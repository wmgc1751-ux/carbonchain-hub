#!/usr/bin/env node
/**
 * tools/harvest-api.mjs —— 静态快照抓取器（生成 public/data/api-snapshot.json）
 * ==================================================================
 * 背景：静态站（Cloudflare Pages）没有后端进程，public/js/data/staticApi.js
 * 在 fetch 层拦截 `/api/*` 并由本快照应答。快照必须来自**真实后端**，
 * 因此需要本脚本从运行中的本地服务逐角色抓取。
 *
 * 两种模式
 * ------------------------------------------------------------------
 *   ① 回放刷新（默认）—— 读现有快照的 fixtures/actions 清单，逐条重放请求，
 *      刷新 response。保证端点覆盖与上一次完全一致，是最可靠的刷新方式。
 *   ② 自省枚举（--from-app）—— 从 server/routes/*.js 自省枚举全部端点，
 *      与快照清单对照，输出"漂移报告"（新增/消失的端点）。含参端点若在
 *      快照中有同模板实例则复用，否则用参数池尽力实例化。
 *
 * 用法
 *   node tools/harvest-api.mjs                     # 回放刷新（需服务在跑 + 已有快照）
 *   node tools/harvest-api.mjs --from-app          # 自省枚举 + 漂移报告
 *   node tools/harvest-api.mjs --base http://127.0.0.1:8300
 *   node tools/harvest-api.mjs --out public/data/api-snapshot.json
 *
 * 前置：`node server/scripts/start-prod.js`（服务需在跑）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

/* ---------- .env 注入（项目未装 dotenv） ---------- */
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const ARGV = process.argv.slice(2);
const argOf = (n, d) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const BASE = argOf('--base', `http://127.0.0.1:${process.env.PORT || 8300}`);
/* --in  = 回放清单来源（读）；--out = 输出目标（写）。默认均为正式快照路径（原地刷新）。
   两者必须分离：否则无法"读正式快照、写到别处试跑"。 */
const IN = path.resolve(ROOT, argOf('--in', 'public/data/api-snapshot.json'));
const OUT = path.resolve(ROOT, argOf('--out', argOf('--in', 'public/data/api-snapshot.json')));
const FROM_APP = ARGV.includes('--from-app');

/* ---------- HTTP ---------- */
function request(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* 非 JSON 保留原文 */ }
        resolve({ status: res.statusCode, json, text: d });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------- 参数池：从抓取到的响应里收集可能的 id 值 ---------- */
const ID_KEYS = /(^|_)(id|did|no|code|hash|tx_id|ent_id|device_did|batch_no)$/i;
const idPool = { ent: new Set(['1', '2', '7', '37']), device: new Set(), tx: new Set(), num: new Set(['1', '2', '3']) };
function harvestIds(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value.slice(0, 30)) harvestIds(v, depth + 1); return; }
  for (const [k, v] of Object.entries(value)) {
    if (ID_KEYS.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      const s = String(v);
      if (/^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s)) {
        idPool.num.add(s);
        if (/ent/i.test(k)) idPool.ent.add(s);
        if (/device|did/i.test(k)) idPool.device.add(s);
        if (/tx|hash/i.test(k)) idPool.tx.add(s);
      }
    }
    harvestIds(v, depth + 1);
  }
}
function instantiate(template) {
  const segs = template.split('/');
  const params = [];
  const filled = segs.map((s) => {
    if (!s.startsWith(':')) return s;
    const name = s.slice(1);
    params.push(name);
    if (/ent/i.test(name)) return [...idPool.ent][0];
    if (/device|did/i.test(name)) return [...idPool.device][0] || [...idPool.num][0];
    if (/tx|hash/i.test(name)) return [...idPool.tx][0] || [...idPool.num][0];
    return [...idPool.num][0];
  });
  return { path: filled.join('/'), params };
}

/* ---------- 自省：从 server/routes/*.js 枚举端点模板 ---------- */
function introspectRoutes() {
  const appSrc = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
  const mounts = [...appSrc.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*require\('\.\/routes\/([^']+)'\)/g)]
    .map((m) => ({ prefix: m[1], mod: m[2] }));
  const out = [];
  for (const { prefix, mod } of mounts) {
    let router;
    try { router = require(path.join(ROOT, 'server', 'routes', mod + '.js')); } catch { continue; }
    const stack = (router && router.stack) || [];
    for (const layer of stack) {
      if (!layer.route) continue;
      const p = prefix + layer.route.path;
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), template: p });
      }
    }
  }
  return out;
}

/* ---------- 归一化：把 path 里的具体值替换为 :p，用于模板比对 ---------- */
function normalize(p) {
  return p.split('/').map((s) => (/^(\d+|[0-9a-f]{8,}|0x[0-9a-f]+)$/i.test(s) ? ':p' : s)).join('/');
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log('\n════════ 静态快照抓取 ════════');
  console.log(`  目标服务  ${BASE}`);
  console.log(`  回放清单  ${path.relative(ROOT, IN)}`);
  console.log(`  输出文件  ${path.relative(ROOT, OUT)}`);
  console.log(`  模式      ${FROM_APP ? '自省枚举 + 漂移报告' : '回放刷新'}\n`);

  /* 0) 探活 */
  const probe = await request('GET', '/api/chain/stats').catch((e) => ({ status: 0, error: e.message }));
  if (!probe.json) {
    console.error(`✘ 目标服务不可达或无响应（status=${probe.status}）。请先启动：node server/scripts/start-prod.js`);
    process.exit(1);
  }
  console.log(`  ✔ 服务可达：${JSON.stringify(probe.json).slice(0, 80)}…`);

  /* 1) 现有快照（回放清单 + 账号清单） */
  const prev = fs.existsSync(IN) ? JSON.parse(fs.readFileSync(IN, 'utf8')) : null;
  if (!FROM_APP && !prev) {
    console.error(`✘ 回放模式需要已有快照作为清单；未找到 ${path.relative(ROOT, IN)}。`);
    console.error('  请先确认 --in 路径，或改用 --from-app 自省生成。');
    process.exit(1);
  }

  /* 2) 登录：账号清单优先取现有快照，其次取 demo-accounts */
  const accounts = await (async () => {
    if (prev && prev.logins) return Object.keys(prev.logins);
    const demo = await request('GET', '/api/auth/demo-accounts');
    return (demo.json?.data || []).map((a) => a.username);
  })();
  const demo = await request('GET', '/api/auth/demo-accounts');
  const pwdOf = new Map((demo.json?.data || []).map((a) => [a.username, a.password]));

  const logins = {};
  const tokens = { public: null };
  for (const username of accounts) {
    const password = pwdOf.get(username) || (username === 'admin' ? 'admin123' : '123456');
    const r = await request('POST', '/api/auth/login', { body: { username, password } });
    if (r.json && r.json.data && r.json.data.token) {
      logins[username] = { token: r.json.data.token, user: r.json.data.user };
      tokens[(prev && prev.logins[username] && prev.logins[username].role) || username] = r.json.data.token;
      const roleKey = { ENTERPRISE: 'ent', VERIFIER: 'ver', REGULATOR: 'reg', TRADER: 'trader', ADMIN: 'admin' }[r.json.data.user.role];
      if (roleKey) tokens[roleKey] = r.json.data.token;
      console.log(`  ✔ 登录 ${username}（${r.json.data.user.roleCn || r.json.data.user.role}）`);
    } else {
      console.warn(`  ⚠ 登录失败 ${username}：${r.text.slice(0, 80)}`);
    }
  }

  /* 3) 抓取 = 回放 or 自省 */
  const fixtures = [];
  const failures = [];
  const roleOf = (r) => tokens[r] || null;

  let plan = [];
  if (prev) {
    plan = prev.fixtures.map((f) => ({ method: f.method, path: f.path, query: f.query || '', role: f.viaRole }));
    console.log(`\n  回放清单：${plan.length} 条（来自现有快照）`);
  } else {
    const routes = introspectRoutes();
    console.log(`\n  自省枚举：${routes.length} 个端点`);
    // 先用无参端点灌满 id 池
    for (const r of routes.filter((x) => !x.template.includes(':'))) {
      for (const tk of ['public', 'admin']) {
        if (!roleOf(tk)) continue;
        const res = await request(r.method, r.template, { token: roleOf(tk) });
        if (res.json && res.json.code === 0) harvestIds(res.json.data);
      }
    }
    for (const r of routes) {
      const inst = r.template.includes(':') ? instantiate(r.template) : { path: r.template };
      for (const tk of ['public', 'ent', 'ver', 'reg', 'trader', 'admin']) {
        if (!roleOf(tk)) continue;
        plan.push({ method: r.method, path: inst.path, query: '', role: tk, template: r.template });
      }
    }
  }

  /* 3.1) 强制补采清单
   *
   * 【为什么必须有这一节】
   * 回放模式只重放"快照里已有的条目"。新加的端点永远不会被自动纳入 ——
   * 结果就是：本地开发一切正常，部署到静态站后新页面全部空白，
   * 而构建过程一声不响地"成功"了。这类缺陷只有在打开线上页面时才发现。
   *
   * 因此这里维护一份"必须存在"的端点清单：不管回放还是自省，
   * 只要 plan 里没有就补进去。
   *
   * 清单里刻意包含真实的查询组合（分页/筛选/多国），因为静态站在
   * fetch 层按 method+path+query 精确匹配；少一个组合，那一页的筛选就失效。 */
  const SEED_ENDPOINTS = [
    /* 真实数据层（公开，无需 token） */
    { method: 'GET', path: '/api/real/overview', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/live', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/truth', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/sources', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/benchmarks', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/trend', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/macro', query: '?country=CHN', role: 'public' },
    { method: 'GET', path: '/api/real/macro', query: '?country=USA', role: 'public' },
    { method: 'GET', path: '/api/real/macro', query: '?country=IND', role: 'public' },
    { method: 'GET', path: '/api/real/macro', query: '?country=EUU', role: 'public' },
    /* 设施台账：默认页 + 行业筛选 + 升序 + 关键字（对应页面上的各个筛选器） */
    { method: 'GET', path: '/api/real/facilities', query: '?page=1&size=20', role: 'public' },
    { method: 'GET', path: '/api/real/facilities', query: '?page=2&size=20', role: 'public' },
    { method: 'GET', path: '/api/real/facilities', query: '?industry=%E7%94%B5%E5%8A%9B&sort=emission&order=DESC&page=1&size=20', role: 'public' },
    { method: 'GET', path: '/api/real/facilities', query: '?sort=emission&order=ASC&page=1&size=20', role: 'public' },
    { method: 'GET', path: '/api/real/facilities', query: '?sort=name&order=DESC&page=1&size=20', role: 'public' },
    { method: 'GET', path: '/api/real/facilities', query: '?sort=state&order=DESC&page=1&size=20', role: 'public' },
    { method: 'GET', path: '/api/real/facilities', query: '?page=1&size=20&state=TX', role: 'public' },
    /* 单设施明细：取台账首行对应的 id（由 instantiate 之外手工给一个确定 id） */
    { method: 'GET', path: '/api/real/facilities/1', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/facilities/500', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/facilities/2000', query: '', role: 'public' },
    { method: 'GET', path: '/api/real/live/selfcheck', query: '', role: 'public' },
  ];
  {
    const have = new Set(plan.map((p) => `${p.method} ${p.path}${p.query || ''}`));
    let added = 0;
    for (const s of SEED_ENDPOINTS) {
      const k = `${s.method} ${s.path}${s.query || ''}`;
      if (have.has(k)) continue;
      plan.push(s);
      have.add(k);
      added++;
    }
    if (added) console.log(`  补采清单：新增 ${added} 条端点（回放清单未覆盖）`);
  }

  console.log(`  抓取中…\n`);
  const seen = new Set();
  for (const item of plan) {
    const key = `${item.method} ${item.path}${item.query} ${item.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = item.path + (item.query || '');
    const res = await request(item.method, url, { token: roleOf(item.role) });
    if (res.json === null) {
      failures.push({ method: item.method, path: item.path, query: item.query, role: item.role, reason: `非 JSON 响应（HTTP ${res.status}）` });
      continue;
    }
    harvestIds(res.json.data);
    fixtures.push({
      method: item.method, path: item.path, query: item.query || '', viaRole: item.role,
      ...(item.template ? { pattern: item.template } : {}),
      response: res.json,
    });
  }

  /* 4) 写操作动作（仅回放模式下复用既有契约） */
  const actions = [];
  if (prev && Array.isArray(prev.actions)) {
    for (const a of prev.actions) {
      const res = await request(a.method, a.path, { token: roleOf(a.role), body: a.body });
      actions.push({ ...a, response: res.json ?? a.response });
    }
    console.log(`  重放写操作契约 ${actions.length} 条`);
  }

  /* 5) 漂移报告（自省模式） */
  if (FROM_APP) {
    const snapTemplates = new Set(fixtures.map((f) => normalize(f.path)));
    const routeTemplates = new Set(introspectRoutes().map((r) => normalize(r.template)));
    const missing = [...routeTemplates].filter((t) => !snapTemplates.has(t));
    const stale = [...snapTemplates].filter((t) => !routeTemplates.has(t));
    console.log(`\n  ── 漂移报告 ──`);
    console.log(`  端点模板：路由 ${routeTemplates.size} · 快照覆盖 ${snapTemplates.size}`);
    console.log(`  未被快照覆盖（${missing.length}）：${missing.slice(0, 8).join(', ') || '无'}`);
    console.log(`  快照中已消失（${stale.length}）：${stale.slice(0, 8).join(', ') || '无'}`);
  }

  /* 6) 落盘 */
  const snapshot = {
    meta: {
      harvestedAt: new Date().toISOString(),
      source: BASE,
      endpointCount: fixtures.length,
      actionCount: actions.length,
      failureCount: failures.length,
      accountCount: accounts.length,
      latestBlock: (probe.json?.data?.height) ?? (prev?.meta?.latestBlock ?? 0),
    },
    logins,
    fixtures,
    actions,
    failures,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snapshot), 'utf8');

  console.log(`\n────────────────────────────────────────`);
  console.log(`  快照写入  ${path.relative(ROOT, OUT)}（${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB）`);
  console.log(`  读端点 ${fixtures.length} · 写动作 ${actions.length} · 账号 ${accounts.length} · 失败 ${failures.length}`);
  if (failures.length) console.log(`  失败明细见 meta.failures`);
  console.log(`────────────────────────────────────────\n`);
  process.exit(fixtures.length > 0 ? 0 : 1);
})().catch((e) => {
  console.error('✘ 抓取失败：', e && e.message ? e.message : e);
  process.exit(2);
});
