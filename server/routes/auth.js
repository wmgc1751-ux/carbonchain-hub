/**
 * routes/auth.js —— 认证与账号
 */
'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const cu = require('../blockchain/crypto-utils');
const { signToken, authRequired, writeLog, ok, fail, wrap } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();

/** 角色中文名 */
const ROLE_CN = { ENTERPRISE: '企业端', VERIFIER: '核查机构端', REGULATOR: '监管端', ADMIN: '系统管理' };

/** 演示账号接口开关（安全默认：线上关闭）
 *   · 显式 DEMO_ACCOUNTS=true   → 开放（确有演示需要时主动开启）；
 *   · 显式 DEMO_ACCOUNTS=false  → 关闭；
 *   · 未设置：本地 / 内网开发默认开放（便于一键切换身份），
 *             生产环境与托管云平台（Render 等）一律关闭。
 *  判定用 config.isProd 而不是裸读 NODE_ENV：即便线上忘了设置
 *  NODE_ENV=production，只要跑在 Render 这类平台上，接口依然是关闭的。 */
const DEMO_ACCOUNTS = config.demoAccounts;

/** 登录限流：同一 IP + 账号每分钟最多 10 次，防暴力破解 */
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  keyFn: (req) => `${req.ip}|${(req.body && req.body.username) || ''}`,
  message: '登录尝试过于频繁，请 1 分钟后再试',
});

/* 登录 ------------------------------------------------------------- */
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, '请输入账号与密码', 400);

  const user = await db.one('SELECT * FROM sys_user WHERE username = ?', [username]);
  if (!user) {
    await writeLog({ headers: req.headers, ip: req.ip }, '用户管理', '登录', username, '账号不存在', 'FAIL');
    return fail(res, '账号或密码错误', 401);
  }
  if (user.status !== 1) return fail(res, '账号已被停用，请联系管理员', 403);

  const v = cu.verifyPassword(password, user.salt, user.password);
  if (!v.ok) {
    await writeLog({ user: { id: user.id, username, role: user.role }, headers: req.headers, ip: req.ip },
      '用户管理', '登录', username, '密码校验失败', 'FAIL');
    return fail(res, '账号或密码错误', 401);
  }
  // 命中旧 SHA256 摘要时，登录成功后透明升级为 scrypt（用户无需感知）
  if (v.legacy) {
    try {
      await db.query('UPDATE sys_user SET password = ? WHERE id = ?',
        [cu.hashPasswordScrypt(password, user.salt), user.id]);
    } catch (e) { /* 迁移失败不影响本次登录 */ }
  }

  await db.query('UPDATE sys_user SET last_login = NOW() WHERE id = ?', [user.id]);

  const payload = {
    id: user.id, username: user.username, role: user.role,
    realName: user.real_name, orgId: user.org_id, orgName: user.org_name,
  };
  const token = signToken(payload);

  const reqLike = { user: payload, headers: req.headers, ip: req.ip };
  await writeLog(reqLike, '用户管理', '登录', username, `以${ROLE_CN[user.role] || user.role}身份登录成功`);

  // 企业端把钱包地址一并返回，前端可直接展示"我的链上身份"
  let wallet = null;
  if (user.role === 'ENTERPRISE' && user.org_id) {
    wallet = await db.value('SELECT wallet_address FROM enterprise WHERE id = ?', [user.org_id]);
  } else if (user.role === 'VERIFIER' && user.org_id) {
    wallet = await db.value('SELECT wallet_address FROM verifier_org WHERE id = ?', [user.org_id]);
  }

  ok(res, { token, user: { ...payload, roleCn: ROLE_CN[user.role], wallet } }, '登录成功');
}));

/* 当前用户 --------------------------------------------------------- */
router.get('/me', authRequired, wrap(async (req, res) => {
  const u = await db.one(
    'SELECT id, username, real_name, role, org_id, org_name, phone, email, last_login FROM sys_user WHERE id = ?',
    [req.user.id]
  );
  if (!u) return fail(res, '账号不存在', 404);
  u.roleCn = ROLE_CN[u.role];
  if (u.role === 'ENTERPRISE') {
    u.orgDetail = await db.one('SELECT * FROM enterprise WHERE id = ?', [u.org_id]);
  } else if (u.role === 'VERIFIER') {
    u.orgDetail = await db.one('SELECT * FROM verifier_org WHERE id = ?', [u.org_id]);
  }
  ok(res, u);
}));

/* 退出 ------------------------------------------------------------- */
router.post('/logout', authRequired, wrap(async (req, res) => {
  await writeLog(req, '用户管理', '退出登录', req.user.username, '退出系统');
  ok(res, null, '已退出');
}));

/* 修改口令 --------------------------------------------------------- */
router.post('/change-password', authRequired, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return fail(res, '新口令至少 6 位', 400);
  const u = await db.one('SELECT * FROM sys_user WHERE id = ?', [req.user.id]);
  if (!cu.verifyPassword(oldPassword || '', u.salt, u.password).ok) return fail(res, '原口令不正确', 400);
  const salt = cu.randomSalt(16);
  await db.query('UPDATE sys_user SET password = ?, salt = ? WHERE id = ?',
    [cu.hashPasswordScrypt(newPassword, salt), salt, req.user.id]);
  await writeLog(req, '用户管理', '修改口令', u.username, '口令已更新');
  ok(res, null, '口令修改成功');
}));

/* 演示账号（方便答辩现场一键切换身份） ------------------------------- */
router.get('/demo-accounts', wrap(async (req, res) => {
  if (!DEMO_ACCOUNTS) return fail(res, '演示账号接口已在当前环境关闭', 403);
  const rows = await db.query(
    `SELECT id, username, real_name, role, org_name FROM sys_user
     WHERE username IN ('admin','reg001','ent001','ent002','ent003','ver001','ver002') ORDER BY id`
  );
  ok(res, rows.map((r) => ({
    username: r.username,
    password: r.username === 'admin' ? 'admin123' : '123456',
    realName: r.real_name,
    role: r.role,
    roleCn: ROLE_CN[r.role],
    orgName: r.org_name,
  })));
}));

module.exports = router;
