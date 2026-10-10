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
async function writeLog(req, module, action, target, detail, result = 'SUCCESS') {
  try {
    const u = req.user || {};
    await db.query(
      `INSERT INTO audit_log (user_id, username, role, module, action, target, detail, ip, result)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        u.id || null, u.username || 'anonymous', u.role || '-', module, action,
        target || null, detail || null,
        (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 60),
        result,
      ]
    );
  } catch (e) {
    /* 日志失败不影响主流程 */
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
