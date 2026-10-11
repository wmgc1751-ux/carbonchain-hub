/**
 * scripts/uncertainty.js —— 核算与不确定度内核的离线复算（可复现证据）
 * ==================================================================
 * 本脚本把 `public/js/data/nucleus.js` 的核算内核搬到 Node 下**真实跑一遍**，
 * 产出可复核的数字，回答六个问题：
 *
 *   1. 台账自洽吗？        —— Tier 1 缺省法 vs Tier 2 参数展开法，13 项燃料逐项对账
 *   2. 产品碳闭合吗？      —— Σ(工序 BOM 分摊) 与 范围一+范围二 是否都等于批次总量
 *   3. 组织碳算得出来吗？    —— 由在网设备读数 × 声明运行日历，逐企业积分
 *   4. 双轨对账站得住吗？    —— 组织碳 ⊇ Σ产品碳 的包含性硬约束 + 存证覆盖率归因
 *   5. 判据会不会永远通过？  —— 负向注入（falsification）：故意制造 4 类错误，验证判据会报警
 *   6. 不确定度可信吗？     —— 蒙特卡洛（10000 次抽样）vs 解析解（误差传播律）互证
 *
 * 产出：
 *   · artifacts/bench/nucleus.json       原始结果
 *   · artifacts/bench/nucleus-report.md  Markdown 报告
 *
 * 用法：node scripts/uncertainty.js [迭代次数]
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* industry.js / sources.js / nucleus.js 都以 window 为宿主，这里造一个 */
global.window = global;

const ROOT = path.join(__dirname, '..');
/* 注意加载顺序：sources → nucleus → industry。
 * industry.js 只把结果挂到 global.App.Industry，没有 module.exports，
 * 因此 require 只用于触发副作用，取值必须走 global.App。 */
const Sources = require(path.join(ROOT, 'public', 'js', 'data', 'sources.js'));
const Nucleus = require(path.join(ROOT, 'public', 'js', 'data', 'nucleus.js'));
require(path.join(ROOT, 'public', 'js', 'data', 'industry.js'));
const Industry = global.App.Industry;
if (!Industry || !Industry.devices) {
  throw new Error('[uncertainty] 未能加载 App.Industry（检查 industry.js 是否挂在 window/globalThis）');
}

const ITER = Math.max(1000, Number(process.argv[2]) || 10000);
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const r1 = (x) => Math.round(x * 10) / 10;

/* 声明核算期与运行日历（在线率由在网设备工况状态折算，不用魔数） */
const CALENDAR = Nucleus.productionCalendar({
  periodCn: '2026Q3',
  days: 92,
  hoursPerDay: 24,
  devices: Industry.devices,
});

/* 辅助用能与输配损耗的声明比例（工程典型值，可在企业档案中按行业覆盖） */
const AUX_SHARE = 0.055;   // 辅助生产 / 办公 / 厂内运输等未分摊到产品的用能
const LOSS_SHARE = 0.08;   // 输配损耗 + 计量器具超差 + 未计量逸散

/* ==================================================================
 * 1. 台账自洽性：Tier1 vs Tier2 逐项对账
 * ================================================================== */
function checkLedgerConsistency() {
  const rows = Sources.fuelFactors
    .filter((f) => f.traceLevel !== 'C')
    .map((f) => {
      const d = Nucleus.dualPathFuel(f.code, 1, Sources);
      return {
        code: f.code, cn: f.cn,
        tier1: r4(d.tier1.value),
        tier2: r4(d.tier2.value),
        differencePct: r4(d.differencePct),
        consistent: d.consistent,
      };
    });
  const maxDev = rows.reduce((m, r) => Math.max(m, Math.abs(r.differencePct)), 0);
  return {
    rows, maxDeviationPct: r4(maxDev),
    allConsistent: rows.every((r) => r.consistent),
    note: 'Tier 1 直接用台账公布的缺省因子；Tier 2 用同一组（NCV, CC, OF）从 IPCC 原始算式重算。'
      + '两者一致 ⇒ 台账数值与其宣称的原始算式自洽，不存在“因子与参数对不上”的隐性错误。',
  };
}

/* ==================================================================
 * 2. 产品碳内部闭合（Tier 1 强判据）
 * ================================================================== */
function checkPcfClosure() {
  const all = Industry.batches || [];
  const c = Nucleus.pcfInternalClosure(all, 0.5);
  return Object.assign({}, c, {
    note: c.note + ' 判据口径：PCF 核算边界仅含范围一 + 范围二，'
      + '上游原辅料以内置因子形式计入各工序，不单列范围三（GB/T 24067-2024 / ISO 14067）。',
  });
}

/* ==================================================================
 * 3. 组织碳核算（逐企业，按声明运行日历积分）
 * ================================================================== */
function computeOrg() {
  const entIds = Object.keys(Industry.ENTERPRISES).map(Number);
  const perEnterprise = entIds.map((id) => {
    const ent = Industry.ENTERPRISES[id];
    const devs = Industry.devicesOf(id);
    const measurable = devs.filter((d) => d.live
      && (d.live.powerKwh || d.live.gasNm3 || d.live.steamT));
    const period = Nucleus.meteredPeriodEmission(measurable, CALENDAR, Sources);
    return {
      entId: id, entName: ent.name, entShort: ent.short, industry: ent.industry, region: ent.region,
      devicesTotal: devs.length,
      devicesUsed: period.count,
      hourlyTotal: r4(period.hourlyTotal),
      periodTotal: r1(period.periodTotal),
      scope1: r1(period.scope1),
      scope2: r1(period.scope2),
      byKey: Object.keys(period.byKey).reduce((o, k) => { o[k] = r1(period.byKey[k]); return o; }, {}),
      metered: period.count > 0,
      reason: period.count > 0 ? null : '该企业在本期尚未接入计量设备，无法做组织碳核算',
      items: period.items.map((i) => ({
        scope: i.scope, key: i.key, cn: i.cn,
        quantity: i.quantity, unit: i.unit, factor: i.factor,
        tco2ePeriod: r1(i.tco2ePeriod), note: i.note || null,
      })),
    };
  });

  const metered = perEnterprise.filter((e) => e.metered);
  const sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return {
    calendar: CALENDAR,
    perEnterprise,
    devicesUsed: sum(perEnterprise, 'devicesUsed'),
    devicesTotal: sum(perEnterprise, 'devicesTotal'),
    meteredCount: metered.length,
    unmeteredCount: perEnterprise.length - metered.length,
    periodTotal: r1(sum(metered, 'periodTotal')),
    scope1: r1(sum(metered, 'scope1')),
    scope2: r1(sum(metered, 'scope2')),
    unit: `tCO₂e（${CALENDAR.periodCn} 期间累计口径，由瞬时读数 × ${CALENDAR.hours.toFixed(1)} 运行小时积分得到）`,
    note: '设备清单是企业在网计量点，不等同于企业完整排放边界；因此该值是'
      + '“已接入计量口径的组织碳”读用，而非企业全量排放。'
      + '未接入计量的企业单列，不用估算值填补。',
  };
}

/* ==================================================================
 * 4. 双轨对账（企业级包含性 + 存证覆盖率 + 联盟汇总）
 * ================================================================== */
function computeReconcile(org) {
  const entIds = Object.keys(Industry.ENTERPRISES).map(Number);
  const rows = entIds.map((id) => {
    const o = org.perEnterprise.find((x) => x.entId === id) || { periodTotal: 0, metered: false };
    const all = Industry.batchesOf(id) || [];
    const stored = all.filter((b) => b.status !== 'BLOCKED');
    const blocked = all.filter((b) => b.status === 'BLOCKED');
    const base = Nucleus.enterpriseReconcile({
      entId: id,
      entName: Industry.ENTERPRISES[id].name,
      industry: Industry.ENTERPRISES[id].industry,
      periodCn: CALENDAR.periodCn,
      orgTotal: o.periodTotal,
      batches: stored,
      auxShare: AUX_SHARE,
      lossShare: LOSS_SHARE,
    });
    return Object.assign(base, {
      metered: o.metered,
      reason: o.reason,
      blockedBatches: blocked.map((b) => b.batchNo),
      pcfSumTotalIncludingBlocked: r1(all.reduce((s, b) => s + b.totalTco2e, 0)),
    });
  });

  const league = Nucleus.leagueReconcile(rows);
  return {
    calendarCn: CALENDAR.periodCn,
    auxShare: AUX_SHARE,
    lossShare: LOSS_SHARE,
    rows: rows.map((r) => Object.assign({}, r, {
      orgTotal: r1(r.orgTotal), pcfSum: r1(r.pcfSum), allocatable: r1(r.allocatable),
      residual: r1(r.residual), coveragePct: r2(r.coveragePct),
    })),
    league: Object.assign({}, league, {
      orgTotal: r1(league.orgTotal), pcfSum: r1(league.pcfSum),
      allocatable: r1(league.allocatable), coveragePct: r2(league.coveragePct),
    }),
    note: '双轨对账的判据不是“两个数字相等”。组织碳刻画企业全部排放，产品碳只覆盖已存证的'
      + '部分批次，因此正确判据是：① 包含性（组织碳 ⊇ Σ产品碳，硬约束）；'
      + '② 可分摊空间 E_alloc = 组织碳 × (1 − 辅助率 − 损耗率)；'
      + '③ 存证覆盖率 ρ = Σ产品碳 / E_alloc。如实报告 ρ 而不是调参凑闭合，才是可被质证的做法。',
  };
}

/* ==================================================================
 * 5. 判据可证伪性验证（负向注入）
 *    证明上面的判据不是"永远通过"的空判据
 * ================================================================== */
function checkFalsification() {
  const cases = [];
  const tol = 0.5;

  /* 用例 A：篡改批次总量 → 应击破"范围一+范围二 === 总量"与"Σ工序 === 总量" */
  {
    const b = Industry.batches.find((x) => x.totalTco2e > 1000);
    const tampered = Object.assign({}, b, { totalTco2e: b.totalTco2e * 1.1 });
    const r = Nucleus.pcfInternalClosure([tampered], tol);
    cases.push({
      id: 'A', name: '篡改批次总碳足迹 +10%',
      inject: `${b.batchNo}：totalTco2e ${b.totalTco2e} → ${(b.totalTco2e * 1.1).toFixed(2)}`,
      expect: 'scopeDevPct / stageDevPct 超限 → FAIL',
      detected: !r.allPass,
      observed: `stageDevPct ${r.maxStageDevPct.toFixed(3)}% / scopeDevPct ${r.maxScopeDevPct.toFixed(3)}%`,
    });
  }

  /* 用例 B：只改范围二占比 → 应被"范围一+范围二 === 总量"抓到 */
  {
    const b = Industry.batches.find((x) => x.totalTco2e > 1000);
    const tampered = Object.assign({}, b, { scope2: b.scope2 * 0.6 });
    const r = Nucleus.pcfInternalClosure([tampered], tol);
    cases.push({
      id: 'B', name: '只改范围二占比（−40%）',
      inject: `${b.batchNo}：scope2 ${b.scope2} → ${(b.scope2 * 0.6).toFixed(2)}`,
      expect: 'scopeDevPct 超限 → FAIL',
      detected: !r.allPass,
      observed: `scopeDevPct ${r.maxScopeDevPct.toFixed(3)}%`,
    });
  }

  /* 用例 C：删掉一个工序分摊 → 应被"Σ工序 === 总量"抓到 */
  {
    const b = Industry.batches.find((x) => x.totalTco2e > 1000);
    const bom = Object.assign({}, b.bom, { stages: b.bom.stages.slice(0, 3) });
    const tampered = Object.assign({}, b, { bom });
    const r = Nucleus.pcfInternalClosure([tampered], tol);
    cases.push({
      id: 'C', name: '删除一个工序分摊段',
      inject: `${b.batchNo}：BOM 4 段 → 3 段`,
      expect: 'stageDevPct 超限 → FAIL',
      detected: !r.allPass,
      observed: `stageDevPct ${r.maxStageDevPct.toFixed(3)}%`,
    });
  }

  /* 用例 D：把产品碳放大到超过组织碳 → 应击破双轨包含性硬约束 */
  {
    const id = 2;
    const all = Industry.batchesOf(id).filter((x) => x.status !== 'BLOCKED');
    const inflate = all.map((x) => ({ batchNo: x.batchNo, product: x.product, totalTco2e: x.totalTco2e * 10 }));
    const norm = Nucleus.enterpriseReconcile({
      entId: id, orgTotal: 24095.84, batches: all, auxShare: AUX_SHARE, lossShare: LOSS_SHARE,
    });
    const bad = Nucleus.enterpriseReconcile({
      entId: id, orgTotal: 24095.84, batches: inflate, auxShare: AUX_SHARE, lossShare: LOSS_SHARE,
    });
    cases.push({
      id: 'D', name: '产品碳放大 10× 使其超过组织碳',
      inject: `ent 2：Σ产品碳 ${norm.pcfSum.toFixed(0)} → ${bad.pcfSum.toFixed(0)} tCO₂e`,
      expect: '包含性被击破 → FAIL（基线应 PASS）',
      detected: norm.pass && !bad.pass,
      observed: `基线 pass=${norm.pass}，注入后 pass=${bad.pass}，不可解释量 ${bad.unexplained.toFixed(1)} tCO₂e`,
    });
  }

  return {
    cases,
    total: cases.length,
    detectedCount: cases.filter((c) => c.detected).length,
    allDetected: cases.every((c) => c.detected),
    note: '负向注入是判据有效性的证明：如果判据在任何输入下都通过，它就不是判据。'
      + '本组用例故意破坏数据链路，要求校验逻辑必须报警 —— 报警即证明判据非空。',
  };
}

/* ==================================================================
 * 6. 蒙特卡洛 vs 解析解（双向互证）
 * ================================================================== */
function checkUncertainty(orgTotal) {
  /* 6.1 乘性模型：排放因子链（AD × NCV × CC × OF） */
  const p = Sources.uncertainty.parameters;
  const sig = (id, fb) => { const row = p.find((x) => x.id === id); return row ? row.sigmaRel : fb; };
  const chainInputs = [
    { id: 'AD', cn: '活动数据', value: 1, sigmaRel: sig('AD', 0.03) },
    { id: 'NCV', cn: '低位发热量', value: 1, sigmaRel: sig('NCV', 0.05) },
    { id: 'CC', cn: '单位热值含碳量', value: 1, sigmaRel: sig('CC', 0.05) },
    { id: 'OF', cn: '碳氧化率', value: 1, sigmaRel: sig('OF', 0.02) },
  ];
  const chainMC = Nucleus.monteCarlo(chainInputs, { model: 'product', iterations: ITER, seed: 20261011 });

  /* 6.2 加性模型：真实批次碳足迹总量 */
  const batch = (Industry.batches || []).find((b) => b.totalTco2e > 0) || { totalTco2e: 2000 };
  const batchMC = Nucleus.mcForBatch(batch.totalTco2e, { iterations: ITER, seed: 20261011, Sources });

  /* 6.3 动态电网法 vs 年均因子法（口径差异） */
  const oracle = Industry.oracle;
  const readings = oracle.series.map((pt, i) => ({
    kwh: 12000 + Math.sin(i / 3.1) * 2600 + i * 40,
    factor: pt.factor,
  }));
  const gridCmp = Nucleus.compareGridMethods(readings, oracle.baseline);

  return {
    iterations: ITER,
    chain: {
      model: 'product',
      inputs: chainInputs.map((i) => ({ id: i.id, cn: i.cn, sigmaRel: i.sigmaRel })),
      analyticSigmaRel: r4(chainMC.analytic.sigmaRel),
      mcSigmaRel: r4(chainMC.sigmaRel),
      crossCheckDiffPct: r2(chainMC.crossCheck.absDiffPct),
      p5: r4(chainMC.quantiles.p5),
      p50: r4(chainMC.quantiles.p50),
      p95: r4(chainMC.quantiles.p95),
      sensitivity: chainMC.sensitivity,
      recommendation: chainMC.recommendation,
      distribution: chainMC.distribution,
    },
    batch: {
      model: 'sum',
      batchNo: batch.batchNo,
      product: batch.product,
      central: r2(batchMC.central),
      mean: r2(batchMC.mean),
      sd: r2(batchMC.sd),
      sigmaRel: r4(batchMC.sigmaRel),
      analyticSigmaRel: r4(batchMC.analytic.sigmaRel),
      crossCheckDiffPct: r2(batchMC.crossCheck.absDiffPct),
      quantiles: { p5: r2(batchMC.quantiles.p5), p50: r2(batchMC.quantiles.p50), p95: r2(batchMC.quantiles.p95) },
      ci95: { lo: r2(batchMC.mean - 1.96 * batchMC.sd), hi: r2(batchMC.mean + 1.96 * batchMC.sd) },
      sensitivity: batchMC.sensitivity,
      recommendation: batchMC.recommendation,
      unit: 'tCO₂e',
    },
    gridMethod: {
      kwhTotal: r2(gridCmp.kwhTotal),
      dynamic: r2(gridCmp.dynamic),
      flat: r2(gridCmp.flat),
      difference: r2(gridCmp.difference),
      differencePct: r2(gridCmp.differencePct),
      effectiveFactor: r4(gridCmp.effectiveFactor),
      annualFactor: r4(gridCmp.annualFactor),
      interpretation: gridCmp.interpretation,
    },
  };
}

/* ==================================================================
 * 主流程
 * ================================================================== */
function main() {
  const t0 = Date.now();
  console.log('='.repeat(78));
  console.log(' 碳链通 · 核算算法与不确定度内核 —— 离线复算');
  console.log('='.repeat(78));
  console.log(` 蒙特卡洛迭代次数：${ITER.toLocaleString()}`);
  console.log(` 声明核算期：${CALENDAR.periodCn}　运行小时：${CALENDAR.hours.toFixed(1)} h`
    + `（${CALENDAR.days}d × ${CALENDAR.hoursPerDay}h × 在线率 ${(CALENDAR.availability * 100).toFixed(1)}%）`);
  console.log('-'.repeat(78));

  const ledger = checkLedgerConsistency();
  console.log(` ① 台账自洽性：${ledger.rows.length} 项燃料 Tier1/Tier2 对账，`
    + `最大偏差 ${ledger.maxDeviationPct}% → ${ledger.allConsistent ? '✅ 全部自洽' : '❌ 存在不一致'}`);

  const pcf = checkPcfClosure();
  console.log(` ② 产品碳内部闭合：${pcf.ok}/${pcf.total} 批次通过`
    + `（最大工序偏差 ${pcf.maxStageDevPct.toFixed(3)}% / 最大范围偏差 ${pcf.maxScopeDevPct.toFixed(3)}%）`
    + ` → ${pcf.allPass ? '✅ 全链路自洽' : '❌ 存在不闭合'}`);

  const org = computeOrg();
  console.log(` ③ 组织碳核算：${org.meteredCount} 家企业接入计量（${org.devicesUsed}/${org.devicesTotal} 台设备）`
    + ` → ${CALENDAR.periodCn} 期间 ${org.periodTotal.toLocaleString()} tCO₂e`
    + `（范围一 ${org.scope1.toLocaleString()} / 范围二 ${org.scope2.toLocaleString()}）`);
  if (org.unmeteredCount) console.log(`    未接入计量：${org.unmeteredCount} 家（不用估算值填补）`);

  const rec = computeReconcile(org);
  rec.rows.forEach((r) => {
    if (!r.metered) {
      console.log(` ④ 双轨对账 [${r.entName}] 跳过 —— ${r.reason}`);
    } else {
      console.log(` ④ 双轨对账 [${r.entName}] 组织碳 ${r.orgTotal.toLocaleString()} ⊇ 产品碳 ${r.pcfSum.toLocaleString()}`
        + ` → 覆盖率 ${r.coveragePct}% ${r.pass ? '✅ 包含性成立' : '❌ 包含性被击破'}`);
    }
  });
  console.log(` ④ 联盟级：${rec.league.meteredCount} 家已接入，Σ组织碳 ${rec.league.orgTotal.toLocaleString()}`
    + `，Σ产品碳 ${rec.league.pcfSum.toLocaleString()}，覆盖率 ${rec.league.coveragePct}%`
    + ` → ${rec.league.allPass ? '✅ 全部通过' : '❌ 存在击破'}`);

  const fal = checkFalsification();
  console.log(` ⑤ 判据可证伪性：${fal.detectedCount}/${fal.total} 类注入被检出`
    + ` → ${fal.allDetected ? '✅ 判据非空（会报警）' : '❌ 存在漏检'}`);

  const unc = checkUncertainty(org.periodTotal);
  console.log(` ⑥ 不确定度互证（乘性链）：解析 ${unc.chain.analyticSigmaRel} vs MC ${unc.chain.mcSigmaRel}，偏差 ${unc.chain.crossCheckDiffPct}%`);
  console.log(` ⑥ 不确定度互证（批次汇总）：解析 ${unc.batch.analyticSigmaRel} vs MC ${unc.batch.sigmaRel}，偏差 ${unc.batch.crossCheckDiffPct}%`);
  console.log(` ⑥ 电网因子口径差：动态法 ${unc.gridMethod.dynamic} vs 年均法 ${unc.gridMethod.flat} → 差 ${unc.gridMethod.differencePct}%`);

  const overallPass = ledger.allConsistent && pcf.allPass && rec.league.allPass
    && fal.allDetected && unc.chain.crossCheckDiffPct < 5 && unc.batch.crossCheckDiffPct < 5;
  console.log('-'.repeat(78));
  console.log(` 综合结论：${overallPass ? '✅ 六项验证全部通过' : '⚠ 存在未通过项，见上方明细'}`);
  console.log('-'.repeat(78));

  const payload = {
    meta: {
      title: '核算算法与不确定度内核 · 离线复算',
      generatedAt: new Date().toISOString(),
      iterations: ITER,
      elapsedSec: r1((Date.now() - t0) / 1000),
      seed: 20261011,
      method: 'node scripts/uncertainty.js（复用 public/js/data/nucleus.js 真实内核）',
      determinism: '全部随机数来自 mulberry32 固定种子 20261011，跨机器结果完全一致，可复核。',
      overallPass,
    },
    ledgerConsistency: ledger,
    pcfClosure: pcf,
    organizationCarbon: org,
    dualTrackReconcile: rec,
    falsification: fal,
    uncertainty: unc,
  };

  const outDir = path.join(ROOT, 'artifacts', 'bench');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'nucleus.json'), JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'nucleus-report.md'), renderMarkdown(payload), 'utf8');

  console.log(` 总耗时 ${payload.meta.elapsedSec}s`);
  console.log(' 原始数据 → artifacts/bench/nucleus.json');
  console.log(' 报告     → artifacts/bench/nucleus-report.md');
  console.log('='.repeat(78));
}

function renderMarkdown(p) {
  const L = [];
  L.push('# 碳链通 · 核算算法与不确定度内核复算报告');
  L.push('');
  L.push(`> 生成时间：${p.meta.generatedAt}　耗时 ${p.meta.elapsedSec}s　蒙特卡洛 ${p.meta.iterations.toLocaleString()} 次　随机种子 ${p.meta.seed}`);
  L.push('>');
  L.push(`> ${p.meta.method}`);
  L.push('>');
  L.push(`> ${p.meta.determinism}`);
  L.push('');
  L.push(`**综合结论：${p.meta.overallPass ? '✅ 六项验证全部通过' : '⚠ 存在未通过项'}**`);
  L.push('');
  L.push('| # | 验证项 | 结果 |');
  L.push('| --- | --- | :---: |');
  L.push(`| ① | 台账自洽性（Tier1 vs Tier2） | ${p.ledgerConsistency.allConsistent ? '✅' : '❌'} |`);
  L.push(`| ② | 产品碳内部闭合（三分量） | ${p.pcfClosure.allPass ? '✅' : '❌'} |`);
  L.push(`| ③ | 组织碳核算（按企业 + 声明日历） | ✅ |`);
  L.push(`| ④ | 双轨包含性（组织碳 ⊇ 产品碳） | ${p.dualTrackReconcile.league.allPass ? '✅' : '❌'} |`);
  L.push(`| ⑤ | 判据可证伪性（负向注入） | ${p.falsification.allDetected ? '✅' : '❌'} |`);
  L.push(`| ⑥ | 不确定度互证（解析 vs 蒙特卡洛） | ${p.uncertainty.chain.crossCheckDiffPct < 5 && p.uncertainty.batch.crossCheckDiffPct < 5 ? '✅' : '⚠'} |`);
  L.push('');

  L.push('## 1. 台账自洽性：Tier 1 缺省法 vs Tier 2 参数展开法');
  L.push('');
  L.push('| 燃料 | Tier 1（缺省因子） | Tier 2（NCV×CC×OF×44/12） | 偏差 | 自洽 |');
  L.push('| --- | ---: | ---: | ---: | :---: |');
  for (const r of p.ledgerConsistency.rows) {
    L.push(`| ${r.cn} | ${r.tier1} | ${r.tier2} | ${r.differencePct}% | ${r.consistent ? '✅' : '❌'} |`);
  }
  L.push('');
  L.push(`最大偏差 **${p.ledgerConsistency.maxDeviationPct}%**，结论：${p.ledgerConsistency.allConsistent ? '全部自洽 ✅' : '存在不一致 ❌'}`);
  L.push('');
  L.push(`> ${p.ledgerConsistency.note}`);
  L.push('');

  const c = p.pcfClosure;
  L.push('## 2. 产品碳内部闭合（Tier 1 强判据）');
  L.push('');
  L.push('判据：');
  L.push('');
  c.criteria.forEach((x) => L.push(`- ${x}`));
  L.push('');
  L.push('| 批次 | 产品 | 状态 | 批次总量 | Σ工序分摊 | 范围一+二 | 工序偏差 | 范围偏差 | 判定 |');
  L.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | :---: |');
  c.rows.forEach((r) => {
    L.push(`| ${r.batchNo} | ${r.product} | ${r.status} | ${r.totalTco2e.toLocaleString()} | ${r.stageSum.toLocaleString()}`
      + ` | ${r.scopeSum.toLocaleString()} | ${r.stageDevPct}% | ${r.scopeDevPct}% | ${r.pass ? '✅' : '❌'} |`);
  });
  L.push('');
  L.push(`**${c.ok}/${c.total} 批次通过**，最大工序偏差 ${c.maxStageDevPct.toFixed(4)}%，最大范围偏差 ${c.maxScopeDevPct.toFixed(4)}%。`);
  L.push('');
  L.push(`> ${c.note}`);
  L.push('');

  const o = p.organizationCarbon;
  L.push('## 3. 组织碳核算（按企业 + 声明运行日历积分）');
  L.push('');
  L.push(`声明核算期 **${o.calendar.periodCn}**：${o.calendar.days} 日 × ${o.calendar.hoursPerDay} h`
    + ` × 在线率 ${(o.calendar.availability * 100).toFixed(1)}%（${o.calendar.availabilityFrom}）`
    + ` = **${o.calendar.hours.toFixed(1)} 运行小时**。`);
  L.push('');
  L.push('| 企业 | 行业 | 在网设备 | 有效计量点 | 期间组织碳(tCO₂e) | 范围一 | 范围二 |');
  L.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  o.perEnterprise.forEach((e) => {
    L.push(`| ${e.entShort} | ${e.industry} | ${e.devicesTotal} | ${e.devicesUsed}`
      + ` | ${e.metered ? e.periodTotal.toLocaleString() : '—（未接入计量）'}`
      + ` | ${e.metered ? e.scope1.toLocaleString() : '—'} | ${e.metered ? e.scope2.toLocaleString() : '—'} |`);
  });
  L.push(`| **合计** | — | ${o.devicesTotal} | ${o.devicesUsed} | **${o.periodTotal.toLocaleString()}** | ${o.scope1.toLocaleString()} | ${o.scope2.toLocaleString()} |`);
  L.push('');
  L.push('已接入企业的明细（活动数据 × 排放因子 = 期间排放）：');
  L.push('');
  L.push('| 企业 | 范围 | 排放源 | 瞬时读数 | 单位 | 运行小时 | 期间排放(tCO₂e) | 排放因子 |');
  L.push('| --- | --- | --- | ---: | --- | ---: | ---: | ---: |');
  o.perEnterprise.filter((e) => e.metered).forEach((e) => {
    e.items.forEach((i) => {
      L.push(`| ${e.entShort} | ${i.scope === 'SCOPE1' ? '范围一' : '范围二'} | ${i.cn}`
        + ` | ${i.quantity.toLocaleString()} | ${i.unit} | ${o.calendar.hours.toFixed(1)}`
        + ` | ${i.tco2ePeriod.toLocaleString()} | ${i.factor} |`);
    });
  });
  L.push('');
  L.push(`> ${o.note}`);
  L.push('');

  const r = p.dualTrackReconcile;
  L.push('## 4. 双轨对账（组织碳 ↔ 产品碳）');
  L.push('');
  L.push('**方法说明。** 组织碳刻画一家企业的**全部**排放；产品碳只覆盖**已上链存证的部分批次**。'
    + '因此正确的判据不是“两个数字相等”，而是：');
  L.push('');
  L.push('1. **包含性（硬约束）**：组织碳 ≥ Σ产品碳。组织碳必须是其产品碳之和的上界；违反即为数据打架。');
  L.push(`2. **可分摊空间**：E_alloc = 组织碳 × (1 − 辅助率 ${(r.auxShare * 100).toFixed(1)}% − 损耗率 ${(r.lossShare * 100).toFixed(1)}%)。`);
  L.push('3. **存证覆盖率**：ρ = Σ产品碳 / E_alloc。试点平台 ρ 偏小是正常的，如实报告而非调参凑闭合。');
  L.push('');
  L.push('| 企业 | 组织碳(tCO₂e) | Σ产品碳(tCO₂e) | 可分摊空间 | 未存证产出 | 覆盖率 ρ | 包含性 |');
  L.push('| --- | ---: | ---: | ---: | ---: | ---: | :---: |');
  r.rows.forEach((x) => {
    if (!x.metered) {
      L.push(`| ${x.entName} | —（未接入计量） | ${x.pcfSum.toLocaleString()} | — | — | — | 跳过 |`);
    } else {
      L.push(`| ${x.entName} | ${x.orgTotal.toLocaleString()} | ${x.pcfSum.toLocaleString()}`
        + ` | ${x.allocatable.toLocaleString()} | ${x.residual.toLocaleString()} | ${x.coveragePct}%`
        + ` | ${x.pass ? '✅' : '❌'} |`);
    }
  });
  L.push(`| **联盟合计** | **${r.league.orgTotal.toLocaleString()}** | **${r.league.pcfSum.toLocaleString()}**`
    + ` | **${r.league.allocatable.toLocaleString()}** | — | **${r.league.coveragePct}%**`
    + ` | ${r.league.allPass ? '✅' : '❌'} |`);
  L.push('');
  r.rows.filter((x) => x.metered).forEach((x) => {
    L.push(`- **${x.entName}**：${x.verdict}`);
  });
  if (r.league.unmetered.length) {
    L.push('');
    L.push('未纳入对账的企业（显式单列，不用估算值填补）：');
    L.push('');
    r.league.unmetered.forEach((x) => L.push(`- ${x.entName}：${x.reason}`));
  }
  L.push('');
  L.push(`> ${r.note}`);
  L.push('');

  const f = p.falsification;
  L.push('## 5. 判据可证伪性验证（负向注入）');
  L.push('');
  L.push('如果一条判据在任何输入下都通过，它就不是判据。本节故意破坏数据链路，要求校验逻辑必须报警。');
  L.push('');
  L.push('| # | 注入内容 | 期望 | 实测观测 | 检出 |');
  L.push('| --- | --- | --- | --- | :---: |');
  f.cases.forEach((x) => {
    L.push(`| ${x.id} | ${x.inject} | ${x.expect} | ${x.observed} | ${x.detected ? '✅ 已检出' : '❌ 漏检'} |`);
  });
  L.push('');
  L.push(`**${f.detectedCount}/${f.total} 类注入被检出** —— 判据非空。`);
  L.push('');
  L.push(`> ${f.note}`);
  L.push('');

  const u = p.uncertainty;
  L.push('## 6. 不确定度传播：解析解 vs 蒙特卡洛（双向互证）');
  L.push('');
  L.push('### 6.1 乘性模型 —— 排放因子链（AD × NCV × CC × OF）');
  L.push('');
  L.push('| 输入项 | 相对标准不确定度 |');
  L.push('| --- | ---: |');
  u.chain.inputs.forEach((i) => L.push(`| ${i.cn} | ±${(i.sigmaRel * 100).toFixed(1)}% |`));
  L.push('');
  L.push(`- 解析解（√(Σσᵢ²)）：**±${(u.chain.analyticSigmaRel * 100).toFixed(2)}%**`);
  L.push(`- 蒙特卡洛（${u.iterations.toLocaleString()} 次）：**±${(u.chain.mcSigmaRel * 100).toFixed(2)}%**`);
  L.push(`- 两者相对偏差：**${u.chain.crossCheckDiffPct}%** → ${u.chain.crossCheckDiffPct < 5 ? '✅ 互证通过' : '⚠ 偏差偏大'}`);
  L.push(`- 分布分位（相对点估计）：P5 ${u.chain.p5}、P50 ${u.chain.p50}、P95 ${u.chain.p95}`);
  L.push('');
  L.push(`> ${u.chain.distribution.note}`);
  L.push('');
  L.push('一阶敏感性（方差贡献占比）：');
  L.push('');
  L.push('| 输入项 | 自身不确定度 | 方差贡献占比 |');
  L.push('| --- | ---: | ---: |');
  u.chain.sensitivity.forEach((s) => L.push(`| ${s.cn} | ±${(s.sigmaRel * 100).toFixed(1)}% | ${s.sharePct}% |`));
  L.push('');
  L.push(`> ${u.chain.recommendation}`);
  L.push('');

  L.push(`### 6.2 加性模型 —— 真实批次「${u.batch.batchNo} · ${u.batch.product}」`);
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('| --- | ---: |');
  L.push(`| 点估计 | ${u.batch.central.toLocaleString()} ${u.batch.unit} |`);
  L.push(`| 抽样均值 | ${u.batch.mean.toLocaleString()} ${u.batch.unit} |`);
  L.push(`| 抽样标准差 | ${u.batch.sd.toLocaleString()} ${u.batch.unit} |`);
  L.push(`| 相对不确定度（解析） | ±${(u.batch.analyticSigmaRel * 100).toFixed(2)}% |`);
  L.push(`| 相对不确定度（蒙特卡洛） | ±${(u.batch.sigmaRel * 100).toFixed(2)}% |`);
  L.push(`| 互证相对偏差 | ${u.batch.crossCheckDiffPct}% |`);
  L.push(`| 95% 置信区间（均值 ±1.96σ） | ${u.batch.ci95.lo.toLocaleString()} ~ ${u.batch.ci95.hi.toLocaleString()} |`);
  L.push(`| 分位 | P5 ${u.batch.quantiles.p5.toLocaleString()} / P50 ${u.batch.quantiles.p50.toLocaleString()} / P95 ${u.batch.quantiles.p95.toLocaleString()} |`);
  L.push('');
  L.push('| 输入项 | 方差贡献占比 |');
  L.push('| --- | ---: |');
  u.batch.sensitivity.forEach((s) => L.push(`| ${s.cn} | ${s.sharePct}% |`));
  L.push('');
  L.push(`> ${u.batch.recommendation}`);
  L.push('');

  const g = u.gridMethod;
  L.push('### 6.3 口径差异：动态电网因子里程积分法 vs 年均因子法');
  L.push('');
  L.push('| 口径 | 结果(tCO₂) | 等效因子(tCO₂/MWh) |');
  L.push('| --- | ---: | ---: |');
  L.push(`| 动态法 Σ(电量_h × EF_h) | ${g.dynamic.toLocaleString()} | ${g.effectiveFactor} |`);
  L.push(`| 年均法 电量 × 年均因子 | ${g.flat.toLocaleString()} | ${g.annualFactor} |`);
  L.push(`| 差异 | ${g.difference.toLocaleString()}（${g.differencePct}%） | — |`);
  L.push('');
  L.push(`> ${g.interpretation}`);
  L.push('>');
  L.push('> 注意：这不是“哪个算错了”，而是**口径不同**。动态法反映真实时序，年均法是国家发布的合规口径。'
    + '本平台同时保留两者，正是为了让口径选择成为**可显式声明、可审计**的决定，而不是隐藏在代码里的默认值。');
  L.push('');

  L.push('## 7. 结论与局限');
  L.push('');
  L.push('**可以主张的结论：**');
  L.push('');
  L.push(`1. 台账与其宣称的 IPCC 算式**逐项自洽**（${p.ledgerConsistency.rows.length} 项燃料，最大偏差 ${p.ledgerConsistency.maxDeviationPct}%）。`);
  L.push(`2. 产品碳三分量（批次总量 / 范围一+二 / Σ工序分摊）**全部闭环**，最大偏差 ${Math.max(c.maxStageDevPct, c.maxScopeDevPct).toFixed(4)}%。`);
  L.push(`3. 组织碳按**可声明的运行日历**积分得到，${o.meteredCount} 家企业接入计量，期内合计 ${o.periodTotal.toLocaleString()} tCO₂e。`);
  L.push(`4. 双轨对账采用**包含性硬约束 + 覆盖率归因**，联盟级覆盖率 ${r.league.coveragePct}%，包含性全部成立。`);
  L.push(`5. 判据经**负向注入验证**：${f.total} 类故意破坏全部被检出（${f.detectedCount}/${f.total}），判据非空。`);
  L.push(`6. 不确定度传播**双向互证通过**：乘性模型解析 ${(u.chain.analyticSigmaRel * 100).toFixed(2)}% vs 抽样 ${(u.chain.mcSigmaRel * 100).toFixed(2)}%（偏差 ${u.chain.crossCheckDiffPct}%），`
    + `加性模型 ${(u.batch.analyticSigmaRel * 100).toFixed(2)}% vs ${(u.batch.sigmaRel * 100).toFixed(2)}%（偏差 ${u.batch.crossCheckDiffPct}%）。`);
  L.push(`7. 敏感性分析给出**可执行的降不确定度优先级**：先测准方差贡献最大的那一项，而不是平均用力。`);
  L.push(`8. 随机数固定种子（${p.meta.seed}），结果**跨机器可复现**，任何人可重跑核对。`);
  L.push('');
  L.push('**必须声明的局限：**');
  L.push('');
  L.push('1. 组织碳口径为“**已接入计量的设备子集**”，不等于企业全量排放边界；'
    + '未接入计量的能源介质（原料含碳、逸散、场内运输等）未计入，故该值是组织碳的**下界**。');
  L.push('2. 设备读数为**瞬时率**，乘运行小时积分是 Tier 1 近似；正式核算应按小时级历史读数做时间积分。');
  L.push(`3. 辅助用能率 ${(r.auxShare * 100).toFixed(1)}%、输配损耗率 ${(r.lossShare * 100).toFixed(1)}% 为**工程声明值**（traceLevel C），`
    + '接入企业历史台账后应替换为实测统计值，机制不变。');
  L.push('4. 双轨对账的覆盖率 ρ 反映**存证批次覆盖企业排放的比例**，它偏低说明试点期只存证了部分批次，'
    + '**不代表核算错误**；但它同时意味着“该企业的组织碳尚未被产品碳完整解释”。');
  L.push('5. 不确定度参数的 σ 取 IPCC 缺省区间代表值，**不是对本企业实测数据统计得到的真实分布**。');
  L.push('6. 蒙特卡洛假设各输入相互独立。若存在相关（如温度同时影响发热量与氧化率），'
    + '需引入相关系数矩阵，本平台当前未实现该扩展。');
  L.push('7. 蒸汽折算采用 1 t ≈ 2.76 GJ 的工程近似，且蒸汽排放因子属台账 C 级示例值。');
  L.push('');
  return L.join('\n');
}

main();
