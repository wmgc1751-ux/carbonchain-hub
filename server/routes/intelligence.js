/**
 * routes/intelligence.js —— 多智能体预测预警 + 数字孪生 API
 *   · 企业端：预警中心（E6）—— 预测曲线 / 超限预警 / 减排建议
 *   · 监管端：异常监控（G4）—— 全市场异常扫描
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, ok, fail, wrap } = require('../middleware/auth');
const intel = require('../services/intelligence');

const router = express.Router();

/** 企业自身 id（企业端）/ 指定企业（监管端） */
function entOf(req) {
  if (req.user.role === 'ENTERPRISE' || req.user.role === 'TRADER') return req.user.orgId;
  return req.query.entId ? Number(req.query.entId) : null;
}

/* 全量预测报告（四智能体） ------------------------------------------ */
router.get('/report', authRequired, wrap(async (req, res) => {
  const entId = entOf(req);
  if (!entId) return fail(res, '请指定企业', 400);
  ok(res, await intel.fullReport(entId));
}));

/* 用量预测 ----------------------------------------------------------- */
router.get('/forecast', authRequired, wrap(async (req, res) => {
  const entId = entOf(req);
  if (!entId) return fail(res, '请指定企业', 400);
  ok(res, await intel.forecast(entId, req.query.days ? Number(req.query.days) : 30));
}));

/* 超限预警 ----------------------------------------------------------- */
router.get('/over-quota', authRequired, wrap(async (req, res) => {
  const entId = entOf(req);
  if (!entId) return fail(res, '请指定企业', 400);
  ok(res, await intel.overQuotaRisk(entId));
}));

/* 异常检测 ----------------------------------------------------------- */
router.get('/anomaly', authRequired, wrap(async (req, res) => {
  const entId = entOf(req);
  if (!entId) return fail(res, '请指定企业', 400);
  ok(res, await intel.anomalyDetect(entId));
}));

/* 减排建议 ----------------------------------------------------------- */
router.get('/advisor', authRequired, wrap(async (req, res) => {
  const entId = entOf(req);
  if (!entId) return fail(res, '请指定企业', 400);
  ok(res, await intel.advisor(entId));
}));

/* 数字孪生情景模拟 --------------------------------------------------- */
router.post('/simulate', authRequired, wrap(async (req, res) => {
  const entId = entOf(req);
  if (!entId) return fail(res, '请指定企业', 400);
  const { scenarios } = req.body || {};
  if (!Array.isArray(scenarios) || !scenarios.length) return fail(res, '请至少提供一个情景', 400);
  ok(res, await intel.simulate(entId, scenarios));
}));

/* 全市场异常扫描（监管端） ------------------------------------------ */
router.get('/market-scan', authRequired, requireRole('REGULATOR'), wrap(async (req, res) => {
  ok(res, await intel.marketScan());
}));

module.exports = router;
