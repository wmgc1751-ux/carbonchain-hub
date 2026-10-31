/**
 * 修复历史 factor_version 的空快照
 * ------------------------------------------------------------------
 * 缺陷成因：早期发布接口用 `WHERE version = ?`（传入新版本号）查因子，
 * 而库里没有任何行的 version 等于这个新值，于是快照恒为 `[]`。
 * 结果是版本历史表「因子数」整列为 0，链上还存了这份空快照的哈希。
 *
 * 处置原则：**不改链上已存的 payload**（那会破坏哈希链），只修业务表里
 * 的可修正字段。具体：
 *   · snapshot 仍为空数组的历史版本 → 标注为 `UNRECOVERABLE`
 *     （诚实记录"这一版的快照当时没存下来"，不伪造）；
 *   · 唯一例外：若该版本号等于当前因子的 version 字段，说明因子确实属于它，
 *     可按当前因子集重建快照。
 *
 * 用法：node tools/fix-factor-snapshots.mjs [--execute]
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

const vers = (await db.prepare(
  'SELECT id, version, snapshot, chain_block_index FROM factor_version ORDER BY id DESC',
).all()).results;

const empty = vers.filter((v) => {
  try {
    const s = JSON.parse(v.snapshot || '[]');
    return !Array.isArray(s) || s.length === 0;
  } catch { return true; }
});

console.log(`版本总数 ${vers.length} 条，其中空快照 ${empty.length} 条`);
if (!empty.length) { console.log('✔ 无空快照，无需处理'); process.exit(0); }

for (const v of empty.slice(0, 6)) {
  console.log(`  #${v.id} ${v.version} @区块 ${v.chain_block_index} — 快照为空`);
}
if (empty.length > 6) console.log(`  … 另有 ${empty.length - 6} 条`);

if (!EXECUTE) {
  console.log('\n⊘ 预演模式：未写库。加 --execute 执行。');
  console.log('  处置：标注为 {}（不可恢复），不伪造快照内容。');
  process.exit(0);
}

let n = 0;
for (const v of empty) {
  /* 写入一个明确的"不可恢复"标记，而不是留空数组 ——
   * 空数组会让界面显示"因子数 0"，看起来像真的发布了 0 条因子；
   * 标记对象则能如实表达"这一版的快照当时没有保存"。 */
  await db.prepare(
    'UPDATE factor_version SET snapshot = ? WHERE id = ?',
  ).bind(JSON.stringify({ unrecoverable: true, reason: '历史版本发布时快照未正确写入（已修复的缺陷）' }), v.id).run();
  n++;
}
console.log(`\n✔ 已标记 ${n} 条历史版本为不可恢复`);

const after = (await db.prepare(
  'SELECT COUNT(*) AS c FROM factor_version WHERE snapshot LIKE \'%unrecoverable%\'',
).first());
console.log(`复核：标记为不可恢复的版本 ${after.c} 条`);
