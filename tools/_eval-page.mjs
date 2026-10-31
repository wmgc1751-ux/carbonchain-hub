/**
 * tools/_eval-page.mjs —— 在真实浏览器里取页面度量（只读，用于核对排版）
 *   node tools/_eval-page.mjs --path /twin --expr "document.querySelector('.tw-stage').getBoundingClientRect().height"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:8300';
const PORT = 9457;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const PAGE = arg('path', '/twin');
const EXPR = arg('expr', 'document.title');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiter = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.waiter.has(m.id)) { const { res, rej, t } = this.waiter.get(m.id); this.waiter.delete(m.id); clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.waiter.delete(id); rej(new Error(method + ' timeout')); }, timeout); this.waiter.set(id, { res, rej, t }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_eval_'));
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      try {
        const list = await new Promise((res, rej) => { http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(JSON.parse(d))); }).on('error', rej); });
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* wait */ }
    }
    const cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
    await sleep(200);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    const role = arg('role', 'ENT');
    const ACC = { ENT: ['ent_zjbd', '123456'], REG: ['reg001', '123456'], VER: ['ver001', '123456'], ADMIN: ['admin', 'admin123'], TRADER: ['trader01', '123456'] };
    if (ACC[role]) {
      const lg = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ACC[role][0], password: ACC[role][1] }) }).then((r) => r.json());
      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
      await sleep(1500);
      await cdp.eval(`(function(){localStorage.setItem('cch_token',${JSON.stringify(lg.data.token)});localStorage.setItem('cch_user',${JSON.stringify(JSON.stringify(lg.data.user))});return 1;})()`);
    }
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${PAGE}` }, 45000);
    await sleep(Number(arg('wait', '5000')));
    const v = await cdp.eval(EXPR);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
