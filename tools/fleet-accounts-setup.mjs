/* 三闭环账号体系搭建（2026-10-30，一次性执行，幂等）
 *
 * 为 56 家在册合成企业建立「闭环 B / 闭环 C」的服务账号与企业主账号：
 *   · reg002 / reg003      —— 两个闭环的监管席位（REG_CLERK）
 *   · trader03             —— 闭环 C 的交易席位（trader02 已存在，闭环 B 复用）
 *   · ent001 ~ ent060      —— 56 家企业的主账号（用户名 = ent + 3 位企业 id，
 *                             已存在的 ent001 跳过），一企一号
 * 口令统一 123456（pbkdf2 摘要），与演示账号口径一致。
 * 原闭环（四家真实企业 + reg001 + ver_cz_review + trader01）不动。
 */
import db from '../server/db.js';
import cu from '../server/blockchain/crypto-utils.js';

const PASSWORD = '123456';

/* 56 家在册合成企业（id 1~60，剔除 CLOSED 的 20/27/47/52）；
 * 前 28 家 → 闭环 B（唐山机构），后 28 家 → 闭环 C（河北绿链） */
const FLEET_ENT_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21,
  22, 23, 24, 25, 26, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 48, 49, 50, 51,
  53, 54, 55, 56, 57, 58, 59, 60,
];

const ACCOUNTS = [
  { username: 'reg002', realName: '冀南监管组经办人', role: 'REGULATOR', orgId: null, orgName: '省级生态环境厅冀南监管组', post: 'REG_CLERK' },
  { username: 'reg003', realName: '冀北监管组经办人', role: 'REGULATOR', orgId: null, orgName: '省级生态环境厅冀北监管组', post: 'REG_CLERK' },
  { username: 'trader03', realName: '陆远航', role: 'TRADER', orgId: 1, orgName: '碳链通碳资产交易中心', post: null },
];

let created = 0, skipped = 0;

async function ensure(a) {
  const exists = await db.one('SELECT id, status FROM sys_user WHERE username = ?', [a.username]);
  if (exists) { console.log(`· 跳过 ${a.username}（已存在 id=${exists.id}）`); skipped++; return; }
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

/* 服务账号 */
for (const a of ACCOUNTS) await ensure(a);

/* 企业主账号：用户名 = ent + 3 位企业 id */
const ents = await db.query(
  `SELECT id, ent_name FROM enterprise WHERE id IN (${FLEET_ENT_IDS.map(() => '?').join(',')})`,
  FLEET_ENT_IDS
);
const byId = new Map(ents.map((e) => [e.id, e]));
for (const id of FLEET_ENT_IDS) {
  const e = byId.get(id);
  if (!e) { console.log(`⚠ 企业 ${id} 不存在，跳过`); continue; }
  await ensure({
    username: 'ent' + String(id).padStart(3, '0'),
    realName: e.ent_name + '管理员',
    role: 'ENTERPRISE', orgId: id, orgName: e.ent_name, post: 'ENT_ADMIN',
  });
}

console.log(`\n完成：新建 ${created} · 跳过 ${skipped}`);
await db.pool.end();
