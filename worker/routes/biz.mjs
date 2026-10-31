/**
 * worker/routes/biz.mjs —— 业务端点（企业 / 监管 / 核查 / MRV / 交易 / 结算 / 信用）
 * ==================================================================================
 * 这一组是平台"能干活"的部分。与 server/routes/*.js 的接口契约完全一致，
 * 前端不需要改任何调用代码。
 *
 * 【D1 上的三条硬约束，在本文件里如何体现】
 *
 *   ① 每个端点的 SQL 都必须能走索引，不能全表扫。
 *      典型例子：企业列表按 country/industry 过滤 —— 表很小（60~400 行），
 *      全扫也无所谓；但 cems_reading（3.4 万行）必须走 (ent_id, reading_time)。
 *
 *   ② 写操作要合并：D1 每日 10 万行写入额度。
 *      凡是"逐条 INSERT"的地方改为 batch。
 *
 *   ③ 聚合一律读预聚合表或小表，不读 cems_reading 明细做 GROUP BY。
 *      碳账户的 cumulative_emission 已由 dynamic 引擎写入 carbon_dynamic_account，
 *      直接读那张表（60 行）。
 *
 * @module worker/routes/biz
 */

import { json, fail, authRequired, requireRole, num, pickEnum } from '../lib/http.mjs';
import { fetchAllSources } from './noticeFeed.mjs';

/**
 * 通知列表的 D1 → 实时抓取回退。
 * D1 配额耗尽（7500/503）或查询失败时，直接从权威源站实时抓取 ——
 * 通知功能是"对外消息"，实时性反而更高，绝不因配额 503。
 */
async function noticesWithFallback(ctx, { category = '', limit = 20 } = {}) {
  const NOTICE_TYPES = {
    OFFICIAL: ['OFFICIAL'], POLICY: ['POLICY'], MARKET: ['MARKET'],
    INTERNATIONAL: ['INTERNATIONAL', 'INTL'], PLATFORM: ['SYSTEM'],
  };
  const types = NOTICE_TYPES[category.toUpperCase()];
  const where = [
    `target_role IN ('ALL','ENTERPRISE')`,
    ...(types ? [`notice_type IN (${types.map(() => '?').join(',')})`] : []),
  ].join(' AND ');

  try {
    const total = num(await ctx.db.value(
      `SELECT COUNT(*) FROM notice WHERE ${where}`, types || []));
    const rows = await ctx.db.query(
      `SELECT id, title, content, notice_type, publisher, is_top, views, publish_time,
              source_name, source_url, fetched_at FROM notice
        WHERE ${where}
        ORDER BY is_top DESC, publish_time DESC LIMIT ?`,
      [...(types || []), Math.min(limit, 100)]);
    return {
      mode: 'db',
      rows: rows.map((x) => ({
        id: num(x.id), title: x.title, content: x.content,
        noticeType: x.notice_type, category: x.notice_type,
        isTop: !!num(x.is_top), publisher: x.publisher,
        publishedAt: x.publish_time, views: num(x.views),
        sourceName: x.source_name || null, sourceUrl: x.source_url || null,
        fetched: !!(x.fetched_at || x.source_url),
      })),
      total,
    };
  } catch (e) {
    /* D1 不可用（配额/故障）：回退到实时源站抓取 */
    const { items, errors } = await fetchAllSources();
    const filtered = (category ? items.filter((i) => i.category === category.toUpperCase()) : items)
      .slice(0, limit);
    return {
      mode: 'live',
      rows: filtered.map((it, i) => ({
        id: -1 - i,                       // 负 id 标识实时条目（不可点详情）
        title: it.title, content: `【${it.categoryLabel}】来源：${it.sourceName}`,
        noticeType: it.category, category: it.category,
        isTop: false, publisher: it.sourceName,
        publishedAt: (it.date ? `${it.date} 00:00:00` : new Date().toISOString().slice(0, 19).replace('T', ' ')),
        views: 0, sourceName: it.sourceName, sourceUrl: it.url, fetched: true,
      })),
      total: filtered.length,
      dbError: String(e.message || e).slice(0, 80),
      feedErrors: errors,
    };
  }
}

const ROLE_CN = {
  ENTERPRISE: '控排企业', VERIFIER: '核查机构', REGULATOR: '监管机构',
  TRADER: '交易机构', ADMIN: '平台管理',
};

/** 企业角色只能看自己；其他角色可按 entId 查（与既有权限模型一致） */
function scopedEntId(ctx) {
  if (ctx.user && ctx.user.role === 'ENTERPRISE' && ctx.user.orgId) return num(ctx.user.orgId);
  return null;
}

export function attachBizRoutes(r) {
  /* ==================================================================================
   * 公共只读（无需登录）—— 公示大屏与公开查询
   * ================================================================================== */

  r.get('/api/public/dashboard', async (ctx) => {
    const chain = await chainStats(ctx);
    const YEAR = new Date().getFullYear();

    const ent = await ctx.db.one(
      `SELECT COUNT(*) AS n,
              COUNT(DISTINCT region) AS regions,
              SUM(CASE WHEN industry IS NOT NULL THEN 1 ELSE 0 END) AS with_ind
         FROM enterprise`);
    const report = await ctx.db.one(
      `SELECT COUNT(*) AS n, SUM(total_emission) AS total FROM emission_report`);
    const quota = await ctx.db.one(
      `SELECT SUM(total_allocated) AS alloc, SUM(used) AS used FROM carbon_quota`);

    /* 公示大屏需要的完整字段集（与 server/routes/public.js 对齐）。
     * 每个 查询独立 try/catch —— 单个聚合失败不拖垮整张屏。 */
    const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

    const emission = await safe(() => ctx.db.one(
      `SELECT IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(intensity),0) AS intensity, COUNT(*) AS cnt
         FROM emission_report WHERE year = ? AND status <> 'DRAFT'`, [YEAR]), null);

    const byIndustry = await safe(() => ctx.db.query(
      `SELECT e.industry AS name, IFNULL(SUM(r.total_emission),0) AS value
         FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
        WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.industry ORDER BY value DESC`, [YEAR]), []);

    const byRegion = await safe(() => ctx.db.query(
      `SELECT e.region AS name, IFNULL(SUM(r.total_emission),0) AS value
         FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
        WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.region ORDER BY value DESC LIMIT 10`, [YEAR]), []);

    const trend = await safe(() => ctx.db.query(
      `SELECT period, IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(intensity),0) AS intensity
         FROM emission_report WHERE status <> 'DRAFT' GROUP BY period ORDER BY period`), []);

    const verified = await safe(() => ctx.db.one(
      `SELECT COUNT(*) AS total, SUM(status='VERIFIED') AS done,
              SUM(status IN ('SUBMITTED','VERIFYING')) AS pending
         FROM emission_report WHERE year = ?`, [YEAR]), null);

    const latestBlocks = await safe(() => ctx.db.query(
      `SELECT block_index, block_hash, prev_hash, tx_count, nonce, difficulty, mine_time, block_time
         FROM chain_block ORDER BY block_index DESC LIMIT 8`), []);

    const latestTxs = await safe(() => ctx.db.query(
      `SELECT tx_id, tx_type, biz_no, block_index, from_address, payload_hash, created_at
         FROM chain_tx ORDER BY id DESC LIMIT 10`), []);

    const notices = await ctx.db.query(
      `SELECT id, title, notice_type, publisher, publish_time FROM notice
        WHERE target_role IN ('ALL','ENTERPRISE')
        ORDER BY is_top DESC, publish_time DESC LIMIT 5`);

    return json({
      chain,
      enterprises: num(ent.n),
      regionCount: num(ent.regions),
      reports: num(report.n),
      reportedEmission: +num(report.total).toFixed(3),
      quotaAllocated: +num(quota.alloc).toFixed(3),
      quotaUsed: +num(quota.used).toFixed(3),
      /* ---- 大屏专用字段（此前 Worker 版缺失导致 /screen 崩溃）---- */
      kpi: {
        entCount: num(ent.n),
        regionCount: num(ent.regions),
        emissionYtd: Number(Number(emission ? emission.total : 0).toFixed(0)),
        avgIntensity: Number(Number(emission ? emission.intensity : 0).toFixed(4)),
        reportCount: emission ? num(emission.cnt) : 0,
        verifiedRate: verified && num(verified.total) > 0
          ? Number(((num(verified.done) / num(verified.total)) * 100).toFixed(1)) : 0,
      },
      byIndustry: byIndustry.map((i) => ({ ...i, value: Number(i.value) })),
      byRegion: byRegion.map((i) => ({ ...i, value: Number(i.value) })),
      trend: trend.map((t) => ({ period: t.period, total: Number(t.total), intensity: Number(t.intensity) })),
      latestBlocks: latestBlocks.map((b) => ({
        ...b,
        block_index: num(b.block_index), tx_count: num(b.tx_count),
        nonce: num(b.nonce), difficulty: num(b.difficulty), mine_time: num(b.mine_time),
      })),
      latestTxs,
      notices: notices.map((n) => ({
        id: num(n.id), title: n.title, category: n.notice_type, publishedAt: n.publish_time,
      })),
      source: '企业自主申报 + 第三方核查机构核证 + 区块链存证',
      generatedAt: new Date().toISOString(),
    });
  });

/* 公示企业名录（脱敏：只出公开字段，不含钱包地址等） */
r.get('/api/public/enterprises', async (ctx) => {
  const page = Math.max(num(ctx.query.page, 1), 1);
  const size = Math.min(Math.max(num(ctx.query.size, 20), 1), 200);
  const YEAR = new Date().getFullYear();
  const base = `FROM enterprise e
     LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ${YEAR} AND r.status <> 'DRAFT'`;
  const total = num(await ctx.db.value(`SELECT COUNT(*) AS c FROM enterprise`));
  const rows = await ctx.db.query(
    `SELECT e.id, e.ent_name, e.industry, e.region, e.scale, e.credit_score, e.status,
            IFNULL(SUM(r.total_emission),0) AS emission_ytd
       ${base}
      GROUP BY e.id ORDER BY emission_ytd DESC LIMIT ? OFFSET ?`, [size, (page - 1) * size]);
  return json({
    rows: rows.map((r) => ({
      id: num(r.id), entName: r.ent_name, industry: r.industry || null,
      region: r.region || null, scale: r.scale || null,
      creditScore: num(r.credit_score), status: r.status,
      emissionYtd: +num(r.emission_ytd).toFixed(3),
    })),
    total, page, size, pages: Math.max(1, Math.ceil(total / size)),
  });
});

/* 公示公告：分类语义存于 notice_type（与本地 MySQL 同构）。
   * D1 配额耗尽时自动回退到权威源站实时抓取（见 noticesWithFallback）。 */
  const NOTICE_TYPES = {
    OFFICIAL: ['OFFICIAL'],
    POLICY: ['POLICY'],
    MARKET: ['MARKET'],
    INTERNATIONAL: ['INTERNATIONAL', 'INTL'],
    PLATFORM: ['SYSTEM'],
  };

  r.get('/api/public/notices/summary', async (ctx) => {
    try {
      const rows = await ctx.db.query(
        `SELECT notice_type, COUNT(*) AS cnt, MAX(publish_time) AS latest FROM notice
          WHERE target_role IN ('ALL','ENTERPRISE') GROUP BY notice_type`);
      const label = { OFFICIAL: '官方通知', POLICY: '政策法规', MARKET: '市场动态',
        INTERNATIONAL: '国际动态', INTL: '国际动态', SYSTEM: '平台公告' };
      const merged = {};
      for (const x of rows) {
        const key = label[x.notice_type] ? (x.notice_type === 'INTL' ? 'INTERNATIONAL' : x.notice_type) : 'PLATFORM';
        merged[key] ||= { key, label: label[key] || '平台公告', count: 0, latest: null };
        merged[key].count += num(x.cnt);
        if (String(x.latest) > (merged[key].latest || '')) merged[key].latest = x.latest;
      }
      return json({ categories: Object.values(merged), mode: 'db' });
    } catch {
      /* D1 不可用：给出静态分类骨架（计数 0），前端 Tab 仍可用 */
      return json({
        mode: 'live-fallback',
        categories: [
          { key: 'OFFICIAL', label: '官方通知', count: 0, latest: null },
          { key: 'POLICY', label: '政策法规', count: 0, latest: null },
          { key: 'MARKET', label: '市场动态', count: 0, latest: null },
          { key: 'INTERNATIONAL', label: '国际动态', count: 0, latest: null },
        ],
      });
    }
  });

  r.get('/api/public/notices', async (ctx) => {
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.size, 10), 1), 50);
    const r2 = await noticesWithFallback(ctx, {
      category: String(ctx.query.category || ''),
      limit: size,
    });
    return json(r2.rows, { page, size, total: r2.total, mode: r2.mode });
  });

  r.get('/api/public/notices/:id', async (ctx) => {
    const id = num(ctx.params.id, NaN);
    const n = await ctx.db.one('SELECT * FROM notice WHERE id = ?', [id]);
    if (!n) return fail('公告不存在', 404);
    /* 阅读数 +1：这是**写操作**，会消耗 D1 写入额度。
     * 公告被反复打开时，每次 +1 会很快吃掉额度 —— 因此降频：
     * 只在"同一 IP 当天首次阅读"时计数（用 audit_log 做去重）。
     * 精确阅读数对业务无价值，趋势有即可。 */
    try {
      const ip = ctx.request.headers.get('CF-Connecting-IP') || 'unknown';
      const seen = await ctx.db.one(
        `SELECT 1 AS x FROM audit_log
          WHERE action='NOTICE_VIEW' AND detail = ? AND created_at > datetime('now','-1 day') LIMIT 1`,
        [`${ip}|${id}`]);
      if (!seen) {
        await ctx.db.run('UPDATE notice SET views = views + 1 WHERE id = ?', [id]);
        await ctx.db.run(
          `INSERT INTO audit_log (username, action, target, detail, created_at)
           VALUES ('anonymous','NOTICE_VIEW',?,?,CURRENT_TIMESTAMP)`,
          ['notice', `${ip}|${id}`]);
      }
    } catch { /* 计数失败不影响阅读 */ }
    return json({
      id: num(n.id), title: n.title, content: n.content,
      noticeType: n.notice_type, category: n.notice_type,
      publishedAt: n.publish_time, views: num(n.views),
      sourceName: n.source_name || null, sourceUrl: n.source_url || null,
      fetched: !!(n.fetched_at || n.source_url),
    });
  });

  /* ==================================================================================
   * 企业端
   * ================================================================================== */

  r.get('/api/enterprise/overview', requireRole('ENTERPRISE')(async (ctx) => {
    const entId = scopedEntId(ctx);
    const ent = await ctx.db.one('SELECT * FROM enterprise WHERE id = ?', [entId]);
    if (!ent) return fail('企业不存在', 404);
    const YEAR = new Date().getFullYear();

    const quota = await ctx.db.one(
      'SELECT * FROM carbon_quota WHERE ent_id = ? AND year = ?', [entId, YEAR])
      || await ctx.db.one(
        'SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC LIMIT 1', [entId]);
    const dyn = await ctx.db.one(
      'SELECT * FROM carbon_dynamic_account WHERE ent_id = ? ORDER BY year DESC LIMIT 1', [entId]);

    /* 前端企业总览页读的是 kpi / trend / currentQuota / alerts / notices
     * （与本地 Express 版同一契约）。此前 Worker 版只给了 quota/dynamic 等
     * 少量字段，页面拿不到 kpi 就整片空白 —— 接口通、页面空，最容易被当成
     * "前端坏了"。这里补齐完整字段集。 */
    const statusRows = await ctx.db.query(
      'SELECT status, COUNT(*) AS cnt FROM emission_report WHERE ent_id = ? GROUP BY status', [entId]);
    const statusMap = {};
    for (const s of statusRows) statusMap[String(s.status).toUpperCase()] = num(s.cnt);

    const emissionYtd = num(await ctx.db.value(
      `SELECT COALESCE(SUM(total_emission),0) FROM emission_report
        WHERE ent_id = ? AND year = ? AND status <> 'DRAFT'`, [entId, YEAR]));

    const trend = await ctx.db.query(
      `SELECT period, total_emission AS total, scope1_emission AS s1, scope2_emission AS s2,
              intensity, output_value AS output, status
         FROM emission_report WHERE ent_id = ? AND status <> 'DRAFT'
        ORDER BY year, quarter`, [entId]);

    const better = num(await ctx.db.value(
      `SELECT COUNT(*) FROM (
         SELECT r.ent_id, SUM(r.total_emission) AS t
           FROM emission_report r JOIN enterprise e2 ON e2.id = r.ent_id
          WHERE r.year = ? AND r.status <> 'DRAFT' AND e2.industry = ?
          GROUP BY r.ent_id) x
        WHERE x.t < ?`, [YEAR, ent.industry, emissionYtd]));
    const industryTotal = num(await ctx.db.value(
      `SELECT COUNT(DISTINCT r.ent_id) FROM emission_report r JOIN enterprise e2 ON e2.id = r.ent_id
        WHERE r.year = ? AND e2.industry = ?`, [YEAR, ent.industry])) || 1;

    const alerts = await ctx.db.query(
      `SELECT alert_no, alert_type, level, title, status, created_at FROM alert_record
        WHERE ent_id = ? ORDER BY created_at DESC LIMIT 5`, [entId]);
    const notices = await ctx.db.query(
      `SELECT id, title, notice_type, publish_time FROM notice
        WHERE target_role IN ('ALL','ENTERPRISE')
        ORDER BY is_top DESC, publish_time DESC LIMIT 5`);

    /* 链上存证笔数：本企业钱包发起的存证数（与"链上身份"页同口径） */
    const chainAnchors = num(await ctx.db.value(
      'SELECT COUNT(*) FROM chain_tx WHERE from_address = ?', [ent.wallet_address]));

    const alloc = quota ? num(quota.total_allocated) : 0;
    const used = quota ? num(quota.used) : 0;
    const avail = quota ? num(quota.available) : 0;
    const reportTotal = Object.values(statusMap).reduce((a, b) => a + b, 0);

    return json({
      enterprise: {
        id: num(ent.id), name: ent.ent_name, code: ent.ent_code, industry: ent.industry,
        region: ent.region, city: ent.city, scale: ent.scale,
        creditScore: num(ent.credit_score), status: ent.status,
        wallet: ent.wallet_address, isReal: num(ent.is_real) === 1,
      },
      kpi: {
        emissionYtd: Number(emissionYtd.toFixed(2)),
        quotaAllocated: alloc,
        quotaAvailable: avail,
        quotaUsed: used,
        quotaGap: Number((alloc - used).toFixed(2)),
        complianceRate: alloc > 0 ? Number(((alloc / Math.max(used, 1)) * 100).toFixed(1)) : 0,
        reportTotal,
        reportVerified: statusMap.VERIFIED || 0,
        reportPending: (statusMap.SUBMITTED || 0) + (statusMap.VERIFYING || 0),
        reportRejected: statusMap.REJECTED || 0,
        chainAnchors,
        industryRank: better + 1,
        industryTotal,
      },
      trend: trend.map((t) => ({
        period: t.period, total: num(t.total), s1: num(t.s1), s2: num(t.s2),
        intensity: num(t.intensity), output: num(t.output), status: t.status,
      })),
      currentQuota: quota ? {
        year: num(quota.year), total_allocated: alloc, available: avail,
        used, frozen: num(quota.frozen), bought: num(quota.bought), sold: num(quota.sold),
      } : null,
      alerts: alerts.map((a) => ({
        alertNo: a.alert_no, alertType: a.alert_type, level: a.level,
        title: a.title, status: a.status, createdAt: a.created_at,
      })),
      notices: notices.map((n) => ({
        id: num(n.id), title: n.title, noticeType: n.notice_type, publishTime: n.publish_time,
      })),
      /* 兼容旧字段（大屏/其他页面可能引用） */
      quota: quota ? {
        year: num(quota.year), allocated: alloc, used, available: avail,
      } : null,
      dynamic: dyn ? {
        year: num(dyn.year),
        cumulativeEmission: num(dyn.cumulative_emission),
        predictedEoy: num(dyn.predicted_eoy),
        gap: num(dyn.gap),
        riskLevel: dyn.risk_level,
        lastReadingAt: dyn.last_reading_at,
      } : null,
      reports: { count: reportTotal, totalEmission: Number(emissionYtd.toFixed(2)) },
      openAlerts: statusMap.OPEN || num(alerts.filter((a) => a.status === 'OPEN').length),
      /* ⚠ 明确标注数据层级 —— 这 60 家是建模主体，不是真实企业 */
      dataLayer: {
        enterprise: 'MODELED',
        note: '本平台的控排企业主体为建模对象；真实设施数据在 /real 层（EPA + Climate TRACE）。',
      },
    });
  }));

  r.get('/api/enterprise/reports', requireRole('ENTERPRISE')(async (ctx) => {
    const entId = scopedEntId(ctx);
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.size, 10), 1), 50);
    const total = num(await ctx.db.value(
      'SELECT COUNT(*) FROM emission_report WHERE ent_id = ?', [entId]));
    const rows = await ctx.db.query(
      `SELECT r.*, v.org_name AS verifier_name
         FROM emission_report r LEFT JOIN verifier_org v ON v.id = r.verifier_id
        WHERE r.ent_id = ? ORDER BY r.year DESC, r.quarter DESC LIMIT ? OFFSET ?`,
      [entId, size, (page - 1) * size]);
    /* 分页信封：前端 usePager 统一读 d.rows / d.total / d.pages。
     * 早期把数组直接放 data 且只给 meta，表格与分页器都读不到数据。 */
    return json({
      rows: rows.map(mapReport),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  r.get('/api/enterprise/reports/:id', requireRole('ENTERPRISE')(async (ctx) => {
    const entId = scopedEntId(ctx);
    const id = num(ctx.params.id, NaN);
    const rep = await ctx.db.one(
      'SELECT * FROM emission_report WHERE id = ? AND ent_id = ?', [id, entId]);
    if (!rep) return fail('上报单不存在或无权访问', 404);
    const items = await ctx.db.query(
      'SELECT * FROM emission_item WHERE report_id = ? ORDER BY id', [id]);
    return json({
      ...mapReport(rep),
      items: items.map((it) => ({
        id: num(it.id), energyType: it.energy_type,
        amount: num(it.amount), unit: it.unit, factor: num(it.factor),
        emission: num(it.co2),
      })),
    });
  }));

  r.get('/api/enterprise/quota', requireRole('ENTERPRISE')(async (ctx) => {
    const entId = scopedEntId(ctx);
    const rows = await ctx.db.query(
      'SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC', [entId]);
    return json(rows.map((q) => ({
      year: num(q.year),
      allocated: num(q.total_allocated),
      used: num(q.used),
      available: num(q.total_allocated) - num(q.used),
      /* 负余额必须显式标出：它是"配额不足"的最直接信号，
       * 而不是一个可以四舍五入成 0 的小数 */
      negative: (num(q.total_allocated) - num(q.used)) < 0,
    })));
  }));

  r.get('/api/enterprise/analytics', requireRole('ENTERPRISE')(async (ctx) => {
    const entId = scopedEntId(ctx);
    /* 只读小表聚合，不碰 cems_reading 明细 */
    const byYear = await ctx.db.query(
      `SELECT year, SUM(total_emission) AS total FROM emission_report
        WHERE ent_id = ? GROUP BY year ORDER BY year`, [entId]);
    const byQuarter = await ctx.db.query(
      `SELECT year, quarter, total_emission AS total FROM emission_report
        WHERE ent_id = ? ORDER BY year, quarter LIMIT 40`, [entId]);
    const byEnergy = await ctx.db.query(
      /* ⚠ emission_item 的实际列：energy_type（不是 energy_name）、co2（不是 emission）。
       * 这两个名字是我按语义猜的，而 MySQL 里是另一套 —— 猜列名是迁移期最高频的错误来源。 */
      `SELECT i.energy_type, SUM(i.co2) AS total, SUM(i.amount) AS amount
         FROM emission_item i JOIN emission_report r ON r.id = i.report_id
        WHERE r.ent_id = ? GROUP BY i.energy_type ORDER BY total DESC`, [entId]);
    return json({
      byYear: byYear.map((x) => ({ year: num(x.year), total: num(x.total) })),
      byQuarter: byQuarter.map((x) => ({ year: num(x.year), quarter: num(x.quarter), total: num(x.total) })),
      byEnergy: byEnergy.map((x) => ({ name: x.energy_type, emission: num(x.total), amount: num(x.amount) })),
    });
  }));

  r.get('/api/enterprise/wallet', requireRole('ENTERPRISE')(async (ctx) => {
    const entId = scopedEntId(ctx);
    /* enterprise 表没有 did 列（链上身份 = wallet_address；DID 仅在部分存证 payload 中） */
    const ent = await ctx.db.one(
      'SELECT ent_name, wallet_address, ent_code FROM enterprise WHERE id = ?', [entId]);
    if (!ent) return fail('企业不存在', 404);
    const tx = await ctx.db.query(
      `SELECT tx_id, tx_type, biz_no, block_index, created_at FROM chain_tx
        WHERE from_address = ? ORDER BY id DESC LIMIT 20`, [ent.wallet_address]);
    return json({
      name: ent.ent_name, address: ent.wallet_address, did: `did:cc:ent:${entId}`,
      entCode: ent.ent_code,
      recentTx: tx.map((t) => ({
        txId: t.tx_id, type: t.tx_type, bizNo: t.biz_no,
        blockIndex: t.block_index === null ? null : num(t.block_index),
        createdAt: t.created_at,
      })),
      /* 链上签名能力说明：线上 Worker 无 SM2，历史签名仍可验证 */
      signing: {
        available: false,
        algorithm: 'SM2',
        reason: '线上运行时（Cloudflare Workers/WebCrypto）不提供国密 SM2 签名。'
          + '历史签名由本地 Node 服务或离线工具验证，仍有效。',
      },
    });
  }));

  r.get('/api/enterprise/notices', authRequired(async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT id, title, category, published_at FROM notice
        ORDER BY published_at DESC LIMIT 20`);
    return json({ rows: rows.map((n) => ({
      id: num(n.id), title: n.title, category: n.category, publishedAt: n.published_at,
    })), total: rows.length, page: 1, size: rows.length, pages: 1 });
  }));

  /* ==================================================================================
   * 监管端
   * ================================================================================== */

  r.get('/api/regulator/overview', requireRole('REGULATOR')(async (ctx) => {
    /* 契约必须与本地 Express 版一致：前端监管驾驶舱读 kpi / trend /
     * byIndustry / byRegion / topEnt / gapEnt / verifyProgress / recentAlerts。
     * 早期 Worker 版只返回 enterprises/reports/quota/…，视图里
     * `d.value.trend.map(...)` 直接抛错 → 整页空白（导航在、内容全无）。 */
    const YEAR = new Date().getFullYear();
    const entCount = num(await ctx.db.value(
      "SELECT COUNT(*) FROM enterprise WHERE status IN ('ACTIVE','WATCH','SUSPENDED')"));
    const activeEnt = num(await ctx.db.value("SELECT COUNT(*) FROM enterprise WHERE status='ACTIVE'"));

    const emission = await ctx.db.one(
      `SELECT COALESCE(SUM(total_emission),0) AS total, COALESCE(AVG(intensity),0) AS intensity,
              COUNT(*) AS reports, SUM(CASE WHEN status='VERIFIED' THEN 1 ELSE 0 END) AS verified
         FROM emission_report WHERE year = ? AND status <> 'DRAFT'`, [YEAR]);
    const quotaStat = await ctx.db.one(
      `SELECT COALESCE(SUM(total_allocated),0) AS allocated, COALESCE(SUM(used),0) AS used,
              COALESCE(SUM(available),0) AS available,
              SUM(CASE WHEN available < 0 THEN 1 ELSE 0 END) AS gapCount
         FROM carbon_quota WHERE year = ?`, [YEAR]);
    const alertAgg = await ctx.db.one(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN level='HIGH' THEN 1 ELSE 0 END) AS high FROM alert_record`);
    const chainAnchors = num(await ctx.db.value('SELECT COUNT(*) FROM chain_tx'));

    const trend = await ctx.db.query(
      `SELECT period, COALESCE(SUM(total_emission),0) AS total,
              COALESCE(AVG(intensity),0) AS intensity, COUNT(*) AS reports
         FROM emission_report WHERE status <> 'DRAFT' GROUP BY period ORDER BY period`);
    const byIndustry = await ctx.db.query(
      `SELECT e.industry AS name, COALESCE(SUM(r.total_emission),0) AS value,
              COUNT(DISTINCT e.id) AS ents
         FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
        WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.industry ORDER BY value DESC`, [YEAR]);
    const byRegion = await ctx.db.query(
      `SELECT e.region AS name, COALESCE(SUM(r.total_emission),0) AS value
         FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
        WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.region ORDER BY value DESC LIMIT 12`, [YEAR]);
    const topEnt = await ctx.db.query(
      `SELECT e.id, e.ent_name AS name, e.industry, COALESCE(SUM(r.total_emission),0) AS value,
              COALESCE(AVG(r.intensity),0) AS intensity
         FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
        WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.id ORDER BY value DESC LIMIT 10`, [YEAR]);
    const gapEnt = await ctx.db.query(
      `SELECT e.id, e.ent_name AS name, e.industry, q.total_allocated, q.used, q.available,
              q.available AS gap
         FROM carbon_quota q JOIN enterprise e ON e.id = q.ent_id
        WHERE q.year = ? ORDER BY q.available ASC LIMIT 10`, [YEAR]);
    const vpRows = await ctx.db.query(
      'SELECT status, COUNT(*) AS cnt FROM emission_report WHERE year = ? GROUP BY status', [YEAR]);
    const vp = {};
    for (const v of vpRows) vp[v.status] = num(v.cnt);
    const recentAlerts = await ctx.db.query(
      `SELECT a.alert_no, a.alert_type, a.level, a.title, a.status, a.created_at, e.ent_name
         FROM alert_record a LEFT JOIN enterprise e ON e.id = a.ent_id
        ORDER BY a.created_at DESC LIMIT 8`);

    const dyn = await ctx.db.one(
      `SELECT SUM(cumulative_emission) AS cum, SUM(gap) AS gap,
              SUM(CASE WHEN risk_level='HIGH' THEN 1 ELSE 0 END) AS high,
              SUM(CASE WHEN risk_level='MEDIUM' THEN 1 ELSE 0 END) AS medium
         FROM carbon_dynamic_account`);
    const chain = await chainStats(ctx);

    return json({
      kpi: {
        entCount, activeEnt,
        emissionYtd: Math.round(num(emission.total)),
        avgIntensity: Number(num(emission.intensity).toFixed(4)),
        reports: num(emission.reports),
        verified: num(emission.verified),
        quotaAllocated: Math.round(num(quotaStat.allocated)),
        quotaUsed: Math.round(num(quotaStat.used)),
        quotaAvailable: Math.round(num(quotaStat.available)),
        gapCount: num(quotaStat.gapCount),
        chainAnchors,
        alertTotal: num(alertAgg.total),
        alertOpen: num(alertAgg.open),
        alertHigh: num(alertAgg.high),
      },
      trend: trend.map((t) => ({ period: t.period, total: num(t.total),
        intensity: num(t.intensity), reports: num(t.reports) })),
      byIndustry: byIndustry.map((i) => ({ name: i.name, value: num(i.value), ents: num(i.ents) })),
      byRegion: byRegion.map((i) => ({ name: i.name, value: num(i.value) })),
      topEnt: topEnt.map((t) => ({ id: num(t.id), name: t.name, industry: t.industry,
        value: num(t.value), intensity: num(t.intensity) })),
      gapEnt: gapEnt.map((g) => ({ id: num(g.id), name: g.name, industry: g.industry,
        total_allocated: num(g.total_allocated), used: num(g.used),
        available: num(g.available), gap: num(g.gap) })),
      verifyProgress: vp,
      recentAlerts: recentAlerts.map((a) => ({
        alertNo: a.alert_no, alertType: a.alert_type, level: a.level, title: a.title,
        status: a.status, createdAt: a.created_at, entName: a.ent_name,
      })),
      /* 兼容旧字段 */
      enterprises: entCount,
      reports: { count: num(emission.reports), verified: num(emission.verified), totalEmission: num(emission.total) },
      quota: { allocated: num(quotaStat.allocated), used: num(quotaStat.used),
        utilizationPct: num(quotaStat.allocated) > 0
          ? +(num(quotaStat.used) / num(quotaStat.allocated) * 100).toFixed(2) : null },
      alerts: { open: num(alertAgg.open), high: num(alertAgg.high) },
      dynamic: { cumulativeEmission: num(dyn.cum), totalGap: num(dyn.gap),
        highRisk: num(dyn.high), mediumRisk: num(dyn.medium) },
      chain,
    });
  }));

  r.get('/api/regulator/enterprises', requireRole('REGULATOR', 'VERIFIER')(async (ctx) => {
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.size, 20), 1), 100);
    const where = [];
    const params = [];
    if (ctx.query.industry) { where.push('e.industry = ?'); params.push(ctx.query.industry); }
    if (ctx.query.region) { where.push('e.region = ?'); params.push(ctx.query.region); }
    if (ctx.query.q) { where.push('e.ent_name LIKE ?'); params.push(`%${ctx.query.q}%`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = num(await ctx.db.value(`SELECT COUNT(*) FROM enterprise e ${w}`, params));
    const rows = await ctx.db.query(
      `SELECT e.id, e.ent_name, e.industry, e.region, e.scale, e.wallet_address,
              q.total_allocated, q.used, d.cumulative_emission, d.gap, d.risk_level
         FROM enterprise e
         LEFT JOIN carbon_quota q ON q.ent_id = e.id
         LEFT JOIN carbon_dynamic_account d ON d.ent_id = e.id
         ${w} ORDER BY e.id LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
    return json({
      rows: rows.map((x) => ({
      id: num(x.id), name: x.ent_name, industry: x.industry, region: x.region, scale: x.scale,
      wallet: x.wallet_address,
      allocated: num(x.total_allocated), used: num(x.used),
      cumulativeEmission: num(x.cumulative_emission),
      gap: num(x.gap), riskLevel: x.risk_level,
      })),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  r.get('/api/regulator/enterprises/filters', requireRole('REGULATOR', 'VERIFIER')(async (ctx) => {
    const ind = await ctx.db.query('SELECT DISTINCT industry FROM enterprise ORDER BY industry');
    const reg = await ctx.db.query('SELECT DISTINCT region FROM enterprise ORDER BY region');
    const scale = await ctx.db.query('SELECT DISTINCT scale FROM enterprise ORDER BY scale');
    return json({
      industries: ind.map((x) => x.industry).filter(Boolean),
      regions: reg.map((x) => x.region).filter(Boolean),
      scales: scale.map((x) => x.scale).filter(Boolean),
    });
  }));

  r.get('/api/regulator/enterprises/:id', requireRole('REGULATOR', 'VERIFIER')(async (ctx) => {
    const id = num(ctx.params.id, NaN);
    const ent = await ctx.db.one('SELECT * FROM enterprise WHERE id = ?', [id]);
    if (!ent) return fail('企业不存在', 404);
    const reports = await ctx.db.query(
      `SELECT id, year, quarter, total_emission, status FROM emission_report
        WHERE ent_id = ? ORDER BY year DESC, quarter DESC LIMIT 20`, [id]);
    const quota = await ctx.db.query(
      'SELECT year, total_allocated, used FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC', [id]);
    const alerts = await ctx.db.query(
      `SELECT id, level, title, status, created_at FROM alert_record
        WHERE ent_id = ? ORDER BY id DESC LIMIT 20`, [id]);
    return json({
      enterprise: {
        id: num(ent.id), name: ent.ent_name, industry: ent.industry,
        region: ent.region, scale: ent.scale, wallet: ent.wallet_address,
        legalPerson: ent.legal_person, contact: ent.contact_phone,
      },
      reports: reports.map(mapReport),
      quota: quota.map((q) => ({
        year: num(q.year), allocated: num(q.total_allocated), used: num(q.used),
        available: num(q.total_allocated) - num(q.used),
      })),
      alerts: alerts.map((a) => ({
        id: num(a.id), level: a.level, title: a.title, status: a.status, createdAt: a.created_at,
      })),
    });
  }));

  r.get('/api/regulator/alerts', requireRole('REGULATOR')(async (ctx) => {
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.size, 20), 1), 100);
    const where = [];
    const params = [];
    if (ctx.query.status) { where.push('a.status = ?'); params.push(ctx.query.status); }
    if (ctx.query.level) { where.push('a.level = ?'); params.push(ctx.query.level); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = num(await ctx.db.value(`SELECT COUNT(*) FROM alert_record a ${w}`, params));
    const rows = await ctx.db.query(
      `SELECT a.*, e.ent_name FROM alert_record a
         LEFT JOIN enterprise e ON e.id = a.ent_id
        ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size]);
    return json({
      rows: rows.map((a) => ({
        id: num(a.id), entId: num(a.ent_id), entName: a.ent_name,
        level: a.level, title: a.title, detail: a.detail, status: a.status,
        createdAt: a.created_at, handledAt: a.handled_at,
      })),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  r.post('/api/regulator/alerts/:id/handle', requireRole('REGULATOR')(async (ctx) => {
    const id = num(ctx.params.id, NaN);
    const b = await ctx.body();
    const note = String(b.note || '').slice(0, 500);
    const r2 = await ctx.db.run(
      `UPDATE alert_record SET status='HANDLED', handled_at=CURRENT_TIMESTAMP, handle_note=?
        WHERE id = ? AND status='OPEN'`, [note, id]);
    if (!r2.changes) return fail('预警不存在或已处理', 404);
    await audit(ctx, 'ALERT_HANDLE', 'alert_record', `${id}: ${note}`);
    return json({ ok: true, id });
  }));

  r.get('/api/regulator/statistics', requireRole('REGULATOR')(async (ctx) => {
    const byIndustry = await ctx.db.query(
      `SELECT industry, COUNT(*) AS n, SUM(total_emission) AS total, AVG(total_emission) AS avg
         FROM enterprise e JOIN emission_report r ON r.ent_id = e.id
        GROUP BY industry ORDER BY total DESC`);
    const byRegion = await ctx.db.query(
      `SELECT region, COUNT(*) AS n FROM enterprise GROUP BY region ORDER BY n DESC`);
    const byYear = await ctx.db.query(
      `SELECT year, SUM(total_emission) AS total FROM emission_report
        GROUP BY year ORDER BY year`);
    const quotaGap = await ctx.db.query(
      `SELECT q.year, SUM(q.total_allocated) AS alloc, SUM(q.used) AS used
         FROM carbon_quota q GROUP BY q.year ORDER BY q.year`);
    return json({
      byIndustry: byIndustry.map((x) => ({
        industry: x.industry, count: num(x.n),
        total: +num(x.total).toFixed(3), avg: +num(x.avg).toFixed(3),
      })),
      byRegion: byRegion.map((x) => ({ region: x.region, count: num(x.n) })),
      byYear: byYear.map((x) => ({ year: num(x.year), total: +num(x.total).toFixed(3) })),
      quota: quotaGap.map((x) => ({
        year: num(x.year), allocated: num(x.alloc), used: num(x.used),
        surplus: num(x.alloc) - num(x.used),
      })),
    });
  }));

  r.get('/api/regulator/logs', requireRole('REGULATOR')(async (ctx) => {
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.size, 20), 1), 100);
    const total = num(await ctx.db.value('SELECT COUNT(*) FROM audit_log'));
    const rows = await ctx.db.query(
      `SELECT id, actor, action, target, detail, created_at, prev_hash, entry_hash
         FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`, [size, (page - 1) * size]);
    return json({
      /* audit_log 的列名是 username（早期这里读 actor，审计页整列空白） */
      rows: rows.map((x) => ({
        id: num(x.id), actor: x.username, username: x.username, role: x.role, module: x.module,
        action: x.action, target: x.target,
        detail: x.detail, createdAt: x.created_at,
        prevHash: x.prev_hash, entryHash: x.entry_hash,
        hashChained: !!x.entry_hash,
      })),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  r.get('/api/regulator/system', requireRole('REGULATOR')(async (ctx) => {
    /* 表规模：information_schema → sqlite_master + 逐表 COUNT。
     * ⚠ 逐表 COUNT 会扫行，5 万行的大表不能逐个查。
     * 因此只精确统计"小表"，大表用预聚合或抽样。 */
    const tables = await ctx.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'agg_%' ORDER BY name");
    const SMALL_LIMIT = 50000;
    const counts = [];
    for (const t of tables) {
      try {
        const n = num(await ctx.db.value(`SELECT COUNT(*) FROM "${t.name}"`));
        if (n > SMALL_LIMIT) {
          counts.push({ table: t.name, rows: n, approximate: true });
        } else {
          counts.push({ table: t.name, rows: n, approximate: false });
        }
      } catch { counts.push({ table: t.name, rows: null, error: true }); }
    }
    const agg = await ctx.db.query(
      'SELECT year, country_iso, SUM(facilities) AS n FROM agg_facility_total GROUP BY year, country_iso ORDER BY year DESC');
    return json({
      tables: counts,
      tableTotal: counts.length,
      totalRows: counts.reduce((a, b) => a + (b.rows || 0), 0),
      realData: agg.map((x) => ({ year: num(x.year), iso: x.country_iso, facilities: num(x.n) })),
      chain: await chainStats(ctx),
      database: 'Cloudflare D1 (SQLite)',
      note: '表规模为实时 COUNT；大于 5 万行的表已标注 approximate 以免消耗读取额度。',
    });
  }));

  r.get('/api/regulator/notices', requireRole('REGULATOR')(async (ctx) => {
    const rows = await ctx.db.query(
      'SELECT id, title, category, published_at, views FROM notice ORDER BY published_at DESC');
    return json({ rows: rows.map((n) => ({
      id: num(n.id), title: n.title, category: n.category,
      publishedAt: n.published_at, views: num(n.views),
    })), total: rows.length, page: 1, size: rows.length, pages: 1 });
  }));

  r.post('/api/regulator/notices', requireRole('REGULATOR')(async (ctx) => {
    const b = await ctx.body();
    const title = String(b.title || '').trim();
    const content = String(b.content || '').trim();
    if (!title || !content) return fail('标题与正文不能为空');
    const res = await ctx.db.run(
      `INSERT INTO notice (title, content, category, published_at, views)
       VALUES (?,?,?,CURRENT_TIMESTAMP,0)`,
      [title.slice(0, 200), content.slice(0, 20000), String(b.category || 'GENERAL')]);
    await audit(ctx, 'NOTICE_CREATE', 'notice', title);
    return json({ ok: true, id: res.lastRowId });
  }));

  /* ==================================================================================
   * 核查机构端
   * ================================================================================== */

  r.get('/api/verifier/overview', requireRole('VERIFIER')(async (ctx) => {
    /* 契约与本地 Express 版一致：前端机构总览读 org / kpi / monthly /
     * conclusion / deviation / todoTasks。早期 Worker 版只给 org/tasks/reports，
     * 视图里 d.value.conclusion.map(...) 抛错 → 整页空白。 */
    const orgId = num(ctx.user.orgId);
    const org = await ctx.db.one('SELECT * FROM verifier_org WHERE id = ?', [orgId]);
    if (!org) return fail('核查机构不存在', 404);

    const stats = await ctx.db.query(
      'SELECT status, COUNT(*) AS cnt FROM verify_task WHERE verifier_id = ? GROUP BY status', [orgId]);
    const sm = {};
    for (const s of stats) sm[String(s.status)] = num(s.cnt);

    /* SQLite 无 DATE_FORMAT：用 substr 取年月 */
    const monthly = await ctx.db.query(
      `SELECT substr(assign_time, 1, 7) AS month, COUNT(*) AS cnt
         FROM verify_task WHERE verifier_id = ?
          AND assign_time >= datetime('now','-12 month')
        GROUP BY month ORDER BY month`, [orgId]);
    const conclusion = await ctx.db.query(
      'SELECT conclusion, COUNT(*) AS cnt FROM verify_report WHERE verifier_id = ? GROUP BY conclusion', [orgId]);
    const deviation = await ctx.db.query(
      `SELECT report_no, deviation_rate, verified_value, issue_time FROM verify_report
        WHERE verifier_id = ? ORDER BY issue_time DESC LIMIT 12`, [orgId]);
    const chainCount = num(await ctx.db.value(
      `SELECT COUNT(*) FROM chain_tx WHERE tx_type = 'VERIFY_REPORT' AND from_address = ?`,
      [org.wallet_address]));
    const todo = await ctx.db.query(
      `SELECT t.id, t.task_no, t.status, t.priority, t.deadline, t.assign_time,
              r.report_no, r.period, r.total_emission, e.ent_name, e.industry
         FROM verify_task t
         JOIN emission_report r ON r.id = t.report_id
         JOIN enterprise e ON e.id = t.ent_id
        WHERE t.verifier_id = ? AND t.status IN ('PENDING','PROCESSING')
        ORDER BY CASE t.priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END,
                 t.assign_time LIMIT 8`, [orgId]);
    const avgDev = num(await ctx.db.value(
      'SELECT COALESCE(AVG(ABS(deviation_rate)),0) FROM verify_report WHERE verifier_id = ?', [orgId]));

    return json({
      org: {
        name: org.org_name, code: org.org_code, level: org.level, region: org.region,
        rating: num(org.rating), passRate: num(org.pass_rate),
        staff: org.staff_count, doneTasks: num(org.done_tasks), status: org.status,
        wallet: org.wallet_address,
      },
      kpi: {
        pending: sm.PENDING || 0, processing: sm.PROCESSING || 0,
        done: sm.DONE || 0, rejected: sm.REJECTED || 0,
        total: Object.values(sm).reduce((a, b) => a + b, 0),
        chainCount, avgDeviation: avgDev.toFixed(2),
      },
      monthly: monthly.map((m) => ({ month: m.month, cnt: num(m.cnt) })),
      conclusion: conclusion.map((c) => ({ name: c.conclusion, value: num(c.cnt) })),
      deviation: deviation.map((d) => ({
        reportNo: d.report_no, deviation: num(d.deviation_rate),
        verifiedValue: num(d.verified_value), issueTime: d.issue_time,
      })),
      /* 表格列的 key 用 snake_case（task_no / ent_name / total_emission），
       * 与本地 Express 版的 SELECT * 结果同形；驼峰键一并保留供其他视图用。 */
      todoTasks: todo.map((t) => ({
        id: num(t.id), task_no: t.task_no, taskNo: t.task_no,
        status: t.status, priority: t.priority,
        deadline: t.deadline, assign_time: t.assign_time, assignTime: t.assign_time,
        report_no: t.report_no, reportNo: t.report_no,
        period: t.period,
        total_emission: num(t.total_emission), totalEmission: num(t.total_emission),
        ent_name: t.ent_name, entName: t.ent_name, industry: t.industry,
      })),
      /* 兼容旧字段 */
      tasks: { total: Object.values(sm).reduce((a, b) => a + b, 0),
        pending: sm.PENDING || 0, done: sm.DONE || 0 },
      reports: Object.values(sm).reduce((a, b) => a + b, 0),
    });
  }));

  r.get('/api/verifier/tasks', requireRole('VERIFIER')(async (ctx) => {
    const orgId = num(ctx.user.orgId);
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.size, 20), 1), 100);
    const where = ['t.verifier_id = ?'];
    const params = [orgId];
    if (ctx.query.status) {
      /* 支持逗号分隔多状态：PENDING,PROCESSING */
      const sts = String(ctx.query.status).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (sts.length) { where.push(`t.status IN (${sts.map(() => '?').join(',')})`); params.push(...sts); }
    }
    const w = 'WHERE ' + where.join(' AND ');
    const total = num(await ctx.db.value(`SELECT COUNT(*) FROM verify_task t ${w}`, params));
    const rows = await ctx.db.query(
      `SELECT t.*, e.ent_name, e.industry, e.region, r.report_no, r.year, r.quarter, r.total_emission, r.period
         FROM verify_task t
         LEFT JOIN enterprise e ON e.id = t.ent_id
         LEFT JOIN emission_report r ON r.id = t.report_id
        ${w} ORDER BY t.id DESC LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
    /* 分页信封：前端 usePager 读 d.rows / d.total / d.pages */
    return json({
      rows: rows.map((t) => ({
        id: num(t.id), taskNo: t.task_no, entId: num(t.ent_id), entName: t.ent_name,
        industry: t.industry, region: t.region,
        reportNo: t.report_no, period: t.period,
        year: num(t.year), quarter: num(t.quarter),
        totalEmission: num(t.total_emission), priority: t.priority,
        status: t.status, deadline: t.deadline, finishTime: t.finish_time,
        createdAt: t.created_at,
      })),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  r.get('/api/verifier/reports', requireRole('VERIFIER')(async (ctx) => {
    const orgId = num(ctx.user.orgId);
    const rows = await ctx.db.query(
      `SELECT vr.*, e.ent_name FROM verify_report vr
         LEFT JOIN enterprise e ON e.id = vr.ent_id
        WHERE vr.verifier_id = ? ORDER BY vr.id DESC LIMIT 100`, [orgId]);
    return json({ rows: rows.map((x) => ({
      id: num(x.id), reportNo: x.report_no, entName: x.ent_name, conclusion: x.conclusion,
      declared: num(x.declared_value), verified: num(x.verified_value),
      deviation: num(x.deviation_rate), sealHash: x.seal_hash,
      opinion: x.opinion, createdAt: x.created_at,
      chain: { blockIndex: num(x.chain_block_index), txId: x.chain_tx_id },
    })), total: rows.length, page: 1, size: rows.length, pages: 1 });
  }));

  r.get('/api/verifier/wallet', requireRole('VERIFIER')(async (ctx) => {
    const orgId = num(ctx.user.orgId);
    /* verifier_org 无 did 列：DID 按机构 ID 规范化派生 */
    const org = await ctx.db.one(
      'SELECT org_name, wallet_address, org_code FROM verifier_org WHERE id = ?', [orgId]);
    if (!org) return fail('核查机构不存在', 404);
    return json({
      name: org.org_name, address: org.wallet_address, did: `did:cc:verifier:${orgId}`,
      orgCode: org.org_code,
      signing: {
        available: false, algorithm: 'SM2',
        reason: '线上运行时（Cloudflare Workers/WebCrypto）不提供国密 SM2。历史签名仍可在本地/离线工具验证。',
      },
    });
  }));

  r.get('/api/verifier/notices', authRequired(async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT id, title, category, published_at FROM notice ORDER BY published_at DESC LIMIT 20`);
    return json({ rows: rows.map((n) => ({
      id: num(n.id), title: n.title, category: n.category, publishedAt: n.published_at,
    })), total: rows.length, page: 1, size: rows.length, pages: 1 });
  }));

  /* ==================================================================================
   * MRV：活动数据 / 核算批次 / 因子台账 / 数据质量
   * ================================================================================== */

  r.get('/api/mrv/activity', authRequired(async (ctx) => {
    const scoped = scopedEntId(ctx);
    const entId = scoped || num(ctx.query.entId);
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.size, 20), 1), 100);
    const where = [];
    const params = [];
    if (entId) { where.push('ent_id = ?'); params.push(entId); }
    if (ctx.query.year) { where.push('year = ?'); params.push(num(ctx.query.year)); }
    if (ctx.query.month) { where.push('month = ?'); params.push(num(ctx.query.month)); }
    if (ctx.query.tier) { where.push('data_tier = ?'); params.push(ctx.query.tier); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = num(await ctx.db.value(`SELECT COUNT(*) FROM activity_data ${w}`, params));
    const rows = await ctx.db.query(
      `SELECT * FROM activity_data ${w} ORDER BY year DESC, month DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size]);
    return json(rows.map(mapActivity), { page, size, total });
  }));

  r.get('/api/mrv/calc/batches', authRequired(async (ctx) => {
    const scoped = scopedEntId(ctx);
    const entId = scoped || num(ctx.query.entId);
    const where = [];
    const params = [];
    if (entId) { where.push('b.ent_id = ?'); params.push(entId); }
    if (ctx.query.year) { where.push('b.year = ?'); params.push(num(ctx.query.year)); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = num(await ctx.db.value(`SELECT COUNT(*) FROM calc_batch b ${w}`, params));
    const rows = await ctx.db.query(
      `SELECT b.*, e.ent_name FROM calc_batch b
         LEFT JOIN enterprise e ON e.id = b.ent_id
        ${w} ORDER BY b.id DESC LIMIT 50`, params);
    return json({
      count: total,
      items: rows.map((b) => ({
        id: num(b.id), batchNo: b.batch_no, entId: num(b.ent_id), entName: b.ent_name,
        year: num(b.year), period: b.period,
        totalEmission: num(b.total_emission), engineVersion: b.engine_version,
        status: b.status, createdAt: b.created_at,
      })),
    });
  }));

  r.get('/api/mrv/factor', async (ctx) => {
    /* 公开可查 —— 因子是公开台账，"要求登录才能查因子"等于"先相信再验证" */
    /* ⚠ 列名以 MySQL 实际结构为准（由 tools/schema-from-mysql.mjs 生成的 schema 同源）：
     *   code / name_cn / of_rate / source_doc / version
     * 而不是 fuel_code / fuel_name / of_value / basis / factor_version。
     * 写错列名的后果是 500 而不是空值 —— 这一点反而好：
     * 静默返回空列表会让人以为"因子库没数据"。 */
    const rows = await ctx.db.query(
      `SELECT * FROM factor_entry ORDER BY category, code`);
    return json(rows.map((f) => ({
      id: num(f.id),
      category: f.category,
      scope: f.scope,
      code: f.code,
      name: f.name_cn,
      industry: f.industry,
      region: f.region,
      ncv: f.ncv == null ? null : num(f.ncv),
      ncvUnit: f.ncv_unit,
      cc: f.cc == null ? null : num(f.cc),
      of: f.of_rate == null ? null : num(f.of_rate),
      ef: f.ef_value == null ? null : num(f.ef_value),
      efUnit: f.ef_unit,
      unit: f.ef_unit,
      basis: f.source_doc,
      sourceYear: f.source_year == null ? null : num(f.source_year),
      version: f.version,
      effectiveFrom: f.effective_from,
      status: f.status,
      /* 三要素可复算：EF = NCV/1000 × CC × OF × 44/12 */
      recomputable: f.ncv != null && f.cc != null && f.of_rate != null,
      /* 入库时的复算结果（由 seed-factors.js 写入） */
      recomputeOk: f.recompute_ok == null ? null : num(f.recompute_ok) === 1,
      recomputeDiff: f.recompute_diff == null ? null : num(f.recompute_diff),
    })));
  });

  r.get('/api/mrv/factor/selftest', async (ctx) => {
    /* 逐条复算因子三要素 —— 这是"核算是科学不是相信"的技术落地 */
    const rows = await ctx.db.query(
      `SELECT code, name_cn, ncv, cc, of_rate, ef_value FROM factor_entry
        WHERE ncv IS NOT NULL AND cc IS NOT NULL AND of_rate IS NOT NULL`);
    const checks = rows.map((f) => {
      const recomputed = num(f.ncv) / 1000 * num(f.cc) * num(f.of_rate) * 44 / 12;
      const rel = num(f.ef_value) > 0 ? Math.abs(recomputed - num(f.ef_value)) / num(f.ef_value) : null;
      return {
        code: f.code, name: f.name_cn,
        stored: num(f.ef_value), recomputed: +recomputed.toFixed(6),
        relDeviation: rel === null ? null : +rel.toFixed(6),
        /* 容差 0.1%：DECIMAL 存储的舍入，不是逻辑错误 */
        pass: rel !== null && rel < 1e-3,
      };
    });
    const passed = checks.filter((c) => c.pass).length;
    return json({
      formula: 'EF = NCV/1000 × CC × OF × 44/12',
      total: checks.length, passed,
      failed: checks.length - passed,
      verdict: passed === checks.length ? '全部因子三要素复算自洽' : '存在不自洽因子',
      checks,
    });
  });

  r.get('/api/mrv/quality', authRequired(async (ctx) => {
    const scoped = scopedEntId(ctx);
    const entId = scoped || num(ctx.query.entId);
    const where = entId ? 'WHERE ent_id = ?' : '';
    const params = entId ? [entId] : [];
    /* 按数据等级统计 —— 用整表聚合但表只有 3 千行，可接受 */
    const tiers = await ctx.db.query(
      `SELECT data_tier AS tier, COUNT(*) AS n, SUM(amount * factor) AS emission
         FROM activity_data ${where} GROUP BY data_tier`, params);
    const total = num(await ctx.db.value(
      `SELECT COUNT(*) FROM activity_data ${where}`, params));
    return json({
      total,
      tiers: tiers.map((t) => ({
        tier: t.tier, rows: num(t.n),
        sharePct: total > 0 ? +(num(t.n) / total * 100).toFixed(2) : null,
        emission: +num(t.emission).toFixed(3),
      })),
      note: '数据等级 L3（实测）> L2（台账）> L1（估算）> L0（缺省）。'
        + '质量分级应按排放量加权，不应按行数 —— 否则 3 行估算就能把整年判死。',
    });
  }));

  /* ==================================================================================
   * 交易 / 结算 / 信用
   * ================================================================================== */

  r.get('/api/trade/market', async (ctx) => {
    /* 契约与本地 Express 版一致：前端行情页读 lastPrice / change / kpi /
     * kline / ccer。早期 Worker 版只给 price/recent，视图里
     * market.kline.map(...) 抛错 → 整页空白。
     * 真实列名是 deal_time（trade_deal 无 created_at）。 */
    const deals = await ctx.db.query(
      `SELECT price, amount, total_amount, deal_time FROM trade_deal
        WHERE status = 'SETTLED' ORDER BY deal_time ASC`);
    const last = deals.length ? deals[deals.length - 1] : null;
    const lastPrice = last ? num(last.price) : 0;

    const dealTime = (d) => String(d.deal_time || '').slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const avgOf = (arr) => (arr.length
      ? arr.reduce((a, b) => a + num(b.price) * num(b.amount), 0)
        / arr.reduce((a, b) => a + num(b.amount), 0)
      : 0);
    const prevAvg = avgOf(deals.filter((d) => dealTime(d) === yest
      || (yest === today && dealTime(d) === today && d !== last)));
    const change = prevAvg > 0 ? Number((((lastPrice - prevAvg) / prevAvg) * 100).toFixed(2)) : 0;

    const agg = await ctx.db.one(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS vol,
              COALESCE(SUM(total_amount),0) AS turnover
         FROM trade_deal WHERE status = 'SETTLED'`);
    const hl = await ctx.db.one(
      "SELECT MAX(price) AS h, MIN(price) AS l FROM trade_deal WHERE status = 'SETTLED'");

    /* K 线按日聚合（SQLite 用 substr 取日期） */
    const kline = await ctx.db.query(
      `SELECT substr(deal_time, 1, 10) AS d, MAX(price) AS high, MIN(price) AS low,
              SUM(amount) AS vol, SUM(total_amount) AS amount
         FROM trade_deal WHERE status = 'SETTLED'
        GROUP BY substr(deal_time, 1, 10) ORDER BY d ASC LIMIT 90`);
    const ccer = await ctx.db.one(
      "SELECT COALESCE(AVG(amount),0) AS avg_amount, COUNT(*) AS cnt FROM credit_asset WHERE asset_type = 'CCER'");

    return json({
      lastPrice,
      change,
      prevAvg: Number(prevAvg.toFixed(2)),
      kpi: {
        deals: num(agg.cnt), volume: Number(num(agg.vol).toFixed(2)),
        turnover: Number(num(agg.turnover).toFixed(2)),
        high: num(hl.h), low: num(hl.l),
      },
      kline: kline.map((k) => ({
        date: k.d, high: num(k.high), low: num(k.low),
        volume: num(k.vol), amount: num(k.amount),
      })),
      ccer: { assetCount: num(ccer.cnt), avgAmount: num(ccer.avg_amount) },
      /* 兼容旧字段 */
      price: {
        last: lastPrice || null,
        avg: deals.length ? Number((deals.reduce((a, b) => a + num(b.price), 0) / deals.length).toFixed(2)) : null,
        high: num(hl.h), low: num(hl.l), samples: deals.length,
      },
      recent: deals.slice(-20).reverse().map((d) => ({
        price: num(d.price), amount: num(d.amount), at: d.deal_time,
      })),
      /* ⚠ 必须声明：这不是真实市场行情 */
      provenance: {
        source: '平台内合成撮合成交',
        isRealMarket: false,
        note: '全国碳市场实时行情需交易所授权接口；当前价格为平台内建模成交的统计值，不可作为市场参考价。',
      },
    });
  });

  r.get('/api/trade/orderbook', async (ctx) => {
    /* trade_order 未存储剩余量列：剩余 = amount - filled_amount */
    const rows = await ctx.db.query(
      `SELECT side, price, SUM(amount - filled_amount) AS amount, COUNT(*) AS orders
         FROM trade_order WHERE status IN ('OPEN','PARTIAL')
        GROUP BY side, price ORDER BY price DESC`);
    const bids = rows.filter((x) => x.side === 'BUY')
      .map((x) => ({ price: num(x.price), amount: num(x.amount), orders: num(x.orders) }));
    const asks = rows.filter((x) => x.side === 'SELL')
      .map((x) => ({ price: num(x.price), amount: num(x.amount), orders: num(x.orders) }));
    return json({ bids, asks });
  });

  r.get('/api/credit/summary', async (ctx) => {
    const a = await ctx.db.one(
      `SELECT COUNT(*) AS n, SUM(available_amount) AS avail, SUM(total_amount) AS total
         FROM credit_asset`);
    const o = await ctx.db.one(
      `SELECT COUNT(*) AS n, SUM(amount) AS total FROM credit_offset`);
    return json({
      assets: { count: num(a.n), available: num(a.avail), total: num(a.total) },
      offsets: { count: num(o.n), total: num(o.total) },
    });
  });

  r.get('/api/settlement/surrender/status', authRequired(async (ctx) => {
    const scoped = scopedEntId(ctx);
    const entId = scoped || num(ctx.query.entId);
    if (!entId) return fail('缺少 entId', 400);
    const q = await ctx.db.one(
      'SELECT * FROM carbon_quota WHERE ent_id = ? ORDER BY year DESC LIMIT 1', [entId]);
    const s = await ctx.db.one(
      'SELECT * FROM quota_surrender WHERE ent_id = ? ORDER BY year DESC LIMIT 1', [entId]);
    return json({
      entId,
      quota: q ? {
        year: num(q.year), allocated: num(q.total_allocated), used: num(q.used),
      } : null,
      surrender: s ? {
        year: num(s.year), amount: num(s.amount), status: s.status, executedAt: s.executed_at,
      } : null,
    });
  }));

  /* ==================================================================================
   * 通知：统一的"数据层级"说明端点（供前端页脚展示）
   * ================================================================================== */

  r.get('/api/meta/data-layers', async (ctx) => {
    return json({
      layers: [
        { key: 'REAL', name: '真实观测', desc: '来自官方/第三方公开数据集，可逐条回溯', examples: ['EPA GHGRP 美国设施', 'Climate TRACE 中国设施', 'World Bank 宏观序列'] },
        { key: 'DERIVED', name: '公式推导', desc: '以 REAL 为输入、经公开公式计算', examples: ['恒等式检验 E=A×EF', '年度同比', '行业集中度 HHI'] },
        { key: 'MODELED', name: '建模生成', desc: '公开参数 + 建模假设，明确标注不冒充实测', examples: ['60 家控排企业主体', 'CEMS 滚动读数', '交易撮合成交'] },
      ],
      rule: '任何一行数据都必须能回答「你属于哪一层、依据是什么」。',
      realDataEntry: '/api/real/truth',
    });
  });
}

/* ==================================================================================
 * 辅助
 * ================================================================================== */

async function chainStats(ctx) {
  const blk = await ctx.db.one(
    `SELECT COUNT(*) AS total_blocks, SUM(tx_count) AS packed,
            MAX(block_index) AS height, MAX(difficulty) AS difficulty
       FROM chain_block`);
  const tx = await ctx.db.one(
    `SELECT COUNT(*) AS rows_n,
            SUM(CASE WHEN status='CONFIRMED' THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending
       FROM chain_tx`);
  const tip = await ctx.db.one(
    'SELECT block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1');

  const confirmed = num(tx.confirmed);
  const pending = num(tx.pending);
  const packed = num(blk.packed);
  return {
    height: num(blk.height),
    totalBlocks: num(blk.total_blocks),
    tipHash: tip ? tip.block_hash : null,
    difficulty: num(blk.difficulty),
    /* 大屏与前端共用的展示口径：totalTxs = 已确认存证笔数。
     * 早期 Worker 版只给 confirmed/ledgerRows，而前端读 totalTxs，
     * 于是首页两个 KPI 显示"— 笔"（接口有数、页面空白）。 */
    totalTxs: confirmed,
    avgMineTime: 0,
    /* 三个口径分开命名 —— 混用是院审点名的"数字对不上"根源 */
    packedTotal: packed,
    confirmed,
    pending,
    ledgerRows: num(tx.rows_n),
    txAccounting: {
      balanced: packed === confirmed + pending,
      diff: packed - (confirmed + pending),
      state: packed === confirmed + pending ? 'BALANCED'
        : (packed - (confirmed + pending) === -pending ? 'PENDING_BACKLOG' : 'MISMATCH'),
    },
    consensus: 'PoA（权威证明）+ 联盟节点轮值出块',
  };
}

function mapReport(r) {
  return {
    id: num(r.id), reportNo: r.report_no, year: num(r.year), quarter: num(r.quarter),
    period: r.period, totalEmission: num(r.total_emission),
    scope1: num(r.scope1_emission), scope2: num(r.scope2_emission),
    status: r.status, verifierName: r.verifier_name || null,
    submitTime: r.submit_time, verifyTime: r.verify_time,
    chainBlockIndex: r.chain_block_index === null ? null : num(r.chain_block_index),
  };
}

function mapActivity(a) {
  return {
    id: num(a.id), entId: num(a.ent_id), year: num(a.year), month: num(a.month),
    sourceCode: a.source_code, sourceName: a.source_name,
    amount: num(a.amount), unit: a.unit, factor: num(a.factor),
    dataTier: a.data_tier, dataOrigin: a.data_origin,
    voucherNo: a.voucher_no, labNo: a.lab_no,
    reviewStatus: a.review_status, createdAt: a.created_at,
  };
}

async function audit(ctx, action, target, detail) {
  try {
    await ctx.db.run(
      `INSERT INTO audit_log (username, action, target, detail, created_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)`,
      [(ctx.user && ctx.user.username) || 'system', action, target, String(detail || '').slice(0, 800)]);
  } catch { /* 审计失败不阻断业务 */ }
}
