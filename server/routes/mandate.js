/**
 * routes/mandate.js —— 代理交易授权管理（P0 修复配对的授权侧）
 * ==================================================================
 * 为什么单独一个路由文件：
 *   授权是"企业主权行为"，必须有独立的生命周期管理（签发/查询/撤销/续期），
 *   而不是散落在交易接口里。企业端与监管端都要能看，但只有企业端能签发。
 *
 * 权限矩阵：
 *   · 企业端(ENTERPRISE)：签发 / 撤销自己的授权，只能看到自己的授权
 *   · 监管端(REGULATOR)：只读全量台账（查看谁授权给谁、范围、期限、状态）
 *   · 交易端(TRADER)：只读"授给自己的"授权（用于显示当前可代理哪些企业）
 *   · 管理员(ADMIN)：不参与（按 P1 内控要求，管理员不做业务决策）
 *
 * 上链：签发与撤销动作都上链，使"企业确实授权过 / 撤销过"成为不可否认的事实。
 */
'use strict';

const express = require('express');
const { authRequired, requireRole, writeLog, ok, fail, wrap } = require('../middleware/auth');
const db = require('../db');
const anchorSvc = require('../services/anchor');

const router = express.Router();

const SCOPES = ['TRADE_ONLY', 'TRADE_AND_OFFSET'];
const SCOPE_CN = { TRADE_ONLY: '仅交易', TRADE_AND_OFFSET: '交易+清缴' };

/* ==================================================================
 * 企业端：查看自己的授权（含已撤销，便于留痕）
 * ================================================================== */
router.get('/mine', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const entId = Number(req.user.orgId);
  const rows = await db.query(
    `SELECT m.*, u.username AS trader_username, u.org_name AS trader_org_name,
            g.real_name AS granted_by_name
       FROM trade_mandate m
       LEFT JOIN sys_user u ON u.id = m.trader_user_id
       LEFT JOIN sys_user g ON g.id = m.granted_by
      WHERE m.ent_id = ?
      ORDER BY m.id DESC`, [entId]
  );
  ok(res, {
    rows: rows.map((r) => ({
      ...r,
      scopeCn: SCOPE_CN[r.scope] || r.scope,
      /* 实时状态：库里的 ACTIVE 若已过期，界面上要显示为已过期 */
      effectiveStatus: r.status === 'ACTIVE' && new Date(r.valid_to) < new Date() ? 'EXPIRED' : r.status,
    })),
  });
}));

/* ==================================================================
 * 企业端：签发授权
 * ================================================================== */
router.post('/', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const entId = Number(req.user.orgId);
  const b = req.body || {};
  const traderUserId = Number(b.traderUserId);
  const scope = String(b.scope || 'TRADE_ONLY').toUpperCase();
  const validFrom = b.validFrom ? new Date(b.validFrom) : new Date();
  const validTo = b.validTo ? new Date(b.validTo) : null;
  const maxAmount = b.maxAmount === undefined || b.maxAmount === '' || b.maxAmount === null
    ? null : Number(b.maxAmount);

  /* ---- 参数校验 ---- */
  if (!Number.isInteger(traderUserId) || traderUserId <= 0) {
    return fail(res, '请选择受托交易机构', 400);
  }
  if (!SCOPES.includes(scope)) return fail(res, `授权范围非法（${SCOPES.join(' / ')}）`, 400);
  if (!validTo || Number.isNaN(validTo.getTime())) return fail(res, '请填写授权到期时间', 400);
  if (validTo <= validFrom) return fail(res, '到期时间必须晚于生效时间', 400);
  if (validTo.getTime() - validFrom.getTime() > 3 * 365 * 864e5) {
    return fail(res, '授权期限不得超过 3 年', 400);
  }
  if (maxAmount !== null && (!Number.isFinite(maxAmount) || maxAmount <= 0)) {
    return fail(res, '额度上限必须为正数（留空表示不限额）', 400);
  }

  /* ---- 受托方必须是真实存在的 TRADER 账号 ---- */
  const trader = await db.one(
    "SELECT id, username, org_name FROM sys_user WHERE id = ? AND role = 'TRADER' AND status = 1",
    [traderUserId]
  );
  if (!trader) return fail(res, '受托方不是有效的交易端账号', 400);

  /* ---- 同一企业+机构+范围 只能有一条有效授权（重复签发先撤销旧的）---- */
  const exist = await db.one(
    "SELECT id FROM trade_mandate WHERE ent_id = ? AND trader_user_id = ? AND scope = ? AND status = 'ACTIVE'",
    [entId, traderUserId, scope]
  );
  if (exist) {
    return fail(res, `已存在同范围的有效授权（#${exist.id}）。如需调整，请先撤销原授权再重新签发。`, 409);
  }

  const [r] = [await db.query(
    `INSERT INTO trade_mandate
       (ent_id, trader_user_id, scope, max_amount, valid_from, valid_to, status, granted_by)
     VALUES (?,?,?,?,?,?,'ACTIVE',?)`,
    [entId, traderUserId, scope, maxAmount, validFrom, validTo, req.user.id]
  )];
  const id = r.insertId;

  /* ---- 授权动作上链（不可否认的关键证据）---- */
  let txId = null;
  let blockIndex = null;
  try {
    const anchor = await anchorSvc.anchor({
      txType: 'TRADE_MANDATE',
      bizNo: `MANDATE-${id}`,
      fromLabel: `ent:${entId}`,
      payload: {
        mandateId: id,
        action: 'GRANT',
        entId,
        traderUserId,
        traderName: trader.org_name || trader.username,
        scope,
        maxAmount,
        validFrom: validFrom.toISOString(),
        validTo: validTo.toISOString(),
        grantedBy: req.user.id,
        grantedByName: req.user.realName || req.user.username,
        note: '企业授权交易机构代理碳配额交易；本记录为授权事实的链上锚点',
      },
    });
    txId = anchor.txId;
    blockIndex = anchor.blockIndex;
    await db.query('UPDATE trade_mandate SET chain_tx_id = ? WHERE id = ?', [txId, id]);
  } catch (e) {
    /* 上链失败不阻塞授权生效（授权是业务行为，链是存证），但要如实标注 */
    await writeLog(req, '代理授权', '签发授权',
      `MANDATE-${id}`, `上链失败：${String(e.message).slice(0, 80)}`, 'PARTIAL');
  }

  await writeLog(req, '代理授权', '签发授权', `MANDATE-${id}`,
    `授权 ${trader.org_name || trader.username} 代理 ${SCOPE_CN[scope]}`
    + (maxAmount ? `，单笔上限 ${maxAmount} t` : '，不限额')
    + `，有效期至 ${validTo.toISOString().slice(0, 10)}`, 'SUCCESS');

  ok(res, {
    id, scope, scopeCn: SCOPE_CN[scope], maxAmount,
    validFrom, validTo, chainTxId: txId, blockIndex,
  }, `授权已生效${txId ? '并已上链存证' : '（上链失败，已记录）'}`);
}));

/* ==================================================================
 * 企业端：撤销授权
 * ================================================================== */
router.post('/:id/revoke', authRequired, requireRole('ENTERPRISE'), wrap(async (req, res) => {
  const entId = Number(req.user.orgId);
  const id = Number(req.params.id);
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);

  const m = await db.one('SELECT * FROM trade_mandate WHERE id = ? AND ent_id = ?', [id, entId]);
  if (!m) return fail(res, '授权不存在或不属于本企业', 404);
  if (m.status !== 'ACTIVE') return fail(res, `授权当前状态为 ${m.status}，无法撤销`, 400);

  await db.query(
    "UPDATE trade_mandate SET status='REVOKED', revoked_by=?, revoked_at=NOW(), revoke_reason=? WHERE id=?",
    [req.user.id, reason || '企业主动撤销', id]
  );

  let txId = null;
  try {
    const anchor = await anchorSvc.anchor({
      txType: 'TRADE_MANDATE',
      bizNo: `MANDATE-${id}-REVOKE`,
      fromLabel: `ent:${entId}`,
      payload: {
        mandateId: id, action: 'REVOKE', entId,
        traderUserId: m.trader_user_id, scope: m.scope,
        revokedBy: req.user.id, revokedByName: req.user.realName || req.user.username,
        reason: reason || '企业主动撤销',
        note: '企业撤销代理授权；撤销后该机构不得再代理本企业任何交易操作',
      },
    });
    txId = anchor.txId;
  } catch (e) { /* 上链失败不阻塞撤销 */ }

  await writeLog(req, '代理授权', '撤销授权', `MANDATE-${id}`, reason || '企业主动撤销', 'SUCCESS');
  ok(res, { id, status: 'REVOKED', chainTxId: txId }, '授权已撤销，该机构将无法再代理本企业交易');
}));

/* ==================================================================
 * 监管端：全量授权台账（只读）
 * ================================================================== */
router.get('/ledger', authRequired, requireRole('REGULATOR'), wrap(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.entId) { where.push('m.ent_id = ?'); params.push(Number(req.query.entId)); }
  if (req.query.traderUserId) { where.push('m.trader_user_id = ?'); params.push(Number(req.query.traderUserId)); }
  if (req.query.status) { where.push('m.status = ?'); params.push(String(req.query.status)); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await db.query(
    `SELECT m.*, e.ent_name, e.ent_code,
            u.username AS trader_username, u.org_name AS trader_org_name,
            g.real_name AS granted_by_name, rv.real_name AS revoked_by_name
       FROM trade_mandate m
       LEFT JOIN enterprise e ON e.id = m.ent_id
       LEFT JOIN sys_user u ON u.id = m.trader_user_id
       LEFT JOIN sys_user g ON g.id = m.granted_by
       LEFT JOIN sys_user rv ON rv.id = m.revoked_by
       ${w}
      ORDER BY m.id DESC LIMIT 500`, params
  );

  /* 统计：有效 / 已撤销 / 已过期 */
  const stat = await db.query(
    `SELECT
       SUM(status='ACTIVE' AND valid_to >= NOW()) AS active,
       SUM(status='ACTIVE' AND valid_to <  NOW()) AS expired,
       SUM(status='REVOKED') AS revoked,
       COUNT(*) AS total
     FROM trade_mandate`
  );

  ok(res, {
    rows: rows.map((r) => ({
      ...r,
      scopeCn: SCOPE_CN[r.scope] || r.scope,
      effectiveStatus: r.status === 'ACTIVE' && new Date(r.valid_to) < new Date() ? 'EXPIRED' : r.status,
    })),
    summary: {
      total: Number(stat[0].total || 0),
      active: Number(stat[0].active || 0),
      expired: Number(stat[0].expired || 0),
      revoked: Number(stat[0].revoked || 0),
    },
  });
}));

/* ==================================================================
 * 交易端：查看授给自己的授权（决定可代理哪些企业）
 * ================================================================== */
router.get('/granted-to-me', authRequired, requireRole('TRADER'), wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT m.*, e.ent_name, e.ent_code
       FROM trade_mandate m
       JOIN enterprise e ON e.id = m.ent_id
      WHERE m.trader_user_id = ? AND m.status = 'ACTIVE' AND m.valid_to >= NOW()
      ORDER BY m.id DESC`, [req.user.id]
  );
  ok(res, {
    rows: rows.map((r) => ({ ...r, scopeCn: SCOPE_CN[r.scope] || r.scope })),
    note: '仅这些企业已授权本机构代理交易；未在列表中的企业不可操作。',
  });
}));

/* ==================================================================
 * 企业端：可授权的交易机构候选（真实存在的 TRADER 账号）
 * ================================================================== */
router.get('/candidates', authRequired, requireRole('ENTERPRISE', 'REGULATOR'), wrap(async (req, res) => {
  const rows = await db.query(
    "SELECT id, username, org_name, real_name FROM sys_user WHERE role='TRADER' AND status=1 ORDER BY id"
  );
  ok(res, rows.map((r) => ({ id: r.id, username: r.username, name: r.org_name || r.real_name || r.username })));
}));

module.exports = router;
