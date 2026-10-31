const fs = require('fs');
const f = 'worker/routes/chain.mjs';
let raw = fs.readFileSync(f, 'utf8');
const crlf = raw.includes('\r\n');
if (crlf) raw = raw.replace(/\r\n/g, '\n');
let changes = 0;

/* ── 1. merkleRoot → Node 同源公式（sha256(左+右) 直接拼接）──
 * 保留原名（调用点多），原 pipe 实现整体替换为 concat 实现。
 * anchor_batch 的批次根若为 pipe 公式所写，其校验改用
 * merkleRootPipe（下方新增）单独处理。 */
const OLD_MERKLE = `export function merkleRoot(leaves) {
  if (!leaves || !leaves.length) return '0'.repeat(64);
  let level = leaves.map((l) => String(l));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(canonicalHash(a, b));
    }
    level = next;
  }
  return level[0];
}`;
const NEW_MERKLE = `/* ⭐ 与本地链内核 cu.merkleRoot 逐字节同源：
 * 两两 sha256(左 + 右) 直接拼接（无分隔符），奇数个则最后一个与自身配对。
 * 2026-10-27 勘查实证：Turso 权威链的 merkle_root 即此公式
 * （tools/_qa/formula-space.mjs 对块 #1/#2 四变体枚举，仅本变体匹配）。 */
export function merkleRoot(leaves) {
  if (!leaves || !leaves.length) return '0'.repeat(64);
  let level = leaves.map((l) => String(l));
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(level[i] + level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

/** 批次锚定（anchor_batch）专用的历史 pipe 公式：该表的 merkle_root
 * 由边缘批次锚定流程以 sha256(左|右) 写入，校验须沿用同公式。
 * 与链内核的 concat 公式是两个子系统，不得混用。 */
export function merkleRootPipe(leaves) {
  if (!leaves || !leaves.length) return '0'.repeat(64);
  let level = leaves.map((l) => String(l));
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(canonicalHash(a, b));
    }
    level = next;
  }
  return level[0];
}`;
if (!raw.includes(OLD_MERKLE)) { console.log('MISS merkleRoot'); process.exit(1); }
raw = raw.replace(OLD_MERKLE, NEW_MERKLE); changes++;

/* ── 2. headerHashOf → Node calcHash PoA 公式 ── */
const OLD_HEADER = `/** 块头哈希：与本地 chain.js 的 calcHash 同口径（canonical 序列化后 SHA-256） */
function headerHashOf(h) {
  return sha256Hex(stableStringify({
    blockIndex: h.blockIndex,
    prevHash: h.prevHash,
    merkleRoot: h.merkleRoot,
    nonce: h.nonce,
    difficulty: h.difficulty,
    txCount: h.txCount,
  }));
}`;
const NEW_HEADER = `/* ⭐ 块头哈希：与本地链内核 calcHash 的 PoA 分支逐字节同源：
 * sha256([index, timestamp, merkleRoot, prevHash, 'POA', proposer, nonce].join('|'))
 * 其中 timestamp 为 UNIX 秒（块时间 block_time 为 UTC 文本，经 strftime 还原）。
 * 2026-10-27 勘查实证：对 Turso 权威链抽块重算逐位一致
 * （旧 canonical JSON 实现与链内核并非同口径——线上 validate 因此恒红，属隐性缺陷）。 */
function nodeCalcHashOf(h) {
  return sha256Hex([
    h.blockIndex, h.timestamp, h.merkleRoot, h.prevHash,
    'POA', h.proposer || '', h.nonce,
  ].join('|'));
}`;
if (!raw.includes(OLD_HEADER)) { console.log('MISS headerHashOf'); process.exit(1); }
raw = raw.replace(OLD_HEADER, NEW_HEADER); changes++;

/* ── 3. 调用点改写 ── */
/* 3a. 块详情（129 附近）：叶子从 payload_hash 改为 tx_id（链内核 Merkle 的叶子），
 *     块头重算改用 nodeCalcHashOf（需传 timestamp/consensus/proposer）。 */
const OLD_129 = `    const leaves = txs.map((t) => t.payload_hash);
    const merkle = merkleRoot(leaves);
    const merkleOk = merkle === b.merkle_root;

    /* 块头哈希复算（与出块时的算法一致：canonical 序列化后 SHA-256） */
    const headerHash = headerHashOf({
      blockIndex: num(b.block_index), prevHash: b.prev_hash, merkleRoot: b.merkle_root,
      nonce: num(b.nonce), difficulty: num(b.difficulty), txCount: num(b.tx_count),`;
const NEW_129 = `    /* Merkle 叶子 = tx_id（链内核写入时的叶子口径），与链上 merkle_root 同源 */
    const leaves = txs.map((t) => t.tx_id);
    const merkle = merkleRoot(leaves);
    const merkleOk = merkle === b.merkle_root;

    /* 块头哈希复算：与本地链内核 calcHash 的 PoA 分支逐字节同源 */
    const headerHash = nodeCalcHashOf({
      blockIndex: num(b.block_index),
      timestamp: Number(b.ts_epoch),
      merkleRoot: b.merkle_root,
      prevHash: b.prev_hash,
      proposer: b.proposer,
      nonce: num(b.nonce),`;
if (!raw.includes(OLD_129)) { console.log('MISS 129'); process.exit(1); }
raw = raw.replace(OLD_129, NEW_129); changes++;

/* 3b. validate 循环：叶子改 tx_id，块头用 nodeCalcHashOf（epoch 从 block_time 还原） */
const OLD_V = `        const leaves = leavesByBlock.get(idx) || [];
        checkedTx += leaves.length;
        const mr = merkleRoot(leaves.map((l) => l.payload_hash));`;
const NEW_V = `        const leaves = leavesByBlock.get(idx) || [];
        checkedTx += leaves.length;
        const mr = merkleRoot(leaves.map((l) => l.tx_id));`;
if (!raw.includes(OLD_V)) { console.log('MISS validate merkle'); process.exit(1); }
raw = raw.replace(OLD_V, NEW_V); changes++;

/* validate 循环里的叶子全量查询需带 tx_id */
const OLD_L = `    const leavesAll = await ctx.db.query(
      'SELECT block_index, payload_hash FROM chain_tx ORDER BY block_index ASC, id ASC');`;
const NEW_L = `    const leavesAll = await ctx.db.query(
      'SELECT block_index, tx_id, payload_hash FROM chain_tx ORDER BY block_index ASC, id ASC');`;
if (!raw.includes(OLD_L)) { console.log('MISS leavesAll'); process.exit(1); }
raw = raw.replace(OLD_L, NEW_L); changes++;

/* validate 的块头重算 */
const OLD_VH = `        /* ③ 块头 */
        const hh = headerHashOf({
          blockIndex: idx, prevHash: b.prev_hash, merkleRoot: b.merkle_root,
          nonce: num(b.nonce), difficulty: num(b.difficulty), txCount: num(b.tx_count),
        });`;
const NEW_VH = `        /* ③ 块头（Node calcHash PoA 公式） */
        const hh = nodeCalcHashOf({
          blockIndex: idx, timestamp: Math.floor(Number(b.ts_epoch)),
          merkleRoot: b.merkle_root, prevHash: b.prev_hash,
          proposer: b.proposer, nonce: num(b.nonce),
        });`;
if (!raw.includes(OLD_VH)) { console.log('MISS validate header'); process.exit(1); }
raw = raw.replace(OLD_VH, NEW_VH); changes++;

/* validate 的 blocks 分批查询需带 epoch/proposer/consensus */
const OLD_BQ = `        \`SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, tx_count
           FROM chain_block ORDER BY block_index ASC LIMIT ? OFFSET ?\`, [BATCH, off]);`;
const NEW_BQ = `        \`SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, tx_count,
               consensus, proposer, strftime('%s', block_time) AS ts_epoch
           FROM chain_block ORDER BY block_index ASC LIMIT ? OFFSET ?\`, [BATCH, off]);`;
if (!raw.includes(OLD_BQ)) { console.log('MISS block query'); process.exit(1); }
raw = raw.replace(OLD_BQ, NEW_BQ); changes++;

/* ── 4. anchor_batch 校验改用 pipe 公式 ── */
const OLD_AB = `    const recomputed = merkleRoot(leaves.map((l) => l.leaf_hash));`;
const NEW_AB = `    const recomputed = merkleRootPipe(leaves.map((l) => l.leaf_hash));`;
if (!raw.includes(OLD_AB)) { console.log('MISS anchor batch'); process.exit(1); }
raw = raw.replace(OLD_AB, NEW_AB); changes++;

if (crlf) raw = raw.replace(/\n/g, '\r\n');
fs.writeFileSync(f, raw, 'utf8');
console.log('worker chain.mjs 公式对齐完成，共 ' + changes + ' 处');
