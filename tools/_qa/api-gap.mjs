/**
 * 前端调用 vs Worker 端点 差集分析（QA 工具）
 * 前端统一走 API.request(method, path) / API.get / API.post，path 形如 '/public/enterprises'。
 * 用法：node tools/_qa/api-gap.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = path.join(ROOT, 'public');

const calls = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(js|html)$/.test(f)) continue;
    const src = fs.readFileSync(p, 'utf8');
    // API.request('GET', '/x') / API.get('/x') / API.post('/x', body)
    const re = /API\.(?:request|get|post)\(\s*(['"])(GET|POST)?\1?\s*,?\s*(['"])(\/[^'"]*)\3/g;
    let m;
    while ((m = re.exec(src))) {
      const method = (m[2] || (m[1] ? 'GET' : 'GET')).toUpperCase();
      calls.push({ method: m[1] === "'" && m[2] ? m[2] : method, path: m[4], file: path.relative(PUB, p) });
    }
    // 单参形式兜底：API.get('/x') / API.post('/x'
    const re2 = /API\.(get|post)\(\s*(['"])(\/[^'"]*)\2/g;
    while ((m = re2.exec(src))) calls.push({ method: m[1].toUpperCase(), path: m[3], file: path.relative(PUB, p) });
  }
}
walk(PUB);

const norm = (u) => '/api' + u.split('?')[0].replace(/\$\{[^}]*\}/g, ':x').replace(/\/\d+(?=\/|$)/g, '/:id');
const uniq = [...new Set(calls.map((c) => c.method + ' ' + norm(c.path)))].sort();

const wk = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'worker/routes'))) {
  if (!f.endsWith('.mjs')) continue;
  const src = fs.readFileSync(path.join(ROOT, 'worker/routes', f), 'utf8');
  const re = /\.(get|post|put|delete|patch)\(\s*'([^']*)/g;
  let m;
  while ((m = re.exec(src))) wk.add(m[1].toUpperCase() + ' ' + m[2]);
}
function match(call) {
  if (wk.has(call)) return true;
  const [m, c] = call.split(' ');
  const cs = c.split('/');
  for (const w of wk) {
    const [wm, wp] = w.split(' ');
    if (wm !== m) continue;
    const ws = wp.split('/');
    if (ws.length !== cs.length) continue;
    if (ws.every((seg, i) => seg.startsWith(':') || seg === cs[i])) return true;
  }
  return false;
}
const missing = uniq.filter((c) => !match(c));
console.log('前端调用端点(归一):', uniq.length, '｜Worker 端点:', wk.size, '｜缺失:', missing.length);
console.log(missing.join('\n'));
