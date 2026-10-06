/**
 * routes/verifier.js —— 第三方核查机构端 API
 * 核查任务受理 / 数据核查 / 出具核查报告并上链存证
 */
'use strict';

const express = require('express');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, requireRole('VERIFIER'));

const vId = (req) => req.user.orgId;
const YEAR = new Date().getFullYear();

/* 概览 ------------------------------------------------------------- */
router.get('/overview', wrap(async (req, res) => {
  const id = vId(req);
  const org = await db.one('SELECT * FROM verifier_org WHERE id = ?', [id]);
  if (!org) return fail(res, '核查机构信息不存在', 404);

  const stat = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM verify_task WHERE verifier_id = ? GROUP BY status`, [id]
  );
  const sm = {};
  stat.forEach((s) => { sm[s.status] = Number(s.cnt); });

  const monthly = await db.query(
    `SELECT DATE_FORMAT(assign_time,'%Y-%m') AS month, COUNT(*) AS cnt
     FROM verify_task WHERE verifier_id = ? AND assign_time >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
     GROUP BY month ORDER BY month`, [id]
  );

  const conclusion = await db.query(
    `SELECT conclusion, COUNT(*) AS cnt FROM verify_report WHERE verifier_id = ? GROUP BY conclusion`, [id]
  );

  const deviation = await db.query(
    `SELECT report_no, deviation_rate, verified_value, issue_time FROM verify_report
     WHERE verifier_id = ? ORDER BY issue_time DESC LIMIT 12`, [id]
  );

  const chainCount = Number(await db.value(
    `SELECT COUNT(*) FROM chain_tx WHERE tx_type = 'VERIFY_REPORT' AND from_address = ?`,
    [org.wallet_address]
  ) || 0);

  const tasks = await db.query(
    `SELECT t.id, t.task_no, t.status, t.priority, t.deadline, t.assign_time,
            r.report_no, r.period, r.total_emission, e.ent_name, e.industry
     FROM verify_task t
     JOIN emission_report r ON r.id = t.report_id
     JOIN enterprise e ON e.id = t.ent_id
     WHERE t.verifier_id = ? AND t.status IN ('PENDING','PROCESSING')
     ORDER BY FIELD(t.priority,'HIGH','NORMAL','LOW'), t.assign_time LIMIT 8`, [id]
  );

  ok(res, {
    org: {
      name: org.org_name, code: org.org_code, level: org.level, region: org.region,
      rating: Number(org.rating), passRate: Number(org.pass_rate),
      staff: org.staff_count, doneTasks: org.done_tasks, status: org.status,
      wallet: org.wallet_address,
    },
    kpi: {
      pending: sm.PENDING || 0,
      processing: sm.PROCESSING || 0,
      done: sm.DONE || 0,
      rejected: sm.REJECTED || 0,
      total: Object.values(sm).reduce((a, b) => a + b, 0),
      chainCount,
      avgDeviation: Number(await db.value(
        'SELECT IFNULL(AVG(ABS(deviation_rate)),0) FROM verify_report WHERE verifier_id = ?', [id]
      ) || 0).toFixed(2),
    },
    monthly,
    conclusion: conclusion.map((c) => ({ name: c.conclusion, value: Number(c.cnt) })),
    deviation,
    todoTasks: tasks,
  });
}));

/* 核查任务列表 ------------------------------------------------------ */
router.get('/tasks', wrap(async (req, res) => {
  const { status, priority, keyword } = req.query;
  const where = ['t.verifier_id = ?'];
  const params = [vId(req)];
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (priority) { where.push('t.priority = ?'); params.push(priority); }
  if (keyword) { where.push('(t.task_no LIKE ? OR e.ent_name LIKE ? OR r.report_no LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }

  const page = await db.paginate(
    `SELECT t.*, r.report_no, r.period, r.total_emission, r.scope1_emission, r.scope2_emission,
            r.intensity, r.status AS report_status, e.ent_name, e.industry, e.region
     FROM verify_task t
     JOIN emission_report r ON r.id = t.report_id
     JOIN enterprise e ON e.id = t.ent_id
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(t.status,'PENDING','PROCESSING','DONE','REJECTED'), FIELD(t.priority,'HIGH','NORMAL','LOW'), t.assign_time DESC`,
    params, req.query
  );
  ok(res, page);
}));

/* 核查任务详情 ------------------------------------------------------ */
router.get('/tasks/:id', wrap(async (req, res) => {
  const t = await db.one(
    `SELECT t.*, r.report_no, r.period, r.year, r.quarter, r.total_emission, r.scope1_emission,
            r.scope2_emission, r.energy_consumption, r.output_value, r.intensity, r.yoy_rate,
            r.data_source, r.status AS report_status, r.attachment,
            e.ent_name, e.ent_code, e.industry, e.region, e.city, e.scale, e.credit_score,
            e.wallet_address
     FROM verify_task t
     JOIN emission_report r ON r.id = t.report_id
     JOIN enterprise e ON e.id = t.ent_id
     WHERE t.id = ? AND t.verifier_id = ?`,
    [req.params.id, vId(req)]
  );
  if (!t) return fail(res, '核查任务不存在或无权访问', 404);
  t.items = await db.query('SELECT * FROM emission_item WHERE report_id = ? ORDER BY scope, id', [t.report_id]);
  t.verifyReport = await db.one('SELECT * FROM verify_report WHERE task_id = ?', [t.id]);

  // 历史同期对比：帮助企业发现异常
  t.history = await db.query(
    `SELECT period, total_emission, intensity FROM emission_report
     WHERE ent_id = ? AND status <> 'DRAFT' ORDER BY year, quarter`, [t.ent_id]
  );
  // 同行均值
  t.peerAvg = await db.one(
    `SELECT IFNULL(AVG(total_emission),0) AS avg_emission, COUNT(*) AS cnt FROM emission_report r
     JOIN enterprise e ON e.id = r.ent_id
     WHERE e.industry = ? AND r.period = ? AND r.status <> 'DRAFT'`, [t.industry, t.period]
  );
  ok(res, t);
}));

/* 受理任务 ---------------------------------------------------------- */
router.post('/tasks/:id/accept', wrap(async (req, res) => {
  const t = await db.one('SELECT * FROM verify_task WHERE id = ? AND verifier_id = ?', [req.params.id, vId(req)]);
  if (!t) return fail(res, '任务不存在', 404);
  if (t.status !== 'PENDING') return fail(res, '该任务已被受理', 400);
  await db.query("UPDATE verify_task SET status='PROCESSING' WHERE id=?", [t.id]);
  await db.query("UPDATE emission_report SET status='VERIFYING' WHERE id=?", [t.report_id]);
  await writeLog(req, '核查作业', '受理核查任务', t.task_no, '任务进入核查中');
  ok(res, null, '任务已受理');
}));

/* 出具核查报告（核心：结论上链存证） --------------------------------- */
router.post('/tasks/:id/verify', wrap(async (req, res) => {
  const { conclusion, verifiedValue, opinion } = req.body || {};
  const t = await db.one(
    `SELECT t.*, r.report_no, r.period, r.total_emission, e.ent_name
     FROM verify_task t JOIN emission_report r ON r.id = t.report_id
     JOIN enterprise e ON e.id = t.ent_id
     WHERE t.id = ? AND t.verifier_id = ?`, [req.params.id, vId(req)]
  );
  if (!t) return fail(res, '核查任务不存在', 404);
  if (t.status === 'DONE' || t.status === 'REJECTED') return fail(res, '该任务已出具结论，无法重复出具', 400);
  if (!['PASS', 'FAIL', 'CONDITIONAL'].includes(conclusion)) return fail(res, '核查结论不合法', 400);

  const declared = Number(t.total_emission);
  const verified = Number(verifiedValue) > 0 ? Number(verifiedValue) : declared;
  const deviation = declared > 0 ? Number((((verified - declared) / declared) * 100).toFixed(2)) : 0;

  const vReportNo = cu.bizNo('VR');
  const auditor = req.user.realName || '核查员';
  const seal = cu.sha256(`${vReportNo}|${verified}|${auditor}|${conclusion}|${t.verifier_id}`);
  const finalConclusion = conclusion === 'FAIL' ? 'FAIL' : (Math.abs(deviation) > 3 ? 'CONDITIONAL' : conclusion);

  const [ins] = await db.pool.query(
    `INSERT INTO verify_report (report_no, task_id, emission_report_id, ent_id, verifier_id,
       declared_value, verified_value, deviation_rate, conclusion, opinion, auditor, seal_hash,
       issue_time, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
    [vReportNo, t.id, t.report_id, t.ent_id, vId(req), declared, verified, deviation,
      finalConclusion, opinion || '经核查，数据来源真实、核算边界清晰，结论予以认可。',
      auditor, seal]
  );
  const vrId = ins.insertId;

  // 上链存证
  const chain = await anchorSvc.anchor({
    txType: 'VERIFY_REPORT',
    bizNo: vReportNo,
    fromLabel: `verifier:${vId(req)}`,
    payload: {
      verifyReportNo: vReportNo, emissionReportNo: t.report_no, entId: t.ent_id,
      entName: t.ent_name, verifierId: vId(req), declared, verified,
      deviationRate: deviation, conclusion: finalConclusion, sealHash: seal, auditor,
    },
  });
  await db.query('UPDATE verify_report SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
    [chain.blockIndex, chain.txId, vrId]);
  await db.query(
    "UPDATE verify_task SET status = ?, finish_time = NOW(), reject_reason = ? WHERE id = ?",
    [finalConclusion === 'FAIL' ? 'REJECTED' : 'DONE', finalConclusion === 'FAIL' ? (opinion || '核查不通过') : null, t.id]
  );
  await db.query(
    'UPDATE emission_report SET status = ?, verify_time = NOW() WHERE id = ?',
    [finalConclusion === 'FAIL' ? 'REJECTED' : 'VERIFIED', t.report_id]
  );
  if (finalConclusion === 'FAIL') {
    await db.query(
      `INSERT INTO alert_record (alert_no, ent_id, alert_type, level, title, content, metric, status, created_at)
       VALUES (?,?, 'DATA_ABNORMAL', 'HIGH', ?, ?, '核查结论', 'OPEN', NOW())`,
      [cu.bizNo('AL'), t.ent_id, `${t.ent_name}${t.period}核查未通过`,
        `核查机构认定排放量 ${verified} tCO2e，与企业申报值 ${declared} tCO2e 偏差 ${deviation}%，已触发预警。`]
    );
  }
  await db.query('UPDATE verifier_org SET done_tasks = done_tasks + 1 WHERE id = ?', [vId(req)]);

  await writeLog(req, '核查作业', '出具核查报告', vReportNo,
    `企业申报 ${declared} / 核查认定 ${verified} / 偏差 ${deviation}% / 结论 ${finalConclusion}，已上链 #${chain.blockIndex}`);

  ok(res, {
    verifyReportId: vrId, verifyReportNo: vReportNo, declared, verified, deviation,
    conclusion: finalConclusion, seal, chain,
  }, `核查报告已出具并上链存证（区块 #${chain.blockIndex}）`);
}));

/* 已出具报告 -------------------------------------------------------- */
router.get('/reports', wrap(async (req, res) => {
  const { conclusion, keyword } = req.query;
  const where = ['v.verifier_id = ?'];
  const params = [vId(req)];
  if (conclusion) { where.push('v.conclusion = ?'); params.push(conclusion); }
  if (keyword) { where.push('(v.report_no LIKE ? OR e.ent_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const page = await db.paginate(
    `SELECT v.*, e.ent_name, e.industry, r.period, r.report_no AS emission_report_no
     FROM verify_report v
     JOIN enterprise e ON e.id = v.ent_id
     JOIN emission_report r ON r.id = v.emission_report_id
     WHERE ${where.join(' AND ')} ORDER BY v.issue_time DESC`, params, req.query
  );
  ok(res, page);
}));

/* 报告链上存证详情 -------------------------------------------------- */
router.get('/reports/:id/chain', wrap(async (req, res) => {
  const v = await db.one('SELECT * FROM verify_report WHERE id = ? AND verifier_id = ?',
    [req.params.id, vId(req)]);
  if (!v) return fail(res, '核查报告不存在', 404);
  if (!v.chain_tx_id) return fail(res, '该报告尚未上链存证', 400);

  const tx = await db.one('SELECT * FROM chain_tx WHERE tx_id = ?', [v.chain_tx_id]);
  const block = await db.one('SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index = ?',
    [v.chain_block_index]);
  const txList = await db.query('SELECT tx_id FROM chain_tx WHERE block_index = ? ORDER BY id', [v.chain_block_index]);
  const proof = cu.merkleProof(txList.map((t) => t.tx_id), txList.findIndex((t) => t.tx_id === v.chain_tx_id));
  const signatureValid = cu.verify(tx.pub_key, cu.stableStringify({
    txId: tx.tx_id, txType: tx.tx_type, bizNo: tx.biz_no, fromAddress: tx.from_address,
    toAddress: tx.to_address, payloadHash: tx.payload_hash, nonce: Number(tx.nonce),
  }), tx.signature);
  // 电子签章复核：报告关键字段重新摘要，与出具时的签章比对
  const sealNow = cu.sha256(`${v.report_no}|${Number(v.verified_value)}|${v.auditor}|${v.conclusion}|${v.verifier_id}`);

  ok(res, {
    report: { reportNo: v.report_no, conclusion: v.conclusion, verifiedValue: Number(v.verified_value) },
    tx: {
      txId: tx.tx_id, from: tx.from_address, to: tx.to_address, payloadHash: tx.payload_hash,
      signature: tx.signature, createdAt: tx.created_at,
    },
    block: block && {
      index: Number(block.block_index), hash: block.block_hash, prevHash: block.prev_hash,
      merkleRoot: block.merkle_root, nonce: Number(block.nonce), difficulty: Number(block.difficulty),
      txCount: Number(block.tx_count), blockTime: block.block_time,
    },
    merkle: { root: proof.root, path: proof.path, rootMatches: block && proof.root === block.merkle_root },
    verify: { signatureValid, sealMatches: sealNow === v.seal_hash, seal: v.seal_hash },
  });
}));

/* 机构链上身份 ------------------------------------------------------ */
router.get('/wallet', wrap(async (req, res) => {
  const org = await db.one('SELECT wallet_address, pub_key, org_name FROM verifier_org WHERE id = ?', [vId(req)]);
  const txs = await db.query(
    `SELECT tx_id, tx_type, biz_no, block_index, payload_hash, created_at FROM chain_tx
     WHERE from_address = ? ORDER BY id DESC LIMIT 20`, [org.wallet_address]
  );
  ok(res, { address: org.wallet_address, publicKey: org.pub_key, algorithm: 'secp256k1 / ECDSA-SHA256', recentTxs: txs });
}));

/* 通知公告 ---------------------------------------------------------- */
router.get('/notices', wrap(async (req, res) => {
  const page = await db.paginate(
    `SELECT id, title, content, notice_type, publisher, publish_time FROM notice
     WHERE target_role IN ('ALL','VERIFIER') ORDER BY is_top DESC, publish_time DESC`, [], req.query
  );
  ok(res, page);
}));

module.exports = router;
