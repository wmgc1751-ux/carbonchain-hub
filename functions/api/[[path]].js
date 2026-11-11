/**
 * functions/api/[[path]].js —— Pages Functions 入口（捕获所有 /api/* 请求）
 * ==================================================================================
 * 【2026-11-01 重大口径变更：D1 数据面 → ECS 权威链全量代理】
 *
 * 此前本文件把 /api/* 委托给 worker/index.mjs 读 D1。D1 里是一份**早期演示
 * 快照**（833 块 / 102 家企业 / 21 个演示账号），与权威链（ECS MySQL，
 * 2187 块 / 67 家 / 8 个演示账号）长期漂移 —— 用户实测「线上线下内容完全
 * 不一样、演示账号一键登录直接失败」，根因即此。
 *
 * 修复：本文件改为**纯反向代理**，把 /api/* 原样转发到 ECS 权威链。
 *   · 数据、账号、链高度、JWT 与 ECS / 本地平台完全同源（一 token 三端通用）；
 *   · D1 保留作历史存档，不再参与任何请求路径；
 *   · 权威链地址由环境变量 AUTHORITY_ORIGIN 覆盖，缺省为 ECS 公网入口。
 *
 * @module functions/api/[[path]]
 */

/* ⚠ 不能用裸 IP：Cloudflare 边缘会拦截 Worker 发往 IP 形态 Host 的请求
 *（error 1003 Direct IP access not allowed）。sslip.io 泛域名解析到同一
 * ECS 公网 IP，nginx 以 default server 接住，行为与直连 IP 完全一致。 */
const DEFAULT_ORIGIN = 'http://47.86.28.202.sslip.io';

export async function onRequest(context) {
  const { request, env, params } = context;

  const origin = String(env && env.AUTHORITY_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
  const subpath = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  const target = `${origin}/api/${subpath}${new URL(request.url).search}`;

  /* 逐跳头不转发；Host 由 fetch 按目标重写 */
  const HOP = new Set(['host', 'connection', 'cf-connecting-ip', 'cf-ray', 'cf-visitor',
    'cf-ipcountry', 'cf-worker', 'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
    'accept-encoding', 'content-length']);
  const headers = new Headers();
  request.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) headers.set(k, v); });

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstream = await fetch(target, init);
    const resHeaders = new Headers();
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === 'transfer-encoding' || lk === 'connection' || lk === 'content-encoding') return;
      resHeaders.set(k, v);
    });
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch (e) {
    return new Response(JSON.stringify({
      code: 502, message: '权威链不可达（' + origin + '）：' + (e && e.message || e), data: null,
    }), { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
}
