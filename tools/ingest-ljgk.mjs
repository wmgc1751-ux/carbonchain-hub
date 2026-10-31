#!/usr/bin/env node
/**
 * tools/ingest-ljgk.mjs —— 真实企业 CEMS 公开日均浓度接入
 * ==================================================================
 * 为什么单独一个工具，而不是给 real-cems-ingest.mjs 加 --mode=ljgk：
 *   两者的**数据语义不同**。real-cems-ingest 处理的是「排放速率 t/h」（可算排放量），
 *   本工具处理的是「污染物浓度 mg/m³」（只能判达标，算不出排放量）。
 *   混在一个工具里，迟早会有人把浓度当排放速率喂进去，静默算错。
 *
 * 输入：企业环境监测平台导出的原始报文 JSON
 *   { "20260926": [ { ps_code, mp_code, monitor_time, pollutant_code,
 *                     pollutant_name, strength, standard_value, status, data_status } ] }
 *
 * 铁律（与 real-cems-ingest 一致）：
 *   · 不生成、不插值、不补造任何一条读数；
 *   · 原始报文逐条留存到 raw_json，可逐条回溯；
 *   · 批次号用内容寻址（CPS-<sha256前24位>），重复导入天然幂等；
 *   · 企业未备案则拒绝入库。
 *
 * 用法：
 *   node tools/ingest-ljgk.mjs --dir "D:/.../信件" --dry-run
 *   node tools/ingest-ljgk.mjs --dir "D:/.../信件"
 *   node tools/ingest-ljgk.mjs --dir "D:/.../信件" --verify
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---------------- 参数 ---------------- */
const ARGV = process.argv.slice(2);
const argOf = (k, d) => {
  const i = ARGV.indexOf('--' + k);
  if (i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) return ARGV[i + 1];
  const eq = ARGV.find((a) => a.startsWith(`--${k}=`));
  return eq ? eq.slice(k.length + 3) : d;
};
const flag = (k) => ARGV.includes('--' + k);
const DIR = argOf('dir', '');
const DRY = flag('dry-run');
const VERIFY = flag('verify');

/* ---------------- 配置 ---------------- */
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const ENV = { ...readEnv(path.join(ROOT, '.env')), ...process.env };
const BIZ = {
  host: ENV.DB_HOST || '127.0.0.1',
  port: Number(ENV.DB_PORT || 3306),
  user: ENV.DB_USER || 'root',
  password: ENV.DB_PASSWORD || '123456',
  database: ENV.DB_NAME || 'carbon_chain',
  charset: 'utf8mb4',
};

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

/* 4 家在册企业：统一社会信用代码 + 目录（代码取自各企业《企业基本信息表》原文） */
const ENTERPRISES = {
  '91130605MA0H2K7L3R': { name: '河北恒能（保定）环保能源有限公司', folder: '01-河北恒能（保定）环保能源有限公司' },
  '91130607MA0N8T5Q2W': { name: '保定瑞丰环保电力有限公司', folder: '03-保定瑞丰环保电力有限公司' },
  '91130633MA0P4R9S6Y': { name: '保定易州恒新环保电力有限公司', folder: '04-保定易州恒新环保电力有限公司' },
  '91130623MA0L6V8X4Z': { name: '河北恒能（涞水）环保能源有限公司', folder: '05-河北恒能（涞水）环保能源有限公司' },
};

/* 污染物编码 → 名称（来自原始报文 pollutant_code） */
const POLLUTANTS = {
  '001': '颗粒物',
  '002': '二氧化硫',
  '003': '氮氧化物',
  '004': '一氧化碳',
  '008': '氯化氢',
};

/* 排放口编码 → 名称（取自各企业《碳排放核算口径资料》第三节原表） */
const OUTLETS = {
  /* 01 河北恒能（保定） */
  '59767CBE8A83398DD31F043A1C56ED70': '3号烟气排放口',
  '59767CBE8A83398D8F2F4B31CAE2A258': '1号烟气排放口',
  '59767CBE8A83398D0122E427614E86FF': '2号烟气排放口',
  '5F35E14AC26672499899264E2DD659CD9FEF454335A10544CD6AB120C4C019249EA80B59C30A1F1E': '1号烟气排放口（新）',
  /* 03 保定瑞丰环保 */
  '59767CBE8A83398D66CF87B719168BF7': '废气排口1号',
  '59767CBE8A83398DF2F25A529B712163': '废气排口2号',
  /* 04 保定易州恒新 */
  '60EA5A184695326CF37B10E4539658B33CE0B8D4B6E1CF753F7DF9DD8266ADC1D3A32FEE1EF67FE4': '焚烧炉烟囱2',
  '1EF217E6CA022BA91C0CCC200B202D21AAB9F72F720D5D2C1D38E65D988D55F91BB61A3DF8A5DCEE': '焚烧炉烟囱1',
  /* 05 河北恒能（涞水） */
  '59767CBE8A83398DB2CCD6C807A5D048': '焚烧炉排气筒',
  '59767CBE8A83398DA24C60D920442DA0': '焚烧炉排气筒2',
};

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

/* ---------------- 解析原始报文 ---------------- */
function parsePacket(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [];
  for (const day of Object.keys(raw)) {
    for (const r of raw[day]) {
      const t = String(r.monitor_time || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(t)) continue;
      const conc = Number(r.strength);
      if (!Number.isFinite(conc)) continue;
      const std = r.standard_value === null || r.standard_value === undefined || r.standard_value === ''
        ? null : Number(r.standard_value);
      rows.push({
        psCode: r.ps_code || null,
        mpCode: r.mp_code,
        readingTime: t,
        pollutantCode: String(r.pollutant_code || '').padStart(3, '0'),
        pollutantName: r.pollutant_name || POLLUTANTS[String(r.pollutant_code).padStart(3, '0')] || '未知',
        concentration: conc,
        standardValue: Number.isFinite(std) ? std : null,
        status: String(r.status ?? '0'),
        dataStatus: String(r.data_status ?? '0'),
        raw: r,
      });
    }
  }
  return rows;
}

/* ---------------- 主流程 ---------------- */
(async () => {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  真实企业 CEMS 公开日均浓度接入（来源：ljgk 公开平台）');
  console.log('══════════════════════════════════════════════════════════\n');

  const conn = await mysql.createConnection({ ...BIZ, dateStrings: true });
  try {
    if (VERIFY) return await verify(conn);

    if (!DIR) {
      console.log(C.bad('✘ 缺少 --dir（指向 信件 数据包根目录）'));
      return;
    }
    if (!fs.existsSync(DIR)) { console.log(C.bad('✘ 目录不存在：' + DIR)); return; }

    /* 收集所有原始 JSON（只认 原始数据JSON 目录，避免把其他 JSON 当读数） */
    const files = walk(DIR).filter((f) => f.endsWith('.json') && f.includes('原始数据JSON'));
    console.log(`  发现原始报文 ${files.length} 份\n`);

    /* 归属企业：按文件路径里的企业目录判断 */
    const byEnt = new Map();
    for (const f of files) {
      const rel = path.relative(DIR, f).split(path.sep);
      const folder = rel[0];
      if (folder.startsWith('00-')) {
        console.log(C.dim(`  跳过（已剔除企业）：${rel.slice(-1)[0]}`));
        continue;
      }
      const meta = Object.entries(ENTERPRISES).find(([, v]) => v.folder === folder);
      if (!meta) { console.log(C.warn(`  ⚠ 未登记企业目录，跳过：${folder}`)); continue; }
      const [entCode, info] = meta;
      const rows = parsePacket(f);
      if (!rows.length) { console.log(C.warn(`  ⚠ 无有效读数：${rel.slice(-1)[0]}`)); continue; }
      if (!byEnt.has(entCode)) byEnt.set(entCode, { info, outlets: new Map(), all: [] });
      const bucket = byEnt.get(entCode);
      /* 按 mp_code 归集（一个文件 = 一个排口） */
      const mp = rows[0].mpCode;
      bucket.outlets.set(mp, rows);
      bucket.all.push(...rows);
      console.log(`  ${info.name.slice(0, 12)} · ${path.basename(f)} → ${rows.length} 条 · mp=${mp.slice(0, 12)}…`);
    }

    console.log('');
    let totalInserted = 0;
    const batches = [];

    for (const [entCode, bucket] of byEnt) {
      /* 企业必须已备案（enterprise 表存在该信用代码），否则拒绝 —— 不虚构企业 */
      const [ents] = await conn.query('SELECT id, ent_name FROM enterprise WHERE ent_code = ?', [entCode]);
      if (!ents.length) {
        console.log(C.warn(`  ⚠ ${bucket.info.name}：信用代码 ${entCode} 未在 enterprise 表备案，跳过（不虚构企业）`));
        continue;
      }
      const entId = ents[0].id;
      console.log(C.b(`  ● ${bucket.info.name}（ent_id=${entId}，信用代码 ${entCode}）`));

      for (const [mpCode, rows] of bucket.outlets) {
        /* 排序校验：时间必须单调（同排口同污染物） */
        const byPoll = new Map();
        for (const r of rows) {
          if (!byPoll.has(r.pollutantCode)) byPoll.set(r.pollutantCode, []);
          byPoll.get(r.pollutantCode).push(r);
        }
        let monoOk = true;
        for (const [, list] of byPoll) {
          for (let i = 1; i < list.length; i++) {
            if (new Date(list[i].readingTime) <= new Date(list[i - 1].readingTime)) { monoOk = false; break; }
          }
        }
        if (!monoOk) {
          console.log(C.bad(`    ✘ 排口 ${mpCode.slice(0, 10)}… 时间非单调，整批拒绝`));
          continue;
        }

        /* 内容寻址批次号：同一份数据重复导入得到同一个号（幂等） */
        const digest = crypto.createHash('sha256')
          .update(rows.map((r) => `${r.mpCode}|${r.readingTime}|${r.pollutantCode}|${r.concentration}`).sort().join(';'))
          .digest('hex').slice(0, 24);
        const batchNo = `CPS-${digest}`;
        const outletName = OUTLETS[mpCode] || `排口-${mpCode.slice(0, 8)}`;

        const [exist] = await conn.query('SELECT COUNT(*) n FROM cems_public_reading WHERE batch_no = ?', [batchNo]);
        if (exist[0].n > 0) {
          console.log(C.dim(`    ⊘ ${outletName}：批次 ${batchNo} 已存在（${exist[0].n} 条），幂等跳过`));
          batches.push({ entCode, outletName, batchNo, rows: exist[0].n, skipped: true });
          continue;
        }

        const validCount = rows.filter((r) => r.status === '0' && r.dataStatus === '0' && r.concentration > 0).length;
        const exceedCount = rows.filter((r) => r.standardValue !== null && r.concentration > r.standardValue).length;
        const zeroCount = rows.filter((r) => r.concentration === 0).length;

        console.log(`    ${outletName}：${rows.length} 条（有效 ${validCount}｜零值 ${zeroCount}｜超限 ${exceedCount}）批次 ${batchNo}`);

        if (DRY) { batches.push({ entCode, outletName, batchNo, rows: rows.length, dry: true }); continue; }

        const values = rows.map((r) => [
          entCode, bucket.info.name, r.psCode, r.mpCode, outletName,
          r.readingTime, r.pollutantCode, r.pollutantName,
          r.concentration, 'mg/m3', r.standardValue,
          (r.standardValue !== null && r.concentration > r.standardValue) ? 1 : 0,
          r.status, r.dataStatus,
          (r.status === '0' && r.dataStatus === '0' && r.concentration > 0) ? 1 : 0,
          'LJGK', 'REAL_PUBLIC', batchNo, JSON.stringify(r.raw),
        ]);
        await conn.query(
          `INSERT INTO cems_public_reading
           (ent_code, ent_name, ps_code, mp_code, outlet_name, reading_time, pollutant_code, pollutant_name,
            concentration, unit, standard_value, exceed, status, data_status, is_valid,
            source, provenance, batch_no, raw_json)
           VALUES ?`,
          [values]
        );
        totalInserted += rows.length;
        batches.push({ entCode, outletName, batchNo, rows: rows.length });
      }
    }

    console.log('');
    if (DRY) {
      console.log(C.warn(`⊘ 预演模式：未写库。将写入 ${batches.filter((b) => !b.skipped).reduce((a, b) => a + b.rows, 0)} 条`));
    } else {
      console.log(C.ok(`✔ 本次写入 ${totalInserted} 条真实读数`));
    }
    const [sum] = await conn.query(
      `SELECT COUNT(*) n, COUNT(DISTINCT mp_code) outlets, COUNT(DISTINCT ent_code) ents,
              MIN(reading_time) t0, MAX(reading_time) t1
         FROM cems_public_reading`
    );
    console.log(`  库内合计：${sum[0].n} 条 · ${sum[0].outlets} 个排口 · ${sum[0].ents} 家企业 · ${sum[0].t0} ~ ${sum[0].t1}`);
    console.log(C.dim('  真实性等级 REAL_PUBLIC；无烟气流量，不用于排放量核算。'));
  } finally {
    await conn.end();
  }
})().catch((e) => { console.error('接入失败：', e.message); process.exit(1); });

/* ---------------- 校验 ---------------- */
async function verify(conn) {
  const [rows] = await conn.query(
    `SELECT ent_name, outlet_name, COUNT(*) n, COUNT(DISTINCT reading_time) days,
            MIN(reading_time) t0, MAX(reading_time) t1,
            SUM(exceed) exceed_n, SUM(concentration = 0) zero_n,
            COUNT(DISTINCT pollutant_name) polls, COUNT(DISTINCT batch_no) batches
       FROM cems_public_reading
      GROUP BY ent_name, outlet_name ORDER BY ent_name, outlet_name`
  );
  console.log('  按排口：');
  for (const r of rows) {
    console.log(`    ${String(r.ent_name).slice(0, 14).padEnd(16)} ${String(r.outlet_name).padEnd(16)} ${String(r.n).padStart(4)} 条 ${r.days} 天 ${String(r.polls)} 项 超限${r.exceed_n} 零值${r.zero_n}`);
  }
  const [t] = await conn.query('SELECT COUNT(*) n, COUNT(DISTINCT batch_no) b FROM cems_public_reading');
  console.log(`  合计 ${t[0].n} 条 / ${t[0].b} 批次`);
}
