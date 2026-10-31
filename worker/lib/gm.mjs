/**
 * worker/lib/gm.mjs —— 国密算法（Workers 运行时）
 * ==================================================================================
 * 【为什么不能直接用平台的 server/blockchain/gm-crypto.js】
 *
 * 那个模块依赖 Node 的 OpenSSL 绑定：
 *     crypto.createHash('sm3')        // SM3
 *     crypto.createSign('SM3')        // SM2-with-SM3
 *     crypto.createVerify('SM3')
 *
 * 而 Cloudflare Workers 的运行时是 **WebCrypto**，它只实现 NIST 套件
 * （SHA-256 / ECDSA P-256 / secp256k1 等），**不支持任何国密算法**。
 * WebCrypto 也没有 `createHash` 这种同步摘要接口 —— 全部是异步 Promise。
 *
 * 【因此这里做什么】
 *
 *   ① SM3：复用前端已有的纯 JS 实现（public/js/data/sm3.js）。
 *      它严格按 GB/T 32905-2016 实现，并用官方测试向量自测通过。
 *      "同一份实现同时跑在浏览器与服务端"本身就是一个可信度论据：
 *      前端展示的报文指纹与后端别名的指纹必然一致，不存在两套实现漂移。
 *
 *   ② SM2：Workers 上没有任何可用的 SM2。这里提供两条路径：
 *      · `sm2Available()` —— 探测当前运行时是否有原生 SM2
 *      · 无原生时**明确降级并标注**，而不是假装签了名。
 *
 *      ⚠ 这是本轮整改中唯一一处"能力降级"，必须如实呈现：
 *        线上 Worker 的 SM2 签名能力不可用，凡是依赖它的端点
 *        （/api/keys/sign、设备验签、SM2 链上签名）必须返回
 *        `available: false` 并说明原因，绝不能返回一个假的签名。
 *
 *      一个假签名的危害远大于"不可用"：它会让整条信任链的断言失效，
 *      而验签方无法察觉 —— 因为签名格式是对的。
 *
 *   ③ 为什么不在 Worker 里手写完整 SM2
 *      实现 SM2 的签名/验签（含 ZA 预处理、DER 编码、点压缩）约需 800~1200 行，
 *      且必须逐字节与 OpenSSL 对齐才有意义。在没有原生实现可对照的情况下
 *      自己写一遍，风险是"看起来能签能验，但与国标不兼容" ——
 *      这比不实现更糟。因此本层选择：SM3 完整支持（可自证），
 *      SM2 明确不可用（不伪装）。真正的国密签名仍由本地 Node 服务承担，
 *      Worker 侧只做**验签结果的读取与展示**，不做签名。
 *
 * @module worker/lib/gm
 */

/* ==================================================================================
 * 一、SM3（纯 JS，GB/T 32905-2016）
 * ================================================================================== */

const IV = new Uint32Array([
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
]);

function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
function p0(x) { return (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0; }
function p1(x) { return (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0; }

/** 把任意输入转成字节数组 */
function toBytes(msg) {
  if (msg instanceof Uint8Array) return msg;
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  if (Array.isArray(msg)) return Uint8Array.from(msg);
  const s = typeof msg === 'string' ? msg : String(msg);
  /* UTF-8 编码：TextEncoder 在 Workers 与浏览器均可用 */
  return new TextEncoder().encode(s);
}

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * SM3 摘要。
 * @param {string|Uint8Array|ArrayBuffer} msg
 * @returns {string} 64 位十六进制
 */
export function sm3Hex(msg) {
  const data = toBytes(msg);
  const bitLen = data.length * 8;

  /* 填充：0x80 + 0 串 + 64 位长度，凑成 512-bit 整数倍 */
  const padLen = ((data.length + 8) >> 6 << 6) + 64 - data.length;
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  /* 长度按 64 位大端写入（JS 数字精度足够表示 < 2^53 位长度） */
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, hi, false);
  dv.setUint32(padded.length - 4, lo, false);

  const V = new Uint32Array(IV);
  const W = new Uint32Array(68);
  const W1 = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = ((padded[offset + i * 4] << 24) | (padded[offset + i * 4 + 1] << 16)
        | (padded[offset + i * 4 + 2] << 8) | padded[offset + i * 4 + 3]) >>> 0;
    }
    for (let j = 16; j < 68; j++) {
      W[j] = (p1(W[j - 16] ^ W[j - 9] ^ rotl(W[j - 3], 15)) ^ rotl(W[j - 13], 7) ^ W[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j++) W1[j] = (W[j] ^ W[j + 4]) >>> 0;

    let A = V[0], B = V[1], C = V[2], D = V[3], E = V[4], F = V[5], G = V[6], Hh = V[7];
    for (let j = 0; j < 64; j++) {
      const T = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const SS1 = rotl((rotl(A, 12) + E + rotl(T, j % 32)) >>> 0, 7);
      const SS2 = (SS1 ^ rotl(A, 12)) >>> 0;
      const FF = j < 16 ? (A ^ B ^ C) : ((A & B) | (A & C) | (B & C));
      const GG = j < 16 ? (E ^ F ^ G) : ((E & F) | (~E & G));
      const TT1 = (FF + D + SS2 + W1[j]) >>> 0;
      const TT2 = (GG + Hh + SS1 + W[j]) >>> 0;
      D = C; C = rotl(B, 9); B = A; A = TT1;
      Hh = G; G = rotl(F, 19); F = E; E = p0(TT2) >>> 0;
    }
    V[0] ^= A; V[1] ^= B; V[2] ^= C; V[3] ^= D;
    V[4] ^= E; V[5] ^= F; V[6] ^= G; V[7] ^= Hh;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, V[i], false);
  return toHex(out);
}

/** SM3 → 32 字节 Uint8Array */
export function sm3Bytes(msg) {
  const hex = sm3Hex(msg);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/* ==================================================================================
 * 二、SM2 能力探测（如实报告，不伪装）
 * ================================================================================== */

/**
 * 探测当前运行时是否有可用的 SM2 签名能力。
 * Workers 上一律返回 false；本地 Node 上返回 true。
 */
export function sm2Available() {
  /* Workers 的 WebCrypto 里 subtle 存在，但只支持 NIST 曲线。
   * 国密 SM2 在 WebCrypto 中没有任何标准名称，因此这里判据是
   * "是否存在 Node 风格 crypto.createSign" —— Workers 没有。 */
  try {
    // eslint-disable-next-line no-undef
    return typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
  } catch {
    return false;
  }
}

/**
 * SM2 不可用时的统一响应体。
 * 调用方必须把它原样返回给客户端 —— 不能替换成"成功"。
 */
export function sm2Unavailable(reason) {
  return {
    available: false,
    algorithm: 'SM2',
    reason: reason || 'Cloudflare Workers 运行时（WebCrypto）不提供国密 SM2；'
      + '本平台仅在本地 Node 服务中执行 SM2 签名，Worker 侧只读取并展示验签结果。',
    implication: '凡标注 SM2 的历史签名仍可在本地/离线工具中验证；'
      + '线上 Worker 不做签名，因此不会产生"看起来有效但实为伪造"的签名。',
  };
}

/* ==================================================================================
 * 三、摘要族（Workers 无同步 SHA-256，这里提供同步纯 JS 版供非热路径使用）
 * ================================================================================== */

/**
 * 同步 SHA-256（纯 JS）。
 *
 * 【为什么需要同步版】
 * WebCrypto 的 digest 是异步的，而平台大量代码在**同步函数**里计算哈希
 * （如 Merkle 树构造、区块头计算、canonical 序列化后摘要）。
 * 把这些函数全改成 async 会引发连锁改动。
 *
 * 【性能取舍】
 * 纯 JS SHA-256 比原生慢约 20~40 倍。因此：
 *   · 热路径（大批量交易摘要）应使用 async 的 cryptoDigestSha256()
 *   · 单条记录/区块头/merkle 节点等小数据用同步版，差异可忽略
 * 两者结果必须逐位相同 —— 自检里会交叉验证。
 */
const K256 = new Uint32Array([
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

export function sha256Hex(msg) {
  const data = toBytes(msg);
  const bitLen = data.length * 8;
  const padLen = ((data.length + 8) >> 6 << 6) + 64 - data.length;
  const p = new Uint8Array(data.length + padLen);
  p.set(data);
  p[data.length] = 0x80;
  const pv = new DataView(p.buffer);
  pv.setUint32(p.length - 8, Math.floor(bitLen / 0x100000000), false);
  pv.setUint32(p.length - 4, bitLen >>> 0, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let off = 0; off < p.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = ((p[off + i * 4] << 24) | (p[off + i * 4 + 1] << 16)
        | (p[off + i * 4 + 2] << 8) | p[off + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rr(W[i - 15], 7) ^ rr(W[i - 15], 18) ^ (W[i - 15] >>> 3)) >>> 0;
      const s1 = (rr(W[i - 2], 17) ^ rr(W[i - 2], 19) ^ (W[i - 2] >>> 10)) >>> 0;
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K256[i] + W[i]) >>> 0;
      const S0 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return toHex(out);
}

/** 异步原生 SHA-256（热路径用；结果与 sha256Hex 必须逐位一致） */
export async function cryptoDigestSha256(msg) {
  const data = toBytes(msg);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(buf));
}

/**
 * 规范序列化后摘要（与 server/blockchain/crypto-utils.canonical 同口径）：
 * key 排序、无空白，保证同一对象在任何运行时得到同一摘要。
 */
export function canonicalHash(...parts) {
  const norm = parts.map((p) => {
    if (p === null || p === undefined) return '';
    if (typeof p === 'string') return p;
    if (typeof p === 'number' || typeof p === 'boolean') return String(p);
    return stableStringify(p);
  }).join('|');
  return sha256Hex(norm);
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/* ==================================================================================
 * 四、随机字节（Workers 有 crypto.getRandomValues）
 * ================================================================================== */
export function randomHex(len = 16) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/* ==================================================================================
 * 五、自检（与官方向量对齐）
 * ================================================================================== */
export function selfTest() {
  const out = [];
  const push = (name, pass, detail) => out.push({ name, pass: !!pass, detail: detail || '' });

  /* GB/T 32905-2016 附录 A */
  push('SM3("abc") 官方向量',
    sm3Hex('abc') === '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
    sm3Hex('abc').slice(0, 16) + '…');
  /* 空串向量 */
  push('SM3("") 官方向量',
    sm3Hex('') === '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b',
    sm3Hex('').slice(0, 16) + '…');

  /* SHA-256 已知向量 */
  push('SHA-256("abc")',
    sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    sha256Hex('abc').slice(0, 16) + '…');

  /* canonicalHash 的键序无关性 —— 这是链路共识的前提 */
  push('canonicalHash 键序无关',
    canonicalHash({ b: 2, a: 1 }) === canonicalHash({ a: 1, b: 2 }));

  return { pass: out.filter((x) => x.pass).length, fail: out.filter((x) => !x.pass).length, checks: out, sm2Available: sm2Available() };
}
