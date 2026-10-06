/**
 * routes/regulator.js —— 监管端 API
 * 驾驶舱 / 企业名录 / 配额分配 / 交易监管 / 预警处置 / 统计分析 / 操作审计
 */
'use strict';

const express = require('express');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, requireRole('REGULATOR'));

const YEAR = new Date().getFullYear();

/* ==================================================================
 * 监管驾驶舱
 * ================================================================== */
router.get('/overview', wrap(async (req, res) => {
  const entCount = Number(await db.value('SELECT COUNT(*) FROM enterprise') || 0);
  const activeEnt = Number(await db.value("SELECT COUNT(*) FROM enterprise WHERE status='ACTIVE'") || 0);

  const emission = await db.one(
    `SELECT IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(intensity),0) AS intensity,
            COUNT(*) AS reports, SUM(status='VERIFIED') AS verified
     FROM emission_report WHERE year = ? AND status <> 'DRAFT'`, [YEAR]
  );

  const quotaStat = await db.one(
    `SELECT IFNULL(SUM(total_allocated),0) AS allocated, IFNULL(SUM(used),0) AS used,
            IFNULL(SUM(available),0) AS available, IFNULL(SUM(bought),0) AS bought,
            IFNULL(SUM(sold),0) AS sold,
            SUM(available < 0) AS gapCount
     FROM carbon_quota WHERE year = ?`, [YEAR]
  );

  const tradeStat = await db.one(
    `SELECT COUNT(*) AS deals, IFNULL(SUM(amount),0) AS volume, IFNULL(SUM(total_amount),0) AS turnover,
            IFNULL(AVG(price),0) AS avgPrice, IFNULL(MAX(price),0) AS maxPrice, IFNULL(MIN(price),0) AS minPrice
     FROM trade_deal WHERE YEAR(deal_time) = ?`, [YEAR]
  );

  const openAlerts = await db.one(
    `SELECT COUNT(*) AS total, SUM(status='OPEN') AS open, SUM(level='HIGH') AS high FROM alert_record`
  );

  const trend = await db.query(
    `SELECT period, IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(intensity),0) AS intensity,
            COUNT(*) AS reports
     FROM emission_report WHERE status <> 'DRAFT' GROUP BY period ORDER BY period`
  );

  const priceTrend = await db.query(
    `SELECT DATE_FORMAT(deal_time,'%Y-%m') AS month, IFNULL(AVG(price),0) AS avgPrice,
            IFNULL(SUM(amount),0) AS volume, IFNULL(SUM(total_amount),0) AS turnover
     FROM trade_deal GROUP BY month ORDER BY month`
  );

  const byIndustry = await db.query(
    `SELECT e.industry AS name, IFNULL(SUM(r.total_emission),0) AS value, COUNT(DISTINCT e.id) AS ents
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.industry ORDER BY value DESC`, [YEAR]
  );

  const byRegion = await db.query(
    `SELECT e.region AS name, IFNULL(SUM(r.total_emission),0) AS value
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.region ORDER BY value DESC LIMIT 12`, [YEAR]
  );

  const topEnt = await db.query(
    `SELECT e.id, e.ent_name AS name, e.industry, IFNULL(SUM(r.total_emission),0) AS value,
            IFNULL(AVG(r.intensity),0) AS intensity
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.id ORDER BY value DESC LIMIT 10`, [YEAR]
  );

  const gapEnt = await db.query(
    `SELECT e.id, e.ent_name AS name, e.industry, q.total_allocated, q.used, q.available,
            (q.available) AS gap
     FROM carbon_quota q JOIN enterprise e ON e.id = q.ent_id
     WHERE q.year = ? ORDER BY q.available ASC LIMIT 10`, [YEAR]
  );

  const verifyProgress = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM emission_report WHERE year = ? GROUP BY status`, [YEAR]
  );
  const vp = {};
  verifyProgress.forEach((v) => { vp[v.status] = Number(v.cnt); });

  const recentAlerts = await db.query(
    `SELECT a.alert_no, a.alert_type, a.level, a.title, a.status, a.created_at, e.ent_name
     FROM alert_record a LEFT JOIN enterprise e ON e.id = a.ent_id
     ORDER BY a.created_at DESC LIMIT 8`
  );

  ok(res, {
    kpi: {
      entCount, activeEnt,
      emissionYtd: Number(Number(emission.total).toFixed(0)),
      avgIntensity: Number(Number(emission.intensity).toFixed(4)),
      reports: Number(emission.reports),
      verified: Number(emission.verified || 0),
      quotaAllocated: Number(Number(quotaStat.allocated).toFixed(0)),
      quotaUsed: Number(Number(quotaStat.used).toFixed(0)),
      quotaAvailable: Number(Number(quotaStat.available).toFixed(0)),
      gapCount: Number(quotaStat.gapCount || 0),
      dealCount: Number(tradeStat.deals),
      tradeVolume: Number(Number(tradeStat.volume).toFixed(0)),
      turnover: Number(Number(tradeStat.turnover).toFixed(0)),
      avgPrice: Number(Number(tradeStat.avgPrice).toFixed(2)),
      maxPrice: Number(tradeStat.maxPrice),
      minPrice: Number(tradeStat.minPrice),
      alertTotal: Number(openAlerts.total),
      alertOpen: Number(openAlerts.open || 0),
      alertHigh: Number(openAlerts.high || 0),
    },
    trend: trend.map((t) => ({ ...t, total: Number(t.total), intensity: Number(t.intensity) })),
    priceTrend: priceTrend.map((p) => ({
      month: p.month, avgPrice: Number(Number(p.avgPrice).toFixed(2)),
      volume: Number(p.volume), turnover: Number(Number(p.turnover).toFixed(0)),
    })),
    byIndustry: byIndustry.map((i) => ({ ...i, value: Number(i.value) })),
    byRegion: byRegion.map((i) => ({ ...i, value: Number(i.value) })),
    topEnt: topEnt.map((t) => ({ ...t, value: Number(t.value), intensity: Number(t.intensity) })),
    gapEnt: gapEnt.map((g) => ({
      ...g, total_allocated: Number(g.total_allocated), used: Number(g.used), available: Number(g.available),
    })),
    verifyProgress: vp,
    recentAlerts,
  });
}));

/* ==================================================================
 * 企业名录
 * ================================================================== */
router.get('/enterprises', wrap(async (req, res) => {
  const { keyword, industry, region, status, scale } = req.query;
  const where = ['1=1'];
  const params = [];
  if (keyword) { where.push('(e.ent_name LIKE ? OR e.ent_code LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  if (industry) { where.push('e.industry = ?'); params.push(industry); }
  if (region) { where.push('e.region = ?'); params.push(region); }
  if (status) { where.push('e.status = ?'); params.push(status); }
  if (scale) { where.push('e.scale = ?'); params.push(scale); }

  const page = await db.paginate(
    `SELECT e.*, q.total_allocated, q.available, q.used, q.bought, q.sold,
            (SELECT IFNULL(SUM(total_emission),0) FROM emission_report r WHERE r.ent_id = e.id AND r.year = ${YEAR} AND r.status <> 'DRAFT') AS emission_ytd,
            (SELECT COUNT(*) FROM emission_report r WHERE r.ent_id = e.id AND r.status = 'VERIFIED') AS verified_reports,
            (SELECT COUNT(*) FROM chain_tx t WHERE t.from_address = e.wallet_address) AS chain_txs
     FROM enterprise e
     LEFT JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ${YEAR}
     WHERE ${where.join(' AND ')} ORDER BY emission_ytd DESC, e.id`,
    params, req.query
  );
  ok(res, page);
}));

router.get('/enterprises/filters', wrap(async (req, res) => {
  const industries = await db.query('SELECT DISTINCT industry AS v FROM enterprise ORDER BY industry');
  const regions = await db.query('SELECT DISTINCT region AS v FROM enterprise ORDER BY region');
  ok(res, { industries: industries.map((i) => i.v), regions: regions.map((r) => r.v) });
}));

router.get('/enterprises/:id', wrap(async (req, res) => {
  const e = await db.one('SELECT * FROM enterprise WHERE id = ?', [req.params.id]);
  if (!e) return fail(res, '企业不存在', 404);
  e.reports = await db.query(
    `SELECT r.id, r.report_no, r.period, r.total_emission, r.intensity, r.status, r.chain_block_index,
            v.org_name AS verifier_name
     FROM emission_report r LEFT JOIN verifier_org v ON v.id = r.verifier_id
     WHERE r.ent_id = ? ORDER BY r.year DESC, r.quarter DESC LIMIT 12`, [req.params.id]
  );
  e.quotas = await db.query('SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC', [req.params.id]);
  e.deals = await db.query(
    `SELECT d.deal_no, d.price, d.amount, d.total_amount, d.deal_time, d.chain_block_index,
            b.ent_name AS buyer_name, s.ent_name AS seller_name
     FROM trade_deal d JOIN enterprise b ON b.id = d.buyer_ent_id JOIN enterprise s ON s.id = d.seller_ent_id
     WHERE d.buyer_ent_id = ? OR d.seller_ent_id = ? ORDER BY d.deal_time DESC LIMIT 10`,
    [req.params.id, req.params.id]
  );
  e.alerts = await db.query('SELECT * FROM alert_record WHERE ent_id = ? ORDER BY created_at DESC LIMIT 8', [req.params.id]);
  e.chainTxs = await db.query(
    `SELECT tx_id, tx_type, biz_no, block_index, payload_hash, status, created_at
     FROM chain_tx WHERE from_address = ? ORDER BY id DESC LIMIT 12`, [e.wallet_address]
  );
  e.mix = await db.query(
    `SELECT i.energy_type AS name, IFNULL(SUM(i.co2),0) AS value FROM emission_item i
     WHERE i.ent_id = ? GROUP BY i.energy_type ORDER BY value DESC`, [req.params.id]
  );
  ok(res, e);
}));

/* ==================================================================
 * 配额分配
 * ================================================================== */
router.get('/allocations', wrap(async (req, res) => {
  const { year, keyword, type } = req.query;
  const where = ['1=1'];
  const params = [];
  if (year) { where.push('a.year = ?'); params.push(year); }
  if (type) { where.push('a.alloc_type = ?'); params.push(type); }
  if (keyword) { where.push('(a.alloc_no LIKE ? OR e.ent_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const page = await db.paginate(
    `SELECT a.*, e.ent_name, e.industry, e.region FROM quota_allocation a
     JOIN enterprise e ON e.id = a.ent_id
     WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC`, params, req.query
  );
  const sum = await db.one(
    `SELECT IFNULL(SUM(quota_amount),0) AS total, COUNT(*) AS cnt FROM quota_allocation WHERE year = ?`,
    [year || YEAR]
  );
  ok(res, { ...page, summary: { total: Number(sum.total), count: Number(sum.cnt) } });
}));

/** 下发配额（含上链存证） */
router.post('/allocations', wrap(async (req, res) => {
  const { entId, year, amount, allocType, allocMethod, baseline } = req.body || {};
  if (!entId || !year || !(Number(amount) > 0)) return fail(res, '企业、年度、分配量均为必填', 400);

  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [entId]);
  if (!ent) return fail(res, '企业不存在', 404);

  const allocNo = cu.bizNo('QA');
  const type = allocType || 'FREE';
  const [ins] = await db.pool.query(
    `INSERT INTO quota_allocation (alloc_no, ent_id, year, quota_amount, alloc_type, alloc_method,
       baseline_intensity, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,NOW())`,
    [allocNo, entId, year, Number(amount), type, allocMethod || '历史强度法',
      baseline ? Number(baseline) : null, req.user.realName || 'regulator']
  );

  // 同步配额账户
  await db.query(
    `INSERT INTO carbon_quota (ent_id, year, total_allocated, available) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE total_allocated = total_allocated + VALUES(total_allocated),
                             available = available + VALUES(available)`,
    [entId, year, Number(amount), Number(amount)]
  );

  const chain = await anchorSvc.anchor({
    txType: 'QUOTA_ALLOC',
    bizNo: allocNo,
    fromLabel: 'regulator:system',
    toLabel: `ent:${entId}`,
    payload: {
      allocNo, entId, entName: ent.ent_name, year: Number(year), quotaAmount: Number(amount),
      allocType: type, allocMethod: allocMethod || '历史强度法', baseline: baseline ? Number(baseline) : null,
      operator: req.user.realName,
    },
  });
  await db.query('UPDATE quota_allocation SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
    [chain.blockIndex, chain.txId, ins.insertId]);

  await writeLog(req, '配额管理', '分配配额', allocNo,
    `向 ${ent.ent_name} 分配 ${amount} 吨（${type}），已上链 #${chain.blockIndex}`);
  ok(res, { allocId: ins.insertId, allocNo, chain }, `配额分配成功，已上链存证（区块 #${chain.blockIndex}）`);
}));

/* ==================================================================
 * 交易监管
 * ================================================================== */
router.get('/trades', wrap(async (req, res) => {
  const { minPrice, maxPrice, keyword } = req.query;
  const where = ['1=1'];
  const params = [];
  if (minPrice) { where.push('d.price >= ?'); params.push(Number(minPrice)); }
  if (maxPrice) { where.push('d.price <= ?'); params.push(Number(maxPrice)); }
  if (keyword) { where.push('(d.deal_no LIKE ? OR b.ent_name LIKE ? OR s.ent_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }

  const page = await db.paginate(
    `SELECT d.*, b.ent_name AS buyer_name, s.ent_name AS seller_name
     FROM trade_deal d JOIN enterprise b ON b.id = d.buyer_ent_id JOIN enterprise s ON s.id = d.seller_ent_id
     WHERE ${where.join(' AND ')} ORDER BY d.deal_time DESC`, params, req.query
  );

  const priceStat = await db.one(
    `SELECT IFNULL(AVG(price),0) AS avgPrice, IFNULL(STDDEV(price),0) AS stdPrice,
            IFNULL(MIN(price),0) AS minPrice, IFNULL(MAX(price),0) AS maxPrice, COUNT(*) AS cnt
     FROM trade_deal`
  );
  // 价格异常检测：偏离均值 2 倍标准差的成交
  const anomalies = await db.query(
    `SELECT d.deal_no, d.price, d.amount, d.deal_time, b.ent_name AS buyer_name, s.ent_name AS seller_name
     FROM trade_deal d JOIN enterprise b ON b.id = d.buyer_ent_id JOIN enterprise s ON s.id = d.seller_ent_id
     WHERE ABS(d.price - (SELECT AVG(price) FROM trade_deal)) > 2 * (SELECT STDDEV(price) FROM trade_deal)
     ORDER BY d.deal_time DESC LIMIT 10`
  );
  const hourly = await db.query(
    `SELECT DATE_FORMAT(deal_time,'%Y-%m-%d %H:00') AS t, IFNULL(AVG(price),0) AS price, IFNULL(SUM(amount),0) AS volume
     FROM trade_deal GROUP BY t ORDER BY t LIMIT 200`
  );
  ok(res, {
    ...page,
    priceStat: {
      avgPrice: Number(Number(priceStat.avgPrice).toFixed(2)),
      stdPrice: Number(Number(priceStat.stdPrice).toFixed(2)),
      minPrice: Number(priceStat.minPrice), maxPrice: Number(priceStat.maxPrice),
      count: Number(priceStat.cnt),
    },
    anomalies,
    candles: hourly.map((h) => ({ t: h.t, price: Number(Number(h.price).toFixed(2)), volume: Number(h.volume) })),
  });
}));

/* ==================================================================
 * 预警处置
 * ================================================================== */
router.get('/alerts', wrap(async (req, res) => {
  const { type, level, status, keyword } = req.query;
  const where = ['1=1'];
  const params = [];
  if (type) { where.push('a.alert_type = ?'); params.push(type); }
  if (level) { where.push('a.level = ?'); params.push(level); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (keyword) { where.push('(a.title LIKE ? OR e.ent_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const page = await db.paginate(
    `SELECT a.*, e.ent_name, e.industry, e.region FROM alert_record a
     LEFT JOIN enterprise e ON e.id = a.ent_id
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(a.status,'OPEN','HANDLING','CLOSED'), FIELD(a.level,'HIGH','MEDIUM','LOW'), a.created_at DESC`,
    params, req.query
  );
  const stat = await db.query('SELECT alert_type AS type, level, status, COUNT(*) AS cnt FROM alert_record GROUP BY alert_type, level, status');
  ok(res, { ...page, stat });
}));

router.post('/alerts/:id/handle', wrap(async (req, res) => {
  const { status, note } = req.body || {};
  if (!['HANDLING', 'CLOSED'].includes(status)) return fail(res, '处理状态不合法', 400);
  const a = await db.one('SELECT * FROM alert_record WHERE id = ?', [req.params.id]);
  if (!a) return fail(res, '预警记录不存在', 404);
  await db.query(
    'UPDATE alert_record SET status = ?, handler = ?, handle_note = ?, closed_at = ? WHERE id = ?',
    [status, req.user.realName || 'regulator', note || null, status === 'CLOSED' ? new Date() : null, a.id]
  );
  await writeLog(req, '预警处置', status === 'CLOSED' ? '关闭预警' : '受理预警', a.alert_no, note || '');
  ok(res, null, status === 'CLOSED' ? '预警已关闭' : '预警已受理');
}));

/* ==================================================================
 * 统计分析
 * ================================================================== */
router.get('/statistics', wrap(async (req, res) => {
  const year = Number(req.query.year) || YEAR;

  const industries = await db.query(
    `SELECT e.industry AS name, COUNT(DISTINCT e.id) AS ents, IFNULL(SUM(r.total_emission),0) AS emission,
            IFNULL(AVG(r.intensity),0) AS intensity
     FROM enterprise e LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY e.industry ORDER BY emission DESC`, [year]
  );

  const regions = await db.query(
    `SELECT e.region AS name, COUNT(DISTINCT e.id) AS ents, IFNULL(SUM(r.total_emission),0) AS emission,
            IFNULL(AVG(r.intensity),0) AS intensity
     FROM enterprise e LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY e.region ORDER BY emission DESC`, [year]
  );

  const scaleStat = await db.query(
    `SELECT e.scale AS name, COUNT(*) AS ents, IFNULL(SUM(r.total_emission),0) AS emission
     FROM enterprise e LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY e.scale`, [year]
  );

  const energyMix = await db.query(
    `SELECT i.energy_type AS name, IFNULL(SUM(i.co2),0) AS value, IFNULL(SUM(i.amount),0) AS amount
     FROM emission_item i JOIN emission_report r ON r.id = i.report_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY i.energy_type ORDER BY value DESC`, [year]
  );

  const reduction = await db.query(
    `SELECT period, IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(yoy_rate),0) AS yoy
     FROM emission_report WHERE status <> 'DRAFT' GROUP BY period ORDER BY period`
  );

  const rank = await db.query(
    `SELECT e.ent_name AS name, e.industry, e.region,
            IFNULL(SUM(r.total_emission),0) AS emission, IFNULL(AVG(r.intensity),0) AS intensity,
            IFNULL(q.available,0) AS quota_available, IFNULL(q.total_allocated,0) AS quota_allocated
     FROM enterprise e
     LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     LEFT JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ?
     GROUP BY e.id ORDER BY emission DESC LIMIT 20`, [year, year]
  );

  const compliance = await db.one(
    `SELECT SUM(used <= total_allocated + bought - sold) AS meet,
            SUM(used > total_allocated + bought - sold) AS gap
     FROM carbon_quota WHERE year = ?`, [year]
  );

  ok(res, {
    industries: industries.map((i) => ({ ...i, emission: Number(i.emission), intensity: Number(i.intensity) })),
    regions: regions.map((i) => ({ ...i, emission: Number(i.emission), intensity: Number(i.intensity) })),
    scaleStat: scaleStat.map((i) => ({ ...i, emission: Number(i.emission) })),
    energyMix: energyMix.map((i) => ({ ...i, value: Number(i.value), amount: Number(i.amount) })),
    reduction: reduction.map((i) => ({ period: i.period, total: Number(i.total), yoy: Number(i.yoy) })),
    rank: rank.map((i) => ({ ...i, emission: Number(i.emission), intensity: Number(i.intensity) })),
    compliance: { meet: Number(compliance.meet || 0), gap: Number(compliance.gap || 0) },
  });
}));

/* ==================================================================
 * 操作审计 + 系统概况
 * ================================================================== */
router.get('/logs', wrap(async (req, res) => {
  const { module: mod, role, keyword } = req.query;
  const where = ['1=1'];
  const params = [];
  if (mod) { where.push('module = ?'); params.push(mod); }
  if (role) { where.push('role = ?'); params.push(role); }
  if (keyword) { where.push('(username LIKE ? OR action LIKE ? OR target LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  const page = await db.paginate(
    `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`, params, req.query
  );
  ok(res, page);
}));

router.get('/system', wrap(async (req, res) => {
  const tables = ['enterprise', 'verifier_org', 'sys_user', 'emission_report', 'emission_item',
    'verify_task', 'verify_report', 'carbon_quota', 'quota_allocation', 'trade_order', 'trade_deal',
    'chain_block', 'chain_tx', 'alert_record', 'audit_log', 'notice'];
  const counts = [];
  for (const t of tables) {
    counts.push({ table: t, rows: Number(await db.value(`SELECT COUNT(*) FROM ${t}`) || 0) });
  }
  const byRole = await db.query('SELECT role, COUNT(*) AS cnt FROM sys_user GROUP BY role');
  const chain = await anchorSvc.getChain();
  const chainStats = await chain.stats();
  const validation = await chain.validateChain();
  ok(res, {
    tableCounts: counts,
    totalRows: counts.reduce((a, b) => a + b.rows, 0),
    byRole,
    chain: chainStats,
    validation: { valid: validation.valid, checked: validation.checkedBlocks, errors: validation.errors.slice(0, 20), errorCount: validation.errors.length },
    runtime: {
      node: process.version,
      platform: process.platform,
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
      db: `${require('../config').db.host}:${require('../config').db.port}/${require('../config').db.database}`,
    },
  });
}));

/* 通知公告发布 */
router.post('/notices', wrap(async (req, res) => {
  const { title, content, noticeType, targetRole, isTop } = req.body || {};
  if (!title) return fail(res, '标题不能为空', 400);
  const [ins] = await db.pool.query(
    `INSERT INTO notice (title, content, notice_type, target_role, publisher, is_top, publish_time)
     VALUES (?,?,?,?,?,?,NOW())`,
    [title, content || '', noticeType || 'POLICY', targetRole || 'ALL', req.user.realName || '监管端', isTop ? 1 : 0]
  );
  await writeLog(req, '通知公告', '发布公告', title, `${noticeType} / ${targetRole}`);
  ok(res, { id: ins.insertId }, '公告已发布');
}));

router.get('/notices', wrap(async (req, res) => {
  const page = await db.paginate(
    `SELECT * FROM notice ORDER BY is_top DESC, publish_time DESC`, [], req.query
  );
  ok(res, page);
}));

module.exports = router;
