/**
 * scripts/load-test.js —— 无依赖集群压测脚本（Node 原生 http）
 * ------------------------------------------------------------------
 * 对目标服务做并发扫描压测，产出 QPS / P50 / P95 / P99 / 错误率 / Markdown 报告。
 *
 * 用法：
 *   node scripts/load-test.js [base_url] [--concurrency=10,50,100,200] [--duration=8]
 *
 * 默认目标：线上 https://carbonchain-hub.onrender.com
 * 测试接口：/api/health（轻）, /api/chain/blocks?pageSize=10（中）, /api/chain/validate（重）
 *
 * 零依赖：用 Node 原生 http/https 模块手写并发，不引入 autocannon/wrkk。
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'https://carbonchain-hub.onrender.com';
const CONCURRENCY = (process.argv.find((a) => a.startsWith('--concurrency=')) || '--concurrency=10,50,100,200')
  .split('=')[1].split(',').map(Number);
const DURATION = Number((process.argv.find((a) => a.startsWith('--duration=')) || '--duration=8').split('=')[1]);

const ENDPOINTS = [
  { name: 'GET /api/health（轻量）', path: '/api/health', method: 'GET' },
  { name: 'GET /api/chain/blocks（中）', path: '/api/chain/blocks?pageSize=10', method: 'GET' },
  { name: 'GET /api/chain/validate（重）', path: '/api/chain/validate', method: 'GET' },
];

function request(base, path) {
  return new Promise((resolve) => {
    const u = new URL(base + path);
    const lib = u.protocol === 'https:' ? https : http;
    const start = Date.now();
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'cch-loadtest/1.0', 'Accept': 'application/json' },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - start, ok: res.statusCode < 500 }));
    });
    req.on('error', (e) => resolve({ status: 0, ms: Date.now() - start, ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: Date.now() - start, ok: false, error: 'timeout' }); });
    req.end();
  });
}

async function runConcurrency(base, endpoint, concurrency, durationSec) {
  const results = [];
  const deadline = Date.now() + durationSec * 1000;
  let active = 0;
  return new Promise((resolve) => {
    function next() {
      if (Date.now() > deadline && active === 0) {
        return resolve(results);
      }
      if (active < concurrency && Date.now() < deadline + 2000) {
        active++;
        request(base, endpoint.path).then((r) => {
          results.push(r);
          active--;
          next();
        });
      }
      if (Date.now() > deadline && active === 0) resolve(results);
      else setTimeout(next, 5);
    }
    // 启动并发
    for (let i = 0; i < concurrency; i++) {
      active++;
      request(base, endpoint.path).then((r) => {
        results.push(r);
        active--;
        next();
      });
    }
  });
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] || 0;
}

async function main() {
  console.log(`\n═══ 碳链通 · 集群压测基线 ═══`);
  console.log(`目标: ${BASE}`);
  console.log(`并发档位: ${CONCURRENCY.join(', ')}`);
  console.log(`每档持续: ${DURATION} 秒`);
  console.log(`测试接口: ${ENDPOINTS.length} 个\n`);

  const report = { base: BASE, timestamp: new Date().toISOString(), results: [] };

  for (const ep of ENDPOINTS) {
    console.log(`\n── ${ep.name} ──`);
    const epResult = { endpoint: ep, concurrencyResults: [] };
    for (const c of CONCURRENCY) {
      process.stdout.write(`  并发 ${c} ... `);
      const arr = await runConcurrency(BASE, ep, c, DURATION);
      const lats = arr.map((r) => r.ms);
      const ok = arr.filter((r) => r.ok).length;
      const errs = arr.length - ok;
      const r = {
        concurrency: c,
        totalRequests: arr.length,
        success: ok,
        errors: errs,
        errorRate: arr.length ? +(errs / arr.length * 100).toFixed(2) : 0,
        qps: +((arr.length / DURATION).toFixed(1)),
        p50: +pct(lats, 50).toFixed(0),
        p95: +pct(lats, 95).toFixed(0),
        p99: +pct(lats, 99).toFixed(0),
        avg: +(lats.reduce((a, b) => a + b, 0) / (lats.length || 1)).toFixed(0),
      };
      epResult.concurrencyResults.push(r);
      console.log(`QPS=${r.qps} P50=${r.p50}ms P95=${r.p95}ms P99=${r.p99}ms 错误率=${r.errorRate}% (${ok}/${arr.length})`);
    }
    report.results.push(epResult);
  }

  // 生成 Markdown 报告
  const md = generateMd(report);
  console.log('\n═══ 压测完成，Markdown 报告已生成 ═══');
  console.log(md);
  return report;
}

function generateMd(report) {
  const lines = [];
  lines.push('# 碳链通 · 集群压测基线报告');
  lines.push('');
  lines.push(`- **目标**: ${report.base}`);
  lines.push(`- **时间**: ${report.timestamp}`);
  lines.push(`- **测试机**: 本机（沙箱 Node ${process.version}）`);
  lines.push(`- **测试方法**: 并发扫描，每档持续 ${DURATION} 秒`);
  lines.push('');
  for (const ep of report.results) {
    lines.push(`## ${ep.endpoint.name}`);
    lines.push('');
    lines.push('| 并发 | 总请求 | 成功 | 错误率 | QPS | P50(ms) | P95(ms) | P99(ms) | 平均(ms) |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of ep.concurrencyResults) {
      lines.push(`| ${r.concurrency} | ${r.totalRequests} | ${r.success} | ${r.errorRate}% | ${r.qps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.avg} |`);
    }
    lines.push('');
  }
  lines.push('## 多节点扩展预测');
  lines.push('');
  lines.push('| 集群规模 | 预估 QPS（线性扩展） | 预估 P95 | 说明 |');
  lines.push('|---|---|---|---|');
  const base = report.results[0];
  if (base) {
    const c100 = base.concurrencyResults.find((r) => r.concurrency === 100);
    if (c100) {
      const baseQps = c100.qps;
      const baseP95 = c100.p95;
      [1, 2, 3, 5, 8].forEach((n) => {
        // Amdahl: 实际扩展受 DB 与共识序列化限制，按 0.7 效率折算
        const predQps = +(baseQps * n * 0.7).toFixed(0);
        const predP95 = +(baseP95 / Math.sqrt(n)).toFixed(0);
        lines.push(`| ${n} 节点 | ${predQps} | ${predP95}ms | DB 序列化瓶颈，按 0.7 效率折算 |`);
      });
    }
  }
  lines.push('');
  lines.push('## k8s 部署清单（真实可用）');
  lines.push('');
  lines.push('```yaml');
  lines.push('# deployment.yaml — 3 副本，滚动更新');
  lines.push('apiVersion: apps/v1');
  lines.push('kind: Deployment');
  lines.push('metadata:');
  lines.push('  name: carbonchain-hub');
  lines.push('spec:');
  lines.push('  replicas: 3');
  lines.push('  strategy:');
  lines.push('    type: RollingUpdate');
  lines.push('    rollingUpdate:');
  lines.push('      maxSurge: 1');
  lines.push('      maxUnavailable: 0');
  lines.push('  selector:');
  lines.push('    matchLabels: { app: carbonchain-hub }');
  lines.push('  template:');
  lines.push('    metadata:');
  lines.push('      labels: { app: carbonchain-hub }');
  lines.push('    spec:');
  lines.push('      containers:');
  lines.push('      - name: app');
  lines.push('        image: carbonchain-hub:latest');
  lines.push('        ports: [{ containerPort: 8300 }]');
  lines.push('        envFrom: [{ secretRef: { name: cch-secrets } }]');
  lines.push('        livenessProbe:');
  lines.push('          httpGet: { path: /api/ops/health, port: 8300 }');
  lines.push('          initialDelaySeconds: 30');
  lines.push('        readinessProbe:');
  lines.push('          httpGet: { path: /api/health, port: 8300 }');
  lines.push('          initialDelaySeconds: 5');
  lines.push('        resources:');
  lines.push('          requests: { cpu: 200m, memory: 256Mi }');
  lines.push('          limits: { cpu: 500m, memory: 512Mi }');
  lines.push('---');
  lines.push('# hpa.yaml — 自动扩缩');
  lines.push('apiVersion: autoscaling/v2');
  lines.push('kind: HorizontalPodAutoscaler');
  lines.push('metadata:');
  lines.push('  name: carbonchain-hub-hpa');
  lines.push('spec:');
  lines.push('  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: carbonchain-hub }');
  lines.push('  minReplicas: 2');
  lines.push('  maxReplicas: 10');
  lines.push('  metrics:');
  lines.push('  - type: Resource');
  lines.push('    resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

main().then((r) => {
  // 输出 JSON 供后续分析
  const fs = require('fs');
  const path = require('path');
  const outDir = path.join(__dirname, '..', 'artifacts');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const out = path.join(outDir, `loadtest-${ts}.json`);
  fs.writeFileSync(out, JSON.stringify(r, null, 2));
  const mdOut = path.join(outDir, `loadtest-${ts}.md`);
  fs.writeFileSync(mdOut, generateMd(r));
  console.log(`\n报告已保存: ${mdOut}`);
  console.log(`JSON 数据: ${out}`);
}).catch((e) => { console.error('压测失败:', e.message); process.exit(1); });
