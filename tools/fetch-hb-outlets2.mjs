#!/usr/bin/env node
/**
 * tools/fetch-hb-outlets2.mjs —— 补齐四家企业其余排口的小时数据
 * ==================================================================
 * 背景：四家企业在河北省公开系统实有 7 个废气排口，原有接入只覆盖每家 1 个
 *       （65 有 1/2/3 号共 3 个，66/67/68 各有 2 个）。本脚本补齐剩余 5 个。
 *
 * 排口由官方接口枚举得来（tools 内不放猜测值）：
 *   GET /online_base/v5/portInfo/findPortTypeAndMonitorTypeByPsId/{psId}
 *   GET /online_base/v5/portInfo?psId=&portTypeId=&fields=portName,portCode,portTypeId
 *
 * 字段较原有接入更全：原有 ingestion 只映射 13 个字段，本脚本把省平台原始报文里
 * 非占位的字段全部取回，其中 a19001=实测含氧量（用 GB 18485 基准氧 11% 反解
 * 折算公式验证：反解均值 11.0±0.06，见 docs 报告）。
 *
 * 落盘：.cache/hb-outlets2/<portId>_<YYYYMM>.json，断点续传（有文件即跳过）。
 * 限速：默认 1600ms/请求；429 退避 25s，最多 5 次。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', '.cache', 'hb-outlets2');
fs.mkdirSync(OUT, { recursive: true });

const ARGV = process.argv.slice(2);
const argOf = (k, d) => {
  const i = ARGV.indexOf('--' + k);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};
const THROTTLE = Number(argOf('throttle', 1600));
const FROM = argOf('from', '2023-01');
const TO = argOf('to', '2026-10');
const ONLY = argOf('only', ''); // 逗号分隔 portId，用于分批跑

/* 官方接口枚举结果（2026-10-30 实测），企业名与库内 enterprise.ent_name 一致 */
const TARGETS = [
  { ent: '河北恒能（保定）环保能源有限公司', psId: '8b41c07e5d2f4a19b3e6d8c1a7f02496', portId: 'a4fe4dd44ebc4e2b9a227990ef2fea12', port: '2号烟气排放口' },
  { ent: '河北恒能（保定）环保能源有限公司', psId: '8b41c07e5d2f4a19b3e6d8c1a7f02496', portId: 'b41b18ea5e104dc98db9423bacd2768b', port: '3号烟气排放口' },
  { ent: '保定瑞丰环保电力有限公司', psId: 'c5d92b13a8064e7f9d21b4e8c30a7f65', portId: '81766099f4c24241beb6bc93a2d874de', port: '废气排口2号' },
  { ent: '保定易州恒新环保电力有限公司', psId: '2f7a60ed91c8436ab05d8e2f7c41938d', portId: 'bf7be06db68d4e80b4a5805a0c2dbe73', port: '焚烧炉烟囱2' },
  { ent: '河北恒能（涞水）环保能源有限公司', psId: '7e30d5a9c14b4f2786ba0c3e9d15f4a2', portId: 'd480364b2a3a4c8ea4bd287d9a0d3ac0', port: '焚烧炉排气筒2' },
];

/* 省平台原始字段。a00000=烟气量，a01901=炉温，a19001=含氧量，
 * a21026=SO2 a21002=NOx a34013=颗粒物 a21005=CO a21001=HCl a21003/a21004=辅助因子。
 * 每项另有 -zsavg(折算值) / -cou(排放量) / -rt(采集时刻) 后缀。 */
const FIELDS = [
  'time',
  'a00000-cou',
  'a01901-avg',
  'a19001-avg',
  'a21026-avg', 'a21026-zsavg', 'a21026-cou',
  'a21002-avg', 'a21002-zsavg', 'a21002-cou',
  'a34013-avg', 'a34013-zsavg', 'a34013-cou',
  'a21005-avg', 'a21005-cou',
  'a21001-avg', 'a21001-zsavg', 'a21001-cou',
  'a21003-avg', 'a21003-cou',
  'a21004-avg', 'a21004-cou',
].join(',');
const HEADERS = FIELDS;

function request(url, body, retry = 5) {
  return new Promise((resolve, reject) => {
    const q = https.request({
      host: '111.62.218.180', port: 9920, path: url, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-ACCESS': 'ANONYMOUS',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000, rejectUnauthorized: false,
    }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => {
        if (r.statusCode === 429) {
          if (retry > 0) return setTimeout(() => request(url, body, retry - 1).then(resolve, reject), 25000);
          return reject(new Error('RATE_LIMIT'));
        }
        let j;
        try { j = JSON.parse(s); } catch {
          if (retry > 0) return setTimeout(() => request(url, body, retry - 1).then(resolve, reject), 8000);
          return reject(new Error('parse:' + s.slice(0, 80)));
        }
        if (j && j.error) {
          if (retry > 0) return setTimeout(() => request(url, body, retry - 1).then(resolve, reject), 8000);
          return reject(new Error(j.error.code || 'api'));
        }
        resolve(j);
      });
    });
    q.on('error', reject);
    q.on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    q.write(body);
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
  const skip = ONLY ? new Set(ONLY.split(',').map((s) => s.trim())) : null;
  const targets = skip ? TARGETS.filter((t) => skip.has(t.portId)) : TARGETS;
  const list = months(FROM, TO);
  console.log(`补齐排口 ${targets.length} 个 × ${list.length} 个月（${FROM} ~ ${TO}）\n`);

  let fetched = 0, cached = 0, empty = 0, failed = 0, totalRows = 0;
  for (const t of targets) {
    console.log(`▶ ${t.ent.slice(0, 10)} / ${t.port}`);
    for (const ym of list) {
      const f = path.join(OUT, `${t.portId}_${ym.replace('-', '')}.json`);
      if (fs.existsSync(f)) { cached++; continue; }
      let rows = [];
      try {
        const j = await request('/online_statistics/v5/dataQuery/list', JSON.stringify({
          index: 1, size: 1000, psId: t.psId, portTypeId: 'port_type2', portId: t.portId,
          dataType: '2061',
          startTime: `${ym}-01 00:00:00`, endTime: `${monthEnd(ym)} 23:00:00`,
          headers: HEADERS,
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
    console.log(`  ─ ${t.port} 完成`);
  }
  console.log(`\n完成：取数 ${fetched} 月（空 ${empty}）/ 缓存 ${cached} / 失败 ${failed} / 本轮落盘 ${totalRows} 行`);
  if (failed) { console.log('有失败月份，重跑本命令即可断点续传'); process.exitCode = 1; }
})().catch((e) => { console.error('抓取失败：', e.message); process.exit(1); });
