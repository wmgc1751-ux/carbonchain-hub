/**
 * routes/integrity.js —— 内控管理接口（P1）
 * ==================================================================
 * 四个能力：
 *   · 岗位字典与子账号管理（机构管理员为本机构开子账号、指定岗位）
 *   · 资质台账与冲突巡检（监管端可看，可一键扫描历史冲突）
 *   · 双人复核待办（待批准的核查结论 / 待确认的清缴）
 *   · 审计批次锚定（每 N 条日志算 Merkle 根上链）
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const db = require('../db');
const integrity = require('../services/integrity');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');

const router = express.Router();

/* ==================================================================
 * 岗位字典（公开给登录用户，前端下拉要用）
 * ================================================================== */
router.get('/posts', authRequired, wrap(async (req, res) => {
  const rows = await db.query('SELECT * FROM user_post_dict ORDER BY role_scope, post');
  ok(res, rows);
}));

/* ==================================================================
 * 本机构的账号列表（机构管理员视角）
 * ================================================================== */
router.get('/members', authRequired, wrap(async (req, res) => {
  if (!req.user.orgId) return fail(res, '当前账号未绑定机构，无成员列表', 400);
  /* 只有企业管理员/机构管理员能看全员；普通岗位只能看到自己 */
  const duty = req.user.post ? await integrity.postDuty(req.user.post) : null;
  const canAdmin = !req.user.post || (duty && duty.can_admin);
  /* 【2026-11-03】user_post_dict 在线上存在同一 post 的多行历史数据
   * （建表时 PRIMARY KEY 未生效的历史插入，ENT_ADMIN 有 can_entry=0/1 两条）。
   * 直接 LEFT JOIN 会把一个账号放大成两行，实测表现为「机构账号（2）」
   * 下同一账号 ent_zjbd 出现两次、且权限列一排「—」一排「✔」。
   * 这里按 post 取权限最全的一行（MAX 聚合），保证一个账号只出现一次；
   * 同时把参数字面量顺序改回与 SQL 中占位符一致的顺序。 */
  const rows = await db.query(
    `SELECT u.id, u.username, u.real_name, u.role, u.post, u.cert_no, u.status,
            u.parent_user_id, p.label AS post_label,
            p.can_entry, p.can_review, p.can_admin, u.created_at
       FROM sys_user u
       LEFT JOIN (
         SELECT post, MAX(label) AS label,
                MAX(can_entry) AS can_entry, MAX(can_review) AS can_review,
                MAX(can_admin) AS can_admin
           FROM user_post_dict GROUP BY post
       ) p ON p.post = u.post
      WHERE u.org_id = ? ${canAdmin ? '' : 'AND u.id = ?'}
      ORDER BY u.id`,
    canAdmin ? [req.user.orgId] : [req.user.orgId, req.user.id]
  );
  ok(res, {
    canAdmin,
    selfId: req.user.id,
    rows: rows.map((r) => ({ ...r, statusCn: r.status === 1 ? '启用' : r.status === 0 ? '待审核' : '停用' })),
  });
}));

/* ==================================================================
 * 新建子账号（机构管理员）
 * ================================================================== */
router.post('/members', authRequired, wrap(async (req, res) => {
  /* 单账号制（2026-10-31）：一个机构只有一个账号，填报/复核/清缴/授权/管理
   * 职能全部整合在该账号内 —— 不再允许创建子账号。换人直接改账号资料。 */
  return fail(res, '单账号模式：每个机构仅保留一个账号，职能已整合，不能新建子账号', 400);
  /* —— 原多账号逻辑保留在 git 历史与下方注释中，便于回滚 ——
  if (!req.user.orgId) return fail(res, '当前账号未绑定机构', 400);
  const duty = req.user.post ? await integrity.postDuty(req.user.post) : null;
  const canAdmin = !req.user.post || (duty && duty.can_admin);
  if (!canAdmin) return fail(res, '只有机构管理员可以新建子账号', 403);

  const { username, password, realName, post, certNo } = req.body || {};
  if (!/^[A-Za-z0-9_]{3,30}$/.test(String(username || ''))) return fail(res, '账号需为 3-30 位字母数字下划线', 400);
  if (String(password || '').length < 6) return fail(res, '密码至少 6 位', 400);
  if (!String(realName || '').trim()) return fail(res, '请填写姓名', 400);
  if (!post) return fail(res, '请指定岗位', 400);

  const pd = await integrity.postDuty(post);
  if (!pd) return fail(res, `岗位 ${post} 不存在`, 400);
  if (pd.role_scope !== req.user.role) {
    return fail(res, `岗位「${pd.label}」属于 ${pd.role_scope} 角色，不能授予 ${req.user.role} 账号`, 400);
  }
  /* 专业岗位（核查员）要求证书号，保证可追溯 */
  if (req.user.role === 'VERIFIER' && /_CLERK|_REVIEWER/.test(post) && !String(certNo || '').trim()) {
    return fail(res, '核查类岗位需填写执业证书编号', 400);
  }

  const dup = await db.one('SELECT id FROM sys_user WHERE username = ?', [username]);
  if (dup) return fail(res, '该账号已被占用', 409);

  const salt = cu.randomSalt(16);
  const hash = cu.hashPasswordPbkdf2(password, salt);
  const r = await db.query(
    `INSERT INTO sys_user (username, password, salt, real_name, role, org_id, org_name,
                           post, parent_user_id, cert_no, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
    [username, hash, salt, realName, req.user.role, req.user.orgId, req.user.orgName || req.user.org_name || null,
      post, req.user.id, certNo || null]
  );
  await writeLog(req, '用户管理', '新建子账号', username, `岗位 ${pd.label}（${post}）`, 'SUCCESS');
  ok(res, { id: r.insertId, username, post, postLabel: pd.label }, '子账号已创建');
}));

/* ==================================================================
 * 修改子账号岗位（职责分离的调整入口）
 * ================================================================== */
router.patch('/members/:id', authRequired, wrap(async (req, res) => {
  const duty = req.user.post ? await integrity.postDuty(req.user.post) : null;
  const canAdmin = !req.user.post || (duty && duty.can_admin);
  if (!canAdmin) return fail(res, '只有机构管理员可以调整岗位', 403);

  const id = Number(req.params.id);
  const u = await db.one('SELECT * FROM sys_user WHERE id = ? AND org_id = ?', [id, req.user.orgId]);
  if (!u) return fail(res, '账号不存在或不属于本机构', 404);

  const { post, status } = req.body || {};
  /* 自锁防护：管理员停用自己会把整个机构的管理通道锁死 —— 服务端直接拒绝。 */
  if (id === req.user.id && status !== undefined && !Number(status)) {
    return fail(res, '不能停用当前登录的账号（会锁死本机构管理入口）', 400);
  }
  if (post) {
    const pd = await integrity.postDuty(post);
    if (!pd) return fail(res, `岗位 ${post} 不存在`, 400);
    if (pd.role_scope !== u.role) return fail(res, '岗位与账号角色不匹配', 400);
    await db.query('UPDATE sys_user SET post = ? WHERE id = ?', [post, id]);
  }
  if (status !== undefined) {
    await db.query('UPDATE sys_user SET status = ? WHERE id = ?', [Number(status) ? 1 : 2, id]);
  }
  await writeLog(req, '用户管理', '调整子账号', u.username,
    `岗位 ${post || '(不变)'} / 状态 ${status === undefined ? '(不变)' : status}`, 'SUCCESS');
  ok(res, { id, post: post || u.post, status: status === undefined ? u.status : status }, '已更新');
}));

/* ==================================================================
 * 资质台账（监管端）
 * ================================================================== */
router.get('/qualifications', authRequired, requireRole('REGULATOR', 'ADMIN'), wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT q.*, u.real_name AS granted_by_name
       FROM org_qualification q LEFT JOIN sys_user u ON u.id = q.granted_by
      ORDER BY q.id DESC LIMIT 500`
  );
  ok(res, rows.map((r) => ({ ...r, qualCn: integrity.qualCn(r.qual_type) })));
}));

/* ==================================================================
 * 冲突巡检（监管端一键扫描）
 * ================================================================== */
router.get('/conflicts', authRequired, requireRole('REGULATOR', 'ADMIN'), wrap(async (req, res) => {
  const found = await integrity.auditConflicts();
  ok(res, {
    scannedAt: new Date().toISOString(),
    conflictCount: found.length,
    rows: found.map((f) => ({
      orgKey: f.org_key, orgName: f.org_name,
      qualA: integrity.qualCn(f.qual_a), qualB: integrity.qualCn(f.qual_b),
      reason: f.reason,
      action: '需吊销其中一项资质（核查独立性优先）',
    })),
  });
}));

/* ==================================================================
 * 双人复核待办（核查端 / 企业端）
 * ================================================================== */
router.get('/pending-approvals', authRequired, wrap(async (req, res) => {
  const out = { verifyReports: [], surrenders: [] };

  /* 待批准的核查结论：本机构提交、未批准的 */
  if (req.user.role === 'VERIFIER' && req.user.orgId) {
    out.verifyReports = await db.query(
      `SELECT vr.id, vr.report_no, vr.conclusion, vr.deviation_rate,
              vr.submitted_by, s.real_name AS submitted_by_name, vr.issue_time,
              er.period, e.ent_name
         FROM verify_report vr
         LEFT JOIN sys_user s ON s.id = vr.submitted_by
         LEFT JOIN emission_report er ON er.id = vr.emission_report_id
         LEFT JOIN enterprise e ON e.id = vr.ent_id
        WHERE vr.approved_by IS NULL AND vr.verifier_id = ?
        ORDER BY vr.id DESC LIMIT 50`, [req.user.orgId]
    );
  }
  ok(res, out);
}));

/* ==================================================================
 * 审计日志批次锚定（手动触发一次；也可由定时任务调用）
 * ================================================================== */
router.post('/audit-anchor', authRequired, requireRole('REGULATOR', 'ADMIN'), wrap(async (req, res) => {
  const batchSize = Math.min(Number((req.body || {}).batchSize) || 500, 2000);
  const r = await integrity.anchorAuditBatch(anchorSvc, cu.merkleRoot, cu.sha256, batchSize);
  if (!r) return ok(res, null, '没有新的审计日志需要锚定');
  await writeLog(req, '审计治理', '审计日志批次锚定', `AUDIT-${r.fromId}-${r.toId}`,
    `${r.rowCount} 条 → Merkle ${r.merkleRoot.slice(0, 16)}… 已上链`, 'SUCCESS');
  ok(res, r, `已锚定 ${r.rowCount} 条审计日志并上链`);
}));

/* 已锚定的批次列表 */
router.get('/audit-anchors', authRequired, requireRole('REGULATOR', 'ADMIN'), wrap(async (req, res) => {
  const rows = await db.query(
    'SELECT * FROM audit_anchor ORDER BY id DESC LIMIT 100'
  );
  ok(res, rows);
}));

module.exports = router;
