/* scripts/health-check.js —— 全项目数据真实性 + 全面性体检（零依赖） */
'use strict';
const fs = require('fs');
global.window = globalThis;  // 兜底：让浏览器专属数据文件在 Node 下可 require

const issues = [];
const ok = [];

/* 1. sources.js 因子台账 */
const S = require('../public/js/data/sources.js');
const pf = S.powerFactors;
if (pf) {
  ok.push('sources.powerFactors 存在，含 national/powerCo2/footprint/gridBaseline');
  if (pf.national && Math.abs(pf.national.value - 0.5703) < 0.0001) ok.push('全国电网平均因子 0.5703 ✓');
  else issues.push('FAIL 全国电网平均因子值不对：' + (pf.national && pf.national.value));
  if (pf.footprint && Math.abs(pf.footprint.value - 0.6205) < 0.0001) ok.push('电力碳足迹因子 0.6205 ✓');
  else issues.push('FAIL 电力碳足迹因子值不对：' + (pf.footprint && pf.footprint.value));
  if (pf.powerCo2 && Math.abs(pf.powerCo2.value - 0.5568) < 0.0001) ok.push('2021 年电力因子 0.5568 ✓');
  else issues.push('FAIL 2021 年电力因子值不对');
} else issues.push('FAIL sources.powerFactors 不存在');

if (S.fuelFactors) {
  let pass = 0, fail = 0;
  S.fuelFactors.forEach((f) => {
    // EF = NCV × CC × OF × 44/12，结果 tCO₂/单位；官方公布值 kgCO₂/单位 → ×1000
    const computed = f.ncv * f.cc * f.of * (44 / 12) * 1000;
    const dev = Math.abs(computed - f.ef) / f.ef * 100;
    if (f.traceLevel === 'C') return;  // 蒸汽为示例值，跳过
    if (dev < 0.5) pass++; else { fail++; issues.push('FAIL 燃料 ' + f.cn + ' 复算偏差 ' + dev.toFixed(3) + '%'); }
  });
  ok.push('IPCC 燃料因子复算：' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (S.fuelFactors.length - 1) + ' 种，蒸汽示例值跳过）');
}
if (S.citations) ok.push('引用来源 ' + S.citations.length + ' 条');
else issues.push('FAIL sources.citations 不存在');

/* 2. industry.js */
const I = require('../public/js/data/industry.js');
if (I.buildDevices) {
  const devs = I.buildDevices();
  ok.push('industry 设备：' + devs.length + ' 台');
  if (devs.length < 12) issues.push('FAIL 设备数 < 12');
  let didOk = 0;
  devs.forEach((d) => { if (d.did && d.did.startsWith('did:')) didOk++; });
  ok.push('DID 格式合规：' + didOk + '/' + devs.length);
  const protos = new Set(devs.map((d) => d.protocol).filter(Boolean));
  ok.push('通信协议：' + Array.from(protos).join(' / '));
  const cemsDevs = devs.filter((d) => d.did && d.did.includes('cems'));
  ok.push('CEMS 设备：' + cemsDevs.length + ' 台');
}
if (I.buildBatches) {
  const batches = I.buildBatches();
  ok.push('industry 批次：' + batches.length + ' 个');
}

/* 3. 无 Math.random 检查（排除注释行，跟踪块注释状态） */
function codeHasMathRandom(src) {
  let inBlock = false;
  return src.split('\n').some((line) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return false;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return false;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
    return /Math\.random\(\)/.test(line);
  });
}
const cemsSrc = fs.readFileSync('./public/js/data/cems.js', 'utf8');
if (codeHasMathRandom(cemsSrc)) issues.push('FAIL cems.js 代码行仍含 Math.random()');
else ok.push('cems.js 代码行已无 Math.random() ✓');
const rdeSrc = fs.readFileSync('./public/js/data/realDataEngine.js', 'utf8');
if (codeHasMathRandom(rdeSrc)) issues.push('FAIL realDataEngine.js 代码行含 Math.random()');
else ok.push('realDataEngine.js 代码行已无 Math.random() ✓');

const RDE = require('../public/js/data/realDataEngine.js');
if (RDE.ARCHIVE_CEMS_60 && RDE.ARCHIVE_CEMS_60.length === 60) ok.push('归档序列 60 帧 ✓');
else issues.push('FAIL 归档序列帧数不对');

/* 4. nucleus.js */
const N = require('../public/js/data/nucleus.js');
if (N.monteCarlo && N.enterpriseReconcile && N.leagueReconcile) ok.push('nucleus 核算函数齐全 ✓');
else issues.push('FAIL nucleus 核算函数缺失');

/* 5. SM3 官方向量 */
const SM3 = require('../public/js/data/sm3.js');
const v = SM3.sm3('abc');
if (v === '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0') ok.push('SM3 官方向量 ✓');
else issues.push('FAIL SM3 abc 向量不对：' + v);

/* 6. carbonCalculator 三口径 */
const Calc = require('../public/js/data/carbonCalculator.js');
ok.push('因子三档：' + Calc.FACTOR_PRESETS.map((f) => f.key + '=' + f.getValue()).join(' / '));

/* 7. view + route 完整性 */
const views = ['login', 'screen', 'explorer', 'verify', 'cems', 'consortium', 'dynamic', 'credit', 'enterprise', 'verifier', 'regulator', 'ops'];
const vMissing = views.filter((vv) => !fs.existsSync('./public/js/views/' + vv + '.js'));
if (vMissing.length) issues.push('FAIL view 缺失：' + vMissing.join(','));
else ok.push('view ' + views.length + ' 个齐全 ✓');
const routes = ['auth', 'enterprise', 'verifier', 'regulator', 'chain', 'consortium', 'dynamic', 'credit', 'public', 'telemetry', 'ops'];
const rMissing = routes.filter((r) => !fs.existsSync('./server/routes/' + r + '.js'));
if (rMissing.length) issues.push('FAIL route 缺失：' + rMissing.join(','));
else ok.push('route ' + routes.length + ' 个齐全 ✓');

/* 8. index.html 脚本引用 */
const html = fs.readFileSync('./public/index.html', 'utf8');
const exp = ['vue.global.prod.js', 'echarts.min.js', 'core.js', 'components.js', 'sources.js', 'nucleus.js', 'sm3.js', 'realDataEngine.js', 'carbonCalculator.js', 'cems.js', 'bench.js', 'industry.js'];
const m = exp.filter((s) => !html.includes(s));
if (m.length) issues.push('FAIL index.html 缺脚本：' + m.join(','));
else ok.push('index.html 脚本引用完整 ✓');

/* 9. 数据文件 Node 兼容性（window 兜底） */
const dataFiles = ['sources.js', 'nucleus.js', 'sm3.js', 'realDataEngine.js', 'carbonCalculator.js', 'cems.js', 'industry.js', 'bench.js'];
dataFiles.forEach((f) => {
  const src = fs.readFileSync('./public/js/data/' + f, 'utf8');
  if (/\}\)\(window\)/.test(src)) issues.push('WARN ' + f + ' 用 })(window) 无法在 Node 下 require（建议改 })(typeof window!==undefined?window:globalThis)）');
});

/* 10. 服务端中间件完整性 */
const mws = ['auth.js', 'rate-limit.js', 'monitor.js', 'structured-log.js', 'canary.js'];
const mwMissing = mws.filter((mw) => !fs.existsSync('./server/middleware/' + mw));
if (mwMissing.length) issues.push('FAIL middleware 缺失：' + mwMissing.join(','));
else ok.push('middleware ' + mws.length + ' 个齐全 ✓');

/* 11. db schema 完整性 */
const schema = fs.existsSync('./db/01_schema.sql') ? fs.readFileSync('./db/01_schema.sql', 'utf8') : '';
if (schema) {
  const tables = (schema.match(/CREATE TABLE[^;]+/g) || []).length;
  ok.push('db schema 含 ' + tables + ' 张表');
  if (tables < 20) issues.push('FAIL schema 表数 < 20');
}

/* 12. package.json 依赖完整性 */
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const deps = Object.keys(pkg.dependencies || {});
ok.push('dependencies：' + deps.join(' / '));
if (!deps.includes('ws')) issues.push('FAIL 缺 ws 依赖');
if (!deps.includes('express')) issues.push('FAIL 缺 express 依赖');

/* 输出 */
console.log('=== 检测通过项 (' + ok.length + ') ===');
ok.forEach((m) => console.log('  OK  ' + m));
console.log('');
console.log('=== 待完善项 (' + issues.length + ') ===');
if (issues.length === 0) console.log('  无');
else issues.forEach((m) => console.log('  ' + m));
console.log('');
console.log('总计：' + ok.length + ' 通过 / ' + issues.length + ' 待完善');
process.exit(issues.length > 0 ? 1 : 0);
