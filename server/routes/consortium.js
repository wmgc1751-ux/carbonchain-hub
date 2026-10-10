/**
 * routes/consortium.js —— 联盟链治理 API
 * 成员节点列表 / 准入申请与审批 / 出块权吊销 / 链副本同步与一致性
 *
 * 读接口开放（联盟成员公开可审计）；写接口需监管角色。
 */
'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const cons = require('../services/consortium');

const router = express.Router();

/* 联盟成员节点列表 --------------------------------------------------- */
router.get('/nodes', wrap(async (req, res) => {
  ok(res, await cons.listNodes());
}));

/* 链副本一致性总览 --------------------------------------------------- */
router.get('/replica', wrap(async (req, res) => {
  ok(res, await cons.replicaStatus());
}));

/* 申请加入联盟（无需审批即可提交） ----------------------------------- */
router.post('/nodes/apply', wrap(async (req, res) => {
  const { nodeId, nodeName, orgType, orgName, remark } = req.body || {};
  if (!nodeId || !nodeName) return fail(res, '请填写节点标识与名称', 400);
  const n = await cons.applyNode({ nodeId, nodeName, orgType, orgName, remark });
  await writeLog(req, '联盟治理', '节点加入申请', nodeId, `申请加入联盟：${nodeName}`);
  ok(res, n, '加入申请已提交，等待联盟审批');
}));

/* 审批通过（授予出块权） --------------------------------------------- */
router.post('/nodes/:nodeId/approve', authRequired, requireRole('REGULATOR'), wrap(async (req, res) => {
  const n = await cons.approveNode(req.params.nodeId, (req.body || {}).weight);
  await writeLog(req, '联盟治理', '审批节点', req.params.nodeId, '授予出块权', 'SUCCESS');
  ok(res, n, `节点 ${req.params.nodeId} 已获批成为联盟出块节点`);
}));

/* 吊销节点出块权 ----------------------------------------------------- */
router.post('/nodes/:nodeId/revoke', authRequired, requireRole('REGULATOR'), wrap(async (req, res) => {
  const n = await cons.revokeNode(req.params.nodeId, (req.body || {}).reason);
  await writeLog(req, '联盟治理', '吊销节点', req.params.nodeId, (req.body || {}).reason || '吊销出块权', 'SUCCESS');
  ok(res, n, `节点 ${req.params.nodeId} 的出块权已被吊销`);
}));

/* 同步单节点副本 ----------------------------------------------------- */
router.post('/nodes/:nodeId/sync', wrap(async (req, res) => {
  const r = await cons.syncNode(req.params.nodeId, req.body || {});
  ok(res, r, r.synced > 0
    ? `节点 ${r.nodeId} 已同步 ${r.synced} 个区块，副本追平至高度 #${r.height}`
    : `节点 ${r.nodeId} 副本已是最新（高度 #${r.height}）`);
}));

/* 全部节点同步 ------------------------------------------------------- */
router.post('/sync', wrap(async (req, res) => {
  const rs = await cons.syncAll();
  const total = rs.reduce((a, b) => a + b.synced, 0);
  ok(res, rs, `已完成 ${rs.length} 个节点的副本同步，共补拉 ${total} 个区块`);
}));

/* 【演示】令某节点链副本落后 ----------------------------------------- */
router.post('/nodes/:nodeId/desync', wrap(async (req, res) => {
  const keep = (req.body || {}).keepHeight !== undefined ? (req.body || {}).keepHeight
    : await db.value('SELECT GREATEST(block_index - 5, 0) FROM chain_block ORDER BY block_index DESC LIMIT 1');
  const r = await cons.desyncNode(req.params.nodeId, keep);
  ok(res, r, `已模拟节点 ${r.nodeId} 的链副本落后到高度 #${r.height}（可随即调用同步接口追平）`);
}));

module.exports = router;
