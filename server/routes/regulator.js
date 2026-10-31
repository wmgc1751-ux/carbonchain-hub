/**
 * routes/regulator.js —— 监管端 API
 * 驾驶舱 / 企业名录 / 配额分配 / 交易监管 / 预警处置 / 统计分析 / 操作审计
 */
'use strict';

const express = require('express');
const db = require('../db');
const timefmt = require('../utils/time');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();
/* P1 权限收缩反转（2026-10-29）：
 * 监管路由拆成两类——只读的运维/台账/证据链 ADMIN 也应可查（运维职责），
 * 但业务决策（配额分配、预警处置、公告发布）仅限 REGULATOR。
 * 因此 router 级放开 ADMIN，三个写接口各自加 REGULATOR 守卫。 */
router.use(authRequired, requireRole('REGULATOR', 'ADMIN'));

/* 业务年度 ------------------------------------------------------------------
 * 原实现取 `new Date().getFullYear()`，即系统时钟的当年（2026）。但平台内的
 * 业务数据分布在 2024 / 2025 —— 于是监管驾驶舱"2026 年度排放总量 0"、
 * 控排企业名录"本年度排放全 0、配额全 -"、配额分配管理"暂无数据"，
 * 三个核心页面首屏同时为空，看起来像整站坏了（2026-10-29 巡检 P0-2/3/3b）。
 *
 * 改为「库内最新有数据的年度」：只在首次使用时解析一次并缓存。
 * 显式传 ?year= 的请求仍以传入值为准，不受影响。 */
let YEAR = new Date().getFullYear();
let yearReady = false;
async function ensureYear() {
  if (yearReady) return YEAR;
  yearReady = true;
  try {
    const row = await db.one(
      `SELECT MAX(y) AS y FROM (
         SELECT year AS y FROM emission_report WHERE status <> 'DRAFT'
         UNION ALL SELECT year AS y FROM carbon_quota
       ) t`
    );
    if (row && Number(row.y) > 0) YEAR = Number(row.y);
  } catch (e) { /* 解析失败沿用当前年，不影响主流程 */ }
  return YEAR;
}

/* ==================================================================
 * 监管驾驶舱
 * ================================================================== */
router.get('/overview', wrap(async (req, res) => {
  await ensureYear();
  /* 年度切换：显式 ?year= 优先，缺省用业务年度（库内最新有数据的年份）。
   * 巡检原话「页面无年度切换，2025 的数看不到」——监管驾驶舱至少要能回看
   * 上一个完整年度，否则趋势图与首屏 KPI 对不上时无从核对。 */
  const Y = Number(req.query.year) > 0 ? Number(req.query.year) : YEAR;
  /* 可选年度清单：从有上报或配额记录的年份里取，前端下拉直接渲染。 */
  const yearRows = await db.query(
    `SELECT y FROM (
       SELECT year AS y FROM emission_report WHERE status <> 'DRAFT'
       UNION SELECT year AS y FROM carbon_quota
     ) t ORDER BY y DESC`
  );
  /* entCount（纳入监管的企业数）必须排除已注销主体。
   *
   * 原来写的是 `COUNT(*) FROM enterprise` —— 只要表里有行就算在监管范围内。
   * 于是任何被停用/注销的企业（包括测试期注册后关闭的账号）都仍被计入
   * "控排企业 XX 家"，而 activeEnt 又只数 ACTIVE，两个数字打了架：
   * 页面显示"62 家控排企业 / 56 家正常"，读者无从判断差的那 6 家算什么。
   *
   * 正确口径：
   *   · entCount  —— 仍在监管名册内的主体（ACTIVE / WATCH / SUSPENDED）；
   *   · activeEnt —— 其中当前正常履约的（仅 ACTIVE）。
   * CLOSED 是"已注销/已退出"，不属于在册主体，两个数都不计入。 */
  const entCount = Number(await db.value(
    "SELECT COUNT(*) FROM enterprise WHERE status IN ('ACTIVE','WATCH','SUSPENDED')"
  ) || 0);
  const activeEnt = Number(await db.value("SELECT COUNT(*) FROM enterprise WHERE status='ACTIVE'") || 0);

  const emission = await db.one(
    `SELECT IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(intensity),0) AS intensity,
            COUNT(*) AS reports, SUM(status='VERIFIED') AS verified
     FROM emission_report WHERE year = ? AND status <> 'DRAFT'`, [Y]
  );

  const quotaStat = await db.one(
    `SELECT IFNULL(SUM(total_allocated),0) AS allocated, IFNULL(SUM(used),0) AS used,
            IFNULL(SUM(available),0) AS available,
            SUM(available < 0) AS gapCount
     FROM carbon_quota WHERE year = ?`, [Y]
  );

  const openAlerts = await db.one(
    `SELECT COUNT(*) AS total, SUM(status='OPEN') AS open, SUM(level='HIGH') AS high FROM alert_record`
  );

  // 链上存证总数（核算结果上链的存证笔数）
  const chainAnchors = Number(await db.ledgerValue('SELECT COUNT(*) FROM chain_tx') || 0);

  const trend = await db.query(
    `SELECT period, IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(intensity),0) AS intensity,
            COUNT(*) AS reports
     FROM emission_report WHERE status <> 'DRAFT' GROUP BY period ORDER BY period`
  );

  const byIndustry = await db.query(
    `SELECT e.industry AS name, IFNULL(SUM(r.total_emission),0) AS value, COUNT(DISTINCT e.id) AS ents
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.industry ORDER BY value DESC`, [Y]
  );

  const byRegion = await db.query(
    `SELECT e.region AS name, IFNULL(SUM(r.total_emission),0) AS value
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.region ORDER BY value DESC LIMIT 12`, [Y]
  );

  const topEnt = await db.query(
    `SELECT e.id, e.ent_name AS name, e.industry, IFNULL(SUM(r.total_emission),0) AS value,
            IFNULL(AVG(r.intensity),0) AS intensity
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.id ORDER BY value DESC LIMIT 10`, [Y]
  );

  const gapEnt = await db.query(
    `SELECT e.id, e.ent_name AS name, e.industry, q.total_allocated, q.used, q.available,
            (q.available) AS gap
     FROM carbon_quota q JOIN enterprise e ON e.id = q.ent_id
     WHERE q.year = ? ORDER BY q.available ASC LIMIT 10`, [Y]
  );

  const verifyProgress = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM emission_report WHERE year = ? GROUP BY status`, [Y]
  );
  const vp = {};
  verifyProgress.forEach((v) => { vp[v.status] = Number(v.cnt); });

  const recentAlerts = await db.query(
    `SELECT a.alert_no, a.alert_type, a.level, a.title, a.status, a.created_at, e.ent_name
     FROM alert_record a LEFT JOIN enterprise e ON e.id = a.ent_id
     ORDER BY a.created_at DESC LIMIT 8`
  );

  /* 报告期完整性判定 —— 趋势图不能把"只报了 1 家的季度"当成真实低谷。
   * 2026Q3/Q4 各只有 1 份上报单，若照常入图，曲线会从 450 万直坠到 2 千，
   * 看起来像排放量断崖式下降（2026-10-29 巡检 P2-38「缺失点直接垂直下落」）。
   * 做法：上报单数不足中位数一半的视为**未完整披露**，数值置 null，
   * 折线在此断开并在提示里点名，而不是画一条假的深谷。 */
  const trendRows = trend.map((t) => ({
    period: t.period, total: Number(t.total), intensity: Number(t.intensity), reports: Number(t.reports),
  }));
  const sortedCounts = trendRows.map((r) => r.reports).sort((a, b) => a - b);
  const medianReports = sortedCounts.length ? sortedCounts[Math.floor(sortedCounts.length / 2)] : 0;
  const minReports = Math.max(3, Math.ceil(medianReports * 0.5));
  const trendPoints = trendRows.map((r) => (r.reports < minReports
    ? { ...r, total: null, intensity: null, partial: true }
    : { ...r, partial: false }));
  const partialPeriods = trendPoints.filter((p) => p.partial).map((p) => p.period);
  const trendNote = partialPeriods.length
    ? `已剔除未完整披露的报告期：${partialPeriods.join('、')}（上报单数少于 ${minReports} 份，非真实低谷）`
    : '';

  ok(res, {
    /* 业务年度回传：前端标题/KPI 不再写死系统时钟的当年 */
    reportYear: Y,
    years: yearRows.map((r) => Number(r.y)).filter((n) => n > 0),
    kpi: {
      entCount, activeEnt,
      emissionYtd: Number(Number(emission.total).toFixed(0)),
      avgIntensity: Number(Number(emission.intensity).toFixed(4)),
      reports: Number(emission.reports),
      verified: Number(emission.verified || 0),
      quotaAllocated: Number(Number(quotaStat.allocated).toFixed(0)),
      quotaUsed: Number(Number(quotaStat.used).toFixed(0)),
      quotaAvailable: Number(Number(quotaStat.available).toFixed(0)),
      gapCount: Number(quotaStat.gapCount || 0),
      chainAnchors,
      alertTotal: Number(openAlerts.total),
      alertOpen: Number(openAlerts.open || 0),
      alertHigh: Number(openAlerts.high || 0),
    },
    trend: trendPoints,
    trendNote: trendNote,
    byIndustry: byIndustry.map((i) => ({ ...i, value: Number(i.value) })),
    byRegion: byRegion.map((i) => ({ ...i, value: Number(i.value) })),
    topEnt: topEnt.map((t) => ({ ...t, value: Number(t.value), intensity: Number(t.intensity) })),
    gapEnt: gapEnt.map((g) => ({
      ...g, total_allocated: Number(g.total_allocated), used: Number(g.used), available: Number(g.available),
    })),
    verifyProgress: vp,
    recentAlerts,
  });
}));

/* ==================================================================
 * 企业名录
 * ================================================================== */
router.get('/enterprises', wrap(async (req, res) => {
  await ensureYear();
  const { keyword, industry, region, status, scale } = req.query;
  const where = ['1=1'];
  const params = [];
  if (keyword) { where.push('(e.ent_name LIKE ? OR e.ent_code LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  if (industry) { where.push('e.industry = ?'); params.push(industry); }
  if (region) { where.push('e.region = ?'); params.push(region); }
  if (status) { where.push('e.status = ?'); params.push(status); }
  else {
    /* 未显式筛选状态时，默认只看"在册主体"（ACTIVE / WATCH / SUSPENDED）。
     * CLOSED 是已注销 —— 它仍在库里是为了保留历史链路可追溯，
     * 但不应该出现在监管名册里冒充"在管企业"。
     * 需要查已注销主体时显式传 ?status=CLOSED。 */
    where.push("e.status IN ('ACTIVE','WATCH','SUSPENDED')");
  }
  if (scale) { where.push('e.scale = ?'); params.push(scale); }

  const page = await db.paginate(
    /* ⚠ 这里原本是 e.*，把 contact_phone / legal_person / wallet_address 等
       一并非列表所需的信息整包发给前端。列表只需要下面这 8 个字段，
       详情页由 /regulator/enterprises/:id 单独取。
       最小必要原则：列表接口不返回联系方式（姓名+手机号属个人敏感信息）。 */
    `SELECT e.id, e.ent_name, e.ent_code, e.industry, e.region, e.scale, e.status, e.credit_score,
            q.total_allocated, q.available, q.used,
            (SELECT IFNULL(SUM(total_emission),0) FROM emission_report r WHERE r.ent_id = e.id AND r.year = ${YEAR} AND r.status <> 'DRAFT') AS emission_ytd,
            (SELECT COUNT(*) FROM emission_report r WHERE r.ent_id = e.id AND r.status = 'VERIFIED') AS verified_reports,
            0 AS chain_txs
     FROM enterprise e
     LEFT JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ${YEAR}
     WHERE ${where.join(' AND ')} ORDER BY emission_ytd DESC, e.id`,
    params, req.query
  );
  /* chain_txs 原先是本查询里的关联子查询 —— 账本库独立成实例后该子查询跨实例失效。
   * 改为：按本页企业 id 另取一次钱包地址（业务库），再向账本库批量计一次数。
   * 钱包地址属于「为完成本次关联而临时取用」的字段，回填后即从响应里删除，
   * 保持上面「列表接口不下发钱包地址/联系方式」的最小必要原则不变。 */
  const ids = page.rows.map((r) => r.id);
  if (ids.length) {
    const addrRows = await db.query(
      `SELECT id, wallet_address FROM enterprise WHERE id IN (${ids.map(() => '?').join(',')})`, ids
    );
    const addrOf = new Map(addrRows.map((a) => [a.id, a.wallet_address]));
    const addrs = addrRows.map((a) => a.wallet_address).filter(Boolean);
    let cntOf = new Map();
    if (addrs.length) {
      const cnts = await db.ledgerQuery(
        `SELECT from_address AS address, COUNT(*) AS cnt FROM chain_tx
          WHERE from_address IN (${addrs.map(() => '?').join(',')}) GROUP BY from_address`, addrs
      );
      cntOf = new Map(cnts.map((c) => [c.address, Number(c.cnt)]));
    }
    page.rows.forEach((r) => { r.chain_txs = cntOf.get(addrOf.get(r.id)) || 0; });
  }
  ok(res, page);
}));

router.get('/enterprises/filters', wrap(async (req, res) => {
  const industries = await db.query('SELECT DISTINCT industry AS v FROM enterprise ORDER BY industry');
  const regions = await db.query('SELECT DISTINCT region AS v FROM enterprise ORDER BY region');
  ok(res, { industries: industries.map((i) => i.v), regions: regions.map((r) => r.v) });
}));

router.get('/enterprises/:id', wrap(async (req, res) => {
  const e = await db.one('SELECT * FROM enterprise WHERE id = ?', [req.params.id]);
  if (!e) return fail(res, '企业不存在', 404);
  e.reports = await db.query(
    `SELECT r.id, r.report_no, r.period, r.total_emission, r.intensity, r.status, r.chain_block_index,
            v.org_name AS verifier_name
     FROM emission_report r LEFT JOIN verifier_org v ON v.id = r.verifier_id
     WHERE r.ent_id = ? ORDER BY r.year DESC, r.quarter DESC LIMIT 12`, [req.params.id]
  );
  e.quotas = await db.query('SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC', [req.params.id]);
  e.alerts = await db.query('SELECT * FROM alert_record WHERE ent_id = ? ORDER BY created_at DESC LIMIT 8', [req.params.id]);
  e.chainTxs = await db.ledgerQuery(
    `SELECT tx_id, tx_type, biz_no, block_index, payload_hash, status, created_at
     FROM chain_tx WHERE from_address = ? ORDER BY id DESC LIMIT 12`, [e.wallet_address]
  );
  /* UTC 字面量 → 本地时区 */
  e.chainTxs = e.chainTxs.map((t) => ({ ...t, created_at: timefmt.localFromUtcLiteral(t.created_at) }));
  e.mix = await db.query(
    `SELECT i.energy_type AS name, IFNULL(SUM(i.co2),0) AS value FROM emission_item i
     WHERE i.ent_id = ? GROUP BY i.energy_type ORDER BY value DESC`, [req.params.id]
  );
  ok(res, e);
}));

/* ==================================================================
 * 配额分配
 * ================================================================== */
router.get('/allocations', wrap(async (req, res) => {
  await ensureYear();
  const { year, keyword, type } = req.query;
  const where = ['1=1'];
  const params = [];
  if (year) { where.push('a.year = ?'); params.push(year); }
  if (type) { where.push('a.alloc_type = ?'); params.push(type); }
  if (keyword) { where.push('(a.alloc_no LIKE ? OR e.ent_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const page = await db.paginate(
    `SELECT a.*, e.ent_name, e.industry, e.region FROM quota_allocation a
     JOIN enterprise e ON e.id = a.ent_id
     WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC`, params, req.query
  );
  const sum = await db.one(
    `SELECT IFNULL(SUM(quota_amount),0) AS total, COUNT(*) AS cnt FROM quota_allocation WHERE year = ?`,
    [year || YEAR]
  );
  ok(res, { ...page, summary: { total: Number(sum.total), count: Number(sum.cnt) } });
}));

/** 下发配额（含上链存证） */
router.post('/allocations', requireRole('REGULATOR'), wrap(async (req, res) => {
  const { entId, year, amount, allocType, allocMethod, baseline } = req.body || {};
  if (!entId || !year || !(Number(amount) > 0)) return fail(res, '企业、年度、分配量均为必填', 400);

  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [entId]);
  if (!ent) return fail(res, '企业不存在', 404);

  const allocNo = cu.bizNo('QA');
  const type = allocType || 'FREE';
  const [ins] = await db.pool.query(
    `INSERT INTO quota_allocation (alloc_no, ent_id, year, quota_amount, alloc_type, alloc_method,
       baseline_intensity, operator, created_at)
     VALUES (?,?,?,?,?,?,?,?,NOW())`,
    [allocNo, entId, year, Number(amount), type, allocMethod || '历史强度法',
      baseline ? Number(baseline) : null, req.user.realName || 'regulator']
  );

  // 同步配额账户
  await db.query(
    `INSERT INTO carbon_quota (ent_id, year, total_allocated, available) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE total_allocated = total_allocated + VALUES(total_allocated),
                             available = available + VALUES(available)`,
    [entId, year, Number(amount), Number(amount)]
  );

  const chain = await anchorSvc.anchor({
    txType: 'QUOTA_ALLOC',
    bizNo: allocNo,
    fromLabel: 'regulator:system',
    toLabel: `ent:${entId}`,
    payload: {
      allocNo, entId, entName: ent.ent_name, year: Number(year), quotaAmount: Number(amount),
      allocType: type, allocMethod: allocMethod || '历史强度法', baseline: baseline ? Number(baseline) : null,
      operator: req.user.realName,
    },
  });
  await db.query('UPDATE quota_allocation SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
    [chain.blockIndex, chain.txId, ins.insertId]);

  await writeLog(req, '配额管理', '分配配额', allocNo,
    `向 ${ent.ent_name} 分配 ${amount} 吨（${type}），已上链 #${chain.blockIndex}`);
  ok(res, { allocId: ins.insertId, allocNo, chain }, `配额分配成功，已上链存证（区块 #${chain.blockIndex}）`);
}));

/* ==================================================================
 * 预警处置
 * ================================================================== */
router.get('/alerts', wrap(async (req, res) => {
  const { type, level, status, keyword } = req.query;
  const where = ['1=1'];
  const params = [];
  if (type) { where.push('a.alert_type = ?'); params.push(type); }
  if (level) { where.push('a.level = ?'); params.push(level); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (keyword) { where.push('(a.title LIKE ? OR e.ent_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const page = await db.paginate(
    `SELECT a.*, e.ent_name, e.industry, e.region FROM alert_record a
     LEFT JOIN enterprise e ON e.id = a.ent_id
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(a.status,'OPEN','HANDLING','CLOSED'), FIELD(a.level,'HIGH','MEDIUM','LOW'), a.created_at DESC`,
    params, req.query
  );
  const stat = await db.query('SELECT alert_type AS type, level, status, COUNT(*) AS cnt FROM alert_record GROUP BY alert_type, level, status');
  ok(res, { ...page, stat });
}));

router.post('/alerts/:id/handle', requireRole('REGULATOR'), wrap(async (req, res) => {
  const { status, note } = req.body || {};
  if (!['HANDLING', 'CLOSED'].includes(status)) return fail(res, '处理状态不合法', 400);
  const a = await db.one('SELECT * FROM alert_record WHERE id = ?', [req.params.id]);
  if (!a) return fail(res, '预警记录不存在', 404);
  await db.query(
    'UPDATE alert_record SET status = ?, handler = ?, handle_note = ?, closed_at = ? WHERE id = ?',
    [status, req.user.realName || 'regulator', note || null, status === 'CLOSED' ? new Date() : null, a.id]
  );
  await writeLog(req, '预警处置', status === 'CLOSED' ? '关闭预警' : '受理预警', a.alert_no, note || '');
  ok(res, null, status === 'CLOSED' ? '预警已关闭' : '预警已受理');
}));

/* ==================================================================
 * 统计分析
 * ================================================================== */
router.get('/statistics', wrap(async (req, res) => {
  await ensureYear();
  const year = Number(req.query.year) || YEAR;

  const industries = await db.query(
    `SELECT e.industry AS name, COUNT(DISTINCT e.id) AS ents, IFNULL(SUM(r.total_emission),0) AS emission,
            IFNULL(AVG(r.intensity),0) AS intensity
     FROM enterprise e LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY e.industry ORDER BY emission DESC`, [year]
  );

  const regions = await db.query(
    `SELECT e.region AS name, COUNT(DISTINCT e.id) AS ents, IFNULL(SUM(r.total_emission),0) AS emission,
            IFNULL(AVG(r.intensity),0) AS intensity
     FROM enterprise e LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY e.region ORDER BY emission DESC`, [year]
  );

  const scaleStat = await db.query(
    `SELECT e.scale AS name, COUNT(*) AS ents, IFNULL(SUM(r.total_emission),0) AS emission
     FROM enterprise e LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY e.scale`, [year]
  );

  const energyMix = await db.query(
    `SELECT i.energy_type AS name, IFNULL(SUM(i.co2),0) AS value, IFNULL(SUM(i.amount),0) AS amount
     FROM emission_item i JOIN emission_report r ON r.id = i.report_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY i.energy_type ORDER BY value DESC`, [year]
  );

  const reduction = await db.query(
    `SELECT period, IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(yoy_rate),0) AS yoy
     FROM emission_report WHERE status <> 'DRAFT' GROUP BY period ORDER BY period`
  );

  /* 注意：q.available / q.total_allocated 未参与聚合，若直接与 GROUP BY e.id 并用，
   * 在开启了 only_full_group_by 的库（TiDB 默认开启）上会报
   *   Expression #6 of SELECT list is not in GROUP BY clause ...
   * 本机 MySQL 某些版本默认关闭该模式，因此本地不报错、云端必报。
   * 这里统一用 MAX() 包一层：q 已按 (ent_id, year) 唯一，MAX() 不改变取值，
   * 但让语句满足严格模式，两端行为一致。 */
  const rank = await db.query(
    `SELECT e.ent_name AS name, e.industry, e.region,
            IFNULL(SUM(r.total_emission),0) AS emission, IFNULL(AVG(r.intensity),0) AS intensity,
            IFNULL(MAX(q.available),0) AS quota_available, IFNULL(MAX(q.total_allocated),0) AS quota_allocated
     FROM enterprise e
     LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     LEFT JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ?
     GROUP BY e.id, e.ent_name, e.industry, e.region
     ORDER BY emission DESC LIMIT 20`, [year, year]
  );

  const compliance = await db.one(
    `SELECT SUM(used <= total_allocated) AS meet,
            SUM(used > total_allocated) AS gap
     FROM carbon_quota WHERE year = ?`, [year]
  );

  ok(res, {
    /* 回传实际使用的业务年度：前端筛选器据此显示"正在看哪一年"，
     * 否则默认年度由后端决定、界面却还写着系统时钟的当年。 */
    reportYear: year,
    industries: industries.map((i) => ({ ...i, emission: Number(i.emission), intensity: Number(i.intensity) })),
    regions: regions.map((i) => ({ ...i, emission: Number(i.emission), intensity: Number(i.intensity) })),
    scaleStat: scaleStat.map((i) => ({ ...i, emission: Number(i.emission) })),
    energyMix: energyMix.map((i) => ({ ...i, value: Number(i.value), amount: Number(i.amount) })),
    reduction: reduction.map((i) => ({ period: i.period, total: Number(i.total), yoy: Number(i.yoy) })),
    rank: rank.map((i) => ({ ...i, emission: Number(i.emission), intensity: Number(i.intensity) })),
    compliance: { meet: Number(compliance.meet || 0), gap: Number(compliance.gap || 0) },
  });
}));

/* ==================================================================
 * 操作审计 + 系统概况
 * ================================================================== */

/* ==================================================================
 * 全链路证据链（P1）
 * ------------------------------------------------------------------
 * 监管事后追责要能回答：这家企业这一年的数据从哪来、谁核过、
 * 配额怎么分的、怎么交易的、有没有清缴。
 * 改造前这些记录分散在企业端/核查端/交易端，要分别查、人工拼。
 * 本接口按「企业+年度」一次返回完整链条，每个节点带链上交易ID与校验状态。
 * ================================================================== */
router.get('/evidence-chain', wrap(async (req, res) => {
  const entId = Number(req.query.entId);
  const year = Number(req.query.year) || new Date().getFullYear();
  if (!Number.isInteger(entId) || entId <= 0) return fail(res, '请指定 entId', 400);

  const ent = await db.one('SELECT id, ent_name, ent_code FROM enterprise WHERE id = ?', [entId]);
  if (!ent) return fail(res, '企业不存在', 404);

  const nodes = [];

  /* (1) 活动数据 */
  const acts = await db.query(
    'SELECT id, month, source_code, quantity, unit, data_origin, status, created_at FROM activity_data WHERE ent_id = ? AND year = ? ORDER BY month',
    [entId, year]
  );
  nodes.push({
    stage: '(1) 活动数据', count: acts.length,
    items: acts.map((a) => ({
      key: '活动数据 #' + a.id, time: a.created_at,
      detail: a.month + ' 月 · ' + a.source_code + ' · ' + a.quantity + ' ' + (a.unit || '') + '（来源 ' + a.data_origin + '）',
      chainTxId: null, status: a.status,
    })),
  });

  /* (2) 排放上报 */
  const reps = await db.query(
    'SELECT id, report_no, period, total_emission, status, submit_time, chain_tx_id FROM emission_report WHERE ent_id = ? AND year = ? ORDER BY quarter',
    [entId, year]
  );
  nodes.push({
    stage: '(2) 排放上报', count: reps.length,
    items: reps.map((r) => ({
      key: r.report_no, time: r.submit_time,
      detail: r.period + ' 上报 ' + r.total_emission + ' tCO2e',
      chainTxId: r.chain_tx_id, status: r.status,
    })),
  });

  /* (3) 核查结论（含双人复核签字位） */
  const vrs = await db.query(
    'SELECT vr.id, vr.report_no, vr.conclusion, vr.deviation_rate, vr.issue_time, ' +
    'vr.chain_tx_id, vr.approved_by, vr.submitted_by, s.real_name AS submitted_name, a.real_name AS approved_name ' +
    'FROM verify_report vr ' +
    'LEFT JOIN sys_user s ON s.id = vr.submitted_by ' +
    'LEFT JOIN sys_user a ON a.id = vr.approved_by ' +
    'LEFT JOIN emission_report er ON er.id = vr.emission_report_id ' +
    'WHERE vr.ent_id = ? AND er.year = ? ORDER BY vr.id',
    [entId, year]
  );
  nodes.push({
    stage: '(3) 核查结论', count: vrs.length,
    items: vrs.map((v) => ({
      key: v.report_no, time: v.issue_time,
      detail: '结论 ' + v.conclusion + '，偏差 ' + v.deviation_rate + '%'
        + (v.submitted_name ? ' · 经办 ' + v.submitted_name : '')
        + (v.approved_name ? ' / 复核 ' + v.approved_name : ' · 待复核'),
      chainTxId: v.chain_tx_id,
      status: v.approved_by ? '已复核生效' : '待复核',
      dualControl: !!(v.approved_by && v.submitted_by && v.approved_by !== v.submitted_by),
    })),
  });

  /* (4) 配额分配 */
  const allocs = await db.query(
    'SELECT id, alloc_no, quota_amount, alloc_type, created_at, chain_tx_id FROM quota_allocation WHERE ent_id = ? AND year = ? ORDER BY id',
    [entId, year]
  );
  nodes.push({
    stage: '(4) 配额分配', count: allocs.length,
    items: allocs.map((a) => ({
      key: a.alloc_no, time: a.created_at,
      detail: '分配 ' + a.quota_amount + ' t（' + a.alloc_type + '）',
      chainTxId: a.chain_tx_id, status: 'ALLOCATED',
    })),
  });

  /* (5) 挂牌与成交 */
  const orders = await db.query(
    'SELECT order_no, side, price, amount, status, created_at, biz_type FROM trade_order WHERE ent_id = ? AND YEAR(created_at) = ? ORDER BY id',
    [entId, year]
  );
  nodes.push({
    stage: '(5) 挂牌/成交', count: orders.length,
    items: orders.map((o) => ({
      key: o.order_no, time: o.created_at,
      detail: (o.side === 'BUY' ? '买入' : '卖出') + ' ' + o.amount + ' t @ ' + o.price + ' 元'
        + (o.biz_type === 'AGENCY' ? '（代理）' : '（自营）'),
      chainTxId: null, status: o.status,
    })),
  });

  /* (6) 清缴 */
  const surs = await db.query(
    'SELECT id, surrendered_quota, status, created_at, chain_tx_id, initiated_by, confirmed_by FROM quota_surrender WHERE ent_id = ? AND year = ? ORDER BY id',
    [entId, year]
  );
  nodes.push({
    stage: '(6) 配额清缴', count: surs.length,
    items: surs.map((s) => ({
      key: '清缴 #' + s.id, time: s.created_at,
      detail: '清缴 ' + s.surrendered_quota + ' t' + (s.confirmed_by ? '（已双人确认）' : ''),
      chainTxId: s.chain_tx_id, status: s.status,
    })),
  });

  const has = (n) => n.count > 0;
  const flat = nodes.flatMap((n) => n.items);
  ok(res, {
    enterprise: ent, year, nodes,
    integrity: {
      activityToReport: has(nodes[0]) && has(nodes[1]),
      reportToVerify: has(nodes[1]) && has(nodes[2]),
      verifyAllApproved: nodes[2].items.every((i) => i.status === '已复核生效'),
      hasAllocation: has(nodes[3]),
      hasTrade: has(nodes[4]),
      hasSurrender: has(nodes[5]),
      chainAnchored: flat.filter((i) => i.chainTxId).length,
      totalNodes: flat.length,
      completeness: nodes.filter(has).length + '/6 环节有记录',
    },
  });
}));

router.get('/logs', wrap(async (req, res) => {
  const { module: mod, role, keyword } = req.query;
  const where = ['1=1'];
  const params = [];
  if (mod) { where.push('module = ?'); params.push(mod); }
  if (role) { where.push('role = ?'); params.push(role); }
  if (keyword) { where.push('(username LIKE ? OR action LIKE ? OR target LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  const page = await db.paginate(
    `SELECT id, user_id, username, role, module, action, target, detail, ip, result,
            DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS created_at,
            prev_hash, entry_hash, (entry_hash IS NOT NULL) AS sealed
       FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`, params, req.query
  );
  ok(res, page);
}));

/* 诊断页结果缓存 10 s：55 表 UNION 计数 + 全链校验 + 审计链抽样校验，
   冷跑 3 s 量级；与 validateChainCached 同一哲学 —— 响应里带 computedAt，
   看的人能分辨"刚算过"与"这是 10 s 内的结论"。?fresh=1 跳过缓存。 */
const systemCache = { at: 0, payload: null };

router.get('/system', wrap(async (req, res) => {
  if (!req.query.fresh && systemCache.payload && Date.now() - systemCache.at < 10_000) {
    return ok(res, systemCache.payload);
  }
  const payload = await computeSystem();
  systemCache.at = Date.now(); systemCache.payload = payload;
  ok(res, payload);
}));

async function computeSystem() {
  // 动态枚举当前库的全部业务表（而非硬编码旧表清单），真实反映线上表数量，
  // 避免「新增表后自检页仍显示旧的 14 张」的误导。
  const allTables = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [require('../config').db.database]
  );
  // 优先展示核心业务表（有数据的），其余表补足
  const core = ['enterprise', 'verifier_org', 'sys_user', 'emission_report', 'emission_item',
    'verify_task', 'verify_report', 'carbon_quota', 'quota_allocation',
    'chain_block', 'chain_tx', 'alert_record', 'audit_log', 'notice'];
  // row_counter 是行数计数基础设施表（服务 /system 本身），不是业务表，从清单排除
  const INFRA_TABLES = new Set(['row_counter']);
  const names = allTables.map((t) => t.TABLE_NAME || t.table_name).filter((t) => !INFRA_TABLES.has(t));
  const ordered = [...new Set([...core.filter((t) => names.includes(t)), ...names])];
  /* 55 张表逐条 COUNT(*) 串行 = 2.4 s，是管理总览/系统自检首屏白等的主因。
     并发化只降到 1.9 s（瓶颈在 MySQL 侧而非往返次数），故改为单条 UNION ALL：
     一次往返拿全部行数，结果按 ordered 原位落座，顺序与表清单严格一致。
     表名全部来自本库的 information_schema，且经反引号包裹，无注入面。 */
  const counts = new Array(ordered.length);
  if (ordered.length) {
    /* real_emission_year（约 34 万行）单表 COUNT 全表扫描 ~1.9 s，是本接口 2.2 s 的主体。
     * 改读 row_counter（AFTER INSERT/DELETE 触发器逐行维护的**精确**行数，
     * initdb 末尾全量重建兜底）—— 这是精确计数，不是 information_schema 那种统计估算。
     * 计数行缺失 / row_counter 表不存在 / 值非法时，自动回退并入 UNION 全表 COUNT：
     * 宁可慢 2 s，也绝不给监管端一个近似数。 */
    let viaCounter = null;
    if (ordered.includes('real_emission_year')) {
      try {
        const rc = await db.one(`SELECT row_count FROM row_counter WHERE table_name = 'real_emission_year'`);
        if (rc && Number.isFinite(Number(rc.row_count))) viaCounter = Number(rc.row_count);
      } catch (e) { /* row_counter 尚未建立（旧库未重跑 initdb）→ 静默回退 */ }
    }
    const counted = viaCounter !== null
      ? ordered.filter((t) => t !== 'real_emission_year')
      : ordered;
    const union = counted
      .map((t, i) => `SELECT ${i} AS i, COUNT(*) AS n FROM \`${t}\``)
      .join(' UNION ALL ');
    const rows = counted.length ? await db.query(union) : [];
    const byIdx = new Map(rows.map((r) => [Number(r.i), Number(r.n) || 0]));
    const byName = new Map(counted.map((t, i) => [t, byIdx.get(i) || 0]));
    ordered.forEach((t, i) => {
      counts[i] = t === 'real_emission_year' && viaCounter !== null
        ? { table: t, rows: viaCounter, viaCounter: true }
        : { table: t, rows: byName.get(t) || 0 };
    });
  }
  const byRole = await db.query('SELECT role, COUNT(*) AS cnt FROM sys_user GROUP BY role');
  const chain = await anchorSvc.getChain();
  const chainStats = await chain.stats();
  /* 全链校验要逐块重算哈希 + 验 PoA 签名 + 重算 Merkle + 链下重算绑定，
     149 块约 1.4 s。这是诊断页而非交易路径，10 s 内重复访问复用同一结果，
     响应里带 cached/cacheAgeMs，看的人能分辨"刚验证过"与"这就是新结论"。 */
  const validation = await chain.validateChainCached({ ttlMs: 10000 });

  /* WP6：把"操作事实链"（审计哈希链）与"业务事实链"（联盟链）并排呈现。
     两条链分工不同、都不可被静默篡改 —— 这是系统治理页最有说服力的一段。 */
  let auditChainInfo = null;
  let auditChainValidation = null;
  try {
    const auditChain = require('../services/auditChain');
    auditChainInfo = await auditChain.stats();
    auditChainValidation = await auditChain.verify({ sample: 1000 });
  } catch (e) { auditChainInfo = { error: e.message }; }

  return {
    tableCounts: counts,
    tableTotal: counts.length,
    totalRows: counts.reduce((a, b) => a + b.rows, 0),
    byRole,
    chain: chainStats,
    validation: {
      valid: validation.valid,
      checked: validation.checkedBlocks,
      errors: validation.errors.slice(0, 20),
      errorCount: validation.errors.length,
      warnings: (validation.warnings || []).slice(0, 20),
      warningCount: validation.warningCount || 0,
      cached: !!validation.cached,
      cacheAgeMs: validation.cacheAgeMs || 0,
    },
    auditChain: auditChainInfo,
    auditChainValidation: auditChainValidation
      ? {
        valid: auditChainValidation.valid,
        mode: auditChainValidation.mode,
        checked: auditChainValidation.checked,
        errorCount: auditChainValidation.errors.length,
        errorTypes: auditChainValidation.errorTypes,
        errors: auditChainValidation.errors.slice(0, 20),
      }
      : null,
    runtime: {
      node: process.version,
      platform: process.platform,
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
      db: `${require('../config').db.host}:${require('../config').db.port}/${require('../config').db.database}`,
    },
    computedAt: new Date().toISOString(),
  };
}

/* 通知公告发布 */
router.post('/notices', requireRole('REGULATOR'), wrap(async (req, res) => {
  const { title, content, noticeType, targetRole, isTop } = req.body || {};
  if (!title) return fail(res, '标题不能为空', 400);
  const [ins] = await db.pool.query(
    `INSERT INTO notice (title, content, notice_type, target_role, publisher, is_top, publish_time)
     VALUES (?,?,?,?,?,?,NOW())`,
    [title, content || '', noticeType || 'POLICY', targetRole || 'ALL', req.user.realName || '监管端', isTop ? 1 : 0]
  );
  await writeLog(req, '通知公告', '发布公告', title, `${noticeType} / ${targetRole}`);
  ok(res, { id: ins.insertId }, '公告已发布');
}));

router.get('/notices', wrap(async (req, res) => {
  const page = await db.paginate(
    `SELECT * FROM notice ORDER BY is_top DESC, publish_time DESC`, [], req.query
  );
  ok(res, page);
}));

module.exports = router;
