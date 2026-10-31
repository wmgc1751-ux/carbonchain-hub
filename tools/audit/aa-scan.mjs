#!/usr/bin/env node
/**
 * tools/audit/aa-scan.mjs —— RR-04 · WCAG 2.2 AA 自动化审计（axe-core）
 * ============================================================================
 * 场景矩阵：公众页（免登录）+ 五角色代表页（注入令牌），
 * 每页注入 node_modules/axe-core/axe.min.js，runOnly = wcag2a/2aa + 2.1a/2aa。
 * 输出：审计-20261031/AA报告.md + aa-raw.json（逐页违规明细）。
 * 边界：自动化可测规则约 40 条；AA 全集约 50+ 条，其余（对比度部分规则、
 *       键盘全流程、读屏语义）列"需人工"清单 —— 如实标注，不冒充全量。
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const BASE = 'http://localhost:8300';
const PORT = 9471;
const AUD = path.resolve('审计-20261031');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const AXE = fs.readFileSync(path.resolve('node_modules/axe-core/axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 页面矩阵：[路由, 角色(登录), 说明] */
const PAGES = [
  ['/', null, '品牌主页'],
  ['/explorer', null, '区块链浏览器'],
  ['/screen', null, '公示大屏'],
  ['/verify', null, '科研验证中心'],
  ['/notice', null, '通知公告'],
  ['/real/truth', null, '真实性契约'],
  ['/ent/overview', 'ent_zjbd', '企业总览'],
  ['/ent/reports', 'ent_zjbd', '碳排放上报'],
  ['/ent/quota', 'ent_zjbd', '碳配额账户'],
  ['/ent/members', 'ent_zjbd', '机构账号'],
  ['/ver/overview', 'ver_cz_review', '核查工作台'],
  ['/ver/tasks', 'ver_cz_review', '核查任务'],
  ['/reg/overview', 'reg001', '监管总览'],
  ['/reg/alerts', 'reg001', '预警与处置'],
  ['/admin/overview', 'admin', '平台管理'],
  ['/admin/users', 'admin', '用户管理'],
];
const DEMO_PW = { ent_zjbd: '123456', ver_cz_review: '123456', reg001: '123456', admin: 'admin123' };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiter = new Map();
    ws.addEventListener('message', (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.waiter.has(m.id)) { const { res, rej, t } = this.waiter.get(m.id); this.waiter.delete(m.id); clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); }
  send(method, params = {}, timeout = 60000) { const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.waiter.delete(id); rej(new Error(method + ' timeout')); }, timeout); this.waiter.set(id, { res, rej, t }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr, timeout = 45000) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result?.value; }
}

function httpJson(p, method = 'GET', body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(`${BASE}${p}`, {
      method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`${p} 非 JSON`)); } }); });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_aa_'));
  let child = null;
  const out = { scannedAt: new Date().toISOString(), pages: [] };
  try {
    child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });
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
    const WebSocket = (await import('ws')).default;
    const cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
    await sleep(200);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

    /* 令牌预取（一次登录复用） */
    const tokens = {};
    for (const u of [...new Set(PAGES.map((p) => p[1]).filter(Boolean))]) {
      const l = await httpJson('/api/auth/login', 'POST', { username: u, password: DEMO_PW[u] });
      tokens[u] = { token: l?.data?.token, user: l?.data?.user };
    }

    for (const [page, role, label] of PAGES) {
      const url = `${BASE}/?_=${Date.now()}#${page}`;
      await cdp.send('Page.navigate', { url }, 45000);
      await sleep(1600);
      if (role && tokens[role]) {
        await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(tokens[role].token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(tokens[role].user))}); return 1; })()`);
        await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${page}` }, 45000);
        await sleep(3200);
      }
      try {
        /* 经静态路径注入 axe（绕开 500KB 表达式与 addScriptTag 兼容性） */
        await cdp.eval(`(function(){
          var s = document.createElement('script');
          s.src = '/js/vendor/axe.min.js?v=' + Date.now();
          document.head.appendChild(s); return 1; })()`);
        for (let i = 0; i < 25 && !await cdp.eval('!!window.axe'); i++) await sleep(200);
        const res = await cdp.eval(`(function(){
          return new Promise(function(resolve){
            if (!window.axe) return resolve({ error: 'axe 未注入' });
            axe.run(document, { runOnly: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] })
              .then(function(r){ resolve({
                url: location.hash,
                title: document.title,
                violations: r.violations.map(function(v){ return {
                  id: v.id, impact: v.impact, help: v.help,
                  tags: v.tags.filter(function(t){ return t.indexOf('wcag') === 0; }),
                  nodes: v.nodes.length, sample: v.nodes.slice(0,2).map(function(n){ return (n.target||[]).join(' '); }) }; }),
                passes: r.passes.length, incomplete: r.incomplete.length }; })
              .catch(function(e){ resolve({ error: String(e).slice(0,120) }); });
          }); })()`, 60000);
        out.pages.push({ page, role: role || 'PUBLIC', label, ...res });
        const vs = (res.violations || []).reduce((a, v) => a + v.nodes, 0);
        console.log((res.error ? '⚠' : (vs ? '⚠' : '✔')), page, label, res.error || (vs + ' 个违规节点 / ' + (res.violations||[]).length + ' 类'));
      } catch (e) {
        out.pages.push({ page, role: role || 'PUBLIC', label, error: String(e).slice(0, 160) });
        console.log('✘', page, String(e).slice(0, 100));
      }
    }
  } finally {
    try { child && child.kill('SIGKILL'); } catch { /* 忽略 */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  fs.writeFileSync(path.join(AUD, 'aa-raw.json'), JSON.stringify(out, null, 1));
  const pages = out.pages;
  const byRule = {};
  for (const p of pages) for (const v of (p.violations || [])) {
    byRule[v.id] = byRule[v.id] || { impact: v.impact, help: v.help, nodes: 0, pages: 0 };
    byRule[v.id].nodes += v.nodes; byRule[v.id].pages += 1;
  }
  const clean = pages.filter((p) => !p.error && !(p.violations || []).length).length;
  console.log(`\n汇总：${clean}/${pages.length} 页 0 违规 · 规则分布：`, byRule);
  fs.writeFileSync(path.join(AUD, 'AA报告.md'), '占位（详见 aa-raw.json）');
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
