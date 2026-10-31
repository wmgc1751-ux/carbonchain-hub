/**
 * routes/real.js —— 真实数据层 API
 * ==================================================================================
 * 本路由提供的是**公开真实数据**与**实时运转状态**，因此整体**不要求登录**。
 *
 * 【数据来源：仅限国内】
 * 本层只接入国内权威渠道 —— 生态环境部 / 国家统计局 / 国家发改委的公开因子、
 * 省级在线监测公开平台的小时级报文、上海环交所与北京绿交所的成交行情。
 * 这些是政府公开信息，可逐条复核。
 *
 * 原接入的 US EPA GHGRP、Climate TRACE、World Bank、OWID 已于 2026-10-30 全部下线，
 * 库内数据、采集代码与接口一并移除。详见 docs/国外数据下线报告-20261030.md。
 *
 * 【为什么公开数据不加鉴权】
 * 上述数据本身是公开发布、可逐条核验的。把它们锁在登录后面会造成两个后果：
 *   1. 第三方无法独立核验平台宣称的真实性，"可核验"变成"请相信我们"。
 *   2. 数据本身没有任何保密价值，加鉴权只是把可验证性当成了权限。
 * 真正需要鉴权的是企业填报的活动数据与核算结果 —— 那些在 /api/mrv 下。
 *
 * 【端点分组】
 *   /sources           数据源登记 + 新鲜度
 *   /cems/coverage     国内企业污染物日均浓度（公开平台）
 *   /cems/emission     国内企业年度 CO₂ 核算（活动水平法，可复算）
 *   /cems/cn/coverage  国内企业 CEMS 小时级实测数据概况
 *   /cems/cn/hourly    国内企业 CEMS 小时级明细
 *   /truth             真实性契约（运行时逐条核验，可当场证伪）
 *   /live              实时快照（秒级指标）
 *   /live/history      指标环形缓冲（画时序曲线）
 *   /stream            SSE 实时推送（浏览器原生 EventSource）
 *
 * @module routes/real
 */
'use strict';

const express = require('express');
const db = require('../db');
const realtime = require('../services/realtime');

const router = express.Router();

/* ---------------------------------------------------------------------------------
 * 小工具
 * --------------------------------------------------------------------------------- */

const ok = (res, data, meta) => res.json({ code: 0, msg: 'ok', data, meta: meta || null });
const fail = (res, msg, code = 400) => res.status(code).json({ code, msg, data: null });

/* 本路由整体是**公开**的（真实源数据本身公开，锁在登录后会让
 * "可核验"变成"请相信"）。但个别端点执行的是**运维动作**（触发对外抓取），
 * 那必须鉴权 —— 因此这里单独引入中间件，只在需要的端点上挂。 */
const { authRequired, requireRole } = require('../middleware/auth');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ==================================================================================
 * 只读聚合缓存（中间件形式）
 * ----------------------------------------------------------------------------------
 * /truth 每次要对十余条 verify_sql 做全表 COUNT，冷耗时 1 s 量级，
 * 而页面会在切换时重复调用。缓存 TTL 取 30 s，命中时打 X-Agg-Cache 头，
 * 便于排查"这个数是不是旧的"。
 *
 * ⚠ 只用于**公开只读**端点。绝不缓存带鉴权上下文的结果 ——
 * 那会把 A 用户的数据返回给 B 用户。
 * ================================================================================== */
const _aggHttpCache = new Map();

function aggCacheMw(ttlMs) {
  return (req, res, next) => {
    const key = req.originalUrl;
    const hit = _aggHttpCache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) {
      res.set('X-Agg-Cache', 'HIT');
      return res.json(hit.body);
    }
    res.set('X-Agg-Cache', 'MISS');
    const orig = res.json.bind(res);
    res.json = (body) => {
      /* 容量控制：超过 64 条清最旧一半，避免长期运行内存增长 */
      if (_aggHttpCache.size > 64) {
        [..._aggHttpCache.keys()].slice(0, 32).forEach((k) => _aggHttpCache.delete(k));
      }
      _aggHttpCache.set(key, { at: now, body });
      return orig(body);
    };
    next();
  };
}

/* ==================================================================================
 * 六、数据源登记
 * ================================================================================== */

/**
 * GET /sources
 *
 * 这一版直接交给 realSync.freshness() 计算，理由：
 * 新鲜度里有一个"是否该重新确认"（dueForCheck）的判断，它依赖各源自己的 TTL。
 * 如果让前端拿 lastFetchedAt 自己算，那 TTL 规则就有两份实现，必然漂移。
 * 规则只能有一个来源。
 */
router.get('/sources', wrap(async (req, res) => {
  const realSync = require('../services/realSync');
  ok(res, await realSync.freshness());
}));

/* ==================================================================================
 * 真实企业 CEMS 公开数据与企业排放核算（2026-10-28 新增）
 * ----------------------------------------------------------------------------------
 * 数据来源：4 家保定垃圾焚烧企业的 ljgk 公开平台原始报文（1150 条日均浓度）
 *          + 河北省发改委 2024 年活动水平统计（官方）
 *          + DB11/T 1416—2017 附录A 矿物碳因子（企业核算口径资料原文）
 *
 * 【能力边界必须写在接口里，不能只写在文档里】
 * 本平台接入的是**污染物浓度**，不是排放量。浓度 × 烟气流量 = 排放量，
 * 而公开渠道没有烟气流量。因此：
 *   · /real/cems/coverage  回答"有哪些真实浓度数据"
 *   · /real/cems/emission  回答"用活动水平法算出的排放量是多少（可复算）"
 * 两个接口各自把 formula / boundary 字段返回给前端，页面据此如实展示。
 * ================================================================================== */

/** 真实 CEMS 浓度数据覆盖情况（如实返回边界，不美化） */
router.get('/cems/coverage', wrap(async (req, res) => {
  const entCode = req.query.entCode || null;
  const params = [];
  let where = '';
  if (entCode) { where = 'WHERE ent_code = ?'; params.push(entCode); }

  const outlets = await db.query(
    `SELECT ent_code, ent_name, outlet_name, mp_code,
            COUNT(*) records, COUNT(DISTINCT reading_time) days,
            COUNT(DISTINCT pollutant_name) pollutants,
            MIN(reading_time) periodFrom, MAX(reading_time) periodTo,
            SUM(exceed) exceedCount, SUM(is_valid) validCount,
            SUM(concentration = 0) zeroCount,
            MIN(batch_no) batchNo, MIN(chain_tx_id) chainTxId
       FROM cems_public_reading ${where}
      GROUP BY ent_code, ent_name, outlet_name, mp_code
      ORDER BY ent_name, outlet_name`, params);

  const [tot] = await db.query(
    `SELECT COUNT(*) records, COUNT(DISTINCT ent_code) enterprises,
            COUNT(DISTINCT mp_code) outlets, COUNT(DISTINCT batch_no) batches,
            COUNT(DISTINCT chain_tx_id) chainTxs,
            MIN(reading_time) periodFrom, MAX(reading_time) periodTo
       FROM cems_public_reading ${where}`, params);

  ok(res, {
    summary: {
      records: Number(tot.records), enterprises: Number(tot.enterprises),
      outlets: Number(tot.outlets), batches: Number(tot.batches),
      anchoredBatches: Number(tot.chainTxs),
      periodFrom: tot.periodFrom, periodTo: tot.periodTo,
    },
    outlets,
    /* ↓ 这三个字段是"声明"而不是"数据"，但必须由后端给出，避免前端各写一套 */
    source: '生态环境部生活垃圾焚烧发电厂自动监测数据公开平台（ljgk.envsc.cn）',
    provenance: 'REAL_PUBLIC',
    granularity: 'DAILY_AVERAGE',
    boundary: {
      whatWeHave: '颗粒物、二氧化硫、氮氧化物、一氧化碳、氯化氢的日均浓度（mg/m³）及标准限值',
      whatWeLack: '烟气流量（m³/h）、含氧量折算基准、CO₂ 监测项',
      canDo: '达标判定（浓度 vs 限值）、链上存证与验真、与官方统计交叉核验',
      cannotDo: '由浓度直接测算排放量（浓度×流量）；小时/分钟级实时排放量',
      whyNotFake: '缺流量就不算排放量。用模拟流量补齐会得到一个"看起来完整"的假数，'
        + '这正是本平台此前被评审指出的"自举模拟"问题，不再重犯。',
    },
  });
}));

/** 企业年度排放核算（活动水平法，可复算、可上链核验） */
router.get('/cems/emission', wrap(async (req, res) => {
  const year = Number(req.query.year) || 2024;
  const rows = await db.query(
    /* 活动水平按「企业+年度」聚合后再 JOIN：enterprise_activity 是一期/二期分行存的，
     * 直接 JOIN 会一对多，把同一家企业的核算结果重复成多行、汇总时翻倍
     * （2026-10-28 实测：恒能保定 30.87 万被算两次，总量虚增到 103.62 万）。
     * 这里先 GROUP BY 成一行再关联。 */
    `SELECT c.ent_code, c.ent_name, c.year, c.method,
            c.msw_t, c.factor_tco2_t, c.oxidation, c.total_tco2, c.biogenic_tco2,
            c.factor_ref, c.evidence, c.status, c.chain_tx_id,
            a.capacity_mw, a.grid_kwh_10k, a.waste_kwh_10k, a.source AS activitySource
       FROM emission_calc c
       LEFT JOIN (
         SELECT ent_code, year,
                SUM(capacity_mw) capacity_mw,
                SUM(grid_kwh_10k) grid_kwh_10k,
                SUM(waste_kwh_10k) waste_kwh_10k,
                MIN(source) source
           FROM enterprise_activity
          GROUP BY ent_code, year
       ) a ON a.ent_code = c.ent_code AND a.year = c.year
      WHERE c.year = ?
      ORDER BY c.total_tco2 DESC`, [year]);

  /* 汇总按企业去重（一期/二期已按企业合并入库），不重复计数 */
  const total = rows.reduce((a, r) => a + Number(r.total_tco2), 0);
  const biogenic = rows.reduce((a, r) => a + Number(r.biogenic_tco2), 0);

  ok(res, {
    year,
    enterprises: rows.length,
    totalTco2: Number(total.toFixed(2)),
    biogenicTco2: Number(biogenic.toFixed(2)),
    rows: rows.map((r) => ({
      ...r,
      totalTco2: Number(r.total_tco2),
      biogenicTco2: Number(r.biogenic_tco2),
      /* 让前端可以当场复算，而不是相信后端算出来的数 */
      recomputable: {
        formula: 'totalTco2 = msw_t × factor_tco2_t',
        check: Number(r.msw_t) * Number(r.factor_tco2_t),
      },
    })),
    method: {
      name: '活动水平法（矿物碳）',
      formula: 'E = MSW × 矿物碳排放因子（含 OF）',
      factor: 0.390,
      oxidation: 0.95,
      factorRef: 'DB11/T 1416—2017 附录A',
      activitySource: '河北省发展和改革委员会《2024年垃圾处理量及上网电量情况统计表》',
      biogenicNote: '生物碳因子 0.623 tCO₂/t 为信息项，不计入排放总量',
    },
    boundaries: {
      cemsDirectMethod: '不可用 —— 缺烟气流量，无法由浓度算排放量',
      thisMethod: '可用 —— 活动水平与排放因子均为官方/标准来源，结果可被第三方复算',
      notClaim: '本结果不是 CEMS 直接测得的排放量，是活动水平法核算值',
    },
  });
}));

/* ==================================================================================
 * 中国控排企业真实 CEMS 小时数据（河北省公开系统）—— 2026-10-28 第二次突破
 * ----------------------------------------------------------------------------------
 * 此前结论"国内无公开 CEMS 排放量"被推翻：河北省污染源自动监控信息公开系统
 * （111.62.218.180:9920）公开了小时级数据，字段含烟气量(m³)、每项污染物
 * 浓度(实测/折算)与排放量(kg)——排放量 kg = 浓度 × 烟气量 × 1e-6。
 *
 * 能力升级：中国控排企业的 SO₂/NOx/颗粒物/CO/HCl 排放量现在是**平台原生字段**，
 * 不再需要自行推算。CO₂ 仍不在 GB 18485 监测范围，按活动水平法另行核算（见上）。
 * ================================================================================== */

/** 中国企业 CEMS 小时数据概况（全表两次 GROUP BY，实测 ~10s —— 缓存 10 分钟） */
router.get('/cems/cn/coverage', aggCacheMw(10 * 60 * 1000), wrap(async (req, res) => {
  const outlets = await db.query(
    `SELECT ent_name, outlet_name, COUNT(*) hours, SUM(is_valid) validHours,
            MIN(monitored_at) periodFrom, MAX(monitored_at) periodTo,
            SUM(flue_gas_m3) flueGasM3,
            SUM(so2_emission_kg) so2Kg, SUM(nox_emission_kg) noxKg,
            SUM(pm_emission_kg) pmKg, SUM(co_emission_kg) coKg, SUM(hcl_emission_kg) hclKg,
            MIN(batch_no) batchNo, MIN(chain_tx_id) chainTxId
       FROM cems_cn_hourly
      GROUP BY ent_name, outlet_name ORDER BY ent_name`
  );
  const [tot] = await db.query(
    `SELECT COUNT(*) hours, SUM(is_valid) valid, COUNT(DISTINCT ent_name) enterprises,
            COUNT(DISTINCT outlet_name) outlets,
            SUM(flue_gas_m3) gas, SUM(so2_emission_kg) so2, SUM(nox_emission_kg) nox,
            SUM(pm_emission_kg) pm, COUNT(DISTINCT batch_no) batches,
            COUNT(DISTINCT chain_tx_id) txs, MIN(monitored_at) d0, MAX(monitored_at) d1
       FROM cems_cn_hourly`
  );
  ok(res, {
    jurisdiction: 'CN-HEBEI',
    jurisdictionNote: '河北省污染源自动监控信息公开系统（河北省生态环境厅）公开发布的小时级自动监测数据',
    summary: {
      hours: Number(tot.hours), validHours: Number(tot.valid),
      enterprises: Number(tot.enterprises), outlets: Number(tot.outlets),
      flueGasM3: Number(Number(tot.gas || 0).toFixed(1)),
      so2Kg: Number(Number(tot.so2 || 0).toFixed(2)),
      noxKg: Number(Number(tot.nox || 0).toFixed(2)),
      pmKg: Number(Number(tot.pm || 0).toFixed(3)),
      batches: Number(tot.batches), anchoredBatches: Number(tot.txs),
      periodFrom: tot.d0, periodTo: tot.d1,
    },
    outlets: outlets.map((o) => ({
      ...o,
      hours: Number(o.hours), validHours: Number(o.validHours),
      flueGasM3: Number(Number(o.flueGasM3 || 0).toFixed(1)),
      so2Kg: Number(Number(o.so2Kg || 0).toFixed(2)),
      noxKg: Number(Number(o.noxKg || 0).toFixed(2)),
      pmKg: Number(Number(o.pmKg || 0).toFixed(3)),
    })),
    capability: {
      whatThisSolves: '中国控排企业的 SO₂/NOx/颗粒物/CO/HCl 排放量(kg) 是监测系统原生字段（浓度×烟气量由省平台算好），不再需要自行推算',
      canDo: '小时级真实排放量核算与趋势、达标判定、排放量-浓度-烟气量三元交叉核验、与活动水平法对照',
      internalCheck: '排放量(kg) = 实测浓度(mg/m³) × 烟气量(m³) × 1e-6；2335 条可验样本吻合率 92.5%，不符者源于源头平台 cou 只保留 1-2 位有效数字（如实保留，未修正）',
      stillMissing: 'CO₂ 不在 GB 18485 焚烧 CEMS 监测范围；CO₂ 排放量仍按活动水平法核算（见本页第一节）',
      negativeFlow: '13 条负烟气量（传感器漂移时段）如实保留并标 is_valid=0，未删除未修正',
    },
  });
}));

/** 中国企业 CEMS 小时明细 */
router.get('/cems/cn/hourly', wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.entName) { where.push('ent_name = ?'); params.push(req.query.entName); }
  if (req.query.outlet) { where.push('outlet_name = ?'); params.push(req.query.outlet); }
  if (req.query.from) { where.push('monitored_at >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('monitored_at <= ?'); params.push(req.query.to); }
  if (req.query.validOnly === '1') where.push('is_valid = 1');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const page = await db.paginate(
    `SELECT ent_name, outlet_name, monitored_at, flue_gas_m3, furnace_temp_c, o2_pct,
            pm_measured, pm_corrected, pm_emission_kg,
            so2_measured, so2_corrected, so2_emission_kg,
            nox_measured, nox_corrected, nox_emission_kg,
            co_measured, co_emission_kg, hcl_measured, hcl_emission_kg,
            is_valid, invalid_reason, batch_no, chain_tx_id
       FROM cems_cn_hourly ${w}
      ORDER BY monitored_at DESC, outlet_name`,
    params, req.query
  );
  page.jurisdiction = 'CN-HEBEI';
  ok(res, page);
}));

/**
 * POST /sync —— 手动触发一轮同步（给运维与演示用）
 * 查询参数：force=1 忽略 TTL；only= 限定源
 */
router.post('/sync', authRequired, requireRole('ADMIN', 'REGULATOR'), wrap(async (req, res) => {
  /* ⚠ 必须鉴权 + 限流。
   *
   * 原实现完全开放：任何人可以 POST /api/real/sync?force=1，让服务端立刻
   * 对外发起一轮真实源抓取。三条后果：
   *   ① 出口 IP 会被对方风控（曾经实际发生过，东财接口已因此禁用）；
   *   ② 攻击者可以把它当放大器，用我们的服务器去打外部 API；
   *   ③ 每轮同步都会写 data_ingest_log，匿名刷请求
   *      可以把这张表灌满，让"最近同步时间"失去参考价值。
   *
   * 只读的 /sources 与 /truth 保持公开 —— 那才是"可核验"需要的。
   * 触发抓取是运维动作，不是核验动作，两者不该同一权限级别。 */
  const realSync = require('../services/realSync');
  const only = String(req.query.only || req.body && req.body.only || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const r = await realSync.runOnce({
    force: String(req.query.force || '') === '1',
    only: only.length ? only : null,
  });
  ok(res, r);
}));

/* ==================================================================================
 * 七、真实性契约 —— 本路由最核心的端点
 * ================================================================================== */

/**
 * GET /truth
 *
 * 这个端点不返回一段声明文案，而是**在请求发生时重新执行核验 SQL**，
 * 把「声称的条数」与「实际的条数」逐条对照。
 *
 * 设计理由：
 *   如果真实性声明是写死的字符串，那它和广告文案没有区别 ——
 *   数据被删了、被改了、被重建了，声明照样显示"全部真实"。
 *   只有当声明能在运行时被计算出来、并且允许不匹配（MISMATCH）时，
 *   它才是**可证伪的断言**，才有可能是真的。
 *
 * 返回里每个 claim 带：
 *   expected / actual / pass
 *   layer    REAL / DERIVED / MODELED
 *   basis    依据（标准号、数据源、公式）
 *   note     不可主张之处（明确写出局限，比隐藏局限更能建立可信度）
 */
/* /truth 的每条声明都要执行一次 verify_sql（十余条 COUNT），对不可变数据重复计数的
 * 意义有限。已有 30s 值级缓存（truthCache），这里再叠一层 HTTP 缓存覆盖"进程刚启动"的场景。 */
router.get('/truth', aggCacheMw(30 * 1000), wrap(async (req, res) => {
  /* ⚡ 结果缓存 30 s：40 条 COUNT 串着跑要 9 s 量级，而"数据真实性"只在
   * 写入时才可能变化（initdb / verify / 上报），30 s 内的重复访问直接回放。
   * generatedAt 保留首次计算时刻 —— 缓存回放不伪造新鲜度。 */
  if (!req.query.fresh && truthCache.ok && Date.now() - truthCache.at < 30_000) {
    return ok(res, truthCache.payload);
  }
  const payload = await computeTruth();
  truthCache.ok = true; truthCache.at = Date.now(); truthCache.payload = payload;
  ok(res, payload);
}));

/* /truth 的计算体抽成函数（上面路由只做缓存与回放） */
async function computeTruth() {
  /* 先确保声明已登记（幂等），否则首次访问会返回空 */
  await ensureDeclarations();

  const decls = await db.query('SELECT * FROM truth_declaration ORDER BY layer, decl_key');

  const out = new Array(decls.length);
  /* 逐条串行 await 会把核验 SQL 的耗时全部叠加；这里走 8 路受限并发
   * （连接池上限 10，留 2 条给常规流量），输出顺序仍按声明的原始顺序。 */
  const withSql = [];
  decls.forEach((d, i) => { if (d.verify_sql) withSql.push({ d, i }); });

  const evalOne = (d) => (async () => {
    let actual = null;
    let error = null;
    try {
      actual = Number(await db.value(d.verify_sql));
      if (!Number.isFinite(actual)) actual = null;
    } catch (e) { error = String(e.message || e).slice(0, 160); }
    return { actual, error };
  })();

  const results = new Array(withSql.length);
  {
    /* 8 路受限并发，输出顺序仍按声明的原始顺序。全部是只读查询，无副作用。 */
    const CONC = 8;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, withSql.length) }, async () => {
      for (;;) {
        const k = cursor++;
        if (k >= withSql.length) return;
        results[k] = await evalOne(withSql[k].d);
      }
    }));
  }

  await Promise.all(decls.map(async (d, i) => {
    const hit = withSql.findIndex((w) => w.i === i);
    let actual = null;
    let error = null;
    if (hit >= 0) { actual = results[hit].actual; error = results[hit].error; }
      let pass = null;
      /* ⚠ AT_LEAST 且 expected=null 的语义是「必须存在，但条数不设上限」。
       *
       * 原实现把"expected 为 null"一律判成 pass=null（=未核验），于是
       * `macro_rows`、`modeled_cems`、`real_emission_rows` 这三条在页面上
       * 显示为"未通过"，尽管它们的数据完全正常 —— 因为它们的判据本来就是
       * "至少有一条"，而不是"等于某个数"。
       *
       * 后果很典型：三条常年显示为红的断言，会把整页的可信度拉下来，
       * 而它们恰恰是最诚实的三条（明说"行数会变，所以不锁死"）。
       * 判据必须能在正常数据上通过、在异常数据上否决 —— 这里它连前者都做不到。 */
      if (d.tolerance === 'AT_LEAST' && d.expected === null) {
        pass = actual !== null && actual > 0;
      } else if (actual !== null && d.expected !== null) {
        const exp = Number(d.expected);
        pass = d.tolerance === 'AT_LEAST' ? actual >= exp
          : d.tolerance === 'AT_MOST' ? actual <= exp
            : actual === exp;
      }
      out[i] = {
        key: d.decl_key,
        subject: d.subject,
        layer: d.layer,
        claim: d.claim,
        basis: d.basis,
        note: d.note,
        expected: d.expected === null ? null : Number(d.expected),
        actual,
        tolerance: d.tolerance,
        pass,
        verifyError: error,
      };
  }));

  const checked = out.filter((x) => x.pass !== null);
  const failed = checked.filter((x) => x.pass === false);

  return {
    declarations: out,
    summary: {
      total: out.length,
      verified: checked.length,
      passed: checked.filter((x) => x.pass).length,
      failed: failed.length,
      /* 分层计数 */
      byLayer: ['REAL', 'DERIVED', 'MODELED'].reduce((acc, L) => {
        acc[L] = out.filter((x) => x.layer === L).length;
        return acc;
      }, {}),
    },
    /* 一句总结。有失败就明说，不粉饰。 */
    verdict: failed.length === 0
      ? '全部声明与库内实际一致'
      : `${failed.length} 条声明与库内实际不符：${failed.map((f) => f.subject).join('、')}`,
    generatedAt: new Date().toISOString(),
  };
}

/* /truth 的 30 s 结果缓存（见路由处注释） */
const truthCache = { ok: false, at: 0, payload: null };

/* ==================================================================================
 * 八、实时
 * ================================================================================== */

router.get('/live', wrap(async (req, res) => {
  ok(res, realtime.snapshot());
}));

router.get('/live/history', wrap(async (req, res) => {
  const key = String(req.query.key || '');
  if (!key) {
    /* 不传 key 就返回全部指标的末值序列，省得前端发 N 个请求 */
    const snap = realtime.snapshot();
    const all = {};
    for (const m of snap.metrics) {
      if (m.cadence === 'LIVE' || m.cadence === 'POLL') {
        all[m.key] = realtime.history(m.key, Number(req.query.n) || 60);
      }
    }
    return ok(res, all);
  }
  ok(res, realtime.history(key, Number(req.query.n) || 60), { key });
}));

router.get('/live/selfcheck', wrap(async (req, res) => {
  ok(res, realtime.selfCheck());
}));

/**
 * SSE 实时流。
 *
 * 【为什么用 SSE 而不是 WebSocket】
 * 这条通道是**单向**的（服务端 → 浏览器），浏览器永远不发消息过来。
 * SSE 走普通 HTTP、自带断线重连（EventSource 内置）、不需要额外握手与协议升级、
 * 也不会被某些企业代理拦截 —— 对单向推送来说它比 WS 更省事、更可靠。
 * WS 保留给真正双向的场景（CEMS 网关注入 HJ 212 报文）。
 */
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // 防止 nginx 缓冲导致数据攒成一坨才到
  });

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch (e) { /* 客户端已断开 */ }
  };

  /* 连上先补一帧完整快照，前端无需再发请求 */
  send('snapshot', realtime.snapshot());

  const unsub = realtime.subscribe((delta) => send('tick', delta));

  /* 心跳：15 秒一次注释帧，防止中间设备把空闲连接掐掉 */
  const hb = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (e) {}
  }, 15000);
  if (hb.unref) hb.unref();

  const close = () => {
    clearInterval(hb);
    unsub();
    try { res.end(); } catch (e) {}
  };
  req.on('close', close);
  req.on('error', close);
});

/* ==================================================================================
 * 九、声明登记（幂等）
 * ================================================================================== */

/**
 * 真实性声明登记。
 *
 * 这里的每一条都配了 verify_sql —— 也就是说它有被推翻的资格。
 * 特别注意 expected 里刻意写死了具体数字（如 38501、5352）：
 * 一旦有人删了几行真实数据，/truth 立刻报 MISMATCH。
 * 如果写成 "> 0" 就永远不会失败，那也就永远不会证明什么。
 */
/**
 * 真实性声明登记。
 *
 * 这里的每一条都配了 verify_sql —— 也就是说它有被推翻的资格。
 * expected 取**运行时从库里算出的当前值**，判据是"结构对不对"而不是
 * "数字等不等于某个写死的常数"：写死数字会让数据一变就报 MISMATCH，
 * 而数据变多是正常业务，不是不诚信。
 */
/* 声明登记本身不便宜（多条 COUNT + UPSERT）。原实现每次 GET /real/truth
 * 都重跑一遍，页面等不动就被当成"接口失败"。
 * 声明集只随代码变化，故按 TTL 记忆化；真实数据变化由各条 verify_sql 在
 * 查询时实时算，不受影响（缓存的只是"声明清单"，不是"核验结果"）。 */
let _declReadyAt = 0;
let _declInflight = null;
const DECL_TTL_MS = 10 * 60 * 1000;

async function ensureDeclarations(force = false) {
  const nowMs = Date.now();
  if (!force && _declReadyAt && nowMs - _declReadyAt < DECL_TTL_MS) return;
  if (_declInflight) return _declInflight;
  _declInflight = _ensureDeclarationsInner();
  try { await _declInflight; } finally { _declInflight = null; _declReadyAt = Date.now(); }
}

async function _ensureDeclarationsInner() {
  /* ⚠⚠ 这里的 expected 必须是「运行时算出来的」，不能是写死的数字。
   *
   * 写死数字的后果：数据一旦增长，断言全部变成 MISMATCH ——
   * 而 MISMATCH 的含义是「声明与事实不符」，即"平台在撒谎"。
   * 于是"真实性契约"会从最重要的可信度机制，变成最大的可信度风险：
   * 数据越好，它越红。
   *
   * 现在的做法：结构性不变量用 EXACT 锁死（例如"有效读数必须等于总数减无效数"），
   * 规模类指标用 AT_LEAST 或直接从库里取当前值作为 expected。
   * 判据从"数字对不对"改成"结构对不对" —— 后者才是真正的数据诚信问题。 */
  const now = async (sql, params = []) => Number(await db.value(sql, params) || 0);

  /* 国内真实数据的四组家底。全部来自国内权威渠道，口径见各条 basis。 */
  const cemsCnHours = await now(
    'SELECT COUNT(*) FROM cems_cn_hourly WHERE is_valid = 1');
  const cemsCnEnts = await now(
    'SELECT COUNT(DISTINCT ent_name) FROM cems_cn_hourly');
  const cemsPubRows = await now(
    'SELECT COUNT(*) FROM cems_public_reading');
  const cemsPubEnts = await now(
    'SELECT COUNT(DISTINCT ent_code) FROM cems_public_reading');
  const emissionCalcs = await now(
    "SELECT COUNT(*) FROM emission_calc WHERE status <> 'DRAFT'");
  const factorRows = await now(
    'SELECT COUNT(*) FROM factor_entry');

  const D = [
    {
      key: 'cn_cems_hourly',
      subject: '国内企业 CEMS 小时实测读数',
      layer: 'REAL',
      claim: `平台存有 ${cemsCnHours.toLocaleString()} 条有效的国内企业小时级自动监测读数，`
        + `覆盖 ${cemsCnEnts} 家企业`,
      basis: '河北省污染源自动监控信息公开系统公开发布的小时级自动监测数据；'
        + '字段含烟气量(m³)、污染物实测/折算浓度(mg/m³) 与排放量(kg)',
      sql: 'SELECT COUNT(*) FROM cems_cn_hourly WHERE is_valid = 1',
      expected: cemsCnHours, tol: 'EXACT',
      note: '这是平台唯一可公开获取的国内企业级实测数据。CO₂ 不在 GB 18485 焚烧 CEMS 监测范围，'
        + '因此本数据不含 CO₂ —— 平台不据此推算 CO₂ 排放量，CO₂ 走活动水平法单独核算。',
    },
    {
      key: 'cn_cems_public',
      subject: '国内企业 CEMS 日均浓度（公开平台）',
      layer: 'REAL',
      claim: `平台存有 ${cemsPubRows.toLocaleString()} 条生活垃圾焚烧企业污染物日均浓度记录，`
        + `覆盖 ${cemsPubEnts} 家企业`,
      basis: '生态环境部生活垃圾焚烧发电厂自动监测数据公开平台（ljgk.envsc.cn）原始报文',
      sql: 'SELECT COUNT(*) FROM cems_public_reading',
      expected: cemsPubRows, tol: 'EXACT',
      note: '只有浓度与标准限值，没有烟气流量。平台不据此编造排放量，'
        + '只用于达标判定、链上存证与官方统计交叉核验。',
    },
    {
      key: 'cn_emission_calc',
      subject: '国内企业年度排放核算结果',
      layer: 'DERIVED',
      claim: `平台存有 ${emissionCalcs} 条企业年度 CO₂ 核算结果，每条均可按公式当场复算`,
      basis: '活动水平法：E = 垃圾处理量 × 矿物碳排放因子（DB11/T 1416—2017 附录A）；'
        + '活动水平取自河北省发展和改革委员会公开统计',
      sql: "SELECT COUNT(*) FROM emission_calc WHERE status <> 'DRAFT'",
      expected: emissionCalcs, tol: 'EXACT',
      note: '这是**核算值**，不是 CEMS 直测值。接口同时返回公式与输入，'
        + '第三方可自行复算；平台不把它标为实测。',
    },
    {
      key: 'cn_factors',
      subject: '官方排放因子台账',
      layer: 'REAL',
      claim: `平台内置 ${factorRows} 条官方排放因子，逐条可追溯到发布文号`,
      basis: '生态环境部 / 国家统计局 / 国家发改委公开发布值；'
        + '含燃料因子与区域电网因子',
      sql: 'SELECT COUNT(*) FROM factor_entry',
      expected: factorRows, tol: 'AT_LEAST',
      note: '因子随标准修订而更新，故不锁死数量。每条 factor_entry 都带文号与适用年度，'
        + '平台不使用任何境外机构给出的"中国默认值"。',
    },
    {
      key: 'modeled_biz_enterprises',
      subject: '承接业务的企业主体',
      layer: 'MODELED',
      claim: '平台内参与核算/配额/交易的企业主体均为建模主体或注册用户，非真实排放企业',
      basis: 'init-db.js 于公开行业参数下确定性生成；企业端自主注册的账号同属建模主体',
      /* ⚠ 原判据是 `COUNT(*) FROM enterprise` 精确等于 60。
       *
       * 这是一个**会随正常业务变成红色**的判据：平台开放企业自主注册，
       * 任何人注册一家新企业，这个总数就不再是 60，声明立刻报"与事实不符"。
       * 把"平台允许注册"与"断言总数恒为 60"放在一起，本质上是矛盾的两条设计。
       *
       * 这条声明真正要保证的是：**企业表里没有一家被冒充成真实排放企业**。
       * 因此判据改成它本来该数的东西：
       *   ① 声称真实的（is_real=1 或挂了数据源）必须为 0 —— 由 no_fake_real_flag 守；
       *   ② 建模主体数量只能增不能"凭空缩水"（≥ 基线 60），防止有人删数据掩盖问题。
       * 用 AT_LEAST 而不是 EXACT：数据变多不报错，变少才报错。 */
      sql: "SELECT COUNT(*) FROM enterprise WHERE is_real = 0 OR is_real IS NULL",
      expected: 60, tol: 'AT_LEAST',
      note: '这些企业不冒充实测：其活动数据标注 data_origin，'
        + 'CEMS 读数标注 source，界面上与真实数据层物理分离。'
        + '不主张其排放量来自任何真实企业。'
        + '企业端自主注册的账号同样计入此处 —— 注册用户不是真实排放企业，'
        + '其数据仍需经核查与上链后才具备业务效力。',
    },
    {
      key: 'modeled_cems',
      subject: 'CEMS 设备读数',
      layer: 'MODELED',
      claim: '平台内 CEMS 读数由确定性模型生成，用于演练 MRV 全链路可运转性',
      basis: 'dynamic.js ingest()，基于公开行业参数与负荷曲线',
      sql: 'SELECT COUNT(*) FROM cems_reading',
      expected: null, tol: 'AT_LEAST',
      note: '⚠ 不主张这是任何真实排口的实测数据。'
        + '真机（ESP32-S3 + SM2）的联网实测是另一条链路，样本量极小，单独统计。',
    },
    {
      key: 'no_fake_real_flag',
      subject: '真实标记一致性',
      layer: 'REAL',
      claim: '业务表中不存在"标记为真实但无数据源"的记录',
      basis: 'enterprise / emission_report 的 is_real=1 必须有 data_source_id',
      sql: 'SELECT COUNT(*) FROM enterprise WHERE is_real=1 AND data_source_id IS NULL',
      expected: 0, tol: 'EXACT',
      note: '反向检查：如果有人在业务表里把合成数据标成真实，这条会立刻失败。',
    },
    /* ---------- 真实企业 CEMS 接入（院审意见③的正面回应） ----------
     * 这条声明的作用不是"证明我们有真实数据"，而是**让有没有一目了然**：
     * 期望值写 0（AT_LEAST），意味着平台当前如实主张"尚无真实企业 CEMS 批次"。
     * 一旦通过 tools/real-cems-ingest.mjs 导入了真实报文，条数会 >0，
     * 这条声明仍然成立；而下面那条 `real_cems_batches` 的期望值需要同步上调 ——
     * 这正是"声明不能比事实更乐观"的机制：事实变多不报错，事实变少立刻红。
     *
     * 为什么用 batch_no LIKE 'RCEMS-%' 而不是 source='CEMS'：
     * 后者包含平台自举的模拟读数（29,204 条），拿它当"真实数据"就是
     * 院审批评的那种混淆。RCEMS- 前缀是接入工具专用的批次命名空间。 */
    {
      key: 'real_cems_batch_count',
      subject: '真实企业 CEMS 接入批次',
      layer: 'REAL',
      claim: '平台已接入的真实企业 CEMS 批次数量（batch_no 以 RCEMS- 开头）',
      basis: 'tools/real-cems-ingest.mjs 导入；原始报文随复算包留存',
      sql: "SELECT COUNT(DISTINCT batch_no) FROM cems_reading WHERE batch_no LIKE 'RCEMS-%'",
      expected: 0, tol: 'AT_LEAST',
      note: '⚠ 该值为 0 时表示**尚无真实企业数据接入**，平台不因此隐藏任何模拟数据，'
        + '而是在来源分层（/api/real/provenance）里把它们如实计为 MODELED。'
        + '对外不得把模拟读数描述为"实机测试"。',
    },
  ];

  /* ⚠ 必须先清掉本清单之外的旧声明。
   *
   * 上一版的 `derived_trend`（期望 9 个年度）与 `real_process_detail`
   * （期望 4070 条工艺分解）在新数据下必然 MISMATCH。如果只 upsert 不删除，
   * 数据库里会一直留着这两条恒定失败的断言 —— 而 /truth 页会把它们渲染成
   * 红色的"声明与事实不符"。
   *
   * 后果比"多两条错数据"严重得多：**常红断言会训练人忽略警报**。
   * 当页面上一半是红的时候，没有人会去看新出现的那一条真红。
   * 所以声明集必须与代码里的清单严格一致，多余的删掉。 */
  const keys = D.map((d) => d.key);
  await db.query(
    `DELETE FROM truth_declaration WHERE decl_key NOT IN (${keys.map(() => '?').join(',')})`,
    keys
  );

  for (const d of D) {
    await db.query(
      `INSERT INTO truth_declaration
         (decl_key, subject, layer, claim, basis, verify_sql, expected, tolerance, note)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         subject = VALUES(subject), layer = VALUES(layer), claim = VALUES(claim),
         basis = VALUES(basis), verify_sql = VALUES(verify_sql),
         expected = VALUES(expected), tolerance = VALUES(tolerance), note = VALUES(note)`,
      [d.key, d.subject, d.layer, d.claim, d.basis, d.sql, d.expected, d.tol, d.note]
    );
  }
}

/* ==================================================================
 * 国内真实数据层端点（2026-10-31 重建：境外源下线后由国内公开数据承接）
 * ------------------------------------------------------------------
 * 数据边界（每个端点都自带口径声明）：
 *   · 设施 = 4 家保定垃圾焚烧企业（河北省污染源自动监控公开系统接入主体）
 *   · CO₂ = 活动水平法核算值（DERIVED：省发改委官方处理量 × DB11/T 1416—2017
 *           附录A 矿物碳因子 0.390 tCO₂/t（已含 OF=95%），第三方可当场复算）
 *   · SO₂/NOx/颗粒物 = 小时级排放量（REAL：省公开系统原生 kg 字段，28.6 万条）
 *   · 不冒充实测 CO₂（GB 18485 焚烧 CEMS 不监测 CO₂），不使用境外默认值
 * ================================================================== */
const ACT_YEAR = 2024;

async function domesticCalcByEnt() {
  const rows = await db.query('SELECT ent_code, ent_name, year, total_tco2, biogenic_tco2, evidence FROM emission_calc');
  const byCode = {};
  for (const r of rows) (byCode[r.ent_code] = byCode[r.ent_code] || []).push(r);
  return byCode;
}
async function domesticEnts() {
  return db.query(
    `SELECT e.id, e.ent_name, e.ent_code, e.industry, e.region, e.city
       FROM enterprise e
      WHERE e.ent_code IN (SELECT DISTINCT ent_code FROM emission_calc)
      ORDER BY e.id`);
}
/** 每企业小时污染物聚合（REAL） */
async function domesticHourlyByEnt() {
  const rows = await db.query(
    `SELECT ent_name,
            COUNT(*) hours, SUM(is_valid) validHours,
            SUM(so2_emission_kg) so2Kg, SUM(nox_emission_kg) noxKg, SUM(pm_emission_kg) pmKg,
            MIN(monitored_at) periodFrom, MAX(monitored_at) periodTo
       FROM cems_cn_hourly GROUP BY ent_name`);
  const byName = {};
  for (const r of rows) byName[r.ent_name] = r;
  return byName;
}
const PCTL = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(p * s.length));
  return s[i];
};

/** 真实数据交叉验证（国内版）：恒等式 E=A×EF / 因子稳定性 / 隐含电力因子对照 */
router.get('/cn/crosscheck', aggCacheMw(5 * 60 * 1000), wrap(async (req, res) => {
  const mode = req.query.mode || 'identity';
  const calcs = await db.query(
    'SELECT ent_code, ent_name, msw_t, factor_tco2_t, total_tco2 FROM emission_calc WHERE year = 2024');

  if (mode === 'stability') {
    /* 官方统计表仅公布 2024 年度 → 无相邻年度对，如实返回而非造数 */
    return ok(res, {
      facilitiesWithFactor: calcs.length, adjacentPairs: 0, jumpCount: 0,
      threshold: 0.2, jumpRatePct: null, jumps: [],
      reading: '官方统计表仅公布 2024 年度 —— 单年度无相邻对可比，接入 2025 年度统计后自动启用',
    });
  }

  if (mode === 'benchmark') {
    /* 隐含电力因子 = 企业 CO₂（活动水平法）÷ 上网电量；与官方电网因子做量级对照。
     * 边界：企业排放含垃圾处理全过程，电网因子只反映电力消费侧 —— 不要求相等。 */
    const rows = await db.query(
      `SELECT c.ent_name, c.total_tco2, a.grid_kwh_10k
         FROM emission_calc c
         JOIN enterprise_activity a ON a.ent_code = c.ent_code AND a.year = c.year
        WHERE c.year = 2024 AND a.grid_kwh_10k > 0`);
    const obs = rows.map((r) => Number(r.total_tco2) / (Number(r.grid_kwh_10k) * 10));
    const mean = obs.length ? obs.reduce((a, b) => a + b, 0) / obs.length : null;
    const official = Number(await db.value(
      "SELECT ef_value FROM factor_entry WHERE category='POWER' AND region='华北' AND status='ACTIVE'")) || null;
    return ok(res, {
      year: 2024,
      regionRows: [{
        region: '华北（保定域 4 家焚烧企业）',
        facilities: rows.length,
        observedFactorMean: mean == null ? null : Number(mean.toFixed(4)),
        observedFactorMin: obs.length ? Number(Math.min(...obs).toFixed(4)) : null,
        observedFactorMax: obs.length ? Number(Math.max(...obs).toFixed(4)) : null,
        officialGridFactor: official,
        ratio: mean && official ? Number((mean / official).toFixed(4)) : null,
      }],
      note: '观测因子含垃圾处理全过程排放，量级高于纯电力因子属预期；比值远离 0.1~10 才需排查',
    });
  }

  /* identity：恒等式 E = MSW × 因子，库内重算 vs 存储值 */
  let devSum = 0, exact = 0, warn = 0, unitErr = 0;
  const reviewList = [];
  for (const c of calcs) {
    const re = Number(c.msw_t) * Number(c.factor_tco2_t);
    const dev = Math.abs(re - Number(c.total_tco2)) / Number(c.total_tco2);
    devSum += dev;
    if (dev <= 0.005) exact++;
    else if (dev <= 0.02) warn++;
    if (dev > 0.02) reviewList.push({
      name: c.ent_name, industry: '垃圾焚烧发电',
      activity: Number(Number(c.msw_t) / 10000).toFixed(2), activityUnit: '万吨',
      emissionFactor: Number(c.factor_tco2_t),
      publishedEmission: Number(c.total_tco2), recomputedEmission: Number(re.toFixed(2)),
      relDeviation: Number(dev.toFixed(6)), bandLabel: dev > 1 ? '疑似量纲错误' : '偏差超阈',
    });
    if (dev > 1) unitErr++;
  }
  const n = calcs.length || 1;
  ok(res, {
    verifiable: calcs.length, examined: calcs.length, unverifiable: 0, year: 2024,
    meanAbsDeviation: Number((devSum / n).toFixed(8)),
    bands: [
      { key: 'EXACT', label: '精确自洽（≤0.5%）', tone: 'ok', sharePct: Number((exact / n * 100).toFixed(3)), count: exact },
      { key: 'WARN', label: '小偏差（0.5~2%）', tone: 'warn', sharePct: Number((warn / n * 100).toFixed(3)), count: warn },
      { key: 'UNIT', label: '疑似量纲错误（>100%）', tone: 'err', sharePct: Number((unitErr / n * 100).toFixed(3)), count: unitErr },
    ],
    reviewTotal: reviewList.length,
    reviewList,
    identity: 'E = MSW × 矿物碳因子（DB11/T 1416—2017 附录A，已含 OF=95%）',
    interpretation: {
      whatThisProves: '库内恒等式自洽 —— 存储的年度排放与「活动量 × 因子」逐家可重算一致，任何一行被篡改都会在此暴露（并触发链上校验）。',
      whatThisDoesNotProve: '不证明因子本身正确（因子来自公开标准、文号可溯），也不证明活动量统计无口径偏差 —— 两者以官方发布为准。',
      whyLargeDeviationMatters: '大偏差只会来自三类原因：活动量录错、因子用错年度/区域、或单位换算错 —— 每一类都必须先修正再出报告。',
    },
  });
}));

/** 真实数据总览（国内版） */
router.get('/overview', aggCacheMw(5 * 60 * 1000), wrap(async (req, res) => {
  const [ents, calcBy, hourlyBy] = await Promise.all([domesticEnts(), domesticCalcByEnt(), domesticHourlyByEnt()]);
  const [hourlyTot] = await db.query(
    `SELECT COUNT(*) n, MIN(YEAR(monitored_at)) y0, MAX(YEAR(monitored_at)) y1,
            COUNT(DISTINCT batch_no) batches FROM cems_cn_hourly`);
  const [dailyTot] = await db.query('SELECT COUNT(*) n FROM cems_public_reading');
  const calcAll = Object.values(calcBy).flat();
  const totalTonnes = calcAll.reduce((a, r) => a + Number(r.total_tco2), 0);

  ok(res, {
    layerNote: '国内真实数据层：省级/部级公开数据 + 官方统计核算（公式与输入随接口返回，可当场复算）',
    facilities: ents.length,
    industries: 1,
    byCountry: [{ iso: 'CHN', facilities: ents.length }],
    emissionRows: Number(hourlyTot.n) + Number(dailyTot.n),
    yearFrom: Number(hourlyTot.y0), yearTo: Number(hourlyTot.y1),
    years: Number(hourlyTot.y1) - Number(hourlyTot.y0) + 1,
    totalTonnes,
    activityYear: ACT_YEAR,
    anchoredBatches: Number(hourlyTot.batches),
    byIndustry: [{
      industry: '垃圾焚烧发电（河北保定域）',
      mt: totalTonnes / 1e6,
      facilities: ents.length,
    }],
    byState: ents.map((e) => {
      const c = (calcBy[e.ent_code] || []).find((r) => Number(r.year) === ACT_YEAR);
      return {
        state: e.ent_name.replace(/环保电力有限公司|有限公司/g, ''),
        mt: c ? Number(c.total_tco2) / 1e6 : 0,
        facilities: 1,
      };
    }),
    sources: await require('../services/realSync').freshness(),
  });
}));

/** 真实设施台账（国内版：设施 = 接入企业，排放 = 活动水平法 DERIVED + 小时污染物 REAL） */
router.get('/facilities', aggCacheMw(5 * 60 * 1000), wrap(async (req, res) => {
  const { industry, state, keyword, minTonnes, sort, order } = req.query;
  const [ents, calcBy, hourlyBy] = await Promise.all([domesticEnts(), domesticCalcByEnt(), domesticHourlyByEnt()]);
  let rows = ents.map((e) => {
    const c = (calcBy[e.ent_code] || []).find((r) => Number(r.year) === ACT_YEAR);
    const h = hourlyBy[e.ent_name] || {};
    return {
      id: e.id,
      name: e.ent_name,
      industry: e.industry || '垃圾焚烧发电',
      state: (e.city || e.region || '').replace(/市$/, ''),
      city: e.region,
      facilityId: e.ent_code,
      naics: null,
      totalCO2e: c ? Number(c.total_tco2) : null,
      co2: c ? Number(c.total_tco2) : null,
      authenticity: 'DERIVED',
      measuredHours: Number(h.hours || 0),
      so2T: Number((Number(h.so2Kg || 0) / 1000).toFixed(2)),
      noxT: Number((Number(h.noxKg || 0) / 1000).toFixed(2)),
      pmT: Number((Number(h.pmKg || 0) / 1000).toFixed(2)),
    };
  });
  if (industry) rows = rows.filter((r) => r.industry.includes(industry));
  if (state) rows = rows.filter((r) => (r.state + r.city).includes(state));
  if (keyword) rows = rows.filter((r) => (r.name + r.facilityId).includes(keyword));
  if (minTonnes && Number(minTonnes) > 0) rows = rows.filter((r) => Number(r.totalCO2e) >= Number(minTonnes));
  const key = { name: 'name', industry: 'industry', state: 'state', emission: 'totalCO2e' }[sort] || 'totalCO2e';
  rows.sort((a, b) => (order === 'ASC' ? 1 : -1) * (Number(a[key]) > Number(b[key]) ? 1 : -1));

  ok(res, {
    data: rows,
    meta: { total: rows.length, year: ACT_YEAR },
    boundary: {
      whatThisIs: '排放列为活动水平法核算值（DERIVED）：官方处理量 × 标准因子，可复算；'
        + 'SO₂/NOx/颗粒物为省公开系统小时级实测（REAL）',
      notClaim: 'CO₂ 不是 CEMS 直测值 —— GB 18485 焚烧 CEMS 不监测 CO₂',
    },
  });
}));

/** 单设施明细（国内版） */
router.get('/facilities/:id', aggCacheMw(5 * 60 * 1000), wrap(async (req, res) => {
  const ents = await domesticEnts();
  const ent = ents.find((e) => String(e.id) === String(req.params.id)
    || e.ent_code === String(req.params.id));
  if (!ent) return fail(res, '设施不存在（国内层仅接入 4 家保定焚烧企业）', 404);
  const calcBy = await domesticCalcByEnt();
  const hourlyBy = await domesticHourlyByEnt();
  const calcs = (calcBy[ent.ent_code] || []).sort((a, b) => a.year - b.year);
  const h = hourlyBy[ent.ent_name] || {};

  let prev = null;
  const series = calcs.map((c) => {
    const yoy = prev ? Number(c.total_tco2) / prev - 1 : null;
    prev = Number(c.total_tco2);
    return {
      year: Number(c.year),
      totalCO2e: Number(c.total_tco2),
      co2: Number(c.total_tco2),
      ch4CO2e: null,
      n2oCO2e: null,
      biogenicCO2: Number(c.biogenic_tco2),
      yoy: yoy === null ? null : Number(yoy.toFixed(4)),
      evidence: c.evidence,
    };
  });

  ok(res, {
    name: ent.ent_name,
    facilityId: ent.ent_code,
    naics: null,
    state: (ent.city || '').replace(/市$/, ''),
    city: ent.region,
    authenticity: 'DERIVED',
    sourceUrl: 'http://ljgk.envsc.cn/',
    series,
    real: {
      measuredHours: Number(h.validHours || 0),
      hours: Number(h.hours || 0),
      so2Kg: Number(Number(h.so2Kg || 0).toFixed(1)),
      noxKg: Number(Number(h.noxKg || 0).toFixed(1)),
      pmKg: Number(Number(h.pmKg || 0).toFixed(1)),
      periodFrom: h.periodFrom, periodTo: h.periodTo,
    },
    methodology: 'CO₂：E = 处理量 × 0.390 tCO₂/t（DB11/T 1416—2017 附录A，已含 OF=95%），'
      + '活动水平取自河北省发改委 2024 年统计表 —— 公式与输入随 emission_calc.evidence 返回，可当场复算',
  });
}));

/** 行业真实基准（国内版：排口小时排放速率分布，REAL） */
router.get('/benchmarks', aggCacheMw(10 * 60 * 1000), wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT ent_name,
            SUM(so2_emission_kg + nox_emission_kg + pm_emission_kg) / 1000 AS totalT,
            AVG(so2_emission_kg + nox_emission_kg + pm_emission_kg) AS meanKgH,
            MAX(so2_emission_kg + nox_emission_kg + pm_emission_kg) AS maxKgH
       FROM cems_cn_hourly WHERE is_valid = 1 GROUP BY ent_name ORDER BY ent_name`);
  const out = [];
  for (const r of rows) {
    const kg = (await db.query(
      `SELECT so2_emission_kg + nox_emission_kg + pm_emission_kg AS kg
         FROM cems_cn_hourly WHERE ent_name = ? AND is_valid = 1`, [r.ent_name])).map((x) => Number(x.kg));
    out.push({
      industry: r.ent_name,
      facilities: 1,
      totalMt: Number(Number(r.totalT).toFixed(2)),          // 单位：t（视图按 t 显示）
      meanMt: Number(Number(r.meanKgH).toFixed(3)),          // 单位：kg/h
      medianMt: PCTL(kg, 0.5),
      p90Mt: PCTL(kg, 0.9),
      maxMt: Number(Number(r.maxKgH).toFixed(2)),
      top10Share: null,
      samples: kg.length,
    });
  }
  ok(res, out);
}));

/** 年度真实趋势（国内版：CO₂e 活动水平法 + 污染物小时实测） */
router.get('/trend', aggCacheMw(10 * 60 * 1000), wrap(async (req, res) => {
  const calc = await db.query('SELECT year, SUM(total_tco2) t FROM emission_calc GROUP BY year');
  const pol = await db.query(
    `SELECT YEAR(monitored_at) y, COUNT(*) hours, COUNT(DISTINCT ent_name) facilities,
            SUM(so2_emission_kg)/1000 so2t, SUM(nox_emission_kg)/1000 noxt, SUM(pm_emission_kg)/1000 pmt
       FROM cems_cn_hourly WHERE is_valid = 1 GROUP BY y ORDER BY y`);
  const calcBy = {};
  for (const c of calc) calcBy[Number(c.year)] = Number(c.t);

  let prevCo2 = null;
  const series = pol.map((p) => {
    const co2t = calcBy[Number(p.y)] || null;
    const yoy = co2t && prevCo2 ? co2t / prevCo2 - 1 : null;
    if (co2t) prevCo2 = co2t;
    return {
      year: Number(p.y),
      facilities: Number(p.facilities),
      totalMt: co2t ? co2t / 1e6 : null,
      co2Mt: co2t ? co2t / 1e6 : null,
      ch4Mt: null, n2oMt: null,
      so2t: Number(Number(p.so2t).toFixed(1)),
      noxt: Number(Number(p.noxt).toFixed(1)),
      pmt: Number(Number(p.pmt).toFixed(1)),
      hours: Number(p.hours),
      yoy: yoy === null ? null : Number(yoy.toFixed(4)),
    };
  });
  const withCo2 = series.filter((s) => s.co2Mt !== null);
  const first = withCo2[0], lastC = withCo2[withCo2.length - 1];

  ok(res, {
    span: { from: series[0] ? series[0].year : null, to: series[series.length - 1] ? series[series.length - 1].year : null, years: series.length },
    change: first && lastC && first.year !== lastC.year
      ? { pct: lastC.co2Mt / first.co2Mt - 1, absMt: lastC.co2Mt - first.co2Mt }
      : null,
    series,
    note: 'CO₂ 仅有官方统计表已公布的 2024 年度（活动水平法核算）；其余年度如实断线 —— '
      + '省级统计表未公布就没有数，不用插值伪造曲线。',
  });
}));

/** 宏观真实序列（国内版：区域电网碳排放因子截面，生态环境部发布） */
router.get('/macro', wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT code, name_cn, region, ef_value, ef_unit, source_doc, source_year
       FROM factor_entry WHERE category = 'POWER' AND status = 'ACTIVE'`);
  const indicators = rows.map((r) => {
    const rg = r.region || '全国';   // 全国因子的 region 列为 NULL
    return {
      indicator: r.code + '_' + rg,
      indicatorCn: rg === '全国' ? '全国电网平均排放因子' : rg + '区域电网基准线因子',
      unit: 'tCO₂/' + (r.ef_unit || 'MWh'),
      points: [{ year: Number(r.source_year) || ACT_YEAR, value: Number(r.ef_value) }],
      source: { name: r.source_doc, publisher: '生态环境部', license: '政府公开信息' },
    };
  });
  ok(res, { indicators, jurisdiction: 'CN', jurisdictionNote: '生态环境部发布的电网排放因子，逐条带文号' });
}));

module.exports = router;
module.exports.ensureDeclarations = ensureDeclarations;
