/* =====================================================================
   ops.js —— 生产运维监控中心（监控告警 / 结构化日志 / 灰度发布）
   ---------------------------------------------------------------------
   生产加固的运维入口，实时展示：
     · QPS / P50 / P95 / P99 / 错误率 / uptime（每 3 秒刷新）
     · 实时 QPS 折线图（ECharts，滚动窗口 40 点）
     · 告警事件流（每 5 秒拉取）
     · 结构化日志流（按级别过滤，每 4 秒拉取）
     · 灰度功能开关列表（可切换）
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  const STYLE_ID = 'ops-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
.ops-mono{font-family:var(--mono);font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-all}
.ops-log{max-height:320px;overflow-y:auto;font-family:var(--mono);font-size:11px;line-height:1.6}
.ops-log .lv-info{color:var(--tx-2)}
.ops-log .lv-warn{color:var(--warn)}
.ops-log .lv-error{color:var(--danger-tx,#fda4af)}
.ops-log .lv-debug{color:var(--tx-3)}
.ops-log .row{padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.ops-flag{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--hair);border-radius:8px;margin-bottom:8px}
.ops-flag.on{border-color:var(--brand);background:rgba(0,192,127,.06)}
`;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  const PageOps = defineComponent({
    name: 'page-ops',
    setup() {
      injectStyle();
      const stats = ref({ qps: 0, p50: 0, p95: 0, p99: 0, errorRate: 0, errorCount: 0, totalRequests: 0, uptime: 0, memoryMB: 0, samples: 0 });
      const alerts = ref([]);
      const logs = ref([]);
      const logLevel = ref('');
      const logQuery = ref('');
      const canaryStatus = ref(null);
      const qpsSeries = ref([]);  // 滚动窗口
      const QPS_CAP = 40;

      let statsTimer = null, alertTimer = null, logTimer = null, chartTimer = null;
      let chart = null, chartEl = null;

      /* 运维接口自 2026-10 起要求监管/管理角色，取数须携带令牌 */
      const authHeaders = () => {
        const t = localStorage.getItem('cch_token');
        return t ? { Authorization: 'Bearer ' + t } : {};
      };

      async function fetchStats() {
        try {
          const r = await fetch('/api/ops/stats', { headers: authHeaders() });
          const j = await r.json();
          if (j && j.data) {
            stats.value = j.data;
            qpsSeries.value.push({ t: new Date().toLocaleTimeString('zh-CN'), v: j.data.qps });
            if (qpsSeries.value.length > QPS_CAP) qpsSeries.value.shift();
            updateChart();
          }
        } catch (e) {}
      }
      async function fetchAlerts() {
        try {
          const r = await fetch('/api/ops/alerts', { headers: authHeaders() });
          const j = await r.json();
          if (j && j.data) alerts.value = j.data.alerts || [];
        } catch (e) {}
      }
      async function fetchLogs() {
        try {
          const p = new URLSearchParams({ limit: '50' });
          if (logLevel.value) p.set('level', logLevel.value);
          if (logQuery.value) p.set('q', logQuery.value);
          const r = await fetch('/api/ops/logs?' + p.toString(), { headers: authHeaders() });
          const j = await r.json();
          if (j && j.data) logs.value = j.data.entries || [];
        } catch (e) {}
      }
      async function fetchCanary() {
        try {
          const r = await fetch('/api/ops/canary', { headers: authHeaders() });
          const j = await r.json();
          if (j && j.data) canaryStatus.value = j.data;
        } catch (e) {}
      }

      async function toggleFlag(key, enabled) {
        try {
          const token = localStorage.getItem('cch_token');
          const r = await fetch('/api/ops/canary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: token ? 'Bearer ' + token : '' },
            body: JSON.stringify({ feature: key, enabled: !enabled }),
          });
          const j = await r.json();
          if (j && j.code === 0) { fetchCanary(); }
        } catch (e) {}
      }

      function initChart(el) {
        if (!el || typeof echarts === 'undefined') return;
        /* ⚠ 这个函数被当作「函数式 ref」传给 div，而 Vue 在**每次 patch** 都会
         * 重新调用它（不是只在挂载时调一次）。于是每 3 秒 stats 一更新就重新
         * init + setOption(空序列)，刚画上去的曲线立刻被空数组覆盖 ——
         * 页面表现为「实时 QPS 监控」整块空白，只剩一条 canvas 边缘竖线
         * （2026-10-29 巡检 P1-18）。
         * 同一个元素只初始化一次；并用已缓存的数据回填。 */
        if (chartEl === el && chart && !chart.isDisposed()) return;
        chartEl = el;
        chart = echarts.init(el);
        /* 画布跟随容器宽度（缺这个，窄屏图表会被裁掉右半） */
        if (initChart.ro) initChart.ro.disconnect();
        initChart.ro = new ResizeObserver(() => { if (chart && !chart.isDisposed()) chart.resize(); });
        initChart.ro.observe(el);
        chart.setOption({
          grid: { left: 50, right: 20, top: 20, bottom: 30 },
          xAxis: { type: 'category', data: [], axisLabel: { color: '#8a94a6', fontSize: 10 } },
          yAxis: { type: 'value', axisLabel: { color: '#8a94a6', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
          series: [{ name: 'QPS', type: 'line', smooth: true, symbol: 'none', data: [],
            lineStyle: { color: '#00c07f', width: 2 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [
              { offset: 0, color: 'rgba(0,192,127,.3)' }, { offset: 1, color: 'rgba(0,192,127,0)' }] } } }],
          tooltip: { trigger: 'axis' },
        });
        /* 初始化后立刻回填已有样本，避免"刚打开是空的，要等下一轮才有线" */
        updateChart();
      }
      function updateChart() {
        if (!chart) return;
        chart.setOption({
          xAxis: { data: qpsSeries.value.map((p) => p.t) },
          series: [{ data: qpsSeries.value.map((p) => p.v) }],
        });
      }

      onMounted(() => {
        fetchStats(); fetchAlerts(); fetchLogs(); fetchCanary();
        statsTimer = setInterval(fetchStats, 3000);
        alertTimer = setInterval(fetchAlerts, 5000);
        logTimer = setInterval(fetchLogs, 4000);
      });
      onUnmounted(() => {
        if (statsTimer) clearInterval(statsTimer);
        if (alertTimer) clearInterval(alertTimer);
        if (logTimer) clearInterval(logTimer);
        if (initChart.ro) { initChart.ro.disconnect(); initChart.ro = null; }
        if (chart) { chart.dispose(); chart = null; }
      });

      function kpis() {
        return h('div', { class: 'grid g4 mb-16' }, [
          h('x-kpi', { label: '实时 QPS', value: stats.value.qps, unit: 'req/s', tone: 'chain', icon: 'chart', foot: `总请求 ${stats.value.totalRequests}` }),
          h('x-kpi', { label: 'P95 延迟', value: stats.value.p95, unit: 'ms', tone: stats.value.p95 > 2000 ? 'rose' : 'carbon', icon: 'clock',
            foot: `P50 ${stats.value.p50} · P99 ${stats.value.p99}` }),
          h('x-kpi', { label: '错误率', value: stats.value.errorRate, unit: '%', tone: stats.value.errorRate > 5 ? 'rose' : 'sky', icon: 'warn',
            /* 错误数此前写死 0，与上方 errorRate 自相矛盾（0.16% × 10080 ≈ 16 条 ≠ 0）。 */
            foot: `错误 ${App.fmt.num(stats.value.errorCount || 0)} / ${App.fmt.num(stats.value.totalRequests)} 请求` }),
          h('x-kpi', { label: '进程运行', value: stats.value.uptime, unit: '秒', tone: 'violet', icon: 'block',
            foot: `内存 ${stats.value.memoryMB} MB · Node ${stats.value.nodeVersion || ''}` }),
        ]);
      }

      function monitorCard() {
        return h('x-card', { title: '实时 QPS 监控', sub: '每 3 秒采样 · Prometheus 兼容指标 /api/ops/metrics', flush: true }, {
          actions: () => h('a', { class: 'btn sm ghost', href: '/api/ops/metrics', target: '_blank' }, 'Prometheus 指标'),
          default: () => h('div', { style: 'padding:14px 16px' }, [
            h('div', { ref: initChart, style: 'width:100%;height:240px' }),
            h('div', { class: 'tiny dim mt-12', style: 'line-height:1.7' }, [
              '指标接口：GET /api/ops/metrics（Prometheus text format）· GET /api/ops/stats（JSON）· GET /api/ops/alerts（告警事件流）。'
              + '生产环境可由 Prometheus 抓取 /api/ops/metrics，Grafana 配置告警与可视化看板。'
              + '当前节点：' + (stats.value.nodeVersion || '—') + ' · 采样数 ' + stats.value.samples + '。',
            ]),
          ]),
        });
      }

      function alertCard() {
        return h('x-card', { title: '告警事件流', sub: '阈值规则：P95>2000ms WARN · P99>5000ms CRIT · 错误率>5% CRIT', flush: true }, {
          default: () => h('div', { style: 'padding:12px 16px;max-height:280px;overflow-y:auto' }, [
            alerts.value.length === 0 ? h('div', { class: 'empty' }, [
              h('div', { class: 'empty-mark' }, [h('x-icon', { name: 'check', size: 30 })]),
              h('div', { class: 'empty-title' }, '无告警 · 所有指标正常'),
            ]) : h('div', {}, alerts.value.map((a) => h('div', {
              class: ['ops-flag', a.severity === 'CRIT' ? '' : 'on'].filter(Boolean).join(' '),
              style: a.severity === 'CRIT' ? 'border-color:var(--danger);background:rgba(216,90,48,.06)' : '',
            }, [
              h('div', {}, [
                h('span', { class: ['tag', a.severity === 'CRIT' ? 'warn' : 'ok'] }, a.severity),
                h('span', { style: 'margin-left:8px;font-weight:500' }, a.message),
              ]),
              /* 告警时间此前直接输出 ISO 8601 原文（2026-10-29T14:22:05.137Z），与全站本地时间格式不一致。 */
              h('div', { class: 'tiny dim mono' }, `${App.fmt.dt(a.ts)} · 当前 ${a.value} > 阈值 ${a.threshold} · 规则 ${a.rule}`),
            ]))),
          ]),
        });
      }

      function logCard() {
        return h('x-card', { title: '结构化日志流', sub: 'JSON 格式 · 环形缓冲 1000 条 · 按 level/q 过滤', flush: true }, {
          actions: () => h('div', { class: 'flex gap-6' }, [
            h('select', {
              class: 'btn sm ghost',
              'aria-label': '日志级别筛选',
              value: logLevel.value,
              onChange: (e) => { logLevel.value = e.target.value; fetchLogs(); },
            }, [
              h('option', { value: '' }, '全部级别'),
              h('option', { value: 'info' }, 'INFO'),
              h('option', { value: 'warn' }, 'WARN'),
              h('option', { value: 'error' }, 'ERROR'),
            ]),
            h('input', {
              class: 'btn sm ghost',
              placeholder: '关键字过滤...',
              value: logQuery.value,
              onInput: (e) => { logQuery.value = e.target.value; },
              onChange: () => fetchLogs(),
              style: 'width:140px',
            }),
          ]),
          default: () => h('div', { class: 'ops-log', style: 'padding:10px 16px' },
            logs.value.length === 0 ? h('x-empty', { inline: true, title: '暂无日志' }) :
            logs.value.map((e) => h('div', { class: 'row lv-' + e.level }, [
              h('span', { class: 'mono', style: 'color:var(--tx-3)' }, e.ts.slice(11, 19) + ' '),
              h('span', { class: 'mono', style: 'margin-right:6px;font-weight:500' }, '[' + (e.level || 'info').toUpperCase() + ']'),
              /* 请求日志的 message 本身就是完整请求行（method path status ms），
               * 此前又把 meta 里的字段拼接一遍 → 每行内容重复两次。仅当
               * message 未包含 path（如告警/灰度等业务日志带 path 元数据）时才补拼。 */
              h('span', {}, e.message + (e.path && !String(e.message).includes(e.path)
                ? ' ' + e.method + ' ' + e.path + ' ' + e.status + ' ' + e.durationMs + 'ms' : '')),
            ]))),
        });
      }

      function canaryCard() {
        /* 灰度开关在服务端是「仅管理员可切换」（routes/ops.js: POST /canary 判 role!=='ADMIN' → 403）。
         * 原界面把可点开关渲染给了所有能进 /ops 的角色，监管端点一下就是 403 ——
         * 界面承诺了后端不允许的能力。这里改为按角色只读。 */
        const canToggle = (App.Store.user || {}).role === 'ADMIN';
        return h('x-card', {
          title: '灰度发布 · 功能开关',
          sub: canToggle ? '?canary=1 或 X-Canary: true header 路由到灰度逻辑'
            : '只读视图 · 灰度开关仅平台管理员可切换',
        }, {
          default: () => h('div', { style: 'padding:12px 16px' },
            canaryStatus.value && canaryStatus.value.features
              ? Object.entries(canaryStatus.value.features).map(([key, f]) => h('div', {
                  class: ['ops-flag', f.enabled ? 'on' : ''].join(' '),
                }, [
                  h('div', {}, [
                    h('div', { style: 'font-weight:500;font-size:13px' }, key),
                    h('div', { class: 'tiny dim' }, f.desc + ' · 上线 ' + f.since),
                  ]),
                  h('div', { class: 'flex gap-6', style: 'align-items:center' }, [
                    h('span', { class: ['tag', f.enabled ? 'ok' : ''] }, f.enabled ? '已开启' : '已关闭'),
                    canToggle
                      ? h('button', {
                          class: ['btn', 'xs', f.enabled ? 'ghost' : 'primary'],
                          onClick: () => toggleFlag(key, f.enabled),
                        }, f.enabled ? '关闭' : '开启')
                      : h('span', { class: 'tiny dim', title: '仅 ADMIN 可切换' }, '需管理员权限'),
                  ]),
                ]))
              : h('div', { class: 'tiny dim' }, '正在加载灰度状态…'),
          ),
        });
      }

      return () => h('x-page', {
        title: '生产运维监控中心',
        desc: '监控告警 / 结构化日志 / 灰度发布 · 生产加固基础设施',
      }, {
        default: () => h('div', { class: 'col gap-16' }, [
          kpis(),
          monitorCard(),
          h('div', { class: 'grid g-2-1' }, [alertCard(), logCard()]),
          canaryCard(),
        ]),
      });
    },
  });

  App.views['page-ops'] = PageOps;
})();
