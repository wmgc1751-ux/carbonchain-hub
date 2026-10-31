/* =====================================================================
   platform-audit.mjs —— 平台级质量扫描（无障碍 / 移动端 / 视觉规范 / 运行时占位）
   ---------------------------------------------------------------------
   console-audit 回答的是"能不能用"（页面渲染、按钮是否绑事件、点击是否报错）。
   本工具回答的是"够不够专业"：

     ① 运行时占位：页面上真的出现了 `${…}` / `undefined` / `NaN` / `Invalid Date`
     ② 无障碍：表单控件有没有可读名称、按钮有没有可读文本、图片有没有 alt
     ③ 对比度：正文/次级文字/按钮文字与真实背景的对比度（WCAG AA 4.5:1）
     ④ 移动端 390×844：横向溢出、超宽元素、点击区 < 40px、正文 < 11px
     ⑤ 控制台警告（console.warn）—— console-audit 只抓 error

   用法：
     node tools/platform-audit.mjs                     # 5 角色 × 精选关键页
     node tools/platform-audit.mjs --role REGULATOR
     node tools/platform-audit.mjs --all               # 全部菜单页（慢）
     node tools/platform-audit.mjs --path /reg/system,/ops
   ===================================================================== */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argOf = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes('--' + k);

const BASE = argOf('base', 'http://127.0.0.1:8300');
const PORT = Number(argOf('port', 9481));
const ONLY_ROLE = argOf('role', null);
const ONLY_PATHS = (argOf('path', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const RUN_ALL = has('all');
const OUT = path.resolve(argOf('out', '_ui-check/platform'));

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [
  { role: 'ENTERPRISE', user: 'ent001', pass: '123456' },
  { role: 'VERIFIER', user: 'ver001', pass: '123456' },
  { role: 'REGULATOR', user: 'reg001', pass: '123456' },
  { role: 'TRADER', user: 'trader01', pass: '123456' },
  { role: 'ADMIN', user: 'admin', pass: 'admin123' },
];

/* 精选关键页：每个角色挑最能代表该端定位的页面。
   要全量用 --all。 */
const KEY_PAGES = {
  ENTERPRISE: ['/matrix', '/cems', '/ent/overview', '/ent/dynamic', '/ent/quota', '/ent/reports', '/mrv/calc', '/real/cn'],
  VERIFIER: ['/ver/overview', '/ver/tasks', '/ver/mrv/calc', '/ver/reports', '/explorer'],
  REGULATOR: ['/reg/overview', '/reg/enterprises', '/reg/allocations', '/reg/alerts', '/reg/system', '/ops', '/keys', '/screen'],
  TRADER: ['/trade/market', '/trade/orders', '/trade/offset', '/trade/account'],
  ADMIN: ['/admin/overview', '/admin/users', '/admin/factors', '/admin/reconcile', '/reg/system'],
};

function httpJson(pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: Number(new URL(BASE).port) || 8300, path: pathname, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
    }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
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
  async json(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async function(){ ${expr} })().then(v=>JSON.stringify(v))`,
      returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text).slice(0, 200));
    return r.result && r.result.value !== undefined ? JSON.parse(r.result.value) : undefined;
  }
}

/* 注入：抓 console.warn（console-audit 只抓 error） */
const HOOK = `(function(){
  if (window.__pa) return; window.__pa = { warns: [], errs: [] };
  var ow = console.warn;
  console.warn = function(){ window.__pa.warns.push(Array.prototype.map.call(arguments,String).join(' ').slice(0,200)); ow.apply(console, arguments); };
  var oe = console.error;
  console.error = function(){ window.__pa.errs.push(Array.prototype.map.call(arguments,String).join(' ').slice(0,200)); oe.apply(console, arguments); };
  window.addEventListener('error', function(e){ window.__pa.errs.push('uncaught: '+String(e.message)); }, true);
  window.addEventListener('unhandledrejection', function(e){ window.__pa.errs.push('rejection: '+String(e.reason&&e.reason.message||e.reason)); });
})();`;

/* ---------- 桌面端检查 ---------- */
const DESKTOP_PROBE = `
  var out = {};
  var vis = function(el){
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.02 && r.width > 1 && r.height > 1;
  };

  /* (1) 运行时占位：用户真的能看到美元花括号 / undefined / NaN / Invalid Date */
  var main = document.querySelector('.content') || document.body;
  var txt = (main.innerText || '');
  var bad = [];
  [['\${', /\\$\\{[^}\\n]{0,40}\\}/], ['{{', /\\{\\{[^}\\n]{0,40}\\}\\}/],
   ['undefined', /\\bundefined\\b/], ['NaN', /\\bNaN\\b/],
   ['null', /\\bnull\\b/], ['Invalid Date', /Invalid Date/]].forEach(function(p){
     var m = txt.match(p[1]);
     if (m) bad.push(p[0] + ' → ' + m[0].slice(0, 60));
  });
  out.placeholders = bad;

  /* (2) 无障碍：表单控件可读名称 */
  var ctrls = [].slice.call(document.querySelectorAll('input,select,textarea'));
  out.controls = ctrls.length;
  out.unlabeled = [];
  ctrls.forEach(function(c){
    if (!vis(c) || c.type === 'hidden') return;
    var name = (c.getAttribute('aria-label') || c.getAttribute('placeholder') || c.getAttribute('title') || '').trim();
    if (!name && c.id) {
      var lb = document.querySelector('label[for="' + c.id + '"]');
      if (lb) name = (lb.innerText || '').trim();
    }
    if (!name) {
      var p = c.parentElement;
      for (var i = 0; i < 3 && p && !name; i++) {
        var l = p.querySelector && p.querySelector('label');
        if (l) name = (l.innerText || '').trim();
        p = p.parentElement;
      }
    }
    if (!name) {
      /* 包在 .field/.fi 里、前面有 label 兄弟节点也算 */
      var sib = c.previousElementSibling;
      if (sib && /^(LABEL|SPAN)$/.test(sib.tagName)) name = (sib.innerText || '').trim();
    }
    if (!name) out.unlabeled.push(c.tagName.toLowerCase() + (c.type ? '[' + c.type + ']' : '') + ' @' + (c.className || '').toString().slice(0, 40));
  });

  /* (3) 按钮/链接可读名称 */
  var btns = [].slice.call(document.querySelectorAll('button, a[href], [role=button]'));
  out.buttons = btns.length;
  out.namelessBtns = [];
  btns.forEach(function(b){
    if (!vis(b)) return;
    var t = (b.innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
    if (!t) out.namelessBtns.push((b.className || '').toString().slice(0, 50) || b.tagName);
  });

  /* (4) 图片 alt */
  var imgs = [].slice.call(document.querySelectorAll('img'));
  out.images = imgs.length;
  out.noAlt = imgs.filter(function(i){ return !i.hasAttribute('alt'); }).map(function(i){ return (i.getAttribute('src') || '').slice(-40); });

  /* (5) 对比度：按 (前景,背景,字号,粗细) 去重，取最差
   *
   * ⚠⚠ 2026-10-26 修：旧实现只走 backgroundColor，而本主题的画布是
   *   body{background-image: 径向渐变} + 各级 backgroundColor 全为 rgba(0,0,0,0)，
   *   于是每一级的可见画布都被判成"透明"，最后回落到一个猜出来的值，
   *   把浅色文字压到浅底上 ⇒ 整屏报"低对比"，而人眼看完全正常。
   *   现在：画布取 --bg-1，再逐级把半透明层叠上去。
   *   同时加两层自校验（纯函数 WCAG 已知值 + 现场注入对照元素），
   *   判据必须先证明自己能判红、能判绿，才有资格报问题。
   */
  function parse(c){
    var m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    var p = m[1].split(',').map(function(x){ return parseFloat(x); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function blend(fg, bg){
    var a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function hex2(c){
    var m = String(c).trim().match(/^#([0-9a-f]{6})$/i);
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  function canvas(){
    var rs = getComputedStyle(document.documentElement);
    var keys = ['--bg-1', '--bg', '--bg-2', '--surface'];
    for (var i = 0; i < keys.length; i++) {
      var c = hex2(rs.getPropertyValue(keys[i]) || '');
      if (c) return c;
    }
    return { r: 10, g: 16, b: 32, a: 1 };
  }
  /* 背景可能是纯 background-image 渐变（例如 .btn.primary 只在渐变里给出绿色，
   *   backgroundColor 依旧是 transparent），只看 backgroundColor 会把
   *   "深字 + 亮绿底"算成"深字 + 深底"⇒ 假警报。
   *
   * ⚠ 一个元素可能有**多层** gradient（.btn.primary 就是"白色高光层 + 绿色渐变层"）。
   *   把所有色标混在一起取均值，会让 0.2 透明度的白色把整块算暗
   *   （实测把 5.06:1 算成 3.37:1）。所以先按括号深度把层切开，逐层取均值，
   *   再按 CSS 的绘制顺序（后列的在下、先列的在上）逐层叠回去。 */
  function splitLayers(bgi) {
    var parts = [], depth = 0, buf = '';
    for (var i = 0; i < bgi.length; i++) {
      var ch = bgi[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    return parts.filter(function (s) { return s.indexOf('gradient') >= 0; });
  }
  function layerAvg(chunk) {
    var re = /rgba?\\([^)]+\\)/g, m, cols = [];
    while ((m = re.exec(chunk))) { var c = parse(m[0]); if (c) cols.push(c); }
    if (!cols.length) return null;
    var r = 0, g = 0, b = 0, a = 0;
    cols.forEach(function (c) { r += c.r; g += c.g; b += c.b; a += c.a; });
    var n = cols.length;
    return { r: r / n, g: g / n, b: b / n, a: a / n };
  }
  function bgOf(el){
    /* layers[0] 恒为最上层，索引越大越深；最后从深到浅逐层叠到画布上 */
    var layers = [], grad = false, cur = el;
    while (cur) {
      var cs = getComputedStyle(cur);
      /* 同一元素内：渐变层压在 background-color 之上；
         渐变之间则是"先列的在上、后列的在下" ⇒ 先按 CSS 顺序压栈，再压 backgroundColor */
      var bgi = cs.backgroundImage;
      if (bgi && bgi !== 'none' && bgi.indexOf('gradient') >= 0) {
        splitLayers(bgi).forEach(function (chunk) {
          var c = layerAvg(chunk);
          if (c && c.a > 0) { layers.push(c); grad = true; }
        });
      }
      var bc = parse(cs.backgroundColor);
      if (bc && bc.a > 0) layers.push(bc);
      cur = cur.parentElement;
    }
    var bg = canvas();
    for (var i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    bg.gradient = grad;
    return bg;
  }
  function lum(c){
    var f = function(v){ v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b){
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function checkOne(el){
    var cs = getComputedStyle(el);
    var fg = parse(cs.color); if (!fg) return null;
    var bg = bgOf(el);
    if (fg.a < 1) fg = blend(fg, bg);
    var size = parseFloat(cs.fontSize) || 12;
    var bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
    var large = size >= 24 || (size >= 18.66 && bold);
    var need = large ? 3.0 : 4.5;
    var r = ratio(fg, bg);
    return {
      ratio: Math.round(r * 100) / 100, need: need, size: size, bold: bold, pass: r >= need,
      color: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      gradient: !!bg.gradient,
      cls: (el.className || '').toString().slice(0, 40), text: (el.innerText || '').trim().slice(0, 30)
    };
  }

  /* 自校验 A：纯函数对着 WCAG 已知值结算 */
  var wWhite = { r: 255, g: 255, b: 255 }, wBlack = { r: 0, g: 0, b: 0 };
  var rBW = ratio(wBlack, wWhite);
  var rGray = ratio({ r: 118, g: 118, b: 118 }, wWhite);
  /* 渐变解析也必须自校验：正则少一个转义会让所有渐变背景静默退回画布色，
     表现为"亮底深字"被判 1.01 —— 这类判据 bug 只能靠自校验抓出来。 */
  var gOne = function(src){
    var ls = splitLayers(src);
    return ls.length === 1 ? layerAvg(ls[0]) : null;
  };
  var gProbe = gOne('linear-gradient(160deg, rgb(18, 209, 143), rgb(0, 192, 127) 52%, rgb(4, 120, 87))');
  var gLow = gOne('linear-gradient(0deg, rgb(10, 16, 32), rgb(10, 16, 32))');
  /* 多层拆层自校验：两层必须被拆成 2 段，且不被混算 */
  var gTwo = splitLayers('linear-gradient(180deg, rgba(255,255,255,.2), rgba(255,255,255,0)), linear-gradient(160deg, rgb(0,192,127), rgb(5,150,105))');
  out.contrastSelfTest = {
    blackOnWhite: Math.round(rBW * 100) / 100, expect: 21,
    gray767676OnWhite: Math.round(rGray * 100) / 100, expectGray: 4.54,
    gradStops: gProbe ? gProbe.r.toFixed(1) + '/' + gProbe.g.toFixed(1) + '/' + gProbe.b.toFixed(1) : null,
    gradAlpha: gProbe ? gProbe.a : null,
    gradLowRgb: gLow ? Math.round(gLow.r) + ',' + Math.round(gLow.g) + ',' + Math.round(gLow.b) : null,
    /* 两层必须被拆成两段；混算的话这里只有 1 段 */
    gradLayers: gTwo.length,
    gradLayersOk: gTwo.length === 2,
    ok: Math.abs(rBW - 21) < 0.2 && Math.abs(rGray - 4.54) < 0.12
      && !!gProbe && Math.abs(gProbe.a - 1) < 0.01 && Math.abs(gProbe.g - 173.67) < 1
      && !!gLow && Math.round(gLow.r) === 10 && Math.round(gLow.g) === 16
      && gTwo.length === 2,
  };

  /* 自校验 B：现场注入"必然不合格"与"必然合格"两个对照元素 */
  (function(){
    var host = document.querySelector('.content') || document.body;
    var mk = function(id, css){
      var s = document.createElement('span');
      s.id = id; s.textContent = '对比度对照文本';
      s.style.cssText = 'font-size:12px;display:inline-block;padding:2px;' + css;
      host.insertBefore(s, host.firstChild);
      return s;
    };
    var badEl = mk('__pa_ctl_low', 'color:#1b2740;background:#0a1020');
    var okEl = mk('__pa_ctl_ok', 'color:#e8eefb;background:#0a1020');
    /* 渐变底也必须能判红：若渐变被静默忽略，这一条会假通过 */
    var gradEl = mk('__pa_ctl_grad', 'color:#1b2740;background:linear-gradient(0deg,#0a1020,#0a1020)');
    var lo = checkOne(badEl), hi = checkOne(okEl), gd = checkOne(gradEl);
    out.contrastControls = {
      low: lo && lo.ratio, lowFlagged: !!(lo && !lo.pass),
      ok: hi && hi.ratio, okCleared: !!(hi && hi.pass),
      grad: gd && gd.ratio, gradFlagged: !!(gd && !gd.pass),
    };
    badEl.remove(); okEl.remove(); gradEl.remove();
    out.contrastControls.ok2 = out.contrastControls.lowFlagged && out.contrastControls.okCleared && out.contrastControls.gradFlagged;
  })();

  var seen = {}, low = [];
  [].slice.call(document.querySelectorAll('.content *')).some(function(el){
    if (el.children.length > 0) return false;
    if (!(el.innerText || '').trim()) return false;
    if (!vis(el)) return false;
    var one = checkOne(el);
    if (!one) return false;
    var key = one.color + '|' + one.bg + '|' + one.size;
    if (seen[key]) return false;
    seen[key] = 1;
    if (!one.pass) low.push(one);
    return false;
  });
  low.sort(function(a, b){ return a.ratio - b.ratio; });
  out.contrastLow = low.slice(0, 8);
  out.contrastCount = low.length;
  out.contrastChecked = Object.keys(seen).length;

  /* (6) 标题层级：h1→h2→h3 是否有跳级 */
  var hs = [].slice.call(document.querySelectorAll('.content h1,.content h2,.content h3,.content h4'))
    .filter(vis).map(function(e){ return Number(e.tagName[1]); });
  out.headingSeq = hs.slice(0, 20);
  out.headingJump = hs.some(function(v, i){ return i > 0 && v - hs[i - 1] > 1; });

  return out;
`;

/* ---------- 移动端检查 ---------- */
const MOBILE_PROBE = `
  var out = {};
  var de = document.documentElement;
  out.viewport = { w: de.clientWidth, scrollW: de.scrollWidth };
  out.hOverflow = Math.max(0, de.scrollWidth - de.clientWidth);

  var vis = function(el){
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.02 && r.width > 1 && r.height > 1;
  };

  /* 超宽元素：右边界超出视口
   * ⚠ 2026-10-26 修：内容在自己的横向滚动容器里（表格 .tbl-wrap{overflow-x:auto}）
   *   本来就该比视口宽，旧判据把它们全算"溢出"，8/8 页刷红。
   *   现在只看"容器本身也是普通文档流"的元素。 */
  var inScroller = function(el){
    var cur = el.parentElement;
    while (cur && cur !== document.body) {
      var cs = getComputedStyle(cur);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && cur.scrollWidth > cur.clientWidth + 1) return true;
      cur = cur.parentElement;
    }
    return false;
  };
  var wide = [];
  [].slice.call(document.querySelectorAll('.content *')).forEach(function(el){
    if (!vis(el)) return;
    var r = el.getBoundingClientRect();
    if (r.right <= de.clientWidth + 2) return;
    if (inScroller(el)) return;
    /* 定位用：最近的滚动祖先 overflowX 与尺寸，便于判断"该滚的没滚" */
    var anc = el.parentElement, aox = '-', asw = 0, acw = 0;
    while (anc && anc !== document.body) {
      var acs = getComputedStyle(anc);
      if (acs.overflowX !== 'visible') { aox = acs.overflowX; asw = anc.scrollWidth; acw = anc.clientWidth; break; }
      anc = anc.parentElement;
    }
    wide.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 40),
                right: Math.round(r.right), w: Math.round(r.width), aox: aox, asw: asw, acw: acw });
  });
  out.wideCount = wide.length;
  out.wide = wide.slice(0, 24);
  out.docOverflow = Math.max(0, de.scrollWidth - de.clientWidth);
  /* 页头/工具栏这类"顶层"元素被裁，比表格内部超出更该报 */
  out.topbarOverflow = (function(){
    var t = document.querySelector('.topbar');
    return t ? Math.max(0, t.scrollWidth - t.clientWidth) : 0;
  })();

  /* 点击区过小：WCAG 2.2 AA(2.5.8) 门槛 24×24。
   * 规范还带"间距例外"：不足 24 的目标，四周留白足够（以中心为圆心画直径 24 的圆
   * 不压到别的目标）同样算通过。表格里 15px 的复选框正好属于这一档——
   * 旧实现按 40×40 一刀切，533 条"违规"里绝大多数是这么来的，
   * 属于判据过严，不是界面缺陷。真正的缺陷是"又小又挤"。 */
  var tsel = 'button, a[href], [role=button], select, input';
  var targets = [].slice.call(document.querySelectorAll(tsel)).filter(vis).map(function(el){
    return { el: el, r: el.getBoundingClientRect() };
  });
  var boxGap = function(a, b){
    var dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
    var dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
    return Math.max(dx, dy);
  };
  var small = [], small40 = 0, cramped = [];
  targets.forEach(function(t){
    var r = t.r, el = t.el;
    if (r.width < 40 || r.height < 40) small40 += 1;
    if (!(r.width < 24 || r.height < 24)) return;
    var rec = { tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height),
                cls: (el.className || '').toString().slice(0, 30),
                text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 20) };
    small.push(rec);
    var minGap = Infinity;
    targets.forEach(function(o){ if (o.el !== el) minGap = Math.min(minGap, boxGap(r, o.r)); });
    /* 15px 见方的框，圆半径 12 ⇒ 超出边框 4.5px；留白 <5px 才算真挤 */
    if (minGap < 5) { rec.gap = Math.round(minGap); cramped.push(rec); }
  });
  out.smallTapCount = small.length;
  out.smallTap = small.slice(0, 10);
  out.smallTap40 = small40;
  out.smallTapCramped = cramped.length;
  out.crampedSample = cramped.slice(0, 8);

  /* 正文字号 < 11px */
  var tiny = 0, tinySample = [];
  [].slice.call(document.querySelectorAll('.content *')).forEach(function(el){
    if (el.children.length || !vis(el)) return;
    var t = (el.innerText || '').trim(); if (!t) return;
    var size = parseFloat(getComputedStyle(el).fontSize) || 12;
    if (size < 11) { tiny++; if (tinySample.length < 5) tinySample.push({ size: size, text: t.slice(0, 20) }); }
  });
  out.tinyText = tiny;
  out.tinyTextSample = tinySample;
  return out;
`;

const state = { generatedAt: new Date().toISOString(), base: BASE, roles: [] };

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_pa_'));
  fs.mkdirSync(OUT, { recursive: true });
  let child = null; let cdp = null;
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
      } catch (e) { /* wait */ }
    }
    if (!target) throw new Error('无法连接调试端口');

    cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
    await sleep(250);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

    for (const acc of ACCOUNTS) {
      if (ONLY_ROLE && acc.role !== ONLY_ROLE) continue;
      const login = await httpJson('/api/auth/login', 'POST', { username: acc.user, password: acc.pass });
      const token = login && login.data && login.data.token;
      const user = login && login.data && login.data.user;
      if (!token) { console.log(`✘ ${acc.role} 登录失败`); continue; }

      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
      /* 角色转场导航：多角色连跑时（>10 页后）无头渲染进程可能因上一页的
       * 图表实例/GC 拖慢响应，45 s 内回不了 CDP 命令。此处未捕获曾让整个
       * 审计进程崩掉（exit 1，已跑完的 13 页结果全部作废）。
       * 现改为"超时→强制新建标签页→重试一次"，工具健壮性与被审计页面无关。 */
      const navWithRetry = async (url, timeout = 45000) => {
        try {
          await cdp.send('Page.navigate', { url }, timeout);
        } catch (e) {
          if (!/cdp timeout/.test(e.message)) throw e;
          console.log(`  ↻ 导航超时，重建标签页重试（${url.slice(-14)}）`);
          try { await cdp.send('Target.createTarget', { url: 'about:blank' }); } catch (e2) { /* 忽略 */ }
          await sleep(1500);
          await cdp.send('Page.navigate', { url }, timeout);
        }
      };
      await navWithRetry(`${BASE}/?_=${Date.now()}#/login`);
      await sleep(2200);
      await cdp.send('Runtime.evaluate', {
        expression: `localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); 1`,
        returnByValue: true,
      });
      await navWithRetry(`${BASE}/?_=${Date.now()}#/login`);
      await sleep(2400);

      let paths = ONLY_PATHS.length ? ONLY_PATHS : (RUN_ALL ? null : KEY_PAGES[acc.role] || []);
      if (!paths) {
        const routes = await cdp.json(`
          var ra = App.routeAccess || {}; var out = []; var seen = {};
          var role = App.Store.user && App.Store.user.role;
          ((ra.MENUS || {})[role] || []).forEach(function(g){ (g.items||[]).forEach(function(it){ if(!seen[it.path]){seen[it.path]=1; out.push(it.path);} }); });
          return out;`);
        paths = routes;
      }

      const roleRep = { role: acc.role, pages: [] };
      console.log(`\n════ ${acc.role}（${paths.length} 页）════`);

      for (const p of paths) {
        const rec = { path: p };
        /* 桌面 */
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
        try { await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${p}` }, 60000); } catch (e) { rec.navFail = true; }
        /* 等到有内容或有骨架屏（不再等标题，避免慢页拖死） */
        for (let k = 0; k < 40; k++) {
          await sleep(400);
          try {
            const ok = await cdp.json(`var m=document.querySelector('.content')||document.body;
              var t=(m.innerText||'').replace(/\\s+/g,'').length;
              return { t: t, sk: document.querySelectorAll('.skel').length, h: location.hash };`);
            if (ok && ok.h.indexOf(p) >= 0 && (ok.t > 80 || ok.sk > 0)) break;
          } catch (e) { /* 主线程忙 */ }
        }
        await sleep(500);

        try { rec.desktop = await cdp.json(DESKTOP_PROBE); } catch (e) { rec.desktopErr = e.message.slice(0, 120); }
        try {
          rec.console = await cdp.json(`return { warns: (window.__pa.warns||[]).slice(0,8), errs: (window.__pa.errs||[]).slice(0,8) };`);
          await cdp.json(`window.__pa.warns.length=0; window.__pa.errs.length=0; return 1;`);
        } catch (e) { /* ignore */ }

        /* 移动端 */
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await sleep(900);
        try { rec.mobile = await cdp.json(MOBILE_PROBE); } catch (e) { rec.mobileErr = e.message.slice(0, 120); }
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

        roleRep.pages.push(rec);

        const d = rec.desktop || {};
        const m = rec.mobile || {};
        const flags = [];
        if ((d.placeholders || []).length) flags.push(`占位:${d.placeholders.join(';')}`);
        if ((d.unlabeled || []).length) flags.push(`无标签控件:${d.unlabeled.length}`);
        if ((d.namelessBtns || []).length) flags.push(`无名按钮:${d.namelessBtns.length}`);
        if ((d.contrastLow || []).length) flags.push(`低对比:${d.contrastLow.length}`);
        if (d.contrastSelfTest && !d.contrastSelfTest.ok) flags.push('⚠对比判据自校验失败');
        if (d.contrastControls && !d.contrastControls.ok2) flags.push('⚠对比对照未按预期分档');
        if ((rec.console && rec.console.errs || []).length) flags.push(`console.error:${rec.console.errs.length}`);
        if ((rec.console && rec.console.warns || []).length) flags.push(`console.warn:${rec.console.warns.length}`);
        if (m.hOverflow > 0) flags.push(`移动端横向溢出:${m.hOverflow}px`);
        if ((m.wideCount || 0) > 0) flags.push(`越界元素:${m.wideCount}`);
        if ((m.smallTapCramped || 0) > 0) flags.push(`点击区又小又挤:${m.smallTapCramped}`);
        if ((m.tinyText || 0) > 0) flags.push(`字号<11px:${m.tinyText}`);
        console.log(`  ${flags.length ? '△' : '✔'} ${p.padEnd(24)} ${flags.join(' | ') || '通过'}`);
      }
      state.roles.push(roleRep);
    }
  } finally {
    try { child && child.kill(); } catch (e) { /* ignore */ }
  }

  fs.writeFileSync(path.join(OUT, 'platform-audit.json'), JSON.stringify(state, null, 2), 'utf8');

  /* ---------- 汇总 ---------- */
  console.log('\n════════ 汇总 ════════');
  const agg = { placeholder: 0, unlabeled: 0, namelessBtn: 0, contrast: 0, warn: 0, error: 0, overflow: 0, wide: 0, smallTap: 0, smallTapCramped: 0, smallTap40: 0, tinyText: 0, pages: 0, clean: 0, selfTestBad: 0, ctlBad: 0 };
  for (const r of state.roles) {
    for (const p of r.pages) {
      agg.pages++;
      const d = p.desktop || {}; const m = p.mobile || {};
      const c = p.console || {};
      if (d.contrastSelfTest && !d.contrastSelfTest.ok) agg.selfTestBad++;
      if (d.contrastControls && !d.contrastControls.ok2) agg.ctlBad++;
      const n = (d.placeholders || []).length + (d.unlabeled || []).length + (d.namelessBtns || []).length
        + (d.contrastLow || []).length + (c.warns || []).length + (c.errs || []).length
        + (m.hOverflow > 0 ? 1 : 0) + (m.smallTapCramped || 0) + (m.tinyText || 0);
      if (n === 0) agg.clean++;
      agg.placeholder += (d.placeholders || []).length;
      agg.unlabeled += (d.unlabeled || []).length;
      agg.namelessBtn += (d.namelessBtns || []).length;
      agg.contrast += (d.contrastLow || []).length;
      agg.warn += (c.warns || []).length;
      agg.error += (c.errs || []).length;
      if (m.hOverflow > 0) agg.overflow++;
      agg.wide += (m.wideCount || 0);
      agg.smallTap += (m.smallTapCount || 0);
      agg.smallTapCramped += (m.smallTapCramped || 0);
      agg.smallTap40 += (m.smallTap40 || 0);
      agg.tinyText += (m.tinyText || 0);
    }
  }
  console.log(`  页面 ${agg.pages}｜全项通过 ${agg.clean}`);
  console.log(`  运行时占位 ${agg.placeholder}｜无标签控件 ${agg.unlabeled}｜无名按钮 ${agg.namelessBtn}｜低对比 ${agg.contrast}`);
  console.log(`  console.warn ${agg.warn}｜console.error ${agg.error}`);
  console.log(`  移动端横向溢出页 ${agg.overflow}｜越界元素 ${agg.wide}｜字号<11px ${agg.tinyText}`);
  console.log(`  点击区：<24px ${agg.smallTap}（含间距例外，真挤 ${agg.smallTapCramped}）｜<40px 参考值 ${agg.smallTap40}`);
  console.log(`  判据自校验：WCAG 取值异常页 ${agg.selfTestBad}｜现场对照未分档页 ${agg.ctlBad}`);
  if (agg.selfTestBad || agg.ctlBad) console.log('  ⚠ 判据本身可疑，本轮低对比结论不可采信');
  console.log(`\n报告：${path.join(OUT, 'platform-audit.json')}`);
}

main().catch((e) => { console.error('审计异常：' + e.message); process.exit(1); });
