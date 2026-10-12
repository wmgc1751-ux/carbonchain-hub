/* =====================================================================
   contractAccounting.js —— 链上核算预览（CarbonAccounting.sol 定点镜像）
   ---------------------------------------------------------------------
   存在意义：消除「界面数字」与「链上存证数字」之间的口径漂移。
   本模块把链上合约 CarbonAccounting.sol 的定点核算内核 1:1 复刻到浏览器，
   使前端预览值与链上 previewEmission / calculateAndRecordEmission 的返回值
   **逐位一致**（BigInt 精确整数运算，无浮点中间量）。

   唯一事实来源链（SSOT chain）：
        App.Sources 因子台账（数值 + 文号，可追溯）
              ↓ 1e6 定点化
        本模块 App.ContractAccounting.preview()      ← 界面预览（与链同算法）
              ↓ 同参数、同标度
        链上 CarbonAccounting.previewEmission()      ← 存证（最终权威）

   定点口径（与合约头部「定点数约定」严格一致，切勿单方改动）：
        FACTOR_BASE = 1e6，**所有输入与输出统一 1e6 标度**
          fuelUsage / powerUsage / outputVolume          : 1e6 定点
          ncv / cc / oxidationRate / gridEmissionFactor  : 1e6 定点（各自独立标度）
          输出 totalEmission / intensity                  : 1e6 定点

        E_燃烧  = (fuelUsage × ncv × cc × OF × 44) / (12 × FACTOR_BASE³)
        E_电力  = (powerUsage × gridEmissionFactor) / FACTOR_BASE
        E_total = E_燃烧 + E_电力
        强度    = (E_total × FACTOR_BASE) / outputVolume

        ⚠ 除数为 **12 × FACTOR_BASE³**（= 12e18）。需求原始写法 12 × FACTOR_BASE
          漏计了 ncv / cc / OF 三个因子各自的 1e6 标度，会使 E_燃烧 整体放大
          1e12 倍。该回归已由 runSelfTest() 固化，勿回退。

   整数语义：与 EVM 一致 —— 定点入参须为整数；除法一律**向下截断**（非四舍五入）。
   ===================================================================== */
(function (global) {
  'use strict';

  /* ================================================================
   * 1. 定点常量（与 Solidity 合约同名同值）
   * ================================================================ */
  const FACTOR_BASE = 1000000n;                                  // 1e6
  const INTENSITY_BASE = FACTOR_BASE;                            // 1e6
  const CO2_C_NUM = 44n;                                         // CO2 相对分子质量
  const CO2_C_DEN = 12n;                                         // C  相对原子质量
  const COMBUSTION_DIVISOR = CO2_C_DEN * FACTOR_BASE ** 3n;      // 12 × 1e18

  /** 与合约自定义错误同名，便于前端做错误分派 */
  const ERR = {
    InvalidInput: 'InvalidInput',                 // 产量为 0，或燃料/电力同时为 0
    InvalidFactors: 'InvalidFactors',             // 因子零值，或碳氧化率超出 (0,1]
    DuplicateBatch: 'DuplicateBatch',             // 同一 batchId 重复上链
    BatchNotFound: 'BatchNotFound',               // 批次不存在
    Unauthorized: 'AccessControlUnauthorizedAccount', // 调用者非 GATEWAY_ROLE
  };

  /* ================================================================
   * 2. 定点换算工具
   * ================================================================ */

  /** 容错转 BigInt（接受 number / string / bigint） */
  function big(v) {
    if (typeof v === 'bigint') return v;
    if (v === null || v === undefined) return 0n;
    return BigInt(typeof v === 'string' ? v.trim() : Math.round(Number(v)));
  }

  /** 物理量 → 1e6 定点（入链前必经步骤；网关侧亦应如此）。
   *  注：入链标度化允许四舍五入，链上运算与输出则严格截断。 */
  function toF6(x) {
    if (typeof x === 'bigint') return x;
    const n = Number(x);
    if (!isFinite(n)) throw new Error(ERR.InvalidInput);
    return BigInt(Math.round(n * 1e6));
  }

  /** 1e6 定点 → 物理量（Number，用于展示；大数请用 f6 字符串形式） */
  function fromF6(v) {
    return Number(big(v)) / 1e6;
  }

  /** 1e6 定点 → 物理量字符串（截断到 d 位小数，不做进位，保持与链上截断语义同观感） */
  function f6(v, d) {
    const dd = d === undefined ? 6 : d;
    const s = big(v);
    const neg = s < 0n;
    const a = neg ? -s : s;
    const int = a / FACTOR_BASE;
    const frac = (a % FACTOR_BASE).toString().padStart(6, '0').slice(0, dd);
    return (neg ? '-' : '') + int.toString() + (dd > 0 ? '.' + frac : '');
  }

  /** 分组千分位（定点整数原值展示用） */
  function group(v) {
    return big(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ================================================================
   * 3. 核算内核（与合约 _compute 逐位等价）
   * ================================================================ */

  /**
   * 链上口径核算 —— 入参**全部为 1e6 定点整数**，返回**全部为 BigInt**。
   * 与 CarbonAccounting.calculateAndRecordEmission / previewEmission 同算法。
   *
   * @param {object} p
   * @param {bigint|number|string} p.fuelUsage           燃料活动数据（1e6 定点）
   * @param {bigint|number|string} p.powerUsage          净购入电量（1e6 定点）
   * @param {bigint|number|string} p.outputVolume        批次产出量（1e6 定点，> 0）
   * @param {bigint|number|string} p.ncv                 低位发热量（1e6 定点）
   * @param {bigint|number|string} p.cc                  单位热值含碳量（1e6 定点）
   * @param {bigint|number|string} p.oxidationRate       碳氧化率 OF（1e6 定点）
   * @param {bigint|number|string} p.gridEmissionFactor  电网平均排放因子（1e6 定点）
   * @returns {{fuelEmission:bigint, powerEmission:bigint, totalEmission:bigint, intensity:bigint}}
   * @throws {Error} ERR.InvalidInput —— 与链上回滚条件一致
   */
  function previewEmission(p) {
    const fuelUsage = big(p.fuelUsage);
    const powerUsage = big(p.powerUsage);
    const outputVolume = big(p.outputVolume);
    const ncv = big(p.ncv);
    const cc = big(p.cc);
    const of = big(p.oxidationRate);
    const grid = big(p.gridEmissionFactor);

    /* 与合约 onlyRole 之外的入参校验一致：
       · 产量为零 → 强度分母为零，不可核算
       · 燃料与电力同时为零 → 该批次无核算意义
       注意前端不做角色校验（链上由 GATEWAY_ROLE 强制）。 */
    if (outputVolume === 0n || (fuelUsage === 0n && powerUsage === 0n)) {
      throw new Error(ERR.InvalidInput);
    }

    // E_燃烧 = (fuelUsage × ncv × cc × OF × 44) / (12 × FACTOR_BASE³)
    const fuelEmission =
      (fuelUsage * ncv * cc * of * CO2_C_NUM) / COMBUSTION_DIVISOR;

    // E_电力 = (powerUsage × gridEmissionFactor) / FACTOR_BASE
    const powerEmission = (powerUsage * grid) / FACTOR_BASE;

    // E_total = E_燃烧 + E_电力
    const totalEmission = fuelEmission + powerEmission;

    // 单位产品碳强度（LCA）= (E_total × FACTOR_BASE) / outputVolume
    const intensity = (totalEmission * INTENSITY_BASE) / outputVolume;

    return { fuelEmission, powerEmission, totalEmission, intensity };
  }

  /**
   * 便捷预览 —— 入参为**物理量**（t / 万Nm³ / MWh），内部定点化后调用内核。
   * @param {object} o
   * @param {number} o.fuelAmount            燃料活动数据（物理量，单位随 fuelUnit）
   * @param {number} o.powerMwh              净购入电量（MWh）
   * @param {number} o.output                批次产出量（t 或产品单位）
   * @param {number} o.ncv                   低位发热量（物理量）
   * @param {number} o.cc                    单位热值含碳量（物理量）
   * @param {number} o.oxidationRate         碳氧化率（物理量，0~1）
   * @param {number} o.gridEmissionFactor    电网因子（tCO₂/MWh）
   */
  function preview(o) {
    const fixed = previewEmission({
      fuelUsage: toF6(o.fuelAmount),
      powerUsage: toF6(o.powerMwh),
      outputVolume: toF6(o.output),
      ncv: toF6(o.ncv),
      cc: toF6(o.cc),
      oxidationRate: toF6(o.oxidationRate),
      gridEmissionFactor: toF6(o.gridEmissionFactor),
    });
    return {
      fixed,
      physical: {
        fuelEmission: fromF6(fixed.fuelEmission),
        powerEmission: fromF6(fixed.powerEmission),
        totalEmission: fromF6(fixed.totalEmission),
        intensity: fromF6(fixed.intensity),
      },
      divisor: COMBUSTION_DIVISOR,
    };
  }

  /* ================================================================
   * 4. 因子台账适配（SSOT → 定点入参）
   * ================================================================ */

  /** 取电力范围二默认电网因子（全国电网平均，环办气候函〔2023〕43号） */
  function defaultGridFactor() {
    const S = global.App && global.App.Sources;
    if (S && S.powerFactors && S.powerFactors.national) return S.powerFactors.national.value;
    return 0.5703; // 兜底，与台账同值
  }

  /**
   * 由因子台账构造**链上调用入参**（1e6 定点 BigInt）。
   * 因子一律取自 App.Sources，不在本模块写死任何数值。
   *
   * @param {object} o
   * @param {string} o.fuelCode      燃料编码（App.Sources.fuelFactors[].code）
   * @param {number} o.fuelAmount    燃料活动数据（物理量）
   * @param {number} o.powerMwh      净购入电量（MWh）
   * @param {number} o.output        批次产出量
   * @param {number} [o.gridFactor]  电网因子覆盖（默认取台账范围二口径值）
   */
  function paramsFromLedger(o) {
    const S = global.App && global.App.Sources;
    const f = S && S.fuelFactor ? S.fuelFactor(o.fuelCode) : null;
    if (!f) throw new Error(ERR.InvalidFactors);

    const grid = o.gridFactor === undefined || o.gridFactor === null
      ? defaultGridFactor()
      : Number(o.gridFactor);

    return {
      /* 合约入参（1e6 定点） */
      fuelUsage: toF6(o.fuelAmount),
      powerUsage: toF6(o.powerMwh),
      outputVolume: toF6(o.output),
      ncv: toF6(f.ncv),
      cc: toF6(f.cc),
      oxidationRate: toF6(f.of),
      gridEmissionFactor: toF6(grid),
      /* 溯源元数据（不入链，仅供界面标注） */
      meta: {
        fuelCode: f.code,
        fuelCn: f.cn,
        fuelUnit: f.unit,
        ncv: f.ncv,
        cc: f.cc,
        of: f.of,
        gridFactor: grid,
        gridUnit: 'tCO₂/MWh',
        gridCite: (S && S.powerFactors && S.powerFactors.national)
          ? S.powerFactors.national.ref : null,
        traceLevel: f.traceLevel,
        src: f.srcNote || null,
      },
    };
  }

  /* ================================================================
   * 5. batchId 生成（与《网关上报协议》第 4 节一致）
   * ================================================================ */

  /** batchId 预映像规范：固定前缀 + 版本 + 网关 DID + 批次号，用 | 分隔避免歧义 */
  function batchPreimage(gatewayDid, batchNo) {
    return 'CARBONCHAIN|v1|' + String(gatewayDid) + '|' + String(batchNo);
  }

  /**
   * 生成 bytes32 batchId。
   * 采用国密 SM3（256 bit），与平台既有报文指纹体系同源；
   * 真实部署若链侧要求 keccak256，可在服务端以同一预映像改摘要算法，预映像规范不变。
   * @returns {string} 0x 前缀 32 字节十六进制
   */
  function batchIdOf(gatewayDid, batchNo) {
    const SM3 = global.App && global.App.SM3;
    if (!SM3 || !SM3.sm3) throw new Error('SM3 模块未加载');
    return '0x' + SM3.sm3(batchPreimage(gatewayDid, batchNo));
  }

  /* ================================================================
   * 6. 交叉校验（与平台浮点内核互证）
   * ================================================================ */

  /**
   * 用平台既有浮点内核 App.Nucleus.tier2（E = AD × NCV × CC × OF × 44/12）
   * 复算燃烧项，与本模块定点结果比对，验证"定点标度无漂移"。
   * 偏差来源仅为链上整数截断（< 1e-6 相对量级），若显著偏大即说明口径被改坏。
   */
  function crossCheckLedger(o) {
    const p = paramsFromLedger(o);
    const r = previewEmission(p);
    const N = global.App && global.App.Nucleus;
    let floatTco2 = null;
    if (N && N.tier2) {
      floatTco2 = N.tier2({
        activity: o.fuelAmount, ncv: p.meta.ncv, cc: p.meta.cc, of: p.meta.of,
      }).value;
    }
    const fixedTco2 = fromF6(r.fuelEmission);
    const devPct = floatTco2 ? Math.abs(fixedTco2 - floatTco2) / floatTco2 * 100 : null;
    return { fixed: r, floatTco2, devPct, meta: p.meta };
  }

  /* ================================================================
   * 7. 自检向量（口径回归固化，勿删）
   * ================================================================ */

  /** GB/T 32150-2015 天然气 + 范围二电力基准场景（与合约测试用例同源） */
  const VECTOR = {
    name: 'GB/T 32150-2015 天然气 + 范围二电力',
    input: {
      fuelAmount: 10,          // 10 万Nm³ 天然气
      powerMwh: 250,           // 250 MWh
      output: 500,             // 500 t 产出
      ncv: 389.31,             // GJ/万Nm³
      cc: 0.0153,              // tC/GJ
      oxidationRate: 0.99,
      gridEmissionFactor: 0.5703, // tCO₂/MWh（环办气候函〔2023〕43号）
    },
    expect: {
      fuelEmission: 216218880n,   // 216.218880 tCO₂e
      powerEmission: 142575000n,  // 142.575000 tCO₂e
      totalEmission: 358793880n,  // 358.793880 tCO₂e
      intensity: 717587n,         // 0.717587 tCO₂e/t（链上截断）
    },
    /** 旧口径（除数 12×FACTOR_BASE）的燃烧项，用于固化 1e12 倍偏差结论 */
    legacyFuelEmission: 216218880900000000000n,
  };

  /**
   * 运行自检：断言定点内核与合约期望值完全一致。
   * @returns {{ok:boolean, cases:Array, vector:object}}
   */
  function selfTest() {
    const cases = [];
    const v = VECTOR;
    let got = null;
    try {
      got = preview(v.input).fixed;
    } catch (e) {
      cases.push({ name: '核算执行', ok: false, detail: e.message });
      return { ok: false, cases, vector: v };
    }

    ['fuelEmission', 'powerEmission', 'totalEmission', 'intensity'].forEach((k) => {
      const ok = got[k] === v.expect[k];
      cases.push({
        name: k, ok,
        got: got[k].toString(), expect: v.expect[k].toString(),
        detail: ok ? (fromF6(v.expect[k]) + ' tCO₂e') : '与合约期望值不一致',
      });
    });

    // 旧口径偏差固化：必须恰好放大 1e12 倍（整数截断使比值略小于 1e12）
    const legacy = (toF6(v.input.fuelAmount) * toF6(v.input.ncv) * toF6(v.input.cc)
      * toF6(v.input.oxidationRate) * CO2_C_NUM) / (CO2_C_DEN * FACTOR_BASE);
    const legacyOk = legacy / v.expect.fuelEmission >= 10n ** 12n - 1n;
    cases.push({
      name: '旧口径偏差固化(1e12 倍)',
      ok: legacyOk,
      got: legacy.toString(),
      expect: v.legacyFuelEmission.toString(),
      detail: legacyOk ? '已确认需求原式放大 1e12 倍' : '偏差量级异常',
    });

    // 链上恒等式自检
    const sumOk = got.totalEmission === got.fuelEmission + got.powerEmission;
    cases.push({
      name: '恒等式 E_total = E_燃烧 + E_电力',
      ok: sumOk, got: got.totalEmission.toString(),
      expect: (got.fuelEmission + got.powerEmission).toString(),
      detail: sumOk ? '成立' : '不成立',
    });

    return { ok: cases.every((c) => c.ok), cases, vector: v };
  }

  /* ================================================================
   * 8. 合约 ABI 与（可选的）真实链上只读
   * ================================================================ */

  /** CarbonAccounting.sol 的关键接口 ABI（前端按需取用，不引入 ethers 依赖） */
  const ABI = [
    'function calculateAndRecordEmission(bytes32 batchId, uint256 fuelUsage, uint256 powerUsage, uint256 outputVolume) returns (uint256 totalEmission, uint256 intensity)',
    'function previewEmission(uint256 fuelUsage, uint256 powerUsage, uint256 outputVolume) view returns (uint256 fuelEmission, uint256 powerEmission, uint256 totalEmission, uint256 intensity)',
    'function getBatchRecord(bytes32 batchId) view returns (tuple(uint256 fuelUsage, uint256 powerUsage, uint256 outputVolume, uint256 fuelEmission, uint256 powerEmission, uint256 totalEmission, uint256 intensity, uint256 timestamp, address gateway))',
    'function setFactors(uint256 newNcv, uint256 newCc, uint256 newOf, uint256 newGridEmissionFactor)',
    'function grantGateway(address gateway)',
    'function gridEmissionFactor() view returns (uint256)',
    'function fuelFactors() view returns (uint256 ncv, uint256 cc, uint256 oxidationRate)',
    'event EmissionRecorded(bytes32 indexed batchId, uint256 totalEmission, uint256 intensity, uint256 timestamp)',
    'error InvalidInput()',
    'error InvalidFactors()',
    'error DuplicateBatch(bytes32 batchId)',
    'error BatchNotFound(bytes32 batchId)',
  ];

  /** previewEmission(uint256,uint256,uint256) 的函数选择器（eth_call 用）
   *  实测值：ethers.id("previewEmission(uint256,uint256,uint256)").slice(0,10) */
  const PREVIEW_SELECTOR = '0xde3c2b8e';

  /**
   * 可选：在浏览器已装钱包（window.ethereum）时直接读取链上 previewEmission，
   * 与本模块预览值做像素级比对。未装钱包或未部署时返回 null，不抛错（优雅降级）。
   * @param {{address:string, fuelUsage:bigint, powerUsage:bigint, outputVolume:bigint, rpcMethod?:string}} o
   */
  async function readOnChainPreview(o) {
    const eth = global.ethereum;
    if (!eth || !o || !o.address) return null;
    const hex = (v) => '0x' + big(v).toString(16).padStart(64, '0');
    const data = PREVIEW_SELECTOR + hex(o.fuelUsage) + hex(o.powerUsage) + hex(o.outputVolume);
    try {
      const ret = await eth.request({
        method: 'eth_call',
        params: [{ to: o.address, data }, 'latest'],
      });
      if (!ret || ret === '0x') return null;
      const words = ret.replace(/^0x/, '').match(/.{64}/g) || [];
      return {
        fuelEmission: BigInt('0x' + words[0]),
        powerEmission: BigInt('0x' + words[1]),
        totalEmission: BigInt('0x' + words[2]),
        intensity: BigInt('0x' + words[3]),
      };
    } catch (e) {
      return null;
    }
  }

  /* ================================================================
   * 9. 导出
   * ================================================================ */
  const ContractAccounting = {
    FACTOR_BASE, INTENSITY_BASE, CO2_C_NUM, CO2_C_DEN, COMBUSTION_DIVISOR,
    ERR, VECTOR, ABI, PREVIEW_SELECTOR,
    toF6, fromF6, f6, group,
    previewEmission, preview,
    paramsFromLedger, defaultGridFactor,
    batchPreimage, batchIdOf,
    crossCheckLedger,
    selfTest,
    readOnChainPreview,
  };

  global.App = global.App || {};
  global.App.ContractAccounting = ContractAccounting;
  if (typeof module !== 'undefined' && module.exports) module.exports = ContractAccounting;
})(typeof window !== 'undefined' ? window : globalThis);
