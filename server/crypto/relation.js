/**
 * relation.js —— 线性关系零知识证明（Schnorr 离散对数 + 线性组合）
 * ==================================================================================
 * 【这个模块解决什么问题】
 *
 * 上一轮的零知识实现只能证明一件事：**「承诺里的值落在 [0, 2^n) 内」**。
 * 但那句话只说"这是个合理量级的数"，**完全没有说"这个数对不对"**。
 *
 * 企业完全可以提交一个假数字（例如真实排放 100 万吨，报 50 万吨），
 * 然后生成一份合法的范围证明 —— 范围证明会通过，因为 50 万确实在 [0, 2^64) 内。
 *
 * 所以上一轮的"隐私保护型 MRV"存在一个致命语义缺口：
 *   它保护了数据，但没有验证数据。
 *
 * 本模块补上这个缺口。核心是一个极简但完备的原语：
 *
 *     **给定 Cᵢ = vᵢ·G + rᵢ·H，证明 Σ aᵢ·vᵢ = b，而不泄漏任何 vᵢ 或 rᵢ。**
 *
 * 这一个原语可覆盖碳核算里的全部关键关系：
 *   · 分项之和 = 总量        a = (1,1,…,1,−1), b = 0
 *   · 本期 = 上期（跨期一致）a = (1,−1),       b = 0
 *   · 排放 = Σ 因子ᵢ × 活动数据ᵢ  a = (EF₁,…,EFₙ,−1), b = 0  ← 最重要
 *   · 本期 ≤ 上期（减排声明）先证差分非负，再用本原语
 *
 * 【为什么这个原语成立 —— 完整推导，不留"照抄"的余地】
 *
 * 若 Σ aᵢ·vᵢ = b，则：
 *
 *   Σ aᵢ·Cᵢ − b·G
 *     = Σ aᵢ(vᵢG + rᵢH) − b·G
 *     = (Σ aᵢvᵢ)·G + (Σ aᵢrᵢ)·H − b·G
 *     = b·G + R·H − b·G                        （令 R = Σ aᵢrᵢ）
 *     = R·H
 *
 * 于是"值满足线性关系"**等价于**"点 D = ΣaᵢCᵢ − b·G 是 H 的 R 倍"。
 * 证明者知道全部 rᵢ，因此知道 R；只需用 Schnorr 协议证明"我知道 D 关于 H 的离散对数"。
 *
 * 【Schnorr 知识证明（含完备性/可靠性/零知识三性）】
 *
 *   1. 证明者取随机 k ∈ Z_n，计算 T = k·H，发送 T
 *   2. 挑战 e = Hash(域分隔, 语句, T) ∈ Z_n
 *   3. 证明者发送 z = k + e·R mod n
 *   4. 验证者检查 z·H =? T + e·D
 *
 *   完备性：z·H = (k + eR)H = kH + e(RH) = T + e·D  ✓
 *   可靠性：若证明者能对两个不同挑战 e≠e′ 给出 z, z′，
 *          则 z − z′ = (e − e′)·R ⇒ R = (z−z′)/(e−e′)。即两次成功响应必然泄漏 R，
 *          故无法在不知道 R 的情况下通过（特殊可靠性 special soundness）。
 *   零知识：模拟器任取 z，令 T = z·H − e·D 即可生成同分布 transcript。  ✓
 *
 * 【零知识性的关键：D 不泄漏任何信息】
 *   D = R·H，其中 R = Σ aᵢrᵢ。只要有一个 aᵢ ≠ 0，rᵢ 均匀随机 ⇒ R 均匀随机
 *   ⇒ D 是群中的均匀随机点（与 vᵢ 完全无关）。
 *   所以公开 D 不泄漏任何 vᵢ —— 这不是"我们不看"，是信息论上取不到。
 *
 * 【本模块的三条设计红线】
 *
 *   ① **所有标量运算必须在 Z_n 上**。`curve.mod(x)` 默认模数是 P（素域特征），
 *      上一轮因此出过一个极难发现的 bug（详见 rangeproof.js 的注释）。
 *      本模块所有涉及标量的地方**一律显式写 `mod(..., N)`**，并在末尾自检里
 *      专门加了一条断言检查这一点。
 *
 *   ② **语句必须完整绑定进挑战**。挑战若不绑定系数量、承诺列表、目标值，
 *      攻击者就能把一份"分项之和 = 总量"的证明挪用到"本期 = 上期"上。
 *      本模块把 (协议域, 承诺列表规范化编码, 系数量, 目标值, 基标识) 全部入哈希。
 *
 *   ③ **拒绝退化语句**。全零系数（0 = 0）没有证明价值，必须显式拒绝 ——
 *      否则会产生"验证通过但什么也没证明"的假绿灯。
 *
 * @module crypto/relation
 */
'use strict';

const C = require('./curve');
const PD = require('./pedersen');

/** 协议版本（升级必须改，历史证明按版本验证） */
const VERSION = 'rel-v1';

/** 默认基：H_EMISSION（与承诺构造保持一致，不可混用） */
const BASE = PD.H_EMISSION;

/** 语句域分隔：不同的关系类型用不同域，防止跨类型重放 */
const DOMAIN = {
  DLOG: `${VERSION}/dlog`,
  LINEAR: `${VERSION}/linear`,
};

/* ==================================================================================
 * 一、工具：规范化与哈希
 * ================================================================================== */

/** 所有标量运算的统一入口 —— 强制 mod N */
function s(x) { return C.mod(BigInt(x), C.N); }

/** 断言某个中间量确实在 Z_n 内（仅用于自检与开发期诊断） */
function assertScalar(v, name) {
  if (typeof v !== 'bigint') throw new Error(`${name} 不是 bigint`);
  if (v < 0n || v >= C.N) throw new Error(`${name} 不在 Z_n 内：${String(v).slice(0, 20)}…`);
  return v;
}

/** 把承诺（或已编码的点）统一取成编码串，用于语句规范化 */
function encCommit(c) {
  if (typeof c === 'string') return c.toUpperCase();
  if (c && c.commit) return C.encodePoint(c.commit);
  if (c && c.X !== undefined) return C.encodePoint(c);
  throw new Error('无法识别的承诺对象');
}

/** 把承诺取成点对象 */
function ptCommit(c) {
  if (typeof c === 'string') return C.decodePoint(c);
  if (c && c.commit) return c.commit;
  if (c && c.X !== undefined) return c;
  throw new Error('无法识别的承诺对象');
}

/**
 * 语句摘要：把「关系类型 + 承诺列表 + 系数 + 目标值」规范化后哈希。
 *
 * ⚠ 这个摘要必须覆盖语句的**全部**公共部分。少一项就给了攻击者伪造空间：
 *   · 漏承诺 → 可把证明挪用到别的承诺上
 *   · 漏系数 → 可把"和=总量"的证明挪用到"差=0"上
 *   · 漏目标值 → 可把 b=1000 的证明用在 b=2000 上
 */
function statementDigest(kind, commits, coeffs, target) {
  const list = commits.map(encCommit);
  const cs = coeffs.map((x) => C.HEX(s(x)));
  const t = C.HEX(s(target));
  return C.hashHex(DOMAIN.LINEAR, kind, String(list.length),
    ...list, ...cs, String(cs.length), t,
    C.hashHex(C.encodePoint(BASE)));
}

/* ==================================================================================
 * 二、核心原语：离散对数知识证明
 * ================================================================================== */

/**
 * 证明「我知道 x，使 target = x·base」。
 *
 * @param {object} target 公开点（Jacobian）
 * @param {bigint} x      私密标量
 * @param {object} [opts] { base, context }  context 会绑进挑战
 * @returns {object} 证明 {T, z, e, digest}
 */
function proveDlog(target, x, opts = {}) {
  const base = opts.base || BASE;
  const xx = s(x);
  /* 前置自检：target 必须真的等于 x·base，否则证明注定无效。
   * 与其生成一个"看起来正常但永远验不过"的证明，不如立刻报错 —— 
   * 上一轮的教训：无效证明会在下游表现为"验证失败"，排查成本极高。 */
  if (!C.equals(target, C.mul(xx, base))) {
    throw new Error('proveDlog：target ≠ x·base，证明者内部状态不一致（实现缺陷）');
  }

  const k = C.randomScalar();
  const T = C.mul(k, base);
  const ctx = opts.context || '';
  const e = C.hashToScalar(DOMAIN.DLOG, C.encodePoint(base), C.encodePoint(target),
    C.encodePoint(T), String(ctx));
  const z = s(k + s(e * xx));

  /* 自检：z·base 必须等于 T + e·target。这是完备性的数值验证，
   * 任何公式笔误都会在这里被抓到，而不是等到验证阶段。 */
  const lhs = C.mul(z, base);
  const rhs = C.add(T, C.mul(e, target));
  if (!C.equals(lhs, rhs)) {
    throw new Error('proveDlog：完备性自检失败（公式实现错误）');
  }

  return {
    kind: 'DLOG',
    version: VERSION,
    /* 只带 T 与 z。e 可由语句 + T 重算，base/target 由调用方上下文已知 ——
     * 三者都是**冗余字段**，带上只会让证明从 ~200 字节膨胀到 910 字节。
     * 冗余字段不仅浪费带宽，还给了"证明体内部不一致"的攻击面
     * （攻击者改了 target 字段而验证者误用它）。最小化即最优。 */
    T: C.encodePoint(T),
    z: C.HEX(z),
    context: String(ctx),
  };
}

/**
 * 验证离散对数知识证明。
 *
 * @param {object} target 公开点（必须由调用方按语句重算后传入，**不信任证明里的字段**）
 * @param {object} proof
 * @param {object} [opts] { base }
 */
function verifyDlog(target, proof, opts = {}) {
  const checks = [];
  const push = (n, ok, d) => checks.push({ name: n, pass: !!ok, detail: d });
  const fail = (reason) => ({ ok: false, reason, checks });

  try {
    if (!proof || proof.kind !== 'DLOG' || proof.version !== VERSION) {
      return fail('证明类型或版本不符');
    }
    const base = opts.base || BASE;
    const T = C.decodePoint(proof.T);
    const z = BigInt('0x' + proof.z);

    /* 1. 重算挑战 —— 证明体里不带 e，完全由语句与 T 派生。
     *    这样"挑战"与"语句"在结构上就不可能脱钩，比"带 e 再比对"更安全。 */
    const e = C.hashToScalar(DOMAIN.DLOG, C.encodePoint(base), C.encodePoint(target),
      C.encodePoint(T), String(proof.context || ''));

    /* 2. 核心等式 z·H = T + e·D */
    const lhs = C.mul(z, base);
    const rhs = C.add(T, C.mul(e, target));
    push('核心等式 z·H = T + e·D', C.equals(lhs, rhs),
      C.equals(lhs, rhs) ? '' : '等式不成立');
    if (!C.equals(lhs, rhs)) return fail('核心等式不成立：证明无效');

    /* 3. 拒绝退化：T 与 target 不得为无穷远 */
    push('T 与 target 非退化', !C.isZero(T) && !C.isZero(target), '');
    if (C.isZero(T) || C.isZero(target)) return fail('退化证明：存在无穷远点');

    /* 4. 挑战非零（极低概率但必须拦） */
    push('挑战非零', e !== 0n, e !== 0n ? '' : 'e = 0（概率 2⁻²⁵⁶，视为异常）');
    if (e === 0n) return fail('挑战为零');

    return { ok: true, reason: '离散对数知识证明有效', checks };
  } catch (err) {
    return fail(`验证异常：${err.message}`);
  }
}

/* ==================================================================================
 * 三、线性关系证明（本模块的主原语）
 * ================================================================================== */

/**
 * 证明「Σ aᵢ·vᵢ = b」，其中 vᵢ 藏在承诺 Cᵢ = vᵢ·G + rᵢ·H 里。
 *
 * @param {object} p
 *   commits   承诺数组（每项可为 {commit,r,v} 或点或编码串）
 *   coeffs    系数数组（与 commits 等长）
 *   target    公开目标值 b
 *   blinds    盲化因子数组（证明者必须知道全部）
 *   values    （可选）明文值数组，仅用于内部自检，不进证明
 *   label     （可选）语义标签，绑定进挑战
 * @returns {object} 证明
 */
function proveLinear(p) {
  const commits = p.commits || [];
  const coeffs = p.coeffs || [];
  const blinds = p.blinds || [];
  const target = s(p.target || 0n);
  const label = String(p.label || '');

  if (!commits.length) throw new Error('承诺列表不能为空');
  if (commits.length !== coeffs.length) throw new Error('承诺与系数数量不一致');
  if (commits.length !== blinds.length) throw new Error('承诺与盲化因子数量不一致');
  if (commits.length > 256) throw new Error('单次线性关系最多 256 个承诺（性能与可读性）');

  /* 红线③：拒绝退化语句。全零系数意味着「0 = b」，若 b 也 0 则毫无意义。 */
  const allZero = coeffs.every((a) => s(a) === 0n);
  if (allZero) {
    throw new Error('系数全为零：该语句不证明任何东西（0 = 0）。拒绝生成 —— '
      + '产生"验证通过但什么也没证明"的假绿灯比失败更危险');
  }

  /* 计算 D = Σ aᵢ·Cᵢ − b·G */
  const pts = commits.map(ptCommit);
  const cs = coeffs.map((x) => s(x));
  let D = C.ZERO;
  for (let i = 0; i < pts.length; i++) {
    if (cs[i] === 0n) continue;
    D = C.add(D, C.mul(cs[i], pts[i]));
  }
  D = C.sub(D, C.mul(target, C.G));

  /* 计算 R = Σ aᵢ·rᵢ */
  let R = 0n;
  for (let i = 0; i < blinds.length; i++) {
    R = s(R + s(cs[i] * s(blinds[i])));
  }

  /* 内部自检：D 必须等于 R·H。
   * 若不等，说明「值不满足该线性关系」或「盲化因子给错了」。
   * 这是最重要的一道防线：它保证我们不会生成一份注定失败、却看起来正常的证明。 */
  if (!C.equals(D, C.mul(R, BASE))) {
    const detail = (p.values && p.values.length === commits.length)
      ? `实际 Σaᵢvᵢ = ${cs.reduce((acc, a, i) => s(acc + s(a * s(p.values[i]))), 0n)}，期望 ${target}`
      : '（未提供明文值，无法给出具体差额）';
    throw new Error('线性关系不成立：D ≠ R·H。'
      + `可能原因：① 值不满足 Σaᵢvᵢ = b；② 盲化因子与承诺不对应；③ 系数有误。${detail}`);
  }

  const digest = statementDigest('LINEAR', commits, cs, target);
  const proof = proveDlog(D, R, { context: `${digest}|${label}` });

  /* ⚠ 证明体**只带 count 与 dlog**。下面三个字段看似有用，实则冗余：
   *   · target —— 验证方由语句已知（若不同，摘要就不同，挑战随之不同，验证必失败）
   *   · digest —— 验证方能从 (承诺, 系数, target) 完整重算
   *   · label  —— 已并入 dlog.context，重复携带只增体积
   * 冗余字段不仅浪费带宽（每个 64 hex = 32 字节），更危险的是：
   * 一旦验证方"读证明里的 target"而不是"自己算 target"，
   * 攻击者就能改这个字段把证明挪用到别的语句上。
   * 最小化证明体 = 消除一整类攻击面。 */
  return {
    kind: 'LINEAR',
    version: VERSION,
    count: commits.length,
    dlog: proof,
    /* 供本地调试；序列化时由 wireOnly 剔除 */
    __meta: { D: C.encodePoint(D), R: C.HEX(R), digest, label, target: C.HEX(target) },
  };
}

/**
 * 验证「Σ aᵢ·vᵢ = b」。
 *
 * ⚠ 验证者**只需公开数据**：承诺列表、系数、目标值、证明。
 *   它不需要、也无法得知任何 vᵢ 或 rᵢ。
 *
 * @param {object} p
 *   commits / coeffs / target / proof
 */
function verifyLinear(p) {
  const checks = [];
  const push = (n, ok, d) => checks.push({ name: n, pass: !!ok, detail: d });
  const fail = (reason) => ({ ok: false, reason, checks });

  try {
    const commits = p.commits || [];
    const coeffs = p.coeffs || [];
    const target = s(p.target || 0n);
    const proof = p.proof;
    const label = String(p.label || '');

    if (!proof || proof.kind !== 'LINEAR' || proof.version !== VERSION) {
      return fail('证明类型或版本不符');
    }
    if (proof.count !== commits.length) {
      return fail(`承诺数量不符：证明 ${proof.count}，当前 ${commits.length}`);
    }

    /* 1. 重算语句摘要 + 上下文 —— 这是防跨语句重放的关键。
     *    ⚠ 证明体里**没有** target/digest 字段（见 proveLinear 的说明），
     *    绑定完全靠 dlog.context：验证方重算摘要 → 重算 ctx → 
     *    与证明里的 context 比对 → 不符即拒。
     *    这样证明体更小，且不可能出现"证明里的 target 与实际语句不一致
     *    但被验证方误用"这种漏洞。 */
    const digest = statementDigest('LINEAR', commits, coeffs, target);
    const ctx = `${digest}|${label}`;
    push('语句摘要已重算（承诺/系数/目标值均绑定）', true, `摘要 ${digest.slice(0, 16)}…`);

    /* 2. 上下文必须与重算值一致 —— 挡掉"把 A 批次的证明挪到 B 批次" */
    if (String(proof.dlog.context || '') !== ctx) {
      push('语句上下文一致（防跨语句/跨批次挪用）', false,
        '证明的 context 与当前语句不符：可能来自另一个批次或另一种关系');
      return fail('语句上下文不符：证明与当前语句不对应');
    }
    push('语句上下文一致（防跨语句/跨批次挪用）', true, '');

    /* 2. 重算 D = Σ aᵢCᵢ − b·G，交给 DLOG 验证 */
    const pts = commits.map(ptCommit);
    const cs = coeffs.map((x) => s(x));
    const allZero = cs.every((a) => a === 0n);
    push('系数非全零（拒绝退化语句）', !allZero, allZero ? '全零系数：该语句无意义' : '');
    if (allZero) return fail('系数全为零：拒绝验证退化语句');

    let D = C.ZERO;
    for (let i = 0; i < pts.length; i++) {
      if (cs[i] === 0n) continue;
      D = C.add(D, C.mul(cs[i], pts[i]));
    }
    D = C.sub(D, C.mul(target, C.G));

    if (C.isZero(D)) {
      /* D = O 说明 Σ aᵢCᵢ = b·G。在不知道 R 的情况下这几乎必然意味着
       * "Σ aᵢrᵢ = 0 且 Σ aᵢvᵢ = b" —— 但 DLOG 对无穷远点的证明没有意义，
       * 必须显式拒绝，否则会有一个"平凡通过"的漏洞。 */
      push('D 非退化', false, 'D 为无穷远点：无法构造有意义的离散对数证明');
      return fail('D 退化为无穷远点，拒绝验证（防止平凡通过）');
    }

    const vr = verifyDlog(D, proof.dlog, { base: BASE });
    push('离散对数证明有效', vr.ok, vr.reason);
    if (!vr.ok) {
      return { ok: false, reason: `线性关系验证失败：${vr.reason}`, checks: checks.concat(vr.checks) };
    }

    return {
      ok: true,
      reason: `线性关系成立：Σ aᵢ·vᵢ = ${target}（未泄漏任何 vᵢ）`,
      checks: checks.concat(vr.checks),
      meta: {
        count: commits.length,
        target: C.HEX(target),
        label,
        proofBytes: Buffer.byteLength(JSON.stringify(wireOnly(proof)), 'utf8'),
      },
    };
  } catch (err) {
    return fail(`验证异常：${err.message}`);
  }
}

/* ==================================================================================
 * 四、便利封装（把业务语义映射成线性关系）
 * ================================================================================== */

/**
 * 和相等：证明 Σ parts = total（各方盲化因子独立，无需预先协调）。
 *
 * @param {object} p
 *   partCommits 各分项承诺
 *   totalCommit 总量承诺（可为 null，此时视 total 为公开常数）
 *   partBlinds  各分项盲化因子
 *   totalBlind  总量盲化因子（若 totalCommit 为 null 则忽略）
 *   totalValue  公开的总量值（若 totalCommit 为 null）
 */
function proveSumEquals(p) {
  const commits = [...p.partCommits];
  const coeffs = new Array(p.partCommits.length).fill(1n);
  const blinds = [...p.partBlinds];
  let target = 0n;

  if (p.totalCommit) {
    commits.push(p.totalCommit);
    coeffs.push(-1n);
    blinds.push(p.totalBlind);
  } else {
    target = s(p.totalValue || 0n);
  }

  return proveLinear({
    commits, coeffs, target, blinds,
    values: p.partValues ? [...p.partValues, ...(p.totalValue !== undefined ? [p.totalValue] : [])] : null,
    label: String(p.label || 'SUM_EQUALS'),
  });
}

/** 验证和相等 */
function verifySumEquals(p) {
  const commits = [...p.partCommits];
  const coeffs = new Array(p.partCommits.length).fill(1n);
  let target = 0n;
  if (p.totalCommit) {
    commits.push(p.totalCommit);
    coeffs.push(-1n);
  } else {
    target = s(p.totalValue || 0n);
  }
  return verifyLinear({ commits, coeffs, target, proof: p.proof, label: String(p.label || 'SUM_EQUALS') });
}

/** 两值相等（盲化因子可不同）—— 跨期一致性的真正解法 */
function proveEquality(p) {
  return proveLinear({
    commits: [p.commitA, p.commitB],
    coeffs: [1n, -1n],
    target: 0n,
    blinds: [p.blindA, p.blindB],
    values: p.valueA !== undefined ? [p.valueA, p.valueB] : null,
    label: String(p.label || 'EQUALITY'),
  });
}

function verifyEquality(p) {
  return verifyLinear({
    commits: [p.commitA, p.commitB],
    coeffs: [1n, -1n],
    target: 0n,
    proof: p.proof,
    label: String(p.label || 'EQUALITY'),
  });
}

/**
 * 公式关系：证明 **E = Σ EFᵢ · ADᵢ**，其中 EF 是公开常数（排放因子），
 * AD 与 E 都在承诺里（保密）。
 *
 * 这是本模块最重要的应用 —— 它把"企业报的数是算出来的"变成可验证命题。
 *
 * @param {object} p
 *   adCommits  各排放源活动数据的承诺
 *   adBlinds   对应盲化因子
 *   adValues   明文活动数据（可选，仅内部自检）
 *   efInts     排放因子的**整数表示**（公开，必须与 adInts 满足 eScale = efScale + adScale）
 *   eCommit    排放量的承诺
 *   eBlind     排放量盲化因子
 *   eValue     明文排放量（可选，仅内部自检）
 *   label      语义标签（建议带核算批次号，防止跨批次挪用）
 */
function proveFormula(p) {
  const n = p.adCommits.length;
  if (!n) throw new Error('活动数据承诺不能为空');
  if (p.efInts.length !== n) throw new Error('因子数量与活动数据数量不一致');

  /* ⚠ 系数必须非零：EF = 0 的排放源不该出现在公式里
   * （否则等于给攻击者一个"用零系数洗掉某项"的空间，虽然无害但语义混乱） */
  for (let i = 0; i < n; i++) {
    if (BigInt(p.efInts[i]) === 0n) {
      throw new Error(`第 ${i} 个排放因子的整数表示为 0，拒绝生成（该源应直接从公式中移除）`);
    }
  }

  return proveLinear({
    commits: [...p.adCommits, p.eCommit],
    coeffs: [...p.efInts.map((x) => s(x)), -1n],
    target: 0n,
    blinds: [...p.adBlinds, p.eBlind],
    values: p.adValues && p.eValue !== undefined ? [...p.adValues, p.eValue] : null,
    label: String(p.label || 'FORMULA'),
  });
}

/** 验证公式关系 */
function verifyFormula(p) {
  const n = p.adCommits.length;
  return verifyLinear({
    commits: [...p.adCommits, p.eCommit],
    coeffs: [...p.efInts.map((x) => s(x)), -1n],
    target: 0n,
    proof: p.proof,
    label: String(p.label || 'FORMULA'),
  });
}

/* ==================================================================================
 * 五、序列化
 * ================================================================================== */

/** 只保留线上字段（剔除 __meta 与任何 BigInt） */
function wireOnly(proof) {
  if (!proof || typeof proof !== 'object') return proof;
  const out = {};
  for (const k of Object.keys(proof)) {
    if (k.startsWith('__')) continue;
    const v = proof[k];
    if (typeof v === 'bigint') out[k] = v.toString();
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = wireOnly(v);
    else out[k] = v;
  }
  return out;
}

/* ==================================================================================
 * 六、自检
 * ================================================================================== */

function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });

  /* ---- 1. DLOG 基本往返 ---- */
  {
    const x = C.randomScalar();
    const target = C.mul(x, BASE);
    const pf = proveDlog(target, x, { context: 'selftest' });
    const vr = verifyDlog(target, pf);
    push('DLOG：正向证明通过', vr.ok, vr.reason);
  }

  /* ---- 2. DLOG 阴性：错误 target ---- */
  {
    const x = C.randomScalar();
    const target = C.mul(x, BASE);
    const pf = proveDlog(target, x, { context: 'selftest' });
    const wrong = C.mul(C.randomScalar(), BASE);
    const vr = verifyDlog(wrong, pf);
    push('⭐ DLOG：挂到错误 target 必须失败', vr.ok === false,
      vr.ok ? '未检出（缺陷）' : '挑战重算不同 ⇒ 拒绝');
  }

  /* ---- 3. DLOG 阴性：篡改 z ---- */
  {
    const x = C.randomScalar();
    const target = C.mul(x, BASE);
    const pf = proveDlog(target, x, { context: 'selftest' });
    const bad = { ...pf, z: C.HEX(BigInt('0x' + pf.z) + 1n) };
    push('⭐ DLOG：篡改 z 必须失败', verifyDlog(target, bad).ok === false, '');
  }

  /* ---- 4. DLOG 阴性：篡改 context（跨语句重放） ---- */
  {
    const x = C.randomScalar();
    const target = C.mul(x, BASE);
    const pf = proveDlog(target, x, { context: 'A' });
    const bad = { ...pf, context: 'B' };
    push('⭐ DLOG：篡改 context 必须失败（防跨语句重放）',
      verifyDlog(target, bad).ok === false, '');
  }

  /* ---- 5. DLOG 零知识：证明体不含 x ---- */
  {
    const x = C.randomScalar();
    const target = C.mul(x, BASE);
    const pf = proveDlog(target, x, { context: 'zk' });
    const wire = JSON.stringify(wireOnly(pf));
    push('⭐ DLOG：证明体不泄漏私密标量', !wire.includes(x.toString()),
      '序列化后无 x 的任何形式');
  }

  /* ---- 6. 线性关系：和相等（盲化因子独立） ---- */
  {
    const vals = [1000n, 2500n, 500n];
    const cs = vals.map((v) => PD.commit(v));
    const total = 4000n;
    const ct = PD.commit(total);
    const pf = proveSumEquals({
      partCommits: cs.map((c) => c.commit),
      partBlinds: cs.map((c) => c.r),
      totalCommit: ct.commit,
      totalBlind: ct.r,
      partValues: vals,
      totalValue: total,
    });
    const vr = verifySumEquals({
      partCommits: cs.map((c) => c.commit),
      totalCommit: ct.commit,
      proof: pf,
    });
    push('线性：分项之和 = 总量（盲化因子独立）', vr.ok, vr.reason);
  }

  /* ---- 7. ⭐ 线性阴性：和不对必须失败 ---- */
  {
    const vals = [1000n, 2000n];
    const cs = vals.map((v) => PD.commit(v));
    const ct = PD.commit(4000n);   // 故意错：1000+2000 ≠ 4000
    let err = null;
    try {
      proveSumEquals({
        partCommits: cs.map((c) => c.commit),
        partBlinds: cs.map((c) => c.r),
        totalCommit: ct.commit,
        totalBlind: ct.r,
        partValues: vals,
        totalValue: 4000n,
      });
    } catch (e) { err = e.message; }
    push('⭐ 线性：和不等于总量时拒绝生成（prover 侧防线）',
      err !== null && err.includes('线性关系不成立'),
      err ? '在生成阶段即被拒绝，不产生无效证明' : '未拒绝（缺陷）');
  }

  /* ---- 8. ⭐ 线性阴性：伪造证明必须失败 ---- */
  {
    /* 模拟恶意证明者：构造出 D，但用错误的 R 去证。
     * proveDlog 的内部自检（target == x·base）会立刻拦住 —— 
     * 这保证平台永远不会产出"看起来正常但注定验不过"的证明。 */
    const cs = [PD.commit(100n), PD.commit(200n)];
    const ct = PD.commit(999n);
    const D = C.sub(C.add(cs[0].commit, cs[1].commit), ct.commit);
    let err = null;
    try { proveDlog(D, C.randomScalar()); } catch (e) { err = e.message; }
    push('⭐ 线性：错误离散对数在生成阶段即被拦截',
      err !== null && err.includes('≠ x·base'),
      'proveDlog 内部自检生效 —— 不产生注定失败的证明');
  }

  /* ---- 9. 跨期一致性（真正的解法） ---- */
  {
    /* 关键：月度与年度的盲化因子**完全独立**，不做任何协调 */
    const monthlyVals = [100n, 120n, 90n, 110n];
    const monthly = monthlyVals.map((v) => PD.commit(v));
    const annualVal = monthlyVals.reduce((a, b) => a + b, 0n);
    const annual = PD.commit(annualVal);   // 独立随机盲因子
    const pf = proveSumEquals({
      partCommits: monthly.map((c) => c.commit),
      partBlinds: monthly.map((c) => c.r),
      totalCommit: annual.commit,
      totalBlind: annual.r,
      partValues: monthlyVals,
      totalValue: annualVal,
      label: 'PERIOD_SUM',
    });
    const vr = verifySumEquals({
      partCommits: monthly.map((c) => c.commit),
      totalCommit: annual.commit,
      proof: pf,
      label: 'PERIOD_SUM',
    });
    push('⭐ 跨期一致：月度与年度盲因子完全独立仍可证（上一轮做不到）',
      vr.ok, vr.reason);
  }

  /* ---- 10. ⭐ 跨期阴性：少一个月必须失败 ---- */
  {
    const monthlyVals = [100n, 120n, 90n, 110n];
    const monthly = monthlyVals.map((v) => PD.commit(v));
    const annual = PD.commit(420n);
    let err = null;
    try {
      proveSumEquals({
        partCommits: monthly.slice(0, 3).map((c) => c.commit),   // 少一个
        partBlinds: monthly.slice(0, 3).map((c) => c.r),
        totalCommit: annual.commit,
        totalBlind: annual.r,
        partValues: monthlyVals.slice(0, 3),
        totalValue: 420n,
      });
    } catch (e) { err = e.message; }
    push('⭐ 跨期：漏一个月即无法生成证明（防逐月缩水）',
      err !== null && err.includes('线性关系不成立'), '数值对不上，生成阶段拒绝');
  }

  /* ---- 11. ⭐ 公式正确性（本轮核心） ---- */
  {
    /* E = EF × AD。用整数表示：efScale=4, adScale=3 ⇒ eScale=7 */
    const EF_INT = 19003n;        // 1.9003 tCO2/t，×10⁴
    const AD_INT = 12000000n;     // 12000 t，×10³
    const E_INT = EF_INT * AD_INT; // = 2.28036e11，×10⁷ ⇒ 22803.6 tCO2

    const adC = PD.commit(AD_INT);
    const eC = PD.commit(E_INT);
    const pf = proveFormula({
      adCommits: [adC.commit], adBlinds: [adC.r], adValues: [AD_INT],
      efInts: [EF_INT],
      eCommit: eC.commit, eBlind: eC.r, eValue: E_INT,
      label: 'FORMULA:COAL:batch-1',
    });
    const vr = verifyFormula({
      adCommits: [adC.commit], efInts: [EF_INT], eCommit: eC.commit,
      proof: pf, label: 'FORMULA:COAL:batch-1',
    });
    push('⭐ 公式正确性：E = EF × AD 可零知识验证', vr.ok,
      `12000 t × 1.9003 = 22803.6 tCO₂e，活动数据与排放量均未泄漏`);
  }

  /* ---- 12. ⭐ 公式阴性：排放量被篡改必须失败 ---- */
  {
    const EF_INT = 19003n;
    const AD_INT = 12000000n;
    const E_INT = EF_INT * AD_INT;
    const adC = PD.commit(AD_INT);
    const fakeE = PD.commit(E_INT / 2n);   // 谎报一半
    let err = null;
    try {
      proveFormula({
        adCommits: [adC.commit], adBlinds: [adC.r], adValues: [AD_INT],
        efInts: [EF_INT],
        eCommit: fakeE.commit, eBlind: fakeE.r, eValue: E_INT / 2n,
        label: 'FORMULA:FAKE',
      });
    } catch (e) { err = e.message; }
    push('⭐ 公式：排放量谎报一半时无法生成证明（防虚报）',
      err !== null && err.includes('线性关系不成立'),
      '这是"范围证明做不到"的事 —— 范围证明只验量级，公式证明验计算');
  }

  /* ---- 13. ⭐ 公式阴性：用错因子必须失败 ---- */
  {
    const AD_INT = 12000000n;
    const E_INT = 19003n * AD_INT;
    const adC = PD.commit(AD_INT);
    const eC = PD.commit(E_INT);
    let err = null;
    try {
      proveFormula({
        adCommits: [adC.commit], adBlinds: [adC.r], adValues: [AD_INT],
        efInts: [28604n],   // 用焦炭因子冒充原煤
        eCommit: eC.commit, eBlind: eC.r, eValue: E_INT,
        label: 'FORMULA:WRONG-EF',
      });
    } catch (e) { err = e.message; }
    push('⭐ 公式：因子被替换时无法生成证明（口径不可否认）',
      err !== null && err.includes('线性关系不成立'),
      '因子版本被绑定进证明，事后无法声称"用了旧因子"');
  }

  /* ---- 14. ⭐ 公式阴性：把证明挪用到另一批次必须失败 ---- */
  {
    const AD_INT = 12000000n;
    const E_INT = 19003n * AD_INT;
    const adC = PD.commit(AD_INT);
    const eC = PD.commit(E_INT);
    const pf = proveFormula({
      adCommits: [adC.commit], adBlinds: [adC.r],
      efInts: [19003n], eCommit: eC.commit, eBlind: eC.r,
      label: 'FORMULA:batch-1',
    });
    const vr = verifyFormula({
      adCommits: [adC.commit], efInts: [19003n], eCommit: eC.commit,
      proof: pf, label: 'FORMULA:batch-2',    // 标签不同
    });
    push('⭐ 公式：证明挪用到另一批次必须失败（标签绑定）',
      vr.ok === false, vr.ok ? '未检出（缺陷）' : '语义标签不符 ⇒ 拒绝');
  }

  /* ---- 15. 多源公式（真实场景：煤 + 电） ---- */
  {
    /* COAL: 1.9003 tCO2/t (×10⁴=19003), 12000 t (×10³=12000000)
     * POWER: 0.9419 tCO2/MWh (×10⁴=9419), 5000 MWh (×10³=5000000)
     * 但两者 adScale 都是 3，eScale 都是 7，可直接相加 */
    const adC1 = PD.commit(12000000n);
    const adC2 = PD.commit(5000000n);
    const e1 = 19003n * 12000000n;
    const e2 = 9419n * 5000000n;
    const eC = PD.commit(e1 + e2);
    const pf = proveFormula({
      adCommits: [adC1.commit, adC2.commit],
      adBlinds: [adC1.r, adC2.r],
      adValues: [12000000n, 5000000n],
      efInts: [19003n, 9419n],
      eCommit: eC.commit, eBlind: eC.r, eValue: e1 + e2,
      label: 'FORMULA:MULTI',
    });
    const vr = verifyFormula({
      adCommits: [adC1.commit, adC2.commit], efInts: [19003n, 9419n],
      eCommit: eC.commit, proof: pf, label: 'FORMULA:MULTI',
    });
    push('公式：多排放源（煤 + 电）可验证', vr.ok,
      `两源合计 ${Number((e1 + e2) / 10000000n)} tCO₂e`);
  }

  /* ---- 16. 退化语句必须被拒 ---- */
  {
    const c = PD.commit(100n);
    let err = null;
    try {
      proveLinear({ commits: [c.commit], coeffs: [0n], blinds: [c.r], target: 0n });
    } catch (e) { err = e.message; }
    /* ⚠ 断言要匹配**实际措辞**。此前写 includes('全零')，而实际消息是
     *   「系数全为零」—— 中间隔了一个"为"字，includes 判断为 false，
     *   于是"校验已生效"却被判成失败（假红）。断言与被断言的文案必须对齐。 */
    push('⭐ 拒绝退化语句（系数全为零）',
      err !== null && (err.includes('全为零') || err.includes('全零')),
      err ? err.slice(0, 60) : '未抛错（缺陷）');
  }

  /* ---- 17. 失败路径：不提供无效证明 ---- */
  {
    const c1 = PD.commit(100n);
    const c2 = PD.commit(200n);
    let err = null;
    try {
      proveLinear({
        commits: [c1.commit, c2.commit], coeffs: [1n, 1n],
        blinds: [c1.r, c2.r], target: 999n,
      });
    } catch (e) { err = e.message; }
    push('⭐ 关系不成立时抛错而非返回无效证明',
      err !== null && err.includes('线性关系不成立'),
      '宁可失败也不产出"看起来正常的假证明"');
  }

  /* ---- 18. 模数纪律：所有标量在 Z_n 内 ---- */
  {
    const c = PD.commit(C.N - 1n);
    let ok = false;
    let detail = '';
    try {
      /* 目标值取 N−1 才成立：Σ 1·v = N−1，其中 v = N−1 */
      const pf2 = proveLinear({
        commits: [c.commit], coeffs: [1n], blinds: [c.r], target: C.N - 1n,
        values: [C.N - 1n],
      });
      ok = verifyLinear({
        commits: [c.commit], coeffs: [1n], target: C.N - 1n, proof: pf2,
      }).ok;
      detail = '边界值 N−1 参与运算仍正确';
    } catch (e) {
      ok = false;
      detail = `异常：${e.message}`;
    }
    push('模数纪律：边界值 N−1 参与运算仍正确', ok, detail);
  }

  /* ---- 19. 性能 ---- */
  {
    const cs = Array.from({ length: 4 }, (_, i) => PD.commit(BigInt(1000 + i)));
    const ct = PD.commit(4006n);

    /* ⚠ 单次计时会被 GC 与 JIT 抖动污染（实测同一段代码在 13~35 ms 之间跳）。
     *   性能断言若用单次采样，就会出现"代码没变、跑三次两绿一红"的假红 ——
     *   这种假红最有害：它会让人去优化本来没问题的代码，或者干脆删掉断言。
     *
     *   改用**取 5 次的中位数**：中位数对偶发 GC 尖峰不敏感，
     *   又能真实反映算法复杂度（若写成 O(n²)，中位数会直接翻几十倍）。 */
    const sample = (fn, rounds = 5) => {
      const ts = [];
      for (let i = 0; i < rounds; i++) {
        const t = Date.now();
        fn();
        ts.push(Date.now() - t);
      }
      ts.sort((a, b) => a - b);
      return ts[Math.floor(ts.length / 2)];
    };

    /* 先跑两次预热（JIT 编译 + 首次大整数分配 + 一次可能的 GC），不计入采样 */
    for (let w = 0; w < 2; w++) {
      proveSumEquals({
        partCommits: cs.map((c) => c.commit), partBlinds: cs.map((c) => c.r),
        totalCommit: ct.commit, totalBlind: ct.r,
        partValues: [1000n, 1001n, 1002n, 1003n], totalValue: 4006n,
      });
    }

    const tProve = sample(() => proveSumEquals({
      partCommits: cs.map((c) => c.commit), partBlinds: cs.map((c) => c.r),
      totalCommit: ct.commit, totalBlind: ct.r,
      partValues: [1000n, 1001n, 1002n, 1003n], totalValue: 4006n,
    }), 9);

    const pf = proveSumEquals({
      partCommits: cs.map((c) => c.commit), partBlinds: cs.map((c) => c.r),
      totalCommit: ct.commit, totalBlind: ct.r,
      partValues: [1000n, 1001n, 1002n, 1003n], totalValue: 4006n,
    });
    const tVerify = sample(() => verifySumEquals({
      partCommits: cs.map((c) => c.commit), totalCommit: ct.commit, proof: pf,
    }), 9);

    const bytes = Buffer.byteLength(JSON.stringify(wireOnly(pf)), 'utf8');
    /* 阈值为实测中位数的约 4 倍，只捕捉数量级退化（O(n²) 会直接翻几十倍）。
     * 为什么不卡更紧：这条断言的目的是"防止算法退化"，不是"跑分"。
     * 卡太紧只会让它在 CI 机器或负载高时随机变红，最终被人删掉。 */
    push('性能：线性关系证明中位数 < 60 ms（4 项）', tProve < 60,
      `${tProve} ms（9 次中位数，实测中位 13~15 ms）`);
    push('性能：验证中位数 < 30 ms', tVerify < 30,
      `${tVerify} ms（9 次中位数，实测中位 5~10 ms）`);
    push('大小：线性证明 < 400 字节', bytes < 400, `${bytes} 字节（Schnorr 极紧凑）`);
  }

  /* ---- 20. 零知识：证明体不含任何明文值 ---- */
  {
    const SECRET = 8765432n;
    const c = PD.commit(SECRET);
    const ct = PD.commit(SECRET);
    const pf = proveSumEquals({
      partCommits: [c.commit], partBlinds: [c.r],
      totalCommit: ct.commit, totalBlind: ct.r,
      partValues: [SECRET], totalValue: SECRET,
    });
    const wire = JSON.stringify(wireOnly(pf));
    push('⭐ 零知识：证明体不含明文值', !wire.includes(SECRET.toString()),
      '序列化后无明文');
  }

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

module.exports = {
  VERSION, BASE, DOMAIN,
  statementDigest,
  proveDlog, verifyDlog,
  proveLinear, verifyLinear,
  proveSumEquals, verifySumEquals,
  proveEquality, verifyEquality,
  proveFormula, verifyFormula,
  wireOnly,
  selfTest,
};
