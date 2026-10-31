#!/usr/bin/env node
/**
 * tools/verify-dist.mjs —— 静态产物（dist/）交付前校验
 * ==================================================================
 * 为什么需要它：静态站没有后端可以做运行期兜底，任何一个"引用了不存在的
 * 文件"或"快照结构不对"都会在线上直接表现为白屏 / 空态。本脚本在**上传前**
 * 把这类问题一次性挡下来。
 *
 * 校验 17 项，覆盖四个层面：
 *   A. 结构与引用完整性（1~6）
 *   B. 静态适配层可用性（7~10）
 *   C. 数据快照自洽性（11~14）
 *   D. 交付卫生（15~17）
 *
 * 用法
 *   npm run verify:dist
 *   node tools/verify-dist.mjs --dir dist
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ARGV = process.argv.slice(2);
const argOf = (n, d) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const DIR = path.resolve(ROOT, argOf('--dir', 'dist'));

let pass = 0; let fail = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? '  →  ' + detail : ''}`);
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

console.log('\n════════ 静态产物校验（dist） ════════');
console.log(`  目录  ${DIR}\n`);
console.log('  ── A. 结构与引用完整性 ──');

/* 1 */
check('产物目录存在', fs.existsSync(DIR), path.relative(ROOT, DIR));

/* 2 */
const indexPath = path.join(DIR, 'index.html');
const indexHtml = read(indexPath);
check('index.html 存在且非空', !!indexHtml && indexHtml.length > 500, indexHtml ? `${(indexHtml.length / 1024).toFixed(1)} KB` : '缺失');

/* 3 */
let missingScripts = [];
if (indexHtml) {
  const srcs = [...indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
  missingScripts = srcs.filter((s) => !fs.existsSync(path.join(DIR, s.split('?')[0].replace(/^\.\//, '')))); // 剥离 ?v= 内容哈希（bust-cache.mjs）
  check(`index.html 引用的 ${srcs.length} 个脚本均存在`, missingScripts.length === 0, missingScripts.slice(0, 3).join(', '));
} else check('index.html 引用的脚本均存在', false, '无法解析');

/* 4 */
let missingLinks = [];
if (indexHtml) {
  const hrefs = [...indexHtml.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s) && !s.startsWith('data:'));
  missingLinks = hrefs.filter((s) => !fs.existsSync(path.join(DIR, s.split('?')[0].replace(/^\.\//, '')))); // 剥离 ?v= 内容哈希
  check(`index.html 引用的 ${hrefs.length} 个样式/资源均存在`, missingLinks.length === 0, missingLinks.slice(0, 3).join(', '));
} else check('index.html 引用的资源均存在', false, '无法解析');

/* 5 */
const vendorFiles = ['vendor/vue.global.prod.js', 'vendor/echarts.min.js'];
const missingVendor = vendorFiles.filter((v) => !fs.existsSync(path.join(DIR, v)));
check('第三方运行时（Vue / ECharts）齐备', missingVendor.length === 0, missingVendor.join(', '));

/* 6 */
check('js/ 与 css/ 目录非空',
  fs.existsSync(path.join(DIR, 'js')) && fs.readdirSync(path.join(DIR, 'js')).length > 0
  && fs.existsSync(path.join(DIR, 'css')) && fs.readdirSync(path.join(DIR, 'css')).length > 0);

console.log('  ── B. 后端契约（动态化架构） ──');

/* ⚠ 这一节的断言在 2026-10-24 被整体换掉，原因必须写清楚：
 *   旧版检查的是「staticApi.js + api-snapshot.json 快照回放层」——那是
 *   静态站时代的做法，页面上的数字是某一时刻的快照却以"当前值"呈现，
 *   两个页面互相矛盾时无法判断哪个是真的。该层已随"线上全动态化"删除。
 *
 *   但校验器没跟着改，于是 `verify:dist` 永远 9/17 —— 一个永远失败的
 *   闸门等于没有闸门：没人会在意它，真正的新缺陷也被淹没在这 8 条假红里。
 *   现在改为断言"当前架构该有的东西"。
 */

/* 7 */
const legacyStaticApi = path.join(DIR, 'js', 'data', 'staticApi.js');
const legacySnap = path.join(DIR, 'data', 'api-snapshot.json');
const legacyRef = !!indexHtml && /staticApi\.js|api-snapshot\.json/.test(indexHtml);
check('已移除快照回放层（产物内无 staticApi / api-snapshot，且未被引用）',
  !fs.existsSync(legacyStaticApi) && !fs.existsSync(legacySnap) && !legacyRef,
  legacyRef ? 'index.html 仍引用快照层' : '');

/* 8 */
const fnEntry = read(path.join(ROOT, 'functions', 'api', '[[path]].js'));
check('Pages Functions 入口存在并委托 worker/index.mjs',
  !!fnEntry && /worker\/index\.mjs/.test(fnEntry), 'functions/api/[[path]].js');

/* 9 */
const workerIndex = read(path.join(ROOT, 'worker', 'index.mjs'));
const workerCopilot = read(path.join(ROOT, 'worker', 'routes', 'copilot.mjs'));
check('云端 copilot 路由随包（多模型网关接线完整）',
  !!workerIndex && /attachCopilotRoutes/.test(workerIndex)
  && /lib\/llm\.mjs/.test(workerCopilot || '') && /grounding/.test(workerCopilot || ''));

/* 10 */
const copilotView = read(path.join(DIR, 'js', 'views', 'copilot.js')) || '';
check('前端状态契约：顾问视图读取 llm.configured（配了密钥徽标必须能变）',
  /llm\.value\s*=\s*s\.llm/.test(copilotView) && /configured/.test(copilotView));

console.log('  ── C. 视图完整性 ──');

/* 11 */
const viewDir = path.join(DIR, 'js', 'views');
const viewFiles = fs.existsSync(viewDir) ? fs.readdirSync(viewDir).filter((f) => f.endsWith('.js')) : [];
const refViews = indexHtml ? [...new Set(indexHtml.match(/js\/views\/[a-z0-9-]+\.js/g) || [])] : [];
const missingViews = refViews.filter((r) => !fs.existsSync(path.join(DIR, r)));
check(`视图脚本齐备（目录 ${viewFiles.length} 个 / 引用 ${refViews.length} 个，无缺失）`,
  viewFiles.length > 0 && refViews.length === viewFiles.length && missingViews.length === 0,
  missingViews.slice(0, 3).join(', '));

/* 12 */
const mustHave = ['js/3d/plant3d.js', 'js/3d/twin3d.js', 'js/notify-center.js', 'js/data/dataLayer.js'];
const missingMust = mustHave.filter((f) => !fs.existsSync(path.join(DIR, f)));
check('3D / 实时推流 / 数据层脚本随包（上一版 dist 曾整体漏掉这三类）',
  missingMust.length === 0, missingMust.join(', '));

/* 13 */
const appJs = read(path.join(DIR, 'js', 'app.js')) || '';
const routes = [...appJs.matchAll(/\[\s*'(\/[^']*)'\s*,\s*'(page-[a-z0-9-]+)'/g)];
check(`路由表可解析且规模正常（${routes.length} 条）`, routes.length >= 80, `仅 ${routes.length} 条`);

/* 14 */
/* 视图既可注册在 views/*.js，也可注册在 app.js 外壳里（如 page-home），
 * 两处都要搜，否则外壳视图会被误判成"漏打包"。 */
let allJs = appJs;
for (const f of viewFiles) allJs += fs.readFileSync(path.join(viewDir, f), 'utf8');
const orphan = [...new Set(routes.map((m) => m[2]))].filter((vid) => !new RegExp(`['"]${vid}['"]`).test(allJs));
check('每个路由的视图 id 都有对应注册（防漏打包/改名）',
  orphan.length === 0, orphan.slice(0, 5).join(', '));

console.log('  ── D. 交付卫生 ──');

/* 15 */
const redirects = read(path.join(DIR, '_redirects'));
check('_redirects 提供 SPA 回退', !!redirects && /index\.html/.test(redirects) && /200/.test(redirects));

/* 16 */
const banned = ['.env', 'node_modules', 'package.json', 'package-lock.json', '.git'];
const present = banned.filter((b) => fs.existsSync(path.join(DIR, b)));
check('未打包敏感/冗余文件', present.length === 0, present.join(', '));

/* 17 */
let absHits = [];
(function scan(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') scan(p); continue; }
    if (!/\.(js|html)$/.test(e.name)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/g);
    if (m) absHits.push(`${path.relative(DIR, p)}:${m[0]}`);
  }
})(DIR);
check('前端无本机后端的绝对地址硬编码', absHits.length === 0, absHits.slice(0, 3).join(', '));

console.log('\n────────────────────────────────────────');
console.log(`  结果：${pass}/${pass + fail} 项通过`);
console.log(`────────────────────────────────────────\n`);
process.exit(fail === 0 ? 0 : 1);
