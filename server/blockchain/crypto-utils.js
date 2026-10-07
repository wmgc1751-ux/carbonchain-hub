/**
 * crypto-utils.js —— 密码学工具层
 * ------------------------------------------------------------------
 * 本模块为整个"碳链通"平台提供真实的密码学原语，不依赖任何第三方区块链
 * 框架，全部基于 Node.js 内置 crypto 模块实现：
 *
 *   1. SHA-256 摘要          —— 区块哈希、交易哈希、Merkle 树、口令摘要
 *   2. Merkle 树             —— 区块内交易的完整性根，O(log n) 验证
 *   3. secp256k1 密钥对      —— 企业/机构的链上钱包身份
 *   4. ECDSA 数字签名        —— 交易不可抵赖（谁发的、发的是不是原文）
 *   5. 钱包地址派生          —— 由公钥单向派生 0x 地址，不可反推
 *
 * @module blockchain/crypto-utils
 */
'use strict';

const crypto = require('crypto');

/** 难度前缀字符：PoW 要求哈希以 N 个 '0' 开头 */
const ZERO = '0';

/* ==================================================================
 * 一、摘要相关
 * ================================================================== */

/**
 * 计算 SHA-256 摘要（十六进制小写）
 * @param {string|Buffer} data 待摘要数据
 * @returns {string} 64 位十六进制字符串
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 对任意对象做"规范化序列化"后再摘要。
 * 关键点：key 必须排序，否则 {a:1,b:2} 与 {b:2,a:1} 会算出不同哈希，
 * 同一个业务数据在不同节点上就得不到一致的摘要，共识会崩。
 * @param {*} obj
 * @returns {string}
 */
function stableStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * 对象稳定哈希
 * @param {*} obj
 * @returns {string}
 */
function hashObject(obj) {
  return sha256(stableStringify(obj));
}

/* ==================================================================
 * 二、Merkle 树
 * ================================================================== */

/**
 * 计算交易哈希列表的 Merkle 根。
 * 奇数个节点时复制最后一个节点（比特币同款处理方式），
 * 保证任意叶子节点的存在性可被 O(log n) 证明。
 * @param {string[]} hashes 交易哈希数组（叶节点）
 * @returns {string} 根哈希；空列表返回 64 个 0
 */
function merkleRoot(hashes) {
  if (!hashes || hashes.length === 0) return ZERO.repeat(64);
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(level[i] + level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

/**
 * 生成 Merkle 证明路径（用于轻节点验证某笔交易确实在区块里）
 * @param {string[]} hashes
 * @param {number} index 目标叶子下标
 * @returns {{root:string, path:Array<{position:string,hash:string}>}}
 */
function merkleProof(hashes, index) {
  const root = merkleRoot(hashes);
  const path = [];
  if (!hashes || hashes.length === 0) return { root, path };
  let level = hashes.slice();
  let idx = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    path.push({ position: idx % 2 === 0 ? 'right' : 'left', hash: level[sibling] });
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { root, path };
}

/**
 * 校验 Merkle 证明
 * @param {string} leafHash
 * @param {Array<{position:string,hash:string}>} path
 * @param {string} root
 * @returns {boolean}
 */
function verifyMerkleProof(leafHash, path, root) {
  let cur = leafHash;
  for (const step of path) {
    cur = step.position === 'right' ? sha256(cur + step.hash) : sha256(step.hash + cur);
  }
  return cur === root;
}

/* ==================================================================
 * 三、钱包：secp256k1 密钥对 / 地址派生 / ECDSA 签名
 * ================================================================== */

/**
 * 生成一个 secp256k1 钱包
 * @returns {{address:string, publicKey:string, privateKey:string}}
 */
function generateWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { address: deriveAddress(publicKey), publicKey, privateKey };
}

/**
 * 生成【确定性】secp256k1 钱包：同一 label 任意时刻、任意机器都得到同一对密钥。
 * ------------------------------------------------------------------
 * 做法：把 label 用 SHA-256 摘要成 32 字节确定性标量，取其模曲线阶的余数作为私钥 d，
 * 再用 PKCS#8 DER 手写封装（INTEGER d / OID secp256k1 / BIT STRING 公钥点），最后包装成 PEM。
 *
 * 为什么要它：
 *   数据库初始化脚本需要在「本机 MySQL」和「云端 TiDB」跑出**完全一致**的存证数据，
 *   否则同一套 SQL 备份在两端重算出来的签名不同，链下比对必然失败。
 *   随机密钥做不到这一点。固定算法种子 ⇒ 可复现的密钥 ⇒ 可复现的链。
 *
 * @param {string} label 形如 'ent:12' / 'verifier:3' / 'regulator:system'
 * @returns {{address:string, publicKey:string, privateKey:string}}
 */
function generateWalletDeterministic(label) {
  const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  // 把 label 摘要成 32 字节，再对曲线阶取模，得到合法私钥标量（0 < d < n）
  const hex = sha256(`carbonchain-hub/keystore/v1|${label}`);
  const d = (BigInt('0x' + hex) % (ORDER - 1n)) + 1n;
  const dBytes = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');

  // DER 封装 PKCS#8（RFC 5915 内层 + RFC 5208 外层），Node 的 openssl 可直接解析
  const der = pkcs8FromScalar(dBytes);
  const privateKey = derToPem('EC PRIVATE KEY', der);
  const keyObj = crypto.createPrivateKey(privateKey);
  const publicKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });

  return { address: deriveAddress(publicKey), publicKey, privateKey };
}

/** 把 32 字节私钥标量封装成 SEC1(PKCS#1) EC PRIVATE KEY 的 DER */
function pkcs8FromScalar(scalar) {
  const seq = (...parts) => {
    const body = Buffer.concat(parts);
    const len = body.length < 0x80
      ? Buffer.from([body.length])
      : Buffer.from([0x81, body.length]);
    return Buffer.concat([Buffer.from([0x30]), len, body]);
  };
  const int = (buf) => {
    const b = buf[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const octet = (buf) => Buffer.concat([Buffer.from([0x04, buf.length]), buf]);
  const secp256k1Oid = Buffer.from([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]);
  // ECPrivateKey ::= SEQUENCE { version INTEGER 1, privateKey OCTET STRING, parameters [0] secp256k1 }
  return seq(
    int(Buffer.from([0x01])),
    octet(scalar),
    Buffer.concat([Buffer.from([0xa0, secp256k1Oid.length]), secp256k1Oid]),
  );
}

/** DER 字节 → PEM 文本 */
function derToPem(label, der) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * 由公钥派生钱包地址：addr = '0x' + sha256(DER公钥).slice(0,40)
 * 单向派生 —— 拿地址无法还原公钥，拿公钥无法还原私钥。
 * @param {string} publicKeyPem
 * @returns {string}
 */
function deriveAddress(publicKeyPem) {
  const der = crypto
    .createPublicKey(publicKeyPem)
    .export({ type: 'spki', format: 'der' });
  return '0x' + sha256(der).slice(0, 40);
}

/**
 * 用私钥对数据做 ECDSA(SHA-256) 签名
 * @param {string} privateKeyPem
 * @param {string} data
 * @returns {string} base64 签名
 */
function sign(privateKeyPem, data) {
  const signer = crypto.createSign('SHA256');
  signer.update(data, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

/**
 * 用公钥验签
 * @param {string} publicKeyPem
 * @param {string} data
 * @param {string} signature base64
 * @returns {boolean}
 */
function verify(publicKeyPem, data, signature) {
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(data, 'utf8');
    verifier.end();
    return verifier.verify(publicKeyPem, signature, 'base64');
  } catch (e) {
    return false;
  }
}

/* ==================================================================
 * 四、口令摘要（登录认证用，业务库中不存明文口令）
 * ================================================================== */

/**
 * 生成随机盐
 * @param {number} len
 * @returns {string}
 */
function randomSalt(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

/**
 * 口令摘要：SHA256(salt + password)
 * @param {string} password
 * @param {string} salt
 * @returns {string}
 */
function hashPassword(password, salt) {
  return sha256(salt + password);
}

/**
 * 生成业务单号 / 随机标识
 * @param {string} prefix
 * @returns {string}
 */
function bizNo(prefix) {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  return `${prefix}${stamp}${crypto.randomInt(1000, 9999)}`;
}

module.exports = {
  sha256,
  stableStringify,
  hashObject,
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
  generateWallet,
  generateWalletDeterministic,
  deriveAddress,
  sign,
  verify,
  randomSalt,
  hashPassword,
  bizNo,
  ZERO,
};
