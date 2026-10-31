/**
 * tools/_probe-dom.mjs —— 在真实页面里执行任意探针表达式（复用 CDP 脚手架）
 *
 *   node tools/_probe-dom.mjs --role REGULATOR --path /reg/overview --file _ui-check/probe.js
 *   node tools/_probe-dom.mjs --role REGULATOR --path /reg/overview --expr "document.body.className"
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
const PORT = 9456;

const ACCOUNTS = {
  ENTERPRISE: { user: 'ent001', pass: '123456' },
  VERIFIER: { user: 'ver001', pass: '123456' },
  REGULATOR: { user: 'reg001', pass: '123456' },
  TRADER: { user: 'trader01', pass: '123456' },
  ADMIN: { user: 'admin', pass: 'admin123' },
};

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const ROLE = (arg('role', 'REGULATOR') || '').toUpperCase();
const PAGE = arg('path', '/reg/overview');
const WAIT = Number(arg('wait', 4000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let EXPR = arg('expr', '');
const FILE = arg('file', '');
if (FILE) EXPR = fs.readFileSync(FILE, 'utf8');
/* 与 platform-audit 的 cdp.json() 同构：探针里允许写 return */
if (argv.includes('--wrap')) EXPR = `(async function(){ ${EXPR} })().then(v=>JSON.stringify(v))`;

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
  send(method, params = {}, timeout = 90000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter.delete(id); rej(new Error(`${method} 超时`)); }, timeout);
      this.waiter.set(id, { res, rej, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeout = 60000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result?.value;
  }
}

function httpJson(p, method = 'GET', body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(`${BASE}${p}`, { method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} },
      (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`${p} 非 JSON`)); } }); });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  if (!EXPR) throw new Error('需要 --expr 或 --file');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_probe_'));
  let child = null;
  try {
    child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`, '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });

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
    const MOBILE = argv.includes('--mobile');
    /* --then-mobile：先按桌面加载、再切到 390 复测，完全复刻 platform-audit
       的"桌面页被 resize 成手机宽"路径（有些问题只在 resize 后出现） */
    const THEN_MOBILE = argv.includes('--then-mobile');
    await cdp.send('Emulation.setDeviceMetricsOverride', MOBILE
      ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
      : { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

    const acc = ACCOUNTS[ROLE];
    const login = await httpJson('/api/auth/login', 'POST', { username: acc.user, password: acc.pass });
    const token = login?.data?.token; const user = login?.data?.user;
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
    await sleep(2200);
    await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${PAGE}` }, 45000);
    await sleep(WAIT);
    if (THEN_MOBILE) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await sleep(900);
    }

    const v = await cdp.eval(EXPR);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  } finally {
    try { child && child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
