/**
 * routes/admin.js —— 平台管理端 API（A1~A5）
 *   · A2 因子库维护：排放因子 CRUD + 版本发布
 *   · A4 对账中心：链上链下对账
 *   · 基础设施：IPFS 文件存证 / 预言机多源校验
 *   · A1/A3/A5：联盟治理（复用 consortium）、用户权限、系统监控（复用 regulator/system）
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const factor = require('../services/factor');
const infra = require('../services/infra');
const db = require('../db');

const router = express.Router();
router.use(authRequired, requireRole('ADMIN'));

/* ---------------- A1 管理总览（管理端自有口径） ----------------
 * 原先管理总览直接借 /api/regulator/system，那是监管端「系统自检」接口：
 * 它会把业务库 55 张表逐张 COUNT(*) 一遍（本机 2.5 s，其中 real_emission_year
 * 34 万行单表就 1.8 s），再跑一遍全链校验。管理总览其实只要 5 个数：
 * 链高度、上链存证、全链校验结论、因子条目、运行环境。
 * 「为 5 个 KPI 等 3 秒半，还借了别的角色的接口」——按页面真实所需裁剪。 */
router.get('/overview', wrap(async (req, res) => {
  const chain = await require('../services/anchor').getChain();
  const [chainStats, validation, factors, versions, byRole] = await Promise.all([
    chain.stats(),
    chain.validateChainCached({ ttlMs: 10000 }),
    factor.listFactors({}),
    factor.listVersions(),
    db.query('SELECT role, COUNT(*) AS cnt FROM sys_user GROUP BY role'),
  ]);
  const cfg = require('../config');
  ok(res, {
    chain: chainStats,
    validation: {
      valid: validation.valid,
      checked: validation.checkedBlocks,
      errors: validation.errors.slice(0, 20),
      errorCount: validation.errors.length,
      warnings: (validation.warnings || []).slice(0, 20),
      warningCount: validation.warningCount || 0,
      cached: !!validation.cached,
      cacheAgeMs: validation.cacheAgeMs || 0,
    },
    factorCount: factors.length,
    versionCount: versions.length,
    factors: factors.slice(0, 12),
    versions,
    byRole: byRole.map((r) => ({ role: r.role, count: Number(r.cnt) })),
    userTotal: byRole.reduce((a, b) => a + Number(b.cnt), 0),
    runtime: {
      node: process.version,
      platform: process.platform,
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
      db: `${cfg.db.host}:${cfg.db.port}/${cfg.db.database}`,
    },
  });
}));

/* ---------------- A2 因子库维护 ---------------- */

router.get('/factors', wrap(async (req, res) => {
  ok(res, await factor.listFactors(req.query));
}));

router.post('/factors', wrap(async (req, res) => {
  let r;
  try { r = await factor.upsertFactor(req.body || {}); }
  catch (e) { return fail(res, e.message, 400); }
  await writeLog(req, '因子库', '维护因子', String(r.energy_type || r.id), '更新排放因子');
  ok(res, r, '因子已保存');
}));

router.post('/factors/publish', wrap(async (req, res) => {
  let r;
  try { r = await factor.publishVersion({ ...(req.body || {}), operator: req.user.realName }); }
  catch (e) { return fail(res, e.message, 400); }
  await writeLog(req, '因子库', '发布版本', r.version, `发布因子版本 ${r.version}（${r.factorCount} 项）`);
  ok(res, r, `因子版本 ${r.version} 已发布并上链存证`);
}));

router.get('/factor-versions', wrap(async (req, res) => {
  ok(res, await factor.listVersions());
}));

/* ---------------- A4 对账中心 ---------------- */

router.post('/reconcile', wrap(async (req, res) => {
  const r = await infra.reconcile();
  await writeLog(req, '对账中心', '执行对账', r.reconNo || '', `核对 ${r.total} 条，不一致 ${r.inconsistent} 条`);
  ok(res, r, r.inconsistent === 0 ? '对账完成，链上链下全部一致' : `对账完成，发现 ${r.inconsistent} 条不一致记录`);
}));

router.get('/reconciliations', wrap(async (req, res) => {
  ok(res, await infra.reconcileHistory(req.query.limit ? Number(req.query.limit) : 20));
}));

/* ---------------- 基础设施：IPFS 存证 ---------------- */

router.post('/ipfs/anchor', wrap(async (req, res) => {
  let r;
  try { r = await infra.fileAnchor({ ...(req.body || {}), fromLabel: 'admin:system' }); }
  catch (e) { return fail(res, e.message, 400); }
  await writeLog(req, '存证', 'IPFS 上链', r.cid, `${r.fileName}（${r.size} B）`);
  ok(res, r, `文件已哈希上链，CID ${r.cid}`);
}));

/* ---------------- 基础设施：预言机 ---------------- */

router.post('/oracle', wrap(async (req, res) => {
  let r;
  try { r = await infra.oracle(req.body || {}); }
  catch (e) { return fail(res, e.message, 400); }
  await writeLog(req, '预言机', '多源校验', r.metric, `共识值 ${r.consensusValue} ${r.unit}（${r.trustedCount}/${r.sourceCount} 源可信）`);
  ok(res, r, `预言机共识值 ${r.consensusValue} ${r.unit}，已上链`);
}));

/* ---------------- 用户与权限：全平台账号台账 ----------------
 * 缺陷清单 P1-25：该页原来只有一张「演示账号」只读表 —— 管理员看得见账号，
 * 却既不能停用、也不能重置口令，页面上没有一个可点的动作。
 *
 * 这里补三个接口：列表 / 启停 / 重置口令。三条硬约束：
 *   ① 不能停用自己（否则一点就把自己锁在门外）；
 *   ② 不能停用最后一个启用的 ADMIN（平台再也没有人能改配置）；
 *   ③ 每次启停/重置都写审计日志（谁、对谁、做了什么）。
 * 账号状态语义：1 启用 / 0 待审核（机构自主注册待准入）/ 2 停用。 */

router.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const role = String(req.query.role || '').trim().toUpperCase();
  const where = [];
  const args = [];
  if (q) {
    where.push('(u.username LIKE ? OR u.real_name LIKE ? OR u.org_name LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (role) { where.push('u.role = ?'); args.push(role); }
  const rows = await db.query(
    `SELECT u.id, u.username, u.real_name, u.role, u.org_id, u.org_name, u.post,
            u.status, u.last_login, u.created_at, p.label AS post_label
       FROM sys_user u
       LEFT JOIN user_post_dict p ON p.post = u.post
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY FIELD(u.role,'ADMIN','REGULATOR','VERIFIER','ENTERPRISE','TRADER'), u.org_id, u.id`,
    args
  );
  const STATUS_CN = { 1: '启用', 0: '待审核', 2: '停用' };
  const list = rows.map((r) => ({
    id: Number(r.id),
    username: r.username,
    realName: r.real_name,
    role: r.role,
    roleCn: { ENTERPRISE: '企业端', VERIFIER: '核查机构端', REGULATOR: '监管端', TRADER: '交易端', ADMIN: '管理端' }[r.role] || r.role,
    post: r.post || null,
    postCn: r.post_label || null,
    orgName: r.org_name || null,
    status: Number(r.status),
    statusCn: STATUS_CN[Number(r.status)] || '未知',
    lastLogin: r.last_login,
    createdAt: r.created_at,
    isSelf: Number(r.id) === Number(req.user.id),
  }));
  const byRole = {};
  list.forEach((u) => { byRole[u.role] = byRole[u.role] || { total: 0, active: 0 }; byRole[u.role].total += 1; if (u.status === 1) byRole[u.role].active += 1; });
  ok(res, {
    rows: list,
    total: list.length,
    active: list.filter((u) => u.status === 1).length,
    suspended: list.filter((u) => u.status === 2).length,
    pendingReview: list.filter((u) => u.status === 0).length,
    byRole,
  });
}));

router.patch('/users/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const status = Number(req.body && req.body.status);
  if (![1, 2].includes(status)) return fail(res, 'status 只能是 1（启用）或 2（停用）', 400);
  const u = await db.one('SELECT id, username, role, status FROM sys_user WHERE id = ?', [id]);
  if (!u) return fail(res, '账号不存在', 404);
  if (u.status === 0) return fail(res, '该账号处于待审核状态，请在「待审核查机构注册」中审核', 409);
  if (Number(id) === Number(req.user.id) && status === 2) return fail(res, '不能停用当前登录账号', 403);
  if (u.role === 'ADMIN' && status === 2) {
    const left = await db.value("SELECT COUNT(*) FROM sys_user WHERE role = 'ADMIN' AND status = 1 AND id <> ?", [id]);
    if (Number(left) === 0) return fail(res, '这是最后一个启用的管理端账号，停用后将无人可管理平台', 409);
  }
  await db.query('UPDATE sys_user SET status = ? WHERE id = ?', [status, id]);
  await writeLog(req, '用户管理', status === 1 ? '启用账号' : '停用账号', u.username,
    `账号 ${u.username}（${u.role}）已${status === 1 ? '启用' : '停用'}`);
  ok(res, { id, status }, status === 1 ? `已启用 ${u.username}` : `已停用 ${u.username}`);
}));

router.post('/users/:id/reset-password', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.one('SELECT id, username, role FROM sys_user WHERE id = ?', [id]);
  if (!u) return fail(res, '账号不存在', 404);
  /* 重置为平台约定的演示口令（管理端 admin123，其余 123456）：
   * 这是答辩现场"换个账号演示"的常规操作，口令本身是公开的演示口令，
   * 回传给管理员不构成额外泄露；正式环境应改为一次性链接 + 强制改密。 */
  const cu = require('../blockchain/crypto-utils');
  const next = u.role === 'ADMIN' ? 'admin123' : '123456';
  const salt = cu.randomSalt(16);
  await db.query('UPDATE sys_user SET password = ?, salt = ? WHERE id = ?',
    [cu.hashPasswordPbkdf2(next, salt), salt, id]);
  await writeLog(req, '用户管理', '重置口令', u.username, `账号 ${u.username} 的口令已重置为演示口令`);
  ok(res, { id, username: u.username, password: next }, `已重置 ${u.username} 的口令`);
}));

/* ---------------- 核查机构注册审核 ----------------
 * 机构自主注册以 sys_user.status=0（待审核）落库，管理员在此
 * 人工准入：通过 → status=1 + verifier_org 转正式 ACTIVE；
 * 驳回 → 注册记录与机构档案一并删除（未产生任何业务数据，可安全清理）。
 * 审核动作全部写审计日志 —— "第三方机构实名注册 + 平台审核准入"
 * 本身就是参赛口径里的合规亮点。 */

router.get('/verifier-registrations', wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT id, username, real_name, org_name, phone, created_at, last_login
       FROM sys_user
      WHERE role = 'VERIFIER' AND status = 0
      ORDER BY created_at DESC`
  );
  ok(res, rows.map((r) => ({
    id: Number(r.id), username: r.username, realName: r.real_name,
    orgName: r.org_name, phone: r.phone, createdAt: r.created_at,
    lastLogin: r.last_login,
  })));
}));

router.post('/verifier-registrations/:id/review', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const approve = !!(req.body && req.body.approve);
  const reason = String((req.body && req.body.reason) || '').trim();

  const u = await db.one("SELECT id, username, real_name, org_id, org_name, status FROM sys_user WHERE id = ? AND role = 'VERIFIER'", [id]);
  if (!u) return fail(res, '注册记录不存在或角色不符', 404);
  if (u.status !== 0) return fail(res, '该注册申请已被处理', 409);

  if (approve) {
    /* P1 资质互斥（2026-10-29）：核查机构与交易代理不得同体。
     * 在"开通核查资质"这个时点校验，命中互斥规则直接拒绝——
     * 利益冲突靠制度约束无效，必须在系统层面硬阻断。 */
    const integrity = require('../services/integrity');
    try {
      await integrity.grantQualification(
        integrity.normalizeOrg(u.org_name), u.org_name, 'VERIFIER',
        { grantedBy: req.user.id, evidence: reason || null }
      );
    } catch (e) {
      if (e instanceof integrity.IntegrityError) return fail(res, e.message, e.status);
      throw e;
    }

    await db.tx(async (conn) => {
      await conn.query('UPDATE sys_user SET status = 1 WHERE id = ?', [id]);
      await conn.query("UPDATE verifier_org SET status = 'ACTIVE' WHERE id = ?", [u.org_id]);
    });
    await writeLog(req, '用户管理', '机构审核通过', u.username,
      `核查机构 ${u.org_name} 审核准入（账号 ${u.username}）${reason ? `· 备注：${reason}` : ''}`);
    return ok(res, { approved: true, username: u.username, orgName: u.org_name }, '已通过：机构账号开通');
  }

  /* 驳回：清理注册记录（账号 + PENDING 机构档案）。先删账号再删档案，
   * 若档案删除失败仅留一条孤儿档案（无账号可登录，无害），不影响驳回结论。 */
  await db.query('DELETE FROM sys_user WHERE id = ? AND status = 0', [id]);
  await db.query("DELETE FROM verifier_org WHERE id = ? AND status = 'PENDING'", [u.org_id]);
  await writeLog(req, '用户管理', '机构审核驳回', u.username,
    `驳回核查机构 ${u.org_name} 的注册申请（账号 ${u.username}）${reason ? `· 原因：${reason}` : ''}`);
  ok(res, { approved: false, username: u.username, orgName: u.org_name }, '已驳回：注册记录已清理');
}));

module.exports = router;
