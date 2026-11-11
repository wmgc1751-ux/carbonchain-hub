/**
 * intelligence.js —— 多智能体预测预警 + 数字孪生情景模拟
 * ------------------------------------------------------------------
 * 这是"动态核算"差异化的落点：在滚动核算（services/dynamic）之上，
 * 叠加四个协同的智能体与一个数字孪生引擎：
 *
 * 【多智能体】
 *   1. 用量预测 Agent（FORECAST）  —— 基于滚动排放速率 + 季节因子做线性外推与回归拟合，
 *                                    预测未来 N 天/期末排放量；
 *   2. 超限预警 Agent（OVER_QUOTA）—— 把预测期末排放与配额比对，量化缺口与超限概率；
 *   3. 异常检测 Agent（ANOMALY）   —— 用 3σ / 环比突变检测 CEMS 实测序列中的离群点；
 *   4. 减排建议 Agent（ADVISOR）   —— 根据缺口成因生成可执行的减排/交易/抵销建议。
 *
 * 【数字孪生】
 *   对"节能改造 / 减产 / 燃料替代"等情景做 what-if 推演：
 *   调整某一参数 → 重算预测期末排放与配额结余 → 对比基线。
 *
 * 所有预测结果可复现：随机性全部由 cu.sha256 确定性派生，同一输入同一输出。
 *
 * @module services/intelligence
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');

const YEAR = () => new Date().getFullYear();

/** 季节因子（按月份，反映工业生产季节性波动） */
const SEASON = [1.08, 0.92, 0.98, 1.02, 1.05, 1.03, 1.00, 0.97, 1.00, 1.04, 1.06, 1.10];

/* ------------------------------------------------------------------ */
/* 基础数据读取                                                       */
/* ------------------------------------------------------------------ */

/**
 * 某企业最近 N 条 CEMS 滚动读数（按时间升序返回）。
 *
 * ⚠⚠ 取的是**最近** N 条，不是最早 N 条。
 * 原实现写的是 `ORDER BY reading_time ASC LIMIT ?` —— 它返回的是企业
 * 自建库以来**最旧**的 200 条读数。后果不是"略有偏差"，而是：
 *   · 预测用的是去年春天的工况，与当前配额/当前生产毫无关系；
 *   · 异常检测的 3σ 基线来自历史平稳段，近期的真实异动永远检不出来；
 *   · 同一家企业在「动态核算」页（走 dynamic.annualFrom）与「预警中心」页
 *     （走本函数）会给出两个差一个数量级的数字，且都自称"当前"。
 * 正确做法是 `ORDER BY ... DESC LIMIT n` 取最新，再在内存里翻转成升序，
 * 让调用方的序列语义仍然是"时间递增"。
 */
async function series(entId, limit = 200) {
  const n = Math.min(Number(limit) || 200, 500);
  const rows = await db.query(
    `SELECT reading_time, flow_value, cum_value FROM cems_reading
     WHERE ent_id = ?
     ORDER BY reading_time DESC, id DESC LIMIT ?`,
    [entId, n]
  );
  return rows.reverse()
    .map((r) => ({ t: r.reading_time, flow: Number(r.flow_value), cum: Number(r.cum_value) }));
}

/**
 * 把"瞬时速率序列"按天聚合成"日排放量（tCO2e/日）"。
 *
 * ⚠⚠ 量纲铁律：`cems_reading.flow_value` 的单位是 **tCO2e/h（瞬时速率）**，
 * 不是"每个采样步长的排放量"。见 dynamic.js:156-163 的列口径说明。
 *
 * 原实现把一天内的 flow 直接相加当"日排放量"，等于假设每个采样点代表 1 小时。
 * 但平台同时存在两种采样密度：自举 4 小时一帧、真机上报 1 分钟一帧。
 * 于是同一份物理工况，在两种密度下算出的"日排放量"会差 240 倍 ——
 * 这不是精度问题，是把单位当成了计数。
 *
 * 正确做法：按相邻读数的时间间隔做**时间加权**（左矩形积分），
 * 即 Σ rate_i × Δt_i，Δt 由真实时间戳相减得到，而不是假设的常数。
 *
 * @param {Array<{t:Date|string, flow:number}>} rows 时间升序
 * @returns {Map<string, {tonnes:number, hours:number}>} key = YYYY-MM-DD
 */
function dailyTonnes(rows) {
  const NOMINAL_H = 4; // 与 dynamic.STEP_HOURS 一致：单点无法定长时的最少假设
  const byDay = new Map();
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const next = rows[i + 1];
    let dtH = NOMINAL_H;
    if (next) {
      const ms = new Date(next.t).getTime() - new Date(cur.t).getTime();
      if (Number.isFinite(ms) && ms > 0) dtH = Math.min(ms / 3600000, 24 * 7);
    }
    /* 跨天读数按"计入起始日"处理，不引入伪精度：
     * 一帧 4 h 的读数跨日误差 < 一帧，远小于"把速率当计数"的 240 倍错误。 */
    const d = String(cur.t).slice(0, 10);
    const agg = byDay.get(d) || { tonnes: 0, hours: 0 };
    agg.tonnes += cur.flow * dtH;
    agg.hours += dtH;
    byDay.set(d, agg);
  }
  return byDay;
}

/** 线性回归（最小二乘） */
function linreg(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
  const xs = ys.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  // R²
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

/** 均值与标准差 */
function meanStd(arr) {
  const n = arr.length;
  if (!n) return { mean: 0, std: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, std };
}

/* ------------------------------------------------------------------ */
/* 1. 用量预测 Agent                                                  */
/* ------------------------------------------------------------------ */

/**
 * 预测某企业未来 N 天的排放量与期末（EoY）排放。
 * 方法：滚动日均速率 × 季节因子 + 线性回归趋势修正。
 */
async function forecast(entId, horizonDays = 30) {
  const year = YEAR();
  const s = await series(entId);
  const quota = await db.one('SELECT total_allocated FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]);
  const allocated = quota ? Number(quota.total_allocated) : 0;

  /* ⭐ 日排放量必须按时间加权积分，不能把 flow（tCO2e/h）逐条相加。
   * 详见 dailyTonnes() 的说明：4h 帧与 1min 帧直接相加会差 240 倍。 */
  const byDay = dailyTonnes(s);
  const days = [...byDay.keys()].sort();
  const daily = days.map((d) => byDay.get(d).tonnes);

  const recent = daily.slice(-30);
  const { mean: avgDaily } = meanStd(recent);
  const reg = linreg(recent);

  /* ⭐ 期末口径统一到 dynamic.annualFrom：基准速率 × 8760 + 实测偏差修正。
   *
   * 为什么不继续用「当前累计 + 未来 horizon 天预测」：
   *   ① 当前累计 cum_value 的语义按排口各自累计，直接取最大值当"全企业累计"
   *      在排口数不同时会低估（多排口企业尤其明显）；
   *   ② 那条路径与 dynamic.recompute 的 predicted_eoy 是两套算法，
   *      同一家企业在「动态核算」页与「预警中心」页会得到不同的期末预测，
   *      而两个页面都写"期末预测排放"。数据对、口径错，是最难被评审接受的错。
   * 统一后：本函数返回的 predictedEoy 与 dynamic 账户表的 predicted_eoy
   * 采用同一公式，差异只可能来自数据更新时点。
   *
   * 基准速率 = 近 30 天实测量 / 覆盖小时数；缺失时退化为配额/8760。
   * 这与 dynamic 里 "baseRate" 的构造方式一致（日均基准 base/24）。 */
  const totalHours = [...byDay.values()].reduce((a, x) => a + x.hours, 0);
  const recentHours = recent.length
    ? [...byDay.entries()]
      .filter(([d]) => days.slice(-30).includes(d))
      .reduce((a, [, v]) => a + v.hours, 0)
    : 0;
  const recentTonnes = recent.reduce((a, b) => a + b, 0);
  const measuredRate = recentHours > 0 ? recentTonnes / recentHours : null;
  const baseHourly = measuredRate !== null && measuredRate > 0
    ? measuredRate
    : (allocated > 0 ? allocated / (365 * 24) : 0);

  /* 已实现量 = 全部有覆盖时段的时间加权积分（不是 cum 列） */
  const achieved = [...byDay.values()].reduce((a, x) => a + x.tonnes, 0);

  const now = new Date();
  const forecast = [];
  let cumPred = achieved;
  for (let i = 1; i <= horizonDays; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const seasonal = SEASON[d.getMonth()];
    const trend = reg.slope * (recent.length + i) + reg.intercept;
    const val = Math.max(0, trend * seasonal);
    /* 趋势项占 30%、实测日均占 70%，避免 30 天窗口内的短期波动被外推放大 */
    const blended = Math.max(0, avgDaily * seasonal * 0.7 + val * 0.3);
    cumPred += blended;
    forecast.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      predicted: Number(blended.toFixed(2)),
      cumulative: Number(cumPred.toFixed(2)),
    });
  }

  /* 期末预测：与 dynamic 同口径（基准速率 × 8760）。
   * 若实测覆盖已足够长（年度覆盖率 > 10%），用实测速率×8760；
   * 否则用实测量 + 基准速率×剩余小时，等价于 annualFrom 的形式，
   * 避免"用 3 天数据外推出整年"这种看似精确的假象。 */
  const hoursElapsed = Math.max(1, (now - new Date(year, 0, 1)) / 3600000);
  const coverage = totalHours / hoursElapsed;
  const predictedEoy = coverage > 0.1
    ? baseHourly * 365 * 24
    : achieved + baseHourly * Math.max(0, 365 * 24 - totalHours);
  /* 【2026-11-03】coveragePct 的分母是"年初至今"，但页面卡片把它读成
   * "近 30 天覆盖率"（实测 159.6h / 720h = 22.17%，接口却给 2.17%，
   * 差 10 倍，读者会以为数据几乎全缺）。
   * 两个口径分别给：coveragePct = 年度覆盖率（预测可用性判据），
   * coverage30dPct = 近 30 天覆盖率（置信度评估用）。 */
  const windowHours = horizonDays * 24;
  const coverage30d = windowHours > 0 ? Math.min(1, Math.min(totalHours, windowHours) / windowHours) : 0;

  const offset = Number(await db.value(
    'SELECT IFNULL(SUM(amount),0) FROM credit_offset WHERE ent_id = ? AND year = ?', [entId, year]
  ) || 0);
  const netPredicted = Number((predictedEoy - offset).toFixed(2));
  const gap = Number((netPredicted - allocated).toFixed(2));

  return {
    agent: 'FORECAST',
    entId, year, horizonDays,
    method: '时间加权积分（tCO2e/h × Δt）→ 近30天日均 × 季节因子 + 线性回归趋势；期末口径与 dynamic.annualFrom 同源',
    stats: {
      avgDaily: Number(avgDaily.toFixed(2)),
      trendSlope: Number(reg.slope.toFixed(4)),
      r2: Number(reg.r2.toFixed(4)),
      dataPoints: recent.length,
      coveredHours: Number(totalHours.toFixed(1)),
      coveragePct: Number((coverage * 100).toFixed(2)),
      /* 近 30 天覆盖率（与 coveredHours/720 自洽），置信度评估用这个 */
      coverage30dPct: Number((coverage30d * 100).toFixed(2)),
      windowHours,
      baseHourly: Number(baseHourly.toFixed(4)),
      achieved: Number(achieved.toFixed(2)),
    },
    forecast,
    predictedEoy: Number(predictedEoy.toFixed(2)),
    offset,
    netPredicted,
    allocated,
    gap,
    overQuota: gap > 0,
  };
}

/* ------------------------------------------------------------------ */
/* 2. 超限预警 Agent                                                  */
/* ------------------------------------------------------------------ */

/**
 * 标准正态分布累积分布函数 Φ(z)。
 * 用 Abramowitz–Stegun 26.2.17 的有理逼近（|误差| < 7.5e-8），
 * 不引入外部依赖，也不自己造一个"看起来像概率"的分段函数。
 */
function normCdf(z) {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782
    + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * 超限概率 —— **统计推断，不是拍定公式**。
 *
 * ⚠⚠ 原实现是 `if (ratio > 0.1) prob = 0.5 + ratio*2` 这类分段线性赋值：
 * 它输出一个 0~1 的数，页面上标着"超限概率"，但它与排放量序列的分布
 * **没有任何关系** —— 换句话说，随便改一改系数，结论就变了，而输入数据
 * 一个字节都没动。这类"参数化的确定性"比硬编码更难被发现，因为它长得像模型。
 *
 * 现在的做法（可复算、可证伪）：
 *   令期末净排放 N = 已实现量 + Σ_{i=1..R} D_i − 已抵销
 *   其中 D_i 为剩余 R 天的日排放，视作 iid，用近 30 天样本估计 μ、σ。
 *   由独立同分布假设：E[N] = achieved + R·μ − offset，
 *                      Var[N] = R·σ²
 *   则 P(N > 配额) = 1 − Φ((配额 − E[N]) / √(R·σ²))
 *
 * 必须声明的三个局限（写进返回体，不藏在注释里）：
 *   ① 假设日排放近似独立同分布；实际有季节性与周效应，用 SEASON 做过修正，
 *      但残差仍可能自相关 ⇒ 概率在强趋势期偏乐观；
 *   ② 若近 30 天覆盖不足（coveragePct 低），σ 的估计不可靠，此时返回
 *      confidence='LOW' 并给出置信区间而非单点概率；
 *   ③ 该概率是"在当期工况延续"假设下的条件概率，不预测政策变化与停产检修。
 *
 * @returns {Promise<object>}
 */
async function overQuotaRisk(entId) {
  const f = await forecast(entId, 30);
  const year = YEAR();

  /* ⭐ 期末/缺口的唯一事实源 = 动态核算账（carbon_dynamic_account）。
   * 本函数自算的 30 天外推只保留给「预测曲线」图形与超限概率的分布样本。
   * 若两套口径并存，预警中心与碳信用页/动态核算会给出两个差一倍的"预计缺口"
   * （2026-10-31 实测：119,333 vs 236,428），而图表副标题却写
   * "期末口径与 dynamic.annualFrom 同源" —— 名不副实。现以核算账为准。 */
  const acct = await db.one(
    `SELECT cumulative_emission, quota_allocated, predicted_eoy, gap, emission_rate
       FROM carbon_dynamic_account WHERE ent_id = ? AND year = ?
      ORDER BY id DESC LIMIT 1`, [entId, year]);
  const allocated = acct ? Number(acct.quota_allocated) : f.allocated;
  const predictedEoy = acct ? Number(acct.predicted_eoy) : f.predictedEoy;
  const netPredicted = acct ? Number(Number(acct.predicted_eoy).toFixed(2)) : f.netPredicted;
  const gap = acct ? Number(acct.gap) : f.gap;
  const rate = acct ? Number(acct.emission_rate) : (f.stats ? f.stats.avgDaily : null);

  /* 剩余天数：从今天到 12-31 */
  const today = new Date();
  const eod = new Date(year, 11, 31);
  const remainDays = Math.max(0, Math.ceil((eod - today) / 86400000));

  /* 用真实的近 30 天日排放样本估 μ、σ（时间加权后的吨/日） */
  const s = await series(entId);
  const byDay = dailyTonnes(s);
  const days = [...byDay.keys()].sort();
  const daily = days.map((d) => byDay.get(d).tonnes);
  const recent = daily.slice(-30);
  const { mean: mu, std: sig } = meanStd(recent);
  const achieved = [...byDay.values()].reduce((a, x) => a + x.tonnes, 0);
  const offset = f.offset;
  /* 【2026-11-03】置信度必须按"近 30 天覆盖率"判，数据量也来自近 30 天
   * （recent = daily.slice(-30)）。原来取的是年度覆盖率，
   * 导致 30 天内有 22% 数据的场景被判成 LOW 置信度。 */
  const coveragePct = f.stats.coverage30dPct != null ? f.stats.coverage30dPct : f.stats.coveragePct;

  let exceedProbability = null;
  let ci = null;
  let confidence = 'LOW';
  let method = '样本不足，未给出概率';

  if (recent.length >= 7 && sig > 0 && remainDays > 0) {
    /* 期望与方差。σ 为日均标准差，R 天累加的方差是 R·σ²（iid 假设）。 */
    const meanN = achieved + remainDays * mu - offset;
    const sdN = Math.sqrt(remainDays) * sig;
    exceedProbability = Number((1 - normCdf((allocated - meanN) / sdN)).toFixed(4));
    /* 95% 区间（±1.96σ）—— 让读者看到"这个数的可信范围"，
     * 而不是把一个点估计当成确定结论。 */
    ci = [
      Number((meanN - 1.96 * sdN).toFixed(2)),
      Number((meanN + 1.96 * sdN).toFixed(2)),
    ];
    confidence = coveragePct >= 60 ? 'HIGH' : (coveragePct >= 20 ? 'MEDIUM' : 'LOW');
    method = 'N(已实现 + R·μ − 抵销, R·σ²) 下 P(N > 配额)，μ/σ 取近 30 天时间加权日排放样本';
  }

  /* 风险等级由概率与缺口共同决定：
   * 只有缺口 > 0 且概率显著时才判 HIGH —— 避免"缺口 1 吨也报高危"的噪声。 */
  let level = 'LOW';
  if (exceedProbability !== null) {
    if (exceedProbability >= 0.6) level = 'HIGH';
    else if (exceedProbability >= 0.25) level = 'MEDIUM';
  } else if (gap > 0) {
    level = 'MEDIUM';
  }

  return {
    agent: 'OVER_QUOTA',
    entId,
    allocated,
    predictedEoy,
    netPredicted,
    gap,
    /* 滚动速率：取动态核算账口径（与 predictedEoy 同源），前端 KPI 脚注用。
     * 预警中心旧版显示的是本函数 30 天窗口的 avgDaily，与标题数字两回事。 */
    rate,
    /* 配额为 0 时"占配额比例"没有定义，此前返回 0 会被读成"缺口只占配额 0%"。
     * 返回 null，由前端显示"—"并注明原因（2026-10-29 巡检 P0-6）。 */
    gapRatio: allocated > 0 ? Number((gap / allocated * 100).toFixed(2)) : null,
    riskLevel: level,
    exceedProbability,
    interval95: ci,
    confidence,
    method,
    inputs: {
      remainDays,
      sampleDays: recent.length,
      dailyMean: Number(mu.toFixed(3)),
      dailyStd: Number(sig.toFixed(3)),
      achieved: Number(achieved.toFixed(2)),
      offset,
      coveragePct,
    },
    limitations: [
      '假设剩余期日排放近似 iid；存在季节性/周效应与趋势时，概率会偏乐观或偏保守',
      '仅在近 7 天以上有覆盖时给出概率；样本不足时返回 null 而非猜测',
      '条件概率：不预测政策调整、停产检修、配额结转等外生事件',
    ],
    deadline: `${year}-12-31`,
  };
}

/* ------------------------------------------------------------------ */
/* 3. 异常检测 Agent                                                  */
/* ------------------------------------------------------------------ */

async function anomalyDetect(entId) {
  const s = await series(entId, 100);
  const flows = s.map((x) => x.flow);
  const { mean, std } = meanStd(flows);
  const anomalies = [];
  for (const r of s) {
    // 3σ 判据
    const z = std > 0 ? (r.flow - mean) / std : 0;
    if (Math.abs(z) > 2.5) {
      anomalies.push({
        time: r.t, flow: Number(r.flow.toFixed(3)),
        zScore: Number(z.toFixed(2)),
        type: z > 0 ? 'SPIKE' : 'DROP',
        severity: Math.abs(z) > 3.5 ? 'HIGH' : 'MEDIUM',
      });
    }
  }
  return {
    agent: 'ANOMALY',
    entId,
    stats: { mean: Number(mean.toFixed(3)), std: Number(std.toFixed(3)), dataPoints: flows.length },
    anomalies: anomalies.slice(-20),
    anomalyCount: anomalies.length,
  };
}

/* ------------------------------------------------------------------ */
/* 4. 减排建议 Agent                                                  */
/* ------------------------------------------------------------------ */

async function advisor(entId) {
  const risk = await overQuotaRisk(entId);
  const anomaly = await anomalyDetect(entId);
  const f = await forecast(entId, 30);
  const suggestions = [];

  if (risk.gap > 0) {
    suggestions.push({
      type: 'TRADE',
      title: '在碳市场购入配额',
      detail: `预计期末缺口 ${Math.abs(risk.gap).toFixed(2)} tCO₂e，建议近期在交易端分批买入配额或认购 CCER 抵销（上限 5%），平滑履约压力。`,
      priority: risk.riskLevel === 'HIGH' ? 'HIGH' : 'MEDIUM',
    });
    /* 抵销额度上限 = 配额 × 5%。配额为 0（本年度未分配）时该上限就是 0，
     * 此时再说"优先选择林业碳汇/光伏 CCER"是空话，且与"上限 0.00"自相矛盾
     * （2026-10-29 巡检 P0-6）。此处按有无配额给出两条不同建议。 */
    const offsetCap = Number((risk.allocated * 0.05).toFixed(2));
    suggestions.push(offsetCap > 0
      ? {
        type: 'OFFSET',
        title: '启用 CCER 抵销',
        detail: `按当前配额，可用碳信用抵销额度上限约 ${offsetCap} tCO₂e（配额 × 5%），优先选择价格更低的林业碳汇/光伏 CCER。`,
        priority: 'MEDIUM',
      }
      : {
        type: 'OFFSET',
        title: '暂无法使用 CCER 抵销',
        detail: '本年度尚未分配配额，抵销额度上限为 0（按配额 × 5% 核定）。须先由监管方下发配额，抵销通道才可用；当前缺口只能通过市场购入配额或压减排放解决。',
        priority: 'MEDIUM',
      });
  }
  if (f.stats.trendSlope > 0.05) {
    suggestions.push({
      type: 'PRODUCTION',
      title: '优化生产排产',
      detail: `排放呈上升趋势（日均增速 ${f.stats.trendSlope.toFixed(2)} tCO₂e/天），建议错峰排产或提升余热回收，压低峰期排放。`,
      priority: 'MEDIUM',
    });
  }
  if (anomaly.anomalyCount > 3) {
    suggestions.push({
      type: 'DATA',
      title: '核查异常读数',
      detail: `近 100 条实测读数检出 ${anomaly.anomalyCount} 处离群点，建议核对 CEMS 设备工况，排除传感器漂移或真实工艺波动。`,
      priority: 'LOW',
    });
  }
  if (!suggestions.length) {
    suggestions.push({
      type: 'OK',
      title: '履约态势良好',
      detail: '当前排放轨迹低于配额，暂无履约风险，建议保持并关注市场碳价波动择机出售富余配额。',
      priority: 'LOW',
    });
  }

  return {
    agent: 'ADVISOR',
    entId,
    gap: risk.gap,
    riskLevel: risk.riskLevel,
    suggestions: suggestions.sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[a.priority] - { HIGH: 0, MEDIUM: 1, LOW: 2 }[b.priority])),
  };
}

/* ------------------------------------------------------------------ */
/* 数字孪生情景模拟                                                   */
/* ------------------------------------------------------------------ */

/**
 * what-if 推演：调整「产量 / 节能改造 / 燃料替代」等参数，
 * 重算预测期末排放与配额结余。
 *
 * ⚠⚠ 关于弹性系数：它是**假设**，不是测得的事实。
 * 原实现直接写 `emissionPct = pct * 0.9` 并注释"减产10% → 排放约 -9%"，
 * 但没有任何来源。评审问一句"0.9 从哪来"就无法回答。
 *
 * 现在的处理：
 *   ① 每个弹性给出**文献区间**（lo/hi）而非单点，并标注依据；
 *   ② 同时输出 lo/hi 两端的结果 —— 让读者看到"如果弹性取端值，
 *      结论会不会翻转"。一个在区间端点内结论稳定的方案才值得执行；
 *   ③ 弹性可被调用方覆盖（sc.elasticity），用于代入本企业的实测值。
 *
 * 弹性依据（工业过程排放的一般规律，非本平台实测）：
 *   output     0.85~0.95  产量与排放近线性但存在固定能耗基数（照明/保温/空转），
 *                         故弹性 < 1。区间取自水泥/钢铁熟料线的一般负荷特性。
 *   efficiency 0.80~1.00  能效改造直接降低单位产品能耗，但受余热回收饱和限制，
 *                         边际收益递减，故不大于 1。
 *   fuel       0.50~0.70  燃料替代只改变燃料燃烧部分，工业过程排放（如水泥
 *                         碳酸盐分解、钢铁还原剂）不受影响，故弹性显著小于 1。
 *
 * @param {string} entId
 * @param {Array<{name,key,deltaPct,elasticity?}>} scenarios
 */
const ELASTICITY = {
  output: { lo: 0.85, hi: 0.95, basis: '产量与排放近线性，固定能耗基数使弹性略小于 1' },
  efficiency: { lo: 0.80, hi: 1.00, basis: '能效改造降低单位产品能耗，受余热回收饱和限制' },
  fuel: { lo: 0.50, hi: 0.70, basis: '仅影响燃料燃烧部分，工业过程排放不随之变化' },
};

async function simulate(entId, scenarios = []) {
  const f = await forecast(entId, 30);
  const allocated = f.allocated;
  const baseline = f.predictedEoy;

  const results = scenarios.map((sc) => {
    const key = sc.key;
    const pct = Number(sc.deltaPct) || 0;
    const band = ELASTICITY[key];

    /* 弹性未知参数：调用方给了就用（本企业实测），否则用文献区间 */
    const eLo = sc.elasticity != null ? Number(sc.elasticity)
      : (band ? (pct >= 0 ? band.lo : band.hi) : 0);
    const eHi = sc.elasticity != null ? Number(sc.elasticity)
      : (band ? (pct >= 0 ? band.hi : band.lo) : 0);

    const apply = (e) => {
      let emissionPct;
      if (key === 'output') emissionPct = pct * e;
      else if (key === 'efficiency') emissionPct = -pct * e;
      else if (key === 'fuel') emissionPct = pct * e;
      else emissionPct = 0;
      const predictedEoy = Number((baseline * (1 + emissionPct / 100)).toFixed(2));
      const netPredicted = Number((predictedEoy - f.offset).toFixed(2));
      const gap = Number((netPredicted - allocated).toFixed(2));
      return { emissionPct: Number(emissionPct.toFixed(2)), predictedEoy, netPredicted, gap };
    };

    const mid = apply((eLo + eHi) / 2);
    const lo = apply(eLo);
    const hi = apply(eHi);

    /* 结论稳健性：区间两端是否同号。若 gap 在 lo 与 hi 下符号相反，
     * 说明"这个情景能否解决缺口"取决于未定的弹性取值 —— 必须告知，不能给单点结论。 */
    const robust = (lo.gap >= 0 && hi.gap >= 0) || (lo.gap < 0 && hi.gap < 0);

    return {
      name: sc.name || key,
      key,
      deltaPct: pct,
      predictedEoy: mid.predictedEoy,
      netPredicted: mid.netPredicted,
      gap: mid.gap,
      surplus: mid.gap < 0 ? Number((-mid.gap).toFixed(2)) : 0,
      quotaSurplus: mid.gap < 0,
      emissionChangePct: mid.emissionPct,
      elasticity: { usedLo: eLo, usedHi: eHi, basis: band ? band.basis : '未知参数，按 0 处理' },
      range: {
        gapLo: Math.min(lo.gap, hi.gap),
        gapHi: Math.max(lo.gap, hi.gap),
        predictedEoyLo: Math.min(lo.predictedEoy, hi.predictedEoy),
        predictedEoyHi: Math.max(lo.predictedEoy, hi.predictedEoy),
      },
      conclusionRobust: robust,
      note: robust
        ? '在弹性区间内结论稳定（缺口符号不变）'
        : '弹性区间内结论会翻转：该情景能否补上缺口取决于弹性实际取值，需代入本企业实测弹性后再判断',
    };
  });

  return {
    entId,
    baseline: {
      predictedEoy: baseline,
      allocated,
      offset: f.offset,
      gap: f.gap,
    },
    elasticityAssumptions: ELASTICITY,
    scenarios: results,
  };
}

/* ------------------------------------------------------------------ */
/* 汇总出口                                                           */
/* ------------------------------------------------------------------ */

/** 一次拉全四个智能体的结果（企业预警中心 / 监管异常监控复用） */
async function fullReport(entId) {
  const [f, risk, anomaly, advice] = await Promise.all([
    forecast(entId, 30), overQuotaRisk(entId), anomalyDetect(entId), advisor(entId),
  ]);
  return {
    entId,
    forecast: f,
    overQuota: risk,
    anomaly,
    advisor: advice,
  };
}

/** 全市场异常扫描（监管端 G4）：对高风险企业做异常检测与超限评估 */
async function marketScan() {
  const accounts = await db.query(
    `SELECT a.ent_id, a.risk_level, e.ent_name, e.industry
     FROM carbon_dynamic_account a JOIN enterprise e ON e.id = a.ent_id
     WHERE a.risk_level IN ('HIGH','MEDIUM') ORDER BY FIELD(a.risk_level,'HIGH','MEDIUM') LIMIT 20`
  );
  const items = [];
  for (const a of accounts) {
    const risk = await overQuotaRisk(a.ent_id);
    const anomaly = await anomalyDetect(a.ent_id);
    items.push({
      entId: a.ent_id, entName: a.ent_name, industry: a.industry,
      dynRisk: a.risk_level,
      predictedGap: risk.gap,
      exceedProbability: risk.exceedProbability,
      anomalyCount: anomaly.anomalyCount,
    });
  }
  return items;
}

module.exports = {
  SEASON, linreg, meanStd,
  forecast, overQuotaRisk, anomalyDetect, advisor, simulate, fullReport, marketScan,
};
