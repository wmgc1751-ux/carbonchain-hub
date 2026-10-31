/**
 * tools/_shot-verifier.mjs —— 机构注册审核 UI 截图（人工目检用）
 *   A. 登录弹窗 · 注册 Tab · 选中「核查机构」通道
 *   B. 管理端 /admin/users · 待审核查机构注册卡片（先经 API 注册一笔探针申请）
 * 输出：_ui-check/shots/verifier-reg-*.png
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

function httpJson(p, method = 'GET', body, token) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(`${BASE}${p}`, {
      method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
    }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`${p} 非 JSON`)); } }); });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

async function shoot(cdp, file) {
  await sleep(800);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 60000);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`shot ${file} (${fs.statSync(file).size} B)`);
}

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  fs.mkdirSync(OUT, { recursive: true });

  /* 先经 API 注册一笔待审申请，保证管理端卡片有数据 */
  const stamp = Date.now().toString(36);
  const reg = await httpJson('/api/auth/register', 'POST', {
    role: 'VERIFIER', username: '_ui_' + stamp, password: 'probe123', realName: '截图探针员',
    orgName: `华信联合（截图探针）核查有限公司${stamp.slice(-4)}`, region: '江苏', contactPhone: '13800000001',
  });
  if (!reg?.data?.pending) throw new Error('探针机构注册失败：' + JSON.stringify(reg).slice(0, 150));
  console.log('pending registration ok:', reg.data.user.username);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_shot_'));
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

    /* ---- A. 注册弹窗 · 核查机构通道 ---- */
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
    await sleep(2600);
    const r1 = await cdp.eval(`(function(){
      const tabs = [...document.querySelectorAll('.auth-tab')];
      const regTab = tabs.find(b => b.textContent.includes('注册'));
      if (!regTab) return 'no-reg-tab';
      regTab.click();
      return 'ok';
    })()`);
    await sleep(400);
    const r2 = await cdp.eval(`(function(){
      const labels = [...document.querySelectorAll('.reg-role')];
      const v = labels.find(l => l.textContent.includes('核查机构'));
      if (!v) return 'no-role-radio';
      v.click();
      return 'ok';
    })()`);
    await sleep(500);
    const roleState = await cdp.eval(`(function(){
      const on = document.querySelector('.reg-role.on');
      const btn = [...document.querySelectorAll('form button')].map(b=>b.textContent.trim()).find(t=>t && t.length<20);
      return JSON.stringify({ selected: on && on.textContent.trim(), submit: btn });
    })()`);
    console.log('A tab:', r1, r2, roleState);
    await shoot(cdp, path.join(OUT, 'verifier-reg-form.png'));

    /* ---- B. 管理端待审卡片 ---- */
    const login = await httpJson('/api/auth/login', 'POST', { username: 'admin', password: 'admin123' });
    const token = login?.data?.token; const user = login?.data?.user;
    if (!token) throw new Error('admin 登录失败');
    await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/admin/users` }, 45000);
    await sleep(4500);
    const pendingVisible = await cdp.eval(`(function(){
      const cards = [...document.querySelectorAll('x-card')];
      const c = cards.find(x => (x.textContent || '').includes('待审核查机构注册'));
      return c ? 'pending-card-visible' : 'no-pending-card';
    })()`);
    console.log('B admin page:', pendingVisible);
    await shoot(cdp, path.join(OUT, 'verifier-admin-review.png'));
  } finally {
    try { child && child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
