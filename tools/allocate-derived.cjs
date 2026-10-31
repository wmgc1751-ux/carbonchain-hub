#!/usr/bin/env node
/**
 * tools/allocate-derived.cjs —— 由核查结论派生配额分配（行业基准线法）
 * ============================================================================
 * 为什么不能用「配额 = 核查排放量 × 某个折扣系数」：
 *   折扣系数没有任何来源，等于把「减排压力」这个政策变量写死成我的假设。
 *   审查时无法回答「凭什么是 0.9」，这跟编造数据没有区别。
 *
 * 本工具用的是**行业基准线法（Benchmarking）**，这是中国碳市场对发电行业
 * 实际采用的方法，且公式里的每一个量都来自真实数据：
 *
 *     基准线强度 = Σ(各企业核查排放量) / Σ(各企业实际上网电量)
 *     企业配额   = 基准线强度 × 该企业实际上网电量
 *
 *   · 核查排放量 —— 已核查、已上链的派生值（来源：cems + 官方活动水平）
 *   · 实际上网电量 —— 河北省发改委《垃圾发电厂2024年垃圾处理量及上网电量情况统计表》
 *   · 基准线 —— 由同批企业实测值算出，不是外部指定的常数
 *
 * 由此产生的效果是**真实的市场结构**：单位电耗碳高的企业配额不足（需买入），
 * 低的企业有盈余（可卖出）。这不是我编的剧本，是四个真实强度算出来的结果。
 *
 * 用法：
 *   node tools/allocate-derived.cjs --year 2024 --dry
 *   node tools/allocate-derived.cjs --year 2024
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const cu = require(path.join(__dirname, '..', 'server', 'blockchain', 'crypto-utils'));
const anchorSvc = require(path.join(__dirname, '..', 'server', 'services', 'anchor'));
const derive = require(path.join(__dirname, '..', 'server', 'services', 'derive'));

const argv = process.argv.slice(2);
const YEAR = (() => {
  const i = argv.indexOf('--year');
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 2024;
})();
const DRY = argv.includes('--dry');

const P = (s = '') => console.log(s);
const R = (x, n = 2) => Number(Number(x).toFixed(n));

/* 上网电量只能取官方统计年度的实测值。没有该年度官方电量就不能分配 ——
 * 用外推电量去分配配额，等于用两个假设叠乘，误差不可控。 */
async function officialGridByEnt(year) {
  const acts = await db.query('SELECT * FROM enterprise_activity WHERE year = ?', [year]);
  if (!acts.length) return null;
  const ents = await db.query("SELECT id, ent_name FROM enterprise WHERE industry='垃圾焚烧发电' ORDER BY id");
  const out = new Map();
  for (const e of ents) {
    const key = derive.normalizeName(e.ent_name);
    const mine = acts.filter((a) => {
      const n = derive.normalizeName(a.ent_name);
      return n === key || n.startsWith(key) || key.startsWith(n);
    });
    if (!mine.length) continue;
    out.set(e.id, {
      entName: e.ent_name,
      grid10kKwh: mine.reduce((s, x) => s + Number(x.grid_kwh_10k), 0),
      msw10kt: mine.reduce((s, x) => s + Number(x.msw_10kt), 0),
      sourceIds: mine.map((x) => x.id),
      sourceLabel: mine[0].source,
    });
  }
  return out.size ? out : null;
}

(async () => {
  P('════════════════════════════════════════════════════════════════════════');
  P(`配额分配（行业基准线法）  ${YEAR} 年度  ${DRY ? '【试算，不落库】' : ''}`);
  P('════════════════════════════════════════════════════════════════════════');

  /* ---- 已核查排放量 ---- */
  const verified = await db.query(
    `SELECT r.ent_id, e.ent_name, SUM(r.total_emission) AS emission, COUNT(*) AS reports
       FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
      WHERE r.year = ? AND r.status = 'VERIFIED'
      GROUP BY r.ent_id, e.ent_name ORDER BY r.ent_id`, [YEAR]
  );
  if (!verified.length) {
    P(`✘ ${YEAR} 年度没有已核查（VERIFIED）的上报单，无法分配配额`);
    P('  请先运行 tools/derive-business.cjs --commit 并完成核查');
    await db.pool.end();
    process.exit(1);
  }

  const grid = await officialGridByEnt(YEAR);
  if (!grid) {
    P(`✘ ${YEAR} 年度缺少官方上网电量统计，无法按基准线法分配`);
    P('  理由：配额必须以"单位电量碳强度"为基准，没有官方电量就只能用外推电量，');
    P('        那是两个假设相乘，误差不可控。宁可空着，也不填一个编的数。');
    await db.pool.end();
    process.exit(1);
  }

  /* ---- 基准线 ---- */
  let sumE = 0;
  let sumG = 0;
  const items = [];
  for (const v of verified) {
    const g = grid.get(Number(v.ent_id));
    if (!g || !(g.grid10kKwh > 0)) {
      P(`  ⚠ ent${v.ent_id} ${v.ent_name} 缺官方上网电量，跳过（不参与基准线）`);
      continue;
    }
    const e = Number(v.emission);
    const MWh = g.grid10kKwh * 10; // 万kWh → MWh
    sumE += e; sumG += MWh;
    items.push({ ...v, emission: e, grid10kKwh: g.grid10kKwh, MWh, gridSrc: g.sourceIds, gridLabel: g.sourceLabel, msw10kt: g.msw10kt });
  }
  if (!items.length) { P('✘ 无可参与计算的样本'); await db.pool.end(); process.exit(1); }

  const benchmark = sumE / sumG; // tCO2/MWh
  P(`\n  基准线强度 = 核查排放量合计 ${R(sumE, 2)} t ÷ 实际上网电量合计 ${R(sumG, 0)} MWh`);
  P(`             = ${benchmark.toFixed(6)} tCO₂/MWh  (${(benchmark * 10).toFixed(4)} tCO₂/万kWh)`);
  P(`  依据：同批 ${items.length} 家垃圾焚烧发电企业实测强度加权平均，非外部指定常数\n`);

  /* ---- 逐企业配额 ---- */
  P('  ┌' + '─'.repeat(96) + '┐');
  P('  │ 企业                                 核查排放(t)   上网(MWh)   实测强度      配额(t)      缺口/盈余(t) │');
  P('  ├' + '─'.repeat(96) + '┤');
  const plans = [];
  for (const it of items) {
    const quota = R(benchmark * it.MWh, 2);
    const gap = R(it.emission - quota, 2); // >0 = 缺口（需买入）
    const intensity = it.emission / it.MWh;
    plans.push({ ...it, quota, gap, intensity });
    const nm = it.ent_name.padEnd(30).slice(0, 30);
    P(`  │ ${nm} ${String(R(it.emission, 0)).padStart(10)}  ${String(R(it.MWh, 0)).padStart(10)}  `
      + `${intensity.toFixed(4).padStart(9)}  ${String(quota).padStart(11)}  ${String(gap).padStart(13)} │`);
  }
  P('  └' + '─'.repeat(96) + '┘');
  const totalQuota = plans.reduce((s, x) => s + x.quota, 0);
  const totalGap = plans.reduce((s, x) => s + x.gap, 0);
  P(`\n  配额合计 ${R(totalQuota, 2)} t，核查排放合计 ${R(sumE, 2)} t，缺口净额 ${R(totalGap, 2)} t`);
  P(`  恒等式校验：配额合计 + 缺口净额 = ${R(totalQuota + totalGap, 2)} t = 核查排放合计 ${R(sumE, 2)} t `
    + `${Math.abs(totalQuota + totalGap - sumE) < 0.05 ? '✔' : '✘'}`);

  if (DRY) {
    P('\n  试算结束（未写库）。去掉 --dry 执行实际分配。');
    await db.pool.end();
    return;
  }

  /* ---- 落库 + 上链 ---- */
  P('\n════ 写入分配记录并上链 ════');
  const regulator = await db.one(
    "SELECT id, username, real_name FROM sys_user WHERE role='REGULATOR' AND post='REG_CLERK' LIMIT 1"
  );
  const approver = await db.one(
    "SELECT id, username, real_name FROM sys_user WHERE role='REGULATOR' AND post='REG_REVIEWER' LIMIT 1"
  );

  for (const p of plans) {
    const exist = await db.one(
      'SELECT id FROM quota_allocation WHERE ent_id=? AND year=?', [p.ent_id, YEAR]
    );
    if (exist) { P(`  ─ ent${p.ent_id} ${YEAR} 年已有分配记录 #${exist.id}，跳过`); continue; }

    const allocNo = cu.bizNo('QA');
    const [ins] = await db.pool.query(
      `INSERT INTO quota_allocation
        (alloc_no, ent_id, year, quota_amount, alloc_type, alloc_method, baseline_intensity,
         operator, proposed_by, approved_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
      [allocNo, p.ent_id, YEAR, p.quota, 'FREE', '行业基准线法', R(benchmark * 10, 4),
        approver ? approver.real_name : 'regulator', regulator ? regulator.id : null,
        approver ? approver.id : null]
    );
    const allocId = ins.insertId;

    await db.query(
      `INSERT INTO carbon_quota (ent_id, year, total_allocated, available, frozen, used, bought, sold, updated_at)
       VALUES (?,?,?,?,0,0,0,0,NOW())
       ON DUPLICATE KEY UPDATE total_allocated = total_allocated + VALUES(total_allocated),
                               available = available + VALUES(available)`,
      [p.ent_id, YEAR, p.quota, p.quota]
    );

    const ent = await db.one('SELECT ent_name FROM enterprise WHERE id=?', [p.ent_id]);
    const chain = await anchorSvc.anchor({
      txType: 'QUOTA_ALLOCATION',
      bizNo: allocNo,
      fromLabel: 'regulator',
      payload: {
        allocNo, entId: p.ent_id, entName: ent.ent_name, year: YEAR,
        quotaAmount: p.quota, allocType: 'FREE', allocMethod: '行业基准线法',
        benchmarkIntensity: R(benchmark * 10, 4),
        /* 分配依据必须一并上链：否则事后只能看到"分了这么多"，看不到"为什么" */
        basis: {
          method: 'BENCHMARK_FROM_VERIFIED_INTENSITY',
          verifiedEmission: R(p.emission, 2),
          gridMWh: R(p.MWh, 0),
          measuredIntensity: R(p.intensity, 6),
          gap: p.gap,
          benchmarkSource: `同批 ${items.length} 家企业核查排放量 ÷ 实际上网电量`,
          gridSource: `enterprise_activity#${p.gridSrc.join(',')}（${p.gridLabel}）`,
          verificationBasis: `${YEAR} 年 ${p.reports} 张已核查上报单`,
        },
      },
    });
    await db.query('UPDATE quota_allocation SET chain_block_index=?, chain_tx_id=? WHERE id=?',
      [chain.blockIndex, chain.txId, allocId]);

    /* 血缘：配额是 MODELED（含基准线这一政策假设），不是实测 */
    await derive.trace({
      targetTable: 'quota_allocation', targetId: allocId, targetLabel: `${ent.ent_name} ${YEAR} 配额`,
      sourceKind: 'DERIVATION',
      sourceRef: `emission_report[ent=${p.ent_id},year=${YEAR},VERIFIED] + enterprise_activity#${p.gridSrc.join(',')}`,
      sourceDetail: {
        verifiedEmission: R(p.emission, 2), gridMWh: R(p.MWh, 0),
        measuredIntensity: R(p.intensity, 6), benchmarkIntensity: R(benchmark, 6),
        quota: p.quota, gap: p.gap,
      },
      ruleCode: 'BENCHMARK_ALLOCATION',
      ruleExpr: `配额 = 基准线强度(${benchmark.toFixed(6)} tCO₂/MWh) × 实际上网电量(${R(p.MWh, 0)} MWh)`,
      layer: 'MODELED', confidence: 'MEDIUM',
      limitation: '配额是政策分配结果，不是排放实测值。基准线由同批企业实测强度加权得出；'
        + '若纳入更多企业或改用其他基准线（历史法/先进值法），分配额会随之变化。'
        + '「缺口/盈余」反映的是本基准线下的相对效率，不等于绝对减排义务。',
      reviewHint: `核查应验算：①${R(p.emission, 2)} t 是否等于该企业 ${YEAR} 年已核查上报量之和；`
        + `②${R(p.MWh, 0)} MWh 是否与省发改委统计表一致；③两者相除是否等于实测强度`,
      chainTxId: chain.txId,
    });

    P(`  ✔ ent${p.ent_id} ${ent.ent_name.slice(0, 16)}：配额 ${p.quota} t`
      + `（${p.gap > 0 ? '缺口 ' + p.gap + ' t' : '盈余 ' + Math.abs(p.gap) + ' t'}）`
      + ` 已上链 #${chain.blockIndex}`);
  }

  P('\n  ✔ 分配完成');
  await db.pool.end();
})().catch((e) => { console.error('\n✘', e.message); console.error(e.stack); process.exit(1); });
