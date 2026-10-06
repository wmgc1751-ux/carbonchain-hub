/** scripts/ui-debug.js —— 临时诊断：观察单页在真实浏览器里的渲染状态 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:8300';
const PORT = 9334;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROUTE = process.argv[2] || '/ent/reports';
const ROLE = process.argv[3] || 'ENTERPRISE';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 调试配置目录放系统临时目录，别写进 artifacts/（每个 40~50MB） */
const PROFILE = path.join(os.tmpdir(), 'carbonchain-cdp', 'dbg-' + Date.now());
process.on('exit', () => { try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

const httpJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

async function main() {
  const acc = (await (await fetch(BASE + '/api/auth/demo-accounts')).json()).data;
  const a = acc.find((x) => x.role === ROLE) || acc[0];
  const login = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: a.username, password: a.password }),
  })).json()).data;

  const child = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-proxy-server', 'about:blank',
  ], { stdio: 'ignore' });
  child.unref();

  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(300);
    try { page = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) { }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0; const pend = new Map(); const evts = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) evts.push(m);
  });
  function send(method, params = {}) {
    const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pend.set(id, { res, rej }));
  }
  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
  }

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Console.enable');
  await send('Page.navigate', { url: BASE + '/#/login' });
  await sleep(1500);
  await ev(`localStorage.setItem('cch_token', ${JSON.stringify(login.token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(login.user))}); true`);
  await send('Page.navigate', { url: BASE + '/?_=' + Date.now() + '#' + ROUTE });
  await sleep(4000);

  const out = {};
  out.views = await ev(`Object.keys(App.views)`);
  out.components = await ev(`Object.keys(App.components || {})`);
  out.router = await ev(`({ path: App.Router.path, view: App.Router.view, name: App.Router.name })`);
  out.store = await ev(`({ tokenLen: (App.Store.token||'').length, role: App.Store.user && App.Store.user.role, org: App.Store.user && App.Store.user.orgName })`);
  out.mainHtmlLen = await ev(`(function(){ var m=document.querySelector('.main,.content,.page,.app-main,main'); return m? m.className + ' len=' + m.innerHTML.length : 'NO MAIN NODE'; })()`);
  out.bodyHtml = await ev(`document.body.innerHTML.length`);
  out.mainSnippet = await ev(`(function(){ var m=document.querySelector('.main,.content,.page,.app-main,main'); return m? m.innerHTML.slice(0, 1200) : ''; })()`);
  out.apiTest = await ev(`(async function(){ try { var d = await App.API.get('/enterprise/reports', { page:1, size:5 }); return { ok:true, keys: Object.keys(d), rows: (d.rows||[]).length, total: d.total }; } catch(e){ return { ok:false, err: String(e.message) }; } })()`);
  out.apiOverview = await ev(`(async function(){ try { var d = await App.API.get('/enterprise/overview'); return { ok:true, keys: Object.keys(d).slice(0,20) }; } catch(e){ return { ok:false, err: String(e.message) }; } })()`);
  out.consoleLogs = evts.filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => e.params.type + ': ' + e.params.args.map((x) => x.value || x.description || '').join(' ')).slice(-25);
  out.exceptions = evts.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.text + ' :: ' + ((e.params.exceptionDetails.exception || {}).description || '')).slice(-10);
  out.logEntries = evts.filter((e) => e.method === 'Log.entryAdded').map((e) => e.params.entry.level + ': ' + e.params.entry.text + ' ' + (e.params.entry.url || '')).slice(-20);

  console.log(JSON.stringify(out, null, 2));
  try { ws.close(); } catch (e) { }
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { }
  await sleep(900);
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (!fs.existsSync(PROFILE)) break;
    await sleep(700);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
