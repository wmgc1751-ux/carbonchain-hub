/* 2026 履约季演示闭环搭建（2026-10-30，一次性编排）
 *
 * 目标：让 8 个演示账号的业务串成完整闭环（2025 履约年度）：
 *   reg001 分配 2025 配额 → ent65/68 挂卖 surplus → trader01 代理 ent66/67
 *   买入补缺 → 四家企业清缴执行 → 全部 SURRENDERED 出证。
 *   另为 ver_cz_review 留一份「待受理 + 待复核」的 2026Q1 活水任务。
 *
 * 前提（已核实）：
 *   · 四家企业 2025 年四个季度上报单均已核查批准（ver_cz_review 历史批准），
 *     年度核定排放 = ent65 302,857.87 / ent66 150,081.46 / ent67 104,100.94 / ent68 160,597.33 t；
 *   · 2025 年配额未分配（演示起点）；
 *   · 定价 68.5/68.8 避开旧挂单（68.9–70.5 为合成企业 2024 vintage 卖单，
 *     78.5 为 ent67 遗留 PARTIAL 买单——它会对我们的卖单成交 1,081.17 t@2025，
 *     已计入 ent67 的供需测算）；
 *   · mandate 单笔上限 1000 t → 先放宽到 100,000 t（SQL）。
 *
 * 用法：node tools/build-closed-loop-2025.mjs [--dry-run]
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
const DRY = process.argv.includes('--dry-run');
const BASE = 'http://127.0.0.1:8300';
const YEAR = 2025;
const PRICE_SELL = 68.5, PRICE_BUY = 68.8;

/* 2025 供需测算（tCO₂e）：
 *  核定排放（已批准结论） / 拟分配（=2024 年免费分配） / 缺口 */
const ENTS = [
  { id: 65, user: 'ent_zjbd', alloc: 362613.08, verified: 302857.87, sell: 55000 },
  { id: 66, user: 'ent_yfkw', alloc: 97498.08,  verified: 150081.46, buy: 52650, deposit: 4000000 },
  { id: 67, user: 'ent_yxyf', alloc: 95369.71,  verified: 104100.94, buy: 7700,  deposit: 1000000 },
  { id: 68, user: 'ent_zjyls', alloc: 172025.13, verified: 160597.33, sell: 11000 },
];

const conn = await mysql.createConnection({
  host: env('DB_HOST', '127.0.0.1'), port: Number(env('DB_PORT', '3306')),
  user: env('DB_USER', 'root'), password: env('DB_PASSWORD', '123456'),
  database: env('DB_NAME', 'carbon_chain'), charset: 'utf8mb4',
});
const q = (sql, p = []) => conn.query(sql, p).then(([r]) => r);
const one = async (sql, p = []) => (await q(sql, p))[0] || null;

async function login(username) {
  const password = username === 'admin' ? 'admin123' : '123456';
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then((x) => x.json());
  if (r.code !== 0) throw new Error(`登录 ${username} 失败：${r.message}`);
  return { token: r.data.token, user: r.data.user };
}
async function api(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  }).then((x) => x.json().catch(() => ({})));
  return r;
}
let step = 0;
const ok = (msg) => console.log(`✔ [${++step}] ${msg}`);
const bail = (msg) => { console.error(`✘ [${++step}] ${msg}`); process.exit(1); };

/* ── 0. 幂等守卫：2025 配额若已存在则拒绝重跑 ─────────────────────── */
const have = await one(`SELECT COUNT(*) n FROM carbon_quota WHERE year = ? AND ent_id IN (65,66,67,68)`, [YEAR]);
if (have.n > 0) bail(`2025 年度配额已存在 ${have.n} 行，闭环疑似已搭建过，拒绝重复执行`);
ok(`前置校验通过：2025 年度配额未分配（起点干净）`);

/* ── 1. 放宽代理授权单笔上限（1000 → 100000 t）────────────────────── */
if (!DRY) {
  const r = await q(`UPDATE trade_mandate SET max_amount = 100000 WHERE ent_id IN (65,66,67,68) AND status='ACTIVE'`);
  ok(`代理授权上限放宽：${r.affectedRows} 条 → max_amount=100000 t`);
} else ok('[dry] 代理授权上限放宽（跳过）');

/* ── 2. reg001：分配 2025 年度免费配额（历史强度法，口径 = 2024）────── */
const reg = await login('reg001');
for (const e of ENTS) {
  if (DRY) continue;
  const r = await api(reg.token, 'POST', '/api/regulator/allocations', {
    entId: e.id, year: YEAR, amount: e.alloc, allocType: 'FREE', allocMethod: '历史强度法',
  });
  if (r.code !== 0) bail(`配额分配 ent${e.id} 失败：${r.message}`);
  ok(`reg001 分配 ent${e.id} 2025 年配额 ${e.alloc} t（区块 #${r.data.chain.blockIndex}）`);
}

/* ── 3. 买方企业结算账户入金 ──────────────────────────────────────── */
for (const e of ENTS.filter((x) => x.deposit)) {
  if (DRY) continue;
  const t = await login(e.user);
  const r = await api(t.token, 'POST', '/api/settlement/account/deposit',
    { amount: e.deposit, remark: '2025 履约年度购碳备付金' });
  if (r.code !== 0) bail(`入金 ent${e.id} 失败：${r.message}`);
  ok(`${e.user} 入金 ${e.deposit} 元（余额 ${r.data.balance ?? '?'}}）`.replace('}}', '}'));
}

/* ── 4. 卖方挂单（冻结 2025 配额；同时触发 ent67 遗留买单成交）──────── */
for (const e of ENTS.filter((x) => x.sell)) {
  if (DRY) continue;
  const t = await login(e.user);
  const r = await api(t.token, 'POST', '/api/trade/orders',
    { side: 'SELL', price: PRICE_SELL, amount: e.sell, year: YEAR });
  if (r.code !== 0) bail(`${e.user} 挂卖失败：${r.message}`);
  ok(`${e.user} 挂卖 ${e.sell} t @ ${PRICE_SELL}（成交 ${r.data.matchedCount} 笔）`);
}

/* ── 5. trader01 代理买方下单（授权额度内）────────────────────────── */
const trader = await login('trader01');
for (const e of ENTS.filter((x) => x.buy)) {
  if (DRY) continue;
  const r = await api(trader.token, 'POST', '/api/trade/orders',
    { side: 'BUY', price: PRICE_BUY, amount: e.buy, year: YEAR, entId: e.id });
  if (r.code !== 0) bail(`trader01 代理 ent${e.id} 买入失败：${r.message}`);
  ok(`trader01 代理 ent${e.id} 买入 ${e.buy} t @ ${PRICE_BUY}（成交 ${r.data.matchedCount} 笔）`);
}

/* ── 6. 仓位核验：每家 2025 可用 ≥ 年度核定排放 ────────────────────── */
if (!DRY) {
  let allOk = true;
  for (const e of ENTS) {
    const row = await one(`SELECT available, frozen FROM carbon_quota WHERE ent_id = ? AND year = ?`, [e.id, YEAR]);
    const surplus = Number(row.available) - e.verified;
    const flag = surplus >= -0.01 ? '✔' : '✘';
    if (surplus < -0.01) allOk = false;
    console.log(`   ${flag} ent${e.id} 可用 ${Number(row.available).toFixed(2)} − 应缴 ${e.verified} = 富余 ${surplus.toFixed(2)} t`);
  }
  if (!allOk) bail('存在可用配额不足的企业，中止清缴');
  ok('六、2025 仓位核验通过，进入清缴');
}

/* ── 7. 四家企业：生成清缴单 → 执行（足额出证）────────────────────── */
for (const e of ENTS) {
  if (DRY) continue;
  const t = await login(e.user);
  const p = await api(t.token, 'POST', '/api/settlement/surrender/prepare', { year: YEAR });
  if (p.code !== 0) bail(`ent${e.id} 生成清缴单失败：${p.message}`);
  if (Number(p.data.willShortfall) > 0.01) bail(`ent${e.id} 仍有缺口 ${p.data.willShortfall} t，交易量测算有误`);
  const x = await api(t.token, 'POST', '/api/settlement/surrender/execute',
    { surrenderNo: p.data.surrenderNo, allowShortfall: false });
  if (x.code !== 0) bail(`ent${e.id} 执行清缴失败：${x.message}`);
  ok(`ent${e.id} 清缴 ${x.data.surrendered} t → ${x.data.status}（凭证 ${x.data.certificateNo}，区块 #${x.data.chain?.blockIndex}）`);
}

/* ── 8. reg001：处置 3 条高优先级预警（其余留作演示活水）────────────── */
if (!DRY) {
  const alerts = await q(`SELECT id, ent_id, title FROM alert_record WHERE ent_id IN (65,66,67,68) AND status='OPEN' ORDER BY level='HIGH' DESC, id LIMIT 3`);
  for (const a of alerts) {
    const r = await api(reg.token, 'POST', `/api/regulator/alerts/${a.id}/handle`,
      { status: 'CLOSED', note: '已核实：数据链路完整，纳入 2025 履约监管台账' });
    if (r.code !== 0) bail(`预警 ${a.id} 处置失败：${r.message}`);
    ok(`reg001 处置预警 #${a.id}（ent${a.ent_id}）→ CLOSED`);
  }
}

/* ── 9. ent66 提交 2026Q1 上报 → 任务钉到沧州（org 8）──────────────── */
let newTask = null;
if (!DRY) {
  const t = await login('ent_yfkw');
  const items = [
    { energyType: '天然气', amount: 1735.2 },
    { energyType: '电力', amount: 3120.5 },
  ];
  const r = await api(t.token, 'POST', '/api/enterprise/reports',
    { year: 2026, quarter: 1, dataSource: '排放因子法', items, submit: true });
  if (r.code !== 0) bail(`2026Q1 上报失败：${r.message}`);
  const repId = r.data.reportId;
  const task = await one(`SELECT id, task_no FROM verify_task WHERE report_id = ? ORDER BY id DESC LIMIT 1`, [repId]);
  await q(`UPDATE verify_task SET verifier_id = 8, verifier_user = 'ver008' WHERE id = ?`, [task.id]);
  await q(`UPDATE emission_report SET verifier_id = 8 WHERE id = ?`, [repId]);
  newTask = { taskId: task.id, taskNo: task.task_no, reportNo: r.data.reportNo };
  ok(`ent66 提交 2026Q1 上报（${r.data.reportNo}，区块 #${r.data.chain.blockIndex}），任务 ${task.task_no} 已指派沧州机构`);
}

/* ── 10. ver_cz_clerk（隐藏账号，经 API）出具结论草稿，留给复核岗现场批准 ── */
if (!DRY && newTask) {
  const clerk = await login('ver_cz_clerk');
  const r = await api(clerk.token, 'POST', `/api/verifier/tasks/${newTask.taskId}/verify`, {
    conclusion: 'PASS',
    opinion: 'CEMS 小时数据与上报明细交叉一致，核算边界完整，建议通过。',
  });
  if (r.code !== 0) bail(`结论草稿提交失败：${r.message}`);
  ok(`ver_cz_clerk 出具结论草稿 ${r.data.verifyReportNo}（待复核）—— ver_cz_review 现场批准即完成双人链`);
}

/* ── 11. 终态汇总 ────────────────────────────────────────────────── */
if (!DRY) {
  const sur = await q(`SELECT ent_id, status, surrendered_quota, certificate_no FROM quota_surrender WHERE year = ? AND ent_id IN (65,66,67,68) ORDER BY ent_id`, [YEAR]);
  const deals = await one(`SELECT COUNT(*) n, SUM(amount) amt FROM trade_deal WHERE buyer_ent_id IN (65,66,67,68) OR seller_ent_id IN (65,66,67,68)`);
  const h = await one(`SELECT MAX(block_index) h FROM chain_block`).catch(() => null);
  console.log('\n════ 2025 履约闭环终态 ════');
  for (const s of sur) console.log(`  ent${s.ent_id}  ${s.status}  已缴 ${Number(s.surrendered_quota).toFixed(2)} t  凭证 ${s.certificate_no || '-'}`);
  console.log(`  四家企业相关成交 ${deals.n} 笔 / ${Number(deals.amt).toFixed(2)} t`);
  console.log(`  链高度 #${h?.h ?? '?'}`);
}
await conn.end();
console.log(DRY ? '\n（演练模式，未写库）' : '\n闭环搭建完成。');
