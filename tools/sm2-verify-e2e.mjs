#!/usr/bin/env node
/**
 * tools/sm2-verify-e2e.mjs —— CEN-100 设备签名验签「端到端 + 阴性对照」证据脚本
 * ==================================================================
 * 目的：证明平台侧新增的验签通道真的生效，且**只放行应当放行的、只拒绝应当拒绝的**。
 *
 * 做法：用平台侧 SM2 私钥按"设备口径"（CANON + ZA）签一张真实 HJ 212 帧，
 *       直投 hj212Server.processFrame（与现场设备**同一条代码路径**），
 *       再构造"应当被拒绝"的输入，确认被拒、**且未落库**。
 *
 * 为什么直调 processFrame 而不用真 TCP：
 *   · 真 TCP 路径已由 tools/device-access-evidence.mjs 证明（5/5，含 QnRtn=4/5/6）；
 *   · 本脚本要验证的是"验签 / 防重放 / 落库留痕"这一层，进程内直调最稳定，
 *     且能直接断言数据库副作用（是否落库、sig_mode 取值）。
 *   两者叠加 = 「网络层真实」+「密码学与数据层真实」。
 *
 * 前置：MySQL 可连（读 .env）；**无需**启动 HTTP/TCP 服务。
 * 用法：npm run verify:sm2  （或 node tools/sm2-verify-e2e.mjs）
 * 输出：tools/out/sm2-verify-evidence.{md,json}
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const H = require(path.join(ROOT, 'server/protocol/hj212.js'));
const bridge = require(path.join(ROOT, 'server/services/sm2DeviceBridge.js'));
const gm = require(path.join(ROOT, 'server/blockchain/gm-crypto.js'));
const registry = require(path.join(ROOT, 'server/services/deviceRegistry.js'));
const hj = require(path.join(ROOT, 'server/services/hj212Server.js'));
const db = require(path.join(ROOT, 'server/db.js'));

/* ---------------- 零依赖帧编码（与 server 端等价的最小实现） ---------------- */
const p2 = (n, w = 2) => String(n).padStart(w, '0');
function crcHex(seg) {
  const v = H.crc16(seg);
  return ((v >> 8) & 0xff).toString(16).padStart(2, '0').toUpperCase()
    + (v & 0xff).toString(16).padStart(2, '0').toUpperCase();
}
function makeQn(seq) {
  const d = new Date();
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${p2(Math.abs(seq) % 1000, 3)}`;
}
function makeDt(base, offsetSec) {
  const d = new Date(base.getTime() + offsetSec * 1000);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
function buildCP({ dataTime, seq, challenge, gdev, sigB64, factors }) {
  const parts = [`DataTime=${dataTime}`, `DevSeq=${seq}`, `Challenge=${challenge}`, `Gdev=${gdev}`];
  if (sigB64) parts.push(`SM2Sig=${sigB64}`);
  for (const [code, val] of Object.entries(factors)) parts.push(`${code}-Rtd=${val},${code}-Flag=N`);
  return `&&${parts.join(';')}&&`;
}
function wrapSeg(qn, cn, mn, cp) {
  const seg = `QN=${qn};ST=31;CN=${cn};PW=123456;MN=${mn};Flag=5;CP=${cp}`;
  const len = Buffer.byteLength(seg, 'latin1');
  return `##${String(len).padStart(4, '0')}${seg}${crcHex(seg)}\r\n`;
}

/* ---------------- 断言辅助 ---------------- */
const rows = [];
function record(o) { rows.push(o); return o; }

async function countReading(entId, monitorNo, dataTime) {
  const sqlTime = `${dataTime.slice(0, 4)}-${dataTime.slice(4, 6)}-${dataTime.slice(6, 8)} `
    + `${dataTime.slice(8, 10)}:${dataTime.slice(10, 12)}:${dataTime.slice(12, 14)}`;
  const rows0 = await db.query(
    'SELECT id, sig_mode, dev_seq, signature FROM cems_reading WHERE ent_id=? AND monitor_no=? AND reading_time=?',
    [entId, monitorNo, sqlTime]
  );
  return { sqlTime, list: rows0 };
}

/* ==================================================================
 * 主流程
 * ================================================================== */
async function main() {
  const startedAt = new Date();
  console.log('\n════════ CEN-100 设备签名验签 · 端到端阴性对照 ════════\n');

  /* —— 步骤 0：平台侧桥接层自检（N7）—— */
  const st = bridge.selfTest();
  record({
    id: 'N7', name: '桥接层自检（ZA 口径 / DER 往返 / 3 项阴性对照）',
    expected: `${st.total}/${st.total}`,
    actual: `${st.passed}/${st.total}`,
    pass: st.pass, kind: '自检',
  });

  /* —— 步骤 0b：台账自举（幂等）—— */
  const seed = await registry.ensureSeeded();
  console.log(`  台账自举：既有 ${seed.existing} / 新增 ${seed.created} / 合计 ${seed.total}`);

  /* —— 选两台 ACTIVE 且已绑定归属的设备 —— */
  const devs = await db.query(
    `SELECT device_did, mn, ent_id, monitor_no, auth_status, dev_pubkey, dev_last_seq
       FROM device_registry
      WHERE auth_status='ACTIVE' AND ent_id IS NOT NULL AND monitor_no IS NOT NULL AND mn IS NOT NULL
      ORDER BY id LIMIT 2`
  );
  if (devs.length < 2) throw new Error('可用设备不足 2 台（ACTIVE 且已绑定），请先 npm run initdb');
  const devA = devs[0];   // 登记公钥 → 走验签通道
  const devB = devs[1];   // 不登记公钥 → UNSIGNED 放行

  /* —— 为 devA 生成并登记 SM2 公钥（等价于 POST /api/iot/devices/register-key）—— */
  const kp = gm.generateSm2WalletDeterministic('CC-E2E-VERIFY');
  const keyFp = bridge.computeZa(kp.publicKey, bridge.DEFAULT_ID).toString('hex').slice(0, 32);
  await db.query(
    'UPDATE device_registry SET dev_pubkey=?, dev_key_fp=?, dev_key_reg_at=NOW(), dev_sm2_id=?, dev_last_seq=0 WHERE device_did=?',
    [kp.publicKey, keyFp, bridge.DEFAULT_ID, devA.device_did]
  );
  console.log(`  待测设备 A：${devA.mn}（企业 ${devA.ent_id} / 排口 ${devA.monitor_no}）已登记公钥，指纹 ${keyFp}`);
  console.log(`  待测设备 B：${devB.mn}（未登记公钥，应 UNSIGNED 放行）\n`);

  const base = new Date(Date.now() + 3600 * 1000);          // 基准时间推后 1h，避开种子读数
  const CH = '9f2a'.repeat(16);                              // 挑战数
  const GDEV = 0.001234567;
  const factorsOk = {                                       // 与 CANON 一致的一组正常读数
    a05001: 180000, a01011: 14.6, a01012: 128.3, a01013: 101.2,
    a01014: 12.3, a19001: 6.8, a01016: 6.0,
  };

  /* 发送辅助：签名 → 组帧 → 解码 → processFrame */
  async function sendSigned({ device, dataTime, seq, factors, signFactors, withSig = true }) {
    const qn = makeQn(seq);
    let sigB64 = null;
    let canon = null;
    if (withSig) {
      canon = bridge.buildCanon({
        mn: device.mn, qn, dataTime, devSeq: seq, challenge: CH,
        factors: signFactors || factors, gdev: GDEV,
      });
      const derB64 = bridge.signAsDevice(kp.privateKey, canon);
      sigB64 = bridge.derToRaw(Buffer.from(derB64, 'base64')).toString('base64');
    }
    const cp = buildCP({ dataTime, seq, challenge: CH, gdev: GDEV, sigB64, factors });
    const frame = wrapSeg(qn, '2011', device.mn, cp);
    const f = H.decode(frame);
    const r = await hj.processFrame(f, { ip: '127.0.0.1' });
    return { frame, canon, sigB64, result: r };
  }

  /* ============ T1：正常签名帧 → 应通过并落库 ============ */
  {
    const dt = makeDt(base, 1);
    const { frame, canon, result } = await sendSigned({ device: devA, dataTime: dt, seq: 100001, factors: factorsOk });
    const cnt = await countReading(devA.ent_id, devA.monitor_no, dt);
    const row = cnt.list[0];
    record({
      id: 'T1', name: '正常签名帧（应通过并落库）', kind: '正向',
      expected: 'QnRtn=1 且落库 sig_mode=STD',
      actual: `QnRtn=${result.qnRtn} 落库=${cnt.list.length} sig_mode=${row ? row.sig_mode : '—'} dev_seq=${row ? row.dev_seq : '—'}`,
      pass: result.qnRtn === 1 && cnt.list.length === 1 && row.sig_mode === 'STD' && Number(row.dev_seq) === 100001,
      frame, canon, cn: '2011', mn: devA.mn, qnRtn: result.qnRtn,
    });
  }

  /* ============ T2（N1）：改一个数但不重签 → 应拒收且不落库 ============ */
  {
    const dt = makeDt(base, 2);
    const tampered = { ...factorsOk, a05001: 999999 };      // 把 CO₂ 浓度改大，签名仍是原值
    const { frame, result } = await sendSigned({
      device: devA, dataTime: dt, seq: 100002, factors: tampered, signFactors: factorsOk,
    });
    const cnt = await countReading(devA.ent_id, devA.monitor_no, dt);
    record({
      id: 'N1', name: '篡改读数不重签（应拒收且不落库）', kind: '阴性',
      expected: 'QnRtn=8（SM2 验签失败）且落库=0',
      actual: `QnRtn=${result.qnRtn} 落库=${cnt.list.length}`,
      pass: result.qnRtn === 8 && cnt.list.length === 0,
      frame, cn: '2011', mn: devA.mn, qnRtn: result.qnRtn,
    });
  }

  /* ============ T3（N2）：原样重放旧帧 → 应拒收（序号回退） ============ */
  {
    const dt = makeDt(base, 1);                             // 与 T1 同序号的报文
    const { frame, result } = await sendSigned({ device: devA, dataTime: dt, seq: 100001, factors: factorsOk });
    record({
      id: 'N2', name: '重放已确认序号（应拒收）', kind: '阴性',
      expected: 'QnRtn=9（序号回退/疑似重放）',
      actual: `QnRtn=${result.qnRtn}`,
      pass: result.qnRtn === 9,
      frame, cn: '2011', mn: devA.mn, qnRtn: result.qnRtn,
    });
  }

  /* ============ T4（N6）：未登记公钥的设备 → 应 UNSIGNED 放行 ============ */
  {
    const dt = makeDt(base, 10);
    const qn = makeQn(7);
    const cp = buildCP({ dataTime: dt, seq: 7, challenge: CH, gdev: GDEV, sigB64: null, factors: factorsOk });
    const frame = wrapSeg(qn, '2011', devB.mn, cp);
    const r = await hj.processFrame(H.decode(frame), { ip: '127.0.0.1' });
    const cnt = await countReading(devB.ent_id, devB.monitor_no, dt);
    const row = cnt.list[0];
    record({
      id: 'N6', name: '未登记公钥的设备（应 UNSIGNED 放行）', kind: '兼容性',
      expected: 'QnRtn=1 且落库 sig_mode=UNSIGNED',
      actual: `QnRtn=${r.qnRtn} 落库=${cnt.list.length} sig_mode=${row ? row.sig_mode : '—'}`,
      pass: r.qnRtn === 1 && cnt.list.length === 1 && row.sig_mode === 'UNSIGNED',
      frame, cn: '2011', mn: devB.mn, qnRtn: r.qnRtn,
    });
  }

  /* ============ T5（N4）：已登记公钥但报文不带签名 → UNSIGNED + 记事件 ============ */
  {
    const dt = makeDt(base, 11);
    const qn = makeQn(8);
    const cp = buildCP({ dataTime: dt, seq: 8, challenge: CH, gdev: GDEV, sigB64: null, factors: factorsOk });
    const frame = wrapSeg(qn, '2011', devA.mn, cp);
    const r = await hj.processFrame(H.decode(frame), { ip: '127.0.0.1' });
    const cnt = await countReading(devA.ent_id, devA.monitor_no, dt);
    const row = cnt.list[0];
    record({
      id: 'N4', name: '已登记公钥但无签名字段（应记为 UNSIGNED 放行）', kind: '兼容性',
      expected: 'QnRtn=1 且落库 sig_mode=UNSIGNED',
      actual: `QnRtn=${r.qnRtn} 落库=${cnt.list.length} sig_mode=${row ? row.sig_mode : '—'}`,
      pass: r.qnRtn === 1 && cnt.list.length === 1 && row.sig_mode === 'UNSIGNED',
      frame, cn: '2011', mn: devA.mn, qnRtn: r.qnRtn,
    });
  }

  /* ============ T6（N5）：序号跳号 → 放行但必须留 SEQ_GAP ============ */
  {
    const dt = makeDt(base, 12);
    const { result } = await sendSigned({ device: devA, dataTime: dt, seq: 100099, factors: factorsOk });
    const gap = await db.query(
      "SELECT COUNT(*) AS n FROM device_verify_log WHERE device_did=? AND outcome='SEQ_GAP'",
      [devA.device_did]
    );
    record({
      id: 'N5', name: '序号跳号（应放行但留 SEQ_GAP 告警）', kind: '可观测性',
      expected: 'QnRtn=1 且 device_verify_log 出现 SEQ_GAP',
      actual: `QnRtn=${result.qnRtn} SEQ_GAP 记录=${gap[0].n}`,
      pass: result.qnRtn === 1 && Number(gap[0].n) >= 1,
      cn: '2011', mn: devA.mn, qnRtn: result.qnRtn,
    });
  }

  /* ============ 汇总：验签事件台账 ============ */
  const outcomeRows = await db.query(
    'SELECT outcome, COUNT(*) AS cnt FROM device_verify_log GROUP BY outcome ORDER BY cnt DESC'
  );

  /* ---------------- 打印 ---------------- */
  let pass = 0;
  for (const r of rows) {
    const mark = r.pass ? '✔' : '✘';
    if (r.pass) pass++;
    console.log(`  ${mark} [${r.id}] ${r.name}`);
    console.log(`      期望：${r.expected}`);
    console.log(`      实测：${r.actual}`);
  }
  console.log(`\n  结果：${pass}/${rows.length} 项符合预期`);
  console.log('  验签事件台账（device_verify_log）：');
  for (const o of outcomeRows) console.log(`      ${o.outcome.padEnd(12, ' ')} ${o.cnt}`);

  /* ---------------- 写出证据 ---------------- */
  const env = {
    measuredAt: startedAt.toISOString(), node: process.version,
    platform: `${os.type()} ${os.release()}`,
    sm2: { available: gm.available, openssl: (gm.CAPS && gm.CAPS.openssl) || null, user_id: bridge.DEFAULT_ID },
    deviceA: { mn: devA.mn, entId: devA.ent_id, monitorNo: devA.monitor_no, keyFp },
    deviceB: { mn: devB.mn, entId: devB.ent_id, monitorNo: devB.monitor_no, pubkey: false },
  };
  const md = [];
  md.push('# CEN-100 设备签名验签 · 端到端阴性对照证据（自动生成）');
  md.push('');
  md.push(`> 生成命令：\`npm run verify:sm2\`　生成时间：${startedAt.toISOString()}`);
  md.push('');
  md.push('## 环境指纹');
  md.push('');
  md.push('```json');
  md.push(JSON.stringify(env, null, 2));
  md.push('```');
  md.push('');
  md.push('## 对照结果');
  md.push('');
  md.push('| # | 项目 | 类别 | 期望 | 实测 | 判定 |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) md.push(`| ${r.id} | ${r.name} | ${r.kind} | ${r.expected} | ${r.actual} | ${r.pass ? 'PASS' : 'FAIL'} |`);
  md.push('');
  md.push('## 验签事件台账（device_verify_log 分组计数）');
  md.push('');
  md.push('| outcome | 条数 |');
  md.push('| --- | --- |');
  for (const o of outcomeRows) md.push(`| ${o.outcome} | ${o.cnt} |`);
  md.push('');
  md.push('## 原始报文（逐字节可核）');
  md.push('');
  for (const r of rows) {
    if (!r.frame) continue;
    md.push(`### [${r.id}] ${r.name}`);
    md.push('```');
    md.push(`发送: ${r.frame}`);
    if (r.canon) md.push(`CANON: ${r.canon}`);
    md.push('```');
  }
  md.push('');
  fs.writeFileSync(path.join(OUT, 'sm2-verify-evidence.md'), md.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'sm2-verify-evidence.json'),
    JSON.stringify({ generatedAt: startedAt.toISOString(), env, rows, outcomes: outcomeRows }, null, 2), 'utf8');
  console.log(`\n  已写出：tools/out/sm2-verify-evidence.md · tools/out/sm2-verify-evidence.json\n`);

  /* ---------------- 复位：清掉本次登记的公钥，回到基线 ---------------- */
  await db.query('UPDATE device_registry SET dev_pubkey=NULL, dev_key_fp=NULL, dev_sig_mode=NULL, dev_last_seq=0 WHERE device_did=?', [devA.device_did]);
  await shutdown();
  process.exit(pass === rows.length ? 0 : 1);
}

/** 关闭连接池，否则 Node 事件循环不退出 */
async function shutdown() {
  try { await db.pool.end(); } catch (_) { /* ignore */ }
  try { await db.chainPool.end(); } catch (_) { /* ignore */ }
}

main().catch(async (e) => {
  console.error('脚本失败：', (e && e.stack) || e);
  await shutdown();
  process.exit(1);
});
