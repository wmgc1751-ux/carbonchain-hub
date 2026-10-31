#!/usr/bin/env node
/**
 * reanchor-emission-sweep.mjs —— CCD-011 扩展：排放上报 intensity 绑定漂移修复
 * ==================================================================================
 * 背景：32 笔 EMISSION_REPORT 在锚定时 intensity 尚未计算（链上 payload 为 0），
 * 现库 intensity 为后算正确值（total_emission / 产值）——按 enterprise.js 的原始
 * payload 结构用现库字段重新锚定并更新 chain_block_index/chain_tx_id。
 *
 * 用法：
 *   node tools/reanchor-emission-sweep.mjs --dry
 *   node tools/reanchor-emission-sweep.mjs
 * 幂等：重跑失配集为空即无操作。
 * @module tools/reanchor-emission-sweep
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

const db = require(path.join(ROOT, 'server', 'db.js'));
const anchorSvc = require(path.join(ROOT, 'server', 'services', 'anchor.js'));

async function main() {
  const txs = await db.ledgerQuery(
    "SELECT tx_id, biz_no, block_index, payload_json FROM chain_tx WHERE tx_type = 'EMISSION_REPORT'");

  /* 每单最新锚点（与 bizBinding 同语义） */
  const latest = new Map();
  for (const t of txs) {
    const prev = latest.get(t.biz_no);
    if (!prev || Number(t.block_index) > Number(prev.block_index)) latest.set(t.biz_no, t);
  }

  const rows = await db.query(
    `SELECT report_no, ent_id, year, quarter, period, scope1_emission, scope2_emission,
            total_emission, intensity, data_source, ent_name
       FROM emission_report vr LEFT JOIN enterprise e ON e.id = vr.ent_id
      WHERE chain_tx_id IS NOT NULL AND chain_tx_id <> ''`);
  const byNo = new Map(rows.map((r) => [String(r.report_no), r]));

  const mismatch = [];
  for (const [bizNo, t] of latest) {
    let p = null;
    try { p = JSON.parse(t.payload_json); } catch { continue; }
    const r = byNo.get(String(bizNo));
    if (!r) continue;
    const diffIntensity = Math.abs(Number(p.intensity || 0) - Number(r.intensity || 0))
      > Math.max(0.01, Math.abs(Number(r.intensity || 0)) * 1e-6);
    if (diffIntensity) mismatch.push({ bizNo, row: r, onChain: Number(p.intensity || 0) });
  }

  console.log(`[emission-sweep] 最新锚点 ${latest.size} 单 · intensity 失配 ${mismatch.length} 笔`
    + (DRY ? '（dry-run）' : ''));
  if (DRY) {
    mismatch.slice(0, 10).forEach((m) => console.log(`  · ${m.bizNo} chain=${m.onChain} db=${Number(m.row.intensity).toFixed(4)}`));
    process.exit(0);
  }

  let ok = 0;
  const fails = [];
  for (const m of mismatch) {
    const r = m.row;
    try {
      const payload = {
        reportNo: r.report_no,
        entId: r.ent_id,
        entName: r.ent_name || null,
        period: r.period || (r.year && r.quarter ? `${r.year}Q${r.quarter}` : null),
        scope1: Number(Number(r.scope1_emission).toFixed(2)),
        scope2: Number(Number(r.scope2_emission).toFixed(2)),
        totalEmission: Number(r.total_emission),
        intensity: Number(r.intensity),
        dataSource: r.data_source || '排放因子法',
        reanchor: 'CCD-011-intensity-sweep',
      };
      const chain = await anchorSvc.anchor({
        txType: 'EMISSION_REPORT',
        bizNo: r.report_no,
        fromLabel: 'ent:system-repair',
        payload,
      });
      await db.query('UPDATE emission_report SET chain_block_index = ?, chain_tx_id = ? WHERE report_no = ?',
        [chain.blockIndex, chain.txId, r.report_no]);
      ok += 1;
      if (ok % 10 === 0) console.log(`  … 已重锚 ${ok}/${mismatch.length}（当前块 ${chain.blockIndex}）`);
    } catch (e) {
      fails.push(`${r.report_no}: ${String(e.message).slice(0, 80)}`);
    }
  }
  console.log(`[emission-sweep] 完成：成功 ${ok}/${mismatch.length}` + (fails.length ? ` · 失败 ${fails.length}` : ''));
  fails.slice(0, 10).forEach((f) => console.error('  ✘ ' + f));
  process.exit(fails.length ? 1 : 0);
}

main().then(
  () => process.exit(0),
  (e) => { console.error('✘ sweep 崩溃：', e); process.exit(1); }
);
