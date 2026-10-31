#!/usr/bin/env node
/**
 * tools/ingest-epa-camd.mjs —— 接入真实 CEMS 排放量数据（EPA CAMD Part 75）
 * ==================================================================
 * 这批数据补上的正是此前缺失的两样东西：
 *   · CO₂ 质量排放（吨/小时）—— 由 CEMS 分析仪直测（MeasureFlg = Measured）
 *   · 伴生量测：热输入、负荷、SO₂、NOx、排放口栈号 —— 足以做交叉核验
 *
 * 与 ingest-ljgk.mjs 的区别（两者都要保留，不能相互替代）：
 *   ljgk     = 中国企业的污染物**浓度**（mg/m³）→ 只能判达标，算不出排放量
 *   CAMD     = 美国机组的**排放量**（tCO₂/h）  → 能直接做排放核算与趋势
 * 所以这批是「国际参照集」，必须在页面与接口上标明 jurisdiction，不能混称"中国控排企业"。
 *
 * 单位换算是本工具最容易出错的地方，因此**原始值一并保留**（co2_mass_raw_st），
 * 并与换算值同列，任何人可复核 ×0.90718474 这一步。
 *
 * 用法：
 *   node tools/ingest-epa-camd.mjs --facility=26 --unit=5 --from=2023-01-01 --to=2023-03-31
 *   node tools/ingest-epa-camd.mjs --list          # 列出已入库概况
 *   node tools/ingest-epa-camd.mjs --throttle=4000 # 自定义请求间隔（DEMO_KEY 建议 ≥4000ms）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import mysql from 'mysql2/promise';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cfg = require('../server/config');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, '..', '.cache', 'camd');

const ARGV = process.argv.slice(2);
const argOf = (k, d) => {
  const i = ARGV.indexOf('--' + k);
  if (i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) return ARGV[i + 1];
  const eq = ARGV.find((a) => a.startsWith(`--${k}=`));
  return eq ? eq.slice(k.length + 3) : d;
};
const flag = (k) => ARGV.includes('--' + k);

const KEY = process.env.EPA_KEY || argOf('api-key', 'DEMO_KEY');
const FACILITY = argOf('facility', '');
const UNIT = argOf('unit', '');
const FROM = argOf('from', '');
const TO = argOf('to', '');
const THROTTLE = Number(argOf('throttle', 4000));
const ST = 0.90718474;   // short ton → metric ton
const LB = 0.45359237;   // lb → kg

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url, retry = 4) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000 }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => {
        let j;
        try { j = JSON.parse(s); } catch (e) {
          if (retry > 0) return setTimeout(() => httpGet(url, retry - 1).then(resolve, reject), 6000);
          return reject(new Error('解析失败: ' + s.slice(0, 120)));
        }
        if (j && j.error) {
          const code = j.error.code || 'ERR';
          if (retry > 0) {
            const wait = code === 'OVER_RATE_LIMIT' ? 45000 : 6000;
            console.log(C.dim(`    限流/错误 ${code}，${wait / 1000}s 后重试（剩 ${retry} 次）`));
            return setTimeout(() => httpGet(url, retry - 1).then(resolve, reject), wait);
          }
          return reject(new Error(code));
        }
        resolve(j);
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

/** 月末日期 */
function monthEnd(y, m) {
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/** 按月拉取（分页最多 5 页/月，通常 1 页足够：744 小时 < 1000） */
async function fetchMonth(facility, unit, y, m) {
  const begin = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = monthEnd(y, m);
  const cacheFile = path.join(CACHE, `f${facility}_u${unit}_${y}${String(m).padStart(2, '0')}.json`);
  if (fs.existsSync(cacheFile)) {
    return { rows: JSON.parse(fs.readFileSync(cacheFile, 'utf8')), cached: true };
  }
  const rows = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.epa.gov/easey/streaming-services/emissions/apportioned/hourly`
      + `?facilityId=${facility}&unitId=${encodeURIComponent(unit)}`
      + `&beginDate=${begin}&endDate=${end}&page=${page}&perPage=500&api_key=${KEY}`;
    const arr = await httpGet(url);
    if (!Array.isArray(arr) || !arr.length) break;
    rows.push(...arr);
    if (arr.length < 500) break;
    await sleep(THROTTLE);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(rows), 'utf8');
  return { rows, cached: false };
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  真实 CEMS 排放量接入（EPA CAMD Part 75 小时级）');
  console.log('══════════════════════════════════════════════════════════\n');

  const conn = await mysql.createConnection({ ...cfg.db, dateStrings: true });
  try {
    if (flag('list')) {
      const [rows] = await conn.query(
        `SELECT facility_id, facility_name, state_code, unit_id, stack_id,
                COUNT(*) hours, SUM(is_measured) measured,
                MIN(emission_date) d0, MAX(emission_date) d1,
                SUM(co2_mass_t) co2, COUNT(DISTINCT batch_no) batches
           FROM cems_emission_hourly
          GROUP BY facility_id, facility_name, state_code, unit_id, stack_id
          ORDER BY co2 DESC`
      );
      if (!rows.length) { console.log('  库内暂无数据'); return; }
      console.log('  设施 / 机组 / 小时数 / 实测 / 时段 / CO₂(万t) / 批次');
      for (const r of rows) {
        console.log(`  ${String(r.facility_name).slice(0, 22).padEnd(24)} u${String(r.unit_id).padEnd(3)} ${r.state_code}`
          + ` ${String(r.hours).padStart(5)}h 实测${String(r.measured).padStart(5)}`
          + ` ${r.d0}~${r.d1} ${(Number(r.co2) / 10000).toFixed(2)}万t ${r.batches}批 栈${r.stack_id || '—'}`);
      }
      return;
    }

    if (!FACILITY || !UNIT || !FROM || !TO) {
      console.log(C.bad('✘ 需要 --facility --unit --from --to'));
      console.log(C.dim('  例：node tools/ingest-epa-camd.mjs --facility=26 --unit=5 --from=2023-01-01 --to=2023-12-31'));
      return;
    }

    const [y0, m0] = FROM.split('-').map(Number);
    const [y1, m1] = TO.split('-').map(Number);
    console.log(`  目标：facility=${FACILITY} unit=${UNIT}  时段 ${FROM} ~ ${TO}  间隔 ${THROTTLE}ms\n`);

    let totalRows = 0;
    let totalMeasured = 0;
    const cur = new Date(Date.UTC(y0, m0 - 1, 1));
    const last = new Date(Date.UTC(y1, m1 - 1, 1));

    while (cur <= last) {
      const y = cur.getUTCFullYear();
      const m = cur.getUTCMonth() + 1;
      let got;
      try {
        got = await fetchMonth(FACILITY, UNIT, y, m);
      } catch (e) {
        console.log(C.bad(`  ✘ ${y}-${String(m).padStart(2, '0')} 取数失败：${e.message}`));
        cur.setUTCMonth(cur.getUTCMonth() + 1);
        await sleep(THROTTLE);
        continue;
      }
      const rows = got.rows;
      if (!rows.length) {
        console.log(C.dim(`  – ${y}-${String(m).padStart(2, '0')}: 无记录`));
        cur.setUTCMonth(cur.getUTCMonth() + 1);
        await sleep(got.cached ? 0 : THROTTLE);
        continue;
      }

      const measured = rows.filter((r) => r.co2Mass != null && r.co2MassMeasureFlg === 'Measured');
      const co2 = measured.reduce((s, r) => s + Number(r.co2Mass), 0);
      const stack = rows.find((r) => r.associatedStacks)?.associatedStacks || null;

      /* 内容寻址批次：同一批数据重复导入得到同一号 */
      const digest = crypto.createHash('sha256')
        .update(rows.map((r) => `${r.facilityId}|${r.unitId}|${r.date}|${r.hour}|${r.co2Mass}|${r.co2MassMeasureFlg}`).join(';'))
        .digest('hex').slice(0, 24);
      const batchNo = `CEMS-${digest}`;

      const [exist] = await conn.query('SELECT COUNT(*) n FROM cems_emission_hourly WHERE batch_no = ?', [batchNo]);
      if (exist[0].n > 0) {
        console.log(C.dim(`  ⊘ ${y}-${String(m).padStart(2, '0')}: 批次已存在（${exist[0].n} 条），跳过`));
        totalMeasured += measured.length;
        cur.setUTCMonth(cur.getUTCMonth() + 1);
        await sleep(got.cached ? 0 : THROTTLE);
        continue;
      }

      const values = rows.map((r) => [
        'US-EPA-CAMD', r.facilityId, r.facilityName, r.stateCode, r.unitId,
        r.associatedStacks || stack, r.date, r.hour,
        r.opTime, r.grossLoad, r.heatInput,
        r.co2Mass != null ? Number(r.co2Mass) * ST : null,
        r.co2Mass != null ? Number(r.co2Mass) : null,
        r.co2Rate, r.so2Mass != null ? Number(r.so2Mass) * LB : null,
        r.noxMass != null ? Number(r.noxMass) * LB : null,
        r.co2MassMeasureFlg,
        (r.co2Mass != null && r.co2MassMeasureFlg === 'Measured') ? 1 : 0,
        r.primaryFuelInfo, r.unitType, r.programCodeInfo,
        'EPA-CAMD-EASEY', 'REAL_CEMS_MEASURED', batchNo, JSON.stringify(r),
      ]);
      await conn.query(
        `INSERT INTO cems_emission_hourly
         (jurisdiction, facility_id, facility_name, state_code, unit_id, stack_id,
          emission_date, emission_hour, op_time, gross_load_mw, heat_input_mmbtu,
          co2_mass_t, co2_mass_raw_st, co2_rate_st_per_mmbtu, so2_mass_kg, nox_mass_kg,
          co2_measure_flag, is_measured, primary_fuel, unit_type, program_code,
          source, provenance, batch_no, raw_json)
         VALUES ?`,
        [values]
      );
      totalRows += rows.length;
      totalMeasured += measured.length;
      console.log(`  ✔ ${y}-${String(m).padStart(2, '0')}: ${rows.length} 条（实测 ${measured.length}）`
        + ` CO₂ ${(co2 * ST / 1000).toFixed(2)} kt · 栈 ${stack || '—'} · ${batchNo.slice(0, 14)}…`);

      cur.setUTCMonth(cur.getUTCMonth() + 1);
      if (!got.cached) await sleep(THROTTLE);
    }

    console.log('');
    console.log(C.ok(`✔ 写入 ${totalRows} 条（其中 CEMS 实测 ${totalMeasured} 条）`));
    const [sum] = await conn.query(
      `SELECT COUNT(*) n, SUM(is_measured) m, SUM(co2_mass_t) co2,
              MIN(emission_date) d0, MAX(emission_date) d1, COUNT(DISTINCT batch_no) b
         FROM cems_emission_hourly`
    );
    console.log(`  库内合计：${sum[0].n} 条（实测 ${sum[0].m}）· CO₂ ${(Number(sum[0].co2) / 10000).toFixed(2)} 万t · ${sum[0].d0} ~ ${sum[0].d1} · ${sum[0].b} 批次`);
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('接入失败：', e.message); process.exit(1); });
