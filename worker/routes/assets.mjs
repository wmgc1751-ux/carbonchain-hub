/**
 * worker/routes/assets.mjs —— 静态资源（由 ASSETS 绑定提供）
 * ==================================================================================
 * Cloudflare 的 assets 绑定已经能直接返回静态文件，本模块只处理两件事：
 *
 *   ① **SPA 兜底**：非 /api 的任意路径都返回 index.html（前端是 hash 路由，
 *      但直接访问 /real/cn 这类路径时不应 404）。
 *   ② **缓存策略**：HTML 必须 no-cache（否则用户会一直拿到旧版 JS 引用），
 *      带 hash 的静态资源可以长缓存。
 *
 * ⚠ 一个真实的坑：如果 HTML 被缓存，用户点开页面时拿到的 index.html 引用了
 * 旧版 app.js，而旧版 app.js 请求的接口可能已被新后端移除 —— 表现为
 * "页面能开但数据全空"，且刷新一次就好（因为这次拿到了新 HTML）。
 * 这类"刷新就好"的故障最难被报告，也最难复现。因此 HTML 一律 no-cache。
 *
 * @module worker/routes/assets
 */

export function attachAssetRoutes(r) {
  /* 静态资源由 index.mjs 的兜底路由交给 env.ASSETS.fetch() 处理，
   * 这里只注册一个可观测的探测端点，便于运维确认 assets 是否绑定成功。 */
  r.get('/api/meta/assets', async (ctx) => {
    const ok = !!(ctx.env.ASSETS && typeof ctx.env.ASSETS.fetch === 'function');
    return new Response(JSON.stringify({
      code: 0, msg: 'ok',
      data: {
        bound: ok,
        note: ok
          ? '静态资源由 Cloudflare Assets 提供；/api/* 由 Worker 实时处理。'
          : '未绑定 ASSETS。请在 wrangler.json 配置 assets.directory = "./public"。',
        dataMode: 'LIVE',
      },
      meta: null,
    }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  });
}
