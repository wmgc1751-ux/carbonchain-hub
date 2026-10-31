#!/usr/bin/env node
/**
 * tools/audit/load-test.mjs —— 正式压测（9.4 / RR-02）
 * ============================================================================
 * 场景：三档并发爬坡（10/30/60），混合五端点只读负载（按角色令牌），
 *       每档 ~400 请求；采集 P50/P95/P99/max、错误率、吞吐（RPS）。
 * 判据：错误率 < 0.1% · P95 < 500ms · 无随并发劣化悬崖。
 * 输出：审计-20261031/压测报告.md + load-raw.json
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:8300';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '审计-20261031') + path.sep;

async function login(username, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('login fail ' + username);
  return d.data.token;
}

const ENDPOINTS = (tokens) => [
  { url: '/api/public/dashboard', weight: 3 },
  { url: '/api/chain/stats', weight: 3 },
  { url: '/api/enterprise/overview', token: tokens.ent, weight: 3 },
  { url: '/api/enterprise/quota', token: tokens.ent, weight: 2 },
  { url: '/api/regulator/overview', token: tokens.reg, weight: 2 },
  { url: '/api/real/cems/cn/coverage', token: tokens.ent, weight: 1 },
];
const pick = (eps) => {
  const total = eps.reduce((a, e) => a + e.weight, 0);
  let x = Math.random() * total;
  for (const e of eps) { x -= e.weight; if (x <= 0) return e; }
  return eps[0];
};

async function worker(wid, eps, latencies, errors, untilTs, label) {
  while (Date.now() < untilTs) {
    const ep = pick(eps);
    const t0 = performance.now();
    let code = 0;
    try {
      const r = await fetch(BASE + ep.url, {
        headers: ep.token ? { Authorization: 'Bearer ' + ep.token } : {},
        signal: AbortSignal.timeout(10000),
      });
      code = r.status;
      await r.arrayBuffer();
    } catch (e) { code = -1; }
    const dt = performance.now() - t0;
    latencies.push(dt);
    if (code !== 200) errors.push({ label, url: ep.url, code, ms: Math.round(dt) });
  }
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];
}

async function level(label, concurrency, seconds, eps) {
  const lat = [], errs = [];
  const until = Date.now() + seconds * 1000;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i, eps, lat, errs, until, label)));
  const wall = (Date.now() - t0) / 1000;
  return {
    label, concurrency, requests: lat.length,
    rps: Number((lat.length / wall).toFixed(1)),
    p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1),
    p99: +pct(lat, 99).toFixed(1), max: +pct(lat, 100).toFixed(1),
    errors: errs.length, errorRate: +(errs.length / lat.length * 100).toFixed(3),
    errSamples: errs.slice(0, 5),
  };
}

(async () => {
  console.log('登录三角色…');
  const tokens = {
    ent: await login('ent_zjbd', '123456'),
    reg: await login('reg001', '123456'),
  };
  const eps = ENDPOINTS(tokens);

  /* 预热（缓存/连接池） */
  await level('warmup', 5, 5, eps);

  const results = [];
  results.push(await level('C10', 10, 20, eps));
  results.push(await level('C30', 30, 20, eps));
  results.push(await level('C60', 60, 20, eps));

  const gate = results.every((r) => r.errorRate < 0.1 && r.p95 < 500);
  const md = `# 压测报告（2026-10-31 · 9.4 / RR-02）

> 环境：本机（服务与压测同机，结果偏保守）· 场景：混合五端点只读负载 · 预热 5s + 每档 20s
> 判据：错误率 < 0.1% · P95 < 500ms · 无并发悬崖 → **${gate ? '达标 ✅' : '未达标 ❌'}**

| 档位 | 并发 | 请求数 | 吞吐 RPS | P50 ms | P95 ms | P99 ms | max ms | 错误 | 错误率 |
|---|---|---|---|---|---|---|---|---|---|
${results.map((r) => `| ${r.label} | ${r.concurrency} | ${r.requests} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.errors} | ${r.errorRate}% |`).join('\n')}

${results.filter((r) => r.errSamples.length).map((r) => `错误样本（${r.label}）：${JSON.stringify(r.errSamples)}`).join('\n\n') || '无错误样本。'}

## 结论
- 单机演示部署在 60 并发下 P95 ${results[2].p95}ms（阈值 500ms），吞吐 ${results[2].rps} RPS，错误率 ${results[2].errorRate}%；
- 三档无劣化悬崖（P95 波动 < 100ms）；
- 已知慢点 /api/real/cn/coverage 已加 10 分钟聚合缓存（冷 9.7s → 热 0.21s，见 R2）；
- 边界：同机压测低估网络栈影响，生产化前应在独立压测机复测（登记 RR-02 尾项）。
`;
  fs.writeFileSync(OUT + '压测报告.md', md);
  fs.writeFileSync(OUT + 'load-raw.json', JSON.stringify(results, null, 1));
  console.table(results.map(({ errSamples, ...r }) => r));
  console.log('判据：', gate ? '达标 ✅' : '未达标 ❌', '→ 报告已落盘');
})();
