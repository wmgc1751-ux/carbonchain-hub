/**
 * services/integrity.js —— 内控与合规校验（P1）
 * ==================================================================
 * 三块职责，都是"系统层面必须硬阻断"的：
 *   ① 岗位分权 checkPost()：录入岗不能审核，审核岗不能录入（职责分离）
 *   ② 双人复核 requireDualControl()：关键动作的批准人必须与经办人不同
 *   ③ 资质互斥 assertNoConflict()：核查机构不得同时持有交易代理资质
 *
 * 为什么必须在服务层做而不是只在前端控制：
 *   前端可以绕过（改请求、直接调 API），而且答辩/审计问的是"系统能不能拦住"，
 *   不是"界面有没有按钮"。这三条都以抛错形式阻止动作发生。
 */
'use strict';

const db = require('../db');

/** 业务错误：带 HTTP 码，由路由层转 fail() */
class IntegrityError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'INTEGRITY_VIOLATION';
  }
}

/* ==================================================================
 * ① 岗位分权
 * ================================================================== */

/** 读取某岗位的职责位（录入/审核/管理） */
async function postDuty(post) {
  if (!post) return null;
  return db.one('SELECT * FROM user_post_dict WHERE post = ?', [post]);
}

/**
 * 校验当前用户具备某个职责位。
 * @param {object} user   req.user
 * @param {'ENTRY'|'REVIEW'|'ADMIN'} need
 * @param {string} action 用于错误提示的动作名（如"提交核查结论"）
 */
async function checkPost(user, need, action) {
  /* 兼容：未设置岗位的历史账号按角色推断默认权限，不因此阻断既有业务。
   * 但会返回 warning 供前端提示"请为账号设置岗位"。 */
  if (!user.post) {
    const legacy = legacyDuty(user.role);
    if (legacy && legacy[need]) return { ok: true, legacy: true };
    throw new IntegrityError(403,
      `${action}需要「${dutyCn(need)}」权限，当前账号未设置岗位。`
      + '请由机构管理员在「账号管理」中为账号指定岗位。', 'NO_POST');
  }
  const d = await postDuty(user.post);
  if (!d) {
    throw new IntegrityError(403, `岗位 ${user.post} 未在字典中定义，请联系管理员`, 'BAD_POST');
  }
  if (!d[`can_${need.toLowerCase()}`]) {
    throw new IntegrityError(403,
      `${action}需要「${dutyCn(need)}」权限，当前岗位为「${d.label}」，不具备该权限。`
      + '（职责分离：录入与审核必须由不同岗位承担）', 'POST_DENIED');
  }
  return { ok: true, duty: d };
}

/** 历史账号（无 post 字段）的默认职责，按角色保守推断 */
function legacyDuty(role) {
  switch (role) {
    case 'ENTERPRISE': return { ENTRY: true, REVIEW: true, ADMIN: true };
    case 'VERIFIER': return { ENTRY: true, REVIEW: true, ADMIN: true };
    case 'REGULATOR': return { ENTRY: true, REVIEW: true, ADMIN: true };
    default: return null;
  }
}

function dutyCn(need) {
  return { ENTRY: '录入', REVIEW: '审核', ADMIN: '管理员' }[need] || need;
}

/* ==================================================================
 * ② 双人复核
 * ================================================================== */

/**
 * 校验双人复核：批准人不得与经办人相同。
 * @param {number} actorId 当前操作人
 * @param {number} peerId  对方（经办或批准）user_id
 * @param {string} action  动作名
 */
function assertDualControl(actorId, peerId, action) {
  if (!peerId) {
    throw new IntegrityError(400,
      `${action}需要两人协作（经办 + 复核），缺少另一方签字位。`, 'DUAL_MISSING');
  }
  if (Number(actorId) === Number(peerId)) {
    throw new IntegrityError(403,
      `${action}不能由同一人经办并批准（自己批准自己）。`
      + '请由另一名具备审核权限的同事复核。', 'SELF_APPROVAL');
  }
  return true;
}

/* ==================================================================
 * ③ 资质互斥
 * ================================================================== */

/**
 * 为机构开通资质，遇互斥规则直接拒绝。
 * @param {string} orgKey  机构标识
 * @param {string} orgName 机构名称
 * @param {string} qualType VERIFIER / TRADER / SELF_TRADE
 * @param {object} opts { grantedBy, evidence }
 */
async function grantQualification(orgKey, orgName, qualType, opts = {}) {
  if (!orgKey || !qualType) throw new IntegrityError(400, '机构标识与资质类型必填');

  /* 查互斥规则：当前要开通的资质 vs 该机构已持有的 ACTIVE 资质 */
  const rules = await db.query(
    'SELECT * FROM qual_conflict_rule WHERE qual_a = ?', [qualType]
  );
  const conflicts = rules.map((r) => r.qual_b);
  if (conflicts.length) {
    const held = await db.query(
      `SELECT qual_type FROM org_qualification
        WHERE org_key = ? AND status = 'ACTIVE' AND qual_type IN (?)`,
      [orgKey, conflicts]
    );
    if (held.length) {
      const rule = rules.find((r) => r.qual_b === held[0].qual_type);
      throw new IntegrityError(409,
        `资质互斥：机构「${orgName}」已持有 ${held.map((h) => qualCn(h.qual_type)).join('、')} 资质，`
        + `不可同时开通 ${qualCn(qualType)}。${rule ? '理由：' + rule.reason : ''}`, 'QUAL_CONFLICT');
    }
  }

  const exist = await db.one(
    'SELECT id, status FROM org_qualification WHERE org_key = ? AND qual_type = ?', [orgKey, qualType]
  );
  if (exist) {
    if (exist.status === 'ACTIVE') {
      throw new IntegrityError(409, `该机构已持有 ${qualCn(qualType)} 资质`, 'QUAL_EXISTS');
    }
    await db.query(
      "UPDATE org_qualification SET status='ACTIVE', revoked_at=NULL, granted_by=?, granted_at=NOW(), evidence=? WHERE id=?",
      [opts.grantedBy || null, opts.evidence || null, exist.id]
    );
    return { id: exist.id, reactivated: true };
  }
  const r = await db.query(
    `INSERT INTO org_qualification (org_key, org_name, qual_type, granted_by, evidence)
     VALUES (?,?,?,?,?)`,
    [orgKey, orgName, qualType, opts.grantedBy || null, opts.evidence || null]
  );
  return { id: r.insertId, created: true };
}

/** 巡检：扫描全部机构，找出同时持有互斥资质的（历史数据绕过写时校验的情况） */
async function auditConflicts() {
  const rules = await db.query('SELECT * FROM qual_conflict_rule');
  const found = [];
  for (const r of rules) {
    const rows = await db.query(
      `SELECT a.org_key, a.org_name, a.qual_type AS qual_a, b.qual_type AS qual_b
         FROM org_qualification a
         JOIN org_qualification b
           ON b.org_key = a.org_key AND b.qual_type = ? AND b.status = 'ACTIVE'
        WHERE a.qual_type = ? AND a.status = 'ACTIVE'`,
      [r.qual_b, r.qual_a]
    );
    for (const x of rows) {
      const key = x.org_key + '|' + [x.qual_a, x.qual_b].sort().join('+');
      if (!found.some((f) => f.key === key)) {
        found.push({ key, ...x, reason: r.reason });
      }
    }
  }
  return found;
}

/**
 * 单笔交易的利益冲突抽查：交易对手是否为本机构的被核查企业。
 * 这是"最实用的一层"——写时互斥只能拦住新开资质，查不到"机构已持有的核查客户正在被自己交易"。
 */
async function checkTradeConflict(traderOrgKeys, buyerEntId, sellerEntId) {
  if (!traderOrgKeys || !traderOrgKeys.length) return [];
  const entIds = [buyerEntId, sellerEntId].filter(Boolean);
  if (!entIds.length) return [];
  const rows = await db.query(
    `SELECT vt.id, vt.report_id, er.ent_id, er.ent_name, vo.org_name
       FROM verify_task vt
       JOIN emission_report er ON er.id = vt.report_id
       LEFT JOIN verifier_org vo ON vo.id = vt.verifier_id
      WHERE er.ent_id IN (?) AND vt.status IN ('ACCEPTED','COMPLETED','VERIFYING')`,
    [entIds]
  );
  /* 只看属于本机构核查的 */
  return rows.filter((r) => r.org_name && traderOrgKeys.includes(normalizeOrg(r.org_name)));
}

function normalizeOrg(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

function qualCn(t) {
  return { VERIFIER: '第三方核查', TRADER: '交易代理', SELF_TRADE: '自营交易' }[t] || t;
}

/* ==================================================================
 * ④ 审计批次锚点
 * ================================================================== */

/**
 * 把一段区间的审计日志做 Merkle 根并上链。
 * 日志本身也可能被 DBA 改，上链后才具备"事后无法悄悄篡改"的性质。
 */
async function anchorAuditBatch(anchorSvc, merkleFn, sha256Fn, batchSize = 500) {
  const row = await db.one('SELECT MAX(to_id) AS lastTo FROM audit_anchor');
  const fromId = Number(row && row.lastTo ? row.lastTo : 0) + 1;
  const rows = await db.query(
    `SELECT id, username, module, action, target, result, created_at
       FROM audit_log WHERE id >= ? ORDER BY id ASC LIMIT ?`, [fromId, batchSize]
  );
  if (!rows.length) return null;
  const leaves = rows.map((r) => sha256Fn([r.id, r.username, r.module, r.action, r.target, r.result,
    String(r.created_at)].join('|')));
  const root = merkleFn(leaves);
  const toId = rows[rows.length - 1].id;

  const anchor = await anchorSvc.anchor({
    txType: 'AUDIT_BATCH',
    bizNo: `AUDIT-${fromId}-${toId}`,
    fromLabel: 'regulator:system',
    payload: {
      fromId, toId, rowCount: rows.length, merkleRoot: root,
      note: '审计日志批次锚点：本批日志的 Merkle 根，用于证明日志未被事后篡改',
    },
  });
  const ins = await db.query(
    `INSERT INTO audit_anchor (from_id, to_id, row_count, merkle_root, chain_tx_id, block_index)
     VALUES (?,?,?,?,?,?)`,
    [fromId, toId, rows.length, root, anchor.txId, anchor.blockIndex]
  );
  return { id: ins.insertId, fromId, toId, rowCount: rows.length, merkleRoot: root, chainTxId: anchor.txId };
}

module.exports = {
  IntegrityError,
  checkPost, postDuty, dutyCn,
  assertDualControl,
  grantQualification, auditConflicts, checkTradeConflict,
  anchorAuditBatch, normalizeOrg, qualCn,
};
