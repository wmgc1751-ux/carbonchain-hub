/**
 * credit.js —— 碳信用资产与抵销服务
 * ------------------------------------------------------------------
 * 响应标题中的"碳资产"：本项目支持的两类碳资产 ——
 *   1. 碳配额（carbon_quota，见 trade.js / quota 相关路由）
 *   2. 碳信用（credit_asset，本模块）：国家核证自愿减排量 CCER / 林业碳汇 / 绿证 等
 *
 * 碳信用可用来**抵销本年度履约缺口**（对标全国碳市场"CCER 抵销不超过配额 5%"规则）：
 *   抵销 → 减少动态核算账户的预计期末缺口 → 降低履约风险等级 → 抵销流水上链存证。
 *
 * @module services/credit
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');

/** 碳信用资产类型 */
const CREDIT_TYPES = {
  CCER: '国家核证自愿减排量',
  FOREST: '林业碳汇',
  GREEN_CERT: '绿色电力证书',
};

/** 抵销比例上限（占企业年度配额）—— 对标全国碳排放权交易市场 CCER 抵销规则 */
const OFFSET_RATIO_LIMIT = 0.05;

const typeCn = (t) => CREDIT_TYPES[t] || t;

function mapAsset(r) {
  const amount = Number(r.amount);
  const used = Number(r.used_amount);
  return {
    id: Number(r.id),
    entId: Number(r.ent_id),
    entName: r.ent_name || null,
    assetNo: r.asset_no,
    assetType: r.asset_type,
    assetTypeCn: typeCn(r.asset_type),
    projectName: r.project_name,
    amount,
    usedAmount: used,
    remaining: Number((amount - used).toFixed(3)),
    issueYear: r.issue_year,
    validUntil: r.valid_until,
    registry: r.registry,
    status: r.status,
    chainBlockIndex: r.chain_block_index,
    chainTxId: r.chain_tx_id,
  };
}

/** 碳信用资产列表（entId 为空则返回全市场） */
async function listAssets(entId = null) {
  const rows = await db.query(
    `SELECT c.*, e.ent_name FROM credit_asset c JOIN enterprise e ON e.id = c.ent_id
     ${entId ? 'WHERE c.ent_id = ?' : ''} ORDER BY (c.status='ACTIVE') DESC, c.id`,
    entId ? [entId] : []
  );
  return rows.map(mapAsset);
}

/** 全市场碳资产总览（监管/公众看板） */
async function summary() {
  const [agg] = (await db.query(
    `SELECT COUNT(*) AS assets, COUNT(DISTINCT ent_id) AS holders,
            IFNULL(SUM(amount),0) AS total, IFNULL(SUM(used_amount),0) AS used
     FROM credit_asset`
  )) || [{}];
  const byType = await db.query(
    `SELECT asset_type, COUNT(*) AS c, IFNULL(SUM(amount),0) AS amount, IFNULL(SUM(used_amount),0) AS used
     FROM credit_asset GROUP BY asset_type ORDER BY amount DESC`
  );
  const offsetCount = Number(await db.value('SELECT COUNT(*) FROM credit_offset')) || 0;
  const offsetAmount = Number(await db.value('SELECT IFNULL(SUM(amount),0) FROM credit_offset')) || 0;
  const total = Number(agg.total || 0);
  const used = Number(agg.used || 0);
  return {
    assetCount: Number(agg.assets || 0),
    holders: Number(agg.holders || 0),
    totalAmount: total,
    usedAmount: used,
    availableAmount: Number((total - used).toFixed(3)),
    offsetCount,
    offsetAmount: Number(offsetAmount.toFixed(3)),
    ratioLimit: OFFSET_RATIO_LIMIT,
    byType: byType.map((r) => ({
      type: r.asset_type, typeCn: typeCn(r.asset_type),
      count: Number(r.c), amount: Number(r.amount), used: Number(r.used),
    })),
  };
}

/** 某企业某年度的抵销额度与缺口情况 */
async function offsetStatus(entId, year) {
  const y = Number(year) || new Date().getFullYear();
  const quota = Number(await db.value(
    'SELECT total_allocated FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, y]
  ) || 0);
  const used = Number(await db.value(
    'SELECT IFNULL(SUM(amount),0) FROM credit_offset WHERE ent_id = ? AND year = ?', [entId, y]
  ) || 0);
  const limit = Number((quota * OFFSET_RATIO_LIMIT).toFixed(3));
  const dyn = await db.one(
    'SELECT gap, predicted_eoy, offset_applied FROM carbon_dynamic_account WHERE ent_id = ? AND year = ?', [entId, y]
  );
  const avail = Number(await db.value(
    `SELECT IFNULL(SUM(amount - used_amount),0) FROM credit_asset WHERE ent_id = ? AND status = 'ACTIVE'`, [entId]
  ) || 0);
  return {
    year: y,
    quota,
    limit,
    used: Number(used.toFixed(3)),
    offsetLimitRemaining: Number(Math.max(0, limit - used).toFixed(3)),
    availableCredit: Number(avail.toFixed(3)),
    gap: dyn ? Number(dyn.gap) : 0,
    predictedEoy: dyn ? Number(dyn.predicted_eoy) : 0,
    offsetApplied: dyn ? Number(dyn.offset_applied) : 0,
    ratioLimit: OFFSET_RATIO_LIMIT,
  };
}

/** 抵销流水 */
async function listOffsets(entId = null, limit = 100) {
  const rows = await db.query(
    `SELECT o.*, a.asset_no, a.asset_type, e.ent_name
     FROM credit_offset o
     JOIN credit_asset a ON a.id = o.asset_id
     JOIN enterprise e ON e.id = o.ent_id
     ${entId ? 'WHERE o.ent_id = ?' : ''}
     ORDER BY o.id DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    entId ? [entId] : []
  );
  return rows.map((r) => ({
    id: Number(r.id),
    offsetNo: r.offset_no,
    entId: Number(r.ent_id),
    entName: r.ent_name,
    year: Number(r.year),
    assetNo: r.asset_no,
    assetType: r.asset_type,
    assetTypeCn: typeCn(r.asset_type),
    amount: Number(r.amount),
    quotaBefore: Number(r.quota_before),
    quotaAfter: Number(r.quota_after),
    operator: r.operator,
    chainBlockIndex: r.chain_block_index,
    chainTxId: r.chain_tx_id,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/**
 * 碳信用抵销（核心动作）：校验额度 → 事务写库 → 上链存证 → 刷新动态核算。
 * @param {object} p { entId, assetId, amount, year, operator }
 */
async function applyOffset({ entId, assetId, amount, year, operator }) {
  const y = Number(year) || new Date().getFullYear();
  const amt = Number(amount);
  if (!entId) throw new Error('缺少企业标识');
  if (!(amt > 0)) throw new Error('抵销量必须大于 0');

  const asset = await db.one('SELECT * FROM credit_asset WHERE id = ? AND ent_id = ?', [assetId, entId]);
  if (!asset) throw new Error('碳信用资产不存在或不属于当前企业');
  if (asset.status !== 'ACTIVE') throw new Error('该碳信用资产当前不可用（已用尽或已过期）');
  if (asset.valid_until && new Date(asset.valid_until) < new Date()) throw new Error('该碳信用资产已过有效期');
  const remaining = Number(asset.amount) - Number(asset.used_amount);
  if (amt > remaining + 1e-6) throw new Error(`抵销量超过该资产可用余额（剩余 ${remaining} tCO₂e）`);

  const st = await offsetStatus(entId, y);
  if (st.quota <= 0) throw new Error('该企业本年度尚未分配配额，无法进行碳信用抵销');
  if (st.used + amt > st.limit + 1e-6) {
    throw new Error(
      `碳信用抵销不得超过配额的 ${(OFFSET_RATIO_LIMIT * 100).toFixed(0)}%`
      + `（上限 ${st.limit} tCO₂e，已用 ${st.used} tCO₂e，剩余可抵销 ${st.offsetLimitRemaining} tCO₂e）`
    );
  }

  const quotaBefore = Number(st.gap.toFixed(3));
  const quotaAfter = Number((st.gap - amt).toFixed(3));
  const offsetNo = cu.bizNo('CO');

  // 事务：写抵销流水 + 更新资产已用量（并发下用行锁保证不超用）
  await db.tx(async (conn) => {
    const [rows] = await conn.query('SELECT amount, used_amount, status FROM credit_asset WHERE id = ? FOR UPDATE', [assetId]);
    const cur = rows[0];
    if (!cur || cur.status !== 'ACTIVE') throw new Error('该碳信用资产当前不可用');
    const rem = Number(cur.amount) - Number(cur.used_amount);
    if (amt > rem + 1e-6) throw new Error(`抵销量超过该资产可用余额（剩余 ${rem} tCO₂e）`);

    await conn.query(
      `INSERT INTO credit_offset
         (offset_no, ent_id, year, asset_id, amount, ratio_limit, quota_before, quota_after, operator, status)
       VALUES (?,?,?,?,?,?,?,?,?, 'CONFIRMED')`,
      [offsetNo, entId, y, assetId, amt, OFFSET_RATIO_LIMIT, quotaBefore, quotaAfter, operator || null]
    );
    await conn.query('UPDATE credit_asset SET used_amount = used_amount + ? WHERE id = ?', [amt, assetId]);
    await conn.query(
      "UPDATE credit_asset SET status = CASE WHEN used_amount >= amount - 0.0005 THEN 'USED' ELSE status END WHERE id = ?",
      [assetId]
    );
  });

  // 上链存证（发起方 = 企业节点）
  const anchorSvc = require('./anchor');
  const res = await anchorSvc.anchor({
    txType: 'CREDIT_OFFSET',
    bizNo: offsetNo,
    fromLabel: `ent:${entId}`,
    payload: {
      offsetNo, entId, year: y, assetNo: asset.asset_no, assetType: asset.asset_type,
      amount: amt, quotaBefore, quotaAfter, ratioLimit: OFFSET_RATIO_LIMIT,
    },
  });
  await db.query(
    'UPDATE credit_offset SET chain_block_index = ?, chain_tx_id = ? WHERE offset_no = ?',
    [res.blockIndex, res.txId, offsetNo]
  );

  // 立即刷新动态核算账户（抵销降低预计缺口与履约风险）
  try { await require('./dynamic').recompute(entId); } catch (e) { /* 不阻断抵销 */ }

  return {
    offsetNo, entId, year: y, assetNo: asset.asset_no, assetType: asset.asset_type,
    amount: amt, quotaBefore, quotaAfter,
    chainBlockIndex: res.blockIndex, chainTxId: res.txId,
  };
}

module.exports = {
  CREDIT_TYPES, OFFSET_RATIO_LIMIT, typeCn,
  listAssets, summary, offsetStatus, listOffsets, applyOffset,
};
