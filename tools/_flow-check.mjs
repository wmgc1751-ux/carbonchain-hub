/**
 * tools/_flow-check.mjs —— 交互流程实测（点一下，然后持续采样页面上的提示/状态）
 *
 *   node tools/_flow-check.mjs --role VER --page /ver/overview \
 *        --click '[title="退出登录"]' --watch 6000 --sample '.toasts,body'
 *
 * 用途：验证「登出后是否还弹『登录状态已失效』」这类**时序型**缺陷 ——
 * 截图只能拍到某一瞬间，而这类问题往往在点击后 1~3 秒才由后台轮询触发，
 * 必须连续采样才能抓到。默认每 400ms 采一次，同时记录 localStorage 里的
 * token 是否已清空、当前 hash 路由落在哪一页。
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
const PORT = 9458;

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
const ROLE = (arg('role', 'VER') || '').toUpperCase();
const PAGE = arg('page', '/ver/overview');
const CLICK = arg('click', '');
const WATCH = Number(arg('watch', '6000'));
const SAMPLE = arg('sample', '.toasts');
const WAIT = Number(arg('wait', '4200'));

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
  send(method, params = {}, timeout = 90000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter.delete(id); rej(new Error(`${method} 超时`)); }, timeout);
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

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_flow_'));
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

    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${PAGE}` }, 45000);
    await sleep(WAIT);

    const snap = `(function(){
      const t = document.querySelector(${JSON.stringify(SAMPLE.split(',')[0])});
      return JSON.stringify({
        hash: location.hash,
        hasTok: !!localStorage.getItem('cch_token'),
        txt: t ? (t.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240) : null,
      });
    })()`;

    console.log('—— 点击前 ——');
    console.log(await cdp.eval(snap));

    /* 钩住提示层：记录每一次 toast 的级别/文案/调用栈。
     * 缺陷往往表现为"弹了不该弹的提示"，截图只能看到结果，
     * 看不到是哪段代码弹的 —— 这里把调用栈一并留下。 */
    await cdp.eval(`(function(){
      if (window.__errs) return 1;
      window.__errs = [];
      const n = App.notify;
      ['err','warn','ok','info'].forEach(function(k){
        const o = n[k].bind(n);
        n[k] = function(m, a){
          try {
            window.__errs.push(k + ' | ' + (typeof m === 'string' ? m : JSON.stringify(m))
              + ' || ' + String(new Error().stack || '').split('\\n').slice(2, 6).join(' <- '));
          } catch (e) {}
          return o(m, a);
        };
      });
      return 1;
    })()`);

    if (CLICK) {
      const hit = await cdp.eval(`(function(){
        const el = document.querySelector(${JSON.stringify(CLICK)});
        if (!el) return 'NOT_FOUND';
        el.click(); return 'CLICKED';
      })()`);
      console.log('—— 点击 ——', hit);
      if (hit === 'NOT_FOUND') throw new Error('未找到可点击元素：' + CLICK);
    }

    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < WATCH) {
      await sleep(400);
      const s = await cdp.eval(snap);
      if (seen[seen.length - 1] !== s) seen.push(s);
    }
    console.log(`—— 点击后 ${WATCH}ms 内的状态变化（去重，共 ${seen.length} 个状态）——`);
    seen.forEach((s, i) => console.log(`  [${i}] ${s}`));

    const errs = await cdp.eval('JSON.stringify(window.__errs || [])');
    const list = JSON.parse(errs || '[]');
    console.log(`—— 期间触发的提示（${list.length} 条，含调用栈）——`);
    list.forEach((s, i) => console.log(`  (${i}) ${s}`));
  } finally {
    try { child && child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
