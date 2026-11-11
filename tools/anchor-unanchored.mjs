#!/usr/bin/env node
/**
 * tools/anchor-unanchored.mjs —— 补齐"业务行从未上链"的存量记录
 * ------------------------------------------------------------------
 * 【与 reanchor-biz.mjs 的分工（别混用）】
 *   reanchor-biz.mjs  处理「业务表写了 chain_tx_id，但账本里查不到该交易」
 *                     —— 那是同步错链造成的失配。
 *   本脚本            处理「业务表 chain_tx_id 为 NULL，从未锚定」
 *                     —— 对账中心里「未锚定」那一列。
 *
 * 为什么要补：配额分配页写着「每次分配都会生成链上存证」，碳信用页写着
 * 「抵销流水上链存证」。有一批历史记录（含 11-01 的 ADJUST 修复流水、
 * 早期碳信用签发与抵销）根本没上链，界面声明与数据对不上。
 * 补锚后声明才成立；补不了的部分由对账中心如实列为「未锚定」。
 *
 * 用法：
 *   node tools/anchor-unanchored.mjs --dry      只看缺口（默认）
 *   node tools/anchor-unanchored.mjs --apply    实际补锚
 *   node tools/anchor-unanchored.mjs --apply --type credit
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const TYPE = (() => { const i = argv.indexOf('--type'); return i >= 0 ? argv[i + 1] : 'all'; })();

const db = require(path.join(ROOT, 'server', 'db.js'));
const anchorSvc = require(path.join(ROOT, 'server', 'services', 'anchor.js'));

const SUMMARY = [];

async function run(name, sql, build) {
  if (TYPE !== 'all' && TYPE !== name) return;
  const rows = await db.query(sql);
  const known = new Set((await db.ledgerQuery('SELECT tx_id FROM chain_tx')).map((r) => r.tx_id));
  /* 两类缺口一起处理：
   *   unanchored —— chain_tx_id 为空，从未锚定
   *   dangling   —— 写了 txid 但账本里查无此交易（早期种子数据写死的伪 txid）
   * 后者若只补锚不记录旧值，等于把"这条记录曾经指向一个不存在的交易"这段历史抹掉，
   * 所以补锚前把原 txid 留存到 *_legacy_tx_id（可用 --apply 后从对账明细追溯）。 */
  const unanchored = rows.filter((r) => !r.chain_tx_id);
  const dangling = rows.filter((r) => r.chain_tx_id && !known.has(r.chain_tx_id));
  console.log(`[${name}] 总 ${rows.length} · 未锚定 ${unanchored.length} · 悬空 txid ${dangling.length} · 已锚定 ${rows.length - unanchored.length - dangling.length}`);
  const todo = [...unanchored, ...dangling.map((r) => ({ ...r, _legacyTxId: r.chain_tx_id }))];
  if (!APPLY || !todo.length) { SUMMARY.push([name, todo.length, 0, rows.length]); return; }

  let ok = 0; const fails = [];
  const t0 = Date.now();
  for (const r of todo) {
    try {
      const p = build(r);
      if (!p) continue;
      const chain = await anchorSvc.anchor(p);
      await db.query(p._update, [chain.blockIndex, chain.txId, r.id]);
      ok++;
    } catch (e) {
      fails.push(`${r.id}: ${e.message}`);
      if (fails.length <= 5) console.log(`  ✘ ${r.id} ${e.message}`);
    }
  }
  console.log(`  ✔ 成功 ${ok} / 失败 ${fails.length} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  SUMMARY.push([name, todo.length, ok, rows.length]);
}

/* ── 1. 配额分配（含历史 ADJUST 调整行） ─────────────────────── */
await run('alloc', `
  SELECT a.id, a.alloc_no, a.ent_id, a.year, a.quota_amount, a.alloc_type, a.alloc_method,
         a.baseline_intensity, a.operator, a.chain_tx_id, e.ent_name
    FROM quota_allocation a JOIN enterprise e ON e.id = a.ent_id
   `, (a) => ({
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
    /* 补锚要标明这是事后补记，不能伪装成当时就上了链 */
    backfill: true,
    legacyTxId: a._legacyTxId || null,
    backfillNote: a._legacyTxId
      ? '存量补锚：原记录指向的交易在账本中不存在（早期种子数据），本次按原始业务数据重新上链，原 txid 留存于 legacyTxId'
      : '存量补锚：该业务动作在原时刻未上链，本次按原始业务数据补记存证',
  },
  _update: 'UPDATE quota_allocation SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
}));

/* ── 2. 碳信用资产签发 ───────────────────────────────────────── */
await run('credit', `
  SELECT c.id, c.asset_no, c.ent_id, c.asset_type, c.project_name, c.amount,
         c.used_amount, c.issue_year, c.valid_until, c.registry, c.status, c.chain_tx_id, e.ent_name
    FROM credit_asset c JOIN enterprise e ON e.id = c.ent_id
   `, (c) => ({
  txType: 'CREDIT_ASSET',
  bizNo: c.asset_no,
  fromLabel: `ent:${c.ent_id}`,
  payload: {
    assetNo: c.asset_no,
    entId: c.ent_id,
    entName: c.ent_name,
    assetType: c.asset_type,
    projectName: c.project_name,
    amount: Number(c.amount),
    usedAmount: Number(c.used_amount || 0),
    issueYear: Number(c.issue_year),
    validUntil: c.valid_until,
    registry: c.registry,
    status: c.status,
    backfill: true,
    legacyTxId: c._legacyTxId || null,
    backfillNote: c._legacyTxId
      ? '存量补锚：原记录指向的交易在账本中不存在，本次按原始资产记录重新上链，原 txid 留存于 legacyTxId'
      : '存量补锚：签发时未上链，本次按原始资产记录补记存证',
  },
  _update: 'UPDATE credit_asset SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
}));

/* ── 3. 碳信用抵销 ───────────────────────────────────────────── */
await run('offset', `
  SELECT o.id, o.offset_no, o.ent_id, o.asset_id, o.year, o.amount,
         o.quota_before, o.quota_after, o.operator, o.chain_tx_id, e.ent_name
    FROM credit_offset o JOIN enterprise e ON e.id = o.ent_id
   `, (o) => ({
  txType: 'CREDIT_OFFSET',
  bizNo: o.offset_no,
  fromLabel: `ent:${o.ent_id}`,
  payload: {
    offsetNo: o.offset_no,
    entId: o.ent_id,
    entName: o.ent_name,
    assetId: o.asset_id,
    year: Number(o.year),
    amount: Number(o.amount),
    quotaBefore: Number(o.quota_before || 0),
    quotaAfter: Number(o.quota_after || 0),
    operator: o.operator,
    backfill: true,
    legacyTxId: o._legacyTxId || null,
    backfillNote: o._legacyTxId
      ? '存量补锚：原记录指向的交易在账本中不存在，本次按原始抵销记录重新上链，原 txid 留存于 legacyTxId'
      : '存量补锚：抵销时未上链，本次按原始抵销记录补记存证',
  },
  _update: 'UPDATE credit_offset SET chain_block_index = ?, chain_tx_id = ? WHERE id = ?',
}));

console.log('\n=== 汇总 ===');
for (const [n, miss, ok, total] of SUMMARY) console.log(`${n.padEnd(8)} 总 ${String(total).padStart(4)} · 待补 ${String(miss).padStart(4)} · 已补 ${ok}`);
if (!APPLY) console.log('\n（只读模式，未写入。加 --apply 执行补锚）');
process.exit(0);
