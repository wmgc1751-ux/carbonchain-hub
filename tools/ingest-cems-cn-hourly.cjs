#!/usr/bin/env node
/* 把抓取的河北省真实 CEMS 小时数据入库（cems_cn_hourly） */
'use strict';
const fs = require('fs');
const mysql = require('mysql2/promise');
const cfg = require('../server/config');

const SRC = '.cache/hb-cems-all.json';
const num = (v) => { const n = Number(v); return (v === undefined || v === null || v === '-' || !Number.isFinite(n)) ? null : n; };

(async () => {
  const all = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const portEnt = {
    '1号烟气排放口': '河北恒能（保定）环保能源有限公司',
    '废气排口1号': '保定瑞丰环保电力有限公司',
    '焚烧炉烟囱': '保定易州恒新环保电力有限公司',
  };

  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  await conn.query(fs.readFileSync('db/10_schema_cems_cn_hourly.sql', 'utf8'));

  /* 清洗：修企业名、判有效性 */
  const rows = [];
  let negFlow = 0, nonFinite = 0;
  for (const r of all) {
    const ent = portEnt[r.port] || r.ent;
    const flow = num(r['a00000-cou']);
    let isValid = 1, reason = null;
    if (flow === null) { isValid = 0; reason = '烟气量缺失'; nonFinite++; }
    else if (flow < 0) { isValid = 0; reason = '负烟气量（传感器漂移时段）'; negFlow++; }
    const so2e = num(r['a21026-cou']);
    if (so2e !== null && so2e < 0) { isValid = 0; reason = (reason ? reason + ';' : '') + '负排放量'; }
    rows.push({
      ent, port: r.port, time: r.time,
      status: r['a00000-rt'] ? null : null, // 工况在页面有列但接口未返回，如实留空
      flow,
      furnace: num(r['a01901-avg']),
      o2: null, // a19001 未在本次 headers 里（浏览器页面上有，接口字段按抓取为准）
      vel: null, gt: null, gh: null, gp: null,
      pm: num(r['a34013-avg']), pmz: num(r['a34013-zsavg']), pme: num(r['a34013-cou']),
      so2: num(r['a21026-avg']), so2z: num(r['a21026-zsavg']), so2e,
      nox: num(r['a21002-avg']), noxz: num(r['a21002-zsavg']), noxe: num(r['a21002-cou']),
      co: num(r['a21005-avg']), coe: num(r['a21005-cou']),
      hcl: num(r['a21001-avg']), hcle: num(r['a21001-cou']),
      isValid, reason,
    });
  }

  const digest = require('crypto').createHash('sha256')
    .update(rows.map((r) => `${r.port}|${r.time}|${r.flow}|${r.so2e}|${r.noxe}`).join(';')).digest('hex').slice(0, 24);
  const batchNo = `CN-${digest}`;

  const [exist] = await conn.query('SELECT COUNT(*) n FROM cems_cn_hourly WHERE batch_no = ?', [batchNo]);
  if (exist[0].n > 0) { console.log(`批次 ${batchNo} 已存在（${exist[0].n} 条），幂等跳过`); await conn.end(); return; }

  const values = rows.map((r) => [
    r.ent, r.port, r.time, null,
    r.flow, r.furnace, r.o2, r.vel, r.gt, r.gh, r.gp,
    r.pm, r.pmz, r.pme, r.so2, r.so2z, r.so2e, r.nox, r.noxz, r.noxe,
    r.co, r.coe, r.hcl, r.hcle,
    r.isValid, r.reason, 'REAL_CEMS_CN', '河北省污染源自动监控信息公开系统',
    batchNo,
  ]);
  await conn.query(
    `INSERT INTO cems_cn_hourly
     (ent_name, outlet_name, monitored_at, op_status,
      flue_gas_m3, furnace_temp_c, o2_pct, flow_velocity, gas_temp_c, gas_humidity, gas_pressure,
      pm_measured, pm_corrected, pm_emission_kg,
      so2_measured, so2_corrected, so2_emission_kg,
      nox_measured, nox_corrected, nox_emission_kg,
      co_measured, co_emission_kg, hcl_measured, hcl_emission_kg,
      is_valid, invalid_reason, provenance, source, batch_no)
     VALUES ?
     /* upsert：排口+小时是自然主键。新增排口会使批次号变化，
      * 重跑脚本时对已有行必须更新而非重插（2026-10-28 实测撞唯一键）。
      * 注意 batch_no 也刷新为新批次，使同一行归属最新一次完整抓取。 */
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

  const [sum] = await conn.query(
    `SELECT COUNT(*) n, SUM(is_valid) v, SUM(flue_gas_m3) gas, SUM(so2_emission_kg) so2,
            SUM(nox_emission_kg) nox, SUM(pm_emission_kg) pm,
            MIN(monitored_at) t0, MAX(monitored_at) t1
       FROM cems_cn_hourly`
  );
  console.log(`✔ 入库 ${values.length} 条（有效 ${sum[0].v}，负流量/缺值 ${negFlow + nonFinite}）批次 ${batchNo}`);
  console.log(`  烟气量合计 ${Number(sum[0].gas).toFixed(0)} m³`);
  console.log(`  SO₂ 排放合计 ${Number(sum[0].so2).toFixed(1)} kg | NOx ${Number(sum[0].nox).toFixed(1)} kg | 颗粒物 ${Number(sum[0].pm).toFixed(2)} kg`);
  console.log(`  时段 ${sum[0].t0} ~ ${sum[0].t1}`);
  await conn.end();
})().catch((e) => { console.error('入库失败：', e.message); process.exit(1); });
