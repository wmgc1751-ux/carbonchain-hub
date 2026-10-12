/**
 * routes/admin.js —— 平台管理端 API（A1~A5）
 *   · A2 因子库维护：排放因子 CRUD + 版本发布
 *   · A4 对账中心：链上链下对账
 *   · 基础设施：IPFS 文件存证 / 预言机多源校验
 *   · A1/A3/A5：联盟治理（复用 consortium）、用户权限、系统监控（复用 regulator/system）
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const factor = require('../services/factor');
const infra = require('../services/infra');

const router = express.Router();
router.use(authRequired, requireRole('ADMIN'));

/* ---------------- A2 因子库维护 ---------------- */

router.get('/factors', wrap(async (req, res) => {
  ok(res, await factor.listFactors(req.query));
}));

router.post('/factors', wrap(async (req, res) => {
  let r;
  try { r = await factor.upsertFactor(req.body || {}); }
  catch (e) { return fail(res, e.message, 400); }
  await writeLog(req, '因子库', '维护因子', String(r.energy_type || r.id), '更新排放因子');
  ok(res, r, '因子已保存');
}));

router.post('/factors/publish', wrap(async (req, res) => {
  let r;
  try { r = await factor.publishVersion({ ...(req.body || {}), operator: req.user.realName }); }
  catch (e) { return fail(res, e.message, 400); }
  await writeLog(req, '因子库', '发布版本', r.version, `发布因子版本 ${r.version}（${r.factorCount} 项）`);
  ok(res, r, `因子版本 ${r.version} 已发布并上链存证`);
}));

router.get('/factor-versions', wrap(async (req, res) => {
  ok(res, await factor.listVersions());
}));

/* ---------------- A4 对账中心 ---------------- */

router.post('/reconcile', wrap(async (req, res) => {
  const r = await infra.reconcile();
  await writeLog(req, '对账中心', '执行对账', r.reconNo || '', `核对 ${r.total} 条，不一致 ${r.inconsistent} 条`);
  ok(res, r, r.inconsistent === 0 ? '对账完成，链上链下全部一致' : `对账完成，发现 ${r.inconsistent} 条不一致记录`);
}));

router.get('/reconciliations', wrap(async (req, res) => {
  ok(res, await infra.reconcileHistory(req.query.limit ? Number(req.query.limit) : 20));
}));

/* ---------------- 基础设施：IPFS 存证 ---------------- */

router.post('/ipfs/anchor', wrap(async (req, res) => {
  let r;
  try { r = await infra.fileAnchor({ ...(req.body || {}), fromLabel: 'admin:system' }); }
  catch (e) { return fail(res, e.message, 400); }
  await writeLog(req, '存证', 'IPFS 上链', r.cid, `${r.fileName}（${r.size} B）`);
  ok(res, r, `文件已哈希上链，CID ${r.cid}`);
}));

/* ---------------- 基础设施：预言机 ---------------- */

router.post('/oracle', wrap(async (req, res) => {
  let r;
  try { r = await infra.oracle(req.body || {}); }
  catch (e) { return fail(res, e.message, 400); }
  await writeLog(req, '预言机', '多源校验', r.metric, `共识值 ${r.consensusValue} ${r.unit}（${r.trustedCount}/${r.sourceCount} 源可信）`);
  ok(res, r, `预言机共识值 ${r.consensusValue} ${r.unit}，已上链`);
}));

module.exports = router;
