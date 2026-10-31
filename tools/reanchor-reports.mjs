#!/usr/bin/env node
/**
 * tools/reanchor-reports.mjs —— 把"交易号不在本节点账本上"的上报单重新锚定到本地链
 *
 * 背景
 * ------------------------------------------------------------------
 * 2026-10-29 业务库从线上部署（Cloudflare Worker + Turso）整体同步回本地 MySQL，
 * 而这些上报单的 chain_tx_id 是**线上那条链**的交易号。本地账本（3307）是另一条
 * 独立链，自然查不到 —— 企业的「存证详情」页因此取不到 tx，核验链路整条断掉。
 *
 * 本脚本对这批报告做一次真实上链：用企业自己的 keystore 私钥签名、走正常出块，
 * 再把新的 block_index / tx_id 回写业务表。锚定后前端就能完整跑通
 * 「交易 → 区块 → Merkle 路径 → 签名验签 → 链上链下比对」。
 *
 * 用法
 *   node tools/reanchor-reports.mjs --limit 3       # 试锚 3 笔，看输出
 *   node tools/reanchor-reports.mjs                 # 全量
 *   node tools/reanchor-reports.mjs --dry           # 只统计缺口，不上链
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const DRY = has('dry');
const LIMIT = Number(arg('limit', '0')) || 0;

const ENV = (() => { try { return readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return ''; } })();
const env = (k, d = '') => { const m = ENV.match(new RegExp(`^${k}=(.*)$`, 'm')); return m ? m[1].trim() : d; };

/* 服务容器：沿用与 server/app.js 相同的 db / keystore / anchor 实例，
 * 保证上链路径（签名、出块、回写）与真实业务提交完全一致。 */
const db = require(path.join(ROOT, 'server', 'db.js'));
const anchorSvc = require(path.join(ROOT, 'server', 'services', 'anchor.js'));

async function main() {
  /* 账本里已有的交易号集合 —— 判据与 /reports/:id/chain 完全一致 */
  const ledger = await db.ledgerQuery('SELECT tx_id FROM chain_tx');
  const known = new Set(ledger.map((r) => r.tx_id));

  const reports = await db.query(
    `SELECT r.id, r.report_no, r.ent_id, r.period, r.scope1_emission, r.scope2_emission,
            r.total_emission, r.intensity, r.data_source, r.chain_tx_id, e.ent_name
       FROM emission_report r JOIN enterprise e ON e.id = r.ent_id
      WHERE r.chain_tx_id IS NOT NULL AND r.status <> 'DRAFT'
      ORDER BY r.id`
  );
  const missing = reports.filter((r) => !known.has(r.chain_tx_id));
  console.log(`账本现有交易 ${known.size} 笔 · 上报单 ${reports.length} 份 · 待补锚 ${missing.length} 份`);
  if (DRY || !missing.length) { await db.pool.end(); await db.ledgerPool.end(); return; }

  const list = LIMIT ? missing.slice(0, LIMIT) : missing;
  let ok = 0; const fails = [];
  const t0 = Date.now();
  for (const r of list) {
    try {
      const chain = await anchorSvc.anchor({
        txType: 'EMISSION_REPORT',
        bizNo: r.report_no,
        fromLabel: `ent:${r.ent_id}`,
        payload: {
          reportNo: r.report_no,
          entId: r.ent_id,
          entName: r.ent_name,
          period: r.period,
          scope1: Number(r.scope1_emission),
          scope2: Number(r.scope2_emission),
          totalEmission: Number(r.total_emission),
          intensity: Number(r.intensity),
          dataSource: r.data_source,
        },
      });
      await db.query('UPDATE emission_report SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
        [chain.blockIndex, chain.txId, r.id]);
      ok++;
      process.stdout.write(`  ✔ ${r.report_no} ${r.ent_name.slice(0, 10)} → 块 ${chain.blockIndex}\r`);
    } catch (e) {
      fails.push(`${r.report_no}: ${e.message}`);
      console.log(`  ✘ ${r.report_no} ${e.message}`);
    }
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n补锚完成：成功 ${ok} / 失败 ${fails.length} · 耗时 ${sec}s`);
  const after = await db.ledgerValue('SELECT COUNT(*) FROM chain_tx');
  const height = await db.ledgerValue('SELECT MAX(block_index) FROM chain_block');
  console.log(`账本现状：${after} 笔交易 · 高度 ${height}`);
  await db.pool.end(); await db.ledgerPool.end();
}

main().catch(async (e) => { console.error('FATAL', e.message); try { await db.pool.end(); await db.ledgerPool.end(); } catch { /* 忽略 */ } process.exit(1); });
