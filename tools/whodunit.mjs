/**
 * whodunit.mjs —— 定位"冷加载某路由后 hash 变成 #/login"的元凶
 * 用法：node tools/whodunit.mjs --base http://127.0.0.1:8899 --route /real/facilities
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
const PORT = Number(argOf('--cdp-port', '9411'));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws'))); });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        c.logs.push(`[${m.params.type}] ` + (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ').slice(0, 260));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        c.logs.push('[exception] ' + String((d.exception && d.exception.description) || d.text || '').slice(0, 300));
      } else if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        if (r && r.status >= 400) c.logs.push(`[net ${r.status}] ${String(r.url).slice(0, 150)}`);
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

/* 注入探针：拦截 App.go / location.hash 赋值，记录调用栈 */
const PROBE = `
(function(){
  window.__GO__ = [];
  var origGo = null;
  var t = setInterval(function(){
    if (!window.App || !App.go || origGo) return;
    origGo = App.go;
    App.go = function(p){
      try { window.__GO__.push({ to: p, stack: String((new Error()).stack || '').split('\\n').slice(1, 8).join(' | ') }); } catch(e){}
      return origGo.apply(this, arguments);
    };
    clearInterval(t);
  }, 4);
  window.__HASHES__ = [];
  var t2 = setInterval(function(){
    if (!window.App || !App.Router) return;
    clearInterval(t2);
    try {
      var origResolve = App.resolve;
      App.resolve = function(){
        window.__HASHES__.push({ hash: location.hash, t: Date.now() });
        return origResolve.apply(this, arguments);
      };
    } catch(e){}
  }, 4);
})();
`;

const profile = path.join(process.cwd(), '_ui-check', '.edge-who-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
  '--hide-scrollbars', '--mute-audio', '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
child.unref();

let target = null;
for (let i = 0; i < 80 && !target; i++) { await sleep(300); try { target = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch {} }
if (!target) { console.error('连不上 Edge'); process.exit(1); }

const cdp = await CDP.connect(target.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

const url = `${BASE}/?_=${Date.now()}#${ROUTE}`;
console.log('导航到:', url);
await cdp.send('Page.navigate', { url });
await sleep(9000);

const goLog = await cdp.evaluate('window.__GO__ || []');
const hashLog = await cdp.evaluate('window.__HASHES__ || []');
const state = await cdp.evaluate(`(function(){
  try { return { hash: location.hash, path: App.Router.path, view: String(App.Router.view),
                 user: App.Store.user ? App.Store.user.role : null,
                 routes: App.routeAccess.ROUTES.filter(function(r){ return r[0].indexOf('/real') === 0; }) }; }
  catch(e) { return String(e.message); } })()`);

console.log('\n最终状态:', JSON.stringify(state, null, 1));
console.log('\nApp.go 调用记录:');
if (Array.isArray(goLog) && goLog.length) goLog.forEach((g, i) => console.log(`  ${i + 1}. → ${g.to}\n     ${g.stack}`));
else console.log('  （无）');
console.log('\nresolve 记录:', JSON.stringify(hashLog));

console.log('\n控制台 / 网络异常:');
cdp.logs.slice(-30).forEach((l) => console.log('  ' + l));

try { child.kill('SIGKILL'); } catch {}
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 800);
process.exit(0);
