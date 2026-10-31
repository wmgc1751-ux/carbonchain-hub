/**
 * services/derive.js —— 「企业只提供 CEMS，其余平台派生」核算引擎
 * ==================================================================================
 * 场景设定
 *   企业侧交付物只有一样：CEMS 小时实测数据（cems_cn_hourly，河北省平台原始报文）。
 *   上报单、核查任务、配额、清缴这些业务对象，企业没有人力也没有口径去填。
 *   平台侧承担这个换算责任，但**换算必须可辩护**：每条派生记录都要能指认
 *   它用到的真实输入、所用规则、以及规则本身的适用边界。
 *
 * 三条硬纪律（这是本模块存在的理由）
 *   ① 派生 ≠ 编造。source_kind='NONE' 的记录在库层面被 CHECK 拒绝。
 *   ② 派生值不冒充实测值。emission_report.is_real 恒为 0；真实性与否由
 *      layer 字段表达，不由"看起来像真的"表达。
 *   ③ 边界写进数据，不写在 PPT 里。limitation 字段必须写"这条值不能证明什么"，
 *      且随记录一起上链 —— 事后无法悄悄改口。
 *
 * 派生链（自下而上，每一跳都有真实输入）
 *   cems_cn_hourly（REAL 实测）
 *     └─ ① 污染物年/季排放量汇总          layer=DERIVED  confidence=HIGH（纯求和，可逆）
 *     └─ ② 季度时间权重                    layer=DERIVED  confidence=HIGH（烟气量占比，纯算术）
 *     └─ ③ 季度烟气排放量                  layer=MODELED  confidence=MEDIUM（含分配假设）
 *     └─ ④ 官方活动水平 CO₂                layer=REAL     confidence=HIGH（官方统计原值）
 *     └─ ⑤ 季度 CO₂ = ④ × ②                layer=MODELED  confidence=MEDIUM（含分配假设）
 *           → emission_report（is_real=0, data_source='DERIVED_FROM_CEMS'）
 *     └─ ⑥ 核查任务                       由现有 /reports/:id/submit 流程自动生成
 *
 * ⚠ 已知且必须披露的口径缝隙
 *   GB 18485 焚烧 CEMS 监测 5 项污染物（烟尘/SO₂/NOx/CO/HCl），**不含 CO₂**。
 *   所以 CO₂ 不可能从 CEMS 直接读出。本模块的 CO₂ 来自官方处理量 × 排放因子，
 *   CEMS 在本模块中的作用是：
 *     (a) 提供污染物排放量本身（真实实测，原生字段，可直接用于达标判定）；
 *     (b) 提供全年排放活动的时间分布形状（哪个月烧得多），用于把年度 CO₂ 拆到季度。
 *   把 CEMS 说成"能测 CO₂"是假的；把没有 CEMS 的季度占比"平摊"也是编造。
 */

'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');

/* 焚烧行业每吨生活垃圾烟气量典型区间（m³/t）。
 * 取自《生活垃圾焚烧发电厂技术规范》与行业环评实测区间 4000–6000。
 * 用途只有一个：判断 CEMS 覆盖的是全厂还是单个排口 —— 不做任何数值修正。 */
const TYPICAL_GAS_PER_TON = { min: 4000, max: 6000 };

const R = (x, n = 2) => (x === null || x === undefined || Number.isNaN(Number(x))
  ? null : Number(Number(x).toFixed(n)));

/* ==================================================================
 * 血缘写入：所有派生结果必须留痕，否则不允许入库
 * ================================================================== */
async function trace({
  targetTable, targetId, targetLabel, sourceKind, sourceRef, sourceDetail,
  ruleCode, ruleExpr, layer = 'DERIVED', confidence = 'HIGH',
  limitation = null, reviewHint = null, chainTxId = null,
}) {
  if (!sourceKind || sourceKind === 'NONE') {
    throw new Error('派生数据缺少真实输入来源（source_kind 不能为空）—— 拒绝入库');
  }
  await db.query(
    `INSERT INTO derivation_log
      (target_table, target_id, target_label, source_kind, source_ref, source_detail,
       rule_code, rule_expr, layer, confidence, limitation, review_hint, chain_tx_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'platform-derivation')
     ON DUPLICATE KEY UPDATE
       target_label=VALUES(target_label), source_ref=VALUES(source_ref),
       source_detail=VALUES(source_detail), rule_expr=VALUES(rule_expr),
       layer=VALUES(layer), confidence=VALUES(confidence),
       limitation=VALUES(limitation), review_hint=VALUES(review_hint),
       chain_tx_id=VALUES(chain_tx_id)`,
    [targetTable, targetId, targetLabel, sourceKind, sourceRef,
      sourceDetail ? JSON.stringify(sourceDetail) : null,
      ruleCode, ruleExpr, layer, confidence, limitation, reviewHint, chainTxId]
  );
}

/* ==================================================================
 * 排口归属：CEMS 的 ent_name 与 enterprise 表按名称前缀匹配
 * 名称来源于省平台原样字符串，企业主表名称可能带/不带「有限公司」，
 * 因此用「去后缀后前缀包含」做匹配，并强制要求唯一命中 —— 命中多家就报错，
 * 不许猜。
 * ================================================================== */
function normalizeName(s) {
  return String(s || '')
    .replace(/[\s（）()]/g, '')
    .replace(/有限(责任)?公司|股份有限公司|公司/g, '')
    .trim();
}

async function resolveEnterprise(cemsEntName) {
  const target = normalizeName(cemsEntName);
  const ents = await db.query('SELECT id, ent_code, ent_name, industry, region FROM enterprise');
  const hits = ents.filter((e) => {
    const n = normalizeName(e.ent_name);
    return n === target || n.startsWith(target) || target.startsWith(n);
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`CEMS 企业名「${cemsEntName}」匹配到 ${hits.length} 家主体：`
      + hits.map((h) => `#${h.id} ${h.ent_name}`).join('、') + ' —— 拒绝猜测归属');
  }
  return null;
}

/* ==================================================================
 * ① 覆盖率登记
 *   只做判定与登记，绝不拿覆盖比例去"修正"实测值。
 * ================================================================== */
async function computeCoverage() {
  /* 2026-10-30 扩口后口径变更：
   *   原先四家企业各只接入 1 个排口，按 (ent_name, outlet_name, year) 分组即可。
   *   补齐后 65 有 3 个、66/67/68 各 2 个排口。若仍逐排口与「全厂处理量」相比，
   *   每行都必然得出「覆盖率偏低 → 仅覆盖单个排口」的结论（实际已覆盖全厂）。
   *   故同时登记两种口径：
   *     · outlet_name = 具体排口名 —— 单排口观测值，仅作明细
   *     · outlet_name = '(全厂合计)' —— 该企业当年全部排口之和，用于与官方处理量比对
   *   覆盖判定只依据后者。 */
  const rows = await db.query(
    `SELECT ent_name, outlet_name, YEAR(monitored_at) AS y,
            SUM(is_valid) AS valid_hours, COUNT(*) AS total_hours,
            SUM(CASE WHEN is_valid=1 THEN flue_gas_m3 ELSE 0 END) AS gas
       FROM cems_cn_hourly
      GROUP BY ent_name, outlet_name, YEAR(monitored_at)
      UNION ALL
     SELECT ent_name, '(全厂合计)' AS outlet_name, YEAR(monitored_at) AS y,
            SUM(is_valid) AS valid_hours, COUNT(*) AS total_hours,
            SUM(CASE WHEN is_valid=1 THEN flue_gas_m3 ELSE 0 END) AS gas
       FROM cems_cn_hourly
      GROUP BY ent_name, YEAR(monitored_at)`
  );
  const act = await db.query(
    `SELECT ent_code, ent_name, year, SUM(msw_10kt) AS msw FROM enterprise_activity
      GROUP BY ent_code, ent_name, year`
  );
  const out = [];
  for (const r of rows) {
    const ent = await resolveEnterprise(r.ent_name);
    if (!ent) continue;
    const gasM3 = Number(r.gas || 0);
    /* 官方处理量按企业名匹配（恒能保定分一期/二期，需按前缀汇总） */
    const key = normalizeName(r.ent_name);
    const a = act.filter((x) => {
      const n = normalizeName(x.ent_name);
      return n === key || n.startsWith(key) || key.startsWith(n);
    }).filter((x) => Number(x.year) === Number(r.y));
    const msw10kt = a.length ? a.reduce((s, x) => s + Number(x.msw), 0) : null;
    const gasPerTon = msw10kt && Number(msw10kt) > 0
      ? gasM3 / (Number(msw10kt) * 1e4) : null;

    /* 覆盖判定：只有拿得到官方处理量才能判。拿不到就写 NULL（=未知），不假设 100%。
     * 且只有「全厂合计」口径才能与官方处理量（全厂口径）相比；
     * 单排口行一律记 NULL —— 分子是单排口、分母是全厂，比出来没有意义。 */
    const isPlantWide = r.outlet_name === '(全厂合计)';
    let ratio = null;
    let basis = null;
    if (!isPlantWide) {
      basis = msw10kt
        ? '单排口口径：分子为本排口实测烟气量，分母为全厂官方处理量，两者不可直接相比；'
          + '全厂覆盖判定见同企业「(全厂合计)」行'
        : '单排口口径，且该年度无可比对的官方处理量；全厂覆盖判定见「(全厂合计)」行';
    } else if (gasPerTon !== null) {
      const mid = (TYPICAL_GAS_PER_TON.min + TYPICAL_GAS_PER_TON.max) / 2;
      ratio = R(gasPerTon / mid, 4);
      if (gasPerTon < TYPICAL_GAS_PER_TON.min) {
        basis = `全厂合计口径：每吨垃圾烟气量 ${gasPerTon.toFixed(0)} m³/t，低于行业典型区间 `
          + `${TYPICAL_GAS_PER_TON.min}–${TYPICAL_GAS_PER_TON.max}；`
          + '判定：已接入的全部排口合计仍低于典型值，说明全厂尚有排口未接入，或官方处理量口径含非焚烧来源';
      } else {
        basis = `全厂合计口径：每吨垃圾烟气量 ${gasPerTon.toFixed(0)} m³/t，落在行业典型区间 `
          + `${TYPICAL_GAS_PER_TON.min}–${TYPICAL_GAS_PER_TON.max} 内；`
          + '判定：已接入排口合计与全厂处理量量级相当，可视为覆盖全厂焚烧烟气';
      }
    } else {
      basis = '该年度无可比对的官方处理量，全厂覆盖比例未知 —— 记为 NULL，不假设为 100%';
    }

    const note = isPlantWide
      ? (ratio === null ? null
        : '全厂合计口径，可直接用于判定 CEMS 对全厂焚烧烟气的覆盖程度')
      : null;

    await db.query(
      `INSERT INTO cems_coverage
        (ent_id, year, outlet_name, valid_hours, expected_hours, flue_gas_10k_m3,
         official_msw_10kt, gas_per_ton_m3, typical_min, typical_max,
         coverage_ratio, coverage_basis, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         valid_hours=VALUES(valid_hours), expected_hours=VALUES(expected_hours),
         flue_gas_10k_m3=VALUES(flue_gas_10k_m3), official_msw_10kt=VALUES(official_msw_10kt),
         gas_per_ton_m3=VALUES(gas_per_ton_m3), coverage_ratio=VALUES(coverage_ratio),
         coverage_basis=VALUES(coverage_basis), note=VALUES(note)`,
      [ent.id, Number(r.y), r.outlet_name, Number(r.valid_hours), Number(r.total_hours),
        R(gasM3 / 1e4, 2), msw10kt === null ? null : R(msw10kt, 4),
        gasPerTon === null ? null : R(gasPerTon, 2),
        TYPICAL_GAS_PER_TON.min, TYPICAL_GAS_PER_TON.max, ratio, basis, note]
    );
    out.push({ entId: ent.id, entName: ent.ent_name, year: Number(r.y), outlet: r.outlet_name,
      validHours: Number(r.valid_hours), gasPerTon: gasPerTon === null ? null : R(gasPerTon, 1),
      coverageRatio: ratio });
  }
  return out;
}

/* ==================================================================
 * ② 污染物排放量汇总（REAL 实测的纯求和，layer=DERIVED，confidence=HIGH）
 * ================================================================== */
async function summarizePollutants(entId, entName, year) {
  const rows = await db.query(
    `SELECT MONTH(monitored_at) AS mo, SUM(is_valid) AS valid_hours,
            SUM(pm_emission_kg) AS pm, SUM(so2_emission_kg) AS so2,
            SUM(nox_emission_kg) AS nox, SUM(co_emission_kg) AS co,
            SUM(hcl_emission_kg) AS hcl, SUM(flue_gas_m3) AS gas,
            MIN(batch_no) AS batch0, MAX(batch_no) AS batch1,
            COUNT(*) AS n
       FROM cems_cn_hourly
      WHERE ent_name LIKE ? AND YEAR(monitored_at) = ? AND is_valid = 1
      GROUP BY MONTH(monitored_at) ORDER BY mo`,
    [`${String(entName).replace(/有限(责任)?公司$/, '').slice(0, 10)}%`, year]
  );
  if (!rows.length) return null;

  const q = [1, 2, 3, 4].map((i) => ({ quarter: i, so2: 0, nox: 0, pm: 0, co: 0, hcl: 0, gas: 0, hours: 0, rows: 0 }));
  for (const r of rows) {
    const qi = Math.floor((Number(r.mo) - 1) / 3);
    const t = q[qi];
    t.so2 += Number(r.so2 || 0); t.nox += Number(r.nox || 0); t.pm += Number(r.pm || 0);
    t.co += Number(r.co || 0); t.hcl += Number(r.hcl || 0); t.gas += Number(r.gas || 0);
    t.hours += Number(r.valid_hours || 0); t.rows += Number(r.n);
  }
  const yearGas = q.reduce((s, x) => s + x.gas, 0);
  q.forEach((x) => { x.share = yearGas > 0 ? R(x.gas / yearGas, 6) : null; });

  /* 分摊比必须精确闭合到 1。
   * 四舍五入到 6 位后各自独立舍入，合计可能是 0.999999。
   * 对 30 万 t 的年度基数，1e-6 的缺口就是 0.31 t —— 四张单加起来
   * 对不上官方基数，核查时会被当成"少报"。把残差并入占比最大的季度，
   * 既保证合计=1，又把对任何单季的扰动压到最小。 */
  if (yearGas > 0) {
    const sumShare = q.reduce((s, x) => s + x.share, 0);
    const residual = R(1 - sumShare, 6);
    if (residual !== 0) {
      const maxIdx = q.reduce((mi, x, i) => (x.share > q[mi].share ? i : mi), 0);
      q[maxIdx].share = R(q[maxIdx].share + residual, 6);
      q[maxIdx].shareAdjusted = residual;
    }
  }

  return {
    year, quarters: q,
    yearTotals: {
      so2Kg: R(q.reduce((s, x) => s + x.so2, 0), 3),
      noxKg: R(q.reduce((s, x) => s + x.nox, 0), 3),
      pmKg: R(q.reduce((s, x) => s + x.pm, 0), 3),
      coKg: R(q.reduce((s, x) => s + x.co, 0), 3),
      hclKg: R(q.reduce((s, x) => s + x.hcl, 0), 3),
      flueGasM3: R(yearGas, 1),
      validHours: q.reduce((s, x) => s + x.hours, 0),
    },
    batchRange: `${rows[0].batch0} … ${rows[rows.length - 1].batch1}`,
  };
}

/* ==================================================================
 * ③④⑤ 生成季度上报单
 *
 * CO₂ 来源的优先级（严格，不降级猜测）：
 *   A. emission_calc（官方处理量 × 排放因子，DB11/T 1416 附录A）—— 首选
 *   B. enterprise_activity（官方处理量） × 因子 —— 当 A 缺该年度时现算
 *   C. 两者都无 → **不生成 CO₂ 上报单**，只登记污染物，并在结果里明确报出
 *      缺什么、去哪补。绝不按"行业均值"填一个数。
 * ================================================================== */
async function deriveQuarterlyReports(ent, year, opts = {}) {
  const sum = await summarizePollutants(ent.id, ent.ent_name, year);
  if (!sum) return { skipped: 'NO_CEMS_DATA', reason: `${year} 年无有效 CEMS 数据` };

  /* ---- CO₂ 基数 ---- */
  const normEnt = normalizeName(ent.ent_name);
  const calc = await db.query(
    'SELECT * FROM emission_calc WHERE year = ? AND (ent_name = ? OR ent_name LIKE ?)',
    [year, ent.ent_name, `${ent.ent_name.replace(/有限(责任)?公司$/, '')}%`]
  );
  const acts = await db.query('SELECT * FROM enterprise_activity WHERE year = ?', [year]);
  const myActs = acts.filter((a) => {
    const n = normalizeName(a.ent_name);
    return n === normEnt || n.startsWith(normEnt) || normEnt.startsWith(n);
  });

  let co2Total = null;
  let co2Basis = null;
  let co2SourceKind = null;
  let co2SourceRef = null;
  let co2Layer = 'REAL';
  let co2Confidence = 'HIGH';
  let co2Limitation = null;
  let factor = null;
  let extrapolated = false;

  if (calc.length) {
    co2Total = calc.reduce((s, x) => s + Number(x.total_tco2), 0);
    co2Basis = calc[0].factor_ref;
    factor = R(calc[0].factor_tco2_t, 6);
    co2SourceKind = 'OFFICIAL_ACTIVITY';
    co2SourceRef = `emission_calc#${calc.map((x) => x.id).join(',')}`;
  } else if (myActs.length) {
    factor = 0.390; // DB11/T 1416—2017 附录A 化石碳因子
    const mswT = myActs.reduce((s, x) => s + Number(x.msw_10kt) * 1e4, 0);
    co2Total = mswT * factor * 0.95; // OF=95%
    co2Basis = 'DB11/T 1416—2017 附录A（化石碳 0.390 tCO₂/t × 氧化率 95%）';
    co2SourceKind = 'OFFICIAL_ACTIVITY';
    co2SourceRef = `enterprise_activity#${myActs.map((x) => x.id).join(',')}`;
  } else if (opts.extrapolate) {
    /* ---- 外推路径：官方处理量尚未公布的年度 ----
     *
     * 允许外推的唯一理由是：企业只交 CEMS，不可能自己填活动水平；
     * 若平台连外推都不做，这些年度在系统里就是空白，业务链断掉。
     *
     * 但外推值绝不能与官方值同等待遇：
     *   · layer = MODELED, confidence = LOW —— 与「官方活动水平 × 分摊」的 MEDIUM 再降一级
     *   · limitation 必须写明「这是外推，不是实测，也不是官方统计」
     *   · 核查任务会带「需补充官方活动水平」的标记，而不是照常放行
     *
     * 外推算式只用两个真实量：上一年官方处理量 × 本年/上年实测烟气量比。
     * 假设只有一个：垃圾处理量与烟气产生量同比例变化。
     * 该假设在焚烧厂稳定运行期成立，在停炉检修年会被打破 —— 所以必须可复核。 */
    const prev = await db.query(
      'SELECT * FROM enterprise_activity WHERE year = ?', [year - 1]
    );
    const prevMine = prev.filter((a) => {
      const n = normalizeName(a.ent_name);
      return n === normEnt || n.startsWith(normEnt) || normEnt.startsWith(n);
    });
    if (prevMine.length) {
      const prevGas = await db.value(
        `SELECT SUM(flue_gas_m3) FROM cems_cn_hourly
          WHERE ent_name LIKE ? AND YEAR(monitored_at) = ? AND is_valid = 1`,
        [`${String(ent.ent_name).replace(/有限(责任)?公司$/, '').slice(0, 10)}%`, year - 1]
      );
      const curGas = sum.yearTotals.flueGasM3;
      if (prevGas && Number(prevGas) > 0 && curGas) {
        const gasRatio = Number(curGas) / Number(prevGas);
        const prevMswT = prevMine.reduce((s, x) => s + Number(x.msw_10kt) * 1e4, 0);
        const estMswT = prevMswT * gasRatio;
        factor = 0.390;
        co2Total = estMswT * factor * 0.95;
        extrapolated = true;
        co2Layer = 'MODELED';
        co2Confidence = 'LOW';
        co2Basis = `外推：${year - 1} 年官方处理量 ${R(prevMswT / 1e4, 2)} 万t `
          + `× 本年/上年实测烟气量比 ${R(gasRatio, 4)} × 因子 0.390 × 氧化率 0.95`;
        co2SourceKind = 'DERIVATION';
        co2SourceRef = `enterprise_activity#${prevMine.map((x) => x.id).join(',')}(基年 ${year - 1})`
          + ` + cems_cn_hourly[${year - 1} 与 ${year} 全年有效小时烟气量]`;
        co2Limitation = `⚠ 本年度 CO₂ 为**外推值，不是实测值，也不是官方统计值**。`
          + `${year} 年省级垃圾处理量统计表尚未公布，本值由 ${year - 1} 年官方处理量 `
          + `× 实测烟气量同比变化外推得到。前提假设「处理量与烟气量同比例变化」，`
          + `在停炉检修、扩产、垃圾热值大幅波动时不成立。`
          + `核查必须以省级统计表原始数据复核；未复核前不得用于配额清缴结论。`;
      }
    }
  }

  if (co2Total === null) {
    return {
      skipped: 'NO_OFFICIAL_ACTIVITY',
      reason: `${year} 年既无 emission_calc 也无 enterprise_activity，`
        + '且未取得可外推的上年官方基数；按纪律不生成 CO₂ 上报单（污染物汇总仍已留存）',
      pollutants: sum,
    };
  }

  /* ---- 强度分母：用官方上网电量，不用产值 ----
   *
   * emission_report.intensity 的原始定义是"单位产值碳排放"(tCO₂/万元)，
   * 但这 4 家企业的 annual_output 为 null —— 没有产值数据。
   * 若留成 0，公示大屏"平均强度"会显示 0，看起来像"零碳企业"，
   * 比显示"—"更误导。
   *
   * 强度并非没有真实分母：垃圾焚烧发电的核心产出是**上网电量**，
   * 官方统计表里就有（万kWh）。用"单位上网电量碳强度"(tCO₂/万kWh)，
   * 与配额分配的基准线口径一致，分母是官方值。
   *
   * 口径不同必须标出来：output_value 存上网电量（万kWh），
   * intensity 存 tCO₂/万kWh，单位写进 remark，
   * 避免有人把 12.4 误读成"每万元产值 12.4 吨"。 */
  let gridWanKwh = null;
  {
    const acts = await db.query('SELECT * FROM enterprise_activity WHERE year = ?', [year]);
    const mine = acts.filter((a) => {
      const n = normalizeName(a.ent_name);
      return n === normEnt || n.startsWith(normEnt) || normEnt.startsWith(n);
    });
    if (mine.length) {
      gridWanKwh = mine.reduce((s, x) => s + Number(x.grid_kwh_10k || 0), 0);
      if (!(gridWanKwh > 0)) gridWanKwh = null;
    }
  }

  /* ---- 逐季度生成 ---- */
  const created = [];
  for (const q of sum.quarters) {
    const period = `${year}Q${q.quarter}`;
    const exists = await db.one(
      'SELECT * FROM emission_report WHERE ent_id = ? AND year = ? AND quarter = ?',
      [ent.id, year, q.quarter]
    );
    if (exists) {
      /* 幂等补录：上一轮可能在上报单已入库、血缘尚未写入时中断。
       * 无血缘的派上报单等于无法追溯的申报值 —— 必须补齐，不能跳过。 */
      const hasLineage = await db.value(
        "SELECT COUNT(*) FROM derivation_log WHERE target_table='emission_report' AND target_id=?",
        [exists.id]
      );
      if (Number(hasLineage) === 0 && exists.data_source === 'DERIVED_FROM_CEMS') {
        const backCo2 = R(co2Total * q.share, 2);
        await trace({
          targetTable: 'emission_report', targetId: exists.id,
          targetLabel: `${ent.ent_name} ${period} CO₂（补录血缘）`,
          sourceKind: 'DERIVATION',
          sourceRef: `${co2SourceRef} + cems_cn_hourly[${year} 全年, batch ${sum.batchRange}]`,
          sourceDetail: {
            annualCo2: R(co2Total, 2), quarterShare: q.share, quarterCo2: backCo2,
            storedByReport: R(exists.total_emission, 2),
            matchStored: Math.abs(backCo2 - Number(exists.total_emission)) < 0.02,
            factor, basis: co2Basis,
          },
          ruleCode: 'CO2_ANNUAL_X_CEMS_GAS_SHARE',
          ruleExpr: `季度CO₂ = 年度CO₂(${R(co2Total, 2)} t) × 当季烟气量占全年比(${(q.share * 100).toFixed(2)}%)`,
          layer: 'MODELED', confidence: 'MEDIUM',
          limitation: 'CO₂ 不是 CEMS 实测值。CEMS（GB 18485 口径）只测烟尘/SO₂/NOx/CO/HCl，不含 CO₂。'
            + '本季 CO₂ = 官方年度活动水平法核算值 × 当季实测烟气量占比。'
            + '「年度总量」可辩护，「季度分配」是分配假设，不能主张为实测。',
          reviewHint: '本条为历史孤儿单补录，应验算存值是否与规则算式一致（见 source_detail.matchStored）',
        });
        await trace({
          targetTable: 'emission_report', targetId: exists.id,
          targetLabel: `${ent.ent_name} ${period} 污染物（补录血缘）`,
          sourceKind: 'CEMS_HOURLY',
          sourceRef: `cems_cn_hourly WHERE YEAR=${year} AND QUARTER=${q.quarter} AND is_valid=1`,
          sourceDetail: {
            rows: q.rows, validHours: q.hours, so2Kg: R(q.so2, 3), noxKg: R(q.nox, 3),
            pmKg: R(q.pm, 3), coKg: R(q.co, 3), hclKg: R(q.hcl, 3), flueGasM3: R(q.gas, 1),
          },
          ruleCode: 'CEMS_POLLUTANT_SUM',
          ruleExpr: '季度污染物排放量 = Σ(该季有效小时 so2/nox/pm/co/hcl_emission_kg)',
          layer: 'DERIVED', confidence: 'HIGH',
          limitation: '本次核算汇总了该企业已接入的全部废气排口（见 cems_coverage 中「(全厂合计)」行）；若全厂尚有排口未接入，此处仍为部分覆盖，覆盖程度见 coverage_ratio（未知时为空）。',
          reviewHint: '核查应比对省平台同批次原始小时数据',
        });
        created.push({ quarter: q.quarter, reportId: exists.id, backfilled: true });
      } else {
        created.push({ quarter: q.quarter, skipped: 'EXISTS', reportId: exists.id });
      }
      continue;
    }
    if (q.share === null) {
      created.push({ quarter: q.quarter, skipped: 'NO_SHARE_WEIGHT' });
      continue;
    }

    const qCo2 = R(co2Total * q.share, 2);
    const reportNo = cu.bizNo('ER');
    const dataSource = 'DERIVED_FROM_CEMS';

    /* 季度上网电量按同一时间权重拆分（与 CO₂ 同比例），
     * 强度 = 季度 CO₂ / 季度上网电量（tCO₂/万kWh）。 */
    const qGrid = gridWanKwh ? R(gridWanKwh * q.share, 2) : 0;
    const qIntensity = qGrid > 0 ? R(qCo2 / qGrid, 4) : 0;
    const remark = gridWanKwh
      ? `CO₂ 为派生值（官方活动水平×实测烟气量占比）；强度口径为 tCO₂/万kWh 上网电量，`
        + `非 tCO₂/万元产值（本企业无产值数据）。CEMS 只提供污染物实测与时间分布。`
      : `CO₂ 为派生值；本年度无官方上网电量，强度无法计算（留 0 而非估算）。`;

    const [ins] = await db.pool.query(
      `INSERT INTO emission_report
        (report_no, ent_id, year, quarter, period, scope1_emission, scope2_emission, total_emission,
         energy_consumption, output_value, intensity, yoy_rate, data_source, status,
         created_at, is_real, co2_only, biogenic_co2, remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),0,?,?,?)`,
      [reportNo, ent.id, year, q.quarter, period, qCo2, 0, qCo2,
        0, qGrid, qIntensity, 0, dataSource, opts.submit ? 'SUBMITTED' : 'DRAFT',
        qCo2, null, remark]
    );
    const reportId = ins.insertId;

    /* 明细行分两类，必须分清 —— 这两类在语义上不是一回事：
     *
     *   ① CO₂ 来源行：本季 CO₂ 的来路（生活垃圾焚烧 × 化石碳因子）。
     *      co2 字段填本季分摊值，这才构成"排放构成"图的扇区。
     *      没有这一行，前端画出来的排放构成是全 0（而汇总字段是对的），
     *      属于静默错误：页面不报错，数字却没意义。
     *
     *   ② CEMS 污染物行：SO₂/NOx/颗粒物/CO/HCl 的实测汇总。
     *      amount 是污染物吨数，co2 恒为 0 —— 污染物本身不是 CO₂ 排放源。
     *      它们的作用是留取证，不是参与碳核算。
     *
     * 混在一起画图会让人以为"SO₂ 贡献了多少 CO₂"。
     * 因此 ① 的 calc_method 不含 'CEMS' 前缀，② 的都带，
     * 供前端/接口按前缀区分。 */
    await db.query(
      `INSERT INTO emission_item (report_id, ent_id, energy_type, scope, amount, unit, factor, co2, calc_method)
       VALUES (?,?,?,1,?,?,?,?,?)`,
      [reportId, ent.id, '生活垃圾焚烧（化石碳）',
        qGrid > 0 ? R(qGrid, 2) : R(qCo2 / 0.390, 2),
        qGrid > 0 ? '万kWh' : 't原料',
        gridWanKwh ? R(0.390, 6) : R(0.390, 6),
        qCo2, '活动水平法（官方处理量×化石碳因子）']
    );

    const items = [
      ['SO₂（CEMS 实测）', q.so2 / 1000, 't', 'CEMS实测汇总'],
      ['NOx（CEMS 实测）', q.nox / 1000, 't', 'CEMS实测汇总'],
      ['颗粒物（CEMS 实测）', q.pm / 1000, 't', 'CEMS实测汇总'],
      ['CO（CEMS 实测）', q.co / 1000, 't', 'CEMS实测汇总'],
      ['HCl（CEMS 实测）', q.hcl / 1000, 't', 'CEMS实测汇总'],
    ];
    for (const [name, amt, unit, method] of items) {
      if (!(amt > 0)) continue;
      await db.query(
        `INSERT INTO emission_item (report_id, ent_id, energy_type, scope, amount, unit, factor, co2, calc_method)
         VALUES (?,?,?,1,?,?,0,0,?)`,
        [reportId, ent.id, name, R(amt, 4), unit, method]
      );
    }

    /* 血缘：CO₂ 分摊（MODELED，含分配假设） */
    await trace({
      targetTable: 'emission_report', targetId: reportId, targetLabel: `${ent.ent_name} ${period} CO₂`,
      sourceKind: 'DERIVATION',
      sourceRef: `${co2SourceRef} + cems_cn_hourly[${year} 全年, batch ${sum.batchRange}]`,
      sourceDetail: {
        annualCo2: R(co2Total, 2), quarterShare: q.share,
        quarterGasM3: R(q.gas, 1), yearGasM3: sum.yearTotals.flueGasM3,
        quarterCo2: qCo2, factor, basis: co2Basis, extrapolated,
      },
      ruleCode: 'CO2_ANNUAL_X_CEMS_GAS_SHARE',
      ruleExpr: `季度CO₂ = 年度CO₂(${R(co2Total, 2)} t) × 当季烟气量占全年比(${(q.share * 100).toFixed(2)}%)`,
      layer: 'MODELED',
      confidence: extrapolated ? 'LOW' : 'MEDIUM',
      limitation: co2Limitation || ('CO₂ 不是 CEMS 实测值。CEMS（GB 18485 口径）只测烟尘/SO₂/NOx/CO/HCl，不含 CO₂。'
        + '本季 CO₂ = 官方年度活动水平法核算值 × 当季实测烟气量占比。'
        + '「年度总量」可辩护，「季度分配」是分配假设，不能主张为实测。'),
      reviewHint: `核查应验算：①年度CO₂基数 ${R(co2Total, 2)} t 是否与官方处理量×因子一致；`
        + '②本季烟气量占比是否与省平台原始小时数据一致；③两者相乘是否等于本单申报值',
    });

    /* 血缘：污染物实测汇总（DERIVED，纯求和可逆） */
    await trace({
      targetTable: 'emission_report', targetId: reportId, targetLabel: `${ent.ent_name} ${period} 污染物`,
      sourceKind: 'CEMS_HOURLY',
      sourceRef: `cems_cn_hourly WHERE YEAR=${year} AND QUARTER=${q.quarter} AND is_valid=1`,
      sourceDetail: {
        rows: q.rows, validHours: q.hours,
        so2Kg: R(q.so2, 3), noxKg: R(q.nox, 3), pmKg: R(q.pm, 3),
        coKg: R(q.co, 3), hclKg: R(q.hcl, 3), flueGasM3: R(q.gas, 1),
      },
      ruleCode: 'CEMS_POLLUTANT_SUM',
      ruleExpr: '季度污染物排放量 = Σ(该季有效小时 so2/nox/pm/co/hcl_emission_kg)',
      layer: 'DERIVED', confidence: 'HIGH',
      limitation: '仅覆盖 CEMS 所监测的那一个排口。若企业存在多个排口而 CEMS 只接其一，'
        + '本值汇总该企业已接入的全部废气排口，不等于全厂污染物排放总量（若仍有排口未接入）；覆盖程度见 cems_coverage「(全厂合计)」行的 coverage_ratio（未知时为空）。',
      reviewHint: '核查应比对省平台同批次原始小时数据，确认求和口径与有效小时判定一致',
    });

    created.push({ quarter: q.quarter, reportId, reportNo, co2: qCo2, share: q.share });
  }

  return {
    pollutants: sum, co2Total: R(co2Total, 2), co2Basis,
    co2SourceKind, co2SourceRef, layer: co2Layer, confidence: co2Confidence,
    extrapolated, limitation: co2Limitation, reports: created,
  };
}

/* ==================================================================
 * ⑥ 上报单上链 + 自动派核查任务
 *   复用既有服务，不另写一套（避免两套口径）。
 * ================================================================== */
async function submitAndAssign(reportId, entId) {
  const r = await db.one('SELECT * FROM emission_report WHERE id = ?', [reportId]);
  if (!r) throw new Error(`上报单 #${reportId} 不存在`);
  if (r.status !== 'DRAFT') return { skipped: 'NOT_DRAFT', status: r.status };

  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [entId]);
  /* 交叉库校验：派生依据的链上批次必须真的存在于账本库 */
  const chain = await anchorSvc.anchor({
    txType: 'EMISSION_REPORT',
    bizNo: r.report_no,
    fromLabel: `ent:${entId}`,
    payload: {
      reportNo: r.report_no, entId, entName: ent.ent_name, period: r.period,
      scope1: Number(r.scope1_emission), scope2: Number(r.scope2_emission),
      totalEmission: Number(r.total_emission), intensity: Number(r.intensity || 0),
      dataSource: r.data_source,
      /* 派生标记随链上存证一起固化，事后无法改口说"这是实测 CO₂" */
      derivation: {
        co2Basis: 'OFFICIAL_ACTIVITY_X_CEMS_SHARE',
        isMeasuredCO2: false,
        cemsMeasuresCO2: false,
      },
    },
  });
  await db.query(
    "UPDATE emission_report SET status='SUBMITTED', submit_time=NOW(), chain_block_index=?, chain_tx_id=? WHERE id=?",
    [chain.blockIndex, chain.txId, reportId]
  );
  await db.query(
    'UPDATE derivation_log SET chain_tx_id = ? WHERE target_table=? AND target_id=? AND chain_tx_id IS NULL',
    [chain.txId, 'emission_report', reportId]
  );

  /* 派核查：优先同省 + **具备双岗位账号**的机构，并按在办任务数轮询。
   *
   * 两轮修正的历史：
   *   v1  `ORDER BY RAND()`     —— 随机，不可复现，可能派给无地域关系的机构
   *   v2  `ORDER BY id LIMIT 1` —— 32 张单全派给同一家，利益集中
   *   v3（当前）               —— 均衡 + 可闭环
   *
   * v3 的关键约束是**可闭环**：调给一家没有 VER_CLERK/VER_REVIEWER 账号的机构，
   * 任务永远停在 PENDING，业务链断在核查环节。因此先筛"同时具备录入岗与
   * 审核岗"的机构，再按在办任务数升序取。没有这样的机构才降级到有任意核查
   * 账号的，最后才用全部 ACTIVE 机构 —— 每一级降级都要留下痕迹。 */
  const v = await pickVerifier(/河北|保定/);
  const taskNo = cu.bizNo('VT');
  const [t] = await db.pool.query(
    `INSERT INTO verify_task (task_no, report_id, ent_id, verifier_id, verifier_user, task_type,
       priority, status, assign_time, deadline, created_at)
     VALUES (?,?,?,?,?,?,'NORMAL','PENDING',NOW(),DATE_ADD(NOW(), INTERVAL 30 DAY),NOW())`,
    [taskNo, reportId, entId, v.id, 'ver' + String(v.id).padStart(3, '0'), 'ROUTINE']
  );
  await db.query('UPDATE emission_report SET verifier_id = ? WHERE id = ?', [v.id, reportId]);
  return { chain, taskId: t.insertId, taskNo, verifier: v.org_name, verifierRegion: v.region };
}

/* ==================================================================
 * 核查机构选取（唯一实现，enterprise.js 与 derive.js 共用）
 *
 * 派单必须同时满足三个条件，缺一个业务链就断：
 *   ① 该机构是 ACTIVE 且具备 VER_CLERK + VER_REVIEWER 双岗 —— 否则两段式核查走不完
 *   ② 在办任务数最少 —— 否则 32 张单全压在同一家，独立性被稀释
 *   ③ 同省优先 —— 否则跨省派单不合常理
 *
 * 顺序是「能力 → 负荷 → 地域」，因为可闭环是第一约束：把任务派给一家
 * 没有审核岗的机构，任务会永远停在 PENDING，比派远了更糟。
 * ================================================================== */
async function pickVerifier(regionPattern, opts = {}) {
  const capable = await db.query(
    `SELECT v.id, v.org_name, v.region,
            COUNT(DISTINCT CASE WHEN u.post='VER_CLERK' THEN u.id END) AS clerks,
            COUNT(DISTINCT CASE WHEN u.post='VER_REVIEWER' THEN u.id END) AS reviewers,
            COUNT(DISTINCT t.id) AS open_load
       FROM verifier_org v
       LEFT JOIN sys_user u ON u.role='VERIFIER' AND u.org_id=v.id AND u.status='ACTIVE'
       LEFT JOIN verify_task t ON t.verifier_id=v.id AND t.status IN ('PENDING','ACCEPTED','IN_PROGRESS')
      WHERE v.status='ACTIVE'
      GROUP BY v.id, v.org_name, v.region
      ORDER BY open_load ASC, v.id ASC`
  );
  if (!capable.length) {
    throw new Error('无可用的核查机构（verifier_org 无 ACTIVE 记录），无法派单');
  }
  const re = regionPattern instanceof RegExp ? regionPattern : null;
  const local = re ? (o) => re.test(String(o.region || '')) : () => false;
  /* 闭环封闭：被排除的机构（如原闭环专属的沧州 org 8）不参与本轮派单 */
  const excluded = new Set(opts.exclude || []);
  const pool = capable.filter((o) => !excluded.has(Number(o.id)));
  if (!pool.length) {
    throw new Error('可用的核查机构均被排除（闭环封闭规则），无法派单');
  }

  let pick = pool.find((o) => local(o) && o.clerks > 0 && o.reviewers > 0)
    || pool.find((o) => o.clerks > 0 && o.reviewers > 0)
    || pool.find((o) => o.clerks > 0 || o.reviewers > 0)
    || pool[0];

  /* 负荷最低的若干家轮流取，避免同一时刻都选到同一条。
   * 用 id 做稳定排序键，保证同样输入得到同样结果（可复现）。 */
  const best = Number(pick.open_load);
  const tied = pool.filter((o) => Number(o.open_load) === best
    && (o.clerks > 0 && o.reviewers > 0) === (pick.clerks > 0 && pick.reviewers > 0));
  pick = tied[0] || pick;

  if (!(pick.clerks > 0 && pick.reviewers > 0)) {
    console.warn(`⚠ 核查机构 #${pick.id} ${pick.org_name} 不具备完整双岗位`
      + `（录入 ${pick.clerks} / 审核 ${pick.reviewers}），两段式核查将无法完成；`
      + '请为其开设 VER_CLERK 与 VER_REVIEWER 账号');
  }
  return pick;
}

module.exports = {
  TYPICAL_GAS_PER_TON,
  trace, computeCoverage, summarizePollutants, deriveQuarterlyReports, submitAndAssign,
  resolveEnterprise, normalizeName, pickVerifier,
};
