/**
 * api-iter2-check.mjs —— 第 2 轮新增路由的**端到端 HTTP 验收**
 * ==================================================================
 * 为什么要有这个脚本
 *   服务层自检（tools/uncertainty-selftest.mjs / keymgmt-selftest.mjs）直接
 *   调用 service 函数，**绕过 Express**。但评审看到的、前端调用的、以及线上
 *   静态快照拦截的，都是 HTTP 层。中间隔着：
 *     · 路由挂载是否真的挂上了（app.js 的 app.use 写错路径就整体 404）
 *     · requireRole 的权限矩阵是否与设计文档一致（越权是硬伤）
 *     · 企业角色是否会因入参而读到别家企业的数据（水平越权）
 *     · 响应体是否泄漏私钥字段
 *   这些只有走真实 HTTP 才验得到。本脚本因此逐条打真请求。
 *
 * 前置
 *   平台服务需在运行（默认 http://127.0.0.1:8300）。
 *   可用 CC_BASE 覆盖，例如：CC_BASE=http://localhost:8300 node tools/api-iter2-check.mjs
 *
 * 用法
 *   npm run api:iter2
 * ==================================================================
 */
'use strict';

const BASE = (process.env.CC_BASE || 'http://127.0.0.1:8300').replace(/\/+$/, '');

let pass = 0; let fail = 0;
const line = (okFlag, name, detail) => {
  if (okFlag) pass++; else fail++;
  console.log(`  ${okFlag ? '✔' : '✗'} ${name}${detail ? '  →  ' + detail : ''}`);
};
const head = (t) => console.log(`\n【${t}】`);

/** 发起请求，返回 { status, code, data, message, raw } */
async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  return {
    status: res.status,
    code: j && j.code,
    data: j && j.data,
    message: (j && j.message) || text.slice(0, 120),
    raw: text,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 递归收集对象里所有 key 名，用于"响应体是否泄漏私钥"的扫描 */
function collectKeys(node, acc = new Set()) {
  if (Array.isArray(node)) { node.forEach((x) => collectKeys(x, acc)); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { acc.add(k); collectKeys(v, acc); }
  }
  return acc;
}

const SECRET_HINTS = ['privatekey', 'private_key', 'secret', 'passphrase', 'mnemonic', 'seed'];

async function login(username, password) {
  const r = await api('POST', '/api/auth/login', { body: { username, password } });
  if (r.code !== 0 || !r.data || !r.data.token) {
    throw new Error(`登录失败 ${username}: HTTP ${r.status} / ${r.message}`);
  }
  return r.data.token;
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  第 2 轮新增路由 · 端到端 HTTP 验收');
  console.log(`  目标：${BASE}`);
  console.log('══════════════════════════════════════════════════════════════');

  /* ---------- 0. 服务存活与登录 ---------- */
  head('0. 连通性与令牌');
  const stats = await api('GET', '/api/chain/stats');
  line(stats.code === 0 && stats.data && stats.data.height > 0,
    '平台服务可达，链已就绪',
    `高度=${stats.data && stats.data.height} / 交易=${stats.data && stats.data.totalTxs}`);
  if (stats.code !== 0) {
    console.log('\n  ⚠ 服务未就绪，后续全部跳过。请先启动平台：npm start');
    console.log(`\n─────────────────────────────────────────────\n  合计 ${pass} 通过 / ${fail} 失败\n`);
    process.exit(1);
  }

  const tokens = {};
  for (const [k, u, p] of [
    ['admin', 'admin', 'admin123'],
    ['regulator', 'reg001', '123456'],
    ['enterprise', 'ent001', '123456'],
    ['verifier', 'ver001', '123456'],
  ]) {
    tokens[k] = await login(u, p);
    await sleep(80);
  }
  line(Object.values(tokens).every((t) => typeof t === 'string' && t.length > 20),
    '四端令牌获取成功（管理员 / 监管 / 企业 / 核查）');

  /* ================================================================
   * T1. WP4 不确定度路由 /api/uncertainty/*
   * ================================================================ */
  head('T1. 不确定度与口径方法学（/api/uncertainty）');

  const cat = await api('GET', '/api/uncertainty/catalog', { token: tokens.admin });
  line(cat.code === 0 && cat.data, 'GET /catalog 可达', `HTTP ${cat.status}`);
  const catKeys = collectKeys(cat.data);
  line(catKeys.has('gating') || catKeys.has('integration') || catKeys.has('tiers'),
    '方法学目录含门控/积分/分级缺省不确定度',
    Array.from(catKeys).slice(0, 12).join(','));

  const ser = await api('GET', '/api/uncertainty/series/1', { token: tokens.admin });
  const serOk = ser.code === 0 && Array.isArray(ser.data && ser.data.series) && ser.data.series.length > 0;
  line(serOk, 'GET /series/1 返回日序列',
    serOk ? `${ser.data.series.length} 天 / 覆盖度 ${ser.data.coverage && ser.data.coverage.ratio}` : ser.message);
  line(serOk && ser.data.gating && ser.data.gating.kept >= 0 && ser.data.gating.byReason,
    '门控报告随序列返回（剔除归因可披露）',
    serOk ? `原始 ${ser.data.gating.raw} / 保留 ${ser.data.gating.kept} / 剔除率 ${(ser.data.gating.excludeRate * 100).toFixed(2)}%` : '');

  const pos = await api('GET', '/api/uncertainty/posterior/1', { token: tokens.admin });
  const posAn = pos.data && pos.data.annual;
  const posOk = pos.code === 0 && posAn && typeof posAn.mean === 'number';
  line(posOk, 'GET /posterior/1 返回年度后验',
    posOk ? `年度 ${posAn.mean.toFixed(1)} tCO2e（95% 区间 ${posAn.low.toFixed(0)}~${posAn.high.toFixed(0)}）/ 配额 ${pos.data.quotaAnnual}` : pos.message);
  line(posOk && pos.data.priorSweep && pos.data.priorSafe === true,
    '弱先验自证：先验敏感性扫描通过',
    posOk ? `最大偏移 ${pos.data.maxShift} / ${pos.data.priorVerdict}` : '');

  const prop = await api('GET', '/api/uncertainty/propagate/1', { token: tokens.admin });
  const propOk = prop.code === 0 && prop.data && prop.data.relativeUncertainty !== undefined;
  line(propOk, 'GET /propagate/1 返回 GUM 合成不确定度',
    propOk ? `相对不确定度 ${prop.data.relativeUncertainty}` : prop.message);
  line(propOk && Array.isArray(prop.data.components) && prop.data.components.length > 0,
    '误差来自哪一项可分解（贡献度排序）',
    propOk ? prop.data.components.map((c) => `${c.name} ${(c.relative * 100).toFixed(2)}%`).join(' | ') : '');

  const mdl = await api('GET', '/api/uncertainty/model/1', { token: tokens.admin });
  const mdlOk = mdl.code === 0 && mdl.data && Array.isArray(mdl.data.models) && mdl.data.models.length > 0;
  line(mdlOk, 'GET /model/1 返回六模型对比',
    mdlOk ? `${mdl.data.models.length} 个模型 / 留出集 ${mdl.data.nTest}` : mdl.message);
  line(mdlOk && mdl.data.verdict, '模型评估给出诚实结论（而非只报最高分）',
    mdlOk ? mdl.data.verdict : '');

  const rep = await api('GET', '/api/uncertainty/report/1', { token: tokens.admin });
  const repOk = rep.code === 0 && rep.data && rep.data.crossCheck;
  line(repOk, 'GET /report/1 返回两口径对照报告', repOk ? `HTTP ${rep.status}` : rep.message);
  line(repOk && rep.data.crossCheck.consistent === true,
    '两口径交叉校验的必要条件成立（u_GUM ≥ u_Bayes）',
    repOk ? `GUM ${rep.data.crossCheck.gum && rep.data.crossCheck.gum.k1Relative} vs Bayes ${rep.data.crossCheck.bayesian && rep.data.crossCheck.bayesian.k1Relative} / 系统项占比 ${rep.data.crossCheck.systematicShare}` : '');

  const st = await api('GET', '/api/uncertainty/selftest', { token: tokens.admin });
  const stData = st.data || {};
  line(st.code === 0 && (stData.allPass === true || stData.passed === stData.total),
    'GET /selftest 数学与逻辑断言全通过',
    `${stData.passed} 通过 / ${stData.total || stData.failed}`);

  const list = await api('GET', '/api/uncertainty/list', { token: tokens.regulator });
  line(list.code === 0 && list.data !== undefined, 'GET /list 返回已落库的后验区间', `HTTP ${list.status}`);

  const ind = await api('GET', '/api/uncertainty/industry?limit=3', { token: tokens.regulator });
  line(ind.code === 0 && ind.data, 'GET /industry 返回行业汇总（限 3 家）', `HTTP ${ind.status}`);

  /* ================================================================
   * T2. WP2 密钥治理路由 /api/keys/*
   * ================================================================ */
  head('T2. 国密密钥治理（/api/keys）');

  const capK = await api('GET', '/api/keys/capability', { token: tokens.admin });
  const capD = capK.data || {};
  line(capK.code === 0, 'GET /capability 可达', `HTTP ${capK.status}`);
  line(/SM2-with-SM3/.test(capD.signing || ''), `签名方案声明为 ${capD.signing || '(空)'}`);
  line(capD.hsmReady === false && !!capD.hsmNote, '如实声明未接硬件加密机', capD.hsmNote || '');
  line(capD.dualControl && capD.dualControl.enforced === true, '双人复核标记为服务层强制',
    (capD.dualControl && capD.dualControl.rule) || '');

  const stK = await api('GET', '/api/keys/status', { token: tokens.admin });
  line(stK.code === 0 && stK.data && stK.data.keys,
    'GET /status 返回密钥世代与轮换统计',
    stK.code === 0 ? `主体 ${stK.data.keys.labels} 个 / 累计世代 ${stK.data.keys.generations} / 已轮换 ${stK.data.keys.rotated}` : stK.message);

  const inv = await api('GET', '/api/keys/inventory', { token: tokens.verifier });
  line(inv.code === 0 && inv.data, 'GET /inventory 可达（核查方只读可看）', `HTTP ${inv.status}`);
  const invKeys = Array.from(collectKeys(inv.data)).map((s) => s.toLowerCase());
  const leaked = invKeys.filter((k) => SECRET_HINTS.some((h) => k.includes(h)));
  line(leaked.length === 0, '响应体不含任何私钥/口令字段', leaked.length ? `泄漏字段：${leaked.join(',')}` : '仅公钥与指纹');

  const lbl = await api('GET', '/api/keys/labels', { token: tokens.admin });
  line(lbl.code === 0 && Array.isArray(lbl.data && lbl.data.prefixes) && lbl.data.prefixes.length > 0,
    'GET /labels 返回可治理主体前缀',
    lbl.code === 0 ? lbl.data.prefixes.join(' ') : lbl.message);

  // 签名 / 验签取证（用专用标签，避免触碰平台真实密钥）
  const DEMO_LABEL = 'device:httpcheck';
  const PAYLOAD = { demo: 'api-iter2', at: 'fixed-for-check', v: 1 };
  const sg = await api('POST', '/api/keys/sign', {
    token: tokens.admin, body: { keyLabel: DEMO_LABEL, payload: PAYLOAD },
  });
  const sgOk = sg.code === 0 && sg.data && sg.data.signature;
  line(sgOk, 'POST /sign 生成 SM2 签名',
    sgOk ? `世代 ${sg.data.generation} / 指纹 ${String(sg.data.publicKeyFingerprint || '').slice(0, 12)}…` : sg.message);

  if (sgOk) {
    const vf = await api('POST', '/api/keys/verify', {
      token: tokens.verifier,
      body: { keyLabel: DEMO_LABEL, payload: PAYLOAD, signature: sg.data.signature },
    });
    line(vf.code === 0 && vf.data && vf.data.valid === true,
      'POST /verify 正确载荷验签通过',
      vf.data ? `generation=${vf.data.generation}` : vf.message);

    const tampered = await api('POST', '/api/keys/verify', {
      token: tokens.verifier,
      body: { keyLabel: DEMO_LABEL, payload: Object.assign({}, PAYLOAD, { v: 2 }), signature: sg.data.signature },
    });
    line(tampered.code === 0 && tampered.data && tampered.data.valid === false,
      'POST /verify 篡改载荷验签失败（负向用例）',
      tampered.data ? `valid=${tampered.data.valid}` : tampered.message);

    const sg2 = await api('POST', '/api/keys/sign', {
      token: tokens.admin, body: { keyLabel: DEMO_LABEL, payload: PAYLOAD },
    });
    line(sg2.code === 0 && sg2.data && sg2.data.signature !== sg.data.signature,
      '同一载荷两次签名不同（SM2 随机数 k 非同定，非哈希冒充）');
  }

  const rl = await api('POST', '/api/keys/rotation-safety-demo', {
    token: tokens.admin, body: { keyLabel: DEMO_LABEL },
  });
  const rlD = rl.data || {};
  line(rl.code === 0 && rlD.allPass === true,
    'POST /rotation-safety-demo 五项轮换安全断言全通过',
    rl.code === 0 ? `${rlD.passed}/${rlD.total}` : rl.message);
  if (rl.code === 0 && Array.isArray(rlD.checks)) {
    rlD.checks.forEach((c) => line(c.pass === true, `  · ${c.name}`, `实际 ${c.actual}${c.generation ? ' (' + c.generation + ')' : ''}`));
  }
  line(rl.code === 0 && rlD.rotation && rlD.rotation.oldKeys.address !== rlD.rotation.newKeys.address,
    '轮换确实换了密钥（新旧地址不同）',
    rl.code === 0 ? `${String(rlD.rotation.oldKeys.address).slice(0, 12)}… → ${String(rlD.rotation.newKeys.address).slice(0, 12)}…` : '');

  const logs = await api('GET', '/api/keys/rotations', { token: tokens.admin });
  line(logs.code === 0 && (Array.isArray(logs.data) || Array.isArray(logs.data && logs.data.rows)),
    'GET /rotations 返回轮换台账', `HTTP ${logs.status}`);

  /* ================================================================
   * T3. 权限边界（越权是硬伤，必须逐条验）
   * ================================================================ */
  head('T3. 权限边界（RBAC / 水平越权）');

  // 企业角色请求别家企业 → 必须被强制改写为自己
  const xEnt = await api('GET', '/api/uncertainty/series/2', { token: tokens.enterprise });
  const forced = xEnt.code === 0 && xEnt.data && Number(xEnt.data.entId) === 1;
  line(forced, '企业端请求别家企业序列被强制改写为本企业（水平越权防护）',
    xEnt.code === 0 ? `请求 ent2 → 实际返回 entId=${xEnt.data.entId}` : xEnt.message);

  // 企业角色触发全平台重算 → 403
  const bEnt = await api('POST', '/api/uncertainty/recompute', { token: tokens.enterprise, body: {} });
  line(bEnt.code !== 0 && (bEnt.status === 403 || bEnt.code === 403),
    '企业端触发全平台重算被拒（403）', `HTTP ${bEnt.status} / ${bEnt.message}`);

  // 核查角色触发全平台重算 → 403
  const bVer = await api('POST', '/api/uncertainty/recompute', { token: tokens.verifier, body: {} });
  line(bVer.code !== 0 && (bVer.status === 403 || bVer.code === 403),
    '核查端触发全平台重算被拒（403）', `HTTP ${bVer.status} / ${bVer.message}`);

  // 监管角色触发重算 → 允许（限定范围以免全量跑；顺带验证空数组被规范化为"全平台"）
  const okReg = await api('POST', '/api/uncertainty/recompute', {
    token: tokens.regulator, body: { entIds: [1] },
  });
  line(okReg.code === 0, '监管端通过权限校验（canBatch 放行）',
    okReg.code === 0 ? `范围 ${okReg.data && okReg.data.total} 家 / 落库 ${okReg.data && okReg.data.saved}` : `HTTP ${okReg.status} / ${okReg.message}`);

  // 空数组不得触发 500（曾拼出非法 SQL `IN ()`）
  const okEmpty = await api('POST', '/api/uncertainty/recompute', {
    token: tokens.regulator, body: { entIds: [] },
  });
  line(okEmpty.code === 0, '空 entIds 数组被规范化为"全平台"而非 500',
    okEmpty.code === 0 ? `处理 ${okEmpty.data && okEmpty.data.total} 家` : `HTTP ${okEmpty.status} / ${okEmpty.message}`);

  // 非管理员提交密钥轮换 → 403
  const kEnt = await api('POST', '/api/keys/rotations', { token: tokens.enterprise, body: { keyLabel: DEMO_LABEL } });
  line(kEnt.code !== 0 && (kEnt.status === 403 || kEnt.code === 403),
    '企业端提交密钥轮换被拒（403）', `HTTP ${kEnt.status} / ${kEnt.message}`);

  // 非管理员跑轮换举证 → 403
  const kVer = await api('POST', '/api/keys/rotation-safety-demo', { token: tokens.verifier, body: { keyLabel: DEMO_LABEL } });
  line(kVer.code !== 0 && (kVer.status === 403 || kVer.code === 403),
    '核查端触发轮换举证被拒（403）', `HTTP ${kVer.status} / ${kVer.message}`);

  // 未登录访问 → 401
  const anon = await api('GET', '/api/uncertainty/catalog');
  line(anon.code !== 0 && (anon.status === 401 || anon.code === 401),
    '未登录访问被拒（401）', `HTTP ${anon.status}`);

  // 非法入参 → 400 而非 500
  const bad = await api('GET', '/api/uncertainty/series/abc', { token: tokens.admin });
  line(bad.status === 400 || (bad.code !== 0 && bad.status < 500),
    '非法 entId 返回 4xx（不暴露 500 堆栈）', `HTTP ${bad.status} / ${bad.message}`);

  /* ---------- 汇总 ---------- */
  const total = pass + fail;
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`  合计 ${pass} 通过 / ${fail} 失败 / 共 ${total} 项`);
  console.log(fail === 0 ? '  ✅ 第 2 轮新增路由端到端验收全部通过' : '  ❌ 存在失败项，请逐条排查');
  console.log('─────────────────────────────────────────────────────────────\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n✗ 验收脚本异常终止：', e && e.stack || e);
  process.exit(2);
});
