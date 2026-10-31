#!/usr/bin/env node
/**
 * tools/anchor-cnh-new.cjs —— 为新增排口的 CEMS 小时批次补锚
 * ==================================================================
 * 背景：2026-10-30 补齐 5 个真实排口 × 46 个月后，cems_cn_hourly 从
 *       134,400 行增至 302,400 行、批次 184 → 414。新增 230 个批次尚无链锚。
 *
 * payload 结构与既有 184 笔 CN_CEMS_HOURLY 完全一致（从链上取回的样本对齐），
 * 保证新旧批次可被同一套离线复核程序验真：
 *   batchNo / provenance / enterprise / outlet / hours / validHours /
 *   periodFrom / periodTo / totals{flueGasM3,so2Kg,noxKg,pmKg} /
 *   granularity / fields / source / co2Note / consistency
 *
 * 幂等：biz_no 已存在则跳过，不重复上链。
 * 用法：node tools/anchor-cnh-new.cjs [--dry-run] [--limit N]
 */
'use strict';
const mysql = require('mysql2/promise');
const { createRequire } = require('node:module');
const req = createRequire(__filename);
const cfg = req('../server/config');
const anchorSvc = req('../server/services/anchor');

const DRY = process.argv.includes('--dry-run');
const li = process.argv.indexOf('--limit');
const LIMIT = li >= 0 ? Number(process.argv[li + 1]) : 0;

(async () => {
  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  const led = await mysql.createConnection({
    host: cfg.ledgerDb.host, port: cfg.ledgerDb.port,
    user: cfg.ledgerDb.user, password: cfg.ledgerDb.password,
    database: cfg.ledgerDb.database, dateStrings: true,
  });
  let done = 0, skip = 0, fail = 0;
  try {
    const [batches] = await conn.query(
      `SELECT batch_no, ent_name, outlet_name, COUNT(*) hours, SUM(is_valid) validHours,
              MIN(monitored_at) d0, MAX(monitored_at) d1,
              SUM(flue_gas_m3) gas, SUM(so2_emission_kg) so2,
              SUM(nox_emission_kg) nox, SUM(pm_emission_kg) pm
         FROM cems_cn_hourly
        GROUP BY batch_no, ent_name, outlet_name
        ORDER BY d0, outlet_name`
    );
    console.log(`库内批次 ${batches.length} 个${DRY ? '（dry-run）' : ''}\n`);

    const [existing] = await led.query(
      "SELECT biz_no FROM chain_tx WHERE tx_type = 'CN_CEMS_HOURLY'"
    );
    const have = new Set(existing.map((r) => r.biz_no));
    console.log(`链上已有 ${have.size} 笔 CN_CEMS_HOURLY`);

    const todo = batches.filter((b) => !have.has(b.batch_no));
    console.log(`待补锚 ${todo.length} 个批次\n`);

    for (const b of todo) {
      if (LIMIT && done >= LIMIT) { console.log(`达到 --limit ${LIMIT}，停止`); break; }
      const payload = {
        batchNo: b.batch_no,
        provenance: 'REAL_CEMS_CN',
        enterprise: b.ent_name,
        outlet: b.outlet_name,
        hours: Number(b.hours),
        validHours: Number(b.validHours),
        periodFrom: String(b.d0),
        periodTo: String(b.d1),
        totals: {
          flueGasM3: Number(Number(b.gas || 0).toFixed(1)),
          so2Kg: Number(Number(b.so2 || 0).toFixed(2)),
          noxKg: Number(Number(b.nox || 0).toFixed(2)),
          pmKg: Number(Number(b.pm || 0).toFixed(2)),
        },
        granularity: 'HOURLY',
        fields: '烟气量m³+浓度(实测/折算)+排放量kg+炉膛温度+含氧量',
        source: '河北省污染源自动监控信息公开系统(111.62.218.180:9920)',
        co2Note: 'GB18485 焚烧CEMS不含CO₂；CO₂按活动水平法另行核算',
        consistency: '排放量kg=实测浓度mg/m³×烟气量m³×1e-6',
      };
      if (DRY) { done++; continue; }
      try {
        const r = await anchorSvc.anchor({
          txType: 'CN_CEMS_HOURLY',
          bizNo: b.batch_no,
          fromLabel: 'regulator:system',
          payload,
        });
        await conn.query('UPDATE cems_cn_hourly SET chain_tx_id = ? WHERE batch_no = ?',
          [r.txId, b.batch_no]);
        done++;
        process.stdout.write(`  ✔ ${String(b.outlet_name).padEnd(12)} ${String(b.d0).slice(0, 7)} `
          + `${String(b.hours).padStart(4)}h → #${r.blockIndex}\r`);
      } catch (e) {
        fail++;
        console.log(`\n  ✘ ${b.batch_no} ${b.outlet_name} ${String(b.d0).slice(0, 7)}: ${e.message}`);
      }
    }

    if (DRY) { console.log(`\ndry-run：将补锚 ${done} 个批次，已存在 ${have.size}`); return; }

    const [chk] = await conn.query(
      'SELECT COUNT(*) n, COUNT(chain_tx_id) chained, COUNT(DISTINCT chain_tx_id) txs FROM cems_cn_hourly'
    );
    console.log(`\n\n✔ 补锚 ${done} / 失败 ${fail} / 原已存在 ${have.size}`);
    console.log(`库内 ${chk[0].n} 行，已带链锚 ${chk[0].chained} 行，链锚 ${chk[0].txs} 笔`);
  } finally {
    await conn.end();
    await led.end();
  }
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
