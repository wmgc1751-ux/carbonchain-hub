/* 盘点论文中与当前实现不符的表述出现次数与上下文 */
const fs = require('fs');
const zlib = require('zlib');

const FILE = process.argv[2];
const buf = fs.readFileSync(FILE);

function findEntry(b, name) {
  for (let i = 0; i < b.length - 4; i++) {
    if (b.readUInt32LE(i) === 0x04034b50) {
      const nl = b.readUInt16LE(i + 26);
      const el = b.readUInt16LE(i + 28);
      const fn = b.slice(i + 30, i + 30 + nl).toString('utf8');
      const cs = b.readUInt32LE(i + 18);
      const ds = i + 30 + nl + el;
      if (fn === name) return { data: b.slice(ds, ds + cs), method: b.readUInt16LE(i + 8) };
    }
  }
  return null;
}

const e = findEntry(buf, 'word/document.xml');
const xml = e.method === 0 ? e.data.toString('utf8') : zlib.inflateRawSync(e.data).toString('utf8');

/* 按段落切分，保留每段纯文本 */
const paras = xml.split(/<w:p[ >]/).map((p) => p.replace(/<[^>]+>/g, '').trim()).filter(Boolean);

const targets = process.argv.slice(3);
for (const t of targets) {
  const hits = paras.filter((p) => p.includes(t));
  console.log(`\n=== "${t}" 命中 ${hits.length} 段 ===`);
  hits.slice(0, 6).forEach((p, i) => {
    const idx = p.indexOf(t);
    const s = Math.max(0, idx - 60);
    console.log(`  [${i + 1}] …${p.slice(s, idx + t.length + 90)}…`);
  });
}
