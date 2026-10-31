/**
 * _probe-mrv.mjs —— 单进程 API 探针（启动服务 → 逐端点验证 → 关闭）
 * ==================================================================================
 * 为什么必须这样写：本环境的沙箱会在 shell 结束时回收后台进程，
 * `node app.js &` 起的服务在下一个命令里就已经死了（curl 返回空）。
 * 因此所有需要 HTTP 的验证都必须放在同一个进程内完成。
 *
 * 用法：node tools/_probe-mrv.mjs [--keep]
 *   --keep  跑完不关服务（供人工在浏览器查看，仅限本地调试）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.PROBE_PORT || 8399);
const BASE = `http://127.0.0.1:${PORT}`;

/* ---- 启动服务（子进程，继承环境） ---- */
const child = spawn(process.execPath, ['server/app.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    INSTANCE_LOCK: '0',          // 测试探针子实例：豁免单实例互斥
    CEMS_INTERVAL_MS: '86400000',
    HJ212_AUTOSTART: '0',        // 探针不需要 TCP 9100，避免端口冲突
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let srvLog = '';
child.stdout.on('data', (d) => { srvLog += d.toString(); });
child.stderr.on('data', (d) => { srvLog += d.toString(); });

const results = [];
const push = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function waitUp(maxMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 未起来 */ }
    await sleep(500);
  }
  return false;
}

async function api(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: r.status, body };
}

async function login(username, password) {
  const r = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200) throw new Error(`登录失败 ${username}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.data.token;
}

async function main() {
  const up = await waitUp();
  if (!up) {
    console.error('✘ 服务未能在 40s 内启动');
    console.error(srvLog.slice(-3000));
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log(`服务已就绪 @ ${BASE}\n${'─'.repeat(70)}`);

  try {
    /* ---- 1. 健康检查 ---- */
    const h = await api('/api/health');
    push('健康检查', h.status === 200 && h.body.data && h.body.data.status === 'UP',
      `高度=${h.body.data && h.body.data.chainHeight}`);

    /* ---- 2. 登录（五种角色） ---- */
    const tok = {};
    for (const [u, p] of [['ent001', '123456'], ['ver001', '123456'], ['reg001', '123456'], ['admin', 'admin123']]) {
      try { tok[u] = await login(u, p); } catch (e) { push(`登录 ${u}`, false, e.message); }
    }
    push('四种角色登录', Object.keys(tok).length === 4, Object.keys(tok).join(','));

    /* ---- 3. 方法学自检（公开） ---- */
    const ms = await api('/api/mrv/factor/selftest');
    push('方法学自检（公开）', ms.status === 200 && ms.body.data.passed === ms.body.data.total,
      ms.status === 200 ? `${ms.body.data.passed}/${ms.body.data.total}` : JSON.stringify(ms.body).slice(0, 200));

    /* ---- 4. 不确定度自检（公开） ---- */
    const uqs = await api('/api/mrv/quality/uq-selftest');
    push('不确定度自检（公开）', uqs.status === 200 && uqs.body.data.passed === uqs.body.data.total,
      uqs.status === 200 ? `${uqs.body.data.passed}/${uqs.body.data.total}` : JSON.stringify(uqs.body).slice(0, 200));

    /* ---- 5. 因子台账（公开，含复算明细） ---- */
    const fac = await api('/api/mrv/factor');
    const facItems = (fac.body.data && fac.body.data.items) || [];
    const fuelItems = facItems.filter((x) => x.category === 'FUEL');
    push('因子台账公开可读', fac.status === 200 && facItems.length >= 20, `${facItems.length} 条`);
    push('燃料因子带三要素复算明细', fuelItems.length > 0 && fuelItems.every((x) => x.derivation && x.derivation.ok),
      `${fuelItems.length} 条全部复算通过`);
    push('区域电网因子差异化', facItems.filter((x) => x.code === 'POWER' && x.region).length >= 7,
      `${facItems.filter((x) => x.code === 'POWER' && x.region).length} 个区域`);

    /* ---- 6. 活动数据台账 ---- */
    const act = await api('/api/mrv/activity?year=2026', { headers: { Authorization: `Bearer ${tok.ent001}` } });
    push('活动数据台账可读', act.status === 200 && act.body.data.count > 0,
      `${act.body.data ? act.body.data.count : 0} 条`);
    push('活动数据按来源分级', act.status === 200 && act.body.data.records.some((r) => r.dataOrigin === 'L3'),
      act.status === 200 ? `L0 条数 ${act.body.data.summary.l0Count}` : '');

    /* ---- 7. ⭐ 核算试算 ---- */
    const preview = await api('/api/mrv/calc/preview', {
      method: 'POST', headers: { Authorization: `Bearer ${tok.ent001}` },
      body: JSON.stringify({ year: 2026 }),
    });
    const pv = preview.body.data || {};
    push('核算试算', preview.status === 200 && pv.total > 0,
      preview.status === 200 ? `${pv.total} tCO₂e，完整=${pv.complete}，可履约=${pv.usableForCompliance}` : JSON.stringify(preview.body).slice(0, 300));
    push('核算给出 U95 区间', pv.uncertainty && pv.uncertainty.u95Rel !== null,
      pv.uncertainty ? `uc=${pv.uncertainty.ucRel} U95=${pv.uncertainty.u95Rel} k=${pv.uncertainty.k}` : 'N/A');
    push('核算给出分源可核对明细', Array.isArray(pv.rows) && pv.rows.length > 0,
      `${(pv.rows || []).length} 个排放源`);
    push('核算给出可复算摘要', !!(pv.inputDigest && pv.resultDigest),
      pv.inputDigest ? `in=${pv.inputDigest.slice(0, 12)}… out=${pv.resultDigest.slice(0, 12)}…` : 'N/A');
    push('不确定度双路径互证', pv.uncertainty && pv.uncertainty.crossValidation && pv.uncertainty.crossValidation.verdict === 'CONSISTENT',
      pv.uncertainty && pv.uncertainty.crossValidation ? pv.uncertainty.crossValidation.verdict : 'N/A');
    push('先验敏感性闸门', pv.uncertainty && pv.uncertainty.priorGate,
      pv.uncertainty && pv.uncertainty.priorGate ? pv.uncertainty.priorGate.status : 'N/A');

    /* ---- 8. 核算落库 + 复算校验 ---- */
    const calc = await api('/api/mrv/calc', {
      method: 'POST', headers: { Authorization: `Bearer ${tok.ent001}` },
      body: JSON.stringify({ year: 2026 }),
    });
    const cb = calc.body.data || {};
    push('核算落库', calc.status === 200 && cb.batchNo, `批次 ${cb.batchNo}${cb.dedup ? '（复用）' : ''}`);
    if (cb.batchNo) {
      const ver = await api(`/api/mrv/calc/batch/${cb.batchNo}/verify`, { headers: { Authorization: `Bearer ${tok.ent001}` } });
      push('⭐ 复算校验（可复现性）', ver.status === 200 && ver.body.data.ok === true,
        ver.body.data ? `${ver.body.data.verdict} ${ver.body.data.passed}/${ver.body.data.total}` : '');
      const det = await api(`/api/mrv/calc/batch/${cb.batchNo}`, { headers: { Authorization: `Bearer ${tok.ent001}` } });
      push('批次详情含分源明细', det.status === 200 && Array.isArray(det.body.data.sources) && det.body.data.sources.length > 0,
        `${det.status === 200 ? det.body.data.sources.length : 0} 条分源`);
    }

    /* ---- 9. 数据质量看板 ---- */
    const q = await api('/api/mrv/quality', { headers: { Authorization: `Bearer ${tok.reg001}` } });
    push('数据质量看板', q.status === 200 && q.body.data.totalRecords > 0,
      q.status === 200 ? `${q.body.data.totalRecords} 条，L3 ${q.body.data.originPct.L3}%` : '');

    /* ---- 10. 结算账户 ---- */
    const dep = await api('/api/settlement/account/deposit', {
      method: 'POST', headers: { Authorization: `Bearer ${tok.ent001}` },
      body: JSON.stringify({ amount: 500000, remark: 'API 探针入金' }),
    });
    push('入金记账', dep.status === 200 && dep.body.data.balance > 0,
      dep.status === 200 ? `余额 ${dep.body.data.balance}` : JSON.stringify(dep.body).slice(0, 200));
    const acc = await api('/api/settlement/account', { headers: { Authorization: `Bearer ${tok.ent001}` } });
    push('账户查询含流水', acc.status === 200 && acc.body.data.recentFlows.length > 0,
      `${acc.status === 200 ? acc.body.data.recentFlows.length : 0} 条流水`);

    /* ---- 11. 履约状态 ---- */
    const cs = await api('/api/settlement/surrender/status?year=2026', { headers: { Authorization: `Bearer ${tok.ent001}` } });
    push('履约状态可查', cs.status === 200 && cs.body.data.assessment,
      cs.status === 200 ? `状态 ${cs.body.data.assessment.state}，依据 ${cs.body.data.emissionBasis.source}` : JSON.stringify(cs.body).slice(0, 200));

    /* ---- 12. CBAM ---- */
    const fsch = await api('/api/settlement/cbam/factor');
    push('CBAM 因子表公开', fsch.status === 200 && fsch.body.data.schedule.length >= 9,
      `${fsch.status === 200 ? fsch.body.data.schedule.length : 0} 个年度`);
    const entProf = await api('/api/enterprise/profile', { headers: { Authorization: `Bearer ${tok.ent001}` } }).catch(() => null);
    const cbamCalc = await api('/api/settlement/cbam/calculate', {
      method: 'POST', headers: { Authorization: `Bearer ${tok.ent001}` },
      body: JSON.stringify({ year: 2026, cnCode: '76011000', quantity: 20000 }),
    });
    const cbc = cbamCalc.body.data || {};
    push('CBAM 证书计算', cbamCalc.status === 200 && cbc.steps && cbc.steps.length === 8,
      cbamCalc.status === 200 ? `应缴 ${cbc.payableEmission} t，净应付 ${cbc.netPayableCny} 元` : JSON.stringify(cbamCalc.body).slice(0, 300));
    push('CBAM 声明局限', cbamCalc.status === 200 && Array.isArray(cbc.limitations) && cbc.limitations.length >= 4,
      `${cbc.limitations ? cbc.limitations.length : 0} 条`);

    /* ---- 13. 交易（含自成交防护） ---- */
    const mk = await api('/api/trade/orders', {
      method: 'POST', headers: { Authorization: `Bearer ${tok.ent001}` },
      body: JSON.stringify({ side: 'BUY', price: 60, amount: 10 }),
    });
    push('买单接入资金冻结', mk.status === 200 && mk.body.data.fundFrozen > 0,
      mk.status === 200 ? `冻结 ${mk.body.data.fundFrozen} 元` : JSON.stringify(mk.body).slice(0, 250));

    /* ---- 14. 越权防护 ---- */
    const deny = await api('/api/mrv/activity?entId=2&year=2026', { headers: { Authorization: `Bearer ${tok.ent001}` } });
    push('企业端不得查他人数据', deny.status === 200 ? (deny.body.data.entId === 1) : true,
      `返回 entId=${deny.body.data ? deny.body.data.entId : deny.status}`);

    const noAuth = await api('/api/mrv/activity?year=2026');
    push('未登录被拒绝', noAuth.status === 401 || noAuth.status === 403, `HTTP ${noAuth.status}`);
  } catch (e) {
    push('探针异常', false, e.message);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`${'─'.repeat(70)}`);
  console.log(`探针结果：${passed}/${results.length} 通过`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ✘ ${f.name} — ${f.detail}`);
  }

  if (!process.argv.includes('--keep')) {
    child.kill('SIGKILL');
    await sleep(300);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('✘ 探针崩溃：', e);
  child.kill('SIGKILL');
  process.exit(1);
});
