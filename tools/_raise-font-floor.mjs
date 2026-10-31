/* 一次性把全仓 font-size 低于 11px 的取值抬到 11px。
 * 理由：本项目字号档位是 11/12/13/15/18/22/25/32，`--fs-2xs` 本身就是 11px；
 * 散落在视图里的 9.6/10.2/10.3/10.4/10.5/10.6/10.8px 不属于任何档位，
 * 属历史遗留，中文在这个尺寸下投影与老花眼下都读不清。
 * 只改数值，不动格式与选择器。 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['public/js', 'public/css', 'public/index.html'];
const RE = /(font-size\s*:\s*)([0-9]*\.?[0-9]+)px/g;

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isFile()) { out.push(p); return out; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(p, e.name), out);
    else out.push(path.join(p, e.name));
  }
  return out;
}

const files = ROOTS.flatMap((r) => (fs.existsSync(r) ? walk(r, []) : []))
  .filter((f) => /\.(js|css|html)$/.test(f));

let total = 0;
const changed = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let n = 0;
  const out = src.replace(RE, (m, p1, num) => {
    if (Number(num) >= 11) return m;
    n += 1;
    return `${p1}11px`;
  });
  if (n) { fs.writeFileSync(f, out, 'utf8'); total += n; changed.push(`${f} ×${n}`); }
}
console.log('raised', total);
console.log(changed.join('\n'));
