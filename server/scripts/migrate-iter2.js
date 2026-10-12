/**
 * migrate-iter2.js —— 第 2 轮升级（WP5 / WP2 阶段一 / WP4）数据库迁移
 * ------------------------------------------------------------------
 * 与 migrate-iter1.js 同一套约定：
 *   · 不 DROP 任何表、不改动任何既有列的数据（只增不删）；
 *   · DDL 从 db/01_schema.sql 抽取，保持单一事实来源，避免脚本与 schema 漂移；
 *   · 每一步都有存续性检查，可安全重复执行（幂等）。
 *
 * 迁移内容（全部为新增表）
 *   · cbam_declaration      CBAM 申报数据包          （WP5）
 *   · green_power_match     小时级绿电溯源匹配        （WP5）
 *   · report_export         双轨报告导出台账          （WP5）
 *   · key_rotation_log      密钥轮换与双人复核日志    （WP2 阶段一）
 *   · uncertainty_posterior 贝叶斯后验不确定度        （WP4）
 *   · model_eval            预测模型评估与消融实验    （WP4）
 *
 * 用法：node server/scripts/migrate-iter2.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

/** 本批次新增的表（顺序即依赖顺序） */
const NEW_TABLES = [
  'cbam_declaration', 'green_power_match', 'report_export',
  'key_rotation_log', 'uncertainty_posterior', 'model_eval',
];

/* ------------------------------------------------------------------ */

async function tableExists(conn, name) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [config.db.database, name]
  );
  return Number(r[0].n) > 0;
}

async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [config.db.database, table, column]
  );
  return Number(r[0].n) > 0;
}

/** 从 01_schema.sql 中抽取指定表的 CREATE TABLE 语句（单一事实来源） */
function extractCreateStatements(sqlFile, tables) {
  const sql = fs.readFileSync(sqlFile, 'utf8').replace(/^\s*--.*$/gm, '');
  const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 2);
  const picked = [];
  for (const name of tables) {
    const re = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${name}\`?\\s*\\(`, 'i');
    const found = stmts.find((s) => re.test(s));
    if (!found) throw new Error(`01_schema.sql 中未找到表 ${name} 的定义`);
    picked.push(found.replace(/^CREATE\s+TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS '));
  }
  return picked;
}

async function main() {
  console.log('▶ 碳链通 CarbonChain Hub —— 第 2 轮升级数据库迁移（WP5 / WP2 / WP4 · 增量幂等）');
  console.log('─'.repeat(68));

  const conn = await mysql.createConnection(config.db);
  let changed = 0;

  try {
    console.log('\n[一] 新增表');
    const ddlFile = path.resolve(config.paths.root, 'db', '01_schema.sql');
    const stmts = extractCreateStatements(ddlFile, NEW_TABLES);
    for (let i = 0; i < NEW_TABLES.length; i++) {
      const name = NEW_TABLES[i];
      const existed = await tableExists(conn, name);
      await conn.query(stmts[i]);
      console.log(`  ${existed ? '·' : '+'} ${name.padEnd(24)} ${existed ? '已存在（跳过创建）' : '已创建'}`);
      if (!existed) changed++;
    }

    /* green_power_match.provenance 是本轮补的列（表已存在时需单独补） */
    console.log('\n[二] 既有新表补列');
    if (await tableExists(conn, 'green_power_match')) {
      const ok = await columnExists(conn, 'green_power_match', 'provenance');
      if (ok) {
        console.log('  · green_power_match.provenance   已存在（跳过）');
      } else {
        await conn.query("ALTER TABLE green_power_match ADD COLUMN provenance JSON DEFAULT NULL COMMENT '数据来源与推算方法声明(实测/推算分别标注，防止把推算值当实测值)' AFTER residual_factor");
        console.log('  + green_power_match.provenance   已添加');
        changed++;
      }
    }

    console.log('\n[校验] 结构落位确认');
    let bad = 0;
    for (const t of NEW_TABLES) {
      const ok = await tableExists(conn, t);
      if (!ok) bad++;
      const n = ok ? Number((await conn.query(`SELECT COUNT(*) AS n FROM ${t}`))[0][0].n) : 0;
      console.log(`  ${ok ? '✔' : '✘'} 表 ${t.padEnd(24)} 现有 ${n} 行`);
    }

    console.log('\n' + '─'.repeat(68));
    console.log(`✔ 迁移完成：本次实际变更 ${changed} 项（重复执行将显示 0 项）`);
    if (bad) console.log(`✘ 有 ${bad} 张表未建成，请检查上方输出`);
    console.log('  下一步：node server/scripts/seed-iter2.js   （灌入 WP2/WP4/WP5 的种子数据）');
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('\n✘ 迁移失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
