/* 从源码静态抽取路由表：mount 前缀来自 app.js，方法+路径来自各 route 文件。
 * 比 require 整个 app 更稳（避免触发链实例、定时器等副作用）。 */
const fs = require('fs');
const path = require('path');
const SRV = path.join(__dirname, '..', '..', 'server');
const appSrc = fs.readFileSync(path.join(SRV, 'app.js'), 'utf8');

const mounts = [];
for (const m of appSrc.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*require\('\.\/routes\/([\w-]+)'\)\s*\)/g)) {
  mounts.push({ prefix: m[1], file: m[2] });
}
const out = [];
for (const { prefix, file } of mounts) {
  const f = path.join(SRV, 'routes', file + '.js');
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/router\.(get|post|put|delete|patch)\(\s*'([^']*)'/g)) {
    out.push({ method: m[1].toUpperCase(), path: (prefix + m[2]).replace(/\/$/, '') || '/' , file });
  }
}
const uniq = [...new Map(out.map(r => [r.method + ' ' + r.path, r])).values()];
fs.writeFileSync(path.join(__dirname, 'routes.json'), JSON.stringify(uniq, null, 1), 'utf8');
console.log('mounts:', mounts.length, 'routes:', uniq.length);
for (const r of uniq.filter(x => /enterprise|verifier|admin|trade|credit/.test(x.path)).slice(0, 60)) {
  console.log(r.method.padEnd(6), r.path);
}
