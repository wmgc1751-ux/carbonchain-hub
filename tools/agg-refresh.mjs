#!/usr/bin/env node
/**
 * tools/agg-refresh.mjs —— 真实数据层聚合表的物化与核验
 * ==================================================================
 * 解决什么
 * ------------------------------------------------------------------
 * `/api/real/overview` 冷启动要 5.5 秒 —— 因为它对 33.9 万行做全表聚合。
 * 这些聚合值描述的是**已发生的历史事实**（2024 年的排放合计不会变），
 * 每次请求重算一遍纯属浪费。本工具把它们物化进 agg_* 表。
 *
 * 两条硬规矩
 * ------------------------------------------------------------------
 *   ① **只物化源表能算出来的值**。这里不引入任何新口径、不做任何平滑，
 *      每一条都是可直接用 SQL 重算验证的聚合结果。
 *   ② **可核验优先于快**。`--verify` 会丢掉物化表、从源表重算一遍，
 *      再与物化结果逐项比对；任何不一致都退出码 1。
 *      物化表存在的意义是"快并诚实"，不是"快并不可查"。
 *
 * 用法
 *   node tools/agg-refresh.mjs            # 物化（幂等，可重复执行）
 *   node tools/agg-refresh.mjs --verify   # 重算并比对，不一致即失败
 *   node tools/agg-refresh.mjs --status   # 只看当前物化状态与覆盖
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tools', 'out');
const ARGV = process.argv.slice(2);
const VERIFY = ARGV.includes('--verify');
const STATUS = ARGV.includes('--status');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.trim().match(/^([\w.]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const E = { ...readEnv(path.join(ROOT, '.env')), ...process.env };
const DB = {
  host: E.DB_HOST || '127.0.0.1',
  port: Number(E.DB_PORT || 3306),
  user: E.DB_USER || 'root',
  password: E.DB_PASSWORD || '',
  database: E.DB_NAME || 'carbon_chain',
  multipleStatements: false,
};

/** 国家维度：空串代表"全部"，另按两国分别物化 */
const COUNTRY_SCOPES = ['', 'CHN', 'USA'];

/* ------------------------------------------------------------------ */
/* 建表                                                                */
/* ------------------------------------------------------------------ */
async function ensureSchema(conn) {
  const sql = fs.readFileSync(path.join(ROOT, 'db', '06_schema_agg.sql'), 'utf8')
    .replace(/^\s*--.*$/gm, '');
  for (const s of sql.split(';').map((x) => x.trim()).filter((x) => x.length > 10)) {
    await conn.query(s);
  }
}

/* ------------------------------------------------------------------ */
/* 计算（源表 → 结果集）。物化与核验共用同一个计算函数，保证口径一致 */
/* ------------------------------------------------------------------ */
async function computeTotals(conn, country) {
  const cf = country ? 'AND f.country_iso = ?' : '';
  const cp = country ? [country] : [];
  /* 一次扫描同时算出：总量、聚合型资产行数、三种气体分项（均排除聚合资产）。
   * 分三次查会让 4 秒的全表扫描做三遍 —— /trend 之前就是这么慢的。 */
  const AGGK = "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.process_json,'$.assetKind')),'FACILITY')";
  const [rows] = await conn.query(
    `SELECT e.year                                        AS year,
            COUNT(*)                                      AS facility_rows,
            COUNT(DISTINCT e.facility_id)                 AS facilities,
            COALESCE(SUM(e.total_co2e),0)                 AS total_co2e,
            SUM(${AGGK} = 'AGGREGATE')                     AS aggregate_rows,
            COALESCE(SUM(CASE WHEN ${AGGK} <> 'AGGREGATE' THEN e.total_co2e  ELSE 0 END),0) AS total_excl_agg,
            COALESCE(SUM(CASE WHEN ${AGGK} <> 'AGGREGATE' THEN e.co2         ELSE 0 END),0) AS co2_excl_agg,
            COALESCE(SUM(CASE WHEN ${AGGK} <> 'AGGREGATE' THEN e.ch4_co2e    ELSE 0 END),0) AS ch4_excl_agg,
            COALESCE(SUM(CASE WHEN ${AGGK} <> 'AGGREGATE' THEN e.n2o_co2e    ELSE 0 END),0) AS n2o_excl_agg
       FROM real_emission_year e
       JOIN real_facility f ON f.id = e.facility_id
      WHERE 1=1 ${cf}
      GROUP BY e.year ORDER BY e.year`,
    cp
  );
  return rows.map((r) => ({
    year: Number(r.year),
    facility_rows: Number(r.facility_rows),
    facilities: Number(r.facilities),
    total_co2e: Number(r.total_co2e),
    aggregate_rows: Number(r.aggregate_rows),
    total_excl_agg: Number(r.total_excl_agg),
    co2_excl_agg: Number(r.co2_excl_agg),
    ch4_excl_agg: Number(r.ch4_excl_agg),
    n2o_excl_agg: Number(r.n2o_excl_agg),
  }));
}

async function computeIndustry(conn, country) {
  const cf = country ? 'AND f.country_iso = ?' : '';
  const cp = country ? [country] : [];
  /* ⚠ 必须排除聚合型资产：它们代表"一片盆地的全部设施"，且排放值多为
   * **负值抵扣项**（2025 年合计 -453.76 Mt，用于避免重复计算）。
   * 混进行业排行会让某些行业出现负排放，而"行业之和"也会与
   * 单一设施口径的年度总量差出 400 多 Mt。
   * 原始实现（优化前）就是排除的，物化必须保持同一口径。 */
  const [rows] = await conn.query(
    `SELECT e.year AS year, f.industry AS industry,
            COUNT(DISTINCT f.id) AS facilities,
            COALESCE(SUM(e.total_co2e),0) AS total_co2e
       FROM real_emission_year e
       JOIN real_facility f ON f.id = e.facility_id
      WHERE 1=1 ${cf} AND e.asset_kind = 'FACILITY'
      GROUP BY e.year, f.industry`,
    cp
  );
  return rows.map((r) => ({
    year: Number(r.year), industry: r.industry,
    facilities: Number(r.facilities), total_co2e: Number(r.total_co2e),
  }));
}

/**
 * 行业分布统计（含分位数）。
 * 用 ROW_NUMBER 一次算完，避免 /benchmarks 原先"每行业 3 次 LIMIT/OFFSET"
 * 造成的 24 次大表扫描（实测 3.2s）。
 *
 * 分位数定义与原来一致：降序排列后取第 floor(n*0.5)+1 行（P50）、floor(n*0.1)+1 行（P90）。
 * 保留"取行"而不是线性插值，是为了与历史结果逐位可比 —— 改口径会让页面上
 * 的"行业基准"数字整体变动，读者会以为数据被改了。
 */
async function computeIndustryStats(conn, country, year) {
  const cf = country ? 'AND f.country_iso = ?' : '';
  const cp = country ? [country] : [];
  const AGGK = "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.process_json,'$.assetKind')),'FACILITY')";
  const [rows] = await conn.query(
    `WITH ranked AS (
       SELECT f.industry, e.total_co2e AS v,
              ROW_NUMBER() OVER (PARTITION BY f.industry ORDER BY e.total_co2e DESC) AS rn,
              COUNT(*) OVER (PARTITION BY f.industry)   AS n,
              SUM(e.total_co2e) OVER (PARTITION BY f.industry) AS tot,
              AVG(e.total_co2e) OVER (PARTITION BY f.industry) AS avgv,
              MIN(e.total_co2e) OVER (PARTITION BY f.industry) AS minv,
              MAX(e.total_co2e) OVER (PARTITION BY f.industry) AS maxv
         FROM real_facility f
         JOIN real_emission_year e ON e.facility_id = f.id
        WHERE e.year = ? ${cf} AND ${AGGK} <> 'AGGREGATE'
     )
     SELECT industry, MAX(n) n, MAX(tot) total, MAX(avgv) mean, MAX(minv) minv, MAX(maxv) maxv,
            MAX(CASE WHEN rn = FLOOR(n*0.5)+1 THEN v END) p50,
            MAX(CASE WHEN rn = FLOOR(n*0.1)+1 THEN v END) p90,
            SUM(CASE WHEN rn <= GREATEST(1, ROUND(n*0.1)) THEN v ELSE 0 END) top10,
            MAX(GREATEST(1, ROUND(n*0.1))) top10n
       FROM ranked GROUP BY industry ORDER BY total DESC`,
    [year, ...cp]
  );
  return rows.map((r) => ({
    industry: r.industry,
    facilities: Number(r.n),
    total_co2e: Number(r.total),
    mean_co2e: Number(r.mean),
    min_co2e: Number(r.minv),
    max_co2e: Number(r.maxv),
    p50_co2e: r.p50 === null ? null : Number(r.p50),
    p90_co2e: r.p90 === null ? null : Number(r.p90),
    top10_co2e: Number(r.top10),
    top10_count: Number(r.top10n),
  }));
}

async function computeRegion(conn, country) {
  const cf = country ? 'AND f.country_iso = ?' : '';
  const cp = country ? [country] : [];
  const [rows] = await conn.query(
    `SELECT e.year AS year, f.admin1 AS region_code,
            COUNT(DISTINCT f.id) AS facilities,
            COALESCE(SUM(e.total_co2e),0) AS total_co2e
       FROM real_emission_year e
       JOIN real_facility f ON f.id = e.facility_id
      WHERE 1=1 ${cf} AND e.asset_kind = 'FACILITY'
      GROUP BY e.year, f.admin1`,
    cp
  );
  return rows.map((r) => ({
    year: Number(r.year), region_code: r.region_code,
    facilities: Number(r.facilities), total_co2e: Number(r.total_co2e),
  }));
}

/* ------------------------------------------------------------------ */
/* 物化                                                                */
/* ------------------------------------------------------------------ */
async function refresh(conn) {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  真实数据层聚合物化');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  库 ${DB.user}@${DB.host}:${DB.port}/${DB.database}`);
  const t0 = Date.now();
  for (const country of COUNTRY_SCOPES) {
    const label = country || 'ALL';
    const totals = await computeTotals(conn, country);
    const inds = await computeIndustry(conn, country);
    const regs = await computeRegion(conn, country);

    await conn.query('DELETE FROM agg_emission_total WHERE country_iso = ?', [country]);
    if (totals.length) {
      await conn.query(
        `INSERT INTO agg_emission_total
           (country_iso, year, facility_rows, facilities, total_co2e, aggregate_rows,
            total_excl_agg, co2_excl_agg, ch4_excl_agg, n2o_excl_agg)
         VALUES ${totals.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
        totals.flatMap((r) => [country, r.year, r.facility_rows, r.facilities, r.total_co2e, r.aggregate_rows,
          r.total_excl_agg, r.co2_excl_agg, r.ch4_excl_agg, r.n2o_excl_agg])
      );
    }

    await conn.query('DELETE FROM agg_industry_year WHERE country_iso = ?', [country]);
    for (let i = 0; i < inds.length; i += 200) {
      const slice = inds.slice(i, i + 200);
      await conn.query(
        `INSERT INTO agg_industry_year (country_iso, year, industry, facilities, total_co2e)
         VALUES ${slice.map(() => '(?,?,?,?,?)').join(',')}`,
        slice.flatMap((r) => [country, r.year, r.industry, r.facilities, r.total_co2e])
      );
    }

    await conn.query('DELETE FROM agg_region_year WHERE country_iso = ?', [country]);
    for (let i = 0; i < regs.length; i += 200) {
      const slice = regs.slice(i, i + 200);
      await conn.query(
        `INSERT INTO agg_region_year (country_iso, year, region_code, facilities, total_co2e)
         VALUES ${slice.map(() => '(?,?,?,?,?)').join(',')}`,
        slice.flatMap((r) => [country, r.year, r.region_code, r.facilities, r.total_co2e])
      );
    }
    /* 行业分布统计（分位数）—— 仅对"完整年度"物化：
     * 进行中年度（当年）的数据每天在变，物化它会让"分位数"变成过期值，
     * 而这种过期没有任何外部信号能看出来。宁可不物化，让 /benchmarks 回落源表。 */
    const currentYear = new Date().getFullYear();
    let statRows = 0;
    await conn.query('DELETE FROM agg_industry_stats WHERE country_iso = ?', [country]);
    for (const t of totals) {
      if (t.year >= currentYear) continue;
      const stats = await computeIndustryStats(conn, country, t.year);
      if (!stats.length) continue;
      await conn.query(
        `INSERT INTO agg_industry_stats
           (country_iso, year, industry, facilities, total_co2e, mean_co2e, min_co2e, max_co2e,
            p50_co2e, p90_co2e, top10_co2e, top10_count)
         VALUES ${stats.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
        stats.flatMap((r) => [country, t.year, r.industry, r.facilities, r.total_co2e,
          r.mean_co2e, r.min_co2e, r.max_co2e, r.p50_co2e, r.p90_co2e, r.top10_co2e, r.top10_count])
      );
      statRows += stats.length;
    }
    console.log(C.ok(`  ✔ ${label.padEnd(4)} 年度 ${String(totals.length).padStart(3)} · 行业 ${String(inds.length).padStart(4)} · 区域 ${String(regs.length).padStart(4)} · 行业统计 ${String(statRows).padStart(4)}`));
  }

  const meta = {
    refreshed_at: new Date().toISOString(),
    source_rows: String((await conn.query('SELECT COUNT(*) c FROM real_emission_year'))[0][0].c),
    facility_rows: String((await conn.query('SELECT COUNT(*) c FROM real_facility'))[0][0].c),
  };
  for (const [k, v] of Object.entries(meta)) {
    await conn.query(
      'INSERT INTO agg_meta (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      [k, v]
    );
  }
  console.log(C.ok(`\n✔ 物化完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`));
  console.log(C.dim(`  源表 ${meta.source_rows} 行（设施-年度）/ ${meta.facility_rows} 家设施`));
  return meta;
}

/* ------------------------------------------------------------------ */
/* 核验：从源表重算，与物化表逐项比对                                    */
/* ------------------------------------------------------------------ */
async function verify(conn) {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  聚合物化核验（丢掉物化值，从源表重算后比对）');
  console.log('══════════════════════════════════════════════════════════');
  const diffs = [];
  const relTol = 1e-9;   // 浮点求和顺序差异的容差；超出即视为口径不一致
  for (const country of COUNTRY_SCOPES) {
    const label = country || 'ALL';
    const srcTotals = await computeTotals(conn, country);
    const [matTotals] = await conn.query(
      `SELECT year, facility_rows, facilities, total_co2e, aggregate_rows,
              total_excl_agg, co2_excl_agg, ch4_excl_agg, n2o_excl_agg
         FROM agg_emission_total WHERE country_iso = ? ORDER BY year`,
      [country]
    );
    if (srcTotals.length !== matTotals.length) {
      diffs.push(`${label} 年度条数：源 ${srcTotals.length} ≠ 物化 ${matTotals.length}`);
    }
    const matByYear = new Map(matTotals.map((r) => [Number(r.year), r]));
    for (const s of srcTotals) {
      const m = matByYear.get(s.year);
      if (!m) { diffs.push(`${label} ${s.year} 年：物化中缺失`); continue; }
      const mt = Number(m.total_co2e);
      const denom = Math.max(Math.abs(s.total_co2e), 1);
      if (Math.abs(mt - s.total_co2e) / denom > relTol) {
        diffs.push(`${label} ${s.year} 年排放合计：源 ${s.total_co2e} ≠ 物化 ${mt}`);
      }
      if (Number(m.facilities) !== s.facilities) diffs.push(`${label} ${s.year} 年设施数：源 ${s.facilities} ≠ 物化 ${m.facilities}`);
      if (Number(m.facility_rows) !== s.facility_rows) diffs.push(`${label} ${s.year} 年记录数：源 ${s.facility_rows} ≠ 物化 ${m.facility_rows}`);
      /* 气体分项与"排除聚合资产"口径也必须逐项核对 —— 它们服务于 /trend，
       * 只要有一个对不上，页面上的 CO2/CH4/N2O 曲线就是错的。 */
      for (const k of ['total_excl_agg', 'co2_excl_agg', 'ch4_excl_agg', 'n2o_excl_agg']) {
        const a = Number(m[k]), b = Number(s[k]);
        if (Math.abs(a - b) / Math.max(Math.abs(b), 1) > relTol) {
          diffs.push(`${label} ${s.year} 年 ${k}：源 ${b} ≠ 物化 ${a}`);
        }
      }
    }

    /* 行业与区域：按 (year, key) 做全量对照，不只比合计 */
    for (const [table, srcRows, keyCol, keyName] of [
      ['agg_industry_year', await computeIndustry(conn, country), 'industry', '行业'],
      ['agg_region_year', await computeRegion(conn, country), 'region_code', '区域'],
    ]) {
      const [mat] = await conn.query(
        `SELECT year, ${keyCol} AS k, facilities, total_co2e FROM ${table} WHERE country_iso = ?`, [country]
      );
      const mk = new Map(mat.map((r) => [`${r.year}|${r.k}`, r]));
      if (mat.length !== srcRows.length) {
        diffs.push(`${label} ${keyName}条数：源 ${srcRows.length} ≠ 物化 ${mat.length}`);
      }
      for (const s of srcRows) {
        const m = mk.get(`${s.year}|${s[keyCol]}`);
        if (!m) { diffs.push(`${label} ${s.year} ${keyName} ${s[keyCol]}：物化中缺失`); continue; }
        const denom = Math.max(Math.abs(s.total_co2e), 1);
        if (Math.abs(Number(m.total_co2e) - s.total_co2e) / denom > relTol) {
          diffs.push(`${label} ${s.year} ${keyName} ${s[keyCol]} 合计：源 ${s.total_co2e} ≠ 物化 ${m.total_co2e}`);
        }
        if (Number(m.facilities) !== s.facilities) {
          diffs.push(`${label} ${s.year} ${keyName} ${s[keyCol]} 设施数：源 ${s.facilities} ≠ 物化 ${m.facilities}`);
        }
      }
    }
    /* 行业分布统计：逐项与源表重算比对（分位数最容易因排序细节而漂移） */
    const [matStat] = await conn.query(
      `SELECT year, industry, facilities, total_co2e, p50_co2e, p90_co2e, top10_co2e
         FROM agg_industry_stats WHERE country_iso = ?`, [country]
    );
    const statKey = new Map(matStat.map((r) => [`${r.year}|${r.industry}`, r]));
    for (const t of await computeTotals(conn, country)) {
      if (t.year >= new Date().getFullYear()) continue;
      const srcStats = await computeIndustryStats(conn, country, t.year);
      for (const st of srcStats) {
        const m = statKey.get(`${t.year}|${st.industry}`);
        if (!m) { diffs.push(`${label} ${t.year} ${st.industry}：行业统计缺失`); continue; }
        for (const [k, tol] of [['total_co2e', relTol], ['p50_co2e', relTol], ['p90_co2e', relTol], ['top10_co2e', relTol]]) {
          const a = m[k] === null ? null : Number(m[k]);
          const b = st[k];
          if (a === null && b === null) continue;
          if (a === null || b === null || Math.abs(a - b) / Math.max(Math.abs(b), 1) > tol) {
            diffs.push(`${label} ${t.year} ${st.industry} ${k}：源 ${b} ≠ 物化 ${a}`);
          }
        }
      }
    }
    console.log(C.ok(`  ✔ ${label.padEnd(4)} 已比对`));
  }

  const [meta] = await conn.query('SELECT k,v FROM agg_meta');
  const mv = Object.fromEntries(meta.map((r) => [r.k, r.v]));
  console.log(C.dim(`  物化时间 ${mv.refreshed_at || '(未知)'} · 源行数 ${mv.source_rows || '?'}`));

  console.log('\n──────────────────────────────────────────────────────────');
  if (diffs.length) {
    console.log(C.bad(`  ✘ 发现 ${diffs.length} 处不一致：`));
    diffs.slice(0, 20).forEach((d) => console.log(`     · ${d}`));
    if (diffs.length > 20) console.log(C.dim(`     … 另有 ${diffs.length - 20} 处`));
    console.log(C.dim('  物化表与源表口径不一致 —— 请重跑 node tools/agg-refresh.mjs'));
  } else {
    console.log(C.ok('  ✔ 物化值与源表重算结果完全一致'));
  }
  console.log('──────────────────────────────────────────────────────────\n');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'agg-verify.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    ok: diffs.length === 0,
    diffs,
    meta: mv,
  }, null, 2), 'utf8');
  return diffs.length === 0;
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
async function status(conn) {
  const [meta] = await conn.query('SELECT k,v FROM agg_meta');
  const mv = Object.fromEntries(meta.map((r) => [r.k, r.v]));
  console.log(`\n  物化时间　${mv.refreshed_at || C.warn('(从未物化)')}`);
  console.log(`  源表行数　${mv.source_rows || '?'}（设施-年度） / ${mv.facility_rows || '?'} 家设施`);
  for (const [t, label] of [['agg_emission_total', '年度'], ['agg_industry_year', '行业×年度'], ['agg_region_year', '区域×年度'], ['agg_industry_stats', '行业统计(分位)']]) {
    try {
      const [[r]] = await conn.query(`SELECT COUNT(*) c FROM ${t}`);
      console.log(`  ${label.padEnd(10)} ${r.c} 行`);
    } catch { console.log(`  ${label.padEnd(10)} ${C.warn('表不存在（先跑 refresh）')}`); }
  }
}

(async () => {
  const conn = await mysql.createConnection(DB);
  try {
    if (STATUS) { await status(conn); return; }
    await ensureSchema(conn);
    if (VERIFY) {
      const ok = await verify(conn);
      process.exit(ok ? 0 : 1);
    }
    await refresh(conn);
    const ok = await verify(conn);
    process.exit(ok ? 0 : 1);
  } finally {
    await conn.end();
  }
})().catch((e) => {
  console.error(C.bad('✘ 失败：'), e.message || e);
  process.exit(9);
});
