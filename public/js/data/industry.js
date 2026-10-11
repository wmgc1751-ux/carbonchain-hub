/* =====================================================================
   碳链通 CarbonChain Hub —— 工业场景模拟数据域（IIoT / 双碳核算 / 联盟链）
   ---------------------------------------------------------------------
   本文件为**前端数据集**，与后端真实接口配合使用：
     · 设备 DID、TEE/SE 安全状态、物料平衡校验  —— 边缘侧感知域
     · 电网排放因子预言机、双轨核算标准、工序级 BOM —— 核算域
     · 联盟链节点共识拓扑                        —— 治理域
     · 批次存证记录、产品数字护照 DPP、穿透式验真链条 —— 交付域
   所有哈希、报文、指纹均按真实格式构造（SHA-256 长十六进制 / 国密 SM2 公钥指纹 /
   HJ212-2017 报文头），数值采用确定性伪随机生成，保证每次打开一致、可复现、
   可被答辩提问逐条追溯。企业 id 与 db/02_seed_data.sql 中 enterprise 表保持一致。
   ===================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------
   * 确定性伪随机（mulberry32）—— 让"看起来随机"的数值可复现
   * ------------------------------------------------------------------ */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** 生成 64 位小写十六进制哈希 */
  function hex64(r) {
    let s = '';
    for (let i = 0; i < 64; i++) s += '0123456789abcdef'[(r() * 16) | 0];
    return s;
  }
  /** 生成 SM2 公钥指纹（ECDSA/SM2 压缩公钥风格：04 + 128 hex） */
  function sm2Pub(r) {
    let s = '04';
    for (let i = 0; i < 128; i++) s += '0123456789abcdef'[(r() * 16) | 0];
    return s;
  }
  /** 生成原始报文十六进制串（物理层报文） */
  function rawFrame(r, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += '0123456789ABCDEF'[(r() * 16) | 0];
    return s;
  }

  /* ------------------------------------------------------------------
   * 一、控排企业档案（与 enterprise 表 id 对齐）
   * ------------------------------------------------------------------ */
  const ENTERPRISES = {
    1: { id: 1, name: '邢台纸业有限公司', short: '邢台纸业', industry: '造纸', region: '河北省邢台市', scale: '小型' },
    2: { id: 2, name: '太原钢联股份有限公司', short: '太原钢联', industry: '钢铁', region: '山西省太原市', scale: '大型' },
    3: { id: 3, name: '长沙铜业集团有限公司', short: '长沙铜业', industry: '铜冶炼', region: '湖南省长沙市', scale: '大型' },
    12: { id: 12, name: '三明化学工业有限公司', short: '三明化学', industry: '化工', region: '福建省三明市', scale: '中型' },
    60: { id: 60, name: '芜湖有色金属有限公司', short: '芜湖有色', industry: '有色金属', region: '安徽省芜湖市', scale: '中型' },
  };

  /* ------------------------------------------------------------------
   * 二、边缘采集设备清单（含 DID / 协议 / 安全芯片 / 物料平衡）
   * ------------------------------------------------------------------ */
  const CHIP_CN = { TEE: '可信执行环境 TEE', SE: '安全芯片 SE' };
  const KINDS = {
    GATEWAY: { cn: '工业边缘网关', icon: 'layers' },
    METER: { cn: '智能电表', icon: 'db' },
    GAS: { cn: '天然气计量表', icon: 'fire' },
    STEAM: { cn: '蒸汽流量计', icon: 'target' },
    CEMS: { cn: 'CEMS 烟气分析仪', icon: 'globe' },
    SCALE: { cn: '物料皮带秤', icon: 'layers' },
  };

  function buildDevices() {
    const spec = [
      // entId, did, kind, name, site, protocol, chip, alg, fw, sampleStep(分钟), 信号强度
      [2, 'did:iot:gateway:01', 'GATEWAY', '工业边缘网关（主）', '太原钢联 · 1# 高炉主控楼', 'OPC-UA / MQTT-TLS', 'TEE', 'SM2+SM4', 'v2.7.3', 1],
      [2, 'did:meter:power:07', 'METER', '智能电表 · 高炉鼓风机组', '太原钢联 · 1# 高炉配电室', 'DL/T 645-2007', 'SE', 'SM4', 'v1.9.2', 15],
      [2, 'did:meter:gas:11', 'GAS', '天然气计量表 · 热风炉', '太原钢联 · 热风炉燃气调压站', 'Modbus-TCP', 'SE', 'SM4', 'v1.4.8', 15],
      [2, 'did:sensor:cems:04', 'CEMS', 'CEMS 烟气分析仪 · 烧结机头', '太原钢联 · 烧结机头排口', 'HJ 212-2017', 'TEE', 'SM2+SM4', 'v3.1.0', 5],
      [1, 'did:iot:gateway:02', 'GATEWAY', '工业边缘网关（备）', '邢台纸业 · 造纸车间集控室', 'OPC-UA / MQTT-TLS', 'TEE', 'SM2+SM4', 'v2.7.3', 1],
      [1, 'did:meter:power:01', 'METER', '智能电表 · 1# 生产线总进线', '邢台纸业 · 1# 生产线配电间', 'Modbus-TCP', 'SE', 'SM4', 'v1.9.2', 15],
      [1, 'did:meter:steam:05', 'STEAM', '蒸汽流量计 · 蒸汽母管', '邢台纸业 · 蒸汽计量间', 'HART / 4-20mA', 'SE', 'SM4', 'v2.0.5', 10],
      [1, 'did:sensor:flow:15', 'SCALE', '物料皮带秤 · 废纸浆投料', '邢台纸业 · 制浆车间', 'RS-485 / Modbus-RTU', 'SE', 'SM4', 'v1.2.1', 20],
      [3, 'did:iot:gateway:03', 'GATEWAY', '工业边缘网关（主）', '长沙铜业 · 闪速熔炼集控站', 'OPC-UA / MQTT-TLS', 'TEE', 'SM2+SM4', 'v2.7.3', 1],
      [3, 'did:meter:power:08', 'METER', '智能电表 · 电解精炼车间', '长沙铜业 · 电解车间配电室', 'DL/T 645-2007', 'SE', 'SM4', 'v1.9.2', 15],
      [3, 'did:meter:gas:12', 'GAS', '天然气计量表 · 阳极炉', '长沙铜业 · 阳极炉燃气站', 'Modbus-TCP', 'SE', 'SM4', 'v1.4.8', 15],
      [3, 'did:sensor:cems:07', 'CEMS', 'CEMS 烟气分析仪 · 焙烧炉排口', '长沙铜业 · 焙烧炉排放口', 'HJ 212-2017', 'TEE', 'SM2+SM4', 'v3.1.0', 5],
    ];
    return spec.map((s, i) => {
      const r = rng(0xC0FFEE + i * 977);
      const [entId, did, kind, name, site, protocol, chip, alg, fw, step] = s;
      const ent = ENTERPRISES[entId];
      const base = { GATEWAY: 0, METER: 0, GAS: 0, STEAM: 0, CEMS: 0, SCALE: 0 };
      /* 三类工况样例：正常 / 关注 / 异常（异常自动阻断上链） */
      const balanceSet = [
        { ratio: 99.4, status: 'NORMAL', note: '耗电工况与产量比对平衡度' },
        { ratio: 99.1, status: 'NORMAL', note: '耗电工况与产量比对平衡度' },
        { ratio: 98.7, status: 'WATCH', note: '燃气计量与热工产汽量偏差' },
        { ratio: 96.2, status: 'WATCH', note: '烟气含氧量与燃烧效率偏离' },
        { ratio: 99.6, status: 'NORMAL', note: '耗电工况与产量比对平衡度' },
        { ratio: 99.8, status: 'NORMAL', note: '耗电工况与产量比对平衡度' },
        { ratio: 97.9, status: 'WATCH', note: '蒸汽管网损与产汽量偏差' },
        { ratio: 99.3, status: 'NORMAL', note: '物料投入与产出比' },
        { ratio: 99.5, status: 'NORMAL', note: '耗电工况与产量比对平衡度' },
        { ratio: 89.6, status: 'ANOMALY', note: '电解整流效率与产量严重偏离' },
        { ratio: 99.2, status: 'NORMAL', note: '耗电工况与产量比对平衡度' },
        { ratio: 98.4, status: 'WATCH', note: '烟气含氧量与燃烧效率偏离' },
      ];
      const bal = balanceSet[i] || balanceSet[0];
      return {
        did, kind, kindCn: KINDS[kind].cn, icon: KINDS[kind].icon,
        name, site, protocol, chip, chipCn: CHIP_CN[chip], alg, fw,
        entId, entName: ent.name, entShort: ent.short, industry: ent.industry,
        sampleStepMin: step,
        online: bal.status !== 'ANOMALY',
        status: bal.status === 'ANOMALY' ? 'DEGRADED' : 'ONLINE',
        /* 边缘硬件身份 */
        hwFingerprint: hex64(r).toUpperCase().replace(/(.{8})/g, '$1 ').trim().slice(0, 47),
        pubKey: sm2Pub(r),
        /* 最近一条上报报文（物理层原始十六进制） */
        frame: rawFrame(r, 128),
        frameLen: 64,
        rptHash: hex64(r),
        rptAt: Date.now() - ((r() * 900 + 30) | 0) * 1000,
        /* 边缘 TEE / SE 签名 */
        teeSignature: '0x' + hex64(r).slice(0, 60),
        sealedAt: '2024-0' + (1 + ((r() * 8) | 0)) + '-1' + ((r() * 9) | 0),
        /* 物料平衡校验 */
        balance: { ratio: bal.ratio, status: bal.status, note: bal.note },
        /* 实时工况（视图层会在此基础上做微小脉动，模拟实时刷新） */
        live: {
          powerKwh: kind === 'METER' ? Math.round(2200 + r() * 9800) : null,
          gasNm3: kind === 'GAS' ? Math.round(560 + r() * 3400) : null,
          steamT: kind === 'STEAM' ? Math.round(38 + r() * 120) : null,
          flowTh: kind === 'SCALE' ? +(3.2 + r() * 9).toFixed(2) : null,
          o2Pct: kind === 'CEMS' ? +(4.6 + r() * 4.2).toFixed(2) : null,
          so2Mg: kind === 'CEMS' ? Math.round(8 + r() * 26) : null,
          noxMg: kind === 'CEMS' ? Math.round(46 + r() * 130) : null,
          flueTempC: kind === 'CEMS' ? Math.round(96 + r() * 66) : null,
          signal: 82 + ((r() * 17) | 0),
          latencyMs: 6 + ((r() * 26) | 0),
        },
        base: base,
      };
    });
  }

  /* ------------------------------------------------------------------
   * 三、标准排放因子库
   *    ⚠ 数据来源一律以 `App.Sources`（真实公开数据源与因子台账）为准，
   *      此处只做"取用 + 标注文号"，不再重复维护数值，避免两份数值漂移。
   *      每条因子带 `cite`（台账 citations 的 id），页面可点击追溯到发文文号。
   * ------------------------------------------------------------------ */
  const SRC = (global.App && global.App.Sources) || null;
  /** 从台账取燃料因子值（取不到时退回内置兜底值，保证离线可用） */
  function factorFromLedger(code, fallbackValue, fallbackUnit) {
    if (SRC && SRC.fuelFactor) {
      const f = SRC.fuelFactor(code);
      if (f) {
        // 台账里天然气以 万Nm³ 计，展示口径统一换算为 Nm³
        const divisor = code === 'NATURAL_GAS' ? 1e4 : 1000;
        return {
          value: Math.round((f.ef / divisor) * 10000) / 10000,
          unit: fallbackUnit,
          cite: (f.cites && f.cites[0]) || null,
          traceLevel: f.traceLevel,
        };
      }
    }
    return { value: fallbackValue, unit: fallbackUnit, cite: null, traceLevel: 'C' };
  }

  const _fNG = factorFromLedger('NATURAL_GAS', 2.1622, 'kgCO₂/Nm³');
  const _fCoal = factorFromLedger('RAW_COAL', 1.9003, 'kgCO₂/kg');
  const _fCoke = factorFromLedger('COKE', 2.8604, 'kgCO₂/kg');
  const _fDiesel = factorFromLedger('DIESEL', 3.0987, 'kgCO₂/kg');
  const _fFuelOil = factorFromLedger('FUEL_OIL', 3.1733, 'kgCO₂/kg');

  const FACTORS = {
    ELECTRICITY: {
      key: 'ELECTRICITY', cn: '外购电力', value: 0.5703, unit: 'kgCO₂/kWh', scope: '范围二',
      cite: 'MEE-2023-43', traceLevel: 'A',
      src: '生态环境部办公厅 · 全国电网平均排放因子（环办气候函〔2023〕43号，2023-02-07）',
      caveat: '这是**范围二口径**的全国电网平均排放因子，与"区域电网基准线排放因子（OM/BM）"'
        + '和"电力碳足迹因子（生命周期）"是三种不同口径，不可混用。',
    },
    NATURAL_GAS: { key: 'NATURAL_GAS', cn: '天然气', value: _fNG.value, unit: _fNG.unit, scope: '范围一', cite: _fNG.cite, traceLevel: _fNG.traceLevel, src: 'GB/T 46053-2025 附录A + 《省级温室气体清单编制指南(试行)》' },
    RAW_COAL: { key: 'RAW_COAL', cn: '原煤', value: _fCoal.value, unit: _fCoal.unit, scope: '范围一', cite: _fCoal.cite, traceLevel: _fCoal.traceLevel, src: 'GB/T 46053-2025 附录A + 《省级温室气体清单编制指南(试行)》' },
    COKE: { key: 'COKE', cn: '焦炭', value: _fCoke.value, unit: _fCoke.unit, scope: '范围一', cite: _fCoke.cite, traceLevel: _fCoke.traceLevel, src: 'GB/T 46053-2025 附录A + 《省级温室气体清单编制指南(试行)》' },
    DIESEL: { key: 'DIESEL', cn: '柴油', value: _fDiesel.value, unit: _fDiesel.unit, scope: '范围一', cite: _fDiesel.cite, traceLevel: _fDiesel.traceLevel, src: 'GB/T 46053-2025 附录A（低位发热量取自《中国能源统计年鉴2023》）' },
    FUEL_OIL: { key: 'FUEL_OIL', cn: '燃料油', value: _fFuelOil.value, unit: _fFuelOil.unit, scope: '范围一', cite: _fFuelOil.cite, traceLevel: _fFuelOil.traceLevel, src: 'GB/T 46053-2025 附录A（低位发热量取自《中国能源统计年鉴2023》）' },
    STEAM: {
      key: 'STEAM', cn: '外购热力（蒸汽折算）', value: 0.1100, unit: 'tCO₂/GJ', scope: '范围二',
      cite: null, traceLevel: 'C',
      src: '蒸汽无全国统一缺省排放因子',
      caveat: '本值为常见工程取值，属**示例值**。正式核算须采用供热单位实测值或合同约定值。',
    },
  };

  /* ------------------------------------------------------------------
   * 四、电网排放因子预言机（Oracle）—— 每小时动态同步
   *    ⚠ 口径纪律：本预言机服务的是【组织层面范围二】核算，
   *      因此基准值取"全国电网平均排放因子"。
   *      区域电网基准线因子（OM/BM）与电力碳足迹因子口径不同，
   *      单独放在 `baselineFactors` / `footprintFactor` 里，绝不与基准值混算。
   * ------------------------------------------------------------------ */
  function buildOracle() {
    const now = new Date();
    const hourMs = 3600 * 1000;
    const lastSyncHour = Math.floor(now.getTime() / hourMs) * hourMs;
    const r = rng(0x7A1E5EED);
    const BASE = 0.5703; // 全国电网平均排放因子（环办气候函〔2023〕43号）
    const series = [];
    for (let i = 23; i >= 0; i--) {
      const t = lastSyncHour - i * hourMs;
      /* 日内波动：夜间火电占比略高 → 因子略高；午间光伏大发 → 因子略低 */
      const h = new Date(t).getHours();
      const wave = Math.sin(((h - 4) / 24) * Math.PI * 2) * 0.0048;
      const noise = (r() - 0.5) * 0.0016;
      series.push({ t, factor: +(BASE + wave + noise).toFixed(4) });
    }
    // 从台账取华北区域基准线（2023 年官方发布值）
    const gb = SRC && SRC.gridBaseline ? SRC.gridBaseline('NORTH') : null;
    return {
      scope: 'GRID_AVG',
      scopeCn: '全国电网平均排放因子（组织层面范围二口径）',
      source: '生态环境部办公厅 · 全国电网平均排放因子',
      publisher: '生态环境部办公厅',
      cite: 'MEE-2023-43',
      doc: '环办气候函〔2023〕43号《关于做好2023—2025年发电行业企业温室气体排放报告管理有关工作的通知》',
      issuedAt: '2023-02-07',
      dataYear: 2022,
      traceLevel: 'A',
      baseline: BASE,              // 基准统一因子 kgCO₂/kWh
      unit: 'kgCO₂/kWh',
      intervalMs: hourMs,
      lastSync: lastSyncHour,
      nextSync: lastSyncHour + hourMs,
      series,
      /* 日内波动为**按物理机理工况建模的模拟序列**，非实测数据 —— 如实标注 */
      seriesIsSimulated: true,
      seriesNote: '小时序列按"夜间火电占比高、午间光伏大发"的物理机理建模生成（振幅约 ±0.48%），'
        + '用于演示预言机"高频同步 + 可存证"的机制；**不是从电网调度系统抓取的实测值**。'
        + '接入真实数据源时，只需替换 series 的取值，其余机制不变。',

      /* ---- 口径隔离区：以下两个因子与上面的 baseline **不同口径**，不可相加或混算 ---- */
      baselineFactors: {
        scope: 'GRID_BASELINE',
        scopeCn: '电网基准线排放因子（CCER 减排项目口径）',
        region: '华北区域电网',
        year: gb ? gb.year : 2023,
        om: gb ? gb.om : 0.9350,          // 电量边际（2019–2021 年供电量加权平均）
        bm: gb ? gb.bm : 0.3020,          // 容量边际（新增装机加权平均）
        alphaWindPv: gb ? gb.alphaWindPv : 0.77675,
        formula: 'α(风电/光伏) = 0.75 × OM + 0.25 × BM',
        cite: 'NCSC-2024-GRID-BL',
        issuedBy: '生态环境部应对气候变化司（国家气候战略中心发布）',
        issuedAt: '2024-07-08',
        traceLevel: 'A',
        usage: '**仅用于 CCER / CDM 减排项目的额外性论证与减排量核算**，'
          + '不得用于组织碳核算（范围二）或产品碳足迹。',
        correction: '本平台早期版本此处误填 OM 0.9421 / BM 0.4812（无官方出处）。'
          + '现修正为 2023 年官方发布值 OM 0.9350 / BM 0.3020，并保留本条修正记录以备核查。',
      },
      footprintFactor: {
        scope: 'POWER_FOOTPRINT',
        scopeCn: '电力碳足迹因子（产品碳足迹 PCF 口径）',
        value: 0.6205,
        unit: 'kgCO₂e/kWh',
        year: 2023,
        cite: 'MEE-2025-01-POWER',
        issuedBy: '生态环境部、国家统计局、国家能源局',
        issuedAt: '2025-01',
        traceLevel: 'A',
        usage: '用于**产品碳足迹（PCF）**中电力投入的排放核算。'
          + '数值高于电网平均排放因子，因为覆盖"燃料开采 → 发电 → 输配电"全生命周期。',
      },
      /* 小时同步记录（预言机调用链存证），oracleTx 在文件末尾统一补齐 */
      pulls: series.slice(-6).map((p) => ({ at: p.t, factor: p.factor, oracleTx: '' })),
    };
  }

  /* ------------------------------------------------------------------
   * 五、双轨核算标准
   * ------------------------------------------------------------------ */
  const STANDARDS = {
    ORG: {
      key: 'ORG',
      code: 'ISO 14064-1',
      cn: '组织碳核算',
      sub: 'Organizational GHG Accounting',
      scopes: [
        { k: '范围一', cn: '化石燃料燃烧直接排放', detail: '高炉煤气 / 焦炉煤气 / 天然气 / 柴油移动源', color: '#f5a524' },
        { k: '范围二', cn: '外购电力与热力间接排放', detail: '外购电量 × 电网排放因子 + 外购热力 × 热力缺省因子', color: '#38bdf8' },
      ],
      note: '边界为法人（或设施）层级，用于年度履约与配额清缴。',
    },
    PCF: {
      key: 'PCF',
      code: 'ISO 14067 / GHG Protocol',
      cn: '产品碳足迹',
      sub: 'Product Carbon Footprint',
      scopes: [
        { k: '原料获取', cn: '上游原辅料隐含碳', detail: '按供应商 EPD 与工艺数据库折算', color: '#a78bfa' },
        { k: '生产制造', cn: '工序级能耗与工艺排放', detail: '工序 BOM × 实测能耗 × 动态因子', color: '#10b981' },
        { k: '包装储运', cn: '包装材料与出厂运输', detail: '包装物隐含碳 + 运输距离 × 单位排放', color: '#2dd4bf' },
      ],
      note: '边界为产品单位（functional unit），用于欧盟新电池法案 / CBAM 碳关税申报。',
    },
  };

  /* ------------------------------------------------------------------
   * 六、工序级 BOM 碳分摊模板
   * ------------------------------------------------------------------ */
  const BOM_STAGES = ['原料加工', '高温冶炼 / 涂布', '组装成型', '包装'];
  const BOM_STAGE_DETAIL = [
    '原辅料破碎、球磨、制浆与预处理',
    '高炉 / 转炉 / 闪速熔炼 / 蒸煮烘干，本段占比最高',
    '热轧冷轧、电解精炼、抄造成型等物理成型工序',
    '卷取、打包、托盘与厂内物流',
  ];

  /* ------------------------------------------------------------------
   * 七、产品批次与链上存证记录
   * ------------------------------------------------------------------ */
  function buildBatches() {
    const spec = [
      // entId, 批次号, 产品, 规格, 产线, 产量, 单位, 总碳足迹 tCO2e, 设备DID, 核查机构, 区块, 状态
      [2, 'BATCH-STEEL-2026Q3-0417', '冷轧钢卷板', 'SPCC 1.0×1250mm', '2# 冷轧连续退火线', 1286.40, 't', 2184.62, 'did:sensor:cems:04', 'CQC', 'CERTIFIED', [0.286, 0.412, 0.226, 0.076]],
      [3, 'BATCH-CU-2026Q3-0212', '阴极铜', 'Cu-CATH-1 (GB/T 467)', '闪速熔炼 + 电解精炼线', 862.15, 't', 1937.44, 'did:sensor:cems:07', 'SGS', 'CERTIFIED', [0.318, 0.384, 0.221, 0.077]],
      [1, 'BATCH-PAPER-2026Q3-1188', '瓦楞原纸', '120g/m² 卷筒', '1# 造纸生产线', 4128.60, 't', 1263.31, 'did:meter:steam:05', 'CQC', 'CERTIFIED', [0.342, 0.398, 0.184, 0.076]],
      [2, 'BATCH-STEEL-2026Q3-0418', '热轧酸洗卷板', 'Q235B 3.0×1500mm', '1# 热轧带钢线', 2041.88, 't', 3312.07, 'did:meter:gas:11', 'CQC', 'PENDING', [0.301, 0.431, 0.201, 0.067]],
      [12, 'BATCH-CHEM-2026Q3-0903', '工业级碳酸二甲酯', '≥99.5% 优等品', '酯交换法联合装置', 596.32, 't', 1489.77, 'did:sensor:cems:11', 'SGS', 'CERTIFIED', [0.364, 0.372, 0.191, 0.073]],
      [60, 'BATCH-NFM-2026Q3-0455', '高纯阴极铜杆', 'φ8mm 光亮铜杆', '上引连铸连轧线', 1104.05, 't', 1658.90, 'did:meter:power:21', 'CQC', 'BLOCKED', [0.305, 0.401, 0.217, 0.077]],
    ];
    const VERIFIERS = {
      CQC: { name: '中国质量认证中心（CQC）', node: 'node-cqc-01', pub: '04b8f2c1e7a94d05', cert: 'CNCA-C8225-100238' },
      SGS: { name: 'SGS 通标标准技术服务有限公司', node: 'node-sgs-01', pub: '04c91ad73f5e2b68', cert: 'CNCA-C9346-778193' },
    };
    const heights = [287, 264, 251, 308, 233, 296];
    return spec.map((s, i) => {
      const r = rng(0xBADC0DE + i * 1543);
      const [entId, batchNo, product, specText, line, qty, unit, totalTco2e, deviceDid, verKey, status, bomShare] = s;
      const ent = ENTERPRISES[entId];
      const ver = VERIFIERS[verKey];
      const stages = BOM_STAGES.map((name, k) => ({
        name, detail: BOM_STAGE_DETAIL[k],
        share: bomShare[k],
        tco2e: +(totalTco2e * bomShare[k]).toFixed(2),
        intensity: +((totalTco2e * bomShare[k]) / qty).toFixed(4),
      }));
      /* 范围一占比：钢铁 / 铜冶炼 / 造纸 / 化工 / 有色加工各有差异，取 36%~45% 区间 */
      const scope1Value = totalTco2e * (0.36 + r() * 0.09);
      return {
        seq: i + 1,
        batchNo, product, spec: specText, line, qty, unit,
        entId, entName: ent.name, entShort: ent.short, industry: ent.industry, region: ent.region,
        totalTco2e,
        /* 范围拆分：范围一（直接燃烧）+ 范围二（外购电热）。
         * 说明：产品碳足迹（PCF）的核算边界只含范围一 + 范围二（GB/T 24067-2024 /
         * ISO 14067 的 cradle-to-gate 口径下，上游原辅料以内置因子形式计入各工序，
         * 不单列范围三）。因此 scope2 由总碳足迹减去范围一取补，保证
         * totalTco2e === scope1 + scope2 恒成立，避免出现合不上的"幽灵碳"。 */
        scope1: +scope1Value.toFixed(2),
        scope2: +(totalTco2e - scope1Value).toFixed(2),
        intensity: +(totalTco2e / qty).toFixed(4),
        deviceDid,
        device: null, // 视图层按 did 关联设备详情
        txHash: hex64(r),
        blockHeight: heights[i],
        blockHash: hex64(rng(0xA11CE + i)),
        payloadHash: hex64(rng(0xF00D + i)),
        consensusAt: Date.now() - (i * 37 + 12) * 3600 * 1000,
        /* 共识节点：企业自建 + 核查机构 + 主管部门 */
        consensusNodes: [
          'node-ent-' + String(entId).padStart(3, '0'),
          ver.node,
          'node-gov-' + (ent.region.slice(0, 2)),
        ],
        /* 第三方核查公钥指纹 */
        verifierName: ver.name,
        verifierNode: ver.node,
        verifierPub: ver.pub + hex64(r).slice(0, 8),
        verifierCert: ver.cert,
        signature: '0x' + hex64(r).slice(0, 64),
        /* DPP 护照编号 */
        dppNo: 'DPP-CN-' + batchNo.replace(/^BATCH-/, '').replace(/-/g, '') + '-' + String(entId).padStart(3, '0'),
        /* 状态：CERTIFIED 已核证 / PENDING 待核证 / BLOCKED 物料平衡异常·阻断上链 */
        status,
        bom: { total: totalTco2e, stages },
      };
    });
  }

  /* ------------------------------------------------------------------
   * 八、联盟链节点网络共识拓扑（四类参与方）
   * ------------------------------------------------------------------ */
  const NODE_ROLES = {
    ENTERPRISE: { cn: '企业自建节点', cls: 'ent', icon: 'factory', desc: '排碳企业自持节点，负责本厂源端数据上链与副本持有' },
    VERIFIER: { cn: '第三方核查机构节点', cls: 'ver', icon: 'verify', desc: '中国质量认证中心 / SGS 等权威核查机构节点，独立复核并背书' },
    REGULATOR: { cn: '生态环境主管部门节点', cls: 'gov', icon: 'shield', desc: '省 / 市级生态环境主管部门节点，实现监管穿透式读取' },
    BANK: { cn: '绿色金融银行节点', cls: 'bank', icon: 'bank', desc: '绿色信贷与碳资产质押授信银行节点，读取链上可信碳资产' },
  };

  function buildTopology() {
    const heights = [313, 313, 313, 312, 313, 313, 313, 311, 313, 313];
    const spec = [
      ['node-ent-002', '太原钢联集团节点', 'ENTERPRISE', 1, 3, 1826, 41],
      ['node-ent-001', '邢台纸业节点', 'ENTERPRISE', 1, 3, 1294, 38],
      ['node-ent-003', '长沙铜业节点', 'ENTERPRISE', 1, 3, 1105, 44],
      ['node-cqc-01', '中国质量认证中心（CQC）节点', 'VERIFIER', 1, 2, 742, 22],
      ['node-sgs-01', 'SGS 通标标准技术服务节点', 'VERIFIER', 1, 2, 688, 26],
      ['node-gov-山西', '山西省生态环境厅节点', 'REGULATOR', 1, 2, 961, 18],
      ['node-gov-湖南', '湖南省生态环境厅节点', 'REGULATOR', 1, 2, 604, 21],
      ['node-bank-兴业', '兴业银行绿色金融节点', 'BANK', 1, 1, 318, 34],
      ['node-bank-工行', '中国工商银行碳金融节点', 'BANK', 1, 1, 286, 31],
      ['node-bank-招商', '招商银行碳资产质押节点', 'BANK', 0, 0, 0, 52],
    ];
    return spec.map((s, i) => {
      const r = rng(0x3EDE + i * 77);
      const [id, name, role, authorized, weight, proposed, latency] = s;
      const h = heights[i];
      return {
        id, name, role, roleCn: NODE_ROLES[role].cn, roleCls: NODE_ROLES[role].cls, icon: NODE_ROLES[role].icon,
        authorized: !!authorized, weight, proposed,
        height: h, mainHeight: 313, lag: 313 - h,
        consistent: h === 313,
        latencyMs: latency,
        wallet: '0x' + hex64(r).slice(0, 40),
        pubKeyFp: (role === 'VERIFIER' ? '04' : '0x') + hex64(r).slice(0, 16),
        joinAt: '202' + (2 + ((r() * 3) | 0)) + '-0' + (1 + ((r() * 9) | 0)) + '-1' + ((r() * 9) | 0),
        status: authorized ? 'ACTIVE' : 'PENDING',
        uplinkMbps: +(6.2 + r() * 94).toFixed(1),
        peers: 4 + ((r() * 6) | 0),
      };
    });
  }

  /* ------------------------------------------------------------------
   * 九、工业物料与能耗结构（原辅料 / 燃料）
   * ------------------------------------------------------------------ */
  const MATERIALS = [
    { key: '电力', unit: 'MWh', factor: 'ELECTRICITY', per: 0.5703, kind: 'energy' },
    { key: '天然气', unit: 'Nm³', factor: 'NATURAL_GAS', per: 2.1622, kind: 'energy' },
    { key: '原煤', unit: 't', factor: 'RAW_COAL', per: 1900.3, kind: 'energy' },
    { key: '焦炭', unit: 't', factor: 'COKE', per: 2860.4, kind: 'energy' },
    { key: '蒸汽（外购热力）', unit: 'GJ', factor: 'STEAM', per: 110.0, kind: 'energy' },
    { key: '铁矿石 / 铜精矿', unit: 't', factor: null, per: 46.8, kind: 'material' },
    { key: '废纸浆 / 再生纤维', unit: 't', factor: null, per: 12.4, kind: 'material' },
    { key: '石灰石 / 熔剂', unit: 't', factor: null, per: 22.1, kind: 'material' },
  ];

  /* ------------------------------------------------------------------
   * 十、对外接口
   * ------------------------------------------------------------------ */
  const devices = buildDevices();
  const batches = buildBatches();
  const batchByDevice = {};
  batches.forEach((b) => { (batchByDevice[b.deviceDid] = batchByDevice[b.deviceDid] || []).push(b); });
  batches.forEach((b) => { b.device = devices.find((d) => d.did === b.deviceDid) || null; });

  const Industry = {
    ENTERPRISES,
    KINDS,
    CHIP_CN,
    FACTORS,
    MATERIALS,
    STANDARDS,
    BOM_STAGES,
    BOM_STAGE_DETAIL,
    NODE_ROLES,
    devices,
    batches,
    topology: buildTopology(),
    oracle: buildOracle(),
    /* 工具：按企业过滤 */
    devicesOf(entId) { return entId ? devices.filter((d) => d.entId === Number(entId)) : devices; },
    batchesOf(entId) { return entId ? batches.filter((b) => b.entId === Number(entId)) : batches; },
    deviceOf(did) { return devices.find((d) => d.did === did) || null; },
    /* 工具：物料平衡汇总（按企业） */
    balanceOf(entId) {
      const list = Industry.devicesOf(entId);
      if (!list.length) return null;
      const worst = list.reduce((a, b) => (b.balance.ratio < a.balance.ratio ? b : a));
      const avg = list.reduce((s, d) => s + d.balance.ratio, 0) / list.length;
      return {
        ratio: +avg.toFixed(1),
        worstRatio: worst.balance.ratio,
        status: list.some((d) => d.balance.status === 'ANOMALY') ? 'ANOMALY'
          : list.some((d) => d.balance.status === 'WATCH') ? 'WATCH' : 'NORMAL',
        worstDevice: worst,
        items: list.map((d) => ({ did: d.did, name: d.name, ratio: d.balance.ratio, status: d.balance.status, note: d.balance.note })),
      };
    },
    /* 工具：批次 BOM 条形图数据 */
    bomBars(batch) {
      return batch.bom.stages.map((s) => ({ name: s.name, value: s.tco2e, share: s.share }));
    },
    /* 工具：生成防伪二维码的点阵（纯前端，无外部依赖）
       用 SHA-256 派生的确定性位图，配合定位角标视觉上等同 QR，用于 DPP 卡片展示。 */
    qrMatrix(text, n) {
      const size = n || 29;
      const seed = hashSeed(text);
      const r = rng(seed);
      const m = [];
      for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) row.push(r() > 0.5 ? 1 : 0);
        m.push(row);
      }
      /* 三个定位角标 */
      const finder = (ox, oy) => {
        for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
          const on = (x === 0 || x === 6 || y === 0 || y === 6) || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
          m[oy + y][ox + x] = on ? 1 : 0;
        }
      };
      finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
      /* 静默区外圈清空 */
      for (let i = 0; i < 8; i++) { m[7][i] = 0; m[i][7] = 0; m[size - 8][i] = 0; m[i][size - 8] = 0; }
      return m;
    },
    /* 工具：穿透式验真流水线（四段） */
    tracePipeline(batch) {
      const dev = batch.device || {};
      const r = hashSeed(batch.txHash);
      const rr = rng(r);
      return [
        {
          key: '物理电表采集', stage: '①', icon: 'db',
          ok: true,
          title: '物理源端计量采集',
          sub: (dev.protocol || 'DL/T 645-2007') + ' · 采集步长 ' + (dev.sampleStepMin || 15) + ' 分钟',
          detail: [
            { k: '设备 DID', v: batch.deviceDid },
            { k: '设备名称', v: (dev.name || '智能电表') },
            { k: '硬件指纹', v: (dev.hwFingerprint || '-') },
            { k: '报文长度', v: (dev.frameLen || 96) + ' 字节' },
          ],
          frame: dev.frame || '-',
        },
        {
          key: '边缘 TEE 国密签名', stage: '②', icon: 'lock',
          ok: true,
          title: (dev.chipCn || '可信执行环境 TEE') + ' · 国密签名已固化',
          sub: '算法 ' + (dev.alg || 'SM2+SM4') + ' · 签名后报文物理哈希防篡改',
          detail: [
            { k: '安全芯片', v: (dev.chipCn || 'TEE') + '（边缘硬件签名已固化）' },
            { k: '签名算法', v: (dev.alg || 'SM2+SM4') },
            { k: '设备公钥', v: (dev.pubKey || '-').slice(0, 40) + '…' },
            { k: '签名值', v: (dev.teeSignature || '-').slice(0, 40) + '…' },
          ],
          frame: (dev.teeSignature || '') + '\n' + (dev.rptHash || ''),
        },
        {
          key: '合约动态核算', stage: '③', icon: 'leaf',
          ok: true,
          title: '动态因子 × 工序 BOM 自动折算',
          sub: '算式：Σ(活动数据 × 排放因子) · 因子由预言机每小时同步',
          detail: [
            { k: '核算标准', v: 'ISO 14064-1 / ISO 14067' },
            { k: '电网因子', v: Industry.oracle.baseline + ' ' + Industry.oracle.unit },
            { k: '批次碳足迹', v: batch.totalTco2e + ' tCO₂e' },
            { k: '单位强度', v: batch.intensity + ' tCO₂e/' + batch.unit },
          ],
          frame: 'keccak(' + (batch.payloadHash || '').slice(0, 32) + '…) = ' + (batch.txHash || '').slice(0, 32) + '…',
        },
        {
          key: '多节点共识上链', stage: '④', icon: 'chain',
          ok: batch.status !== 'BLOCKED',
          title: '『' + (batch.consensusNodes || []).length + ' 节点』PoA 共识出块 · 已写入区块链',
          sub: '区块高度 #' + batch.blockHeight + ' · 共识时间 ' + fmtTime(batch.consensusAt),
          detail: [
            { k: '交易哈希 TxHash', v: batch.txHash },
            { k: '区块高度', v: '#' + batch.blockHeight },
            { k: '共识节点', v: (batch.consensusNodes || []).join('、') },
            { k: '第三方核查公钥', v: batch.verifierName + ' · ' + batch.verifierPub.slice(0, 24) + '…' },
          ],
          frame: 'TxHash ' + (batch.txHash || '') + '\nBlockHash ' + (batch.blockHash || '') + '\nSignature ' + (batch.signature || ''),
        },
      ].map((s) => Object.assign(s, { entropy: rr() }));
    },
  };

  /* ------------------------------------------------------------------
   * 辅助
   * ------------------------------------------------------------------ */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function fmtTime(t) {
    const d = new Date(t);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* 内联 sm2Pub 依赖 rng，此处补齐 oracle.pulls 的 oracleTx（避免空串） */
  Industry.oracle.pulls = Industry.oracle.pulls.map((p, i) => {
    const r = rng(0x5EED + i * 31);
    return { at: p.at, factor: p.factor, oracleTx: '0x' + hex64(r).slice(0, 40) };
  });

  global.App = global.App || {};
  global.App.Industry = Industry;
})(window);
