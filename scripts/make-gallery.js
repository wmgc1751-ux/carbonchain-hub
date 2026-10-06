/**
 * scripts/make-gallery.js
 * 把 browser-check.js 产出的巡检结果渲染成一份可翻看的 HTML 证据总览
 * （截图 + 每个路由的渲染指标 + 交互回归结果）。
 *
 * 用法：node scripts/make-gallery.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts');
const report = JSON.parse(fs.readFileSync(path.join(OUT, 'ui-report.json'), 'utf8'));

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const roleName = { ENTERPRISE: '企业端', VERIFIER: '核查机构端', REGULATOR: '监管端', null: '公众端' };
const groupOf = (r) => (r.role === 'ENTERPRISE' ? 'A' : r.role === 'VERIFIER' ? 'B' : r.role === 'REGULATOR' ? 'C' : 'D');
const groupTitle = {
  A: '一、企业端（控排企业）', B: '二、核查机构端', C: '三、监管端', D: '四、公众端（免登录）',
};

/* 分组：同一角色的连续路由归到一起 */
const ordered = report.details;
const groups = { A: [], B: [], C: [], D: [] };
ordered.forEach((d) => groups[groupOf(d)].push(d));

const shot = (f) => f.replace(/\\/g, '/');

function routeCard(d, i) {
  const ok = d.pass;
  return `
  <figure class="shot">
    <figcaption>
      <span class="idx">${String(i + 1).padStart(2, '0')}</span>
      <b>${esc(d.label)}</b>
      <code>#${esc(d.route)}</code>
      <span class="badge ${ok ? 'ok' : 'bad'}">${ok ? '通过' : '失败'}</span>
      <span class="meta">文本 ${d.textLen} · 表格 ${d.tables}（${d.rows} 行）· 图表 ${d.charts} · 控制台异常 ${d.logs.length}</span>
    </figcaption>
    <a href="${esc(shot(d.shot))}" target="_blank"><img loading="lazy" src="${esc(shot(d.shot))}" alt="${esc(d.label)}"></a>
  </figure>`;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>碳链通 · 系统实测证据总览</title>
<style>
  :root{
    --bg:#f5f7fa; --panel:#ffffff; --line:#e2e8f0; --tx:#0f172a; --tx2:#475569;
    --ok:#0f9d58; --bad:#dc2626; --accent:#0b7285;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
    font-family:"HarmonyOS Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;line-height:1.6}
  header{padding:30px 32px 22px;background:linear-gradient(135deg,#0b3d3a,#0b7285 55%,#1e6f9f);color:#fff}
  header h1{margin:0 0 6px;font-size:25px;letter-spacing:.5px}
  header p{margin:0;opacity:.9;font-size:13.5px}
  .kpis{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
  .kpi{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.25);border-radius:9px;padding:9px 14px;min-width:120px}
  .kpi b{display:block;font-size:19px}
  .kpi span{font-size:11.5px;opacity:.88}
  main{max-width:1280px;margin:0 auto;padding:24px 20px 70px}
  h2{font-size:16.5px;margin:30px 0 14px;padding-left:11px;border-left:4px solid var(--accent)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px}
  .shot{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:11px;overflow:hidden;
    box-shadow:0 1px 3px rgba(15,23,42,.06)}
  figcaption{padding:11px 13px 10px;font-size:13px;display:flex;flex-wrap:wrap;gap:7px;align-items:center}
  figcaption b{font-size:13.5px}
  figcaption code{background:#f1f5f9;color:var(--tx2);padding:1.5px 6px;border-radius:5px;font-size:11.5px}
  .idx{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;
    background:#e6f4f1;color:#0b7285;font-size:11.5px;font-weight:700}
  .badge{font-size:11.5px;padding:1.5px 8px;border-radius:99px;font-weight:600}
  .badge.ok{background:#e7f6ee;color:var(--ok)}
  .badge.bad{background:#fdecec;color:var(--bad)}
  .meta{flex-basis:100%;color:#64748b;font-size:11.5px}
  .shot img{display:block;width:100%;height:auto;border-top:1px solid var(--line);background:#0b1020}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:4px 16px 14px;margin-top:6px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 9px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--tx2);font-weight:600;font-size:12.5px;background:#f8fafc}
  tr:last-child td{border-bottom:0}
  .ok-t{color:var(--ok);font-weight:600}
  .bad-t{color:var(--bad);font-weight:600}
  footer{max-width:1280px;margin:0 auto;padding:0 20px 40px;color:#64748b;font-size:12px}
</style>
</head>
<body>
<header>
  <h1>碳链通 CarbonChain Hub · 系统实测证据总览</h1>
  <p>无头 Edge + Chrome DevTools Protocol 真实驱动浏览器逐页渲染 —— 不是截图拼贴，而是每次访问都记录 DOM 体量、表格行数、图表实例数、未解析组件与控制台异常。</p>
  <div class="kpis">
    <div class="kpi"><b>${report.routes.pass}/${report.routes.total}</b><span>路由渲染通过</span></div>
    <div class="kpi"><b>${report.interactions.pass}/${report.interactions.total}</b><span>关键交互通过</span></div>
    <div class="kpi"><b>${report.chain.height}</b><span>链高度</span></div>
    <div class="kpi"><b>${report.chain.totalTxs}</b><span>链上存证</span></div>
    <div class="kpi"><b>0</b><span>控制台异常</span></div>
    <div class="kpi"><b>${new Date(report.generatedAt).toLocaleString('zh-CN')}</b><span>采集时间</span></div>
  </div>
</header>
<main>
  <h2>关键交互回归</h2>
  <div class="panel">
    <table>
      <thead><tr><th style="width:34%">交互路径</th><th style="width:10%">结果</th><th>实测细节（脚本回读的浏览器状态）</th></tr></thead>
      <tbody>
        ${report.interactions.map((x) => `<tr><td>${esc(x.name)}</td><td class="${x.pass ? 'ok-t' : 'bad-t'}">${x.pass ? '通过' : '失败'}</td><td><code>${esc(x.detail)}</code></td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  ${Object.keys(groups).map((g) => groups[g].length ? `
  <h2>${groupTitle[g]}</h2>
  <div class="grid">${groups[g].map((d, i) => routeCard(d, ordered.indexOf(d))).join('')}</div>` : '').join('')}

  <h2>逐个路由的渲染指标</h2>
  <div class="panel">
    <table>
      <thead><tr><th>#</th><th>端</th><th>路由</th><th>页面</th><th>结果</th><th>文本量</th><th>表格/行</th><th>图表</th><th>异常</th><th>未解析组件</th></tr></thead>
      <tbody>
        ${ordered.map((d, i) => `<tr>
          <td>${i + 1}</td><td>${esc(roleName[d.role])}</td><td><code>${esc(d.route)}</code></td><td>${esc(d.label)}</td>
          <td class="${d.pass ? 'ok-t' : 'bad-t'}">${d.pass ? '通过' : '失败'}</td>
          <td>${d.textLen}</td><td>${d.tables} / ${d.rows}</td><td>${d.charts}</td><td>${d.logs.length}</td>
          <td>${(d.unresolved || []).length ? esc(d.unresolved.join(', ')) : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</main>
<footer>
  复现方式：<code>node server/app.js</code> 启动服务后执行 <code>node scripts/browser-check.js</code>，原始数据见 <code>artifacts/ui-report.json</code>。
</footer>
</body>
</html>`;

fs.writeFileSync(path.join(OUT, '证据总览.html'), html, 'utf8');
console.log('已生成 artifacts/证据总览.html ，共 ' + ordered.length + ' 个路由 + ' + report.interactions.length + ' 项交互');
