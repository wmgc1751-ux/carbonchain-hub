#!/usr/bin/env node
/**
 * tools/anchor-real-data.mjs —— 把真实数据与核算结果上链存证
 * ==================================================================
 * 上链内容（全部来自真实来源，非生成）：
 *   ① CEMS_PUBLIC_BATCH  —— 8 个真实数据批次（每批的排口/条数/时间范围/内容摘要/溯源渠道）
 *   ② ACTIVITY_EMISSION  —— 4 家企业的活动水平法核算结果（含公式、因子、证据）
 *
 * payload 里只放「可被第三方独立复算」的字段：输入、口径、结果。
 * 不放「看起来漂亮」的衍生数字。
 */
import mysql from 'mysql2/promise';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cfg = require('../server/config');
const anchorSvc = require('../server/services/anchor');

(async () => {
  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  try {
    /* ---------- ① 真实数据批次上链 ---------- */
    const [batches] = await conn.query(
      `SELECT batch_no, ent_code, ent_name, outlet_name, COUNT(*) n,
              COUNT(DISTINCT pollutant_name) polls,
              MIN(reading_time) t0, MAX(reading_time) t1,
              SUM(exceed) exceed_n, SUM(is_valid) valid_n,
              COUNT(DISTINCT chain_tx_id) chained
         FROM cems_public_reading
        GROUP BY batch_no, ent_code, ent_name, outlet_name
        ORDER BY ent_name, outlet_name`
    );
    console.log(`\n真实数据批次 ${batches.length} 个\n`);
    let anchoredBatch = 0, skippedBatch = 0;
    for (const b of batches) {
      const [done] = await conn.query(
        'SELECT chain_tx_id FROM cems_public_reading WHERE batch_no = ? AND chain_tx_id IS NOT NULL LIMIT 1', [b.batch_no]
      );
      if (done.length) { skippedBatch++; console.log(`  ⊘ ${b.outlet_name}：已上链 ${done[0].chain_tx_id.slice(0, 16)}…`); continue; }

      const r = await anchorSvc.anchor({
        txType: 'CEMS_PUBLIC_BATCH',
        bizNo: b.batch_no,
        fromLabel: 'regulator:system',
        payload: {
          batchNo: b.batch_no,
          enterprise: b.ent_name,
          entCode: b.ent_code,
          outlet: b.outlet_name,
          records: b.n,
          pollutants: b.polls,
          periodFrom: b.t0,
          periodTo: b.t1,
          exceedCount: Number(b.exceed_n),
          validCount: Number(b.valid_n),
          source: '生态环境部生活垃圾焚烧发电厂自动监测数据公开平台(ljgk.envsc.cn)',
          provenance: 'REAL_PUBLIC',
          granularity: 'DAILY_AVERAGE',
          boundary: '仅污染物浓度，无烟气流量，不用于排放量核算',
        },
      });
      await conn.query('UPDATE cems_public_reading SET chain_tx_id = ? WHERE batch_no = ?', [r.txId, b.batch_no]);
      anchoredBatch++;
      console.log(`  ✔ ${String(b.outlet_name).padEnd(16)} ${String(b.n).padStart(3)}条 → 区块 #${r.blockIndex} ${r.txId.slice(0, 16)}…`);
    }

    /* ---------- ② 核算结果上链 ---------- */
    const [calcs] = await conn.query(
      `SELECT * FROM emission_calc WHERE status <> 'ANCHORED' ORDER BY ent_name`
    );
    console.log(`\n排放核算结果 ${calcs.length} 条\n`);
    let anchoredCalc = 0;
    for (const c of calcs) {
      const r = await anchorSvc.anchor({
        txType: 'ACTIVITY_EMISSION',
        bizNo: `AE-${c.year}-${c.ent_code.slice(-6)}`,
        fromLabel: 'regulator:system',
        payload: {
          enterprise: c.ent_name,
          entCode: c.ent_code,
          year: Number(c.year),
          method: c.method,
          input: { mswTonnes: Number(c.msw_t), unit: 't 入炉垃圾' },
          factor: {
            fossil: Number(c.factor_tco2_t),
            biogenic: 0.623,
            oxidation: Number(c.oxidation),
            ref: c.factor_ref,
          },
          result: {
            totalTco2: Number(c.total_tco2),
            biogenicTco2: Number(c.biogenic_tco2),
            biogenicNote: '生物碳为信息项，不计入排放总量',
          },
          evidence: c.evidence,
          reproducibility: 'E = MSW(t) × 0.390；输入与因子均可在本 payload 内重算',
          provenance: 'REAL_OFFICIAL_INPUT',
        },
      });
      await conn.query("UPDATE emission_calc SET chain_tx_id = ?, status = 'ANCHORED' WHERE id = ?", [r.txId, c.id]);
      anchoredCalc++;
      console.log(`  ✔ ${String(c.ent_name).slice(0, 14).padEnd(16)} ${(Number(c.total_tco2) / 10000).toFixed(2)} 万tCO₂ → 区块 #${r.blockIndex} ${r.txId.slice(0, 16)}…`);
    }

    console.log(`\n批次：新上链 ${anchoredBatch} / 已存在 ${skippedBatch}`);
    console.log(`核算：新上链 ${anchoredCalc}`);
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('上链失败：', e.message); console.error(e.stack.split('\n').slice(0, 5).join('\n')); process.exit(1); });
