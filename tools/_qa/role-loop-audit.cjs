#!/usr/bin/env node
/**
 * tools/_qa/role-loop-audit.cjs —— 五角色职能闭环审计
 * ==================================================================
 * 逐个角色跑完整业务链路，记录每一步是否可执行、断在哪。
 * 只读为主（写操作仅限无副作用或有幂等保护的演示动作）。
 */
'use strict';
const http = require('http');
function req(m, p, body, tok) {
  return new Promise((r) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (tok) h.Authorization = 'Bearer ' + tok;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    const q = http.request({ host: '127.0.0.1', port: 8300, path: p, method: m, headers: h, timeout: 25000 }, (res) => {
      let s = ''; res.on('data', (c) => (s += c));
      res.on('end', () => { try { r({ status: res.statusCode, j: JSON.parse(s) }); } catch { r({ status: res.statusCode, raw: s.slice(0, 120) }); } });
    });
    q.on('timeout', () => { q.destroy(); r({ status: 0, raw: 'timeout' }); });
    q.on('error', (e) => r({ status: 0, raw: e.message }));
    if (d) q.write(d); q.end();
  });
}
const lg = async (u, pw) => {
  const x = await req('POST', '/api/auth/login', { username: u, password: pw });
  return x.j && x.j.data ? x.j.data.token : null;
};

const results = [];
function step(role, name, r, expect) {
  const ok = expect ? (r.status === expect) : (r.status === 200 && (!r.j || r.j.code === 0));
  results.push({ role, name, status: r.status, ok, msg: (r.j && r.j.message) || r.raw || '' });
  return ok;
}

(async () => {
  console.log('\n════ 五角色职能闭环审计 ════\n');

  /* ── 企业端 ── */
  {
    const t = await lg('ent_zjbd', '123456');
    const R = 'ENTERPRISE';
    console.log(`【${R}】河北恒能（保定）`);
    step(R, '登录', { status: t ? 200 : 401 }, 200);
    const ov = await req('GET', '/api/enterprise/overview', null, t); step(R, '① 企业总览', ov);
    const rep = await req('GET', '/api/enterprise/reports', null, t); step(R, '② 上报单列表', rep);
    const q = await req('GET', '/api/enterprise/quota', null, t); step(R, '③ 配额账户', q);
    const w = await req('GET', '/api/enterprise/wallet', null, t); step(R, '④ 链上身份', w);
    const cr = await req('GET', '/api/credit/status?entId=65', null, t); step(R, '⑤ 碳信用', cr);
    const ord = await req('GET', '/api/trade/orders', null, t); step(R, '⑥ 我的委托单', ord);
    const acc = await req('GET', '/api/trade/account', null, t); step(R, '⑦ 交易账户', acc);
    const mr = await req('GET', '/api/mrv/activity', null, t); step(R, '⑧ 活动数据', mr);
    const man = await req('GET', '/api/mandate/mine', null, t); step(R, '⑨ 代理授权', man);
    const dis = await req('GET', '/api/disclosure/consent', null, t); step(R, '⑩ 公示授权', dis);

    /* 写操作可行性（不实际提交，只探测必填校验是否可达） */
    const create = await req('POST', '/api/enterprise/reports', {}, t);
    results.push({ role: R, name: '⑪ 创建上报单（探测参数校验）', status: create.status, ok: create.status === 400 || create.status === 200, msg: (create.j && create.j.message) || '' });
  }

  /* ── 监管端 ── */
  {
    const t = await lg('reg001', '123456');
    const R = 'REGULATOR';
    console.log(`【${R}】省生态环境厅`);
    step(R, '登录', { status: t ? 200 : 401 }, 200);
    step(R, '① 监管驾驶舱', await req('GET', '/api/regulator/overview', null, t));
    step(R, '② 企业名录', await req('GET', '/api/regulator/enterprises', null, t));
    step(R, '③ 配额分配台账', await req('GET', '/api/regulator/allocations', null, t));
    step(R, '④ 预警处置', await req('GET', '/api/regulator/alerts', null, t));
    step(R, '⑤ 证据链', await req('GET', '/api/regulator/evidence-chain?entId=65&year=2026', null, t));
    step(R, '⑥ 代理授权台账', await req('GET', '/api/mandate/ledger', null, t));
    step(R, '⑦ 内控治理-冲突巡检', await req('GET', '/api/integrity/conflicts', null, t));
    step(R, '⑧ 公示覆盖率', await req('GET', '/api/disclosure/coverage', null, t));
    step(R, '⑨ 系统状况', await req('GET', '/api/regulator/system', null, t));
    step(R, '⑩ 审计日志', await req('GET', '/api/regulator/logs', null, t));
  }

  /* ── 核查端 ── */
  {
    const t1 = await lg('ver001', '123456');
    const t2 = await lg('ver_clerk', '123456');
    const t3 = await lg('ver_review', '123456');
    const R = 'VERIFIER';
    console.log(`【${R}】河北省绿链核查 + 大连碳中和（含录入/审核双岗位）`);
    step(R, '登录(ver001)', { status: t1 ? 200 : 401 }, 200);
    step(R, '登录(ver_clerk)', { status: t2 ? 200 : 401 }, 200);
    step(R, '登录(ver_review)', { status: t3 ? 200 : 401 }, 200);
    step(R, '① 核查工作台', await req('GET', '/api/verifier/overview', null, t1));
    step(R, '② 待办任务', await req('GET', '/api/verifier/tasks', null, t1));
    step(R, '③ 核查报告台账', await req('GET', '/api/verifier/reports', null, t1));
    step(R, '④ 机构链上身份', await req('GET', '/api/verifier/wallet', null, t1));
    step(R, '⑤ 待复核结论', await req('GET', '/api/integrity/pending-approvals', null, t2));
    /* 录入员越权审核应被拒 */
    const bad = await req('GET', '/api/regulator/overview', null, t2);
    results.push({ role: R, name: '⑥ 录入员访问监管接口（应403）', status: bad.status, ok: bad.status === 403, msg: '' });
  }

  /* ── 交易端 ── */
  {
    const t = await lg('trader01', '123456');
    const R = 'TRADER';
    console.log(`【${R}】碳资产交易服务中心`);
    step(R, '登录', { status: t ? 200 : 401 }, 200);
    step(R, '① 市场行情', await req('GET', '/api/trade/market', null, t));
    step(R, '② 盘口', await req('GET', '/api/trade/orderbook', null, t));
    step(R, '③ 授给我的授权', await req('GET', '/api/mandate/granted-to-me', null, t));
    step(R, '④ 代理账户(ent65)', await req('GET', '/api/trade/account?entId=65', null, t));
    step(R, '⑤ 代理委托单', await req('GET', '/api/trade/orders?entId=65', null, t));
    /* 未授权企业应被拒 */
    const noAuth = await req('GET', '/api/trade/account?entId=70', null, t);
    results.push({ role: R, name: '⑥ 未授权企业(ent70)（应403）', status: noAuth.status, ok: noAuth.status === 403, msg: (noAuth.j && noAuth.j.message || '').slice(0, 50) });
  }

  /* ── 管理端 ── */
  {
    const t = await lg('admin', 'admin123');
    const R = 'ADMIN';
    console.log(`【${R}】平台管理`);
    step(R, '登录', { status: t ? 200 : 401 }, 200);
    step(R, '① 管理总览', await req('GET', '/api/admin/overview', null, t));
    step(R, '② 因子库', await req('GET', '/api/admin/factors', null, t));
    step(R, '③ 因子版本', await req('GET', '/api/admin/factor-versions', null, t));
    step(R, '④ 对账中心', await req('GET', '/api/admin/reconciliations', null, t));
    step(R, '⑤ 用户与权限', await req('GET', '/api/admin/verifier-registrations', null, t));
    step(R, '⑥ 运维监控', await req('GET', '/api/regulator/system', null, t));
    step(R, '⑦ 审计锚定', await req('GET', '/api/integrity/audit-anchors', null, t));
    /* 业务接口应被拒 */
    const biz = await req('POST', '/api/regulator/allocations', { entId: 65, year: 2026, amount: 100 }, t);
    results.push({ role: R, name: '⑧ 业务决策-配额分配（应403）', status: biz.status, ok: biz.status === 403, msg: '' });
  }

  /* ── 输出 ── */
  console.log('\n════ 结果 ════\n');
  const byRole = {};
  results.forEach((r) => { (byRole[r.role] = byRole[r.role] || []).push(r); });
  for (const [role, list] of Object.entries(byRole)) {
    const okN = list.filter((x) => x.ok).length;
    console.log(`${role}: ${okN}/${list.length} 通过`);
    list.filter((x) => !x.ok).forEach((x) => console.log(`   ✘ ${x.name} → ${x.status} ${x.msg.slice(0, 70)}`));
  }
  const totalOk = results.filter((x) => x.ok).length;
  console.log(`\n合计 ${totalOk}/${results.length}`);
  require('fs').writeFileSync('tools/out/role-loop-audit.json', JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log('已写出 tools/out/role-loop-audit.json');
})();
