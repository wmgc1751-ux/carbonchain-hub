/**
 * functions/api/[[path]].js —— Pages Functions 入口（捕获所有 /api/* 请求）
 * ==================================================================================
 * 【为什么需要这个文件】
 *
 * Worker 已部署到 carbonchain-hub.wmgc1751.workers.dev 并运行正常，
 * 但在本项目的目标网络环境下 **workers.dev 域名不可达**（实测 3/3 超时），
 * 而碳链通小程序/平台一直使用的 **pages.dev 与 dpdns.org 域名可达**。
 *
 * 这不是部署问题，是网络层的域名可达性差异。解决方案不是换域名，
 * 而是让同一份 Worker 代码同时挂在 Pages 上 —— Pages Functions
 * 与 Worker 共享同一套运行时、同一套绑定（D1 / ASSETS）。
 *
 * 【为什么复用而不是重写】
 * 如果把 API 逻辑复制一份到 functions/，两份实现必然漂移：
 * 改了一边忘了另一边，线上表现是"某些端点行为不一致"，且不报错。
 * 因此这里只做**适配层**：
 *   · 把 Pages Functions 的 context 转成 worker/index.mjs 认识的 (request, env, ctx)
 *   · 其余全部委托给 worker/index.mjs 的默认导出
 *
 * 这样唯一的真相仍是 worker/index.mjs 与 worker/routes/*。
 *
 * ⚠ Pages Functions 的 env 里，D1 绑定的名字取决于 Pages 项目的
 *   Settings → Functions → D1 database bindings 配置。本文件兼容两种常见命名
 *   （DB / carbonchain_platform），并在都缺失时给出明确提示，
 *   而不是抛一个看不懂的 TypeError。
 *
 * @module functions/api/[[path]]
 */

import worker from '../../worker/index.mjs';

export async function onRequest(context) {
  const { request, env, next, params } = context;

  /* D1 绑定归一化：Pages 的绑定名可能与 wrangler.json 里的不同 */
  const db = env.DB || env.carbonchain_platform || env.carbonchain_platform_db || null;
  if (!db) {
    return new Response(JSON.stringify({
      code: 500,
      msg: 'Pages Functions 未绑定 D1 数据库。'
        + '请在 Cloudflare 控制台 → Pages → 项目 → Settings → Functions → '
        + 'D1 database bindings 添加绑定（Variable name 建议填 DB），或改用 Worker 部署。',
      data: null,
    }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }

  /* 构造一个与 Worker 一致的 env：补齐绑定名，并给出 waitUntil */
  const workerEnv = {
    ...env,
    DB: db,
    /* 演示账号开关交给 worker/routes/auth.mjs 判断（默认开放）。
     * 此处不再改写 DEMO_ACCOUNTS —— 曾经在这里做"环境变量兜底"，
     * 反而让 Pages 侧的旧 env 快照覆盖了代码里的默认值，排查成本很高。
     * 只用 DELETE 语义：把 env 里的字符串原样传下去即可。 */
    /* 静态资源：Pages 自己处理静态文件，Functions 只接管 /api/*，
     * 因此这里不需要 ASSETS 绑定；若代码走到静态兜底分支，返回 404 更符合语义。 */
    ASSETS: env.ASSETS || null,
  };

  /* Pages Functions 的 context 有 waitUntil，但没有 ctx 对象；
   * worker/index.mjs 期望 ctx.waitUntil 存在。 */
  const ctxShim = {
    waitUntil: (p) => {
      try { context.waitUntil(p); } catch { /* 非关键任务 */ }
    },
    passThroughOnException: () => {
      try { context.passThroughOnException(); } catch { /* ignore */ }
    },
  };

  return worker.fetch(request, workerEnv, ctxShim);
}
