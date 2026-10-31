#!/usr/bin/env node
/**
 * reanchor-deal-missing.mjs —— CCD-011 收尾：补锚 chain_tx_id 指向不存在交易
 * 的 TRADE_DEAL 行（reanchor-biz 不覆盖 deal 类型）。
 * 用法：node tools/reanchor-deal-missing.mjs [--dry]
 * 幂等：重跑缺失集为空即无操作。
 * @module tools/reanchor-deal-missing
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
  const known = new Set((await db.ledgerQuery('SELECT tx_id FROM chain_tx')).map((r) => r.tx_id));
  const rows = await db.query(
    `SELECT d.deal_no, d.buyer_ent_id, d.seller_ent_id, d.price, d.amount, d.total_amount, d.fee,
            bo.order_no AS buy_order_no, so.order_no AS sell_order_no
       FROM trade_deal d
       LEFT JOIN trade_order bo ON bo.id = d.buy_order_id
       LEFT JOIN trade_order so ON so.id = d.sell_order_id
      WHERE d.chain_tx_id IS NOT NULL AND d.chain_tx_id <> ''`);
  const missing = rows.filter((r) => !known.has(r.chain_tx_id));
  console.log(`[deal-missing] TRADE_DEAL 有交易号 ${rows.length} · 指向缺失 ${missing.length}`
    + (DRY ? '（dry-run）' : ''));
  if (DRY) {
    missing.forEach((r) => console.log(`  · ${r.deal_no} → 缺失 tx ${String(r.chain_tx_id).slice(0, 16)}…`));
    process.exit(0);
  }
  let ok = 0;
  const fails = [];
  for (const r of missing) {
    try {
      const net = Math.round(Number(r.total_amount) - Number(r.fee || 0));
      const chain = await anchorSvc.anchor({
        txType: 'TRADE_DEAL',
        bizNo: r.deal_no,
        fromLabel: `ent:${r.seller_ent_id}`,
        toLabel: `ent:${r.buyer_ent_id}`,
        payload: {
          dealNo: r.deal_no,
          buyerEntId: r.buyer_ent_id, sellerEntId: r.seller_ent_id,
          price: Number(r.price), amount: Number(r.amount),
          totalAmount: Number(r.total_amount), fee: Number(r.fee || 0),
          netToSeller: net,
          buyOrderNo: r.buy_order_no || null, sellOrderNo: r.sell_order_no || null,
          settlement: 'DvP（券款对付，资金与配额同事务交割）',
          reanchor: 'CCD-011-deal-missing',
        },
      });
      await db.query('UPDATE trade_deal SET chain_block_index = ?, chain_tx_id = ? WHERE deal_no = ?',
        [chain.blockIndex, chain.txId, r.deal_no]);
      ok += 1;
    } catch (e) {
      fails.push(`${r.deal_no}: ${String(e.message).slice(0, 80)}`);
    }
  }
  console.log(`[deal-missing] 完成：成功 ${ok}/${missing.length}` + (fails.length ? ` · 失败 ${fails.length}` : ''));
  fails.forEach((f) => console.error('  ✘ ' + f));
  process.exit(fails.length ? 1 : 0);
}

main().then(
  () => process.exit(0),
  (e) => { console.error('✘ 崩溃：', e); process.exit(1); }
);
