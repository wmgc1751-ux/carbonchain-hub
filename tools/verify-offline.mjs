/**
 * verify-offline.mjs —— 零信任离线复核工具（WP7 可核验性）
 * ==================================================================
 * 为什么它必须"零信任"
 * ------------------------------------------------------------------
 * 平台内已有的 /api/chain/validate 是**服务端自己校验自己**：
 * 无论是"用错了哈希算法"还是"故意放过某条异常"，调用方都无从察觉。
 * 本工具的设计前提是：
 *
 *   ① **不 require 项目任何模块** —— 哈希、Merkle、稳定序列化、ECDSA 验签
 *      全部按公开规范在本文件内**独立重实现**。因此服务端内核若有 bug，
 *      本工具会与它产生分歧并暴露出来，而不是一起错。
 *   ② **不需要数据库、不需要启动服务** —— 只吃一份 JSON 导出。
 *   ③ **可被外部值锚定** —— 支持 --tip <区块哈希> 把校验结果钉在
 *      材料中已公开披露的链顶哈希上，杜绝"事后重造一条自洽的假链"。
 *
 * 它复核什么（六项）
 * ------------------------------------------------------------------
 *   ① 区块头哈希重算        —— 链上区块内容是否被改
 *   ② 前向引用 prevHash     —— 链是否断裂、区块是否被抽换
 *   ③ Merkle 根重算         —— 区块内交易是否被增删
 *   ④ 出块签名与授权资格    —— 是否由获授权节点出块（PoA）
 *   ⑤ 链下重算绑定          —— 链下业务明文是否仍与链上锚定摘要一致
 *   ⑥ 批量锚定一致性        —— 批次 Merkle 根是否与锚点交易载荷内的根一致
 *                              （批次登记值 ↔ 链上锚点 ↔ 叶集合 三方对齐）
 *
 * 用法：
 *   node tools/verify-offline.mjs --input tools/out/chain-export.json
 *   node tools/verify-offline.mjs --input chain.json --tip <区块哈希> --json report.json
 *   node tools/verify-offline.mjs --input chain.json --sample 20   # 抽样证明校验条数
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

/* ==================================================================
 * 第一部分：按公开规范独立重实现全部密码学原语
 * （不使用、不引入项目的 server/blockchain/* —— 这是独立性的核心）
 * ================================================================== */

/** SHA-256（十六进制小写） */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 规范化序列化：**key 必须排序**。
 * 若不排序，{a:1,b:2} 与 {b:2,a:1} 会得到不同摘要 ——
 * 同一份业务数据在不同节点上就得不到一致哈希，共识与复核同时崩塌。
 */
function stableStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** 对象稳定哈希 */
function hashObject(obj) {
  return sha256(stableStringify(obj));
}

/** Merkle 根：奇数节点复制末叶（与比特币同款处理） */
function merkleRoot(hashes) {
  if (!hashes || hashes.length === 0) return '0'.repeat(64);
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    level = next;
  }
  return level[0];
}

/** 校验 Merkle 证明路径 */
function verifyMerkleProof(leafHash, proofPath, root) {
  let cur = leafHash;
  for (const step of proofPath) {
    cur = step.position === 'right' ? sha256(cur + step.hash) : sha256(step.hash + cur);
  }
  return cur === root;
}

/** 区块头哈希（按共识类型分派） */
function calcBlockHash(b) {
  const consensus = String(b.consensus || 'POW').toUpperCase();
  if (consensus === 'POA') {
    return sha256([b.index, b.timestamp, b.merkleRoot, b.prevHash, 'POA', b.proposer || '', b.nonce].join('|'));
  }
  return sha256([b.index, b.timestamp, b.merkleRoot, b.prevHash, b.difficulty, b.nonce].join('|'));
}

/** 出块签名的待签内容（区块头规范序列化） */
function signingPayload(b) {
  return stableStringify({
    index: b.index, timestamp: b.timestamp, merkleRoot: b.merkleRoot,
    prevHash: b.prevHash, consensus: 'POA', proposer: b.proposer || '', nonce: b.nonce,
  });
}

/** 交易签名的待签内容 */
function txSignContent(t) {
  return stableStringify({
    txId: t.txId,
    txType: t.txType,
    bizNo: t.bizNo || null,
    fromAddress: t.fromAddress || 'SYSTEM',
    toAddress: t.toAddress || null,
    payloadHash: t.payloadHash,
    nonce: t.nonce,
  });
}

/** ECDSA(SHA-256) 验签，签名为 base64 */
function ecdsaVerify(publicKeyPem, data, signatureBase64) {
  try {
    const v = crypto.createVerify('SHA256');
    v.update(data, 'utf8');
    v.end();
    return v.verify(publicKeyPem, signatureBase64, 'base64');
  } catch (e) {
    return false;
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/**
 * 从链上原始 UTC 字面量推导 epoch 秒 —— **本工具唯一信任的时间来源**。
 *
 * 为什么不直接用导出文件里的 blocks[].ts：
 *   ts 是 MySQL 的 UNIX_TIMESTAMP(block_time)，其取值依赖**导出时会话时区**。
 *   会话若是 +08:00，同一个 '2026-10-11 11:50:52' 会解出比真实值小 28800 的秒数，
 *   进而让全链区块哈希与出块签名"集体失配"——但这只是读取口径错，链本身没问题。
 *   复核要的是**不依赖导出方环境**的结论，故这里只吃 block_time 字面量。
 *
 * 约定来源：server/blockchain/chain.js#utcDateString —— 链内写入即 UTC 字面量。
 */
function tsFromUtcLiteral(literal) {
  if (literal === null || literal === undefined) return null;
  const s = String(literal).trim();
  if (s === '') return null;
  // 支持 'YYYY-MM-DD HH:mm:ss' 与 'YYYY-MM-DDTHH:mm:ss'，允许尾部毫秒/时区被忽略
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])
  );
  return Math.floor(ms / 1000);
}

/* ==================================================================
 * 第二部分：校验主流程
 * ================================================================== */

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      a[key] = val;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error('用法：node tools/verify-offline.mjs --input <chain-export.json> [--tip <区块哈希>] [--sample N] [--json <输出>]');
  process.exit(2);
}
const inputPath = path.resolve(args.input);
const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const sampleN = Math.max(Number(args.sample) || 5, 0);

const errors = [];
const warns = [];
const coverage = {
  blocksHashRecomputed: 0,
  prevLinkChecked: 0,
  merkleRootsRecomputed: 0,
  txMerkleMembershipVerified: 0,
  proposerSigVerified: 0,
  proposerSigUnverifiable: 0,
  txSignatureVerified: 0,
  txSignatureUnverifiable: 0,
  payloadBindingChecked: 0,
  payloadBoundOk: 0,
  payloadBindingMismatch: 0,
  batchesChecked: 0,
  batchRootConsistent: 0,
  batchLeafProofVerified: 0,
};

const E = (type, message, extra = {}) => errors.push({ type, message, ...extra });
/* 治理告警：与 errors 分开收集 —— 它影响"要不要人去处理"，不影响"数据是否被改"。 */
const W = (type, message) => warns.push(`[${type}] ${message}`);

/* ---------- 0. 入参自检与外部锚定 ---------- */
let tzDriftBlocks = 0;      // 导出 ts 与自推导 ts 不一致的区块数
let tsMissingBlocks = 0;    // 既无 block_time 又无 ts 的区块数

const blocks = (data.blocks || []).map((r) => {
  const derived = tsFromUtcLiteral(r.block_time);
  const exportedTs = Number(r.ts);
  if (derived === null) tsMissingBlocks++;
  else if (Number.isFinite(exportedTs) && exportedTs !== derived) tzDriftBlocks++;
  return {
    index: Number(r.block_index),
    // 以自推导值为准；缺失时退回导出值（并在报告中据此给出提示）
    timestamp: derived === null ? exportedTs : derived,
    timestampExported: Number.isFinite(exportedTs) ? exportedTs : null,
    blockTimeLiteral: r.block_time || null,
    merkleRoot: r.merkle_root,
    prevHash: r.prev_hash,
    difficulty: Number(r.difficulty),
    nonce: Number(r.nonce),
    consensus: String(r.consensus || 'POW').toUpperCase(),
    proposer: r.proposer || null,
    proposerSig: r.proposer_sig || null,
    hash: r.block_hash,
    txCount: Number(r.tx_count),
  };
});
const txs = (data.txs || []).map((r) => ({
  txId: r.tx_id,
  txType: r.tx_type,
  bizNo: r.biz_no,
  blockIndex: r.block_index == null ? null : Number(r.block_index),
  fromAddress: r.from_address,
  toAddress: r.to_address,
  payloadHash: r.payload_hash,
  payloadJson: r.payload_json,
  signature: r.signature,
  pubKey: r.pub_key,
  nonce: Number(r.nonce),
  anchorStatus: r.anchor_status,
  anchorBatchNo: r.anchor_batch_no,
}));
const nodePubKey = new Map();
const nodeAuth = new Map();
for (const n of (data.nodes || [])) {
  if (n.public_key) nodePubKey.set(n.node_id, n.public_key);
  nodeAuth.set(n.node_id, { status: n.status, auth: Number(n.is_authorized) });
}

const tip = blocks.length ? blocks[blocks.length - 1] : null;
if (args.tip) {
  const expect = String(args.tip).trim();
  if (!tip || tip.hash !== expect) {
    E('TIP_MISMATCH',
      `链顶哈希与外部锚定值不符：期望 ${expect.slice(0, 20)}…，实际 ${tip ? tip.hash.slice(0, 20) + '…' : '（空链）'}`,
      { expected: expect, actual: tip ? tip.hash : null });
  }
}

/* 时间口径体检：导出方若未把会话时区钉为 UTC，ts 会整体偏移整数小时。
 * 本工具已改为以 block_time 字面量为准，故此差异不影响结论，但必须显式告知，
 * 否则使用者会误以为"复查结果与平台不一致"。 */
if (tzDriftBlocks > 0) {
  const deltas = new Set();
  for (const b of blocks) {
    if (b.timestampExported !== null && b.timestampExported !== b.timestamp) {
      deltas.add(b.timestampExported - b.timestamp);
    }
  }
  const d = [...deltas];
  const consistent = d.length === 1 && d[0] % 3600 === 0;
  warns.push(`导出文件的 ts 与 block_time 字面量推导值不一致（${tzDriftBlocks}/${blocks.length} 块，`
    + `偏移 ${d.join(' / ')} 秒${consistent ? '，为整数小时，典型会话时区未钉 UTC' : ''}）。`
    + ' 本次复核已按 block_time 的 UTC 口径重算，结论不受影响。');
}
if (tsMissingBlocks > 0) {
  warns.push(`有 ${tsMissingBlocks} 个区块缺少 block_time 字面量，已退回使用导出方提供的 ts（时间口径未经独立验证）。`);
}

/* ---------- ① 区块头哈希 + ② 前向引用 ---------- */
const txByBlock = new Map();
for (const t of txs) {
  if (t.blockIndex == null) continue;
  if (!txByBlock.has(t.blockIndex)) txByBlock.set(t.blockIndex, []);
  txByBlock.get(t.blockIndex).push(t);
}

for (let i = 0; i < blocks.length; i++) {
  const b = blocks[i];
  coverage.blocksHashRecomputed++;
  const expect = calcBlockHash(b);
  if (expect !== b.hash) {
    E('HASH_MISMATCH', `区块 #${b.index} 内容哈希与记录不符：期望 ${expect.slice(0, 16)}…，实际 ${b.hash.slice(0, 16)}…`);
  }
  if (i > 0) {
    coverage.prevLinkChecked++;
    if (b.prevHash !== blocks[i - 1].hash) {
      E('PREV_HASH_MISMATCH', `区块 #${b.index} 的 prevHash 未指向 #${b.index - 1}（链断裂）`);
    }
  }

  /* ---------- ③ Merkle 根重算 ---------- */
  coverage.merkleRootsRecomputed++;
  const rows = txByBlock.get(b.index) || [];
  const root = merkleRoot(rows.map((t) => t.txId));
  if (root !== b.merkleRoot) {
    E('MERKLE_ROOT_MISMATCH',
      `区块 #${b.index} 的 Merkle 根与交易表不一致（交易被增删改）：期望 ${root.slice(0, 16)}…，实际 ${b.merkleRoot.slice(0, 16)}…`);
  }

  /* ---------- ④ 出块签名与授权资格 ---------- */
  if (b.consensus === 'POA') {
    const pub = nodePubKey.get(b.proposer);
    if (!pub) {
      coverage.proposerSigUnverifiable++;
    } else {
      coverage.proposerSigVerified++;
      if (!b.proposerSig || !ecdsaVerify(pub, signingPayload(b), b.proposerSig)) {
        E('POA_SIGNATURE_INVALID', `区块 #${b.index} 的 PoA 出块签名无效（出块节点 ${b.proposer}）`);
      }
    }
    /* ⚠⚠ 出块资格必须按「出块当时」判，不能按「此刻」判 —— 与 chain.js#validateChain
     * 同一分档（这里原先是 PROPOSER_UNAUTHORIZED 一律记错的旧实现，属于同一判据的
     * 第二份副本；两份不一致会让"线上说通过、离线复核说 271 处异常"同时成立）。
     *   · 出块者不在节点表里 ⇒ 硬错误（身份不可识别，也就是签名无从归属）
     *   · 出块者在册但事后被撤销/停用 ⇒ 治理告警，不反溯历史区块
     * 撤销节点不能反溯撤销它签过的历史共识，否则每次联盟治理都会让整条链"变红"。 */
    const st = nodeAuth.get(b.proposer);
    if (!pub && !st) {
      E('PROPOSER_UNREGISTERED', `区块 #${b.index} 的出块节点 ${b.proposer} 不在联盟节点表中（身份不可识别）`);
    } else if (st && (st.status !== 'ACTIVE' || !st.auth)) {
      coverage.proposerRevokedLater = (coverage.proposerRevokedLater || 0) + 1;
      W('PROPOSER_REVOKED_LATER', `区块 #${b.index} 由 ${b.proposer} 出块；该节点现为 ${st.status}（历史区块不因事后撤销而失效）`);
    }
  } else if (!String(b.hash).startsWith('0'.repeat(b.difficulty))) {
    E('POW_INVALID', `区块 #${b.index} 不满足难度 ${b.difficulty} 的工作量证明`);
  }
}

/* ---------- ⑤ 链下重算绑定 + 交易签名 ---------- */
for (const t of txs) {
  coverage.payloadBindingChecked++;
  const payload = (t.payloadJson === null || t.payloadJson === undefined) ? null : safeParse(t.payloadJson);
  if (hashObject(payload) === t.payloadHash) {
    coverage.payloadBoundOk++;
  } else {
    coverage.payloadBindingMismatch++;
    E('PAYLOAD_BINDING_MISMATCH',
      `交易 ${t.txId.slice(0, 16)}… 的链下明细与链上锚定摘要不符（链下业务数据被改，或锚点被改）`,
      { txId: t.txId });
  }

  if (t.signature && t.pubKey) {
    coverage.txSignatureVerified++;
    if (!ecdsaVerify(t.pubKey, txSignContent(t), t.signature)) {
      E('TX_SIGNATURE_INVALID', `交易 ${t.txId.slice(0, 16)}… 的签名校验失败（交易字段被改动）`);
    }
  } else {
    coverage.txSignatureUnverifiable++;
  }
}

/* ---------- ⑥ 批量锚定一致性（三方对齐） ----------
 * 对齐关系：batch_leaf 叶集合 → 重算根
 *           anchor_batch.merkle_root → 批次登记根
 *           锚点交易 payload.merkleRoot → 链上锚定根
 * 三者必须完全一致。任一处被改都会在此暴露。 */
const batchSummaries = [];
const leavesByBatch = new Map();
for (const l of (data.batchLeaves || [])) {
  if (!leavesByBatch.has(l.batch_no)) leavesByBatch.set(l.batch_no, []);
  leavesByBatch.get(l.batch_no).push(l);
}
const txById = new Map(txs.map((t) => [t.txId, t]));

for (const batch of (data.anchorBatches || [])) {
  coverage.batchesChecked++;
  const lv = (leavesByBatch.get(batch.batch_no) ||[])
    .slice()
    .sort((x, y) => Number(x.leaf_index) - Number(y.leaf_index));
  const hashes = lv.map((l) => l.tx_id);
  const recomputed = merkleRoot(hashes);
  const registered = batch.merkle_root;

  // 叶序自检：leaf_index 必须连续 0..n-1
  const contiguous = lv.every((l, i) => Number(l.leaf_index) === i);
  if (!contiguous) {
    E('BATCH_LEAF_ORDER_BROKEN', `批次 ${batch.batch_no} 的叶序不连续（leaf_index 被改或叶被删除）`);
  }

  if (recomputed !== registered) {
    E('BATCH_ROOT_MISMATCH',
      `批次 ${batch.batch_no} 的叶集合重算根与批次登记根不一致：期望 ${recomputed.slice(0, 16)}…，实际 ${String(registered).slice(0, 16)}…`);
  } else {
    coverage.batchRootConsistent++;
  }

  // 与链上锚点交易载荷对照
  const anchorTx = batch.anchor_tx_id ? txById.get(batch.anchor_tx_id) : null;
  let onChainRoot = null;
  if (anchorTx) {
    const p = safeParse(anchorTx.payloadJson);
    onChainRoot = p ? p.merkleRoot : null;
    if (onChainRoot !== registered) {
      E('BATCH_CHAIN_ROOT_MISMATCH',
        `批次 ${batch.batch_no} 的链上锚点载荷根与批次登记根不一致（批次登记被改）`);
    }
    const leafDigest = p ? p.leafDigest : null;
    const expectDigest = sha256(hashes.join('|'));
    if (leafDigest && leafDigest !== expectDigest) {
      E('BATCH_LEAF_DIGEST_MISMATCH', `批次 ${batch.batch_no} 的叶序承诺与叶集合不符（叶被增删或改序）`);
    }
  } else {
    warns.push(`批次 ${batch.batch_no} 未找到锚点交易（可能在导出窗口外）`);
  }

  // 抽样验证单笔存证的 Merkle 存在性证明
  let proofOk = 0;
  for (let k = 0; k < Math.min(sampleN, hashes.length); k++) {
    const idx = Math.floor((k + 0.5) * hashes.length / Math.min(sampleN, hashes.length));
    const { path: proofPath } = buildProof(hashes, Math.min(idx, hashes.length - 1));
    if (verifyMerkleProof(hashes[Math.min(idx, hashes.length - 1)], proofPath, registered)) proofOk++;
    else E('BATCH_PROOF_INVALID', `批次 ${batch.batch_no} 第 ${idx} 叶的存在性证明无法通过验证`);
  }
  coverage.batchLeafProofVerified += proofOk;

  batchSummaries.push({
    batchNo: batch.batch_no,
    leafCount: Number(batch.leaf_count),
    leafActual: lv.length,
    merkleRootRegistered: registered,
    merkleRootRecomputed: recomputed,
    rootConsistent: recomputed === registered,
    anchorTxId: batch.anchor_tx_id,
    onChainRoot,
    chainRootConsistent: onChainRoot === registered,
    leafOrderContiguous: contiguous,
    proofSamplesVerified: proofOk,
  });
}

/** 生成 Merkle 证明路径（与 chain.js#merkleProof 同规范，独立实现） */
function buildProof(hashes, index) {
  const root = merkleRoot(hashes);
  const proofPath = [];
  if (!hashes || hashes.length === 0) return { root, path: proofPath };
  let level = hashes.slice();
  let idx = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    proofPath.push({ position: idx % 2 === 0 ? 'right' : 'left', hash: level[sibling] });
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { root, path: proofPath };
}

/* ==================================================================
 * 第三部分：输出
 * ================================================================== */
const report = {
  tool: 'tools/verify-offline.mjs',
  independence: '本工具不依赖项目任何模块，哈希/Merkle/稳定序列化/ECDSA 验签均为按公开规范独立重实现',
  input: inputPath,
  verifiedAt: new Date().toISOString(),
  source: data.meta ? data.meta.source : null,
  exportedAt: data.meta ? data.meta.exportedAt : null,
  externalAnchor: args.tip || null,
  timeBasis: {
    primary: 'block_time 字面量按 UTC 推导（独立于导出方会话时区）',
    exportedTsDriftBlocks: tzDriftBlocks,
    missingBlockTimeBlocks: tsMissingBlocks,
  },
  chain: {
    height: tip ? tip.index : -1,
    totalBlocks: blocks.length,
    tipHash: tip ? tip.hash : null,
    totalTxs: txs.length,
  },
  coverage,
  batches: batchSummaries,
  errors,
  warnings: warns,
  valid: errors.length === 0,
};

console.log('');
console.log('════════════════════════════════════════════════════════════════');
console.log('  碳链通 · 零信任离线复核报告');
console.log('════════════════════════════════════════════════════════════════');
console.log(`  输入文件    ${inputPath}`);
console.log(`  数据来源    ${report.source || '—'}  导出时间 ${report.exportedAt || '—'}`);
console.log(`  链          高度 ${report.chain.height} · 区块 ${blocks.length} · 存证 ${txs.length}`);
console.log(`  链顶哈希    ${report.chain.tipHash || '—'}`);
console.log(`  时间口径    block_time 字面量按 UTC 推导`
  + (tzDriftBlocks ? `（导出 ts 有 ${tzDriftBlocks}/${blocks.length} 块偏差，已忽略）` : '（与导出 ts 一致）'));
if (args.tip) console.log(`  外部锚定    ${args.tip}  →  ${report.chain.tipHash === args.tip ? '一致 ✔' : '不一致 ✘'}`);
console.log('────────────────────────────────────────────────────────────────');
console.log('  复核覆盖面（本次到底验了什么、验了多少）');
console.log(`    ① 区块头哈希重算          ${coverage.blocksHashRecomputed}`);
console.log(`    ② 前向引用校验            ${coverage.prevLinkChecked}`);
console.log(`    ③ Merkle 根重算           ${coverage.merkleRootsRecomputed}`);
console.log(`    ④ 出块签名验签            ${coverage.proposerSigVerified}`
  + (coverage.proposerSigUnverifiable ? `（${coverage.proposerSigUnverifiable} 块无公钥可验）` : ''));
console.log(`    ⑤ 链下重算绑定            ${coverage.payloadBindingChecked} 笔`
  + `（通过 ${coverage.payloadBoundOk} / 失配 ${coverage.payloadBindingMismatch}）`);
console.log(`      交易签名验签            ${coverage.txSignatureVerified}`
  + (coverage.txSignatureUnverifiable ? `（${coverage.txSignatureUnverifiable} 笔无签名）` : ''));
console.log(`    ⑥ 批量锚定三方对齐        ${coverage.batchesChecked} 批`
  + `（根一致 ${coverage.batchRootConsistent}）`);
console.log(`      单笔存在性证明抽样      ${coverage.batchLeafProofVerified} 条通过`);
console.log('────────────────────────────────────────────────────────────────');
if (batchSummaries.length) {
  console.log('  批量锚定明细');
  for (const b of batchSummaries) {
    console.log(`    ${b.batchNo}  ${String(b.leafActual).padStart(5)} 笔 → 1 个锚点  `
      + `根一致 ${b.rootConsistent ? '✔' : '✘'}  链上对照 ${b.chainRootConsistent ? '✔' : '✘'}  `
      + `叶序连续 ${b.leafOrderContiguous ? '✔' : '✘'}  证明抽样 ${b.proofSamplesVerified} 条`);
  }
  console.log('────────────────────────────────────────────────────────────────');
}
if (warns.length) {
  console.log(`  ⚠ 提示 ${warns.length} 条`);
  warns.slice(0, 10).forEach((w) => console.log(`    · ${w}`));
  console.log('────────────────────────────────────────────────────────────────');
}
if (errors.length) {
  console.log(`  ✘ 发现异常 ${errors.length} 处`);
  errors.slice(0, 30).forEach((e) => console.log(`    [${e.type}] ${e.message}`));
  if (errors.length > 30) console.log(`    …另有 ${errors.length - 30} 处`);
} else {
  console.log('  ✔ 全部复核项通过：链上字段未被改动，链下明文与链上锚点逐笔绑定一致，');
  console.log('    批量锚定根与链上锚点载荷三方对齐，抽样存在性证明全部可独立验证。');
}
console.log('════════════════════════════════════════════════════════════════');
console.log('');

if (args.json) {
  const out = path.resolve(args.json);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`已写出 JSON 报告：${out}`);
}

process.exit(errors.length === 0 ? 0 : 1);
