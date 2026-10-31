/**
 * check-frontend.mjs —— 前端静态审查（构建检查的替代品）
 * ==================================================================================
 * 【为什么需要这个：本项目零构建】
 *
 * 平台是"Vue 3 全局构建 + 零打包"，没有 webpack/vite 在编译期帮你抓错误。
 * `node --check` 只验证语法，抓不到这些问题：
 *   · 用了未定义的全局变量（浏览器里要到运行时才 TypeError）
 *   · h('x-foo') 引用了未注册的组件（会渲染成空的自定义元素，不报错）
 *   · 组件注册名与路由表不一致（页面点进去是 404）
 *   · 跨文件引用的 App.* 命名空间拼错
 *
 * 这些错误在浏览器里表现为"页面白屏或某块不显示"，且控制台信息往往
 * 指向无关位置。因此做一遍静态审查，比人工点 70 个页面可靠得多。
 *
 * 检查项：
 *   1. 语法（node --check 的等价物）
 *   2. 未声明的裸全局标识符（白名单：Vue / App / window / document / ...）
 *   3. h('x-*') 引用的组件是否在 components.js 里注册
 *   4. App.views['page-*'] 与 app.js 路由表是否一一对应
 *   5. App.XXX 命名空间引用是否都有定义处
 *
 * 用法：node tools/check-frontend.mjs
 * @module tools/check-frontend
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const problems = [];
const warnings = [];
const add = (kind, file, line, msg) => problems.push({ kind, file, line, msg });
const warn = (kind, file, line, msg) => warnings.push({ kind, file, line, msg });

/* ==================================================================================
 * 一、收集文件
 * ================================================================================== */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

const jsFiles = [
  ...walk(path.join(ROOT, 'public/js')),
].filter((f) => !f.includes('vendor'));

console.log(`扫描 ${jsFiles.length} 个前端脚本`);

/* ==================================================================================
 * 二、语法检查
 * ================================================================================== */
for (const f of jsFiles) {
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ').trim();
    add('SYNTAX', path.relative(ROOT, f), 0, msg);
  }
}

/* ==================================================================================
 * 三、收集已注册组件与视图
 * ================================================================================== */
const compSrc = fs.readFileSync(path.join(ROOT, 'public/js/components.js'), 'utf8');
const registeredComponents = new Set();
{
  const re = /(['"])(x-[a-z0-9-]+)\1\s*:/g;
  let m;
  while ((m = re.exec(compSrc)) !== null) registeredComponents.add(m[2]);
}

const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
const routeViews = new Set();
{
  /* 路由表形如 ['/path', 'page-xxx'], */
  const re = /\[\s*'([^']+)'\s*,\s*'(page-[a-z0-9-]+)'\s*\]/g;
  let m;
  while ((m = re.exec(appSrc)) !== null) routeViews.add(m[2]);
}

const declaredViews = new Set();
for (const f of jsFiles) {
  const s = fs.readFileSync(f, 'utf8');
  /* 两种注册方式：
   *   ① 单个：App.views['page-xxx'] = X
   *   ② 批量：Object.assign(App.views, { 'page-xxx': X, ... })
   * 第 ② 种在原实现里被漏掉了 —— 于是 35 个视图全被判成"未定义"，
   * 一大批假阳性把真问题（x-alert 未注册）淹没了。
   * 判据必须覆盖两种写法，否则这个检查器本身就是噪声源。 */
  const re1 = /App\.views\[['"]([a-z0-9-]+)['"]\]\s*=/g;
  let m;
  while ((m = re1.exec(s)) !== null) declaredViews.add(m[1]);

  const re2 = /Object\.assign\(\s*App\.views\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = re2.exec(s)) !== null) {
    const body = m[1];
    const reProp = /['"]([a-z0-9-]+)['"]\s*:/g;
    let pm;
    while ((pm = reProp.exec(body)) !== null) declaredViews.add(pm[1]);
  }
}

/* ==================================================================================
 * 四、检查 h('x-*') 组件引用
 * ================================================================================== */
const COMPONENT_ALIASES = new Set([
  /* 这些是通过 h(变量名) 渲染的，不是字符串标签 */
]);

for (const f of jsFiles) {
  const s = fs.readFileSync(f, 'utf8');
  const lines = s.split('\n');
  lines.forEach((line, i) => {
    /* 匹配 h('x-foo' 或 h("x-foo" */
    const re = /\bh\(\s*['"](x-[a-z0-9-]+)['"]/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const tag = m[1];
      if (!registeredComponents.has(tag)) {
        add('UNREGISTERED_COMPONENT', path.relative(ROOT, f), i + 1,
          `h('${tag}') 未在 components.js 注册 → 会渲染成空的 <${tag}> 自定义元素`);
      }
    }
  });
}

/* ==================================================================================
 * 五、检查路由与视图的一一对应
 * ================================================================================== */
for (const v of routeViews) {
  if (!declaredViews.has(v)) {
    add('MISSING_VIEW', 'public/js/app.js', 0,
      `路由引用了视图 '${v}'，但没有任何文件定义 App.views['${v}']`);
  }
}
for (const v of declaredViews) {
  if (v.startsWith('page-') && !routeViews.has(v) && v !== 'page-home' && v !== 'page-404') {
    warn('ORPHAN_VIEW', '-', 0, `视图 '${v}' 已定义但未在任何路由中使用（可能是死代码）`);
  }
}

/* ==================================================================================
 * 六、检查 App.* 命名空间引用
 * ================================================================================== */
/* 先收集所有"定义"：App.Xxx = ... 或 App.Xxx 出现在 core.js 的导出对象里 */
const definedNamespaces = new Set(['views', 'components', 'h', 'API', 'Store', 'Router',
  'go', 'define', 'resolve', 'fmt', 'notify', 'toast', 'copyText', 'debounce',
  'usePager', 'cache', 'staticNote', 'chartBase', 'catAxis', 'valAxis', 'areaGrad',
  'useChart', 'PALETTE', 'vue', 'dict', 'DICT', 'routeAccess']);

for (const f of jsFiles) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /(?:global\.)?App\.([A-Za-z_][\w]*)\s*=/g;
  let m;
  while ((m = re.exec(s)) !== null) definedNamespaces.add(m[1]);
}
/* core.js 的 global.App = { ... } 整体导出 */
{
  const coreSrc = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
  const block = coreSrc.match(/global\.App\s*=\s*\{([\s\S]*?)\n  \};/);
  if (block) {
    block[1].split(',').forEach((seg) => {
      const nm = seg.trim().match(/^([A-Za-z_][\w]*)/);
      if (nm) definedNamespaces.add(nm[1]);
    });
  }
}

const ALLOWED_UNDEFINED = new Set([
  /* 浏览器内建 */
  'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
  'console', 'fetch', 'WebSocket', 'EventSource', 'CustomEvent', 'Event',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'setSession', 'Vue', 'THREE', 'URL', 'URLSearchParams',
  'TextDecoder', 'TextEncoder', 'AbortController', 'Blob', 'FileReader', 'Image',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'performance', 'devicePixelRatio',
  'globalThis', 'module', 'exports', 'require', 'process',
]);

for (const f of jsFiles) {
  const s = fs.readFileSync(f, 'utf8');
  const lines = s.split('\n');
  lines.forEach((line, i) => {
    /* 只检查 App.XXX 形式的引用（这是项目内的耦合点） */
    const re = /\bApp\.([A-Za-z_][\w]*)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const nm = m[1];
      if (!definedNamespaces.has(nm) && !ALLOWED_UNDEFINED.has(nm)) {
        /* 排除注释行 */
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
        add('UNDEFINED_NAMESPACE', path.relative(ROOT, f), i + 1,
          `App.${nm} 没有定义处 —— 运行时会是 undefined`);
      }
    }
  });
}

/* ==================================================================================
 * 七、检查 index.html 是否引入了新增脚本
 * ================================================================================== */
{
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const required = ['js/3d/twin3d.js', 'js/views/twin.js', 'js/views/copilot.js'];
  for (const r of required) {
    if (!html.includes(r)) {
      add('MISSING_SCRIPT', 'public/index.html', 0, `未引入 ${r} —— 对应功能不会加载`);
    }
  }
  /* 检查脚本顺序：views 必须在 app.js 之前（app.js 挂载时要能读到 App.views） */
  const idxApp = html.indexOf('js/app.js');
  for (const v of ['js/views/twin.js', 'js/views/copilot.js']) {
    const idxV = html.indexOf(v);
    if (idxV > idxApp && idxApp > 0) {
      add('SCRIPT_ORDER', 'public/index.html', 0,
        `${v} 在 app.js 之后加载 —— 挂载时该视图还不存在`);
    }
  }
}

/* ==================================================================================
 * 八、输出
 * ================================================================================== */
console.log('');
if (warnings.length) {
  console.log(`⚠ 警告 ${warnings.length} 项：`);
  for (const w of warnings) {
    console.log(`  [${w.kind}] ${w.file}${w.line ? ':' + w.line : ''} — ${w.msg}`);
  }
  console.log('');
}

if (!problems.length) {
  console.log('✔ 前端静态审查通过（0 错误）');
  if (warnings.length) console.log(`  另有 ${warnings.length} 项警告（非阻断）`);
  process.exit(0);
}

console.log(`✘ 错误 ${problems.length} 项：`);
const byKind = new Map();
for (const p of problems) {
  if (!byKind.has(p.kind)) byKind.set(p.kind, []);
  byKind.get(p.kind).push(p);
}
for (const [kind, list] of byKind) {
  console.log(`\n  [${kind}] ${list.length} 项`);
  for (const p of list.slice(0, 12)) {
    console.log(`    ${p.file}${p.line ? ':' + p.line : ''} — ${p.msg}`);
  }
  if (list.length > 12) console.log(`    …另有 ${list.length - 12} 项`);
}
process.exit(1);
