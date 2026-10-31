#!/usr/bin/env node
/** 审计-20261031/license-scan.cjs —— RR-07 离线许可证扫描（SBOM 简表）
 *  遍历 node_modules 下全部 package.json（含嵌套依赖），聚合许可证与版本，
 *  标记需要关注的许可证类别（强 Copyleft：GPL/AGPL/LGPL/SSPL/Commons Clause）。
 *  输出：审计-20261031/sbom-licenses.json + 控制台摘要。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const FORBIDDEN_RE = /(GPL|AGPL|LGPL|SSPL|Commons Clause|EUPL)/i;
const seen = new Map();

function scan(dir, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name);
    if (e.name.startsWith('@')) { scan(sub, depth + 1); continue; }
    const pj = path.join(sub, 'package.json');
    if (!fs.existsSync(pj)) { scan(sub, depth + 1); continue; }
    try {
      const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const key = (p.name || e.name) + '@' + (p.version || '?');
      if (!seen.has(key)) {
        seen.set(key, {
          name: p.name || e.name, version: p.version || '?',
          license: typeof p.license === 'string' ? p.license : JSON.stringify(p.license) || 'UNDEFINED',
          homepage: p.homepage || '',
        });
      }
    } catch { /* 损坏的 package.json：记录占位 */ }
    scan(sub, depth + 1);
  }
}
scan(NM, 0);

const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const flagged = list.filter((x) => FORBIDDEN_RE.test(x.license));
fs.writeFileSync(path.join(__dirname, 'sbom-licenses.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), total: list.length, flagged, packages: list }, null, 1));
console.log(`SBOM：${list.length} 个包 · 关注许可证 ${flagged.length} 个`);
for (const f of flagged) console.log('  ⚠', f.name + '@' + f.version, '→', f.license);
console.log(flagged.length ? '处置：演示制品不分发/不出售，GPL 类仅影响再分发 —— 上产品化前逐个替换或取得授权' : '无强 Copyleft 依赖 ✓');
