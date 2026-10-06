/**
 * trade.js —— 碳配额交易撮合引擎
 * ------------------------------------------------------------------
 * 采用最经典的「价格优先、时间优先」连续撮合规则：
 *   · 新买入委托与价格最低的卖出委托撮合（成交价取被动方价格）
 *   · 新卖出委托与价格最高的买入委托撮合
 *   · 撮合成功后生成成交单、划转配额余额，并把成交结果上链存证
 * 配额的"冻结 / 解冻 / 划转"与链上存证一一对应，做到账实相符、可追溯。
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');

const LICENSE_FEE_RATE = 0.0006; // 交易手续费率

/** 取企业某年配额账户，不存在则开户 */
async function ensureQuota(entId, year) {
  let q = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]);
  if (!q) {
    await db.query(
      'INSERT INTO carbon_quota (ent_id, year, total_allocated, available, frozen, used, bought, sold) VALUES (?,?,0,0,0,0,0,0)',
      [entId, year]
    );
    q = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]);
  }
  return q;
}

/**
 * 挂单（含即时撮合）
 * @param {object} p { entId, side, price, amount, year }
 */
async function placeOrder(p) {
  const year = p.year || new Date().getFullYear();
  const side = String(p.side).toUpperCase();
  const price = Number(p.price);
  const amount = Number(p.amount);

  if (!['BUY', 'SELL'].includes(side)) throw new Error('委托方向只能是 BUY 或 SELL');
  if (!(price > 0)) throw new Error('委托价格必须大于 0');
  if (!(amount > 0)) throw new Error('委托数量必须大于 0');

  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [p.entId]);
  if (!ent) throw new Error('企业不存在');
  if (ent.status === 'SUSPENDED') throw new Error('该企业已被暂停交易资格，无法挂单');

  const quota = await ensureQuota(p.entId, year);

  if (side === 'SELL' && Number(quota.available) < amount) {
    throw new Error(`可用配额不足：当前可用 ${Number(quota.available).toFixed(2)} 吨，本次委托 ${amount} 吨`);
  }

  const orderNo = cu.bizNo('OD');
  const [ins] = await db.pool.query(
    `INSERT INTO trade_order (order_no, ent_id, side, price, amount, filled_amount, status)
     VALUES (?,?,?,?,?,0,'OPEN')`,
    [orderNo, p.entId, side, price, amount]
  );
  const orderId = ins.insertId;

  // 卖出方冻结配额
  if (side === 'SELL') {
    await db.query('UPDATE carbon_quota SET available = available - ?, frozen = frozen + ? WHERE id = ?',
      [amount, amount, quota.id]);
  }

  const result = await match({ id: orderId, ent_id: p.entId, side, price, amount, filled_amount: 0, order_no: orderNo }, year);
  return { orderId, orderNo, deals: result.deals, order: await db.one('SELECT * FROM trade_order WHERE id = ?', [orderId]) };
}

/**
 * 连续撮合：反复寻找对手方最优价委托，直到无成交或本单成交完毕
 */
async function match(order, year) {
  const deals = [];
  let remaining = Number(order.amount) - Number(order.filled_amount || 0);

  for (let guard = 0; guard < 50 && remaining > 0; guard++) {
    const isBuy = order.side === 'BUY';
    // 入参 order 可能是"新挂单"，也可能来自数据库（撤单后重新撮合）
    const latest = await db.one('SELECT * FROM trade_order WHERE id = ?', [order.id]);
    if (!latest || ['FILLED', 'CANCELLED'].includes(latest.status)) break;
    remaining = Number(latest.amount) - Number(latest.filled_amount);
    if (remaining <= 0) break;

    const cmp = isBuy ? '<=' : '>=';
    const sort = isBuy ? 'ASC' : 'DESC'; // 买方要最低卖价，卖方要最高买价
    const opposite = await db.one(
      `SELECT * FROM trade_order
       WHERE side = ? AND status IN ('OPEN','PARTIAL') AND ent_id <> ?
         AND price ${cmp} ? AND (amount - filled_amount) > 0
       ORDER BY price ${sort}, created_at ASC LIMIT 1`,
      [isBuy ? 'SELL' : 'BUY', latest.ent_id, latest.price]
    );
    if (!opposite) break;

    const oppRemain = Number(opposite.amount) - Number(opposite.filled_amount);
    const qty = Math.min(remaining, oppRemain);
    const dealPrice = isBuy
      ? Number(opposite.price)  // 主动买方向被动卖方价成交
      : Number(latest.price);   // 主动卖方向被动买方价成交
    const total = Number((dealPrice * qty).toFixed(2));
    const fee = Number((total * LICENSE_FEE_RATE).toFixed(2));

    const buyerId = isBuy ? latest.ent_id : opposite.ent_id;
    const sellerId = isBuy ? opposite.ent_id : latest.ent_id;
    const buyOrderId = isBuy ? latest.id : opposite.id;
    const sellOrderId = isBuy ? opposite.id : latest.id;
    const dealNo = cu.bizNo('DL');

    const [dealIns] = await db.pool.query(
      `INSERT INTO trade_deal (deal_no, buy_order_id, sell_order_id, buyer_ent_id, seller_ent_id,
         price, amount, total_amount, fee, deal_time, status)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),'SETTLED')`,
      [dealNo, buyOrderId, sellOrderId, buyerId, sellerId, dealPrice, qty, total, fee]
    );
    const dealId = dealIns.insertId;

    // 更新两张委托单
    for (const [oid, done] of [[latest.id, qty], [opposite.id, qty]]) {
      const o = await db.one('SELECT amount, filled_amount FROM trade_order WHERE id = ?', [oid]);
      const filled = Number(o.filled_amount) + done;
      await db.query(
        "UPDATE trade_order SET filled_amount = ?, status = ? WHERE id = ?",
        [filled, filled >= Number(o.amount) ? 'FILLED' : 'PARTIAL', oid]
      );
    }

    // 划转配额：卖方解冻并计入卖出，买方计入买入
    const sq = await ensureQuota(sellerId, year);
    const bq = await ensureQuota(buyerId, year);
    await db.query(
      'UPDATE carbon_quota SET frozen = GREATEST(frozen - ?, 0), sold = sold + ? WHERE id = ?',
      [qty, qty, sq.id]
    );
    await db.query(
      'UPDATE carbon_quota SET bought = bought + ?, available = available + ? WHERE id = ?',
      [qty, qty, bq.id]
    );

    // 上链存证（成交即存证，链上时间戳即为清算时点）
    const seller = await db.one('SELECT ent_name, wallet_address FROM enterprise WHERE id = ?', [sellerId]);
    const buyer = await db.one('SELECT ent_name, wallet_address FROM enterprise WHERE id = ?', [buyerId]);
    const chain = await anchorSvc.anchor({
      txType: 'TRADE_DEAL',
      bizNo: dealNo,
      fromLabel: `ent:${sellerId}`,
      toLabel: `ent:${buyerId}`,
      payload: {
        dealNo, buyerEntId: buyerId, buyerName: buyer.ent_name, sellerEntId: sellerId, sellerName: seller.ent_name,
        price: dealPrice, amount: qty, totalAmount: total, fee, year,
      },
    });
    await db.query('UPDATE trade_deal SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
      [chain.blockIndex, chain.txId, dealId]);

    deals.push({
      id: dealId, dealNo, price: dealPrice, amount: qty, totalAmount: total, fee,
      buyer: buyer.ent_name, seller: seller.ent_name,
      chainBlockIndex: chain.blockIndex, chainTxId: chain.txId,
    });
  }

  return { deals };
}

/** 撤单：解冻配额 */
async function cancelOrder(orderId, entId) {
  const o = await db.one('SELECT * FROM trade_order WHERE id = ?', [orderId]);
  if (!o) throw new Error('委托单不存在');
  if (Number(o.ent_id) !== Number(entId)) throw new Error('只能撤销本企业的委托单');
  if (['FILLED', 'CANCELLED'].includes(o.status)) throw new Error('该委托单已结束，无法撤销');

  const remain = Number(o.amount) - Number(o.filled_amount);
  await db.query("UPDATE trade_order SET status = 'CANCELLED' WHERE id = ?", [orderId]);

  if (o.side === 'SELL' && remain > 0) {
    const year = new Date(o.created_at).getFullYear();
    const q = await ensureQuota(entId, year);
    await db.query('UPDATE carbon_quota SET frozen = GREATEST(frozen - ?,0), available = available + ? WHERE id = ?',
      [remain, remain, q.id]);
  }
  return { orderId, cancelled: remain };
}

module.exports = { placeOrder, cancelOrder, ensureQuota, match, LICENSE_FEE_RATE };
