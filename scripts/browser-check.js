/**
 * scripts/browser-check.js —— 端到端 UI 巡检（CDP 驱动本机 Edge，无需任何 npm 依赖）
 *
 * 做三件事：
 *   1) 逐个路由真实渲染，抓取 console 错误 / 未捕获异常 / 未处理 Promise 拒绝
 *   2) 全页截图落盘到 artifacts/screens/
 *   3) 关键交互回归（登录、报表详情抽屉、区块详情、告警处理）
 *
 * 用法：node scripts/browser-check.js [--headed]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.APP_BASE || 'http://127.0.0.1:8300';
const PORT = Number(process.env.CDP_PORT || 9333);
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts');
const SHOT = path.join(OUT, 'screens');
const HEADED = process.argv.includes('--headed');

/* Edge 调试用的一次性配置目录放系统临时目录，别写进 artifacts/ —— 每个 40~50MB，
   一旦清理失败就会堆在交付目录里。 */
const TMP_ROOT = path.join(os.tmpdir(), 'carbonchain-cdp');
let ACTIVE_PROFILE = null;
process.on('exit', () => {
  if (ACTIVE_PROFILE) { try { fs.rmSync(ACTIVE_PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout ' + url)));
  });
}

async function api(pathname, method = 'GET', body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api' + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(pathname + ' -> ' + json.message);
  return json.data;
}

/* ------------------------------------------------------------------ CDP */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.method + ' ' + msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 30000);
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('eval error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  }
}

async function launchEdge() {
  // 清掉上一次残留：占用调试端口的旧实例会让新的 Edge 起不来（同一 profile 被锁）
  try {
    const busy = await new Promise((resolve) => {
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      ps.stdout.on('data', (d) => { out += d; });
      ps.on('close', () => resolve(out.trim()));
    });
    for (const pid of busy.split(/\s+/).filter(Boolean)) {
      spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      await sleep(700);
    }
  } catch (e) { /* 忽略 */ }

  const profile = path.join(TMP_ROOT, 'profile-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  ACTIVE_PROFILE = profile;
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--no-proxy-server', '--proxy-bypass-list=*',
    '--window-size=1680,1050',
    '--disable-features=Translate,BackForwardCache',
    'about:blank',
  ];
  if (HEADED) args.splice(0, 1);
  const child = spawn(EDGE, args, { detached: false, stdio: 'ignore' });
  child.unref();
  return { child, profile };
}

/** 结束后整棵进程树收干净，否则残留的 Edge 会拖垮下一次巡检 */
async function killEdge(child, profile) {
  try { if (child && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  await sleep(800);
  /* 必须 await 到真正删掉为止：以前用 setTimeout 延迟删除，紧接着 process.exit()
     会把定时器一起掐掉，导致 profile 目录（每个约 40~50MB）永久堆在磁盘上。 */
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (!fs.existsSync(profile)) break;
    await sleep(700);
  }
  if (ACTIVE_PROFILE === profile) ACTIVE_PROFILE = null;
}

async function waitForTarget(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* 端口未就绪 */ }
    await sleep(300);
  }
  throw new Error('未能在超时内连接到 Edge 调试端口 ' + PORT);
}

/* --------------------------------------------------------------- 初始化脚本 */
const INIT_SCRIPT = `
window.__logs = [];
(function () {
  var oe = console.error, ow = console.warn;
  console.error = function () { window.__logs.push({ lvl: 'error', msg: Array.prototype.map.call(arguments, String).join(' ') }); oe.apply(console, arguments); };
  console.warn = function () { window.__logs.push({ lvl: 'warn', msg: Array.prototype.map.call(arguments, String).join(' ') }); ow.apply(console, arguments); };
  window.addEventListener('error', function (e) {
    var t = e.target && e.target.tagName;
    if (t && (t === 'IMG' || t === 'SCRIPT' || t === 'LINK')) {
      window.__logs.push({ lvl: 'resource', msg: t + ' 加载失败: ' + (e.target.src || e.target.href) });
    } else {
      window.__logs.push({ lvl: 'uncaught', msg: String(e.message) + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0) });
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    window.__logs.push({ lvl: 'unhandledRejection', msg: String((r && r.message) || r) });
  });
})();
`;

const PROBE = `(function () {
  var app = document.getElementById('app');
  if (!app) return { fatal: 'no #app' };
  var txt = (app.innerText || '').replace(/\\s+/g, ' ').trim();
  var log = (window.__logs || []).filter(function (x) {
    return x.lvl === 'uncaught' || x.lvl === 'unhandledRejection' || x.lvl === 'error' || x.lvl === 'resource';
  });
  var warns = (window.__logs || []).filter(function (x) { return x.lvl === 'warn'; }).slice(0, 6);
  var chartCanvas = document.querySelectorAll('canvas').length;
  return {
    hash: location.hash,
    booting: !!document.querySelector('.boot'),
    htmlLen: app.innerHTML.length,
    textLen: txt.length,
    head: txt.slice(0, 110),
    cards: document.querySelectorAll('.card,.stat,.panel').length,
    tables: document.querySelectorAll('table').length,
    rows: document.querySelectorAll('tbody tr').length,
    charts: chartCanvas,
    errorBars: Array.prototype.map.call(document.querySelectorAll('.alertbar.err,.empty.err'), function (n) { return (n.innerText || '').slice(0, 90); }),
    warns: warns,
    unresolved: Array.prototype.filter.call(document.querySelectorAll('*'), function (n) {
      return n.tagName && n.tagName.indexOf('X-') === 0;
    }).map(function (n) { return n.tagName.toLowerCase(); }).filter(function (v, i, a) { return a.indexOf(v) === i; }),
    logs: log.slice(0, 12),
  };
})()`;

/* --------------------------------------------------------------- 场景定义 */
const ROLE_ROUTES = {
  ENTERPRISE: [
    ['/ent/overview', '企业总览'],
    ['/ent/reports', '碳排放上报'],
    ['/ent/quota', '碳配额账户'],
    ['/ent/trade', '碳配额交易'],
    ['/ent/analytics', '数据分析'],
    ['/ent/wallet', '链上身份'],
    ['/ent/notices', '通知公告'],
  ],
  VERIFIER: [
    ['/ver/overview', '核查总览'],
    ['/ver/tasks', '核查任务'],
    ['/ver/reports', '核查报告'],
    ['/ver/wallet', '机构链上身份'],
    ['/ver/notices', '通知公告'],
  ],
  REGULATOR: [
    ['/reg/overview', '监管总览'],
    ['/reg/enterprises', '企业名录'],
    ['/reg/allocations', '配额分配'],
    ['/reg/trades', '交易监管'],
    ['/reg/alerts', '预警处置'],
    ['/reg/stats', '统计分析'],
    ['/reg/logs', '操作日志'],
    ['/reg/system', '系统设置'],
    ['/reg/notices', '通知公告'],
  ],
};

const PUBLIC_ROUTES = [
  ['/login', '统一登录'],
  ['/screen', '数据公示大屏'],
  ['/explorer', '区块链浏览器'],
];

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  fs.mkdirSync(SHOT, { recursive: true });

  // 1) 取三端 token + 若干动态 ID
  const accounts = await api('/auth/demo-accounts');
  const tokens = {};
  const users = {};
  for (const a of accounts) {
    if (tokens[a.role]) continue;
    const d = await api('/auth/login', 'POST', { username: a.username, password: a.password });
    tokens[a.role] = d.token;
    users[a.role] = d.user;
  }
  const notices = await api('/public/notices?page=1&size=1', 'GET', null, null).catch(() => null);
  const noticeId = notices && notices.rows && notices.rows.length ? notices.rows[0].id : null;
  const chain = await api('/chain/stats');

  console.log(`[i] 令牌就绪: ${Object.keys(tokens).join(', ')}  链高度=${chain.height}`);

  // 2) 启动浏览器
  const { child: proc, profile } = await launchEdge();
  const target = await waitForTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
  });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false,
  });

  // about:blank 下 localStorage 不可用，先落到真实 origin
  await cdp.send('Page.navigate', { url: `${BASE}/?_boot=1#/login` });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const u = await cdp.evaluate('location.origin');
      if (u && u.indexOf('127.0.0.1') > -1) break;
    } catch (e) { /* 导航中 */ }
  }
  await sleep(600);

  const results = [];

  /** 载入指定角色会话 + 路由（整页重载，确保 App.Store 与 localStorage 一致） */
  async function loadRoute(role, route, { keepSession = false } = {}) {
    if (!keepSession) {
      const token = tokens[role] || '';
      const user = users[role] || null;
      await cdp.evaluate(`(function(){
        ${token ? `localStorage.setItem('cch_token', ${JSON.stringify(token)});` : `localStorage.removeItem('cch_token');`}
        ${user ? `localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))});` : `localStorage.removeItem('cch_user');`}
        return true;
      })()`);
    }
    const url = `${BASE}/?_=${Date.now()}#${route}`;
    await cdp.send('Page.navigate', { url });
    // 等待渲染稳定
    const t0 = Date.now();
    let probe = null;
    while (Date.now() - t0 < 14000) {
      await sleep(260);
      try { probe = await cdp.evaluate(PROBE); } catch (e) { continue; }
      if (probe && !probe.booting && probe.textLen > 60) break;
    }
    await sleep(1250); // 等异步数据与图表
    return probe;
  }

  async function shoot(name) {
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    const h = Math.min(Math.max(size.height, 900), 5200);
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.max(size.width, 1680), height: h, scale: 1 },
    });
    const file = path.join(SHOT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return { file: path.relative(ROOT, file), size: fs.statSync(file).size, height: h };
  }

  async function visit(role, route, label, seq) {
    const probe = await loadRoute(role, route);
    const shot = await shoot(`${String(seq).padStart(2, '0')}-${label}`);
    const pass = probe && !probe.booting && probe.textLen > 60
      && probe.logs.length === 0 && probe.unresolved.length === 0 && probe.errorBars.length === 0;
    results.push({ seq, role, route, label, pass, probe, shot });
    console.log(`${pass ? 'PASS' : 'FAIL'}  [${role || 'PUBLIC'}] ${route}  texts=${probe ? probe.textLen : '-'} charts=${probe ? probe.charts : '-'} tables=${probe ? probe.tables : '-'} rows=${probe ? probe.rows : '-'} logs=${probe ? probe.logs.length : '-'} unresolved=${probe ? probe.unresolved.join(',') : '-'}  -> ${shot.file}`);
    return probe;
  }

  /* ---- A. 公开路由 ---- */
  let seq = 1;
  for (const [route, label] of PUBLIC_ROUTES) {
    await visit(null, route, label, seq++);
  }
  if (noticeId) await visit(null, `/notice/${noticeId}`, '公告详情', seq++);
  await visit(null, '/explorer/block/1', '区块详情', seq++);
  const tx = await api('/chain/txs?page=1&size=200').catch(() => null);
  let txWithPath = null;
  if (tx && tx.rows && tx.rows.length) {
    // 优先挑一笔「所在区块有多笔交易」的存证，这样交易详情里能展示完整 Merkle 证明路径
    for (const row of tx.rows.slice(0, 40)) {
      try {
        const d = await api('/chain/tx/' + row.tx_id);
        if (d.merkle && (d.merkle.path || []).length > 0) { txWithPath = row.tx_id; break; }
      } catch (e) { /* 跳过 */ }
    }
    if (!txWithPath) txWithPath = tx.rows[0].tx_id;
  }
  if (txWithPath) await visit(null, `/explorer/tx/${txWithPath}`, '交易详情（含 Merkle 路径）', seq++);

  /* ---- B. 三端业务路由 ---- */
  for (const role of ['ENTERPRISE', 'VERIFIER', 'REGULATOR']) {
    for (const [route, label] of ROLE_ROUTES[role]) {
      await visit(role, route, `${role.slice(0, 3)}-${label}`, seq++);
    }
  }

  /* ---- C. 交互回归 ---- */
  const interactions = [];

  // C1. 登录页真实登录（清空会话 → 填表 → 点登录）
  await cdp.evaluate(`localStorage.clear(); true`);
  await loadRoute(null, '/login', { keepSession: true });
  const loginOk = await cdp.evaluate(`(function () {
    var inputs = document.querySelectorAll('.login-card input');
    if (inputs.length < 2) return { ok: false, why: 'no inputs' };
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], 'ent001'); inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(inputs[1], '123456'); inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    var btn = document.querySelector('.login-card .btn.primary');
    if (!btn) return { ok: false, why: 'no button' };
    btn.click();
    return { ok: true };
  })()`);
  await sleep(2200);
  const afterLogin = await cdp.evaluate(`({ hash: location.hash, hasToken: !!localStorage.getItem('cch_token') })`);
  interactions.push({
    name: '登录页表单登录 → 跳转企业端',
    pass: loginOk.ok && /^#\/ent\//.test(afterLogin.hash) && afterLogin.hasToken,
    detail: JSON.stringify(afterLogin),
    shot: (await shoot('90-登录后企业总览')).file,
  });

  // C2. 上报列表 → 点击表格行 → 详情弹窗
  await loadRoute('ENTERPRISE', '/ent/reports');
  const drawer = await cdp.evaluate(`(function () {
    var row = document.querySelector('tbody tr.clickable') || document.querySelector('tbody tr');
    if (!row) return { ok: false, why: '无数据行' };
    row.click();
    return { ok: true, cols: row.children.length };
  })()`);
  await sleep(2000);
  const drawerState = await cdp.evaluate(`(function(){
    var d = document.querySelector('.mask .modal');
    var t = d ? (d.innerText || '').replace(/\\s+/g,' ').trim() : '';
    var h = d && d.querySelector('.modal-head h3');
    return { open: !!d, title: h ? h.innerText : '', textLen: t.length, head: t.slice(0, 90) };
  })()`);
  interactions.push({
    name: '排放上报 → 行点击打开详情弹窗',
    pass: drawer.ok && drawerState.open && drawerState.textLen > 200,
    detail: JSON.stringify({ click: drawer, panel: drawerState }),
    shot: (await shoot('91-上报详情弹窗')).file,
  });

  // C3. 区块链浏览器 → 点进区块详情
  await loadRoute(null, '/explorer');
  const blk = await cdp.evaluate(`(function () {
    var rows = document.querySelectorAll('tbody tr');
    if (!rows.length) return { ok: false, why: '无区块行' };
    var t = rows[0].querySelector('a,button,.link,.block-idx');
    if (t) { t.click(); return { ok: true, via: 'link', label: (t.innerText||'').trim() }; }
    rows[0].click(); return { ok: true, via: 'row' };
  })()`);
  await sleep(2200);
  const blkState = await cdp.evaluate(`(function(){
    var app = document.getElementById('app');
    var txt = (app.innerText||'').replace(/\\s+/g,' ');
    return {
      hash: location.hash,
      textLen: (app.innerText||'').length,
      err: (document.querySelector('.alertbar.err')||{innerText:''}).innerText,
      merkle: /Merkle/i.test(txt),
      hashes: document.querySelectorAll('.hashbox,.mono').length,
    };
  })()`);
  interactions.push({
    name: '区块链浏览器 → 区块详情（含 Merkle 根）',
    pass: blk.ok && /^#\/explorer\/block\//.test(blkState.hash) && blkState.err === '' && blkState.textLen > 400,
    detail: JSON.stringify({ click: blk, after: blkState }),
    shot: (await shoot('92-区块详情')).file,
  });

  // C4. 监管端预警处置
  await loadRoute('REGULATOR', '/reg/alerts');
  const alertBtn = await cdp.evaluate(`(function () {
    var btns = Array.prototype.filter.call(document.querySelectorAll('tbody button'), function (b) {
      return (b.innerText || '').trim() === '处置';
    });
    if (!btns.length) return { ok: false, why: '无处置按钮' };
    btns[0].click(); return { ok: true, label: (btns[0].innerText||'').trim() };
  })()`);
  await sleep(1800);
  const alertState = await cdp.evaluate(`(function(){
    var d = document.querySelector('.mask .modal');
    var h = d && d.querySelector('.modal-head h3');
    return { open: !!d, title: h ? h.innerText : '', textLen: d ? (d.innerText||'').length : 0, hash: location.hash };
  })()`);
  interactions.push({
    name: '监管端预警 → 处置弹窗',
    pass: alertBtn.ok && alertState.open && alertState.textLen > 120,
    detail: JSON.stringify({ click: alertBtn, panel: alertState }),
    shot: (await shoot('93-预警处置弹窗')).file,
  });

  // C5. 链上存证核验弹窗（Merkle 证明 + 多重验签）
  await loadRoute('ENTERPRISE', '/ent/reports');
  const proofBtn = await cdp.evaluate(`(function () {
    var btns = Array.prototype.filter.call(document.querySelectorAll('tbody button'), function (b) {
      return (b.innerText || '').trim() === '存证';
    });
    if (!btns.length) return { ok: false, why: '无存证按钮' };
    btns[0].click(); return { ok: true, label: (btns[0].innerText||'').trim() };
  })()`);
  await sleep(2600);
  const proofState = await cdp.evaluate(`(function(){
    var d = document.querySelector('.mask .modal');
    if (!d) return { open: false };
    var txt = (d.innerText || '').replace(/\\s+/g,' ');
    return {
      open: true, textLen: txt.length,
      readouts: d.querySelectorAll('.readout,.ro').length,
      merkle: /Merkle/.test(txt),
      signed: /验签|签名/.test(txt),
      head: txt.slice(0, 140),
    };
  })()`);
  interactions.push({
    name: '企业端存证按钮 → 链上核验弹窗（验签 + Merkle 路径）',
    pass: proofBtn.ok && proofState.open && proofState.merkle && proofState.textLen > 200,
    detail: JSON.stringify({ click: proofBtn, panel: proofState }),
    shot: (await shoot('94-链上存证核验')).file,
  });

  /* ---- D. 汇总 ---- */
  const passRoutes = results.filter((r) => r.pass).length;
  const passInter = interactions.filter((r) => r.pass).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    chain: { height: chain.height, totalTxs: chain.totalTxs },
    routes: { total: results.length, pass: passRoutes, fail: results.length - passRoutes },
    interactions: { total: interactions.length, pass: passInter, fail: interactions.length - passInter },
    failures: results.filter((r) => !r.pass).map((r) => ({
      route: r.route, role: r.role, label: r.label,
      booting: r.probe.booting, textLen: r.probe.textLen,
      logs: r.probe.logs, errorBars: r.probe.errorBars, unresolved: r.probe.unresolved,
      warns: r.probe.warns,
      shot: r.shot.file,
    })),
    interactionFailures: interactions.filter((r) => !r.pass),
    details: results.map((r) => ({
      route: r.route, role: r.role, label: r.label, pass: r.pass,
      textLen: r.probe.textLen, tables: r.probe.tables, rows: r.probe.rows,
      cards: r.probe.cards, charts: r.probe.charts, hash: r.probe.hash,
      logs: r.probe.logs, errorBars: r.probe.errorBars, shot: r.shot.file,
    })),
    interactions,
  };
  fs.writeFileSync(path.join(OUT, 'ui-report.json'), JSON.stringify(summary, null, 2), 'utf8');

  const md = [
    '# UI 巡检报告（无头 Edge + CDP 实测）',
    '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 站点：${BASE}　链高度：${chain.height}　累计存证：${chain.totalTxs}`,
    `- 路由渲染：**${passRoutes}/${results.length}** 通过`,
    `- 关键交互：**${passInter}/${interactions.length}** 通过`,
    '',
    '## 一、路由渲染明细',
    '',
    '| # | 角色 | 路由 | 页面 | 结果 | 文本量 | 表格 | 图表 | 控制台异常 |',
    '|---|------|------|------|------|--------|------|------|------------|',
    ...results.map((r, i) => `| ${i + 1} | ${r.role || '公众'} | \`${r.route}\` | ${r.label} | ${r.pass ? '✅' : '❌'} | ${r.probe.textLen} | ${r.probe.tables} | ${r.probe.charts} | ${r.probe.logs.length} |`),    '',
    '## 二、关键交互',
    '',
    '| 交互 | 结果 | 细节 | 截图 |',
    '|------|------|------|------|',
    ...interactions.map((x) => `| ${x.name} | ${x.pass ? '✅' : '❌'} | \`${x.detail}\` | \`${x.shot}\` |`),
    '',
  ];
  if (summary.failures.length) {
    md.push('## 三、失败明细', '');
    summary.failures.forEach((f) => {
      md.push(`### ${f.role || '公众'} ${f.route}（${f.label}）`, '');
      md.push(`- 仍在启动屏：${f.booting}　文本量：${f.textLen}　截图：\`${f.shot}\``);
      if (f.unresolved && f.unresolved.length) md.push('- 未解析标签：' + f.unresolved.map((s) => '`<' + s + '>`').join(' '));
      if (f.warns && f.warns.length) md.push('- 警告：\n' + f.warns.map((l) => `  - ${l.msg}`).join('\n'));
      if (f.errorBars && f.errorBars.length) md.push('- 页面错误条：' + f.errorBars.map((s) => '`' + s + '`').join('；'));
      if (f.logs && f.logs.length) md.push('- 控制台：\n' + f.logs.map((l) => `  - [${l.lvl}] ${l.msg}`).join('\n'));
      md.push('');
    });
  }
  if (summary.interactionFailures.length) {
    md.push('## 四、交互失败明细', '');
    summary.interactionFailures.forEach((f) => md.push(`- **${f.name}** → \`${f.detail}\``));
    md.push('');
  }
  fs.writeFileSync(path.join(OUT, 'ui-report.md'), md.join('\n'), 'utf8');

  console.log(`\n===== 路由 ${passRoutes}/${results.length}　交互 ${passInter}/${interactions.length} =====`);
  console.log('报告：artifacts/ui-report.md');
  summary.failures.forEach((f) => console.log(`FAIL ${f.role || 'PUBLIC'} ${f.route} logs=${JSON.stringify(f.logs)}`));

  try { ws.close(); } catch (e) { /* ignore */ }
  await killEdge(proc, profile);
  process.exit(0);
}

main().catch((e) => {
  console.error('巡检脚本异常：', e && e.stack || e);
  process.exit(1);
});
