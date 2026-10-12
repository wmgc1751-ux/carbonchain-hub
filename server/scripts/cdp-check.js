/**
 * cdp-check.js —— 碳链通 5 角色前端巡检（零依赖，Edge + CDP）
 * 验证：交易端 / 管理端 / 企业端预警中心 / 监管端交易监管 等新增页面渲染正常
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.APP_BASE || 'http://127.0.0.1:8300';
const PORT = Number(process.env.CDP_PORT || 9333);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(process.cwd(), '_ui-check');
const SHOT = path.join(OUT, 'screens');
const W = 1680, H = 1050;

/* 通过 API 登录拿 token */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpReq(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: 8300, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
    }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; });
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}
async function login(username, password) {
  const r = await httpReq('POST', '/api/auth/login', { username, password });
  return r && r.data ? { token: r.data.token, user: r.data.user } : null;
}

const httpJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.onEvent = null;
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else if (m.method && this.onEvent) this.onEvent(m); }); }
  send(method, params = {}) { const id = ++this.seq; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 30000); }); }
  async evaluate(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined; }
}

const INIT = `window.__logs = []; (function(){
  var oe = console.error;
  console.error = function(){ window.__logs.push({lvl:'error', msg: Array.prototype.map.call(arguments,String).join(' ')}); oe.apply(console, arguments); };
  window.addEventListener('error', function(e){ var t = e.target && e.target.tagName;
    if (t && t !== 'SCRIPT' && t !== 'IMG' && t !== 'LINK') window.__logs.push({lvl:'uncaught', msg: String(e.message)+' @ '+e.filename+':'+e.lineno});
    else if (t) window.__logs.push({lvl:'resource', msg: t+' 加载失败: '+(e.target.src||e.target.href)}); }, true);
  window.addEventListener('unhandledrejection', function(e){ window.__logs.push({lvl:'unhandledRejection', msg: String(e.reason&&e.reason.message||e.reason)}); }); })();`;

const PROBE = `(function(){
  var app = document.getElementById('app') || document.body;
  var txt = (app.innerText || '').replace(/\\s+/g,' ').trim();
  var logs = (window.__logs || []).filter(function(x){ return x.lvl !== 'warn'; });
  return {
    booting: !!document.querySelector('.boot,.loading,.spinner'),
    textLen: txt.length, head: txt.slice(0, 80),
    tables: document.querySelectorAll('table').length,
    rows: document.querySelectorAll('tbody tr').length,
    charts: document.querySelectorAll('canvas').length,
    unresolved: Array.prototype.filter.call(document.querySelectorAll('*'), function(n){ return n.tagName && n.tagName.indexOf('X-') === 0; })
      .map(function(n){ return n.tagName.toLowerCase(); }).filter(function(v,i,a){ return a.indexOf(v)===i; }),
    logs: logs.slice(0, 8)
  };
})()`;

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });

  // 登录拿 token
  const accounts = [
    { role: '交易端', user: 'trader01', pass: '123456', routes: [['/trade/market', 'T1市场行情'], ['/trade/orders', 'T2交易下单'], ['/trade/account', 'T3我的账户'], ['/trade/deals', 'T4交易记录'], ['/trade/offset', 'T5抵销清缴']] },
    { role: '管理端', user: 'admin', pass: 'admin123', routes: [['/admin/overview', 'A1管理总览'], ['/admin/factors', 'A2因子库'], ['/admin/users', 'A3用户权限'], ['/admin/reconcile', 'A4对账中心']] },
    { role: '企业端', user: 'ent001', pass: '123456', routes: [['/ent/predict', 'E6预警中心']] },
    { role: '监管端', user: 'reg001', pass: '123456', routes: [['/reg/trades', '交易监管']] },
  ];
  const sessions = {};
  for (const a of accounts) { const s = await login(a.user, a.pass); sessions[a.role] = s; console.log(`登录 ${a.user}(${a.role}) => ${s ? 'OK' : 'FAIL'}`); }

  // 启动 Edge
  try { const busy = await new Promise((resolve) => { const ps = spawn('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`], { stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; ps.stdout.on('data', (d) => { out += d; }); ps.on('close', () => resolve(out.trim())); }); for (const pid of busy.split(/\s+/).filter(Boolean)) { spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); await sleep(700); } } catch (e) {}

  const profile = path.join(OUT, '.edge-' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-proxy-server', '--proxy-bypass-list=*', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  child.unref();
  let target = null;
  for (let i = 0; i < 80 && !target; i++) { await sleep(300); try { target = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) {} }
  if (!target) throw new Error('连接不上 Edge 调试端口');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws error'))); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/#/login` });
  for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await cdp.evaluate('location.origin')).indexOf('http') === 0) break; } catch (e) {} }

  const results = [];
  let n = 0;
  for (const a of accounts) {
    const s = sessions[a.role];
    await cdp.evaluate(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(s.token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(s.user))}); return true; })()`);
    for (const [route, label] of a.routes) {
      n++;
      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${route}` });
      let probe = null; const t0 = Date.now();
      while (Date.now() - t0 < 15000) { await sleep(260); try { probe = await cdp.evaluate(PROBE); } catch (e) { continue; } if (probe && !probe.booting && probe.textLen > 40) break; }
      await sleep(1200);
      const metrics = await cdp.send('Page.getLayoutMetrics'); const size = metrics.cssContentSize || metrics.contentSize;
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.max(size.width, W), height: Math.min(Math.max(size.height, 800), 5200), scale: 1 } });
      fs.writeFileSync(path.join(SHOT, `${String(n).padStart(2, '0')}-${a.role}-${label}.png`), Buffer.from(shot.data, 'base64'));
      const pass = probe && !probe.booting && probe.textLen > 40 && probe.unresolved.length === 0;
      results.push({ role: a.role, route, label, pass, textLen: probe ? probe.textLen : 0, rows: probe ? probe.rows : 0, charts: probe ? probe.charts : 0, unresolved: probe ? probe.unresolved : [], logs: probe ? probe.logs : [] });
      console.log(`${pass ? 'PASS' : 'FAIL'}  [${a.role}] ${route}(${label})  text=${probe ? probe.textLen : '-'} rows=${probe ? probe.rows : '-'} charts=${probe ? probe.charts : '-'} unresolved=${probe ? probe.unresolved.join(',') : '-'}`);
      if (probe && probe.logs.length) probe.logs.forEach((l) => console.log(`      [${l.lvl}] ${l.msg}`.slice(0, 180)));
    }
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2), 'utf8');
  const okN = results.filter((r) => r.pass).length;
  console.log(`\n===== ${okN}/${results.length} 通过，截图在 _ui-check/screens/ =====`);
  try { ws.close(); } catch (e) {}
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }, 1500);
  process.exit(okN === results.length ? 0 : 1);
}

main().catch((e) => { console.error('巡检失败：', e && e.stack || e); process.exit(1); });
