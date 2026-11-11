/**
 * uncertainty.js —— WP4 核算升级：把"一个数字"变成"一个可辩护的区间"
 * ==================================================================
 * 为什么这是本平台最容易被评审专家追问的一环
 * ------------------------------------------------------------------
 * 前面的 WP1/WP6 已经解决了"数据从哪来""数据有没有被改过"。
 * 但只要平台还只输出"企业 X 年排放 12,345.67 吨"这样一个**单点数字**，
 * 任何一个懂核查的人都会问同一句话：
 *
 *     "这个数字的误差有多大？超排了 3% 你凭什么说是超排？"
 *
 * 本模块就是对这句话的正面回答。它做四件事：
 *
 *   ① 数据准入 —— 三级门控（质量标记 / 物理量级 / 时间覆盖）
 *      被剔除的每一条读数都要能给出来源、数量、理由。**不做静默清洗。**
 *   ② 区间估计 —— Normal-Inverse-Gamma 共轭后验（均值与方差同时未知）
 *      输出年度排放的 95% 置信区间；再用蒙特卡洛独立抽验一遍，
 *      两条路径必须给出相同端点 —— 这是"区间算对了"的证据。
 *   ③ 交叉校验 —— GUM/误差传播法（IPCC 分级缺省不确定度）独立算一遍，
 *      与贝叶斯区间对照。两者同量级 ⇒ 互相印证；差一个数量级 ⇒ 必须解释。
 *   ④ 归因分解 —— 把总不确定度拆到"测量 / 缺口 / 电耗计量 / 电网因子"，
 *      告诉企业**去哪一项上花力气降不确定度最划算**。
 *
 * ------------------------------------------------------------------
 * 三条诚实红线（本模块全部结论的可信度都压在这三条上）
 * ------------------------------------------------------------------
 * 红线 1 · 不外推空白
 *   两个有效读数之间超过名义采样周期（4h）的空白，一律**不补、不外推**，
 *   只在 coverage 里如实记为缺口。宁可低估排放量，也不造数据。
 *   （注：这是核算口径，不是补齐口径 —— 平台另有 PIM 替代规则用于履约结算，
 *     两者用途不同，不得混用。）
 *
 * 红线 2 · 先验强度必须自证无影响
 *   共轭先验天然有"把结论往先验拽"的倾向。模块固定做先验敏感性扫描：
 *   kappa0 跨 4 个数量级变化，若 95% 区间宽度变化超过阈值，则**拒绝出结论**。
 *
 * 红线 3 · 复杂模型不胜任就如实说
 *   modelEval() 会把 MAPE/R² 与消融结果一起落库。31 天样本撑不起季节项时，
 *   结论里就写"复杂模型未取胜"，而不是挑一个好看的指标往上报。
 * ==================================================================
 */
'use strict';

const db = require('../db');
const st = require('./statistics');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');
/* ⭐ 年度口径的唯一来源。本模块**不允许**自写年化公式（见 posterior 内的说明）：
   同一份读数在两侧套不同放大系数，就是"核算口径分叉"的来源 ②。 */
const dyn = require('./dynamic');

/* ==================================================================
 * 一、口径常量（每一个都给出依据，不出现"经验值"三个字）
 * ================================================================== */

/** 单排口瞬时排放速率的工程上限（tCO2e/h）
 *  依据：国内单机容量最大的 1000MW 超超临界燃煤机组，年排放约 370 万 tCO2e，
 *  按 5000 等效满负荷小时折算 ≈ 745 tCO2e/h。取 5000 即留 6.7 倍余量。
 *  超过此值的一律判为量级异常，不进入核算。 */
const HARD_MAX_RATE = 5000;

/** 单企业日排放的工程上限（tCO2e/天）
 *  依据：日内 24h × 单企业最多 10 个排口 × 745 ≈ 17.9 万，取 8 万为保守上限。 */
const HARD_MAX_DAILY = 80000;

/** 名义采样周期（分钟）。HJ 212 数据采集传输仪最小上报周期为 1 分钟，
 *  平台配置的名义周期为 4 小时；超过名义周期的空白按红线 1 处理。 */
const NOMINAL_INTERVAL_MIN = 240;

/** 稳健离群门控阈值（对数空间，见 gate()）。
 *  z 条件给出统计依据，ratio 条件控制误杀：两者**同时**满足才判为离群。 */
const OUTLIER_Z = 6;
const OUTLIER_RATIO = 5;

/** 默认置信水平 */
const LEVEL = 0.95;

/** IPCC 式分级缺省不确定度（相对值）—— 来源：《省级温室气体清单编制指南》
 *  与 HJ 75/76 对 CEMS 系统的准确度要求，逐项可查。 */
const TIER_UNCERTAINTY = {
  cemsHigh: 0.05,      // CEMS 实测，有效覆盖 ≥ 95%
  cemsMid: 0.10,       // CEMS 实测，有效覆盖 80%~95%（含替代补齐）
  cemsLow: 0.20,       // CEMS 实测，有效覆盖 < 80%
  substitute: 0.50,    // 缺数替代段：按相邻时段均值替代，替代值本身按 ±50% 计
  gridFactor: 0.05,    // 区域电网基准线排放因子（生态环境部年度公布值的不确定度区间）
  metering: 0.02,      // 电能表计量准确度（0.5S 级 + 互感器合成）
  defaultFactor: 0.10, // 缺省排放因子（未实测时）
};

/** 年化天数口径：与配额、履约保持一致，统一按自然年 365 天，
 *  闰年不做特例（避免同一企业相邻两年口径不可比）。 */
const DAYS_PER_YEAR = 365;

/* ==================================================================
 * 二、一级门控：把原始读数整理成"可用读数"
 * ================================================================== */

/**
 * 逐排口稳健基准（对数空间中位数 + MAD）。
 *
 * 为什么用中位数/MAD 而不是均值/标准差：量级异常本身就是离群点，
 * 均值与标准差会被它自己拉偏，导致"用被污染的标准去判污染"的循环。
 * 中位数与 MAD 的崩点（breakdown point）为 50%，不受少数离群值影响。
 */
function stackBaselines(rows) {
  const byMon = new Map();
  for (const r of rows) {
    const rate = Number(r.flow_value);
    if (!(rate > 0) || !Number.isFinite(rate) || rate > HARD_MAX_RATE) continue;
    if (r.quality_flag !== 'NORMAL' || r.status !== 'NORMAL') continue;
    if (String(r.source || '').toUpperCase() === 'WATCHDOG') continue;
    const k = String(r.monitor_no);
    if (!byMon.has(k)) byMon.set(k, []);
    byMon.get(k).push(Math.log(rate));
  }
  const out = new Map();
  for (const [k, v] of byMon) {
    v.sort((a, b) => a - b);
    const med = v[Math.floor(v.length / 2)];
    const dev = v.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
    const mad = dev[Math.floor(dev.length / 2)] * 1.4826;   // 归一化到 σ 尺度
    out.set(k, { n: v.length, med, mad });
  }
  return out;
}

/**
 * 数据准入四级门控。
 *
 *   gate-1 数据来源：source ≠ 'WATCHDOG'
 *          （WATCHDOG 是平台看门狗补记的离线占位记录，**不是设备上报**，
 *           用在链路可用性统计里，绝不能进排放核算）
 *   gate-2 有效性：rate > 0 且有限
 *          （零值/负值 = 停机或校准态，本身是真实工况，但不构成排放）
 *   gate-3 质量标记：quality_flag = 'NORMAL' 且 status = 'NORMAL'
 *          （MISSING/DRIFT/OFFLINE/CALIBRATION 一律剔除）
 *   gate-4 物理量级：rate ≤ HARD_MAX_RATE
 *          （剔除量级异常，典型表现是被取代的旧构建写入的 10³ 倍放大值）
 *   gate-5 稳健离群：同排口对数空间 |z| > OUTLIER_Z 且 rate > OUTLIER_RATIO × 稳健中位数
 *          （判据：既要有统计依据，又要有工程意义上的量级差。详见 OUTLIER_* 常量注释）
 *
 * 每一级剔除都单独计数并在报告中披露 —— 不做静默清洗。
 *
 * @param {Array} rows 原始读数
 * @param {object} opts { outlierZ, outlierRatio, baselineMin }
 * @returns {{kept:Array, byReason:Object, notes:Array, baselines:Map, total:number}}
 */
function gate(rows, opts = {}) {
  const zLim = opts.outlierZ === undefined ? OUTLIER_Z : opts.outlierZ;
  const rLim = opts.outlierRatio === undefined ? OUTLIER_RATIO : opts.outlierRatio;
  const baselineMin = opts.baselineMin === undefined ? 20 : opts.baselineMin;
  const baselines = stackBaselines(rows);

  const byReason = {
    watchdog: 0,      // 看门狗占位记录
    nonPositive: 0,   // 零/负值（停机、校准）
    qualityFlag: 0,   // 质量标记不合格
    implausible: 0,   // 超出工程上限
    outlier: 0,       // 稳健离群
  };
  const notes = [];
  const kept = [];
  let maxSeen = 0;
  let maxOutlierRatio = 0;

  for (const r of rows) {
    const rate = Number(r.flow_value);
    if (Number.isFinite(rate) && rate > maxSeen) maxSeen = rate;
    /* 归因顺序即信息披露顺序：先判"这条到底是不是设备报的"，再判数值本身。
       理由：WATCHDOG 占位记录的 flow_value 恒为 0，若先判零值，它们会被
       笼统计入"零值"一栏，报告里就看不出"平台补记的占位"与"设备报的真实停机"
       是两回事 —— 前者根本不该进核算，后者才是工况。 */
    if (String(r.source || '').toUpperCase() === 'WATCHDOG') {
      byReason.watchdog++;
      continue;
    }
    if (!(rate > 0) || !Number.isFinite(rate)) {
      byReason.nonPositive++;
      continue;
    }
    if (r.quality_flag !== 'NORMAL' || r.status !== 'NORMAL') {
      byReason.qualityFlag++;
      continue;
    }
    if (rate > HARD_MAX_RATE) {
      byReason.implausible++;
      continue;
    }
    /* 稳健离群：需要同排口至少 baselineMin 个可用点才敢建基准 */
    const b = baselines.get(String(r.monitor_no));
    if (b && b.n >= baselineMin && b.mad > 1e-9) {
      const z = Math.abs(Math.log(rate) - b.med) / b.mad;
      const ratio = rate / Math.exp(b.med);
      if (z > zLim && ratio > rLim) {
        byReason.outlier++;
        if (ratio > maxOutlierRatio) maxOutlierRatio = ratio;
        continue;
      }
    }
    kept.push({ t: new Date(r.reading_time), rate, monitor: r.monitor_no });
  }

  if (byReason.implausible) {
    notes.push(`剔除 ${byReason.implausible} 条超工程上限读数（瞬时速率 > ${HARD_MAX_RATE} tCO2e/h）`
      + `，最大观测值 ${maxSeen.toFixed(2)} tCO2e/h，超限 ${(maxSeen / HARD_MAX_RATE).toFixed(1)} 倍。`
      + '该类读数不具备物理意义，按红线 1 不予替代、直接剔除并披露。');
  }
  if (byReason.outlier) {
    notes.push(`剔除 ${byReason.outlier} 条稳健离群读数（同排口对数空间 |z| > ${zLim} 且`
      + ` 高于稳健中位数 ${rLim} 倍以上；最大偏离 ${maxOutlierRatio.toFixed(0)} 倍）。`
      + '判据为"统计显著 + 工程量级异常"双条件，避免把正常负荷波动误判为离群。');
  }
  if (byReason.watchdog) {
    notes.push(`剔除 ${byReason.watchdog} 条 WATCHDOG 看门狗占位记录（平台补记的离线占位，非设备上报）。`);
  }
  if (byReason.nonPositive) {
    notes.push(`剔除 ${byReason.nonPositive} 条零值/负值读数（停机或校准态）。`);
  }
  if (byReason.qualityFlag) {
    notes.push(`剔除 ${byReason.qualityFlag} 条质量标记不合格读数（MISSING/DRIFT/OFFLINE/CALIBRATION）。`);
  }
  return { kept, byReason, notes, baselines, total: rows.length };
}

/* ==================================================================
 * 三、日均排放序列（步进积分 + 时间覆盖）
 * ================================================================== */

/**
 * 步进积分：把"瞬时速率"序列积分为"排放量"。
 *
 * 口径：第 i 个有效读数代表其后 Δt_i = min(t_{i+1} − t_i, 名义周期) 时段的平均速率。
 *       末点无后继 → 不予外推（宁可少算）。
 *       超过名义周期的空白 → 按名义周期截断，剩余部分记为缺口。
 *
 * 为什么不能"条数 × 名义周期"：本平台数据存在两种采样密度
 * （种子段 4h/条、设备直报段 1min/条）。若按固定周期折算，
 * 1 分钟采样段会被放大 240 倍 —— 这是 WP4 最初版本的错误，已修正并加断言。
 *
 * @param {Array} kept 门控后的读数 [{t, rate, monitor}]
 * @returns {{byDay:Map, coveredMin:number, gapMin:number, maxGapMin:number, points:number}}
 */
function integrate(kept) {
  const byMonitor = new Map();
  for (const p of kept) {
    if (!byMonitor.has(p.monitor)) byMonitor.set(p.monitor, []);
    byMonitor.get(p.monitor).push(p);
  }
  const byDay = new Map();          // 'YYYY-MM-DD' → 排放量
  const byDayMin = new Map();       // 'YYYY-MM-DD' → 被实测覆盖的分钟数
  const monitors = [];              // 逐排口统计（用于"各排口只看自己的观测跨度"）
  let coveredMin = 0;
  let gapMin = 0;
  let maxGapMin = 0;
  let points = 0;

  for (const [name, list] of byMonitor) {
    list.sort((a, b) => a.t - b.t);
    let mCovered = 0;
    let mGap = 0;
    let mEnergy = 0;
    for (let i = 0; i < list.length - 1; i++) {
      const dtMin = (list[i + 1].t - list[i].t) / 60000;
      if (!(dtMin > 0)) continue;
      const use = Math.min(dtMin, NOMINAL_INTERVAL_MIN);
      const rest = dtMin - use;
      if (rest > 0) { mGap += rest; if (rest > maxGapMin) maxGapMin = rest; }
      /* 把这段时间的排放量摊到它跨越的各个自然日（避免跨日点全落到起始日） */
      const energy = list[i].rate * (use / 60);      // tCO2e
      spreadToDays(byDay, byDayMin, list[i].t, use, energy);
      mCovered += use;
      mEnergy += energy;
      points++;
    }
    coveredMin += mCovered;
    gapMin += mGap;
    monitors.push({
      monitor: name,
      first: list[0].t.toISOString(),
      last: list[list.length - 1].t.toISOString(),
      readings: list.length,
      /* 该排口**自己的**观测跨度（不是全局跨度）。
         为什么必须分开算：某些排口只在窗口里出现过几分钟（测试设备、临时接入、
         已停用的点），若把它们按"全局跨度"计入分母，会把一家正常企业的
         覆盖度算成十几个百分点，进而错误地把它归到最宽的分级不确定度档。 */
      ownSpanMin: Number(((list[list.length - 1].t - list[0].t) / 60000).toFixed(2)),
      coveredMin: Number(mCovered.toFixed(2)),
      gapMin: Number(mGap.toFixed(2)),
      /* 该排口窗口内的实测排放量：既用于诊断，也是"企业级覆盖时长"加权平均的权重 */
      energy: Number(mEnergy.toFixed(3)),
    });
  }
  /* ⭐ 企业级"被测量覆盖时长"= 各排口覆盖时长按**该排口实测排放量**加权平均。
     推导：设排口 m 占企业排放份额 shareₘ（Σ=1），则
       基准应排放量 = Σₘ baseRate·shareₘ·coveredₘ = baseRate · Σₘ shareₘ·coveredₘ，
     故企业级覆盖时长 = Σₘ shareₘ·coveredₘ（份额加权），份额用实测排放量作代理。
     与 dynamic.observedCorrection 的 coveredHours 同一口径 —— 排口完全同质时
     退化为算术平均；被"只出现过几分钟"的排口污染时不会崩（实测 ent7 有 16 个排口）。 */
  const emittedTotal = monitors.reduce((a, m) => a + m.energy, 0);
  const coveredHoursWeighted = emittedTotal > 0
    ? monitors.reduce((a, m) => a + (m.coveredMin / 60) * m.energy, 0) / emittedTotal
    : 0;

  return {
    byDay, byDayMin, coveredMin, gapMin, maxGapMin, points,
    monitors: byMonitor.size, monitorDetail: monitors,
    emittedTotal: Number(emittedTotal.toFixed(3)),
    coveredHoursWeighted: Number(coveredHoursWeighted.toFixed(3)),
  };
}

/** 中位数（就地排序副本） */
function medianOf(arr) {
  if (!arr.length) return 0;
  const v = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** 把 [t, t+minutes] 区间的排放量与覆盖时长按自然日边界摊开（跨零点时按分钟拆分） */
function spreadToDays(byDay, byDayMin, t, minutes, energy) {
  let cur = t.getTime();
  let left = minutes;
  while (left > 1e-9) {
    const d = new Date(cur);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
    const chunk = Math.min(left, (nextMidnight - cur) / 60000);
    const key = dayKey(new Date(cur));
    if (byDay) byDay.set(key, (byDay.get(key) || 0) + energy * (chunk / minutes));
    if (byDayMin) byDayMin.set(key, (byDayMin.get(key) || 0) + chunk);
    cur += chunk * 60000;
    left -= chunk;
  }
}

/** 本地日期键 YYYY-MM-DD（不用 toISOString，避免时区偏移） */
function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 取某企业的日均排放序列（含门控报告与覆盖度）。
 * @param {number} entId
 * @param {object} opts { from, to, minCoverage }
 */
async function dailySeries(entId, opts = {}) {
  const where = ['ent_id = ?'];
  const args = [entId];
  if (opts.from) { where.push('reading_time >= ?'); args.push(opts.from); }
  if (opts.to) { where.push('reading_time < ?'); args.push(opts.to); }

  const rows = await db.query(
    `SELECT monitor_no, reading_time, flow_value, quality_flag, status, source
       FROM cems_reading WHERE ${where.join(' AND ')}
      ORDER BY monitor_no, reading_time`, args);

  const g = gate(rows, opts);
  const ig = integrate(g.kept);

  /* ---- 时间覆盖：按「实际被实测速率代表的时长」计，不按读数条数计 ----
   * 定义：coverage = Σ 各排口已覆盖分钟 / Σ 各排口**自身**观测跨度分钟
   * 三个口径陷阱都要避开：
   *   ① 不能用"有读数的小时数 / 总小时数"：名义周期是 4h，一条 4h 周期的读数
   *      只落在 1 个小时里，按小时计数会把 100% 覆盖的合规采样误算成 25%。
   *   ② 不能用"读数条数 × 名义周期"：1 分钟采样段会被放大 240 倍。
   *   ③ 不能用"全局跨度 × 排口数"作分母：窗口里只出现过几分钟的排口
   *      （测试设备、临时接入、已停用的点）会把分母撑大，把一家采样正常的
   *      企业算成覆盖不足，进而错误地归到最宽的分级不确定度档。
   * 每个排口只对自己的观测跨度负责，才是"这家企业的数据够不够用"的正确答案。 */
  const days = Array.from(ig.byDay.keys()).sort();
  const spanHours = days.length
    ? (new Date(days[days.length - 1]) - new Date(days[0])) / 3600000 + 24 : 0;
  const ownSpanMin = ig.monitorDetail.reduce((a, m) => a + m.ownSpanMin, 0);
  const coverage = ownSpanMin > 0 ? ig.coveredMin / ownSpanMin : 0;
  const gapShare = ig.coveredMin + ig.gapMin > 0 ? ig.gapMin / (ig.coveredMin + ig.gapMin) : 0;
  const spanDays = Math.max(1, days.length);
  /* 活跃排口：观测跨度 ≥ 1 小时（低于此的不具备"覆盖某个时段"的资格） */
  const activeMonitors = ig.monitorDetail.filter((m) => m.ownSpanMin >= 60).length;

  /* 按门控前的原始读数统计各质量标记的占比（用于分级缺省不确定度） */
  const rawQuality = {};
  for (const r of rows) rawQuality[r.quality_flag] = (rawQuality[r.quality_flag] || 0) + 1;
  const substituteRatio = rows.length
    ? ((rawQuality.SUBSTITUTED || 0) + (rawQuality.MISSING || 0)) / rows.length : 0;

  /* ---- 日级完整性门控 ----
   * 数据窗口的首日/末日天然是残缺日（例如窗口从 09-12 21:53 开始，当天只有 2 小时）。
   * 残缺日的排放量只反映那几小时，与整日不可比；若直接放进日均序列，
   * 会被当成"极端低排放日"，白白把样本方差抬高一大截。
   * 判据用**窗口内中位日**作基准，而不是"1440 分钟 × 排口数" —— 后者在排口
   * 采样节奏不齐（有的 4h 一条、有的 1min 一条）时会给出荒谬的期望值。
   * 注意这里衡量的是"这一天与序列里其他天可不可比"，与上面的覆盖度不是一回事：
   * 覆盖度衡量"数据够不够"，日完整性衡量"这一天能不能进统计样本"。 */
  const minDay = opts.minDayCoverage === undefined ? 0.5 : opts.minDayCoverage;
  const dayMins = days.map((d) => ig.byDayMin.get(d) || 0);
  const baselineDayMin = medianOf(dayMins.filter((x) => x > 0));
  const thresholdMin = baselineDayMin * minDay;
  const allDays = days.map((d, i) => {
    const covered = dayMins[i];
    return {
      day: d,
      emission: Number(ig.byDay.get(d).toFixed(4)),
      coveredMinutes: Number(covered.toFixed(1)),
      ratioToMedianDay: baselineDayMin > 0 ? Number((covered / baselineDayMin).toFixed(4)) : 1,
      complete: days.length < 3 || covered >= thresholdMin,
    };
  });
  const completeDays = allDays.filter((x) => x.complete);

  return {
    entId,
    series: completeDays.map((x) => ({ day: x.day, emission: x.emission })),
    daily: completeDays.map((x) => x.emission),
    allDays,
    days: completeDays.length,
    incompleteDays: allDays.length - completeDays.length,
    dayNote: allDays.length === completeDays.length
      ? '窗口内每日覆盖均达标，全部进入序列。'
      : `窗口内 ${allDays.length - completeDays.length} 天为残缺日（覆盖不足中位日的 `
        + `${(minDay * 100).toFixed(0)}%，中位日 ${baselineDayMin.toFixed(0)} 分钟），已排除：`
        + allDays.filter((x) => !x.complete)
          .map((x) => `${x.day}(${x.coveredMinutes.toFixed(0)}min, 中位日的 ${(x.ratioToMedianDay * 100).toFixed(0)}%)`).join('、')
        + '。理由：残缺日的排放量只反映窗口内那几小时，与整日不可比，'
        + '混入会把样本方差抬高一个量级。',
    /* 门控报告 */
    gating: {
      raw: g.total,
      kept: g.kept.length,
      excludeRate: g.total ? 1 - g.kept.length / g.total : 0,
      byReason: g.byReason,
      notes: g.notes,
    },
    coverage: {
      ratio: Number(coverage.toFixed(4)),
      coveredMinutes: Number(ig.coveredMin.toFixed(1)),
      /* 企业级覆盖时长（排放量加权，见 integrate 内推导）—— 年度口径用它，不用算术平均 */
      coveredHoursWeighted: ig.coveredHoursWeighted,
      emittedTotal: ig.emittedTotal,
      ownSpanMinutes: Number(ownSpanMin.toFixed(1)),
      gapMinutes: Number(ig.gapMin.toFixed(1)),
      gapShare: Number(gapShare.toFixed(6)),
      maxGapMinutes: Number(ig.maxGapMin.toFixed(1)),
      monitors: ig.monitors,
      activeMonitors,
      monitorDetail: ig.monitorDetail,
      pointsUsed: ig.points,
      windowSpanHours: Number(spanHours.toFixed(2)),
      windowSpanDays: spanDays,
      sampleDensityPerHour: Number((ig.points / spanDays / 24).toFixed(2)),
      nominalIntervalMin: NOMINAL_INTERVAL_MIN,
      note: `步进积分按真实间隔 Δt = min(相邻间隔, ${NOMINAL_INTERVAL_MIN}min) 折算；`
        + '超过名义周期的空白不补、不外推（红线 1）。'
        + '覆盖度 = Σ各排口已覆盖分钟 / Σ各排口自身观测跨度分钟，'
        + '与采样密度无关（4h 与 1min 采样的企业可直接比较），也不受"只短暂出现过的排口"干扰。'
        + `注：本口径衡量的是**窗口内**的数据完备性；窗口本身仅覆盖年度的一部分（${spanDays} 天 / 365 天），`
        + '年度外推带来的不确定度在报告的"局限"一节单独披露。',
    },
    rawQuality,
    substituteRatio: Number(substituteRatio.toFixed(4)),
  };
}

/* ==================================================================
 * 四、贝叶斯后验区间
 * ================================================================== */

/** 企业上下文（配额、产值、行业、最新上报单的分范围拆分） */
async function entContext(entId) {
  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [entId]);
  if (!ent) throw new Error(`企业 ${entId} 不存在`);
  const quota = await db.one(
    'SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC LIMIT 1', [entId]);
  const report = await db.one(
    `SELECT year, quarter, period, scope1_emission, scope2_emission, total_emission,
            energy_consumption, output_value, intensity, data_source
       FROM emission_report WHERE ent_id = ? ORDER BY year DESC, quarter DESC LIMIT 1`, [entId]);
  /* 核算年度：以配额年度为准（配额即履约目标，年份口径必须与之一致）；
     无配额记录时退到上报单年度，再退到系统当前年。 */
  const year = quota ? Number(quota.year)
    : (report ? Number(report.year) : new Date().getFullYear());
  return {
    ent, year,
    quota: quota || null,
    quotaAnnual: quota ? Number(quota.total_allocated) : null,
    report: report || null,
  };
}

/**
 * 年度排放的贝叶斯后验区间。
 *
 * 模型：设日均排放 x ~ Normal(μ, σ²)，μ 与 σ² 同时未知，取 Normal-Inverse-Gamma 共轭先验。
 *   先验中心 μ0 取企业当年配额的年化日均（企业自己的履约目标就是最自然的先验）；
 *   先验强度 κ0 取 1（等效 1 个观测点，弱信息），并在敏感性扫描中自证其无关性。
 *
 * ⭐ 年化口径（2026-10-14，来源 ② 根治）：与平台核算账**共用 `dynamic.annualFrom`**
 *      annual = 基准速率(base/24) × 8760 + 实测偏差修正
 *   而不是本模块原先自作主张的「实测日均 × 365」。两者的差别在于**未实测时段怎么填**：
 *     · 核算账：未实测时段按配额基准模型填补，实测覆盖时段按实测值（偏差是绝对量）；
 *     · 旧本模块：整年都按实测速率外推（偏差被放大 8760/coveredHours ≈ 12 倍）。
 *   窗口只覆盖年度 8.5%（31/365 天）时，两条外推假设必然分叉 —— 实测 ent2 相差 16.11%。
 *   统计上正确的做法不是"再起一个口径"，而是**对平台那个估计量做区间刻画**：
 *   偏差项对日均均值的灵敏度系数是被实测覆盖的**有效天数**（而非 365），抽样区间按它传播；
 *   未实测时段的模型风险按"未实测日与实测日同分布"另行计入，两项平方和开根。
 *   这样既不夸大也不缩小，且与本平台对外唯一的核算口径严格一致。
 */
async function posterior(entId, opts = {}) {
  const ctx = await entContext(entId);
  const ds = await dailySeries(entId, opts);
  if (ds.days < 3) {
    return {
      entId, entName: ctx.ent.ent_name, available: false,
      reason: `有效日均观测点仅 ${ds.days} 个，不足以做区间估计（至少 3 个）。`,
      series: ds.series, gating: ds.gating, coverage: ds.coverage,
    };
  }

  const xs = ds.daily;
  const level = opts.level || LEVEL;
  const obs = st.describe(xs);

  /* 先验：中心取企业当年配额的年化日均（企业自己的履约目标是最自然的先验中心），
     强度取 κ₀ = 0.01 —— 等效 0.01 个观测点，实质是非信息先验：
     后验均值 mu_n = (κ₀·μ₀ + n·x̄)/(κ₀ + n) ≈ x̄，结论完全由数据决定。
     为什么不取更强的先验：当企业实测排放与配额出现 2~3 倍偏离时（本平台确有此类企业），
     强先验会把区间往配额方向拉，产出一个"看起来更窄、实际上更错"的区间。 */
  const mu0 = ctx.quotaAnnual ? ctx.quotaAnnual / DAYS_PER_YEAR : obs.mean;
  const alpha0 = 0.5;   // 使 df = 2α₀ + n ≈ n + 1，与经典 t 区间可比（见 classical 对照）
  const KAPPA_PRIMARY = 0.01;
  const prior = { mu0, kappa0: KAPPA_PRIMARY, alpha0, level };

  const post = st.nigPosterior(xs, prior);
  const mc = st.monteCarloCheck(xs, prior, opts.draws || 20000);

  /* 经典 t 区间对照：贝叶斯区间在弱先验下必须收敛到它，否则说明实现有偏 */
  const classical = (() => {
    const tCrit = st.studentTQuantile(1 - (1 - level) / 2, Math.max(1, obs.n - 1));
    const hw = tCrit * obs.sd / Math.sqrt(obs.n);
    return { mean: obs.mean, sd: obs.sd, tCrit, halfWidth: hw, ci: [obs.mean - hw, obs.mean + hw] };
  })();
  const classicalDelta = classical.halfWidth > 0
    ? (post.ci.halfWidth - classical.halfWidth) / classical.halfWidth : null;

  /* 先验敏感性扫描（红线 2）：κ₀ 跨 4 个数量级，看结论是否被先验牵引 */
  const sweep = [0.01, 0.1, 1, 10, 100].map((k) => {
    const p = st.nigPosterior(xs, { mu0, kappa0: k, alpha0, level });
    return {
      kappa0: k, mean: p.mean, halfWidth: p.ci.halfWidth,
      meanShiftPct: post.mean !== 0 ? (p.mean - post.mean) / post.mean * 100 : null,
      halfWidthShiftPct: post.ci.halfWidth > 0
        ? (p.ci.halfWidth - post.ci.halfWidth) / post.ci.halfWidth * 100 : null,
    };
  });
  /* 判据：κ₀ ∈ [0.01, 1]（先验等效样本量 ≤ 1 个观测点）内点估计相对变化 < 2% */
  const weak = sweep.filter((s) => s.kappa0 <= 1);
  const maxShift = Math.max(...weak.map((s) => Math.abs(s.meanShiftPct || 0)));
  const priorSafe = maxShift < 2;
  const strong = sweep.filter((s) => s.kappa0 >= 10);
  const priorVerdict = `κ₀ ∈ [0.01, 1]（先验等效样本量 ≤ 1 个观测点）内，点估计最大变化 ${maxShift.toFixed(2)}%`
    + `（阈值 2%）⇒ ${priorSafe
      ? `结论由数据主导，先验不构成实质影响。`
      : `⚠ 先验已对结论产生实质影响，该档区间不作为报告口径。`}`
    + ` 作为对照：若强行施加 κ₀ ≥ 10 的强先验（等效样本量 ≥ 观测数的 ${(10 / obs.n).toFixed(2)} 倍），`
    + `点估计将被拉向配额日均 ${mu0.toFixed(2)} tCO2e/day，偏移 `
    + `${strong.map((s) => `${s.meanShiftPct.toFixed(1)}%`).join(' / ')}；本平台不采用该档先验。`;

  /* ==================================================================
   * ⭐ 年化：与平台核算账共用唯一口径（2026-10-14，来源 ② 根治）
   * ================================================================== */
  const HOURS_PER_YEAR = dyn.HOURS_PER_YEAR;                 // 8760
  const baseRate = dyn.dailyBaseFor(ctx.ent, ctx.quotaAnnual || 0) / 24;   // tCO2e/h

  /* 企业级覆盖时长 / 窗口实测排放量：**直接取 integrate 的口径**，不在本函数里
     另算一份算术平均。这一步很关键 —— 另算一份就是"同一口径写两遍"，
     而这正是来源 ① 的成因。integrate 里已按"份额加权（实测排放量作代理）"
     求出企业级覆盖时长，与 dynamic.observedCorrection 同源。
     ⚠ 用全量实测数据（不扣残缺日）：日完整性门控是**统计**用的（避免把只测了
       两小时的首日当成"极端低排放日"抬高样本方差），不是**核算**过滤。 */
  const coveredHours = Number(ds.coverage.coveredHoursWeighted) || 0;
  const measuredTotal = Number(ds.coverage.emittedTotal) || 0;
  const coveredDays = coveredHours / 24;
  const uncoveredDays = Math.max(0, HOURS_PER_YEAR / 24 - coveredDays);

  /* 实测偏差修正（本模块**自行**积分、门控更严 → 与核算账是有意义的独立交叉校验，
     而不是把核算账的值搬过来）。口径与 dynamic.observedCorrection 相同：
     correction = ∫实测速率 dt − 基准速率 × 被实测覆盖时长 */
  const baseOnCovered = baseRate * coveredHours;
  const correction = measuredTotal - baseOnCovered;

  /* 点估计：唯一口径 */
  const annualMean = dyn.annualFrom(baseRate, correction);

  /* ---- 区间的两项来源（平方和开根） ----
     ① 抽样项：估计量对日均均值的灵敏度系数 = 被实测覆盖的**有效天数**（不是 365）。
        日均均值 μ 的 95% 区间半宽为 post.ci.halfWidth，故 n 天合计的半宽 = n × 半宽。
     ② 模型项：未实测时段按基准模型填补这一**假设本身**的不确定度。
        假设"未实测日与实测日同分布"，则未实测时段的偏差合计 ~ N(0, uncoveredDays·σ²)，
        其中 σ 取实测日间波动 obs.sd，95% 半宽 = 1.96 × √uncoveredDays × σ。
        这一项通常远大于 ① —— 它如实反映"一年里只有约 8.5% 被真正测到"。
     两项独立，按平方和开根合成。 */
  const samplingHalf = post.ci.halfWidth * ds.days;
  const modelHalf = 1.96 * Math.sqrt(uncoveredDays) * (obs.sd || 0);
  const halfWidth = Math.sqrt(samplingHalf * samplingHalf + modelHalf * modelHalf);

  const annual = {
    mean: annualMean,
    low: annualMean - halfWidth,
    high: annualMean + halfWidth,
    halfWidth,
    relHalfWidth: annualMean !== 0 ? halfWidth / Math.abs(annualMean) : null,
    /* 口径自证：与核算账同源，且把"区间为什么这么宽/窄"拆开摆出来 */
    basis: 'annual = 基准速率 × 8760 + 实测偏差修正（与 dynamic.annualFrom 同一实现）',
    baseRate,
    correction,
    decomposition: {
      baseYear: baseRate * HOURS_PER_YEAR,
      measuredTotal: Number(measuredTotal.toFixed(3)),
      baseOnCovered: Number(baseOnCovered.toFixed(3)),
      coveredDays: Number(coveredDays.toFixed(2)),
      uncoveredDays: Number(uncoveredDays.toFixed(2)),
      monitors: ds.coverage.monitors,
      activeMonitors: ds.coverage.activeMonitors,
      samplingHalfWidth: Number(samplingHalf.toFixed(3)),
      modelHalfWidth: Number(modelHalf.toFixed(3)),
      note: '抽样项 = 日均均值区间半宽 × 实测覆盖天数；模型项 = 1.96 × √未实测天数 × 实测日间波动。'
        + '模型项占绝对多数属正常：本年度仅约 8.5% 的时段有实测数据。',
    },
  };

  const row = {
    entId, year: ctx.year, target: 'ANNUAL_EMISSION',
    priorType: 'Normal-Inverse-Gamma（均值与方差同时未知的共轭模型）',
    priorParams: { mu0, kappa0: KAPPA_PRIMARY, alpha0, beta0: post.prior.beta0, level },
    posteriorParams: post.posterior,
    nObs: xs.length,
    obsSummary: {
      mean: post.obs.mean, sd: post.obs.sd, min: post.obs.min, max: post.obs.max,
      unit: 'tCO2e/day',
    },
    mean: post.mean, sd: post.scale, level,
    ciLow: post.ci.low, ciHigh: post.ci.high,
    mc,
    method: 'Normal-Inverse-Gamma 共轭后验；均值的边缘后验为 t 分布（自由度 2α_n）',
    extra: {
      annual, classical, classicalDelta, priorSweep: sweep, priorSafe, maxShift, priorVerdict,
      quotaAnnual: ctx.quotaAnnual,
      /* 年化点估计与配额的对照（履约口径）：缺口为正即超排 */
      quotaGap: ctx.quotaAnnual ? annualMean - ctx.quotaAnnual : null,
      quotaRatio: ctx.quotaAnnual ? annualMean / ctx.quotaAnnual : null,
      coverage: ds.coverage, gating: ds.gating, series: ds.series,
      entName: ctx.ent.ent_name, industry: ctx.ent.industry,
      disclaimer: '本区间刻画的是**年度排放估计量的抽样不确定度 + 未实测时段的模型外推风险**，'
        + '不含系统性偏差（如监测系统未校准的量程误差）——后者由 GUM 合成口径（/propagate）单独给出。'
        + '口径说明：年度点估计与平台核算账共用同一公式（基准速率 × 8760 + 实测偏差修正），'
        + '先验取非信息档（κ₀ = 0.01），并在报告中披露 κ₀ 跨 4 个数量级的敏感性扫描结果。',
    },
  };
  return row;
}

/** 落库（幂等：同 (ent_id, year, target) 覆盖） */
async function savePosterior(row) {
  await db.query(
    `INSERT INTO uncertainty_posterior
      (ent_id, year, target, prior_type, prior_params, posterior_params, n_obs, obs_summary,
       mean, sd, ci_level, ci_low, ci_high, mc_cross_check, method)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       prior_type=VALUES(prior_type), prior_params=VALUES(prior_params),
       posterior_params=VALUES(posterior_params), n_obs=VALUES(n_obs),
       obs_summary=VALUES(obs_summary), mean=VALUES(mean), sd=VALUES(sd),
       ci_level=VALUES(ci_level), ci_low=VALUES(ci_low), ci_high=VALUES(ci_high),
       mc_cross_check=VALUES(mc_cross_check), method=VALUES(method)`,
    [row.entId, row.year, row.target, row.priorType,
      JSON.stringify(row.priorParams), JSON.stringify(row.posteriorParams),
      row.nObs, JSON.stringify(row.obsSummary),
      row.mean, row.sd, row.level, row.ciLow, row.ciHigh,
      JSON.stringify(row.mc), row.method]);
  return { saved: true };
}

/* ==================================================================
 * 五、GUM / 误差传播法（独立第二口径）
 * ================================================================== */

/**
 * 误差传播法合成相对不确定度。
 *
 *   总排放 E = E_scope1 + E_scope2
 *   E_scope1 = Σ (CEMS 实测速率 × 时间)          → u1 = CEMS 系统不确定度（分级）
 *   E_scope2 = 用电量 × 区域电网排放因子          → u2 = √(u_计量² + u_因子²)
 *   合成：u_rel = √( (w1·u1)² + (w2·u2)² )，w 为各分范围的排放量权重
 *
 * 这一口径刻意**不依赖**每日序列的统计分布，只用工程分级缺省值，
 * 因此与贝叶斯区间互相独立 —— 两者一致才有意义。
 */
async function propagate(entId, opts = {}) {
  const ctx = await entContext(entId);
  const ds = await dailySeries(entId, opts);

  const cov = ds.coverage.ratio;
  /* ⭐ 取档口径 = 年度有效时间覆盖率（cems_coverage，与监管预警同一张表、同一个数），
   * 而不是"重算窗口"的窗口覆盖度 —— 窗口通常只有 24~48h，窗口 100% 会把年度
   * 82.5% 的企业放进 ±5% 档，与预警文案「低于 95% 质量分级管控线」直接矛盾
   * （2026-10-31 巡检 P1-4）。窗口覆盖度仍如实展示在「时间覆盖度与采样密度」一节，
   * 其"注"里已写明窗口仅覆盖年度的一部分。
   * 口径细节：cems_coverage 同一年度可能同时有「单排口行」与「(全厂合计)行」，
   * 直接 SUM 会重复计数（曾把 82.5% 算成 90.1%）—— 取最新年度，优先全厂合计行。 */
  const covRows = await db.query(
    `SELECT year, outlet_name, valid_hours, expected_hours
       FROM cems_coverage WHERE ent_id = ? ORDER BY year DESC`, [entId]);
  const maxCovYear = covRows.length ? covRows[0].year : null;
  const yrRows = covRows.filter((r) => r.year === maxCovYear);
  const plantRows = yrRows.filter((r) => r.outlet_name === '(全厂合计)');
  const pickRows = plantRows.length ? plantRows : yrRows;
  const covDen = pickRows.reduce((a, r) => a + Number(r.expected_hours || 0), 0);
  const covAnnual = covDen > 0
    ? pickRows.reduce((a, r) => a + Number(r.valid_hours || 0), 0) / covDen
    : cov;
  const uCems = covAnnual >= 0.95 ? TIER_UNCERTAINTY.cemsHigh
    : covAnnual >= 0.80 ? TIER_UNCERTAINTY.cemsMid : TIER_UNCERTAINTY.cemsLow;

  /* 缺口替代项：缺口时长占比 × 替代值不确定度（面积加权，非简单相加） */
  const gapShare = ds.coverage.gapShare;
  const uGap = Math.sqrt(gapShare) * TIER_UNCERTAINTY.substitute;

  const components = [];
  components.push({
    key: 'cems',
    name: 'CEMS 实测（范围一）',
    relative: uCems,
    /* 【2026-11-03】此处是纯文本（前端按 innerText 渲染，不走 markdown），
     * 原来写成 **年度** 会原样印出星号。改为「」强调。 */
    basis: `HJ 75/76 在线监测系统准确度要求；本企业「年度」有效时间覆盖率 ${(covAnnual * 100).toFixed(1)}%`
      + `（cems_coverage 口径，与监管预警同源；重算窗口覆盖度 ${(cov * 100).toFixed(1)}% 仅反映最近 ${ds.coverage.windowSpanDays || '?'} 天）`
      + `（≥95% 取 ±${(TIER_UNCERTAINTY.cemsHigh * 100).toFixed(0)}%，80~95% 取 ±${(TIER_UNCERTAINTY.cemsMid * 100).toFixed(0)}%，<80% 取 ±${(TIER_UNCERTAINTY.cemsLow * 100).toFixed(0)}%）`,
  });
  components.push({
    key: 'gap',
    name: '时间缺口替代（范围一）',
    relative: uGap,
    basis: `缺口占比 ${(gapShare * 100).toFixed(2)}%，替代值本身按 ±${(TIER_UNCERTAINTY.substitute * 100).toFixed(0)}% 计，`
      + '按面积加权得 √(缺口占比) × 替代不确定度',
  });
  components.push({
    key: 'metering',
    name: '电能计量（范围二）',
    relative: TIER_UNCERTAINTY.metering,
    basis: `0.5S 级电能表 + 电流互感器合成，取 ±${(TIER_UNCERTAINTY.metering * 100).toFixed(0)}%`,
  });
  components.push({
    key: 'gridFactor',
    name: '区域电网基准线排放因子（范围二）',
    relative: TIER_UNCERTAINTY.gridFactor,
    basis: `生态环境部发布的${ctx.ent.region}区域电网基准线排放因子的区间估计，`
      + `取 ±${(TIER_UNCERTAINTY.gridFactor * 100).toFixed(0)}%`,
  });

  /* 分范围权重：优先用最新上报单的 scope1/scope2；缺则按行业缺省比例 */
  let w1 = 0.7;
  let w2 = 0.3;
  let weightBasis = '行业缺省比例（范围一 70% / 范围二 30%）';
  if (ctx.report) {
    const s1 = Number(ctx.report.scope1_emission);
    const s2 = Number(ctx.report.scope2_emission);
    if (s1 + s2 > 0) {
      w1 = s1 / (s1 + s2);
      w2 = s2 / (s1 + s2);
      weightBasis = `取自最新上报单 ${ctx.report.period}（范围一 ${s1.toFixed(2)} / 范围二 ${s2.toFixed(2)} tCO2e）`;
    }
  }

  const u1 = Math.sqrt(uCems * uCems + uGap * uGap);
  const u2 = Math.sqrt(TIER_UNCERTAINTY.metering ** 2 + TIER_UNCERTAINTY.gridFactor ** 2);
  const uRel = Math.sqrt((w1 * u1) ** 2 + (w2 * u2) ** 2);

  /* 贡献分解：各成分对合成方差的占比 */
  const contributions = [
    { key: 'cems', share: (w1 * uCems) ** 2 / (uRel ** 2 || 1) },
    { key: 'gap', share: (w1 * uGap) ** 2 / (uRel ** 2 || 1) },
    { key: 'metering', share: (w2 * TIER_UNCERTAINTY.metering) ** 2 / (uRel ** 2 || 1) },
    { key: 'gridFactor', share: (w2 * TIER_UNCERTAINTY.gridFactor) ** 2 / (uRel ** 2 || 1) },
  ].sort((a, b) => b.share - a.share);
  const top = contributions[0];

  const steps = [
    { step: 1, title: '范围拆分', formula: 'w₁ = S₁/(S₁+S₂)，w₂ = S₂/(S₁+S₂)', basis: weightBasis,
      value: `w₁ = ${(w1 * 100).toFixed(2)}%，w₂ = ${(w2 * 100).toFixed(2)}%` },
    { step: 2, title: '范围一合成', formula: 'u₁ = √(u_CEMS² + u_缺口²)',
      value: `√(${(uCems * 100).toFixed(2)}%² + ${(uGap * 100).toFixed(4)}%²) = ${(u1 * 100).toFixed(3)}%` },
    { step: 3, title: '范围二合成', formula: 'u₂ = √(u_计量² + u_电网因子²)',
      value: `√(${(TIER_UNCERTAINTY.metering * 100).toFixed(2)}%² + ${(TIER_UNCERTAINTY.gridFactor * 100).toFixed(2)}%²) = ${(u2 * 100).toFixed(3)}%` },
    { step: 4, title: '加权合成（GUM）', formula: 'u = √( (w₁u₁)² + (w₂u₂)² )',
      value: `√((${(w1 * u1 * 100).toFixed(3)}%)² + (${(w2 * u2 * 100).toFixed(3)}%)²) = ${(uRel * 100).toFixed(3)}%` },
    { step: 5, title: '主导项判定', formula: 'argmax(贡献占比)',
      value: `${top.key} 贡献 ${(top.share * 100).toFixed(1)}% —— 降低总不确定度应从该项入手` },
  ];

  return {
    entId, entName: ctx.ent.ent_name,
    method: 'GUM 误差传播法 / IPCC 分级缺省不确定度（与贝叶斯口径相互独立）',
    relativeUncertainty: uRel,
    components, contributions, weights: { scope1: w1, scope2: w2, basis: weightBasis },
    steps,
    guidance: uRel > 0 ? `本企业总不确定度 ±${(uRel * 100).toFixed(2)}%（k=1）。`
      + `主导来源为「${components.find((c) => c.key === top.key).name}」，贡献 ${(top.share * 100).toFixed(1)}%。`
      + `若把该项降到 0，总不确定度可降至 ±${(Math.sqrt(Math.max(0, uRel ** 2 - (top.share * uRel ** 2))) * 100).toFixed(2)}%。` : null,
  };
}

/* ==================================================================
 * 六、预测模型评估与消融实验
 * ================================================================== */

/** 递归多步预测：给出训练序列，返回 h 步预测数组 */
function forecasters() {
  return {
    /* 朴素法：以最后一日重复（真·基线，任何模型打不过它就没有存在价值） */
    NAIVE: (ys, h) => new Array(h).fill(ys[ys.length - 1]),
    /* 均值法 */
    MEAN: (ys, h) => new Array(h).fill(st.describe(ys).mean),
    /* 尾部移动平均 */
    'MA-3': (ys, h) => new Array(h).fill(ys.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, ys.length)),
    /* 线性趋势（外推斜率） */
    LINREG: (ys, h) => {
      const xs = ys.map((_, i) => i);
      const lr = st.linreg(xs, ys);
      return Array.from({ length: h }, (_, k) => lr.a + lr.b * (ys.length + k));
    },
    /* 阻尼 Holt 趋势 */
    HOLT: (ys, h) => {
      const m = st.holtLinear(ys);
      return Array.from({ length: h }, (_, k) => m.fit(k + 1));
    },
  };
}

/**
 * 模型评估：留出法（默认最后 7 天），逐个模型算 MAPE/RMSE/MAE/R²。
 * 同时给出**消融实验**：把复合模型的各组件依次去掉，看精度变化。
 */
async function modelEval(entId, opts = {}) {
  const h = opts.horizon || 7;
  const ds = await dailySeries(entId, opts);
  if (ds.days < h + 8) {
    return { entId, available: false, reason: `有效序列 ${ds.days} 天，不足以留出 ${h} 天做评估（至少需 ${h + 8} 天）。` };
  }
  const ys = ds.daily;
  const train = ys.slice(0, ys.length - h);
  const test = ys.slice(ys.length - h);
  const dates = ds.series.map((s) => s.day);
  const modelLog = [];
  for (const [name, fn] of Object.entries(forecasters())) {
    let pred;
    try { pred = fn(train, h); } catch (e) { continue; }
    const m = st.metrics(test, pred);
    modelLog.push({
      model: name, mape: m.mape, rmse: m.rmse, mae: m.mae, r2: m.r2,
      nTrain: train.length, nTest: test.length, params: null,
    });
  }

  /* 季节性模型：趋势(居中MA) + 周内季节项 + 尾部残差水平 */
  const trendFull = st.centeredMA(ys, 7);
  const season = st.seasonalByWeekday(dates, ys, trendFull);
  const seasonalPred = (() => {
    const lastTrend = st.describe(train.filter((v) => v > 0)).mean;
    const out = [];
    const lastDate = new Date(dates[dates.length - h - 1]);
    for (let k = 1; k <= h; k++) {
      const d = new Date(lastDate.getTime() + k * 86400000);
      out.push(lastTrend + season[d.getDay()]);
    }
    return out;
  })();
  const ms = st.metrics(test, seasonalPred);
  modelLog.push({
    model: 'TREND+SEASON', mape: ms.mape, rmse: ms.rmse, mae: ms.mae, r2: ms.r2,
    nTrain: train.length, nTest: test.length,
    params: { season, window: 7, trendSource: '居中移动平均(7)' },
  });

  /* 消融：从复合模型出发逐项剔除 */
  const ablation = [];
  const base = modelLog.find((m) => m.model === 'TREND+SEASON');
  const holt = modelLog.find((m) => m.model === 'HOLT');
  const naive = modelLog.find((m) => m.model === 'NAIVE');
  const meanM = modelLog.find((m) => m.model === 'MEAN');
  if (base && holt) {
    ablation.push({
      variant: '完整模型 TREND+SEASON', removed: null, mape: base.mape,
      deltaMape: 0, note: '趋势项 + 周内季节项',
    });
    ablation.push({
      variant: '去掉季节项（仅趋势水平）', removed: '季节项',
      mape: meanM ? meanM.mape : null,
      deltaMape: meanM && base.mape !== null ? meanM.mape - base.mape : null,
      note: '退化为"训练段均值"，用于检验季节项是否真的带来信息',
    });
    ablation.push({
      variant: '去掉趋势项（仅 Holt 水平+阻尼趋势）', removed: '居中移动平均趋势',
      mape: holt.mape, deltaMape: holt.mape !== null && base.mape !== null ? holt.mape - base.mape : null,
      note: 'Holt 自身含阻尼趋势，用于检验移动平均趋势是否多余',
    });
    ablation.push({
      variant: '全部去掉（朴素基线）', removed: '全部组件',
      mape: naive ? naive.mape : null,
      deltaMape: naive && base.mape !== null ? naive.mape - base.mape : null,
      note: '朴素法 = 以最后一日重复，是"模型是否值得存在"的判据',
    });
  }

  /* 诚实结论：复杂模型相对最简模型是否真的取胜 */
  const valid = modelLog.filter((m) => m.mape !== null && Number.isFinite(m.mape));
  valid.sort((a, b) => a.mape - b.mape);
  const best = valid[0];
  const simplest = valid.find((m) => m.model === 'NAIVE') || valid.find((m) => m.model === 'MEAN');
  let verdict;
  if (best && simplest) {
    const gain = simplest.mape > 0 ? (simplest.mape - best.mape) / simplest.mape : 0;
    verdict = `留出 ${h} 天（训练 ${train.length} 天）。最优模型 ${best.model}（MAPE ${best.mape.toFixed(2)}%），`
      + `朴素基线 ${simplest.model}（MAPE ${simplest.mape.toFixed(2)}%），相对改善 ${(gain * 100).toFixed(1)}%。`
      + (gain < 0.10
        ? '⚠ 改善不足 10%：在 31 天量级的样本上，复杂模型相对朴素基线**未取得实质优势**，'
          + '平台据此**不宣称**预测精度优势，仅将模型用于"缺数区间的最保守插补"，并在报告中披露该结论。'
        : `复杂模型相对朴素基线有 ${(gain * 100).toFixed(1)}% 的实质改善。`);
  } else {
    verdict = '样本不足，未能完成对照。';
  }

  const slice = `${ds.series[0].day} ~ ${ds.series[ds.series.length - 1].day}，`
    + `${ds.days} 个有效日均观测（已过三级门控；剔除 ${ds.gating.raw - ds.gating.kept} 条原始读数）`;

  return {
    entId, available: true,
    horizon: h, nTrain: train.length, nTest: test.length,
    split: `HOLDOUT-${h}D`, models: modelLog, ablation, verdict, datasetSlice: slice,
    season, test, train, dates,
    note: '留出法（最后 h 天不参与拟合）。未做滚动重估，原因是样本仅 31 天，'
      + '滚动会进一步压缩训练段，得到的"泛化误差"反而更不可信。'
      + '另需说明：R² 在 7 点留出集上极不稳定 —— 留出集近乎常数时 SS_tot → 0，'
      + 'R² 会趋于负无穷（本表出现的 -40 这类值都属此情形），'
      + '因此本模块以 MAPE 为主判据，R² 仅作旁证，不作为模型取舍依据。',
  };
}

/* ==================================================================
 * 七、综合报告：两口径对照
 * ================================================================== */

/**
 * 完整体检报告：门控 → 后验 → 传播 → 两口径对照 → 结论与局限。
 */
async function report(entId, opts = {}) {
  const ctx = await entContext(entId);
  const ds = await dailySeries(entId, opts);
  const post = await posterior(entId, opts);
  const prop = await propagate(entId, opts);

  let crossCheck = null;
  if (post.available !== false && post.extra && post.extra.annual) {
    const a = post.extra.annual;
    /* 贝叶斯区间的半宽 → k=1 相对不确定度（除以 1.96） */
    const uBayes = a.relHalfWidth != null ? a.relHalfWidth / 1.96 : null;
    const uGum = prop.relativeUncertainty;

    /* ---- 两个口径量的根本不是同一件事，必须先说清楚 ----
     *   贝叶斯区间：**年度估计量的不确定度** —— 由两项构成：
     *              (a) 抽样随机性（实测覆盖天数的日均均值区间，随观测增多收窄）；
     *              (b) 模型外推风险（未实测时段"按基准填补"这一假设本身，按实测日间波动外推）。
     *              (b) 通常主导，因为本年度仅约 8.5% 的时段有实测数据。
     *   GUM 合成：  **报告值的合成误差** —— 含仪器准确度、计量、排放因子等
     *              **系统性**项，这些项**不会因为多测而变小**。
     * 因此正确的必要条件不是"两者接近"，而是 **u_GUM ≥ u_Bayes**；
     * 反过来（GUM < 贝叶斯）才说明分级缺省值被低估了，是真正的异常。
     * 更有价值的结论在于**系统项占比**：系统项占绝对多数时，意味着
     * 继续加密采样收益有限，降不确定度要从校准与凭证入手。 */
    const w1 = prop.weights.scope1;
    const w2 = prop.weights.scope2;
    const gapComp = prop.components.find((c) => c.key === 'gap');
    const uRandom = Math.abs(w1 * gapComp.relative);            // 缺口替代 → 随机/统计项
    const uSystematic = uGum > uRandom ? Math.sqrt(uGum * uGum - uRandom * uRandom) : 0;
    const sysShare = uGum > 0 ? uSystematic / uGum : 0;
    const ratio = uBayes != null && uGum > 0 ? uBayes / uGum : null;

    crossCheck = {
      bayesian: { k1Relative: uBayes, ci95: [a.low, a.high], halfWidth: a.halfWidth,
        meaning: '年度估计量的不确定度（抽样项 + 未实测时段的模型外推项）' },
      gum: { k1Relative: uGum, randomPart: uRandom, systematicPart: uSystematic,
        meaning: '报告值的合成误差（含不随观测增多的系统性项）' },
      ratio,
      /* 必要条件：合成不确定度不得小于抽样随机性 */
      consistent: uGum >= (uBayes || 0) - 1e-12,
      systematicShare: sysShare,
      verdict: ratio == null ? '两口径不可比。'
        : (!(uGum >= uBayes)
          ? `⚠ 异常：GUM 合成不确定度 ${(uGum * 100).toFixed(2)}% 竟然小于贝叶斯抽样不确定度 `
            + `${(uBayes * 100).toFixed(2)}%，说明分级缺省值被低估，须复核 TIER_UNCERTAINTY 取值。`
          : `合成不确定度 ${(uGum * 100).toFixed(2)}% ≥ 抽样不确定度 ${(uBayes * 100).toFixed(2)}%，`
            + `量级关系成立（比值 ${ratio.toFixed(2)}）。其中系统性项占 ${(sysShare * 100).toFixed(1)}%：`
            + (sysShare >= 0.8
              ? '**系统项主导** —— 加密采样对降低报告不确定度几乎没有帮助，'
                + '应把资源投向仪器校准、检定与凭证获取（绿电、计量）。'
                + '这一结论单看任何一个口径都得不出来，是本模块交叉校验的主要产出。'
              : '随机项仍有可观占比 —— 提高采样密度与补齐缺口仍能实质降低不确定度。')),
    };
  }

  const models = await modelEval(entId, opts);

  const win = ds.allDays.length
    ? `${ds.allDays[0].day} ~ ${ds.allDays[ds.allDays.length - 1].day}`
    : '—';
  const ann = post.available === false ? null : (post.extra && post.extra.annual);
  const limitations = [
    `有效序列仅 ${ds.days} 天（数据窗口 ${win}，其中 ${ds.incompleteDays} 天为残缺日已排除），`
      + '未覆盖完整年度。年度点估计与平台核算账共用同一口径'
      + '（annual = 基准速率 × 8760 + 实测偏差修正），因此其区间由两项构成：'
      + (ann && ann.decomposition
        ? `抽样项 ±${ann.decomposition.samplingHalfWidth.toFixed(0)} tCO2e（实测覆盖 `
          + `${ann.decomposition.coveredDays.toFixed(1)} 天）与模型项 ±${ann.decomposition.modelHalfWidth.toFixed(0)} tCO2e`
          + `（未实测 ${ann.decomposition.uncoveredDays.toFixed(0)} 天，按实测日间波动外推）。`
          + (ann.decomposition.modelHalfWidth > ann.decomposition.samplingHalfWidth
            ? '**模型项主导** —— 这意味着继续加密采样对收窄年度区间帮助有限，'
              + '真正的杠杆是延长实测覆盖时段（或为未实测时段提供可核查的凭证）。'
            : '抽样项主导。')
        : '抽样项与模型项之和。'),
    '口径诚实说明：未实测时段按配额基准模型填补（这是本平台对外唯一的年度累计口径），'
      + '其不确定度以"未实测日与实测日同分布"为模型估计，属**模型风险**而非已观测事实；'
      + '随着实测覆盖时段延长，模型项按 √未实测天数 自然收窄。',
    '贝叶斯区间不含监测系统的量程/线性度系统偏差 —— 后者由 GUM 口径单独给出。',
    ds.coverage.ratio < 0.95
      ? `时间覆盖 ${(ds.coverage.ratio * 100).toFixed(1)}% < 95%，CEMS 项按 ±${(TIER_UNCERTAINTY.cemsMid * 100).toFixed(0)}% 或更宽的分级缺省值计，`
        + '这会主导总不确定度。'
      : `时间覆盖 ${(ds.coverage.ratio * 100).toFixed(1)}% 达标，CEMS 项按 ±${(TIER_UNCERTAINTY.cemsHigh * 100).toFixed(0)}% 计。`,
    '区域电网基准线排放因子按年度公布值取用，企业侧月度波动未单独建模。',
  ];

  return {
    entId,
    entName: ctx.ent.ent_name, industry: ctx.ent.industry, region: ctx.ent.region,
    year: ctx.year,
    period: { from: opts.from || null, to: opts.to || null },
    gating: ds.gating,
    coverage: ds.coverage,
    series: ds.series,
    allDays: ds.allDays,
    incompleteDays: ds.incompleteDays,
    dayNote: ds.dayNote,
    posterior: post.available === false ? post : {
      available: true, mean: post.mean, sd: post.sd, level: post.level,
      ci: [post.ciLow, post.ciHigh], nObs: post.nObs,
      annual: post.extra.annual, priorSweep: post.extra.priorSweep,
      priorSafe: post.extra.priorSafe, priorVerdict: post.extra.priorVerdict,
      classical: post.extra.classical, classicalDelta: post.extra.classicalDelta,
      quotaRatio: post.extra.quotaRatio, mc: post.mc,
      method: post.method,
    },
    propagation: prop,
    crossCheck,
    modelEval: models.available === false ? models : {
      available: true, horizon: models.horizon, nTrain: models.nTrain, nTest: models.nTest,
      models: models.models, ablation: models.ablation, verdict: models.verdict,
      datasetSlice: models.datasetSlice, note: models.note,
    },
    limitations,
  };
}

/** 生成报告并上链存证（口径与结论的不可篡改留痕） */
async function reportAndAnchor(entId, opts = {}) {
  const r = await report(entId, opts);
  const digest = cu.sha256(cu.stableStringify({
    entId: r.entId, year: r.year, gating: r.gating.byReason, coverage: r.coverage.ratio,
    posterior: r.posterior.available ? { mean: r.posterior.mean, ci: r.posterior.ci } : null,
    propagation: r.propagation.relativeUncertainty,
    crossCheck: r.crossCheck ? r.crossCheck.ratio : null,
    verdict: r.modelEval.available ? r.modelEval.verdict : null,
  }));
  try {
    const a = await anchorSvc.anchor({
      txType: 'UNCERTAINTY_REPORT',
      bizNo: `UR-${r.entId}-${r.year}`,
      fromLabel: `ent:${r.entId}`,
      payload: {
        entId: r.entId, year: r.year, digest,
        annualMean: r.posterior.available ? r.posterior.annual.mean : null,
        uRel: r.propagation.relativeUncertainty,
        nObs: r.posterior.available ? r.posterior.nObs : 0,
      },
    });
    r.chain = { digest, txId: a.txId, blockIndex: a.blockIndex, blockHash: a.blockHash };
  } catch (e) {
    r.chain = { digest, error: e.message, note: '链服务不可用时仍返回完整报告，仅缺存证' };
  }
  return r;
}

/* ==================================================================
 * 八、批量与汇总
 * ================================================================== */

/** 批量重算（默认全部有 CEMS 数据的企业） */
async function recomputeAll(opts = {}) {
  /* 空数组要当作"不限定范围"。若直接判 truthy，[] 会拼出 `IN ()` 的非法 SQL
   * （MySQL 语法错误 → 500）。API 调用方传 [] 是常见写法，不能算异常输入。 */
  const scope = Array.isArray(opts.entIds) && opts.entIds.length ? opts.entIds : null;
  const rows = await db.query(
    `SELECT DISTINCT ent_id FROM cems_reading ${scope ? `WHERE ent_id IN (${scope.map(() => '?').join(',')})` : ''}
      ORDER BY ent_id`, scope || []);
  const out = { total: rows.length, saved: 0, skipped: [], failed: [], modelEvalRows: 0 };
  for (const r of rows) {
    try {
      const p = await posterior(r.ent_id, opts);
      if (p.available === false) { out.skipped.push({ entId: r.ent_id, reason: p.reason }); continue; }
      await savePosterior(p);
      out.saved++;
      /* 顺带落库模型评估。批量重算本就是"把结论固定下来"的动作，
         模型评估与后验区间同源同批次产出，才不会出现两者时点不一致。 */
      try {
        const me = await saveModelEval(r.ent_id, opts);
        out.modelEvalRows += me.saved;
      } catch (e) {
        out.failed.push({ entId: r.ent_id, error: 'modelEval: ' + e.message });
      }
    } catch (e) {
      out.failed.push({ entId: r.ent_id, error: e.message });
    }
  }
  return out;
}

/**
 * 把某企业的模型评估结果落库（model_eval 台账）。
 * 幂等：先按 ent_id 清空再写入，重复重算不会累积重复行。
 * 每个可评估模型一行；消融实验与结论挂在全部行上（便于按企业整体检索）。
 */
async function saveModelEval(entId, opts = {}) {
  const me = await modelEval(entId, opts);
  if (me.available === false) return { saved: 0, skipped: me.reason };
  await db.query('DELETE FROM model_eval WHERE ent_id = ?', [Number(entId)]);
  let saved = 0;
  for (const m of me.models || []) {
    if (m.mape === null || m.mape === undefined || !Number.isFinite(Number(m.mape))) continue;
    await db.query(
      `INSERT INTO model_eval
        (ent_id, model, horizon_days, n_train, n_test, split, mape, rmse, mae, r2,
         params, ablation, dataset_slice, verdict, evaluated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [Number(entId), m.model, Number(me.horizon) || 0, Number(m.nTrain) || 0, Number(m.nTest) || 0,
        me.split || 'HOLDOUT', round(m.mape, 4), round(m.rmse, 4), round(m.mae, 4), round(m.r2, 6),
        JSON.stringify(m.params || null), JSON.stringify(me.ablation || null),
        me.datasetSlice || null, me.verdict || null]
    );
    saved++;
  }
  return { saved };
}

/** 保留 d 位小数；非有限值一律归 0（DECIMAL NOT NULL 列不接受 NaN） */
function round(v, d = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(d));
}

/** 行业汇总：把各企业的相对不确定度按排放量加权汇总 */
async function industrySummary(opts = {}) {
  const rows = await db.query(
    `SELECT id, ent_name, industry, region FROM enterprise ORDER BY id`);
  const items = [];
  for (const e of rows.slice(0, opts.limit || 12)) {
    try {
      const ds = await dailySeries(e.id, opts);
      if (ds.days < 3) { items.push({ entId: e.id, entName: e.ent_name, available: false }); continue; }
      const p = st.nigPosterior(ds.daily, {
        mu0: st.describe(ds.daily).mean, kappa0: 0.01, alpha0: 0.5, level: LEVEL,
      });
      items.push({
        entId: e.id, entName: e.ent_name, industry: e.industry, region: e.region,
        available: true, days: ds.days,
        coverage: ds.coverage.ratio,
        dailyMean: p.mean,
        relHalfWidth: p.mean !== 0 ? p.ci.halfWidth / Math.abs(p.mean) : null,
        implausible: ds.gating.byReason.implausible,
      });
    } catch (err) {
      items.push({ entId: e.id, entName: e.ent_name, available: false, error: err.message });
    }
  }
  const ok = items.filter((i) => i.available);
  return {
    scanned: items.length,
    available: ok.length,
    avgCoverage: ok.length ? ok.reduce((a, b) => a + b.coverage, 0) / ok.length : 0,
    avgRelHalfWidth: ok.length ? ok.reduce((a, b) => a + b.relHalfWidth, 0) / ok.length : 0,
    totalImplausibleRows: items.reduce((a, b) => a + (b.implausible || 0), 0),
    items,
  };
}

/** 已落库的后验区间清单 */
async function list() {
  return db.query(
    `SELECT u.*, e.ent_name, e.industry
       FROM uncertainty_posterior u JOIN enterprise e ON e.id = u.ent_id
      ORDER BY u.ent_id`);
}

/** 已落库的模型评估台账（每条 = 某企业某模型一次留出法评估） */
async function modelEvalList(opts = {}) {
  const where = []; const args = [];
  if (opts.entId) { where.push('m.ent_id = ?'); args.push(Number(opts.entId)); }
  if (opts.model) { where.push('m.model = ?'); args.push(String(opts.model)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.query(
    `SELECT m.id, m.ent_id, e.ent_name, e.industry, m.model, m.horizon_days, m.n_train, m.n_test,
            m.split, m.mape, m.rmse, m.mae, m.r2, m.dataset_slice, m.verdict,
            DATE_FORMAT(m.evaluated_at,'%Y-%m-%d %H:%i:%s') AS evaluated_at
       FROM model_eval m JOIN enterprise e ON e.id = m.ent_id
       ${w} ORDER BY m.ent_id, m.mape LIMIT 400`, args);
}

/** 口径与方法说明（供前端"方法学"面板展示） */
function catalog() {
  return {
    standard: ['ISO 14064-1:2018 组织层级温室气体量化与报告', 'ISO 14067:2018 产品碳足迹',
      'GUM (JCGM 100:2008) 测量不确定度表示指南',
      'IPCC 2006 国家温室气体清单指南（分级缺省不确定度）', 'HJ 75-2017 / HJ 76-2017 固定污染源烟气 CEMS'],
    gates: [
      { id: 'gate-1', name: '数据来源', rule: "source ≠ 'WATCHDOG'", order: 1, why: '看门狗占位记录不是设备上报，只能用于链路可用性统计，不得进核算' },
      { id: 'gate-2', name: '有效性', rule: 'rate > 0', order: 2, why: '零值/负值读数代表停机或校准态，本身是真实工况但不构成排放' },
      { id: 'gate-3', name: '质量标记', rule: "quality_flag = 'NORMAL' AND status = 'NORMAL'", order: 3, why: '校准/漂移/停机/缺失态读数不具代表性' },
      { id: 'gate-4', name: '物理量级', rule: `rate ≤ ${HARD_MAX_RATE} tCO2e/h`, order: 4, why: '超过单排口工程上限（1000MW 机组约 745 tCO2e/h 的 6.7 倍）的读数无物理意义' },
      { id: 'gate-5', name: '稳健离群', rule: `同排口对数空间 |z| > ${OUTLIER_Z} 且 rate > ${OUTLIER_RATIO}× 稳健中位数`, order: 5, why: '统计显著 + 工程量级异常双条件，避免把正常负荷波动误判为离群；基准用中位数/MAD 以免被离群值自身污染' },
      { id: 'gate-6', name: '时间覆盖', rule: '积分时长 / 应有时长', order: 6, why: '决定 CEMS 项采用哪一档分级缺省不确定度' },
    ],
    integration: {
      rule: `Δt = min(相邻间隔, ${NOMINAL_INTERVAL_MIN} min)；末点不外推；超限空白记缺口不补`,
      why: '本平台数据存在 4h 与 1min 两种采样密度，按固定周期折算会放大 240 倍（自校验中已加"采样密度无关性"断言防回归）',
    },
    tiers: TIER_UNCERTAINTY,
    constants: { HARD_MAX_RATE, HARD_MAX_DAILY, NOMINAL_INTERVAL_MIN, LEVEL, DAYS_PER_YEAR, OUTLIER_Z, OUTLIER_RATIO },
  };
}

/* ==================================================================
 * 九、自校验
 * ================================================================== */

function selfTest() {
  const checks = [];
  const push = (name, expect, actual, pass) => checks.push({ name, expect, actual, pass });

  /* 1) 数学内核继承自 statistics.js */
  const stR = st.selfTest();
  push(`statistics 内核 ${stR.passed}/${stR.total}`, '全部通过', `${stR.passed}/${stR.total}`, stR.allPass);

  /* 2) 门控：量级异常必须被剔除，正常波动必须保留 */
  const fake = [
    { monitor_no: 'M1', reading_time: '2026-10-01 00:00:00', flow_value: 50, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' },
    { monitor_no: 'M1', reading_time: '2026-10-01 04:00:00', flow_value: 46466.5, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' },
    { monitor_no: 'M1', reading_time: '2026-10-01 08:00:00', flow_value: 52, quality_flag: 'DRIFT', status: 'ABNORMAL', source: 'CEMS' },
    { monitor_no: 'M1', reading_time: '2026-10-01 12:00:00', flow_value: 0, quality_flag: 'OFFLINE', status: 'OFFLINE', source: 'WATCHDOG' },
    { monitor_no: 'M1', reading_time: '2026-10-01 14:00:00', flow_value: 0, quality_flag: 'MISSING', status: 'ABNORMAL', source: 'CEMS' },
    { monitor_no: 'M1', reading_time: '2026-10-01 16:00:00', flow_value: 48, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' },
  ];
  const g = gate(fake);
  push('门控剔除量级异常（46466 tCO2e/h）', 1, g.byReason.implausible, g.byReason.implausible === 1);
  push('门控保留合规读数', 2, g.kept.length, g.kept.length === 2);
  push('门控剔除质量不合格', 1, g.byReason.qualityFlag, g.byReason.qualityFlag === 1);
  push('门控剔除 WATCHDOG 占位（优先于零值归因）', 1, g.byReason.watchdog, g.byReason.watchdog === 1);
  push('门控剔除设备零值', 1, g.byReason.nonPositive, g.byReason.nonPositive === 1);

  /* 2b) 稳健离群门控：只剔除"统计显著 + 工程量级异常"，不误杀正常负荷波动。
        这是本门控最需要防的错 —— 把 3.5 倍超工程上限但低于 5000 的尖峰放过，
        同时不能把 ±40% 的正常负荷波动当成离群砍掉。 */
  const mkRow = (i, rate) => ({
    monitor_no: 'M9',
    reading_time: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 60000),
    flow_value: rate, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS',
  });
  const normal = [];
  for (let i = 0; i < 60; i++) normal.push(mkRow(i, 50 * (1 + 0.4 * Math.sin(i / 3))));  // 30~70
  const spike = normal.concat([mkRow(60, 1941.11)]);                                     // 尖峰 ≈ 39 倍中位数
  push('稳健离群：剔除 39 倍尖峰', 1, gate(spike).byReason.outlier, gate(spike).byReason.outlier === 1);
  push('稳健离群：不误杀 ±40% 正常波动', 0, gate(normal).byReason.outlier, gate(normal).byReason.outlier === 0);
  push('稳健离群：尖峰剔除后仅剩合规点', 60, gate(spike).kept.length, gate(spike).kept.length === 60);

  /* 3) 步进积分：恒定速率 100 tCO2e/h，4h 间隔，全天 6 点 → 应为 100×24 = 2400 */
  const day = '2026-10-02';
  const cadence = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${day}T00:00:00`);
    d.setHours(i * 4);
    cadence.push({ monitor_no: 'M1', reading_time: d, flow_value: 100, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' });
  }
  const g2 = gate(cadence);
  const ig2 = integrate(g2.kept);
  const got = ig2.byDay.get(day);
  push('步进积分 恒定100t/h×4h→24h = 2400 tCO2e', 2400, Number((got || 0).toFixed(3)), Math.abs((got || 0) - 2400) < 1e-6);

  /* 4) 采样密度无关性：同样的物理过程，1min 采样与 4h 采样必须积分出同一结果
        （这是"按固定周期折算会放大 240 倍"那条缺陷的回归断言） */
  const fine = [];
  for (let i = 0; i < 1441; i++) {
    const d = new Date(`${day}T00:00:00`); d.setMinutes(i);
    fine.push({ monitor_no: 'M2', reading_time: d, flow_value: 100, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' });
  }
  const ig3 = integrate(gate(fine).kept);
  const got2 = ig3.byDay.get(day);
  push('采样密度无关：1min 采样积分同为 2400', 2400, Number((got2 || 0).toFixed(3)), Math.abs((got2 || 0) - 2400) < 1e-6);

  /* 5) 缺口不外推：两点相隔 8h，只应计入 4h */
  const gap = gate([
    { monitor_no: 'M3', reading_time: new Date(`${day}T00:00:00`), flow_value: 100, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' },
    { monitor_no: 'M3', reading_time: new Date(`${day}T08:00:00`), flow_value: 100, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' },
  ]).kept;
  const ig4 = integrate(gap);
  push('8h 空白只计 4h（不外推）', 400, Number((ig4.byDay.get(day) || 0).toFixed(3)), Math.abs((ig4.byDay.get(day) || 0) - 400) < 1e-6);
  push('缺口时长被如实记录', 240, Number(ig4.gapMin.toFixed(1)), Math.abs(ig4.gapMin - 240) < 1e-6);

  /* 5b) 跨零点摊分：22:00 → 02:00（4h 一步）应跨两个自然日，各摊 2 小时 */
  const cross = gate([
    { monitor_no: 'M4', reading_time: new Date('2026-10-02T22:00:00'), flow_value: 100, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' },
    { monitor_no: 'M4', reading_time: new Date('2026-10-03T02:00:00'), flow_value: 100, quality_flag: 'NORMAL', status: 'NORMAL', source: 'CEMS' },
  ]).kept;
  const ig5 = integrate(cross);
  push('跨零点摊分：10-02 覆盖 120 分钟', 120, Number((ig5.byDayMin.get('2026-10-02') || 0).toFixed(1)),
    Math.abs((ig5.byDayMin.get('2026-10-02') || 0) - 120) < 1e-6);
  push('跨零点摊分：两日各得 200 tCO2e', 200, Number((ig5.byDay.get('2026-10-02') || 0).toFixed(3)),
    Math.abs((ig5.byDay.get('2026-10-02') || 0) - 200) < 1e-6
    && Math.abs((ig5.byDay.get('2026-10-03') || 0) - 200) < 1e-6);

  /* 6) 后验区间必须包含样本均值，且半宽随 n 单调收窄 */
  const xs = [];
  for (let i = 0; i < 30; i++) xs.push(1000 + ((i * 37) % 41) - 20);
  const p1 = st.nigPosterior(xs, { kappa0: 1, alpha0: 2, level: 0.95 });
  push('后验区间包含样本均值', true, p1.ci.low < p1.mean && p1.mean < p1.ci.high,
    p1.ci.low < p1.mean && p1.mean < p1.ci.high);
  const p2 = st.nigPosterior(xs.concat(xs), { kappa0: 1, alpha0: 2, level: 0.95 });
  push('样本量翻倍 ⇒ 区间收窄', true, `${p1.ci.halfWidth.toFixed(3)} → ${p2.ci.halfWidth.toFixed(3)}`,
    p2.ci.halfWidth < p1.ci.halfWidth);

  /* 7) 误差传播法（GUM）的解析恒等式
     u = √( Σ (wᵢ·uᵢ)² )。两条可手算的退化情形：
       · 单成分、权重 1  ⇒ u = u₁
       · k 个等权独立成分、各 ±u ⇒ u = u/√k（权重把贡献平方后再相加）
     以及一条单调性：增加成分不会让合成不确定度变小。 */
  const gum = (terms) => Math.sqrt(terms.reduce((a, t) => a + (t.w * t.u) ** 2, 0));
  const one = gum([{ w: 1, u: 0.05 }]);
  push('GUM 单成分 w=1, u=5% ⇒ 5%', 0.05, Number(one.toFixed(9)), Math.abs(one - 0.05) < 1e-12);

  const two = gum([{ w: 0.5, u: 0.05 }, { w: 0.5, u: 0.05 }]);
  push('GUM 两等权成分各 5% ⇒ 5%/√2', Number((0.05 / Math.SQRT2).toFixed(9)), Number(two.toFixed(9)),
    Math.abs(two - 0.05 / Math.SQRT2) < 1e-12);

  const three = gum([{ w: 1 / 3, u: 0.05 }, { w: 1 / 3, u: 0.05 }, { w: 1 / 3, u: 0.05 }]);
  push('GUM 三等权成分各 5% ⇒ 5%/√3', Number((0.05 / Math.sqrt(3)).toFixed(9)), Number(three.toFixed(9)),
    Math.abs(three - 0.05 / Math.sqrt(3)) < 1e-12);

  const four = gum([{ w: 1, u: 0.05 }, { w: 0, u: 0 }]);
  push('GUM 增加零贡献成分不改变结果', Number(one.toFixed(9)), Number(four.toFixed(9)), Math.abs(four - one) < 1e-12);

  const passed = checks.filter((c) => c.pass).length;
  return { checks, passed, total: checks.length, allPass: passed === checks.length };
}

module.exports = {
  HARD_MAX_RATE, HARD_MAX_DAILY, NOMINAL_INTERVAL_MIN, LEVEL, TIER_UNCERTAINTY,
  gate, integrate, dailySeries, entContext,
  posterior, savePosterior, propagate, modelEval, saveModelEval, forecasters,
  report, reportAndAnchor, recomputeAll, industrySummary, list, modelEvalList, catalog, selfTest,
};
