/**
 * diag-static.mjs —— 静态站诊断：看 StaticApi 到底匹配到了什么
 * 用法：node tools/diag-static.mjs --base https://www.carbonchain.dpdns.org --route /real/facilities
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ARGV = process.argv.slice(2);
const argOf = (n, d) => {
  /* 同时支持 --k v 与 --k=v 两种写法。
   * 【为什么必须支持 --k=v】Windows 的 Git Bash（MSYS）会把形如 /real/facilities
   * 的命令行参数当成 POSIX 绝对路径，自动改写成 D:/WorkBuddy/.../real/facilities。
   * 结果被测页面收到一个垃圾 hash，回落 404 再被守卫踢回登录页 ——
   * 看起来像应用缺陷，实际是测试脚本被 shell 改了参数。
   * 用 --k=v 形式（赋值不经过独立 argv 元素）可以完全避开这次改写。 */
  const eq = ARGV.find((a) => a.startsWith(n + '='));
  if (eq) return eq.slice(n.length + 1);
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d;
};
const BASE = argOf('--base', 'http://127.0.0.1:8899');
const ROUTE = argOf('--route', '/real/facilities');
const PORT = Number(argOf('--cdp-port', '9401'));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws'))); });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval');
    return r.result && r.result.value;
  }
}

const profile = path.join(process.cwd(), '_ui-check', '.edge-diag-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
  '--hide-scrollbars', '--mute-audio', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
child.unref();

let target = null;
for (let i = 0; i < 80 && !target; i++) { await sleep(300); try { target = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch {} }
if (!target) { console.error('连不上 Edge'); process.exit(1); }

const cdp = await CDP.connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
const logs = [];
cdp.ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const t = (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
    logs.push(`[${m.params.type}] ${t}`.slice(0, 300));
  }
  if (m.method === 'Network.responseReceived') { var r=m.params.response; if (r && r.status !== 200) logs.push('[net '+r.status+'] '+r.url.slice(0,160)); }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text || '').slice(0, 300));
  }
});

await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${ROUTE}` });
await sleep(9000);

const st = await cdp.evaluate('(function(){ try{ return window.App && App.StaticApi ? App.StaticApi.status() : "no StaticApi"; }catch(e){ return "ERR "+e.message; } })()');
console.log('StaticApi.status():', JSON.stringify(st, null, 1));

const probe = await cdp.evaluate(`(async function(){
  var out = {};
  try {
    var r = await fetch('./api/real/facilities?sort=emission&order=DESC&page=1&size=20');
    var txt = await r.text();
    out.status = r.status;
    out.ct = r.headers.get('content-type');
    out.len = txt.length;
    out.code = (function(){ try { return JSON.parse(txt).code; } catch(e){ return 'not-json: '+txt.slice(0,60); } })();
    out.rows = (function(){ try { var j=JSON.parse(txt); return (j.data||[]).length; } catch(e){ return null; } })();
  } catch(e) { out.err = e.message; }
  try {
    var r2 = await App.API.getEnvelope('/real/facilities', { sort:'emission', order:'DESC', page:1, size:20 });
    out.envTotal = r2.meta ? r2.meta.total : null;
    out.envRows = (r2.data||[]).length;
  } catch(e) { out.envErr = e.message; }
  return out;
})()`);
console.log('直连探针:', JSON.stringify(probe, null, 1));

const dom = await cdp.evaluate(`(function(){
  var pages = document.querySelectorAll('.page');
  var tbs = document.querySelectorAll('tbody');
  var body = document.body.innerText || '';
  return { pageCount: pages.length, tbodyCount: tbs.length,
           rows: document.querySelectorAll('tbody tr').length,
           bodyLen: body.length,
           hasNoMatch: body.indexOf('没有符合条件') >= 0,
           hasLoading: body.indexOf('查询中') >= 0,
           tail: body.slice(-400).replace(/\\s+/g,' ') };
})()`);
console.log('DOM:', JSON.stringify(dom, null, 1));

const rt = await cdp.evaluate(`(function(){ try { return { hash: location.hash, path: App.Router.path, view: String(App.Router.view), name: App.Router.name, user: App.Store.user ? App.Store.user.role : null, hasView: !!App.views[App.Router.view] }; } catch(e) { return 'ERR '+e.message; } })()`);
console.log('路由状态:', JSON.stringify(rt, null, 1));
const ra = await cdp.evaluate(`(function(){ try { var ra=App.routeAccess; return { open: ra.OPEN_ROUTES, canEnterNull: ra.canEnter(null, "/real/facilities"), canEnterReal: ra.canEnter(null, "/real") }; } catch(e){ return "ERR "+e.message; } })()`);
console.log("白名单:", JSON.stringify(ra));
console.log('\n控制台（末 25 条）:');
logs.slice(-25).forEach((l) => console.log('  ' + l));

try { child.kill('SIGKILL'); } catch {}
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 800);
process.exit(0);
