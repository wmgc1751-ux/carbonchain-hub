/**
 * data/sources.js —— 真实公开数据源与因子台账（可追溯 · 可复核 · 可复算）
 * ==================================================================
 * 本文件是"碳链通"全部核算参数与政策依据的**单一事实来源（SSOT）**。
 * 设计原则：
 *
 *   1. **每一个数字都必须能追到文号**。任何因子都带 `cite`（指向 citations 里的
 *      来源条目）、`issuedAt`、`dataYear`，不允许出现"网上查的"这类不可复核值。
 *   2. **能复算的必须复算**。燃料排放因子一律给出 IPCC 公式的四个输入
 *      （低位发热量 NCV、单位热值含碳量 CC、碳氧化率 OF、分子量比 44/12），
 *      前端现场重算并与官方公布值比对，偏差超过 0.5% 即告警。
 *   3. **口径必须区分，不能混用**。电力相关的因子有四类口径，用途完全不同：
 *      · 全国电网平均排放因子        → 企业外购电力的**范围二**核算
 *      · 电力二氧化碳排放因子（年度） → 电力消费间接排放核算（非控排单位）
 *      · 电网基准线排放因子 OM/BM    → CCER 等**减排项目**的额外性与减排量核算
 *      · 电力碳足迹因子（生命周期）  → **产品碳足迹（PCF）**核算
 *      把四者混为一谈是行业最常见的低级错误，本平台在数据结构上就强制区分。
 *   4. **诚实标注可信度**。每条数据带 `traceLevel`：
 *      A = 一手官方发布（附文号/公告号）；B = 权威汇编（国标/团标附录）；
 *      C = 示例值（仅供演示，正式申报须替换为官方当期值）。
 *
 * ⚠ 免责声明：本台账为**工程实现所用的公开数据快照**，用于平台演示与技术论证。
 *   任何正式碳核算、核查报告、CBAM 申报，均须以国家主管部门当期发布值
 *   及经认可的第三方核查结论为准。因子会随年份更新，使用前请核对 `asOf`。
 *
 * @module data/sources
 */
(function (global) {
  'use strict';

  /* ================================================================
   * 0. 元信息
   * ================================================================ */
  const meta = {
    title: '碳链通 · 真实公开数据源与因子台账',
    version: '1.0.0',
    asOf: '2026-10-11',
    scope: '中国全国碳市场 + 产品碳足迹（PCF）+ 欧盟 CBAM 场景',
    methodology: 'IPCC 2006 国家温室气体清单指南（缺省法）+ 中国电力/燃料官方因子',
    disclaimer: '本台账为工程实现所用的公开数据快照。正式碳核算、核查报告与 CBAM 申报，'
      + '均须以国家主管部门当期发布值及经认可的第三方核查结论为准。',
    traceLevels: {
      A: '一手官方发布（附文号/公告号），可直接引用',
      B: '权威汇编（国家标准 / 团体标准 / 交易所披露文件附录）',
      C: '示例值，仅用于演示，正式申报须替换为官方当期值',
    },
  };

  /* ================================================================
   * 1. 引用来源清单（citations）
   *    每条都给出：发布机构 / 文号 / 日期 / 可访问链接
   * ================================================================ */
  const citations = [
    {
      id: 'MEE-2023-43',
      short: '环办气候函〔2023〕43号',
      title: '关于做好2023—2025年发电行业企业温室气体排放报告管理有关工作的通知',
      issuer: '生态环境部办公厅',
      issuedAt: '2023-02-07',
      ref: '环办气候函〔2023〕43号',
      governs: '全国电网平均排放因子 0.5703 tCO₂/MWh（发电行业控排企业范围二核算）',
    },
    {
      id: 'MEE-2024-12',
      short: '2024年第12号公告',
      title: '关于发布2021年电力二氧化碳排放因子的公告',
      issuer: '生态环境部、国家统计局',
      issuedAt: '2024-04-12',
      ref: '生态环境部、国家统计局公告 2024年第12号',
      governs: '2021年电力二氧化碳排放因子 0.5568 tCO₂/MWh',
    },
    {
      id: 'MEE-2025-01-POWER',
      short: '2023年电力碳足迹因子',
      title: '2023年电力碳足迹因子（含8种发电类型与输配电碳足迹因子、全国电力平均碳足迹因子）',
      issuer: '生态环境部、国家统计局、国家能源局',
      issuedAt: '2025-01',
      ref: '生态环境部 2025 年 1 月发布',
      governs: '全国电力平均碳足迹因子 0.6205 kgCO₂e/kWh（**生命周期口径**，用于产品碳足迹）',
      note: '明显小于国外数据库给出的"中国默认值"，填补国内因子数据空白。'
        + '用于产品碳足迹（PCF）核算，**不可与全国电网平均排放因子混用**——后者的范围是"发电碳排放"，'
        + '前者覆盖"燃料开采→发电→输配电"的全生命周期。',
    },
    {
      id: 'NCSC-2024-GRID-BL',
      short: '2023年区域电网基准线排放因子',
      title: '2023年减排项目中国区域电网基准线排放因子',
      issuer: '生态环境部应对气候变化司（国家气候战略中心发布）',
      issuedAt: '2024-07-08',
      ref: '国家气候战略中心 2024-07-08 发布',
      governs: '七大区域电网 OM / BM 基准线排放因子（用于 CCER 减排项目减排量核算）',
      note: 'OM 为 2019–2021 三年以年供电量为权重的加权平均值。'
        + '风电/光伏项目基准线取 α = 0.75×OM + 0.25×BM（UNFCCC《电力系统排放因子计算工具》7.0 版）。',
    },
    {
      id: 'IPCC-2006-V2',
      short: 'IPCC 2006 指南 第2卷 能源',
      title: '2006 IPCC Guidelines for National Greenhouse Gas Inventories, Volume 2: Energy, Chapter 1 Table 1.4',
      issuer: 'IPCC（联合国政府间气候变化专门委员会）',
      issuedAt: '2006',
      ref: 'IPCC 2006 Guidelines, Vol.2 Ch.1 Table 1.4',
      governs: '燃料燃烧 CO₂ 缺省排放因子与不确定度区间；碳氧化率缺省值',
    },
    {
      id: 'PROV-GHG-2011',
      short: '省级温室气体清单编制指南（试行）',
      title: '省级温室气体清单编制指南（试行）',
      issuer: '国家发展改革委应对气候变化司',
      issuedAt: '2011',
      ref: '发改办气候〔2011〕1041号',
      governs: '常用化石燃料单位热值含碳量与 CO₂ 排放系数（1.9003 / 2.8604 / 3.0202 / 3.1705 / 3.0959 / 2.1622 等）',
    },
    {
      id: 'GBT-2589-2020',
      short: 'GB/T 2589-2020',
      title: '综合能耗计算通则',
      issuer: '国家市场监督管理总局、国家标准化管理委员会',
      issuedAt: '2020',
      ref: 'GB/T 2589-2020',
      governs: '能源折标准煤系数、平均低位发热量',
    },
    {
      id: 'GBT-46053-2025',
      short: 'GB/T 46053-2025',
      title: '温室气体减排量评估技术规范（附录A 相关参数推荐值）',
      issuer: '国家市场监督管理总局、国家标准化管理委员会',
      issuedAt: '2025',
      ref: 'GB/T 46053-2025 附录 A',
      governs: '不同燃料燃烧的热值与加权平均 CO₂ 排放因子（低位发热量取《中国能源统计年鉴2023》）',
    },
    {
      id: 'GBT-24067-2024',
      short: 'GB/T 24067-2024',
      title: '温室气体 产品碳足迹 量化要求和指南',
      issuer: '国家市场监督管理总局（国家标准委）批准发布，生态环境部提出并指导制定',
      issuedAt: '2024-09',
      ref: 'GB/T 24067-2024',
      governs: '中国产品碳足迹核算**通则国家标准**，参照 ISO 14067，采用与 GB/T 24040、GB/T 24044 一致的方式',
      note: '填补我国产品碳足迹核算通用标准空白，为碳足迹核算方法国际交流互认打下基础。',
    },
    {
      id: 'ISO-14064-1',
      short: 'ISO 14064-1:2018',
      title: '温室气体 第1部分：组织层次上对温室气体排放和清除的量化与报告的规范及指南',
      issuer: 'ISO',
      issuedAt: '2018',
      ref: 'ISO 14064-1:2018',
      governs: '组织碳核算（范围一/范围二）国际标准',
    },
    {
      id: 'ISO-14067',
      short: 'ISO 14067:2018',
      title: '温室气体 产品碳足迹 量化要求和指南',
      issuer: 'ISO',
      issuedAt: '2018',
      ref: 'ISO 14067:2018',
      governs: '产品碳足迹（PCF）国际标准，GB/T 24067-2024 的参照对象',
    },
    {
      id: 'GHGP-CORP',
      short: 'GHG Protocol 企业标准',
      title: 'The Greenhouse Gas Protocol: A Corporate Accounting and Reporting Standard (Revised Edition)',
      issuer: 'WRI / WBCSD',
      issuedAt: '2004（修订版）',
      ref: 'GHG Protocol Corporate Standard',
      governs: '范围一/二/三划分的国际通用定义',
    },
    {
      id: 'GHGP-GWP-V2',
      short: 'GHG Protocol GWP 值 v2.0',
      title: 'IPCC Global Warming Potential Values (v2.0)',
      issuer: 'GHG Protocol',
      issuedAt: '2024-08-07',
      ref: 'GHG Protocol GWP table v2.0',
      governs: 'AR6 GWP 取值口径：化石源 CH₄ 29.8 仅适用于化石源逸散与过程排放；'
        + '其余甲烷（含化石燃料的固定/移动燃烧）用 27.0',
    },
    {
      id: 'IPCC-AR6-WG1',
      short: 'IPCC AR6 WGI 表7.15',
      title: 'Climate Change 2021: The Physical Science Basis, Chapter 7, Table 7.15',
      issuer: 'IPCC',
      issuedAt: '2021',
      ref: 'IPCC AR6 WGI Chapter 7 Table 7.15（GWP100，不含气候-碳反馈）',
      governs: 'GWP100：CO₂=1；CH₄(化石)=29.8，CH₄(非化石)=27.0（通用值27.9）；N₂O=273；SF₆=24,300；NF₃=17,400；PFC(CF₄)=7,380',
    },
    {
      id: 'CEA-NATIONAL',
      short: '全国碳市场（CEA）行情',
      title: '全国碳排放权交易市场综合价格行情与成交信息',
      issuer: '上海环境能源交易所（全国碳排放权交易机构）',
      issuedAt: '2026（持续更新）',
      ref: '上海环境能源交易所每日行情公告',
      governs: '全国碳配额（CEA）成交价格',
    },
    {
      id: 'CEA-REPORT-2026',
      short: '《全国碳市场发展报告(2026)》',
      title: '全国碳市场发展报告(2026)',
      issuer: '生态环境部（2026中国碳市场大会发布）',
      issuedAt: '2026-09-15',
      ref: '2026 中国碳市场大会（武汉）发布',
      governs: '全国碳市场覆盖范围、成交量价年度统计数据',
    },
    {
      id: 'CCER-CONTRACT',
      short: '全国温室气体自愿减排交易市场',
      title: '核证自愿减排量（CCER）成交行情',
      issuer: '北京绿色交易所 / 全国温室气体自愿减排注册登记系统',
      issuedAt: '2026（持续更新）',
      ref: 'CCER 市场行情公告',
      governs: 'CCER 成交均价',
    },
    {
      id: 'EU-CBAM-956',
      short: 'CBAM Regulation (EU) 2023/956',
      title: 'Regulation (EU) 2023/956 establishing a carbon border adjustment mechanism',
      issuer: '欧洲议会与欧盟理事会；执行机构：欧盟委员会 taxation-customs 总司',
      issuedAt: '2023-05-17（2026-01-01 起进入正式实施期）',
      ref: 'Regulation (EU) 2023/956；修订 Regulation (EU) 2025/2083',
      governs: '碳边境调节机制：覆盖水泥、钢铁、铝、化肥、电力、氢；'
        + '2026-01-01 起进口商须购买 CBAM 证书；单一大宗阈值 50 吨；'
        + '证书价格按欧盟 ETS 拍卖均价（2026 季度均价，2027 起周均价）',
    },
    {
      id: 'EU-BATTERY-1542',
      short: 'Batteries Regulation (EU) 2023/1542',
      title: 'Regulation (EU) 2023/1542 concerning batteries and waste batteries',
      issuer: '欧洲议会与欧盟理事会',
      issuedAt: '2023-07-12',
      ref: 'Regulation (EU) 2023/1542',
      governs: '欧盟新电池法规：动力电池须提供碳足迹声明与**产品数字护照（DPP）**，'
        + '碳足迹须经第三方核查并按生命周期分阶段披露',
    },
    {
      id: 'MEE-CARBON-FOOTPRINT-PLAN',
      short: '《关于建立碳足迹管理体系的实施方案》',
      title: '关于建立碳足迹管理体系的实施方案',
      issuer: '生态环境部等 15 部门',
      issuedAt: '2024-06',
      ref: '环气候〔2024〕40号 等 15 部门联合印发',
      governs: '国家产品碳足迹管理体系顶层设计；国家温室气体排放因子数据库建设',
    },
    {
      id: 'MEE-FACTOR-DB',
      short: '国家温室气体排放因子数据库',
      title: '国家温室气体排放因子数据库',
      issuer: '生态环境部会同国家统计局建设并上线',
      issuedAt: '2025',
      ref: '国家温室气体排放因子数据库（在线）',
      governs: '基础能源、原材料、交通运输等通用因子及外贸产品终端消费品因子',
    },
    {
      id: 'MOFCOM-CBAM-2026',
      short: '商务部就 CBAM 答记者问',
      title: '商务部新闻发言人就欧盟碳边境调节机制（CBAM）正式实施答记者问',
      issuer: '中华人民共和国商务部',
      issuedAt: '2026-01',
      ref: '商务部新闻发言人答记者问',
      governs: '中方立场：欧方对中国产品碳排放强度设定显著偏高的基础默认值，'
        + '不符合中国当前实际水平和未来发展趋势，构成不公平、歧视性待遇',
    },
  ];

  const citeMap = {};
  citations.forEach((c) => { citeMap[c.id] = c; });
  const cite = (id) => citeMap[id] || null;

  /* ================================================================
   * 2. 电力因子：四类口径（严禁混用）
   * ================================================================ */

  /** 口径定义 —— 本平台在数据结构上强制区分 */
  const POWER_SCOPES = {
    GRID_AVG: {
      code: 'GRID_AVG',
      cn: '全国电网平均排放因子',
      use: '企业外购电力的【范围二】间接排放核算（发电行业控排企业适用）',
      boundary: '发电环节 CO₂ 排放 ÷ 上网电量',
      unit: 'tCO₂/MWh',
    },
    POWER_CO2: {
      code: 'POWER_CO2',
      cn: '电力二氧化碳排放因子',
      use: '非控排单位核算电力消费间接排放',
      boundary: '发电环节 CO₂ 排放 ÷ 用电量（含输配损失处理口径）',
      unit: 'tCO₂/MWh',
    },
    GRID_BASELINE: {
      code: 'GRID_BASELINE',
      cn: '电网基准线排放因子（OM / BM）',
      use: 'CCER / CDM 等【减排项目】的额外性论证与减排量核算',
      boundary: 'OM＝电量边际（现有电厂加权平均）；BM＝容量边际（新增装机加权平均）',
      unit: 'tCO₂/MWh',
    },
    POWER_FOOTPRINT: {
      code: 'POWER_FOOTPRINT',
      cn: '电力碳足迹因子（生命周期）',
      use: '【产品碳足迹 PCF】中电力投入的排放核算',
      boundary: '燃料开采 → 发电 → 输配电 全生命周期',
      unit: 'kgCO₂e/kWh',
    },
  };

  /** 全国层面的电力因子历史序列（可追溯） */
  const powerFactors = {
    /** 当前基准：组织碳核算（范围二）默认取值 */
    national: {
      scope: 'GRID_AVG',
      code: 'CN-GRID-AVG',
      name: '全国电网平均排放因子',
      value: 0.5703,
      unit: 'tCO₂/MWh',
      dataYear: 2022,
      issuedBy: '生态环境部办公厅',
      issuedAt: '2023-02-07',
      ref: '环办气候函〔2023〕43号',
      cite: 'MEE-2023-43',
      traceLevel: 'A',
      applicability: '2023—2025 年发电行业企业温室气体排放报告',
      note: '部分团体标准将本值标注为"全国电网平均排放因子(2023)"，另有资料标注为 2022 年度值。'
        + '差异源于"数据年度 / 报告适用年度"的命名习惯，**引用时应注明文号而非仅写年份**。',
    },
    /** 性质：消费侧口径，年度发布 */
    powerCo2: {
      scope: 'POWER_CO2',
      code: 'CN-POWER-CO2',
      name: '电力二氧化碳排放因子（2021 年）',
      value: 0.5568,
      unit: 'tCO₂/MWh',
      dataYear: 2021,
      issuedBy: '生态环境部、国家统计局',
      issuedAt: '2024-04-12',
      ref: '生态环境部、国家统计局公告 2024年第12号',
      cite: 'MEE-2024-12',
      traceLevel: 'A',
      note: '用于非控排单位核算电力消费产生的间接排放。与"全国电网平均排放因子"同为消费侧口径，'
        + '但发布主体与适用对象不同，发电行业控排企业应使用后者。',
    },
    /** 生命周期口径：产品碳足迹使用 */
    footprint: {
      scope: 'POWER_FOOTPRINT',
      code: 'CN-POWER-CFP',
      name: '全国电力平均碳足迹因子（2023 年）',
      value: 0.6205,
      unit: 'kgCO₂e/kWh',
      dataYear: 2023,
      issuedBy: '生态环境部、国家统计局、国家能源局',
      issuedAt: '2025-01',
      ref: '2023年电力碳足迹因子（2025年1月发布）',
      cite: 'MEE-2025-01-POWER',
      traceLevel: 'A',
      note: '生命周期口径，覆盖燃煤/燃气/水电/核电/风电/光伏/光热/生物质 8 类发电与输配电。'
        + '以 2023 年各类型发电量为权重迭代计算。'
        + '**数值高于电网平均排放因子，是因为包含了燃料开采等上游环节**——'
        + '这正是"排放因子"与"碳足迹因子"的核心区别。',
    },
    /** 历史序列：用于展示因子逐年下降趋势（脱碳成效） */
    history: [
      { year: 2017, value: 0.6101, scope: 'GRID_AVG', issuedBy: '国家发展改革委', note: '首次发布全国电网排放因子' },
      { year: 2020, value: 0.5810, scope: 'GRID_AVG', issuedBy: '生态环境部办公厅', ref: '环办气候函〔2022〕111号', issuedAt: '2022-03' },
      { year: 2021, value: 0.5568, scope: 'POWER_CO2', issuedBy: '生态环境部、国家统计局', ref: '2024年第12号公告', issuedAt: '2024-04-12' },
      { year: 2022, value: 0.5703, scope: 'GRID_AVG', issuedBy: '生态环境部办公厅', ref: '环办气候函〔2023〕43号', issuedAt: '2023-02-07' },
      { year: 2023, value: 0.6205, scope: 'POWER_FOOTPRINT', issuedBy: '生态环境部、国家统计局、国家能源局', issuedAt: '2025-01', unit: 'kgCO₂e/kWh' },
    ],
    /** 七大区域电网基准线排放因子（2023 年，用于 CCER 减排项目） */
    gridBaseline: {
      year: 2023,
      issuedAt: '2024-07-08',
      issuedBy: '生态环境部应对气候变化司（国家气候战略中心发布）',
      cite: 'NCSC-2024-GRID-BL',
      traceLevel: 'A',
      unit: 'tCO₂/MWh',
      /** α = 0.75×OM + 0.25×BM（风电/光伏）；其他可再生 α = 0.5×OM + 0.5×BM */
      alphaRule: { windPv: { om: 0.75, bm: 0.25 }, other: { om: 0.5, bm: 0.5 } },
      regions: [
        { code: 'NORTH', cn: '华北区域电网', om: 0.9350, bm: 0.3020 },
        { code: 'NORTHEAST', cn: '东北区域电网', om: 1.0472, bm: 0.2070 },
        { code: 'EAST', cn: '华东区域电网', om: 0.7703, bm: 0.2030 },
        { code: 'CENTRAL', cn: '华中区域电网', om: 0.8771, bm: 0.2696 },
        { code: 'NORTHWEST', cn: '西北区域电网', om: 0.9014, bm: 0.3597 },
        { code: 'SOUTH', cn: '南方区域电网', om: 0.7738, bm: 0.1981 },
        { code: 'SOUTHWEST', cn: '西南区域电网', om: 0.5959, bm: 0.0634 },
      ],
      note: 'OM 为 2019—2021 三年以年供电量为权重的加权平均值。'
        + '该因子**仅用于减排项目**（CCER）的额外性论证与减排量核算，'
        + '**不得**用于组织碳核算（范围二）或产品碳足迹。',
    },
  };

  /* ================================================================
   * 3. 燃料排放因子（IPCC 缺省法 · 可现场复算）
   *    EF[kgCO₂/单位] = NCV[GJ/单位] × CC[tC/GJ] × OF × 44/12
   * ================================================================ */

  /** 分子量比 CO₂/C = 44/12 */
  const C_TO_CO2 = 44 / 12;

  /**
   * @typedef {Object} FuelFactor
   * @property {string} code      内部编码
   * @property {string} cn        中文名
   * @property {string} unit      活动数据单位
   * @property {number} ncv       平均低位发热量（GJ/单位）
   * @property {number} cc        单位热值含碳量（tC/GJ）
   * @property {number} of        碳氧化率（0~1）
   * @property {number} ef        官方公布 CO₂ 排放因子（kgCO₂/单位）
   * @property {string} traceLevel 可信度
   * @property {string[]} cites   来源
   */
  const fuelFactors = [
    // ---- 来自 GB/T 46053-2025 附录 A（低位发热量取《中国能源统计年鉴2023》，
    //      单位热值含碳量取《省级温室气体清单指南(试行)》）----
    { code: 'RAW_COAL', cn: '原煤', unit: 't', ncv: 20.908, cc: 0.02637, of: 0.94, ef: 1900.3, traceLevel: 'B', cites: ['GBT-46053-2025', 'PROV-GHG-2011'], srcNote: '《中国能源统计年鉴2023》低位发热量 + 省级清单指南含碳量' },
    { code: 'COKE', cn: '焦炭', unit: 't', ncv: 28.435, cc: 0.02950, of: 0.93, ef: 2860.4, traceLevel: 'B', cites: ['GBT-46053-2025', 'PROV-GHG-2011'] },
    { code: 'CRUDE_OIL', cn: '原油', unit: 't', ncv: 41.816, cc: 0.02010, of: 0.98, ef: 3022.9, traceLevel: 'B', cites: ['GBT-46053-2025', 'PROV-GHG-2011'] },
    { code: 'FUEL_OIL', cn: '燃料油', unit: 't', ncv: 41.816, cc: 0.02110, of: 0.98, ef: 3173.3, traceLevel: 'B', cites: ['GBT-46053-2025', 'PROV-GHG-2011'] },
    { code: 'GASOLINE', cn: '汽油', unit: 't', ncv: 43.070, cc: 0.01890, of: 0.98, ef: 2927.7, traceLevel: 'B', cites: ['GBT-46053-2025', 'PROV-GHG-2011'] },
    { code: 'KEROSENE', cn: '煤油', unit: 't', ncv: 43.070, cc: 0.01960, of: 0.98, ef: 3036.1, traceLevel: 'B', cites: ['GBT-46053-2025', 'PROV-GHG-2011'] },
    { code: 'DIESEL', cn: '柴油', unit: 't', ncv: 42.652, cc: 0.02020, of: 0.98, ef: 3098.7, traceLevel: 'B', cites: ['GBT-46053-2025', 'PROV-GHG-2011'] },
    { code: 'LPG', cn: '液化石油气', unit: 't', ncv: 50.179, cc: 0.01720, of: 0.98, ef: 3101.3, traceLevel: 'B', cites: ['GBT-46053-2025'] },
    { code: 'REFINERY_GAS', cn: '炼厂干气', unit: 't', ncv: 45.998, cc: 0.01820, of: 0.98, ef: 3011.9, traceLevel: 'B', cites: ['GBT-46053-2025'] },
    { code: 'NATURAL_GAS', cn: '天然气', unit: '万Nm³', ncv: 389.31, cc: 0.01530, of: 0.99, ef: 21622.0, traceLevel: 'B', cites: ['GBT-46053-2025', 'PROV-GHG-2011'], srcNote: '÷10⁴ 得 2.1622 kgCO₂/Nm³' },
    // ---- 来自减排项目口径 GB/T 46053-2025 / 区域电网 OM 计算说明（数值略有差异，
    //      因其低位发热量年份与含碳量取值来源不同；两者均为真实值，须按场景选用）----
    { code: 'ANTHRACITE', cn: '无烟煤', unit: 't', ncv: 26.7, cc: 0.02749, of: 0.94, ef: 2529.8, traceLevel: 'B', cites: ['GBT-46053-2025'], scenario: 'CCER 减排项目口径' },
    { code: 'BITUMINOUS', cn: '一般烟煤', unit: 't', ncv: 19.5701, cc: 0.02618, of: 0.93, ef: 1747.1, traceLevel: 'B', cites: ['GBT-46053-2025'], scenario: 'CCER 减排项目口径' },
    { code: 'COKE_PROJ', cn: '焦炭（减排项目口径）', unit: 't', ncv: 28.4352, cc: 0.02942, of: 0.93, ef: 2852.7, traceLevel: 'B', cites: ['GBT-46053-2025'], scenario: 'CCER 减排项目口径' },
    // ---- 蒸汽：无统一国标缺省值，须按供热方实测或合同约定，故标注为示例值 ----
    { code: 'STEAM', cn: '外购蒸汽', unit: 'GJ', ncv: 1.0, cc: 0, of: 0, ef: 0.1100, traceLevel: 'C', cites: [], srcNote: '蒸汽无全国统一缺省排放因子。本值为常见工程取值（0.11 tCO₂/GJ），正式核算须采用供热单位实测值或合同约定值。' },
  ];

  /**
   * IPCC 缺省法复算：EF = NCV × CC × OF × 44/12
   * @param {{ncv:number, cc:number, of:number, unitDivisor?:number}} p
   *        unitDivisor: 输出单位换算（如天然气 万Nm³ → Nm³ 传 1e4）
   * @returns {number} 复算值（tCO₂/单位）
   */
  function computeEf(p) {
    const ef = Number(p.ncv) * Number(p.cc) * Number(p.of) * C_TO_CO2;
    return p.unitDivisor ? ef / Number(p.unitDivisor) : ef;
  }

  /**
   * 对全部燃料做"官方公布值 vs 公式复算值"一致性核验。
   * @returns {{rows:Array, maxDeviationPct:number, allWithinTolerance:boolean}}
   */
  function verifyFuelFactors(tolerancePct) {
    const tol = Number(tolerancePct) || 0.5;
    const rows = fuelFactors.filter((f) => f.traceLevel !== 'C').map((f) => {
      // 官方公布值单位 kgCO₂/单位；公式输出 tCO₂/单位
      const computed = computeEf(f) * 1000;
      const devPct = Math.abs(computed - f.ef) / f.ef * 100;
      return {
        code: f.code,
        cn: f.cn,
        published: f.ef,
        computed: Math.round(computed * 100) / 100,
        deviationPct: Math.round(devPct * 1000) / 1000,
        withinTolerance: devPct <= tol,
        formula: `${f.ncv} × ${f.cc} × ${f.of} × 44/12 × 1000`,
      };
    });
    const maxDev = rows.reduce((m, r) => Math.max(m, r.deviationPct), 0);
    return { rows, maxDeviationPct: Math.round(maxDev * 1000) / 1000, allWithinTolerance: rows.every((r) => r.withinTolerance), tolerancePct: tol };
  }

  /* ================================================================
   * 4. GWP（全球增温潜势，IPCC AR6，100 年，不含气候-碳反馈）
   * ================================================================ */
  const gwps = {
    standard: 'IPCC AR6 WGI Chapter 7, Table 7.15（GWP100，不含气候-碳反馈）',
    cite: 'IPCC-AR6-WG1',
    attributionCite: 'GHGP-GWP-V2',
    traceLevel: 'A',
    values: [
      { gas: 'CO2', cn: '二氧化碳', formula: 'CO₂', gwp100: 1, ar5: 1 },
      { gas: 'CH4_FOSSIL', cn: '甲烷（化石源）', formula: 'CH₄', gwp100: 29.8, ar5: 28, ar6Uncertainty: 11, appliesTo: '化石能源的**逸散排放**与碳为化石来源的工业过程排放（油气系统泄漏、煤炭开采甲烷）' },
      { gas: 'CH4_NON_FOSSIL', cn: '甲烷（非化石源）', formula: 'CH₄', gwp100: 27.0, ar5: 28, ar6Uncertainty: 11, appliesTo: '其余全部甲烷，**包括化石燃料的固定燃烧与移动燃烧**、废弃物、农业、废水' },
      { gas: 'CH4_GENERIC', cn: '甲烷（通用值）', formula: 'CH₄', gwp100: 27.9, ar5: 28, note: '仅计入 CH₄ 自身辐射强迫，不含氧化生成 CO₂ 的部分（AR6 Table 7.SM.6）' },
      { gas: 'N2O', cn: '氧化亚氮', formula: 'N₂O', gwp100: 273, ar5: 265, ar6Uncertainty: 130 },
      { gas: 'SF6', cn: '六氟化硫', formula: 'SF₆', gwp100: 24300, ar5: 23500, note: '电气开关设备、镁加工' },
      { gas: 'NF3', cn: '三氟化氮', formula: 'NF₃', gwp100: 17400, ar5: 16100, note: '半导体制造、光伏生产' },
      { gas: 'CF4', cn: '四氟化碳', formula: 'CF₄', gwp100: 7380, ar5: 6630, note: '一次铝冶炼、半导体；已纳入全国碳市场温室气体种类' },
      { gas: 'C2F6', cn: '六氟化二碳', formula: 'C₂F₆', gwp100: 12400, ar5: 11100, note: '铝冶炼、半导体；已纳入全国碳市场温室气体种类' },
    ],
    /**
     * 取 GWP 值。注意化石源甲烷的选取规则（GHG Protocol v2.0 口径）。
     * @param {string} gas 'CH4' | 'N2O' | ...
     * @param {'fossil'|'non-fossil'|null} origin
     */
    gwp: function (gas, origin) {
      const g = String(gas || '').toUpperCase();
      if (g === 'CH4' || g === 'CH₄') {
        const key = origin === 'fossil' ? 'CH4_FOSSIL' : origin === 'non-fossil' ? 'CH4_NON_FOSSIL' : 'CH4_GENERIC';
        const row = gwps.values.find((v) => v.gas === key);
        return row ? row.gwp100 : 27.9;
      }
      const row = gwps.values.find((v) => v.gas === g);
      return row ? row.gwp100 : 1;
    },
    warning: '常见错误：不分来源统一采用 CH₄=25（AR4）或 28（AR5）。'
      + 'AR6 之后须区分化石源（29.8）与非化石源（27.0）；'
      + '对本平台涉及的固定源燃烧，正确取值为 **27.0**（燃烧生成的 CO₂ 已在燃烧 CO₂ 中计入，'
      + '不能再把甲烷氧化后的碳重复计一遍）。',
  };

  /* ================================================================
   * 5. 碳价（多市场）
   * ================================================================ */
  const carbonPrice = {
    asOf: '2026-10-11',
    markets: [
      {
        code: 'CEA',
        cn: '全国碳排放权交易市场（配额）',
        unit: '元/吨 CO₂e',
        currency: 'CNY',
        traceLevel: 'A',
        cite: 'CEA-NATIONAL',
        /** 最新可核验收盘价 */
        latest: { value: 97.90, date: '2026-08-31', basis: '综合价格收盘价' },
        /** 关键时点（用于展示趋势） */
        points: [
          { date: '2021-07-16', value: 48.00, note: '全国碳市场开市首日开盘价（51.23 为开盘，此处取当日行情口径）' },
          { date: '2024-12-31', value: 97.49, note: '2024 年末' },
          { date: '2025-12-31', value: 74.63, note: '2025 年底综合价格收盘价；较启动首日开盘价上涨 55%' },
          { date: '2026-08-31', value: 97.90, note: '较 2025 年底上涨 31.18%' },
          { date: '2026-09-30', value: 94.96, note: '9 月 30 日收盘价' },
        ],
        stats: {
          avg2025: 62.36,
          avg2026Sep: 95.33,
          high2026Sep: 98.50,
          low2026Sep: 92.51,
          dailyVolatility2025: 0.93,
          cumulativeVolumeMt: 992,
          cumulativeValueBnCNY: 68.59,
          cumulativeAsOf: '2026-09-30',
        },
      },
      {
        code: 'CCER',
        cn: '全国温室气体自愿减排交易市场',
        unit: '元/吨 CO₂e',
        currency: 'CNY',
        traceLevel: 'A',
        cite: 'CCER-CONTRACT',
        latest: { value: 93.34, date: '2026-09', basis: '9 月成交均价' },
        points: [
          { date: '2025-03', value: 80.45, note: '首批核证自愿减排量入市交易' },
          { date: '2025-12-31', value: 85.00, note: '2025 年底成交均价' },
          { date: '2026-08-31', value: 86.51, note: '8 月底成交均价' },
          { date: '2026-09-30', value: 93.34, note: '9 月成交均价，与 CEA 价差进一步收窄' },
        ],
        stats: { avg2025: 70.76, avg2025SolarThermal: 81.58, avg2025OffshoreWind: 69.27 },
      },
      {
        code: 'EU_ETS',
        cn: '欧盟碳排放交易体系（EU ETS / EUA）',
        unit: '欧元/吨 CO₂e',
        currency: 'EUR',
        traceLevel: 'B',
        cite: 'CEA-NATIONAL',
        latest: { value: 85.16, date: '2026-09-10', basis: '成交均价' },
        note: '**CBAM 证书价格即以欧盟 ETS 拍卖均价为基准换算**（2026 按季度均价，2027 起按周均价），'
          + '因此 EU ETS 价格直接决定中国出口企业面临的碳关税成本。',
      },
    ],
    /** 全国碳市场覆盖范围（2026） */
    coverage: {
      sectors: ['发电', '钢铁', '水泥', '铝冶炼'],
      nextSectors: ['石化', '化工', '造纸', '民航'],
      entities: 3680,
      coveredEmissionsBt: 83,
      shareOfNationalPct: 65,
      gases: ['CO₂', 'CF₄（四氟化碳）', 'C₂F₆（六氟化二碳）'],
      cite: 'CEA-REPORT-2026',
      note: '2025 年首次扩围，重点排放单位由 2024 年的 2096 家增至 3378 家（+61.16%）；'
        + '2026 年四个行业共 3680 家，覆盖全国碳排放总量 65% 以上。',
    },
    /** 换算所需的参考汇率（仅用于跨市场比较，非交易用价） */
    fx: { EURCNY: 7.85, asOf: '2026-10', note: '仅用于平台内跨市场折算展示，非实时交易汇率。' },
  };

  /* ================================================================
   * 6. 政策法规与标准清单
   * ================================================================ */
  const standards = [
    {
      code: 'GB/T 24067-2024', cn: '温室气体 产品碳足迹 量化要求和指南',
      kind: '国标', level: '通则', issuer: '市场监管总局（国家标准委）', issuedAt: '2024-09',
      traceLevel: 'A', cite: 'GBT-24067-2024',
      maps: 'ISO 14067:2018（参照）', purpose: '产品碳足迹（PCF）核算',
      note: '填补我国产品碳足迹核算通用标准空白；为碳足迹核算方法国际交流互认打下基础。'
        + '平台"产品碳足迹（ISO 14067 / GHG Protocol）"轨即对标本标准。',
    },
    {
      code: 'ISO 14064-1:2018', cn: '温室气体 第1部分：组织层次量化与报告规范及指南',
      kind: '国际标准', level: '组织层面', issuer: 'ISO', issuedAt: '2018',
      traceLevel: 'A', cite: 'ISO-14064-1', purpose: '组织碳核算（范围一/范围二）',
      note: '平台"组织碳核算（ISO 14064）"轨对标本标准。',
    },
    {
      code: 'ISO 14067:2018', cn: '温室气体 产品碳足迹 量化要求和指南',
      kind: '国际标准', level: '产品层面', issuer: 'ISO', issuedAt: '2018',
      traceLevel: 'A', cite: 'ISO-14067', purpose: '产品碳足迹（PCF）',
    },
    {
      code: 'GHG Protocol Corporate', cn: '温室气体核算体系 企业核算与报告标准',
      kind: '国际方法学', level: '组织层面', issuer: 'WRI / WBCSD', issuedAt: '2004（修订版）',
      traceLevel: 'A', cite: 'GHGP-CORP', purpose: '范围一/二/三划分的国际通用定义',
    },
    {
      code: 'GB/T 32150-2015', cn: '工业企业温室气体排放核算和报告通则',
      kind: '国标', level: '通则', issuer: '国家标准委', issuedAt: '2015',
      traceLevel: 'A', purpose: '国内企业温室气体核算通则',
    },
    {
      code: 'GB/T 32151.1~.13', cn: '温室气体排放核算与报告要求 系列行业标准',
      kind: '国标', level: '行业', issuer: '国家标准委', issuedAt: '2015—2023',
      traceLevel: 'A', purpose: '发电、钢铁、水泥、铝冶炼等行业核算与报告要求',
      note: '全国碳市场扩围后，钢铁、水泥、铝冶炼纳入管控即依托该系列标准。',
    },
    {
      code: 'GB/T 2589-2020', cn: '综合能耗计算通则',
      kind: '国标', level: '基础方法', issuer: '市场监管总局、国家标准委', issuedAt: '2020',
      traceLevel: 'A', cite: 'GBT-2589-2020', purpose: '折标准煤系数与平均低位发热量',
    },
    {
      code: 'GB/T 46053-2025', cn: '温室气体减排量评估技术规范',
      kind: '国标', level: '方法学', issuer: '市场监管总局、国家标准委', issuedAt: '2025',
      traceLevel: 'A', cite: 'GBT-46053-2025', purpose: '减排量评估；附录A 给出燃料热值与排放因子推荐值',
    },
    {
      code: 'ISO 14040 / 14044', cn: '生命周期评价 原则与框架 / 要求与指南',
      kind: '国际标准', level: '基础方法', issuer: 'ISO', issuedAt: '2006',
      traceLevel: 'A', purpose: 'LCA 方法基础，ISO 14067 与 GB/T 24067 均以其为方法依据',
      note: '国标对应版本为 GB/T 24040、GB/T 24044，GB/T 24067-2024 明确采用与其一致的方式。',
    },
    {
      code: 'IPCC 2006 Guidelines', cn: '2006 年 IPCC 国家温室气体清单指南',
      kind: '国际方法学', level: '基础方法', issuer: 'IPCC', issuedAt: '2006',
      traceLevel: 'A', cite: 'IPCC-2006-V2', purpose: '缺省法排放因子、不确定度区间、碳氧化率',
    },
  ];

  const policies = [
    {
      code: '碳排放权交易管理暂行条例', cn: '碳排放权交易管理暂行条例',
      issuer: '国务院', issuedAt: '2024-01-25 公布，2024-05-01 施行', ref: '国务院令第 775 号',
      traceLevel: 'A',
      purpose: '中国首部应对气候变化领域专门行政法规，确立碳排放权交易基本制度框架。',
    },
    {
      code: '碳足迹管理体系实施方案', cn: '关于建立碳足迹管理体系的实施方案',
      issuer: '生态环境部等 15 部门', issuedAt: '2024-06', ref: '环气候〔2024〕40号 等',
      traceLevel: 'A', cite: 'MEE-CARBON-FOOTPRINT-PLAN',
      purpose: '国家产品碳足迹管理体系顶层设计，部署国家温室气体排放因子数据库建设。',
    },
    {
      code: '产品碳足迹核算标准编制工作指引', cn: '产品碳足迹核算标准编制工作指引',
      issuer: '生态环境部牵头', issuedAt: '2024-12', traceLevel: 'A',
      purpose: '推动团标、行标、国标互相衔接；优先聚焦基础能源、"新三样"、交通运输等领域。',
      note: '已形成含锂离子电池、电力变压器、光伏组件等在内的百余项产品碳足迹核算标准。',
    },
    {
      code: '国家温室气体排放因子数据库', cn: '国家温室气体排放因子数据库',
      issuer: '生态环境部会同国家统计局', issuedAt: '2025 上线', traceLevel: 'A', cite: 'MEE-FACTOR-DB',
      purpose: '为产品碳足迹核算提供公共因子数据基础；本平台因子台账与其口径保持一致。',
    },
  ];

  /* ================================================================
   * 7. 国际绿色贸易规则（应用价值锚点）
   * ================================================================ */
  const internationalRules = [
    {
      code: 'CBAM',
      cn: '欧盟碳边境调节机制（碳关税）',
      ref: 'Regulation (EU) 2023/956；修订 Regulation (EU) 2025/2083',
      cite: 'EU-CBAM-956',
      traceLevel: 'A',
      status: '**2026-01-01 起进入正式实施期（征收期）**，过渡期（2023-10-01 至 2025-12-31）已结束',
      coverage: ['水泥', '钢铁', '铝', '化肥', '电力', '氢'],
      expansion: '2025-12 提案扩围约 180 种钢铝密集型下游产品（机械设备及零件、汽车及零部件、家用电器、电气设备、金属制品），预计 2028-01-01 实施',
      mechanics: {
        certificatePrice: '以欧盟 ETS 配额拍卖均价计价（2026 按季度均价，2027 起按周均价）',
        formula: '碳关税成本 = CBAM 证书数量 × 欧盟周拍卖均价 − 原产国已支付合规碳成本',
        certificateCount: 'CBAM 证书数量 = 应征税产品碳排放总量 − 免费配额总量',
        threshold: '单一大宗阈值 50 吨（不足 50 吨免于合规义务；阈值为**进口商**口径）',
        authorization: '进口商或间接海关代表须申请授权申报人资格，最迟不晚于 2026-03-31',
      },
      /** 对中国出口企业的直接冲击（可量化的痛点，也是本平台的价值锚点） */
      impactCN: {
        costPerTonSteel: { min: 130, max: 4670, unit: '元/吨', basis: '按缺省值法核算的 CBAM 钢铁产品额外成本区间' },
        verification: '使用**实际值**计算需：产品隐含碳排放专业核算 + 结果经欧盟认可的第三方机构核查 + 上游数据可获取；三者缺一即只能退回缺省值法。',
        defaultPenalty: '欧盟对中国产品碳排放强度设定的基础默认值显著偏高，且将在未来三年内逐年提高；中方已明确表示反对，认为构成不公平、歧视性待遇。',
        cite: 'MOFCOM-CBAM-2026',
      },
      /** 平台可直接对标的合规能力 */
      platformMapping: [
        '批次级产品碳足迹（PCF）核算 → 对应 CBAM 要求的"产品隐含碳排放"',
        '第三方核查节点签名 → 对应"经欧盟认可的第三方机构核查"',
        '设备 DID + 边缘硬件签名 + 原始报文 → 解决"上游数据难获取"',
        '链上存证 + 穿透式验真 → 为"实际值法"提供可被欧盟信任的数据链路',
        '原产国已支付碳成本凭证（CEA/CCER 成交存证）→ 对应 CBAM 成本扣减',
      ],
    },
    {
      code: 'EU_BATTERY',
      cn: '欧盟新电池法规',
      ref: 'Regulation (EU) 2023/1542',
      cite: 'EU-BATTERY-1542',
      traceLevel: 'A',
      status: '已生效，分阶段实施',
      requires: [
        '动力电池须提供**碳足迹声明**并按生命周期分阶段披露',
        '碳足迹须经第三方核查',
        '须提供**产品数字护照（Digital Product Passport, DPP）**，扫码可查',
      ],
      platformMapping: [
        '产品数字护照（DPP）卡片：BOM 碳排放构成 + 第三方核查公钥签名 + 防伪二维码',
        '第三方核查节点公钥签名 → 对应"碳足迹须经第三方核查"',
        '穿透式验真流水线（物理采集→国密签名→合约核算→多节点共识）→ 对应 DPP 的可验证性要求',
      ],
    },
    {
      code: 'CRITICAL_FACT',
      cn: '关键事实：欧盟不承认绿证抵扣电力间接排放',
      traceLevel: 'A',
      cite: 'MEE-CARBON-FOOTPRINT-PLAN',
      detail: '欧盟已发布的官方指导文件**明确排除绿色电力证书抵扣电力间接排放**，只认可'
        + '"物理直连（direct line）"与"签订电力购买协议（PPA）"两种方式。',
      implication: '这意味着中国企业无法靠购买绿证来降低出口产品的电力间接排放——'
        + '**必须拿出"电从哪来、用了多少、如何计量"的可核查证据链**。'
        + '这正是本平台"工业源端感知（设备 DID + 边缘签名 + 物理报文）"要解决的核心问题，'
        + '也是相对纯软件碳管理平台的**不可替代性**所在。',
    },
  ];

  /* ================================================================
   * 8. IPCC 不确定度参数（供蒙特卡洛不确定度传播使用）
   * ================================================================ */
  const uncertainty = {
    standard: 'IPCC 2006 Guidelines Volume 1 Chapter 3（不确定度）与 Volume 2（能源）缺省区间',
    cite: 'IPCC-2006-V2',
    traceLevel: 'A',
    /** 各输入项的相对标准不确定度（1σ，相对值） */
    parameters: [
      { id: 'AD', cn: '活动数据（能源消耗量 / 电量计量）', symbol: 'AD', sigmaRel: 0.030, dist: 'normal', basis: '计量器具精度等级（电能表 0.5S 级 / 流量计 1.0 级）+ 数据完整性', note: '平台按设备计量精度与在线率动态调整' },
      { id: 'NCV', cn: '平均低位发热量', symbol: 'NCV', sigmaRel: 0.050, dist: 'normal', basis: 'IPCC 缺省值不确定度上限 ±5%（煤炭品种波动最大）', note: '若采用入厂煤化验实测值，可降至 ±2%' },
      { id: 'CC', cn: '单位热值含碳量', symbol: 'CC', sigmaRel: 0.050, dist: 'normal', basis: 'IPCC 缺省值 ±5%', note: '实测元素碳可降至 ±2%' },
      { id: 'OF', cn: '碳氧化率', symbol: 'OF', sigmaRel: 0.020, dist: 'normal', basis: 'IPCC 缺省实际排放中碳氧化率接近 1，多为未完全燃烧损失导致的小幅偏差', note: '连续运行的工业窑炉取 ±2%' },
      { id: 'EF_ELEC', cn: '电网排放因子', symbol: 'EF_elec', sigmaRel: 0.020, dist: 'normal', basis: '法规单值发布，年度更新；此处计入"年度间漂移 + 区域差异"的等效不确定度', note: '若需要更严谨，应改用区域实际供电结构动态因子' },
      { id: 'GWP', cn: 'GWP 值（非 CO₂ 气体折算）', symbol: 'GWP', sigmaRel: 0.010, dist: 'normal', basis: 'AR6 给出不确定度区间（CH₄ ±11、N₂O ±130 绝对值），折算为相对值', note: 'CO₂ 占主导时影响很小' },
    ],
    /** IPCC 给出的简化合成方法：相对合成不确定度 = sqrt(Σ(各分量相对不确定度)²) */
    combining: {
      formula: 'U_combined = sqrt( Σ (U_i)² )',
      basis: 'IPCC 2006 Guidelines Vol.1 Ch.3 Eq.3.1（误差传播 / 平方和开方）',
      note: '当各分量相互独立时，合成相对不确定度为各分量相对不确定度的平方和开方。'
        + '本平台同时提供该解析解与 **蒙特卡洛抽样**（10000 次）两种算法，两者结果应相互印证——'
        + '解析解验证抽样的正确性，抽样给出分布形状与置信区间（解析解只能给单一数值）。',
    },
    /** 数据质量分级（对应 IPCC 的 Tier 概念） */
    tiers: [
      { tier: 'Tier 1', cn: '缺省法', inputs: '活动数据 + 缺省排放因子', accuracy: '相对不确定度 ±5%~±15%', note: '本平台默认档位' },
      { tier: 'Tier 2', cn: '本国/区域特定因子', inputs: '活动数据 + 国别实测因子', accuracy: '±3%~±8%', note: '接入 CEMS 实测后可达' },
      { tier: 'Tier 3', cn: '连续在线监测（CEMS）', inputs: '烟气流量 + 浓度连续测量', accuracy: '±2%~±5%（视工况）', note: '本平台 CEMS 设备已支持，可作为"实测增强"档' },
    ],
  };

  /* ================================================================
   * 9. 工具函数
   * ================================================================ */

  /** 取全国层面电力因子 */
  function powerFactor(kind) {
    const k = String(kind || 'national');
    if (k === 'powerCo2') return powerFactors.powerCo2;
    if (k === 'footprint') return powerFactors.footprint;
    return powerFactors.national;
  }

  /** 取某区域电网基准线因子与风电/光伏基准线 α */
  function gridBaseline(regionCode) {
    const gb = powerFactors.gridBaseline;
    const r = gb.regions.find((x) => x.code === regionCode) || gb.regions[0];
    const a = gb.alphaRule.windPv;
    const alphaWindPv = Math.round((a.om * r.om + a.bm * r.bm) * 1e6) / 1e6;
    const b = gb.alphaRule.other;
    const alphaOther = Math.round((b.om * r.om + b.bm * r.bm) * 1e6) / 1e6;
    return { ...r, alphaWindPv, alphaOther, year: gb.year, cite: gb.cite };
  }

  /** 取某市场碳价 */
  function priceOf(marketCode) {
    const m = carbonPrice.markets.find((x) => x.code === marketCode);
    return m || null;
  }

  /** 按燃料编码取因子 */
  function fuelFactor(code) {
    return fuelFactors.find((f) => f.code === code) || null;
  }

  /** 台账统计（供页面展示"数据可追溯率"） */
  function stats() {
    const allItems = [
      ...powerFactors.history.map((h) => ({ traceLevel: 'A' })),
      powerFactors.national, powerFactors.powerCo2, powerFactors.footprint,
      ...powerFactors.gridBaseline.regions.map((r) => ({ traceLevel: 'A' })),
      ...fuelFactors, ...gwps.values, ...carbonPrice.markets,
      ...standards, ...policies, ...internationalRules, ...uncertainty.parameters,
    ];
    const byLevel = { A: 0, B: 0, C: 0 };
    allItems.forEach((i) => { const l = i.traceLevel || 'B'; byLevel[l] = (byLevel[l] || 0) + 1; });
    const total = allItems.length;
    return {
      total,
      byLevel,
      traceabilityPct: Math.round(((byLevel.A + byLevel.B) / total) * 1000) / 10,
      citations: citations.length,
      standards: standards.length,
      policies: policies.length + 1, // 含《碳排放权交易管理暂行条例》
      internationalRules: internationalRules.length,
      fuelFactors: fuelFactors.filter((f) => f.traceLevel !== 'C').length,
      verifiedFuelFactors: verifyFuelFactors().rows.length,
    };
  }

  /* ================================================================
   * 导出
   * ================================================================ */
  const Sources = {
    meta,
    citations,
    cite,
    citeMap,
    POWER_SCOPES,
    powerFactors,
    fuelFactors,
    C_TO_CO2,
    computeEf,
    verifyFuelFactors,
    gwps,
    carbonPrice,
    standards,
    policies,
    internationalRules,
    uncertainty,
    powerFactor,
    gridBaseline,
    priceOf,
    fuelFactor,
    stats,
  };

  global.App = global.App || {};
  global.App.Sources = Sources;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sources;
})(typeof window !== 'undefined' ? window : globalThis);
