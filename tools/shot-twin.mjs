/**
 * shot-twin.mjs —— 用本机 Edge + CDP 抓 /twin 页真实渲染，用于诊断 3D 场景
 * 运行：node tools/shot-twin.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.APP_BASE || 'http://127.0.0.1:8300';
const PORT = Number(process.env.CDP_PORT || 9333);
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.resolve('artifacts');
const SHOT = path.join(OUT, 'screens');
const W = Number(process.env.SHOT_W || 1600);
const H = Number(process.env.SHOT_H || 1000);
const TAG = process.env.SHOT_TAG || 'twin';
const ROUTE = process.env.SHOT_ROUTE || '/twin';
const PICK = Number(process.env.SHOT_PICK || 0);   // 切换到第 N 个候选设施（1 起）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((res, rej) => {
  const req = http.get(url, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
  req.on('error', rej);
  req.setTimeout(8000, () => req.destroy(new Error('timeout')));
});

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
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 30000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  }
}

const INIT = `
window.__logs = [];
(function(){
  var oe = console.error;
  console.error = function(){ window.__logs.push({lvl:'error', msg: Array.prototype.map.call(arguments,String).join(' ')}); oe.apply(console, arguments); };
  window.addEventListener('error', function(e){
    var t = e.target && e.target.tagName;
    if (t && t !== 'SCRIPT' && t !== 'IMG' && t !== 'LINK') window.__logs.push({lvl:'uncaught', msg: String(e.message)+' @ '+e.filename+':'+e.lineno});
    else if (t) window.__logs.push({lvl:'resource', msg: t+' 加载失败: '+(e.target.src||e.target.href)});
  }, true);
  window.addEventListener('unhandledrejection', function(e){ window.__logs.push({lvl:'unhandledRejection', msg: String(e.reason&&e.reason.message||e.reason)}); });
})();
`;

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const profile = path.join(OUT, '.edge-profile-' + Date.now());
  const child = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--mute-audio', '--no-proxy-server', '--proxy-bypass-list=*',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore' });
  child.unref();

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(300);
    try { target = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch { /* wait */ }
  }
  if (!target) throw new Error('连不上 Edge 调试端口');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws error'))); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  await cdp.send('Page.navigate', { url: `${BASE}/#${ROUTE}` });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { if ((await cdp.evaluate(`!!document.querySelector('.tw-canvas-wrap canvas')`)) === true) break; } catch { /* nav */ }
  }
  await sleep(3500);

  const viewport = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT, `${TAG}-viewport.png`), Buffer.from(viewport.data, 'base64'));

  if (PICK > 1) {
    await cdp.evaluate(`(function(){
      var items = document.querySelectorAll('.tw-item');
      if (items.length >= ${PICK}) items[${PICK} - 1].click();
      return items.length;
    })()`);
    await sleep(3500);
  }

  // 只截 3D 舞台（含工具栏/HUD），用于判断构图
  const rect = await cdp.evaluate(`(function(){
    var r = document.querySelector('.tw-stage').getBoundingClientRect();
    return { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY),
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  const stageShot = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
  });
  fs.writeFileSync(path.join(SHOT, `${TAG}-stage.png`), Buffer.from(stageShot.data, 'base64'));

  const metrics = await cdp.send('Page.getLayoutMetrics');
  const size = metrics.cssContentSize || metrics.contentSize;
  const full = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.max(size.width, W), height: Math.min(Math.max(size.height, 800), 5200), scale: 1 },
  });
  fs.writeFileSync(path.join(SHOT, `${TAG}-full.png`), Buffer.from(full.data, 'base64'));

  const info = await cdp.evaluate(`(function(){
    const app = document.getElementById('app');
    const wrap = document.querySelector('.tw-canvas-wrap');
    const cv = wrap && wrap.querySelector('canvas');
    return {
      pageH: document.documentElement.scrollHeight,
      stage: wrap ? { w: wrap.clientWidth, h: wrap.clientHeight } : null,
      canvas: cv ? { w: cv.width, h: cv.height, cssW: cv.clientWidth, cssH: cv.clientHeight } : null,
      text: (app.innerText||'').replace(/\\s+/g,' ').slice(0, 500),
      logs: (window.__logs||[]).slice(0,12),
      fit: window.__twFit || null,
      unresolved: Array.from(document.querySelectorAll('*')).filter(n=>n.tagName.startsWith('X-')).map(n=>n.tagName.toLowerCase()),
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));

  try { ws.close(); } catch { /* ignore */ }
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 1500);
  process.exit(0);
}

main().catch((e) => { console.error('失败：', e?.stack || e); process.exit(1); });
