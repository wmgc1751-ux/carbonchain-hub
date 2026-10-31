/**
 * dpp-export-check.js —— D① 缺口的功能级证据
 * 验证：区块链浏览器 → 数字护照弹窗 →「导出数据包（JSON）」确实落盘，
 *       且导出物含 schema/链上锚点/核查签名，可离线复核。
 * 复用 cdp-check.js 的零依赖 Edge + CDP 模式。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.APP_BASE || 'http://127.0.0.1:8300';
const PORT = Number(process.env.CDP_PORT || 9334);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(process.cwd(), '_ui-check');
const DL = path.join(OUT, 'dpp-download');
const W = 1680, H = 1050;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: 8300, path: p, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } },
      (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}
const httpJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.seq; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 30000); }); }
  async evaluate(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined; }
}

/** 点击按钮（按可见文本包含匹配） */
const CLICK = (txt) => `(function(){
  var bs = Array.prototype.slice.call(document.querySelectorAll('button'));
  var b = bs.filter(function(x){ return (x.innerText||'').indexOf(${JSON.stringify(txt)}) >= 0 && !x.disabled; })[0];
  if (!b) return 'NOT_FOUND';
  b.click(); return 'CLICKED';
})()`;

async function main() {
  fs.mkdirSync(DL, { recursive: true });
  for (const f of fs.readdirSync(DL)) fs.unlinkSync(path.join(DL, f));

  const s = await httpReq('POST', '/api/auth/login', { username: 'ent001', password: '123456' });
  const token = s && s.data && s.data.token;
  const user = s && s.data && s.data.user;
  if (!token) throw new Error('登录失败');
  console.log('登录 ent001 => OK');

  try { const ps = spawn('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`], { stdio: ['ignore', 'pipe', 'ignore'] }); let o = ''; ps.stdout.on('data', (d) => { o += d; }); await new Promise((r) => ps.on('close', r)); for (const pid of o.trim().split(/\s+/).filter(Boolean)) { spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); await sleep(600); } } catch (e) {}

  const profile = path.join(OUT, '.edge-dpp-' + Date.now());
  const child = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--hide-scrollbars',
    '--mute-audio', '--no-proxy-server', '--proxy-bypass-list=*', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  child.unref();

  let target = null;
  for (let i = 0; i < 80 && !target; i++) { await sleep(300); try { target = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) {} }
  if (!target) throw new Error('连接不上 Edge 调试端口');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws error'))); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  try { await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true }); }
  catch (e) { await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }); }

  await cdp.send('Page.navigate', { url: `${BASE}/#/login` });
  for (let i = 0; i < 60; i++) { await sleep(250); try { if (String(await cdp.evaluate('location.origin')).indexOf('http') === 0) break; } catch (e) {} }
  await cdp.evaluate(`(function(){ localStorage.setItem('cch_token', ${JSON.stringify(token)}); localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(user))}); return true; })()`);

  await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/explorer` });
  for (let i = 0; i < 60; i++) { await sleep(300); const n = await cdp.evaluate(`document.querySelectorAll('button.btn.xs.chain').length`).catch(() => 0); if (n > 0) break; }

  const c1 = await cdp.evaluate(CLICK('数字护照'));
  console.log('打开数字护照 =>', c1);
  if (c1 !== 'CLICKED') throw new Error('未找到「数字护照」按钮');
  await sleep(1200);

  const modal = await cdp.evaluate(`document.body.innerText.indexOf('Digital Product Passport') >= 0`);
  console.log('护照弹窗已渲染 =>', modal);

  const c2 = await cdp.evaluate(CLICK('导出数据包'));
  console.log('点击导出 =>', c2);
  if (c2 !== 'CLICKED') throw new Error('未找到「导出数据包」按钮');

  let files = [];
  for (let i = 0; i < 40; i++) { await sleep(300); files = fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload')); if (files.length) break; }

  const res = { modalRendered: modal, clicked: c2, files, ok: false };
  if (files.length) {
    const p = path.join(DL, files[0]);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.file = files[0];
    res.bytes = fs.statSync(p).size;
    res.schema = j.schema;
    res.dppNo = j.dppNo;
    res.hasChainAnchor = !!(j.chainAnchor && j.chainAnchor.txHash && j.chainAnchor.blockHash);
    res.hasVerification = !!(j.verification && j.verification.signature);
    res.tamperEvidenceChain = (j.tamperEvidenceChain || []).length;
    res.ok = j.schema === 'carbonchain.dpp/v1' && res.hasChainAnchor && res.hasVerification;
  }

  console.log('\n── D① 证据 ──');
  console.log(JSON.stringify(res, null, 2));
  fs.writeFileSync(path.join(OUT, 'dpp-export-report.json'), JSON.stringify(res, null, 2), 'utf8');

  try { ws.close(); } catch (e) {}
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }, 1500);
  setTimeout(() => process.exit(res.ok ? 0 : 1), 2000);
}

main().catch((e) => { console.error('D① 证据脚本失败：', (e && e.stack) || e); process.exit(1); });
