/* 把「真机上报的 cems_reading」单独锚定成一笔链上存证。
 *
 * 背景（为什么需要这个脚本）：
 *   `dynamic.startScheduler()` 的 tick 会做 batch 上链，但它的周期由
 *   CEMS_INTERVAL_MS 控制；演示期该值被设为 24h（用于关掉虚拟数据调度），
 *   所以真机读数不会自己上链。本脚本用于手动补一次锚定。
 *
 * 口径复用：锚定+回写逻辑**只有一份实现** —— `services/dynamic#anchorPendingBatch`。
 *   ⚠ 早前这里有第二份实现，且 `startScheduler` 内联的那份用的是
 *   `WHERE chain_tx_id IS NULL`（全表条件），会把所有设备的历史未锚定行
 *   统统挂到同一笔交易上，使 chain_tx_id 失去溯源意义。现在统一到一处，
 *   本脚本只负责"传一个设备过滤条件"。
 *
 * 用法：node server/scripts/anchor-real-rows.cjs [deviceDid 片段]
 */
const dynamic = require('../services/dynamic');

const DEV_FRAG = process.argv[2] || 'd6782a54';

(async () => {
  const r = await dynamic.anchorPendingBatch({
    where: 'device_did LIKE ?',
    params: [`%${DEV_FRAG}%`],
    bizPrefix: 'CEMSREAL',
    scope: 'REAL_DEVICE_ONLY',
  });
  if (!r) {
    console.log('该设备没有待锚定的读数（chain_tx_id 已全部回写）');
  } else {
    console.log(JSON.stringify(r, null, 1));
  }
  /* ⚠ 必须显式退出：db 连接池不 close，事件循环一直有句柄，
   *   进程不会自己结束 —— 表现为「跑完不出结果、被外层 timeout 杀成 SIGTERM」。 */
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e && e.stack ? e.stack : e);
  process.exit(1);
});
