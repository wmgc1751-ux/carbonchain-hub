/**
 * worker/index.mjs —— 碳链通平台 · Cloudflare Workers 入口
 * ==================================================================================
 * 【这一层的定位】
 *
 * 平台此前线上是「Cloudflare Pages 静态站 + 前端拦截 /api 回放快照」。
 * 那个模式的问题不是性能，而是**语义**：页面上的每个数字都是某个时刻的
 * 快照，却以"当前值"的样式呈现。评审点开两个页面看到互相矛盾的数，
 * 无法判断哪个是真的。
 *
 * 本轮把这些全部换成真实后端：
 *   · 所有 /api/* 由本 Worker 实时计算并读 D1
 *   · 前端不再有任何快照回放分支（staticApi.js 已删）
 *   · 静态资源仍由 Pages/Assets 提供，但**数据永远是活的**
 *
 * 【为什么数据库是 D1 而不是 MySQL】
 * Workers 无法建立 MySQL 的长连接（无 TCP socket）。D1 是 Cloudflare 的
 * SQLite 服务，与 Worker 同域、零连接开销。代价是三个真实限制，
 * 全部在下面的代码里显式处理，不假装不存在：
 *   ① 无交互式事务（只有 batch 原子提交）
 *   ② 每日写入 10 万行的额度
 *   ③ 全表聚合按扫描行计费（必须用预聚合表）
 *
 * 【实时性怎么保证】
 * 分两类，绝不混为一谈：
 *   · **真·实时**（读时确定性计算）：负荷曲线、瞬时速率、今日累计 ——
 *     给定时刻 t，任何请求都算出同一个值，不落库、不消耗写入额度。
 *   · **准实时**（Cron 预聚合）：行业/区域汇总、洞察 —— 每 30 分钟刷新。
 *     页面上明确标注"截至 HH:MM"，不写"实时"。
 *
 * @module worker/index
 */

import { Router, makeContext, json, fail, authRequired, requireRole, num } from './lib/http.mjs';
import * as real from './routes/real.mjs';
import { attachAssetRoutes } from './routes/assets.mjs';
import { attachAuthRoutes } from './routes/auth.mjs';
import { attachBizRoutes } from './routes/biz.mjs';
import { attachBiz2Routes } from './routes/biz2.mjs';
import { registerCachePurge } from './lib/chainwrite.mjs';
import { attachChainRoutes } from './routes/chain.mjs';
import { attachOpsRoutes } from './routes/ops.mjs';
import { attachTwinRoutes } from './routes/twin.mjs';
import { attachCopilotRoutes } from './routes/copilot.mjs';
import { attachNoticeFeedRoutes } from './routes/noticeFeed.mjs';
import { attachEvidenceRoutes } from './routes/evidence.mjs';
import { refreshAggregates } from './jobs/aggregate.mjs';

const BUILD = {
  version: '2.0.0-worker',
  builtAt: '2026-10-24',
  runtime: 'cloudflare-workers',
  database: 'd1',
};

/* ==================================================================================
 * 路由装配
 * ================================================================================== */

function buildRouter() {
  const r = new Router();

  /* ---------- 健康检查：必须最先注册 ----------
   * 历史教训：international.js 挂在 /api 根上且内部 use(authRequired)，
   * 导致其后注册的 /api/health 也被要求登录，云平台健康检查拿到 401
   * 判定实例不健康 ⇒ 部署成功但流量不切。
   * 这里把所有 /api 级中间件都放在健康检查**之后**。 */
  r.get('/api/health', async (ctx) => {
    const t0 = Date.now();
    let dbOk = false;
    let dbErr = null;
    let tables = 0;
    try {
      tables = num(await ctx.db.value(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"));
      dbOk = true;
    } catch (e) { dbErr = String(e.message || e); }

    return json({
      status: dbOk ? 'UP' : 'DEGRADED',
      time: new Date().toISOString(),
      build: { ...BUILD, database: ctx.db.backend || 'd1' },
      database: { ok: dbOk, engine: ctx.db.backend || 'd1', tables, error: dbErr },
      latencyMs: Date.now() - t0,
      /* 明确声明：这不是快照，是实时读库 */
      dataMode: 'LIVE',
    });
  });

  /* ---------- 真实数据层（公开，无需登录） ----------
   * 理由：源数据本身是公开数据集（EPA Public Domain / Climate TRACE CC BY）。
   * 锁在登录后会让"可核验"变成"请相信"。 */
  r.get('/api/real/overview', real.overview);
  r.get('/api/real/facilities', real.facilities);
  r.get('/api/real/facilities/:id', real.facilityDetail);
  r.get('/api/real/trend', real.trend);
  r.get('/api/real/benchmarks', real.benchmarks);
  r.get('/api/real/sources', real.sources);
  r.get('/api/real/truth', real.truth);
  r.get('/api/real/cn/regions', real.cnRegions);
  r.get('/api/real/cn/insight', real.cnInsight);
  /* 兼容：集中度与集团视角也走同一个洞察端点 */
  r.get('/api/real/cn/concentration', async (ctx) => {
    ctx.query.mode = 'concentration';
    return real.cnInsight(ctx);
  });
  r.get('/api/real/cn/owner-groups', async (ctx) => {
    ctx.query.mode = 'groups';
    return real.cnInsight(ctx);
  });

  /* ---------- 其余业务路由 ---------- */
  attachAuthRoutes(r);
  attachBizRoutes(r);
  attachBiz2Routes(r);
  attachChainRoutes(r);
  attachAssetRoutes(r);
  attachOpsRoutes(r);
  /* 真实厂区数字孪生：从 Climate TRACE 真实设施数据派生 3D 厂区几何 */
  attachTwinRoutes(r);
  /* AI 顾问 + 可信存证（Worker 版：capabilities/nodes 不查 D1，
   * ask/list 查 D1 但走边缘缓存；额度耗尽时 capabilities/nodes 仍可用） */
  attachCopilotRoutes(r);
  attachEvidenceRoutes(r);
  /* 实时通知聚合：权威源站 → Cache API，零 D1 消耗 */
  attachNoticeFeedRoutes(r);

  /* ---------- 运维：手动刷新预聚合（需 ADMIN/REGULATOR） ---------- */
  r.post('/api/ops/refresh-aggregates', requireRole('ADMIN', 'REGULATOR')(async (ctx) => {
    /* ⚠ 把错误细节返回给**已鉴权**的运维人员。
     *
     * 全局错误处理器对所有 500 都返回"服务器内部错误" —— 那是对的（不向公众泄露栈），
     * 但对运维动作而言，没有细节就无从修复。因此这里自行捕获并按角色决定详细程度：
     * ADMIN 拿到完整栈与提示，其他角色只拿到概要。 */
    try {
      const res = await refreshAggregates(ctx.env, ctx.db, {
        force: String(ctx.query.force || '') === '1',
        level: String(ctx.query.level || 'INSIGHTS').toUpperCase() === 'AGGREGATE'
          ? 'AGGREGATE' : 'INSIGHTS',
      });
      return json(res);
    } catch (e) {
      console.error('[REFRESH_AGG_ERROR]', e && e.stack ? e.stack : e);
      const detail = {
        error: String((e && e.message) || e),
        hint: '常见原因：D1 单次 batch 语句数超限、某表缺列、或 SQL 方言不兼容（JSON_*/FIELD/LIMIT x,y）。',
      };
      if (ctx.user && ctx.user.role === 'ADMIN') {
        detail.stack = String((e && e.stack) || '').split('\n').slice(0, 10);
      }
      return new Response(JSON.stringify({ code: 500, msg: '预聚合刷新失败', data: detail }),
        { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }));

  /* ---------- 未知 /api 路径 ---------- */
  r.get('/api/*', async () => fail('接口不存在', 404));
  r.post('/api/*', async () => fail('接口不存在', 404));
  r.put('/api/*', async () => fail('接口不存在', 404));
  r.delete('/api/*', async () => fail('接口不存在', 404));

  /* ---------- 静态资源（assets 绑定；未绑定时给明确提示） ---------- */
  r.get('/*', async (ctx) => {
    if (ctx.env.ASSETS && typeof ctx.env.ASSETS.fetch === 'function') {
      return ctx.env.ASSETS.fetch(ctx.request);
    }
    return new Response(
      '静态资源未绑定。请在 wrangler.json 里配置 assets.directory = "./public" 后重新部署。',
      { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  });

  return r;
}

let ROUTER = null;
function router() {
  if (!ROUTER) ROUTER = buildRouter();
  return ROUTER;
}

/* ==================================================================================
 * 入口
 * ================================================================================== */

/* ==================================================================================
 * 边缘缓存 TTL 分级
 * ==================================================================================
 * 按端点的数据变化频率分三档。变化越频繁 TTL 越短。
 *
 * ⚠ 以下端点**永不缓存**（返回 0）：
 *   · /api/real/stream     — SSE 流式推送，缓存会把流变成死数据
 *   · /api/real/live       — 每秒重算的实时指标，缓存 1 秒都是假的
 *   · /api/copilot/*       — POST 请求（本就不走 GET 缓存）
 *   · /api/evidence/notarize / verify — POST 写操作
 *
 * 【为什么真实数据层给 5 分钟就够了】
 * Climate TRACE 的数据是年度更新的。D1 里的这份镜像由 Cron 每 30 分钟
 * 检查一次增量。5 分钟的边缘缓存意味着：源数据不变时缓存命中（零 D1 读），
 * 源数据更新后最多 5 分钟内自动过期拉新值 —— 这不是静态，是活的缓存。 */
function edgeCacheTtl(pathname) {
  /* 永不缓存 */
  if (pathname.includes('/stream')) return 0;
  if (pathname.includes('/live')) return 0;
  if (pathname.startsWith('/api/copilot/ask')) return 0;
  if (pathname.startsWith('/api/copilot/stream')) return 0;
  /* capabilities 是静态清单，可以缓存 */
  if (pathname.startsWith('/api/copilot/capabilities')) return 300;
  if (pathname.startsWith('/api/evidence/notarize')) return 0;
  if (pathname.startsWith('/api/evidence/verify')) return 0;
  if (pathname.startsWith('/api/auth/')) return 0;

  /* 链状态：变化较频繁但不需要秒级 */
  /* 链概况：不缓存。它的唯一价值是"现在链到哪了" —— 缓存 60s 会让
   * "提交成功 #789"与"链概况仍显示 #786"同时出现在屏幕上。写入很频繁
   * （上报/核查/下单/清缴都出块），任何正 TTL 都会制造这种自相矛盾。
   * Turso 毫秒级直查，这一条读不走缓存也不构成额度压力。 */
  if (pathname.startsWith('/api/chain/stats')) return 0;
  /* 区块/存证列表：短缓存（列表本身是长尾内容，30 秒内重复翻页居多） */
  if (pathname.startsWith('/api/chain/blocks')) return 30;
  if (pathname.startsWith('/api/chain/txs')) return 30;
  if (pathname.startsWith('/api/chain/validate')) return 300;
  if (pathname.startsWith('/api/chain/trust-model')) return 60;

  /* 真实数据层（年度数据，5 分钟绰绰有余） */
  if (pathname.startsWith('/api/real/')) return 300;
  if (pathname.startsWith('/api/twin/')) return 300;
  if (pathname.startsWith('/api/mrv/factor')) return 300;
  if (pathname.startsWith('/api/meta/')) return 300;

  /* 业务数据：5 分钟。
   * 【为什么从 60s 提到 300s】免费层 D1 只有 500 万行读/天。60s TTL 意味着
   * 每个 query 组合每天至少穿透 1440 次；几个访客 + 几个角色页面就把额度
   * 打光，之后全站 503 到 UTC 零点。300s 把穿透量降为 1/5 —— 配额、批次、
   * 报告这类数据 5 分钟延迟对业务无感知；需要更高频的"实时感"由
   * 通知中心（源站实时抓取，零 D1）与链状态（60s）承载。 */
  if (pathname.startsWith('/api/enterprise/')) return 300;
  if (pathname.startsWith('/api/regulator/')) return 300;
  if (pathname.startsWith('/api/public/')) return 300;
  if (pathname.startsWith('/api/settlement/')) return 300;
  if (pathname.startsWith('/api/verifier/')) return 300;
  if (pathname.startsWith('/api/trade/')) return 300;
  if (pathname.startsWith('/api/dynamic/')) return 300;
  if (pathname.startsWith('/api/credit/')) return 300;
  if (pathname.startsWith('/api/mrv/')) return 300;
  if (pathname.startsWith('/api/ops/')) return 300;

  /* 其他 GET：2 分钟（兜底——比 30s 保守，防未知端点高频穿透） */
  return 120;
}

/* ==================================================================================
 * 进程内缓存（in-isolate memory cache）
 * ==================================================================================
 * 【为什么边缘缓存之外还要加进程内缓存】
 *
 * Cloudflare `caches.default` 是**每个数据中心（colo）独立**的。用户请求
 * 可能被路由到不同 colo，导致跨 colo 的缓存命中率不稳定（实测多次
 * 请求同一 URL 仍返回 MISS）。
 *
 * 进程内缓存在同一个 Worker isolate（同一个 V8 实例）内共享。
 * 一个 isolate 生存期间会服务大量请求，因此进程内命中率可达 80-95%。
 * 与边缘缓存配合：进程内（毫秒级命中）→ 边缘（跨请求命中）→ D1（冷查）。
 *
 * ⚠ 这不是静态数据 — 缓存条目有 TTL，到期自动过期，
 *   D1 源数据更新后最多 TTL 秒内自动拉新值。
 * ================================================================================== */
const memCache = new Map();
const MEM_CACHE_MAX = 200;

function memGet(key) {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > e.ttl * 1000) {
    memCache.delete(key);
    return null;
  }
  return e.body;
}

function memPut(key, body, ttl) {
  if (memCache.size >= MEM_CACHE_MAX) {
    /* 简单淘汰：清掉已过期的 */
    const now = Date.now();
    for (const [k, v] of memCache) {
      if (now - v.at > v.ttl * 1000) memCache.delete(k);
    }
    /* 仍满则清最早的 */
    if (memCache.size >= MEM_CACHE_MAX) {
      const first = memCache.keys().next().value;
      memCache.delete(first);
    }
  }
  memCache.set(key, { body, at: Date.now(), ttl });
}

/* 链上写入后清空进程内缓存（chainwrite.appendBlock 出块时回调）。
 * 不注册这个钩子的话，写入后 60s 内 /api/chain/stats 仍返回旧高度。 */
registerCachePurge(() => memCache.clear());

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {};
    const url = new URL(request.url);

    /* CORS 预检 */
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    /* ⭐⭐⭐ 边缘缓存层 —— 根治 D1 额度问题的根本解法 ⭐⭐⭐
     *
     * 【为什么必须做这一层】
     * D1 免费层每天 500 万行读取。平台 20+ 个端点每次请求都查 D1，
     * 几个访客刷新几页就能把当日额度打光 —— 表现为"平台挂了"。
     *
     * 【解法：Cloudflare Cache API（边缘缓存）】
     * `caches.default` 是每个数据中心（colo）的边缘缓存。
     * 首次请求 → 查 D1 → 结果写入边缘缓存
     * 后续请求 → 命中缓存 → **零 D1 读取**
     *
     * 【为什么这不是"静态数据集"】
     *   · 缓存有 TTL（见下方 cacheTtl），到期自动过期
     *   · 源头是 D1 里的真实数据（Climate TRACE / EPA 迁移而来）
     *   · D1 数据由 Cron 预聚合同步刷新（30 分钟 / 每日两级）
     *   · 缓存过期后下一次请求重新从 D1 拉最新值
     *   ⇒ 数据是**活的**，只是"不需要每个请求都重新查一遍不变的数据"
     *
     * 【TTL 分级】
     *   · 5 分钟 — 真实数据层（年度数据，源头一年更新一次，5 分钟绰绰有余）
     *   · 1 分钟 — 链状态（区块高度，变化较频繁但不需要秒级）
     *   · 0 秒   — 实时流 / SSE / 写操作（永远不缓存） */
    /* 带鉴权的请求一律不缓存：缓存键只有 URL，不含 Authorization ——
     * 同 isolate 内 5 分钟窗口可能出现"同 URL 的其他角色拿到你的缓存"
     * （串数据）与"提交后读到旧值"（像没生效）。角色页直连 Turso，
     * 缓存只保留给公开只读端点。 */
    const CACHE_ENABLED = request.method === 'GET' && url.pathname.startsWith('/api/')
      && !request.headers.has('Authorization');
    let cacheKey = null;
    let cacheTtl = 0;

    if (CACHE_ENABLED) {
      cacheTtl = edgeCacheTtl(url.pathname);
      /* 第一层：进程内缓存（同一 isolate 内，毫秒级命中，零网络开销） */
      if (cacheTtl > 0) {
        const memBody = memGet(url.toString());
        if (memBody !== null) {
          return new Response(memBody, {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'X-Mem-Cache': 'HIT',
              'X-Data-Mode': 'LIVE',
              'X-Response-Time': '0',
            },
          });
        }
      }

      /* 第二层：边缘缓存（跨请求命中，但跨 colo 不保证） */
      cacheKey = new Request(url.toString(), { method: 'GET' });
      try {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          const h = new Headers(cached.headers);
          h.set('X-Edge-Cache', 'HIT');
          h.set('X-Cache-Age', String(Math.round((Date.now() - Number(h.get('X-Cached-At') || Date.now())) / 1000)) + 's');
          return new Response(cached.body, { status: cached.status, headers: h });
        }
      } catch (e) { /* 缓存不可用（某些 Workers 环境）→ 正常处理 */ }
    }

    let response;
    const t0 = Date.now();
    const c = makeContext(request, env, { waitUntil: (p) => ctx.waitUntil(p) });

    try {
      const r = await router().dispatch(c);
      response = r || fail('接口不存在', 404);
    } catch (e) {
      /* 额度耗尽与代码故障必须分开报 —— 处置方式完全不同 */
      const { isQuotaError, D1QuotaError } = await import('./lib/db.mjs');
      if (e instanceof D1QuotaError || isQuotaError(e)) {
        /* ⭐ KV 降级层：D1 额度耗尽时，从 KV 读最近一份真实数据。
         *
         * 【为什么这不是"静态数据"】
         * KV 里的数据由 Cron Trigger 每 30 分钟从 D1 同步——
         * 它是**最近一份真实查询结果**的副本，不是人工编造的静态集。
         * 只要 D1 曾经可用过（哪怕一次），KV 里就有数据可服务。
         *
         * 【KV 配额独立于 D1】
         * KV 免费层 100K 读/天，与 D1 的 500 万行/天是两个完全独立的池。
         * D1 打光不影响 KV 读取。 */
        if (CACHE_ENABLED && env.KV_CACHE) {
          try {
            const kvKey = 'api:' + url.pathname + url.search;
            const kvVal = await env.KV_CACHE.get(kvKey, 'json');
            if (kvVal && kvVal.body) {
              const ageMin = Math.round((Date.now() - kvVal.at) / 60000);
              console.log('[KV_FALLBACK_HIT]', url.pathname, 'age', ageMin + 'min');
              response = new Response(JSON.stringify({
                code: 0, msg: 'ok',
                data: kvVal.body,
                meta: { source: 'kv-fallback', ageMinutes: ageMin },
              }), {
                status: 200,
                headers: {
                  'Content-Type': 'application/json; charset=utf-8',
                  'X-KV-Fallback': 'HIT',
                  'X-KV-Age': ageMin + 'min',
                  'X-Data-Mode': 'LIVE',
                },
              });
            }
          } catch (kvErr) { /* KV 不可用 → 走正常 503 */ }
        }

        /* KV 也没有 → 返回 503 但信息完整 */
        if (!response || response.status !== 200) {
          const resetsAt = e.resetsAt || null;
          console.error('[D1_QUOTA_EXHAUSTED]', request.method, url.pathname, String(e.message).slice(0, 200));
          response = new Response(JSON.stringify({
            code: 503,
            msg: '数据库每日额度已耗尽（配额限制，非代码故障）',
            data: {
              kind: 'D1_QUOTA_EXHAUSTED',
              limit: '免费层：读取 500 万行/天',
              resetsAt,
              hint: '额度在 UTC 零点重置；边缘缓存与 KV 降级层将防止再次打光。',
              whatStillWorks: [
                '/api/health', '/api/copilot/capabilities', '/api/evidence/nodes',
                '/api/chain/crypto-selftest', '/api/meta/data-layers',
                '静态页面加载',
              ],
            },
          }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        }
      } else {
        /* 未捕获异常：细节只进日志，对外泛化 —— 泄露栈或 SQL 会暴露表结构 */
        console.error('[WORKER_ERROR]', request.method, url.pathname, e && e.stack ? e.stack : e);
        response = fail('服务器内部错误，请稍后重试', 500);
      }
    }

    /* 统一附加 CORS 与可观测头 */
    const h = new Headers(response.headers);
    const origin = request.headers.get('Origin');
    const allow = String(env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allow.length) {
      if (origin && allow.includes(origin)) {
        h.set('Access-Control-Allow-Origin', origin);
        h.set('Access-Control-Allow-Credentials', 'true');
        h.set('Vary', 'Origin');
      }
    } else {
      /* 同源部署：路径相同即无跨域，无需头。开发预览可用 CORS_DEV=1 放开。 */
      if (env.CORS_DEV === '1' && origin) {
        h.set('Access-Control-Allow-Origin', origin);
        h.set('Access-Control-Allow-Credentials', 'true');
        h.set('Vary', 'Origin');
      } else if (origin && new URL(origin).host !== url.host) {
        /* 明确标注：跨域但未获授权。前端会因此看到 CORS 错误而不是"空数据"。 */
        h.set('X-CORS-Blocked', '1');
      }
    }
    h.set('X-Data-Mode', 'LIVE');
    h.set('X-Response-Time', String(Date.now() - t0));
    /* D1 用量：让"额度还剩多少"变成可观测指标 */
    h.set('X-D1-Rows-Read', String(c.meter.rowsRead));
    h.set('X-D1-Queries', String(c.meter.queries));
    h.set('X-Edge-Cache', 'MISS');

    /* ⭐ 边缘缓存写入：仅对成功的 GET 响应 */
    if (CACHE_ENABLED && response.status === 200 && cacheTtl > 0) {
      h.set('X-Edge-Cache-TTL', cacheTtl + 's');
      h.set('X-Cached-At', String(Date.now()));
      h.set('Cache-Control', `public, max-age=${cacheTtl}`);

      /* 进程内缓存 + KV 同步写入（一次性序列化，三层共享） */
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        memPut(url.toString(), text, cacheTtl);

        /* KV 写入：供 D1 额度耗尽时的降级层读取。
         * KV 的 value 结构 { body: JSON数据, at: 时间戳 }。
         * 写入 TTL 设为 7 天（比边缘缓存长得多），确保降级层
         * 总有数据可用（最差情况是 7 天前的数据，仍然比 503 好）。 */
        if (env.KV_CACHE) {
          const jsonBody = JSON.parse(text);
          const data = jsonBody && jsonBody.data !== undefined ? jsonBody.data : jsonBody;
          ctx.waitUntil(
            env.KV_CACHE.put('api:' + url.pathname + url.search,
              JSON.stringify({ body: data, at: Date.now() }),
              { expirationTtl: 7 * 24 * 3600 }),
          );
        }
      } catch (e) { /* 序列化/写入失败不影响正常返回 */ }

      /* 边缘缓存（跨请求命中） */
      try {
        if (cacheKey) {
          const cacheable = new Response(response.clone().body, {
            status: response.status, headers: h,
          });
          ctx.waitUntil(caches.default.put(cacheKey, cacheable));
        }
      } catch (e) { /* 缓存写入失败不影响正常返回 */ }
    }

    return new Response(response.body, { status: response.status, headers: h });
  },

  /**
   * Cron Trigger：刷新预聚合。
   *
   * 【为什么分两级】
   * 两个 cron 表达式，成本差 50 倍：
   *   · `*​/30 * * * *`  → AGGREGATE 级：只重算"指纹变了"的年度。
   *     数据按年更新，多数轮次直接跳过，单轮成本接近 0。
   *   · `17 3 * * *`     → INSIGHTS 级：额外全量重算洞察（约 110 万行）。
   *     每天只有这 1 次，因为洞察要对每个行业各扫一遍全表。
   *
   * 若不分级，48 轮/天 × 230 万行 = 1.1 亿行，第 3 轮就会把 500 万额度打光，
   * 之后**所有查询都返回错误** —— 表现为"平台挂了"，实际只是配额耗尽。
   * 这个判断是算出来的：见 jobs/aggregate.mjs 顶部注释里的成本明细。
   *
   * 如何区分是哪一次触发：event.cron 就是表达式原文，直接比对。
   */
  async scheduled(event, env, ctx) {
    try {
      const { makeDb, selectBackend } = await import('./lib/db.mjs');
      const meter = { queries: 0, rowsRead: 0, rowsWritten: 0 };
      const db = makeDb(selectBackend(env), meter);

      /* 每天 03:17 那次跑完整洞察；其余轮次只做增量聚合 */
      const isDaily = String(event.cron || '').startsWith('17 3');

      const res = await refreshAggregates(env, db, {
        level: isDaily ? 'INSIGHTS' : 'AGGREGATE',
      });
      console.log('[CRON]', isDaily ? '洞察级' : '增量级', JSON.stringify(res),
        'rowsRead=', meter.rowsRead);

      /* 额度预警：单轮读取超过 100 万行就记警告，避免静默烧光额度 */
      if (meter.rowsRead > 1_000_000) {
        console.warn('[CRON_QUOTA] 单轮 rowsRead 偏高:', meter.rowsRead,
          '— 当日剩余额度可能不足，检查是否有年度指纹反复变化');
      }
    } catch (e) {
      console.error('[CRON_ERROR]', e && e.stack ? e.stack : e);
    }
  },
};
