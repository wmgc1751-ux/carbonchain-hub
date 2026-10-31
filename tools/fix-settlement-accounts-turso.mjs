/**
 * 结算账户补齐（Turso 版）—— 与 tools/fix-settlement-accounts.mjs 同口径
 * ------------------------------------------------------------------
 * 资金 = 本年度配额总量 × 68.5 元/吨 × 30% 准备金；无配额企业给 5,000 元下限。
 * 这不是"系统赠币"，而是"持有配额可作交易保证金"的业务假设，
 * 金额可由配额反算核对，不是凭空发钱。
 *
 * 背景：本地 MySQL 已补齐 56 户，但云端 Turso 迁移时只带过来 2 户 ——
 * 线上交易端点开即「可用资金不足：可用 0 元」，演示断头路。
 *
 * 用法：node tools/fix-settlement-accounts-turso.mjs [--execute]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTurso } from '../../../碳链通小程序/server/src/turso.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXECUTE = process.argv.includes('--execute');

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const db = createTurso({ url: env.TURSO_URL, token: env.TURSO_AUTH_TOKEN });

const QUOTA_PRICE = 68.5;
const RESERVE_RATIO = 0.30;
/* 取库里实际存在的最大配额年度：云端数据年度可能与系统时钟不同步（本轮实测 2026 年有配额，系统年份也是 2026，但该查询曾因常量错位取到 0） */
const yearRows = (await db.prepare('SELECT MAX(year) AS y FROM carbon_quota').first());
const YEAR = Number(yearRows && yearRows.y) || new Date().getFullYear();

const rows = (await db.prepare(
  `SELECT e.id, e.ent_name, COALESCE(q.total_allocated, 0) AS quota, q.year AS qyear,
          COALESCE(a.balance, -1) AS balance, a.id AS acc_id
     FROM enterprise e
     LEFT JOIN carbon_quota q ON q.ent_id = e.id AND q.year = ${YEAR}
     LEFT JOIN settlement_account a ON a.ent_id = e.id AND a.currency = 'CNY'
    WHERE e.status IN ('ACTIVE','WATCH','SUSPENDED')
    ORDER BY e.id`).all()).results;

const plan = [];
for (const r of rows) {
  const quota = Number(r.quota) || 0;
  const fund = quota > 0 ? Math.round(quota * QUOTA_PRICE * RESERVE_RATIO) : 5000;
  if (r.acc_id === null) plan.push({ ...r, action: 'CREATE', fund });
  else if (Number(r.balance) <= 0) plan.push({ ...r, action: 'FUND', fund });
}

console.log(`在册企业 ${rows.length} 家｜需处理 ${plan.length} 家（新建 ${plan.filter((p) => p.action === 'CREATE').length} / 注资 ${plan.filter((p) => p.action === 'FUND').length}）`);
for (const p of plan.slice(0, 10)) {
  console.log(`  ${String(p.id).padStart(3)} ${String(p.ent_name).slice(0, 20).padEnd(22)} 配额 ${String(Math.round(p.quota)).padStart(10)} t → ${p.fund.toLocaleString()} 元`);
}
if (plan.length > 10) console.log(`  … 另有 ${plan.length - 10} 家`);

if (!plan.length) { console.log('✔ 所有企业在册企业均已有可用结算账户，无需处理'); process.exit(0); }
if (!EXECUTE) { console.log('\n⊘ 预演模式：未写库。加 --execute 执行。'); process.exit(0); }

let created = 0, funded = 0;
for (const p of plan) {
  if (p.action === 'CREATE') {
    await db.prepare(
      `INSERT INTO settlement_account (ent_id, currency, balance, frozen, total_in, total_out, credit_limit, status, updated_at, created_at)
       VALUES (?, 'CNY', ?, 0, ?, 0, 0, 'ACTIVE', datetime('now'), datetime('now'))`,
    ).bind(p.id, p.fund, p.fund).run();
    created++;
  } else {
    await db.prepare(
      `UPDATE settlement_account SET balance = ?, total_in = total_in + ?, updated_at = datetime('now')
        WHERE ent_id = ? AND currency = 'CNY'`,
    ).bind(p.fund, p.fund, p.id).run();
    funded++;
  }
}
const after = (await db.prepare(
  "SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS total FROM settlement_account WHERE currency='CNY'",
).first());
console.log(`✔ 新建账户 ${created} 个 · 补充资金 ${funded} 个｜当前账户 ${after.n} 个，余额合计 ${Number(after.total).toLocaleString()} 元`);
