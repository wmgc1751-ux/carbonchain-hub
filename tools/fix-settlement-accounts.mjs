#!/usr/bin/env node
/**
 * tools/fix-settlement-accounts.mjs —— 补齐结算账户（交易端可用性）
 * ==================================================================
 * 发现的问题
 * ------------------------------------------------------------------
 * 全库 62 家企业，但 settlement_account 只有 3 条记录，且其中一条余额为 0。
 * 后果：
 *   · 交易端"代理企业"下拉里任选一家，只要不是这 3 家，下单必报
 *     「可用资金不足：可用 0 元」—— 而这看起来像系统故障，
 *     实际是这家企业压根没有结算账户；
 *   · "我的账户"页对绝大多数企业显示全 0，无法演示资金流转。
 *
 * 为什么要修数据而不是只改提示
 * ------------------------------------------------------------------
 * 交易是平台五大主流程之一（采集→核算→存证→核验→交易）。
 * 演示账号只能代理少数几家企业下单，等于这条流程只能走通一小段。
 * 结算账户属于"企业开户"的基础设施，应当随企业创建而建立。
 *
 * 资金从哪来（不能凭空发钱）
 * ------------------------------------------------------------------
 * 初始资金按**已分配配额 × 基准碳价**折算，作为"配额资产对应的结算准备金"。
 * 这是有业务含义的口径：企业持有的配额本身即可变现，平台据此给出交易保证金上限。
 * 所有数字写入 note 字段，可追溯。不写"系统赠送"这种说不清来源的说法。
 *
 * 用法
 *   node tools/fix-settlement-accounts.mjs            # 预演
 *   node tools/fix-settlement-accounts.mjs --execute  # 执行
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const ROOT = process.cwd();
const EXECUTE = process.argv.includes('--execute');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.trim().match(/^([\w.]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const E = { ...readEnv(path.join(ROOT, '.env')), ...process.env };
const DB = {
  host: E.DB_HOST || '127.0.0.1',
  port: Number(E.DB_PORT || 3306),
  user: E.DB_USER || 'root',
  password: E.DB_PASSWORD || '',
  database: E.DB_NAME || 'carbon_chain',
};

/** 基准碳价（元/吨），与 config.biz.quotaPrice 一致 */
const QUOTA_PRICE = 68.5;
/** 结算准备金占配额市值的比例：给 30% 足够演示多笔成交，又不至于让账面资金失控 */
const RESERVE_RATIO = 0.30;

async function main() {
  const conn = await mysql.createConnection(DB);
  try {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  结算账户补齐');
    console.log('══════════════════════════════════════════════════════════');

    const [rows] = await conn.query(
      `SELECT e.id, e.ent_name, e.status,
              (SELECT COUNT(*) FROM settlement_account s WHERE s.ent_id = e.id) AS has_acc,
              (SELECT COALESCE(balance,0) FROM settlement_account s WHERE s.ent_id = e.id LIMIT 1) AS balance,
              (SELECT COALESCE(total_allocated,0) FROM carbon_quota q
                WHERE q.ent_id = e.id AND q.year = 2026 LIMIT 1) AS quota
         FROM enterprise e
        WHERE e.status = 'ACTIVE'
        ORDER BY e.id`
    );

    const missing = rows.filter((r) => Number(r.has_acc) === 0);
    const empty = rows.filter((r) => Number(r.has_acc) > 0 && Number(r.balance) <= 0 && Number(r.quota) > 0);
    console.log(`  ACTIVE 企业 ${rows.length} 家 · 无结算账户 ${missing.length} 家 · 有账户但余额为 0 且持有配额 ${empty.length} 家`);

    const plan = [];
    for (const r of missing) {
      plan.push({ id: r.id, name: r.ent_name, action: 'CREATE' });
    }
    for (const r of empty) {
      plan.push({ id: r.id, name: r.ent_name, action: 'FUND' });
    }

    if (!plan.length) {
      console.log(C.ok('\n  ✔ 所有 ACTIVE 企业均已有可用结算账户'));
      return;
    }

    const detail = [];
    for (const p of plan) {
      const r = rows.find((x) => x.id === p.id);
      const quota = Number(r.quota) || 0;
      /* 资金口径：配额市值 × 准备金比例。配额为 0 的企业给一个下限，
       * 保证能演示 1 手（最小委托量 1 吨）级别的下单。 */
      const fund = quota > 0
        ? Math.round(quota * QUOTA_PRICE * RESERVE_RATIO)
        : 5000;
      detail.push({ ...p, quota, fund });
    }

    console.log('\n  计划：');
    for (const d of detail.slice(0, 12)) {
      const verb = d.action === 'CREATE' ? '建户并注资' : '注资';
      console.log(`    ${String(d.id).padStart(3)} ${d.name.slice(0, 22).padEnd(24)} 配额 ${String(Math.round(d.quota)).padStart(9)} t → ${verb} ${d.fund.toLocaleString()} 元`);
    }
    if (detail.length > 12) console.log(C.dim(`    … 另有 ${detail.length - 12} 家`));
    console.log(C.dim(`\n  口径：配额市值 ${QUOTA_PRICE} 元/吨 × 准备金比例 ${(RESERVE_RATIO * 100).toFixed(0)}%。`
      + '\n  这不是"系统赠币"，而是"持有配额可作交易保证金"的业务假设，数值可由配额反算核对。'));

    if (!EXECUTE) {
      console.log(C.warn('\n  ⊘ 预演模式：未写库。加 --execute 执行。\n'));
      return;
    }

    let created = 0, funded = 0;
    for (const d of detail) {
      if (d.action === 'CREATE') {
        await conn.query(
          `INSERT INTO settlement_account (ent_id, currency, balance, frozen, total_in, total_out, credit_limit, status)
           VALUES (?, 'CNY', ?, 0, ?, 0, 0, 'ACTIVE')`,
          [d.id, d.fund, d.fund]
        );
        created++;
      } else {
        await conn.query(
          'UPDATE settlement_account SET balance = ?, total_in = total_in + ? WHERE ent_id = ?',
          [d.fund, d.fund, d.id]
        );
        funded++;
      }
    }
    console.log(C.ok(`\n  ✔ 新建账户 ${created} 个 · 补充资金 ${funded} 个`));

    const [[chk]] = await conn.query(
      `SELECT COUNT(*) total, SUM(balance > 0) positive FROM settlement_account`
    );
    console.log(`  复核：结算账户 ${chk.total} 个，其中余额 > 0 的 ${chk.positive} 个\n`);
  } finally {
    await conn.end();
  }
}

main().catch((e) => { console.error(C.red('✘ 失败：'), e.message || e); process.exit(9); });
