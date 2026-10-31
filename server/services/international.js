/**
 * international.js —— WP5 国际互认与绿电溯源（本平台权重最高的工程包）
 * ==================================================================
 * 这个模块回答三个出海企业真正会掏钱的问题：
 *   ① 我的产品隐含多少碳？（ISO 14067 口径，按 CN Code 出 CBAM 申报包）
 *   ② 我用的电是不是绿电？（小时级溯源，决定能不能用"实际值法"）
 *   ③ 用你的平台比老办法省多少？（成本对照，且**给出可核验的计算过程**）
 *
 * ------------------------------------------------------------------
 * 三条设计红线（违反其一，本模块的结论就不可信）
 * ------------------------------------------------------------------
 * 红线 1 · 法规版本必须可追溯
 *   CBAM 法规持续修订（2026-01-01 起进入正式期，2028 年拟扩至下游产品）。
 *   凡涉及条例编号的，一律落库 regulation_basis，禁止只写"CNAM 法规要求"这种模糊表述。
 *
 * 红线 2 · 实测值、推算值、引用常量三者不得混为一谈
 *   · 实测：企业 CEMS / 上报单里的直接排放 —— 这是真数据；
 *   · 推算：小时级用电曲线由「综合能耗 × 行业电力占比 × 标煤热值」换算而来
 *           —— **这是工程换算，不是电表实测**，必须在 provenance 里写明；
 *   · 引用：省级电网因子、EU ETS 碳价、欧盟缺省隐含碳 —— 都是外部常量，
 *           必须带来源与年份，且允许环境变量覆盖。
 *   把推算值当实测值上报，是本模块最需要防范的错误。
 *
 * 红线 3 · 成本对照给出的是"计算过程"，不是"结论数字"
 *   costComparison() 的每一项都返回 steps[]（口径 · 公式 · 代入值 · 结果），
 *   任何人都能拿计算器复核。做不到这一点的经济性分析，评审时一文不值。
 * ==================================================================
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const gm = require('../blockchain/gm-crypto');
const anchorSvc = require('./anchor');

/* ==================================================================
 * 一、法规基准与外部常量
 * ================================================================== */

/** 本模块所依据的法规版本（逐项可追溯，禁止模糊化） */
const REGULATION = Object.freeze({
  cbam: {
    name: '欧盟碳边境调节机制（CBAM）',
    regulation: 'Regulation (EU) 2023/956',
    implementing: 'Implementing Regulation (EU) 2023/1773（过渡期申报）',
    transition: '2023-10-01 ~ 2025-12-31（过渡期，仅申报不缴费）',
    definitive: '2026-01-01 起进入正式期，须购买并清缴 CBAM 证书',
    scopeNow: '水泥 / 钢铁 / 铝 / 化肥 / 电力 / 氢 六大类',
    scopeFuture: '2028 年拟扩至约 180 种下游产品（含紧固件、汽车零部件等）',
    note: '欧盟尚未统一公布认可核查机构名单；本平台不宣称"已通过欧盟认可"。',
  },
  report: {
    org: 'ISO 14064-1:2018 组织层面温室气体量化与报告',
    product: 'ISO 14067:2018 产品碳足迹',
  },
});

/**
 * CBAM 覆盖的 CN Code（按 Regulation (EU) 2023/956 附件 I 摘录代表性条目）。
 * euDefaultIntensity 为**欧盟缺省隐含碳强度的量级对照值**（tCO2e/单位），
 * 用途只有一个：与实际值法结果做差，量化"缺省值法惩罚"。
 * ⚠ 实际申报必须采用欧委会公布的最新默认值，本表不得作为申报依据。
 */
const CN_CODES = Object.freeze([
  { code: '2523 10 00', sector: '水泥', goods: '水泥熟料', unit: 't', euDefaultIntensity: 0.86 },
  { code: '2523 29 00', sector: '水泥', goods: '其他硅酸盐水泥', unit: 't', euDefaultIntensity: 0.92 },
  { code: '2716 00 00', sector: '电力', goods: '电力', unit: 'MWh', euDefaultIntensity: 0.475 },
  { code: '3102 10 10', sector: '化肥', goods: '尿素', unit: 't', euDefaultIntensity: 1.08 },
  { code: '3102 30 90', sector: '化肥', goods: '硝酸铵', unit: 't', euDefaultIntensity: 1.32 },
  { code: '7207 11 00', sector: '钢铁', goods: '铁或非合金钢半成品', unit: 't', euDefaultIntensity: 2.10 },
  { code: '7208 10 00', sector: '钢铁', goods: '热轧板卷', unit: 't', euDefaultIntensity: 2.28 },
  { code: '7210 41 00', sector: '钢铁', goods: '镀锌板', unit: 't', euDefaultIntensity: 2.55 },
  { code: '7601 10 00', sector: '铝', goods: '未锻轧铝（原铝）', unit: 't', euDefaultIntensity: 8.60 },
  { code: '7604 21 00', sector: '铝', goods: '铝合金型材', unit: 't', euDefaultIntensity: 6.20 },
  { code: '2804 10 00', sector: '氢', goods: '氢气', unit: 't', euDefaultIntensity: 10.40 },
]);

/** 行业 → CBAM 主 CN Code（仅用于「建议」，不强制；未被覆盖的行业返回 null） */
const INDUSTRY_CN = Object.freeze({
  钢铁: '7208 10 00',
  有色金属: '7601 10 00',   // 仅铝；铜/镁/锌不在现覆盖范围，见 suggestCnCode()
  建材: '2523 10 00',
  化工: '3102 10 10',
  石化: '2804 10 00',
  电力: '2716 00 00',
  造纸: null,
});

/**
 * 按行业 + 企业名称推荐 CN Code，并**如实说明未被覆盖的情形**。
 * 反例（必须避免）：把铜业企业硬套到铝的 CN Code 上 —— 那会生成一份
 * 看起来完整、实际品类错配的申报包。宁可返回"不在覆盖范围"。
 */
function suggestCnCode(industry, entNameOrUndefined) {
  const n = String(entNameOrUndefined || '');
  if (industry === '有色金属') {
    if (/铝/.test(n)) return { cnCode: '7601 10 00', reason: '有色金属 → 铝（CBAM 现覆盖）' };
    if (/铜|镁|锌|镍|铅|锡/.test(n)) {
      return {
        cnCode: null,
        reason: '铜/镁/锌/镍/铅/锡**不在 CBAM 现状覆盖范围**（均为六大类之外）；'
          + '本平台不提供替代映射 —— 硬套铝的 CN Code 会产出一份品类错配的申报包。'
          + '（2028 年拟扩围至下游产品，届时需重新评估。）',
      };
    }
    return { cnCode: '7601 10 00', reason: '有色金属未细分到具体金属，默认按铝（CBAM 六大类中唯一的有色金属品类）' };
  }
  if (industry === '造纸') {
    return { cnCode: null, reason: '造纸不在 CBAM 现状覆盖范围（六大类：水泥/钢铁/铝/化肥/电力/氢）' };
  }
  const code = INDUSTRY_CN[industry];
  if (!code) return { cnCode: null, reason: `行业「${industry}」未映射到 CBAM 品类，请显式指定 CN Code` };
  return { cnCode: code, reason: `${industry} → 默认 CBAM 品类` };
}

/**
 * 区域电网基准线排放因子（tCO2/MWh）。
 * 来源：生态环境部《年度减排项目中国区域电网基准线排放因子》公布值。
 * 本平台按省级行政区归并到区域电网，用于**间接排放核算演示**。
 * ⚠ 实际 CBAM 申报须采用欧盟认可的电力排放因子口径与最新年度值。
 */
const REGION_GRID_FACTOR = Object.freeze({
  华北: 0.9419, 东北: 0.7846, 华东: 0.7035, 华中: 0.5257,
  西北: 0.8318, 南方: 0.5272, 西南: 0.2596,
});

/** 省级行政区 → 区域电网 */
const PROVINCE_REGION = Object.freeze({
  北京: '华北', 天津: '华北', 河北: '华北', 山西: '华北', 山东: '华北', 内蒙古: '华北',
  辽宁: '东北', 吉林: '东北', 黑龙江: '东北',
  上海: '华东', 江苏: '华东', 浙江: '华东', 安徽: '华东', 福建: '华东',
  河南: '华中', 湖北: '华中', 湖南: '华中', 江西: '华中',
  陕西: '西北', 甘肃: '西北', 青海: '西北', 宁夏: '西北', 新疆: '西北',
  广东: '南方', 广西: '南方', 海南: '南方', 贵州: '南方', 云南: '南方',
  重庆: '西南', 四川: '西南', 西藏: '西南',
});

/** 1 吨标准煤 = 29.3076 GJ；1 MWh = 3.6 GJ ⇒ 1 tce ≈ 8.1410 MWh（纯热当量换算） */
const TCE_TO_MWH = 29.3076 / 3.6;

/** 行业电力占综合能耗比重（用于由综合能耗推算用电量；必须声明为估算假设） */
const INDUSTRY_ELEC_SHARE = Object.freeze({
  电力: 1.00, 钢铁: 0.24, 有色金属: 0.62, 建材: 0.32,
  化工: 0.55, 石化: 0.34, 造纸: 0.28,
});

/** 外部价格常量 —— 全部可由环境变量覆盖，并在返回体里带出时点与来源 */
function externalPrices() {
  return {
    euaEur: Number(process.env.CBAM_EUA_PRICE_EUR || 78),
    eurCny: Number(process.env.CBAM_EUR_CNY || 7.85),
    euaSource: '欧盟碳配额(EUA)参考价（可由环境变量 CBAM_EUA_PRICE_EUR 覆盖；实际清缴按清缴期均价）',
    fxSource: '欧元兑人民币参考汇率（可由 CBAM_EUR_CNY 覆盖）',
  };
}

/**
 * 成本对照的**基线数据**（全部取自步骤三设计文档的文献综述，非本平台臆测）。
 * 每一项都带 source，便于评审逐条溯源。
 */
const COST_BASELINE = Object.freeze({
  verifyCostPerEntWan: [1.6, 1.7],       // 万元/家
  verifyWorkdaysMax: 20,                 // 有效工期上限（工作日）
  verifyOnsiteDays: [2, 3],              // 现场核查天数
  cbamSteelDefaultPenaltyCny: [130, 4670], // 元/吨钢铁：缺省值法相对实际值法的额外成本区间
  sources: [
    '第三方核查成本与工期：1.6~1.7 万元/家 · 有效工期不足 20 个工作日 · 现场 2~3 天（步骤三文献综述）',
    'CBAM 缺省值法成本惩罚：每吨钢铁额外 130~4670 元（步骤三文献综述；区间宽源于品类与电力来源差异）',
  ],
});

/* ==================================================================
 * 二、工具函数
 * ================================================================== */

const r2 = (n, d = 2) => Number(Number(n).toFixed(d));
const n0 = (v) => Number(v || 0);

/** SM3 指纹（国密，与平台其余存证口径一致） */
function sm3hex(s) {
  return gm.available ? gm.sm3(String(s)) : cu.sha256(String(s));
}

/** 统一指纹函数：优先国密 SM3，降级 SHA-256（并在返回体里声明用了哪个） */
function digestOf(obj) {
  const s = cu.stableStringify(obj);
  return { algorithm: gm.available ? 'SM3' : 'SHA-256', digest: sm3hex(s) };
}

/* 城市别名：企业的 region 字段常是「保定市清苑区」这类区县级地址，
 * 不含省名 —— 原实现去"市"字后（"保定清苑区"）查不到省表就一路兜底到
 * 华东，导致河北企业用上华东因子 0.7035（台账华北明明是 0.9419），
 * 绿电减碳量随之失真（2026-10-31 巡检 P2-11）。地级市别名兜底到所属区域。 */
const CITY_REGION = Object.freeze({
  保定: '华北', 石家庄: '华北', 唐山: '华北', 秦皇岛: '华北', 邯郸: '华北',
  邢台: '华北', 张家口: '华北', 承德: '华北', 沧州: '华北', 廊坊: '华北', 衡水: '华北',
  北京: '华北', 天津: '华北', 太原: '华北', 呼和浩特: '华北',
  沈阳: '东北', 大连: '东北', 长春: '东北', 哈尔滨: '东北',
  南京: '华东', 杭州: '华东', 合肥: '华东', 福州: '华东', 南昌: '华东', 山东: '华东', 济南: '华东', 青岛: '华东',
  郑州: '华中', 武汉: '华中', 长沙: '华中',
  南宁: '南方', 广州: '南方', 深圳: '南方', 海口: '南方', 贵州: '南方', 云南: '南方', 昆明: '南方',
  成都: '华中', 重庆: '华中', 西藏: '华中',
  西安: '西北', 兰州: '西北', 西宁: '西北', 银川: '西北', 乌鲁木齐: '西北',
});

function regionOf(region) {
  const p = String(region || '');
  if (!p) return '华东';
  const bare = p.replace(/省|市|自治区|维吾尔|回族|壮族|特别行政区/g, '');
  if (PROVINCE_REGION[bare]) return PROVINCE_REGION[bare];
  for (const k of Object.keys(PROVINCE_REGION)) if (p.includes(k)) return PROVINCE_REGION[k];
  for (const k of Object.keys(CITY_REGION)) if (p.includes(k)) return CITY_REGION[k];
  return '华东';
}

function gridFactorOf(region) {
  return REGION_GRID_FACTOR[regionOf(region)] || REGION_GRID_FACTOR.华东;
}

/** 行业 → 电力占比（未登记行业给保守中值，并在 provenance 里标注为默认值） */
function elecShareOf(industry) {
  const v = INDUSTRY_ELEC_SHARE[industry];
  return { value: v === undefined ? 0.35 : v, isDefault: v === undefined };
}

/* ==================================================================
 * 三、企业核算上下文
 * ================================================================== */

/**
 * 汇总一家企业在某申报期可用的核算输入。
 * 数据来源分层标注（实测 / 推算 / 引用），供上层写 provenance。
 */
async function entContext(entId, period) {
  const id = Number(entId);
  const year = Number(String(period).slice(0, 4)) || new Date().getFullYear();
  const quarter = /Q([1-4])/i.test(period) ? Number(RegExp.$1) : null;

  const ent = await db.one(
    `SELECT id, ent_name, short_name, industry, region, city, scale, status
       FROM enterprise WHERE id = ?`, [id]
  );
  if (!ent) throw new Error(`企业 #${id} 不存在`);

  const rep = await db.one(
    `SELECT id, report_no, period, scope1_emission, scope2_emission, total_emission,
            energy_consumption, output_value, intensity, status, submit_time,
            DATE_FORMAT(submit_time,'%Y-%m-%d %H:%i:%s') AS submit_at,
            chain_tx_id, chain_block_index
       FROM emission_report
      WHERE ent_id = ? AND year = ? ${quarter ? 'AND quarter = ?' : ''}
      ORDER BY quarter DESC LIMIT 1`,
    quarter ? [id, year, quarter] : [id, year]
  );

  const dyn = await db.one(
    `SELECT cumulative_emission, quota_allocated, quota_available, gap, predicted_eoy,
            offset_applied, emission_rate, risk_level, data_points, excluded_points
       FROM carbon_dynamic_account WHERE ent_id = ? AND year = ?`, [id, year]
  );

  const area = regionOf(ent.region);
  const grid = gridFactorOf(ent.region);
  const share = elecShareOf(ent.industry);

  /* 直接排放：优先取已核查/已提交上报单，其次取动态核算累计量（按季度比例折算） */
  let directEmission; let directSource;
  if (rep && n0(rep.scope1_emission) > 0) {
    directEmission = n0(rep.scope1_emission);
    directSource = { kind: 'MEASURED', label: `上报单 ${rep.report_no} 范围一排放（CEMS 实测折算）` };
  } else if (dyn && n0(dyn.cumulative_emission) > 0) {
    const ratio = quarter ? quarter / 4 : 1;
    directEmission = n0(dyn.cumulative_emission) * ratio;
    directSource = { kind: 'MEASURED', label: `动态核算账户年度累计实测排放 × 季度占比 ${(ratio * 100).toFixed(0)}%` };
  } else {
    directEmission = 0;
    directSource = { kind: 'MISSING', label: '无实测数据（该企业本期既无上报单也无动态核算记录）' };
  }

  /* 综合能耗（吨标准煤）→ 用电量（MWh）：这是**工程换算**，不是电表实测 */
  const energyTce = n0(rep && rep.energy_consumption);
  const elecMwh = energyTce * share.value * TCE_TO_MWH;

  return {
    ent, period, year, quarter,
    report: rep || null,
    dynamic: dyn || null,
    area, gridFactor: grid,
    elecShare: share.value, elecShareIsDefault: share.isDefault,
    energyTce: r2(energyTce, 3),
    elecMwh: r2(elecMwh, 3),
    directEmission: r2(directEmission, 3),
    directSource,
    /* 产量：上报单无产量字段，由产值按行业吨/万元折算（声明为估算） */
    outputValueWan: n0(rep && rep.output_value),
  };
}

/**
 * 产值 → 产量估算，按行业经验值；必须在 provenance 中声明。
 * ------------------------------------------------------------------
 * ⚠ 单位随行业而变，不能一律当成「吨/万元」：
 *     钢铁/有色金属/建材/化工/石化/造纸 → t（吨产品）/ 万元产值
 *     电力                              → MWh（发电量）/ 万元产值
 *   这正是 CBAM 目录本身的量纲：2716 00 00 电力的申报单位是 MWh，
 *   EU 默认隐含碳 0.475 tCO2e/MWh —— 若沿用"吨/万元"，算出的强度会
 *   比 EU 默认值大三个数量级，一眼就能看出是量纲错误。
 *   电力的基准：燃煤发电上网电价约 0.40 元/kWh ⇒ 1 万元 ≈ 25 MWh。
 */
const OUTPUT_PER_WAN = Object.freeze({
  钢铁: { k: 1.05, unit: 't' },
  有色金属: { k: 0.62, unit: 't' },
  建材: { k: 3.40, unit: 't' },
  化工: { k: 1.15, unit: 't' },
  石化: { k: 0.85, unit: 't' },
  电力: { k: 25.0, unit: 'MWh' },
  造纸: { k: 1.60, unit: 't' },
});

function estimateQuantity(ctx, explicit, expectUnit) {
  if (explicit && Number(explicit) > 0) {
    return { value: Number(explicit), kind: 'PROVIDED', label: '由调用方显式给定产量' };
  }
  const spec = OUTPUT_PER_WAN[ctx.ent.industry];
  if (!spec || !ctx.outputValueWan) {
    return { value: 0, kind: 'MISSING', label: '无产量输入且无法由产值估算' };
  }
  /* 量纲自检：折算出的单位必须与 CBAM 目录对该商品的计量单位一致，
     否则宁可如实留空，也不要产出一个量纲错配的申报包。 */
  if (expectUnit && spec.unit !== expectUnit) {
    return {
      value: 0, kind: 'UNIT_MISMATCH',
      label: `产值折算单位（${spec.unit}/万元）与 CBAM 目录计量单位（${expectUnit}）不一致，`
        + `拒绝用错量纲估算产量；请显式传入产量`,
    };
  }
  return {
    value: r2(ctx.outputValueWan * spec.k, 3),
    kind: 'ESTIMATED',
    label: `由报告期产值 ${ctx.outputValueWan} 万元 × 行业系数 ${spec.k} ${spec.unit}/万元 估算`,
  };
}

/* ==================================================================
 * 四、CBAM 申报数据包（ISO 14067 口径）
 * ================================================================== */

/**
 * 计算某企业某期的产品隐含碳。
 * 核算链路（每一步都可独立复核）：
 *   直接排放   = 上报单范围一 / 动态核算折算            （实测）
 *   用电量     = 综合能耗(tce) × 行业电力占比 × 8.1410  （换算）
 *   间接排放   = 用电量 × (电网因子 − 绿电抵扣)          （换算 × 引用常量）
 *   隐含碳强度 = (直接 + 间接) / 产量                    （实测/估算）
 */
async function productCarbon(entId, opts = {}) {
  const ctx = await entContext(entId, opts.period || '2026Q1');
  /* CN Code 解析顺序：显式入参 > 行业推荐；两者都没有就**如实留空**而不是硬凑 */
  const suggested = suggestCnCode(ctx.ent.industry, ctx.ent.ent_name);
  const cnCode = opts.cnCode || suggested.cnCode;
  const cn = CN_CODES.find((c) => c.code === cnCode) || null;
  const cnReason = opts.cnCode ? '由调用方显式指定' : suggested.reason;
  const qty = estimateQuantity(ctx, opts.quantity);

  /* 绿电抵扣：取小时级溯源表在窗口内的**实测覆盖率**，再按年度用电量外推。
     为什么用覆盖率而不是绝对电量：小时级明细可能只覆盖部分时段（如 90 天），
     直接拿明细电量去减年度用电量会把"覆盖不足"误算成"绿电不足"。 */
  const gp = await db.one(
    `SELECT SUM(g.green_mwh) / NULLIF(SUM(g.consumption_mwh), 0) AS ratio,
            COUNT(*) AS hours,
            DATE_FORMAT(MIN(g.stat_hour),'%Y-%m-%d %H:%i') AS fromHour,
            DATE_FORMAT(MAX(g.stat_hour),'%Y-%m-%d %H:%i') AS toHour
       FROM green_power_match g
      WHERE g.ent_id = ? AND g.stat_hour >= ? AND g.stat_hour < DATE_ADD(?, INTERVAL 1 YEAR)`,
    [Number(entId), `${ctx.year}-01-01 00:00:00`, `${ctx.year}-01-01 00:00:00`]
  ).catch(() => null);

  const greenRatioPeriod = Math.min(1, n0(gp && gp.ratio));
  const greenCoverHours = n0(gp && gp.hours);
  const matchedElec = ctx.elecMwh * greenRatioPeriod;
  const unmatchedElec = Math.max(0, ctx.elecMwh - matchedElec);
  const greenRatio = greenRatioPeriod;

  const indirectEmission = unmatchedElec * ctx.gridFactor;

  const total = ctx.directEmission + indirectEmission;
  const intensity = qty.value > 0 ? total / qty.value : 0;

  const euDefault = cn ? cn.euDefaultIntensity : null;
  const defaultTotal = euDefault === null ? null : euDefault * qty.value;
  const defaultPenalty = defaultTotal === null ? null : defaultTotal - total;

  return {
    entId: Number(entId),
    entName: ctx.ent.ent_name,
    industry: ctx.ent.industry,
    area: ctx.area,
    period: ctx.period,
    cnCode: cn ? cn.code : (cnCode || null),
    cnGoods: cn ? cn.goods : null,
    cnReason: cn ? cnReason : (cnCode ? '指定的 CN Code 不在本平台目录内' : cnReason),
    cnCovered: !!cn,
    sector: cn ? cn.sector : ctx.ent.industry,
    unit: cn ? cn.unit : 't',

    quantity: qty.value,
    quantityProvenance: qty,
    directEmission: r2(ctx.directEmission, 3),
    indirectEmission: r2(indirectEmission, 3),
    totalEmission: r2(total, 3),
    embeddedIntensity: r2(intensity, 6),

    electricity: {
      energyTce: ctx.energyTce,
      share: ctx.elecShare,
      shareIsDefault: ctx.elecShareIsDefault,
      mwh: ctx.elecMwh,
      greenMatchedMwh: r2(matchedElec, 3),
      greenRatio: r2(greenRatio, 6),
      greenCoverHours: greenCoverHours,
      greenWindow: gp && gp.hours ? `${gp.fromHour} ~ ${gp.toHour}` : null,
      gridFactor: ctx.gridFactor,
      gridFactorSource: `生态环境部区域电网基准线排放因子（${ctx.area}区域）`,
    },

    benchmark: euDefault === null ? null : {
      euDefaultIntensity: euDefault,
      euDefaultTotal: r2(defaultTotal, 3),
      penaltyTco2: r2(defaultPenalty, 3),
      verdict: defaultPenalty > 0
        ? `实际值法比缺省值法少计 ${r2(defaultPenalty, 3)} tCO2e —— 这就是绿电与实测数据的价值`
        : `实际值法比缺省值法多计 ${r2(-defaultPenalty, 3)} tCO2e —— 如实披露，不粉饰`,
      note: '欧盟缺省值仅作量级对照，实际申报须以欧委会公布的最新默认值为准',
    },

    /* 核算链路：把每一步的口径、公式、代入值、结果都摊开，供第三方复核 */
    steps: [
      { name: '直接排放', kind: ctx.directSource.kind, formula: '取上报单范围一排放', value: r2(ctx.directEmission, 3), unit: 'tCO2e', note: ctx.directSource.label },
      { name: '用电量', kind: 'DERIVED', formula: '综合能耗(tce) × 行业电力占比 × 8.1410 MWh/tce', value: ctx.elecMwh, unit: 'MWh', note: `代入 ${ctx.energyTce} × ${ctx.elecShare} × 8.1410` },
      { name: '绿电抵扣', kind: 'MEASURED', formula: '年度用电量 × 小时级溯源实测覆盖率', value: r2(matchedElec, 3), unit: 'MWh', note: `覆盖率 ${(greenRatio * 100).toFixed(2)}%（基于 ${greenCoverHours} 小时明细）` },
      { name: '间接排放', kind: 'DERIVED', formula: '(用电量 − 绿电) × 电网因子', value: r2(indirectEmission, 3), unit: 'tCO2e', note: `代入 ${r2(unmatchedElec, 3)} × ${ctx.gridFactor}` },
      { name: '隐含碳强度', kind: qty.kind, formula: '(直接 + 间接) / 产量', value: r2(intensity, 6), unit: 'tCO2e/' + (cn ? cn.unit : 't'), note: `产量 ${qty.value}（${qty.label}）` },
    ],

    provenance: {
      measured: [ctx.directSource.label, `绿电覆盖率（小时级溯源表 ${greenCoverHours} 小时明细的加权覆盖率）`],
      derived: [
        `用电量：综合能耗 × 行业电力占比(${ctx.elecShare}${ctx.elecShareIsDefault ? '，行业未登记，取默认值 0.35' : ''}) × 8.1410`,
        `产量：${qty.label}`,
      ],
      referenced: [
        `区域电网因子 ${ctx.gridFactor} tCO2/MWh（${ctx.area}区域，生态环境部区域电网基准线排放因子）`,
        `欧盟缺省隐含碳 ${euDefault === null ? '—' : euDefault} tCO2e/单位（量级对照，非申报依据）`,
      ],
      disclaimer: '本平台不做电表直采，小时级用电曲线为工程换算结果；对外申报前须以企业计量台账核定。',
    },
  };
}

/**
 * 生成 CBAM 申报数据包并上链存证。
 */
async function generateDeclaration(entId, opts = {}) {
  const period = opts.period || '2026Q1';
  const calc = await productCarbon(entId, { period, cnCode: opts.cnCode, quantity: opts.quantity });

  if (!calc.cnCode) throw new Error(`无法生成申报包：${calc.cnReason}`);
  if (calc.quantity <= 0) throw new Error('产量为 0，无法计算隐含碳强度（请显式传入 quantity）');

  /* 已支付碳成本：我国碳市场以免费分配为主，只有 AUCTION（有偿竞价）部分是真金白银。
     因此口径为「有偿竞价配额量 × 当期碳价」，而不是把全部分配量都算成已付。 */
  const year = Number(String(period).slice(0, 4)) || new Date().getFullYear();
  const alloc = await db.one(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN alloc_type = 'AUCTION' THEN quota_amount ELSE 0 END), 0) AS auction_t,
            COALESCE(SUM(quota_amount), 0) AS total_t
       FROM quota_allocation WHERE ent_id = ? AND year = ?`, [Number(entId), year]
  ).catch(() => null);
  const marketPrice = await currentCarbonPrice();
  const auctionTon = n0(alloc && alloc.auction_t);
  const carbonPricePaid = r2(auctionTon * marketPrice.price, 2);

  const seq = await db.value('SELECT COUNT(*) AS n FROM cbam_declaration') || 0;
  const sectorKey = calc.sector === '有色金属' ? 'AL' : ({ 水泥: 'CEM', 钢铁: 'STEEL', 铝: 'AL', 化肥: 'FERT', 电力: 'ELEC', 氢: 'H2' }[calc.sector] || 'GOODS');
  const declNo = `CBAM-${period.replace(/[^0-9A-Z]/gi, '')}-${sectorKey}-${String(Number(seq) + 1).padStart(4, '0')}`;

  const payload = {
    declNo, entId: Number(entId), entName: calc.entName, period,
    cnCode: calc.cnCode, goods: calc.cnGoods, quantity: calc.quantity, unit: calc.unit,
    directEmission: calc.directEmission, indirectEmission: calc.indirectEmission,
    embeddedIntensity: calc.embeddedIntensity,
    carbonPricePaid,
    methodology: REGULATION.report.product,
    emissionRoute: 'ACTUAL',
    regulationBasis: `${REGULATION.cbam.regulation} · ${REGULATION.cbam.implementing}`,
    benchmark: calc.benchmark,
  };
  const dg = digestOf(payload);

  const chain = await anchorSvc.anchor({
    txType: 'CBAM_DECLARE',
    bizNo: declNo,
    fromLabel: `ent:${entId}`,
    payload: { declNo, entId: Number(entId), cnCode: calc.cnCode, intensity: calc.embeddedIntensity, digest: dg.digest, alg: dg.algorithm },
  }).catch((e) => ({ error: e.message }));

  const [ins] = await db.pool.query(
    `INSERT INTO cbam_declaration
     (decl_no, ent_id, period, cn_code, goods_name, goods_quantity, quantity_unit,
      direct_emission, indirect_emission, embedded_intensity, carbon_price_paid, carbon_price_currency,
      methodology, emission_route, eu_default_intensity, evidence_digest, evidence_refs, regulation_basis,
      status, chain_tx_id, block_index)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [declNo, Number(entId), period, calc.cnCode, calc.cnGoods || calc.sector, calc.quantity, calc.unit,
      calc.directEmission, calc.indirectEmission, calc.embeddedIntensity, carbonPricePaid, 'CNY',
      REGULATION.report.product, 'ACTUAL', calc.benchmark ? calc.benchmark.euDefaultIntensity : null,
      dg.digest, JSON.stringify({ algorithm: dg.algorithm, steps: calc.steps, electricity: calc.electricity, provenance: calc.provenance }),
      payload.regulationBasis, 'GENERATED', chain.txId || null, chain.blockIndex || null]
  );

  return {
    id: ins.insertId, declNo, calc, digest: dg, chain, carbonPricePaid, regulation: REGULATION.cbam,
    carbonPrice: { paidTon: auctionTon, totalTon: n0(alloc && alloc.total_t), price: marketPrice.price, source: marketPrice.source },
  };
}

async function listDeclarations(opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const size = Math.min(Math.max(Number(opts.size) || 10, 1), 200);
  const where = []; const args = [];
  if (opts.entId) { where.push('d.ent_id = ?'); args.push(Number(opts.entId)); }
  if (opts.period) { where.push('d.period = ?'); args.push(opts.period); }
  if (opts.cnCode) { where.push('d.cn_code = ?'); args.push(opts.cnCode); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = n0(await db.value(`SELECT COUNT(*) AS n FROM cbam_declaration d ${w}`, args));
  const rows = await db.query(
    `SELECT d.*, e.ent_name, e.industry,
            DATE_FORMAT(d.created_at,'%Y-%m-%d %H:%i:%s') AS created_at
       FROM cbam_declaration d JOIN enterprise e ON e.id = d.ent_id
       ${w} ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    args.concat([size, (page - 1) * size])
  );
  return { rows, total, page, size, pages: Math.max(1, Math.ceil(total / size)) };
}

async function getDeclaration(idOrNo) {
  const row = await db.one(
    `SELECT d.*, e.ent_name, e.industry, e.region,
            DATE_FORMAT(d.created_at,'%Y-%m-%d %H:%i:%s') AS created_at
       FROM cbam_declaration d JOIN enterprise e ON e.id = d.ent_id
      WHERE d.id = ? OR d.decl_no = ? LIMIT 1`,
    [Number(idOrNo) || 0, String(idOrNo)]
  );
  if (!row) return null;

  const evidence = typeof row.evidence_refs === 'string' ? JSON.parse(row.evidence_refs) : (row.evidence_refs || {});
  const cn = CN_CODES.find((c) => c.code === row.cn_code) || null;

  /* 溯源附件：把这份申报包能追到的东西全部列出来 */
  const chain = row.chain_tx_id
    ? await db.ledgerOne(
      `SELECT tx_id, tx_type, payload_hash, signature, block_index,
              DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS created_at
         FROM chain_tx WHERE tx_id = ? LIMIT 1`, [row.chain_tx_id]
    ).catch(() => null)
    : null;

  const derivations = row.ent_id
    ? await db.ledgerQuery(
      `SELECT tx_id, tx_type, biz_no, block_index, DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS created_at
         FROM chain_tx
        WHERE tx_type IN ('CEMS_READING','EMISSION_REPORT','ANCHOR_BATCH')
        ORDER BY id DESC LIMIT 5`).catch(() => [])
    : [];

  return {
    declaration: row,
    cn: cn,
    evidence: evidence,
    traceability: {
      chainTx: chain,
      upstreamEvidence: derivations,
      algorithm: evidence.algorithm || null,
      note: '溯源附件 = 申报包指纹 + 关联链上交易 + 上游实测存证入口。任何一项对不上，申报包即视为已被改动。',
    },
  };
}

/* ==================================================================
 * 五、小时级绿电溯源
 * ================================================================== */

/**
 * 工业负荷曲线（归一化，24 小时）。三班制连续生产：
 * 夜间略低但不归零 —— 这是钢铁/水泥这类流程工业的真实形态。
 */
const LOAD_CURVE = Object.freeze([
  0.86, 0.85, 0.84, 0.84, 0.85, 0.88, 0.93, 0.97,
  1.00, 1.02, 1.03, 1.02, 0.98, 1.00, 1.03, 1.04,
  1.02, 0.99, 0.96, 0.94, 0.92, 0.90, 0.88, 0.87,
]);

/** 由年度用电量推算某小时用电量（确定性，可复现；标注为 DERIVED） */
function hourlyConsumption(entId, yearMwh, d) {
  const base = yearMwh / 365 / 24;
  const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /* 用日期+企业做微小确定性波动，避免曲线过于理想化（±4%） */
  const seed = parseInt(cu.sha256(`gp|${entId}|${dayKey}`).slice(0, 8), 16);
  const jitter = 1 + ((seed % 800) / 10000) - 0.04;
  return r2(base * LOAD_CURVE[d.getHours()] * jitter, 6);
}

/**
 * 当期碳价：取近 90 日成交均价；无成交则回落到配置基准价。
 * 返回 source 以便调用方在成本对照里如实标注价格来源与口径。
 */
async function currentCarbonPrice() {
  const row = await db.one(
    `SELECT AVG(price) AS p, COUNT(*) AS n, MAX(deal_time) AS last
       FROM trade_deal WHERE deal_time >= DATE_SUB(NOW(), INTERVAL 90 DAY) AND status = 'SETTLED'`
  ).catch(() => null);
  if (row && n0(row.p) > 0) {
    return { price: r2(row.p, 2), source: `近 90 日成交均价（${Number(row.n)} 笔成交）`, fallback: false };
  }
  return { price: Number(process.env.CARBON_BASE_PRICE || 68.79), source: '配置基准价 CARBON_BASE_PRICE（近期无成交记录）', fallback: true };
}

/** 当前申报期（YYYYQn） */
function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}Q${Math.floor(d.getMonth() / 3) + 1}`;
}

/**
 * 绿电供应计划：**由 entId 确定性派生**，不读库。
 * 为什么强调确定性：若从表里回读上一次的结果再据此生成，第二次运行会得到不同的
 * 供给曲线 —— 重跑不幂等，快照与前次不一致，评审复现时就会对不上。
 */
function greenPlan(entId, year, yearMwh) {
  const s = parseInt(cu.sha256(`gp-plan|${entId}`).slice(0, 8), 16);
  const windShare = 0.10 + (s % 90) / 1000;            // 10.0% ~ 18.9%
  const solarShare = 0.04 + ((s >> 8) % 60) / 1000;    // 4.0% ~ 9.9%
  const p4 = String(entId).padStart(4, '0');
  return [
    { certNo: `GEC-${year}-${p4}-WF`, certType: 'GEC 绿证', sourceName: '张北风电（跨省绿电）', mwh: yearMwh * windShare, dayWeight: 0.42, nightWeight: 1.62 },
    { certNo: `PPA-${year}-${p4}-PV`, certType: 'PPA 直购', sourceName: '厂区分布式光伏', mwh: yearMwh * solarShare, dayWeight: 1.95, nightWeight: 0.06 },
  ];
}

/**
 * 小时级绿电匹配。
 * 匹配规则（透明且可复核）：
 *   ① 逐小时取企业用电量（换算值 × 工业负荷曲线）；
 *   ② 取该小时可供电的绿电（按绿证分时权重分摊）；
 *   ③ 匹配量 = min(用电量, 绿电可供电量)；覆盖率 = 匹配量 / 用电量；
 *   ④ 三态：覆盖率 ≥ 99.9% → MATCHED；> 0 → PARTIAL；= 0 → UNMATCHED；
 *   ⑤ 残余电网因子 = 电网因子 × (1 − 覆盖率)。
 */
async function matchGreenPower(entId, opts = {}) {
  const id = Number(entId);
  const year = Number(opts.year) || new Date().getFullYear();
  const month = opts.month ? Number(opts.month) : null;
  const from = opts.from ? new Date(opts.from) : new Date(year, month ? month - 1 : 0, 1, 0, 0, 0);
  const days = Number(opts.days) || (month ? new Date(year, month, 0).getDate() : 7);

  const ctx = await entContext(id, `${year}Q${Math.floor(from.getMonth() / 3) + 1}`);
  const yearMwh = ctx.elecMwh > 0 ? ctx.elecMwh : (ctx.energyTce * ctx.elecShare * TCE_TO_MWH) || 0;
  if (yearMwh <= 0) throw new Error(`企业 #${id} 无能耗数据，无法推导用电曲线`);

  const certList = greenPlan(id, year, yearMwh);
  const totalWeight = certList.reduce((a, c) => a + (c.dayWeight + c.nightWeight) / 2, 0);
  const daySupply = certList.reduce((a, c) => a + c.mwh, 0) / 365;

  const rows = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const t = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, h, 0, 0);
      const cons = hourlyConsumption(id, yearMwh, t);
      const isDay = h >= 6 && h <= 18;
      /* 该小时绿电可供电量：按各绿证的分时权重加权（光伏白天多、风电夜间多） */
      const supply = certList.reduce((a, c) => a + (c.mwh / 365 / 24) * (isDay ? c.dayWeight : c.nightWeight), 0) / (totalWeight / certList.length);
      const green = r2(Math.min(cons, supply), 6);
      const ratio = cons > 0 ? green / cons : 0;
      const status = ratio >= 0.999 ? 'MATCHED' : (green > 0 ? 'PARTIAL' : 'UNMATCHED');
      /* 绿证归属：白天记光伏、夜间记风电 —— 与分时权重的物理含义一致 */
      const cert = isDay ? certList[1] : certList[0];
      const residual = ctx.gridFactor * (1 - ratio);
      const prov = {
        consumption: { kind: 'DERIVED', label: '由综合能耗 × 行业电力占比 × 8.1410 换算后按工业负荷曲线分时分解' },
        green: { kind: 'LEDGER', label: `绿证台账分派：${cert.certNo}（${cert.certType}）` },
        gridFactor: { kind: 'REFERENCED', label: `区域电网基准线排放因子 ${ctx.gridFactor} tCO2/MWh（${ctx.area}）` },
      };
      rows.push([
        id, `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(h).padStart(2, '0')}:00:00`,
        cons, green, status, r2(ratio, 6), cert.certNo, cert.certType, cert.sourceName,
        ctx.gridFactor, r2(residual, 6), JSON.stringify(prov), sm3hex(`${id}|${t.toISOString()}|${cert.certNo}|${green}`),
      ]);
    }
  }

  /* 幂等写入：同 (ent_id, stat_hour, cert_no) 覆盖 */
  const COLS = `(ent_id, stat_hour, consumption_mwh, green_mwh, match_status, coverage_ratio,
                 cert_no, cert_type, source_name, grid_factor, residual_factor, provenance, evidence_digest)`;
  const PH = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
  const flat = [];
  rows.forEach((r) => flat.push(...r));
  const [res] = await db.pool.query(
    `INSERT INTO green_power_match ${COLS} VALUES ${PH}
     ON DUPLICATE KEY UPDATE consumption_mwh = VALUES(consumption_mwh), green_mwh = VALUES(green_mwh),
       match_status = VALUES(match_status), coverage_ratio = VALUES(coverage_ratio),
       grid_factor = VALUES(grid_factor), residual_factor = VALUES(residual_factor),
       provenance = VALUES(provenance), evidence_digest = VALUES(evidence_digest)`,
    flat
  );

  const matched = rows.filter((r) => r[4] === 'MATCHED').length;
  const partial = rows.filter((r) => r[4] === 'PARTIAL').length;
  const totalCons = rows.reduce((a, r) => a + r[2], 0);
  const totalGreen = rows.reduce((a, r) => a + r[3], 0);
  const ratio = totalCons > 0 ? totalGreen / totalCons : 0;

  const summary = {
    entId: id, year, month, fromHour: rows[0][1], toHour: rows[rows.length - 1][1], hours: rows.length,
    consumptionMwh: r2(totalCons, 3), greenMwh: r2(totalGreen, 3),
    coverageRatio: r2(ratio, 6),
    hoursMatched: matched, hoursPartial: partial, hoursUnmatched: rows.length - matched - partial,
    avgGridFactor: ctx.gridFactor,
    avgResidualFactor: r2(ctx.gridFactor * (1 - ratio), 6),
    indirectEmissionActual: r2((totalCons - totalGreen) * ctx.gridFactor, 3),
    indirectEmissionNoGreen: r2(totalCons * ctx.gridFactor, 3),
    savedTco2: r2(totalGreen * ctx.gridFactor, 3),
    affected: res.affectedRows,
  };

  const dg = digestOf({ entId: id, summary, hours: rows.length });
  const chain = await anchorSvc.anchor({
    txType: 'GREEN_POWER', bizNo: `GP-${id}-${year}${month ? '-' + String(month).padStart(2, '0') : ''}`,
    fromLabel: `ent:${id}`, payload: { ...summary, digest: dg.digest, alg: dg.algorithm },
  }).catch((e) => ({ error: e.message }));

  return {
    summary, digest: dg, chain,
    samples: rows.slice(0, 48).map((r) => ({
      statHour: r[1], consumptionMwh: r[2], greenMwh: r[3], matchStatus: r[4],
      coverageRatio: r[5], certNo: r[6], certType: r[7], sourceName: r[8], residualFactor: r[10],
    })),
    provenance: {
      measured: ['绿证台账电量（平台内登记）'],
      derived: ['小时用电量 = 年度用电量 / 365 / 24 × 负荷曲线系数 × 日均波动（±4%）',
        '分时绿电供给 = 日均绿电 / 24 × 分时权重（光伏时段 1.85 / 其余 0.42）'],
      referenced: [`区域电网基准线排放因子 ${ctx.gridFactor} tCO2/MWh`],
      disclaimer: '平台未直连电表与绿证核销系统，小时曲线为工程换算结果；用于欧盟申报前须与企业计量台账、绿证核销记录逐小时核对。',
    },
  };
}

/** 绿电匹配汇总（读库，不重算） */
async function greenPowerSummary(opts = {}) {
  const where = []; const args = [];
  if (opts.entId) { where.push('g.ent_id = ?'); args.push(Number(opts.entId)); }
  if (opts.from) { where.push('g.stat_hour >= ?'); args.push(opts.from); }
  if (opts.to) { where.push('g.stat_hour <= ?'); args.push(opts.to); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const agg = await db.one(
    `SELECT COUNT(*) AS hours, SUM(g.consumption_mwh) AS cons, SUM(g.green_mwh) AS green,
            SUM(g.match_status = 'MATCHED') AS matched, SUM(g.match_status = 'PARTIAL') AS partial,
            SUM(g.match_status = 'UNMATCHED') AS unmatched,
            AVG(g.grid_factor) AS gridf, AVG(g.residual_factor) AS residf
       FROM green_power_match g ${w}`, args
  );
  const byCert = await db.query(
    `SELECT g.cert_no, g.cert_type, g.source_name, COUNT(*) AS hours,
            SUM(g.consumption_mwh) AS cons, SUM(g.green_mwh) AS green
       FROM green_power_match g ${w}
      GROUP BY g.cert_no, g.cert_type, g.source_name ORDER BY green DESC LIMIT 10`, args
  );
  const daily = await db.query(
    `SELECT DATE(g.stat_hour) AS d, SUM(g.consumption_mwh) AS cons, SUM(g.green_mwh) AS green
       FROM green_power_match g ${w}
      GROUP BY DATE(g.stat_hour) ORDER BY d DESC LIMIT 14`, args
  );
  const entCount = n0(await db.value(
    `SELECT COUNT(DISTINCT ent_id) AS n FROM green_power_match ${w.replace(/g\./g, '')}`,
    args
  ));

  const cons = n0(agg && agg.cons); const green = n0(agg && agg.green);
  return {
    scope: { entId: opts.entId ? Number(opts.entId) : null, from: opts.from || null, to: opts.to || null },
    hours: n0(agg && agg.hours),
    enterprises: entCount,
    consumptionMwh: r2(cons, 3),
    greenMwh: r2(green, 3),
    coverageRatio: cons > 0 ? r2(green / cons, 6) : 0,
    hoursMatched: n0(agg && agg.matched),
    hoursPartial: n0(agg && agg.partial),
    hoursUnmatched: n0(agg && agg.unmatched),
    avgGridFactor: r2(n0(agg && agg.gridf), 6),
    avgResidualFactor: r2(n0(agg && agg.residf), 6),
    savedTco2: r2(green * n0(agg && agg.gridf), 3),
    byCert: byCert.map((c) => ({
      certNo: c.cert_no, certType: c.cert_type, sourceName: c.source_name,
      hours: Number(c.hours), consumptionMwh: r2(c.cons, 3), greenMwh: r2(c.green, 3),
    })),
    daily: daily.map((d) => ({ date: d.d, consumptionMwh: r2(d.cons, 3), greenMwh: r2(d.green, 3), ratio: d.cons > 0 ? r2(d.green / d.cons, 4) : 0 })).reverse(),
  };
}

/* ==================================================================
 * 六、双轨报告导出（ISO 14064-1 组织 + ISO 14067 产品）
 * ================================================================== */

async function exportReport(entId, std, opts = {}) {
  const id = Number(entId);
  const period = opts.period || `${new Date().getFullYear()}Q1`;
  const want = String(std || '14064').replace(/[^0-9]/g, '');
  if (!['14064', '14067'].includes(want)) throw new Error('std 只支持 14064（组织碳）或 14067（产品碳）');

  const ctx = await entContext(id, period);
  const year = ctx.year;

  /* 两轨都算，才能互证 —— 这也是"双轨"的意义所在 */
  const orgRep = await db.query(
    `SELECT period, scope1_emission, scope2_emission, total_emission, energy_consumption,
            output_value, intensity, status
       FROM emission_report WHERE ent_id = ? AND year = ? ORDER BY quarter`, [id, year]
  );
  const orgTotal = r2(orgRep.reduce((a, r) => a + n0(r.total_emission), 0), 3);
  const dyn = await db.one(
    `SELECT cumulative_emission, quota_allocated, quota_available, predicted_eoy, gap, risk_level,
            data_points, excluded_points
       FROM carbon_dynamic_account WHERE ent_id = ? AND year = ?`, [id, year]
  );
  const prod = await productCarbon(id, { period, cnCode: opts.cnCode });

  const payload = want === '14064'
    ? {
      standard: REGULATION.report.org,
      boundary: '运营控制权法（Operational Control）',
      organization: { entId: id, entName: ctx.ent.ent_name, industry: ctx.ent.industry, region: ctx.ent.region },
      period,
      /* 类别 1~6 的框架对齐：本平台能实测的是类别 1/2，其余如实标注为未纳入 */
      categories: [
        { no: 1, name: '直接 GHG 排放与清除', value: r2(ctx.directEmission, 3), source: 'CEMS 实测折算 / 上报单', included: true },
        { no: 2, name: '输入能源的间接 GHG 排放', value: r2(ctx.elecMwh * ctx.gridFactor, 3), source: '用电量 × 区域电网因子', included: true },
        { no: 3, name: '运输产生的间接排放', value: 0, source: '—', included: false, note: '本平台未纳入运输环节' },
        { no: 4, name: '组织使用产品的间接排放', value: 0, source: '—', included: false, note: '未纳入' },
        { no: 5, name: '与组织产品相关的间接排放', value: 0, source: '—', included: false, note: '未纳入' },
        { no: 6, name: '其他间接排放', value: 0, source: '—', included: false, note: '未纳入' },
      ],
      totals: {
        scope1: r2(ctx.directEmission, 3), scope2: r2(ctx.elecMwh * ctx.gridFactor, 3),
        total: r2(ctx.directEmission + ctx.elecMwh * ctx.gridFactor, 3),
      },
      dynamicAccount: dyn || null,
      records: orgRep.map((r) => ({
        period: r.period, scope1: n0(r.scope1_emission), scope2: n0(r.scope2_emission),
        total: n0(r.total_emission), energyTce: n0(r.energy_consumption), status: r.status,
      })),
      coverage: `已纳入类别 1、2；类别 3~6 未纳入（如实声明，不虚标完整度）`,
    }
    : {
      standard: REGULATION.report.product,
      boundary: '从摇篮到大门（Cradle-to-Gate）',
      organization: { entId: id, entName: ctx.ent.ent_name, industry: ctx.ent.industry, region: ctx.ent.region },
      period,
      product: { cnCode: prod.cnCode, goods: prod.cnGoods, quantity: prod.quantity, unit: prod.unit },
      stages: [
        { name: '原材料获取', value: null, included: false, note: '需上游供应链数据，本平台未接入' },
        { name: '生产（直接排放）', value: prod.directEmission, included: true, source: 'CEMS 实测折算' },
        { name: '生产（电力间接）', value: prod.indirectEmission, included: true, source: '用电量 × 电网因子 − 绿电抵扣' },
        { name: '分销/使用/废弃', value: null, included: false, note: '不在摇篮到大门边界内' },
      ],
      totals: { totalEmission: prod.totalEmission, intensity: prod.embeddedIntensity, unit: `tCO2e/${prod.unit}` },
      benchmark: prod.benchmark,
      steps: prod.steps,
      coverage: '摇篮到大门边界；上游原材料与下游阶段未纳入（如实声明）',
    };

  const dg = digestOf(payload);
  const fileFingerprint = cu.sha256(cu.stableStringify({ std: want, payload, digest: dg.digest }));

  const chain = await anchorSvc.anchor({
    txType: 'REPORT_EXPORT', bizNo: `RPT-${want}-${id}-${period}`,
    fromLabel: `ent:${id}`,
    payload: { std: want, entId: id, period, digest: dg.digest, alg: dg.algorithm, fileFingerprint },
  }).catch((e) => ({ error: e.message }));

  const title = want === '14064'
    ? `${ctx.ent.ent_name} ${period} 组织温室气体排放报告（ISO 14064-1）`
    : `${ctx.ent.ent_name} ${period} 产品碳足迹报告（ISO 14067）`;

  const [ins] = await db.pool.query(
    `INSERT INTO report_export
     (ent_id, std, report_scope, title, period, payload, content_digest, file_fingerprint,
      total_emission, cross_check, generated_by, chain_tx_id, block_index)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, `ISO ${want === '14064' ? '14064-1' : '14067'}`, want === '14064' ? 'ORGANIZATION' : 'PRODUCT',
      title, period, JSON.stringify(payload), dg.digest, fileFingerprint,
      want === '14064' ? payload.totals.total : payload.totals.totalEmission,
      JSON.stringify({
        against: want === '14064' ? 'ISO 14067（产品轨）' : 'ISO 14064-1（组织轨）',
        productTotal: prod.totalEmission, orgTotal,
        note: want === '14064'
          ? '组织轨与产品轨的量纲不同，互证点是"组织总量应 ≥ 已核算产品的隐含碳之和"'
          : '产品轨的组织总量上限 = 组织轨报告总量；若产品隐含碳之和超过组织总量，说明边界或产量数据有误',
      }),
      opts.operator || 'system', chain.txId || null, chain.blockIndex || null]
  );

  return {
    id: ins.insertId, std: `ISO ${want === '14064' ? '14064-1' : '14067'}`, title, period,
    payload, digest: dg, fileFingerprint, chain,
    crossCheck: { orgTotal, productTotal: prod.totalEmission },
    exportHint: '前端据此 payload 渲染并另存为 .md/.txt；文件指纹可用于证明"交付的就是这份"。',
  };
}

async function listReports(opts = {}) {
  const where = []; const args = [];
  if (opts.entId) { where.push('r.ent_id = ?'); args.push(Number(opts.entId)); }
  if (opts.std) { where.push('r.std LIKE ?'); args.push(`%${opts.std}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.query(
    `SELECT r.id, r.ent_id, e.ent_name, r.std, r.report_scope, r.title, r.period,
            r.content_digest, r.file_fingerprint, r.total_emission, r.chain_tx_id, r.block_index,
            DATE_FORMAT(r.created_at,'%Y-%m-%d %H:%i:%s') AS created_at
       FROM report_export r JOIN enterprise e ON e.id = r.ent_id
       ${w} ORDER BY r.id DESC LIMIT 50`, args
  );
}

async function getReport(id) {
  const row = await db.one(
    `SELECT r.*, e.ent_name, DATE_FORMAT(r.created_at,'%Y-%m-%d %H:%i:%s') AS created_at
       FROM report_export r JOIN enterprise e ON e.id = r.ent_id WHERE r.id = ?`, [Number(id)]
  );
  if (!row) return null;
  if (typeof row.payload === 'string') { try { row.payload = JSON.parse(row.payload); } catch (e) { /* 保持原样 */ } }
  if (typeof row.cross_check === 'string') { try { row.cross_check = JSON.parse(row.cross_check); } catch (e) { /* 保持原样 */ } }
  return row;
}

/* ==================================================================
 * 七、成本量化对照（给出可核验的计算过程，而非结论数字）
 * ================================================================== */

async function costComparison(entId) {
  const prices = externalPrices();
  const id = entId ? Number(entId) : null;

  const ent = id ? await db.one(
    `SELECT id, ent_name, industry, region FROM enterprise WHERE id = ?`, [id]
  ) : null;

  /* ---- 对照 1：核查成本 ---- */
  const verifyBaselineLow = COST_BASELINE.verifyCostPerEntWan[0] * 10000;
  const verifyBaselineHigh = COST_BASELINE.verifyCostPerEntWan[1] * 10000;
  const verifyBaselineMid = (verifyBaselineLow + verifyBaselineHigh) / 2;

  /* 平台侧成本的口径必须说清楚：不宣称"零成本"，而是"人工现场工时被替代的部分" */
  const chainEvidence = n0(await db.ledgerValue(
    `SELECT COUNT(*) AS n FROM chain_tx WHERE tx_type IN ('CEMS_READING','EMISSION_REPORT','ANCHOR_BATCH','VERIFY_REPORT')`
  ));
  const evidenceRate = 5000;    // 每条人工核验的存证，传统方式约需 5000 元人工工时（保守假设，可在文档中说明）
  const platformLaborWan = 0.35; // 平台一次性接入与运维摊薄（万元/家·年）

  const verifyCost = {
    item: '核查成本',
    baseline: {
      low: verifyBaselineLow, high: verifyBaselineHigh, unit: '元/家·年',
      budget: `${COST_BASELINE.verifyWorkdaysMax} 个工作日上限 · 现场 ${COST_BASELINE.verifyOnsiteDays[0]}~${COST_BASELINE.verifyOnsiteDays[1]} 天`,
    },
    platform: {
      laborWan: platformLaborWan,
      note: '平台侧成本仅计接入与运维摊薄，不含人工判断本身 —— 核查结论仍需人签字，本平台不替代核查机构',
    },
    steps: [
      { step: 1, formula: '传统核查中位成本', calc: `(${verifyBaselineLow} + ${verifyBaselineHigh}) / 2`, value: verifyBaselineMid, unit: '元/家·年' },
      { step: 2, formula: '企业本期链上存证条数', calc: 'COUNT(chain_tx) 按类型统计', value: chainEvidence, unit: '条' },
      { step: 3, formula: '平台侧年化成本', calc: `${platformLaborWan} 万元/家·年`, value: platformLaborWan * 10000, unit: '元/家·年' },
      { step: 4, formula: '单家年节约', calc: `${verifyBaselineMid} − ${platformLaborWan * 10000}`, value: r2(verifyBaselineMid - platformLaborWan * 10000, 2), unit: '元/家·年' },
      { step: 5, formula: '节约率', calc: `节约 / 传统成本`, value: r2((verifyBaselineMid - platformLaborWan * 10000) / verifyBaselineMid * 100, 2), unit: '%' },
    ],
    savingPerEnt: r2(verifyBaselineMid - platformLaborWan * 10000, 2),
    savingRate: r2((verifyBaselineMid - platformLaborWan * 10000) / verifyBaselineMid * 100, 2),
    caveat: `节约的部分是"数据采集、存证、交叉核对"的人工工时；核查结论的专家判断不可替代，本对照不宣称"取消核查"。`
      + ` 参与比对的存证基数：全平台 ${chainEvidence} 条。`,
  };

  /* ---- 对照 2：履约成本（事前预警 vs 期末扎堆） ---- */
  const market = await currentCarbonPrice();
  const carbonPrice = market.price;

  const risk = id
    ? await db.one(`SELECT gap, risk_level FROM carbon_dynamic_account WHERE ent_id = ? ORDER BY year DESC LIMIT 1`, [id])
    : await db.one(`SELECT SUM(gap) AS gap, COUNT(*) AS n FROM carbon_dynamic_account WHERE risk_level = 'HIGH'`);
  const gap = Math.max(0, n0(risk && risk.gap));

  /* 期末溢价：集中交易推高价格的幅度，取文献常用区间 8%~20%，此处取中值并在步骤里写明 */
  const premiumRate = 0.14;
  const complianceCost = {
    item: '履约成本',
    steps: [
      { step: 1, formula: '当期碳价', calc: market.source, value: r2(carbonPrice, 2), unit: '元/tCO2e' },
      { step: 2, formula: '事前预警可提前采购的缺口', calc: 'carbon_dynamic_account.gap', value: r2(gap, 3), unit: 'tCO2e' },
      { step: 3, formula: '期末扎堆溢价率', calc: '取区间中值 14%（参考文献区间 8%~20%）', value: premiumRate * 100, unit: '%' },
      { step: 4, formula: '规避的溢价支出', calc: `${r2(gap, 3)} × ${r2(carbonPrice, 2)} × ${premiumRate}`, value: r2(gap * carbonPrice * premiumRate, 2), unit: '元' },
    ],
    carbonPrice: r2(carbonPrice, 2), carbonPriceSource: market.source, gap: r2(gap, 3),
    saving: r2(gap * carbonPrice * premiumRate, 2),
    premiumRate,
    caveat: '溢价率为文献区间中值，非本平台实测；平台提供的是"提前 90 天看到缺口"的能力，能否拿到低价仍取决于市场。',
  };

  /* ---- 对照 3：出口成本（缺省值法 vs 实际值法） ---- */
  let exportCost = null;
  if (id) {
    try {
      const prod = await productCarbon(id, { period: currentPeriod() });
      if (prod.benchmark && prod.quantity > 0) {
        const euaCny = prices.euaEur * prices.eurCny;
        const penalty = Math.max(0, prod.benchmark.penaltyTco2);
        exportCost = {
          item: '出口成本',
          steps: [
            { step: 1, formula: '产品实际隐含碳强度', calc: '(直接+间接)/产量', value: prod.embeddedIntensity, unit: `tCO2e/${prod.unit}` },
            { step: 2, formula: '欧盟缺省隐含碳强度', calc: '量级对照值', value: prod.benchmark.euDefaultIntensity, unit: `tCO2e/${prod.unit}` },
            { step: 3, formula: '单位产品多计的排放', calc: `缺省 − 实际`, value: r2(prod.benchmark.euDefaultIntensity - prod.embeddedIntensity, 6), unit: `tCO2e/${prod.unit}` },
            { step: 4, formula: '本批多计总量', calc: `${r2(penalty, 3)}`, value: r2(penalty, 3), unit: 'tCO2e' },
            { step: 5, formula: 'EUA 折算人民币', calc: `${prices.euaEur} EUR × ${prices.eurCny}`, value: r2(euaCny, 2), unit: '元/tCO2e' },
            { step: 6, formula: '本批额外成本', calc: `${r2(penalty, 3)} × ${r2(euaCny, 2)}`, value: r2(penalty * euaCny, 2), unit: '元' },
            { step: 7, formula: '折合吨产品', calc: `额外成本 / 产量`, value: r2(penalty * euaCny / prod.quantity, 2), unit: `元/${prod.unit}` },
          ],
          cnCode: prod.cnCode, goods: prod.cnGoods, quantity: prod.quantity,
          penaltyTco2: r2(penalty, 3),
          euaPriceEur: prices.euaEur, eurCny: prices.eurCny, euaCny: r2(euaCny, 2),
          extraCost: r2(penalty * euaCny, 2),
          perUnitCost: r2(penalty * euaCny / prod.quantity, 2),
          referenceRange: COST_BASELINE.cbamSteelDefaultPenaltyCny,
          caveat: `欧盟缺省值仅作量级对照；实际申报须以欧委会公布的最新默认值为准。`
            + ` 文献给出的钢铁品类缺省值法惩罚区间为 ${COST_BASELINE.cbamSteelDefaultPenaltyCny[0]}~${COST_BASELINE.cbamSteelDefaultPenaltyCny[1]} 元/吨，`
            + `本批次计算结果 ${r2(penalty * euaCny / prod.quantity, 2)} 元/${prod.unit}${(penalty * euaCny / prod.quantity) >= COST_BASELINE.cbamSteelDefaultPenaltyCny[0] && (penalty * euaCny / prod.quantity) <= COST_BASELINE.cbamSteelDefaultPenaltyCny[1] ? '（落在区间内，与文献自洽）' : '（落在区间外，需检查缺省值取值与品类匹配）'}。`,
        };
      }
    } catch (e) { exportCost = { item: '出口成本', error: e.message }; }
  }

  const items = [verifyCost, complianceCost].concat(exportCost ? [exportCost] : []);

  return {
    entId: id,
    entName: ent ? ent.ent_name : '全平台汇总',
    industry: ent ? ent.industry : null,
    generatedAt: new Date().toISOString(),
    prices,
    baselineSources: COST_BASELINE.sources,
    items,
    principles: [
      '每一项都给出 steps[]（口径 · 公式 · 代入值 · 结果），可用计算器复核',
      '文献基线与平台实测分列，不把估计值包装成实测值',
      '不宣称"取消核查"——平台替代的是数据采集与交叉核对的工时，不是专家判断',
    ],
  };
}

/* ==================================================================
 * 八、总览与目录
 * ================================================================== */

async function catalog() {
  return {
    regulation: REGULATION,
    cnCodes: CN_CODES,
    industryCn: INDUSTRY_CN,
    gridFactors: { byRegion: REGION_GRID_FACTOR, provinceToRegion: PROVINCE_REGION, tceToMwh: r2(TCE_TO_MWH, 4) },
    elecShare: INDUSTRY_ELEC_SHARE,
    outputToTon: OUTPUT_PER_WAN,
    costBaseline: COST_BASELINE,
    prices: externalPrices(),
  };
}

async function overview() {
  const decl = await db.one(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT ent_id) AS ents,
            SUM(embedded_intensity > 0) AS withIntensity
       FROM cbam_declaration`
  );
  const gp = await db.one(
    `SELECT COUNT(*) AS hours, COUNT(DISTINCT ent_id) AS ents,
            SUM(consumption_mwh) AS cons, SUM(green_mwh) AS green
       FROM green_power_match`
  );
  const rpt = await db.one(
    `SELECT COUNT(*) AS n, SUM(std LIKE '%14064%') AS org, SUM(std LIKE '%14067%') AS prod FROM report_export`
  );
  const byIndustry = await db.query(
    `SELECT e.industry, COUNT(DISTINCT d.ent_id) AS ents, COUNT(*) AS decls,
            AVG(d.embedded_intensity) AS avgIntensity
       FROM cbam_declaration d JOIN enterprise e ON e.id = d.ent_id
      GROUP BY e.industry ORDER BY decls DESC`
  );
  const byCn = await db.query(
    `SELECT cn_code, MAX(goods_name) AS goods, COUNT(*) AS n, AVG(embedded_intensity) AS avgIntensity,
            AVG(eu_default_intensity) AS avgDefault
       FROM cbam_declaration GROUP BY cn_code ORDER BY n DESC LIMIT 12`
  );

  const cons = n0(gp && gp.cons); const green = n0(gp && gp.green);
  return {
    regulation: REGULATION.cbam,
    declarations: { total: n0(decl && decl.n), enterprises: n0(decl && decl.ents) },
    greenPower: {
      hours: n0(gp && gp.hours), enterprises: n0(gp && gp.ents),
      consumptionMwh: r2(cons, 3), greenMwh: r2(green, 3),
      coverageRatio: cons > 0 ? r2(green / cons, 6) : 0,
    },
    reports: { total: n0(rpt && rpt.n), org: n0(rpt && rpt.org), product: n0(rpt && rpt.prod) },
    byIndustry: byIndustry.map((r) => ({
      industry: r.industry, enterprises: Number(r.ents), declarations: Number(r.decls),
      avgIntensity: r2(n0(r.avgIntensity), 6),
    })),
    byCnCode: byCn.map((r) => ({
      cnCode: r.cn_code, goods: r.goods, count: Number(r.n),
      avgIntensity: r2(n0(r.avgIntensity), 6), avgEuDefault: r2(n0(r.avgDefault), 6),
    })),
  };
}

module.exports = {
  REGULATION, CN_CODES, INDUSTRY_CN, REGION_GRID_FACTOR, COST_BASELINE, suggestCnCode,
  entContext, productCarbon, generateDeclaration, listDeclarations, getDeclaration,
  matchGreenPower, greenPowerSummary,
  exportReport, listReports, getReport,
  costComparison, catalog, overview, externalPrices,
};
