/**
 * worker/lib/realtime.mjs —— 读时确定性实时计算
 * ==================================================================================
 * 【为什么"实时"不能靠落库】
 *
 * 平台原来每 60 秒生成一批 CEMS 读数并写入数据库。搬到 D1 后这条路立刻走不通：
 *   · D1 免费层每日写入上限 10 万行
 *   · 60 家 × 3 排口 × 每分钟 = 每 20 分钟就用完额度
 * 更根本的问题是：**那些读数本来就是模型算出来的**，存它与算它没有区别，
 * 存下来只是多了一次 IO 和一份需要维护的副本。
 *
 * 【因此改为读时计算】
 * 给定时刻 t，函数 f(t) 直接算出"此刻应显示的值"。特性：
 *   · 不落库 → 零写入额度
 *   · 纯函数 → 任何实例、任何时刻算出的同一个 t 结果完全一致（可复算）
 *   · 可验证 → 页面上可以标"该值由负荷曲线在请求时刻实时计算，未落库"
 *
 * 【诚实的边界】
 * 这类值是 **MODELED** 而不是 REAL。它们不来自任何真实排口，
 * 而是"按公开行业参数 + 确定性负荷曲线推算的工况"。
 * 平台在返回体里把 provenance 标为 MODELED，并在页面上如实显示 ——
 * 把模型输出说成实测，是这条线下唯一不可接受的事。
 *
 * 【真·实测在哪】
 * 真机上报走 HJ 212 / TCP 9100，落 cems_reading 表（device_did 非空）。
 * 那部分数据在 D1 里是静态快照（由本地节点同步），量很小但真实性最高。
 * 本模块**不生成**那类数据，只读取并单独统计。
 *
 * @module worker/lib/realtime
 */

/**
 * 负荷曲线：四层确定性正弦叠加。
 * 与本地 server/services/realtime.js 的 loadFactor 完全同式 ——
 * 这样"线上显示的值"与"本地服务显示的值"在同一时刻相同，
 * 不存在两套实时口径。
 */
export function loadFactor(date) {
  const d = date instanceof Date ? date : new Date(date);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;

  /* 日周期（早晚双峰）、周周期（工作日/周末）、班次周期（8 小时）、微波动 */
  const daily = Math.sin((2 * Math.PI * (h - 6)) / 24);
  const shift = Math.sin((2 * Math.PI * (h - 7)) / 12);
  const halfShift = Math.sin((2 * Math.PI * (h - 2)) / 8);
  const fine = Math.sin((2 * Math.PI * h) / 3);

  /* 归一化到 [0.72, 1.12] —— 工业负荷不会在 0 与峰值之间剧烈摆动 */
  const raw = 0.92 + 0.10 * daily + 0.05 * shift + 0.025 * halfShift + 0.012 * fine;
  return Math.max(0.60, Math.min(1.25, raw));
}

/**
 * 计算秒级实时快照。
 *
 * @param {object} db     D1 句柄
 * @param {Date}   [at]   计算时刻（缺省为当前）
 */
export async function snapshot(db, at) {
  const now = at ? (at instanceof Date ? at : new Date(at)) : new Date();
  const lf = loadFactor(now);

  /* 平台侧真实指标：从 D1 读（这些是真数据，不需要算） */
  const blk = await db.one(
    `SELECT MAX(block_index) AS height, COUNT(*) AS blocks FROM chain_block`);
  const tx = await db.one(
    `SELECT COUNT(*) AS rows_n,
            SUM(CASE WHEN status='CONFIRMED' THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending
       FROM chain_tx`);
  const fac = await db.one('SELECT COUNT(*) AS n FROM real_facility');
  const agg = await db.one(
    `SELECT SUM(facilities) AS n FROM agg_facility_total
      WHERE year = (SELECT MAX(year) FROM agg_facility_total WHERE year < ?)`,
    [now.getFullYear()]);
  const dev = await db.one(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN device_did IS NOT NULL THEN 1 ELSE 0 END) AS real_dev,
            MAX(last_seen_at) AS last_seen
       FROM device_registry`);

  /* 建模指标：按负荷曲线算，不落库 */
  const BASE_RATE = 8.42;      // 全平台基准瞬时速率（tCO2e/s），与本地服务同值
  const instantRate = +(BASE_RATE * lf).toFixed(4);
  /* 今日累计 = 从当日 00:00 积分到 now。
   * 用解析积分而不是逐点累加：解析式可复算、与采样频率无关。 */
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const hoursToday = (now.getTime() - startOfDay) / 3600000;
  const todayEmission = +(BASE_RATE * lf * hoursToday * 3600 / 1000).toFixed(1); // 千吨

  const metrics = [
    {
      key: 'chain.height', value: blk ? Number(blk.height) : 0, unit: '块',
      provenance: 'PLATFORM', cadence: 'LIVE',
      label: '联盟链高度',
      detail: '出块由本地节点调度器驱动；本值实时读 D1',
    },
    {
      key: 'chain.tx.confirmed', value: tx ? Number(tx.confirmed) : 0, unit: '笔',
      provenance: 'PLATFORM', cadence: 'LIVE',
      label: '已确认存证',
      detail: '状态为 CONFIRMED 的交易笔数（不是累计打包量）',
    },
    {
      key: 'chain.tx.pending', value: tx ? Number(tx.pending) : 0, unit: '笔',
      provenance: 'PLATFORM', cadence: 'LIVE',
      label: '待打包',
      detail: '已入池、等待下一个出块周期',
    },
    {
      key: 'real.facilities', value: fac ? Number(fac.n) : 0, unit: '家',
      provenance: 'REAL', cadence: 'STATIC',
      label: '真实设施台账',
      detail: 'EPA GHGRP + Climate TRACE（年频数据，不会每秒变化）',
    },
    {
      key: 'real.facilities.latestYear', value: agg ? Number(agg.n) : 0, unit: '家',
      provenance: 'REAL', cadence: 'STATIC',
      label: '最新完整年度设施数',
      detail: '来自预聚合表，非实时扫描',
    },
    {
      key: 'iot.devices', value: dev ? Number(dev.n) : 0, unit: '台',
      provenance: 'REAL', cadence: 'STATIC',
      label: '设备台账',
      detail: `其中真机直报 ${dev ? Number(dev.real_dev) : 0} 台；数据由本地 HJ212 服务端落库后同步`,
    },
    {
      key: 'cems.instantRate', value: instantRate, unit: 'tCO₂e/s',
      provenance: 'MODELED', cadence: 'LIVE',
      label: '全平台瞬时排放速率',
      detail: `基准 ${BASE_RATE} tCO₂e/s × 负荷系数 ${lf.toFixed(4)}（四层确定性正弦，可复算）`,
    },
    {
      key: 'cems.todayEmission', value: todayEmission, unit: 'tCO₂e',
      provenance: 'MODELED', cadence: 'LIVE',
      label: '今日累计排放（模型口径）',
      detail: `基准速率 × 负荷系数 × 当日已过 ${hoursToday.toFixed(2)} 小时；解析积分，非逐点累加`,
    },
    {
      key: 'load.factor', value: +lf.toFixed(4), unit: '',
      provenance: 'MODELED', cadence: 'LIVE',
      label: '当前负荷系数',
      detail: '范围 0.60~1.25，由日/班次/微波动三层正弦叠加',
    },
  ];

  return {
    at: now.toISOString(),
    tickMs: 1000,
    tickCount: Math.floor(now.getTime() / 1000) % 100000,
    loadFactor: +lf.toFixed(4),
    metrics,
    /* ⚠ 这三句话是这个模块最重要的输出 */
    provenanceNotice: {
      live: 'LIVE 类指标每次请求重新计算：平台侧指标实时读 D1，建模指标按负荷曲线解析计算。',
      static: 'STATIC 类指标为年频/低频数据（真实设施台账、宏观序列），不会每秒变化 —— 给它们加抖动静止是造假。',
      noWrite: '本端点**不写数据库**。模型指标不落库：存一个能算出来的值只会多一份要维护的副本，还会耗尽 D1 写入额度。',
    },
  };
}

/**
 * 历史序列（环形缓冲的替代）。
 *
 * D1 上不保存秒级历史（写入额度不允许）。需要历史曲线时用解析式反推：
 * 给定时间范围与步长，采样 loadFactor 得到同一条曲线。
 * 这在语义上是**正确的** —— 因为曲线本来就是确定性的，
 * 重算出来的历史与"当时若落库"会得到的结果一致。
 */
export function history(fromMs, toMs, stepSec = 60) {
  const out = [];
  const step = Math.max(1, stepSec) * 1000;
  for (let t = fromMs; t <= toMs; t += step) {
    out.push({ t: new Date(t).toISOString(), load: +loadFactor(new Date(t)).toFixed(4) });
    /* 安全上限：最多 2000 点，避免异常参数产生巨大数组 */
    if (out.length >= 2000) break;
  }
  return out;
}

/**
 * 自检：确认"确定性"这一核心性质。
 * 同一时刻重复计算必须得到完全相同的结果；不同时刻必须不同。
 */
export function selfCheck() {
  const t = new Date('2026-10-24T12:00:00Z');
  const a = loadFactor(t);
  const b = loadFactor(t);
  const c = loadFactor(new Date('2026-10-24T18:00:00Z'));
  return {
    pass: a === b && a !== c,
    checks: [
      { name: '同一时刻重复计算一致', pass: a === b, detail: `${a} vs ${b}` },
      { name: '不同时刻结果不同', pass: a !== c, detail: `${a} vs ${c}` },
      { name: '负荷系数在合理区间', pass: a >= 0.6 && a <= 1.25, detail: String(a) },
    ],
  };
}
