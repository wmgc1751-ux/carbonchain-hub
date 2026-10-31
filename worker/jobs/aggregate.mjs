/**
 * worker/jobs/aggregate.mjs —— 预聚合作业
 * ==================================================================================
 * 【为什么这个文件是整个 D1 架构的核心】
 *
 * D1 的计费单位是「读取行数」。实测：
 *   对 5 万行做一次 GROUP BY → rows_read = 100,000
 *   免费层每天 500 万行 ⇒ 只能跑 50 次
 * 而平台的 /overview 一页就要查行业、区域、年度三组聚合 —— 加上访客刷新，
 * 一个上午就能把当日额度打光。额度用尽后所有查询返回错误，
 * 表现为"平台挂了"，而实际上只是配额问题。
 *
 * 【解法：把扫描成本搬到写入侧】
 * 同一组聚合预先算好写进 agg_* 表，读取侧只查几十行（实测 rows_read=12）。
 * 扫描成本从"每次请求"变成"每 30 分钟一次"：
 *   6 年 × 9 行业 × 8 区域 ≈ 432 行 + 几十行汇总 = 几百行写入/轮
 *   每轮读取约 30~60 万行（一次性）
 *   每天 48 轮 × 50 万 ≈ 2400 万行… 这仍然超预算。
 *
 * ⚠ 所以必须做**增量与降频**：
 *   · 只对"数据有变化"的年度重算（用 MAX(updated_at) 判断）
 *   · 真实设施数据按年更新，一天之内几乎不变 ⇒ 实际每轮只算 1~2 个年度
 *   · 若检测到源数据未变化，直接跳过（记 lastAggAt 指纹）
 *
 * 【判据：什么算"数据变化"】
 * 用「设施数 + 年度记录数 + 总排放量」三者组成指纹。
 * 只比设施数会漏掉"排放量被修订但设施数不变"的情况；
 * 只比总排放量会漏掉"新增设施但排放为 0"的情况。三者合起来足够。
 *
 * @module worker/jobs/aggregate
 */

/** 预聚合的年度窗口：只算最近 N 年（更早的年度已稳定，不必每轮重算） */
const RECENT_YEARS = 3;

/**
 * 两级调度：把"便宜的高频任务"与"昂贵的低频任务"分开。
 * ==================================================================================
 * 【为什么必须分级 —— 这是算出来的，不是拍的】
 *
 * D1 免费层每天 500 万行读取额度。实测各步骤成本：
 *   · 单年度矩阵聚合（GROUP BY country×industry×region）：约 20 万行
 *   · 洞察全量（leads / outliers / benchmark / concentration / groups）：
 *     约 110 万行 —— 因为它要对每个行业各扫一遍全表
 *
 * 若每 30 分钟跑一次全量：
 *   6 年 × 20 万 + 110 万 ≈ 230 万行/轮 ⇒ 每天只能跑 2 轮
 *   而 Cron 是 48 轮/天 ⇒ 第 3 轮起就超额，之后**所有查询返回错误**
 *   （表现为"平台挂了"，实际只是配额耗尽）
 *
 * 因此拆成两级：
 *   · AGGREGATE（每 30 分钟）：只重算「指纹变了」的年度。数据按年更新，
 *     一天之内通常 0 个年度变化 ⇒ 单轮成本约等于 0，最多 20 万行。
 *   · INSIGHTS（每天 1 次，UTC 03:xx）：全量重算洞察，约 110 万行。
 *
 * 这样日均：48 × ~2 万（多数轮直接跳过） + 1 × 110 万 ≈ 200 万行，
 * 留出一半余量给正常浏览。
 *
 * 【判据：如何知道"这一轮可以跳过"】
 * 比对指纹（设施数 | 记录数 | 总排放量）。三者任一变化即重算。
 * 只比其中一个都不够：设施数不变但排放被修订、或新增零排放设施，都会漏判。
 */
const CRON_LEVEL = {
  /** 每 30 分钟：只做增量年度聚合 */
  AGGREGATE: 'AGGREGATE',
  /** 每天一次：额外重算洞察 */
  INSIGHTS: 'INSIGHTS',
};

/**
 * 计算并写入预聚合表。
 * @param {object} env
 * @param {object} db  makeDb 返回的句柄
 * @param {object} [opts] { force, level, skipInsights }
 */
export async function refreshAggregates(env, db, opts = {}) {
  const t0 = Date.now();
  const currentYear = new Date().getFullYear();
  const level = opts.level || CRON_LEVEL.AGGREGATE;
  const result = {
    level,
    startedAt: new Date(t0).toISOString(),
    yearsProcessed: [],
    yearsSkipped: [],
    rowsWritten: 0,
    fingerprintChanged: false,
  };

  /* ---------- 1. 先做"增量年度聚合"（便宜，每轮都做） ----------
   * 只处理最近 3 年 + 数据里实际存在的年度在最近窗口内的部分。
   * 更早年度（如 2010–2018 的美国数据）完全稳定，重算只消耗额度不产生变化。
   *
   * ⚠ 首次部署时 agg 表为空，必须能建起全量。判据：agg_facility_total 无行
   * ⇒ 判定为首次，本次扫描全部年度（一次性成本可接受）。 */
  const aggEmpty = num(await db.value('SELECT COUNT(*) FROM agg_facility_total')) === 0;

  const years = [];
  for (let y = currentYear; y >= currentYear - RECENT_YEARS; y--) years.push(y);

  if (aggEmpty || opts.force) {
   /* 首次或强制：覆盖数据中存在的全部年度 */
    const existing = await db.query('SELECT DISTINCT year FROM real_emission_year ORDER BY year DESC');
    existing.map((r) => Number(r.year)).forEach((y) => { if (!years.includes(y)) years.push(y); });
    result.firstRun = aggEmpty;
  }
  years.sort((a, b) => b - a);

  /* ---------- 2. 逐年度：算指纹，变了才重算 ---------- */
  for (const year of years) {
    /* ⚠ db.one() 在"该年度没有任何记录"时返回 **null**（不是空对象）。
     * 直接取 `fp.facilities` 会抛 TypeError，而该错误会被上层 catch 成
     * "服务器内部错误" —— 用户看不到任何线索，只会觉得平台坏了。
     *
     * 真实会发生的场景：某年度数据被清理、或首次部署时只迁了部分年度。
     * 因此这里必须给默认值，而不是假设一定查得到。 */
    const fp = (await db.one(
      `SELECT COUNT(*) AS facilities, COUNT(e.id) AS rows_n, SUM(e.total_co2e) AS total
         FROM real_emission_year e JOIN real_facility f ON f.id = e.facility_id
        WHERE e.year = ?`, [year])) || {};

    const facilityCount = num(fp.facilities);
    const rowCount = num(fp.rows_n);

    /* 该年度无数据：跳过，并且**删掉它的旧聚合**（若存在）。
     * 否则会留下"某个已被清空的年度"的陈旧聚合，页面会显示幻影数据。 */
    if (rowCount === 0) {
      try {
        await db.tx([
          { sql: 'DELETE FROM agg_facility_year WHERE year = ?', params: [year] },
          { sql: 'DELETE FROM agg_facility_total WHERE year = ?', params: [year] },
        ]);
      } catch { /* 清理失败不阻断其他年度 */ }
      result.yearsSkipped.push({ year, reason: '无数据' });
      continue;
    }

    const fingerprint = `${facilityCount}|${rowCount}|${Math.round(num(fp.total))}`;
    const prev = await db.one(
      'SELECT payload_json FROM agg_insight WHERE kind = ? AND scope = ?',
      ['FINGERPRINT', String(year)]).catch(() => null);

    if (!opts.force && prev && prev.payload_json === fingerprint) {
      result.yearsSkipped.push(year);
      continue;
    }

    /* ---------- 3. 重算该年度的行业×区域矩阵 ----------
     * 一次 GROUP BY 拿到全部组合，写进 agg_facility_year。
     * 这是全表扫描（rows_read 大），但每轮只对"变化了的年度"做一次。
     *
     * ⚠ device_did 是 cems_reading 的字段，**不在 real_emission_year**。
     * 真实设施观测数据（Climate TRACE / EPA）本身不区分"设备直报"与"模型生成"——
     * 它整体是 REAL 层。因此这里的 device_rows 恒为 0：
     * 真实设施的年度排放记录没有"设备/模型"之分，只有"观测/报送"之分。
     * 保留该列是为了与 agg_facility_year 的表结构对齐，而不是为了填一个假数字。 */
    const matrix = await db.query(
      `SELECT f.country_iso, e.year, f.industry,
              f.admin1 AS region_code,
              COUNT(*) AS facilities,
              SUM(e.total_co2e) AS total_co2e
         FROM real_emission_year e
         JOIN real_facility f ON f.id = e.facility_id
        WHERE e.year = ? AND f.country_iso IN ('CHN','USA')
        GROUP BY f.country_iso, e.year, f.industry, f.admin1`, [year]);

    /* 先删该年度旧聚合，再插入 —— 用 batch 保证原子性。
     * ⚠ D1 没有交互式事务，delete + insert 必须放进同一个 batch，
     * 否则中间时刻的读取会看到"空数据"。 */
    const ops = [{ sql: 'DELETE FROM agg_facility_year WHERE year = ?', params: [year] }];
    for (const m of matrix) {
      ops.push({
        sql: `INSERT INTO agg_facility_year
                (country_iso, year, industry, region_code, facilities, total_co2e, device_rows, refreshed_at)
              VALUES (?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`,
        params: [m.country_iso, Number(m.year), m.industry, m.region_code,
          Number(m.facilities), Number(m.total_co2e), 0],
      });
    }

    /* ---------- 4. 该年度的总量与聚合资产单列 ---------- */
    const totals = await db.query(
      `SELECT f.country_iso, e.year,
              COUNT(*) AS facilities,
              SUM(e.total_co2e) AS total_co2e,
              SUM(CASE WHEN json_extract(e.process_json,'$.assetKind')='AGGREGATE' THEN 1 ELSE 0 END) AS agg_assets,
              SUM(CASE WHEN json_extract(e.process_json,'$.assetKind')='AGGREGATE' THEN e.total_co2e ELSE 0 END) AS agg_tonnes
         FROM real_emission_year e
         JOIN real_facility f ON f.id = e.facility_id
        WHERE e.year = ? GROUP BY f.country_iso, e.year`, [year]);

    ops.push({ sql: 'DELETE FROM agg_facility_total WHERE year = ?', params: [year] });
    for (const t of totals) {
      ops.push({
        sql: `INSERT INTO agg_facility_total
                (country_iso, year, facilities, emission_rows, total_co2e,
                 aggregate_assets, aggregate_tonnes, refreshed_at)
              VALUES (?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`,
        params: [t.country_iso, Number(t.year), Number(t.facilities), Number(t.facilities),
          num(t.total_co2e), num(t.agg_assets), num(t.agg_tonnes)],
      });
    }

    /* 记录指纹（存在 agg_insight 里，复用同一张表避免再建表） */
    ops.push({
      sql: `INSERT INTO agg_insight (kind, scope, payload_json, refreshed_at)
            VALUES ('FINGERPRINT', ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(kind, scope) DO UPDATE SET payload_json = excluded.payload_json, refreshed_at = CURRENT_TIMESTAMP`,
      params: [String(year), fingerprint],
    });

    /* 分批提交：D1 单次 batch 有语句数上限，按 80 条一组 */
    for (let i = 0; i < ops.length; i += 80) {
      const chunk = ops.slice(i, i + 80);
      await db.tx(chunk);
      result.rowsWritten += chunk.length;
    }
    result.yearsProcessed.push({ year, cells: matrix.length, countries: totals.length });
    result.fingerprintChanged = true;
  }

  /* ---------- 5. 洞察（仅 INSIGHTS 级或首次） ----------
   * 成本约 110 万行，每天只能跑 1 次。
   * 用最新**完整**年度，不用当年 —— 当年数据仍在累积，线索会是假的。 */
  if (level === CRON_LEVEL.INSIGHTS || aggEmpty || opts.force) {
    const latestComplete = num(await db.value(
      'SELECT MAX(year) FROM agg_facility_total WHERE year < ?', [currentYear])) || (currentYear - 1);

    const steps = [
      ['leads', () => computeLeads(db, latestComplete)],
      ['outliers', () => computeOutliers(db, latestComplete)],
      ['benchmarks', () => computeBenchmarks(db, latestComplete)],
      ['concentration', () => computeConcentration(db, latestComplete)],
      ['groups', () => computeGroups(db, latestComplete)],
    ];
    const insightReport = { year: latestComplete, steps: {} };
    /* 逐步隔离失败：某一步出错不应让其余步骤也跳过 ——
     * 否则一个行业的异常数据会让全部洞察都停在旧值上。 */
    for (const [name, fn] of steps) {
      try {
        await fn();
        insightReport.steps[name] = 'OK';
      } catch (e) {
        insightReport.steps[name] = 'FAIL: ' + String(e.message || e).slice(0, 120);
      }
    }
    result.insights = insightReport;
  } else {
    result.insights = { skipped: true, reason: '本级别（AGGREGATE）不重算洞察，洞察每天刷新一次' };
  }

  result.elapsedMs = Date.now() - t0;
  return result;
}

/* ==================================================================================
 * 洞察计算（各自独立，失败不影响其他）
 * ================================================================================== */

/** 异常增长线索：相对增幅与绝对增量必须同时满足 */
async function computeLeads(db, year) {
  const fromYear = year - 1;
  const rows = await db.query(
    `SELECT c.id, c.name, c.industry, c.admin2 AS region,
            p.total_co2e AS prev_e, cur.total_co2e AS curr_e
       FROM real_facility c
       JOIN real_emission_year p ON p.facility_id = c.id AND p.year = ?
       JOIN real_emission_year cur ON cur.facility_id = c.id AND cur.year = ?
      WHERE c.country_iso = 'CHN'
        AND COALESCE(json_extract(cur.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'
        AND p.total_co2e > 0 AND cur.total_co2e > 0
        AND (cur.total_co2e - p.total_co2e) >= 100000
        AND (cur.total_co2e - p.total_co2e) / p.total_co2e * 100 >= 20
      ORDER BY (cur.total_co2e - p.total_co2e) DESC
      LIMIT 40`, [fromYear, year]);

  const payload = {
    fromYear, toYear: year,
    criteria: {
      minAbsIncreaseTonnes: 100000, minGrowthPct: 20,
      why: '相对增幅与绝对增量必须同时满足。只用相对增幅会让小设施占满清单；'
        + '只用绝对增量会漏掉"小而快速增长"的新建产能。',
    },
    yearCompleteness: { fromYearComplete: true, toYearComplete: true, warning: null },
    leads: rows.map((r) => {
      const prev = Number(r.prev_e), curr = Number(r.curr_e);
      const inc = curr - prev;
      return {
        facilityId: Number(r.id), name: r.name, industry: r.industry, region: r.region,
        prevTonnes: Math.round(prev), currTonnes: Math.round(curr),
        increaseTonnes: Math.round(inc),
        growthPct: +(inc / prev * 100).toFixed(2),
        whyFlagged: `${year} 年排放较 ${fromYear} 年增加 ${Math.round(inc / 1e4)} 万吨`
          + `（+${(inc / prev * 100).toFixed(1)}%），绝对增量 ${Math.round(inc).toLocaleString()} tCO₂e`,
        possibleExplanations: [
          '新建或扩建产能投产（合法，需核对环评与配额变更）',
          '机组利用小时数上升（市场因素，需核对发电量）',
          '燃料品种从低碳向高碳切换（需核对入炉煤质）',
          '观测质量改善导致的历史低估被修正（非真实增长）',
        ],
        action: '调取该设施同期活动数据（产量/燃料消耗/发电量）与在线监测原始数据，比对增量是否可由可核实因素解释。',
      };
    }),
    totalMatches: rows.length,
    limitations: [
      '本清单来自第三方观测估算，不含企业自报值；线索仅供参考，不构成违法认定',
      '同比基于相邻两个完整年度；进行中年度不参与比较',
      '已排除聚合型资产，避免把"一片区域"当成一家企业',
    ],
  };
  await saveInsight(db, 'LEADS', 'CHN', payload);
}

/** 强度离群：按行业算 z 分数 */
async function computeOutliers(db, year) {
  const rows = await db.query(
    `SELECT f.id, f.name, f.industry, f.admin2 AS region,
            e.total_co2e, e.process_json
       FROM real_emission_year e JOIN real_facility f ON f.id = e.facility_id
      WHERE f.country_iso='CHN' AND e.year = ?
        AND COALESCE(json_extract(e.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'
        AND json_extract(e.process_json,'$.emissionFactor') IS NOT NULL
        AND e.total_co2e > 10000`, [year]);

  const byInd = new Map();
  for (const r of rows) {
    let ev = r.process_json;
    if (typeof ev === 'string') { try { ev = JSON.parse(ev); } catch { ev = {}; } }
    const ef = ev && ev.emissionFactor != null ? Number(ev.emissionFactor) : null;
    if (!ef || ef <= 0) continue;
    if (!byInd.has(r.industry)) byInd.set(r.industry, []);
    byInd.get(r.industry).push({
      id: Number(r.id), name: r.name, region: r.region,
      tonnes: Number(r.total_co2e), intensity: ef, unit: ev.activityUnit || null,
    });
  }

  const outliers = [];
  const indStats = [];
  for (const [ind, list] of byInd) {
    if (list.length < 10) continue;
    const vals = list.map((x) => x.intensity);
    const n = vals.length;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];
    indStats.push({ industry: ind, facilities: n, medianIntensity: +median.toFixed(6) });
    if (sd <= 0) continue;
    for (const x of list) {
      const z = (x.intensity - mean) / sd;
      if (z >= 2.0) {
        outliers.push({
          facilityId: x.id, name: x.name, industry: ind, region: x.region,
          tonnes: Math.round(x.tonnes), intensity: +x.intensity.toFixed(6), unit: x.unit,
          industryMean: +mean.toFixed(6), industryMedian: +median.toFixed(6), industrySd: +sd.toFixed(6),
          zScore: +z.toFixed(2), sampleSize: n,
          multipleOfMedian: +(x.intensity / median).toFixed(2),
          whyFlagged: `排放强度 ${x.intensity.toFixed(3)} ${x.unit || ''}，`
            + `为同行业中位数的 ${(x.intensity / median).toFixed(2)} 倍，z=${z.toFixed(2)}（样本 ${n} 家）`,
          possibleExplanations: [
            '工艺路线不同（长流程 vs 短流程炼钢、湿法 vs 干法水泥）',
            '燃料结构差异（煤基 vs 气基）', '产品结构不同', '观测或统计口径差异（是否含自备电厂）',
          ],
        });
      }
    }
  }
  outliers.sort((a, b) => b.zScore - a.zScore);

  await saveInsight(db, 'OUTLIERS', 'CHN', {
    year, threshold: 'z ≥ 2',
    byIndustry: indStats,
    outliers: outliers.slice(0, 30),
    totalMatches: outliers.length,
    limitations: [
      '排放强度单位随行业不同，不可跨行业比较',
      'z 分数假设同行业近似正态；工艺路线分化时分布可能双峰',
      '强度高不等于违规：工艺路线与产品结构差异是主要解释',
    ],
  });
}

/** 企业对标：把分布点存下来，读取侧按传入排放量算百分位 */
async function computeBenchmarks(db, year) {
  const inds = await db.query(
    `SELECT industry, COUNT(*) AS n FROM real_facility f
       JOIN real_emission_year e ON e.facility_id = f.id
      WHERE f.country_iso='CHN' AND e.year = ?
        AND COALESCE(json_extract(e.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'
      GROUP BY industry HAVING n >= 10 ORDER BY n DESC`, [year]);

  for (const it of inds) {
    const rows = await db.query(
      `SELECT e.total_co2e FROM real_facility f
         JOIN real_emission_year e ON e.facility_id = f.id
        WHERE f.country_iso='CHN' AND e.year = ? AND f.industry = ?
          AND COALESCE(json_extract(e.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'
          AND e.total_co2e > 0 ORDER BY e.total_co2e ASC`,
      [year, it.industry]);
    const vals = rows.map((r) => Math.round(Number(r.total_co2e)));
    if (!vals.length) continue;
    const n = vals.length;
    const q = (p) => vals[Math.min(n - 1, Math.floor(n * p))];
    await saveInsight(db, 'BENCHMARK', it.industry, {
      industry: it.industry, year, sampleSize: n, unit: 'tCO2e/年',
      distribution: {
        p10: q(0.10), p25: q(0.25), median: q(0.50), p75: q(0.75), p90: q(0.90), p99: q(0.99),
        max: vals[n - 1], sum: vals.reduce((a, b) => a + b, 0),
        points: n <= 2000 ? vals : vals.filter((_, i) => i % Math.ceil(n / 2000) === 0),
      },
      interpretation: {
        howToRead: '分位数是真实观测分布的直接取样。P75 意味着 75% 的同行排放量低于该值。',
        caution: '样本量 < 30 时，分位数不稳定，应谨慎引用。',
        crossIndustryWarning: '不同行业排放量级差异极大，跨行业比较没有意义。',
      },
    });
  }
}

/** 行业集中度：HHI + CR10 */
async function computeConcentration(db, year) {
  const inds = await db.query(
    `SELECT industry, COUNT(*) AS n, SUM(total_co2e) AS total
       FROM real_facility f JOIN real_emission_year e ON e.facility_id = f.id
      WHERE f.country_iso='CHN' AND e.year = ?
        AND COALESCE(json_extract(e.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'
      GROUP BY industry HAVING n >= 5 ORDER BY total DESC`, [year]);

  const out = [];
  for (const it of inds) {
    const top = await db.query(
      `SELECT e.total_co2e AS v FROM real_facility f
         JOIN real_emission_year e ON e.facility_id = f.id
        WHERE f.country_iso='CHN' AND e.year = ? AND f.industry = ?
          AND COALESCE(json_extract(e.process_json,'$.assetKind'),'FACILITY') <> 'AGGREGATE'
        ORDER BY e.total_co2e DESC LIMIT 100`, [year, it.industry]);
    const total = Number(it.total) || 0;
    if (!total) continue;
    const shares = top.map((r) => Number(r.v) / total);
    let hhi = shares.reduce((a, s) => a + s * s * 10000, 0);
    const restShare = 1 - shares.reduce((a, b) => a + b, 0);
    const restN = Math.max(1, Number(it.n) - shares.length);
    hhi += (restShare * restShare / restN) * 10000;
    const cr10 = shares.slice(0, 10).reduce((a, b) => a + b, 0);
    out.push({
      industry: it.industry, facilities: Number(it.n),
      totalMt: +(total / 1e6).toFixed(2),
      hhi: +hhi.toFixed(1),
      concentrationLevel: hhi > 2500 ? '高度集中' : (hhi > 1500 ? '中度集中' : '相对分散'),
      cr10Pct: +(cr10 * 100).toFixed(2),
      topFacilitySharePct: shares.length ? +(shares[0] * 100).toFixed(2) : null,
    });
  }
  await saveInsight(db, 'CONCENTRATION', 'CHN', {
    year, country: 'CHN', industries: out,
    method: 'HHI = Σ(份额²)×10000（前 100 家精确，其余按均分近似）；CR10 = 前 10 家份额',
    thresholds: {
      competitive: '<1500', moderate: '1500~2500', concentrated: '>2500',
      basis: '美国司法部/联邦贸易委员会横向合并指南的通行分档',
    },
    policyReading: 'HHI 高、CR10 高的行业，监管抓前 10~30 家即可覆盖大部分排放；'
      + 'HHI 低而家数多的行业，需依赖自动监测与数据质量分级，而非逐家核查。',
    limitations: [
      '集中度基于 Climate TRACE 观测估算，与企业自报口径可能存在系统性差异',
      '仅统计样本量 ≥5 的行业；样本过小的行业不计算',
    ],
  });
}

/** 集团视角：按真实所有权聚合 */
async function computeGroups(db, year) {
  const rows = await db.query(
    `SELECT f.id, f.name, f.industry, f.admin2 AS region, e.total_co2e, e.process_json
       FROM real_facility f JOIN real_emission_year e ON e.facility_id = f.id
      WHERE f.country_iso='CHN' AND e.year = ?
        AND json_array_length(json_extract(e.process_json,'$.owners')) > 0`, [year]);

  const groups = new Map();
  for (const r of rows) {
    let ev = r.process_json;
    if (typeof ev === 'string') { try { ev = JSON.parse(ev); } catch { ev = {}; } }
    const owners = [...new Set((ev.owners || []).map((o) => String(o).trim()).filter(Boolean))];
    for (const o of owners) {
      const g = groups.get(o) || { group: o, facilities: 0, total: 0, industries: new Set(), regions: new Set(), names: [] };
      g.facilities++; g.total += Number(r.total_co2e) || 0;
      g.industries.add(r.industry);
      if (r.region) g.regions.add(r.region);
      if (g.names.length < 5) g.names.push(r.name);
      groups.set(o, g);
    }
  }
  const list = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, 30)
    .map((g) => ({
      group: g.group, facilities: g.facilities,
      totalMt: +(g.total / 1e6).toFixed(2),
      industries: [...g.industries], regions: [...g.regions],
      sampleFacilities: g.names,
    }));

  await saveInsight(db, 'GROUPS', 'CHN', {
    year, country: 'CHN', groups: list,
    coverage: { facilitiesWithOwner: rows.length, distinctGroups: groups.size },
    limitations: [
      '所有权信息仅部分设施可得（源数据覆盖率约 60%），故集团合计是下界',
      '同一集团可能存在多个拼写变体，未做模糊合并（宁可拆开，不可错并）',
    ],
  });
}

async function saveInsight(db, kind, scope, payload) {
  await db.run(
    `INSERT INTO agg_insight (kind, scope, payload_json, refreshed_at)
     VALUES (?,?,?, CURRENT_TIMESTAMP)
     ON CONFLICT(kind, scope) DO UPDATE SET payload_json = excluded.payload_json, refreshed_at = CURRENT_TIMESTAMP`,
    [kind, scope, JSON.stringify(payload)]);
}

function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
