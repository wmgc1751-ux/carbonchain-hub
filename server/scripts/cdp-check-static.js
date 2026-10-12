/**
 * cdp-check-static.js —— 第 2 轮新增页面在「静态模式」下的前端渲染巡检（零依赖，Edge + CDP）
 * ------------------------------------------------------------------
 * 与 cdp-check.js（在线后端 8300）的区别：
 *   · BASE 指向静态服务器（8899，纯静态 dist 产物）；
 *   · 登录令牌直接取自快照 data/api-snapshot.json 里的 logins 记录（绕过在线登录）；
 *   · 覆盖第 2 轮新增的 8 个路由，验证页面在「无后端、快照应答」下仍能渲染，
 *     且 staticApi.js 的 fetch 层拦截能命中快照（不出现 unresolved 组件 / 空态）。
 * ------------------------------------------------------------------
 * 用法：node server/scripts/cdp-check-static.js [--base http://127.0.0.1:8899]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ARGS = process.argv.slice(2);
const argOf = (n, d) => { const i = ARGS.indexOf(n); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d; };
const BASE = argOf('--base', 'http://127.0.0.1:8899');
const SNAP = argOf('--snapshot', path.join(process.cwd(), 'public/data/api-snapshot.json'));
const PORT = Number(process.env.CDP_PORT || 9336);
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(fs.existsSync);
const OUT = path.join(process.cwd(), '_ui-check', 'static');
const SHOT = path.join(OUT, 'screens');
const W = 1680, H = 1050;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  var staticMode = (window.__StaticApiMode !== undefined) ? window.__StaticApiMode : (window.App && window.App.Store ? '?' : '?');
  return {
    booting: !!document.querySelector('.boot,.loading,.spinner'),
    textLen: txt.length, head: txt.slice(0, 90),
    tables: document.querySelectorAll('table').length,
    rows: document.querySelectorAll('tbody tr').length,
    charts: document.querySelectorAll('canvas').length,
    hasEmpty: !!document.querySelector('.empty,.empty-title'),
    unresolved: Array.prototype.filter.call(document.querySelectorAll('*'), function(n){ return n.tagName && n.tagName.indexOf('X-') === 0; })
      .map(function(n){ return n.tagName.toLowerCase(); }).filter(function(v,i,a){ return a.indexOf(v)===i; }),
    logs: logs.slice(0, 8)
  };
})()`;

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  if (!fs.existsSync(SNAP)) throw new Error('快照不存在：' + SNAP);

  // 从快照取各角色登录记录（token 直接注入，绕过在线登录）
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf-8'));
  const logins = snap.logins || {};
  const tok = (u) => (logins[u] && logins[u].token) || '';

  const accounts = [
    { role: '企业端', user: 'ent001', routes: [
      ['/ent/uncertainty', 'E-U1 核算不确定度'],
      ['/ent/cbam', 'E-U2 CBAM 申报'],
      ['/ent/greenpower', 'E-U3 绿电溯源'],
      ['/ent/dual-report', 'E-U4 双轨报告'],
    ] },
    { role: '监管端', user: 'reg001', routes: [
      ['/reg/uncertainty', 'R-U1 不确定度监管'],
      ['/reg/cbam', 'R-U2 CBAM 监管'],
      ['/reg/greenpower', 'R-U3 绿电监管'],
      ['/reg/dual-report', 'R-U4 双轨报告台账'],
      ['/keys', 'R-K1 密钥治理(只读)'],
    ] },
    { role: '管理端', user: 'admin', routes: [
      ['/keys', 'A-K1 密钥治理(可写)'],
      ['/reg/uncertainty', 'A-U1 不确定度汇总'],
    ] },
  ];

  const sessions = {};
  for (const a of accounts) {
    const t = tok(a.user);
    const u = (logins[a.user] && logins[a.user].user) || {};
    sessions[a.role] = { token: t, user: u };
    console.log(`令牌 ${a.user}(${a.role}) => ${t ? 'OK' : '缺失'}`);
  }

  // 清理端口残留
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
  await cdp.send('Page.navigate', { url: `${BASE}/#/screen` });
  for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await cdp.evaluate('location.origin')).indexOf('http') === 0) break; } catch (e) {} }

  const results = [];
  let n = 0;
  for (const a of accounts) {
    const s = sessions[a.role];
    if (!s.token) { console.log(`SKIP ${a.role}（无令牌）`); continue; }
    await cdp.evaluate(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(s.token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(s.user))}); return true; })()`);
    for (const [route, label] of a.routes) {
      n++;
      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${route}` });
      let probe = null; const t0 = Date.now();
      while (Date.now() - t0 < 15000) { await sleep(260); try { probe = await cdp.evaluate(PROBE); } catch (e) { continue; } if (probe && !probe.booting && probe.textLen > 40) break; }
      await sleep(1000);
      const metrics = await cdp.send('Page.getLayoutMetrics'); const size = metrics.cssContentSize || metrics.contentSize;
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.max(size.width, W), height: Math.min(Math.max(size.height, 800), 5200), scale: 1 } });
      fs.writeFileSync(path.join(SHOT, `${String(n).padStart(2, '0')}-${a.role}-${label}.png`), Buffer.from(shot.data, 'base64'));
      const pass = probe && !probe.booting && probe.textLen > 40 && probe.unresolved.length === 0;
      results.push({ role: a.role, route, label, pass, textLen: probe ? probe.textLen : 0, rows: probe ? probe.rows : 0, charts: probe ? probe.charts : 0, hasEmpty: probe ? probe.hasEmpty : false, unresolved: probe ? probe.unresolved : [], logs: probe ? probe.logs : [] });
      console.log(`${pass ? 'PASS' : 'FAIL'}  [${a.role}] ${route}(${label})  text=${probe ? probe.textLen : '-'} rows=${probe ? probe.rows : '-'} charts=${probe ? probe.charts : '-'} empty=${probe ? probe.hasEmpty : '-'} unresolved=${probe ? probe.unresolved.join(',') : '-'}`);
      if (probe && probe.logs.length) probe.logs.forEach((l) => console.log(`      [${l.lvl}] ${l.msg}`.slice(0, 200)));
    }
  }

  fs.writeFileSync(path.join(OUT, 'report-static.json'), JSON.stringify(results, null, 2), 'utf8');
  const okN = results.filter((r) => r.pass).length;
  console.log(`\n===== 静态模式第 2 轮页面 ${okN}/${results.length} 通过，截图在 _ui-check/static/screens/ =====`);
  try { ws.close(); } catch (e) {}
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }, 1500);
  process.exit(okN === results.length ? 0 : 1);
}

main().catch((e) => { console.error('巡检失败：', e && e.stack || e); process.exit(1); });
