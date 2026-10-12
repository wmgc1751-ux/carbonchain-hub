/**
 * cems-sim.mjs —— CEMS 数采仪模拟器（WP1 源端真实化的"对端"）
 * ==================================================================
 * 为什么模拟器要**自带**一套 HJ 212 实现
 * ------------------------------------------------------------------
 * 如果模拟器 require 平台的 server/protocol/hj212.js，那么它和平台用的是
 * 同一份编解码代码 —— 编码器和解码器一起错，测试照样全绿，什么也没证明。
 * 所以本文件**独立重写了 CRC-16 与整帧组装**（连查表法都不用，纯位运算），
 * 平台只有解对了才收得到数据。这是"真互通"与"假自洽"的分界线。
 *
 * 它模拟什么
 * ------------------------------------------------------------------
 *   · 从平台 API 拉取已登记的设备台账（MN / 排口 / 企业），按台账上线
 *   · 按 HJ 212-2017 组装报文：CN=9021 登录 → 周期性 CN=2011 实时数据
 *   · 物理量发生器：由排口工况确定性生成流速/截面积/CO₂浓度/含氧量，
 *     不含任何随机分量（mulberry32 播种自 MN）—— 同一 MN 永远同一条序列，
 *     演示可复现、断网续传后可对账
 *   · 断网续传：与平台断开时把报文压入本地缓冲，重连后按时间顺序补传
 *   · 故障注入：--crc-bad 发坏 CRC；--foreign-mn 发未登记 MN（验证准入拦截）
 *
 * 用法
 *   node tools/cems-sim.mjs                                  # 拉台账，全部 HJ212 设备上线
 *   node tools/cems-sim.mjs --api http://127.0.0.1:8300 --interval 5 --rounds 3
 *   node tools/cems-sim.mjs --mn <24位十六进制> --interval 2 --rounds 1
 *   node tools/cems-sim.mjs --crc-bad --rounds 1             # 故意发坏 CRC
 *   node tools/cems-sim.mjs --foreign-mn --rounds 1          # 发未登记设备
 *   node tools/cems-sim.mjs --offline 6 --rounds 3           # 前 6 秒断网，之后补传
 */
import net from 'node:net';
import crypto from 'node:crypto';

/* ==================================================================
 * 第一部分：**独立**的 HJ 212-2017 编码实现（不复用平台代码）
 * ================================================================== */

/** HJ 212 CRC-16：初值全 1，多项式右移形式 0xA001，逐位运算 */
function crc16(data) {
  let crc = 0xffff;
  const buf = Buffer.from(data, 'latin1');
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
    }
  }
  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

/** 组装一整帧：## + 4位长度 + 数据段 + 4位CRC + CRLF */
function frame(seg) {
  const len = Buffer.byteLength(seg, 'latin1');
  if (len > 1024) throw new Error('数据段超长');
  return `##${String(len).padStart(4, '0')}${seg}${crc16(seg)}\r\n`;
}

/** Date → YYYYMMDDhhmmss（设备本地时） */
function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** QN：精确到毫秒的 17 位请求编码 */
function qn(d) {
  const p = (n, w) => String(n).padStart(w, '0');
  return `${stamp(d)}${p(d.getMilliseconds(), 3)}`;
}

/* ==================================================================
 * 第二部分：确定性工况发生（无随机分量）
 * ================================================================== */

/** mulberry32：确定性 PRNG，种子来自字符串 */
function seeded(label) {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) { h ^= label.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  let a = h >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成某排口在给定时刻的工况。
 * 型号：负荷在日内按两段正弦波动；CO₂ 浓度随负荷略升（燃烧完全度变化）；
 * 含氧量随负荷略降。均为**确定性**函数，与 wall clock 绑定，可重放。
 * @param {string} mn
 * @param {Date} t
 * @param {number} idx 排口序号（决定基准负荷）
 */
function operatingPoint(mn, t, idx = 0) {
  const rnd = seeded(mn);
  const baseVel = 12.0 + idx * 1.6 + rnd() * 2.0;     // 基准流速 m/s
  const section = 5.5 + idx * 0.9 + rnd() * 0.8;      // 烟道截面积 m²
  const baseCo2 = 168000 + idx * 4200 + rnd() * 9000; // CO₂ 质量浓度 mg/m³

  // 日内负荷曲线：两个整周期，相位由 MN 决定
  const phase = rnd() * Math.PI * 2;
  const dayFrac = (t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds()) / 86400;
  const load = 0.86 + 0.14 * Math.sin(dayFrac * Math.PI * 4 + phase);

  const velocity = baseVel * load;
  const co2 = baseCo2 * (0.97 + 0.05 * load);
  const o2 = 7.2 - 1.1 * load;                        // 负荷越高，过剩氧越低
  const temp = 118 + 14 * load;
  const pressure = -0.118 - 0.006 * load;             // kPa
  const humidity = 8.5 + 1.5 * load;
  const dust = 8.5 + 4.0 * load;
  const so2 = 18 + 9 * load;
  const nox = 42 + 16 * load;

  return {
    velocity: Number(velocity.toFixed(2)),
    section: Number(section.toFixed(2)),
    co2: Math.round(co2),
    o2: Number(o2.toFixed(2)),
    temp: Number(temp.toFixed(1)),
    pressure: Number(pressure.toFixed(3)),
    humidity: Number(humidity.toFixed(1)),
    dust: Number(dust.toFixed(2)),
    so2: Number(so2.toFixed(2)),
    nox: Number(nox.toFixed(2)),
  };
}

/** 组装 CN=2011 实时数据帧 */
function buildRealtime(o) {
  const t = o.time;
  const p = o.point;
  const cp = '&&' + [
    `DataTime=${stamp(t)}`,
    `a05001-Rtd=${p.co2},a05001-Flag=${o.flag || 'N'}`,
    `a01011-Rtd=${p.velocity},a01011-Flag=${o.flag || 'N'}`,
    `a01016-Rtd=${p.section},a01016-Flag=${o.flag || 'N'}`,
    `a19001-Rtd=${p.o2},a19001-Flag=N`,
    `a01012-Rtd=${p.temp},a01012-Flag=N`,
    `a01013-Rtd=${p.pressure},a01013-Flag=N`,
    `a01014-Rtd=${p.humidity},a01014-Flag=N`,
    `a34013-Rtd=${p.dust},a34013-Flag=${o.flag || 'N'}`,
    `a21026-Rtd=${p.so2},a21026-Flag=N`,
    `a21002-Rtd=${p.nox},a21002-Flag=N`,
  ].join(';') + '&&';

  const seg = [
    `QN=${qn(t)}`,
    `ST=${o.st || '31'}`,
    'CN=2011',
    `PW=${o.pw}`,
    `MN=${o.mn}`,
    'Flag=5',
    `CP=${cp}`,
  ].join(';');

  if (o.badCrc) {
    // 故意写错 CRC：取正确值异或 0xFFFF
    const good = crc16(seg);
    const bad = ((parseInt(good, 16) ^ 0xffff) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    return `##${String(Buffer.byteLength(seg, 'latin1')).padStart(4, '0')}${seg}${bad}\r\n`;
  }
  return frame(seg);
}

/** 组装 CN=9021 登录帧 */
function buildLogin(o) {
  const seg = [
    `QN=${qn(o.time)}`, `ST=${o.st || '31'}`, 'CN=9021',
    `PW=${o.pw}`, `MN=${o.mn}`, 'Flag=5',
  ].join(';');
  return frame(seg);
}

/* ==================================================================
 * 第三部分：设备会话
 * ================================================================== */

const args = {};
for (let i = 0; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k.startsWith('--')) {
    const key = k.slice(2);
    args[key] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
  }
}

const API = String(args.api || 'http://127.0.0.1:8300').replace(/\/$/, '');
const HOST = String(args.host || '127.0.0.1');
const PORT = Number(args.port || 9100);
const PW = String(args.pw || '123456');
const INTERVAL_SEC = Math.max(Number(args.interval || 3), 1);
const ROUNDS = Number(args.rounds || 2);
const OFFLINE_SEC = Number(args.offline || 0);
const BAD_CRC = !!args['crc-bad'];
const FOREIGN_MN = !!args['foreign-mn'];
const ST = String(args.st || '31');

/** 从平台拉取设备台账 */
async function fetchDevices() {
  const url = `${API}/api/iot/devices?protocol=HJ212&authStatus=ACTIVE&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`拉取设备台账失败 HTTP ${res.status}`);
  const j = await res.json();
  const rows = Array.isArray(j) ? j : (j.rows || j.data || []);
  // 同一 MN 只保留一个会话；按企业+排口排序保证确定性
  const uniq = new Map();
  for (const d of rows) if (d.mn && !uniq.has(d.mn)) uniq.set(d.mn, d);
  return [...uniq.values()].sort((a, b) => String(a.mn).localeCompare(String(b.mn)));
}

class DeviceSession {
  constructor(dev, idx) {
    this.dev = dev;
    this.idx = idx;
    this.mn = dev.mn;
    this.socket = null;
    this.buffer = [];      // 断网续传缓冲
    this.sent = 0;
    this.acked = 0;
    this.rejected = 0;
    this.recv = '';
    this.connected = false;
  }

  connect() {
    return new Promise((resolve) => {
      const s = net.createConnection({ host: HOST, port: PORT });
      this.socket = s;
      s.on('connect', () => {
        this.connected = true;
        s.write(buildLogin({ time: new Date(), mn: this.mn, pw: PW, st: ST }));
        const pending = this.buffer.length;
        if (pending) {
          // 断网续传：按时间顺序补传
          for (const f of this.buffer) s.write(f);
          this.sent += pending;
          this.buffer = [];
        }
        resolve({ ok: true, resumed: pending });
      });
      s.on('data', (chunk) => {
        this.recv += chunk.toString('latin1');
        for (;;) {
          const p = this.recv.indexOf('##');
          if (p < 0) { this.recv = ''; break; }
          if (this.recv.length < p + 10) break;
          const len = Number.parseInt(this.recv.slice(p + 2, p + 6), 10);
          if (!Number.isFinite(len)) { this.recv = this.recv.slice(p + 2); continue; }
          const need = p + 6 + len + 4;
          if (this.recv.length < need) break;
          const seg = this.recv.slice(p + 6, p + 6 + len);
          this.recv = this.recv.slice(need);
          const m = seg.match(/QnRtn=(\d+)/);
          if (m) { if (m[1] === '1') this.acked++; else this.rejected++; }
        }
      });
      s.on('error', () => { this.connected = false; resolve({ ok: false }); });
      s.on('close', () => { this.connected = false; });
      setTimeout(() => resolve({ ok: this.connected, timeout: true }), 3000);
    });
  }

  emit(time, opts = {}) {
    const point = operatingPoint(this.mn, time, this.idx);
    const f = buildRealtime({
      time, mn: this.mn, pw: PW, st: ST, point,
      flag: opts.flag, badCrc: opts.badCrc,
    });
    if (this.connected && this.socket && this.socket.writable) {
      this.socket.write(f);
      this.sent++;
    } else {
      this.buffer.push(f);      // 断网 → 压入缓冲，重连后补传
    }
    return { point, frame: f };
  }

  close() { if (this.socket) try { this.socket.destroy(); } catch (e) {} }
}

/* ==================================================================
 * 主流程
 * ================================================================== */

async function main() {
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  碳链通 · CEMS 数采仪模拟器（HJ 212-2017 独立实现）');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  平台地址    ${API}    设备接入 ${HOST}:${PORT}`);
  console.log(`  上报节奏    每 ${INTERVAL_SEC} 秒一轮 × ${ROUNDS} 轮`);
  console.log(`  注入        ${BAD_CRC ? '坏 CRC ' : ''}${FOREIGN_MN ? '未登记 MN ' : ''}${OFFLINE_SEC ? `前 ${OFFLINE_SEC}s 断网后补传 ` : ''}${(!BAD_CRC && !FOREIGN_MN && !OFFLINE_SEC) ? '无（正常链路）' : ''}`);
  console.log('────────────────────────────────────────────────────────────────');

  let devices;
  if (FOREIGN_MN) {
    devices = [{ mn: crypto.createHash('sha256').update('FOREIGN-DEVICE').digest('hex').slice(0, 24).toUpperCase(), monitor_no: '（未登记）', ent_name: '（未登记）' }];
    console.log(`  故障注入：使用未登记 MN ${devices[0].mn}（期望平台登记为 PENDING 并拒绝入库）`);
  } else if (args.mn) {
    devices = [{ mn: String(args.mn), monitor_no: '（命令行指定）', ent_name: '—' }];
  } else {
    devices = await fetchDevices();
  }

  if (!devices.length) {
    console.error('  ✘ 未取到任何 HJ212 设备。请确认平台已启动且执行过设备台账自举。');
    process.exit(1);
  }
  console.log(`  在线设备    ${devices.length} 台${FOREIGN_MN ? '' : `（示例前 3 台：${devices.slice(0, 3).map((d) => d.monitor_no || d.mn.slice(0, 8)).join(' / ')}）`}`);
  console.log('────────────────────────────────────────────────────────────────');

  const sessions = devices.map((d, i) => new DeviceSession(d, i));
  const results = await Promise.all(sessions.map((s) => s.connect()));
  const up = results.filter((r) => r.ok).length;
  const resumed = results.reduce((a, r) => a + (r.resumed || 0), 0);
  console.log(`  ✔ 已接入 ${up}/${sessions.length} 台设备${resumed ? `；补传缓冲 ${resumed} 帧` : ''}`);

  if (OFFLINE_SEC > 0) {
    console.log(`  ⏸ 模拟断网 ${OFFLINE_SEC}s（期间报文进入本地缓冲，不发送）…`);
    for (const s of sessions) { s.close(); s.connected = false; }
    await new Promise((r) => setTimeout(r, OFFLINE_SEC * 1000));
    console.log('  ▶ 网络恢复，重连并补传缓冲报文…');
    await Promise.all(sessions.map((s) => s.connect()));
  }

  const t0 = Date.now();
  for (let round = 0; round < ROUNDS; round++) {
    for (const s of sessions) {
      // 每台设备错开 12ms，避免同一毫秒撞 QN
      s.emit(new Date(t0 + round * INTERVAL_SEC * 1000 + s.idx * 12), { badCrc: BAD_CRC });
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }

  await new Promise((r) => setTimeout(r, 1200));   // 等应答回来

  console.log('────────────────────────────────────────────────────────────────');
  const totalSent = sessions.reduce((a, s) => a + s.sent, 0);
  const totalAck = sessions.reduce((a, s) => a + s.acked, 0);
  const totalRej = sessions.reduce((a, s) => a + s.rejected, 0);
  console.log(`  已发报文    ${totalSent} 帧（含登录帧 ${sessions.length}）`);
  console.log(`  平台确认    ${totalAck} 帧（QnRtn=1 执行成功）`);
  console.log(`  平台拒绝    ${totalRej} 帧${totalRej ? '（QnRtn≠1，看平台侧 events）' : ''}`);
  const sample = operatingPoint(sessions[0].mn, new Date(), 0);
  const q = sample.velocity * sample.section * 3600;
  console.log('  单帧物理量（首台设备当前工况）');
  console.log(`    烟气流速 ${sample.velocity} m/s × 截面积 ${sample.section} m² = 烟气流量 ${Math.round(q)} m³/h`);
  console.log(`    CO₂ 浓度 ${sample.co2} mg/m³  →  排放速率 ${(q * sample.co2 * 1e-9).toFixed(3)} tCO₂/h`);
  console.log(`    含氧量 ${sample.o2}%  烟温 ${sample.temp}℃  烟尘 ${sample.dust} mg/m³  SO₂ ${sample.so2}  NOx ${sample.nox}`);
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');

  for (const s of sessions) s.close();
  // 等 socket 关闭事件刷完再退出
  await new Promise((r) => setTimeout(r, 300));
  process.exit(up === sessions.length ? 0 : 1);
}

main().catch((e) => {
  console.error('✘ 模拟器异常：', e && e.message ? e.message : e);
  process.exit(2);
});
