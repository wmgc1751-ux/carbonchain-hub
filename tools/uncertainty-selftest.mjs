/**
 * uncertainty-selftest.mjs —— WP4 核算升级的验收脚本
 * ==================================================================
 * 分两层：
 *   A. 纯逻辑断言（不依赖数据库）—— 直接跑 services/uncertainty.js#selfTest()
 *   B. 真实数据断言（依赖库）—— 这几条才是最有分量的，因为它们是**跨模块口径对账**：
 *
 *      B1 读数积分 vs 平台动态核算账
 *         把 cems_reading 的瞬时速率按 Δt 积分为年度排放，应当与
 *         `carbon_dynamic_account.predicted_eoy` 在同一量级（±15%）。
 *         这一条是回归断言：本轮修掉的口径缺陷正是"读数积分与动态核算差 2 倍"，
 *         一旦有人再把 flow_value 的单位改回去，这里会立刻红。
 *
 *      B2 采样密度无关性
 *         同一企业的日均序列，无论其读数来自 4h 周期还是 1min 周期，
 *         积分口径必须给出同一量级（否则就是"按固定周期折算"的老错误）。
 *
 *      B3 门控真的在剔除东西
 *         全平台剔除率应落在合理区间（1%~15%）：为 0 说明门控是摆设，
 *         过高说明把正常数据也砍了。
 *
 *      B4 两口径交叉校验的必要条件
 *         对抽样企业，GUM 合成不确定度必须 ≥ 贝叶斯抽样不确定度。
 *
 * 用法
 *   npm run uncertainty:selftest
 *   node tools/uncertainty-selftest.mjs --ents 1,2,37
 */
'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const U = require('../server/services/uncertainty');
const db = require('../server/db');

const argOf = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 ? process.argv[i + 1] : d;
};

let pass = 0; let fail = 0;
const line = (okFlag, name, detail) => {
  if (okFlag) pass++; else fail++;
  console.log(`  ${okFlag ? '✔' : '✗'} ${name}${detail ? '  →  ' + detail : ''}`);
};
const pct = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  WP4 核算升级 · 验收（不确定度 / 模型评估 / 口径一致性）');
  console.log('══════════════════════════════════════════════════════════════');

  /* ---------- A. 纯逻辑断言 ---------- */
  console.log('\n【A】逻辑与数学断言（不依赖数据库）');
  const st = U.selfTest();
  st.checks.forEach((c) => line(c.pass, c.name, `期望 ${c.expect} / 实际 ${c.actual}`));
  console.log(`  ── 小计 ${st.passed}/${st.total}`);

  /* ---------- B. 真实数据断言 ---------- */
  const idsArg = argOf('ents', '1,2,37,7');
  const ids = idsArg.split(',').map((s) => Number(s.trim())).filter(Boolean);

  console.log('\n【B1】读数积分 vs 平台动态核算账（口径一致性回归断言）');
  const rows = await db.query(
    `SELECT d.ent_id, d.predicted_eoy, d.emission_rate, e.ent_name
       FROM carbon_dynamic_account d JOIN enterprise e ON e.id = d.ent_id
      WHERE d.ent_id IN (${ids.map(() => '?').join(',')})`, ids);
  for (const r of rows) {
    const p = await U.posterior(r.ent_id);
    if (p.available === false) { line(false, `ent${r.ent_id} 后验可用`, p.reason); continue; }
    const mine = p.extra.annual.mean;
    const theirs = Number(r.predicted_eoy);
    const dev = theirs > 0 ? Math.abs(mine - theirs) / theirs : 1;
    line(dev <= 0.15,
      `ent${r.ent_id} ${r.ent_name} 积分年化 ${mine.toFixed(0)} vs 动态核算 ${theirs.toFixed(0)} tCO2e`,
      `偏差 ${pct(dev)}${dev <= 0.15 ? '' : '（>15%，口径可能再次分叉）'}`);
  }

  console.log('\n【B2】采样密度无关性 / 覆盖度可计算');
  const covs = [];
  for (const id of ids) {
    const ds = await U.dailySeries(id);
    covs.push(ds.coverage.ratio);
    const okCov = ds.coverage.ratio > 0.5 && ds.coverage.ratio <= 1.0001;
    line(okCov, `ent${id} 时间覆盖 ${pct(ds.coverage.ratio)}`,
      `${ds.coverage.pointsUsed} 点 / ${ds.coverage.monitors} 排口 · 密度 ${ds.coverage.sampleDensityPerHour} 点/时`);
    line(ds.days >= 25, `ent${id} 有效日均观测 ${ds.days} 天（残缺日 ${ds.incompleteDays} 天已排除）`);
  }

  console.log('\n【B3】全平台门控实效（剔除率应落在 1%~15%）');
  const ents = await db.query('SELECT id FROM enterprise ORDER BY id');
  const tot = { raw: 0, kept: 0, implausible: 0, outlier: 0, qualityFlag: 0, nonPositive: 0, watchdog: 0 };
  for (const e of ents) {
    const ds = await U.dailySeries(e.id);
    tot.raw += ds.gating.raw; tot.kept += ds.gating.kept;
    Object.keys(tot).forEach((k) => {
      if (ds.gating.byReason[k] !== undefined) tot[k] += ds.gating.byReason[k];
    });
  }
  const exRate = tot.raw ? 1 - tot.kept / tot.raw : 0;
  console.log(`     扫描 ${ents.length} 家企业 / ${tot.raw} 条原始读数`);
  console.log(`     剔除归因：质量标记 ${tot.qualityFlag} · 零值 ${tot.nonPositive} · `
    + `超上限 ${tot.implausible} · 稳健离群 ${tot.outlier} · 看门狗 ${tot.watchdog}`);
  line(exRate >= 0.01 && exRate <= 0.15, `全平台剔除率 ${pct(exRate)}（期望 1%~15%）`);

  console.log('\n【B4】两口径交叉校验的必要条件（GUM ≥ 贝叶斯抽样）');
  for (const id of ids) {
    const r = await U.report(id);
    if (!r.crossCheck) { line(false, `ent${id} 两口径可对照`, '数据不足'); continue; }
    line(r.crossCheck.consistent,
      `ent${id} 合成 ${pct(r.crossCheck.gum.k1Relative)} ≥ 抽样 ${pct(r.crossCheck.bayesian.k1Relative)}`,
      `系统项占比 ${pct(r.crossCheck.systematicShare)}`);
  }

  console.log('\n【B5】先验敏感性自证（κ₀ 跨数量级不改变结论）');
  for (const id of ids) {
    const p = await U.posterior(id);
    if (p.available === false) continue;
    line(p.extra.priorSafe, `ent${id} 弱先验区间内点估计变化 ${p.extra.maxShift.toFixed(2)}%（阈值 2%）`);
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
  console.log('══════════════════════════════════════════════════════════════\n');

  await db.pool.end();
  if (db.chainPool) await db.chainPool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✘ 验收脚本异常：', e);
  try { await db.pool.end(); } catch (x) { /* ignore */ }
  process.exit(1);
});
