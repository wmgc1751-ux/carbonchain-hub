/**
 * routes/trade.js —— 碳配额履约流转 API
 * 市场行情 / 盘口 / 委托挂牌 / 撤单 / 成交记录 / 履约账户 / 抵销清缴
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
const db = require('../db');

const router = express.Router();

/* ==================================================================================
 * 交易主体解析 —— P0 越权漏洞修复（2026-10-29）
 * ----------------------------------------------------------------------------------
 * 改造前的实现：
 *   function traderEntId(req) {
 *     if (req.user.role === 'ENTERPRISE') return req.user.orgId;
 *     const explicit = req.body.entId || req.query.entId;
 *     return explicit || req.user.orgId;   // ← 直接采信客户端传入的 entId
 *   }
 * 后果：任何 TRADER 账号带上 entId=任意企业 就能以其名义挂牌/撤单/清缴，
 *       企业毫不知情。这是"可被直接利用"的越权，不是边界模糊。
 *
 * 改造后：TRADER 必须持有该企业签发的、仍在有效期内的授权记录（trade_mandate），
 *        且操作范围与额度都要落在授权范围内。缺失即 403，不做任何降级放行。
 * ================================================================================== */

/** 业务错误：带 HTTP 状态码，由路由层统一转 fail() */
class TradeAuthError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail || null;
  }
}

/**
 * 解析当前操作的交易主体。
 * @param {object} req     请求对象
 * @param {string} need    需要的授权范围：'TRADE'（挂牌/撤单/账户）或 'OFFSET'（清缴）
 * @param {number} amount  本次操作涉及的数量（用于额度校验），null 表示不校验额度
 * @returns {Promise<{entId:number, mandate:object|null}>}
 */
async function resolveActor(req, need = 'TRADE', amount = null) {
  /* ---- 企业端：操作自己，无需授权 ---- */
  if (req.user.role === 'ENTERPRISE') {
    if (!req.user.orgId) throw new TradeAuthError(403, '当前账号未绑定企业主体');
    return { entId: Number(req.user.orgId), mandate: null };
  }

  /* ---- 交易端：必须有企业授权 ---- */
  if (req.user.role !== 'TRADER') {
    throw new TradeAuthError(403, '当前角色无权发起交易操作');
  }

  const explicit = (req.body && req.body.entId) || (req.query && req.query.entId);
  if (!explicit) {
    throw new TradeAuthError(400,
      '交易端必须显式指定代理企业（entId）。交易端不默认代表任何企业，避免"忘记传参即操作自身"的隐式行为。');
  }
  const entId = Number(explicit);
  if (!Number.isInteger(entId) || entId <= 0) {
    throw new TradeAuthError(400, 'entId 非法');
  }

  /* 授权查询：必须 ACTIVE 且在有效期内 */
  const m = await db.one(
    `SELECT m.*, e.ent_name,
            (m.valid_to < NOW()) AS expired
       FROM trade_mandate m
       JOIN enterprise e ON e.id = m.ent_id
      WHERE m.ent_id = ? AND m.trader_user_id = ? AND m.status = 'ACTIVE'
      ORDER BY m.id DESC LIMIT 1`,
    [entId, req.user.id]
  );

  if (!m) {
    throw new TradeAuthError(403,
      `企业 #${entId} 未授权本机构代理交易。请由该企业在「企业端 → 代理授权」中签发授权后再操作。`);
  }
  if (m.expired) {
    /* 过期授权顺手标记，便于企业端与监管端看到真实状态 */
    await db.query("UPDATE trade_mandate SET status='EXPIRED' WHERE id=? AND status='ACTIVE'", [m.id]);
    throw new TradeAuthError(403, `授权已于 ${m.valid_to} 过期，请企业重新签发`);
  }
  if (need === 'OFFSET' && m.scope !== 'TRADE_AND_OFFSET') {
    throw new TradeAuthError(403,
      '当前授权范围仅为「交易」，不包含配额清缴。需要企业将授权范围调整为「交易+清缴」。');
  }
  if (amount !== null && m.max_amount !== null && Number(amount) > Number(m.max_amount)) {
    throw new TradeAuthError(403,
      `本次操作 ${amount} t 超出授权单笔上限 ${Number(m.max_amount)} t`);
  }

  return { entId, mandate: m };
}

/** 兼容旧调用点：只取 entId（内部统一走 resolveActor，不再直接采信客户端参数） */
async function traderEntId(req, need = 'TRADE', amount = null) {
  const a = await resolveActor(req, need, amount);
  return a.entId;
}

/** 把 TradeAuthError 转成标准响应；其它异常继续抛 */
function guard(req, res, fn) {
  return wrap(async (req2, res2) => {
    try {
      return await fn(req2, res2);
    } catch (e) {
      if (e instanceof TradeAuthError) {
        return fail(res2, e.message, e.status);
      }
      throw e;
    }
  });
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
  if (req.user.role === 'REGULATOR') {
    return ok(res, await trade.listOrders(req.query.entId ? Number(req.query.entId) : null, req.query));
  }
  let entId;
  try {
    entId = await traderEntId(req, 'TRADE');
  } catch (e) {
    if (e instanceof TradeAuthError) return fail(res, e.message, e.status);
    throw e;
  }
  ok(res, await trade.listOrders(entId, req.query));
}));

/* 提交委托单 --------------------------------------------------------- */
router.post('/orders', authRequired, requireRole('ENTERPRISE', 'TRADER'), wrap(async (req, res) => {
  const { side, price, amount, year } = req.body || {};

  /* P0：先解析交易主体并通过授权校验（额度按本次下单量校验） */
  let actor;
  try {
    actor = await resolveActor(req, 'TRADE', amount === undefined ? null : Number(amount));
  } catch (e) {
    if (e instanceof TradeAuthError) return fail(res, e.message, e.status);
    throw e;
  }

  let r;
  try {
    r = await trade.placeOrder({
      entId: actor.entId, side, price, amount,
      /* year 允许显式指定配额 vintage（如清缴 2024 年度缺口时交易 2024 年配额）；
       * 不传则服务端按「当前年 → 该企业最近待履约年度」回退解析。 */
      year: year === undefined ? null : Number(year),
      operator: req.user.realName || req.user.username,
      bizType: req.user.role === 'TRADER' ? 'AGENCY' : 'PROPRIETARY',
      mandateId: actor.mandate ? actor.mandate.id : null,
    });
  } catch (e) {
    return fail(res, e.message, 400);
  }
  await writeLog(req, '碳交易', '委托下单', r.order.orderNo,
    `${trade.sideCn(r.order.side)} ${r.order.amount} tCO₂e @ ${r.order.price} 元/吨`
    + (actor.mandate ? `（代理授权 #${actor.mandate.id} · 企业 #${actor.entId}）` : ''),
    'SUCCESS');
  ok(res, r, r.matchedCount > 0
    ? `委托已提交，并即时撮合成交 ${r.matchedCount} 笔`
    : '委托已挂出，等待成交');
}));

/* 撤单 --------------------------------------------------------------- */
router.post('/orders/:id/cancel', authRequired, requireRole('ENTERPRISE', 'TRADER'), wrap(async (req, res) => {
  let entId;
  try {
    entId = await traderEntId(req, 'TRADE');
  } catch (e) {
    if (e instanceof TradeAuthError) return fail(res, e.message, e.status);
    throw e;
  }
  let r;
  try {
    r = await trade.cancelOrder(Number(req.params.id), entId);
  } catch (e) {
    return fail(res, e.message, 400);
  }
  await writeLog(req, '碳交易', '撤销委托', r.orderNo, '撤回未成交委托', 'SUCCESS');
  ok(res, r, '委托已撤销');
}));

/* 成交记录 ----------------------------------------------------------- */
router.get('/deals', authRequired, wrap(async (req, res) => {
  if (req.user.role === 'REGULATOR') {
    return ok(res, await trade.listDeals(req.query.entId ? Number(req.query.entId) : null));
  }
  let entId;
  try {
    entId = await traderEntId(req, 'TRADE');
  } catch (e) {
    if (e instanceof TradeAuthError) return fail(res, e.message, e.status);
    throw e;
  }
  ok(res, await trade.listDeals(entId));
}));

/* 交易账户总览 ------------------------------------------------------- */
router.get('/account', authRequired, requireRole('ENTERPRISE', 'TRADER'), wrap(async (req, res) => {
  let entId;
  try {
    entId = await traderEntId(req, 'TRADE');
  } catch (e) {
    if (e instanceof TradeAuthError) return fail(res, e.message, e.status);
    throw e;
  }
  ok(res, await trade.account(entId));
}));

/* 抵销清缴（CCER 抵销履约缺口，复用碳信用服务） ---------------------- */
router.post('/offset', authRequired, requireRole('ENTERPRISE', 'TRADER'), wrap(async (req, res) => {
  const { assetId, amount, year } = req.body || {};

  /* P0：清缴需要 TRADE_AND_OFFSET 范围的授权，且额度同样受上限约束 */
  let actor;
  try {
    actor = await resolveActor(req, 'OFFSET', amount === undefined ? null : Number(amount));
  } catch (e) {
    if (e instanceof TradeAuthError) return fail(res, e.message, e.status);
    throw e;
  }

  let r;
  try {
    r = await credit.applyOffset({
      entId: actor.entId, assetId: Number(assetId), amount, year,
      operator: req.user.realName || req.user.username,
    });
  } catch (e) {
    return fail(res, e.message, 400);
  }
  await writeLog(req, '碳交易', '抵销清缴', r.offsetNo,
    `用 ${r.assetType} 抵销 ${r.amount} tCO2e`
    + (actor.mandate ? `（代理授权 #${actor.mandate.id} · 企业 #${actor.entId}）` : ''), 'SUCCESS');
  ok(res, r, '抵销清缴完成，缺口已下降并上链存证');
}));

module.exports = router;
