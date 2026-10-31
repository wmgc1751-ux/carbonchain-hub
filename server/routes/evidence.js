/**
 * routes/evidence.js —— 核算节点可信存证 API
 * ==================================================================================
 * 端点：
 *   POST /api/evidence/notarize        为任意核算节点生成存证凭证
 *   POST /api/evidence/batch/:batchNo  为核算批次生成存证（最常用）
 *   POST /api/evidence/verify          离线复核凭证（**公开，无需登录**）
 *   GET  /api/evidence/list            查询存证记录
 *   GET  /api/evidence/nodes           可存证的节点类型清单
 *
 * 【为什么 /verify 不需要登录】
 * 存证的价值在于"任何人都能验证"。如果验证必须登录，那它就退化成
 * "请相信我们验证过"——那和没有存证是一样的。
 * 凭证本身包含复核所需的全部信息（完整载荷 + 摘要 + 链上锚点），
 * 因此第三方拿到凭证即可独立复核，不需要平台的任何权限。
 *
 * @module routes/evidence
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, ok, fail, wrap } = require('../middleware/auth');
const E = require('../services/evidenceChain');

const router = express.Router();

/* ---------------------------------------------------------------------------------
 * 可存证的节点类型（公开 —— 让前端知道能对哪些动作存证）
 * --------------------------------------------------------------------------------- */
router.get('/nodes', (req, res) => {
  ok(res, Object.keys(E.NODE_TYPES).map((k) => ({
    code: k, name: E.NODE_TYPES[k],
  })));
});

/* ---------------------------------------------------------------------------------
 * 为核算批次生成存证
 * --------------------------------------------------------------------------------- */
router.post('/batch/:batchNo', authRequired, wrap(async (req, res) => {
  const batchNo = String(req.params.batchNo || '');
  if (!batchNo) return fail(res, 'batchNo 必填', 400);

  /* 越权检查：企业只能为自己的批次存证 */
  if (req.user.role === 'ENTERPRISE') {
    const row = await require('../db').one(
      'SELECT ent_id FROM calc_batch WHERE batch_no = ?', [batchNo]);
    if (!row) return fail(res, '批次不存在', 404);
    if (Number(row.ent_id) !== Number(req.user.orgId)) {
      return fail(res, '无权为其他企业的批次生成存证', 403);
    }
  }

  try {
    const cred = await E.notarizeCalcBatch(batchNo);
    /* 存证是重要动作，写审计。
     * ⚠ audit_log 的列是 user_id / username / role / module / action / target / detail，
     * 不是通用的 actor/action/target —— 按真实结构写。 */
    await require('../db').query(
      `INSERT INTO audit_log (user_id, username, role, module, action, target, detail, ip, result, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
      [req.user.uid || null, req.user.username || 'system', req.user.role || null,
        'evidence', 'NOTARIZE', 'calc_batch',
        `${batchNo} → ${cred.chain ? '区块#' + cred.chain.blockIndex : '未上链：' + cred.chainError}`,
        req.ip || null, cred.chain ? 'SUCCESS' : 'PARTIAL']);
    ok(res, cred);
  } catch (e) {
    fail(res, e.message, 400);
  }
}));

/* ---------------------------------------------------------------------------------
 * 通用存证（任意节点类型）
 * --------------------------------------------------------------------------------- */
router.post('/notarize', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  try {
    const cred = await E.notarize({
      nodeType: b.nodeType,
      bizNo: b.bizNo,
      entId: req.user.role === 'ENTERPRISE' ? Number(req.user.orgId) : (b.entId == null ? null : Number(b.entId)),
      inputs: b.inputs,
      factors: b.factors,
      output: b.output,
      methodology: b.methodology,
      extra: b.extra,
    });
    ok(res, cred);
  } catch (e) {
    fail(res, e.message, 400);
  }
}));

/* ---------------------------------------------------------------------------------
 * 离线复核（公开）
 * --------------------------------------------------------------------------------- */
router.post('/verify', wrap(async (req, res) => {
  const cred = (req.body && (req.body.credential || req.body)) || null;
  if (!cred) return fail(res, '需要凭证对象', 400);

  const result = E.verifyCredential(cred);

  /* 额外一层：如果凭证带 chain 锚点，去链上确认该 txId 确实存在、
   * 且 payload_hash 与凭证摘要一致。这一步让"存证"从"我算了摘要"
   * 升级为"链上确实有这条记录且内容对得上"。 */
  let chainCheck = null;
  if (cred.chain && cred.chain.txId) {
    try {
      const row = await require('../db').ledgerOne(
        `SELECT tx_id, block_index, payload_hash, payload_json FROM chain_tx WHERE tx_id = ?`,
        [String(cred.chain.txId)]);
      if (!row) {
        chainCheck = { found: false, reason: '链上不存在该交易号' };
      } else {
        let onChain = null;
        try { onChain = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json; }
        catch { onChain = null; }
        chainCheck = {
          found: true,
          blockIndex: row.block_index === null ? null : Number(row.block_index),
          /* 链上载荷里的 payloadDigest 必须等于凭证里的 payloadDigest */
          digestMatches: !!(onChain && onChain.payloadDigest === cred.payloadDigest),
          onChainDigest: onChain ? onChain.payloadDigest : null,
        };
      }
    } catch (e) {
      chainCheck = { found: false, reason: '链上查询失败：' + e.message };
    }
  }

  ok(res, {
    ...result,
    chainCheck,
    /* 汇总判据：既要凭证内部自洽，又要链上确实存在且摘要一致 */
    finalVerdict: result.ok && (!chainCheck || (chainCheck.found && chainCheck.digestMatches))
      ? 'PASS —— 凭证自洽且链上锚点匹配'
      : 'FAIL —— 见 checks 与 chainCheck',
  });
}));

/* ---------------------------------------------------------------------------------
 * 存证记录查询
 * --------------------------------------------------------------------------------- */
router.get('/list', authRequired, wrap(async (req, res) => {
  const rows = await E.listEvidence({
    bizNo: req.query.bizNo,
    limit: req.query.limit,
  });
  ok(res, rows, { count: rows.length });
}));

module.exports = router;
