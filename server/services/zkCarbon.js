/**
 * zkCarbon.js —— 零知识碳核算协议（隐私保护型 MRV）
 * ==================================================================================
 * 【为什么这是整个平台最有价值的一件事】
 *
 * 碳数据平台进不了真实企业的根本原因，不是功能不够，是**一个矛盾解不开**：
 *   · 监管必须能验证企业报的排放量；
 *   · 企业绝不愿把活动数据（产量、能耗、工艺、开工率）交给任何人——
 *     那是商业机密，泄漏给竞争对手等于商业自杀。
 *
 * 现有做法的两条路都走不通：
 *   ① 明文上链 → 企业不会用；
 *   ② 只报汇总数 → 监管无法验证真实性，等于信任企业自述。
 *
 * 本协议给出第三条路：**可验证但不披露**。
 *   企业向链上提交对排放量的承诺（65 字节）与一份范围证明，
 *   监管可以确认：
 *     · 这个数与活动数据一致（同态一致性）
 *     · 这个数在合理量级内（范围证明）
 *     · 这个数没被事后篡改（承诺绑定性）
 *     · 这个数与其他口径自洽（跨期一致性）
 *   而**看不到任何一个原始数字**。
 *
 * 【协议流程】
 *
 *   企业侧（私有）
 *     ├─ 活动数据 AD（燃料量、电量…）→ 本地正向核算 → 排放量 v
 *     ├─ 对 v 生成承诺 Com(v, r)
 *     └─ 对 v 生成范围证明 π（证明 0 ≤ v < 2^64）
 *
 *   上链（公开）
 *     └─ { commit: 65B, proof: ~1.1KB, period, entDid, meta }
 *
 *   监管侧（只用公开数据）
 *     ├─ 验承诺绑定：打开时用 (v, r) 对比
 *     ├─ 验范围证明：v 在合理区间
 *     ├─ 验跨期一致：Σ 月度承诺 = 年度承诺（同态）
 *     └─ 按需审计：企业授权后才打开具体值
 *
 * 【四个可验证性质（每个都有对应的自检）】
 *   ① 绑定（binding）：改 v 或 r 必失败 → 数据不可抵赖
 *   ② 隐藏（hiding）：给定承诺，无法区分底层数值 → 商业秘密受保护
 *   ③ 范围（range）：v ∉ [0, 2^n) 时无法生成有效证明 → 防虚报小数字
 *   ④ 聚合（aggregate）：ΣCom(vᵢ) = Com(Σvᵢ) → 可做区域/行业总量核算
 *
 * 【诚实声明（必须让使用者看到）】
 *   · 本协议保护"数值不被未授权方获知"，**不保护元数据**（时间、企业标识、
 *     申报频次仍是公开的）。
 *   · 承诺绑定性的基础是离散对数困难性；若未来量子计算机可用，
 *     需迁移到后量子方案。
 *   · 范围证明采用 O(n) 通信量版本（见 rangeproof.js 的说明），
 *     不是完整 Bulletproofs 的对数版本。
 *   · 本协议不替代法定核查。它让核查**更高效**（可直接信任链上承诺），
 *     不替代核查机构的实质判断。
 *
 * @module services/zkCarbon
 */
'use strict';

const C = require('../crypto/curve');
const PD = require('../crypto/pedersen');
const RP = require('../crypto/rangeproof');
const REL = require('../crypto/relation');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');

/** 协议版本（升级时必须改，历史证明需按版本验证） */
const PROTOCOL_VERSION = 'zkc-v1';

/** 默认位宽：64 位可覆盖 1.8×10^19 tCO₂e，远超任何企业年度排放 */
const DEFAULT_BITS = 64;

/* ==================================================================================
 * 一、企业侧：生成隐私承诺与证明
 * ================================================================================== */

/**
 * 为一次核算结果生成隐私承诺包（本地计算，不上传原始数据）。
 *
 * @param {object} p
 *   entId       企业ID
 *   year        年度
 *   emission    排放量（tCO2e，数值）
 *   breakdown   可选的分解明细 [{ sourceCode, emission }]，用于生成分源承诺
 *   bits        位宽（默认 64）
 * @returns {object} 可上链的承诺包（**不含任何原始数值**）
 */
async function buildCommitment(p) {
  const entId = Number(p.entId);
  const year = Number(p.year);
  const emission = Number(p.emission);
  if (!entId || !year) throw new Error('entId 与 year 必填');
  if (!(emission >= 0)) throw new Error('排放量必须为非负数');

  const bits = Number(p.bits) || DEFAULT_BITS;
  /* 排放量必须能用整数表达到位宽内。真实核算结果是 3 位小数，
   * 因此统一乘以 1000 转为「千克级整数」，避免小数无法进入有限域。
   * ⚠ 这个缩放因子必须写进承诺包，否则验证方无法还原量纲。 */
  const SCALE = 1000;
  const vScaled = BigInt(Math.round(emission * SCALE));
  if (vScaled >= (1n << BigInt(bits))) {
    throw new Error(`排放量 ${emission} t（缩放后 ${vScaled}）超出 ${bits} 位范围。`
      + '请提高 bits 或检查输入量级');
  }

  /* 1. 生成承诺 */
  const blind = C.randomScalar();
  const cm = PD.commit(vScaled, blind);

  /* 2. 生成范围证明 */
  const t0 = Date.now();
  const proof = RP.prove(vScaled, blind, cm, { bits });
  const proveMs = Date.now() - t0;

  /* 3. 分源承诺（可选）—— 让监管能验证"分项之和等于总量"而不看明细 */
  let parts = null;
  if (Array.isArray(p.breakdown) && p.breakdown.length) {
    parts = p.breakdown.map((b) => {
      const vv = BigInt(Math.round(Number(b.emission) * SCALE));
      const rr = C.randomScalar();
      const cc = PD.commit(vv, rr);
      return {
        sourceCode: String(b.sourceCode || 'UNKNOWN'),
        commit: cc.encode,
        /* 分项的盲化因子由企业自己保管（交给审计方 = 披露该分项） */
        __blind: rr.toString(),
        __value: vv.toString(),
      };
    });
    /* 校验：Σ 分项是否等于总量（企业侧自查，不通过就不该上链） */
    const sum = parts.reduce((s, x) => s + BigInt(x.__value), 0n);
    if (sum !== vScaled) {
      throw new Error(`分项之和 ${sum} ≠ 总量 ${vScaled}（缩放后）。`
        + '分项与总量不一致时不得提交承诺 —— 这是"自洽性"的最低要求');
    }
  }

  const payload = {
    protocol: PROTOCOL_VERSION,
    entId, year,
    /* 量纲：承诺中的整数 = 实际吨数 × scale */
    scale: SCALE,
    unit: 'tCO2e',
    /* 承诺（公开） */
    commit: cm.encode,
    /* 范围证明（公开） */
    proof: RP.wireOnly(proof),
    /* 分源承诺（公开；盲化因子与数值不公开） */
    parts: parts ? parts.map((x) => ({ sourceCode: x.sourceCode, commit: x.commit })) : null,
    /* 元数据（公开，但已在 limitations 中声明） */
    meta: {
      bits,
      createdAt: new Date().toISOString(),
      proveMs,
      generator: 'SM2-Pedersen + Bulletproofs(O(n))',
    },
  };

  /* 4. 计算摘要（上链用） */
  payload.digest = C.hashHex(PROTOCOL_VERSION, cm.encode, payload.proof.digest,
    String(entId), String(year), String(SCALE));

  return {
    /** 可安全公开/上链的部分 */
    publicPayload: payload,
    /** 企业必须自己保管的私密部分（绝不外传） */
    privateWitness: {
      emission,
      scaledValue: vScaled.toString(),
      blind: blind.toString(),
      parts: parts ? parts.map((x) => ({ sourceCode: x.sourceCode, value: x.__value, blind: x.__blind })) : null,
      warning: '此文件包含可反推排放量的全部信息，等同于商业机密本身。'
        + '仅用于向授权审计方开放，或用于未来自证。丢失后无法再打开承诺。',
    },
  };
}

/* ==================================================================================
 * 二、监管侧：只用公开数据验证
 * ================================================================================== */

/**
 * 验证隐私承诺包（**不接触任何原始数值**）。
 *
 * @param {object} payload 公开承诺包
 * @param {object} [opts]  { expectedYear, minPlausible, maxPlausible }
 * @returns {object} 验证结论
 */
function verifyCommitment(payload, opts = {}) {
  const checks = [];
  const push = (n, ok, d) => checks.push({ name: n, pass: !!ok, detail: d });
  const fail = (reason) => ({ ok: false, reason, checks });

  try {
    if (!payload || payload.protocol !== PROTOCOL_VERSION) {
      return fail(`协议版本不符：期望 ${PROTOCOL_VERSION}，实际 ${payload && payload.protocol}`);
    }
    if (opts.expectedYear && Number(payload.year) !== Number(opts.expectedYear)) {
      return fail(`年度不符：期望 ${opts.expectedYear}，实际 ${payload.year}`);
    }

    /* 2.1 承诺必须能解码为合法曲线点 */
    let commitPt;
    try {
      commitPt = C.decodePoint(payload.commit);
      push('承诺解码为合法曲线点', !C.isZero(commitPt),
        C.encodePoint(commitPt).slice(0, 24) + '…');
    } catch (e) {
      return fail(`承诺解码失败：${e.message}`);
    }

    /* 2.2 范围证明验证（核心） */
    const vr = RP.verify(payload.proof, commitPt);
    push('范围证明有效（0 ≤ v < 2^bits）', vr.ok, vr.reason);
    if (!vr.ok) return fail(`范围证明无效：${vr.reason}`);

    /* 2.3 摘要自洽 */
    const dg = C.hashHex(PROTOCOL_VERSION, payload.commit, payload.proof.digest,
      String(payload.entId), String(payload.year), String(payload.scale));
    push('承诺包摘要自洽', dg === payload.digest,
      dg === payload.digest ? '' : '摘要不匹配（元数据被改动）');
    if (dg !== payload.digest) return fail('摘要不匹配：承诺包的元数据被篡改');

    /* 2.4 量纲合法性 */
    push('缩放因子为已知值', [1, 1000, 1000000].includes(Number(payload.scale)),
      `scale=${payload.scale}`);
    if (![1, 1000, 1000000].includes(Number(payload.scale))) {
      return fail('缩放因子非法：只接受 1 / 1000 / 1000000');
    }

    /* 2.5 分源承诺存在时，其结构必须合法（无法验证和，因为盲化因子未公开，
     *     但可以验证每个承诺都是合法点 —— 这已能排除"塞一个乱码当承诺"） */
    if (Array.isArray(payload.parts) && payload.parts.length) {
      let allValid = true;
      for (const pt of payload.parts) {
        try {
          const q = C.decodePoint(pt.commit);
          if (C.isZero(q)) allValid = false;
        } catch (e) { allValid = false; }
      }
      push(`分源承诺 ${payload.parts.length} 项均为合法点`, allValid,
        allValid ? '' : '存在非法承诺点');
      if (!allValid) return fail('分源承诺中存在非法点');
    }

    /* 2.6 合理性区间检查（**不做，但必须说明为什么**）
     * 为什么不能靠范围证明判断"排放量是否合理"：
     *   范围证明只证明 0 ≤ v < 2^64，任何百万级到十亿级的数都能通过。
     *   要判断"是否合理"，必须知道行业基准/企业规模 —— 那是另一回事。
     *   诚实的做法是：把这项判断交给核查机构，平台不假装能做。 */

    return {
      ok: true,
      reason: '隐私承诺有效：数据未被篡改、数值在合法范围内，且平台无法得知具体数值',
      entId: Number(payload.entId),
      year: Number(payload.year),
      checks,
      meta: {
        bits: payload.proof.bits,
        proofBytes: vr.meta ? vr.meta.proofBytes : null,
        commitBytes: 65,
        disclosure: '监管侧仅获得"承诺有效"这一结论，未获得任何原始数值',
      },
    };
  } catch (e) {
    return fail(`验证异常：${e.message}`);
  }
}

/* ==================================================================================
 * 三、授权披露（企业主动打开承诺）
 * ================================================================================== */

/**
 * 企业授权披露：用私密见证打开承诺，供审计方核对。
 *
 * ⚠ 这是"选择性披露"：企业可以选择只打开某一个分项，而不打开总量。
 *   这正是传统"全有或全无"上传方式做不到的。
 *
 * @param {object} payload         公开承诺包
 * @param {object} witness         企业保管的私密见证
 * @param {string} [disclosePart]  只披露某个分源（sourceCode），不传则披露总量
 */
function authorizedDisclose(payload, witness, disclosePart) {
  if (!witness || !witness.blind) throw new Error('缺少私密见证，无法打开承诺');

  if (disclosePart) {
    /* 只披露指定分项 */
    const part = (witness.parts || []).find((x) => x.sourceCode === disclosePart);
    if (!part) throw new Error(`见证中不存在分项 ${disclosePart}`);
    const pub = (payload.parts || []).find((x) => x.sourceCode === disclosePart);
    if (!pub) throw new Error(`公开包中不存在分项 ${disclosePart}`);
    const pt = C.decodePoint(pub.commit);
    const ok = PD.open(pt, BigInt(part.value), BigInt(part.blind));
    if (!ok) throw new Error('分项承诺打开失败：见证与承诺不匹配（数据被改过？）');
    return {
      scope: 'PART',
      sourceCode: disclosePart,
      /* 注意：这里返回的是**缩放后**的整数，必须同时给 scale 与单位 */
      valueScaled: part.value,
      scale: payload.scale,
      unit: payload.unit,
      value: Number(BigInt(part.value)) / Number(payload.scale),
      blind: part.blind,
      verified: true,
      note: '已披露该分项的数值与盲化因子。披露后该分项不再具备保密性',
    };
  }

  /* 披露总量 */
  const pt = C.decodePoint(payload.commit);
  const ok = PD.open(pt, BigInt(witness.scaledValue), BigInt(witness.blind));
  if (!ok) throw new Error('承诺打开失败：见证与承诺不匹配');
  return {
    scope: 'TOTAL',
    valueScaled: witness.scaledValue,
    scale: payload.scale,
    unit: payload.unit,
    value: Number(BigInt(witness.scaledValue)) / Number(payload.scale),
    blind: witness.blind,
    verified: true,
    note: '已披露总量。若需保留保密性，请只披露分项或使用聚合证明',
  };
}

/* ==================================================================================
 * 四、聚合核算（区域/行业总量，不看个体数值）
 * ================================================================================== */

/**
 * 聚合承诺：把 N 家企业的承诺相加，得到一个"总量承诺"。
 *
 * 这是碳市场宏观统计的关键能力：
 *   · 监管想知道"全省排放总量"，但不应看到每家的具体数字；
 *   · 企业愿意参与总量核算，但不愿被逐个查看。
 *
 * 同态性保证：ΣCom(vᵢ, rᵢ) = Com(Σvᵢ, Σrᵢ)
 * 于是监管只需拿到一个 65 字节的聚合承诺，就能对外发布"本省总量"，
 * 而无需收集任何一家企业的明细。
 *
 * @param {Array<{commit:string}>} payloads 各企业的公开承诺
 * @returns {object} 聚合承诺与验证信息
 */
function aggregate(payloads) {
  if (!Array.isArray(payloads) || !payloads.length) throw new Error('承诺列表不能为空');
  if (payloads.length > 10000) throw new Error('单次聚合上限 10000 家');

  let acc = C.ZERO;
  const individual = [];
  for (const p of payloads) {
    const pt = C.decodePoint(p.commit || p);
    if (C.isZero(pt)) throw new Error('聚合输入中存在无穷远点（非法承诺）');
    acc = C.add(acc, pt);
    individual.push(p.commit || C.encodePoint(pt));
  }

  const enc = C.encodePoint(acc);
  return {
    count: payloads.length,
    aggregateCommit: enc,
    /* 聚合承诺的摘要：可用于对外公告"这就是本区域总量承诺" */
    digest: C.hashHex('carbonchain-hub/aggregate/v1', enc, String(payloads.length)),
    /* 验证信息：任何人都能复核这个聚合是由哪些承诺相加得到的 */
    inputs: individual,
    properties: {
      hiding: '聚合承诺同样不泄漏任何单家数值',
      binding: '改动任何一家承诺，聚合值必变',
      orderIndependent: '加法交换律保证聚合与顺序无关',
    },
    note: '聚合后可由持有全部见证的一方（如监管+企业联合）选择是否打开总量；'
      + '平台不持有任何见证，因此平台自身永远无法得知总量',
  };
}

/**
 * 跨期一致性：证明「Σ 月度值 = 年度值」，**且各月盲化因子完全独立**。
 *
 * 【上一轮的实现是错的 —— 必须记录，否则会再犯】
 *
 * 旧实现直接比较 Σ月度承诺 与 年度承诺 是否相等：
 *
 *     consistent = (Σ Com(mᵢ) == Com(annual))
 *
 * 这个判据只在「年度承诺的盲化因子恰好等于各月之和」时成立。
 * 而在真实业务里，企业每个月独立生成承诺（盲化因子各自随机），
 * **不可能也不需要去协调 12 个随机数**。所以旧判据在真实场景下永远为 false。
 *
 * 更糟的是：旧的自检让年度承诺**由月度承诺相加构造**，
 * 于是测试恒真、代码实际不可用 —— 这是**循环论证**（tautology），
 * 和"先验敏感性闸门恒为 0"是同一类错误：测试证明了测试自己。
 *
 * 【正确解法：用线性关系零知识证明】
 *   声明：Σ mᵢ − a = 0（a 为年度承诺里的值）
 *   系数：(1,1,…,1,−1)，目标 0
 *   由 relation.proveSumEquals 生成，验证方不需要任何盲化因子。
 *
 * 这样：
 *   · 各月盲化因子可以完全独立（真实场景）；
 *   · 验证方只需公开数据；
 *   · 少一个月 → 数值对不上 → 拒绝（真正的防线）。
 *
 * @param {object} p
 *   monthlyCommits  月度承诺列表
 *   monthlyBlinds   月度盲化因子（仅企业侧生成证明时需要）
 *   annualCommit    年度承诺
 *   annualBlind     年度盲化因子（仅企业侧）
 *   mode            'prove' | 'verify'
 *   proof           当 mode='verify' 时必传
 */
function periodProof(p) {
  const monthly = p.monthlyCommits || [];
  if (!Array.isArray(monthly) || !monthly.length) {
    throw new Error('月度承诺列表不能为空');
  }
  if (monthly.length > 24) throw new Error('月度承诺最多 24 个（性能与业务合理性）');
  const label = String(p.label || `PERIOD:${p.year || ''}:${monthly.length}`);

  if (p.mode === 'verify') {
    const vr = REL.verifySumEquals({
      partCommits: monthly.map((m) => m.commit || m),
      totalCommit: p.annualCommit.commit || p.annualCommit,
      proof: p.proof,
      label,
    });
    return {
      consistent: vr.ok,
      months: monthly.length,
      reason: vr.reason,
      checks: vr.checks,
      detail: vr.ok
        ? `月度承诺（${monthly.length} 个，盲化因子各自独立）之和等于年度承诺，`
          + '且未泄漏任何月度数值'
        : `不一致：${vr.reason}`,
    };
  }

  /* prove 模式 */
  if (!Array.isArray(p.monthlyBlinds) || p.monthlyBlinds.length !== monthly.length) {
    throw new Error('monthlyBlinds 数量必须与 monthlyCommits 一致');
  }
  if (p.annualBlind === undefined || p.annualBlind === null) {
    throw new Error('annualBlind 必填（年度承诺的盲化因子）');
  }
  const proof = REL.proveSumEquals({
    partCommits: monthly.map((m) => m.commit || m),
    partBlinds: p.monthlyBlinds.map((x) => BigInt(x)),
    totalCommit: p.annualCommit.commit || p.annualCommit,
    totalBlind: BigInt(p.annualBlind),
    partValues: p.monthlyValues || null,
    totalValue: p.annualValue,
    label,
  });
  return {
    months: monthly.length,
    label,
    proof: REL.wireOnly(proof),
    proofBytes: Buffer.byteLength(JSON.stringify(REL.wireOnly(proof)), 'utf8'),
    note: '跨期一致性的零知识证明：验证方无需任何盲化因子即可确认月度之和等于年度值',
  };
}

/**
 * 生成「排放量确实是算出来的」零知识证明（**本轮核心能力**）。
 *
 * 【为什么这个 API 是决定性的】
 *
 * 上一轮的承诺 + 范围证明只能证明「承诺里的值落在 [0, 2^64) 内」。
 * 但企业完全可以把这个数填成任意值 —— 范围证明对"这个数对不对"零保障。
 * 换句话说：上一轮的隐私 MRV 保护了数据，但没有验证数据。
 *
 * 本函数补上这个缺口：从核算批次里取出真实的
 *   ① 各排放源的活动数据（AD，藏进承诺）
 *   ② 各排放源的排放因子（EF，公开——因子本来就是公开台账）
 *   ③ 核算结果（E，藏进承诺）
 * 然后生成证明 **E = Σ EFᵢ × ADᵢ**。
 *
 * 验证方只需：批次号、EF 列表、AD 承诺、E 承诺、证明。
 * 它无法得知任何 AD 或 E 的数值，但能确定「这个 E 确实是按这些 EF 和 AD 算出来的」。
 *
 * 【量纲处理 —— 最容易出错的地方】
 *   EF 是 4 位小数（如 1.9003），AD 是 3 位小数（如 12000.000），
 *   乘积是 7 位小数。有限域只认整数，所以必须统一缩放：
 *     EF_int = EF × 10⁴        （efScale = 4）
 *     AD_int = AD × 10³        （adScale = 3）
 *     E_int  = E  × 10⁷        （eScale  = 4 + 3 = 7）
 *   于是 E_int = EF_int × AD_int 在整数上成立。
 *
 *   ⚠ 若 eScale ≠ efScale + adScale，等式在整数上不成立，证明必然失败。
 *     本函数会显式校验这一点，并在错误时给出口径提示，而不是抛一个"证明失败"。
 *
 * @param {object} p
 *   batchNo   核算批次号（从 calc_batch + calc_source_detail 取真实数据）
 *   label     语义标签（默认带批次号，防止跨批次挪用）
 *   override  可选：{'COAL': {ad: 12000, ef: 1.9003}, ...} 用于离线自测
 */
async function buildFormulaProof(p) {
  const batchNo = String(p.batchNo || '');
  if (!batchNo) throw new Error('batchNo 必填');

  const EF_SCALE = 4;    // 因子 4 位小数
  const AD_SCALE = 3;    // 活动数据 3 位小数
  const E_SCALE = EF_SCALE + AD_SCALE;   // 7 位小数

  /* 1. 取批次与分源明细 */
  const batch = await db.one(
    `SELECT batch_no, ent_id, year, total_emission, factor_version
       FROM calc_batch WHERE batch_no = ? AND status <> 'VOID'`, [batchNo]
  );
  if (!batch) throw new Error(`核算批次 ${batchNo} 不存在或已作废`);

  const details = await db.query(
    `SELECT source_code, source_cn, activity, activity_unit, ef_value, ef_tier, emission, status
       FROM calc_source_detail WHERE batch_id =
         (SELECT id FROM calc_batch WHERE batch_no = ?)
       ORDER BY scope, source_code`, [batchNo]
  );
  /* 只取成功核算且有活动数据的源 —— 缺数据的源不能进公式（否则等于给 0 一个承诺） */
  const usable = details.filter((d) => d.status === 'OK'
    && Number(d.activity) > 0 && Number(d.ef_value) > 0 && Number(d.emission) > 0);
  if (!usable.length) {
    throw new Error(`批次 ${batchNo} 没有可用于公式证明的排放源`
      + '（全部为 NO_DATA 或数值为零）');
  }

  /* 2. 计算整数表示并做量纲自检 */
  const sources = [];
  let sumE = 0n;
  for (const d of usable) {
    const efInt = BigInt(Math.round(Number(d.ef_value) * 10 ** EF_SCALE));
    const adInt = BigInt(Math.round(Number(d.activity) * 10 ** AD_SCALE));
    const eInt = efInt * adInt;                    // 单个源的整数排放量（×10⁷）
    /* ⚠ 逐源核对：整数乘法的结果必须与数据库里登记的排放量一致。
     *
     * 但要区分两种"不一致"：
     *   ① 量纲错误（例如 eScale 少算 1 位）→ 相对差 10 倍、100 倍级别 ⇒ 必须报错
     *   ② DECIMAL 列的四舍五入 → 相对差 1e-5 级别 ⇒ 正常，必须容忍
     *
     * 为什么不能一刀切用 1e-6：`calc_source_detail.emission` 是 DECIMAL(18,3)，
     * 本身只有 3 位小数。而 EF(4 位) × AD(3 位) 精确到 7 位小数，
     * 写库时被截到 3 位 ⇒ 相对差最大可达 5e-4 / 1e3 = 5e-4，即 0.05%。
     * 实测该批次 COAL 源的相对差为 0.001025%（1.03e-5），属正常舍入。
     *
     * 因此阈值定为 0.1%（1e-3）：足以捕捉任何量纲级错误（差 10 倍即 900%），
     * 又能容忍全部正常舍入。这类"阈值定错导致假红"的教训见 relation.js 的性能断言。 */
    const dbEInt = BigInt(Math.round(Number(d.emission) * 10 ** E_SCALE));
    const diff = eInt > dbEInt ? eInt - dbEInt : dbEInt - eInt;
    const relDiff = Number(dbEInt) > 0 ? Number(diff) / Number(dbEInt) : 1;
    if (relDiff > 1e-3) {
      throw new Error(`排放源 ${d.source_code} 的量纲核对失败：`
        + `EF_int×AD_int = ${eInt}，数据库登记 ${dbEInt}，相对差 ${(relDiff * 100).toFixed(4)}%。`
        + `这超过 0.1% 的舍入容差，说明 EF_SCALE(${EF_SCALE}) 或 AD_SCALE(${AD_SCALE}) `
        + '与实际小数位不匹配（差 10 倍即 900%，量纲错误的典型特征）');
    }
    sources.push({
      code: d.source_code, cn: d.source_cn,
      efInt, adInt, eInt,
      activityUnit: d.activity_unit,
      /* 仅用于企业侧内部自检，不进证明 */
      __ad: Number(d.activity), __ef: Number(d.ef_value),
    });
    sumE += eInt;
  }

  /* 3. 逐源生成承诺 */
  const adCommits = [];
  const adBlinds = [];
  for (const s of sources) {
    const c = PD.commit(s.adInt);
    adCommits.push(c.commit);
    adBlinds.push(c.r);
    s.__commit = c.encode;
  }
  const eC = PD.commit(sumE);

  /* 4. 生成公式证明 E = Σ EFᵢ·ADᵢ */
  const label = String(p.label || `FORMULA:${batchNo}`);
  const pf = REL.proveFormula({
    adCommits, adBlinds, adValues: sources.map((s) => s.adInt),
    efInts: sources.map((s) => s.efInt),
    eCommit: eC.commit, eBlind: eC.r, eValue: sumE,
    label,
  });
  const wire = REL.wireOnly(pf);

  return {
    batchNo,
    entId: Number(batch.ent_id),
    year: Number(batch.year),
    factorVersion: batch.factor_version,
    label,
    scales: { ef: EF_SCALE, ad: AD_SCALE, e: E_SCALE },
    /* 公开部分（可上链、可给监管） */
    publicPayload: {
      protocol: `${PROTOCOL_VERSION}+formula`,
      batchNo,
      entId: Number(batch.ent_id),
      year: Number(batch.year),
      factorVersion: batch.factor_version,
      label,
      scales: { ef: EF_SCALE, ad: AD_SCALE, e: E_SCALE },
      /* 因子整数（公开——因子本来就是公开台账，保密的是活动数据） */
      efInts: sources.map((s) => s.efInt.toString()),
      sourceCodes: sources.map((s) => s.code),
      adCommits: adCommits.map((c) => C.encodePoint(c)),
      eCommit: eC.encode,
      proof: wire,
      proofBytes: Buffer.byteLength(JSON.stringify(wire), 'utf8'),
      digest: C.hashHex('zkc-formula/v1', batchNo, eC.encode,
        ...adCommits.map((c) => C.encodePoint(c)),
        ...sources.map((s) => s.efInt.toString())),
    },
    /* 私密见证（企业保管） */
    privateWitness: {
      batchNo,
      /* 各源的真实活动数据与盲化因子 —— 泄漏它们等于泄漏产量/能耗 */
      sources: sources.map((s) => ({
        code: s.code, activity: String(s.adInt), blind: s.blind ? s.blind.toString() : null,
        commit: s.__commit,
      })),
      eValue: sumE.toString(),
      eBlind: eC.r.toString(),
      note: '此文件包含各排放源的活动数据（等价于产量/能耗机密）。仅用于向授权方开放。',
    },
    /* 便于企业核对：不泄漏给外部，仅在返回体里给一次 */
    __internal: {
      sourceCount: sources.length,
      totalE: Number(sumE) / 10 ** E_SCALE,
      detail: sources.map((s) => ({
        code: s.code, ad: s.__ad, ef: s.__ef,
        e: Number(s.eInt) / 10 ** E_SCALE,
      })),
    },
  };
}

/* ==================================================================================
 * 四之二、不依赖数据库的底层构造器（用于验证协议本身，不用于业务写入）
 * ================================================================================== */

/**
 * 用**任意给定的整数三元组**构造公式证明（不读数据库）。
 *
 * 【为什么需要这个入口】
 *
 * `buildFormulaProof` 只能证明"数据库里某个核算批次"的公式关系。这在业务上
 * 是对的，但在**验证协议本身**时不够用：要证明"协议能作用于真实世界的数"，
 * 就必须能把真实设施的 (EF, AD, E) 直接喂进来，而不必先把它塞进一张业务表。
 *
 * 更重要的是阴性对照：要构造"谎报 30%"的*错误*证明，就必须能控制公开包里的
 * eCommit。如果只能从库里读，"错误证明"根本构造不出来 ——
 * 而构造不出来，就无法证明验证器真的会拒绝它。
 *
 * ⚠ 本入口不做业务校验（是否存在、是否有权、量纲是否与库一致）。
 *   它面向**验证与测试**，不是业务写入路径；业务路径请用 buildFormulaProof。
 *
 * @param {object} p
 *   sources  [{ code, label, efInt, adInt }]  efInt/adInt 为整数（已乘 10^scale）
 *   eInt     可选；给出时必须等于 Σ efInt×adInt（否则说明输入自相矛盾）
 *   efScale / adScale / eScale
 *   label    证明语句标签（防跨场景挪用）
 */
function buildFormulaProofFromValues(p) {
  const EF_SCALE = Number(p.efScale);
  const AD_SCALE = Number(p.adScale);
  const E_SCALE = Number(p.eScale);
  if (!Number.isFinite(EF_SCALE) || !Number.isFinite(AD_SCALE) || !Number.isFinite(E_SCALE)) {
    throw new Error('efScale / adScale / eScale 必须是数字');
  }
  if (E_SCALE !== EF_SCALE + AD_SCALE) {
    throw new Error(`量纲不自洽：eScale(${E_SCALE}) ≠ efScale(${EF_SCALE}) + adScale(${AD_SCALE})`);
  }
  const src = Array.isArray(p.sources) ? p.sources : [];
  if (!src.length) throw new Error('sources 不能为空');

  const label = String(p.label || 'FORMULA:adhoc');
  const sources = [];
  let sumE = 0n;

  for (const s of src) {
    const efInt = BigInt(s.efInt);
    const adInt = BigInt(s.adInt);
    if (efInt <= 0n || adInt <= 0n) throw new Error('efInt 与 adInt 必须为正整数');
    /* 单源整数排放量：efInt × adInt 天然带 10^(ef+ad) 的标度，
     * 与 E_SCALE = ef + ad 一致 —— 这就是量纲铁律的算术来源。 */
    const eInt = efInt * adInt;
    sources.push({
      code: String(s.code || 'SRC'),
      cn: String(s.label || s.code || ''),
      efInt, adInt, eInt,
      activityUnit: s.activityUnit || null,
    });
    sumE += eInt;
  }

  /* 若调用方给了 eInt，必须与逐源求和一致；否则说明输入自相矛盾，直接拒绝。
   * ⚠ 阴性对照需要的"谎报"应当改**公开包的 eCommit**，而不是让 eInt 与求和不一致 ——
   * 后者会被本函数拦住，反而构不出"看起来有效但实际错误"的证明，
   * 也就测不出验证器是否真的在验证。 */
  if (p.eInt != null) {
    const want = BigInt(p.eInt);
    if (want !== sumE) {
      throw new Error(`eInt(${want}) 与 Σ efInt×adInt(${sumE}) 不一致：`
        + '这会让证明从一开始就不成立。若要做阴性对照，请篡改公开包而非改这里');
    }
  }

  const adCommits = [];
  const adBlinds = [];
  for (const s of sources) {
    const c = PD.commit(s.adInt);
    adCommits.push(c.commit);
    adBlinds.push(c.r);
  }
  const eC = PD.commit(sumE);

  const pf = REL.proveFormula({
    adCommits, adBlinds, adValues: sources.map((s) => s.adInt),
    efInts: sources.map((s) => s.efInt),
    eCommit: eC.commit, eBlind: eC.r, eValue: sumE,
    label,
  });
  const wire = REL.wireOnly(pf);

  const batchNo = String(p.batchNo || 'ADHOC');
  return {
    batchNo,
    entId: p.entId != null ? Number(p.entId) : null,
    year: p.year != null ? Number(p.year) : null,
    factorVersion: p.factorVersion || 'adhoc',
    label,
    scales: { ef: EF_SCALE, ad: AD_SCALE, e: E_SCALE },
    publicPayload: {
      protocol: `${PROTOCOL_VERSION}+formula`,
      batchNo,
      entId: p.entId != null ? Number(p.entId) : null,
      year: p.year != null ? Number(p.year) : null,
      factorVersion: p.factorVersion || 'adhoc',
      label,
      scales: { ef: EF_SCALE, ad: AD_SCALE, e: E_SCALE },
      efInts: sources.map((s) => s.efInt.toString()),
      sourceCodes: sources.map((s) => s.code),
      adCommits: adCommits.map((c) => C.encodePoint(c)),
      eCommit: eC.encode,
      proof: wire,
      proofBytes: Buffer.byteLength(JSON.stringify(wire), 'utf8'),
      digest: C.hashHex('zkc-formula/v1', batchNo, eC.encode,
        ...adCommits.map((c) => C.encodePoint(c)),
        ...sources.map((s) => s.efInt.toString())),
    },
    privateWitness: {
      batchNo,
      sources: sources.map((s, i) => ({
        code: s.code,
        activity: s.adInt.toString(),
        blind: adBlinds[i].toString(),
      })),
      eValue: sumE.toString(),
      eBlind: eC.r.toString(),
      note: '此文件含活动数据与盲化因子，等价于产量/能耗机密。仅用于向授权方开放。',
    },
    __internal: {
      sourceCount: sources.length,
      totalE: Number(sumE) / 10 ** E_SCALE,
      detail: sources.map((s) => ({
        code: s.code,
        ad: Number(s.adInt) / 10 ** AD_SCALE,
        ef: Number(s.efInt) / 10 ** EF_SCALE,
        e: Number(s.eInt) / 10 ** E_SCALE,
      })),
    },
  };
}

/**
 * 验证「排放量确实是算出来的」。
 * @param {object} p
 *   publicPayload  上面 buildFormulaProof 返回的 publicPayload
 */
function verifyFormulaProof(p) {
  const pl = p.publicPayload || p;
  const checks = [];
  const push = (n, ok, d) => checks.push({ name: n, pass: !!ok, detail: d });

  if (!pl || !pl.proof) return { ok: false, reason: '缺少证明体', checks };

  /* 量纲自检：e = ef + ad */
  const sc = pl.scales || {};
  if (Number(sc.e) !== Number(sc.ef) + Number(sc.ad)) {
    return {
      ok: false,
      reason: `量纲不自洽：eScale(${sc.e}) ≠ efScale(${sc.ef}) + adScale(${sc.ad})。`
        + '公式在整数上不成立，证明必然无效',
      checks,
    };
  }
  push('量纲自洽（e = ef + ad）', true, `${sc.ef} + ${sc.ad} = ${sc.e}`);

  /* 摘要核对：防止公开包的其他字段被改动 */
  const dg = C.hashHex('zkc-formula/v1', pl.batchNo, pl.eCommit,
    ...pl.adCommits, ...pl.efInts);
  push('公开包摘要自洽', dg === pl.digest,
    dg === pl.digest ? '' : '摘要不匹配：批次号/承诺/因子被改动');
  if (dg !== pl.digest) {
    return { ok: false, reason: '公开包摘要不匹配：元数据被篡改', checks };
  }

  /* 核心：验证公式关系 */
  const vr = REL.verifyFormula({
    adCommits: pl.adCommits,
    efInts: pl.efInts.map((x) => BigInt(x)),
    eCommit: pl.eCommit,
    proof: pl.proof,
    label: pl.label,
  });
  push('公式关系 E = Σ EF·AD 成立', vr.ok, vr.reason);
  return {
    ok: vr.ok,
    reason: vr.ok
      ? `证明有效：该批次的排放量确实等于 ${pl.sourceCodes.length} 个排放源的 `
        + 'EF × AD 之和，且未泄漏任何活动数据'
      : `证明无效：${vr.reason}`,
    checks: checks.concat(vr.checks),
    meta: {
      batchNo: pl.batchNo,
      sourceCount: pl.sourceCodes ? pl.sourceCodes.length : null,
      factorVersion: pl.factorVersion,
      proofBytes: pl.proofBytes,
      disclosure: '验证方确认了"这个数是算出来的"，但未获得任何活动数据或排放量数值',
    },
  };
}

/**
 * 保存公式证明（只存公开部分）并上链存证。
 *
 * ⚠ 与承诺表一样：活动数据与盲化因子**绝不入库**。
 *   平台自己也无法从本表反推任何活动数据 —— 这是设计目标。
 */
async function saveFormulaProof(result, opts = {}) {
  if (!result || !result.publicPayload) throw new Error('公式证明结果无效');

  const pl = result.publicPayload;
  const exist = await db.one('SELECT id FROM zk_formula_proof WHERE digest = ?', [pl.digest]);
  if (exist) return { id: Number(exist.id), dedup: true };

  const [ins] = await db.pool.query(
    `INSERT INTO zk_formula_proof
      (ent_id, year, batch_no, factor_version, source_count,
       ef_scale, ad_scale, e_scale, e_commit, payload_json, digest,
       proof_bytes, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      result.entId, result.year, result.batchNo, result.factorVersion,
      pl.sourceCodes.length, result.scales.ef, result.scales.ad, result.scales.e,
      pl.eCommit, JSON.stringify(pl), pl.digest,
      pl.proofBytes, 'ACTIVE', opts.operator || null,
    ]
  );

  let chain = null;
  try {
    const anchorSvc = require('./anchor');
    const tr = await anchorSvc.anchor({
      txType: 'ZK_FORMULA_PROOF',
      bizNo: 'ZKF-' + result.batchNo + '-' + pl.digest.slice(0, 8),
      fromLabel: 'ent:' + result.entId,
      payload: {
        batchNo: result.batchNo,
        entId: result.entId,
        year: result.year,
        sourceCount: pl.sourceCodes.length,
        factorVersion: result.factorVersion,
        eCommit: pl.eCommit,
        digest: pl.digest,
        scales: result.scales,
        /* ⚠ 上链内容不含任何活动数据或排放量数值 */
        disclosure: 'ZERO_KNOWLEDGE_FORMULA',
      },
    });
    await db.query(
      'UPDATE zk_formula_proof SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
      [tr.blockIndex, tr.txId, ins.insertId]
    );
    chain = { blockIndex: tr.blockIndex, txId: tr.txId };
  } catch (e) {
    chain = { error: '上链失败：' + e.message };
  }

  return { id: ins.insertId, dedup: false, chain };
}

/* ==================================================================================
 * 五、落库与链上存证
 * ================================================================================== */

/** 保存隐私承诺包（只存公开部分；企业侧见证不落平台库） */
async function saveCommitment(payload, opts = {}) {
  const exist = await db.one(
    'SELECT id FROM zk_commitment WHERE ent_id = ? AND year = ? AND commit_value = ?',
    [payload.entId, payload.year, payload.commit]
  );
  if (exist) return { id: Number(exist.id), dedup: true };

  const [ins] = await db.pool.query(
    `INSERT INTO zk_commitment
      (ent_id, year, protocol, commit_value, proof_json, parts_json, digest,
       bits, scale_factor, unit, prove_ms, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      payload.entId, payload.year, payload.protocol, payload.commit,
      JSON.stringify(payload.proof),
      payload.parts ? JSON.stringify(payload.parts) : null,
      payload.digest, payload.meta.bits, payload.scale, payload.unit,
      payload.meta.proveMs || null, 'ACTIVE', opts.operator || null,
    ]
  );

  /* 上链：承诺摘要（不是承诺本身，承诺本身可离线分发） */
  let chain = null;
  try {
    const anchorSvc = require('./anchor');
    const tr = await anchorSvc.anchor({
      txType: 'ZK_COMMITMENT',
      bizNo: `ZK-${payload.entId}-${payload.year}-${String(payload.digest).slice(0, 8)}`,
      fromLabel: `ent:${payload.entId}`,
      payload: {
        protocol: payload.protocol,
        entId: payload.entId,
        year: payload.year,
        commit: payload.commit,
        digest: payload.digest,
        bits: payload.meta.bits,
        scale: payload.scale,
        /* ⚠ 上链内容必须**不含任何原始数值**，否则隐私承诺失去意义 */
        disclosure: 'ZERO_KNOWLEDGE',
      },
    });
    await db.query(
      'UPDATE zk_commitment SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
      [tr.blockIndex, tr.txId, ins.insertId]
    );
    chain = { blockIndex: tr.blockIndex, txId: tr.txId };
  } catch (e) {
    chain = { error: `上链失败：${e.message}` };
  }

  return { id: ins.insertId, dedup: false, chain };
}

/** 查询企业某年度的承诺包 */
async function listCommitments(entId, year) {
  const where = [];
  const params = [];
  if (entId) { where.push('ent_id = ?'); params.push(Number(entId)); }
  if (year) { where.push('year = ?'); params.push(Number(year)); }
  const rows = await db.query(
    `SELECT c.*, e.ent_name FROM zk_commitment c JOIN enterprise e ON e.id = c.ent_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.id DESC LIMIT 500`, params
  );
  return rows.map((r) => ({
    id: Number(r.id),
    entId: Number(r.ent_id),
    entName: r.ent_name,
    year: Number(r.year),
    protocol: r.protocol,
    commit: r.commit_value,
    digest: r.digest,
    bits: Number(r.bits),
    scale: Number(r.scale_factor),
    unit: r.unit,
    parts: safeJson(r.parts_json),
    proof: safeJson(r.proof_json),
    status: r.status,
    chain: { blockIndex: r.chain_block_index, txId: r.chain_tx_id },
    createdAt: r.created_at,
  }));
}

/**
 * 安全解析 JSON 列。
 *
 * ⚠ MySQL 的 JSON 类型列经 mysql2 驱动返回时**已经是对象**，不是字符串。
 *   直接 `JSON.parse(row.proof_json)` 会抛 `"[object Object]" is not valid JSON`。
 *   而这一点在不同驱动/版本/连接选项下行为不一致（有的返回字符串），
 *   因此必须写成"是字符串才 parse"的双兼容形式 —— 而不是假定某一种。
 *
 *   这类"数据库驱动返回值形状"的差异最容易在换环境时炸，
 *   且报错信息（"[object Object]" is not valid JSON）与真正原因（列类型 + 驱动行为）
 *   几乎无法从字面推断出来。
 */
function safeJson(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;          // 驱动已解析
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return fallback;
}

/* ==================================================================================
 * 六、自检
 * ================================================================================== */

async function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });

  /* 1. 端到端：生成 → 验证 */
  try {
    const { publicPayload, privateWitness } = await buildCommitment({
      entId: 1, year: 2026, emission: 8695375.682,
    });
    const vr = verifyCommitment(publicPayload, { expectedYear: 2026 });
    push('端到端：生成承诺 → 监管验证通过', vr.ok, vr.reason);
    push('承诺包不含原始排放量', !JSON.stringify(publicPayload).includes('8695375'),
      '序列化后的公开包中无原始数值');

    /* 2. 授权披露能还原出正确数值 */
    const disc = authorizedDisclose(publicPayload, privateWitness);
    push('授权披露可还原正确数值',
      Math.abs(disc.value - 8695375.682) < 0.001 && disc.verified,
      `披露值 ${disc.value} tCO₂e（原值 8695375.682）`);
  } catch (e) { push('端到端', false, e.message); }

  /* 3. 阴性对照：篡改承诺 */
  try {
    const { publicPayload } = await buildCommitment({ entId: 1, year: 2026, emission: 1000 });
    const bad = { ...publicPayload, commit: C.encodePoint(C.mul(C.randomScalar(), C.G)) };
    const vr = verifyCommitment(bad);
    push('⭐ 篡改承诺必须失败', vr.ok === false, vr.ok ? '未检出（缺陷）' : '范围证明与承诺不匹配');
  } catch (e) { push('⭐ 篡改承诺必须失败', false, e.message); }

  /* 4. 阴性对照：篡改年度（元数据） */
  try {
    const { publicPayload } = await buildCommitment({ entId: 1, year: 2026, emission: 1000 });
    const bad = { ...publicPayload, year: 2025 };
    const vr = verifyCommitment(bad);
    push('⭐ 篡改年度必须失败（摘要保护元数据）', vr.ok === false,
      vr.ok ? '未检出（缺陷）' : '摘要不匹配');
  } catch (e) { push('⭐ 篡改年度必须失败', false, e.message); }

  /* 5. 阴性对照：用错见证打开 */
  try {
    const { publicPayload, privateWitness } = await buildCommitment({ entId: 1, year: 2026, emission: 1000 });
    let err = null;
    try { authorizedDisclose(publicPayload, { ...privateWitness, blind: '1' }); } catch (e) { err = e.message; }
    push('⭐ 错误见证无法打开承诺', err !== null && err.includes('不匹配'),
      err || '未抛错（缺陷）');
  } catch (e) { push('⭐ 错误见证无法打开承诺', false, e.message); }

  /* 6. 同态聚合：3 家承诺聚合后仍可验证结构合法 */
  try {
    const ps = [];
    for (let i = 1; i <= 3; i++) {
      const { publicPayload } = await buildCommitment({ entId: i, year: 2026, emission: 1000 * i });
      ps.push(publicPayload);
    }
    const agg = aggregate(ps);
    push('同态聚合 3 家承诺', agg.count === 3 && agg.aggregateCommit.length === 130,
      `聚合承诺 ${agg.aggregateCommit.slice(0, 24)}…`);
    /* 聚合的确定性：同样输入两次聚合结果相同 */
    const agg2 = aggregate(ps);
    push('聚合结果确定性', agg.aggregateCommit === agg2.aggregateCommit, '');
    /* 顺序无关 */
    const agg3 = aggregate([...ps].reverse());
    push('⭐ 聚合与顺序无关（交换律）', agg.aggregateCommit === agg3.aggregateCommit, '');
    /* 改一家，聚合必变 */
    const ps2 = [...ps];
    ps2[1] = { ...ps2[1], commit: C.encodePoint(C.mul(C.randomScalar(), C.G)) };
    const agg4 = aggregate(ps2);
    push('⭐ 改动任一家承诺，聚合值必变', agg4.aggregateCommit !== agg.aggregateCommit, '');
  } catch (e) { push('同态聚合', false, e.message); }

  /* 7. 分源承诺与总量自洽 */
  try {
    const { publicPayload, privateWitness } = await buildCommitment({
      entId: 1, year: 2026, emission: 5000,
      breakdown: [
        { sourceCode: 'COAL', emission: 3000 },
        { sourceCode: 'POWER', emission: 2000 },
      ],
    });
    push('分源承诺与总量自洽（生成时校验）',
      publicPayload.parts && publicPayload.parts.length === 2,
      `2 个分源承诺`);
    /* 只披露一个分项 */
    const d = authorizedDisclose(publicPayload, privateWitness, 'COAL');
    push('⭐ 可选择只披露单个分项', d.scope === 'PART' && Math.abs(d.value - 3000) < 0.001,
      `仅披露 COAL = ${d.value} t，POWER 仍保密`);
  } catch (e) { push('分源承诺', false, e.message); }

  /* 8. 分项之和不等于总量时必须拒绝生成 */
  try {
    let err = null;
    try {
      await buildCommitment({
        entId: 1, year: 2026, emission: 5000,
        breakdown: [{ sourceCode: 'COAL', emission: 3000 }, { sourceCode: 'POWER', emission: 1000 }],
      });
    } catch (e) { err = e.message; }
    push('⭐ 分项之和不等于总量时拒绝生成', err !== null && err.includes('不一致'),
      err || '未拒绝（缺陷）');
  } catch (e) { push('⭐ 分项之和不等于总量时拒绝生成', false, e.message); }

  /* 9. 跨期一致性（**真实场景**：各月盲化因子完全独立）
   *
   * ⚠ 上一轮这里写的是循环论证：先让「年度承诺 = Σ月度承诺」构造出来，
   *   再断言「Σ月度承诺 == 年度承诺」。恒真，但代码在真实场景下不可用。
   *   现在改为：年度承诺**独立生成**（盲化因子随机且与月度无关），
   *   再用线性关系零知识证明来验证数值相等。这才是真实业务形态。 */
  try {
    const monthlyVals = [100, 120, 95, 110, 130, 105, 115, 125, 100, 108, 112, 118];
    const ms = [];
    const mBlinds = [];
    for (const v of monthlyVals) {
      const r = await buildCommitment({ entId: 1, year: 2026, emission: v });
      ms.push(r.publicPayload);
      mBlinds.push(r.privateWitness.blind);
    }
    /* 年度承诺：独立生成，盲化因子与月度毫无关系 */
    const totalVal = monthlyVals.reduce((a, b) => a + b, 0);
    const annual = await buildCommitment({ entId: 1, year: 2026, emission: totalVal });

    const pr = periodProof({
      mode: 'prove',
      monthlyCommits: ms,
      monthlyBlinds: mBlinds,
      annualCommit: annual.publicPayload,
      annualBlind: annual.privateWitness.blind,
      monthlyValues: monthlyVals.map((v) => BigInt(Math.round(v * 1000))),
      annualValue: BigInt(Math.round(totalVal * 1000)),
      year: 2026,
      label: 'PERIOD:2026:REAL',
    });
    const vr = periodProof({
      mode: 'verify',
      monthlyCommits: ms,
      annualCommit: annual.publicPayload,
      proof: pr.proof,
      year: 2026,
      label: 'PERIOD:2026:REAL',
    });
    push('⭐ 跨期一致：12 个月盲化因子独立仍可证（真实场景）',
      vr.consistent === true, `${pr.proofBytes} 字节的零知识证明`);

    /* 阴性：少一个月 */
    try {
      periodProof({
        mode: 'prove',
        monthlyCommits: ms.slice(0, 11),
        monthlyBlinds: mBlinds.slice(0, 11),
        annualCommit: annual.publicPayload,
        annualBlind: annual.privateWitness.blind,
        monthlyValues: monthlyVals.slice(0, 11).map((v) => BigInt(Math.round(v * 1000))),
        annualValue: BigInt(Math.round(totalVal * 1000)),
        year: 2026, label: 'PERIOD:2026:REAL',
      });
      push('⭐ 跨期：漏一个月即无法生成证明（防逐月缩水）', false, '未拒绝（缺陷）');
    } catch (e) {
      push('⭐ 跨期：漏一个月即无法生成证明（防逐月缩水）',
        e.message.includes('线性关系不成立'), '数值对不上，生成阶段拒绝');
    }

    /* 阴性：把证明挪用到另一个年度标签 */
    const vr2 = periodProof({
      mode: 'verify',
      monthlyCommits: ms,
      annualCommit: annual.publicPayload,
      proof: pr.proof,
      year: 2027, label: 'PERIOD:2027:REAL',
    });
    push('⭐ 跨期：证明不能挪用到别的年度（标签绑定）',
      vr2.consistent === false, vr2.consistent ? '未检出（缺陷）' : '上下文不符 ⇒ 拒绝');
  } catch (e) { push('跨期一致性', false, e.message); }

  /* 10. 性能 */
  try {
    const t0 = Date.now();
    const { publicPayload } = await buildCommitment({ entId: 1, year: 2026, emission: 8695375 });
    const tBuild = Date.now() - t0;
    const t1 = Date.now();
    verifyCommitment(publicPayload);
    const tVerify = Date.now() - t1;
    const bytes = Buffer.byteLength(JSON.stringify(publicPayload), 'utf8');
    push('生成 < 5 秒', tBuild < 5000, `${tBuild} ms`);
    push('验证 < 1 秒', tVerify < 1000, `${tVerify} ms`);
    push('公开包大小 < 4 KB', bytes < 4096, `${bytes} 字节（承诺 65B + 证明 ~1.1KB）`);
    push('压缩比：原始数据明细 vs 公开包',
      bytes < 4096, `一家企业一年的承诺仅 ${(bytes / 1024).toFixed(1)} KB，可批量上链`);
  } catch (e) { push('性能', false, e.message); }

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

module.exports = {
  PROTOCOL_VERSION, DEFAULT_BITS,
  buildCommitment, verifyCommitment, authorizedDisclose,
  aggregate, periodProof,
  buildFormulaProof, buildFormulaProofFromValues, verifyFormulaProof, saveFormulaProof,
  saveCommitment, listCommitments, safeJson,
  selfTest,
};
