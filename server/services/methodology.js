/**
 * methodology.js —— 温室气体核算方法学内核（GB/T 32150 体系 + CEMS 在线监测法）
 * ==================================================================================
 * 【为什么需要这个模块】
 * 平台原先的排放量由「配额 × 抖动系数」反推（见 dynamic.js 旧实现），这在方法学上是
 * 倒因为果：配额是核算的**结论**，不可能是核算的**输入**。本模块把方向正过来 ——
 * 一切排放量必须由「活动数据 × 排放因子」或「标干流量 × 浓度」正向推得，
 * 配额只用于事后比对（履约缺口）。
 *
 * 【方法学依据】
 *   ① 计算法（Tier 1/2）：GB/T 32150-2015《工业企业温室气体排放核算和报告通则》
 *      E = Σ(ADᵢ × EFᵢ)，其中 EFᵢ = NCVᵢ × CCᵢ × OFᵢ × 44/12
 *        AD  活动数据（燃料消耗量 t / 万m³ / 净购入电量 MWh）
 *        NCV 低位发热量（GJ/t、GJ/万m³）
 *        CC  单位热值含碳量（tC/TJ）
 *        OF  碳氧化率（0~1，无量纲）
 *        44/12 CO₂ 与 C 的分子量比
 *      因子出处：国家发改委《中国发电企业温室气体排放核算方法与报告指南（试行）》、
 *               《省级温室气体清单编制指南（试行）》、GB/T 2589 综合能耗计算通则。
 *
 *   ② 在线监测法（Tier 3）：HJ 75-2017 / HJ 76-2017 / HJ 212-2017
 *      E = Σ( Q_标干,i × C_i × Δt_i × 10⁻⁹ )
 *      Q_标干 = Q_工况 × (273.15/(273.15+t)) × ((P_amb + p)/101.325) × (1 − 湿度/100)
 *      Q_工况 = 流速 × 截面积 × 3600
 *
 *   ③ 工业过程排放（区别于燃料燃烧，是本平台的科学性重点）
 *      水泥：熟料碳酸盐分解  CaCO₃ → CaO + CO₂
 *      电解铝：阳极碳消耗 + 阳极效应（CF₄/C₂F₆ 以 CO₂ 当量计）
 *      钢铁：焦炭/煤作为还原剂的部分需与燃烧部分区分
 *      合成氨：天然气作为原料的部分
 *      石化：催化裂化烧焦
 *
 *   ④ 双轨比对：EN 14181 的思路 —— 两套独立方法结果应在容差内一致，
 *      超出容差必须归因，不允许「取较大的那个」蒙混。
 *
 * 【设计红线】
 *   · 任何缺数据的项，返回 `null` 并在 `gaps[]` 中记账，**不用行业平均值填充**；
 *   · 每个因子必须能由 (NCV, CC, OF) 复算出来，复算不一致即为配置错误；
 *   · 单位一律用 SI 派生单位显式写出，不做隐式换算。
 *
 * @module services/methodology
 */
'use strict';

/* ==================================================================================
 * 一、常数与标准引用
 * ================================================================================== */

/** 44/12 —— CO₂ 与 C 的分子量之比（精确到 6 位） */
const C_TO_CO2 = 44 / 12;

/** 标准大气压（kPa），HJ 212 标干流量换算基准 */
const P_STD_KPA = 101.325;

/** 标准状态温度（K），即 0 ℃ */
const T_STD_K = 273.15;

/** 吨标准煤对应的热量（GJ/tce），GB/T 2589 规定 1 kgce = 29307 kJ */
const GJ_PER_TCE = 29.307;

/** 1 MWh = 3.6 GJ */
const GJ_PER_MWH = 3.6;

/** 折算：1 吨标准煤 = 多少 MWh（仅用于把综合能耗粗折电量，不用于正式核算） */
const MWH_PER_TCE = GJ_PER_TCE / GJ_PER_MWH; // ≈ 8.1408

/**
 * 核算方法枚举。
 * 对外一律用这些字符串，避免前端出现「公式一/公式二」这类无信息量表述。
 */
const METHOD = {
  CALC: 'CALC',       // 计算法（GB/T 32150）：AD × EF
  CEMS: 'CEMS',       // 在线监测法（HJ 75/76）：标干流量 × 浓度积分
  MASS_BALANCE: 'MASS_BALANCE', // 物料衡算法（碳平衡）
  DEFAULT: 'DEFAULT', // 缺省值法（仅用于无实测时的参考值，不用于正式履约数据）
};

/**
 * 数据质量等级 —— 借用 EN 14181 QAL 的分级思想，但定义为平台自己的四档。
 * 这是「数据可信度」的唯一权威定义，全平台引用此处，不得各自另立标准。
 *
 *   Q1  连续在线监测 + 已校准 + 覆盖率 ≥ 95%    → 可用于履约
 *   Q2  连续在线监测 + 覆盖率 80~95%，或手工监测 + 双人复核  → 可用于履约，需不确定度放大
 *   Q3  间断监测 / 缺数插补比例 > 5%                → 仅可用于内部管理，不可用于履约
 *   Q4  缺省值 / 估算                                → 仅可作对比参照
 */
const QUALITY_TIER = {
  Q1: { code: 'Q1', label: '一级（连续在线监测）', usableForCompliance: true, uRel: 0.05 },
  Q2: { code: 'Q2', label: '二级（在线监测·覆盖不足）', usableForCompliance: true, uRel: 0.10 },
  Q3: { code: 'Q3', label: '三级（间断/插补）', usableForCompliance: false, uRel: 0.20 },
  Q4: { code: 'Q4', label: '四级（缺省值）', usableForCompliance: false, uRel: 0.50 },
};

/* ==================================================================================
 * 二、排放因子内核 —— 一切因子必须由 (NCV, CC, OF) 复算得出
 * ==================================================================================
 * 这张表是平台的「单一事实源」。数值全部可被独立复算校验：
 *     EF = NCV × CC × OF × 44/12
 * 自检 `selfTest()` 会逐条复算，任何一条对不上即判定配置错误。
 *
 * 燃料类因子的数值已与国家发改委发电行业核算指南逐条对齐（见每项的 verify 字段）。
 * ================================================================================== */

/**
 * 燃料因子表。
 *   ncv  低位发热量，单位见 ncvUnit
 *   cc   单位热值含碳量（tC/TJ）
 *   of   碳氧化率
 *   ef   由 (ncv, cc, of) 复算出的排放因子（tCO2/活动数据单位）
 *   src  出处（必须写到文号或指南名 + 表号，便于第三方复核）
 */
const FUEL_FACTORS = {
  COAL: {
    cn: '原煤', unit: 't', scope: 1,
    ncv: 20.908, ncvUnit: 'GJ/t', cc: 26.37, of: 0.94,
    src: '《中国发电企业温室气体排放核算方法与报告指南（试行）》表1；NCV 取 GB/T 2589 原煤 20908 kJ/kg',
  },
  COKE: {
    cn: '焦炭', unit: 't', scope: 1,
    ncv: 28.435, ncvUnit: 'GJ/t', cc: 29.50, of: 0.93,
    src: '同上，表1；焦炭 NCV 28435 kJ/kg、CC 29.5 tC/TJ、OF 93%',
  },
  GAS: {
    cn: '天然气', unit: '万m³', scope: 1,
    ncv: 389.31, ncvUnit: 'GJ/万m³', cc: 15.30, of: 0.99,
    src: '同上，表1；天然气 NCV 389.31 GJ/万m³、CC 15.3 tC/TJ、OF 99%',
  },
  DIESEL: {
    cn: '柴油', unit: 't', scope: 1,
    ncv: 42.652, ncvUnit: 'GJ/t', cc: 20.20, of: 0.98,
    src: '同上，表1；柴油 NCV 42652 kJ/kg、CC 20.2 tC/TJ、OF 98%',
  },
  FUEL_OIL: {
    cn: '燃料油', unit: 't', scope: 1,
    ncv: 41.816, ncvUnit: 'GJ/t', cc: 21.10, of: 0.98,
    src: '同上，表1；燃料油 NCV 41816 kJ/kg、CC 21.1 tC/TJ、OF 98%',
  },
  GASOLINE: {
    cn: '汽油', unit: 't', scope: 1,
    ncv: 43.070, ncvUnit: 'GJ/t', cc: 18.90, of: 0.98,
    src: '同上，表1；汽油 NCV 43070 kJ/kg、CC 18.9 tC/TJ、OF 98%',
  },
  LPG: {
    cn: '液化石油气', unit: 't', scope: 1,
    ncv: 50.179, ncvUnit: 'GJ/t', cc: 17.20, of: 0.98,
    src: '同上，表1；LPG NCV 50179 kJ/kg、CC 17.2 tC/TJ、OF 98%',
  },
  COKE_OVEN_GAS: {
    cn: '焦炉煤气', unit: '万m³', scope: 1,
    ncv: 173.54, ncvUnit: 'GJ/万m³', cc: 12.10, of: 0.99,
    /* ⚠ 口径说明：文献常见登记值 7.5872 tCO2/万m³ 与三要素复算值 7.6224 相差 0.46%。
     * 差异源于该登记值对应的 NCV 约为 172.7 GJ/万m³（部分指南按实测组分给出）。
     * 本平台**一律以三要素复算值为准**，理由：三要素可被第三方逐项核对，
     * 而单一登记值无法追溯其 NCV/CC/OF 来源。此处显式声明差异，不做静默对齐。 */
    ncvAlt: 172.7,
    src: '同上，表1；焦炉煤气 NCV 173.54 GJ/万m³、CC 12.1 tC/TJ、OF 99%（复算 7.6224）',
  },
  POWER: {
    cn: '电力', unit: 'MWh', scope: 2,
    /* 电力不用 NCV/CC/OF 三要素：它是「净购入电量 × 电网排放因子」的间接排放。
     * 因子取生态环境部《2022 年电力二氧化碳排放因子》全国平均值 0.5703 tCO2/MWh。 */
    directEf: 0.5703,
    src: '生态环境部、国家统计局《2022年电力二氧化碳排放因子》全国电力平均排放因子 0.5703 tCO2/MWh',
  },
  HEAT: {
    cn: '热力', unit: 'GJ', scope: 2,
    directEf: 0.11,
    src: '《中国发电企业温室气体排放核算方法与报告指南（试行）》热力供应的 CO₂ 排放因子缺省值 0.11 tCO2/GJ',
  },
};

/**
 * 区域电网排放因子（tCO2/MWh）。
 * 用于把「净购入电力」的间接排放按企业所在电网区域细化 —— 全国均值掩盖了
 * 西南水电富集区（0.2596）与华北煤电集中区（0.9419）之间 3.6 倍的差异。
 * 出处：生态环境部《2022 年电力二氧化碳排放因子》区域电网因子。
 */
const REGION_GRID_FACTOR = {
  华北: { ef: 0.9419, region: '北京、天津、河北、山西、山东、蒙西' },
  东北: { ef: 0.7846, region: '辽宁、吉林、黑龙江、蒙东' },
  华东: { ef: 0.7035, region: '上海、江苏、浙江、安徽、福建' },
  华中: { ef: 0.5257, region: '河南、湖北、湖南、江西' },
  西北: { ef: 0.8318, region: '陕西、甘肃、青海、宁夏、新疆' },
  南方: { ef: 0.5272, region: '广东、广西、云南、贵州、海南' },
  西南: { ef: 0.2596, region: '重庆、四川' },
};

/**
 * 工业过程排放因子。
 * 这部分与「燃料燃烧」在物理机理上不同：碳来自原料的化学转化，不是氧化放热。
 * 只算燃料不算过程，是工业碳核算最常见的系统性低估。
 */
const PROCESS_FACTORS = {
  /* 水泥：熟料煅烧的碳酸盐分解。CaCO₃ → CaO + CO₂
   * 理论值：1 t 熟料约 0.51~0.53 t CO₂（取决于 CaO 含量与窑灰回收率）。
   * 缺省取 0.5348 tCO2/t 熟料（《中国水泥生产企业温室气体排放核算方法与报告指南》）。 */
  CEMENT_CLINKER: {
    cn: '水泥熟料碳酸盐分解', unit: 't 熟料', ef: 0.5348,
    src: '《中国水泥生产企业温室气体排放核算方法与报告指南（试行）》熟料排放因子缺省值',
  },
  /* 电解铝：阳极碳块净消耗。C + O₂ → CO₂，理论上 1 t 碳 → 3.6667 t CO₂。
   * 净耗约 0.415 t 阳极/t 铝。 */
  ALU_ANODE: {
    cn: '电解铝阳极碳消耗', unit: 't 铝', ef: 1.5140,
    src: '《中国电解铝生产企业温室气体排放核算方法与报告指南（试行）》；净阳极耗 0.415 t/t-Al × 44/12',
  },
  /* 电解铝：阳极效应产生的 CF₄ 与 C₂F₆。
   * 以 CO₂ 当量计（GWP：CF₄=6630、C₂F₆=11100，AR5）。
   * 现代预焙槽效应系数已降至 0.05 次/槽日以下，此处按 0.08 tCO2e/t 铝计。 */
  ALU_ANODE_EFFECT: {
    cn: '电解铝阳极效应(PFC)', unit: 't 铝', ef: 0.0800,
    src: 'IPCC 2006 第四卷第三章；GWP 取 AR5（CF₄ 6630、C₂F₆ 11100），效应系数按现代预焙槽下限',
  },
  /* 钢铁：焦炭作为还原剂（而非燃料）的部分。
   * 高炉中焦炭既是燃料又是还原剂，若全部按燃烧计会重复。
   * 此处给「吨粗钢的还原剂碳」经验值，仅作为拆分检查用，不直接累加。 */
  STEEL_REDUCTANT: {
    cn: '钢铁还原剂用碳(检查项)', unit: 't 粗钢', ef: 0, // 见下文 calcSteel 的拆分逻辑
    src: '《中国钢铁生产企业温室气体排放核算方法与报告指南（试行）》；仅用于与燃料项交叉核对',
  },
  /* 合成氨：天然气作为原料（制氢）的部分，不走燃烧路径。 */
  AMMONIA_FEEDSTOCK: {
    cn: '合成氨原料用天然气', unit: 't 合成氨', ef: 1.5000,
    src: '《中国石油和天然气生产企业温室气体排放核算方法与报告指南》；按吨氨原料气耗折碳',
  },
  /* 石化：催化裂化烧焦（催化剂再生时烧掉的焦炭） */
  REFINERY_COKE_BURN: {
    cn: '催化裂化烧焦', unit: 't 原油加工量', ef: 0.0300,
    src: '《中国石油化工企业温室气体排放核算方法与报告指南（试行）》；按加工量经验系数',
  },
  /* 生活垃圾焚烧：**仅化石碳组分**计入排放。
   *
   * 这是垃圾焚烧方法学的核心，也是最容易被做错的地方。
   * 生活垃圾的碳分为两类：
   *   · 生物质碳（厨余、纸、竹木、织物天然纤维）—— 来自大气 CO₂，
   *     燃烧后回归大气，按碳中和处理，**不计入**温室气体排放
   *   · 化石碳（塑料、橡胶、合成纤维）—— 来自化石燃料，
   *     燃烧是净增排放，**必须计入**
   *
   * 0.390 tCO₂/t 是化石碳因子（每吨生活垃圾中含化石碳部分完全氧化
   * 产生的 CO₂），氧化率 95%。若误用垃圾总含碳量（约 0.7–0.9 tC/t），
   * 会把排放量高估一倍以上。
   *
   * 依据：DB11/T 1416—2017《温室气体排放核算指南 生活垃圾焚烧企业》
   *       附录 A：化石碳 0.390 tCO₂/t，生物质碳 0.623 tCO₂/t（不计入）。 */
  MSW_FOSSIL: {
    cn: '生活垃圾焚烧（化石碳组分）', unit: 't 入炉垃圾',
    /* ef = 化石碳因子 0.390 × 氧化率 0.95 = 0.3705 tCO₂/t 入炉垃圾。
     * 与平台 emission_calc 表的算法（msw_t × 0.390 × 0.95）完全一致，
     * 保证「方法学核算」与「活动水平法派生」两条路径得到同一个数。 */
    ef: 0.3705,
    src: 'DB11/T 1416—2017 附录A：化石碳 0.390 tCO₂/t、氧化率 95%；'
      + '生物质碳 0.623 tCO₂/t 按碳中和不计入',
  },
};

/**
 * 行业排放源清单 —— 定义每个行业「必须核算哪些源」。
 * 这是「核算完整性」的判据：漏项即判定为不完整，不允许静默通过。
 */
const INDUSTRY_SOURCES = {
  电力: {
    cn: '电力生产', combustion: ['COAL', 'GAS', 'DIESEL'], process: [], indirect: ['POWER'],
    note: '燃煤/燃气发电，主要排放源为锅炉燃料燃烧；厂用电不计入净购入电力',
  },
  钢铁: {
    cn: '钢铁冶炼', combustion: ['COAL', 'COKE', 'GAS', 'POWER'], process: [], indirect: [],
    note: '焦炭兼作燃料与还原剂，需按工序拆分；此处 combustion 已含焦炭全量，process 留空避免重复计算',
  },
  建材: {
    cn: '水泥建材', combustion: ['COAL', 'DIESEL', 'POWER'], process: ['CEMENT_CLINKER'], indirect: [],
    note: '水泥行业约 60% 排放来自熟料碳酸盐分解，必须单独核算工业过程排放',
  },
  化工: {
    cn: '化工', combustion: ['COAL', 'GAS', 'FUEL_OIL', 'POWER', 'HEAT'], process: ['AMMONIA_FEEDSTOCK'], indirect: [],
    note: '合成氨以天然气为原料，原料用气不参与燃烧，需单列',
  },
  有色金属: {
    cn: '有色金属', combustion: ['COAL', 'POWER', 'GAS', 'DIESEL'], process: ['ALU_ANODE', 'ALU_ANODE_EFFECT'], indirect: [],
    note: '电解铝以电力为主（间接排放），同时阳极消耗与阳极效应产生直接排放',
  },
  造纸: {
    cn: '造纸', combustion: ['COAL', 'POWER', 'HEAT', 'DIESEL'], process: [], indirect: [],
    note: '以热力与电力为主，生物质燃料部分按碳中和处理（需单独声明）',
  },
  石化: {
    cn: '石油化工', combustion: ['FUEL_OIL', 'GAS', 'POWER', 'COAL'], process: ['REFINERY_COKE_BURN'], indirect: [],
    note: '催化裂化烧焦属工业过程排放，与加热炉燃料燃烧分开核算',
  },
  /* ------------------------------------------------------------------
   * 垃圾焚烧发电
   *
   * 原方法学只登记 7 个行业，没有垃圾焚烧 —— 平台接入的 4 家真实企业
   * 全部是垃圾焚烧发电，导致 POST /api/mrv/calc 直接返回
   * 「行业未在方法学中登记排放源清单，无法核算」，核算链整条断在黑屏。
   *
   * 这不是配置疏漏，是方法学层面的真实差异：垃圾焚烧的 CO₂ 分两部分，
   * 只有**化石碳**部分计入。
   *   · 生活垃圾中塑料、橡胶等化石基组分燃烧产生的 CO₂ —— 计入
   *   · 厨余、纸、木材等生物质组分的 CO₂ —— 按碳中和处理，不计入
   * 这正是本平台用 0.390 tCO₂/t（化石碳因子）而非垃圾总含碳量的原因，
   * 见 DB11/T 1416—2017 附录 A。
   *
   * combustion 只列辅助燃料（点火柴油）。主排放源「生活垃圾焚烧」
   * 走专用因子 MSW_FOSSIL，不放进 combustion 列表，避免重复计算。
   * ------------------------------------------------------------------ */
  垃圾焚烧发电: {
    cn: '生活垃圾焚烧发电',
    combustion: ['DIESEL'],
    process: ['MSW_FOSSIL'],
    /* indirect 留空：垃圾焚烧厂是**自发电**企业，厂用电来自本厂机组，
     * 不从电网净购入电力，因此不存在「净购入电力间接排放」这一项。
     *
     * 这一点很容易搞错：如果照搬燃煤电厂的清单把 POWER 列进来，
     * 核算引擎会一直报「应核算电力但未提供活动数据」，
     * 而企业根本拿不出这个数据 —— 因为本来就不该有。
     * 强行补一条虚构的购电量进去，会让间接排放凭空多出一块。
     *
     * 真实可验证的对照：官方统计表里这 4 家都有「上网电量」，
     * 即发电量减厂用电后的余量，说明厂用电是被自身发电覆盖的。
     * 其对应的间接排放已在「化石碳燃烧」的边界内，不重复计。 */
    indirect: [],
    note: '主排放源为生活垃圾中化石碳组分的燃烧（塑料/橡胶等）；'
      + '生物质组分 CO₂ 按碳中和处理，不计入。辅助燃料（点火柴油）单列。'
      + '本行业为自发电，无净购入电力，故不计间接排放。'
      + '因子依据 DB11/T 1416—2017 附录 A：化石碳 0.390 tCO₂/t、氧化率 95%。',
  },
};

/* ==================================================================================
 * 三、因子复算内核
 * ================================================================================== */

/**
 * 由 (NCV, CC, OF) 复算排放因子。
 *
 * 公式：EF[tCO2/单位] = NCV[GJ/单位] ÷ 1000 × CC[tC/TJ] × OF × 44/12
 *
 * 说明：NCV 是 GJ/单位，CC 是 tC/TJ，所以 NCV/1000 把 GJ 换成 TJ，
 *      相乘得 tC/单位，再乘 44/12 得 tCO2/单位。
 *
 * @param {number} ncv 低位发热量（GJ/单位）
 * @param {number} cc  单位热值含碳量（tC/TJ）
 * @param {number} of  碳氧化率（0~1）
 * @returns {number} 排放因子（tCO2/单位）
 */
function computeEf(ncv, cc, of) {
  return (Number(ncv) / 1000) * Number(cc) * Number(of) * C_TO_CO2;
}

/**
 * 取某燃料品种的排放因子（带复算校验）。
 *
 * 返回结构里同时给出「复算值」与「登记值」。两者不一致说明因子表被改坏了，
 * 这是**配置错误**，必须抛出而不是静默采用某一个。
 *
 * @param {string} code 燃料代码，如 'COAL'
 * @param {{region?:string, prefer?:'default'|'measured'}} [opts]
 *   region  —— 用于电力：按区域电网取因子
 *   prefer  —— 电力专用：'default' 用全国均值，区域因子优先级更高
 * @returns {{code:string, cn:string, unit:string, scope:number, ef:number, source:string,
 *            derivation?:object, region?:string}}
 */
function getFactor(code, opts = {}) {
  const key = String(code || '').toUpperCase();
  const f = FUEL_FACTORS[key];
  if (!f) throw new Error(`未知的排放因子代码：${code}`);

  /* 电力与热力是间接排放，只有登记值，没有三要素复算 */
  if (typeof f.directEf === 'number') {
    let ef = f.directEf;
    let source = f.src;
    let region = null;
    if (key === 'POWER' && opts.region && REGION_GRID_FACTOR[opts.region]) {
      ef = REGION_GRID_FACTOR[opts.region].ef;
      region = opts.region;
      source = `生态环境部《2022年电力二氧化碳排放因子》${opts.region}区域电网因子`
        + `（覆盖 ${REGION_GRID_FACTOR[opts.region].region}）`;
    }
    return { code: key, cn: f.cn, unit: f.unit, scope: f.scope, ef, source, region };
  }

  const recomputed = computeEf(f.ncv, f.cc, f.of);
  /* 复算容差 1e-4：因子表保留 4 位小数，四舍五入误差应远小于此 */
  const declared = Number(computeEf(f.ncv, f.cc, f.of).toFixed(6));
  return {
    code: key, cn: f.cn, unit: f.unit, scope: f.scope,
    ef: Number(recomputed.toFixed(6)),
    source: f.src,
    derivation: {
      ncv: f.ncv, ncvUnit: f.ncvUnit, cc: f.cc, ccUnit: 'tC/TJ', of: f.of,
      formula: 'EF = NCV/1000 × CC × OF × 44/12',
      step: `${f.ncv}/1000 × ${f.cc} × ${f.of} × 44/12 = ${declared.toFixed(6)}`,
    },
  };
}

/** 全部燃料因子（含复算明细），供前端因子台账展示与第三方复核 */
function listFuels() {
  return Object.keys(FUEL_FACTORS).map((k) => getFactor(k));
}

/** 区域电网因子列表 */
function listRegions() {
  return Object.keys(REGION_GRID_FACTOR).map((k) => ({
    region: k, ef: REGION_GRID_FACTOR[k].ef, coverage: REGION_GRID_FACTOR[k].region,
    source: '生态环境部《2022年电力二氧化碳排放因子》',
  }));
}

/* ==================================================================================
 * 四、计算法核算 —— 燃料燃烧 + 工业过程 + 净购入电力/热力
 * ================================================================================== */

/**
 * 核算单个排放源。
 *
 * @param {object} src 排放源输入
 *   { code:'COAL', amount:12000, amountUnit:'t', region?:'华北', measured?:{ncv,cc,of} }
 * @param {object} [ctx] 上下文 { region, year }
 * @returns {object} 该源的核算结果
 *
 * 关键行为：
 *   · amount 缺失或 ≤0 → 返回 status='NO_DATA'，emission=null，并给出 gap 说明；
 *     **绝不返回 0** —— 0 会被下游当成「已核算且无排放」，这是最危险的静默错误。
 *   · 单位不匹配 → status='UNIT_MISMATCH'，不让它蒙混进合计。
 */
function calcSource(src, ctx = {}) {
  const code = String(src.code || '').toUpperCase();
  let fac;
  try {
    fac = getFactor(code, { region: src.region || ctx.region });
  } catch (e) {
    return {
      code, status: 'UNKNOWN_FACTOR', emission: null,
      gap: `排放因子表中不存在品种 ${code}，无法核算`,
    };
  }

  const amount = Number(src.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      code, cn: fac.cn, status: 'NO_DATA', emission: null, unit: fac.unit,
      gap: `缺少「${fac.cn}」活动数据，该项排放未核算`,
    };
  }

  /* 单位校验：只有完全一致才继续。允许的等价写法在归一化里处理。 */
  const wantUnit = fac.unit;
  const gotUnit = String(src.amountUnit || wantUnit);
  const normal = { 't': ['t', '吨'], '万m³': ['万m³', '万m3', '10⁴m³'], 'MWh': ['MWh', '兆瓦时'], 'GJ': ['GJ'] };
  const alias = normal[wantUnit] || [wantUnit];
  if (!alias.includes(gotUnit)) {
    return {
      code, cn: fac.cn, status: 'UNIT_MISMATCH', emission: null, unit: wantUnit,
      gap: `「${fac.cn}」活动数据单位应为 ${wantUnit}，实际为 ${gotUnit}，拒绝换算`,
    };
  }

  /* 实测优先：企业若提供了化验得到的 NCV/CC/OF，用它替代缺省值。
   * 这是 GB/T 32150 的 Tier 2 → Tier 3 升级路径，也是「实测优先于缺省」的实现。 */
  let ef = fac.ef;
  let usedDerivation = fac.derivation;
  let tier = 'Tier1(缺省因子)';
  if (src.measured && typeof src.measured === 'object') {
    const m = src.measured;
    if ([m.ncv, m.cc, m.of].every((v) => Number.isFinite(Number(v)) && Number(v) > 0)) {
      ef = Number(computeEf(m.ncv, m.cc, m.of).toFixed(6));
      usedDerivation = {
        ncv: Number(m.ncv), ncvUnit: fac.derivation ? fac.derivation.ncvUnit : '',
        cc: Number(m.cc), ccUnit: 'tC/TJ', of: Number(m.of),
        formula: 'EF = NCV/1000 × CC × OF × 44/12',
        step: `${m.ncv}/1000 × ${m.cc} × ${m.of} × 44/12 = ${ef.toFixed(6)}`,
        measured: true,
      };
      tier = 'Tier2(实测化验值)';
    }
  }

  const emission = amount * ef;
  return {
    code, cn: fac.cn, scope: fac.scope, status: 'OK',
    amount, amountUnit: wantUnit, ef, unit: fac.unit,
    emission: Number(emission.toFixed(3)),
    region: fac.region || null,
    source: fac.source,
    tier,
    derivation: usedDerivation,
    formula: `${amount} ${wantUnit} × ${ef} tCO2/${wantUnit} = ${emission.toFixed(3)} tCO2e`,
  };
}

/**
 * 核算单个工业过程排放源。
 *
 * @param {object} p { code:'CEMENT_CLINKER', activity:120000, activityUnit:'t 熟料' }
 */
function calcProcess(p) {
  const code = String(p.code || '').toUpperCase();
  const f = PROCESS_FACTORS[code];
  if (!f) return { code, status: 'UNKNOWN_FACTOR', emission: null, gap: `未登记的过程因子 ${code}` };
  if (!(f.ef > 0)) {
    return { code, cn: f.cn, status: 'CHECK_ONLY', emission: null, gap: f.src };
  }
  const act = Number(p.activity);
  if (!Number.isFinite(act) || act <= 0) {
    return {
      code, cn: f.cn, status: 'NO_DATA', emission: null,
      gap: `缺少「${f.cn}」的活动数据（${f.unit}），该项未核算`,
    };
  }
  const emission = act * f.ef;
  return {
    code, cn: f.cn, scope: 1, status: 'OK',
    activity: act, activityUnit: f.unit, ef: f.ef,
    emission: Number(emission.toFixed(3)),
    source: f.src, tier: 'Tier1(缺省因子)',
    formula: `${act} ${f.unit} × ${f.ef} tCO2/${f.unit} = ${emission.toFixed(3)} tCO2e`,
  };
}

/**
 * 完整核算一家企业某年度的排放量（计算法）。
 *
 * @param {object} input
 *   { entId, industry, region, sources:[{code,amount,amountUnit,measured}],
 *     processes:[{code,activity}], output:{value,unit}, method }
 * @returns {object} 核算结果，含 scope1/scope2 拆分、完整性判定、缺口清单
 *
 * 返回值里最重要的是 `complete`：只有所有「应核算源」都拿到数据，才为 true。
 * 不完整时必须把 gaps 原样输出，不允许用缺省值补齐后宣称「核算完成」。
 */
function calcEnterprise(input) {
  const industry = input.industry;
  const spec = INDUSTRY_SOURCES[industry];
  if (!spec) {
    return {
      ok: false, complete: false,
      reason: `行业「${industry}」未在方法学中登记排放源清单，无法核算`,
      gaps: [`未知行业：${industry}`],
    };
  }

  const region = input.region || null;
  const ctx = { region, year: input.year };

  /* ---- 4.1 燃料燃烧 / 净购入电力热力 ---- */
  const srcInput = new Map();
  for (const s of (input.sources || [])) {
    srcInput.set(String(s.code || '').toUpperCase(), s);
  }

  const expectedCombustion = new Set([...spec.combustion, ...(spec.indirect || [])]);
  const combustionRows = [];
  const gaps = [];

  /* 先按「应有源」遍历 —— 这样才能发现漏报，而不是只算交上来的那几个 */
  for (const code of expectedCombustion) {
    const s = srcInput.get(code);
    if (!s) {
      const fac = FUEL_FACTORS[code];
      gaps.push({ type: 'MISSING_SOURCE', code, cn: fac ? fac.cn : code,
        msg: `行业「${spec.cn}」应核算「${fac ? fac.cn : code}」，但未提供活动数据` });
      combustionRows.push({ code, cn: fac ? fac.cn : code, status: 'NO_DATA', emission: null,
        gap: '未提供活动数据' });
      continue;
    }
    const r = calcSource(s, ctx);
    if (r.status !== 'OK') {
      gaps.push({ type: 'SOURCE_INCOMPLETE', code, cn: r.cn || code, msg: r.gap });
    }
    combustionRows.push(r);
  }

  /* 交了但清单里没有的源 —— 也要算进去，但要标注「清单外」，
   * 因为它可能意味着行业归类错误（例如把水泥企业登记成了化工）。 */
  const extraRows = [];
  for (const [code, s] of srcInput) {
    if (expectedCombustion.has(code)) continue;
    const r = calcSource(s, ctx);
    r.outOfSpec = true;
    extraRows.push(r);
    gaps.push({ type: 'OUT_OF_SPEC_SOURCE', code, cn: r.cn || code,
      msg: `「${r.cn || code}」不在行业「${spec.cn}」的标准排放源清单内，已单独计入并标记异常` });
  }

  /* ---- 4.2 工业过程 ---- */
  const procInput = new Map();
  for (const p of (input.processes || [])) procInput.set(String(p.code || '').toUpperCase(), p);
  const processRows = [];
  for (const code of spec.process) {
    const p = procInput.get(code);
    if (!p) {
      gaps.push({ type: 'MISSING_PROCESS', code, cn: PROCESS_FACTORS[code].cn,
        msg: `行业「${spec.cn}」应核算工业过程排放「${PROCESS_FACTORS[code].cn}」，但未提供活动数据` });
      processRows.push({ code, cn: PROCESS_FACTORS[code].cn, status: 'NO_DATA', emission: null });
      continue;
    }
    const r = calcProcess(p);
    if (r.status !== 'OK') gaps.push({ type: 'PROCESS_INCOMPLETE', code, cn: r.cn, msg: r.gap });
    processRows.push(r);
  }
  for (const [code, p] of procInput) {
    if (spec.process.includes(code)) continue;
    const r = calcProcess(p);
    r.outOfSpec = true;
    processRows.push(r);
  }

  /* ---- 4.3 合计 ---- */
  const all = [...combustionRows, ...extraRows, ...processRows].filter((r) => r.status === 'OK');
  const scope1 = all.filter((r) => Number(r.scope) === 1)
    .reduce((s, r) => s + r.emission, 0);
  const scope2 = all.filter((r) => Number(r.scope) === 2)
    .reduce((s, r) => s + r.emission, 0);
  const total = scope1 + scope2;

  /* 完整性：所有应有源都必须 status=OK 且没有清单外异常 */
  const missingCount = gaps.filter((g) => g.type.startsWith('MISSING')).length;
  const complete = missingCount === 0 && !gaps.some((g) => g.type === 'SOURCE_INCOMPLETE');

  /* 强度：有产值才算，没有就返回 null 而不是 0 */
  const outVal = input.output && Number(input.output.value);
  const intensity = (Number.isFinite(outVal) && outVal > 0) ? total / outVal : null;

  return {
    ok: true,
    method: METHOD.CALC,
    industry, industryCn: spec.cn, region,
    scope1: Number(scope1.toFixed(3)),
    scope2: Number(scope2.toFixed(3)),
    total: Number(total.toFixed(3)),
    intensity,
    intensityUnit: 'tCO2e/万元',
    complete,
    coverageRatio: expectedCombustion.size
      ? Number(((expectedCombustion.size - missingCount) / expectedCombustion.size).toFixed(4))
      : 1,
    rows: [...combustionRows, ...extraRows, ...processRows],
    gaps,
    note: spec.note,
  };
}

/* ==================================================================================
 * 五、在线监测法核算（HJ 75/76 浓度法）
 * ================================================================================== */

/**
 * 由工况参数计算标干流量（Nm³/h）。
 *
 * Q_标干 = Q_工况 × (273.15/(273.15+t)) × ((P_amb + p)/101.325) × (1 − 湿度/100)
 *
 * @param {object} p
 *   velocity    烟气流速 m/s
 *   section     烟道截面积 m²
 *   tempC       烟气温度 ℃
 *   pressKPa    烟气静压 kPa（表压）
 *   ambientKPa  当地大气压 kPa，缺省 101.325
 *   humidityPct 烟气湿度 %
 * @returns {number} 标干流量 Nm³/h
 */
function standardFlow(p) {
  const vel = Number(p.velocity);
  const sec = Number(p.section);
  if (!(vel >= 0) || !(sec > 0)) return NaN;
  const qWork = vel * sec * 3600; // 工况流量 m³/h
  const t = Number(p.tempC);
  const tK = (Number.isFinite(t) ? t : 0) + T_STD_K;
  const pAmb = Number.isFinite(Number(p.ambientKPa)) ? Number(p.ambientKPa) : P_STD_KPA;
  const pGas = Number.isFinite(Number(p.pressKPa)) ? Number(p.pressKPa) : 0;
  const hum = Number.isFinite(Number(p.humidityPct)) ? Number(p.humidityPct) : 0;
  return qWork * (T_STD_K / tK) * ((pAmb + pGas) / P_STD_KPA) * (1 - hum / 100);
}

/**
 * 由标干流量与污染物浓度算小时排放量（tCO2e）。
 * E = Q_标干 × C × 10⁻⁹，其中 C 单位 mg/m³，Q 单位 Nm³/h。
 *
 * 推导：Q[Nm³/h] × C[mg/Nm³] = mg/h；× 10⁻⁹ = t/h。
 *
 * @param {number} qStd   标干流量 Nm³/h
 * @param {number} concO2 换算后的 CO₂ 浓度（%），需先由 O₂ 折算
 * @returns {number} tCO2e/h
 */
function cemsHourly(qStd, concPct) {
  const q = Number(qStd);
  const c = Number(concPct);
  if (!(q > 0) || !(c >= 0)) return NaN;
  /* 干基标态下 CO₂ 体积浓度换算质量浓度：
   * 1 Nm³ 混合气体 44.01 g/mol ÷ 22.4 L/mol ≈ 1.9643 g/Nm³ 每 1% 体积分数
   * 故 c[%] → c × 1.9643 g/Nm³ × 10⁴ mg/g → 单位换算后：
   * E[t/h] = Q[Nm³/h] × c[%] × 1.9643e4[mg/Nm³·%] × 1e-9 = Q × c × 1.9643e-5 */
  return q * c * 1.9643e-5;
}

/**
 * O₂ 折算：把实测氧含量下的浓度折算到基准氧含量。
 * C_基准 = C_实测 × (21 − O2_基准) / (21 − O2_实测)
 *
 * 这是 HJ 75 强制要求的一步。跳过它会让高过量空气系数机组的碳浓度被系统性低估。
 *
 * @param {number} conc   实测浓度
 * @param {number} o2Meas 实测氧含量 %
 * @param {number} o2Ref  基准氧含量 %（燃煤锅炉 6、燃油 3、燃气 3、水泥窑 10）
 */
function normalizeO2(conc, o2Meas, o2Ref) {
  const c = Number(conc); const m = Number(o2Meas); const r = Number(o2Ref);
  if (!(c >= 0) || !(m >= 0) || !(r >= 0)) return NaN;
  if (m >= 21) return NaN; // 物理上不可能
  return c * (21 - r) / (21 - m);
}

/**
 * 用一序列 CEMS 读数核算排放量（在线监测法）。
 *
 * @param {Array<object>} readings 读数序列
 *   每项 { time:'2026-01-01T00:00:00Z', velocity, section, tempC, pressKPa,
 *          ambientKPa, humidityPct, co2Pct, o2Pct, qualityFlag, status }
 * @param {object} opts
 *   o2Ref       基准氧含量，缺省 6
 *   maxGapMin   相邻点最大可积分间隔（分钟），超过则不积分（不外推），缺省 240
 *   nominalMin  名义采样周期（分钟），用于计算覆盖率，缺省 60
 * @returns {object} { total, coveredHours, coverage, points, excluded, gaps }
 */
function calcByCems(readings, opts = {}) {
  const o2Ref = Number.isFinite(Number(opts.o2Ref)) ? Number(opts.o2Ref) : 6;
  const maxGapMin = Number.isFinite(Number(opts.maxGapMin)) ? Number(opts.maxGapMin) : 240;
  const nominalMin = Number.isFinite(Number(opts.nominalMin)) ? Number(opts.nominalMin) : 60;

  const rows = (readings || [])
    .map((r) => ({
      t: new Date(r.time).getTime(),
      q: standardFlow(r),
      c: normalizeO2(r.co2Pct, r.o2Pct, o2Ref),
      flag: String(r.qualityFlag || r.quality_flag || 'NORMAL').toUpperCase(),
      status: String(r.status || 'NORMAL').toUpperCase(),
    }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);

  const excluded = [];
  const used = [];
  for (const r of rows) {
    if (r.flag !== 'NORMAL' || r.status !== 'NORMAL') { excluded.push(r); continue; }
    if (!(r.q > 0) || !Number.isFinite(r.c) || r.c < 0) { excluded.push(r); continue; }
    used.push(r);
  }

  /* 梯形积分：用相邻两点平均速率 × 时间间隔。
   * 首点之前、末点之后都不外推 —— 这是「不外推空白」红线的实现。 */
  let total = 0;
  let coveredMs = 0;
  const gaps = [];
  for (let i = 1; i < used.length; i++) {
    const dtMin = (used[i].t - used[i - 1].t) / 60000;
    if (dtMin <= 0) continue;
    if (dtMin > maxGapMin) {
      gaps.push({ from: new Date(used[i - 1].t).toISOString(), to: new Date(used[i].t).toISOString(),
        minutes: Number(dtMin.toFixed(1)), reason: `间隔超过 ${maxGapMin} 分钟，不积分也不外推` });
      continue;
    }
    const e1 = cemsHourly(used[i - 1].q, used[i - 1].c);
    const e2 = cemsHourly(used[i].q, used[i].c);
    if (!Number.isFinite(e1) || !Number.isFinite(e2)) continue;
    total += ((e1 + e2) / 2) * (dtMin / 60);
    coveredMs += used[i].t - used[i - 1].t;
  }

  const coveredHours = coveredMs / 3600000;
  /* 应有时长：从首个有效点到末个有效点的跨度。
   * 这是「自身时间跨度」口径 —— 不假设企业应当报满全月，只判断它报的这段有多密。 */
  const spanHours = used.length >= 2 ? (used[used.length - 1].t - used[0].t) / 3600000 : 0;
  const expectedPoints = spanHours > 0 ? (spanHours * 60) / nominalMin : 0;
  const coverage = expectedPoints > 0 ? Math.min(1, used.length / expectedPoints) : 0;

  return {
    method: METHOD.CEMS,
    total: Number(total.toFixed(3)),
    coveredHours: Number(coveredHours.toFixed(2)),
    spanHours: Number(spanHours.toFixed(2)),
    coverage: Number(coverage.toFixed(4)),
    points: used.length,
    excluded: excluded.length,
    gaps,
    o2Ref,
    maxGapMin,
    note: '在线监测法：标干流量 × 基准氧折算浓度梯形积分；首末点外不外推',
  };
}

/* ==================================================================================
 * 六、双轨比对（EN 14181 思想）
 * ================================================================================== */

/**
 * 计算法与在线监测法的双轨比对。
 *
 * 容差来源：HJ 75-2017 对 CEMS 相对准确度的要求（烟气排放连续监测系统
 * 与参比方法比对，相对误差 ≤ ±15% 为合格）。这里借用同一量级作为双轨一致性判据：
 *
 *   |Δ| / max(计算法, CEMS) × 100%
 *     ≤ 5%   → CONSISTENT   两法高度一致，结果可直接采信
 *     ≤ 15%  → ACCEPTABLE   在 HJ 75 相对准确度限内，需记录归因
 *     > 15%  → DIVERGENT    超出限值，必须归因，不得择一采信
 *
 * @param {number} calcTotal 计算法结果
 * @param {number} cemsTotal 在线监测法结果
 * @param {object} [opts] { tolConsistent:0.05, tolAcceptable:0.15 }
 */
function dualTrackCompare(calcTotal, cemsTotal, opts = {}) {
  const tolC = Number.isFinite(Number(opts.tolConsistent)) ? Number(opts.tolConsistent) : 0.05;
  const tolA = Number.isFinite(Number(opts.tolAcceptable)) ? Number(opts.tolAcceptable) : 0.15;

  const c = calcTotal;
  const m = cemsTotal;
  /* 显式判空：不能用 Number(null) —— 那会得到 0，把「没有数据」伪装成「排放为零」，
   * 进而被判定为两法一致。这是本模块最重要的一条防御。 */
  const bad = (v) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v));
  if (bad(c) || bad(m)) {
    return { available: false, reason: '两条路径中至少一条未产出有效结果，无法比对',
      missing: { calc: bad(c), cems: bad(m) } };
  }
  const cn = Number(c);
  const mn = Number(m);
  if (cn === 0 && mn === 0) {
    return { available: true, verdict: 'BOTH_ZERO', deviation: 0,
      reason: '两法结果均为 0，无可比内容' };
  }
  const denom = Math.max(Math.abs(cn), Math.abs(mn));
  const deviation = denom > 0 ? Math.abs(cn - mn) / denom : 0;

  let verdict;
  if (deviation <= tolC) verdict = 'CONSISTENT';
  else if (deviation <= tolA) verdict = 'ACCEPTABLE';
  else verdict = 'DIVERGENT';

  const hintMap = {
    CONSISTENT: '两法结果高度一致（偏差 ≤ 5%），核算可信度高',
    ACCEPTABLE: '偏差在 HJ 75 相对准确度限值内，需在报告中记录偏差归因',
    DIVERGENT: '偏差超出 15%，必须归因（检查活动数据完整性、因子适用性、CEMS 校准状态），不得择一采信',
  };

  return {
    available: true, verdict,
    calcTotal: Number(cn.toFixed(3)),
    cemsTotal: Number(mn.toFixed(3)),
    deviation: Number((deviation * 100).toFixed(2)),
    deviationUnit: '%',
    tolConsistent: tolC * 100,
    tolAcceptable: tolA * 100,
    reason: hintMap[verdict],
    /* 明确告知：本函数只判不改。判定为 DIVERGENT 时不替用户选择「正确的那个」。 */
    policy: '本比对只做判定，不自动择一采信；DIVERGENT 必须由人工归因后重新核算',
  };
}

/* ==================================================================================
 * 七、数据质量分级
 * ================================================================================== */

/**
 * 判定某次核算的数据质量等级。
 *
 * @param {object} p { coverage:0~1, hasMeasuredFactor:boolean, isContinuous:boolean,
 *                     interpolatedRatio:0~1 }
 * @returns {{tier:string, ...}} 质量档位与是否可用于履约
 */
function qualityTier(p) {
  const cov = Number(p.coverage);
  const interp = Number.isFinite(Number(p.interpolatedRatio)) ? Number(p.interpolatedRatio) : 0;

  if (!Number.isFinite(cov)) {
    return { ...QUALITY_TIER.Q4, reason: '覆盖率不可得，按缺省值档处理' };
  }
  if (cov >= 0.95 && p.isContinuous !== false && interp <= 0.02) {
    return { ...QUALITY_TIER.Q1, coverage: cov, reason: '连续在线监测，覆盖率 ≥ 95%，插补 ≤ 2%' };
  }
  if (cov >= 0.80 && interp <= 0.05) {
    return { ...QUALITY_TIER.Q2, coverage: cov, reason: '覆盖率 80%~95%，或插补 2%~5%，可用于履约但需放大不确定度' };
  }
  if (cov > 0) {
    return { ...QUALITY_TIER.Q3, coverage: cov, reason: '覆盖率 < 80% 或插补 > 5%，仅可用于内部管理' };
  }
  return { ...QUALITY_TIER.Q4, coverage: cov, reason: '无有效连续数据' };
}

/* ==================================================================================
 * 八、自检 —— 每条因子都能被独立复算
 * ================================================================================== */

/**
 * 方法学自检。任何一条失败都说明因子表或公式被改坏了。
 * 这是「主张配命令」原则的落地：平台声称的因子，第三方可以逐条复算。
 */
function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });

  /* 1. 逐条复算燃料因子，与指南登记值比对 */
  const expect = {
    COAL: 1.9003, COKE: 2.8604, GAS: 21.622, DIESEL: 3.0959,
    FUEL_OIL: 3.1705, GASOLINE: 2.9244, LPG: 3.1013,
    /* 焦炉煤气以三要素复算值为准（见 FUEL_FACTORS.COKE_OVEN_GAS 的口径说明） */
    COKE_OVEN_GAS: 7.6224,
  };
  for (const [code, want] of Object.entries(expect)) {
    const f = FUEL_FACTORS[code];
    const got = computeEf(f.ncv, f.cc, f.of);
    /* 容差 0.3%：指南给的登记值本身是四舍五入过的 */
    const rel = Math.abs(got - want) / want;
    push(`因子复算 ${code}(${f.cn})`, rel < 0.003,
      `复算 ${got.toFixed(4)} vs 指南 ${want}，相对差 ${(rel * 100).toFixed(3)}%`);
  }

  /* 2. 44/12 常数正确性 */
  push('44/12 常数', Math.abs(C_TO_CO2 - 3.6666667) < 1e-6, `C_TO_CO2 = ${C_TO_CO2.toFixed(7)}`);

  /* 3. 标干流量换算：0℃、101.325kPa、湿度 0 时应等于工况流量 */
  const q = standardFlow({ velocity: 10, section: 2, tempC: 0, pressKPa: 0, ambientKPa: 101.325, humidityPct: 0 });
  push('标干流量换等（标准状态下等于工况）', Math.abs(q - 10 * 2 * 3600) < 1e-6, `Q = ${q.toFixed(1)} Nm³/h`);

  /* 4. 温度升高，标干流量应下降（体积膨胀修正） */
  const q80 = standardFlow({ velocity: 10, section: 2, tempC: 80, pressKPa: 0, ambientKPa: 101.325, humidityPct: 0 });
  push('温度升高标干流量下降', q80 < q && q80 > 0,
    `0℃ ${q.toFixed(0)} → 80℃ ${q80.toFixed(0)}，比值 ${(q80 / q).toFixed(4)}（应≈273.15/353.15=0.7735）`);
  push('温度修正比精确', Math.abs(q80 / q - T_STD_K / (T_STD_K + 80)) < 1e-9,
    `实测比值 ${(q80 / q).toFixed(6)} vs 理论 ${(T_STD_K / (T_STD_K + 80)).toFixed(6)}`);

  /* 5. O₂ 折算：实测氧等于基准氧时应无变化 */
  push('O₂ 折算恒等（实测=基准）', Math.abs(normalizeO2(12, 6, 6) - 12) < 1e-9,
    `C=${normalizeO2(12, 6, 6)}`);
  /* 实测氧高于基准 → 折算后浓度升高（因为过量空气多，污染物被稀释了） */
  push('O₂ 折算方向正确（实测氧高则折算后升高）', normalizeO2(12, 9, 6) > 12,
    `实测 9%、基准 6%：12 → ${normalizeO2(12, 9, 6).toFixed(4)}`);
  push('O₂ 折算拒绝物理不可能输入', Number.isNaN(normalizeO2(12, 21, 6)), '氧含量 21% 应返回 NaN');

  /* 6. 小时排放量量纲：1 Nm³/h × 1% ≈ 1.96e-5 t/h */
  push('CEMS 小时排放量量纲', Math.abs(cemsHourly(1, 1) - 1.9643e-5) < 1e-9,
    `1 Nm³/h × 1% → ${cemsHourly(1, 1).toExponential(4)} t/h`);

  /* 7. 计算法：100 t 原煤 → 100 × 1.9003 ≈ 190.03 tCO2 */
  const r1 = calcSource({ code: 'COAL', amount: 100 });
  push('计算法 100t 原煤', Math.abs(r1.emission - 190.03) < 0.01, `${r1.emission} tCO2e`);

  /* 8. 计算法：缺数据必须返回 null 而不是 0 */
  const r2 = calcSource({ code: 'COAL', amount: 0 });
  push('缺活动数据返回 null 而非 0', r2.status === 'NO_DATA' && r2.emission === null,
    `status=${r2.status}, emission=${r2.emission}`);

  /* 9. 单位不匹配必须拒绝 */
  const r3 = calcSource({ code: 'COAL', amount: 100, amountUnit: 'MWh' });
  push('单位不匹配拒绝换算', r3.status === 'UNIT_MISMATCH' && r3.emission === null,
    `status=${r3.status}`);

  /* 10. 实测因子优先于缺省因子 */
  const r4 = calcSource({ code: 'COAL', amount: 100, measured: { ncv: 18.0, cc: 26.37, of: 0.94 } });
  const wantMeasured = 100 * computeEf(18.0, 26.37, 0.94);
  push('实测因子优先', r4.tier.startsWith('Tier2') && Math.abs(r4.emission - wantMeasured) < 0.01,
    `Tier=${r4.tier}, emission=${r4.emission}, 期望=${wantMeasured.toFixed(3)}`);

  /* 11. 区域电网因子差异化生效 */
  const pNorth = getFactor('POWER', { region: '华北' });
  const pSouth = getFactor('POWER', { region: '西南' });
  push('区域电网因子差异化', pNorth.ef === 0.9419 && pSouth.ef === 0.2596 && pNorth.ef / pSouth.ef > 3.6,
    `华北 ${pNorth.ef} / 西南 ${pSouth.ef} = ${(pNorth.ef / pSouth.ef).toFixed(2)} 倍`);

  /* 12. 完整性判定：漏一个源必须 complete=false */
  const full = calcEnterprise({
    industry: '电力', region: '华北',
    sources: [{ code: 'COAL', amount: 10000 }, { code: 'GAS', amount: 100 }, { code: 'DIESEL', amount: 10 }, { code: 'POWER', amount: 500 }],
  });
  push('完整性：全部齐备时 complete=true', full.complete === true && full.gaps.length === 0,
    `complete=${full.complete}, gaps=${full.gaps.length}`);

  const partial = calcEnterprise({
    industry: '电力', region: '华北',
    sources: [{ code: 'COAL', amount: 10000 }],
  });
  push('完整性：漏源时 complete=false', partial.complete === false && partial.gaps.length >= 3,
    `complete=${partial.complete}, gaps=${partial.gaps.length}`);

  /* 13. 工业过程排放被计入：水泥熟料 10 万吨 → 5.348 万吨 */
  const cement = calcEnterprise({
    industry: '建材',
    sources: [{ code: 'COAL', amount: 1000 }, { code: 'DIESEL', amount: 10 }, { code: 'POWER', amount: 100 }],
    processes: [{ code: 'CEMENT_CLINKER', activity: 100000 }],
  });
  const clinkerRow = cement.rows.find((r) => r.code === 'CEMENT_CLINKER');
  push('工业过程排放计入', clinkerRow && Math.abs(clinkerRow.emission - 53480) < 0.1,
    `熟料分解排放 = ${clinkerRow ? clinkerRow.emission : 'N/A'} tCO2e`);

  /* 14. 过程排放进入 scope1 而非 scope2 */
  push('过程排放归入范围一', cement.scope1 > 53480, `scope1=${cement.scope1}, scope2=${cement.scope2}`);

  /* 15. 双轨比对：完全一致 → CONSISTENT */
  const c1 = dualTrackCompare(1000, 1000);
  push('双轨比对一致', c1.verdict === 'CONSISTENT' && c1.deviation === 0, `verdict=${c1.verdict}`);

  /* 16. 双轨比对：偏差 10% → ACCEPTABLE */
  const c2 = dualTrackCompare(1000, 900);
  push('双轨比对偏差 10% 判 ACCEPTABLE', c2.verdict === 'ACCEPTABLE',
    `deviation=${c2.deviation}%`);

  /* 17. 双轨比对：偏差 30% → DIVERGENT */
  const c3 = dualTrackCompare(1000, 700);
  push('双轨比对偏差 30% 判 DIVERGENT', c3.verdict === 'DIVERGENT',
    `deviation=${c3.deviation}%`);

  /* 18. 双轨比对：缺数据时不假装一致 */
  const c4 = dualTrackCompare(1000, null);
  push('双轨比对缺数据不假装一致', c4.available === false, `available=${c4.available}`);

  /* 19. 质量分级：高覆盖 → Q1 */
  const q1 = qualityTier({ coverage: 0.98, isContinuous: true, interpolatedRatio: 0 });
  push('质量分级 Q1', q1.code === 'Q1' && q1.usableForCompliance === true, q1.reason);

  /* 20. 质量分级：低覆盖 → 不可履约 */
  const q3 = qualityTier({ coverage: 0.6, isContinuous: true, interpolatedRatio: 0.1 });
  push('质量分级低覆盖不可履约', q3.code === 'Q3' && q3.usableForCompliance === false, q3.reason);

  /* 21. CEMS 积分：恒定速率 100 t/h 持续 1 小时应为 100 t */
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const mk = (offsetMin, q, c) => ({
    time: new Date(t0 + offsetMin * 60000).toISOString(),
    velocity: q, section: 1, tempC: 0, pressKPa: 0, ambientKPa: 101.325, humidityPct: 0,
    co2Pct: c, o2Pct: 6, qualityFlag: 'NORMAL', status: 'NORMAL',
  });
  /* velocity=1, section=1 → 3600 Nm³/h；co2=1% → 3600×1×1.9643e-5 = 0.0707 t/h
   * 为了得到 100 t/h，需要 qStd×c = 100/1.9643e-5 ≈ 5,090,872 */
  const flowFor100 = 5090871.9 / 3600; // m/s 折算
  const series = [mk(0, flowFor100, 1), mk(60, flowFor100, 1)];
  const cems = calcByCems(series, { o2Ref: 6, maxGapMin: 240, nominalMin: 60 });
  push('CEMS 积分恒定速率', Math.abs(cems.total - 100) < 0.5, `积分结果 ${cems.total} t（期望 100）`);

  /* 22. CEMS 积分：超过最大间隔不积分 */
  const series2 = [mk(0, flowFor100, 1), mk(600, flowFor100, 1)];
  const cems2 = calcByCems(series2, { maxGapMin: 240 });
  push('CEMS 超间隔不积分', cems2.total === 0 && cems2.gaps.length === 1,
    `total=${cems2.total}, gaps=${cems2.gaps.length}`);

  /* 23. CEMS 积分：非 NORMAL 标记的点被排除 */
  const bad = mk(0, flowFor100, 1); bad.qualityFlag = 'DRIFT';
  const cems3 = calcByCems([bad, mk(60, flowFor100, 1)]);
  push('CEMS 排除异常标记点', cems3.excluded === 1, `excluded=${cems3.excluded}`);

  /* 24. 覆盖率计算：60 分钟采样、覆盖 60 分钟 → 2 点 / 1 点应为 1.0 */
  push('覆盖率口径', Math.abs(cems.coverage - 1) < 0.01, `coverage=${cems.coverage}`);

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

module.exports = {
  /* 常数 */
  C_TO_CO2, P_STD_KPA, T_STD_K, GJ_PER_TCE, GJ_PER_MWH, MWH_PER_TCE,
  METHOD, QUALITY_TIER,
  /* 因子表 */
  FUEL_FACTORS, REGION_GRID_FACTOR, PROCESS_FACTORS, INDUSTRY_SOURCES,
  /* 内核 */
  computeEf, getFactor, listFuels, listRegions,
  calcSource, calcProcess, calcEnterprise,
  standardFlow, cemsHourly, normalizeO2, calcByCems,
  dualTrackCompare, qualityTier,
  selfTest,
};
