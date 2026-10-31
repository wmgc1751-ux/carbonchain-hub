#!/usr/bin/env node
/* 把设备自报的 65 字节 SM2 公钥（04||X||Y）补成 SPKI PEM，并登记到平台台账。
 *
 * 为什么需要这个工具：
 *   固件开机只打印「65 字节未压缩点的十六进制」（src/main.c#ST_BOOT）。
 *   而平台 `POST /api/iot/devices/register-key` 要的是 PEM/SPKI 字符串。
 *   SPKI 页眉是固定的 26 字节常量（与 `server/keystore.json` 里 SM2 公钥 PEM 的
 *   头部 "MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAE" 完全同源），所以本地补齐即可，
 *   不必让固件在只有 512 B 栈的日志里塞多行 PEM。
 *
 * ⚠ 公钥登记只做一次：`device_registry.dev_pubkey` 一旦有值，该设备此后每一帧
 *   都进验签通道（验签失败 QnRtn=8、序号回退 QnRtn=9，均不落库）。
 *   登记前务必确认 hex 与该设备的指纹对得上（见 --fp）。
 *
 * 用法：
 *   node tools/register-device-key.mjs <130位hex> [--mn 010000A8900016F000169DC0]
 *        [--fp f09499c39f78719a] [--api http://127.0.0.1:8300]
 *        [--user admin] [--pass admin123] [--dry]
 */
import crypto from 'node:crypto';
import process from 'node:process';

const HEX = (process.argv[2] || '').trim().toUpperCase();
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const MN = arg('mn', '010000A8900016F000169DC0');
const FP_EXPECT = arg('fp', '');
const API = arg('api', 'http://127.0.0.1:8300');
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin123');
const DRY = process.argv.includes('--dry');

if (!/^04[0-9A-F]{128}$/.test(HEX)) {
  console.error(`✘ 公钥格式不对：需 130 位十六进制且以 04 开头，实收 ${HEX.length} 位`);
  process.exit(2);
}

/* SPKI DER 头有两种写法，**公钥点完全相同，只有曲线 OID 与长度不同**：
 *   ① SM2 OID   30 59 | 30 13 | 0607 2A8648CE3D0201 | 0608 2A811CCF5501822D | 0342 00
 *   ② P-256 OID 30 56 | 30 10 | 0607 2A8648CE3D0201 | 0605 2B8104000A      | 0342 00
 *
 * 为什么两种都要备：设备固件（src/cc_sm2.c#SM2_SPKI_HEAD）生成的是 ①，
 * 而平台 server/keystore.json 里的 SM2 公钥 PEM 头部是
 * "MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAE"，解出来是 **②（P-256 OID）**。
 * ⚠ 源码注释曾断言"与 keystore.json 头部完全一致"——这是错的：两者 OID 不同。
 *   平台侧 computeZa() 只取 DER 末 65 字节，不解析 OID，所以两种都能算出同一个 ZA；
 *   但 `crypto.createPublicKey()` 是否接受 SM2 OID 取决于本机 OpenSSL 版本。
 *   ⇒ 策略：优先 ①（语义正确），被平台拒收再退回 ②（本机已验证可解析）。
 */
const OIDS = {
  sm2: '3059301306072A8648CE3D020106082A811CCF5501822D034200',
  p256: '3056301006072A8648CE3D020106052B8104000A034200',
};

/** 用指定 OID 形式拼 SPKI PEM */
function buildPem(oidKey) {
  const head = Buffer.from(OIDS[oidKey], 'hex');
  const der = Buffer.concat([head, Buffer.from(HEX, 'hex')]);
  const b64 = der.toString('base64');
  return {
    b64,
    pem: `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`,
  };
}

const sm2Form = buildPem('sm2');
const p256Form = buildPem('p256');

/* 自检：两种形式的 DER 长度必须分别等于 91 / 88 字节，且末 65 字节完全相同 */
if (Buffer.from(sm2Form.b64, 'base64').length !== 91
  || Buffer.from(p256Form.b64, 'base64').length !== 88) {
  console.error('✘ SPKI 长度不对（SM2 应 91 B、P-256 应 88 B），DER 头拼错了');
  process.exit(2);
}

/* 指纹 = SM3(PEM) 前 16 字节，与固件 ST_PROVISION 里的算法完全一致。
 * ⚠ 必须用 ①（SM2 OID）形式的 PEM 算：设备算指纹用的就是自己生成的 ① 形式。
 *   Node 原生无 SM3，走 OpenSSL 的 sm3。 */
const PEM = sm2Form.pem;
let fp = null;
try {
  fp = crypto.createHash('sm3').update(PEM, 'utf8').digest('hex').slice(0, 32);
} catch (e) {
  console.log('（本机 OpenSSL 无 sm3，跳过指纹自校）');
}

/* ⚠ 长度必须对齐：固件 ST_PROVISION 打印的是「前 8 字节」= 16 个十六进制字符，
 *   而本地算出的是 16 字节 = 32 个字符。曾拿 32 字符去比 16 字符，
 *   明明指纹一致却被判成"不是该设备的公钥"，白排查一轮。 */
const FP_LEN = FP_EXPECT.length;          // 设备自报多少位，就比对多少位
console.log('公钥点  :', HEX.slice(0, 20) + '…' + HEX.slice(-8));
console.log('PEM 首行:', sm2Form.b64.slice(0, 40) + '…');
console.log('指纹    :', fp || 'n/a', FP_EXPECT ? `（设备自报前 ${FP_LEN} 位 ${FP_EXPECT}）` : '');

if (fp && FP_EXPECT && fp.slice(0, FP_LEN) !== FP_EXPECT.toLowerCase()) {
  console.error('✘ 指纹与设备自报不一致 —— 说明这串 hex 不是该设备的公钥，停止登记');
  process.exit(3);
}
/* ⚠ 这一步是真正的把关：PEM 拼错时指纹必然对不上，
 *   而"登记了一个错公钥"的后果是该设备此后每一帧都被判验签失败。 */
if (fp && FP_EXPECT && fp.slice(0, FP_LEN) === FP_EXPECT.toLowerCase()) {
  console.log('✅ 指纹自校通过：本地补页眉得到的 PEM 与设备自报指纹一致');
}

if (DRY) {
  console.log('\n--- 仅预览，未提交 ---\n' + PEM);
  process.exit(0);
}

const j = async (url, opt) => {
  const r = await fetch(url, opt);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch { return { status: r.status, body: t }; }
};

const login = await j(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const token = login.body?.data?.token;
if (!token) { console.error('✘ 登录失败:', JSON.stringify(login.body).slice(0, 300)); process.exit(4); }

async function post(keyHex) {
  return j(`${API}/api/iot/devices/register-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mn: MN, publicKey: keyHex, sm2Id: '1234567812345678' }),
  });
}

let used = 'sm2';
let res = await post(sm2Form.pem);
if (res.body?.code !== 0) {
  console.log(`SM2 OID 形式被拒（${res.status}：${(res.body?.message || '').slice(0, 120)}），改用 P-256 OID 形式重试…`);
  used = 'p256';
  res = await post(p256Form.pem);
}
console.log('\n登记结果:', res.status, JSON.stringify(res.body?.data ?? res.body).slice(0, 400));
if (res.body?.code !== 0) process.exit(5);
console.log(`✅ 已登记（${used} OID 形式）。此后该设备每帧进入验签通道，dev_last_seq 随帧推进`);
