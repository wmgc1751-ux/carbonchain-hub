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

function signToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + config.jwt.expiresIn };
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
  if (expect !== sig) return null;
  try {
    const body = JSON.parse(Buffer.from(p2, 'base64url').toString('utf8'));
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch (e) {
    return null;
  }
}

/* ---------------- 中间件 ---------------- */

/** 必须登录 */
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ code: 401, message: '登录状态已失效，请重新登录' });
  req.user = user;
  next();
}

/** 角色白名单 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
    if (roles.length && !roles.includes(req.user.role) && req.user.role !== 'ADMIN') {
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

module.exports = { signToken, verifyToken, authRequired, requireRole, writeLog, ok, fail, wrap };
