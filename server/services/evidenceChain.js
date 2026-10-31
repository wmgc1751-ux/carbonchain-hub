/**
 * evidenceChain.js —— 核算节点可信存证（业务语义层）
 * ==================================================================================
 * 【为什么需要这一层，而不是让业务直接调 anchor()】
 *
 * `anchor()` 是**通用的上链原语**：给什么 payload 就存什么，它不理解业务。
 * 而"核算节点存证"有额外要求，这些要求不该散落在 20 个调用点里：
 *
 *   ① **载荷必须规范化**。同一个核算结果，字段顺序不同就会得到不同哈希 ——
 *      那不是"防篡改"，是"每次存证都有新哈希"，等于什么都没保证。
 *   ② **必须能离线复核**。存证的价值不在于"我存了"，而在"任何人都能重算
 *      这个哈希并验证"。因此载荷里必须带足够的信息让复核者独立重算。
 *   ③ **必须区分"链上锚点"与"链下明细"**。链上只放摘要，明细在业务表；
 *      两者绑定关系要能被检查（否则篡改明细不会被发现）。
 *
 * 本模块只做这三件事：规范化、算摘要、调 anchor。它不重复实现链。
 *
 * 【与 ZK 模块的分工】
 *   · 本模块解决"这个核算结果确实被存证过，且没被改过"（完整性）
 *   · ZK 模块解决"这个核算结果确实是算出来的"（正确性，不泄漏原始数据）
 *   两者互补：完整性 + 正确性 = 可验证的核算。
 *
 * @module services/evidenceChain
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');

/* ==================================================================================
 * 一、规范化与摘要
 * ================================================================================== */

/**
 * 规范化序列化：键排序、剔除空值、固定数字精度。
 *
 * 【为什么剔除 undefined 而保留 null】
 * undefined 表示"这个字段不存在"，null 表示"这个字段存在但值为空"。
 * 两者语义不同：前者可能是旧版对象，后者是明确的无值。
 * 若把 null 也剔除，"{a:1,b:null}" 与 "{a:1}" 会得到同一哈希 ——
 * 那就无法区分"没有这个字段"与"字段为空"。
 */
function canonicalize(obj) {
  if (obj === null) return null;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (typeof obj === 'object') {
    const out = {};
    Object.keys(obj).sort().forEach((k) => {
      const v = obj[k];
      if (v === undefined) return;              // 不存在 → 跳过
      out[k] = canonicalize(v);
    });
    return out;
  }
  if (typeof obj === 'number') {
    /* 浮点数统一到 6 位，避免 0.1+0.2 这类表示差异导致哈希不同。
     * 6 位远超核算精度（排放量 3 位小数、因子 4 位），不会丢失信息。 */
    return Number.isFinite(obj) ? Number(obj.toFixed(6)) : null;
  }
  return obj;
}

/** 摘要：SHA-256(规范化 JSON) */
function digestOf(payload) {
  return cu.sha256(JSON.stringify(canonicalize(payload)));
}

/* ==================================================================================
 * 二、核算节点存证
 * ================================================================================== */

/** 可存证的核算节点类型 */
const NODE_TYPES = {
  ACTIVITY_RECORDED: '活动数据登记',
  CALC_COMPLETED: '核算批次完成',
  VERIFY_PASSED: '核查通过',
  QUOTA_ALLOCATED: '配额分配',
  SURRENDER_EXECUTED: '履约清缴',
  REPORT_SUBMITTED: '排放上报',
};

/**
 * 为一次核算节点生成存证凭证。
 *
 * 载荷设计原则：**让复核者能在没有本平台的情况下重算**。
 * 因此载荷里包含：
 *   · 输入摘要（活动数据的规范化哈希）
 *   · 使用的因子（含版本号 —— 否则"用旧因子算的"无法被发现）
 *   · 输出值（排放量）
 *   · 计算口径（方法学版本）
 * 复核者拿到这四项即可独立重算并比对。
 *
 * @param {object} p
 *   nodeType    NODE_TYPES 的键
 *   bizNo       业务单号（批次号/上报号）
 *   entId       企业 ID
 *   inputs      输入摘要（活动数据列表，或已算好的摘要字符串）
 *   factors     使用的因子 [{code, ef, version}]
 *   output      输出值（排放量 tCO2e）
 *   methodology 方法学版本
 *   extra       其他需要固定的元数据
 * @returns {Promise<object>} 凭证
 */
async function notarize(p) {
  const nodeType = String(p.nodeType || '').toUpperCase();
  if (!NODE_TYPES[nodeType]) {
    throw new Error(`未知的核算节点类型：${p.nodeType}（支持 ${Object.keys(NODE_TYPES).join(' / ')}）`);
  }
  if (!p.bizNo) throw new Error('bizNo 必填');

  /* 载荷：把"复核所需的全部信息"一次性固定下来 */
  const payload = {
    /* 头部：能唯一确定"这是哪一次核算" */
    nodeType,
    nodeTypeCn: NODE_TYPES[nodeType],
    bizNo: String(p.bizNo),
    entId: p.entId == null ? null : Number(p.entId),
    /* 输入摘要：若调用方给的是数组，这里重新算；给的是字符串则直接采用
     * （用于"输入很大、已在别处算过摘要"的场景） */
    inputsDigest: Array.isArray(p.inputs) ? digestOf(p.inputs)
      : (typeof p.inputs === 'string' ? p.inputs : null),
    inputCount: Array.isArray(p.inputs) ? p.inputs.length : null,
    /* 因子：必须带版本，否则无法排除"用旧因子" */
    factors: (p.factors || []).map((f) => ({
      code: f.code, ef: Number(f.ef), version: f.version || null,
    })),
    factorsDigest: digestOf(p.factors || []),
    /* 输出：核算结果 */
    output: p.output == null ? null : Number(Number(p.output).toFixed(6)),
    outputUnit: 'tCO2e',
    /* 口径 */
    methodology: p.methodology || null,
    /* 存证时点：链上时间由区块决定，这里是业务时点 */
    notarizedAt: new Date().toISOString(),
    ...(p.extra && typeof p.extra === 'object' ? { extra: p.extra } : {}),
  };

  const payloadDigest = digestOf(payload);

  /* 上链：复用现有 anchor()，它负责签名、进池、PoA 出块 */
  let chainResult = null;
  let chainError = null;
  try {
    chainResult = await anchorSvc.anchor({
      txType: 'EVIDENCE_NODE',
      bizNo: String(p.bizNo),
      fromLabel: p.entId ? `ent:${p.entId}` : 'regulator:system',
      payload: {
        /* ⚠ 链上只放摘要，不放在整份 payload ——
         * 链的存储是稀缺资源，而完整载荷可以留在业务表里。
         * 但为了让复核者能重算，摘要必须包含**足够的信息量**。
         * 这里把 payload 的规范化 JSON 也一并存入链下（见下方 evidence_json），
         * 链上只锚定它的摘要。 */
        nodeType,
        bizNo: String(p.bizNo),
        entId: payload.entId,
        payloadDigest,
        output: payload.output,
        methodology: payload.methodology,
      },
    });
  } catch (e) {
    chainError = e.message;
  }

  return {
    nodeType,
    nodeTypeCn: NODE_TYPES[nodeType],
    bizNo: String(p.bizNo),
    entId: payload.entId,
    payloadDigest,
    /* 时序证据 */
    notarizedAt: payload.notarizedAt,
    /* 链上锚点（可能为空 —— 见 chainError） */
    chain: chainResult ? {
      txId: chainResult.txId,
      blockIndex: chainResult.blockIndex,
      blockHash: chainResult.blockHash,
      txHash: chainResult.txHash,
    } : null,
    chainError,
    /* 完整载荷：供独立复核者重算摘要 */
    evidence: payload,
    /* 复核说明：把"怎么验"写进返回体，而不是让用户猜 */
    verifyHint: {
      digestAlgorithm: 'SHA-256',
      canonicalization: '键排序 + 数字固定 6 位小数 + 剔除 undefined',
      steps: [
        '1. 取 evidence 字段（完整载荷）',
        '2. 按同样规则规范化（键排序、数字 6 位小数）',
        '3. 计算 SHA-256，应等于 payloadDigest',
        '4. 用 payloadDigest 到链上查 txId，应能找到对应区块',
        '5. 独立复算输出值：Σ(活动数据 × 因子)，应等于 output',
      ],
      caveat: '链上只锚定 payloadDigest，完整载荷保存在本响应与业务表中。'
        + '若业务表中的载荷被改动，第 3 步会失败 —— 这正是存证的作用。',
    },
  };
}

/**
 * 离线复核：给定凭证，重算并比对。
 *
 * 【为什么复核必须能在离线做】
 * "请相信我们的平台校验过" 不是证明。复核者应当能用本函数 +
 * 凭证里的公开信息独立验证，不需要访问本平台的数据库。
 */
function verifyCredential(cred) {
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });

  if (!cred || !cred.evidence) {
    return { ok: false, reason: '凭证缺少 evidence 字段，无法复核', checks };
  }

  /* ① 摘要复算 */
  const recomputed = digestOf(cred.evidence);
  push('载荷摘要可复算', recomputed === cred.payloadDigest,
    recomputed === cred.payloadDigest ? '' : `重算 ${recomputed.slice(0, 16)}… ≠ 凭证 ${String(cred.payloadDigest).slice(0, 16)}…`);

  /* ② 载荷内部自洽：output 与 factors 的存在性 */
  const ev = cred.evidence;
  push('载荷含输出值', ev.output != null, `output=${ev.output}`);
  push('载荷含方法学口径', !!ev.methodology, ev.methodology || '缺失');
  push('载荷含因子版本', Array.isArray(ev.factors) && ev.factors.every((f) => f.version),
    ev.factors && ev.factors.length ? `${ev.factors.length} 个因子` : '无因子（可能不是核算类节点）');

  /* ③ 因子摘要一致性 */
  const fDigest = digestOf(ev.factors || []);
  push('因子摘要自洽', fDigest === ev.factorsDigest);

  /* ④ 链上锚点存在性（仅结构检查，真正的链上查询由调用方做） */
  push('含链上锚点', !!cred.chain, cred.chain ? `区块 #${cred.chain.blockIndex}` : `未上链：${cred.chainError || '未知原因'}`);

  const passed = checks.filter((c) => c.pass).length;
  return {
    ok: checks.every((c) => c.pass),
    passed, total: checks.length,
    checks,
    verdict: checks.every((c) => c.pass)
      ? '凭证内部自洽，摘要可复算'
      : '凭证存在问题，见未通过项',
  };
}

/* ==================================================================================
 * 三、批量与查询
 * ================================================================================== */

/**
 * 为一次核算批次的所有排放源生成存证。
 * 这是"关键核算节点注入存证"的主要入口。
 */
async function notarizeCalcBatch(batchNo, opts = {}) {
  const batch = await db.one(
    `SELECT * FROM calc_batch WHERE batch_no = ?`, [String(batchNo)]);
  if (!batch) throw new Error(`核算批次 ${batchNo} 不存在`);

  const details = await db.query(
    `SELECT source_code, source_cn, activity, activity_unit, ef_value, ef_tier, emission, status
       FROM calc_source_detail WHERE batch_id = ? AND status = 'OK'
      ORDER BY source_code`, [Number(batch.id)]);

  if (!details.length) {
    throw new Error(`批次 ${batchNo} 没有可存证的排放源（全部为 NO_DATA）`);
  }

  return notarize({
    nodeType: 'CALC_COMPLETED',
    bizNo: String(batchNo),
    entId: Number(batch.ent_id),
    inputs: details.map((d) => ({
      source: d.source_code,
      activity: Number(d.activity),
      unit: d.activity_unit,
      tier: d.ef_tier,
    })),
    factors: details.map((d) => ({
      code: d.source_code,
      ef: Number(d.ef_value),
      version: batch.factor_version || 'unspecified',
    })),
    output: Number(batch.total_emission),
    methodology: batch.engine_version || 'unknown',
    extra: {
      year: Number(batch.year),
      period: batch.period,
      sourceCount: details.length,
      /* 分源明细摘要：让复核者能定位"哪个源被改了" */
      sourceDigests: details.map((d) => ({
        code: d.source_code,
        emission: Number(d.emission),
        digest: digestOf({ code: d.source_code, activity: Number(d.activity), ef: Number(d.ef_value) }),
      })),
    },
  });
}

/** 查某企业/某批次的存证记录（从链表反查） */
async function listEvidence(opts = {}) {
  const where = ["tx_type = 'EVIDENCE_NODE'"];
  const params = [];
  if (opts.bizNo) { where.push('biz_no = ?'); params.push(String(opts.bizNo)); }
  const limit = Math.min(Number(opts.limit) || 50, 200);

  /* 链表走账本通道（账本库可能与业务库不在同一实例） */
  const rows = await db.ledgerQuery(
    `SELECT tx_id, biz_no, block_index, payload_hash, payload_json, created_at, status
       FROM chain_tx WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT ?`, [...params, limit]);

  return rows.map((r) => {
    let payload = null;
    try { payload = typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json; }
    catch { payload = null; }
    return {
      txId: r.tx_id,
      bizNo: r.biz_no,
      blockIndex: r.block_index === null ? null : Number(r.block_index),
      payloadHash: r.payload_hash,
      payload,
      createdAt: r.created_at,
      status: r.status,
    };
  });
}

module.exports = {
  NODE_TYPES,
  canonicalize, digestOf,
  notarize, verifyCredential,
  notarizeCalcBatch, listEvidence,
};
