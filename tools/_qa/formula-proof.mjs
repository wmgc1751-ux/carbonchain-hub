import fs from 'node:fs';
import path from 'node:path';


const ROOT = process.cwd();
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

/* 纯 JS 同步 SHA-256（与 worker/lib/gm.mjs 的 sha256Hex 同源逻辑，此处独立实现以便对照） */
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111d7 || 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const bitLen = bytes.length * 8;
  const withPad = new Uint8Array(((bytes.length + 8) >> 6 << 6) + 64);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  const W = new Int32Array(64);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(W[i - 15], 7) ^ rr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rr(W[i - 2], 17) ^ rr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  function rr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
}
function rr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

/* Node calcHash PoA 分支的精确复刻：sha256([index, timestamp, merkleRoot, prevHash, 'POA', proposer, nonce].join('|')) */
function nodeCalcHash(b) {
  return sha256Hex([
    b.block_index, Math.floor(Number(b.epoch)), b.merkle_root, b.prev_hash,
    String(b.consensus || 'POA').toUpperCase(), b.proposer || '', b.nonce,
  ].join('|'));
}
/* Node cu.merkleRoot 的精确复刻：两两 sha256(左+右) 直接拼接，奇数补尾，空→64 个 0 */
function nodeMerkle(hashes) {
  if (!hashes || !hashes.length) return '0'.repeat(64);
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256Hex(level[i] + level[i + 1]));
    level = next;
  }
  return level[0];
}


async function q(sql) {
  const r = await fetch(env.TURSO_URL.replace('libsql://','https://') + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.TURSO_AUTH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] }),
  });
  const j = await r.json();
  const res = j.results[0].response.result;
  return res.rows.map((cells) => { const o = {}; res.cols.forEach((c, i) => { o[c.name] = cells[i] && cells[i].value !== null ? cells[i].value : null; }); return o; });
}
const q1 = async (sql) => (await q(sql))[0];
const db = { prepare: (sql) => ({ bind: () => {}, all: () => {} }), __q: q, __q1: q1 };

(async () => {
  const blocksRows = await q();
  for (const b of blocksRows) {
    const ids = (await q('SELECT tx_id FROM chain_tx WHERE block_index = ' + b.block_index + ' ORDER BY id')).map(x => x.tx_id);
    const phs = (await q('SELECT payload_hash FROM chain_tx WHERE block_index = ' + b.block_index + ' ORDER BY id')).map(x => x.payload_hash);
    console.log('块 #' + b.block_index, '叶子数', ids.length, '| 存 merkle', String(b.merkle_root).slice(0,16), '| 存 hash', String(b.block_hash).slice(0,16));
    // merkle 变体
    const mTxConcat = nodeMerkle(ids);
    const mPhConcat = nodeMerkle(phs);
    console.log('  merkle(tx_id,直接拼接)  ', mTxConcat.slice(0,16), mTxConcat === b.merkle_root ? '✔匹配' : '✘');
    console.log('  merkle(payload_hash拼接)', mPhConcat.slice(0,16), mPhConcat === b.merkle_root ? '✔匹配' : '✘');
    // block hash 变体（merkle 用匹配到的值）
    const mr = mTxConcat === b.merkle_root ? mTxConcat : mPhConcat;
    const hv1 = sha256Hex([b.block_index, Math.floor(Number(b.epoch)), b.merkle_root, b.prev_hash, 'POA', b.proposer || '', b.nonce].join('|'));
    console.log('  块哈希 v1(管道,epoch int) ', hv1.slice(0,16), hv1 === b.block_hash ? '✔匹配' : '✘');
    const hv2 = sha256Hex([b.block_index, b.epoch, b.merkle_root, b.prev_hash, 'POA', b.proposer || '', b.nonce].join('|'));
    console.log('  块哈希 v2(epoch字符串)   ', hv2.slice(0,16), hv2 === b.block_hash ? '✔匹配' : '✘');
    const hv3 = sha256Hex([b.block_index, Math.floor(Number(b.epoch)), b.merkle_root, b.prev_hash, b.consensus, b.proposer || '', b.nonce].join('|'));
    console.log('  块哈希 v3(consensus原值)  ', hv3.slice(0,16), hv3 === b.block_hash ? '✔匹配' : '✘');
  }
().catch((e) => { console.log('ERR', e.message); process.exit(1); });
)().catch(e=>console.log('ERR',e.message));
