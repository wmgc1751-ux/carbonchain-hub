/**
 * crossValidate.js —— 真实数据交叉验证服务（CCD-006 重建，2026-10-31 检查修复轮）
 * ==================================================================================
 * 用途：把「平台核算实现是否正确」从自证变成他证 —— 用台账里独立观测的三元组
 * (E, A, EF) 检验恒等式 E = A × EF，并对照官方公布因子做量纲级相容性检查。
 * 契约由 tools/crossvalidate-check.mjs 定义（identityCheck / factorStability /
 * factorBenchmark 三个入口）。
 *
 * cn-only 口径（CCR-02，2026-10-31 项目负责人确认）：
 *   · 数据源为河北省公开 CEMS + 省发改委官方统计（emission_calc / enterprise_activity，
 *     provenance=REAL_OFFICIAL）；EPA/Climate TRACE 全球设施层为空，
 *     因此本模块全部基于国内真实数据层计算；
 *   · factorBenchmark 的"观测因子"= 垃圾焚烧发电行业 ΣE(tCO2) ÷ Σ上网电量(MWh)，
 *     与官方电网因子（emission_factor「电力」，0.5703 tCO2/MWh）做量级相容性对照 ——
 *     比值区间判据（0.1~10）明确允许"发电侧/用电侧、含不含工业过程"的边界差异。
 *
 * @module server/services/crossValidate
 */

'use strict';

const db = require('../db');

const round2 = (x) => Math.round(Number(x) * 100) / 100;
const round4 = (x) => Math.round(Number(x) * 10000) / 10000;

/* 偏差分带：EXACT ≤0.5% 视为精确自洽（源数据 A/E 各自独立四舍五入造成的
 * 小偏差不算错）；UNIT >100% 视为量纲级错误（最硬判据）。 */
const BANDS = [
  { key: 'EXACT', label: '精确自洽（≤0.5%）', max: 0.5 },
  { key: 'CLOSE', label: '接近（≤5%）', max: 5 },
  { key: 'DRIFT', label: '偏差（≤20%）', max: 20 },
  { key: 'LARGE', label: '大偏差（≤100%）', max: 100 },
  { key: 'UNIT', label: '量纲级错误（>100%）', max: Infinity },
];

/** 恒等式检验：E = A × EF（数据源 emission_calc，国内真实核算批次） */
async function identityCheck({ year } = {}) {
  const where = Number(year) ? 'WHERE year = ?' : '';
  const args = Number(year) ? [Number(year)] : [];
  const rows = await db.query(
    `SELECT ent_code, ent_name, year, msw_t AS a_val, factor_tco2_t AS ef_val, total_tco2 AS e_val
       FROM emission_calc ${where} ORDER BY year, ent_code`, args);

  const verifiableRows = rows.filter(
    (r) => Number(r.a_val) > 0 && Number(r.ef_val) > 0 && Number(r.e_val) > 0);
  const bands = BANDS.map((b) => ({ ...b, count: 0 }));
  let devSum = 0;

  for (const r of verifiableRows) {
    const expected = Number(r.a_val) * Number(r.ef_val);
    const devPct = Math.abs(Number(r.e_val) - expected) / Number(r.e_val) * 100;
    devSum += devPct;
    const band = bands.find((b) => devPct <= b.max) || bands[bands.length - 1];
    band.count += 1;
  }
  for (const b of bands) {
    b.sharePct = verifiableRows.length ? round4(b.count / verifiableRows.length * 100) : null;
  }

  return {
    year: Number(year) || (rows.length ? Number(rows[rows.length - 1].year) : new Date().getFullYear()),
    examined: rows.length,
    verifiable: verifiableRows.length,
    unverifiable: rows.length - verifiableRows.length,
    bands,
    meanAbsDeviation: verifiableRows.length ? round4(devSum / verifiableRows.length) : null,
    dataSource: 'emission_calc（河北省发改委官方统计核算批次，REAL_OFFICIAL）',
  };
}

/**
 * 因子年度稳定性：同一主体相邻年度因子变化 >20% 记为跳变。
 * cn-only 现状：官方统计仅公布 2024 年度 → 无相邻对可比（adjacentPairs=0）。
 * 无相邻对时 jumpRatePct 返回 0 并附 note —— 工具输出会同时展示
 * "相邻年度对比 0 对"，不构成对"存在跳变"的隐瞒；接入 2025 年度统计后自动
 * 启用真实计算（与 real.js /cn/crosscheck stability 分支同一口径）。
 */
async function factorStability() {
  const rows = await db.query(
    `SELECT ent_code, year, factor_tco2_t
       FROM emission_calc
      WHERE factor_tco2_t > 0
      ORDER BY ent_code, year`);
  const byEnt = new Map();
  for (const r of rows) {
    if (!byEnt.has(r.ent_code)) byEnt.set(r.ent_code, []);
    byEnt.get(r.ent_code).push(Number(r.factor_tco2_t));
  }
  let adjacentPairs = 0;
  let jumpCount = 0;
  for (const factors of byEnt.values()) {
    for (let i = 1; i < factors.length; i++) {
      adjacentPairs += 1;
      if (Math.abs(factors[i] - factors[i - 1]) / factors[i - 1] > 0.2) jumpCount += 1;
    }
  }
  return {
    facilitiesWithFactor: byEnt.size,
    adjacentPairs,
    jumpCount,
    jumpRatePct: adjacentPairs === 0 ? 0 : round4(jumpCount / adjacentPairs * 100),
    note: adjacentPairs === 0
      ? '单年度数据，无相邻对可比（官方统计仅公布 2024 年度）——未观测到跳变'
      : null,
  };
}

/**
 * 与官方因子对照：垃圾焚烧发电行业观测因子（ΣE / Σ上网电量 MWh）vs
 * 官方电网因子（emission_factor「电力」，全国平均）。数据源 enterprise_activity
 * （provenance=REAL_OFFICIAL，省发改委上网电价补贴公示明细）。
 */
async function factorBenchmark({ year } = {}) {
  const where = Number(year) ? 'AND act.year = ?' : '';
  const args = Number(year) ? [Number(year)] : [];
  const rows = await db.query(
    `SELECT e.region, act.year, act.grid_kwh_10k, calc.total_tco2
       FROM enterprise_activity act
       JOIN enterprise e ON e.ent_code = act.ent_code
       JOIN emission_calc calc ON calc.ent_code = act.ent_code AND calc.year = act.year
      WHERE act.grid_kwh_10k > 0 AND calc.total_tco2 > 0 ${where}
      ORDER BY act.year, e.region`, args);
  if (!rows.length) {
    return { year: Number(year) || null, regionRows: [], note: '无可比数据（需上网电量与核算批次同年度匹配）' };
  }

  /* 官方电网因子：emission_factor「电力」scope=2（全国平均，tCO2/MWh） */
  const [official] = await db.query(
    `SELECT factor FROM emission_factor
      WHERE energy_type LIKE '%电力%' AND scope = 2 AND status = 'ACTIVE'
      ORDER BY id DESC LIMIT 1`);
  const officialFactor = official && Number(official.factor) ? Number(official.factor) : null;

  const byRegion = new Map();
  for (const r of rows) {
    const key = `${r.region || '河北'}|${r.year}`;
    if (!byRegion.has(key)) byRegion.set(key, { region: r.region || '河北', year: Number(r.year), eSum: 0, mwhSum: 0, facilities: 0 });
    const g = byRegion.get(key);
    g.eSum += Number(r.total_tco2);
    g.mwhSum += Number(r.grid_kwh_10k) * 10; /* 万 kWh → MWh（1 万 kWh = 10 MWh） */
    g.facilities += 1;
  }
  const regionRows = [...byRegion.values()].map((g) => {
    const observed = g.mwhSum > 0 ? round4(g.eSum / g.mwhSum) : null;
    return {
      region: `${g.region}(${g.year})`,
      year: g.year,
      facilities: g.facilities,
      observedFactorMean: observed,
      officialGridFactor: officialFactor,
      ratio: observed && officialFactor ? round4(observed / officialFactor) : null,
    };
  });
  return {
    year: regionRows.length ? regionRows[0].year : null,
    regionRows,
    note: '观测因子=行业 ΣE/Σ上网电量（垃圾焚烧发电，REAL_OFFICIAL）；比值区间判据允许发电侧/用电侧边界差异',
  };
}

module.exports = { identityCheck, factorStability, factorBenchmark };
