#!/usr/bin/env node
/**
 * tools/_qa/patch-docx.cjs —— 按精确文本替换 docx 内容（保留格式）
 * ==================================================================
 * 为什么不用 python-docx：本机没有 Python。
 * docx 本质是 zip + word/document.xml，文本被切成 <w:t> 片段，
 * 一句完整的话常常跨多个 run（因为编辑历史不同、格式不同）。
 * 因此替换必须做到：**跨 run 的文本也能匹配并合并写回**。
 *
 * 做法：
 *   1. 解开 word/document.xml；
 *   2. 把每个 <w:p> 内的所有 <w:t> 文本拼成一个整串，并记录每个 run 的
 *      起止偏移；
 *   3. 在整串上做替换；
 *   4. 把替换后的整串按原始 run 边界重新分配（只改被影响的 run，
 *      其余 run 保持字节不变 —— 这样未涉及的格式不会被动到）。
 *
 * 局限（必须知晓）：
 *   · 只处理正文段落文字，不处理表格单元格以外的复杂结构；
 *   · 若替换跨越了「格式变化点」（同一段里一半加粗一半不加粗），
 *     合并后格式会以第一个 run 为准 —— 本文件里没有这种情形；
 *   · 不处理超链接内部的 run。
 *
 * 用法：
 *   node tools/_qa/patch-docx.cjs <docx> <patch.json> [--dry]
 * patch.json: [{ "from": "原文", "to": "新文", "expect": 1 }, ...]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILE = process.argv[2];
const PATCH = process.argv[3];
const DRY = process.argv.includes('--dry');

/* ---------------- 最小 zip 读写（仅 stored / deflate） ---------------- */
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
      entries.push({
        name, method, raw,
        data: method === 0 ? raw : zlib.inflateRawSync(raw),
        hdrStart: i, hdrEnd: ds,
      });
      i = ds + csize;
      /* 数据描述符（bit 3）在本文件里未使用；若有则需跳过 12/16 字节 */
    } else i++;
  }
  return entries;
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    /* 只有压缩后更小才用 deflate */
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const nl = Buffer.byteLength(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);           // UTF-8 名称
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);  // 时间/日期（保持不变亦可）
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nl, 26);
    lh.writeUInt16LE(0, 28);
    const nameBuf = Buffer.from(e.name, 'utf8');
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nl, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += 30 + nl + body.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/* ---------------- XML 文本替换 ---------------- */
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 在单个 <w:p>…</w:p> 内做跨 run 替换。
 * 返回 { xml, hits }
 */
function replaceInParagraph(pXml, pairs, applied) {
  /* 收集所有 <w:t ...>text</w:t> 的位置与内容 */
  const runs = [];
  const re = /<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(pXml)) !== null) {
    runs.push({
      start: m.index,
      end: re.lastIndex,
      openTag: m[0].slice(0, m[0].indexOf('>') + 1),
      text: m[2],
      textStart: m.index + m[0].indexOf('>') + 1,
      textEnd: re.lastIndex - '</w:t>'.length,
    });
  }
  if (!runs.length) return { xml: pXml, hits: 0 };

  let full = runs.map((r) => r.text).join('');
  let hits = 0;

  for (const pr of pairs) {
    if (!full.includes(pr.from)) continue;
    /* 只替换已应用次数未达 expect 的 */
    const done = applied.get(pr.from) || 0;
    if (pr.expect !== undefined && done >= pr.expect) continue;
    full = full.replace(pr.from, pr.to);
    applied.set(pr.from, done + 1);
    hits++;
  }
  if (!hits) return { xml: pXml, hits: 0 };

  /* 把新整串按原 run 长度重新分配：保持各 run 的格式，
   * 长度差全部落在最后一个受影响的 run 上。 */
  let pos = 0;
  let out = '';
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    out += pXml.slice(cursor, r.textStart);
    const remainLen = full.length - pos;
    const take = i === runs.length - 1 ? remainLen : Math.min(r.text.length, Math.max(0, remainLen));
    out += escXml(full.slice(pos, pos + take));
    pos += take;
    cursor = r.textEnd;
  }
  out += pXml.slice(cursor);
  return { xml: out, hits };
}

function main() {
  const buf = fs.readFileSync(FILE);
  const entries = readZip(buf);
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  if (!docEntry) throw new Error('word/document.xml 不存在');

  let xml = docEntry.data.toString('utf8');
  const pairs = JSON.parse(fs.readFileSync(PATCH, 'utf8'));
  const applied = new Map();

  /* 逐段落处理：<w:p ...>…</w:p>（注意自闭合 <w:p/>） */
  xml = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (pXml) => {
    const r = replaceInParagraph(pXml, pairs, applied);
    return r.xml;
  });

  console.log('替换结果：');
  let miss = 0;
  for (const pr of pairs) {
    const n = applied.get(pr.from) || 0;
    const exp = pr.expect === undefined ? 1 : pr.expect;
    const ok = n === exp;
    if (!ok) miss++;
    console.log(`  ${ok ? '✔' : '✘'} 命中 ${n}/${exp}  ${pr.from.slice(0, 42).replace(/\n/g, ' ')}…`);
  }

  if (DRY) { console.log('\n[dry-run] 未写文件'); process.exit(miss ? 1 : 0); }

  docEntry.data = Buffer.from(xml, 'utf8');
  const outBuf = writeZip(entries);
  fs.writeFileSync(FILE, outBuf);
  console.log(`\n已写入 ${path.basename(FILE)}（${(outBuf.length / 1024).toFixed(0)} KB）`);
  process.exit(miss ? 1 : 0);
}

main();
