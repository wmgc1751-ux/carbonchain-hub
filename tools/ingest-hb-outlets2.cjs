#!/usr/bin/env node
/**
 * tools/ingest-hb-outlets2.cjs —— 把补齐排口的小时数据入库 cems_cn_hourly
 * ==================================================================
 * 输入：.cache/hb-outlets2/<portId>_<YYYYMM>.json（fetch-hb-outlets2.mjs 落盘）
 * 幂等：唯一键 (outlet_name, monitored_at) 上 upsert，重复跑不产生重复行
 *
 * 字段映射（省平台原生 → 库列）：
 *   a00000-cou  → flue_gas_m3        小时烟气量 m³
 *   a01901-avg  → furnace_temp_c     炉膛温度 ℃
 *   a19001-avg  → o2_pct             实测含氧量 %（原有接入漏采，本批补齐）
 *   a34013-*    → pm_*               颗粒物 实测/折算/排放量kg
 *   a21026-*    → so2_*
 *   a21002-*    → nox_*
 *   a21005-*    → co_*               （省平台无折算值，corrected 留空）
 *   a21001-*    → hcl_*
 *
 * 有效性判定与原接入保持一致：烟气量缺失/为负 → is_valid=0，如实保留不修正。
 * 未识别因子（a21003/a21004 等）不猜测语义，不入库。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const cfg = require('../server/config');

const SRC = path.join(__dirname, '..', '.cache', 'hb-outlets2');
const DRY = process.argv.includes('--dry-run');

/* portId → 企业与排口（与 fetch-hb-outlets2.mjs 的 TARGETS 一一对应） */
const PORTS = {
  'a4fe4dd44ebc4e2b9a227990ef2fea12': ['河北恒能（保定）环保能源有限公司', '2号烟气排放口'],
  'b41b18ea5e104dc98db9423bacd2768b': ['河北恒能（保定）环保能源有限公司', '3号烟气排放口'],
  '81766099f4c24241beb6bc93a2d874de': ['保定瑞丰环保电力有限公司', '废气排口2号'],
  'bf7be06db68d4e80b4a5805a0c2dbe73': ['保定易州恒新环保电力有限公司', '焚烧炉烟囱2'],
  'd480364b2a3a4c8ea4bd287d9a0d3ac0': ['河北恒能（涞水）环保能源有限公司', '焚烧炉排气筒2'],
};

const num = (v) => {
  const n = Number(v);
  return (v === undefined || v === null || v === '-' || !Number.isFinite(n)) ? null : n;
};

/* 物理量程闸门。
 * 背景：2026-10-30 实测本批 168,000 行里出现 -2.05e17 mg/m³ 这类传感器故障值
 * （省平台原样发布，未做剔除）。这类值直接入库会：
 *   ① 击穿 DECIMAL 列（pm_measured 溢出）；
 *   ② 让任何 SUM/AVG 失去意义。
 * 处理原则与既有接入一致：**不修正数值、不静默丢弃** —— 超量程置 NULL，
 * 并在 invalid_reason 里写明，行本身保留（is_valid=0）。
 * 量程取「不可能出现的物理区间」而非「可能出现的业务区间」：
 *   浓度 0–20,000 mg/m³（垃圾焚烧限值 SO2/NOx 为 100–300，留 60 倍余量）
 *   烟气量 0–1,000,000 m³/h（焚烧炉典型 3–15 万，留 6 倍余量）
 *   炉温 0–1,300 ℃，含氧量 0–21 %（标干烟气理论上限） */
const RANGE = {
  conc: [-1, 20000], flow: [-1, 1000000], furnace: [-1, 1300], o2: [-0.5, 21.5],
};
const gate = (v, key) => {
  if (v === null) return null;
  const [lo, hi] = RANGE[key];
  return (v < lo || v > hi) ? null : v;
};

(async () => {
  if (!fs.existsSync(SRC)) { console.error('缓存目录不存在：' + SRC); process.exit(1); }
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.json'));
  console.log(`月文件 ${files.length} 个${DRY ? '（dry-run，不写库）' : ''}\n`);

  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  let inserted = 0, updated = 0, skipped = 0;
  const batches = new Map();
  const invalidStats = { 缺烟气量: 0, 负烟气量: 0, 负排放量: 0, 超量程: 0 };

  try {
    for (const f of files) {
      const base = f.replace('.json', '');
      const portId = base.split('_')[0];
      const ym = base.split('_')[1];
      const meta = PORTS[portId];
      if (!meta) { skipped++; console.log(`  ⊘ 未知 portId ${portId}，跳过`); continue; }
      const [ent, port] = meta;

      const rows = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
      if (!rows.length) continue;

      const digest = crypto.createHash('sha256')
        .update(base + rows.map((r) => r.time).join(',')).digest('hex').slice(0, 24);
      const batchNo = `CNH-${digest}`;

      const values = rows.map((r) => {
        const flowRaw = num(r['a00000-cou']);
        const flow = gate(flowRaw, 'flow');
        let isValid = 1, reason = null;
        if (flow === null) {
          isValid = 0;
          reason = flowRaw === null ? '烟气量缺失' : '超量程烟气量（源端异常值）';
          invalidStats[flowRaw === null ? '缺烟气量' : '超量程']++;
        } else if (flow < 0) { isValid = 0; reason = '负烟气量（传感器漂移时段）'; invalidStats['负烟气量']++; }

        /* 五项污染物：实测/折算/排放量各自过量程闸门 */
        const pick = (raw, key, label) => {
          const v = num(raw);
          const g = gate(v, key);
          if (v !== null && g === null) {
            isValid = 0;
            reason = (reason ? reason + ';' : '') + `${label}超量程`;
            invalidStats['超量程']++;
          }
          return g;
        };
        const pmAvg = pick(r['a34013-avg'], 'conc', 'PM浓度');
        const pmZ = pick(r['a34013-zsavg'], 'conc', 'PM折算');
        const pmCou = pick(r['a34013-cou'], 'conc', 'PM排放量');
        const so2Avg = pick(r['a21026-avg'], 'conc', 'SO2浓度');
        const so2Z = pick(r['a21026-zsavg'], 'conc', 'SO2折算');
        const so2Cou = pick(r['a21026-cou'], 'conc', 'SO2排放量');
        const noxAvg = pick(r['a21002-avg'], 'conc', 'NOx浓度');
        const noxZ = pick(r['a21002-zsavg'], 'conc', 'NOx折算');
        const noxCou = pick(r['a21002-cou'], 'conc', 'NOx排放量');
        const coAvg = pick(r['a21005-avg'], 'conc', 'CO浓度');
        const coCou = pick(r['a21005-cou'], 'conc', 'CO排放量');
        const hclAvg = pick(r['a21001-avg'], 'conc', 'HCl浓度');
        const hclCou = pick(r['a21001-cou'], 'conc', 'HCl排放量');
        const ft = pick(r['a01901-avg'], 'furnace', '炉温');
        const o2 = pick(r['a19001-avg'], 'o2', '含氧量');

        if (so2Cou !== null && so2Cou < 0) {
          isValid = 0;
          reason = (reason ? reason + ';' : '') + '负排放量';
          invalidStats['负排放量']++;
        }
        return [
          ent, port, r.time, null,
          flow, ft, o2, null, null, null, null,
          pmAvg, pmZ, pmCou,
          so2Avg, so2Z, so2Cou,
          noxAvg, noxZ, noxCou,
          coAvg, coCou,
          hclAvg, hclCou,
          isValid, reason, 'REAL_CEMS_CN', '河北省污染源自动监控信息公开系统', batchNo,
        ];
      });

      if (DRY) {
        console.log(`  [dry] ${port} ${ym}: ${values.length} 行`);
        continue;
      }

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
           flue_gas_m3=VALUES(flue_gas_m3), furnace_temp_c=VALUES(furnace_temp_c),
           o2_pct=VALUES(o2_pct),
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
      batches.set(batchNo, { ent, port, ym, n: values.length });
      process.stdout.write(`  ${port} ${ym}: ${values.length} 行（affected ${res.affectedRows}）\r`);
    }

    if (DRY) { console.log('\ndry-run 结束，未写库'); return; }

    console.log(`\n✔ upsert 完成，累计 affected ${inserted}，批次 ${batches.size}，跳过 ${skipped}`);
    if (invalidStats['缺烟气量'] || invalidStats['负烟气量'] || invalidStats['负排放量']) {
      console.log(`  有效性标记：${JSON.stringify(invalidStats)}（如实保留，未修正）`);
    }

    const [sum] = await conn.query(
      `SELECT COUNT(*) n, SUM(is_valid) v, COUNT(DISTINCT ent_name) ents,
              COUNT(DISTINCT outlet_name) outs, COUNT(DISTINCT batch_no) batches,
              MIN(monitored_at) t0, MAX(monitored_at) t1,
              SUM(flue_gas_m3) gas, SUM(so2_emission_kg) so2, SUM(nox_emission_kg) nox,
              SUM(pm_emission_kg) pm, SUM(o2_pct IS NOT NULL) has_o2
         FROM cems_cn_hourly`
    );
    const s = sum[0];
    console.log(`库内合计：${s.n} 条（有效 ${s.v}，含氧量非空 ${s.has_o2}）· ${s.ents} 家企业 · ${s.outs} 排口 · ${s.batches} 批次`);
    console.log(`时段：${s.t0} ~ ${s.t1}`);
    console.log(`烟气量 ${(Number(s.gas) / 1e8).toFixed(2)} 亿m³ | SO₂ ${Number(s.so2).toFixed(0)} kg | NOx ${Number(s.nox).toFixed(0)} kg | PM ${Number(s.pm).toFixed(0)} kg`);
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('入库失败：', e.message); process.exit(1); });
