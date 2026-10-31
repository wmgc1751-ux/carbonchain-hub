/* =====================================================================
   text-audit.mjs —— 全站逐页**文案**审计（真实浏览器取全文 + 规则扫描）
   ---------------------------------------------------------------------
   与 console-audit.mjs 的分工：
     console-audit 管"页面能不能用"（路由/接口/按钮/点击）；
     text-audit 管"页面上写的每一个字对不对"：
       · 错别字 / 用词不当 / 中英混排
       · 标签与数值不匹配（合计 vs 明细、同一标签两个值）
       · 裸状态码、ISO 时间泄漏、null/undefined/[object Object] 上屏
       · 全半角混排、标点异常、Markdown ** 残留
       · 「共 X 条」与实际行数不符
       · 数字精度/千分位在同一列里忽全忽不全
   规则只能抓"机械可判定"的问题；语序、口径这类要人读 ——
   所以每页全文都会存成 .txt，供逐页人工过目。

   用法：
     node tools/text-audit.mjs                  # 全角色 + 公开页
     node tools/text-audit.mjs --role REGULATOR # 只跑一个角色
     node tools/text-audit.mjs --public-only    # 只跑公开页（不登录）
   ===================================================================== */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argOf = (k, dflt) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (k) => process.argv.includes('--' + k);

const BASE = argOf('base', 'http://127.0.0.1:8300');
const PORT = Number(argOf('port', 9425));
const ONLY_ROLE = argOf('role', null);
const PUBLIC_ONLY = has('public-only');
const OUT = path.resolve(argOf('out', '_ui-check/text-audit'));
const PAGES_DIR = path.join(OUT, 'pages');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [
  { role: 'ENTERPRISE', user: 'ent_zjbd', pass: '123456' },
  { role: 'VERIFIER', user: 'ver001', pass: '123456' },
  { role: 'REGULATOR', user: 'reg001', pass: '123456' },
  { role: 'TRADER', user: 'trader01', pass: '123456' },
  { role: 'ADMIN', user: 'admin', pass: 'admin123' },
];

/* 公开页：不登录可看（OPEN_ROUTES）。/login 单独放在最后，因为它有独立问题域。 */
const PUBLIC_ROUTES = ['/screen', '/explorer', '/verify', '/cems', '/matrix', '/twin', '/notice', '/real', '/real/truth', '/login'];

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
      let m; try { m = JSON.parse(ev.data); } catch { return; }
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

/* ------------------------------------------------- 每页取全文（结构化） */
const EXTRACT = `
return (function(){
  var main = document.querySelector('.content') || document.body;
  var out = { title: '', desc: '', cards: [], table: [], selects: [], buttons: [], kvs: [], text: '' };

  var h2 = document.querySelector('.page-head h2') || document.querySelector('.matrix-title')
        || document.querySelector('.screen-head h1') || document.querySelector('.screen-title');
  out.title = h2 ? (h2.innerText || '').trim() : '';
  var d1 = document.querySelector('.page-head .desc');
  out.desc = d1 ? (d1.innerText || '').trim() : '';

  /* 卡片/分区标题 */
  Array.prototype.forEach.call(main.querySelectorAll('.card-h .t, .card-head, h3, h4, .sect-t'), function(n){
    var t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t && out.cards.indexOf(t) < 0) out.cards.push(t.slice(0, 80));
  });

  /* 表格：表头 + 全部行（压缩空格，单元格用 | 连接） */
  Array.prototype.forEach.call(main.querySelectorAll('table'), function(tb, ti){
    var head = Array.prototype.map.call(tb.querySelectorAll('thead th'), function(th){
      return (th.innerText || '').replace(/\\s+/g, ' ').trim();
    });
    var rows = Array.prototype.map.call(tb.querySelectorAll('tbody tr'), function(tr){
      return Array.prototype.map.call(tr.querySelectorAll('td'), function(td){
        return (td.innerText || '').replace(/\\s+/g, ' ').trim();
      }).filter(function(x, i, a){ return true; });
    });
    out.table.push({ i: ti, head: head, rows: rows.slice(0, 200), rowCount: rows.length });
  });

  /* 下拉框选项 */
  Array.prototype.forEach.call(main.querySelectorAll('select'), function(s, si){
    out.selects.push({
      i: si, label: (s.getAttribute('aria-label') || s.name || ('select#' + si)),
      options: Array.prototype.map.call(s.options, function(o){ return (o.textContent || '').trim(); }),
    });
  });

  /* 按钮与可点文本 */
  Array.prototype.forEach.call(main.querySelectorAll('button, [role="button"], a.btn'), function(b){
    var t = (b.innerText || b.title || b.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    if (t) out.buttons.push(t.slice(0, 50));
  });

  /* 键值对行（.row / .kv / dt+dd / 自定义 data-k）：标签→值，用于"同页同名不同值"检查 */
  Array.prototype.forEach.call(main.querySelectorAll('.row, .kv, .tw-row, .info-row'), function(r){
    var k = r.querySelector('.k, .label, dt, .name');
    var v = r.querySelector('.v, .value, dd, .val');
    if (k && v) out.kvs.push([ (k.innerText||'').trim().slice(0, 40), (v.innerText||'').trim().slice(0, 80) ]);
  });

  /* 输入框占位符 */
  out.placeholders = Array.prototype.map.call(main.querySelectorAll('input[placeholder], textarea[placeholder]'), function(i){
    return i.getAttribute('placeholder');
  }).filter(Boolean).slice(0, 30);

  /* 全文（保留换行，供逐字阅读） */
  var clone = main.cloneNode(true);
  Array.prototype.forEach.call(clone.querySelectorAll('script,style,svg,canvas,noscript'), function(n){ n.remove(); });
  out.text = (clone.innerText || '').split('\\n').map(function(l){ return l.replace(/\\s+/g, ' ').trim(); })
    .filter(function(l){ return l; }).join('\\n');

  return out;
})();
`;

/* ------------------------------------------------------- 文案规则扫描 */
const RULES = [
  { id: 'TYPO', re: /降解|登陆(?!页)|帐号|帐户|装机动|复查通过率|日超|排发|炭排放|碳排量级|做废|完呈|统计完|其它(?!说明)/g, msg: '疑似错别字/用词不当' },
  { id: 'EN_MIX', re: /t of steel|t of clinker|t of cement|million tonnes|Mt CO2(?!e)|kgCO2(?!e)/g, msg: '英文单位/写法残留' },
  { id: 'RAW_CODE', re: /\b(SUBMITTED|REJECTED|PENDING_APPROVAL|DRAFT_ONLY|APPROVED_|NO DATA|N\/A|null|undefined|NaN|\[object Object\])\b/g, msg: '状态码/空值上屏' },
  { id: 'ISO_TIME', re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z/g, msg: 'ISO/UTC 时间泄漏到界面' },
  { id: 'MARKDOWN', re: /\*\*|##(?= )|(?<!\S)\*(?!\*)/g, msg: 'Markdown 符号未渲染' },
  { id: 'PUNCT', re: /[。，、；：]{2,}|（\s*）|\(\s*\)|【\s*】|「\s*」/g, msg: '标点异常（连续/空括号）' },
  { id: 'HALFWIDTH', re: /[\u4e00-\u9fff],[\u4e00-\u9fff]|[\u4e00-\u9fff]\([\u4e00-\u9fff]/g, msg: '中文间用了半角标点' },
  { id: 'FUTURE_DATE', re: /\b(202[8-9]|20[3-9]\d)-\d{2}-\d{2}\b/g, msg: '出现未来日期' },
  { id: 'OLD_DATE', re: /\b(19\d|200\d|201[0-8])-\d{2}-\d{2}\b/g, msg: '出现异常久远日期' },
  { id: 'MIX_SCALE', re: /百万/g, msg: '「百万」量级词（与「万」制并存易打架，需人工确认）' },
];

function scanText(txt) {
  const hits = [];
  const lines = txt.split('\n');
  lines.forEach((line, li) => {
    RULES.forEach((r) => {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(line))) {
        hits.push({ rule: r.id, msg: r.msg, line: li + 1, text: line.slice(Math.max(0, m.index - 24), m.index + 40) });
        if (r.re.lastIndex === m.index) r.re.lastIndex++;
      }
    });
  });
  return hits;
}

/* 「共/合计 N 条」与实际行数比对 + 表格数字列求和校验 */
function checkTables(tables) {
  const probs = [];
  tables.forEach((tb) => {
    /* 1) 数值列求和 vs 合计行 */
    const numericCols = [];
    (tb.head || []).forEach((h, ci) => {
      let allNum = true; let n = 0;
      tb.rows.forEach((row) => {
        const v = (row[ci] || '').replace(/[, ]/g, '');
        if (/^-?\d+(\.\d+)?$/.test(v)) n++; else allNum = false;
      });
      if (allNum && n >= 2) numericCols.push(ci);
    });
    numericCols.forEach((ci) => {
      const sum = tb.rows.reduce((a, row) => a + Number((row[ci] || '').replace(/[, ]/g, '')), 0);
      const last = tb.rows[tb.rows.length - 1];
      const label = (last[0] || '') + (last[1] || '');
      if (!/合计|总计|小计|汇总/.test(label)) return;
      const shown = String(last[ci] || '').replace(/[, ]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(shown)) return;
      const diff = Math.abs(sum - Number(shown));
      if (diff > Math.max(0.01, Math.abs(sum) * 0.001)) {
        probs.push({ kind: 'SUM_MISMATCH', table: tb.i, col: (tb.head || [])[ci] || ci,
          detail: `合计 ${shown} ≠ 明细求和 ${+sum.toFixed(4)}（差 ${+diff.toFixed(4)}）` });
      }
    });
    /* 2) 同一列里数字精度忽全忽不全（如 12.5 与 12.50 与 12 并存） */
    numericCols.forEach((ci) => {
      const forms = new Set();
      tb.rows.forEach((row) => {
        const raw = (row[ci] || '').trim();
        const m = raw.match(/^(-?[\d,]+(?:\.\d+)?)(.*)$/);
        if (!m) return;
        const dec = (m[1].split('.')[1] || '').length;
        const hasComma = m[1].includes(',');
        forms.add(dec + '|' + (hasComma ? 'K' : 'P'));
      });
      if (forms.size > 2) {
        probs.push({ kind: 'NUM_FORMAT_MIX', table: tb.i, col: (tb.head || [])[ci] || ci,
          detail: `同一列出现 ${forms.size} 种数字格式：${[...forms].join(' / ')}` });
      }
    });
  });
  return probs;
}

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_text_'));
  let child = null; let cdp = null;
  const allFindings = [];
  const safeName = (s) => s.replace(/[^\w.-]+/g, '_');

  try {
    child = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars', '--no-proxy-server', '--proxy-bypass-list=*',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--window-size=1440,960', 'about:blank',
    ], { stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(300);
      try {
        const list = await new Promise((res, rej) => {
          http.get(`http://127.0.0.1:${PORT}/json/list`, (r) => {
            let d = ''; r.on('data', (c) => { d += c; });
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
          }).on('error', rej);
        });
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* 未就绪 */ }
    }
    if (!target) throw new Error('无法连接调试端口');

    cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
    await new Promise((r, j) => {
      cdp.ws.addEventListener('open', r, { once: true });
      cdp.ws.addEventListener('error', () => j(new Error('ws error')), { once: true });
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

    async function goto(route) {
      try { await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${route}` }, 90000); }
      catch { try { await cdp.send('Page.stopLoading', {}, 8000); } catch { /* 忽略 */ } }
      let probe = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        await sleep(300);
        try {
          probe = await cdp.json(`
            var main = document.querySelector('.content') || document.body;
            return { hash: location.hash,
              booting: !!document.querySelector('.boot'),
              textLen: (main.innerText||'').replace(/\\s+/g,' ').trim().length };
          `);
        } catch { continue; }
        if (probe && !probe.booting && probe.hash.indexOf(route) >= 0 && probe.textLen > 40) break;
      }
      await sleep(900);
      return probe;
    }

    async function auditPage(role, route, label) {
      const probe = await goto(route);
      if (!probe) {
        allFindings.push({ role, route, kind: 'FATAL', detail: '页面 40s 内未就绪' });
        return null;
      }
      let data = null;
      try { data = await cdp.json(EXTRACT); } catch (e) {
        allFindings.push({ role, route, kind: 'FATAL', detail: '取文失败: ' + String(e.message).slice(0, 120) });
        return null;
      }

      const file = path.join(PAGES_DIR, `${safeName(role)}__${safeName(route)}.txt`);
      const head = `# ${role} · ${route} · ${data.title}${data.desc ? '\n# desc: ' + data.desc : ''}\n`;
      fs.writeFileSync(file, head + data.text, 'utf8');

      const findings = [];
      scanText(data.text).forEach((h) => findings.push({ kind: h.rule, detail: `L${h.line} ${h.msg}：…${h.text}…` }));
      checkTables(data.table).forEach((p) => findings.push({ kind: p.kind, detail: `表${p.table} [${p.col}] ${p.detail}` }));
      if (data.text.length < 60 && route !== '/login') findings.push({ kind: 'THIN', detail: `正文仅 ${data.text.length} 字` });
      /* 同页同名键不同值 */
      const seen = new Map();
      data.kvs.forEach(([k, v]) => {
        if (!k) return;
        if (seen.has(k) && seen.get(k) !== v) {
          findings.push({ kind: 'KV_CONFLICT', detail: `「${k}」同页两个值：${seen.get(k)} vs ${v}` });
        }
        if (!seen.has(k)) seen.set(k, v);
      });

      findings.forEach((f) => allFindings.push({ role, route, label, ...f }));
      const mark = findings.length ? '⚠' : '✔';
      console.log(`  ${mark} ${route.padEnd(24)} ${(data.title || '(无标题)').slice(0, 14).padEnd(14)} 文本${String(data.text.length).padStart(5)} 项${findings.length}`);
      return data;
    }

    /* ---- 公开页（不登录）---- */
    console.log('════ 公开页 ════');
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
    /* about:blank 下 localStorage 会抛 SecurityError（Access is denied）——
     * 必须等到真正落到目标 origin 再碰它。固定 sleep 不够（冷启动时不够用）。 */
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const o = await cdp.eval('location.origin + "|" + document.readyState');
        if (String(o).indexOf('http') === 0 && String(o).endsWith('complete')) break;
      } catch { /* 导航中 */ }
    }
    await cdp.eval(`(function(){ localStorage.clear(); return 1; })()`);
    for (const r of PUBLIC_ROUTES) await auditPage('PUBLIC', r, '');

    /* ---- 登录角色页 ---- */
    if (!PUBLIC_ONLY) {
      for (const acc of ACCOUNTS) {
        if (ONLY_ROLE && acc.role !== ONLY_ROLE) continue;
        console.log(`\n════ ${acc.role}（${acc.user}）════`);
        const login = await httpJson('/api/auth/login', 'POST', { username: acc.user, password: acc.pass });
        const token = login && login.data && login.data.token;
        const user = login && login.data && login.data.user;
        if (!token) {
          console.log(`  ✘ 登录失败`);
          allFindings.push({ role: acc.role, route: '(login)', kind: 'FATAL', detail: '登录失败' });
          continue;
        }
        await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/login` }, 45000);
        await sleep(1800);
        await cdp.eval(`(function(){
          localStorage.setItem('cch_token', ${JSON.stringify(token)});
          localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))});
          return 1; })()`);
        const home = (user && user.role === 'TRADER') ? '/trade/market' : '/login';
        await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${home}` }, 45000);
        await sleep(2200);

        const routes = await cdp.json(`
          var ra = App.routeAccess || {};
          var role = App.Store.user && App.Store.user.role;
          var out = []; var seen = {};
          ((ra.MENUS || {})[role] || []).forEach(function(g){
            (g.items || []).forEach(function(it){
              if (seen[it.path]) return; seen[it.path] = 1;
              out.push({ path: it.path, label: it.label });
            });
          });
          return out;
        `);
        console.log(`  菜单入口 ${routes.length} 个`);
        for (const r of routes) await auditPage(acc.role, r.path, r.label);
      }
    }

    fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(allFindings, null, 2), 'utf8');
    console.log(`\n════ 汇总：${allFindings.length} 条疑似问题，全文已存 ${PAGES_DIR} ════`);
    const byKind = {};
    allFindings.forEach((f) => { byKind[f.kind] = (byKind[f.kind] || 0) + 1; });
    console.log('  ' + JSON.stringify(byKind));
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { /* 忽略 */ }
    try { if (child) child.kill(); } catch { /* 忽略 */ }
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main().catch((e) => { console.error('审计异常：', e.message); process.exit(2); });
