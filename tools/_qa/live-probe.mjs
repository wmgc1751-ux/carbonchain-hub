/**
 * 线上端点存在性探测：对前端调用的每个端点打线上，
 * 404 = 未实现；其余（200/400/401/403/405）= 路由存在。
 * POST 用无鉴权探测（已注册路由先过鉴权 → 401；未注册 → 404）。
 * 用法：node tools/_qa/live-probe.mjs [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.argv[2] || 'https://www.carbonchain.dpdns.org';
const PUB = path.join(ROOT, 'public');

const calls = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(js|html)$/.test(f)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const re = /API\.(?:request|get|post)\(\s*(['"])((GET|POST)\1\s*,?\s*)?(['"])(\/[^'"]*)\4/g;
    let m;
    while ((m = re.exec(src))) {
      const method = (m[3] || 'GET').toUpperCase();
      calls.push({ method, path: m[5], file: path.relative(PUB, p) });
    }
    const re2 = /API\.(get|post)\(\s*(['"])(\/[^'"]*)\2/g;
    while ((m = re2.exec(src))) calls.push({ method: m[1].toUpperCase(), path: m[3], file: path.relative(PUB, p) });
  }
}
walk(PUB);

const norm = (u) => '/api' + u.split('?')[0].replace(/\$\{[^}]*\}/g, ':x').replace(/\/\d+(?=\/|$)/g, '/:id');
const uniq = [...new Set(calls.map((c) => c.method + ' ' + norm(c.path)))].sort();
const sample = (u) => {
  let s = u.replace(/:x/g, '1').replace(/:id/g, '1');
  if (!/\/\d/.test(s)) s = s.replace(/(\/api\/[^/]+)$/, '$1'); // 保持原样
  return s;
};

const missing = [];
for (const call of uniq) {
  const [method, p] = call.split(' ');
  const probe = method === 'GET' ? 'GET' : 'POST';
  let code = 0;
  try {
    const res = await fetch(BASE + sample(p), {
      method: probe,
      headers: { 'Content-Type': 'application/json' },
      body: probe === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(25000),
    });
    code = res.status;
  } catch (e) { code = -1; }
  if (code === 404) missing.push(call);
  console.log(String(code).padStart(4), call);
}
console.log('\n=== 线上缺失（404）端点:', missing.length, '===');
console.log(missing.join('\n'));
