/**
 * tools/_console-audit.mjs —— 登录后控制台逐页实测（界面+功能完整性）
 *   每角色：API 登录 → 运行时读取该角色全部菜单路径 → hash 逐页导航 →
 *   断言：非错误视图 / x-page 标题非空 / 卡片与内容量 / JS 异常捕获 → 截图留档。
 *   另测：路由守卫（他角色页面访问被拒）。
 * 用法：node tools/_console-audit.mjs [ROLE ...]   （缺省=全部五角色）
 * 输出：_ui-check/console-audit.json + shots/console/<role>--<path>.png
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
const OUT_JSON = path.resolve('_ui-check/console-audit.json');
const OUT_SHOTS = path.resolve('_ui-check/shots/console');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = {
  ENTERPRISE: { user: 'ent001', pass: '123456' },
  VERIFIER: { user: 'ver001', pass: '123456' },
  REGULATOR: { user: 'reg001', pass: '123456' },
  TRADER: { user: 'trader01', pass: '123456' },
  ADMIN: { user: 'admin', pass: 'admin123' },
};
/* 等待加长：图表/3D 页渲染慢 */
const SLOW_PATHS = ['/twin', '/matrix', '/screen', '/reg/stats', '/ent/analytics', '/reg/dynamic'];
const WAIT_NORMAL = Number(process.env.AUDIT_WAIT || 2200);
const WAIT_SLOW = Number(process.env.AUDIT_WAIT_SLOW || 4200);
/* settled 轮询上限：固定等待后若页面仍无正文（骨架屏期），继续轮询到此上限。
 * 根因背景：/screen 的 /public/dashboard 是重聚合接口，连续巡检压测下响应
 * 可超过固定等待 ⇒ 快照落在骨架屏期，误报"空白"。轮询能同时区分
 * 「慢响应」（上限内恢复 ⇒ 通过，记录实际耗时）与「永久挂起」（到上限仍骨架）。 */
const SETTLE_MAX = Number(process.env.AUDIT_SETTLE_MAX || 15000);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiter = new Map(); this.consoleErrs = [];
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.waiter.has(m.id)) {
        const { res, rej, t } = this.waiter.get(m.id); this.waiter.delete(m.id); clearTimeout(t);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.consoleErrs.push(String(d.exception?.description || d.text || 'exception').slice(0, 160));
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        const t = String(m.params.entry.text || '');
        if (!/favicon|net::ERR_ABORTED|Failed to load resource.*40[134]/.test(t)) {
          this.consoleErrs.push(('console: ' + t).slice(0, 160));
        }
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
  async eval(expr, timeout = 30000) {
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
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 60000);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}

const PAGE_CHECK = `(function(){
  const t0 = performance.now();
  const page = document.querySelector('x-page');
  const errView = [...document.querySelectorAll('button')].some(b => (b.textContent||'').includes('回到首页'))
    && !document.querySelector('x-page');
  const title = page ? (page.getAttribute('title') || page.shadowRoot?.querySelector?.('.page-title')?.textContent || '') : '';
  const bodyText = (document.body.innerText || '').trim();
  const cards = document.querySelectorAll('x-card').length;
  const tables = document.querySelectorAll('x-table').length;
  const kpis = document.querySelectorAll('x-kpi').length;
  const empty = bodyText.length < 80;
  const dash = performance.getEntriesByType('resource')
    .filter((r) => r.name.includes('dashboard'))
    .map((r) => Math.round(r.duration) + 'ms').slice(-1)[0] || null;
  return JSON.stringify({
    errView, title: String(title).slice(0, 60), textLen: bodyText.length,
    cards, tables, kpis, hasEchart: !!document.querySelector('canvas'),
    skel: !!document.querySelector('.skel'), dash,
    blank: empty, ms: Math.round(performance.now() - t0),
  });
})()`;

async function auditRole(cdp, role, acc, results) {
  const login = await httpJson('/api/auth/login', 'POST', { username: acc.user, password: acc.pass });
  const token = login?.data?.token; const user = login?.data?.user;
  if (!token) { results.push({ role, path: '(login)', ok: false, note: '登录失败' }); return; }

  await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
  await sleep(1800);
  await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);
  await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/` }, 45000);
  await sleep(2200);

  /* 运行时读取该角色菜单（唯一真相源：侧边栏就是功能全集） */
  const menuRaw = await cdp.eval(`(function(){
    const M = (window.App && App.routeAccess && App.routeAccess.MENUS && App.routeAccess.MENUS[${JSON.stringify(role)}]) || [];
    const out = [];
    M.forEach(g => (g.items||[]).forEach(i => out.push({ path: i.path, label: i.label })));
    return JSON.stringify(out);
  })()`);
  const items = JSON.parse(menuRaw || '[]');
  const home = { ENTERPRISE: '/ent/overview', VERIFIER: '/ver/overview', REGULATOR: '/reg/overview', TRADER: '/trade/market', ADMIN: '/admin/overview' }[role];
  const paths = [{ path: home, label: '(角色首页)' }, ...items.filter((x, i, a) => a.findIndex((y) => y.path === x.path) === i)];

  for (const it of paths) {
    cdp.consoleErrs.length = 0;
    const wait = SLOW_PATHS.some((p) => it.path.startsWith(p)) ? WAIT_SLOW : WAIT_NORMAL;
    await cdp.eval(`location.hash = ${JSON.stringify(it.path)}; 1`);
    await sleep(wait);
    let chk = {};
    try { chk = JSON.parse(await cdp.eval(PAGE_CHECK)); } catch (e) { chk = { evalErr: String(e.message).slice(0, 100) }; }
    /* settled 轮询：固定等待后仍无正文 ⇒ 骨架屏期，继续等到正文出现或上限 */
    const settle0 = Date.now();
    while (!chk.errView && !chk.evalErr && (chk.textLen || 0) < 80 && Date.now() - settle0 < SETTLE_MAX) {
      await sleep(500);
      try { chk = JSON.parse(await cdp.eval(PAGE_CHECK)); } catch (e) { chk = { evalErr: String(e.message).slice(0, 100) }; }
    }
    const elapsed = wait + (Date.now() - settle0);
    const errs = [...cdp.consoleErrs];
    const ok = !chk.errView && !chk.blank && !chk.evalErr && errs.length === 0;
    const note = [
      chk.evalErr ? 'eval错误:' + chk.evalErr : '',
      chk.errView ? '落到错误视图' : '',
      chk.blank ? `内容过少(${chk.textLen}字)` : '',
      errs.length ? `JS异常×${errs.length}: ${errs[0]}` : '',
    ].filter(Boolean).join(' | ');
    const shot = path.join(OUT_SHOTS, `${role}${it.path.replace(/\//g, '_')}.png`);
    try { await shoot(cdp, shot); } catch { /* 截图失败不阻断 */ }
    results.push({
      role, path: it.path, label: it.label, ok,
      title: chk.title || '', textLen: chk.textLen, cards: chk.cards, tables: chk.tables,
      kpis: chk.kpis, chart: !!chk.hasEchart, skel: !!chk.skel, dash: chk.dash || null,
      ms: elapsed, errs, note: note || 'OK', shot,
    });
    console.log(`  ${ok ? '✓' : '✗'} ${role} ${it.path} ${note || 'OK'}${chk.skel ? ' [骨架屏未退]' : ''} (${Math.round(elapsed)}ms${chk.dash ? ', dash ' + chk.dash : ''})`);
  }

  /* 路由守卫：本角色访问管理端页应被拒（ADMIN 自身跳过） */
  if (role !== 'ADMIN') {
    await cdp.eval(`location.hash = '/admin/users'; 1`);
    await sleep(2200);
    const guard = await cdp.eval(`(function(){
      const txt = (document.body.innerText||'');
      const onAdmin = !!document.querySelector('x-page[title*="用户与权限"], x-page');
      return JSON.stringify({ bounced: txt.includes('无权') || txt.includes('登录') || txt.includes('回到首页') || !location.hash.includes('/admin/users'), hash: location.hash });
    })()`);
    const g = JSON.parse(guard);
    results.push({ role, path: '(守卫→/admin/users)', ok: g.bounced, note: g.bounced ? '已拦截' : '未拦截:' + g.hash });
    console.log(`  ${g.bounced ? '✓' : '✗'} ${role} 守卫 /admin/users ${g.bounced ? '已拦截' : '未拦截 ' + g.hash}`);
  }
}

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  fs.mkdirSync(OUT_SHOTS, { recursive: true });
  const argv = process.argv.slice(2);
  const roles = argv.length ? argv.map((s) => s.toUpperCase()) : Object.keys(ACCOUNTS);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_audit_'));
  let child = null;
  const results = [];
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
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

    for (const role of roles) {
      console.log(`\n══ ${role} ══`);
      await auditRole(cdp, role, ACCOUNTS[role], results);
      /* 增量落盘：角色跑完即写，进程被回收也有已完成角色的结果 */
      try { fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2)); } catch { /* 忽略 */ }
    }
  } finally {
    try { child && child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2));
  const okN = results.filter((r) => r.ok).length;
  console.log(`\n=== console-audit: ${okN}/${results.length} 页通过（明细 ${OUT_JSON}）===`);
  process.exit(okN === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
