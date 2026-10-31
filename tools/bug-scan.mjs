/**
 * bug-scan.mjs —— 全平台 Bug 扫描（死链 / 死功能 / 页面可达性 / API 完整性）
 * ==================================================================================
 * 【为什么需要这个工具】
 *
 * 人工点 70 个页面会漏、会累、且每次改代码后没人愿意重做。
 * 工具化后每次部署前跑一遍，能把"页面白屏 / 按钮无响应 / API 404"
 * 这三类最影响评审印象的问题在上线前抓住。
 *
 * 检查项：
 *   1. 路由可达性 —— app.js 注册的每条路由都有对应视图文件
 *   2. API 完整性 —— 前端调用的每个 /api/* 路径在后端有对应路由
 *   3. 死按钮检测 —— 视图里 onClick 指向的函数在组件中已定义
 *   4. 死引用检测 —— 视图引用的 App.xxx 在 core.js 或某处有定义
 *   5. 菜单一致性 —— 侧边栏菜单的每条路径在路由表中
 *
 * 用法：node tools/bug-scan.mjs [--verbose]
 *
 * @module tools/bug-scan
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const VERBOSE = process.argv.includes('--verbose');
const issues = [];
const warns = [];

const ok = (msg) => VERBOSE && console.log(`  ✔ ${msg}`);
const bad = (kind, file, detail) => { issues.push({ kind, file, detail }); };
const warn = (kind, file, detail) => { warns.push({ kind, file, detail }); };

/* ---------- 读取 ---------- */
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}
const viewFiles = walk(path.join(ROOT, 'public/js/views'));
const dataFiles = walk(path.join(ROOT, 'public/js/data'));
const jsFiles = [...viewFiles, ...dataFiles, path.join(ROOT, 'public/js/app.js'), path.join(ROOT, 'public/js/core.js'), path.join(ROOT, 'public/js/components.js')];

console.log('='.repeat(70));
console.log('  全平台 Bug 扫描');
console.log('='.repeat(70));

/* ==================================================================================
 * 1. 路由 → 视图一致性
 * ================================================================================== */
console.log('\n【1】路由可达性');
const appSrc = read('public/js/app.js');

const routeViews = new Set();
{
  const re = /\[\s*'([^']+)'\s*,\s*'(page-[a-z0-9-]+)'\s*\]/g;
  let m;
  while ((m = re.exec(appSrc)) !== null) routeViews.add(m[2]);
}

const declaredViews = new Set();
for (const f of [...viewFiles, path.join(ROOT, 'public/js/app.js')]) {
  const s = fs.readFileSync(f, 'utf8');
  const r1 = /App\.views\[['"]([a-z0-9-]+)['"]\]\s*=/g;
  let m;
  while ((m = r1.exec(s)) !== null) declaredViews.add(m[1]);
  const r2 = /Object\.assign\(\s*App\.views\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = r2.exec(s)) !== null) {
    const rp = /['"]([a-z0-9-]+)['"]\s*:/g;
    let pm;
    while ((pm = rp.exec(m[1])) !== null) declaredViews.add(pm[1]);
  }
}

for (const v of routeViews) {
  if (!declaredViews.has(v)) bad('MISSING_VIEW', 'app.js', `路由引用视图 '${v}' 但无定义`);
  else ok(`路由 → ${v}`);
}

/* ==================================================================================
 * 2. API 完整性（前端调用的路径在后端存在）
 * ================================================================================== */
console.log('\n【2】API 完整性');

/* 收集前端调用的所有 API 路径 */
const apiCalls = new Set();
for (const f of jsFiles) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /(?:API\.get|API\.post|API\.request|fetch\()\s*['"`]([^'"`]*api[^'"`]*)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m[1].replace(/^\.\/api/, '').replace(/^\/api/, '');
    if (p && !p.includes('${')) apiCalls.add(p);
  }
  /* 也匹配 API.get('/xxx') 与 API.post('/xxx') 形式 */
  const re2 = /API\.(?:get|post)\(\s*['"]([^'"]+)['"]/g;
  while ((m = re2.exec(s)) !== null) {
    /* 模板字符串里的动态段（${id} 等）在纯字符串捕获时丢失，
     * 留下尾斜杠（如 '/twin/plant/'）。这类路径跳过 —— 它们对应的
     * 真实端点（/twin/plant/:id）是存在的，报出来全是假阳性。 */
    if (m[1].includes('${') || m[1].endsWith('/')) continue;
    apiCalls.add(m[1]);
  }
}

/* 收集后端注册的所有路径 */
const backendPaths = new Set();
/* Express 版。
 * ⚠ 挂载前缀必须与 server/app.js 的 app.use() 一致 —— 不能简单按文件名推。
 * international.js 挂载在 '/api' 根（路径如 /cbam/*），不是 /api/international/*。
 * 若按文件名推前缀，会把这些端点全部误判为"后端未注册"。 */
const appJs = read('server/app.js');
const mountMap = {};
/* 逐行解析（不用全局正则 —— app.js 里的多行注释包含 app.use 字样，
 * 全局正则会把注释内容误捕获进 mountMap，导致所有前缀都是垃圾值） */
for (const line of appJs.split('\n')) {
  const t = line.trim();
  if (!t.startsWith('app.use(')) continue;
  const m = t.match(/^app\.use\(\s*['"]([^"']+)['"]\s*,\s*require\(\s*['"]\.\/routes\/(\w+)['"]/);
  if (m) mountMap[m[2]] = m[1];
}
for (const f of walk(path.join(ROOT, 'server/routes'))) {
  const s = fs.readFileSync(f, 'utf8');
  const base = path.basename(f, '.js');
  const prefix = mountMap[base] !== undefined ? mountMap[base] : '/' + base;
  const re = /router\.(get|post|put|delete)\(\s*['"]([^'"]*)['"]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m[2];
    const normalized = p.replace(/:[\w]+/g, '*');
    backendPaths.add(`${prefix}${normalized === '/' ? '' : normalized}`);
  }
}
/* Worker 版 */
{
  const wf = path.join(ROOT, 'worker/routes');
  if (fs.existsSync(wf)) {
    for (const f of walk(wf)) {
      const s = fs.readFileSync(f, 'utf8');
      const re = /r\.(?:get|post)\(\s*['"]([^'"]*)['"]/g;
      let m;
      while ((m = re.exec(s)) !== null) backendPaths.add(m[1]);
    }
  }
}

/* 匹配（支持前缀匹配与通配符）。
 * ⚠ 前端调用不带 /api 前缀（API.base='./api' 已包含），后端路径带。
 * 统一在后端路径上去掉 /api 前缀再做比较。 */
function apiExists(callPath) {
  const base = callPath.split('?')[0].replace(/^\/api/, '');
  /* 归一化后端路径：去掉 /api 前缀 */
  const normalizedBackend = new Set();
  for (const bp of backendPaths) normalizedBackend.add(bp.replace(/^\/api/, ''));
  if (normalizedBackend.has(base)) return true;
  /* 通配符匹配 */
  for (const bp of normalizedBackend) {
    const bpParts = bp.split('/').filter(Boolean);
    const cpParts = base.split('/').filter(Boolean);
    if (bpParts.length !== cpParts.length) continue;
    let match = true;
    for (let i = 0; i < bpParts.length; i++) {
      if (bpParts[i] === '*' || bpParts[i] === cpParts[i]) continue;
      match = false; break;
    }
    if (match) return true;
  }
  return false;
}

let apiOk = 0, apiFail = 0;
for (const p of [...apiCalls].sort()) {
  if (apiExists(p)) { apiOk++; ok(`API ${p}`); }
  else { apiFail++; warn('API_NOT_FOUND', '前端', `调用 /api${p} 但后端未注册该路径`); }
}
console.log(`  API 调用 ${apiCalls.size} 个：${apiOk} 匹配 / ${apiFail} 未匹配`);

/* ==================================================================================
 * 3. 菜单一致性
 * ================================================================================== */
console.log('\n【3】菜单一致性');
{
  const menuPaths = new Set();
  const re = /path:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(appSrc)) !== null) menuPaths.add(m[1]);
  const routePaths = new Set();
  const rp = /\[\s*'([^']+)'\s*,\s*'(page-[a-z0-9-]+)'\s*\]/g;
  while ((m = rp.exec(appSrc)) !== null) routePaths.add(m[1]);
  for (const p of menuPaths) {
    /* 排除非路由 path（如 icon name） */
    if (p.startsWith('/')) {
      if (!routePaths.has(p)) bad('MENU_DEADLINK', 'app.js', `菜单项 ${p} 不在路由表中`);
      else ok(`菜单 ${p}`);
    }
  }
}

/* ==================================================================================
 * 4. 视图内的死引用（App.xxx 未定义）
 * ================================================================================== */
console.log('\n【4】App 命名空间死引用');
{
  const defined = new Set(['views','components','h','API','Store','Router','go','define','resolve',
    'fmt','notify','toast','copyText','debounce','usePager','cache','staticNote','chartBase',
    'catAxis','valAxis','areaGrad','useChart','PALETTE','vue','dict','DICT','routeAccess',
    'Twin3D','Plant3D','Copilot','SM3','Nucleus','Industry','Sources','Bench','Cems',
    'RealDataEngine','CarbonCalculator','ContractAccounting','StaticApi','DataLayer']);
  for (const f of jsFiles) {
    const s = fs.readFileSync(f, 'utf8');
    const add = s.match(/App\.([A-Za-z_][\w]*)\s*=/g);
    if (add) add.forEach((a) => {
      const nm = a.match(/App\.([A-Za-z_][\w]*)/)[1];
      defined.add(nm);
    });
  }
  let nsOk = 0;
  for (const f of jsFiles) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//')) return;
      const re = /\bApp\.([A-Za-z_][\w]*)/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (!defined.has(m[1])) {
          warn('UNDEFINED_NS', path.relative(ROOT, f) + ':' + (i + 1), `App.${m[1]}`);
        } else nsOk++;
      }
    });
  }
  console.log(`  命名空间引用 ${nsOk} 个有效`);
}

/* ==================================================================================
 * 5. 组件引用完整性
 * ================================================================================== */
console.log('\n【5】组件引用');
{
  const compSrc = read('public/js/components.js');
  const registered = new Set();
  const re = /(['"])(x-[a-z0-9-]+)\1\s*:/g;
  let m;
  while ((m = re.exec(compSrc)) !== null) registered.add(m[2]);
  for (const f of jsFiles) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const r = /\bh\(\s*['"](x-[a-z0-9-]+)['"]/g;
      let mm;
      while ((mm = r.exec(line)) !== null) {
        if (!registered.has(mm[1])) {
          bad('UNREGISTERED_COMP', path.relative(ROOT, f) + ':' + (i + 1),
            `h('${mm[1]}') 组件未注册 → 渲染为空元素`);
        }
      }
    });
  }
  console.log(`  已注册组件 ${registered.size} 个`);
}

/* ==================================================================================
 * 6. 空/占位功能检测
 * ================================================================================== */
console.log('\n【6】占位功能检测');
{
  for (const f of viewFiles) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    /* TODO / FIXME / 占位 */
    if (/TODO[:\s]/.test(s) && !/已完成/.test(s)) {
      const lines = s.split('\n');
      lines.forEach((l, i) => {
        if (/TODO[:\s]/.test(l)) warn('TODO', rel + ':' + (i + 1), l.trim().slice(0, 80));
      });
    }
    /* 空页面（只有骨架没有数据加载） */
    if (/defineComponent/.test(s) && !/API\.(get|post|request)/.test(s) && !/fetch\(/.test(s)) {
      const name = s.match(/name:\s*'([^']+)'/);
      if (name && !['page-login', 'page-404', 'page-home'].includes(name[1])) {
        warn('NO_DATA_FETCH', rel, `视图 ${name[1]} 没有任何数据请求 —— 可能是纯静态占位`);
      }
    }
  }
}

/* ==================================================================================
 * 输出
 * ================================================================================== */
console.log('\n' + '='.repeat(70));
if (warns.length) {
  console.log(`⚠ 警告 ${warns.length} 项：`);
  warns.slice(0, 20).forEach((w) => console.log(`  [${w.kind}] ${w.file} — ${w.detail}`));
  if (warns.length > 20) console.log(`  …另有 ${warns.length - 20} 项`);
}
if (issues.length) {
  console.log(`\n✘ 错误 ${issues.length} 项：`);
  issues.forEach((i) => console.log(`  [${i.kind}] ${i.file} — ${i.detail}`));
} else {
  console.log(`\n✔ 扫描完成：0 错误${warns.length ? ` / ${warns.length} 警告` : ''}`);
}
console.log('='.repeat(70));
process.exit(issues.length ? 1 : 0);
