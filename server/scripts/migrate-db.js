/**
 * migrate-db.js —— 数据库「增量迁移」脚本（幂等，不清库、不覆盖存量数据）
 * ------------------------------------------------------------------
 * 背景：线上数据库（TiDB Cloud）在代码重构新增表后，未随部署同步补齐新表，
 *       导致依赖新表的接口（因子库/因子版本/对账中心等）SQL 报错 → 500。
 *       而全量 initdb 会 DROP 重建所有表、清空存量数据与链上存证，风险高。
 *
 * 本脚本只做两件「安全、幂等」的事：
 *   1. 对 db/01_schema.sql 中所有表执行 `CREATE TABLE IF NOT EXISTS`
 *      —— 已存在的表原样跳过，绝不 DROP、绝不覆盖；
 *   2. 对「空表」补齐最小种子数据（仅因子库 emission_factor + 因子版本
 *      factor_version 两项，其余表空态即前端「暂无数据」的合法降级态）。
 *
 * 用法： node server/scripts/migrate-db.js
 *      （已接入 start-prod.js 启动自检，检测到缺表会自动调用本脚本）
 */
'use strict';

const fs = require('fs');
const mysql = require('mysql2/promise');
const config = require('../config');
const cu = require('../blockchain/crypto-utils');

/* 因子种子（与 init-db.js / seed-pools.js 保持一致，对齐 GB/T 32150） */
const ENERGY_TYPES = [
  { name: '原煤', unit: 't', factor: 1.9003, scope: 1 },
  { name: '焦炭', unit: 't', factor: 2.8604, scope: 1 },
  { name: '天然气', unit: '万m³', factor: 21.622, scope: 1 },
  { name: '柴油', unit: 't', factor: 3.0959, scope: 1 },
  { name: '燃料油', unit: 't', factor: 3.1705, scope: 1 },
  { name: '电力', unit: 'MWh', factor: 0.5703, scope: 2 },
  { name: '热力', unit: 'GJ', factor: 0.1100, scope: 2 },
];

/** 读取 schema，去掉库级语句与行注释，返回干净 DDL 文本 */
function readSchema() {
  let sql = fs.readFileSync(config.paths.schema, 'utf8');
  sql = sql.replace(/^\s*--.*$/gm, '');                 // 去行注释
  sql = sql
    .replace(/DROP\s+DATABASE[^;]*;/gi, '')
    .replace(/CREATE\s+DATABASE[^;]*;/gi, '')
    .replace(/USE\s+`?[\w$]+`?\s*;/gi, '');              // 云托管库无建库权限
  return sql;
}

/**
 * 提取所有 CREATE TABLE 语句，并把 `CREATE TABLE` 改写为
 * `CREATE TABLE IF NOT EXISTS`，实现幂等建表。
 * 用分号切分会导致 DDL 内注释/字符串里的分号误切，这里改为按
 * `CREATE TABLE` 关键字定位起始、按表尾 `) ENGINE=...;` 定位结束。
 */
function extractCreateTables(sql) {
  const tables = [];
  // 按 CREATE TABLE 切块：每块从 CREATE TABLE 到下一个 CREATE TABLE 或结尾
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([\w$]+)`?/gi;
  const matches = [...sql.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : sql.length;
    let ddl = sql.slice(start, end);
    // 截断到表定义结束的 `ENGINE=...;`（含分号），去掉尾部多余的 SET/注释
    const semi = ddl.search(/\)\s*ENGINE\s*=/i);
    if (semi !== -1) {
      const tail = ddl.indexOf(';', semi);
      if (tail !== -1) ddl = ddl.slice(0, tail + 1);
    }
    // 改写为 IF NOT EXISTS
    ddl = ddl.replace(/CREATE\s+TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
    tables.push({ name: m[1], ddl: ddl.trim() });
  }
  return tables;
}

/** 判断某表是否存在 */
async function tableExists(conn, dbName, table) {
  const [[r]] = await conn.query(
    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [dbName, table]
  );
  return Number(r.c) > 0;
}

/** 判断某表是否为空 */
async function tableEmpty(conn, table) {
  const [[r]] = await conn.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
  return Number(r.c) === 0;
}

async function main() {
  const t0 = Date.now();
  const dbName = config.db.database;
  console.log('─'.repeat(64));
  console.log('  碳链通 CarbonChain Hub —— 数据库增量迁移（幂等 · 不清库）');
  console.log(`  目标库: ${config.db.host}:${config.db.port}/${dbName}`);
  console.log('─'.repeat(64));

  const conn = await mysql.createConnection({ ...config.db, multipleStatements: false });

  const sql = readSchema();
  const tables = extractCreateTables(sql);
  console.log(`  读取到 ${tables.length} 张表定义，开始幂等建表…`);

  let created = 0, existed = 0;
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) {
    const exists = await tableExists(conn, dbName, t.name);
    if (exists) {
      existed++;
      continue;
    }
    await conn.query(t.ddl);
    created++;
    console.log(`  ＋ 新建表 ${t.name}`);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  /* ---- 补空表种子：因子库 + 因子版本 ---- */
  let seeded = 0;
  try {
    if (await tableEmpty(conn, 'emission_factor')) {
      const rows = ENERGY_TYPES.map((t, i) => [
        i + 1, t.name, t.factor, t.unit, t.scope,
        t.scope === 1 ? '国家温室气体排放核算指南' : '省级电网平均二氧化碳排放因子',
        null, 'v2026.1', new Date(2026, 0, 5), null, 'ACTIVE', null,
      ]);
      const ph = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
      await conn.query(
        `INSERT INTO emission_factor (id, energy_type, factor, unit, scope, source, industry, version, effective_from, effective_to, status, remark)
         VALUES ${ph}`,
        rows.flat()
      );
      seeded += rows.length;
      console.log(`  ➜ 补种子 emission_factor 因子 ${rows.length} 项`);
    }

    if (await tableEmpty(conn, 'factor_version')) {
      const snapshot = JSON.stringify(ENERGY_TYPES.map((t) => ({
        energyType: t.name, factor: t.factor, unit: t.unit, scope: t.scope,
      })));
      await conn.query(
        `INSERT INTO factor_version (id, version, effective_from, effective_to, operator, snapshot, status, created_at)
         VALUES (1, 'v2026.1', ?, NULL, '系统初始化', ?, 'ACTIVE', ?)`,
        [new Date(2026, 0, 5), snapshot, new Date(2026, 0, 5)]
      );
      seeded += 1;
      console.log(`  ➜ 补种子 factor_version 版本 1 条`);
    }
  } catch (e) {
    console.error('  ⚠ 补种子失败（表结构可能已存在但列不符，跳过）:', e.message);
  }

  /* ---- 补缺失的演示账号（trader01/trader02 交易端） ---- */
  // 旧版种子数据未含交易端账号，导致登录页「演示账号一键切换」缺交易端入口。
  // 这里幂等补齐：仅在 username 不存在时插入，绝不动已有账号。
  try {
    const demoUsers = [
      { username: 'trader01', real_name: '韩雪梅', role: 'TRADER', org_id: 1, org_name: '碳链通碳资产交易中心' },
      { username: 'trader02', real_name: '林志远', role: 'TRADER', org_id: 2, org_name: '碳链通碳资产交易中心' },
    ];
    for (const u of demoUsers) {
      const [existing] = await conn.query('SELECT id FROM sys_user WHERE username = ?', [u.username]);
      if (existing.length) continue;
      const salt = cu.randomSalt(8);
      const hash = cu.hashPassword('123456', salt);
      await conn.query(
        `INSERT INTO sys_user (username, password, salt, real_name, role, org_id, org_name, status, created_at)
         VALUES (?,?,?,?,?,?,?,1,NOW())`,
        [u.username, hash, salt, u.real_name, u.role, u.org_id, u.org_name]
      );
      seeded += 1;
      console.log(`  ➜ 补演示账号 ${u.username}（${u.real_name} · 交易端）`);
    }
  } catch (e) {
    console.error('  ⚠ 补演示账号失败（sys_user 表可能列结构不符，跳过）:', e.message);
  }

  await conn.end();
  console.log('─'.repeat(64));
  console.log(`  ✅ 迁移完成：新建表 ${created} 张，已存在跳过 ${existed} 张，补种子 ${seeded} 条`);
  console.log(`     用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

module.exports = { main, extractCreateTables, readSchema };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('✘ 增量迁移失败:', e);
    process.exit(1);
  });
}
