#!/usr/bin/env node
/**
 * tools/derivation-audit.cjs —— 「仅 CEMS 输入」派生链的最终一致性审计
 * ============================================================================
 * 审计六条不变量。任一失败即非零退出，可直接接 CI。
 *
 *   I1  无血缘派生为零：每条 derived 业务单据都必须能指认真实输入
 *   I2  派生值不冒充实测：is_real 恒为 0
 *   I3  CEMS 数值可复算：上报单里的污染物 = cems_cn_hourly 同季度求和
 *   I4  分摊比闭合：各季度占比之和 = 1（否则年度合计对不上官方基数）
 *   I5  年度合计闭合：派生年度 CO₂ = 官方活动水平法核算值（容差 0.05 t）
 *   I6  账实守恒：分配 + 买入 − 卖出 − 已用 = 可用 + 冻结
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));

const P = (s = '') => console.log(s);
const line = (c = '─', n = 78) => c.repeat(n);

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) pass++; else fail++;
  P(`  ${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`);
};

(async () => {
  P(line('═', 78));
  P('「仅 CEMS 输入」派生链一致性审计');
  P(line('═', 78));

  /* ---------- I1 血缘完整性 ---------- */
  P('\n【I1】派生血缘完整性');
  const noLineage = await db.query(
    `SELECT r.id, r.report_no, r.ent_id, r.period
       FROM emission_report r
      WHERE r.data_source = 'DERIVED_FROM_CEMS'
        AND NOT EXISTS (SELECT 1 FROM derivation_log d
                         WHERE d.target_table='emission_report' AND d.target_id=r.id)`
  );
  check(noLineage.length === 0, '所有派生上报单均有血缘记录', `${noLineage.length} 张缺失`);

  const noSrc = Number(await db.value(
    "SELECT COUNT(*) FROM derivation_log WHERE source_kind IS NULL OR source_kind IN ('','NONE')"
  ));
  check(noSrc === 0, '所有血缘均有真实来源（source_kind 非空）', `${noSrc} 条缺失`);

  const totalLin = Number(await db.value('SELECT COUNT(*) FROM derivation_log'));
  const byLayer = await db.query(
    'SELECT layer, confidence, COUNT(*) n FROM derivation_log GROUP BY layer, confidence ORDER BY layer, confidence'
  );
  P(`     血缘 ${totalLin} 条：` + byLayer.map((x) => `${x.layer}/${x.confidence}=${x.n}`).join('  '));

  /* ---------- I2 真实性标记 ---------- */
  P('\n【I2】派生值不冒充实测');
  const fakeReal = Number(await db.value('SELECT COUNT(*) FROM emission_report WHERE is_real <> 0'));
  check(fakeReal === 0, 'is_real<>0 的上报单为 0', `实测 ${fakeReal}`);

  /* 本审计只审「真实派生」这条链（DERIVED_FROM_CEMS）。
   *
   * 补充主体引入后，库里多了另一类数据：DEMO_SUPPLEMENT（演示）。
   * 若仍按"所有上报单都必须标 DERIVED_FROM_CEMS"来判，会把演示数据
   * 误报为违规 —— 那是审计口径没跟上数据分层，不是数据出错。
   *
   * 正确的判据是分层的：真实派生必须可回溯（I1/I3/I4/I5 已覆盖），
   * 演示数据必须**不可回溯且已标注**，两者互不冒充。
   * 演示侧的检查见 tools/verify-supplementary.cjs 第三节。 */
  const badDataSource = Number(await db.value(
    "SELECT COUNT(*) FROM emission_report WHERE data_source NOT IN ('DERIVED_FROM_CEMS','DEMO_SUPPLEMENT')"
  ));
  check(badDataSource === 0, '上报单数据源均为已知分层（真实派生/演示）', `异常 ${badDataSource}`);

  const demoUnmarked = Number(await db.value(
    "SELECT COUNT(*) FROM emission_report WHERE data_source='DEMO_SUPPLEMENT' AND remark NOT LIKE '%演示%'"
  ));
  check(demoUnmarked === 0, '演示数据单据内均已标注', `未标注 ${demoUnmarked}`);

  const demoWithLineage = Number(await db.value(
    `SELECT COUNT(*) FROM emission_report r WHERE r.data_source='DEMO_SUPPLEMENT'
      AND EXISTS (SELECT 1 FROM derivation_log d
                   WHERE d.target_table='emission_report' AND d.target_id=r.id)`
  ));
  check(demoWithLineage === 0, '演示数据不挂血缘（与真实派生严格分离）', `误挂 ${demoWithLineage}`);

  /* ---------- I3 CEMS 数值可复算 ---------- */
  P('\n【I3】污染物数值与 CEMS 原始数据一致（抽样复算）');
  const items = await db.query(
    `SELECT i.report_id, i.energy_type, i.amount, r.ent_id, r.year, r.quarter, e.ent_name
       FROM emission_item i
       JOIN emission_report r ON r.id = i.report_id
       JOIN enterprise e ON e.id = r.ent_id
      WHERE i.calc_method = 'CEMS实测汇总'
        AND i.energy_type LIKE 'SO₂%'
      ORDER BY i.report_id LIMIT 8`
  );
  let i3ok = 0; let i3bad = [];
  for (const it of items) {
    const raw = await db.value(
      `SELECT SUM(so2_emission_kg) FROM cems_cn_hourly
        WHERE ent_name LIKE ? AND YEAR(monitored_at)=? AND QUARTER(monitored_at)=? AND is_valid=1`,
      [`${String(it.ent_name).replace(/有限(责任)?公司$/, '').slice(0, 10)}%`, it.year, it.quarter]
    );
    const expect = Number(raw || 0) / 1000; // kg → t
    const diff = Math.abs(Number(it.amount) - expect);
    if (diff < 0.01) i3ok++;
    else i3bad.push(`单#${it.report_id} 存${it.amount} 复算${expect.toFixed(4)}`);
  }
  check(i3bad.length === 0, `SO₂ 实测汇总可回溯原始小时数据`, `${i3ok}/${items.length} 吻合`
    + (i3bad.length ? ' 偏差: ' + i3bad.slice(0, 3).join('; ') : ''));

  /* ---------- I4 分摊比闭合 ---------- */
  P('\n【I4】季度分摊比闭合到 1');
  const shares = await db.query(
    `SELECT r.ent_id, r.year,
            SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(d.source_detail,'$.quarterShare')) AS DECIMAL(18,10))) sh,
            COUNT(*) n
       FROM derivation_log d JOIN emission_report r ON r.id = d.target_id
      WHERE d.rule_code = 'CO2_ANNUAL_X_CEMS_GAS_SHARE'
      GROUP BY r.ent_id, r.year ORDER BY r.ent_id, r.year`
  );
  let i4bad = 0;
  for (const s of shares) {
    const ok = Math.abs(Number(s.sh) - 1) < 1e-6;
    if (!ok) i4bad++;
    P(`     ent${s.ent_id} ${s.year}: 合计 ${Number(s.sh).toFixed(10)} (${s.n} 季) ${ok ? '✔' : '✘'}`);
  }
  check(i4bad === 0, '所有企业-年度分摊比精确闭合', `${shares.length} 组，${i4bad} 组异常`);

  /* ---------- I5 年度合计闭合 ---------- */
  P('\n【I5】派生年度合计 = 官方活动水平法核算值');
  /* 只审真实派生数据。演示数据（DEMO_SUPPLEMENT）没有官方基数可比 ——
   * 它们的量级来自行业参数，本就不该与官方统计对齐。
   * 把它们纳入比较会把 I5 变成"永远失败"的断言，等于让审计失去意义。 */
  const totals = await db.query(
    `SELECT r.ent_id, r.year, SUM(r.total_emission) s
       FROM emission_report r WHERE r.data_source = 'DERIVED_FROM_CEMS'
      GROUP BY r.ent_id, r.year ORDER BY r.ent_id, r.year`
  );
  let i5bad = 0;
  for (const t of totals) {
    const base = await db.value(
      `SELECT MIN(CAST(JSON_UNQUOTE(JSON_EXTRACT(source_detail,'$.annualCo2')) AS DECIMAL(18,2)))
         FROM derivation_log WHERE rule_code='CO2_ANNUAL_X_CEMS_GAS_SHARE'
        AND target_id IN (SELECT id FROM emission_report WHERE ent_id=? AND year=?)`,
      [t.ent_id, t.year]
    );
    const diff = Math.abs(Number(t.s) - Number(base || 0));
    const ok = diff <= 0.05;
    if (!ok) i5bad++;
    P(`     ent${t.ent_id} ${t.year}: 派生 ${Number(t.s).toFixed(2)} / 基数 ${Number(base || 0).toFixed(2)}`
      + ` 差 ${diff.toFixed(4)} ${ok ? '✔' : '✘'}`);
  }
  check(i5bad === 0, '全部年度合计与官方基数闭合（容差 0.05 t）', `${i5bad} 组超差`);

  /* ---------- I6 账实守恒 ---------- */
  P('\n【I6】配额账实守恒：分配 + 买入 − 卖出 − 已用 = 可用 + 冻结');
  const quotas = await db.query(
    `SELECT ent_id, year, total_allocated, available, frozen, used, bought, sold
       FROM carbon_quota ORDER BY ent_id, year`
  );
  let i6bad = 0;
  for (const q of quotas) {
    const lhs = Number(q.total_allocated) + Number(q.bought) - Number(q.sold) - Number(q.used);
    const rhs = Number(q.available) + Number(q.frozen);
    const ok = Math.abs(lhs - rhs) < 0.01;
    if (!ok) i6bad++;
    P(`     ent${q.ent_id} ${q.year}: ${lhs.toFixed(2)} vs ${rhs.toFixed(2)} ${ok ? '✔' : '✘'}`);
  }
  check(i6bad === 0, '配额守恒全部成立', `${quotas.length} 个账户，${i6bad} 个不平`);

  /* ---------- 汇总 ---------- */
  P('\n' + line('═', 78));
  P(`  通过 ${pass} 项，失败 ${fail} 项`);
  const chain = await db.query(
    'SELECT COUNT(*) blocks FROM chain_block WHERE 1=0'
  ).catch(() => []);
  P(line('═', 78));
  await db.pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n✘', e.message); console.error(e.stack); process.exit(1); });
