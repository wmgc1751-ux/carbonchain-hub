/* =====================================================================
   notify-center.js —— 全局实时通知中心
   ---------------------------------------------------------------------
   【功能】
   ① 顶栏铃铛 + 未读数徽标（红色圆点），有新消息时铃铛抖动闪烁；
   ② 点击展开下拉面板：最新 10 条（分类色点 + 标题 + 时间 + 来源），
      打开即视为已读（徽标清零）；
   ③ 新消息到达时右下角 toast 弹窗提醒（含分类与来源）；
   ④ 双通道实时接收：
        · 本地后端：SSE /api/notify/stream —— 权威源站抓到新消息即推送
        · 云端 / SSE 失败：60 秒轮询 /api/public/notices —— 增量检测
   ⑤ 已读状态存 localStorage（cch_notice_seen_ts），跨刷新保持。

   【为什么已读存前端而不是数据库】
   通知是"广播型"消息（无个人化定向），已读只影响"红点显示"这一
   客户端体验；为此加一张 notice_read 表 + 每次打开面板一次写请求，
   在云端会白白消耗 D1 写入配额。单设备体验下 localStorage 等价，
   成本为零。

   【覆盖范围】组件挂在公开顶栏与工作台顶栏两处 topbar-right ——
   公众、企业、核查、监管、交易、管理全部角色页面都有铃铛与弹窗。

   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  const SEEN_KEY = 'cch_notice_seen_ts';
  const POLL_MS = 60000;          // 轮询兜底间隔
  const PANEL_SIZE = 10;          // 面板展示条数
  const FETCH_SIZE = 30;          // 内存中保留的最新条数

  /* ------------------------------------------------------------------
   * 样式（一次性注入）
   * ------------------------------------------------------------------ */
  const STYLE_ID = 'notify-center-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
.nc-bell{position:relative;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);
  color:var(--tx-2);width:32px;height:32px;border-radius:8px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:.15s;flex:none}
.nc-bell:hover{border-color:rgba(16,185,129,.45);color:#6ee7b7}
/* 带 label 的合体形态（公开顶栏）：铃铛 + 文字同一按钮，如「🔔 通知公告」 */
.nc-bell.has-label{width:auto;padding:0 13px 0 11px;gap:6px;font-size:12.4px;color:var(--tx-1)}
.nc-bell.has-label:hover{color:#6ee7b7}
.nc-bell .nc-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;
  border-radius:999px;background:#f43f5e;color:#fff;font-size:11px;font-weight:700;line-height:16px;
  text-align:center;box-shadow:0 2px 8px rgba(244,63,94,.5);font-family:var(--mono)}
.nc-bell.flashing{animation:ncShake .6s ease-in-out 3, ncGlow 1.8s ease-in-out 1}
@keyframes ncShake{0%,100%{transform:rotate(0)}20%{transform:rotate(-12deg)}40%{transform:rotate(10deg)}
  60%{transform:rotate(-7deg)}80%{transform:rotate(5deg)}}
@keyframes ncGlow{0%,100%{box-shadow:0 0 0 0 rgba(244,63,94,0)}30%{box-shadow:0 0 0 6px rgba(244,63,94,.35)}}

.nc-wrap{position:relative}
.nc-panel{position:absolute;right:0;top:40px;width:min(360px,calc(100vw - 40px));max-height:460px;
  overflow-y:auto;z-index:9500;border:1px solid rgba(16,185,129,.25);border-radius:12px;
  background:linear-gradient(180deg,rgba(11,18,30,.98),rgba(9,15,26,.99));
  box-shadow:0 18px 48px rgba(0,0,0,.55);backdrop-filter:blur(12px);animation:ncIn .16s ease-out}
@keyframes ncIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.nc-head{display:flex;align-items:center;justify-content:space-between;
  padding:10px 13px;border-bottom:1px solid rgba(255,255,255,.07);position:sticky;top:0;
  background:rgba(11,18,30,.98);z-index:1}
.nc-head b{font-size:12.8px;color:var(--tx-0)}
.nc-head .nc-live{font-size:11px;color:#6ee7b7;display:flex;align-items:center;gap:5px}
.nc-head .nc-live i{width:6px;height:6px;border-radius:50%;background:#10b981;animation:ncPulse 2s infinite}
@keyframes ncPulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}70%{box-shadow:0 0 0 6px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}
.nc-item{display:flex;gap:9px;padding:9px 13px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.04)}
.nc-item:hover{background:rgba(16,185,129,.06)}
.nc-item .nc-dot{width:7px;height:7px;border-radius:50%;margin-top:6px;flex:none}
.nc-item .nc-title{font-size:12.2px;color:var(--tx-1);line-height:1.5;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nc-item.unread .nc-title{color:var(--tx-0);font-weight:600}
.nc-item .nc-meta{font-size:11px;color:var(--tx-3);margin-top:2px}
.nc-item .nc-cat{font-family:var(--mono)}
.nc-foot{padding:8px 13px;text-align:center;border-top:1px solid rgba(255,255,255,.06)}
.nc-foot button{background:none;border:none;color:#6ee7b7;font-size:11.6px;cursor:pointer}
.nc-foot button:hover{text-decoration:underline}
.nc-empty{padding:26px 13px;text-align:center;color:var(--tx-3);font-size:12px}

/* toast 弹窗提醒 */
.nc-toast{position:fixed;right:22px;bottom:86px;z-index:9600;width:min(340px,calc(100vw - 44px));
  border:1px solid rgba(16,185,129,.35);border-radius:12px;overflow:hidden;
  background:linear-gradient(180deg,rgba(11,18,30,.98),rgba(9,15,26,.99));
  box-shadow:0 16px 44px rgba(0,0,0,.55);backdrop-filter:blur(12px);cursor:pointer;
  animation:ncToastIn .3s cubic-bezier(.2,.9,.3,1.2)}
@keyframes ncToastIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
.nc-toast.out{animation:ncToastOut .25s ease-in forwards}
@keyframes ncToastOut{to{opacity:0;transform:translateX(40px)}}
.nc-toast .nc-t-head{display:flex;align-items:center;gap:7px;padding:8px 12px 0;
  font-size:11px;color:#6ee7b7;font-weight:600}
.nc-toast .nc-t-title{padding:4px 12px 8px;font-size:12.4px;color:var(--tx-0);line-height:1.55;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nc-toast .nc-t-src{padding:0 12px 10px;font-size:11px;color:var(--tx-3)}
`;
    document.head.appendChild(el);
  }

  /* ------------------------------------------------------------------
   * 分类色（与 x-tag tone 对应的圆点颜色）
   * ------------------------------------------------------------------ */
  const CAT_COLORS = {
    OFFICIAL: '#10b981', POLICY: '#38bdf8', MARKET: '#f5a524',
    INTERNATIONAL: '#a78bfa', PLATFORM: '#71829b',
  };
  const CAT_LABEL = {
    OFFICIAL: '官方通知', POLICY: '政策法规', MARKET: '市场动态',
    INTERNATIONAL: '国际动态', SYSTEM: '平台公告',
  };
  function catOf(n) { return n.category || n.notice_type || n.noticeType || 'PLATFORM'; }
  function timeOf(n) { return n.publishedAt || n.publish_time || null; }
  function srcOf(n) { return n.sourceName || n.source_name || n.publisher || '平台'; }
  function urlOf(n) { return n.sourceUrl || n.source_url || null; }

  /* ------------------------------------------------------------------
   * 全局单例状态（跨组件共享：公开顶栏 / 工作台顶栏共用一份数据）
   * ------------------------------------------------------------------ */
  const state = {
    notices: ref([]),
    open: ref(false),
    flashing: ref(false),
    live: ref(false),            // 实时通道是否就绪（SSE 或轮询中）
    _mode: ref(null),            // 'sse' | 'poll' —— 面板状态标签用
    /* 未读集合（会话内）：为什么不用"发布时间 > 已读时间戳"判断？
     * 客户端与服务器时钟存在偏差 —— 客户端快 2 秒时，刚推送的消息
     * publishedAt(服务器) < seenTs(客户端 Date.now())，新消息会被
     * 误判为已读、徽标不亮。用标题集合判断与任何时钟无关。
     * seenTs 仍持久化到 localStorage，仅用于"刷新后"的初次过滤。 */
    _unread: ref([]),            // 未读标题数组（数组替换触发响应式）
    _seenTs: Number(localStorage.getItem(SEEN_KEY) || 0),
    _es: null,                   // EventSource
    _poll: null,                 // 轮询 timer
    _known: new Set(),           // 已见过的标题（增量检测）
    _toastEl: null, _toastTimer: null,
    _inited: false,
  };

  const unread = computed(() => state.notices.value.filter((n) => state._unread.value.includes(n.title)).length);

  function markAllSeen() {
    state._seenTs = Date.now();
    localStorage.setItem(SEEN_KEY, String(state._seenTs));
    state._unread.value = [];    // 替换引用触发响应式更新
  }

  /* ------------------------------------------------------------------
   * 数据加载
   * ------------------------------------------------------------------ */
  async function loadList() {
    try {
      const rows = await App.API.get('/public/notices', { page: 1, size: FETCH_SIZE });
      const list = Array.isArray(rows) ? rows : (rows.rows || []);
      state.notices.value = list;
      for (const n of list) {
        state._known.add(n.title);
        /* 刷新后初次过滤：localStorage 时间戳晚于发布时间的算未读
         * （时钟偏差在此场景可接受——误差只是多/少几个红点，不是漏掉弹窗） */
        const t = timeOf(n);
        if (t && new Date(String(t).replace(' ', 'T')).getTime() > state._seenTs) {
          state._unread.value = [...state._unread.value, n.title];
        }
      }
      return list;
    } catch { return []; }
  }

  /* ------------------------------------------------------------------
   * 新消息处理：入列 + 铃铛闪烁 + toast 弹窗
   * ------------------------------------------------------------------ */
  function absorb(rows, { silent = false } = {}) {
    if (!Array.isArray(rows)) return;
    const fresh = rows.filter((n) => n.title && !state._known.has(n.title));
    if (!fresh.length) return;
    for (const n of fresh) state._known.add(n.title);
    /* 新的排前面，截断到 FETCH_SIZE */
    state.notices.value = [...fresh, ...state.notices.value].slice(0, FETCH_SIZE);
    /* 会话内新消息一律记未读（与时钟无关，弹窗与徽标判断一致） */
    state._unread.value = [...state._unread.value, ...fresh.map((n) => n.title)];
    if (silent) return;                    // 首次加载不弹窗

    /* 铃铛抖动闪烁 */
    state.flashing.value = false;
    requestAnimationFrame(() => { state.flashing.value = true; });
    setTimeout(() => { state.flashing.value = false; }, 2400);

    /* 弹窗（最新一条；多条时提示总数） */
    showToast(fresh[0], fresh.length);
  }

  function showToast(n, count) {
    /* 单例：新弹窗顶掉旧的 */
    if (state._toastEl) { state._toastEl.close(); }
    const el = document.createElement('div');
    el.className = 'nc-toast';
    const cat = catOf(n);
    el.innerHTML = `
      <div class="nc-t-head">🔔 碳链通 · 收到 ${count > 1 ? count + ' 条新通知' : '新通知'}</div>
      <div class="nc-t-title"></div>
      <div class="nc-t-src"></div>`;
    el.querySelector('.nc-t-title').textContent = n.title;
    el.querySelector('.nc-t-src').textContent =
      `${CAT_LABEL[cat] || '通知'} · ${srcOf(n)} · ${App.fmt.dt(timeOf(n))}`;
    const close = () => {
      if (!el.parentNode) return;
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    };
    el.close = close;
    el.onclick = () => {
      const u = urlOf(n);
      if (u) window.open(u, '_blank', 'noopener');
      else App.go('/notice');
      close();
    };
    document.body.appendChild(el);
    state._toastEl = { close };
    state._toastTimer = setTimeout(close, 8000);
  }

  /* ------------------------------------------------------------------
   * 实时通道
   * ------------------------------------------------------------------ */
  function connect() {
    /* 通道 1：SSE（本地后端）。云端 Pages 无此端点（404）→
     * EventSource 永久关闭 → 自动落到通道 2 轮询。 */
    try {
      const es = new EventSource(App.API.base + '/notify/stream');
      state._es = es;
      es.addEventListener('hello', () => { state.live.value = true; state._mode.value = 'sse'; });
      es.addEventListener('notice', (e) => {
        try {
          const d = JSON.parse(e.data);
          absorb(d.rows || []);
        } catch { /* 半包忽略 */ }
      });
      es.onerror = () => {
        state.live.value = false;
        /* readyState CLOSED 表示浏览器已放弃（如 404/网络断）——
         * 切换轮询兜底。自动重连中（CONNECTING）则等待，不重复切换。 */
        if (es.readyState === EventSource.CLOSED) {
          state._es = null;
          startPolling();
        }
      };
      es.onopen = () => { state.live.value = true; state._mode.value = 'sse'; };
      return;
    } catch { /* SSE 不可用 → 轮询 */ }
    startPolling();
  }

  function startPolling() {
    if (state._poll) return;
    state.live.value = true;   // 轮询也算"在线"
    state._mode.value = 'poll';
    state._poll = setInterval(async () => {
      try {
        const rows = await App.API.get('/public/notices', { page: 1, size: 6 });
        absorb(Array.isArray(rows) ? rows : (rows.rows || []));
      } catch { /* 网络抖动，下轮再试 */ }
    }, POLL_MS);
  }

  function disconnect() {
    if (state._es) { state._es.close(); state._es = null; }
    if (state._poll) { clearInterval(state._poll); state._poll = null; }
  }

  /* ------------------------------------------------------------------
   * 组件：铃铛按钮 + 下拉面板
   * ------------------------------------------------------------------ */
  const NoticeBell = defineComponent({
    name: 'notice-bell',
    /* label：可选，传入后铃铛按钮呈"图标+文字"合体形态（公开顶栏用）；
     * 工作台顶栏不传，保持纯图标 */
    props: { label: { type: String, default: '' } },
    setup(props) {
      injectStyle();

      onMounted(async () => {
        if (!state._inited) {
          state._inited = true;
          await loadList();
          connect();
          document.addEventListener('click', onDocClick, true);
        }
      });
      onUnmounted(() => { /* 单例状态不随组件卸载 —— 两处顶栏共用 */ });

      function onDocClick(e) {
        if (!state.open.value) return;
        if (e.target.closest && e.target.closest('.nc-wrap')) return;
        state.open.value = false;
      }

      function toggle() {
        state.open.value = !state.open.value;
        if (state.open.value) markAllSeen();   // 打开即已读
      }

      function goItem(n) {
        state.open.value = false;
        const u = urlOf(n);
        /* 有原文链接的真实消息直接打开原文（站内无详情时），否则进站内详情 */
        if (u && Number(n.id) < 0) { window.open(u, '_blank', 'noopener'); return; }
        App.go('/notice/' + n.id);
      }

      return () => {
        const n = unread.value;
        const items = state.notices.value.slice(0, PANEL_SIZE);

        const panel = !state.open.value ? null : h('div', { class: 'nc-panel' }, [
          h('div', { class: 'nc-head' }, [
            h('b', {}, '通知中心'),
            h('span', {
              class: 'nc-live',
              title: state._mode.value === 'sse'
                ? 'SSE 实时推送已连接（权威源站新消息秒级到达）'
                : '轮询模式（每 60 秒检查一次新消息）',
            }, [
              h('i'),
              state.live.value ? (state._mode.value === 'sse' ? '实时' : '轮询') : '连接中',
            ]),
          ]),
          !items.length
            ? h('div', { class: 'nc-empty' }, '暂无通知 —— 权威源站消息实时聚合中')
            : h('div', {}, items.map((it) => {
              const cat = catOf(it);
              const t = timeOf(it);
              const isNew = state._unread.value.includes(it.title);
              return h('div', { class: ['nc-item', isNew && 'unread'], onClick: () => goItem(it) }, [
                h('span', { class: 'nc-dot', style: 'background:' + (CAT_COLORS[cat] || CAT_COLORS.PLATFORM) }),
                h('div', { style: 'flex:1;min-width:0' }, [
                  h('div', { class: 'nc-title' }, it.title),
                  h('div', { class: 'nc-meta' }, [
                    h('span', { class: 'nc-cat' }, CAT_LABEL[cat] || '通知'),
                    ' · ' + srcOf(it) + ' · ' + App.fmt.dt(t),
                  ]),
                ]),
              ]);
            })),
          h('div', { class: 'nc-foot' }, [
            h('button', { onClick: () => { state.open.value = false; App.go('/notice'); } }, '查看全部通知 →'),
          ]),
        ]);

        return h('div', { class: 'nc-wrap' }, [
          h('button', {
            class: ['nc-bell', props.label && 'has-label', state.flashing.value && 'flashing'],
            title: n ? `${n} 条未读通知` : '通知中心',
            /* WCAG 2.5.3 / axe label-content-name-mismatch：可见文本（未读数徽标）
             * 必须包含在可访问名内 —— 固定 aria-label 与动态徽标数字不符
             * 会在全站每页触发 serious 违规（2026-10-31 AA 审计）。 */
            'aria-label': n ? `通知中心，${n > 99 ? '99+' : n} 条未读` : '通知中心',
            onClick: toggle,
          }, [
            h('span', { 'aria-hidden': 'true', style: 'font-size:15px;line-height:1' }, '🔔'),
            props.label ? h('span', {}, props.label) : null,
            n ? h('span', { 'aria-hidden': 'true', class: 'nc-badge' }, n > 99 ? '99+' : String(n)) : null,
          ]),
          panel,
        ]);
      };
    },
  });

  App.NoticeBell = NoticeBell;
})();
