#!/usr/bin/env node
/**
 * tools/derive-business.cjs —— 「企业只交 CEMS，平台派生其余业务数据」
 * ============================================================================
 * 用法：
 *   node tools/derive-business.cjs --year 2024                 # 试算，不提交不上链
 *   node tools/derive-business.cjs --year 2024 --commit        # 提交 + 上链 + 派核查
 *   node tools/derive-business.cjs --year 2025 --extrapolate   # 官方统计未公布时允许外推
 *   node tools/derive-business.cjs --all --commit              # 2024 + 2025 全量
 *   node tools/derive-business.cjs --verify                    # 只做一致性校验
 *
 * 设计纪律（写进代码，不写在 PPT 里）：
 *   ① 没有真实输入的派生一律拒绝（derivation_log.source_kind 有 CHECK 约束）
 *   ② is_real 恒为 0 —— 派生值不冒充实测值
 *   ③ 外推年度 layer=MODELED / confidence=LOW，且 limitation 写明「不是实测也不是官方统计」
 *   ④ 分摊比必须精确闭合到 1，否则年度合计对不上官方基数
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const derive = require(path.join(__dirname, '..', 'server', 'services', 'derive'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const COMMIT = has('--commit');
const VERIFY_ONLY = has('--verify');
const EXTRAPOLATE = has('--extrapolate');
const ALL = has('--all');
const YEARS = ALL ? [2024, 2025] : [Number(val('--year', 2024))];

const P = (s = '') => console.log(s);
const line = (c = '─', n = 76) => c.repeat(n);

/* ================================================================== */
async function verify() {
  P(line('═'));
  P('一致性校验');
  P(line('═'));

  let pass = 0;
  let fail = 0;
  const check = (ok, label, detail = '') => {
    if (ok) pass++; else fail++;
    P(`  ${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`);
  };

  /* 1. is_real 必须全为 0：派生值不冒充真实 */
  const fakeReal = Number(await db.value(
    'SELECT COUNT(*) FROM emission_report WHERE is_real <> 0'
  ));
  check(fakeReal === 0, 'is_real<>0 的上报单为 0（派生值不冒充实测）', `实测 ${fakeReal}`);

  /* 2. 每条派生单必须有血缘 */
  const orphan = Number(await db.value(
    `SELECT COUNT(*) FROM emission_report r
      WHERE r.data_source = 'DERIVED_FROM_CEMS'
        AND NOT EXISTS (SELECT 1 FROM derivation_log d
                         WHERE d.target_table='emission_report' AND d.target_id=r.id)`
  ));
  check(orphan === 0, '无血缘的派生上报单为 0', `实测 ${orphan}`);

  /* 3. 分摊比闭合到 1 */
  const shares = await db.query(
    `SELECT r.ent_id, r.year,
            SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(d.source_detail,'$.quarterShare')) AS DECIMAL(18,8))) sh,
            COUNT(*) n,
            MIN(CAST(JSON_UNQUOTE(JSON_EXTRACT(d.source_detail,'$.annualCo2')) AS DECIMAL(18,2))) base
       FROM derivation_log d JOIN emission_report r ON r.id = d.target_id
      WHERE d.rule_code = 'CO2_ANNUAL_X_CEMS_GAS_SHARE'
      GROUP BY r.ent_id, r.year ORDER BY r.ent_id, r.year`
  );
  for (const s of shares) {
    const ok = Math.abs(Number(s.sh) - 1) < 1e-6;
    check(ok, `ent${s.ent_id} ${s.year} 分摊比闭合`, `合计 ${Number(s.sh).toFixed(6)} / 基数 ${Number(s.base).toFixed(2)} t`);
  }

  /* 4. 派生年度合计 vs 官方基数 */
  const totals = await db.query(
    `SELECT r.ent_id, r.year, SUM(r.total_emission) s
       FROM emission_report r WHERE r.data_source='DERIVED_FROM_CEMS'
      GROUP BY r.ent_id, r.year ORDER BY r.ent_id, r.year`
  );
  for (const t of totals) {
    const base = await db.value(
      `SELECT MIN(CAST(JSON_UNQUOTE(JSON_EXTRACT(source_detail,'$.annualCo2')) AS DECIMAL(18,2)))
         FROM derivation_log WHERE rule_code='CO2_ANNUAL_X_CEMS_GAS_SHARE'
        AND target_id IN (SELECT id FROM emission_report WHERE ent_id=? AND year=?)`,
      [t.ent_id, t.year]
    );
    const diff = Math.abs(Number(t.s) - Number(base || 0));
    check(diff <= 0.05, `ent${t.ent_id} ${t.year} 年度合计与基数闭合`,
      `派生 ${Number(t.s).toFixed(2)} / 基数 ${Number(base || 0).toFixed(2)} / 差 ${diff.toFixed(4)} t`);
  }

  /* 5. 血缘来源不得为 NONE（库层已有 CHECK，这里再查一次以防绕过） */
  const noSrc = Number(await db.value(
    "SELECT COUNT(*) FROM derivation_log WHERE source_kind IS NULL OR source_kind='' OR source_kind='NONE'"
  ));
  check(noSrc === 0, '无来源的派生血缘为 0', `实测 ${noSrc}`);

  /* 6. 外推记录必须标明 LOW 置信 */
  const badExtrap = Number(await db.value(
    `SELECT COUNT(*) FROM derivation_log
      WHERE JSON_EXTRACT(source_detail,'$.extrapolated') = TRUE AND confidence <> 'LOW'`
  ));
  check(badExtrap === 0, '外推记录置信度均为 LOW', `违规 ${badExtrap}`);

  P(line());
  P(`  通过 ${pass} 项，失败 ${fail} 项`);
  return fail === 0;
}

/* ================================================================== */
async function deriveYear(year) {
  P(line('═'));
  P(`派生 ${year} 年度业务数据${EXTRAPOLATE ? '（允许外推）' : ''}${COMMIT ? '' : ' —— 试算模式，不提交'}`);
  P(line('═'));

  const ents = await db.query(
    "SELECT id, ent_name, ent_code FROM enterprise WHERE industry='垃圾焚烧发电' ORDER BY id"
  );
  const summaries = [];

  for (const ent of ents) {
    const r = await derive.deriveQuarterlyReports(ent, year, { extrapolate: EXTRAPOLATE });
    P(`\n── #${ent.id} ${ent.ent_name}`);
    if (r.skipped) {
      P(`   跳过：${r.skipped}`);
      P(`   ${r.reason}`);
      summaries.push({ ent: ent.ent_name, skipped: r.skipped });
      continue;
    }
    P(`   CO₂ 基数 ${r.co2Total} t`);
    P(`   依据：${r.co2Basis}`);
    if (r.extrapolated) P('   ⚠ 外推值（layer=MODELED, confidence=LOW），不得作为实测主张');
    P(`   CEMS 污染物：SO₂ ${r.pollutants.yearTotals.so2Kg} kg，`
      + `NOx ${r.pollutants.yearTotals.noxKg} kg，`
      + `烟尘 ${r.pollutants.yearTotals.pmKg} kg，`
      + `有效小时 ${r.pollutants.yearTotals.validHours}`);

    const created = r.reports.filter((q) => q.reportId && !q.skipped);
    const existed = r.reports.filter((q) => q.skipped === 'EXISTS');
    P(`   上报单：新建/补血缘 ${created.length} 张，已存在 ${existed.length} 张`);

    /* 提交 + 上链 + 派核查 */
    if (COMMIT) {
      for (const q of r.reports) {
        if (!q.reportId) continue;
        try {
          const res = await derive.submitAndAssign(q.reportId, ent.id);
          if (res.skipped) {
            P(`   Q${q.quarter} 单#${q.reportId}：${res.skipped}（${res.status}）`);
          } else {
            P(`   Q${q.quarter} 单#${q.reportId}：已上链 #${res.chain.blockIndex}，`
              + `核查任务 ${res.taskNo} → ${res.verifier}`);
          }
        } catch (e) {
          P(`   Q${q.quarter} 单#${q.reportId}：上链失败 ${e.message}`);
        }
      }
    } else {
      for (const q of r.reports) {
        if (q.skipped) { P(`   Q${q.quarter}: ${q.skipped}`); continue; }
        P(`   Q${q.quarter}: CO₂ ${q.co2} t (${(q.share * 100).toFixed(2)}%) 单#${q.reportNo}`);
      }
    }
    summaries.push({ ent: ent.ent_name, co2: r.co2Total, extrapolated: !!r.extrapolated });
  }

  return summaries;
}

/* ================================================================== */
async function main() {
  P('');
  if (VERIFY_ONLY) {
    const ok = await verify();
    await db.pool.end();
    process.exit(ok ? 0 : 1);
  }

  /* 覆盖率登记始终先跑：它决定「单排口 ≠ 全厂」这个边界能否被看见 */
  P(line('═'));
  P('CEMS 覆盖口径登记（判定单排口 vs 全厂）');
  P(line('═'));
  const cov = await derive.computeCoverage();
  const yrs = new Set(YEARS.map(String));
  for (const c of cov.filter((x) => yrs.has(String(x.year)))) {
    P(`  ${c.entName.slice(0, 16)} ${c.year} ${c.outlet}`);
    P(`    有效小时 ${c.validHours}  每吨烟气 ${c.gasPerTon ?? '未知'} m³/t  `
      + `覆盖比 ${c.coverageRatio ?? '未知'}`);
  }

  const all = [];
  for (const y of YEARS) {
    const s = await deriveYear(y);
    all.push(...s.map((x) => ({ ...x, year: y })));
  }

  P('\n' + line('═'));
  const ok = await verify();
  await db.pool.end();
  P('\n' + line('═'));
  P(ok ? '  ✔ 全部一致性校验通过' : '  ✘ 存在未通过项，见上');
  P(line('═'));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('\n✘', e.message);
  console.error(e.stack);
  process.exit(1);
});
