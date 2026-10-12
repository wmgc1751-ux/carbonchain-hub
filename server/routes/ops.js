/**
 * routes/ops.js —— 生产运维接口（监控 / 告警 / 日志 / 灰度 / 深度健康）
 * ------------------------------------------------------------------
 * 给运维团队和 Prometheus/Grafana 用的"生产加固"接口集合：
 *   GET  /api/ops/metrics   Prometheus 文本格式指标（可被 prometheus 抓取）
 *   GET  /api/ops/stats      JSON 统计（QPS/P50/P95/P99/错误率）
 *   GET  /api/ops/alerts     告警事件流
 *   GET  /api/ops/logs       结构化日志查询（?level=&since=&q=&limit=）
 *   GET  /api/ops/canary     灰度状态
 *   POST /api/ops/canary     切换灰度功能开关（管理员）
 *   GET  /api/ops/health     深度健康检查（链/DB/内存/uptime）
 *
 * 审计日志哈希链（WP6 工程品质 · 操作事实防篡改）
 *   GET  /api/ops/audit-chain              链状态概览（条目/已封印/链首链尾/按模块分布）
 *   GET  /api/ops/audit-chain/verify       全链复算校验（?sample=N 仅抽查最后 N 条）
 *   POST /api/ops/audit-chain/seal         封印历史未封印条目（管理员）
 *   GET  /api/ops/audit-chain/entry/:id    单条条目可核验明细（含复算哈希）
 */
'use strict';

const express = require('express');
const monitor = require('../middleware/monitor');
const slog = require('../middleware/structured-log');
const canary = require('../middleware/canary');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

/* 运维接口整体需要监管/管理角色 —— 指标、日志、告警、灰度均含内部运行信息，
 * 一律不得匿名可读（前端 /ops 页亦仅对 REGULATOR/ADMIN 开放）。 */
router.use(authRequired, requireRole('REGULATOR'));

/* Prometheus 指标（text/plain，version=0.0.4） */
router.get('/metrics', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(monitor.prometheus());
});

/* JSON 统计快照 */
router.get('/stats', (req, res) => {
  ok(res, {
    ...monitor.stats(),
    uptime: Math.floor(process.uptime()),
    memoryMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
    nodeVersion: process.version,
    timestamp: Date.now(),
  });
});

/* 告警事件流 */
router.get('/alerts', (req, res) => {
  ok(res, { alerts: monitor.alerts(), rules: monitor.RULES });
});

/* 结构化日志查询 */
router.get('/logs', (req, res) => {
  const { level, since, until, q, limit } = req.query;
  ok(res, { entries: slog.query({ level, since, until, q, limit }), total: slog.ring().length });
});

/* 灰度状态 */
router.get('/canary', (req, res) => {
  ok(res, canary.status());
});

/* 切换灰度功能开关（仅管理员） */
router.post('/canary', authRequired, (req, res) => {
  if (req.user.role !== 'ADMIN') return fail(res, '仅管理员可切换灰度开关', 403);
  const { feature, enabled } = req.body || {};
  if (!feature) return fail(res, '缺少 feature 参数', 400);
  const r = canary.toggle(feature, enabled);
  if (!r.ok) return fail(res, r.reason, 404);
  ok(res, r, `灰度开关 ${feature} 已${r.enabled ? '开启' : '关闭'}`);
});

/* 深度健康检查：链 / DB / 内存 / uptime 全量诊断 */
router.get('/health', async (req, res) => {
  const checks = {};
  // 进程
  checks.process = { ok: true, uptime: Math.floor(process.uptime()), memoryMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1), node: process.version };
  // 链（异步）
  try {
    const { getChain } = require('../services/anchor');
    const chain = await getChain();
    const stats = await chain.stats();
    checks.chain = { ok: true, height: stats.height, totalBlocks: stats.totalBlocks, consensus: stats.consensusMode || 'POA' };
  } catch (e) { checks.chain = { ok: false, error: e.message }; }
  // DB
  try {
    const db = require('../db');
    const r = await db.one('SELECT 1 AS ok');
    checks.db = { ok: !!r, };
  } catch (e) { checks.db = { ok: false, error: e.message }; }
  // 监控指标（非关键检查项，不影响整体健康判定）
  checks.metrics = { ok: true, ...monitor.stats() };
  const allOk = ['process', 'chain', 'db'].every((k) => checks[k] && checks[k].ok);
  res.status(allOk ? 200 : 503).json({ code: allOk ? 0 : 1, data: checks });
});

/* ==================================================================
 * 审计日志哈希链（WP6）
 * ------------------------------------------------------------------
 * 需求来源：链上的业务事实再可信，操作它的人如果不留痕，"可信"也只是半截。
 * 这里把 audit_log 从"可被静默 UPDATE 的普通表"升级为哈希链，并暴露
 * 校验接口 —— 任何改动都能被独立复算抓出来。
 * ================================================================== */

/* 链状态概览 */
router.get('/audit-chain', wrap(async (req, res) => {
  const auditChain = require('../services/auditChain');
  ok(res, await auditChain.stats());
}));

/* 全链复算校验（sample=0/省略 为全量） */
router.get('/audit-chain/verify', wrap(async (req, res) => {
  const auditChain = require('../services/auditChain');
  const r = await auditChain.verify({ sample: Number(req.query.sample) || 0 });
  /* 校验失败不是"接口错误"，而是"发现异常" —— 用 200 返回，让调用方读到明细；
     仅当调用方主动要求 ?strict=1 时才以 4xx 表达失败，便于脚本 exit code 判断。 */
  if (!r.valid && String(req.query.strict || '') === '1') {
    return res.status(409).json({ code: 409, message: '审计链校验未通过，存在被篡改或未封印条目', data: r });
  }
  ok(res, r, r.valid ? '审计链完整，未发现篡改' : `审计链发现 ${r.errors.length} 处异常`);
}));

/* 封印历史未封印条目（仅管理员） */
router.post('/audit-chain/seal', wrap(async (req, res) => {
  if (req.user.role !== 'ADMIN') return fail(res, '仅管理员可执行审计链封印', 403);
  const auditChain = require('../services/auditChain');
  const r = await auditChain.seal({ limit: Number((req.body || {}).limit) || 2000 });
  /* 封印本身也是一次"操作事实"，记一笔（它会被追加到刚封印的链尾之后） */
  writeLog(req, '运维', '封印审计链', `sealed=${r.sealed}`, `剩余未封印 ${r.remaining} 条`).catch(() => {});
  ok(res, r, r.sealed ? `已封印 ${r.sealed} 条` : '无待封印条目（幂等）');
}));

/* 单条条目可核验明细 */
router.get('/audit-chain/entry/:id', wrap(async (req, res) => {
  const auditChain = require('../services/auditChain');
  const r = await auditChain.entry(req.params.id);
  if (!r) return fail(res, `审计条目 #${req.params.id} 不存在`, 404);
  ok(res, r);
}));

module.exports = router;
