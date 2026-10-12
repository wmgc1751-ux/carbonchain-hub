/**
 * flag-legacy-outliers.js —— 标注遗留的量级异常读数（不删除）
 * ==================================================================
 * 背景
 * ------------------------------------------------------------------
 * 2026-10-12 傍晚的设备直报实测（HJ 212 模拟器）由**已被取代的旧构建**写入，
 * 瞬时速率最高达 4.6 万 tCO2e/h，比当前构建（约 30~50 tCO2e/h）高 3 个数量级。
 * 根因已随构建更新消失（当前路径写入 50.751 tCO2e/h，与
 * 「流速 × 截面积 × 3600 × 浓度 × 1e-9」的物理折算一致）。
 *
 * 为什么是"标注"而不是"删除"
 * ------------------------------------------------------------------
 * 这几百条记录带 device_did / CRC-16 / SM3 指纹，属于**源端证据**。
 * 一个"可信存证平台"如果会悄悄删掉对自己不利的源端数据，它宣称的可信度就一文不值。
 * 正确做法是：
 *   · 保留原始记录（值、时间、设备指纹一律不动）；
 *   · 把 quality_flag 改为 DRIFT —— 这正是该标记的语义（「测到了但读数存疑」）；
 *   · 由 WP4 的数据准入门控在核算中排除，并在报告中如实披露剔除数量与理由。
 * 于是这条历史缺陷反而成了"质量门控真的在干活"的现场证据。
 *
 * 判据（两条，任一命中即标注）
 * ------------------------------------------------------------------
 *   ① 绝对量级：flow_value > HARD_MAX_RATE（单排口工程上限，与 WP4 门控同源）
 *   ② 相对基准：flow_value > 5 × **同排口平台自举读数的中位数**
 *      基准刻意只取 `device_did IS NULL` 的行 —— 也就是由当前构建生成的干净读数，
 *      避免"用被污染的基准去判污染"。中位数而非均值，理由同上。
 *
 * 用法
 *   node server/scripts/flag-legacy-outliers.js --dry-run   # 只看会改多少行
 *   node server/scripts/flag-legacy-outliers.js             # 执行并重算
 */
'use strict';

const db = require('../db');
const dyn = require('../services/dynamic');

/** 相对基准倍数阈值（与 WP4 的稳健离群门控一致） */
const RATIO_LIMIT = 5;
/** 该时刻之前的设备直报属于被取代构件的压测批次 */
const CUTOFF = '2026-10-12 22:00:00';

function median(arr) {
  if (!arr.length) return null;
  const v = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const u = require('../services/uncertainty');
  const HARD = u.HARD_MAX_RATE;

  console.log('▶ 标注遗留量级异常读数（保留原始记录，仅改质量标记）');
  console.log('─'.repeat(72));

  /* 1) 基准：同排口的平台自举读数中位数（只用当前构建生成的干净数据） */
  const clean = await db.query(
    `SELECT monitor_no, flow_value FROM cems_reading
      WHERE device_did IS NULL AND quality_flag = 'NORMAL' AND flow_value > 0`
  );
  const byMon = new Map();
  for (const r of clean) {
    const k = String(r.monitor_no);
    if (!byMon.has(k)) byMon.set(k, []);
    byMon.get(k).push(Number(r.flow_value));
  }
  const med = new Map();
  for (const [k, v] of byMon) med.set(k, median(v));
  console.log(`基准：${med.size} 个排口，取自 ${clean.length} 条平台自举读数（中位数）`);

  /* 2) 逐条判定待标注的设备直报读数 */
  const dev = await db.query(
    `SELECT id, monitor_no, reading_time, flow_value, quality_flag FROM cems_reading
      WHERE device_did IS NOT NULL AND reading_time < ?
      ORDER BY id`, [CUTOFF]
  );
  const hits = [];
  const reasons = { absolute: 0, relative: 0, noBaseline: 0, kept: 0 };
  for (const r of dev) {
    const flow = Number(r.flow_value);
    const base = med.get(String(r.monitor_no));
    let hit = false;
    if (flow > HARD) { hit = true; reasons.absolute++; }
    else if (base && flow / base > RATIO_LIMIT) { hit = true; reasons.relative++; }
    else if (!base) reasons.noBaseline++;
    if (hit) hits.push(r.id);
    else reasons.kept++;
  }

  console.log(`待判设备直报读数：${dev.length} 条`);
  console.log(`  · 命中绝对量级（> ${HARD} tCO2e/h）：${reasons.absolute} 条`);
  console.log(`  · 命中相对基准（> ${RATIO_LIMIT} × 同排口中位数）：${reasons.relative} 条`);
  console.log(`  · 无基准可比、按保留处理：${reasons.noBaseline} 条`);
  console.log(`  · 判定正常、保留：${reasons.kept} 条`);

  const toFlag = [];
  for (const r of dev) if (hits.includes(r.id) && r.quality_flag !== 'DRIFT') toFlag.push(r.id);

  if (!toFlag.length) { console.log('\n无需处理（已全部标注）。'); return; }
  if (dry) { console.log(`\n[dry-run] 将标注 ${toFlag.length} 条，未做修改。`); return; }

  /* 3) 分批标注（每批 ≤ 500，避免超长 IN 列表） */
  let affected = 0;
  for (let i = 0; i < toFlag.length; i += 500) {
    const slice = toFlag.slice(i, i + 500);
    const res = await db.query(
      `UPDATE cems_reading SET quality_flag = 'DRIFT', status = 'ABNORMAL'
        WHERE id IN (${slice.map(() => '?').join(',')}) AND quality_flag <> 'DRIFT'`, slice
    );
    affected += res.affectedRows || 0;
  }
  console.log(`\n✔ 已标注 ${affected} 条为 DRIFT / ABNORMAL（原值、时间、设备指纹均未改动）`);

  const q = await db.query(
    `SELECT quality_flag, COUNT(*) AS n FROM cems_reading GROUP BY quality_flag ORDER BY n DESC`);
  const tot = q.reduce((s, x) => s + Number(x.n), 0);
  console.log('\n质量标记分布：');
  for (const x of q) {
    console.log(`  ${String(x.quality_flag).padEnd(12)} ${String(x.n).padStart(7)} 条  ${((Number(x.n) / tot) * 100).toFixed(2)}%`);
  }

  console.log('\n重新滚动核算 …');
  await dyn.resetCorrCache();
  await dyn.recompute();
  const ov = await dyn.overview();
  console.log(`核算完成：风险 高 ${ov.summary.highRisk} / 中 ${ov.summary.mediumRisk} / 低 ${ov.summary.lowRisk}`);
  console.log('─'.repeat(72));
  console.log('✅ 完成。');
}

main()
  .then(async () => { await db.pool.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('✘ 失败：', e);
    try { await db.pool.end(); } catch (x) { /* ignore */ }
    process.exit(1);
  });
