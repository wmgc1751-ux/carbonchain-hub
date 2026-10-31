#!/usr/bin/env node
/**
 * tools/anchor-cems-emission.mjs —— 真实 CEMS 排放量批次上链
 * 每个「设施+机组+月」批次上链一条，payload 只放可独立核验的字段。
 */
import mysql from 'mysql2/promise';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cfg = require('../server/config');
const anchorSvc = require('../server/services/anchor');

(async () => {
  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  try {
    const [batches] = await conn.query(
      `SELECT batch_no, facility_id, facility_name, state_code, unit_id, stack_id,
              COUNT(*) hours, SUM(is_measured) measured,
              MIN(emission_date) d0, MAX(emission_date) d1,
              SUM(co2_mass_t) co2, MIN(chain_tx_id) tx,
              MIN(primary_fuel) fuel, MIN(unit_type) utype
         FROM cems_emission_hourly
        GROUP BY batch_no, facility_id, facility_name, state_code, unit_id, stack_id
        ORDER BY d0`
    );
    console.log(`\nCEMS 排放量批次 ${batches.length} 个\n`);
    let done = 0, skip = 0;
    for (const b of batches) {
      if (b.tx) { skip++; console.log(`  ⊘ ${b.facility_name} u${b.unit_id} 已上链 ${String(b.tx).slice(0, 14)}…`); continue; }
      const r = await anchorSvc.anchor({
        txType: 'CEMS_EMISSION_BATCH',
        bizNo: b.batch_no,
        fromLabel: 'regulator:system',
        payload: {
          batchNo: b.batch_no,
          jurisdiction: 'US-EPA-CAMD',
          facility: { id: b.facility_id, name: b.facility_name, state: b.state_code, unit: b.unit_id, stack: b.stack_id },
          hours: Number(b.hours),
          measuredHours: Number(b.measured),
          periodFrom: String(b.d0),
          periodTo: String(b.d1),
          co2MetricTonnes: Number(Number(b.co2).toFixed(4)),
          fuel: b.fuel,
          unitType: b.utype,
          source: 'US EPA CAMD / EASEY API（40 CFR Part 75 连续排放监测强制上报）',
          provenance: 'REAL_CEMS_MEASURED',
          measuredMeaning: 'co2MassMeasureFlg=Measured 表示该小时 CO₂ 质量由 CEMS 分析仪直测',
          unitConversion: 'co2_mass_t = co2_mass_raw_st × 0.90718474；SO2/NOx: lb × 0.45359237 = kg',
          verifiable: 'CO₂(=短吨×0.9072) 与 热输入MMBtu×co2Rate(短吨/MMBtu) 应相等，实测平均比 1.0027',
        },
      });
      await conn.query('UPDATE cems_emission_hourly SET chain_tx_id = ? WHERE batch_no = ?', [r.txId, b.batch_no]);
      done++;
      console.log(`  ✔ ${String(b.facility_name).slice(0, 20).padEnd(22)} u${b.unit_id} ${String(b.hours).padStart(4)}h`
        + ` CO₂ ${(Number(b.co2) / 1000).toFixed(2)}kt → 区块 #${r.blockIndex} ${r.txId.slice(0, 14)}…`);
    }
    console.log(`\n新上链 ${done} / 已存在 ${skip}`);

    /* 汇总核验 */
    const [s] = await conn.query(
      `SELECT COUNT(*) n, SUM(is_measured) m, SUM(co2_mass_t) co2, COUNT(DISTINCT chain_tx_id) tx
         FROM cems_emission_hourly`
    );
    console.log(`库内：${s[0].n} 条（实测 ${s[0].m}）· CO₂ ${(Number(s[0].co2) / 1000).toFixed(2)} kt · 上链 ${s[0].tx} 笔`);
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('上链失败：', e.message); process.exit(1); });
