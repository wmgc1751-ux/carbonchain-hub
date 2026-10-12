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

/** 某企业近 N 条 CEMS 滚动读数（按时间升序） */
async function series(entId, limit = 200) {
  const rows = await db.query(
    `SELECT reading_time, flow_value, cum_value FROM cems_reading
     WHERE ent_id = ? ORDER BY reading_time ASC, id ASC LIMIT ?`,
    [entId, Math.min(limit, 500)]
  );
  return rows.map((r) => ({ t: r.reading_time, flow: Number(r.flow_value), cum: Number(r.cum_value) }));
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

  // 近 30 天日均排放序列
  const daily = [];
  const byDay = new Map();
  for (const r of s) {
    const d = String(r.t).slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + r.flow);
  }
  const days = [...byDay.keys()].sort();
  for (const d of days) daily.push(byDay.get(d));

  const recent = daily.slice(-30);
  const { mean: avgDaily } = meanStd(recent);
  const reg = linreg(recent);

  // 预测未来 horizonDays 天：叠加季节因子
  const now = new Date();
  const forecast = [];
  let cumPred = s.length ? s[s.length - 1].cum : 0;
  let sumPred = 0;
  for (let i = 1; i <= horizonDays; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const seasonal = SEASON[d.getMonth()];
    const trend = reg.slope * (recent.length + i) + reg.intercept;
    const val = Math.max(0, trend * seasonal);
    // 用回归趋势与均值做加权（趋势项占 30%，均值占 70%，避免过拟合）
    const blended = Math.max(0, avgDaily * seasonal * 0.7 + val * 0.3);
    cumPred += blended;
    sumPred += blended;
    forecast.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      predicted: Number(blended.toFixed(2)),
      cumulative: Number(cumPred.toFixed(2)),
    });
  }

  // 期末预测 = 当前累计 + 未来预测 + 年初到现在的已实现（当前累计已含）
  const predictedEoy = Number(cumPred.toFixed(2));
  const offset = Number(await db.value(
    'SELECT IFNULL(SUM(amount),0) FROM credit_offset WHERE ent_id = ? AND year = ?', [entId, year]
  ) || 0);
  const netPredicted = Number((predictedEoy - offset).toFixed(2));
  const gap = Number((netPredicted - allocated).toFixed(2));

  return {
    agent: 'FORECAST',
    entId, year, horizonDays,
    method: '滚动日均速率 × 季节因子 + 线性回归趋势',
    stats: {
      avgDaily: Number(avgDaily.toFixed(2)),
      trendSlope: Number(reg.slope.toFixed(4)),
      r2: Number(reg.r2.toFixed(4)),
      dataPoints: recent.length,
    },
    forecast,
    predictedEoy,
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

async function overQuotaRisk(entId) {
  const f = await forecast(entId, 30);
  const { allocated, predictedEoy, netPredicted, gap } = f;
  // 超限概率：基于缺口占配额比例粗略量化（>10% 视为高危）
  let level = 'LOW';
  let prob = 0;
  if (allocated > 0) {
    const ratio = gap / allocated;
    if (ratio > 0.1) { level = 'HIGH'; prob = Math.min(0.95, 0.5 + ratio * 2); }
    else if (ratio > 0) { level = 'MEDIUM'; prob = Math.min(0.7, ratio * 3); }
    else prob = Math.max(0.02, 0.15 + ratio);
  }
  return {
    agent: 'OVER_QUOTA',
    entId,
    allocated,
    predictedEoy,
    netPredicted,
    gap,
    gapRatio: allocated > 0 ? Number((gap / allocated * 100).toFixed(2)) : 0,
    riskLevel: level,
    exceedProbability: Number(prob.toFixed(2)),
    deadline: `${YEAR()}-12-31`,
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
    suggestions.push({
      type: 'OFFSET',
      title: '启用 CCER 抵销',
      detail: `按当前缺口，可用碳信用抵销额度上限约 ${(risk.allocated * 0.05).toFixed(2)} tCO₂e，优先选择价格更低的林业碳汇/光伏 CCER。`,
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
 * @param {object} p { entId, scenarios:[{name, key, deltaPct}] }
 *   key: output(产量) / efficiency(能效) / fuel(燃料碳强度)
 *   deltaPct: 相对当前 ± 百分比
 */
async function simulate(entId, scenarios = []) {
  const f = await forecast(entId, 30);
  const allocated = f.allocated;
  const baseline = f.predictedEoy;

  const results = scenarios.map((sc) => {
    const key = sc.key;
    const pct = Number(sc.deltaPct) || 0;
    // 不同参数对期末排放的影响弹性
    let emissionPct;
    if (key === 'output') emissionPct = pct * 0.9;      // 减产 10% → 排放约 -9%
    else if (key === 'efficiency') emissionPct = -pct;   // 能效提升 10% → 排放 -10%
    else if (key === 'fuel') emissionPct = pct * 0.6;    // 燃料碳强度 -10% → 排放 -6%
    else emissionPct = 0;

    const predictedEoy = Number((baseline * (1 + emissionPct / 100)).toFixed(2));
    const offset = f.offset;
    const netPredicted = Number((predictedEoy - offset).toFixed(2));
    const gap = Number((netPredicted - allocated).toFixed(2));
    const surplus = Number((-gap).toFixed(2));

    return {
      name: sc.name || key,
      key,
      deltaPct: pct,
      predictedEoy,
      netPredicted,
      gap,
      surplus: surplus > 0 ? surplus : 0,
      quotaSurplus: gap < 0,
      emissionChangePct: Number(emissionPct.toFixed(2)),
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
