/**
 * routes/disclosure.js —— 公示专区与公示授权（P2）
 * ==================================================================
 * 设计原则：**未授权默认不公示**。
 *   企业授权书通常不含"对外公示"，直接公示会超出授权范围。
 *   因此每一项公示都需要企业显式授权（disclosure_consent），
 *   未授权的企业数据一律不出现在公开接口里。
 *
 * 三个层次：
 *   · 企业端：查看可公示项说明 / 授权 / 撤回
 *   · 公众端：只读已授权企业的脱敏公示数据（无需登录）
 *   · 监管端：查看各企业公示授权覆盖率（谁授权了、谁没授权）
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const db = require('../db');
const anchorSvc = require('../services/anchor');

const router = express.Router();

/* ==================================================================
 * 企业端：查看公示项说明与自己的授权状态
 * ================================================================== */
router.get('/consent', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const entId = Number(req.user.orgId);
  const items = await db.query('SELECT * FROM disclosure_item_dict ORDER BY item');
  const mine = await db.query('SELECT * FROM disclosure_consent WHERE ent_id = ?', [entId]);
  const map = new Map(mine.map((m) => [m.item, m]));
  ok(res, {
    items: items.map((it) => ({
      ...it,
      status: (map.get(it.item) || {}).consent_status || 'NONE',
      maskLevel: (map.get(it.item) || {}).mask_level || 'SUMMARY',
      grantedAt: (map.get(it.item) || {}).granted_at || null,
      note: (map.get(it.item) || {}).note || null,
    })),
    hint: '未授权的公示项不会出现在公众页面。授权与撤回均即时生效。',
  });
}));

/* ==================================================================
 * 企业端：授权 / 撤回 某个公示项
 * ================================================================== */
router.post('/consent', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const entId = Number(req.user.orgId);
  const { item, action, maskLevel, note } = req.body || {};
  if (!['VERIFY_RESULT', 'COMPLIANCE', 'EMISSION_RANK'].includes(item)) {
    return fail(res, '公示项不合法', 400);
  }
  if (!['GRANT', 'REVOKE'].includes(action)) return fail(res, 'action 必须是 GRANT 或 REVOKE', 400);

  const status = action === 'GRANT' ? 'GRANTED' : 'REVOKED';
  const lvl = maskLevel === 'DETAIL' ? 'DETAIL' : 'SUMMARY';

  const exist = await db.one('SELECT id FROM disclosure_consent WHERE ent_id = ? AND item = ?', [entId, item]);
  if (exist) {
    await db.query(
      `UPDATE disclosure_consent
          SET consent_status = ?, mask_level = ?, granted_by = ?,
              granted_at = IF(?='GRANTED', NOW(), granted_at),
              revoked_at = IF(?='REVOKED', NOW(), NULL),
              note = ?
        WHERE id = ?`,
      [status, lvl, req.user.id, status, status, note || null, exist.id]
    );
  } else {
    await db.query(
      `INSERT INTO disclosure_consent (ent_id, item, consent_status, mask_level, granted_by, granted_at, note)
       VALUES (?,?,?,?,?,NOW(),?)`,
      [entId, item, status, lvl, req.user.id, note || null]
    );
  }

  /* 授权/撤回动作上链（公示范围是企业的实质权利，应当可追溯） */
  let txId = null;
  try {
    const a = await anchorSvc.anchor({
      txType: 'DISCLOSURE_CONSENT',
      bizNo: `DISC-${entId}-${item}-${Date.now()}`,
      fromLabel: `ent:${entId}`,
      payload: {
        entId, item, action, maskLevel: lvl,
        operator: req.user.realName || req.user.username,
        note: note || null,
        note2: action === 'GRANT' ? '企业授权本项公示（脱敏后）' : '企业撤回本项公示授权',
      },
    });
    txId = a.txId;
  } catch (e) { /* 上链失败不阻塞 */ }

  await writeLog(req, '信息公开', action === 'GRANT' ? '授权公示' : '撤回公示',
    item, `脱敏级别 ${lvl}${note ? ' · ' + note : ''}`, 'SUCCESS');
  ok(res, { item, status, maskLevel: lvl, chainTxId: txId },
    action === 'GRANT' ? '已授权公示（公众页面将出现本项，脱敏展示）' : '已撤回授权（公众页面立即移除本项）');
}));

/* ==================================================================
 * 公众端：已授权企业的公示数据（无需登录）
 * ================================================================== */
router.get('/public/:item', wrap(async (req, res) => {
  const item = String(req.params.item || '').toUpperCase();
  if (!['VERIFY_RESULT', 'COMPLIANCE', 'EMISSION_RANK'].includes(item)) {
    return fail(res, '公示项不合法', 400);
  }

  /* 只有 GRANTED 的企业才进结果集 */
  const consented = await db.query(
    `SELECT c.ent_id, c.mask_level, c.granted_at
       FROM disclosure_consent c
      WHERE c.item = ? AND c.consent_status = 'GRANTED'`, [item]
  );
  const entIds = consented.map((c) => Number(c.ent_id));
  if (!entIds.length) {
    return ok(res, {
      item, count: 0, rows: [],
      note: '当前没有企业授权公示本项。公示需企业逐项授权——未授权不公示，这是授权范围的边界。',
    });
  }

  let rows = [];
  if (item === 'VERIFY_RESULT') {
    rows = await db.query(
      `SELECT e.ent_name, e.industry, e.region,
              er.period, vr.conclusion, vr.issue_time,
              vo.org_name AS verifier_name, vr.chain_tx_id
         FROM verify_report vr
         JOIN enterprise e ON e.id = vr.ent_id
         LEFT JOIN emission_report er ON er.id = vr.emission_report_id
         LEFT JOIN verifier_org vo ON vo.id = vr.verifier_id
        WHERE vr.ent_id IN (?) AND vr.approved_by IS NOT NULL
        ORDER BY vr.issue_time DESC LIMIT 200`, [entIds]
    );
    /* 脱敏：只给结论与机构，不给数值 */
    rows = rows.map((r) => ({
      enterprise: r.ent_name, industry: r.industry, region: r.region,
      period: r.period,
      conclusion: r.conclusion === 'PASS' ? '通过' : r.conclusion === 'FAIL' ? '不通过' : '有条件通过',
      verifier: r.verifier_name,
      issueDate: r.issue_time ? String(r.issue_time).slice(0, 10) : null,
      chainTxId: r.chain_tx_id ? String(r.chain_tx_id).slice(0, 16) + '…' : null,
      note: '按公示授权脱敏：仅展示结论，不展示排放数值与核查底稿',
    }));
  } else if (item === 'COMPLIANCE') {
    rows = await db.query(
      `SELECT e.ent_name, e.industry, q.year,
              SUM(q.total_allocated) AS alloc,
              SUM(q.used) AS used,
              SUM(s.surrendered_quota) AS surrendered
         FROM enterprise e
         JOIN carbon_quota q ON q.ent_id = e.id
         LEFT JOIN quota_surrender s ON s.ent_id = e.id AND s.year = q.year
        WHERE e.id IN (?)
        GROUP BY e.id, e.ent_name, e.industry, q.year
        ORDER BY q.year DESC LIMIT 200`, [entIds]
    );
    rows = rows.map((r) => {
      const done = Number(r.used) > 0 && Number(r.surrendered) >= Number(r.used) * 0.999;
      return {
        enterprise: r.ent_name, industry: r.industry, year: r.year,
        compliant: done ? '已足额清缴' : (Number(r.surrendered) > 0 ? '部分清缴' : '未见清缴记录'),
        note: '按公示授权脱敏：仅展示履约状态，不展示金额与交易价格',
      };
    });
  } else {
    /* EMISSION_RANK：只给分档，不给精确值 */
    rows = await db.query(
      `SELECT e.ent_name, e.industry, SUM(r.total_emission) AS total
         FROM enterprise e JOIN emission_report r ON r.ent_id = e.id
        WHERE e.id IN (?) AND r.status <> 'DRAFT'
        GROUP BY e.id, e.ent_name, e.industry`, [entIds]
    );
    const byInd = {};
    rows.forEach((r) => { (byInd[r.industry] = byInd[r.industry] || []).push(r); });
    rows = rows.map((r) => {
      const peers = byInd[r.industry] || [];
      const sorted = peers.slice().sort((a, b) => Number(b.total) - Number(a.total));
      const idx = sorted.findIndex((p) => p.ent_name === r.ent_name);
      const pct = sorted.length > 1 ? idx / (sorted.length - 1) : 0;
      return {
        enterprise: r.ent_name, industry: r.industry,
        band: pct <= 0.33 ? 'A（行业排放较低档）' : pct <= 0.66 ? 'B（行业排放中等档）' : 'C（行业排放较高档）',
        note: '按公示授权脱敏：仅展示所在行业分档，不展示精确排放量与排名位次',
      };
    });
  }

  ok(res, {
    item, count: rows.length, rows,
    consentingEnterprises: entIds.length,
    updatedAt: new Date().toISOString(),
    disclaimer: '本页数据经企业授权公示并脱敏；未授权企业的数据不在此展示。链上存证可逐笔核验。',
  });
}));

/* ==================================================================
 * 监管端：公示授权覆盖率
 * ================================================================== */
router.get('/coverage', authRequired, requireRole('REGULATOR', 'ADMIN'), wrap(async (req, res) => {
  const ents = await db.query('SELECT id, ent_name FROM enterprise WHERE status = ?', ['ACTIVE']);
  const cons = await db.query("SELECT ent_id, item, consent_status FROM disclosure_consent WHERE consent_status = 'GRANTED'");
  const byEnt = {};
  cons.forEach((c) => { (byEnt[c.ent_id] = byEnt[c.ent_id] || []).push(c.item); });
  ok(res, {
    totalEnterprises: ents.length,
    rows: ents.map((e) => ({
      entId: e.id, entName: e.ent_name,
      granted: byEnt[e.id] || [],
      grantedCount: (byEnt[e.id] || []).length,
    })),
    summary: {
      enterprisesWithAny: Object.keys(byEnt).length,
      coverageRate: ents.length ? Number((Object.keys(byEnt).length / ents.length * 100).toFixed(1)) : 0,
    },
    note: '未授权的公示项不会出现在公众页面。推动企业授权是信息公开的前提。',
  });
}));

module.exports = router;
