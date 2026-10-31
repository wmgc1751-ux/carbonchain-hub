#!/usr/bin/env node
/** 单进程：起服务 → cdp-check 页面巡检（重试2次）→ 关服务 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
const ROOT = process.cwd();
const up = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (r) => { r.resume(); resolve(r.statusCode > 0); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});
const server = spawn(process.execPath, ['server/app.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: '8300' } });
let code = 1;
try {
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) { ready = await up(8300); if (!ready) await new Promise((r) => setTimeout(r, 1000)); }
  if (!ready) throw new Error('服务未就绪');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync(process.execPath, ['server/scripts/cdp-check.js'], { cwd: ROOT, stdio: 'inherit', timeout: 10 * 60 * 1000 });
    console.log(`[cdp-session] 第 ${attempt} 次退出码 ${r.status}`);
    if (r.status === 0) { code = 0; break; }
  }
} catch (e) { console.error('[cdp-session]', e.message); }
finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  try { server.kill('SIGKILL'); } catch { /* 已退出 */ }
}
process.exit(code);
