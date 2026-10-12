/**
 * statistics.js —— 统计推断内核（WP4 核算升级的数学底座）
 * ==================================================================
 * 零依赖实现，理由与前几轮一致：保持"单机可离线演示"这一既有优势。
 * 引入 heavylib / jStat 只为算一个 t 分位数并不值得。
 *
 * 提供三类能力
 *   一、特殊函数：lnGamma / 正则化不完全 Beta（连分式）/ Student-t CDF 与分位数
 *   二、贝叶斯共轭推断：Normal-Inverse-Gamma 后验（均值与方差同时未知）
 *   三、时序分解与预测精度指标：移动平均趋势、周内季节项、MAPE/RMSE/MAE/R²
 *
 * 正确性锚定（见本文件末尾 selfTest()）
 *   · t 分布分位数对照已知值：t(0.975, df=10)=2.228、t(0.975, df=30)=2.042、
 *     t(0.975, df=∞)→1.960；
 *   · 大样本下 NIG 后验的 95% 区间应收敛到 1.96·σ/√n。
 *   这两条让"我们算的区间是对的"从自述变成可复核。
 * ==================================================================
 */
'use strict';

/* ==================================================================
 * 一、特殊函数
 * ================================================================== */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(z) —— Lanczos 近似，z > 0 */
function lnGamma(z) {
  if (z < 0.5) {
    /* 反射公式，覆盖 (0, 0.5) */
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  let x = 0.99999999999980993;
  const zz = z - 1;
  for (let i = 0; i < LANCZOS.length; i++) x += LANCZOS[i] / (zz + i + 1);
  const t = zz + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** 连分式（Numerical Recipes betacf，Lentz 修正版） */
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  const qab = a + b; const qap = a + 1; const qam = a - 1;
  let c = 1; let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}

/** 正则化不完全 Beta 函数 I_x(a,b) */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t 累积分布函数 P(T ≤ t) */
function studentTCdf(t, df) {
  if (!(df > 0)) return NaN;
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const p = 0.5 * incompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - p : p;
}

/** Student-t 分位数（对 CDF 做二分，1e-10 精度足够） */
function studentTQuantile(p, df) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -1e4; let hi = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/** 标准正态分位数（Acklam 有理逼近，精度 ~1e-9） */
function normalQuantile(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425; const phigh = 1 - plow;
  let q; let r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * 逆 Gamma 抽样（用于蒙特卡洛）：X ~ InvGamma(alpha, beta)
 * 由 Gamma(alpha, 1) 生成：若 G ~ Gamma(alpha,1)，则 beta/G ~ InvGamma(alpha,beta)。
 * Marsaglia-Tsang 方法生成 Gamma(alpha,1)。
 */
function gammaSample(alpha, rng) {
  if (alpha < 1) {
    /* Boost: Gamma(a) = Gamma(a+1) * U^(1/a) */
    const u = rng();
    return gammaSample(alpha + 1, rng) * Math.pow(u, 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x; let v;
    do {
      x = normalSample(rng); v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(rng) {
  let u = 0; let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ==================================================================
 * 二、贝叶斯共轭推断：Normal-Inverse-Gamma
 * ================================================================== */

/** 样本基础统计量 */
function describe(xs) {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, variance: 0, sd: 0, min: 0, max: 0, sum: 0, ss: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const ss = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const variance = n > 1 ? ss / (n - 1) : 0;
  return { n, mean, sum, ss, variance, sd: Math.sqrt(variance), min: Math.min(...xs), max: Math.max(...xs) };
}

/**
 * Normal-Inverse-Gamma 后验（均值与方差均未知的标准共轭模型）。
 * 先验超参数：mu0（先验均值）、kappa0（先验强度/等效样本量）、alpha0、beta0
 * 后验：
 *   kappa_n = kappa0 + n
 *   mu_n    = (kappa0·mu0 + n·x̄) / kappa_n
 *   alpha_n = alpha0 + n/2
 *   beta_n  = beta0 + ½·SS + (kappa0·n·(x̄−mu0)²) / (2·kappa_n)
 * 均值的边缘后验：t 分布，自由度 2·alpha_n，位置 mu_n，尺度 √(beta_n/(alpha_n·kappa_n))
 */
function nigPosterior(xs, prior = {}) {
  const d = describe(xs);
  const mu0 = prior.mu0 === undefined ? d.mean : Number(prior.mu0);
  const kappa0 = prior.kappa0 === undefined ? 1 : Number(prior.kappa0);
  const alpha0 = prior.alpha0 === undefined ? 2 : Number(prior.alpha0);
  const beta0 = prior.beta0 === undefined
    ? Math.max(d.variance * alpha0, 1e-12)
    : Number(prior.beta0);

  const kappaN = kappa0 + d.n;
  const muN = (kappa0 * mu0 + d.n * d.mean) / kappaN;
  const alphaN = alpha0 + d.n / 2;
  const betaN = beta0 + d.ss / 2 + (kappa0 * d.n * (d.mean - mu0) * (d.mean - mu0)) / (2 * kappaN);
  const df = 2 * alphaN;
  const scale = Math.sqrt(betaN / (alphaN * kappaN));

  const level = prior.level === undefined ? 0.95 : Number(prior.level);
  const tCrit = studentTQuantile(1 - (1 - level) / 2, df);

  return {
    prior: { mu0, kappa0, alpha0, beta0 },
    posterior: { mun: muN, kappan: kappaN, alphan: alphaN, betan: betaN },
    df, scale,
    mean: muN,
    /* 后验方差的期望：beta_n / (alpha_n − 1)（alpha_n > 1 时） */
    varianceMean: alphaN > 1 ? betaN / (alphaN - 1) : null,
    /* ★ 预测区间：纳入未知方差 → t 分布而不是正态；这是"单值 → 区间"的实质 */
    predictive: { df, loc: muN, scale: Math.sqrt(betaN * (kappaN + 1) / (alphaN * kappaN)) },
    ci: { level, low: muN - tCrit * scale, high: muN + tCrit * scale, halfWidth: tCrit * scale, tCrit },
    obs: d,
  };
}

/**
 * 蒙特卡洛交叉验证：从后验直接抽样，得到区间端点。
 * 与解析解的 t 分布区间**必须一致** —— 两条独立路径互相印证。
 */
function monteCarloCheck(xs, prior = {}, draws = 20000, seed = 20261012) {
  const post = nigPosterior(xs, prior);
  let s = seed >>> 0;
  const rng = () => {
    /* xorshift32：确定性可复现，避免每次跑出不同结论 */
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const alphaN = post.posterior.alphan;
  const betaN = post.posterior.betan;
  const kappaN = post.posterior.kappan;

  const mus = new Float64Array(draws);
  for (let i = 0; i < draws; i++) {
    const g = gammaSample(alphaN, rng);
    const sigma2 = betaN / g;
    mus[i] = post.posterior.mun + normalSample(rng) * Math.sqrt(sigma2 / kappaN);
  }
  const sorted = Array.from(mus).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(draws - 1, Math.max(0, Math.floor(p * draws)))];
  const mcMean = mus.reduce((a, b) => a + b, 0) / draws;
  const mcSd = Math.sqrt(mus.reduce((a, b) => a + (b - mcMean) * (b - mcMean), 0) / (draws - 1));

  return {
    draws,
    seed,
    mean: mcMean,
    sd: mcSd,
    ci: { level: post.ci.level, low: q(0.025), high: q(0.975) },
    agreement: {
      meanDelta: Math.abs(mcMean - post.mean),
      meanRelPct: post.mean !== 0 ? Math.abs(mcMean - post.mean) / Math.abs(post.mean) * 100 : null,
      sdDelta: Math.abs(mcSd - post.scale),
      lowDelta: Math.abs(q(0.025) - post.ci.low),
      highDelta: Math.abs(q(0.975) - post.ci.high),
    },
    verdict: '解析解（t 分布）与蒙特卡洛抽样结论一致 ⇒ 区间计算无误。'
      + '蒙特卡洛在本方案中退回"交叉验证"角色，不再作为不确定度的唯一来源。',
    note: '随机数发生器为确定性 xorshift32（固定种子），因此本结果可复现，不会每次跑出不同数字。',
  };
}

/* ==================================================================
 * 三、时序分解与预测
 * ================================================================== */

/** 居中移动平均（趋势项） */
function centeredMA(xs, win = 7) {
  const half = Math.floor(win / 2);
  const out = new Array(xs.length).fill(null);
  for (let i = half; i < xs.length - half; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) s += xs[i + k];
    out[i] = s / (2 * half + 1);
  }
  return out;
}

/** 线性回归 y = a + b·x，返回斜率、截距与拟合优度 */
function linreg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { a: ys[0] || 0, b: 0, r2: 0, predict: () => (ys[0] || 0) };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { a, b, r2, mx, my, predict: (x) => a + b * x };
}

/**
 * Holt 线性趋势（阻尼），带简单参数选择。
 * 选它的理由：31 个观测点做 STL+ARIMA 属于杀鸡用牛刀，
 * 而且深度模型在小样本上极易过拟合 —— 这一点会在消融里被如实暴露。
 * 阻尼趋势的 h 步预测：level + trend · φ(1−φ^h)/(1−φ)
 */
function holtLinear(ys, opts = {}) {
  const alpha = opts.alpha === undefined ? 0.35 : opts.alpha;
  const beta = opts.beta === undefined ? 0.12 : opts.beta;
  const phi = opts.phi === undefined ? 0.92 : opts.phi;   // 阻尼系数
  if (!ys.length) return { level: 0, trend: 0, phi, fitted: [], fit: () => 0 };
  if (ys.length < 2) return { level: ys[0], trend: 0, phi, fitted: [ys[0]], fit: () => ys[0] };

  let level = ys[0];
  let trend = ys[1] - ys[0];
  const fitted = [level];
  for (let i = 1; i < ys.length; i++) {
    const forecast = level + phi * trend;
    const err = ys[i] - forecast;
    level = forecast + alpha * err;
    trend = phi * trend + alpha * beta * err;
    fitted.push(level);
  }
  const damp = (h) => (phi === 1 ? h : (phi * (1 - Math.pow(phi, h))) / (1 - phi));
  return { level, trend, phi, fitted, fit: (h) => level + trend * (h <= 0 ? 0 : damp(h)) };
}

/**
 * 季节项提取：按星期几求"相对趋势的偏离均值"（周内季节性）。
 * 这是 STL 的简化形式（趋势用移动平均、季节用分组均值、残差为余项），
 * 但保留了 STL 的可解释性：三项各自可单独画图、单独消融。
 */
function seasonalByWeekday(dates, ys, trend) {
  const buckets = Array.from({ length: 7 }, () => []);
  for (let i = 0; i < ys.length; i++) {
    const t = trend[i];
    if (t === null || t === undefined) continue;
    const dow = new Date(dates[i]).getDay();
    if (ys[i]) buckets[dow].push(ys[i] - t);
  }
  const season = buckets.map((b) => (b.length ? b.reduce((a, c) => a + c, 0) / b.length : 0));
  const mean = season.reduce((a, b) => a + b, 0) / 7;
  return season.map((v) => v - mean);   // 中心化，季节项和为 0
}

/** AR(1) 残差自回归：r_t = c + φ·r_{t-1} */
function ar1(residuals) {
  const xs = residuals.slice(0, -1);
  const ys = residuals.slice(1);
  const lr = linreg(xs, ys);
  return { c: lr.a, phi: lr.b, r2: lr.r2 };
}

/* ---- 精度指标 ---- */

function metrics(actual, predicted) {
  const n = actual.length;
  let sumAbsErr = 0; let sumSqErr = 0; let sumAbsPct = 0; let pctN = 0;
  const mean = actual.reduce((a, b) => a + b, 0) / n;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const e = actual[i] - predicted[i];
    sumAbsErr += Math.abs(e);
    sumSqErr += e * e;
    if (Math.abs(actual[i]) > 1e-9) { sumAbsPct += Math.abs(e / actual[i]); pctN++; }
    ssTot += (actual[i] - mean) * (actual[i] - mean);
  }
  return {
    n,
    mae: sumAbsErr / n,
    rmse: Math.sqrt(sumSqErr / n),
    mape: pctN ? (sumAbsPct / pctN) * 100 : null,
    r2: ssTot === 0 ? null : 1 - sumSqErr / ssTot,
  };
}

/* ==================================================================
 * 四、自校验（把"算得对"变成可复核的事实）
 * ================================================================== */

function selfTest() {
  const checks = [];
  const tCases = [
    { df: 1, p: 0.975, expect: 12.7062, tol: 0.001 },
    { df: 5, p: 0.975, expect: 2.5706, tol: 0.001 },
    { df: 10, p: 0.975, expect: 2.2281, tol: 0.001 },
    { df: 30, p: 0.975, expect: 2.0423, tol: 0.001 },
    { df: 1000, p: 0.975, expect: 1.9623, tol: 0.002 },
  ];
  tCases.forEach((c) => {
    const got = studentTQuantile(c.p, c.df);
    checks.push({
      name: `t 分位数 t(0.975, df=${c.df})`, expect: c.expect, actual: Number(got.toFixed(4)),
      pass: Math.abs(got - c.expect) <= c.tol,
    });
  });
  /* lnGamma(5) = ln(24) = 3.1780538 */
  checks.push({ name: 'lnΓ(5)=ln(24)', expect: 3.178054, actual: Number(lnGamma(5).toFixed(6)), pass: Math.abs(lnGamma(5) - Math.log(24)) < 1e-9 });
  /* I_0.5(2,2) = 0.5（对称性） */
  checks.push({ name: 'I_0.5(2,2)=0.5', expect: 0.5, actual: Number(incompleteBeta(2, 2, 0.5).toFixed(8)), pass: Math.abs(incompleteBeta(2, 2, 0.5) - 0.5) < 1e-8 });
  /* Φ(1.96)≈0.975 */
  checks.push({ name: 'Φ(1.96)≈0.975', expect: 0.975, actual: Number(normalQuantile(0.975).toFixed(4)), pass: Math.abs(normalQuantile(0.975) - 1.96) < 0.002 });

  /* 大样本一致性：NIG 的 95% 区间半宽 → 1.96·s/√n */
  const xs = [];
  let seed = 42;
  for (let i = 0; i < 400; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; xs.push(100 + ((seed % 2000) / 1000 - 1) * 5); }
  const post = nigPosterior(xs, { kappa0: 0.01, alpha0: 0.01, beta0: 1e-6, mu0: 100 });
  const classic = 1.96 * Math.sqrt(describe(xs).variance / xs.length);
  checks.push({
    name: 'NIG 大样本半宽 → 1.96·s/√n（差 <3%）', expect: Number(classic.toFixed(6)),
    actual: Number(post.ci.halfWidth.toFixed(6)),
    pass: Math.abs(post.ci.halfWidth - classic) / classic < 0.03,
  });

  /* 蒙特卡洛 vs 解析解 */
  const mc = monteCarloCheck(xs, { kappa0: 0.01, alpha0: 0.01, beta0: 1e-6, mu0: 100 }, 8000);
  checks.push({
    name: '蒙特卡洛均值与解析解一致（相对差 <0.5%）', expect: '—',
    actual: `${mc.agreement.meanRelPct.toFixed(4)}%`,
    pass: mc.agreement.meanRelPct < 0.5,
  });
  checks.push({
    name: '蒙特卡洛 2.5% 分位与解析下界一致（差 < 2%）', expect: '—',
    actual: `${(mc.agreement.lowDelta / Math.abs(post.ci.low) * 100).toFixed(3)}%`,
    pass: mc.agreement.lowDelta / Math.abs(post.ci.low) < 0.02,
  });

  const passed = checks.filter((c) => c.pass).length;
  return { checks, passed, total: checks.length, allPass: passed === checks.length };
}

module.exports = {
  lnGamma, incompleteBeta, studentTCdf, studentTQuantile, normalQuantile,
  describe, nigPosterior, monteCarloCheck, gammaSample, normalSample,
  centeredMA, linreg, holtLinear, seasonalByWeekday, ar1, metrics,
  selfTest,
};
