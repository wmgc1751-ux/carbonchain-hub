/**
 * routes/uncertainty.js —— WP4 核算升级：不确定度、模型评估与口径方法学
 * ------------------------------------------------------------------
 * 挂载点：`/api/uncertainty`
 *
 * 权限设计
 *   读接口：任意已登录角色 —— 不确定度是"报告质量"的公开属性，
 *           监管方、核查方、企业方都应当看得到，藏着反而可疑。
 *   写接口：
 *     · 单企业重算   ENTERPRISE（只能算自己）/ REGULATOR / ADMIN
 *     · 全平台重算   REGULATOR / ADMIN
 *     · 报告上链     同上（会写链，须留痕）
 *
 * 端点分组
 *   方法学   /catalog              门控规则、积分口径、分级缺省不确定度、常量依据
 *   序列     /series/:entId        日均排放序列 + 门控报告 + 覆盖度 + 残缺日
 *   区间     /posterior/:entId     贝叶斯后验 + 先验敏感性 + 蒙特卡洛交叉验证
 *   传播     /propagate/:entId     GUM 误差传播 + 主导项 + 降不确定度建议
 *   模型     /model/:entId         模型评估 + 消融实验 + 诚实结论
 *   综合     /report/:entId        两口径对照 + 局限声明
 *            /report/:entId/anchor 生成报告并上链存证
 *   清单     /list                 已落库的后验区间
 *   批量     /recompute            批量重算
 *   行业     /industry             行业汇总（相对不确定度加权）
 *   自检     /selftest             本模块的数学与逻辑断言
 * ------------------------------------------------------------------
 */
'use strict';

const express = require('express');
const U = require('../services/uncertainty');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

/** 解析目标企业：企业角色一律用自己的 orgId（忽略入参，防越权） */
function resolveEntId(req, raw) {
  if (req.user.role === 'ENTERPRISE') return Number(req.user.orgId);
  const v = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  return v === null || Number.isNaN(v) ? null : v;
}

const canWrite = requireRole('ENTERPRISE', 'REGULATOR', 'ADMIN');
const canBatch = requireRole('REGULATOR', 'ADMIN');

/** 查询期参数（from/to/level/horizon 等）从 query 透传 */
function optsOf(req) {
  const q = req.query || {};
  const o = {};
  if (q.from) o.from = q.from;
  if (q.to) o.to = q.to;
  if (q.level) o.level = Number(q.level);
  if (q.horizon) o.horizon = Number(q.horizon);
  if (q.draws) o.draws = Number(q.draws);
  if (q.minDayCoverage !== undefined) o.minDayCoverage = Number(q.minDayCoverage);
  return o;
}

/* ==================================================================
 * 一、方法学（把"依据"摆在最前面）
 * ================================================================== */

router.get('/catalog', wrap(async (req, res) => {
  ok(res, U.catalog());
}));

/* ==================================================================
 * 二、序列与门控
 * ================================================================== */

router.get('/series/:entId', wrap(async (req, res) => {
  const id = resolveEntId(req, req.params.entId);
  if (!id) return fail(res, '缺少 entId（企业角色由令牌自动带入）', 400);
  try {
    const ds = await U.dailySeries(id, optsOf(req));
    ok(res, {
      entId: ds.entId, days: ds.days, incompleteDays: ds.incompleteDays,
      series: ds.series, allDays: ds.allDays, dayNote: ds.dayNote,
      gating: ds.gating, coverage: ds.coverage,
      rawQuality: ds.rawQuality, substituteRatio: ds.substituteRatio,
    });
  } catch (e) { fail(res, e.message, 400); }
}));

/* ==================================================================
 * 三、贝叶斯后验区间
 * ================================================================== */

router.get('/posterior/:entId', wrap(async (req, res) => {
  const id = resolveEntId(req, req.params.entId);
  if (!id) return fail(res, '缺少 entId（企业角色由令牌自动带入）', 400);
  try {
    const p = await U.posterior(id, optsOf(req));
    if (p.available === false) return ok(res, p);
    ok(res, {
      entId: p.entId, year: p.year, nObs: p.nObs, obsSummary: p.obsSummary,
      mean: p.mean, sd: p.sd, level: p.level,
      ciLow: p.ciLow, ciHigh: p.ciHigh,
      annual: p.extra.annual,
      classical: p.extra.classical, classicalDelta: p.extra.classicalDelta,
      priorParams: p.priorParams, posteriorParams: p.posteriorParams,
      priorSweep: p.extra.priorSweep, priorSafe: p.extra.priorSafe,
      maxShift: p.extra.maxShift, priorVerdict: p.extra.priorVerdict,
      quotaAnnual: p.extra.quotaAnnual, quotaGap: p.extra.quotaGap, quotaRatio: p.extra.quotaRatio,
      mc: p.mc, method: p.method, disclaimer: p.extra.disclaimer,
      coverage: p.extra.coverage, gating: p.extra.gating, series: p.extra.series,
    });
  } catch (e) { fail(res, e.message, 400); }
}));

/* ==================================================================
 * 四、GUM 误差传播
 * ================================================================== */

router.get('/propagate/:entId', wrap(async (req, res) => {
  const id = resolveEntId(req, req.params.entId);
  if (!id) return fail(res, '缺少 entId（企业角色由令牌自动带入）', 400);
  try {
    ok(res, await U.propagate(id, optsOf(req)));
  } catch (e) { fail(res, e.message, 400); }
}));

/* ==================================================================
 * 五、模型评估与消融
 * ================================================================== */

router.get('/model/:entId', wrap(async (req, res) => {
  const id = resolveEntId(req, req.params.entId);
  if (!id) return fail(res, '缺少 entId（企业角色由令牌自动带入）', 400);
  try {
    const m = await U.modelEval(id, optsOf(req));
    if (m.available === false) return ok(res, m);
    ok(res, {
      entId: m.entId, horizon: m.horizon, nTrain: m.nTrain, nTest: m.nTest,
      split: m.split, models: m.models, ablation: m.ablation,
      verdict: m.verdict, datasetSlice: m.datasetSlice, note: m.note,
      season: m.season, test: m.test,
    });
  } catch (e) { fail(res, e.message, 400); }
}));

/* ==================================================================
 * 六、综合报告
 * ================================================================== */

router.get('/report/:entId', wrap(async (req, res) => {
  const id = resolveEntId(req, req.params.entId);
  if (!id) return fail(res, '缺少 entId（企业角色由令牌自动带入）', 400);
  try {
    ok(res, await U.report(id, optsOf(req)));
  } catch (e) { fail(res, e.message, 400); }
}));

/** 生成报告并上链（结论的不可篡改留痕） */
router.post('/report/:entId/anchor', canWrite, wrap(async (req, res) => {
  const id = resolveEntId(req, req.params.entId);
  if (!id) return fail(res, '缺少 entId（企业角色由令牌自动带入）', 400);
  try {
    const r = await U.reportAndAnchor(id, optsOf(req));
    await writeLog(req, 'UNCERTAINTY', 'ANCHOR', `ent=${id}`,
      { entId: id, chain: r.chain });
    ok(res, {
      entId: r.entId, entName: r.entName, year: r.year,
      chain: r.chain,
      annual: r.posterior.available ? r.posterior.annual : null,
      relativeUncertainty: r.propagation.relativeUncertainty,
      crossCheck: r.crossCheck,
      verdict: r.modelEval.available ? r.modelEval.verdict : null,
    });
  } catch (e) { fail(res, e.message, 400); }
}));

/* ==================================================================
 * 七、批量与汇总
 * ================================================================== */

router.get('/list', wrap(async (req, res) => {
  ok(res, await U.list());
}));

/** 已落库的模型评估台账（每行 = 某企业某模型一次留出法评估） */
router.get('/models', wrap(async (req, res) => {
  ok(res, await U.modelEvalList({ entId: req.query.entId, model: req.query.model }));
}));

/** 批量重算后验区间并落库 */
router.post('/recompute', canBatch, wrap(async (req, res) => {
  /* entIds 为空数组时视同"全平台"，否则会拼出 `IN ()` 非法 SQL */
  const raw = req.body && req.body.entIds;
  const ids = Array.isArray(raw) && raw.length ? raw.map(Number).filter(Number.isFinite) : null;
  try {
    const r = await U.recomputeAll(Object.assign(optsOf(req), { entIds: ids }));
    await writeLog(req, 'UNCERTAINTY', 'RECOMPUTE', `成功 ${r.saved}/${r.total}`, r);
    ok(res, r);
  } catch (e) { fail(res, e.message, 500); }
}));

/** 行业汇总（相对不确定度的企业间分布） */
router.get('/industry', wrap(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 12;
  try {
    ok(res, await U.industrySummary(Object.assign(optsOf(req), { limit })));
  } catch (e) { fail(res, e.message, 500); }
}));

/* ==================================================================
 * 八、自检
 * ================================================================== */

router.get('/selftest', wrap(async (req, res) => {
  ok(res, U.selfTest());
}));

module.exports = router;
