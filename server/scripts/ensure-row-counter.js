/**
 * ensure-row-counter.js —— 行数计数表：建立 / 修复 / 全量重建（幂等）
 * ------------------------------------------------------------------
 * 用途一（首次启用）：在**不重跑 initdb** 的存量库上建立 row_counter 表与
 *   real_emission_year 的 AFTER INSERT / AFTER DELETE 触发器，并全量重建计数。
 * 用途二（失真修复）：若有人 TRUNCATE real_emission_year（TRUNCATE 不触发
 *   DELETE 触发器，计数会漂移），重跑本脚本即恢复精确计数。
 *
 * 用法： node server/scripts/ensure-row-counter.js
 * 说明：/api/regulator/system 读取该计数表将 real_emission_year 的全表 COUNT
 *   （约 34 万行 ~1.9 s）降为 O(1) 读数 —— 这是**精确计数**（触发器逐行维护），
 *   绝非 information_schema.TABLE_ROWS 那种统计估算；读侧取不到计数行时自动
 *   回退全表 COUNT（regulator.js#computeSystem），宁可慢也不给近似值。
 */
'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');

async function main() {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: false });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS row_counter (
      table_name VARCHAR(64) NOT NULL COMMENT '被计数的业务表名',
      row_count  BIGINT       NOT NULL DEFAULT 0 COMMENT '精确行数（触发器维护）',
      updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近一次增减/重建时刻',
      PRIMARY KEY (table_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='业务表精确行数计数（触发器维护，禁估算）'`);

    await conn.query('DROP TRIGGER IF EXISTS trg_rey_row_inc');
    await conn.query(`CREATE TRIGGER trg_rey_row_inc AFTER INSERT ON real_emission_year
      FOR EACH ROW
      INSERT INTO row_counter (table_name, row_count, updated_at)
      VALUES ('real_emission_year', 1, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE row_count = row_count + 1, updated_at = CURRENT_TIMESTAMP`);
    await conn.query('DROP TRIGGER IF EXISTS trg_rey_row_dec');
    await conn.query(`CREATE TRIGGER trg_rey_row_dec AFTER DELETE ON real_emission_year
      FOR EACH ROW
      UPDATE row_counter SET row_count = row_count - 1, updated_at = CURRENT_TIMESTAMP
      WHERE table_name = 'real_emission_year'`);

    await conn.query(`REPLACE INTO row_counter (table_name, row_count, updated_at)
      SELECT 'real_emission_year', COUNT(*), CURRENT_TIMESTAMP FROM real_emission_year`);

    /* 自证：计数行必须与真实 COUNT(*) 一致，否则本次启用失败（不静默） */
    const [[rc]] = await conn.query(`SELECT row_count FROM row_counter WHERE table_name = 'real_emission_year'`);
    const [[ac]] = await conn.query('SELECT COUNT(*) AS n FROM real_emission_year');
    const counted = Number(rc.row_count); const actual = Number(ac.n);
    if (counted !== actual) throw new Error(`重建后仍不一致：counter=${counted} actual=${actual}`);
    console.log(`✔ row_counter 就绪：real_emission_year = ${counted} 行（与真实 COUNT(*) 一致）`);
    console.log('  触发器 trg_rey_row_inc / trg_rey_row_dec 已建立，后续增删自动维护');
  } finally {
    await conn.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('✘ 失败:', e.message); process.exit(1); });
