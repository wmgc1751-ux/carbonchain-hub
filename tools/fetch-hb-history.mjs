#!/usr/bin/env node
/**
 * tools/fetch-hb-history.mjs —— 批量提取河北省公开系统历史小时数据
 * ================================================================
 * 目标：为"动态核算/年度核算/季节趋势"提供足够长度的真实时序。
 * 范围：4 家企业 × 2023-01 ~ 2026-10（46 个月），逐月逐企业拉取。
 * 落盘：.cache/hb-history/<psId>_<portId>_<YYYYMM>.json，断点续传（有文件即跳过）。
 * 限速：每请求间隔 --throttle（默认 1200ms）。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', '.cache', 'hb-history');
fs.mkdirSync(OUT, { recursive: true });

const ARGV = process.argv.slice(2);
const argOf = (k, d) => { const i = ARGV.indexOf('--' + k); return i >= 0 && ARGV[i+1] && !ARGV[i+1].startsWith('--') ? ARGV[i+1] : d; };
const THROTTLE = Number(argOf('throttle', 1200));
const FROM = argOf('from', '2023-01');
const TO = argOf('to', '2026-10');

const TARGETS = [
  { ent: '河北恒能（保定）环保能源有限公司', psId: '8b41c07e5d2f4a19b3e6d8c1a7f02496', portId: 'f3fbc747db564b8bbfe8a09fc4484aed', port: '1号烟气排放口' },
  { ent: '保定瑞丰环保电力有限公司', psId: 'c5d92b13a8064e7f9d21b4e8c30a7f65', portId: '76dad044ef304843b17a587b4a0a04f2', port: '废气排口1号' },
  { ent: '保定易州恒新环保电力有限公司', psId: '2f7a60ed91c8436ab05d8e2f7c41938d', portId: 'd94a0aa5e2564818bb10efe38c39875c', port: '焚烧炉烟囱' },
  { ent: '河北恒能（涞水）环保能源有限公司', psId: '7e30d5a9c14b4f2786ba0c3e9d15f4a2', portId: '1e287d2846684ef084cab41e695b6be6', port: '焚烧炉排气筒' },
];
const H = 'time,a00000-cou,a00000-otherFlag,a01901-avg,a34013-avg,a34013-zsavg,a34013-cou,a21026-avg,a21026-zsavg,a21026-cou,a21002-avg,a21002-zsavg,a21002-cou,a21005-avg,a21005-cou,a21001-avg,a21001-cou';

function request(url, body, retry = 4) {
  return new Promise((resolve, reject) => {
    const q = https.request({
      host: '111.62.218.180', port: 9920, path: url, method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-ACCESS': 'ANONYMOUS', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: 60000,
    }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => {
        let j;
        try { j = JSON.parse(s); } catch {
          if (retry > 0) return setTimeout(() => request(url, body, retry - 1).then(resolve, reject), 6000);
          return reject(new Error('parse:' + s.slice(0, 80)));
        }
        if (j && j.error) {
          const wait = /OVER_RATE/.test(j.error.code || '') ? 45000 : 6000;
          if (retry > 0) return setTimeout(() => request(url, body, retry - 1).then(resolve, reject), wait);
          return reject(new Error(j.error.code || 'api'));
        }
        resolve(j);
      });
    });
    q.on('error', reject);
    q.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    if (body) q.write(body);
    q.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function months(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

(async () => {
  const list = months(FROM, TO);
  console.log(`提取窗口 ${FROM} ~ ${TO}（${list.length} 个月）× ${TARGETS.length} 家企业\n`);
  let totalRows = 0, fetched = 0, cached = 0, empty = 0, failed = 0;
  for (const t of TARGETS) {
    console.log(`▶ ${t.ent}（${t.port}）`);
    for (const ym of list) {
      const f = path.join(OUT, `${t.psId}_${t.portId}_${ym.replace('-', '')}.json`);
      if (fs.existsSync(f)) { cached++; continue; }
      let rows = [];
      try {
        const j = await request('/online_statistics/v5/dataQuery/list', JSON.stringify({
          index: 1, size: 1000, psId: t.psId, portTypeId: 'port_type2', portId: t.portId,
          dataType: '2061', startTime: `${ym}-01 00:00:00`, endTime: `${monthEnd(ym)} 23:00:00`, headers: H,
        }));
        rows = (j.data || []).filter((x) => x.time);
        fs.writeFileSync(f, JSON.stringify(rows));
        totalRows += rows.length;
        if (rows.length) fetched++; else empty++;
        process.stdout.write(`  ${ym}: ${rows.length} 条\r`);
      } catch (e) {
        failed++;
        console.log(`\n  ✘ ${ym}: ${e.message}`);
      }
      await sleep(THROTTLE);
    }
    console.log(`  ─ ${t.ent.slice(0, 8)} 完成`);
  }
  console.log(`\n完成：本轮取数 ${fetched} 个月（空 ${empty}）/ 缓存命中 ${cached} / 失败 ${failed} / 本轮落盘 ${totalRows} 行`);
  console.log(`下一步：node tools/ingest-hb-history.cjs  把 .cache/hb-history/*.json 全量入库`);
})();
