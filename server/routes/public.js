/**
 * routes/public.js —— 公众端 / 数据公示大屏 API（无需登录）
 * 体现"碳数据的公共监督属性"：任何公民都可以查询排放总量与链上存证。
 */
'use strict';

const express = require('express');
const db = require('../db');
const anchorSvc = require('../services/anchor');
const { ok, fail, wrap } = require('../middleware/auth');

const router = express.Router();
const YEAR = new Date().getFullYear();

/* 公示大屏总览 ------------------------------------------------------ */
router.get('/dashboard', wrap(async (req, res) => {
  const chain = await anchorSvc.getChain();
  const stats = await chain.stats();

  const entCount = Number(await db.value('SELECT COUNT(*) FROM enterprise') || 0);
  const regionCount = Number(await db.value('SELECT COUNT(DISTINCT region) FROM enterprise') || 0);

  const emission = await db.one(
    `SELECT IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(intensity),0) AS intensity, COUNT(*) AS cnt
     FROM emission_report WHERE year = ? AND status <> 'DRAFT'`, [YEAR]
  );

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

  const trend = await db.query(
    `SELECT period, IFNULL(SUM(total_emission),0) AS total, IFNULL(AVG(intensity),0) AS intensity
     FROM emission_report WHERE status <> 'DRAFT' GROUP BY period ORDER BY period`
  );

  const latestBlocks = await db.query(
    `SELECT block_index, block_hash, prev_hash, tx_count, nonce, difficulty, mine_time, block_time
     FROM chain_block ORDER BY block_index DESC LIMIT 8`
  );

  const latestTxs = await db.query(
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

  ok(res, {
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
      avgIntensity: Number(Number(emission.intensity).toFixed(4)),
      reportCount: Number(emission.cnt),
      verifiedRate: Number(verified.total) > 0
        ? Number(((Number(verified.done) / Number(verified.total)) * 100).toFixed(1)) : 0,
    },
    byIndustry: byIndustry.map((i) => ({ ...i, value: Number(i.value) })),
    byRegion: byRegion.map((i) => ({ ...i, value: Number(i.value) })),
    trend: trend.map((t) => ({ period: t.period, total: Number(t.total), intensity: Number(t.intensity) })),
    latestBlocks: latestBlocks.map((b) => ({
      ...b,
      block_index: Number(b.block_index), tx_count: Number(b.tx_count),
      nonce: Number(b.nonce), difficulty: Number(b.difficulty), mine_time: Number(b.mine_time),
    })),
    latestTxs,
    notices,
  });
}));

/* 公示企业名录（脱敏） ------------------------------------------------ */
router.get('/enterprises', wrap(async (req, res) => {
  const page = await db.paginate(
    `SELECT e.id, e.ent_name, e.industry, e.region, e.city, e.scale, e.credit_score,
            e.wallet_address, e.status,
            IFNULL(SUM(r.total_emission),0) AS emission_ytd, IFNULL(AVG(r.intensity),0) AS intensity
     FROM enterprise e
     LEFT JOIN emission_report r ON r.ent_id = e.id AND r.year = ${YEAR} AND r.status <> 'DRAFT'
     GROUP BY e.id ORDER BY emission_ytd DESC`,
    [], req.query
  );
  ok(res, {
    ...page,
    rows: page.rows.map((r) => ({
      ...r,
      emission_ytd: Number(r.emission_ytd),
      intensity: Number(Number(r.intensity).toFixed(4)),
      // 公开展示时对统一社会信用代码等敏感字段做屏蔽（此处仅展示名称与钱包地址）
    })),
  });
}));

/* 公示公告 ---------------------------------------------------------- */
router.get('/notices', wrap(async (req, res) => {
  const page = await db.paginate(
    `SELECT id, title, content, notice_type, publisher, is_top, views, publish_time FROM notice
     WHERE target_role IN ('ALL','ENTERPRISE') ORDER BY is_top DESC, publish_time DESC`,
    [], req.query
  );
  ok(res, page);
}));

router.get('/notices/:id', wrap(async (req, res) => {
  const n = await db.one('SELECT * FROM notice WHERE id = ?', [req.params.id]);
  if (!n) return fail(res, '公告不存在', 404);
  await db.query('UPDATE notice SET views = views + 1 WHERE id = ?', [n.id]);
  ok(res, n);
}));

module.exports = router;
