#!/usr/bin/env node
/* =====================================================================
   bust-cache.mjs —— 部署前对 dist/index.html 的本地 JS/CSS 引用做内容哈希版本化
   ---------------------------------------------------------------------
   背景坑（2026-10-26 实测定位）：
   自定义域 www.carbonchain.dpdns.org 所在 zone（DigitalPlat 托管，我们无控制权）
   会把 JS/CSS 的浏览器 TTL 覆盖为 max-age=14400（4h），覆盖掉 _headers 里的
   max-age=300 —— 用户浏览器在部署后最长 4 小时仍命中旧 JS。
   HTML 入口两侧都是 max-age=60，因此解法是：内容变了 → 引用 URL 变 → 缓存击穿。

   策略：对 index.html 里引用的 ./js/*.js / ./css/*.css 逐文件计算 MD5 前 8 位
   作为 ?v= 参数。文件没变 → URL 不变 → 缓存继续生效；变了 → URL 必变 → 强制拉新。
   vendor/（vue/echarts）保持不带参数：内容稳定走 7 天 immutable 长缓存，
   若升级 vendor 需手动清理（改文件名或接受 7 天窗口）。

   用法：node tools/bust-cache.mjs   （在 robocopy 打包 dist 之后、部署之前运行）
   ===================================================================== */
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(DIST, 'index.html');

if (!existsSync(INDEX)) {
  console.error('[bust-cache] dist/index.html 不存在 —— 先完成打包（robocopy public dist /MIR）');
  process.exit(1);
}

let html = readFileSync(INDEX, 'utf8');
const VENDOR_RE = /vendor\//; // vendor 不参与版本化（长缓存 immutable）

/* 匹配 href="./css/x.css" 或 src="./js/x.js"（不含 vendor） */
const REF_RE = /((?:src|href)=["'])\.\/((?:js|css)\/[^"']+?\.(?:js|css))(["'])/g;

let stamped = 0, unchanged = 0, missing = [];

html = html.replace(REF_RE, (m, pre, rel, post) => {
  if (VENDOR_RE.test(rel)) return m;
  const abs = path.join(DIST, rel.replace(/^\/+/, ''));
  if (!existsSync(abs)) { missing.push(rel); return m; }
  const hash = createHash('md5').update(readFileSync(abs)).digest('hex').slice(0, 8);
  return `${pre}./${rel}?v=${hash}${post}`;
});

/* 幂等：统计时区分"本次新加"与"哈希一致保留" */
stamped = (html.match(/\?v=[0-9a-f]{8}/g) || []).length;

if (missing.length) {
  console.error('[bust-cache] 引用缺失，中止（不写出半成品 index.html）:', missing);
  process.exit(2);
}

writeFileSync(INDEX, html);
console.log(`[bust-cache] 完成：index.html 共 ${stamped} 处带内容哈希版本号`);
console.log('[bust-cache] vendor/ 引用未版本化（immutable 长缓存，升级时需手动处理）');
