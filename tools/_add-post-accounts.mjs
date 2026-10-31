/* 一次性执行脚本（2026-10-29）：为既有机构补齐缺口岗位账号。
 *
 * 背景：全平台账号盘点后发现三处「单人撑一岗」的结构性缺口 ——
 *   1) 大连碳中和技术研究院（ver001 所在机构）只有机构管理员，
 *      无法演示核查端「录入 → 审核」双人链（同账号自批会被 403 拒绝）；
 *   2) 邢台纸业（ent001）只有企业管理员，无法演示企业端
 *      「填报员提交 → 换人复核」与履约清缴的岗位分离；
 *   3) 交易端只有 trader01 一个席位，演示不出「已授权席位 vs
 *      未授权席位」的代理授权对照（trade_mandate 按交易员用户绑定）。
 *
 * 建号口径与 tools/add-supplementary-enterprises.cjs 一致：
 * pbkdf2 口令摘要（两端运行时均可校验）、演示口令 123456、
 * 岗位编码取自 user_post_dict（VER_CLERK/VER_REVIEWER/ENT_CLERK/QUOTA_MANAGER）。
 * 幂等：用户名已存在则跳过。
 */
import db from '../server/db.js';
import cu from '../server/blockchain/crypto-utils.js';

const ACCOUNTS = [
  { username: 'ver_dl_clerk',  realName: '大连核查录入员', role: 'VERIFIER', orgId: 1, orgName: '大连碳中和技术研究院有限公司', post: 'VER_CLERK' },
  { username: 'ver_dl_review', realName: '大连核查审核员', role: 'VERIFIER', orgId: 1, orgName: '大连碳中和技术研究院有限公司', post: 'VER_REVIEWER' },
  { username: 'ent001_clerk',  realName: '邢台纸业排放填报员', role: 'ENTERPRISE', orgId: 1, orgName: '邢台纸业有限公司', post: 'ENT_CLERK' },
  { username: 'ent001_quota',  realName: '邢台纸业履约管理员', role: 'ENTERPRISE', orgId: 1, orgName: '邢台纸业有限公司', post: 'QUOTA_MANAGER' },
  { username: 'trader02',      realName: '沈明远', role: 'TRADER', orgId: 1, orgName: '碳链通碳资产交易中心', post: null },
];

const PASSWORD = '123456';
let created = 0, skipped = 0;

for (const a of ACCOUNTS) {
  const exists = await db.one('SELECT id, status FROM sys_user WHERE username = ?', [a.username]);
  if (exists) { console.log(`· 跳过 ${a.username}（已存在 id=${exists.id} status=${exists.status}）`); skipped++; continue; }
  const salt = cu.randomSalt(16);
  const hash = cu.hashPasswordPbkdf2(PASSWORD, salt);
  await db.query(
    `INSERT INTO sys_user (username, password, salt, real_name, role, org_id, org_name, post, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,1,NOW())`,
    [a.username, hash, salt, a.realName, a.role, a.orgId, a.orgName, a.post]
  );
  console.log(`✔ 新建 ${a.username}（${a.role}${a.post ? ' / ' + a.post : ''} · ${a.orgName}）`);
  created++;
}

console.log(`\n完成：新建 ${created} · 跳过 ${skipped}`);
await db.pool.end();
