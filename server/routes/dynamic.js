/**
 * routes/dynamic.js —— 动态核算 API
 * 实时读数 / 滚动核算总览 / 手动采数 / 手动重算
 *
 * 读接口：监管端与公众可看全量；企业端登录后只看本企业。
 * 写接口（手动采数/重算）：需登录。
 */
'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, requireRole, ok, fail, wrap } = require('../middleware/auth');
const dyn = require('../services/dynamic');

const router = express.Router();

/** 解析"当前登录企业"的 ent_id（仅企业角色返回，其它角色返回 null 表示可见全量） */
function scopedEntId(req) {
  if (req.user && req.user.role === 'ENTERPRISE' && req.user.orgId) return Number(req.user.orgId);
  return null;
}

/* 动态核算总览 ------------------------------------------------------- */
/* ⚠⚠ 这一端点必须鉴权。
 *
 * 原实现是 `router.get('/overview', wrap(...))` —— 完全无鉴权，且
 * `scopedEntId(req)` 在匿名时返回 null，而 null 在 `dyn.overview()` 里
 * 的语义是"给我全部企业"。于是**任何未登录的访问者都能拿到全平台 60 家
 * 企业的动态账户明细**：滚动排放量、配额余额、履约缺口、风险等级。
 *
 * 这不是"公开数据"。公开数据是真实层（EPA/Climate TRACE 的设施台账），
 * 而那些数据之所以公开，是因为源数据本身公开。企业配额与缺口是
 * **监管过程数据**，泄露它等于泄露"哪家企业即将违约"——
 * 这在碳市场里是可以直接变现的信息。
 *
 * 保留匿名访问的只有"聚合口径"（不含企业标识的总量统计），
 * 需要它的场景（如公示大屏）走 /api/public/dashboard。 */
router.get('/overview', authRequired, wrap(async (req, res) => {
  /* 企业角色强制锁定本企业；其他角色可显式按 entId 查单家。 */
  const scoped = scopedEntId(req);
  if (scoped) return ok(res, await dyn.overview(scoped));
  const entId = req.query.entId ? Number(req.query.entId) : null;
  ok(res, await dyn.overview(entId));
}));

/* 某企业实时读数 ----------------------------------------------------- */
router.get('/readings', authRequired, wrap(async (req, res) => {
  const scoped = scopedEntId(req);
  const entId = scoped || Number(req.query.entId);
  if (!entId) return fail(res, '缺少参数 entId', 400);

  /* 数据可见范围（产品口径）：企业端仅本企业（scoped 锁定）；核查 / 监管 / 管理
   * 角色可查看全部企业的实时监测数据（核查机构需跨企业核验，故与监管端同级可见）。 */
  const ent = await db.one('SELECT id, ent_name, industry, scale FROM enterprise WHERE id = ?', [entId]);
  if (!ent) return fail(res, '企业不存在', 404);
  ok(res, {
    enterprise: ent,
    monitors: dyn.monitorsOf(ent).map((m) => ({ monitorNo: m.monitor_no, energyType: m.energy_type, name: m.name })),
    readings: await dyn.readings(entId, req.query.limit),
  });
}));

/* 手动触发一次采数（监管/管理角色；采集为全局操作） ------------------- */
router.post('/ingest', authRequired, requireRole('REGULATOR'), wrap(async (req, res) => {
  const r = await dyn.ingest({ days: Number((req.body || {}).days) || 1 });
  ok(res, r, `已采集 ${r.inserted} 条 CEMS 实测读数（批次 ${r.batchNo}）`);
}));

/* 手动触发滚动核算（企业仅本企业；监管/管理可指定企业或全量） --------- */
router.post('/recompute', authRequired, requireRole('ENTERPRISE', 'REGULATOR'), wrap(async (req, res) => {
  const scoped = scopedEntId(req);
  const target = scoped || (req.body && req.body.entId ? Number(req.body.entId) : null);
  const rs = await dyn.recompute(target);
  ok(res, { count: rs.length, results: rs }, `已完成 ${rs.length} 家企业的滚动核算`);
}));

/* 企业端：我的动态核算 ----------------------------------------------- */
router.get('/me', authRequired, wrap(async (req, res) => {
  const entId = scopedEntId(req);
  if (!entId) return fail(res, '仅企业端可查看本企业动态核算', 403);
  const ov = await dyn.overview(entId);
  const quota = await db.one(
    `SELECT total_allocated, available, used FROM carbon_quota
     WHERE ent_id = ? AND year = YEAR(NOW())`, [entId]
  );
  ok(res, { ...ov, quota });
}));

module.exports = router;
