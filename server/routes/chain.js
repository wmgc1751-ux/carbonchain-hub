/**
 * routes/chain.js —— 区块链浏览器 API
 * 区块查询 / 交易查询 / 全链校验 / 篡改演示 / 手动出块
 *
 * 说明：本模块的读接口完全开放（体现"公有链可审计"的特性）；
 * 篡改与修复接口属于教学演示用的受控接口，由 config.chain.demoEndpoints 开关控制，
 * 生产环境应予以关闭或仅对监管节点内网开放。
 */
'use strict';

const express = require('express');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');
const { authRequired, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();

const TX_TYPE_CN = {
  EMISSION_REPORT: '排放上报存证',
  VERIFY_REPORT: '核查报告存证',
  QUOTA_ALLOC: '配额分配存证',
  TRADE_DEAL: '交易成交存证',
  ENTERPRISE_REG: '企业备案存证',
};

/** 演示接口开关（可用环境变量 CHAIN_DEMO=false 关闭） */
const DEMO = process.env.CHAIN_DEMO !== 'false';
function demoOnly(req, res, next) {
  if (!DEMO) return fail(res, '演示接口已在当前环境中关闭', 403);
  next();
}

/* 链概况 ------------------------------------------------------------ */
router.get('/stats', wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  const stats = await chain.stats();
  const byBiz = await db.query(
    `SELECT tx_type AS type, COUNT(*) AS cnt FROM chain_tx GROUP BY tx_type ORDER BY cnt DESC`
  );
  const size = await db.one(
    `SELECT IFNULL(SUM(size_bytes),0) AS s, IFNULL(SUM(tx_count),0) AS t FROM chain_block`
  );
  const holders = await db.query(
    `SELECT e.ent_name AS name, e.wallet_address AS address, COUNT(t.tx_id) AS cnt
     FROM enterprise e LEFT JOIN chain_tx t ON t.from_address = e.wallet_address
     GROUP BY e.id ORDER BY cnt DESC LIMIT 10`
  );
  ok(res, {
    ...stats,
    byBizType: byBiz.map((b) => ({ ...b, typeCn: TX_TYPE_CN[b.type] || b.type, cnt: Number(b.cnt) })),
    totalSize: Number(size.s),
    totalTxInBlocks: Number(size.t),
    topAccounts: holders.map((h) => ({ ...h, cnt: Number(h.cnt) })),
  });
}));

/* 区块列表 ---------------------------------------------------------- */
router.get('/blocks', wrap(async (req, res) => {
  const page = await db.paginate(
    `SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, tx_count,
            miner, size_bytes, mine_time, UNIX_TIMESTAMP(block_time) AS ts, block_time
     FROM chain_block ORDER BY block_index DESC`, [], req.query
  );
  ok(res, page);
}));

/* 区块详情（含区块内交易） ------------------------------------------- */
router.get('/blocks/:index', wrap(async (req, res) => {
  const b = await db.one(
    'SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index = ?', [req.params.index]
  );
  if (!b) return fail(res, '区块不存在', 404);
  const txs = await db.query(
    `SELECT tx_id, tx_type, biz_no, from_address, to_address, payload_hash, payload_json,
            nonce, gas_fee, status, created_at
     FROM chain_tx WHERE block_index = ? ORDER BY id`, [req.params.index]
  );
  const hashes = txs.map((t) => t.tx_id);
  const proof = cu.merkleProof(hashes, 0);

  const block = {
    index: Number(b.block_index), hash: b.block_hash, prevHash: b.prev_hash,
    merkleRoot: b.merkle_root, nonce: Number(b.nonce), difficulty: Number(b.difficulty),
    txCount: Number(b.tx_count), miner: b.miner, sizeBytes: Number(b.size_bytes),
    mineTime: Number(b.mine_time), blockTime: b.block_time, timestamp: Number(b.ts),
  };
  // 现场重算：本区块记录哈希与实时重算哈希是否一致
  const recomputed = require('../blockchain/chain').Blockchain.calcHash(block);

  ok(res, {
    block,
    recomputedHash: recomputed,
    hashMatch: recomputed === block.hash,
    merkle: { root: proof.root, rootMatches: proof.root === block.merkle_root, samplePath: proof.path },
    transactions: txs.map((t) => ({
      ...t,
      txTypeCn: TX_TYPE_CN[t.tx_type] || t.tx_type,
      nonce: Number(t.nonce),
      gas_fee: Number(t.gas_fee),
      payload: typeof t.payload_json === 'string' ? safeParse(t.payload_json) : t.payload_json,
    })),
  });
}));

/* 交易列表 ---------------------------------------------------------- */
router.get('/txs', wrap(async (req, res) => {
  const { type, status, keyword, blockIndex } = req.query;
  const where = ['1=1'];
  const params = [];
  if (type) { where.push('tx_type = ?'); params.push(type); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (blockIndex !== undefined && blockIndex !== '') { where.push('block_index = ?'); params.push(Number(blockIndex)); }
  if (keyword) { where.push('(tx_id LIKE ? OR biz_no LIKE ? OR from_address LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  const page = await db.paginate(
    `SELECT id, tx_id, tx_type, biz_no, block_index, from_address, to_address, payload_hash,
            nonce, gas_fee, status, created_at, confirmed_at
     FROM chain_tx WHERE ${where.join(' AND ')} ORDER BY id DESC`, params, req.query
  );
  ok(res, { ...page, rows: page.rows.map((r) => ({ ...r, txTypeCn: TX_TYPE_CN[r.tx_type] || r.tx_type, nonce: Number(r.nonce), gas_fee: Number(r.gas_fee) })) });
}));

/* 交易详情（验签 + Merkle 证明） ------------------------------------- */
router.get('/tx/:txId', wrap(async (req, res) => {
  const tx = await db.one('SELECT * FROM chain_tx WHERE tx_id = ?', [req.params.txId]);
  if (!tx) return fail(res, '交易不存在', 404);

  const block = tx.block_index === null ? null : await db.one(
    'SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index = ?', [tx.block_index]
  );
  let merkle = null;
  if (block) {
    const list = await db.query('SELECT tx_id FROM chain_tx WHERE block_index = ? ORDER BY id', [tx.block_index]);
    const idx = list.findIndex((t) => t.tx_id === tx.tx_id);
    const proof = cu.merkleProof(list.map((t) => t.tx_id), idx);
    merkle = {
      leafIndex: idx, leafHash: tx.tx_id, root: proof.root, path: proof.path,
      rootMatches: proof.root === block.merkle_root,
      verified: cu.verifyMerkleProof(tx.tx_id, proof.path, proof.root),
    };
  }
  const signatureValid = tx.signature
    ? cu.verify(tx.pub_key, cu.stableStringify({
      txId: tx.tx_id, txType: tx.tx_type, bizNo: tx.biz_no, fromAddress: tx.from_address,
      toAddress: tx.to_address, payloadHash: tx.payload_hash, nonce: Number(tx.nonce),
    }), tx.signature)
    : false;

  const payload = typeof tx.payload_json === 'string' ? safeParse(tx.payload_json) : tx.payload_json;
  const payloadIntact = cu.hashObject(payload) === tx.payload_hash;

  ok(res, {
    tx: {
      txId: tx.tx_id, txType: tx.tx_type, txTypeCn: TX_TYPE_CN[tx.tx_type] || tx.tx_type,
      bizNo: tx.biz_no, blockIndex: tx.block_index, from: tx.from_address, to: tx.to_address,
      payloadHash: tx.payload_hash, nonce: Number(tx.nonce), fee: Number(tx.gas_fee),
      status: tx.status, signature: tx.signature, pubKey: tx.pub_key, createdAt: tx.created_at,
    },
    payload,
    block: block && {
      index: Number(block.block_index), hash: block.block_hash, prevHash: block.prev_hash,
      merkleRoot: block.merkle_root, nonce: Number(block.nonce), difficulty: Number(block.difficulty),
      blockTime: block.block_time, miner: block.miner,
    },
    verify: { signatureValid, payloadIntact },
    merkle,
  });
}));

/* 交易池 ------------------------------------------------------------ */
router.get('/pool', wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT tx_id, tx_type, biz_no, from_address, payload_hash, status, created_at
     FROM chain_tx WHERE status = 'PENDING' ORDER BY id DESC LIMIT 50`
  );
  const chain = await anchorSvc.getChain();
  ok(res, { count: chain.pool.length, rows });
}));

/* 全链完整性校验 ----------------------------------------------------- */
router.get('/validate', wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  const r = await chain.validateChain({ fromIndex: Number(req.query.fromIndex) || 0 });
  ok(res, {
    ...r,
    errors: r.errors.slice(0, 50),
    errorCount: r.errors.length,
    criteria: [
      '① 逐块重算 SHA-256，比对记录的区块哈希',
      '② 校验每块是否满足 PoW 难度（前导零个数）',
      '③ 校验 prevHash 是否指向上一区块（链是否连续）',
      '④ 由链上交易表重算 Merkle 根，与区块头比对（交易是否被增删改）',
    ],
  });
}));

/* 篡改演示 ---------------------------------------------------------- */
router.post('/tamper', demoOnly, wrap(async (req, res) => {
  const { blockIndex, field } = req.body || {};
  const chain = await anchorSvc.getChain();
  const r = await chain.tamper(Number(blockIndex), field || 'merkle_root');
  ok(res, r, `已模拟篡改区块 #${r.blockIndex} 的 ${r.field} 字段，全链校验结果：${r.validation.valid ? '未发现异常' : `发现 ${r.validation.errors.length} 处异常`}`);
}));

/* 修复链（重做后缀 PoW） --------------------------------------------- */
router.post('/repair', demoOnly, wrap(async (req, res) => {
  const fromIndex = Number((req.body || {}).fromIndex) || 0;
  const chain = await anchorSvc.getChain();
  const r = await chain.repairChain(fromIndex);
  ok(res, r, `已从区块 #${fromIndex} 起重算后缀哈希并重做工作量证明，共修复 ${r.repaired.length} 个区块`);
}));

/* 手动出块 ---------------------------------------------------------- */
router.post('/mine', demoOnly, wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  if (!chain.pool.length) return fail(res, '当前交易池为空，无可打包交易', 400);
  const block = await chain.mineBlock();
  if (req.user) await writeLog(req, '链上存证', '手动出块', `#${block.index}`, `打包 ${block.txCount} 笔交易`);
  ok(res, block, `出块成功：#${block.index}，打包 ${block.txCount} 笔交易，耗时 ${block.mineTime}ms`);
}));

/** 通用：按地址查询该主体的全部存证 */
router.get('/address/:address', wrap(async (req, res) => {
  const addr = req.params.address;
  const ent = await db.one('SELECT id, ent_name, industry, region FROM enterprise WHERE wallet_address = ?', [addr]);
  const ver = await db.one('SELECT id, org_name, region FROM verifier_org WHERE wallet_address = ?', [addr]);
  const txs = await db.query(
    `SELECT tx_id, tx_type, biz_no, block_index, to_address, payload_hash, created_at
     FROM chain_tx WHERE from_address = ? ORDER BY id DESC LIMIT 100`, [addr]
  );
  const stats = await db.one(
    `SELECT COUNT(*) AS cnt, IFNULL(SUM(gas_fee),0) AS fee FROM chain_tx WHERE from_address = ?`, [addr]
  );
  ok(res, {
    address: addr,
    owner: ent ? { type: 'ENTERPRISE', ...ent } : (ver ? { type: 'VERIFIER', ...ver } : null),
    txCount: Number(stats.cnt),
    totalFee: Number(stats.fee),
    txs: txs.map((t) => ({ ...t, txTypeCn: TX_TYPE_CN[t.tx_type] || t.tx_type })),
  });
}));

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = router;
