/* 一次性探针（2026-10-30）：验证企业端「一个主账号走通全流程」。
 * 只做只读请求与无副作用的核算预览，不写任何业务数据。 */
const BASE = 'http://127.0.0.1:8300';

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'ent_zjbd', password: '123456' }),
}).then((r) => r.json());

if (login.code !== 0) { console.error('登录失败：', login.message); process.exit(1); }
const tk = login.data.token;
const u = login.data.user;
console.log(`登录：${u.username} · ${u.orgName} · role=${u.role} · post=${u.post}`);
const H = { Authorization: `Bearer ${tk}` };

const CASES = [
  ['企业总览',        'GET',  '/api/enterprise/overview'],
  ['上报单列表',      'GET',  '/api/enterprise/reports?page=1&pageSize=5'],
  ['配额账户',        'GET',  '/api/enterprise/quota'],
  ['排放分析',        'GET',  '/api/enterprise/analytics'],
  ['绿色电力/钱包',   'GET',  '/api/enterprise/wallet'],
  ['MRV 填报数据',    'GET',  '/api/mrv/activity?page=1&pageSize=5'],
  ['核算预览(无副作用)', 'POST', '/api/mrv/calc/preview', { entId: 65, year: 2025, activityEmissions: [{ factorCode: 'N2O_WASTE_INCIN', activityValue: 100 }] }],
  ['清缴单列表',      'GET',  '/api/settlement/surrender'],
  ['结算账户',        'GET',  '/api/settlement/account'],
  ['交易行情/挂单',    'GET',  '/api/trade/orders'],
  ['交易授权(席位)',   'GET',  '/api/trade/mandates'],
];

let pass = 0, failCount = 0;
for (const [name, method, path, body] of CASES) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method, headers: { ...H, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    const okFlag = r.status === 200 && j.code === 0;
    const hint = j.data && Array.isArray(j.data.items) ? `（${j.data.total ?? j.data.items.length} 行）`
      : j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? '' : '';
    console.log(`${okFlag ? '✔' : '✘'} ${name.padEnd(12)} ${r.status} ${j.message || ''}${hint}`);
    okFlag ? pass++ : failCount++;
  } catch (e) {
    console.log(`✘ ${name} 异常：${e.message}`); failCount++;
  }
}
console.log(`\n结果：${pass} 通过 / ${failCount} 失败 —— ${failCount ? '有接口单账号走不通' : '单一主账号可走通企业端全部关键接口'}`);
