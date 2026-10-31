/**
 * routes/settlement.js —— 商业闭环 API
 * ==================================================================================
 * 分组：
 *   /account      资金结算账户（余额 / 流水 / 入金 / 出金）
 *   /surrender    配额履约清缴（准备 / 执行 / 批量 / 状态）
 *   /retirement   碳信用注销（注销 / 查询）
 *   /cbam         CBAM 证书（计算 / 台账）
 *
 * 访问控制：
 *   · 账户：企业端看自己；监管端看全部；管理端看全部
 *   · 清缴：企业端可发起自己的；监管端可批量；核查端只读
 *   · 注销：企业端发起自己的；监管端可代发起（含强制注销）
 *
 * @module routes/settlement
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const db = require('../db');
const settlement = require('../services/settlement');
const compliance = require('../services/compliance');
const cbam = require('../services/cbam');

const router = express.Router();

/** 解析目标企业：企业端强制自身，其他角色需显式 entId */
function resolveEnt(req, explicit) {
  if (req.user.role === 'ENTERPRISE') return Number(req.user.orgId);
  const v = explicit === undefined || explicit === null ? null : Number(explicit);
  return v || null;
}

/* ==================================================================================
 * 一、资金结算账户
 * ================================================================================== */

router.get('/account', authRequired, wrap(async (req, res) => {
  const entId = resolveEnt(req, req.query.entId);
  if (!entId) return fail(res, '需要 entId（企业端自动取自身）', 400);
  ok(res, await settlement.accountInfo(entId));
}));

router.post('/account/deposit', authRequired, requireRole('ENTERPRISE', 'REGULATOR'), wrap(async (req, res) => {
  const b = req.body || {};
  const entId = resolveEnt(req, b.entId);
  if (!entId) return fail(res, '需要 entId', 400);
  const r = await settlement.deposit(entId, Number(b.amount), {
    remark: b.remark, operator: req.user.username,
  });
  await writeLog(req, 'SETTLE_DEPOSIT', `入金 ent=${entId} ${b.amount} 元`);
  ok(res, r);
}));

router.post('/account/withdraw', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const b = req.body || {};
  const entId = resolveEnt(req, b.entId);
  if (!entId) return fail(res, '需要 entId', 400);
  try {
    const r = await settlement.withdraw(entId, Number(b.amount), { remark: b.remark });
    await writeLog(req, 'SETTLE_WITHDRAW', `出金 ent=${entId} ${b.amount} 元`);
    ok(res, r);
  } catch (e) {
    /* 余额不足是业务错误（409），不是服务器错误 */
    return res.status(409).json({ code: 409, message: e.message });
  }
}));

/* 全平台结算概览（监管端/管理端） */
router.get('/account/overview', authRequired, requireRole('ADMIN', 'REGULATOR'), wrap(async (req, res) => {
  const agg = await db.query(
    `SELECT COUNT(*) accounts, SUM(balance) totalBalance, SUM(frozen) totalFrozen,
            SUM(total_in) totalIn, SUM(total_out) totalOut
       FROM settlement_account WHERE currency = 'CNY'`
  );
  const byBiz = await db.query(
    `SELECT biz_type, COUNT(*) n, SUM(amount) amt FROM settlement_flow GROUP BY biz_type ORDER BY amt DESC`
  );
  const a = agg[0] || {};
  ok(res, {
    accounts: Number(a.accounts || 0),
    totalBalance: Number(a.totalBalance || 0),
    totalFrozen: Number(a.totalFrozen || 0),
    totalIn: Number(a.totalIn || 0),
    totalOut: Number(a.totalOut || 0),
    byBizType: byBiz.map((x) => ({ bizType: x.biz_type, count: Number(x.n), amount: Number(x.amt) })),
  });
}));

/* ==================================================================================
 * 二、履约清缴
 * ================================================================================== */

/* 履约全景（企业看自己，监管看全部） */
router.get('/surrender/status', authRequired, wrap(async (req, res) => {
  const entId = resolveEnt(req, req.query.entId);
  const year = Number(req.query.year) || new Date().getFullYear();
  if (entId) return ok(res, await compliance.complianceStatus(entId, year));

  /* 监管视角：全平台履约概览 */
  if (req.user.role !== 'ADMIN' && req.user.role !== 'REGULATOR') {
    return fail(res, '非企业角色查看全平台概览需 ADMIN/REGULATOR 权限', 403);
  }
  const ents = await db.query(
    `SELECT id FROM enterprise WHERE status <> 'SUSPENDED' ORDER BY id`
  );
  const list = [];
  for (const e of ents) {
    try { list.push(await compliance.complianceStatus(Number(e.id), year)); }
    catch (err) { list.push({ entId: Number(e.id), error: err.message }); }
  }
  const states = {};
  for (const x of list) {
    const s = (x.assessment && x.assessment.state) || 'ERROR';
    states[s] = (states[s] || 0) + 1;
  }
  ok(res, {
    year, scope: 'ALL',
    total: list.length,
    states,
    complianceRate: list.length
      ? Number(((states.COMPLIANT || 0) / list.length * 100).toFixed(2)) : 0,
    items: list,
  });
}));

/* 生成清缴单 */
router.post('/surrender/prepare', authRequired, requireRole('ENTERPRISE', 'REGULATOR'), wrap(async (req, res) => {
  const b = req.body || {};
  const entId = resolveEnt(req, b.entId);
  if (!entId) return fail(res, '需要 entId', 400);
  try {
    const r = await compliance.prepareSurrender({
      entId, year: Number(b.year) || new Date().getFullYear(),
      operator: req.user.username, deadline: b.deadline,
    });
    await writeLog(req, 'SURRENDER_PREPARE',
      `生成清缴单 ent=${entId} ${r.year}：应缴 ${r.requiredQuota} t，可用 ${r.availableQuota} t`);
    ok(res, r);
  } catch (e) {
    return res.status(409).json({ code: 409, message: e.message });
  }
}));

/* 执行清缴 */
router.post('/surrender/execute', authRequired, requireRole('ENTERPRISE', 'REGULATOR'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.surrenderNo) return fail(res, 'surrenderNo 必填', 400);
  try {
    const r = await compliance.executeSurrender(String(b.surrenderNo), {
      operator: req.user.username,
      allowShortfall: b.allowShortfall === true,
    });
    await writeLog(req, 'SURRENDER_EXECUTE',
      `执行清缴 ${b.surrenderNo}：${r.status}，实缴 ${r.surrendered} t，缺口 ${r.shortfall} t`);
    ok(res, r);
  } catch (e) {
    return res.status(409).json({ code: 409, message: e.message });
  }
}));

/* 批量清缴（监管端年末动作） */
/* P1 权限收缩（2026-10-29）：批量清缴是会真实变更企业履约状态与配额的**业务决策**，
 * 管理员（ADMIN）只管配置与运维，不得参与。故从 requireRole 中移除 ADMIN。 */
router.post('/surrender/batch', authRequired, requireRole('REGULATOR'), wrap(async (req, res) => {
  const b = req.body || {};
  const year = Number(b.year) || new Date().getFullYear();
  const r = await compliance.batchSurrender(year, {
    operator: req.user.username,
    dryRun: b.dryRun === true,
    allowShortfall: b.allowShortfall !== false,
  });
  await writeLog(req, 'SURRENDER_BATCH',
    `批量清缴 ${year}：成功 ${r.succeeded}/${r.total}，总清缴 ${r.totalSurrendered} t，总缺口 ${r.totalShortfall} t`
    + (b.dryRun ? '（试算）' : ''));
  ok(res, r);
}));

/* 清缴单列表 */
router.get('/surrender', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  const entId = resolveEnt(req, req.query.entId);
  if (entId) { where.push('s.ent_id = ?'); params.push(entId); }
  if (req.query.year) { where.push('s.year = ?'); params.push(Number(req.query.year)); }
  if (req.query.status) { where.push('s.status = ?'); params.push(String(req.query.status)); }

  const rows = await db.query(
    `SELECT s.*, e.ent_name FROM quota_surrender s JOIN enterprise e ON e.id = s.ent_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.id DESC LIMIT 200`, params
  );
  ok(res, {
    count: rows.length,
    items: rows.map((r) => ({
      surrenderNo: r.surrender_no, entId: Number(r.ent_id), entName: r.ent_name,
      year: Number(r.year), verifiedEmission: Number(r.verified_emission),
      offsetUsed: Number(r.offset_used), requiredQuota: Number(r.required_quota),
      surrenderedQuota: Number(r.surrendered_quota), shortfall: Number(r.shortfall),
      penalty: Number(r.penalty), status: r.status,
      certificateNo: r.certificate_no, emissionSource: r.emission_source,
      deadline: r.deadline,
      chain: { blockIndex: r.chain_block_index, txId: r.chain_tx_id },
    })),
  });
}));

/* ==================================================================================
 * 三、碳信用注销
 * ================================================================================== */

router.post('/retirement', authRequired, requireRole('ENTERPRISE', 'REGULATOR'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.assetId) return fail(res, 'assetId 必填', 400);
  try {
    const r = await compliance.retireCredit({
      assetId: Number(b.assetId), amount: Number(b.amount),
      purpose: b.purpose || 'OFFSET', beneficiary: b.beneficiary,
      operator: req.user.username,
    });
    await writeLog(req, 'CREDIT_RETIRE',
      `注销碳信用 ${r.assetNo} ${r.amount} t（${r.purpose}）`);
    ok(res, r);
  } catch (e) {
    return res.status(409).json({ code: 409, message: e.message });
  }
}));

router.get('/retirement', authRequired, wrap(async (req, res) => {
  const entId = resolveEnt(req, req.query.entId);
  ok(res, { items: await compliance.listRetirements({ entId, purpose: req.query.purpose }) });
}));

/* 可注销资产列表 */
router.get('/retirement/candidates', authRequired, wrap(async (req, res) => {
  const entId = resolveEnt(req, req.query.entId);
  if (!entId) return fail(res, '需要 entId', 400);
  const rows = await db.query(
    `SELECT id, asset_no, asset_type, amount, used_amount, issue_year, valid_until, status
       FROM credit_asset
      WHERE ent_id = ? AND status IN ('ACTIVE','USED') AND amount > used_amount
      ORDER BY valid_until`, [entId]
  );
  ok(res, {
    count: rows.length,
    items: rows.map((r) => ({
      assetId: Number(r.id), assetNo: r.asset_no, assetType: r.asset_type,
      amount: Number(r.amount), used: Number(r.used_amount),
      remaining: Number((Number(r.amount) - Number(r.used_amount)).toFixed(3)),
      issueYear: Number(r.issue_year),
      validUntil: r.valid_until, status: r.status,
    })),
  });
}));

/* ==================================================================================
 * 四、CBAM 证书
 * ================================================================================== */

/* CBAM 免费配额因子表（公开，任何进口商可核对） */
router.get('/cbam/factor', wrap(async (req, res) => {
  /* ⚠ 不要写成 { schedule: cbam.cbamFactorSchedule() } —— 那个函数本身已经
   * 返回 { source, schedule, override, caveat }，再包一层会让前端拿到
   * schedule.schedule，字段路径错位（实测前端取 .schedule.length 得 undefined）。 */
  ok(res, cbam.cbamFactorSchedule());
}));

/* 计算 CBAM 证书（不落库） */
router.post('/cbam/calculate', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const entId = Number(b.entId) || (req.user.role === 'ENTERPRISE' ? Number(req.user.orgId) : null);
  if (!entId) return fail(res, '需要 entId', 400);
  try {
    const r = await cbam.calculateCertificate({
      entId, year: Number(b.year) || new Date().getFullYear(),
      cnCode: b.cnCode, quantity: Number(b.quantity),
      euaPriceEur: b.euaPriceEur === undefined ? undefined : Number(b.euaPriceEur),
      eurCny: b.eurCny === undefined ? undefined : Number(b.eurCny),
      originCarbonPriceCny: b.originCarbonPriceCny === undefined ? undefined : Number(b.originCarbonPriceCny),
    });
    ok(res, r);
  } catch (e) {
    return res.status(409).json({ code: 409, message: e.message });
  }
}));

/* 生成并落库证书 */
router.post('/cbam/certificate', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const b = req.body || {};
  const entId = Number(b.entId) || (req.user.role === 'ENTERPRISE' ? Number(req.user.orgId) : null);
  if (!entId) return fail(res, '需要 entId', 400);
  try {
    const r = await cbam.issueCertificate({
      entId, year: Number(b.year) || new Date().getFullYear(),
      cnCode: b.cnCode, quantity: Number(b.quantity),
      originCarbonPriceCny: b.originCarbonPriceCny,
      operator: req.user.username,
    });
    await writeLog(req, 'CBAM_CERT_ISSUE',
      `生成 CBAM 证书 ${r.certNo}：应缴 ${r.payableEmission} t，净应付 ${r.netPayableCny} 元`);
    ok(res, r);
  } catch (e) {
    return res.status(409).json({ code: 409, message: e.message });
  }
}));

/* 证书台账 */
router.get('/cbam/certificates', authRequired, wrap(async (req, res) => {
  const entId = resolveEnt(req, req.query.entId);
  const where = [];
  const params = [];
  if (entId) { where.push('ent_id = ?'); params.push(entId); }
  if (req.query.year) { where.push('year = ?'); params.push(Number(req.query.year)); }
  const rows = await db.query(
    `SELECT * FROM cbam_certificate ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT 200`, params
  );
  ok(res, {
    count: rows.length,
    items: rows.map((r) => ({
      certNo: r.cert_no, entId: Number(r.ent_id), year: Number(r.year),
      embeddedEmission: Number(r.embedded_emission),
      freeAllocation: Number(r.free_allocation),
      cbamFactor: Number(r.cbam_factor),
      payableEmission: Number(r.payable_emission),
      euaPriceEur: Number(r.eua_price_eur), eurCny: Number(r.eur_cny),
      amountEur: Number(r.amount_eur), amountCny: Number(r.amount_cny),
      deductionCny: Number(r.deduction_cny), netPayableCny: Number(r.net_payable_cny),
      priceSource: r.price_source, status: r.status, createdAt: r.created_at,
    })),
  });
}));

module.exports = router;
