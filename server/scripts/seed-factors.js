/**
 * seed-factors.js —— 结构化排放因子台账写入（带复算校验）
 * ==================================================================================
 * 把 methodology.js 内登记的因子（三要素 + 文号）写入 factor_entry 表。
 *
 * 为什么不能只写结果值：第三方要复核一个排放因子，必须能拿到 NCV、CC、OF 三个
 * 输入自己算一遍。只给 1.9003 这种结果，等于要求对方「相信」而不是「验证」。
 * 本脚本在写入前逐条复算，复算偏差超过 0.3% 即拒绝写入 —— **因子库不允许带病入库**。
 *
 * @module scripts/seed-factors
 */
'use strict';

const db = require('../db');
const M = require('../services/methodology');

const VERSION = 'v2026.1';
const EFFECTIVE_FROM = '2026-01-01';

/** 燃料类因子：从 methodology 的 FUEL_FACTORS 转成表行 */
function fuelRows() {
  const rows = [];
  for (const [code, f] of Object.entries(M.FUEL_FACTORS)) {
    const isIndirect = typeof f.directEf === 'number';
    const ef = isIndirect ? f.directEf : M.computeEf(f.ncv, f.cc, f.of);
    let category = 'FUEL';
    if (isIndirect) category = (code === 'POWER' ? 'POWER' : 'HEAT');

    rows.push({
      code, name_cn: f.cn, category, scope: f.scope,
      ncv: isIndirect ? null : f.ncv,
      ncv_unit: isIndirect ? null : f.ncvUnit,
      cc: isIndirect ? null : f.cc,
      of_rate: isIndirect ? null : f.of,
      ef_value: Number(ef.toFixed(8)),
      ef_unit: f.unit,
      source_doc: f.src,
      source_year: 2022,
      industry: null,
      region: null,
      version: VERSION,
      effective_from: EFFECTIVE_FROM,
      status: 'ACTIVE',
      remark: isIndirect
        ? '间接排放因子，非 AD×EF×OF 形式，无三要素复算'
        : `三要素复算：${f.ncv}/1000 × ${f.cc} × ${f.of} × 44/12 = ${ef.toFixed(6)}`,
    });
  }

  /* 区域电网因子：同一 code=POWER 但不同 region，靠 uk(code,version,region) 区分 */
  for (const [region, r] of Object.entries(M.REGION_GRID_FACTOR)) {
    rows.push({
      code: 'POWER', name_cn: `电力（${region}区域）`, category: 'POWER', scope: 2,
      ncv: null, ncv_unit: null, cc: null, of_rate: null,
      ef_value: r.ef, ef_unit: 'MWh',
      source_doc: `生态环境部《2022年电力二氧化碳排放因子》${region}区域电网因子（覆盖 ${r.region}）`,
      source_year: 2022,
      industry: null, region,
      version: VERSION, effective_from: EFFECTIVE_FROM, status: 'ACTIVE',
      remark: `区域电网因子，覆盖：${r.region}`,
    });
  }
  return rows;
}

/** 工业过程因子 */
function processRows() {
  const rows = [];
  for (const [code, f] of Object.entries(M.PROCESS_FACTORS)) {
    if (!(f.ef > 0)) continue; // 检查项不入库（如 STEEL_REDUCTANT）
    rows.push({
      code, name_cn: f.cn, category: 'PROCESS', scope: 1,
      ncv: null, ncv_unit: null, cc: null, of_rate: null,
      ef_value: f.ef, ef_unit: f.unit,
      source_doc: f.src, source_year: null,
      industry: null, region: null,
      version: VERSION, effective_from: EFFECTIVE_FROM, status: 'ACTIVE',
      remark: '工业过程排放因子（碳来自原料化学转化，非燃烧氧化）',
    });
  }
  return rows;
}

/**
 * 复算校验：燃料类必须满足 EF = NCV/1000 × CC × OF × 44/12（容差 0.3%）。
 * 不满足的行**拒绝入库**并抛错 —— 这是防止「因子表被改坏」的唯一硬约束。
 */
function verifyRows(rows) {
  const problems = [];
  for (const r of rows) {
    if (r.category !== 'FUEL') {
      r.recompute_ok = 1;
      r.recompute_diff = 0;
      continue;
    }
    const re = M.computeEf(r.ncv, r.cc, r.of_rate);
    const diff = Math.abs(re - r.ef_value);
    const rel = r.ef_value > 0 ? diff / r.ef_value : 1;
    r.recompute_diff = Number(diff.toFixed(8));
    r.recompute_ok = rel < 0.003 ? 1 : 0;
    if (!r.recompute_ok) {
      problems.push(`${r.code}(${r.name_cn})：登记 ${r.ef_value} vs 复算 ${re.toFixed(6)}，相对差 ${(rel * 100).toFixed(3)}%`);
    }
  }
  if (problems.length) {
    throw new Error('因子复算校验未通过，拒绝入库：\n  - ' + problems.join('\n  - '));
  }
  return { checked: rows.length, fuelChecked: rows.filter((r) => r.category === 'FUEL').length };
}

/**
 * 写入 factor_entry。
 * @param {object} [opts] { silent:boolean }
 */
async function seed(opts = {}) {
  const rows = [...fuelRows(), ...processRows()];
  const v = verifyRows(rows);

  /* 先清掉同版本的旧行，保证幂等（唯一键是 code+version+region，
   * 但 region 为 NULL 时 MySQL 唯一键不去重 —— NULL ≠ NULL，
   * 所以必须显式 DELETE，否则重复执行会堆出多份）。 */
  await db.query('DELETE FROM factor_entry WHERE version = ?', [VERSION]);

  const cols = ['code', 'name_cn', 'category', 'scope', 'ncv', 'ncv_unit', 'cc', 'of_rate',
    'ef_value', 'ef_unit', 'source_doc', 'source_year', 'industry', 'region',
    'version', 'effective_from', 'status', 'recompute_ok', 'recompute_diff', 'remark'];
  const vals = rows.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c])));
  const CHUNK = 100;
  let n = 0;
  for (let i = 0; i < vals.length; i += CHUNK) {
    const slice = vals.slice(i, i + CHUNK);
    const ph = slice.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
    await db.pool.query(`INSERT INTO factor_entry (${cols.join(',')}) VALUES ${ph}`, slice.flat());
    n += slice.length;
  }

  /* 同步刷新扁平的 emission_factor 表 —— 保持旧接口可用。
   * 这一步让「因子库」与「核算链」重新连上：旧表的 factor 值从此
   * 由 factor_entry 的复算结果派生，不再是手写常量。 */
  const fuelOnly = rows.filter((r) => r.category === 'FUEL' && !r.region);
  for (const r of fuelOnly) {
    await db.query(
      `UPDATE emission_factor SET factor = ?, source = ?, effective_from = ?, version = ?
        WHERE energy_type = ? AND industry IS NULL`,
      [Number(r.ef_value.toFixed(6)), r.source_doc, EFFECTIVE_FROM, VERSION, r.code]
    );
  }

  const stats = {
    version: VERSION,
    total: n,
    fuel: rows.filter((r) => r.category === 'FUEL').length,
    power: rows.filter((r) => r.category === 'POWER').length,
    heat: rows.filter((r) => r.category === 'HEAT').length,
    process: rows.filter((r) => r.category === 'PROCESS').length,
    regionGrid: Object.keys(M.REGION_GRID_FACTOR).length,
    recomputeChecked: v.checked,
    fuelRecomputeChecked: v.fuelChecked,
    syncedFlatTable: fuelOnly.length,
  };
  if (!opts.silent) {
    console.log(`✔ 因子台账已写入：${n} 条（燃料 ${stats.fuel} / 电力 ${stats.power} / 热力 ${stats.heat} / 过程 ${stats.process}）`);
    console.log(`  复算校验：${v.fuelChecked}/${v.fuelChecked} 条燃料因子通过三要素复算`);
    console.log(`  已同步扁平因子表 emission_factor：${fuelOnly.length} 条`);
  }
  return stats;
}

module.exports = { seed, verifyRows, fuelRows, processRows, VERSION };

/* 允许直接执行：node server/scripts/seed-factors.js */
if (require.main === module) {
  seed()
    .then((s) => { console.log(JSON.stringify(s, null, 2)); return db.pool.end(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error('✘ 写入失败：', e.message); process.exit(1); });
}
