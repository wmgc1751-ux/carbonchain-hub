#!/usr/bin/env node
/**
 * tools/fix-single-account-20261031.cjs —— 单账号制迁移（2026-10-31）
 * ============================================================================
 * 设计决定：一个机构（企业/核查/监管/交易）只保留一个账号，职能整合进该账号。
 *
 * 幸存者选取（保持演示工具链与文档兼容）：
 *   · 企业      → 机构主账号（ent001 / ent_zjbd / ent_yfkw / ent_yxyf / ent_zjyls…）
 *   · 核查机构  → org1 保 ver001（ORG_ADMIN）；org8/45/54 保 *_review（复核为闭环收口）
 *   · 监管      → reg001（REG_CLERK，职能整合后含复核）
 *   · 交易      → trader01（trade_mandate 60 笔全部重指到 id=3）
 *   · 系统      → admin 本就唯一
 *
 * 安全性依据（迁移前已核查）：
 *   · 业务流全部按 role 鉴权（requireRole），postDuty 仅用于成员管理页；
 *   · verify_task.verifier_user 是生成字符串（'ver'+orgId），非 sys_user 外键；
 *   · 核查流程无"录入≠复核"身份隔离检查，单账号可贯通；
 *   · trade_mandate 是唯一 trader_user_id 外键，60 笔全部重指。
 *
 * 幂等：重复执行以"用户名不存在"为跳过条件。
 * 用法：node tools/fix-single-account-20261031.cjs [--dry]
 * ============================================================================
 */
'use strict';
const path = require('path');
const db = require(path.join(__dirname, '..', 'server', 'db'));
const DRY = process.argv.includes('--dry');

const DELETE_USERS = [
  // 企业子账号（5 厂 × 填报员/履约管理员）
  'ent001_clerk', 'ent001_quota', 'ent_zjbd_clerk', 'ent_zjbd_quota',
  'ent_yfkw_clerk', 'ent_yfkw_quota', 'ent_yxyf_clerk', 'ent_yxyf_quota',
  'ent_zjyls_clerk', 'ent_zjyls_quota',
  // 核查机构子账号（org1 双岗、org8/45/54 的 clerk）
  'ver_dl_clerk', 'ver_dl_review', 'ver_cz_clerk', 'ver_ts_clerk', 'ver_hblv_clerk',
  // 监管冗余账号（reg001 幸存）
  'reg_review', 'reg002', 'reg003',
  // 交易冗余账号（trader01 幸存）
  'trader02', 'trader03',
];

async function main() {
  console.log(`单账号制迁移 2026-10-31  ${DRY ? '【试算】' : ''}`);

  /* ---------- ① 岗位职责整合（user_post_dict）---------- */
  const DUTY = {
    ENT_ADMIN:   [1, 1, 1],   // 企业唯一账号：填报 + 复核 + 管理
    ORG_ADMIN:   [1, 1, 1],   // 核查唯一账号：核算 + 复核 + 管理
    VER_CLERK:   [1, 1, 1],
    VER_REVIEWER:[1, 1, 1],
    REG_CLERK:   [1, 1, 0],   // 监管唯一账号：经办 + 复核
  };
  for (const [post, [e, r, a]] of Object.entries(DUTY)) {
    const cur = await db.one('SELECT can_entry, can_review, can_admin FROM user_post_dict WHERE post = ?', [post]);
    if (!cur) continue;
    if (Number(cur.can_entry) === e && Number(cur.can_review) === r && Number(cur.can_admin) === a) continue;
    console.log(`  ① ${post} 职责 → entry=${e} review=${r} admin=${a}`);
    if (!DRY) await db.query(
      'UPDATE user_post_dict SET can_entry = ?, can_review = ?, can_admin = ? WHERE post = ?', [e, r, a, post]);
  }

  /* ---------- ② 交易授权重指（54/57 → trader01=3）---------- */
  const remand = await db.query(
    'SELECT trader_user_id, COUNT(*) n FROM trade_mandate WHERE trader_user_id IN (54,57) GROUP BY trader_user_id');
  for (const r of remand) {
    console.log(`  ② trade_mandate trader_user_id ${r.trader_user_id} → 3（${r.n} 笔）`);
    if (!DRY) await db.query('UPDATE trade_mandate SET trader_user_id = 3 WHERE trader_user_id = ?', [r.trader_user_id]);
  }

  /* ---------- ③ 幸存者岗位规范化 ---------- */
  const nor = await db.one("SELECT id, username, post FROM sys_user WHERE username = 'ent001'");
  if (nor && nor.post !== 'ENT_ADMIN') {
    console.log(`  ③ ${nor.username} post ${nor.post} → ENT_ADMIN`);
    if (!DRY) await db.query("UPDATE sys_user SET post = 'ENT_ADMIN' WHERE id = ?", [nor.id]);
  }

  /* ---------- ④ 删除冗余子账号 ---------- */
  for (const username of DELETE_USERS) {
    const u = await db.one('SELECT id, username, role FROM sys_user WHERE username = ?', [username]);
    if (!u) continue;   // 幂等
    console.log(`  ④ 删除 ${u.role} 子账号 ${u.username}（#${u.id}）—— 职能已并入机构主账号`);
    if (!DRY) await db.query('DELETE FROM sys_user WHERE id = ?', [u.id]);
  }

  /* ---------- ⑤ 终态核对 ---------- */
  const stat = await db.query(
    `SELECT role, COUNT(*) n FROM sys_user GROUP BY role ORDER BY role`);
  const total = stat.reduce((a, s) => a + Number(s.n), 0);
  const multi = await db.query(
    `SELECT role, org_id, COUNT(*) n FROM sys_user
      WHERE role IN ('ENTERPRISE','VERIFIER','TRADER','REGULATOR') AND org_id IS NOT NULL
      GROUP BY role, org_id HAVING n > 1`);
  const regN = await db.value("SELECT COUNT(*) FROM sys_user WHERE role = 'REGULATOR'");
  const trN = await db.value("SELECT COUNT(*) FROM sys_user WHERE role = 'TRADER'");
  console.log(`  ⑤ 终态：${total} 个账号（${stat.map((s) => s.role + '=' + s.n).join(' ')}）`);
  console.log(`  ⑤ 多账号机构：${multi.length}（应为 0）· 监管 ${regN}（应为 1）· 交易 ${trN}（应为 1）`);
  if (!DRY && (multi.length > 0 || Number(regN) !== 1 || Number(trN) !== 1)) {
    console.log('  ⚠ 未达成单账号终态，请人工核查上方明细');
  }

  console.log(DRY ? '[试算结束]' : '[迁移完成]');
  await db.pool.end();
}
main().catch((e) => { console.error('✘', e.message); console.error(e.stack); process.exit(1); });
