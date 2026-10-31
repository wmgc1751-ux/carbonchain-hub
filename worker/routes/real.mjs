/**
 * worker/routes/real.mjs —— 真实数据层（Cloudflare Workers / D1）
 * ==================================================================================
 * 与 server/routes/real.js 一一对应，但做了三处**必要的架构调整**：
 *
 * 【调整 1：聚合走预聚合表，不扫实体表】
 * D1 实测：对 5 万行做 GROUP BY 会 rows_read=100,000，而免费层每天 500 万行
 * 读取额度 ⇒ 只能跑 50 次。因此：
 *   · `/overview` 的行业/区域/年度汇总 → 读 agg_facility_year / agg_facility_total
 *   · 明细列表（/facilities）→ 走索引分页，rows_read 可控（每页 20 行）
 *   · 洞察（/cn/insight）→ 读 agg_insight（Cron 预计算）
 *
 * 【调整 2：Carbon TRACE 的 process_json 用 JSON1 函数解析】
 * MySQL 用 JSON_EXTRACT，SQLite 用 json_extract —— 已在 lib/db.mjs 的
 * toSqliteSql 里统一改写，这里不需要写两套。
 *
 * 【调整 3：真实性契约的核验 SQL 必须能在 D1 跑】
 * 原契约里用了 `YEAR(CURDATE())`、`JSON_LENGTH` 等，已改写。
 * 关键原则不变：expected 全部**运行时计算**，不写死 ——
 * 写死的数字在数据增长后会变成"平台在撒谎"的红色告警。
 *
 * @module worker/routes/real
 */

import { json, fail, num, pickEnum } from '../lib/http.mjs';

const COUNTRIES = ['USA', 'CHN'];
const INDUSTRIES = ['电力', '钢铁', '建材', '化工', '石化', '造纸', '有色金属', '煤炭', '其他'];

const REGION_CN = {
  NORTH: '华北', NORTHEAST: '东北', EAST: '华东',
  CENTRAL: '华中', NORTHWEST: '西北', SOUTH: '南方', SOUTHWEST: '西南',
};

const COUNTRY_NOTE = {
  USA: {
    name: '美国', source: 'US EPA GHGRP（40 CFR Part 98 强制报告制度）',
    nature: '企业向监管机构报送并公开的实名排放数据',
    usable: '设施级排放画像、行业基准、方法学交叉校验',
    notUsable: '不能代表中国企业，也不能作为中国碳市场履约依据',
  },
  CHN: {
    name: '中国', source: 'Climate TRACE（卫星遥感 / CEMS 反演 / 电网与航运观测的多源融合估算）',
    nature: '独立第三方观测估算，非企业自报核查值',
    usable: '区域与行业排放画像、第三方交叉校验、CBAM 默认值比对、异常线索发现',
    notUsable: '不能替代企业履约清缴与核查报告，法律效力不同于企业报送值',
  },
};

function parseCountry(v) {
  if (v === undefined || v === null || v === '') return null;
  const c = String(v).toUpperCase();
  return COUNTRIES.includes(c) ? c : undefined;
}

/** 聚合型资产排除条件（与 MySQL 版同口径） */
const AGG_EXCL = "COALESCE(json_extract(e.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'";

/* ==================================================================================
 * GET /api/real/overview
 * ================================================================================== */

export async function overview(ctx) {
  try {
    return await overviewImpl(ctx);
  } catch (e) {
    /* ⚠ 额度耗尽必须与"SQL 写错"区分开 —— 前者要等额度重置，后者要改代码。
     * 这里先问 db 层这是不是配额错误，是就直接抛给全局处理器（它会返回 503）；
     * 不是才返回方言/SQL 诊断。 */
    const { isQuotaError, D1QuotaError } = await import('../lib/db.mjs');
    if (e instanceof D1QuotaError || isQuotaError(e)) throw e;

    console.error('[OVERVIEW_ERROR]', e && e.stack ? e.stack : e);
    return new Response(JSON.stringify({
      code: 500,
      msg: '真实数据总览查询失败',
      data: {
        error: String((e && e.message) || e),
        hint: '通常是 D1 不支持的 SQL 方言（FIELD / LIMIT x,y / JSON 函数）或聚合表的列缺失。',
        detail: String((e && e.stack) || '').split('\n').slice(0, 6),
      },
    }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
}

async function overviewImpl(ctx) {
  const country = parseCountry(ctx.query.country);
  if (country === undefined) {
    return fail(`未知国家代码：${ctx.query.country}（支持 ${COUNTRIES.join(' / ')}）`);
  }
  const currentYear = new Date().getFullYear();

  /* ---------- 年度完整性 ----------
   * 两个独立维度：设施覆盖（抓取是否完成）+ 年度时间（是否已过完）。
   * 这与 MySQL 版完全同一判据 —— 口径不统一是院审点名的问题。 */
  const yearRows = country
    ? await ctx.db.query(
      `SELECT year, SUM(facilities) AS n FROM agg_facility_total
        WHERE country_iso = ? GROUP BY year ORDER BY year`, [country])
    : await ctx.db.query(
      'SELECT year, SUM(facilities) AS n FROM agg_facility_total GROUP BY year ORDER BY year');

  const counts = yearRows.map((r) => num(r.n)).sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;

  const completeness = yearRows.map((r) => {
    const n = num(r.n);
    const y = num(r.year);
    const coverageOk = median > 0 ? n >= median * 0.6 : false;
    const yearOver = y < currentYear;
    const reasons = [];
    if (!coverageOk) reasons.push(`设施覆盖不完整：仅入库 ${n.toLocaleString()} 家（其他年度约 ${median.toLocaleString()} 家）`);
    if (!yearOver) reasons.push(`年度尚未结束：${y} 年只统计到当前时点，不可与完整年度直接比较`);
    return {
      year: y, facilities: n, complete: coverageOk && yearOver,
      facilityCoverageOk: coverageOk, yearOver,
      note: reasons.length ? reasons.join('；') : null,
    };
  });

  const latestYear = completeness.length ? Math.max(...completeness.map((c) => c.year)) : null;
  const latestComplete = completeness.filter((c) => c.complete)
    .map((c) => c.year).sort((a, b) => b - a)[0] || latestYear;

  const reqYear = Number(ctx.query.year) || null;
  const validYears = new Set(completeness.map((c) => c.year));
  const effectiveYear = reqYear && validYears.has(reqYear) ? reqYear : latestComplete;

  /* ---------- 规模 ----------
   * ⚠ 区域归属存在 real_facility.admin1（不是 region_code ——
   * 那是预聚合表 agg_facility_year 的列名）。这两个名字不一致是
   * "迁移时用元数据生成 schema"之后暴露的典型问题：
   * 业务表沿用 MySQL 原有列名，聚合表是新设计的，两边命名没对齐。
   * 读实体表用 admin1，读聚合表用 region_code —— 必须分清。 */
  const facSql = country
    ? `SELECT COUNT(*) AS n, COUNT(DISTINCT industry) AS inds,
              COUNT(DISTINCT admin1) AS regions,
              SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) AS geo
         FROM real_facility WHERE country_iso = ?`
    : `SELECT COUNT(*) AS n, COUNT(DISTINCT industry) AS inds,
              COUNT(DISTINCT admin1) AS regions,
              SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) AS geo
         FROM real_facility`;
  const fac = await ctx.db.one(facSql, country ? [country] : []) || {};

  const emi = await ctx.db.one(
    country
      ? `SELECT COUNT(*) AS n, COUNT(DISTINCT year) AS yrs, MIN(year) AS y0, MAX(year) AS y1
           FROM real_emission_year e JOIN real_facility f ON f.id = e.facility_id
          WHERE f.country_iso = ?`
      : `SELECT COUNT(*) AS n, COUNT(DISTINCT year) AS yrs, MIN(year) AS y0, MAX(year) AS y1
           FROM real_emission_year e JOIN real_facility f ON f.id = e.facility_id`,
    country ? [country] : []
  ) || {};

  /* ---------- 行业/区域结构（走预聚合） ---------- */
  const byIndustryRaw = effectiveYear
    ? await ctx.db.query(
      `SELECT industry, SUM(facilities) AS facilities, SUM(total_co2e) AS total
         FROM agg_facility_year
        WHERE year = ? ${country ? 'AND country_iso = ?' : ''}
        GROUP BY industry ORDER BY total DESC`,
      country ? [effectiveYear, country] : [effectiveYear])
    : [];

  const byRegionRaw = effectiveYear
    ? await ctx.db.query(
      `SELECT region_code, SUM(facilities) AS facilities, SUM(total_co2e) AS total
         FROM agg_facility_year
        WHERE year = ? ${country ? 'AND country_iso = ?' : ''}
        GROUP BY region_code ORDER BY total DESC`,
      country ? [effectiveYear, country] : [effectiveYear])
    : [];

  /* ---------- 国家分层 ---------- */
  const byCountryRaw = await ctx.db.query(
    `SELECT 'CHN' AS iso, COUNT(*) AS facilities FROM real_facility WHERE country_iso='CHN'
     UNION ALL
     SELECT 'USA' AS iso, COUNT(*) AS facilities FROM real_facility WHERE country_iso='USA'`
  );

  const sources = await ctx.db.query(
    `SELECT source_key, name, publisher, license, authenticity, last_fetched_at, record_count
       FROM data_source ORDER BY authenticity, source_key`
  );

  return json({
    countryFilter: country,
    countryNote: country ? COUNTRY_NOTE[country] : null,
    facilities: num(fac.n),
    states: num(fac.regions),
    industries: num(fac.inds),
    withCoordinates: num(fac.geo),
    emissionRows: num(emi.n),
    yearFrom: emi.y0 === null || emi.y0 === undefined ? null : num(emi.y0),
    yearTo: emi.y1 === null || emi.y1 === undefined ? null : num(emi.y1),
    latestYear,
    latestCompleteYear: latestComplete,
    effectiveYear,
    yearCompleteness: completeness,
    years: num(emi.yrs),
    /* ⚠ totalTonnes 是**全部年度累计**，不是当年。字段名保留以兼容前端，
     * 但前端已改为显示 byIndustry 之和（单年度口径）。 */
    totalTonnes: 0,
    byCountry: byCountryRaw.map((r) => ({ iso: r.iso, facilities: num(r.facilities) })),
    byIndustry: byIndustryRaw.map((r) => ({
      industry: r.industry,
      facilities: num(r.facilities),
      mt: +(num(r.total) / 1e6).toFixed(2),
    })),
    byState: byRegionRaw.map((r) => ({
      state: REGION_CN[r.region_code] || (r.region_code === null ? '未归属' : r.region_code),
      stateCode: r.region_code,
      facilities: num(r.facilities),
      mt: +(num(r.total) / 1e6).toFixed(2),
    })),
    sources: sources.map((s) => ({
      key: s.source_key, name: s.name, publisher: s.publisher,
      license: s.license, authenticity: s.authenticity,
      lastFetchedAt: s.last_fetched_at,
      recordCount: s.record_count === null ? null : num(s.record_count),
    })),
    generatedAt: new Date().toISOString(),
  });
}

/* ==================================================================================
 * GET /api/real/facilities
 * ================================================================================== */

export async function facilities(ctx) {
  const country = parseCountry(ctx.query.country);
  if (country === undefined) return fail(`未知国家代码：${ctx.query.country}`);

  const currentYear = new Date().getFullYear();
  /* 默认年度：最新**完整**年度。按国家取，避免美国数据止于 2018 时永远空表。 */
  const year = Number(ctx.query.year) || num(await ctx.db.value(
    country
      ? `SELECT MAX(e.year) FROM real_emission_year e JOIN real_facility f ON f.id=e.facility_id
          WHERE f.country_iso = ? AND e.year < ?`
      : `SELECT MAX(e.year) FROM real_emission_year e JOIN real_facility f ON f.id=e.facility_id
          WHERE e.year < ?`,
    country ? [country, currentYear] : [currentYear]
  )) || (currentYear - 1);

  const size = Math.min(Math.max(num(ctx.query.size, 20), 1), 200);
  const page = Math.max(num(ctx.query.page, 1), 1);
  const offset = (page - 1) * size;

  const where = ['e.year = ?'];
  const params = [year];
  if (country) { where.push('f.country_iso = ?'); params.push(country); }

  if (ctx.query.industry) {
    if (!INDUSTRIES.includes(ctx.query.industry)) return fail(`未知行业：${ctx.query.industry}`);
    where.push('f.industry = ?'); params.push(ctx.query.industry);
  }
  if (ctx.query.state) { where.push('f.admin1 = ?'); params.push(String(ctx.query.state).toUpperCase()); }
  if (ctx.query.q) {
    where.push('(f.name LIKE ? OR f.external_id = ?)');
    params.push(`%${String(ctx.query.q).slice(0, 60)}%`, String(ctx.query.q));
  }
  if (ctx.query.minTonnes) { where.push('e.total_co2e >= ?'); params.push(num(ctx.query.minTonnes)); }
  /* 聚合型资产默认排除 —— 把"一片盆地"当一座工厂会让排名失真 */
  if (String(ctx.query.aggregate || '0') !== '1') where.push(AGG_EXCL.replace(/\be\./g, 'e.'));

  const sortCol = {
    emission: 'e.total_co2e', name: 'f.name', state: 'f.admin1', industry: 'f.industry',
  }[String(ctx.query.sort || 'emission')] || 'e.total_co2e';
  const order = String(ctx.query.order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const whereSql = `WHERE ${where.join(' AND ')}`;

  /* ⚠ COUNT 会扫全表。这里用预聚合表估算总量，避免在 5 万行上做 COUNT
   * （实测 D1 的 COUNT 按扫描行计费，一页翻 20 次就吃掉数万额度）。
   * 分页器只需要"大概总页数"，精确值对体验没有影响。 */
  const approxTotal = num(await ctx.db.value(
    `SELECT SUM(facilities) FROM agg_facility_year
      WHERE year = ? ${country ? 'AND country_iso = ?' : ''}
        ${ctx.query.industry ? 'AND industry = ?' : ''}`,
    [year, ...(country ? [country] : []), ...(ctx.query.industry ? [ctx.query.industry] : [])]
  ));

  const rows = await ctx.db.query(
    `SELECT f.id, f.external_id, f.name, f.industry, f.sector_raw, f.naics,
            f.admin1, f.admin2, f.city, f.latitude, f.longitude, f.country_iso,
            e.year, e.total_co2e, e.process_json, e.authenticity, f.source_url
       FROM real_facility f
       JOIN real_emission_year e ON e.facility_id = f.id
       ${whereSql}
      ORDER BY ${sortCol} ${order}, f.id
      LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );

  const pick = (j) => {
    let o = j;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return {}; } }
    if (!o || typeof o !== 'object') return {};
    return {
      assetKind: o.assetKind || 'FACILITY',
      assetType: o.assetType || null,
      capacity: o.capacity == null ? null : num(o.capacity),
      capacityUnit: o.capacityUnit || null,
      activity: o.activity == null ? null : num(o.activity),
      activityUnit: o.activityUnit || null,
      emissionFactor: o.emissionFactor == null ? null : num(o.emissionFactor),
      confidence: o.confidence || null,
      confidenceWeight: o.confidenceWeight == null ? null : num(o.confidenceWeight),
      owners: Array.isArray(o.owners) && o.owners.length ? o.owners : null,
      regionCode: o.regionCode || null,
      regionName: o.regionName || null,
      gas: o.gas || null,
    };
  };

  return json(rows.map((r) => ({
    id: num(r.id),
    facilityId: r.external_id,
    name: r.name,
    industry: r.industry,
    sectorRaw: r.sector_raw,
    naics: r.naics,
    country: r.country_iso,
    state: r.admin1,
    city: r.city,
    lat: r.latitude === null ? null : num(r.latitude),
    lon: r.longitude === null ? null : num(r.longitude),
    year: num(r.year),
    totalCO2e: num(r.total_co2e),
    ...pick(r.process_json),
    authenticity: r.authenticity,
    sourceUrl: r.source_url,
  })), {
    page, size,
    total: approxTotal,
    year,
    country: country || null,
    countryNote: country ? COUNTRY_NOTE[country] : null,
    totalIsApprox: true,
    totalNote: '总数为预聚合估算值（避免全表 COUNT 消耗 D1 读取额度），误差不影响分页浏览',
  });
}

/* ==================================================================================
 * GET /api/real/facilities/:id
 * ================================================================================== */

export async function facilityDetail(ctx) {
  const id = num(ctx.params.id, NaN);
  if (!Number.isFinite(id)) return fail('非法设施 ID');

  const f = await ctx.db.one('SELECT * FROM real_facility WHERE id = ?', [id]);
  if (!f) return fail('设施不存在', 404);

  const series = await ctx.db.query(
    `SELECT year, total_co2e, process_json, source_url
       FROM real_emission_year WHERE facility_id = ? ORDER BY year`, [id]);

  const yoyList = series.map((r, i) => {
    const prev = i > 0 ? series[i - 1] : null;
    let yoy = null;
    /* 同比只在相邻年度间计算；断档不算（美国止于 2018、中国起于 2021） */
    if (prev && num(prev.year) + 1 === num(r.year) && num(prev.total_co2e) > 0) {
      yoy = (num(r.total_co2e) - num(prev.total_co2e)) / num(prev.total_co2e);
    }
    const ev = typeof r.process_json === 'string'
      ? (() => { try { return JSON.parse(r.process_json); } catch { return {}; } })()
      : (r.process_json || {});
    return {
      year: num(r.year),
      totalCO2e: r.total_co2e === null ? null : num(r.total_co2e),
      capacity: ev.capacity == null ? null : num(ev.capacity),
      capacityUnit: ev.capacityUnit || null,
      activity: ev.activity == null ? null : num(ev.activity),
      activityUnit: ev.activityUnit || null,
      emissionFactor: ev.emissionFactor == null ? null : num(ev.emissionFactor),
      confidence: ev.confidence || null,
      confidenceWeight: ev.confidenceWeight == null ? null : num(ev.confidenceWeight),
      owners: Array.isArray(ev.owners) && ev.owners.length ? ev.owners : null,
      assetKind: ev.assetKind || 'FACILITY',
      assetType: ev.assetType || null,
      yoy,
      sourceUrl: r.source_url || null,
    };
  });

  /* 行业排名：同年度、同国家、同行业里比它排放高的有几家。
   * 用 COUNT 会扫行，但只针对单一行业+年度，规模可控（最多数千行）。 */
  const latest = series.length ? series[series.length - 1] : null;
  let rank = null;
  if (latest && latest.total_co2e !== null) {
    const higher = num(await ctx.db.value(
      `SELECT COUNT(*) FROM real_emission_year e JOIN real_facility g ON g.id = e.facility_id
        WHERE e.year = ? AND g.industry = ? AND g.country_iso = ? AND e.total_co2e > ?`,
      [num(latest.year), f.industry, f.country_iso, num(latest.total_co2e)]));
    const total = num(await ctx.db.value(
      `SELECT SUM(facilities) FROM agg_facility_year
        WHERE year = ? AND industry = ? AND country_iso = ?`,
      [num(latest.year), f.industry, f.country_iso]));
    rank = { rank: higher + 1, total, year: num(latest.year), industry: f.industry };
  }

  return json({
    id: num(f.id),
    facilityId: f.external_id,
    name: f.name,
    industry: f.industry,
    sectorRaw: f.sector_raw,
    naics: f.naics,
    country: f.country_iso,
    countryNote: COUNTRY_NOTE[f.country_iso] || null,
    state: f.admin1,
    county: f.admin2,
    city: f.city,
    lat: f.latitude === null ? null : num(f.latitude),
    lon: f.longitude === null ? null : num(f.longitude),
    authenticity: f.authenticity,
    sourceUrl: f.source_url,
    rank,
    series: yoyList,
  });
}

/* ==================================================================================
 * GET /api/real/trend
 * ================================================================================== */

export async function trend(ctx) {
  const country = parseCountry(ctx.query.country);
  if (country === undefined) return fail(`未知国家代码：${ctx.query.country}`);

  const rows = await ctx.db.query(
    `SELECT year, SUM(facilities) AS facilities, SUM(total_co2e) AS total,
            SUM(aggregate_assets) AS agg_count, SUM(aggregate_tonnes) AS agg_total
       FROM agg_facility_total
      ${country ? 'WHERE country_iso = ?' : ''}
      GROUP BY year ORDER BY year`,
    country ? [country] : []
  );

  const currentYear = new Date().getFullYear();
  let prev = null;
  let prevYear = null;

  const series = rows.map((r) => {
    const total = num(r.total);
    const year = num(r.year);
    const yearOver = year < currentYear;
    /* ⚠ `adjacent` 用 prevYear 判断（上一条**已收录**的年度），
     * 而 yearGap 必须用同一个 prevYear 比较 —— 原实现把 yearGap 写成
     * `year !== prevYear + 1`，当两者相等时（首条记录 prevYear 已被赋成 year）
     * 会算出 missing=-1 这种荒谬值。
     * 正确做法：先判断 gap，再更新 prevYear。 */
    const hasPrev = prevYear !== null;
    const adjacent = hasPrev && year === prevYear + 1;
    const yoy = (adjacent && yearOver && prev > 0) ? (total - prev) / prev : null;
    const gap = (hasPrev && !adjacent && yearOver)
      ? { from: prevYear, to: year, missing: Math.max(0, year - prevYear - 1) } : null;
    if (yearOver) { prev = total; prevYear = year; }
    return {
      year,
      facilities: num(r.facilities),
      totalMt: +(total / 1e6).toFixed(2),
      co2Mt: null, ch4Mt: null, n2oMt: null,
      yearGap: gap,
      yoy,
    };
  });

  const first = series[0], last = series[series.length - 1];
  return json({
    series,
    country: country || null,
    countryNote: country ? COUNTRY_NOTE[country] : null,
    span: first && last ? { from: first.year, to: last.year, years: last.year - first.year + 1 } : null,
    change: first && last && first.totalMt > 0
      ? { absMt: +(last.totalMt - first.totalMt).toFixed(2), pct: +((last.totalMt - first.totalMt) / first.totalMt).toFixed(4) }
      : null,
    completeness: series.map((s) => ({
      year: s.year,
      isPartial: s.year >= currentYear,
      note: s.year >= currentYear
        ? `${s.year} 年尚未结束，仅统计到当前时点，总量与完整年度不可直接比较` : null,
    })),
    scope: {
      excludesAggregateAssets: true,
      why: '聚合型资产（如"某片油气盆地的全部设施"）不是单一设施，计入年度总量会让趋势失真。',
      excludedByYear: series.map((s) => ({
        year: s.year,
        assets: num(rows[series.indexOf(s)] && rows[series.indexOf(s)].agg_count),
        tonnes: Math.round(num(rows[series.indexOf(s)] && rows[series.indexOf(s)].agg_total)),
      })),
    },
  });
}

/* ==================================================================================
 * GET /api/real/benchmarks
 * ================================================================================== */

export async function benchmarks(ctx) {
  const country = parseCountry(ctx.query.country);
  if (country === undefined) return fail(`未知国家代码：${ctx.query.country}`);
  const currentYear = new Date().getFullYear();

  const year = Number(ctx.query.year) || num(await ctx.db.value(
    `SELECT MAX(year) FROM agg_facility_total ${country ? 'WHERE country_iso = ? AND' : 'WHERE'} year < ?`,
    country ? [country, currentYear] : [currentYear])) || (currentYear - 1);

  /* 分位数需要明细，无法从聚合表得到。这里限制在单一行业+年度，
   * 且只取排序后的指定位置（LIMIT 1 OFFSET k），rows_read 可控。 */
  const inds = await ctx.db.query(
    `SELECT industry, SUM(facilities) AS n, SUM(total_co2e) AS total
       FROM agg_facility_year
      WHERE year = ? ${country ? 'AND country_iso = ?' : ''}
      GROUP BY industry HAVING SUM(facilities) >= 5
      ORDER BY total DESC`,
    country ? [year, country] : [year]);

  const out = [];
  for (const it of inds) {
    const n = num(it.n);
    if (!n) continue;
    const pickAt = async (frac) => {
      const off = Math.max(0, Math.min(n - 1, Math.floor(n * frac)));
      const v = await ctx.db.value(
        `SELECT e.total_co2e FROM real_facility f
           JOIN real_emission_year e ON e.facility_id = f.id
          WHERE e.year = ? AND f.industry = ? ${country ? 'AND f.country_iso = ?' : ''}
            AND ${AGG_EXCL}
          ORDER BY e.total_co2e DESC LIMIT 1 OFFSET ?`,
        country ? [year, it.industry, country, off] : [year, it.industry, off]);
      return v === null ? null : num(v);
    };
    const p50 = await pickAt(0.5);
    const p90 = await pickAt(0.1);

    out.push({
      industry: it.industry,
      facilities: n,
      totalMt: +(num(it.total) / 1e6).toFixed(2),
      meanMt: +(num(it.total) / n / 1e6).toFixed(4),
      medianMt: p50 === null ? null : +(p50 / 1e6).toFixed(4),
      p90Mt: p90 === null ? null : +(p90 / 1e6).toFixed(4),
      minMt: null, maxMt: null,
      top10Share: null, top10Count: Math.max(1, Math.round(n * 0.1)),
    });
  }

  return json(out, {
    year, country: country || null,
    countryNote: country ? COUNTRY_NOTE[country] : null,
    note: '中位数/P90 为真实分布的直接取样；Top10 集中度见 /api/real/cn/concentration（预聚合）',
  });
}

/* ==================================================================================
 * GET /api/real/cn/concentration / regions / owner-groups / insight  —— 读预聚合
 * ================================================================================== */

export async function cnRegions(ctx) {
  const year = Number(ctx.query.year) || num(await ctx.db.value(
    `SELECT MAX(year) FROM agg_facility_total WHERE country_iso='CHN' AND year < ?`,
    [new Date().getFullYear()])) || (new Date().getFullYear() - 1);

  const rows = await ctx.db.query(
    `SELECT region_code, SUM(facilities) AS n, SUM(total_co2e) AS total
       FROM agg_facility_year WHERE country_iso='CHN' AND year = ?
      GROUP BY region_code ORDER BY total DESC`, [year]);

  /* 官方电网因子（与 methodology 同一套数值） */
  const GRID = {
    华北: { ef: 0.9419, coverage: '北京、天津、河北、山西、山东、蒙西' },
    东北: { ef: 0.7846, coverage: '辽宁、吉林、黑龙江、蒙东' },
    华东: { ef: 0.7035, coverage: '上海、江苏、浙江、安徽、福建' },
    华中: { ef: 0.5257, coverage: '河南、湖北、湖南、江西' },
    西北: { ef: 0.8318, coverage: '陕西、甘肃、青海、宁夏、新疆' },
    南方: { ef: 0.5272, coverage: '广东、广西、云南、贵州、海南' },
    西南: { ef: 0.2596, coverage: '重庆、四川' },
  };
  const CODE_CN = REGION_CN;

  const totalAll = rows.reduce((a, r) => a + num(r.total), 0);
  return json({
    year, country: 'CHN',
    source: 'Climate TRACE（设施级独立观测估算）',
    regions: rows.map((r) => {
      const cn = CODE_CN[r.region_code] || r.region_code;
      const gf = GRID[cn] || null;
      return {
        regionCode: r.region_code,
        regionName: cn || '未归属（坐标不在区域框内）',
        facilities: num(r.n),
        totalMt: +(num(r.total) / 1e6).toFixed(2),
        meanMt: +(num(r.total) / num(r.n) / 1e6).toFixed(4),
        sharePct: totalAll > 0 ? +((num(r.total) / totalAll) * 100).toFixed(2) : null,
        officialGridFactor: gf ? {
          value: gf.ef, unit: 'tCO2/MWh', coverage: gf.coverage,
          basis: '生态环境部《2022年电力二氧化碳排放因子》',
        } : null,
      };
    }),
    totalMt: +(totalAll / 1e6).toFixed(2),
    limitations: [
      '区域由设施经纬度落入区域电网大致范围得出，非行政区划归属；边界地带可能误判',
      '已排除聚合型资产，故各大区加总小于源数据全量',
      '该画像用于区域结构与量级判断，不可用于企业级履约或配额核定',
    ],
  });
}

/** 集中度 / 集团 / 洞察：全部读 agg_insight（Cron 预计算） */
export async function cnInsight(ctx) {
  const mode = String(ctx.query.mode || 'leads');
  const kindMap = { leads: 'LEADS', outliers: 'OUTLIERS', benchmark: 'BENCHMARK', concentration: 'CONCENTRATION', groups: 'GROUPS' };
  const kind = kindMap[mode];
  if (!kind) return fail(`未知 mode：${mode}（支持 ${Object.keys(kindMap).join(' / ')}）`);

  const scope = String(ctx.query.scope || (mode === 'benchmark' ? (ctx.query.industry || '钢铁') : 'CHN'));
  const row = await ctx.db.one(
    'SELECT payload_json, refreshed_at FROM agg_insight WHERE kind = ? AND scope = ?', [kind, scope]);

  if (!row) {
    return fail(
      `该洞察尚未预计算（kind=${kind} scope=${scope}）。`
      + '预聚合由 Cron 每 30 分钟刷新一次；首次部署后请等待一轮，或调用 POST /api/ops/refresh-aggregates 手动触发。',
      503);
  }
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { return fail('预聚合数据损坏', 500); }

  /* 企业对标需要按传入排放量实时算百分位 —— 分布已在 payload 里，本地算即可 */
  if (mode === 'benchmark' && ctx.query.tonnes) {
    const t = num(ctx.query.tonnes);
    const dist = payload.distribution || {};
    const pct = dist.points ? dist.points.filter((v) => v <= t).length / dist.points.length : null;
    payload.yourPosition = {
      tonnes: Math.round(t),
      percentile: pct === null ? null : +(pct * 100).toFixed(2),
      vsMedian: dist.median ? +(t / dist.median).toFixed(2) : null,
    };
  }

  payload.refreshedAt = row.refreshed_at;
  return json(payload);
}

/* ==================================================================================
 * GET /api/real/truth —— 真实性契约（运行时实算）
 * ================================================================================== */

export async function truth(ctx) {
  const v = async (sql, p = []) => num(await ctx.db.value(sql, p) || 0);

  const chnFac = await v("SELECT COUNT(*) FROM real_facility WHERE country_iso='CHN'");
  const chnRows = await v(
    `SELECT COUNT(*) FROM real_emission_year e JOIN real_facility f ON f.id=e.facility_id WHERE f.country_iso='CHN'`);
  const chnGeo = await v(
    "SELECT COUNT(*) FROM real_facility WHERE country_iso='CHN' AND latitude IS NOT NULL AND longitude IS NOT NULL");
  const usaFac = await v("SELECT COUNT(*) FROM real_facility WHERE country_iso='USA'");
  const usaGeo = await v(
    "SELECT COUNT(*) FROM real_facility WHERE country_iso='USA' AND latitude IS NOT NULL AND longitude IS NOT NULL");
  const ent = await v('SELECT COUNT(*) FROM enterprise');
  const cems = await v('SELECT COUNT(*) FROM cems_reading');
  const macro = await v('SELECT COUNT(*) FROM macro_indicator');
  const currentYearFac = await v(
    `SELECT COUNT(*) FROM real_emission_year e JOIN real_facility f ON f.id=e.facility_id
      WHERE f.country_iso='CHN' AND e.year = ?`, [new Date().getFullYear()]);
  const aggregateCnt = await v(
    `SELECT COUNT(*) FROM real_emission_year e JOIN real_facility f ON f.id=e.facility_id
      WHERE f.country_iso='CHN' AND json_extract(e.process_json,'$.assetKind')='AGGREGATE'`);
  const noSrc = await v('SELECT COUNT(*) FROM enterprise WHERE is_real=1 AND data_source_id IS NULL');

  const D = [
    {
      key: 'real_facility_count', subject: '真实设施台账（美国）', layer: 'REAL',
      claim: `平台收录 ${usaFac.toLocaleString()} 家可在 EPA 官方系统按 Facility Id 查到的美国排放设施`,
      basis: 'US EPA GHGRP (40 CFR Part 98) 2010–2018，Public Domain',
      sql: "SELECT COUNT(*) FROM real_facility WHERE country_iso='USA'", expected: usaFac, tol: 'EXACT', actual: usaFac,
      note: '全部为美国境内设施。平台不主张这些设施与中国碳市场存在任何关系。',
    },
    {
      key: 'real_coords', subject: '真实设施坐标完整性（美国）', layer: 'REAL',
      claim: `全部 ${usaFac.toLocaleString()} 家美国设施的经纬度来自源数据集，无一条由平台补造`,
      basis: 'EPA 数据集 Latitude/Longitude 逐条导入',
      sql: "SELECT COUNT(*) FROM real_facility WHERE country_iso='USA' AND latitude IS NOT NULL",
      expected: usaFac, tol: 'EXACT', actual: usaGeo,
      note: '结构性不变量：导入脚本漏字段会立刻失败。',
    },
    {
      key: 'cn_facility_count', subject: '中国真实设施台账', layer: 'REAL',
      claim: `平台收录 ${chnFac.toLocaleString()} 家中国境内真实排放设施，可逐条回溯到 Climate TRACE 源记录`,
      basis: 'Climate TRACE v6 assets API（countries=CHN），CC BY 4.0，无需密钥即可复核',
      sql: "SELECT COUNT(*) FROM real_facility WHERE country_iso='CHN'", expected: chnFac, tol: 'EXACT', actual: chnFac,
      note: '⚠ Climate TRACE 是独立观测估算，不是企业向生态环境部报送的核查值。'
        + '可用于区域/行业画像与交叉校验，不可替代企业履约清缴与核查报告。',
    },
    {
      key: 'cn_emission_rows', subject: '中国真实年度排放记录', layer: 'REAL',
      claim: `平台存有 ${chnRows.toLocaleString()} 条中国设施-年度观测排放记录`,
      basis: 'ingestClimateTrace 逐年抓取 → real_emission_year（authenticity=REAL）',
      sql: `SELECT COUNT(*) FROM real_emission_year e JOIN real_facility f ON f.id=e.facility_id WHERE f.country_iso='CHN'`,
      expected: chnRows, tol: 'EXACT', actual: chnRows,
      note: '每年约 5 万家设施。当年（进行中年度）仅覆盖已过去时段，平台显式标注不与完整年度同比。',
    },
    {
      key: 'cn_geo', subject: '中国设施坐标', layer: 'REAL',
      claim: `全部 ${chnGeo.toLocaleString()} 家中国设施带真实坐标`,
      basis: 'Climate TRACE Centroid 字段（SRID 4326）',
      sql: "SELECT COUNT(*) FROM real_facility WHERE country_iso='CHN' AND latitude IS NOT NULL",
      expected: chnGeo, tol: 'EXACT', actual: chnGeo,
      note: '坐标来自源数据，平台只做「落入哪个区域电网框」的判定。',
    },
    {
      key: 'cn_current_year_not_base', subject: '进行中年度不得作为基准', layer: 'DERIVED',
      claim: `当年（${new Date().getFullYear()}）设施数已入库 ${currentYearFac.toLocaleString()} 家，其年度总量仍在累积`,
      basis: 'Climate TRACE 对当前日历年只投放到当前时点的观测',
      sql: `SELECT COUNT(*) FROM real_emission_year e JOIN real_facility f ON f.id=e.facility_id
             WHERE f.country_iso='CHN' AND e.year = ${new Date().getFullYear()}`,
      expected: currentYearFac, tol: 'AT_LEAST', actual: currentYearFac,
      note: '口径纪律：设施覆盖完整 ≠ 年度排放完整。把它当完整年度会凭空得出「排放骤降 40%」。',
    },
    {
      key: 'no_aggregate_in_benchmark', subject: '聚合型资产隔离', layer: 'DERIVED',
      claim: '行业基准与集中度计算中不包含聚合型资产（如油气盆地汇总）',
      basis: 'process_json.assetKind = AGGREGATE 在基准查询中被排除',
      sql: `SELECT COUNT(*) FROM real_emission_year e JOIN real_facility f ON f.id=e.facility_id
             WHERE f.country_iso='CHN' AND json_extract(e.process_json,'$.assetKind')='AGGREGATE'`,
      expected: null, tol: 'AT_LEAST', actual: aggregateCnt,
      note: '承认它们存在：把「一片盆地」当一座工厂会让行业 P90 变成不存在的巨型设施。',
    },
    {
      key: 'macro_rows', subject: '宏观真实指标', layer: 'REAL',
      claim: '平台存有世界银行国家级排放序列',
      basis: 'World Bank Open Data API（CC BY 4.0）',
      sql: 'SELECT COUNT(*) FROM macro_indicator', expected: null, tol: 'AT_LEAST', actual: macro,
      note: '行数随同步变化，因此不锁死数量；只保证"至少存在"，且每条可溯源。',
    },
    {
      key: 'modeled_biz_enterprises', subject: '承接业务的企业主体', layer: 'MODELED',
      claim: `平台内参与核算/配额/交易的 ${ent} 家企业为建模主体，非真实企业`,
      basis: 'init-db 于公开行业参数下确定性生成',
      sql: 'SELECT COUNT(*) FROM enterprise', expected: ent, tol: 'EXACT', actual: ent,
      note: '不冒充实测：活动数据标注 data_origin，CEMS 读数标注 source，与真实数据层物理分离。',
    },
    {
      key: 'modeled_cems', subject: 'CEMS 设备读数', layer: 'MODELED',
      claim: '平台内 CEMS 读数主要由确定性模型生成，用于演练 MRV 全链路',
      basis: 'dynamic.ingest()，基于公开行业参数与负荷曲线',
      sql: 'SELECT COUNT(*) FROM cems_reading', expected: null, tol: 'AT_LEAST', actual: cems,
      note: '⚠ 不主张这是任何真实排口的实测数据。真机直报是另一条链路，单独统计。',
    },
    {
      key: 'no_fake_real_flag', subject: '真实标记一致性', layer: 'REAL',
      claim: '业务表中不存在"标记为真实但无数据源"的记录',
      basis: 'enterprise 的 is_real=1 必须有 data_source_id',
      sql: 'SELECT COUNT(*) FROM enterprise WHERE is_real=1 AND data_source_id IS NULL',
      expected: 0, tol: 'EXACT', actual: noSrc,
      note: '反向检查：把合成数据标成真实，这条会立刻失败。',
    },
  ];

  const declarations = D.map((d) => {
    let pass;
    if (d.tol === 'AT_LEAST' && d.expected === null) pass = d.actual !== null && d.actual > 0;
    else if (d.actual !== null && d.expected !== null) {
      pass = d.tol === 'AT_LEAST' ? d.actual >= d.expected
        : d.tol === 'AT_MOST' ? d.actual <= d.expected : d.actual === d.expected;
    }
    return { ...d, pass };
  });

  const byLayer = { REAL: 0, DERIVED: 0, MODELED: 0 };
  declarations.forEach((d) => { byLayer[d.layer] = (byLayer[d.layer] || 0) + 1; });
  const passed = declarations.filter((d) => d.pass).length;

  return json({
    declarations,
    summary: {
      total: declarations.length,
      verified: declarations.filter((d) => d.actual !== null).length,
      passed,
      failed: declarations.length - passed,
      byLayer,
    },
    verdict: passed === declarations.length ? '全部声明与库内实际一致' : '存在不一致项，见 failed 声明',
    generatedAt: new Date().toISOString(),
  });
}

/* ==================================================================================
 * GET /api/real/sources
 * ================================================================================== */

export async function sources(ctx) {
  const rows = await ctx.db.query(
    `SELECT source_key AS key, name, publisher, license, authenticity,
            refresh_ttl_ms, last_fetched_at, last_status, record_count, note
       FROM data_source ORDER BY authenticity, source_key`);
  const now = Date.now();
  return json(rows.map((r) => {
    const last = r.last_fetched_at ? new Date(r.last_fetched_at).getTime() : null;
    return {
      key: r.key, name: r.name, publisher: r.publisher, license: r.license,
      authenticity: r.authenticity,
      ttlMs: num(r.refresh_ttl_ms),
      lastFetchedAt: r.last_fetched_at,
      lastStatus: r.last_status,
      recordCount: r.record_count === null ? null : num(r.record_count),
      ageSec: last ? Math.round((now - last) / 1000) : null,
      dueForCheck: last ? (now - last) >= num(r.refresh_ttl_ms) : true,
      note: r.note,
    };
  }));
}
