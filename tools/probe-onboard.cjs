/**
 * probe-onboard.cjs —— 企业对接能力实测探针（启动→测→关 单进程）
 * 验证：企业自主注册 / 注册即登录 / 租户隔离 / 重复注册拒绝 / 数据接入端点
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = 8391;
const HJ212_PORT = 9191;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');

function req(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch (e) { /* keep raw */ }
        resolve({ status: res.statusCode, json: j, raw: buf.slice(0, 300) });
      });
    });
    r.on('error', reject);
    r.setTimeout(8000, () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, okFlag, detail) {
  results.push({ name, ok: okFlag, detail });
  console.log(`${okFlag ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HJ212_PORT: String(HJ212_PORT),
      INSTANCE_LOCK: '0',
      JWT_SECRET: 'probe-onboard-secret-for-test-only-0x2f',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

  try {
    // 1. 等待就绪
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { const h = await req('GET', `${BASE}/api/health`); if (h.status === 200) { ready = true; break; } }
      catch (e) { /* retry */ }
      await sleep(500);
    }
    record('服务就绪(/api/health)', ready, ready ? `端口 ${PORT}` : '60s 内未就绪');
    if (!ready) throw new Error('server not ready');

    // 2. 企业自主注册（唯一随机名）
    const stamp = Date.now().toString(36).toUpperCase();
    const regBody = {
      username: 'probe_ent_' + stamp.toLowerCase(),
      password: 'Probe#123456',
      realName: '探针联系人',
      orgName: '探针测试企业' + stamp,
      industry: '电力',
      region: '江苏',
      contactPhone: '13800000000',
    };
    const reg = await req('POST', `${BASE}/api/auth/register`, regBody);
    const regOk = reg.status === 200 && reg.json && reg.json.ok !== false && reg.json.data && reg.json.data.token;
    record('企业自主注册 POST /api/auth/register', !!regOk,
      `HTTP ${reg.status} | ${reg.json ? (reg.json.message || JSON.stringify(reg.json).slice(0, 120)) : reg.raw}`);
    const token = regOk ? reg.json.data.token : null;
    const orgId = regOk ? reg.json.data.user.orgId : null;
    const role = regOk ? reg.json.data.user.role : null;
    record('注册即登录(返回token+ENTERPRISE角色)', !!(token && role === 'ENTERPRISE' && Number.isInteger(orgId)),
      `role=${role} orgId=${orgId}`);

    // 3. /me 鉴权回读
    const me = await req('GET', `${BASE}/api/auth/me`, null, token);
    record('注册账号鉴权回读 /api/auth/me', me.status === 200 && me.json && me.json.data && me.json.data.username === regBody.username,
      `HTTP ${me.status} username=${me.json && me.json.data ? me.json.data.username : '?'}`);

    // 4. 租户隔离：新企业工作台数据应为空/仅限本企业
    const iso1 = await req('GET', `${BASE}/api/enterprise/overview`, null, token);
    const d = iso1.json && iso1.json.data;
    const detail = iso1.status + ' ' + JSON.stringify(d).slice(0, 220);
    const emptyish = !d || JSON.stringify(d).match(/ent001|华明|示范/) === null;
    record('租户隔离(新企业看不到既有企业数据)', iso1.status === 200 && emptyish, detail);

    // 5. 负向：重复企业名注册应 409
    const dup = await req('POST', `${BASE}/api/auth/register`, { ...regBody, username: 'probe_dup_' + stamp.toLowerCase() });
    record('重复企业名注册被拒', dup.status === 409, `HTTP ${dup.status} | ${dup.json ? dup.json.message : dup.raw}`);

    // 6. 负向：敏感角色不可注册（模拟：注册接口不接受 role 字段）
    const evil = await req('POST', `${BASE}/api/auth/register`, { ...regBody, username: 'probe_evil_' + stamp.toLowerCase(), role: 'ADMIN', orgName: '探针越权企业' + stamp });
    const evilRole = evil.json && evil.json.data && evil.json.data.user ? evil.json.data.user.role : '?';
    record('公开注册无法获得 ADMIN 角色', evil.status === 200 ? evilRole === 'ENTERPRISE' : evil.status >= 400,
      `HTTP ${evil.status} role=${evilRole}`);

    // 7. 数据接入面：IoT 设备接口 + HJ212 就绪
    const iot = await req('GET', `${BASE}/api/iot/status`, null, token);
    record('IoT 数据接入面 /api/iot/status', iot.status === 200, `HTTP ${iot.status} ${JSON.stringify(iot.json).slice(0, 160)}`);

    // 8. HJ212 TCP 端口探活（服务在 DB 就绪+台账自举后才监听，约需 15-20s，轮询等待）
    const net = require('net');
    let hjOk = false;
    for (let i = 0; i < 30 && !hjOk; i++) {
      hjOk = await new Promise((resolve) => {
        const s = net.connect(HJ212_PORT, '127.0.0.1', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
        s.setTimeout(2000, () => { s.destroy(); resolve(false); });
      });
      if (!hjOk) await sleep(1000);
    }
    record('HJ212 数据接入服务(TCP)', hjOk, `端口 ${HJ212_PORT} ${hjOk ? '可连接' : '30s 内未监听'}`);

    // 9. 设备登记/绑定权限面（企业角色不应能登记设备密钥）
    const regKey = await req('POST', `${BASE}/api/iot/devices/register-key`, { deviceId: 'PROBE-DEV-01', publicKey: 'test' }, token);
    record('设备密钥登记仅限 ADMIN/REGULATOR', regKey.status === 403, `HTTP ${regKey.status}`);

    /* ---- 10~13 企业 REST 数据录入通道（线上 Workers 无 TCP 时的对等接入面） ---- */
    const yr = new Date().getFullYear();
    const act = await req('POST', `${BASE}/api/mrv/activity`, {
      year: yr, month: 10, sourceCode: 'COAL', quantity: 128.5, dataOrigin: 'L2',
      voucherNo: 'PROBE-V-001', remark: 'probe-onboard 录入',
    }, token);
    const actOk = act.status === 200 && act.json && act.json.data && act.json.data.status === 'SUBMITTED';
    record('企业 REST 录入活动数据 POST /api/mrv/activity', !!actOk,
      `HTTP ${act.status} | ${act.json && act.json.data ? `id=${act.json.data.id} status=${act.json.data.status}` : (act.json && act.json.message) || act.raw}`);
    const recId = actOk ? act.json.data.id : null;

    const bulk = await req('POST', `${BASE}/api/mrv/activity/bulk`, {
      year: yr, items: [
        { month: 9, sourceCode: 'COAL', quantity: 96.0, dataOrigin: 'L2' },
        { month: 9, sourceCode: 'POWER', quantity: 41.2, dataOrigin: 'L3' },
      ],
    }, token);
    const bulkOk = bulk.status === 200 && bulk.json && bulk.json.data && bulk.json.data.saved === 2;
    record('企业 REST 批量录入 POST /api/mrv/activity/bulk', !!bulkOk,
      `HTTP ${bulk.status} | ${bulk.json && bulk.json.data ? `saved=${bulk.json.data.saved} rejected=${bulk.json.data.rejected}` : (bulk.json && bulk.json.message) || bulk.raw}`);

    const bad = await req('POST', `${BASE}/api/mrv/activity`, { year: yr, month: 10, sourceCode: 'NOT_A_SOURCE', quantity: 1 }, token);
    record('未知排放源录入被拒(方法学校验)', bad.status === 400, `HTTP ${bad.status}`);

    const list = await req('GET', `${BASE}/api/mrv/activity?year=${yr}`, null, token);
    const listRows = list.json && list.json.data && list.json.data.records ? list.json.data.records : [];
    const onlyMine = listRows.length > 0 && listRows.every((r) => r.sourceCode === 'COAL' || r.sourceCode === 'POWER');
    record('录入数据租户隔离(仅见本企业记录)', list.status === 200 && listRows.length >= 3 && onlyMine,
      `HTTP ${list.status} rows=${listRows.length} sources=${[...new Set(listRows.map((r) => r.sourceCode))].join(',')}`);

  } catch (e) {
    record('探针异常中止', false, String(e.message || e));
  } finally {
    child.kill('SIGTERM');
    await sleep(800);
    try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\nSUMMARY: ${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
})();
