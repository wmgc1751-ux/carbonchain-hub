/**
 * routes/public.js —— 公众端 / 数据公示大屏 API（无需登录）
 * 体现"碳数据的公共监督属性"：任何公民都可以查询排放总量与链上存证。
 */
'use strict';

const express = require('express');
const db = require('../db');
const anchorSvc = require('../services/anchor');
const timefmt = require('../utils/time');
const { ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();

/* ==================================================================
 * 报告年度解析
 *
 * ⚠ 原实现是模块级常量 `const YEAR = new Date().getFullYear()`，
 * 把「公示口径的年度」等同于「系统时钟年份」。这个等式不成立：
 *
 *   碳数据存在天然滞后 —— 2026 年的排放要到 2027 年才核查完、才可能公示。
 *   所以任何时刻打开公示大屏，当年数据必然是空的。于是大屏永远显示
 *   "年度排放 0 / 核查通过率 0%"，而库里明明躺着 32 张已核查上报单、
 *   144.5 万 tCO₂ 的核算成果。
 *
 * 这不是数据缺失，是查询口径错位：拿"还没到的年度"去问"已发生的排放"。
 * 更糟的是它让整个平台在公众第一屏看起来是个空壳。
 *
 * 修正：默认年度 = 库里最新的、确有已核查数据的年度；
 *       可用 ?year= 显式指定回溯查看；
 *       并把「实际用的年度」返回给前端，让大屏能写明"统计年度 2024"，
 *       而不是让读者误以为是今年。
 * ================================================================== */
async function resolveReportYear(requested) {
  const want = Number(requested);
  if (Number.isInteger(want) && want >= 2000 && want <= 2100) return want;
  const row = await db.one(
    `SELECT year FROM emission_report
      WHERE status <> 'DRAFT'
      GROUP BY year ORDER BY year DESC LIMIT 1`
  );
  return row ? Number(row.year) : new Date().getFullYear();
}

/* 公示大屏总览 ------------------------------------------------------ */
router.get('/dashboard', wrap(async (req, res) => {
  const YEAR = await resolveReportYear(req.query.year);
  const chain = await anchorSvc.getChain();
  const stats = await chain.stats();

  /* 口径必须与监管驾驶舱一致：CLOSED = 已注销/已退出，不属于在册控排主体。
   * 2026-10-29 发现同一平台出现两个数——登录页「63 家控排企业」、
   * 监管驾驶舱「纳入控排企业 60 家」，差的 3 家是状态为 CLOSED 的测试主体。
   * 公开看板是未登录访客看到的第一屏，口径错了比数字少更伤可信度。 */
  const entCount = Number(await db.value("SELECT COUNT(*) FROM enterprise WHERE status <> 'CLOSED'") || 0);
  const regionCount = Number(await db.value("SELECT COUNT(DISTINCT region) FROM enterprise WHERE status <> 'CLOSED'") || 0);

  const emission = await db.one(
    `SELECT IFNULL(SUM(total_emission),0) AS total, COUNT(*) AS cnt,
            IFNULL(SUM(output_value),0) AS grid
     FROM emission_report WHERE year = ? AND status <> 'DRAFT'`, [YEAR]
  );

  /* 强度 = 年度排放 ÷ 年度上网电量（tCO₂/万kWh），用真实官方电量作分母。
   *
   * ⚠ 不能再用 AVG(intensity)：
   *   ① 它是各季度强度的算术平均，不考虑季度电量差异 —— 冬季发电少、
   *      单位电量碳强度高，简单平均会系统性地偏离真实加权强度。
   *   ② 2025 年度没有官方上网电量（统计表未公布），季度 intensity 为 0，
   *      AVG 得到 0 —— 大屏显示"平均强度 0"，读者会理解为"零碳"。
   *      正确做法是返回 null，让前端显示"—"。
   *
   * 有分母才算，没分母就是"未知"，不是 0。 */
  const emissionGrid = Number(emission.grid || 0);
  const avgIntensity = emissionGrid > 0
    ? Number((Number(emission.total) / emissionGrid).toFixed(4))
    : null;

  const byIndustry = await db.query(
    `SELECT e.industry AS name, IFNULL(SUM(r.total_emission),0) AS value
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.industry ORDER BY value DESC`, [YEAR]
  );

  const byRegion = await db.query(
    `SELECT e.region AS name, IFNULL(SUM(r.total_emission),0) AS value
     FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
     WHERE r.year = ? AND r.status <> 'DRAFT' GROUP BY e.region ORDER BY value DESC LIMIT 10`, [YEAR]
  );

  /* 趋势图的强度同样用「Σ排放 ÷ Σ上网电量」加权算，不用 AVG(intensity)。
   * 分母为 0 的期间返回 null，前端折线断开而不是掉到 0 ——
   * 掉到 0 会被读成"那个季度零碳"。全部期间都算，不受 reportYear 限制，
   * 这样趋势图能看到完整的 2024→2025 走势。 */
  const trend = await db.query(
    `SELECT period,
            IFNULL(SUM(total_emission),0) AS total,
            IFNULL(SUM(output_value),0) AS grid
     FROM emission_report WHERE status <> 'DRAFT' GROUP BY period ORDER BY period`
  );

  const latestBlocks = await db.ledgerQuery(
    `SELECT block_index, block_hash, prev_hash, tx_count, nonce, difficulty, mine_time, block_time
     FROM chain_block ORDER BY block_index DESC LIMIT 8`
  );

  const latestTxs = await db.ledgerQuery(
    `SELECT tx_id, tx_type, biz_no, block_index, from_address, payload_hash, created_at
     FROM chain_tx ORDER BY id DESC LIMIT 10`
  );

  const notices = await db.query(
    `SELECT id, title, notice_type, publisher, publish_time FROM notice
     WHERE target_role IN ('ALL','ENTERPRISE') ORDER BY is_top DESC, publish_time DESC LIMIT 6`
  );

  const verified = await db.one(
    `SELECT COUNT(*) AS total, SUM(status='VERIFIED') AS done,
            SUM(status IN ('SUBMITTED','VERIFYING')) AS pending
     FROM emission_report WHERE year = ?`, [YEAR]
  );

  /* 可选回溯年度清单 —— 前端据此提供年份切换，也让"这一屏是哪一年"可辨 */
  const availableYears = (await db.query(
    `SELECT year, COUNT(*) n FROM emission_report WHERE status <> 'DRAFT'
      GROUP BY year ORDER BY year DESC`
  )).map((r) => ({ year: Number(r.year), reports: Number(r.n) }));

  ok(res, {
    /* 统计年度显式回传：前端必须显示它，避免读者误读为"本年" */
    reportYear: YEAR,
    availableYears,
    chain: {
      height: stats.height, tipHash: stats.tipHash, totalBlocks: stats.totalBlocks,
      totalTxs: stats.confirmed, difficulty: stats.difficulty, avgMineTime: stats.avgMineTime,
      consensus: stats.consensus, crypto: stats.crypto, node: stats.node,
      byBizType: stats.txByType,
      blockRate: stats.blockRate,
    },
    kpi: {
      entCount, regionCount,
      emissionYtd: Number(Number(emission.total).toFixed(0)),
      /* null 表示"无官方电量可比，强度未知"，不代表零碳 */
      avgIntensity,
      reportCount: Number(emission.cnt),
      verifiedRate: Number(verified.total) > 0
        ? Number(((Number(verified.done) / Number(verified.total)) * 100).toFixed(1)) : 0,
    },
    byIndustry: byIndustry.map((i) => ({ ...i, value: Number(i.value) })),
    byRegion: byRegion.map((i) => ({ ...i, value: Number(i.value) })),
    trend: trend.map((t) => {
      const g = Number(t.grid || 0);
      return {
        period: t.period,
        total: Number(t.total),
        /* null = 该期无官方电量，强度未知；前端应断线而非画 0 */
        intensity: g > 0 ? Number((Number(t.total) / g).toFixed(4)) : null,
      };
    }),
    latestBlocks: latestBlocks.map((b) => ({
      ...b,
      block_index: Number(b.block_index), tx_count: Number(b.tx_count),
      nonce: Number(b.nonce), difficulty: Number(b.difficulty), mine_time: Number(b.mine_time),
      /* 库里是 UTC 字面量，转本地时区（2026-10-29 巡检 P0-7） */
      block_time: timefmt.localFromUtcLiteral(b.block_time),
    })),
    latestTxs: latestTxs.map((t) => ({ ...t, created_at: timefmt.localFromUtcLiteral(t.created_at) })),
    notices,
  });
}));

/* 公示企业名录（脱敏） ------------------------------------------------ */
router.get('/enterprises', wrap(async (req, res) => {
  /* order_count：该企业名下挂单数。
   * 交易端需要一个"适合作为默认代理企业"的判据 —— 默认落在没有挂单的企业上，
   * "我的委托单"就是空表，演示者会以为功能坏了。
   * 挂单量本身在盘口就是公开信息，补这个字段不泄露任何新内容。 */
  /* 年度同样不能取系统时钟：名录里的排放量若按"当年"统计会全为 0，
   * 排序失去意义、筛选也无法定位。与 /dashboard 共用同一套年度解析。 */
  const Y = await resolveReportYear(req.query.year);
  const page = await db.paginate(
    `SELECT e.id, e.ent_name, e.industry, e.region, e.city, e.scale, e.credit_score,
            e.wallet_address, e.status,
            IFNULL(SUM(r.total_emission),0) AS emission_ytd, IFNULL(AVG(r.intensity),0) AS intensity,
            (SELECT COUNT(*) FROM trade_order t WHERE t.ent_id = e.id) AS order_count
     FROM enterprise e
     LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ? AND r.status <> 'DRAFT'
     WHERE e.status IN ('ACTIVE','WATCH','SUSPENDED')
     GROUP BY e.id ORDER BY emission_ytd DESC`,
    [Y], req.query
  );
  ok(res, {
    ...page,
    reportYear: Y,
    rows: page.rows.map((r) => ({
      ...r,
      emission_ytd: Number(r.emission_ytd),
      intensity: Number(Number(r.intensity).toFixed(4)),
      order_count: Number(r.order_count),
      // 公开展示时对统一社会信用代码等敏感字段做屏蔽（此处仅展示名称与钱包地址）
    })),
  });
}));

/* 公示公告 ---------------------------------------------------------- */
/* 分类筛选：notice_type 承载分类语义（OFFICIAL/POLICY/MARKET/INTL/SYSTEM）。
 * 旧数据兼容：INTL 与 INTERNATIONAL 同义，SYSTEM 归入"平台公告"。 */
const NOTICE_CATEGORIES = {
  OFFICIAL:      ['OFFICIAL'],
  POLICY:        ['POLICY'],
  MARKET:        ['MARKET'],
  INTERNATIONAL: ['INTERNATIONAL', 'INTL'],
  PLATFORM:      ['SYSTEM'],
};

router.get('/notices', wrap(async (req, res) => {
  const cat = String(req.query.category || '').toUpperCase();
  const types = NOTICE_CATEGORIES[cat];

  const where = [
    `target_role IN ('ALL','ENTERPRISE')`,
    ...(types ? [`notice_type IN (${types.map(() => '?').join(',')})`] : []),
  ].join(' AND ');

  const page = await db.paginate(
    `SELECT id, title, content, notice_type, publisher, is_top, views, publish_time,
            source_name, source_url, fetched_at FROM notice
     WHERE ${where} ORDER BY is_top DESC, publish_time DESC`,
    types || [], req.query
  );
  ok(res, page);
}));

/* 分类汇总（前端 Tab 徽标用） */
router.get('/notices/summary', wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT notice_type, COUNT(*) AS cnt, MAX(publish_time) AS latest FROM notice
     WHERE target_role IN ('ALL','ENTERPRISE') GROUP BY notice_type`
  );
  const label = { OFFICIAL: '官方通知', POLICY: '政策法规', MARKET: '市场动态',
    INTERNATIONAL: '国际动态', INTL: '国际动态', SYSTEM: '平台公告' };
  const merged = {};
  for (const r of rows) {
    /* INTL 与 INTERNATIONAL 是同一分类的两种写法，合并；
     * 其余**保留原 key**。早先把无法识别的类型一律折进 PLATFORM，
     * 于是「平台公告」标签里躺着市场通报，点开又与标签不符
     * （2026-10-29 巡检 P1-19）。未知类型就用原始编码当标签，至少不串味。 */
    const key = r.notice_type === 'INTL' ? 'INTERNATIONAL' : r.notice_type;
    const lb = label[r.notice_type] || label[key] || String(r.notice_type);
    merged[key] ||= { key, label: lb, count: 0, latest: null };
    merged[key].count += Number(r.cnt);
    if (String(r.latest) > (merged[key].latest || '')) merged[key].latest = r.latest;
  }
  ok(res, { categories: Object.values(merged) });
}));

router.get('/notices/:id', wrap(async (req, res) => {
  const n = await db.one('SELECT * FROM notice WHERE id = ?', [req.params.id]);
  if (!n) return fail(res, '公告不存在', 404);
  await db.query('UPDATE notice SET views = views + 1 WHERE id = ?', [n.id]);
  ok(res, n);
}));

module.exports = router;
