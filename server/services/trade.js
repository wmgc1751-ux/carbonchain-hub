/**
 * trade.js —— 碳配额交易撮合引擎
 * ------------------------------------------------------------------
 * 面向工业场景的碳资产二级市场：控排企业之间买卖碳配额（carbon_quota），
 * 撮合规则采用国内碳市场主流的「价格优先、时间优先」连续竞价。
 *
 *   挂单(placeOrder) → 撮合(match) → 成交(成交双方配额划转 + 冻结解冻) → 上链存证
 *
 * 每笔成交：
 *   1. 买方 carbon_quota.available 增加、bought 累计；
 *   2. 卖方 carbon_quota.available 减少（挂单时已冻结 → 成交时扣减 frozen）；
 *   3. 成交记录写入 trade_deal 并上链存证（txType = TRADE_DEAL）。
 *
 * @module services/trade
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');

/** 撮合方向 */
const SIDE = { BUY: 'BUY', SELL: 'SELL' };
/** 委托单状态 */
const ORDER_STATUS = {
  OPEN: 'OPEN', PARTIAL: 'PARTIAL', FILLED: 'FILLED', CANCELLED: 'CANCELLED',
};
/** 手续费率（万分之 6，对标全国碳市场交易经手费） */
const FEE_RATE = 0.0006;

const sideCn = (s) => (s === 'BUY' ? '买入' : '卖出');
const statusCn = (s) => ({
  OPEN: '挂单中', PARTIAL: '部分成交', FILLED: '已成交', CANCELLED: '已撤单',
}[s] || s);

function mapOrder(r) {
  return {
    id: Number(r.id),
    orderNo: r.order_no,
    entId: Number(r.ent_id),
    entName: r.ent_name || null,
    side: r.side,
    sideCn: sideCn(r.side),
    price: Number(r.price),
    amount: Number(r.amount),
    filledAmount: Number(r.filled_amount),
    status: r.status,
    statusCn: statusCn(r.status),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapDeal(r) {
  return {
    id: Number(r.id),
    dealNo: r.deal_no,
    buyOrderId: r.buy_order_id ? Number(r.buy_order_id) : null,
    sellOrderId: r.sell_order_id ? Number(r.sell_order_id) : null,
    buyerEntId: Number(r.buyer_ent_id),
    sellerEntId: Number(r.seller_ent_id),
    buyerName: r.buyer_name || null,
    sellerName: r.seller_name || null,
    price: Number(r.price),
    amount: Number(r.amount),
    totalAmount: Number(r.total_amount),
    fee: Number(r.fee),
    dealTime: r.deal_time,
    chainBlockIndex: r.chain_block_index,
    chainTxId: r.chain_tx_id,
    status: r.status,
  };
}

/* ------------------------------------------------------------------ */
/* 挂单                                                               */
/* ------------------------------------------------------------------ */

/**
 * 提交委托单。
 * @param {object} p { entId, side, price, amount, operator }
 */
async function placeOrder({ entId, side, price, amount, operator }) {
  const s = String(side || '').toUpperCase();
  if (![SIDE.BUY, SIDE.SELL].includes(s)) throw new Error('委托方向不合法（BUY / SELL）');
  const pr = Number(price);
  const amt = Number(amount);
  if (!(pr > 0)) throw new Error('委托单价必须大于 0');
  if (!(amt > 0)) throw new Error('委托数量必须大于 0');

  const year = new Date().getFullYear();
  const quota = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]);
  if (!quota) throw new Error('本年度尚无配额账户，无法交易');

  const orderNo = cu.bizNo('OD');

  if (s === SIDE.SELL) {
    // 卖出：校验可用余额，冻结相应配额
    const available = Number(quota.available);
    if (amt > available + 1e-6) {
      throw new Error(`可用配额不足（可用 ${available} tCO₂e，拟卖出 ${amt} tCO₂e）`);
    }
    await db.tx(async (conn) => {
      const [rows] = await conn.query('SELECT available FROM carbon_quota WHERE ent_id = ? AND year = ? FOR UPDATE', [entId, year]);
      const cur = Number(rows[0].available);
      if (amt > cur + 1e-6) throw new Error(`可用配额不足（可用 ${cur} tCO₂e）`);
      await conn.query(
        'UPDATE carbon_quota SET available = available - ?, frozen = frozen + ? WHERE ent_id = ? AND year = ?',
        [amt, amt, entId, year]
      );
      await conn.query(
        `INSERT INTO trade_order (order_no, ent_id, side, price, amount, filled_amount, status)
         VALUES (?,?,?,?,?,0,'OPEN')`,
        [orderNo, entId, s, pr, amt]
      );
    });
  } else {
    await db.query(
      `INSERT INTO trade_order (order_no, ent_id, side, price, amount, filled_amount, status)
       VALUES (?,?,?,?,?,0,'OPEN')`,
      [orderNo, entId, s, pr, amt]
    );
  }

  // 撮合
  const matched = await match();

  const order = await db.one('SELECT * FROM trade_order WHERE order_no = ?', [orderNo]);
  return { order: mapOrder(order), matchedCount: matched.length };
}

/**
 * 连续竞价撮合：买单价 ≥ 卖单价即成交，成交价取先进入订单簿的一方（时间优先）。
 * 成交价格 = 两笔委托中「先挂出」的那一方价格。
 */
async function match() {
  const deals = [];
  // 取当前可撮合的买单（价高优先）与卖单（价低优先）
  const buys = await db.query(
    `SELECT o.*, e.ent_name FROM trade_order o JOIN enterprise e ON e.id = o.ent_id
     WHERE o.side='BUY' AND o.status IN ('OPEN','PARTIAL')
     ORDER BY o.price DESC, o.id ASC`
  );
  const sells = await db.query(
    `SELECT o.*, e.ent_name FROM trade_order o JOIN enterprise e ON e.id = o.ent_id
     WHERE o.side='SELL' AND o.status IN ('OPEN','PARTIAL')
     ORDER BY o.price ASC, o.id ASC`
  );

  let bi = 0, si = 0;
  while (bi < buys.length && si < sells.length) {
    const buy = buys[bi];
    const sell = sells[si];
    if (Number(buy.price) < Number(sell.price)) break; // 无可成交价格

    const buyRemain = Number(buy.amount) - Number(buy.filled_amount);
    const sellRemain = Number(sell.amount) - Number(sell.filled_amount);
    if (buyRemain <= 0) { bi++; continue; }
    if (sellRemain <= 0) { si++; continue; }

    // 成交价：先挂单者价格（时间优先）
    const price = buy.id < sell.id ? Number(buy.price) : Number(sell.price);
    const amount = Number(Math.min(buyRemain, sellRemain).toFixed(2));
    if (amount <= 0) break;

    const deal = await executeDeal({
      buy, sell, price, amount,
    });
    deals.push(deal);

    if (buyRemain - amount < 1e-6) bi++;
    if (sellRemain - amount < 1e-6) si++;
  }
  return deals;
}

/**
 * 执行单笔成交（事务内完成资金/配额划转 + 订单状态更新）。
 */
async function executeDeal({ buy, sell, price, amount }) {
  const total = Number((price * amount).toFixed(2));
  const fee = Number((total * FEE_RATE).toFixed(2));
  const dealNo = cu.bizNo('DL');
  const year = new Date().getFullYear();

  await db.tx(async (conn) => {
    // 卖方：冻结配额扣减、sold 累计
    await conn.query(
      `UPDATE carbon_quota SET frozen = frozen - ?, sold = sold + ? WHERE ent_id = ? AND year = ?`,
      [amount, amount, sell.ent_id, year]
    );
    // 买方：可用配额增加、bought 累计
    await conn.query(
      `UPDATE carbon_quota SET available = available + ?, bought = bought + ? WHERE ent_id = ? AND year = ?`,
      [amount, amount, buy.ent_id, year]
    );
    // 更新两笔委托单的成交进度
    await conn.query(
      `UPDATE trade_order SET filled_amount = filled_amount + ?,
         status = CASE WHEN filled_amount >= amount - 0.0005 THEN 'FILLED'
                       WHEN filled_amount > 0 THEN 'PARTIAL' ELSE status END
       WHERE id = ?`,
      [amount, sell.id]
    );
    await conn.query(
      `UPDATE trade_order SET filled_amount = filled_amount + ?,
         status = CASE WHEN filled_amount >= amount - 0.0005 THEN 'FILLED'
                       WHEN filled_amount > 0 THEN 'PARTIAL' ELSE status END
       WHERE id = ?`,
      [amount, buy.id]
    );
    // 成交记录
    await conn.query(
      `INSERT INTO trade_deal
         (deal_no, buy_order_id, sell_order_id, buyer_ent_id, seller_ent_id, price, amount, total_amount, fee)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealNo, buy.id, sell.id, buy.ent_id, sell.ent_id, price, amount, total, fee]
    );
  });

  // 上链存证
  let chain = null;
  try {
    chain = await anchorSvc.anchor({
      txType: 'TRADE_DEAL',
      bizNo: dealNo,
      fromLabel: `ent:${sell.ent_id}`,
      toLabel: `ent:${buy.ent_id}`,
      payload: {
        dealNo, buyerEntId: buy.ent_id, sellerEntId: sell.ent_id,
        price, amount, totalAmount: total, fee,
        buyOrderNo: buy.order_no, sellOrderNo: sell.order_no,
      },
    });
    await db.query('UPDATE trade_deal SET chain_block_index = ?, chain_tx_id = ? WHERE deal_no = ?',
      [chain.blockIndex, chain.txId, dealNo]);
  } catch (e) {
    console.error('[trade] 成交上链失败：', e.message);
  }

  return mapDeal(await db.one(
    `SELECT d.*, be.ent_name AS buyer_name, se.ent_name AS seller_name
     FROM trade_deal d
     JOIN enterprise be ON be.id = d.buyer_ent_id
     JOIN enterprise se ON se.id = d.seller_ent_id
     WHERE d.deal_no = ?`, [dealNo]
  ));
}

/* ------------------------------------------------------------------ */
/* 撤单                                                               */
/* ------------------------------------------------------------------ */

async function cancelOrder(orderId, entId) {
  const order = await db.one('SELECT * FROM trade_order WHERE id = ? AND ent_id = ?', [orderId, entId]);
  if (!order) throw new Error('委托单不存在或不属于当前企业');
  if (!['OPEN', 'PARTIAL'].includes(order.status)) throw new Error('该委托单已成交或已撤单，无法撤单');

  const remain = Number(order.amount) - Number(order.filled_amount);
  await db.tx(async (conn) => {
    await conn.query(
      "UPDATE trade_order SET status='CANCELLED' WHERE id = ? AND status IN ('OPEN','PARTIAL')",
      [orderId]
    );
    if (order.side === 'SELL' && remain > 0) {
      const year = new Date().getFullYear();
      await conn.query(
        'UPDATE carbon_quota SET available = available + ?, frozen = frozen - ? WHERE ent_id = ? AND year = ?',
        [remain, remain, order.ent_id, year]
      );
    }
  });
  return { orderNo: order.order_no, released: order.side === 'SELL' ? remain : 0 };
}

/* ------------------------------------------------------------------ */
/* 查询                                                               */
/* ------------------------------------------------------------------ */

/** 委托单列表 */
async function listOrders(entId = null, filters = {}) {
  const where = [];
  const params = [];
  if (entId) { where.push('o.ent_id = ?'); params.push(entId); }
  if (filters.status) { where.push('o.status = ?'); params.push(filters.status); }
  if (filters.side) { where.push('o.side = ?'); params.push(filters.side); }
  const rows = await db.query(
    `SELECT o.*, e.ent_name FROM trade_order o JOIN enterprise e ON e.id = o.ent_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.id DESC LIMIT 200`, params
  );
  return rows.map(mapOrder);
}

/** 成交记录列表 */
async function listDeals(entId = null, filters = {}) {
  const where = [];
  const params = [];
  if (entId) {
    where.push('(d.buyer_ent_id = ? OR d.seller_ent_id = ?)');
    params.push(entId, entId);
  }
  const rows = await db.query(
    `SELECT d.*, be.ent_name AS buyer_name, se.ent_name AS seller_name
     FROM trade_deal d
     JOIN enterprise be ON be.id = d.buyer_ent_id
     JOIN enterprise se ON se.id = d.seller_ent_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY d.id DESC LIMIT 200`, params
  );
  return rows.map(mapDeal);
}

/** 买卖盘口（前 10 档） */
async function orderBook() {
  const buys = await db.query(
    `SELECT price, SUM(amount - filled_amount) AS amount FROM trade_order
     WHERE side='BUY' AND status IN ('OPEN','PARTIAL')
     GROUP BY price ORDER BY price DESC LIMIT 10`
  );
  const sells = await db.query(
    `SELECT price, SUM(amount - filled_amount) AS amount FROM trade_order
     WHERE side='SELL' AND status IN ('OPEN','PARTIAL')
     GROUP BY price ORDER BY price ASC LIMIT 10`
  );
  const to = (rows) => rows.map((r) => ({ price: Number(r.price), amount: Number(r.amount) }));
  return { buys: to(buys), sells: to(sells) };
}

/** 市场行情：最新价、涨跌、成交量、K 线、CCER 对比 */
async function market() {
  const deals = await db.query(
    `SELECT price, amount, deal_time FROM trade_deal WHERE status='SETTLED'
     ORDER BY deal_time ASC`
  );
  const last = deals.length ? deals[deals.length - 1] : null;
  // 近 30 日 vs 前一日均价 → 涨跌
  const today = deals.filter((d) => {
    const t = new Date(d.deal_time);
    const now = new Date();
    return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  });
  const prev = deals.filter((d) => {
    const t = new Date(d.deal_time);
    const now = new Date();
    const y = new Date(now.getTime() - 86400000);
    return t.getFullYear() === y.getFullYear() && t.getMonth() === y.getMonth() && t.getDate() === y.getDate();
  });
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + Number(b.price) * Number(b.amount), 0) / arr.reduce((a, b) => a + Number(b.amount), 0) : 0);
  const lastPrice = last ? Number(last.price) : 0;
  const prevAvg = avg(prev);
  const change = prevAvg > 0 ? Number((((lastPrice - prevAvg) / prevAvg) * 100).toFixed(2)) : 0;

  // 成交量统计
  const agg = await db.one(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(amount),0) AS vol, IFNULL(SUM(total_amount),0) AS turnover
     FROM trade_deal WHERE status='SETTLED'`
  );
  const high = await db.one('SELECT MAX(price) AS h, MIN(price) AS l FROM trade_deal WHERE status="SETTLED"');

  // K 线（按日聚合）
  const kline = await db.query(
    `SELECT DATE(deal_time) AS d, MAX(price) AS high, MIN(price) AS low,
            SUM(amount) AS vol, SUM(total_amount) AS amount
     FROM trade_deal WHERE status='SETTLED'
     GROUP BY DATE(deal_time) ORDER BY d ASC LIMIT 90`
  );

  // CCER 价格对比（碳信用资产均价，作为第二类碳资产价格参照）
  const ccer = await db.one(
    `SELECT IFNULL(AVG(amount),0) AS avg_amount, COUNT(*) AS cnt FROM credit_asset WHERE asset_type='CCER'`
  );

  return {
    lastPrice,
    change,
    prevAvg: Number(prevAvg.toFixed(2)),
    kpi: {
      deals: Number(agg.cnt),
      volume: Number(Number(agg.vol).toFixed(2)),
      turnover: Number(Number(agg.turnover).toFixed(2)),
      high: Number(high.h || 0),
      low: Number(high.l || 0),
    },
    kline: kline.map((k) => ({
      date: k.d, high: Number(k.high), low: Number(k.low), volume: Number(k.vol), amount: Number(k.amount),
    })),
    ccer: { assetCount: Number(ccer.cnt), avgAmount: Number(ccer.avg_amount) },
  };
}

/** 交易端账户总览（配额 + 碳信用 + 冻结/可用 + 资金流水） */
async function account(entId) {
  const year = new Date().getFullYear();
  const quota = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]) || {};
  const credits = await db.query(
    `SELECT c.* FROM credit_asset c WHERE c.ent_id = ? AND c.status='ACTIVE' ORDER BY c.id DESC`, [entId]
  );
  const deals = await listDeals(entId);
  const orders = await listOrders(entId);
  return {
    year,
    quota: {
      totalAllocated: Number(quota.total_allocated || 0),
      available: Number(quota.available || 0),
      frozen: Number(quota.frozen || 0),
      used: Number(quota.used || 0),
      bought: Number(quota.bought || 0),
      sold: Number(quota.sold || 0),
    },
    credits: credits.map((c) => ({
      id: Number(c.id), assetNo: c.asset_no, assetType: c.asset_type,
      amount: Number(c.amount), usedAmount: Number(c.used_amount),
      remaining: Number((Number(c.amount) - Number(c.used_amount)).toFixed(3)),
    })),
    orders: orders.slice(0, 20),
    deals: deals.slice(0, 20),
  };
}

/** 交易监管统计（监管端） */
async function tradeStat() {
  const agg = await db.one(
    `SELECT COUNT(*) AS orders, SUM(status IN ('OPEN','PARTIAL')) AS openOrders,
            IFNULL(SUM(amount),0) AS orderAmount
     FROM trade_order`
  );
  const dealAgg = await db.one(
    `SELECT COUNT(*) AS deals, IFNULL(SUM(amount),0) AS volume, IFNULL(SUM(total_amount),0) AS turnover
     FROM trade_deal WHERE status='SETTLED'`
  );
  const priceTrend = await db.query(
    `SELECT DATE(deal_time) AS d, AVG(price) AS price, SUM(amount) AS vol
     FROM trade_deal WHERE status='SETTLED' GROUP BY DATE(deal_time) ORDER BY d ASC LIMIT 60`
  );
  return {
    orders: Number(agg.orders), openOrders: Number(agg.openOrders), orderAmount: Number(agg.orderAmount),
    deals: Number(dealAgg.deals), volume: Number(dealAgg.volume), turnover: Number(dealAgg.turnover),
    priceTrend: priceTrend.map((p) => ({ date: p.d, price: Number(p.price), volume: Number(p.vol) })),
  };
}

module.exports = {
  SIDE, ORDER_STATUS, FEE_RATE, sideCn, statusCn,
  placeOrder, cancelOrder, match, listOrders, listDeals, orderBook, market, account, tradeStat,
};
