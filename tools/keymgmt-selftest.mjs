/**
 * keymgmt-selftest.mjs —— WP2 密码学生产化的验收脚本
 * ==================================================================
 * 这个脚本要证明的不是"我们调用了签名函数"，而是三件评审真正关心的事：
 *
 *   ① 算法套件是真的国密
 *      SM2（GB/T 32918）+ SM3（GB/T 32905），签名方案为 SM2-with-SM3。
 *      自检里会断言：同一载荷两次签名结果不同（SM2 随机数 k 非同定），
 *      但都能验通过 —— 这正是 SM2 而非"哈希冒充签名"的特征。
 *
 *   ② 密钥轮换不以牺牲可核验性为代价
 *      用第 N 代签名 → 轮换到 N+1 代 → **旧签名仍能验通过**，且 generation
 *      标记为 HISTORICAL（由历史公钥验）。五项断言逐条打印。
 *
 *   ③ 双人复核是服务层强制，不是流程约定
 *      同一人既申请又复核时，必须抛错并拒绝执行；换另一人才放行。
 *
 * 用法
 *   npm run keymgmt:selftest
 */
'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const KM = require('../server/services/keymgmt');
const db = require('../server/db');

let pass = 0; let fail = 0;
const line = (okFlag, name, detail) => {
  if (okFlag) pass++; else fail++;
  console.log(`  ${okFlag ? '✔' : '✗'} ${name}${detail ? '  →  ' + detail : ''}`);
};

const PAYLOAD = {
  bizNo: 'WP2-SELFTEST-001',
  entId: 1,
  emission: 12345.6789,
  period: '2026',
  at: '2026-10-12T22:00:00.000Z',
  nested: { a: [1, 2, 3], b: '中文载荷测试' },
};

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  WP2 密码学生产化 · 验收（国密 SM2/SM3 密钥治理）');
  console.log('══════════════════════════════════════════════════════════════');

  /* ---------- A. 能力声明 ---------- */
  console.log('\n【A】能力与提供商（含如实声明的局限）');
  const cap = KM.capability();
  line(cap.available === true, `SM2 可用（${cap.suite}）`, cap.reason || '');
  line(/SM2-with-SM3/.test(cap.signing || ''), `签名方案：${cap.signing}`);
  line(cap.hsmReady === false && !!cap.hsmNote, '如实声明"未接硬件加密机"', cap.hsmNote);
  line(cap.dualControl && cap.dualControl.enforced === true, '双人复核标记为服务层强制', cap.dualControl && cap.dualControl.rule);

  /* ---------- B. 签名语义 ---------- */
  console.log('\n【B】签名与验签语义');
  const label = 'node:1';
  const s1 = KM.signPayload(label, PAYLOAD);
  const s2 = KM.signPayload(label, PAYLOAD);
  line(s1.signature !== s2.signature,
    '同一载荷两次签名结果不同（SM2 随机数 k 非同定 ⇒ 非"哈希冒充签名"）',
    `${String(s1.signature).slice(0, 20)}… vs ${String(s2.signature).slice(0, 20)}…`);
  line(KM.verifyPayload(label, PAYLOAD, s1.signature).valid === true, '原载荷验签通过');
  line(KM.verifyPayload(label, { ...PAYLOAD, emission: 9999 }, s1.signature).valid === false,
    '篡改数值 ⇒ 验签失败');
  line(KM.verifyPayload(label, { ...PAYLOAD, nested: { a: [1, 2, 4], b: '中文载荷测试' } }, s1.signature).valid === false,
    '篡改嵌套字段 ⇒ 验签失败');
  /* 规范化序列化：键序变化不应影响验签 */
  const reordered = { at: PAYLOAD.at, period: PAYLOAD.period, emission: PAYLOAD.emission, entId: PAYLOAD.entId,
    bizNo: PAYLOAD.bizNo, nested: { b: PAYLOAD.nested.b, a: PAYLOAD.nested.a } };
  line(KM.verifyPayload(label, reordered, s1.signature).valid === true,
    '键序变化仍验签通过（stableStringify 规范化）');
  line(KM.verifyPayload('node:999', PAYLOAD, s1.signature).valid === false, '未登记主体验签失败');

  /* ---------- C. 轮换安全性（五项断言） ---------- */
  console.log('\n【C】密钥轮换安全性举证');
  const demo = KM.rotationSafetyDemo('ent:9', PAYLOAD);
  demo.checks.forEach((c) => line(c.pass, c.name,
    `期望 ${c.expect} / 实际 ${c.actual}${c.generation ? ' (' + c.generation + ')' : ''}`));
  console.log(`     世代：第 ${demo.generations.before} 代 → 第 ${demo.generations.after} 代`);
  console.log(`     结论：${demo.conclusion}`);

  /* ---------- D. 双人复核（服务层强制） ---------- */
  console.log('\n【D】双人复核全流程');
  const rotLabel = 'gateway:1';
  const before = KM.signPayload(rotLabel, PAYLOAD);
  const req = await KM.requestRotation({ keyLabel: rotLabel, requestedBy: '张工', reason: '自检验证' });
  line(req.status === 'PENDING', `轮换申请已创建 #${req.id}（此时不生成任何新私钥）`);

  let sameRejected = false;
  let sameMsg = '';
  try { await KM.approveRotation(req.id, { approvedBy: '张工' }); } catch (e) { sameRejected = true; sameMsg = e.message; }
  line(sameRejected, '同一人申请+复核 ⇒ 被拒绝', sameMsg);

  const approved = await KM.approveRotation(req.id, { approvedBy: '李工', note: '自检复核' });
  line(approved.status === 'APPROVED', '换另一人复核 ⇒ 执行',
    `${approved.oldGeneration.address} → ${approved.newGeneration.address}`);
  line(approved.oldGeneration.address !== approved.newGeneration.address, '新旧世代地址不同');
  line(!!(approved.chain && approved.chain.txId), '轮换动作已上链留痕',
    approved.chain ? `block #${approved.chain.blockIndex} · tx ${String(approved.chain.txId).slice(0, 16)}…` : '');

  const vOld = KM.verifyPayload(rotLabel, PAYLOAD, before.signature);
  line(vOld.valid === true && vOld.generation === 'HISTORICAL',
    '轮换后旧签名仍验通过，且标记为 HISTORICAL',
    vOld.note || vOld.reason || '');
  const vOldPinned = KM.verifyPayload(rotLabel, PAYLOAD, before.signature, before.keyId);
  line(vOldPinned.valid === true, `指定第 ${before.keyId} 代公钥 → 仍验通过`);
  const after = KM.signPayload(rotLabel, PAYLOAD);
  const vNew = KM.verifyPayload(rotLabel, PAYLOAD, after.signature);
  line(vNew.valid === true && vNew.generation === 'CURRENT', '新签名由当前世代验通过');

  /* ---------- E. 台账完整性 ---------- */
  console.log('\n【E】轮换台账与密钥清单');
  const log = await KM.rotationLog({ limit: 20 });
  const logRows = log.rows || log;
  line(Array.isArray(logRows) && logRows.length > 0, `轮换台账 ${logRows.length} 条`);
  const row = logRows.find((r) => Number(r.id) === Number(req.id));
  line(!!row && row.dualControlOk === true, '台账带 dualControlOk 计算字段（复核人 ≠ 申请人）');
  line(!!row && row.approved_by !== row.requested_by, `复核留痕：${row && row.requested_by} 申请 / ${row && row.approved_by} 复核`);

  const inv = await KM.keyInventory();
  const items = inv.items || inv;
  line(Array.isArray(items) && items.length > 0, `密钥清单 ${items.length} 个主体`);
  const leak = JSON.stringify(items).match(/privateKey|PRIVATE KEY|"d"\s*:/i);
  line(!leak, '清单中不含任何私钥字段（只暴露公钥与指纹）');

  const st = await KM.status();
  line(st.keys && st.keys.rotated >= 1, `已轮换主体数 ${st.keys && st.keys.rotated}`);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
  console.log('══════════════════════════════════════════════════════════════\n');

  await db.pool.end();
  if (db.chainPool) await db.chainPool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\n✘ 验收脚本异常：', e);
  try { await db.pool.end(); } catch (x) { /* ignore */ }
  process.exit(1);
});
