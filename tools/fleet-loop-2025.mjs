/* 三闭环 2025 履约年度批量闭环（2026-10-30，一次性编排，分阶段幂等）
 *
 * 前提（由 fleet-accounts-setup.mjs / fleet-tasks-reassign.mjs 完成）：
 *   · 56 家合成企业各有主账号 ent001~ent060；reg002/reg003/trader03 已建；
 *   · 224 份 2025 核查结论草稿的任务已重开（VERIFYING）并 112/112 归入
 *     唐山(org 45)/河北绿链(org 54)。
 *
 * 本脚本阶段（每阶段先查库跳过已完成项）：
 *   A 代理授权：56 家企业 → 所属闭环交易席位（trader02 / trader03）；
 *   B 结论批准：ver_ts_review / ver_hblv_review 批准本闭环全部草稿
 *     （PASS/CONDITIONAL 生效上链；FAIL 按规则改判为 REJECTED 并触发预警，
 *      其排放不计入履约认定值 —— 法定口径）；
 *   C 监管调剂：reg002/003 对非交易客户端的缺口企业按「认定值−可用量+50t」增发；
 *   D 闭环内交易：盈余企业挂卖 @68.5，缺口大户经席位代理买入 @68.8；
 *     每闭环买卖总量精确配平（防止跨闭环撮合），成交 DvP 交割上链；
 *   E 履约清缴：56 家生成并执行 2025 清缴单（足额 → SURRENDERED + 凭证上链）。
 *
 * 用法：node tools/fleet-loop-2025.mjs [--phase A|B|C|D|E]（缺省全跑）
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
const BASE = 'http://127.0.0.1:8300';
const YEAR = 2025;
const PRICE_SELL = 68.5, PRICE_BUY = 68.8;
const ONLY = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : null;
const run = (ph) => !ONLY || ONLY === ph;

const conn = await mysql.createConnection({
  host: env('DB_HOST', '127.0.0.1'), port: Number(env('DB_PORT', '3306')),
  user: env('DB_USER', 'root'), password: env('DB_PASSWORD', '123456'),
  database: env('DB_NAME', 'carbon_chain'), charset: 'utf8mb4', multipleStatements: false,
});
const q = (sql, p = []) => conn.query(sql, p).then(([r]) => r);
const one = async (sql, p = []) => (await q(sql, p))[0] || null;

async function login(username) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: username === 'admin' ? 'admin123' : '123456' }),
  }).then((x) => x.json());
  if (r.code !== 0) throw new Error(`登录 ${username} 失败：${r.message}`);
  return r.data.token;
}
async function api(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  }).then((x) => x.json().catch(() => ({})));
  return r;
}
const fmt = (n) => Number(n).toFixed(2);

/* ── 闭环划分与用户映射 ──────────────────────────────────────────── */
const ents = await q(`SELECT id, ent_name FROM enterprise WHERE status='ACTIVE' AND id NOT IN (65,66,67,68) ORDER BY id`);
const LOOPS = [
  { key: 'B', orgId: 45, reg: 'reg002', trader: 'trader02', review: 'ver_ts_review', ids: ents.slice(0, 28).map((e) => e.id) },
  { key: 'C', orgId: 54, reg: 'reg003', trader: 'trader03', review: 'ver_hblv_review', ids: ents.slice(28).map((e) => e.id) },
];
const entUser = (id) => 'ent' + String(id).padStart(3, '0');
const loopOf = new Map(LOOPS.flatMap((L) => L.ids.map((id) => [id, L])));
const traderIds = {};
for (const L of LOOPS) traderIds[L.trader] = (await one('SELECT id FROM sys_user WHERE username=?', [L.trader])).id;

/* 认定值口径：仅 PASS/CONDITIONAL 计入履约（FAIL 季度由批准阶段改判 REJECTED） */
async function verifiedOf(entId) {
  const r = await one(
    `SELECT COALESCE(SUM(vr.verified_value),0) v FROM verify_report vr
      JOIN emission_report er ON er.id=vr.emission_report_id
     WHERE er.ent_id=? AND er.year=? AND vr.approved_by IS NOT NULL AND vr.conclusion IN ('PASS','CONDITIONAL')`,
    [entId, YEAR]);
  return Number(r.v);
}

/* ══ A. 代理授权 ═══════════════════════════════════════════════════ */
if (run('A')) {
  let n = 0;
  for (const L of LOOPS) {
    for (const id of L.ids) {
      const ex = await one(
        `SELECT id FROM trade_mandate WHERE ent_id=? AND trader_user_id=? AND status='ACTIVE'`,
        [id, traderIds[L.trader]]);
      if (ex) continue;
      const tk = await login(entUser(id));
      const r = await api(tk, 'POST', '/api/mandate', {
        traderUserId: traderIds[L.trader], scope: 'TRADE_ONLY',
        maxAmount: 1000000, validFrom: '2026-10-30T00:00:00Z', validTo: '2027-12-30T08:00:00Z',
      });
      if (r.code !== 0) { console.log(`✘ 授权 ent${id} → ${L.trader}：${r.message}`); continue; }
      n++;
    }
    console.log(`✔ [A] 闭环${L.key} 代理授权就绪（${L.trader}）`);
  }
  console.log(`   新签授权 ${n} 条`);
}

/* ══ B. 结论批准（224 份草稿，两闭环审核岗）═════════════════════════ */
if (run('B')) {
  for (const L of LOOPS) {
    const drafts = await q(
      `SELECT vr.id draft_id, vr.conclusion, vr.verified_value, t.id task_id, er.ent_id
         FROM verify_report vr
         JOIN emission_report er ON er.id=vr.emission_report_id
         JOIN verify_task t ON t.report_id=er.id
        WHERE er.ent_id IN (${L.ids.map(() => '?').join(',')}) AND er.year=?
          AND vr.approved_by IS NULL AND t.verifier_id=?`, [...L.ids, YEAR, L.orgId]);
    if (!drafts.length) { console.log(`✔ [B] 闭环${L.key} 无待批草稿`); continue; }
    const tk = await login(L.review);
    let okN = 0, failN = 0, errN = 0;
    for (const d of drafts) {
      const r = await api(tk, 'POST', `/api/verifier/tasks/${d.task_id}/verify`, {
        approveReportId: d.draft_id, conclusion: d.conclusion,
        verifiedValue: Number(d.verified_value),
        opinion: d.conclusion === 'FAIL'
          ? '复核确认：关键排放源数据存在实质性缺陷，结论不予通过，需整改后重新上报。'
          : '复核确认：数据来源真实、核算边界完整，认定值予以认可。',
      });
      if (r.code !== 0) { errN++; console.log(`   ✘ 草稿 ${d.draft_id}（ent${d.ent_id}）：${r.message}`); continue; }
      d.conclusion === 'FAIL' ? failN++ : okN++;
      if ((okN + failN + errN) % 40 === 0) console.log(`   … 闭环${L.key} 已处理 ${okN + failN + errN}/${drafts.length}`);
    }
    console.log(`✔ [B] 闭环${L.key} 批准完成：PASS/COND ${okN} · FAIL改判 ${failN} · 失败 ${errN}`);
  }
}

/* ══ C+D+E 需要的缺口快照（认定值 vs 可用量）═══════════════════════ */
async function gaps() {
  const out = {};
  for (const L of LOOPS) {
    out[L.key] = [];
    for (const id of L.ids) {
      const v = await verifiedOf(id);
      const acc = await one(`SELECT available FROM carbon_quota WHERE ent_id=? AND year=?`, [id, YEAR]);
      out[L.key].push({ id, v, avail: acc ? Number(acc.available) : 0, gap: acc ? Number(acc.available) - v : 0 });
    }
  }
  return out;
}

/* ══ C. 监管调剂（先定交易客户端，其余缺口全额增发）════════════════ */
let GAPS = await gaps();
const PLAN = {};
if (run('C') || run('D')) {
  for (const L of LOOPS) {
    const g = GAPS[L.key];
    const deficits = g.filter((x) => x.gap < -0.01).sort((a, b) => a.gap - b.gap);
    const supplyEnts = g.filter((x) => x.gap > 0.01);
    const supply = supplyEnts.reduce((s, x) => s + x.gap - 10, 0);
    /* 交易客户端：缺口从小到大贪心，尽量多企业走交易链路；资金须覆盖货款 */
    const clients = [];
    let cum = 0;
    for (const d of deficits) {
      const cost = (-d.gap) * PRICE_BUY * 1.05;
      const bal = Number((await one('SELECT balance FROM settlement_account WHERE ent_id=?', [d.id])).balance);
      if (cum + (-d.gap) <= supply - 500 && bal >= cost) { clients.push(d); cum += -d.gap; }
    }
    PLAN[L.key] = { clients, supplyEnts, buyTotal: cum };
    console.log(`[计划] 闭环${L.key}：交易客户端 ${clients.length} 家（Σ ${fmt(cum)} t）；调剂 ${deficits.length - clients.length} 家；供给 ${fmt(supply)} t`);
  }
}
if (run('C')) {
  for (const L of LOOPS) {
    const tk = await login(L.reg);
    const clientSet = new Set(PLAN[L.key].clients.map((c) => c.id));
    let n = 0;
    for (const x of GAPS[L.key]) {
      if (x.gap >= -0.01 || clientSet.has(x.id)) continue;
      const r = await api(tk, 'POST', '/api/regulator/allocations', {
        entId: x.id, year: YEAR, amount: fmt(-x.gap + 50), allocType: 'FREE', allocMethod: '年中调剂',
      });
      if (r.code !== 0) console.log(`   ✘ 调剂 ent${x.id}：${r.message}`); else n++;
    }
    console.log(`✔ [C] 闭环${L.key} 监管调剂 ${n} 笔`);
  }
}

/* ══ D. 闭环内交易（卖出=买入精确配平，防跨闭环撮合）═══════════════ */
if (run('D')) {
  for (const L of LOOPS) {
    const { clients, supplyEnts, buyTotal } = PLAN[L.key];
    if (!clients.length) { console.log(`✔ [D] 闭环${L.key} 无需交易`); continue; }
    /* 幂等守卫：本轮已下过单的企业跳过（重跑不重复成交） */
    const doneEnts = new Set((await q(
      `SELECT ent_id, side FROM trade_order WHERE ent_id IN (${L.ids.map(() => '?').join(',')})
        AND created_at >= CURDATE() AND status IN ('OPEN','PARTIAL','FILLED')`, L.ids
    )).map((r) => `${r.ent_id}:${r.side}`));
    const pendingClients = clients.filter((c) => !doneEnts.has(`${c.id}:BUY`));
    if (!pendingClients.length) { console.log(`✔ [D] 闭环${L.key} 本轮已成交，跳过`); continue; }
    const buyTotal2 = Number(pendingClients.reduce((s, c) => s + (-c.gap), 0).toFixed(2));
    /* 卖量分配：按 (富余−10) 等比缩放到 Σ卖=Σ买，舍入差额由最大卖家找平 */
    const base = supplyEnts.map((s) => ({ id: s.id, amount: s.gap - 10, cap: s.gap }));
    const scale = buyTotal2 / base.reduce((s, x) => s + x.amount, 0);
    const sells = base
      .filter((s) => !doneEnts.has(`${s.id}:SELL`))
      .map((s) => ({ id: s.id, amount: Number((s.amount * scale).toFixed(2)), cap: s.cap }));
    const diff = Number((buyTotal2 - sells.reduce((s, x) => s + x.amount, 0)).toFixed(2));
    const big = sells.reduce((a, b) => (b.amount > a.amount ? b : a));
    big.amount = Number((big.amount + diff).toFixed(2));
    if (sells.some((s) => s.amount <= 0) || big.amount > big.cap) {
      console.log(`✘ 闭环${L.key} 卖量配平失败（diff=${diff}）`); continue;
    }
    let sold = 0;
    for (const s of sells) {
      const tk = await login(entUser(s.id));
      const r = await api(tk, 'POST', '/api/trade/orders',
        { side: 'SELL', price: PRICE_SELL, amount: fmt(s.amount), year: YEAR });
      if (r.code !== 0) console.log(`   ✘ 挂卖 ent${s.id}：${r.message}`); else sold++;
    }
    const tt = await login(L.trader);
    let bought = 0;
    for (const c of pendingClients) {
      const r = await api(tt, 'POST', '/api/trade/orders',
        { side: 'BUY', price: PRICE_BUY, amount: fmt(-c.gap), year: YEAR, entId: c.id });
      if (r.code !== 0) console.log(`   ✘ 代理买入 ent${c.id}：${r.message}`); else bought++;
    }
    console.log(`✔ [D] 闭环${L.key} 挂卖 ${sold} 笔 / 代理买入 ${bought} 笔（Σ ${fmt(buyTotal2)} t @${PRICE_SELL}/${PRICE_BUY}）`);
  }
}

/* ══ E. 履约清缴（56 家全部生成并执行 2025 清缴单）═════════════════ */
if (run('E')) {
  GAPS = await gaps();
  for (const L of LOOPS) {
    let done = 0, skipped = 0, bad = 0;
    for (const id of L.ids) {
      const ex = await one(`SELECT surrender_no, status FROM quota_surrender WHERE ent_id=? AND year=?`, [id, YEAR]);
      if (ex && ['SURRENDERED', 'CERTIFIED'].includes(ex.status)) { skipped++; continue; }
      const tk = await login(entUser(id));
      const p = await api(tk, 'POST', '/api/settlement/surrender/prepare', { year: YEAR });
      if (p.code !== 0) { bad++; console.log(`   ✘ ent${id} 试算：${p.message}`); continue; }
      if (Number(p.data.willShortfall) > 0.01) {
        bad++; console.log(`   ✘ ent${id} 仍缺 ${fmt(p.data.willShortfall)} t（可用 ${fmt(p.data.availableQuota)} / 应缴 ${fmt(p.data.requiredQuota)}）`); continue;
      }
      const x = await api(tk, 'POST', '/api/settlement/surrender/execute',
        { surrenderNo: p.data.surrenderNo, allowShortfall: false });
      if (x.code !== 0) { bad++; console.log(`   ✘ ent${id} 执行：${x.message}`); continue; }
      done++;
      if (done % 10 === 0) console.log(`   … 闭环${L.key} 已清缴 ${done}`);
    }
    console.log(`✔ [E] 闭环${L.key} 清缴：完成 ${done} · 已完成跳过 ${skipped} · 异常 ${bad}`);
  }
}

/* ══ 终态 ══════════════════════════════════════════════════════════ */
const entIds = ents.map((e) => e.id);
const sur = await q(
  `SELECT status, COUNT(*) n FROM quota_surrender WHERE year=? AND ent_id IN (${entIds.map(() => '?').join(',')}) GROUP BY status`,
  [YEAR, ...entIds]);
console.log('\n════ 舰队 2025 清缴终态 ════');
for (const s of sur) console.log(`  ${s.status}: ${s.n} 家`);
const cb = await one('SELECT MAX(block_index) h FROM chain_block').catch(() => null);
console.log(`  链高度 #${cb?.h ?? '?'}`);
await conn.end();
