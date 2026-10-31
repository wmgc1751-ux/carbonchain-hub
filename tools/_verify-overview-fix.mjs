/**
 * tools/_verify-overview-fix.mjs —— 核查端「机构总览」四项改动的页面级回归
 *
 * 校验目标（对应 2026-10-30 的四项修复）：
 *   1. 报告归属：KPI「链上存证」与「累计完成」同口径
 *   2. 统计口径：结论分布/平均偏差率只统计已上链结论
 *   3. 待办任务：点击后跳到 /ver/tasks?open=<id> 并自动打开作业台
 *   4. 「最近出具的核查报告」已替换为「待复核结论」
 *
 * 用 CDP 驱动本机 Edge/Chrome：注入 ver001 会话 → 渲染 → 断言 DOM → 截图。
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
  await sleep(600);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, 60000);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`  shot ${path.basename(file)} (${fs.statSync(file).size} B)`);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  fs.mkdirSync(OUT, { recursive: true });

  const login = await httpJson('/api/auth/login', 'POST', { username: 'ver001', password: '123456' });
  if (login.code !== 0) throw new Error('登录失败：' + JSON.stringify(login).slice(0, 150));
  const sess = { token: login.data.token, user: login.data.user };
  console.log('ver001 session ok ·', sess.user.orgName);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_ov_'));
  let child = null;
  try {
    child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });

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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

    /* 先打开任意页写入会话，再进总览 */
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}` }, 45000);
    await sleep(2200);
    await cdp.eval(`(function(s){
      try { localStorage.clear(); } catch(e){}
      localStorage.setItem('cch_token', s.token);
      localStorage.setItem('cch_user', JSON.stringify(s.user));
      return 'ok';
    })(${JSON.stringify(sess)})`);

    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/ver/overview` }, 45000);
    await sleep(5000);

    const snap = await cdp.eval(`(function(){
      const cards = [...document.querySelectorAll('main .card')];
      const txt = (el) => el ? el.innerText.replace(/\\s+/g,' ').trim() : null;
      const find = (t) => cards.find(c => txt(c) && txt(c).includes(t));
      const kpis = [...document.querySelectorAll('main .card.kpi')].map(c => txt(c).slice(0,70));
      const todoCard = find('待办任务');
      const todoRows = todoCard ? [...todoCard.querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\\s+/g,' ').trim()) : [];
      return {
        hash: location.hash,
        title: (document.querySelector('main h2')||{}).innerText || null,
        kpis,
        hasPendingReview: !!find('待复核结论'),
        hasOldReport: !!find('最近出具的核查报告'),
        pendingReviewText: txt(find('待复核结论')),
        workloadSub: (function(){ const c=find('近 12 个月核查工作量'); const s=c&&c.querySelector('.card-head'); return s?txt(s):null; })() || null,
        concSub: (function(){ const c=find('核查结论分布'); const s=c&&c.querySelector('.card-head'); return s?txt(s):null; })() || null,
        canvases: [...document.querySelectorAll('main canvas')].map(c => ({ w: c.width, h: c.height })),
        todoRows,
        bodyScrollH: document.body.scrollHeight,
      };
    })()`);

    console.log('\n── 页面快照 ──');
    console.log(JSON.stringify(snap, null, 1));
    await shoot(cdp, path.join(OUT, 'ver-overview-fixed.png'));

    console.log('\n── 断言 ──');
    check('已进入机构总览', snap.hash.includes('/ver/overview'), snap.hash);
    check('KPI 链上存证标明去重口径', /已存证报告数 = 完成 \d+ \+ 驳回 \d+/.test(snap.kpis.join(' ')), snap.kpis[4] || '');
    check('KPI 平均偏差率标注已上链结论', /已上链结论/.test(snap.kpis.join(' ')), snap.kpis[3] || '');
    check('结论分布副标题标明口径', /份已上链结论 · \d+ 类结论 · 通过率/.test(snap.concSub || ''), snap.concSub);
    check('「待复核结论」区块存在', snap.hasPendingReview);
    check('旧「最近出具的核查报告」已移除', !snap.hasOldReport);
    check('两个图表均已渲染', snap.canvases.length === 2, JSON.stringify(snap.canvases));
    check('待办任务表有数据', snap.todoRows.length > 0, snap.todoRows.length + ' 行');

    /* 待办点击 → 应跳 /ver/tasks?open=<id> 并自动打开作业台 */
    const jumped = await cdp.eval(`(async function(){
      const todoCard = [...document.querySelectorAll('main .card')].find(c => c.innerText.includes('待办任务'));
      if (!todoCard) return { err: 'no-todo-card' };
      const row = todoCard.querySelector('tbody tr');
      if (!row) return { err: 'no-row' };
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 3200));
      const modal = document.querySelector('.modal, [class*="modal"]');
      return {
        hash: location.hash,
        modalOpen: !!modal,
        modalTitle: modal ? (modal.innerText||'').replace(/\\s+/g,' ').slice(0,90) : null,
      };
    })()`);
    console.log('\n── 待办点击 ──');
    console.log(JSON.stringify(jumped, null, 1));
    await shoot(cdp, path.join(OUT, 'ver-task-jump.png'));

    check('点击待办跳到带 open 参数的任务页', /\/ver\/tasks\?open=\d+/.test(jumped.hash || ''), jumped.hash);
    check('作业台弹窗已自动打开', !!jumped.modalOpen, jumped.modalTitle || '');

    const bad = results.filter((r) => !r.ok);
    console.log(`\n结果：${results.length - bad.length}/${results.length} 通过`);
    if (bad.length) {
      console.log('失败项：' + bad.map((b) => b.name).join(' / '));
      process.exitCode = 1;
    }
  } finally {
    try { child && child.kill(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
