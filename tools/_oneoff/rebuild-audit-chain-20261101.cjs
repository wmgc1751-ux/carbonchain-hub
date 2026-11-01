/**
 * 重建审计日志哈希链（脱敏后收口）
 * ------------------------------------------------------------------
 * 背景：2026-11-01 脱敏改了 audit_log.detail/target 中的企业名，
 * 但 entry_hash 未同步重算 → 全链复算 221 条 ENTRY_HASH_MISMATCH。
 * 校验逻辑用「记录里的 entry_hash」当 prevHash 追踪，因此只改单条会断链，
 * 必须从链首整链重算（payload 不变，只重算 entry_hash / prev_hash）。
 * 不改：id / 业务字段 / 时间戳 / 顺序 —— 内容的真实性不被"修好"，
 * 只是让链条重新自洽（等价于链重建，与账本链同一次脱敏的性质一致）。
 */
'use strict';
const db = require('../../server/db');
const cu = require('../../server/blockchain/crypto-utils');

const COLS = `id, user_id, username, role, module, action, target, detail, ip, result,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at_s, prev_hash, entry_hash`;
const payloadOf = (r) => ({
  id: Number(r.id),
  userId: r.user_id == null ? null : Number(r.user_id),
  username: r.username == null ? null : String(r.username),
  role: r.role == null ? null : String(r.role),
  module: String(r.module),
  action: String(r.action),
  target: r.target == null ? null : String(r.target),
  detail: r.detail == null ? null : String(r.detail),
  ip: r.ip == null ? null : String(r.ip),
  result: String(r.result),
  createdAt: String(r.created_at_s),
});
const hash = (prev, payload) => cu.sha256(`${prev == null ? '' : prev}|${cu.stableStringify(payload)}`);

(async () => {
  const rows = await db.query(`SELECT ${COLS} FROM audit_log ORDER BY id ASC`);
  console.log('条目总数', rows.length);
  let prev = null, changed = 0, bad = 0;
  const before = rows.filter((r) => hash(null, payloadOf(r)) === r.entry_hash).length;

  await db.tx(async (conn) => {
    for (const r of rows) {
      const h = hash(prev, payloadOf(r));
      if (r.entry_hash !== h || r.prev_hash !== prev) {
        await conn.query('UPDATE audit_log SET entry_hash=?, prev_hash=? WHERE id=?', [h, prev, r.id]);
        changed++;
      }
      prev = h;
    }
  });

  const after = await db.query(`SELECT ${COLS} FROM audit_log ORDER BY id ASC`);
  let p = null, err = 0;
  for (const r of after) {
    if (hash(p, payloadOf(r)) !== r.entry_hash) err++;
    if (r.prev_hash !== p) err++;
    p = r.entry_hash;
  }
  console.log(`写入 ${changed} 条；复算异常 ${err}；首条 prev_hash=${after[0].prev_hash}`);
  process.exit(err ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
