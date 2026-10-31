/**
 * 演示核查机构补齐待办任务（Turso 版）
 * ------------------------------------------------------------------
 * 与本地 tools/demo-readiness.mjs 同口径：演示机构（ver001 → org 1）
 * 必须具备至少 2 个 PENDING 任务，否则评审点开核查端只能"查看"，
 * 接单 → 出结论 → 上链 这条闭环演示不下去。
 *
 * 做法：把其它机构名下"企业已提交但尚未出具结论"的任务重新指派给
 * 演示机构（保留原报告与截止日期），**不新建虚构任务**、不改业务数据。
 *
 * 用法：node tools/_qa/demo-verifier-tasks-turso.mjs [--execute]
 */
import fs from 'node:fs';
import { createTurso } from '../../../../碳链通小程序/server/src/turso.js';

const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const db = createTurso({ url: env.TURSO_URL, token: env.TURSO_AUTH_TOKEN });
const EXECUTE = process.argv.includes('--execute');

const ORG = 1;   // ver001 → 大连碳中和技术研究院有限公司
const NEED = 2;

const have = Number((await db.prepare(
  `SELECT COUNT(*) AS n FROM verify_task WHERE verifier_id = ${ORG} AND status = 'PENDING'`).first()).n);
console.log(`演示机构 #${ORG} 当前 PENDING 任务：${have} 个（需要 ≥ ${NEED}）`);

if (have >= NEED) { console.log('✔ 已满足，无需处理'); process.exit(0); }

const need = NEED - have;
const cands = (await db.prepare(
  `SELECT t.id, t.task_no, t.report_id, t.ent_id, t.verifier_id, e.ent_name
     FROM verify_task t
     JOIN emission_report r ON r.id = t.report_id
     LEFT JOIN enterprise e ON e.id = t.ent_id
    WHERE t.status = 'PENDING' AND t.verifier_id <> ${ORG}
      AND r.status IN ('SUBMITTED','VERIFYING')
    ORDER BY t.id DESC LIMIT ${need}`).all()).results;

console.log(`可重新指派的候选任务：${cands.length} 个`);
for (const c of cands) console.log(`  #${c.id} ${c.task_no} ${c.ent_name} (原 verifier ${c.verifier_id})`);

if (!cands.length) { console.log('⊘ 没有可指派的候选（需先有企业提交上报）'); process.exit(1); }
if (!EXECUTE) { console.log('\n⊘ 预演模式：未写库。加 --execute 执行。'); process.exit(0); }

for (const c of cands) {
  await db.prepare(
    `UPDATE verify_task SET verifier_id = ?, verifier_user = ? WHERE id = ? AND status = 'PENDING'`,
  ).bind(ORG, `ver${String(ORG).padStart(3, '0')}`, c.id).run();
  await db.prepare('UPDATE emission_report SET verifier_id = ? WHERE id = ?').bind(ORG, c.report_id).run();
  console.log(`  ✓ #${c.id} → verifier ${ORG}`);
}

const after = Number((await db.prepare(
  `SELECT COUNT(*) AS n FROM verify_task WHERE verifier_id = ${ORG} AND status = 'PENDING'`).first()).n);
console.log(`✔ 完成：演示机构 PENDING 任务 ${have} → ${after}`);
