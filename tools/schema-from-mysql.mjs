/**
 * schema-from-mysql.mjs —— 从 MySQL **实际结构**反向生成 D1 Schema
 * ==================================================================================
 * 【为什么放弃解析 DDL 文本，改用数据库元数据】
 *
 * 之前的 schema-to-sqlite.mjs 解析 db/*.sql 的 DDL 文本。它漏了两张表的 12 个列：
 *   enterprise     缺 data_source_id / external_id / is_real / latitude / longitude / naics
 *   emission_report 缺 biogenic_co2 / ch4_co2e / co2_only / data_source_id / is_real / n2o_co2e
 *
 * 原因很实在：这些列是**迁移期用 ALTER TABLE 追加的**，从未回写到 01_schema.sql。
 * 于是 DDL 文件描述的是"建库那一刻的结构"，而库里是"累加修正后的结构"。
 *
 * 这个偏差在迁移时不会报错，只在 INSERT 时才暴露为
 * `table X has no column named Y` —— 而那时已经写坏了几批数据。
 *
 * 【因此改为以 information_schema 为准】
 * MySQL 的 information_schema.COLUMNS / STATISTICS / TABLES 是**运行时真相**，
 * 不可能漏列、不可能过时。用它们生成 D1 DDL，两边结构必然一致。
 *
 * 代价：生成结果不再有手写注释（元数据里没有业务说明）。
 * 但结构正确性 > 注释美观 —— 而且业务说明可以维护在单独的字典文件里。
 *
 * 用法：
 *   node tools/schema-from-mysql.mjs            # 生成 db/d1/schema.sql
 *   node tools/schema-from-mysql.mjs --dry
 *
 * @module tools/schema-from-mysql
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const DRY = process.argv.includes('--dry');
const OUT_DIR = path.join(ROOT, 'db', 'd1');
const OUT_FILE = path.join(OUT_DIR, 'schema.sql');

/* ---------- 读 .env ---------- */
const env = {};
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/* ==================================================================================
 * 类型映射：MySQL COLUMN_TYPE → SQLite
 * ================================================================================== */

/**
 * 把 MySQL 的 COLUMN_TYPE 映射为 SQLite 类型。
 *
 * 【映射原则：保住语义，而不是保住名字】
 *   · 所有整数 → INTEGER（SQLite 只有一种整数，64 位）
 *   · DECIMAL/NUMERIC → REAL（SQLite 无定点数；精度声明见文件头）
 *   · 字符串族 → TEXT（VARCHAR/CHAR/ENUM/SET 在 SQLite 里都是 TEXT，
 *     ENUM 的值域靠应用层校验）
 *   · JSON → TEXT（JSON1 扩展在查询时用 json_extract 解析）
 *   · 二进制 → BLOB
 *   · 日期时间 → TEXT（ISO8601 字符串，避免时区漂移）
 */
function mapType(columnType, dataType) {
  const dt = String(dataType || '').toLowerCase();
  const ct = String(columnType || '').toLowerCase();

  if (dt === 'tinyint') return 'INTEGER';      // 含 tinyint(1) 布尔
  if (['smallint', 'mediumint', 'int', 'integer', 'bigint', 'bit', 'year'].includes(dt)) return 'INTEGER';
  if (['decimal', 'numeric', 'float', 'double', 'real'].includes(dt)) return 'REAL';
  if (['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set'].includes(dt)) return 'TEXT';
  if (dt === 'json') return 'TEXT';
  if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'].includes(dt)) return 'BLOB';
  if (['date', 'datetime', 'timestamp', 'time'].includes(dt)) return 'TEXT';
  return 'TEXT';
}

/**
 * 生成单列的 DDL 片段。
 *
 * ⚠ 三个 SQLite 特有的约束必须在这里处理：
 *   ① AUTO_INCREMENT → 必须写成 `INTEGER PRIMARY KEY`（不能带 NOT NULL，
 *      否则不再是 rowid 别名，自增失效）
 *   ② DEFAULT CURRENT_TIMESTAMP 可用；但 `ON UPDATE CURRENT_TIMESTAMP` 不支持
 *   ③ DEFAULT '0000-00-00 00:00:00' 这类 MySQL 零值在 SQLite 里非法，必须改写为 NULL
 */
function columnDdl(col) {
  const name = col.COLUMN_NAME;
  const type = mapType(col.COLUMN_TYPE, col.DATA_TYPE);
  const isAuto = String(col.EXTRA || '').toLowerCase().includes('auto_increment');

  if (isAuto) {
    /* 自增主键：SQLite 唯一的自增写法 */
    return `  "${name}" INTEGER PRIMARY KEY`;
  }

  const parts = [`  "${name}" ${type}`];

  /* DEFAULT：只保留 SQLite 能理解的值 */
  const def = col.COLUMN_DEFAULT;
  if (def !== null && def !== undefined) {
    const d = String(def);
    /* MySQL 的零值默认在 SQLite 里无意义，改为不设默认 */
    if (/^0000-00-00/.test(d)) {
      /* 跳过 */
    } else if (/^CURRENT_TIMESTAMP$/i.test(d)) {
      parts.push('DEFAULT CURRENT_TIMESTAMP');
    } else if (/^-?\d+(\.\d+)?$/.test(d)) {
      parts.push(`DEFAULT ${d}`);
    } else if (/^'(.*)'$/s.test(d)) {
      parts.push(`DEFAULT '${d.replace(/^'|'$/g, '').replace(/'/g, "''")}'`);
    } else {
      /* 其他表达式（如 CURRENT_DATE）直接跳过，避免生成非法 DDL */
    }
  }

  if (col.IS_NULLABLE === 'NO') parts.push('NOT NULL');

  return parts.join(' ');
}

/* ==================================================================================
 * 索引映射
 * ================================================================================== */

function indexDdl(table, idx) {
  const cols = idx.columns.map((c) => `"${c}"`).join(', ');
  const kind = idx.NON_UNIQUE === 0 ? 'UNIQUE INDEX' : 'INDEX';
  return `CREATE ${kind} IF NOT EXISTS "${idx.name}" ON "${table}" (${cols});`;
}

/* ==================================================================================
 * 主流程
 * ================================================================================== */

async function main() {
  const makeConn = (dbName) => mysql.createConnection({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: dbName,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  const DB = env.DB_NAME || 'carbon_chain';
  /* 账本是**独立数据库**（业务库只有指向它的只读视图）。
   * 若只读业务库的 information_schema，会拿到 5 个视图而非实体表 —— 列信息仍在，
   * 但 TABLE_TYPE='VIEW'，且视图列不保证与实体表完全一致。
   * 因此账本 5 表必须从 ledgerDb 读实体结构。
   * 同库部署（ledgerDb == db）时跳过，避免重复。 */
  const LEDGER = env.LEDGER_DB_NAME || 'carbon_chain_ledger';
  const splitDb = LEDGER && LEDGER !== DB;

  const conn = await makeConn(DB);
  const ledgerConn = splitDb ? await makeConn(LEDGER) : null;

  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS t, TABLE_COMMENT AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`, [DB]);

  let ledgerTables = [];
  if (ledgerConn) {
    const [lt] = await ledgerConn.query(
      `SELECT TABLE_NAME AS t, TABLE_COMMENT AS c FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`, [LEDGER]);
    ledgerTables = lt;
  }

  const chunks = [];
  chunks.push(`-- =====================================================================================
-- 碳链通平台 · D1 (SQLite) Schema —— 由 tools/schema-from-mysql.mjs 从 MySQL 实际结构生成
-- =====================================================================================
-- ⚠ 本文件是**生成产物**，不要手改。重新生成：
--     node tools/schema-from-mysql.mjs
--
-- 【为什么以 MySQL 元数据为准，而不解析 DDL 文本】
-- 早期版本解析 db/*.sql 的 DDL。它漏了两张表共 12 个列 —— 因为这些列是
-- 迁移期用 ALTER TABLE 追加的，从未回写到 DDL 文件。
-- 偏差不会在生成时报错，只在 INSERT 时暴露为
--   table enterprise has no column named data_source_id
-- 而那时已经写坏了几批数据。
--
-- information_schema 是运行时真相，不可能漏列、不可能过时。
-- 因此两边结构必然一致 —— 结构正确性优先于注释美观。
--
-- 【精度声明】
-- DECIMAL(p,s) → REAL（IEEE754 双精度，15~17 位有效数字）。
-- 对 DECIMAL(18,3) 的典型值足够，但**不要用 SQL 累加后比较相等**：
-- 累加顺序不同会有末位差异。聚合请用预聚合表并统一 toFixed 还原。
--
-- 【类型映射】
-- 整数族 → INTEGER（SQLite 只有 64 位整数）
-- DECIMAL/FLOAT/DOUBLE → REAL
-- VARCHAR/CHAR/ENUM/SET/JSON → TEXT（ENUM 值域靠应用层校验）
-- BLOB 族 → BLOB
-- DATE/DATETIME/TIMESTAMP → TEXT（ISO8601，避免时区漂移）
-- =====================================================================================

PRAGMA foreign_keys = OFF;
`);

  let totalCols = 0;
  let totalIdx = 0;
  const missing = [];

  /** 从指定连接与库名抽取一张表的 DDL */
  async function emitTable(c, dbName, t, tag) {
    const name = t.t;
    const [cols] = await c.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%'
        ORDER BY ORDINAL_POSITION`, [dbName, name]);
    /* GENERATED（生成）列是 MySQL 侧查询优化，SQLite/D1 侧不需要：
     * 本工具不特判其 DDL（会产出错误的普通列），直接跳过，与 migrate-to-d1 口径一致。 */
    if (!cols.length) { missing.push(`${name}@${dbName}`); return; }

    const [idxRows] = await c.query(
      `SELECT INDEX_NAME AS n, NON_UNIQUE AS u, SEQ_IN_INDEX AS s, COLUMN_NAME AS x
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME <> 'PRIMARY'
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [dbName, name]);
    const idxMap = new Map();
    for (const r of idxRows) {
      if (!idxMap.has(r.n)) idxMap.set(r.n, { name: r.n, NON_UNIQUE: Number(r.u), columns: [] });
      idxMap.get(r.n).columns.push(r.x);
    }

    const comment = String(t.c || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
    chunks.push(`\n-- ${name}${tag ? ' [' + tag + ']' : ''}${comment ? ' —— ' + comment : ''}（${cols.length} 列）`);
    chunks.push(`CREATE TABLE IF NOT EXISTS "${name}" (`);
    chunks.push(cols.map(columnDdl).join(',\n'));
    chunks.push(');');
    totalCols += cols.length;

    for (const idx of idxMap.values()) {
      chunks.push(indexDdl(name, idx));
      totalIdx++;
    }
  }

  chunks.push(`\n-- =====================================================================\n-- 账本库（${LEDGER}，链上 5 表实体结构）\n-- =====================================================================\n`);
  for (const t of ledgerTables) {
    await emitTable(ledgerConn, LEDGER, t, 'ledger');
  }

  chunks.push(`\n-- =====================================================================\n-- 业务库（${DB}）\n-- =====================================================================\n`);
  for (const t of tables) {
    await emitTable(conn, DB, t, null);
  }

  const totalTables = ledgerTables.length + tables.length;


  /* ---------- 预聚合表（D1 专用，MySQL 侧没有） ---------- */
  chunks.push(`
-- =====================================================================
-- 预聚合表（D1 性能关键 —— MySQL 侧不需要，故不在此生成范围内）
-- =====================================================================
-- 实测：D1 上对 5 万行做 GROUP BY 会 rows_read=100,000，
-- 免费层每天 500 万行读取额度 ⇒ 只能跑 50 次。
-- 读预聚合表后同口径查询 rows_read=12。
-- 这不是"优化"，是"能不能用"的分界。
CREATE TABLE IF NOT EXISTS agg_facility_year (
  country_iso TEXT NOT NULL,
  year INTEGER NOT NULL,
  industry TEXT NOT NULL,
  region_code TEXT,
  facilities INTEGER NOT NULL DEFAULT 0,
  total_co2e REAL NOT NULL DEFAULT 0,
  device_rows INTEGER NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (country_iso, year, industry, region_code)
);
CREATE INDEX IF NOT EXISTS idx_afy_year ON agg_facility_year(year);

CREATE TABLE IF NOT EXISTS agg_facility_total (
  country_iso TEXT NOT NULL,
  year INTEGER NOT NULL,
  facilities INTEGER NOT NULL DEFAULT 0,
  emission_rows INTEGER NOT NULL DEFAULT 0,
  total_co2e REAL NOT NULL DEFAULT 0,
  aggregate_assets INTEGER NOT NULL DEFAULT 0,
  aggregate_tonnes REAL NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (country_iso, year)
);

CREATE TABLE IF NOT EXISTS agg_insight (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, scope)
);

CREATE TABLE IF NOT EXISTS _migration_log (
  table_name TEXT PRIMARY KEY,
  rows_expected INTEGER,
  rows_written INTEGER,
  migrated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

PRAGMA foreign_keys = ON;
`);

  await conn.end();
  if (ledgerConn) await ledgerConn.end();

  const sql = chunks.join('\n');
  if (DRY) {
    console.log(`[试运行] 表 ${totalTables} 张（账本 ${ledgerTables.length} + 业务 ${tables.length}） · 列 ${totalCols} · 索引 ${totalIdx}`);
    if (missing.length) console.log('缺列的表：', missing.join(', '));
    process.exit(0);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, sql, 'utf8');

  console.log(`✔ 已生成 ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`  表 ${totalTables} 张（账本 ${ledgerTables.length} + 业务 ${tables.length}） · 列 ${totalCols} · 索引 ${totalIdx} · 体积 ${(Buffer.byteLength(sql) / 1024).toFixed(1)} KB`);
  if (missing.length) console.log(`  ⚠ ${missing.length} 张表无列信息：${missing.join(', ')}`);
}

main().catch((e) => { console.error('✘', e.message); process.exit(1); });
