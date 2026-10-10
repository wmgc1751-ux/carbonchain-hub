/**
 * scripts/bench.js —— 轻量接口性能采样（无需任何依赖）
 *
 * 对若干代表性接口各打 N 次（默认 20 次，跳过前 3 次预热），
 * 统计平均 / 中位 / P95 / 最快 / 最慢耗时，输出 Markdown 表格。
 *
 * 用法：node scripts/bench.js [次数]
 * 前置：后端已启动（node server/app.js）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.APP_BASE || 'http://127.0.0.1:8300';
const N = Math.max(5, Number(process.argv[2]) || 20);

async function api(pathname, method = 'GET', body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api' + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(pathname + ' -> ' + json.message);
  return json.data;
}

function stat(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const sum = a.reduce((s, v) => s + v, 0);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    avg: sum / a.length, p50: q(0.5), p95: q(0.95), min: a[0], max: a[a.length - 1],
  };
}

async function main() {
  const acc = await api('/auth/demo-accounts');
  const ent = acc.find((a) => a.role === 'ENTERPRISE');
  const reg = acc.find((a) => a.role === 'REGULATOR');
  const et = (await api('/auth/login', 'POST', { username: ent.username, password: ent.password })).token;
  const rt = (await api('/auth/login', 'POST', { username: reg.username, password: reg.password })).token;

  const cases = [
    ['GET', '/health', null, null, '健康检查（含链高度查询）'],
    ['GET', '/public/dashboard', null, null, '公示大屏聚合数据'],
    ['GET', '/chain/blocks?page=1&size=10', null, null, '区块列表'],
    ['GET', '/chain/txs?page=1&size=10', null, null, '交易列表'],
    ['GET', '/chain/validate', null, null, '全链完整性校验（含 PoA 签名逐块验签）'],
    ['GET', '/enterprise/overview', null, et, '企业总览'],
    ['GET', '/enterprise/reports?page=1&size=10', null, et, '企业上报单分页'],
    ['GET', '/enterprise/analytics', null, et, '企业碳数据分析'],
    ['GET', '/regulator/overview', null, rt, '监管总览'],
    ['GET', '/regulator/statistics', null, rt, '监管统计分析'],
  ];

  const rows = [];
  for (const [method, p, body, token, label] of cases) {
    await api(p, method, body, token); // 预热
    const times = [];
    for (let i = 0; i < N; i++) {
      const t = Date.now();
      await api(p, method, body, token);
      times.push(Date.now() - t);
    }
    rows.push({ label, path: p, ...stat(times) });
    console.log(`${label.padEnd(16)} avg=${stat(times).avg.toFixed(1)}ms p95=${stat(times).p95}ms`);
  }

  const md = [
    '# 接口性能采样',
    '',
    `- 采样时间：${new Date().toLocaleString('zh-CN')}`,
    `- 站点：${BASE}　每接口 ${N} 次（已预热 1 次）`,
    '',
    '| 接口 | 说明 | 平均 | 中位 | P95 | 最快 | 最慢 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| \`${r.path}\` | ${r.label} | ${r.avg.toFixed(1)} ms | ${r.p50} ms | ${r.p95} ms | ${r.min} ms | ${r.max} ms |`),
    '',
  ];
  const out = path.join(__dirname, '..', 'artifacts', 'perf-report.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md.join('\n'), 'utf8');
  console.log('\n已写入 artifacts/perf-report.md');
}

main().catch((e) => { console.error('性能采样失败：', e.message); process.exit(1); });
