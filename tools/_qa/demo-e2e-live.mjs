/**
 * 线上演示号全流程验证（www / Cloudflare Pages Functions + Turso）
 * ------------------------------------------------------------------
 * 对每个演示角色跑一遍真实业务闭环，断言写在响应上：
 *   admin   因子库 → 发布上链 → 对账
 *   reg001  配额下发（上链）→ 预警处置
 *   ent001  上报（上链）→ 查存证 Merkle 证明 → 交易下单 → 撤单
 *   ver001  接单 → 出具结论（上链）
 *   trader  下单撮合 → 账户 → 成交记录 → 撤单
 * 全部通过才算"演示号无断头路"。
 *
 * 用法：node tools/_qa/demo-e2e-live.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'https://www.carbonchain.dpdns.org';
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

async function login(username, password) {
  const r = await call('/api/auth/login', { method: 'POST', body: { username, password } });
  if (r.status !== 200 || !r.json?.data?.token) {
    throw new Error(`登录失败 ${username}: ${r.status} ${r.json?.msg || ''}`);
  }
  return r.json.data;
}

console.log(`\n=== 线上演示号全流程 · ${BASE} ===\n`);

/* ---------------- 1. 五个角色登录 ---------------- */
console.log('[1] 演示账号登录');
const accounts = [
  ['admin', 'admin123'], ['reg001', '123456'], ['ent001', '123456'],
  ['ver001', '123456'], ['trader01', '123456'],
];
const S = {};
for (const [u, p] of accounts) {
  try {
    const d = await login(u, p);
    S[u] = d;
    check(`登录 ${u}`, true, `${d.user?.role} / ${d.user?.name || ''}`);
  } catch (e) { check(`登录 ${u}`, false, String(e.message).slice(0, 80)); }
}

/* ---------------- 2. 各角色核心页面数据 ---------------- */
console.log('\n[2] 角色核心接口');
const roleApi = {
  admin: ['/api/admin/overview', '/api/admin/factors', '/api/admin/factor-versions', '/api/admin/reconciliations'],
  reg001: ['/api/regulator/overview', '/api/regulator/enterprises', '/api/regulator/alerts',
    '/api/regulator/allocations', '/api/regulator/statistics'],
  ent001: ['/api/enterprise/overview', '/api/enterprise/reports', '/api/enterprise/quota',
    '/api/enterprise/wallet', '/api/enterprise/analytics', '/api/trade/account'],
  ver001: ['/api/verifier/overview', '/api/verifier/tasks', '/api/verifier/reports', '/api/verifier/wallet'],
  trader01: ['/api/trade/account', '/api/trade/deals', '/api/trade/market', '/api/trade/orderbook'],
};
for (const [u, eps] of Object.entries(roleApi)) {
  const tok = S[u]?.token;
  if (!tok) { check(`${u} 接口集`, false, '无 token'); continue; }
  let okN = 0;
  for (const ep of eps) {
    const r = await call(ep, { token: tok });
    if (r.status === 200 && r.json?.code === 0) okN++;
    else console.log(`      · ${ep} → ${r.status} ${r.json?.msg || ''}`);
  }
  check(`${u} 核心接口 ${okN}/${eps.length}`, okN === eps.length, okN === eps.length ? '' : '有失败项');
}

/* ---------------- 3. 链上：三端口径 + 单笔存证 ---------------- */
console.log('\n[3] 统一链核验');
const stats = await call('/api/chain/stats');
const miniStats = await (await fetch("https://api.carbonchain.dpdns.org/mini/v1/chain/stats", { signal: AbortSignal.timeout(30000) })).json().then((j) => ({ status: 200, json: j })).catch(() => ({ status: 0, json: null }));
const wwwH = stats.json?.data?.height, miniH = miniStats.json?.data?.height;
check('www 与小程序的链顶一致', wwwH !== undefined && wwwH === miniH, `www #${wwwH} / mini #${miniH}`);

const blocks = await call('/api/chain/blocks?page=1&size=1');
const tip = blocks.json?.data?.rows?.[0];
check('区块列表可取', !!tip, tip ? `#${tip.height}` : '');

const txs = await call('/api/chain/txs?page=1&size=1');
const tx0 = txs.json?.data?.rows?.[0];
check('存证列表可取', !!tx0, tx0 ? `${tx0.txType} @#${tx0.height}` : '');
if (tx0?.txId) {
  const td = await call('/api/chain/tx/' + tx0.txId);
  check('单笔存证详情（哈希复算）', td.status === 200 && td.json?.data?.payloadIntact === true,
    td.json?.data ? `payloadIntact=${td.json.data.payloadIntact}` : `${td.status}`);
}

/* ---------------- 4. admin：因子发布上链 + 对账 ---------------- */
console.log('\n[4] 管理员闭环');
if (S.admin) {
  const ver = 'v2026.qa' + Date.now().toString().slice(-4);
  const pub = await call('/api/admin/factors/publish', {
    method: 'POST', token: S.admin.token, body: { version: ver },
  });
  check('发布因子版本并上链', pub.status === 200 && pub.json?.data?.chain?.blockIndex >= 0,
    pub.json?.data ? `#${pub.json.data.chain?.blockIndex}` : `${pub.status} ${pub.json?.msg || ''}`);

  const rec = await call('/api/admin/reconcile', { method: 'POST', token: S.admin.token, body: {} });
  check('业务行↔链上摘要对账', rec.status === 200,
    rec.json?.data ? `核对 ${rec.json.data.total} 笔，不一致 ${rec.json.data.inconsistent}` : `${rec.status}`);
}

/* ---------------- 5. reg001：配额下发上链 ---------------- */
console.log('\n[5] 监管闭环');
if (S.reg001) {
  const alloc = await call('/api/regulator/allocations', {
    method: 'POST', token: S.reg001.token,
    body: { entId: 3, year: 2026, amount: 1000, allocType: 'FREE', allocMethod: '历史强度法' },
  });
  check('配额下发并上链', alloc.status === 200 && alloc.json?.data?.chain?.blockIndex >= 0,
    alloc.json?.data ? `${alloc.json.data.allocNo} @#${alloc.json.data.chain.blockIndex}` : `${alloc.status} ${alloc.json?.msg || ''}`);
}

/* ---------------- 6. ent001：上报 → 存证 → 交易 ---------------- */
console.log('\n[6] 企业闭环');
if (S.ent001) {
  const before = (await call('/api/chain/stats')).json?.data?.height;
  /* 用一个未上报过的季度：先查已上报期次，挑一个空档 */
  const reps = await call('/api/enterprise/reports?size=50', { token: S.ent001.token });
  const used = new Set((reps.json?.data?.rows || []).map((r) => `${r.year}Q${r.quarter}`));
  let period = null;
  for (const y of [2026, 2025]) {
    for (const q of [4, 3, 2, 1]) {
      if (!used.has(`${y}Q${q}`)) { period = { year: y, quarter: q }; break; }
    }
    if (period) break;
  }
  if (!period) { check('企业上报', false, '已无空档季度可上报'); }
  else {
    const rep = await call('/api/enterprise/reports', {
      method: 'POST', token: S.ent001.token,
      body: {
        year: period.year, quarter: period.quarter, dataSource: '排放因子法', submit: true,
        items: [{ energyType: '原煤', amount: 1200 }, { energyType: '电力', amount: 350 }],
      },
    });
    const h = rep.json?.data?.chain?.blockIndex;
    check('企业上报并上链', rep.status === 200 && h >= 0,
      rep.json?.data ? `${period.year}Q${period.quarter} 总量 ${rep.json.data.total} t @#${h}` : `${rep.status} ${rep.json?.msg || ''}`);

    const after = (await call('/api/chain/stats')).json?.data?.height;
    check('写后立即读到新高度', after > before, `#${before} → #${after}`);

    if (rep.json?.data?.reportId) {
      const ch = await call(`/api/enterprise/reports/${rep.json.data.reportId}/chain`, { token: S.ent001.token });
      const d = ch.json?.data;
      check('存证详情含 Merkle 证明', ch.status === 200 && Array.isArray(d?.merkleProof),
        d ? `leafIndex=${d.leafIndex} proof=${d.merkleProof.length} 层 业务绑定=${d.verification?.businessBinding}` : `${ch.status}`);
    }
  }
}

/* ---------------- 7. ver001：接单 → 出结论上链 ---------------- */
console.log('\n[7] 核查闭环');
if (S.ver001) {
  const tasks = await call('/api/verifier/tasks?status=PENDING&size=20', { token: S.ver001.token });
  const pend = (tasks.json?.data?.rows || [])[0];
  if (!pend) {
    check('核查待办存在', false, '演示机构无待办任务');
  } else {
    check('核查待办存在', true, `${pend.taskNo || pend.id}`);
    const acc = await call(`/api/verifier/tasks/${pend.id}/accept`, { method: 'POST', token: S.ver001.token, body: {} });
    check('受理核查任务', acc.status === 200, acc.json?.msg || `${acc.status}`);
    const done = await call(`/api/verifier/tasks/${pend.id}/verify`, {
      method: 'POST', token: S.ver001.token,
      body: { conclusion: 'PASS', verifiedValue: null, opinion: '线上全流程验证：数据来源真实、核算边界清晰。' },
    });
    const bh = done.json?.data?.chain?.blockIndex;
    check('出具结论并上链', done.status === 200 && bh >= 0,
      done.json?.data ? `${done.json.data.verifyReportNo} 偏差 ${done.json.data.deviation}% @#${bh}` : `${done.status} ${done.json?.msg || ''}`);
    const again = await call(`/api/verifier/tasks/${pend.id}/verify`, {
      method: 'POST', token: S.ver001.token, body: { conclusion: 'PASS' },
    });
    check('[阴性] 重复出结论必须 409/400', again.status === 400 || again.status === 409, `实际 ${again.status}`);
  }
}

/* ---------------- 8. trader01：下单 → 撮合 → 撤单 ---------------- */
console.log('\n[8] 交易闭环');
if (S.trader01) {
  const acc0 = await call('/api/trade/account', { token: S.trader01.token });
  const cash0 = acc0.json?.data?.account?.balance;
  check('交易账户有可用资金', acc0.status === 200 && (cash0 === null || cash0 >= 0),
    `余额 ${cash0} 元 / 估值配额 ${acc0.json?.data?.quota?.available} t`);

  /* 挂一个明显不会成交的买单（价格 1 元，低于卖盘），再撤单 —— 验证冻结与退回 */
  const ord = await call('/api/trade/orders', {
    method: 'POST', token: S.trader01.token,
    body: { side: 'BUY', price: 1, amount: 10 },
  });
  const order = ord.json?.data?.order;
  check('委托下单', ord.status === 200 && !!order,
    order ? `${order.orderNo} ${order.side} 10t@1元 状态 ${order.status}` : `${ord.status} ${ord.json?.msg || ''}`);

  if (order && (order.status === 'OPEN' || order.status === 'PARTIAL')) {
    const acc1 = await call('/api/trade/account', { token: S.trader01.token });
    check('买单冻结资金', (acc1.json?.data?.account?.frozen || 0) >= 10,
      `冻结 ${acc1.json.data.account.frozen} 元`);
    const cancel = await call(`/api/trade/orders/${order.id}/cancel`, { method: 'POST', token: S.trader01.token, body: {} });
    check('撤单并退回冻结', cancel.status === 200,
      cancel.json?.data ? `退回 ${cancel.json.data.releasedFunds} 元` : `${cancel.status} ${cancel.json?.msg || ''}`);
  }

  const deals = await call('/api/trade/deals', { token: S.trader01.token });
  check('成交记录可取', deals.status === 200 && Array.isArray(deals.json?.data),
    `${deals.json?.data?.length ?? 0} 笔`);
}

/* ---------------- 9. 越权与边界（阴性对照） ---------------- */
console.log('\n[9] 越权与边界');
const noTok = await call('/api/enterprise/overview');
check('[阴性] 无 token 访问企业端必须 401', noTok.status === 401, `实际 ${noTok.status}`);

if (S.ver001) {
  const cross = await call('/api/enterprise/overview', { token: S.ver001.token });
  check('[阴性] 核查端 token 访问企业端必须 403', cross.status === 403, `实际 ${cross.status}`);
}
if (S.ent001) {
  const bad = await call('/api/enterprise/reports', {
    method: 'POST', token: S.ent001.token,
    body: { year: 2026, quarter: 1, items: [{ energyType: '原煤', amount: 0 }] },
  });
  check('[阴性] 零消耗量必须 400', bad.status === 400, `实际 ${bad.status}`);
  const dup = await call('/api/enterprise/reports', {
    method: 'POST', token: S.ent001.token,
    body: { year: 2026, quarter: 1, submit: false, items: [{ energyType: '原煤', amount: 100 }] },
  });
  check('[阴性] 重复季度上报必须 400', dup.status === 400, `实际 ${dup.status} ${dup.json?.msg || ''}`);
}

console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ${fail ? `｜失败 ${fail} 项` : ''} ===`);
if (failures.length) console.log('失败项：\n  ' + failures.join('\n  '));
process.exit(fail ? 1 : 0);
