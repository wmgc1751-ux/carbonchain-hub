/**
 * grounding.js —— 数字溯源校验（防大模型编造数字）
 * ==================================================================================
 * 【要解决的问题】
 *
 * 接上大模型之后，风险从"答不了"变成"答得太顺"。实测过的典型错误：
 * 工具查到的缺口是 3,208 tCO₂e，模型写成「缺口约 3,200 吨，约占配额的 12%」——
 * 第一个数字是四舍五入改写，第二个数字整段是它自己算的。两处都不在原数据里。
 *
 * 对一个碳数据平台，这种漂移不是措辞问题：它会被截图当证据引用。
 * 所以不能只靠提示词说"请勿编造"——**提示词是请求，不是约束**。
 *
 * 【做法：事后核对，不干预生成】
 *
 *   工具结果（结构化） → 事实数字集合（含单位换算变体）
 *   模型回答（自然语言） → 抽取全部数字
 *   逐个比对 → 分三类：命中 / 换算命中（万/亿）/ 无出处
 *
 * 「无出处」不删句子（删了读者就不知道模型说过什么），而是：
 *   ① 在响应里返回 grounding 明细（前端可高亮）；
 *   ② 在回答末尾追加一行溯源声明，指出哪几个数字查不到来源。
 *
 * 【为什么不用"让模型自己标来源"的做法】
 *   模型自标来源同样可能编造（"（来源：GB/T 32150 第 5.2 条）"可以整句生成）。
 *   校验必须在模型之外，用机器可比的规则做。
 *
 * @module services/grounding
 */
'use strict';

/**
 * 递归收集源文本中**字面带百分号**的数字（"5%" → 5）。
 *
 * 与 collectNumbers 的区别是语义性的：collectNumbers 只关心"这个数出现过"，
 * 本函数还要求它出现时**带了 % 记法**。用于放行规则引擎原话里的
 * 「抵销上限为主体配额的 5%」这类合法百分比，同时不放行公式里的裸整数
 * （如 × 44/12 的 12），后者一旦进白名单就会合法化任意编造的整数百分比。
 */
function percentLiteralsOf(node, out = new Set(), depth = 0) {
  if (depth > 6 || node == null) return out;
  if (typeof node === 'string') {
    for (const m of node.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) out.add(v);
    }
    return out;
  }
  if (Array.isArray(node)) {
    for (const x of node.slice(0, 200)) percentLiteralsOf(x, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) percentLiteralsOf(node[k], out, depth + 1);
  }
  return out;
}

/** 从任意结构中递归收集数字（含数组/对象/字符串里的数字） */
function collectNumbers(node, out = new Set(), depth = 0) {
  if (depth > 6 || node == null) return out;
  if (typeof node === 'number') {
    if (Number.isFinite(node)) out.add(node);
    return out;
  }
  if (typeof node === 'string') {
    /* 结构化结果里的字符串常含数字（如 "12000 吨"、"3.2 tCO2e"） */
    for (const m of node.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const v = Number(m[0]);
      if (Number.isFinite(v)) out.add(v);
    }
    return out;
  }
  if (Array.isArray(node)) {
    for (const x of node.slice(0, 200)) collectNumbers(x, out, depth + 1);
    return out;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) collectNumbers(node[k], out, depth + 1);
  }
  return out;
}

/** 数字 → 一组"同一事实的合理写法"（四舍五入到各精度 + 万/亿换算） */
function variantsOf(v) {
  const set = new Set();
  const push = (x) => { if (Number.isFinite(x)) set.add(Number(x.toFixed(6))); };
  push(v);
  for (const d of [0, 1, 2, 3, 4]) push(Number(v.toFixed(d)));
  /* 符号 ↔ 语义记账互通：库里的 gap 存负数表示"富余"（-68873 意味着没有缺口、
   * 反而多出 68873 吨），模型按人话写成"富余 68,873.14"是正数 —— 同一事实的
   * 两种记法，不是编造。绝对值因此必须进同一个变体集合。
   * ⚠ 只加绝对值，不加"任意符号翻转"：若允许 -X ↔ +X 无限制互通，
   *   那么把"缺口 100"写成"富余 100"就无法被区分出来。 */
  if (v < 0) {
    push(-v);
    for (const d of [0, 1, 2, 3, 4]) push(Number((-v).toFixed(d)));
  }
  /* 单位换算：模型爱把 222877 写成 22.29 万吨 / 22 万吨 */
  for (const k of [1e4, 1e8]) {
    push(v / k);
    for (const d of [0, 1, 2, 3]) push(Number((v / k).toFixed(d)));
  }
  /* 比率 ↔ 百分比口径互通：库里常存 0.9676，模型爱写 96.76%。
   * 两者是同一事实的不同记法，必须双向可达，否则真实数字会被判成编造。 */
  if (v !== 0 && Math.abs(v) <= 1) {
    push(v * 100);
    for (const d of [0, 1, 2, 3]) push(Number((v * 100).toFixed(d)));
  }
  if (Math.abs(v) > 1 && Math.abs(v) <= 100) {
    push(v / 100);
    for (const d of [0, 1, 2, 3, 4]) push(Number((v / 100).toFixed(d)));
  }
  /* 千分位写法 222,877 在抽取阶段已归一为 222877，无需单独处理 */
  return set;
}

/**
 * 校验一段回答里的数字是否都能在事实集中找到出处。
 *
 * @param {string} answer 模型回答
 * @param {Array<object>|object} facts 工具结果（可多份）
 * @param {object} [opts]
 *   question  原始问题（问题里出现的数字不算编造）
 *   tolerance 相对容差，默认 0.005（0.5%）—— 覆盖"四舍五入到不同位数"
 * @returns {{total:number, verified:number, unverified:Array, ratio:number, policy:string}}
 */
function verify(answer, facts, opts = {}) {
  const text = String(answer || '');
  const sources = Array.isArray(facts) ? facts : [facts];

  /* 事实数字 → 变体集合（预展开，比对时 O(1)）
   * ⚠ 百分比单独一套集合，见下方 pctAllowed 的说明。 */
  const allowed = new Set();
  const pctAllowed = new Set();
  for (const s of sources) {
    const raw = collectNumbers(s);
    for (const v of raw) {
      const vs = variantsOf(v);
      for (const x of vs) allowed.add(x);
      /* 百分比只允许匹配"非整数的真实比率"。
       * 反例（自测抓出来的）：因子复算公式里有 `× 44/12`，其中的 12 是一个
       * 化学计量系数；若把它放进通用集合，模型编造的"下降 12%"就会被判为
       * 有出处 —— 一个常数合法化了任意一个小整数百分比。 */
      if (!Number.isInteger(v)) for (const x of vs) pctAllowed.add(x);
    }
    /* 但源头**字面写了百分号**的整数必须放行：规则引擎自己的结论里就有
     * 「CCER 抵销上限为主体配额的 5%」，模型照抄 5% 是忠实引用，不是编造。
     * 判据是"源文本里该数紧跟 %"，与上面 44/12 那种裸整数区分开。 */
    for (const pv of percentLiteralsOf(s)) {
      pctAllowed.add(Number(pv.toFixed(6)));
      for (const x of variantsOf(pv)) pctAllowed.add(x);
    }
  }

  /* 问题里的数字：用户自己给的，不算模型编造 */
  const fromQuestion = new Set();
  for (const m of String(opts.question || '').matchAll(/-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0]);
    if (Number.isFinite(v)) {
      fromQuestion.add(v);
      for (const x of variantsOf(v)) { allowed.add(x); pctAllowed.add(x); }
    }
  }

  /* 容差 0.01%（原为 0.5%）。
   * 实测反例：真实期末预测 293,687.71，模型写成 293,739.94 —— 差 52 tCO₂e，
   * 在 0.5% 容差（±1,468）下被判为"四舍五入"放行。对碳数据平台，这不是舍入，
   * 是另一个数；截图引用后无法与原数据对上。
   * 0.01% 仍能覆盖一切真实舍入记法：variantsOf 已预展开到 4 位小数与
   * 万/亿换算，容差只为兜住"再多保留一位"这类边角，不需要宽容到能藏住偏差。 */
  const tol = opts.tolerance ?? 0.0001;
  const unverified = [];
  let total = 0;
  let verified = 0;

  /* 抽取正文数字。排除：
   *   · Markdown 列表序号（行首 "1. " / "- "）
   *   · 三位以内的小整数（工具名、源数量、条款号，误报率高于命中率）
   *   · 1990–2100 之间的整数（年份，几乎总是合理上下文） */
  /* ⚠ 这里的量词必须是 \d+ 而不是 \d{1,3}：
   * 后者在 "3208" 上只吃到 "320"（因为后面的千分位分组要求先有逗号），
   * 于是每个四位数都被截断成三位——校验结果全变"无出处"，
   * 看起来像模型全在编数字。这个 bug 是自测里抓出来的。 */
  const RE = /(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?%?/g;
  const seen = new Set();

  for (const m of text.matchAll(RE)) {
    const rawTok = m[0];
    const atLineStart = /(?:^|\n)\s*$/.test(text.slice(Math.max(0, m.index - 6), m.index));
    if (atLineStart && /^\d{1,2}[.、)]?$/.test(rawTok)) continue;   // 列表序号

    const isPct = rawTok.endsWith('%');
    const numStr = rawTok.replace(/,/g, '').replace(/%$/, '');
    const v = Number(numStr);
    if (!Number.isFinite(v)) continue;

    /* 小整数与年份不纳入统计（但记入 whitelist 说明，避免"看起来漏检"） */
    const isYear = Number.isInteger(v) && v >= 1990 && v <= 2100;
    const isSmallInt = !isPct && Number.isInteger(v) && Math.abs(v) < 100;
    if (isYear || isSmallInt) continue;
    if (seen.has(rawTok)) continue;
    seen.add(rawTok);

    total += 1;
    const pool = isPct ? pctAllowed : allowed;
    let hit = pool.has(Number(v.toFixed(6)));
    if (!hit) {
      /* 容差比对：只对 >=100 的数字做相对容差，小数做绝对容差 */
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
    total, verified,
    unverified,
    ratio: total ? Number((verified / total).toFixed(4)) : 1,
    policy: '正文中 ≥100 的整数、小数与百分比逐个核对；年份、三位以内小整数、'
      + '用户问题里出现过的数字不纳入（误报率高于命中率）',
  };
}

/**
 * 生成回答末尾的溯源声明。
 * 校验全通过 → 一句正向说明（这本身就是可信度信号）；
 * 有未命中 → 明确列出，并给出"以页面数据为准"的处置建议。
 */
function footnote(g) {
  if (!g || !g.total) return '';
  if (!g.unverified.length) {
    return `\n\n_数字溯源：正文 ${g.total} 个数字均可在平台数据中找到出处（自动核对，容差 0.5%）。_`;
  }
  const list = g.unverified.slice(0, 6).map((u) => u.raw).join('、');
  return `\n\n_⚠ 数字溯源：${g.total} 个数字中 ${g.unverified.length} 个未在平台数据中找到出处`
    + `（${list}${g.unverified.length > 6 ? ' 等' : ''}），可能是模型自行推算或单位换算。`
    + `涉及决策请以平台页面数据为准。_`;
}

module.exports = { verify, footnote, collectNumbers, variantsOf };
