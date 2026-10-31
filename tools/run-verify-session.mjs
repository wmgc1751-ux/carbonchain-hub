#!/usr/bin/env node
/**
 * tools/run-verify-session.mjs —— 单进程验证会话
 * 起服务(8300+9100) → 等就绪 → 全量 verify:all → 关服务
 * 沙箱环境下后台常驻进程会被回收，因此必须"启动→测→关"同进程完成。
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const ROOT = process.cwd();
const NODE = process.execPath;

function up(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (r) => {
      r.resume(); resolve(r.statusCode > 0);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const server = spawn(NODE, ['server/app.js'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: '8300' },
});
server.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
server.stderr.on('data', (d) => process.stderr.write('[srv!] ' + d));

let code = 1;
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (await up(8300)) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('服务 90s 未就绪（8300 /api/health）');
  console.log('[runner] 服务就绪');
  /* 页面巡检（写 tools/out/ui-check.json，台账 ui.pages.pass 消费）。
   * 失败重试一次（无头 Edge 偶发 Page.navigate 超时）；巡检失败不阻断回归。 */
  let cdpStatus = 1;
  for (let attempt = 1; attempt <= 2 && cdpStatus !== 0; attempt++) {
    const cdp = spawnSync(NODE, ['server/scripts/cdp-check.js'], {
      cwd: ROOT, stdio: 'inherit', timeout: 10 * 60 * 1000,
    });
    cdpStatus = cdp.status ?? 1;
    console.log(`[runner] cdp-check 第 ${attempt} 次退出码 ${cdpStatus}`);
  }
  /* 巡检后复检服务 —— 实测出现过"巡检超时后服务无响应"导致 3 个套件 SKIP 的情况；
   * 服务不在就重启，保证后续 HTTP 类套件有真实被测对象。 */
  if (!(await up(8300))) {
    console.log('[runner] ⚠ 服务已不可达，重启 …');
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2000));
    try { server.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  let srv = server;
  for (let i = 0; i < 2 && !(await up(8300)); i++) {
    srv = spawn(NODE, ['server/app.js'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '8300' },
    });
    srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
    srv.stderr.on('data', (d) => process.stderr.write('[srv!] ' + d));
    for (let k = 0; k < 60 && !(await up(8300)); k++) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!(await up(8300))) throw new Error('服务重启后仍不可达');
  console.log('[runner] 服务可达，开始全量 verify:all …');
  const r = spawnSync(NODE, ['tools/verify-all.mjs'], {
    cwd: ROOT, stdio: 'inherit', timeout: 55 * 60 * 1000,
  });
  code = r.status ?? 1;
  console.log(`[runner] verify:all 退出码 ${code}`);
} catch (e) {
  console.error('[runner] 失败：', e.message);
  code = 2;
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  try { server.kill('SIGKILL'); } catch { /* 已退出 */ }
}
process.exit(code);
