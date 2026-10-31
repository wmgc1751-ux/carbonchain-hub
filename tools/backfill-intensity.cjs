/* 回填派生上报单的强度与上网电量分母
 *
 * 背景：最初生成时 intensity/output_value 都留 0，因为企业没有产值数据。
 * 结果公示大屏"平均强度"显示 0，像零碳企业 —— 比显示"—"更误导。
 * 改为用官方上网电量作分母（tCO₂/万kWh），并写清口径。
 *
 * 幂等：只处理 intensity=0 且 remark 里没有"万kWh"标记的行。
 */
'use strict';
const path = require('path');
const db = require(path.join(__dirname,'..','server','db'));
const { normalizeName } = require(path.join(__dirname,'..','server','services','derive'));

const R = (x, n = 2) => Number(Number(x).toFixed(n));

(async () => {
  const reports = await db.query(
    `SELECT r.id, r.ent_id, r.year, r.quarter, r.total_emission, r.intensity, r.remark,
            e.ent_name
       FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
      WHERE r.data_source = 'DERIVED_FROM_CEMS'
      ORDER BY r.ent_id, r.year, r.quarter`
  );

  const gridCache = {};
  async function gridFor(entName, year) {
    const k = `${entName}|${year}`;
    if (k in gridCache) return gridCache[k];
    const acts = await db.query('SELECT * FROM enterprise_activity WHERE year = ?', [year]);
    const key = normalizeName(entName);
    const mine = acts.filter((a) => {
      const n = normalizeName(a.ent_name);
      return n === key || n.startsWith(key) || key.startsWith(n);
    });
    const v = mine.length ? mine.reduce((s, x) => s + Number(x.grid_kwh_10k || 0), 0) : 0;
    gridCache[k] = v > 0 ? v : null;
    return gridCache[k];
  }

  /* 季度权重取自血缘快照，与当季 CO₂ 用的是同一套占比 */
  async function shareOf(reportId) {
    const row = await db.one(
      `SELECT source_detail FROM derivation_log
        WHERE target_table='emission_report' AND target_id=? AND rule_code='CO2_ANNUAL_X_CEMS_GAS_SHARE'`,
      [reportId]
    );
    if (!row) return null;
    const d = typeof row.source_detail === 'string' ? JSON.parse(row.source_detail) : row.source_detail;
    return d && d.quarterShare !== undefined ? Number(d.quarterShare) : null;
  }

  let fixed = 0;
  let skipped = 0;
  for (const r of reports) {
    if (Number(r.intensity) > 0) { skipped++; continue; }
    const g = await gridFor(r.ent_name, r.year);
    if (!g) { skipped++; continue; }
    const share = (await shareOf(r.id)) ?? 0.25;
    const qGrid = R(g * share, 2);
    if (!(qGrid > 0)) { skipped++; continue; }
    const intensity = R(Number(r.total_emission) / qGrid, 4);
    const remark = `CO₂ 为派生值（官方活动水平×实测烟气量占比）；强度口径为 tCO₂/万kWh 上网电量，`
      + `非 tCO₂/万元产值（本企业无产值数据）。CEMS 只提供污染物实测与时间分布。`;
    await db.query(
      'UPDATE emission_report SET output_value=?, intensity=?, remark=? WHERE id=?',
      [qGrid, intensity, remark, r.id]
    );
    fixed++;
    console.log(`  #${r.id} ent${r.ent_id} ${r.year}Q${r.quarter}: `
      + `上网 ${qGrid} 万kWh → 强度 ${intensity} tCO₂/万kWh`);
  }

  console.log(`\n回填 ${fixed} 张，跳过 ${skipped} 张（已有强度或无官方电量）`);

  console.log('\n=== 分年度强度 ===');
  const agg = await db.query(
    `SELECT year, SUM(total_emission) co2, SUM(output_value) grid,
            COUNT(*) n, AVG(intensity) ai
       FROM emission_report WHERE data_source='DERIVED_FROM_CEMS'
      GROUP BY year ORDER BY year`
  );
  for (const a of agg) {
    const avg = Number(a.grid) > 0 ? R(Number(a.co2) / Number(a.grid), 4) : null;
    console.log(`  ${a.year}: 排放 ${R(Number(a.co2), 0)} t / 上网 ${R(Number(a.grid), 0)} 万kWh`
      + ` → 加权强度 ${avg} tCO₂/万kWh（${a.n} 张）`);
  }
  await db.pool.end();
})().catch((e) => { console.error('✘', e.message); console.error(e.stack); process.exit(1); });
