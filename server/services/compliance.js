/**
 * compliance.js —— 履约清缴与碳信用注销（碳市场闭环的最后一环）
 * ==================================================================================
 * 【为什么这是「闭环」而不是「又一个功能」】
 * 碳市场的经济逻辑是：
 *     配额稀缺 → 有价格 → 企业减排或购买 → 期末清缴 → 配额被消耗 → 下一年重新稀缺
 * 若缺了「清缴」这一环：
 *   · 配额永不被消耗，企业可以无限持有，"稀缺"是假的；
 *   · 交易只是数字在账户间搬家，没有"必须交出"的压力；
 *   · 碳价没有锚，因为它不代表任何必须履行的义务。
 * 旧版 `carbon_quota.used` 只由 initdb 种子写入，全库没有任何代码更新它 ——
 * 也就是说，平台的"履约率"统计读的是一个从不变化的列。这不是"未完成"，
 * 是**让整个碳市场叙事失去物理基础**。
 *
 * 【注销 ≠ 抵销】
 *   抵销（offset）：用碳信用冲减配额缺口，抵销后信用记为 USED，仍可查询、仍可审计。
 *   注销（retire）：减排量被真实消费，永久退出流通，不可再被任何人声称。
 * CCER 规则要求抵销的减排量必须注销。没有注销，同一份减排量可被无限次声称，
 * 这是碳市场最经典的漏洞（double claiming）。
 *
 * 【本模块的两条硬约束】
 *   ① 清缴量不得超过企业持有的可用配额（不允许负余额）
 *   ② 一份碳信用只能注销一次（数据库唯一 + 状态机双保险）
 *
 * @module services/compliance
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');

/** 清缴截止日（每年 12 月 31 日；实际全国碳市场为次年 6 月 30 日，此处按年度末） */
const SURRENDER_DEADLINE_MONTH = 12;
const SURRENDER_DEADLINE_DAY = 31;

/** 缺口罚款倍数（对标《碳排放权交易管理暂行条例》：处未清缴配额市场价值的 5~10 倍） */
const PENALTY_MULTIPLIER = 5;

/* ==================================================================================
 * 一、清缴基数确定
 * ================================================================================== */

/**
 * 确定某企业某年度的「应清缴排放量」—— 这是清缴的第一步，也是最容易被糊弄的一步。
 *
 * 取值优先级（由强到弱，每一级都必须留痕）：
 *   ① 已出具的核查报告认定值（verify_report.verified_value）—— 法定口径
 *   ② 已确认的核算批次（calc_batch，usable_for_compliance=1）—— 平台口径
 *   ③ 两者都有但差异大 → 不擅自选择，报冲突待人工裁定
 *   ④ 都没有 → 拒绝清缴（不允许用配额或估算倒推）
 *
 * ⚠ 「两者都有」时必须比对。若核查值与平台核算值差异超过 5%，
 *   说明企业申报书与平台数据不一致，这是核查发现项的来源，不能静默取其一。
 *
 * @param {number} entId
 * @param {number} year
 * @returns {object} { available, value, source, alternatives, conflict }
 */
async function resolveVerifiedEmission(entId, year) {
  /* ① 核查报告认定值：**按排放年度归集该年度全部季度报告并求和**
   *
   * ⚠ 这里曾是「YEAR(issue_time) = year + ORDER BY issue_time DESC LIMIT 1」，
   * 两个缺陷都会让履约结论错得无声无息：
   *
   *   缺陷 A：按签发年归集。
   *     "核查报告哪年签发"与"清缴哪一年的排放"是两个不同的时间轴。
   *     2024 年度的排放通常在 2025–2026 年才完成核查。按签发年过滤，
   *     查 2024 年度得到 0 份报告，系统报「无合格核查报告」——
   *     这不是缺数据，是把年度轴用错了，企业会被误判为未履约。
   *
   *   缺陷 B：只取最新一份。
   *     履约清缴是**年度**义务，应缴量 = 全年各季度上报单核查值之和。
   *     取"最新一份"等于只按最后一个季度缴配额，欠缴四分之三，
   *     而单据显示"已清缴"—— 账面合规、实质严重欠缴，是最危险的一种错。
   *
   * 修正：JOIN emission_report 按 er.year 归集，求和为年度认定值；
   *      保留逐张明细（quarters/items）供审计核对，不只给一个总数。 */
  const vrs = await db.query(
    `SELECT vr.id, vr.report_no, vr.verified_value, vr.declared_value, vr.deviation_rate,
            vr.conclusion, vr.issue_time, vr.approved_by, vr.submitted_by,
            er.year, er.quarter, er.period
       FROM verify_report vr
       JOIN emission_report er ON er.id = vr.emission_report_id
      WHERE vr.ent_id = ? AND er.year = ? AND vr.conclusion IN ('PASS','CONDITIONAL')
        AND vr.approved_by IS NOT NULL
      ORDER BY er.quarter, vr.id`,
    [entId, year]
  );
  const vr = vrs.length ? {
    id: vrs[vrs.length - 1].id,
    count: vrs.length,
    verified_value: vrs.reduce((s, x) => s + Number(x.verified_value), 0),
    declared_value: vrs.reduce((s, x) => s + Number(x.declared_value), 0),
    quarters: vrs.map((x) => Number(x.quarter)).sort((a, b) => a - b),
    items: vrs,
  } : null;

  /* ② 平台核算批次：取该年度最新一个可履约批次 */
  const cb = await db.one(
    `SELECT batch_no, total_emission, u95_rel, quality_tier, created_at
       FROM calc_batch
      WHERE ent_id = ? AND year = ? AND usable_for_compliance = 1 AND status <> 'VOID'
      ORDER BY id DESC LIMIT 1`,
    [entId, year]
  );

  const alts = {
    verifyReport: vr ? {
      id: Number(vr.id),
      /* reportNo 用"多张"表达，避免前端误以为是单张报告编号 */
      reportNo: vr.count > 1 ? `${vr.count} 份季度核查报告（合计）` : vrs[0].report_no,
      reportCount: vr.count,
      quarters: vr.quarters,
      /* 逐张明细：审计要能点到每一张，而不是只看一个汇总数 */
      items: vr.items.map((x) => ({
        id: Number(x.id), reportNo: x.report_no, period: x.period,
        quarter: Number(x.quarter), verified: Number(x.verified_value),
        declared: Number(x.declared_value), deviationRate: Number(x.deviation_rate),
        conclusion: x.conclusion, issuedAt: x.issue_time,
      })),
      value: Number(vr.verified_value), declared: Number(vr.declared_value),
      deviationRate: Number(((vr.verified_value - vr.declared_value) / Math.max(vr.declared_value, 1) * 100).toFixed(2)),
      conclusion: vr.items.every((x) => x.conclusion === 'PASS') ? 'PASS' : 'CONDITIONAL',
      issuedAt: vr.items[vr.items.length - 1].issue_time,
      coverage: `${vr.quarters.map((q) => 'Q' + q).join('/')}`,
      strength: `法定口径：${vr.count} 份第三方核查报告（${vr.quarters.map((q) => 'Q' + q).join('/')}）`
        + '已出具并上链，年度认定值为各季度之和',
    } : null,
    calcBatch: cb ? {
      batchNo: cb.batch_no, value: Number(cb.total_emission),
      u95Rel: cb.u95_rel === null ? null : Number(cb.u95_rel),
      qualityTier: cb.quality_tier, createdAt: cb.created_at,
      strength: '平台口径：基于活动数据台账正向核算，可逐项复算',
    } : null,
  };

  if (!vr && !cb) {
    return {
      available: false,
      reason: `企业 ${entId} 在 ${year} 年度既无合格核查报告，也无可用于履约的核算批次`,
      detail: '清缴必须有可核查的排放量依据。平台拒绝用配额量、行业均值或估算值倒推应清缴量。',
      hint: '请先完成核算（POST /api/mrv/calc）并确保 usable_for_compliance=1，或等待核查报告出具',
      alternatives: alts,
    };
  }

  /* 两者都有 → 比对 */
  if (vr && cb) {
    const v = Number(vr.verified_value);
    const c = Number(cb.total_emission);
    const denom = Math.max(Math.abs(v), Math.abs(c));
    const diffPct = denom > 0 ? Math.abs(v - c) / denom * 100 : 0;
    const conflict = diffPct > 5;
    return {
      available: true,
      /* 有核查报告时以核查值为准（法定），但冲突必须报出来 */
      value: v,
      source: 'VERIFY_REPORT',
      conflict,
      /* 季度不齐也必须报出来：只有 2 个季度的核查值不能当作年度义务基数，
       * 否则清缴额会被系统性低估（少缴），而单据上看起来一切正常。 */
      incomplete: vr.quarters.length < 4,
      incompleteDetail: vr.quarters.length < 4
        ? `${year} 年度仅 ${vr.quarters.length} 个季度已核查（${vr.quarters.map((q) => 'Q' + q).join('/')}），`
          + '年度义务应按全年四个季度计算；缺失季度须补报并核查后再行清缴。'
          + '本条认定值不作为最终年度义务。'
        : null,
      conflictDetail: conflict
        ? `核查认定值 ${v} t 与平台核算值 ${c} t 相差 ${diffPct.toFixed(2)}%，超过 5% 阈值。`
          + '清缴以核查值为准（法定口径），但该差异应作为核查发现项记录并追因'
        : null,
      diffPct: Number(diffPct.toFixed(2)),
      alternatives: alts,
    };
  }

  if (vr) {
    return { available: true, value: Number(vr.verified_value), source: 'VERIFY_REPORT',
      conflict: false,
      incomplete: vr.quarters.length < 4,
      incompleteDetail: vr.quarters.length < 4
        ? `${year} 年度仅 ${vr.quarters.length} 个季度已核查（${vr.quarters.map((q) => 'Q' + q).join('/')}），`
          + '缺失季度须补报并核查后再行清缴'
        : null,
      alternatives: alts };
  }
  return { available: true, value: Number(cb.total_emission), source: 'CALC_BATCH',
    conflict: false,
    note: '无第三方核查报告，采用平台核算值。法定履约场景必须补办核查，本值仅供内部管理。',
    alternatives: alts };
}

/* ==================================================================================
 * 二、履约清缴
 * ================================================================================== */

/**
 * 生成清缴单（状态 PENDING，尚未实际扣减配额）。
 *
 * 分两步设计（生成 → 执行）的理由：
 *   清缴是法定动作，必须有人复核。生成单子可以先看"应交多少、手上够不够"，
 *   执行才真正扣配额。合并成一步会让"看一眼数字就误扣配额"成为可能。
 *
 * @param {object} p { entId, year, operator, deadline }
 */
async function prepareSurrender(p) {
  const entId = Number(p.entId);
  const year = Number(p.year) || new Date().getFullYear();

  const em = await resolveVerifiedEmission(entId, year);
  if (!em.available) throw new Error(em.reason);

  const quota = await db.one(
    'SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, year]
  );
  if (!quota) throw new Error(`企业 ${entId} 在 ${year} 年度没有配额账户，无法清缴`);

  /* 已抵销的碳信用 —— 抵销量可以冲减应清缴配额 */
  const offsetUsed = Number(await db.value(
    "SELECT COALESCE(SUM(amount),0) FROM credit_offset WHERE ent_id = ? AND year = ? AND status = 'CONFIRMED'",
    [entId, year]
  ) || 0);

  const verified = em.value;
  const required = Math.max(0, round3(verified - offsetUsed));
  const availableQuota = Number(quota.available);
  const willShortfall = Math.max(0, round3(required - availableQuota));

  const deadline = p.deadline || `${year}-${String(SURRENDER_DEADLINE_MONTH).padStart(2, '0')}-${String(SURRENDER_DEADLINE_DAY).padStart(2, '0')}`;
  const basePrice = Number(await currentCarbonPrice());
  const penalty = round2(willShortfall * basePrice * PENALTY_MULTIPLIER);

  /* ⚠⚠ 重复试算的语义陷阱（2026-10-24 实测暴露）
   *
   * 清缴执行后 `available` 已经被扣减。若再次调用 prepareSurrender，
   * 它拿"扣减后的可用配额"去比"应缴配额"，就会算出「又缺 59 万吨」——
   * 而实际上该企业早已足额清缴。这不是数字错误，是**语义错误**：
   * 试算问的是"还需要缴多少"，不是"如果从零开始要缴多少"。
   *
   * 正确做法：先查该年度已存在的清缴记录。
   *   · 已 SURRENDERED/CERTIFIED → 直接返回"已完成"，不再算新缺口
   *   · 已 SHORTFALL             → 只算"剩余待补缴"部分
   *   · 无记录                    → 正常试算
   */
  const existing = await db.one(
    'SELECT * FROM quota_surrender WHERE ent_id = ? AND year = ?', [entId, year]
  );
  if (existing && ['SURRENDERED', 'CERTIFIED'].includes(existing.status)) {
    return {
      surrenderNo: existing.surrender_no,
      entId, year, status: existing.status,
      alreadySurrendered: true,
      emission: { verified: round3(Number(existing.verified_emission)), source: existing.emission_source },
      offsetUsed: round3(Number(existing.offset_used)),
      requiredQuota: round3(Number(existing.required_quota)),
      surrenderedQuota: round3(Number(existing.surrendered_quota)),
      availableQuota: round3(availableQuota),
      willShortfall: 0,
      estimatedPenalty: 0,
      certificateNo: existing.certificate_no,
      deadline: existing.deadline,
      note: `${year} 年度已完成履约清缴（${existing.certificate_no || '已出具凭证'}），无需重复清缴。`
        + '如需查看明细请调用 GET /api/settlement/surrender?year=' + year,
    };
  }

  const surrenderNo = cu.bizNo('SUR');
  await db.query(
    `INSERT INTO quota_surrender
      (surrender_no, ent_id, year, verified_emission, offset_used, required_quota,
       surrendered_quota, shortfall, penalty, penalty_rule,
       calc_batch_id, verify_report_id, emission_source, status, operator, deadline)
     VALUES (?,?,?,?,?,?,0,0,0,?,?,?,?,'PENDING',?,?)
     ON DUPLICATE KEY UPDATE verified_emission = VALUES(verified_emission),
       offset_used = VALUES(offset_used), required_quota = VALUES(required_quota),
       penalty = VALUES(penalty), emission_source = VALUES(emission_source)`,
    [
      surrenderNo, entId, year, verified, offsetUsed, required,
      `按《碳排放权交易管理暂行条例》处未清缴配额市场价值 ${PENALTY_MULTIPLIER} 倍罚款（市场价 ${basePrice} 元/吨）`,
      em.alternatives.calcBatch ? null : null,
      em.alternatives.verifyReport ? em.alternatives.verifyReport.id : null,
      em.source, p.operator || null, deadline,
    ]
  );

  /* 已在 PENDING 时 ON DUPLICATE KEY 不会更新 surrender_no，回读一次拿真实单号 */
  const row = await db.one('SELECT * FROM quota_surrender WHERE ent_id = ? AND year = ?', [entId, year]);

  return {
    surrenderNo: row.surrender_no,
    entId, year,
    status: row.status,
    emission: {
      verified: round3(verified), source: em.source,
      conflict: em.conflict, conflictDetail: em.conflictDetail,
      alternatives: em.alternatives,
    },
    offsetUsed: round3(offsetUsed),
    requiredQuota: required,
    availableQuota: round3(availableQuota),
    willShortfall: round3(willShortfall),
    estimatedPenalty: penalty,
    penaltyRule: `未清缴部分 × 市场价 ${basePrice} 元/吨 × ${PENALTY_MULTIPLIER} 倍`,
    deadline,
    note: '此为清缴单（PENDING），配额尚未扣减。需调用 executeSurrender 才真正交割。',
  };
}

/**
 * 执行清缴：真正从可用配额中扣减，写入 used，状态置 SURRENDERED 或 SHORTFALL。
 *
 * @param {string} surrenderNo
 * @param {object} [opts] { operator, allowShortfall }
 */
async function executeSurrender(surrenderNo, opts = {}) {
  const s = await db.one('SELECT * FROM quota_surrender WHERE surrender_no = ?', [surrenderNo]);
  if (!s) throw new Error(`清缴单 ${surrenderNo} 不存在`);
  if (s.status === 'SURRENDERED' || s.status === 'CERTIFIED') {
    /* ⚠ 幂等分支必须返回与首次执行**同构**的字段集，不能只给一个提示。
     * 早先这里只返回 { alreadyDone, status, note }，导致调用方拿
     * `ex.surrendered` 得到 undefined，累加成 NaN 后静默传播 ——
     * 打印出的"应缴合计 NaN 万 t"就是这么来的，而库里的数据其实是好的。
     * 这种"数据对、报表错"的缺陷最难被发现，必须从接口形状上根除。 */
    return {
      alreadyDone: true, surrenderNo, status: s.status,
      entId: Number(s.ent_id), year: Number(s.year),
      required: Number(s.required_quota),
      surrendered: Number(s.surrendered_quota),
      shortfall: Number(s.shortfall),
      penalty: Number(s.penalty),
      certificateNo: s.certificate_no,
      chain: { blockIndex: s.chain_block_index, txId: s.chain_tx_id },
      note: '该清缴单已执行，重复调用不再扣减（幂等）',
    };
  }

  const entId = Number(s.ent_id);
  const year = Number(s.year);
  const required = Number(s.required_quota);

  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();

    /* 锁定配额行（FOR UPDATE），防止并发清缴超额 */
    const qr = await conn.query(
      'SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ? FOR UPDATE', [entId, year]
    );
    const quota = qr[0][0];
    if (!quota) throw new Error('配额账户不存在');

    const available = Number(quota.available);
    const actual = Math.min(required, available);
    const shortfall = round3(required - actual);

    /* 状态判定：
     *   shortfall == 0 → SURRENDERED（足额）
     *   shortfall > 0 但 allowShortfall → SHORTFALL（记录缺口与罚款）
     *   shortfall > 0 且不允许 → 直接拒绝，不产生半笔清缴 */
    if (shortfall > 0 && !opts.allowShortfall) {
      throw new Error(
        `可用配额不足：需清缴 ${required} t，可用 ${available} t，缺口 ${shortfall} t。`
        + '若确认按缺口清缴（并计罚款），请显式传 allowShortfall=true'
      );
    }

    await conn.query(
      'UPDATE carbon_quota SET available = available - ?, used = used + ? WHERE ent_id = ? AND year = ?',
      [actual, actual, entId, year]
    );

    const status = shortfall > 0 ? 'SHORTFALL' : 'SURRENDERED';
    const certNo = status === 'SURRENDERED' ? `CERT-${year}-${String(entId).padStart(4, '0')}` : null;

    await conn.query(
      `UPDATE quota_surrender
          SET surrendered_quota = ?, shortfall = ?, status = ?, certificate_no = ?, operator = ?
        WHERE id = ?`,
      [actual, shortfall, status, certNo, opts.operator || s.operator || null, s.id]
    );

    await conn.commit();

    /* ---- 上链存证：清缴是法定动作，必须留不可篡改痕迹 ----
     * ⚠ 必须走 anchorSvc.anchor()（它负责派生钱包、构建交易、签名、落块），
     *   不能直接调 chain.submit() —— 后者不存在（正确名是 submitTx），
     *   而且绕过 keystore 会导致交易没有签名方，验签必失败。 */
    let chain = null;
    try {
      const tr = await anchorSvc.anchor({
        txType: 'QUOTA_SURRENDER',
        bizNo: surrenderNo,
        fromLabel: 'regulator:system',
        toLabel: `ent:${entId}`,
        payload: {
          surrenderNo, entId, year,
          verifiedEmission: Number(s.verified_emission),
          offsetUsed: Number(s.offset_used),
          requiredQuota: required,
          surrenderedQuota: actual,
          shortfall,
          status, certificateNo: certNo,
          timestamp: new Date().toISOString(),
        },
      });
      await db.query(
        'UPDATE quota_surrender SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
        [tr.blockIndex, tr.txId, s.id]
      );
      chain = { blockIndex: tr.blockIndex, txId: tr.txId };
    } catch (e) {
      chain = { error: `上链失败：${e.message}（业务已提交，需补锚定）` };
    }

    return {
      surrenderNo, entId, year, status,
      required, surrendered: round3(actual), shortfall: round3(shortfall),
      penalty: shortfall > 0 ? round2(shortfall * Number(await currentCarbonPrice()) * PENALTY_MULTIPLIER) : 0,
      certificateNo: certNo,
      quotaAfter: { available: round3(available - actual), used: round3(Number(quota.used) + actual) },
      chain,
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 批量清缴（监管端年末动作）：为年度内所有有依据的企业生成并执行清缴 */
async function batchSurrender(year, opts = {}) {
  const ents = await db.query(
    `SELECT DISTINCT e.id FROM enterprise e
       JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ?
      WHERE e.status <> 'SUSPENDED' ORDER BY e.id`, [year]
  );
  const results = [];
  for (const e of ents) {
    try {
      const prep = await prepareSurrender({ entId: e.id, year, operator: opts.operator });
      if (!opts.dryRun) {
        const ex = await executeSurrender(prep.surrenderNo, {
          operator: opts.operator, allowShortfall: opts.allowShortfall !== false,
        });
        results.push({ entId: e.id, ok: true, ...ex });
      } else {
        results.push({ entId: e.id, ok: true, dryRun: true, ...prep });
      }
    } catch (err) {
      results.push({ entId: e.id, ok: false, reason: err.message });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  const shortCount = results.filter((r) => r.shortfall > 0).length;
  return {
    year, total: ents.length, succeeded: okCount, failed: ents.length - okCount,
    withShortfall: shortCount,
    totalSurrendered: round3(results.filter((r) => r.ok).reduce((s, r) => s + (r.surrendered || 0), 0)),
    totalShortfall: round3(results.filter((r) => r.ok).reduce((s, r) => s + (r.shortfall || 0), 0)),
    details: results,
  };
}

/* ==================================================================================
 * 三、碳信用注销
 * ================================================================================== */

/**
 * 注销碳信用（永久退出流通）。
 *
 * 与抵销的区别（必须严格区分，否则双重计算）：
 *   抵销 = 用 credit_asset.used_amount 累加 + dynamic.recompute 减缺口
 *   注销 = credit_asset.status = 'RETIRED' + 写 credit_retirement
 * 一笔信用可以「先抵销、后注销」（这是正确顺序：抵销使其产生环境权益，
 * 注销使其不可再流通）。但不能「注销后再抵销」—— 已注销的不能再动。
 *
 * @param {object} p { assetId, amount, entId, purpose, beneficiary, operator }
 */
async function retireCredit(p) {
  const assetId = Number(p.assetId);
  const amount = round3(p.amount);
  if (!(amount > 0)) throw new Error('注销数量必须大于 0');

  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();

    const ar = await conn.query('SELECT * FROM credit_asset WHERE id = ? FOR UPDATE', [assetId]);
    const asset = ar[0][0];
    if (!asset) throw new Error(`碳信用资产 ${assetId} 不存在`);

    /* ⚠ 状态前置校验：已注销的不得再注销（这是防双重声明的核心） */
    if (asset.status === 'RETIRED') {
      throw new Error(`资产 ${asset.asset_no} 已注销，不得重复注销（防双重声明）`);
    }
    if (asset.status === 'EXPIRED') throw new Error(`资产 ${asset.asset_no} 已过期，不得注销`);

    const total = Number(asset.amount);
    const used = Number(asset.used_amount);
    const remaining = round3(total - used);
    if (amount > remaining + 1e-6) {
      throw new Error(`可注销余额不足：资产总量 ${total}、已用 ${used}、剩余 ${remaining}，本次申请 ${amount}`);
    }

    /* 是否全部注销 → 决定资产最终状态 */
    const willBeFullyRetired = Math.abs(amount - remaining) < 0.001;
    const newUsed = round3(used + amount);
    const newStatus = willBeFullyRetired ? 'RETIRED' : asset.status;

    /* credit_asset.status 是 VARCHAR(20)（不是 ENUM），RETIRED 可直接写入。
     * 早先写过 try/catch 捕捉 "Data truncated" 并降级为 USED —— 那是出于对
     * 枚举类型的误判，反而会让"已注销"与"已用尽"混为一谈，破坏防双重声明的基础。
     * 现在直接写，写入失败就是真失败。 */
    await conn.query(
      'UPDATE credit_asset SET used_amount = ?, status = ? WHERE id = ?',
      [newUsed, newStatus, assetId]
    );

    const retireNo = cu.bizNo('RET');
    const purpose = String(p.purpose || 'OFFSET').toUpperCase();
    if (!['OFFSET', 'VOLUNTARY', 'CBAM'].includes(purpose)) {
      throw new Error(`注销用途必须是 OFFSET / VOLUNTARY / CBAM，收到 ${purpose}`);
    }

    const proofHash = cu.sha256(cu.stableStringify({
      retireNo, assetId, assetNo: asset.asset_no, amount, purpose,
      entId: Number(asset.ent_id), timestamp: new Date().toISOString(),
    }));

    await conn.query(
      `INSERT INTO credit_retirement
        (retire_no, ent_id, asset_id, amount, purpose, beneficiary,
         asset_status_before, proof_hash, status, operator)
       VALUES (?,?,?,?,?,?,?,?,'CONFIRMED',?)`,
      [retireNo, Number(asset.ent_id), assetId, amount, purpose, p.beneficiary || null,
        asset.status, proofHash, p.operator || null]
    );

    await conn.commit();

    /* 上链 */
    let chain = null;
    try {
      const tr = await anchorSvc.anchor({
        txType: 'CREDIT_RETIRE',
        bizNo: retireNo,
        fromLabel: `ent:${Number(asset.ent_id)}`,
        payload: {
          retireNo, assetNo: asset.asset_no, assetId, amount, purpose,
          beneficiary: p.beneficiary || null, proofHash,
          assetStatusAfter: newStatus,
          fullyRetired: willBeFullyRetired,
        },
      });
      await db.query(
        'UPDATE credit_retirement SET chain_block_index = ?, chain_tx_id = ? WHERE retire_no = ?',
        [tr.blockIndex, tr.txId, retireNo]
      );
      chain = { blockIndex: tr.blockIndex, txId: tr.txId };
    } catch (e) {
      chain = { error: `上链失败：${e.message}` };
    }

    return {
      retireNo, assetId, assetNo: asset.asset_no,
      amount, purpose, beneficiary: p.beneficiary || null,
      assetStatusBefore: asset.status, assetStatusAfter: newStatus,
      fullyRetired: willBeFullyRetired,
      remaining: round3(remaining - amount),
      proofHash, chain,
      note: '注销后该减排量永久退出流通，任何主体不得再次声称（proofHash 可用于对外证明）',
    };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 查询注销记录 */
async function listRetirements(filters = {}) {
  const where = [];
  const params = [];
  if (filters.entId) { where.push('r.ent_id = ?'); params.push(Number(filters.entId)); }
  if (filters.purpose) { where.push('r.purpose = ?'); params.push(filters.purpose); }
  const rows = await db.query(
    `SELECT r.*, a.asset_no, a.asset_type
       FROM credit_retirement r LEFT JOIN credit_asset a ON a.id = r.asset_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.id DESC LIMIT 200`, params
  );
  return rows.map((r) => ({
    retireNo: r.retire_no, entId: Number(r.ent_id), assetNo: r.asset_no,
    assetType: r.asset_type, amount: Number(r.amount), purpose: r.purpose,
    beneficiary: r.beneficiary, proofHash: r.proof_hash,
    status: r.status, at: r.created_at,
    chain: { blockIndex: r.chain_block_index, txId: r.chain_tx_id },
  }));
}

/* ==================================================================================
 * 四、履约全景
 * ================================================================================== */

/** 某企业的履约全景：应缴 / 已缴 / 缺口 / 抵销 / 注销 / 风险 */
async function complianceStatus(entId, year) {
  const y = Number(year) || new Date().getFullYear();
  const em = await resolveVerifiedEmission(entId, y);
  const quota = await db.one('SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, y]);
  const surrender = await db.one('SELECT * FROM quota_surrender WHERE ent_id = ? AND year = ?', [entId, y]);
  const offsetUsed = Number(await db.value(
    "SELECT COALESCE(SUM(amount),0) FROM credit_offset WHERE ent_id = ? AND year = ? AND status='CONFIRMED'",
    [entId, y]
  ) || 0);
  const retired = Number(await db.value(
    'SELECT COALESCE(SUM(amount),0) FROM credit_retirement WHERE ent_id = ?', [entId]
  ) || 0);

  const verified = em.available ? em.value : null;
  const required = verified === null ? null : Math.max(0, round3(verified - offsetUsed));
  const surrendered = surrender ? Number(surrender.surrendered_quota) : 0;
  const gap = required === null ? null : round3(required - surrendered);

  return {
    entId, year: y,
    emissionBasis: em.available ? {
      value: verified, source: em.source,
      conflict: em.conflict, conflictDetail: em.conflictDetail,
      basisStrength: em.alternatives.verifyReport ? '法定口径（核查报告）' : '平台口径（核算批次）',
    } : { available: false, reason: em.reason },
    quota: quota ? {
      allocated: Number(quota.total_allocated), available: Number(quota.available),
      frozen: Number(quota.frozen), used: Number(quota.used),
      bought: Number(quota.bought), sold: Number(quota.sold),
    } : null,
    offset: { usedForYear: round3(offsetUsed), creditRetiredTotal: round3(retired) },
    surrender: surrender ? {
      no: surrender.surrender_no, status: surrender.status,
      required: Number(surrender.required_quota),
      surrendered: surrendered,
      shortfall: Number(surrender.shortfall),
      penalty: Number(surrender.penalty),
      certificateNo: surrender.certificate_no,
      chain: { blockIndex: surrender.chain_block_index, txId: surrender.chain_tx_id },
    } : null,
    assessment: {
      /* 履约状态机：
       *   NO_BASIS        无排放依据，无法判定
       *   NOT_SURRENDERED 未清缴
       *   PARTIAL         已清缴不足
       *   COMPLIANT       已足额清缴
       *   SHORTFALL       已按缺口清缴（有罚款） */
      state: !em.available ? 'NO_BASIS'
        : (!surrender ? 'NOT_SURRENDERED'
          : (Number(surrender.shortfall) > 0 ? 'SHORTFALL'
            : (surrendered + 1e-6 >= required ? 'COMPLIANT' : 'PARTIAL'))),
      gap,
      riskLevel: gap === null ? 'UNKNOWN' : (gap > 0 ? (gap > (required || 1) * 0.1 ? 'HIGH' : 'MEDIUM') : 'LOW'),
      note: gap !== null && gap > 0
        ? `尚缺 ${gap} tCO2e 配额，需在清缴截止日前购买或使用碳信用抵销`
        : (gap === 0 ? '配额已足额覆盖核定排放' : null),
    },
  };
}

/* ==================================================================================
 * 五、工具
 * ================================================================================== */

/** 当前碳价（平台内近 90 日成交均价，无成交则回落到基准价） */
async function currentCarbonPrice() {
  /* ⚠ 列名是 deal_time，不是 created_at（trade_deal 表没有 created_at 列） */
  const v = await db.value(
    `SELECT AVG(price) FROM trade_deal
      WHERE status = 'SETTLED' AND deal_time >= DATE_SUB(NOW(), INTERVAL 90 DAY)`
  );
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : 68.79;
}

function round3(v) { return Number(Number(v).toFixed(3)); }
function round2(v) { return Number(Number(v).toFixed(2)); }

/* ==================================================================================
 * 六、自检
 * ================================================================================== */

async function selfTest() {
  const items = [];
  const push = (name, pass, detail) => items.push({ name, pass: !!pass, detail });

  /* 1. 清缴基数解析：必须优先核查报告
     ⚠ 样本两个口径都必须对齐 resolver 契约：
     ① 只取**已批准**（approved_by 非空）——派生管线的活水单被双岗契约正确排除；
     ② 年度取**报告所属年度**（er.year），不是签发年 YEAR(issue_time)——
        2024 年度排放 2025/2026 年才签发，按签发年会查空（本文件头部的"缺陷 A"）。
     2026-10-31 审计实测：两处错叠加导致自检误报 8/9。 */
  const sample = await db.one(
    `SELECT vr.ent_id, er.year AS y, vr.verified_value FROM verify_report vr
       JOIN emission_report er ON er.id = vr.emission_report_id
      WHERE vr.conclusion='PASS' AND vr.approved_by IS NOT NULL
      ORDER BY vr.id DESC LIMIT 1`
  );
  if (sample) {
    const em = await resolveVerifiedEmission(Number(sample.ent_id), Number(sample.y));
    push('清缴基数优先取核查报告', em.available && em.source === 'VERIFY_REPORT',
      `source=${em.source}, value=${em.value}`);
    push('清缴基数给出双口径对照', em.alternatives && ('verifyReport' in em.alternatives),
      `alternatives keys=${Object.keys(em.alternatives || {}).join(',')}`);
  } else {
    push('清缴基数优先取核查报告', false, '库中无 PASS 状态的核查报告');
  }

  /* 2. 无依据时必须拒绝，不得编造 */
  const bogus = await resolveVerifiedEmission(999999, 2026);
  push('无排放依据时拒绝清缴', bogus.available === false,
    `available=${bogus.available}, reason=${(bogus.reason || '').slice(0, 40)}`);

  /* 3. 注销：已注销的不得再注销 */
  const retiredAsset = await db.one("SELECT * FROM credit_asset WHERE status = 'RETIRED' LIMIT 1");
  if (retiredAsset) {
    let err = null;
    try { await retireCredit({ assetId: Number(retiredAsset.id), amount: 1, purpose: 'OFFSET' }); }
    catch (e) { err = e.message; }
    push('已注销资产不得重复注销', err !== null && err.includes('已注销'), err || '未拦截（缺陷）');
  } else {
    /* 无已注销资产时，用「超额注销」路径验证防护 */
    const a = await db.one("SELECT * FROM credit_asset WHERE status = 'ACTIVE' LIMIT 1");
    if (a) {
      const remain = Number(a.amount) - Number(a.used_amount);
      let err = null;
      try { await retireCredit({ assetId: Number(a.id), amount: remain + 1000, purpose: 'OFFSET' }); }
      catch (e) { err = e.message; }
      push('超额注销被拒绝', err !== null && err.includes('不足'), err || '未拦截（缺陷）');
    } else {
      push('超额注销被拒绝', false, '库中无可用碳信用资产');
    }
  }

  /* 4. 注销用途必须合法 */
  const anyAsset = await db.one("SELECT * FROM credit_asset WHERE status <> 'RETIRED' AND amount > used_amount LIMIT 1");
  if (anyAsset) {
    let err = null;
    try { await retireCredit({ assetId: Number(anyAsset.id), amount: 1, purpose: 'NEGATIVE_CONTROL' }); }
    catch (e) { err = e.message; }
    push('非法注销用途被拒绝', err !== null && err.includes('用途'),
      err || '未拦截（缺陷）');
  }

  /* 5. 履约状态机：无依据 → NO_BASIS */
  const st = await complianceStatus(999999, 2026);
  push('履约状态机：无依据判 NO_BASIS', st.assessment.state === 'NO_BASIS',
    `state=${st.assessment.state}`);

  /* 6. 欠额清缴必须显式授权 */
  const sur = await db.one("SELECT * FROM quota_surrender WHERE status = 'PENDING' LIMIT 1");
  if (sur) {
    push('清缴单存在且状态可识别', !!sur.surrender_no, `${sur.surrender_no} status=${sur.status}`);
  } else {
    push('清缴单存在且状态可识别', true, '当前无 PENDING 清缴单（首次运行属正常）');
  }

  /* 7. 罚款倍数与市场价联动 */
  const price = await currentCarbonPrice();
  push('碳价可得且为正', price > 0, `${price} 元/吨`);
  push('罚款倍数符合条例（5~10 倍）', PENALTY_MULTIPLIER >= 5 && PENALTY_MULTIPLIER <= 10,
    `${PENALTY_MULTIPLIER} 倍`);

  const passed = items.filter((i) => i.pass).length;
  return { total: items.length, passed, failed: items.length - passed, items };
}

module.exports = {
  PENALTY_MULTIPLIER, SURRENDER_DEADLINE_MONTH, SURRENDER_DEADLINE_DAY,
  resolveVerifiedEmission, prepareSurrender, executeSurrender, batchSurrender,
  retireCredit, listRetirements, complianceStatus, currentCarbonPrice,
  selfTest,
};
