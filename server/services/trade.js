/**
 * trade.js —— 碳配额履约流转撮合引擎
 * ------------------------------------------------------------------
 * 定位说明：本模块是「碳资产动态核算 + 可信存证」的**履约闭环衍生应用**，
 * 不是平台的独立业务场所 —— 控排企业据此把动态核算出的配额缺口/结余
 * 付诸履约，成交记录同样上链存证。
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
const settlement = require('./settlement');

/** 撮合方向 */
const SIDE = { BUY: 'BUY', SELL: 'SELL' };
/** 委托单状态 */
const ORDER_STATUS = {
  OPEN: 'OPEN', PARTIAL: 'PARTIAL', FILLED: 'FILLED', CANCELLED: 'CANCELLED',
};
/** 手续费率（万分之 6，对标全国碳市场交易经手费） */
const FEE_RATE = 0.0006;

/* 挂单价格偏离保护（涨跌幅限制）
 *
 * 【为什么必须有】撮合是「价格优先」，一张极端价格的挂单会永久占据盘口首档：
 * 库里曾出现 5 笔 price=1.00 的买单（正常价 60~80 元），其中一笔仍为 OPEN，
 * 于是买盘从 66.50 直接跳到 1.00 —— 盘口区间被一张明显输错的单子撑大，
 * 读者无法判断真实价格区间。更实际的风险是：这类单一旦被误撮合，
 * 就是一次价格严重失真的成交。
 *
 * 判据取「相对参考价的最大偏离」，参考价 = 最近一笔已结算成交价；
 * 无历史成交时（冷启动）不做限制。
 * 阈值 30%：国内试点碳市场日涨跌幅普遍在 ±10%~±30%，放宽到 30%
 * 是为了不误伤跨期大幅波动，但仍能挡住输错量级的单子。
 */
const MAX_PRICE_DEVIATION = 0.30;

/** 最近一笔已结算成交价；无成交返回 null */
async function referencePrice() {
  const r = await db.one(
    "SELECT price FROM trade_deal WHERE status='SETTLED' ORDER BY deal_time DESC, id DESC LIMIT 1"
  );
  return r ? Number(r.price) : null;
}

/** 校验挂单价是否落在允许区间，违规时返回说明文案，合规返回 null */
function checkPriceBand(price, ref) {
  if (!ref || !(ref > 0)) return null;
  const lo = ref * (1 - MAX_PRICE_DEVIATION);
  const hi = ref * (1 + MAX_PRICE_DEVIATION);
  if (price >= lo && price <= hi) return null;
  return `委托单价 ${price} 元/吨偏离最近成交价 ${ref} 元/吨 超过 `
    + `${(MAX_PRICE_DEVIATION * 100).toFixed(0)}%（允许区间 ${lo.toFixed(2)} ~ ${hi.toFixed(2)} 元/吨），请确认价格是否输错。`;
}

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
 *
 * 【2026-10-24 整改：补齐资金侧】
 * 旧实现 BUY 分支只 INSERT 一条订单，不冻结任何资金；成交时买方
 * `available += amount` —— **凭下单凭空获得配额**。这不是"简化"，
 * 是把交易的成本环节整个删掉。现在买单必须先把资金冻起来，
 * 否则撮合时无款可付。
 */
async function placeOrder({ entId, side, price, amount, operator, bizType = "PROPRIETARY", mandateId = null, year = null }) {
  const s = String(side || '').toUpperCase();
  if (![SIDE.BUY, SIDE.SELL].includes(s)) throw new Error('委托方向不合法（BUY / SELL）');
  const pr = Number(price);
  const amt = Number(amount);
  if (!(pr > 0)) throw new Error('委托单价必须大于 0');
  if (!(amt > 0)) throw new Error('委托数量必须大于 0');

  /* 单笔委托上限，防止误输入把整个账户冻死 */
  const MAX_ORDER_AMOUNT = 1e7;
  if (amt > MAX_ORDER_AMOUNT) throw new Error(`单笔委托数量不得超过 ${MAX_ORDER_AMOUNT} tCO₂e`);

  /* 价格偏离校验：挡住输错量级的单子（如把 68 输成 1）。
   * 必须在冻结资金/配额之前拦下 —— 否则脏单已经占用了 frozen。 */
  const refPrice = await referencePrice();
  const bandErr = checkPriceBand(pr, refPrice);
  if (bandErr) throw new Error(bandErr);

  /* 交易年度解析
   *
   * 原实现硬编码 `new Date().getFullYear()`，隐含一个错误前提：
   * 「今年交易的配额就是今年的配额」。实际上碳市场交易的是**履约年度**的配额：
   * 企业为了清缴 2024 年度缺口，在 2026 年买入的是 2024 年配额（vintage 2024）。
   * 按当前年份取账户，会让所有跨年交易报「本年度尚无配额账户，无法交易」——
   * 这不是数据问题，是模型把「交易发生时间」和「配额归属年度」混为一谈。
   *
   * 修正：
   *   ① 显式传 year 时以传入为准（调用方明确指定 vintage）；
   *   ② 未传时优先当前年，若无账户则回退到该企业最近一个有待履约需求的年度
   *      （有配额账户且未完成清缴）。回退只在该企业**确实有履约义务**时发生，
   *      不会让"没有配额的年份"凭空变得可交易。 */
  let yr = Number(year) || new Date().getFullYear();
  let quota = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, yr]);
  if (!quota && !year) {
    const fallback = await db.one(
      `SELECT q.* FROM carbon_quota q
        WHERE q.ent_id = ?
          AND NOT EXISTS (SELECT 1 FROM quota_surrender s
                           WHERE s.ent_id = q.ent_id AND s.year = q.year
                             AND s.status IN ('SURRENDERED','CERTIFIED'))
        ORDER BY q.year DESC LIMIT 1`,
      [entId]
    );
    if (fallback) { quota = fallback; yr = Number(fallback.year); }
  }
  if (!quota) throw new Error('本年度尚无配额账户，无法交易');
  const year_ = yr;

  const orderNo = cu.bizNo('OD');

  if (s === SIDE.SELL) {
    /* ---- 卖出：冻结配额 ---- */
    const available = Number(quota.available);
    if (amt > available + 1e-6) {
      throw new Error(`可用配额不足（可用 ${available} tCO₂e，拟卖出 ${amt} tCO₂e）`);
    }
    await db.tx(async (conn) => {
      const [rows] = await conn.query(
        'SELECT available FROM carbon_quota WHERE ent_id = ? AND year = ? FOR UPDATE', [entId, year_]
      );
      const cur = Number(rows[0].available);
      if (amt > cur + 1e-6) throw new Error(`可用配额不足（可用 ${cur} tCO₂e）`);
      await conn.query(
        'UPDATE carbon_quota SET available = available - ?, frozen = frozen + ? WHERE ent_id = ? AND year = ?',
        [amt, amt, entId, year_]
      );
      await conn.query(
        `INSERT INTO trade_order (order_no, ent_id, side, price, amount, filled_amount, status, biz_type, mandate_id, vintage_year)
         VALUES (?,?,?,?,?,0,'OPEN',?,?,?)`,
        [orderNo, entId, s, pr, amt, bizType, mandateId, year_]
      );
    });
  } else {
    /* ---- 买入：冻结资金（成交额 + 预估手续费，避免成交时因手续费不足而失败）---- */
    const gross = Number((pr * amt).toFixed(2));
    /* 手续费按最大可能收取额预冻结（FEE_RATE 从成交额中扣，
     * 因此冻结额需含手续费对应的可支付部分。此处按 gross 冻结即可 —— 
     * 因为手续费是从 gross 内部划出的，买方总付出就是 gross）。 */
    await settlement.freezeFunds(entId, gross);
    try {
      await db.query(
        `INSERT INTO trade_order (order_no, ent_id, side, price, amount, filled_amount, status, biz_type, mandate_id, vintage_year)
         VALUES (?,?,?,?,?,0,'OPEN',?,?,?)`,
        [orderNo, entId, s, pr, amt, bizType, mandateId, year_]
      );
    } catch (e) {
      /* 订单写入失败必须把冻结的钱退回，否则资金被永久冻结 */
      await settlement.unfreezeFunds(entId, gross).catch(() => {});
      throw e;
    }
  }

  /* 撮合 */
  const matched = await match();

  /* 返回下单结果时必须带上企业名称：列表接口用的是 JOIN 查询，
   * 这里若用裸 SELECT，前端拿到的 entName 就是 null ——
   * 下单成功的提示里"XX 公司 买入"会变成" 买入"。
   * 两条路径字段必须一致，否则同一订单在"刚下单"与"列表刷新后"显示不同。 */
  const order = await db.one(
    `SELECT o.*, e.ent_name FROM trade_order o JOIN enterprise e ON e.id = o.ent_id
      WHERE o.order_no = ?`, [orderNo]
  );
  return {
    order: mapOrder(order),
    matchedCount: matched.length,
    fundFrozen: s === SIDE.BUY ? Number((pr * amt).toFixed(2)) : 0,
    quotaFrozen: s === SIDE.SELL ? amt : 0,
  };
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

    /* ⚠ 自成交防护：同一企业不得与自己的反向委托成交。
     * 旧实现没有这个判断，同企业的买卖单可以撮合，凭空产生一笔"成交"
     * 并虚增成交量与 K 线 —— 这是最容易被识破的造假痕迹，也是监管明令禁止的行为。
     * 处理方式：跳过这一对（不 break，因为后面可能还有别的对手方）。 */
    if (Number(buy.ent_id) === Number(sell.ent_id)) {
      const buyLeft = buys.slice(bi + 1).some((b) => Number(b.ent_id) !== Number(sell.ent_id));
      const sellLeft = sells.slice(si + 1).some((s) => Number(s.ent_id) !== Number(buy.ent_id));
      /* 若买方后面还有别的企业卖单，推进卖指针；否则推进买指针。两者都没有则结束。 */
      if (sellLeft) { si++; continue; }
      if (buyLeft) { bi++; continue; }
      break;
    }

    // 成交价：先挂单者价格（时间优先）
    const price = buy.id < sell.id ? Number(buy.price) : Number(sell.price);
    const amount = Number(Math.min(buyRemain, sellRemain).toFixed(2));
    if (amount <= 0) break;

    const deal = await executeDeal({
      buy, sell, price, amount,
    });
    if (deal && deal.skipped) { si++; continue; }
    deals.push(deal);

    if (buyRemain - amount < 1e-6) bi++;
    if (sellRemain - amount < 1e-6) si++;
  }
  return deals;
}

/**
 * 执行单笔成交。
 *
 * 【2026-10-24 整改：接入 DvP 券款对付】
 * 旧实现只改配额数量，买卖双方都不动钱 —— 买方凭空获得配额、手续费无处扣收、
 * 成交状态直接就是 SETTLED 而没有清算步骤。现在：
 *   · 资金与配额在同一事务内同时交割（settlement.settleDvP）
 *   · 手续费真实从买方成交额中划出，卖方收净额
 *   · 任一环节失败整笔回滚，不产生"半笔成交"
 */
async function executeDeal({ buy, sell, price, amount }) {
  const total = Number((price * amount).toFixed(2));
  const fee = Number((total * FEE_RATE).toFixed(2));
  const dealNo = cu.bizNo('DL');

  /* 成交年度 = 该笔配额归属的履约年度，不是"今天几号"。
   *
   * 原实现用 new Date().getFullYear()，会去扣「今年的」配额账户。
   * 2026 年交易 2024 年 vintage 的配额时，买方账户上今年没有余额，
   * 交割必然失败 —— 而订单本身是合法的。年度错位会让跨年交易全部无法成交。
   *
   * 取法（2026-10-30 修复：优先委托 vintage）：
   *   ① 订单落库的 vintage_year（placeOrder 冻结配额/资金时用的就是它，
   *      交割必须回到同一账户，否则卖方在 2025 冻结的配额会被拿去对 2026
   *      账户交割，「卖方配额冻结不足」让整批撮合饿死）；
   *   ② 双方都无标记的历史订单：回退「卖方有冻结配额的年度 ∩ 买方账户」
   *      —— 冻结在哪，可交割的配额就在哪；
   *   ③ 再退回旧交集逻辑。 */
  const yearsOf = async (entId) => (await db.query(
    `SELECT year FROM carbon_quota WHERE ent_id = ?
      ORDER BY (year = YEAR(CURDATE())) DESC, year DESC`, [entId]
  )).map((r) => Number(r.year));
  const sellYears = await yearsOf(Number(sell.ent_id));
  const buyYears = await yearsOf(Number(buy.ent_id));
  const frozenYearsOf = async (entId) => (await db.query(
    `SELECT year FROM carbon_quota WHERE ent_id = ? AND frozen > 0
      ORDER BY (year = YEAR(CURDATE())) DESC, year DESC`, [entId]
  )).map((r) => Number(r.year));
  const vintage = Number(sell.vintage_year) || Number(buy.vintage_year) || null;
  const year = (vintage && sellYears.includes(vintage) && buyYears.includes(vintage))
    ? vintage
    : (await frozenYearsOf(Number(sell.ent_id))).find((y) => buyYears.includes(y))
      || sellYears.find((y) => buyYears.includes(y))
      || sellYears[0]
      || buyYears[0]
      || new Date().getFullYear();

  /* ---- ① 先做 DvP 交割（含买方冻结校验、资金与配额同时划转）----
   * 它有自己的事务。若失败，抛错给调用方，撮合循环会继续尝试下一对。 */
  let dvp;
  try {
    dvp = await settlement.settleDvP({
      buyEntId: Number(buy.ent_id),
      sellEntId: Number(sell.ent_id),
      amount, price, year, dealNo,
    });
  } catch (e) {
    /* 交割失败不应让整批撮合崩掉，但必须如实报告原因 */
    return { skipped: true, reason: e.message, buyOrder: buy.order_no, sellOrder: sell.order_no };
  }

  /* ---- ② 更新委托单进度 + 写成交记录（独立事务）----
   *
   * ⚠ 这里曾写成：
   *     SET filled_amount = filled_amount + ?, status = CASE WHEN filled_amount + ? >= ...
   *   MySQL 的 SET 子句是**从左到右**求值，后面的 status 表达式读到的
   *   filled_amount 已经是累加后的新值，于是相当于把成交量算了两遍。
   *   后果：委托 25959 t、成交 24878 t（96%）也会被判为 FILLED。
   *   被判 FILLED 的单不能撤，剩下 1081 t 对应的资金永远冻结 —— 资金黑洞。
   *
   * 修正：把 status 放在**前面**赋值，让它读到旧值并显式加上本次成交量；
   *       filled_amount 放最后累加。顺序即语义，不再依赖求值副作用。 */
  await db.tx(async (conn) => {
    for (const oid of [sell.id, buy.id]) {
      await conn.query(
        `UPDATE trade_order
            SET status = CASE WHEN filled_amount + ? >= amount - 0.0005 THEN 'FILLED'
                              WHEN filled_amount + ? > 0 THEN 'PARTIAL'
                              ELSE status END,
                filled_amount = filled_amount + ?
          WHERE id = ?`,
        [amount, amount, amount, oid]
      );
    }
    /* 买方成交后，多余冻结的资金（委托价高于成交价的差额）要退回可用。
     * 否则挂单 100 元、成交 70 元时，30 元的差额会被永久冻结。 */
    const buyOrderPrice = Number(buy.price);
    const refund = Number(((buyOrderPrice - price) * amount).toFixed(2));
    await conn.query(
      `INSERT INTO trade_deal
         (deal_no, buy_order_id, sell_order_id, buyer_ent_id, seller_ent_id, price, amount, total_amount, fee)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [dealNo, buy.id, sell.id, buy.ent_id, sell.ent_id, price, amount, total, fee]
    );
    /* 记下来供下面退回 */
    buy._refund = refund > 0 ? refund : 0;
  });

  /* 退差价（在成交事务之外，避免锁住账户行太久） */
  if (buy._refund > 0) {
    await settlement.unfreezeFunds(Number(buy.ent_id), buy._refund).catch(() => {});
  }

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
        netToSeller: dvp.net,
        buyOrderNo: buy.order_no, sellOrderNo: sell.order_no,
        settlement: 'DvP（券款对付，资金与配额同事务交割）',
      },
    });
    await db.query('UPDATE trade_deal SET chain_block_index = ?, chain_tx_id = ? WHERE deal_no = ?',
      [chain.blockIndex, chain.txId, dealNo]);
  } catch (e) {
    console.error('[trade] 成交上链失败：', e.message);
  }

  const row = await db.one(
    `SELECT d.*, be.ent_name AS buyer_name, se.ent_name AS seller_name
     FROM trade_deal d
     JOIN enterprise be ON be.id = d.buyer_ent_id
     JOIN enterprise se ON se.id = d.seller_ent_id
     WHERE d.deal_no = ?`, [dealNo]
  );
  return { ...mapDeal(row), settlement: dvp };
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
      /* 退回挂单时冻结的那个年度账户。
       * 用 new Date().getFullYear() 会把 2024 年度的冻结配额退到 2026 年账户：
       * 2024 年账户永远显示"冻结中"，2026 年账户凭空多出配额 —— 两头都错，
       * 且两边的合计看起来都是对的（守恒被破坏而不是被打破）。 */
      const qy = await db.one(
        `SELECT year FROM carbon_quota WHERE ent_id = ? AND frozen >= ? - 1e-6
          ORDER BY (year = YEAR(CURDATE())) DESC, year DESC LIMIT 1`,
        [order.ent_id, remain]
      );
      const year = qy ? Number(qy.year) : new Date().getFullYear();
      await conn.query(
        'UPDATE carbon_quota SET available = available + ?, frozen = frozen - ? WHERE ent_id = ? AND year = ?',
        [remain, remain, order.ent_id, year]
      );
    }
  });

  /* ⚠ 买单撤单必须退回冻结资金。
   * 旧实现只处理 SELL 分支 —— 买单撤单后钱永远被冻着，这是"资金黑洞"。
   * 退款额 = 剩余未成交量 × 委托价（成交部分已按成交价结算，差额已在成交时退回）。 */
  let releasedFunds = 0;
  if (order.side === 'BUY' && remain > 0) {
    releasedFunds = Number((remain * Number(order.price)).toFixed(2));
    const r = await settlement.unfreezeFunds(Number(order.ent_id), releasedFunds);
    releasedFunds = r.unfrozen;
  }

  return {
    orderNo: order.order_no,
    releasedQuota: order.side === 'SELL' ? remain : 0,
    releasedFunds,
  };
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
  /* 涨跌幅口径：当日加权均价 vs **最近一个有成交的交易日**的加权均价。
   *
   * 原实现固定取"自然日昨天"。但碳市场成交稀疏（库里 3 个月只有 27 个
   * 交易日，最新一批成交集中在今天），昨天常常一笔都没有：
   * prevAvg = 0 → change 恒为 0 → KPI 卡片上永远挂着「↑ 0.00%」。
   * 一个永远不动的箭头比不显示更糟：它暗示"价格平稳"，而事实是"没有可比基准"。
   *
   * 现在的做法：
   *   · 有前一个有成交日 → 正常算涨跌幅，并在 cmpDate 里说明对比的是哪一天；
   *   · 全天库内只有一天成交 → change 返回 null，前端显示「较前日无成交」，
   *     而不是伪装成 0%。 */
  const byDay = new Map();
  for (const d of deals) {
    const day = String(d.deal_time).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(d);
  }
  const days = [...byDay.keys()].sort();
  const avg = (arr) => (arr.length
    ? arr.reduce((a, b) => a + Number(b.price) * Number(b.amount), 0)
      / arr.reduce((a, b) => a + Number(b.amount), 0)
    : 0);
  const lastPrice = last ? Number(last.price) : 0;
  const lastDay = days[days.length - 1] || null;
  const prevDay = days.length > 1 ? days[days.length - 2] : null;
  const todayAvg = lastDay ? avg(byDay.get(lastDay)) : 0;
  const prevAvg = prevDay ? avg(byDay.get(prevDay)) : 0;
  /* 同一交易日内：用"最新价 vs 当日均价"衡量当日内的价格水平；
   * 跨日：用"当日均价 vs 前日均价"。两者都以 lastPrice 为被减项，
   * 保证卡片上的箭头方向与"最新价相对基准的高低"一致。 */
  const change = prevAvg > 0
    ? Number((((lastPrice - prevAvg) / prevAvg) * 100).toFixed(2))
    : null;
  const changeBasis = prevAvg > 0 ? `较 ${prevDay} 均价` : '前一交易日无成交，无可比基准';

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
    /* change 可能为 null：表示没有可比基准（前一交易日无成交），
     * 前端必须显示"无基准"而不是 0%。 */
    change,
    changeBasis,
    prevAvg: Number(prevAvg.toFixed(2)),
    lastDay,
    prevDay,
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
    /* CCER 对照：credit_asset 表没有价格字段，这里只能给出"规模"口径
     * （项数 / 平均体量）。字段名如实反映这一点，避免前端把数量
     * 当成"价格参照"展示。 */
    ccer: { assetCount: Number(ccer.cnt), avgAmount: Number(ccer.avg_amount) },
  };
}

/** 交易端账户总览（配额 + 碳信用 + 冻结/可用 + 资金流水） */
async function account(entId) {
  /* 展示「当前有配额的那个履约年度」，而不是系统年份。
   * 用系统年份会让 2024 年配额在 2026 年打开页面时显示为全 0，
   * 用户以为配额丢了 —— 实际只是查错了年度。同时返回全部年度供切换。 */
  const allQuota = await db.query(
    'SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC', [entId]
  );
  const pick = allQuota.find((q) => Number(q.year) === new Date().getFullYear()) || allQuota[0] || {};
  const year = Number(pick.year) || new Date().getFullYear();
  const quota = pick;
  const credits = await db.query(
    `SELECT c.* FROM credit_asset c WHERE c.ent_id = ? AND c.status='ACTIVE' ORDER BY c.id DESC`, [entId]
  );
  const deals = await listDeals(entId);
  const orders = await listOrders(entId);
  return {
    year,
    years: allQuota.map((q) => ({
      year: Number(q.year),
      totalAllocated: Number(q.total_allocated || 0),
      available: Number(q.available || 0),
      frozen: Number(q.frozen || 0),
      used: Number(q.used || 0),
    })),
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
  SIDE, ORDER_STATUS, FEE_RATE, MAX_PRICE_DEVIATION, sideCn, statusCn,
  placeOrder, cancelOrder, match, listOrders, listDeals, orderBook, market, account, tradeStat,
  referencePrice, checkPriceBand,
};
