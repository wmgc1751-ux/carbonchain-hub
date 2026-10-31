/**
 * import-real-data.mjs —— 真实数据层统一导入（可复现、可离线重放）
 * ==================================================================================
 * 平台有三种真实数据源，导入方式、依赖、耗时完全不同，因此**不能混在一个命令里**：
 *
 *   climate_trace  中国设施级排放，6 个年度 × 5 万家 = 30 万行
 *                  依赖外网（首次 ~40 分钟），有缓存后离线重放 ~6 秒
 *   epa_ghgrp      美国设施级排放，9 个年度 = 3.85 万行
 *                  依赖本地 xlsx 文件，无需外网
 *   worldbank/owid 国家级宏观序列
 *                  依赖外网，年度数据，秒级
 *
 * 【为什么必须支持"离线重放"】
 * 评审、第三方复核、期末打包都可能在没有外网的机器上重跑。如果导入必须联网，
 * 那"可复现"就变成了"在有网的时候可复现"，这不是可复现。
 * 因此本脚本的策略是：
 *   · 缓存存在（.cache/realdata/climatetrace/assets-YYYY-OFFSET.json）→ 直接重放
 *   · 缓存缺失 → 联网抓取并写缓存
 *   · --offline 时缓存缺失即报错，绝不静默跳过（跳过会让"数据不全"看起来像"数据正常"）
 *
 * 用法：
 *   node tools/import-real-data.mjs                 # 全部源，能缓存就缓存
 *   node tools/import-real-data.mjs --only climate_trace
 *   node tools/import-real-data.mjs --years 2024,2025
 *   node tools/import-real-data.mjs --offline       # 只允许用缓存
 *   node tools/import-real-data.mjs --check         # 只报告当前库内状态，不导入
 *
 * @module tools/import-real-data
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const db = require(path.join(ROOT, 'server/db'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const ONLY = (argOf('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const YEARS = (argOf('years', '') || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const OFFLINE = has('offline');
const CHECK = has('check');
const FORCE = has('force');
const MAX = Number(argOf('max', 0)) || undefined;

const want = (key) => ONLY.length === 0 || ONLY.includes(key);

/* ==================================================================================
 * 一、状态检查
 * ================================================================================== */
async function reportState() {
  console.log('─'.repeat(78));
  console.log('  真实数据层现状');
  console.log('─'.repeat(78));

  const bySrc = await db.query(
    `SELECT f.country_iso iso, ds.source_key src,
            COUNT(DISTINCT f.id) facilities,
            COUNT(e.id) rows_n,
            MIN(e.year) y0, MAX(e.year) y1,
            SUM(e.total_co2e) total
       FROM real_facility f
       JOIN data_source ds ON ds.id = f.source_id
       LEFT JOIN real_emission_year e ON e.facility_id = f.id
      GROUP BY f.country_iso, ds.source_key`
  );
  if (!bySrc.length) {
    console.log('  （空）真实设施台账尚无数据');
  } else {
    for (const r of bySrc) {
      console.log(`  ${String(r.src).padEnd(16)} ${String(r.iso)}  `
        + `设施 ${Number(r.facilities).toLocaleString().padStart(7)}  `
        + `年度记录 ${Number(r.rows_n).toLocaleString().padStart(8)}  `
        + `年度 ${r.y0}–${r.y1}  `
        + `合计 ${(Number(r.total) / 1e6).toFixed(0)} Mt`);
    }
  }

  const macro = await db.query(
    'SELECT country_iso iso, COUNT(*) n, COUNT(DISTINCT indicator) inds FROM macro_indicator GROUP BY country_iso'
  );
  console.log(`  宏观序列          ${macro.map((m) => `${m.iso}:${m.n}行/${m.inds}指标`).join('  ') || '（空）'}`);

  /* 按年度列出中国设施数，并标注完整性 —— 与 /api/real/overview 同一判据 */
  const chnYears = await db.query(
    `SELECT e.year, COUNT(*) n FROM real_emission_year e
       JOIN real_facility f ON f.id = e.facility_id
      WHERE f.country_iso = 'CHN' GROUP BY e.year ORDER BY e.year`
  );
  if (chnYears.length) {
    const counts = chnYears.map((r) => Number(r.n)).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)];
    const currentYear = new Date().getFullYear();
    console.log('\n  中国设施按年度：');
    for (const r of chnYears) {
      const n = Number(r.n);
      const coverageOk = n >= median * 0.6;
      const yearOver = Number(r.year) < currentYear;
      const flag = coverageOk && yearOver ? '✔ 完整' : (yearOver ? '✘ 抓取不全' : '◐ 进行中');
      console.log(`    ${r.year}  ${n.toLocaleString().padStart(7)} 家   ${flag}`);
    }
  }

  const srcRows = await db.query(
    `SELECT source_key, last_status, last_fetched_at, record_count
       FROM data_source ORDER BY source_key`
  );
  console.log('\n  数据源登记：');
  for (const s of srcRows) {
    console.log(`    ${String(s.source_key).padEnd(16)} ${String(s.last_status || '-').padEnd(6)} `
      + `记录 ${String(s.record_count == null ? '-' : Number(s.record_count).toLocaleString()).padStart(9)}  `
      + `最近同步 ${s.last_fetched_at ? new Date(s.last_fetched_at).toISOString().slice(0, 19).replace('T', ' ') : '从未'}`);
  }
  console.log('─'.repeat(78));
}

if (CHECK) {
  await reportState();
  process.exit(0);
}

/* ==================================================================================
 * 二、Climate TRACE（中国设施级）
 * ================================================================================== */
async function importClimateTrace() {
  console.log('\n【1/3】Climate TRACE —— 中国设施级排放');
  const T = require(path.join(ROOT, 'server/services/ingestClimateTrace'));

  /* 离线模式先确认缓存是否覆盖请求的年度，缺就报错而不是静默跳过。
   * 静默跳过会让"这一年度数据不全"看起来像"这一年度本来就这样"。 */
  if (OFFLINE) {
    const fs = require('node:fs');
    const dir = path.join(ROOT, '.cache', 'realdata', 'climatetrace');
    const years = YEARS.length ? YEARS : [2021, 2022, 2023, 2024, 2025, 2026];
    const missing = years.filter((y) => !fs.existsSync(path.join(dir, `assets-${y}-0.json`)));
    if (missing.length) {
      console.error(`✘ --offline 但缓存缺失年度：${missing.join(', ')}`);
      console.error('  请在有网环境先跑一次不带 --offline 的导入，或调整 --years。');
      throw new Error('缓存不完整');
    }
  }

  const st = await T.ingest({
    years: YEARS.length ? YEARS : undefined,
    maxAssets: MAX,
    force: FORCE,
  });
  console.log(`  ✔ 设施 ${st.facilities.toLocaleString()} 家 · 年度记录 ${st.emissionRows.toLocaleString()} 条`
    + ` · 用时 ${(st.elapsedMs / 1000).toFixed(1)} s`);
  for (const [y, v] of Object.entries(st.byYear)) {
    console.log(`    ${y}: ${Number(v.assets).toLocaleString()} 条 · ${(Number(v.tonnes) / 1e6).toFixed(0)} Mt`);
  }
  return st;
}

/* ==================================================================================
 * 三、EPA GHGRP（美国设施级，本地文件）
 * ================================================================================== */
async function importEpa() {
  console.log('\n【2/3】US EPA GHGRP —— 美国设施级排放（本地文件重放）');
  const IR = require(path.join(ROOT, 'server/services/ingestReal'));
  const files = IR.listEpaJson();
  if (!files.length) {
    console.log('  ⊘ 跳过：未找到本地 EPA JSON（tools/out/epa-ghgrp-*.json）');
    console.log('    生成方式：python tools/import_epa_ghgrp.py --year 2018');
    return null;
  }
  const st = await IR.ingestEpaFacilities({ years: YEARS.length ? YEARS : undefined });
  console.log(`  ✔ 设施 ${st.facilities.toLocaleString()} 家 · 记录 ${st.emissionRows.toLocaleString()} 条`
    + ` · ${st.years.join(',')}`);
  return st;
}

/* ==================================================================================
 * 四、World Bank / OWID（宏观）
 * ================================================================================== */
async function importMacro() {
  console.log('\n【3/3】World Bank / OWID —— 国家级宏观序列');
  if (OFFLINE) {
    console.log('  ⊘ 跳过：--offline 模式不发起外网请求（宏观序列年度更新，缓存策略不同）');
    return null;
  }
  const IR = require(path.join(ROOT, 'server/services/ingestReal'));
  try {
    const st = await IR.ingestMacro({ iso: 'CHN' });
    console.log(`  ✔ 指标 ${st.indicators ? st.indicators.length : '?'} 项 · 状态 ${st.status || 'OK'}`);
    return st;
  } catch (e) {
    /* 宏观源是外网服务，失败不应让整个导入失败 —— 但它也不是"成功"。
     * 明确标 FAIL 并保留已有数据，比"假装成功"诚实。 */
    console.log(`  ✘ 宏观导入失败：${e.message.slice(0, 120)}`);
    console.log('    已有宏观数据保持不变；/api/real/sources 会显示该源最近一次失败时间。');
    return null;
  }
}

/* ==================================================================================
 * 主流程
 * ================================================================================== */
const t0 = Date.now();
let failed = false;

try {
  if (want('climate_trace')) await importClimateTrace();
  else console.log('\n【1/3】Climate TRACE —— 跳过（--only 未选中）');

  if (want('epa_ghgrp')) await importEpa();
  else console.log('\n【2/3】EPA GHGRP —— 跳过（--only 未选中）');

  if (want('macro')) await importMacro();
  else console.log('\n【3/3】World Bank / OWID —— 跳过（--only 未选中）');
} catch (e) {
  failed = true;
  console.error('\n✘ 导入中断：', e.message);
}

console.log(`\n总用时 ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await reportState();

if (failed) process.exit(1);
process.exit(0);
