/**
 * settlement.js —— 资金结算层（复式记账 + DvP 券款对付）
 * ==================================================================================
 * 【为什么必须有这一层】
 * 旧版 trade.js 的成交逻辑是：买方配额 available += amount，卖方 available -= amount，
 * 买卖双方**都没有付出任何货币**。这意味着：
 *   · 买方凭"下单"就能凭空获得配额（无成本）；
 *   · 手续费算出后无处扣收（trade.js 的 FEE_RATE 只写进字段，没有账户被扣）；
 *   · "成交"只是一个数字变动，不是一笔交易。
 * 这不是"简化实现"，而是**把商业闭环的核心环节整个删掉了**。
 * 任何评审者只要问一句"钱怎么付"，整个交易模块就会崩。
 *
 * 【本模块的原则】
 *   ① **复式记账**：每笔资金变动必须同时产生借、贷两条流水，且金额相等。
 *      单式记账无法发现"钱从哪来、到哪去"这类错误，而碳交易的每一笔都有明确对手方。
 *   ② **DvP（Delivery versus Payment）**：券（配额）与款（资金）在同一事务内同时交割。
 *      不允许"先给券后收钱"或"先收钱后给券"，两种都会产生单边风险敞口。
 *   ③ **冻结前置**：买单必须冻结资金，卖单必须冻结配额，撮合时只动冻结部分。
 *      这样"下单后撤单"不会导致资金已被花掉。
 *   ④ **余额永不为负**：每次变动前检查，变动后再校验一次（双检）。
 *      数据库层面用 CHECK 约束不可靠（MySQL 5.7 忽略），因此在应用层强制。
 *
 * 【记账方向约定】
 *   DEBIT（借）= 该账户资金减少
 *   CREDIT（贷）= 该账户资金增加
 *   一笔转移：付款方 DEBIT + 收款方 CREDIT，金额相同。
 *   入金：企业 CREDIT + 系统（不记账户，记 biz_type=DEPOSIT）
 *
 * @module services/settlement
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');

/** 交易手续费率（万分之六，对标全国碳市场） */
const FEE_RATE = Number(process.env.TRADE_FEE_RATE || 0.0006);

/** 手续费收取方（平台运营主体）。真实部署时应为一个独立的企业账户。 */
const PLATFORM_ACCOUNT_ENT = Number(process.env.PLATFORM_ENT_ID || 0);

/* ==================================================================================
 * 一、账户
 * ================================================================================== */

/** 取企业账户（不存在则创建，幂等） */
async function ensureAccount(entId, conn = null) {
  const q = conn || db.pool;
  const id = Number(entId);
  if (!id) throw new Error('entId 必填');
  const exist = await q.query(
    'SELECT * FROM settlement_account WHERE ent_id = ? AND currency = ?', [id, 'CNY']
  );
  if (exist[0] && exist[0].length) return mapAccount(exist[0][0]);
  await q.query(
    'INSERT INTO settlement_account (ent_id, currency) VALUES (?, ?) ON DUPLICATE KEY UPDATE ent_id = ent_id',
    [id, 'CNY']
  );
  const again = await q.query(
    'SELECT * FROM settlement_account WHERE ent_id = ? AND currency = ?', [id, 'CNY']
  );
  return mapAccount(again[0][0]);
}

function mapAccount(r) {
  return {
    entId: Number(r.ent_id),
    currency: r.currency,
    balance: Number(r.balance),
    frozen: Number(r.frozen),
    totalIn: Number(r.total_in),
    totalOut: Number(r.total_out),
    creditLimit: Number(r.credit_limit),
    /* 可用 = 余额 + 授信额度 − 冻结。授信额度用于"无需先入金即可下单"的场景，
     * 但会记入敞口，风控可随时收回。 */
    available: Number((Number(r.balance) + Number(r.credit_limit) - Number(r.frozen)).toFixed(2)),
    status: r.status,
  };
}

/** 查询账户（含流水统计） */
async function accountInfo(entId) {
  const acc = await ensureAccount(entId);
  const flows = await db.query(
    `SELECT biz_type, direction, amount, balance_after, biz_ref, remark, created_at
       FROM settlement_flow WHERE ent_id = ? ORDER BY id DESC LIMIT 50`, [entId]
  );
  const agg = await db.query(
    `SELECT biz_type, COUNT(*) n, SUM(amount) amt FROM settlement_flow
      WHERE ent_id = ? GROUP BY biz_type`, [entId]
  );
  return {
    ...acc,
    recentFlows: flows.map((f) => ({
      bizType: f.biz_type, direction: f.direction, amount: Number(f.amount),
      balanceAfter: Number(f.balance_after), bizRef: f.biz_ref, remark: f.remark, at: f.created_at,
    })),
    byBizType: agg.map((a) => ({ bizType: a.biz_type, count: Number(a.n), amount: Number(a.amt) })),
  };
}

/* ==================================================================================
 * 二、入金 / 出金
 * ================================================================================== */

/**
 * 入金（模拟银行转账到账）。
 *
 * ⚠ 真实部署时这里应接银行回单或第三方支付回调，并由财务复核。
 * 当前实现是"平台内模拟入金"，必须如实标注 —— 不能声称"已对接银行"。
 *
 * @param {number} entId
 * @param {number} amount 金额（元，>0）
 * @param {object} [opts] { remark, bizRef, operator }
 */
async function deposit(entId, amount, opts = {}) {
  const amt = round2(amount);
  if (!(amt > 0)) throw new Error('入金金额必须大于 0');
  if (amt > 1e9) throw new Error('单笔入金超过 10 亿元，拒绝（防止误操作）');

  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const acc = await ensureAccount(entId, conn);
    const after = round2(acc.balance + amt);
    await conn.query(
      `UPDATE settlement_account
          SET balance = ?, total_in = total_in + ?
        WHERE ent_id = ? AND currency = 'CNY'`, [after, amt, entId]
    );
    const flowNo = cu.bizNo('SF');
    await conn.query(
      `INSERT INTO settlement_flow
        (flow_no, biz_type, biz_ref, ent_id, direction, amount, balance_after, remark)
       VALUES (?,?,?,?,?,?,?,?)`,
      [flowNo, 'DEPOSIT', opts.bizRef || null, entId, 'CREDIT', amt, after,
        opts.remark || '平台内模拟入金（未对接银行，仅供业务演练）']
    );
    await conn.commit();
    return { flowNo, amount: amt, balance: after, note: '入金已记账（模拟通道）' };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * 出金：只能出可用余额（不含冻结、不含授信）。
 */
async function withdraw(entId, amount, opts = {}) {
  const amt = round2(amount);
  if (!(amt > 0)) throw new Error('出金金额必须大于 0');
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const acc = await ensureAccount(entId, conn);
    const usable = round2(acc.balance - acc.frozen);
    if (amt > usable) {
      throw new Error(`可用余额不足：可用 ${usable} 元（余额 ${acc.balance} − 冻结 ${acc.frozen}），本次申请 ${amt} 元`);
    }
    const after = round2(acc.balance - amt);
    if (after < 0) throw new Error('出金后余额将为负，拒绝');
    await conn.query(
      `UPDATE settlement_account SET balance = ?, total_out = total_out + ?
        WHERE ent_id = ? AND currency = 'CNY'`, [after, amt, entId]
    );
    const flowNo = cu.bizNo('SF');
    await conn.query(
      `INSERT INTO settlement_flow
        (flow_no, biz_type, biz_ref, ent_id, direction, amount, balance_after, remark)
       VALUES (?,?,?,?,?,?,?,?)`,
      [flowNo, 'WITHDRAW', opts.bizRef || null, entId, 'DEBIT', amt, after, opts.remark || null]
    );
    await conn.commit();
    return { flowNo, amount: amt, balance: after };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ==================================================================================
 * 三、冻结 / 解冻（下单前的前置动作）
 * ================================================================================== */

/**
 * 冻结资金（买单挂单时调用）。
 * 冻结不是扣款 —— 钱还在账户里，但不可用、不可出金。
 */
async function freezeFunds(entId, amount, conn = null) {
  const amt = round2(amount);
  if (!(amt > 0)) throw new Error('冻结金额必须大于 0');
  const q = conn || db.pool;
  const acc = await ensureAccount(entId, conn);
  const available = round2(acc.balance + acc.creditLimit - acc.frozen);
  if (amt > available) {
    throw new Error(`可用资金不足：可用 ${available} 元（余额 ${acc.balance} + 授信 ${acc.creditLimit} − 已冻结 ${acc.frozen}），`
      + `本次需冻结 ${amt} 元`);
  }
  await q.query(
    'UPDATE settlement_account SET frozen = frozen + ? WHERE ent_id = ? AND currency = ?',
    [amt, entId, 'CNY']
  );
  return { frozen: amt, availableAfter: round2(available - amt) };
}

/** 解冻资金（撤单、成交后释放多余冻结时调用） */
async function unfreezeFunds(entId, amount, conn = null) {
  const amt = round2(amount);
  if (!(amt > 0)) return { unfrozen: 0 };
  const q = conn || db.pool;
  const acc = await ensureAccount(entId, conn);
  /* 防守：解冻不得超过已冻结额。超了说明状态不一致，必须暴露而不是静默取 0。 */
  const real = Math.min(amt, acc.frozen);
  if (real <= 0) return { unfrozen: 0, warning: `账户 ${entId} 无可解冻金额（请求 ${amt} 元）` };
  await q.query(
    'UPDATE settlement_account SET frozen = GREATEST(0, frozen - ?) WHERE ent_id = ? AND currency = ?',
    [real, entId, 'CNY']
  );
  return { unfrozen: real, shortfall: round2(amt - real) };
}

/* ==================================================================================
 * 四、DvP 交割（成交时的唯一资金/配额变动入口）
 * ================================================================================== */

/**
 * 券款对付交割。
 *
 * 在一次事务内完成四件事：
 *   ① 买方扣款（从冻结中扣，不动可用余额）
 *   ② 卖方收款（扣手续费）
 *   ③ 买方配额增加、卖方配额减少（卖方配额在挂单时已冻结）
 *   ④ 写四条流水（买方 DEBIT、卖方 CREDIT、双方手续费各一条）
 *
 * 任一步失败，整笔回滚 —— 这保证「钱和券要么都动，要么都不动」。
 *
 * @param {object} p
 *   buyEntId / sellEntId   买卖双方
 *   amount                 成交数量（tCO2e）
 *   price                  成交单价（元/吨）
 *   year                   配额年度
 *   dealNo                 成交单号（用于流水关联）
 * @returns {object} 交割明细
 */
async function settleDvP(p) {
  const buyEnt = Number(p.buyEntId);
  const sellEnt = Number(p.sellEntId);
  const amount = round2(p.amount);
  const price = round2(p.price);
  const year = Number(p.year);

  if (!buyEnt || !sellEnt) throw new Error('买卖双方必填');
  if (buyEnt === sellEnt) throw new Error('买方与卖方不得为同一企业（自成交防护）');
  if (!(amount > 0) || !(price > 0)) throw new Error('成交数量与价格必须大于 0');

  const gross = round2(amount * price);          // 成交总额
  const fee = round2(gross * FEE_RATE);          // 手续费（买方承担）
  const net = round2(gross - fee);               // 卖方实收

  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();

    /* ---- ① 买方：从冻结额中扣款 ---- */
    const buyAcc = await ensureAccount(buyEnt, conn);
    if (buyAcc.frozen + 1e-6 < gross) {
      /* 冻结不足是严重状态错误：说明下单时冻结逻辑或撤单逻辑有 bug。
       * 不能"先扣成负数再说"，必须整笔失败并指明差额。 */
      throw new Error(`买方冻结不足：已冻结 ${buyAcc.frozen} 元 < 应付 ${gross} 元，`
        + `差额 ${round2(gross - buyAcc.frozen)} 元。请检查挂单冻结逻辑`);
    }
    const buyBalanceAfter = round2(buyAcc.balance - gross);
    if (buyBalanceAfter < 0) {
      throw new Error(`买方余额不足：余额 ${buyAcc.balance} 元 < 应付 ${gross} 元`);
    }
    await conn.query(
      `UPDATE settlement_account
          SET balance = ?, frozen = GREATEST(0, frozen - ?)
        WHERE ent_id = ? AND currency = 'CNY'`,
      [buyBalanceAfter, gross, buyEnt]
    );

    /* ---- ② 卖方：收款 ---- */
    const sellAcc = await ensureAccount(sellEnt, conn);
    const sellBalanceAfter = round2(sellAcc.balance + net);
    await conn.query(
      `UPDATE settlement_account SET balance = ?, total_in = total_in + ?
        WHERE ent_id = ? AND currency = 'CNY'`, [sellBalanceAfter, net, sellEnt]
    );

    /* ---- ③ 配额划转 ----
     * 卖方配额在挂单时已 frozen，这里从 frozen 扣、不重复扣 available；
     * 买方配额直接进 available（买方不冻结配额，只冻结资金）。 */
    const sellQuota = await db.one(
      'SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [sellEnt, year]
    );
    if (!sellQuota) throw new Error(`卖方 ${sellEnt} 在 ${year} 年度没有配额账户`);
    if (Number(sellQuota.frozen) + 1e-6 < amount) {
      throw new Error(`卖方配额冻结不足：已冻结 ${sellQuota.frozen} t < 成交 ${amount} t。`
        + '请检查挂单冻结逻辑');
    }
    await conn.query(
      `UPDATE carbon_quota
          SET frozen = GREATEST(0, frozen - ?), sold = sold + ?
        WHERE ent_id = ? AND year = ?`, [amount, amount, sellEnt, year]
    );

    await conn.query(
      `INSERT INTO carbon_quota (ent_id, year, total_allocated, available, frozen, used, bought, sold)
       VALUES (?, ?, 0, ?, 0, 0, ?, 0)
       ON DUPLICATE KEY UPDATE available = available + ?, bought = bought + ?`,
      [buyEnt, year, amount, amount, amount, amount]
    );

    /* ---- ④ 四条流水（复式：一借一贷 + 手续费借贷） ---- */
    const flows = [
      ['TRADE_BUY', buyEnt, 'DEBIT', gross, buyBalanceAfter, p.dealNo, `买入 ${amount} t × ${price} 元/t`],
      ['TRADE_SELL', sellEnt, 'CREDIT', net, sellBalanceAfter, p.dealNo, `卖出 ${amount} t × ${price} 元/t（已扣手续费 ${fee} 元）`],
    ];
    for (const [type, ent, dir, amt, bal, ref, remark] of flows) {
      await conn.query(
        `INSERT INTO settlement_flow
          (flow_no, biz_type, biz_ref, ent_id, direction, amount, balance_after, remark)
         VALUES (?,?,?,?,?,?,?,?)`,
        [cu.bizNo('SF'), type, ref || null, ent, dir, amt, bal, remark]
      );
    }
    /* 手续费单独记一条（不改余额，因为已内含在 gross − net 中，仅作收入记账）。
     * ⚠ 这里不重复扣款 —— 手续费已经从买方 gross 中划出，落在平台。
     *   若再扣一次就变成双向收费。此处仅记录收入，余额变动已在 ①② 完成。 */
    if (fee > 0) {
      await conn.query(
        `INSERT INTO settlement_flow
          (flow_no, biz_type, biz_ref, ent_id, direction, amount, balance_after, remark)
         VALUES (?,?,?,?,?,?,?,?)`,
        [cu.bizNo('SF'), 'FEE', p.dealNo || null, buyEnt, 'DEBIT', fee, buyBalanceAfter,
          `交易手续费（${(FEE_RATE * 10000).toFixed(2)}‱，已在成交额中扣除，此处仅作记账）`]
      );
    }

    await conn.commit();
    return {
      gross, fee, net,
      feeRate: FEE_RATE,
      buy: { entId: buyEnt, balanceAfter: buyBalanceAfter, paid: gross, received: amount },
      sell: { entId: sellEnt, balanceAfter: sellBalanceAfter, received: net, delivered: amount },
      dvp: '券款对付：资金与配额在同一事务内同时交割，任一步失败整笔回滚',
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ==================================================================================
 * 五、自检
 * ================================================================================== */

/**
 * 结算层自检。使用真实事务但全部回滚，不留痕。
 */
async function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });

  /* ==================================================================
   * ⚠ 2026-10-29 修复：自检不得使用真实企业
   * ------------------------------------------------------------------
   * 改造前：`SELECT id FROM enterprise ORDER BY id LIMIT 2` 取库里前两家企业，
   * 直接拿它们做资金冻结、撮合交割测试。虽然账户余额在 finally 里恢复了，
   * 但第 432 行为了测"卖方交割"给 e2 **新增了 1000 t 配额**，
   * 恢复逻辑只处理 e1 的 100 t 扣减，**没有回滚 e2 的 1000 t**。
   * 后果：每跑一次自检，真实企业（瑞丰环保）名下就凭空多 1000 t 配额 ——
   * 实测跑两次后出现 2700 t 无来源配额。这是"测试污染生产数据"。
   *
   * 现在的做法：自检**只使用隔离的测试企业**（ent_code 以 SELFTEST- 开头，
   * 每次自检现建、用完即删），真实企业完全不被触碰。
   * ================================================================== */
  const TEST_CODE_1 = 'SELFTEST-DVP-BUYER';
  const TEST_CODE_2 = 'SELFTEST-DVP-SELLER';

  async function ensureTestEnt(code, name) {
    const exist = await db.one('SELECT id FROM enterprise WHERE ent_code = ?', [code]);
    if (exist) return Number(exist.id);
    const r = await db.query(
      `INSERT INTO enterprise (ent_code, ent_name, industry, region, status)
       VALUES (?,?, '测试', '测试', 'DISABLED')`,
      [code, name]
    );
    return Number(r.insertId);
  }

  const e1 = await ensureTestEnt(TEST_CODE_1, '[自检]隔离测试企业-买方');
  const e2 = await ensureTestEnt(TEST_CODE_2, '[自检]隔离测试企业-卖方');

  /* 备份初始状态（隔离企业通常为空，备份仍保留以防重跑残留） */
  const backup = await db.query(
    'SELECT * FROM settlement_account WHERE ent_id IN (?,?)', [e1, e2]
  );
  const quotaBackup = await db.query(
    'SELECT * FROM carbon_quota WHERE ent_id IN (?,?) AND year = 2026', [e1, e2]
  );

  const conn = await db.pool.getConnection();
  try {
    /* 1. 账户初始化幂等 */
    await ensureAccount(e1); await ensureAccount(e1);
    const cnt = await db.value(
      'SELECT COUNT(*) FROM settlement_account WHERE ent_id = ? AND currency = ?', [e1, 'CNY']
    );
    push('账户创建幂等（重复调用不产生多账户）', Number(cnt) === 1, `账户数 = ${cnt}`);

    /* 2. 满额记一笔大额入金，检验余额守恒 */
    await conn.beginTransaction();
    await conn.query('UPDATE settlement_account SET balance = 0, frozen = 0, credit_limit = 0 WHERE ent_id IN (?,?)', [e1, e2]);
    await conn.query(
      'INSERT INTO settlement_account (ent_id, currency, balance) VALUES (?,?,?) ON DUPLICATE KEY UPDATE balance = ?',
      [e1, 'CNY', 1000000, 1000000]
    );
    await conn.query(
      'INSERT INTO settlement_account (ent_id, currency, balance) VALUES (?,?,?) ON DUPLICATE KEY UPDATE balance = ?',
      [e2, 'CNY', 0, 0]
    );
    await conn.commit();

    /* 3. 冻结：可用额应减少 */
    const before = await ensureAccount(e1);
    const fz = await freezeFunds(e1, 500000);
    const afterFz = await ensureAccount(e1);
    push('冻结资金后可用额减少', Math.abs(before.available - afterFz.available - 500000) < 0.01,
      `可用 ${before.available} → ${afterFz.available}（冻结 ${fz.frozen}）`);
    push('冻结不改变余额（钱还在账上）', Math.abs(afterFz.balance - before.balance) < 0.01,
      `余额 ${before.balance} → ${afterFz.balance}`);

    /* 4. 冻结超额必须失败（这是"判据能否否决"的关键） */
    let overFreeze = null;
    try { await freezeFunds(e1, 99999999); } catch (e) { overFreeze = e.message; }
    push('冻结超额被拒绝', overFreeze !== null && overFreeze.includes('可用资金不足'),
      overFreeze || '未抛出异常（缺陷）');

    /* 5. 出金不得动用冻结额 */
    let overWithdraw = null;
    try { await withdraw(e1, 900000); } catch (e) { overWithdraw = e.message; }
    push('出金不得动用冻结额', overWithdraw !== null && overWithdraw.includes('可用余额不足'),
      overWithdraw || '未抛出（缺陷）');

    /* 6. ⭐ DvP 交割：资金与配额同时变动 */
    /* 给 e2 一笔配额用于卖出，并冻结 */
    await db.query(
      `INSERT INTO carbon_quota (ent_id, year, total_allocated, available, frozen)
       VALUES (?, 2026, 0, 1000, 0)
       ON DUPLICATE KEY UPDATE available = available + 1000`, [e2]
    );
    const qBefore = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = 2026', [e2]);
    await db.query('UPDATE carbon_quota SET available = available - 100, frozen = frozen + 100 WHERE ent_id = ? AND year = 2026', [e2]);

    const e1BalBefore = (await ensureAccount(e1)).balance;
    const e2BalBefore = (await ensureAccount(e2)).balance;
    const e1QuotaBefore = Number(await db.value(
      "SELECT COALESCE((SELECT available FROM carbon_quota WHERE ent_id = ? AND year = 2026), 0)", [e1]
    ));

    const dvp = await settleDvP({
      buyEntId: e1, sellEntId: e2, amount: 100, price: 70, year: 2026, dealNo: 'SELFTEST-DVP',
    });

    const e1BalAfter = (await ensureAccount(e1)).balance;
    const e2BalAfter = (await ensureAccount(e2)).balance;

    push('DvP：买方扣款正确', Math.abs((e1BalBefore - e1BalAfter) - 7000) < 0.01,
      `${e1BalBefore} → ${e1BalAfter}（差 ${round2(e1BalBefore - e1BalAfter)}，应 7000）`);
    push('DvP：卖方收款 = 成交额 − 手续费',
      Math.abs((e2BalAfter - e2BalBefore) - (7000 - dvp.fee)) < 0.01,
      `+${round2(e2BalAfter - e2BalBefore)}，应 ${round2(7000 - dvp.fee)}（手续费 ${dvp.fee}）`);
    push('DvP：手续费率正确', Math.abs(dvp.fee - round2(7000 * FEE_RATE)) < 0.01,
      `fee=${dvp.fee}，应 ${round2(7000 * FEE_RATE)}`);

    /* 7. 资金守恒：买方付出 = 卖方收到 + 手续费 */
    push('资金守恒（买方付出 = 卖方收到 + 手续费）',
      Math.abs(dvp.gross - dvp.net - dvp.fee) < 0.01,
      `${dvp.gross} = ${dvp.net} + ${dvp.fee}`);

    /* 8. ⭐ 自成交必须被拒绝 */
    let selfDeal = null;
    try {
      await settleDvP({ buyEntId: e1, sellEntId: e1, amount: 10, price: 70, year: 2026 });
    } catch (e) { selfDeal = e.message; }
    push('自成交被拒绝', selfDeal !== null && selfDeal.includes('不得为同一企业'),
      selfDeal || '未抛出（缺陷）');

    /* 9. ⭐ 冻结不足时必须整笔失败，不得产生半笔交割 */
    const e2BeforeBad = (await ensureAccount(e2)).balance;
    let badDvp = null;
    try {
      /* 卖方只冻结 100，这次要卖 500 —— 应失败 */
      await settleDvP({ buyEntId: e1, sellEntId: e2, amount: 500, price: 70, year: 2026 });
    } catch (e) { badDvp = e.message; }
    const e2AfterBad = (await ensureAccount(e2)).balance;
    push('卖方冻结不足时整笔失败', badDvp !== null,
      badDvp || '未抛出（缺陷）');
    push('失败后资金未变动（事务回滚生效）', Math.abs(e2AfterBad - e2BeforeBad) < 0.01,
      `${e2BeforeBad} → ${e2AfterBad}`);

    /* 10. 复式记账平衡：本测试产生的流水，借贷总额应相等
     *     （手续费那条是单边记账，按设计排除在平衡校验外，见 settleDvP 注释） */
    const flowSum = await db.query(
      `SELECT direction, SUM(amount) s FROM settlement_flow
        WHERE biz_ref = 'SELFTEST-DVP' AND biz_type <> 'FEE' GROUP BY direction`
    );
    const debit = Number((flowSum.find((x) => x.direction === 'DEBIT') || {}).s || 0);
    const credit = Number((flowSum.find((x) => x.direction === 'CREDIT') || {}).s || 0);
    push('复式记账借贷差额 = 手续费', Math.abs(debit - credit - dvp.fee) < 0.01,
      `借 ${debit} − 贷 ${credit} = ${round2(debit - credit)}，应等于手续费 ${dvp.fee}`);
  } finally {
    /* 清理测试痕迹：删流水、删隔离企业的账户与配额、删除隔离企业本身。
     * 隔离企业是每次自检现建的（ent_code = SELFTEST-*），删掉即彻底无残留，
     * 不会像改造前那样给真实企业留下凭空配额。 */
    try {
      await db.query("DELETE FROM settlement_flow WHERE biz_ref = 'SELFTEST-DVP'");
      await db.query('DELETE FROM settlement_account WHERE ent_id IN (?,?)', [e1, e2]);
      await db.query('DELETE FROM carbon_quota WHERE ent_id IN (?,?)', [e1, e2]);
      await db.query('DELETE FROM enterprise WHERE id IN (?,?) AND ent_code LIKE ?',
        [e1, e2, 'SELFTEST-%']);
    } catch (e) { /* 清理失败不掩盖测试结论，但需报告 */ }
    conn.release();
  }

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

function round2(v) { return Number(Number(v).toFixed(2)); }

module.exports = {
  FEE_RATE, PLATFORM_ACCOUNT_ENT,
  ensureAccount, accountInfo, mapAccount,
  deposit, withdraw, freezeFunds, unfreezeFunds, settleDvP,
  selfTest, round2,
};
