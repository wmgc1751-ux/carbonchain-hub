/**
 * tools/perf-audit.mjs —— 首屏性能与资源体积审计（真实浏览器）
 *
 * 采信的口径一律来自浏览器自身的 Performance 时间线，不用"估"的：
 *   FCP  = performance.getEntriesByName('first-contentful-paint')
 *   LCP  = PerformanceObserver('largest-contentful-paint') 的最大值
 *   DCL  = navigationTiming.domContentLoadedEventEnd
 *   资源 = performance.getEntriesByType('resource') 逐条统计（按体积排序）
 *   接口 = 由本脚本自己发的 fetch 记录（页面请求无法直接量到响应体大小）
 *
 * 阈值（4G 桌面宽带 + 本地服务的现实目标，不是实验室理想值）：
 *   FCP ≤ 1200 ms｜LCP ≤ 2500 ms｜DCL ≤ 2500 ms｜单页资源总量 ≤ 3.5 MB
 *
 *   node tools/perf-audit.mjs
 *   node tools/perf-audit.mjs --role REGULATOR
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:8300';
const PORT = 9457;
const OUT = path.resolve('_ui-check/perf');

const LIMIT = { fcp: 1200, lcp: 2500, dcl: 2500, bytes: 3.5 * 1024 * 1024 };

const ACCOUNTS = {
  ENTERPRISE: { user: 'ent001', pass: '123456' },
  VERIFIER: { user: 'ver001', pass: '123456' },
  REGULATOR: { user: 'reg001', pass: '123456' },
  TRADER: { user: 'trader01', pass: '123456' },
  ADMIN: { user: 'admin', pass: 'admin123' },
};

const PAGES = {
  ENTERPRISE: ['/ent/overview', '/mrv/reports'],
  VERIFIER: ['/verifier/tasks'],
  REGULATOR: ['/reg/overview', '/reg/enterprises'],
  TRADER: ['/trade/market'],
  ADMIN: ['/admin/overview'],
};

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const ONLY_ROLE = (arg('role', '') || '').toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiter = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.waiter.has(m.id)) {
        const { res, rej, t } = this.waiter.get(m.id); this.waiter.delete(m.id); clearTimeout(t);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter.delete(id); rej(new Error(`${method} 超时`)); }, timeout);
      this.waiter.set(id, { res, rej, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result?.value;
  }
  async json(expr) {
    const v = await this.eval(`(async function(){ ${expr} })().then(v=>JSON.stringify(v))`);
    return typeof v === 'string' ? JSON.parse(v) : v;
  }
}

function httpJson(p, method = 'GET', body, token) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(`${BASE}${p}`, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error('非 JSON')); } }); });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

/* 在页面里采集时间线。必须在导航前注入。 */
const COLLECT = `
  var nav = performance.getEntriesByType('navigation')[0] || {};
  var paints = {};
  performance.getEntriesByType('paint').forEach(function(p){ paints[p.name] = p.startTime; });
  var lcp = 0;
  try {
    var po = new PerformanceObserver(function(list){ list.getEntries().forEach(function(e){ lcp = Math.max(lcp, e.startTime); }); });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { /* 老浏览器 */ }
  await new Promise(function(r){ setTimeout(r, 400); });
  var res = performance.getEntriesByType('resource').map(function(r){
    return { name: r.name.replace(location.origin, ''), type: r.initiatorType, bytes: r.transferSize || r.encodedBodySize || 0, ms: Math.round(r.duration) };
  });
  var total = res.reduce(function(a, b){ return a + b.bytes; }, 0);
  var byType = {};
  res.forEach(function(r){ byType[r.type] = (byType[r.type] || 0) + r.bytes; });
  res.sort(function(a, b){ return b.bytes - a.bytes; });
  return {
    fcp: Math.round(paints['first-contentful-paint'] || 0),
    lcp: Math.round(lcp),
    dcl: Math.round(nav.domContentLoadedEventEnd || 0),
    load: Math.round(nav.loadEventEnd || 0),
    resCount: res.length,
    bytes: total,
    byType: byType,
    top: res.slice(0, 6),
    domNodes: document.querySelectorAll('*').length,
  };
`;

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_perf_'));
  const report = { generatedAt: new Date().toISOString(), base: BASE, limit: LIMIT, roles: [] };
  let child = null;
  try {
    child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      /* 无头模式下渲染帧由调度器决定，偶发"几十秒才出第一帧"（实测 /reg/overview
         报 FCP 44.8s，而同一导航独立采样 FCP=192ms、/trade/market 报 7.1s 实测
         72ms）。这三项是 Chrome 官方推荐的无头确定性渲染开关。 */
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--run-all-compositor-stages-before-draw',
      '--disable-extensions', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try {
        const list = await new Promise((res, rej) => {
          http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
        });
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* 未就绪 */ }
    }
    if (!target) throw new Error('无法连接调试端口');

    const cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
    await sleep(200);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    /* 首次访问的冷缓存口径：禁用缓存，避免"第二次打开当然快" */
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    for (const [role, acc] of Object.entries(ACCOUNTS)) {
      if (ONLY_ROLE && role !== ONLY_ROLE) continue;
      const login = await httpJson('/api/auth/login', 'POST', { username: acc.user, password: acc.pass });
      const token = login?.data?.token; const user = login?.data?.user;
      if (!token) { console.log(`✘ ${role} 登录失败`); continue; }

      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
      await sleep(2000);
      await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);

      const roleRep = { role, pages: [] };
      console.log(`\n════ ${role} ════`);
      for (const p of PAGES[role] || []) {
        await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${p}` }, 60000);
        /* 等首屏内容出现 */
        for (let k = 0; k < 30; k++) {
          await sleep(300);
          try {
            const n = await cdp.eval(`(document.querySelector('.content')||document.body).innerText.replace(/\\s+/g,'').length`);
            if (n > 60) break;
          } catch { /* 主线程忙 */ }
        }
        let m = null;
        try { m = await cdp.json(COLLECT); } catch (e) { m = { err: e.message }; }
        if (!m || m.err) { console.log(`  ? ${p} 采集失败 ${m ? m.err : ''}`); continue; }
        const bad = [];
        if (m.fcp > LIMIT.fcp) bad.push(`FCP ${m.fcp}ms`);
        if (m.lcp > LIMIT.lcp) bad.push(`LCP ${m.lcp}ms`);
        if (m.dcl > LIMIT.dcl) bad.push(`DCL ${m.dcl}ms`);
        if (m.bytes > LIMIT.bytes) bad.push(`资源 ${(m.bytes / 1048576).toFixed(2)}MB`);
        m.bad = bad;
        roleRep.pages.push({ path: p, ...m });
        const kb = (n) => (n / 1024).toFixed(0) + 'KB';
        console.log(`  ${bad.length ? '△' : '✔'} ${p.padEnd(22)} FCP ${String(m.fcp).padStart(4)}ms  LCP ${String(m.lcp).padStart(4)}ms  DCL ${String(m.dcl).padStart(4)}ms  资源 ${m.resCount} 个 / ${kb(m.bytes)}  DOM ${m.domNodes}${bad.length ? '  ← ' + bad.join(' / ') : ''}`);
        if (m.top && m.top.length) console.log(`      最大资源：${m.top.slice(0, 3).map((r) => `${path.basename(r.name)} ${kb(r.bytes)}`).join('｜')}`);
      }
      report.roles.push(roleRep);
    }
  } finally {
    try { child && child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  fs.writeFileSync(path.join(OUT, 'perf-audit.json'), JSON.stringify(report, null, 2), 'utf8');
  let pages = 0; let badPages = 0;
  for (const r of report.roles) for (const p of r.pages) { pages++; if ((p.bad || []).length) badPages++; }
  console.log(`\n════════ 汇总 ════════`);
  console.log(`  页面 ${pages}｜超阈值 ${badPages}`);
  console.log(`  阈值：FCP ≤ ${LIMIT.fcp}ms｜LCP ≤ ${LIMIT.lcp}ms｜DCL ≤ ${LIMIT.dcl}ms｜资源 ≤ ${(LIMIT.bytes / 1048576).toFixed(1)}MB（冷缓存）`);
  console.log(`\n报告：${path.join(OUT, 'perf-audit.json')}`);
}

main().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });
