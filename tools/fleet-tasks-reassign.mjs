/* 三闭环任务重指派（2026-10-30，一次性 SQL  surgery，幂等）
 *
 * 背景：56 家合成企业的 2025 年度核查结论（224 份草稿，全部未批准）所挂的
 * verify_task 被种子数据标成 DONE/REJECTED，且散落在约 40 家机构 —— 既是
 * 「DONE 任务挂着待批结论」的自相矛盾状态，也无法由闭环机构的审核岗经 API
 * 走双人批准（任务按机构隔离）。
 *
 * 本脚本：
 *   1) 按闭环拆分（前 28 家 → 唐山 org 45，后 28 家 → 河北绿链 org 54），
 *      把 2025 年度上报单的任务重新指派到所属闭环机构；
 *   2) 状态重开：DONE/REJECTED → VERIFYING（两段式核查的「待复核」中间态，
 *      使 approveReportId 批准路径可用）；PENDING/PROCESSING 原样保留；
 *   3) 迁出沧州(org 8)卡着的两个外来企业任务（ent25/ent38，闭环封闭要求）；
 *   4) 同步 emission_report.verifier_id。
 * 原闭环四家真实企业（65~68）的任务一律不动。
 */
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const ENV = (() => {
  try { return readFileSync(new URL('../.env', import.meta.url), 'utf8'); } catch { return ''; }
})();
const env = (k, d = '') => {
  const m = ENV.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim() : d;
};

const ORG_B = 45, ORG_C = 54;
const conn = await mysql.createConnection({
  host: env('DB_HOST', '127.0.0.1'), port: Number(env('DB_PORT', '3306')),
  user: env('DB_USER', 'root'), password: env('DB_PASSWORD', '123456'),
  database: env('DB_NAME', 'carbon_chain'), charset: 'utf8mb4', multipleStatements: false,
});
const q = (sql, p = []) => conn.query(sql, p).then(([r]) => r);

const ents = await q(`SELECT id FROM enterprise WHERE status='ACTIVE' AND id NOT IN (65,66,67,68) ORDER BY id`);
const ids = ents.map((e) => e.id);
const orgOf = new Map(ids.map((id, i) => [id, i < 28 ? ORG_B : ORG_C]));
console.log(`闭环 B（org ${ORG_B}）企业 ${ids.slice(0, 28).length} 家；闭环 C（org ${ORG_C}）企业 ${ids.length - 28} 家`);

/* 1+2+4) 2025 年度任务重指派 + 重开 */
const tasks = await q(
  `SELECT t.id, t.task_no, t.status, t.verifier_id, er.ent_id
     FROM emission_report er
     JOIN verify_task t ON t.report_id = er.id
    WHERE er.ent_id IN (${ids.map(() => '?').join(',')}) AND er.year = 2025`, ids
);
let moved = 0, reopened = 0, same = 0;
for (const t of tasks) {
  const target = orgOf.get(t.ent_id);
  const needMove = t.verifier_id !== target;
  const needReopen = ['DONE', 'REJECTED'].includes(t.status);
  if (!needMove && !needReopen) { same++; continue; }
  if (needReopen) {
    await q(`UPDATE verify_task SET status='VERIFYING', finish_time=NULL, reject_reason=NULL WHERE id=?`, [t.id]);
    reopened++;
  }
  if (needMove) {
    await q(`UPDATE verify_task SET verifier_id=?, verifier_user=? WHERE id=?`,
      [target, 'ver' + String(target).padStart(3, '0'), t.id]);
    await q(`UPDATE emission_report SET verifier_id=? WHERE id=? AND verifier_id<>?`,
      [target, (await q(`SELECT report_id FROM verify_task WHERE id=?`, [t.id]))[0].report_id, target]);
    /* 【2026-10-30 补】verify_report 必须一起改。
     * 原脚本只同步 verify_task 与 emission_report，核查结论的 verifier_id
     * 留在原机构 —— 结果是报告出现在 A 机构的台账里、任务却归属 B 机构，
     * 且电子签章摘要（拼入了 verifier_id）与落库值对不上，核验必然失败。
     * 全库曾累计 219 条此类记录（org1 名下混入 8 份别家报告），
     * 直接表现就是「累计完成」与「链上存证」两个数字永远对不齐。 */
    await q(`UPDATE verify_report SET verifier_id=? WHERE task_id=? AND verifier_id<>?`,
      [target, t.id, target]);
    moved++;
  }
}
console.log(`2025 任务：重指派 ${moved} · 重开 ${reopened} · 原样 ${same}（共 ${tasks.length}）`);

/* 3) 迁出沧州的两个外来任务（按企业所属闭环归位） */
const strays = await q(
  `SELECT t.id, t.task_no, t.ent_id, t.status FROM verify_task t
    WHERE t.verifier_id = 8 AND t.ent_id NOT IN (65,66,67,68)
      AND t.status IN ('PENDING','PROCESSING','VERIFYING','ACCEPTED','IN_PROGRESS')`
);
for (const t of strays) {
  const target = orgOf.get(t.ent_id);
  if (!target) { console.log(`⚠ 任务 ${t.task_no}（ent${t.ent_id}）不在闭环企业清单，跳过`); continue; }
  await q(`UPDATE verify_task SET verifier_id=?, verifier_user=? WHERE id=?`,
    [target, 'ver' + String(target).padStart(3, '0'), t.id]);
  console.log(`✔ 迁出 ${t.task_no}（ent${t.ent_id} ${t.status}）→ org ${target}`);
}

/* 终态核对：org 8 除四家真实企业外应无任何在办任务 */
const leftRows = await q(
  `SELECT COUNT(*) n FROM verify_task WHERE verifier_id=8 AND ent_id NOT IN (65,66,67,68)
    AND status IN ('PENDING','PROCESSING','VERIFYING','ACCEPTED','IN_PROGRESS')`
);
console.log(`org 8 在办外来任务残留：${leftRows[0].n}（应为 0）`);
const dist = await q(
  `SELECT verifier_id, status, COUNT(*) n FROM verify_task
    WHERE ent_id IN (${ids.map(() => '?').join(',')}) AND year(created_at) >= 2020
      AND id IN (SELECT t2.id FROM verify_task t2 JOIN emission_report er2 ON er2.id=t2.report_id WHERE er2.year=2025)
    GROUP BY verifier_id, status ORDER BY verifier_id, status`, ids
);
console.log('== 2025 任务终态 ==');
for (const r of dist) console.log(`  org${r.verifier_id} ${r.status} ${r.n}`);

await conn.end();
console.log('任务重指派完成。');
