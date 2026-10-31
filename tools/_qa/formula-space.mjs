import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

/* 纯 JS 同步 SHA-256（标准实现） */
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function rr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const bitLen = bytes.length * 8;
  const buf = new Uint8Array(((bytes.length + 8) >> 6 << 6) + 64);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(buf.length - 4, bitLen >>> 0, false);
  const W = new Int32Array(64);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let off = 0; off < buf.length; off += 64) {
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
}
/* 两种 Merkle 配对算法 */
function merkleConcat(hashes) {           // Node 版：sha256(左+右) 直接拼接
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
function merklePipe(hashes) {             // worker 版：sha256(左|右)
  if (!hashes || !hashes.length) return '0'.repeat(64);
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256Hex(level[i] + '|' + level[i + 1]));
    level = next;
  }
  return level[0];
}

async function q(sql) {
  const r = await fetch(env.TURSO_URL.replace('libsql://', 'https://') + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.TURSO_AUTH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] }),
  });
  const j = await r.json();
  const res = j.results[0].response.result;
  return res.rows.map((cells) => {
    const o = {};
    res.cols.forEach((c, i) => { o[c.name] = cells[i] === null || cells[i].value === null ? null : cells[i].value; });
    return o;
  });
}
const q1 = async (sql) => (await q(sql))[0];

(async () => {
  console.log('== 公式空间对齐实验（块 #1、#2）==');
  const blocks = await q("SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, consensus, proposer, strftime('%s', block_time) AS epoch, block_time FROM chain_block WHERE block_index IN (1,2) ORDER BY block_index");
  for (const b of blocks) {
    const ids = (await q(`SELECT tx_id FROM chain_tx WHERE block_index = ${b.block_index} ORDER BY id`)).map((x) => x.tx_id);
    const phs = (await q(`SELECT payload_hash FROM chain_tx WHERE block_index = ${b.block_index} ORDER BY id`)).map((x) => x.payload_hash);
    console.log(`\n块 #${b.block_index} 叶子 ${ids.length} | 存 merkle ${String(b.merkle_root).slice(0, 16)} | 存 hash ${String(b.block_hash).slice(0, 16)}`);
    const mTx = merkleConcat(ids), mPh = merkleConcat(phs), mTxP = merklePipe(ids), mPhP = merklePipe(phs);
    console.log(`  merkle: tx拼接 ${mTx.slice(0, 12)} ${mTx === b.merkle_root ? '✔' : '✘'} | ph拼接 ${mPh.slice(0, 12)} ${mPh === b.merkle_root ? '✔' : '✘'} | tx管道 ${mTxP.slice(0, 12)} ${mTxP === b.merkle_root ? '✔' : '✘'} | ph管道 ${mPhP.slice(0, 12)} ${mPhP === b.merkle_root ? '✔' : '✘'}`);
    const mr = [mTx, mPh, mTxP, mPhP].find((x) => x === b.merkle_root) || b.merkle_root;
    // 块哈希变体
    const variants = {
      v1_管道_epoch数值: sha256Hex([b.block_index, Math.floor(Number(b.epoch)), mr, b.prev_hash, 'POA', b.proposer || '', b.nonce].join('|')),
      v2_管道_epoch字符串: sha256Hex([b.block_index, b.epoch, mr, b.prev_hash, 'POA', b.proposer || '', b.nonce].join('|')),
      v3_管道_epoch浮点: sha256Hex([b.block_index, Number(b.epoch), mr, b.prev_hash, 'POA', b.proposer || '', b.nonce].join('|')),
      v4_含consensus原值: sha256Hex([b.block_index, Math.floor(Number(b.epoch)), mr, b.prev_hash, b.consensus, b.proposer || '', b.nonce].join('|')),
    };
    for (const [k, v] of Object.entries(variants)) {
      console.log(`  块哈希 ${k.padEnd(18)} ${v.slice(0, 16)} ${v === b.block_hash ? '✔匹配' : '✘'}`);
    }
  }
})().catch((e) => console.log('ERR', e.message));
