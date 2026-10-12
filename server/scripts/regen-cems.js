/**
 * regen-cems.js —— 重建自举 CEMS 读数（含数据质量扰动）
 * ==================================================================
 * 什么时候需要它
 * ------------------------------------------------------------------
 * `dynamic.js#ingest` 的质量扰动规则是**后加的**。已经跑过 `npm run initdb` 的库，
 * 里面存的是"清一色 NORMAL"的旧自举数据，`INSERT IGNORE` 又按
 * (ent_id, monitor_no, reading_time) 去重 —— 直接重跑 ingest 一条都不会变。
 * 所以要先用本脚本把**平台自举的读数**清掉再重生成。
 *
 * 只清什么、不清什么
 * ------------------------------------------------------------------
 *   · 清：`device_did IS NULL` 的行 —— 这些是平台自举生成的（可复现的模拟工况）；
 *   · 留：`device_did IS NOT NULL` 的行 —— 这些是真实设备通过 HJ 212 报文上报的，
 *         带着 CRC / SM3 / 报文原始时间，属于"源端证据"，绝不因重建自举数据而被抹掉。
 * 默认按 --all 语义重建 30 天窗口（与 init-db 的 bootstrap 一致）。
 *
 * 对联盟链有无影响
 * ------------------------------------------------------------------
 * 无。链上存的是**锚定时刻**的 payload 摘要与签名，payload 本身只含
 * `{ batchNo, readingCount, at }`，不回读 cems_reading；链下重算绑定校验
 * （tools/verify-offline.mjs）的输入是链表自身的 payload_json，与读数表无关。
 *
 * 用法
 *   node server/scripts/regen-cems.js            # 默认 30 天窗口
 *   node server/scripts/regen-cems.js --days 7
 */
'use strict';

const db = require('../db');
const dyn = require('../services/dynamic');

async function main() {
  const di = process.argv.indexOf('--days');
  const days = di >= 0 ? Number(process.argv[di + 1]) || 30 : 30;

  console.log('▶ 重建自举 CEMS 读数（含质量扰动）');
  console.log('─'.repeat(68));

  const before = await db.one(
    `SELECT COUNT(*) AS total, SUM(device_did IS NULL) AS self_gen,
            SUM(device_did IS NOT NULL) AS device_reported FROM cems_reading`
  );
  console.log(`重建前：共 ${before.total} 条（平台自举 ${before.self_gen} / 设备直报 ${before.device_reported}）`);

  const del = await db.query('DELETE FROM cems_reading WHERE device_did IS NULL');
  console.log(`已清理平台自举读数：${del.affectedRows} 条（设备直报读数列一律保留）`);

  console.log(`\n重新生成近 ${days} 天准实时读数 …`);
  const r = await dyn.ingest({ days });
  console.log(`生成完成：批次 ${r.batchNo}，新增 ${r.inserted} 条，覆盖 ${r.enterprises} 家企业，每点 ${r.points} 个采样`);

  const q = await db.query(
    `SELECT quality_flag, COUNT(*) AS cnt FROM cems_reading GROUP BY quality_flag ORDER BY cnt DESC`
  );
  const total = q.reduce((s, x) => s + Number(x.cnt), 0);
  console.log('\n质量标记分布：');
  for (const x of q) {
    console.log(`  ${String(x.quality_flag).padEnd(12)} ${String(x.cnt).padStart(7)} 条  ${((Number(x.cnt) / total) * 100).toFixed(2)}%`);
  }

  console.log('\n重新滚动核算 …');
  await dyn.recompute();
  const ov = await dyn.overview();
  console.log(`核算就绪：企业 ${ov.summary.enterprises} 家 · 风险 高 ${ov.summary.highRisk} / 中 ${ov.summary.mediumRisk} / 低 ${ov.summary.lowRisk}`);
  console.log(`累计排放 ${ov.summary.cumulativeEmission.toFixed(2)} tCO₂e · 总缺口 ${ov.summary.totalGap.toFixed(2)} tCO₂e`);

  console.log('─'.repeat(68));
  console.log('✅ 完成。请重启服务以刷新内存中的动态核算缓存。');
}

main()
  .then(async () => { await db.pool.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('✘ 重建失败：', e);
    try { await db.pool.end(); } catch (x) { /* ignore */ }
    process.exit(1);
  });
