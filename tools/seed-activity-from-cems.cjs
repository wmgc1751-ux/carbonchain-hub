#!/usr/bin/env node
/**
 * tools/seed-activity-from-cems.cjs
 * ============================================================================
 * 从**真实 CEMS 实测数据**生成月度活动数据，使「活动数据台账」页面可用。
 *
 * 这不是编数据，但也不是直接实测 —— 必须说清是哪一种：
 *
 *   CEMS 实测的是**烟气量与污染物浓度**，不是燃料消耗量。
 *   燃料量只能由烟气量反算：垃圾焚烧的烟气量与入炉垃圾量近似成正比。
 *   反算用了两个行业参数（每吨垃圾烟气量、垃圾低位热值），
 *   这两个参数的选取本身就是假设。
 *
 * 因此生成的 activity_data 一律：
 *   · data_origin = 'L2'（二级数据），不是 L1（实测计量）
 *   · remark 写明"由 CEMS 烟气量反算，非燃料计量表读数"
 *   · 只对 4 家真实企业生成，不给演示主体生成
 *
 * 对比：真实企业的上报单是 DERIVED_FROM_CEMS（可回溯到 CEMS 批次）；
 *       本脚本产出的活动数据是 CEMS_DERIVED_ACTIVITY（可回溯但含换算假设）。
 *
 * 用法：
 *   node tools/seed-activity-from-cems.cjs --dry
 *   node tools/seed-activity-from-cems.cjs
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));

const DRY = process.argv.includes('--dry');
const R = (x, n = 4) => Number(Number(x).toFixed(n));

/* 反算参数：这两个是假设，不是实测值，必须写进 remark */
const GAS_PER_TON_MSW = 4500;     // m³/t，行业典型区间 4000–6000 取中值
const MSW_LHV_GJ_PER_T = 7.0;     // GJ/t，生活垃圾低位热值典型值 6–8

const YEAR = (() => {
  const i = process.argv.indexOf('--year');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 2024;
})();

(async () => {
  console.log('══════════════════════════════════════════════════════════');
  console.log(`由 CEMS 烟气量反算月度活动数据  ${YEAR}  ${DRY ? '【试算】' : ''}`);
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  反算参数（假设，非实测）：每吨垃圾烟气量 ${GAS_PER_TON_MSW} m³/t，`
    + `低位热值 ${MSW_LHV_GJ_PER_T} GJ/t`);

  const ents = await db.query(
    "SELECT id, ent_name FROM enterprise WHERE industry='垃圾焚烧发电' ORDER BY id"
  );

  let created = 0;
  let skipped = 0;

  for (const e of ents) {
    /* 逐月取真实烟气量（只算有效小时） */
    const rows = await db.query(
      `SELECT MONTH(monitored_at) AS mo, SUM(flue_gas_m3) AS gas, SUM(is_valid) AS valid
         FROM cems_cn_hourly
        WHERE ent_name LIKE ? AND YEAR(monitored_at) = ? AND is_valid = 1
        GROUP BY MONTH(monitored_at) ORDER BY mo`,
      [`${String(e.ent_name).replace(/有限(责任)?公司$/, '').slice(0, 10)}%`, YEAR]
    );
    if (!rows.length) { console.log(`  跳过 ${e.ent_name}（${YEAR} 年无 CEMS 数据）`); continue; }

    console.log(`\n── #${e.id} ${e.ent_name.slice(0, 18)}`);
    for (const r of rows) {
      const gasM3 = Number(r.gas || 0);
      if (!(gasM3 > 0)) continue;
      const mswT = gasM3 / GAS_PER_TON_MSW;   // 吨垃圾
      const exists = await db.one(
        `SELECT id FROM activity_data
          WHERE ent_id=? AND year=? AND month=? AND source_code='MSW'`, [e.id, YEAR, r.mo]
      );
      if (exists) { skipped++; continue; }
      if (DRY) { console.log(`   [dry] ${YEAR}-${String(r.mo).padStart(2, '0')}  ${R(mswT, 0)} t 垃圾`); continue; }

      const remark = `【二级数据】由 CEMS 实测烟气量反算，非燃料计量表读数。`
        + `实测烟气量 ${R(gasM3, 0)} m³（有效小时 ${r.valid}）÷ 每吨垃圾烟气量 `
        + `${GAS_PER_TON_MSW} m³/t = ${R(mswT, 0)} t 入炉垃圾。`
        + `反算假设：①每吨垃圾烟气量取行业区间中值；②烟气量与入炉量近似成正比。`
        + `两个假设都会引入偏差，故标 data_origin=L2 而非 L1（实测计量）。`
        + `⚠ 另需注意：CEMS 仅覆盖单个排口，反算值系统性低于全厂官方处理量`
        + `（本平台实测覆盖比约 15%–31%）。本值用于台账演示与量级校核，`
        + `不作为全厂处理量的申报依据 —— 后者以省发改委统计表为准。`;

      await db.query(
        `INSERT INTO activity_data
          (ent_id, year, month, source_code, source_type, quantity, unit,
           data_origin, status, remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,'SUBMITTED',?,NOW(),NOW())`,
        [e.id, YEAR, r.mo, 'MSW', 'FUEL', R(mswT, 2), 't', 'L2', remark]
      );
      created++;
      if (created <= 6) console.log(`   ${YEAR}-${String(r.mo).padStart(2, '0')}  ${R(mswT, 0)} t`);
    }
    if (created > 6) console.log(`   …（本月起共 ${rows.length} 个月）`);
  }

  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  新建活动数据 ${created} 条，已存在 ${skipped} 条`);
  if (!DRY) {
    const chk = await db.query(
      `SELECT data_origin, COUNT(*) n, SUM(quantity) s
         FROM activity_data WHERE year=? GROUP BY data_origin`, [YEAR]
    );
    for (const c of chk) console.log(`    origin=${c.data_origin}  ${c.n} 条  ${R(Number(c.s), 0).toLocaleString()} t`);
  }
  console.log('══════════════════════════════════════════════════════════');
  await db.pool.end();
})().catch((e) => { console.error('✘', e.message); console.error(e.stack); process.exit(1); });
