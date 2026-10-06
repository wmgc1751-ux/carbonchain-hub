/**
 * smoke-test.js —— 接口冒烟测试 / 交付自检脚本
 * ------------------------------------------------------------------
 * 依次以四种角色登录，遍历全部核心接口，逐条校验 HTTP 状态与业务 code。
 * 用法： node scripts/smoke-test.js [baseUrl]
 */
'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8300';

let pass = 0, fail = 0;
const failures = [];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, json };
}

async function check(name, method, path, opts = {}, expectCode = 0) {
  try {
    const r = await api(method, path, opts);
    const bizOk = r.json && r.json.code === expectCode;
    if (r.status < 400 && bizOk) {
      pass++;
      const size = JSON.stringify(r.json.data || {}).length;
      console.log(`  ✔ ${name.padEnd(38)} ${String(r.status).padEnd(4)} ${size}B`);
    } else {
      fail++;
      failures.push(`${name} → HTTP ${r.status} / code ${r.json && r.json.code} / ${r.json && r.json.message}`);
      console.log(`  ✘ ${name.padEnd(38)} ${r.status} ${(r.json && r.json.message) || ''}`);
    }
    return r.json;
  } catch (e) {
    fail++;
    failures.push(`${name} → ${e.message}`);
    console.log(`  ✘ ${name.padEnd(38)} ${e.message}`);
    return null;
  }
}

async function login(username, password) {
  const r = await api('POST', '/api/auth/login', { body: { username, password } });
  if (r.json && r.json.code === 0) return r.json.data;
  throw new Error(`登录失败 ${username}: ${r.json && r.json.message}`);
}

(async () => {
  console.log(`\n═══ 碳链通 CarbonChain Hub 接口自检 · ${BASE} ═══\n`);

  /* ---- 公共 ---- */
  console.log('【公共接口】');
  await check('健康检查', 'GET', '/api/health');
  await check('演示账号列表', 'GET', '/api/auth/demo-accounts');
  await check('公示大屏', 'GET', '/api/public/dashboard');
  await check('公示企业名录', 'GET', '/api/public/enterprises?page=1&size=5');
  await check('公示公告', 'GET', '/api/public/notices?page=1&size=5');
  await check('碳价行情', 'GET', '/api/public/carbon-price?days=90');

  /* ---- 区块链浏览器 ---- */
  console.log('\n【区块链浏览器】');
  await check('链概况', 'GET', '/api/chain/stats');
  await check('区块列表', 'GET', '/api/chain/blocks?page=1&size=5');

  /* 区块索引不是从 0 连续编号的（创世块的 block_index 由链的构建方式决定），
   * 因此先取列表里真实存在的区块索引，再做详情/篡改测试，避免硬编码 10 在某些
   * 重建后的链上不存在。
   * 注意：列表接口返回的是库字段 block_index，详情接口返回的才是转换后的 index。 */
  const blkList = await check('区块列表(探测索引)', 'GET', '/api/chain/blocks?page=1&size=5');
  const blkRows = (blkList && blkList.data && blkList.data.rows) || [];
  const firstRow = blkRows[0] || {};
  const probeIndex = Number(firstRow.block_index !== undefined ? firstRow.block_index : firstRow.index);
  const tamperIndex = Number.isFinite(probeIndex) ? probeIndex : 1;

  const b = await check(`区块详情(#${tamperIndex})`, 'GET', `/api/chain/blocks/${tamperIndex}`);
  await check('交易列表', 'GET', '/api/chain/txs?page=1&size=5');
  await check('交易详情', 'GET', `/api/chain/tx/${b && b.data && b.data.transactions[0] ? b.data.transactions[0].tx_id : 'x'}`);
  await check('交易池', 'GET', '/api/chain/pool');
  await check('全链完整性校验', 'GET', '/api/chain/validate');
  await check('地址存证查询', 'GET', '/api/chain/address/' + (b && b.data && b.data.transactions[0] ? b.data.transactions[0].from_address : 'x'));

  /* ---- 企业端 ---- */
  console.log('\n【企业端】');
  const ent = await login('ent001', '123456');
  const et = ent.token;
  await check('企业概览', 'GET', '/api/enterprise/overview', { token: et });
  const reports = await check('上报单列表', 'GET', '/api/enterprise/reports?page=1&size=20', { token: et });
  const rows = (reports && reports.data && reports.data.rows) || [];
  /* 挑一条【已上链】的上报单做存证详情测试：不是所有上报单都已完成上链，
   * 取第一条可能命中未上链的草稿，导致误报失败。 */
  const chained = rows.find((r) => r.chain_tx_id || r.chainTxId || r.chain_block_index !== null && r.chain_block_index !== undefined);
  const rid = (chained || rows[0] || {}).id || 1;
  await check('上报单详情', 'GET', `/api/enterprise/reports/${rid}`, { token: et });
  await check('链上存证详情', 'GET', `/api/enterprise/reports/${rid}/chain`, { token: et });
  await check('配额账户', 'GET', '/api/enterprise/quota', { token: et });
  await check('我的委托', 'GET', '/api/enterprise/orders?page=1&size=5', { token: et });
  await check('市场订单簿', 'GET', '/api/enterprise/orderbook', { token: et });
  await check('我的成交', 'GET', '/api/enterprise/deals?page=1&size=5', { token: et });
  await check('数据分析', 'GET', '/api/enterprise/analytics', { token: et });
  await check('链上身份', 'GET', '/api/enterprise/wallet', { token: et });
  await check('通知公告', 'GET', '/api/enterprise/notices?page=1&size=5', { token: et });

  // 写操作：新建上报 → 提交 → 校验上链
  // 幂等处理：同一企业同一「年度+季度」只允许一张上报单，
  // 因此先取已存在的周期，再挑一个空位（优先放在下一年度，避免污染本年演示数据）。
  const rnd = Math.floor(Math.random() * 900) + 100;
  const listed = await api('GET', '/api/enterprise/reports?page=1&size=200', { token: et });
  const myReports = (listed.json && listed.json.data && listed.json.data.rows) || [];
  const taken = new Set(myReports.map((r) => r.year + '-' + r.quarter));
  let slot = null;
  for (const y of [Number(process.env.SMOKE_YEAR) || 2027, 2028, 2029, 2030]) {
    for (const q of [1, 2, 3, 4]) {
      if (!taken.has(y + '-' + q)) { slot = { year: y, quarter: q }; break; }
    }
    if (slot) break;
  }
  if (!slot) {
    console.log('⚠ 新建并提交上报（上链）  SKIP  该企业 2027—2030 年全部季度均已有上报单');
  } else {
    const created = await check('新建并提交上报（上链）', 'POST', '/api/enterprise/reports', {
      token: et,
      body: {
        year: slot.year, quarter: slot.quarter, dataSource: '在线监测', submit: true,
        items: [{ energyType: '原煤', amount: 12000 + rnd }, { energyType: '电力', amount: 3200 + rnd }],
      },
    });
    if (created && created.data) {
      const nr = await check('新上报单链上存证核查', 'GET', `/api/enterprise/reports/${created.data.reportId}/chain`, { token: et });
      if (nr && nr.data) {
        const v = nr.data.verify;
        console.log(`     ↳ 签名验签=${v.signatureValid} 数据完整=${v.dataIntact} 链下一致=${v.dbMatchesSnapshot} 区块#${nr.data.block.index}`);
      }
    }
  }
  // 挂单撮合：故意报一个远离市场的买入价，使其无法立即成交，便于验证撤单
  const order = await check('创建挂单（进入撮合队列）', 'POST', '/api/enterprise/orders', {
    token: et, body: { side: 'BUY', price: 1, amount: 300 },
  });
  if (order && order.data && order.data.orderId) {
    await check('撤销挂单', 'POST', `/api/enterprise/orders/${order.data.orderId}/cancel`, { token: et });
  }

  /* ---- 核查机构端 ---- */
  console.log('\n【核查机构端】');
  const ver = await login('ver001', '123456');
  const vt = ver.token;
  await check('机构概览', 'GET', '/api/verifier/overview', { token: vt });
  const tasks = await check('核查任务列表', 'GET', '/api/verifier/tasks?page=1&size=5', { token: vt });
  await check('核查任务详情', 'GET', `/api/verifier/tasks/${tasks && tasks.data && tasks.data.rows[0] ? tasks.data.rows[0].id : 1}`, { token: vt });
  await check('已出具报告', 'GET', '/api/verifier/reports?page=1&size=5', { token: vt });
  await check('机构链上身份', 'GET', '/api/verifier/wallet', { token: vt });
  await check('通知公告', 'GET', '/api/verifier/notices?page=1&size=5', { token: vt });

  /* ---- 监管端 ---- */
  console.log('\n【监管端】');
  const reg = await login('reg001', '123456');
  const rt = reg.token;
  await check('监管驾驶舱', 'GET', '/api/regulator/overview', { token: rt });
  await check('企业名录', 'GET', '/api/regulator/enterprises?page=1&size=5', { token: rt });
  await check('名录筛选项', 'GET', '/api/regulator/enterprises/filters', { token: rt });
  await check('企业详情', 'GET', '/api/regulator/enterprises/1', { token: rt });
  await check('配额分配流水', 'GET', '/api/regulator/allocations?page=1&size=5', { token: rt });
  await check('交易监管', 'GET', '/api/regulator/trades?page=1&size=5', { token: rt });
  await check('预警中心', 'GET', '/api/regulator/alerts?page=1&size=5', { token: rt });
  await check('统计分析', 'GET', '/api/regulator/statistics', { token: rt });
  await check('操作审计', 'GET', '/api/regulator/logs?page=1&size=5', { token: rt });
  await check('系统概况', 'GET', '/api/regulator/system', { token: rt });
  await check('公告管理', 'GET', '/api/regulator/notices?page=1&size=5', { token: rt });
  await check('下发配额（上链）', 'POST', '/api/regulator/allocations', {
    token: rt, body: { entId: 2, year: 2026, amount: 1000, allocType: 'FREE', allocMethod: '行业基准线法', baseline: 1.25 },
  });

  /* ---- 篡改演示 ---- */
  console.log('\n【区块链防篡改演示】');
  const t1 = await check(`模拟篡改区块 #${tamperIndex}`, 'POST', '/api/chain/tamper', { token: rt, body: { blockIndex: tamperIndex, field: 'merkle_root' } });
  if (t1 && t1.data) {
    console.log(`     ↳ 篡改后校验：valid=${t1.data.validation.valid} 异常数=${t1.data.validation.errors.length}`);
    console.log(`     ↳ 首条异常：${t1.data.validation.errors[0] ? t1.data.validation.errors[0].message : '-'}`);
  }
  const t2 = await check('修复链（重做 PoW）', 'POST', '/api/chain/repair', { token: rt, body: { fromIndex: tamperIndex } });
  if (t2 && t2.data) {
    console.log(`     ↳ 修复 ${t2.data.repaired.length} 个区块，重做工作量证明总耗时 ${t2.data.repaired.reduce((a, b) => a + b.cost, 0)}ms`);
    console.log(`     ↳ 修复后校验：valid=${t2.data.validation.valid} 异常数=${t2.data.validation.errors.length}`);
    console.log(`     ↳ 注意：重算后整条后缀的区块哈希已全部改变 —— 这说明篡改"成本极高且可被全网察觉"`);
  }

  console.log('\n' + '═'.repeat(64));
  console.log(`  测试用例 ${pass + fail} 条 · 通过 ${pass} · 失败 ${fail}`);
  if (failures.length) {
    console.log('  失败明细：');
    failures.forEach((f) => console.log('    - ' + f));
  } else {
    console.log('  ✅ 全部接口自检通过');
  }
  console.log('═'.repeat(64) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
