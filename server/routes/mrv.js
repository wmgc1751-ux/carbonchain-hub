/**
 * routes/mrv.js —— MRV 生产作业流 API
 * ==================================================================================
 * MRV = Monitoring（监测）/ Reporting（报告）/ Verification（核查）
 * 这是碳市场的数据基础设施，也是本平台从「演示」转向「可用」的主干。
 *
 * 端点分组：
 *   /activity   活动数据台账（录入 / 复核 / 查询 / 批量导入）
 *   /calc       核算作业（试算 / 落库 / 复算校验 / 批次查询）
 *   /factor     因子台账（结构化因子 + 三要素复算）
 *   /quality    数据质量（覆盖率 / 来源分级 / 缺口清单）
 *
 * 访问控制：
 *   · 活动数据：企业端填报，核查端与监管端可读
 *   · 核算：企业端发起，核查端复核，监管端可读全部
 *   · 因子：管理端维护，所有人可读（因子必须公开，否则无法复核）
 *
 * @module routes/mrv
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const db = require('../db');
const calcEngine = require('../services/calcEngine');
const methodology = require('../services/methodology');
const uq = require('../services/uq');

const router = express.Router();

/** 访问主体：企业端取自身；核查/监管/管理端可指定 entId */
function scopedEntId(req, explicit) {
  if (req.user.role === 'ENTERPRISE') return req.user.orgId;
  const v = explicit !== undefined && explicit !== null ? Number(explicit) : null;
  if (!v) return null;
  return v;
}

/* ==================================================================================
 * 一、活动数据台账
 * ================================================================================== */

/* 查询活动数据（按企业 + 年度 + 月份） */
router.get('/activity', authRequired, wrap(async (req, res) => {
  const entId = scopedEntId(req, req.query.entId);
  const year = Number(req.query.year) || new Date().getFullYear();
  if (!entId) return fail(res, '需要指定 entId（企业端自动取自身）', 400);

  const where = ['ent_id = ?', 'year = ?'];
  const params = [entId, year];
  if (req.query.month) { where.push('month = ?'); params.push(Number(req.query.month)); }
  if (req.query.sourceCode) { where.push('source_code = ?'); params.push(String(req.query.sourceCode).toUpperCase()); }
  if (req.query.status) { where.push('status = ?'); params.push(String(req.query.status).toUpperCase()); }
  if (req.query.origin) { where.push('data_origin = ?'); params.push(String(req.query.origin).toUpperCase()); }

  const rows = await db.query(
    `SELECT * FROM activity_data WHERE ${where.join(' AND ')}
      ORDER BY source_code, month`, params
  );

  /* 按排放源汇总，同时给出「哪个月缺」—— 这比给一个总数有用得多 */
  const bySource = new Map();
  for (const r of rows) {
    const k = r.source_code;
    if (!bySource.has(k)) {
      bySource.set(k, {
        sourceCode: k, sourceType: r.source_type, unit: r.unit,
        total: 0, months: [], origins: {}, statuses: {},
      });
    }
    const s = bySource.get(k);
    s.total = Number((s.total + Number(r.quantity)).toFixed(4));
    s.months.push(Number(r.month));
    s.origins[r.data_origin] = (s.origins[r.data_origin] || 0) + 1;
    s.statuses[r.status] = (s.statuses[r.status] || 0) + 1;
  }

  const missingMonths = {};
  for (const [code, s] of bySource) {
    const miss = [];
    for (let m = 1; m <= 12; m++) if (!s.months.includes(m)) miss.push(m);
    if (miss.length) missingMonths[code] = miss;
  }

  ok(res, {
    entId, year,
    count: rows.length,
    records: rows.map((r) => ({
      id: Number(r.id), month: Number(r.month),
      sourceCode: r.source_code, sourceType: r.source_type,
      quantity: Number(r.quantity), unit: r.unit,
      dataOrigin: r.data_origin,
      meterNo: r.meter_no, meterCalibratedUntil: r.meter_calibrated_until,
      voucherNo: r.voucher_no, labReportNo: r.lab_report_no,
      measured: (r.measured_ncv || r.measured_cc || r.measured_of) ? {
        ncv: r.measured_ncv === null ? null : Number(r.measured_ncv),
        cc: r.measured_cc === null ? null : Number(r.measured_cc),
        of: r.measured_of === null ? null : Number(r.measured_of),
      } : null,
      submittedBy: r.submitted_by, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
      status: r.status, rejectReason: r.reject_reason, remark: r.remark,
    })),
    bySource: [...bySource.values()].map((s) => ({
      ...s, months: s.months.length, total: Number(s.total.toFixed(3)),
    })),
    missingMonths,
    summary: {
      coveredMonths: new Set(rows.map((r) => Number(r.month))).size,
      l0Count: rows.filter((r) => r.data_origin === 'L0').length,
      pendingReview: rows.filter((r) => r.status === 'SUBMITTED').length,
    },
  });
}));

/* 录入/更新一条活动数据 */
router.post('/activity', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const b = req.body || {};
  const entId = req.user.role === 'ENTERPRISE' ? req.user.orgId : Number(b.entId);
  if (!entId) return fail(res, '企业端自动取自身，管理端需传 entId', 400);

  const year = Number(b.year) || new Date().getFullYear();
  const month = Number(b.month);
  const code = String(b.sourceCode || '').toUpperCase();
  const qty = Number(b.quantity);

  if (!(month >= 1 && month <= 12)) return fail(res, 'month 必须为 1~12', 400);
  if (!code) return fail(res, 'sourceCode 必填（如 COAL / CEMENT_CLINKER / POWER）', 400);
  /* ⚠ 负数是显式错误：活动数据不可能为负。允许 0 表示"本月确实没有消耗"，
   * 但 0 与"未填报"语义不同 —— 0 是声明，未填报是缺失，二者在核算中处理不同。 */
  if (!Number.isFinite(qty) || qty < 0) return fail(res, 'quantity 必须为非负数', 400);

  /* 校验排放源是否在方法学登记表中 —— 否则核算时会变成"未知源" */
  const known = methodology.FUEL_FACTORS[code] || methodology.PROCESS_FACTORS[code];
  if (!known) {
    return fail(res, `排放源 ${code} 未在方法学因子表中登记；可选：`
      + Object.keys(methodology.FUEL_FACTORS).concat(Object.keys(methodology.PROCESS_FACTORS)).join(' / '), 400);
  }
  const unit = b.unit || known.unit || 't';

  const origin = String(b.dataOrigin || 'L2').toUpperCase();
  if (!['L3', 'L2', 'L1', 'L0'].includes(origin)) return fail(res, 'dataOrigin 必须为 L3/L2/L1/L0', 400);

  const isProcess = !!methodology.PROCESS_FACTORS[code];
  const sourceType = isProcess ? 'PROCESS' : (known.scope === 2 ? 'INDIRECT' : 'FUEL');

  await db.query(
    `INSERT INTO activity_data
      (ent_id, year, month, source_code, source_type, quantity, unit, data_origin,
       meter_no, meter_calibrated_until, voucher_no, measured_ncv, measured_cc, measured_of,
       lab_report_no, submitted_by, status, remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'SUBMITTED',?)
     ON DUPLICATE KEY UPDATE
       quantity = VALUES(quantity), unit = VALUES(unit), data_origin = VALUES(data_origin),
       meter_no = VALUES(meter_no), meter_calibrated_until = VALUES(meter_calibrated_until),
       voucher_no = VALUES(voucher_no), measured_ncv = VALUES(measured_ncv),
       measured_cc = VALUES(measured_cc), measured_of = VALUES(measured_of),
       lab_report_no = VALUES(lab_report_no), status = 'SUBMITTED', remark = VALUES(remark)`,
    [entId, year, month, code, sourceType, qty, unit, origin,
      b.meterNo || null, b.meterCalibratedUntil || null, b.voucherNo || null,
      b.measuredNcv || null, b.measuredCc || null, b.measuredOf || null,
      b.labReportNo || null, req.user.username || null, b.remark || null]
  );

  const row = await db.one(
    'SELECT * FROM activity_data WHERE ent_id = ? AND year = ? AND month = ? AND source_code = ?',
    [entId, year, month, code]
  );

  await writeLog(req, 'MRV_ACTIVITY_SAVE',
    `录入活动数据 ent=${entId} ${year}-${month} ${code}=${qty}${unit}（${origin}）`);

  ok(res, {
    id: Number(row.id), entId, year, month, sourceCode: code, sourceType,
    quantity: Number(row.quantity), unit: row.unit, dataOrigin: row.data_origin,
    status: row.status,
    hint: origin === 'L0'
      ? '⚠ L0 表示活动数据缺失、按缺省值暂代。该记录会导致整年不可用于履约，请尽快补录原始凭证'
      : (origin === 'L1' ? '⚠ L1 为估算值，需补录原始凭证才能通过复核' : null),
  });
}));

/* 批量导入活动数据（一次提交整月/整年） */
router.post('/activity/bulk', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const b = req.body || {};
  const entId = req.user.role === 'ENTERPRISE' ? req.user.orgId : Number(b.entId);
  if (!entId) return fail(res, '需要 entId', 400);
  const year = Number(b.year) || new Date().getFullYear();
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return fail(res, 'items 不能为空', 400);
  if (items.length > 500) return fail(res, '单次最多导入 500 条', 400);

  const results = []; let saved = 0, rejected = 0;
  for (const it of items) {
    const code = String(it.sourceCode || '').toUpperCase();
    const month = Number(it.month);
    const qty = Number(it.quantity);
    const known = methodology.FUEL_FACTORS[code] || methodology.PROCESS_FACTORS[code];
    if (!known || !(month >= 1 && month <= 12) || !Number.isFinite(qty) || qty < 0) {
      rejected++; results.push({ item: it, ok: false, reason: known ? '月份或数量非法' : `未知排放源 ${code}` });
      continue;
    }
    const isProcess = !!methodology.PROCESS_FACTORS[code];
    const sourceType = isProcess ? 'PROCESS' : (known.scope === 2 ? 'INDIRECT' : 'FUEL');
    const origin = String(it.dataOrigin || 'L2').toUpperCase();
    await db.query(
      `INSERT INTO activity_data
        (ent_id, year, month, source_code, source_type, quantity, unit, data_origin,
         meter_no, voucher_no, measured_ncv, measured_cc, measured_of, lab_report_no,
         submitted_by, status, remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'SUBMITTED',?)
       ON DUPLICATE KEY UPDATE quantity = VALUES(quantity), data_origin = VALUES(data_origin),
         meter_no = VALUES(meter_no), voucher_no = VALUES(voucher_no),
         measured_ncv = VALUES(measured_ncv), measured_cc = VALUES(measured_cc),
         measured_of = VALUES(measured_of), lab_report_no = VALUES(lab_report_no),
         status = 'SUBMITTED'`,
      [entId, year, month, code, sourceType, qty, it.unit || known.unit || 't',
        ['L3', 'L2', 'L1', 'L0'].includes(origin) ? origin : 'L2',
        it.meterNo || null, it.voucherNo || null,
        it.measuredNcv || null, it.measuredCc || null, it.measuredOf || null,
        it.labReportNo || null, req.user.username || null, it.remark || null]
    );
    saved++;
  }

  await writeLog(req, 'MRV_ACTIVITY_BULK', `批量导入活动数据 ent=${entId} ${year}：成功 ${saved} / 拒绝 ${rejected}`);
  ok(res, { entId, year, saved, rejected, details: results.slice(0, 50) });
}));

/* 复核活动数据（核查端/管理端）—— 双人复核制 */
router.post('/activity/:id/review', authRequired, requireRole('VERIFIER', 'ADMIN', 'REGULATOR'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const approve = req.body && req.body.approve !== false;
  const reason = (req.body && req.body.reason) || null;

  const row = await db.one('SELECT * FROM activity_data WHERE id = ?', [id]);
  if (!row) return fail(res, '记录不存在', 404);
  if (row.status === 'REVIEWED' && approve) {
    return ok(res, { id, status: 'REVIEWED', alreadyDone: true });
  }

  /* ⚠ L0 数据不允许复核通过。
   * 这不是"过严"：L0 = 活动数据缺失、用行业均值暂代。给它盖上"已复核"的章，
   * 等于把估算值洗成实测值，整个数据质量体系就失效了。 */
  if (approve && row.data_origin === 'L0') {
    return fail(res, 'L0（缺省值）数据不得复核通过：请先补录原始凭证并改为 L2/L3 后重提', 409);
  }

  await db.query(
    `UPDATE activity_data SET status = ?, reviewed_by = ?, reviewed_at = NOW(),
       reject_reason = ? WHERE id = ?`,
    [approve ? 'REVIEWED' : 'REJECTED', req.user.username || null, approve ? null : reason, id]
  );
  await writeLog(req, 'MRV_ACTIVITY_REVIEW',
    `${approve ? '通过' : '驳回'}活动数据 #${id}（${row.source_code} ${row.year}-${row.month}）${reason ? '：' + reason : ''}`);

  ok(res, { id, status: approve ? 'REVIEWED' : 'REJECTED', reviewedBy: req.user.username });
}));

/* ==================================================================================
 * 二、核算作业
 * ================================================================================== */

/* 试算（不落库）—— 让企业先看到"如果现在核算会得到什么"，再决定是否确认 */
router.post('/calc/preview', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const entId = scopedEntId(req, b.entId || req.query.entId);
  if (!entId) return fail(res, '需要 entId', 400);
  const year = Number(b.year) || new Date().getFullYear();

  const r = await calcEngine.compute({
    entId, year,
    method: b.method || 'CALC',
    factorVersion: b.factorVersion,
    onlyReviewed: b.onlyReviewed === true,
  });
  if (!r.ok) {
    /* fail() 只接受三个参数，附带诊断信息需要显式返回 */
    return res.status(409).json({ code: 409, message: r.reason, detail: r.detail || null, gaps: r.gaps || null, hint: r.hint || null });
  }
  ok(res, r);
}));

/* 核算并落库 */
router.post('/calc', authRequired, requireRole('ENTERPRISE', 'ADMIN', 'VERIFIER'), wrap(async (req, res) => {
  const b = req.body || {};
  const entId = scopedEntId(req, b.entId);
  if (!entId) return fail(res, '需要 entId', 400);
  const year = Number(b.year) || new Date().getFullYear();

  const r = await calcEngine.compute({
    entId, year, method: b.method || 'CALC',
    factorVersion: b.factorVersion, onlyReviewed: b.onlyReviewed === true,
  });
  if (!r.ok) {
    return res.status(409).json({ code: 409, message: r.reason, detail: r.detail || null, gaps: r.gaps || null, hint: r.hint || null });
  }

  const saved = await calcEngine.persist(r, {
    operator: req.user.username, confirm: b.confirm === true,
  });

  /* 把不确定度写回批次（首次落库时 u_rel 等为空） */
  if (!saved.dedup && r.uncertainty) {
    await db.query(
      `UPDATE calc_batch SET u_rel = ?, u95_rel = ?, u_low = ?, u_high = ? WHERE batch_no = ?`,
      [r.uncertainty.ucRel, r.uncertainty.u95Rel,
        r.uncertainty.interval ? r.uncertainty.interval.low : null,
        r.uncertainty.interval ? r.uncertainty.interval.high : null,
        saved.batchNo]
    );
  }

  await writeLog(req, 'MRV_CALC',
    `核算 ent=${entId} ${year}：${r.total} tCO₂e（${r.complete ? '完整' : '有缺口'}，`
    + `${r.usableForCompliance ? '可履约' : '不可履约'}）批次 ${saved.batchNo}`);

  ok(res, {
    batchNo: saved.batchNo, batchId: saved.batchId, dedup: saved.dedup,
    detailRows: saved.detailRows,
    result: {
      total: r.total, scope1: r.scope1, scope2: r.scope2,
      complete: r.complete, gapCount: r.gapCount,
      qualityTier: r.quality.code, usableForCompliance: r.usableForCompliance,
      notUsableReason: r.notUsableReason,
      u95: r.uncertainty.u95, u95Rel: r.uncertainty.u95Rel,
      interval: r.uncertainty.interval,
      publishable: r.uncertainty.publishable,
    },
    digests: { input: r.inputDigest, result: r.resultDigest },
    note: saved.dedup ? saved.note : null,
  });
}));

/* 批次列表 */
router.get('/calc/batches', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  const entId = scopedEntId(req, req.query.entId);
  if (entId) { where.push('ent_id = ?'); params.push(entId); }
  if (req.query.year) { where.push('year = ?'); params.push(Number(req.query.year)); }
  if (req.query.usable === '1') where.push('usable_for_compliance = 1');
  if (req.query.complete === '1') where.push('is_complete = 1');

  const rows = await db.query(
    `SELECT b.*, e.ent_name FROM calc_batch b JOIN enterprise e ON e.id = b.ent_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.id DESC LIMIT 200`, params
  );
  ok(res, {
    count: rows.length,
    items: rows.map((r) => ({
      batchNo: r.batch_no, entId: Number(r.ent_id), entName: r.ent_name,
      year: Number(r.year), method: r.method, factorVersion: r.factor_version,
      industry: r.industry, region: r.region,
      scope1: Number(r.scope1), scope2: Number(r.scope2), total: Number(r.total_emission),
      intensity: r.intensity === null ? null : Number(r.intensity),
      complete: !!r.is_complete, gapCount: Number(r.gap_count),
      qualityTier: r.quality_tier, usableForCompliance: !!r.usable_for_compliance,
      u95Rel: r.u95_rel === null ? null : Number(r.u95_rel),
      status: r.status, createdAt: r.created_at,
    })),
  });
}));

/* 批次详情（含分源可核对明细） */
router.get('/calc/batch/:batchNo', authRequired, wrap(async (req, res) => {
  const b = await calcEngine.getBatch(req.params.batchNo);
  if (!b) return fail(res, '批次不存在', 404);
  /* 企业端只能看自己的 */
  if (req.user.role === 'ENTERPRISE' && b.entId !== Number(req.user.orgId)) {
    return fail(res, '无权查看其他企业的核算批次', 403);
  }
  ok(res, b);
}));

/* ⭐ 复算校验 —— 平台「可复算」主张的唯一证据 */
router.get('/calc/batch/:batchNo/verify', authRequired, wrap(async (req, res) => {
  const v = await calcEngine.verifyBatch(req.params.batchNo);
  ok(res, v);
}));

/* ==================================================================================
 * 三、因子台账
 * ================================================================================== */

/* 因子列表（公开，无需登录 —— 因子必须可被任何人复核） */
router.get('/factor', wrap(async (req, res) => {
  const where = ["status = 'ACTIVE'"];
  const params = [];
  if (req.query.category) { where.push('category = ?'); params.push(String(req.query.category).toUpperCase()); }
  if (req.query.code) { where.push('code = ?'); params.push(String(req.query.code).toUpperCase()); }
  if (req.query.region) { where.push('(region = ? OR region IS NULL)'); params.push(String(req.query.region)); }
  if (req.query.version) { where.push('version = ?'); params.push(String(req.query.version)); }

  const rows = await db.query(
    `SELECT * FROM factor_entry WHERE ${where.join(' AND ')} ORDER BY category, code, region`, params
  );

  ok(res, {
    count: rows.length,
    items: rows.map((r) => ({
      code: r.code, nameCn: r.name_cn, category: r.category, scope: Number(r.scope),
      ef: Number(r.ef_value), efUnit: r.ef_unit,
      derivation: r.ncv === null ? null : {
        ncv: Number(r.ncv), ncvUnit: r.ncv_unit,
        cc: Number(r.cc), of: Number(r.of_rate),
        formula: 'EF = NCV/1000 × CC × OF × 44/12',
        recomputed: Number(methodology.computeEf(Number(r.ncv), Number(r.cc), Number(r.of_rate)).toFixed(6)),
        diff: Number(r.recompute_diff),
        ok: !!r.recompute_ok,
      },
      source: r.source_doc, sourceYear: r.source_year,
      industry: r.industry, region: r.region,
      version: r.version, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
      remark: r.remark,
    })),
    methodology: {
      standards: [
        'GB/T 32150-2015 工业企业温室气体排放核算和报告通则',
        '《中国发电企业温室气体排放核算方法与报告指南（试行）》',
        '《省级温室气体清单编制指南（试行）》',
        'HJ 75-2017 / HJ 76-2017 固定污染源烟气 CEMS 技术要求',
        'HJ 212-2017 污染物在线监控（监测）系统数据传输标准',
        'ISO 14064-1:2018 组织层级温室气体量化与报告',
        'GUM (JCGM 100:2008) 测量不确定度表示指南',
        'JCGM 101:2008 GUM 增补 1：蒙特卡洛法',
      ],
      formulas: {
        calc: 'E = Σ(ADᵢ × EFᵢ)，EF = NCV/1000 × CC × OF × 44/12',
        cems: 'E = Σ(Q_标干 × C_基准氧 × Δt × 10⁻⁹)',
        consistency: '|ΔE| / max(E_calc, E_cems) ≤ 15%（HJ 75 相对准确度量级）',
      },
    },
  });
}));

/* 方法学自检（公开）—— 任何人可验证因子复算是否正确 */
router.get('/factor/selftest', wrap(async (req, res) => {
  ok(res, methodology.selfTest());
}));

/* 区域电网因子 */
router.get('/factor/regions', wrap(async (req, res) => {
  ok(res, { items: methodology.listRegions() });
}));

/* ==================================================================================
 * 四、数据质量
 * ================================================================================== */

/* 数据质量看板：这是「成熟程度」与「科学性」的直接证据 */
router.get('/quality', authRequired, wrap(async (req, res) => {
  const entId = scopedEntId(req, req.query.entId);
  const year = Number(req.query.year) || new Date().getFullYear();

  const where = ['year = ?'];
  const params = [year];
  if (entId) { where.push('ent_id = ?'); params.push(entId); }

  const rows = await db.query(
    `SELECT data_origin, status, COUNT(*) n, SUM(quantity) qty
       FROM activity_data WHERE ${where.join(' AND ')}
      GROUP BY data_origin, status`, params
  );

  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  const byOrigin = { L3: 0, L2: 0, L1: 0, L0: 0 };
  const byStatus = {};
  for (const r of rows) {
    if (byOrigin[r.data_origin] !== undefined) byOrigin[r.data_origin] += Number(r.n);
    byStatus[r.status] = (byStatus[r.status] || 0) + Number(r.n);
  }

  /* 缺口分析：哪些企业/排放源缺月 */
  const gaps = await db.query(
    `SELECT ent_id, source_code, COUNT(DISTINCT month) months
       FROM activity_data WHERE ${where.join(' AND ')} AND status IN ('SUBMITTED','REVIEWED')
      GROUP BY ent_id, source_code HAVING months < 12
      ORDER BY months LIMIT 50`, params
  );

  ok(res, {
    year, entId: entId || 'ALL',
    totalRecords: total,
    byOrigin, byStatus,
    originPct: Object.fromEntries(Object.entries(byOrigin)
      .map(([k, v]) => [k, total ? Number((v / total * 100).toFixed(2)) : 0])),
    gaps: gaps.map((g) => ({
      entId: Number(g.ent_id), sourceCode: g.source_code, months: Number(g.months),
      missing: 12 - Number(g.months),
    })),
    guidance: {
      L3: '实测（计量器具+检定）：可直接用于履约',
      L2: '台账（原始凭证）：可直接用于履约',
      L1: '估算：需补录原始凭证，否则不计入履约',
      L0: '缺省值：占比超 1% 即整年不可用于履约',
    },
  });
}));

/* 不确定度自检（公开）—— 任何人可验证 GUM / MC / 闸门实现 */
router.get('/quality/uq-selftest', wrap(async (req, res) => {
  ok(res, uq.selfTest());
}));

module.exports = router;
