/**
 * anchor.js —— 业务动作上链服务
 * ------------------------------------------------------------------
 * 业务代码只需要调用 anchor()，即可完成：
 *   构造交易 → 用发起方私钥 ECDSA 签名 → 进入交易池 → 打包 → PoA 轮值节点出块 → 返回区块高度与交易号
 * 业务表再回写 chain_block_index / chain_tx_id，形成"链上链下双记录"，
 * 任何一方被篡改都能通过比对发现。
 */
'use strict';

const config = require('../config');
const db = require('../db');
const keystore = require('../blockchain/keystore');
const { Blockchain } = require('../blockchain/chain');

let chain = null;

/** 取全局唯一链实例（懒加载 + 从数据库恢复） */
async function getChain() {
  if (!chain) {
    /* ⚠ 必须传 `db.chainPool` 而不是 `db.pool`：
     * 链内核会执行 `SET time_zone='+00:00'`（为了 DATETIME ↔ 秒数的跨库恒等），
     * 这条会话级 SET 会随连接回到池里。若与业务共池，会污染业务的 NOW() 口径，
     * 使按时间窗的统计静默判错。理由详见 server/db.js#chainPool 的注释。 */
    chain = new Blockchain(db.chainPool, config.chain);
    await chain.init();
  }
  return chain;
}

/**
 * 上链存证
 * @param {object} p
 *   p.txType     EMISSION_REPORT / VERIFY_REPORT / QUOTA_ALLOC / ENTERPRISE_REG
 *   p.bizNo      业务单号
 *   p.fromLabel  发起方 keystore 标签，如 'ent:12' / 'verifier:3' / 'regulator:system'
 *   p.toLabel    接收方标签（可省略，默认监管节点）
 *   p.payload    业务数据快照
 * @returns {Promise<{txId:string, blockIndex:number, blockHash:string, txHash:string}>}
 */
async function anchor(p) {
  const c = await getChain();
  /* ⚠ 2026-10-29 归一化：undefined 键在两条序列化路径上口径不同——
   *   payloadHash 用 stableStringify（undefined → null），
   *   payload_json 用 JSON.stringify（undefined 键直接丢弃）。
   *   只要 payload 里有 undefined 值的键，锚定后链下绑定校验必 mismatch
   *   （实测：EPA 批次 payload.facility.id 因 SELECT 漏列触发）。
   *   在进 buildTx 前先递归剔除 undefined 键，让哈希与存储口径恒一致。 */
  const stripUndefined = (v) => {
    if (Array.isArray(v)) return v.map(stripUndefined);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) {
        if (v[k] !== undefined) o[k] = stripUndefined(v[k]);
      }
      return o;
    }
    return v;
  };
  if (p.payload) p.payload = stripUndefined(p.payload);
  const from = keystore.walletFor(p.fromLabel || 'regulator:system');
  const to = p.toLabel ? keystore.walletFor(p.toLabel) : keystore.systemWallet();

  const tx = c.buildTx({
    txType: p.txType,
    bizNo: p.bizNo || null,
    fromAddress: from.address,
    toAddress: to.address,
    payload: p.payload || {},
    privateKey: from.privateKey,
    publicKey: from.publicKey,
    fee: p.fee === undefined ? 0.002 : p.fee,
  });

  const { block } = await c.submitTx(tx);
  return {
    txId: tx.txId,
    payloadHash: tx.payloadHash,
    signature: tx.signature,
    fromAddress: from.address,
    blockIndex: block ? block.index : null,
    blockHash: block ? block.hash : null,
    blockTime: block ? new Date(block.timestamp * 1000) : null,
  };
}

/** 业务动作完成后清理内存链缓存（用于初始化/修复后刷新） */
async function reload() {
  chain = null;
  return getChain();
}

module.exports = { getChain, anchor, reload };
