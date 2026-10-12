/**
 * sm2-keystore.js —— SM2 密钥托管（国密生产化）
 * ==================================================================
 * 与 keystore.js（套件 A / secp256k1 + ECDSA）并列的第二套密钥库。
 * 差异不只是曲线：这里要解决一个 ECDSA 那套没有正面回答的问题 ——
 * **密钥轮换之后，用旧私钥签出来的历史签名还算不算数？**
 *
 * 本模块的答案（也是 WP2 阶段一最值得讲的技术点）：
 *   轮换时把当前密钥**降级为历史公钥**（丢弃私钥、仅保留公钥与指纹），
 *   新签名的用新私钥，历史签名的仍然可以用历史公钥验通过。
 *   即：**轮换不破坏历史可验证性**。
 *   如果轮换时把旧密钥整个删掉，全链的历史签名会集体验签失败 ——
 *   那等于用"更安全"的名义毁掉了账本的可核验性。
 *
 * 存储
 *   server/sm2-keystore.json，与 keystore.json 同款 AES-256-GCM 整体加密
 *   （KEYSTORE_SECRET 未配置时明文落盘，仅限开发；启动时会打警告）。
 *   ⚠ 生产环境应替换为 HSM / KMS。本模块预留 provider 抽象，
 *     接 HSM 时实现 signWithProvider() 即可，调用方无需改动。
 * ==================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gm = require('./gm-crypto');
const config = require('../config');

const FILE = process.env.SM2_KEYSTORE_FILE
  ? path.resolve(process.env.SM2_KEYSTORE_FILE)
  : path.resolve(path.dirname(config.paths.keystore), 'sm2-keystore.json');

/** { [label]: { label, provider, current:{...}, history:[...], createdAt, updatedAt } } */
let store = {};

function encKey() {
  const s = process.env.KEYSTORE_SECRET;
  if (!s) return null;
  return crypto.createHash('sha256').update(String(s)).digest();
}

function encryptStore(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {
    __enc: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptStore(payload) {
  const key = encKey();
  if (!key) throw new Error('SM2 密钥库为加密格式，但未配置 KEYSTORE_SECRET，无法解密');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      store = raw && raw.__enc ? decryptStore(raw) : raw;
    }
  } catch (e) {
    store = {};
  }
  sanitize();
  return store;
}

/**
 * 自愈：修复"新世代与旧世代派生出同一把密钥"的历史脏数据。
 *
 * 成因：nextKeyId 曾按 `history.length + 1` 计算。对**从未轮换过**的记录
 * （history 为空）会算出 1，而 current.keyId 本来就是 1 —— 撞号后
 * `generateSm2WalletDeterministic('<label>#g1')` 给出的是同一把密钥，
 * "轮换"于是变成空操作：地址不变、历史条目和当前世代共用同一份密钥材料，
 * 而台账上却记了一次轮换。这是**最坏的一类密码学缺陷**：
 * 表面上"做了轮换"，实际上前向安全性一点没提升。
 *
 * 处理：丢弃与 current 地址完全相同的 history 条目；若修复后 current 的
 * keyId 与任一历史条目撞号，则按 (最大已用 keyId + 1) 重新派生 current，
 * 让这次轮换真正发生。只在检测到脏数据时才写盘。
 */
function sanitize() {
  let dirty = false;
  for (const label of Object.keys(store)) {
    const rec = store[label];
    if (!rec || !rec.current) continue;
    const hist = Array.isArray(rec.history) ? rec.history : (rec.history = []);
    const before = hist.length;
    rec.history = hist.filter((h) => h && h.address !== rec.current.address);
    if (rec.history.length !== before) dirty = true;

    const used = new Set(rec.history.map((h) => Number(h.keyId)).filter(Number.isFinite));
    if (used.has(Number(rec.current.keyId))) {
      const next = (used.size ? Math.max(...used) : 0) + 1;
      const w = gm.generateSm2WalletDeterministic(`${label}#g${next}`);
      rec.current = {
        keyId: next,
        address: w.address,
        publicKey: w.publicKey,
        privateKey: w.privateKey,
        fingerprint: fingerprint(w.publicKey),
        createdAt: new Date().toISOString(),
        regeneratedBy: 'sanitize(): 修复与历史世代撞号的当前密钥',
      };
      dirty = true;
    }
    rec.updatedAt = rec.updatedAt || new Date().toISOString();
  }
  if (dirty) {
    try { save(); } catch (e) { /* 只读环境下降级为内存修复 */ }
  }
  return dirty;
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const body = encKey() ? encryptStore(store) : store;
  fs.writeFileSync(FILE, JSON.stringify(body, null, 2), 'utf8');
}

/** 公钥指纹：SM3(SPKI-DER) —— 与地址派生同源，便于人工核对 */
function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return gm.sm3(der);
}

/**
 * 密钥代数编号：label 内自增，便于在日志里说清"第几代"。
 *
 * ⚠ 必须锚定 **current.keyId**，不能锚定 history.length。
 * 后者在"从未轮换过"的记录上会算出 1，与 current.keyId 撞号，
 * 于是确定性派生得到同一把密钥 —— 轮换变成空操作（详见 sanitize() 的注释）。
 */
function nextKeyId(rec) {
  const cur = rec && rec.current ? Number(rec.current.keyId) : 0;
  const hist = rec && Array.isArray(rec.history) ? rec.history.map((h) => Number(h.keyId)) : [];
  const max = hist.reduce((a, b) => (Number.isFinite(b) && b > a ? b : a), Number.isFinite(cur) ? cur : 0);
  return max + 1;
}

function available() { return gm.available; }
function capability() {
  return {
    available: gm.available,
    reason: gm.available ? null : (gm.CAPS && gm.CAPS.reason) || 'OpenSSL 未编译国密算法',
    suite: 'SM2（GB/T 32918） + SM3（GB/T 32905）',
    signing: 'SM2-with-SM3（OpenSSL createSign("SM3") + SM2 私钥）',
    curve: gm.CAPS && gm.CAPS.curve ? gm.CAPS.curve : null,
    storeFile: FILE,
    storeEncrypted: !!encKey(),
    provider: 'SOFTWARE（本地密钥库）',
    hsmReady: false,
    hsmNote: '已预留 provider 抽象：接入 HSM/KMS 时实现 signWithProvider()，调用方无需改动。当前**未接硬件加密机**，如实声明。',
  };
}

/**
 * 取某个主体的 SM2 密钥记录，不存在则生成第 1 代。
 * 用确定性派生 ⇒ 同一 label 在任何机器上得到同一对密钥，跨环境可复现。
 */
function ensure(label, opts = {}) {
  if (!gm.available) {
    throw new Error('SM2 不可用：' + ((gm.CAPS && gm.CAPS.reason) || 'OpenSSL 未编译国密算法'));
  }
  let rec = store[label];
  if (!rec) {
    const keyId = 1;
    const w = gm.generateSm2WalletDeterministic(`${label}#g${keyId}`);
    rec = store[label] = {
      label,
      provider: opts.provider || 'SOFTWARE',
      current: {
        keyId,
        address: w.address,
        publicKey: w.publicKey,
        privateKey: w.privateKey,
        fingerprint: fingerprint(w.publicKey),
        createdAt: new Date().toISOString(),
      },
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    save();
  }
  return rec;
}

/** 当前世代的密钥（含私钥）—— 只在本进程内使用，绝不外传 */
function currentKey(label) {
  const rec = ensure(label);
  return { ...rec.current, label, provider: rec.provider };
}

/**
 * 执行轮换：当前密钥降级进 history（**丢弃私钥，只留公钥与指纹**），生成下一代。
 * @returns {{oldKeys:object, newKeys:object}}
 */
function rotate(label, reason) {
  const rec = ensure(label);
  const old = rec.current;
  const keyId = nextKeyId(rec);
  const w = gm.generateSm2WalletDeterministic(`${label}#g${keyId}`);
  const nu = {
    keyId,
    address: w.address,
    publicKey: w.publicKey,
    privateKey: w.privateKey,
    fingerprint: fingerprint(w.publicKey),
    createdAt: new Date().toISOString(),
  };
  /* 关键：历史条目只保留公钥，不保留私钥 —— 既能验历史签名，又不能重签历史 */
  rec.history.push({
    keyId: old.keyId,
    address: old.address,
    publicKey: old.publicKey,
    fingerprint: old.fingerprint,
    createdAt: old.createdAt,
    retiredAt: new Date().toISOString(),
    retiredReason: reason || null,
  });
  rec.current = nu;
  rec.updatedAt = new Date().toISOString();
  save();
  return {
    oldKeys: { keyId: old.keyId, address: old.address, fingerprint: old.fingerprint, createdAt: old.createdAt },
    newKeys: { keyId: nu.keyId, address: nu.address, fingerprint: nu.fingerprint, createdAt: nu.createdAt },
  };
}

/** SM2 签名（私钥不出本模块） */
function sign(label, data) {
  const k = currentKey(label);
  const sig = gm.sm2Sign(k.privateKey, typeof data === 'string' ? data : Buffer.from(data));
  return {
    keyId: k.keyId,
    address: k.address,
    fingerprint: k.fingerprint,
    algorithm: 'SM2-with-SM3',
    signature: sig,
    signedAt: new Date().toISOString(),
  };
}

/**
 * 验签（不指定世代时，**依次尝试当前与全部历史公钥**）。
 * 这是"轮换不破坏历史可验证性"的实现点：
 * 轮换后旧的签名仍会被历史公钥验通过，并回报是哪一代密钥签的。
 */
function verify(label, data, signature, keyId) {
  if (!gm.available) return { valid: false, reason: 'SM2 不可用' };
  const rec = store[label];
  if (!rec) return { valid: false, reason: `未登记的主体 ${label}` };
  const buf = typeof data === 'string' ? data : Buffer.from(data);

  const candidates = [];
  if (keyId === undefined || keyId === null) {
    candidates.push(rec.current);
    rec.history.forEach((h) => candidates.push(h));
  } else {
    if (rec.current.keyId === Number(keyId)) candidates.push(rec.current);
    rec.history.filter((h) => h.keyId === Number(keyId)).forEach((h) => candidates.push(h));
  }

  for (const k of candidates) {
    if (gm.sm2Verify(k.publicKey, buf, signature)) {
      return {
        valid: true,
        keyId: k.keyId,
        address: k.address,
        fingerprint: k.fingerprint,
        generation: k.keyId === rec.current.keyId ? 'CURRENT' : 'HISTORICAL',
        note: k.keyId === rec.current.keyId
          ? '当前世代密钥验签通过'
          : `历史第 ${k.keyId} 代密钥验签通过 —— 密钥已轮换但历史签名依然有效`,
      };
    }
  }
  return { valid: false, reason: '当前世代与全部历史公钥均未验通过（签名被篡改或密钥不属于该主体）' };
}

function record(label) {
  const rec = store[label];
  if (!rec) return null;
  return {
    label: rec.label,
    provider: rec.provider,
    current: { keyId: rec.current.keyId, address: rec.current.address, fingerprint: rec.current.fingerprint, createdAt: rec.current.createdAt },
    history: (rec.history || []).map((h) => ({ keyId: h.keyId, address: h.address, fingerprint: h.fingerprint, createdAt: h.createdAt, retiredAt: h.retiredAt })),
    generations: 1 + (rec.history || []).length,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

function labels() { return Object.keys(store); }
function all() { return store; }
function reload() { load(); return store; }

load();

module.exports = {
  FILE, available, capability, fingerprint,
  ensure, currentKey, rotate, sign, verify, record, labels, all, reload,
};
