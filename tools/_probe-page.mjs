/* 通用单页探针：node tools/_probe-page.mjs <hash路径> [ENT|REG|VER|ADMIN|TRADER]
 * 返回页面标题/文本量/残留 ** 数量，并打印 console 异常 —— 用于逐页文本巡检复核。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:8300';
const PORT = 9469;
const PAGE = process.argv[2] || '/ent/dynamic';
const ROLE = process.argv[3] || 'ENT';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJSON = (p) => new Promise((res, rej) => {
  http.get(p, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-probe-'));
const child = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=' + PORT, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=*', '--no-first-run', '--disable-gpu',
  '--window-size=1440,960', 'about:blank',
], { stdio: 'ignore' });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiter = new Map(); this.events = [];
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.waiter.has(m.id)) { const { res, rej, t } = this.waiter.get(m.id); this.waiter.delete(m.id); clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method === 'Runtime.exceptionThrown') this.events.push('EXC: ' + String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
    }); }
  send(method, params = {}, timeout = 60000) { const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.waiter.delete(id); rej(new Error(method + ' timeout')); }, timeout); this.waiter.set(id, { res, rej, t }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }
}

const ACC = { ENT: ['ent_zjbd', '123456'], REG: ['reg001', '123456'], VER: ['ver001', '123456'], ADMIN: ['admin', 'admin123'], TRADER: ['trader01', '123456'] };

try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) { await sleep(250); try {
    const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
    target = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* retry */ } }
  if (!target) throw new Error('no CDP page target');
  const WebSocket = (await import('ws')).default;
  const cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
  await new Promise((r, j) => { cdp.ws.addEventListener('open', r, { once: true }); cdp.ws.addEventListener('error', () => j(new Error('ws error')), { once: true }); });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const [u, p] = ACC[ROLE] || ACC.ENT;
  const lg = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }).then((r) => r.json());
  await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}a#/login` }, 45000);
  await sleep(1500);
  await cdp.eval(`(function(){localStorage.setItem('cch_token',${JSON.stringify(lg.data.token)});localStorage.setItem('cch_user',${JSON.stringify(JSON.stringify(lg.data.user))});return 1;})()`);
  await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}b#${PAGE}` }, 45000);
  await sleep(7000);
  const st = await cdp.eval(`JSON.stringify({hash:location.hash,title:document.title,len:(document.body.innerText||'').length,star:(document.body.innerText.match(/\\*\\*/g)||[]).length,head:(document.querySelector('.content')||document.body).innerText.replace(/\\n+/g,' | ').slice(0,220)})`);
  console.log('STATE:', st);
  cdp.events.slice(0, 10).forEach((e) => console.log(e));
  if (process.argv[4] === '--full') console.log((await cdp.eval(`(document.querySelector('.content')||document.body).innerText`)));
} finally {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
