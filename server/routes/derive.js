/**
 * routes/derive.js —— 派生业务数据的血缘查询接口
 * ==================================================================
 * 只读。三组能力：
 *   · 按业务对象查血缘（"这张上报单是怎么算出来的"）
 *   · 按企业查整个派生链（"这家企业的数据从 CEMS 到配额走过了什么"）
 *   · CEMS 覆盖口径（"这个排口的数据代表全厂吗"）
 *
 * 设计要点：每条血缘都返回 layer / confidence / limitation 三件套。
 * limitation 尤其重要 —— 它回答"这条值不能证明什么"，
 * 是防止派生值被当作实测值对外主张的最后一道说明。
 */
'use strict';

const express = require('express');
const db = require('../db');
const { authRequired, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();

const parseDetail = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
};

const shape = (r) => ({
  id: Number(r.id),
  targetTable: r.target_table,
  targetId: Number(r.target_id),
  targetLabel: r.target_label,
  source: { kind: r.source_kind, ref: r.source_ref, detail: parseDetail(r.source_detail) },
  rule: { code: r.rule_code, expr: r.rule_expr },
  layer: r.layer,
  confidence: r.confidence,
  limitation: r.limitation,
  reviewHint: r.review_hint,
  chainTxId: r.chain_tx_id,
  createdAt: r.created_at,
});

/* ==================================================================
 * 单条业务对象的血缘
 * GET /api/derive/trace?table=emission_report&id=372
 * ================================================================== */
router.get('/trace', authRequired, wrap(async (req, res) => {
  const table = String(req.query.table || '').trim();
  const id = Number(req.query.id);
  if (!table || !Number.isInteger(id) || id <= 0) {
    return fail(res, '需要 table（表名）与 id（主键，正整数）', 400);
  }
  const allow = ['emission_report', 'quota_allocation', 'quota_surrender', 'verify_report'];
  if (!allow.includes(table)) {
    return fail(res, `table 只支持：${allow.join(' / ')}`, 400);
  }
  const rows = await db.query(
    `SELECT * FROM derivation_log WHERE target_table = ? AND target_id = ? ORDER BY id`,
    [table, id]
  );
  if (!rows.length) {
    return ok(res, { targetTable: table, targetId: id, records: [], note: '该对象没有派生血缘记录' });
  }
  ok(res, { targetTable: table, targetId: id, records: rows.map(shape) });
}));

/* ==================================================================
 * 单张上报单的完整解释：排放量 + 污染物 + 血缘 + 链上证据
 * GET /api/derive/report/:id
 * ================================================================== */
router.get('/report/:id', authRequired, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.one(
    `SELECT r.*, e.ent_name, e.ent_code FROM emission_report r
       JOIN enterprise e ON e.id = r.ent_id WHERE r.id = ?`, [id]
  );
  if (!r) return fail(res, '上报单不存在', 404);

  const rows = await db.query(
    "SELECT * FROM derivation_log WHERE target_table='emission_report' AND target_id=? ORDER BY id", [id]
  );
  const items = await db.query(
    'SELECT energy_type, amount, unit, calc_method FROM emission_item WHERE report_id=? ORDER BY id', [id]
  );
  const verified = await db.one(
    `SELECT vr.report_no, vr.verified_value, vr.deviation_rate, vr.conclusion,
            vr.chain_block_index, vr.approved_by, u.real_name AS approver
       FROM verify_report vr LEFT JOIN sys_user u ON u.id = vr.approved_by
      WHERE vr.emission_report_id = ? LIMIT 1`, [id]
  );

  ok(res, {
    report: {
      id: Number(r.id), reportNo: r.report_no, entId: Number(r.ent_id), entName: r.ent_name,
      period: r.period, year: r.year, quarter: Number(r.quarter),
      totalEmission: Number(r.total_emission), dataSource: r.data_source,
      status: r.status, isReal: Number(r.is_real),
      chainBlockIndex: r.chain_block_index, chainTxId: r.chain_tx_id,
      submitTime: r.submit_time, verifyTime: r.verify_time,
    },
    /* 这一项是整页最关键的判断依据：CO₂ 不是 CEMS 测出来的 */
    co2Provenance: {
      cemsMeasuresCO2: false,
      explanation: 'GB 18485 焚烧 CEMS 监测烟尘/SO₂/NOx/CO/HCl 五项，不含 CO₂。'
        + '本单 CO₂ = 官方年度活动水平法核算值 × 当季实测烟气量占比。'
        + '年度总量可辩护；季度分配是分配假设。',
      annualTotalDefensible: true,
      quarterlySplitIsAssumption: true,
    },
    pollutantItems: items.map((i) => ({
      name: i.energy_type, amount: Number(i.amount), unit: i.unit, method: i.calc_method,
    })),
    lineage: rows.map(shape),
    verification: verified ? {
      reportNo: verified.report_no, verifiedValue: Number(verified.verified_value),
      deviationRate: Number(verified.deviation_rate), conclusion: verified.conclusion,
      chainBlockIndex: verified.chain_block_index,
      approvedBy: verified.approver || null,
    } : null,
  });
}));

/* ==================================================================
 * 企业派生链总览
 * GET /api/derive/enterprise/:entId?year=2024
 * ================================================================== */
router.get('/enterprise/:entId', authRequired, wrap(async (req, res) => {
  const entId = Number(req.params.entId);
  const year = Number(req.query.year) || null;
  const ent = await db.one('SELECT id, ent_name, ent_code, industry, region FROM enterprise WHERE id=?', [entId]);
  if (!ent) return fail(res, '企业不存在', 404);

  const yrWhere = year ? 'AND r.year = ?' : '';
  const yrParams = year ? [year] : [];

  const reports = await db.query(
    `SELECT r.id, r.report_no, r.period, r.year, r.quarter, r.total_emission, r.status,
            r.chain_block_index, r.chain_tx_id,
            (SELECT COUNT(*) FROM derivation_log d
              WHERE d.target_table='emission_report' AND d.target_id=r.id) AS lineageCount
       FROM emission_report r WHERE r.ent_id = ? ${yrWhere}
      ORDER BY r.year, r.quarter`, [entId, ...yrParams]
  );

  const allocs = await db.query(
    `SELECT a.id, a.alloc_no, a.year, a.quota_amount, a.alloc_method, a.baseline_intensity,
            a.chain_block_index,
            (SELECT COUNT(*) FROM derivation_log d
              WHERE d.target_table='quota_allocation' AND d.target_id=a.id) AS lineageCount
       FROM quota_allocation a WHERE a.ent_id = ? ${year ? 'AND a.year = ?' : ''}
      ORDER BY a.year`, [entId, ...yrParams]
  );

  const surrenders = await db.query(
    `SELECT id, surrender_no, year, required_quota, surrendered_quota, shortfall, status,
            penalty, chain_block_index
       FROM quota_surrender WHERE ent_id = ? ${year ? 'AND year = ?' : ''}
      ORDER BY year`, [entId, ...yrParams]
  );

  const coverage = await db.query(
    `SELECT year, outlet_name, valid_hours, expected_hours, flue_gas_10k_m3,
            official_msw_10kt, gas_per_ton_m3, coverage_ratio, coverage_basis, note
       FROM cems_coverage WHERE ent_id = ? ${year ? 'AND year = ?' : ''}
      ORDER BY year, outlet_name`, [entId, ...yrParams]
  );

  const quotes = await db.query(
    /* cems_cn_hourly 没有 year 列 —— 年度由 monitored_at 派生。
     * 必须写 YEAR(monitored_at) AS yr 并在 GROUP BY 里复用同一表达式，
     * 直接 SELECT year 会报 Unknown column。 */
    `SELECT YEAR(monitored_at) AS yr,
            SUM(so2_emission_kg) so2, SUM(nox_emission_kg) nox, SUM(pm_emission_kg) pm,
            SUM(co_emission_kg) co, SUM(hcl_emission_kg) hcl, SUM(flue_gas_m3) gas,
            SUM(is_valid) validHours, COUNT(*) hours
       FROM cems_cn_hourly
      WHERE ent_name LIKE ? ${year ? 'AND YEAR(monitored_at) = ?' : ''}
      GROUP BY YEAR(monitored_at) ORDER BY YEAR(monitored_at)`,
    [`${String(ent.ent_name).replace(/有限(责任)?公司$/, '').slice(0, 10)}%`, ...yrParams]
  );

  ok(res, {
    enterprise: { id: Number(ent.id), name: ent.ent_name, code: ent.ent_code,
      industry: ent.industry, region: ent.region },
    year,
    cemsRaw: quotes.map((q) => ({
      year: Number(q.yr || (year || 0)),
      validHours: Number(q.validHours), totalHours: Number(q.hours),
      flueGasM3: Number(Number(q.gas || 0).toFixed(1)),
      pollutants: {
        so2Kg: Number(Number(q.so2 || 0).toFixed(3)),
        noxKg: Number(Number(q.nox || 0).toFixed(3)),
        pmKg: Number(Number(q.pm || 0).toFixed(3)),
        coKg: Number(Number(q.co || 0).toFixed(3)),
        hclKg: Number(Number(q.hcl || 0).toFixed(3)),
      },
      note: 'CEMS 原生字段，未经平台换算',
    })),
    coverage: coverage.map((c) => ({
      year: Number(c.year), outlet: c.outlet_name,
      validHours: Number(c.valid_hours), expectedHours: Number(c.expected_hours),
      flueGas10kM3: c.flue_gas_10k_m3 === null ? null : Number(c.flue_gas_10k_m3),
      officialMsw10kt: c.official_msw_10kt === null ? null : Number(c.official_msw_10kt),
      gasPerTonM3: c.gas_per_ton_m3 === null ? null : Number(c.gas_per_ton_m3),
      coverageRatio: c.coverage_ratio === null ? null : Number(c.coverage_ratio),
      basis: c.coverage_basis, note: c.note,
    })),
    reports: reports.map((r) => ({
      id: Number(r.id), reportNo: r.report_no, period: r.period,
      year: r.year, quarter: Number(r.quarter), totalEmission: Number(r.total_emission),
      status: r.status, chainBlockIndex: r.chain_block_index,
      lineageCount: Number(r.lineageCount),
    })),
    allocations: allocs.map((a) => ({
      id: Number(a.id), allocNo: a.alloc_no, year: a.year,
      quota: Number(a.quota_amount), method: a.alloc_method,
      baselineIntensity: a.baseline_intensity === null ? null : Number(a.baseline_intensity),
      chainBlockIndex: a.chain_block_index, lineageCount: Number(a.lineageCount),
    })),
    surrenders: surrenders.map((s) => ({
      id: Number(s.id), surrenderNo: s.surrender_no, year: s.year,
      required: Number(s.required_quota), surrendered: Number(s.surrendered_quota),
      shortfall: Number(s.shortfall), penalty: Number(s.penalty || 0),
      status: s.status, chainBlockIndex: s.chain_block_index,
    })),
  });
}));

/* ==================================================================
 * CEMS 覆盖口径（单排口 vs 全厂）
 * GET /api/derive/coverage?entId=&year=
 * ================================================================== */
router.get('/coverage', authRequired, wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.entId) { where.push('c.ent_id = ?'); params.push(Number(req.query.entId)); }
  if (req.query.year) { where.push('c.year = ?'); params.push(Number(req.query.year)); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db.query(
    `SELECT c.*, e.ent_name FROM cems_coverage c
       JOIN enterprise e ON e.id = c.ent_id ${w}
      ORDER BY c.ent_id, c.year`, params
  );
  const typical = { min: 4000, max: 6000 };
  ok(res, {
    typicalGasPerTon: typical,
    typingNote: '每吨生活垃圾烟气量行业典型区间 4000–6000 m³/t。'
      + '低于该区间说明 CEMS 只覆盖单个排口，而官方处理量是全厂口径，两者不可直接相比。',
    rows: rows.map((r) => ({
      entId: Number(r.ent_id), entName: r.ent_name, year: Number(r.year), outlet: r.outlet_name,
      validHours: Number(r.valid_hours), expectedHours: Number(r.expected_hours),
      coverage: Number((Number(r.valid_hours) / Math.max(Number(r.expected_hours), 1) * 100).toFixed(2)),
      flueGas10kM3: r.flue_gas_10k_m3 === null ? null : Number(r.flue_gas_10k_m3),
      officialMsw10kt: r.official_msw_10kt === null ? null : Number(r.official_msw_10kt),
      gasPerTonM3: r.gas_per_ton_m3 === null ? null : Number(r.gas_per_ton_m3),
      coverageRatio: r.coverage_ratio === null ? null : Number(r.coverage_ratio),
      verdict: r.coverage_ratio === null
        ? '未知（无官方处理量可比对，不假设为 100%）'
        : (Number(r.gas_per_ton_m3) < typical.min ? '单排口（不代表全厂）' : '量级相当'),
      basis: r.coverage_basis, note: r.note,
    })),
  });
}));

/* ==================================================================
 * 平台级派生汇总（给监管端/演示落地页用）
 * GET /api/derive/summary
 * ================================================================== */
router.get('/summary', authRequired, wrap(async (req, res) => {
  const lin = await db.query(
    'SELECT layer, confidence, COUNT(*) n FROM derivation_log GROUP BY layer, confidence'
  );
  const byRule = await db.query(
    'SELECT rule_code, COUNT(*) n, MIN(created_at) firstAt FROM derivation_log GROUP BY rule_code'
  );
  const repRows = await db.query(
    `SELECT COUNT(*) n, SUM(total_emission) s, MIN(year) y0, MAX(year) y1,
            COUNT(DISTINCT ent_id) ents
       FROM emission_report WHERE data_source='DERIVED_FROM_CEMS'`
  );
  const rep = repRows[0] || {};
  const cems = await db.query(
    `SELECT COUNT(*) hours, COUNT(DISTINCT ent_name) ents, COUNT(DISTINCT batch_no) batches,
            COUNT(DISTINCT chain_tx_id) txs, MIN(monitored_at) d0, MAX(monitored_at) d1
       FROM cems_cn_hourly WHERE is_valid = 1`
  );
  const trading = await db.query(
    'SELECT COUNT(*) deals, SUM(amount) volume, SUM(total_amount) turnover FROM trade_deal'
  );
  ok(res, {
    cemsInput: {
      validHours: Number(cems[0].hours), enterprises: Number(cems[0].ents),
      batches: Number(cems[0].batches), anchoredBatches: Number(cems[0].txs),
      periodFrom: cems[0].d0, periodTo: cems[0].d1,
      note: '真实 CEMS 小时实测数据（河北省污染源自动监控信息公开系统）',
    },
    derivedReports: Number(rep.n || 0) > 0 ? {
      count: Number(rep.n), totalTco2: Number(Number(rep.s || 0).toFixed(2)),
      years: [Number(rep.y0), Number(rep.y1)],
      enterprises: Number(rep.ents),
    } : { count: 0 },
    lineage: {
      total: lin.reduce((s, x) => s + Number(x.n), 0),
      byLayer: lin.map((x) => ({ layer: x.layer, confidence: x.confidence, count: Number(x.n) })),
      byRule: byRule.map((x) => ({ rule: x.rule_code, count: Number(x.n), firstAt: x.firstAt })),
    },
    trading: trading.length ? {
      deals: Number(trading[0].deals || 0),
      volume: Number(Number(trading[0].volume || 0).toFixed(2)),
      turnover: Number(Number(trading[0].turnover || 0).toFixed(2)),
    } : { deals: 0 },
    capabilityBoundary: {
      measuresCO2: false,
      measured: 'SO₂ / NOx / 颗粒物 / CO / HCl 排放量（kg），小时级，排口原生字段',
      derived: 'CO₂ 年度总量（官方活动水平 × 因子）与季度分配（按实测烟气量占比）',
      notClaimed: '不主张 CEMS 可直接读出 CO₂；不主张单排口数据等于全厂排放',
    },
  });
}));

module.exports = router;
