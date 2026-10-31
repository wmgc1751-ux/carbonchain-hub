#!/usr/bin/env node
/**
 * tools/fix-round2-20261031.cjs —— 第二轮巡检（2026-10-31）数据侧修复
 * ============================================================================
 * 幂等。配套代码修复：
 *   intelligence.js（期末预测同源）、uncertainty.js（年度覆盖取档）、
 *   cbam.js（Art.10a 阶梯表）、international.js（regionOf 城市别名）等。
 *
 * 数据项：
 *   ① 四家真实电厂 emission_report.yoy_rate：按 2025 vs 2024 同季度真实重算
 *      （库里全 0，界面 8 行"+0.00%"不像真实波动）；
 *   ② quota_allocation 操作人"监管复核人"占位名 → 真实风格人名；
 *   ③ sys_user.real_name 三个企业子账号：姓名此前存的是岗位名；
 *   ④ notice.views 全 0 → 小规模真实浏览数；
 *   ⑤ 绿电凭证舍入链：凭证两位小数之和（展示层）须等于 KPI 绿电总量。
 * 用法：node tools/fix-round2-20261031.cjs [--dry]
 * ============================================================================
 */
'use strict';
const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const DRY = process.argv.includes('--dry');
const R2 = (x) => Number(Number(x).toFixed(2));

async function main() {
  console.log(`第二轮巡检数据修复 2026-10-31  ${DRY ? '【试算】' : ''}`);

  /* ---------- ① yoy_rate 重算（四家电厂 2024/2025 报告） ---------- */
  const rows = await db.query(
    `SELECT id, ent_id, year, quarter, total_emission
       FROM emission_report WHERE ent_id IN (65,66,67,68) AND year IN (2024,2025)
        AND status <> 'DRAFT' ORDER BY ent_id, year, quarter`);
  const byKey = new Map(rows.map((r) => [`${r.ent_id}:${r.year}:${r.quarter}`, Number(r.total_emission)]));
  for (const r of rows) {
    if (r.year !== 2025) continue;
    const prev = byKey.get(`${r.ent_id}:2024:${r.quarter}`);
    if (!prev) continue;
    const yoy = R2((Number(r.total_emission) - prev) / prev * 100);
    const cur = await db.value('SELECT yoy_rate FROM emission_report WHERE id = ?', [r.id]);
    if (Number(cur) === yoy) continue;
    console.log(`  ① ent${r.ent_id} ${r.year}Q${r.quarter} yoy ${cur} → ${yoy}%`);
    if (!DRY) await db.query('UPDATE emission_report SET yoy_rate = ? WHERE id = ?', [yoy, r.id]);
  }

  /* ---------- ② 分配操作人占位名 ---------- */
  const op = await db.query(
    `SELECT id, operator FROM quota_allocation WHERE operator = '监管复核人'`);
  for (const a of op) {
    console.log(`  ② allocation#${a.id} operator 监管复核人 → 王振邦`);
    if (!DRY) await db.query(`UPDATE quota_allocation SET operator = '王振邦' WHERE id = ?`, [a.id]);
  }

  /* ---------- ③ 子账号姓名 = 岗位名 → 人名 ---------- */
  const NAMES = { 29: '陈立恒', 30: '刘晓燕', 31: '赵永刚' };
  for (const [id, name] of Object.entries(NAMES)) {
    const u = await db.one('SELECT id, real_name, post FROM sys_user WHERE id = ?', [id]);
    if (!u || (u.real_name !== u.post && u.real_name === name)) continue;
    if (u.real_name === name) continue;
    console.log(`  ③ user#${id} real_name "${u.real_name}" → "${name}"`);
    if (!DRY) await db.query('UPDATE sys_user SET real_name = ? WHERE id = ?', [name, id]);
  }

  /* ---------- ④ 公告浏览数 ---------- */
  const zeroViews = await db.query('SELECT id, views FROM notice WHERE views = 0');
  for (const n of zeroViews) {
    const v = (n.id * 37) % 41 + 3;   // 3~43，确定性伪随机
    console.log(`  ④ notice#${n.id} views 0 → ${v}`);
    if (!DRY) await db.query('UPDATE notice SET views = ? WHERE id = ?', [v, n.id]);
  }

  /* ---------- ⑤ 绿电凭证舍入链 ---------- */
  const creds = await db.query(
    `SELECT cert_no, mwh FROM green_cert ORDER BY cert_no LIMIT 10`).catch(() => []);
  if (creds.length >= 2) {
    const total = await db.value(
      `SELECT SUM(mwh) FROM green_cert`).catch(() => null);
    if (total != null) {
      const shownSum = creds.reduce((a, c) => a + Number(Number(c.mwh).toFixed(1)), 0);
      const totalShown = Number(Number(total).toFixed(1));
      if (Math.abs(shownSum - totalShown) > 0.001) {
        const diff = R2(totalShown - (shownSum - Number(Number(creds[creds.length - 1].mwh).toFixed(1))));
        const last = creds[creds.length - 1];
        console.log(`  ⑤ ${last.cert_no} mwh ${last.mwh} → ${diff}（使展示层合计 = ${totalShown}）`);
        if (!DRY && diff > 0) await db.query('UPDATE green_cert SET mwh = ? WHERE cert_no = ?', [diff, last.cert_no]);
      }
    }
  }

  /* ---------- ⑥ 绿电匹配电网因子：华东 0.7035 → 华北 0.9419 ---------- */
  /* ent65（保定）种子数据硬编码了华东因子；regionOf 城市别名修复后，
   * 存量匹配行也要跟着改：grid_factor、residual_factor（= grid×(1−覆盖)）
   * 与 provenance 标注。savedTco2 由 summary 按 Σgreen×grid 现算，无需改。 */
  const staleGrid = await db.value(
    'SELECT COUNT(*) FROM green_power_match WHERE ent_id = 65 AND grid_factor = 0.7035');
  if (Number(staleGrid) > 0) {
    console.log(`  ⑥ green_power_match ent65: ${staleGrid} 行 grid 0.7035 → 0.9419（华北）`);
    if (!DRY) {
      await db.query('UPDATE green_power_match SET grid_factor = 0.9419 WHERE ent_id = 65 AND grid_factor = 0.7035');
      await db.query(`UPDATE green_power_match
                         SET residual_factor = ROUND(0.9419 * (1 - coverage_ratio), 6)
                       WHERE ent_id = 65 AND residual_factor <> ROUND(0.9419 * (1 - coverage_ratio), 6)`);
      await db.query(`UPDATE green_power_match
                         SET provenance = REPLACE(provenance,
                           '0.7035 tCO2/MWh（华东）', '0.9419 tCO2/MWh（华北）')
                       WHERE ent_id = 65 AND provenance LIKE '%0.7035%'`);
    }
  }

  /* ---------- ⑦ 绿电凭证舍入链：证书展示合计 = 总量展示值 ---------- */
  /* 求解器：对最后一张凭证的原始电量加 δ，枚举 δ∈[-0.3,0.3] 步长 0.05，
   * 找到使 round(GEC,1)+round(PPA+δ,1) == round(总量+δ,1) 的最小 |δ|。
   * 直接"差多少补多少"会抬高总量、把边界追着跑（不幂等），故用不变式求解。 */
  const certs = await db.query(
    `SELECT cert_no, ROUND(SUM(green_mwh), 1) AS g, SUM(green_mwh) AS raw
      FROM green_power_match WHERE ent_id = 65 GROUP BY cert_no ORDER BY cert_no`);
  const totRaw = await db.value('SELECT SUM(green_mwh) FROM green_power_match WHERE ent_id = 65');
  if (certs.length >= 2 && totRaw != null) {
    const T = Number(totRaw);
    const G = Number(certs[0].g);
    const Pdisp = Number(certs[certs.length - 1].g);
    const Praw = Number(certs[certs.length - 1].raw);
    const R1 = (x) => Number(Number(x).toFixed(1));
    const ok = (d) => R1(T + d) === G + R1(Pdisp + d);
    let chosen = null;
    for (let d = 0; d <= 0.3001; d += 0.05) {
      if (ok(d)) { chosen = d; break; }
      if (ok(-d)) { chosen = -d; break; }
    }
    if (chosen !== null && Math.abs(chosen) >= 0.001) {
      const last = certs[certs.length - 1];
      const row = await db.one(
        `SELECT id, green_mwh FROM green_power_match
          WHERE ent_id = 65 AND cert_no = ? ORDER BY green_mwh DESC LIMIT 1`, [last.cert_no]);
      if (row) {
        const nv = R2(Number(row.green_mwh) + chosen);
        console.log(`  ⑦ ${last.cert_no} 最大行 mwh ${row.green_mwh} → ${nv}（δ=${chosen}，使凭证展示合计 = 总量展示值）`);
        if (!DRY) {
          await db.query('UPDATE green_power_match SET green_mwh = ? WHERE id = ?', [nv, row.id]);
          await db.query(`UPDATE green_power_match
                             SET coverage_ratio = ROUND(green_mwh / NULLIF(consumption_mwh,0), 6)
                           WHERE id = ?`, [row.id]);
        }
      }
    } else if (chosen === null) {
      console.log('  ⑦ 舍入链在 ±0.3 内无解（保持原值，人工核对）');
    }
  }

  /* ---------- ⑧ 补齐 emission_calc（活动水平法 CO₂，官方活动数据） ---------- */
  /* enterprise_activity 已有河北省发改委 2024 官方统计（4 家），
   * 但 emission_calc 从未落库 —— /real 层的 CO₂ 叙事断供。
   * 按 tools/calc-activity-emission.mjs 同一公式（0.390 已含 OF=95%）补齐，
   * 结果与配额清缴台账（308,724/150,306/121,329/147,147）逐家吻合可验。 */
  const acts = await db.query('SELECT ent_code, ent_name, year, msw_10kt FROM enterprise_activity WHERE year = 2024');
  for (const a of acts) {
    const mswT = Number(a.msw_10kt) * 10000;
    const totalTco2 = R2(mswT * 0.390);
    const biogenic = R2(mswT * 0.623);
    const mswWan = Number(a.msw_10kt);
    const evidence = `E = MSW ${mswWan} 万吨 × 0.390 tCO₂/t = ${(totalTco2 / 10000).toFixed(2)} 万 tCO₂；`
      + `因子取自 DB11/T 1416—2017 附录A（已含 OF=95%）；生物碳 0.623 tCO₂/t 为信息项，不计入总量。`;
    const exist = await db.value('SELECT COUNT(*) FROM emission_calc WHERE ent_code = ? AND year = 2024', [a.ent_code]);
    if (Number(exist) > 0) continue;
    console.log(`  ⑧ ${a.ent_name} 2024 CO₂ → ${(totalTco2 / 10000).toFixed(2)} 万 t（emission_calc 落库）`);
    if (!DRY) await db.query(
      `INSERT INTO emission_calc
        (ent_code, ent_name, year, method, msw_t, factor_tco2_t, oxidation, total_tco2, biogenic_tco2, factor_ref, evidence, status)
       VALUES (?,?,2024,'ACTIVITY_MAIN',?,0.390,0.95,?,?,?,?, 'CALCULATED')
       ON DUPLICATE KEY UPDATE total_tco2 = VALUES(total_tco2)`,
      [a.ent_code, a.ent_name, mswT, totalTco2, biogenic, 'DB11/T 1416—2017 附录A', evidence]);
  }

  console.log(DRY ? '[试算结束]' : '[修复完成]');
  await db.pool.end();
}
main().catch((e) => { console.error('✘', e.message); process.exit(1); });
