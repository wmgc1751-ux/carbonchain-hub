/**
 * cross-check-internal.cjs —— 内核自校验参照（WP7 可核验性 · 双轨对撞）
 * ==================================================================
 * 定位：与 tools/verify-offline.mjs **成对使用**。
 *
 *   · verify-offline.mjs  —— 零信任外部复核。不 require 项目任何模块，
 *                            独立重实现全部密码学原语，只吃一份 JSON 导出。
 *   · cross-check-internal.cjs —— 平台自身内核自校验。直接调用
 *                            server/blockchain/chain.js#validateChain。
 *
 * 两者是**两条独立实现路径**：
 *   - 若结论一致（valid、区块数、链顶哈希、链下绑定笔数全等），
 *     说明"平台自证"与"第三方独立复核"没有分歧，可核验性主张成立；
 *   - 若结论不一致，则必有一方口径有问题 —— 这正是本对撞要暴露的。
 *
 * 历史价值：本脚本第一次运行即暴露出 verify-offline.mjs 曾因
 * 「导出会话时区未钉 UTC」而误报 150 块哈希失配 + 150 块签名失配（共 300 处假阳性），
 * 而内核侧同一时刻判定 valid=true。对撞机制因此证明了自身价值。
 *
 * 用法：
 *   node tools/cross-check-internal.cjs
 *   node tools/cross-check-internal.cjs --from 100     # 只校验高度 100 之后
 *
 * 退出码：0 = 内核判定链有效；1 = 内核判定链无效；2 = 运行失败
 */
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');

/* 项目未安装 dotenv，这里做一次极简 .env 注入（不覆盖已存在的环境变量） */
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { Blockchain } = require(path.join(root, 'server/blockchain/chain.js'));
const db = require(path.join(root, 'server/db.js'));

/* 参数 */
const argv = process.argv.slice(2);
let fromIndex = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--from') fromIndex = Number(argv[++i]) || 0;
}

(async () => {
  // chain.js 内部用 `const [rows] = await this.db.query(...)`，
  // 故此处必须传**原生连接池**，不能传 db 包装器（其 query 直接返回 rows）。
  // 用 chainPool 而非 pool：链内核会 SET time_zone='+00:00'，必须独占连接
  // （理由见 server/db.js#chainPool 注释）。
  const chain = new Blockchain(db.chainPool, { consensusMode: 'POA', nodeName: 'cross-check-internal' });
  await chain.init();

  const r = await chain.validateChain({ fromIndex });
  const s = await chain.stats();

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  碳链通 · 内核自校验参照（cross-check-internal）');
  console.log('════════════════════════════════════════════════════════════════');
  if (fromIndex) console.log(`  校验范围      高度 ≥ ${fromIndex}`);
  console.log(`  判定          ${r.valid ? '链接构有效 ✔' : '发现异常 ✘'}`);
  console.log(`  区块校验数    ${r.checkedBlocks}`);
  console.log(`  链高度        ${r.height}`);
  console.log(`  链顶哈希      ${s.tipHash}`);
  console.log(`  区块 / 存证   ${s.totalBlocks} / ${s.totalTxs}`);
  console.log(`  异常          ${(r.errors || []).length} 处`);
  if (r.errors && r.errors.length) {
    for (const e of r.errors.slice(0, 10)) console.log(`    [${e.type}] ${e.message}`);
    if (r.errors.length > 10) console.log(`    …另有 ${r.errors.length - 10} 处`);
  }
  if (r.coverage) {
    console.log(`  覆盖面        ${JSON.stringify(r.coverage)}`);
  }
  console.log('────────────────────────────────────────────────────────────────');
  console.log('  对撞用法：把上面的「判定 / 链顶哈希 / 链下绑定笔数」与');
  console.log('  `node tools/verify-offline.mjs --input tools/out/chain-export.json`');
  console.log('  的输出逐项比对。两条独立实现路径，结论必须一致。');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');

  await db.pool.end().catch(() => {});
  await db.chainPool.end().catch(() => {});
  process.exit(r.valid ? 0 : 1);
})().catch((e) => {
  console.error('✘ 交叉校验失败：', e && e.message ? e.message : e);
  process.exit(2);
});
