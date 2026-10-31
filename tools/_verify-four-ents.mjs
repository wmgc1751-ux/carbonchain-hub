#!/usr/bin/env node
/**
 * tools/_verify-four-ents.mjs —— 四家企业接入后的验收自测
 *
 * 覆盖：健康检查 → 演示账号 → 四家企业数据总量 → 存证链路（验签 / 链下比对 / Merkle）
 *       → 核查端可见性 → 公开看板口径
 *
 * 用法：先启动服务，再 node tools/_verify-four-ents.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8300';

const j = async (p, opt = {}) => {
  const r = await fetch(BASE + p, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { code: r.status, raw: t.slice(0, 120) }; }
};
const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (p, tk) => j(p, { headers: tk ? { authorization: `Bearer ${tk}` } : {} });

let pass = 0; let fail = 0;
const chk = (name, cond, extra = '') => {
  console.log(`  ${cond ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`);
  cond ? pass++ : fail++;
};

const login = async (u, p = '123456') => (await post('/api/auth/login', { username: u, password: p }))?.data?.token;

(async () => {
  console.log('\n── 1. 健康与账本 ──');
  const h = await j('/api/health');
  chk('health UP', h?.data?.status === 'UP', `链高 ${h?.data?.chainHeight}`);
  chk('账本可达', h?.code === 0);

  console.log('\n── 2. 演示账号 ──');
  const demos = (await j('/api/auth/demo-accounts'))?.data || [];
  /* 2026-10-30 账号收敛：全部角色「一类一个账号」共 8 个（docs/四家企业接入与演示账号） */
  chk('白名单 8 个', demos.length === 8, `实际 ${demos.length}`);
  const four = ['ent_zjbd', 'ent_yfkw', 'ent_yxyf', 'ent_zjyls'];
  for (const u of four) {
    const a = demos.find((x) => x.username === u);
    const t = await login(u, a?.password || '123456');
    chk(`${u} 可登录`, !!t, a?.orgName || '');
  }
  for (const u of ['admin', 'reg001', 'ver001', 'ver_cz_review', 'ent001', 'trader01']) {
    const a = demos.find((x) => x.username === u);
    chk(`${u} 可登录`, !!(await login(u, a?.password || '123456')));
  }

  console.log('\n── 3. 四家企业数据 ──');
  const rows = [];
  for (const u of four) {
    const t = await login(u);
    const ov = (await get('/api/enterprise/overview', t))?.data || {};
    const k = ov.kpi || {};
    rows.push({ u, name: ov.enterprise?.name, reports: k.reportTotal, verified: k.reportVerified, ytd: k.emissionYtd, anchors: k.chainAnchors });
    /* 2026-10-30 起 ent 66 多一份 2026Q1（SUBMITTED 流转中）：底线是 ≥8 份且已核查 ≥8 */
    chk(`${u} 报告 ≥8 份 / 已核查 ≥8`, k.reportTotal >= 8 && k.reportVerified >= 8, `${ov.enterprise?.name} ${k.reportTotal}/${k.reportVerified}`);
  }
  console.table(rows);

  console.log('\n── 4. 存证链路 ──');
  for (const u of four) {
    const t = await login(u);
    const pg = (await get('/api/enterprise/reports', t))?.data || {};
    const list = pg.rows || pg.list || [];
    if (!list.length) { chk(`${u} 有报告`, false); continue; }
    const c = await get(`/api/enterprise/reports/${list[0].id}/chain`, t);
    const v = c?.data?.verify || {};
    chk(`${u} 存证验签`, c?.code === 0 && v.signatureValid === true,
      `块 ${c?.data?.block?.index} 数据完整 ${v.dataIntact} 链下一致 ${v.dbMatchesSnapshot} merkle ${c?.data?.merkle?.rootMatches}`);
  }

  console.log('\n── 5. 核查端 ──');
  const tv = await login('ver_cz_review');
  const vt = (await get('/api/verifier/tasks', tv))?.data;
  const vlist = vt?.list || vt?.rows || vt || [];
  chk('核查任务可见', Array.isArray(vlist) && vlist.length > 0, `${vlist.length} 条`);
  const hit4 = vlist.filter((x) => /河北恒能（保定）|瑞丰环保|易州恒新/.test(x.ent_name || '')).length;
  chk('含四家企业任务', hit4 > 0, `${hit4} 条`);
  const vr = (await get('/api/verifier/reports', tv))?.data;
  const vrlist = vr?.list || vr?.rows || vr || [];
  if (vrlist.length) {
    const c = await get(`/api/verifier/reports/${vrlist[0].id}/chain`, tv);
    chk('核查结论存证可核验', c?.code === 0 && c?.data?.verify?.signatureValid === true, `块 ${c?.data?.block?.index}`);
  }

  console.log('\n── 6. 公开看板 ──');
  const d = (await j('/api/public/dashboard'))?.data || {};
  chk('企业数 64（在册）', d.kpi?.entCount === 64, `${d.kpi?.entCount}`);
  chk('省份覆盖', d.kpi?.regionCount > 0, `${d.kpi?.regionCount} 省`);
  chk('链上存证', d.chain?.totalTxs > 0, `${d.chain?.totalTxs} 笔 / ${d.chain?.totalBlocks} 块`);
  /* reportCount 是「本年度（2025）非草稿上报单」口径，不是全库累计 */
  chk('2025 年度上报单', d.kpi?.reportCount > 0, `${d.kpi?.reportCount} 份`);

  console.log(`\n结果：\x1b[32m${pass} 通过\x1b[0m · ${fail ? `\x1b[31m${fail} 失败\x1b[0m` : '0 失败'}\n`);
  process.exit(fail ? 1 : 0);
})();
