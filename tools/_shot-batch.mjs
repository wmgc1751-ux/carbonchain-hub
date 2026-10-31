/**
 * tools/_shot-batch.mjs —— 一次启动浏览器，连续截多张桌面图（巡检复核用）
 *
 *   node tools/_shot-batch.mjs --role ENT --pages /cems,/ops,/ent/analytics
 *
 * 与 _shot.mjs 的区别：只起一次 Edge、只登录一次，逐页切 hash 截图，
 * 避免为每页重复付 3~4 秒启动与登录成本（一次复核要覆盖二十多页）。
 * 输出：_ui-check/shots/<name>.png
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
const OUT = path.resolve('_ui-check/shots');

/* 演示账号已改为四家真实企业的岗位账号，ent_zjbd 是企业端主账号 */
const ACCOUNTS = {
  ENT: { user: 'ent_zjbd', pass: '123456' },
  VER: { user: 'ver001', pass: '123456' },
  REG: { user: 'reg001', pass: '123456' },
  TRADER: { user: 'trader01', pass: '123456' },
  ADMIN: { user: 'admin', pass: 'admin123' },
  NONE: null,
};

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const ROLE = (arg('role', 'REG') || '').toUpperCase();
const PAGES = (arg('pages', '/reg/overview') || '').split(',').map((s) => s.trim()).filter(Boolean);
const PREFIX = arg('prefix', ROLE.toLowerCase());
const EVAL = arg('eval', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiter = new Map(); this.ev = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.waiter.has(m.id)) {
        const { res, rej, t } = this.waiter.get(m.id); this.waiter.delete(m.id); clearTimeout(t);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method && this.ev.has(m.method)) {
        for (const f of this.ev.get(m.method)) { try { f(m.params); } catch { /* 忽略 */ } }
      }
    });
  }
  on(m, f) { if (!this.ev.has(m)) this.ev.set(m, []); this.ev.get(m).push(f); }
  send(method, params = {}, timeout = 90000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter.delete(id); rej(new Error(`${method} 超时 ${timeout}ms`)); }, timeout);
      this.waiter.set(id, { res, rej, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeout = 45000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result?.value;
  }
}

function httpJson(p, method = 'GET', body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(`${BASE}${p}`, {
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`${p} 非 JSON`)); } }); });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

async function shoot(cdp, file, w) {
  const m = await cdp.send('Page.getLayoutMetrics');
  const cs = m.cssContentSize || m.contentSize || { width: w, height: 960 };
  const full = Math.min(Math.ceil(cs.height || 960), 5200);
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.max(w, Math.ceil(cs.width || w)), height: full, scale: 1 },
  }, 60000);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return { bytes: fs.statSync(file).size, w: Math.max(w, Math.ceil(cs.width || w)), h: full };
}

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_batch_'));
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

    const acc = ACCOUNTS[ROLE];
    if (acc) {
      const login = await httpJson('/api/auth/login', 'POST', { username: acc.user, password: acc.pass });
      const token = login?.data?.token; const user = login?.data?.user;
      if (!token) throw new Error('登录失败：' + acc.user);
      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
      await sleep(1800);
      await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);
    }

    for (const p of PAGES) {
      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${p}` }, 45000);
      await sleep(Number(arg('wait', '4200')));
      if (EVAL) {
        try {
          const v = await cdp.eval(EVAL);
          console.log(`[${p}] ${typeof v === 'string' ? v : JSON.stringify(v)}`);
        } catch (e) { console.log(`[${p}] !! ${e.message}`); }
        continue;
      }
      const name = `${PREFIX}${p.replace(/[^\w]+/g, '_')}`;
      try {
        const r = await shoot(cdp, path.join(OUT, `${name}.png`), 1440);
        console.log(`${p}  ->  ${name}.png  ${r.w}x${r.h}  ${r.bytes} B`);
      } catch (e) { console.log(`${p}  !!  ${e.message}`); }
    }
  } finally {
    try { child && child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
