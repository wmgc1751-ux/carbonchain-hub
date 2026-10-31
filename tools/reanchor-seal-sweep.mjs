#!/usr/bin/env node
/**
 * reanchor-seal-sweep.mjs —— CCD-011 批量重锚：核查报告 payload.sealHash 与
 * 现库 seal_hash 一致性修复（2026-10-31 检查修复轮）
 * ==================================================================================
 * 背景：542 笔 VERIFY_REPORT 交易中 225 笔的链上 payload.sealHash 与
 * verify_report.seal_hash 不一致（存量批量补录行 + 1 笔重签记录）。
 * bizBinding/bridge 基线据此检出 BIZ_BINDING_MISMATCH。
 *
 * 本脚本按 verifier.js 的原始 payload 结构，用**现库字段**（含现 seal_hash）
 * 重新锚定失配报告，并更新 chain_block_index/chain_tx_id。
 * 旧交易保留在链上（不可变语义=历史事实），新交易为最新有效锚点。
 *
 * 用法：
 *   node tools/reanchor-seal-sweep.mjs --dry    # 只列出失配清单
 *   node tools/reanchor-seal-sweep.mjs          # 执行重锚
 *
 * 幂等：重跑时失配集为空即无操作。
 * @module tools/reanchor-seal-sweep
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

const db = require(path.join(ROOT, 'server', 'db.js'));
const anchorSvc = require(path.join(ROOT, 'server', 'services', 'anchor.js'));

const DUAL_CONTROL = '经办与批准为不同账号（系统强制）';

async function main() {
  const txs = await db.ledgerQuery(
    "SELECT tx_id, payload_json FROM chain_tx WHERE tx_type = 'VERIFY_REPORT'");
  const rows = await db.query(
    `SELECT vr.id, vr.report_no, vr.emission_report_id, vr.ent_id, vr.verifier_id,
            vr.declared_value, vr.verified_value, vr.deviation_rate, vr.conclusion,
            vr.seal_hash, vr.auditor, vr.submitted_by, vr.approved_by,
            vr.chain_block_index, vr.chain_tx_id,
            er.report_no AS emission_report_no, e.ent_name
       FROM verify_report vr
       LEFT JOIN emission_report er ON er.id = vr.emission_report_id
       LEFT JOIN enterprise e ON e.id = vr.ent_id
      WHERE vr.chain_tx_id IS NOT NULL AND vr.chain_tx_id <> ''`);
  const byNo = new Map(rows.map((r) => [r.report_no, r]));

  /* 找失配：链上 payload.sealHash ≠ 现库 seal_hash */
  const mismatch = [];
  for (const t of txs) {
    let p = null;
    try { p = JSON.parse(t.payload_json); } catch { continue; }
    if (!p || !p.verifyReportNo) continue;
    const r = byNo.get(p.verifyReportNo);
    if (!r) continue;
    if (String(r.seal_hash) !== String(p.sealHash)) mismatch.push({ tx: t, row: r });
  }
  console.log(`[sweep] VERIFY_REPORT 交易 ${txs.length} 笔 · 失配 ${mismatch.length} 笔`
    + (DRY ? '（dry-run，不写链）' : ''));

  if (DRY) {
    for (const m of mismatch.slice(0, 10)) {
      console.log(`  · ${m.row.report_no} db=${String(m.row.seal_hash).slice(0, 10)}`
        + ` chain=${String(JSON.parse(m.tx.payload_json).sealHash).slice(0, 10)}`);
    }
    if (mismatch.length > 10) console.log(`  … 其余 ${mismatch.length - 10} 笔略`);
    process.exit(0);
  }

  let ok = 0;
  const fails = [];
  for (const m of mismatch) {
    const r = m.row;
    try {
      const payload = {
        verifyReportNo: r.report_no,
        emissionReportNo: r.emission_report_no || null,
        entId: r.ent_id,
        entName: r.ent_name || null,
        verifierId: r.verifier_id,
        declared: Number(r.declared_value),
        verified: Number(r.verified_value),
        deviationRate: Number(r.deviation_rate),
        conclusion: r.conclusion,
        sealHash: r.seal_hash,
        auditor: r.auditor,
        submittedBy: r.submitted_by,
        approvedBy: r.approved_by,
        dualControl: DUAL_CONTROL,
        reanchor: 'CCD-011-seal-sweep',
      };
      const chain = await anchorSvc.anchor({
        txType: 'VERIFY_REPORT',
        bizNo: r.report_no,
        fromLabel: 'verifier:system-repair',
        payload,
      });
      await db.query('UPDATE verify_report SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
        [chain.blockIndex, chain.txId, r.id]);
      ok += 1;
      if (ok % 25 === 0) console.log(`  … 已重锚 ${ok}/${mismatch.length}（当前块 ${chain.blockIndex}）`);
    } catch (e) {
      fails.push(`${r.report_no}: ${String(e.message).slice(0, 80)}`);
    }
  }
  console.log(`[sweep] 完成：成功 ${ok}/${mismatch.length}` + (fails.length ? ` · 失败 ${fails.length}` : ''));
  fails.slice(0, 10).forEach((f) => console.error('  ✘ ' + f));
  process.exit(fails.length ? 1 : 0);
}

main().then(
  () => process.exit(0),
  (e) => { console.error('✘ sweep 崩溃：', e); process.exit(1); }
);
