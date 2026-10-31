#!/usr/bin/env node
/**
 * tools/_qa/filter-matrix.cjs —— 列表接口「筛选参数」全组合实测
 * ==================================================================
 * 为什么需要它（2026-10-28 教训）：
 *   企业端上报列表裸写 `status = ?`，JOIN 了同样有 status 列的 verifier_org，
 *   于是**只有选了筛选条件才 500**、不选筛选一切正常。浅层扫描（不带参数）
 *   和静态代码审查都抓不到这类"参数型缺陷"。
 *
 * 做法：把每个列表接口的筛选参数，按「每个取值」×「空/非空」逐一打一遍，
 * 只要出现 500 或非预期错误码就报出来。只做 GET，不写数据。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const PORT = 8300;
const BASE = `http://127.0.0.1:${PORT}`;

function call(method, p, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, timeout: 30000 },
      (resp) => {
        let s = '';
        resp.on('data', (c) => (s += c));
        resp.on('end', () => {
          let b; try { b = JSON.parse(s); } catch { b = { raw: s.slice(0, 120) }; }
          resolve({ status: resp.statusCode, body: b });
        });
      });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: { msg: 'timeout' } }); });
    r.on('error', (e) => resolve({ status: 0, body: { msg: String(e.message) } }));
    if (data) r.write(data);
    r.end();
  });
}

/* 角色 → 该角色会真正用到的列表接口与其筛选维度 */
const PLAN = [
  {
    role: 'ENTERPRISE', user: 'ent001',
    cases: [
      ['/api/enterprise/reports', { status: ['DRAFT', 'SUBMITTED', 'VERIFYING', 'APPROVED', 'REJECTED'], period: ['2026Q3', '2025Q4'], keyword: ['ER', 'zzz'] }],
      ['/api/enterprise/notices', {}],
      ['/api/enterprise/quota', {}],
      ['/api/mrv/activity', { year: ['2026', '2025'], month: ['1', '12'], status: ['CONFIRMED', 'PENDING'], origin: ['MANUAL', 'REAL'] }],
      ['/api/settlement/retirement', { year: ['2026'] }],
      ['/api/credit/offsets', {}],
      ['/api/trade/orders', { status: ['OPEN', 'FILLED', 'CANCELLED'] }],
      ['/api/trade/deals', {}],
    ],
  },
  {
    role: 'REGULATOR', user: 'reg001',
    cases: [
      ['/api/regulator/enterprises', { industry: ['造纸', '电力'], region: ['河北'], status: ['ACTIVE'] }],
      ['/api/regulator/logs', { module: ['AUTH', 'TRADE'], role: ['ADMIN', 'ENTERPRISE'], keyword: ['login', 'zzz'] }],
      ['/api/regulator/allocations', { year: ['2026'] }],
      ['/api/regulator/alerts', { status: ['OPEN', 'HANDLED'] }],
      ['/api/trade/deals', {}],
      ['/api/regulator/notices', {}],
    ],
  },
  {
    role: 'VERIFIER', user: 'ver001',
    cases: [
      ['/api/verifier/tasks', { status: ['PENDING', 'ACCEPTED', 'DONE'] }],
      ['/api/verifier/reports', {}],
      ['/api/verifier/notices', {}],
    ],
  },
  {
    role: 'TRADER', user: 'trader01',
    cases: [
      ['/api/trade/market', { status: ['OPEN'] }],
      ['/api/trade/orders', { status: ['OPEN', 'FILLED'] }],
      ['/api/trade/deals', {}],
    ],
  },
  {
    role: 'ADMIN', user: 'admin',
    cases: [
      ['/api/admin/factors', { status: ['ACTIVE'] }],
      ['/api/admin/reconciliations', {}],
      ['/api/chain/txs', { type: ['EMISSION_REPORT', 'TRADE_DEAL'], status: ['CONFIRMED'], keyword: ['ER'] }],
      ['/api/chain/blocks', {}],
    ],
  },
];

async function login(u, p) {
  const r = await call('POST', '/api/auth/login', null, { username: u, password: p });
  return r.body && r.body.data && r.body.data.token;
}

function combos(dims) {
  /* 每个维度取值的独立组合 + 全空。只做「单维单值」，避免组合爆炸；
   * 单维就能触发 JOIN 歧义，这正是要抓的形态。 */
  const out = [];
  for (const [k, vals] of Object.entries(dims)) {
    for (const v of vals) out.push({ [k]: v });
  }
  if (Object.keys(dims).length) out.push({});       // 无参数对照
  return out;
}

(async () => {
  const findings = [];
  let checks = 0;
  for (const grp of PLAN) {
    const token = await login(grp.user, grp.user === 'admin' ? 'admin123' : '123456');
    if (!token) { console.log(`✘ ${grp.role} 登录失败`); continue; }
    console.log(`\n════ ${grp.role} ════`);
    for (const [p, dims] of grp.cases) {
      const cs = Object.keys(dims).length ? combos(dims) : [{}];
      for (const q of cs) {
        const qs = Object.entries(q).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        const url = qs ? `${p}?${qs}` : p;
        checks++;
        const r = await call('GET', url, token);
        const code = r.body && r.body.code;
        const okStatus = r.status === 200 && (code === 0 || code === undefined);
        if (!okStatus) {
          const msg = (r.body && (r.body.message || r.body.msg)) || r.body;
          console.log(`  ✘ ${url} → ${r.status} ${String(msg).slice(0, 110)}`);
          findings.push({ role: grp.role, url, status: r.status, msg: String(msg) });
        }
      }
    }
    const badForRole = findings.filter((f) => f.role === grp.role);
    console.log(`  ── ${grp.role}：用例 ${grp.cases.reduce((a, [, d]) => a + (Object.keys(d).length ? combos(d).length : 1), 0)}｜失败 ${badForRole.length}`);
  }

  console.log(`\n══ 合计 ${checks} 个参数组合，失败 ${findings.length} ══`);
  const outDir = path.join(ROOT, 'tools', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'filter-matrix.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), checks, findings }, null, 2), 'utf8');
  process.exitCode = findings.length ? 1 : 0;
})();
