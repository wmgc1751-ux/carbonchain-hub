/* 登录页「演示身份」下拉展开态截图（验收 P1-14：面板背景不透明） */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const BASE = 'http://127.0.0.1:8300';
const PORT = 9461;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiter = new Map();
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.waiter.has(m.id)) { const { res, rej, t } = this.waiter.get(m.id); this.waiter.delete(m.id); clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); }
  send(method, params = {}, timeout = 60000) { const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.waiter.delete(id); rej(new Error(method + ' timeout')); }, timeout); this.waiter.set(id, { res, rej, t }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error'); return r.result?.value; }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-login-'));
const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, `--user-data-dir=${profile}`,
  '--no-proxy-server', '--proxy-bypass-list=*', '--no-first-run', '--disable-gpu', '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });
try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) { await sleep(250); try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch { /* retry */ } }
  const WebSocket = (await import('ws')).default;
  const cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
  await new Promise((r, j) => { cdp.ws.addEventListener('open', r, { once: true }); cdp.ws.addEventListener('error', () => j(new Error('ws error')), { once: true }); });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
  await sleep(3500);
  const opened = await cdp.eval(`(function(){
    const btn = [...document.querySelectorAll('button,div[role=button],.dd-trigger,[class*=trigger]')]
      .find((b) => /选择演示身份/.test(b.textContent || ''));
    if (!btn) return 'trigger-not-found';
    btn.click(); return 'clicked';
  })()`);
  await sleep(900);
  const probe = await cdp.eval(`(function(){
    const pop = document.querySelector('.dd-pop');
    if (!pop) return { found: false };
    const cs = getComputedStyle(pop);
    return { found: true, bg: cs.backgroundColor, opaque: cs.backgroundColor && !/rgba\\(.*,\\s*0\\)/.test(cs.backgroundColor) };
  })()`);
  console.log('open:', opened, 'panel:', JSON.stringify(probe));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 60000);
  fs.writeFileSync('_ui-check/shots/v_login_dropdown.png', Buffer.from(shot.data, 'base64'));
  console.log('saved _ui-check/shots/v_login_dropdown.png');
} finally {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
