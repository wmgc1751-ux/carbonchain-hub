#!/usr/bin/env node
/**
 * tools/reanchor-biz.mjs —— 补齐"业务表有交易号、账本里查不到"的存量业务存证
 *
 * 与 reanchor-reports.mjs 同因同解：业务库从线上部署同步回本地后，
 * 核查结论 / 配额分配 / 配额清缴 / 代理授权 携带的是另一条链的交易号。
 * 本脚本按各自**原始的 payload 结构**重新上链（签名方也照原样取），
 * 使「存证详情」页的验签、Merkle 路径、链下链上比对三条线都能跑通。
 *
 * 用法：
 *   node tools/reanchor-biz.mjs --dry              # 只看缺口
 *   node tools/reanchor-biz.mjs --type verify      # 单类型
 *   node tools/reanchor-biz.mjs                    # 全部
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const TYPE = (() => { const i = argv.indexOf('--type'); return i >= 0 ? argv[i + 1] : 'all'; })();

const db = require(path.join(ROOT, 'server', 'db.js'));
const anchorSvc = require(path.join(ROOT, 'server', 'services', 'anchor.js'));

const SUMMARY = [];

async function run(name, sql, build) {
  if (TYPE !== 'all' && TYPE !== name) return;
  const known = new Set((await db.ledgerQuery('SELECT tx_id FROM chain_tx')).map((r) => r.tx_id));
  const rows = await db.query(sql);
  const missing = rows.filter((r) => r.chain_tx_id && !known.has(r.chain_tx_id));
  console.log(`[${name}] 有交易号 ${rows.length} · 待补锚 ${missing.length}`);
  if (DRY || !missing.length) { SUMMARY.push([name, missing.length, 0]); return; }

  let ok = 0; const fails = [];
  const t0 = Date.now();
  for (const r of missing) {
    try {
      const p = build(r);
      if (!p) continue;
      const chain = await anchorSvc.anchor(p);
      await db.query(p._update, p._args ? p._args(chain, r) : [chain.blockIndex, chain.txId, r.id]);
      ok++;
    } catch (e) {
      fails.push(`${r.id}: ${e.message}`);
      console.log(`  ✘ ${r.id} ${e.message}`);
    }
  }
  console.log(`  ✔ 成功 ${ok} / 失败 ${fails.length} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  SUMMARY.push([name, missing.length, ok]);
}

/* ── 1. 核查结论 ─────────────────────────────────────────────── */
const verifySql = `
  SELECT v.id, v.report_no, v.task_id, v.emission_report_id, v.ent_id, v.verifier_id,
         v.declared_value, v.verified_value, v.deviation_rate, v.conclusion, v.opinion,
         v.auditor, v.seal_hash, v.submitted_by, v.approved_by, v.chain_tx_id,
         e.ent_name, er.report_no AS em_report_no
    FROM verify_report v
    JOIN enterprise e ON e.id = v.ent_id
    LEFT JOIN emission_report er ON er.id = v.emission_report_id
   WHERE v.chain_tx_id IS NOT NULL AND v.chain_tx_id <> ''`;
const verifyBuild = (v) => ({
  txType: 'VERIFY_REPORT',
  bizNo: v.report_no,
  fromLabel: `verifier:${v.verifier_id}`,
  payload: {
    verifyReportNo: v.report_no,
    emissionReportNo: v.em_report_no,
    entId: v.ent_id,
    entName: v.ent_name,
    verifierId: v.verifier_id,
    declared: Number(v.declared_value),
    verified: Number(v.verified_value),
    deviationRate: Number(v.deviation_rate),
    conclusion: v.conclusion,
    sealHash: v.seal_hash,
    auditor: v.auditor,
    submittedBy: v.submitted_by,
    approvedBy: v.approved_by,
    dualControl: '经办与批准为不同账号（系统强制）',
  },
  _update: 'UPDATE verify_report SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
});

/* ── 2. 配额分配 ─────────────────────────────────────────────── */
const allocSql = `
  SELECT a.id, a.alloc_no, a.ent_id, a.year, a.quota_amount, a.alloc_type, a.alloc_method,
         a.baseline_intensity, a.operator, a.chain_tx_id, e.ent_name
    FROM quota_allocation a JOIN enterprise e ON e.id = a.ent_id
   WHERE a.chain_tx_id IS NOT NULL AND a.chain_tx_id <> ''`;
const allocBuild = (a) => ({
  txType: 'QUOTA_ALLOC',
  bizNo: a.alloc_no,
  fromLabel: 'regulator:system',
  toLabel: `ent:${a.ent_id}`,
  payload: {
    allocNo: a.alloc_no,
    entId: a.ent_id,
    entName: a.ent_name,
    year: Number(a.year),
    quotaAmount: Number(a.quota_amount),
    allocType: a.alloc_type,
    allocMethod: a.alloc_method || '历史强度法',
    baseline: a.baseline_intensity === null ? null : Number(a.baseline_intensity),
    operator: a.operator,
  },
  _update: 'UPDATE quota_allocation SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
});

/* ── 3. 配额清缴 ─────────────────────────────────────────────── */
const surrenderSql = `
  SELECT s.id, s.surrender_no, s.ent_id, s.year, s.verified_emission, s.offset_used,
         s.required_quota, s.surrendered_quota, s.shortfall, s.status, s.certificate_no,
         s.chain_tx_id, e.ent_name
    FROM quota_surrender s JOIN enterprise e ON e.id = s.ent_id
   WHERE s.chain_tx_id IS NOT NULL AND s.chain_tx_id <> ''`;
const surrenderBuild = (s) => ({
  txType: 'QUOTA_SURRENDER',
  bizNo: s.surrender_no,
  fromLabel: 'regulator:system',
  toLabel: `ent:${s.ent_id}`,
  payload: {
    surrenderNo: s.surrender_no,
    entId: s.ent_id,
    year: Number(s.year),
    verifiedEmission: Number(s.verified_emission),
    offsetUsed: Number(s.offset_used),
    requiredQuota: Number(s.required_quota),
    surrenderedQuota: Number(s.surrendered_quota),
    shortfall: Number(s.shortfall),
    status: s.status,
    certificateNo: s.certificate_no,
  },
  _update: 'UPDATE quota_surrender SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
});

/* ── 4. 交易代理授权 ─────────────────────────────────────────── */
const mandateSql = `
  SELECT m.id, m.ent_id, m.trader_user_id, m.scope, m.max_amount, m.valid_from, m.valid_to,
         m.granted_by, m.chain_tx_id, e.ent_name, u.org_name AS trader_org, u.username AS trader_user
    FROM trade_mandate m
    JOIN enterprise e ON e.id = m.ent_id
    LEFT JOIN sys_user u ON u.id = m.trader_user_id
   WHERE m.chain_tx_id IS NOT NULL AND m.chain_tx_id <> ''`;
const mandateBuild = (m) => ({
  txType: 'TRADE_MANDATE',
  bizNo: `MANDATE-${m.id}`,
  fromLabel: `ent:${m.ent_id}`,
  payload: {
    mandateId: m.id,
    action: 'GRANT',
    entId: m.ent_id,
    traderUserId: m.trader_user_id,
    traderName: m.trader_org || m.trader_user,
    scope: m.scope,
    maxAmount: Number(m.max_amount),
    validFrom: m.valid_from ? new Date(m.valid_from).toISOString() : null,
    validTo: m.valid_to ? new Date(m.valid_to).toISOString() : null,
    grantedBy: m.granted_by,
    grantedByName: null,
    note: '企业授权交易机构代理碳配额交易；本记录为授权事实的链上锚点',
  },
  _update: 'UPDATE trade_mandate SET chain_tx_id = ? WHERE id = ?', // 该表无 block_index 列
  _args: (chain, m) => [chain.txId, m.id],
});

async function main() {
  await run('verify', verifySql, verifyBuild);
  await run('quota', allocSql, allocBuild);
  await run('surrender', surrenderSql, surrenderBuild);
  await run('mandate', mandateSql, mandateBuild);

  if (!DRY && SUMMARY.some((s) => s[1])) {
    const n = await db.ledgerValue('SELECT COUNT(*) FROM chain_tx');
    const h = await db.ledgerValue('SELECT MAX(block_index) FROM chain_block');
    console.log(`\n账本现状：${n} 笔交易 · 高度 ${h}`);
  }
  await db.pool.end(); await db.ledgerPool.end();
}

main().catch(async (e) => { console.error('FATAL', e.message); try { await db.pool.end(); await db.ledgerPool.end(); } catch { /* 忽略 */ } process.exit(1); });
