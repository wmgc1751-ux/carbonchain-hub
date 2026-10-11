/**
 * data/nucleus.js —— 核算算法与不确定度传播内核
 * ==================================================================
 * 本模块是"碳链通"的**可计算核心**，与 data/sources.js（因子台账）解耦：
 * 台账管"用哪些因子"，本模块管"怎么算、算得准不准"。
 *
 * 双端可用：浏览器挂到 `App.Nucleus`；Node 下可 `require` 直接跑（CI / 离线复算）。
 *
 * 提供五组能力：
 *
 *  A. 排放量核算（三条路径，可交叉验证）
 *     · Tier 1 缺省法       E = 活动数据 × 缺省排放因子
 *     · Tier 2 参数展开法   E = 活动数据 × NCV × CC × OF × 44/12
 *     · 动态电网法          E = Σ (逐时电量 × 该小时电网因子)　← 与用年均因子算的结果不同
 *
 *  B. 双轨一致性对账（组织碳 ↔ 产品碳）
 *     同一企业在同一期间的【组织碳核算总量】与【各产品碳足迹之和 + 非生产性用能】应闭合。
 *     不闭合的差额本身就是有价值的审计线索（损耗、口径差、漏报）。
 *
 *  C. 蒙特卡洛不确定度传播（**真实抽样计算**）
 *     · 乘性模型（Πxᵢ，如排放因子链）：相对不确定度 = √(Σσᵢ²)
 *     · 加性模型（Σxᵢ，如多源排放汇总）：相对不确定度 = √(Σ(σᵢxᵢ)²) / Σxᵢ
 *     两种模型都同时给出【解析解】与【蒙特卡洛解】，并要求二者相互印证 ——
 *     解析解验证抽样实现的正确性，抽样给出分布形状与置信区间（解析解只能给单值）。
 *
 *  D. 一阶敏感性分析（方差贡献）
 *     用标准化输入与输出的 Pearson 相关系数平方，估计各输入对方差的一阶贡献占比，
 *     回答"要降低不确定度，最该先测准哪个量"。
 *
 *  E. 随机数发生器（可复现）
 *     mulberry32 伪随机 + Box–Muller 正态变换，固定种子 ⇒ 任何机器上结果完全一致。
 *
 * @module data/nucleus
 */
(function (global) {
  'use strict';

  /* ================================================================
   * E. 可复现随机数（固定种子 ⇒ 跨机器同结果）
   * ================================================================ */

  /** mulberry32：32 位状态的快速伪随机数发生器，返回 [0,1) */
  function mulberry32(seed) {
    let a = (Number(seed) || 0) >>> 0;
    return function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 标准正态抽样器（Box–Muller）
   * @param {() => number} rand [0,1) 均匀随机源
   */
  function makeNormal(rand) {
    let spare = null;
    return function normal() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0; let v = 0;
      do { u = rand(); } while (u <= 1e-12);
      v = rand();
      const mag = Math.sqrt(-2 * Math.log(u));
      const z0 = mag * Math.cos(2 * Math.PI * v);
      const z1 = mag * Math.sin(2 * Math.PI * v);
      spare = z1;
      return z0;
    };
  }

  /* ================================================================
   * A. 排放量核算
   * ================================================================ */

  /** 分子量比 CO₂/C */
  const C_TO_CO2 = 44 / 12;

  const METHODS = {
    TIER1: {
      code: 'TIER1',
      cn: 'Tier 1 缺省法',
      formula: 'E = AD × EF',
      inputs: ['AD', 'EF'],
      note: '活动数据 × 缺省排放因子。上手最快，不确定度最大（燃料因子直接用国标缺省值）。',
    },
    TIER2: {
      code: 'TIER2',
      cn: 'Tier 2 参数展开法',
      formula: 'E = AD × NCV × CC × OF × 44/12',
      inputs: ['AD', 'NCV', 'CC', 'OF'],
      note: '把缺省因子拆成"发热量 × 含碳量 × 氧化率"，可使用入厂化验实测值，'
        + '把不确定度从单点 ±5% 降到各分量可控。也是 IPCC 给出缺省因子的原始算式。',
    },
    TIER3: {
      code: 'TIER3',
      cn: 'Tier 3 连续在线监测（CEMS）',
      formula: 'E = Σ (烟气流量 × 浓度 × Δt)',
      inputs: ['FLOW', 'CONC', 'TIME'],
      note: '直接测烟气，绕开"燃料量 × 因子"的间接推导。本平台 CEMS 烟气分析仪已具备该能力，'
        + '可作为"实测增强档"。',
    },
    GRID_DYNAMIC: {
      code: 'GRID_DYNAMIC',
      cn: '动态电网因子里程积分法',
      formula: 'E = Σ (用电量_h × EF_h)',
      inputs: ['AD_h', 'EF_h'],
      note: '用逐时电网排放因子对逐时电量加权，而非"年用电量 × 年均因子"。'
        + '当用电曲线与电网因子曲线的相关性为正时，两者结果会显著不同 —— '
        + '这正是"用哪个因子"会成为可争议点的原因，也是本平台坚持留存逐时读数与因子快照的动机。',
    },
  };

  /**
   * Tier 1：缺省法 E = AD × EF
   * @param {number} activity 活动数据
   * @param {number} factor 排放因子（单位须与活动数据匹配）
   * @returns {{value:number, method:string, formula:string, inputs:object}}
   */
  function tier1(activity, factor) {
    const v = Number(activity) * Number(factor);
    return { value: v, method: 'TIER1', formula: METHODS.TIER1.formula, inputs: { AD: Number(activity), EF: Number(factor) } };
  }

  /**
   * Tier 2：参数展开法 E = AD × NCV × CC × OF × 44/12
   * @param {{activity:number, ncv:number, cc:number, of:number, unitScale?:number}} p
   */
  function tier2(p) {
    const v = Number(p.activity) * Number(p.ncv) * Number(p.cc) * Number(p.of) * C_TO_CO2 * (p.unitScale || 1);
    return {
      value: v, method: 'TIER2', formula: METHODS.TIER2.formula,
      inputs: { AD: Number(p.activity), NCV: Number(p.ncv), CC: Number(p.cc), OF: Number(p.of) },
    };
  }

  /**
   * 动态电网法：E = Σ (电量_h × EF_h)
   * @param {Array<{kwh:number, factor:number, at?:number}>} readings
   */
  function gridDynamic(readings) {
    const list = readings || [];
    let total = 0;
    let kwhSum = 0;
    let weighted = 0;
    for (const r of list) {
      const k = Number(r.kwh) || 0;
      const f = Number(r.factor) || 0;
      total += k * f;
      kwhSum += k;
      weighted += k * f;
    }
    const avgFactor = kwhSum ? weighted / kwhSum : 0;
    return {
      value: total, method: 'GRID_DYNAMIC', formula: METHODS.GRID_DYNAMIC.formula,
      kwhTotal: kwhSum,
      effectiveFactor: avgFactor,           // 用电量加权等效因子
      points: list.length,
    };
  }

  /**
   * 同口径对比：年均因子法 vs 动态因子法。
   * 用于量化"用哪个因子"带来的口径差异（不是误差，是口径差 —— 两者都"对"，但含义不同）。
   * @param {Array<{kwh:number, factor:number}>} readings
   * @param {number} annualFactor 年均因子
   */
  function compareGridMethods(readings, annualFactor) {
    const dyn = gridDynamic(readings);
    const flat = dyn.kwhTotal * Number(annualFactor);
    const diff = dyn.value - flat;
    return {
      dynamic: dyn.value,
      flat,
      difference: diff,
      differencePct: flat ? (diff / flat) * 100 : 0,
      effectiveFactor: dyn.effectiveFactor,
      annualFactor: Number(annualFactor),
      kwhTotal: dyn.kwhTotal,
      interpretation: Math.abs(diff) < 1e-9
        ? '用电曲线与因子曲线无相关性，两种口径结果一致。'
        : (diff > 0
          ? '动态法结果更高：企业高负荷时段恰好落在电网因子较高的时段（如夜间），用年均因子会低估排放。'
          : '动态法结果更低：企业高负荷时段落在电网因子较低时段（如午间光伏大发），用年均因子会高估排放。'),
    };
  }

  /* ================================================================
   * B. 双轨一致性对账（组织碳 ↔ 产品碳）
   * ================================================================ */

  /**
   * 组织碳核算：把各类排放源按范围聚合。
   * @param {Array<{scope:'SCOPE1'|'SCOPE2', key:string, cn:string, quantity:number, unit:string, factor:number, tco2e:number}>} items
   */
  function aggregateOrg(items) {
    const list = items || [];
    const scope1 = list.filter((i) => i.scope === 'SCOPE1');
    const scope2 = list.filter((i) => i.scope === 'SCOPE2');
    const sum = (a) => a.reduce((s, i) => s + (Number(i.tco2e) || 0), 0);
    const byKey = {};
    list.forEach((i) => { byKey[i.key] = (byKey[i.key] || 0) + (Number(i.tco2e) || 0); });
    return {
      total: sum(list),
      scope1: sum(scope1),
      scope2: sum(scope2),
      byKey,
      items: list,
      count: list.length,
    };
  }

  /**
   * 双轨对账：组织碳总量 应 ≈ Σ(产品碳足迹) + 非生产性/辅助用能 + 损耗
   * ------------------------------------------------------------------
   * 差额不是"错误"，而是审计线索。本函数把差额拆成可解释的几类，
   * 并给出闭合率与需要说明的残差。
   * @param {{orgTotal:number, batches:Array<{batchNo:string, product:string, totalTco2e:number}>,
   *          auxiliary?:number, lossPct?:number, periodCn?:string}} p
   */
  function reconcile(p) {
    const orgTotal = Number(p.orgTotal) || 0;
    const batches = (p.batches || []).map((b) => ({ ...b, totalTco2e: Number(b.totalTco2e) || 0 }));
    const pcfSum = batches.reduce((s, b) => s + b.totalTco2e, 0);
    const auxiliary = Number(p.auxiliary) || 0;      // 辅助生产 / 办公等未分摊到产品的用能
    const lossPct = Number(p.lossPct) || 0;          // 输配损耗 / 计量误差等

    const explained = pcfSum + auxiliary;
    const residual = orgTotal - explained;           // 未解释残差
    const lossAllowance = orgTotal * (lossPct / 100);
    const withinTolerance = Math.abs(residual) <= lossAllowance;

    return {
      periodCn: p.periodCn || '',
      orgTotal,
      pcfSum,
      auxiliary,
      lossPct,
      explained,
      residual,
      residualPct: orgTotal ? (residual / orgTotal) * 100 : 0,
      lossAllowance,
      withinTolerance,
      closurePct: orgTotal ? (explained / orgTotal) * 100 : 0,
      batches,
      verdict: withinTolerance
        ? `双轨闭合（残差 ${(residual / 1000).toFixed(2)} ktCO₂e，落在 ${lossPct}% 容许区间内）。`
        : `双轨未闭合：残差 ${(residual / 1000).toFixed(2)} ktCO₂e 超出 ${lossPct}% 容许区间，`
          + '需说明差额来源（常见：批次边界与核算期不一致、辅助用能漏计、计量器具超差、'
          + '产品或半成品跨期结转）。',
    };
  }

  /* ================================================================
   * B2. 双轨对账（时间基校正 · 包含性硬约束 · 覆盖率归因）
   * ================================================================ */

  /**
   * 声明核算期与运行日历。
   * ------------------------------------------------------------------
   * 组织碳是"期间累计量"，设备读数是"瞬时率"。两者必须先统一到同一时间基
   * 才具备可比性 —— 这是双轨对账的第一道口径校正。该口径必须显式声明、
   * 可被质证，绝不允许用"24×365"这种隐式年化把结论强行凑出来。
   * @param {{days?:number, hoursPerDay?:number, availability?:number, periodCn?:string, devices?:Array}} opts
   */
  function productionCalendar(opts) {
    const o = opts || {};
    const days = Number(o.days) || 92;
    const hoursPerDay = Number(o.hoursPerDay) || 24;
    /* 在线率优先取自设备工况状态（异常态设备不计入有效运行小时），否则用声明值 */
    let availability = o.availability === undefined ? null : Number(o.availability);
    let availabilityFrom = '声明值';
    if (availability === null && o.devices && o.devices.length) {
      const ok = o.devices.filter((d) => d.online !== false
        && (!d.balance || d.balance.status !== 'ANOMALY')).length;
      availability = ok / o.devices.length;
      availabilityFrom = `在网设备工况折算（${ok}/${o.devices.length} 台有效）`;
    }
    if (availability === null) { availability = 0.94; availabilityFrom = '缺省声明值'; }
    const hours = days * hoursPerDay * availability;
    return {
      periodCn: o.periodCn || '2026Q3',
      days, hoursPerDay, availability, availabilityFrom, hours,
      note: `核算期 ${o.periodCn || '2026Q3'}：${days} 日 × ${hoursPerDay} h × 在线率 `
        + `${(availability * 100).toFixed(1)}%（${availabilityFrom}）≈ ${hours.toFixed(1)} 运行小时。`,
    };
  }

  /**
   * 设备瞬时率 → 期间累计排放（范围一 + 范围二）。
   * @param {Array} devices
   * @param {object} calendar productionCalendar() 的返回值
   * @param {object} SourcesRef
   */
  function meteredPeriodEmission(devices, calendar, SourcesRef) {
    const cal = calendar && calendar.hours ? calendar : productionCalendar();
    const hourly = orgFromDevices(devices, SourcesRef);
    const h = cal.hours;
    const scale = (v) => v * h;
    return {
      calendar: cal,
      hours: h,
      count: hourly.count,
      hourlyTotal: hourly.total,
      periodTotal: scale(hourly.total),
      scope1: scale(hourly.scope1),
      scope2: scale(hourly.scope2),
      byKey: Object.keys(hourly.byKey).reduce((o, k) => { o[k] = scale(hourly.byKey[k]); return o; }, {}),
      items: hourly.items.map((i) => Object.assign({}, i, { tco2ePeriod: scale(i.tco2e) })),
      note: `口径：设备瞬时读数 × ${h.toFixed(1)} 运行小时（${cal.periodCn}）。`
        + '设备清单为企业在网计量点，不等同于企业完整排放边界，故该值应作为'
        + '"已接入计量口径的组织碳"读用，而非企业全量排放。',
    };
  }

  /**
   * 产品碳内部自洽（Tier 1 强判据，可证伪）
   * ------------------------------------------------------------------
   * ① Σ(工序 BOM 分摊) === 批次总量
   * ② 范围一 + 范围二 === 批次总量
   *    （PCF 核算边界仅含范围一 + 范围二：GB/T 24067-2024 / ISO 14067
   *      cradle-to-gate 口径下，上游原辅料以内置因子形式计入各工序，
   *      不单列范围三。故三分量必须闭环。）
   * @param {Array} batches
   * @param {number} tolerancePct
   */
  function pcfInternalClosure(batches, tolerancePct) {
    const tol = tolerancePct === undefined ? 0.5 : tolerancePct;
    const rows = (batches || []).map((b) => {
      const stages = (b.bom && b.bom.stages) || [];
      const stageSum = stages.reduce((s, x) => s + (Number(x.tco2e) || 0), 0);
      const scopeSum = (Number(b.scope1) || 0) + (Number(b.scope2) || 0);
      const total = Number(b.totalTco2e) || 0;
      const stageDevPct = total ? ((stageSum - total) / total) * 100 : 0;
      const scopeDevPct = total ? ((scopeSum - total) / total) * 100 : 0;
      return {
        batchNo: b.batchNo, product: b.product, entShort: b.entShort, status: b.status,
        totalTco2e: total,
        stageSum: +stageSum.toFixed(2), scopeSum: +scopeSum.toFixed(2),
        stageDevPct: +stageDevPct.toFixed(4), scopeDevPct: +scopeDevPct.toFixed(4),
        pass: Math.abs(stageDevPct) <= tol && Math.abs(scopeDevPct) <= tol,
      };
    });
    const ok = rows.filter((r) => r.pass).length;
    return {
      tolerancePct: tol, rows, ok, total: rows.length,
      allPass: rows.length > 0 && ok === rows.length,
      maxStageDevPct: rows.reduce((m, r) => Math.max(m, Math.abs(r.stageDevPct)), 0),
      maxScopeDevPct: rows.reduce((m, r) => Math.max(m, Math.abs(r.scopeDevPct)), 0),
      criteria: [
        `① Σ(工序 BOM 分摊) 与批次总量偏差 ≤ ${tol}%`,
        `② 范围一 + 范围二 与批次总量偏差 ≤ ${tol}%（PCF 边界仅含范围一 + 范围二）`,
      ],
      note: '产品碳侧的内部闭合判据，属硬约束：任一条不通过都说明数据链路存在错误。',
    };
  }

  /**
   * 企业级双轨对账
   * ------------------------------------------------------------------
   * 轨道 O（组织碳，自上而下）= 在网计量设备读数按声明日历积分
   * 轨道 P（产品碳，自下而上）= 该企业当期已上链存证的批次产品碳足迹合计
   *
   * 判据设计（本方法的核心）：
   *   组织碳刻画的是一家企业**全部**排放；产品碳只覆盖**已存证的部分批次**。
   *   所以正确的判据不是"两个数字相等"，而是：
   *     ① 包含性（硬约束）：O ≥ P。组织碳必须是其产品碳之和的上界，
   *        违反即为数据打架（计量盲区 / 活动数据错误 / 未计量的直排）。
   *     ② 可分摊空间：E_alloc = O × (1 − 辅助率 − 损耗率)，即组织碳中理论上
   *        可归集到产品的那部分。
   *     ③ 存证覆盖率：ρ = P / E_alloc。试点平台 ρ 偏小是正常的（只存证了
   *        部分批次）；如实报告 ρ 而不是调参凑闭合，才是可被质证的做法。
   * @param {{orgTotal:number, batches:Array, auxShare?:number, lossShare?:number}} p
   */
  function enterpriseReconcile(p) {
    const orgTotal = Number(p.orgTotal) || 0;
    const batches = (p.batches || []).map((b) => ({
      batchNo: b.batchNo, product: b.product, entShort: b.entShort,
      totalTco2e: Number(b.totalTco2e) || 0,
    }));
    const pcfSum = batches.reduce((s, b) => s + b.totalTco2e, 0);
    const auxShare = p.auxShare === undefined ? 0.055 : Number(p.auxShare);
    const lossShare = p.lossShare === undefined ? 0.08 : Number(p.lossShare);
    const allocatable = orgTotal * (1 - auxShare - lossShare);
    const residual = allocatable - pcfSum;
    const coveragePct = allocatable > 0 ? (pcfSum / allocatable) * 100 : 0;
    const containment = pcfSum <= orgTotal;
    const residualNonNeg = residual >= -1e-6;
    const pass = containment && residualNonNeg;
    return {
      entId: p.entId, entName: p.entName, industry: p.industry,
      periodCn: p.periodCn || '',
      orgTotal, pcfSum, auxShare, lossShare, allocatable,
      residual, coveragePct,
      containment, residualNonNeg, pass,
      unexplained: residual < 0 ? -residual : 0,
      batches,
      verdict: pass
        ? `双轨包含性成立：组织碳 ${orgTotal.toFixed(1)} ≥ 已存证产品碳 ${pcfSum.toFixed(1)} tCO₂e，`
          + `存证覆盖率 ${coveragePct.toFixed(1)}%；余下 ${residual.toFixed(1)} tCO₂e 为未纳入本期存证的产出，`
          + `另有声明辅助用能 ${(auxShare * 100).toFixed(1)}%、输配损耗与计量超差 ${(lossShare * 100).toFixed(1)}%。`
        : `双轨包含性被击破：已存证产品碳 ${pcfSum.toFixed(1)} tCO₂e 超出组织碳 ${orgTotal.toFixed(1)} tCO₂e`
          + `（超 ${(-residual).toFixed(1)} tCO₂e）。产品碳之和不可能大于企业组织碳总量，`
          + '说明存在计量盲区、活动数据错误或未计量的直接排放，必须回溯原始凭证。',
    };
  }

  /**
   * 联盟级汇总对账：把各企业结果合并，并显式区分"未接入计量"的企业。
   * @param {Array} perEnterprise enterpriseReconcile 的结果数组（每项含 metered 标记）
   */
  function leagueReconcile(perEnterprise) {
    const list = perEnterprise || [];
    const metered = list.filter((r) => r.metered !== false);
    const unmetered = list.filter((r) => r.metered === false);
    const sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const orgTotal = sum(metered, 'orgTotal');
    const pcfSum = sum(list, 'pcfSum');
    const allocatable = sum(metered, 'allocatable');
    const failed = list.filter((r) => r.metered !== false && !r.pass);
    return {
      enterprises: list.length,
      meteredCount: metered.length,
      unmeteredCount: unmetered.length,
      unmetered: unmetered.map((r) => ({ entId: r.entId, entName: r.entName, reason: r.reason })),
      orgTotal, pcfSum, allocatable,
      coveragePct: allocatable > 0 ? (pcfSum / allocatable) * 100 : 0,
      failed: failed.map((r) => r.entId),
      allPass: failed.length === 0,
      note: '联盟级对账只对"已接入计量"的企业做包含性校验；未接入计量的企业单列，'
        + '不得用估算值填补（否则对账失去意义）。',
    };
  }

  /* ================================================================
   * C. 不确定度传播
   * ================================================================ */

  /**
   * 把不确定度参数表整理成标准化输入。
   * @param {Array<{id:string, cn:string, value:number, sigmaRel:number, dist?:string}>} specs
   */
  function toInputs(specs) {
    return (specs || []).map((s) => ({
      id: s.id,
      cn: s.cn,
      value: Number(s.value),
      sigmaRel: Number(s.sigmaRel) || 0,
      dist: s.dist || 'normal',
    }));
  }

  /**
   * 解析解（一阶误差传播，IPCC 2006 Vol.1 Ch.3 Eq.3.1）
   * @param {Array} inputs
   * @param {'product'|'sum'} model
   */
  function analyticUncertainty(inputs, model) {
    const list = toInputs(inputs);
    if (model === 'sum') {
      const total = list.reduce((s, i) => s + i.value, 0);
      // 绝对不确定度合成：sqrt(Σ(σᵢ·xᵢ)²)，再除以总量得到相对值
      const absVar = list.reduce((s, i) => s + Math.pow(i.sigmaRel * i.value, 2), 0);
      const absSigma = Math.sqrt(absVar);
      return {
        model: 'sum',
        central: total,
        absSigma,
        sigmaRel: total ? absSigma / total : 0,
        contributions: list.map((i) => ({
          id: i.id, cn: i.cn,
          share: absVar ? Math.pow(i.sigmaRel * i.value, 2) / absVar : 0,
        })),
        formula: 'U = √( Σ (σᵢ · xᵢ)² ) / Σ xᵢ',
      };
    }
    // 乘性模型：相对不确定度 = √(Σσᵢ²)
    const central = list.reduce((s, i) => s + (i.mul ? Math.log(i.value) : 0), 0);
    const sigmaRel = Math.sqrt(list.reduce((s, i) => s + Math.pow(i.sigmaRel, 2), 0));
    const varSum = list.reduce((s, i) => s + Math.pow(i.sigmaRel, 2), 0);
    return {
      model: 'product',
      central: list.reduce((s, i) => s * i.value, 1),
      sigmaRel,
      contributions: list.map((i) => ({
        id: i.id, cn: i.cn,
        share: varSum ? Math.pow(i.sigmaRel, 2) / varSum : 0,
      })),
      formula: 'U = √( Σ σᵢ² )',
      _logCentral: central,
    };
  }

  /**
   * 蒙特卡洛不确定度传播（真实抽样）
   * ------------------------------------------------------------------
   * 模型：
   *   · product：y = Π (xᵢ · (1 + σᵢ·zᵢ))          —— 排放因子链 / 多参数相乘
   *   · sum     ：y = Σ (xᵢ · (1 + σᵢ·zᵢ))          —— 多排放源相加
   * @param {Array} inputs [{id,cn,value,sigmaRel,dist}]
   * @param {{model?:'product'|'sum', iterations?:number, seed?:number, confidence?:number[]}} opts
   */
  function monteCarlo(inputs, opts) {
    const o = opts || {};
    const list = toInputs(inputs);
    const model = o.model === 'sum' ? 'sum' : 'product';
    const N = Math.max(100, Number(o.iterations) || 10000);
    const seed = o.seed === undefined ? 20261011 : Number(o.seed);
    const confs = o.confidence || [0.05, 0.5, 0.95];

    const rand = mulberry32(seed);
    const normal = makeNormal(rand);

    const out = new Float64Array(N);
    // 敏感性分析用：记录各输入的标准化扰动 zᵢ 与输出
    const zByInput = list.map(() => new Float64Array(N));

    for (let k = 0; k < N; k++) {
      let acc = model === 'sum' ? 0 : 1;
      for (let j = 0; j < list.length; j++) {
        const inp = list[j];
        const z = inp.dist === 'lognormal'
          // 对数正态：x = value · exp(σ·z − σ²/2)，中位数不变
          ? Math.exp(inp.sigmaRel * normal() - (inp.sigmaRel * inp.sigmaRel) / 2)
          : 1 + inp.sigmaRel * normal();
        zByInput[j][k] = z;
        if (model === 'sum') acc += inp.value * z;
        else acc *= inp.value * z;
      }
      out[k] = acc;
    }

    // 统计量
    const sorted = Float64Array.from(out).sort();
    const mean = out.reduce((s, v) => s + v, 0) / N;
    let varAcc = 0;
    for (let k = 0; k < N; k++) varAcc += (out[k] - mean) * (out[k] - mean);
    const sd = Math.sqrt(varAcc / (N - 1));
    const q = (p) => sorted[Math.min(N - 1, Math.max(0, Math.floor(p * N)))];

    // 一阶敏感性：corr(zⱼ, y)²，归一化为贡献占比
    const corr2 = list.map((inp, j) => {
      const zs = zByInput[j];
      const mz = zs.reduce((s, v) => s + v, 0) / N;
      let cz = 0; let cw = 0; let wz = 0; let wy = 0;
      for (let k = 0; k < N; k++) {
        const dz = zs[k] - mz;
        const dy = out[k] - mean;
        cz += dz * dy; wz += dz * dz; wy += dy * dy;
      }
      void cw;
      const r = (wz * wy) > 0 ? cz / Math.sqrt(wz * wy) : 0;
      return { id: inp.id, cn: inp.cn, sigmaRel: inp.sigmaRel, r2: r * r };
    });
    const r2sum = corr2.reduce((s, c) => s + c.r2, 0);
    corr2.forEach((c) => { c.share = r2sum ? c.r2 / r2sum : 0; });
    corr2.sort((a, b) => b.share - a.share);

    const analytic = analyticUncertainty(list, model);
    const ci = {};
    confs.forEach((c) => { ci['p' + Math.round(c * 100)] = q(c); });

    /* 直方图分箱（供可视化）。边界取 P0.1 ~ P99.9，避免长尾把主峰压扁；
     * 越界样本计入 clipped，不丢弃、不隐藏。 */
    const hLo = sorted[Math.floor(0.001 * N)];
    const hHi = sorted[Math.min(N - 1, Math.floor(0.999 * N))];
    const BINS = 40;
    const hWidth = (hHi - hLo) / BINS || 1;
    const counts = new Array(BINS).fill(0);
    let below = 0; let above = 0;
    for (let k = 0; k < N; k++) {
      const v = out[k];
      if (v < hLo) { below++; continue; }
      if (v > hHi) { above++; continue; }
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((v - hLo) / hWidth)));
      counts[idx] += 1;
    }
    const histogram = {
      bins: BINS, lo: hLo, hi: hHi, width: hWidth,
      centers: Array.from({ length: BINS }, (_, i) => hLo + (i + 0.5) * hWidth),
      counts,
      clipped: { below, above },
      note: '边界取 P0.1~P99.9（P0.1 以下 ' + below + ' 个样本、P99.9 以上 ' + above + ' 个样本计入 clipped，未丢弃）。',
    };

    return {
      model,
      iterations: N,
      seed,
      central: analytic.central,
      mean,
      sd,
      sigmaRel: mean ? sd / mean : 0,
      min: sorted[0],
      max: sorted[N - 1],
      quantiles: ci,
      histogram,
      distribution: {
        type: model === 'product' ? '近似对数正态（乘性模型）' : '近似正态（加性模型）',
        note: model === 'product'
          ? '乘性模型下输出服从对数正态，均值略高于中位数，右偏 —— 这解释了为什么'
            + '"点估计值"往往低于"分布均值"，保守取值应看 P95 而非均值。'
          : '加性模型下输出近似正态，"点估计 ±2σ"即约 95% 置信区间。',
      },
      analytic,
      crossCheck: {
        analyticSigmaRel: analytic.sigmaRel,
        mcSigmaRel: mean ? sd / mean : 0,
        absDiffPct: analytic.sigmaRel ? Math.abs((mean ? sd / mean : 0) - analytic.sigmaRel) / analytic.sigmaRel * 100 : 0,
        note: '解析解与蒙特卡洛解应高度一致（相对偏差 < 5%）。'
          + '若不一致，说明抽样次数不足或模型非线性较强 —— 这是一道**自检闸门**，'
          + '本平台每次运行都会校验，避免"跑了个蒙特卡洛但其实算错了"。',
      },
      sensitivity: corr2.map((c) => ({
        id: c.id, cn: c.cn, sigmaRel: c.sigmaRel,
        sharePct: Math.round(c.share * 1000) / 10,
      })),
      recommendation: (function () {
        const top = corr2[0];
        if (!top) return '无输入项，无法给出建议。';
        const target = top.share > 0 ? top.cn : '';
        return `方差贡献最大的是「${target}」（占 ${(top.share * 100).toFixed(1)}%）。`
          + `若要压缩核算结果的不确定度，优先把它从"缺省值"换成"实测值"——`
          + `只改这一项，理论上可把总不确定度降到 √(Σσᵢ² − σ_${top.id}²)。`;
      })(),
    };
  }

  /* ================================================================
   * 便捷封装：从台账 + 工业数据域直接跑
   * ================================================================ */

  /** 取台账（浏览器读 App.Sources；Node 下可传入） */
  function ledgerVia(SourcesRef) {
    if (SourcesRef) return SourcesRef;
    if (typeof global.App !== 'undefined' && global.App && global.App.Sources) return global.App.Sources;
    try { return require('./sources.js'); } catch (e) { return null; }
  }

  /**
   * 对"粉尘/燃料燃烧"单源做 Tier1/Tier2 双路核算并比对。
   * @param {string} fuelCode 台账中的燃料编码
   * @param {number} activity 活动数据（吨 / 万Nm³）
   * @param {object} SourcesRef
   */
  function dualPathFuel(fuelCode, activity, SourcesRef) {
    const S = ledgerVia(SourcesRef);
    if (!S) throw new Error('[nucleus] 缺少因子台账 App.Sources');
    const f = S.fuelFactor(fuelCode);
    if (!f) throw new Error('[nucleus] 台账中无燃料 ' + fuelCode);
    const a = tier1(activity, f.ef / 1000);                     // 台账 ef 单位 kgCO₂ → tCO₂
    const b = tier2({ activity, ncv: f.ncv, cc: f.cc, of: f.of }); // tCO₂
    const diff = b.value - a.value;
    return {
      fuelCode, cn: f.cn, activity,
      tier1: a, tier2: b,
      difference: diff,
      differencePct: a.value ? (diff / a.value) * 100 : 0,
      consistent: a.value ? Math.abs(diff / a.value) * 100 <= 0.5 : true,
      note: 'Tier 1 用台账公布的缺省因子；Tier 2 用同一组参数从原始算式重新算一遍。'
        + '两者应当一致（差异仅来自官方公布值的进位取整）—— 这是对台账本身的交叉校验。',
    };
  }

  /**
   * 对一批工业设备读数做组织碳核算（范围一 + 范围二）。
   * @param {Array} devices App.Industry.devices（含 live 读数与 kind）
   * @param {object} SourcesRef
   */
  function orgFromDevices(devices, SourcesRef) {
    const S = ledgerVia(SourcesRef);
    if (!S) throw new Error('[nucleus] 缺少因子台账 App.Sources');
    const EF_ELEC = S.powerFactor('national').value;  // tCO₂/MWh
    const items = [];
    (devices || []).forEach((d) => {
      const live = d.live || {};
      if (d.kind === 'METER' && live.powerKwh) {
        const mwh = Number(live.powerKwh) / 1000;
        items.push({
          scope: 'SCOPE2', key: 'ELECTRICITY', cn: '外购电力（' + d.did + '）',
          source: d.name, quantity: Number(live.powerKwh), unit: 'kWh', factor: EF_ELEC,
          tco2e: mwh * EF_ELEC,
        });
      } else if (d.kind === 'GAS' && live.gasNm3) {
        const f = S.fuelFactor('NATURAL_GAS');
        const efNm3 = f ? f.ef / 1e4 / 1000 : 0.0021622; // tCO₂/Nm³
        items.push({
          scope: 'SCOPE1', key: 'NATURAL_GAS', cn: '天然气（' + d.did + '）',
          source: d.name, quantity: Number(live.gasNm3), unit: 'Nm³', factor: efNm3,
          tco2e: Number(live.gasNm3) * efNm3,
        });
      } else if (d.kind === 'STEAM' && live.steamT) {
        const f = S.fuelFactor('STEAM');
        const efGj = f ? f.ef : 0.11;  // tCO₂/GJ（示例值 C 级）
        const gj = Number(live.steamT) * 2.76; // 1 t 蒸汽 ≈ 2.76 GJ（按典型中压蒸汽焓值折算）
        items.push({
          scope: 'SCOPE2', key: 'STEAM', cn: '外购蒸汽（' + d.did + '）',
          source: d.name, quantity: Number(live.steamT), unit: 't', factor: efGj,
          tco2e: gj * efGj,
          note: '蒸汽按 1 t ≈ 2.76 GJ 折算，属工程近似；正式核算须取供热方实测焓值。',
        });
      }
    });
    return aggregateOrg(items);
  }

  /**
   * 对"某批次碳足迹总量"做蒙特卡洛不确定度传播（真实抽样）。
   * 输入项取 IPCC 参数表中的 AD / NCV / CC / OF + 电网因子不确定度。
   * @param {number} centralTco2e 点估计值（tCO₂e）
   * @param {object} opts
   */
  function mcForBatch(centralTco2e, opts) {
    const S = ledgerVia(opts && opts.Sources);
    const o = opts || {};
    const share = {
      AD: o.adShare === undefined ? 0.72 : o.adShare,
      FUEL: o.fuelShare === undefined ? 0.22 : o.fuelShare,
      ELEC: o.elecShare === undefined ? 0.06 : o.elecShare,
    };
    const p = (S && S.uncertainty && S.uncertainty.parameters) || [];
    const pick = (id, fallback) => {
      const row = p.find((x) => x.id === id);
      return row ? row.sigmaRel : fallback;
    };
    const inputs = [
      { id: 'AD', cn: '活动数据（计量）', value: centralTco2e * share.AD, sigmaRel: pick('AD', 0.03), dist: 'normal' },
      { id: 'FUEL', cn: '燃料参数链（NCV×CC×OF）', value: centralTco2e * share.FUEL, sigmaRel: Math.sqrt(Math.pow(pick('NCV', 0.05), 2) + Math.pow(pick('CC', 0.05), 2) + Math.pow(pick('OF', 0.02), 2)), dist: 'normal' },
      { id: 'ELEC', cn: '电网排放因子', value: centralTco2e * share.ELEC, sigmaRel: pick('EF_ELEC', 0.02), dist: 'normal' },
    ];
    return monteCarlo(inputs, { model: 'sum', iterations: o.iterations || 10000, seed: o.seed });
  }

  /* ================================================================
   * 导出
   * ================================================================ */
  const Nucleus = {
    METHODS,
    C_TO_CO2,
    // 随机数
    mulberry32, makeNormal,
    // A 核算
    tier1, tier2, gridDynamic, compareGridMethods,
    // B 对账
    aggregateOrg, reconcile,
    productionCalendar, meteredPeriodEmission,
    pcfInternalClosure, enterpriseReconcile, leagueReconcile,
    // C 不确定度
    toInputs, analyticUncertainty, monteCarlo,
    // 便捷封装
    dualPathFuel, orgFromDevices, mcForBatch,
  };

  global.App = global.App || {};
  global.App.Nucleus = Nucleus;
  if (typeof module !== 'undefined' && module.exports) module.exports = Nucleus;
})(typeof window !== 'undefined' ? window : globalThis);
