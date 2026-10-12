/**
 * dynamic.js —— 碳资产动态核算引擎
 * ------------------------------------------------------------------
 * 这是"动态核算"的落地实现，替代原先"按季度人工填报"的静态核算：
 *
 *   1. 实时采数   模拟工业排口 CEMS 在线监测设备按小时推送排放读数
 *                 （烟气流量折算为 tCO2e/h），取代人工季度填报。
 *   2. 滚动核算   基于实测读数**持续滚动**计算：年度累计排放、当前排放速率、
 *                 按速率外推的期末排放量。
 *   3. 动态配额   把滚动核算结果与配额账户比对，实时算出**配额缺口**，
 *                 并按缺口大小动态给出履约风险等级。
 *   4. 动态预警   缺口/风险越过阈值时，自动产生监管预警（写入 alert_record）。
 *
 * 核算口径与静态上报保持一致（Scope1/2 折算为 tCO2e），因此两条路径可互相印证。
 *
 * @module services/dynamic
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const config = require('../config');

/** 行业日均排放强度基准（tCO2e/天，中型企业）：用于生成可复现的模拟实测数据 */
const INDUSTRY_BASE = {
  电力: 1800, 钢铁: 1600, 建材: 900, 化工: 1100,
  有色金属: 1000, 造纸: 500, 石化: 1400,
};
const SCALE_RATIO = { 大型: 1.6, 中型: 1.0, 小型: 0.55 };

/** 采样步长（小时）：CEMS 每 STEP 小时推一次读数 */
const STEP_HOURS = 4;

/** 某企业的日均排放基准（确定性：同企业每次运行结果一致，便于复现） */
function dailyBase(ent) {
  const base = INDUSTRY_BASE[ent.industry] || 800;
  const ratio = SCALE_RATIO[ent.scale] || 1.0;
  const h = parseInt(cu.sha256('dyn-baseline|' + ent.id).slice(0, 6), 16) % 200; // 0..199
  return Math.round((base + h) * ratio);
}

/**
 * 日均排放基准（与企业配额规模锚定）：
 * 以该企业当年配额作为"应排放量"参照，乘一个确定性偏置（-20% ~ +20%），
 * 使多数企业期末排放落在配额附近、少数企业超排触发预警 —— 贴近真实碳市场分布。
 */
function dailyBaseFor(ent, allocated) {
  const annual = allocated > 0
    ? allocated
    : (INDUSTRY_BASE[ent.industry] || 800) * 365 * (SCALE_RATIO[ent.scale] || 1);
  const h = (parseInt(cu.sha256('dyn-bias|' + ent.id).slice(0, 4), 16) % 401) - 200; // -200..200
  return Math.max(1, (annual / 365) * (1 + h / 1000));
}

/** 该企业排口配置（规模越大排口越多） */
function monitorsOf(ent) {
  const n = ent.scale === '大型' ? 3 : ent.scale === '小型' ? 1 : 2;
  const names = ['1 号排口', '2 号排口', '3 号排口'];
  return Array.from({ length: n }, (_, i) => ({
    monitor_no: `M-${String(ent.id).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`,
    energy_type: i === 0 ? '烟煤' : (i === 1 ? '天然气' : '电力'),
    name: names[i],
  }));
}

/**
 * 排口排放分担比：3 个排口按 5:3:2 分配，2 个排口按 5:3 归一化，1 个排口独占。
 *
 * ⚠ 归一化到 1 是硬要求。早先版本对 1/2 排口的企业直接沿用 5:3:2 的前几项
 * （合计只有 0.5 / 0.8），于是"排口读数之和"系统性小于企业实际排放量：
 *   1 排口企业偏小 50%，2 排口企业偏小 20%。
 * 这类口径缺陷在 `carbon_dynamic_account` 上**不会暴露** —— 那里的年度累计由
 * 年初基数 `base × passedDays` 主导，7 天窗口的欠计被完全掩盖。
 * 只有当审计方真去积分原始读数时才会显现，而那正是 WP4 唯一要做的事。
 */
function sharesOf(n) {
  const base = [0.5, 0.3, 0.2].slice(0, n);
  const sum = base.reduce((a, b) => a + b, 0);
  return base.map((x) => x / sum);
}

/** 当前核算年度 / 周期（与本年度配额账户口径一致，年度滚动） */
function currentPeriod(d = new Date()) {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return { year: d.getFullYear(), quarter: q, period: `${d.getFullYear()} 年度` };
}

/**
 * 生成 CEMS 实测读数（幂等：已存在的 (ent, monitor, time) 不重复插入）。
 * @param {object} opts { days 回溯天数, now 基准时间 }
 */
async function ingest(opts = {}) {
  const days = opts.days || 7;
  const now = opts.now ? new Date(opts.now) : new Date();
  const ents = await db.query("SELECT id, industry, scale FROM enterprise WHERE status <> 'SUSPENDED'");
  const batchNo = cu.bizNo('CEMS');
  const rows = [];

  const points = Math.floor((days * 24) / STEP_HOURS);
  const { year: quotaYear } = currentPeriod(now);
  for (const ent of ents) {
    const allocated = Number(await db.value(
      'SELECT total_allocated FROM carbon_quota WHERE ent_id = ? AND year = ?', [ent.id, quotaYear]
    ) || 0);
    const base = dailyBaseFor(ent, allocated);
    /* ⚠ 口径（与 cems_reading.flow_value 的列注释一致）：写入的是**瞬时排放速率 tCO2e/h**，
       不是"每个采样步长的排放量"。两个理由：
         ① 列注释写的就是 tCO2e/h，而 HJ 212 设备直报路径（hj212Server）走的是
            「流速 × 截面积 × 3600 × 浓度 × 1e-9」的物理折算，产出的是真速率。
            同列两种单位会让任何积分/对账都失去意义。
         ② 只有速率才能被任意间隔积分：平台存在 4h（自举）与 1min（设备直报）两种
            采样密度，写"每步排放量"就无法跨密度比较。
       企业级日均排放 = base ⇒ 每小时的速率基准 = base / 24。 */
    const perHour = base / 24;
    const mons = monitorsOf(ent);
    const monShares = sharesOf(mons.length);
    /* cum 的锚点：窗口起点时刻的「年度累计」。
       公式 = 基准速率 × 自年初小时数 + 该时点之前的**实测偏差修正**。
       ⚠ 不能简单写成 `base × passedDays` —— 那等于把全年的实测偏差统统抹掉，
       cum 会退化成"配额基线的复读机"，`recompute` 的"动态核算"也就名不副实。
       实测偏差修正由 observedCorrection() 给出（与设备直报路径共用同一实现）。 */
    const jan1 = new Date(now.getFullYear(), 0, 1).getTime();
    const windowStartMs = now.getTime() - points * STEP_HOURS * 3600 * 1000;
    const windowStart = new Date(windowStartMs);
    let cum = perHour * ((windowStartMs - jan1) / 3600000)
      + await observedCorrection(ent.id, windowStart);

    for (let p = 0; p <= points; p++) {
      const t = new Date(windowStartMs + p * STEP_HOURS * 3600 * 1000);
      /* 一个采样步长内所有排口共用一个企业级 cum。
         先算完整步长再落 cum，避免"同一步长内不同排口拿到不同累计值"——
         而 recompute 取的是最新一条读数的 cum，那种不一致会让年度累计随
         插入顺序抖动。 */
      let stepFlow = 0;
      const stepRows = [];
      for (let mi = 0; mi < mons.length; mi++) {
        const m = mons[mi];
        const share = monShares[mi];
        const jitter = 0.92 + ((parseInt(cu.sha256(`${m.monitor_no}|${t.toISOString()}`).slice(0, 4), 16) % 160) / 1000);
        const flow = Number((perHour * share * jitter).toFixed(3));   // tCO2e/h

        /* ── 数据质量扰动（确定性派生，不是随机噪声）──────────────────
           为什么自举数据也要有"脏数据"：
             真实 CEMS 不可能 100% 完美 —— 校准窗口、探头漂移、断线停机都会留痕。
             若自举数据清一色 NORMAL，则"数据质量治理"这一层在看板上只剩一种颜色，
             等于没做。质量标记必须被真实产生、并且**真正影响核算**（见 recompute），
             否则它只是装饰。
           实现：按 (企业, 排口, 时刻) 的 SHA-256 确定性派生质量标记，比例贴近行业实测：
             MISSING      1.2%  该时段无有效上报
             CALIBRATION  0.8%  校准/维护窗口
             OFFLINE      0.3%  停机/断线
             DRIFT        0.9%  测到了但读数存疑（flow 值明显偏离工况）
           同一份种子在任意机器、任意次运行都得到同一结果（可复现）。
           关键口径：**只有 NORMAL 推进年度累计 cum**。缺数/校准/停机/漂移一律不推进，
           于是 cum 的含义是"经质量门控后的可信年度累计"，而不是"所有报数的累加"。 */
        const roll = parseInt(
          cu.sha256(`cems-quality|${ent.id}|${m.monitor_no}|${t.toISOString()}`).slice(0, 6), 16
        ) % 1000;
        let quality = 'NORMAL';
        let flowValue = flow;
        let o2 = Number((3.5 + (flow % 2)).toFixed(2));
        let temp = Number((120 + (flow % 40)).toFixed(2));
        if (roll < 12) { quality = 'MISSING'; flowValue = 0; o2 = null; temp = null; }
        else if (roll < 20) { quality = 'CALIBRATION'; flowValue = 0; o2 = null; temp = null; }
        else if (roll < 23) { quality = 'OFFLINE'; flowValue = 0; o2 = null; temp = null; }
        else if (roll < 32) { quality = 'DRIFT'; flowValue = Number((flow * 1.35).toFixed(3)); }

        /* cum 的单位是 tCO2e（年度累计排放量），flowValue 的单位是 tCO2e/h，
           因此每个采样步长推进的是 flowValue × STEP_HOURS，而不是 flowValue 本身。 */
        if (quality === 'NORMAL') stepFlow += flowValue;

        stepRows.push([
          ent.id, m.monitor_no, m.energy_type, fmt(t), flowValue, 0,
          o2, temp,
          quality === 'NORMAL' ? 'NORMAL' : 'ABNORMAL', quality, batchNo,
        ]);
      }
      /* 末点（p === points）没有后继读数，其所代表的时段无从确定 → 不推进，
         与 WP4 积分口径的"末点不外推"一致。 */
      if (p < points) cum += stepFlow * STEP_HOURS;
      const cumNow = Number(cum.toFixed(3));
      for (const r of stepRows) { r[5] = cumNow; rows.push(r); }
    }
  }

  // 批量插入（每 500 行一条 INSERT，跨地域/大数据量下显著快于逐行）
  // 幂等：同一 (enterprise, monitor, reading_time) 已存在则跳过，避免重复采数造成累计值漂移。
  const COLS = 'ent_id, monitor_no, energy_type, reading_time, flow_value, cum_value, o2_content, temperature, source, status, quality_flag, batch_no';
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const ph = slice.map(() => "(?,?,?,?,?,?,?,?,'CEMS',?,?,?)").join(',');
    const res = await db.query(`INSERT IGNORE INTO cems_reading (${COLS}) VALUES ${ph}`, slice.flat());
    inserted += (res && res.affectedRows != null) ? res.affectedRows : slice.length;
  }
  return { batchNo, inserted, enterprises: ents.length, days, points: points + 1 };
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

/* ==================================================================
 * 实测偏差修正（WP4：统一两条写入路径的 cum 口径）
 * ================================================================== */

/** 名义采样周期上限（分钟）——超过它的空白不予外推，与 WP4 的积分口径一致 */
const NOMINAL_CAP_MIN = STEP_HOURS * 60;
/** 修正量的缓存粒度：5 分钟。修正量是"实测相对基准的偏离"，本身就缓慢变化，
 *  而 H 帧级调用（hj212Server 每收一帧算一次 cum）若不做缓存会把全年窗口
 *  反复聚合一遍。缓存键含 5 分钟时间桶，因此**历史锚点**（如重建窗口起点）
 *  与**当前时刻**各占一个桶，不会互相污染。 */
const CORR_TTL_MS = 300000;
const corrCache = new Map();

/** 清空修正量缓存（复位 / 配额外变更后调用） */
function resetCorrCache() { corrCache.clear(); }

/**
 * 观测窗口内的「实测偏差修正量」(tCO2e)。
 *
 *   correction = ∫实测速率 dt − 基准速率 × 被测量覆盖的时长
 *
 * 语义：实测排放相对**配额基准**的超出（正）或不足（负）部分。
 * 只统计真正被测量覆盖的时长，因此不会因为采样稀疏而被误判成"排放偏低"。
 *
 * 为什么需要它：平台的读数窗口只有 30 天（自举）或更短，1 月 1 日到窗口起点
 * 这一段没有任何实测数据。假装它是 0，年度累计会凭空少掉 11 个月；
 * 用"基准速率"填补、再把窗口内实测相对基准的偏差修正进去，是唯一既不失真、
 * 也不虚构数据的形式。于是：
 *
 *     cum(t) = 基准速率(base/24) × 自年初小时数 + correction
 *
 * 该形式与 `ingest()` 的 `cum = base × passedDays + Σ(flow × STEP_HOURS)` 在
 * 覆盖率 100% 时**恒等**，因此两条写入路径（平台自举 / HJ 212 设备直报）
 * 产出同一尺度、可混用的 cum。
 */
async function observedCorrection(entId, upto = new Date()) {
  const key = `${entId}:${Math.floor(upto.getTime() / CORR_TTL_MS)}`;
  const hit = corrCache.get(key);
  if (hit && Date.now() - hit.at < CORR_TTL_MS) return hit.value;

  const ctx = await db.one('SELECT id, industry, scale FROM enterprise WHERE id = ?', [entId]);
  if (!ctx) return 0;
  const year = upto.getFullYear();
  const allocated = Number(await db.value(
    'SELECT total_allocated FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]
  ) || 0);
  const baseRate = dailyBaseFor(ctx, allocated) / 24;   // tCO2e/h

  const rows = await db.query(
    `SELECT monitor_no, reading_time, flow_value FROM cems_reading
      WHERE ent_id = ? AND reading_time >= ? AND reading_time < ?
        AND quality_flag = 'NORMAL' AND status = 'NORMAL'
        AND flow_value > 0 AND source <> 'WATCHDOG'
      ORDER BY monitor_no, reading_time`,
    [entId, `${year}-01-01 00:00:00`, fmt(upto)]
  );

  /* 步进积分：Δt = min(相邻间隔, 名义上限)；末点不外推（与 WP4 同一口径） */
  let integrated = 0;
  let coveredHours = 0;
  let prevMon = null;
  let prevT = null;
  let prevRate = 0;
  for (const r of rows) {
    const t = new Date(r.reading_time).getTime();
    if (r.monitor_no === prevMon) {
      const dtMin = Math.min((t - prevT) / 60000, NOMINAL_CAP_MIN);
      if (dtMin > 0) { integrated += prevRate * (dtMin / 60); coveredHours += dtMin / 60; }
    }
    prevMon = r.monitor_no; prevT = t; prevRate = Number(r.flow_value);
  }

  const value = Number((integrated - baseRate * coveredHours).toFixed(3));
  if (corrCache.size > 600) corrCache.clear();   // 时间桶无界增长，做个上限兜底
  corrCache.set(key, { at: Date.now(), value, coveredHours: Number(coveredHours.toFixed(2)) });
  return value;
}

/**
 * 滚动核算：由 CEMS 实测读数持续计算某企业（或全部企业）的动态核算账户。
 * @param {number|null} entId 为空则核算全部企业
 * @returns {Promise<object[]>} 核算结果
 */
async function recompute(entId = null) {
  const { year, period } = currentPeriod();
  const daysPassed = Math.max(1, Math.floor((Date.now() - new Date(year, 0, 1).getTime()) / 86400000));
  const ents = entId
    ? await db.query('SELECT id, industry, scale FROM enterprise WHERE id = ?', [entId])
    : await db.query("SELECT id, industry, scale FROM enterprise WHERE status <> 'SUSPENDED'");

  const results = [];
  for (const ent of ents) {
    /* 1) 周期累计实测排放 = 该企业**最新一条有效读数**的年度累计值。
       ⭐ 质量门控（WP1）：只采信 quality_flag='NORMAL' 的读数。
       若把缺数/校准/停机/漂移期间的值一并采信，质量标记就只是装饰；
       这里让质量标记**真正决定哪些数据进入核算**，并用 excluded_points 如实披露被排除的量。
       退化路径：某企业一条有效读数都没有时，退回最新任意读数（否则该企业会凭空变成 0 排放），
       但此时 risk 计算中的 `allocated === 0 && cumulative > 0` 等分支仍按真实值走。 */
    const latestValid = await db.one(
      `SELECT cum_value, reading_time FROM cems_reading
       WHERE ent_id = ? AND quality_flag = 'NORMAL' ORDER BY reading_time DESC, id DESC LIMIT 1`, [ent.id]
    );
    const latest = latestValid || await db.one(
      `SELECT cum_value, reading_time FROM cems_reading
       WHERE ent_id = ? ORDER BY reading_time DESC, id DESC LIMIT 1`, [ent.id]
    );
    const cumulative = latest ? Number(latest.cum_value) : 0;

    // 本年度有效点数 / 被质量门控排除的点数（披露而非隐藏）
    const qstat = await db.one(
      `SELECT SUM(quality_flag = 'NORMAL') AS valid, SUM(quality_flag <> 'NORMAL') AS excluded
         FROM cems_reading WHERE ent_id = ? AND reading_time >= ?`,
      [ent.id, `${year}-01-01 00:00:00`]
    );
    const validPoints = Number((qstat && qstat.valid) || 0);
    const excludedPoints = Number((qstat && qstat.excluded) || 0);

    // 2) 配额账户（提前查询：既用于排放速率兜底，也用于缺口计算）
    const quota = await db.one('SELECT total_allocated, available FROM carbon_quota WHERE ent_id = ? AND year = ?', [ent.id, year]);
    const allocated = quota ? Number(quota.total_allocated) : 0;
    const available = quota ? Number(quota.available) : 0;

    // 3) 滚动日均排放速率（tCO2e/天）= 年度累计实测排放 / 自年初已过天数
    //    口径稳定、可复现：不依赖"最近一天恰好有几条读数"，读数越积越准。
    const latestAt = latest ? new Date(latest.reading_time) : new Date();
    const elapsedDays = Math.max(1, (latestAt.getTime() - new Date(year, 0, 1).getTime()) / 86400000);
    const rate = cumulative > 0
      ? Number((cumulative / elapsedDays).toFixed(4))
      : dailyBaseFor(ent, allocated);

    // 4) 已用碳信用抵销量（第二类碳资产 CCER 等）—— 抵销履约缺口
    const offsetTotal = Number(await db.value(
      'SELECT IFNULL(SUM(amount),0) FROM credit_offset WHERE ent_id = ? AND year = ?', [ent.id, year]
    ) || 0);

    // 5) 按当前速率外推期末排放 → 抵销后预计配额缺口（= 预测期末 − 已抵销 − 已分配配额）
    const predicted = Number((rate * 365).toFixed(3));
    const netPredicted = predicted - offsetTotal;
    const gap = Number((netPredicted - allocated).toFixed(3));
    let risk = 'LOW';
    if (allocated > 0 && netPredicted > allocated * 1.1) risk = 'HIGH';
    else if (allocated > 0 && netPredicted > allocated) risk = 'MEDIUM';
    else if (allocated === 0 && cumulative > 0) risk = 'MEDIUM';

    // 6) 落库（UPSERT）
    await db.query(
      `INSERT INTO carbon_dynamic_account
         (ent_id, year, period, cumulative_emission, quota_allocated, quota_available, gap,
          predicted_eoy, offset_applied, emission_rate, risk_level, data_points, excluded_points, last_reading_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         period=VALUES(period), cumulative_emission=VALUES(cumulative_emission),
         quota_allocated=VALUES(quota_allocated), quota_available=VALUES(quota_available),
         gap=VALUES(gap), predicted_eoy=VALUES(predicted_eoy), offset_applied=VALUES(offset_applied),
         emission_rate=VALUES(emission_rate),
         risk_level=VALUES(risk_level), data_points=VALUES(data_points),
         excluded_points=VALUES(excluded_points), last_reading_at=VALUES(last_reading_at)`,
      [ent.id, year, period, cumulative, allocated, available, gap, predicted, offsetTotal, rate, risk,
        validPoints, excludedPoints, latest ? fmt(new Date(latest.reading_time)) : null]
    );
    results.push({
      entId: ent.id, cumulative, allocated, gap, predicted, offset: offsetTotal, rate, risk,
      validPoints, excludedPoints, qualityGated: !latestValid,
    });
  }

  // 6) 触发动态预警
  await emitAlerts(entId);
  return results;
}

/** 根据动态核算结果产生/更新监管预警（同企业同类 OPEN 预警不重复产生） */
async function emitAlerts(entId = null) {
  const where = entId ? 'AND a.ent_id = ?' : '';
  const params = entId ? [entId] : [];
  const rows = await db.query(
    `SELECT a.*, e.ent_name FROM carbon_dynamic_account a
     JOIN enterprise e ON e.id = a.ent_id
     WHERE a.risk_level IN ('HIGH','MEDIUM') ${where}`, params
  );
  let created = 0;
  for (const r of rows) {
    const open = await db.one(
      "SELECT id FROM alert_record WHERE ent_id = ? AND alert_type = 'OVER_QUOTA' AND status <> 'CLOSED'",
      [r.ent_id]
    );
    if (open) continue;
    const level = r.risk_level === 'HIGH' ? 'HIGH' : 'MEDIUM';
    await db.query(
      `INSERT INTO alert_record (alert_no, ent_id, alert_type, level, title, content, metric, status)
       VALUES (?,?, 'OVER_QUOTA', ?, ?, ?, ?, 'OPEN')`,
      [cu.bizNo('AL'), r.ent_id, level,
        `${r.ent_name} 动态核算触发配额缺口预警`,
        `截至最近实测，本年度累计排放 ${Number(r.cumulative_emission).toFixed(2)} tCO₂e，已分配配额 ${Number(r.quota_allocated).toFixed(2)} tCO₂e；`
        + `按当前滚动速率（${Number(r.emission_rate).toFixed(2)} tCO₂e/天）外推，预计期末排放约 ${Number(r.predicted_eoy).toFixed(2)} tCO₂e，`
        + `预计期末缺口 ${Number(r.gap).toFixed(2)} tCO₂e（风险 ${level}）。`,
        `预计缺口 ${Number(r.gap).toFixed(2)} tCO2e`]
    );
    created++;
  }
  return created;
}

/** 动态核算总览（监管/企业看板用） */
async function overview(entId = null) {
  const { year, period } = currentPeriod();
  const where = entId ? 'WHERE a.ent_id = ?' : '';
  const params = entId ? [entId] : [];
  const [agg] = (await db.query(
    `SELECT COUNT(*) AS cnt,
            IFNULL(SUM(cumulative_emission),0) AS cum,
            IFNULL(SUM(quota_allocated),0) AS alloc,
            IFNULL(SUM(gap),0) AS gap,
            IFNULL(SUM(offset_applied),0) AS offset,
            SUM(risk_level='HIGH') AS high, SUM(risk_level='MEDIUM') AS medium, SUM(risk_level='LOW') AS low
     FROM carbon_dynamic_account a ${where}`, params
  )) || [{}];
  const rows = await db.query(
    `SELECT a.*, e.ent_name, e.industry, e.region, e.scale
     FROM carbon_dynamic_account a JOIN enterprise e ON e.id = a.ent_id
     ${where} ORDER BY FIELD(a.risk_level,'HIGH','MEDIUM','LOW'), a.gap DESC LIMIT 200`, params
  );
  const [reading] = (await db.query(
    `SELECT COUNT(*) AS cnt, IFNULL(AVG(flow_value),0) AS avg_flow, MAX(reading_time) AS last_at FROM cems_reading`
  )) || [{}];
  return {
    year, period,
    summary: {
      enterprises: Number(agg.cnt),
      cumulativeEmission: Number(agg.cum),
      quotaAllocated: Number(agg.alloc),
      totalGap: Number(agg.gap),
      totalOffset: Number(agg.offset),
      highRisk: Number(agg.high || 0),
      mediumRisk: Number(agg.medium || 0),
      lowRisk: Number(agg.low || 0),
    },
    readings: {
      total: Number(reading.cnt),
      avgFlow: Number(reading.avg_flow),
      lastAt: reading.last_at,
    },
    accounts: rows.map((r) => ({
      entId: r.ent_id, entName: r.ent_name, industry: r.industry, region: r.region, scale: r.scale,
      period: r.period,
      cumulativeEmission: Number(r.cumulative_emission),
      quotaAllocated: Number(r.quota_allocated),
      quotaAvailable: Number(r.quota_available),
      gap: Number(r.gap),
      predictedEoy: Number(r.predicted_eoy),
      offsetApplied: Number(r.offset_applied),
      emissionRate: Number(r.emission_rate),
      riskLevel: r.risk_level,
      validPoints: Number(r.data_points),
      excludedPoints: Number(r.excluded_points) || 0,
      qualityGated: Number(r.excluded_points) > 0,
      lastReadingAt: r.last_reading_at,
      updatedAt: r.updated_at,
    })),
  };
}

/** 某企业的实时读数序列（近 n 条） */
async function readings(entId, limit = 48) {
  const rows = await db.query(
    `SELECT monitor_no, energy_type, reading_time, flow_value, cum_value, o2_content, temperature,
            status, quality_flag, source, device_did, batch_no, chain_tx_id
     FROM cems_reading WHERE ent_id = ? ORDER BY reading_time DESC, id DESC LIMIT ?`,
    [entId, Math.min(Number(limit) || 48, 500)]
  );
  return rows.reverse();
}

/* ---------------- 定时采数调度（准实时滚动） ---------------- */
let timer = null;

/** 启动定时采数与核算；intervalMs 默认 60s（演示节奏，生产可按小时） */
function startScheduler(intervalMs = Number(process.env.CEMS_INTERVAL_MS || 60000)) {
  if (timer) return timer;
  const tick = async () => {
    try {
      await ingest({ days: 0 });     // 采集最近一个步长
      await recompute();             // 滚动重算全部企业
      // 采数批次上链存证（整批一次，体现"实测数据直接上链"）
      try {
        const anchorSvc = require('./anchor');
        const batch = cu.bizNo('CEMS');
        const n = await db.value('SELECT COUNT(*) FROM cems_reading');
        const res = await anchorSvc.anchor({
          txType: 'CEMS_READING', bizNo: batch,
          fromLabel: 'regulator:system',
          payload: { batchNo: batch, readingCount: Number(n), at: new Date().toISOString() },
        });
        await db.query('UPDATE cems_reading SET chain_tx_id = ? WHERE chain_tx_id IS NULL', [res.txId]);
      } catch (e) { /* 上链失败不阻断采数 */ }
    } catch (e) {
      console.error('[dynamic] 定时核算失败：', e.message);
    }
  };
  timer = setInterval(tick, Math.max(5000, intervalMs));
  if (timer.unref) timer.unref();
  return timer;
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 幂等自举：若尚无实测数据，生成一段历史读数并完成首轮核算 */
async function bootstrap() {
  const cnt = Number(await db.value('SELECT COUNT(*) FROM cems_reading')) || 0;
  if (cnt === 0) await ingest({ days: 30 });
  await recompute();
  return overview();
}

module.exports = {
  INDUSTRY_BASE, STEP_HOURS, NOMINAL_CAP_MIN, dailyBase, dailyBaseFor, monitorsOf, sharesOf, currentPeriod,
  ingest, recompute, emitAlerts, overview, readings,
  observedCorrection, resetCorrCache,
  startScheduler, stopScheduler, bootstrap,
};
