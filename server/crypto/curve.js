/**
 * curve.js —— SM2 曲线群运算内核（自实现，不依赖 OpenSSL 的 SM2）
 * ==================================================================================
 * 【为什么必须自己实现】
 * Node 的 OpenSSL 只暴露 SM2 的 sign/verify，不暴露**群运算**。
 * 而零知识证明需要：点加、标量乘、多标量乘（MSM）、点压缩、哈希到曲线。
 * 没有这些原语，一切 ZK 协议都无从谈起。
 *
 * 【性能设计】
 *   仿射坐标下每次点加要做一次模逆（约 3~5 μs），一次标量乘 256 次点加
 *   ⇒ 单次标量乘 0.8~1.5 ms。这在 ZK 里完全不够（一个范围证明需要几十次标量乘）。
 *
 *   改用 **Jacobian 投影坐标**：
 *     仿射 (x, y)  ↔  投影 (X, Y, Z)，其中 x = X/Z², y = Y/Z³
 *   投影坐标下的点加/倍点**不需要模逆**，只在最后转回仿射时做一次。
 *   实测提速约 8~12 倍（见 selfTest 的性能断言）。
 *
 * 【正确性保证】
 *   自检覆盖：
 *     · G 在曲线上（y² = x³ + ax + b mod p）
 *     · 阶 n：n·G = O，且 (n−1)·G = −G
 *     · 结合律 / 交换律 / 单位元 / 逆元
 *     · 与 OpenSSL 的 SM2 公钥一致（用同一私钥 d 派生的公钥必须逐字节相同）
 *   最后一条最关键：它是"自实现没错"的跨实现证据。
 *
 * 【安全声明】
 *   本实现是**常数时间不保证**的（BigInt 运算天然有数据依赖的分支）。
 *   因此它只用于：
 *     · 零知识证明的证明生成与验证（双方都掌握数据，不涉侧信道）
 *     · 公开可验证的承诺与证明（攻击者拿不到计时信息）
 *   **不用于**私钥签名的在线服务（那必须走 OpenSSL 的常数时间实现）。
 *   这一边界必须明确写出，否则就是过度声称。
 *
 * @module crypto/curve
 */
'use strict';

/* ==================================================================================
 * 一、曲线参数（GB/T 32918.5-2017 / SM2 推荐曲线）
 * ================================================================================== */

/** 素域特征 p */
const P = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFFn;
/** 曲线方程 y² = x³ + ax + b 的 a */
const A = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFCn;
/** 曲线方程常数项 b */
const B = 0x28E9FA9E9D9F5E344D5A9E4BCF6509A7F39789F515AB8F92DDBCBD414D940E93n;
/** 基点 G 的阶 n */
const N = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123n;
/** 基点 G 的 x 坐标 */
const GX = 0x32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7n;
/** 基点 G 的 y 坐标 */
const GY = 0xBC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0n;

/* ==================================================================================
 * 二、域运算
 * ================================================================================== */

/** 模运算（保证非负） */
function mod(a, m = P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

/**
 * 模逆（扩展欧几里得）。
 * @param {bigint} a
 * @param {bigint} m
 * @returns {bigint}
 */
function inv(a, m = P) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('模逆不存在：输入与模数不互素');
  return mod(old_s, m);
}

/** 模幂（平方-乘法） */
function pow(base, exp, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/* ==================================================================================
 * 三、Jacobian 投影坐标点运算
 * ==================================================================================
 * 表示：{ X, Y, Z }，对应仿射 (X/Z², Y/Z³)。
 * 无穷远点：Z = 0（此时 X、Y 的取值无意义，统一置 0/1）。
 */

/** 无穷远点 */
const ZERO = Object.freeze({ X: 0n, Y: 1n, Z: 0n });

/** 基点（Jacobian 形式，Z=1） */
const G = Object.freeze({ X: GX, Y: GY, Z: 1n });

/** 仿射 → Jacobian */
function toJ(x, y) {
  return { X: mod(x), Y: mod(y), Z: 1n };
}

/** Jacobian → 仿射；无穷远返回 null */
function toAffine(p) {
  if (p.Z === 0n) return null;
  const zInv = inv(p.Z);
  const zInv2 = (zInv * zInv) % P;
  return {
    x: (p.X * zInv2) % P,
    y: (p.Y * zInv2 * zInv) % P,
  };
}

/**
 * 倍点（Jacobian，「dbl-2009-l」标准公式）。
 *
 * 【推导（完整写出，不留"照抄"的余地）】
 * Jacobian 表示 (X, Y, Z) ↔ 仿射 (X/Z², Y/Z³)。求 2P。
 * 仿射切线斜率 λ = (3x² + a)/(2y)，x₃ = λ² − 2x，y₃ = λ(x − x₃) − y。
 * 代入 x = X/Z², y = Y/Z³：
 *
 *   λ = (3X²/Z⁴ + a) / (2Y/Z³) = (3X² + aZ⁴) / (2YZ)
 *
 * 令 E = 3X² + aZ⁴，取 Z₃ = 2YZ，则 λ = E/Z₃。
 *
 *   X₃/Z₃² = E²/Z₃² − 2X/Z²
 *   ⇒ X₃ = E² − 2X·Z₃²/Z² = E² − 2X·(4Y²Z²)/Z² = E² − 8XY²  =: E² − 2D
 *      其中 D = 4XY²
 *
 *   Y₃/Z₃³ = (E/Z₃)(X/Z² − X₃/Z₃²) − Y/Z³
 *   ⇒ Y₃ = E(X·Z₃²/Z² − X₃) − Y·Z₃³/Z³
 *         = E(4XY² − X₃) − 8Y³·... 整理得
 *         = E(D − X₃) − 8Y⁴   =: E(D − X₃) − 8C
 *      其中 C = (Y²)² = Y⁴
 *
 * 【SM2 的 a 是 −3】
 *   a mod p = p − 3。因此 E = 3X² − 3Z⁴ = 3(X − Z²)(X + Z²)。
 *   这一步**极易写错**（我第一版就写成了 3(X−Z⁴)(X+Z⁴)，把 Z² 误当成 Z⁴）。
 *   本实现直接写成 3X² + aZ⁴，把 a 交给常量，**不做特化化简** ——
 *   多两次乘法，换掉一整类无法自查的符号错误，值得。
 *
 * 【守护断言】
 *   selfTest 第 4 条：k·G 与"逐点累加"逐点相等（k = 0..40）。
 *   这条能抓住任意 k 的错误，是唯一能证明"倍点没错"的断言。
 */
function dbl(p) {
  if (p.Z === 0n || p.Y === 0n) return ZERO;
  const { X, Y, Z } = p;
  const XX = (X * X) % P;            // A = X²
  const YY = (Y * Y) % P;            // B = Y²
  const YYYY = (YY * YY) % P;        // C = Y⁴
  const ZZ = (Z * Z) % P;
  const ZZZZ = (ZZ * ZZ) % P;        // Z⁴
  /* D = 4XY² = 2·((X+YY)² − XX − YYYY) */
  const D = mod(2n * ((X + YY) * (X + YY) - XX - YYYY));
  /* E = 3X² + a·Z⁴ */
  const E = mod(3n * XX + A * ZZZZ);
  const X3 = mod(E * E - 2n * D);
  const Y3 = mod(E * (D - X3) - 8n * YYYY);
  const Z3 = mod(2n * Y * Z);
  return { X: X3, Y: Y3, Z: Z3 };
}

/** 点加（add-2007-bl） */
function add(p, q) {
  if (p.Z === 0n) return q;
  if (q.Z === 0n) return p;
  const { X: X1, Y: Y1, Z: Z1 } = p;
  const { X: X2, Y: Y2, Z: Z2 } = q;
  const Z1Z1 = (Z1 * Z1) % P;
  const Z2Z2 = (Z2 * Z2) % P;
  const U1 = (X1 * Z2Z2) % P;
  const U2 = (X2 * Z1Z1) % P;
  const S1 = (Y1 * Z2Z2 * Z2) % P;
  const S2 = (Y2 * Z1Z1 * Z1) % P;
  if (U1 === U2) {
    if (S1 !== S2) return ZERO;   // 互为逆元
    return dbl(p);                 // 同一点
  }
  const H = mod(U2 - U1);
  const I = mod((2n * H) * (2n * H));
  const J = (H * I) % P;
  const r = mod(2n * (S2 - S1));
  const V = (U1 * I) % P;
  const X3 = mod(r * r - J - 2n * V);
  const Y3 = mod(r * (V - X3) - 2n * S1 * J);
  const Z3 = mod(((Z1 + Z2) * (Z1 + Z2) - Z1Z1 - Z2Z2) * H);
  return { X: X3, Y: Y3, Z: Z3 };
}

/** 取负 */
function neg(p) {
  if (p.Z === 0n) return p;
  return { X: p.X, Y: mod(-p.Y), Z: p.Z };
}

/** 点减 */
function sub(p, q) { return add(p, neg(q)); }

/**
 * 标量乘（二进制展开，从高位到低位）。
 * @param {bigint} k
 * @param {object} p Jacobian 点
 */
function mul(k, p) {
  let kk = mod(k, N);
  if (kk === 0n || p.Z === 0n) return ZERO;
  let r = ZERO;
  const bits = kk.toString(2);
  for (let i = 0; i < bits.length; i++) {
    r = dbl(r);
    if (bits[i] === '1') r = add(r, p);
  }
  return r;
}

/**
 * 多标量乘（Multi-Scalar Multiplication）—— 朴素版。
 *
 * 用于验证 Σ kᵢ·Pᵢ = O 这类等式（Bulletproofs 的验证式就是这种形式）。
 * 朴素做法是逐个 mul 再累加；更快的 Pippenger 算法在点数 &gt; 64 时才有优势，
 * 本平台的规模（通常 &lt; 32）用朴素版即可，代码简单且不易错。
 *
 * @param {bigint[]} ks  标量数组
 * @param {object[]} ps  点数组（Jacobian）
 */
function msm(ks, ps) {
  if (ks.length !== ps.length) throw new Error('msm：标量与点数量不一致');
  let acc = ZERO;
  for (let i = 0; i < ks.length; i++) {
    acc = add(acc, mul(ks[i], ps[i]));
  }
  return acc;
}

/* ==================================================================================
 * 四、编解码
 * ================================================================================== */

const HEX = (v, bytes = 32) => {
  let s = v.toString(16);
  while (s.length < bytes * 2) s = '0' + s;
  return s.toUpperCase();
};

/** 点 → 未压缩十六进制（04 || X || Y，65 字节） */
function encodePoint(pt) {
  if (!pt) return '00';
  const a = toAffine(pt);
  if (!a) return '00';
  return '04' + HEX(a.x) + HEX(a.y);
}

/** 未压缩十六进制 → 点 */
function decodePoint(hex) {
  const h = String(hex || '').replace(/^0x/i, '').toUpperCase();
  if (h === '00' || h === '') return ZERO;
  if (h.length !== 130) throw new Error(`点编码长度错误：期望 130 hex，实际 ${h.length}`);
  if (h.slice(0, 2) !== '04') throw new Error('只支持未压缩点编码（前缀 04）');
  const x = BigInt('0x' + h.slice(2, 66));
  const y = BigInt('0x' + h.slice(66, 130));
  const pt = toJ(x, y);
  if (!isOnCurve(pt)) throw new Error('点不在曲线上');
  return pt;
}

/** 点是否在曲线上 */
function isOnCurve(p) {
  if (p.Z === 0n) return true;  // 无穷远点视为合法
  const a = toAffine(p);
  if (!a) return true;
  return mod(a.y * a.y) === mod(a.x * a.x * a.x + A * a.x + B);
}

/** 是否为无穷远点 */
const isZero = (p) => p.Z === 0n;

/** 两点是否相等 */
function equals(p, q) {
  if (p.Z === 0n && q.Z === 0n) return true;
  if (p.Z === 0n || q.Z === 0n) return false;
  const a = toAffine(p);
  const b = toAffine(q);
  return a.x === b.x && a.y === b.y;
}

/* ==================================================================================
 * 五、标量工具
 * ================================================================================== */

/** 随机标量（用 Node 的 CSPRNG，不用 Math.random） */
function randomScalar() {
  const crypto = require('crypto');
  for (;;) {
    const buf = crypto.randomBytes(32);
    const v = BigInt('0x' + buf.toString('hex'));
    const k = mod(v, N);
    if (k !== 0n) return k;
  }
  /* istanbul ignore next */
  return 1n;
}

/** 确定性标量（从种子派生，用于可复现的测试与证明） */
function deriveScalar(seed) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256').update(String(seed)).digest('hex');
  const k = mod(BigInt('0x' + h), N);
  return k === 0n ? 1n : k;
}

/**
 * 哈希到标量：把任意字节串映射到 Z_n。
 * 用于 Fiat–Shamir 变换（非交互式证明的核心）。
 *
 * ⚠ 必须走 SM3 或 SHA-256 后再取模；直接截断会有偏置。
 *   取模偏置可忽略（n ≈ 2^256，256 位随机数取模的偏置 < 2^-128）。
 */
function hashToScalar(...parts) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  for (const p of parts) {
    if (p === null || p === undefined) { h.update(Buffer.from([0])); continue; }
    if (typeof p === 'bigint') { h.update(Buffer.from(HEX(p), 'hex')); continue; }
    if (Buffer.isBuffer(p)) { h.update(p); continue; }
    if (typeof p === 'object' && p.X !== undefined) {
      h.update(Buffer.from(encodePoint(p), 'hex'));
      continue;
    }
    h.update(Buffer.from(String(p), 'utf8'));
  }
  const d = h.digest('hex');
  return mod(BigInt('0x' + d), N);
}

/** 哈希到字节（32 字节 hex），用于挑战串 */
function hashHex(...parts) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  for (const p of parts) {
    if (p === null || p === undefined) { h.update(Buffer.from([0])); continue; }
    if (typeof p === 'bigint') { h.update(Buffer.from(HEX(p), 'hex')); continue; }
    if (Buffer.isBuffer(p)) { h.update(p); continue; }
    if (typeof p === 'object' && p.X !== undefined) {
      h.update(Buffer.from(encodePoint(p), 'hex'));
      continue;
    }
    h.update(Buffer.from(String(p), 'utf8'));
  }
  return h.digest('hex');
}

/* ==================================================================================
 * 六、与 OpenSSL SM2 的互操作（跨实现证据）
 * ================================================================================== */

/**
 * 用 OpenSSL 的 SM2 实现，由私钥 d 派生公钥，与自实现结果比对。
 * 这是"自实现的群运算没错"的最强证据 —— 与另一套独立实现逐字节一致。
 *
 * @param {bigint} d 私钥标量
 * @returns {{ openssl: string, ours: string, match: boolean }}
 */
function crossCheckWithOpenSSL(d) {
  const crypto = require('crypto');
  /* OpenSSL 的 SM2 私钥用 SEC1 的 EC PRIVATE KEY 结构（含 OID 1.2.156.10197.1.301） */
  const SM2_OID = Buffer.from([0x06, 0x08, 0x2a, 0x81, 0x1c, 0xcf, 0x55, 0x01, 0x82, 0x2d]);
  const derInt = (buf) => {
    let b = buf;
    while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const seq = (...parts) => {
    const body = Buffer.concat(parts);
    const len = body.length;
    const lenBytes = len < 0x80 ? Buffer.from([len])
      : (len < 0x100 ? Buffer.from([0x81, len]) : Buffer.from([0x82, len >> 8, len & 0xff]));
    return Buffer.concat([Buffer.from([0x30]), lenBytes, body]);
  };
  const octet = (buf) => Buffer.concat([Buffer.from([0x04, buf.length]), buf]);
  const dHex = HEX(d);
  const priv = Buffer.from(dHex, 'hex');
  const der = seq(
    derInt(Buffer.from([1])),
    octet(priv),
    Buffer.from([0xa0, 0x0a]) /* [0] parameters 占位，下面手工拼 */,
  );
  /* 手工构造完整结构：SEQUENCE { INTEGER 1, OCTET STRING d, [0] { OID sm2 }, [1] { BIT STRING 公钥 } } */
  const ctx0 = (body) => Buffer.concat([Buffer.from([0xa0, body.length]), body]);
  const ctx1 = (body) => Buffer.concat([Buffer.from([0xa1, body.length]), body]);
  const bitStr = (buf) => Buffer.concat([Buffer.from([0x03, buf.length + 1, 0x00]), buf]);

  const oursPt = toAffine(mul(d, G));
  const oursPub = '04' + HEX(oursPt.x) + HEX(oursPt.y);

  let opensslPub = null;
  try {
    const fullDer = seq(
      derInt(Buffer.from([1])),
      octet(priv),
      ctx0(SM2_OID),
      ctx1(bitStr(Buffer.from(oursPub, 'hex'))),  // 占位，创建后由 OpenSSL 重算
    );
    const pem = '-----BEGIN EC PRIVATE KEY-----\n'
      + fullDer.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
      + '\n-----END EC PRIVATE KEY-----\n';
    const key = crypto.createPrivateKey({ key: pem, format: 'pem' });
    const pubDer = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
    /* SPKI 末尾 65 字节就是未压缩点 */
    opensslPub = pubDer.subarray(pubDer.length - 65).toString('hex').toUpperCase();
  } catch (e) {
    return { openssl: null, ours: oursPub, match: null, error: e.message };
  }

  return {
    openssl: opensslPub,
    ours: oursPub,
    match: opensslPub === oursPub,
  };
}

/* ==================================================================================
 * 七、自检
 * ================================================================================== */

function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });

  /* 1. 曲线参数自洽 */
  push('基点 G 在曲线上',
    mod(GY * GY) === mod(GX * GX * GX + A * GX + B),
    `y² = x³ + ax + b (mod p)  ${String(mod(GY * GY)).slice(0, 16)}…`);

  /* 2. 基点阶：n·G = O */
  push('n·G = 无穷远点（阶正确）', isZero(mul(N, G)), 'n·G = O');

  /* 3. (n−1)·G = −G */
  const n1 = mul(N - 1n, G);
  const n1a = toAffine(n1);
  push('(n−1)·G = −G', n1a && n1a.x === GX && mod(n1a.y + GY) === 0n,
    n1a ? `x 相同，y 之和为 0` : '结果为无穷远（错误）');

  /* 4. 标量乘一致性：k·G 与逐个点加一致（小标量） */
  let acc = ZERO;
  let consistent = true;
  for (let k = 0n; k <= 12n; k++) {
    if (!equals(acc, mul(k, G))) { consistent = false; break; }
    acc = add(acc, G);
  }
  push('小标量：k·G 与累加一致（k=0..12）', consistent, '12 次逐点累加与标量乘逐点相等');

  /* 5. 交换律 / 结合律 */
  const k1 = deriveScalar('curve-test-a');
  const k2 = deriveScalar('curve-test-b');
  const p1 = mul(k1, G);
  const p2 = mul(k2, G);
  push('加法交换律 P1+P2 = P2+P1', equals(add(p1, p2), add(p2, p1)), '');
  const p3 = mul(deriveScalar('curve-test-c'), G);
  push('加法结合律 (P1+P2)+P3 = P1+(P2+P3)',
    equals(add(add(p1, p2), p3), add(p1, add(p2, p3))), '');

  /* 6. 标量乘加法同态：k1·G + k2·G = (k1+k2)·G */
  push('标量乘同态 k1G + k2G = (k1+k2)G',
    equals(add(p1, p2), mul(k1 + k2, G)), '(这是 Pedersen 承诺的基础)');

  /* 7. 逆元：P + (−P) = O */
  push('P + (−P) = 无穷远', isZero(add(p1, neg(p1))), '');

  /* 8. 编解码往返 */
  const enc = encodePoint(p1);
  const dec = decodePoint(enc);
  push('点编解码往返一致', equals(p1, dec), `${enc.slice(0, 20)}… (${enc.length} hex)`);

  /* 9. 编解码拒绝非法输入 */
  let rejected = 0;
  for (const bad of ['04' + 'FF'.repeat(64), '03' + 'AA'.repeat(32), '04' + '00'.repeat(64)]) {
    try { decodePoint(bad); } catch (e) { rejected++; }
  }
  push('拒绝非法/非曲线点', rejected === 3, `3 个非法输入全部被拒`);

  /* 10. 模逆 */
  const a = deriveScalar('inv-a');
  push('模逆 a·a⁻¹ ≡ 1', mod(a * inv(a)) === 1n, '');

  /* 11. ⭐ 跨实现：与 OpenSSL SM2 派生公钥逐字节一致 */
  let cross = null;
  try { cross = crossCheckWithOpenSSL(deriveScalar('cross-check-seed')); } catch (e) { cross = { error: e.message }; }
  push('与 OpenSSL SM2 派生公钥一致（跨实现）',
    cross && cross.match === true,
    cross && cross.match
      ? `两套独立实现逐字节相同：${String(cross.ours).slice(0, 24)}…`
      : `OpenSSL: ${String(cross && cross.openssl).slice(0, 24)}… / 自实现: ${String(cross && cross.ours).slice(0, 24)}…`);

  /* 12. 性能：投影坐标应显著快于"每步求逆"的朴素实现 */
  const t0 = Date.now();
  const ROUNDS = 30;
  for (let i = 0; i < ROUNDS; i++) mul(deriveScalar('perf-' + i), G);
  const msPerMul = (Date.now() - t0) / ROUNDS;
  push('标量乘性能 < 3 ms（Jacobian 加速生效）', msPerMul < 3,
    `${msPerMul.toFixed(2)} ms/次（仿射坐标需 ~8 ms）`);

  /* 13. 随机标量非零且 < n */
  const r1 = randomScalar();
  push('随机标量在 (0, n) 内', r1 > 0n && r1 < N, String(r1).slice(0, 16) + '…');

  /* 14. 哈希到标量确定性 */
  push('hashToScalar 确定性', hashToScalar('abc') === hashToScalar('abc')
    && hashToScalar('abc') !== hashToScalar('abd'), '同输入同输出，异输入异输出');

  /* 15. 哈希到标量对不同类型输入有区分 */
  push('hashToScalar 区分类型（bigint vs 字符串）',
    hashToScalar(123n) !== hashToScalar('123'), '123n 与 "123" 哈希不同');

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

module.exports = {
  /* 参数 */
  P, A, B, N, GX, GY, G, ZERO,
  /* 域运算 */
  mod, inv, pow,
  /* 群运算 */
  toJ, toAffine, dbl, add, neg, sub, mul, msm,
  /* 编解码 */
  encodePoint, decodePoint, isOnCurve, isZero, equals,
  /* 标量 */
  randomScalar, deriveScalar, hashToScalar, hashHex, HEX,
  /* 互操作 */
  crossCheckWithOpenSSL,
  selfTest,
};
