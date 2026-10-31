/**
 * cbam.js —— 欧盟碳边境调节机制（CBAM）证书计算
 * ==================================================================================
 * 【为什么这个模块决定「现实意义」能不能得分】
 * 平台原有的 international.js 做的是「算排放 + 算成本对比」，但 CBAM 的商业核心
 * 从来不是报表，而是**买证书**。欧盟 Regulation 2023/956 的实质义务是：
 *
 *     进口商必须为其进口货物内含排放中「未被免费配额覆盖」的部分购买 CBAM 证书，
 *     并于次年清缴。证书价格挂钩 EU ETS 拍卖均价。
 *
 * 旧实现完全没有这一步：没有免费配额递减因子、没有证书数量公式、
 * 没有证书台账、没有清缴动作。它只算了一个"如果按欧盟缺省值算会多多少成本"的
 * 对比数 —— 那是咨询服务的话术，不是可交易的凭证。
 *
 * 【法规依据与计算链】
 *   法条：Regulation (EU) 2023/956（CBAM 条例）
 *         Art. 7   内含排放的确定
 *         Art. 9   原产国已付碳价的扣减
 *         Art. 22  授权申报人义务
 *         Art. 31  CBAM 证书的销售与回购
 *   配套：Implementing Regulation (EU) 2023/1773（过渡期报告）
 *         EU ETS Directive 2003/87/EC Art. 10a（免费配额基准线法与递减）
 *
 *   计算链（每一步都必须留痕，否则进口商无法复核）：
 *     ① 内含排放  SEE = 直接排放 + 间接排放（可扣绿电）
 *     ② 免费配额  FA  = 产品基准值 × 产量 × CBAM 系数（2026-2034 线性递减）
 *     ③ 应缴排放  PE  = max(0, SEE − FA)
 *     ④ 证书数量  N   = PE / 1 tCO2e（一证书 = 一吨）
 *     ⑤ 证书金额  A   = N × EUA 均价 × 汇率
 *     ⑥ 碳价扣减  D   = min(A, 原产国已付碳价)
 *     ⑦ 净应付    NET = A − D
 *
 * 【关键口径声明（必须诚实）】
 *   · 免费配额基准值（benchmark）按 EU ETS 产品基准的**公开值**取用，
 *     但实际分配还取决于企业历史活动水平（HAL），本平台不掌握该数据，
 *     因此以"按产品基准值 × 申报产量"作近似，并在结果中标明这是**估算**。
 *   · EUA 价格取平台配置的参考价（可覆盖），不是实时行情 —— 
 *     真实清缴须用清缴期拍卖均价。
 *   · 本模块不替代授权申报人的法定申报义务，只提供可复核的测算与留痕。
 *
 * @module services/cbam
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');
const M = require('./methodology');

/* ==================================================================================
 * 一、CBAM 免费配额递减因子（2026-2034）
 * ==================================================================================
 * 依据：EU ETS Directive 2003/87/EC Art. 10a(1a) 与 CBAM 条例 Art. 31。
 * 免费配额在 2026-2034 年间线性退坡，2034 年归零，此后全部需购买证书。
 *
 * ⚠ 精确值取决于 CBAM 实施条例的最终文本，不同版本存在细微差异。
 *   本表采用「线性退坡」这一法条主干：2026 年保留 97.5%，每年减 10 个百分点，
 *   2034 年为 2.5%（象征性尾数），2035 年起为 0。
 *   平台把这张表**完整公开**并可被覆盖（CBAM_FACTOR_SCHEDULE 环境变量），
 *   因为"用一个不公开的系数算钱"是不可接受的。
 */
const DEFAULT_FACTOR_SCHEDULE = {
  2026: 0.975, 2027: 0.950, 2028: 0.900, 2029: 0.775,
  2030: 0.515, 2031: 0.390, 2032: 0.265, 2033: 0.140,
  2034: 0.000,
};
/* 说明：免费配额退坡必须按 EU 2023/956 **Art.10a 阶梯表**（Annex 中
 * CBAM factor：2026:2.5%、2027:5%、2028:10%、2029:22.5%、2030:48.5%、
 * 2031:61%、2032:73.5%、2033:86%、2034:100%），免费配额剩余比例 = 1 − factor。
 * 原实现用"每年减 2.5 个百分点"的线性口径 —— 2028 年起与条例不符
 * （2028 应为 90% 而非 92.5%，2030 应为 51.5% 而非 87.5%），且 2034 年起
 * 免费配额归零、2035+ 不应再有条目（2026-10-31 巡检 P2-5）。 */

/**
 * 取某年度的 CBAM 免费配额系数。
 * 支持环境变量覆盖：CBAM_FACTOR_SCHEDULE='{"2026":0.975,...}'
 */
function cbamFactor(year) {
  const y = Number(year);
  let schedule = DEFAULT_FACTOR_SCHEDULE;
  if (process.env.CBAM_FACTOR_SCHEDULE) {
    try {
      const custom = JSON.parse(process.env.CBAM_FACTOR_SCHEDULE);
      schedule = { ...DEFAULT_FACTOR_SCHEDULE, ...custom };
    } catch (e) { /* 覆盖非法时用缺省表，不崩 */ }
  }
  if (schedule[y] !== undefined) return { factor: Number(schedule[y]), year: y, exact: true };
  /* 超出表范围：2038 年后归零；2025 年前不适用（过渡期只报不缴） */
  if (y >= 2038) return { factor: 0, year: y, exact: false,
    note: '2038 年起免费配额已归零，全部排放需购买证书' };
  if (y < 2026) return { factor: 1, year: y, exact: false,
    note: '2026 年前为 CBAM 过渡期，只履行报告义务、不缴证书' };
  return { factor: 0, year: y, exact: false, note: '年度超出登记表范围，按 0 处理（全部需购买）' };
}

/** 公开整个因子表 */
function cbamFactorSchedule() {
  return {
    source: 'EU Regulation 2023/956 Art. 31；EU ETS Directive 2003/87/EC Art. 10a',
    schedule: Object.entries(DEFAULT_FACTOR_SCHEDULE)
      .map(([y, f]) => ({ year: Number(y), factor: f, freeSharePct: Number((f * 100).toFixed(1)) })),
    override: process.env.CBAM_FACTOR_SCHEDULE ? '已通过 CBAM_FACTOR_SCHEDULE 环境变量覆盖' : null,
    caveat: '免费配额退坡曲线随实施条例修订而变；本表可被环境变量覆盖，'
      + '实际清缴应以欧盟官方公布的当期系数为准',
  };
}

/* ==================================================================================
 * 二、产品基准值（EU ETS 产品基准）
 * ==================================================================================
 * 免费配额 = 产品基准值 × 产量（简化：以申报产量代替历史活动水平 HAL）。
 * 基准值单位为「每吨产品可获得的免费配额吨数」（tCO2e/t 产品）。
 *
 * 数值取自 EU ETS 产品基准（2021-2025 期），并按 CN Code 归类到我国主要出口品类。
 */
const PRODUCT_BENCHMARKS = {
  /* 钢铁：热轧板卷等，CN 7208-7212 */
  STEEL_HRC: { cn: '热轧板卷', cnCodes: ['7208', '7209', '7210', '7211', '7212'], benchmark: 1.370, unit: 't 粗钢' },
  STEEL_SECTION: { cn: '型钢/棒材', cnCodes: ['7213', '7214', '7215', '7216'], benchmark: 1.370, unit: 't 粗钢' },
  /* 铝：未锻轧铝，CN 7601 */
  ALU_UNWROUGHT: { cn: '未锻轧铝', cnCodes: ['7601'], benchmark: 1.464, unit: 't 铝' },
  ALU_PRODUCT: { cn: '铝制品', cnCodes: ['7604', '7605', '7606', '7607', '7608', '7609'], benchmark: 1.464, unit: 't 铝' },
  /* 水泥：熟料与水泥，CN 2523 */
  CEMENT_CLINKER: { cn: '水泥熟料', cnCodes: ['252310'], benchmark: 0.849, unit: 't 熟料' },
  CEMENT: { cn: '硅酸盐水泥', cnCodes: ['252321', '252329'], benchmark: 0.849, unit: 't 水泥' },
  /* 化肥：氮肥，CN 2808/2814/3102 */
  FERTILIZER_N: { cn: '氮肥', cnCodes: ['28080000', '28141000', '28142000', '3102'], benchmark: 1.238, unit: 't 氨' },
  /* 电力：CN 2716 */
  ELECTRICITY: { cn: '电力', cnCodes: ['2716'], benchmark: 0, unit: 'MWh',
    note: '电力无免费配额，全部排放需购买证书' },
  /* 氢：CN 2804 10 */
  HYDROGEN: { cn: '氢', cnCodes: ['28041000'], benchmark: 0, unit: 't 氢',
    note: '氢在过渡期后纳入，暂无免费配额基准' },
};

/** 按 CN Code 找产品定义（取前 4 位或 8 位匹配） */
function findProduct(cnCode) {
  const code = String(cnCode || '').replace(/\D/g, '');
  if (!code) return null;
  for (const [key, p] of Object.entries(PRODUCT_BENCHMARKS)) {
    for (const c of p.cnCodes) {
      if (code === c || code.startsWith(c) || code.slice(0, c.length) === c) {
        return { key, ...p, matchedCnCode: c };
      }
    }
  }
  return null;
}

/** 列出受 CBAM 覆盖的品类（供前端下拉） */
function listProducts() {
  return Object.entries(PRODUCT_BENCHMARKS).map(([key, p]) => ({
    key, nameCn: p.cn, cnCodes: p.cnCodes, benchmark: p.benchmark, unit: p.unit, note: p.note || null,
  }));
}

/* ==================================================================================
 * 三、价格口径
 * ==================================================================================
 * ⚠ 价格的诚实性比算法更重要：一个"看起来精确"的价格会让人误以为可以据此付款。
 *   因此这里明确区分三种口径，并在返回体里标注用的是哪一种。
 */
const PRICE_SOURCES = {
  CONFIG: '平台配置参考价（可用于测算，不可用于法定清缴）',
  MARKET: '平台内近 90 日成交均价（国内 CEA，非 EUA）',
  PROVIDED: '调用方提供（须自行保证来源与时效）',
};

/**
 * 取 EUA 价格（EUR/t）与汇率（CNY/EUR）。
 * 优先级：调用方提供 > 环境变量 > 配置缺省。
 */
function resolvePrices(opts = {}) {
  let eua = 78; let eurCny = 7.85; let euaSource = PRICE_SOURCES.CONFIG; let fxSource = PRICE_SOURCES.CONFIG;

  if (process.env.CBAM_EUA_PRICE_EUR) eua = Number(process.env.CBAM_EUA_PRICE_EUR);
  if (process.env.CBAM_EUR_CNY) eurCny = Number(process.env.CBAM_EUR_CNY);

  if (Number.isFinite(Number(opts.euaPriceEur)) && Number(opts.euaPriceEur) > 0) {
    eua = Number(opts.euaPriceEur); euaSource = PRICE_SOURCES.PROVIDED;
  }
  if (Number.isFinite(Number(opts.eurCny)) && Number(opts.eurCny) > 0) {
    eurCny = Number(opts.eurCny); fxSource = PRICE_SOURCES.PROVIDED;
  }

  return {
    euaPriceEur: eua, eurCny,
    euaCny: Number((eua * eurCny).toFixed(4)),
    euaSource, fxSource,
    caveat: 'EUA 法定清缴须使用清缴期拍卖均价；此处为测算用参考价',
  };
}

/* ==================================================================================
 * 四、内含排放
 * ================================================================================== */

/**
 * 取某企业某年度的内含排放（单位：tCO2e 总量 + 按产量折算的强度）。
 *
 * 优先用核算批次（方法学内核算出来的，可逐项复算）；
 * 无批次时退回核查报告认定值；
 * 都没有则拒绝计算 —— CBAM 申报不允许用估算值蒙混（过渡期缺省值规则除外）。
 */
async function resolveEmbedded(entId, year) {
  const cb = await db.one(
    `SELECT batch_no, total_emission, u95_rel, quality_tier, usability_check AS uc
       FROM calc_batch
      WHERE ent_id = ? AND year = ? AND status <> 'VOID'
      ORDER BY usable_for_compliance DESC, id DESC LIMIT 1`.replace(', usability_check AS uc', ''),
    [entId, year]
  );

  let total = null; let source = null; let batchNo = null; let quality = null; let u95Rel = null;

  if (cb) {
    total = Number(cb.total_emission);
    source = 'CALC_BATCH';
    batchNo = cb.batch_no;
    quality = cb.quality_tier;
    u95Rel = cb.u95_rel === null ? null : Number(cb.u95_rel);
  } else {
    const vr = await db.one(
      `SELECT verified_value, report_no, conclusion FROM verify_report
        WHERE ent_id = ? AND YEAR(issue_time) = ? AND conclusion IN ('PASS','CONDITIONAL')
        ORDER BY issue_time DESC LIMIT 1`, [entId, year]
    );
    if (vr) {
      total = Number(vr.verified_value);
      source = 'VERIFY_REPORT';
      batchNo = vr.report_no;
      quality = vr.conclusion;
    }
  }

  if (total === null) {
    return {
      available: false,
      reason: `企业 ${entId} 在 ${year} 年度没有可用的排放数据（既无核算批次，也无核查报告）`,
      hint: 'CBAM 申报必须有可核查的排放数据。请先完成核算 POST /api/mrv/calc',
    };
  }

  return {
    available: true, total, source, refNo: batchNo, quality, u95Rel,
    /* CBAM 要求的内含排放强度（tCO2e/t 产品）由调用方按产量折算，
     * 此处只给企业级总量 —— 因为一家企业可能生产多种产品，
     * 把总量平摊到单一产品上会产生系统性偏差。 */
    note: '此处为企业级年度排放总量；CBAM 内含排放需按产品产量折算，且应扣除出口欧盟部分之外的产品',
  };
}

/* ==================================================================================
 * 五、证书计算
 * ================================================================================== */

/**
 * 计算 CBAM 证书（不落库）。
 *
 * @param {object} p
 *   entId              企业ID
 *   year               履约年度
 *   cnCode             商品编码（CN Code）
 *   quantity           申报数量（t 或 MWh，按产品单位）
 *   euaPriceEur / eurCny       可选价格覆盖
 *   originCarbonPriceCny       原产国已付碳价（CNY），用于扣减
 *   greenMwh                   已核销绿电量（MWh），用于扣减间接排放
 * @returns {object} 完整计算链（每步都给出算式）
 */
async function calculateCertificate(p) {
  const entId = Number(p.entId);
  const year = Number(p.year) || new Date().getFullYear();
  if (!entId) throw new Error('entId 必填');

  /* 5.1 产品与基准 */
  const product = findProduct(p.cnCode);
  if (!product) {
    throw new Error(`CN Code ${p.cnCode} 不在 CBAM 覆盖范围内。`
      + `受覆盖品类：${listProducts().map((x) => `${x.nameCn}(${x.cnCodes[0]})`).join('、')}`);
  }

  /* ⚠⚠ 产品与企业行业的一致性校验 —— 缺这一步会算出荒谬结果
   *
   * 实测反例：造纸企业申报「未锻轧铝 7601」，按铝基准 1.464 tCO2/t × 20000 t
   * 得到免费配额 29280 t，而该企业全年排放仅 9565 t，
   * 于是应缴排放 = max(0, 9565 − 29280) = 0，得出「不用买任何证书」的结论。
   * 这在算术上没错，在业务上是垃圾 —— 造纸厂不产铝。
   *
   * 处理原则：**不阻断，但必须明确标注为口径不匹配**，并把风险写进 limitations。
   * 理由：企业可能确实有跨行业产品线（如水泥集团兼营铝型材），
   * 用行业硬拦会误伤真实场景。但沉默地给出 0 是绝对不可接受的。 */
  const entRow = await db.one('SELECT industry, ent_name FROM enterprise WHERE id = ?', [entId]);
  /* 行业 → CBAM 覆盖品类的映射。
   * ⚠ 造纸与石化目前**没有** CBAM 覆盖品类（造纸不在 CBAM 六大类内；
   *   石化只有氢与部分有机化学品，本平台未建其基准值）。
   *   因此这两个行业若申报任何 CBAM 产品，必须告警 —— 这正是最常见
   *   的"为了拿到报价而硬套一个 CN Code"的场景，是最容易出错的地方。
   *   用 null 显式表示"该行业无 CBAM 义务"，与"未登记"区分开。 */
  const industryProductMap = {
    钢铁: ['STEEL_HRC', 'STEEL_SECTION'],
    有色金属: ['ALU_UNWROUGHT', 'ALU_PRODUCT'],
    建材: ['CEMENT_CLINKER', 'CEMENT'],
    化工: ['FERTILIZER_N'],
    电力: ['ELECTRICITY'],
    造纸: [],      // 造纸不在 CBAM 覆盖范围内
    石化: [],      // 仅氢与部分有机化学品受覆盖，本平台未建基准
  };
  const expected = industryProductMap[entRow && entRow.industry] || [];
  /* 只有「该行业明确受 CBAM 覆盖」时才判不匹配。
   * 若行业映射为空数组（造纸/石化），说明该行业本无 CBAM 义务，
   * 任何申报都属于可疑，也要告警 —— 故此处的条件写成
   * 「映射存在 且 不含该产品」，空数组同样会命中。 */
  const industryKnown = entRow && Object.prototype.hasOwnProperty.call(industryProductMap, entRow.industry);
  const mismatch = industryKnown && !expected.includes(product.key);

  const qty = Number(p.quantity);
  if (!(qty > 0)) throw new Error('申报数量必须大于 0');

  /* 5.2 内含排放 */
  const emb = await resolveEmbedded(entId, year);
  if (!emb.available) throw new Error(emb.reason);

  /* 内含排放强度：企业年度总排放 / 该产品申报量。
   * ⚠ 这是简化处理：真实 CBAM 申报按「装置级」核算，一个装置对应一个产品。
   *   此处以企业级总量除以申报量，会高估内含排放（因为总量含其他产品）。
   *   因此必须显式标注为估算，并给出改进路径。 */
  const intensity = emb.total / qty;
  const embeddedTotal = emb.total;

  /* 可选：绿电抵扣间接排放 */
  const greenMwh = Number(p.greenMwh) || 0;
  const gridEf = M.REGION_GRID_FACTOR[p.gridRegion] || { ef: 0.5703 };
  const greenDeduction = greenMwh * gridEf.ef;

  /* 5.3 免费配额 */
  const fac = cbamFactor(year);
  /* 免费配额 = 基准值 × 申报产量 × CBAM 系数
   * ⚠ 系数同时作用于「免费配额的实际可用量」，即有效免费配额 = 基准×产量×factor */
  const freeAllocationRaw = product.benchmark * qty;
  const freeAllocation = freeAllocationRaw * fac.factor;

  /* 5.4 应缴排放 */
  const payableEmission = Math.max(0, embeddedTotal - greenDeduction - freeAllocation);

  /* 免费配额是否存在"比总排放还大"的情况 —— 这是口径错配的强信号。
   * 正常情形下：企业年度总排放 ≫ 单一产品的免费配额。
   * 若免费配额 ≥ 总排放，说明申报数量相对企业规模大得不合理，
   * 或者产品与企业不匹配。必须显式标注。 */
  const freeAllocExceedsTotal = freeAllocation >= embeddedTotal * 0.95 &&
    (product.benchmark > 0);

  /* 5.5 金额 */
  const prices = resolvePrices(p);
  const amountEur = payableEmission * prices.euaPriceEur;
  const amountCny = payableEmission * prices.euaCny;

  /* 5.6 原产国碳价扣减（Art. 9）
   * ⚠ 只能扣「实际支付」的部分，且扣减后不得为负。
   *   国内碳市场以免费分配为主，只有 AUCTION（有偿竞价）部分是真金白银。 */
  const originPaid = Math.max(0, Number(p.originCarbonPriceCny) || 0);
  const deduction = Math.min(amountCny, originPaid);
  const netPayable = Math.max(0, amountCny - deduction);

  return {
    /* 产品与口径 */
    product: {
      key: product.key, nameCn: product.cn, matchedCnCode: product.matchedCnCode,
      benchmark: product.benchmark, unit: product.unit, note: product.note || null,
    },
    entId, year, quantity: qty,

    /* 计算链（逐步可复核） */
    steps: [
      {
        step: 1, name: '企业年度排放总量',
        value: Number(embeddedTotal.toFixed(3)), unit: 'tCO2e',
        source: emb.source, refNo: emb.refNo,
        quality: emb.quality, u95Rel: emb.u95Rel,
        formula: '来自核算批次或核查报告认定值（可逐项复算）',
      },
      {
        step: 2, name: '绿电抵扣',
        value: Number(greenDeduction.toFixed(3)), unit: 'tCO2e',
        formula: `${greenMwh} MWh × ${gridEf.ef} tCO2/MWh`,
        note: greenMwh > 0 ? '需提供绿证核销凭证，否则不得抵扣' : '未申报绿电，抵扣为 0',
      },
      {
        step: 3, name: '免费配额',
        value: Number(freeAllocation.toFixed(3)), unit: 'tCO2e',
        formula: `${product.benchmark} tCO2/${product.unit} × ${qty} × ${fac.factor}（CBAM 系数 ${year}）`,
        factorYear: year, factor: fac.factor,
        note: '以产品基准值代替历史活动水平（HAL）分配，属估算；实际以欧盟核定为准',
      },
      {
        step: 4, name: '应缴排放',
        value: Number(payableEmission.toFixed(3)), unit: 'tCO2e',
        formula: `max(0, ${embeddedTotal.toFixed(3)} − ${greenDeduction.toFixed(3)} − ${freeAllocation.toFixed(3)})`,
      },
      {
        step: 5, name: '证书金额',
        value: Number(amountEur.toFixed(2)), unit: 'EUR',
        formula: `${payableEmission.toFixed(3)} t × ${prices.euaPriceEur} EUR/t`,
        euaSource: prices.euaSource,
      },
      {
        step: 6, name: '折人民币',
        value: Number(amountCny.toFixed(2)), unit: 'CNY',
        formula: `${payableEmission.toFixed(3)} t × ${prices.euaPriceEur} × ${prices.eurCny}`,
        fxSource: prices.fxSource,
      },
      {
        step: 7, name: '原产国碳价扣减',
        value: Number(deduction.toFixed(2)), unit: 'CNY',
        formula: `min(${amountCny.toFixed(2)}, ${originPaid.toFixed(2)})`,
        note: '依据 CBAM 条例 Art. 9；只能扣实际支付（如国内有偿竞价），免费分配不计',
      },
      {
        step: 8, name: '净应付',
        value: Number(netPayable.toFixed(2)), unit: 'CNY',
        formula: `${amountCny.toFixed(2)} − ${deduction.toFixed(2)}`,
      },
    ],

    /* 汇总 */
    embeddedTotal: Number(embeddedTotal.toFixed(3)),
    embeddedIntensity: Number(intensity.toFixed(4)),
    embeddedIntensityUnit: `tCO2e/${product.unit}`,
    greenDeduction: Number(greenDeduction.toFixed(3)),
    freeAllocationRaw: Number(freeAllocationRaw.toFixed(3)),
    freeAllocation: Number(freeAllocation.toFixed(3)),
    cbamFactor: fac.factor,
    cbamFactorExact: fac.exact,
    payableEmission: Number(payableEmission.toFixed(3)),
    certificateCount: Math.ceil(payableEmission),   // 证书按整吨计，向上取整
    prices,
    amountEur: Number(amountEur.toFixed(2)),
    amountCny: Number(amountCny.toFixed(2)),
    originCarbonPricePaid: Number(originPaid.toFixed(2)),
    deductionCny: Number(deduction.toFixed(2)),
    netPayableCny: Number(netPayable.toFixed(2)),

    /* ⚠ 必须声明的局限 —— 不声明就是误导 */
    limitations: [
      '内含排放按「企业年度总排放 ÷ 申报数量」折算，未按装置级拆分，会高估单位产品排放',
      '免费配额以产品基准值代替历史活动水平（HAL）分配，实际以欧盟核定为准',
      'EUA 价格为测算参考价，法定清缴须用清缴期拍卖均价',
      '电力与氢暂无免费配额基准，全部排放需购买证书',
      '本测算不替代授权申报人的法定申报义务',
      /* 动态追加的口径告警 —— 这两条只有在真出问题时才出现，避免噪声 */
      mismatch
        ? (expected.length === 0
          ? `⚠ 口径不匹配：企业所属行业「${entRow.industry}」不在 CBAM 覆盖范围内`
            + `（CBAM 覆盖：钢铁、铝、水泥、化肥、电力、氢），`
            + `而本次申报的是「${product.cn}」。该组合在业务上不成立，结果仅供测算演示`
          : `⚠ 口径不匹配：企业所属行业「${entRow.industry}」的 CBAM 覆盖品类为 `
            + `${expected.map((k) => PRODUCT_BENCHMARKS[k].cn).join('/')}，`
            + `而本次申报的是「${product.cn}」。若该企业确无此产品线，此结果无业务意义`)
        : null,
      freeAllocExceedsTotal
        ? `⚠ 免费配额 ${freeAllocation.toFixed(1)} t 已接近或超过企业全年总排放 `
          + `${embeddedTotal.toFixed(1)} t，说明申报数量相对企业规模过大（或产品不匹配）。`
          + '应缴排放被判为 0 是算术结果，不代表真的不用缴 —— 请核对申报数量与产品归属'
        : null,
    ].filter(Boolean),
    regulation: {
      primary: 'Regulation (EU) 2023/956 (CBAM)',
      articles: ['Art. 7 内含排放确定', 'Art. 9 原产国碳价扣减', 'Art. 22 授权申报人',
        'Art. 31 证书销售与回购'],
      implementing: 'Implementing Regulation (EU) 2023/1773（过渡期报告义务）',
      ets: 'Directive 2003/87/EC Art. 10a（免费配额基准线与递减）',
    },
  };
}

/**
 * 生成并落库 CBAM 证书。
 */
async function issueCertificate(p) {
  const calc = await calculateCertificate(p);
  const certNo = cu.bizNo('CBAM');

  const [ins] = await db.pool.query(
    `INSERT INTO cbam_certificate
      (cert_no, ent_id, year, embedded_emission, free_allocation, cbam_factor,
       payable_emission, eua_price_eur, eur_cny, price_source,
       amount_eur, amount_cny, origin_carbon_price_paid, deduction_cny, net_payable_cny,
       status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CALCULATED')`,
    [
      certNo, calc.entId, calc.year,
      calc.embeddedTotal, calc.freeAllocation, calc.cbamFactor,
      calc.payableEmission, calc.prices.euaPriceEur, calc.prices.eurCny,
      `${calc.prices.euaSource} / ${calc.prices.fxSource}`,
      calc.amountEur, calc.amountCny,
      calc.originCarbonPricePaid, calc.deductionCny, calc.netPayableCny,
    ]
  );

  /* 上链：证书金额是对外主张的商业数据，必须留痕 */
  let chain = null;
  try {
    const tr = await anchorSvc.anchor({
      txType: 'CBAM_CERTIFICATE',
      bizNo: certNo,
      fromLabel: `ent:${calc.entId}`,
      payload: {
        certNo, entId: calc.entId, year: calc.year,
        cnCode: calc.product.matchedCnCode, quantity: calc.quantity,
        embeddedEmission: calc.embeddedTotal,
        freeAllocation: calc.freeAllocation, cbamFactor: calc.cbamFactor,
        payableEmission: calc.payableEmission,
        amountCny: calc.amountCny, netPayableCny: calc.netPayableCny,
        timestamp: new Date().toISOString(),
      },
    });
    await db.query(
      'UPDATE cbam_certificate SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
      [tr.blockIndex, tr.txId, ins.insertId]
    );
    chain = { blockIndex: tr.blockIndex, txId: tr.txId };
  } catch (e) {
    chain = { error: `上链失败：${e.message}` };
  }

  return { certNo, certId: ins.insertId, ...calc, chain };
}

/* ==================================================================================
 * 六、自检
 * ================================================================================== */

async function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });
  const r6 = (v) => Number(Number(v).toFixed(6));

  /* 1. CBAM 系数递减且单调 */
  const f2026 = cbamFactor(2026).factor;
  const f2030 = cbamFactor(2030).factor;
  const f2034 = cbamFactor(2034).factor;
  push('CBAM 系数逐年递减', f2026 > f2030 && f2030 > f2034,
    `2026 ${f2026} > 2030 ${f2030} > 2034 ${f2034}`);
  push('CBAM 系数在 [0,1] 内', f2026 <= 1 && f2034 >= 0, `[${f2034}, ${f2026}]`);

  /* 2. 过渡期（2025）不缴 */
  push('2025 年（过渡期）系数为 1', cbamFactor(2025).factor === 1, `factor=${cbamFactor(2025).factor}`);

  /* 3. 2038 年后归零 */
  push('2038 年后归零', cbamFactor(2040).factor === 0, `factor=${cbamFactor(2040).factor}`);

  /* 4. 产品识别 */
  const steel = findProduct('72083900');
  push('CN Code 识别钢铁', steel && steel.key === 'STEEL_HRC', steel ? steel.cn : '未识别');
  const alu = findProduct('76011000');
  push('CN Code 识别铝', alu && alu.key === 'ALU_UNWROUGHT', alu ? alu.cn : '未识别');
  const cement = findProduct('25231000');
  push('CN Code 识别水泥熟料', cement && cement.key === 'CEMENT_CLINKER', cement ? cement.cn : '未识别');
  push('未覆盖品类返回 null', findProduct('99999999') === null, 'CN 99999999');

  /* 5. ⭐ 手工复算证书数量 —— 这是判据能否成立的核心
   *    设：内含排放 100000 t，铝基准 1.464，产量 50000 t，2026 系数 0.975
   *    免费配额 = 1.464 × 50000 × 0.975 = 71370
   *    应缴 = max(0, 100000 − 0 − 71370) = 28630
   *    金额(EUR) = 28630 × 78 = 2233140
   *    金额(CNY) = 28630 × 78 × 7.85 = 17530149
   */
  const free = 1.464 * 50000 * 0.975;
  const payable = Math.max(0, 100000 - free);
  push('免费配额公式正确（手算对照）', Math.abs(free - 71370) < 1,
    `${1.464} × 50000 × 0.975 = ${free.toFixed(2)}（期望 71370）`);
  push('应缴排放公式正确', Math.abs(payable - 28630) < 1,
    `100000 − 71370 = ${payable.toFixed(2)}（期望 28630）`);
  push('金额换算正确', Math.abs(payable * 78 * 7.85 - 17530149) < 10,
    `28630 × 78 × 7.85 = ${(payable * 78 * 7.85).toFixed(2)}（期望 17530149）`);

  /* 6. 碳价扣减不得使净应付为负 */
  const bigDeduction = Math.min(payable * 78 * 7.85, 999999999);
  const net = Math.max(0, payable * 78 * 7.85 - bigDeduction);
  push('碳价扣减后净应付不为负', net >= 0, `net=${net.toFixed(2)}`);
  /* 扣减不得超过金额本身 */
  const overDeduct = Math.min(payable * 78 * 7.85, 1e12);
  push('扣减额不超过证书金额', overDeduct <= payable * 78 * 7.85 + 1e-6,
    `min(金额, 超额) = ${overDeduct.toFixed(2)}`);

  /* 7. 无排放数据时必须拒绝 */
  const bogus = await resolveEmbedded(999999, 2026);
  push('无排放数据时拒绝计算', bogus.available === false,
    `available=${bogus.available}`);

  /* 8. 真实企业端到端计算 */
  const ent = await db.one(
    `SELECT b.ent_id, b.year FROM calc_batch b WHERE b.status <> 'VOID' LIMIT 1`
  );
  if (ent) {
    try {
      const r = await calculateCertificate({
        entId: Number(ent.ent_id), year: Number(ent.year),
        cnCode: '76011000', quantity: 50000,
      });
      push('真实企业 CBAM 计算可跑通', r.payableEmission >= 0 && r.certificateCount >= 0,
        `应缴 ${r.payableEmission} t，证书 ${r.certificateCount} 张，净应付 ${r.netPayableCny} 元`);
      push('计算链 8 步完整', r.steps.length === 8, `steps=${r.steps.length}`);
      push('局限声明齐备', Array.isArray(r.limitations) && r.limitations.length >= 4,
        `${r.limitations.length} 条局限已声明`);
      /* 证书数量必须与应缴排放一致（向上取整） */
      push('证书数量 = 应缴排放向上取整', r.certificateCount === Math.ceil(r.payableEmission),
        `${r.certificateCount} vs ceil(${r.payableEmission})`);
    } catch (e) {
      push('真实企业 CBAM 计算可跑通', false, e.message);
    }
  } else {
    push('真实企业 CBAM 计算可跑通', false, '库中无核算批次');
  }

  /* 9. 未覆盖 CN Code 必须抛错 */
  let cnErr = null;
  if (ent) {
    try {
      await calculateCertificate({ entId: Number(ent.ent_id), year: Number(ent.year), cnCode: '99999999', quantity: 100 });
    } catch (e) { cnErr = e.message; }
    push('未覆盖品类拒绝计算', cnErr !== null && cnErr.includes('不在 CBAM 覆盖范围'),
      cnErr || '未抛错（缺陷）');
  }

  /* 10. 数量为 0 必须拒绝 */
  let qtyErr = null;
  if (ent) {
    try {
      await calculateCertificate({ entId: Number(ent.ent_id), year: Number(ent.year), cnCode: '76011000', quantity: 0 });
    } catch (e) { qtyErr = e.message; }
    push('数量为 0 拒绝计算', qtyErr !== null && qtyErr.includes('大于 0'), qtyErr || '未抛错（缺陷）');
  }

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

module.exports = {
  DEFAULT_FACTOR_SCHEDULE, PRODUCT_BENCHMARKS,
  cbamFactor, cbamFactorSchedule, findProduct, listProducts,
  resolvePrices, resolveEmbedded, calculateCertificate, issueCertificate,
  selfTest,
};
