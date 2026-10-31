#!/usr/bin/env node
/**
 * tools/_qa/deep-audit.cjs —— 深度交互审计（真点、全覆盖、带调用栈）
 * ==================================================================
 * 与 tools/console-audit.mjs 的区别（为什么还要这个）：
 *   · console-audit 每页只点前 8 个按钮，且不碰页签/下拉/搜索/分页 ——
 *     2026-10-28 用户截图里的 "Cannot read properties of undefined (reading 'length')"
 *     就是这样漏掉的（它由某个非前 8 位的控件触发）。
 *   · 本工具点**全部**可见控件：按钮、页签、分段器、下拉、搜索框、分页、图标按钮。
 *   · 关键增强：包装 App.notify.err，在**报错发生的那一刻**抓 new Error().stack，
 *     直接指出是哪个 view 文件的哪一行把异常吞成了 toast。console-audit 只记录
 *     消息文本，定位不到代码行。
 *
 * 判定口径（与 console-audit 一致）：
 *   点击后出现 uncaught / console.error / 接口 4xx-5xx / 错误 toast ⇒ 记为缺陷。
 *   "请填写""请选择"这类表单校验提示不算缺陷。
 *
 * 安全：DENY 清单内的破坏性/写链动作一律不点。
 *
 * 用法：
 *   node tools/_qa/deep-audit.cjs --role ENTERPRISE --port 9431
 *   node tools/_qa/deep-audit.cjs --role ADMIN --port 9435 --max 25
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');
const WebSocket = globalThis.WebSocket || require('ws');

const argOf = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const BASE = argOf('base', 'http://127.0.0.1:8300');
const PORT = Number(argOf('port', 9431));
const ONLY_ROLE = argOf('role', null);
const MAX_CTRL = Number(argOf('max', 999));
const OUT = path.resolve(argOf('out', '_ui-check/deep'));

const ACCOUNTS = [
  { user: 'admin', pass: 'admin123', role: 'ADMIN' },
  { user: 'reg001', pass: '123456', role: 'REGULATOR' },
  { user: 'ent001', pass: '123456', role: 'ENTERPRISE' },
  { user: 'ver001', pass: '123456', role: 'VERIFIER' },
  { user: 'trader01', pass: '123456', role: 'TRADER' },
];

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 破坏性动作：不点（含防篡改实验台的"模拟恶意篡改"，点了会把真实链改脏） */
const DENY = /退出|登出|删除|移除|清缴|下单|买入|卖出|挂牌|成交|提交|确认|签发|注销|重置|清空|回滚|停止|启动|上链|拨款|分配|审核|通过|驳回|撤销|冻结|解锁|烧录|部署|销毁|解约|支付|转账|申购|赎回|篡改|改写|重新出块|出块并修复|导出|下载/;

function httpJson(pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: new URL(BASE).port || 8300, path: pathname, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
    }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; });
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}, timeout = 45000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, timeout);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text;
      throw new Error('eval: ' + String(d).slice(0, 240));
    }
    return r.result ? r.result.value : undefined;
  }
  async json(expr) {
    const raw = await this.eval(`(async function(){ ${expr} })().then(function(v){ return JSON.stringify(v); })`);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

/* 注入探针：
 *  ① 抓 uncaught / console.error / rejection，**带 stack**
 *  ② 包装 App.notify.err —— 这是本项目把异常显示成红色 toast 的唯一通道。
 *     在它被调用的瞬间取 new Error().stack，栈里第 2 帧就是抛出点的调用者
 *     （即哪个 view 的哪一行 catch 到了异常），这是定位"toast 报错"的关键。
 */
const HOOK = `(function(){
  if (window.__auditHooked) return; window.__auditHooked = true;
  window.__audit = { logs: [], net: [], errToasts: [] };

  var oe = console.error;
  console.error = function(){
    var st = '';
    try { st = (new Error()).stack || ''; } catch(e){}
    window.__audit.logs.push({ kind:'console.error', msg: Array.prototype.map.call(arguments,String).join(' '), stack: st });
    oe.apply(console, arguments);
  };
  window.addEventListener('error', function(e){
    window.__audit.logs.push({
      kind:'uncaught', msg: String(e.message),
      where: (e.filename||'') + ':' + (e.lineno||0) + ':' + (e.colno||0),
      stack: (e.error && e.error.stack) || ''
    });
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    window.__audit.logs.push({
      kind:'rejection', msg: String(e.reason && e.reason.message || e.reason),
      stack: (e.reason && e.reason.stack) || ''
    });
  });

  /* App.notify.err 包装（轮询等 App 挂载） */
  var tries = 0;
  var iv = setInterval(function(){
    if (window.App && App.notify && typeof App.notify.err === 'function' && !App.notify.err.__wrapped) {
      var orig = App.notify.err.bind(App.notify);
      var wrapped = function(msg){
        var st = '';
        try { st = (new Error()).stack || ''; } catch(e){}
        window.__audit.errToasts.push({ msg: String(msg), stack: st });
        return orig.apply(null, arguments);
      };
      wrapped.__wrapped = true;
      App.notify.err = wrapped;
      clearInterval(iv);
    }
    if (++tries > 400) clearInterval(iv);
  }, 25);

  var of = window.fetch;
  if (of) window.fetch = function(){
    var url = arguments[0];
    var u = (typeof url === 'string') ? url : (url && url.url) || '';
    return of.apply(this, arguments).then(function(r){
      if (!r.ok) window.__audit.net.push(r.status + ' ' + String(u).slice(0, 200));
      return r;
    }, function(e){
      var m = String(e && e.message || e);
      if (!/abort/i.test(m) && !(e && e.name === 'AbortError')) {
        window.__audit.net.push('NETFAIL ' + String(u).slice(0, 200) + ' · ' + m);
      }
      throw e;
    });
  };
})();`;

const problems = [];
const report = { startedAt: new Date().toISOString(), base: BASE, roles: [] };

function log(...a) { console.log(...a); }

/* 采集本页可交互控件（全量，分五类） */
const ENUM = `
  var scope = document.querySelector('.content') || document.body;
  function vis(el){ return !!(el.offsetParent || el.getClientRects().length) && el.offsetWidth > 0; }
  function txt(el){
    return (el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
  }
  var out = { tabs: [], buttons: [], selects: [], inputs: [], pagers: [] };
  var seen = {};
  function push(kind, el, extra){
    var t = txt(el);
    var key = kind + '|' + t + '|' + String(el.className||'');
    if (seen[key]) return; seen[key] = 1;
    var o = { text: t.slice(0, 50), cls: String(el.className||'').slice(0, 70), disabled: el.disabled === true };
    if (extra) Object.keys(extra).forEach(function(k){ o[k] = extra[k]; });
    out[kind].push(o);
  }
  Array.prototype.forEach.call(scope.querySelectorAll('[role="tab"], .tab, .seg-item, .tabs .tab, .seg button'), function(el){
    if (vis(el) && txt(el)) push('tabs', el);
  });
  Array.prototype.forEach.call(scope.querySelectorAll('button, [role="button"], a.btn'), function(el){
    if (vis(el) && txt(el)) push('buttons', el);
  });
  Array.prototype.forEach.call(scope.querySelectorAll('select'), function(el){
    if (vis(el)) push('selects', el, { value: el.value, options: Array.prototype.map.call(el.options, function(o){ return o.value; }) });
  });
  Array.prototype.forEach.call(scope.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'), function(el){
    if (vis(el)) push('inputs', el, { ph: el.getAttribute('placeholder') || '' });
  });
  Array.prototype.forEach.call(scope.querySelectorAll('.pager button, .pagination button, .pg button, [class*="page-btn"]'), function(el){
    if (vis(el) && txt(el)) push('pagers', el);
  });
  return out;
`;

/* 执行一个交互并采集差异 */
function ACT(kind, text, optVal) {
  return `
  return (async function(){
    var kind = ${JSON.stringify(kind)}, want = ${JSON.stringify(text)};
    var scope = document.querySelector('.content') || document.body;
    function vis(el){ return !!(el.offsetParent || el.getClientRects().length) && el.offsetWidth > 0; }
    function txt(el){ return (el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim(); }
    var sel = { tabs: '[role="tab"], .tab, .seg-item, .tabs .tab, .seg button',
                buttons: 'button, [role="button"], a.btn',
                selects: 'select',
                inputs: 'input[type="text"], input[type="search"], input:not([type])',
                pagers: '.pager button, .pagination button, .pg button, [class*="page-btn"]' }[kind];
    var target = null;
    Array.prototype.forEach.call(scope.querySelectorAll(sel), function(el){
      if (target) return;
      if (!vis(el) || el.disabled) return;
      if (txt(el) === want) target = el;
    });
    if (!target) return { skipped: true };

    var bLogs = (window.__audit.logs||[]).length;
    var bToasts = (window.__audit.errToasts||[]).length;
    var bNet = (window.__audit.net||[]).length;
    var bHash = location.hash;
    var bText = ((document.querySelector('.content')||document.body).innerText||'').length;

    try {
      if (kind === 'inputs') {
        target.focus(); target.value = '煤'; 
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      } else if (kind === 'selects') {
        var opts = Array.prototype.map.call(target.options, function(o){ return o.value; });
        var nv = ${JSON.stringify(optVal)} || (opts.length > 1 ? opts[1] : opts[0]);
        target.value = nv;
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        target.click();
      }
    } catch (e) {
      return { threw: String(e && e.message), stack: (e && e.stack) || '' };
    }

    await new Promise(function(r){ setTimeout(r, 520); });

    var logs = (window.__audit.logs||[]).slice(bLogs);
    var toasts = (window.__audit.errToasts||[]).slice(bToasts);
    var net = (window.__audit.net||[]).slice(bNet);
    var aText = ((document.querySelector('.content')||document.body).innerText||'').length;
    var overlay = !!document.querySelector('.mask, .drawer-mask, .cmdk-mask, .modal-mask');

    /* 清理：关浮层，避免影响后续控件 */
    if (overlay) {
      Array.prototype.forEach.call(document.querySelectorAll('.mask, .drawer-mask, .cmdk-mask, .modal-mask'), function(m){
        var x = m.querySelector('.x, .drawer-head .x, .modal-head .x, .close');
        if (x) { try { x.click(); } catch (e) {} }
      });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(function(r){ setTimeout(r, 180); });
    }
    return {
      logs: logs, toasts: toasts, net: net, overlay: overlay,
      hashChanged: location.hash !== bHash, textDelta: aText - bText,
      /* 单帧调用栈：toast 事件里第 2~4 帧通常已指向触发控件所在的 view 文件 */
      caller: (new Error()).stack ? String((new Error()).stack).split('\\n').slice(2,6).join(' | ') : ''
    };
  })();
  `;
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_deep_'));
  fs.mkdirSync(OUT, { recursive: true });
  let child = null; let cdp = null;
  try {
    child = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--window-size=1440,1000', 'about:blank',
    ], { stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      try {
        const list = await new Promise((res, rej) => {
          http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => {
            let d = ''; r.on('data', (c) => { d += c; });
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
          }).on('error', rej);
        });
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch (e) { /* not ready */ }
    }
    if (!target) throw new Error('无法连接调试端口');

    cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
    await sleep(200);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

    for (const acc of ACCOUNTS) {
      if (ONLY_ROLE && acc.role !== ONLY_ROLE) continue;
      log(`\n════ ${acc.role}（${acc.user}）════`);
      const login = await httpJson('/api/auth/login', 'POST', { username: acc.user, password: acc.pass });
      const token = login && login.data && login.data.token;
      const user = login && login.data && login.data.user;
      if (!token) { log(`  ✘ 登录失败`); continue; }

      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
      await sleep(2000);
      await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);

      /* 写 token 后必须**整页重载**：Store 在模块初始化时读 localStorage，
       * 只改 hash 不换文档的话 App.Store.user 仍是旧值（role=null），
       * 导致 MENUS[role] 取不到、整轮审计扫出 0 个控件。 */
      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}${acc.role === 'TRADER' ? '#/trade/market' : '#/login'}` }, 45000);
      /* 等 SPA 真正就绪：App 挂载 + Store.user.role 已对上 + MENUS 非空。
       * 固定 sleep 不够稳（机器忙时 boot 会被拖慢），这里轮询到条件成立为止。 */
      const ready0 = Date.now();
      let menuReady = false;
      while (Date.now() - ready0 < 30000) {
        await sleep(300);
        try {
          menuReady = await cdp.eval(`(function(){
            if (!window.App || !App.Store || !App.routeAccess) return false;
            var role = App.Store.user && App.Store.user.role;
            if (!role) return false;
            var g = (App.routeAccess.MENUS || {})[role];
            return !!(g && g.length);
          })()`);
          if (menuReady) break;
        } catch (e) { /* 仍在 boot */ }
      }
      if (!menuReady) { log('  ✘ SPA 未就绪，跳过该角色'); problems.push({ role: acc.role, kind: 'boot', msg: 'SPA 未就绪' }); continue; }

      const routes = await cdp.json(`
        var ra = App.routeAccess || {}; var out = []; var seen = {};
        var role = App.Store.user && App.Store.user.role;
        ((ra.MENUS || {})[role] || []).forEach(function(g){ (g.items||[]).forEach(function(it){
          if (seen[it.path]) return; seen[it.path]=1; out.push({ path: it.path, label: it.label });
        }); });
        return out;
      `);

      const roleReport = { role: acc.role, user: acc.user, pages: [], totals: { ctrl: 0, acted: 0, bad: 0 } };
      for (const r of routes) {
        let ready = false;
        try {
          await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${r.path}` }, 60000);
        } catch (e) { /* 超时也继续探 */ }
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
          await sleep(300);
          try {
            const p = await cdp.json(`
              var h2 = document.querySelector('.page-head h2') || document.querySelector('.matrix-title')
                    || document.querySelector('.screen-head h1') || document.querySelector('.screen-title')
                    || document.querySelector('.content h1');
              return { hash: location.hash, title: h2 ? (h2.innerText||'').trim() : '', boot: !!document.querySelector('.boot') };
            `);
            if (p && !p.boot && p.hash.indexOf(r.path) >= 0 && p.title) { ready = true; break; }
          } catch (e) { /* 继续等 */ }
        }
        if (!ready) { log(`  ?  ${r.path} 未就绪，跳过`); continue; }
        await sleep(400);

        /* 清空本页审计缓冲 */
        await cdp.eval(`(function(){ window.__audit.logs.length=0; window.__audit.net.length=0; window.__audit.errToasts.length=0; return 1; })()`).catch(() => 0);

        const inv = await cdp.json(ENUM).catch(() => ({ tabs: [], buttons: [], selects: [], inputs: [], pagers: [] }));
        const page = { path: r.path, label: r.label, ctrl: 0, acted: 0, bad: [] };

        const plan = [];
        inv.tabs.forEach((c) => plan.push(['tabs', c.text, null]));
        inv.buttons.filter((c) => !DENY.test(c.text)).forEach((c) => plan.push(['buttons', c.text, null]));
        inv.pagers.forEach((c) => plan.push(['pagers', c.text, null]));
        inv.selects.forEach((c) => plan.push(['selects', c.text || '(select)', (c.options && c.options.length > 1) ? c.options[1] : null]));
        inv.inputs.slice(0, 3).forEach((c) => plan.push(['inputs', c.text || c.ph || '(input)', null]));

        page.ctrl = plan.length;
        const limited = plan.slice(0, MAX_CTRL);

        /* 点击会改变页面状态（弹窗、换页签、表格重排），一次枚举出来的控件列表
         * 点到中途就失效——实测覆盖率只有 40% 左右。改成分批：每批点 6 个就
         * 重新导航回本页、重新枚举、跳过已点过的，直到扫完或轮次用尽。 */
        const done = new Set();
        const STALE = 6;
        for (let round = 0; round < 10; round++) {
          let batch = 0;
          for (const [kind, text, opt] of limited) {
            const key = kind + '|' + text;
            if (done.has(key)) continue;
            if (batch >= STALE) break;
            done.add(key);
            batch++;
            const res = await cdp.json(ACT(kind, text, opt)).catch((e) => ({ threw: e.message }));
            if (!res || res.skipped) continue;
            page.acted++;
            const errToasts = (res.toasts || []).filter((t) => !/请填写|请选择|请先|不能为空|格式不|请输入|至少|最多|超出|无权限|无权访问/.test(String(t.msg)));
            const logErrs = (res.logs || []).filter((l) =>
              l.kind === 'uncaught' || l.kind === 'rejection' || /TypeError|ReferenceError|is not a function|Cannot read/.test(l.msg));
            const netErrs = (res.net || []).filter((n) => !/^4\d\d .*\/api\/(auth|chain\/tamper)/.test(n));
            const bad = (res.threw ? 1 : 0) + errToasts.length + logErrs.length + netErrs.length;
            if (bad) {
              page.bad.push({
                kind, text, threw: res.threw || null,
                toasts: errToasts, logs: logErrs, net: netErrs,
              });
              const first = errToasts[0] ? errToasts[0].msg
                : (logErrs[0] ? logErrs[0].msg : (netErrs[0] || res.threw));
              log(`  ✘ ${r.path.padEnd(24)} [${kind}]「${String(text).slice(0, 18)}」→ ${String(first).slice(0, 90)}`);
              problems.push({
                role: acc.role, path: r.path, label: r.label, kind, ctrl: text,
                msg: String(first),
                stack: (errToasts[0] && errToasts[0].stack) || (logErrs[0] && logErrs[0].stack) || '',
                net: netErrs,
              });
            }
          }
          if (done.size >= limited.length) break;
          try {
            await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${r.path}` }, 40000);
            await sleep(2600);
            await cdp.eval(`(function(){ window.__audit.logs.length=0; window.__audit.net.length=0; window.__audit.errToasts.length=0; return 1; })()`).catch(() => 0);
          } catch (e) { break; }
        }

        roleReport.totals.ctrl += page.ctrl;
        roleReport.totals.acted += page.acted;
        roleReport.totals.bad += page.bad.length;
        roleReport.pages.push(page);
        if (!page.bad.length) log(`  ✔ ${r.path.padEnd(24)} 控件 ${page.acted}/${page.ctrl}`);
      }
      report.roles.push(roleReport);
      log(`  ── ${acc.role}：控件 ${roleReport.totals.acted}/${roleReport.totals.ctrl}｜异常 ${roleReport.totals.bad}`);
    }

    report.problems = problems;
    report.finishedAt = new Date().toISOString();
    const f = path.join(OUT, `deep-${ONLY_ROLE || 'ALL'}-${PORT}.json`);
    fs.writeFileSync(f, JSON.stringify(report, null, 2), 'utf8');
    log(`\n已写出 ${f}；异常 ${problems.length} 项`);
    if (problems.length) {
      log('\n──────── 缺陷明细 ────────');
      problems.forEach((p, i) => {
        log(`\n[${i + 1}] ${p.role} ${p.path} · ${p.kind}「${p.ctrl}」`);
        log(`    消息：${p.msg}`);
        if (p.stack) log(`    调用栈：${String(p.stack).split('\n').slice(0, 5).join('\n           ')}`);
      });
    }
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) { /* ignore */ }
    try { if (child) child.kill(); } catch (e) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error('深度审计异常：', e.message); process.exit(2); });
