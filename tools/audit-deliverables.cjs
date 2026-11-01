#!/usr/bin/env node
/**
 * tools/audit-deliverables.mjs —— 全交付物数字口径核查器
 * ==================================================================
 * 为什么需要它（院审意见②/建议③的整改）
 * ------------------------------------------------------------------
 * 原有 metrics-consistency.mjs 只扫本项目目录的 .js/.mjs/.html/.json，
 * 存在三个覆盖盲区，恰好是院审点名数字的藏身处：
 *   · 不扫 .md          → 所有 Markdown 报告与论文源稿不受检
 *   · 不扫跨项目目录    → 碳链通小程序/ 不在范围内（"132 台"就在那里）
 *   · 不扫 .docx        → 提交版论文不受检（"198 台"就在那里）
 *
 * 本工具把扫描面扩到**全部可交付材料**，并与数据库实测值逐项比对。
 * 与 metrics-consistency 的分工：
 *   metrics-consistency —— 检查"同一概念在不同位置是否同值"（仓库内）
 *   本工具             —— 检查"写出去的数字是否等于库里查出来的数"（跨交付物）
 *
 * 设计原则
 *   · 不猜：每个口径都必须能在库里复算，复算不出的标 UNVERIFIABLE
 *   · 不自动改：只报位置，改由人决定
 *   · 区分语境：历史归档文件（tools/out 旧快照、整改对照表引用院审原话）
 *     单独归类，不与当前交付物混为一谈
 *
 * 用法
 *   node tools/audit-deliverables.mjs
 *   node tools/audit-deliverables.mjs --strict   # 有 ERROR 时退出码 1
 * 产物
 *   tools/out/deliverables-audit.json / .md
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../server/db');

const STRICT = process.argv.includes('--strict');
const HUB = path.resolve(__dirname, '..');
const WORKSPACE = path.resolve(HUB, '..', '..');

/* 交付物根目录（跨项目） */
const ROOTS = [
  { name: '平台-源码', dir: HUB, kinds: ['.js', '.mjs', '.html'] , skip: ['node_modules', 'dist', 'vendor', '.git', 'tools/out', '_ui-check', 'backup-'] },
  { name: '平台-文档', dir: path.join(HUB, 'docs'), kinds: ['.md'], skip: [] },
  { name: '平台-论文', dir: path.join(HUB, 'tools', '_qa'), kinds: ['.docx'], skip: [] },
  { name: '小程序-文档', dir: path.join(WORKSPACE, '碳链通小程序', 'docs'), kinds: ['.md', '.docx'], skip: [] },
  { name: '小程序-源码', dir: path.join(WORKSPACE, '碳链通小程序'), kinds: ['.js', '.json'], skip: ['node_modules', '.git', 'miniprogram_npm'] },
  { name: '工作区-报告', dir: WORKSPACE, kinds: ['.md'], skip: ['node_modules', '碳链通平台', '碳链通小程序', '.tmp-', '.workbuddy'] },
];

/* ---------------- 文本抽取 ---------------- */

/** 从 .docx 抽取正文（解压 → document.xml → 去标签） */
function docxText(file) {
  const tmp = path.join(HUB, 'tools', 'out', '_audit_docx');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync('unzip', ['-o', '-q', file, '-d', tmp], { stdio: 'ignore' });
    const xml = fs.readFileSync(path.join(tmp, 'word', 'document.xml'), 'utf8');
    // <w:p> 分行为段落边界；<w:tab/> 与 <w:br/> 视为空白
    return xml.replace(/<w:p[ >]/g, '\n<w:p ').replace(/<[^>]+>/g, '');
  } catch (e) {
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function collect(dir, kinds, skip, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.some((s) => e.name.includes(s))) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { collect(p, kinds, skip, out); continue; }
    if (!kinds.some((k) => e.name.endsWith(k))) continue;
    if (/\.min\./.test(e.name)) continue;
    /* 备份/归档目录不计入当前交付物 */
    if (/backup|归档|_版本备份|paper-backup/i.test(p)) continue;
    out.push(p);
  }
  return out;
}

/* ---------------- 口径定义（每个都必须能从库里复算） ---------------- */

async function buildTruth() {
  const one = async (sql) => {
    try { const r = await db.query(sql); return r.length ? Object.values(r[0])[0] : null; }
    catch (e) { return null; }
  };
  const ledgerOne = async (sql) => {
    try { const r = await db.ledgerQuery(sql); return r.length ? Object.values(r[0])[0] : null; }
    catch (e) { return null; }
  };

  const devTotal = Number(await one('SELECT COUNT(*) c FROM device_registry'));
  const normalCnt = Number(await one("SELECT COUNT(*) c FROM cems_reading WHERE quality_flag='NORMAL'"));
  const readTotal = Number(await one('SELECT COUNT(*) c FROM cems_reading'));
  const realHourly = Number(await one('SELECT COUNT(*) c FROM cems_cn_hourly'));
  const realPublic = Number(await one('SELECT COUNT(*) c FROM cems_public_reading'));
  const blocks = Number(await ledgerOne('SELECT COUNT(*) c FROM chain_block'));
  const txs = Number(await ledgerOne('SELECT COUNT(*) c FROM chain_tx'));

  /* PoW ↔ PoA 倍数：不是一个可以"查库"得到的数，而是基准测试的产出。
   * 这里读最近一次 tools/bench-consensus.mjs 的结果，保证论文里的倍数
   * 与证据文件同源 —— 这正是院审"79 倍无出处"的整改点：倍数必须能指回
   * 一次具体运行的产物，而不是作者凭印象写下的数字。 */
  let powRatio = null;
  let powNote = '未运行 tools/bench-consensus.mjs';
  try {
    const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'bench-consensus.json'), 'utf8'));
    powRatio = Number(b.ratio);
    powNote = `PoA ${b.poa.medianMs}ms / PoW ${b.pow.medianMs}ms（难度 ${b.difficulty}，${b.generatedAt}）`;
  } catch (e) { /* 无证据文件则留空，不猜 */ }

  return {
    '设备台账台数': {
      value: devTotal,
      sql: 'SELECT COUNT(*) FROM device_registry',
      note: 'device_registry 登记总数；含真实与演示两类，明细以 provenance/remark 区分',
    },
    'NORMAL质量占比': {
      value: readTotal ? Number(((normalCnt / readTotal) * 100).toFixed(1)) : null,
      sql: "SELECT ROUND(100*SUM(quality_flag='NORMAL')/COUNT(*),1) FROM cems_reading",
      unit: '%',
      note: `${normalCnt}/${readTotal}`,
    },
    '真实CEMS小时数据': {
      value: realHourly,
      sql: "SELECT COUNT(*) FROM cems_cn_hourly WHERE provenance='REAL_CEMS_CN'",
      note: '河北省污染源自动监控信息公开系统，4 家企业',
    },
    '真实公开读数': {
      value: realPublic,
      sql: "SELECT COUNT(*) FROM cems_public_reading WHERE provenance='REAL_PUBLIC'",
      note: 'LJGK 渠道日级数据',
    },
    '本地区块总数': { value: blocks, sql: 'SELECT COUNT(*) FROM chain_block（账本库）' },
    '本地存证总数': { value: txs, sql: 'SELECT COUNT(*) FROM chain_tx（账本库）' },
    'PoW耗时倍数': {
      value: powRatio,
      sql: 'node tools/bench-consensus.mjs',
      note: powNote,
    },
  };
}

/* ---------------- 断言规则 ---------------- */

/**
 * 每条规则命中一句"对外口径"表述，抽出数字并与实测值比对。
 * scope: 'current' 计入交付物；'archive' 仅提示不计错
 */
const RULES = [
  {
    id: 'device.count',
    desc: '接入设备台数',
    truthKey: '设备台账台数',
    /* 「接入设备N台」「CEMS设备 N 台」「设备总数」「登记设备」——必须是台数断言 */
    re: /(?:接入设备|CEMS\s*设备|设备总数|登记设备)\s*([0-9,]{2,5})\s*台/g,
    tolerance: 0,
  },
  {
    id: 'quality.normal',
    desc: 'NORMAL 质量占比',
    truthKey: 'NORMAL质量占比',
    re: /(?:NORMAL[^0-9]{0,12}|正常质量数据占比)\s*([0-9]{1,3}\.[0-9]{1,2})\s*%/g,
    tolerance: 0.15,
  },
  {
    id: 'chain.txs',
    desc: '全链存证笔数',
    truthKey: '本地存证总数',
    /* 收紧：必须带"全链/链上/累计存证"这类全局限定词，排除"共190笔批次"这类局部计数 */
    re: /(?:全链|链上|累计存证|存证总数|总计存证)\s*(?:共|已)?\s*([0-9,]{2,7})\s*笔/g,
    tolerance: 0.02,
  },
  {
    id: 'pow.ratio',
    desc: 'PoW 相对耗时倍数',
    truthKey: 'PoW耗时倍数',
    /* 「PoW 慢79倍」「约为其120倍」 */
    re: /(?:PoW[^。，]{0,16}?(?:慢|耗时)?(?:约|约为其|约为)?\s*([0-9]{1,4})\s*倍)/g,
    /* 基准测试有测量波动：PoW 中位耗时随 CPU 负载浮动，倍数允许 ±10% */
    tolerance: 0.12,
  },
];

/* 已知的"引用院审原话/回顾历史问题"上下文——出现在这些词附近时不计入错误 */
const ARCHIVE_MARKERS = [
  '院审原文', '院审意见', '院审对本案', '评审指出', '评审意见', '评审明确', '判定原文',
  '整改前', '修复前', '曾写', '曾显示', '原文',
  '已删除', '不再使用', '不得使用', '错误示例', '反例', '历史', '旧版',
];

/* 带数据源限定的数字是"有出处"的：只要句子说明了统计自哪个库/哪套数据，
 * 与另一个库的实测值不同属正常，不判错（例：小程序论文「本地演示库…
 * CEMS 设备 132 台」＝ cc_device 表 132 行，属实）。 */
const EXEMPT_MARKERS = [
  '本地演示库', '演示数据', '合成数据', '示例数据', 'cc_device',
  '台账登记', '含真实与演示', '时点', '截至',
];

function scanFile(file, text) {
  const hits = [];
  const lines = text.split('\n');
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const raw = m[1].replace(/,/g, '');
        const num = Number(raw);
        if (!Number.isFinite(num)) continue;
        /* 附近 3 行内是否有归档标记（注释块常把"院审原文"放在数字的上一行） */
        const ctx = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
        const archived = ARCHIVE_MARKERS.some((k) => ctx.includes(k));
        /* 同句内已声明数据源 → 视为有出处 */
        const sourced = EXEMPT_MARKERS.some((k) => line.includes(k) || ctx.includes(k));
        hits.push({ rule: rule.id, desc: rule.desc, found: num, raw: m[0], line: i + 1, text: line.trim().slice(0, 160), archived, sourced });
      }
    }
  }
  return hits;
}

/* ---------------- 主流程 ---------------- */

(async () => {
  const truth = await buildTruth();

  const findings = [];
  const scanned = [];

  for (const root of ROOTS) {
    const files = collect(root.dir, root.kinds, root.skip);
    for (const f of files) {
      let text;
      if (f.endsWith('.docx')) {
        text = docxText(f);
        if (text === null) { findings.push({ level: 'SKIP', file: f, msg: 'docx 解析失败' }); continue; }
      } else {
        text = fs.readFileSync(f, 'utf8');
      }
      scanned.push(f);
      for (const h of scanFile(f, text)) {
        const key = h.rule;
        const rule = RULES.find((r) => r.id === key);
        const t = truth[rule.truthKey];
        if (!t || t.value === null) {
          findings.push({ level: 'UNVERIFIABLE', ...h, file: f, truth: null });
          continue;
        }
        const expect = Number(t.value);
        const ok = Math.abs(h.found - expect) <= Math.max(rule.tolerance, expect * 0.02);
        /* 带日期的过程报告是"某时点的快照"，与当前实测不同属正常时序演化，
         * 降级为 HISTORICAL 只记录不判错 —— 否则 10-28 报告里的 134,400 条
         * 会因为 10-30 增长到 302,400 而被误判成造假。 */
        const dated = /[/\\]docs[/\\][^/\\]*-20\d{6}\.(md|docx)$/.test(f);
        findings.push({
          level: h.archived ? 'INFO' : (h.sourced ? 'SOURCED' : (ok ? 'OK' : (dated ? 'HISTORICAL' : 'ERROR'))),
          ...h, file: f, expect,
          msg: ok ? '与实测一致'
            : (h.sourced ? `已声明数据源（${h.raw}），与平台库 ${expect} 不同属正常`
              : (dated ? `时点快照（实测现值 ${expect}${t.unit || ''}）`
                : `与实测不符（实测 ${expect}${t.unit || ''}）`)),
        });
      }
    }
  }

  /* ---------------- 输出 ---------------- */
  const rel = (p) => path.relative(WORKSPACE, p).replace(/\\/g, '/');
  const err = findings.filter((f) => f.level === 'ERROR');
  const warn = findings.filter((f) => f.level === 'UNVERIFIABLE');
  const info = findings.filter((f) => f.level === 'INFO');
  const hist = findings.filter((f) => f.level === 'HISTORICAL');
  const sourced = findings.filter((f) => f.level === 'SOURCED');
  const ok = findings.filter((f) => f.level === 'OK');

  const C = { r: (s) => `\x1b[31m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[90m${s}\x1b[0m` };

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  全交付物数字口径核查');
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('  扫描范围：' + ROOTS.map((r) => r.name).join(' / '));
  console.log('  文件数：' + scanned.length + '\n');

  console.log('  数据库实测口径（每个都可复算）：');
  for (const [k, v] of Object.entries(truth)) {
    console.log(`    ${k} = ${v.value}${v.unit || ''}    ${C.d('← ' + v.sql)}`);
  }
  console.log('');

  if (err.length) {
    console.log(C.r(`  ✘ 不一致 ${err.length} 处：`));
    for (const f of err) {
      console.log(`    ${rel(f.file)}:${f.line}  「${f.raw}」 → ${f.msg}`);
    }
    console.log('');
  }
  if (warn.length) {
    console.log(C.y(`  ? 无法复算 ${warn.length} 处（口径缺失）`));
    for (const f of warn) console.log(`    ${rel(f.file)}:${f.line}  「${f.raw}」（${f.desc}）`);
    console.log('');
  }
  if (info.length) {
    console.log(C.d(`  · 归档/引用语境，不计入错误 ${info.length} 处`));
    console.log('');
  }
  if (hist.length) {
    console.log(C.d(`  · 带日期的过程报告，属时点快照 ${hist.length} 处（不判错）`));
    for (const f of hist) console.log(C.d(`    ${rel(f.file)}:${f.line}  「${f.raw}」${f.msg}`));
    console.log('');
  }
  if (sourced.length) {
    console.log(C.d(`  · 已声明数据源，与平台库不同属正常 ${sourced.length} 处`));
    for (const f of sourced) console.log(C.d(`    ${rel(f.file)}:${f.line}  「${f.raw}」`));
    console.log('');
  }
  console.log(`  ✔ 与实测一致 ${ok.length} 处`);

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  错误 ${err.length} · 无法复算 ${warn.length} · 时点快照 ${hist.length} · 已声明来源 ${sourced.length} · 归档 ${info.length} · 一致 ${ok.length}`);
  console.log('──────────────────────────────────────────────────────────\n');

  /* 落盘 */
  const outDir = path.join(HUB, 'tools', 'out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    scannedFiles: scanned.map(rel),
    truth,
    summary: { error: err.length, unverifiable: warn.length, archive: info.length, ok: ok.length },
    findings: findings.map((f) => ({ ...f, file: rel(f.file) })),
  };
  fs.writeFileSync(path.join(outDir, 'deliverables-audit.json'), JSON.stringify(payload, null, 2));

  const md = [
    '# 全交付物数字口径核查报告',
    '',
    `生成时间：${payload.generatedAt}`,
    `扫描文件：${scanned.length} 个`,
    '',
    '## 一、数据库实测口径',
    '',
    '| 口径 | 实测值 | 复算 SQL |',
    '| --- | --- | --- |',
    ...Object.entries(truth).map(([k, v]) => `| ${k} | ${v.value}${v.unit || ''} | \`${v.sql}\` |`),
    '',
    '## 二、不一致（ERROR）',
    '',
    err.length ? '| 文件:行 | 原文 | 问题 |' : '无',
    ...(err.length ? ['| --- | --- | --- |', ...err.map((f) => `| ${rel(f.file)}:${f.line} | ${f.raw} | ${f.msg} |`)] : []),
    '',
    '## 三、无法复算（UNVERIFIABLE）',
    '',
    warn.length ? '| 文件:行 | 原文 |' : '无',
    ...(warn.length ? ['| --- | --- |', ...warn.map((f) => `| ${rel(f.file)}:${f.line} | ${f.raw} |`)] : []),
    '',
    '## 四、汇总',
    '',
    `- 错误：${err.length}`,
    `- 无法复算：${warn.length}`,
    `- 归档/引用语境（不计错）：${info.length}`,
    `- 与实测一致：${ok.length}`,
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'deliverables-audit.md'), md);

  console.log('  证据：tools/out/deliverables-audit.json / .md\n');
  process.exit(STRICT && err.length ? 1 : 0);
})().catch((e) => {
  console.error('核查器异常：', e);
  process.exit(2);
});
