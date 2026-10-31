/**
 * 链上指标锚定工具 —— 把"会变的数字"转成"永久可验证的历史事实"
 * ==================================================================
 * 问题：论文表 5-3 引用链高度与存证笔数，而这两个值随业务持续增长。
 * 每过一天，表里的数字就与系统实际值不符 —— 评审一对比就发现"对不上"。
 *
 * 这不是数据问题，是**引用方式**问题：把动态量的实时读数当成了静态值。
 *
 * 解法：给每个数字加两个锚点 —— 统计时刻 + 区块高度。
 *   "截至区块 #829（2026-10-27 15:xx），全链累计 2,990 笔存证"
 * 这句话**永远为真**，不需要在任何时间点重新刷新；而且任何人随时可以
 * 回查区块 #829 验证它。动态量因此变成可证伪的历史陈述。
 *
 * 用法：
 *   node tools/anchor-metrics.mjs                 # 输出当前锚点（用于写论文）
 *   node tools/anchor-metrics.mjs --verify <h> <n> <date>
 *                                                 # 校验论文所引锚点是否成立
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTurso } from '../../../碳链通小程序/server/src/turso.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const db = createTurso({ url: env.TURSO_URL, token: env.TURSO_AUTH_TOKEN });

const args = process.argv.slice(2);
const verifyMode = args[0] === '--verify';

/** 取链顶 + 累计存证数 + 统计时刻 */
async function snapshot() {
  const tip = await db.prepare(
    'SELECT block_index AS h, block_hash AS hash, block_time AS t FROM chain_block ORDER BY block_index DESC LIMIT 1',
  ).first();
  const txs = await db.prepare('SELECT COUNT(*) AS c FROM chain_tx').first();
  const blocks = await db.prepare('SELECT COUNT(*) AS c FROM chain_block').first();
  const cems = await db.prepare('SELECT COUNT(*) AS c FROM cems_reading').first();
  return {
    height: Number(tip.h),
    hash: String(tip.hash),
    blockTime: String(tip.t),
    totalTx: Number(txs.c),
    totalBlocks: Number(blocks.c),
    cemsReadings: Number(cems.c),
  };
}

/**
 * 校验某个历史锚点是否成立。
 * 锚点成立的定义：在高度 h 的区块内，累计存证笔数恰为 n。
 * 这可通过「该块内 MAX(id) 的 chain_tx」直接复算 —— 与当前链顶无关，
 * 因此无论链后来增长多少，这个断言永远可验证。
 */
async function verify(h, expectedTx, expectedDate) {
  const tip = await db.prepare(
    'SELECT block_index AS h, block_hash AS hash, block_time AS t FROM chain_block ORDER BY block_index DESC LIMIT 1',
  ).first();
  /* ⚠ 参数必须走 .bind()：把数组作为 prepare() 的第二参数会被静默忽略，
   * 于是 `WHERE block_index <= ?` 拿到 NULL、恒返回 0 ——
   * 校验功能会把**正确的锚点也判为不成立**，比没有校验更糟。 */
  const atBlock = await db.prepare(
    'SELECT COUNT(*) AS c FROM chain_tx WHERE block_index <= ?',
  ).bind(h).first();
  const blk = await db.prepare(
    'SELECT block_index AS h, block_hash AS hash, block_time AS t, tx_count AS n FROM chain_block WHERE block_index = ?',
  ).bind(h).first();

  const out = [];
  const ok = (cond, label, detail) => {
    out.push({ ok: !!cond, label, detail });
    return !!cond;
  };

  ok(!!blk, `区块 #${h} 存在`, blk ? `${blk.t} · ${String(blk.hash).slice(0, 16)}…` : '不存在');
  ok(Number(atBlock.c) === expectedTx,
    `截至 #${h} 累计存证 = ${expectedTx}`,
    `实算 ${atBlock.c} 笔${Number(atBlock.c) === expectedTx ? '' : ' ← 不符'}`);
  if (expectedDate) {
    ok(String(blk && blk.t).slice(0, 10) === expectedDate,
      `该块时间 = ${expectedDate}`, `实际 ${String(blk && blk.t).slice(0, 10)}`);
  }

  console.log(`\n锚点校验：#${h} / ${expectedTx} 笔 / ${expectedDate || '（未指定日期）'}`);
  console.log(`  当前链顶：#${tip.h}（已增长 ${Number(tip.h) - Number(h)} 块）`);
  console.log('  —— 链顶增长不影响锚点成立性，这正是锚点的意义 ——\n');
  out.forEach((r) => console.log(`  ${r.ok ? '✔' : '✘'} ${r.label}  ${r.detail}`));

  const allOk = out.every((r) => r.ok);
  console.log(`\n${allOk ? '✔ 锚点成立：论文所引数据可随时复核' : '✘ 锚点不成立：论文数据与实际链上历史不符'}`);
  process.exit(allOk ? 0 : 1);
}

if (verifyMode) {
  const h = Number(args[1]);
  const n = Number(args[2]);
  const d = args[3] || '';
  if (!Number.isFinite(h) || !Number.isFinite(n)) {
    console.error('用法：node tools/anchor-metrics.mjs --verify <区块高度> <累计存证数> [YYYY-MM-DD]');
    process.exit(2);
  }
  await verify(h, n, d);
} else {
  const s = await snapshot();
  const date = s.blockTime.slice(0, 10);
  console.log('\n══════ 当前链上锚点（可直接写入论文表 5-3）══════\n');
  console.log(`  截至区块 #${s.height}（${s.blockTime}）`);
  console.log(`  全链累计：${s.totalBlocks} 个区块 / ${s.totalTx} 笔存证`);
  console.log(`  链顶哈希：${s.hash.slice(0, 16)}…`);
  console.log(`  CEMS 读数：${s.cemsReadings} 条`);
  console.log('\n  论文建议表述：');
  console.log(`  「截至区块 #${s.height}（${date}），全链累计 ${s.totalBlocks} 个区块、${s.totalTx} 笔存证。」`);
  console.log('\n  该表述为历史陈述，日后无需刷新；可用下面命令随时复核：');
  console.log(`  node tools/anchor-metrics.mjs --verify ${s.height} ${s.totalTx} ${date}\n`);
}
