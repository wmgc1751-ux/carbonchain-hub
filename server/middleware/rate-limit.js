/**
 * rate-limit.js —— 轻量内存限流中间件（生产防暴力破解 / 防刷）
 * ------------------------------------------------------------------
 * 说明：单进程内存计数，配合联盟链"准入 + 审计"已足够课程/内网场景；
 * 多副本部署时应替换为 Redis 等共享存储（接口保持不变）。
 */
'use strict';

function rateLimit({ windowMs = 60 * 1000, max = 10, keyFn, message } = {}) {
  const hits = new Map();
  // 周期性清理过期计数，避免内存无限增长
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }, windowMs);
  if (sweeper.unref) sweeper.unref();

  return function limiter(req, res, next) {
    const key = keyFn ? keyFn(req) : (req.ip || 'unknown');
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || now > rec.reset) { rec = { count: 0, reset: now + windowMs }; hits.set(key, rec); }
    rec.count++;
    const remain = Math.max(0, max - rec.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remain));
    if (rec.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((rec.reset - now) / 1000)));
      return res.status(429).json({ code: 429, message: message || '操作过于频繁，请稍后再试' });
    }
    next();
  };
}

module.exports = { rateLimit };
