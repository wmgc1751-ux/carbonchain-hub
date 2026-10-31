#!/usr/bin/env node
/**
 * 把「保定四家真实企业」的业务数据从临时库 cc_tmp_restore 迁回业务库 carbon_chain。
 *
 * 背景：2026-10-29 17:00 按用户要求把数据回滚到「四家企业接入之前」，
 *       enterprise 65~68 及其全部关联数据被清理，17:08 的全量备份保留在
 *       _backup-before-restore/ 并已还原到 cc_tmp_restore。
 *       本次是反向操作：把四家企业连同真实 CEMS 数据、排放报告、核查结论、
 *       配额与交易记录一并装回平台，供演示账号登录查看。
 *
 * 两条硬约束：
 *   1) 业务表 id 与当前库重叠（如 verify_report 281~286 已被 42~50 号企业占用），
 *      因此所有内部自增 id 统一偏移 ID_SHIFT；引用本批次的列同步偏移。
 *   2) 跨库引用（verifier_org / data_source / 因子等）属共享字典，不偏移；
 *      sys_user 保持原 id 插入，仅把与现有账号冲突的 trader01 引用改指当前 id。
 *
 * 用法：node tools/restore-four-enterprises.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

/* 项目未引入 dotenv，沿用 tools/ 下其它脚本的做法手工解析 .env */
const ENV = (() => {
  try { return readFileSync(new URL('../.env', import.meta.url), 'utf8'); } catch { return ''; }
})();
const env = (k, d = '') => {
  const m = ENV.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : d;
};

const DRY = process.argv.includes('--dry-run');
const SRC = 'cc_tmp_restore';
const DST = env('DB_NAME', 'carbon_chain');
const ID_SHIFT = 1_000_000;
const ENT_IDS = [65, 66, 67, 68];

/* 业务表：按 ent_id 归属四家企业。
 * order 决定插入顺序 —— 父表先于子表，子表的外键列才能取到已平移的父 id。 */
const ENT_TABLES = [
  { t: 'emission_report',  refs: {} },                                          // 父：报告
  { t: 'emission_item',    refs: { report_id: 'emission_report' } },            // 子：明细
  { t: 'verify_task',      refs: { report_id: 'emission_report' } },            // 子：核查任务
  { t: 'verify_report',    refs: { task_id: 'verify_task', emission_report_id: 'emission_report' } },
  { t: 'calc_batch',       refs: {} },                                          // 父：核算批次
  { t: 'quota_surrender',  refs: { calc_batch_id: 'calc_batch', verify_report_id: 'verify_report' } },
  { t: 'trade_mandate',    refs: {} },                                          // 父：交易授权
  { t: 'trade_order',      refs: { mandate_id: 'trade_mandate' } },
  { t: 'zk_commitment',    refs: {} },
  { t: 'activity_data',    refs: {} },
  { t: 'alert_record',     refs: {} },
  { t: 'carbon_quota',     refs: {} },
  { t: 'cems_coverage',    refs: {} },
  { t: 'cems_reading',     refs: {} },
  { t: 'device_registry',  refs: {} },
  { t: 'disclosure_consent', refs: {} },
  { t: 'green_power_match', refs: {} },
  { t: 'quota_allocation', refs: {} },
  { t: 'settlement_account', refs: {} },
  { t: 'settlement_flow',  refs: {} },
];

/* 按企业名称关联的大表（无 ent_id） */
const NAME_TABLES = [
  { t: 'cems_cn_hourly',      key: 'ent_name' },
  { t: 'cems_public_reading', key: 'ent_name' },
];

/* 存 user.id 的列 —— 值需按 user id 映射改写（当前库里这些 id 属于别的人） */
const USER_ID_COLS = {
  verify_report: ['submitted_by', 'approved_by'],
  quota_allocation: ['proposed_by', 'approved_by'],
  disclosure_consent: ['granted_by'],
  trade_mandate: ['trader_user_id', 'granted_by', 'revoked_by'],
  trade_order: ['reviewed_by'],
  quota_surrender: ['initiated_by', 'confirmed_by'],
  activity_data: ['submitted_by', 'reviewed_by'],
};

/* 需要一并落地的账号：四家企业 12 个岗位账号 + 被核查链引用的 7 个核查/监管账号。
 * 不放进演示白名单的账号同样要插 —— 它们出现在"核查报告提交人"这类字段里。 */
const EXTRA_USERS = [
  'ent_zjbd', 'ent_zjbd_clerk', 'ent_zjbd_quota',
  'ent_yfkw', 'ent_yfkw_clerk', 'ent_yfkw_quota',
  'ent_yxyf', 'ent_yxyf_clerk', 'ent_yxyf_quota',
  'ent_zjyls', 'ent_zjyls_clerk', 'ent_zjyls_quota',
  'reg_review', 'ver_hblv_clerk', 'ver_hblv_review',
  'ver_cz_clerk', 'ver_cz_review', 'ver_ts_clerk', 'ver_ts_review',
];

const conn = await mysql.createConnection({
  host: env('DB_HOST', '127.0.0.1'),
  port: Number(env('DB_PORT', '3306')),
  user: env('DB_USER', 'root'),
  password: env('DB_PASSWORD', '123456'),
  database: DST,
  multipleStatements: false,
  charset: 'utf8mb4',
});

const log = (...a) => console.log(...a);
let fail = 0;

/** 取表的可插入列（排除生成列） */
async function colsOf(schema, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME AS c, EXTRA AS e FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [schema, table]
  );
  return rows.filter((r) => !String(r.e || '').toUpperCase().includes('GENERATED')).map((r) => r.c);
}

async function scalar(sql, params = []) {
  const [r] = await conn.query(sql, params);
  return r[0] ? Object.values(r[0])[0] : null;
}

/* ── 0. 前置校验 ─────────────────────────────────────────────── */
const dup = await scalar(`SELECT COUNT(*) FROM ${DST}.enterprise WHERE id IN (?)`, [ENT_IDS]);
if (dup > 0) {
  console.error(`✘ 目标库已存在 enterprise id ${ENT_IDS.join('/')}（${dup} 行），中止以免重复插入`);
  process.exit(1);
}
const ents = (await conn.query(`SELECT id, ent_code, ent_name, industry FROM ${SRC}.enterprise WHERE id IN (?)`, [ENT_IDS]))[0];
if (ents.length !== 4) {
  console.error(`✘ 源库只找到 ${ents.length} 家企业，期望 4 家`);
  process.exit(1);
}
const ENT_NAMES = ents.map((e) => e.ent_name);
log(`源：${SRC} → 目标：${DST}${DRY ? '（演练模式，不提交）' : ''}`);
log(`四家企业：${ents.map((e) => `${e.id} ${e.ent_name}`).join(' / ')}\n`);

/* ── 1. 共享字典补齐：verifier_org ────────────────────────────── */
const [missVorg] = await conn.query(
  `SELECT s.* FROM ${SRC}.verifier_org s
   LEFT JOIN ${DST}.verifier_org d ON d.id = s.id
   WHERE d.id IS NULL`
);
log(`[字典] verifier_org 缺失 ${missVorg.length} 行`);
for (const r of missVorg) {
  const cols = await colsOf(SRC, 'verifier_org');
  const ph = cols.map(() => '?').join(',');
  if (!DRY) {
    await conn.query(
      `INSERT INTO ${DST}.verifier_org (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${ph})`,
      cols.map((c) => r[c])
    );
  }
}

/* ── 2. 账号：保持原 id 插入，冲突的 username 建映射 ───────────── */
const [srcUsers] = await conn.query(`SELECT * FROM ${SRC}.sys_user WHERE username IN (?)`, [EXTRA_USERS]);
const [dstUsers] = await conn.query(`SELECT id, username FROM ${DST}.sys_user`);
const dstByName = new Map(dstUsers.map((u) => [u.username, u.id]));
const dstIds = new Set(dstUsers.map((u) => u.id));

/** 备份 user id → 目标库 user id */
const userMap = new Map();
const userCols = await colsOf(SRC, 'sys_user');
let insUsers = 0;
for (const u of srcUsers) {
  if (dstByName.has(u.username)) {
    userMap.set(u.id, dstByName.get(u.username));
    continue;
  }
  let id = u.id;
  if (dstIds.has(id)) {                    // 原 id 被占 → 让 MySQL 自增派号
    id = null;
  }
  if (!DRY) {
    const cols = userCols.filter((c) => id !== null || c !== 'id');
    const ph = cols.map(() => '?').join(',');
    const [res] = await conn.query(
      `INSERT INTO ${DST}.sys_user (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${ph})`,
      cols.map((c) => u[c])
    );
    userMap.set(u.id, id !== null ? id : res.insertId);
  } else {
    userMap.set(u.id, id !== null ? id : -1);
  }
  insUsers++;
}
/* 企业账号：若原 id 与本库既有账号撞号，同样按上面规则处理 */
log(`[账号] 待插入 ${insUsers} 个，复用 ${srcUsers.length - insUsers} 个（用户名已存在）`);
log(`[账号] id 映射 ${[...userMap.entries()].filter(([a, b]) => a !== b).map(([a, b]) => `${a}→${b}`).join(', ') || '（无变化）'}`);

/* ── 3. 企业主表 ─────────────────────────────────────────────── */
if (!DRY) {
  const ecols = await colsOf(SRC, 'enterprise');
  const ph = ecols.map(() => '?').join(',');
  for (const e of ents) {
    const [row] = await conn.query(`SELECT * FROM ${SRC}.enterprise WHERE id = ?`, [e.id]);
    await conn.query(
      `INSERT INTO ${DST}.enterprise (${ecols.map((c) => `\`${c}\``).join(',')}) VALUES (${ph})`,
      ecols.map((c) => row[0][c])
    );
  }
}
log(`[企业] 插入 ${ents.length} 行`);

/* ── 4. 业务表 ───────────────────────────────────────────────── */
const summary = [];
for (const { t, refs } of ENT_TABLES) {
  const n = await scalar(`SELECT COUNT(*) FROM ${SRC}.${t} WHERE ent_id IN (?)`, [ENT_IDS]);
  if (!n) { summary.push([t, 0]); continue; }

  const cols = await colsOf(SRC, t);
  const userRef = new Set(USER_ID_COLS[t] || []);
  const exprs = cols.map((c) => {
    if (c === 'id') return `\`id\` + ${ID_SHIFT}`;
    if (refs[c]) return `(\`${c}\` + ${ID_SHIFT})`;          // 本批次父行 id
    if (userRef.has(c)) {                                    // 跨批次 user id
      const cases = [...userMap.entries()]
        .filter(([a, b]) => a !== b)
        .map(([a, b]) => `WHEN ${a} THEN ${b}`).join(' ');
      return cases ? `(CASE \`${c}\` ${cases} ELSE \`${c}\` END)` : `\`${c}\``;
    }
    return `\`${c}\``;
  });

  const sql = `INSERT INTO ${DST}.${t} (${cols.map((c) => `\`${c}\``).join(',')})
               SELECT ${exprs.join(',')} FROM ${SRC}.${t} WHERE ent_id IN (?)`;
  if (!DRY) await conn.query(sql, [ENT_IDS]);
  summary.push([t, n]);
  log(`  ${t.padEnd(22)} +${n}`);
}

/* ── 5. 按企业名称关联的 CEMS 大表 ───────────────────────────── */
for (const { t, key } of NAME_TABLES) {
  const cols = await colsOf(SRC, t);
  const exprs = cols.map((c) => (c === 'id' ? `\`id\` + ${ID_SHIFT}` : `\`${c}\``));
  const n = await scalar(`SELECT COUNT(*) FROM ${SRC}.${t} WHERE \`${key}\` IN (?)`, [ENT_NAMES]);
  const sql = `INSERT INTO ${DST}.${t} (${cols.map((c) => `\`${c}\``).join(',')})
               SELECT ${exprs.join(',')} FROM ${SRC}.${t} WHERE \`${key}\` IN (?)`;
  if (!DRY) await conn.query(sql, [ENT_NAMES]);
  summary.push([t, n]);
  log(`  ${t.padEnd(22)} +${n}`);
}

/* ── 6. 汇总 ─────────────────────────────────────────────────── */
log('\n── 写入汇总 ──');
let total = 0;
for (const [t, n] of summary) { total += n; log(`  ${t.padEnd(24)} ${String(n).padStart(7)}`); }
log(`  ${'合计'.padEnd(24)} ${String(total).padStart(7)}`);

if (!DRY) {
  const after = await scalar(`SELECT COUNT(*) FROM ${DST}.enterprise`);
  log(`\n企业总数：${after}（其中在册 ${await scalar(`SELECT COUNT(*) FROM ${DST}.enterprise WHERE status='ACTIVE'`)}）`);
  log(`演示账号可用：${(await conn.query(`SELECT username FROM ${DST}.sys_user WHERE username IN (?) AND status=1`, [EXTRA_USERS]))[0].length} / ${EXTRA_USERS.length}`);
}

await conn.end();
if (fail) process.exit(1);
