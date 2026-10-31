/* =====================================================================
   碳链通 CarbonChain Hub —— 前端内核
   包含：API 客户端 / 全局状态 / 哈希路由 / 格式化工具 / 字典 / 图表主题
   ===================================================================== */
(function (global) {
  'use strict';

  const { reactive, ref, computed, onMounted, onUnmounted, watch, nextTick } = Vue;

  /* ==================================================================
   * 一、全局状态
   * ================================================================== */
  const Store = reactive({
    token: localStorage.getItem('cch_token') || '',
    user: JSON.parse(localStorage.getItem('cch_user') || 'null'),
    toasts: [],
    chain: { height: 0, totalBlocks: 0, totalTxs: 0, confirmed: 0, pending: 0, difficulty: 0, tipHash: '' },
    /* 静态演示模式的快照元信息（由 app.js#refreshChain 周期同步）。
     * 放进 reactive 是为了让「快照角标」有响应式依赖——StaticApi.isStatic()
     * 读的是普通对象，computed 不追踪，直接读会因缓存永不重算（实测踩过）。 */
    snap: { mode: 'unknown', harvestedAt: null },
    /* AI 顾问的共享上下文 —— 页面与 Copilot 之间唯一的契约。
     *
     * workshop: { id, name, scope, emission, energy } | null
     *           用户在 3D 数字孪生里选中的车间；Copilot 读它，
     *           使「这个车间排放多少」能解析到具体对象。
     * batchNo:  当前关注的核算批次号（页面可写入）。
     *
     * 为什么放 Store 而不是各页面自存：浮窗跨页面常驻，
     * 需要"随时读到当前选中了什么"。用共享响应式对象而非事件总线 ——
     * 事件只传递变化那一刻，而用户可能先选中、隔很久才提问，
     * 那时状态仍需可读。
     */
    copilotContext: { workshop: null, batchNo: null },
    loading: false,
    /* 【缺陷 P1-23】用户**主动登出**标记。
     *
     * 登出的瞬间会发生这种事：页面已经在跳转途中，但上一屏的 load() 还在
     * 等后端 —— 后端此时已吊销 token，返回 401「登录状态已失效，请重新登录」，
     * 页面 catch 后照常弹错。于是用户刚点「退出登录」，屏幕上同时出现
     * 「已退出登录」和「登录状态已失效」两条提示，看起来像退出失败。
     *
     * 用这个标记把"主动登出"与"令牌真的过期"分开：
     *   · 主动登出 → 残留的 401 提示一律不弹（用户知道自己刚退出）；
     *   · 被动失效 → 提示照常弹，并跳登录页（用户需要知道为什么被踢出来）。 */
    loggedOutByUser: false,
  });

  function setSession(token, user) {
    Store.token = token || '';
    Store.user = user || null;
    if (token) {
      /* 重新登录即清掉"主动登出"标记，否则下一次真过期时提示会被误吞 */
      Store.loggedOutByUser = false;
      localStorage.setItem('cch_token', token);
      localStorage.setItem('cch_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('cch_token');
      localStorage.removeItem('cch_user');
    }
  }

  /* ==================================================================
   * 一·五、灰度开关（【新增增强】2026-10-25）
   * ------------------------------------------------------------------
   * 目的：每一项新能力都能单独关闭，出问题不必回滚整批代码。
   * 读取顺序（后者覆盖前者）：
   *   ① 代码内默认值  →  ② localStorage.cch_flags  →  ③ URL 参数 ?flags=
   *   ?flags=cmdk,-table.batch   ⇒  开启 cmdk、关闭 table.batch
   * 关闭后走"原有逻辑"分支，行为与升级前完全一致。
   * ================================================================== */
  const FLAG_DEFAULTS = {
    'net.v2': true,          // 超时 / GET 重试 / 并发去重 / SWR 缓存
    'shell.collapse': true,  // 侧栏收起
    'shell.cmdk': true,      // 全局命令面板 ⌘K
    'shell.turb': true,      // 路由切换过渡
    'table.batch': true,     // 表格批量选择 / CSV 导出
    'modal.focus': true,     // 弹窗 ESC / 锁滚 / 焦点圈定
    'ui.density': true,      // 密度与字号档
  };

  /* ⚠ flags 必须是响应式对象。
   * 早期用普通对象：App.setFlag() 确实改了值、也确实写进了 localStorage，
   * 但读取侧 App.flag() 返回的是一次性 boolean，Vue 无从得知变化 ——
   * 于是设置面板里的开关「点下去数据变了、颜色不变」，用户以为没生效。
   * 用 reactive 包一层：读取建立依赖，写回触发重渲染。 */
  const flags = (typeof Vue !== 'undefined' && Vue.reactive)
    ? Vue.reactive(Object.assign({}, FLAG_DEFAULTS))
    : Object.assign({}, FLAG_DEFAULTS);

  (function readFlags() {
    try {
      const saved = JSON.parse(localStorage.getItem('cch_flags') || '{}');
      Object.keys(saved).forEach((k) => { flags[k] = !!saved[k]; });
    } catch (e) { /* 隐私模式 / 脏数据：忽略 */ }
    try {
      const q = new URLSearchParams(location.search).get('flags');
      if (q) {
        q.split(',').forEach((raw) => {
          const s = raw.trim();
          if (!s) return;
          if (s.charAt(0) === '-') flags[s.slice(1)] = false;
          else flags[s.replace(/^\+/, '')] = true;
        });
      }
    } catch (e) { /* 忽略 */ }
  })();

  /** 读开关。未登记的键一律返回 true（新代码默认生效，旧代码不受影响） */
  function flag(name) {
    if (!(name in flags)) return true;
    return flags[name] !== false;
  }

  /** 运行时改开关（调试/命令面板用），并持久化 */
  function setFlag(name, on) {
    flags[name] = !!on;
    try { localStorage.setItem('cch_flags', JSON.stringify(flags)); } catch (e) { /* 忽略 */ }
    return flags[name];
  }

  /* ==================================================================
   * 二、API 客户端
   * ================================================================== */
  /* 【新增增强】网络参数集中一处，便于按环境调参 */
  const NET = {
    timeout: 20000,       // 单次请求超时（原实现无超时，弱网下会一直等）
    retries: 2,           // GET 幂等重试次数（POST 永不重试，避免重复写）
    backoff: [400, 900],  // 退避序列
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 带分类信息的错误：status / retriable 供重试与提示分层使用 */
  function mkErr(message, meta) {
    const e = new Error(message);
    e.name = 'ApiError';
    if (meta) {
      if (meta.status !== undefined) e.status = meta.status;
      if (meta.code !== undefined) e.code = meta.code;
      e.retriable = !!meta.retriable;
    }
    return e;
  }

  /** 同一 tick 内相同 GET 只发一次（页面里相邻组件常重复取同一份数据） */
  const inflight = new Map();

  const API = {
    base: './api',

    /* 【优化重构】原 request 拆成两层：
     *   _raw()     —— 单次请求（原实现，仅补了超时与错误分类）
     *   request()  —— 外层策略（去重 / 重试）
     * 拆分而不是原地改的原因：重试必须能拿到"这一次失败"的完整信息，
     * 混在一个函数里会让 401 跳转逻辑被重试循环执行多次。 */
    async _raw(method, path, body, opts = {}) {
      const url = API.base + path;
      const headers = { 'Content-Type': 'application/json' };
      if (Store.token && !opts.noAuth) headers.Authorization = 'Bearer ' + Store.token;
      /* 【新增增强】超时控制。没有超时的时候，"后端卡住"与"后端很慢"
       * 在界面上是同一件事——都是一直转圈，用户只能靠猜。加超时后
       * 至少能明确说"等了 20 秒没响应"，并给出可执行建议。 */
      const ms = opts.timeout === undefined ? NET.timeout : opts.timeout;
      const ctl = (!opts.signal && typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = ctl && ms > 0 ? setTimeout(() => { try { ctl.abort(); } catch (e) { /* 忽略 */ } }, ms) : null;

      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: ctl ? ctl.signal : opts.signal,
        });
      } catch (e) {
        /* 区分"超时"与"连不上"：两者的处置方式不同（重试 / 叫后端起来） */
        const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
        throw mkErr(aborted
          ? `请求超时（超过 ${Math.round(ms / 1000)} 秒未响应）：${method} ${path}`
          : '无法连接服务端，请确认后端已启动', { retriable: true });
      } finally {
        if (timer) clearTimeout(timer);
      }
      let json = null;
      try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }

      if (res.status === 401 && !opts.noRedirect) {
        /* ⚠⚠ 只有在「当前页面本身需要登录」时才踢人。
         *
         * 原实现无条件跳 /login。后果：**任何公开页面**只要顺带调用了一个
         * 需登录的接口（例如 3D 透明页想额外展示"关联存证"），401 就会把
         * 正在浏览公开内容的访客直接踢到登录页 —— 页面根本渲染不出来。
         *
         * 实测症状：访问 /twin（已在 OPEN_ROUTES 白名单内），画面闪一下就变成
         * 登录页；控制台无报错，因为跳转是"正常"的 401 处理，不是异常。
         *
         * 判据：当前路由是否在匿名可访问的白名单内。在白名单内 ⇒ 不跳转，
         * 只让这次请求失败（调用方自己 catch 并降级）。
         * 不在白名单 ⇒ 说明用户访问的是需要登录的页面，正常跳登录。 */
        setSession('', null);
        const openRoutes = (global.App && global.App.routeAccess && global.App.routeAccess.OPEN_ROUTES) || [];
        const cur = (global.App && global.App.Router && global.App.Router.path) || '/';
        const isOpen = openRoutes.some((x) => (x === '/' ? cur === '/' : (cur === x || cur.startsWith(x + '/'))));
        if (!isOpen) location.hash = '#/login';
        throw mkErr((json && (json.msg || json.message)) || '登录已失效，请重新登录',
          { status: 401, retriable: false });
      }
      /* ⚠ 后端统一用 msg 字段（见 worker/lib/http.mjs 的 fail()）。
       * 原实现只读 json.message，于是所有业务错误的提示都退化成
       * "请求失败 (HTTP 400)" —— 用户看不到"用户名或密码错误"这类有效信息，
       * 只能看到状态码。这类"信息被吞掉"的 bug 不会报错，只会让人困惑。 */
      if (!json) {
        throw mkErr(`服务端返回了非 JSON 响应（HTTP ${res.status}）。`
          + '常见原因：静态托管把 /api 请求兜底成了 index.html —— 请确认后端已部署且路由生效。',
        /* 5xx 值得重试；被兜底成 HTML 的 200 重试也没用，标记不可重试 */
        { status: res.status, retriable: res.status >= 500 });
      }
      if (json.code !== 0) {
        /* 【新增增强】把 HTTP 状态挂到错误上，供 errHint() 分层与重试判定。
         * 5xx 是服务端瞬时故障，可以重试；4xx 是请求本身不对，重试只会重复失败。 */
        throw mkErr(json.msg || json.message || `请求失败 (HTTP ${res.status})`,
          { status: res.status, code: json.code, retriable: res.status >= 500 });
      }
      return json.data;
    },

    /* 【新增增强】外层策略：并发去重 + GET 幂等重试。
     * 为什么只重试 GET：POST 可能是"提交上报""发起交易"，
     * 超时后重发会在后端产生两条记录——用户看到一条，账上有两条。 */
    async request(method, path, body, opts = {}) {
      if (!flag('net.v2')) return API._raw(method, path, body, opts);

      const isGet = method === 'GET';
      const url = API.base + path;
      const key = isGet ? 'G ' + url + ' ' + (Store.token ? 'auth' : 'anon') : null;

      /* 调用方显式要最新数据（刷新按钮）时不去重，也不吃缓存 */
      if (key && !opts.fresh) {
        const hit = inflight.get(key);
        if (hit) return hit;
      }

      const tries = (isGet && opts.retry !== 0)
        ? (opts.retries === undefined ? NET.retries : opts.retries) + 1
        : 1;

      const task = (async () => {
        let last = null;
        let retried = 0;
        for (let i = 0; i < tries; i++) {
          try {
            return await API._raw(method, path, body, opts);
          } catch (e) {
            last = e;
            if (!e || !e.retriable || i === tries - 1) break;
            retried += 1;
            await sleep(NET.backoff[Math.min(i, NET.backoff.length - 1)]);
          }
        }
        /* 把"重试过几次"写在 message 末尾：用户看到"已自动重试 2 次"，
         * 就知道不是自己点错了，而是后端确实不稳，才有理由去报障。 */
        if (last && retried > 0) {
          last.retried = retried;
          last.message = last.message + `（已自动重试 ${retried} 次）`;
        }
        throw last;
      })();

      if (key) {
        inflight.set(key, task);
        /* 用 then 而不是 finally：finally 会产生一个未处理的拒绝分支 */
        const clear = () => { inflight.delete(key); };
        task.then(clear, clear);
      }
      return task;
    },

    get(path, params) {
      let q = '';
      if (params) {
        const usp = new URLSearchParams();
        Object.keys(params).forEach((k) => {
          if (params[k] !== undefined && params[k] !== null && params[k] !== '') usp.append(k, params[k]);
        });
        q = usp.toString() ? '?' + usp.toString() : '';
      }
      return API.request('GET', path + q);
    },

    /**
     * 取回完整包络 { code, msg, data, meta }。
     *
     * 【为什么需要这个】
     * request() 只返回 json.data，把 meta 丢掉了。对分页列表来说 meta 里
     * 装着 total / page / size —— 没有它前端只能画"当前页"，画不出总页数，
     * 也无法判断"是不是已经到底了"。丢掉 meta 再自己数条数是错的：
     * 一页 20 条不代表总共 20 条。
     */
    async getEnvelope(path, params, opts = {}) {
      let q = '';
      if (params) {
        const usp = new URLSearchParams();
        Object.keys(params).forEach((k) => {
          if (params[k] !== undefined && params[k] !== null && params[k] !== '') usp.append(k, params[k]);
        });
        q = usp.toString() ? '?' + usp.toString() : '';
      }
      const url = API.base + path + q;
      const headers = { 'Content-Type': 'application/json' };
      if (Store.token) headers.Authorization = 'Bearer ' + Store.token;
      /* 【新增增强】与 request() 一致的超时保护（分页列表同样会卡住） */
      const ctl = (!opts.signal && typeof AbortController !== 'undefined') ? new AbortController() : null;
      const ms = opts.timeout === undefined ? NET.timeout : opts.timeout;
      const timer = ctl && ms > 0 ? setTimeout(() => { try { ctl.abort(); } catch (e) { /* 忽略 */ } }, ms) : null;
      let res;
      try {
        res = await fetch(url, { method: 'GET', headers, signal: ctl ? ctl.signal : opts.signal });
      } catch (e) {
        throw mkErr(e && e.name === 'AbortError'
          ? `请求超时（超过 ${Math.round(ms / 1000)} 秒未响应）`
          : '无法连接服务端，请确认后端已启动', { retriable: true });
      } finally {
        if (timer) clearTimeout(timer);
      }
      let json = null;
      try { json = await res.json(); } catch (e) { /* 非 JSON */ }
      if (!json) {
        throw mkErr(`服务端返回了非 JSON 响应（HTTP ${res.status}）。请确认后端已部署。`,
          { status: res.status, retriable: res.status >= 500 });
      }
      if (json.code !== 0) {
        throw mkErr(json.msg || json.message || `请求失败 (HTTP ${res.status})`,
          { status: res.status, code: json.code });
      }
      return json;
    },

    post(path, body) { return API.request('POST', path, body || {}); },
  };

  /* ==================================================================
   * 三、消息提示
   * ================================================================== */
  let toastSeq = 0;
  const toastTimers = new Map();

  /** 手动关闭（带操作按钮的提示，点过按钮就该消失） */
  function closeToast(id) {
    const i = Store.toasts.findIndex((t) => t.id === id);
    if (i > -1) Store.toasts.splice(i, 1);
    const t = toastTimers.get(id);
    if (t) { clearTimeout(t); toastTimers.delete(id); }
  }

  /**
   * 顶层提示。
   * 【新增增强】第 4 个参数 action: { label, run } —— 让提示本身可操作。
   * 例：失败提示直接给"重试"，用户不必回到页面找按钮。
   * duration 传 0 表示常驻（必须由用户点按钮或关闭），用于"重试也可能失败"的场景。
   */
  function toast(message, type = 'info', duration = 3200, action) {
    /* 主动登出后，残留请求的 401 不该再提示（详见 Store.loggedOutByUser 的说明）。
     * 只拦「登录失效」这一类文案：登出后跳转到的公开页若真的报别的错（如接口 500），
     * 仍要照常提示，不能连带吞掉。 */
    if (Store.loggedOutByUser && typeof message === 'string'
      && /登录(状态)?已失效|请重新登录|令牌过期/.test(message)) {
      return -1;
    }
    const id = ++toastSeq;
    Store.toasts.push({ id, message, type, action: action || null });
    /* 最多同时保留 4 条：批量操作出错时容易一次弹十几条，堆满屏幕反而看不到重点 */
    while (Store.toasts.length > 4) {
      const first = Store.toasts.shift();
      const t0 = toastTimers.get(first.id);
      if (t0) { clearTimeout(t0); toastTimers.delete(first.id); }
    }
    if (duration > 0) {
      toastTimers.set(id, setTimeout(() => closeToast(id), duration));
    }
    return id;
  }

  const notify = {
    ok: (m, action) => toast(m, 'ok', 3200, action),
    err: (m, action) => toast(m, 'err', action ? 0 : 5200, action),
    info: (m, action) => toast(m, 'info', 3200, action),
    warn: (m, action) => toast(m, 'warn', 4200, action),
    /** 失败 + 重试：把"能不能再试一次"这件事放进提示里，而不是让用户自己找 */
    retry: (m, fn) => toast(m, 'err', 0, { label: '重试', run: fn }),
    close: closeToast,
  };

  /* ==================================================================
   * 三·五、确认对话框（Promise 化，替代原生 confirm）
   * ==================================================================
   * 原生 window.confirm() 在主线程上同步阻塞：弹窗期间页面完全不响应，
   * 自动化巡检里表现为 "Runtime.evaluate 超时 = 页面卡死"；用户侧还可能被
   * 浏览器的"阻止此页面创建更多对话框"静默吞掉，于是动作变成"点了没反应"。
   * 这里用页面内弹层实现，返回 Promise<boolean>，样式与平台一致，不阻塞渲染。
   */
  function confirmDialog(opts) {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    const title = o.title || '请确认';
    const message = String(o.message || '');
    const danger = !!o.danger;

    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const mask = document.createElement('div');
      mask.className = 'cch-confirm-mask';
      mask.style.cssText = 'position:fixed;inset:0;z-index:9850;display:flex;align-items:center;'
        + 'justify-content:center;background:rgba(4,10,20,.62);backdrop-filter:blur(3px);padding:24px;';

      const box = document.createElement('div');
      box.className = 'cch-confirm';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.style.cssText = 'width:min(520px,100%);background:var(--bg-2,#0d1729);'
        + 'border:1px solid rgba(255,255,255,.14);border-radius:14px;'
        + 'box-shadow:0 24px 64px -12px rgba(0,0,0,.72);padding:20px 22px 16px;';

      const h3 = document.createElement('div');
      h3.style.cssText = 'font-size:15px;font-weight:600;color:var(--tx-1,#eef4ff);margin-bottom:10px;';
      h3.textContent = title;

      const body = document.createElement('div');
      body.style.cssText = 'font-size:13px;line-height:1.75;color:var(--tx-2,#b6c4da);white-space:pre-wrap;';
      body.textContent = message;

      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:18px;';

      const mkBtn = (txt, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn' + (cls ? ' ' + cls : '');
        b.textContent = txt;
        return b;
      };
      const cancelBtn = mkBtn(o.cancelText || '取消', '');
      const okBtn = mkBtn(o.okText || '确认', danger ? 'danger' : 'primary');

      let done = false;
      const close = (val) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* 忽略 */ } }
        resolve(val);
      };
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(false); }
        else if (e.key === 'Enter' && document.activeElement === okBtn) { e.preventDefault(); close(true); }
      }

      cancelBtn.addEventListener('click', () => close(false));
      okBtn.addEventListener('click', () => close(true));
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(false); });
      document.addEventListener('keydown', onKey, true);

      bar.appendChild(cancelBtn);
      bar.appendChild(okBtn);
      box.appendChild(h3);
      if (message) box.appendChild(body);
      box.appendChild(bar);
      mask.appendChild(box);
      document.body.appendChild(mask);
      setTimeout(() => { try { okBtn.focus(); } catch (e) { /* 忽略 */ } }, 30);
    });
  }

  /* ==================================================================
   * 四、哈希路由
   * ================================================================== */
  const Router = reactive({ path: '/', params: {}, query: {}, view: '', name: '' });
  const routeTable = [];

  function define(pattern, view, name) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    }) + '$');
    routeTable.push({ pattern, regex, keys, view, name: name || view });
  }

  function resolve() {
    let raw = location.hash.replace(/^#/, '');
    if (!raw) raw = '/screen';
    const [p, qs] = raw.split('?');
    const path = p || '/';
    const query = {};
    new URLSearchParams(qs || '').forEach((v, k) => { query[k] = v; });

    for (const r of routeTable) {
      const m = r.regex.exec(path);
      if (m) {
        Router.path = path;
        Router.query = query;
        Router.view = r.view;
        Router.name = r.name;
        Router.params = {};
        r.keys.forEach((k, i) => { Router.params[k] = decodeURIComponent(m[i + 1]); });
        return;
      }
    }
    Router.path = path; Router.view = 'page-404'; Router.params = {}; Router.query = query;
  }

  function go(path) {
    if (location.hash === '#' + path) return;
    location.hash = '#' + path;
  }

  /* 动画保险丝（2026-10-29）：路由过渡 .view-fade 依赖 CSS 动画时钟。当页面被
   * 浏览器判定为遮挡/节流（后台标签页、内嵌 webview、主线程被重负载阻塞）时，
   * document.timeline 会冻结在 0，动画永远停在第一帧 opacity:0 —— 实测表现为
   * "切页后整页空白"（内容在 DOM 里但不可见，控制台无任何报错）。
   * 这里在路由切换后延时给 .view-fade 补一个落定类，强制进入可见终态；
   * 动画正常运行时该类只是提前结束 120ms 的淡入，无任何副作用。 */
  let viewFuseTimer = 0;
  function armViewFuse() {
    clearTimeout(viewFuseTimer);
    viewFuseTimer = setTimeout(() => {
      document.querySelectorAll('.view-fade:not(.view-done)').forEach((el) => el.classList.add('view-done'));
    }, 260);
  }
  window.addEventListener('hashchange', () => { resolve(); window.scrollTo({ top: 0 }); armViewFuse(); });
  /* 首屏直达（如打开 #/reg/enterprises）同样可能遇到冻结时钟，双保险各补一次 */
  setTimeout(armViewFuse, 600);
  setTimeout(armViewFuse, 2200);

  /* ==================================================================
   * 五、格式化工具
   * ================================================================== */
  const fmt = {
    /** 千分位 */
    num(v, digits = 0) {
      if (v === null || v === undefined || v === '') return '-';
      const n = Number(v);
      if (!isFinite(n)) return '-';
      return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    },
    /**
     * 把数据文本里的 Markdown 强调标记 `**xx**` 渲染为 <b>xx</b>。
     * ------------------------------------------------------------------
     * 背景：台账（App.Sources）等数据源里的说明文字天然带 `**` 强调意图，
     * 但直接用 h('div', {}, 字符串) 渲染时 `**` 会**原样显示**，既难看也说明不了重点。
     * 这里统一提供一个"纯文本 → 带强调片段"的渲染器，供各视图复用：
     *   h('div', {}, App.fmt.md(someText))
     * @param {string} s
     * @returns {Array} vnode 数组（可安全作为 children 传入）
     */
    md(s) {
      const str = String(s === null || s === undefined ? '' : s);
      const parts = str.split('**');
      return parts.map((seg, i) => (i % 2 === 1
        ? h('b', { style: 'color:var(--tx-0)' }, seg)
        : seg)).filter((x) => x !== '');
    },
    /** 只去掉 `**` 标记（用于 title 属性等纯文本场景） */
    plain(s) {
      return String(s === null || s === undefined ? '' : s).replace(/\*\*/g, '');
    },
    /** 自动量级（万 / 亿） */
    big(v) {
      const n = Number(v) || 0;
      const abs = Math.abs(n);
      if (abs >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
      if (abs >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
      return n.toFixed(0);
    },
    usd(v) { return '¥' + fmt.num(v, 2); },
    pct(v, d = 1) { return (Number(v) || 0).toFixed(d) + '%'; },
    /** 2026-09-17 20:31 */
    dt(v) {
      if (!v) return '-';
      const d = new Date(v);
      if (isNaN(d)) return String(v);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    d(v) {
      if (!v) return '-';
      const d = new Date(v);
      if (isNaN(d)) return String(v);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },
    /** 相对时间 */
    ago(v) {
      if (!v) return '-';
      const t = new Date(v).getTime();
      if (isNaN(t)) return '-';
      const s = Math.floor((Date.now() - t) / 1000);
      if (s < 60) return s + ' 秒前';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
      return fmt.d(v);
    },
    short(h, len = 12) {
      if (!h) return '-';
      const s = String(h);
      return s.length <= len * 2 + 3 ? s : s.slice(0, len) + '…' + s.slice(-4);
    },
    addr(a) { return a ? String(a).slice(0, 8) + '…' + String(a).slice(-6) : '-'; },
    /** 字节 */
    bytes(b) {
      const n = Number(b) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(2) + ' MB';
    },
  };

  /* ==================================================================
   * 六、业务字典（枚举 → 中文 / 颜色）
   * ================================================================== */
  const DICT = {
    reportStatus: {
      DRAFT: ['草稿', 't-mute'], SUBMITTED: ['已提交', 't-info'], VERIFYING: ['核查中', 't-violet'],
      VERIFIED: ['已核查', 't-ok'], REJECTED: ['已驳回', 't-danger'],
    },
    taskStatus: {
      PENDING: ['待受理', 't-warn'], PROCESSING: ['核查中', 't-info'], DONE: ['已完成', 't-ok'], REJECTED: ['已驳回', 't-danger'],
    },
    taskType: { ROUTINE: ['常规核查', 't-mute'], RECHECK: ['复查', 't-info'], RANDOM: ['抽查', 't-violet'] },
    priority: { HIGH: ['高', 't-danger'], NORMAL: ['中', 't-mute'], LOW: ['低', 't-mute'] },
    conclusion: { PASS: ['通过', 't-ok'], CONDITIONAL: ['有条件通过', 't-warn'], FAIL: ['不通过', 't-danger'] },
    allocType: { FREE: ['免费分配', 't-ok'], AUCTION: ['有偿竞价', 't-info'], BUYBACK: ['政府回购', 't-violet'] },
    alertType: {
      OVER_QUOTA: ['配额超限', 't-danger'], DATA_ABNORMAL: ['数据异常', 't-warn'], MISSING_REPORT: ['漏报', 't-violet'],
      CHAIN_RISK: ['链上风险', 't-chain'], PRICE_ANOMALY: ['价格异常', 't-warn'],
    },
    alertLevel: { HIGH: ['高', 't-danger'], MEDIUM: ['中', 't-warn'], LOW: ['低', 't-mute'] },
    alertStatus: { OPEN: ['待处理', 't-danger'], HANDLING: ['处理中', 't-warn'], CLOSED: ['已关闭', 't-ok'] },
    entStatus: { ACTIVE: ['正常', 't-ok'], WATCH: ['重点关注', 't-warn'], SUSPENDED: ['暂停存证', 't-danger'] },
    txType: {
      EMISSION_REPORT: ['排放上报存证', 't-ok'], VERIFY_REPORT: ['核查报告存证', 't-info'],
      QUOTA_ALLOC: ['配额分配存证', 't-violet'],
      ENTERPRISE_REG: ['企业备案存证', 't-mute'],
      CREDIT_ASSET: ['碳信用签发存证', 't-ok'],
      CREDIT_OFFSET: ['碳信用抵销存证', 't-info'],
      TRADE_DEAL: ['配额交易成交存证', 't-chain'],
      CEMS_READING: ['实测读数存证', 't-violet'],
      FACTOR_VERSION: ['因子版本存证', 't-info'],
      FILE_ANCHOR: ['文件 IPFS 存证', 't-mute'],
      ORACLE_FEED: ['预言机数据存证', 't-chain'],
    },
    role: { ENTERPRISE: '企业端', VERIFIER: '核查机构端', REGULATOR: '监管端', TRADER: '交易端', ADMIN: '管理端' },
    /* 交易方向 */
    orderSide: { BUY: ['买入', 't-danger'], SELL: ['卖出', 't-ok'] },
    orderStatus: { OPEN: ['挂单中', 't-info'], PARTIAL: ['部分成交', 't-warn'], FILLED: ['已成交', 't-ok'], CANCELLED: ['已撤单', 't-mute'] },
    /* 多智能体 */
    agent: { FORECAST: ['用量预测', 't-info'], OVER_QUOTA: ['超限预警', 't-danger'], ANOMALY: ['异常检测', 't-warn'], ADVISOR: ['减排建议', 't-ok'] },
    riskLevel: { HIGH: ['高', 't-danger'], MEDIUM: ['中', 't-warn'], LOW: ['低', 't-ok'] },
    factorStatus: { ACTIVE: ['生效中', 't-ok'], ARCHIVED: ['已归档', 't-mute'] },
    noticeType: { OFFICIAL: ['官方通知', 't-ok'], POLICY: ['政策法规', 't-info'], MARKET: ['市场公告', 't-chain'], INTERNATIONAL: ['国际动态', 't-violet'], INTL: ['国际动态', 't-violet'], SYSTEM: ['平台公告', 't-mute'] },
    energy: ['原煤', '焦炭', '天然气', '柴油', '燃料油', '电力', '热力'],
    scale: { 大型: 't-info', 中型: 't-violet', 小型: 't-mute' },
  };

  function dict(map, key) {
    const v = map[key];
    if (!v) return { label: key || '-', cls: 't-mute' };
    return Array.isArray(v) ? { label: v[0], cls: v[1] } : { label: v, cls: 't-mute' };
  }

  /* ==================================================================
   * 七、ECharts 主题
   * ================================================================== */
  /* 图表色板（2026-10-23 收口）：前 5 位是语义主色，与 CSS 令牌一一对应；
     后 5 位是同色相的浅档，只用于多序列堆叠。原 #38bdf8 / #fb7185 折进
     cyan / danger —— 同一语义不再有两个近似色。 */
  const PALETTE = ['#10b981', '#06b6d4', '#f5a524', '#a78bfa', '#f43f5e', '#34d399', '#22d3ee', '#fbbf24', '#c4b5fd', '#fda4af'];

  const AXIS = {
    axisLine: { lineStyle: { color: 'rgba(255,255,255,.13)' } },
    axisTick: { show: false },
    axisLabel: { color: '#8d9cb5', fontSize: 11 },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)', type: 'dashed' } },
  };

  function chartBase(extra = {}) {
    return Object.assign({
      color: PALETTE,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: 'HarmonyOS Sans SC, PingFang SC, Microsoft YaHei, sans-serif', color: '#c3d0e4' },
      grid: { left: 10, right: 16, top: 34, bottom: 6, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(10,16,32,.96)',
        borderColor: 'rgba(255,255,255,.16)',
        borderWidth: 1,
        padding: [9, 12],
        textStyle: { color: '#eef4ff', fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: 'rgba(16,185,129,.5)', type: 'dashed' } },
      },
      legend: { textStyle: { color: '#8d9cb5', fontSize: 11.5 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 14, top: 2 },
    }, extra);
  }

  /** 类目轴 */
  function catAxis(data, extra = {}) {
    return Object.assign({ type: 'category', data, boundaryGap: true }, AXIS, extra);
  }
  /** 数值轴
   *  alignTicks: true —— 多轴同图时（如「排放总量 tCO₂e」+「排放强度」双轴），
   *  两轴刻度若各自取整，0 线与刻度线不对齐，强度线会被"视觉错位"到
   *  25 万量级的位置上，看起来像画错了（缺陷清单 P2-38）。单轴无副作用。 */
  function valAxis(extra = {}) {
    return Object.assign({ type: 'value', alignTicks: true }, AXIS, extra);
  }

  /** 渐变填充（面积图用） */
  function areaGrad(colorFrom, colorTo) {
    return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: colorFrom }, { offset: 1, color: colorTo },
    ]);
  }

  /* ==================================================================
   * 八、ECharts 组合式函数
   * ================================================================== */
  function useChart(getOption, deps = []) {
    const el = ref(null);
    let inst = null;
    let ro = null;

    function render() {
      if (!el.value) return;
      if (!inst) inst = echarts.init(el.value, null, { renderer: 'canvas' });
      const opt = typeof getOption === 'function' ? getOption() : getOption;
      if (opt) inst.setOption(opt, true);
    }

    /* 【优化重构】原来这里挂的是匿名函数，卸载时无法移除 ——
     * 每进出一次带图表的页面就多一个 window resize 监听，
     * 来回切 20 次就是 20 个监听同时 resize 已销毁的实例。 */
    const onWinResize = () => { if (inst && !inst.isDisposed()) inst.resize(); };

    onMounted(() => {
      nextTick(render);
      ro = new ResizeObserver(() => onWinResize());
      if (el.value) ro.observe(el.value);
      window.addEventListener('resize', onWinResize);
    });
    onUnmounted(() => {
      if (ro && el.value) ro.unobserve(el.value);
      window.removeEventListener('resize', onWinResize);
      if (inst) { inst.dispose(); inst = null; }
    });

    if (deps.length) watch(deps, () => nextTick(render), { deep: true });

    return { el, render, getInstance: () => inst };
  }

  /* ==================================================================
   * 九、其它工具
   * ================================================================== */
  /**
   * 静态演示模式提示条。
   * ------------------------------------------------------------------
   * 静态站点用快照应答 /api/*，读数据是快照时点值、写操作响应真实但不落库。
   * 这不是缺陷，但**必须显式告知**，否则用户会把快照数值当成实时值。
   * 需要真实后端的能力（密码学运算、时序库关联、真落库）也在这里提示。
   * @param {string} [text] 覆盖默认文案
   * @returns {object|null} 静态模式返回提示条 vnode，在线模式返回 null
   */
  /* 静态模式提示条：**已废弃**。
   * 平台不再有快照回放能力（staticApi.js 与 api-snapshot.json 均已删除），
   * 因此"当前为静态演示模式"这类提示在任何情况下都不应出现。
   * 保留函数签名是为了让既有调用点不必改动 —— 但恒返回 null，
   * 这样即使某个页面忘了删调用，也不会渲染出误导性的横幅。 */
  function staticNote() {
    return null;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(String(text));
      notify.ok('已复制到剪贴板');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); notify.ok('已复制到剪贴板'); } catch (e2) { notify.err('复制失败'); }
      document.body.removeChild(ta);
    }
  }

  /** 防抖 */
  function debounce(fn, wait = 320) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /** 分页 composable */
  function usePager(loader, initial = { page: 1, size: 10 }) {
    const state = reactive({
      rows: [], total: 0, page: initial.page, size: initial.size, pages: 1, loading: false, error: '',
      hint: null,
    });
    async function load(extra) {
      state.loading = true; state.error = ''; state.hint = null;
      try {
        const d = await loader(Object.assign({ page: state.page, size: state.size }, extra || {}));
        state.rows = d.rows || d || [];
        state.total = d.total !== undefined ? d.total : state.rows.length;
        state.pages = d.pages || Math.max(1, Math.ceil(state.total / state.size));
      } catch (e) {
        state.error = e.message;
        /* 【新增增强】同时给出"为什么 + 怎么办"，页面可只渲染 hint 而不必自己判断 */
        state.hint = errHint(e);
        state.rows = [];
      } finally {
        state.loading = false;
      }
    }
    function goto(p) {
      const np = Math.min(Math.max(1, p), state.pages || 1);
      if (np === state.page) return;
      state.page = np;
      return load();
    }
    function reset(extra) { state.page = 1; return load(extra); }
    return { state, load, goto, reset };
  }

  /* 轻量内存缓存，避免页面来回切换重复请求 */
  const cache = {
    map: new Map(),
    async get(key, producer, ttl = 45000) {
      const hit = cache.map.get(key);
      if (hit && Date.now() - hit.t < ttl) return hit.v;
      const v = await producer();
      cache.map.set(key, { t: Date.now(), v });
      return v;
    },
    /**
     * 【新增增强】stale-while-revalidate。
     * ------------------------------------------------------------------
     * get() 只在"没命中"时才请求，命中过期值则同步等待——页面切回来还是白屏。
     * swr() 的做法相反：**先把旧值给出去让页面立刻有内容**，再在后台刷新，
     * 拿到新值后回调 onUpdate。过期数据的风险由"后台刷新"消化，不是由用户等待。
     *
     * @returns {*} 命中则返回旧值（可能已过期）；未命中返回 null（调用方自行首次加载）
     */
    swr(key, producer, ttl = 45000, onUpdate) {
      const hit = cache.map.get(key);
      if (!hit) return null;
      if (Date.now() - hit.t > ttl) {
        Promise.resolve()
          .then(producer)
          .then((v) => {
            cache.map.set(key, { t: Date.now(), v });
            if (typeof onUpdate === 'function') onUpdate(v);
          })
          .catch(() => { /* 后台刷新失败：保留旧值，不打扰用户 */ });
      }
      return hit.v;
    },
    clear(prefix) {
      if (!prefix) return cache.map.clear();
      [...cache.map.keys()].forEach((k) => { if (k.startsWith(prefix)) cache.map.delete(k); });
    },
  };

  /* ==================================================================
   * 九·五、错误分层提示（【新增增强】2026-10-25）
   * ------------------------------------------------------------------
   * 原实现把 e.message 直接甩到界面上，于是所有异常长得一样：
   *   "请求失败 (HTTP 500)"
   * 用户看完不知道是"我的操作错了"还是"后端挂了"，也不知道该做什么。
   * 这里按"现象 / 原因 / 下一步"三段拆开，页面只要渲染这三段即可。
   * ================================================================== */
  function errHint(e) {
    const msg = (e && e.message) || String(e || '未知错误');
    const st = (e && e.status) || 0;

    if (st === 0 && /无法连接服务端/.test(msg)) {
      return { tone: 'danger', title: '连不上服务端', reason: '后端未启动，或网络/代理把请求拦了下来。',
        action: '确认后端已启动（npm start，端口 8300）后点重试', retriable: true };
    }
    if (st === 0 && /请求超时/.test(msg)) {
      return { tone: 'warn', title: '请求超时', reason: '后端在规定时间内没有返回，可能是数据量过大或正在重建索引。',
        action: '稍后重试；若持续出现，请缩小查询范围（如限定年度/企业）', retriable: true };
    }
    if (st === 401) {
      return { tone: 'warn', title: '登录已失效', reason: '令牌过期或已在别处退出。',
        action: '重新登录后再试', retriable: false };
    }
    if (st === 403) {
      return { tone: 'danger', title: '没有该功能的权限', reason: '当前角色不在授权范围内。',
        action: '切换到有权限的账号，或联系管理员授权', retriable: false };
    }
    if (st === 404) {
      return { tone: 'warn', title: '接口或资源不存在', reason: '前端版本与后端不一致，或该记录已被删除。',
        action: '刷新页面；若仍报错，请核对后端版本', retriable: false };
    }
    if (st >= 500) {
      return { tone: 'danger', title: '服务端内部错误', reason: `后端处理时抛出异常（HTTP ${st}）。`,
        action: '点重试（已自动重试仍失败）；持续失败请查看后端日志', retriable: true };
    }
    if (/非 JSON 响应/.test(msg)) {
      return { tone: 'danger', title: '接口返回了网页而不是数据', reason: '静态托管把 /api 兜底成了 index.html。',
        action: '确认后端已部署且 /api 路由生效（而不是只部署了静态文件）', retriable: false };
    }
    return { tone: 'danger', title: '操作未完成', reason: msg, action: '按提示修正后重试', retriable: !!(e && e.retriable) };
  }

  /** 把错误直接渲染成一条可读提示（页面 catch 里最常用的一行） */
  function showErr(e, action) {
    const h2 = errHint(e);
    notify.err(`${h2.title}：${h2.reason}`, action || (h2.retriable ? { label: '重试', run: () => location.reload() } : null));
    return h2;
  }

  /* ==================================================================
   * 九·六、参数校验（【新增增强】2026-10-25）
   * ------------------------------------------------------------------
   * 目的：把"非法输入"挡在发请求之前。原实现多数是提交后才由后端报错，
   * 用户填了 12 个字段、等到 800ms 后才知道第一个字段写错了。
   * 用法：
   *   const err = App.validate([
   *     [form.quantity, App.validators.positive, '数量必须大于 0'],
   *     [form.month, (v) => App.validators.range(v, 1, 12), '月份需在 1–12'],
   *   ]);
   *   if (err) { App.notify.err(err); return; }
   * ================================================================== */
  const validators = {
    required: (v) => v !== null && v !== undefined && String(v).trim() !== '',
    number: (v) => v !== '' && v !== null && isFinite(Number(v)),
    positive: (v) => validators.number(v) && Number(v) > 0,
    nonNegative: (v) => validators.number(v) && Number(v) >= 0,
    int: (v) => validators.number(v) && Number.isInteger(Number(v)),
    range: (v, min, max) => validators.number(v) && Number(v) >= min && Number(v) <= max,
    len: (v, min, max) => {
      const n = String(v === null || v === undefined ? '' : v).trim().length;
      return n >= min && n <= max;
    },
    /** 业务编码：字母/数字/下划线/连字符，2–32 位 */
    code: (v) => /^[A-Za-z0-9_-]{2,32}$/.test(String(v || '')),
    /** 哈希：64 位十六进制（SM3/SHA-256 同形） */
    hash64: (v) => /^[0-9a-fA-F]{64}$/.test(String(v || '')),
    year: (v) => validators.int(v) && Number(v) >= 2000 && Number(v) <= 2100,
    month: (v) => validators.int(v) && Number(v) >= 1 && Number(v) <= 12,
  };

  /**
   * @param {Array<[any, Function, string]>} rules  [值, 判定函数, 失败文案]
   * @returns {string} 第一条失败文案；全部通过返回 ''
   */
  function validate(rules) {
    for (let i = 0; i < (rules || []).length; i++) {
      const [val, test, msg] = rules[i];
      let ok = false;
      try { ok = !!test(val); } catch (e) { ok = false; }
      if (!ok) return msg || '输入不合法';
    }
    return '';
  }

  /* ==================================================================
   * 九·七、偏好（密度 / 字号 / 导航）—— 【新增增强】
   * ------------------------------------------------------------------
   * 为什么做"密度档"而不是浅色主题：当前主题只有深色一套，且 2254 行样式里
   * 大量硬编码 rgba(255,255,255,…)，做浅色等于重写整个样式层，违背增量原则。
   * 而"信息密度"是效率平台更刚性的需求：同一屏能多看几行表格。
   * 三档 density（compact / normal / loose）+ 三档字号（sm / normal / lg）。
   * ================================================================== */
  /* 【新增增强】2026-10-25：新增两档偏好 ——
   *   contrast: 'normal' | 'more'  投影仪 / 强光环境下的可读性
   *   motion:   'on'     | 'off'   低配机器与"讨厌动画"的用户
   * 只加两个键、两个 body class，不改任何既有键的语义，旧 localStorage 照样能读。 */
  const PREFS_DEFAULT = { density: 'normal', font: 'normal', nav: 'expanded', contrast: 'normal', motion: 'on' };
  const prefs = reactive(Object.assign({}, PREFS_DEFAULT));

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem('cch_prefs') || '{}');
      Object.keys(PREFS_DEFAULT).forEach((k) => {
        if (saved[k]) prefs[k] = saved[k];
      });
    } catch (e) { /* 忽略 */ }
  }

  function applyPrefs() {
    const b = document.body;
    if (!b) return;
    ['density-compact', 'density-loose', 'fs-sm', 'fs-lg', 'nav-collapsed',
      'contrast-more', 'motion-off'].forEach((c) => b.classList.remove(c));
    if (prefs.density === 'compact') b.classList.add('density-compact');
    if (prefs.density === 'loose') b.classList.add('density-loose');
    if (prefs.font === 'sm') b.classList.add('fs-sm');
    if (prefs.font === 'lg') b.classList.add('fs-lg');
    if (prefs.nav === 'collapsed') b.classList.add('nav-collapsed');
    if (prefs.contrast === 'more') b.classList.add('contrast-more');
    if (prefs.motion === 'off') b.classList.add('motion-off');
  }

  function setPref(key, value) {
    prefs[key] = value;
    try { localStorage.setItem('cch_prefs', JSON.stringify(prefs)); } catch (e) { /* 忽略 */ }
    applyPrefs();
    return value;
  }

  loadPrefs();
  applyPrefs();

  /* ==================================================================
   * 九·八、最近访问（【新增增强】）
   * ------------------------------------------------------------------
   * 40+ 路由里，用户 80% 时间只在 5 个页面之间来回。命令面板里
   * "最近访问"排在最前，比搜索更快——因为不需要想关键词。
   * ================================================================== */
  const RECENT_KEY = 'cch_recent';
  const RECENT_MAX = 10;

  const recent = {
    list() {
      try {
        const arr = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    },
    push(path, label) {
      if (!path) return;
      const arr = recent.list().filter((x) => x.path !== path);
      arr.unshift({ path, label: label || path, t: Date.now() });
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(arr.slice(0, RECENT_MAX))); } catch (e) { /* 忽略 */ }
    },
    clear() {
      try { localStorage.removeItem(RECENT_KEY); } catch (e) { /* 忽略 */ }
    },
  };

  /* ==================================================================
   * 十、组件名解析版 h
   * ------------------------------------------------------------------
   * Vue 3 的 h('x-card') 对字符串标签一律按原生元素处理，不会去查应用
   * 的全局注册表，直接写会渲染成一堆空的 <x-card> 自定义元素。
   * 这里统一包一层：命中 App.components 内的 x-* 组件时改传组件对象。
   * ================================================================== */
  const rawH = Vue.h;

  function h(type, propsOrChildren, children) {
    if (typeof type === 'string' && type.indexOf('-') > 0 && type.charAt(0) === 'x') {
      const comps = global.App && global.App.components;
      const comp = comps && comps[type];
      if (comp) {
        const args = Array.prototype.slice.call(arguments);
        args[0] = comp;
        return rawH.apply(null, args);
      }
      if (window.console) console.warn('[h] 未注册的组件标签：<' + type + '>');
    }
    return rawH.apply(null, arguments);
  }

  global.App = {
    Store, API, Router, define, resolve, go, h,
    fmt, DICT, dict, notify, toast, closeToast, copyText, debounce, usePager, cache, staticNote,
    confirm: confirmDialog,
    chartBase, catAxis, valAxis, areaGrad, useChart, PALETTE,
    /* 【新增增强】2026-10-25 升级层 */
    flags, flag, setFlag, NET,
    errHint, showErr, validators, validate,
    prefs, setPref, applyPrefs, recent,
    vue: { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick },
  };
  global.setSession = setSession;
})(window);
