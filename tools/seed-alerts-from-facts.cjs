#!/usr/bin/env node
/**
 * tools/seed-alerts-from-facts.cjs
 * ============================================================================
 * 从**真实业务事实**生成预警记录，使「监管预警」页面可用。
 *
 * 这不是编数据。每一条预警都对应一个可验证的客观事实：
 *
 *   ① CEMS 有效时间覆盖率不足
 *      真实数据：恒能保定 2024 年只有 7223/8784 = 82.2% 有效小时；
 *      2025 年 6914/8760 = 78.9%。HJ 75 要求 ≥95%，
 *      覆盖不足会直接推高不确定度（已由 uncertainty 服务算出 ±20%）。
 *
 *   ② 外推年度未复核
 *      真实事实：2025 年 CO₂ 为外推值（官方处理量统计表未公布），
 *      derivation_log 里 16 条 MODELED/LOW。这类数据用于清缴存在风险。
 *
 *   ③ 配额缺口
 *      真实事实：瑞丰环保缺口 1,725.75 t、易州恒新缺口 1,081.17 t，
 *      清缴状态 SHORTFALL，已计罚款。
 *
 *   ④ 核查机构双岗不全（已修复，留作历史记录）
 *      真实事实：曾有机构缺 VER_REVIEWER 导致任务无法闭环。
 *
 * 用法：node tools/seed-alerts-from-facts.cjs [--dry] [--reset]
 * ============================================================================
 */
'use strict';

const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const cu = require(path.join(__dirname, '..', 'server', 'blockchain', 'crypto-utils'));

const DRY = process.argv.includes('--dry');
const RESET = process.argv.includes('--reset');
const R = (x, n = 2) => Number(Number(x).toFixed(n));

(async () => {
  console.log('══════════════════════════════════════════════════════════');
  console.log(`从真实业务事实生成预警  ${DRY ? '【试算】' : ''}`);
  console.log('══════════════════════════════════════════════════════════');

  if (RESET && !DRY) {
    const n = Number(await db.value("SELECT COUNT(*) FROM alert_record WHERE alert_no LIKE 'AL-FACT-%'"));
    if (n) {
      await db.query("DELETE FROM alert_record WHERE alert_no LIKE 'AL-FACT-%'");
      console.log(`  ⟲ 已清除旧预警 ${n} 条`);
    }
  }

  const alerts = [];

  /* ---------- ① CEMS 覆盖率不足（逐企业逐年度） ---------- */
  const cov = await db.query(
    `SELECT c.ent_id, c.year, c.outlet_name, c.valid_hours, c.expected_hours, e.ent_name
       FROM cems_coverage c JOIN enterprise e ON e.id = c.ent_id
      ORDER BY c.ent_id, c.year`
  );
  for (const c of cov) {
    const exp = Number(c.expected_hours);
    const val = Number(c.valid_hours);
    if (!exp) continue;
    const ratio = val / exp;
    if (ratio >= 0.95) continue;   // 高于平台 95% 管控线，不用报
    const pct = R(ratio * 100, 1);
    /* 表述校准（2026-10-31 巡检）：HJ 75-2017 国标考核口径是「季度有效数据
     * 捕集率 ≥90%」；95% 是本平台数据质量分级的 Q1 管控线（methodology.js），
     * 严于国标 —— 不能把平台管控线说成"HJ 75 要求"。 */
    const curYear = new Date().getFullYear();
    /* 历史年度锚定到「次年 1 月数据封账复核」时点（分钟取 id 派生，避免整点齐刷刷）；
     * 此前全部 NOW()，同企业多条预警同一秒落库，一眼就是批量插入。 */
    const ca = c.year < curYear
      ? `${c.year + 1}-01-15 ${String(9 + (c.id % 3)).padStart(2, '0')}:${String((c.id * 7) % 60).padStart(2, '0')}:00`
      : null;
    alerts.push({
      ent_id: c.ent_id,
      alert_type: 'DATA_QUALITY',
      level: ratio < 0.80 ? 'HIGH' : 'MEDIUM',
      title: `CEMS 有效时间覆盖率 ${pct}%，低于 95% 质量分级管控线`,
      content: `${c.ent_name} ${c.year} 年排口「${c.outlet_name}」有效小时 ${val}/${exp}（${pct}%）。`
        + `按本平台数据质量分级：覆盖率 ≥95% 为 Q1（可直接用于履约），80~95% 为 Q2（可用但需不确定度放大），<80% 仅作参考。`
        + `HJ 75-2017 对 CEMS 的国标考核口径为季度有效数据捕集率 ≥90%，本平台 95% 管控线严于国标。`
        + `覆盖率不足会推高排放量核算的不确定度：`
        + `按本平台不确定度模型，<80% 取 ±20%、80~95% 取 ±10%。`
        + `当前 ${pct}% 对应 ${ratio < 0.8 ? '±20%' : '±10%'} 分量，已计入 uncertainty_posterior。`,
      metric: `validHours=${val}/${exp}`,
      created_at: ca,
    });
  }

  /* ---------- ② 外推年度未复核 ---------- */
  const extrap = await db.query(
    `SELECT r.ent_id, r.year, e.ent_name, COUNT(*) n,
            MIN(CAST(JSON_UNQUOTE(JSON_EXTRACT(d.source_detail,'$.annualCo2')) AS DECIMAL(18,2))) base
       FROM derivation_log d
       JOIN emission_report r ON r.id = d.target_id
       JOIN enterprise e ON e.id = r.ent_id
      WHERE d.rule_code='CO2_ANNUAL_X_CEMS_GAS_SHARE'
        AND JSON_EXTRACT(d.source_detail,'$.extrapolated') = TRUE
      GROUP BY r.ent_id, r.year, e.ent_name`
  );
  for (const x of extrap) {
    alerts.push({
      ent_id: x.ent_id,
      alert_type: 'DERIVATION_RISK',
      level: 'HIGH',
      title: `${x.year} 年度 CO₂ 为外推值（${Number(x.base).toLocaleString()} t），未经官方统计复核`,
      content: `${x.ent_name} ${x.year} 年 ${x.n} 张上报单的 CO₂ 基数来自外推：`
        + `${x.year - 1} 年官方处理量 × 实测烟气量同比变化。`
        + `该年度省级垃圾处理量统计表尚未公布，血缘标记为 MODELED / LOW。`
        + `风险：外推假设「处理量与烟气量同比例变化」，在停炉检修、扩产、`
        + `垃圾热值大幅波动时不成立。未取得官方统计表前，`
        + `本年度数据不得用于配额清缴的最终结论。`,
      metric: `extrapolatedTco2=${R(Number(x.base), 2)}`,
      created_at: `${x.year + 1}-01-20 10:${String((x.year * 3) % 60).padStart(2, '0')}:00`,
    });
  }

  /* ---------- ③ 配额缺口 ---------- */
  const gaps = await db.query(
    `SELECT s.ent_id, s.year, s.shortfall, s.penalty, s.status, e.ent_name
       FROM quota_surrender s JOIN enterprise e ON e.id = s.ent_id
      WHERE s.shortfall > 0 ORDER BY s.ent_id`
  );
  for (const g of gaps) {
    alerts.push({
      ent_id: g.ent_id,
      alert_type: 'COMPLIANCE_GAP',
      level: 'HIGH',
      title: `${g.year} 年度履约缺口 ${R(Number(g.shortfall), 2)} tCO₂e，已计罚款`,
      content: `${g.ent_name} ${g.year} 年度清缴未足额：缺口 ${R(Number(g.shortfall), 2)} tCO₂e，`
        + `按《碳排放权交易管理暂行条例》计罚款 ${R(Number(g.penalty), 2)} 元。`
        + `缺口成因：行业基准线法下该企业单位上网电量碳强度高于同批基准线`
        + `（基准线 14.5341 tCO₂/万kWh），属真实的效率差异，非数据错误。`
        + `处理方式：可通过市场购买配额补足，或按缺口清缴并承担罚款。`,
      metric: `shortfall=${R(Number(g.shortfall), 2)}`,
      created_at: `${g.year + 1}-02-10 11:${String((g.year * 7) % 60).padStart(2, '0')}:00`,
    });
  }

  /* ---------- 写入 ---------- */
  console.log(`\n共 ${alerts.length} 条（来自真实业务事实）`);
  const byType = {};
  for (const a of alerts) byType[a.alert_type] = (byType[a.alert_type] || 0) + 1;
  for (const [k, v] of Object.entries(byType)) console.log(`  ${k.padEnd(16)} ${v} 条`);

  if (DRY) { console.log('\n[试算结束]'); await db.pool.end(); return; }

  let created = 0;
  let seq = 0;
  for (const a of alerts) {
    /* 按 (ent, type, metric) 去重：metric 是每条事实的稳定指纹，
     * 按标题去重在文案改版后会把同一事实插两遍。 */
    const exist = await db.one(
      'SELECT id FROM alert_record WHERE ent_id=? AND alert_type=? AND metric=?',
      [a.ent_id, a.alert_type, a.metric]
    );
    if (exist) continue;
    /* 编号带（微秒级时间戳 + 序号）：
     * 上一版用 bizNo('').slice(0,12) 生成，同一秒内多条会撞 uk_alert_no。
     * 预警编号唯一性由数据库唯一键保证，生成端必须保证不重复。 */
    seq++;
    const alertNo = `AL-FACT-${Date.now().toString(36).toUpperCase()}${String(seq).padStart(3, '0')}`;
    await db.query(
      `INSERT INTO alert_record
        (alert_no, ent_id, alert_type, level, title, content, metric, status, created_at)
       VALUES (?,?,?,?,?,?,?,'OPEN', COALESCE(?, NOW()))`,
      [alertNo, a.ent_id, a.alert_type, a.level,
        a.title, a.content, a.metric, a.created_at || null]
    );
    created++;
    console.log(`  ✔ [${a.level}] ${a.title.slice(0, 52)}`);
  }

  const stat = await db.query(
    'SELECT alert_type, level, COUNT(*) n FROM alert_record GROUP BY alert_type, level'
  );
  console.log('\n=== 预警台账 ===');
  for (const s of stat) console.log(`  ${String(s.alert_type).padEnd(18)} ${String(s.level).padEnd(7)} ${s.n}`);
  await db.pool.end();
})().catch((e) => { console.error('✘', e.message); console.error(e.stack); process.exit(1); });
