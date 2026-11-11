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
  /* 【2026-11-03】越权修复：原来非企业角色不传 entId 就返回**全平台**碳信用资产。
   * 实测 ver_cz_review（核查机构）与 trader01（交易代理）都能拉到
   * 沈阳镁业、芜湖有色金属等全部企业的资产明细 —— 碳信用属于企业碳资产隐私。
   *
   * 现在的可见范围：
   *   ENTERPRISE        → 强制本企业
   *   REGULATOR / ADMIN → 全平台（监管必需），可用 ?entId= 收窄
   *   VERIFIER / TRADER → 必须显式 ?entId=；未指定则返回空列表并说明原因。 */
  const role = req.user.role;
  const explicit = req.query.entId ? Number(req.query.entId) : null;

  if (role === 'ENTERPRISE') return ok(res, await credit.listAssets(req.user.orgId));
  if (role === 'REGULATOR' || role === 'ADMIN') return ok(res, await credit.listAssets(explicit));

  if (!explicit) {
    return ok(res, [], '请指定企业后查看碳信用资产（本角色不具备全平台查看权限）');
  }
  return ok(res, await credit.listAssets(explicit));
}));

/* 抵销额度与缺口情况 ------------------------------------------------- */
router.get('/status', authRequired, wrap(async (req, res) => {
  const entId = req.user.role === 'ENTERPRISE' ? req.user.orgId : (req.query.entId ? Number(req.query.entId) : null);
  if (!entId) return fail(res, '请指定企业', 400);
  ok(res, await credit.offsetStatus(entId, req.query.year ? Number(req.query.year) : undefined));
}));

/* 抵销流水 ----------------------------------------------------------- */
router.get('/offsets', authRequired, wrap(async (req, res) => {
  /* 与 /assets 同源的越权面：非企业角色不传 entId 会拿到全平台抵销流水。同规则收口。 */
  const role = req.user.role;
  const explicit = req.query.entId ? Number(req.query.entId) : null;
  if (role === 'ENTERPRISE') return ok(res, await credit.listOffsets(req.user.orgId, req.query.limit));
  if (role === 'REGULATOR' || role === 'ADMIN') return ok(res, await credit.listOffsets(explicit, req.query.limit));
  if (!explicit) return ok(res, [], '请指定企业后查看抵销流水（本角色不具备全平台查看权限）');
  return ok(res, await credit.listOffsets(explicit, req.query.limit));
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
