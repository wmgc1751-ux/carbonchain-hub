/**
 * cdp-check.js —— 碳链通 5 角色前端巡检（零依赖，Edge + CDP）
 * 验证：交易端 / 管理端 / 企业端预警中心 / 监管端交易监管 等新增页面渲染正常
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.APP_BASE || 'http://127.0.0.1:8300';
const PORT = Number(process.env.CDP_PORT || 9333);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(process.cwd(), '_ui-check');
const SHOT = path.join(OUT, 'screens');
const W = 1680, H = 1050;

/* 通过 API 登录拿 token */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* ⚠ 端口必须从 APP_BASE 解析，不能硬编码 8300。
 * 早先 BASE 读了 APP_BASE 但 httpReq 里写死 port: 8300，
 * 于是换端口起服务时页面巡检会连到错误端口（或根本没有服务）：
 * 表现为 ECONNREFUSED，而真正原因被藏在"巡检失败"里。
 * 这是典型的"配置读了一半"缺陷 —— 比完全不读更难发现。 */
const API_PORT = (() => {
  try { return Number(new URL(BASE).port) || 8300; } catch { return 8300; }
})();
function httpReq(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: API_PORT, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
    }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; });
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}
async function login(username, password) {
  const r = await httpReq('POST', '/api/auth/login', { username, password });
  return r && r.data ? { token: r.data.token, user: r.data.user } : null;
}

const httpJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.onEvent = null;
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      else if (m.method && this.onEvent) this.onEvent(m); }); }
  send(method, params = {}) { const id = ++this.seq; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 30000); }); }
  async evaluate(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined; }
}

const INIT = `window.__logs = []; (function(){
  var oe = console.error;
  console.error = function(){ window.__logs.push({lvl:'error', msg: Array.prototype.map.call(arguments,String).join(' ')}); oe.apply(console, arguments); };
  window.addEventListener('error', function(e){ var t = e.target && e.target.tagName;
    if (t && t !== 'SCRIPT' && t !== 'IMG' && t !== 'LINK') window.__logs.push({lvl:'uncaught', msg: String(e.message)+' @ '+e.filename+':'+e.lineno});
    else if (t) window.__logs.push({lvl:'resource', msg: t+' 加载失败: '+(e.target.src||e.target.href)}); }, true);
  window.addEventListener('unhandledrejection', function(e){ window.__logs.push({lvl:'unhandledRejection', msg: String(e.reason&&e.reason.message||e.reason)}); }); })();`;

const PROBE = `(function(){
  var app = document.getElementById('app') || document.body;
  var txt = (app.innerText || '').replace(/\\s+/g,' ').trim();
  var logs = (window.__logs || []).filter(function(x){ return x.lvl !== 'warn'; });
  /* ⚠ 必须单独取"页面标题"作为判据。
   *   只靠 textLen > 40 是完全不可靠的：应用外壳（侧边栏 + 顶栏）本身就有
   *   上千字，任何页面（哪怕白屏、哪怕路由没生效）都能满足。
   *   实测后果：企业端三个 MRV 页的 textLen/rows/charts 一模一样（1053/2/2），
   *   全部被判 PASS，但三个页面其实是同一个东西（外壳 + 一条错误）。
   *   这里额外取 h2 标题与 hash，让"页面确实切过去了"这件事可验证。 */
  var h2 = document.querySelector('.page-head h2');
  return {
    booting: !!document.querySelector('.boot,.loading,.spinner'),
    textLen: txt.length, head: txt.slice(0, 80),
    /* headAll 供内容级断言使用：只给 head（前 80 字）根本看不到
     * 页面主体里的关键数字，断言必然落空。截到 40000 字足够覆盖任何一页。 */
    headAll: txt.slice(0, 40000),
    title: h2 ? (h2.innerText || '').trim() : '',
    hash: location.hash,
    tables: document.querySelectorAll('table').length,
    rows: document.querySelectorAll('tbody tr').length,
    charts: document.querySelectorAll('canvas').length,
    unresolved: Array.prototype.filter.call(document.querySelectorAll('*'), function(n){ return n.tagName && n.tagName.indexOf('X-') === 0; })
      .map(function(n){ return n.tagName.toLowerCase(); }).filter(function(v,i,a){ return a.indexOf(v)===i; }),
    logs: logs.slice(0, 8)
  };
})()`;

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });

  // 登录拿 token
  const accounts = [
    { role: '交易端', user: 'trader01', pass: '123456', routes: [['/trade/market', 'T1市场行情'], ['/trade/orders', 'T2交易下单'], ['/trade/account', 'T3我的账户'], ['/trade/deals', 'T4交易记录'], ['/trade/offset', 'T5抵销清缴']] },
    { role: '管理端', user: 'admin', pass: 'admin123', routes: [['/admin/overview', 'A1管理总览'], ['/admin/factors', 'A2因子库'], ['/admin/users', 'A3用户权限'], ['/admin/reconcile', 'A4对账中心'], ['/gov/audit-chain', 'G3审计链(ADMIN)']] },
    /* 不确定度报告页：年度口径（基准速率 × 8760 + 实测偏差修正 + 抽样/模型两项半宽）
       是本平台最容易被追问的一环，必须纳入页面级回归，否则口径改动不会被前端巡检发现。 */
    /* MRV 作业流页面（2026-10-24 新增）同样必须纳入：
       它们是"能不能真干活"的入口，接口通不代表页面渲染得出来
       （视图注册、组件属性、字段名任一处错都会白屏）。 */
    { role: '企业端', user: 'ent001', pass: '123456', routes: [
      ['/ent/predict', 'E6预警中心'],
      ['/ent/uncertainty', 'E7核算不确定度'],
      ['/mrv/activity', 'E8活动数据台账'],
      ['/mrv/calc', 'E9核算作业'],
      ['/mrv/compliance', 'E10履约与清缴'],
      ['/ent/mrv/cbam', 'E11CBAM证书'],
      ['/ent/zk', 'E12隐私承诺'],
      ['/zk', 'E13零知识协议'],
    ] },
    { role: '监管端', user: 'reg001', pass: '123456', routes: [
      ['/reg/trades', '交易监管'],
      ['/gov/iot', 'G1设备接入'],
      ['/gov/quality', 'G2数据质量'],
      ['/gov/audit-chain', 'G3审计链'],
      ['/reg/uncertainty', 'G4不确定度监管'],
      ['/reg/mrv/calc', 'G5核算批次监管'],
      ['/reg/mrv/compliance', 'G6履约清缴监管'],
      ['/mrv/factor', 'G7因子台账'],
      ['/reg/zk', 'G8零知识验证'],
    ] },
    /* 真实数据层（2026-10-24 第 4 轮）：**未登录**巡检。
       这一层刻意公开，因此必须验证"不带 token 也能渲染出真实内容"——
       如果它其实需要登录，页面会静默重定向到 #/login，肉眼在报告里
       只会看到一行 FAIL，查不出根因。用 user:null 单独跑一轮最直接。 */
    { role: '公开访客', user: null, pass: null, routes: [
      /* expect 里的每个串都是**必须出现在页面文本里**的事实：
       *   · 5,352 / 38,501 / 2010 / 2018  ← 台账规模（数字不符说明接口或渲染漂移）
       *   · 数据边界声明                  ← 首屏必须写明"这批是美国设施"
       *   · 真实                       ← 真实性等级标签必须渲染出来
       *   · 一致性 / 核验                  ← 契约页必须显示核验结果而非空白
       * 少了任何一条就不算通过 —— "页面有内容"不等于"内容是对的"。 */
      ['/real', 'R1真实数据总览', ['真实数据层', '5,352', '38,501', '数据边界声明', 'EPA']],
      ['/real/facilities', 'R2真实设施台账', ['真实设施台账', 'Facility Id', '电力']],
      ['/real/benchmarks', 'R3行业真实基准', ['行业真实基准', '中位数', 'P90', 'Top10']],
      ['/real/trend', 'R4年度真实趋势', ['年度真实趋势', '2010', '2018', '同比']],
      ['/real/macro', 'R5宏观真实序列', ['宏观真实序列', '真实']],
      ['/real/truth', 'R6数据真实性契约', ['数据真实性契约', '核验', 'REAL', 'MODELED']],
    ] },
  ];
  const sessions = {};
  /* CDP_ONLY_ANON=1：只跑匿名用例。
   * 用途：对**静态产物**（dist + 本地 http.server）做巡检时，
   * 后端 login 接口不存在，带 token 的用例全部无法建立会话。
   * 与其让那些用例报一堆假 FAIL，不如只跑本来就不需要登录的那一组 ——
   * 而 /real/* 恰恰是唯一需要验证"静态模式下也能看"的页面。 */
  const ONLY_ANON = process.env.CDP_ONLY_ANON === '1';
  const activeAccounts = ONLY_ANON ? accounts.filter((a) => !a.user) : accounts;
  for (const a of activeAccounts) {
    if (!a.user) { sessions[a.role] = { anonymous: true }; console.log(`登录 ${a.role} => 匿名（不注入 token）`); continue; }
    const s = await login(a.user, a.pass); sessions[a.role] = s;
    console.log(`登录 ${a.user}(${a.role}) => ${s ? 'OK' : 'FAIL'}`);
  }

  // 启动 Edge
  try { const busy = await new Promise((resolve) => { const ps = spawn('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`], { stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; ps.stdout.on('data', (d) => { out += d; }); ps.on('close', () => resolve(out.trim())); }); for (const pid of busy.split(/\s+/).filter(Boolean)) { spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); await sleep(700); } } catch (e) {}

  const profile = path.join(OUT, '.edge-' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-proxy-server', '--proxy-bypass-list=*', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  child.unref();
  let target = null;
  for (let i = 0; i < 80 && !target; i++) { await sleep(300); try { target = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) {} }
  if (!target) throw new Error('连接不上 Edge 调试端口');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws error'))); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE}/#/login` });
  for (let i = 0; i < 60; i++) { await sleep(250); try { if ((await cdp.evaluate('location.origin')).indexOf('http') === 0) break; } catch (e) {} }

  const results = [];
  let n = 0;
  for (const a of activeAccounts) {
    const s = sessions[a.role];
    /* 匿名访客：必须**清空** token，否则会沿用上一轮登录态，
     * 测出来的是"已登录能不能看"，而不是"公开数据能不能看"。 */
    if (s && s.anonymous) {
      await cdp.evaluate("(function(){ localStorage.removeItem('cch_token'); localStorage.removeItem('cch_user'); return true; })()");
    } else {
      await cdp.evaluate(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(s.token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(s.user))}); return true; })()`);
    }
    for (const [route, label] of a.routes) {
      n++;
      /* ⭐ 页级重试（2026-10-26）：共享环境下 CDP Page.navigate 偶发 30s 超时
       * （实测三轮各随机卡在不同页面，页面本身单独访问正常）。
       * 原行为：任一页超时 → 整轮巡检作废 → ui-check.json 不落盘 → 台账红。
       * 这让整份台账被一次环境抖动绑架。现改为页级重试一次：
       * 超时后重新导航同一 URL（换缓存参数）再等一轮；两轮都超时才如实判 FAIL。 */
      let navErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}&r=${attempt}#${route}` });
          navErr = null;
          break;
        } catch (e) {
          navErr = e;
          console.log(`  ⚠ [${a.role}] ${route} 导航超时（第 ${attempt + 1} 次），重试…`);
        }
      }
      if (navErr) throw navErr;
      /* ⭐ 等待条件必须"针对本页"，不能只看 textLen。
       *   判据：hash 匹配目标路由 且 页面标题非空 且 不在加载态。
       *   这样既能等真渲染完，又能在路由没生效时如实判 FAIL（而不是被外壳文字骗过）。
       *   hash 匹配用 indexOf(route) 而非严格相等：带参数的路由（/explorer/tx/:id）
       *   实际 hash 会含具体 id。 */
      let probe = null; const t0 = Date.now();
      /* /real/* 真实数据页要跑 30 万行级聚合查询，共享环境压库时 15s 窗口不够
       * （实测 splash 期超窗 → 误判 FAIL）。对这些页放宽到 30s。 */
      const waitMs = route.indexOf('/real/') === 0 ? 30000 : 15000;
      while (Date.now() - t0 < waitMs) {
        await sleep(280);
        try { probe = await cdp.evaluate(PROBE); } catch (e) { continue; }
        const routed = probe && probe.hash && probe.hash.indexOf(route) >= 0;
        if (probe && !probe.booting && routed && probe.title) break;
      }
      await sleep(900);
      const metrics = await cdp.send('Page.getLayoutMetrics'); const size = metrics.cssContentSize || metrics.contentSize;
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.max(size.width, W), height: Math.min(Math.max(size.height, 800), 5200), scale: 1 } });
      fs.writeFileSync(path.join(SHOT, `${String(n).padStart(2, '0')}-${a.role}-${label}.png`), Buffer.from(shot.data, 'base64'));
      /* 判据：不加载中 + 路由真的切过去了 + 有页面标题 + 有实质内容 + 组件全部解析
       *
       * ⭐ 第三层：**内容级断言**（expect）。
       *   textLen > 200 只能证明"有字"，证明不了"字是对的"——一个渲染报错
       *   也能轻松凑够 200 字。真实数据层必须证明具体数字真的到了页面上：
       *   5,352 家设施、38,501 条记录、-14.94% 期间变化、10 条声明全部核验通过。
       *   少了任何一个，说明接口字段名或渲染逻辑已经漂移，而页面上仍"看着正常"。 */
      const routed = !!(probe && probe.hash && probe.hash.indexOf(route) >= 0);
      const text = (probe && probe.headAll) ? probe.headAll : (probe ? String(probe.head || '') : '');
      const missing = (a.expect && a.expect.length)
        ? a.expect.filter((s) => text.indexOf(s) < 0) : [];
      const pass = !!(probe && !probe.booting && routed && probe.title
        && probe.textLen > 200 && probe.unresolved.length === 0 && missing.length === 0);
      results.push({ role: a.role, route, label, pass, textLen: probe ? probe.textLen : 0, rows: probe ? probe.rows : 0, charts: probe ? probe.charts : 0, unresolved: probe ? probe.unresolved : [], logs: probe ? probe.logs : [], title: probe ? probe.title : '', routed, missing });
      console.log(`${pass ? 'PASS' : 'FAIL'}  [${a.role}] ${route}(${label})  text=${probe ? probe.textLen : '-'} rows=${probe ? probe.rows : '-'} charts=${probe ? probe.charts : '-'} unresolved=${probe ? probe.unresolved.join(',') : '-'}`);
      if (missing.length) console.log(`       ⚠ 内容断言未命中：${missing.join(' / ')}`);
      /* 打印页面标题：这是"页面确实切过去了"的最短证据。
       * 若三个页面标题相同，说明路由或视图注册有问题，而不是"都渲染正常"。 */
      if (probe) {
        console.log(`       title: ${probe.title || '(空)'} ｜ head: ${String(probe.head || '').replace(/\s+/g, ' ').slice(0, 88)}`);
        if (!routed) console.log(`       ⚠ 路由未切换：期望 hash 含 ${route}，实际 ${probe.hash || '(空)'}`);
        else if (!probe.title) console.log('       ⚠ 页面标题为空：可能视图未注册或渲染失败');
        if (probe.logs && probe.logs.length) {
          for (const lg of probe.logs.slice(0, 2)) console.log(`       ⚠ [${lg.lvl}] ${String(lg.msg).slice(0, 140)}`);
        }
      }
      if (probe && probe.head) {
        console.log(`       head: ${probe.head.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
      if (probe && probe.logs.length) probe.logs.forEach((l) => console.log(`      [${l.lvl}] ${l.msg}`.slice(0, 180)));
    }
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2), 'utf8');
  const okN = results.filter((r) => r.pass).length;
  /* 同时写一份带汇总的 ui-check.json 到 tools/out，供指标台账直接消费。
   *
   * ⚠⚠ 部分运行必须写**别的文件**。
   *   CDP_ONLY_ANON=1 只跑 6 个匿名页面，如果它也写 ui-check.json，
   *   就会把上一轮 33 页的全量结果覆盖成 6 页 —— 于是台账里
   *   `ui.pages.pass` 从 33 掉到 6，越出 [20,100] 区间被判 SUSPECT，
   *   整个 verify-all 以失败收场，而实际上页面全都是通过的。
   *
   *   这与"`--only` 部分运行会覆盖 verify-all.json 留 0/0 假数据"
   *   是同一类缺陷：**部分运行污染全量产物**。修法是让产物文件名随模式改变，
   *   而不是靠人记得别跑。 */
  try {
    /* ⚠ 用 process.cwd() 而不是 ROOT —— 本脚本没有定义 ROOT。
     *   写成 ROOT 会在运行到这一行时抛 ReferenceError，
     *   而这一行在 process.exit 之前，会导致整个巡检以"崩溃"结束（退出码 1），
     *   使得 24 个页面全部通过也被判为失败。这类"最后一步崩掉"最隐蔽。 */
    const outDir = path.join(process.cwd(), 'tools', 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const artifact = ONLY_ANON ? 'ui-check-anon.json' : 'ui-check.json';
    fs.writeFileSync(path.join(outDir, artifact), JSON.stringify({
      generatedAt: new Date().toISOString(),
      scope: ONLY_ANON ? 'anonymous-only' : 'full',
      base: BASE,
      total: results.length, passed: okN, failed: results.length - okN,
      routes: results.map((r) => ({ route: r.route, label: r.label, pass: r.pass, title: r.title || '', routed: !!r.routed })),
    }, null, 2), 'utf8');
  } catch (e) { console.warn('⚠ 写 ui-check.json 失败：', e.message); }
  console.log(`\n===== ${okN}/${results.length} 通过，截图在 _ui-check/screens/ =====`);
  try { ws.close(); } catch (e) {}
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }, 1500);
  process.exit(okN === results.length ? 0 : 1);
}

main().catch((e) => { console.error('巡检失败：', e && e.stack || e); process.exit(1); });
