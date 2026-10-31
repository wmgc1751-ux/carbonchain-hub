/**
 * migrate-notice-feed.js —— 通知公告表升级：接入真实外部消息源
 * ==================================================================================
 * 变更：
 *   1. notice 表新增三列：
 *        source_name   来源名称（如"生态环境部"）
 *        source_url    原文链接（权威平台 URL）
 *        fetched_at    抓取时间（区分"实时抓取"与"平台自建"）
 *   2. notice_type 扩充两个值：OFFICIAL（官方通知）、INTL（国际动态）
 *      原有 POLICY / MARKET / SYSTEM 继续沿用，语义不变。
 *   3. 清空原 initdb 生成的 60 条模板公告（内容为循环填充的占位文案），
 *      为真实消息让位。已阅记录表 notice_read 不动。
 *
 * 用法：node server/scripts/migrate-notice-feed.js
 */
'use strict';

(async () => {
  const mysql = require('mysql2/promise');
  const cfg = require('../config').db;

  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user,
    password: cfg.password, database: cfg.database,
    multipleStatements: false,
  });

  try {
    console.log('→ 通知公告表升级（真实消息源）');

    /* 1. 加列（已存在则跳过） */
    const [cols] = await conn.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME = 'notice'",
      [cfg.database],
    );
    const have = new Set(cols.map((c) => c.COLUMN_NAME));

    const adds = [
      ['source_name', "VARCHAR(120) NULL COMMENT '来源名称（权威平台）'"],
      ['source_url', "VARCHAR(500) NULL COMMENT '原文链接'"],
      ['fetched_at', "DATETIME NULL COMMENT '抓取时间'"],
    ];
    for (const [col, ddl] of adds) {
      if (!have.has(col)) {
        await conn.query(`ALTER TABLE notice ADD COLUMN ${col} ${ddl}`);
        console.log(`  ✔ notice + ${col}`);
      } else {
        console.log(`  · notice.${col} 已存在，跳过`);
      }
    }

    /* 2. 删除模板占位公告（title 含"（2）"等循环编号或内容是模板文案） */
    const [del] = await conn.query(
      `DELETE FROM notice WHERE content LIKE '%如有疑问请联系平台运维值班电话%'`,
    );
    console.log(`  ✔ 清除模板占位公告 ${del.affectedRows} 条`);

    /* 3. 保留 platform 自建公告数的下限提示 */
    const [left] = await conn.query('SELECT COUNT(*) AS c FROM notice');
    console.log(`  · 剩余公告 ${left[0].c} 条（随后由真实抓取填充）`);

    console.log('✔ 完成');
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('✘ 迁移失败：', e.message); process.exit(1); });
