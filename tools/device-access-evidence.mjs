#!/usr/bin/env node
/**
 * tools/device-access-evidence.mjs —— 真实设备端接入「端到端」证据脚本
 * ==================================================================
 * 用途：证明平台的 HJ 212-2017 源端接入**不是模拟**。做法是站在「一台真实
 * 数采仪」的位置，用 socket 直连平台 TCP 端口，按标准编出合规报文发过去，
 * 再逐字节接收平台的应答，全程不做任何 HTTP/JSON 的「走后门」。
 *
 * 它和 `iot-selftest.mjs` 的区别：
 *   · iot-selftest 走的是**内存级**服务调用（同一进程内模拟 socket）；
 *   · 本脚本走的是**真 TCP 套接字**，与现场设备完全同一条代码路径。
 *   两者叠加 = 「协议层正确」+「网络层真实」的双重证据。
 *
 * 前置条件：
 *   1. 平台已启动：npm start（或 HJ212_AUTOSTART=1 node server/app.js）
 *   2. 平台 TCP 端口可达：默认 127.0.0.1:9100（可用 HJ212_PORT / HJ212_HOST 覆盖）
 *
 * 用法：
 *   npm run evidence:device
 *   或 node tools/device-access-evidence.mjs
 *
 * 输出：Markdown + JSON 证据，落盘 tools/out/device-evidence.{md,json}
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HJ212_HOST || '127.0.0.1';
const PORT = Number(process.env.HJ212_PORT || 9100);
const PW = process.env.HJ212_PW || '123456';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

/* ==================================================================
 * 零依赖 HJ 212 编解码（只实现本脚本所需的最小集合，与 server 端无关）
 * ================================================================== */
const CRC_POLY = 0xa001, CRC_INIT = 0xffff;
function crc16(data) {
  const buf = Buffer.from(String(data), 'latin1');
  let crc = CRC_INIT;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = (crc & 1) ? (crc >>> 1) ^ CRC_POLY : crc >>> 1;
  }
  return crc & 0xffff;
}
function crcHex(seg) {
  const v = crc16(seg);
  return ((v >> 8) & 0xff).toString(16).padStart(2, '0').toUpperCase()
    + (v & 0xff).toString(16).padStart(2, '0').toUpperCase();
}
const p2 = (n, w = 2) => String(n).padStart(w, '0');
function qn(d = new Date(), seq = null) {
  const z = seq == null ? p2(d.getMilliseconds(), 3) : p2(Math.abs(Number(seq)) % 1000, 3);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${z}`;
}
function dt(d = new Date()) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
function encode({ st = '31', cn, mn, pw = PW, cp, flag = 5, seq }) {
  const seg = `QN=${qn(new Date(), seq)};ST=${st};CN=${cn};PW=${pw};MN=${mn};Flag=${flag};` + (cp ? `CP=${cp}` : '');
  const len = Buffer.byteLength(seg, 'latin1');
  return `##${String(len).padStart(4, '0')}${seg}${crcHex(seg)}\r\n`;
}
function buildCP({ dataTime, factors }) {
  const parts = [`DataTime=${dataTime}`];
  for (const [code, rtd, flag] of factors) parts.push(`${code}-Rtd=${rtd},${code}-Flag=${flag}`);
  return `&&${parts.join(';')}&&`;
}
/* 从应答帧里抠出 QnRtn（server 端 buildAck 会把 QnRtn 放进 CP 区） */
function parseQnRtn(frame) {
  const s = String(frame);
  const m = s.match(/QnRtn=(\d+)/);
  return m ? Number(m[1]) : null;
}
function parseCnQn(frame) {
  const s = String(frame);
  const cn = s.match(/CN=(\d+)/);
  const q = s.match(/QN=(\d+)/);
  return { cn: cn ? cn[1] : null, qn: q ? q[1] : null };
}

/* ==================================================================
 * 真 TCP 客户端：连一次、发一帧、读一帧应答
 * ================================================================== */
function exchange(frame) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: HOST, port: PORT });
    let acc = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); sock.destroy(); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error('读应答超时（5s，对端未返回帧）')), 5000);
    sock.on('connect', () => { sock.write(frame, 'latin1'); });
    sock.on('data', (chunk) => {
      acc += chunk.toString('latin1');
      /* 收到至少一帧（以 \r\n 结尾）即认为应答完整，主动断开。
       * 平台保持长连接，不会主动 FIN，故不能等 end/close。 */
      if (acc.includes('\r\n')) finish(resolve, acc);
    });
    sock.on('error', (e) => finish(reject, e));
    sock.on('close', () => finish(resolve, acc));
  });
}

/* ==================================================================
 * 主流程
 * ================================================================== */
async function main() {
  const rows = [];
  const startedAt = new Date();
  const env = {
    measuredAt: startedAt.toISOString(),
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    target: `${HOST}:${PORT}`,
    password: PW,
  };

  /* 用一台「真实数采仪」的身份：MN 取一段 EPC-96 风格的 24 位十六进制。
   * 该 MN 未在平台登记 → 平台应自动登记为 PENDING 并应答 QnRtn=5（未授权），
   * 这本身就是「协议栈端到端可工作」的强证据：平台真的解析了 MN、真的查了台账。 */
  const MN = '010000A8900016F000169DC0';

  /* —— 步骤 1：链路登录（CN=9021，数据转发登录）—— */
  {
    const frame = encode({ cn: '9021', mn: MN, flag: 5, seq: 1 });
    try {
      const resp = await exchange(frame);
      rows.push({
        step: '链路登录', cn: '9021', mn: MN,
        sent: frame, received: resp, qnRtn: parseQnRtn(resp),
        crc: crcHex(frame.slice(6, frame.length - 6 - 2)),
        ok: true,
      });
    } catch (e) {
      rows.push({ step: '链路登录', cn: '9021', mn: MN, ok: false, error: e.message });
    }
  }

  /* —— 步骤 2：心跳（CN=9022）—— */
  {
    const frame = encode({ cn: '9022', mn: MN, flag: 5, seq: 2 });
    try {
      const resp = await exchange(frame);
      rows.push({
        step: '链路心跳', cn: '9022', mn: MN,
        sent: frame, received: resp, qnRtn: parseQnRtn(resp), ok: true,
      });
    } catch (e) {
      rows.push({ step: '链路心跳', cn: '9022', mn: MN, ok: false, error: e.message });
    }
  }

  /* —— 步骤 3：实时数据（CN=2011），带碳核算主因子 a05001（CO₂ 质量浓度）—— */
  {
    const cp = buildCP({
      dataTime: dt(),
      factors: [
        ['a05001', '180000', 'N'],  // CO₂ 质量浓度 180000 mg/m³
        ['a01011', '14.6', 'N'],    // 烟气流速 14.6 m/s
        ['a01016', '6.0', 'N'],     // 烟道截面积 6.0 m²
        ['a19001', '6.8', 'N'],     // 氧气含量 6.8 %
        ['a01012', '128.3', 'N'],   // 烟气温度 128.3 ℃
      ],
    });
    const frame = encode({ cn: '2011', mn: MN, cp, flag: 5, seq: 3 });
    try {
      const resp = await exchange(frame);
      rows.push({
        step: '实时数据上报', cn: '2011', mn: MN,
        sent: frame, received: resp, qnRtn: parseQnRtn(resp), ok: true,
      });
    } catch (e) {
      rows.push({ step: '实时数据上报', cn: '2011', mn: MN, ok: false, error: e.message });
    }
  }

  /* —— 步骤 4：错误密码（负向对照，证明平台真在做鉴权）—— */
  {
    const frame = encode({ cn: '9022', mn: MN, pw: 'WRONG', flag: 5, seq: 4 });
    try {
      const resp = await exchange(frame);
      rows.push({
        step: '错误密码对照', cn: '9022', mn: MN,
        sent: frame, received: resp, qnRtn: parseQnRtn(resp), ok: true,
      });
    } catch (e) {
      rows.push({ step: '错误密码对照', cn: '9022', mn: MN, ok: false, error: e.message });
    }
  }

  /* —— 步骤 5：坏 CRC（负向对照，证明平台真在做完整性校验）—— */
  {
    const good = encode({ cn: '9022', mn: MN, flag: 5, seq: 5 });
    const bad = good.slice(0, good.length - 6) + '0000' + '\r\n';
    try {
      const resp = await exchange(bad);
      rows.push({
        step: '坏 CRC 对照', cn: '9022', mn: MN,
        sent: bad, received: resp, qnRtn: parseQnRtn(resp), ok: true,
      });
    } catch (e) {
      rows.push({ step: '坏 CRC 对照', cn: '9022', mn: MN, ok: false, error: e.message });
    }
  }

  /* —— 结果判定 —— */
  const names = { 1: '执行成功', 2: '执行失败', 3: '报文格式错误', 4: '密码错误', 5: '未授权', 6: 'CRC 错误', 7: '未绑定归属主体' };
  const expected = {
    '链路登录': 5,          // 未登记设备 → 自动登记 PENDING → 未授权
    '链路心跳': 5,
    '实时数据上报': 5,
    '错误密码对照': 4,       // 密码错
    '坏 CRC 对照': 6,        // CRC 错
  };
  let pass = 0, fail = 0;
  const checked = rows.map((r) => {
    if (!r.ok) { fail++; return { ...r, verdict: 'FAIL', reason: r.error }; }
    const exp = expected[r.step];
    const good = exp !== undefined && r.qnRtn === exp;
    if (good) pass++; else fail++;
    return { ...r, verdict: good ? 'PASS' : 'FAIL', expectedQnRtn: exp, qnRtnName: names[r.qnRtn] || '无' };
  });

  console.log('\n════════ 真实设备端接入证据 · 端到端 ════════\n');
  for (const r of checked) {
    const mark = r.verdict === 'PASS' ? '✔' : '✘';
    console.log(`  ${mark} ${r.step.padEnd(8, '　')} 期望 QnRtn=${r.expectedQnRtn}(${names[r.expectedQnRtn] || '—'})  实测 QnRtn=${r.qnRtn ?? '—'}(${r.qnRtnName})`);
    console.log(`      发送: ${r.sent}`);
    console.log(`      应答: ${r.received}`);
  }
  console.log(`\n  结果：${pass}/${rows.length} 项对照符合预期（含 2 项负向对照）`);
  console.log(`  说明：QnRtn=5 证明平台真解析了 MN 并查了台账（未登记→自动 PENDING→未授权）；`);
  console.log(`        QnRtn=4/6 证明密码与 CRC 校验是真实执行的，非摆设。\n`);

  /* —— 写证据文件 —— */
  const md = [];
  md.push('# 真实设备端接入证据（自动生成）');
  md.push('');
  md.push(`> 生成命令：\`npm run evidence:device\`　生成时间：${startedAt.toISOString()}`);
  md.push('');
  md.push('## 环境指纹');
  md.push('');
  md.push('```json');
  md.push(JSON.stringify(env, null, 2));
  md.push('```');
  md.push('');
  md.push('## 端到端对照（真 TCP 套接字，非内存模拟）');
  md.push('');
  md.push('| # | 步骤 | CN | 期望 QnRtn | 实测 QnRtn | 判定 |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  checked.forEach((r, i) => {
    md.push(`| ${i + 1} | ${r.step} | ${r.cn} | ${r.expectedQnRtn ?? '—'} | ${r.qnRtn ?? '—'} | ${r.verdict} |`);
  });
  md.push('');
  md.push('## 原始报文（逐字节可核）');
  md.push('');
  checked.forEach((r) => {
    md.push(`### ${r.step}`);
    md.push('```');
    md.push(`发送: ${r.sent}`);
    md.push(`应答: ${r.received}`);
    md.push('```');
  });
  fs.writeFileSync(path.join(OUT, 'device-evidence.md'), md.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'device-evidence.json'), JSON.stringify({ generatedAt: startedAt.toISOString(), env, rows: checked }, null, 2), 'utf8');
  console.log(`  已写出：tools/out/device-evidence.md · tools/out/device-evidence.json\n`);

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('脚本失败：', e.message); process.exit(1); });
