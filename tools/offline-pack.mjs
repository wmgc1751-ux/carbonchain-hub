#!/usr/bin/env node
/**
 * tools/offline-pack.mjs —— 答辩现场「离线应急包」一键启动器
 * ==================================================================
 * 用途：把"答辩现场断网"这个最大的不确定性，压缩成一条命令。
 *
 * 三级降级策略（按可靠性从高到低）：
 *   ┌─ 第 1 层  线上静态站（www.carbonchain.dpdns.org）—— 有网时的首选，零本地依赖
 *   ├─ 第 2 层  本地静态站（dist/）—— 断网但机器在，5 秒起一个静态服务
 *   └─ 第 3 层  本地全栈（npm start）—— 需要"真落库写入"演示时，走 MySQL + 后端
 *
 * 本脚本只负责第 2 层（静态站）与第 3 层（全栈）的**一键拉起**与**健康自检**。
 * 第 1 层无需脚本，直接开浏览器即可。
 *
 * 用法：
 *   npm run offline
 *   或 node tools/offline-pack.mjs [static|full]
 *
 *   static  → 起静态站（默认，端口 8899，零数据库依赖）
 *   full    → 起全栈（端口 8300 + 9100，需本机 MySQL）
 *
 * 依赖：仅 Node 内置模块，零 npm 依赖，断网可用。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const mode = process.argv[2] || 'static';

const DIST = process.env.DIST_DIR || 'D:/AI/WorkBuddy/workspace/dist';
const STATIC_PORT = Number(process.env.OFFLINE_STATIC_PORT || 8899);
const FULL_PORT = Number(process.env.OFFLINE_FULL_PORT || 8300);
const FULL_TCP_PORT = Number(process.env.OFFLINE_TCP_PORT || 9100);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
};

/* ---------- 第 2 层：静态站 ---------- */
function serveStatic() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error(`✘ dist 不存在或损坏：${DIST}\n  请先跑：node scripts/01-preprocess.mjs（在 D:/AI/WorkBuddy/workspace 下）`);
    process.exit(1);
  }
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const full = join(DIST, p);
    try {
      const st = await stat(full);
      if (st.isDirectory()) throw new Error('dir');
      const buf = await readFile(full);
      res.writeHead(200, {
        'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buf);
    } catch {
      // SPA 回退：未知路径（含 /api/*）返回 index.html
      try {
        const buf = await readFile(join(DIST, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
      }
    }
  });
  server.listen(STATIC_PORT, '127.0.0.1', () => {
    console.log(`\n✅ 静态站已就绪（第 2 层降级）`);
    console.log(`   访问：http://127.0.0.1:${STATIC_PORT}`);
    console.log(`   说明：读操作 100% 可用；写操作响应真实但刷新回快照基准态（静态层无落库）。`);
    console.log(`   需要"真落库写入"演示时，改用：npm run offline -- full\n`);
  });
}

/* ---------- 第 3 层：全栈 ---------- */
function serveFull() {
  console.log(`\n🚀 正在启动全栈后端（第 3 层降级，需本机 MySQL）…\n`);
  const child = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, HJ212_AUTOSTART: '1', CEMS_INTERVAL_MS: '86400000', PORT: String(FULL_PORT) },
  });
  child.on('exit', (code) => {
    console.log(`\n后端已退出（code=${code}）。如需重启用：npm run offline -- full`);
  });
}

/* ---------- 健康自检 ---------- */
function checkPort(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function healthCheck() {
  const results = [];
  const staticUp = await checkPort('127.0.0.1', STATIC_PORT);
  const fullUp = await checkPort('127.0.0.1', FULL_PORT);
  const tcpUp = await checkPort('127.0.0.1', FULL_TCP_PORT);
  const onlineUp = await checkPort('www.carbonchain.dpdns.org', 443, 4000);

  results.push(['第 1 层 · 线上静态站', onlineUp]);
  results.push(['第 2 层 · 本地静态站', staticUp]);
  results.push(['第 3 层 · 本地全栈 HTTP', fullUp]);
  results.push(['第 3 层 · 本地 HJ212 TCP', tcpUp]);

  console.log('\n════════ 离线应急包 · 健康自检 ════════');
  for (const [name, up] of results) {
    console.log(`  ${up ? '✅' : '❌'} ${name}${up ? ' · 在线' : ' · 未就绪'}`);
  }
  console.log('════════════════════════════════════════\n');
  return results;
}

/* ---------- 主入口 ---------- */
if (mode === 'health') {
  healthCheck().then(() => process.exit(0));
} else if (mode === 'full') {
  serveFull();
  console.log(`   后端启动后访问：http://127.0.0.1:${FULL_PORT}`);
  console.log(`   设备 TCP 端口：${FULL_TCP_PORT}（HJ 212-2017）\n`);
} else {
  serveStatic();
  // 静态站不阻塞：健康自检后打印提示
  setTimeout(async () => {
    const ok = await checkPort('127.0.0.1', STATIC_PORT, 1500);
    if (!ok) { console.error('✘ 静态站启动失败'); process.exit(1); }
  }, 500);
}
