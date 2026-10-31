#!/usr/bin/env node
/**
 * tools/calc-activity-emission.mjs —— 活动水平法排放核算（可复算、可上链）
 * ==================================================================
 * 为什么用活动水平法，而不是 CEMS 直接法：
 *   本数据包只有「污染物浓度 mg/m³」，没有「烟气流量 m³/h」，
 *   浓度×流量=排放量 这条路走不通。但活动水平法输入齐全：
 *     入炉垃圾量 MSW（省发改委官方统计）
 *     × 矿物碳排放因子 0.390 tCO₂/t（DB11/T 1416—2017 附录A，企业核算口径资料原文）
 *     × 碳氧化率 OF = 95%（同文件）
 *
 * 严格守住的口径：
 *   · 生物碳因子 0.623 tCO₂/t 只作信息项，**不计入排放总量**（与各企业核算资料一致）；
 *   · 因子与氧化率逐条写入 evidence，任何人都能拿着两个数把结果重算一遍；
 *   · 一期/二期按统计表原行分别入库，企业层面合计再汇总 —— 不合并、不四舍五入凑数。
 *
 * 用法：
 *   node tools/calc-activity-emission.mjs --dir "D:/.../信件" --dry-run
 *   node tools/calc-activity-emission.mjs --dir "D:/.../信件"
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cfg = require('../server/config');

const ARGV = process.argv.slice(2);
const argOf = (k, d) => {
  const i = ARGV.indexOf('--' + k);
  if (i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) return ARGV[i + 1];
  const eq = ARGV.find((a) => a.startsWith(`--${k}=`));
  return eq ? eq.slice(k.length + 3) : d;
};
const DIR = argOf('dir', '');
const DRY = ARGV.includes('--dry-run');
const YEAR = Number(argOf('year', 2024));

/* 因子（逐字取自各企业《碳排放核算口径资料》第七节） */
const FACTOR_FOSSIL = 0.390;   // tCO2/t 入炉垃圾（矿物碳，计入总量）
const FACTOR_BIOGENIC = 0.623; // tCO2/t（生物碳，信息项）
const OXIDATION = 0.95;        // 碳氧化率 OF
const FACTOR_REF = 'DB11/T 1416—2017 附录A（企业核算口径资料第七节原表）';

/* 统计表行 → 企业信用代码（一期/二期归同一法人） */
const ENT_MAP = {
  '河北恒能（保定）环保能源有限公司': '91130605MA0H2K7L3R',
  '保定瑞丰环保电力有限公司': '91130607MA0N8T5Q2W',
  '保定易州恒新环保电力有限公司': '91130633MA0P4R9S6Y',
  '河北恒能（涞水）环保能源有限公司': '91130623MA0L6V8X4Z',
};

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((l) => {
    const v = l.split(',');
    const o = {};
    head.forEach((h, i) => (o[h] = (v[i] || '').trim()));
    return o;
  });
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  活动水平法排放核算（${YEAR} 年度 · 官方统计口径）`);
  console.log('══════════════════════════════════════════════════════════\n');

  if (!DIR) { console.error('✘ 缺少 --dir'); process.exit(2); }
  const files = walk(DIR).filter((f) => f.includes('活动水平_河北省发改委统计') && f.endsWith('.csv'));
  console.log(`  找到活动水平文件 ${files.length} 份\n`);

  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  try {
    const byEnt = new Map();
    for (const f of files) {
      for (const r of parseCsv(fs.readFileSync(f, 'utf8'))) {
        const rawName = r['项目名称'] || '';
        if (!rawName) continue;
        /* 一期/二期 → 母公司；匹配时用「去掉 一期/二期 后缀」的名字 */
        const baseName = rawName.replace(/(一期|二期|三期)$/, '');
        const code = ENT_MAP[baseName] || ENT_MAP[rawName];
        if (!code) { console.log(`  ⚠ 未登记企业，跳过：${rawName}`); continue; }
        const msw = Number(r['年垃圾处理量(万吨)']);
        const cap = Number(r['发电机组容量(MW)']);
        const grid = Number(r['年实际上网电量(万kWh)']);
        const wasteKwh = Number(r['年垃圾发电上网电量(万kWh)']);
        if (!Number.isFinite(msw) || msw <= 0) {
          console.log(`  ⚠ ${rawName}：处理量缺失/无效，跳过（不估值）`);
          continue;
        }
        if (!byEnt.has(code)) byEnt.set(code, { code, rows: [] });
        byEnt.get(code).rows.push({
          entName: rawName, capacityMw: cap, msw10kt: msw,
          grid10k: grid, wasteKwh10k: wasteKwh,
          source: r['数据来源'], provenance: 'REAL_OFFICIAL',
        });
        console.log(`  ${rawName}: ${msw} 万吨/${YEAR}（装机 ${cap} MW）`);
      }
    }

    console.log('');
    const results = [];
    for (const [code, ent] of byEnt) {
      const [ents] = await conn.query('SELECT id, ent_name FROM enterprise WHERE ent_code = ?', [code]);
      if (!ents.length) { console.log(`  ⚠ 信用代码 ${code} 未备案，跳过`); continue; }
      const entId = ents[0].id;
      let mswTotal = 0;

      for (const r of ent.rows) {
        mswTotal += r.msw10kt;
        if (DRY) continue;
        await conn.query(
          `INSERT INTO enterprise_activity
            (ent_code, ent_name, year, capacity_mw, msw_10kt, grid_kwh_10k, waste_kwh_10k, source, provenance)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             capacity_mw=VALUES(capacity_mw), msw_10kt=VALUES(msw_10kt),
             grid_kwh_10k=VALUES(grid_kwh_10k), waste_kwh_10k=VALUES(waste_kwh_10k),
             source=VALUES(source), provenance=VALUES(provenance)`,
          [code, r.entName, YEAR, r.capacityMw, r.msw10kt, r.grid10k, r.wasteKwh10k, r.source, r.provenance]
        );
      }

      /* 核算：E = MSW(t) × 因子 × 是否再乘 OF
       * 注意：附录A 的 0.390 已是「含 OF=95% 的成品因子」（逐组分重算可得，
       * 见 2026-10-28 验证脚本），再乘一次 OF 会重复扣减。这里只用 0.390。 */
      const mswT = mswTotal * 10000;
      const totalTco2 = mswT * FACTOR_FOSSIL;
      const biogenicTco2 = mswT * FACTOR_BIOGENIC;
      const evidence = `E = MSW ${mswTotal} 万吨 × ${FACTOR_FOSSIL} tCO₂/t = ${(totalTco2 / 10000).toFixed(2)} 万 tCO₂；`
        + `因子取自 ${FACTOR_REF}（已含 OF=${OXIDATION}）；生物碳 ${FACTOR_BIOGENIC} tCO₂/t 为信息项，不计入总量。`;

      console.log(`  ● ${ents[0].ent_name}`);
      console.log(`      处理量 ${mswTotal.toFixed(2)} 万吨 → 矿物碳 ${(totalTco2 / 10000).toFixed(2)} 万 tCO₂`
        + `（生物碳信息项 ${(biogenicTco2 / 10000).toFixed(2)} 万 tCO₂）`);

      if (!DRY) {
        await conn.query(
          `INSERT INTO emission_calc
            (ent_code, ent_name, year, method, msw_t, factor_tco2_t, oxidation, total_tco2, biogenic_tco2, factor_ref, evidence, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,'CALCULATED')
           ON DUPLICATE KEY UPDATE
             msw_t=VALUES(msw_t), factor_tco2_t=VALUES(factor_tco2_t), oxidation=VALUES(oxidation),
             total_tco2=VALUES(total_tco2), biogenic_tco2=VALUES(biogenic_tco2),
             factor_ref=VALUES(factor_ref), evidence=VALUES(evidence), status='CALCULATED'`,
          [code, ents[0].ent_name, YEAR, 'ACTIVITY_MAIN', mswT, FACTOR_FOSSIL, OXIDATION,
            totalTco2, biogenicTco2, FACTOR_REF, evidence]
        );
      }
      results.push({ code, name: ents[0].ent_name, msw10kt: mswTotal, totalTco2 });
    }

    console.log('');
    const sum = results.reduce((a, r) => a + r.totalTco2, 0);
    console.log(`  合计（4 家）：${(sum / 10000).toFixed(2)} 万 tCO₂`);
    console.log(DRY ? '\n⊘ 预演模式：未写库' : '\n✔ 已写入 enterprise_activity 与 emission_calc');
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('核算失败：', e.message); process.exit(1); });
