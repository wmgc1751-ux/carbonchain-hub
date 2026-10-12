/**
 * routes/chain.js —— 区块链浏览器 API
 * 区块查询 / 交易查询 / 全链校验 / 篡改演示 / 手动出块
 *
 * 说明：本模块的读接口完全开放（体现"公有链可审计"的特性）；
 * 篡改 / 还原 / 手动出块属于**破坏性写接口**，由环境变量 CHAIN_DEMO 控制，
 * **生产环境默认关闭**（安全默认），需显式 CHAIN_DEMO=true 才开放，供答辩演示或内网教学使用。
 */
'use strict';

const express = require('express');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');
const anchorBatch = require('../services/anchorBatch');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();

const TX_TYPE_CN = {
  EMISSION_REPORT: '排放上报存证',
  VERIFY_REPORT: '核查报告存证',
  QUOTA_ALLOC: '配额分配存证',
  ENTERPRISE_REG: '企业备案存证',
  TRADE_DEAL: '履约流转成交存证',
  CREDIT_ASSET: '碳信用资产存证',
  FACTOR_VERSION: '因子版本发布存证',
  CEMS_BATCH: 'CEMS 实测批次存证',
  FILE_ANCHOR: '文件存证',
  ORACLE_FEED: '预言机数据存证',
  ANCHOR_BATCH: '批量锚点存证',
};

/**
 * 演示接口开关（安全默认：线上关闭）。
 * 原实现为 `process.env.CHAIN_DEMO !== 'false'` —— 即**线上默认开启**，
 * 意味着公网上任何人都能调用 /api/chain/tamper 去改写链上数据、调用 /repair 重挖后缀块。
 * 这些是**破坏性写接口**，绝不能默认暴露。现改为与 config.demoAccounts 一致的口径：
 *   显式 CHAIN_DEMO=true / false 优先；未设置时，只有非生产环境开放。
 */
const { isProd } = require('../config');
const DEMO = process.env.CHAIN_DEMO === 'true'
  || (process.env.CHAIN_DEMO === undefined && !isProd);
function demoOnly(req, res, next) {
  if (!DEMO) {
    return fail(res, '演示接口已在当前环境关闭（生产环境默认关闭；如需开启请显式设置 CHAIN_DEMO=true）', 403);
  }
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
    `SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, consensus,
            proposer, proposer_sig, tx_count, miner, size_bytes, mine_time,
            UNIX_TIMESTAMP(block_time) AS ts, block_time
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
    consensus: b.consensus || 'POW', proposer: b.proposer || null, proposerSig: b.proposer_sig || null,
    txCount: Number(b.tx_count), miner: b.miner, sizeBytes: Number(b.size_bytes),
    mineTime: Number(b.mine_time), blockTime: b.block_time, timestamp: Number(b.ts),
  };
  // 现场重算：本区块记录哈希与实时重算哈希是否一致
  const recomputed = require('../blockchain/chain').Blockchain.calcHash(block);
  // PoA 出块签名现场验签（证明是本轮授权节点出的块）
  let proposerSigValid = null;
  if (block.consensus === 'POA' && block.proposerSig) {
    try {
      const node = await db.one('SELECT public_key FROM chain_node WHERE node_id = ?', [block.proposer]);
      const pub = node && node.public_key
        ? node.public_key
        : require('../blockchain/keystore').all()[`node:${block.proposer}`]?.publicKey;
      proposerSigValid = !!(pub && cu.verify(pub, require('../blockchain/chain').Blockchain.signingPayload(block), block.proposerSig));
    } catch (e) { proposerSigValid = null; }
  }

  ok(res, {
    block,
    recomputedHash: recomputed,
    hashMatch: recomputed === block.hash,
    proposerSigValid,
    // 注意：这里的 block 是上面重塑过的驼峰对象，字段名是 merkleRoot；
    // 早前误写成 block.merkle_root（那是原始行 b 的字段名），
    // 导致恒为 undefined、rootMatches 永远是 false。改回 merkleRoot 后与 b 同源一致。
    merkle: { root: proof.root, rootMatches: proof.root === block.merkleRoot, samplePath: proof.path },
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
  /* 全链校验是重活（对每个区块做出块签名验签 + Merkle 重建，对每笔交易做链下重算绑定）。
   * 监管端与浏览器会高频轮询本接口，故走带缓存的入口：
   *   · 默认 TTL 5s，且缓存键含链数据变更版本号 —— 出块/篡改/修复会立刻使其失效；
   *   · 传 ?fresh=1 可强制穿透缓存重算（答辩现场演示防篡改时用，确保看到实时结果）。
   * 返回体新增 cached / cacheAgeMs，如实告知调用方本次是否为复用结果。 */
  const fresh = String(req.query.fresh || '') === '1';
  const r = await chain.validateChainCached({
    fromIndex: Number(req.query.fromIndex) || 0,
    ttlMs: fresh ? 0 : 5000,
  });
  ok(res, {
    ...r,
    errors: r.errors.slice(0, 50),
    errorCount: r.errors.length,
    criteria: [
      '① 逐块重算 SHA-256，比对记录的区块哈希（区块内容是否被改动）',
      '② 校验每块的共识合法性：PoA 块验「出块节点签名 + 联盟授权资格」；历史 PoW 块验难度前导零',
      '③ 校验 prevHash 是否指向上一区块（链是否连续、区块是否被抽换）',
      '④ 由链上交易表重算 Merkle 根，与区块头比对（区块内交易是否被增删改）',
      '⑤ 链下重算绑定：用链下业务明文重算 SHA-256，与链上锚定的 payload_hash 比对'
        + '（链下明细是否被改动而链上锚点未变 —— 这是"链上存证 + 链下存储"结构下唯一的链下完整性出口）',
    ],
    // 如实披露本次结果是否为缓存复用。缓存键含链数据变更版本号，
    // 因此任何写入（出块 / 篡改 / 修复）都会即时失效，不存在"链已破坏仍报 valid"的窗口。
    freshness: r.cached
      ? `复用 ${r.cacheAgeMs} ms 前的校验结果（链高与链数据版本均未变化）；如需强制重算请加 ?fresh=1`
      : '本次为实时重算（缓存窗口外，或链数据刚发生变更）',
  });
}));

/* 篡改演示 ---------------------------------------------------------- */
router.post('/tamper', demoOnly, wrap(async (req, res) => {
  const { blockIndex, field } = req.body || {};
  const chain = await anchorSvc.getChain();
  const r = await chain.tamper(Number(blockIndex), field || 'merkle_root');
  const msg = r.field === 'offchain_payload'
    ? `已篡改区块 #${r.blockIndex} 内交易的**链下明细**字段 ${r.changedKey}（链上锚点未动）；`
      + `全链校验结果：${r.validation.valid ? '链上四道校验均通过、第五道亦未告警' : `发现 ${r.validation.errors.length} 处异常（第五道「链下重算绑定」）`}`
    : `已模拟篡改区块 #${r.blockIndex} 的 ${r.field} 字段，全链校验结果：${r.validation.valid ? '未发现异常' : `发现 ${r.validation.errors.length} 处异常`}`;
  ok(res, r, msg);
}));

/* 还原链下明细篡改（配合 field=offchain_payload 的演示） ---------------- */
router.post('/repair-payload', demoOnly, wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  const r = await chain.repairOffChainPayload((req.body || {}).blockIndex);
  ok(res, r, `已还原 ${r.restored} 笔链下明细，第五道校验结果：${r.validation ? (r.validation.valid ? '通过' : '仍有异常') : '无需校验'}`);
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

/* ==================================================================
 * 批量锚定（WP3 链内核规模化）
 * ------------------------------------------------------------------
 * 设计要点：把时间窗内 N 笔业务存证组织为 1 棵 Merkle 树，链上只留 1 个锚点。
 * 读接口开放（可审计性），触发接口需监管/管理角色（属运营动作，非演示破坏性操作）。
 * ================================================================== */

/* 锚定统计（含状态语义说明，防止把 PENDING 误读为"未上链"） */
router.get('/anchor/stats', wrap(async (req, res) => {
  ok(res, await anchorBatch.stats());
}));

/* 批次列表 */
router.get('/anchor/batches', wrap(async (req, res) => {
  const r = await anchorBatch.listBatches({ page: req.query.page, size: req.query.size });
  ok(res, r);
}));

/* 批次详情（含全部叶） */
router.get('/anchor/batch/:batchNo', wrap(async (req, res) => {
  const b = await anchorBatch.getBatch(req.params.batchNo);
  if (!b) return fail(res, `批次 ${req.params.batchNo} 不存在`, 404);
  ok(res, b);
}));

/* 单笔存证的 Merkle 存在性证明（O(log N) 独立验证） */
router.get('/anchor/proof', wrap(async (req, res) => {
  const { batchNo, txId } = req.query;
  if (!batchNo || !txId) return fail(res, '缺少 batchNo 或 txId 参数', 400);
  const p = await anchorBatch.getProof(batchNo, txId);
  if (!p.found) return fail(res, '该存证不属于指定批次', 404);
  ok(res, p);
}));

/* 触发一次批量锚定（监管 / 管理角色） */
router.post('/anchor/run', authRequired, requireRole('REGULATOR'), wrap(async (req, res) => {
  const r = await anchorBatch.createBatch({
    limit: (req.body || {}).limit,
    actor: req.user && req.user.role === 'REGULATOR' ? 'regulator:system' : 'regulator:system',
  });
  if (!r.created) return ok(res, r, r.hint || '当前无可锚定的存证');
  await writeLog(req, '链上存证', '批量锚定',
    r.batchNo, `${r.leafCount} 笔存证 → 1 个锚点，根 ${r.merkleRoot.slice(0, 16)}…`);
  ok(res,
    r,
    `批量锚定完成：${r.leafCount} 笔存证聚合为 1 个锚点（压缩比 ${r.compressionRatio}），`
    + `锚点交易 ${r.anchorTxId.slice(0, 16)}… 落于区块 #${r.anchorBlockIndex}`);
}));

module.exports = router;
