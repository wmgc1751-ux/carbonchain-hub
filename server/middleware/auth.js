/**
 * auth.js —— 认证 / 鉴权 / 审计中间件
 * JWT(HS256) 采用 Node 内置 crypto 手写实现，不引入额外依赖，便于审计。
 */
'use strict';

const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

/* ---------------- JWT ---------------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');

/* 吊销黑名单（内存版，jti → 过期时刻）。单实例部署下完整有效（本服务有实例互斥）；
 * 登出/改密即写入，token 自身过期后条目自动清除，内存有界。
 * 多副本部署时应替换为 Redis（与本文件顶注释同口径）。 */
const revokedTokens = new Map();
function pruneRevoked() {
  const now = Date.now() / 1000;
  for (const [jti, exp] of revokedTokens) if (exp <= now) revokedTokens.delete(jti);
  /* 超量兜底：Map 保持插入序，删最旧的 */
  while (revokedTokens.size > 10_000) revokedTokens.delete(revokedTokens.keys().next().value);
}
const revokedSweeper = setInterval(pruneRevoked, 10 * 60 * 1000);
if (revokedSweeper.unref) revokedSweeper.unref();

function signToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  /* jti：令牌唯一 ID，供登出吊销定位单个令牌 */
  const body = { ...payload, jti: crypto.randomBytes(9).toString('base64url'), iat: now, exp: now + config.jwt.expiresIn };
  const p1 = b64u(JSON.stringify(header));
  const p2 = b64u(JSON.stringify(body));
  const sig = crypto
    .createHmac('sha256', config.jwt.secret)
    .update(`${p1}.${p2}`)
    .digest('base64url');
  return `${p1}.${p2}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [p1, p2, sig] = parts;
  const expect = crypto
    .createHmac('sha256', config.jwt.secret)
    .update(`${p1}.${p2}`)
    .digest('base64url');
  /* 常量时间比较：普通 !== 在签名前缀相同时存在理论上的时序侧信道 */
  const a = Buffer.from(expect);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const raw = JSON.parse(Buffer.from(p2, 'base64url').toString('utf8'));
    if (raw.exp && raw.exp < Math.floor(Date.now() / 1000)) return null;
    if (raw.jti && revokedTokens.has(raw.jti)) return null;   // 已吊销
    return normalizeClaims(raw);
  } catch (e) {
    return null;
  }
}

/**
 * 跨端 claims 归一（2026-10-31 两端账号互通）
 * ------------------------------------------------------------------
 * 平台签发的 claims 是 { id, username, role, realName, orgId, orgName }，
 * 小程序签发的是 { uid, username, role, entId, name, org }。
 * 两端共用同一个 JWT_SECRET 之后，平台会验到小程序签发的令牌 ——
 * 若不做归一，业务代码读 req.user.id / orgId 会拿到 undefined，
 * 表现为"登录成功、进页面全空"（比 401 更难查）。
 *
 * 归一方向：把小程序的键补齐成平台键，**原有的键全部保留**，
 * 因此平台自己签发的令牌行为完全不变（幂等）。
 */
function normalizeClaims(raw) {
  const c = { ...raw };
  if (c.id === undefined && c.uid !== undefined) c.id = c.uid;
  if (c.uid === undefined && c.id !== undefined) c.uid = c.id;
  if (c.orgId === undefined && c.entId !== undefined) c.orgId = c.entId;
  if (c.entId === undefined && c.orgId !== undefined) c.entId = c.orgId;
  if (c.realName === undefined && c.name !== undefined) c.realName = c.name;
  if (c.orgName === undefined && c.org !== undefined) c.orgName = c.org;
  return c;
}

/** 吊销一个已签发的 token（登出时调用）。无效/过期的 token 静默忽略。 */
function revokeToken(token) {
  const body = verifyToken(token);
  if (body && body.jti) {
    revokedTokens.set(body.jti, body.exp || Math.floor(Date.now() / 1000) + 60);
    pruneRevoked();
  }
}

/* ---------------- 中间件 ---------------- */

/** 必须登录 */
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  /* 只认 Authorization 头。旧版还接受 ?token= 查询参数，但 URL 会进
   * 访问日志/Referer/代理日志，等于把令牌写进第三方留存——已收紧移除。 */
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ code: 401, message: '登录状态已失效，请重新登录' });
  req.user = user;
  next();
}

/**
 * 可选登录：有有效 token 就解析出身份，没有/无效则按访客放行（req.user = null）。
 *
 * 用于 AI 顾问这类**访客也能用、但登录后要认得自己企业**的接口。
 * 曾经 /api/copilot/ask 完全不挂鉴权，后果是 req.user 恒为 undefined ——
 * 企业账号问"我的配额"时拿不到 orgId，工具只能报"未指定企业"，
 * 而模型被迫围绕一个空数据答，看起来像 AI 不会用，实际是身份丢了。
 *
 * ⚠ 不得用它替代 authRequired：需要身份才能做的操作（改配置、查他人数据）
 *   必须用 authRequired，否则等于把权限校验变成"有就查、没有就跳过"。
 */
function authOptional(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  req.user = token ? verifyToken(token) : null;
  next();
}

/** 角色白名单
 *
 * ⚠ 2026-10-29 P1 权限收缩：移除了 ADMIN 的"超级用户"旁路。
 *
 * 改造前第 91 行是：
 *   if (roles.length && !roles.includes(req.user.role) && req.user.role !== 'ADMIN')
 * 即 **ADMIN 永远通过任何角色检查**——管理员可调用全部业务接口（配额分配、
 * 核查结论、批量清缴、交易下单…）。这违反内控的基本原则：管理员若同时能
 * 决定业务结果，审计就变成"自己审自己"；一旦管理员账号被冒用，损失是全域的。
 *
 * 现在的规则：ADMIN 只能进入显式列出 'ADMIN' 的接口（配置/运维/审计），
 * 业务决策类接口必须显式声明角色，不再有隐式旁路。
 * 若确有管理员需要临时参与业务，应该用业务角色账号，而不是放宽 ADMIN。
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ code: 403, message: '当前角色无权访问该功能' });
    }
    next();
  };
}

/** 记录操作日志（业务审计留痕） */
/**
 * 写审计日志（WP6：写入即入哈希链）。
 *
 * 改造前是裸 INSERT，任何能连库的人都能 UPDATE 抹掉"谁改了配额"而看不出来。
 * 现在每条写入都会链上前一条的 entry_hash，改动任意一条都会导致其后全部失配。
 * 实现见 services/auditChain.js（含时区口径与并发说明）。
 *
 * 日志失败不影响主流程 —— 但**不静默**：控制台会留下痕迹，
 * 否则"审计失败"本身就成了一条不被审计的事件。
 */
async function writeLog(req, module, action, target, detail, result = 'SUCCESS') {
  const u = req.user || {};
  const payload = {
    userId: u.id || null,
    username: u.username || 'anonymous',
    role: u.role || '-',
    module, action,
    target: target || null,
    detail: detail || null,
    ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 60),
    result,
  };
  try {
    // 延迟 require：避免 auth.js（被几乎所有路由依赖）与审计链产生加载期循环
    const auditChain = require('../services/auditChain');
    return await auditChain.append(payload);
  } catch (e) {
    console.error('[audit] 审计日志入链失败（主流程不受影响）：', e.message);
    // 兜底：至少把内容落库，宁可暂时未封印，也不丢事件
    try {
      await db.query(
        `INSERT INTO audit_log (user_id, username, role, module, action, target, detail, ip, result)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [payload.userId, payload.username, payload.role, module, action,
          payload.target, payload.detail, payload.ip, result]
      );
    } catch (e2) {
      console.error('[audit] 兜底写入同样失败：', e2.message);
    }
    return null;
  }
}

/** 统一响应包装 */
function ok(res, data, message = 'ok') {
  return res.json({ code: 0, message, data });
}

function fail(res, message, code = 500) {
  return res.status(code).json({ code, message });
}

/** async 路由异常捕获 */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { signToken, verifyToken, revokeToken, authRequired, authOptional, requireRole, writeLog, ok, fail, wrap };
