/* =====================================================================
   staticApi.js —— 静态数据适配层（让纯静态站完全独立运行）
   =====================================================================
   背景
   -----
   本平台前端为"无构建"架构（public/ 直接由 30 个 <script> 加载）。
   部署到 Cloudflare Pages 后没有任何后端进程，`/api/*` 会被 Pages 的
   SPA 回退规则接管，一律返回 index.html（HTTP 200 + text/html），
   于是所有业务请求都失败。

   方案
   -----
   在 **fetch 层**统一拦截所有 `/api/*` 请求（这样连 ops.js 里直接
   fetch 的调用也覆盖得到），按快照 `data/api-snapshot.json` 应答。
   快照由 `scripts/harvest-api.mjs` 从真实本地后端逐角色抓取，因此
   返回的是**真实业务数据**而非编造数据。

   双模自适应
   ----------
   · 在线模式（本地 Express 8080/8300、旧 Render 全栈站）→ 透传真实后端
   · 静态模式（Cloudflare Pages）           → 由快照应答
   启动时用一次 `/api/chain/stats` 探测判定，判定后不再逐请求重试，
   静态模式下零网络等待。

   静态模式能力边界（真实、不夸大）
   --------------------------------
   · 读操作：100% 由快照应答，含本地分页切片（翻页完全可用）
   · 登录  ：复用抓取到的真实会话令牌，五端皆可登录
   · 写操作：按后端字段契约合成响应，并在内存中就地更新列表快照，
             使"新增/受理/核查/分配/挂单/撤单/发布"等操作立刻可见
   · 不落库 ：刷新页面后回到快照基准状态（静态站天然无持久化）
   ===================================================================== */
(function (global) {
  'use strict';
  if (global.__CCH_STATIC_API__) return;
  global.__CCH_STATIC_API__ = true;

  const SNAPSHOT_URL = './data/api-snapshot.json';
  const PROBE_URL = './api/chain/stats';
  const PROBE_TIMEOUT_MS = 2600;
  const LIST_KEYS = ['rows', 'list', 'items', 'entries'];

  const ROLE_KEY = { ENTERPRISE: 'ent', VERIFIER: 'ver', REGULATOR: 'reg', TRADER: 'trader', ADMIN: 'admin' };

  const nativeFetch = typeof global.fetch === 'function' ? global.fetch.bind(global) : null;

  const S = {
    mode: 'unknown',        // 'unknown' | 'live' | 'static'
    bundle: null,
    exact: new Map(),       // 'GET /api/p?q'  -> Map<role, fixture>
    byPath: new Map(),      // 'GET /api/p'    -> Map<role, fixture（列表最长）>
    patterns: [],           // [{ method, re, fixtures }]
    actions: [],
    error: '',
    booting: null,
    /* 静态演示期由本层自洽签发的「签名」（非真实国密），仅用于让"签→验"闭环可点 */
    demoSigs: new Map(),
    stats: { hit: 0, miss: 0, route: 0, write: 0 },
  };
  global.__CCH_STATIC__ = S;

  /* ==================================================================
   * 0. 小工具
   * ================================================================== */
  function isObject(v) { return v !== null && typeof v === 'object'; }

  /** 从任意 url 中提取 /api 之后的路径与查询串；非 API 请求返回 null */
  function splitApiUrl(url) {
    let s = String(url == null ? '' : url);
    try { s = new URL(s, (global.location && global.location.href) || 'http://localhost/').href; }
    catch (e) { /* 保持原串，继续用正则提取 */ }
    const m = s.match(/\/api(\/[^?#]*)?(\?[^#]*)?$/);
    if (!m) return null;
    return { path: '/api' + (m[1] || ''), query: m[2] || '' };
  }

  /** 查询串规范化：键排序 + 去空值，使 `?a=1&b=2` 与 `?b=2&a=1` 等价 */
  function normalizeQuery(q) {
    if (!q || q === '?') return '';
    const usp = new URLSearchParams(q.charAt(0) === '?' ? q.slice(1) : q);
    const pairs = [];
    usp.forEach((v, k) => { if (v !== '' && v != null) pairs.push([k, v]); });
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return pairs.length ? '?' + pairs.map((p) => p[0] + '=' + p[1]).join('&') : '';
  }

  function queryParams(q) {
    const out = {};
    new URLSearchParams((q || '').replace(/^\?/, '')).forEach((v, k) => { out[k] = v; });
    return out;
  }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  /** 确定性伪哈希（不引入随机源，可复现） */
  function pseudoHash(seed) {
    let h1 = 0x811c9dc5; let h2 = 0x01000193;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) {
      h1 = ((h1 ^ s.charCodeAt(i)) * 16777619) >>> 0;
      h2 = (h2 + s.charCodeAt(i) * (i + 7)) >>> 0;
    }
    let out = '';
    for (let i = 0; i < 8; i++) {
      h1 = ((h1 * 16777619) ^ h2) >>> 0;
      h2 = ((h2 * 2246822519) ^ h1) >>> 0;
      out += h1.toString(16).padStart(8, '0');
    }
    return out.slice(0, 64);
  }

  /** 从快照数据里取列表数组（兼容 rows / list / items / entries / 裸数组） */
  function listOf(data) {
    if (Array.isArray(data)) return data;
    if (!isObject(data)) return null;
    for (const k of LIST_KEYS) if (Array.isArray(data[k])) return data[k];
    return null;
  }

  function listLenOfFixture(f) {
    if (!f || !f.response) return -1;
    const l = listOf(f.response.data);
    return l ? l.length : -1;
  }

  /** Map<role, fixture> 的取值：优先 public，其次列表最长 */
  function pickFromRoleMap(m, role) {
    if (!m) return null;
    if (role && m.has(role)) return m.get(role);
    if (m.has('public')) return m.get('public');
    let best = null;
    m.forEach((f) => { if (!best || listLenOfFixture(f) > listLenOfFixture(best)) best = f; });
    return best;
  }

  function jsonRes(payload, status) {
    return new Response(JSON.stringify(payload), {
      status: status || 200,
      statusText: status === 401 ? 'Unauthorized' : 'OK',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function envelope(data, code, message) {
    return { code: code === undefined ? 0 : code, message: message || 'ok', data: data === undefined ? null : data };
  }

  /** 当前登录角色（简写 key），未登录为 public */
  function currentRole(init) {
    const u = global.App && global.App.Store && global.App.Store.user;
    if (u && ROLE_KEY[u.role]) return ROLE_KEY[u.role];
    const tok = tokenOf(init);
    if (tok && S.bundle && S.bundle.logins) {
      const keys = Object.keys(S.bundle.logins);
      for (let i = 0; i < keys.length; i++) {
        if (S.bundle.logins[keys[i]].token === tok) {
          const r = S.bundle.logins[keys[i]].user.role;
          return ROLE_KEY[r] || 'public';
        }
      }
    }
    return 'public';
  }

  function tokenOf(init) {
    try {
      const h = init && init.headers;
      if (!h) return '';
      if (typeof h.get === 'function') return h.get('Authorization') || '';
      if (Array.isArray(h)) {
        for (const p of h) if (String(p[0]).toLowerCase() === 'authorization') return p[1];
        return '';
      }
      const k = Object.keys(h).find((x) => x.toLowerCase() === 'authorization');
      return k ? String(h[k]) : '';
    } catch (e) { return ''; }
  }

  /* ==================================================================
   * 1. 索引构建
   * ================================================================== */
  function buildIndex(bundle) {
    S.bundle = bundle;
    S.actions = (bundle.actions || []).slice();

    const patchPattern = [];
    for (const f of bundle.fixtures) {
      const key = f.method + ' ' + f.path + normalizeQuery(f.query || '');
      if (!S.exact.has(key)) S.exact.set(key, new Map());
      const b = S.exact.get(key);
      const cur = b.get(f.viaRole);
      if (!cur || listLenOfFixture(f) > listLenOfFixture(cur)) b.set(f.viaRole, f);

      const pk = f.method + ' ' + f.path;
      if (!S.byPath.has(pk)) S.byPath.set(pk, new Map());
      const pm = S.byPath.get(pk);
      const curP = pm.get(f.viaRole);
      if (!curP || listLenOfFixture(f) > listLenOfFixture(curP)) pm.set(f.viaRole, f);

      if (f.pattern) patchPattern.push(f);
    }

    /* 参数化端点（/api/x/:id）→ 正则兜底 */
    const byPattern = new Map();
    for (const f of patchPattern) {
      if (!byPattern.has(f.pattern)) {
        const keys = [];
        const re = new RegExp('^' + f.pattern.replace(/:[A-Za-z0-9_]+/g, (mm) => { keys.push(mm); return '([^/]+)'; }) + '$');
        byPattern.set(f.pattern, { method: f.method, re, fixtures: [] });
      }
      byPattern.get(f.pattern).fixtures.push(f);
    }
    S.patterns = [...byPattern.values()];

    /* 链高度游标：写操作合成区块号时递增 */
    const base = Number((bundle.meta && bundle.meta.latestBlock) || 0);
    S.chainCursor = base + 1;
    S.writeSeq = 0;
    S.chains = {};
  }

  function matchPattern(method, path, role) {
    for (const p of S.patterns) {
      if (p.method !== method) continue;
      if (!p.re.test(path)) continue;
      const m = new Map();
      p.fixtures.forEach((f) => { if (!m.has(f.viaRole)) m.set(f.viaRole, f); });
      return pickFromRoleMap(m, role);
    }
    return null;
  }

  function nextBlock() { return S.chainCursor++; }
  function nextSeq() { return ++S.writeSeq; }

  /* ==================================================================
   * 2. GET 解析（含本地分页切片 + 本地筛选 + 关键词过滤）
   * ================================================================== */

  /* 由分页/排序/时间戳等机制参数，不参与业务筛选 */
  const NON_FILTER = new Set(['page', 'size', 'limit', 'offset', 'sort', 'order', 'ts', 't', '_']);

  /**
   * 本地筛选：仅对「能确认为行字段」的参数生效——
   * 若某参数在所有行里都找不到同名字段，则忽略该参数（避免因字段命名差异把表格筛空）。
   * keyword / q 走整行模糊匹配。
   */
  function filterRows(rows, params) {
    let out = rows;
    for (const k of Object.keys(params)) {
      const v = String(params[k] == null ? '' : params[k]).toLowerCase();
      if (!v || NON_FILTER.has(k)) continue;
      if (k === 'keyword' || k === 'q') {
        const kw = v;
        out = out.filter((r) => { try { return JSON.stringify(r).toLowerCase().indexOf(kw) >= 0; } catch (e) { return false; } });
        continue;
      }
      const hasField = rows.some((r) => isObject(r) && r[k] !== undefined);
      if (!hasField) continue;
      const next = out.filter((r) => {
        const fv = String(r[k] == null ? '' : r[k]).toLowerCase();
        return fv === v || (v.length > 1 && fv.indexOf(v) >= 0);
      });
      out = next;
    }
    return out;
  }

  function sliceList(data, params) {
    if (!isObject(data)) return data;
    let page = Number(params.page);
    let size = Number(params.size);
    if (!size && params.limit) { size = Number(params.limit); page = 1; }
    if (!size || size <= 0) return data;

    const key = LIST_KEYS.find((k) => Array.isArray(data[k]));
    if (!key) return data;

    let rows = filterRows(data[key], params);
    if (rows.length !== data[key].length) data = Object.assign({}, data);
    data[key] = rows;

    if (!page || page <= 0) page = 1;
    const total = rows.length;
    const start = (page - 1) * size;
    data[key] = rows.slice(start, start + size);
    data.page = page;
    data.size = size;
    data.total = total;
    data.pages = Math.max(1, Math.ceil(total / size));
    return data;
  }

  function resolveGet(path, query, role) {
    const nq = normalizeQuery(query);
    const params = queryParams(nq);
    const key = 'GET ' + path + nq;
    const bucket = S.exact.get(key);
    const pathMap = S.byPath.get('GET ' + path);
    let f = bucket ? pickFromRoleMap(bucket, role) : null;

    const wantSize = Number(params.size) || Number(params.limit) || 0;
    if (wantSize > 0) {
      /* 分页请求：优先用「行数最多」的那份快照做本地切片，保证任意页码都能翻 */
      const cand = pickFromRoleMap(pathMap, role);
      if (cand && (!f || listLenOfFixture(cand) > listLenOfFixture(f))) f = cand;
      /* 精确快照已够一页、且无额外业务筛选时，优先用精确快照（保真度更高） */
      const noExtraFilter = !params.keyword && !params.q
        && Object.keys(params).every((k) => NON_FILTER.has(k) || k === 'page' || k === 'size' || k === 'limit');
      if (bucket && noExtraFilter && listLenOfFixture(pickFromRoleMap(bucket, role)) >= wantSize) {
        f = pickFromRoleMap(bucket, role);
      }
    } else if (!f) {
      /* 非分页请求（含过滤类查询）：回落到同路径的首选快照 */
      f = pickFromRoleMap(pathMap, role);
    }

    if (!f) f = matchPattern('GET', path, role);
    if (!f) return null;

    let data = clone(f.response.data);
    /* 列表型数据统一做本地筛选/分页；非列表数据原样返回 */
    if (isObject(data) && LIST_KEYS.some((k) => Array.isArray(data[k]))) data = sliceList(data, params);
    else if (Array.isArray(data) && wantSize > 0) {
      const rows = filterRows(data, params);
      const start = ((Number(params.page) || 1) - 1) * wantSize;
      data = rows.slice(start, start + wantSize);
    }
    return { data, fixture: f };
  }

  /* ==================================================================
   * 3. POST 解析（登录 / 动作快照 / 契约合成 / 本地列表变更）
   * ================================================================== */
  function findFixture(path, role) {
    const pm = S.byPath.get('GET ' + path);
    return pickFromRoleMap(pm, role);
  }

  /** 就地变更内存快照，使写操作后的列表刷新可见 */
  function mutateList(path, fn) {
    const pm = S.byPath.get('GET ' + path);
    if (!pm) return;
    pm.forEach((f) => {
      const d = f.response && f.response.data;
      if (!isObject(d)) return;
      /* 裸数组响应（/api/iot/devices、/api/trade/orders 等）没有 LIST_KEYS 包裹，也要能就地变更 */
      if (Array.isArray(d)) { fn(d, d); return; }
      const key = LIST_KEYS.find((k) => Array.isArray(d[k]));
      if (!key) return;
      fn(d[key], d);
    });
  }

  function patchRow(path, idField, id, patch) {
    mutateList(path, (arr) => {
      const row = arr.find((r) => String(r[idField]) === String(id));
      if (row) Object.assign(row, patch);
    });
  }

  function removeRow(path, idField, id) {
    mutateList(path, (arr) => {
      const i = arr.findIndex((r) => String(r[idField]) === String(id));
      if (i >= 0) arr.splice(i, 1);
    });
  }

  function unshiftRow(path, row) {
    mutateList(path, (arr, d) => {
      arr.unshift(row);
      if (d.total !== undefined) d.total = Number(d.total) + 1;
    });
  }

  /** 演示账号密码校验（快照里带明文口令，与真实后端一致） */
  function demoAccounts() {
    const f = S.exact.get('GET /api/auth/demo-accounts');
    const got = f ? pickFromRoleMap(f, 'public') : null;
    if (!got) return [];
    const d = got.response.data;
    return Array.isArray(d) ? d : [];
  }

  function handleLogin(body) {
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    const acc = demoAccounts().find((a) => a.username === username);
    const rec = S.bundle && S.bundle.logins ? S.bundle.logins[username] : null;
    if (!acc || !rec || String(acc.password) !== password) {
      return { env: { code: 401, message: '账号或密码错误（静态演示环境，请使用下方演示账号登录）', data: null }, status: 401 };
    }
    S.role = ROLE_KEY[acc.role] || 'public';
    return { env: envelope({ token: rec.token, user: rec.user }) };
  }

  const nowStr = (function () {
    return function () {
      const d = new Date();
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
  })();

  function quotaAfter(amount) {
    const st = findFixture('/api/trade/account', 'trader');
    const base = (st && Number(st.response.data && st.response.data.quota)) || 10000;
    return Math.max(0, Math.round((base - Number(amount || 0)) * 100) / 100);
  }

  /** 键名字典序递归序列化 —— 与后端 cu.stableStringify 同语义，用于载荷比对 */
  function stableKey(v) {
    if (Array.isArray(v)) return '[' + v.map(stableKey).join(',') + ']';
    if (isObject(v)) {
      return '{' + Object.keys(v).sort()
        .map((k) => JSON.stringify(k) + ':' + stableKey(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  /** 按后端真实字段契约合成写操作响应 */
  function synthPost(path, body, role) {
    let m;

    /* ---- 碳排上报 ---- */
    if (path === '/api/enterprise/reports' && (m = 1)) {
      const seq = nextSeq();
      const year = Number((body && body.year) || new Date().getFullYear());
      const quarter = Number((body && body.quarter) || 1);
      const items = ((body && body.items) || []).slice();
      const total = Math.round(items.reduce((a, i) => a + Number(i.amount || 0) * 2.1, 0) * 100) / 100;
      const submit = !!(body && body.submit);
      const reportId = 9000 + seq;
      const reportNo = 'ER' + year + String(quarter).padStart(2, '0') + String(1000 + seq).slice(-4);
      const blk = submit ? nextBlock() : null;
      const txId = submit ? pseudoHash('ER-' + reportNo) : null;
      unshiftRow('/api/enterprise/reports', {
        id: reportId, report_no: reportNo, year, quarter, period: year + 'Q' + quarter,
        scope1_emission: null, scope2_emission: null, total_emission: submit ? total : total,
        energy_consumption: null, output_value: null, intensity: null, yoy_rate: null,
        data_source: (body && body.dataSource) || '排放因子法',
        status: submit ? 'SUBMITTED' : 'DRAFT',
        submit_time: submit ? nowStr() : null, verify_time: null,
        chain_block_index: blk, chain_tx_id: txId, remark: null, verifier_name: null,
      });
      return envelope({
        reportId, reportNo, total,
        chain: blk ? { blockIndex: blk, txId } : null,
      });
    }

    if ((m = path.match(/^\/api\/enterprise\/reports\/([^/]+)\/submit$/))) {
      const blk = nextBlock();
      const txId = pseudoHash('ER-submit-' + m[1] + '-' + blk);
      patchRow('/api/enterprise/reports', 'id', m[1], {
        status: 'SUBMITTED', submit_time: nowStr(), chain_block_index: blk, chain_tx_id: txId,
      });
      return envelope({ chain: { blockIndex: blk, txId } });
    }

    /* ---- 配额分配 ---- */
    if (path === '/api/regulator/allocations') {
      const seq = nextSeq();
      const year = Number((body && body.year) || new Date().getFullYear());
      const amount = Number((body && body.amount) || 0);
      const blk = nextBlock();
      const allocNo = 'QA' + year + 'A' + String(100 + seq).slice(-3);
      const entId = Number((body && body.entId) || 0);
      const entFixture = findFixture('/api/regulator/enterprises', 'reg');
      const entRows = (entFixture && listOf(entFixture.response.data)) || [];
      const ent = entRows.find((e) => String(e.id) === String(entId)) || {};
      unshiftRow('/api/regulator/allocations', {
        id: 9000 + seq, alloc_no: allocNo, ent_id: entId, year,
        quota_amount: amount, alloc_type: (body && body.allocType) || 'FREE',
        alloc_method: (body && body.allocMethod) || '历史强度法',
        baseline_intensity: (body && body.baseline) || null,
        operator: (global.App && global.App.Store && global.App.Store.user && global.App.Store.user.realName) || '监管员',
        chain_block_index: blk, chain_tx_id: pseudoHash('QA-' + allocNo),
        created_at: nowStr(), ent_name: ent.ent_name || ent.name || '-',
        industry: ent.industry || '-', region: ent.region || '-',
      });
      return envelope({ allocNo, chain: { blockIndex: blk, txId: pseudoHash('QA-' + allocNo) } });
    }

    /* ---- 预警处理 ---- */
    if ((m = path.match(/^\/api\/regulator\/alerts\/([^/]+)\/handle$/))) {
      patchRow('/api/regulator/alerts', 'id', m[1], {
        status: (body && body.status) || 'HANDLING',
        handle_note: (body && body.note) || null,
        handler: (global.App && global.App.Store && global.App.Store.user && global.App.Store.user.realName) || '监管员',
        closed_at: (body && body.status) === 'CLOSED' ? nowStr() : null,
      });
      return envelope({ ok: true });
    }

    /* ---- 通知公告 ---- */
    if (path === '/api/regulator/notices') {
      const seq = nextSeq();
      unshiftRow('/api/regulator/notices', Object.assign({
        id: 9000 + seq, views: 0, publisher: '监管端', publish_time: nowStr(),
      }, body || {}));
      return envelope({ ok: true, id: 9000 + seq });
    }

    /* ---- 核查任务：受理 ---- */
    if ((m = path.match(/^\/api\/verifier\/tasks\/([^/]+)\/accept$/))) {
      patchRow('/api/verifier/tasks', 'id', m[1], { status: 'PROCESSING', report_status: 'VERIFYING' });
      return envelope({ ok: true });
    }

    /* ---- 核查任务：出具报告 ---- */
    if ((m = path.match(/^\/api\/verifier\/tasks\/([^/]+)\/verify$/))) {
      const seq = nextSeq();
      const blk = nextBlock();
      const vrId = 9000 + seq;
      const vrNo = 'VR' + new Date().getFullYear() + String(vrId).slice(-5);
      patchRow('/api/verifier/tasks', 'id', m[1], {
        status: 'DONE', report_status: 'VERIFIED', finish_time: nowStr(),
      });
      unshiftRow('/api/verifier/reports', {
        id: vrId, report_no: vrNo, task_id: Number(m[1]), emission_report_id: null, ent_id: null, verifier_id: null,
        declared_value: null, verified_value: (body && body.verifiedValue) || null, deviation_rate: null,
        conclusion: (body && body.conclusion) || 'PASS', opinion: (body && body.opinion) || '',
        auditor: (global.App && global.App.Store && global.App.Store.user && global.App.Store.user.realName) || '核查员',
        seal_hash: pseudoHash('VR-seal-' + vrNo), chain_block_index: blk,
        chain_tx_id: pseudoHash('VR-' + vrNo), issue_time: nowStr(), created_at: nowStr(),
        ent_name: '-', industry: '-', period: '-', emission_report_no: '-',
      });
      return envelope({
        verifyReportId: vrId, verifyReportNo: vrNo,
        conclusion: (body && body.conclusion) || 'PASS',
        seal: pseudoHash('VR-seal-' + vrNo),
        chain: { blockIndex: blk, txId: pseudoHash('VR-' + vrNo) },
      });
    }

    /* ---- 碳信用抵销 ---- */
    if (path === '/api/credit/offset') {
      const amount = Number((body && body.amount) || 0);
      const blk = nextBlock();
      const seq = nextSeq();
      unshiftRow('/api/credit/offsets', {
        id: 9000 + seq, offset_no: 'CO' + String(900000 + seq), asset_id: (body && body.assetId) || null,
        amount, purpose: '履约抵销', status: 'DONE', chain_block_index: blk,
        chain_tx_id: pseudoHash('CO-' + seq), created_at: nowStr(), operator: '交易端',
      });
      return envelope({ amount, quotaAfter: quotaAfter(amount), chain: { blockIndex: blk } });
    }

    /* ---- 交易：委托下单 / 撤单 / 抵销清缴 ---- */
    if (path === '/api/trade/orders') {
      const seq = nextSeq();
      const price = Number((body && body.price) || 0);
      const amount = Number((body && body.amount) || 0);
      const id = 9000 + seq;
      unshiftRow('/api/trade/orders', {
        id, order_no: 'TO' + String(900000 + seq), side: (body && body.side) || 'BUY',
        price, amount, filled: 0, status: 'OPEN', created_at: nowStr(),
      });
      return envelope({
        orderId: id, matchedCount: 0,
        chain: { blockIndex: nextBlock() },
      });
    }

    if ((m = path.match(/^\/api\/trade\/orders\/([^/]+)\/cancel$/))) {
      patchRow('/api/trade/orders', 'id', m[1], { status: 'CANCELLED' });
      return envelope({ ok: true });
    }

    if (path === '/api/trade/offset') {
      const amount = Number((body && body.amount) || 0);
      const blk = nextBlock();
      const seq = nextSeq();
      unshiftRow('/api/credit/offsets', {
        id: 9000 + seq, offset_no: 'CO' + String(900000 + seq), asset_id: (body && body.assetId) || null,
        amount, purpose: '履约抵销（交易端）', status: 'DONE', chain_block_index: blk,
        chain_tx_id: pseudoHash('CO-t-' + seq), created_at: nowStr(), operator: '交易端',
      });
      return envelope({ amount, quotaAfter: quotaAfter(amount), chain: { blockIndex: blk } });
    }

    /* ---- 因子库 ---- */
    if (path === '/api/admin/factors') {
      const seq = nextSeq();
      unshiftRow('/api/admin/factors', Object.assign({
        id: 9000 + seq, status: 'ACTIVE', version: 'v' + new Date().getFullYear() + '.' + seq,
        effectiveFrom: nowStr(), effectiveTo: null, remark: null, industry: null,
      }, body || {}));
      return envelope({ ok: true });
    }

    if (path === '/api/admin/factors/publish') {
      const seq = nextSeq();
      const blk = nextBlock();
      const version = 'v' + new Date().getFullYear() + '.' + seq;
      const vf = findFixture('/api/admin/factor-versions', 'admin');
      const rows = vf ? listOf(vf.response.data) : null;
      const ff = findFixture('/api/admin/factors', 'admin');
      const fl = ff ? listOf(ff.response.data) : null;
      const factorCount = fl ? fl.length : 0;
      if (rows) {
        rows.unshift({
          id: 9000 + seq, version, factorCount, status: 'ACTIVE',
          effectiveFrom: (body && body.effectiveFrom) || nowStr(),
          chain_block_index: blk, chain_tx_id: pseudoHash('FV-' + version),
          publishedBy: '管理员', createdAt: nowStr(),
        });
      }
      return envelope({ version, factorCount, chain: { blockIndex: blk } });
    }

    /* ---- 联盟链运维 ---- */
    if (path === '/api/consortium/sync') {
      const nf = findFixture('/api/consortium/nodes', 'public') || findFixture('/api/consortium/nodes', 'reg');
      const nodes = (nf && listOf(nf.response.data)) || [];
      return envelope(nodes.map((n) => ({ nodeId: n.nodeId || n.node_id, synced: 0 })));
    }
    if ((m = path.match(/^\/api\/consortium\/nodes\/([^/]+)\/sync$/))) {
      return envelope({ nodeId: m[1], synced: 0 });
    }
    if (/^\/api\/consortium\/nodes\/([^/]+)\/(desync|approve|revoke)$/.test(path)) {
      const mm = path.match(/\/nodes\/([^/]+)\/(desync|approve|revoke)$/);
      if (mm[2] === 'approve') patchRow('/api/consortium/nodes', 'nodeId', mm[1], { status: 'ACTIVE' });
      if (mm[2] === 'revoke') patchRow('/api/consortium/nodes', 'nodeId', mm[1], { status: 'REVOKED' });
      if (mm[2] === 'desync') patchRow('/api/consortium/nodes', 'nodeId', mm[1], { status: 'PENDING' });
      return envelope({ ok: true, nodeId: mm[1] });
    }
    if (path === '/api/consortium/nodes/apply') {
      return envelope({ ok: true, status: 'PENDING' });
    }

    /* ---- 动态核算 ---- */
    if (path === '/api/dynamic/ingest') {
      return envelope({ inserted: 288, days: (body && body.days) || 1, at: nowStr() });
    }
    if (path === '/api/dynamic/recompute') {
      return envelope({ count: 60, at: nowStr() });
    }

    /* ---- 链上篡改 / 修复演示 ---- */
    if (path === '/api/chain/tamper') {
      const idx = Number((body && body.blockIndex) || S.chainCursor - 1);
      invalidateValidate(idx);
      return envelope({
        blockIndex: idx, field: (body && body.field) || 'merkle_root', changedKey: 'payload',
        validation: { valid: false, errors: [{ blockIndex: idx, reason: '区块哈希与重算结果不一致' }] },
        at: nowStr(),
      });
    }
    if (path === '/api/chain/repair-payload') {
      const idx = Number((body && body.blockIndex) || S.chainCursor - 1);
      return envelope({ blockIndex: idx, restored: 3, validation: { valid: true, errors: [] }, at: nowStr() });
    }
    if (path === '/api/chain/repair') {
      const from = Number((body && body.fromIndex) || S.chainCursor - 1);
      invalidateValidate(-1);
      return envelope({
        repaired: [{ blockIndex: from, cost: 128, hash: pseudoHash('repair-' + from) }],
        at: nowStr(),
      });
    }

    /* ---- 运维灰度 ---- */
    if (path === '/api/ops/canary') {
      const cf = findFixture('/api/ops/canary', 'reg') || findFixture('/api/ops/canary', 'admin');
      const data = cf ? clone(cf.response.data) : { features: [] };
      const feats = data.features || data.flags || [];
      const target = feats.find((x) => (x.key || x.feature) === (body && body.feature));
      if (target) target.enabled = !!(body && body.enabled);
      return envelope(data);
    }

    /* ---- 智能体（有动作快照时上面已命中，此处兜底） ---- */
    if (path === '/api/intelligence/simulate') {
      const rep = findFixture('/api/intelligence/report', 'ent');
      const d = rep ? clone(rep.response.data) : {};
      d.scenarios = (body && body.scenarios) || [];
      d.at = nowStr();
      return envelope(d);
    }

    /* ---- 工业设备接入（WP1）：准入治理就地变更台账，刷新即可见 ---- */
    if ((m = path.match(/^\/api\/iot\/devices\/([^/]+)\/auth$/))) {
      const did = decodeURIComponent(m[1]);
      const status = String((body && body.status) || '').toUpperCase();
      if (['ACTIVE', 'PENDING', 'REVOKED'].indexOf(status) < 0) return envelope(null, 400, 'status 必须是 ACTIVE / PENDING / REVOKED 之一');
      let prev = null; let mn = '';
      mutateList('/api/iot/devices', (arr) => {
        const row = arr.find((r) => String(r.device_did) === did);
        if (row) { prev = row.auth_status; mn = row.mn; row.auth_status = status; }
      });
      if (prev === null) return envelope(null, 404, '设备 ' + did + ' 不存在');
      return envelope({ device_did: did, mn, auth_status: status, previous: prev, affected: 1 }, 0,
        '设备 ' + (mn || did) + ' 授权状态已由 ' + prev + ' 变更为 ' + status + '（静态演示：变更仅存于浏览器内存）');
    }
    if ((m = path.match(/^\/api\/iot\/devices\/([^/]+)\/bind$/))) {
      const did = decodeURIComponent(m[1]);
      const entId = Number(body && body.entId);
      const monitorNo = (body && body.monitorNo) || '';
      if (!entId) return envelope(null, 400, '归属企业 entId 必填');
      const ef = findFixture('/api/regulator/enterprises', 'reg') || findFixture('/api/regulator/enterprises', 'admin');
      const ents = ef ? listOf(ef.response.data) : [];
      const ent = ents.find((e) => Number(e.id || e.ent_id) === entId);
      const entName = (ent && (ent.ent_name || ent.name)) || ('企业 #' + entId);
      let found = false;
      mutateList('/api/iot/devices', (arr) => {
        const row = arr.find((r) => String(r.device_did) === did);
        if (!row) return;
        found = true;
        row.ent_id = entId; row.ent_name = entName;
        if (monitorNo) row.monitor_no = monitorNo;
      });
      if (!found) return envelope(null, 404, '设备 ' + did + ' 不存在');
      return envelope({ device_did: did, entId, entName, monitorNo: monitorNo || null, affected: 1 }, 0,
        '设备已绑定至 ' + entName + (monitorNo ? ' · ' + monitorNo : '') + '（静态演示：绑定仅存于浏览器内存）');
    }
    /* 离线看门狗依赖真实时序库判定"静默"，静态快照无此能力 —— 如实返回空巡检结果，不伪造补记 */
    if (path === '/api/iot/offline-sweep') {
      return envelope({
        silentMinutes: Number((body && body.silentMinutes) || 180),
        cooldownMinutes: Number((body && body.cooldownMinutes) || 60),
        evidenceOnly: true, scope: 'ALL', candidates: 0, marked: 0, details: [],
        batchNo: null, staticMode: true, at: nowStr(),
      }, 0, '静态演示模式：离线看门狗需连接实时数据库，此处不产生补记记录');
    }

    /* ---- 审计日志哈希链（WP6）：封印是"补上后手牌"，静态层无未封印条目 ---- */
    if (path === '/api/ops/audit-chain/seal') {
      const sf = findFixture('/api/ops/audit-chain', 'reg') || findFixture('/api/ops/audit-chain', 'admin');
      const d = (sf && sf.response.data) || {};
      return envelope({ sealed: 0, remaining: Number(d.unsealed || 0), staticMode: true, at: nowStr() },
        0, '静态演示模式：快照内条目均已封印，无待封印内容（幂等）');
    }

    /* ---- WP4 核算不确定度：报告上链（静态层返回合成区块号，不真实写链） ---- */
    if ((m = path.match(/^\/api\/uncertainty\/report\/([^/]+)\/anchor$/))) {
      const entId = m[1];
      const blk = nextBlock();
      return envelope({
        entId: Number(entId), entName: '企业 #' + entId, year: new Date().getFullYear(),
        chain: { blockIndex: blk, txId: pseudoHash('UR-' + entId + '-' + blk) },
        annual: null, relativeUncertainty: null, crossCheck: null, verdict: null,
      }, 0, '静态演示模式：报告摘要已生成（区块 #' + blk + '），不落库');
    }
    if (path === '/api/uncertainty/recompute') {
      const ids = (body && Array.isArray(body.entIds) && body.entIds.length)
        ? body.entIds.map(Number).filter(Number.isFinite) : null;
      const total = ids ? ids.length : 60;
      return envelope({ total, saved: total, skipped: [], failed: [], staticMode: true },
        0, '静态演示模式：后验区间按快照数据就地重算，共 ' + total + ' 家');
    }

    /* ---- WP2 密钥治理：签名/验签/轮换举证均为取证，静态层用确定性伪签名应答，
            但明确标注"非真实 SM2"，绝不伪造"验签通过"误导评审 ---- */
    if (path === '/api/keys/sign') {
      const label = (body && body.keyLabel) || '';
      if (!label) return envelope(null, 400, '缺少 keyLabel');
      const digest = pseudoHash('SM3-' + label + '|' + JSON.stringify(body && body.payload));
      return envelope({
        keyLabel: label, keyId: 1, address: pseudoHash('addr-' + label),
        publicKeyFingerprint: pseudoHash('fp-' + label), algorithm: 'SM2-with-SM3',
        generation: 'CURRENT', payloadDigest: { algorithm: 'SM3', digest },
        signature: pseudoHash('SIG-' + label + '-' + Date.now()),
        staticMode: true,
      }, 0, '静态演示模式：此处为演示用伪签名，真实 SM2 签名需连接后端');
    }
    if (path === '/api/keys/verify') {
      /* 静态层没有真实私钥，无法给出可信验签结果 —— 如实返回"静态模式不验签" */
      return envelope({
        keyLabel: (body && body.keyLabel) || '', valid: null, generation: null,
        reason: '静态演示模式不提供 SM2 验签（无真实私钥/公钥对），请连接后端取证', staticMode: true,
      }, 0, '静态演示模式：验签需真实密钥对，此处不伪造结果');
    }
    if (path === '/api/keys/rotation-safety-demo' || path === '/api/keys/rotations'
      || /^\/api\/keys\/rotations\/[^/]+\/(approve|reject)$/.test(path)) {
      return envelope({
        staticMode: true, allPass: null,
        conclusion: '静态演示模式不执行密钥轮换与轮换举证：轮换会真实改写密钥库，'
          + '且历史签名验签需要真实 SM2 密钥对，请连接后端在 /keys 页面取证。',
      }, 0, '静态演示模式：轮换与轮换举证需真实密钥对，此处不执行');
    }

    /* ---- WP5 国际互认：CBAM 试算/生成、绿电匹配、双轨报告导出 ---- */
    if (path === '/api/cbam/calc') {
      const cf = findFixture('/api/cbam/catalog', 'reg') || findFixture('/api/cbam/catalog', 'admin');
      const catalog = (cf && cf.response.data) || {};
      const code = (body && body.cnCode) || ((catalog.cnCodes && catalog.cnCodes[0] && catalog.cnCodes[0].code) || '');
      const item = (catalog.cnCodes || []).find((x) => x.code === code) || {};
      const quantity = Number((body && body.quantity)) || 1000;
      const intensity = Number(item.euDefaultIntensity) || 1.2;
      return envelope({
        entId: (body && body.entId), entName: '演示企业', industry: item.sector || '钢铁',
        period: (body && body.period) || '2026Q1', cnCode: code, cnGoods: item.goods || '-',
        cnCovered: true, sector: item.sector || '-', unit: item.unit || 't', quantity,
        embeddedIntensity: intensity, totalEmission: Math.round(intensity * quantity * 100) / 100,
        benchmark: { euDefaultIntensity: intensity, euDefaultTotal: Math.round(intensity * quantity * 100) / 100, penaltyTco2: 0, verdict: '静态演示试算' },
        staticMode: true,
      }, 0, '静态演示模式：CBAM 试算按快照目录的 EU 默认强度估算，仅供界面演示');
    }
    if (path === '/api/cbam/generate') {
      const blk = nextBlock(); const seq = nextSeq();
      const declNo = 'CBAM-STATIC-' + String(9000 + seq);
      return envelope({
        id: 9000 + seq, declNo, calc: { cnGoods: '演示商品', embeddedIntensity: 1.2, unit: 't' },
        digest: { algorithm: 'SM3', digest: pseudoHash(declNo) },
        chain: { blockIndex: blk, txId: pseudoHash('CBAM-' + declNo) },
        carbonPricePaid: 0,
      }, 0, '静态演示模式：申报包 ' + declNo + ' 已生成（区块 #' + blk + '），不落库');
    }
    if (path === '/api/greenpower/match') {
      const sf = findFixture('/api/greenpower/summary', 'reg') || findFixture('/api/greenpower/summary', 'admin');
      const s = ((sf && sf.response.data) || {});
      return envelope({
        summary: {
          hours: s.hours || 0, coverageRatio: s.coverageRatio || 0, savedTco2: s.savedTco2 || 0,
          hoursMatched: s.hoursMatched || 0, hoursPartial: s.hoursPartial || 0, hoursUnmatched: s.hoursUnmatched || 0,
        }, staticMode: true,
      }, 0, '静态演示模式：绿电匹配按快照基线应答，不产生新记录');
    }
    if (path === '/api/report/export') {
      const std = ((body && body.std) || '14064').replace(/[^0-9]/g, '');
      const blk = nextBlock(); const seq = nextSeq();
      const title = 'ISO ' + (std === '14067' ? '14067' : '14064-1') + ' 报告（静态演示）';
      return envelope({
        id: 9000 + seq, std: 'ISO ' + (std === '14067' ? '14067' : '14064-1'), title,
        period: (body && body.period) || '2026Q1',
        payload: { title, staticMode: true },
        digest: { algorithm: 'SM3', digest: pseudoHash('REP-' + seq) },
        fileFingerprint: pseudoHash('FILE-' + seq),
        chain: { blockIndex: blk, txId: pseudoHash('REP-' + seq) },
        crossCheck: { orgTotal: 1000, productTotal: 900 },
      }, 0, '静态演示模式：双轨报告已生成并上链（区块 #' + blk + '），不落库');
    }

    /* ---- 退出登录 ---- */
    if (path === '/api/auth/logout') return envelope({ ok: true });

    /* ================================================================
     * 第 2 轮（WP2 密码学 / WP4 核算升级 / WP5 国际互认）
     * ----------------------------------------------------------------
     * 原则与前文一致：能由快照推出的就地合成并更新列表；需要真实密码学
     * 或时序库能力的，如实返回 staticMode 标记，**不伪造结论**。
     * ================================================================ */

    /* ---- WP2：国密签名取证 ----
       快照里存着一对真实的 (基准载荷, SM2 签名)。载荷一致时返回那把真签名；
       其它载荷没有真实 SM2 可用，于是如实标注 algorithm=STATIC-DEMO 并由本层
       自洽签发，使"签 → 验"闭环仍可点，且绝不冒充国密。 */
    if (path === '/api/keys/sign' || path === '/api/keys/verify') {
      const base = S.actions.find((a) => a.path === '/api/keys/sign');
      const basePayload = base && base.body ? base.body.payload : null;
      const baseSig = base && base.response && base.response.data ? base.response.data.signature : null;
      const inLabel = (body && body.keyLabel) || 'ent:9';
      const inCanon = body ? stableKey(body.payload) : '';
      const baseCanon = basePayload !== null ? stableKey(basePayload) : '';
      const memoKey = inLabel + '|' + inCanon;

      if (path === '/api/keys/sign') {
        if (baseSig && inCanon === baseCanon) return clone(base.response);
        const sig = pseudoHash('STATIC-DEMO|' + memoKey);
        S.demoSigs.set(memoKey, sig);
        return envelope({
          keyLabel: inLabel, keyId: 1,
          address: pseudoHash('ADDR|' + inLabel).slice(0, 42),
          publicKeyFingerprint: pseudoHash('FP|' + inLabel),
          algorithm: 'STATIC-DEMO（静态站点无 SM2 实现，此签名不是真实国密签名）',
          generation: 'CURRENT',
          payloadDigest: { algorithm: 'SM3', digest: pseudoHash('SM3|' + inCanon) },
          signature: sig, signedAt: nowStr(), staticMode: true,
        }, 0, '静态演示模式：该载荷未经真实 SM2 签名');
      }

      const sig = (body && body.signature) || '';
      if (baseSig && sig === baseSig && inCanon === baseCanon) return clone(base.response);
      if (S.demoSigs.get(memoKey) === sig && sig) {
        return envelope({
          keyLabel: inLabel, valid: true, keyId: 1, generation: 'CURRENT',
          address: pseudoHash('ADDR|' + inLabel).slice(0, 42),
          note: '静态演示模式：由静态层自洽比对（非真实国密验签）',
        });
      }
      return envelope({
        keyLabel: inLabel, valid: false,
        reason: '静态快照模式下仅能核验「快照基准载荷 + 基准签名」这一对组合；'
          + '其余组合一律判为不通过 —— 宁可误拒，不可误放。',
      });
    }

    /* ---- WP2：密钥轮换申请（下一世代密钥在复核通过后才生成） ---- */
    if (path === '/api/keys/rotations') {
      const keyLabel = (body && body.keyLabel) || '';
      if (!keyLabel) return envelope(null, 400, '缺少 keyLabel');
      const list = findFixture('/api/keys/rotations', 'admin') || findFixture('/api/keys/rotations', 'reg');
      const rows = list && Array.isArray(list.response.data) ? list.response.data : null;
      if (rows && rows.some((r) => r.key_label === keyLabel && r.approval_status === 'PENDING')) {
        return envelope(null, 400, `主体 ${keyLabel} 已存在待复核的轮换申请，请先处理`);
      }
      const seq = nextSeq();
      const id = 9000 + seq;
      const invRow = (invanceOf(keyLabel) || {});
      const row = {
        id, key_label: keyLabel, key_type: 'SM2', action: 'ROTATE',
        old_address: invRow.address || null, new_address: null,
        old_fingerprint: invRow.fingerprint || null, new_fingerprint: null,
        reason: (body && body.reason) || '常规轮换',
        requested_by: (body && body.requestedBy) || userName(),
        approved_by: null, approval_status: 'PENDING', approval_note: null,
        approved_at: null, chain_tx_id: null, block_index: null,
        created_at: nowStr(), dualControlOk: false,
      };
      unshiftRow('/api/keys/rotations', row);
      return envelope({
        id, keyLabel, action: 'ROTATE', status: 'PENDING',
        currentGeneration: invRow.generations || 1,
        currentAddress: row.old_address, currentFingerprint: row.old_fingerprint,
        requestedBy: row.requested_by,
        rule: '下一世代的密钥对在复核通过之后才生成 —— 未批准前不产生任何新私钥。',
        staticMode: true,
      }, 0, '静态演示模式：台账变更仅存于浏览器内存，未真正轮换密钥');
    }

    /* ---- WP2：双人复核（approve / reject） ---- */
    if ((m = path.match(/^\/api\/keys\/rotations\/([^/]+)\/(approve|reject)$/))) {
      const id = m[1]; const verb = m[2];
      const actor = (body && body.approvedBy) || userName();
      const list = findFixture('/api/keys/rotations', 'admin') || findFixture('/api/keys/rotations', 'reg');
      const rows = list && Array.isArray(list.response.data) ? list.response.data : [];
      const target = rows.find((r) => String(r.id) === String(id));
      if (!target) return envelope(null, 404, `轮换申请 #${id} 不存在`);
      if (target.approval_status !== 'PENDING') {
        return envelope(null, 400, `轮换申请 #${id} 当前状态为 ${target.approval_status}，不可重复复核`);
      }
      /* ★ 双人复核是服务层强制：同一人既申请又复核时直接拒绝执行。
         静态层同样执行这条判据，保证演示态不会给出与真实后端相反的结论。 */
      if (String(actor) === String(target.requested_by)) {
        return envelope(null, 400,
          `双人复核未满足：复核人「${actor}」与申请人相同。轮换被拒绝执行（approved_by 必须 ≠ requested_by）。`);
      }
      if (verb === 'reject') {
        patchRow('/api/keys/rotations', 'id', id, {
          approval_status: 'REJECTED', approved_by: actor, approval_note: (body && body.note) || null,
          approved_at: nowStr(), dualControlOk: true,
        });
        return envelope({ id: Number(id), status: 'REJECTED', approvedBy: actor, staticMode: true }, 0, '已驳回');
      }
      const blk = nextBlock();
      const newAddr = pseudoHash('ADDR2|' + target.key_label).slice(0, 42);
      const newFp = pseudoHash('FP2|' + target.key_label);
      patchRow('/api/keys/rotations', 'id', id, {
        approval_status: 'APPROVED', approved_by: actor, approval_note: (body && body.note) || null,
        approved_at: nowStr(), block_index: blk,
        chain_tx_id: pseudoHash('KEYROT|' + id),
        new_address: newAddr, new_fingerprint: newFp,
        dualControlOk: true,
      });
      /* 字段名对齐服务层真实返回：oldGeneration / newGeneration（不是 from/toAddress） */
      return envelope({
        id: Number(id), keyLabel: target.key_label, status: 'APPROVED',
        requestedBy: target.requested_by, approvedBy: actor,
        oldGeneration: { keyId: 1, address: target.old_address, fingerprint: target.old_fingerprint },
        newGeneration: { keyId: 2, address: newAddr, fingerprint: newFp },
        chain: { blockIndex: blk, txId: pseudoHash('KEYROT|' + id) },
        reminder: '历史签名不受影响：旧公钥已作为历史世代保留，可用它继续验签。',
        staticMode: true,
      }, 0, '轮换已生效并上链（静态演示：台账变更仅存于浏览器内存）');
    }

    /* ---- WP4：不确定度报告上链 ---- */
    if ((m = path.match(/^\/api\/uncertainty\/report\/([^/]+)\/anchor$/))) {
      const entId = Number(m[1]) || 1;
      const rf = findFixture('/api/uncertainty/report/' + entId, role) || findFixture('/api/uncertainty/report/1', 'reg');
      const d = (rf && rf.response.data) || {};
      const blk = nextBlock();
      return envelope({
        entId, entName: d.entName || null, year: d.year || null,
        chain: { blockIndex: blk, txId: pseudoHash('UR|' + entId), txType: 'UNCERTAINTY_REPORT' },
        annual: d.posterior && d.posterior.annual ? d.posterior.annual.mean : null,
        relativeUncertainty: d.propagation ? d.propagation.relativeUncertainty : null,
        crossCheck: d.crossCheck || null,
        verdict: d.modelEval ? d.modelEval.verdict : null,
        staticMode: true,
      }, 0, `不确定度报告已上链（静态演示：区块 #${blk}，未写入真实链）`);
    }

    /* ---- WP4：批量重算 ---- */
    if (path === '/api/uncertainty/recompute') {
      const sf = findFixture('/api/uncertainty/industry', 'reg') || findFixture('/api/uncertainty/industry', 'admin');
      const d = (sf && sf.response.data) || {};
      const total = Number(d.scanned || 0);
      const saved = Number(d.available || 0);
      return envelope({
        total, saved, skipped: [], failed: [],
        staticMode: true,
      }, 0, `静态演示模式：按快照统计可评估 ${saved}/${total} 家；真实重算需连接数据库`);
    }

    /* ---- WP5：CBAM 申报包生成 ---- */
    if (path === '/api/cbam/generate') {
      const cf = S.actions.find((a) => a.path === '/api/cbam/calc');
      if (!cf) return null;
      const base = clone(cf.response.data);
      const seq = nextSeq();
      const blk = nextBlock();
      const period = (body && body.period) || base.period || '2026Q1';
      const declNo = 'CBAM-' + String(period).replace(/[^0-9A-Z]/gi, '') + '-GOODS-' + String(9000 + seq).slice(-4);
      const txId = pseudoHash('CBAM|' + declNo);
      unshiftRow('/api/cbam/declarations', {
        id: 9000 + seq, decl_no: declNo, ent_id: base.entId, ent_name: base.entName,
        period, cn_code: base.cnCode, goods_name: base.cnGoods, goods_quantity: base.quantity,
        quantity_unit: base.unit, direct_emission: base.directEmission,
        indirect_emission: base.indirectEmission, embedded_intensity: base.embeddedIntensity,
        evidence_digest: pseudoHash('CBAMD|' + declNo), status: 'GENERATED',
        chain_tx_id: txId, block_index: blk, created_at: nowStr(),
      });
      return envelope({
        id: 9000 + seq, declNo, calc: base, chain: { blockIndex: blk, txId },
        digest: { algorithm: 'SM3', digest: pseudoHash('CBAMD|' + declNo) },
        carbonPricePaid: 0,
        staticMode: true,
      }, 0, `申报包 ${declNo} 已生成（静态演示：样例企业 ${base.entName} 的快照试算结果）`);
    }

    /* ---- WP5：小时级绿电匹配 / 双轨报告导出 ----
       两者都需要读取时序库做真实关联计算，静态站点不具备该能力。
       按既有约定（同 /api/iot/offline-sweep）如实返回 staticMode，不伪造结果。 */
    if (path === '/api/greenpower/match') {
      return envelope({
        staticMode: true, summary: null, hourly: [], byCert: [], staticReason: 'HOURLY_JOIN_REQUIRED',
      }, 0, '静态演示模式：小时级绿电匹配需读写时序数据库，请在本地 npm start 或在线模式下执行');
    }
    if (path === '/api/report/export') {
      return envelope({
        staticMode: true, std: null, payload: null, staticReason: 'DB_WRITE_REQUIRED',
      }, 0, '静态演示模式：双轨报告导出需落库并上链，请在本地 npm start 或在线模式下执行');
    }

    return null;
  }

  /** 当前登录用户显示名（静态层合成响应时填 operator 字段用） */
  function userName() {
    const u = global.App && global.App.Store && global.App.Store.user;
    return (u && (u.realName || u.username)) || 'admin';
  }

  /** 从密钥台账快照里取某主体的当前世代信息 */
  function invanceOf(label) {
    const f = findFixture('/api/keys/inventory', 'admin') || findFixture('/api/keys/inventory', 'reg');
    const rows = f && Array.isArray(f.response.data) ? f.response.data : [];
    const rec = rows.find((r) => r.label === label);
    if (!rec) return null;
    return {
      address: rec.current && rec.current.address,
      fingerprint: rec.current && rec.current.fingerprint,
      generations: rec.generations || 1,
    };
  }

  /** 篡改后让 /api/chain/validate 也反映出异常（再修复时恢复） */
  function invalidateValidate(blockIndex) {
    const pm = S.byPath.get('GET /api/chain/validate');
    if (!pm) return;
    pm.forEach((f) => {
      const d = f.response && f.response.data;
      if (!isObject(d)) return;
      if (blockIndex < 0) {
        d.valid = true; d.errors = [];
      } else {
        d.valid = false;
        d.errors = [{ blockIndex, reason: '区块哈希与重算结果不一致（静态演示）' }];
      }
    });
  }

  /* ==================================================================
   * 4. 探测 + 快照装载
   * ================================================================== */
  async function probeMode() {
    if (!nativeFetch || !global.location || !/^https?:/.test(global.location.protocol)) return 'static';
    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, PROBE_TIMEOUT_MS) : null;
      const res = await nativeFetch(PROBE_URL, {
        headers: { Accept: 'application/json' },
        signal: ctl ? ctl.signal : undefined,
        cache: 'no-store',
      });
      if (timer) clearTimeout(timer);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('json') < 0) return 'static';
      const j = await res.json();
      return j && j.code === 0 ? 'live' : 'static';
    } catch (e) {
      return 'static';
    }
  }

  async function loadBundle() {
    if (!nativeFetch) throw new Error('无 fetch 实现');
    const res = await nativeFetch(SNAPSHOT_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('快照 HTTP ' + res.status);
    return res.json();
  }

  function boot() {
    if (S.booting) return S.booting;
    S.booting = (async () => {
      S.mode = await probeMode();
      if (S.mode === 'static') {
        global.__CCH_DISABLE_WS__ = true;   // 静态站无 WS 服务，直接走归档序列，避免无谓失败请求
        try {
          buildIndex(await loadBundle());
          console.info('[StaticApi] 静态数据模式已启用 · 快照 ' + S.bundle.fixtures.length
            + ' 条读快照 / ' + S.actions.length + ' 条动作快照 / 账号 ' + Object.keys(S.bundle.logins || {}).length + ' 个');
        } catch (e) {
          S.error = e.message || String(e);
          console.error('[StaticApi] 快照装载失败，将降级为空数据：', S.error);
        }
      } else {
        console.info('[StaticApi] 在线模式：/api/* 直连真实后端');
      }
      return S.mode;
    })();
    return S.booting;
  }

  /* ==================================================================
   * 5. fetch 层拦截
   * ================================================================== */
  function staticRespond(method, api, init, url) {
    let body = null;
    if (init && typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch (e) { body = null; } }
    const role = currentRole(init);

    if (method === 'GET' || method === 'HEAD') {
      const got = resolveGet(api.path, api.query, role);
      if (got) {
        S.stats.hit++;
        if (S.stats.hit === 1) console.info('[StaticApi] 快照开始应答请求，首个命中：' + api.path);
        return jsonRes(envelope(got.data));
      }
      S.stats.miss++;
      console.warn('[StaticApi] 快照未覆盖，返回空结构：' + api.path + (api.query || ''));
      return jsonRes(envelope({
        rows: [], list: [], items: [], entries: [], total: 0, page: 1, size: 10, pages: 1,
        alerts: [], nodes: [], quotes: [], suggestions: [], tables: [],
      }));
    }

    S.stats.write++;
    if (api.path === '/api/auth/login') {
      const r = handleLogin(body);
      return jsonRes(r.env, r.status);
    }

    /* 载荷敏感的端点不经通用动作快照：否则任意载荷都会命中同一份快照，
       把"篡改载荷应当验签失败"这类负向用例变成永远 PASS —— 那是假证据。 */
    const BODY_SENSITIVE = { '/api/keys/sign': 1, '/api/keys/verify': 1 };
    const action = BODY_SENSITIVE[api.path] ? null : S.actions.find((a) => a.path === api.path);
    if (action) {
      if (api.path === '/api/admin/reconcile') {
        const hf = findFixture('/api/admin/reconciliations', 'admin');
        const rows = hf ? listOf(hf.response.data) : null;
        if (rows) {
          rows.unshift({
            reconNo: 'RC' + String(Date.now()).slice(-10),
            totalRecords: action.response.data.total,
            inconsistent: action.response.data.inconsistent,
            createdAt: nowStr(),
          });
        }
      }
      return jsonRes(action.response);
    }

    const synth = synthPost(api.path, body, role);
    if (synth) return jsonRes(synth);
    S.stats.route++;
    return jsonRes(envelope({ ok: true, at: nowStr() }));
  }

  function install() {
    if (!nativeFetch || global.fetch.__cchPatched) { boot(); return; }
    const patched = async function (input, init) {
      const url = typeof input === 'string' ? input
        : (input && input.url ? input.url : String(input));
      const api = splitApiUrl(url);
      if (!api) return nativeFetch(input, init);

      await boot();
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();

      if (S.mode === 'live') {
        try {
          const res = await nativeFetch(input, init);
          const ct = ((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
          if (ct.indexOf('json') >= 0) return res;
          /* 后端把 /api/* 回退成了 HTML（Pages SPA 行为）→ 永久切静态 */
          S.mode = 'static';
          if (!S.bundle) { global.__CCH_DISABLE_WS__ = true; try { buildIndex(await loadBundle()); } catch (e) { S.error = e.message; } }
          console.info('[StaticApi] 后端未提供 JSON API，已切换为静态数据模式');
        } catch (e) {
          S.mode = 'static';
          if (!S.bundle) { global.__CCH_DISABLE_WS__ = true; try { buildIndex(await loadBundle()); } catch (e2) { S.error = e2.message; } }
        }
      }
      return staticRespond(method, api, init, url);
    };
    patched.__cchPatched = true;
    global.fetch = patched;
    boot();
  }

  /* ==================================================================
   * 6. 对外接口
   * ================================================================== */
  global.App = global.App || {};
  global.App.StaticApi = {
    get mode() { return S.mode; },
    get bundle() { return S.bundle; },
    get stats() { return S.stats; },
    get error() { return S.error; },
    isStatic() { return S.mode === 'static'; },
    ready() { return boot(); },
    status() {
      return {
        mode: S.mode,
        ready: !!S.bundle,
        endpoints: S.bundle ? S.bundle.fixtures.length : 0,
        actions: S.actions.length,
        accounts: S.bundle ? Object.keys(S.bundle.logins || {}).length : 0,
        harvestedAt: S.bundle ? S.bundle.meta.harvestedAt : null,
        error: S.error,
        stats: S.stats,
      };
    },
    resolveGet(path, query, role) { return resolveGet(path, query, role || currentRole()); },
  };

  install();
})(window);
