#!/usr/bin/env node
/**
 * tools/_probe-bugs.mjs —— 逐条核实 BUG清单-20261029 的当前状态
 * 只读探针：不做任何写操作。输出「仍存在 / 已修复」判定，供修复前后对照。
 */
const BASE = 'http://127.0.0.1:8300';
const j = async (p, opt = {}) => { const r = await fetch(BASE + '/api' + p, opt); const t = await r.text(); try { return JSON.parse(t); } catch { return { code: r.status, raw: t.slice(0, 100) }; } };
const post = (p, b) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const get = async (p, tk) => {
  const r = await j(p, { headers: tk ? { authorization: `Bearer ${tk}` } : {} });
  if (r.code !== 0) console.log(`  !! ${p} -> code=${r.code} ${r.message || r.raw || ''}`);
  return r;
};
const login = async (u, p = '123456') => {
  const r = await post('/auth/login', { username: u, password: p });
  if (!r?.data?.token) console.log(`  !! login ${u} -> ${JSON.stringify(r).slice(0, 120)}`);
  return r?.data?.token;
};
const out = (id, title, obj) => console.log(`\n[${id}] ${title}\n  ${JSON.stringify(obj)}`);

(async () => {
  const T = {
    reg: await login('reg001'), ent: await login('ent_zjbd'), ver: await login('ver001'),
    tr: await login('trader01'), adm: await login('admin', 'admin123'),
  };

  /* ── P0-1 / P0-4 / P0-9：企业端配额口径 ── */
  const eov = (await get('/enterprise/overview', T.ent))?.data || {};
  out('P0-1', '企业端履约缺口', { reportYear: eov.reportYear, kpi: eov.kpi });
  const eq = (await get('/enterprise/quota', T.ent))?.data || {};
  out('P0-9', '配额账户明细', { list: eq.list, keys: Object.keys(eq) });
  const ean = (await get('/enterprise/analytics', T.ent))?.data || {};
  out('P0-4', '企业分析 KPI', Object.keys(ean).reduce((o, k) => (o[k] = typeof ean[k] === 'object' ? '[obj]' : ean[k], o), {}));

  /* ── P0-2 / P0-3 / P0-3b：监管端年度 ── */
  const rov = (await get('/regulator/overview', T.reg))?.data || {};
  out('P0-2', '监管驾驶舱', { reportYear: rov.reportYear, kpi: rov.kpi });
  const rent = (await get('/regulator/enterprises?size=5', T.reg))?.data || {};
  out('P0-3', '企业名录首行', { rows: (rent.rows || []).slice(0, 2), year: rent.year || rent.reportYear });
  const ral = (await get('/regulator/allocations', T.reg))?.data || {};
  out('P0-3b', '配额分配管理', { total: ral.total, rows: (ral.rows || []).length, year: ral.year });

  /* ── P0-5：联盟链副本高度 ── */
  const cn = (await get('/consortium/nodes', T.reg))?.data || {};
  out('P0-5', '联盟链节点', cn);

  /* ── P0-7：区块时间 ── */
  const bl = (await get('/chain/blocks?size=3'))?.data || {};
  out('P0-7', '最近区块时间', (bl.rows || []).slice(0, 3).map((b) => ({ i: b.block_index, t: b.block_time })));

  /* ── P0-8：活动数据单位 ── */
  const act = (await get('/mrv/activity?size=3', T.ent))?.data || {};
  out('P0-8', '活动数据单位', { rows: (act.rows || []).slice(0, 2), unit: act.unit, total: act.total });

  /* ── P0-10：原煤因子两处取值 ── */
  const fa = (await get('/mrv/factor', T.ent))?.data || {};
  const admOv = (await get('/admin/overview', T.adm))?.data || {};
  out('P0-10', '原煤因子', {
    mrv: (fa.rows || fa.list || []).filter((r) => /原煤/.test(r.name || r.factor_name || '')).slice(0, 3),
    adminCurrent: admOv.currentFactors || admOv.factors || null,
  });

  /* ── P0-13：mine_time ── */
  const st = (await get('/chain/stats'))?.data || {};
  out('P0-13', '链统计', st);

  /* ── P1-31：核查端存证 ── */
  const vov = (await get('/verifier/overview', T.ver))?.data || {};
  out('P1-31', '核查端概览', vov.kpi || vov);

  /* ── P1-15：交易盘口 ── */
  const mk = (await get('/trade/market', T.tr))?.data || {};
  out('P1-15', '交易行情', { days: (mk.trend || mk.kline || []).length, asks: (mk.asks || []).length, bids: (mk.bids || []).length });
})();
