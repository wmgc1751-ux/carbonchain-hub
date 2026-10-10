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
const { authRequired, ok, fail, wrap } = require('../middleware/auth');
const dyn = require('../services/dynamic');

const router = express.Router();

/** 解析"当前登录企业"的 ent_id（仅企业角色返回，其它角色返回 null 表示可见全量） */
function scopedEntId(req) {
  if (req.user && req.user.role === 'ENTERPRISE' && req.user.orgId) return Number(req.user.orgId);
  return null;
}

/* 动态核算总览 ------------------------------------------------------- */
router.get('/overview', wrap(async (req, res) => {
  const entId = scopedEntId(req) || (req.query.entId ? Number(req.query.entId) : null);
  ok(res, await dyn.overview(entId));
}));

/* 某企业实时读数 ----------------------------------------------------- */
router.get('/readings', authRequired, wrap(async (req, res) => {
  const scoped = scopedEntId(req);
  const entId = scoped || Number(req.query.entId);
  if (!entId) return fail(res, '缺少参数 entId', 400);
  const ent = await db.one('SELECT id, ent_name, industry, scale FROM enterprise WHERE id = ?', [entId]);
  if (!ent) return fail(res, '企业不存在', 404);
  ok(res, {
    enterprise: ent,
    monitors: dyn.monitorsOf(ent).map((m) => ({ monitorNo: m.monitor_no, energyType: m.energy_type, name: m.name })),
    readings: await dyn.readings(entId, req.query.limit),
  });
}));

/* 手动触发一次采数 --------------------------------------------------- */
router.post('/ingest', authRequired, wrap(async (req, res) => {
  const r = await dyn.ingest({ days: Number((req.body || {}).days) || 1 });
  ok(res, r, `已采集 ${r.inserted} 条 CEMS 实测读数（批次 ${r.batchNo}）`);
}));

/* 手动触发滚动核算 --------------------------------------------------- */
router.post('/recompute', authRequired, wrap(async (req, res) => {
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
    `SELECT total_allocated, available, frozen, used, bought, sold FROM carbon_quota
     WHERE ent_id = ? AND year = YEAR(NOW())`, [entId]
  );
  ok(res, { ...ov, quota });
}));

module.exports = router;
