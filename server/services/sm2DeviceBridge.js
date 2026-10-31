/**
 * server/services/sm2DeviceBridge.js —— 设备签名验签桥接层
 * ==================================================================
 * 安装位置：`server/services/sm2DeviceBridge.js`（由 hardware/platform-patch 复制）
 *
 * 为什么需要这一层（实测结论，不是推测）
 * ------------------------------------------------------------------
 * 平台侧现成的 gm-crypto.js#sm2Verify 走 Node `crypto.createVerify('SM3')`
 * → OpenSSL。实测反解过它真正的入签摘要：
 *
 *      由 s=(1+d)⁻¹(k−r·d) 反解 k → x1=(kG).x → e=(r−x1) mod n
 *      结果 e == SM3(M)，**不等于** SM3(ZA‖M)
 *
 * 也就是说本平台当前（Node 22 / OpenSSL 3.5）走的是**不含 ZA** 的口径，
 * 而 GM/T 0003.2 的标准口径是 e = SM3(ZA ‖ M)。
 * 二者互不兼容：直接拿标准国密设备的签名去验，必失败，且只会报"验签失败"。
 *
 * 解法（不改密码学，只改输入）
 * ------------------------------------------------------------------
 * OpenSSL 在该路径下算的是 e = SM3(送进去的 data)。
 * 那么我们**自己把 ZA 拼在消息前面**再送进去：
 *
 *      sm2Verify(pub, Buffer.concat([ZA, M]), sig)
 *      ⇒ OpenSSL 算 SM3(ZA ‖ M) ⇒ 恰好等于标准口径 ✅
 *
 * 好处：平台侧**不需要自己实现 SM2**，仍然用 Node/OpenSSL；
 *       设备端也不必为了迁就平台而做出非标实现。
 *
 * ⚠ 三条必须写死的约定（任一条不一致都会全量验签失败）
 * ------------------------------------------------------------------
 *   ① 用户标识 ID：设备端与平台侧必须同为 '1234567812345678'（16 字节）。
 *      改了它就是换了一套 ZA，所有历史签名全部作废。
 *   ② 规范化读数串 CANON：字段顺序、分隔符、定点小数位数，两端逐字符一致。
 *   ③ 签名格式：设备上报裸 r‖s（64 字节，Base64）；
 *      Node crypto 只吃 **DER**，故必须 rawToDer 转换。
 */
'use strict';

const crypto = require('node:crypto');
const gm = require('../blockchain/gm-crypto');

/* ---- SM2 曲线参数（GB/T 32918.5-2017）---- */
const SM2_A = Buffer.from('FFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFC', 'hex');
const SM2_B = Buffer.from('28E9FA9E9D9F5E344D5A9E4BCF6509A7F39789F515AB8F92DDBCBD414D940E93', 'hex');
const SM2_GX = Buffer.from('32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7', 'hex');
const SM2_GY = Buffer.from('BC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0', 'hex');

/** 用户标识：必须与设备端烧录值一致。**改它等于换一套 ZA。 */
const DEFAULT_ID = '1234567812345678';

/* ==================================================================
 * ZA 计算
 * ================================================================== */

/**
 * ZA = SM3(ENTL ‖ ID ‖ a ‖ b ‖ Gx ‖ Gy ‖ Px ‖ Py)
 * ENTL 取 ID 的**位**长度（16 字节 → 128 → 0x0080），不是字节长度。
 * @param {string} publicKeyPem 设备公钥 PEM（SPKI）
 * @param {string} [id]
 * @returns {Buffer} 32 字节
 */
function computeZa(publicKeyPem, id = DEFAULT_ID) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const point = der.subarray(der.length - 65);   // 04 || X(32) || Y(32)
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('设备公钥非未压缩格式（04||X||Y）');
  }
  const entl = Buffer.from([0x00, Buffer.byteLength(id, 'ascii') * 8]);
  return gm.sm3Buf(Buffer.concat([
    entl, Buffer.from(id, 'ascii'),
    SM2_A, SM2_B, SM2_GX, SM2_GY,
    point.subarray(1, 33), point.subarray(33, 65),
  ]));
}

/* ==================================================================
 * DER ↔ 裸 r‖s
 * ================================================================== */

function derInt(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let v = buf.subarray(i);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v]);   // 正数补零
  return Buffer.concat([Buffer.from([0x02, v.length]), v]);
}

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}

/** 裸 r‖s（64B）→ DER SEQUENCE。Node crypto 只吃 DER。 */
function rawToDer(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 64) {
    throw new Error(`裸签名应为 64 字节，实为 ${raw && raw.length}`);
  }
  const body = Buffer.concat([derInt(raw.subarray(0, 32)), derInt(raw.subarray(32, 64))]);
  return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
}

/** DER → 裸 r‖s（64B） */
function derToRaw(der) {
  if (!Buffer.isBuffer(der) || der[0] !== 0x30) throw new Error('非 DER SEQUENCE');
  let i = 1;
  let n = der[i++];
  if (n & 0x80) {
    const nb = n & 0x7f;
    n = der.readUIntBE(i, nb);
    i += nb;
  }
  const body = der.subarray(i, i + n);
  const ints = [];
  let j = 0;
  while (j < body.length && ints.length < 2) {
    if (body[j] !== 0x02) throw new Error('DER 结构异常');
    const len = body[j + 1];
    ints.push(body.subarray(j + 2, j + 2 + len));
    j += 2 + len;
  }
  /* DER 的 INTEGER 若最高位为 1 会带一个 0x00 前导字节（33 字节），
   * 直接 Buffer.concat 会算出负的补零长度。必须先剥前导零。 */
  const pad = (b) => {
    let k = 0;
    while (k < b.length - 1 && b[k] === 0) k++;
    const v = b.subarray(k);
    if (v.length > 32) throw new Error('签名整数超过 32 字节');
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  return Buffer.concat([pad(ints[0]), pad(ints[1])]);
}

/* ==================================================================
 * 规范化读数串（签名对象）
 * ==================================================================
 * ⚠ 必须与设备端 firmware/src/cc_canon.c 的 build_canon() **逐字符一致**。
 *   两端任一处不同（字段顺序、分隔符、小数位数），验签 100% 失败。
 *
 * ⚠ 浮点一律走定点字符串：%.3f / %.9f。
 *   若两端各自用二进制浮点序列化，"12.5" 与 "12.500000000000001" 摘要必然不同，
 *   表现为"数据没错却天天验签失败"。
 */
const CANON_FACTORS = ['a05001', 'a01011', 'a01012', 'a01013', 'a01014', 'a19001', 'a01016'];

function fmt(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`因子值非有限数：${v}`);
  return n.toFixed(digits);
}

/**
 * 构造 CANON 串。
 * @param {object} o { mn, qn, dataTime, devSeq, challenge, factors:{code:value}, gdev }
 */
function buildCanon(o = {}) {
  const parts = [
    String(o.mn || ''),
    String(o.qn || ''),
    String(o.dataTime || ''),
    String(o.devSeq == null ? '' : o.devSeq),
    String(o.challenge || ''),
  ];
  for (const code of CANON_FACTORS) {
    const v = (o.factors || {})[code];
    parts.push(`${code}=${fmt(v, 3)}`);
  }
  parts.push(`G=${fmt((o.gdev == null ? 0 : o.gdev), 9)}`);
  return parts.join('|');
}

/* ==================================================================
 * 验签（对外主入口）
 * ================================================================== */

/**
 * 验签一条设备读数。
 *
 * 兼容策略：**标准优先，非标回退**。
 *   · 先按标准（拼 ZA）验 —— 通过则 mode='STD'
 *   · 失败再按平台历史口径（不拼 ZA）验 —— 通过则 mode='NO_ZA'，并**记录告警**，
 *     因为这类设备不符合 GM/T 0003，应在台账中标记并限期整改，而不是默默放过。
 *
 * @param {string} publicKeyPem
 * @param {string|Buffer} canon  规范化读数串（buildCanon 的输出）
 * @param {Buffer|string} sigRaw 裸 r‖s（Buffer）或其 base64（string）
 * @param {object} [opts] { id }
 * @returns {{ok:boolean, mode:string|null, reason?:string}}
 */
function verifyDevice(publicKeyPem, canon, sigRaw, opts = {}) {
  if (!gm.available) return { ok: false, mode: null, reason: 'GM_UNAVAILABLE' };
  if (!publicKeyPem) return { ok: false, mode: null, reason: 'NO_PUBKEY' };

  let raw;
  try {
    raw = Buffer.isBuffer(sigRaw) ? sigRaw : Buffer.from(String(sigRaw), 'base64');
    if (raw.length !== 64) return { ok: false, mode: null, reason: 'BAD_SIG_LEN' };
  } catch (e) {
    return { ok: false, mode: null, reason: 'BAD_SIG_B64' };
  }

  const msg = Buffer.isBuffer(canon) ? canon : Buffer.from(String(canon), 'utf8');
  let der;
  try {
    der = rawToDer(raw);
  } catch (e) {
    return { ok: false, mode: null, reason: 'BAD_SIG_FORMAT' };
  }

  try {
    const za = computeZa(publicKeyPem, opts.id || DEFAULT_ID);
    if (gm.sm2Verify(publicKeyPem, Buffer.concat([za, msg]), der.toString('base64'))) {
      return { ok: true, mode: 'STD' };
    }
  } catch (e) { /* 落到回退分支 */ }

  try {
    if (gm.sm2Verify(publicKeyPem, msg, der.toString('base64'))) {
      return { ok: true, mode: 'NO_ZA' };   // 非标设备，须告警
    }
  } catch (e) { /* 忽略 */ }

  return { ok: false, mode: null, reason: 'SIG_MISMATCH' };
}

/**
 * 平台侧以设备口径签名（用于 OTA 固件包签名、平台下发的挑战数回执等）。
 * 与 verifyDevice 的 STD 口径互逆。
 */
function signAsDevice(privateKeyPem, data, opts = {}) {
  const msg = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const pub = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
  const za = computeZa(crypto.createPublicKey(privateKeyPem)
    .export({ type: 'spki', format: 'pem' }), opts.id || DEFAULT_ID);
  void pub;
  return gm.sm2Sign(privateKeyPem, Buffer.concat([za, msg]));
}

/* ==================================================================
 * 自检（阴性对照：只测"能通过"不算验证）
 * ================================================================== */

function selfTest() {
  const out = [];
  const t = (name, pass, note) => out.push({ name, pass: !!pass, note: note || '' });

  if (!gm.available) {
    t('国密可用', false, gm.CAPS.reason);
    return { pass: false, total: 1, passed: 0, details: out };
  }
  t('国密套件可用（SM2 + SM3）', true, `OpenSSL ${gm.CAPS.openssl}`);

  const kp = gm.generateSm2WalletDeterministic('CC-BRIDGE-SELFTEST');
  const canon = buildCanon({
    mn: '010000A8900016F000169DC0', qn: '20261013120000000',
    dataTime: '20261013120000', devSeq: 104857, challenge: '9f2a'.repeat(16),
    factors: { a05001: 120000, a01011: 8.5, a01012: 96.4, a01013: 101.2, a01014: 12.3, a19001: 6.8, a01016: 2.5 },
    gdev: 0.001234567,
  });

  // 平台按 STD 口径签（ZA‖M），等价于一台标准设备
  let sigDer;
  try {
    sigDer = gm.sm2Sign(kp.privateKey, Buffer.concat([computeZa(kp.publicKey), Buffer.from(canon, 'utf8')]));
  } catch (e) {
    t('平台侧可产生标准签名', false, e.message);
    return { pass: false, total: out.length, passed: out.filter((x) => x.pass).length, details: out };
  }
  const raw = derToRaw(Buffer.from(sigDer, 'base64'));

  t('① 标准签名（含 ZA）验过', verifyDevice(kp.publicKey, canon, raw).ok === true);
  t('① 验签结果 mode=STD', verifyDevice(kp.publicKey, canon, raw).mode === 'STD');
  t('② 篡改消息应验不过（阴性对照）',
    verifyDevice(kp.publicKey, canon + 'x', raw).ok === false);

  const bad = Buffer.from(raw); bad[0] ^= 0x01;
  t('③ 篡改签名应验不过（阴性对照）', verifyDevice(kp.publicKey, canon, bad).ok === false);

  t('④ 签名长度非 64 字节应被拒（阴性对照）',
    verifyDevice(kp.publicKey, canon, raw.subarray(0, 63)).ok === false);

  // 非标（不含 ZA）设备应走回退并被标记
  const sigNoZa = gm.sm2Sign(kp.privateKey, Buffer.from(canon, 'utf8'));
  const rawNoZa = derToRaw(Buffer.from(sigNoZa, 'base64'));
  const r5 = verifyDevice(kp.publicKey, canon, rawNoZa);
  t('⑤ 非标签名走回退且被标记 NO_ZA', r5.ok === true && r5.mode === 'NO_ZA',
    '这类设备应在台账告警并限期整改');

  // ID 敏感性
  t('⑥ 换用户 ID 后应验不过（阴性对照）',
    verifyDevice(kp.publicKey, canon, raw, { id: 'CEN100-OTHER-ID' }).ok === false,
    '证明 ID 必须双方写死一致');

  // DER 往返
  t('⑦ raw→DER→raw 往返恒等', derToRaw(rawToDer(raw)).equals(raw));

  const passed = out.filter((x) => x.pass).length;
  return { pass: passed === out.length, total: out.length, passed, details: out };
}

module.exports = {
  DEFAULT_ID, CANON_FACTORS,
  computeZa, rawToDer, derToRaw, buildCanon, verifyDevice, signAsDevice,
  selfTest,
};
