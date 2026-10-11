/**
 * middleware/monitor.js —— 生产级监控指标收集 + 告警引擎
 * ------------------------------------------------------------------
 * 提供 Prometheus 兼容的指标输出与阈值告警：
 *   · http_requests_total{method,path,status}  请求计数
 *   · http_request_duration_seconds 请求延迟直方图（P50/P95/P99）
 *   · chain_height_gauge / db_pool_active_gauge  业务指标
 *   · alerts  告警事件流（按规则触发，去重入缓冲）
 *
 * 零依赖：用 Node 原生 crypto + 手写直方图，不引入 prom-client。
 */
'use strict';

const crypto = require('crypto');

/* 指标存储 */
const httpRequests = new Map();          // key: `${method}|${path}|${status}` → count
const httpDuration = [];                // 最近 1000 个延迟（毫秒）
const DURATION_CAP = 1000;
const alerts = [];                       // 告警事件（最近 200 条）
const ALERT_CAP = 200;
const alertDedup = new Map();            // 去重 key → 上次触发时间

/* 阈值规则（可调） */
const RULES = [
  { key: 'p95_high', field: 'p95', op: '>', threshold: 2000, severity: 'WARN', msg: 'P95 延迟超 2 秒' },
  { key: 'p99_critical', field: 'p99', op: '>', threshold: 5000, severity: 'CRIT', msg: 'P99 延迟超 5 秒' },
  { key: 'error_rate', field: 'errorRate', op: '>', threshold: 5, severity: 'CRIT', msg: '错误率超 5%' },
];

function recordRequest(method, path, status, durationMs) {
  const normPath = path.replace(/\d+/g, ':id').split('?')[0].slice(0, 60);
  const key = `${method}|${normPath}|${status}`;
  httpRequests.set(key, (httpRequests.get(key) || 0) + 1);
  httpDuration.push(durationMs);
  if (httpDuration.length > DURATION_CAP) httpDuration.shift();
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] || 0;
}

function stats() {
  const total = httpDuration.length;
  const p50 = percentile(httpDuration, 50);
  const p95 = percentile(httpDuration, 95);
  const p99 = percentile(httpDuration, 99);
  const avg = total ? httpDuration.reduce((a, b) => a + b, 0) / total : 0;
  let errCount = 0, reqCount = 0;
  for (const [k, v] of httpRequests.entries()) {
    reqCount += v;
    if (k.endsWith('|500') || k.endsWith('|502') || k.endsWith('|503') || k.endsWith('|504')) errCount += v;
  }
  return {
    totalRequests: reqCount,
    errorCount: errCount,
    errorRate: reqCount ? +(errCount / reqCount * 100).toFixed(2) : 0,
    p50: +p50.toFixed(1),
    p95: +p95.toFixed(1),
    p99: +p99.toFixed(1),
    avg: +avg.toFixed(1),
    samples: total,
    qps: total ? +(total / (process.uptime() || 1)).toFixed(2) : 0,
  };
}

function pushAlert(rule, value) {
  const now = Date.now();
  const last = alertDedup.get(rule.key);
  if (last && now - last < 60000) return;  // 同规则 60 秒内去重
  alertDedup.set(rule.key, now);
  const evt = {
    id: crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    severity: rule.severity,
    rule: rule.key,
    message: rule.msg,
    value: +value.toFixed(1),
    threshold: rule.threshold,
  };
  alerts.unshift(evt);
  if (alerts.length > ALERT_CAP) alerts.pop();
  // 同时写结构化日志
  try { require('./structured-log').log(rule.severity === 'CRIT' ? 'error' : 'warn', '告警触发: ' + rule.msg, evt); }
  catch (e) {}
}

function checkAlerts() {
  const s = stats();
  RULES.forEach((r) => {
    const v = r.field === 'p95' ? s.p95 : r.field === 'p99' ? s.p99 : r.field === 'errorRate' ? s.errorRate : 0;
    if (r.op === '>' && v > r.threshold) pushAlert(r, v);
  });
  return alerts.slice(0, 50);
}

/* Prometheus 文本格式输出 */
function prometheus() {
  const s = stats();
  const lines = [];
  lines.push('# HELP http_requests_total Total HTTP requests by method/path/status');
  lines.push('# TYPE http_requests_total counter');
  for (const [k, v] of httpRequests.entries()) {
    const [method, path, status] = k.split('|');
    lines.push(`http_requests_total{method="${method}",path="${path}",status="${status}"} ${v}`);
  }
  lines.push('# HELP http_request_duration_ms Request duration percentiles');
  lines.push('# TYPE http_request_duration_ms gauge');
  lines.push(`http_request_duration_ms{quantile="0.5"} ${s.p50}`);
  lines.push(`http_request_duration_ms{quantile="0.95"} ${s.p95}`);
  lines.push(`http_request_duration_ms{quantile="0.99"} ${s.p99}`);
  lines.push(`http_request_duration_ms{quantile="avg"} ${s.avg}`);
  lines.push('# HELP http_error_rate_percent Current error rate');
  lines.push('# TYPE http_error_rate_percent gauge');
  lines.push(`http_error_rate_percent ${s.errorRate}`);
  lines.push('# HELP http_qps Queries per second (avg since boot)');
  lines.push('# TYPE http_qps gauge');
  lines.push(`http_qps ${s.qps}`);
  lines.push('# HELP process_uptime_seconds Process uptime');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${process.uptime().toFixed(0)}`);
  return lines.join('\n');
}

/* 中间件：记录每个请求的耗时与状态码 */
function middleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    recordRequest(req.method, req.path, res.statusCode, dur);
  });
  next();
}

/* 每 30 秒检查一次告警 */
setInterval(() => { try { checkAlerts(); } catch (e) {} }, 30000);

module.exports = {
  middleware,
  recordRequest,
  stats,
  prometheus,
  checkAlerts,
  alerts: () => alerts.slice(0, 50),
  RULES,
};
