/**
 * middleware/canary.js —— 灰度发布路由（基于 header/query 的功能开关）
 * ------------------------------------------------------------------
 * 生产级灰度发布的轻量实现：
 *   · 携带 `?canary=1` query 或 `X-Canary: true` header 的请求标记为灰度
 *   · 全局功能开关表（feature flags），管理员通过 /api/ops/canary 切换
 *   · 灰度请求路由到实验性逻辑（req.canary=true），稳定请求走主路径
 *
 * 真实生产通常配合 Istio/Envoy 流量切分，本实现是应用层兜底方案。
 */
'use strict';

const flags = {
  // 功能开关表（默认全部关闭，按需开启）
  'realtime_push': { enabled: true, desc: 'WebSocket 实时推送（已稳定上线）', since: '2026-10-11' },
  'gm_crypto_browser': { enabled: true, desc: '浏览器侧国密 SM3（已稳定上线）', since: '2026-10-11' },
  'merkle_rpc_verify': { enabled: true, desc: '真实链上 RPC 默克尔验真', since: '2026-10-11' },
  'factor_dynamic_switch': { enabled: true, desc: '因子动态切换', since: '2026-10-11' },
  'cluster_load_test': { enabled: false, desc: '集群压测模式（关闭正常限流，仅供压测）', since: '2026-10-11' },
  'canary_new_dashboard': { enabled: false, desc: '新版看板（灰度中，仅 canary 请求可见）', since: '2026-10-11' },
};

function middleware(req, res, next) {
  const viaQuery = req.query && (req.query.canary === '1' || req.query.canary === 'true');
  const viaHeader = req.headers['x-canary'] === 'true' || req.headers['x-canary'] === '1';
  req.canary = !!(viaQuery || viaHeader);
  if (req.canary) {
    res.setHeader('X-Canary', 'true');
    res.setHeader('X-Canary-Features', Object.entries(flags).filter(([, f]) => f.enabled).map(([k]) => k).join(','));
  }
  next();
}

function status() {
  return {
    canaryRatio: 0.1,  // 模拟 10% 灰度流量（真实由 Istio 切分）
    features: flags,
    canaryHeader: 'X-Canary: true',
    canaryQuery: '?canary=1',
  };
}

function toggle(feature, enabled) {
  if (!flags[feature]) return { ok: false, reason: 'feature not found' };
  flags[feature].enabled = !!enabled;
  try { require('./structured-log').info('灰度开关切换', { feature, enabled: flags[feature].enabled }); } catch (e) {}
  return { ok: true, feature, enabled: flags[feature].enabled };
}

function isEnabled(feature) {
  return !!(flags[feature] && flags[feature].enabled);
}

module.exports = { middleware, status, toggle, isEnabled, flags };
