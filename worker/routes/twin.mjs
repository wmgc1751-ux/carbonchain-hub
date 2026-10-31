/**
 * worker/routes/twin.mjs —— 真实厂区数字孪生 API（D1 运行时）
 * ==================================================================================
 * 与 server/routes/twin.js 一一对应，差异只在 SQL 方言：
 *   MySQL  JSON_EXTRACT / JSON_LENGTH  →  D1  json_extract / json_array_length
 *   MySQL  LEFT(name,6)                →  SQLite  substr(name,1,6)
 *
 * 【几何派生逻辑完全一致 —— 这不是"两套实现"】
 * 厂区布局算法（网格排布、真实尺寸、排放分摊）在两边是同一份数学，
 * 只是数据从不同的库读。若两边算法分叉，会出现"本地看到的厂区和线上不一样"，
 * 那是最难排查的一类不一致。
 *
 * 为避免复制出错，这里把 PLANT_PROFILES 与 derivePlant 逐行对齐
 * server/routes/twin.js。改动时必须两边同步 —— 已在两处文件头互相标注。
 *
 * @module worker/routes/twin
 */

import { json, fail, num, pickEnum } from '../lib/http.mjs';

/* ==================================================================================
 * 一、行业档案（与 server/routes/twin.js 保持一致）
 * ================================================================================== */

const PLANT_PROFILES = {
  POWER: {
    label: '燃煤电厂', footprintM: [1800, 1200], unitsPerGW: 2,
    structures: [
      { kind: 'BOILER', name: '锅炉房', w: 90, h: 78, d: 120, per: 'unit' },
      { kind: 'TURBINE', name: '汽机房', w: 220, h: 42, d: 90, per: 'unit' },
      { kind: 'STACK', name: '烟囱', w: 22, h: 240, d: 22, per: 'unit' },
      { kind: 'COOLING', name: '冷却塔', w: 110, h: 165, d: 110, per: 'unit' },
      { kind: 'COALYARD', name: '储煤场', w: 420, h: 28, d: 220, per: 'plant' },
      { kind: 'SUBSTATION', name: '升压站', w: 160, h: 22, d: 120, per: 'plant' },
      { kind: 'WATER', name: '水处理', w: 120, h: 18, d: 90, per: 'plant' },
    ],
  },
  STEEL: {
    label: '钢铁联合企业', footprintM: [2600, 1500], unitsPerGW: 1,
    structures: [
      { kind: 'SINTER', name: '烧结车间', w: 260, h: 46, d: 130, per: 'plant' },
      { kind: 'BLAST', name: '高炉', w: 62, h: 105, d: 62, per: 'unit' },
      { kind: 'BOF', name: '转炉炼钢', w: 180, h: 58, d: 110, per: 'plant' },
      { kind: 'ROLLING', name: '轧钢车间', w: 380, h: 34, d: 130, per: 'plant' },
      { kind: 'COKE', name: '焦化', w: 220, h: 40, d: 100, per: 'plant' },
      { kind: 'POWER', name: '自备电厂', w: 160, h: 60, d: 120, per: 'plant' },
      { kind: 'STACK', name: '烟囱', w: 18, h: 180, d: 18, per: 'plant' },
    ],
  },
  CEMENT: {
    label: '水泥厂', footprintM: [1400, 900], unitsPerGW: 2,
    structures: [
      { kind: 'KILN', name: '回转窑', w: 240, h: 24, d: 34, per: 'unit' },
      { kind: 'PREHEATER', name: '预热器塔', w: 42, h: 118, d: 42, per: 'unit' },
      { kind: 'CLINKER', name: '熟料库', w: 56, h: 68, d: 56, per: 'unit' },
      { kind: 'MILL', name: '生料磨', w: 130, h: 36, d: 80, per: 'plant' },
      { kind: 'CEMENTMILL', name: '水泥磨', w: 150, h: 34, d: 85, per: 'plant' },
      { kind: 'STACK', name: '烟囱', w: 16, h: 140, d: 16, per: 'plant' },
    ],
  },
  CHEMICAL: {
    label: '化工装置区', footprintM: [1600, 1100], unitsPerGW: 2,
    structures: [
      { kind: 'REACTOR', name: '反应器组', w: 80, h: 62, d: 80, per: 'unit' },
      { kind: 'COLUMN', name: '精馏塔', w: 26, h: 95, d: 26, per: 'unit' },
      { kind: 'TANK', name: '储罐区', w: 44, h: 26, d: 44, per: 'unit' },
      { kind: 'UTILITY', name: '公用工程', w: 180, h: 32, d: 110, per: 'plant' },
      { kind: 'FLARE', name: '火炬', w: 12, h: 120, d: 12, per: 'plant' },
      { kind: 'STACK', name: '烟囱', w: 16, h: 110, d: 16, per: 'plant' },
    ],
  },
  OTHER: {
    label: '工业设施', footprintM: [1400, 1000], unitsPerGW: 1,
    structures: [
      { kind: 'HALL', name: '主厂房', w: 220, h: 40, d: 120, per: 'unit' },
      { kind: 'UTILITY', name: '公用工程', w: 150, h: 28, d: 100, per: 'plant' },
      { kind: 'STACK', name: '烟囱', w: 16, h: 120, d: 16, per: 'plant' },
    ],
  },
};

function profileOf(industry) {
  if (industry === '电力') return 'POWER';
  if (industry === '钢铁') return 'STEEL';
  if (industry === '建材') return 'CEMENT';
  if (industry === '化工' || industry === '石化') return 'CHEMICAL';
  return 'OTHER';
}

/** 安全解析 process_json（D1 的 TEXT 列可能是字符串） */
function parseEv(j) {
  if (!j) return {};
  if (typeof j === 'object') return j;
  try { return JSON.parse(j); } catch { return {}; }
}

/* ==================================================================================
 * 一之二、真实厂区事实库（与 Express 版同一份检索结果，同步维护）
 * ==================================================================================
 * 数据来源均为公开报道/官方资料，逐条带出处。检索日期 2026-10-25。
 * areaEstimated=true 表示面积未公开、按机组定额估算。
 */
const REAL_PLANT_FACTS = {
  '25451405': {
    nameZh: '大唐托克托电厂',
    footprintM: [2800, 1500], footprintAreaKm2: 4.2,
    unitGroups: [
      { label: '600MW 超临界机组', count: 8, mw: 600 },
      { label: '660MW 超超临界机组', count: 2, mw: 660 },
      { label: '300MW 自备机组', count: 2, mw: 300 },
    ],
    sources: [
      '百度百科：大唐托克托发电厂（8×60万+2×30万+2×66万=672万千瓦）',
      '人民日报中国能源报 2017-03：世界最大火电厂的传奇',
      '托克托县年鉴：配套园区规划占地 28.6 km²，东区约 4 km²',
    ],
  },
};

function realFactsFor(externalId, name) {
  const id = String(externalId || '');
  if (REAL_PLANT_FACTS[id]) return REAL_PLANT_FACTS[id];
  const nm = String(name || '');
  if (/Angang/i.test(nm)) return {
    nameZh: '鞍钢股份（鞍山本部）',
    footprintM: [5600, 4300], footprintAreaKm2: 24,
    unitGroups: [{ label: '4000m³ 级高炉', count: 4, mw: 0 }],
    sources: ['新浪财经 2022-05：鞍山钢铁主厂区面积约 24 平方公里',
      '央视新闻 2016-11：鞍钢鞍山基地占地超 120 平方公里（含矿区）'],
  };
  if (/BaoTou/i.test(nm)) return {
    nameZh: '包钢股份（包头本部）',
    footprintM: [6000, 6000], footprintAreaKm2: 36,
    unitGroups: [{ label: '2500m³ 级高炉', count: 4, mw: 0 }],
    sources: ['新浪财经 2022-05：包钢中心厂区 37.5 平方公里',
      '西安建筑科技大学/我的钢铁：包钢中心厂区 36 平方公里'],
  };
  if (/Maanshan/i.test(nm)) return {
    nameZh: '马钢股份（马鞍山本部）',
    footprintM: [3700, 3650], footprintAreaKm2: 13.5,
    unitGroups: [{ label: '2500m³ 级高炉', count: 3, mw: 0 }],
    sources: ['中国汽车工程学会：马钢占地 13.5 平方公里',
      '经济日报 2024-03：2000 万吨钢配套规模'],
  };
  if (/Guazhou|Changle/i.test(nm)) return {
    nameZh: '甘肃电投常乐电厂',
    footprintM: [1900, 1100], footprintAreaKm2: 2.1, areaEstimated: true,
    unitGroups: [{ label: '1000MW 超超临界机组', count: 6, mw: 1000 }],
    sources: ['甘肃国资委 2024-12：6×100万千瓦、全国最大百万千瓦级',
      '甘肃日报 2025-10：600 万千瓦全部投产',
      '⚠ 面积未公开，估算约 2.1 km²'],
  };
  if (/Changshu/i.test(nm)) return {
    nameZh: '华润电力常熟电厂',
    footprintM: [1500, 800], footprintAreaKm2: 1.2, areaEstimated: true,
    unitGroups: [{ label: '650MW 超临界机组', count: 3, mw: 650 }],
    sources: ['华润电力官网：3 台 65 万千瓦超临界',
      '⚠ 面积未公开，估算约 1.2 km²'],
  };
  return null;
}

/* ==================================================================================
 * 二、几何派生（与 Express 版同一份数学）
 * ================================================================================== */
function derivePlant(totalCo2e, ev, profileKey, externalId, facilityName) {
  const prof = PLANT_PROFILES[profileKey] || PLANT_PROFILES.OTHER;
  const facts = realFactsFor(externalId, facilityName);
  const capacity = ev.capacity == null ? null : Number(ev.capacity);
  const capacityUnit = ev.capacityUnit || '';

  /* 真实机组构成优先（事实库），无事实时按装机推算 */
  let unitCount = 1;
  let actualUnits = 1;
  let unitGroups = null;
  if (facts && Array.isArray(facts.unitGroups) && facts.unitGroups.length) {
    unitGroups = facts.unitGroups.map((g) => ({
      label: g.label, mw: g.mw || null,
      actualCount: g.count, displayCount: Math.min(g.count, 2),
    }));
    actualUnits = facts.unitGroups.reduce((a, g) => a + g.count, 0);
    unitCount = facts.unitGroups.reduce((a, g) => a + Math.min(g.count, 2), 0);
  } else if (capacity && /MW/i.test(capacityUnit)) {
    unitCount = Math.max(1, Math.round((capacity / 1000) * prof.unitsPerGW));
    actualUnits = unitCount;
    unitCount = Math.min(unitCount, 4);
  } else if (capacity && /steel|t\b/i.test(capacityUnit)) {
    unitCount = Math.max(1, Math.min(4, Math.round(capacity / 5e6)));
    actualUnits = unitCount;
  }

  /* 真实事实优先（公开测绘/环评数据），无事实时用行业典型值 */
  const [fw, fd] = facts ? facts.footprintM : prof.footprintM;
  const scale = 1.0;
  const sceneW = fw;
  const sceneD = fd;

  const total = Number(totalCo2e);
  const perUnitShare = 0.78;
  const unitEmission = unitCount > 0 ? (total * perUnitShare) / unitCount : total;
  const plantStructures = prof.structures.filter((p) => p.per === 'plant');
  const plantEach = plantStructures.length
    ? (total * (1 - perUnitShare)) / plantStructures.length : 0;

  /* 工艺链布局（与 Express 版 routes/twin.js 同一份数学，2026-10-29 同步）：
   * 旧的"每类结构一行、行内等距铺满场区宽度"会把 8 个结构拉到 4.8 km 宽、
   * 两台高炉相距 4.5 km，3D 场景读不出厂区感。改为按工艺顺序成簇摆放。 */
  const CHAIN_SEQ = {
    POWER: ['BOILER', 'TURBINE', 'STACK', 'COOLING'],
    STEEL: ['SINTER', 'COKE', 'BLAST', 'BOF', 'ROLLING'],
    CEMENT: ['MILL', 'KILN', 'PREHEATER', 'CLINKER', 'CEMENTMILL'],
    CHEMICAL: ['REACTOR', 'COLUMN', 'TANK'],
    OTHER: ['HALL'],
  };
  const chainSeq = CHAIN_SEQ[profileKey] || CHAIN_SEQ.OTHER;

  /** 沿 x 摆放一行结构：prefGap 为不同工艺段间距（场区宽度 3%，夹 45~180 m），
   *  intraGap 为同种设备代表体间距；间距按场区宽度等比压缩（系数下限 0.18）。 */
  function placeRow(items, rowZ, prefGap, intraGap) {
    if (!items.length) return;
    const gapSum = items.slice(1).reduce((a, it, i) =>
      a + (it.kind === items[i].kind ? intraGap : prefGap), 0);
    const sumW = items.reduce((a, it) => a + it.w, 0);
    const limit = sceneW * 0.92;
    let k = 1;
    if (gapSum > 0 && sumW + gapSum > limit) k = Math.max(0.18, (limit - sumW) / gapSum);
    let cursor = -((sumW + gapSum * k) / 2);
    items.forEach((it, i) => {
      if (i > 0) cursor += (it.kind === items[i - 1].kind ? intraGap : prefGap) * k;
      it.x = cursor + it.w / 2;
      it.z = rowZ;
      cursor += it.w;
    });
  }

  const unitRow = [];
  let idx = 0;
  for (const s of prof.structures.filter((p) => p.per === 'unit')) {
    for (let i = 0; i < unitCount; i++) {
      unitRow.push({
        id: `${s.kind}-${++idx}`, kind: s.kind, name: `${s.name} #${i + 1}`,
        w: s.w, h: s.h, d: s.d, sizeM: { w: s.w, h: s.h, d: s.d },
        emission: +unitEmission.toFixed(2),
        sharePct: +((unitEmission / total) * 100).toFixed(2),
      });
    }
  }

  const plantRow = [];
  let pidx = 0;
  for (const s of [...plantStructures].sort((a, b) => (b.w * b.d) - (a.w * a.d))) {
    plantRow.push({
      id: `${s.kind}-${++pidx}`, kind: s.kind, name: s.name,
      w: s.w, h: s.h, d: s.d, sizeM: { w: s.w, h: s.h, d: s.d },
      emission: +plantEach.toFixed(2),
      sharePct: +((plantEach / total) * 100).toFixed(2),
    });
  }
  /* 按工艺链定位：主链在 z = -0.10·sceneD，辅助设施在 z = +0.16·sceneD */
  const rank = (kind) => {
    const i = chainSeq.indexOf(kind);
    return i < 0 ? 99 : i;
  };
  const allItems = [...unitRow, ...plantRow]
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (rank(a.it.kind) - rank(b.it.kind)) || (a.i - b.i))
    .map((x) => x.it);
  const chainItems = allItems.filter((it) => rank(it.kind) < 99);
  const auxItems = allItems.filter((it) => rank(it.kind) === 99);
  const prefGap = Math.max(45, Math.min(180, sceneW * 0.03));
  placeRow(chainItems, -sceneD * 0.10, prefGap, 40);
  placeRow(auxItems, sceneD * 0.16, prefGap * 0.75, 40);

  const structures = [...chainItems, ...auxItems].map((it) => ({
    id: it.id, kind: it.kind, name: it.name, sizeM: it.sizeM,
    local: { x: +it.x.toFixed(2), y: +(it.h / 2).toFixed(2), z: +it.z.toFixed(2) },
    scene: { w: +it.w.toFixed(2), h: +it.h.toFixed(2), d: +it.d.toFixed(2) },
    emission: it.emission, sharePct: it.sharePct,
  }));

  return {
    profile: profileKey, profileLabel: prof.label,
    footprintM: { w: fw, d: fd },
    footprintAreaKm2: facts ? (facts.footprintAreaKm2 || null) : null,
    areaEstimated: facts ? !!facts.areaEstimated : false,
    areaSources: facts ? (facts.sources || []) : null,
    scale,
    sceneExtent: { w: sceneW, d: sceneD },
    unitCount, actualUnits,
    unitGroups: unitGroups || null,
    unitsPerRepresentative: unitCount > 0 ? +(actualUnits / unitCount).toFixed(1) : 1,
    structures,
  };
}

/* ==================================================================================
 * 三、路由
 * ================================================================================== */

export function attachTwinRoutes(r) {
  /* ---------- 候选设施 ---------- */
  r.get('/api/twin/candidates', async (ctx) => {
    const country = String(ctx.query.country || 'CHN').toUpperCase();
    const year = Number(ctx.query.year) || 2025;
    const limit = Math.min(Number(ctx.query.limit) || 12, 40);

    const rows = await ctx.db.query(
      `SELECT f.id, f.external_id, f.name, f.industry, f.sector_raw, f.admin2 AS region,
              f.latitude, f.longitude, e.year, e.total_co2e, e.process_json, f.source_url
         FROM real_facility f
         JOIN real_emission_year e ON e.facility_id = f.id
        WHERE f.country_iso = ?
          AND e.year = ?
          AND f.latitude IS NOT NULL AND f.longitude IS NOT NULL
          AND e.total_co2e > 5000000
          AND f.industry IN ('电力','钢铁','建材','化工','石化','有色金属','煤炭')
          AND COALESCE(json_extract(e.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'
          AND (json_extract(e.process_json,'$.capacity') IS NOT NULL
               OR json_extract(e.process_json,'$.activity') IS NOT NULL)
          AND substr(f.name,1,6) <> 'China_'
        ORDER BY e.total_co2e DESC
        LIMIT ?`, [country, year, limit]);

    return json(rows.map((r) => {
      const ev = parseEv(r.process_json);
      return {
        id: num(r.id),
        externalId: r.external_id,
        name: r.name,
        industry: r.industry,
        sectorRaw: r.sector_raw,
        region: r.region,
        lat: num(r.latitude),
        lon: num(r.longitude),
        year: num(r.year),
        totalCO2e: num(r.total_co2e),
        capacity: ev.capacity == null ? null : num(ev.capacity),
        capacityUnit: ev.capacityUnit || null,
        activity: ev.activity == null ? null : num(ev.activity),
        activityUnit: ev.activityUnit || null,
        emissionFactor: ev.emissionFactor == null ? null : num(ev.emissionFactor),
        owners: Array.isArray(ev.owners) ? ev.owners.slice(0, 3) : [],
        confidence: ev.confidence && ev.confidence.total_co2e_100yrgwp
          ? ev.confidence.total_co2e_100yrgwp : null,
        assetType: ev.assetType || null,
        profile: profileOf(r.industry),
        sourceUrl: r.source_url,
      };
    }), {
      country, year, count: rows.length,
      note: '仅列出排放 >500 万吨、有真实坐标与装机的工业设施。数值来自 Climate TRACE 源记录。',
    });
  });

  /* ---------- 单厂区完整数据 ---------- */
  r.get('/api/twin/plant/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isFinite(id)) return fail('非法设施 ID');

    const f = await ctx.db.one('SELECT * FROM real_facility WHERE id = ?', [id]);
    if (!f) return fail('设施不存在', 404);

    const allSeries = await ctx.db.query(
      `SELECT year, total_co2e, process_json FROM real_emission_year
        WHERE facility_id = ? ORDER BY year`, [id]);
    if (!allSeries.length) return fail('该设施无年度排放记录', 404);

    const currentYear = new Date().getFullYear();
    const reqYear = Number(ctx.query.year) || null;
    const validYears = allSeries.map((r) => num(r.year));
    const completeYears = validYears.filter((y) => y < currentYear);
    const pickYear = (reqYear && validYears.includes(reqYear)) ? reqYear
      : (completeYears.length ? Math.max(...completeYears) : validYears[validYears.length - 1]);

    const series = allSeries.filter((r) => num(r.year) <= pickYear);
    const latest = allSeries.find((r) => num(r.year) === pickYear)
      || allSeries[allSeries.length - 1];

    const ev = parseEv(latest.process_json);
    const profileKey = profileOf(f.industry);
    /* 传入设施标识（external_id + name），让事实库能匹配真实占地 */
    const plant = derivePlant(latest.total_co2e, ev, profileKey, f.external_id, f.name);

    const years = series.map((r) => ({
      year: num(r.year),
      totalCO2e: num(r.total_co2e),
      isPartial: num(r.year) >= currentYear,
    }));

    return json({
      facility: {
        id: num(f.id), externalId: f.external_id, name: f.name, nameCn: f.name_cn,
        industry: f.industry, sectorRaw: f.sector_raw, country: f.country_iso,
        region: f.admin1, regionName: f.admin2,
        lat: f.latitude === null ? null : num(f.latitude),
        lon: f.longitude === null ? null : num(f.longitude),
        sourceUrl: f.source_url, authenticity: f.authenticity,
      },
      metrics: {
        year: num(latest.year),
        totalCO2e: num(latest.total_co2e),
        capacity: ev.capacity == null ? null : num(ev.capacity),
        capacityUnit: ev.capacityUnit || null,
        activity: ev.activity == null ? null : num(ev.activity),
        activityUnit: ev.activityUnit || null,
        emissionFactor: ev.emissionFactor == null ? null : num(ev.emissionFactor),
        assetType: ev.assetType || null,
        owners: Array.isArray(ev.owners) ? ev.owners : [],
        confidence: ev.confidence || null,
      },
      years,
      processBreakdown: Array.isArray(ev.processes) ? ev.processes : [],
      plant,
      dataLayer: {
        values: 'REAL',
        valuesBasis: 'Climate TRACE 设施级观测估算（可逐条回溯 sourceUrl）',
        geometry: 'DERIVED',
        geometryBasis: `按${plant.profileLabel}的工程量级（场区 ${plant.footprintM.w}×${plant.footprintM.d} m）派生，非厂内测绘。`
          + '尺寸比例遵循行业常识（烟囱/冷却塔/厂房相对高度与占地）。',
        allocation: '设施总排放按机组数均分——假设同型号机组近似等排放。这是工程假设，不是实测分摊。',
        notClaimed: [
          '不主张这是厂区的实测三维模型',
          '不主张各机组排放是独立计量的（除 EPA 工艺段分解外）',
          '不主张坐标精确到单栋建筑（设施级坐标精度约 100 m）',
        ],
      },
    });
  });

  /* ---------- 跨设施对比 ---------- */
  r.get('/api/twin/compare', async (ctx) => {
    const industry = String(ctx.query.industry || '电力');
    const country = String(ctx.query.country || 'CHN').toUpperCase();
    const year = Number(ctx.query.year) || 2025;
    const limit = Math.min(Number(ctx.query.limit) || 5, 10);

    const rows = await ctx.db.query(
      `SELECT f.id, f.name, f.latitude, f.longitude, e.total_co2e, e.process_json
         FROM real_facility f JOIN real_emission_year e ON e.facility_id = f.id
        WHERE f.country_iso = ? AND e.year = ? AND f.industry = ?
          AND f.latitude IS NOT NULL
          AND COALESCE(json_extract(e.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'
        ORDER BY e.total_co2e DESC LIMIT ?`, [country, year, industry, limit]);

    return json(rows.map((r) => {
      const ev = parseEv(r.process_json);
      return {
        id: num(r.id), name: r.name,
        lat: num(r.latitude), lon: num(r.longitude),
        totalCO2e: num(r.total_co2e),
        capacity: ev.capacity == null ? null : num(ev.capacity),
        capacityUnit: ev.capacityUnit || null,
        emissionFactor: ev.emissionFactor == null ? null : num(ev.emissionFactor),
      };
    }), { industry, country, year });
  });
}
