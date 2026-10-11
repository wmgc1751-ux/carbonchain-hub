/**
 * middleware/structured-log.js —— 结构化日志（JSON）+ 环形缓冲查询
 * ------------------------------------------------------------------
 * 生产级日志聚合的基础设施：
 *   · 所有日志以 JSON 单行格式输出（便于 ELK/Loki 采集）
 *   · 内存环形缓冲最近 1000 条，提供 /api/ops/logs 查询接口
 *   · 按级别（debug/info/warn/error）+ 时间 + 关键字过滤
 *   · 请求日志中间件：自动记录 method/path/status/duration/ip
 *
 * 零依赖：纯 Node 实现，不引入 winston/pino。
 */
'use strict';

const RING_CAP = 1000;
const ring = [];
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function log(level, message, meta) {
  const lvl = LEVELS[level] ? level : 'info';
  const entry = {
    ts: new Date().toISOString(),
    level: lvl,
    message,
    ...((meta && typeof meta === 'object') ? meta : {}),
  };
  ring.push(entry);
  if (ring.length > RING_CAP) ring.shift();
  // 同时输出到 stdout（便于容器日志采集）
  const out = JSON.stringify(entry);
  if (lvl === 'error') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

function info(msg, meta) { log('info', msg, meta); }
function warn(msg, meta) { log('warn', msg, meta); }
function error(msg, meta) { log('error', msg, meta); }
function debug(msg, meta) { log('debug', msg, meta); }

/** 查询日志：按 level / since / until / q / limit 过滤 */
function query(opts) {
  const o = opts || {};
  const minLevel = LEVELS[o.level] || 0;
  const since = o.since ? new Date(o.since).getTime() : 0;
  const until = o.until ? new Date(o.until).getTime() : Date.now();
  const q = (o.q || '').toLowerCase();
  const limit = Math.min(o.limit || 100, 500);
  const out = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ring[i];
    if (LEVELS[e.level] < minLevel) continue;
    const t = new Date(e.ts).getTime();
    if (t < since || t > until) continue;
    if (q && !JSON.stringify(e).toLowerCase().includes(q)) continue;
    out.push(e);
  }
  return out;
}

/* 请求日志中间件 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    const normPath = req.path.replace(/\d+/g, ':id').split('?')[0];
    log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      `${req.method} ${normPath} ${res.statusCode} ${dur}ms`, {
        method: req.method,
        path: normPath,
        status: res.statusCode,
        durationMs: dur,
        ip: req.ip || req.connection.remoteIpAddress || '-',
        ua: (req.headers['user-agent'] || '').slice(0, 80),
      });
  });
  next();
}

module.exports = { log, info, warn, error, debug, query, requestLogger, ring: () => ring.slice() };
