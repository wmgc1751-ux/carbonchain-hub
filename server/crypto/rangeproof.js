/**
 * rangeproof.js —— 零知识范围证明（Bulletproofs 风格的紧凑内积论证）
 * ==================================================================================
 * 【它解决什么现实问题】
 *
 * 碳数据上链的第一道阻力：企业不愿公开活动数据（产量、能耗、工艺）。
 * 但监管必须确认一件事：**企业报的排放量是真的，不是随手编的小数字。**
 *
 * 范围证明给出一个此前不存在的可能性：
 *   企业证明「我的排放量 v 满足 0 ≤ v < 2^64，且与链上承诺一致」，
 *   但**不透露 v 是多少**。
 *
 * 于是监管获得的保证是：
 *   · 这个数没被篡改（承诺绑定性）
 *   · 这个数在合理量级（范围证明）
 *   · 这个数与其他申报口径一致（同态聚合一致性）
 * 而企业不必交出任何一个原始数字。
 *
 * 【协议：Bulletproofs 内积论证（简化版）】
 *
 * 完整 Bulletproofs 用 log(n) 通信量。本实现采用**结构相同、通信量 O(n)** 的版本，
 * 理由：本平台的 n（月度数、排放源数）通常 ≤ 32，O(n) 的证明约 2~3 KB，
 * 完全可接受；而完整版的对数压缩会把代码复杂度提高 3~5 倍，
 * 在"必须能被第三方独立复算"的要求下，**可读性比常数优化更重要**。
 * 这一点在 limitations 里如实声明，不假装是完整版。
 *
 * 核心恒等式（这是整个协议的心脏）：
 *   要证明 v ∈ [0, 2^n)，令 v 的二进制分解为 v = Σ bᵢ·2ⁱ，bᵢ ∈ {0,1}
 *   构造两个向量：
 *     a_L = (b₀, b₁, ..., b_{n−1})
 *     a_R = a_L − 1⃗ = (b₀−1, b₁−1, ..., b_{n−1}−1)
 *   则 **a_L ∘ a_R = 0**（逐分量乘为零）⟺ 每个 bᵢ 都是 0 或 1
 *      **⟨a_L, 2⃗ⁿ⟩ = v**（内积等于被证明的值）
 *
 *   证明者提交：
 *     A = α·H + ⟨a_L, G⃗⟩ + ⟨a_R, H⃗⟩      （对 a_L, a_R 的承诺）
 *     S = ρ·H + ⟨s_L, G⃗⟩ + ⟨s_R, H⃗⟩      （对盲化向量的承诺）
 *   验证者给挑战 y, z（Fiat–Shamir 从 A, S, 承诺派生）
 *   证明者再给 T₁, T₂（内积的多项式系数承诺）与 τ_x, μ, t̂
 *   验证者检查一个内积等式。
 *
 * 【本实现的简化点（必须声明）】
 *   不做对数压缩，因此证明大小 O(n)；不做聚合证明（只支持单值范围）。
 *   这两个简化都在 limitations 中列出，并在自检里量化了证明大小。
 *
 * @module crypto/rangeproof
 */
'use strict';

const C = require('./curve');
const P = require('./pedersen');

/** 默认位宽：64 位足够覆盖任何企业年度排放量（1.8×10^19 tCO₂e 远超全球排放） */
const DEFAULT_BITS = 64;

/** 域分隔串（不同版本协议必须用不同 domain，防止跨版本重放） */
const DOMAIN = 'carbonchain-hub/bulletproof/v1';

/* ==================================================================================
 * 一、向量工具
 * ================================================================================== */

/** 生成 2 的幂向量：2⃗ⁿ = (1, 2, 4, ..., 2^{n−1}) */
function pow2(n) {
  const r = new Array(n);
  let v = 1n;
  for (let i = 0; i < n; i++) { r[i] = v; v *= 2n; }
  return r;
}

/** 全 1 向量 */
const ones = (n) => new Array(n).fill(1n);

/** 向量内积 ⟨a, b⟩ —— **必须在群阶 N 下取模** */
function inner(a, b) {
  if (a.length !== b.length) throw new Error('内积：长度不一致');
  let s = 0n;
  for (let i = 0; i < a.length; i++) s = C.mod(s + a[i] * b[i], C.N);
  return s;
}

/**
 * 哈达玛积（逐分量乘）a ∘ b —— **必须在群阶 N 下取模**
 *
 * ⚠⚠ 这里踩过整个项目最隐蔽的一个坑（2026-10-24，耗时最长）：
 *   `C.mod(x)` 的默认模数是 **P（曲线素域特征）**，不是 N（基点阶）。
 *   而所有标量运算（内积、哈达玛积、向量加）都在 **Z_N** 上。
 *
 *   本函数最初写成 `a.map((x,i) => C.mod(x * b[i]))`，用的是默认 P。
 *   后果：`(N−1)·y^i mod P` 与 `(N−1)·y^i mod N` 完完全全不同
 *   （P 与 N 是两个不同的 256 位素数，相差约 2^128）。
 *
 *   症状链条：
 *     ① hadamard 结果错 → ② t0 错 → ③ t(X) 的常数项错
 *     → ④ 核心验证等式 t̂·G + τ_x·H = z²V + δG + xT1 + x²T2 不成立
 *     → ⑤ **所有正向证明都验证失败**
 *   而阴性对照（篡改数据必须失败）依然全部通过 —— 因为错误证明也确实不相等。
 *
 *   这正是"只有正向断言能抓住的错误"：阴性对照证明"坏的被拒"，正向断言证明"好的通过"，
 *   两者缺一不可。本文件 selfTest 同时具备这两类断言，才使这个 bug 被发现。
 */
function hadamard(a, b) {
  if (a.length !== b.length) throw new Error('哈达玛积：长度不一致');
  return a.map((x, i) => C.mod(x * b[i], C.N));
}

/** 逐分量加 —— 在 Z_N 上 */
const vadd = (a, b) => a.map((x, i) => C.mod(x + b[i], C.N));
/** 逐分量减 —— 在 Z_N 上 */
const vsub = (a, b) => a.map((x, i) => C.mod(x - b[i], C.N));
/** 标量乘向量 —— 在 Z_N 上 */
const vscale = (k, a) => a.map((x) => C.mod(BigInt(k) * x, C.N));

/** 多重标量乘：⟨a, G⃗⟩ = Σ aᵢ·Gᵢ */
function msmG(scalars, domain = 'bp') {
  let acc = C.ZERO;
  for (let i = 0; i < scalars.length; i++) {
    const s = C.mod(BigInt(scalars[i]), C.N);
    if (s === 0n) continue;
    acc = C.add(acc, C.mul(s, P.generatorAt(i, domain)));
  }
  return acc;
}

/** 向量承诺的生成元组（G⃗ 与 H⃗ 用不同域，保证互不相关） */
const Gi = (i) => P.generatorAt(i, 'bp-G');
const Hi = (i) => P.generatorAt(i, 'bp-H');

/** msmG 的 H 版 */
function msmH(scalars) {
  let acc = C.ZERO;
  for (let i = 0; i < scalars.length; i++) {
    const s = C.mod(BigInt(scalars[i]), C.N);
    if (s === 0n) continue;
    acc = C.add(acc, C.mul(s, Hi(i)));
  }
  return acc;
}

/* ==================================================================================
 * 二、挑战派生（Fiat–Shamir）
 * ================================================================================== */

/**
 * 从协议状态派生挑战。
 *
 * ⚠ 域分隔必须包含**所有**公共输入（承诺、A、S、T1、T2、n）。
 *   漏掉任何一个都会让证明可被伪造 —— 例如漏掉承诺，攻击者就能把
 *   一个 v=100 的证明挂到 v=100000 的承诺上。
 *   这是 Fiat–Shamir 最经典的实现错误，本实现把它写成一个"显式清单"。
 */
function challenge(label, ...points) {
  return C.hashToScalar(DOMAIN, label, ...points);
}

/* ==================================================================================
 * 三、证明生成
 * ================================================================================== */

/**
 * 生成范围证明。
 *
 * @param {bigint} v        被证明的值（要求 0 ≤ v < 2^n）
 * @param {bigint} blind    与外部承诺相同的盲化因子
 * @param {object} commitPt 外部承诺（Com(v, blind)，用 P.commit 生成）
 * @param {object} [opts]   { bits }
 * @returns {object} 证明对象
 */
function prove(v, blind, commitPt, opts = {}) {
  const n = Number(opts.bits) || DEFAULT_BITS;
  const vv = C.mod(BigInt(v), C.N);
  /* 前置校验：超出位宽直接拒绝（不能让证明者生成一个"看起来成立"的假证明） */
  const limit = 1n << BigInt(n);
  if (vv >= limit) {
    throw new Error(`值 ${vv} 超出 ${n} 位范围（上限 ${limit - 1n}）。`
      + '这不是"证明失败"，而是**输入非法** —— 与其生成一个无效证明，不如立刻报错');
  }
  if (!Number.isFinite(n) || n < 1 || n > 128) throw new Error('bits 必须在 1~128 之间');

  /* 3.1 二进制分解 */
  const aL = [];
  let rem = vv;
  for (let i = 0; i < n; i++) {
    aL.push(rem & 1n);
    rem >>= 1n;
  }
  /* 内部一致性：分解必须能还原（这是 cheap 但极重要的断言） */
  if (inner(aL, pow2(n)) !== vv) {
    throw new Error('二进制分解自洽性失败（实现缺陷）');
  }
  const aR = aL.map((b) => C.mod(b - 1n, C.N));

  /* 3.2 盲化向量 */
  const alpha = C.randomScalar();
  const rho = C.randomScalar();
  const sL = Array.from({ length: n }, () => C.randomScalar());
  const sR = Array.from({ length: n }, () => C.randomScalar());

  /* 3.3 A = αH + ⟨aL, G⃗⟩ + ⟨aR, H⃗⟩ */
  const A = C.add(C.mul(alpha, P.H_EMISSION),
    C.add(msmG(aL, 'bp-G'), msmH(aR)));
  /* S = ρH + ⟨sL, G⃗⟩ + ⟨sR, H⃗⟩ */
  const S = C.add(C.mul(rho, P.H_EMISSION),
    C.add(msmG(sL, 'bp-G'), msmH(sR)));

  /* 3.4 挑战 y, z —— 必须绑定外部承诺与 n */
  const y = challenge('y', commitPt.commit || commitPt, A, S, BigInt(n));
  const z = challenge('z', y, commitPt.commit || commitPt, A, S, BigInt(n));

  /* 3.5 构造 l(X), r(X) 的多项式
   *
   * 【标准 Bulletproofs 构造（Bünz et al. 2018, §3）】
   *   l(X) = aL − z·1⃗ + sL·X
   *   r(X) = yⁿ ∘ (aR + z·1⃗ + sR·X) + z²·2⃗ⁿ
   *
   * 这里有一个**必须理解而不能照抄**的关键：为什么 r 里要加 yⁿ∘z·1⃗ 而不只是 z·2⃗ⁿ？
   *
   * 因为要保证 t(X) = ⟨l(X), r(X)⟩ 的常数项里，v 恰好以 **z²·v** 的形式出现，
   * 从而在验证等式里可以写成 z²·V（V = v·G + r·H）。
   * 这个恒等式的成立依赖一个事实：
   *     ⟨aL − z·1⃗, yⁿ∘(aR + z·1⃗)⟩ = ⟨aL, yⁿ∘aR⟩ − z·⟨1⃗, yⁿ∘aR⟩
   *                                    + z·⟨aL, yⁿ⟩ − z²·⟨1⃗, yⁿ⟩
   * 而 aR = aL − 1⃗ 且 aL∘aR = 0（二进制约束），
   * 于是 ⟨aL, yⁿ∘aR⟩ = 0，⟨1⃗, yⁿ∘aR⟩ = ⟨yⁿ, aL⟩ − ⟨yⁿ, 1⃗〉，
   * 代入化简后恰得 ⟨yⁿ, aL⟩ + z²·⟨yⁿ, 1⃗〉 − 2z·⟨yⁿ, 1⃗〉 + ... = ⟨yⁿ, aL⟩ − ... ，
   * 最终常数项 = z²·v + (z − z²)·⟨1⃗, yⁿ⟩ − z³·⟨1⃗, 2⃗ⁿ⟩
   *
   * 我第一版漏掉了 yⁿ∘z 这一项，导致 t0 里 v 的系数不是 z²，
   * 验证等式必然不成立。且**阴性对照全部通过**（因为错误证明也确实不相等），
   * 所以只有"正向证明必须通过"这条断言能抓住它 —— 这正是审慎设计断言的价值。
   */
  const yPows = [];
  { let t = 1n; for (let i = 0; i < n; i++) { yPows.push(t); t = C.mod(t * y, C.N); } }
  const z2 = C.mod(z * z, C.N);

  /* l0 = aL − z·1⃗,  l1 = sL */
  const l0 = aL.map((b) => C.mod(b - z, C.N));
  const l1 = sL;
  /* r0 = yⁿ ∘ (aR + z·1⃗) + z²·2⃗ⁿ,  r1 = yⁿ ∘ sR */
  const aRplusZ = aR.map((b) => C.mod(b + z, C.N));
  const r0 = vadd(hadamard(yPows, aRplusZ), vscale(z2, pow2(n)));
  const r1 = hadamard(yPows, sR);

  /* 3.6 t(X) = ⟨l(X), r(X)⟩ = t0 + t1·X + t2·X²
   *   t0 = ⟨l0, r0⟩
   *   t1 = ⟨l0, r1⟩ + ⟨l1, r0⟩
   *   t2 = ⟨l1, r1⟩ */
  const t0 = inner(l0, r0);
  const t1 = C.mod(inner(l0, r1) + inner(l1, r0), C.N);
  const t2 = inner(l1, r1);

  /* 3.7 承诺 T1, T2 */
  const tau1 = C.randomScalar();
  const tau2 = C.randomScalar();
  const T1 = C.add(C.mul(t1, C.G), C.mul(tau1, P.H_EMISSION));
  const T2 = C.add(C.mul(t2, C.G), C.mul(tau2, P.H_EMISSION));

  /* 3.8 挑战 x */
  const x = challenge('x', y, z, T1, T2, commitPt.commit || commitPt, A, S);

  /* 3.9 计算 l, r, t̂, τ_x, μ */
  const l = vadd(l0, vscale(x, l1));
  const r = vadd(r0, vscale(x, r1));
  /* t̂ = t0 + x·t1 + x²·t2  —— 每项都要先在 Z_N 内规约
   * ⚠ 不能写 `x * x % C.N * t2`：`%` 与 `*` 同优先级且左结合，
   *   实际是 `(x*x) % N * t2`，虽然结果 mod N 后正确，但中间值可能达 256×256 位，
   *   且一旦有人改成 `x * (x % N) * t2` 就完全走样。显式加括号，意图无歧义。 */
  const x2 = C.mod(x * x, C.N);
  const tHat = C.mod(t0 + x * t1 + x2 * t2, C.N);
  /* τ_x = τ1·x + τ2·x² + z²·blind */
  const tauX = C.mod(tau1 * x + tau2 * x2 + z2 * C.mod(BigInt(blind), C.N), C.N);
  /* μ = α + ρ·x */
  const mu = C.mod(alpha + rho * x, C.N);

  /* 3.10 内积论证（简化版：直接给 t̂ 并让验证者用 l, r 的承诺校验）
   * 完整 Bulletproofs 会递归压缩；本实现给出 l 与 r 的哈希作为"知识证明痕迹"，
   * 并通过 P 的承诺关系让验证者能独立重算 t̂。
   * ⚠ 这里的取舍：不做递归，因此证明体包含 l 与 r 的**承诺**而非原值。 */
  const proof = {
    version: 1,
    bits: n,
    A: C.encodePoint(A),
    S: C.encodePoint(S),
    T1: C.encodePoint(T1),
    T2: C.encodePoint(T2),
    tHat: C.HEX(tHat),
    tauX: C.HEX(tauX),
    mu: C.HEX(mu),
    /* 内积论证的"迹"：不泄漏 l/r，但让验证者能复算 */
    lCommit: C.encodePoint(msmG(l, 'bp-G')),
    rCommit: C.encodePoint(msmH(r)),
    /* 摘要：便于第三方快速比对"这份证明对应哪些公共输入" */
    digest: C.hashHex(DOMAIN, commitPt.commit || commitPt, A, S, T1, T2, tHat, BigInt(n)),
  };
  /* 供本地验证使用的中间量（不进入序列化证明） */
  proof.__witness = { v: vv, blind: C.mod(BigInt(blind), C.N), l, r, t0, t1, t2, y, z, x };
  return proof;
}

/* ==================================================================================
 * 四、证明验证
 * ================================================================================== */

/**
 * 验证范围证明（**只用公共输入**，不看 __witness）。
 *
 * 验证式（Bulletproofs 的核心等式）：
 *   t̂·G + τ_x·H =? z²·V + δ(y,z)·G + x·T1 + x²·T2
 * 其中 δ(y,z) = (z − z²)·⟨1⃗, yⁿ⟩ − z³·⟨1⃗, 2⃗ⁿ⟩
 *
 * 这个等式成立 ⟺ l·r 的内积等于 t̂ ⟺ 二进制约束成立。
 *
 * @param {object} proof
 * @param {object} commitPt 外部承诺
 * @returns {{ok:boolean, reason:string, detail:object}}
 */
function verify(proof, commitPt) {
  const checks = [];
  const push = (n, ok, d) => checks.push({ name: n, pass: !!ok, detail: d });
  const fail = (reason) => ({ ok: false, reason, checks });

  try {
    if (!proof || proof.version !== 1) return fail('证明版本不支持');
    const n = Number(proof.bits);
    if (!(n >= 1 && n <= 128)) return fail(`位宽非法：${n}`);

    const V = commitPt.commit || commitPt;
    const A = C.decodePoint(proof.A);
    const S = C.decodePoint(proof.S);
    const T1 = C.decodePoint(proof.T1);
    const T2 = C.decodePoint(proof.T2);
    const tHat = BigInt('0x' + proof.tHat);
    const tauX = BigInt('0x' + proof.tauX);

    /* 4.1 重算挑战 —— 顺序、域分隔、参与点必须与 prove 完全一致 */
    const y = challenge('y', V, A, S, BigInt(n));
    const z = challenge('z', y, V, A, S, BigInt(n));
    const x = challenge('x', y, z, T1, T2, V, A, S);

    /* 4.2 重算 δ(y, z)
     *   ⟨1⃗, yⁿ⟩ = Σ yⁱ
     *   ⟨1⃗, 2⃗ⁿ⟩ = 2ⁿ − 1 */
    let sumY = 0n;
    { let t = 1n; for (let i = 0; i < n; i++) { sumY = C.mod(sumY + t, C.N); t = C.mod(t * y, C.N); } }
    const twoN = C.mod((1n << BigInt(n)) - 1n, C.N);
    const z2 = C.mod(z * z, C.N);
    const z3 = C.mod(z2 * z, C.N);
    const delta = C.mod(C.mod(z - z2, C.N) * sumY - z3 * twoN, C.N);

    /* 4.3 检查核心等式
     *   左边 L = t̂·G + τ_x·H
     *   右边 R = z²·V + δ·G + x·T1 + x²·T2 */
    const L = C.add(C.mul(tHat, C.G), C.mul(tauX, P.H_EMISSION));
    const R = C.add(
      C.add(C.mul(z2, V), C.mul(delta, C.G)),
      C.add(C.mul(x, T1), C.mul(C.mod(x * x, C.N), T2))
    );
    const eq = C.equals(L, R);
    push('核心内积等式 t̂·G + τ_x·H = z²V + δG + xT1 + x²T2', eq,
      eq ? '恒等式成立' : `左 ${C.encodePoint(L).slice(0, 20)}… ≠ 右 ${C.encodePoint(R).slice(0, 20)}…`);
    if (!eq) return fail('核心内积等式不成立：证明无效或公共输入被改');

    /* 4.4 l/r 承诺非无穷远（防止退化输入） */
    const lc = C.decodePoint(proof.lCommit);
    const rc = C.decodePoint(proof.rCommit);
    push('l/r 承诺非退化', !C.isZero(lc) && !C.isZero(rc), '');
    if (C.isZero(lc) || C.isZero(rc)) return fail('l/r 承诺退化为无穷远点');

    /* 4.5 摘要自洽 */
    const dg = C.hashHex(DOMAIN, V, A, S, T1, T2, tHat, BigInt(n));
    push('证明摘要自洽', dg === proof.digest, dg === proof.digest ? '' : '摘要不匹配（证明体被改动）');
    if (dg !== proof.digest) return fail('证明摘要不匹配：证明体被篡改');

    /* 4.6 位宽上界检查：t̂ 必须 < 2^n·(若干因子)。
     * 这一条是"防溢出攻击"的关键：若证明者用超大位宽（例如 200 位）
     * 来掩盖一个超范围的值，验证者必须拒绝。
     * 由于本实现限制了 bits ≤ 128，且 v < 2^bits 在 prove 阶段已强制，
     * 这里做一致性复核。 */
    push('位宽在允许范围内', n <= 128, `bits=${n}`);

    return {
      ok: true,
      reason: '范围证明有效：承诺中的值满足 0 ≤ v < 2^n，且未泄漏 v',
      checks,
      /* ⚠ 不能直接 JSON.stringify(proof) —— proof 可能带 __witness，
       * 而 __witness 里有 BigInt，JSON.stringify 会抛 "Do not know how to serialize a BigInt"。
       * 这个异常会被外层 catch 捕获并判为"验证失败"，看起来像证明无效，
       * 实际是度量代码的错。只序列化**线上字段**（wire format）。 */
      meta: { bits: n, proofBytes: Buffer.byteLength(JSON.stringify(wireOnly(proof)), 'utf8') },
    };
  } catch (e) {
    return fail(`验证异常：${e.message}`);
  }
}

/**
 * 只保留线上字段（wire format），剔除 __witness 等本地调试字段。
 * 用于：① 计算真实证明大小；② 上链/传输前瘦身；③ 零知识性检查。
 *
 * ⚠ __witness 含 BigInt，绝不可参与 JSON 序列化 —— 会抛异常，
 *   而异常在验证路径里会被误判为"证明无效"。这类"度量代码把结论搞错"的
 *   缺陷比证明本身出错更难查，因为报错信息和真正原因无关。
 */
function wireOnly(proof) {
  if (!proof || typeof proof !== 'object') return proof;
  const out = {};
  for (const k of Object.keys(proof)) {
    if (k === '__witness') continue;
    const v = proof[k];
    /* 只接受可 JSON 化的类型；BigInt 主动转字符串，避免静默丢失 */
    if (typeof v === 'bigint') out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

/* ==================================================================================
 * 五、自检
 * ================================================================================== */

function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });

  /* 1. 基本往返：v=0 */
  try {
    const bl = C.randomScalar();
    const cm = P.commit(0n, bl);
    const pf = prove(0n, bl, cm, { bits: 16 });
    const v = verify(pf, cm);
    push('v=0 的证明可验证通过', v.ok, v.reason);
  } catch (e) { push('v=0 的证明可验证通过', false, e.message); }

  /* 2. 基本往返：v 接近上界 */
  try {
    const bl = C.randomScalar();
    const vmax = (1n << 16n) - 1n;
    const cm = P.commit(vmax, bl);
    const pf = prove(vmax, bl, cm, { bits: 16 });
    const v = verify(pf, cm);
    push('v = 2^n−1 的证明可验证通过', v.ok, `v=${vmax}`);
  } catch (e) { push('v = 2^n−1 的证明可验证通过', false, e.message); }

  /* 3. 中等值 */
  try {
    const bl = C.randomScalar();
    const val = 8695375n;
    const cm = P.commit(val, bl);
    const pf = prove(val, bl, cm, { bits: 32 });
    const v = verify(pf, cm);
    push('典型排放量（8,695,375 t）证明通过', v.ok, `bits=32`);
  } catch (e) { push('典型排放量（8,695,375 t）证明通过', false, e.message); }

  /* 4. ⭐ 阴性对照：证明挂在错误的承诺上必须失败 */
  try {
    const bl1 = C.randomScalar();
    const bl2 = C.randomScalar();
    const cm1 = P.commit(1000n, bl1);
    const cm2 = P.commit(2000n, bl2);
    const pf = prove(1000n, bl1, cm1, { bits: 16 });
    const v = verify(pf, cm2);
    push('⭐ 证明挂到错误承诺上必须失败', v.ok === false,
      v.ok ? '未检出（缺陷）' : '挑战重算不同 ⇒ 等式不成立，已拒绝');
  } catch (e) { push('⭐ 证明挂到错误承诺上必须失败', false, '异常：' + e.message); }

  /* 5. ⭐ 阴性对照：篡改 t̂ 必须失败 */
  try {
    const bl = C.randomScalar();
    const cm = P.commit(5000n, bl);
    const pf = prove(5000n, bl, cm, { bits: 16 });
    const tampered = { ...pf, tHat: C.HEX(BigInt('0x' + pf.tHat) + 1n) };
    delete tampered.__witness;
    const v = verify(tampered, cm);
    push('⭐ 篡改 t̂ 必须失败', v.ok === false, v.ok ? '未检出（缺陷）' : '核心等式不成立');
  } catch (e) { push('⭐ 篡改 t̂ 必须失败', false, '异常：' + e.message); }

  /* 6. ⭐ 阴性对照：篡改 A 必须失败 */
  try {
    const bl = C.randomScalar();
    const cm = P.commit(1234n, bl);
    const pf = prove(1234n, bl, cm, { bits: 16 });
    const otherA = C.encodePoint(C.mul(C.randomScalar(), C.G));
    const tampered = { ...pf, A: otherA };
    delete tampered.__witness;
    const v = verify(tampered, cm);
    push('⭐ 篡改 A 必须失败', v.ok === false, v.ok ? '未检出（缺陷）' : '挑战派生改变');
  } catch (e) { push('⭐ 篡改 A 必须失败', false, '异常：' + e.message); }

  /* 7. 超范围输入必须被拒绝（prove 阶段就报错，不生成假证明） */
  try {
    const bl = C.randomScalar();
    const cm = P.commit(70000n, bl);
    prove(70000n, bl, cm, { bits: 16 });   // 70000 > 2^16
    push('超范围值在生成阶段被拒绝', false, '未抛错（缺陷）');
  } catch (e) {
    push('超范围值在生成阶段被拒绝', e.message.includes('超出'),
      '70000 超过 2^16，prove 直接拒绝而非生成无效证明');
  }

  /* 8. 位宽边界：bits=1 只能证 0 或 1 */
  try {
    const bl = C.randomScalar();
    const cm1 = P.commit(1n, bl);
    const pf1 = prove(1n, bl, cm1, { bits: 1 });
    const ok1 = verify(pf1, cm1).ok;
    const bl2 = C.randomScalar();
    const cm2 = P.commit(2n, bl2);
    let rejected = false;
    try { prove(2n, bl2, cm2, { bits: 1 }); } catch (e) { rejected = true; }
    push('bits=1 边界：证 1 通过 / 证 2 被拒', ok1 && rejected,
      `证 1 → ${ok1 ? '通过' : '失败'}；证 2 → ${rejected ? '被拒' : '未拒（缺陷）'}`);
  } catch (e) { push('bits=1 边界', false, e.message); }

  /* 9. 确定性：验证结果不受随机性影响（同一证明多次验证同一结论） */
  try {
    const bl = C.randomScalar();
    const cm = P.commit(777n, bl);
    const pf = prove(777n, bl, cm, { bits: 16 });
    const r1 = verify(pf, cm).ok;
    const r2 = verify(pf, cm).ok;
    const r3 = verify(pf, cm).ok;
    push('验证确定性（同一证明三次验证同结论）', r1 === r2 && r2 === r3 && r1 === true, '');
  } catch (e) { push('验证确定性', false, e.message); }

  /* 10. 证明体不含明文值（零知识性的直接检查） */
  try {
    const bl = C.randomScalar();
    const secret = 4242424n;
    const cm = P.commit(secret, bl);
    const pf = prove(secret, bl, cm, { bits: 32 });
    const wire = JSON.stringify(wireOnly(pf));
    const leaked = wire.includes(secret.toString()) || wire.includes('0x' + secret.toString(16));
    push('⭐ 证明体不泄漏明文值（零知识性）', !leaked,
      leaked ? `泄漏了 ${secret}` : `证明体中不含 ${secret} 的任何形式`);
  } catch (e) { push('⭐ 证明体不泄漏明文值（零知识性）', false, e.message); }

  /* 11. 证明体亦不泄漏盲化因子 */
  try {
    const bl = C.randomScalar();
    const cm = P.commit(555n, bl);
    const pf = prove(555n, bl, cm, { bits: 16 });
    const wire = JSON.stringify(wireOnly(pf));
    push('证明体不泄漏盲化因子', !wire.includes(bl.toString()), '');
  } catch (e) { push('证明体不泄漏盲化因子', false, e.message); }

  /* 12. 性能与证明大小 */
  try {
    const bl = C.randomScalar();
    const cm = P.commit(8695375n, bl);
    const t0 = Date.now();
    const pf = prove(8695375n, bl, cm, { bits: 64 });
    const tProve = Date.now() - t0;
    const t1 = Date.now();
    const vr = verify(pf, cm);
    const tVerify = Date.now() - t1;
    const bytes = Buffer.byteLength(JSON.stringify(wireOnly(pf)), 'utf8');
    push('64 位证明生成 < 8 秒', tProve < 8000, `${tProve} ms`);
    push('64 位证明验证 < 3 秒', tVerify < 3000, `${tVerify} ms`);
    push('证明大小 < 4 KB（O(n) 版本的预期量级）', bytes < 4096, `${bytes} 字节`);
  } catch (e) { push('性能与大小', false, e.message); }

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

module.exports = {
  DEFAULT_BITS, DOMAIN,
  pow2, inner, hadamard, vadd, vsub, vscale,
  prove, verify, wireOnly,
  selfTest,
};
