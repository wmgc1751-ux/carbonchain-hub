#!/usr/bin/env node
/* 复测异常项：顺序执行、无并发干扰，区分"真 bug"与"负载误报" */
'use strict';
const http = require('http');
function req(method, p, token) {
  return Promise.race([
    new Promise((resolve) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      const t0 = Date.now();
      const r = http.request({ host: '127.0.0.1', port: 8300, path: p, method, headers, timeout: 60000 },
        (resp) => {
          let s = '';
          resp.on('data', (c) => (s += c));
          resp.on('end', () => resolve({ ms: Date.now() - t0, status: resp.statusCode, body: s.slice(0, 300) }));
        });
      r.on('timeout', () => { r.destroy(); resolve({ ms: Date.now() - t0, status: 0, body: 'TIMEOUT' }); });
      r.on('error', (e) => resolve({ ms: Date.now() - t0, status: 0, body: String(e.message) }));
      r.end();
    }),
    new Promise((resolve) => setTimeout(() => resolve({ ms: 60000, status: 0, body: 'HARD-TIMEOUT' }), 61000)),
  ]);
}
async function login(u, p) {
  return new Promise((resolve) => {
    const d = JSON.stringify({ username: u, password: p });
    const rq = http.request({ host: '127.0.0.1', port: 8300, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
      (resp) => { let s = ''; resp.on('data', (c) => (s += c)); resp.on('end', () => { try { resolve(JSON.parse(s).data.token); } catch { resolve(null); } }); });
    rq.write(d); rq.end();
  });
}
(async () => {
  const T = {};
  for (const [u, p] of [['admin','admin123'],['reg001','123456'],['ent001','123456']]) T[u] = await login(u, p);
  const cases = [
    ['重接口·负载复测', '/api/chain/trust-model', 'admin'],
    ['重接口·负载复测', '/api/regulator/system', 'reg001'],
    ['重接口·负载复测', '/api/chain/validate', 'admin'],
    ['重接口·负载复测', '/api/chain/business-binding', 'admin'],
    ['重接口·负载复测', '/api/chain/anchor/stats', 'admin'],
    ['500 复现', '/api/enterprise/wallet', 'admin'],
    ['对照·正常', '/api/enterprise/wallet', 'ent001'],
  ];
  for (const [tag, p, role] of cases) {
    const r = await req('GET', p, T[role]);
    console.log(`[${tag}] ${p} @${role} -> ${r.status} ${r.ms}ms  ${String(r.body).slice(0, 140)}`);
  }
  // 带参正验：从可列表接口取真实 entId
  const entList = await req('GET', '/api/regulator/enterprises', T.reg001);
  let entId = null;
  try {
    const d = JSON.parse(entList.body).data;
    const row = (d && (d.rows || d.items || d))[0] || (Array.isArray(d) ? d[0] : null);
    entId = row && (row.entId || row.id || row.orgId);
  } catch {}
  console.log('样本 entId =', entId);
  const withQ = [
    ['/api/intelligence/report?entId=', 'entId'],
    ['/api/mrv/activity?entId=', 'entId'],
    ['/api/credit/status?entId=', 'entId'],
    ['/api/settlement/account?entId=', 'entId'],
    ['/api/dynamic/readings?entId=', 'entId'],
  ];
  for (const [p] of withQ) {
    const r = await req('GET', p + entId, T.ent001);
    console.log(`[带参正验] ${p}${entId} @ent001 -> ${r.status} ${r.ms}ms  ${String(r.body).slice(0, 120)}`);
  }
})();
