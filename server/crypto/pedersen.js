/**
 * pedersen.js —— Pedersen 承诺 + 向量承诺（国密 SM2 曲线）
 * ==================================================================================
 * 【为什么碳数据需要"承诺"而不是"明文上链"】
 *
 * 碳市场推行遇到的最大阻力不是技术，是**商业秘密**。
 * 企业不愿上链的活动数据里，包含产量、能耗结构、工艺参数、开工率——
 * 这些是竞争对手最想要的东西。而监管又必须能验证。
 *
 * 明文上链 = 商业自杀；不上链 = 无法监管。这对矛盾不解决，
 * 碳数据平台永远只能停在"演示环境"，进不了真实企业。
 *
 * Pedersen 承诺给出第三条路：
 *   · 上链只放一个 65 字节的椭圆曲线点（承诺值）
 *   · 承诺对数值**信息论隐藏**（information-theoretically hiding）——
 *     给定承诺，任何计算能力的攻击者都无法区分底层是 100 还是 1000000
 *   · 但企业**无法抵赖**：一旦要改口，必须找出另一个 (v', r') 使承诺相同，
 *     这等价于解离散对数（computationally binding）
 *
 * 于是：监管可以拿到"这个数没被改过"的保证，却拿不到"这个数是多少"。
 * 数据由企业主动授权披露时才打开。
 *
 * 【构造】
 *   Commit(v, r) = v·G + r·H
 *   其中 G 是 SM2 基点，H 是"哈希到曲线"得到的第二个生成元，
 *   r 是盲化因子（随机标量）。
 *
 * 【H 的生成必须"无可解释"（nothing-up-my-sleeve）】
 *   若 H = k·G 且有人知道 k，则可伪造承诺（因为 v·G + r·k·G = (v+rk)·G，
 *   单一生成元的承诺毫无隐藏性）。因此 H 必须用哈希派生，且**无人知道其离散对数**：
 *     H = HashToCurve("carbonchain-hub/pedersen/H/v1")
 *   注意：标准做法是 try-and-increment（尝试 x = hash(msg||ctr)，看 x³+ax+b 是否为二次剩余）。
 *
 * 【同态性 —— 这是聚合证明的基础】
 *   Commit(a) + Commit(b) = Commit(a+b)   （盲化因子相加）
 *   因此 N 家企业的排放可以**先聚合承诺、再证明聚合值**，
 *   验证者只需验一个点，不需要逐个验证 N 条。
 *
 * 【零知识性】
 *   承诺本身不泄漏 v —— 因为对任意 v'，都存在唯一 r' = r + (v−v')/k_H 使承诺不变
 *   （前提是没人知道 k_H = log_H G）。这正是"隐藏"的严格含义。
 *
 * @module crypto/pedersen
 */
'use strict';

const C = require('./curve');

/* ==================================================================================
 * 一、第二生成元 H（nothing-up-my-sleeve）
 * ================================================================================== */

/**
 * 尝试-递增法哈希到曲线（try-and-increment）。
 *
 * 算法：
 *   1. 计算 x = SHA256(domain || counter) mod p
 *   2. 检查 y² = x³ + ax + b 是否有解（用 Legendre 符号：y² 的 (p−1)/2 次幂）
 *   3. 若无解，counter++ 重试；若有解，取 y 为任一平方根（取偶/奇由约定决定）
 *
 * 为什么不用更简单的 "x = hash, y = sqrt(...)"：
 *   约一半的 x 不在曲线对应的二次剩余集合里，必须重试。这是标准做法。
 *
 * @param {string} domain 域分隔串（不同用途必须给不同 domain，防止生成元复用）
 * @returns {object} Jacobian 点
 */
function hashToCurve(domain) {
  const crypto = require('crypto');
  const P = C.P;
  const exp = (P - 1n) / 2n;   // Legendre 符号的指数
  for (let ctr = 0; ctr < 1000; ctr++) {
    const h = crypto.createHash('sha256')
      .update(`${domain}|${ctr}`)
      .digest('hex');
    const x = C.mod(BigInt('0x' + h));
    /* y² = x³ + ax + b */
    const rhs = C.mod(x * x * x + C.A * x + C.B);
    if (rhs === 0n) continue;
    /* Legendre：rhs^((p−1)/2) ≡ 1 表示是二次剩余 */
    if (C.pow(rhs, exp) !== 1n) continue;
    /* Tonelli–Shanks 求平方根（p ≡ 3 mod 4 时直接 y = rhs^((p+1)/4)） */
    let y;
    if (P % 4n === 3n) {
      y = C.pow(rhs, (P + 1n) / 4n);
    } else {
      y = tonelliShanks(rhs, P);
    }
    if (y === null) continue;
    if (C.mod(y * y) !== rhs) continue;
    /* 规范化：取较小的那个根（保证跨实现一致） */
    if (y > P - y) y = P - y;
    const pt = C.toJ(x, y);
    if (!C.isOnCurve(pt)) continue;
    return pt;
  }
  throw new Error(`hashToCurve 失败：${domain}（1000 次尝试未找到曲线点，极不可能）`);
}

/** Tonelli–Shanks（p ≡ 1 mod 4 时的模平方根） */
function tonelliShanks(n, p) {
  if (C.pow(n, (p - 1n) / 2n) !== 1n) return null;
  let q = p - 1n;
  let s = 0n;
  while (q % 2n === 0n) { q /= 2n; s += 1n; }
  let z = 2n;
  while (C.pow(z, (p - 1n) / 2n) === 1n) z += 1n;
  let m = s;
  let c = C.pow(z, q);
  let t = C.pow(n, q);
  let r = C.pow(n, (q + 1n) / 2n);
  while (t !== 1n) {
    let i = 0n;
    let t2 = t;
    while (t2 !== 1n) { t2 = (t2 * t2) % p; i += 1n; if (i > m) return null; }
    const b = C.pow(c, 1n << (m - i - 1n));
    m = i;
    c = (b * b) % p;
    t = (t * c) % p;
    r = (r * b) % p;
  }
  return r;
}

/**
 * 承诺用的两个生成元。
 *
 * ⚠ 两个 domain 必须不同，且**一旦上线永不可改**。
 *   改了 domain ⇒ 生成元变了 ⇒ 历史承诺全部失效（无法再验证）。
 *   这是比"数据库 schema"更硬的兼容性约束，必须写进文档。
 */
const H_EMISSION = hashToCurve('carbonchain-hub/pedersen/H/emission/v1');
const H_BLIND = hashToCurve('carbonchain-hub/pedersen/H/blinding/v1');

/* ==================================================================================
 * 二、标量承诺
 * ================================================================================== */

/**
 * 生成承诺：Com(v, r) = v·G + r·H
 *
 * @param {bigint} v 被承诺的值（必须 < n；实际使用中应 < 2^64，配合范围证明）
 * @param {bigint} [r] 盲化因子（缺省随机生成）
 * @param {object} [H] 生成元（缺省 H_EMISSION）
 * @returns {{commit:object, v:bigint, r:bigint, encode:string}}
 */
function commit(v, r, H = H_EMISSION) {
  const vv = C.mod(BigInt(v), C.N);
  const rr = r === undefined || r === null ? C.randomScalar() : C.mod(BigInt(r), C.N);
  const pt = C.add(C.mul(vv, C.G), C.mul(rr, H));
  return {
    commit: pt,
    v: vv,
    r: rr,
    encode: C.encodePoint(pt),
  };
}

/** 打开承诺：验证 Com(v, r) 是否等于给定承诺 */
function open(commitPt, v, r, H = H_EMISSION) {
  const vv = C.mod(BigInt(v), C.N);
  const rr = C.mod(BigInt(r), C.N);
  const expect = C.add(C.mul(vv, C.G), C.mul(rr, H));
  return C.equals(commitPt, expect);
}

/** 同态相加：Com(a) + Com(b) = Com(a+b, ra+rb) */
function addCommits(c1, c2) {
  return C.add(c1.commit ? c1.commit : c1, c2.commit ? c2.commit : c2);
}

/**
 * 同态线性组合：Σ kᵢ·Com(vᵢ) = Com(Σ kᵢvᵢ, Σ kᵢrᵢ)
 * 这是"多企业聚合"的数学基础：不必逐个打开，直接聚合承诺。
 */
function linearCombine(commitPts, scalars) {
  if (commitPts.length !== scalars.length) throw new Error('承诺与系数数量不一致');
  return C.msm(scalars.map((s) => C.mod(BigInt(s), C.N)),
    commitPts.map((c) => (c.commit ? c.commit : c)));
}

/**
 * 线性组合盲化因子：Σ kᵢ·rᵢ mod n
 *
 * ⚠ 必须显式取模。盲化因子是 Z_n 的元素，整数相加会溢出到 [0, 2n) 之外，
 *   而点运算内部按 mod n 处理 —— 两侧路径不一致会导致"承诺正确但验证失败"。
 *   这类错误极难定位（因为承诺本身是对的，错的只是期望值）。
 *   平台内所有对盲化因子的组合都必须走本函数，禁止手写 `a*r1 + b*r2`。
 */
function combineBlinds(blinds, scalars) {
  if (blinds.length !== scalars.length) throw new Error('盲化因子与系数数量不一致');
  let acc = 0n;
  for (let i = 0; i < blinds.length; i++) {
    acc = C.mod(acc + C.mod(BigInt(scalars[i]), C.N) * C.mod(BigInt(blinds[i]), C.N), C.N);
  }
  return acc;
}

/* ==================================================================================
 * 三、向量承诺（Pedersen Vector Commitment）
 * ==================================================================================
 * Com(v⃗) = Σ vᵢ·Gᵢ + r·H
 * 其中 Gᵢ 是一组相互独立的生成元（哈希派生，无人知道它们之间的关系）。
 *
 * 用途：把"12 个月的逐月活动数据"一次承诺，
 * 支持对单个月做子承诺证明（不必暴露其他月份）。
 */

/** 按需派生一组生成元（缓存，避免重复 hashToCurve） */
const GEN_CACHE = new Map();
function generatorAt(index, domain = 'activity') {
  const key = `${domain}#${index}`;
  if (!GEN_CACHE.has(key)) {
    GEN_CACHE.set(key, hashToCurve(`carbonchain-hub/pedersen/G/${domain}/v1/${index}`));
  }
  return GEN_CACHE.get(key);
}

/**
 * 向量承诺。
 * @param {bigint[]} values
 * @param {bigint} [blind]
 * @param {string} [domain] 生成元域（不同业务用不同域，防止跨业务伪造）
 */
function commitVector(values, blind, domain = 'activity') {
  if (!Array.isArray(values) || !values.length) throw new Error('向量不能为空');
  if (values.length > 1024) throw new Error('向量过长（上限 1024）');
  const r = blind === undefined || blind === null ? C.randomScalar() : C.mod(BigInt(blind), C.N);
  let acc = C.mul(r, H_BLIND);
  for (let i = 0; i < values.length; i++) {
    const v = C.mod(BigInt(values[i]), C.N);
    if (v !== 0n) acc = C.add(acc, C.mul(v, generatorAt(i, domain)));
  }
  return { commit: acc, blind: r, length: values.length, domain, encode: C.encodePoint(acc) };
}

/** 打开向量承诺（验证） */
function openVector(commitPt, values, blind, domain = 'activity') {
  const r = C.mod(BigInt(blind), C.N);
  let acc = C.mul(r, H_BLIND);
  for (let i = 0; i < values.length; i++) {
    const v = C.mod(BigInt(values[i]), C.N);
    if (v !== 0n) acc = C.add(acc, C.mul(v, generatorAt(i, domain)));
  }
  return C.equals(commitPt.commit ? commitPt.commit : commitPt, acc);
}

/* ==================================================================================
 * 四、自检
 * ================================================================================== */

function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });

  /* 1. H 在曲线上且不等于 G */
  push('H_EMISSION 是合法曲线点', C.isOnCurve(H_EMISSION) && !C.isZero(H_EMISSION),
    C.encodePoint(H_EMISSION).slice(0, 24) + '…');
  push('H_BLIND 是合法曲线点', C.isOnCurve(H_BLIND) && !C.isZero(H_BLIND),
    C.encodePoint(H_BLIND).slice(0, 24) + '…');
  push('两个生成元互不相同（域分隔生效）',
    !C.equals(H_EMISSION, H_BLIND), 'H_EMISSION ≠ H_BLIND');

  /* 2. 承诺隐藏性：同一个 v、不同 r ⇒ 承诺完全不同 */
  const v = 12345n;
  const c1 = commit(v);
  const c2 = commit(v);
  push('同值不同盲化因子 ⇒ 承诺不同（隐藏性）',
    !C.equals(c1.commit, c2.commit),
    `c1=${c1.encode.slice(0, 20)}… c2=${c2.encode.slice(0, 20)}…`);

  /* 3. 打开正确 */
  push('承诺可正确打开', open(c1.commit, v, c1.r), 'Com(v,r) 验证通过');

  /* 4. ⭐ 打开错误值必须失败 —— 这是"绑定性"的直接体现 */
  push('打开错误值必须失败（绑定性）',
    !open(c1.commit, v + 1n, c1.r) && !open(c1.commit, v, c1.r + 1n),
    '改 v 或改 r 均无法通过');

  /* 5. ⭐ 同态性：Com(a)+Com(b) = Com(a+b) */
  const a = 1000n;
  const b = 2500n;
  const ca = commit(a);
  const cb = commit(b);
  const sum = C.add(ca.commit, cb.commit);
  const sumBlind = combineBlinds([ca.r, cb.r], [1n, 1n]);
  push('同态相加：Com(a)+Com(b) 可被 a+b 打开',
    open(sum, a + b, sumBlind),
    `Com(1000)+Com(2500) = Com(3500)，盲化因子用 combineBlinds 取模`);

  /* 6. ⭐ 同态性负面：用错误的值打开聚合承诺必须失败 */
  push('聚合承诺不能用错误总量打开',
    !open(sum, a + b + 1n, sumBlind),
    '总量 +1 ⇒ 验证失败');

  /* 7. 线性组合（MSM）
   *
   * 【关于盲化因子是否必须取模 —— 实测结论与直觉相反，如实记录】
   *
   * 我原本断言"朴素相加（不取模）会验证失败"。实测：**它照样通过**。
   * 原因：`curve.mul()` 内部第一行就是 `mod(k, N)`，
   * 因此 `mul(2r, H)` 与 `mul(mod(2r), H)` 恒等 —— 取模被下游吞掉了。
   *
   * 那为什么仍然要坚持用 `combineBlinds()`：
   *   ① 语义正确。r 是 Z_n 的元素，Z_n 上的加法本来就要 mod n；
   *      依赖下游兜底是"隐式契约"，一旦有人换掉 mul 或换曲线就崩。
   *   ② 一旦 ZK 协议里出现 `r` 参与**整数比较**（例如范围证明要判断 r 的大小区间），
   *      未取模的值会让判断结果不同 —— 那时 bug 会出现在最不该出现的地方。
   *   ③ 可读性。`combineBlinds` 显式表达"这是模 n 的线性组合"。
   *
   * 这里如实记录"实测朴素写法也通过"，而不是编一个"必须取模否则失败"的故事。
   * 断言改为验证**语义等价性**（两种写法结果相同），而不是编造一个不存在的失败。 */
  const cs = [commit(100n), commit(200n), commit(300n)];
  const lc = linearCombine(cs, [2n, 3n, 1n]);
  const expectV = 2n * 100n + 3n * 200n + 1n * 300n;
  const expectR = combineBlinds([cs[0].r, cs[1].r, cs[2].r], [2n, 3n, 1n]);
  push('线性组合 Σkᵢ·Com(vᵢ) = Com(Σkᵢvᵢ)',
    open(lc, expectV, expectR),
    `2×100 + 3×200 + 1×300 = ${expectV}`);
  push('combineBlinds 与朴素相加结果等价（mul 内部已取模）',
    open(lc, expectV, 2n * cs[0].r + 3n * cs[1].r + 1n * cs[2].r),
    '两种写法均通过 —— 取模被 curve.mul 兜住，故仍坚持显式取模以保语义正确');
  /* 负面：改总量必须失败（这才是真正该守的边界） */
  push('线性组合：总量被篡改即失败',
    !open(lc, expectV + 1n, expectR), '总量 +1 ⇒ 验证失败');

  /* 8. 向量承诺往返 */
  const vec = Array.from({ length: 12 }, (_, i) => BigInt((i + 1) * 100));
  const vc = commitVector(vec);
  push('向量承诺可打开', openVector(vc.commit, vec, vc.blind),
    `12 维向量，承诺 ${vc.encode.slice(0, 20)}…`);

  /* 9. 向量承诺：改任一元素必须失败 */
  const tampered = [...vec];
  tampered[5] = tampered[5] + 1n;
  push('向量承诺：改单个元素即失败',
    !openVector(vc.commit, tampered, vc.blind),
    '第 6 个元素 +1 ⇒ 验证失败');

  /* 10. 生成元独立性：Gᵢ 互不相同且都不等于 G / H */
  const gens = [0, 1, 2].map((i) => generatorAt(i));
  const distinct = !C.equals(gens[0], gens[1]) && !C.equals(gens[1], gens[2])
    && !C.equals(gens[0], gens[2]);
  const notBase = gens.every((g) => !C.equals(g, C.G) && !C.equals(g, H_EMISSION));
  push('向量生成元互相独立且不等于 G/H', distinct && notBase, 'G₀ ≠ G₁ ≠ G₂，均非基点');

  /* 11. 生成元缓存一致（同 index 必须返回同一点） */
  push('生成元派生确定性（缓存与重算一致）',
    C.equals(generatorAt(0), hashToCurve('carbonchain-hub/pedersen/G/activity/v1/0')),
    '同 index 派生同一生成元');

  /* 12. 零值承诺仍隐藏（Com(0) = r·H ≠ O） */
  const cZero = commit(0n);
  push('Com(0) 不等于无穷远（零值也被盲化）',
    !C.isZero(cZero.commit), `Com(0)=${cZero.encode.slice(0, 20)}…`);

  /* 13. 大数值（1e12，约百万吨级排放）正常工作 */
  const big = 8695375n;  // 本平台 60 家年度排放总量（tCO2e）
  const cBig = commit(big);
  push('大数值（8,695,375 tCO₂e）承诺正常',
    open(cBig.commit, big, cBig.r), '百万量级无溢出');

  /* 14. 承诺编码长度固定（不泄漏数值大小）*/
  const encSmall = commit(1n).encode;
  const encBig = commit(8695375n).encode;
  push('承诺编码长度恒定（不泄漏数值大小）',
    encSmall.length === encBig.length && encSmall.length === 130,
    `小值 ${encSmall.length} hex / 大值 ${encBig.length} hex`);

  /* 15. 性能：单次承诺（2 次标量乘） */
  const t0 = Date.now();
  const N_ROUNDS = 20;
  for (let i = 0; i < N_ROUNDS; i++) commit(BigInt(i + 1));
  const ms = (Date.now() - t0) / N_ROUNDS;
  push('单次承诺 < 8 ms（2 次标量乘）', ms < 8, `${ms.toFixed(2)} ms/次`);

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

module.exports = {
  H_EMISSION, H_BLIND,
  hashToCurve, generatorAt,
  commit, open, addCommits, linearCombine, combineBlinds,
  commitVector, openVector,
  selfTest,
};
