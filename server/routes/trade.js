/**
 * routes/trade.js —— 碳配额交易 API
 * 市场行情 / 盘口 / 委托下单 / 撤单 / 成交记录 / 交易账户 / 抵销清缴
 *
 * 访问控制：
 *   · 读接口（行情/盘口）公开；
 *   · 下单/撤单/账户 —— 企业端(ENTERPRISE) 与 交易端(TRADER) 均可；
 *   · 交易监管统计 —— 监管端(REGULATOR)。
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const trade = require('../services/trade');
const credit = require('../services/credit');

const router = express.Router();

/** 当前交易主体：企业端用自身企业；交易端用请求指定的企业代理（默认自身绑定的企业） */
function traderEntId(req) {
  if (req.user.role === 'ENTERPRISE') return req.user.orgId;
  // 交易端：优先取 body/query 中的 entId，否则用自身 orgId
  const explicit = req.body && req.body.entId ? Number(req.body.entId)
    : (req.query.entId ? Number(req.query.entId) : null);
  return explicit || req.user.orgId;
}

/* 市场行情（公开） --------------------------------------------------- */
router.get('/market', wrap(async (req, res) => {
  ok(res, await trade.market());
}));

/* 盘口（公开） ------------------------------------------------------- */
router.get('/orderbook', wrap(async (req, res) => {
  ok(res, await trade.orderBook());
}));

/* 委托单列表 --------------------------------------------------------- */
router.get('/orders', authRequired, wrap(async (req, res) => {
  const entId = req.user.role === 'REGULATOR' ? (req.query.entId ? Number(req.query.entId) : null)
    : traderEntId(req);
  ok(res, await trade.listOrders(entId, req.query));
}));

/* 提交委托单 --------------------------------------------------------- */
router.post('/orders', authRequired, requireRole('ENTERPRISE', 'TRADER'), wrap(async (req, res) => {
  const { side, price, amount } = req.body || {};
  let r;
  try {
    r = await trade.placeOrder({
      entId: traderEntId(req), side, price, amount,
      operator: req.user.realName || req.user.username,
    });
  } catch (e) {
    return fail(res, e.message, 400);
  }
  await writeLog(req, '碳交易', '委托下单', r.order.orderNo,
    `${trade.sideCn(r.order.side)} ${r.order.amount} tCO₂e @ ${r.order.price} 元/吨`, 'SUCCESS');
  ok(res, r, r.matchedCount > 0
    ? `委托已提交，并即时撮合成交 ${r.matchedCount} 笔`
    : '委托已挂出，等待成交');
}));

/* 撤单 --------------------------------------------------------------- */
router.post('/orders/:id/cancel', authRequired, requireRole('ENTERPRISE', 'TRADER'), wrap(async (req, res) => {
  let r;
  try {
    r = await trade.cancelOrder(Number(req.params.id), traderEntId(req));
  } catch (e) {
    return fail(res, e.message, 400);
  }
  await writeLog(req, '碳交易', '撤销委托', r.orderNo, '撤回未成交委托', 'SUCCESS');
  ok(res, r, '委托已撤销');
}));

/* 成交记录 ----------------------------------------------------------- */
router.get('/deals', authRequired, wrap(async (req, res) => {
  const entId = req.user.role === 'REGULATOR' ? (req.query.entId ? Number(req.query.entId) : null)
    : traderEntId(req);
  ok(res, await trade.listDeals(entId));
}));

/* 交易账户总览 ------------------------------------------------------- */
router.get('/account', authRequired, requireRole('ENTERPRISE', 'TRADER'), wrap(async (req, res) => {
  ok(res, await trade.account(traderEntId(req)));
}));

/* 抵销清缴（CCER 抵销履约缺口，复用碳信用服务） ---------------------- */
router.post('/offset', authRequired, requireRole('ENTERPRISE', 'TRADER'), wrap(async (req, res) => {
  const { assetId, amount, year } = req.body || {};
  let r;
  try {
    r = await credit.applyOffset({
      entId: traderEntId(req), assetId: Number(assetId), amount, year,
      operator: req.user.realName || req.user.username,
    });
  } catch (e) {
    return fail(res, e.message, 400);
  }
  await writeLog(req, '碳交易', '抵销清缴', r.offsetNo,
    `用 ${r.assetType} 抵销 ${r.amount} tCO2e`, 'SUCCESS');
  ok(res, r, '抵销清缴完成，缺口已下降并上链存证');
}));

module.exports = router;
