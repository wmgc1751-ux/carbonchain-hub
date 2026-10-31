/**
 * migrate-to-turso.mjs —— MySQL → Turso（libSQL）全量迁移
 * ==================================================================================
 * 与 tools/migrate-to-d1.mjs 同一套流程，目标端换成 Turso：
 *   · DDL：db/d1/schema.sql（SQLite 方言，Turso 直接可用）按分号切分执行
 *   · 数据：MySQL 按 id 游标分批读 → libSQL batch 写（比 wrangler --file
 *     快且无 CLI 速率限制）
 *   · 校验：--verify 逐表比对行数
 *
 * 【前置条件】
 *   环境变量或 .env 中已有：
 *     TURSO_URL         libsql://<dbname>-<org>.turso.io
 *     TURSO_AUTH_TOKEN  turso 平台生成的数据库 token
 *   （turso.app 网页建库 → "Generate Token" 即得，无需 CLI）
 *
 * 【用法】
 *   node tools/migrate-to-turso.mjs            # 全量迁移（DDL + 数据）
 *   node tools/migrate-to-turso.mjs --verify   # 只核对行数
 *   node tools/migrate-to-turso.mjs --ddl      # 只执行 DDL
 *   node tools/migrate-to-turso.mjs --table notice   # 只迁指定表
 */
'use strict';

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = path.join(ROOT, 'db', 'd1', 'schema.sql');
const BATCH_ROWS = 400;

/* 解析 .env（项目根） */
const env = {};
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TURSO_URL = process.env.TURSO_URL || env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || env.TURSO_AUTH_TOKEN;
const YEAR_FILTER = (() => {
  const i = process.argv.indexOf('--year');
  return i > -1 ? Number(process.argv[i + 1]) : null;
})();
const ONLY = (() => {
  const i = process.argv.indexOf('--table');
  return i > -1 ? [process.argv[i + 1]] : [];
})();
const VERIFY = process.argv.includes('--verify');
const DDL_ONLY = process.argv.includes('--ddl');
const REBUILD = process.argv.includes('--rebuild');

/** 从 schema.sql 提取单表的 CREATE TABLE 并执行（--rebuild 用） */
async function applyDdlTable(table) {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const re = new RegExp('CREATE TABLE IF NOT EXISTS "' + table + '"[\\s\\S]*?\\);', 'i');
  const m = sql.match(re);
  if (!m) throw new Error(`schema.sql 中找不到表 ${table} 的 DDL`);
  await client.execute(m[0]);
}

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('✘ 缺少 TURSO_URL / TURSO_AUTH_TOKEN（.env 或环境变量）。');
  console.error('  获取方式：https://turso.app 建库后 → Connect → 复制 URL 与 Token');
  process.exit(1);
}

const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

/* 链账本表在独立的 ledger 库（carbon_chain_ledger）—— 与 migrate-to-d1
 * 同口径：这两张表清单在迁移时按需切换连接。 */
const LEDGER_TABLES = ['chain_block', 'chain_tx', 'chain_node', 'chain_node_replica', 'chain_payload_backup'];

async function ledgerConn() {
  const cfg = require('../server/config').ledgerDb;
  return mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user,
    password: cfg.password, database: cfg.database,
    charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
  });
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
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
  });
  return conn;
}

/** JS 值 → SQLite 字面量（与 migrate-to-d1.mjs 同口径） */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
  if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').slice(0, 19)}'`;
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** 执行 DDL：把 schema.sql 按分号切分逐条执行（跳过注释/空语句） */
async function applyDdl() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const stmts = sql
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter((s) => /^(CREATE|INSERT|DROP|ALTER)/i.test(s));
  console.log(`DDL：${stmts.length} 条语句（来自 db/d1/schema.sql）`);
  let done = 0;
  for (const s of stmts) {
    try {
      await client.execute(s);
    } catch (e) {
      /* 已存在的表/索引跳过 —— 幂等 */
      if (/already exists/i.test(String(e.message || e))) continue;
      throw e;
    }
    done++;
    if (done % 20 === 0) process.stdout.write(`\r  DDL ${done}/${stmts.length}`);
  }
  console.log(`\r  ✔ DDL 执行完成（新建 ${done}）              `);
}

async function listTables() {
  const c = await ensureConn();
  const [rows] = await c.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`,
    [env.DB_NAME || 'carbon_chain']);
  return rows.map((r) => r.t);
}

async function tableColumns(table) {
  const isLedger = LEDGER_TABLES.includes(table);
  const c = isLedger ? await ledgerConn() : await ensureConn();
  const db = isLedger ? require('../server/config').ledgerDb.database : (env.DB_NAME || 'carbon_chain');
  const [rows] = await c.query(
    `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [db, table]);
  if (isLedger) await c.end();
  return rows.map((r) => r.c);
}

async function tableRowCount(table) {
  const isLedger = LEDGER_TABLES.includes(table);
  const c = isLedger ? await ledgerConn() : await ensureConn();
  const [[r]] = await c.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  if (isLedger) await c.end();
  return Number(r.n);
}

async function tursoCount(table) {
  const r = await client.execute(`SELECT COUNT(*) AS c FROM "${table}"`);
  const row = r.rows[0];
  return Number(row ? row[0] : 0);
}

/** 迁移单表：id 游标分批，batch 原子写 */
async function migrateTable(table) {
  /* --rebuild：先 DROP 再迁 —— 用于修正"Turso 里有源库已没有的行"
   * （源库在迁移窗口内被运行时增删过，INSERT OR REPLACE 无法删除多余行） */
  if (REBUILD) {
    try { await client.execute(`DROP TABLE IF EXISTS "${table}"`); } catch { /* ignore */ }
    await applyDdlTable(table);
  }
  const isLedger = LEDGER_TABLES.includes(table);
  const total = await tableRowCount(table);
  if (!total) return { table, total: 0, written: 0 };

  const cols = await tableColumns(table);
  const c = isLedger ? await ledgerConn() : await ensureConn();
  const colList = cols.map((col) => `"${col}"`).join(',');

  let lastId = null;
  let written = 0;

  for (;;) {
    const baseWhere = YEAR_FILTER ? `WHERE year = ${YEAR_FILTER}` : '';
    const where = lastId === null ? baseWhere : (baseWhere ? baseWhere + ' AND id > ?' : 'WHERE id > ?');
    const params = lastId === null ? [] : [lastId];
    const [rows] = await c.query(
      `SELECT * FROM \`${table}\` ${where} ORDER BY id LIMIT ?`, [...params, BATCH_ROWS]);
    if (!rows.length) break;

    const stmts = rows.map((r) => {
      const vals = cols.map((col) => sqlLiteral(r[col])).join(',');
      return { sql: `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${vals})`, args: [] };
    });

    /* libSQL batch：一次 HTTP 往返原子提交整批 */
    await client.batch(stmts, 'write');

    written += rows.length;
    lastId = rows[rows.length - 1].id;
    process.stdout.write(`\r    ${table}: ${written}/${total} 行`);
    if (rows.length < BATCH_ROWS) break;
  }
  if (isLedger) await c.end();
  process.stdout.write('\n');
  return { table, total, written };
}

async function main() {
  console.log('='.repeat(78));
  console.log('  MySQL → Turso (libSQL) 数据迁移');
  console.log(`  目标：${TURSO_URL.replace(/\/\/.*@/, '//***@')}`);
  console.log('='.repeat(78));

  if (!VERIFY) {
    console.log('\n【1/2】执行 DDL（幂等，已存在的表跳过）…');
    await applyDdl();
  }

  if (DDL_ONLY) { console.log('\n✔ 完成（仅 DDL）'); process.exit(0); }

  const tables = await listTables();
  /* 链账本表在 ledger 库，主库清单里没有 —— 补进迁移范围 */
  const allTables = [...tables];
  for (const t of LEDGER_TABLES) if (!allTables.includes(t)) allTables.push(t);
  const targets = ONLY.length
    ? allTables.filter((t) => ONLY.includes(t))
    : allTables;
  console.log(`\n【2/2】迁移数据：${targets.length} 张表`);

  const log = [];
  for (const t of targets) {
    try {
      log.push(await migrateTable(t));
    } catch (e) {
      console.error(`\n  ✘ ${t} 失败：${String(e.message || e).slice(0, 200)}`);
      log.push({ table: t, error: String(e.message || e).slice(0, 100) });
    }
  }

  console.log('\n【核对】Turso 行数：');
  let mismatch = 0;
  for (const entry of log) {
    if (entry.error) { mismatch++; console.log(`  ✘ ${entry.table.padEnd(28)} 迁移失败：${entry.error}`); continue; }
    const turso = await tursoCount(entry.table);
    const ok = turso === entry.total;
    if (!ok) mismatch++;
    console.log(`  ${ok ? '✔' : '✘'} ${entry.table.padEnd(28)} MySQL ${String(entry.total).padStart(7)}  Turso ${String(turso).padStart(7)}${ok ? '' : '   ← 不一致'}`);
  }
  console.log(mismatch === 0 ? '\n✔ 迁移完成，全部一致' : `\n✘ ${mismatch} 张表不一致`);
  if (conn) await conn.end();
  process.exit(mismatch === 0 ? 0 : 1);
}

main().catch((e) => { console.error('✘ 失败：', e.message); process.exit(1); });
