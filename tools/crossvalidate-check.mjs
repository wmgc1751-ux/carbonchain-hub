/**
 * crossvalidate-check.mjs —— 真实数据交叉验证 CLI（科学性证据，可独立复跑）
 * ==================================================================================
 * 这个脚本把「平台的核算实现是否正确」从**自证**变成**他证**：
 * 用 Climate TRACE 独立观测的三元组 (E, A, EF) 检验恒等式 E = A × EF。
 *
 * 三个量来自不同观测链，因此这个等式是一条可被数据本身证伪的约束。
 * 它检验的是量纲与口径，不是精度 —— 把 tCO2e/MWh 当 tCO2e/GWh 会差 1000 倍，
 * 这类错误在合成数据上永远不会暴露。
 *
 * 用法：
 *   node tools/crossvalidate-check.mjs                # 默认年度，全部三项检查
 *   node tools/crossvalidate-check.mjs --year 2024
 *   node tools/crossvalidate-check.mjs --json         # 机读输出
 *
 * 退出码：0 全部通过；1 存在失败项。
 *
 * @module tools/crossvalidate-check
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const cv = require(path.join(ROOT, 'server/services/crossValidate'));
const db = require(path.join(ROOT, 'server/db'));

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const JSON_OUT = argv.includes('--json');
const YEAR = Number(argOf('year', 0)) || undefined;

const results = [];
let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  results.push({ name, pass: !!ok, detail: detail || '' });
  if (ok) pass++; else fail++;
  if (!JSON_OUT) console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('='.repeat(80));
console.log('  真实数据交叉验证 · 核算内核 vs 外部独立观测');
console.log('='.repeat(80));

/* ------------------------------------------------------------------ */
/* 一、恒等式 E = A × EF                                              */
/* ------------------------------------------------------------------ */
console.log('\n【一】恒等式检验：平台按 A×EF 重算，与源数据独立观测的 E 比较');

const idt = await cv.identityCheck({ year: YEAR });
console.log(`  年度 ${idt.year} · 可检验 ${idt.verifiable.toLocaleString()} 家`
  + `（共 ${idt.examined.toLocaleString()} 家，其中 ${idt.unverifiable} 家源数据缺 A 或 EF）`);
for (const b of idt.bands) {
  console.log(`     ${b.label.padEnd(24)} ${String(b.count).padStart(6)} 家`
    + `  ${b.sharePct == null ? '—' : b.sharePct.toFixed(3) + '%'}`);
}

check('存在可检验的真实设施', idt.verifiable > 0, `${idt.verifiable} 家`);
/* 判据：精确自洽（≤0.5%）占比必须 > 95%。
 * 为什么是 95% 而不是 100%：源数据的 A 与 E 各自独立四舍五入到有限位数，
 * 极端小量级的记录（如 0.00164 头牲畜）相对偏差会被放大。
 * 要求 100% 会让这条判据变成"永远红"，而常红判据会被训练成忽略警报。 */
const exactBand = idt.bands.find((b) => b.key === 'EXACT');
check('精确自洽（≤0.5%）占比 > 95%', exactBand && exactBand.sharePct > 95,
  exactBand ? `${exactBand.sharePct}%` : '无数据');
/* 判据：不得出现量纲级错误（偏差 > 100%）。
 * 这是最硬的判据：偏差 100 倍意味着单位搞错了，不是精度问题。 */
const unitBand = idt.bands.find((b) => b.key === 'UNIT');
check('无量纲级错误（偏差 > 100%）', unitBand && unitBand.count === 0,
  unitBand ? `${unitBand.count} 例` : '无数据');

/* ------------------------------------------------------------------ */
/* 二、因子年度稳定性                                                  */
/* ------------------------------------------------------------------ */
console.log('\n【二】排放因子年度稳定性（因子是技术属性，短期不应剧烈变化）');

const stab = await cv.factorStability({});
console.log(`  有因子记录 ${stab.facilitiesWithFactor.toLocaleString()} 家 · `
  + `相邻年度对比 ${stab.adjacentPairs.toLocaleString()} 对 · `
  + `跳变 >20% 共 ${stab.jumpCount} 例（${stab.jumpRatePct}%）`);

check('存在因子记录', stab.facilitiesWithFactor > 0, `${stab.facilitiesWithFactor} 家`);
/* 判据：跳变率 < 10%。超过 10% 说明数据源或我们的解析有系统性问题，
 * 而不是个别设施的技术改造。 */
check('因子跳变率 < 10%', stab.jumpRatePct != null && stab.jumpRatePct < 10,
  stab.jumpRatePct == null ? '无法计算' : `${stab.jumpRatePct}%`);

/* ------------------------------------------------------------------ */
/* 三、与官方因子对照                                                  */
/* ------------------------------------------------------------------ */
console.log('\n【三】第三方观测因子 vs 官方公布区域电网因子（量级相容性）');

const bm = await cv.factorBenchmark({ year: YEAR });
console.log(`  年度 ${bm.year} · 电力行业按区域聚合`);
for (const r of bm.regionRows) {
  console.log(`     ${String(r.region).padEnd(6)} n=${String(r.facilities).padStart(5)}`
    + `  观测均值=${r.observedFactorMean == null ? '—' : r.observedFactorMean}`
    + `  官方=${r.officialGridFactor == null ? '—' : r.officialGridFactor}`
    + `  比值=${r.ratio == null ? '—' : r.ratio}`);
}

/* 判据：所有可计算的比值都必须落在 0.1~10 之间。
 * 落在区间外几乎一定是单位或口径错误；区间内则可解释为
 * 发电侧/用电侧、含不含工业过程等边界差异。 */
const ratios = bm.regionRows.map((r) => r.ratio).filter((r) => r != null);
const outOfRange = ratios.filter((r) => r < 0.1 || r > 10);
check('所有区域比值在物理相容区间（0.1~10）', ratios.length > 0 && outOfRange.length === 0,
  ratios.length === 0 ? '无可比区域' : `${ratios.length} 个区域，越界 ${outOfRange.length} 个`);

/* ------------------------------------------------------------------ */
/* 结论                                                               */
/* ------------------------------------------------------------------ */
const summary = {
  year: idt.year,
  identity: {
    verifiable: idt.verifiable,
    meanAbsDeviation: idt.meanAbsDeviation,
    exactSharePct: exactBand ? exactBand.sharePct : null,
    unitErrors: unitBand ? unitBand.count : null,
  },
  stability: {
    facilities: stab.facilitiesWithFactor,
    pairs: stab.adjacentPairs,
    jumpRatePct: stab.jumpRatePct,
  },
  benchmark: { ratios, outOfRange: outOfRange.length },
  pass, fail,
  verdict: fail === 0 ? 'PASS' : 'FAIL',
  generatedAt: new Date().toISOString(),
};

console.log('\n' + '='.repeat(80));
console.log(`  结果：${pass} 通过 / ${fail} 失败`);
console.log(`  结论：${fail === 0
  ? '核算实现的量纲与口径与外部真实观测一致，未发现系统性错误。'
  : '存在失败项：核算实现与真实数据的物理含义存在不一致，需排查。'}`);
console.log('='.repeat(80));

if (JSON_OUT) console.log(JSON.stringify({ summary, results }, null, 2));

try {
  const fs = require('node:fs');
  const outDir = path.join(ROOT, 'tools', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'crossvalidate-check.json'),
    JSON.stringify({ summary, results }, null, 2), 'utf8');
} catch (e) {
  console.warn('⚠ 未能写出结果文件：', e.message);
}

process.exit(fail === 0 ? 0 : 1);
