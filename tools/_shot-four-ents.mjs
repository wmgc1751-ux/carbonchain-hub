/**
 * tools/_shot-four-ents.mjs —— 四家企业接入后的视觉核对截图
 *
 * 截三张：
 *   1) 登录页演示身份下拉（20 个账号按角色 / 主体 / 岗位三层分组）
 *   2) 四家企业之一（恒能保定）的企业驾驶舱
 *   3) 公开大屏（总量指标是否随四家一并抬升）
 *
 * 用法：node tools/_shot-four-ents.mjs
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
const PORT = 9457;
const OUT = path.resolve('_ui-check/shots');
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result?.value;
  }
}

function httpJson(p, method = 'GET', body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(`${BASE}${p}`, {
      method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

async function shoot(cdp, file, w, h) {
  const m = await cdp.send('Page.getLayoutMetrics');
  const cs = m.cssContentSize || m.contentSize || { width: w, height: h };
  const full = Math.min(Math.ceil(cs.height || h), 6000);
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.max(w, Math.ceil(cs.width || w)), height: full, scale: 1 },
  }, 60000);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return { file, bytes: fs.statSync(file).size, w, h: full };
}

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch4_'));
  let child = null;
  try {
    child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`, '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });

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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });

    /* 1) 登录页：展开演示身份下拉 */
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
    await sleep(3500);
    const opened = await cdp.eval(`(function(){
      const b = document.querySelector('.dd-btn');
      if (!b) return 'no-btn';
      b.click();
      return 'clicked';
    })()`);
    await sleep(1800);
    const items = await cdp.eval(`document.querySelectorAll('.dd-item').length`);
    const groups = await cdp.eval(`Array.from(document.querySelectorAll('.dd-group-h .dd-group-t')).map(e=>e.textContent.trim())`);
    console.log(`登录页下拉：${opened} / 条目 ${items} / 分组 ${JSON.stringify(groups)}`);
    console.log(await shoot(cdp, path.join(OUT, 'four-ents-login-dd.png'), 1440, 1200));

    /* 2) 企业驾驶舱：河北恒能（保定） */
    const login = await httpJson('/api/auth/login', 'POST', { username: 'ent_zjbd', password: '123456' });
    const token = login?.data?.token; const user = login?.data?.user;
    if (!token) throw new Error('登录失败');
    await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/ent/overview` }, 45000);
    await sleep(6000);
    console.log(await shoot(cdp, path.join(OUT, 'four-ents-ent-overview.png'), 1440, 1200));

    /* 3) 公开大屏 */
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/screen` }, 45000);
    await sleep(6000);
    console.log(await shoot(cdp, path.join(OUT, 'four-ents-screen.png'), 1440, 1200));
  } finally {
    try { child && child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
