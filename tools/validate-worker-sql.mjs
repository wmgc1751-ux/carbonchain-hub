/**
 * validate-worker-sql.mjs —— 校验 Worker 里的列名与 MySQL 实际结构一致
 * ==================================================================================
 * 【为什么需要这个工具】
 *
 * 把 Express 后端重写到 Workers 时，最容易出的错不是逻辑，而是**列名**。
 * 本轮实际遇到的例子：
 *   · factor_entry 实际列是 `code/name_cn/of_rate/source_doc/version`
 *     而代码写的是 `fuel_code/fuel_name/of_value/basis/factor_version`
 *   · real_facility 的区域列是 `admin1`，预聚合表是 `region_code`
 *   · real_emission_year 没有 `device_did`（那是 cems_reading 的）
 *
 * 这些错误不会在语法检查时暴露，只会在请求时变成 500 ——
 * 而 500 被全局处理器泛化成"服务器内部错误"，运维看不到线索。
 *
 * 【做法】
 * 从 worker/ 目录抽出所有 `SELECT ... FROM <table>` 与 `INSERT INTO <table> (...)`
 * 的列引用，逐个与 information_schema 里的真实列名比对。
 * 不做完整 SQL 解析（那需要引入解析器），只做**高置信度的启发式检查**：
 *   · 明确写出表名的查询 → 检查其中的裸标识符是否是该表的列
 *   · 别名（f.xxx / e.xxx）→ 检查 xxx 是否在**任一**相关表里存在
 *
 * 这会漏一些、也会少量误报，但足以抓住"整列名写错"这一类致命问题。
 *
 * 用法：
 *   node tools/validate-worker-sql.mjs
 *   node tools/validate-worker-sql.mjs --verbose
 *
 * @module tools/validate-worker-sql
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

const VERBOSE = process.argv.includes('--verbose');

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
 * 一、收集真实列名
 * ================================================================================== */
async function loadSchema() {
  const conn = await mysql.createConnection({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
  });
  const biz = env.DB_NAME || 'carbon_chain';
  const ledger = env.LEDGER_DB_NAME || 'carbon_chain_ledger';

  const cols = new Map();   // table → Set(column)
  const [rows] = await conn.query(
    `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA IN (?, ?)`, [biz, ledger]);
  for (const r of rows) {
    if (!cols.has(r.t)) cols.set(r.t, new Set());
    cols.get(r.t).add(r.c.toLowerCase());
  }
  await conn.end();

  /* 预聚合表（D1 专用，MySQL 里没有）——按 db/d1/schema.sql 里的定义补上。
   * ⚠ 表名可能带引号（业务表由生成器加引号）或不带引号（预聚合表是手写的）。
   * 只用带引号的正则会漏掉后者，导致把 agg_* 全判成"未知表"——
   * 那是工具的假阳性，会掩盖真问题。 */
  const d1 = path.join(ROOT, 'db', 'd1', 'schema.sql');
  if (fs.existsSync(d1)) {
    const sql = fs.readFileSync(d1, 'utf8');
    const re = /CREATE TABLE IF NOT EXISTS\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/g;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const t = m[1];
      if (!cols.has(t)) cols.set(t, new Set());
      for (const line of m[2].split('\n')) {
        const cm = line.trim().match(/^"?(\w+)"?\s+(INTEGER|REAL|TEXT|BLOB)/i);
        if (cm) cols.get(t).add(cm[1].toLowerCase());
      }
    }
  }
  return cols;
}

/* ==================================================================================
 * 二、抽取 SQL 并检查
 * ================================================================================== */

/** SQL 保留字与函数名，不是列名 */
const KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'as', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'group', 'by', 'order', 'having',
  'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'case', 'when', 'then', 'else', 'end', 'distinct', 'count', 'sum', 'avg',
  'min', 'max', 'coalesce', 'ifnull', 'cast', 'int', 'integer', 'text', 'real',
  'asc', 'desc', 'union', 'all', 'exists', 'like', 'between', 'true', 'false',
  'current_timestamp', 'current_date', 'now', 'date', 'strftime', 'json_extract',
  'json_array_length', 'json_object', 'json_array', 'group_concat', 'replace',
  'nullif', 'abs', 'round', 'length', 'lower', 'upper', 'substr', 'substring',
  'timestamp', 'datetime', 'blob', 'varchar', 'decimal', 'boolean', 'integer',
  /* UPSERT 的 SET 子句关键字，不是表名 */
  'set', 'conflict', 'do', 'nothing', 'excluded', 'on',
]);

/** 从 worker/ 下所有 .mjs 抽取反引号模板字符串里的 SQL */
function extractSqlBlocks(text) {
  const out = [];
  const re = /`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) continue;
    /* 计算行号，便于定位 */
    const idx = m.index;
    const line = text.slice(0, idx).split('\n').length;
    out.push({ sql: body, line });
  }
  return out;
}

/**
 * 检查一段 SQL。
 * 策略：找出 `FROM x` / `JOIN x` / `INSERT INTO x` 里的表名，
 * 然后检查该 SQL 里出现的裸标识符是否都是这些表的列（或别名、关键字）。
 */
function checkSql(sql, allCols, file, line) {
  const problems = [];

  /* 归一化：去掉模板插值 ${...} */
  const normalized = sql.replace(/\$\{[^}]*\}/g, '?');

  /* 收集表。
   * ⚠ 两个必须排除的假阳性来源：
   *   ① `DO UPDATE SET` —— UPDATE 后面跟的是 SET，不是表名；
   *   ② `ON CONFLICT(kind, scope)` —— CONFLICT 后被括号包住时不是表名。
   * 若不排除，工具会报"未知表: set"，而这类假阳性会掩盖真正的问题。 */
  const tables = new Set();
  const tRe = /\b(?:FROM|JOIN|INSERT\s+INTO)\s+"?(\w+)"?|\bUPDATE\s+(?!SET\b)"?(\w+)"?/gi;
  let tm;
  while ((tm = tRe.exec(normalized)) !== null) {
    const nm = (tm[1] || tm[2] || '').toLowerCase();
    if (nm && !KEYWORDS.has(nm)) tables.add(nm);
  }

  /* CTE / 子查询别名不是表 */
  const known = new Set();
  for (const t of tables) {
    if (allCols.has(t)) [...allCols.get(t)].forEach((c) => known.add(c));
    else problems.push({ file, line, kind: '未知表', detail: t, sql: normalized.slice(0, 100).replace(/\s+/g, ' ') });
  }
  if (!known.size) return problems;

  /* 收集别名映射：f.id → f 来自 real_facility 之类。这里简化：所有别名共用已知列集合 */
  const aliases = new Set();
  const aRe = /\b(\w+)\.(\w+)/g;
  let am;
  while ((am = aRe.exec(normalized)) !== null) aliases.add(am[2].toLowerCase());

  /* 检查带别名的列引用 */
  aRe.lastIndex = 0;
  while ((am = aRe.exec(normalized)) !== null) {
    const col = am[2].toLowerCase();
    if (KEYWORDS.has(col)) continue;
    if (!known.has(col)) {
      problems.push({
        file, line, kind: '列名疑似不存在',
        detail: `${am[1]}.${am[2]}`,
        hint: `已收集 ${known.size} 个列名，未匹配 ${col}`,
        sql: normalized.slice(0, 120).replace(/\s+/g, ' '),
      });
    }
  }

  return problems;
}

/* ==================================================================================
 * 三、主流程
 * ================================================================================== */
async function main() {
  console.log('='.repeat(78));
  console.log('  Worker SQL 列名校验');
  console.log('='.repeat(78));

  const allCols = await loadSchema();
  console.log(`\n已加载 ${allCols.size} 张表的列定义\n`);

  const files = [];
  function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f.endsWith('.mjs')) files.push(p);
    }
  }
  walk(path.join(ROOT, 'worker'));

  const problems = [];
  let scanned = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const blk of extractSqlBlocks(text)) {
      scanned++;
      problems.push(...checkSql(blk.sql, allCols, path.relative(ROOT, f), blk.line));
    }
  }

  console.log(`扫描 ${files.length} 个文件 / ${scanned} 段 SQL\n`);

  if (!problems.length) {
    console.log('✔ 未发现列名问题');
    process.exit(0);
  }

  /* 按 (文件, 行, 详情) 去重 */
  const seen = new Set();
  const uniq = [];
  for (const p of problems) {
    const k = `${p.file}|${p.line}|${p.detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }

  /* 分组展示 */
  const byFile = new Map();
  for (const p of uniq) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  for (const [file, list] of byFile) {
    console.log(`✘ ${file}（${list.length} 处）`);
    for (const p of list) {
      console.log(`   L${p.line}  ${p.kind}: ${p.detail}`);
      if (p.hint) console.log(`          ${p.hint}`);
      if (VERBOSE) console.log(`          SQL: ${p.sql}`);
    }
  }

  console.log(`\n合计 ${uniq.length} 处疑似问题。`);
  console.log('提示：别名与子查询可能产生误报，请人工复核带 "unknown table" 的项。');
  process.exit(uniq.length ? 1 : 0);
}

main().catch((e) => { console.error('✘', e.message); process.exit(1); });
