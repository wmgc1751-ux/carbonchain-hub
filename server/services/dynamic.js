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
    const perStep = base / (24 / STEP_HOURS); // 每个采样步长的排放量(tCO2e)
    const mons = monitorsOf(ent);
    // 本年度累计基数：年初到采数窗口起点的排放量（让 cum 表示"年度累计"）
    const jan1 = new Date(now.getFullYear(), 0, 1).getTime();
    const windowStart = now.getTime() - points * STEP_HOURS * 3600 * 1000;
    const passedDays = Math.max(0, (windowStart - jan1) / 86400000);
    let cum = base * passedDays;

    for (let p = 0; p <= points; p++) {
      const t = new Date(windowStart + p * STEP_HOURS * 3600 * 1000);
      for (const m of mons) {
        const share = m.monitor_no.endsWith('01') ? 0.5 : (m.monitor_no.endsWith('02') ? 0.3 : 0.2);
        const jitter = 0.92 + ((parseInt(cu.sha256(`${m.monitor_no}|${t.toISOString()}`).slice(0, 4), 16) % 160) / 1000);
        const flow = Number((perStep * share * jitter).toFixed(3));
        cum += flow;
        rows.push([
          ent.id, m.monitor_no, m.energy_type, fmt(t), flow, Number(cum.toFixed(3)),
          Number((3.5 + (flow % 2)).toFixed(2)), Number((120 + (flow % 40)).toFixed(2)), batchNo,
        ]);
      }
    }
  }

  // 批量插入（每 500 行一条 INSERT，跨地域/大数据量下显著快于逐行）
  // 幂等：同一 (enterprise, monitor, reading_time) 已存在则跳过，避免重复采数造成累计值漂移。
  const COLS = 'ent_id, monitor_no, energy_type, reading_time, flow_value, cum_value, o2_content, temperature, source, status, batch_no';
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const ph = slice.map(() => "(?,?,?,?,?,?,?,?,'CEMS','NORMAL',?)").join(',');
    const res = await db.query(`INSERT IGNORE INTO cems_reading (${COLS}) VALUES ${ph}`, slice.flat());
    inserted += (res && res.affectedRows != null) ? res.affectedRows : slice.length;
  }
  return { batchNo, inserted, enterprises: ents.length, days, points: points + 1 };
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
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
    // 1) 周期累计实测排放 = 该企业最新一条读数的年度累计值
    const latest = await db.one(
      `SELECT cum_value, reading_time FROM cems_reading
       WHERE ent_id = ? ORDER BY reading_time DESC, id DESC LIMIT 1`, [ent.id]
    );
    const cumulative = latest ? Number(latest.cum_value) : 0;

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
          predicted_eoy, offset_applied, emission_rate, risk_level, data_points, last_reading_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         period=VALUES(period), cumulative_emission=VALUES(cumulative_emission),
         quota_allocated=VALUES(quota_allocated), quota_available=VALUES(quota_available),
         gap=VALUES(gap), predicted_eoy=VALUES(predicted_eoy), offset_applied=VALUES(offset_applied),
         emission_rate=VALUES(emission_rate),
         risk_level=VALUES(risk_level), data_points=VALUES(data_points), last_reading_at=VALUES(last_reading_at)`,
      [ent.id, year, period, cumulative, allocated, available, gap, predicted, offsetTotal, rate, risk,
        latest ? 1 : 0, latest ? fmt(new Date(latest.reading_time)) : null]
    );
    results.push({ entId: ent.id, cumulative, allocated, gap, predicted, offset: offsetTotal, rate, risk });
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
      lastReadingAt: r.last_reading_at,
      updatedAt: r.updated_at,
    })),
  };
}

/** 某企业的实时读数序列（近 n 条） */
async function readings(entId, limit = 48) {
  const rows = await db.query(
    `SELECT monitor_no, energy_type, reading_time, flow_value, cum_value, o2_content, temperature, status, batch_no, chain_tx_id
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
  INDUSTRY_BASE, STEP_HOURS, dailyBase, dailyBaseFor, monitorsOf, currentPeriod,
  ingest, recompute, emitAlerts, overview, readings,
  startScheduler, stopScheduler, bootstrap,
};
