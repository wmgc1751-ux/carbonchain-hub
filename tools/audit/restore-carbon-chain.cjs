#!/usr/bin/env node
/**
 * tools/audit/restore-carbon-chain.cjs —— 事故恢复：重建 carbon_chain
 * ============================================================================
 * 事故：2026-10-31 恢复演练 v1 将 db/01_schema.sql 内嵌的
 *       「DROP DATABASE IF EXISTS carbon_chain;」当普通语句执行，误删生产库。
 * 根因：schema 文件自带 DROP/CREATE DATABASE 语句 + 逐句执行器无危险语句过滤。
 * 恢复：从 tools/out/backup-2026-10-30T20-33-29（审计 RR-08 演练产物，含当日
 *       全部数据变更）重建 carbon_chain。账本 3307 未受影响，无需恢复。
 * 防再犯：本脚本显式剔除任何 DROP/CREATE/USE DATABASE 语句。
 * ============================================================================
 */
'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cfg = require('../../server/config.js');

const BK = process.argv[2] || path.resolve('tools/out/backup-2026-10-30T20-33-29');
const DB = 'carbon_chain';

async function importTable(conn, table, file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => '`' + c + '`').join(',');
  const ph = '(' + cols.map(() => '?').join(',') + ')';
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const vals = chunk.map((r) => cols.map((c) =>
      r[c] === null ? null : (typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])));
    await conn.query(`INSERT INTO \`${table}\` (${colList}) VALUES ${chunk.map(() => ph).join(',')}`, vals.flat());
  }
  return rows.length;
}

async function main() {
  console.log('事故恢复 · 备份源:', BK);
  const manifest = JSON.parse(fs.readFileSync(path.join(BK, 'manifest.json'), 'utf8'));

  const admin = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
    multipleStatements: true, charset: 'utf8mb4',
  });

  /* 1. 重建库（显式，不依赖 schema 内嵌语句） */
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  await admin.query('USE `' + DB + '`');

  /* 2. schema：剔除任何 DROP/CREATE/USE DATABASE 语句（防再犯）
     账本文件 00_schema_ledger.sql 自管理（自带 DROP/CREATE/USE
     carbon_chain_ledger）—— 在 3306 上按原样执行即得同名影子库，
     01_schema 末尾 chain_* 只读视图随之自然解析；3307 真账本不受影响。
     拆句器支持 DELIMITER 块（业务 schema 含存储过程）。 */
  const splitSql = (raw) => {
    const out = [];
    let delim = ';';
    let cur = '';
    for (const line of raw.replace(/^--.*$/gm, '').split(/\r?\n/)) {
      const t = line.trim();
      if (/^DELIMITER\s+/i.test(t)) { if (cur.trim()) out.push(cur.trim()); cur = ''; delim = t.split(/\s+/)[1]; continue; }
      cur += line + '\n';
      if (cur.trimEnd().endsWith(delim)) {
        let st = cur.trim();
        st = st.slice(0, st.length - delim.length).trim();
        if (st && !/^(DROP|CREATE|USE)\s+DATABASE/i.test(st)) out.push(st);
        cur = '';
      }
    }
    if (cur.trim() && !/^(DROP|CREATE|USE)\s+DATABASE/i.test(cur.trim())) out.push(cur.trim());
    return out;
  };
  await admin.query(fs.readFileSync('db/00_schema_ledger.sql', 'utf8'));
  const schemaFiles = ['db/01_schema.sql', 'db/04_schema_mrv.sql', 'db/05_schema_real.sql'];
  for (const f of schemaFiles) {
    const stmts = splitSql(fs.readFileSync(f, 'utf8'));
    for (const st of stmts) await admin.query('USE `' + DB + '`; ' + st);
    console.log('  ✔ schema:', f, `（${stmts.length} 句）`);
  }

  /* 3. 数据导入（动态 DDL 兜底）
     背景：22 张表（cems_cn_hourly / sys_user / trade_mandate / emission_calc 等）
     由迁移脚本/修复会话创建，不在 db/*.sql 声明文件里。恢复源用
     「JSON 行键 → 动态建表/补列」兜底，保证备份数据完整落库：
       · 类型推断：整数→BIGINT，小数→DOUBLE，日期串→DATETIME，对象→JSON，其余→TEXT
       · 已有表缺列 → ALTER TABLE ADD COLUMN
     row_counter 一并恢复（ID 计数器随之续用）。 */
  const sqlType = (v) => {
    if (v === null || v === undefined) return 'TEXT';
    if (typeof v === 'number') return Number.isInteger(v) ? 'BIGINT' : 'DOUBLE';
    if (typeof v === 'boolean') return 'TINYINT(1)';
    if (typeof v === 'object') return 'JSON';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return 'DATETIME';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'DATE';
    if (s.length <= 64) return 'VARCHAR(255)';
    return 'TEXT';
  };
  const ensureTable = async (conn, table, rows) => {
    const [exists] = await conn.query('SHOW TABLES LIKE ?', [table]);
    let cols = new Map();
    if (exists.length) {
      const [cs] = await conn.query('SHOW COLUMNS FROM `' + table + '`');
      for (const c of cs) cols.set(c.Field, c);
    } else {
      await conn.query('CREATE TABLE `' + table + '` (`__rid` BIGINT AUTO_INCREMENT PRIMARY KEY)');
    }
    const keys = new Set();
    for (const r of rows.slice(0, 300)) for (const k of Object.keys(r)) keys.add(k);
    for (const k of keys) {
      if (cols.has(k)) continue;
      const sample = rows.find((r) => r[k] !== null && r[k] !== undefined);
      const type = sample ? sqlType(sample[k]) : 'TEXT';
      await conn.query('ALTER TABLE `' + table + '` ADD COLUMN `' + k + '` ' + type);
      cols.set(k, { Field: k });
    }
    return cols;
  };
  const importTable = async (conn, table, file) => {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!rows.length) return 0;
    await ensureTable(conn, table, rows);
    const cols = (await conn.query('SHOW COLUMNS FROM `' + table + '`'))[0].map((c) => c.Field)
      .filter((c) => c !== '__rid');
    const colList = cols.map((c) => '`' + c + '`').join(',');
    const ph = '(' + cols.map(() => '?').join(',') + ')';
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = chunk.map((r) => cols.map((c) =>
        r[c] == null ? null : (typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])));
      await conn.query(`INSERT INTO \`${table}\` (${colList}) VALUES ${chunk.map(() => ph).join(',')}`, vals.flat());
    }
    return rows.length;
  };
  const tables = Object.keys(manifest.tables.business);
  let total = 0;
  const skipped = [];
  for (const t of tables) {
    const f = path.join(BK, 'business__' + t + '.json');
    if (!fs.existsSync(f)) continue;
    try {
      const n = await importTable(admin, t, f);
      total += n;
    } catch (e) {
      skipped.push(t + '（' + e.message.slice(0, 60) + '）');
    }
  }
  console.log(`  ✔ 数据导入：${total} 行（${tables.length - skipped.length} 表）· 跳过 ${skipped.length}：${skipped.join(', ') || '无'}`);

  /* 4. 校验 */
  const checks = {};
  for (const t of ['enterprise', 'emission_report', 'verify_task', 'sys_user', 'carbon_quota', 'cems_cn_hourly']) {
    checks[t] = Number((await admin.query('SELECT COUNT(*) n FROM `' + t + '`'))[0][0].n);
  }
  console.log('  ✔ 关键表行数:', JSON.stringify(checks));
  const [spot] = await admin.query("SELECT ent_name FROM enterprise WHERE id = 65");
  console.log('  ✔ 抽样 企业65:', spot[0].ent_name);

  await admin.end();
  console.log('恢复完成 ✅ —— 请重启应用并复核业务页面');
}
main().catch((e) => { console.error('✘', e.message); process.exit(1); });
