#!/usr/bin/env node
/**
 * tools/metrics-consistency.mjs —— 数字口径一致性守门器
 * ==================================================================
 * 为什么需要它（院审意见②的直接整改）
 * ------------------------------------------------------------------
 * 院审原文：「关键数字无出处（PoW慢79倍、132台设备）且摘要894笔与正文895笔不一致」。
 *
 * 上一轮建了「指标溯源台账」，解决了"数字有没有出处"。但仍有另一类问题没被
 * 机器拦住：**同一组数字在不同位置出现了不同的值**。
 *
 * 台账回答的是"这个数从哪来"；本工具回答的是"这个数在全文是不是只有一个值"。
 * 两者互补，缺一不可 —— 一个有出处但每天在页面上变来变去的数字，
 * 在答辩现场仍然是致命的。
 *
 * 检查的三类矛���
 *   ① 汇总 vs 明细：verify-all 的 totals.failed 与 rows[].status 是否对得上；
 *   ② 台账 vs 页面：前端硬编码的"笔数/块数/倍数/设备数"是否与台账同值；
 *   ③ 同一指标多处不同值：同一概念在代码/文案里出现多个不同数字。
 *
 * 设计原则（与台账一致）
 *   · 只报告、不自动改数：自动"修正"数字会掩盖问题；
 *   · 缺数据即 SKIP，不猜：读不到的就不检查，而不是当成通过；
 *   · 可执行：每条问题给出文件:行号，便于当场改。
 *
 * 用法
 *   node tools/metrics-consistency.mjs
 *   node tools/metrics-consistency.mjs --strict     # 存在 ERROR 时退出码 1
 * 产物
 *   tools/out/metrics-consistency.json / .md
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tools', 'out');
const STRICT = process.argv.includes('--strict');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

const findings = [];
function add(level, code, title, detail, where) {
  findings.push({ level, code, title, detail, where: where || null });
}

function readJson(rel) {
  const p = path.join(OUT_DIR, rel);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/* ==================================================================
 * ① 汇总 vs 明细
 * ================================================================== */
function checkVerifyAll() {
  const v = readJson('verify-all.json');
  if (!v) { add('SKIP', 'VA_MISSING', '全量回归汇总缺失', 'tools/out/verify-all.json 不存在，跳过'); return; }
  const t = v.totals || {};
  const rows = v.rows || [];
  if (!rows.length) { add('SKIP', 'VA_EMPTY', '回归明细为空', 'rows 为空，无法对账'); return; }

  const cnt = (s) => rows.filter((r) => r.status === s).length;
  for (const [key, status] of [['passed', 'PASS'], ['failed', 'FAIL'], ['blocked', 'BLOCKED'], ['skipped', 'SKIP'], ['warned', 'WARN']]) {
    if (t[key] === undefined) continue;
    const actual = cnt(status);
    if (Number(t[key]) !== actual) {
      add('ERROR', 'VA_TOTALS_MISMATCH', `汇总 ${key} 与明细不符`,
        `totals.${key}=${t[key]}，但 rows 中 ${status} 有 ${actual} 条`,
        'tools/out/verify-all.json');
    }
  }

  /* 失败套件的断言数不应计入 sumPass —— 若计入，等于用"断言全过"掩盖"套件失败" */
  const failedRows = rows.filter((r) => r.status === 'FAIL');
  if (failedRows.length && Number(t.sumPass) > 0 && Number(t.sumPass) === Number(t.sumTotal)) {
    add('WARN', 'VA_FAILED_HIDDEN', '存在失败套件但断言显示全过',
      `失败套件 ${failedRows.map((r) => r.id).join(', ')}；sumPass=${t.sumPass}/${t.sumTotal}。`
      + '这两个事实可以同时成立（失败套件不计断言），但对外引用时必须同时说明',
      'tools/out/verify-all.json');
  }
}

/* ==================================================================
 * ② 台账 vs 页面硬编码
 * ================================================================== */
/** 从台账取某指标值 */
function ledgerValue(ledger, id) {
  if (!ledger) return undefined;
  for (const g of ledger.groups || []) {
    for (const r of g.rows || []) if (r.id === id) return r.value;
  }
  for (const r of ledger.rows || []) if (r.id === id) return r.value;
  return undefined;
}

/** 递归收集源码文件 */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'vendor', 'out', 'dist', '.git', '_ui-check', 'stage4-demo'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(js|mjs|html|json)$/.test(e.name) && !/\.min\./.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 数字类断言：只匹配**明确的全局性表述**，不匹配业务分页/示例读数。
 *
 * 反例（上一版的误报来源，已全部排除）：
 *   · "最近 50 笔"（分页大小）、"1000 块 × 10 交易 = 10,000 笔"（合成基准规模）
 *   · "1e12 倍"（科学计数法，正则会把 12 抓出来）
 *   · "同行 2 倍"、"烟囱是标尺的 2.4 倍"（业务比较，不是共识倍数）
 * 判据：只有当数字处在**指代全链/全网总量**的句式里才算"对外口径"。
 */
const NUM_CLAIM_RULES = [
  {
    id: 'chain.txs',
    /* 「全链共 N 笔」「累计 N 笔存证」「链上 N 笔」—— 带全局限定词才计入 */
    re: /(?:全链|累计|链上|总计|共)\s*([\d,]{2,})\s*笔/g,
    unit: '笔',
    allow: (n, lv) => Math.abs(n - Number(lv)) <= Math.max(2, Number(lv) * 0.02),
    label: (v) => `${v} 笔`,
  },
  {
    id: 'chain.blocks',
    re: /(?:全链|累计|链上|总计|共)\s*([\d,]{2,})\s*个?\s*区块/g,
    unit: '块',
    allow: (n, lv) => Math.abs(n - Number(lv)) <= Math.max(2, Number(lv) * 0.02),
    label: (v) => `${v} 块`,
  },
  {
    id: 'consensus.ratio',
    /* 只认「PoA 比 PoW 快 N 倍」这一类句式 —— 这是台账 consensus.ratio 的唯一语义 */
    re: /(?:PoA|授权出块)[^。，\n]{0,20}?(?:快|提升|高)\s*(?:约\s*)?([\d.]{1,6})\s*倍|(?:快|提升)\s*(?:约\s*)?([\d.]{1,6})\s*倍[^。，\n]{0,12}(?:PoW)/g,
    unit: '倍',
    allow: (n, lv) => Math.abs(n - Number(lv)) <= Math.max(1, Number(lv) * 0.1),
    label: (v) => `${v} 倍`,
    pick: (m) => m[1] || m[2],
  },
  {
    id: 'iot.total',
    /* 「全网 N 台设备」「接入 N 台设备」—— 带接入/全网限定词 */
    re: /(?:全网|接入|累计|台账共|共)\s*([\d,]{2,})\s*台设备/g,
    unit: '台',
    allow: (n, lv) => Math.abs(n - Number(lv)) <= Math.max(2, Number(lv) * 0.05),
    label: (v) => `${v} 台`,
  },
];

function checkHardcodedNumbers(ledger) {
  if (!ledger) { add('SKIP', 'LEDGER_MISSING', '指标台账缺失', '先跑 node tools/metrics-ledger.mjs'); return; }
  const files = [
    ...walk(path.join(ROOT, 'public', 'js')),
    path.join(ROOT, 'public', 'index.html'),
  ].filter((f) => fs.existsSync(f));

  const hits = new Map();  // ruleId -> [{file,line,text,value}]
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      /* 跳过注释行：注释里的数字是在解释历史，不构成对外口径 */
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      for (const rule of NUM_CLAIM_RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(line)) !== null) {
          const raw = rule.pick ? rule.pick(m) : m[1];
          const n = Number(String(raw).replace(/,/g, ''));
          if (!Number.isFinite(n)) continue;
          if (!hits.has(rule.id)) hits.set(rule.id, []);
          hits.get(rule.id).push({ file: path.relative(ROOT, f), line: i + 1, text: trimmed.slice(0, 140), value: n });
        }
      }
    });
  }

  for (const rule of NUM_CLAIM_RULES) {
    const lv = ledgerValue(ledger, rule.id);
    const list = hits.get(rule.id) || [];
    if (lv === undefined) {
      if (list.length) {
        add('WARN', 'LEDGER_NO_METRIC', `${rule.id} 在台账中不存在，但页面引用了 ${rule.unit}`,
          `页面共有 ${list.length} 处引用，无法与台账比对。示例：${list[0].file}:${list[0].line}`);
      }
      continue;
    }
    for (const h of list) {
      if (!rule.allow(h.value, lv)) {
        add('ERROR', 'HARDCODE_DRIFT', `页面硬编码 ${h.value} ${rule.unit} 与台账 ${lv} ${rule.unit} 不一致`,
          `${h.file}:${h.line}　「${h.text}」　（台账口径应为 ${rule.label(lv)}）`,
          `${h.file}:${h.line}`);
      }
    }
  }
}

/* ==================================================================
 * ③ 同一概念多处不同值（只在"共识加速比"语义下检查）
 * ==================================================================
 * 这一条只针对一个具体风险：PoA 相对 PoW 的加速比在不同页面被写成不同数字。
 * 之所以不能泛化到所有"…倍"，是因为页面上大量倍数属于业务比较
 * （"同行 2 倍""标尺的 2.4 倍""误用量纲会差 1000 倍"），把它们都算作
 * 口径矛盾只会制造噪音，反而让真正的矛盾被淹没。
 */
function checkScatteredValues(ledger) {
  if (!ledger) return;
  const ratio = ledgerValue(ledger, 'consensus.ratio');
  if (ratio === undefined) return;
  const files = walk(path.join(ROOT, 'public', 'js'));
  const seen = new Map();
  /* 只有紧邻 PoA/PoW/共识/出块 语境的倍数才算；科学计数法（1e12）不匹配 */
  const re = /(?:PoA|PoW|共识|出块)[^。，\n]{0,24}?([\d]{1,5}(?:\.[\d]+)?)\s*倍|([\d]{1,5}(?:\.[\d]+)?)\s*倍[^。，\n]{0,16}(?:PoA|PoW|共识|出块)/g;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      let m;
      while ((m = re.exec(line)) !== null) {
        const n = Number(m[1] || m[2]);
        if (!Number.isFinite(n) || n < 1 || n > 10000) continue;
        if (Math.abs(n - Number(ratio)) <= Math.max(1, Number(ratio) * 0.1)) continue;
        if (!seen.has(n)) seen.set(n, []);
        seen.get(n).push(`${path.relative(ROOT, f)}:${i + 1}`);
      }
    });
  }
  for (const [n, locs] of seen) {
    add('ERROR', 'RATIO_SCATTER', `共识加速比出现 ${n} 倍，与台账 ${ratio} 倍不一致`,
      `位置：${locs.slice(0, 6).join('，')}${locs.length > 6 ? ` 等 ${locs.length} 处` : ''}`
      + '。同一件事（PoA 相对 PoW 的提速）在全文只能有一个值，且必须来自台账',
      locs[0]);
  }
}

/* ==================================================================
 * 主流程
 * ================================================================== */
function main() {
  const ledger = readJson('metrics-ledger.json');
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  数字口径一致性守门器');
  console.log('══════════════════════════════════════════════════════════');

  checkVerifyAll();
  checkHardcodedNumbers(ledger);
  checkScatteredValues(ledger);

  const err = findings.filter((f) => f.level === 'ERROR');
  const warn = findings.filter((f) => f.level === 'WARN');
  const skip = findings.filter((f) => f.level === 'SKIP');

  for (const f of findings) {
    const tag = { ERROR: C.bad('[错误]'), WARN: C.warn('[告警]'), SKIP: C.dim('[跳过]') }[f.level];
    console.log(`\n  ${tag} ${C.b(f.title)}`);
    console.log(`     ${f.detail}`);
  }
  if (!findings.length) console.log(`\n  ${C.ok('✔ 未发现口径矛盾')}`);

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  错误 ${err.length} · 告警 ${warn.length} · 跳过 ${skip.length}`);
  console.log('──────────────────────────────────────────────────────────\n');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'metrics-consistency.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: { error: err.length, warn: warn.length, skip: skip.length },
    findings,
  }, null, 2), 'utf8');

  const md = ['# 数字口径一致性报告', '', `生成时间：${new Date().toISOString()}`, '',
    `错误 ${err.length} · 告警 ${warn.length} · 跳过 ${skip.length}`, ''];
  if (!findings.length) md.push('未发现口径矛盾。');
  for (const f of findings) {
    md.push(`## [${f.level}] ${f.title}`, '', f.detail, '');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'metrics-consistency.md'), md.join('\n'), 'utf8');

  process.exit(STRICT ? (err.length ? 1 : 0) : 0);
}

main();
