/**
 * 联盟节点副本同步修复（Turso 版）
 * ------------------------------------------------------------------
 * 背景：主链出块后没有任何机制把新区块同步到成员节点的链副本
 * （chain_node_replica），副本一路落后。实测主链 #812 时五个副本
 * 全部停在 #767，而 /api/consortium/replica 的旧判据拿"副本间最大高度"
 * 当基准，于是照样报"5/5 一致"——一个永远不会报错的校验。
 *
 * 本工具做两件事：
 *   1. 把各节点副本补齐到主链链顶（逐块写入，含块哈希）；
 *   2. 按"副本高度 === 主链链顶"重新判定一致性并输出。
 *
 * 用法：node tools/fix-replica-sync.mjs [--execute]
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

const tip = await db.prepare(
  'SELECT block_index AS h, block_hash AS hash FROM chain_block ORDER BY block_index DESC LIMIT 1').first();
const tipH = Number(tip.h);
console.log(`主链链顶：#${tipH} ${String(tip.hash).slice(0, 16)}…`);

const nodes = (await db.prepare(
  'SELECT node_id, node_name, status, replica_height FROM chain_node ORDER BY id').all()).results;
const rep = (await db.prepare(
  'SELECT node_id, MAX(block_index) AS h FROM chain_node_replica GROUP BY node_id').all()).results;
const repMap = new Map(rep.map((r) => [r.node_id, Number(r.h)]));

console.log('\n节点副本现状：');
let needFix = 0;
for (const n of nodes) {
  const cur = repMap.get(n.node_id) || 0;
  const behind = tipH - cur;
  if (behind > 0) needFix++;
  console.log(`  ${n.node_id.padEnd(22)} ${String(n.node_name).slice(0, 14).padEnd(16)} `
    + `副本 #${String(cur).padStart(4)}  落后 ${String(Math.max(0, behind)).padStart(3)} 块`);
}

if (!needFix) { console.log('\n✔ 全部副本已同步到链顶，无需处理'); process.exit(0); }
if (!EXECUTE) { console.log('\n⊘ 预演模式：未写库。加 --execute 执行。'); process.exit(0); }

/* 逐块补齐：每块写入 5 个节点的副本行 */
const minH = Math.min(...nodes.map((n) => repMap.get(n.node_id) || 0));
const blocks = (await db.prepare(
  'SELECT block_index, block_hash FROM chain_block WHERE block_index > ? ORDER BY block_index ASC',
).bind(minH).all()).results;
console.log(`待补齐区块：${blocks.length} 个（从 #${minH + 1} 起）`);
if (!blocks.length) { console.log('⊘ 无区块需要补齐（副本行可能已存在但高度记录不同）'); }

let written = 0;
for (const b of blocks) {
  const stmts = nodes.map((n) => ({
    sql: `INSERT INTO chain_node_replica (node_id, block_index, block_hash, synced_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(node_id, block_index) DO UPDATE SET block_hash = excluded.block_hash`,
    args: [n.node_id, Number(b.block_index), b.block_hash],
  }));
  try {
    await db.batch(stmts);
    written += stmts.length;
  } catch (e) {
    /* ON CONFLICT 需要唯一约束；无约束时退回普通 INSERT */
    const plain = nodes.map((n) => ({
      sql: `INSERT INTO chain_node_replica (node_id, block_index, block_hash, synced_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      args: [n.node_id, Number(b.block_index), b.block_hash],
    }));
    await db.batch(plain);
    written += plain.length;
  }
}
await db.prepare('UPDATE chain_node SET replica_height = ?, replica_tip = ?').bind(tipH, tip.hash).run();

console.log(`\n✔ 写入副本记录 ${written} 条`);

const after = (await db.prepare(
  'SELECT node_id, MAX(block_index) AS h FROM chain_node_replica GROUP BY node_id').all()).results;
const ok = after.filter((r) => Number(r.h) === tipH).length;
console.log(`复验：${ok}/${nodes.length} 个副本与链顶 #${tipH} 一致`);
