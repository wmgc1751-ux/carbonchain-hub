/* 临时核实脚本：逐项检查 BUG 清单 P0 数据口径问题的接口现状 */
const BASE = 'http://127.0.0.1:8300';
const j = async (p, T) => { const r = await fetch(BASE + p, T ? { headers: { Authorization: 'Bearer ' + T } } : undefined); const x = await r.json().catch(() => null); return { status: r.status, code: x && x.code, msg: x && x.message, d: x && x.data }; };
const login = async (u, p) => (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).data.token;

const sec = (t) => console.log('\n════ ' + t + ' ════');
const out = (label, v) => console.log(label, JSON.stringify(v));

(async () => {
  const ENT = await login('ent_zjbd', '123456');
  const REG = await login('reg001', '123456');
  const ADM = await login('admin', 'admin123');
  const TRD = await login('trader01', '123456');

  sec('P0-1 /api/enterprise/overview（履约缺口/配额）');
  {
    const { d } = await j('/api/enterprise/overview', ENT);
    const pick = {};
    for (const k of Object.keys(d || {})) { const v = d[k]; if (v && typeof v === 'object' && !Array.isArray(v)) pick[k] = v; else pick[k] = v; }
    out('keys', Object.keys(d || {}));
    for (const k of ['quota', 'compliance', 'emission', 'year', 'gap']) if (d && d[k] !== undefined) out(k, d[k]);
  }

  sec('P0-2 /api/regulator/overview（监管驾驶舱）');
  {
    const { d } = await j('/api/regulator/overview', REG);
    out('all', d);
  }

  sec('P0-3 /api/regulator/enterprises');
  {
    const { d } = await j('/api/regulator/enterprises?page=1&pageSize=8', REG);
    const rows = (d && (d.rows || d.list || d.items)) || d;
    if (Array.isArray(rows)) out('first2', rows.slice(0, 2)); else out('shape', d);
  }

  sec('P0-3b /api/regulator/allocations 年度参数');
  {
    const a = await j('/api/regulator/allocations?year=2026', REG);
    const b = await j('/api/regulator/allocations?year=2024', REG);
    out('2026', typeof a.d === 'object' ? Object.keys(a.d) : a.d);
    out('2026.summary', a.d && (a.d.summary || a.d.stats));
    out('2024.summary', b.d && (b.d.summary || b.d.stats));
  }

  sec('P0-4 /api/enterprise/analytics KPI');
  {
    const { d } = await j('/api/enterprise/analytics', ENT);
    out('keys', d && Object.keys(d));
    out('kpi-ish', d && { quota: d.quota, used: d.used, balance: d.balance, allowance: d.allowance });
  }

  sec('P0-5 /api/consortium/* 副本高度口径');
  {
    const a = await j('/api/consortium/overview', REG);
    out('overview', a.d);
    const b = await j('/api/consortium/nodes', REG);
    out('nodes', b.d);
  }

  sec('P0-6 /api/enterprise/predict');
  {
    const { d } = await j('/api/enterprise/predict', ENT);
    out('all', d);
  }

  sec('P0-7 /api/chain/blocks block_time 格式');
  {
    const { d } = await j('/api/chain/blocks?page=1&pageSize=3', TRD);
    out('rows', d && (d.rows || d.blocks || d.list || d).toString().slice(0, 100));
    const arr = d && (d.rows || d.blocks || d.list || d);
    if (Array.isArray(arr)) out('block_time[0]', arr[0].block_time || arr[0].time || arr[0].timestamp);
    const s = await j('/api/chain/stats', TRD);
    out('stats', s.d);
  }

  sec('P0-9 /api/enterprise/quota 明细');
  {
    const { d } = await j('/api/enterprise/quota', ENT);
    out('all', d);
  }

  sec('P0-10 /api/mrv/factors vs admin factors');
  {
    const a = await j('/api/mrv/factors');
    const arr = a.d && (a.d.rows || a.d.list || a.d);
    if (Array.isArray(arr)) out('coal', arr.filter((x) => /原煤|coal/i.test(x.name || x.factor_name || '')).slice(0, 3)); else out('shape', a.d);
    const b = await j('/api/admin/factors', ADM);
    const brr = b.d && (b.d.rows || b.d.list || b.d);
    if (Array.isArray(brr)) out('admin.coal', brr.filter((x) => /原煤|coal/i.test(x.name || x.factor_name || '')).slice(0, 3)); else out('admin.shape', b.d);
  }

  sec('P0-13 出块耗时 mine_time');
  {
    const s = await j('/api/chain/stats', TRD);
    out('stats', s.d);
    const m = await j('/api/chain/metrics', TRD).catch(() => null);
    out('metrics', m && m.d);
  }

  sec('P1-31 /api/verifier/overview');
  {
    const VER = await login('ver001', '123456');
    const { d } = await j('/api/verifier/overview', VER);
    out('all', d);
  }
})().catch((e) => console.error('FATAL', e));
