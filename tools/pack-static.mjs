#!/usr/bin/env node
/**
 * tools/pack-static.mjs —— 静态站打包器（产出可上传 Cloudflare Pages 的 dist/）
 * ==================================================================
 * 背景：本项目前端为**无构建**架构（public/ 直接由 <script> 加载）。
 * 因此"打包"不含编译，只做三件事：
 *   ① 把 public/ 原样复制为 dist/
 *   ② 确认快照 data/api-snapshot.json 为最新（可由 --harvest 先抓）
 *   ③ 写入静态托管所需的路由规则 _redirects（SPA 回退到 index.html）
 *
 * 用法
 *   npm run pack:static                 # 打包（要求快照已存在）
 *   npm run pack:static -- --harvest    # 打包前先抓取快照
 *   npm run pack:static -- --out dist
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const ARGV = process.argv.slice(2);
const argOf = (n, d) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const SRC = path.join(ROOT, 'public');
const OUT = path.resolve(ROOT, argOf('--out', 'dist'));

console.log('\n════════ 静态站打包 ════════');
console.log(`  源目录  public/`);
console.log(`  输出    ${path.relative(ROOT, OUT)}/\n`);

/* 0) 可选：先抓快照 */
if (ARGV.includes('--harvest')) {
  console.log('  ▶ 先执行快照抓取…');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'harvest-api.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('✘ 快照抓取失败，已中止打包。'); process.exit(1); }
}

/* 1) 前置检查
 *
 * ⚠⚠ 2026-10-25 修正：这里原本硬性要求 public/data/api-snapshot.json 存在，
 *   否则拒绝打包。但那个"静态快照层"已于 2026-10-24 整体下线 ——
 *   线上 /api/* 全部交给 functions/api/[[path]].js → worker/index.mjs + D1，
 *   前端不再读快照。
 *   结果就是这个闸门从此**永远失败**，谁也无法打包：
 *   "永远失败的闸门等于没闸门"，而且会逼着人绕过它手工 cp，绕过时还会漏文件。
 *   现在改为：快照存在则照旧校验（兼容老分支），不存在则是正常状态，继续打包。
 */
if (!fs.existsSync(path.join(SRC, 'index.html'))) { console.error('✘ public/index.html 不存在。'); process.exit(1); }

const snapSrc = path.join(SRC, 'data', 'api-snapshot.json');
if (fs.existsSync(snapSrc)) {
  try {
    const meta = JSON.parse(fs.readFileSync(snapSrc, 'utf8')).meta || {};
    console.log(`  ✔ 快照就绪（兼容旧流程）：读端点 ${meta.endpointCount} · 写动作 ${meta.actionCount} · 抓取于 ${meta.harvestedAt}`);
  } catch (e) {
    console.log('  · 检测到 api-snapshot.json 但无法解析，按动态架构继续（不影响产物）');
  }
} else {
  console.log('  · 动态架构：/api/* 由 Pages Functions 处理，无需静态快照');
}

/* 2) 复制
 *
 * ⚠⚠ 2026-10-25 改成"先建新目录、成功后再替换"。
 *   旧写法是 rmSync(dist) → cpSync，中间被打断（沙箱回收进程 / Ctrl+C /
 *   磁盘满）就会留下一个**空的 dist/**：看起来打包完成了，实际线上是白屏，
 *   而且 dist 被删掉后连回滚都没有。本期已经真实发生过一次。
 *   新写法最坏情况下留下一个 dist.new/，dist/ 原封不动。
 */
const STAGE = OUT + '.new';
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.cpSync(SRC, STAGE, { recursive: true });
console.log('  ✔ 已复制 public/ → ' + path.relative(ROOT, STAGE) + '/（暂存）');

/* 3) SPA 回退规则（写进暂存目录，与产物一起切换） */
fs.writeFileSync(path.join(STAGE, '_redirects'), '/*    /index.html   200\n', 'utf8');
console.log('  ✔ 已写入 _redirects（SPA 回退到 index.html）');

/* 3.5) 替换：先确保暂存目录里真的有 index.html，再动 dist */
if (!fs.existsSync(path.join(STAGE, 'index.html'))) {
  console.error('✘ 暂存目录缺少 index.html，已中止（dist/ 未被改动）。');
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(STAGE, OUT);
console.log('  ✔ 已切换 ' + path.relative(ROOT, OUT) + '/');

/* 3.6) 缓存版本化：index.html 的本地 JS/CSS 引用加内容哈希 ?v=
   —— 自定义域 zone 会把 JS/CSS 浏览器 TTL 覆盖为 4h，内容变了必须换 URL
      （2026-10-26 实测定位，详见 tools/bust-cache.mjs 头注释） */
try {
  await import('./bust-cache.mjs');
} catch (e) {
  console.error('✘ bust-cache 失败，中止（dist/ 内容已就绪但未版本化，禁止部署）：', e.message);
  process.exit(1);
}

/* 4) 统计 */
function walk(dir) {
  let files = 0; let bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = walk(p); files += s.files; bytes += s.bytes; }
    else { files++; bytes += fs.statSync(p).size; }
  }
  return { files, bytes };
}
const st = walk(OUT);
const largest = (() => {
  const list = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p); else list.push([path.relative(OUT, p), fs.statSync(p).size]);
    }
  })(OUT);
  return list.sort((a, b) => b[1] - a[1]).slice(0, 3);
})();

console.log(`\n────────────────────────────────────────`);
console.log(`  文件 ${st.files} 个 · 总体积 ${(st.bytes / 1048576).toFixed(2)} MB`);
console.log(`  最大文件：${largest.map(([f, s]) => `${f} (${(s / 1048576).toFixed(2)}MB)`).join(' · ')}`);
console.log(`  下一步：npm run verify:dist   然后上传 ${path.relative(ROOT, OUT)}/ 到 Cloudflare Pages`);
console.log(`────────────────────────────────────────\n`);
