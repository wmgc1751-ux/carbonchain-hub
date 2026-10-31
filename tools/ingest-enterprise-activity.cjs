#!/usr/bin/env node
/**
 * tools/ingest-enterprise-activity.cjs —— 用官方公开数据补齐 enterprise_activity
 * ==================================================================
 * 数据来源（唯一）：
 *   河北省发改委《河北省生活垃圾焚烧发电项目 2024 年垃圾处理量及上网电量》
 *   全省 78 家明细表，落在 信件/00-方案研究/数据包/
 *   河北垃圾发电厂2024年垃圾处理量及上网电量_全省78家.csv
 *
 * 为什么需要这张表：
 *   services/derive.js 的 computeCoverage() 只从 enterprise_activity 取官方处理量，
 *   表为空时覆盖比例只能记为 NULL（"未知"），无法判定 CEMS 单排口覆盖全厂的多少。
 *   补齐后覆盖判定才有分母。
 *
 * 口径处理（重要，不合并会算错）：
 *   官方表里「河北恒能（保定）环保能源有限公司一期 / 二期」是同一主体下两套机组，
 *   而库内 enterprise 是一家。按主体合并求和（43.46 + 35.70 = 79.16 万吨），
 *   该值与 cems_coverage.official_msw_10kt（79.16）交叉吻合，可作为合并口径的验证。
 *
 * 幂等：按 (ent_code, year) 上 upsert。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cfg = require('../server/config');

const DRY = process.argv.includes('--dry-run');
const CSV = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(
  __dirname, '..', '..', '信件', '00-方案研究', '数据包',
  '河北垃圾发电厂2024年垃圾处理量及上网电量_全省78家.csv'
);
const YEAR = 2024;
const SOURCE = '河北省发展和改革委员会《河北省生活垃圾焚烧发电项目上网电价补贴》公示明细（2024 年度，全省 78 家）';

/** 官方表中的名称 → 库内 enterprise.ent_code。只映射本届数据包内的 4 家真实企业。 */
const NAME_TO_CODE = {
  '河北恒能（保定）环保能源有限公司一期': '91130605MA0H2K7L3R',
  '河北恒能（保定）环保能源有限公司二期': '91130605MA0H2K7L3R',
  '保定瑞丰环保电力有限公司': '91130607MA0N8T5Q2W',
  '保定易州恒新环保电力有限公司': '91130633MA0P4R9S6Y',
  '河北恒能（涞水）环保能源有限公司': '91130623MA0L6V8X4Z',
};

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    /* 备注列可能含逗号，只切前 7 段，余下并入备注 */
    const parts = l.split(',');
    const row = {};
    head.forEach((h, i) => { row[h.trim()] = (i < head.length - 1 ? parts[i] : parts.slice(i).join(',')) || ''; });
    return row;
  });
}

(async () => {
  if (!fs.existsSync(CSV)) { console.error('CSV 不存在：' + CSV); process.exit(1); }
  const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
  console.log(`官方明细 ${rows.length} 行；按主体合并…${DRY ? '（dry-run）' : ''}\n`);

  const agg = new Map();
  for (const r of rows) {
    const name = (r['项目名称'] || '').trim();
    const code = NAME_TO_CODE[name];
    if (!code) continue;
    const cur = agg.get(code) || {
      code, names: [], capacity_mw: 0, msw_10kt: 0, grid_kwh_10k: 0, waste_kwh_10k: 0,
    };
    cur.names.push(name);
    cur.capacity_mw += Number(r['发电机组容量(MW)'] || 0);
    cur.msw_10kt += Number(r['年垃圾处理量(万吨)'] || 0);
    cur.grid_kwh_10k += Number(r['年实际上网电量(万kWh)'] || 0);
    cur.waste_kwh_10k += Number(r['年垃圾发电上网电量(万kWh)'] || 0);
    agg.set(code, cur);
  }

  if (!agg.size) { console.error('未匹配到任何目标企业，检查 CSV 列名或 NAME_TO_CODE'); process.exit(1); }

  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  try {
    for (const [code, a] of agg) {
      const [ent] = await conn.query('SELECT id, ent_name FROM enterprise WHERE ent_code = ?', [code]);
      if (!ent.length) { console.log(`  ⊘ ${code} 库内无此主体，跳过`); continue; }
      const entName = ent[0].ent_name;
      const note = a.names.length > 1 ? `（官方表分 ${a.names.length} 期，已按主体合并：${a.names.join(' + ')}）` : '';
      console.log(`  ${entName}${note}`);
      console.log(`    装机 ${a.capacity_mw} MW · 处理量 ${a.msw_10kt.toFixed(2)} 万t · 上网电量 ${a.grid_kwh_10k.toFixed(2)} 万kWh`);
      if (DRY) continue;
      await conn.query(
        `INSERT INTO enterprise_activity
           (ent_code, ent_name, year, capacity_mw, msw_10kt, grid_kwh_10k, waste_kwh_10k,
            source, source_url, provenance)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           ent_name=VALUES(ent_name), capacity_mw=VALUES(capacity_mw), msw_10kt=VALUES(msw_10kt),
           grid_kwh_10k=VALUES(grid_kwh_10k), waste_kwh_10k=VALUES(waste_kwh_10k),
           source=VALUES(source), source_url=VALUES(source_url), provenance=VALUES(provenance)`,
        [code, entName, YEAR,
          Number(a.capacity_mw.toFixed(2)), Number(a.msw_10kt.toFixed(4)),
          Number(a.grid_kwh_10k.toFixed(4)), Number(a.waste_kwh_10k.toFixed(4)),
          SOURCE + (note || ''), null, 'REAL_OFFICIAL']
      );
    }

    if (DRY) { console.log('\ndry-run 结束，未写库'); return; }
    const [chk] = await conn.query(
      `SELECT a.ent_code, a.ent_name, a.year, a.msw_10kt, c.official_msw_10kt, c.coverage_ratio
         FROM enterprise_activity a
         LEFT JOIN cems_coverage c ON c.ent_id = (SELECT id FROM enterprise WHERE ent_code = a.ent_code) AND c.year = a.year`
    );
    console.log('\n补入结果（与 cems_coverage 交叉核对）：');
    for (const r of chk) {
      console.log(`  ${String(r.ent_name).slice(0, 18).padEnd(20)} ${r.year} 处理量 ${r.msw_10kt} 万t · 覆盖率表 ${r.official_msw_10kt ?? '—'}`);
    }
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
