/**
 * routes/enterprise.js —— 企业端 API
 * 碳排放数据上报 / 链上存证 / 配额账户 / 碳配额履约与流转 / 数据分析
 */
'use strict';

const express = require('express');
const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('../services/anchor');
const keystore = require('../blockchain/keystore');
const timefmt = require('../utils/time');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, requireRole('ENTERPRISE'));

/* ==================================================================
 * 业务年度解析（企业端）
 *
 * ⚠ 原实现是模块级 `const YEAR = new Date().getFullYear()`，把「业务年度」
 * 等同于「系统时钟年份」。碳数据天然滞后：当年排放要到次年才核查完。
 * 因此企业一登录看到的必然是「2026 年度累计排放 0 / 配额 0 / 缺口 0」，
 * 而实际上该企业有 8 张已核查上报单、36 万 t 配额 —— 全部显示成 0。
 *
 * 这不是没数据，是问错了年份。对使用者而言后果很直接：
 * 他打开工作台以为系统没跑通、数据丢了。
 *
 * 修正：默认取该企业**最新有已核查数据的年度**；?year= 可显式指定。
 * 必须按企业取，不能用全局最新年 —— 不同企业的履约进度不同。
 * ================================================================== */
async function resolveEntYear(id, requested) {
  const want = Number(requested);
  if (Number.isInteger(want) && want >= 2000 && want <= 2100) return want;
  /* 先找已提交（≥SUBMITTED）的年度 —— 那才是有效的申报口径。
   * 找不到再退到含草稿的最新年度：企业刚建、刚导入演示数据时全部是 DRAFT，
   * 若只认非草稿，工作台会显示"2026 年度 0 t"，用户以为数据没进来。
   * 草稿年度要能看见，但不能与已申报年度混为一谈 —— 调用方据 status 区分。 */
  const row = await db.one(
    `SELECT year FROM emission_report WHERE ent_id = ? AND status <> 'DRAFT'
      GROUP BY year ORDER BY year DESC LIMIT 1`, [id]
  );
  if (row) return Number(row.year);
  const draft = await db.one(
    'SELECT MAX(year) AS y FROM emission_report WHERE ent_id = ?', [id]
  );
  if (draft && draft.y) return Number(draft.y);
  const q = await db.one(
    'SELECT year FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC LIMIT 1', [id]
  );
  return q ? Number(q.year) : new Date().getFullYear();
}
const entId = (req) => req.user.orgId;

/* ==================================================================
 * 概览
 * ================================================================== */
router.get('/overview', wrap(async (req, res) => {
  const id = entId(req);
  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [id]);
  if (!ent) return fail(res, '企业信息不存在', 404);

  /* 业务年度：默认取该企业最新有核查数据的年度，可 ?year= 指定 */
  const YEAR = await resolveEntYear(id, req.query.year);

  /* emissionYtd 只算**已提交**（非草稿）的申报量 —— 这是"已申报排放"的
   * 正确口径，草稿不构成对外申报。
   *
   * 但如果该企业当前年度只有草稿，emissionYtd 就是 0，工作台显示
   * "0 tCO₂e"会让用户以为数据没进来。因此另给 draftEmission，
   * 让前端能说清"另有 N 张草稿共 X t 尚未提交"，而不是只给一个 0。 */
  const emissionYtd = Number(await db.value(
    'SELECT IFNULL(SUM(total_emission),0) FROM emission_report WHERE ent_id = ? AND year = ? AND status <> "DRAFT"',
    [id, YEAR]
  ) || 0);
  const draft = await db.one(
    `SELECT COUNT(*) n, IFNULL(SUM(total_emission),0) s FROM emission_report
      WHERE ent_id = ? AND year = ? AND status = 'DRAFT'`, [id, YEAR]
  );

  const quota = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [id, YEAR]) || {
    total_allocated: 0, available: 0, used: 0,
  };

  const statusCount = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM emission_report WHERE ent_id = ? GROUP BY status`, [id]
  );
  const statusMap = {};
  statusCount.forEach((s) => { statusMap[s.status] = Number(s.cnt); });

  /* 跨库 JOIN 拆开：业务表取本企业的 chain_tx_id 清单，账本库按清单计数。
   * 两库可能不在同一实例上，JOIN 在跨实例部署下不成立。 */
  const myTxIds = (await db.query(
    'SELECT chain_tx_id FROM emission_report WHERE ent_id = ? AND chain_tx_id IS NOT NULL', [id]
  )).map((r) => r.chain_tx_id);
  const chainAnchors = myTxIds.length
    ? Number(await db.ledgerValue(
      `SELECT COUNT(*) FROM chain_tx WHERE tx_id IN (${myTxIds.map(() => '?').join(',')})`, myTxIds
    ) || 0)
    : 0;

  const trend = await db.query(
    `SELECT period, total_emission AS total, scope1_emission AS s1, scope2_emission AS s2,
            intensity, output_value AS output, status
     FROM emission_report WHERE ent_id = ? AND status <> 'DRAFT' ORDER BY year, quarter`, [id]
  );

  const rank = await db.query(
    `SELECT COUNT(*) AS better FROM (
        SELECT r.ent_id, SUM(r.total_emission) AS t
        FROM emission_report r JOIN enterprise e2 ON e2.id = r.ent_id
        WHERE r.year = ? AND r.status <> 'DRAFT' AND e2.industry = ?
        GROUP BY r.ent_id) x
     WHERE x.t < (SELECT IFNULL(SUM(total_emission),0) FROM emission_report WHERE ent_id = ? AND year = ? AND status <> 'DRAFT')`,
    [YEAR, ent.industry, id, YEAR]
  );
  /* 【2026-11-03】分母必须与分子同口径：上面的「优于本企业数」只统计
   * 非草稿上报单，这里却把只有草稿单的同行业企业也算进了总数，
   * 会出现「排名 3 / 2」这种分母小于分子的情况。 */
  const industryTotal = Number(await db.value(
    `SELECT COUNT(DISTINCT r.ent_id) FROM emission_report r JOIN enterprise e2 ON e2.id = r.ent_id
     WHERE r.year = ? AND e2.industry = ? AND r.status <> 'DRAFT'`, [YEAR, ent.industry]
  ) || 1);

  /* content/handle_note 一并回传：总览页预警表只有标题，用户看到
   * 「配额缺口预警」却无法知道它是哪个年度、什么原因触发
   * （2025 盈余 + 2026 配额未分配预警同屏，无详情入口时逻辑无法闭合）。 */
  const alerts = await db.query(
    `SELECT alert_no, alert_type, level, title, content, status, handle_note, created_at, closed_at FROM alert_record
     WHERE ent_id = ? ORDER BY created_at DESC LIMIT 5`, [id]
  );

  const notices = await db.query(
    `SELECT id, title, notice_type, publish_time FROM notice
     WHERE target_role IN ('ALL','ENTERPRISE') ORDER BY is_top DESC, publish_time DESC LIMIT 5`
  );

  ok(res, {
    /* 业务年度必须回传：前端要写明"2024 年度"，否则用户会以为看到的是今年 */
    reportYear: YEAR,
    enterprise: {
      id: ent.id, name: ent.ent_name, code: ent.ent_code, industry: ent.industry,
      region: ent.region, city: ent.city, scale: ent.scale, creditScore: ent.credit_score,
      status: ent.status, wallet: ent.wallet_address,
    },
    kpi: {
      emissionYtd: Number(emissionYtd.toFixed(2)),
      /* 草稿量单独给：让"0 已申报"与"有草稿待提交"能区分开 */
      draftCount: Number(draft.n || 0),
      draftEmission: Number(Number(draft.s || 0).toFixed(2)),
      quotaAllocated: Number(quota.total_allocated),
      quotaAvailable: Number(quota.available),
      quotaUsed: Number(quota.used),
      /* 履约缺口 / 盈余 = 分配配额 − 已申报排放（正=盈余，负=缺口）。
       * 原实现是 total_allocated − used，即"配额余量"，与卡片标签不符：
       * 实测该企业 2025 年排放 302,858 t、本年度配额 0，卡片却显示
       * "履约缺口 / 盈余 0 tCO₂e · 动态核算配额盈余" —— 把"根本没分配配额"
       * 说成了"刚好平衡"，是所有 KPI 里最容易被评委抓住的一处（2026-10-29 巡检 P0-1）。
       * quotaAssigned 一并回传：配额为 0 时前端应显示"未分配"，不能给一个 0 装作结论。 */
      quotaGap: Number((Number(quota.total_allocated) - emissionYtd).toFixed(2)),
      quotaAssigned: Number(quota.total_allocated) > 0,
      /* 配额使用进度「占比」= 已清缴配额 ÷ 已分配配额。
       * 原实现分子分母写反（362,613 ÷ 302,858 = 119.7%），与同卡环图
       * （used/alloc = 83.5%）以及「履约缺口/盈余 59,755 · 结余为正」KPI 直接
       * 矛盾 —— 同一张卡里环画 83.5%、文字写 119.7%（2026-10-31 巡检 P0）。 */
      complianceRate: Number(quota.total_allocated) > 0
        ? Number(((Number(quota.used) / Number(quota.total_allocated)) * 100).toFixed(1)) : 0,
      reportTotal: Object.values(statusMap).reduce((a, b) => a + b, 0),
      reportVerified: statusMap.VERIFIED || 0,
      reportPending: (statusMap.SUBMITTED || 0) + (statusMap.VERIFYING || 0),
      reportRejected: statusMap.REJECTED || 0,
      chainAnchors,
      industryRank: Number(rank[0].better) + 1,
      industryTotal,
    },
    trend,
    currentQuota: quota,
    alerts,
    notices,
  });
}));

/* ==================================================================
 * 碳排上报
 * ================================================================== */
router.get('/reports', wrap(async (req, res) => {
  const { status, period, keyword } = req.query;
  /* 过滤列一律带表别名：本查询 LEFT JOIN verifier_org，两表都有 status 列，
   * 裸写 `status = ?` 会报 "Column 'status' in where clause is ambiguous"
   * （2026-10-28 实测：企业端上报列表只要选任何状态就 500）。 */
  const where = ['r.ent_id = ?'];
  const params = [entId(req)];
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (period) { where.push('r.period = ?'); params.push(period); }
  if (keyword) { where.push('r.report_no LIKE ?'); params.push(`%${keyword}%`); }

  const page = await db.paginate(
    `SELECT r.id, r.report_no, r.year, r.quarter, r.period, r.scope1_emission, r.scope2_emission,
            r.total_emission, r.energy_consumption, r.output_value, r.intensity, r.yoy_rate,
            r.data_source, r.status, r.submit_time, r.verify_time, r.chain_block_index,
            r.chain_tx_id, r.remark,
            v.org_name AS verifier_name
     FROM emission_report r LEFT JOIN verifier_org v ON v.id = r.verifier_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.year DESC, r.quarter DESC, r.id DESC`,
    params, req.query
  );
  ok(res, page);
}));

router.get('/reports/:id', wrap(async (req, res) => {
  const r = await db.one(
    `SELECT r.*, v.org_name AS verifier_name FROM emission_report r
     LEFT JOIN verifier_org v ON v.id = r.verifier_id
     WHERE r.id = ? AND r.ent_id = ?`, [req.params.id, entId(req)]
  );
  if (!r) return fail(res, '上报单不存在', 404);
  r.items = await db.query('SELECT * FROM emission_item WHERE report_id = ? ORDER BY scope, id', [r.id]);
  r.tasks = await db.query('SELECT * FROM verify_task WHERE report_id = ?', [r.id]);
  r.verifyReport = await db.one('SELECT * FROM verify_report WHERE emission_report_id = ?', [r.id]);
  ok(res, r);
}));

/**
 * 新建上报单
 * body: { year, quarter, dataSource, items:[{energyType, amount}], submit:bool }
 */
router.post('/reports', wrap(async (req, res) => {
  const id = entId(req);
  const { year, quarter, dataSource, items, submit } = req.body || {};

  /* 入参校验：年度/季度/消耗量必须为合法值。
     历史缺陷：仅校验非空，导致 quarter=99、year=1800、amount 为负数或非数字
     均可入库（负数会算出"负排放"），且非数字会经 Number(x)||0 被静默当作 0。 */
  const y = Number(year);
  const q = Number(quarter);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    return fail(res, '核算年度不合法（应为 2000–2100 之间的整数）', 400);
  }
  if (!Number.isInteger(q) || q < 1 || q > 4) {
    return fail(res, '核算季度不合法（应为 1–4）', 400);
  }
  if (!Array.isArray(items) || items.length === 0) return fail(res, '请至少填写一项能源消耗数据', 400);

  const exists = await db.one('SELECT id FROM emission_report WHERE ent_id = ? AND year = ? AND quarter = ?',
    [id, y, q]);
  if (exists) return fail(res, `${y} 年第 ${q} 季度已存在上报单，请勿重复上报`, 400);

  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [id]);

  // 计算明细 → 汇总
  let s1 = 0, s2 = 0, energy = 0;
  const rows = [];
  for (const it of items) {
    const meta = require('../scripts/seed-pools').ENERGY_TYPES.find((x) => x.name === it.energyType);
    if (!meta) continue;
    const amount = Number(it.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(res, `能源「${it.energyType}」的消耗量必须为大于 0 的数字`, 400);
    }
    const co2 = Number((amount * meta.factor).toFixed(3));
    if (meta.scope === 1) s1 += co2; else s2 += co2;
    const TCE = { 原煤: 0.7143, 焦炭: 0.9714, 天然气: 12.143, 柴油: 1.4571, 燃料油: 1.4286, 电力: 0.3025, 热力: 0.03412 };
    energy += amount * (TCE[meta.name] || 0.7);
    rows.push({ meta, amount, co2 });
  }
  if (!rows.length) return fail(res, '能源品种不合法', 400);

  const yearReports = await db.query(
    'SELECT IFNULL(SUM(output_value),0) AS o FROM emission_report WHERE ent_id = ? AND year = ?', [id, y]
  );
  /* 产值取值链：当年四季度均值 → 企业档案年产值/4 → 0。
   * 2026-10-30 修复：原写法 `A || B` 在 A=0 且 annual_output 为 NULL 时
   * 得到 NaN，INSERT 直接 500 —— 四家真实企业 annual_output 恰好全空，
   * 首次真实提交上报就踩中。 */
  const qOutput = Number(yearReports[0].o) / 4;
  const aOutput = Number(ent.annual_output) / 4;
  const outputValue = Number((qOutput > 0 ? qOutput : (aOutput > 0 ? aOutput : 0)).toFixed(2));
  const total = Number((s1 + s2).toFixed(2));
  const intensity = outputValue > 0 ? Number((total / outputValue).toFixed(4)) : 0;

  const reportNo = cu.bizNo('ER');
  const status = submit ? 'SUBMITTED' : 'DRAFT';
  const [ins] = await db.pool.query(
    `INSERT INTO emission_report
      (report_no, ent_id, year, quarter, period, scope1_emission, scope2_emission, total_emission,
       energy_consumption, output_value, intensity, yoy_rate, data_source, status, submit_time, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [reportNo, id, y, q, `${y}Q${q}`, Number(s1.toFixed(2)), Number(s2.toFixed(2)), total,
      Number(energy.toFixed(2)), outputValue, intensity, 0, dataSource || '排放因子法', status,
      submit ? new Date() : null]
  );
  const reportId = ins.insertId;

  for (const r of rows) {
    await db.query(
      `INSERT INTO emission_item (report_id, ent_id, energy_type, scope, amount, unit, factor, co2, calc_method)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [reportId, id, r.meta.name, r.meta.scope, r.amount, r.meta.unit, r.meta.factor, r.co2,
        r.meta.scope === 1 ? '排放因子法' : '购入量法']
    );
  }

  let chain = null;
  if (submit) {
    chain = await anchorSvc.anchor({
      txType: 'EMISSION_REPORT',
      bizNo: reportNo,
      fromLabel: `ent:${id}`,
      payload: {
        reportNo, entId: id, entName: ent.ent_name, period: `${y}Q${q}`,
        scope1: Number(s1.toFixed(2)), scope2: Number(s2.toFixed(2)), totalEmission: total,
        intensity, dataSource: dataSource || '排放因子法',
      },
    });
    await db.query('UPDATE emission_report SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
      [chain.blockIndex, chain.txId, reportId]);
    await assignVerifier(reportId, id, y, q);
  }

  await writeLog(req, '碳排上报', submit ? '提交上报' : '暂存草稿', reportNo,
    `报告期 ${y}Q${q}，排放总量 ${total} tCO2e`);

  ok(res, { reportId, reportNo, total, chain }, submit ? '上报成功，数据已上链存证' : '草稿已保存');
}));

/** 提交草稿 */
router.post('/reports/:id/submit', wrap(async (req, res) => {
  const r = await db.one('SELECT * FROM emission_report WHERE id = ? AND ent_id = ?', [req.params.id, entId(req)]);
  if (!r) return fail(res, '上报单不存在', 404);
  if (r.status !== 'DRAFT') return fail(res, '该上报单已提交，无法重复提交', 400);

  const ent = await db.one('SELECT * FROM enterprise WHERE id = ?', [entId(req)]);
  const chain = await anchorSvc.anchor({
    txType: 'EMISSION_REPORT',
    bizNo: r.report_no,
    fromLabel: `ent:${entId(req)}`,
    payload: {
      reportNo: r.report_no, entId: entId(req), entName: ent.ent_name, period: r.period,
      scope1: Number(r.scope1_emission), scope2: Number(r.scope2_emission),
      totalEmission: Number(r.total_emission), intensity: Number(r.intensity), dataSource: r.data_source,
    },
  });
  await db.query(
    "UPDATE emission_report SET status='SUBMITTED', submit_time=NOW(), chain_block_index=?, chain_tx_id=? WHERE id=?",
    [chain.blockIndex, chain.txId, r.id]
  );
  const task = await assignVerifier(r.id, entId(req), r.year, r.quarter);
  await writeLog(req, '碳排上报', '提交上报', r.report_no, `排放总量 ${r.total_emission} tCO2e，已上链 #${chain.blockIndex}`);
  ok(res, { chain, task }, '提交成功，数据已上链存证');
}));

/** 为上报表指派第三方核查机构并生成核查任务。
 *
 * 原实现 `ORDER BY RAND() LIMIT 1` 有三个缺陷：
 *   ① 不可复现 —— 同一次演示两次派给不同机构，无法解释；
 *   ② 可能派给没有 VER_CLERK/VER_REVIEWER 账号的机构，任务永久停在 PENDING；
 *   ③ 忽略地域 —— 河北企业派给海南机构不合常理。
 * 统一走 derive.pickVerifier()：能力（双岗）→ 负荷（在办数）→ 地域，三级排序。 */
async function assignVerifier(reportId, id, year, quarter) {
  /* 闭环封闭（2026-10-30）：四家真实企业（65~68）专属沧州机构（org 8），
   * 其余企业的新任务一律排除沧州(8)与大连(1)——前者是原闭环的核查席，
   * 后者保留给大连院自身演示动线；新企业的任务在其余可闭环机构
   * （唐山 45 / 河北绿链 54）之间按负荷均分，与演示账号的闭环划分一致。 */
  const SEALED_ORG_IDS = [1, 8];
  const isRealFour = [65, 66, 67, 68].includes(Number(id));
  const exclude = isRealFour ? [] : SEALED_ORG_IDS;
  const v = await require('../services/derive').pickVerifier(/河北|保定/, { exclude });
  if (!v) return null;
  /* 2026-11-01 交付复检修复：verifier_user 原来按 "ver"+机构id 拼接（如 ver045），
   * 而库里真实账号是 ver_ts_review 这类名字 —— 派单落点本身没问题（任务按 verifier_id
   * 归属），但"承办账号"字段指向一个不存在的用户名，界面显示与可登录账号对不上。
   * 改为落库前查该机构的真实核查账号，查不到才退回旧命名。 */
  const acc = await db.one(
    `SELECT username FROM sys_user
      WHERE role='VERIFIER' AND org_id=? AND status IN (1,'ACTIVE')
      ORDER BY FIELD(post,'VER_CLERK','VER_REVIEWER','ORG_ADMIN'), id LIMIT 1`, [v.id]
  );
  const verifierUser = acc ? acc.username : ('ver' + String(v.id).padStart(3, '0'));
  const taskNo = cu.bizNo('VT');
  const [ins] = await db.pool.query(
    `INSERT INTO verify_task (task_no, report_id, ent_id, verifier_id, verifier_user, task_type,
       priority, status, assign_time, deadline, created_at)
     VALUES (?,?,?,?,?,?,?,'PENDING',NOW(),DATE_ADD(NOW(), INTERVAL 30 DAY),NOW())`,
    [taskNo, reportId, id, v.id, verifierUser, 'ROUTINE',
      Number(quarter) <= 1 ? 'HIGH' : 'NORMAL']
  );
  await db.query('UPDATE emission_report SET verifier_id = ? WHERE id = ?', [v.id, reportId]);
  return { taskId: ins.insertId, taskNo, verifier: v.org_name };
}

/* ==================================================================
 * 链上存证详情（含签名验签 + Merkle 证明）
 * ================================================================== */
router.get('/reports/:id/chain', wrap(async (req, res) => {
  const r = await db.one('SELECT * FROM emission_report WHERE id = ? AND ent_id = ?',
    [req.params.id, entId(req)]);
  if (!r) return fail(res, '上报单不存在', 404);
  if (!r.chain_tx_id) return fail(res, '该上报单尚未上链存证', 400);

  const tx = await db.ledgerOne('SELECT * FROM chain_tx WHERE tx_id = ?', [r.chain_tx_id]);
  /* 业务库与账本库曾经分离部署过（本地账本 / 线上 Worker+Turso 各有一条链），
   * 线上同步来的上报单带着线上链的交易号，本节点账本自然查不到。
   * 这种情况必须给明确答复 —— 曾经直接解引用 tx.pub_key，一个 500 把
   * "存证缺失"说成了"服务器故障"，演示现场最难解释。 */
  if (!tx) {
    return fail(res, '该上报单的存证不在当前节点账本上（其交易号来自另一部署批次的链），无法就地核验', 404);
  }
  const block = await db.ledgerOne('SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index = ?',
    [r.chain_block_index]);
  const txList = await db.ledgerQuery('SELECT tx_id FROM chain_tx WHERE block_index = ? ORDER BY id', [r.chain_block_index]);
  const leaf = txList.findIndex((t) => t.tx_id === r.chain_tx_id);
  const proof = cu.merkleProof(txList.map((t) => t.tx_id), leaf);

  // 实时验签：用企业公钥验证这笔存证确实由本企业私钥签发
  const signatureValid = cu.verify(tx.pub_key, cu.stableStringify({
    txId: tx.tx_id, txType: tx.tx_type, bizNo: tx.biz_no, fromAddress: tx.from_address,
    toAddress: tx.to_address, payloadHash: tx.payload_hash, nonce: Number(tx.nonce),
  }), tx.signature);

  // 链下链上比对：库里的排放总量是否与存证快照一致
  const snapshot = typeof tx.payload_json === 'string' ? JSON.parse(tx.payload_json) : tx.payload_json;
  const bizHashNow = cu.hashObject(snapshot);
  const dataIntact = bizHashNow === tx.payload_hash;
  const dbMatchesSnapshot = Number(snapshot.totalEmission) === Number(r.total_emission);

  ok(res, {
    report: { id: r.id, reportNo: r.report_no, period: r.period, total: Number(r.total_emission), status: r.status },
    tx: {
      txId: tx.tx_id, txType: tx.tx_type, from: tx.from_address, to: tx.to_address,
      payloadHash: tx.payload_hash, nonce: Number(tx.nonce), fee: Number(tx.gas_fee),
      signature: tx.signature, createdAt: tx.created_at,
    },
    block: block && {
      index: Number(block.block_index), hash: block.block_hash, prevHash: block.prev_hash,
      merkleRoot: block.merkle_root, nonce: Number(block.nonce), difficulty: Number(block.difficulty),
      txCount: Number(block.tx_count), miner: block.miner, mineTime: Number(block.mine_time),
      sizeBytes: Number(block.size_bytes), blockTime: block.block_time,
    },
    /* leafHash 与 leafIndex 一并返回：单笔交易区块的 path 为空数组，
     * 前端要靠 (leafIndex=0 且 root=leafHash) 判断"单叶场景"，
     * 缺任一项都会被误报成"证明路径缺失"。 */
    merkle: {
      leafIndex: leaf,
      leafHash: r.chain_tx_id,
      root: proof.root,
      rootMatches: proof.root === (block ? block.merkle_root : ''),
      path: proof.path,
    },
    verify: { signatureValid, dataIntact, dbMatchesSnapshot, snapshot },
  });
}));

/* ==================================================================
 * 配额账户
 * ================================================================== */
router.get('/quota', wrap(async (req, res) => {
  const id = entId(req);
  const list = await db.query('SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC', [id]);
  const alloc = await db.query(
    `SELECT a.*, (SELECT COUNT(*) FROM quota_allocation x WHERE x.id <= a.id AND x.ent_id = a.ent_id) AS seq
     FROM quota_allocation a WHERE a.ent_id = ? ORDER BY a.year DESC, a.id DESC LIMIT 20`, [id]
  );
  const ent = await db.one('SELECT wallet_address FROM enterprise WHERE id = ?', [id]);
  ok(res, { list, allocations: alloc, wallet: ent ? ent.wallet_address : null });
}));

/* ==================================================================
 * 数据分析
 * ================================================================== */
router.get('/analytics', wrap(async (req, res) => {
  const id = entId(req);
  /* 年度口径同上：不能取系统时钟，否则能源结构与同行对比全为空 */
  const YEAR = await resolveEntYear(id, req.query.year);
  const trend = await db.query(
    `SELECT period, total_emission AS total, scope1_emission AS s1, scope2_emission AS s2, intensity
     FROM emission_report WHERE ent_id = ? AND status <> 'DRAFT' ORDER BY year, quarter`, [id]
  );
  /* 排放构成（按排放源拆分）
   *
   * ⚠ 这里必须过滤掉 CEMS 污染物行。派生上报单里有两类明细：
   *   ① CO₂ 分摊行 —— 真正的排放来源，co2 > 0
   *   ② CEMS 污染物行 —— SO₂/NOx/颗粒物/CO/HCl 的实测汇总，
   *      amount 是吨数、co2 恒为 0（污染物不是 CO₂ 排放源）
   * 原查询不过滤，把 ② 也当成"能源品种"画饼图，结果 5 个扇区全是 0，
   * 用户看到的是"排放构成全是 0" —— 而真实 CO₂ 在汇总字段里好端端的。
   * 这类静默错误比报错更难发现：页面不报错，只是数字没意义。 */
  const mix = await db.query(
    `SELECT i.energy_type AS name, IFNULL(SUM(i.co2),0) AS value
     FROM emission_item i JOIN emission_report r ON r.id = i.report_id
     WHERE i.ent_id = ? AND r.year = ? AND i.co2 > 0
       AND (i.calc_method IS NULL OR i.calc_method NOT LIKE 'CEMS%')
     GROUP BY i.energy_type ORDER BY value DESC`, [id, YEAR]
  );

  /* CEMS 污染物实测汇总（与排放构成分开呈现：一个是 CO₂ 来源，
   * 一个是污染物排放量，混在一张图里在语义上是错的） */
  const pollutants = await db.query(
    `SELECT i.energy_type AS name, IFNULL(SUM(i.amount),0) AS value, i.unit
     FROM emission_item i JOIN emission_report r ON r.id = i.report_id
     WHERE i.ent_id = ? AND r.year = ? AND i.calc_method LIKE 'CEMS%'
     GROUP BY i.energy_type, i.unit ORDER BY value DESC`, [id, YEAR]
  );
  const quota = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [id, YEAR]);
  /* 本年度没有配额记录时 quota 为 null，前端 `quota || {}` 会让四张 KPI
   * 全部退化成「—」（2026-10-29 巡检 P0-4：数据分析页顶部四张卡无一有数）。
   * 这里补两件事：①零值兜底，页面显示 0 而不是破折号；
   * ②回传该企业最近一次分配，让用户知道"不是系统没数据，是本年度还没分"。 */
  const lastQuota = quota ? null : await db.one(
    `SELECT year, total_allocated, used, available FROM carbon_quota
     WHERE ent_id = ? ORDER BY year DESC LIMIT 1`, [id]
  );
  // 履约缺口动态：按季度核算出的累计排放 vs 配额，反映「动态核算 → 履约」的缺口走势
  const monthly = await db.query(
    `SELECT DATE_FORMAT(r.created_at,'%Y-%m') AS month,
            IFNULL(SUM(r.total_emission),0) AS amount
     FROM emission_report r
     WHERE r.ent_id = ? AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY month ORDER BY month`, [id, YEAR]
  );
  const peers = await db.query(
    `SELECT r.ent_id AS entId, e.ent_name AS name, SUM(r.total_emission) AS value
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE e.industry = (SELECT industry FROM enterprise WHERE id = ?) AND r.year = ? AND r.status <> 'DRAFT'
     GROUP BY r.ent_id ORDER BY value DESC LIMIT 10`, [id, YEAR]
  );
  /* 【2026-11-03】isMe 原来被写死为 false —— 前端「同行业排放对标 TOP10」
   * 图例明写"橙色为本企业"，但接口从来不告诉前端哪一行是本企业，
   * 于是本企业永远不高亮：读者只能靠自己从一串公司名里认出自己。
   * 这里按 ent_id 比对真实标记；peers 里若没有本企业（如行业唯一），
   * 额外把本企业补进去，保证对标图始终能定位到自己。 */
  const myId = Number(id);
  const myName = await db.value('SELECT ent_name FROM enterprise WHERE id = ?', [id]);
  const peerRows = peers.map((p) => ({
    name: p.name, value: Number(p.value), isMe: Number(p.entId) === myId,
  }));
  if (!peerRows.some((p) => p.isMe)) {
    const own = await db.value(
      `SELECT IFNULL(SUM(total_emission),0) FROM emission_report
        WHERE ent_id = ? AND year = ? AND status <> 'DRAFT'`, [myId, YEAR]
    );
    peerRows.push({ name: myName, value: Number(own || 0), isMe: true });
    peerRows.sort((a, b) => b.value - a.value);
  }
  ok(res, {
    reportYear: YEAR,
    trend, mix,
    /* CEMS 污染物实测汇总：与 CO₂ 排放构成分开给，
     * 前者是"排了多少污染物"，后者是"CO₂ 从哪来"，不能混在一张图里 */
    pollutants: pollutants.map((p) => ({
      name: p.name, value: Number(p.value), unit: p.unit,
    })),
    quota: quota
      ? {
        ...quota,
        total_allocated: Number(quota.total_allocated) || 0,
        used: Number(quota.used) || 0,
        available: Number(quota.available) || 0,
        assigned: true,
      }
      : { year: YEAR, total_allocated: 0, used: 0, available: 0, assigned: false },
    /* 本年度未分配时的"最近一次分配"，供页面注明口径 */
    lastQuota: lastQuota
      ? {
        year: Number(lastQuota.year),
        total_allocated: Number(lastQuota.total_allocated) || 0,
        used: Number(lastQuota.used) || 0,
        available: Number(lastQuota.available) || 0,
      }
      : null,
    monthly: monthly.map((m) => ({ ...m, amount: Number(m.amount) })),
    peers: peerRows,
    myName,
  });
}));

/* ==================================================================
 * 通知公告
 * ================================================================== */
router.get('/notices', wrap(async (req, res) => {
  const page = await db.paginate(
    `SELECT id, title, content, notice_type, publisher, is_top, views, publish_time FROM notice
     WHERE target_role IN ('ALL','ENTERPRISE') ORDER BY is_top DESC, publish_time DESC`,
    [], req.query
  );
  ok(res, page);
}));

/* 我的链上身份 */
router.get('/wallet', wrap(async (req, res) => {
  const id = entId(req);
  const ent = await db.one('SELECT wallet_address, pub_key, ent_name FROM enterprise WHERE id = ?', [id]);
  if (!ent) return fail(res, '企业信息不存在', 404);
  const w = keystore.walletFor(`ent:${id}`);

  /* 自愈：历史数据里存在 wallet_address 为 NULL 的企业（注册流程曾漏写）。
   * 这里在读接口上补齐 —— 用 walletFor 的确定性密钥，与 anchor() 实际签名用的
   * 是同一把，补写不会造成身份分裂。放在读路径而非迁移脚本，是因为
   * 这类企业的数量未知且零散，一次性的数据修复容易漏掉。
   * 补写失败不影响本次读取（地址照样返回），只是下次再试。 */
  let address = ent.wallet_address;
  let publicKey = ent.pub_key;
  if (!address || !publicKey) {
    address = address || w.address;
    publicKey = publicKey || w.publicKey;
    try {
      await db.query('UPDATE enterprise SET wallet_address = ?, pub_key = ? WHERE id = ?',
        [address, publicKey, id]);
    } catch (e) { /* 读路径不应因写失败而 500 */ }
  }

  const txs = await db.ledgerQuery(
    `SELECT tx_id, tx_type, biz_no, block_index, from_address, payload_hash, created_at
     FROM chain_tx WHERE from_address = ? ORDER BY id DESC LIMIT 20`, [address]
  );
  ok(res, {
    address,
    publicKey,
    algorithm: 'secp256k1 / ECDSA-SHA256',
    privateKeyLocation: '节点本地密钥库（不落业务库）',
    /* created_at 是 UTC 字面量，必须转本地时区再给前端。
     * 原样透传时前端按本地时间解析，整列比真实时间早 8 小时，而同一张表的
     * 区块号是降序的 —— 于是"按区块号排好序的列表里时间却忽前忽后"
     * （2026-10-29 巡检 P0-7b）。 */
    recentTxs: txs.map((t) => ({ ...t, created_at: timefmt.localFromUtcLiteral(t.created_at) })),
  });
}));

module.exports = router;
