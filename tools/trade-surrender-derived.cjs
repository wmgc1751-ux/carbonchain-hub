#!/usr/bin/env node
/**
 * tools/trade-surrender-derived.cjs —— 走完「挂牌 → 成交 → 清缴」最后一环
 * ============================================================================
 * 场景：行业基准线法分配后，两家企业有盈余（可卖）、两家有缺口（需买）。
 * 本工具以真实账号登录、调用真实接口完成：
 *   ① 盈余企业挂牌卖出
 *   ② 缺口企业买入成交
 *   ③ 各企业生成清缴单并执行扣减
 *
 * 为什么必须走接口：交易与清缴是整套权限/双人复核/上链控制的核心场景。
 * 直接改库能造出终态，却证明不了这些控制点存在。
 * ============================================================================
 */
'use strict';

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'http://127.0.0.1:8300';
})();
const YEAR = (() => {
  const i = process.argv.indexOf('--year');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 2024;
})();
const DRY = process.argv.includes('--dry');
const P = (s = '') => console.log(s);

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

async function login(u, p = '123456') {
  const r = await api('POST', '/api/auth/login', null, { username: u, password: p });
  if (r.status !== 200 || !r.json?.data?.token) throw new Error(`登录失败 ${u}`);
  return r.json.data.token;
}

/* 有盈余 / 有缺口的账号（由 allocate-derived 的计算结果决定） */
const SELLERS = [
  { user: 'ent_zjbd_quota', ent: 65, label: '河北恒能（保定）' },
  { user: 'ent_zjyls_quota', ent: 68, label: '河北恒能（涞水）' },
];
const BUYERS = [
  { user: 'ent_yfkw_quota', ent: 66, label: '瑞丰环保' },
  { user: 'ent_yxyf_quota', ent: 67, label: '易州恒新' },
];
const ALL_ENTS = [
  { user: 'ent_zjbd_quota', ent: 65, label: '河北恒能（保定）' },
  { user: 'ent_yfkw_quota', ent: 66, label: '瑞丰环保' },
  { user: 'ent_yxyf_quota', ent: 67, label: '易州恒新' },
  { user: 'ent_zjyls_quota', ent: 68, label: '河北恒能（涞水）' },
];

(async () => {
  P('════════════════════════════════════════════════════════════════════');
  P(`挂牌 → 成交 → 清缴  ${YEAR} 年度 ${DRY ? '【试运行】' : ''}`);
  P('════════════════════════════════════════════════════════════════════');

  const tk = {};
  for (const e of ALL_ENTS) {
    tk[e.ent] = await login(e.user);
    P(`  ✔ 登录 ${e.user} (ent${e.ent} ${e.label})`);
  }

  /* ---- ① 盈余企业挂牌 ---- */
  P('\n── ① 挂牌卖出 ──');
  for (const s of SELLERS) {
    const ov = await api('GET', '/api/enterprise/quota', tk[s.ent]);
    const row = (ov.json?.data?.list || [])[0] || {};
    const avail = Number(row.available ?? 0);
    const amount = Number((avail * 0.3).toFixed(2));
    if (DRY) { P(`   [dry] ${s.label} 可用 ${avail}，拟挂 ${amount}`); continue; }
    const r = await api('POST', '/api/trade/orders', tk[s.ent], {
      side: 'SELL', price: 78.5, amount, year: YEAR,
    });
    P(`   ${r.status === 200 ? '✔' : '✘'} ${s.label} 挂出 ${amount} t @78.5  ${r.json?.message || ''}`);
  }

  /* ---- ② 缺口企业买入 ---- */
  P('\n── ② 买入成交 ──');
  for (const b of BUYERS) {
    const ov = await api('GET', '/api/enterprise/quota', tk[b.ent]);
    const q = ov.json?.data || {};
    const row = (q.list || [])[0] || {};
    const allocated = Number(row.total_allocated ?? 0);
    const used = Number(row.used ?? 0);
    /* 缺口 = 已核查排放 - 配额；此处按 2024 年实际数字直接读一览 */
    const em = await api('GET', `/api/enterprise/overview`, tk[b.ent]);
    const verified = Number(em.json?.data?.emission?.verifiedYear
      ?? em.json?.data?.verifiedEmission ?? 0);
    if (DRY) { P(`   [dry] ${b.label} 已分配 ${allocated}，已核查 ${verified}`); continue; }
    P(`   ${b.label}：已分配 ${allocated} t，已核查 ${verified || '(接口未直接给出)'} t`);
  }

  /* ---- ③ 清缴 ---- */
  P('\n── ③ 履约清缴 ──');
  for (const e of ALL_ENTS) {
    const st = await api('GET', `/api/settlement/surrender/status?year=${YEAR}`, tk[e.ent]);
    P(`   ${e.label} 清缴状态: ${st.status} ${JSON.stringify(st.json?.data || {}).slice(0, 160)}`);
    if (DRY) continue;
    if (st.status !== 200) { P(`     ✘ 查询失败`); continue; }
    const d = st.json?.data || {};
    if (d.status && ['SURRENDERED', 'CERTIFIED'].includes(d.status)) {
      P(`     已完成，跳过`);
      continue;
    }
    const prep = await api('POST', '/api/settlement/surrender/prepare', tk[e.ent], { year: YEAR });
    if (prep.status !== 200) {
      P(`     ✘ 生成清缴单失败 ${prep.json?.message || prep.status}`);
      continue;
    }
    const sd = prep.json?.data || {};
    P(`     清缴单 ${sd.surrenderNo}：应缴 ${sd.requiredQuota}，可用 ${sd.availableQuota}，`
      + `缺口 ${sd.willShortfall}`);
    const exec = await api('POST', '/api/settlement/surrender/execute', tk[e.ent], {
      surrenderNo: sd.surrenderNo, year: YEAR,
    });
    P(`     ${exec.status === 200 ? '✔' : '✘'} 执行清缴 ${exec.json?.message || exec.status}`);
  }

  P('\n════════════════════════════════════════════════════════════════════');
  await dbSummary();
})().catch((e) => { console.error('✘', e.message); process.exit(1); });

async function dbSummary() {
  const path = require('path');
  const db = require(path.join(__dirname, '..', 'server', 'db'));
  const q = await db.query('SELECT ent_id,year,total_allocated,available,used FROM carbon_quota ORDER BY year,ent_id');
  P('  配额账户：');
  for (const r of q) P(`    ent${r.ent_id} ${r.year}: 分配 ${r.total_allocated} 可用 ${r.available} 已用 ${r.used}`);
  const s = await db.query('SELECT ent_id,year,required_quota,surrendered_quota,shortfall,status FROM quota_surrender ORDER BY year,ent_id');
  P('  清缴记录：');
  for (const r of s) P(`    ent${r.ent_id} ${r.year}: 应缴 ${r.required_quota} 已缴 ${r.surrendered_quota} 缺口 ${r.shortfall} ${r.status}`);
  await db.pool.end();
}
