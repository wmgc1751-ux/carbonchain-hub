/* =====================================================================
   content-audit.mjs —— 内容合规扫描（占位符 / 乱码 / 术语 / 排版瑕疵）
   ---------------------------------------------------------------------
   解决的问题：代码能跑、按钮能点，但页面上留着 TODO、"测试测试"、
   Lorem ipsum、半角逗号夹在中文里、同一概念三种叫法 —— 这类东西
   机器不报错，人一眼就看出"没做完"。

   纯静态扫描，不启浏览器、不连数据库，可随时复跑：
     node tools/content-audit.mjs
     node tools/content-audit.mjs --out _ui-check/content
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const OUT = path.resolve(ROOT, argOf('out', '_ui-check/content'));

/* 扫描范围：前端源码 + 后端路由/服务里的面向用户文案 */
const TARGETS = [
  { dir: 'public/js', ext: ['.js'] },
  { dir: 'public', ext: ['.css', '.html'] },
  { dir: 'server', ext: ['.js'] },
];
/* 排除：第三方库、构建产物、证据快照、测试桩 */
const SKIP = /node_modules|[\\/]out[\\/]|_ui-check|[\\/]vendor[\\/]|vue\.global|echarts|\.min\./;

/* ---------------- 规则表 ---------------- */
const RULES = [
  {
    id: 'placeholder',
    name: '未完成占位符',
    re: /\b(TODO|FIXME|XXX|HACK|TBD)\b/g,
    level: 'high',
    hint: '页面上不该出现"待办"标记',
  },
  {
    id: 'coming-soon',
    name: '空壳文案（即将上线/开发中）',
    re: /敬请期待|即将上线|功能开发中|正在建设中|待补充|待完善|coming soon/gi,
    level: 'high',
    hint: '要么实现，要么删掉入口；"即将上线"在验收现场等于"没做完"',
  },
  {
    id: 'lorem',
    name: 'Lorem ipsum 假文',
    re: /lorem ipsum/gi,
    level: 'high',
    hint: '占位假文必须换成真实业务文案',
  },
  {
    id: 'junk',
    name: '测试痕迹（假数据/占位字符）',
    re: /(测试测试|测试数据|测试一下|asdf|qwerty|aaaa+|11111111|123123123|foo\s*bar|example\.com|张三|李四|王五)/gi,
    level: 'mid',
    hint: '示例数据要贴真实业务场景，不能留明显占位',
  },
  {
    id: 'punct-dup',
    name: '重复标点',
    re: /([。，、；：！？])\1+/g,
    level: 'low',
    hint: '重复标点多为拼接 bug',
  },
  {
    id: 'punct-halfwidth',
    name: '中文里的半角标点',
    re: /[\u4e00-\u9fa5][,;:!?][\u4e00-\u9fa5]/g,
    level: 'low',
    hint: '中文正文应使用全角标点',
  },
  {
    id: 'tmpl-var',
    name: '未替换的模板占位',
    /* ⚠⚠ 这里只找"双花括号"与 printf 占位。`${x}` 在 JS 模板字符串里到处都是，
       静态扫它等于把正常代码全报一遍（首版就是 1887 条噪音，报告直接失去价值）。
       真正要抓的是"渲染后用户还能看到 ${…} / {{…}}"——那属于运行时，
       由 platform-audit.mjs 在 DOM 上判定，不在这里猜。 */
    /* 只找双花括号（Vue 模板漏渲染）。printf 的 %s/%d 一律不在这里判：
       服务端日志、HJ212 报文格式串都合法，静态扫必然全是噪音；
       真正要抓的"用户能看到 ${…}"属于渲染结果，交给 platform-audit 在 DOM 上查。 */
    re: /\{\{[^}]{1,40}\}\}/g,
    /* 噪音排除：MySQL 的 DATE_FORMAT('%Y-%m-%d') 会命中 %d；JSDoc 的 {{ok:boolean}} 是类型注解；
       服务端 console.log('… %d', n) 是 printf 占位，属正常。 */
    noise: /DATE_FORMAT|%Y[-/.]|@returns|@param|@type|console\.log|<%|=%/i,
    level: 'mid',
    hint: '疑似模板占位漏渲染',
  },
  {
    id: 'mojibake',
    name: '乱码字符',
    re: /[\uFFFD]|锟斤拷|烫烫烫|屯屯屯/g,
    level: 'high',
    hint: '编码损坏',
  },
];

/* 术语一致性：同一概念多种叫法，专家一眼看出不严谨 */
const TERMS = [
  { id: 'credit', re: /碳信用/g, label: '碳信用' },
  { id: 'ccer', re: /CCER/g, label: 'CCER' },
  { id: 'quota', re: /碳配额/g, label: '碳配额' },
  { id: 'allowance', re: /配额/g, label: '配额（泛称）' },
  { id: 'offset', re: /抵销|抵消/g, label: '抵销/抵消' },
];

/* 抵销 vs 抵消：
 * ⚠ 这两个词不是同义词 —— "抵销"是碳市场的抵消履约（offset），
 * "抵消"常用于"两个量相互抵消"这种数学/物理语境（如 dynamic.js 里
 * "分子分母在同一窗口内抵消"）。所以不能见到"抵消"就报，
 * 只在它跟碳资产语境连用时才算术语混用。 */
const OFFSET_CN_RE = /碳[^。；\n]{0,6}抵消|抵消[^。；\n]{0,6}(碳信用|配额|减排量|碳资产)/g;

const files = [];
for (const t of TARGETS) {
  const abs = path.join(ROOT, t.dir);
  if (!fs.existsSync(abs)) continue;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (SKIP.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (t.ext.includes(path.extname(e.name))) files.push(p);
    }
  };
  walk(abs);
}

const findings = [];
const termCount = {};
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);

  for (const r of RULES) {
    lines.forEach((line, i) => {
      r.re.lastIndex = 0;
      const m = line.match(r.re);
      if (!m) return;
      if (r.noise && r.noise.test(line)) return;
      /* 注释里的"测试数据""TODO"不会出现在用户界面上：
         仍然记录（便于自查），但降级为 low，不再污染 high/mid 的结论。 */
      const inComment = /^\s*(\/\/|\*|\/\*)/.test(line);
      if (inComment && r.id === 'tmpl-var') return;
      const uniq = [...new Set(m.map((x) => x.trim()))].slice(0, 3);
      findings.push({
        rule: r.id, name: r.name,
        level: inComment ? 'low' : r.level,
        inComment,
        file: rel, line: i + 1,
        sample: line.trim().slice(0, 160),
        matches: uniq,
        hint: r.hint,
      });
    });
  }

  for (const t of TERMS) {
    const c = (text.match(t.re) || []).length;
    if (c) termCount[t.id] = (termCount[t.id] || 0) + c;
  }
}

/* 抵销 vs 抵消：只统计"碳语境下的抵消"，并按文件定位 */
const offsetMixedHits = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const text = fs.readFileSync(f, 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    OFFSET_CN_RE.lastIndex = 0;
    if (OFFSET_CN_RE.test(line)) offsetMixedHits.push({ file: rel, line: i + 1, sample: line.trim().slice(0, 140) });
  });
}
const offsetMixed = offsetMixedHits.length > 0;

const byLevel = { high: 0, mid: 0, low: 0 };
for (const x of findings) byLevel[x.level] += 1;

fs.mkdirSync(OUT, { recursive: true });
const report = {
  scannedFiles: files.length,
  generatedAt: new Date().toISOString(),
  totals: { findings: findings.length, ...byLevel },
  termCount,
  offsetMixed,
  findings,
};
fs.writeFileSync(path.join(OUT, 'content-audit.json'), JSON.stringify(report, null, 2), 'utf8');

/* ---------------- 控制台输出 ---------------- */
const group = (arr, k) => arr.reduce((a, x) => { (a[x[k]] = a[x[k]] || []).push(x); return a; }, {});
console.log(`\n内容合规扫描 —— 文件 ${files.length} 个`);
console.log(`  高 ${byLevel.high} · 中 ${byLevel.mid} · 低 ${byLevel.low}\n`);

for (const [id, arr] of Object.entries(group(findings, 'rule'))) {
  console.log(`■ ${arr[0].name}（${arr.length}）— ${arr[0].hint}`);
  const perFile = Object.entries(group(arr, 'file')).sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  for (const [f, xs] of perFile) {
    console.log(`   ${f}  ×${xs.length}`);
    for (const x of xs.slice(0, 3)) console.log(`     L${x.line}  ${x.matches.join(' / ')}  ← ${x.sample.slice(0, 90)}`);
  }
  console.log('');
}

if (offsetMixed) console.log('⚠ 术语不一致：「抵销」与「抵消」两种写法同时存在，需统一。\n');
console.log(`报告：${path.join(OUT, 'content-audit.json')}`);
