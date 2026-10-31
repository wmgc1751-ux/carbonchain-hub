/* 为已存派生上报单补 "CO₂ 来源行"（emission_item）
 *
 * 背景：最初只写了 CEMS 污染物行（co2=0），没有写 CO₂ 来源行。
 * 前端"排放构成"图按 emission_item.co2 聚合，结果 5 个扇区全为 0，
 * 而汇总字段 total_emission 是对的 —— 静默错误，页面不报错但图没意义。
 *
 * 幂等：已存在 '生活垃圾焚烧（化石碳）' 行的单据跳过。
 */
'use strict';
const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));

const R = (x, n = 2) => Number(Number(x).toFixed(n));

(async () => {
  const reports = await db.query(
    `SELECT r.id, r.ent_id, r.year, r.quarter, r.total_emission, r.output_value
       FROM emission_report r
      WHERE r.data_source = 'DERIVED_FROM_CEMS'
        AND NOT EXISTS (
          SELECT 1 FROM emission_item i
           WHERE i.report_id = r.id AND i.energy_type = '生活垃圾焚烧（化石碳）')
      ORDER BY r.id`
  );
  if (!reports.length) { console.log('  无需补录'); await db.pool.end(); return; }

  console.log(`需补录 ${reports.length} 张上报单`);
  let n = 0;
  for (const r of reports) {
    const grid = Number(r.output_value || 0);
    const co2 = Number(r.total_emission);
    await db.query(
      `INSERT INTO emission_item (report_id, ent_id, energy_type, scope, amount, unit, factor, co2, calc_method)
       VALUES (?,?,?,1,?,?,?,?,?)`,
      [r.id, r.ent_id, '生活垃圾焚烧（化石碳）',
        grid > 0 ? R(grid, 2) : R(co2 / 0.390, 2),
        grid > 0 ? '万kWh' : 't原料',
        0.390, co2, '活动水平法（官方处理量×化石碳因子）']
    );
    n++;
  }
  console.log(`  ✔ 补录 ${n} 条 CO₂ 来源行`);

  const chk = await db.query(
    `SELECT r.year, SUM(i.co2) itemCo2, MIN(r.total_emission) repCo2
       FROM emission_item i JOIN emission_report r ON r.id = i.report_id
      WHERE i.energy_type = '生活垃圾焚烧（化石碳）'
      GROUP BY r.year ORDER BY r.year`
  );
  console.log('\n=== 校验：明细 CO₂ 合计 vs 单据 CO₂ ===');
  for (const c of chk) {
    console.log(`  ${c.year}: 明细合计 ${R(Number(c.itemCo2), 2)} / 单据 ${R(Number(c.repCo2), 2)}`);
  }
  await db.pool.end();
})().catch((e) => { console.error('✘', e.message); console.error(e.stack); process.exit(1); });
