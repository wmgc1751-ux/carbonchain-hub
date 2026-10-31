#!/usr/bin/env node
/* tools/_qa/live-sweep.cjs —— 五角色 × 全部 GET 路由 实测矩阵
 * 目的：真实企业接入前的使用级体检。verify:all 证明"逻辑对"，本脚本证明"每个角色
 * 点每个页面背后的接口都拿得到数据"。只读（GET），不写库。
 * 判定：200+code0=OK；401/403=AUTH（预期内的角色隔离）；5xx/其他4xx/code!=0=异常。
 * 输出：控制台异常清单 + tools/out/live-sweep.json
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1', PORT = 8300;
const ROOT = path.join(__dirname, '..', '..');
const ROUTES_DIR = path.join(ROOT, 'server', 'routes');

const ACCOUNTS = [
  ['admin', 'admin123'],
  ['reg001', '123456'],
  ['ent001', '123456'],
  ['ver001', '123456'],
  ['trader01', '123456'],
];

function req(method, p, token) {
  // 硬护栏：流式接口（copilot/telemetry 等）可能永不下发结束帧，
  // 25 秒墙钟强制返回，避免整场扫描被一条路由卡死。
  return Promise.race([
    reqOnce(method, p, token),
    new Promise((resolve) => setTimeout(() => resolve({ status: 0, body: 'hard-timeout-25s' }), 25000)),
  ]);
}

function reqOnce(method, p, token) {
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers, timeout: 20000 },
      (resp) => {
        let s = '';
        resp.on('data', (c) => (s += c));
        resp.on('end', () => {
          let body;
          try { body = JSON.parse(s); } catch { body = s.slice(0, 200); }
          resolve({ status: resp.statusCode, body });
        });
      });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.end();
  });
}

/* ---- 1. 从源码解析全部 GET 路由（含挂载前缀） ---- */
function parseRoutes() {
  const appJs = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
  const mounts = [...appJs.matchAll(/app\.use\('([^']+)',\s*require\('\.\/routes\/(\w+)'\)\)/g)]
    .map((m) => ({ prefix: m[1], file: m[2] }));
  const routes = [];
  for (const { prefix, file } of mounts) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, file + '.js'), 'utf8');
    for (const m of src.matchAll(/router\.get\(\s*'([^']*)'/g)) {
      const sub = m[1];
      const full = (prefix.replace(/\/$/, '') + (sub === '/' ? '' : sub));
      if (full.includes(':')) continue; // 参数路由单独抽样
      routes.push({ mount: prefix, sub, full, file });
    }
  }
  return routes;
}

/* ---- 2. 登录拿 token ---- */
async function login() {
  const tokens = {};
  for (const [u, p] of ACCOUNTS) {
    const r = await req('POST', '/api/auth/login', null);
    const r2 = await new Promise((resolve) => {
      const d = JSON.stringify({ username: u, password: p });
      const rq = http.request({ host: HOST, port: PORT, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
        (resp) => { let s = ''; resp.on('data', (c) => (s += c)); resp.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } }); });
      rq.on('error', () => resolve({}));
      rq.write(d); rq.end();
    });
    const t = r2 && r2.data && r2.data.token;
    if (!t) { console.error(`登录失败: ${u} -> ${JSON.stringify(r2).slice(0, 120)}`); process.exit(2); }
    tokens[u] = t;
  }
  return tokens;
}

function isEmptyData(body) {
  if (!body || typeof body !== 'object') return false;
  const d = body.data;
  if (d === null || d === undefined) return false; // 有些接口 data 为 null 是正常（如单查无结果）
  if (Array.isArray(d)) return d.length === 0;
  if (typeof d === 'object') {
    if (d.rows && Array.isArray(d.rows)) return d.rows.length === 0;
    if (d.items && Array.isArray(d.items)) return d.items.length === 0;
  }
  return false;
}

(async () => {
  const routes = parseRoutes();
  console.log(`解析到 GET 路由（无参数）: ${routes.length} 条，开始登录…`);
  const tokens = await login();
  console.log('5 角色登录成功，开始扫描…\n');

  const results = [];
  const anomalies = [];
  let n = 0;
  const jobs = [];
  for (const rt of routes) jobs.push(rt);
  const CONC = 4;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const rt = jobs[idx++];
      const perRole = {};
      const roleRuns = ACCOUNTS.map(async ([u]) => {
        const r = await req('GET', rt.full, tokens[u]);
        let cls;
        if (r.status === 200) {
          const code = r.body && typeof r.body === 'object' ? r.body.code : undefined;
          if (code === undefined || code === 0) {
            cls = isEmptyData(r.body) ? 'EMPTY' : 'OK';
          } else cls = 'CODE_' + code;
        } else if (r.status === 401 || r.status === 403) cls = 'AUTH';
        else if (r.status === 0) cls = 'CONN';
        else cls = 'HTTP_' + r.status;
        perRole[u] = { status: r.status, cls };
        if (['HTTP_500', 'HTTP_400', 'HTTP_404', 'HTTP_501', 'HTTP_502', 'HTTP_503', 'CONN'].includes(cls)
            || (typeof cls === 'string' && cls.startsWith('CODE_'))) {
          anomalies.push({ route: rt.full, role: u, status: r.status, cls,
            body: JSON.stringify(r.body).slice(0, 220) });
        }
      });
      await Promise.all(roleRuns);
      const allAuth = Object.values(perRole).length === ACCOUNTS.length
        && Object.values(perRole).every((x) => x.cls === 'AUTH');
      if (allAuth) anomalies.push({ route: rt.full, role: '*', status: '-', cls: 'ALL_AUTH',
        body: '所有角色均 401/403 —— 疑似死接口' });
      const allEmpty = Object.values(perRole).length === ACCOUNTS.length
        && Object.values(perRole).every((x) => x.cls === 'EMPTY');
      if (allEmpty) anomalies.push({ route: rt.full, role: '*', status: '-', cls: 'ALL_EMPTY',
        body: '所有角色均空数据（可能正常，需人工判断）' });
      results.push({ route: rt.full, file: rt.file, perRole });
      n++;
      if (n % 10 === 0) console.log(`  … ${n}/${routes.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const okCount = results.filter((r) => Object.values(r.perRole).some((x) => x.cls === 'OK')).length;
  console.log(`\n══ 扫描完成：${results.length} 条路由 ══`);
  console.log(`至少一个角色可用: ${okCount} · 异常条目: ${anomalies.length}`);

  const byCls = {};
  for (const a of anomalies) byCls[a.cls] = (byCls[a.cls] || 0) + 1;
  console.log('异常分类:', JSON.stringify(byCls));
  const real = anomalies.filter((a) => !['ALL_EMPTY'].includes(a.cls));
  for (const a of real.slice(0, 60)) console.log(`  [${a.cls}] ${a.route}  ${a.role}  ${a.body.slice(0, 150)}`);

  const out = path.join(ROOT, 'tools', 'out', 'live-sweep.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), total: results.length, okCount, anomalies, results }, null, 2));
  console.log('已写出:', out);
})();
