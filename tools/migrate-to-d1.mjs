/**
 * migrate-to-d1.mjs —— MySQL → D1 数据迁移
 * ==================================================================================
 * 【为什么需要专门的迁移工具而不是 mysqldump】
 *
 * 三处根本差异：
 *   ① **方言**：MySQL 的 `INSERT ... VALUES` 里含反斜杠转义、`\0` 等，
 *      SQLite 不接受同样写法；D1 的 HTTP 接口对单条语句大小也有限制。
 *   ② **吞吐**：D1 走 wrangler 的批量导入，每批上限约 1000 条语句/5MB。
 *      30 万行必须切批，且失败要能从中断处续跑。
 *   ③ **精度**：DECIMAL 列必须是 REAL。用 JSON 传输时若经过 Number，
 *      大数会变成 `1.267e+8` 这类科学计数法，SQLite 能解析但精度已丢。
 *      因此所有数值按**原始字符串**搬运，由 SQLite 自己转。
 *
 * 【为什么必须可续跑】
 * 迁移 30 万行、60 张表，中途断网/超额是常态。若每次都从头开始，
 * 一个 40 分钟的迁移永远跑不完。因此：
 *   · 每表迁移完成即写 `_migration_log`（在 D1 侧）
 *   · 重跑时跳过已完成的表（除非 --force）
 *
 * 【行数校验是硬要求】
 * 迁移完成的判据不是"没报错"，而是**每张表的行数与 MySQL 侧一致**。
 * 少一行就意味着某个页面会缺数据，而缺失不会报错 —— 只会静默少显示。
 *
 * 用法：
 *   node tools/migrate-to-d1.mjs --dry              # 只统计，不写
 *   node tools/migrate-to-d1.mjs                    # 全量迁移
 *   node tools/migrate-to-d1.mjs --only real_facility,real_emission_year
 *   node tools/migrate-to-d1.mjs --verify           # 只核对行数
 *   node tools/migrate-to-d1.mjs --force            # 忽略已完成标记
 *
 * @module tools/migrate-to-d1
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const DRY = has('dry');
const VERIFY = has('verify');
const FORCE = has('force');
const YEAR_FILTER = Number(argOf('year', 0)) || 0;  // 仅对含 year 列的表生效
const ONLY = (argOf('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DB_NAME = 'carbonchain-platform';
const BATCH_ROWS = Number(argOf('batch', 800));
const TMP_DIR = path.join(ROOT, '.cache', 'd1-migrate');

const WRANGLER = 'C:/Users/wang/.workbuddy/binaries/node/workspace/node_modules/wrangler/bin/wrangler.js';

/* 表迁移顺序：先小表后大表，且**父表先于子表**（便于人工核对）。
 * 不建外键，因此顺序不影响完整性，但影响"看到数据逐步出现"的体验。 */
const TABLE_ORDER = [
  /* 基础字典 */
  'sys_user', 'enterprise', 'verifier_org', 'emission_factor', 'factor_entry',
  'data_source', 'macro_indicator',
  /* 真实数据层（最大，但最独立） */
  'real_facility', 'real_emission_year',
  /* 业务 */
  'emission_report', 'emission_item', 'verify_task', 'verify_report',
  'carbon_quota', 'quota_allocation', 'trade_order', 'trade_deal',
  'credit_asset', 'credit_offset', 'alert_record', 'audit_log', 'notice',
  /* 链 */
  'chain_block', 'chain_tx', 'chain_node', 'chain_node_replica',
  'anchor_batch', 'batch_leaf', 'chain_payload_backup',
  /* MRV */
  'activity_data', 'calc_batch', 'calc_source_detail', 'factor_version',
  'settlement_account', 'settlement_flow', 'quota_surrender', 'credit_retirement',
  'cbam_certificate', 'cbam_declaration', 'green_power_match', 'report_export',
  /* 设备 */
  'device_registry', 'device_verify_log', 'source_crosscheck',
  /* 其他 */
  'cems_reading', 'carbon_dynamic_account', 'intelligence_report',
  'uncertainty_posterior', 'model_eval', 'key_rotation_log',
  'zk_commitment', 'zk_disclosure_log', 'zk_formula_proof',
  'data_ingest_log', 'reconciliation', 'truth_declaration', 'live_rollup',
];

/* ==================================================================================
 * 一、连接 MySQL
 * ================================================================================== */
const envPath = path.join(ROOT, '.env');
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

let conn;
async function ensureConn() {
  if (conn) return conn;
  conn = await mysql.createConnection({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'carbon_chain',
    charset: 'utf8mb4',
    /* 关键：把 BIGINT / DECIMAL 以字符串返回，避免 JS 精度损失 */
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    multipleStatements: false,
  });
  return conn;
}

/* ==================================================================================
 * 二、SQL 值转义（SQLite 口径）
 * ================================================================================== */

/**
 * 把 JS 值转成 SQLite 字面量。
 *
 * ⚠ 三处与 MySQL 的差异：
 *   ① SQLite 用 '' 表示单引号（没有反斜杠转义）；
 *   ② 布尔要转 0/1（SQLite 无 BOOLEAN）；
 *   ③ Buffer/二进制要转 X'hex'。
 * 数值一律不加引号 —— 加引号会让 SQLite 按 TEXT 存，之后比较与排序都会错。
 */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return String(v);
  }
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
  if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').slice(0, 19)}'`;
  if (typeof v === 'object') {
    /* JSON 列：D1 侧是 TEXT，直接存序列化结果 */
    return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/* ==================================================================================
 * 三、wrangler 调用
 * ================================================================================== */

function runWrangler(args, opts = {}) {
  const full = [WRANGLER, 'd1', 'execute', DB_NAME, '--remote', ...args];
  try {
    const out = execFileSync('node', full, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeout || 300_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), error: e.message };
  }
}

/**
 * 带退避重试的 wrangler 调用。
 *
 * 【为什么必须重试 —— 这是实测出来的，不是预防性设计】
 * D1 对**连续快速写入**有速率限制。实测现象：
 *   · 同一批 SQL 文件单独执行 → 成功（600 条 / 70~86 ms）
 *   · 在连续执行第 9、25 批时 → 失败（错误信息被 wrangler 吞掉，只显示
 *     "The execution fails to complete"）
 * 也就是"每一批都正确，连起来跑就挂"。
 *
 * 如果只重试一次，仍然会失败（限流窗口比一次重试长）。
 * 因此用**指数退避**：1s → 3s → 8s → 20s，最多 4 次。
 * 退避期间不查库、不做别的事 —— 任何附加请求都会延长限流窗口。
 */
function runWranglerRetry(args, opts = {}) {
  const maxAttempts = opts.maxAttempts || 4;
  const backoff = [1000, 3000, 8000, 20000];
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    last = runWrangler(args, opts);
    if (last.ok) return last;
    if (i < maxAttempts - 1) {
      const wait = backoff[Math.min(i, backoff.length - 1)];
      process.stdout.write(`\r    ⟳ 第 ${i + 1} 次失败，${wait / 1000}s 后重试…`);
      const t0 = Date.now();
      while (Date.now() - t0 < wait) { /* 同步等待，保持简单 */ }
    }
  }
  return last;
}

/** 查询 D1 单值 */
function d1Value(sql) {
  const r = runWrangler(['--json', '--command', sql]);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out);
    /* wrangler 的 --json 输出是数组，取第一个结果的 results[0] */
    const rows = Array.isArray(j) ? (j[0] && j[0].results) || [] : (j.results || []);
    if (!rows.length) return null;
    return Object.values(rows[0])[0];
  } catch {
    return null;
  }
}

/* ==================================================================================
 * 四、表清单与迁移
 * ================================================================================== */

async function listTables() {
  const c = await ensureConn();
  const [rows] = await c.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`,
    [env.DB_NAME || 'carbon_chain']);
  const all = rows.map((r) => r.t);
  /* 按预设顺序排，未列出的追加到后面 */
  const ordered = TABLE_ORDER.filter((t) => all.includes(t));
  const rest = all.filter((t) => !TABLE_ORDER.includes(t));
  return [...ordered, ...rest];
}

async function tableColumns(table) {
  const c = await ensureConn();
  const [rows] = await c.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%'
      ORDER BY ORDINAL_POSITION`,
    [env.DB_NAME || 'carbon_chain', table]);
  /* GENERATED（生成）列是 MySQL 侧的查询优化（如 real_emission_year.owners_len），
   * D1/Worker 侧不迁移：D1 schema 没有该列，带上它会让 INSERT 撞 unknown column。 */
  return rows.map((r) => r.c);
}

async function tableRowCount(table) {
  const c = await ensureConn();
  const [[r]] = await c.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(r.n);
}

/** 迁移单表 */
async function migrateTable(table) {
  const total = await tableRowCount(table);
  if (!total) return { table, total: 0, written: 0, skipped: 'empty' };

  const cols = await tableColumns(table);
  const c = await ensureConn();

  /* 按 id 游标分批读取，而不是 LIMIT/OFFSET ——
   * OFFSET 在 30 万行上会越翻越慢（每次都要跳过前面的行）。 */
  let lastId = null;
  let written = 0;
  let batchNo = 0;

  fs.mkdirSync(TMP_DIR, { recursive: true });

  for (;;) {
    const baseWhere = YEAR_FILTER ? `WHERE year = ${YEAR_FILTER}` : '';
    const where = lastId === null ? baseWhere : (baseWhere ? baseWhere + ' AND id > ?' : 'WHERE id > ?');
    const params = lastId === null ? [] : [lastId];
    const [rows] = await c.query(
      `SELECT * FROM \`${table}\` ${where} ORDER BY id LIMIT ?`, [...params, BATCH_ROWS]);
    if (!rows.length) break;

    const stmts = rows.map((r) => {
      const vals = cols.map((col) => sqlLiteral(r[col])).join(',');
      const colList = cols.map((col) => `"${col}"`).join(',');
      return `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${vals});`;
    });

    const file = path.join(TMP_DIR, `${table}-${String(batchNo).padStart(4, '0')}.sql`);
    fs.writeFileSync(file, stmts.join('\n'), 'utf8');

    if (!DRY) {
      const res = runWranglerRetry(['--file', file], { timeout: 600_000 });
      if (!res.ok) {
        /* 失败的批次保留文件，便于人工排查 —— 删掉就再也查不到是哪一行错了 */
        throw new Error(`批次 ${batchNo} 失败（文件保留：${path.relative(ROOT, file)}）：${res.out.slice(0, 400)}`);
      }
    }

    written += rows.length;
    lastId = rows[rows.length - 1].id;
    batchNo++;
    process.stdout.write(`\r    ${table}: ${written}/${total} 行`);
    if (rows.length < BATCH_ROWS) break;
  }

  if (!DRY) {
    /* 成功后清理临时文件，避免 .cache 膨胀 */
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (f.startsWith(table + '-')) fs.unlinkSync(path.join(TMP_DIR, f));
    }
  }
  process.stdout.write('\n');
  return { table, total, written };
}

/* ==================================================================================
 * 五、主流程
 * ================================================================================== */

async function main() {
  console.log('='.repeat(78));
  console.log('  MySQL → Cloudflare D1 数据迁移');
  console.log('='.repeat(78));

  const tables = await listTables();
  const targets = ONLY.length ? tables.filter((t) => ONLY.includes(t)) : tables;

  console.log(`\n源库：${env.DB_HOST || '127.0.0.1'}/${env.DB_NAME || 'carbon_chain'}`);
  console.log(`目标：D1 ${DB_NAME}`);
  console.log(`表数：${targets.length}（库内共 ${tables.length}）\n`);

  /* ---------- 只核对行数 ---------- */
  if (VERIFY) {
    console.log('【行数核对】');
    let mismatch = 0;
    for (const t of targets) {
      const my = await tableRowCount(t);
      const d1 = Number(d1Value(`SELECT COUNT(*) FROM "${t}"`) || 0);
      const ok = my === d1;
      if (!ok) mismatch++;
      console.log(`  ${ok ? '✔' : '✘'} ${t.padEnd(28)} MySQL ${String(my).padStart(7)}  D1 ${String(d1).padStart(7)}${ok ? '' : '   ← 不一致'}`);
    }
    console.log(`\n${mismatch === 0 ? '✔ 全部一致' : `✘ ${mismatch} 张表行数不一致`}`);
    await conn.end();
    process.exit(mismatch === 0 ? 0 : 1);
  }

  /* ---------- 迁移前先建迁移日志表 ---------- */
  if (!DRY) {
    runWrangler(['--command',
      `CREATE TABLE IF NOT EXISTS _migration_log (
         table_name TEXT PRIMARY KEY, rows_expected INTEGER, rows_written INTEGER,
         migrated_at TEXT DEFAULT CURRENT_TIMESTAMP)`]);
  }

  const report = [];
  const t0 = Date.now();

  for (const t of targets) {
    /* 跳过已完成的表（除非 --force） */
    if (!FORCE && !DRY) {
      const done = d1Value(`SELECT rows_written FROM _migration_log WHERE table_name = '${t}'`);
      if (done !== null && done !== undefined) {
        const myTotal = await tableRowCount(t);
        if (Number(done) === myTotal) {
          console.log(`  ⊘ ${t.padEnd(28)} 已完成（${done} 行），跳过`);
          report.push({ table: t, total: myTotal, written: Number(done), skipped: true });
          continue;
        }
        console.log(`  ↻ ${t.padEnd(28)} 行数已变（${done} → ${myTotal}），重迁`);
      }
    }

    const total = await tableRowCount(t);
    process.stdout.write(`  → ${t.padEnd(28)} 共 ${total} 行\n`);
    try {
      const r = await migrateTable(t);
      report.push(r);
      if (!DRY) {
        runWrangler(['--command',
          `INSERT OR REPLACE INTO _migration_log (table_name, rows_expected, rows_written, migrated_at)
           VALUES ('${t}', ${r.total}, ${r.written}, CURRENT_TIMESTAMP)`]);
      }
      /* 大表迁移后核对一次行数 —— 这是"迁移成功"的唯一硬判据 */
      if (!DRY && r.total > 0) {
        const d1n = Number(d1Value(`SELECT COUNT(*) FROM "${t}"`) || 0);
        const ok = d1n >= r.written;
        console.log(`    ${ok ? '✔' : '✘'} 核对：D1 ${d1n} 行（写入 ${r.written}）`);
        if (!ok) report[report.length - 1].verifyFailed = true;
      }
    } catch (e) {
      console.error(`    ✘ 失败：${e.message}`);
      report.push({ table: t, error: e.message });
      /* 单表失败不终止全局 —— 其余表继续迁移，最后汇总报告。
       * 一次中断全部重跑的成本太高（30 万行要 40 分钟）。 */
    }
  }

  /* ---------- 汇总 ---------- */
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const okT = report.filter((r) => !r.error && !r.verifyFailed);
  const failT = report.filter((r) => r.error || r.verifyFailed);
  const totalRows = report.reduce((a, r) => a + (r.written || 0), 0);

  console.log('\n' + '='.repeat(78));
  console.log(`  完成 ${okT.length}/${report.length} 张表 · 共 ${totalRows.toLocaleString()} 行 · ${elapsed} s`);
  if (failT.length) {
    console.log(`  失败 ${failT.length} 张：`);
    failT.forEach((r) => console.log(`    · ${r.table}: ${r.error || '行数核对未通过'}`));
  }
  console.log('='.repeat(78));

  fs.writeFileSync(path.join(ROOT, 'tools', 'out', 'migrate-to-d1.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), elapsedSec: Number(elapsed), report }, null, 2), 'utf8');

  if (conn) await conn.end();
  process.exit(failT.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n✘ 迁移中断：', e.message);
  if (conn) conn.end().catch(() => {});
  process.exit(1);
});
