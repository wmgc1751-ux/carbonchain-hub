/**
 * 演示数据复位（Turso 版）
 * ------------------------------------------------------------------
 * 全流程验证脚本会真实消耗演示数据：企业把 2025/2026 八个季度报满、
 * 核查机构把待办全部出结论。反复跑几次之后演示就"无空档可演示"了。
 *
 * 本工具把演示所需的最小数据集复位到**可重复演示**的稳态：
 *   1. ent001 保留 2026Q1–Q3 + 2025 全年，清空 2026Q4（留一个空档）；
 *   2. ver001（org 1）保留已出结论的报告，补 ≥2 个 PENDING 待办；
 *   3. 报告/任务/存证一律不删 —— 只调状态与指派关系。
 *
 * 用法：node tools/_qa/demo-reset-turso.mjs [--execute]
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

const ENT = 1;          // ent001 → 邢台纸业
const VER_ORG = 1;      // ver001 → 大连碳中和技术研究院
const KEEP_PERIODS = ['2026Q1', '2026Q2', '2026Q3'];
const OPEN_PERIOD = '2026Q4';

const log = [];

/* 1) 企业季度空档：把 2026Q4 的报告与任务清掉（只清这一个季度） */
const q4 = (await db.prepare(
  `SELECT id, report_no, status, chain_tx_id FROM emission_report
    WHERE ent_id = ${ENT} AND period = '${OPEN_PERIOD}'`).all()).results;
log.push(`ent001 ${OPEN_PERIOD} 现有上报单：${q4.length} 条（将清空以留出演示空档）`);

/* 2) 核查待办 */
const pend = (await db.prepare(
  `SELECT COUNT(*) AS n FROM verify_task WHERE verifier_id = ${VER_ORG} AND status = 'PENDING'`).first()).n;
log.push(`ver001 待办：${Number(pend)} 个（目标 ≥ 2）`);

if (!EXECUTE) {
  console.log(log.join('\n'));
  console.log('\n⊘ 预演模式：未写库。加 --execute 执行。');
  process.exit(0);
}

/* 执行：删除 2026Q4 的报告与关联任务（演示空档用，非历史数据） */
for (const r of q4) {
  await db.prepare(`DELETE FROM emission_item WHERE report_id = ${r.id}`).run();
  await db.prepare(`DELETE FROM verify_task WHERE report_id = ${r.id}`).run();
  await db.prepare(`DELETE FROM verify_report WHERE emission_report_id = ${r.id}`).run();
  await db.prepare(`DELETE FROM emission_report WHERE id = ${r.id}`).run();
}
console.log(`  ✓ 已清空 ${q4.length} 条 ${OPEN_PERIOD} 上报单（含明细与关联任务）`);

/* 补待办：把其它机构 PENDING 且报告未定稿的任务指给 ver001 */
const have = Number((await db.prepare(
  `SELECT COUNT(*) AS n FROM verify_task WHERE verifier_id = ${VER_ORG} AND status = 'PENDING'`).first()).n);
const need = Math.max(0, 2 - have);
if (need > 0) {
  const cands = (await db.prepare(
    `SELECT t.id, t.report_id FROM verify_task t
       JOIN emission_report r ON r.id = t.report_id
      WHERE t.status = 'PENDING' AND t.verifier_id <> ${VER_ORG}
        AND r.status IN ('SUBMITTED','VERIFYING')
      ORDER BY t.id DESC LIMIT ${need}`).all()).results;
  for (const c of cands) {
    await db.prepare(
      `UPDATE verify_task SET verifier_id = ${VER_ORG}, verifier_user = 'ver001' WHERE id = ${c.id}`).run();
    await db.prepare(`UPDATE emission_report SET verifier_id = ${VER_ORG} WHERE id = ${c.report_id}`).run();
  }
  console.log(`  ✓ 补入 ${cands.length} 个待办到 ver001`);
}

const fin = (await db.prepare(
  `SELECT COUNT(*) AS n FROM verify_task WHERE verifier_id = ${VER_ORG} AND status = 'PENDING'`).first()).n;
const q4left = (await db.prepare(
  `SELECT COUNT(*) AS n FROM emission_report WHERE ent_id = ${ENT} AND period = '${OPEN_PERIOD}'`).first()).n;
console.log(`✔ 复位完成：ver001 待办 ${Number(fin)} 个｜ent001 ${OPEN_PERIOD} 空档 ${Number(q4left) === 0 ? '已就绪' : '仍占用'}`);
