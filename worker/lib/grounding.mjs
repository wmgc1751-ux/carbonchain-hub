/**
 * worker/lib/grounding.mjs —— 数字溯源校验（Worker 运行时版本）
 * ==================================================================================
 * 与 server/services/grounding.js 同一算法、同一口径。分两份而不是共享，
 * 是因为两个运行时模块体系不同（CJS / ESM），跨体系 import 会在打包时踩坑；
 * 因此这里保持**逐行同构**，任何一处修改必须同步另一处 ——
 * 自测 tools/llm-selftest.mjs 覆盖本地版，tools/worker-parity-test 覆盖结构一致性。
 *
 * @module worker/lib/grounding
 */

/** 递归收集结构中的数字 */
export function collectNumbers(node, out = new Set(), depth = 0) {
  if (depth > 6 || node == null) return out;
  if (typeof node === 'number') { if (Number.isFinite(node)) out.add(node); return out; }
  if (typeof node === 'string') {
    for (const m of node.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const v = Number(m[0]);
      if (Number.isFinite(v)) out.add(v);
    }
    return out;
  }
  if (Array.isArray(node)) { for (const x of node.slice(0, 200)) collectNumbers(x, out, depth + 1); return out; }
  if (typeof node === 'object') { for (const k of Object.keys(node)) collectNumbers(node[k], out, depth + 1); }
  return out;
}

/** 同一事实的合理写法（四舍五入到各精度 + 万/亿换算） */
export function variantsOf(v) {
  const set = new Set();
  const push = (x) => { if (Number.isFinite(x)) set.add(Number(x.toFixed(6))); };
  push(v);
  for (const d of [0, 1, 2, 3, 4]) push(Number(v.toFixed(d)));
  for (const k of [1e4, 1e8]) {
    push(v / k);
    for (const d of [0, 1, 2, 3]) push(Number((v / k).toFixed(d)));
  }
  /* 比率 ↔ 百分比口径互通（0.9676 ↔ 96.76%），与本地版同一条规则 */
  if (v !== 0 && Math.abs(v) <= 1) {
    push(v * 100);
    for (const d of [0, 1, 2, 3]) push(Number((v * 100).toFixed(d)));
  }
  if (Math.abs(v) > 1 && Math.abs(v) <= 100) {
    push(v / 100);
    for (const d of [0, 1, 2, 3, 4]) push(Number((v / 100).toFixed(d)));
  }
  return set;
}

/**
 * 校验回答中的数字能否在事实集中找到出处。
 * @param {string} answer
 * @param {Array|object} facts
 * @param {object} [opts] { question, tolerance }
 */
export function verify(answer, facts, opts = {}) {
  const text = String(answer || '');
  const sources = Array.isArray(facts) ? facts : [facts];

  const allowed = new Set();
  const pctAllowed = new Set();
  for (const s of sources) {
    for (const v of collectNumbers(s)) {
      const vs = variantsOf(v);
      for (const x of vs) allowed.add(x);
      /* 百分比只匹配真实比率（非整数），避免把公式常数（如 44/12 里的 12）
       * 当成"下降 12%"的出处 —— 与本地版同一条规则。 */
      if (!Number.isInteger(v)) for (const x of vs) pctAllowed.add(x);
    }
  }
  for (const m of String(opts.question || '').matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (Number.isFinite(v)) { for (const x of variantsOf(v)) { allowed.add(x); pctAllowed.add(x); } }
  }

  const tol = opts.tolerance ?? 0.005;
  const unverified = [];
  let total = 0;
  let verified = 0;
  const seen = new Set();
  /* ⚠ \d+ 而非 \d{1,3}：后者会把 3208 截成 320（千分位分组要求先有逗号） */
  const RE = /(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?%?/g;

  for (const m of text.matchAll(RE)) {
    const rawTok = m[0];
    const atLineStart = /(?:^|\n)\s*$/.test(text.slice(Math.max(0, m.index - 6), m.index));
    if (atLineStart && /^\d{1,2}[.、)]?$/.test(rawTok)) continue;

    const isPct = rawTok.endsWith('%');
    const v = Number(rawTok.replace(/,/g, '').replace(/%$/, ''));
    if (!Number.isFinite(v)) continue;

    const isYear = Number.isInteger(v) && v >= 1990 && v <= 2100;
    const isSmallInt = !isPct && Number.isInteger(v) && Math.abs(v) < 100;
    if (isYear || isSmallInt) continue;
    if (seen.has(rawTok)) continue;
    seen.add(rawTok);

    total += 1;
    const pool = isPct ? pctAllowed : allowed;
    let hit = pool.has(Number(v.toFixed(6)));
    if (!hit) {
      for (const a of pool) {
        const diff = Math.abs(a - v);
        if (v !== 0 && diff / Math.abs(v) <= tol) { hit = true; break; }
        if (v === 0 && diff < 0.01) { hit = true; break; }
      }
    }
    if (hit) verified += 1;
    else unverified.push({ raw: rawTok, value: v, percent: isPct });
  }

  return {
    total, verified, unverified,
    ratio: total ? Number((verified / total).toFixed(4)) : 1,
    policy: '正文中 ≥100 的整数、小数与百分比逐个核对；年份、三位以内小整数、'
      + '用户问题里出现过的数字不纳入（误报率高于命中率）',
  };
}

/** 溯源声明 */
export function footnote(g) {
  if (!g || !g.total) return '';
  if (!g.unverified.length) {
    return `\n\n_数字溯源：正文 ${g.total} 个数字均可在平台数据中找到出处（自动核对，容差 0.5%）。_`;
  }
  const list = g.unverified.slice(0, 6).map((u) => u.raw).join('、');
  return `\n\n_⚠ 数字溯源：${g.total} 个数字中 ${g.unverified.length} 个未在平台数据中找到出处`
    + `（${list}${g.unverified.length > 6 ? ' 等' : ''}），可能是模型自行推算或单位换算。`
    + `涉及决策请以平台页面数据为准。_`;
}
