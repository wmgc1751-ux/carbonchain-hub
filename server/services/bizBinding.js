/**
 * bizBinding.js —— 第六道校验：业务行 ↔ 链上摘要 绑定核对
 * ------------------------------------------------------------------
 * 为什么需要这一道（评审指出的「信任模型硬伤」的直接回应）
 * ---------------------------------------------------------------
 * 平台原有五道校验里，第⑤道「链下重算绑定」重算的是 `chain_tx.payload_json`
 * 的 SHA-256，与链上 `payload_hash` 比对。它证明的是**存证快照**没被改，
 * 却证明不了**业务表里的那一行**没被改 —— 因为业务表与 payload 是两份副本，
 * 二者之间没有任何校验关系。
 *
 * 于是存在一条五道校验全部放行的攻击路径：
 *     UPDATE emission_report SET total_emission = total_emission - 10000 WHERE id = 7;
 * 它只改业务库（页面展示、监管查询、动态核算都读这一行），链上快照纹丝不动，
 * 五道校验全绿。这就是「链上锚点与链下明文同库，一条 UPDATE 即可同时篡改」的
 * 真正含义：**不是链被改了，而是被改的那份数据根本不在校验范围内**。
 *
 * 本模块补上这一段：以 `chain_tx.biz_no` 关联业务单号，把链上 payload 中的
 * 关键数值/文本字段与业务表的对应列逐项比对，任何一项不一致即报
 * `BIZ_BINDING_MISMATCH`。它是「对账式」校验，不改变链上数据，也不进
 * 主链校验的默认路径（避免每次全链校验都扫全部业务表），而是：
 *   · 由监管端穿透核验接口 `GET /api/chain/business-binding` 按需触发；
 *   · 由 `tools/attack-same-db.mjs` 作为「同库同改」攻击用例的判定依据。
 *
 * ⚠ 口径说明（如实披露）：本道只能校验**已声明映射**的字段。未在 FIELD_MAP
 * 中登记的字段、以及聚合计算出的派生值（如碳足迹分摊结果），不在本道覆盖范围内，
 * 需要由对应的业务对账判据（§3.7 双轨对账）另行覆盖。
 */
'use strict';

const db = require('../db');

/**
 * 交易类型 → { 业务表, 单号列, 字段映射: 链上 payload 键 → 业务表列 }
 * 只登记"决定权利与义务"的关键字段；描述性字段（企业名称变更等）不参与比对。
 */
const FIELD_MAP = {
  EMISSION_REPORT: {
    table: 'emission_report',
    key: 'report_no',
    label: '排放上报',
    fields: {
      scope1: 'scope1_emission',
      scope2: 'scope2_emission',
      totalEmission: 'total_emission',
      intensity: 'intensity',
    },
  },
  VERIFY_REPORT: {
    table: 'verify_report',
    key: 'report_no',
    label: '核查报告',
    fields: {
      deviationRate: 'deviation_rate',
      conclusion: 'conclusion',
      sealHash: 'seal_hash',
    },
  },
  QUOTA_ALLOC: {
    table: 'quota_allocation',
    key: 'alloc_no',
    label: '配额分配',
    fields: { quotaAmount: 'quota_amount' },
  },
  CREDIT_ASSET: {
    table: 'credit_asset',
    key: 'asset_no',
    label: '碳信用资产',
    fields: { amount: 'amount' },
  },
  CREDIT_OFFSET: {
    table: 'credit_offset',
    key: 'offset_no',
    label: '碳信用抵销',
    fields: { amount: 'amount' },
  },
  TRADE_DEAL: {
    table: 'trade_deal',
    key: 'deal_no',
    label: '交易成交',
    fields: { price: 'price', amount: 'amount', totalAmount: 'total_amount', fee: 'fee' },
  },
  ENTERPRISE_REG: {
    table: 'enterprise',
    key: 'ent_code',
    label: '企业备案',
    fields: { industry: 'industry', region: 'region', wallet: 'wallet_address' },
  },
  FACTOR_VERSION: {
    table: 'factor_version',
    key: 'version',
    label: '因子版本',
    fields: { version: 'version' },
    /* 存证单号带业务前缀 FV-，而 factor_version.version 只存 v2026.1。
     * 关联前统一剥掉前缀，避免"单号口径不同"被误报成失配。 */
    normalizeKey: (bizNo) => String(bizNo).replace(/^FV-/, ''),
  },
};

/** 单号规范化：不同类型的历史单号带不同前缀，关联前统一口径 */
function normKey(m, bizNo) {
  const v = String(bizNo);
  return m.normalizeKey ? m.normalizeKey(v) : v;
}

/** 数值比较：DECIMAL 落库会补零，字符串/数字混用一律按数值比，容差取相对 1e-6 与 0.01 的较大者 */
function sameValue(onChain, offChain) {
  if (onChain === null || onChain === undefined) return offChain === null || offChain === undefined;
  if (offChain === null || offChain === undefined) return false;
  const a = Number(onChain);
  const b = Number(offChain);
  if (Number.isFinite(a) && Number.isFinite(b)) {
    const tol = Math.max(Math.abs(b) * 1e-6, 0.01);
    return Math.abs(a - b) <= tol;
  }
  return String(onChain) === String(offChain);
}

/**
 * 核对业务表与链上存证的绑定关系。
 * @param {object} [opts]
 *   opts.txType  只核对某一种交易类型
 *   opts.limit   最多核对多少笔（默认全部）
 *   opts.sinceBlock 只核对某高度之后的存证
 * @returns {Promise<{checked:number, ok:number, missing:number, mismatches:Array, byType:object, elapsedMs:number}>}
 */
async function verifyBusinessBinding(opts = {}) {
  const t0 = Date.now();
  const where = ['block_index IS NOT NULL', 'biz_no IS NOT NULL'];
  const params = [];
  if (opts.txType) { where.push('tx_type = ?'); params.push(String(opts.txType)); }
  if (opts.sinceBlock !== undefined) { where.push('block_index >= ?'); params.push(Number(opts.sinceBlock)); }
  const limit = Number(opts.limit) > 0 ? ` LIMIT ${Math.floor(Number(opts.limit))}` : '';

  /* 链表在账本库，走 ledgerQuery；业务行在业务库，走 query。
   * 注意不能写成一个跨库 JOIN：两库可能不在同一实例上（生产配置允许分离部署）。 */
  const txs = await db.ledgerQuery(
    `SELECT tx_id, tx_type, biz_no, block_index, payload_json
       FROM chain_tx
      WHERE ${where.join(' AND ')}
      ORDER BY block_index ASC, id ASC${limit}`,
    params
  );

  const byType = {};
  const mismatches = [];
  let checked = 0;
  let missing = 0;

  /* 只评估每个业务单的**最新锚点**（按 block_index 取最大）。
   * ⚠ 2026-10-31（CCD-011 修复轮）：reanchor 重锚后同一单存在新旧两条交易，
   * 旧交易的 payload 是被替代的历史快照——把它当失配会把"重锚成功"误报成
   * "绑定漂移"。绑定关系 = 业务行 chain_tx_id 指向的当前交易；历史交易
   * 按链不可变语义保留，不参与比对。 */
  const latest = new Map();
  for (const t of txs) {
    const k = `${t.tx_type}|${String(t.biz_no)}`;
    const prev = latest.get(k);
    if (!prev || Number(t.block_index) > Number(prev.block_index)) latest.set(k, t);
  }
  const deduped = [...latest.values()];

  /* 按类型分批取业务行，避免「每笔一次查询」的 N+1 */
  const groups = new Map();
  for (const t of deduped) {
    const m = FIELD_MAP[t.tx_type];
    if (!m) continue;
    if (!groups.has(t.tx_type)) groups.set(t.tx_type, []);
    groups.get(t.tx_type).push(t);
  }

  for (const [txType, list] of groups) {
    const m = FIELD_MAP[txType];
    const keys = [...new Set(list.map((t) => normKey(m, t.biz_no)))];
    const rows = [];
    const CHUNK = 500;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const slice = keys.slice(i, i + CHUNK);
      const ph = slice.map(() => '?').join(',');
      const part = await db.query(
        `SELECT * FROM ${m.table} WHERE ${m.key} IN (${ph})`, slice
      );
      rows.push(...part);
    }
    const rowMap = new Map(rows.map((r) => [String(r[m.key]), r]));
    byType[txType] = { label: m.label, table: m.table, checked: 0, ok: 0, missing: 0, mismatch: 0 };

    for (const t of list) {
      checked++;
      byType[txType].checked++;
      const row = rowMap.get(normKey(m, t.biz_no));
      if (!row) {
        missing++;
        byType[txType].missing++;
        mismatches.push({
          txId: t.tx_id, txType, bizNo: t.biz_no, table: m.table,
          field: m.key, onChain: String(t.biz_no), offChain: null,
          reason: 'MISSING_BIZ_ROW',
        });
        continue;
      }
      let payload;
      try { payload = JSON.parse(t.payload_json || '{}'); } catch (e) { payload = null; }
      if (!payload) {
        mismatches.push({
          txId: t.tx_id, txType, bizNo: t.biz_no, table: m.table,
          field: 'payload_json', onChain: '(unparsable)', offChain: null,
          reason: 'PAYLOAD_UNPARSABLE',
        });
        byType[txType].mismatch++;
        continue;
      }
      let dirty = false;
      for (const [pKey, col] of Object.entries(m.fields)) {
        if (!(pKey in payload)) continue;   // 旧版存证没有该字段 → 不判失配（口径收敛，不臆断）
        if (!sameValue(payload[pKey], row[col])) {
          dirty = true;
          mismatches.push({
            txId: t.tx_id, txType, bizNo: t.biz_no, table: m.table,
            field: `${m.table}.${col}`, onChain: payload[pKey], offChain: row[col],
            reason: 'BIZ_BINDING_MISMATCH',
          });
        }
      }
      if (dirty) byType[txType].mismatch++;
      else byType[txType].ok++;
    }
  }

  const okCount = Object.values(byType).reduce((s, x) => s + x.ok, 0);
  /* 2026-11-01 交付复检修复：原实现把 MISSING_BIZ_ROW（链上有存证、业务行已被清理，
   * 典型是测试数据或作废单）也计入 mismatch，导致"基线未篡改"就跑出 DETECTED，
   * 演练脚本因此整轮判失败。语义上二者不同：
   *   · MISSING_BIZ_ROW  —— 链不可删、业务行可删，属正常账实差异，单列 missing
   *   · BIZ_BINDING_MISMATCH —— 两边都在但内容不一致，这才是篡改信号
   * 只有后者（以及载荷不可解析）才应触发 DETECTED。 */
  const dirty = mismatches.filter((m) => m.reason === 'BIZ_BINDING_MISMATCH').length;
  const unparsable = mismatches.filter((m) => m.reason === 'PAYLOAD_UNPARSABLE').length;
  return {
    code: (dirty + unparsable) ? 'BIZ_BINDING_MISMATCH' : 'BIZ_BINDING_OK',
    checked,
    ok: okCount,
    missing,
    mismatch: dirty + unparsable,
    byType,
    mismatches: mismatches.slice(0, 200),
    elapsedMs: Date.now() - t0,
    note: '业务行与链上摘要逐字段比对；mismatch 仅统计「两边都在但不一致」（篡改信号），'
      + 'missing 为「链上有存证、业务行已不存在」，属账实差异不计入失配。',
  };
}

module.exports = { verifyBusinessBinding, FIELD_MAP, sameValue };
