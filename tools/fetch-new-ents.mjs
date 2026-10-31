#!/usr/bin/env node
/** 批量提取新企业 46 个月 CEMS 数据 → .cache/hb-history/ */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', '.cache', 'hb-history');
fs.mkdirSync(OUT, { recursive: true });

const TARGETS = [
  { ent: '河北华电石家庄热电有限公司', psId: '4c5a75dc50514ac0b11e4a86268fe4b4', portId: '83cfc894a02a4f238f38dbf8b1fd9d4e', port: '废气排放口', industry: '热电' },
  { ent: '石家庄钢铁有限责任公司特殊钢分公司', psId: 'e4f0f4181614448d95f5192e7fb708c8', portId: 'effe4c343ba0438fac9892f06e35ecf1', port: '特殊钢废气排放口', industry: '钢铁' },
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
        try { j = JSON.parse(s); } catch { if (retry > 0) return setTimeout(() => request(url, body, retry - 1).then(resolve, reject), 6000); return reject(new Error('parse')); }
        if (j && j.error) { if (retry > 0) return setTimeout(() => request(url, body, retry - 1).then(resolve, reject), 30000); return reject(new Error(j.error.code)); }
        resolve(j);
      });
    });
    q.on('error', reject); q.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    if (body) q.write(body);
    q.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function months(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
function monthEnd(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

(async () => {
  const list = months('2023-01', '2026-10');
  console.log(`提取 ${list.length} 个月 × ${TARGETS.length} 家新企业\n`);
  let total = 0, cached = 0;
  for (const t of TARGETS) {
    for (const ym of list) {
      const f = path.join(OUT, `${t.psId}_${t.portId}_${ym.replace('-', '')}.json`);
      if (fs.existsSync(f)) { cached++; continue; }
      try {
        const j = await request('/online_statistics/v5/dataQuery/list', JSON.stringify({
          index: 1, size: 1000, psId: t.psId, portTypeId: 'port_type2', portId: t.portId,
          dataType: '2061', startTime: `${ym}-01 00:00:00`, endTime: `${monthEnd(ym)} 23:00:00`, headers: H,
        }));
        const rows = (j.data || []).filter((x) => x.time);
        fs.writeFileSync(f, JSON.stringify(rows));
        total += rows.length;
        process.stdout.write(`  ${t.ent.slice(0, 8)} ${ym}: ${rows.length}\r`);
      } catch (e) { console.log(`\n  ✘ ${t.ent.slice(0, 8)} ${ym}: ${e.message}`); }
      await sleep(1200);
    }
    console.log(`\n  ─ ${t.ent.slice(0, 8)} 完成`);
  }
  console.log(`\n完成：新提取 ${total} 行 / 缓存 ${cached}`);
})();
