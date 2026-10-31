/**
 * worker/lib/http.mjs —— 极简路由 + 统一响应 + JWT 鉴权
 * ==================================================================================
 * 【为什么不用 Express】
 * Express 依赖 Node 的 http 模块、流、Buffer 等，无法在 Workers 运行。
 * 而本平台只需要「路径匹配 + 中间件链」这两个能力 —— 用一个约 200 行的
 * 路由表就够，引入 Hono/itty-router 反而多一层依赖与打包体积。
 *
 * 【路由匹配规则】
 * 支持 `/api/real/facilities/:id` 这类命名参数，与平台既有 Express 路由风格一致。
 * 因此 server/routes/*.js 里的路径声明可以逐条照搬，不需要重新设计。
 *
 * 【响应格式必须与既有前端完全一致】
 * 前端 core.js 的 API.request 期望：
 *     { code: 0, msg: 'ok', data: ..., meta: ... }   成功
 *     { code: <非0>, msg: '...', data: null }         失败
 * 一旦格式变了，所有页面同时白屏。因此这里固定这两种形状，
 * 且 `code` 与 HTTP status 分离（业务错误用非 0 code + 对应 HTTP status）。
 *
 * @module worker/lib/http
 */

import { makeDb, makePaginate, createUsageMeter, selectBackend } from './db.mjs';

/* ==================================================================================
 * 一、响应构造
 * ================================================================================== */

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Expose-Headers': 'X-D1-Rows-Read, X-Request-Id',
};

function corsFor(env, request) {
  /* 生产：只允许同源（前端与 API 同域部署在 Workers 上，同源请求本不需要 CORS 头）。
   * 开发预览：允许回显来源，方便本地 8300 端口联调。
   * 配置了 CORS_ORIGINS 时按白名单。 */
  const origin = request.headers.get('Origin');
  const allow = String(env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { ...CORS_HEADERS, Vary: 'Origin' };
  if (allow.length) {
    if (origin && allow.includes(origin)) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Access-Control-Allow-Credentials'] = 'true';
    }
  } else if (env.CORS_DEV === '1') {
    h['Access-Control-Allow-Origin'] = origin || '*';
    h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}

export function json(data, meta, init = {}) {
  const body = { code: 0, msg: 'ok', data: data === undefined ? null : data, meta: meta === undefined ? null : meta };
  /* 安全响应头（与 Node 版 server/app.js 同一套，两运行时不得出现安全差异）：
   * nosniff 防 JSON 被嗅探为 HTML 执行；DENY 防验真页被透明 iframe 套壳诱导点击；
   * Referrer-Policy 防钱包地址随 Referer 外泄。本运行时全走 HTTPS，HSTS 常开。 */
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    ...(init.headers || {}),
  };
  return new Response(JSON.stringify(body), { status: 200, headers: h });
}

export function fail(message, status = 400, code) {
  return new Response(JSON.stringify({
    code: code === undefined ? status : code,
    msg: String(message || '请求处理失败'),
    data: null,
  }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* ==================================================================================
 * 二、路由表
 * ================================================================================== */

/**
 * 把 `/a/:id/b` 编译成匹配函数。
 * 返回 { re, keys }，re 的捕获组顺序与 keys 一致。
 */
function compilePath(path) {
  const keys = [];
  const pattern = path
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // 转义正则元字符（先转义）
    .replace(/\/:([A-Za-z_][\w]*)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })
    /* 支持末尾通配 `*`，用于静态资源与 SPA 兜底 */
    .replace(/\*$/, '(.*)');
  return { re: new RegExp(`^${pattern}/?$`), keys };
}

export class Router {
  constructor() {
    this.routes = [];
    this.globals = [];
  }

  /** 全局中间件（按注册顺序执行，可返回 Response 提前结束） */
  use(fn) {
    this.globals.push(fn);
    return this;
  }

  add(method, path, ...handlers) {
    const { re, keys } = compilePath(path);
    this.routes.push({ method: method.toUpperCase(), path, re, keys, handlers });
    return this;
  }

  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }

  /** 找出匹配的路由（含同路径但方法不符的情况，用于返回 405） */
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method.toUpperCase()) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] || ''); });
      return { route: r, params };
    }
    return pathMatched ? { methodMismatch: true } : null;
  }

  /** 执行 */
  async dispatch(ctx) {
    /* 全局中间件 */
    for (const g of this.globals) {
      const r = await g(ctx);
      if (r instanceof Response) return r;
    }

    const found = this.match(ctx.method, ctx.path);
    if (!found) return null;
    if (found.methodMismatch) return fail('方法不被允许', 405);
    ctx.params = found.params;

    for (const h of found.route.handlers) {
      const r = await h(ctx);
      if (r instanceof Response) return r;
    }
    return fail(`路由 ${found.route.path} 未返回响应`, 500);
  }
}

/* ==================================================================================
 * 三、JWT（HS256，与 server/middleware/auth.js 同格式）
 * ==================================================================================
 * 平台既有令牌是 HS256 JWT，payload 含 { uid, username, role, orgId }。
 * Workers 的 WebCrypto 支持 HMAC-SHA256，可直接验签 —— 因此线上与本地
 * 可以共用同一个 JWT_SECRET，用户不需要在两套系统里各登录一次。
 */

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToBytes(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signJwt(payload, secret, ttlSeconds = 12 * 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const h = b64urlEncode(enc.encode(JSON.stringify(header)));
  const p = b64urlEncode(enc.encode(JSON.stringify(body)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyJwt(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecodeToBytes(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(p)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ==================================================================================
 * 四、上下文构造
 * ================================================================================== */

export function makeContext(request, env, ctxInfo = {}) {
  const url = new URL(request.url);
  const meter = createUsageMeter();
  /* 后端选择：配置了 TURSO_URL 则整体切 Turso（5 亿行读/月），
   * 否则用 D1（wrangler 绑定的 env.DB）。二者 SQL 方言同为 SQLite。 */
  const backend = selectBackend(env);
  const db = makeDb(backend, meter);

  const ctx = {
    request,
    env,
    url,
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    params: {},
    db,
    paginate: makePaginate(db),
    meter,
    user: null,
    /** 读取 JSON body（失败返回空对象，避免调用方到处 try） */
    async body() {
      if (request.method === 'GET' || request.method === 'HEAD') return {};
      try { return await request.json(); } catch { return {}; }
    },
    /** 载入当前用户（从 Authorization 头） */
    async loadUser() {
      const h = request.headers.get('Authorization') || '';
      const m = h.match(/^Bearer\s+(.+)$/i);
      const q = url.searchParams.get('token');
      const token = m ? m[1] : q;
      if (!token) return null;
      const payload = await verifyJwt(token, env.JWT_SECRET || 'dev-only-change-me');
      if (!payload) return null;
      this.user = {
        uid: payload.uid,
        username: payload.username,
        role: payload.role,
        orgId: payload.orgId,
        name: payload.name,
      };
      return this.user;
    },
    waitUntil: ctxInfo.waitUntil || (() => {}),
  };
  return ctx;
}

/* ==================================================================================
 * 五、鉴权装饰器（与 server/middleware/auth.js 语义一致）
 * ================================================================================== */

/** 必须登录；失败返回 401 */
export function authRequired(handler) {
  return async (ctx) => {
    const u = ctx.user || await ctx.loadUser();
    if (!u) return fail('登录状态已失效，请重新登录', 401);
    return handler(ctx);
  };
}

/** 必须属于指定角色之一；ADMIN 隐式放行（与既有实现的约定一致） */
export function requireRole(...roles) {
  return (handler) => authRequired(async (ctx) => {
    const r = ctx.user && ctx.user.role;
    if (r !== 'ADMIN' && !roles.includes(r)) {
      return fail(`当前角色（${r || '未登录'}）无权访问该接口`, 403);
    }
    return handler(ctx);
  });
}

/* ==================================================================================
 * 六、工具
 * ================================================================================== */

/** 安全转数字 */
export function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 白名单校验（用于 SQL 片段拼接场景） */
export function pickEnum(v, allowed, dflt) {
  return allowed.includes(v) ? v : dflt;
}

export { createUsageMeter };
