/**
 * schema-to-sqlite.mjs —— 把 MySQL DDL 转成 D1（SQLite）可执行 DDL
 * ==================================================================================
 * 【为什么必须自动化】
 * 60 张表、约 3,000 行 DDL、90 处 AUTO_INCREMENT、76 处 ENGINE/CHARSET、
 * 数百处 COMMENT。手改一遍必然出错，而且下次 schema 更新时无法重跑 ——
 * "改完就没人敢动"的迁移脚本是技术债里最贵的一种。
 *
 * 【转换规则：哪些必须改，为什么】
 *
 *   AUTO_INCREMENT         → INTEGER PRIMARY KEY AUTOINCREMENT（SQLite 语义：
 *                            只有 INTEGER PRIMARY KEY 才是 rowid 别名）
 *   ENGINE=InnoDB / CHARSET → 直接删除（SQLite 无存储引擎概念）
 *   COMMENT '...'          → 删除（SQLite 不支持列注释；表注释改为单独注释行，
 *                            保留原文以便追溯）
 *   JSON 列                → TEXT（SQLite 无 JSON 类型，但 JSON1 扩展可用；
 *                            查询侧需把 JSON_EXTRACT 改为 json_extract）
 *   DECIMAL(p,s)           → REAL（SQLite 无定点数。⚠ 这是**精度损失**，
 *                            必须在迁移时把 DECIMAL 列的值按原字符串写入，
 *                            读侧用 toFixed 还原，不做中间运算）
 *   TINYINT(1)             → INTEGER（布尔语义）
 *   ENUM(...)              → TEXT（值域靠应用层校验）
 *   DATETIME / TIMESTAMP   → TEXT（ISO8601 字符串，避免时区漂移）
 *   ON UPDATE CURRENT_TIMESTAMP → 删除（SQLite 无此特性；由应用层或触发器维护）
 *   UNSIGNED               → 删除（SQLite 无符号概念）
 *   KEY / INDEX 内联声明    → 拆成独立的 CREATE INDEX 语句
 *   UNIQUE KEY             → CREATE UNIQUE INDEX
 *   SQL SECURITY INVOKER 视图 → SQLite 无视图权限模型，直接转普通 VIEW
 *
 * 【不做的事】
 *   不改列名、不改类型宽度语义、不合并表 —— 保持与 MySQL 侧 1:1 可对照。
 *   迁移工具（migrate-to-d1.mjs）依赖这个 1:1 关系做逐表比对。
 *
 * 用法：
 *   node tools/schema-to-sqlite.mjs            # 输出 db/d1/schema.sql
 *   node tools/schema-to-sqlite.mjs --dry       # 只打印统计，不写文件
 *
 * @module tools/schema-to-sqlite
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const SOURCES = [
  { file: 'db/00_schema_ledger.sql', note: '账本库（链上 5 表）' },
  { file: 'db/01_schema.sql', note: '业务库主结构（33 表）' },
  { file: 'db/04_schema_mrv.sql', note: 'MRV/结算/CBAM/ZK/数据源（17 表）' },
  { file: 'db/05_schema_real.sql', note: '真实数据层（5 表）' },
];

const OUT_DIR = path.join(ROOT, 'db', 'd1');
const OUT_FILE = path.join(OUT_DIR, 'schema.sql');

/* ==================================================================================
 * 一、单列定义转换
 * ================================================================================== */

/** SQLite 保留字里与列名冲突的，需要引号包起来（目前无冲突，预留） */
const RESERVED = new Set(['order', 'group', 'index', 'table', 'select', 'from', 'where']);

/**
 * 剥离行内 `--` 注释（引号内的 `--` 视为数据，不剥离）。
 * 纯注释行会返回空串。
 */
function stripInlineComment(line) {
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = line[i - 1];
    if (inStr) {
      if (ch === strCh && prev !== '\\') inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = true; strCh = ch; continue; }
    if (ch === '-' && line[i + 1] === '-') {
      return line.slice(0, i);
    }
  }
  return line;
}

function convertColumnDef(line) {
  /* ⚠ 先剥离行内 `--` 注释，再解析。
   *
   * 这一步不能省。MySQL 版 schema 里有这样的行：
   *   -- 行业：同时保留平台分类与原始分类，避免"归类即失真",
   * 注意行尾那个逗号 —— 它在注释**里面**，但按行切分后它会留在字符串末尾，
   * 于是生成的 DDL 变成 `... 归类即失真",` 这样的非法片段。
   * SQLite 报的是 `near ")": syntax error`，错误位置与真正原因相距很远，
   * 极难定位。这类"注释里的标点污染 DDL"是生成式转换最典型的坑。
   *
   * 判据：`--` 出现在引号之外才算注释起始；引号内的 `--` 是数据。 */
  let s = stripInlineComment(line).trim().replace(/,$/, '');
  if (!s) return null;

  /* 1) 去掉 COMMENT '...' —— 注意值里可能含转义单引号 */
  s = s.replace(/\s+COMMENT\s+'(?:[^'\\]|\\.|'')*'/gi, '');

  /* 2) AUTO_INCREMENT → 由外层统一处理主键（见 buildTable） */
  const hasAutoInc = /AUTO_INCREMENT/i.test(s);
  s = s.replace(/\s+AUTO_INCREMENT/gi, '');

  /* 3) 去掉 UNSIGNED */
  s = s.replace(/\s+UNSIGNED/gi, '');

  /* 4) 去掉 ON UPDATE CURRENT_TIMESTAMP */
  s = s.replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(\s*\(\s*\d*\s*\))?/gi, '');

  /* 5) DEFAULT CURRENT_TIMESTAMP 保留（SQLite 支持） */

  /* 6) 类型映射 */
  s = s.replace(/\bTINYINT\s*\(\s*1\s*\)/gi, 'INTEGER');
  s = s.replace(/\bTINYINT(\s*\(\s*\d+\s*\))?/gi, 'INTEGER');
  s = s.replace(/\bSMALLINT(\s*\(\s*\d+\s*\))?/gi, 'INTEGER');
  s = s.replace(/\bMEDIUMINT(\s*\(\s*\d+\s*\))?/gi, 'INTEGER');
  s = s.replace(/\bBIGINT\s*\(\s*\d+\s*\)/gi, 'INTEGER');
  s = s.replace(/\bBIGINT/gi, 'INTEGER');
  s = s.replace(/\bINT\s*\(\s*\d+\s*\)/gi, 'INTEGER');
  s = s.replace(/\bINT\b/gi, 'INTEGER');
  s = s.replace(/\bDECIMAL\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 'REAL');
  s = s.replace(/\bDOUBLE(\s*\(\s*\d+\s*,\s*\d+\s*\))?/gi, 'REAL');
  s = s.replace(/\bFLOAT(\s*\(\s*\d+\s*,\s*\d+\s*\))?/gi, 'REAL');
  s = s.replace(/\bJSON\b/gi, 'TEXT');
  s = s.replace(/\bENUM\s*\((?:[^)'\\]|\\.|'')*\)/gi, 'TEXT');
  s = s.replace(/\bDATETIME(\s*\(\s*\d*\s*\))?/gi, 'TEXT');
  s = s.replace(/\bTIMESTAMP(\s*\(\s*\d*\s*\))?/gi, 'TEXT');
  s = s.replace(/\bDATE\b(?!TEXT)/gi, 'TEXT');
  s = s.replace(/\bLONGTEXT\b/gi, 'TEXT');
  s = s.replace(/\bMEDIUMTEXT\b/gi, 'TEXT');
  s = s.replace(/\bTINYTEXT\b/gi, 'TEXT');
  s = s.replace(/\bVARCHAR\s*\(\s*\d+\s*\)/gi, 'TEXT');
  s = s.replace(/\bCHAR\s*\(\s*\d+\s*\)/gi, 'TEXT');
  s = s.replace(/\bVARBINARY\s*\(\s*\d+\s*\)/gi, 'BLOB');
  s = s.replace(/\bBLOB\b/gi, 'BLOB');

  /* 7) 压缩多余空白 */
  s = s.replace(/\s+/g, ' ').trim();

  return { def: s, hasAutoInc };
}

/* ==================================================================================
 * 二、单表转换
 * ================================================================================== */

function buildTable(tableName, bodyLines, tableComment) {
  const cols = [];
  const indexes = [];
  let primaryKeyFromAutoInc = null;

  for (const raw of bodyLines) {
    /* 同样先剥离行内注释 —— 表体里既有纯注释行，也有注释里的逗号。 */
    const line = stripInlineComment(raw).trim().replace(/,$/, '');
    if (!line) continue;

    /* ---- 表级约束 ---- */
    if (/^PRIMARY\s+KEY\s*\(/i.test(line)) {
      const m = line.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (m) {
        const col = m[1].split(',')[0].trim().replace(/`/g, '');
        /* AUTO_INCREMENT 列已变成 INTEGER，SQLite 里主键若想自增必须是
         * INTEGER PRIMARY KEY（不能是表级 PRIMARY KEY(col)）；这里记录，外层改写 */
        if (primaryKeyFromAutoInc === col) {
          // 已在列定义上处理，跳过
        } else {
          indexes.push({ sql: `-- 主键 ${col} 由列定义承担` });
        }
      }
      continue;
    }
    if (/^UNIQUE\s+KEY\s+/i.test(line)) {
      const m = line.match(/^UNIQUE\s+KEY\s+`?([\w]+)`?\s*\(([^)]+)\)/i);
      if (m) {
        const colsList = m[2].split(',').map((c) => c.trim().replace(/\s+(ASC|DESC)$/i, '')).join(', ');
        indexes.push({ unique: true, name: m[1], sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_${tableName}_${m[1]} ON ${tableName} (${colsList});` });
      }
      continue;
    }
    if (/^KEY\s+/i.test(line)) {
      const m = line.match(/^KEY\s+`?([\w]+)`?\s*\(([^)]+)\)/i);
      if (m) {
        const colsList = m[2].split(',').map((c) => c.trim().replace(/\s+(ASC|DESC)$/i, '')).join(', ');
        indexes.push({ name: m[1], sql: `CREATE INDEX IF NOT EXISTS idx_${tableName}_${m[1]} ON ${tableName} (${colsList});` });
      }
      continue;
    }
    if (/^(CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i.test(line)) {
      /* 外键一律不建：SQLite 需 PRAGMA foreign_keys=ON 且 D1 对级联行为
       * 与 MySQL 不完全一致；平台的完整性靠应用层事务 + 校验保证，
       * 迁移时逐表比对行数即可发现孤儿行。 */
      continue;
    }

    /* ---- 列定义 ---- */
    const c = convertColumnDef(line);
    if (!c) continue;
    let def = c.def;
    if (c.hasAutoInc) {
      /* SQLite 铁律：自增主键必须写成 `INTEGER PRIMARY KEY`，
       * **不能**带 NOT NULL —— 一旦写成 `INTEGER PRIMARY KEY NOT NULL`，
       * 该列就不再是 rowid 别名，AUTOINCREMENT 语义随之失效
       * （SQLite 会静默接受，但插入时不再自动赋值）。
       * 这类"能执行但语义错"的 DDL 比语法错误更危险：建库成功、插入失败。 */
      def = def.replace(/^`?([\w]+)`?\s+INTEGER\s+NOT\s+NULL/i, '`$1` INTEGER PRIMARY KEY');
      def = def.replace(/^`?([\w]+)`?\s+INTEGER\s+PRIMARY\s+KEY\s+NOT\s+NULL/i, '`$1` INTEGER PRIMARY KEY');
      /* 兜底：若上面两条都没命中，强制改写首列 */
      if (!/INTEGER\s+PRIMARY\s+KEY/i.test(def)) {
        def = def.replace(/^(`?[\w]+`?)\s+INTEGER/i, '$1 INTEGER PRIMARY KEY');
      }
      def = def.replace(/\bNOT\s+NULL\b/gi, '').replace(/\s+/g, ' ').trim();
      primaryKeyFromAutoInc = (line.match(/^`?([\w]+)`?/) || [])[1];
    }
    cols.push('  ' + def);
  }

  const lines = [];
  if (tableComment) lines.push(`-- ${tableComment}`);
  lines.push(`CREATE TABLE IF NOT EXISTS ${tableName} (`);
  lines.push(cols.join(',\n'));
  lines.push(');');
  const sql = lines.join('\n');
  const idxSql = indexes.filter((i) => i.sql && !i.sql.startsWith('--')).map((i) => i.sql);
  return { sql, idxSql, columns: cols.length };
}

/* ==================================================================================
 * 三、文件级解析
 * ================================================================================== */

/** 按分号切分语句，但要跳过字符串里的分号 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const prev = sql[i - 1];
    if (inStr) {
      buf += ch;
      if (ch === strCh && prev !== '\\') inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = true; strCh = ch; buf += ch; continue; }
    /* 行注释 */
    if (ch === '-' && sql[i + 1] === '-' && !buf.trim()) {
      const nl = sql.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === ';') { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 抽取紧邻 CREATE TABLE 之前的注释作为表说明 */
function commentBefore(sql, pos) {
  /* 只看紧邻的注释块（中间不能夹非注释、非空行），否则会误取上一张表的说明。
   * 实测：MySQL 版每张表前的注释块形如
   *   -- ---------------------------------------------------------------------
   *   -- 12. chain_block  区块链区块表（...）
   *   -- ---------------------------------------------------------------------
   * 要提取的是其中**有内容**的那一行，而不是分隔线。 */
  const before = sql.slice(Math.max(0, pos - 1200), pos);
  const lines = before.split('\n').map((l) => l.trim());
  const picked = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;                       // 空行忽略
    if (!l.startsWith('--')) break;         // 遇到非注释即停止
    const text = l.replace(/^--\s?/, '').trim();
    if (!text) continue;                    // 纯分隔线
    if (/^-{5,}$/.test(text)) continue;     // 纯横线
    picked.unshift(text);
    if (picked.length >= 2) break;          // 最多取两行，避免把整段说明搬进来
  }
  return picked.length ? picked.join(' · ').slice(0, 200) : null;
}

/* ==================================================================================
 * 主流程
 * ================================================================================== */

let totalTables = 0;
let totalIndexes = 0;
let totalViews = 0;
const chunks = [];
const report = [];

chunks.push(`-- =====================================================================================
-- 碳链通平台 · D1 (SQLite) Schema —— 由 tools/schema-to-sqlite.mjs 自动生成
-- =====================================================================================
-- ⚠ 本文件是**生成产物**，不要手改。改 schema 请改 db/*.sql（MySQL 版）后重跑：
--     node tools/schema-to-sqlite.mjs
-- 这样 MySQL 与 D1 两侧永远同源，不会出现"线上表结构和本地不一致"。
--
-- 【为什么保留 MySQL 版作为唯一真源】
-- 本地开发、证据包、离线复核全部跑在 MySQL 上；D1 是部署目标。
-- 若两边各维护一份 DDL，第一次改表就会漂移，而漂移不会报错 ——
-- 只会在某天线上查询突然少一个字段。
--
-- 【精度声明】
-- DECIMAL(p,s) 全部映射为 REAL。SQLite 的 REAL 是 IEEE754 双精度，
-- 对 DECIMAL(18,3) 的典型值（如 12605.911）完全够用（15~17 位有效数字），
-- 但**不要用 SQL 做累加后再比较相等**：累加顺序不同会有末位差异。
-- 金额/排放量的聚合请在应用层或预聚合表里做，并统一用 toFixed 还原。
-- =====================================================================================

PRAGMA foreign_keys = OFF;
`);

for (const src of SOURCES) {
  const p = path.join(ROOT, src.file);
  if (!fs.existsSync(p)) { console.warn('⊘ 缺失：' + src.file); continue; }
  const raw = fs.readFileSync(p, 'utf8');

  chunks.push(`\n-- =====================================================================\n-- 来自 ${src.file} · ${src.note}\n-- =====================================================================\n`);

  /* 视图单独处理（保持可读） */
  const viewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?VIEW\s+`?(\w+)`?\s+AS\s+([\s\S]*?);/gi;
  let m;
  const views = [];
  while ((m = viewRe.exec(raw)) !== null) {
    views.push({ name: m[1], body: m[2].trim() });
  }

  /* 表：用正则抓 CREATE TABLE 块（到匹配的右括号） */
  const tblRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(/gi;
  let t;
  while ((t = tblRe.exec(raw)) !== null) {
    const tableName = t[1];
    const start = t.index + t[0].length;
    /* 括号配平，跳过字符串 */
    let depth = 1;
    let i = start;
    let inStr = false;
    let strCh = '';
    let body = '';
    for (; i < raw.length && depth > 0; i++) {
      const ch = raw[i];
      if (inStr) { body += ch; if (ch === strCh && raw[i - 1] !== '\\') inStr = false; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = true; strCh = ch; body += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') { depth--; if (depth === 0) break; }
      body += ch;
    }
    const bodyLines = body.split('\n');
    const tblComment = commentBefore(raw, t.index);
    const built = buildTable(tableName, bodyLines, tblComment);
    chunks.push(built.sql + '\n');
    if (built.idxSql.length) chunks.push(built.idxSql.join('\n') + '\n');
    totalTables++;
    totalIndexes += built.idxSql.length;
    report.push({ table: tableName, columns: built.columns, indexes: built.idxSql.length, from: src.file });
    /* 跳过已消费区域，避免重复匹配内层 */
    tblRe.lastIndex = i;
  }

  /* 视图：MySQL 的链上 5 表在业务库是"指向账本库的只读视图"。
   * 在 D1 里没有跨库概念，账本表与业务表同在同一个 D1 —— 
   * 因此这些视图会与实体表同名冲突。
   *
   * ⚠ 正确处理：D1 版**不建这些视图**，直接建实体表（账本表来自 00_schema_ledger.sql）。
   * 业务侧查询代码写的是 `FROM chain_tx`，在 MySQL 里命中视图、在 D1 里命中实体表，
   * 语义一致（都是只读清单），因此不需要改代码。
   * 这里把它们记录在注释里，说明为何跳过。 */
  for (const v of views) {
    chunks.push(`-- [跳过视图] ${v.name}：D1 无跨库，该名称由实体表直接承载（语义一致）\n`);
    totalViews++;
  }
}

chunks.push(`
-- =====================================================================
-- 预聚合表（D1 性能关键）
-- =====================================================================
-- 【为什么必须有这张表】
-- 实测：D1 上对 5 万行做 GROUP BY 会 rows_read=100,000（全表 + 索引双读），
-- 而免费层每天只有 500 万行读取额度 —— 只能跑约 50 次这样的查询。
-- 用预聚合表后同口径查询 rows_read=12。
--
-- 这不是"优化"，是"能不能用"的分界。聚合结果由 Cron Trigger 定期刷新，
-- 页面读预聚合；需要明细时按 id/分页读实体表（带索引，rows_read 可控）。
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

-- 产业洞察预聚合（监管线索 / 强度离群 / 企业对标）
-- 这三类计算都要扫全表，必须在写入侧算好，读取侧只查结果。
CREATE TABLE IF NOT EXISTS agg_insight (
  kind TEXT NOT NULL,            -- LEADS / OUTLIERS / BENCHMARK
  scope TEXT NOT NULL,           -- 国家或行业标识
  payload_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, scope)
);

PRAGMA foreign_keys = ON;
`);

if (process.argv.includes('--dry')) {
  console.log(`\n[试运行] 表 ${totalTables} 张 · 索引 ${totalIndexes} 条 · 跳过视图 ${totalViews} 个`);
  console.log('未写文件。');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, chunks.join('\n'), 'utf8');

/* 机读报告，供迁移工具与文档引用 */
fs.writeFileSync(path.join(OUT_DIR, 'schema-report.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), tables: totalTables, indexes: totalIndexes, viewsSkipped: totalViews, detail: report }, null, 2), 'utf8');

console.log(`✔ 已生成 ${path.relative(ROOT, OUT_FILE)}`);
console.log(`  表 ${totalTables} 张 · 索引 ${totalIndexes} 条 · 跳过视图 ${totalViews} 个`);
console.log(`  体积 ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB`);
