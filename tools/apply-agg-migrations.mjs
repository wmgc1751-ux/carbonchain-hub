#!/usr/bin/env node
/**
 * tools/apply-agg-migrations.mjs —— 应用聚合层与生成列的结构迁移
 * ==================================================================
 * 幂等执行 db/06_schema_agg.sql 与 db/07_schema_assetkind.sql。
 *
 * 为什么需要专门的迁移器而不是直接 `mysql < file.sql`：
 *   · 07 里有 `DELIMITER $$`（存储过程），那是 mysql CLI 的客户端指令，
 *     协议层不认识，必须自己切分；
 *   · 08 需要判断列/索引是否已存在（MySQL 8 不支持 ADD COLUMN IF NOT EXISTS）；
 *   · 迁移要能重复执行且不报错 —— 部署脚本每次启动都会调它。
 *
 * 用法
 *   node tools/apply-agg-migrations.mjs
 *   node tools/apply-agg-migrations.mjs --check   # 只报告状态，不改结构
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const ROOT = process.cwd();
const ONLY_CHECK = process.argv.includes('--check');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
};

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.trim().match(/^([\w.]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const E = { ...readEnv(path.join(ROOT, '.env')), ...process.env };
const DB = {
  host: E.DB_HOST || '127.0.0.1',
  port: Number(E.DB_PORT || 3306),
  user: E.DB_USER || 'root',
  password: E.DB_PASSWORD || '',
  database: E.DB_NAME || 'carbon_chain',
  multipleStatements: true,
};

/** 把带 DELIMITER 的 SQL 切成协议层可执行的一条条语句 */
function splitSql(raw) {
  let sql = raw.replace(/^\s*--.*$/gm, '');
  const GUARD = '\u0001';
  /* DELIMITER $$ ... DELIMITER ; 之间的过程体：把体内 ';' 换成占位符 */
  sql = sql.replace(/DELIMITER\s+\$\$([\s\S]*?)DELIMITER\s*;/gi, (m, body) =>
    body.replace(/;/g, GUARD).replace(/\$\$\s*$/, ';\n'));
  return sql.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
    .map((s) => s.split(GUARD).join(';'));
}

async function tableExists(conn, t) {
  const [r] = await conn.query(
    'SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]
  );
  return Number(r[0].c) > 0;
}

async function main() {
  const conn = await mysql.createConnection(DB);
  try {
    console.log(`\n  库 ${DB.user}@${DB.host}:${DB.port}/${DB.database}`);

    if (ONLY_CHECK) {
      for (const t of ['agg_emission_total', 'agg_industry_year', 'agg_region_year', 'agg_industry_stats', 'agg_meta']) {
        const has = await tableExists(conn, t);
        console.log(`  ${has ? C.ok('✔') : C.bad('✘')} ${t}`);
      }
      const [col] = await conn.query(
        "SELECT COUNT(*) c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='real_emission_year' AND column_name='asset_kind'"
      );
      console.log(`  ${Number(col[0].c) ? C.ok('✔') : C.bad('✘')} real_emission_year.asset_kind（生成列）`);
      return;
    }

    /* 06：聚合表（纯 CREATE TABLE IF NOT EXISTS，天然幂等） */
    const sql06 = fs.readFileSync(path.join(ROOT, 'db', '06_schema_agg.sql'), 'utf8');
    let n06 = 0;
    for (const s of splitSql(sql06)) { await conn.query(s); n06++; }
    console.log(C.ok(`✔ 06 聚合表就绪（${n06} 条语句）`));

    /* 08：生成列（内部已做存在性判断，可重复执行） */
    const sql08 = fs.readFileSync(path.join(ROOT, 'db', '07_schema_assetkind.sql'), 'utf8');
    /* 08 里用了 DELIMITER + 存储过程；服务器的 multipleStatements 无法直接吃
     * DELIMITER，因此这里按过程体整体下发（CREATE PROCEDURE 本身是一条语句）。 */
    const procBody = sql08.replace(/^\s*--.*$/gm, '');
    const guard = '\u0001';
    const withGuarded = procBody.replace(/DELIMITER\s+\$\$([\s\S]*?)DELIMITER\s*;/gi, (m, body) =>
      body.replace(/;/g, guard).replace(/\$\$\s*$/, ';\n'));
    const stmts08 = withGuarded.split(';').map((s) => s.trim()).filter((s) => s.length > 3)
      .map((s) => s.split(guard).join(';'));
    for (const s of stmts08) await conn.query(s);
    console.log(C.ok(`✔ 07 生成列就绪（${stmts08.length} 条语句）`));

    /* 报告结果 */
    const [col] = await conn.query(
      "SELECT COLUMN_NAME, EXTRA FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='real_emission_year' AND column_name='asset_kind'"
    );
    console.log(col.length
      ? C.ok(`✔ real_emission_year.asset_kind 已存在（${col[0].EXTRA || 'STORED'}）`)
      : C.bad('✘ real_emission_year.asset_kind 创建失败'));
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(C.bad('✘ 迁移失败：'), e.code || '', e.message || e);
  process.exit(1);
});
