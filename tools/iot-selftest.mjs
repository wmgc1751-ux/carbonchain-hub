/**
 * iot-selftest.mjs —— 设备接入与准入治理的端到端验收（WP1）
 * ==================================================================
 * 为什么它不是"再跑一遍模拟器"
 * ------------------------------------------------------------------
 * 模拟器证明的是"报文能互通"。本工具证明的是**治理是否真的生效**：
 * 平台会不会在设备未授权、未绑定、报文被篡改、重复投递这些情形下，
 * 真的把数据挡在核算账本之外 —— 而不是嘴上说说。
 *
 * 与模拟器一样，本文件**自带独立的 HJ 212 编码器**（不复用 platform 代码），
 * 否则"编码器和解码器一起错"会让测试永远全绿。
 *
 * 验收用例（每例都按平台运行态计数**增量**判定，不依赖绝对基线）
 *   T1 未登记设备报到        → 期望：登记 PENDING，入库 +0，应答码 5
 *   T2 审批为 ACTIVE 后报到  → 期望：仍未绑定主体，入库 +0，应答码 7
 *   T3 绑定归属主体后报到    → 期望：入库 +1，应答码 1
 *   T4 CRC 被篡改的报文      → 期望：crcFail +1，入库 +0，应答码 6
 *   T5 访问密码错误的报文    → 期望：authFail +1，入库 +0，应答码 4
 *   T6 同一帧重复投递        → 期望：duplicates +1，入库 +0（幂等）
 *   T7 补传旧时间戳（断网续传）→ 期望：入库 +1，backfilled +1
 *   T8 重复占用同一排口      → 期望：拒绝绑定（防重复计量）
 *   T9 离线看门狗·未投运      → 期望：已绑定但从未直报的设备**不**被判离线（不误报）
 *   T10 离线看门狗·静默检出   → 期望：最后一次直报在 4 小时前 → 补记 1 条 OFFLINE
 *   T11 离线看门狗·冷却      → 期望：冷却期内重复巡检不重复补记
 *
 * 用法
 *   node tools/iot-selftest.mjs                                  # 默认 http://127.0.0.1:8300
 *   node tools/iot-selftest.mjs --api http://127.0.0.1:8300 --cleanup
 *   node tools/iot-selftest.mjs --ent 7                          # 指定绑定的企业
 *
 * 退出码：0 = 全部用例通过；1 = 存在失败用例
 */
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* ==================================================================
 * 一、**独立**的 HJ 212-2017 编码实现（与平台代码零共享）
 * ================================================================== */

function crc16(data) {
  let crc = 0xffff;
  for (const b of Buffer.from(data, 'latin1')) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
  }
  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}

/** 组装整帧；opts.badCrc 会把 CRC 故意写错 */
function frame(seg, opts = {}) {
  const len = Buffer.byteLength(seg, 'latin1');
  const crc = opts.badCrc
    ? (((parseInt(crc16(seg), 16) ^ 0xffff) & 0xffff).toString(16).toUpperCase().padStart(4, '0'))
    : crc16(seg);
  return `##${String(len).padStart(4, '0')}${seg}${crc}\r\n`;
}

function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function qn(d) { return `${stamp(d)}${String(d.getMilliseconds()).padStart(3, '0')}`; }

/**
 * 组装一帧 CN=2011 实时数据。
 * @param {object} o { mn, time, pw, st, flag, badCrc, qualityFlag }
 */
function realtimeFrame(o) {
  const t = o.time;
  const seg = [
    `QN=${qn(t)}`, `ST=${o.st || '31'}`, 'CN=2011', `PW=${o.pw == null ? '123456' : o.pw}`,
    `MN=${o.mn}`, 'Flag=5',
    'CP=&&' + [
      `DataTime=${stamp(t)}`,
      `a05001-Rtd=${o.co2 == null ? 178000 : o.co2},a05001-Flag=${o.qualityFlag || 'N'}`,
      `a01011-Rtd=${o.velocity == null ? 13.2 : o.velocity},a01011-Flag=${o.qualityFlag || 'N'}`,
      `a01016-Rtd=${o.section == null ? 6.0 : o.section},a01016-Flag=${o.qualityFlag || 'N'}`,
      'a19001-Rtd=6.8,a19001-Flag=N',
      'a01012-Rtd=128.5,a01012-Flag=N',
      'a34013-Rtd=11.2,a34013-Flag=' + (o.qualityFlag || 'N'),
    ].join(';') + '&&',
  ].join(';');
  return frame(seg, o);
}

/* ==================================================================
 * 二、HTTP 客户端
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
const TCP_PORT = Number(args['tcp-port'] || 9100);
const TCP_HOST = String(args.host || '127.0.0.1');
const OUT_ENT = Number(args.ent || 7);
const CLEANUP = !!args.cleanup;

async function apiGet(p) {
  const r = await fetch(API + p);
  const j = await r.json();
  if (j.code !== 0) throw new Error(`GET ${p} 失败：${j.message}`);
  return j.data;
}
async function apiPost(p, body, token) {
  const r = await fetch(API + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

/* ==================================================================
 * 三、TCP 会话（发送帧、读应答码）
 * ================================================================== */

class Session {
  constructor(mn) {
    this.mn = mn;
    this.recv = '';
    this.rtn = [];       // 收到的应答码
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: TCP_HOST, port: TCP_PORT });
      this.socket = s;
      s.on('connect', () => resolve(true));
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
          if (m) this.rtn.push(Number(m[1]));
        }
      });
      s.on('error', (e) => reject(e));
      setTimeout(() => resolve(this.socket && !this.socket.destroyed), 2500);
    });
  }

  /** 发送并等待应答，返回本次应答码（超时返回 null） */
  async ask(frameStr, waitMs = 1500) {
    const before = this.rtn.length;
    this.socket.write(frameStr);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this.rtn.length > before) return this.rtn[this.rtn.length - 1];
      await new Promise((r) => setTimeout(r, 40));
    }
    return null;
  }

  close() { try { this.socket.destroy(); } catch (e) {} }
}

/* ==================================================================
 * 四、用例执行
 * ================================================================== */

const results = [];

/**
 * 挑一个该企业下尚未被占用的排口编号。
 * 从 00..FF 顺序找首个空闲；标准排口 01/02/03 已被在册设备占用，故会自然跳过。
 * @param {number} entId
 * @returns {Promise<string>}
 */
async function pickFreeMonitor(entId) {
  const all = await apiGet(`/api/iot/devices?entId=${entId}&limit=1000`);
  const used = new Set(all.map((d) => d.monitor_no).filter(Boolean));
  const pre = `M-${String(entId).padStart(4, '0')}-`;
  for (let i = 0; i < 256; i++) {
    const cand = pre + i.toString(16).toUpperCase().padStart(2, '0');
    if (!used.has(cand)) return cand;
  }
  throw new Error(`企业 ${entId} 下已无空闲排口编号可用`);
}

async function runCase(name, expect, fn) {
  const before = await apiGet('/api/iot/status');
  let detail = {};
  let error = null;
  try { detail = await fn() || {}; } catch (e) { error = e.message; }
  const after = await apiGet('/api/iot/status');

  const delta = {
    readingsInserted: after.readingsInserted - before.readingsInserted,
    crcFail: after.crcFail - before.crcFail,
    authFail: after.authFail - before.authFail,
    rejected: after.rejected - before.rejected,
    duplicates: after.duplicates - before.duplicates,
    backfilled: after.backfilled - before.backfilled,
  };

  const problems = [];
  if (error) problems.push(`执行异常：${error}`);
  for (const [k, v] of Object.entries(expect.delta || {})) {
    if (delta[k] !== v) problems.push(`${k} 增量应为 ${v}，实际 ${delta[k]}`);
  }
  for (const [k, v] of Object.entries(expect.rtn || {})) {
    if (detail[k] !== v) problems.push(`${k} 应为 ${v}，实际 ${detail[k]}`);
  }
  if (expect.check) expect.check(detail, problems);

  results.push({ name, pass: problems.length === 0, delta, detail, problems });
  return { delta, detail };
}

/* ==================================================================
 * 五、主流程
 * ================================================================== */

async function main() {
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  碳链通 · 设备接入与准入治理 端到端验收');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  平台 API    ${API}`);
  console.log(`  设备接入    ${TCP_HOST}:${TCP_PORT}（HJ 212-2017）`);
  console.log(`  绑定企业    ${OUT_ENT}`);
  console.log('────────────────────────────────────────────────────────────────');

  // 每轮用全新 MN，保证可重复执行
  const MN = crypto.createHash('sha256')
    .update(`IOT-SELFTEST|${Date.now()}|${Math.random()}`)
    .digest('hex').slice(0, 24).toUpperCase();
  console.log(`  测试设备 MN ${MN}（全新，刻意不在册）`);

  /* 时间槽：每个用例用**互不相同**的秒级时间戳。
   * 踩过的坑：T4/T5 应答在 40ms 内返回，若各用例各取 new Date()，
   * T3 与 T6 会落在同一秒，(ent,monitor,reading_time) 唯一键把它判成重复，
   * 于是 T6 的"首帧应入库"永远失败 —— 这是测试自身的缺陷，不是平台缺陷。
   * 固定基准 + 逐例偏移，让判定与执行快慢无关。 */
  const BASE = Math.floor(Date.now() / 1000) * 1000;
  const tAt = (offsetSec) => new Date(BASE - offsetSec * 1000);
  console.log(`  时间基准    ${stamp(new Date(BASE))}（逐例偏移，保证唯一）`);

  const token = (await apiPost('/api/auth/login', { username: 'admin', password: 'admin123' })).body.data.token;
  const sess = new Session(MN);
  await sess.connect();
  console.log('  ✔ 已建立 HJ 212 连接');
  console.log('────────────────────────────────────────────────────────────────');

  /* ---------- T1 未登记设备报到 ---------- */
  await runCase('T1 未登记设备报到（期望拦截）',
    { delta: { readingsInserted: 0, rejected: 1 }, rtn: { rtn: 5 } },
    async () => ({ rtn: await sess.ask(realtimeFrame({ mn: MN, time: tAt(0), pw: '123456' })) }));

  const dev = (await apiGet(`/api/iot/devices?keyword=${MN}`))[0];
  results[results.length - 1].detail.台账状态 = dev ? dev.auth_status : '（未登记）';
  if (!dev || dev.auth_status !== 'PENDING') {
    results[results.length - 1].pass = false;
    results[results.length - 1].problems.push(`期望自动登记为 PENDING，实际 ${dev ? dev.auth_status : '未登记'}`);
  }
  const DID = dev ? dev.device_did : null;

  /* ---------- T2 已授权但未绑定 ---------- */
  await runCase('T2 审批为 ACTIVE 但未绑定主体（期望仍拦截）',
    { delta: { readingsInserted: 0, rejected: 1 }, rtn: { rtn: 7 } },
    async () => {
      const a = await apiPost(`/api/iot/devices/${encodeURIComponent(DID)}/auth`,
        { status: 'ACTIVE', note: '验收用例：现场核验通过' }, token);
      if (a.status !== 200) throw new Error(`审批失败：${a.body.message}`);
      return { rtn: await sess.ask(realtimeFrame({ mn: MN, time: tAt(1), pw: '123456' })), 审批: a.body.message };
    });

  /* ---------- T3 绑定归属主体后放行 ---------- */
  /* 动态挑选一个空闲的排口编号。
   * 踩过的坑：写死 M-0007-91 时，第二次运行会撞上第一次运行留下的设备，
   * T3 永远失败 —— 自测工具必须自己保证可重复，不能依赖"数据库恰好干净"。 */
  const TEST_MONITOR = await pickFreeMonitor(OUT_ENT);
  console.log(`  选用排口    ${TEST_MONITOR}（该企业下的空闲编号）`);
  console.log('────────────────────────────────────────────────────────────────');
  await runCase('T3 绑定归属主体后（期望放行入库）',
    { delta: { readingsInserted: 1, rejected: 0 }, rtn: { rtn: 1 } },
    async () => {
      const b = await apiPost(`/api/iot/devices/${encodeURIComponent(DID)}/bind`,
        { entId: OUT_ENT, monitorNo: TEST_MONITOR, note: '验收用例绑定' }, token);
      if (b.status !== 200) throw new Error(`绑定失败：${b.body.message}`);
      return { rtn: await sess.ask(realtimeFrame({ mn: MN, time: tAt(2), pw: '123456' })), 绑定: b.body.message };
    });

  /* ---------- T4 CRC 被篡改 ---------- */
  await runCase('T4 CRC 被篡改的报文（期望校验拦截）',
    { delta: { crcFail: 1, readingsInserted: 0 }, rtn: { rtn: 6 } },
    async () => ({ rtn: await sess.ask(realtimeFrame({ mn: MN, time: tAt(3), pw: '123456', badCrc: true })) }));

  /* ---------- T5 访问密码错误 ---------- */
  await runCase('T5 访问密码错误（期望鉴权拦截）',
    { delta: { authFail: 1, readingsInserted: 0 }, rtn: { rtn: 4 } },
    async () => ({ rtn: await sess.ask(realtimeFrame({ mn: MN, time: tAt(4), pw: 'wrong-pw' })) }));

  /* ---------- T6 重复投递（幂等） ---------- */
  {
    const t = tAt(5);
    const f = realtimeFrame({ mn: MN, time: t, pw: '123456' });
    await runCase('T6 同一帧重复投递（期望幂等去重）',
      { delta: { readingsInserted: 1, duplicates: 1 }, rtn: { rtn: 1 } },
      async () => {
        const r1 = await sess.ask(f);
        const dupBefore = (await apiGet('/api/iot/status')).duplicates;
        const r2 = await sess.ask(f);
        // 幂等：第二帧仍应以"执行成功"应答（对设备而言是成功的），但不重复入库
        void dupBefore;
        return { rtn: r2, 首帧应答: r1 };
      });
  }

  /* ---------- T7 补传旧时间戳（断网续传） ---------- */
  await runCase('T7 补传旧时间戳（期望识别为断网续传）',
    { delta: { readingsInserted: 1, backfilled: 1 }, rtn: { rtn: 1 } },
    async () => {
      const old = new Date(Date.now() - 3600 * 1000);   // 1 小时前
      return { rtn: await sess.ask(realtimeFrame({ mn: MN, time: old, pw: '123456' })), 补传时刻: stamp(old) };
    });

  /* ---------- T8 按排口编号占用冲突（治理纪律） ---------- */
  await runCase('T8 重复占用同一排口（期望拒绝，防重复计量）',
    { delta: { readingsInserted: 0 } },
    async () => {
      // 另起一个全新设备，尝试绑定到 T3 已占用的排口，且不带 replace
      const MN2 = crypto.createHash('sha256').update(`IOT-SELFTEST-2|${Date.now()}`).digest('hex').slice(0, 24).toUpperCase();
      const s2 = new Session(MN2);
      await s2.connect();
      await s2.ask(realtimeFrame({ mn: MN2, time: new Date(), pw: '123456' }));   // 触发自动登记
      const d2 = (await apiGet(`/api/iot/devices?keyword=${MN2}`))[0];
      s2.close();
      const r = await apiPost(`/api/iot/devices/${encodeURIComponent(d2.device_did)}/bind`,
        { entId: OUT_ENT, monitorNo: TEST_MONITOR }, token);
      if (r.status === 200) throw new Error('同一排口被两台设备绑定成功 —— 治理纪律未生效！');
      return { 应答: r.body.message.slice(0, 90) + '…' };
    });

  /* ---------- T9~T11 离线看门狗（OFFLINE 标记的真实生产者） ----------
   * 为什么单独验它：MISSING/DRIFT/CALIBRATION 都能由**报文本身**给出（设备在报，只是报了坏数据），
   * 唯独 OFFLINE 相反 —— 设备什么都没报。没有看门狗，"设备静默"这件最严重的数据质量事件
   * 在平台里不会留下任何痕迹。以下三条分别验：不误报 / 能检出 / 冷却生效。 */
  const offlineCount = async () => {
    const q = await apiGet('/api/iot/quality');
    const row = q.distribution.find((d) => d.flag === 'OFFLINE');
    return row ? Number(row.count) : 0;
  };

  // 临时设备：登记（拒绝入库）→ 审批 → 绑定到一个空闲排口
  const MN3 = crypto.createHash('sha256')
    .update(`IOT-SELFTEST-WD|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 24).toUpperCase();
  const s3 = new Session(MN3);
  await s3.connect();
  await s3.ask(realtimeFrame({ mn: MN3, time: new Date(Date.now() - 300000), pw: '123456' }));
  const d3 = (await apiGet(`/api/iot/devices?keyword=${MN3}`))[0];
  const MON3 = await pickFreeMonitor(OUT_ENT);
  await apiPost(`/api/iot/devices/${encodeURIComponent(d3.device_did)}/auth`, { status: 'ACTIVE', note: '看门狗用例' }, token);
  await apiPost(`/api/iot/devices/${encodeURIComponent(d3.device_did)}/bind`, { entId: OUT_ENT, monitorNo: MON3, note: '看门狗用例绑定' }, token);
  console.log('');
  console.log(`  看门狗测试设备 ${MN3}`);
  console.log(`  绑定排口    ${MON3}（该设备尚无任何直报读数）`);
  console.log('────────────────────────────────────────────────────────────────');

  /* ---------- T9 未投运 ≠ 离线（不误报） ---------- */
  await runCase('T9 离线看门狗：已绑定但从未直报（期望不判离线）',
    {},
    async () => {
      const r = await apiPost('/api/iot/offline-sweep',
        { did: d3.device_did, silentMinutes: 1, cooldownMinutes: 60, maxPerRun: 5 }, token);
      if (r.status !== 200) throw new Error(`巡检失败：${r.body.message}`);
      const data = r.body.data;
      if (data.marked !== 0) throw new Error(`期望不判离线，实际补记 ${data.marked} 条`);
      return { 巡检范围: data.scope, 判定模式: data.evidenceOnly ? '仅设备直报为存活证据' : '宽松', 补记: data.marked };
    });

  /* ---------- T10 静默检出（最后一次直报在 4 小时前） ---------- */
  {
    const beforeOffline = await offlineCount();
    await runCase('T10 离线看门狗：静默 4 小时（期望检出并补记 OFFLINE）',
      { delta: { readingsInserted: 1 } },
      async () => {
        const old = new Date(Date.now() - 4 * 3600 * 1000);
        const rtn = await s3.ask(realtimeFrame({ mn: MN3, time: old, pw: '123456' }));
        const r = await apiPost('/api/iot/offline-sweep',
          { did: d3.device_did, silentMinutes: 60, cooldownMinutes: 60, maxPerRun: 5 }, token);
        if (r.status !== 200) throw new Error(`巡检失败：${r.body.message}`);
        const data = r.body.data;
        const after = await offlineCount();
        if (data.marked !== 1) throw new Error(`期望补记 1 条，实际 ${data.marked}`);
        if (!data.details[0] || data.details[0].monitorNo !== MON3) {
          throw new Error(`补记的排口应为 ${MON3}，实际 ${data.details[0] && data.details[0].monitorNo}`);
        }
        if (after - beforeOffline !== 1) throw new Error(`OFFLINE 总数应 +1，实际 ${after - beforeOffline}`);
        return {
          rtn, 补记: `${data.marked} 条（排口 ${data.details[0].monitorNo}）`,
          最后直报: String(data.details[0].lastAt).slice(0, 19),
          OFFLINE总数: `${beforeOffline} → ${after}`,
        };
      });
  }

  /* ---------- T11 冷却期不重复补记 ---------- */
  await runCase('T11 离线看门狗：冷却期内重复巡检（期望不重复补记）',
    {},
    async () => {
      const r = await apiPost('/api/iot/offline-sweep',
        { did: d3.device_did, silentMinutes: 60, cooldownMinutes: 60, maxPerRun: 5 }, token);
      const data = r.body.data;
      if (data.marked !== 0) throw new Error(`冷却期内不应重复补记，实际 ${data.marked}`);
      return { 补记: data.marked, 说明: '同一排口 60 分钟内已有 OFFLINE 记录，冷却生效' };
    });

  s3.close();

  sess.close();
  await new Promise((r) => setTimeout(r, 300));

  /* ---------- 输出 ---------- */
  for (const r of results) {
    console.log('');
    console.log(`  ${r.pass ? '✔' : '✘'} ${r.name}`);
    console.log(`      运行态增量  ${JSON.stringify(r.delta)}`);
    for (const [k, v] of Object.entries(r.detail)) {
      if (k === 'rtn') continue;
      console.log(`      ${k}：${String(v).slice(0, 130)}`);
    }
    if (r.detail.rtn !== undefined) console.log(`      平台应答码  QnRtn=${r.detail.rtn}`);
    for (const p of r.problems) console.log(`      ✘ ${p}`);
  }

  const pass = results.filter((r) => r.pass).length;
  console.log('');
  console.log('────────────────────────────────────────────────────────────────');
  console.log(`  结果：${pass}/${results.length} 个用例通过`);
  console.log(pass === results.length
    ? '  ✔ 准入治理闭环成立：未登记/未授权/未绑定/坏 CRC/错密码 一律挡在账本之外，'
      + '\n    重复投递幂等去重，断网补传可识别，同一排口不允许重复计量。'
    : '  ✘ 存在未通过用例，准入治理存在缺口。');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');

  if (CLEANUP) {
    console.log(`  提示：测试设备 ${MN} 及其读数已写入平台。`);
    console.log('  这是**真实设备数据**（平台无法区分测试与生产设备），故不自动删除；');
    console.log('  如需清理，请由监管端吊销该设备，并按 device_did 手工处置其读数。');
    console.log('');
  }

  /* ---------- 证据落盘（指标溯源台账 iot.* 四条的证据源） ----------
   * 台账纪律"缺证即空"要求每个被引用的数字都有落盘文件可查；
   * 本套件此前只打印不落盘，导致台账四条 iot 指标永远 MISSING。
   * 数字直接取自 /api/iot/stats 实时统计（registry.stats()），
   * 与页面/接口口径同源，不在此处二次计算。 */
  try {
    const stats = await apiGet('/api/iot/stats');
    const outDir = path.resolve(process.cwd(), 'tools', 'out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'iot-stats.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      generator: 'tools/iot-selftest.mjs',
      cmd: 'node tools/iot-selftest.mjs',
      source: '/api/iot/stats（registry.stats() 实时统计）',
      data: {
        total: stats.total, active: stats.active,
        directReports: stats.directReports, crcVerified: stats.crcVerified,
      },
      selftest: { pass, total: results.length },
    }, null, 2), 'utf8');
    console.log(`  证据已写出：tools/out/iot-stats.json（设备 ${stats.total} 台 / ACTIVE ${stats.active} / 直报 ${stats.directReports} 帧 / CRC 通过 ${stats.crcVerified} 帧）`);
  } catch (e) {
    console.log(`  ⚠ 证据落盘失败（不影响用例判定）：${e.message}`);
  }

  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('✘ 验收脚本异常：', e && e.message ? e.message : e);
  process.exit(2);
});
