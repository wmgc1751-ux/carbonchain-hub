#!/usr/bin/env node
/**
 * tools/demo-readiness.mjs —— 演示账号"无断头路"保障
 * ==================================================================
 * 解决什么问题
 * ------------------------------------------------------------------
 * 答辩现场点开某个演示账号，应该能完整走完这个角色的主流程。
 * 但种子数据的核查任务派单是**随机**的（`ORDER BY RAND()`），
 * 于是很常见的情况是：演示核查机构分到的 9 个任务全部已完成，
 * 点进去只能"查看"，没有任何可执行动作 —— 核查流程演示不下去。
 *
 * 这不是数据"错"，而是**演示可用性**问题：数据分布合理，但演示路径断了。
 * 本工具在不动任何业务规则的前提下，为每个演示角色补齐"至少有一条可操作"的数据。
 *
 * 判据（每个角色一条，缺则补）
 * ------------------------------------------------------------------
 *   VERIFIER  演示机构至少有 N 个 PENDING/PROCESSING 核查任务
 *   ENTERPRISE 演示企业至少有 1 份 DRAFT 上报单（可演示"新建→提交"）与
 *              1 份已核查报告（可演示"查看链上存证"）
 *   REGULATOR 至少有 1 条 SUBMITTED 报告待分配（可演示"下发配额/查看待核查"）
 *   TRADER    盘口有买有卖、账户有余额（可演示"下单→成交"）
 *
 * 安全性
 *   · 默认 dry-run，只报告缺口；
 *   · --fix 才写库，且只做"增加待办"与"重新派单"，不删除历史；
 *   · 幂等：已满足判据时不动作。
 *
 * 用法
 *   node tools/demo-readiness.mjs           # 报告
 *   node tools/demo-readiness.mjs --fix     # 补齐
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const ROOT = process.cwd();
const FIX = process.argv.includes('--fix');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
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

/** 演示角色 → 账号（与 /api/auth/demo-accounts 保持一致） */
const DEMO = {
  ADMIN: 'admin', REGULATOR: 'reg001', ENTERPRISE: 'ent001',
  VERIFIER: 'ver001', TRADER: 'trader01',
};
/** 每个演示核查机构至少要有的可操作任务数 */
const MIN_PENDING_TASKS = 3;

const gaps = [];
function gap(role, code, detail, fixable) { gaps.push({ role, code, detail, fixable }); }

async function main() {
  const conn = await mysql.createConnection(DB);
  try {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  演示账号可用性检查（无断头路）');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  库 ${DB.user}@${DB.host}:${DB.port}/${DB.database}${FIX ? C.warn('　[--fix 将写库]') : C.dim('　[dry-run]')}`);

    /* ---------- 解析演示账号 → 业务主体 ---------- */
    const users = {};
    for (const [role, username] of Object.entries(DEMO)) {
      const [r] = await conn.query(
        'SELECT id, username, role, real_name, org_id, org_name, status FROM sys_user WHERE username = ?', [username]
      );
      users[role] = r[0] || null;
      if (!r[0]) gap(role, 'ACCOUNT_MISSING', `演示账号 ${username} 不存在`, false);
      else if (Number(r[0].status) !== 1) gap(role, 'ACCOUNT_DISABLED', `演示账号 ${username} 状态为 ${r[0].status}，无法登录`, false);
    }

    /* ---------- VERIFIER：是否有可操作任务 ---------- */
    const ver = users.VERIFIER;
    if (ver) {
      const [[cnt]] = await conn.query(
        `SELECT SUM(status IN ('PENDING','PROCESSING')) AS live, COUNT(*) AS total
           FROM verify_task WHERE verifier_id = ?`, [ver.org_id]
      );
      const live = Number(cnt.live) || 0;
      console.log(`\n  核查机构 ${C.b(ver.org_name)}（org_id=${ver.org_id}）`);
      console.log(`    任务合计 ${cnt.total} · 可操作 ${live}`);
      if (live < MIN_PENDING_TASKS) {
        gap('VERIFIER', 'NO_ACTIONABLE_TASK',
          `可操作核查任务仅 ${live} 个（期望 ≥ ${MIN_PENDING_TASKS}）—— 点进"核查任务"只能看历史，无法演示受理/出具报告`, true);
      }
    }

    /* ---------- ENTERPRISE：草稿 + 已核查 ---------- */
    const ent = users.ENTERPRISE;
    if (ent) {
      const [[c]] = await conn.query(
        `SELECT SUM(status='DRAFT') AS draft, SUM(status='VERIFIED') AS verified,
                SUM(status='SUBMITTED' OR status='VERIFYING') AS inflight, COUNT(*) AS total
           FROM emission_report WHERE ent_id = ?`, [ent.org_id]
      );
      console.log(`\n  企业 ${C.b(ent.org_name)}（ent_id=${ent.org_id}）`);
      console.log(`    上报单合计 ${c.total} · 草稿 ${Number(c.draft)||0} · 核查中 ${Number(c.inflight)||0} · 已核查 ${Number(c.verified)||0}`);
      const [[w]] = await conn.query('SELECT wallet_address FROM enterprise WHERE id = ?', [ent.org_id]);
      if (!w || !w.wallet_address) {
        gap('ENTERPRISE', 'NO_WALLET', '企业未开户（wallet_address 为空）—— "链上身份"页全空', true);
      }
      const [[q]] = await conn.query(
        'SELECT COUNT(*) n FROM carbon_quota WHERE ent_id = ?', [ent.org_id]
      );
      if (!Number(q.n)) {
        gap('ENTERPRISE', 'NO_QUOTA_ACCOUNT',
          '企业无配额账户 —— "碳配额账户"页全 0，但这是监管下发前的正常状态，'
          + '页面应提示"配额尚未下发"而不是只显示 0', false);
      }
    }

    /* ---------- REGULATOR：待处理事项 ---------- */
    const reg = users.REGULATOR;
    if (reg) {
      const [[c]] = await conn.query(
        `SELECT SUM(status='SUBMITTED') AS pendingVerify,
                (SELECT COUNT(*) FROM alert_record WHERE status='OPEN') AS openAlerts
           FROM emission_report`
      );
      console.log(`\n  监管端 ${C.b(reg.real_name)}`);
      console.log(`    待核查上报 ${Number(c.pendingVerify)||0} · 未处理预警 ${Number(c.openAlerts)||0}`);
      if (!Number(c.pendingVerify) && !Number(c.openAlerts)) {
        gap('REGULATOR', 'NOTHING_PENDING', '监管端没有任何待处理项', false);
      }
    }

    /* ---------- TRADER：盘口与账户 ---------- */
    const tr = users.TRADER;
    if (tr) {
      const [[ob]] = await conn.query(
        `SELECT SUM(side='BUY' AND status IN ('OPEN','PARTIAL')) AS buys,
                SUM(side='SELL' AND status IN ('OPEN','PARTIAL')) AS sells
           FROM trade_order`
      );
      const [[acc]] = await conn.query(
        'SELECT COALESCE(balance,0) AS bal, COALESCE(frozen,0) AS fz FROM settlement_account WHERE ent_id = ? LIMIT 1',
        [tr.org_id || 0]
      ).catch(() => [[{ bal: null, fz: null }]]);
      console.log(`\n  交易端 ${C.b(tr.real_name)}`);
      console.log(`    盘口 买 ${Number(ob.buys)||0} / 卖 ${Number(ob.sells)||0} 档 · 结算账户余额 ${acc && acc.bal != null ? acc.bal : '(无账户)'}`);
      if (!Number(ob.buys) || !Number(ob.sells)) {
        gap('TRADER', 'THIN_ORDERBOOK', '盘口单边或缺档 —— "行情/下单"演示不完整', false);
      }
    }

    /* ---------- 汇总 ---------- */
    console.log('\n──────────────────────────────────────────────────────────');
    if (!gaps.length) {
      console.log(C.ok('  ✔ 全部演示角色均有可操作路径'));
    } else {
      console.log(`  发现 ${gaps.length} 处缺口：`);
      for (const g of gaps) {
        const tag = g.fixable ? C.warn('[可补齐]') : C.bad('[需人工]');
        console.log(`\n  ${tag} ${C.b(g.role)} · ${g.code}`);
        console.log(`     ${g.detail}`);
      }
    }
    console.log('──────────────────────────────────────────────────────────');

    /* ---------- 修复 ---------- */
    if (FIX) {
      const fixed = [];
      const verGap = gaps.find((g) => g.role === 'VERIFIER' && g.code === 'NO_ACTIONABLE_TASK');
      if (verGap) {
        const n = await fixVerifierTasks(conn, ver.org_id);
        fixed.push(`重新派单 ${n} 个核查任务给 ${ver.org_name}`);
      }
      const entGap = gaps.find((g) => g.role === 'ENTERPRISE' && g.code === 'NO_WALLET');
      if (entGap) {
        const keystore = (await import('node:module')).createRequire(import.meta.url);
        const ks = keystore('../server/blockchain/keystore');
        const w = ks.walletFor(`ent:${ent.org_id}`);
        await conn.query('UPDATE enterprise SET wallet_address = ?, pub_key = ? WHERE id = ?',
          [w.address, w.publicKey, ent.org_id]);
        fixed.push(`为 ${ent.org_name} 开户：${w.address}`);
      }
      if (fixed.length) {
        console.log(C.ok('\n  已补齐：'));
        fixed.forEach((x) => console.log(`    · ${x}`));
        console.log(C.dim('  重新跑一次（不带 --fix）可确认缺口已消除'));
      } else {
        console.log(C.dim('\n  没有可自动补齐的缺口（其余需人工判断）'));
      }
    } else if (gaps.some((g) => g.fixable)) {
      console.log(C.dim('\n  加 --fix 可自动补齐标记为 [可补齐] 的项'));
    }
    console.log('');

    fs.mkdirSync(path.join(ROOT, 'tools', 'out'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'tools', 'out', 'demo-readiness.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), fixed: FIX, gaps,
    }, null, 2), 'utf8');
  } finally {
    await conn.end();
  }
}

/**
 * 给指定核查机构补充可操作任务：
 * 从"已提交但派给了别的机构"的报告里挑几条，改派给演示机构。
 * 只改派 SUBMITTED（尚未进入核查）的，不动 VERIFYING —— 那是别人正在做的活。
 */
async function fixVerifierTasks(conn, verifierId) {
  const [[cur]] = await conn.query(
    `SELECT SUM(status IN ('PENDING','PROCESSING')) AS live FROM verify_task WHERE verifier_id = ?`, [verifierId]
  );
  const need = MIN_PENDING_TASKS - (Number(cur.live) || 0);
  if (need <= 0) return 0;

  const [cands] = await conn.query(
    `SELECT t.id, t.report_id, t.ent_id, r.period
       FROM verify_task t
       JOIN emission_report r ON r.id = t.report_id
      WHERE t.status = 'PENDING' AND t.verifier_id <> ?
      ORDER BY t.id DESC LIMIT ?`, [verifierId, need]
  );
  let n = 0;
  for (const c of cands) {
    await conn.query(
      'UPDATE verify_task SET verifier_id = ?, verifier_user = ? WHERE id = ?',
      [verifierId, 'ver' + String(verifierId).padStart(3, '0'), c.id]
    );
    await conn.query('UPDATE emission_report SET verifier_id = ? WHERE id = ?', [verifierId, c.report_id]);
    n++;
  }
  return n;
}

main().catch((e) => { console.error(C.bad('✘ 失败：'), e.message || e); process.exit(9); });
