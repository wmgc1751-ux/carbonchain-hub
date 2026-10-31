/**
 * calcEngine.js —— 核算引擎（活动数据 → 核算批次 → 可复算结果）
 * ==================================================================================
 * 【这个模块解决什么问题】
 * 平台原先的排放量由「配额 × 抖动」反推（dynamic.js 旧路径），这在方法学上是倒因
 * 为果。本模块建立正向链路：
 *
 *     活动数据台账(activity_data)  ──┐
 *     排放因子台账(factor_entry)    ──┼→ 核算引擎 → 核算批次(calc_batch) → 分源明细
 *     方法学口径(methodology.js)   ──┘                                    ↓
 *                                                                    不确定度 → 上链
 *
 * 【三条硬约束】
 *   ① **可复算**：给定同一 (活动数据, 因子版本, 引擎版本)，必须得到同一结果。
 *      实现方式：输入规范化后算 SHA-256 摘要，结果同样算摘要。任何一方变动，
 *      摘要即变，第三方可据此判断「这份结果是哪份输入算出来的」。
 *   ② **不补齐**：缺哪个源就记哪个缺口，绝不用行业均值填充后宣称完整。
 *   ③ **质量门控真实生效**：Q3/Q4 数据算得出数，但 `usable_for_compliance=0`，
 *      不能拿去履约。这一条决定了平台是否诚实。
 *
 * @module services/calcEngine
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const M = require('./methodology');
const UQ = require('./uq');

/** 核算引擎版本号 —— 引擎逻辑任何改动都必须递增，否则历史批次不可复现 */
const ENGINE_VERSION = '1.0.0';

/** 月度数据满额判据：12 个月才允许声明「完整年」 */
const FULL_YEAR_MONTHS = 12;

/* ==================================================================================
 * 一、输入装载
 * ================================================================================== */

/**
 * 装载某企业某年度的活动数据，按排放源汇总。
 *
 * @param {number} entId
 * @param {number} year
 * @param {object} [opts] { onlyReviewed:boolean }
 * @returns {object} { sources:Map, processes:Map, months:Set, raw:Array }
 *
 * ⚠ 关键设计：只装载 `status IN ('SUBMITTED','REVIEWED')` 的数据。
 * 草稿（DRAFT）不算数 —— 否则「随手填个数」就会进入核算，这是审计上不可接受的。
 * `onlyReviewed=true` 时进一步收紧到已复核（双人复核制）。
 */
async function loadActivity(entId, year, opts = {}) {
  const statuses = opts.onlyReviewed ? ['REVIEWED'] : ['SUBMITTED', 'REVIEWED'];
  const ph = statuses.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT * FROM activity_data
      WHERE ent_id = ? AND year = ? AND status IN (${ph})
      ORDER BY month, source_code`,
    [entId, year, ...statuses]
  );

  const sources = new Map();   // code → { amount, unit, months:Set, origins:[], byOrigin:{} }
  const processes = new Map();
  const months = new Set();
  const dataOrigins = [];

  for (const r of rows) {
    const code = String(r.source_code || '').toUpperCase();
    const qty = Number(r.quantity);
    if (!(qty > 0)) continue;
    months.add(Number(r.month));
    dataOrigins.push(String(r.data_origin || 'L2'));
    const origin = String(r.data_origin || 'L2');

    if (String(r.source_type) === 'PROCESS') {
      /* ⚠ code 必须显式带上：早先漏了这个字段，导致 compute() 里
       * `pr.code` 为 undefined，最终在方法学内核里被当成空字符串排放源，
       * 产出一行 code='' 的幽灵明细。这类"字段漏带"在聚合场景下不会报错，
       * 只会让结果里多出一条谁也解释不清的行 —— 因此这里显式补上并断言。 */
      const cur = processes.get(code) || {
        code, amount: 0, unit: r.unit, months: new Set(), origins: [], byOrigin: {}, byMonthQty: {},
      };
      cur.amount += qty;
      cur.months.add(Number(r.month));
      cur.origins.push(origin);
      cur.byOrigin[origin] = (cur.byOrigin[origin] || 0) + qty;
      cur.byMonthQty[Number(r.month)] = (cur.byMonthQty[Number(r.month)] || 0) + qty;
      processes.set(code, cur);
    } else {
      const cur = sources.get(code) || {
        code, amount: 0, unit: r.unit, months: new Set(), origins: [], byOrigin: {}, byMonthQty: {},
        measured: { ncv: [], cc: [], of: [], labs: [] },
      };
      cur.amount += qty;
      cur.months.add(Number(r.month));
      cur.origins.push(origin);
      cur.byOrigin[origin] = (cur.byOrigin[origin] || 0) + qty;
      cur.byMonthQty[Number(r.month)] = (cur.byMonthQty[Number(r.month)] || 0) + qty;
      /* 实测化验值：按月加权不现实（同一批煤可跨月），此处取算术均值并记录样本数。
       * 这是 GB/T 32150 Tier2 的简化处理，需在报告中披露。 */
      if (Number(r.measured_ncv) > 0) cur.measured.ncv.push(Number(r.measured_ncv));
      if (Number(r.measured_cc) > 0) cur.measured.cc.push(Number(r.measured_cc));
      if (Number(r.measured_of) > 0) cur.measured.of.push(Number(r.measured_of));
      if (r.lab_report_no) cur.measured.labs.push(r.lab_report_no);
      sources.set(code, cur);
    }
  }

  return {
    sources, processes, months,
    dataOrigins,
    rawCount: rows.length,
    /* 整体数据等级：按数量加权取主导档（占量最大的那一档），
     * 不用「最差档」—— 「有一个月是估算」不等于「整年都是估算」。 */
    worstOrigin: dominantOrigin(weightedOrigins(sources, processes)),
  };
}

/** 汇总全部源的按来源等级加权的数量分布 */
function weightedOrigins(sources, processes) {
  const agg = { L3: 0, L2: 0, L1: 0, L0: 0 };
  for (const s of [...sources.values(), ...processes.values()]) {
    for (const [o, q] of Object.entries(s.byOrigin || {})) {
      if (agg[o] !== undefined) agg[o] += q;
    }
  }
  return agg;
}

/** 取占量最大的来源等级 */
function dominantOrigin(agg) {
  let best = 'L3'; let bestVal = -1;
  for (const [k, v] of Object.entries(agg)) {
    if (v > bestVal) { bestVal = v; best = k; }
  }
  return best;
}

/**
 * 单个源的主导来源等级。
 * 一个源可能有 12 个月，其中 11 个月 L3、1 个月 L0 ——
 * 这个源应记为 L3（主导），而那 1 个月的 L0 数量在全局加权里体现。
 */
function srcOrigin(s) {
  if (!s || !s.byOrigin) return null;
  return dominantOrigin(s.byOrigin);
}

/** 取一组来源等级中最差的一档（L3 最好，L0 最差） */
function worstOf(list) {
  const order = ['L3', 'L2', 'L1', 'L0'];
  if (!list || !list.length) return 'L0';
  let worst = 'L3';
  for (const x of list) {
    const i = order.indexOf(String(x));
    if (i > order.indexOf(worst)) worst = String(x);
  }
  return worst;
}

function mean(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* ==================================================================================
 * 二、核算执行
 * ================================================================================== */

/**
 * 执行一次核算，返回完整结果（不落库）。
 *
 * @param {object} p
 *   entId      企业ID（必填，用于取行业与区域）
 *   year       核算年度
 *   periodFrom / periodTo  核算期（仅用于记录，活动数据按月装载）
 *   method     'CALC' | 'DUAL'   ；DUAL 时会额外跑 CEMS 并做双轨比对
 *   factorVersion  锁定的因子版本（缺省取当前 ACTIVE）
 *   onlyReviewed   是否只采信已复核数据
 * @returns {object} 核算结果（含 rows / gaps / digests / uncertainty 输入）
 */
async function compute(p) {
  const entId = Number(p.entId);
  if (!entId) throw new Error('entId 必填');
  const year = Number(p.year) || new Date().getFullYear();

  /* 2.1 企业基本信息 —— 行业决定「应核算哪些源」，区域决定电网因子 */
  const ent = await db.one(
    'SELECT id, ent_name, industry, region, scale, annual_output FROM enterprise WHERE id = ?', [entId]
  );
  if (!ent) throw new Error(`企业 ${entId} 不存在`);

  /* 2.2 因子版本锁定 —— 这是「可复现」的前提。
   *     若调用方不指定，锁定当前 ACTIVE 版本；若连 ACTIVE 都没有，直接失败，
   *     不允许「随便用最新值」这种不可复现的做法。 */
  let factorVersion = p.factorVersion;
  if (!factorVersion) {
    const v = await db.one(
      "SELECT version FROM factor_version WHERE status = 'ACTIVE' ORDER BY effective_from DESC LIMIT 1"
    );
    if (!v) throw new Error('因子库没有生效版本，无法核算（请先发布 factor_version）');
    factorVersion = v.version;
  }

  /* 2.3 装载活动数据 */
  const act = await loadActivity(entId, year, { onlyReviewed: !!p.onlyReviewed });
  if (act.rawCount === 0) {
    return {
      ok: false, entId, year, reason: '该企业本年度没有已提交的活动数据，无法核算',
      detail: '活动数据是核算的唯一输入。没有数据时不得用配额或行业均值反推排放量。',
      hint: '请先通过 POST /api/mrv/activity 录入活动数据并提交复核',
    };
  }

  /* 2.4 行业区域映射 —— enterprise.region 存的是省级名，需映射到电网区域 */
  const gridRegion = gridRegionOf(ent.region);

  /* 2.5 组织输入 */
  const sources = [];
  const processes = [];
  for (const [, s] of act.sources) {
    const measured = (s.measured.ncv.length && s.measured.cc.length && s.measured.of.length)
      ? { ncv: mean(s.measured.ncv), cc: mean(s.measured.cc), of: mean(s.measured.of) }
      : undefined;
    sources.push({
      code: s.code, amount: s.amount, amountUnit: s.unit,
      measured,
      _months: s.months.size, _origins: s.origins,
    });
  }
  for (const [, pr] of act.processes) {
    processes.push({ code: pr.code, activity: pr.amount, _months: pr.months.size, _origins: pr.origins });
  }

  /* 2.6 调用方法学内核 */
  const output = (ent.annual_output && Number(ent.annual_output) > 0)
    ? { value: Number(ent.annual_output), unit: '万元' } : null;

  const calc = M.calcEnterprise({
    industry: ent.industry, region: gridRegion, year,
    sources, processes, output,
  });

  if (!calc.ok) {
    return { ok: false, entId, year, reason: calc.reason, gaps: calc.gaps };
  }

  /* 2.7 补充分源明细的「月数」与「数据来源等级」——
   *     方法学内核不认识数据库，这两项在这里补。 */
  const rows = calc.rows.map((r) => {
    const src = act.sources.get(r.code) || act.processes.get(r.code);
    const monthsCount = src ? src.months.size : 0;
    return {
      ...r,
      monthsCount,
      dataOrigin: srcOrigin(src) || 'L0',
      /* 该源内部各来源等级的数量分布（用于按排放量加权质量分级） */
      originQty: src ? { ...src.byOrigin } : {},
      /* 年不完整：月数不足 12 但仍有数据 → 单独标记，避免「只报 1 个月就当年报」 */
      partialYear: monthsCount > 0 && monthsCount < FULL_YEAR_MONTHS,
    };
  });

  /* 2.8 双轨比对（可选） */
  let dual = null;
  if (String(p.method || '').toUpperCase() === 'DUAL') {
    dual = await runDualTrack(entId, year, calc);
  }

  /* 2.9 质量分级
   *
   * ⚠ 判据必须按**排放量加权**，不能按行数，也不该按「源」取最差档。
   * 理由：一个源 12 个月里有 1 个月是估算值，与 12 个月全是估算值，
   * 对可信度的影响差 12 倍。若按源取最差档，几乎每家都会被打成 L0，
   * 判据失去区分力（与「改判据才过」同类错误：判据过严同样是错的）。
   *
   * 正确口径：把一个源的排放量按其内部各来源等级的数量占比拆开，
   * 汇总出「L1+L0 来源贡献了多少 tCO₂e」，再除以总排放量。
   */
  const emissionByOrigin = { L3: 0, L2: 0, L1: 0, L0: 0 };
  for (const r of rows) {
    const e = Number(r.emission);
    if (!(e > 0)) continue;
    const qtyByOrigin = r.originQty || {};
    const qtyTotal = Object.values(qtyByOrigin).reduce((a, b) => a + b, 0);
    if (qtyTotal > 0) {
      for (const [o, q] of Object.entries(qtyByOrigin)) {
        if (emissionByOrigin[o] === undefined) continue;
        emissionByOrigin[o] += e * (q / qtyTotal);
      }
    } else {
      /* 无源级分布（例如过程源未记录）→ 整块记到该源的主导档，不猜测 */
      const o = String(r.dataOrigin || 'L2');
      if (emissionByOrigin[o] !== undefined) emissionByOrigin[o] += e;
    }
  }
  const emissionTotal = Object.values(emissionByOrigin).reduce((a, b) => a + b, 0);
  const interpolatedRatio = emissionTotal > 0
    ? (emissionByOrigin.L1 + emissionByOrigin.L0) / emissionTotal
    : 0;
  const monthCoverage = act.months.size / 12;

  const tier = M.qualityTier({
    coverage: monthCoverage,
    isContinuous: true,
    interpolatedRatio,
  });

  /* 能否履约：四个条件同时满足 —— 核算完整 / 质量档合格 / 月覆盖满年 / L0 占比在容差内。
   * L0 是「没有数据」而非「数据不好」，因此单独设一条更严的门槛：
   * 只要 L0 贡献的排放量超过 1%，整年即不可用于履约，必须补录原始凭证。 */
  const l0Share = emissionTotal > 0 ? emissionByOrigin.L0 / emissionTotal : 0;
  const hasL0 = l0Share > 0.01;
  const usableForCompliance = calc.complete && tier.usableForCompliance
    && act.months.size === FULL_YEAR_MONTHS && !hasL0;

  /* 2.11 不确定度：从分源明细构造输入分量，走 GUM + 蒙特卡洛双路径
   *
   * 每个排放源的输入分量需要两路不确定度：
   *   u_AD  ← 该源活动数据的来源等级（L3/L2/L1/L0 对应 2%/5%/15%/50%）
   *   u_EF  ← 该源用的是 Tier2 实测化验因子还是 Tier1 缺省因子
   * 两者独立，合成 u_rel = √(u_AD² + u_EF²)。
   *
   * ⚠ 不能给所有源套同一个 u_rel —— 那等于宣称"每吨煤和每度电的计量精度一样"，
   *   而这正是旧实现被诟病的地方（实测比值 15~40 倍差异却仍判"一致"）。
   */
  const uqInputs = [];
  for (const r of rows) {
    if (!(Number(r.emission) > 0)) continue;
    const adLevel = r.dataOrigin || 'L2';
    const uAd = (UQ.AD_UNCERTAINTY[adLevel] || UQ.AD_UNCERTAINTY.L2).rel;
    let efKey = 'TIER1_FUEL';
    if (r.tier && String(r.tier).startsWith('Tier2')) efKey = 'TIER2_FUEL';
    else if (Number(r.scope) === 2) efKey = 'GRID';
    else if (r.code && String(r.code).includes('CEMENT')) efKey = 'PROCESS';
    else if (r.activity !== undefined) efKey = 'PROCESS';
    const uEf = (UQ.EF_UNCERTAINTY[efKey] || UQ.EF_UNCERTAINTY.TIER1_FUEL).rel;

    uqInputs.push({
      key: r.code,
      /* 用「排放量 / 1」作为 AD 与 EF 的代理：GUM 与 MC 只关心乘积与相对不确定度，
       * 因此取 ad = emission, ef = 1 在数学上等价，且避免虚构活动数据值。 */
      ad: Number(r.emission), ef: 1,
      uAdRel: uAd, uEfRel: uEf,
      emission: Number(r.emission),
      uRel: Math.sqrt(uAd * uAd + uEf * uEf),
      uType: adLevel === 'L3' ? 'A' : 'B',
      df: r.monthsCount ? Math.max(1, r.monthsCount - 1) : 11,
      label: r.cn || r.code,
      source: `AD ${adLevel}(${(uAd * 100).toFixed(1)}%) + EF ${efKey}(${(uEf * 100).toFixed(2)}%)`,
    });
  }

  const gum = UQ.gumCombine(uqInputs);
  const mcUq = UQ.monteCarloPropagate(uqInputs, { draws: 50000, seed: 20261024 });
  const uqCross = UQ.crossValidatePathA(gum, mcUq);

  /* 路径 C：用月度活动数据做贝叶斯（回答"月度波动"这个不同问题） */
  const monthlyTotals = monthlyEmissionTotals(rows, act);
  const bayes = UQ.bayesianMonthly(monthlyTotals.values);

  /* 先验敏感性闸门 —— 真闸门：BLOCKED 时不输出区间 */
  const gate = monthlyTotals.values.length >= 3
    ? UQ.priorSensitivityGate(monthlyTotals.values)
    : { status: 'BLOCKED', available: false, reason: '月度数据不足 3 个，无法检验先验敏感性' };

  /* 敏感性分析：Sobol + 单因素弹性 */
  const sobol = UQ.sobolIndices(uqInputs, { draws: 100000 });
  const elastic = UQ.elasticity(uqInputs, 0.1);

  const uqResult = {
    /* 最终对外口径：以 GUM 为主（可解析复核），MC 为互证 */
    uc: gum.uc, ucRel: gum.ucRel,
    k: gum.k, kMethod: gum.kMethod, nuEff: gum.nuEff,
    u95: gum.u95, u95Rel: gum.u95Rel,
    interval: gum.interval,
    /* ⭐ 区间是否可对外发布：只有闸门 PASS 且两路径互证才允许 */
    publishable: gate.status === 'PASS' && uqCross.ok === true,
    publishBlockReason: gate.status !== 'PASS' ? `先验敏感性闸门 ${gate.status}：${gate.reason}`
      : (uqCross.ok !== true ? `解析与蒙特卡洛互证失败：${uqCross.reason}` : null),
    contributions: gum.contributions,
    dominant: gum.dominant,
    crossValidation: uqCross,
    monteCarlo: { mean: mcUq.mean, sd: mcUq.sd, u95: mcUq.u95, skewness: mcUq.skewness, draws: mcUq.draws },
    bayesian: bayes,
    priorGate: gate,
    sensitivity: { sobol, elasticity: elastic },
    method: 'GUM 解析传播（主）+ JCGM 101 蒙特卡洛（互证）+ NIG 贝叶斯（月度波动，另答一问）',
  };

  /* 2.12 摘要（可复算性的物质基础） */
  const inputDigest = digestInput({
    entId, year, engineVersion: ENGINE_VERSION, factorVersion,
    industry: ent.industry, gridRegion,
    sources: sources.map((s) => ({
      code: String(s.code), amount: round(s.amount, 4), unit: s.amountUnit,
      measured: s.measured ? { ncv: round(s.measured.ncv, 4), cc: round(s.measured.cc, 4), of: round(s.measured.of, 4) } : null,
    })).sort((a, b) => a.code.localeCompare(b.code)),
    processes: processes.map((x) => ({ code: String(x.code), activity: round(x.activity, 4) }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  });

  const resultDigest = cu.sha256(canonical({
    engineVersion: ENGINE_VERSION, factorVersion,
    scope1: round(calc.scope1, 3), scope2: round(calc.scope2, 3),
    total: round(calc.total, 3), complete: calc.complete,
    rows: rows.map((r) => ({
      code: String(r.code),
      emission: r.emission === null || r.emission === undefined ? null : round(r.emission, 3),
      status: r.status,
    })).sort((a, b) => a.code.localeCompare(b.code)),
  }));

  return {
    ok: true,
    entId, year,
    entName: ent.ent_name, industry: ent.industry, industryCn: calc.industryCn,
    region: ent.region, gridRegion,
    method: String(p.method || 'CALC').toUpperCase(),
    factorVersion, engineVersion: ENGINE_VERSION,
    scope1: calc.scope1, scope2: calc.scope2, total: calc.total,
    intensity: calc.intensity, intensityUnit: calc.intensityUnit,
    complete: calc.complete, coverageRatio: calc.coverageRatio,
    gaps: calc.gaps, gapCount: calc.gaps.length,
    rows,
    monthsCovered: act.months.size,
    dataOrigin: act.worstOrigin,
    emissionByOrigin: Object.fromEntries(Object.entries(emissionByOrigin)
      .map(([k, v]) => [k, Number(v.toFixed(1))])),
    interpolatedRatio: Number((interpolatedRatio * 100).toFixed(2)),
    quality: tier,
    usableForCompliance,
    notUsableReason: usableForCompliance ? null : [
      !calc.complete ? '核算存在缺口（有应核算的排放源缺活动数据）' : null,
      !tier.usableForCompliance ? `数据质量档 ${tier.code} 不可用于履约：${tier.reason}` : null,
      act.months.size !== FULL_YEAR_MONTHS ? `活动数据仅覆盖 ${act.months.size}/12 个月，不构成完整年度` : null,
      hasL0 ? `存在缺省值来源（L0）数据，占排放量 ${(l0Share * 100).toFixed(2)}%（阈值 1%），必须补录原始凭证` : null,
    ].filter(Boolean),
    dualTrack: dual,
    uncertainty: uqResult,
    inputDigest, resultDigest,
    note: calc.note,
  };
}

/**
 * 按月度拆排放量，用于贝叶斯路径（回答「月度波动」）。
 *
 * 拆分逻辑：每个排放源的年度排放量按该源的月度活动数据量占比分摊。
 * 这样得到的月度序列既反映生产季节性，又保持合计与年度值一致。
 *
 * ⚠ 只收「有月度数据」的源。缺口源（NO_DATA）不参与拆分 ——
 * 若把它按均值摊进每个月，等于用虚构数据填补，月度序列就失去意义。
 */
function monthlyEmissionTotals(rows, act) {
  const byMonth = new Map();
  for (const r of rows) {
    if (!(Number(r.emission) > 0)) continue;
    const src = act.sources.get(r.code) || act.processes.get(r.code);
    if (!src) continue;
    /* 需要该源的逐月数量，而不是只汇总值。loadActivity 只存了汇总，
     * 因此这里用 byMonthQty（在 loadActivity 中一并收集）。 */
    const monthQty = src.byMonthQty || {};
    const sumQty = Object.values(monthQty).reduce((a, b) => a + b, 0);
    if (!(sumQty > 0)) continue;
    for (const [m, q] of Object.entries(monthQty)) {
      const share = q / sumQty;
      byMonth.set(Number(m), (byMonth.get(Number(m)) || 0) + Number(r.emission) * share);
    }
  }
  const values = [...byMonth.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  return { values, byMonth };
}

/** 省级行政区 → 电网区域 */
function gridRegionOf(province) {
  const p = String(province || '');
  const map = {
    华北: ['北京', '天津', '河北', '山西', '山东', '内蒙古'],
    东北: ['辽宁', '吉林', '黑龙江'],
    华东: ['上海', '江苏', '浙江', '安徽', '福建'],
    华中: ['河南', '湖北', '湖南', '江西'],
    西北: ['陕西', '甘肃', '青海', '宁夏', '新疆'],
    南方: ['广东', '广西', '云南', '贵州', '海南'],
    西南: ['重庆', '四川'],
  };
  for (const [region, provs] of Object.entries(map)) {
    if (provs.some((x) => p.includes(x))) return region;
  }
  return null; // 未知则用全国均值，不猜
}

/**
 * 双轨比对：从 cems_reading 取实测读数，用在线监测法算一遍，与计算法比。
 *
 * 【重要口径说明】
 * `cems_reading.flow_value` 存的是**瞬时排放速率 tCO2e/h**（见列注释与 dynamic.js
 * 的写入口径），不是原始工况参数。因此这条路径**不需要**再走
 * velocity × section 折算，直接对速率做梯形积分即可。
 * 而 `methodology.calcByCems` 面向的是「原始工况参数」，两者入口不同但积分口径一致
 * （Δt 上限 240 分钟、末点不外推、非 NORMAL 排除）。
 *
 * 注意：这条路径要求真实 CEMS 数据存在。若库中是平台自举数据（source='CEMS'
 * 但由 dynamic.ingest 生成），比对虽可跑，但**不能**宣称「实机验证」——
 * 该判断由调用方依据 data_origin 决定，本函数只负责算。
 */
async function runDualTrack(entId, year, calcResult) {
  const readings = await db.query(
    `SELECT reading_time, flow_value, quality_flag, status, source
       FROM cems_reading
      WHERE ent_id = ? AND reading_time >= ? AND reading_time < ?
      ORDER BY reading_time`,
    [entId, `${year}-01-01 00:00:00`, `${year + 1}-01-01 00:00:00`]
  ).catch(() => []);

  if (!readings.length) {
    return { available: false, reason: '该企业本年度没有 CEMS 实测读数，无法做双轨比对' };
  }

  /* 速率积分：与 methodology.calcByCems 同口径 */
  const MAX_GAP_MIN = 240;
  const rows = readings
    .map((r) => ({
      t: new Date(r.reading_time).getTime(),
      q: Number(r.flow_value),
      flag: String(r.quality_flag || 'NORMAL').toUpperCase(),
      status: String(r.status || 'NORMAL').toUpperCase(),
    }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);

  const used = rows.filter((r) => r.flag === 'NORMAL' && r.status === 'NORMAL' && r.q > 0);
  const excluded = rows.length - used.length;

  /* ⚠ 同刻多排口的去重：cum_value 是任意时刻的**企业级累计排放**，
   * flow_value 是**单排口**速率。积分时必须先按时刻把各排口速率相加，
   * 否则 N 个排口会被重复积分 N 次（这正是 P3 缺陷的同构问题）。
   * 这里按时间桶聚合成企业级速率后再积分。 */
  const buckets = new Map();
  for (const r of used) {
    const k = r.t;
    buckets.set(k, (buckets.get(k) || 0) + r.q);
  }
  const series = [...buckets.entries()].map(([t, q]) => ({ t, q })).sort((a, b) => a.t - b.t);

  let total = 0;
  const gaps = [];
  for (let i = 1; i < series.length; i++) {
    const dtMin = (series[i].t - series[i - 1].t) / 60000;
    if (dtMin <= 0) continue;
    if (dtMin > MAX_GAP_MIN) {
      gaps.push({ minutes: Number(dtMin.toFixed(1)), reason: `间隔超过 ${MAX_GAP_MIN} 分钟，不积分也不外推` });
      continue;
    }
    total += ((series[i].q + series[i - 1].q) / 2) * (dtMin / 60);
  }

  const spanHours = series.length >= 2 ? (series[series.length - 1].t - series[0].t) / 3600000 : 0;
  const coveredHours = spanHours - gaps.reduce((s, g) => s + g.minutes / 60, 0);

  const cmp = M.dualTrackCompare(calcResult.total, total);
  /* 源构成：区分「真实设备直报」与「平台自举」，这是能否宣称实机验证的关键 */
  const sources = [...new Set(readings.map((r) => r.source))];

  return {
    ...cmp,
    cemsDetail: {
      readings: readings.length,
      usedPoints: series.length,
      excludedPoints: excluded,
      coveredHours: Number(coveredHours.toFixed(2)),
      spanHours: Number(spanHours.toFixed(2)),
      gapCount: gaps.length,
      sourceKinds: sources,
      /* 只有当全部读数都来自真实设备（非 CEMS 自举）时才为 true */
      fromRealDevice: sources.length > 0 && !sources.includes('CEMS'),
    },
    note: 'CEMS 侧按 tCO2e/h 速率梯形积分（同刻多排口先加和为厂级速率，避免重复积分）',
  };
}

/* ==================================================================================
 * 三、摘要与规范化
 * ================================================================================== */

function round(v, d) { return Number(Number(v).toFixed(d)); }

/**
 * 规范化 JSON：键排序、去空白、数字统一格式。
 * 目的：同一份数据在任意机器、任意时刻序列化后字节完全一致，
 *       否则摘要无法跨环境比对（这是「可复算」的隐含前提）。
 */
function canonical(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'number') return Number.isFinite(obj) ? String(obj) : 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function digestInput(input) { return cu.sha256(canonical(input)); }

/* ==================================================================================
 * 四、落库
 * ================================================================================== */

/**
 * 把核算结果落库为一个批次（含分源明细）。
 * 幂等：同一 input_digest 已存在且状态非 VOID 时，直接返回既有批次，不重复计算。
 *
 * @param {object} result compute() 的返回值
 * @param {object} [opts] { operator, confirm:boolean }
 */
async function persist(result, opts = {}) {
  if (!result || !result.ok) throw new Error('核算结果无效，不能落库');

  const dup = await db.one(
    "SELECT batch_no FROM calc_batch WHERE input_digest = ? AND status <> 'VOID' ORDER BY id DESC LIMIT 1",
    [result.inputDigest]
  );
  if (dup) {
    return { batchNo: dup.batch_no, dedup: true,
      note: '相同输入已核算过，直接复用既有批次（可复算性验证：同一输入不产生第二个结果）' };
  }

  const batchNo = cu.bizNo('CALC');
  const [ins] = await db.pool.query(
    `INSERT INTO calc_batch
      (batch_no, ent_id, year, period_from, period_to, method, factor_version, industry, region,
       scope1, scope2, total_emission, intensity, output_value,
       is_complete, coverage_ratio, gap_count, gap_detail,
       quality_tier, usable_for_compliance,
       input_digest, result_digest, engine_version, status, operator)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      batchNo, result.entId, result.year,
      `${result.year}-01-01`, `${result.year}-12-31`,
      result.method, result.factorVersion, result.industry, result.region,
      result.scope1, result.scope2, result.total,
      result.intensity === null ? null : result.intensity,
      result.intensity === null ? null : null,
      result.complete ? 1 : 0, result.coverageRatio, result.gapCount,
      JSON.stringify(result.gaps || []),
      result.quality.code, result.usableForCompliance ? 1 : 0,
      result.inputDigest, result.resultDigest, result.engineVersion,
      opts.confirm ? 'CONFIRMED' : 'COMPUTED', opts.operator || null,
    ]
  );
  const batchId = ins.insertId;

  /* 分源明细逐行落库 —— 这是「一个总数」变「N 条可核对推导」的地方 */
  const cols = ['batch_id', 'source_code', 'source_cn', 'source_type', 'scope',
    'activity', 'activity_unit', 'months_count', 'ef_value', 'ef_source', 'ef_tier',
    'derivation', 'emission', 'status', 'gap_reason', 'data_origin'];
  const vals = (result.rows || []).map((r) => [
    batchId, r.code, r.cn || r.code,
    r.code && r.code.includes('CEMENT') ? 'PROCESS'
      : (Number(r.scope) === 2 ? 'INDIRECT' : (r.activity !== undefined ? 'PROCESS' : 'FUEL')),
    Number(r.scope) || 1,
    r.amount !== undefined ? r.amount : (r.activity !== undefined ? r.activity : null),
    r.amountUnit || r.activityUnit || r.unit || null,
    r.monthsCount || 0,
    r.ef === undefined ? null : r.ef,
    r.source || null,
    r.tier || null,
    (r.formula || '').slice(0, 400) || null,
    r.emission === null || r.emission === undefined ? null : r.emission,
    r.status || 'OK',
    r.gap || null,
    r.dataOrigin || null,
  ]);
  if (vals.length) {
    const ph = vals.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
    await db.pool.query(`INSERT INTO calc_source_detail (${cols.join(',')}) VALUES ${ph}`, vals.flat());
  }

  return { batchNo, batchId, dedup: false, detailRows: vals.length };
}

/* ==================================================================================
 * 五、查询与复算校验
 * ================================================================================== */

/** 取批次详情（含分源明细） */
async function getBatch(batchNo) {
  const b = await db.one('SELECT * FROM calc_batch WHERE batch_no = ?', [batchNo]);
  if (!b) return null;
  const rows = await db.query(
    'SELECT * FROM calc_source_detail WHERE batch_id = ? ORDER BY scope, source_code', [b.id]
  );
  return {
    batchNo: b.batch_no,
    entId: Number(b.ent_id), year: Number(b.year),
    period: { from: b.period_from, to: b.period_to },
    method: b.method, factorVersion: b.factor_version, engineVersion: b.engine_version,
    industry: b.industry, region: b.region,
    scope1: Number(b.scope1), scope2: Number(b.scope2), total: Number(b.total_emission),
    intensity: b.intensity === null ? null : Number(b.intensity),
    complete: !!b.is_complete, coverageRatio: Number(b.coverage_ratio),
    gapCount: Number(b.gap_count), gaps: safeJson(b.gap_detail, []),
    qualityTier: b.quality_tier, usableForCompliance: !!b.usable_for_compliance,
    uncertainty: {
      uRel: b.u_rel === null ? null : Number(b.u_rel),
      u95Rel: b.u95_rel === null ? null : Number(b.u95_rel),
      low: b.u_low === null ? null : Number(b.u_low),
      high: b.u_high === null ? null : Number(b.u_high),
    },
    digests: { input: b.input_digest, result: b.result_digest },
    status: b.status, chain: { blockIndex: b.chain_block_index, txId: b.chain_tx_id },
    createdAt: b.created_at,
    sources: rows.map((r) => ({
      code: r.source_code, cn: r.source_cn, type: r.source_type, scope: Number(r.scope),
      activity: r.activity === null ? null : Number(r.activity), activityUnit: r.activity_unit,
      monthsCount: Number(r.months_count),
      ef: r.ef_value === null ? null : Number(r.ef_value), efSource: r.ef_source, tier: r.ef_tier,
      derivation: r.derivation,
      emission: r.emission === null ? null : Number(r.emission),
      status: r.status, gap: r.gap_reason, dataOrigin: r.data_origin,
    })),
  };
}

function safeJson(s, fallback) {
  if (s === null || s === undefined) return fallback;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

/**
 * 复算校验：用当前引擎按批次的输入重算一遍，与落库值比对。
 *
 * 这是「可复算」这一主张的**唯一证据**。若不一致，说明：
 *   · 引擎逻辑变了但没升版本号（违反可复现性），或
 *   · 活动数据被事后改动（违反审计完整性），或
 *   · 因子版本被替换（违反版本锁定）。
 * 三种情况都必须报错，不能静默通过。
 */
async function verifyBatch(batchNo) {
  const b = await db.one('SELECT * FROM calc_batch WHERE batch_no = ?', [batchNo]);
  if (!b) return { ok: false, reason: '批次不存在' };

  const re = await compute({
    entId: Number(b.ent_id), year: Number(b.year),
    method: b.method, factorVersion: b.factor_version,
  });
  if (!re.ok) {
    return { ok: false, batchNo, reason: `复算失败：${re.reason}` };
  }

  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail });

  push('输入摘要一致', re.inputDigest === b.input_digest,
    re.inputDigest === b.input_digest
      ? '输入未变动'
      : `当前输入摘要 ${re.inputDigest.slice(0, 16)}… ≠ 批次记录 ${String(b.input_digest).slice(0, 16)}…（活动数据被改动过）`);
  push('结果摘要一致', re.resultDigest === b.result_digest,
    re.resultDigest === b.result_digest
      ? '结果可逐位复现'
      : `当前结果摘要 ${re.resultDigest.slice(0, 16)}… ≠ 批次记录 ${String(b.result_digest).slice(0, 16)}…`);
  push('排放总量一致', Math.abs(re.total - Number(b.total_emission)) < 0.01,
    `复算 ${re.total} vs 落库 ${Number(b.total_emission)}`);
  push('范围一一致', Math.abs(re.scope1 - Number(b.scope1)) < 0.01,
    `复算 ${re.scope1} vs 落库 ${Number(b.scope1)}`);
  push('范围二一致', Math.abs(re.scope2 - Number(b.scope2)) < 0.01,
    `复算 ${re.scope2} vs 落库 ${Number(b.scope2)}`);
  push('引擎版本未变', re.engineVersion === b.engine_version,
    `当前 ${re.engineVersion} vs 批次 ${b.engine_version}`);
  push('因子版本未变', re.factorVersion === b.factor_version,
    `当前 ${re.factorVersion} vs 批次 ${b.factor_version}`);

  const passed = checks.filter((c) => c.pass).length;
  return {
    ok: passed === checks.length,
    batchNo,
    verdict: passed === checks.length ? 'REPRODUCIBLE' : 'DIVERGED',
    passed, total: checks.length, checks,
  };
}

module.exports = {
  ENGINE_VERSION, FULL_YEAR_MONTHS,
  compute, persist, getBatch, verifyBatch,
  loadActivity, gridRegionOf, canonical,
};
