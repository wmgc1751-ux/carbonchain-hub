#!/usr/bin/env node
/**
 * tools/ingest-hb-history.cjs —— 把 .cache/hb-history/*.json（46 个月全量）入库
 * 逻辑：读所有月份文件 → 修企业名 → 有效性判定 → upsert 入 cems_cn_hourly
 * 幂等：upsert + 内容寻址批次按排口+月切分
 */
'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cfg = require('../server/config');

const SRC = '.cache/hb-history';
const num = (v) => { const n = Number(v); return (v === undefined || v === null || v === '-' || !Number.isFinite(n)) ? null : n; };
const PORT_ENT = {
  '1号烟气排放口': '河北恒能（保定）环保能源有限公司',
  '废气排口1号': '保定瑞丰环保电力有限公司',
  '焚烧炉烟囱': '保定易州恒新环保电力有限公司',
  '焚烧炉排气筒': '河北恒能（涞水）环保能源有限公司',
};
// 排口名 → 企业名兜底用 psId（万一某月文件企业归属异常，仍按 psId 判）
const PS_ENT = {
  '8b41c07e5d2f4a19b3e6d8c1a7f02496': '河北恒能（保定）环保能源有限公司',
  'c5d92b13a8064e7f9d21b4e8c30a7f65': '保定瑞丰环保电力有限公司',
  '2f7a60ed91c8436ab05d8e2f7c41938d': '保定易州恒新环保电力有限公司',
  '7e30d5a9c14b4f2786ba0c3e9d15f4a2': '河北恒能（涞水）环保能源有限公司',
};

(async () => {
  const dir = path.resolve(SRC);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  console.log(`月文件 ${files.length} 个\n`);

  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });

  const crypto = require('crypto');
  let inserted = 0, updated = 0;
  const batches = [];

  for (const f of files) {
    const base = f.replace('.json', '');
    const psId = base.split('_')[0];
    const portId = base.split('_')[1];
    const rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const ent = PS_ENT[psId] || '未知企业';
    // 排口名从 portEnt 表按 portId 反查（portId→port 名映射）
    const PORTNAME = {
      'f3fbc747db564b8bbfe8a09fc4484aed': '1号烟气排放口',
      '76dad044ef304843b17a587b4a0a04f2': '废气排口1号',
      'd94a0aa5e2564818bb10efe38c39875c': '焚烧炉烟囱',
      '1e287d2846684ef084cab41e695b6be6': '焚烧炉排气筒',
    };
    const port = PORTNAME[portId] || ('排口-' + portId.slice(0, 6));

    const digest = crypto.createHash('sha256').update(base + rows.map((r) => r.time).join(',')).digest('hex').slice(0, 24);
    const batchNo = `CNH-${digest}`;

    const values = rows.map((r) => {
      const flow = num(r['a00000-cou']);
      let isValid = 1, reason = null;
      if (flow === null) { isValid = 0; reason = '烟气量缺失'; }
      else if (flow < 0) { isValid = 0; reason = '负烟气量（传感器漂移时段）'; }
      const so2e = num(r['a21026-cou']);
      if (so2e !== null && so2e < 0) { isValid = 0; reason = (reason ? reason + ';' : '') + '负排放量'; }
      return [
        ent, port, r.time, null,
        flow, num(r['a01901-avg']), null, null, null, null, null,
        num(r['a34013-avg']), num(r['a34013-zsavg']), num(r['a34013-cou']),
        num(r['a21026-avg']), num(r['a21026-zsavg']), so2e,
        num(r['a21002-avg']), num(r['a21002-zsavg']), num(r['a21002-cou']),
        num(r['a21005-avg']), num(r['a21005-cou']),
        num(r['a21001-avg']), num(r['a21001-cou']),
        isValid, reason, 'REAL_CEMS_CN', '河北省污染源自动监控信息公开系统', batchNo,
      ];
    });

    if (!values.length) continue;
    const [res] = await conn.query(
      `INSERT INTO cems_cn_hourly
       (ent_name, outlet_name, monitored_at, op_status,
        flue_gas_m3, furnace_temp_c, o2_pct, flow_velocity, gas_temp_c, gas_humidity, gas_pressure,
        pm_measured, pm_corrected, pm_emission_kg,
        so2_measured, so2_corrected, so2_emission_kg,
        nox_measured, nox_corrected, nox_emission_kg,
        co_measured, co_emission_kg, hcl_measured, hcl_emission_kg,
        is_valid, invalid_reason, provenance, source, batch_no)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         ent_name=VALUES(ent_name), op_status=VALUES(op_status),
         flue_gas_m3=VALUES(flue_gas_m3), furnace_temp_c=VALUES(furnace_temp_c),
         pm_measured=VALUES(pm_measured), pm_corrected=VALUES(pm_corrected), pm_emission_kg=VALUES(pm_emission_kg),
         so2_measured=VALUES(so2_measured), so2_corrected=VALUES(so2_corrected), so2_emission_kg=VALUES(so2_emission_kg),
         nox_measured=VALUES(nox_measured), nox_corrected=VALUES(nox_corrected), nox_emission_kg=VALUES(nox_emission_kg),
         co_measured=VALUES(co_measured), co_emission_kg=VALUES(co_emission_kg),
         hcl_measured=VALUES(hcl_measured), hcl_emission_kg=VALUES(hcl_emission_kg),
         is_valid=VALUES(is_valid), invalid_reason=VALUES(invalid_reason),
         provenance=VALUES(provenance), source=VALUES(source), batch_no=VALUES(batch_no)`,
      [values]
    );
    inserted += res.affectedRows;
    batches.push({ batchNo, port, ent, n: values.length });
    process.stdout.write(`  ${port} ${base.split('_')[2]}: ${values.length} 条（affected ${res.affectedRows}）\r`);
  }

  console.log(`\n✔ upsert 完成，累计 affected ${inserted}，批次数 ${batches.length}`);
  const [sum] = await conn.query(
    `SELECT COUNT(*) n, SUM(is_valid) v, COUNT(DISTINCT ent_name) ents, COUNT(DISTINCT outlet_name) outs,
            COUNT(DISTINCT batch_no) batches, MIN(monitored_at) t0, MAX(monitored_at) t1,
            SUM(flue_gas_m3) gas, SUM(so2_emission_kg) so2, SUM(nox_emission_kg) nox, SUM(pm_emission_kg) pm
       FROM cems_cn_hourly`
  );
  console.log(`库内合计：${sum[0].n} 条（有效 ${sum[0].v}）· ${sum[0].ents} 家企业 · ${sum[0].outs} 排口 · ${sum[0].batches} 批次`);
  console.log(`时段：${sum[0].t0} ~ ${sum[0].t1}`);
  console.log(`烟气量 ${(Number(sum[0].gas) / 1e8).toFixed(2)} 亿m³ | SO₂ ${Number(sum[0].so2).toFixed(0)} kg | NOx ${Number(sum[0].nox).toFixed(0)} kg | PM ${Number(sum[0].pm).toFixed(0)} kg`);
  await conn.end();
})().catch((e) => { console.error('入库失败：', e.message); process.exit(1); });
