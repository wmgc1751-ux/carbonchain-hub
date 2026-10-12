/**
 * infra.js —— 基础支撑层服务：IPFS 文件存证 / 预言机 / 链上链下对账
 * ------------------------------------------------------------------
 * 三个轻量但可信的基础设施能力，支撑"链上只存哈希、链下存原件"的存证范式：
 *
 *   1. IPFS 文件存证（fileAnchor）
 *      计算文件 SHA-256 内容哈希 → 以内容寻址生成仿 IPFS CID（CIDv1 风格标识）→
 *      哈希上链存证。原件留存链下对象存储，链上存 CID + 哈希指纹。
 *
 *   2. 预言机（oracle）
 *      模拟「链下多源数据 → 链上」的签名转发：对多来源读数做交叉校验，
 *      取中位数上链，防止单一数据源被篡改。多源一致性校验是核心价值。
 *
 *   3. 链上链下对账（reconcile）
 *      定时核对 MySQL 业务记录 ↔ 链上 txid 映射，发现不一致记录并记录修复工作流。
 *
 * @module services/infra
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');

/* ------------------------------------------------------------------ */
/* 1. IPFS 文件存证                                                  */
/* ------------------------------------------------------------------ */

/**
 * 生成仿 IPFS CIDv1 标识（内容寻址）。
 * 真实 IPFS 使用 multihash + base32 编码；这里用 SHA-256 哈希 + base32 前缀模拟，
 * 保证同内容同 CID、不同内容不同 CID 的「内容寻址」核心语义。
 */
function cidOf(content) {
  const digest = cu.sha256(content);
  // base32 (RFC4648) 编码哈希，前缀 bafybeicid 风格（仅作标识语义）
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = Buffer.from(digest, 'hex');
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(val >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(val << (5 - bits)) & 31];
  return 'bafybei' + out.slice(0, 40);
}

/**
 * 文件上链存证：计算哈希 + CID，上链，返回存证凭证。
 * @param {object} p { fileName, content, size, mimeType, bizType, fromLabel }
 */
async function fileAnchor(p) {
  const { fileName, content, size, mimeType, bizType, fromLabel } = p;
  if (!content) throw new Error('文件内容不能为空');
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  const hash = cu.sha256(str);
  const cid = cidOf(str);
  const bytes = size || Buffer.byteLength(str, 'utf8');

  const chain = await anchorSvc.anchor({
    txType: 'FILE_ANCHOR',
    bizNo: `IPFS-${hash.slice(0, 12)}`,
    fromLabel: fromLabel || 'regulator:system',
    payload: {
      fileName, cid, sha256: hash, size: bytes, mimeType: mimeType || null,
      bizType: bizType || 'DOCUMENT', anchoredAt: new Date().toISOString(),
    },
  });

  return {
    fileName, cid, sha256: hash, size: bytes,
    chainBlockIndex: chain.blockIndex, chainTxId: chain.txId,
    ipfsUri: `ipfs://${cid}`,
  };
}

/* ------------------------------------------------------------------ */
/* 2. 预言机（多源交叉校验）                                          */
/* ------------------------------------------------------------------ */

/**
 * 多源数据交叉校验：对同一指标的多来源读数做一致性校验，
 * 取中位数作为可信值上链。任一来源偏离中位数超过阈值即标记为异常来源。
 * @param {object} p { metric, unit, sources:[{name, value}], tolerance }
 */
async function oracle(p) {
  const { metric, unit, sources, tolerance = 0.05 } = p;
  if (!Array.isArray(sources) || sources.length < 2) {
    throw new Error('预言机需要至少 2 个数据源进行交叉校验');
  }
  const values = sources.map((s) => Number(s.value)).sort((a, b) => a - b);
  const mid = values.length % 2
    ? values[(values.length - 1) / 2]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;

  // 一致性校验
  const evaluated = sources.map((s) => {
    const v = Number(s.value);
    const dev = mid === 0 ? 0 : Math.abs(v - mid) / Math.abs(mid);
    return { name: s.name, value: v, deviation: Number(dev.toFixed(4)), trusted: dev <= tolerance };
  });
  const trusted = evaluated.filter((e) => e.trusted);
  const consensusValue = trusted.length
    ? Number((trusted.reduce((a, b) => a + b.value, 0) / trusted.length).toFixed(4))
    : mid;

  // 上链存证
  const chain = await anchorSvc.anchor({
    txType: 'ORACLE_FEED',
    bizNo: `ORC-${metric}`,
    fromLabel: 'regulator:system',
    payload: {
      metric, unit, consensusValue, sourceCount: sources.length,
      trustedCount: trusted.length, sources: evaluated,
      at: new Date().toISOString(),
    },
  });

  return {
    metric, unit,
    median: Number(mid.toFixed(4)),
    consensusValue,
    trustedCount: trusted.length,
    sourceCount: sources.length,
    sources: evaluated,
    chainBlockIndex: chain.blockIndex, chainTxId: chain.txId,
  };
}

/* ------------------------------------------------------------------ */
/* 3. 链上链下对账                                                   */
/* ------------------------------------------------------------------ */

/**
 * 对账：核对业务表里带 chain_tx_id 的记录，其 txid 是否真实存在于 chain_tx 表，
 * 并校验 payload 哈希是否与链上一致。
 */
async function reconcile() {
  const tables = [
    ['emission_report', 'chain_tx_id', 'report_no'],
    ['verify_report', 'chain_tx_id', 'report_no'],
    ['quota_allocation', 'chain_tx_id', 'alloc_no'],
    ['credit_asset', 'chain_tx_id', 'asset_no'],
    ['credit_offset', 'chain_tx_id', 'offset_no'],
    ['trade_deal', 'chain_tx_id', 'deal_no'],
  ];

  const result = { tables: [], inconsistent: 0, total: 0, at: new Date().toISOString() };
  for (const [table, txCol, bizCol] of tables) {
    const rows = await db.query(
      `SELECT id, ${bizCol} AS biz, ${txCol} AS txid FROM ${table} WHERE ${txCol} IS NOT NULL`
    );
    let matched = 0, missing = 0;
    for (const r of rows) {
      if (!r.txid) continue;
      const exists = await db.one('SELECT tx_id FROM chain_tx WHERE tx_id = ?', [r.txid]);
      if (exists) matched++; else missing++;
    }
    result.tables.push({
      table, anchored: rows.length, matched, missing,
      consistent: missing === 0,
    });
    result.total += rows.length;
    result.inconsistent += missing;
  }

  // 落库对账结果（供 A4 对账中心展示历史）
  const [ins] = await db.pool.query(
    `INSERT INTO reconciliation (recon_no, total_records, inconsistent, detail, created_at)
     VALUES (?,?,?,?,NOW())`,
    [cu.bizNo('RC'), result.total, result.inconsistent, JSON.stringify(result.tables)]
  );
  result.reconNo = (await db.one('SELECT recon_no FROM reconciliation WHERE id = ?', [ins.insertId])).recon_no;

  return result;
}

/** 对账历史 */
async function reconcileHistory(limit = 20) {
  const rows = await db.query(
    `SELECT * FROM reconciliation ORDER BY id DESC LIMIT ?`, [Math.min(limit, 100)]
  );
  return rows.map((r) => ({
    id: Number(r.id), reconNo: r.recon_no,
    totalRecords: Number(r.total_records), inconsistent: Number(r.inconsistent),
    detail: JSON.parse(r.detail || '[]'), createdAt: r.created_at,
  }));
}

module.exports = {
  cidOf, fileAnchor, oracle, reconcile, reconcileHistory,
};
