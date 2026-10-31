/**
 * migrate-real.js —— 应用真实数据层 DDL（幂等，不动既有数据）
 * ==================================================================================
 * 与 init-db.js（重建全部数据）不同：本脚本**只建表**，不删任何行。
 * 用于在已有生产库上增量引入真实数据层。
 *
 * 用法：
 *   node server/scripts/migrate-real.js            # 建表
 *   node server/scripts/migrate-real.js --verify   # 只校验表是否存在
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

const TABLES = ['real_facility', 'real_emission_year', 'real_series', 'live_rollup', 'truth_declaration'];

async function main() {
  const verifyOnly = process.argv.includes('--verify');
  const conn = await mysql.createConnection({
    ...config.db,
    multipleStatements: false,
  });

  try {
    if (!verifyOnly) {
      const file = config.paths.realSchema;
      if (!fs.existsSync(file)) throw new Error(`DDL 文件不存在：${file}`);
      let sql = fs.readFileSync(file, 'utf8');
      /* 去行注释 + 保留 SET NAMES */
      sql = sql.replace(/^\s*--.*$/gm, '');
      const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 3);
      let n = 0;
      for (const s of stmts) {
        if (/^SET\s+NAMES/i.test(s)) { await conn.query(s); continue; }
        await conn.query(s);
        n++;
      }
      console.log(`✔ 真实数据层 DDL 执行 ${n} 条（幂等，未触碰既有数据）`);
    }

    /* 校验：表存在 + 行数 */
    const [rows] = await conn.query(
      `SELECT table_name AS t, table_rows AS n
         FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name IN (?)
        ORDER BY table_name`, [TABLES]
    );
    const found = new Set(rows.map((r) => r.t));
    const missing = TABLES.filter((t) => !found.has(t));
    if (missing.length) {
      console.error(`✘ 缺失表：${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('✔ 5 张表全部就绪：');
    for (const r of rows) console.log(`   ${r.t.padEnd(22)} ~${r.n} 行`);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('✘ 迁移失败：', e.message);
  process.exit(1);
});
