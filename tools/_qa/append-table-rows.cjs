#!/usr/bin/env node
/**
 * tools/_qa/append-table-rows.cjs —— 向 docx 指定表格追加行（复制末行格式）
 * 用法：
 *   node append-table-rows.cjs <docx> <tableIndex 1-based> <rows.json>
 * rows.json: [["①","列2","列3"], ...]
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const FILE = process.argv[2];
const TIDX = Number(process.argv[3]);
const ROWS = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));

function readZip(buf) {
  const entries = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) === 0x04034b50) {
      const method = buf.readUInt16LE(i + 8);
      const csize = buf.readUInt32LE(i + 18);
      const nl = buf.readUInt16LE(i + 26);
      const el = buf.readUInt16LE(i + 28);
      const name = buf.slice(i + 30, i + 30 + nl).toString('utf8');
      const ds = i + 30 + nl + el;
      const raw = buf.slice(ds, ds + csize);
      entries.push({ name, method, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
      i = ds + csize;
    } else i++;
  }
  return entries;
}

let T = null;
function crc32(b) {
  if (!T) {
    T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ T[(c ^ b[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data;
    const def = zlib.deflateRawSync(data, { level: 9 });
    const useDef = def.length < data.length;
    const body = useDef ? def : data;
    const method = useDef ? 8 : 0;
    const crc = crc32(data);
    const nl = Buffer.byteLength(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nl, 26);
    locals.push(lh, Buffer.from(e.name, 'utf8'), body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nl, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, Buffer.from(e.name, 'utf8'));
    offset += 30 + nl + body.length;
  }
  const lb = Buffer.concat(locals), cb = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cb.length, 12); eocd.writeUInt32LE(lb.length, 16);
  return Buffer.concat([lb, cb, eocd]);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const buf = fs.readFileSync(FILE);
const entries = readZip(buf);
const doc = entries.find((e) => e.name === 'word/document.xml');
let xml = doc.data.toString('utf8');

const tblRe = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
let m, idx = 0, target = null;
while ((m = tblRe.exec(xml)) !== null) {
  idx++;
  if (idx === TIDX) { target = { start: m.index, end: m.index + m[0].length, body: m[0] }; break; }
}
if (!target) throw new Error(`第 ${TIDX} 张表不存在`);

/* 取最后一行作为模板 */
const trs = [...target.body.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)];
if (!trs.length) throw new Error('表格无数据行，无法推断格式');
const tpl = trs[trs.length - 1][0];
const tcs = [...tpl.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((x) => x[0]);
if (tcs.length !== ROWS[0].length) {
  throw new Error(`模板列数 ${tcs.length} 与新行字段数 ${ROWS[0].length} 不一致`);
}

function buildRow(values) {
  let row = tpl;
  /* 逆序替换每个 tc 里的文本，避免偏移错乱 */
  const cells = [...tpl.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)];
  const parts = [];
  let cursor = 0;
  cells.forEach((c, i) => {
    parts.push(tpl.slice(cursor, c.index));
    let cellXml = c[0];
    /* 替换该单元格内第一个 <w:t>…</w:t> 的文本，其余 <w:t> 清空 */
    let first = true;
    cellXml = cellXml.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, (tt) => {
      const open = tt.slice(0, tt.indexOf('>') + 1);
      const t = first ? esc(values[i]) : '';
      first = false;
      return `${open}${t}</w:t>`;
    });
    /* 若该 cell 没有任何 <w:t>（空单元格），插入一个 */
    if (!/<w:t[\s>]/.test(c[0])) {
      cellXml = cellXml.replace(/<\/w:p>/, `<w:r><w:t>${esc(values[i])}</w:t></w:r></w:p>`);
    }
    /* 去掉重复的 paraId，避免 Word 报冲突 */
    cellXml = cellXml.replace(/w14:paraId="[0-9A-F]{8}"/g, '');
    parts.push(cellXml);
    cursor = c.index + c[0].length;
  });
  parts.push(tpl.slice(cursor));
  row = parts.join('');
  return row.replace(/w14:paraId="[0-9A-F]{8}"/g, '');
}

const newRows = ROWS.map(buildRow).join('');
const newTable = target.body.replace(/(<\/w:tbl>)$/, newRows + '$1');
xml = xml.slice(0, target.start) + newTable + xml.slice(target.end);

doc.data = Buffer.from(xml, 'utf8');
fs.writeFileSync(FILE, writeZip(entries));
console.log(`已向第 ${TIDX} 张表追加 ${ROWS.length} 行`);
