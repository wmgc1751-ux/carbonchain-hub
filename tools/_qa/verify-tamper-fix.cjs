#!/usr/bin/env node
/**
 * tools/_qa/verify-tamper-fix.cjs —— 针对性复现 + 验证防篡改面板缺陷
 * 步骤：进 /explorer（企业端）→ 点「模拟恶意篡改」→ 点「按共识重新出块并修复」
 *      → 若修复后出现 TypeError 则复现成功；修复后应无任何错误。
 * 结束：无论结果如何都调用 /api/chain/repair 把链恢复。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9461, BASE = 'http://127.0.0.1:8300';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hj(p, m = 'GET', b, tok) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const h = { 'Content-Type': 'application/json' };
    if (tok) h.Authorization = 'Bearer ' + tok;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const q = http.request({ host: '127.0.0.1', port: 8300, path: p, method: m, headers: h }, (r) => {
      let s = ''; r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch { res({ raw: s.slice(0, 200) }); } });
    });
    q.on('error', rej); if (d) q.write(d); q.end();
  });
}

(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), '_cch_tf_'));
  const ch = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 70; i++) {
    await sleep(300);
    try {
      const l = await new Promise((r2, j) => { http.get(`http://127.0.0.1:${PORT}/json/list`, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => r2(JSON.parse(d))); }).on('error', j); });
      t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (t) break;
    } catch { /* wait */ }
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const send = (m, p = {}, to = 40000) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { pend.set(id, { res, rej }); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('to ' + m)); } }, to); }); };
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text).slice(0, 200)); return r.result ? r.result.value : undefined; };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function(){
      window.__errs = [];
      window.addEventListener('error', function(e){ window.__errs.push('uncaught: ' + e.message); }, true);
      var t=0, iv=setInterval(function(){
        if (window.App && App.notify && !App.notify.err.__w) {
          var o = App.notify.err.bind(App.notify);
          var w = function(m){ window.__errs.push('toast: ' + m); return o.apply(null, arguments); };
          w.__w = 1; App.notify.err = w; clearInterval(iv);
        }
        if (++t > 400) clearInterval(iv);
      }, 25);
    })();`,
  });

  const lg = await hj('/api/auth/login', 'POST', { username: 'ent001', password: '123456' });
  const tok = lg.data.token, usr = lg.data.user;
  await send('Page.navigate', { url: `${BASE}/?_=1#/explorer` }); await sleep(2500);
  await ev(`localStorage.setItem('cch_token',${JSON.stringify(tok)});localStorage.setItem('cch_user',${JSON.stringify(JSON.stringify(usr))});1`);
  await send('Page.navigate', { url: `${BASE}/?_=2#/explorer` });

  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    await sleep(400);
    const ok = await ev(`!!(document.querySelector('.content') && /防篡改|篡改/.test(document.body.innerText))`).catch(() => false);
    if (ok) break;
  }

  const click = async (label) => ev(`(function(){
    var els = Array.prototype.slice.call(document.querySelectorAll('button'));
    var b = els.filter(function(el){ return (el.innerText||'').trim().indexOf(${JSON.stringify(label)}) >= 0; })[0];
    if (!b) return 'NOT_FOUND';
    b.click(); return 'CLICKED';
  })()`);

  console.log('点「模拟恶意篡改」:', await click('模拟恶意篡改'));
  await sleep(3500);
  console.log('点「按共识重新出块并修复」:', await click('按共识重新出块并修复'));
  await sleep(6000);

  const errs = await ev(`JSON.stringify(window.__errs||[])`);
  const panelTxt = await ev(`(function(){var a=document.querySelectorAll('.alertbar');return a.length?a[0].innerText.slice(0,120):'(无)';})()`);
  console.log('面板首条提示:', panelTxt);
  console.log('捕获错误:', errs);

  /* 兜底恢复链 */
  const rep = await hj('/api/chain/repair', 'POST', { fromIndex: 1 });
  console.log('兜底修复:', rep.code === 0 ? 'OK 已重算 ' + (rep.data.repaired || []).length + ' 块' : JSON.stringify(rep).slice(0, 120));

  const list = JSON.parse(errs || '[]');
  console.log(list.length ? '✘ 仍有 ' + list.length + ' 条错误' : '✔ 修复后无任何错误');
  ws.close(); ch.kill(); await sleep(300); fs.rmSync(prof, { recursive: true, force: true });
  process.exit(list.length ? 1 : 0);
})();
