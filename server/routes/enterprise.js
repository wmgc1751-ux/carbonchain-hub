/**
 * routes/enterprise.js —— 企业端 API
 * 碳排放数据上报 / 链上存证 / 配额账户 / 碳配额交易 / 数据分析
 */
'use strict';

const express = require('express');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');
const trade = require('../services/trade');
const keystore = require('../blockchain/keystore');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, requireRole('ENTERPRISE'));

const YEAR = new Date().getFullYear();
const entId = (req) => req.user.orgId;

/* ==================================================================
 * 概览
 * ================================================================== */
router.get('/overview', wrap(async (req, res) => {
  const id = entId(req);
  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [id]);
  if (!ent) return fail(res, '企业信息不存在', 404);

  const emissionYtd = Number(await db.value(
    'SELECT IFNULL(SUM(total_emission),0) FROM emission_report WHERE ent_id = ? AND year = ? AND status <> "DRAFT"',
    [id, YEAR]
  ) || 0);

  const quota = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [id, YEAR]) || {
    total_allocated: 0, available: 0, frozen: 0, used: 0, bought: 0, sold: 0,
  };

  const statusCount = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM emission_report WHERE ent_id = ? GROUP BY status`, [id]
  );
  const statusMap = {};
  statusCount.forEach((s) => { statusMap[s.status] = Number(s.cnt); });

  const chainAnchors = Number(await db.value(
    `SELECT COUNT(*) FROM chain_tx t JOIN emission_report r ON r.chain_tx_id = t.tx_id WHERE r.ent_id = ?`, [id]
  ) || 0);

  const dealTotal = await db.one(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(total_amount),0) AS amt FROM trade_deal WHERE buyer_ent_id = ? OR seller_ent_id = ?`,
    [id, id]
  );

  const trend = await db.query(
    `SELECT period, total_emission AS total, scope1_emission AS s1, scope2_emission AS s2,
            intensity, output_value AS output, status
     FROM emission_report WHERE ent_id = ? AND status <> 'DRAFT' ORDER BY year, quarter`, [id]
  );

  const rank = await db.query(
    `SELECT COUNT(*) AS better FROM (
        SELECT r.ent_id, SUM(r.total_emission) AS t
        FROM emission_report r JOIN enterprise e2 ON e2.id = r.ent_id
        WHERE r.year = ? AND r.status <> 'DRAFT' AND e2.industry = ?
        GROUP BY r.ent_id) x
     WHERE x.t < (SELECT IFNULL(SUM(total_emission),0) FROM emission_report WHERE ent_id = ? AND year = ? AND status <> 'DRAFT')`,
    [YEAR, ent.industry, id, YEAR]
  );
  const industryTotal = Number(await db.value(
    `SELECT COUNT(DISTINCT r.ent_id) FROM emission_report r JOIN enterprise e2 ON e2.id = r.ent_id
     WHERE r.year = ? AND e2.industry = ?`, [YEAR, ent.industry]
  ) || 1);

  const alerts = await db.query(
    `SELECT alert_no, alert_type, level, title, status, created_at FROM alert_record
     WHERE ent_id = ? ORDER BY created_at DESC LIMIT 5`, [id]
  );

  const notices = await db.query(
    `SELECT id, title, notice_type, publish_time FROM notice
     WHERE target_role IN ('ALL','ENTERPRISE') ORDER BY is_top DESC, publish_time DESC LIMIT 5`
  );

  ok(res, {
    enterprise: {
      id: ent.id, name: ent.ent_name, code: ent.ent_code, industry: ent.industry,
      region: ent.region, city: ent.city, scale: ent.scale, creditScore: ent.credit_score,
      status: ent.status, wallet: ent.wallet_address,
    },
    kpi: {
      emissionYtd: Number(emissionYtd.toFixed(2)),
      quotaAllocated: Number(quota.total_allocated),
      quotaAvailable: Number(quota.available),
      quotaUsed: Number(quota.used),
      quotaGap: Number((Number(quota.total_allocated) + Number(quota.bought) - Number(quota.sold) - Number(quota.used)).toFixed(2)),
      complianceRate: Number(quota.total_allocated) > 0
        ? Number(((Number(quota.total_allocated) / Math.max(Number(quota.used), 1)) * 100).toFixed(1)) : 0,
      reportTotal: Object.values(statusMap).reduce((a, b) => a + b, 0),
      reportVerified: statusMap.VERIFIED || 0,
      reportPending: (statusMap.SUBMITTED || 0) + (statusMap.VERIFYING || 0),
      reportRejected: statusMap.REJECTED || 0,
      chainAnchors,
      dealCount: Number(dealTotal.cnt || 0),
      dealAmount: Number(Number(dealTotal.amt || 0).toFixed(2)),
      industryRank: Number(rank[0].better) + 1,
      industryTotal,
    },
    trend,
    currentQuota: quota,
    alerts,
    notices,
  });
}));

/* ==================================================================
 * 碳排上报
 * ================================================================== */
router.get('/reports', wrap(async (req, res) => {
  const { status, period, keyword } = req.query;
  const where = ['ent_id = ?'];
  const params = [entId(req)];
  if (status) { where.push('status = ?'); params.push(status); }
  if (period) { where.push('period = ?'); params.push(period); }
  if (keyword) { where.push('report_no LIKE ?'); params.push(`%${keyword}%`); }

  const page = await db.paginate(
    `SELECT r.id, r.report_no, r.year, r.quarter, r.period, r.scope1_emission, r.scope2_emission,
            r.total_emission, r.energy_consumption, r.output_value, r.intensity, r.yoy_rate,
            r.data_source, r.status, r.submit_time, r.verify_time, r.chain_block_index,
            r.chain_tx_id, r.remark,
            v.org_name AS verifier_name
     FROM emission_report r LEFT JOIN verifier_org v ON v.id = r.verifier_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.year DESC, r.quarter DESC, r.id DESC`,
    params, req.query
  );
  ok(res, page);
}));

router.get('/reports/:id', wrap(async (req, res) => {
  const r = await db.one(
    `SELECT r.*, v.org_name AS verifier_name FROM emission_report r
     LEFT JOIN verifier_org v ON v.id = r.verifier_id
     WHERE r.id = ? AND r.ent_id = ?`, [req.params.id, entId(req)]
  );
  if (!r) return fail(res, '上报单不存在', 404);
  r.items = await db.query('SELECT * FROM emission_item WHERE report_id = ? ORDER BY scope, id', [r.id]);
  r.tasks = await db.query('SELECT * FROM verify_task WHERE report_id = ?', [r.id]);
  r.verifyReport = await db.one('SELECT * FROM verify_report WHERE emission_report_id = ?', [r.id]);
  ok(res, r);
}));

/**
 * 新建上报单
 * body: { year, quarter, dataSource, items:[{energyType, amount}], submit:bool }
 */
router.post('/reports', wrap(async (req, res) => {
  const id = entId(req);
  const { year, quarter, dataSource, items, submit } = req.body || {};
  if (!year || !quarter) return fail(res, '请选择核算年度与季度', 400);
  if (!Array.isArray(items) || items.length === 0) return fail(res, '请至少填写一项能源消耗数据', 400);

  const exists = await db.one('SELECT id FROM emission_report WHERE ent_id = ? AND year = ? AND quarter = ?',
    [id, year, quarter]);
  if (exists) return fail(res, `${year} 年第 ${quarter} 季度已存在上报单，请勿重复上报`, 400);

  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [id]);

  // 计算明细 → 汇总
  let s1 = 0, s2 = 0, energy = 0;
  const rows = [];
  for (const it of items) {
    const meta = require('../scripts/seed-pools').ENERGY_TYPES.find((x) => x.name === it.energyType);
    if (!meta) continue;
    const amount = Number(it.amount) || 0;
    const co2 = Number((amount * meta.factor).toFixed(3));
    if (meta.scope === 1) s1 += co2; else s2 += co2;
    const TCE = { 原煤: 0.7143, 焦炭: 0.9714, 天然气: 12.143, 柴油: 1.4571, 燃料油: 1.4286, 电力: 0.3025, 热力: 0.03412 };
    energy += amount * (TCE[meta.name] || 0.7);
    rows.push({ meta, amount, co2 });
  }
  if (!rows.length) return fail(res, '能源品种不合法', 400);

  const yearReports = await db.query(
    'SELECT IFNULL(SUM(output_value),0) AS o FROM emission_report WHERE ent_id = ? AND year = ?', [id, year]
  );
  const outputValue = Number((Number(yearReports[0].o) / 4 || Number(ent.annual_output) / 4).toFixed(2));
  const total = Number((s1 + s2).toFixed(2));
  const intensity = outputValue > 0 ? Number((total / outputValue).toFixed(4)) : 0;

  const reportNo = cu.bizNo('ER');
  const status = submit ? 'SUBMITTED' : 'DRAFT';
  const [ins] = await db.pool.query(
    `INSERT INTO emission_report
      (report_no, ent_id, year, quarter, period, scope1_emission, scope2_emission, total_emission,
       energy_consumption, output_value, intensity, yoy_rate, data_source, status, submit_time, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [reportNo, id, year, quarter, `${year}Q${quarter}`, Number(s1.toFixed(2)), Number(s2.toFixed(2)), total,
      Number(energy.toFixed(2)), outputValue, intensity, 0, dataSource || '排放因子法', status,
      submit ? new Date() : null]
  );
  const reportId = ins.insertId;

  for (const r of rows) {
    await db.query(
      `INSERT INTO emission_item (report_id, ent_id, energy_type, scope, amount, unit, factor, co2, calc_method)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [reportId, id, r.meta.name, r.meta.scope, r.amount, r.meta.unit, r.meta.factor, r.co2,
        r.meta.scope === 1 ? '排放因子法' : '购入量法']
    );
  }

  let chain = null;
  if (submit) {
    chain = await anchorSvc.anchor({
      txType: 'EMISSION_REPORT',
      bizNo: reportNo,
      fromLabel: `ent:${id}`,
      payload: {
        reportNo, entId: id, entName: ent.ent_name, period: `${year}Q${quarter}`,
        scope1: Number(s1.toFixed(2)), scope2: Number(s2.toFixed(2)), totalEmission: total,
        intensity, dataSource: dataSource || '排放因子法',
      },
    });
    await db.query('UPDATE emission_report SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
      [chain.blockIndex, chain.txId, reportId]);
    await assignVerifier(reportId, id, year, quarter);
  }

  await writeLog(req, '碳排上报', submit ? '提交上报' : '暂存草稿', reportNo,
    `报告期 ${year}Q${quarter}，排放总量 ${total} tCO2e`);

  ok(res, { reportId, reportNo, total, chain }, submit ? '上报成功，数据已上链存证' : '草稿已保存');
}));

/** 提交草稿 */
router.post('/reports/:id/submit', wrap(async (req, res) => {
  const r = await db.one('SELECT * FROM emission_report WHERE id = ? AND ent_id = ?', [req.params.id, entId(req)]);
  if (!r) return fail(res, '上报单不存在', 404);
  if (r.status !== 'DRAFT') return fail(res, '该上报单已提交，无法重复提交', 400);

  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [entId(req)]);
  const chain = await anchorSvc.anchor({
    txType: 'EMISSION_REPORT',
    bizNo: r.report_no,
    fromLabel: `ent:${entId(req)}`,
    payload: {
      reportNo: r.report_no, entId: entId(req), entName: ent.ent_name, period: r.period,
      scope1: Number(r.scope1_emission), scope2: Number(r.scope2_emission),
      totalEmission: Number(r.total_emission), intensity: Number(r.intensity), dataSource: r.data_source,
    },
  });
  await db.query(
    "UPDATE emission_report SET status='SUBMITTED', submit_time=NOW(), chain_block_index=?, chain_tx_id=? WHERE id=?",
    [chain.blockIndex, chain.txId, r.id]
  );
  const task = await assignVerifier(r.id, entId(req), r.year, r.quarter);
  await writeLog(req, '碳排上报', '提交上报', r.report_no, `排放总量 ${r.total_emission} tCO2e，已上链 #${chain.blockIndex}`);
  ok(res, { chain, task }, '提交成功，数据已上链存证');
}));

/** 为上报表随机指派一家第三方核查机构并生成核查任务 */
async function assignVerifier(reportId, id, year, quarter) {
  const v = await db.one(
    `SELECT * FROM verifier_org WHERE status='ACTIVE' ORDER BY RAND() LIMIT 1`
  );
  if (!v) return null;
  const taskNo = cu.bizNo('VT');
  const [ins] = await db.pool.query(
    `INSERT INTO verify_task (task_no, report_id, ent_id, verifier_id, verifier_user, task_type,
       priority, status, assign_time, deadline, created_at)
     VALUES (?,?,?,?,?,?,?,'PENDING',NOW(),DATE_ADD(NOW(), INTERVAL 30 DAY),NOW())`,
    [taskNo, reportId, id, v.id, 'ver' + String(v.id).padStart(3, '0'), 'ROUTINE',
      Number(quarter) <= 1 ? 'HIGH' : 'NORMAL']
  );
  await db.query('UPDATE emission_report SET verifier_id = ? WHERE id = ?', [v.id, reportId]);
  return { taskId: ins.insertId, taskNo, verifier: v.org_name };
}

/* ==================================================================
 * 链上存证详情（含签名验签 + Merkle 证明）
 * ================================================================== */
router.get('/reports/:id/chain', wrap(async (req, res) => {
  const r = await db.one('SELECT * FROM emission_report WHERE id = ? AND ent_id = ?',
    [req.params.id, entId(req)]);
  if (!r) return fail(res, '上报单不存在', 404);
  if (!r.chain_tx_id) return fail(res, '该上报单尚未上链存证', 400);

  const tx = await db.one('SELECT * FROM chain_tx WHERE tx_id = ?', [r.chain_tx_id]);
  const block = await db.one('SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index = ?',
    [r.chain_block_index]);
  const txList = await db.query('SELECT tx_id FROM chain_tx WHERE block_index = ? ORDER BY id', [r.chain_block_index]);
  const leaf = txList.findIndex((t) => t.tx_id === r.chain_tx_id);
  const proof = cu.merkleProof(txList.map((t) => t.tx_id), leaf);

  // 实时验签：用企业公钥验证这笔存证确实由本企业私钥签发
  const signatureValid = cu.verify(tx.pub_key, cu.stableStringify({
    txId: tx.tx_id, txType: tx.tx_type, bizNo: tx.biz_no, fromAddress: tx.from_address,
    toAddress: tx.to_address, payloadHash: tx.payload_hash, nonce: Number(tx.nonce),
  }), tx.signature);

  // 链下链上比对：库里的排放总量是否与存证快照一致
  const snapshot = typeof tx.payload_json === 'string' ? JSON.parse(tx.payload_json) : tx.payload_json;
  const bizHashNow = cu.hashObject(snapshot);
  const dataIntact = bizHashNow === tx.payload_hash;
  const dbMatchesSnapshot = Number(snapshot.totalEmission) === Number(r.total_emission);

  ok(res, {
    report: { id: r.id, reportNo: r.report_no, period: r.period, total: Number(r.total_emission), status: r.status },
    tx: {
      txId: tx.tx_id, txType: tx.tx_type, from: tx.from_address, to: tx.to_address,
      payloadHash: tx.payload_hash, nonce: Number(tx.nonce), fee: Number(tx.gas_fee),
      signature: tx.signature, createdAt: tx.created_at,
    },
    block: block && {
      index: Number(block.block_index), hash: block.block_hash, prevHash: block.prev_hash,
      merkleRoot: block.merkle_root, nonce: Number(block.nonce), difficulty: Number(block.difficulty),
      txCount: Number(block.tx_count), miner: block.miner, mineTime: Number(block.mine_time),
      sizeBytes: Number(block.size_bytes), blockTime: block.block_time,
    },
    merkle: { leafIndex: leaf, root: proof.root, rootMatches: proof.root === (block ? block.merkle_root : ''), path: proof.path },
    verify: { signatureValid, dataIntact, dbMatchesSnapshot, snapshot },
  });
}));

/* ==================================================================
 * 配额账户
 * ================================================================== */
router.get('/quota', wrap(async (req, res) => {
  const id = entId(req);
  const list = await db.query('SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC', [id]);
  const alloc = await db.query(
    `SELECT a.*, (SELECT COUNT(*) FROM quota_allocation x WHERE x.id <= a.id AND x.ent_id = a.ent_id) AS seq
     FROM quota_allocation a WHERE a.ent_id = ? ORDER BY a.year DESC, a.id DESC LIMIT 20`, [id]
  );
  const ent = await db.one('SELECT wallet_address FROM enterprise WHERE id = ?', [id]);
  ok(res, { list, allocations: alloc, wallet: ent ? ent.wallet_address : null });
}));

/* ==================================================================
 * 交易：挂单 / 撤单 / 订单簿 / 成交
 * ================================================================== */
router.get('/orders', wrap(async (req, res) => {
  const { status, side } = req.query;
  const where = ['ent_id = ?'];
  const params = [entId(req)];
  if (status) { where.push('status = ?'); params.push(status); }
  if (side) { where.push('side = ?'); params.push(side); }
  const page = await db.paginate(
    `SELECT * FROM trade_order WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, params, req.query
  );
  ok(res, page);
}));

/** 市场订单簿（全部企业的未成交委托，用于画买卖盘口） */
router.get('/orderbook', wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT o.id, o.order_no, o.side, o.price, (o.amount - o.filled_amount) AS remain, e.ent_name, o.created_at
     FROM trade_order o JOIN enterprise e ON e.id = o.ent_id
     WHERE o.status IN ('OPEN','PARTIAL') AND (o.amount - o.filled_amount) > 0
     ORDER BY o.price DESC LIMIT 40`
  );
  const bids = rows.filter((r) => r.side === 'BUY').sort((a, b) => b.price - a.price).slice(0, 8);
  const asks = rows.filter((r) => r.side === 'SELL').sort((a, b) => a.price - b.price).slice(0, 8);
  const last = await db.one('SELECT price, deal_time FROM trade_deal ORDER BY deal_time DESC LIMIT 1');
  ok(res, { bids, asks, lastPrice: last ? Number(last.price) : null, lastTime: last ? last.deal_time : null });
}));

router.post('/orders', wrap(async (req, res) => {
  const { side, price, amount, year } = req.body || {};
  const r = await trade.placeOrder({ entId: entId(req), side, price, amount, year: year || YEAR });
  await writeLog(req, '交易撮合', '创建挂单', r.orderNo,
    `${side} ${amount} 吨 @ ${price} 元/吨，成交 ${r.deals.length} 笔`);
  ok(res, r, r.deals.length ? `挂单成功并即时成交 ${r.deals.length} 笔` : '挂单成功，已进入撮合队列');
}));

router.post('/orders/:id/cancel', wrap(async (req, res) => {
  const r = await trade.cancelOrder(req.params.id, entId(req));
  await writeLog(req, '交易撮合', '撤销挂单', `#${req.params.id}`, `解冻 ${r.cancelled} 吨配额`);
  ok(res, r, '撤单成功，冻结配额已解冻');
}));

router.get('/deals', wrap(async (req, res) => {
  const id = entId(req);
  const where = ['(d.buyer_ent_id = ? OR d.seller_ent_id = ?)'];
  const params = [id, id];
  if (req.query.period) { where.push("DATE_FORMAT(d.deal_time,'%Y-%m') = ?"); params.push(req.query.period); }
  const page = await db.paginate(
    `SELECT d.*, b.ent_name AS buyer_name, s.ent_name AS seller_name,
            CASE WHEN d.buyer_ent_id = ${Number(id)} THEN 'BUY' ELSE 'SELL' END AS my_side
     FROM trade_deal d
     JOIN enterprise b ON b.id = d.buyer_ent_id
     JOIN enterprise s ON s.id = d.seller_ent_id
     WHERE ${where.join(' AND ')} ORDER BY d.deal_time DESC`, params, req.query
  );
  ok(res, page);
}));

/* ==================================================================
 * 数据分析
 * ================================================================== */
router.get('/analytics', wrap(async (req, res) => {
  const id = entId(req);
  const trend = await db.query(
    `SELECT period, total_emission AS total, scope1_emission AS s1, scope2_emission AS s2, intensity
     FROM emission_report WHERE ent_id = ? AND status <> 'DRAFT' ORDER BY year, quarter`, [id]
  );
  const mix = await db.query(
    `SELECT i.energy_type AS name, IFNULL(SUM(i.co2),0) AS value
     FROM emission_item i JOIN emission_report r ON r.id = i.report_id
     WHERE i.ent_id = ? AND r.year = ? GROUP BY i.energy_type ORDER BY value DESC`, [id, YEAR]
  );
  const quota = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [id, YEAR]);
  const monthly = await db.query(
    `SELECT DATE_FORMAT(deal_time,'%Y-%m') AS month, IFNULL(SUM(amount),0) AS amount,
            IFNULL(AVG(price),0) AS price
     FROM trade_deal WHERE buyer_ent_id = ? OR seller_ent_id = ? GROUP BY month ORDER BY month`, [id, id]
  );
  const peers = await db.query(
    `SELECT e.ent_name AS name, SUM(r.total_emission) AS value
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE e.industry = (SELECT industry FROM enterprise WHERE id = ?) AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY r.ent_id ORDER BY value DESC LIMIT 10`, [id, YEAR]
  );
  ok(res, {
    trend, mix,
    quota: quota || {},
    monthly: monthly.map((m) => ({ ...m, amount: Number(m.amount), price: Number(Number(m.price).toFixed(2)) })),
    peers: peers.map((p) => ({ ...p, value: Number(p.value), isMe: false })),
    myName: (await db.value('SELECT ent_name FROM enterprise WHERE id = ?', [id])),
  });
}));

/* ==================================================================
 * 通知公告
 * ================================================================== */
router.get('/notices', wrap(async (req, res) => {
  const page = await db.paginate(
    `SELECT id, title, content, notice_type, publisher, is_top, views, publish_time FROM notice
     WHERE target_role IN ('ALL','ENTERPRISE') ORDER BY is_top DESC, publish_time DESC`,
    [], req.query
  );
  ok(res, page);
}));

/* 我的链上身份 */
router.get('/wallet', wrap(async (req, res) => {
  const ent = await db.one('SELECT wallet_address, pub_key, ent_name FROM enterprise WHERE id = ?', [entId(req)]);
  const w = keystore.walletFor(`ent:${entId(req)}`);
  const txs = await db.query(
    `SELECT tx_id, tx_type, biz_no, block_index, from_address, payload_hash, created_at
     FROM chain_tx WHERE from_address = ? ORDER BY id DESC LIMIT 20`, [ent.wallet_address]
  );
  ok(res, {
    address: ent.wallet_address,
    publicKey: ent.pub_key,
    algorithm: 'secp256k1 / ECDSA-SHA256',
    privateKeyLocation: '节点本地密钥库（不落业务库）',
    recentTxs: txs,
  });
}));

module.exports = router;
