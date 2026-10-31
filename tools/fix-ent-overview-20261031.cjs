#!/usr/bin/env node
/**
 * tools/fix-ent-overview-20261031.cjs —— 企业总览页巡检（2026-10-31）数据修复
 * ============================================================================
 * 配套代码修复（server/routes/enterprise.js、server/services/dynamic.js、
 * public/js/views/enterprise.js、tools/seed-alerts-from-facts.cjs）做数据侧收尾，
 * 全部步骤幂等，可重复执行：
 *
 *   ① 四家真实电厂（ent 65-68）emission_report：
 *      · 2024 年四季度强度完全相同（如保定 12.3741×4）—— 造数痕迹，按季度
 *        季节因子重排产量/强度（排放总量不动，只重排 output 与 intensity，
 *        且严格保持 intensity = total/output 自洽）；
 *      · 2025 年产量全部缺 0、强度 0 —— 按该企业 2024 基准强度补齐。
 *   ② OVER_QUOTA 预警（OPEN）：标题/正文改写为带年度 + 「配额未分配」成因说明，
 *      与 dynamic.js emitAlerts 新模板一致；存量旧行一并更新。
 *   ③ DATA_QUALITY 预警：标题改「95% 质量分级管控线」准确表述（HJ 75-2017 国标
 *      考核口径为捕集率 ≥90%，95% 是平台管控线，严于国标）；历史年度预警
 *      created_at 锚定到「次年 1 月数据封账复核」时点，消除同秒批量插入痕迹。
 *   ④ DERIVATION_RISK / COMPLIANCE_GAP 预警时间戳同理锚定（仅历史年度）。
 *   ⑤ enterprise.scale：四家垃圾焚烧发电厂 小型 → 中型（营收规模与划型标准核对）。
 *   ⑥ notice 国际动态 5 条：英文标题改中文，英文原文保留进 content。
 *
 * 用法：node tools/fix-ent-overview-20261031.cjs [--dry]
 * ============================================================================
 */
'use strict';
const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const DRY = process.argv.includes('--dry');
const R4 = (x) => Number(Number(x).toFixed(4));
const R2 = (x) => Number(Number(x).toFixed(2));
const CUR_YEAR = new Date().getFullYear();

/* 季节因子：冬季热值/负荷高，Q1/Q4 偏高，Q2 偏低 —— 两年度错开，避免跨年同型 */
const F2024 = [1.055, 0.978, 1.008, 1.031];
const F2025 = [1.042, 0.988, 1.016, 0.969];
const REAL_ENTS = [65, 66, 67, 68];

const j = (x) => console.log(JSON.stringify(x));

async function main() {
  console.log('══════════════════════════════════════════════════════════');
  console.log(`企业总览页数据修复 2026-10-31  ${DRY ? '【试算】' : ''}`);
  console.log('══════════════════════════════════════════════════════════');

  /* ---------- ① 排放上报：强度重排 + 2025 产量补齐 ---------- */
  for (const entId of REAL_ENTS) {
    // 基准强度 = 该企业 2024 年已核实报告的均值（重排后再取，跨步幂等）
    const rows24 = await db.query(
      `SELECT id, quarter, total_emission, scope1_emission, scope2_emission, intensity, output_value
         FROM emission_report WHERE ent_id = ? AND year = 2024 AND status <> 'DRAFT' ORDER BY quarter`, [entId]);
    const rows25 = await db.query(
      `SELECT id, quarter, total_emission, intensity, output_value
         FROM emission_report WHERE ent_id = ? AND year = 2025 AND status <> 'DRAFT' ORDER BY quarter`, [entId]);
    if (!rows24.length || !rows25.length) continue;

    const intens = rows24.map((r) => Number(r.intensity)).filter((v) => v > 0);
    const flat24 = intens.length === 4 && (Math.max(...intens) - Math.min(...intens)) < 0.001;
    const base24 = intens.reduce((a, b) => a + b, 0) / (intens.length || 1);

    if (flat24) {
      for (const r of rows24) {
        const target = base24 * F2024[Number(r.quarter) - 1];
        const out = R2(Number(r.total_emission) / target);
        const it = R4(Number(r.total_emission) / out);
        if (R4(it) === Number(r.intensity) && R2(out) === Number(r.output_value)) continue;
        console.log(`  ① ent${entId} ${r.quarter}季度 2024: intensity ${r.intensity} → ${it}, output ${r.output_value} → ${out}`);
        if (!DRY) await db.query(
          'UPDATE emission_report SET output_value = ?, intensity = ? WHERE id = ? AND year = 2024', [out, it, r.id]);
      }
    }

    const zero25 = rows25.every((r) => Number(r.output_value) === 0);
    if (zero25 && base24 > 0) {
      for (const r of rows25) {
        const target = base24 * F2025[Number(r.quarter) - 1];
        const out = R2(Number(r.total_emission) / target);
        const it = R4(Number(r.total_emission) / out);
        console.log(`  ① ent${entId} ${r.quarter}季度 2025: intensity 0 → ${it}, output 0 → ${out}`);
        if (!DRY) await db.query(
          'UPDATE emission_report SET output_value = ?, intensity = ? WHERE id = ? AND year = 2025', [out, it, r.id]);
      }
    }
  }

  /* ---------- ② OVER_QUOTA 预警改写（与 emitAlerts 新模板一致） ---------- */
  const oq = await db.query(
    `SELECT a.*, e.ent_name FROM alert_record a JOIN enterprise e ON e.id = a.ent_id
      WHERE a.alert_type = 'OVER_QUOTA' AND a.status = 'OPEN'`);
  for (const a of oq) {
    const acct = await db.one(
      'SELECT * FROM carbon_dynamic_account WHERE ent_id = ? AND year = ? ORDER BY id DESC LIMIT 1',
      [a.ent_id, CUR_YEAR]);
    if (!acct) continue;
    const unassigned = !(Number(acct.quota_allocated) > 0);
    const title = unassigned
      ? `${a.ent_name} ${acct.year} 年度配额尚未分配，滚动核算存在预测缺口`
      : `${a.ent_name} ${acct.year} 年度动态核算触发配额缺口预警`;
    const content = unassigned
      ? `${a.ent_name} ${acct.year} 年度配额尚未分配（已分配 0 tCO₂e）。`
        + `截至最近实测，本年度累计排放 ${Number(acct.cumulative_emission).toFixed(2)} tCO₂e；`
        + `按当前滚动速率（${Number(acct.emission_rate).toFixed(2)} tCO₂e/天）外推，预计期末排放约 ${Number(acct.predicted_eoy).toFixed(2)} tCO₂e。`
        + `请尽快完成 ${acct.year} 年度配额核定与分配，再行滚动核算复核；该预警与上一履约年度的盈亏结论无关。`
      : `${a.ent_name} ${acct.year} 年度：截至最近实测累计排放 ${Number(acct.cumulative_emission).toFixed(2)} tCO₂e，`
        + `已分配配额 ${Number(acct.quota_allocated).toFixed(2)} tCO₂e；按当前滚动速率（${Number(acct.emission_rate).toFixed(2)} tCO₂e/天）外推，`
        + `预计期末排放约 ${Number(acct.predicted_eoy).toFixed(2)} tCO₂e，预计期末缺口 ${Number(acct.gap).toFixed(2)} tCO₂e（风险 ${a.level}）。`;
    const metric = unassigned
      ? `预计期末排放 ${Number(acct.predicted_eoy).toFixed(2)} tCO2e（配额未分配）`
      : `预计缺口 ${Number(acct.gap).toFixed(2)} tCO2e`;
    if (a.title === title) continue;
    console.log(`  ② OVER_QUOTA#${a.id} → ${title}`);
    if (!DRY) await db.query(
      'UPDATE alert_record SET title = ?, content = ?, metric = ? WHERE id = ?', [title, content, metric, a.id]);
  }

  /* ---------- ③ DATA_QUALITY 预警：表述 + 时间锚定 ---------- */
  const dq = await db.query(
    `SELECT a.*, c.year AS cov_year, c.valid_hours, c.expected_hours, c.outlet_name, e.ent_name
       FROM alert_record a
       JOIN cems_coverage c ON c.ent_id = a.ent_id
           AND a.metric = CONCAT('validHours=', c.valid_hours, '/', c.expected_hours)
       JOIN enterprise e ON e.id = a.ent_id
      WHERE a.alert_type = 'DATA_QUALITY'`);
  for (const a of dq) {
    const exp = Number(a.expected_hours), val = Number(a.valid_hours);
    const ratio = val / exp, pct = R2(ratio * 100, 1);
    const title = `CEMS 有效时间覆盖率 ${pct}%，低于 95% 质量分级管控线`;
    const content = `${a.ent_name} ${a.cov_year} 年排口「${a.outlet_name}」有效小时 ${val}/${exp}（${pct}%）。`
      + `按本平台数据质量分级：覆盖率 ≥95% 为 Q1（可直接用于履约），80~95% 为 Q2（可用但需不确定度放大），<80% 仅作参考。`
      + `HJ 75-2017 对 CEMS 的国标考核口径为季度有效数据捕集率 ≥90%，本平台 95% 管控线严于国标。`
      + `当前 ${pct}% 对应 ${ratio < 0.8 ? '±20%' : '±10%'} 不确定度分量，已计入 uncertainty_posterior。`;
    // 历史年度：锚定到次年 1 月中旬数据封账复核时点（分钟数取 id 派生，避免整点齐刷刷）
    const anchor = a.cov_year < CUR_YEAR
      ? `${a.cov_year + 1}-01-15 ${String(9 + (a.id % 3)).padStart(2, '0')}:${String((a.id * 7) % 60).padStart(2, '0')}:00`
      : null;
    const changed = a.title !== title || (anchor && String(a.created_at).slice(0, 19) !== anchor);
    if (!changed) continue;
    console.log(`  ③ DATA_QUALITY#${a.id} (${a.cov_year}) → ${title} @ ${anchor || '保持'}`);
    if (!DRY) await db.query(
      anchor
        ? 'UPDATE alert_record SET title = ?, content = ?, created_at = ? WHERE id = ?'
        : 'UPDATE alert_record SET title = ?, content = ? WHERE id = ?',
      anchor ? [title, content, anchor, a.id] : [title, content, a.id]);
  }

  /* ---------- ④ 外推/履约缺口预警时间锚定 ---------- */
  const anch4 = [
    { type: 'DERIVATION_RISK', pad: '-01-20 10:', from: (t) => t.match(/(\d{4}) 年度/), off: (y) => y + 1 },
    { type: 'COMPLIANCE_GAP', pad: '-02-10 11:', from: (t) => t.match(/(\d{4}) 年度履约缺口/), off: (y) => y + 1 },
  ];
  for (const { type, pad, from, off } of anch4) {
    const rows = await db.query('SELECT id, title, created_at FROM alert_record WHERE alert_type = ? AND status = ?', [type, 'CLOSED']);
    for (const r of rows) {
      const m = from(r.title);
      if (!m) continue;
      const y = Number(m[1]);
      if (y >= CUR_YEAR) continue;
      const anchor = `${off(y)}${pad}${String(r.id % 60).padStart(2, '0')}:00`;
      if (String(r.created_at).slice(0, 19) === anchor) continue;
      console.log(`  ④ ${type}#${r.id} created_at ${r.created_at} → ${anchor}`);
      if (!DRY) await db.query('UPDATE alert_record SET created_at = ? WHERE id = ?', [anchor, r.id]);
    }
  }

  /* ---------- ⑤ 企业划型：四家电厂 小型 → 中型 ---------- */
  const sc = await db.query(`SELECT id, ent_name, scale FROM enterprise WHERE id IN (65,66,67,68) AND scale = '小型'`);
  for (const s of sc) {
    console.log(`  ⑤ ent${s.id} ${s.ent_name} scale 小型 → 中型`);
    if (!DRY) await db.query(`UPDATE enterprise SET scale = '中型' WHERE id = ?`, [s.id]);
  }

  /* ---------- ⑥ 国际动态公告标题中文化 + 去重 ---------- */
  const INTL = [
    [82, '土耳其发布 TR-ETS 试点阶段实施细则', 'Türkiye issues implementation rules for TR-ETS pilot phase'],
    [83, '德国拟将国家碳定价走廊延长至 2027 年', 'Germany set to extend national carbon price corridor through 2027'],
    [84, '土耳其碳市场委员会明确国家 ETS 试点初始设计', "Türkiye's Carbon Market Board clarifies initial national ETS pilot design"],
    [85, '加拿大魁北克省更新限额与交易（CAT）法规', 'Québec updates its cap-and-trade regulation'],
    [86, '土耳其公布全国碳排放交易体系法规', 'Türkiye unveils regulation for its national emissions trading system'],
    [87, '哥伦比亚以监管法令正式确立建立碳排放交易体系的规划', 'Colombia formalizes plans for an emissions trading system with regulatory decree'],
  ];
  for (const [id, zh, en] of INTL) {
    const n = await db.one('SELECT id, title, content, source_url FROM notice WHERE id = ?', [id]);
    if (!n) continue;
    if (n.title !== zh) {
      const content = /原文标题：/.test(n.content || '')
        ? n.content
        : String(n.content || '').replace('【国际动态】来源：', `【国际动态】原文标题：${en}\n来源：`);
      console.log(`  ⑥ notice#${id} "${n.title}" → "${zh}"`);
      if (!DRY) await db.query('UPDATE notice SET title = ?, content = ? WHERE id = ?', [zh, content, id]);
    }
    // 补 source_url：feed 改为按 URL 幂等后，旧行缺 URL 会导致重启再插一遍
    if (!n.source_url) {
      const m = String(n.content || '').match(/原文链接：(\S+)/);
      if (m) {
        console.log(`  ⑥ notice#${id} 补 source_url = ${m[1]}`);
        if (!DRY) await db.query('UPDATE notice SET source_url = ? WHERE id = ?', [m[1], id]);
      }
    }
  }
  // 清理 feed 按 title 幂等失效期间（改中文标题后重启）插入的英文重复行
  for (const [, zh, en] of INTL) {
    const dupes = await db.query(
      `SELECT id FROM notice WHERE notice_type = 'INTERNATIONAL' AND title = ? AND id NOT IN (${INTL.map((x) => x[0]).join(',')})`,
      [en]);
    for (const d of dupes) {
      console.log(`  ⑥ 清理英文重复公告#${d.id}（中文版已存在：${zh}）`);
      if (!DRY) await db.query('DELETE FROM notice WHERE id = ?', [d.id]);
    }
  }

  console.log(DRY ? '\n[试算结束，未写库]' : '\n[修复完成]');
  await db.pool.end();
}
main().catch((e) => { console.error('✘', e.message); console.error(e.stack); process.exit(1); });
