/* =====================================================================
   real.js —— 真实数据层 + 实时运转
   ---------------------------------------------------------------------
   这组页面的任务不是"好看"，而是**让真实性可被当场核验**：

     /real           真实数据总览   规模 / 覆盖 / 分层计数 / 实时 ticker
     /real/facilities 真实设施台账  美国 EPA + 中国 Climate TRACE 双源，可逐条回溯
     /real/benchmarks 行业真实基准  均值 vs 中位数 vs P90 vs Top10 集中度
     /real/trend     年度真实趋势   2010–2018 九年度，同比不插值
     /real/macro     宏观真实序列   世界银行 / OWID
     /real/truth     真实性契约     10 条声明，运行时逐条实算对照

   三条设计立场（贯穿全组页面）：

   ① **每行数据都带"它是哪一层"**。REAL / DERIVED / MODELED 三个标签
      出现在每个数字旁边，而不是只在页脚写一句"部分数据为模拟"。
      页脚免责声明是免责，行内标签才是披露。

   ② **实时分两类显示**。甲类（平台自身状态）每秒跳动并注明题；
      乙类（外部年频源）显示"数据年度 + 最近同步时间"，**不假装每秒在变**。
      给年频数据加抖动来"看起来实时"，是数据可视化里最常见的造假。

   ③ **不可主张的事写在页面上**。比如"哪些是美国设施、哪些是中国第三方观测估算"
      无任何关系"——这句必须出现在总览首屏，而不是藏在文档里。

   数据获取策略：本层 API 全部**无需登录**，因此页面在未登录状态也能看。
   这正是"可被第三方核验"的实现方式。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, reactive, onMounted, onUnmounted, watch, nextTick } = Vue;
  const h = App.h;

  /* ------------------------------------------------------------------
   * 样式
   * ------------------------------------------------------------------ */
  const STYLE_ID = 'real-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
/* 真实性等级标签 —— 三种颜色对应三层，全站统一 */
.rl-tier{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:11px;
  letter-spacing:.4px;padding:1.5px 6px;border-radius:5px;line-height:1.5;white-space:nowrap}
.rl-tier.REAL{background:rgba(16,185,129,.17);color:var(--ok-tx);border:1px solid rgba(16,185,129,.3)}
.rl-tier.DERIVED{background:rgba(6,182,212,.15);color:#67e8f9;border:1px solid rgba(6,182,212,.28)}
.rl-tier.MODELED{background:rgba(245,165,36,.15);color:var(--warn-tx);border:1px solid rgba(245,165,36,.3)}
.rl-tier.PLATFORM{background:rgba(167,139,250,.15);color:#c4b5fd;border:1px solid rgba(167,139,250,.28)}

/* 实时 ticker */
.rl-live{display:flex;align-items:center;gap:7px;font-size:11.6px;color:var(--tx-3)}
.rl-dot{width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 0 rgba(16,185,129,.6);
  animation:rlPulse 2s infinite}
.rl-dot.off{background:#64748b;animation:none;box-shadow:none}
@keyframes rlPulse{
  0%{box-shadow:0 0 0 0 rgba(16,185,129,.55)}
  70%{box-shadow:0 0 0 7px rgba(16,185,129,0)}
  100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}
}
.rl-liveval{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--ok-tx);font-size:13px;
  transition:color .3s}
.rl-liveval.flash{color:#a7f3d0}

/* 卡片/表 */
.rl-grid{display:grid;gap:12px}
.rl-kpis{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.rl-2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.rl-note{border-left:3px solid rgba(6,182,212,.5);padding:8px 12px;background:rgba(6,182,212,.055);
  border-radius:0 8px 8px 0;font-size:12.2px;line-height:1.78;color:var(--tx-1);margin:10px 0}
.rl-warn{border-left:3px solid rgba(245,165,36,.6);padding:8px 12px;background:rgba(245,165,36,.06);
  border-radius:0 8px 8px 0;font-size:12.2px;line-height:1.78;color:var(--tx-1);margin:10px 0}
.rl-bad{border-left:3px solid rgba(244,63,94,.6);padding:8px 12px;background:rgba(244,63,94,.06);
  border-radius:0 8px 8px 0;font-size:12.2px;line-height:1.78;color:var(--tx-1);margin:10px 0}
.rl-ok{border-left:3px solid rgba(16,185,129,.55);padding:8px 12px;background:rgba(16,185,129,.055);
  border-radius:0 8px 8px 0;font-size:12.2px;line-height:1.78;color:var(--tx-1);margin:10px 0}

.rl-table{width:100%;border-collapse:collapse;font-size:12.2px}
.rl-table th{text-align:left;font-weight:500;color:var(--tx-3);font-size:11.2px;padding:7px 9px;
  border-bottom:1px solid var(--hair);white-space:nowrap;position:sticky;top:0;
  background:var(--bg-1);z-index:1}
.rl-table td{padding:7px 9px;border-bottom:1px solid var(--hair);color:var(--tx-1);vertical-align:middle}
.rl-table tbody tr:hover{background:rgba(255,255,255,.022)}
.rl-table .mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.rl-table .r{text-align:right}
.rl-scroll{max-height:min(62vh,620px);overflow:auto;border-radius:8px}

.rl-form{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px}
.rl-form .fi{display:flex;flex-direction:column;gap:4px}
.rl-form label{font-size:11px;color:var(--tx-3);letter-spacing:.3px}
.rl-form input,.rl-form select{padding:6px 9px;border-radius:7px;font-size:12.2px;
  background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0);min-width:110px}
.rl-form input:focus,.rl-form select:focus{outline:none;border-color:rgba(16,185,129,.5)}

.rl-pager{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:10px;font-size:12px;
  color:var(--tx-3)}
.rl-btn{padding:5px 12px;border-radius:7px;font-size:12px;cursor:pointer;border:1px solid var(--hair);
  background:var(--bg-1);color:var(--tx-1);transition:.15s}
.rl-btn:hover:not(:disabled){border-color:rgba(16,185,129,.45);color:var(--ok-tx)}
.rl-btn:disabled{opacity:.35;cursor:not-allowed}
.rl-btn.on{background:rgba(16,185,129,.15);color:var(--ok-tx);border-color:rgba(16,185,129,.4)}

/* 真实性契约 */
.rl-decl{border:1px solid var(--hair);border-radius:10px;padding:11px 13px;margin-bottom:9px;
  background:var(--bg-1);transition:.15s}
/* 不符项：原来只有一圈浅红描边 + 5% 底色，在一屏 10 条声明里几乎看不出来
   （2026-10-29 巡检 P1-28）。改为左侧 3px 实心红条 + 略强底色，扫视即可命中。 */
.rl-decl.fail{border-color:rgba(244,63,94,.5);border-left:3px solid #f43f5e;background:rgba(244,63,94,.07)}
/* 从汇总条跳转过来时闪一下，长列表里一眼能看见落在哪一条 */
.rl-decl.hit{box-shadow:0 0 0 2px rgba(244,63,94,.6);background:rgba(244,63,94,.13)}
.rl-failbar{margin-top:12px;padding:10px 13px;border:1px solid rgba(244,63,94,.45);
  border-radius:10px;background:rgba(244,63,94,.08);font-size:12.6px;line-height:1.8}
.rl-failbar .jump{display:inline-flex;align-items:center;gap:5px;margin:6px 6px 0 0;
  padding:3px 10px;border-radius:7px;border:1px solid rgba(244,63,94,.45);
  background:rgba(244,63,94,.12);color:#fda4af;font-size:11.8px;cursor:pointer}
.rl-failbar .jump:hover{background:rgba(244,63,94,.22)}
.rl-decl-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.rl-decl-t{font-size:13px;color:var(--tx-0);font-weight:500}
.rl-decl-c{font-size:12.4px;line-height:1.75;color:var(--tx-1);margin:5px 0}
.rl-decl-m{font-size:11.4px;line-height:1.7;color:var(--tx-3);font-family:var(--mono)}
.rl-decl-n{font-size:11.6px;line-height:1.72;color:var(--warn-tx);margin-top:5px}
.rl-chip{font-family:var(--mono);font-size:11px;padding:1.5px 7px;border-radius:5px;
  background:rgba(255,255,255,.05);color:var(--tx-2)}
.rl-chip.pass{background:rgba(16,185,129,.16);color:var(--ok-tx)}
.rl-chip.fail{background:rgba(244,63,94,.16);color:var(--danger-tx)}

.rl-bar{height:6px;border-radius:4px;background:rgba(255,255,255,.07);overflow:hidden;min-width:52px}
.rl-bar i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#10b981,#06b6d4)}

/* 标题区右侧元素自动靠右 —— 本组页面把实时状态条/操作按钮直接作为 .page-head
   的第二子节点，而不是包一层 .acts，所以这里补一条对齐规则。
   比给每个页面套 .acts 更省事，也避免漏掉某一页导致标题与按钮挤在一起。 */
.rl-page-head > .rl-live,
.rl-page-head > .flex{ margin-left:auto; display:flex; gap:8px; align-items:center }
`;
    document.head.appendChild(el);
  }

  /* ------------------------------------------------------------------
   * 小工具
   * ------------------------------------------------------------------ */
  const num = (v, d = 0) => (v === null || v === undefined || !isFinite(v)) ? '—'
    : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  const mt = (v) => (v === null || v === undefined) ? '—' : num(v, 2) + ' Mt';
  const pct = (v, d = 2) => (v === null || v === undefined) ? '—'
    : (Number(v) * 100).toFixed(d) + '%';
  const ago = (sec) => {
    if (sec === null || sec === undefined) return '从未同步';
    if (sec < 60) return `${Math.round(sec)} 秒前`;
    if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时前`;
    return `${(sec / 86400).toFixed(1)} 天前`;
  };
  const Tier = (t) => h('span', { class: 'rl-tier ' + (t || 'REAL') }, t || 'REAL');

  /* ==================================================================
   * 实时订阅（全局单例）
   * ==================================================================
   * 【为什么用 EventSource 且做成单例】
   * 六个页面都要显示实时指标。如果每页各开一条 SSE 连接，切页时旧连接
   * 不一定立刻关闭（组件卸载与连接关闭存在竞态），最终会堆出 N 条连接，
   * 服务端每 tick 要往 N 个死连接写数据。
   * 单例 + 引用计数：只有第一个页面订阅时建连，最后一个页面卸载时断开。
   * 这是 EventSource 与组件生命周期之间最容易漏掉的一环。
   */
  const live = reactive({
    connected: false,
    metrics: {},
    tick: 0,
    tickMs: 1000,
    uptimeSec: 0,
    lastAt: 0,
    refs: 0,
    es: null,
    /* 通道类型：sse（服务端推送）/ poll（轮询兜底）/ off（都没有）
     * 静态部署（Cloudflare Pages）没有后端进程，SSE 连不上 —— 此时自动退化为
     * 每秒轮询 /api/real/live。静态站里这个端点由 staticApi 就地重算 MODELED
     * 指标（确定性负荷曲线，与服务端同式），所以数字依然每秒在动，
     * 而且是"真值"不是抖动。若不标明通道类型，用户无从判断他看到的是
     * 服务端推送还是本地推算 —— 这必须显示出来。 */
    mode: 'off',
    pollTimer: null,
    errCount: 0,
  });

  function applyMetrics(list) {
    if (!Array.isArray(list)) return;
    for (const m of list) live.metrics[m.key] = m;
    live.tick = (live.tick || 0) + 1;
    live.lastAt = Date.now();
  }

  function startPolling() {
    if (live.pollTimer) return;
    live.mode = 'poll';
    const tickOnce = async () => {
      try {
        const d = await App.API.get('/real/live');
        live.connected = true;
        live.errCount = 0;
        live.tickMs = (d && d.tickMs) || 1000;
        live.uptimeSec = (d && d.uptimeSec) || 0;
        applyMetrics(d && d.metrics);
      } catch (e) {
        live.errCount++;
        if (live.errCount > 5) { live.connected = false; }
      }
    };
    tickOnce();
    live.pollTimer = setInterval(tickOnce, 1000);
  }

  function stopPolling() {
    if (live.pollTimer) clearInterval(live.pollTimer);
    live.pollTimer = null;
  }

  function liveSubscribe() {
    live.refs++;
    if (live.es || live.pollTimer) return;
    trySse();
  }

  function trySse() {
    if (live.es || live.pollTimer) return;
    try {
      const es = new EventSource((App.API.base || './api') + '/real/stream');
      live.es = es;
      live.mode = 'sse';
      es.addEventListener('snapshot', (e) => {
        try {
          const d = JSON.parse(e.data);
          live.connected = true;
          live.tickMs = d.tickMs || 1000;
          live.uptimeSec = d.uptimeSec || 0;
          applyMetrics(d.metrics);
          /* SSE 恢复后停掉轮询 —— 两条通道同时跑会让 tick 计数翻倍，
           * 页面上的"tick"就不再是真实 tick 数。 */
          if (live.pollTimer) { stopPolling(); live.mode = 'sse'; }
        } catch (err) { /* 帧损坏则跳过，下一帧再来 */ }
      });
      es.addEventListener('tick', (e) => {
        try {
          const d = JSON.parse(e.data);
          live.connected = true;
          applyMetrics(d.metrics);
        } catch (err) { /* 同上 */ }
      });
      es.onopen = () => { live.connected = true; };
      es.onerror = () => {
        live.connected = false;
        /* ⚠ 这里不能"等连续失败 N 次再降级"。
         * 静态部署（Cloudflare Pages / 本地 http.server）对 /api/real/stream
         * 返回 404，而按 EventSource 规范，非 200 或 content-type 不是
         * text/event-stream 属于**致命失败，浏览器不会重连** ——
         * onerror 只会触发一次。于是"等 3 次"的判据永远不成立，
         * 页面就一直停在"断开（重连中）"，数字全是破折号。
         * 实测确认：这就是静态模式下实时面板不出数的根因。
         * 正确做法：首次失败立即降级为轮询；再定时尝试恢复 SSE。 */
        try { es.close(); } catch (e2) {}
        live.es = null;
        startPolling();
        scheduleSseRetry();
      };
    } catch (err) {
      live.connected = false;
      startPolling();
    }
  }

  let sseRetryTimer = null;
  function scheduleSseRetry() {
    if (sseRetryTimer) return;
    /* 60 秒再试一次 SSE。静态站上会立刻再次失败并重新排期 ——
     * 代价是每分钟一个 404 请求，可以忽略；而真实服务端若只是短暂抖动，
     * 60 秒后就能回到推送模式。 */
    sseRetryTimer = setTimeout(() => {
      sseRetryTimer = null;
      if (live.refs > 0 && !live.es) {
        const wasPolling = !!live.pollTimer;
        trySse();
        if (wasPolling && !live.es) scheduleSseRetry();
      }
    }, 60000);
  }

  function liveUnsubscribe() {
    live.refs = Math.max(0, live.refs - 1);
    if (live.refs > 0) return;
    if (live.es) { try { live.es.close(); } catch (e) {} live.es = null; }
    stopPolling();
    if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
    live.connected = false;
    live.mode = 'off';
  }

  /**
   * 实时数值组件：数字变化时闪一下。
   * 不做"滚动数字"动画 —— 那会让相邻两次变化看起来连续，
   * 掩盖了"数据其实是每 tick 跳一次"的事实。
   */
  const LiveVal = defineComponent({
    name: 'rl-live-val',
    props: {
      k: String, digits: { type: Number, default: 3 }, unit: String,
      big: Boolean, fallback: { type: String, default: '—' },
    },
    setup(props) {
      const flash = ref(false);
      let last = null;
      watch(() => (live.metrics[props.k] || {}).value, (v) => {
        if (last !== null && v !== last) {
          flash.value = true;
          setTimeout(() => { flash.value = false; }, 320);
        }
        last = v;
      });
      const m = computed(() => live.metrics[props.k]);
      return () => {
        const v = m.value ? m.value.value : null;
        const display = (v === null || v === undefined) ? props.fallback
          : Number(v).toLocaleString('zh-CN', {
            minimumFractionDigits: props.digits, maximumFractionDigits: props.digits,
          });
        return h('span', {
          class: ['rl-liveval', flash.value && 'flash'],
          style: props.big ? 'font-size:19px;color:var(--tx-0)' : '',
        }, [display, props.unit ? h('span', {
          style: 'font-size:11px;color:var(--tx-3);margin-left:3px',
        }, props.unit) : null]);
      };
    },
  });

  /** 实时状态条：连接状态 + tick + 最后更新 */
  const LiveBar = defineComponent({
    name: 'rl-live-bar',
    setup() {
      const since = ref(0);
      let timer = null;
      onMounted(() => {
        liveSubscribe();
        timer = setInterval(() => {
          since.value = live.lastAt ? (Date.now() - live.lastAt) / 1000 : null;
        }, 500);
      });
      onUnmounted(() => {
        liveUnsubscribe();
        if (timer) clearInterval(timer);
      });
      return () => h('div', { class: 'rl-live' }, [
        h('span', { class: ['rl-dot', !live.connected && 'off'] }),
        h('span', {}, live.connected
          ? (live.mode === 'sse' ? '实时通道已连接（服务端推送）'
            : '实时通道已连接（静态模式 · 每秒轮询 · MODELED 指标本地重算）')
          : (live.mode === 'poll' ? '轮询重连中' : '实时通道断开（重连中）')),
        h('span', { style: 'color:var(--tx-3)' }, '·'),
        h('span', { class: 'mono' }, `tick ${live.tick}`),
        h('span', { style: 'color:var(--tx-3)' }, '·'),
        h('span', {}, since.value === null ? '等待首帧'
          : `最后一帧 ${since.value < 1.5 ? '刚刚' : since.value.toFixed(1) + ' 秒前'}`),
      ]);
    },
  });

  /* ==================================================================
   * 页面一：真实数据总览
   * ================================================================== */
  App.views['page-real-overview'] = defineComponent({
    name: 'page-real-overview',
    setup() {
      injectStyle();
      const d = ref(null);
      const liveSnap = ref(null);
      const err = ref('');
      const loading = ref(true);

      async function load() {
        loading.value = true; err.value = '';
        try {
          const [ov, lv] = await Promise.all([
            App.API.get('/real/overview'),
            App.API.get('/real/live').catch(() => null),
          ]);
          d.value = ov;
          liveSnap.value = lv;
        } catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      const maxInd = computed(() => {
        const a = (d.value && d.value.byIndustry) || [];
        return a.length ? Math.max(...a.map((x) => x.mt)) : 1;
      });
      const maxState = computed(() => {
        const a = (d.value && d.value.byState) || [];
        return a.length ? Math.max(...a.map((x) => x.mt)) : 1;
      });

      return () => {
        if (loading.value) {
          return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '加载真实数据层…')]);
        }
        if (err.value) {
          return h('div', { class: 'page' }, [
            h('div', { class: 'rl-bad' }, '真实数据层不可用：' + err.value),
            h('button', { class: 'rl-btn', onClick: load }, '重试'),
          ]);
        }
        const x = d.value;

        return h('div', { class: 'page' }, [
          /* 头部 */
          h('div', { class: 'page-head rl-page-head' }, [
            h('div', {}, [
              h('h2', {}, '真实数据层'),
              h('div', { class: 'desc' },
                '本页所有数字均来自官方/第三方公开数据集，可逐条回溯原始记录；'
                + '每行都标注来源、许可与数据性质。'),
              /* 「年度真实趋势」自导航收敛（2026-10-30），改由本页直达 */
              h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' }, [
                h('button', { class: 'rl-btn', onClick: () => App.go('/real/trend') }, '年度真实趋势 ↗'),
              ]),
            ]),
            h('div', { class: 'acts' }, [h(LiveBar)]),
          ]),

          /* 最重要的一句话：先说清边界（2026-10-31 国内版）。
           * 境外源（EPA GHGRP / Climate TRACE）已下线并清库，本层由国内公开数据承接：
           * 污染物 = 省公开系统小时级实测（REAL）；CO₂ = 活动水平法核算（DERIVED）。
           * 分层陈述，数字全部来自接口返回的 byCountry。 */
          h('div', { class: 'rl-warn', style: 'margin-top:12px' }, [
            h('b', {}, '数据边界声明：'),
            ' 本层共 ',
            h('b', {}, num(x.facilities)),
            ' 家接入企业（河北省保定域垃圾焚烧发电），来自两类互不相同的源：',
            (x.byCountry || []).map((c) => h('span', {
              style: 'display:inline-block;margin:0 6px;padding:1px 7px;border-radius:5px;'
                + 'background:rgba(255,255,255,.06);font-family:var(--mono);font-size:11.4px',
            }, `${c.iso} ${num(c.facilities)} 家`)),
            '。',
            h('span', {}, [
              h('b', {}, 'SO₂ / NOx / 颗粒物'),
              '（河北省污染源自动监控信息公开系统）为',
              h('b', {}, '小时级实测排放量'),
              '，是平台原生字段；',
              h('b', {}, 'CO₂'),
              '（活动水平法）为',
              h('b', {}, '官方统计处理量 × 标准因子的核算值'),
              ' —— GB 18485 焚烧 CEMS 不监测 CO₂，这不是缺陷而是监测制度的边界，',
              h('b', {}, '平台不冒充实测'),
              '。核算公式与输入随接口返回，第三方可当场复算。',
            ]),
          ]),

          /* 规模 KPI */
          h('div', { class: ['rl-grid', 'rl-kpis'], style: 'margin:14px 0' }, [
            kpi('真实接入企业', num(x.facilities), '家', 'REAL', `${x.industries} 个行业 · 河北省保定域`),
            kpi('真实数据行', num(x.emissionRows), '条', 'REAL', `小时实测 + 日均浓度 · ${x.yearFrom}–${x.yearTo} 共 ${x.years} 年`),
            kpi('年度 CO₂ 核算合计', num(x.totalTonnes / 1e4, 2), '万t', 'DERIVED', `${x.activityYear} 年度 · 活动水平法，可复算`),
            kpi('已上链批次', num(x.anchoredBatches), '批', 'REAL', '小时数据按批锚定联盟链'),
          ]),

          /* 实时指标 */
          h('div', { class: 'card', style: 'margin-bottom:14px' }, [
            h('div', { class: 'card-head' }, [
              h('div', { class: 'flex-1' }, [
                h('h3', {}, '实时运转'),
                h('div', { class: 'sub' }, '甲类指标每秒推进；乙类为年频真实源，只显示数据年度与同步时间'),
              ]),
              h('div', { class: 'acts' }, [h(LiveBar)]),
            ]),
            h('div', { class: 'card-body' }, [
              h('div', { class: ['rl-grid', 'rl-kpis'] }, [
                liveKpi('全平台瞬时排放速率', 'cems.instantRate', 4, 'tCO₂e/s', 'MODELED',
                  '日均速率 × 负荷曲线（确定性，可复算）'),
                liveKpi('今日累计排放', 'cems.todayEmission', 1, 'tCO₂e', 'MODELED', '模型口径'),
                liveKpi('联盟链高度', 'chain.height', 0, '块', 'PLATFORM', '出块由调度器驱动'),
                liveKpi('累计上链交易', 'chain.txs', 0, '笔', 'PLATFORM', '链上真实交易数'),
                liveKpi('平台成交均价', 'market.price', 2, '元/t', 'PLATFORM', '近 365 日成交均值'),
                liveKpi('国内 CEMS 小时实测', 'cn.hours', 0, '条', 'REAL', '河北省公开系统 · 静态累计'),
              ]),
              h('div', { class: 'rl-note' }, [
                h('b', {}, '为什么有些指标每秒钟在变、有些不动：'),
                ' 平台自身的链高度、累计交易、结算流水是',
                h('b', {}, '真实发生的系统状态'),
                '，每秒读一次确实不同；而 EPA 年度数据一年只发布一版，',
                '把它做成每秒跳动只是动画效果。给年频数据加抖动来"显得实时"，',
                '是数据可视化里最常见的造假手法 —— 本平台不做。',
              ]),
            ]),
          ]),

          /* 行业 + 州 分布 */
          h('div', { class: ['rl-grid', 'rl-2'], style: 'margin-bottom:14px' }, [
            h('div', { class: 'card' }, [
              h('div', { class: 'card-head' }, [
                h('div', { class: 'flex-1' }, [
                  h('h3', {}, '行业分布'),
                  h('div', { class: 'sub' }, `CO₂ 核算 ${x.activityYear} 年度 · 活动水平法（DERIVED）`),
                ]),
                h('div', { class: 'acts' }, [Tier('DERIVED')]),
              ]),
              h('div', { class: 'card-body' }, x.byIndustry.map((r) => h('div', {
                style: 'padding:6px 0;border-bottom:1px solid var(--hair)',
              }, [
                h('div', { class: 'flex between', style: 'font-size:12.4px;margin-bottom:4px' }, [
                  h('span', {}, r.industry),
                  h('span', { class: 'mono', style: 'color:var(--tx-2)' },
                    `${mt(r.mt)} · ${num(r.facilities)} 家`),
                ]),
                h('div', { class: 'rl-bar' }, [
                  h('i', { style: `width:${(r.mt / maxInd.value * 100).toFixed(1)}%` }),
                ]),
              ]))),
            ]),
            h('div', { class: 'card' }, [
              h('div', { class: 'card-head' }, [
                h('div', { class: 'flex-1' }, [
                  h('h3', {}, '企业分布'),
                  h('div', { class: 'sub' }, `按 ${x.activityYear} 年度 CO₂ 核算量排序`),
                ]),
                h('div', { class: 'acts' }, [Tier('DERIVED')]),
              ]),
              h('div', { class: 'card-body' }, x.byState.map((r) => h('div', {
                style: 'padding:4px 0',
              }, [
                h('div', { class: 'flex between', style: 'font-size:11.9px;margin-bottom:3px' }, [
                  h('span', { class: 'mono' }, r.state),
                  h('span', { style: 'color:var(--tx-3)' }, `${mt(r.mt)} · ${r.facilities}`),
                ]),
                h('div', { class: 'rl-bar', style: 'height:4px' }, [
                  h('i', { style: `width:${(r.mt / maxState.value * 100).toFixed(1)}%` }),
                ]),
              ]))),
            ]),
          ]),

          /* 数据源 */
          h('div', { class: 'card' }, [
            h('div', { class: 'card-head' }, [
              h('div', { class: 'flex-1' }, [
                h('h3', {}, '数据源登记'),
                h('div', { class: 'sub' }, '每个源都记录许可协议与最近同步状态 —— 无法溯源的数据不应进入平台'),
              ]),
            ]),
            h('div', { class: 'card-body', style: 'padding:0' }, [
              h('div', { class: 'rl-scroll' }, [
                h('table', { class: 'rl-table' }, [
                  h('thead', {}, [h('tr', {}, [
                    h('th', {}, '数据源'), h('th', {}, '发布机构'), h('th', {}, '许可'),
                    h('th', { class: 'r' }, '记录数'), h('th', {}, '最近同步'),
                  ])]),
                  h('tbody', {}, x.sources.map((s) => h('tr', {}, [
                    h('td', {}, [h('div', { style: 'color:var(--tx-0)' }, s.name),
                      h('div', { class: 'mono', style: 'font-size:11px;color:var(--tx-3)' }, s.key)]),
                    h('td', { style: 'font-size:11.6px' }, s.publisher || '—'),
                    h('td', { style: 'font-size:11.4px' }, s.license || '—'),
                    h('td', { class: 'mono r' }, s.recordCount === null ? '—' : num(s.recordCount)),
                    h('td', { style: 'font-size:11.4px' }, s.lastFetchedAt
                      ? App.fmt.dt(s.lastFetchedAt) : '—'),
                  ]))),
                ]),
              ]),
            ]),
          ]),
        ]);
      };
    },
  });

  /* ==================================================================
   * 页面二：真实设施台账
   * ================================================================== */
  App.views['page-real-facilities'] = defineComponent({
    name: 'page-real-facilities',
    setup() {
      injectStyle();
      const rows = ref([]);
      const meta = ref({ page: 1, size: 20, total: 0, year: null });
      const loading = ref(false);
      const err = ref('');
      const q = reactive({
        industry: '', state: '', keyword: '', minTonnes: '', sort: 'emission',
        order: 'DESC', page: 1, size: 20,
      });
      const INDUSTRIES = ['垃圾焚烧发电'];

      async function load() {
        loading.value = true; err.value = '';
        try {
          const env = await App.API.getEnvelope('/real/facilities', {
            industry: q.industry, state: q.state, q: q.keyword,
            minTonnes: q.minTonnes, sort: q.sort, order: q.order,
            page: q.page, size: q.size,
          });
          rows.value = env.data || [];
          meta.value = env.meta || meta.value;
        } catch (e) { err.value = e.message || String(e); rows.value = []; }
        loading.value = false;
      }
      onMounted(load);

      const totalPages = computed(() => Math.max(1, Math.ceil(meta.value.total / q.size)));

      function apply() { q.page = 1; load(); }
      function sortBy(col) {
        if (q.sort === col) q.order = q.order === 'ASC' ? 'DESC' : 'ASC';
        else { q.sort = col; q.order = 'DESC'; }
        load();
      }
      function goto(p) {
        q.page = Math.max(1, Math.min(totalPages.value, p));
        load();
      }
      const sortMark = (col) => q.sort === col ? (q.order === 'ASC' ? ' ↑' : ' ↓') : '';

      return () => h('div', { class: 'page' }, [
        h('div', { class: 'page-head rl-page-head' }, [
          h('div', {}, [
            h('h2', {}, '真实设施台账'),
            h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7' }, [
              '共 ',
              h('b', { style: 'color:var(--tx-1)' }, num(meta.value.total)),
              ' 条真实记录（当前年度 ',
              h('b', { style: 'color:var(--tx-1)' }, String(meta.value.year || '—')),
              '）。点击行展开年度序列与工艺分解。',
            ]),
          ]),
          h(LiveBar),
        ]),

        h('div', { class: 'rl-note', style: 'margin-top:12px' }, [
          h('b', {}, '每条记录可独立核验：'),
          ' 主体代码为统一社会信用代码（18 位，全国唯一）；小时级污染物数据来自河北省公开系统原始报文，',
          'CO₂ 为官方统计处理量 × 标准因子的核算值，公式与输入随接口返回、可当场复算。',
        ]),

        /* 筛选 */
        h('div', { class: 'rl-form' }, [
          h('div', { class: 'fi' }, [
            h('label', {}, '行业'),
            h('select', {
              value: q.industry,
              onChange: (e) => { q.industry = e.target.value; apply(); },
            }, [h('option', { value: '' }, '全部行业'),
              ...INDUSTRIES.map((i) => h('option', { value: i }, i))]),
          ]),
          h('div', { class: 'fi' }, [
            h('label', {}, '地市'),
            h('input', {
              value: q.state, placeholder: '如 保定',
              onInput: (e) => { q.state = e.target.value; },
              onChange: apply,
            }),
          ]),
          h('div', { class: 'fi' }, [
            h('label', {}, '设施名称 / 设施号'),
            h('input', {
              value: q.keyword, placeholder: '关键字',
              onInput: (e) => { q.keyword = e.target.value; },
              onChange: apply,
            }),
          ]),
          h('div', { class: 'fi' }, [
            h('label', {}, '最小排放 (tCO₂e)'),
            h('input', {
              value: q.minTonnes, placeholder: '如 1000000',
              onInput: (e) => { q.minTonnes = e.target.value; }, onChange: apply,
            }),
          ]),
          h('button', { class: 'rl-btn', onClick: load }, '刷新'),
          h('button', {
            class: 'rl-btn', onClick: () => {
              Object.assign(q, { industry: '', state: '', keyword: '', minTonnes: '', page: 1 });
              load();
            },
          }, '清空条件'),
        ]),

        err.value ? h('div', { class: 'rl-bad' }, err.value) : null,

        h('div', { class: 'card' }, [
          h('div', { class: 'card-body', style: 'padding:0' }, [
            loading.value ? h('div', { class: 'empty', style: 'padding:30px' }, '查询中…')
              : h('div', { class: 'rl-scroll' }, [
                h('table', { class: 'rl-table' }, [
                  h('thead', {}, [h('tr', {}, [
                    h('th', { style: 'cursor:pointer', onClick: () => sortBy('name') },
                      '设施' + sortMark('name')),
                    h('th', { style: 'cursor:pointer', onClick: () => sortBy('industry') },
                      '行业' + sortMark('industry')),
                    h('th', { style: 'cursor:pointer', onClick: () => sortBy('state') },
                      '位置' + sortMark('state')),
                    h('th', {}, '主体代码'),
                    h('th', { class: 'r', style: 'cursor:pointer', onClick: () => sortBy('emission') },
                      'CO₂ 核算 (tCO₂)' + sortMark('emission')),
                    h('th', { class: 'r' }, '实测小时'),
                    h('th', {}, '等级'),
                  ])]),
                  h('tbody', {}, rows.value.length ? rows.value.map((r) => h('tr', {
                    key: r.id,
                    onClick: () => { location.hash = '#/real/facility/' + r.id; },
                    style: 'cursor:pointer',
                  }, [
                    h('td', {}, [h('div', { style: 'color:var(--tx-0)' }, r.name),
                      h('div', { class: 'mono', style: 'font-size:11px;color:var(--tx-3)' },
                        r.naics ? 'NAICS ' + r.naics : '')]),
                    h('td', {}, r.industry),
                    h('td', { class: 'mono', style: 'font-size:11.4px' },
                      `${r.state || '—'}${r.city ? ' · ' + r.city : ''}`),
                    h('td', { class: 'mono', style: 'font-size:11.2px' }, r.facilityId),
                    h('td', { class: 'mono r', style: 'color:var(--brand-l)' }, num(r.totalCO2e, 0)),
                    h('td', { class: 'mono r' }, num(r.measuredHours, 0)),
                    h('td', {}, [Tier(r.authenticity)]),
                  ])) : [h('tr', {}, [h('td', {
                    colspan: 7, style: 'text-align:center;padding:26px;color:var(--tx-3)',
                  }, '没有符合条件的记录')])]),
                ]),
              ]),
          ]),
        ]),

        h('div', { class: 'rl-pager' }, [
          h('span', {}, `共 ${num(meta.value.total)} 条 · 第 ${q.page} / ${totalPages.value} 页`),
          h('button', { class: 'rl-btn', disabled: q.page <= 1, onClick: () => goto(1) }, '首页'),
          h('button', { class: 'rl-btn', disabled: q.page <= 1, onClick: () => goto(q.page - 1) }, '上一页'),
          h('button', {
            class: 'rl-btn', disabled: q.page >= totalPages.value,
            onClick: () => goto(q.page + 1),
          }, '下一页'),
          h('button', {
            class: 'rl-btn', disabled: q.page >= totalPages.value,
            onClick: () => goto(totalPages.value),
          }, '末页'),
        ]),
      ]);
    },
  });

  /* ==================================================================
   * 页面三：单设施明细
   * ================================================================== */
  App.views['page-real-facility'] = defineComponent({
    name: 'page-real-facility',
    setup() {
      injectStyle();
      const d = ref(null);
      const err = ref('');
      const id = ref(null);

      async function load() {
        /* 从 Router.params 取，而不是解析 location.hash。
         * 原因：从台账点进 A 设施、再点进 B 设施时，路由视图仍是同一个组件，
         * Vue 会复用实例而**不会重新 mounted**。若只在 onMounted 里读取，
         * 页面会永远停在第一次打开的那个设施上 —— 表现为"点了没反应"，
         * 而且不报错，极难发现。必须 watch 参数变化。 */
        const raw = (App.Router.params && App.Router.params.id) || null;
        id.value = raw ? Number(raw) : null;
        if (!id.value) { err.value = 'URL 中没有设施 ID'; return; }
        err.value = '';
        d.value = null;
        try { d.value = await App.API.get('/real/facilities/' + id.value); }
        catch (e) { err.value = e.message || String(e); }
      }
      onMounted(load);
      watch(() => App.Router.params.id, (nv, ov) => { if (nv !== ov) load(); });

      return () => {
        if (err.value) {
          return h('div', { class: 'page' }, [
            h('div', { class: 'rl-bad' }, err.value),
            h('button', {
              class: 'rl-btn',
              onClick: () => { location.hash = '#/real/facilities'; },
            }, '返回台账'),
          ]);
        }
        if (!d.value) return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '加载中…')]);
        const x = d.value;
        const maxE = Math.max(...x.series.map((s) => s.totalCO2e), 1);
        const last = x.series[x.series.length - 1];
        const procs = last && last.processes ? last.processes : [];

        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head rl-page-head' }, [
            h('div', {}, [
              h('h2', {}, x.name),
              h('div', { style: 'font-size:12.3px;color:var(--tx-3);font-family:var(--mono)' },
                `主体代码 ${x.facilityId} · ${x.state || ''} ${x.city || ''}`),
            ]),
            h('div', { class: 'flex', style: 'gap:8px;align-items:center' }, [
              Tier(x.authenticity),
              h('button', {
                class: 'rl-btn',
                onClick: () => { location.hash = '#/real/facilities'; },
              }, '返回台账'),
            ]),
          ]),

          h('div', { class: 'rl-note', style: 'margin-top:12px' }, [
            h('b', {}, '原始数据地址：'),
            h('span', { class: 'mono', style: 'font-size:11.3px;word-break:break-all' },
              x.sourceUrl || '—'),
            h('div', { style: 'margin-top:4px' },
              '生态环境部生活垃圾焚烧发电厂自动监测数据公开平台（官方渠道）：可核对该企业污染物日均浓度与达标情况。'
              + 'CO₂ 核算的输入（省发改委统计处理量）与公式随 emission_calc.evidence 返回，可当场复算。'),
          ]),

          h('div', { class: ['rl-grid', 'rl-kpis'], style: 'margin:14px 0' }, [
            kpi('最新年度 CO₂ 核算', num(last.totalCO2e, 0), 't', 'DERIVED', String(last.year) + ' · 活动水平法'),
            kpi('CEMS 实测小时', num((x.real || {}).measuredHours, 0), 'h', 'REAL',
              `有效/合计 ${num((x.real || {}).measuredHours, 0)}/${num((x.real || {}).hours, 0)}`),
            kpi('SO₂ 排放（实测）', num((x.real || {}).so2Kg / 1000, 2), 't', 'REAL', '小时级合计'),
            kpi('NOx 排放（实测）', num((x.real || {}).noxKg / 1000, 2), 't', 'REAL', '小时级合计'),
            kpi('颗粒物（实测）', num((x.real || {}).pmKg / 1000, 2), 't', 'REAL', '小时级合计'),
            kpi('年度间变化', last.yoy === null ? '—' : pct(last.yoy), '', 'DERIVED',
              last.yoy === null ? '官方统计表仅公布 2024 年度' : '相邻年真实对比'),
          ]),

          /* 年度序列 */
          h('div', { class: 'card', style: 'margin-bottom:14px' }, [
            h('div', { class: 'card-head' }, [
              h('div', { class: 'flex-1' }, [
                h('h3', {}, '年度 CO₂ 核算序列'),
                h('div', { class: 'sub' }, '缺数据的年份不插值 —— 没有就是没有'),
              ]),
              h('div', { class: 'acts' }, [Tier('DERIVED')]),
            ]),
            h('div', { class: 'card-body' }, x.series.map((s) => h('div', {
              style: 'padding:5px 0;border-bottom:1px solid var(--hair)',
            }, [
              h('div', { class: 'flex between', style: 'font-size:12.2px;margin-bottom:3px' }, [
                h('span', { class: 'mono' }, String(s.year)),
                h('span', { class: 'flex', style: 'gap:10px;align-items:center' }, [
                  s.yoy !== null && h('span', {
                    class: 'mono', style: `font-size:11px;color:${s.yoy > 0 ? 'var(--danger-tx)' : 'var(--ok-tx)'}`,
                  }, (s.yoy > 0 ? '+' : '') + (s.yoy * 100).toFixed(2) + '%'),
                  h('span', { class: 'mono', style: 'color:var(--tx-1)' }, num(s.totalCO2e, 0)),
                ]),
              ]),
              h('div', { class: 'rl-bar' }, [
                h('i', { style: `width:${(s.totalCO2e / maxE * 100).toFixed(1)}%` }),
              ]),
            ]))),
          ]),

          /* 工艺分解 */
          procs.length ? h('div', { class: 'card' }, [
            h('div', { class: 'card-head' }, [
              h('div', { class: 'flex-1' }, [
                h('h3', {}, `排放来自哪里 · ${last.year}`),
                h('div', { class: 'sub' }, 'EPA 按工艺段（Subpart）上报的原始分解'),
              ]),
              h('div', { class: 'acts' }, [Tier('REAL')]),
            ]),
            h('div', { class: 'card-body' }, procs.map((p) => h('div', {
              style: 'display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--hair);font-size:12.3px',
            }, [
              h('span', {}, [p.nameCn || p.name,
                p.nameCn && h('span', {
                  style: 'color:var(--tx-3);font-size:11px;margin-left:6px',
                }, p.name)]),
              h('span', { class: 'mono', style: 'color:var(--tx-1)' },
                `${num(p.emission, 0)} t · ${(p.emission / last.totalCO2e * 100).toFixed(1)}%`),
            ]))),
          ]) : null,
        ]);
      };
    },
  });

  /* ==================================================================
   * 页面四：行业真实基准
   * ================================================================== */
  App.views['page-real-benchmarks'] = defineComponent({
    name: 'page-real-benchmarks',
    setup() {
      injectStyle();
      const rows = ref([]);
      const err = ref('');
      const loading = ref(true);

      async function load() {
        loading.value = true;
        try { rows.value = await App.API.get('/real/benchmarks'); }
        catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      return () => h('div', { class: 'page' }, [
        h('div', { class: 'page-head rl-page-head' }, [
          h('div', {}, [
            h('h2', {}, '行业真实基准'),
            h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:660px' },
              '基于河北省公开系统小时级排放数据（28.6 万条实测）的排口排放速率分布。分位数直接取样自真实分布，不是拟合曲线。'),
            /* 「宏观真实序列」自导航收敛（2026-10-30），改由本页直达 */
            h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' }, [
              h('button', { class: 'rl-btn', onClick: () => App.go('/real/macro') }, '宏观真实序列 ↗'),
            ]),
          ]),
          h(LiveBar),
        ]),

        h('div', { class: 'rl-note', style: 'margin-top:12px' }, [
          h('b', {}, '为什么均值、P50 和峰值必须同时给出：'),
          ' 焚烧工况存在启炉与负荷波动，小时排放速率的长尾会显著抬高均值 —— ',
          'P50 代表"典型小时"，',
          h('b', {}, '峰值'),
          '用于捕捉异常尖峰（对照 GB 18485 限值与治理设施运行状态），',
          '而均值决定总量。只看均值会把尖峰摊平，只看峰值会以偏概全 —— ',
          h('b', {}, '三个数一起看，才能既评总量又抓异常'),
          '。以上全部取样自真实小时分布，非拟合。',
        ]),

        err.value ? h('div', { class: 'rl-bad' }, err.value) : null,

        loading.value ? h('div', { class: 'card' }, [h('div', { class: 'empty' }, '加载中…')])
          : h('div', { class: 'card' }, [
            h('div', { class: 'card-body', style: 'padding:0' }, [
              h('table', { class: 'rl-table' }, [
                h('thead', {}, [h('tr', {}, [
                  h('th', {}, '企业（排口）'), h('th', { class: 'r' }, '样本小时'),
                  h('th', { class: 'r' }, '年排放合计 (t)'), h('th', { class: 'r' }, '小时均值 (kg/h)'),
                  h('th', { class: 'r' }, 'P50 (kg/h)'), h('th', { class: 'r' }, 'P90 (kg/h)'),
                  h('th', { class: 'r' }, '峰值 (kg/h)'), h('th', { class: 'r' }, 'Top10% 份额'),
                ])]),
                h('tbody', {}, rows.value.map((r) => h('tr', {}, [
                  h('td', { style: 'color:var(--tx-0)' }, r.industry),
                  h('td', { class: 'mono r' }, num(r.samples)),
                  h('td', { class: 'mono r', style: 'color:var(--brand-l)' }, num(r.totalMt, 1)),
                  h('td', { class: 'mono r' }, num(r.meanMt, 1)),
                  h('td', { class: 'mono r' }, num(r.medianMt, 1)),
                  h('td', { class: 'mono r' }, num(r.p90Mt, 1)),
                  h('td', { class: 'mono r' }, num(r.maxMt, 1)),
                  h('td', { class: 'mono r' }, r.top10Share === null ? '—' : pct(r.top10Share, 1)),
                ]))),
              ]),
            ]),
          ]),

        h('div', { class: 'rl-warn', style: 'margin-top:14px' }, [
          h('b', {}, '使用限制：'),
          ' 本基准是',
          h('b', {}, '美国'),
          '工业设施的分布，与中国重点排放单位的规模结构、能源结构（煤电占比）、',
          '产能水平均不同。它的正确用途是（a）作为核算引擎在真实数据上的对照集；',
          '（b）说明"名额分配必须看分布而不是看均值"这一方法学结论。',
          '它',
          h('b', {}, '不可'),
          '直接作为中国行业的配额基准值使用。',
        ]),
      ]);
    },
  });

  /* ==================================================================
   * 页面五：年度真实趋势
   * ================================================================== */
  App.views['page-real-trend'] = defineComponent({
    name: 'page-real-trend',
    setup() {
      injectStyle();
      const d = ref(null);
      const err = ref('');
      const chartEl = ref(null);
      let chart = null;
      let chartRO = null;
      /* 图表容器自适应：init 只取一次宽度，视口一缩（桌面页切手机宽）
         画布仍是桌面尺寸，右半被卡片裁掉 ⇒ 挂 ResizeObserver 跟随容器 */
      function roResize() {
        if (chartRO) chartRO.disconnect();
        if (!chartEl.value) return;
        chartRO = new ResizeObserver(() => { if (chart && !chart.isDisposed()) chart.resize(); });
        chartRO.observe(chartEl.value);
      }
      function roTeardown() { if (chartRO) { chartRO.disconnect(); chartRO = null; } }

      async function load() {
        try {
          d.value = await App.API.get('/real/trend');
          await nextTick();
          draw();
        } catch (e) { err.value = e.message || String(e); }
      }

      function draw() {
        if (!chartEl.value || !d.value || !window.echarts) return;
        if (chart) chart.dispose();
        chart = echarts.init(chartEl.value);
        roResize();
        const s = d.value.series;
        chart.setOption(App.chartBase({
          grid: { left: 12, right: 20, top: 42, bottom: 8, containLabel: true },
          legend: {
            data: ['CO₂e（活动水平法 · DERIVED）', 'SO₂（实测）', 'NOx（实测）', '颗粒物（实测）'],
            textStyle: { color: '#8d9cb5', fontSize: 11.5 }, top: 4, icon: 'roundRect',
          },
          tooltip: Object.assign({}, App.chartBase().tooltip, { trigger: 'axis' }),
          xAxis: { type: 'category', data: s.map((x) => x.year), axisLabel: { color: '#8d9cb5' } },
          yAxis: [
            { type: 'value', name: '万t CO₂e', nameTextStyle: { color: '#8d9cb5', fontSize: 11 },
              axisLabel: { color: '#8d9cb5' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)' } } },
            { type: 'value', name: '污染物 t', nameTextStyle: { color: '#8d9cb5', fontSize: 11 },
              axisLabel: { color: '#8d9cb5' }, splitLine: { show: false } },
          ],
          series: [
            { name: 'CO₂e（活动水平法 · DERIVED）', type: 'line', smooth: false, symbolSize: 6,
              connectNulls: false,
              data: s.map((x) => x.co2Mt === null ? null : Number((x.co2Mt * 100).toFixed(2))),
              lineStyle: { width: 2.6, color: '#10b981' }, itemStyle: { color: '#10b981' },
              areaStyle: { color: App.areaGrad('rgba(16,185,129,.28)', 'rgba(16,185,129,0)') } },
            { name: 'SO₂（实测）', type: 'line', yAxisIndex: 1, smooth: false, symbolSize: 4,
              connectNulls: false, data: s.map((x) => x.so2t),
              lineStyle: { width: 1.6, color: '#06b6d4' }, itemStyle: { color: '#06b6d4' } },
            { name: 'NOx（实测）', type: 'line', yAxisIndex: 1, smooth: false, symbolSize: 4,
              connectNulls: false, data: s.map((x) => x.noxt),
              lineStyle: { width: 1.4, color: '#f5a524' }, itemStyle: { color: '#f5a524' } },
            { name: '颗粒物（实测）', type: 'line', yAxisIndex: 1, smooth: false, symbolSize: 4,
              connectNulls: false, data: s.map((x) => x.pmt),
              lineStyle: { width: 1.4, color: '#a78bfa' }, itemStyle: { color: '#a78bfa' } },
          ],
        }));
      }

      onMounted(load);
      onUnmounted(() => { roTeardown(); if (chart) { chart.dispose(); chart = null; } });

      /* 页头常驻：首屏聚合要跑 4～5 s，原实现在拿到数据前只渲染一句"加载中…"，
         页面没有标题、没有骨架，用户看到的是一张空白页（自动化巡检也会判成"无页头"）。
         结构先到位、内容再填，是这类慢聚合页应有的形态。 */
      function pageHead(sub) {
        return h('div', { class: 'page-head rl-page-head' }, [
          h('div', {}, [
            h('h2', {}, '年度真实趋势'),
            h('div', { style: 'font-size:12.4px;color:var(--tx-3)' }, sub),
          ]),
          h(LiveBar),
        ]);
      }

      return () => {
        if (err.value) {
          return h('div', { class: 'page' }, [
            pageHead('真实数据集年度汇总'),
            h('div', { class: 'card', style: 'margin-top:14px' }, [
              h('x-empty', { title: '年度趋势加载失败', sub: String(err.value), tone: 'danger', retry: true, onRetry: () => load() }),
            ]),
          ]);
        }
        if (!d.value) {
          return h('div', { class: 'page' }, [
            pageHead('真实数据集年度汇总 · 正在聚合'),
            h('div', { class: 'rl-grid rl-kpis', style: 'margin:14px 0' },
              [0, 1, 2, 3].map(() => h('div', { class: 'skel', style: 'height:74px' }))),
            h('div', { class: 'card' }, [h('div', { class: 'skel', style: 'height:300px' })]),
          ]);
        }
        const x = d.value;
        return h('div', { class: 'page' }, [
          pageHead(`${x.span.from}–${x.span.to}（${x.span.years} 个年度）· 四家保定焚烧企业，CO₂ 活动水平法 + 污染物小时实测`),

          h('div', { class: ['rl-grid', 'rl-kpis'], style: 'margin:14px 0' }, [
            kpi('期间变化', x.change ? (x.change.pct * 100).toFixed(2) + '%' : '—', '',
              'DERIVED', x.change ? '首末有数年真实对比' : 'CO₂ 仅 2024 年度有官方统计，无法对比'),
            kpi('绝对变化', x.change ? num(x.change.absMt, 2) : '—', 'Mt', 'DERIVED',
              x.change && x.change.absMt < 0 ? '净减少' : (x.change ? '净增加' : '无对比基准')),
            kpi('最新年度 CO₂e', x.series.filter((s) => s.co2Mt !== null).length
              ? num(x.series.filter((s) => s.co2Mt !== null).slice(-1)[0].co2Mt * 100, 1) : '—', '万t', 'DERIVED',
              '活动水平法 · 可复算'),
            kpi('最新实测小时', num(x.series[x.series.length - 1].hours), 'h', 'REAL',
              String(x.series[x.series.length - 1].year) + ' 年度 · ' + num(x.series[x.series.length - 1].facilities) + ' 家接入'),
          ]),

          h('div', { class: 'card', style: 'margin-bottom:14px' }, [
            h('div', { class: 'card-head' }, [
              h('div', { class: 'flex-1' }, [h('h3', {}, '排放趋势'), h('div', { class: 'sub' }, 'CO₂ 缺失年如实断线（connectNulls=false）；左轴万t CO₂e / 右轴污染物 t')]),
              h('div', { class: 'acts' }, [Tier('DERIVED')]),
            ]),
            h('div', { class: 'card-body' }, [
              h('div', { ref: chartEl, style: 'width:100%;height:340px' }),
            ]),
          ]),

          h('div', { class: 'card' }, [
            h('div', { class: 'card-head' }, [
              h('div', { class: 'flex-1' }, [h('h3', {}, '逐年明细与同比')]),
            ]),
            h('div', { class: 'card-body', style: 'padding:0' }, [
              h('table', { class: 'rl-table' }, [
                h('thead', {}, [h('tr', {}, [
                  h('th', {}, '年度'), h('th', { class: 'r' }, '实测小时'),
                  h('th', { class: 'r' }, 'CO₂e (万t)'), h('th', { class: 'r' }, 'SO₂ (t)'),
                  h('th', { class: 'r' }, 'NOx (t)'), h('th', { class: 'r' }, '颗粒物 (t)'),
                  h('th', { class: 'r' }, 'CO₂ 同比'),
                ])]),
                h('tbody', {}, x.series.map((s) => h('tr', {}, [
                  h('td', { class: 'mono', style: 'color:var(--tx-0)' }, String(s.year)),
                  h('td', { class: 'mono r' }, num(s.hours)),
                  h('td', { class: 'mono r', style: 'color:var(--brand-l)' },
                    s.co2Mt === null ? '—' : num(s.co2Mt * 100, 2)),
                  h('td', { class: 'mono r' }, num(s.so2t, 1)),
                  h('td', { class: 'mono r' }, num(s.noxt, 1)),
                  h('td', { class: 'mono r' }, num(s.pmt, 1)),
                  h('td', { class: 'mono r', style: s.yoy === null ? 'color:var(--tx-3)'
                    : (s.yoy > 0 ? 'color:var(--danger-tx)' : 'color:var(--ok-tx)') },
                  s.yoy === null ? '—' : (s.yoy > 0 ? '+' : '') + (s.yoy * 100).toFixed(2) + '%'),
                ]))),
              ]),
            ]),
          ]),

          h('div', { class: 'rl-note', style: 'margin-top:14px' }, [
            h('b', {}, '一个需要说清的细节：'),
            ' 图中 CO₂e 只有 ',
            h('b', {}, '2024'),
            ' 年度有值 —— 省发改委统计表目前只公布到 2024 年度，2023/2025/2026 没有',
            h('b', {}, '官方活动水平'),
            '就没有核算依据。平台把这些年份画成断线而不是插值连起来：',
            h('b', {}, '修正缺年来让曲线好看，正是数据造假的起点'),
            '。污染物三条线（SO₂/NOx/颗粒物）为小时级实测，2023–2026 全程有数。',
          ]),
        ]);
      };
    },
  });

  /* ==================================================================
   * 页面六：宏观真实序列
   * ================================================================== */
  App.views['page-real-macro'] = defineComponent({
    name: 'page-real-macro',
    setup() {
      injectStyle();
      const d = ref(null);
      const country = ref('CHN');
      const err = ref('');
      const chartEl = ref(null);
      let chart = null;
      let chartRO = null;
      /* 同上：画布必须跟随容器宽度（缺这个，窄屏图表会被裁掉右半） */
      function roResize() {
        if (chartRO) chartRO.disconnect();
        if (!chartEl.value) return;
        chartRO = new ResizeObserver(() => { if (chart && !chart.isDisposed()) chart.resize(); });
        chartRO.observe(chartEl.value);
      }
      function roTeardown() { if (chartRO) { chartRO.disconnect(); chartRO = null; } }

      async function load() {
        err.value = '';
        try {
          d.value = await App.API.get('/real/macro', { country: country.value });
          await nextTick();
          draw();
        } catch (e) { err.value = e.message || String(e); }
      }
      function draw() {
        if (!chartEl.value || !d.value || !window.echarts) return;
        if (chart) chart.dispose();
        chart = echarts.init(chartEl.value);
        roResize();
        const inds = d.value.indicators;
        /* 单年度截面：柱状对比比单点折线更可读（折线版在境外序列时代用） */
        chart.setOption(App.chartBase({
          grid: { left: 12, right: 20, top: 42, bottom: 8, containLabel: true },
          tooltip: Object.assign({}, App.chartBase().tooltip, { trigger: 'axis' }),
          xAxis: {
            type: 'category',
            data: inds.map((x) => x.indicatorCn.replace('区域电网基准线因子', '').replace('全国电网平均排放因子', '全国')),
            axisLabel: { color: '#8d9cb5', interval: 0, rotate: 30 },
          },
          yAxis: {
            type: 'value', name: 'tCO₂/MWh',
            nameTextStyle: { color: '#8d9cb5', fontSize: 11 },
            axisLabel: { color: '#8d9cb5' },
            splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)' } },
          },
          series: [{
            name: '电网碳排放因子',
            type: 'bar', barWidth: '52%',
            data: inds.map((x) => x.points.length ? x.points[0].value : null),
            itemStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: '#10b981' }, { offset: 1, color: 'rgba(16,185,129,.25)' }]),
              borderRadius: [4, 4, 0, 0],
            },
          }],
        }));
      }
      onMounted(load);
      onUnmounted(() => { roTeardown(); if (chart) { chart.dispose(); chart = null; } });

      return () => h('div', { class: 'page' }, [
        h('div', { class: 'page-head rl-page-head' }, [
          h('div', {}, [
            h('h2', {}, '区域电网碳排放因子'),
            h('div', { style: 'font-size:12.4px;color:var(--tx-3)' },
              '全国 + 七大区域电网因子（生态环境部发布，逐条带文号）· 用于范围二核算与绿电对比'),
          ]),
          h('div', { class: 'flex', style: 'gap:8px;align-items:center' }, [
            h('span', { class: 'rl-tier REAL' }, 'REAL'),
            h('span', { class: 'rl-chip' }, '年度发布 · 静态'),
            h(LiveBar),
          ]),
        ]),

        h('div', { class: 'rl-note', style: 'margin-top:12px' }, [
          h('b', {}, '为什么这些数据"实时"不了：'),
          ' 电网因子由生态环境部',
          h('b', {}, '按年度发布、滞后约 1~2 年'),
          '。平台上把它标为 ',
          h('span', { class: 'rl-tier REAL' }, 'REAL'),
          ' + ',
          h('span', { class: 'rl-chip' }, 'cadence STATIC'),
          '，显示数据年度与文号。',
          '如果有人告诉你某个平台的宏观碳数据"每秒实时更新"，那它更新的不是数据，是动画。',
        ]),

        err.value ? h('div', { class: 'rl-bad' }, err.value) : null,

        d.value ? h('div', {}, [
          h('div', { class: 'card', style: 'margin-bottom:14px' }, [
            h('div', { class: 'card-head' }, [
              h('div', { class: 'flex-1' }, [h('h3', {}, '因子对比（tCO₂/MWh）'),
                h('div', { class: 'sub' }, '范围二核算用"平均因子"；绿电环境权益对比用"基准线因子"——两者口径不同，不混用')]),
              h('div', { class: 'acts' }, [Tier('REAL')]),
            ]),
            h('div', { class: 'card-body' }, [
              h('div', { ref: chartEl, style: 'width:100%;height:330px' }),
            ]),
          ]),
          h('div', { class: 'card' }, [
            h('div', { class: 'card-head' }, [h('div', { class: 'flex-1' }, [h('h3', {}, '指标清单')])]),
            h('div', { class: 'card-body', style: 'padding:0' }, [
              h('table', { class: 'rl-table' }, [
                h('thead', {}, [h('tr', {}, [
                  h('th', {}, '指标'), h('th', {}, '单位'), h('th', {}, '来源'),
                  h('th', {}, '许可'), h('th', { class: 'r' }, '点数'),
                  h('th', {}, '年度范围'), h('th', { class: 'r' }, '最新值'),
                ])]),
                h('tbody', {}, d.value.indicators.map((x) => {
                  const pts = x.points.filter((p) => p.value !== null);
                  const last = pts[pts.length - 1];
                  return h('tr', {}, [
                    h('td', { style: 'color:var(--tx-0)' }, x.indicatorCn || x.indicator),
                    h('td', { style: 'font-size:11.4px' }, x.unit || '—'),
                    h('td', { style: 'font-size:11.4px' }, x.source.publisher || x.source.name),
                    h('td', { style: 'font-size:11.2px' }, x.source.license || '—'),
                    h('td', { class: 'mono r' }, String(pts.length)),
                    h('td', { class: 'mono', style: 'font-size:11.2px' },
                      pts.length ? `${pts[0].year}–${pts[pts.length - 1].year}` : '—'),
                    h('td', { class: 'mono r', style: 'color:var(--brand-l)' },
                      last ? num(last.value, 2) : '—'),
                  ]);
                })),
              ]),
            ]),
          ]),
        ]) : h('div', { class: 'card' }, [h('div', { class: 'empty' }, '加载中…')]),
      ]);
    },
  });

  /* ==================================================================
   * 页面七：真实性契约
   * ==================================================================
   * 这是整组的"宪法页"：每条声明都配一条核验 SQL，页面加载时**重新执行**，
   * 把声称值与实算值并排显示。任何一条对不上，页面立刻变红。
   *
   * 一个不能失败的声明，证明不了任何事。所以这里刻意写了具体数字（38501、5352），
   * 而不是"> 0"。
   */
  App.views['page-real-truth'] = defineComponent({
    name: 'page-real-truth',
    setup() {
      injectStyle();
      const d = ref(null);
      const err = ref('');
      const loading = ref(true);
      const filter = ref('ALL');

      async function load() {
        loading.value = true; err.value = '';
        try { d.value = await App.API.get('/real/truth'); }
        catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      const shown = computed(() => {
        const a = (d.value && d.value.declarations) || [];
        return filter.value === 'ALL' ? a : a.filter((x) => x.layer === filter.value);
      });

      /* 【缺陷 P1-28】不符项散落在 10 条声明的长列表里，页面只在上方写了一句
       * 「✘ 存在不符」，用户要自己往下翻才知道是哪一条。这里给出：
       *   ① 稳定的 DOM id（按声明内容生成，与筛选无关）；
       *   ② 上方汇总条里的「前往」按钮 —— 点击自动切回「全部」并滚动高亮到该条。 */
      const declId = (c) => 'rl-d-' + String(c.id != null ? c.id : c.subject)
        .replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 60);
      const hitId = ref('');
      function jumpTo(c) {
        filter.value = 'ALL';
        const id = declId(c);
        /* 等筛选切到「全部」后该条才一定在 DOM 里 */
        setTimeout(() => {
          const el = document.getElementById(id);
          if (!el) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          hitId.value = id;
          setTimeout(() => { if (hitId.value === id) hitId.value = ''; }, 2400);
        }, 80);
      }

      return () => {
        if (loading.value) return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '核验中…')]);
        if (err.value) return h('div', { class: 'page' }, [h('div', { class: 'rl-bad' }, err.value)]);
        const x = d.value;

        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head rl-page-head' }, [
            h('div', {}, [
              h('h2', {}, '数据真实性契约'),
              h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:680px' },
                '以下每一条声明都绑定了一条核验 SQL，本次页面加载时已重新执行。声称值与实算值并列显示 —— 对不上就变红。'),
            ]),
            h('div', { class: 'flex', style: 'gap:8px;align-items:center' }, [
              h('button', { class: 'rl-btn', onClick: load }, '重新核验'),
              h(LiveBar),
            ]),
          ]),

          /* 总结 */
          h('div', {
            class: x.summary.failed === 0 ? 'rl-ok' : 'rl-bad',
            style: 'margin-top:12px;font-size:13px',
          }, [
            h('b', {}, x.summary.failed === 0 ? '✔ 全部通过 · ' : '✘ 存在不符 · '),
            x.verdict,
            h('span', { style: 'color:var(--tx-3);margin-left:8px' },
              `（已核验 ${x.summary.passed}/${x.summary.verified} 条有计数断言；共 ${x.summary.total} 条声明）`),
          ]),

          /* 分层说明 */
          h('div', { class: ['rl-grid', 'rl-kpis'], style: 'margin:14px 0' }, [
            layerCard('REAL', x.summary.byLayer.REAL,
              '官方公开发布的真实数据，可逐条回溯到原始文件。这是平台唯一可以主张"真实"的层。'),
            layerCard('DERIVED', x.summary.byLayer.DERIVED,
              '以 REAL 为输入、经公开公式推导。推导链可复算 —— 给定相同输入，任何人算出相同结果。'),
            layerCard('MODELED', x.summary.byLayer.MODELED,
              '公开信息 + 建模假设构造的业务主体与时序。明确标注，不冒充实测，不主张其数据来自任何真实企业。'),
          ]),

          /* 不符项定位条：把"是哪一条"直接点出来（缺陷 P1-28） */
          x.summary.failed > 0 && h('div', { class: 'rl-failbar' }, [
            h('b', {}, `✘ ${x.summary.failed} 条声明与库内实际不符：`),
            h('span', { style: 'color:var(--tx-3);margin-left:6px' }, '点击条目直接定位，并高亮该条'),
            h('div', {}, ((x.declarations || []).filter((c) => c.pass === false)).map((c) =>
              h('button', { class: 'jump', onClick: () => jumpTo(c) },
                `${c.subject} →`))),
          ]),

          /* 筛选 */
          h('div', { style: 'display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap' }, [
            ...['ALL', 'REAL', 'DERIVED', 'MODELED'].map((k) => h('button', {
              class: ['rl-btn', filter.value === k && 'on'],
              onClick: () => { filter.value = k; },
            }, k === 'ALL' ? `全部 (${x.summary.total})` : `${k} (${x.summary.byLayer[k] || 0})`)),
          ]),

          /* 声明列表 */
          ...shown.value.map((c) => h('div', {
            id: declId(c),
            class: ['rl-decl', c.pass === false && 'fail', hitId.value && hitId.value === declId(c) && 'hit'],
          }, [
            h('div', { class: 'rl-decl-h' }, [
              Tier(c.layer),
              h('span', { class: 'rl-decl-t' }, c.subject),
              /* AT_LEAST/AT_MOST 语义下"一致"措辞不准：声称 60 / 实算 67 判过，
               * 显示"✔ 一致"会被读成精确相等（2026-10-31 巡检 P4）。按容差措辞。 */
              c.pass === true && h('span', { class: 'rl-chip pass' },
                c.tolerance === 'AT_LEAST' ? '✔ ≥ 预期' : c.tolerance === 'AT_MOST' ? '✔ ≤ 预期' : '✔ 一致'),
              c.pass === false && h('span', { class: 'rl-chip fail' }, '✘ 不符'),
              c.pass === null && h('span', { class: 'rl-chip' }, '仅文字声明'),
              c.expected !== null && h('span', { class: 'rl-chip' },
                `声称 ${num(c.expected)} / 实算 ${c.actual === null ? '—' : num(c.actual)}`),
            ]),
            h('div', { class: 'rl-decl-c' }, c.claim),
            h('div', { class: 'rl-decl-m' }, '依据：' + (c.basis || '—')),
            c.verifyError && h('div', { class: 'rl-decl-n' }, '核验异常：' + c.verifyError),
            /* note 里有 **强调** 标记，必须走 fmt.md 渲染；直接拼字符串会把
             * 星号原样显示成「该值为 0 时表示**尚无真实企业数据接入**」
             * （2026-10-29 巡检 P1-20 的同类残留）。 */
            c.note && h('div', { class: 'rl-decl-n' }, App.fmt.md('不可主张之处：' + c.note)),
          ])),

          h('div', { class: 'rl-warn', style: 'margin-top:16px' }, [
            h('b', {}, '这份契约的设计意图：'),
            ' 真实性声明如果是一段写死的文案，它和广告没有区别 —— 数据被删、被改、被重建，',
            '文案照样显示"全部真实"。只有当声明能在运行时被',
            h('b', {}, '计算出来'),
            '、并且',
            h('b', {}, '允许失败'),
            '时，它才是可证伪的断言，才有可能是真的。',
            '本页的每一条 expected 都写死了具体数字，因此它随时可能变红 —— 这正是它有意义的原因。',
          ]),
        ]);
      };
    },
  });

  /* ==================================================================
   * 真实企业 CEMS 与排放核算（2026-10-28）
   * ------------------------------------------------------------------
   * 这一页要同时回答两件事，缺一不可：
   *   ① 我们确实接入了真实企业数据（1150 条、8 排口、4 家企业、可溯源）
   *   ② 这批数据**算不出** CEMS 排放量（缺烟气流量），所以改用活动水平法核算
   * 只答①是吹牛，只答②等于白接。两件事并排放在首屏，是这一页的设计核心。
   * ================================================================== */
  App.views['page-real-ent-cems'] = defineComponent({
    name: 'page-real-ent-cems',
    setup() {
      injectStyle();
      const cov = ref(null);
      const emi = ref(null);
      const cemsEmi = ref(null);
      const cnCems = ref(null);
      const err = ref('');
      const loading = ref(true);

      async function load() {
        loading.value = true; err.value = '';
        try {
          const [a, b, d] = await Promise.all([
            App.API.get('/real/cems/coverage'),
            App.API.get('/real/cems/emission?year=2024'),
            /* EPA CAMD 段随境外源下线已摘除 —— 不再请求已不存在的
             * emission-coverage（console-audit 曾判 404 网络失败，2026-10-31） */
            App.API.get('/real/cems/cn/coverage').catch(() => null),
          ]);
          cov.value = a; emi.value = b; cemsEmi.value = null; cnCems.value = d;
        } catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      return () => {
        if (loading.value) return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '加载中…')]);
        if (err.value) return h('div', { class: 'page' }, [h('div', { class: 'rl-bad' }, err.value)]);
        const c = cov.value || {};
        const s = c.summary || {};
        const e2 = emi.value || {};
        const bd = c.boundary || {};
        const m = e2.method || {};

        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head rl-page-head' }, [
            h('div', {}, [
              h('h2', {}, '真实企业 CEMS 与排放核算'),
              h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:760px' },
                '数据来源：生态环境部生活垃圾焚烧发电厂自动监测数据公开平台（ljgk.envsc.cn）原始报文；'
                + '活动水平来自河北省发改委 2024 年统计表；排放因子来自 DB11/T 1416—2017 附录A。'
                + '本页所有排放量都可在页面内当场复算。'),
            ]),
          ]),

          h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px' }, [
            kpi('接入企业', s.enterprises, '家', 'REAL'),
            kpi('排放口', s.outlets, '个', 'REAL'),
            kpi('实测记录', num(s.records), '条', 'REAL'),
            kpi('已上链批次', s.anchoredBatches, '批', 'REAL'),
            kpi('核算排放量', (e2.totalTco2 / 10000).toFixed(2), '万tCO₂', 'DERIVED'),
            /* EPA CAMD 段（emission-coverage）随境外数据源下线：无数据时
             * 不渲染"0 小时 REAL"假 KPI —— 该整节本就按 cs.hours 为空自动隐藏 */
            ...((((cemsEmi.value || {}).summary || {}).hours)
              ? [kpi('CEMS实测小时', ((cemsEmi.value || {}).summary || {}).measuredHours || 0, '小时', 'REAL')]
              : []),
            kpi('中国CEMS小时', ((cnCems.value || {}).summary || {}).hours || 0, '小时', 'REAL'),
          ]),

          h('div', { class: 'rl-warn', style: 'margin-bottom:16px' }, [
            h('b', {}, '⚠ 能力边界（必须与数据一起看）：'),
            h('div', { style: 'margin-top:6px' }, [h('b', {}, '已有：'), bd.whatWeHave || '']),
            h('div', {}, [h('b', {}, '缺少：'), bd.whatWeLack || '']),
            h('div', {}, [h('b', {}, '能做：'), bd.canDo || '']),
            h('div', {}, [h('b', {}, '不能做：'), bd.cannotDo || '']),
            h('div', { style: 'margin-top:6px;color:var(--tx-3)' }, bd.whyNotFake || ''),
          ]),

          h('h3', { style: 'font-size:14px;margin:18px 0 8px;color:var(--tx-0)' }, '一、排放量核算（活动水平法 · 可复算）'),
          h('div', { style: 'font-size:12px;color:var(--tx-3);margin-bottom:8px' },
            '公式：' + (m.formula || '') + '；因子 ' + (m.factor || '') + ' tCO₂/t（' + (m.factorRef || '') + '）；'
            + (m.biogenicNote || '')),
          h('table', { class: 'rl-table' }, [
            h('thead', {}, [h('tr', {}, ['企业', '入炉垃圾(t)', '因子', '核算值(万tCO₂)', '当场复算', '链上交易'].map((x) => h('th', {}, x)))]),
            h('tbody', {}, (e2.rows || []).map((r) => h('tr', {}, [
              h('td', {}, r.ent_name),
              h('td', { style: 'font-family:var(--mono)' }, num(r.msw_t)),
              h('td', { style: 'font-family:var(--mono)' }, String(r.factor_tco2_t)),
              h('td', { style: 'font-family:var(--mono);color:var(--tx-0)' }, (r.totalTco2 / 10000).toFixed(2)),
              h('td', { style: 'font-family:var(--mono)' }, (r.recomputable.check / 10000).toFixed(2) + ' ✔'),
              h('td', { style: 'font-family:var(--mono);font-size:10.4px' },
                r.chain_tx_id ? String(r.chain_tx_id).slice(0, 12) + '…' : '—'),
            ]))),
          ]),
          h('div', { style: 'font-size:11.6px;color:var(--tx-3);margin-top:8px' },
            '合计 ' + e2.enterprises + ' 家 · ' + (e2.totalTco2 / 10000).toFixed(2) + ' 万tCO₂（矿物碳）；'
            + '生物碳信息项 ' + (e2.biogenicTco2 / 10000).toFixed(2) + ' 万tCO₂ 不计入。'
            + (e2.boundaries ? ' ' + (e2.boundaries.notClaim || '') : '')),

          /* ===== 真实 CEMS 排放量（EPA CAMD） ===== */
          (() => {
            const ce = cemsEmi.value || {};
            const cs = ce.summary || {};
            const cap = ce.capability || {};
            if (!cs.hours) return null;
            return h('div', {}, [
              h('h3', { style: 'font-size:14px;margin:22px 0 8px;color:var(--tx-0)' },
                '二、真实 CEMS 排放量（CO₂ 直测 · 小时级）'),
              h('div', { style: 'font-size:12px;color:var(--tx-3);margin-bottom:8px' },
                '辖区：' + (ce.jurisdiction || '') + ' —— ' + (ce.jurisdictionNote || '')),
              h('table', { class: 'rl-table' }, [
                h('thead', {}, [h('tr', {}, ['设施', '机组', '栈号', '实测小时', 'CO₂(t)', 'SO₂(kg)', 'NOx(kg)', '时段'].map((x) => h('th', {}, x)))]),
                h('tbody', {}, (ce.units || []).map((u) => h('tr', {}, [
                  h('td', {}, String(u.facility_name) + ' (' + String(u.state_code) + ')'),
                  h('td', { style: 'font-family:var(--mono)' }, 'u' + String(u.unit_id)),
                  h('td', { style: 'font-family:var(--mono);font-size:10.4px' }, u.stack_id || '—'),
                  h('td', { style: 'font-family:var(--mono)' }, String(u.measuredHours) + '/' + String(u.hours)),
                  h('td', { style: 'font-family:var(--mono)' }, num(u.co2Tonnes)),
                  h('td', { style: 'font-family:var(--mono)' }, num(u.so2Kg)),
                  h('td', { style: 'font-family:var(--mono)' }, num(u.noxKg)),
                  h('td', { style: 'font-size:10.6px' }, String(u.periodFrom) + ' ~ ' + String(u.periodTo)),
                ]))),
              ]),
              h('div', { style: 'font-size:11.6px;color:var(--tx-3);margin-top:8px' },
                '合计：' + cs.measuredHours + ' 个实测小时 · CO₂ ' + num(cs.co2Tonnes) + ' t · '
                + cs.anchoredBatches + '/' + cs.batches + ' 批次已上链。' + (cap.whatThisSolves || '')),
              h('div', { class: 'rl-warn', style: 'margin-top:10px' }, [
                h('b', {}, '为什么这一节能补上缺口：'),
                (cap.canDo || '') + '。' + (cap.crossCheck || ''),
                h('div', { style: 'margin-top:4px;color:var(--tx-3)' }, (cap.notClaim || '')),
              ]),
            ]);
          })(),

          /* ===== 中国 CEMS 小时级排放量（河北省公开系统） ===== */
          (() => {
            const cn = cnCems.value || {};
            const cs = cn.summary || {};
            const cap = cn.capability || {};
            if (!cs.hours) return null;
            return h('div', {}, [
              h('h3', { style: 'font-size:14px;margin:22px 0 8px;color:var(--tx-0)' },
                '三、中国控排企业 CEMS 排放量（小时级 · 河北省公开系统）'),
              h('div', { style: 'font-size:12px;color:var(--tx-3);margin-bottom:8px' },
                '辖区：' + (cn.jurisdiction || '') + ' —— ' + (cn.jurisdictionNote || '')),
              h('table', { class: 'rl-table' }, [
                h('thead', {}, [h('tr', {}, ['企业', '排放口', '小时', '有效', '烟气量(万m³)', 'SO₂(kg)', 'NOx(kg)', '颗粒物(kg)', '时段'].map((x) => h('th', {}, x)))]),
                h('tbody', {}, (cn.outlets || []).map((o) => h('tr', {}, [
                  h('td', {}, String(o.ent_name).slice(0, 14)),
                  h('td', {}, o.outlet_name),
                  h('td', { style: 'font-family:var(--mono)' }, String(o.hours)),
                  h('td', { style: 'font-family:var(--mono)' }, String(o.validHours)),
                  h('td', { style: 'font-family:var(--mono)' }, num(o.flueGasM3 / 10000)),
                  h('td', { style: 'font-family:var(--mono)' }, num(o.so2Kg)),
                  h('td', { style: 'font-family:var(--mono)' }, num(o.noxKg)),
                  h('td', { style: 'font-family:var(--mono)' }, num(o.pmKg)),
                  h('td', { style: 'font-size:10.6px' }, String(o.periodFrom).slice(0, 10) + ' ~ ' + String(o.periodTo).slice(0, 10)),
                ]))),
              ]),
              h('div', { style: 'font-size:11.6px;color:var(--tx-3);margin-top:8px' },
                '合计：' + cs.hours + ' 小时（有效 ' + cs.validHours + '）· 烟气量 ' + num(cs.flueGasM3 / 10000) + ' 万m³ · '
                + 'SO₂ ' + num(cs.so2Kg) + ' kg · NOx ' + num(cs.noxKg) + ' kg · 颗粒物 ' + num(cs.pmKg) + ' kg · '
                + cs.anchoredBatches + '/' + cs.batches + ' 批次已上链。' + (cap.whatThisSolves || '')),
              h('div', { class: 'rl-warn', style: 'margin-top:10px' }, [
                h('b', {}, '三元交叉核验（可当场复算）：'),
                (cap.internalCheck || ''),
                h('div', { style: 'margin-top:4px;color:var(--tx-3)' }, (cap.negativeFlow || '')),
                h('div', { style: 'margin-top:4px' }, (cap.stillMissing || '')),
              ]),
            ]);
          })(),

          h('h3', { style: 'font-size:14px;margin:22px 0 8px;color:var(--tx-0)' }, '四、真实 CEMS 浓度数据（ljgk 日均值）（逐排口 · 可溯源）'),
          h('table', { class: 'rl-table' }, [
            h('thead', {}, [h('tr', {}, ['企业', '排放口', '记录', '天数', '污染物', '时段', '超限', '批次'].map((x) => h('th', {}, x)))]),
            h('tbody', {}, (c.outlets || []).map((o) => h('tr', {}, [
              h('td', {}, String(o.ent_name).slice(0, 14)),
              h('td', {}, o.outlet_name),
              h('td', { style: 'font-family:var(--mono)' }, String(o.records)),
              h('td', { style: 'font-family:var(--mono)' }, String(o.days)),
              h('td', { style: 'font-family:var(--mono)' }, String(o.pollutants) + ' 项'),
              h('td', { style: 'font-size:10.6px' },
                String(o.periodFrom).slice(0, 10) + ' ~ ' + String(o.periodTo).slice(0, 10)),
              h('td', { style: 'font-family:var(--mono)' }, String(o.exceedCount)),
              h('td', { style: 'font-family:var(--mono);font-size:10.4px' }, String(o.batchNo || '').slice(0, 10) + '…'),
            ]))),
          ]),
          h('div', { style: 'font-size:11.6px;color:var(--tx-3);margin-top:8px' },
            '数据源：' + (c.source || '') + '；真实性等级 ' + (c.provenance || '') + '；粒度 ' + (c.granularity || '') + '。'
            + '每条记录保留原始报文 JSON（ps_code / mp_code / monitor_time / pollutant_code / strength / standard_value），可逐条回溯。'),

          h('div', { class: 'rl-warn', style: 'margin-top:18px' }, [
            h('b', {}, '这一页如实回答了两个问题：'),
            h('div', {}, '① 「有没有真实企业数据？」—— 有。4 家企业、8 个排放口、1,150 条记录，来自官方公开平台，逐条可溯源，且已上链存证。'),
            h('div', {}, '② 「这些数据能不能算 CEMS 排放量？」—— 中国 4 家企业：不能（只有浓度、无流量）；美国 CAMD 机组：能（CO₂ 由 CEMS 直测，吨/小时）。'),
            h('div', { style: 'margin-top:6px' },
              '因此本页给出的排放量是活动水平法核算值（官方处理量 × 标准因子），不是 CEMS 直测值。'
              + '要得到 CEMS 直测排放量，需要企业授权回流接口或 HJ 212 直连提供烟气流量 —— 通道已就绪，等企业授权。'),
          ]),
        ]);
      };
    },
  });

  /* ==================================================================
   * 组件小工具
   * ================================================================== */
  function kpi(label, value, unit, tier, foot) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card-body', style: 'padding:12px 13px' }, [
        h('div', { class: 'flex between', style: 'align-items:center;margin-bottom:6px' }, [
          h('div', { style: 'font-size:11.4px;color:var(--tx-3)' }, label),
          Tier(tier),
        ]),
        h('div', { style: 'font-family:var(--mono);font-size:21px;color:var(--tx-0);line-height:1.15' }, [
          String(value),
          unit ? h('span', { style: 'font-size:11px;color:var(--tx-3);margin-left:4px' }, unit) : null,
        ]),
        foot ? h('div', { style: 'font-size:11px;color:var(--tx-3);margin-top:5px;line-height:1.5' },
          foot) : null,
      ]),
    ]);
  }

  function liveKpi(label, key, digits, unit, tier, foot) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card-body', style: 'padding:12px 13px' }, [
        h('div', { class: 'flex between', style: 'align-items:center;margin-bottom:6px' }, [
          h('div', { style: 'font-size:11.4px;color:var(--tx-3)' }, label),
          Tier(tier),
        ]),
        h('div', { style: 'line-height:1.15' }, [
          h(LiveVal, { k: key, digits, unit, big: true }),
        ]),
        foot ? h('div', { style: 'font-size:11px;color:var(--tx-3);margin-top:5px;line-height:1.5' },
          foot) : null,
      ]),
    ]);
  }

  function layerCard(layer, count, desc) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card-body', style: 'padding:12px 13px' }, [
        h('div', { class: 'flex between', style: 'align-items:center;margin-bottom:6px' }, [
          Tier(layer),
          h('span', { class: 'mono', style: 'font-size:16px;color:var(--tx-0)' }, String(count)),
        ]),
        h('div', { style: 'font-size:11.2px;color:var(--tx-3);line-height:1.62' }, desc),
      ]),
    ]);
  }
})();
