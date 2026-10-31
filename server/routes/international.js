/**
 * routes/international.js —— WP5 国际互认与绿电溯源 API
 * ------------------------------------------------------------------
 * 挂载点：`/api`（与设计文档的端点命名逐字对齐）
 *   /api/cbam/*        CBAM 申报数据包（ISO 14067 口径）
 *   /api/greenpower/*  小时级绿电溯源
 *   /api/report/*      双轨报告导出（ISO 14064-1 / ISO 14067）
 *   /api/cost/*        成本量化对照
 *
 * 权限设计
 *   读接口：任意已登录角色（国际合规信息对外可见，符合"推广价值"的举证需要）
 *   写接口：企业只能操作**自己**的主体（ent_id 强制取自 req.user.orgId，不接受入参覆盖）；
 *           ADMIN 可代为操作（用于演示与代建）
 * ------------------------------------------------------------------
 */
'use strict';

const express = require('express');
const I = require('../services/international');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

/**
 * 解析目标企业 ID。
 * 企业角色：一律用令牌里的 orgId（**忽略入参**，防止越权改别家数据）；
 * 其他角色：用显式入参，未给则返回 null 表示"全平台汇总"。
 */
function resolveEntId(req, raw) {
  if (req.user.role === 'ENTERPRISE') return Number(req.user.orgId);
  const v = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  return v === null || Number.isNaN(v) ? null : v;
}

/** 写操作的授权：企业只能写自己，ADMIN 可以写任意（演示/代建） */
function writableEntId(req, raw) {
  if (req.user.role === 'ENTERPRISE') return Number(req.user.orgId);
  if (req.user.role === 'ADMIN' || req.user.role === 'REGULATOR') return Number(raw);
  return null;
}

/* ==================================================================
 * 一、法规基准与目录（把"依据哪一版法规"摆在最前面）
 * ================================================================== */

router.get('/cbam/catalog', wrap(async (req, res) => {
  ok(res, await I.catalog());
}));

router.get('/cbam/overview', wrap(async (req, res) => {
  ok(res, await I.overview());
}));

/* ==================================================================
 * 二、CBAM 申报数据包
 * ================================================================== */

/** 试算（不落库、不上链）—— 用于企业在正式生成前反复调整参数 */
router.post('/cbam/calc', wrap(async (req, res) => {
  const b = req.body || {};
  const id = resolveEntId(req, b.entId);
  if (!id) return fail(res, '缺少 entId（企业角色由令牌自动带入）', 400);
  try {
    const r = await I.productCarbon(id, {
      period: b.period, cnCode: b.cnCode, quantity: b.quantity,
    });
    ok(res, r);
  } catch (e) { fail(res, e.message, 400); }
}));

/** 生成并上链存证 */
router.post('/cbam/generate', wrap(async (req, res) => {
  const b = req.body || {};
  const id = writableEntId(req, b.entId);
  if (!id) return fail(res, '缺少 entId，或当前角色无权限为其他主体生成申报包', 403);
  try {
    const r = await I.generateDeclaration(id, { period: b.period, cnCode: b.cnCode, quantity: b.quantity });
    await writeLog(req, '国际互认', '生成 CBAM 申报包', r.declNo,
      `${r.calc.cnGoods} · 隐含碳 ${r.calc.embeddedIntensity} tCO2e/${r.calc.unit} · 指纹 ${r.digest.algorithm}:${r.digest.digest.slice(0, 16)}…`);
    ok(res, r, `CBAM 申报包 ${r.declNo} 已生成并上链（区块 ${r.chain.blockIndex || '—'}）`);
  } catch (e) { fail(res, e.message, 400); }
}));

router.get('/cbam/declarations', wrap(async (req, res) => {
  const id = resolveEntId(req, req.query.entId);
  const r = await I.listDeclarations({
    entId: id, period: req.query.period, cnCode: req.query.cnCode,
    page: req.query.page, size: req.query.size,
  });
  ok(res, r);
}));

router.get('/cbam/declaration/:id', wrap(async (req, res) => {
  const r = await I.getDeclaration(req.params.id);
  if (!r) return fail(res, `申报包 ${req.params.id} 不存在`, 404);
  /* 企业只能看自己的 */
  if (req.user.role === 'ENTERPRISE' && Number(r.declaration.ent_id) !== Number(req.user.orgId)) {
    return fail(res, '无权查看其他企业的申报包', 403);
  }
  ok(res, r);
}));

/* ==================================================================
 * 三、小时级绿电溯源
 * ================================================================== */

router.post('/greenpower/match', wrap(async (req, res) => {
  const b = req.body || {};
  const id = writableEntId(req, b.entId);
  if (!id) return fail(res, '缺少 entId，或当前角色无权限为其他主体执行匹配', 403);
  try {
    const r = await I.matchGreenPower(id, {
      year: b.year, month: b.month, days: b.days, from: b.from,
    });
    await writeLog(req, '国际互认', '小时级绿电匹配', `ent:${id}`,
      `${r.summary.hours} 小时 · 覆盖率 ${(r.summary.coverageRatio * 100).toFixed(2)}% · 减碳 ${r.summary.savedTco2} tCO2e`);
    ok(res, r, `已完成 ${r.summary.hours} 小时的绿电匹配，覆盖率 ${(r.summary.coverageRatio * 100).toFixed(2)}%`);
  } catch (e) {
    /* 无本期能耗数据 ≠ 错误：是"没有可匹配的输入"。返回 200 空结果 + 边界说明，
     * 前端按空态呈现 —— 400 会让自动化回归把正常业务空态判为点击异常（2026-10-31 巡检）。 */
    if (/无能耗数据|无法推导用电曲线/.test(e.message || '')) {
      return ok(res, {
        noData: true,
        summary: { hours: 0, coverageRatio: 0, savedTco2: 0 },
        boundary: { note: `${e.message}（本期无匹配输入，非系统故障）` },
      }, '本企业本期无能耗数据，无可匹配输入');
    }
    fail(res, e.message, 400);
  }
}));

router.get('/greenpower/summary', wrap(async (req, res) => {
  const id = resolveEntId(req, req.query.entId);
  ok(res, await I.greenPowerSummary({ entId: id, from: req.query.from, to: req.query.to }));
}));

/* ==================================================================
 * 四、双轨报告导出
 * ================================================================== */

/** 设计文档端点名：POST /api/report/export?std=14064|14067 */
router.post('/report/export', wrap(async (req, res) => {
  const b = req.body || {};
  const std = b.std || req.query.std;
  const id = writableEntId(req, b.entId);
  if (!id) return fail(res, '缺少 entId，或当前角色无权限为其他主体导出报告', 403);
  if (!std) return fail(res, '缺少 std 参数（14064 组织碳 / 14067 产品碳）', 400);
  try {
    const r = await I.exportReport(id, std, { period: b.period, cnCode: b.cnCode, operator: req.user.username });
    await writeLog(req, '国际互认', `导出双轨报告 ${r.std}`, r.title,
      `总量 ${r.payload.totals.total !== undefined ? r.payload.totals.total : r.payload.totals.totalEmission} · 指纹 ${r.digest.algorithm}:${r.digest.digest.slice(0, 16)}…`);
    ok(res, r, `${r.std} 报告已生成并上链存证`);
  } catch (e) { fail(res, e.message, 400); }
}));

router.get('/report/list', wrap(async (req, res) => {
  const id = resolveEntId(req, req.query.entId);
  ok(res, await I.listReports({ entId: id, std: req.query.std }));
}));

router.get('/report/:id', wrap(async (req, res) => {
  const r = await I.getReport(req.params.id);
  if (!r) return fail(res, `报告 ${req.params.id} 不存在`, 404);
  if (req.user.role === 'ENTERPRISE' && Number(r.ent_id) !== Number(req.user.orgId)) {
    return fail(res, '无权查看其他企业的报告', 403);
  }
  ok(res, r);
}));

/* ==================================================================
 * 五、成本量化对照
 * ================================================================== */

router.get('/cost/comparison', wrap(async (req, res) => {
  const id = resolveEntId(req, req.query.entId);
  ok(res, await I.costComparison(id));
}));

module.exports = router;
