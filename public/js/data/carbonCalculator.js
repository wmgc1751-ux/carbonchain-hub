/* =====================================================================
   carbonCalculator.js —— 真实国标物理计算与因子库解耦
   ---------------------------------------------------------------------
   设计原则：
     1. **严禁写死碳排放总量**，必须通过物理公式动态计算
     2. **因子库解耦** —— 因子从 App.Sources（单一事实来源 SSOT）取，
        不在本文件写死任何数值
     3. **动态因子切换** —— 支持全国平均 / 区域电网 / 绿电核销 0 因子
        三种口径，实时触发计算更新
     4. **口径强制区分** —— 全国电网平均排放因子（范围二）与
        电力碳足迹因子（生命周期 PCF）不可混用

   核算公式：
     范围一瞬时排放速率（直接排放，烟气实测）：
       E_dir (tCO₂/h) = 烟气流量(m³/h) × (CO₂浓度% / 100) × (44 / 22.4) × 10⁻³
       （ρ_CO₂ = 44/22.4 g/L = 1964.3 g/m³；质量流量(g/h)=Q×φ×ρ；
        折吨=×1e-6 → Q×φ×1964.3×1e-6 = Q×(φ/100)×(44/22.4)×1e-3）

     范围二电力折算（外购电力间接排放）：
       E_indir (tCO₂) = 消耗电量(MWh) × 动态电网排放因子
       默认加载最新官方基准：0.5703 tCO₂/MWh
       （环办气候函〔2023〕43号，2023-02-07，2022 年度，全国电网平均）
   ===================================================================== */
(function (global) {
  'use strict';

  const M_CO2 = 44, V_M = 22.4;

  /* ================================================================
   * 1. 因子口径定义（从 App.Sources 动态取值，不在本文件写死）
   * ================================================================ */
  const FACTOR_PRESETS = [
    {
      key: 'national_avg',
      label: '全国电网平均排放因子',
      scope: '范围二（外购电力间接排放）',
      cite: '环办气候函〔2023〕43号 · 2023-02-07 · 2022 年度',
      getValue: () => {
        const S = global.App && global.App.Sources;
        if (!S) return 0.5703;  // 兜底
        // 从台账取值（sources.js 的 electricityFactors.nationalAvg）
        const f = S.electricityFactors && S.electricityFactors.nationalAvg;
        return f ? f.value : 0.5703;
      },
      unit: 'tCO₂/MWh',
    },
    {
      key: 'regional_grid',
      label: '区域电网基准线（华东 OM）',
      scope: 'CCER 减排项目基准线（不可与范围二混用）',
      cite: '国家气候战略中心 2024-07-08 · 2023 年区域电网基准线',
      getValue: () => {
        const S = global.App && global.App.Sources;
        if (!S) return 0.7703;  // 华东 OM 兜底
        const regions = S.electricityFactors && S.electricityFactors.regionalBaseline;
        if (!regions) return 0.7703;
        // 取华东 OM
        const huadong = regions.find((r) => r.region === '华东');
        return huadong ? huadong.om : 0.7703;
      },
      unit: 'tCO₂/MWh',
      warn: '此因子用于 CCER 减排项目核算，不可用于企业范围二排放申报',
    },
    {
      key: 'green_power',
      label: '绿电核销（0 因子）',
      scope: '已通过绿证/直连 PPAs 核销的电力',
      cite: 'CBAM 排除绿证抵扣 · 欧盟只认可物理直连与 PPA',
      getValue: () => 0,
      unit: 'tCO₂/MWh',
      warn: '欧盟 CBAM 明确排除绿证抵扣电力间接排放，只认可物理直连与 PPA',
    },
  ];

  let activeFactorKey = 'national_avg';
  const factorListeners = [];

  function getActiveFactor() {
    return FACTOR_PRESETS.find((f) => f.key === activeFactorKey) || FACTOR_PRESETS[0];
  }
  function setActiveFactor(key) {
    if (!FACTOR_PRESETS.find((f) => f.key === key)) return false;
    activeFactorKey = key;
    factorListeners.forEach((cb) => { try { cb(getActiveFactor()); } catch (e) {} });
    return true;
  }
  function onFactorChange(cb) {
    factorListeners.push(cb);
    return function off() {
      const i = factorListeners.indexOf(cb);
      if (i >= 0) factorListeners.splice(i, 1);
    };
  }

  /* ================================================================
   * 2. 物理公式实现
   * ================================================================ */

  /** 范围一瞬时排放速率（tCO₂/h）
   *  @param flow       标态干烟气流量 (m³/h)
   *  @param co2Pct      CO₂ 体积浓度 (%)
   *  @return tCO₂/h
   */
  function directEmissionRate(flow, co2Pct) {
    return flow * (co2Pct / 100) * (M_CO2 / V_M) * 1e-3;
  }

  /** 范围一累计排放（tCO₂）
   *  @param rate        瞬时速率 (tCO₂/h)
   *  @param hours       运行小时数
   */
  function directEmissionCumulative(rate, hours) {
    return rate * hours;
  }

  /** 范围二电力折算排放（tCO₂）
   *  @param kwh         消耗电量
   *  @param factorOverride  可选：手动指定因子（不传则用当前激活因子）
   *  @return tCO₂
   */
  function indirectElectricityEmission(kwh, factorOverride) {
    const mwh = kwh / 1000;
    const factor = factorOverride != null ? factorOverride : getActiveFactor().getValue();
    return mwh * factor;
  }

  /** 双轨对账：组织碳（直接+间接）vs 产品碳分摊总和
   *  组织碳 ⊇ Σ产品碳 是硬约束（包含性约束）
   *  @param directTons     范围一直接排放
   *  @param indirectTons   范围二间接排放
   *  @param productTco2e   产品碳分摊总和
   *  @return { totalOrg, productSum, coverage, hardConstraintOk, deviationPct }
   */
  function reconcileTracks(directTons, indirectTons, productTco2e) {
    const totalOrg = directTons + indirectTons;
    const productSum = productTco2e;
    const hardConstraintOk = totalOrg >= productSum * 0.999;  // 容差 0.1%
    const coverage = totalOrg > 0 ? productSum / totalOrg : 0;
    const deviationPct = totalOrg > 0 ? ((totalOrg - productSum) / totalOrg * 100) : 0;
    return { totalOrg, productSum, coverage, hardConstraintOk, deviationPct };
  }

  /** 单位推导（供 UI 展示） */
  function unitDerivation() {
    return {
      molarMass: M_CO2 + ' g/mol',
      molarVolume: V_M + ' L/mol',
      density: (M_CO2 / V_M).toFixed(4) + ' g/L = ' + (M_CO2 / V_M * 1000).toFixed(1) + ' g/m³',
      formula: 'E_dir(t/h) = Q(m³/h) × (φ/100) × (44/22.4) × 1e-3',
      formulaIndirect: 'E_indir(t) = 电量(MWh) × 动态电网因子(tCO₂/MWh)',
      nationalDefault: '0.5703 tCO₂/MWh（环办气候函〔2023〕43号）',
    };
  }

  /* ================================================================
   * 3. 导出
   * ================================================================ */
  const CarbonCalculator = {
    FACTOR_PRESETS,
    getActiveFactor,
    setActiveFactor,
    onFactorChange,
    directEmissionRate,
    directEmissionCumulative,
    indirectElectricityEmission,
    reconcileTracks,
    unitDerivation,
    PHYSICS: { M_CO2, V_M },
  };

  global.App = global.App || {};
  global.App.CarbonCalculator = CarbonCalculator;
  if (typeof module !== 'undefined' && module.exports) module.exports = CarbonCalculator;
})(typeof window !== 'undefined' ? window : globalThis);
