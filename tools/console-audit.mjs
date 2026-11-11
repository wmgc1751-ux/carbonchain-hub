/* =====================================================================
   console-audit.mjs —— 全角色控制台审计（真实浏览器逐页逐按钮）
   ---------------------------------------------------------------------
   要回答的问题不是"页面能不能打开"，而是：
     ① 每个角色的每个入口，页面是否真的渲染出来、有没有未解析组件；
     ② 接口有没有失败（4xx/5xx/网络错误），失败后页面是白屏还是给了提示；
     ③ 页面上的**每一个按钮是否真的绑了事件** —— 即"点了没反应"的按钮；
     ④ 安全点击之后有没有抛异常、有没有弹错误提示。

   ③ 的判据：Vue 3 在元素上挂 `_vei`（vnode event invokers）缓存，
   只要 h('button', { onClick }) 绑过事件，元素上就有 `_vei.onClick`。
   没有 `_vei`、也没有原生 onclick、也不是 form 的 submit 按钮
   ⇒ 这个按钮**视觉上可点、实际什么都不做**。这是纯静态判定，不产生副作用。

   ④ 的判据：点击后的 expect 是"要么什么都没有发生（打开弹窗也是"，但
   绝不能出现 uncaught / console.error / 红色 toast / 4xx-5xx 请求。
   破坏性动作（提交、下单、清缴、删除…）按 denylist 跳过 —— 见 §安全策略。

   用法：
     node tools/console-audit.mjs                # 全角色全页面
     node tools/console-audit.mjs --role REGULATOR
     node tools/console-audit.mjs --no-click     # 只做静态审计，不点任何按钮
     node tools/console-audit.mjs --base http://127.0.0.1:8300
   ===================================================================== */
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argOf = (k, dflt) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (k) => process.argv.includes('--' + k);

const BASE = argOf('base', 'http://127.0.0.1:8300');
const PORT = Number(argOf('port', 9423));
const ONLY_ROLE = argOf('role', null);
const ONLY_PATHS = (argOf('path', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DO_CLICK = !has('no-click');
const OUT = path.resolve(argOf('out', '_ui-check/audit'));

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 账号 */
const ACCOUNTS = [
  /* 2026-10-29 巡检附注：原来写死 ent001，而该账号已从演示身份列表移除
   * （现以保定四家真实企业为主体，ent_zjbd 等 12 个岗位账号）。脚本按此
   * 登录会 401，整轮企业端被静默跳过 —— 零缺陷的假象正来自这里。 */
  { role: 'ENTERPRISE', user: 'ent_zjbd', pass: '123456' },
  { role: 'ADMIN', user: 'admin', pass: 'admin123' },
  /* 2026-11-01 统一口径：登录页下拉就是这 8 个，审计必须逐账号全覆盖。
   * ver001 已不在演示清单（核查端席位 = ver_cz_review）；四家企业同 UI
   * 不同数据，逐家全跑才能回答"每一个演示账号的每一个界面"。 */
  { role: 'VERIFIER', user: 'ver_cz_review', pass: '123456' },
  { role: 'REGULATOR', user: 'reg001', pass: '123456' },
  { role: 'TRADER', user: 'trader01', pass: '123456' },
  { role: 'ENTERPRISE', user: 'ent_yfkw', pass: '123456' },
  { role: 'ENTERPRISE', user: 'ent_yxyf', pass: '123456' },
  { role: 'ENTERPRISE', user: 'ent_zjyls', pass: '123456' },
];

/* ---------------------------------------------------------------- HTTP */
function httpJson(pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    /* 2026-11-01：支持远程 --base（ECS / www）。原实现写死 127.0.0.1，
     * --base 指向线上时登录请求仍打到本机，整轮审计全部 401。 */
    const u = new URL(BASE);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: pathname, method,
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

/* ---------------------------------------------------------------- CDP */
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
  /* 默认 45 s（原 30 s）：重数据页的 Runtime.evaluate 在连续巡检中常超过 30 s，
     一旦超时整页结果丢失，容易被误判成"页面卡死"。 */
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

/* ------------------------------------------------- 注入到每个新文档的探针 */
const HOOK = `(function(){
  if (window.__auditHooked) return; window.__auditHooked = true;
  window.__audit = { logs: [], net: [], toasts: [] };

  var oe = console.error;
  console.error = function(){
    window.__audit.logs.push('console.error: ' + Array.prototype.map.call(arguments,String).join(' '));
    oe.apply(console, arguments);
  };
  window.addEventListener('error', function(e){
    window.__audit.logs.push('uncaught: ' + String(e.message) + ' @ ' + (e.filename||'') + ':' + (e.lineno||0));
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    window.__audit.logs.push('rejection: ' + String(e.reason && e.reason.message || e.reason));
  });

  /* 网络：fetch */
  var of = window.fetch;
  if (of) window.fetch = function(){
    var url = arguments[0];
    var u = (typeof url === 'string') ? url : (url && url.url) || '';
    return of.apply(this, arguments).then(function(r){
      if (!r.ok) window.__audit.net.push(r.status + ' ' + String(u).slice(0, 160));
      return r;
    }, function(e){
      /* ⚠ 主动取消不算失败：core.js 在离开页面时会 abort 未完成的请求，
         把 AbortError 记成"接口失败"会让每一页都背一条假告警，
         最后没人再看这份报告。 */
      var msg = String(e && e.message || e);
      if (!/abort/i.test(msg) && !(e && e.name === 'AbortError')) {
        window.__audit.net.push('NETFAIL ' + String(u).slice(0, 160) + ' · ' + msg);
      }
      throw e;
    });
  };
  /* 网络：XHR（core.js 走的是 fetch，但第三方可能走 XHR） */
  var ox = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
  if (ox) {
    window.XMLHttpRequest.prototype.open = function(m, u){
      var self = this;
      self.__u = u;
      self.addEventListener('loadend', function(){
        if (self.status >= 400) window.__audit.net.push(self.status + ' ' + String(u).slice(0, 160));
      });
      return ox.apply(this, arguments);
    };
  }
})();`;

/* ------------------------------------------------------------------ 主流程 */
const report = { startedAt: new Date().toISOString(), base: BASE, roles: [] };
const problems = [];

function log(...a) { console.log(...a); }

/* denylist：会造成数据变更或状态跳转的动作，一律不点。
 * 篡改|改写|重新出块：/explorer 的「防篡改实验台」按钮——点了会把真实链改脏
 * （2026-10-28 审计事故：自动点击"模拟恶意篡改"导致区块 #30 被改写），本审计绝不触碰。 */
const DENY = /退出|登出|删除|移除|清缴|下单|买入|卖出|挂牌|成交|提交|确认|签发|注销|重置|清空|回滚|停止|启动|上链|拨款|分配|审核|通过|驳回|撤销|冻结|解锁|烧录|部署|销毁|解约|支付|转账|申购|赎回|篡改|改写|重新出块|出块并修复/;

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_audit_'));
  fs.mkdirSync(OUT, { recursive: true });
  let child = null; let cdp = null;

  try {
    child = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--window-size=1440,960', 'about:blank',
    ], { stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 60; i++) {
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
      } catch (e) { /* 未就绪 */ }
    }
    if (!target) throw new Error('无法连接调试端口');

    cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
    await new Promise((r) => setTimeout(r, 200));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

    for (const acc of ACCOUNTS) {
      if (ONLY_ROLE && acc.role !== ONLY_ROLE) continue;
      log(`\n════ 角色 ${acc.role}（${acc.user}）════`);

      const login = await httpJson('/api/auth/login', 'POST', { username: acc.user, password: acc.pass });
      const token = login && login.data && login.data.token;
      const user = login && login.data && login.data.user;
      if (!token) { log(`  ✘ 登录失败：${JSON.stringify(login).slice(0, 140)}`); problems.push({ role: acc.role, kind: 'login', detail: '登录失败' }); continue; }

      /* ⚠ 先导航到同源页面，再写 localStorage：
       *   初始停在 about:blank 时 localStorage 是 "Access is denied"，
       *   直接 eval 会抛 SecurityError，整个角色被跳过。 */
      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
      /* 2026-11-01：等 SPA 真正就绪（App 挂载 + 侧边栏/登录表单出现），
       * 不再写死 2.2 s——远程审计时网络稍慢 App 未定义，
       * 下一句 eval 直接 ReferenceError 把整个角色打没（上一轮 6 个角色 0 页的元凶）。 */
      {
        let ready = false;
        for (let i = 0; i < 30 && !ready; i++) {
          await sleep(500);
          try {
            ready = await cdp.eval(`(function(){ return typeof App !== 'undefined' && !!document.body.querySelector('a[href^="#/"], form'); })()`) === true;
          } catch (e) { ready = false; }
        }
        if (!ready) log('  ⚠ 页面就绪等待超时，继续尝试');
      }
      await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);
      await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${(user && user.role === 'TRADER') ? '/trade/market' : '/login'}` }, 45000);
      /* 第二次跳转等待会话恢复；⚠ 必须同时校验 username 与 role——
       * 2026-11-01 实测：SPA 自身的会话持久化可能与本工具的 setItem 竞态，
       * 偶发恢复出上一个角色的会话（trader01 轮跑出监管菜单 36 页的假象）。
       * 校验失败就重写 localStorage 并再导航一次，最多重试 2 轮。 */
      for (let attempt = 0; attempt < 3; attempt++) {
        let ok2 = false;
        for (let i = 0; i < 20 && !ok2; i++) {
          await sleep(500);
          try {
            /* ⚠ 必须等到 routeAccess.MENUS[role] 就位：Store 恢复（core.js，早）
             * 与菜单表定义（app.js 末尾，大文件跨网慢）是两个时刻——
             * 只等 Store 会话恢复就提取菜单，偶发拿到 0（上几轮 0 页元凶之二）。 */
            ok2 = await cdp.eval(`(function(){ return typeof App !== 'undefined' && !!(App.Store && App.Store.user && App.Store.user.username === ${JSON.stringify(acc.user)} && App.Store.user.role === ${JSON.stringify(acc.role)} && App.routeAccess && App.routeAccess.MENUS && (App.routeAccess.MENUS[${JSON.stringify(acc.role)}] || []).length > 0); })()`) === true;
          } catch (e) { ok2 = false; }
        }
        if (ok2) break;
        log(`  ⚠ 会话恢复第 ${attempt + 1} 次未确认（${acc.user}/${acc.role}），重写凭据重试`);
        try {
          await cdp.eval(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return 1; })()`);
          await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#login` }, 45000);
          await sleep(1500);
        } catch (e) { /* 导航失败继续下一轮 */ }
      }

      const routes = await cdp.json(`
        var ra = App.routeAccess || {};
        var out = []; var seen = {};
        var role = App.Store.user && App.Store.user.role;
        ((ra.MENUS || {})[role] || []).forEach(function(g){
          (g.items || []).forEach(function(it){
            if (seen[it.path]) return; seen[it.path] = 1;
            out.push({ path: it.path, label: it.label, group: g.group });
          });
        });
        return out;
      `);
      if (!routes.length) {
        /* 2026-11-01 诊断：菜单为 0 时打出页面真实状态，别再猜 */
        try {
          const dbg = await cdp.eval(`JSON.stringify({href: location.href, uname: (window.App&&App.Store&&App.Store.user&&App.Store.user.username)||null, role: (window.App&&App.Store&&App.Store.user&&App.Store.user.role)||null, roleKeys: window.App&&App.routeAccess?Object.keys(App.routeAccess.MENUS||{}):null, lsUser: (localStorage.getItem('cch_user')||'').slice(0,60), errs: (window.__audit&&window.__audit.logs||[]).slice(0,4)})`);
          log(`  ⚠ 菜单 0 诊断: ${String(dbg).slice(0, 260)}`);
        } catch (e) { log(`  ⚠ 菜单 0 诊断失败: ${String(e.message).slice(0, 120)}`); }
      }
      log(`  菜单入口 ${routes.length} 个`);
      const targets = ONLY_PATHS.length ? routes.filter((r) => ONLY_PATHS.indexOf(r.path) > -1) : routes;

      const roleReport = { role: acc.role, user: acc.user, routeCount: routes.length, pages: [], totals: { dead: 0, buttons: 0, clicks: 0, clickErr: 0, netFail: 0, unresolved: 0 } };

      for (const r of targets) {
        const page = { path: r.path, label: r.label, group: r.group };

        /* ⚠ 每一页都要能被"卡死"单独终止：
         *   某个页面若在主线程里跑长任务（同步蒙特卡洛、大表计算），
         *   Runtime.evaluate 会一直不返回，进而把整个审计拖死 ——
         *   实测就是这样丢掉了一整轮结果。这里逐页 try/catch + 降级恢复。 */
        try {
          await cdp.eval(`(function(){ window.__audit.logs.length = 0; window.__audit.net.length = 0; return 1; })()`).catch(() => 0);
        } catch (e) { /* 上一页可能仍占用主线程 */ }

        let navigated = true;
        /* 窗口放宽到 90 s：重数据页（/ent/uncertainty 四个并发聚合接口、
           /real/truth 全库核对）在累积了几十页之后，主线程与后端都会被前序页面拖慢。
           实测这些页面"单独跑 3 s、连续跑 40 s+" —— 是等待窗口问题，不是渲染错误。 */
        try { await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${r.path}` }, 90000); }
        catch (e) { navigated = false; }

        if (!navigated) {
          page.ok = false; page.reason = '导航超时';
          page.fatal = ['导航超时(>90s)：页面在加载中长时间占用主线程'];
          /* 救场：停加载并回到登录页，保证后续页面还能测 */
          try { await cdp.send('Page.stopLoading', {}, 8000); } catch (e) { /* 忽略 */ }
          try { await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 25000); } catch (e) { /* 忽略 */ }
          await sleep(1200);
          problems.push({ role: acc.role, path: r.path, label: r.label, kind: 'fatal', detail: page.fatal[0] });
          roleReport.pages.push(page);
          log(`  ✘ ${r.path.padEnd(26)} 导航超时(>90s)`);
          continue;
        }

        /* 等"本页"就绪：hash 对上 且 标题非空 且 不在 loading。
           窗口 45 s（原 20 s）：实测 /real/benchmarks、/real/trend 这类聚合页
           单跑 1.5 s 就有页头，但连续巡检 20+ 页后后端与主线程都被前序页面拖慢，
           20 s 内拿不到标题就会被记成"无页面标题"——是等待窗口问题，不是渲染缺陷。
           与 Page.navigate 的 90 s、CDP eval 的 45 s 保持同一量级。 */
        let probe = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 45000) {
          await sleep(300);
          try {
            probe = await cdp.json(`
              /* 标题判据不能只认 .page-head h2：全幅看板页（/matrix 指挥中心、
                 /screen 大屏）与自绘页头（/explorer）用的是自有页头。
                 只看 .page-head 会让这些页永远 title='' ⇒ 既误报"无标题"，
                 又让下面的等待循环白等满 20 s。 */
              var h2 = document.querySelector('.page-head h2')
                    || document.querySelector('.matrix-title')
                    || document.querySelector('.screen-head h1')
                    || document.querySelector('.screen-title')
                    || document.querySelector('.content h1');
              var main = document.querySelector('.content') || document.body;
              var un = [];
              Array.prototype.forEach.call(document.querySelectorAll('*'), function(n){
                if (n.tagName && n.tagName.indexOf('X-') === 0) un.push(n.tagName.toLowerCase());
              });
              return {
                hash: location.hash, title: h2 ? (h2.innerText||'').trim() : '',
                textLen: (main.innerText||'').replace(/\\s+/g,' ').trim().length,
                tables: document.querySelectorAll('.content table').length,
                rows: document.querySelectorAll('.content tbody tr').length,
                booting: !!document.querySelector('.boot')
              };
            `);
          } catch (e) { continue; }
          if (probe && !probe.booting && probe.hash.indexOf(r.path) >= 0 && probe.title) break;
        }
        await sleep(600);

        const health = await cdp.json(`
          var main = document.querySelector('.content') || document.body;
          var un = [];
          Array.prototype.forEach.call(document.querySelectorAll('*'), function(n){
            if (n.tagName && n.tagName.indexOf('X-') === 0) un.push(n.tagName.toLowerCase());
          });
          return {
            hash: location.hash,
            title: ((document.querySelector('.page-head h2')
                  || document.querySelector('.matrix-title')
                  || document.querySelector('.screen-head h1')
                  || document.querySelector('.screen-title')
                  || document.querySelector('.content h1') || {}).innerText || '').trim(),
            textLen: (main.innerText||'').replace(/\\s+/g,' ').trim().length,
            skewel: document.querySelectorAll('.skel').length,
            tables: document.querySelectorAll('.content table').length,
            rows: document.querySelectorAll('.content tbody tr').length,
            charts: document.querySelectorAll('.content canvas').length,
            unresolved: un,
            logs: (window.__audit.logs || []).slice(0, 6),
            net: (window.__audit.net || []).slice(0, 8)
          };
        `).catch(() => null);

        if (!health) {
          page.ok = false; page.reason = '探针失败';
          page.fatal = ['页面无响应：主线程被长任务占用，30s 内无法求值'];
          try { await cdp.send('Page.stopLoading', {}, 8000); } catch (e) { /* 忽略 */ }
          try { await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 25000); } catch (e) { /* 忽略 */ }
          await sleep(1200);
          problems.push({ role: acc.role, path: r.path, label: r.label, kind: 'fatal', detail: page.fatal[0] });
          roleReport.pages.push(page);
          log(`  ✘ ${r.path.padEnd(26)} 页面无响应(主线程阻塞)`);
          continue;
        }

        page.title = health.title;
        page.textLen = health.textLen;
        page.tables = health.tables;
        page.rows = health.rows;
        page.skel = health.skewel;
        page.resolvedRoute = health.hash.indexOf(r.path) >= 0;
        page.unresolved = health.unresolved;
        page.netFail = health.net;
        page.consoleErr = health.logs;

        /* ---- 按钮静态审计：找出"没绑事件"的按钮 ---- */
        const inv = await cdp.json(`
          var scope = document.querySelector('.content') || document.body;
          var out = [];
          var seen = {};
          Array.prototype.forEach.call(scope.querySelectorAll('button, [role="button"], a.btn'), function(el){
            if (!el.offsetParent && el.offsetWidth === 0) return;     // 不可见
            var txt = (el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
            var hasVei = !!(el._vei && el._vei.onClick);
            var hasNative = typeof el.onclick === 'function' || el.hasAttribute('onclick');
            var isSubmit = el.type === 'submit';
            /* a.btn[href] 本身就是"活"的（真会跳转/下载），
               原判据只看 _vei/onclick，把它误报成死按钮（实测 /ops 的
               「Prometheus 指标」就是指向 /api/ops/metrics 的链接）。 */
            var hasHref = el.tagName === 'A' && !!el.getAttribute('href')
              && el.getAttribute('href') !== '#' && el.getAttribute('href') !== 'javascript:void(0)';
            var disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
            var key = txt + '|' + (el.className || '') + '|' + (el.disabled ? 1 : 0);
            if (seen[key]) return; seen[key] = 1;
            out.push({
              text: txt.slice(0, 40), cls: String(el.className||'').slice(0, 60),
              live: hasVei || hasNative || isSubmit || hasHref, disabled: disabled,
              hasVei: hasVei, native: hasNative, submit: isSubmit, href: hasHref
            });
          });
          return { total: out.length, list: out };
        `).catch(() => ({ total: 0, list: [] }));

        page.buttons = inv.total;
        page.dead = inv.list.filter((b) => !b.live).map((b) => ({ text: b.text, cls: b.cls }));
        roleReport.totals.buttons += inv.total;
        roleReport.totals.dead += page.dead.length;

        /* ---- 动态点击审计（安全动作） ---- */
        if (DO_CLICK) {
          const clickable = inv.list.filter((b) => b.live && !b.disabled && b.text && !DENY.test(b.text)).slice(0, 8);
          const clickResults = [];
          for (const btn of clickable) {
            const res = await cdp.json(`
              return (async function(){
                var want = ${JSON.stringify(btn.text)};
                var scope = document.querySelector('.content') || document.body;
                var target = null;
                Array.prototype.forEach.call(scope.querySelectorAll('button, [role="button"], a.btn'), function(el){
                  if (target) return;
                  var t = (el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim();
                  if (t === want && !el.disabled) target = el;
                });
                if (!target) return { skipped: true };
                var before = (window.__audit.logs||[]).length;
                var beforeNet = (window.__audit.net||[]).length;
                var beforeToast = (App.Store.toasts||[]).length;
                try { target.click(); } catch (e) { return { threw: String(e && e.message) }; }
                await new Promise(function(r){ setTimeout(r, 420); });
                var newLogs = (window.__audit.logs||[]).slice(before);
                var newNet = (window.__audit.net||[]).slice(beforeNet);
                var newToasts = (App.Store.toasts||[]).slice(beforeToast);
                var errToasts = newToasts.filter(function(t){ return t.type === 'err'; }).map(function(t){ return t.message; })
                  /* ⚠ 校验提示不是缺陷：没填数量就点「测算」当然会被拦下来。
                     把这类文案算成"点击异常"会让报告里塞满噪音，
                     真正要抓的是"点了之后抛异常/接口 500"。 */
                  .filter(function(m){ return !/请填写|请选择|请先|不能为空|格式不|请输入|至少|最多|超出/.test(String(m)); });
                var overlay = !!document.querySelector('.mask, .drawer-mask, .cmdk-mask');
                /* 收尾：关掉可能打开的浮层，避免影响下一个按钮 */
                if (overlay) {
                  document.querySelectorAll('.mask, .drawer-mask, .cmdk-mask').forEach(function(m){
                    var x = m.querySelector('.x, .drawer-head .x, .modal-head .x');
                    if (x) { try { x.click(); } catch (e) {} }
                  });
                  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                }
                await new Promise(function(r){ setTimeout(r, 260); });
                return { logs: newLogs, net: newNet, errToasts: errToasts, overlay: overlay };
              })();
            `).catch((e) => ({ threw: e.message }));

            if (!res || res.skipped) continue;
            roleReport.totals.clicks++;
            const bad = (res.threw ? 1 : 0) + ((res.logs || []).length ? 1 : 0)
              + ((res.net || []).length ? 1 : 0) + ((res.errToasts || []).length ? 1 : 0);
            if (bad) {
              roleReport.totals.clickErr++;
              clickResults.push({ btn: btn.text, threw: res.threw || null, logs: res.logs || [], net: res.net || [], errToasts: res.errToasts || [] });
            }
          }
          page.clickIssues = clickResults;
        }

        /* ---- 汇总该页问题（分两档）----
         * fatal：用户看得见的功能失效（白屏、死按钮、点击报错、接口真失败、组件未解析）
         * struct：结构/一致性不符（无 page-head 标题、正文过短）
         * 两档分开统计，否则"公屏本来就没有 page-head"会被算成故障，报告立刻失去可信度。 */
        const fatal = [];
        const struct = [];
        if (!page.resolvedRoute) fatal.push('路由未切换');
        if (page.unresolved.length) fatal.push('未解析组件:' + page.unresolved.join(','));
        if (page.netFail.length) fatal.push('接口失败:' + page.netFail.slice(0, 3).join(' | '));
        if (page.consoleErr.length) fatal.push('控制台错误:' + page.consoleErr[0].slice(0, 100));
        if (page.dead.length) fatal.push('死按钮:' + page.dead.map((d) => d.text || d.cls).slice(0, 4).join(' / '));
        if (page.clickIssues && page.clickIssues.length) fatal.push('点击异常:' + page.clickIssues[0].btn + ' → ' + (page.clickIssues[0].threw || page.clickIssues[0].errToasts[0] || page.clickIssues[0].logs[0] || page.clickIssues[0].net[0] || '').toString().slice(0, 90));
        if (!health.title) struct.push('无页面标题(page-head)');
        /* 有骨架屏 = 页面结构已就位、数据还在路上，不是"正文缺失"。
           慢聚合页（/real/trend 首屏 4~5 s）若按纯字数判会一直误报。 */
        if (page.textLen < 60 && !(page.skel > 0)) struct.push('正文过少(' + page.textLen + ')');

        page.ok = fatal.length === 0;
        page.fatal = fatal;
        page.struct = struct;
        roleReport.totals.netFail += page.netFail.length;
        roleReport.totals.unresolved += page.unresolved.length;
        roleReport.totals.struct = (roleReport.totals.struct || 0) + (struct.length ? 1 : 0);

        if (page.ok) {
          const mark = struct.length ? '△' : '✔';
          log(`  ${mark} ${r.path.padEnd(26)} ${String(health.title || '(无标题)').slice(0, 16).padEnd(16)} 表${page.tables}/行${page.rows} 按钮${page.buttons}${struct.length ? '  ⚠ ' + struct.join(',') : ''}`);
          struct.forEach((s) => problems.push({ role: acc.role, path: r.path, label: r.label, kind: 'struct', detail: s }));
        } else {
          log(`  ✘ ${r.path.padEnd(26)} ${fatal.join(' ；').slice(0, 150)}`);
          fatal.forEach((b) => problems.push({ role: acc.role, path: r.path, label: r.label, kind: 'fatal', detail: b }));
          struct.forEach((s) => problems.push({ role: acc.role, path: r.path, label: r.label, kind: 'struct', detail: s }));
        }
        roleReport.pages.push(page);
      }

      report.roles.push(roleReport);
      log(`  ── 小计：${roleReport.pages.filter((p) => p.ok).length}/${roleReport.pages.length} 页可用`
        + `｜结构待优化 ${roleReport.totals.struct || 0} 页｜按钮 ${roleReport.totals.buttons}｜死按钮 ${roleReport.totals.dead}`
        + `｜点击 ${roleReport.totals.clicks} 次/异常 ${roleReport.totals.clickErr}`);
    }

    report.finishedAt = new Date().toISOString();
    report.problems = problems;
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

    /* 控制台汇总 */
    log('\n════════════════ 汇总 ════════════════');
    let totalPages = 0; let okPages = 0; let deadAll = 0; let btnAll = 0; let clickErrAll = 0; let clickAll = 0;
    report.roles.forEach((r) => {
      const okc = r.pages.filter((p) => p.ok).length;
      totalPages += r.pages.length; okPages += okc;
      deadAll += r.totals.dead; btnAll += r.totals.buttons;
      clickErrAll += r.totals.clickErr; clickAll += r.totals.clicks;
      log(`  ${r.role.padEnd(11)} 页面 ${okc}/${r.pages.length} 正常 ｜ 按钮 ${r.totals.buttons}（死 ${r.totals.dead}）｜ 点击 ${r.totals.clicks}（异常 ${r.totals.clickErr}）`);
    });
    log(`  ${'总计'.padEnd(11)} 页面 ${okPages}/${totalPages} 正常 ｜ 按钮 ${btnAll}（死 ${deadAll}）｜ 点击 ${clickAll}（异常 ${clickErrAll}）`);
    log(`  报告：${path.join(OUT, 'report.json')}`);

    if (problems.length) {
      log('\n──────── 问题清单（前 40 条）────────');
      problems.slice(0, 40).forEach((p) => log(`  [${p.kind}] ${p.role} ${p.path} · ${p.label}\n        ${p.detail}`));
      if (problems.length > 40) log(`  …… 另有 ${problems.length - 40} 条，见 report.json`);
    }

    process.exitCode = problems.length ? 1 : 0;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) { /* 忽略 */ }
    try { if (child) child.kill(); } catch (e) { /* 忽略 */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

main().catch((e) => { console.error('审计异常：', e.message); process.exit(2); });
