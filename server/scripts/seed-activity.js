/**
 * seed-activity.js —— 生成企业活动数据台账（正向核算的输入端）
 * ==================================================================================
 * 【这个脚本在做什么，以及为什么这样做】
 *
 * 平台的旧做法是：先有配额 → 用哈希抖动反推排放量 → 生成"实测读数"。
 * 这条链路里，**活动数据这一环从未存在**。于是所有排放量都无法被第三方验证：
 * 你无法回答「这 18 万吨 CO₂ 是从多少吨煤、多少度电算出来的」。
 *
 * 本脚本建立正向链路的第一环：为每家企业生成 12 个月、按排放源分列的
 * 活动数据台账，并带上：
 *   · 计量器具编号与检定有效期（真实的台账要有这个）
 *   · 原始凭证号（发票/磅单/化验单）
 *   · 实测化验值（NCV/CC/OF，用于 Tier2 升级）
 *   · 数据来源分级（L3 实测 / L2 台账 / L1 估算 / L0 缺省）
 *   · 双人复核状态
 *
 * 【数据生成方式 —— 必须说清楚，否则会误导】
 * 这是**合成台账**，不是真实企业的生产数据。生成方式：
 *   ① 取该企业 2026 年已核定的排放量级（来自 emission_report，与配额同量级）；
 *   ② 按行业能源结构把排放量拆到各排放源；
 *   ③ 每种源用「排放量 ÷ 该源因子」反推实物消耗量。
 *
 * 为什么允许「从排放量反推实物量」：
 *   这只是**造测试数据**时的构造技巧，与核算引擎的方向无关。
 *   核算引擎永远是正向的 AD × EF（见 services/methodology.js），
 *   它拿到台账后不会知道、也不会利用这个反推关系。
 *
 * 这样构造带来一个关键好处：新核算结果与旧上报单**能对账**。
 * 两者差异只应来自方法学（是否单列工业过程、是否采用实测化验因子），
 * 而不是量级错位。若量级错位，任何"配额缺口分析"都会得出荒谬结论。
 *
 * 任何对外表述都必须明确这是合成数据（见 tools/data-provenance.mjs 的 L1 分级）。
 *
 * @module scripts/seed-activity
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const M = require('../services/methodology');

const YEAR = 2026;

/**
 * 行业能源结构：各排放源在总排放中的占比区间。
 * 依据行业实际能耗结构设定（例如建材约 60% 来自熟料分解，有色金属以电力为主）。
 * 结构：{ 排放源: [占比下限, 占比上限] }
 *
 * 注意：这些是**排放量占比**，不是能耗占比 —— 两者因因子差异而不同。
 */
const EMISSION_SHARE = {
  电力: { COAL: [0.90, 0.96], GAS: [0.02, 0.05], DIESEL: [0.003, 0.008], POWER: [0.02, 0.05] },
  钢铁: { COAL: [0.28, 0.36], COKE: [0.44, 0.52], GAS: [0.08, 0.13], POWER: [0.06, 0.10] },
  建材: {
    /* 水泥：熟料分解约 60%，煤约 30%，其余为电与油 */
    CEMENT_CLINKER: [0.56, 0.63], COAL: [0.28, 0.34], DIESEL: [0.004, 0.010], POWER: [0.05, 0.09],
  },
  化工: {
    AMONIA_PLACEHOLDER: null, // 占位，实际见下（合成氨原料用气归入 GAS 的燃烧项之外）
    COAL: [0.30, 0.40], GAS: [0.20, 0.30], FUEL_OIL: [0.04, 0.08],
    POWER: [0.14, 0.20], HEAT: [0.10, 0.16], AMMONIA_FEEDSTOCK: [0.06, 0.12],
  },
  有色金属: {
    /* 电解铝：电力占绝对主导（间接排放），阳极与效应为直接排放 */
    POWER: [0.72, 0.80], COAL: [0.06, 0.11], GAS: [0.02, 0.05],
    DIESEL: [0.002, 0.006], ALU_ANODE: [0.07, 0.11], ALU_ANODE_EFFECT: [0.004, 0.010],
  },
  造纸: { COAL: [0.28, 0.36], POWER: [0.30, 0.38], HEAT: [0.26, 0.34], DIESEL: [0.004, 0.010] },
  石化: {
    FUEL_OIL: [0.30, 0.38], GAS: [0.26, 0.34], POWER: [0.14, 0.20],
    COAL: [0.12, 0.18], REFINERY_COKE_BURN: [0.03, 0.07],
  },
};
/* 去掉占位键 */
delete EMISSION_SHARE.化工.AMONIA_PLACEHOLDER;

/**
 * 月度生产季节性系数 —— 真实企业的产量不是平均分布的。
 * 1-2 月春节检修、7-8 月高温限电、11-12 月赶工，这些都会体现在活动数据里。
 * 若台账是「12 个月平均」，任何做过实际核查的人一眼就能看出是编的。
 *
 * 归一化到合计 = 12，保证月度之和 = 年度目标值。
 */
const SEASONAL_RAW = [
  0.88, 0.80, 1.02, 1.05, 1.04, 1.02,   // 1-6 月：春节低谷 + 春季回升
  0.96, 0.95, 1.03, 1.06, 1.08, 1.11,   // 7-12 月：高温限电 + 年末赶工
];
const SEASONAL_SUM = SEASONAL_RAW.reduce((a, b) => a + b, 0);
const SEASONAL = SEASONAL_RAW.map((x) => x * 12 / SEASONAL_SUM);

/** 需要作为「工业过程」录入的源 */
const PROCESS_CODES = new Set(Object.keys(M.PROCESS_FACTORS));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 取该企业 2026 年的目标排放量级。
 * 优先用 emission_report 的实际合计（这是旧口径的"已报数"），
 * 没有则退回 carbon_quota.total_allocated（配额量级），两者同阶。
 */
async function targetEmission(entId, allocated) {
  const v = await db.value(
    'SELECT SUM(total_emission) FROM emission_report WHERE ent_id = ? AND year = ?', [entId, YEAR]
  );
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return Number(allocated) > 0 ? Number(allocated) : 0;
}

/** 取某排放源的排放因子（用于把排放量反推为实物量） */
function efOf(code) {
  const f = M.FUEL_FACTORS[code];
  if (f) return M.getFactor(code).ef;
  const p = M.PROCESS_FACTORS[code];
  if (p) return p.ef;
  return null;
}

/** 取某排放源的活动数据单位 */
function unitOf(code) {
  const f = M.FUEL_FACTORS[code];
  if (f) return f.unit;
  return 't'; // 过程因子统一用 t（熟料/铝/合成氨/原油加工量）
}

/**
 * 生成某企业全部排放源的 12 个月活动数据。
 *
 * @param {object} ent 企业 { id, industry, scale }
 * @param {number} targetTotal 该企业年度目标排放量（tCO2e）
 * @param {number} rngSeed 确定性种子
 * @returns {{rows:Array, plan:Array}} rows 为待插入行，plan 为规划明细（用于自检）
 */
function genForEnterprise(ent, targetTotal, rngSeed) {
  const spec = M.INDUSTRY_SOURCES[ent.industry];
  const shares = EMISSION_SHARE[ent.industry];
  if (!spec || !shares || !(targetTotal > 0)) return { rows: [], plan: [] };

  const rng = mulberry32(rngSeed);
  const codes = [...spec.combustion, ...(spec.indirect || []), ...spec.process]
    .filter((c) => shares[c]);

  /* 先给每个源分配一个占比（在区间内取值），再归一化到 1 —— 
   * 归一化保证各源排放量之和恰好等于目标排放量，不产生量级漂移。 */
  const rawShares = new Map();
  let sum = 0;
  for (const c of codes) {
    const [lo, hi] = shares[c];
    const v = lo + rng() * (hi - lo);
    rawShares.set(c, v);
    sum += v;
  }
  const normShares = new Map([...rawShares].map(([k, v]) => [k, v / sum]));

  const rows = [];
  const plan = [];

  for (const code of codes) {
    const targetEmissionForSrc = targetTotal * normShares.get(code);
    const ef = efOf(code);
    if (!ef || !(ef > 0)) continue;
    const annualQty = targetEmissionForSrc / ef;
    const unit = unitOf(code);
    const isProcess = PROCESS_CODES.has(code);
    const fuel = M.FUEL_FACTORS[code];

    plan.push({
      code, cn: (fuel && fuel.cn) || (M.PROCESS_FACTORS[code] && M.PROCESS_FACTORS[code].cn) || code,
      sharePct: Number((normShares.get(code) * 100).toFixed(2)),
      emission: Number(targetEmissionForSrc.toFixed(1)),
      ef, unit, annualQty: Number(annualQty.toFixed(2)),
    });

    for (let m = 1; m <= 12; m++) {
      const season = SEASONAL[m - 1];
      /* 月度波动：±7% 的确定性扰动（由 企业+源+月 派生，保证可复现） */
      const jSeed = parseInt(cu.sha256(`act|${ent.id}|${code}|${m}`).slice(0, 6), 16);
      const jitter = 0.93 + (jSeed % 140) / 1000;   // 0.93 ~ 1.07
      const qty = (annualQty / 12) * season * jitter;

      /* ── 数据来源分级：真实台账不可能 100% 都是实测 ──
       * 目标分布：L3 实测 60% / L2 台账 33% / L1 估算 5% / L0 缺省 2%
       * 若全部标 L3 反而不可信 —— 而"数据质量治理"这一层也就无从检验。 */
      const roll = parseInt(cu.sha256(`origin|${ent.id}|${code}|${m}`).slice(0, 6), 16) % 1000;
      let origin = 'L3';
      if (roll >= 600 && roll < 930) origin = 'L2';
      else if (roll >= 930 && roll < 980) origin = 'L1';
      else if (roll >= 980) origin = 'L0';

      /* ── 实测化验值（Tier2 升级路径）──
       * 仅 L3 且非每第 3 个月的燃料类数据带化验单。
       * 实测值围绕缺省值波动（煤质波动是真实的），偏差 ±5%。 */
      let measuredNcv = null; let measuredCc = null; let measuredOf = null; let labNo = null;
      if (fuel && fuel.ncv && origin === 'L3' && (jSeed % 3) !== 0) {
        const dev = 0.95 + (jSeed % 100) / 1000;
        measuredNcv = Number((fuel.ncv * dev).toFixed(4));
        measuredCc = Number((fuel.cc * (0.98 + (jSeed % 40) / 1000)).toFixed(4));
        measuredOf = Number(Math.min(1, fuel.of * (0.99 + (jSeed % 20) / 1000)).toFixed(4));
        labNo = `LAB-${YEAR}-${String(ent.id).padStart(3, '0')}-${String(m).padStart(2, '0')}`;
      }

      rows.push({
        ent_id: ent.id, year: YEAR, month: m,
        source_code: code,
        source_type: isProcess ? 'PROCESS' : (fuel && fuel.scope === 2 ? 'INDIRECT' : 'FUEL'),
        quantity: Number(qty.toFixed(4)),
        unit,
        data_origin: origin,
        meter_no: origin === 'L3' ? `MT-${String(ent.id).padStart(3, '0')}-${code.slice(0, 3)}` : null,
        meter_calibrated_until: origin === 'L3' ? `${YEAR}-12-31` : null,
        voucher_no: origin !== 'L0'
          ? `VCH-${YEAR}-${String(ent.id).padStart(3, '0')}-${String(m).padStart(2, '0')}-${code.slice(0, 3)}`
          : null,
        measured_ncv: measuredNcv, measured_cc: measuredCc, measured_of: measuredOf,
        lab_report_no: labNo,
        submitted_by: `ent${String(ent.id).padStart(3, '0')}`,
        /* ── 双人复核制 ──
         * L0（缺省值）与 L1（估算）**不予复核通过**：必须退回补录。
         * 这是真实的内控规则，也是"数据质量"能真正影响核算结果的关键 ——
         * 若所有数据都自动通过复核，质量分级就只是装饰。 */
        reviewed_by: (origin === 'L3' || origin === 'L2') ? 'reviewer01' : null,
        reviewed_at: (origin === 'L3' || origin === 'L2')
          ? `${YEAR}-${String(m).padStart(2, '0')}-28 10:00:00` : null,
        status: (origin === 'L3' || origin === 'L2') ? 'REVIEWED' : 'SUBMITTED',
        remark: origin === 'L0' ? '活动数据缺失，按行业均值暂代（不可用于履约）'
          : (origin === 'L1' ? '工程估算值，待补录原始凭证' : null),
      });
    }
  }

  return { rows, plan };
}

/**
 * 主流程：为全部企业生成活动数据台账。
 * @param {object} [opts] { silent:boolean }
 */
async function seed(opts = {}) {
  const ents = await db.query(
    `SELECT e.id, e.ent_name, e.industry, e.region, e.scale, e.annual_output,
            q.total_allocated
       FROM enterprise e
       LEFT JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ?
      WHERE e.status <> 'SUSPENDED'
      ORDER BY e.id`, [YEAR]
  );

  await db.query('DELETE FROM activity_data WHERE year = ?', [YEAR]);

  const all = [];
  const planAll = [];
  const stats = {
    enterprises: 0, rows: 0, skipped: 0,
    byOrigin: { L3: 0, L2: 0, L1: 0, L0: 0 },
    targetTotal: 0, plannedTotal: 0,
  };

  for (const ent of ents) {
    const target = await targetEmission(ent.id, ent.total_allocated);
    if (!(target > 0)) { stats.skipped++; continue; }
    const { rows, plan } = genForEnterprise(ent, target, 20260917 + Number(ent.id));
    if (!rows.length) { stats.skipped++; continue; }
    stats.targetTotal += target;
    stats.plannedTotal += plan.reduce((s, p) => s + p.emission, 0);
    for (const r of rows) stats.byOrigin[r.data_origin]++;
    all.push(...rows);
    planAll.push({ entId: ent.id, industry: ent.industry, target: Number(target.toFixed(1)), plan });
    stats.enterprises++;
  }

  const cols = ['ent_id', 'year', 'month', 'source_code', 'source_type', 'quantity', 'unit',
    'data_origin', 'meter_no', 'meter_calibrated_until', 'voucher_no',
    'measured_ncv', 'measured_cc', 'measured_of', 'lab_report_no',
    'submitted_by', 'reviewed_by', 'reviewed_at', 'status', 'remark'];
  const vals = all.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c])));

  const CHUNK = 400;
  for (let i = 0; i < vals.length; i += CHUNK) {
    const slice = vals.slice(i, i + CHUNK);
    const ph = slice.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
    await db.pool.query(`INSERT INTO activity_data (${cols.join(',')}) VALUES ${ph}`, slice.flat());
  }

  stats.rows = vals.length;
  const total = Object.values(stats.byOrigin).reduce((a, b) => a + b, 0);
  stats.originPct = Object.fromEntries(
    Object.entries(stats.byOrigin).map(([k, v]) => [k, total ? Number((v / total * 100).toFixed(2)) : 0])
  );
  stats.targetVsPlanned = {
    target: Number(stats.targetTotal.toFixed(1)),
    planned: Number(stats.plannedTotal.toFixed(1)),
    deviationPct: stats.targetTotal > 0
      ? Number((Math.abs(stats.plannedTotal - stats.targetTotal) / stats.targetTotal * 100).toFixed(4))
      : null,
  };

  if (!opts.silent) {
    console.log(`✔ 活动数据台账已生成：${stats.rows} 行 · ${stats.enterprises} 家企业 · ${YEAR} 年 12 个月`);
    console.log(`  数据来源分级：L3 实测 ${stats.originPct.L3}% / L2 台账 ${stats.originPct.L2}%`
      + ` / L1 估算 ${stats.originPct.L1}% / L0 缺省 ${stats.originPct.L0}%`);
    console.log(`  量级对账：目标 ${stats.targetVsPlanned.target} t vs 规划 ${stats.targetVsPlanned.planned} t`
      + `（偏差 ${stats.targetVsPlanned.deviationPct}%，应接近 0）`);
  }
  return stats;
}

module.exports = { seed, EMISSION_SHARE, SEASONAL, YEAR, genForEnterprise };

if (require.main === module) {
  seed()
    .then((s) => {
      console.log(JSON.stringify(s, null, 2));
      return db.pool.end();
    })
    .then(() => process.exit(0))
    .catch((e) => { console.error('✘ 生成失败：', e.message); process.exit(1); });
}
