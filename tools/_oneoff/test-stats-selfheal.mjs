/* 验证 stats() 的链顶自愈：把内存链故意截短 4 块（模拟"另一个进程刚往同一本
 * 账本写了 4 个块"），stats() 应就地 reloadAll 并把 height 拉回库顶，
 * 且**不改动数据库任何一行**。纯内存操作，可反复执行。 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Blockchain } = require('../../server/blockchain/chain.js');
const db = require('../../server/db.js');

const [[before]] = await db.chainPool.query('SELECT COUNT(*) AS c, MAX(block_index) AS m FROM chain_block');
const chain = await new Blockchain(db.chainPool).init();
const realLen = chain.blocks.length;
const realTip = chain.blocks[realLen - 1].index;

const s0 = await chain.stats();
console.log(`基线      height=${s0.height} totalBlocks=${s0.totalBlocks} maxBlockIndex=${s0.maxBlockIndex}`);

chain.blocks = chain.blocks.slice(0, -4);
console.log(`人为截短  内存链顶=${chain.blocks[chain.blocks.length - 1].index}（内存 ${chain.blocks.length} 块，库 ${Number(before.c)} 块）`);

const s1 = await chain.stats();
console.log(`调用stats height=${s1.height} totalBlocks=${s1.totalBlocks} maxBlockIndex=${s1.maxBlockIndex} 内存恢复=${chain.blocks.length} 块`);

const selfConsistent = s1.height === s1.maxBlockIndex && s1.totalBlocks === s1.maxBlockIndex + 1;
const healed = chain.blocks.length === realLen && s1.height === realTip;
const [[after]] = await db.chainPool.query('SELECT COUNT(*) AS c, MAX(block_index) AS m FROM chain_block');
const dbUntouched = Number(after.c) === Number(before.c) && Number(after.m) === Number(before.m);

console.log('');
console.log(`① height=maxBlockIndex 且 totalBlocks=max+1 : ${selfConsistent ? 'PASS' : 'FAIL'}`);
console.log(`② 内存链自愈回真实链顶 #${realTip}           : ${healed ? 'PASS' : 'FAIL'}`);
console.log(`③ 数据库未被本次测试改动                    : ${dbUntouched ? 'PASS' : 'FAIL'}`);
await db.pool.end().catch(() => {});
process.exit(selfConsistent && healed && dbUntouched ? 0 : 1);
