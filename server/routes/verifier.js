/**
 * routes/verifier.js —— 第三方核查机构端 API
 * 核查任务受理 / 数据核查 / 出具核查报告并上链存证
 */
'use strict';

const express = require('express');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const keystore = require('../blockchain/keystore');
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

  /* 【口径修正 2026-10-30】"有效核查结论"的判据用**已上链存证**，不是 approved_by。
   *
   * 两条写入路径决定了这个选择：
   *   ① 两阶段流程（POST /tasks/:id/verify 不带 approveReportId → 复核批准 → 上链）
   *      结束时 approved_by 会被写入；
   *   ② 早期单阶段路径（本服务与 worker/routes/biz2.mjs 的历史实现、
   *      以及批量演示脚本）直接出具并上链，approved_by 保持为 NULL。
   * 两条路径的产物都是"已生效、已存证、任务已 DONE"的报告，
   * 若按 approved_by 判断，会把这批真实报告全部排除在结论分布与平均偏差率之外
   * ——实测 org1 的 12 份报告会整块消失，饼图直接空白。
   *
   * chain_tx_id 是唯一贯穿两条路径、且事后不可伪造成立的字段
   * （它对应账本里一条已签名的交易）。真正未生效的草稿（如 VRD 前缀）
   * 恰恰是 chain_tx_id 为空的那一条。 */
  const EFFECTIVE = 'v.verifier_id = ? AND v.chain_tx_id IS NOT NULL AND v.chain_tx_id <> \'\'';

  /* 月度工作量补齐成**连续 12 个月**（含 0 的月份）。
   * 原实现只返回有数据的月份，横轴变成 3 个类目并排的柱子，
   * 视觉上像是"连续三个月都在出量"，而实际上中间有整月空档。
   * 补齐后柱间距即真实时间间隔，空档一眼可见。 */
  const monthlyRaw = await db.query(
    `SELECT DATE_FORMAT(assign_time,'%Y-%m') AS month, COUNT(*) AS cnt
     FROM verify_task WHERE verifier_id = ? AND assign_time >= DATE_SUB(NOW(), INTERVAL 11 MONTH)
     GROUP BY month ORDER BY month`, [id]
  );
  const monthMap = {};
  monthlyRaw.forEach((m) => { monthMap[m.month] = Number(m.cnt); });
  const monthly = [];
  const nowD = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(nowD.getFullYear(), nowD.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthly.push({ month: key, cnt: monthMap[key] || 0 });
  }

  const conclusion = await db.query(
    `SELECT v.conclusion, COUNT(*) AS cnt FROM verify_report v WHERE ${EFFECTIVE} GROUP BY v.conclusion`, [id]
  );

  /* 待复核结论：经办已提交、尚无复核签章。
   * 注意它必须是"未上链"的草稿 —— 早期单阶段路径写出的报告 approved_by 虽为空，
   * 但已经存证生效，把它们列进"待复核"会让人去批准一份已生效的报告。 */
  const pendingReview = await db.query(
    `SELECT v.id, v.report_no, v.declared_value, v.verified_value, v.deviation_rate,
            v.conclusion AS draft_conclusion, v.issue_time, v.submitted_by,
            e.ent_name, r.period
     FROM verify_report v
     JOIN enterprise e ON e.id = v.ent_id
     JOIN emission_report r ON r.id = v.emission_report_id
     WHERE v.verifier_id = ? AND v.approved_by IS NULL
       AND (v.chain_tx_id IS NULL OR v.chain_tx_id = '')
     ORDER BY v.issue_time DESC LIMIT 8`, [id]
  );

  /* 最近签发的有效报告（替换原先的 deviation 名单）。
   * 原 `deviation` 取 issue_time 倒序前 12 条且不筛状态，
   * 结果整块表格 12 行全是 +0.00%、且与「核查报告台账」首屏完全重复、缺结论列。
   * 改为只取已存证报告并带上结论。 */
  const deviation = await db.query(
    `SELECT v.report_no, v.deviation_rate, v.verified_value, v.conclusion, v.issue_time
     FROM verify_report v WHERE ${EFFECTIVE} ORDER BY v.issue_time DESC LIMIT 8`, [id]
  );

  /* 链上存证：按本机构钱包计，且**只算本机构已生效报告对应的交易号**。
   * 原来直接 count 该钱包的全部 VERIFY_REPORT 交易，历史改派留下的
   * 重复锚定会被重复计数，与「累计完成」永远对不上。
   * 报告号必须在业务库先取出来再传参：账本库账号对业务库表无 SELECT 权限，
   * 写成子查询会直接 1142 报错（不是数据为空，是查询被拒）。 */
  /* 链上存证：**按报告份数**计（distinct biz_no），不是按交易笔数计。
   *
   * 原实现直接 count 该钱包的全部 VERIFY_REPORT 交易，有两个问题：
   *   ① 历史改派后同一份报告可能被两个机构各锚定一次，走进来就被重复计数；
   *   ② 补锚/重锚（tools/reanchor-biz.mjs）会给同一 report_no 再写一条交易。
   * 实测 org45：126 份报告对应 131 笔交易（5 份各有 2 笔）。
   * 存证数应当等于"有多少份报告可被独立核验"，即distinct biz_no；
   * 这样它才与「累计完成」同口径，读者不用再猜两个数字为什么不等。
   * 报告号必须在业务库先取出来再传参：账本库账号对业务库表无 SELECT 权限，
   * 写成子查询会直接 1142 报错（不是数据为空，是查询被拒）。 */
  const sealNos = (await db.query(
    `SELECT v.report_no FROM verify_report v WHERE ${EFFECTIVE}`, [id]
  )).map((r) => r.report_no);
  const chainCount = sealNos.length ? Number(await db.ledgerValue(
    `SELECT COUNT(DISTINCT biz_no) FROM chain_tx
     WHERE tx_type = 'VERIFY_REPORT' AND from_address = ?
       AND biz_no IN (${sealNos.map(() => '?').join(',')})`,
    [org.wallet_address, ...sealNos]
  ) || 0) : 0;

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
      staff: org.staff_count,
      /* 【2026-11-03】done_tasks 是 init-db 随机种子值（18~420），
       * 又在每次上链时 +1 累加，实测 org45 冗余字段写着 321，
       * 而该机构真实的 DONE 任务只有 123 —— 与同屏「累计完成 123」直接打架。
       * 一律用实时计数，不再读这个会漂移的冗余列。 */
      doneTasks: sm.DONE || 0, status: org.status,
      wallet: org.wallet_address,
    },
    kpi: {
      pending: sm.PENDING || 0,
      processing: sm.PROCESSING || 0,
      done: sm.DONE || 0,
      rejected: sm.REJECTED || 0,
      total: Object.values(sm).reduce((a, b) => a + b, 0),
      chainCount,
      pendingReview: pendingReview.length,
      /* 平均偏差率同口径，只取已存证结论：真正未生效的草稿认定值等于申报值，
       * 混进来会把真实偏差拉向 0，指标失去意义。 */
      avgDeviation: Number(await db.value(
        `SELECT IFNULL(AVG(ABS(v.deviation_rate)),0) FROM verify_report v WHERE ${EFFECTIVE}`, [id]
      ) || 0).toFixed(2),
    },
    monthly,
    conclusion: conclusion.map((c) => ({ name: c.conclusion, value: Number(c.cnt) })),
    deviation,
    pendingReview,
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
  const { conclusion, verifiedValue, opinion, approveReportId } = req.body || {};
  const t = await db.one(
    `SELECT t.*, r.report_no, r.period, r.total_emission, e.ent_name
     FROM verify_task t JOIN emission_report r ON r.id = t.report_id
     JOIN enterprise e ON e.id = t.ent_id
     WHERE t.id = ? AND t.verifier_id = ?`, [req.params.id, vId(req)]
  );
  if (!t) return fail(res, '核查任务不存在', 404);
  if (t.status === 'DONE' || t.status === 'REJECTED') return fail(res, '该任务已出具结论，无法重复出具', 400);
  if (!['PASS', 'FAIL', 'CONDITIONAL'].includes(conclusion)) return fail(res, '核查结论不合法', 400);

  /* ==================================================================
   * P1 双人复核：核查结论必须「经办提交 → 另一人批准」两阶段
   * ------------------------------------------------------------------
   * 为什么核查结论尤其需要：结论直接决定企业排放量是否成立。
   * 一人可定成败既不合《碳排放权交易管理暂行条例》对核查独立性的要求，
   * 事后也无法区分"谁判断的、谁复核的"。
   *
   * 调用约定：
   *   ① 经办：body 不带 approveReportId → 生成待复核的结论记录并返回 verifyReportId
   *   ② 复核：body 带 approveReportId → 同一接口批准、生效、上链
   * 单账号机构在第二阶段会因"批准人=提交人"被拒——这是设计意图，
   * 提示该机构增加一名复核岗账号（职责分离）。
   * ================================================================== */
  const integrity = require('../services/integrity');

  if (!approveReportId) {
    try { await integrity.checkPost(req.user, 'ENTRY', '提交核查结论'); }
    catch (e) { if (e instanceof integrity.IntegrityError) return fail(res, e.message, e.status); throw e; }

    const dDeclared = Number(t.total_emission);
    const dVerified = Number(verifiedValue) > 0 ? Number(verifiedValue) : dDeclared;
    const dDev = dDeclared > 0 ? Number((((dVerified - dDeclared) / dDeclared) * 100).toFixed(2)) : 0;
    const draftNo = cu.bizNo('VRD');
    const [ins0] = await db.pool.query(
      `INSERT INTO verify_report (report_no, task_id, emission_report_id, ent_id, verifier_id,
         declared_value, verified_value, deviation_rate, conclusion, opinion, auditor, seal_hash,
         submitted_by, issue_time, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [draftNo, t.id, t.report_id, t.ent_id, vId(req), dDeclared, dVerified, dDev,
        conclusion, opinion || '', req.user.realName || '核查员',
        cu.sha256(`${draftNo}|${dVerified}|${conclusion}`), req.user.id]
    );
    await db.query("UPDATE verify_task SET status = 'VERIFYING' WHERE id = ?", [t.id]);
    await writeLog(req, '核查作业', '提交核查结论（待复核）', draftNo,
      `结论 ${conclusion}，偏差 ${dDev}%，等待复核人批准`, 'SUCCESS');
    return ok(res, {
      stage: 'SUBMITTED', verifyReportId: ins0.insertId, verifyReportNo: draftNo,
      conclusion, deviation: dDev,
      next: '需由具备「核查审核」岗位的另一名同事调用本接口并携带 approveReportId 批准',
    }, '核查结论已提交，等待复核人批准后才会生效并上链');
  }

  /* ---- 阶段②：复核并生效 ---- */
  const vr = await db.one('SELECT * FROM verify_report WHERE id = ? AND task_id = ?',
    [Number(approveReportId), t.id]);
  if (!vr) return fail(res, '待批准的核查结论不存在（请使用第一阶段返回的 verifyReportId）', 404);
  if (vr.approved_by) return fail(res, '该结论已被批准，无法重复批准', 400);
  try {
    await integrity.checkPost(req.user, 'REVIEW', '批准核查结论');
    integrity.assertDualControl(req.user.id, vr.submitted_by, '批准核查结论');
  } catch (e) {
    if (e instanceof integrity.IntegrityError) return fail(res, e.message, e.status);
    throw e;
  }

  const declared = Number(vr.declared_value);
  const verified = Number(vr.verified_value);
  const deviation = Number(vr.deviation_rate);
  const vReportNo = vr.report_no;
  /* 【2026-11-03】「主核查员」必须保留**经办人**，不能被批准人覆盖。
   * 原实现 `const auditor = req.user.realName` 在第二阶段执行，
   * 于是复核岗一批准，报告的主核查员就从"某某核查复核员"变成了批准人，
   * 台账里同一份报告前后两次看到的经办人对不上（实测：VRD202611011040485961
   * 批准后主核查员变成"核查录入员"，而同批历史报告仍是复核员姓名）。
   * 经办人姓名在阶段①已写入 vr.auditor，这里沿用；只有缺失时才回退当前用户。 */
  const auditor = vr.auditor || (req.user.realName || '核查员');
  const approver = req.user.realName || '复核人';
  const finalConclusion = conclusion === 'FAIL' ? 'FAIL' : (Math.abs(deviation) > 3 ? 'CONDITIONAL' : conclusion);
  /* 签章覆盖值与批准人：批准动作本身要进签章，否则"谁批准的"无签名背书 */
  const seal = cu.sha256(`${vReportNo}|${verified}|${auditor}|${approver}|${finalConclusion}|${t.verifier_id}`);

  await db.query(
    `UPDATE verify_report SET conclusion=?, opinion=?, auditor=?, seal_hash=?,
            approved_by=?, approved_at=NOW() WHERE id=?`,
    [finalConclusion, opinion || vr.opinion || '经核查，数据来源真实、核算边界清晰，结论予以认可。',
      auditor, seal, req.user.id, vr.id]
  );
  const vrId = vr.id;

  // 上链存证（含双人复核签字位）
  const chain = await anchorSvc.anchor({
    txType: 'VERIFY_REPORT',
    bizNo: vReportNo,
    fromLabel: `verifier:${vId(req)}`,
    payload: {
      verifyReportNo: vReportNo, emissionReportNo: t.report_no, entId: t.ent_id,
      entName: t.ent_name, verifierId: vId(req), declared, verified,
      deviationRate: deviation, conclusion: finalConclusion, sealHash: seal, auditor,
      /* auditor = 经办人（主核查员）；approver 单独记名，两者都不许混成一个人 */
      approver,
      submittedBy: vr.submitted_by, approvedBy: req.user.id,
      dualControl: '经办与批准为不同账号（系统强制）',
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
  /* 【2026-11-03】不再维护 verifier_org.done_tasks 这个冗余列。
   * 它以随机种子值起步、又被每次上链 +1 累加，值只会离真实数越来越远
   * （实测 org45：列值 321 vs 真实 DONE 123）。统计一律实时 COUNT，
   * 冗余列保留但不再写入，避免两处口径继续漂移。 */

  await writeLog(req, '核查作业', '复核批准核查报告', vReportNo,
    `经办 ${auditor} / 批准 ${approver} / 偏差 ${deviation}% / 结论 ${finalConclusion}，已上链 #${chain.blockIndex}`);

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

  const tx = await db.ledgerOne('SELECT * FROM chain_tx WHERE tx_id = ?', [v.chain_tx_id]);
  /* 同 enterprise.js#/reports/:id/chain：业务库与账本库曾分离部署，
   * 历史核查结论的交易号可能属于另一条链。查不到必须给明确答复，
   * 直接解引用 tx.pub_key 会把"存证缺失"变成 500 服务器错误。 */
  if (!tx) {
    return fail(res, '该核查结论的存证不在当前节点账本上（其交易号来自另一部署批次的链），无法就地核验', 404);
  }
  const block = await db.ledgerOne('SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index = ?',
    [v.chain_block_index]);
  const txList = await db.ledgerQuery('SELECT tx_id FROM chain_tx WHERE block_index = ? ORDER BY id', [v.chain_block_index]);
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
    /* leafIndex / leafHash 必须返回：
     * 单笔交易区块的 Merkle 证明路径为空数组（root 就等于叶哈希），
     * 前端需要靠这两项把"单叶场景"与"路径真缺失"区分开。
     * 之前只返回 root/path，前端拿不到 leafIndex，于是一个正常的
     * 单叶区块被显示成"证明路径数据缺失，请检查链上数据结构"——
     * 数据完全正确，提示却在说数据结构有问题。 */
    merkle: {
      root: proof.root,
      path: proof.path,
      leafIndex: txList.findIndex((t) => t.tx_id === v.chain_tx_id),
      leafHash: v.chain_tx_id,
      rootMatches: block && proof.root === block.merkle_root,
    },
    verify: { signatureValid, sealMatches: sealNow === v.seal_hash, seal: v.seal_hash },
  });
}));

/* 机构链上身份 ------------------------------------------------------ */
router.get('/wallet', wrap(async (req, res) => {
  const org = await db.one('SELECT wallet_address, pub_key, org_name FROM verifier_org WHERE id = ?', [vId(req)]);
  /* 自愈：历史上注册的机构没有钱包地址（注册流程曾漏写）。
   * 用 walletFor 的确定性密钥补齐，与 anchor() 实际签名用的是同一把，
   * 不会造成身份分裂。补写失败不影响本次读取。 */
  const orgId = vId(req);
  let address = org && org.wallet_address;
  let publicKey = org && org.pub_key;
  if (org && (!address || !publicKey)) {
    const w = keystore.walletFor(`ver:${orgId}`);
    address = address || w.address;
    publicKey = publicKey || w.publicKey;
    try {
      await db.query('UPDATE verifier_org SET wallet_address = ?, pub_key = ? WHERE id = ?',
        [address, publicKey, orgId]);
    } catch (e) { /* 读路径不因写失败而 500 */ }
  }
  const txs = await db.ledgerQuery(
    `SELECT tx_id, tx_type, biz_no, block_index, payload_hash, created_at FROM chain_tx
     WHERE from_address = ? ORDER BY id DESC LIMIT 20`, [address || '']
  );
  ok(res, { address, publicKey, algorithm: 'secp256k1 / ECDSA-SHA256', recentTxs: txs });
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
