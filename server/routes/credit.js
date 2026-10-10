/**
 * routes/credit.js —— 碳信用资产与抵销 API
 * 全市场碳资产总览 / 企业碳信用资产 / 抵销额度与缺口 / 抵销流水 / 发起抵销
 *
 * 读接口：全市场总览公开，企业明细需登录（企业端仅见本企业）。
 * 写接口：碳信用抵销仅企业端可发起。
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const credit = require('../services/credit');

const router = express.Router();

/* 全市场碳资产总览（公开） ------------------------------------------- */
router.get('/summary', wrap(async (req, res) => {
  ok(res, await credit.summary());
}));

/* 碳信用资产列表 ----------------------------------------------------- */
router.get('/assets', authRequired, wrap(async (req, res) => {
  const entId = req.user.role === 'ENTERPRISE' ? req.user.orgId : (req.query.entId ? Number(req.query.entId) : null);
  ok(res, await credit.listAssets(entId));
}));

/* 抵销额度与缺口情况 ------------------------------------------------- */
router.get('/status', authRequired, wrap(async (req, res) => {
  const entId = req.user.role === 'ENTERPRISE' ? req.user.orgId : (req.query.entId ? Number(req.query.entId) : null);
  if (!entId) return fail(res, '请指定企业', 400);
  ok(res, await credit.offsetStatus(entId, req.query.year ? Number(req.query.year) : undefined));
}));

/* 抵销流水 ----------------------------------------------------------- */
router.get('/offsets', authRequired, wrap(async (req, res) => {
  const entId = req.user.role === 'ENTERPRISE' ? req.user.orgId : (req.query.entId ? Number(req.query.entId) : null);
  ok(res, await credit.listOffsets(entId, req.query.limit));
}));

/* 发起碳信用抵销（企业端） ------------------------------------------- */
router.post('/offset', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const { assetId, amount, year } = req.body || {};
  let r;
  try {
    r = await credit.applyOffset({
      entId: req.user.orgId,
      assetId: Number(assetId),
      amount,
      year,
      operator: req.user.realName || req.user.username,
    });
  } catch (e) {
    return fail(res, e.message, 400);
  }
  await writeLog(req, '碳资产', '碳信用抵销', r.offsetNo,
    `用 ${r.assetType} 抵销 ${r.amount} tCO2e，预计缺口 ${r.quotaBefore} → ${r.quotaAfter} tCO2e`, 'SUCCESS');
  ok(res, r, `已用碳信用抵销 ${r.amount} tCO₂e，预计配额缺口降至 ${r.quotaAfter} tCO₂e，抵销流水已上链存证`);
}));

module.exports = router;
