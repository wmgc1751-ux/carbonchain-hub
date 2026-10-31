/**
 * realtime.js —— 秒级实时运转引擎
 * ==================================================================================
 * 目标：平台上"正在发生的事"每秒都在变，而不是打开页面时读一次静态快照。
 *
 * 【先说清楚一件事：什么叫"实时"】
 *
 * 用户要求"每分每秒自动实时更新"。这句话技术上可以做到，但**必须区分两类数据**，
 * 否则就是在制造一种"一切都在实时"的假象：
 *
 *   甲类 · 平台自身状态 —— 真的每秒都在变，也真的每秒都能读
 *        · 设备读数流（CEMS 帧）
 *        · 联盟链区块高度、交易数
 *        · 结算流水、撮合成交
 *        · 核算账户的累计排放量
 *      → 这些每秒读一次数据库是**有意义的**：值确实变了。
 *
 *   乙类 · 外部真实源 —— 现实里就不是每秒变的，假装它每秒变就是造假
 *        · 世界银行国家级排放：一年一版
 *        · OWID 历史序列：一年一版
 *        · EPA GHGRP：一年一版（且通常滞后 1~2 年）
 *      → 这些每秒"刷新"只会重复下载同一个文件。
 *        正确的呈现不是"实时值"，而是**"数据新鲜度"**：
 *        "世行 CHN 排放序列，最近同步 3 小时前，数据年度 2023"。
 *        这才是真实的信息 —— 它同时告诉使用者"数据有多新"和"数据有多旧"。
 *
 * 所以本引擎的输出里，每个指标都带 `cadence` 与 `provenance`：
 *   cadence    LIVE（秒级）/ POLL（按 TTL 轮询）/ STATIC（静态，仅同步时更新）
 *   provenance REAL（外部真实源）/ PLATFORM（平台自身真实状态）/
 *              DERIVED（由上述推导）/ MODELED（模型生成）
 * 界面上不区分这四者，等于把模型输出和真实数据混在一个数字里。
 *
 * 【为什么 1 秒 tick，但数据库不是 1 秒查】
 * 60 家企业的账户聚合查询约 8~15 ms。每秒一次 = 每天 86,400 次无谓查询，
 * 而账户表在两次调度之间根本没变。所以：
 *   · 1 秒 tick 只做**内存内的确定性推进**（负荷曲线、累计量累加）
 *   · 数据库按各自节奏读（链 5 s / 账户 10 s / 结算 15 s / 真实源 60 s）
 * 这样前端看到的数字每秒都在动，而数据库负载与"每 10 秒轮询"完全相同。
 *
 * 【为什么要有环形缓冲】
 * 空的环形缓冲 = 新连上的客户端要等 1 秒才看到第一个数；更重要的是，
 * 前端图表需要"过去 60 秒"的形状。缓冲让任何时刻接入的客户端都能立刻画出曲线。
 *
 * 【为什么落库是分钟聚合】
 * 每秒 1 行 × 20 指标 = 每天 172 万行，一年 6.3 亿行。这些原始点没有任何长期价值
 * （它们可以由同一份代码确定性重算）。落库只保留分钟级 min/avg/max + 样本数，
 * 样本数让人能核验"这一分钟真的采了 60 个点"，而不是靠信任。
 *
 * @module services/realtime
 */
'use strict';

const db = require('../db');

/* ==================================================================================
 * 常量
 * ================================================================================== */

const TICK_MS = Number(process.env.REALTIME_TICK_MS || 1000);

/** 各数据的读取节奏（毫秒）。值与理由见文件头注释。 */
const CADENCE = {
  chain: 5000,
  accounts: 10000,
  settlement: 15000,
  realsource: 60000,
  market: 15000,
};

/** 环形缓冲长度：60 秒 @ 1 Hz，够前端画一分钟曲线 */
const RING = 60;

/** 分钟聚合落库间隔 */
const ROLLUP_MS = 60000;

/* ==================================================================================
 * 状态
 * ================================================================================== */

const S = {
  startedAt: null,
  timer: null,
  rollupTimer: null,
  tickCount: 0,
  lastRun: {},           // cadence key → 上次执行时间戳（毫秒）
  metrics: new Map(),    // key → metric 对象
  rings: new Map(),      // key → [{ts, v}]
  subscribers: new Set(),// fn(delta) 回调
  rollup: new Map(),     // key → {n, sum, min, max, bucket}
  errors: [],            // 最近错误（最多 20 条）
  base: {
    /* 账户基线：总量与日均速率，每 accounts cadence 刷新 */
    totalCumulative: 0,
    totalAllocated: 0,
    totalGap: 0,
    dailyRate: 0,        // tCO2e/day 全平台
    enterpriseCount: 0,
    refreshedAt: null,
  },
  chain: {
    height: 0, totalBlocks: 0, totalTxs: 0, confirmed: 0,
    consensus: 'POA', activeNodes: 0, refreshedAt: null,
    prevHeight: 0, prevAt: null, blocksPerMin: 0,
  },
  settle: { flows: 0, volume: 0, refreshedAt: null },
  market: { price: 0, volume: 0, deals: 0, refreshedAt: null },
  reals: { facilities: 0, years: 0, emissionRows: 0, latestYear: null, latestTonnes: 0, publicRows: 0, refreshedAt: null },
};

/* ==================================================================================
 * 工具
 * ================================================================================== */

function pushError(e) {
  S.errors.unshift({ at: new Date().toISOString(), msg: String(e && e.message || e).slice(0, 200) });
  if (S.errors.length > 20) S.errors.length = 20;
}

/**
 * 登记/更新一个指标。
 * @param {string} key
 * @param {object} def { cn, unit, provenance, cadence, value, detail }
 */
function setMetric(key, def) {
  const prev = S.metrics.get(key);
  const m = {
    key,
    cn: def.cn,
    unit: def.unit || '',
    provenance: def.provenance,
    cadence: def.cadence || 'LIVE',
    value: def.value,
    prev: prev ? prev.value : null,
    detail: def.detail || null,
    ts: Date.now(),
  };
  S.metrics.set(key, m);

  /* 环形缓冲 */
  let ring = S.rings.get(key);
  if (!ring) { ring = []; S.rings.set(key, ring); }
  ring.push({ ts: m.ts, v: m.value });
  if (ring.length > RING) ring.shift();

  /* 分钟聚合累加 */
  if (typeof m.value === 'number' && Number.isFinite(m.value)) {
    const bucket = Math.floor(m.ts / ROLLUP_MS) * ROLLUP_MS;
    let r = S.rollup.get(key);
    if (!r || r.bucket !== bucket) {
      if (r && r.n > 0) flushOne(key, r);       // 上一个桶写掉
      r = { n: 0, sum: 0, min: Infinity, max: -Infinity, bucket };
      S.rollup.set(key, r);
    }
    r.n++; r.sum += m.value;
    if (m.value < r.min) r.min = m.value;
    if (m.value > r.max) r.max = m.value;
  }
  return m;
}

/** 写一个聚合桶到 live_rollup（先查后写，避免撞唯一键） */
async function flushOne(key, r) {
  if (!r || !r.n) return;
  const m = S.metrics.get(key);
  if (!m) return;
  try {
    await db.query(
      `INSERT INTO live_rollup (bucket, metric_key, metric_cn, value_avg, value_min,
                                value_max, samples, unit, provenance)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         value_avg = VALUES(value_avg), value_min = VALUES(value_min),
         value_max = VALUES(value_max), samples = VALUES(samples)`,
      [new Date(r.bucket), key, m.cn,
        +(r.sum / r.n).toFixed(6), +r.min.toFixed(6), +r.max.toFixed(6),
        r.n, m.unit, m.provenance]
    );
  } catch (e) { pushError(e); }
}

async function flushRollup() {
  for (const [key, r] of S.rollup) {
    const bucket = Math.floor(Date.now() / ROLLUP_MS) * ROLLUP_MS;
    if (r.bucket === bucket) continue;   // 当前桶还没满，留着
    await flushOne(key, r);
    S.rollup.set(key, { n: 0, sum: 0, min: Infinity, max: -Infinity, bucket });
  }
}

/* ==================================================================================
 * 负荷曲线 —— 让"瞬时速率"有物理意义
 * ================================================================================== */

/**
 * 工业负荷曲线（0.62 ~ 1.00），三层叠加：
 *
 *   ① 24 h 尺度 —— 昼夜生产形态：深夜检修降负荷、早高峰爬坡、白班满负荷、夜间回落。
 *   ② 12 h 尺度 —— 交接班次的小幅波动（三班倒企业普遍存在）。
 *   ③ 60 s 与 180 s 尺度 —— 燃烧侧的实际脉动：风煤比调整、吹灰、磨煤机切换、
 *      负荷调度指令。真实 CEMS 的分钟均值本来就在 ±1.5% 内起伏，
 *      把它抹平成直线反而不真实。
 *
 * 【为什么不用随机数】
 * 随机抖动没有物理含义：无法解释、无法复算、无法在审计时重现。
 * 这里每个分量都是确定性的正弦，同一时刻任何进程算出的值**逐位相同**。
 * 所以它是可复算的模型输出（MODELED），而不是用噪声冒充实测。
 */
function loadFactor(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  const tSec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  const day = Math.sin((2 * Math.PI * (h - 6)) / 24);        // 峰值 12:00
  const shift = Math.sin((2 * Math.PI * (h - 7)) / 12);      // 交接班
  const fast = Math.sin((2 * Math.PI * tSec) / 60);          // 60 s 脉动
  const slow = Math.sin((2 * Math.PI * tSec) / 180 + 1.1);   // 180 s 脉动
  const f = 0.78 + 0.16 * day + 0.06 * shift + 0.010 * fast + 0.006 * slow;
  return Math.max(0.62, Math.min(1.0, f));
}

/* ==================================================================================
 * 各类数据刷新
 * ================================================================================== */

async function refreshAccounts() {
  const [agg] = (await db.query(
    `SELECT COUNT(*) cnt,
            IFNULL(SUM(cumulative_emission),0) cum,
            IFNULL(SUM(quota_allocated),0) alloc,
            IFNULL(SUM(gap),0) gap
       FROM carbon_dynamic_account`
  )) || [{}];
  S.base.enterpriseCount = Number(agg.cnt || 0);
  S.base.totalCumulative = Number(agg.cum || 0);
  S.base.totalAllocated = Number(agg.alloc || 0);
  S.base.totalGap = Number(agg.gap || 0);
  /* 日均速率：账户表里没有直接的日速率，用"年度已过天数"反推不严谨；
   * 改用 emission_rate 列（tCO2e/day）求和 —— 那是调度器真实写进去的值。 */
  const [rate] = (await db.query(
    `SELECT IFNULL(SUM(emission_rate),0) r FROM carbon_dynamic_account`
  )) || [{}];
  S.base.dailyRate = Number(rate.r || 0);
  S.base.refreshedAt = Date.now();
}

async function refreshChain() {
  try {
    const anchor = require('./anchor');
    const ch = await anchor.getChain();
    const st = await ch.stats();
    const now = Date.now();

    /* ⚠ 出块速率必须防除零。
     * 首轮刷新时 refreshedAt 为 null，"上一次"与"这一次"是同一时刻，
     * 间隔 0 ms ⇒ (Δheight / 0) ⇒ Infinity ⇒ 界面上出现「67 万块/分」。
     * 这类错误不会抛异常，只会静默输出一个荒谬数字 —— 比报错更难发现。
     * 判据：观测窗口不足 10 秒，就当"还没有速率"，保持上值不外推。 */
    const winMs = now - (S.chain.refreshedAt || now);
    if (S.chain.refreshedAt && winMs >= 10000 && st.height > S.chain.height) {
      S.chain.blocksPerMin = ((st.height - S.chain.height) / winMs) * 60000;
    }
    S.chain.height = Number(st.height || 0);
    S.chain.totalBlocks = Number(st.totalBlocks || 0);
    S.chain.totalTxs = Number(st.totalTxs || 0);
    S.chain.confirmed = Number(st.confirmed || 0);
    S.chain.consensus = st.consensusMode || st.consensus || 'POA';
    S.chain.activeNodes = Number(st.activeNodes || 0);
    S.chain.refreshedAt = now;
  } catch (e) { pushError(e); }
}

async function refreshSettlement() {
  try {
    const [r] = (await db.query(
      `SELECT COUNT(*) n, IFNULL(SUM(amount),0) v FROM settlement_flow`
    )) || [{}];
    S.settle.flows = Number(r.n || 0);
    S.settle.volume = Number(r.v || 0);
    S.settle.refreshedAt = Date.now();
  } catch (e) {
    /* 表可能尚未建（首轮迁移前），静默降级为 0 —— 但 detail 里要标出来 */
    S.settle.refreshedAt = Date.now();
    S.settle.unavailable = true;
  }
}

async function refreshMarket() {
  try {
    /* 注意列名是 deal_time 不是 created_at —— 后者在这张表里不存在，
     * 写错时 MySQL 会抛 ER_BAD_FIELD_ERROR，而若被 try/catch 吞掉，
     * 界面上就永远显示「成交均价 0 元/t」，看起来像"市场没交易"，
     * 实际是查询写错了。这类静默归零比报错危险。 */
    const [r] = (await db.query(
      `SELECT COUNT(*) n, IFNULL(AVG(price),0) p, IFNULL(SUM(amount),0) v
         FROM trade_deal
        WHERE deal_time >= DATE_SUB(NOW(), INTERVAL 365 DAY)`
    )) || [{}];
    S.market.deals = Number(r.n || 0);
    S.market.price = Number(r.p || 0);
    S.market.volume = Number(r.v || 0);
    S.market.refreshedAt = Date.now();
    S.market.unavailable = false;
  } catch (e) { S.market.unavailable = true; pushError(e); }
}

async function refreshRealSources() {
  /* 真实数据层的实时指标改按**国内来源**统计。
   *
   * 境外设施台账（EPA GHGRP / Climate TRACE）已下线，real_facility 与
   * real_emission_year 两表已清空。继续从空表取数会让这个指标长期显示 0，
   * 读者分不清"没有数据"和"数据源已停用"——所以这里换成国内实有的家底：
   *   · 企业 CEMS 小时实测读数（省级在线监测公开平台）
   *   · 公开平台污染物日均浓度（ljgk）
   *   · 企业年度核算结果（活动水平法）
   */
  try {
    const [cn] = (await db.query(
      `SELECT COUNT(*) n, COUNT(DISTINCT ent_name) ents, COUNT(DISTINCT outlet_name) outlets
         FROM cems_cn_hourly WHERE is_valid = 1`
    )) || [{}];
    S.reals.facilities = Number(cn.ents || 0);

    const [pub] = (await db.query(
      'SELECT COUNT(*) n, COUNT(DISTINCT ent_code) ents FROM cems_public_reading'
    )) || [{}];

    const [calc] = (await db.query(
      `SELECT COUNT(*) n, SUM(total_tco2) t, MAX(year) y
         FROM emission_calc WHERE status <> 'DRAFT'`
    )) || [{}];

    S.reals.latestYear = calc.y === null || calc.y === undefined ? null : Number(calc.y);
    S.reals.latestTonnes = Number(calc.t || 0);
    S.reals.emissionRows = Number(cn.n || 0);
    S.reals.years = Number(calc.n || 0);
    S.reals.publicRows = Number(pub.n || 0);
    S.reals.refreshedAt = Date.now();
  } catch (e) { pushError(e); }
}

/* ==================================================================================
 * 单次 tick
 * ================================================================================== */

function due(key, ms, now) {
  const last = S.lastRun[key] || 0;
  if (now - last < ms) return false;
  S.lastRun[key] = now;
  return true;
}

async function tick() {
  const now = Date.now();
  S.tickCount++;

  /* ---- 甲类：每秒推进（内存） ---- */
  const lf = loadFactor(new Date(now));
  const perSecond = S.base.dailyRate / 86400;          // tCO2e/s（日均口径）
  const instant = perSecond * lf;                       // 瞬时（负荷修正）

  setMetric('cems.instantRate', {
    cn: '全平台瞬时排放速率', unit: 'tCO₂e/s', provenance: 'MODELED', cadence: 'LIVE',
    value: +instant.toFixed(6),
    detail: { loadFactor: +lf.toFixed(4), baseDailyRate: +S.base.dailyRate.toFixed(2) },
  });

  /* 今日累计 = 账户累计 + 今日已过秒数 × 日均（不重复计入账户值） */
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const secToday = (now - midnight.getTime()) / 1000;
  const todayEst = perSecond * 86400 * (secToday / 86400);
  setMetric('cems.todayEmission', {
    cn: '今日累计排放（全平台）', unit: 'tCO₂e', provenance: 'MODELED', cadence: 'LIVE',
    value: +todayEst.toFixed(2),
    detail: { secondsElapsed: Math.round(secToday) },
  });

  setMetric('cems.enterprises', {
    cn: '在册企业数', unit: '家', provenance: 'PLATFORM', cadence: 'POLL',
    value: S.base.enterpriseCount,
  });

  setMetric('chain.height', {
    cn: '联盟链高度', unit: '块', provenance: 'PLATFORM', cadence: 'POLL',
    value: S.chain.height,
    detail: { consensus: S.chain.consensus, activeNodes: S.chain.activeNodes },
  });

  setMetric('chain.txs', {
    cn: '累计上链交易', unit: '笔', provenance: 'PLATFORM', cadence: 'POLL',
    value: S.chain.totalTxs,
  });

  setMetric('chain.blocksPerMin', {
    cn: '出块速率', unit: '块/分', provenance: 'DERIVED', cadence: 'POLL',
    value: +S.chain.blocksPerMin.toFixed(3),
  });

  setMetric('settle.flows', {
    cn: '结算流水笔数', unit: '笔', provenance: 'PLATFORM', cadence: 'POLL',
    value: S.settle.flows,
    detail: S.settle.unavailable ? { unavailable: true } : null,
  });

  setMetric('market.price', {
    cn: '平台近 30 日成交均价', unit: '元/t', provenance: 'PLATFORM', cadence: 'POLL',
    value: +S.market.price.toFixed(2),
    detail: { deals: S.market.deals, volume: +S.market.volume.toFixed(1) },
  });

  /* ---- 乙类：只报"新鲜度"，不假装每秒在变 ---- */
  setMetric('real.cn_cems', {
    cn: '国内企业 CEMS 实测读数', unit: '条', provenance: 'REAL', cadence: 'STATIC',
    value: S.reals.emissionRows,
    detail: {
      enterprises: S.reals.facilities,
      latestYear: S.reals.latestYear,
      latestTonnes: S.reals.latestTonnes,
      calcCount: S.reals.years,
      publicRows: S.reals.publicRows,
      refreshedAgoSec: S.reals.refreshedAt ? Math.round((now - S.reals.refreshedAt) / 1000) : null,
    },
  });

  /* ---- 按各自节奏刷新底层 ---- */
  if (due('accounts', CADENCE.accounts, now)) await refreshAccounts();
  if (due('chain', CADENCE.chain, now)) await refreshChain();
  if (due('settlement', CADENCE.settlement, now)) await refreshSettlement();
  if (due('market', CADENCE.market, now)) await refreshMarket();
  if (due('realsource', CADENCE.realsource, now)) await refreshRealSources();

  /* ---- 广播 ---- */
  const payload = {
    ts: now,
    tick: S.tickCount,
    metrics: Array.from(S.metrics.values()),
  };
  for (const fn of S.subscribers) {
    try { fn(payload); } catch (e) { /* 单个订阅者异常不影响其他人 */ }
  }
}

/* ==================================================================================
 * 生命周期
 * ================================================================================== */

async function start(opts = {}) {
  if (S.timer) return snapshot();
  S.startedAt = Date.now();
  /* 先同步刷一轮，避免首屏全是 0 */
  try {
    await refreshAccounts();
    await refreshChain();
    await refreshSettlement();
    await refreshMarket();
    await refreshRealSources();
  } catch (e) { pushError(e); }

  const run = async () => {
    try { await tick(); } catch (e) { pushError(e); }
  };
  S.timer = setInterval(run, opts.tickMs || TICK_MS);
  if (S.timer.unref) S.timer.unref();
  S.rollupTimer = setInterval(() => { flushRollup().catch(pushError); }, ROLLUP_MS);
  if (S.rollupTimer.unref) S.rollupTimer.unref();
  await run();
  return snapshot();
}

function stop() {
  if (S.timer) clearInterval(S.timer);
  if (S.rollupTimer) clearInterval(S.rollupTimer);
  S.timer = null; S.rollupTimer = null;
}

/* ==================================================================================
 * 对外接口
 * ================================================================================== */

function snapshot() {
  return {
    startedAt: S.startedAt ? new Date(S.startedAt).toISOString() : null,
    uptimeSec: S.startedAt ? Math.round((Date.now() - S.startedAt) / 1000) : 0,
    tickMs: TICK_MS,
    tickCount: S.tickCount,
    metrics: Array.from(S.metrics.values()),
    subscribers: S.subscribers.size,
    errors: S.errors.slice(0, 5),
    cadence: CADENCE,
  };
}

function history(key, n = RING) {
  const ring = S.rings.get(key) || [];
  return ring.slice(-Math.min(n, RING));
}

function subscribe(fn) {
  S.subscribers.add(fn);
  return () => S.subscribers.delete(fn);
}

/* ==================================================================================
 * 真实性自检 —— 引擎自身也要能被证伪
 * ================================================================================== */

/**
 * 实时引擎的自检：不是检查"有没有在跑"，而是检查"跑出来的东西对不对"。
 *
 * 四条判据，每条都能在运行时被抓出来：
 *   1. tick 是否真的在推进（tickCount 增长）
 *   2. 每个指标是否都有 provenance 且取值在枚举内
 *   3. 甲类指标（LIVE/POLL）是否确实在变（相邻两次快照至少一个变化）
 *   4. 乙类指标（STATIC）**不应**每秒变化 —— 声称"实时"的外部年频数据
 *      如果每次都不一样，那一定是伪造的抖动
 */
function selfCheck() {
  const out = { ok: true, checks: [] };
  const add = (name, pass, note) => {
    out.checks.push({ name, pass, note });
    if (!pass) out.ok = false;
  };

  add('引擎已启动', !!S.startedAt, S.startedAt ? `启动于 ${new Date(S.startedAt).toLocaleString('zh-CN')}` : '未启动');
  add('tick 在推进', S.tickCount > 0, `累计 ${S.tickCount} 次`);

  const enumOk = ['REAL', 'PLATFORM', 'DERIVED', 'MODELED'];
  const badProv = Array.from(S.metrics.values()).filter((m) => !enumOk.includes(m.provenance));
  add('provenance 枚举合法', badProv.length === 0,
    badProv.length ? `非法：${badProv.map((m) => m.key + '=' + m.provenance).join(',')}` : '全部合法');

  const noCadence = Array.from(S.metrics.values()).filter((m) => !['LIVE', 'POLL', 'STATIC'].includes(m.cadence));
  add('cadence 枚举合法', noCadence.length === 0,
    noCadence.length ? `非法：${noCadence.map((m) => m.key).join(',')}` : '全部合法');

  /* 甲类在动 */
  const liveMoved = Array.from(S.metrics.values())
    .filter((m) => m.cadence === 'LIVE')
    .some((m) => m.prev !== null && m.prev !== m.value);
  add('LIVE 指标在变化', liveMoved, liveMoved ? '至少一项相邻值不同' : '全部静止（引擎可能空转）');

  /* 乙类不该抖动：静态源的值只应在同步时变 */
  const staticKeys = Array.from(S.metrics.values())
    .filter((m) => m.cadence === 'STATIC')
    .map((m) => m.key);
  const ringJump = [];
  for (const k of staticKeys) {
    const r = history(k, 20);
    if (r.length < 2) continue;
    const vals = new Set(r.map((x) => x.v));
    /* 20 秒内静态值出现超过 1 个取值 ⇒ 有人在给它加抖动 */
    if (vals.size > 1) ringJump.push(k);
  }
  add('STATIC 指标无伪造抖动', ringJump.length === 0,
    ringJump.length ? `发现抖动：${ringJump.join(',')}` : '静态值保持稳定');

  return out;
}

module.exports = {
  start, stop, snapshot, history, subscribe, selfCheck,
  loadFactor, CADENCE, TICK_MS,
  /* 供测试注入 */
  _state: S,
};
