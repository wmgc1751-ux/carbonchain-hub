#!/usr/bin/env node
/**
 * tools/ownership-coherence-check.mjs —— 核查机构归属一致性守门
 * ==================================================================
 * 为什么需要它
 * ------------------------------------------------------------------
 * 任务改派（tools/fleet-tasks-reassign.mjs）历史上只更新 verify_task 与
 * emission_report，漏掉了 verify_report。核查结论因此会留在原机构名下，
 * 表现为：
 *   · A 机构的总览/台账里出现别家机构的任务产出的报告；
 *   · 「累计完成」（按任务）与「链上存证」（按报告）两个数字对不上；
 *   · 电子签章摘要（sha256 拼入了 verifier_id）与落库值不一致，
 *     点「核验存证」必失败 —— 这是静默错误，页面不报错，只是结论错误。
 * 全库曾累计 219 条。
 *
 * 本脚本把三条不变量做成可重复执行的断言，接入 verify:all。
 *
 * 用法
 *   node tools/ownership-coherence-check.mjs
 *   node tools/ownership-coherence-check.mjs --strict   # 警告也计为失败
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = require(path.join(ROOT, 'server', 'db.js'));
const cu = require(path.join(ROOT, 'server', 'blockchain', 'crypto-utils.js'));
const STRICT = process.argv.includes('--strict');

const rows = [];
function add(level, name, detail) {
  rows.push({ level, name, detail });
  const mark = level === 'FAIL' ? '✘' : level === 'WARN' ? '!' : '✔';
  console.log(`  ${mark} ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  /* ── 不变量 1：报告归属必须等于其任务的归属 ── */
  const mismatch = await db.query(
    `SELECT COUNT(*) AS c FROM verify_report vr
       JOIN verify_task vt ON vt.id = vr.task_id
      WHERE vr.verifier_id <> vt.verifier_id`
  );
  const n1 = Number(mismatch[0].c);
  add(n1 === 0 ? 'PASS' : 'FAIL', '核查报告与任务的机构归属一致',
    n1 === 0 ? '0 条不一致' : `${n1} 条报告挂在他家机构的任务下`);

  /* ── 不变量 2：排放上报单归属与任务一致 ── */
  const m2 = await db.query(
    `SELECT COUNT(*) AS c FROM emission_report er
       JOIN verify_task vt ON vt.report_id = er.id
      WHERE er.verifier_id <> vt.verifier_id`
  );
  const n2 = Number(m2[0].c);
  add(n2 === 0 ? 'PASS' : 'FAIL', '排放上报单与任务的机构归属一致',
    n2 === 0 ? '0 条不一致' : `${n2} 条不一致`);

  /* ── 不变量 3：电子签章摘要可由落库值重算 ──
   * 摘要 = sha256(报告号|认定值|核查员|结论|机构ID)。
   * 归属被改错时这项必然失败 —— 比"看数字对不对"更硬的证据。
   *
   * 只校验**已上链生效**的报告：两阶段流程的草稿阶段
   * （server/routes/verifier.js 提交分支）用的是另一套三字段摘要
   * sha256(报告号|认定值|结论)，复核批准时才改写为五字段并上链。
   * 草稿尚未生效、也无法被外部核验，用生效公式去比对只会误报。 */
  const reports = await db.query(
    `SELECT report_no, verifier_id, verified_value, auditor, conclusion, seal_hash
       FROM verify_report
      WHERE seal_hash IS NOT NULL AND seal_hash <> ''
        AND chain_tx_id IS NOT NULL AND chain_tx_id <> ''`
  );
  let badSeal = 0;
  const samples = [];
  for (const r of reports) {
    const expect = cu.sha256(`${r.report_no}|${Number(r.verified_value)}|${r.auditor}|${r.conclusion}|${r.verifier_id}`);
    if (expect !== r.seal_hash) {
      badSeal++;
      if (samples.length < 3) samples.push(r.report_no);
    }
  }
  add(badSeal === 0 ? 'PASS' : 'FAIL', '核查结论电子签章可复算',
    badSeal === 0 ? `${reports.length} 份全部吻合` : `${badSeal} 份摘要对不上（如 ${samples.join(', ')}）`);

  /* ── 不变量 4：各机构「完成+驳回」应等于其已存证报告份数 ──
   * 这条是总览页两个 KPI 的等式，不等就说明台账口径出了问题。 */
  const orgs = await db.query(
    `SELECT t.verifier_id AS id,
            SUM(t.status = 'DONE') AS done,
            SUM(t.status = 'REJECTED') AS rejected
       FROM verify_task t GROUP BY t.verifier_id`
  );
  const chained = await db.query(
    `SELECT verifier_id AS id, COUNT(DISTINCT report_no) AS c
       FROM verify_report
      WHERE chain_tx_id IS NOT NULL AND chain_tx_id <> ''
      GROUP BY verifier_id`
  );
  const cmap = Object.fromEntries(chained.map((r) => [String(r.id), Number(r.c)]));
  const off = [];
  for (const o of orgs) {
    const id = String(o.id);
    const tasksDone = Number(o.done || 0) + Number(o.rejected || 0);
    const chain = cmap[id] || 0;
    if (tasksDone !== chain) off.push(`org${id}: 完成+驳回 ${tasksDone} ≠ 存证 ${chain}`);
  }
  add(off.length === 0 ? 'PASS' : 'WARN', '各机构「完成+驳回」= 已存证报告份数',
    off.length === 0 ? `${orgs.length} 家机构全部相等` : off.slice(0, 3).join('；'));

  /* ── 不变量 5：同一份报告不应被同一机构重复锚定 ──
   * 重复锚定会让「链上存证」虚高。总览接口已改按 distinct biz_no 计，
   * 这里继续提示数据层的重复，便于排查补锚脚本。 */
  const wallets = await db.query('SELECT id, wallet_address FROM verifier_org');
  const wmap = Object.fromEntries(wallets.map((w) => [String(w.id), String(w.wallet_address || '').toLowerCase()]));
  const byNo = await db.query(
    `SELECT verifier_id AS id, report_no, COUNT(*) AS c FROM verify_report
      WHERE chain_tx_id IS NOT NULL AND chain_tx_id <> ''
      GROUP BY verifier_id, report_no HAVING COUNT(*) > 1`
  );
  let dupAnchors = 0;
  for (const r of byNo) {
    const w = wmap[String(r.id)];
    if (!w) continue;
    const cnt = await db.ledgerValue(
      `SELECT COUNT(*) FROM chain_tx
        WHERE tx_type = 'VERIFY_REPORT' AND from_address = ? AND biz_no = ?`, [w, r.report_no]
    );
    if (Number(cnt || 0) > 1) dupAnchors++;
  }
  add(dupAnchors === 0 ? 'PASS' : 'WARN', '同一报告未被重复上链',
    dupAnchors === 0 ? '无重复锚定' : `${dupAnchors} 份报告有多笔存证（口径已按去重计，不虚高）`);

  const fails = rows.filter((r) => r.level === 'FAIL').length;
  const warns = rows.filter((r) => r.level === 'WARN').length;
  console.log(`\n归属一致性：${rows.length - fails - warns} 通过 · ${warns} 警告 · ${fails} 失败`);
  process.exit(code(fails, warns));
} catch (e) {
  console.error('FATAL', e.message);
  process.exit(1);
}

function code(fails, warns) {
  if (fails) return 1;
  if (STRICT && warns) return 1;
  return 0;
}
