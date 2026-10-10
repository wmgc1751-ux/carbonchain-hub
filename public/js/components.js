/* =====================================================================
   碳链通 CarbonChain Hub —— 全局组件库
   x-icon / x-card / x-kpi / x-tag / x-hash / x-chainbadge /
   x-table / x-pager / x-modal / x-chart / x-page / x-empty / x-toasts
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, h, ref, computed, nextTick, onMounted, watch } = Vue;

  /* ------------------------------------------------------------------
   * 图标（内联 SVG path）
   * ------------------------------------------------------------------ */
  const ICONS = {
    chain: 'M9.5 14.5 14.5 9.5M7 17a4 4 0 0 1 0-5.66l2.34-2.34a4 4 0 0 1 5.66 0M17 7a4 4 0 0 1 0 5.66l-2.34 2.34a4 4 0 0 1-5.66 0',
    dash: 'M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z',
    report: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M9 13h6M9 17h6',
    verify: 'm9 11 3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    coin: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    trade: 'm7 17 10-10M7 7h10v10M3 7h4M17 17h4',
    alert: 'M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z',
    users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    chart: 'M3 3v18h18M7 16v-5M12 16V8M17 16v-9',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
    plus: 'M12 5v14M5 12h14',
    close: 'M18 6 6 18M6 6l12 12',
    copy: 'M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2Zm-4 6H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
    check: 'm20 6-11 11-5-5',
    x: 'M18 6 6 18M6 6l12 12',
    refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    arrowUp: 'M12 19V5M5 12l7-7 7 7',
    arrowDown: 'M12 5v14M19 12l-7 7-7-7',
    arrowRight: 'M5 12h14M12 5l7 7-7 7',
    link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    lock: 'M5 11h14v11H5V11Zm3 0V7a4 4 0 0 1 8 0v4',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0 0c2.5-2.7 4-6.2 4-10s-1.5-7.3-4-10M12 2c-2.5 2.7-4 6.2-4 10s1.5 7.3 4 10M2 12h20',
    bank: 'M3 21h18M3 10h18L12 3 3 10Zm3 0v11M18 11v10M9 21v-6h6v6',
    factory: 'M2 20h20M4 20V9l5 3V9l5 3V9l5 3v8M8 20v-4h4v4',
    leaf: 'M11 20A7 7 0 0 1 4 13c0-5 4-9 9-10 1 5-1 10-5 13M2 22c4-6 8-9 13-10',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-16v6l4 2',
    block: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5',
    wallet: 'M3 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14h.01M11 12h1v5h1',
    key: 'M15.5 7.5a4.5 4.5 0 1 0-4.47 4.5L6 17v3h3l1-1v-2h2v-2h2l1.03-1.03A4.5 4.5 0 0 0 15.5 7.5Z',
    filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3Z',
    layers: 'm12 2 10 5-10 5L2 7l10-5Zm10 12-10 5-10-5M22 17l-10 5-10-5',
    fire: 'M12 22c4 0 7-2.7 7-6.7 0-3.6-3-5.3-3-8.3 0-1.4.6-2.6 1.4-3.4C15.6 3.6 14 3 13 3c0 3-2 4-3.5 6C8 10.8 5 11.6 5 15.3 5 19.3 8 22 12 22Z',
    target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-4a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0-4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    db: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3Zm9-3v14c0 1.66-4.03 3-9 3s-9-1.34-9-3V5m18 7c0 1.66-4.03 3-9 3s-9-1.34-9-3',
    play: 'm6 3 14 9-14 9V3Z',
    pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  };

  const XIcon = defineComponent({
    name: 'x-icon',
    props: { name: { type: String, required: true }, size: { type: [Number, String], default: 16 } },
    setup(props) {
      return () => h('svg', {
        viewBox: '0 0 24 24', width: props.size, height: props.size,
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        style: 'display:block',
      }, [h('path', { d: ICONS[props.name] || ICONS.info })]);
    },
  });

  /* ------------------------------------------------------------------
   * x-card
   * ------------------------------------------------------------------ */
  const XCard = defineComponent({
    name: 'x-card',
    props: { title: String, sub: String, flush: Boolean, tight: Boolean },
    setup(props, { slots }) {
      return () => h('div', { class: 'card' }, [
        (props.title || slots.actions || slots.head) && h('div', { class: 'card-head' }, [
          slots.head ? slots.head() : h('div', { class: 'flex-1' }, [
            h('h3', {}, props.title),
            props.sub && h('div', { class: 'sub' }, props.sub),
          ]),
          slots.actions && h('div', { class: 'acts' }, slots.actions()),
        ]),
        h('div', { class: ['card-body', props.flush && 'flush', props.tight && 'tight'] }, slots.default && slots.default()),
      ]);
    },
  });

  /* ------------------------------------------------------------------
   * x-kpi
   * ------------------------------------------------------------------ */
  const XKpi = defineComponent({
    name: 'x-kpi',
    props: {
      label: String, value: [String, Number], unit: String, icon: String,
      tone: { type: String, default: 'carbon' }, foot: String,
      delta: [String, Number], deltaTone: String,
    },
    setup(props, { slots }) {
      return () => h('div', { class: ['card', 'kpi', 'k-' + props.tone] }, [
        h('div', { class: 'glow' }),
        h('div', { class: 'flex between' }, [
          h('div', { class: 'lbl' }, props.label),
          props.icon && h('div', { class: 'ico', style: 'color:var(--tx-2)' }, [h(XIcon, { name: props.icon, size: 16 })]),
        ]),
        h('div', { class: 'val' }, [
          props.value === null || props.value === undefined ? '-' : props.value,
          props.unit && h('span', { class: 'unit' }, props.unit),
        ]),
        (props.foot || props.delta !== undefined || slots.default) && h('div', { class: 'foot' }, [
          props.delta !== undefined && props.delta !== null && h('span', {
            class: ['delta', props.deltaTone || (Number(props.delta) >= 0 ? 'bad' : 'good')],
          }, [
            h(XIcon, { name: Number(props.delta) >= 0 ? 'arrowUp' : 'arrowDown', size: 13 }),
            Math.abs(Number(props.delta)).toFixed(2) + '%',
          ]),
          props.foot && h('span', {}, props.foot),
          slots.default && slots.default(),
        ]),
      ]);
    },
  });

  /* ------------------------------------------------------------------
   * x-tag
   * ------------------------------------------------------------------ */
  const XTag = defineComponent({
    name: 'x-tag',
    props: {
      text: String, tone: { type: String, default: 't-mute' },
      dict: Object, dictKey: [String, Number], plain: Boolean,
    },
    setup(props) {
      return () => {
        let label = props.text, cls = props.tone;
        if (props.dict) { const d = App.dict(props.dict, props.dictKey); label = d.label; cls = d.cls; }
        return h('span', { class: ['tag', cls, props.plain && 'plain'] }, label);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-hash —— 可点击复制的哈希
   * ------------------------------------------------------------------ */
  const XHash = defineComponent({
    name: 'x-hash',
    props: { value: String, len: { type: Number, default: 12 } },
    setup(props) {
      return () => h('span', {
        class: 'hash', title: props.value || '',
        onClick: (e) => { e.stopPropagation(); App.copyText(props.value || ''); },
      }, App.fmt.short(props.value, props.len));
    },
  });

  /* ------------------------------------------------------------------
   * x-chainbadge —— 链上存证标识
   * ------------------------------------------------------------------ */
  const XChainBadge = defineComponent({
    name: 'x-chainbadge',
    props: { block: [Number, String], hash: String, label: String },
    setup(props) {
      return () => {
        if (props.block === null || props.block === undefined || props.block === '') {
          return h('span', { class: 'tag t-mute', style: 'font-size:11.4px' }, '未上链');
        }
        return h('span', {
          class: 'chainbadge', title: (props.label || '已上链存证') + (props.hash ? ' · ' + props.hash : ''),
          onClick: (e) => { e.stopPropagation(); if (props.hash) App.copyText(props.hash); },
        }, [
          h(XIcon, { name: 'block', size: 12 }),
          '#' + props.block,
          h('span', { class: 'lock-ok', title: '链上公钥已核验 · 点击复制哈希' }, [h(XIcon, { name: 'lock', size: 11 })]),
        ]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-table —— 数据表格，支持具名插槽 col-<key>
   * ------------------------------------------------------------------ */
  const XTable = defineComponent({
    name: 'x-table',
    props: {
      columns: { type: Array, required: true },
      rows: { type: Array, default: () => [] },
      loading: Boolean, empty: { type: String, default: '暂无数据' },
      rowClick: Function, rowKey: { type: String, default: 'id' },
      selectedKey: [String, Number],
    },
    setup(props, { slots }) {
      return () => {
        if (props.loading && !props.rows.length) {
          return h('div', { class: 'card-body' }, Array.from({ length: 6 }).map((_, i) =>
            h('div', { class: 'skel', style: 'height:34px;margin-bottom:8px' })));
        }
        if (!props.rows.length) {
          return h('div', { class: 'empty' }, [
            h('div', { class: 'empty-mark' }, [h(XIcon, { name: 'shield', size: 34 })]),
            h('div', { class: 'empty-title' }, props.empty),
            h('div', { class: 'empty-sub' }, '数据经联盟链存证，链路状态正常'),
          ]);
        }
        const head = h('thead', {}, [h('tr', {}, props.columns.map((c) =>
          h('th', { class: c.align === 'right' ? 'num' : '', style: c.width ? `width:${c.width}` : '' }, c.title)))]);

        const body = h('tbody', {}, props.rows.map((row, ri) => h('tr', {
          class: ['', props.rowClick && 'clickable', String(props.selectedKey) === String(row[props.rowKey]) && 'sel'],
          onClick: props.rowClick ? () => props.rowClick(row, ri) : undefined,
        }, props.columns.map((c) => {
          const slot = slots['col-' + c.key];
          const val = row[c.key];
          return h('td', { class: c.align === 'right' ? 'num' : '' },
            slot ? slot({ row, value: val, index: ri }) : (val === null || val === undefined || val === '' ? h('span', { class: 'dim' }, '-') : String(val)));
        }))));

        return h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [head, body])]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-pager
   * ------------------------------------------------------------------ */
  const XPager = defineComponent({
    name: 'x-pager',
    props: {
      page: { type: Number, default: 1 }, pages: { type: Number, default: 1 },
      total: { type: Number, default: 0 }, size: { type: Number, default: 10 },
    },
    emits: ['change'],
    setup(props, { emit }) {
      return () => {
        const list = [];
        const cur = props.page;
        const max = props.pages || 1;
        let s = Math.max(1, cur - 2);
        let e = Math.min(max, s + 4);
        s = Math.max(1, e - 4);
        for (let i = s; i <= e; i++) list.push(i);
        return h('div', { class: 'pager' }, [
          h('div', { class: 'info' }, `共 ${App.fmt.num(props.total)} 条 · 第 ${cur}/${max} 页`),
          h('button', { class: 'pg-btn', disabled: cur <= 1, onClick: () => emit('change', cur - 1) }, '上一页'),
          ...list.map((p) => h('button', {
            class: ['pg-btn', p === cur && 'on'], onClick: () => emit('change', p),
          }, String(p))),
          h('button', { class: 'pg-btn', disabled: cur >= max, onClick: () => emit('change', cur + 1) }, '下一页'),
        ]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-chart
   * ------------------------------------------------------------------ */
  const XChart = defineComponent({
    name: 'x-chart',
    props: { option: Object, height: { type: String, default: 'h300' }, loading: Boolean },
    setup(props) {
      const el = ref(null);
      let inst = null;
      let ro = null;

      function draw() {
        if (!el.value || !props.option) return;
        if (!inst || inst.isDisposed()) inst = echarts.init(el.value, null, { renderer: 'canvas' });
        inst.setOption(props.option, true);
      }

      onMounted(() => {
        nextTick(draw);
        if (window.ResizeObserver) {
          ro = new ResizeObserver(() => inst && inst.resize());
          nextTick(() => el.value && ro.observe(el.value));
        }
      });
      watch(() => props.option, () => nextTick(draw), { deep: true });

      return () => h('div', {
        ref: el,
        class: ['chart', props.height],
        style: props.loading ? 'opacity:.35;transition:opacity .2s' : 'transition:opacity .2s',
      });
    },
  });

  /* ------------------------------------------------------------------
   * x-page —— 页面标题区
   * ------------------------------------------------------------------ */
  const XPage = defineComponent({
    name: 'x-page',
    props: { title: String, desc: String },
    setup(props, { slots }) {
      return () => h('div', {}, [
        h('div', { class: 'page-head' }, [
          h('div', {}, [h('h2', {}, props.title), props.desc && h('div', { class: 'desc' }, props.desc)]),
          slots.actions && h('div', { class: 'acts' }, slots.actions()),
        ]),
        slots.default && slots.default(),
      ]);
    },
  });

  /* ------------------------------------------------------------------
   * x-modal
   * ------------------------------------------------------------------ */
  const XModal = defineComponent({
    name: 'x-modal',
    props: { modelValue: Boolean, title: String, width: { type: String, default: '620px' } },
    emits: ['update:modelValue'],
    setup(props, { slots, emit }) {
      return () => {
        if (!props.modelValue) return null;
        return h('div', { class: 'mask', onClick: () => emit('update:modelValue', false) }, [
          h('div', {
            class: 'modal', style: `max-width:${props.width}`, onClick: (e) => e.stopPropagation(),
          }, [
            h('div', { class: 'modal-head' }, [
              h('h3', {}, props.title),
              h('button', { class: 'x', onClick: () => emit('update:modelValue', false) }, [h(XIcon, { name: 'close', size: 16 })]),
            ]),
            h('div', { class: 'modal-body' }, slots.default && slots.default()),
            slots.footer && h('div', { class: 'modal-foot' }, slots.footer()),
          ]),
        ]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-bars —— 横向条形排名
   * ------------------------------------------------------------------ */
  const XBars = defineComponent({
    name: 'x-bars',
    props: { items: { type: Array, default: () => [] }, max: Number, tone: { type: String, default: '' }, valueKey: { type: String, default: 'value' }, labelKey: { type: String, default: 'name' }, format: Function },
    setup(props) {
      return () => {
        const max = props.max || Math.max(...props.items.map((i) => Number(i[props.valueKey]) || 0), 1);
        return h('div', {}, props.items.map((it) => {
          const v = Number(it[props.valueKey]) || 0;
          return h('div', { class: 'bar-row' }, [
            h('div', { class: 'nm', title: it[props.labelKey] }, it[props.labelKey]),
            h('div', { class: 'bar-track' }, [h('div', { class: ['bar-fill', props.tone], style: `width:${Math.max(2, (v / max) * 100)}%` })]),
            h('div', { class: 'vv' }, props.format ? props.format(v, it) : App.fmt.big(v)),
          ]);
        }));
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-toasts
   * ------------------------------------------------------------------ */
  const XToasts = defineComponent({
    name: 'x-toasts',
    setup() {
      return () => h('div', { class: 'toasts' }, App.Store.toasts.map((t) =>
        h('div', { class: ['toast', t.type] }, [
          h(XIcon, { name: t.type === 'ok' ? 'check' : t.type === 'err' ? 'x' : t.type === 'warn' ? 'alert' : 'info', size: 17 }),
          h('div', { class: 'flex-1' }, t.message),
        ])));
    },
  });

  /* ------------------------------------------------------------------
   * x-readout —— 校验结论条
   * ------------------------------------------------------------------ */
  const XReadout = defineComponent({
    name: 'x-readout',
    props: { pass: Boolean, label: String, detail: String },
    setup(props) {
      return () => h('div', { class: ['readout', props.pass ? 'pass' : 'fail'] }, [
        h('span', { class: 'flag' }, props.pass ? 'PASS' : 'FAIL'),
        h('span', { class: 'k' }, props.label),
        props.detail && h('span', { class: 'mono', style: 'margin-left:auto;color:var(--tx-3)' }, props.detail),
      ]);
    },
  });

  /* 注册 */
  const comps = {
    'x-icon': XIcon, 'x-card': XCard, 'x-kpi': XKpi, 'x-tag': XTag,
    'x-hash': XHash, 'x-chainbadge': XChainBadge, 'x-table': XTable, 'x-pager': XPager,
    'x-chart': XChart, 'x-page': XPage, 'x-modal': XModal, 'x-bars': XBars,
    'x-toasts': XToasts, 'x-readout': XReadout,
  };
  App.components = comps;
})();
