#!/usr/bin/env node
/**
 * tools/seed-demo-business.cjs
 * ============================================================================
 * 为「方案 A」补充主体生成**演示业务数据**，使平台空置功能页面可用。
 *
 * ⚠ 本脚本生成的全部是演示数据，不是任何真实企业的实际排放。
 *   可辨识性靠三处叠加，缺一不可：
 *
 *   ① data_source = 'DEMO_SUPPLEMENT'（与真实企业的 'DERIVED_FROM_CEMS' 严格区分）
 *   ② is_real = 0（与真实数据同，但真实数据另有 derivation_log 血缘）
 *   ③ remark 首行写明「演示数据 · 用于功能演示，非真实排放」
 *
 *   真实企业的 32 张上报单每张都有 derivation_log 血缘可回溯；
 *   本脚本生成的没有血缘 —— 这不是瑕疵，而是设计：
 *   "能否回溯到真实输入"本身就是真假数据的分界线。
 *   审计脚本 tools/derivation-audit.cjs 的 I1 只检查 DERIVED_FROM_CEMS，
 *   因此不会被演示数据污染。
 *
 * 用法：
 *   node tools/seed-demo-business.cjs --dry
 *   node tools/seed-demo-business.cjs
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const cu = require(path.join(__dirname, '..', 'server', 'blockchain', 'crypto-utils'));

const DRY = process.argv.includes('--dry');
const RESET = process.argv.includes('--reset');
const MARK = 'DEMO_SUPPLEMENT';
const R = (x, n = 2) => Number(Number(x).toFixed(n));

/* 演示用行业参数：仅用于让演示数据量级合理，不代表任何真实企业。
 *
 * ⚠ 量级取舍的说明（这一条很容易被忽略，但它决定别人第一眼看到什么）：
 *   钢铁 120 万吨 + 热电 300 万 MWh 是**行业典型规模**，但把这两家放进
 *   一个只有 4 家垃圾焚烧企业的池子里，演示数据会占总量 87% ——
 *   公示大屏的"年度排放"变成 978 万 t，其中 800 多万是我编的。
 *   真实数据的 144 万 t 反而成了零头。
 *
 *   这不是数值算错，是**比例失衡**：把演示主体按行业大厂规模建，
 *   却让它们承担"补充展示"的角色。补充件的体量不该压过主体。
 *
 *   因此按"中小规模"取：钢铁年产钢 60 万吨、热电年上网 100 万 MWh，
 *   使演示数据占比落在 ~50%，既能撑起功能演示，
 *   又不会让公示大屏的数字主要由演示数据构成。
 *   这个比例仍是人为选择 —— 所以在 remark 和文档里都写明，
 *   不假装它是自然形成的。 */
const INDUSTRY_PROFILE = {
  钢铁: {
    /* 长流程钢铁吨钢直接排放约 1.8–2.1 tCO₂（高炉+转炉）。
     * 取 1.95 中值；年产钢 60 万吨（中型特钢企业量级）。 */
    intensityPerUnit: 1.95, unit: 't',
    annualOutput: 60 * 1e4, annualOutputUnit: 't',
    note: '按长流程钢铁吨钢直接排放约 1.95 tCO₂ 的行业量级演示（年产钢 60 万吨）',
  },
  热电: {
    /* 燃煤热电度电 CO₂ 约 0.85 kg。
     * 年上网电量 100 万 MWh = 10 亿 kWh（中型热电厂量级）。 */
    intensityPerUnit: 0.85, unit: 'MWh',
    annualOutput: 1000000, annualOutputUnit: 'MWh',
    note: '按燃煤热电度电 CO₂ 约 0.85 t/MWh 的行业量级演示（年上网电量 100 万 MWh）',
  },
};

(async () => {
  console.log('══════════════════════════════════════════════════════════');
  console.log(`生成补充主体的演示业务数据  ${DRY ? '【试算】' : ''}`);
  console.log('══════════════════════════════════════════════════════════');

  const ents = await db.query(
    `SELECT id, ent_name, short_name, industry FROM enterprise
      WHERE id >= 86 AND industry IN ('钢铁','热电') ORDER BY id`
  );
  if (!ents.length) { console.log('无待处理企业'); await db.pool.end(); return; }

  /* --reset：先清掉本脚本此前生成的演示数据（只删 data_source=DEMO_SUPPLEMENT，
   * 绝不碰真实派生数据）。用于调整量级后重算，避免同一季度存在两套演示值。 */
  if (RESET && !DRY) {
    const ids = ents.map((e) => e.id);
    const ph = ids.map(() => '?').join(',');
    const n = Number(await db.value(
      `SELECT COUNT(*) FROM emission_report WHERE ent_id IN (${ph}) AND data_source=?`,
      [...ids, MARK]
    ));
    if (n > 0) {
      await db.query(
        `DELETE i FROM emission_item i JOIN emission_report r ON r.id=i.report_id
          WHERE r.ent_id IN (${ph}) AND r.data_source=?`, [...ids, MARK]
      );
      await db.query(
        `DELETE FROM emission_report WHERE ent_id IN (${ph}) AND data_source=?`,
        [...ids, MARK]
      );
      console.log(`\n  ⟲ 已清除旧演示数据 ${n} 张（未触及真实派生数据）`);
    }
  }

  const YEARS = [2024, 2025];
  let reportCount = 0;

  for (const e of ents) {
    const prof = INDUSTRY_PROFILE[e.industry];
    if (!prof) { console.log(`  跳过 ${e.ent_name}（行业 ${e.industry} 无演示参数）`); continue; }

    console.log(`\n── #${e.id} ${e.ent_name}（${e.industry}）`);

    const annualCo2 = prof.annualOutput * prof.intensityPerUnit;

    /* 季度权重：演示用固定的季节分布（钢铁 Q4 高、热电 Q1/Q4 高），
     * 与真实企业的"按实测烟气量分摊"完全不同 —— 那是真实值，这是演示形状。 */
    const shares = e.industry === '钢铁'
      ? [0.235, 0.245, 0.250, 0.270]
      : [0.300, 0.215, 0.185, 0.300];

    for (const year of YEARS) {
      for (let qi = 0; qi < 4; qi++) {
        const quarter = qi + 1;
        const period = `${year}Q${quarter}`;
        const exists = await db.one(
          'SELECT id FROM emission_report WHERE ent_id=? AND year=? AND quarter=?',
          [e.id, year, quarter]
        );
        if (exists) { console.log(`   ${period} 已存在，跳过`); continue; }

        const co2 = R(annualCo2 * shares[qi], 2);
        /* output_value 存的是物理产量（t 或 MWh），不是产值。
         * intensity 因此是"单位产量碳强度"，与真实企业那份
         * "单位上网电量碳强度"口径一致，都是物理强度而非经济强度。 */
        const outputValue = R(prof.annualOutput * shares[qi], 2);
        const intensity = outputValue > 0 ? R(co2 / outputValue, 6) : 0;
        const reportNo = cu.bizNo('ER');
        const remark = `【演示数据】用于功能演示，非真实排放。`
          + `生成方式：行业量级参数 × 固定季节权重。${prof.note}。`
          + `本单据没有 derivation_log 血缘，不可回溯到任何 CEMS 实测数据 —— `
          + `这正是它与真实企业上报单（DERIVED_FROM_CEMS，可逐项回溯）的区别。`;

        if (DRY) {
          console.log(`   [dry] ${period} CO₂ ${co2} t`);
          continue;
        }

        const [ins] = await db.pool.query(
          `INSERT INTO emission_report
            (report_no, ent_id, year, quarter, period, scope1_emission, scope2_emission,
             total_emission, energy_consumption, output_value, intensity, yoy_rate,
             data_source, status, remark, created_at, is_real, co2_only)
           VALUES (?,?,?,?,?,?,0,?,?,?,?,0,?,'DRAFT',?,NOW(),0,?)`,
          [reportNo, e.id, year, quarter, period, co2, co2,
            R(co2 / (prof.intensityPerUnit * 1000) * 1000, 2), outputValue, intensity,
            MARK, remark, co2]
        );
        const reportId = ins.insertId;

        await db.query(
          `INSERT INTO emission_item (report_id, ent_id, energy_type, scope, amount, unit, factor, co2, calc_method)
           VALUES (?,?,?,1,?,?,?,?,?)`,
          [reportId, e.id,
            e.industry === '钢铁' ? '焦炭/煤（高炉-转炉流程）' : '原煤（燃煤热电）',
            outputValue, prof.unit, R(prof.intensityPerUnit, 6), co2, '行业量级演示参数']
        );
        reportCount++;
      }
      console.log(`   ${year} 年 4 张（CO₂ 合计 ${R(annualCo2, 0)} t）`);
    }
  }

  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  新建演示上报单 ${reportCount} 张`);
  if (!DRY) {
    const chk = await db.query(
      `SELECT data_source, COUNT(*) n, SUM(total_emission) s
         FROM emission_report GROUP BY data_source ORDER BY n DESC`
    );
    console.log('\n  按来源分类：');
    for (const c of chk) {
      const tag = c.data_source === MARK ? '  ← 演示（无血缘，不可回溯）'
        : c.data_source === 'DERIVED_FROM_CEMS' ? '  ← 真实派生（有血缘，可回溯）' : '';
      console.log(`    ${String(c.data_source).padEnd(20)} ${String(c.n).padStart(3)} 张  `
        + `${R(Number(c.s), 0).toLocaleString()} t${tag}`);
    }
  }
  console.log('══════════════════════════════════════════════════════════');
  await db.pool.end();
})().catch((e) => { console.error('✘', e.message); console.error(e.stack); process.exit(1); });
