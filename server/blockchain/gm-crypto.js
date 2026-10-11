/**
 * gm-crypto.js —— 国密（商用密码）套件层
 * ------------------------------------------------------------------
 * 本模块为"碳链通"提供**与国际套件对等的国产密码学原语**，与 crypto-utils.js
 * 中的 secp256k1 / SHA-256 套件并列构成"双密码套件"，可在链上按策略切换：
 *
 *   ┌ 套件 A（国际通用）  secp256k1 + SHA-256 + ECDSA   —— 对标以太坊/Fabric 生态
 *   └ 套件 B（国密合规）  SM2       + SM3     + SM2签名  —— 对标《密码法》《数据安全法》
 *
 * 实现依据的标准（全部为国家/行业公开标准，可公开引用、可复核）：
 *   · GB/T 32918.1-2016 / GB/T 32918.2-2016《信息安全技术 SM2 椭圆曲线公钥密码算法》
 *   · GB/T 32905-2016《信息安全技术 SM3 密码杂凑算法》  （等同 GM/T 0004-2012）
 *   · GB/T 35276-2017《信息安全技术 SM2 密码算法使用规范》
 *
 * 实现方式与可信性
 * ------------------------------------------------------------------
 * 本模块**不自研密码算法**（自研密码算法在工程上不可接受、在评审中也不可信），
 * 而是调用 Node.js 内置 `crypto` 模块所绑定的 **OpenSSL 3.x 国密实现**：
 *   - 曲线：`SM2`（即 sm2p256v1，OpenSSL 命名 SM2）
 *   - 摘要：`sm3`
 *   - 签名：`createSign('SM3')` + SM2 私钥 ⇒ SM2-with-SM3 签名
 * OpenSSL 3.x 已通过国家密码管理局商用密码检测中心的安全性检测，是政务、金融
 * 领域国产化改造中的主流底座。
 *
 * 正确性自证（conformance）
 * ------------------------------------------------------------------
 * 本模块内置**标准测试向量自检**：SM3('abc') 必须等于 GB/T 32905-2016 附录 A
 * 给出的官方杂凑值 66c7f0f4...b8f4ba8e0。任一部署环境中可通过
 * `gmCrypto.conformance()` 现场复核，避免"宣称国密、实际未启用"的合规虚标。
 *
 * 降级策略
 * ------------------------------------------------------------------
 * 若运行环境的 OpenSSL 未编译国密算法（`gmCrypto.available === false`），
 * 本模块的所有函数抛出可捕获的错误，调用方（chain.js / 业务层）应回落到套件 A。
 * 平台启动不因国密不可用而失败。
 *
 * @module blockchain/gm-crypto
 */
'use strict';

const crypto = require('crypto');

/* ==================================================================
 * 零、能力探测
 * ================================================================== */

/** SM3 官方标准测试向量（GB/T 32905-2016 附录 A / GM/T 0004-2012 附录 A） */
const SM3_TEST_VECTOR = Object.freeze([
  { msg: 'abc', digest: '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0' },
  {
    msg: 'abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
    digest: 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732',
  },
]);

/** 能力探测结果（模块加载时一次性判定） */
const CAPS = (function detect() {
  const out = {
    sm3: false,
    sm2: false,
    openssl: process.versions.openssl || 'unknown',
    node: process.version,
    curve: null,
    reason: '',
  };
  try {
    out.sm3 = crypto.getHashes().some((h) => String(h).toLowerCase() === 'sm3');
  } catch (e) { out.sm3 = false; }
  try {
    out.sm2 = crypto.getCurves().some((c) => String(c).toUpperCase() === 'SM2');
  } catch (e) { out.sm2 = false; }
  if (!out.sm3 || !out.sm2) {
    out.reason = 'OpenSSL 未编译国密算法（需 OpenSSL 1.1.1+ / 3.x 且启用 SM2、SM3）';
  } else {
    // 实测一次密钥生成，确认曲线真的可用（getCurves 只是列出名称）
    try {
      crypto.generateKeyPairSync('ec', { namedCurve: 'SM2' });
      out.curve = 'SM2';
    } catch (e) {
      out.sm2 = false;
      out.reason = 'SM2 曲线不可用：' + e.message;
    }
  }
  return Object.freeze(out);
})();

/** 模块是否可用（SM2 + SM3 均就绪） */
const available = CAPS.sm3 && CAPS.sm2;

function assertAvailable() {
  if (!available) {
    const err = new Error('[gm-crypto] 国密套件不可用：' + (CAPS.reason || '未知原因'));
    err.code = 'GM_UNAVAILABLE';
    throw err;
  }
}

/* ==================================================================
 * 一、SM3 杂凑
 * ================================================================== */

/**
 * SM3 摘要（GB/T 32905-2016），输出 64 位十六进制小写
 * @param {string|Buffer} data
 * @returns {string}
 */
function sm3(data) {
  assertAvailable();
  return crypto.createHash('sm3').update(data).digest('hex');
}

/**
 * SM3 摘要（输出 Buffer，供 Merkle 等二进制拼接场景使用）
 * @param {string|Buffer} data
 * @returns {Buffer}
 */
function sm3Buf(data) {
  assertAvailable();
  return crypto.createHash('sm3').update(data).digest();
}

/* ==================================================================
 * 二、SM2 密钥对与地址
 * ================================================================== */

/** SM2 曲线推荐参数（GB/T 32918.5-2017）—— 曲线阶 n */
const SM2_ORDER = BigInt('0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123');
/** SM2 曲线 OID（1.2.156.10197.1.301）的 DER 编码 */
const SM2_OID_DER = Buffer.from([0x06, 0x08, 0x2a, 0x81, 0x1c, 0xcf, 0x55, 0x01, 0x82, 0x2d]);

/** DER 辅助：SEQUENCE */
function derSeq(...parts) {
  const body = Buffer.concat(parts);
  const len = body.length < 0x80
    ? Buffer.from([body.length])
    : body.length < 0x100
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([0x30]), len, body]);
}
/** DER 辅助：INTEGER */
function derInt(buf) {
  const b = buf[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
}
/** DER 辅助：OCTET STRING */
function derOctet(buf) {
  return Buffer.concat([Buffer.from([0x04, buf.length]), buf]);
}
/** DER 辅助：CONTEXT [0] 显式标签（曲线参数） */
function derCtx0(buf) {
  return Buffer.concat([Buffer.from([0xa0, buf.length]), buf]);
}
/** DER → PEM */
function derToPem(label, der) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * 由 32 字节私钥标量构造 SEC1（RFC 5915）私钥 PEM。
 * SM2 与 secp256k1 的 DER 结构完全相同，仅曲线 OID 不同，
 * 因此同一套封装逻辑可用于双套件 —— 这也是国密改造可以最小侵入落地的原因。
 * @param {Buffer} scalar 32 字节
 * @returns {string} PEM
 */
function sec1PemFromScalar(scalar) {
  const der = derSeq(
    derInt(Buffer.from([0x01])),                 // version = 1
    derOctet(scalar),                            // privateKey
    derCtx0(SM2_OID_DER),                        // parameters [0] = SM2 OID
  );
  return derToPem('EC PRIVATE KEY', der);
}

/**
 * 生成随机 SM2 密钥对
 * @returns {{suite:string, address:string, publicKey:string, privateKey:string}}
 */
function generateSm2Wallet() {
  assertAvailable();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'SM2',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { suite: 'SM2', address: sm2Address(publicKey), publicKey, privateKey };
}

/**
 * 生成【确定性】SM2 密钥对：同一 label 在任意机器上得到同一对密钥。
 * 用途与 crypto-utils.generateWalletDeterministic 一致：让本机 MySQL 与云端 TiDB
 * 用同一套 SQL 初始化出**完全一致**的国密存证数据。
 * @param {string} label 形如 'ent:12' / 'node:node-bank-招商' / 'device:did:meter:power:07'
 * @returns {{suite:string, address:string, publicKey:string, privateKey:string}}
 */
function generateSm2WalletDeterministic(label) {
  assertAvailable();
  const hex = sm3(`carbonchain-hub/keystore/sm2/v1|${label}`);
  const d = (BigInt('0x' + hex) % (SM2_ORDER - 1n)) + 1n;
  const scalar = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
  const privateKey = sec1PemFromScalar(scalar);
  const keyObj = crypto.createPrivateKey(privateKey);
  const publicKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
  return { suite: 'SM2', address: sm2Address(publicKey), publicKey, privateKey };
}

/**
 * 由 SM2 公钥派生链上地址：'0x' + SM3(SPKI-DER).slice(0, 40)
 * 与套件 A 的派生口径一致（同样取 20 字节 / 40 hex），地址长度可比。
 * @param {string} publicKeyPem
 * @returns {string}
 */
function sm2Address(publicKeyPem) {
  assertAvailable();
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return '0x' + sm3(der).slice(0, 40);
}

/* ==================================================================
 * 三、SM2 签名 / 验签（SM2-with-SM3）
 * ================================================================== */

/**
 * 用 SM2 私钥对数据签名（杂凑算法 SM3）
 * @param {string} privateKeyPem
 * @param {string|Buffer} data
 * @returns {string} base64 签名（DER 编码，长度约 70~72 字节）
 */
function sm2Sign(privateKeyPem, data) {
  assertAvailable();
  const signer = crypto.createSign('SM3');
  signer.update(data);
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

/**
 * 用 SM2 公钥验签
 * @param {string} publicKeyPem
 * @param {string|Buffer} data
 * @param {string} signature base64
 * @returns {boolean}
 */
function sm2Verify(publicKeyPem, data, signature) {
  if (!available) return false;
  try {
    const verifier = crypto.createVerify('SM3');
    verifier.update(data);
    verifier.end();
    return verifier.verify(publicKeyPem, signature, 'base64');
  } catch (e) {
    return false;
  }
}

/* ==================================================================
 * 四、SM3 Merkle 树（与 crypto-utils 的 SHA-256 版结构对等）
 * ================================================================== */

/**
 * 计算 SM3 Merkle 根。奇数节点复制末尾（与比特币/SHA-256 版同款处理）。
 * @param {string[]} hashes 叶节点（十六进制摘要串）
 * @returns {string}
 */
function merkleRootSm3(hashes) {
  assertAvailable();
  if (!hashes || hashes.length === 0) return '0'.repeat(64);
  // 把 hex 叶节点还原为字节，再逐层做 SM3(左||右)，避免 hex 字符串拼接带来的长度歧义
  let level = hashes.map((h) => Buffer.from(String(h), 'hex'));
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sm3Buf(Buffer.concat([level[i], level[i + 1]])));
    }
    level = next;
  }
  return level[0].toString('hex');
}

/** SM3 Merkle 证明路径 */
function merkleProofSm3(hashes, index) {
  assertAvailable();
  const root = merkleRootSm3(hashes);
  const path = [];
  if (!hashes || hashes.length === 0) return { root, path };
  let level = hashes.map((h) => Buffer.from(String(h), 'hex'));
  let idx = index;
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    path.push({ position: idx % 2 === 0 ? 'right' : 'left', hash: level[sib].toString('hex') });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sm3Buf(Buffer.concat([level[i], level[i + 1]])));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { root, path };
}

/** 校验 SM3 Merkle 证明 */
function verifyMerkleProofSm3(leafHash, path, root) {
  assertAvailable();
  let cur = Buffer.from(String(leafHash), 'hex');
  for (const step of path) {
    const sib = Buffer.from(String(step.hash), 'hex');
    cur = step.position === 'right'
      ? sm3Buf(Buffer.concat([cur, sib]))
      : sm3Buf(Buffer.concat([sib, cur]));
  }
  return cur.toString('hex') === root;
}

/* ==================================================================
 * 五、合规自证：标准测试向量一致性
 * ================================================================== */

/**
 * 现场复核 SM3 实现是否符合国家标准测试向量。
 * 评审或第三方审计可调用此函数，得到**可复核的合规证据**，而非口头声明。
 * @returns {{available:boolean, hash:string, cases:Array, pass:boolean, checkedAt:string, source:string}}
 */
function conformance() {
  const result = {
    available,
    hash: 'SM3',
    standard: 'GB/T 32905-2016 / GM/T 0004-2012',
    source: 'GB/T 32905-2016 附录 A 标准测试向量',
    openssl: CAPS.openssl,
    cases: [],
    pass: false,
    checkedAt: new Date().toISOString(),
  };
  if (!available) {
    result.reason = CAPS.reason;
    return result;
  }
  for (const c of SM3_TEST_VECTOR) {
    const actual = sm3(c.msg);
    result.cases.push({
      msg: c.msg.length > 24 ? c.msg.slice(0, 24) + '…' : c.msg,
      msgBytes: Buffer.byteLength(c.msg),
      expected: c.digest,
      actual,
      pass: actual === c.digest,
    });
  }
  result.pass = result.cases.every((c) => c.pass);
  return result;
}

/* ==================================================================
 * 六、套件描述符（供前端「密码套件」卡片与文档引用）
 * ================================================================== */

/** 双套件元数据 —— 前端渲染、报告引用的单一事实来源 */
const SUITES = Object.freeze({
  A: {
    id: 'A',
    code: 'INTL-ECDSA',
    name: '国际通用套件',
    curve: 'secp256k1',
    curveCn: 'secp256k1（SEC 2 标准曲线）',
    digest: 'SHA-256',
    digestCn: 'SHA-256（FIPS 180-4）',
    signature: 'ECDSA',
    signatureCn: 'ECDSA（X9.62）',
    std: ['FIPS 180-4', 'SEC 2', 'ANSI X9.62'],
    note: '与以太坊、Hyperledger Fabric 生态同构，便于跨链互操作与海外机构验证。',
    color: 'sky',
  },
  B: {
    id: 'B',
    code: 'CN-GM',
    name: '国密合规套件',
    curve: 'SM2',
    curveCn: 'SM2（sm2p256v1，256 位素域）',
    digest: 'SM3',
    digestCn: 'SM3（256 位杂凑，输出 256 bit）',
    signature: 'SM2-with-SM3',
    signatureCn: 'SM2 数字签名（SM3 杂凑）',
    std: ['GB/T 32918.1-2016', 'GB/T 32918.2-2016', 'GB/T 32905-2016', 'GB/T 35276-2017'],
    note: '满足《中华人民共和国密码法》与《数据安全法》对关键信息基础设施的自主可控要求，'
      + '可用于政务、能源、金融等领域的国产化替代场景。',
    color: 'carbon',
  },
});

module.exports = {
  available,
  CAPS,
  SM3_TEST_VECTOR,
  SUITES,
  sm3,
  sm3Buf,
  generateSm2Wallet,
  generateSm2WalletDeterministic,
  sm2Address,
  sm2Sign,
  sm2Verify,
  merkleRootSm3,
  merkleProofSm3,
  verifyMerkleProofSm3,
  conformance,
};
