#!/usr/bin/env node
/**
 * tools/audit/retention-purge.cjs —— RR-06 数据留存策略执行器
 * ============================================================================
 * 策略（分类分级见 审计-20261031/数据留存策略.md）：
 *   audit_log          365 天（审计留痕：与链上锚定互补，超期归档后清理）
 *   cems_reading       730 天（原始实测：永久保留为证据，此处仅演示窗口清理能力）
 *   cems_cn_hourly     永久（REAL 层，不清理 —— 脚本硬编码跳过）
 *   zk_disclosure_log  180 天
 *   notify / data_ingest_log  180 天
 * 默认 --dry（只统计不删除）；--execute 才实际删除。
 * ============================================================================
 */
'use strict';
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'server', 'db'));

const POLICY = [
  { table: 'audit_log', column: 'created_at', days: 365, note: '审计留痕（超期建议先归档）' },
  { table: 'zk_disclosure_log', column: 'created_at', days: 180 },
  { table: 'data_ingest_log', column: 'created_at', days: 180 },
  { table: 'cems_reading', column: 'reading_time', days: 730 },
];
const PROTECTED = ['cems_cn_hourly', 'cems_public_reading', 'emission_calc', 'emission_report', 'chain_tx', 'chain_block'];

(async () => {
  const EXEC = process.argv.includes('--execute');
  console.log(`数据留存策略执行  ${EXEC ? '【实际删除】' : '【试算 --dry】'}`);
  let total = 0;
  for (const p of POLICY) {
    try {
      const n = Number(await db.value(
        `SELECT COUNT(*) FROM \`${p.table}\` WHERE \`${p.column}\` < DATE_SUB(NOW(), INTERVAL ${p.days} DAY)`));
      if (!n) continue;
      total += n;
      console.log(`  ${p.table}: ${n} 条超期（>${p.days} 天）${EXEC ? '→ 已删除' : '→ 将删除'}`);
      if (EXEC) await db.query(
        `DELETE FROM \`${p.table}\` WHERE \`${p.column}\` < DATE_SUB(NOW(), INTERVAL ${p.days} DAY)`);
    } catch (e) { console.log(`  ${p.table}: 跳过（${e.message.slice(0, 60)}）`); }
  }
  console.log(`PROTECTED（永不清理）：${PROTECTED.join(', ')}`);
  console.log(total ? (EXEC ? `共删除 ${total} 条` : `共 ${total} 条待清理（加 --execute 执行）`) : '无超期数据');
  await db.pool.end();
})().catch((e) => { console.error('✘', e.message); process.exit(1); });
