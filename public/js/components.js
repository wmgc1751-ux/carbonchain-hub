/* =====================================================================
   碳链通 CarbonChain Hub —— 全局组件库
   x-icon / x-card / x-kpi / x-tag / x-hash / x-chainbadge /
   x-table / x-pager / x-modal / x-chart / x-page / x-empty / x-toasts
   ---------------------------------------------------------------------
   2026-10-25 升级：新增 x-skeleton / x-drawer；增强 x-table（批量+CSV）、
   x-pager（跳页+每页条数）、x-modal（ESC+锁滚+焦点圈定）、x-empty（重试）。
   增强项的 props 全部默认关闭 —— 旧调用点的渲染结果不变。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, h, ref, computed, nextTick, onMounted, onUnmounted, watch } = Vue;

  /* 组件库内不经过 App.h（避免加载期 App 尚未就绪），
     x-* 标签只在本文件末尾统一注册，跨文件引用统一走 App.h。 */

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
    /* AI 顾问图标（四角星 + 中心点）—— 本轮新增 */
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
    key: 'M15.5 7.5a4.5 4.5 0 1 0-4.47 4.5L6 17v3h3l1-1v-2h2v-2h2l1.03-1.03A4.5 4.5 0 0 0 15.5 7.5Z',
    filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3Z',
    layers: 'm12 2 10 5-10 5L2 7l10-5Zm10 12-10 5-10-5M22 17l-10 5-10-5',
    fire: 'M12 22c4 0 7-2.7 7-6.7 0-3.6-3-5.3-3-8.3 0-1.4.6-2.6 1.4-3.4C15.6 3.6 14 3 13 3c0 3-2 4-3.5 6C8 10.8 5 11.6 5 15.3 5 19.3 8 22 12 22Z',
    target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-4a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0-4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    db: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3Zm9-3v14c0 1.66-4.03 3-9 3s-9-1.34-9-3V5m18 7c0 1.66-4.03 3-9 3s-9-1.34-9-3',
    play: 'm6 3 14 9-14 9V3Z',
    pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
    /* 【新增增强】2026-10-25：外壳与交互补充图标 */
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    command: 'M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0 3-3Z',
    panelLeft: 'M3 3h18v18H3zM9 3v18',
    menu: 'M3 6h18M3 12h18M3 18h18',
    chevronLeft: 'M15 18l-6-6 6-6',
    chevronRight: 'M9 18l6-6-6-6',
    cornerDownLeft: 'M9 10 4 15l5 5M20 4v7a4 4 0 0 1-4 4H4',
    table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18',
    expand: 'M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3',
    /* 【新增增强】2026-10-25 设置入口用 */
    gear: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
    /* 【登录页 2026-10-29】口令明文切换与演示身份下拉所需 */
    eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22',
    chevronDown: 'm6 9 6 6 6-6',
  };

  /* ------------------------------------------------------------------
   * 【新增增强】图标尺寸刻度（2026-10-25）
   * ------------------------------------------------------------------
   * 升级前全站图标尺寸有 10/11/12/13/14/15/16/17/19/20/21/22/30/34/60 共 15 种，
   * 其中 19 / 21 只出现 5 次 —— 不是设计选择，是"随手写的"。
   * 同屏出现 17 与 19 两种图标时，视觉上会有一点点"没对齐"的微妙不适，
   * 但谁也说不清哪里不对，最后变成整个界面显得不精致。
   *
   * 做法：把尺寸吸附到刻度上，而不是去改 600 多处调用点。
   *   · 已经在刻度上的（99% 的情况）原样返回，零变化；
   *   · 10px 以下的细节装饰不吸附（那是刻意的微调）；
   *   · 只有 19 / 21 这类"手抖值"会被拉到最近的刻度，最大偏移 1px。
   * 这样既统一了刻度，又不产生一次"大面积改样式"的回归风险。
   * ------------------------------------------------------------------ */
  const ICON_SCALE = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 26, 30, 34, 60];

  function snapIconSize(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 16;
    if (n < 10) return n;
    if (ICON_SCALE.indexOf(n) > -1) return n;
    let best = ICON_SCALE[0];
    let dist = Infinity;
    for (let i = 0; i < ICON_SCALE.length; i++) {
      const d = Math.abs(ICON_SCALE[i] - n);
      if (d < dist) { dist = d; best = ICON_SCALE[i]; }
    }
    return best;
  }

  const XIcon = defineComponent({
    name: 'x-icon',
    props: { name: { type: String, required: true }, size: { type: [Number, String], default: 16 } },
    setup(props) {
      return () => h('svg', {
        viewBox: '0 0 24 24', width: snapIconSize(props.size), height: snapIconSize(props.size),
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        style: 'display:block',
      }, [h('path', { d: ICONS[props.name] || ICONS.info })]);
    },
  });

  /* ------------------------------------------------------------------
   * x-skeleton —— 统一骨架屏（【新增增强】）
   * ------------------------------------------------------------------
   * 各页原本各写各的：有的 `加载中…` 文字，有的 6 个 div.skel。
   * 同一件事三种样子，切页时观感最刺眼。这里统一成三型。
   * ------------------------------------------------------------------ */
  const XSkeleton = defineComponent({
    name: 'x-skeleton',
    props: {
      type: { type: String, default: 'line' },   // line | table | card | kpi
      rows: { type: Number, default: 5 },
      height: { type: [Number, String], default: 0 },
    },
    setup(props) {
      return () => {
        const n = Math.max(1, props.rows);
        if (props.type === 'table') {
          return h('div', { class: 'skel-table' }, Array.from({ length: n }).map(() =>
            h('div', { class: 'skel-row' }, [
              h('i', { class: 'skel', style: 'width:22%' }),
              h('i', { class: 'skel', style: 'width:38%' }),
              h('i', { class: 'skel', style: 'width:18%' }),
              h('i', { class: 'skel', style: 'width:12%' }),
            ])));
        }
        if (props.type === 'card') {
          return h('div', { class: 'grid g3' }, Array.from({ length: n }).map(() =>
            h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [
              h('i', { class: 'skel', style: 'width:42%;height:12px;display:block;margin-bottom:12px' }),
              h('i', { class: 'skel', style: 'width:64%;height:24px;display:block' }),
            ])])));
        }
        if (props.type === 'kpi') {
          return h('div', { class: 'grid g4' }, Array.from({ length: n }).map(() =>
            h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [
              h('i', { class: 'skel', style: 'width:38%;height:11px;display:block;margin-bottom:14px' }),
              h('i', { class: 'skel', style: 'width:58%;height:26px;display:block' }),
            ])])));
        }
        const style = props.height ? `height:${typeof props.height === 'number' ? props.height + 'px' : props.height}` : '';
        return h('div', {}, Array.from({ length: n }).map(() =>
          h('i', { class: 'skel', style: 'display:block;margin-bottom:9px;' + style })));
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-empty —— 统一空态
   * ------------------------------------------------------------------
   * 三种语气，不要混用：
   *   safe  绿色盾牌 + 雷达扫描 —— "检查过了，一切正常"（零超标 / 零风险）
   *   data  中性灰           —— "这里确实还没有数据"（未上报 / 未生成）
   *   error 玫红              —— "取数失败，可重试"
   * inline=true 走轻量行内样式，用于表格单元格 / 图表占位，不抢版面。
   * 【新增增强】retry / hint 属性：把"为什么失败 + 点这里重试"放进空态里。
   * ------------------------------------------------------------------ */
  const XEmpty = defineComponent({
    name: 'x-empty',
    props: {
      title: { type: String, default: '暂无数据' },
      sub: String,
      icon: { type: String, default: 'db' },
      tone: { type: String, default: 'data' },
      inline: Boolean,
      /* 下列为新增，默认不传 = 与升级前表现完全一致 */
      retry: Boolean,
      retryText: { type: String, default: '重新加载' },
      hint: Object,     // App.errHint() 的返回值 { title, reason, action }
    },
    emits: ['retry'],
    setup(props, { emit }) {
      return () => {
        if (props.inline) return h('div', { class: 'empty-inline' }, props.title);

        const h2 = props.hint;
        const sub = props.sub || (h2 ? h2.reason : (props.tone === 'safe' ? '数据经联盟链存证，链路状态正常' : ''));

        return h('div', { class: ['empty', 'empty-tone-' + props.tone] }, [
          h('div', { class: 'empty-mark' }, [h(XIcon, { name: props.icon, size: 34 })]),
          h('div', { class: 'empty-title' }, props.title),
          sub && h('div', { class: 'empty-sub' }, sub),
          h2 && h2.action && h('div', { class: 'empty-action-tip' }, [
            h(XIcon, { name: 'info', size: 13 }),
            h('span', {}, h2.action),
          ]),
          props.retry
            ? h('div', { class: 'empty-acts' }, [
              h('button', { class: 'btn sm', onClick: () => emit('retry') }, [
                h(XIcon, { name: 'refresh', size: 14 }), props.retryText,
              ]),
            ])
            : null,
        ]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-card
   * ------------------------------------------------------------------ */
  const XCard = defineComponent({
    name: 'x-card',
    /* 【新增增强】loading：为 true 时用骨架屏占位正文（可选，默认 false） */
    props: { title: String, sub: String, flush: Boolean, tight: Boolean, loading: Boolean, loadingRows: { type: Number, default: 4 } },
    setup(props, { slots }) {
      return () => h('div', { class: 'card' }, [
        (props.title || slots.actions || slots.head) && h('div', { class: 'card-head' }, [
          slots.head ? slots.head() : h('div', { class: 'flex-1' }, [
            h('h3', {}, props.title),
            props.sub && h('div', { class: 'sub' }, props.sub),
          ]),
          slots.actions && h('div', { class: 'acts' }, slots.actions()),
        ]),
        h('div', { class: ['card-body', props.flush && 'flush', props.tight && 'tight'] },
          props.loading
            ? [h(XSkeleton, { rows: props.loadingRows })]
            : (slots.default && slots.default())),
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
          props.icon && h('div', { class: 'ico' }, [h(XIcon, { name: props.icon, size: 16 })]),
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
   * ------------------------------------------------------------------
   * 【原有逻辑保留】columns / rows / loading / empty / rowClick / rowKey /
   *   selectedKey / slots['col-*'] 的行为一字未改。
   * 【新增增强】selectable / selected / exportName / exportScope：
   *   不传这些 props 时，返回的根节点仍是 .tbl-wrap —— DOM 结构与升级前
   *   逐字一致（页面传入的 class/style 落点不变）；只有启用增强项时才额外
   *   包一层 .tbl-box 承载工具条与批量条。
   * ------------------------------------------------------------------ */
  const XTable = defineComponent({
    name: 'x-table',
    props: {
      columns: { type: Array, required: true },
      rows: { type: Array, default: () => [] },
      loading: Boolean, empty: { type: String, default: '暂无数据' },
      rowClick: Function, rowKey: { type: String, default: 'id' },
      selectedKey: [String, Number],
      /* ---- 以下为增强项 ----
       * 【新增增强】2026-10-25：selectable / exportName 的默认值从 false / undefined
       * 改为 null，语义变成"没表态 = 交给自动判定"：
       *   null      → 自动：flag(table.batch) 开 + 行数≥3 + 主键唯一时启用
       *   true      → 强制启用（即便只有 1 行）
       *   false     → 强制关闭（单页退出批量，其余页不受影响）
       * ⚠ 必须是 null 而不是 false：false 与"用户显式关闭"无法区分，
       *   一旦设成 false 就再也自动不了，74 处调用点就都得逐个改。
       */
      selectable: { type: Boolean, default: null },
      /* ⚠ 默认必须是 undefined 而不是 []：
       * 数组默认值会在父组件每次重渲染时重新生成一个新引用，
       * watch 会把它当"外部改动了选择"，于是用户刚勾的行被清空。 */
      selected: { type: Array, default: undefined },
      /* 【新增增强】exportName 传 null 时自动由当前路由推导（/a/b → a-b） */
      exportName: { type: String, default: null },
      exportScope: { type: String, default: 'page' },  // page（当前页） | selected（已选）
      toolbar: Boolean,                                 // 是否显示工具条容器（供 slots.tools）
      hintText: String,                                 // 工具条左侧说明（如筛选条件）
    },
    emits: ['update:selected', 'export'],
    setup(props, { slots, emit }) {
      /** 只有在调用方真的传入 selectedKey 时才判定行选中；
       *  否则 undefined === undefined 会把整张表都标成选中（历史缺陷）。 */
      const hasSel = () => props.selectedKey !== undefined && props.selectedKey !== null && props.selectedKey !== '';
      const isSelected = (row) => hasSel() && String(props.selectedKey) === String(row[props.rowKey]);

      /* 批量选择：优先跟随受控 props，未受控时用内部状态 */
      const inner = ref(Array.isArray(props.selected) ? props.selected.slice() : []);
      watch(() => props.selected, (v) => {
        if (Array.isArray(v) && v !== inner.value) inner.value = v.slice();
      });

      /* ------------------------------------------------------------------
       * 【新增增强】主键列自动识别
       * ----------------------------------------------------------------
       * 为什么不能直接信任 props.rowKey 的默认值 'id'：
       * 全站 74 处表里，区块表用 block_index、交易表用 tx_id、批次表用 batch_no…
       * 这些行**没有 id 字段**。此时 String(row['id']) === "undefined"，
       * 而 "undefined" 是"真值"，于是：
       *   ① 每一行的 key 都相同 → 勾第 1 行等于勾了全页；
       *   ② 导出的"已选"集合与用户看到的完全不符。
       * 这是静默错误，界面不报错、数据全错，所以必须在上线前挡住。
       * 判定方式：候选列必须在**当前页全部行**上取值非空且两两不重复，
       * 才认为它是主键。找不到就返回 rowKey 原值并让 batchReady 判 false。
       * ------------------------------------------------------------------ */
      const AUTO_KEY_CANDIDATES = [
        'id', 'key', 'code', 'no', 'txHash', 'tx_id', 'hash',
        'block', 'block_index', 'address', 'batchNo', 'batch_no', 'creditId',
      ];

      const resolvedKey = computed(() => {
        const explicit = props.rowKey;
        /* 调用方显式指定了非默认主键 → 严格尊重，不做猜测 */
        if (explicit && explicit !== 'id') return explicit;
        const rows = props.rows || [];
        if (!rows.length) return explicit || 'id';

        const uniqueIn = (k) => {
          const vals = rows.map((r) => (r === null || r === undefined ? '' : String(r[k])));
          if (vals.some((v) => !v || v === 'undefined' || v === 'null')) return false;
          return new Set(vals).size === vals.length;
        };

        for (let i = 0; i < AUTO_KEY_CANDIDATES.length; i++) {
          if (uniqueIn(AUTO_KEY_CANDIDATES[i])) return AUTO_KEY_CANDIDATES[i];
        }

        /* 兜底：业务表的主键常常是领域字段（energyCn / version / batch_no…），
         * 不叫 id。此时退化为"依次试每一列，谁唯一谁就是主键"。
         * 表格第一列是标识列的概率极高，所以从第一列往右扫，命中即止。
         * ⚠ 仍然要求"全页唯一"，因此不会出现"两行同 key ⇒ 勾一行等于勾全部"。 */
        const cols = props.columns || [];
        for (let i = 0; i < cols.length; i++) {
          const k = cols[i] && cols[i].key;
          if (k && uniqueIn(k)) return k;
        }

        return explicit || 'id';
      });

      const keyOf = (row) => (row === null || row === undefined ? '' : String(row[resolvedKey.value]));
      const isChecked = (row) => inner.value.indexOf(keyOf(row)) > -1;

      /* ------------------------------------------------------------------
       * 【新增增强】自动装配的开关判据
       * ----------------------------------------------------------------
       * 三条守卫缺一不可，目的都是"不确定就不启用"：
       *   ① flag table.batch 打开（可在 URL 用 ?flags=table.batch:0 一键关掉）
       *   ② 行数 ≥ 3 —— 1~2 行的汇总表加复选列纯属噪音
       *   ③ 主键唯一且非空 —— 否则勾选与导出都会串行
       * 行数不足或主键不唯一时**连 DOM 都不变**（不出现 .tbl-box 包裹层），
       * 所以小表的既有样式与结构完全不受这次升级影响。
       * ------------------------------------------------------------------ */
      const flagOn = (name, dflt) => (App.flag ? !!App.flag(name) : dflt);

      const batchReady = computed(() => {
        const rows = props.rows || [];
        if (rows.length < 3) return false;
        const k = resolvedKey.value;
        const vals = rows.map((r) => (r === null || r === undefined ? '' : String(r[k])));
        return vals.every((v) => !!v && v !== 'undefined' && v !== 'null')
          && new Set(vals).size === vals.length;
      });

      const useSel = computed(() => {
        if (props.selectable !== null && props.selectable !== undefined) return props.selectable === true;
        return batchReady.value && flagOn('table.batch', true);
      });

      /** 自动导出名：优先用调用方的 exportName，其次由当前路由推导
       *  ⚠ 导出**不受"≥3 行"守卫限制**，只有批量勾选受限：
       *    导出只需要列定义，1 行的表也该能导出（例如"因子版本历史"常年 1 行）；
       *    而批量勾选在 1~2 行的表上纯属噪音。这是两个不同的门槛，不能共用一个判据。 */
      const effectiveExportName = computed(() => {
        if (props.exportName) return props.exportName;
        if (!flagOn('table.batch', true)) return null;
        if (!(props.rows || []).length) return null;
        const p = (App.Router && App.Router.path) || 'export';
        const slug = String(p).replace(/^\/+/, '').replace(/[\/?#&=]+/g, '-').replace(/[^\w\u4e00-\u9fa5-]/g, '');
        return slug || 'export';
      });

      function setSel(next) {
        inner.value = next;
        emit('update:selected', next);
      }

      function toggleRow(row, e) {
        if (e) e.stopPropagation();
        const k = keyOf(row);
        if (!k) return;
        setSel(inner.value.indexOf(k) > -1
          ? inner.value.filter((x) => x !== k)
          : inner.value.concat([k]));
      }

      const pageKeys = computed(() => (props.rows || []).map(keyOf).filter(Boolean));
      const checkedOnPage = computed(() => pageKeys.value.filter((k) => inner.value.indexOf(k) > -1).length);
      const allChecked = computed(() => pageKeys.value.length > 0 && checkedOnPage.value === pageKeys.value.length);
      const partChecked = computed(() => checkedOnPage.value > 0 && !allChecked.value);

      function toggleAll() {
        const all = pageKeys.value;
        if (allChecked.value) {
          const drop = {};
          all.forEach((k) => { drop[k] = 1; });
          setSel(inner.value.filter((k) => !drop[k]));
        } else {
          const set = {};
          inner.value.concat(all).forEach((k) => { set[k] = 1; });
          setSel(Object.keys(set));
        }
      }

      function doExport() {
        if (!App.ux || !App.ux.downloadCSV) { App.notify.err('导出组件未加载'); return; }
        const target = props.exportScope === 'selected'
          ? (props.rows || []).filter(isChecked)
          : (props.rows || []);
        if (!target.length) {
          App.notify.warn(props.exportScope === 'selected' ? '请先勾选要导出的行' : '当前没有可导出的数据');
          return;
        }
        /* 只导出"有 key 或有 export 函数"的列；纯操作列（渲染按钮）自动排除 */
        App.ux.downloadCSV(effectiveExportName.value || 'export', props.columns, target);
        App.notify.ok(`已导出 ${target.length} 行`);
        emit('export', target);
      }

      /** 表头全选框：半选态必须用 DOM 属性设置，checked 表达不了 */
      function bindIndeterminate(vnode) {
        if (vnode && vnode.el) vnode.el.indeterminate = partChecked.value;
      }

      function renderTools() {
        const showExport = !!effectiveExportName.value || props.exportScope === 'selected';
        if (!props.toolbar && !showExport && !slots.tools) return null;
        /* 【新增增强】只有"自动装配出来的导出按钮"（页面没给 tools / hint）时
         * 走 compact 版：不占整条工具条高度、不加分隔线、右对齐贴边，
         * 避免 74 张表每张头顶都多出一条空荡荡的横条。 */
        const onlyExport = !props.toolbar && !slots.tools && !props.hintText;
        return h('div', { class: ['tbl-tools', onlyExport && 'compact'] }, [
          h('div', { class: 'tbl-tools-l' }, [
            slots.tools ? slots.tools() : null,
            props.hintText ? h('span', { class: 'tbl-hint' }, props.hintText) : null,
          ]),
          h('div', { class: 'tbl-tools-r' }, [
            showExport ? h('button', {
              class: ['btn', 'sm', 'ghost', onlyExport && 'icon'],
              title: '按当前列为 CSV 导出（Excel 可直接打开）',
              onClick: doExport,
            }, onlyExport
              ? [h(XIcon, { name: 'download', size: 14 })]
              : [h(XIcon, { name: 'download', size: 14 }), '导出 CSV']) : null,
          ]),
        ]);
      }

      function renderBulk() {
        if (!useSel.value || !inner.value.length) return null;
        /* 【新增增强】把选中结果传给插槽：批量动作的入参是"选了哪些行"，
         * 让页面自己去 store 里维护一份选中集合会与表格内部状态打架。 */
        const picked = (props.rows || []).filter(isChecked);
        return h('div', { class: 'bulk-bar' }, [
          h('span', { class: 'bulk-n' }, [h('b', {}, String(inner.value.length)), ' 项已选']),
          h('span', { class: 'bulk-sep' }),
          slots.bulk ? slots.bulk({ keys: inner.value, rows: picked }) : null,
          h('button', { class: 'btn sm ghost', onClick: () => setSel([]) }, '清空选择'),
        ]);
      }

      return () => {
        if (props.loading && !props.rows.length) {
          return h('div', { class: 'card-body' }, [h(XSkeleton, { type: 'table', rows: 6 })]);
        }
        if (!props.rows.length) {
          return h(XEmpty, { title: props.empty, sub: '数据经联盟链存证，链路状态正常', icon: 'shield', tone: 'safe' });
        }

        const colCount = props.columns.length + (useSel.value ? 1 : 0);

        const head = h('thead', {}, [h('tr', {}, [
          /* 复选列固定在首列，不参与 columns 定义 —— 页面无需改列配置 */
          useSel.value ? h('th', { class: 'th-sel', style: 'width:40px' }, [
            h('input', {
              type: 'checkbox', class: 'cb', checked: allChecked.value,
              'aria-label': '全选本页',
              onChange: toggleAll,
              onVnodeMounted: bindIndeterminate,
              onVnodeUpdated: bindIndeterminate,
            }),
          ]) : null,
          ...props.columns.map((c) =>
            h('th', { class: c.align === 'right' ? 'num' : '', style: c.width ? `width:${c.width}` : '' }, c.title)),
        ])]);

        const body = h('tbody', {}, props.rows.map((row, ri) => h('tr', {
          class: ['', props.rowClick && 'clickable', isSelected(row) && 'sel', isChecked(row) && 'checked'],
          onClick: props.rowClick ? () => props.rowClick(row, ri) : undefined,
        }, [
          useSel.value ? h('td', { class: 'td-sel' }, [
            h('input', {
              type: 'checkbox', class: 'cb', checked: isChecked(row),
              'aria-label': '选择该行',
              onChange: (e) => { e.stopPropagation(); toggleRow(row); },
              onClick: (e) => e.stopPropagation(),
            }),
          ]) : null,
          ...props.columns.map((c) => {
            const slot = slots['col-' + c.key];
            const val = row[c.key];
            return h('td', { class: c.align === 'right' ? 'num' : '' },
              slot ? slot({ row, value: val, index: ri }) : (val === null || val === undefined || val === '' ? h('span', { class: 'dim' }, '-') : String(val)));
          }),
        ])));

        if (!colCount) return null;

        const wrap = h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [head, body])]);
        const tools = renderTools();
        const bulk = renderBulk();

        /* 【原有逻辑保留】没有启用任何增强项时，返回的根节点仍是 .tbl-wrap，
         * DOM 结构与升级前逐字一致 —— 页面给 x-table 传的 class / style
         * 落点不变（例如 explorer 的 .tbl-blocks / .tbl-txs 依赖这一点）。 */
        if (!tools && !bulk) return wrap;

        return h('div', { class: 'tbl-box' }, [tools, bulk, wrap]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-pager
   * ------------------------------------------------------------------
   * 【原有逻辑保留】props page/pages/total/size + emit('change', page)。
   * 【新增增强】sizes（每页条数候选）+ emit('size-change') + 页码直达输入。
   *   不传 sizes 时，条数选择器不渲染 —— 旧调用点界面不变。
   * ------------------------------------------------------------------ */
  const XPager = defineComponent({
    name: 'x-pager',
    props: {
      page: { type: Number, default: 1 }, pages: { type: Number, default: 1 },
      total: { type: Number, default: 0 }, size: { type: Number, default: 10 },
      /* 增强项（默认关闭） */
      sizes: { type: Array, default: () => [] },
      jump: Boolean,            // 页码直达输入
      disabled: Boolean,
    },
    emits: ['change', 'size-change'],
    setup(props, { emit }) {
      const jumpVal = ref('');
      return () => {
        const list = [];
        const cur = props.page;
        const max = props.pages || 1;
        /* 空数据不渲染分页器：0 条时的"共 0 条 · 第 1/1 页"是纯噪音（2026-10-29） */
        if (!props.total) return null;
        let s = Math.max(1, cur - 2);
        let e = Math.min(max, s + 4);
        s = Math.max(1, e - 4);
        for (let i = s; i <= e; i++) list.push(i);

        function goPage(p) {
          if (props.disabled) return;
          const np = Math.min(Math.max(1, Number(p) || 1), max);
          if (np === cur) return;
          emit('change', np);
        }

        return h('div', { class: 'pager' }, [
          h('div', { class: 'info' }, `共 ${App.fmt.num(props.total)} 条 · 第 ${cur}/${max} 页`),

          /* 每页条数：只在调用方给出候选时出现 */
          props.sizes.length
            ? h('select', {
              class: 'pg-size',
              title: '每页显示条数',
              value: String(props.size),
              onChange: (ev) => emit('size-change', Number(ev.target.value)),
            }, props.sizes.map((z) => h('option', { value: String(z) }, `${z} 条/页`)))
            : null,

          h('button', { class: 'pg-btn', disabled: cur <= 1, onClick: () => goPage(cur - 1) }, '上一页'),
          ...list.map((p) => h('button', {
            class: ['pg-btn', p === cur && 'on'], onClick: () => goPage(p),
          }, String(p))),
          h('button', { class: 'pg-btn', disabled: cur >= max, onClick: () => goPage(cur + 1) }, '下一页'),

          /* 页码直达：5 万条台账只能一页页点，实操上是不可用的 */
          props.jump
            ? h('label', { class: 'pg-jump', title: '输入页码后回车直达' }, [
              h('span', {}, '跳至'),
              h('input', {
                class: 'pg-input', type: 'number', min: 1, max,
                value: jumpVal.value,
                placeholder: String(cur),
                onInput: (ev) => { jumpVal.value = ev.target.value; },
                onKeydown: (ev) => {
                  if (ev.key === 'Enter') { goPage(jumpVal.value); jumpVal.value = ''; }
                },
              }),
              h('span', {}, '页'),
            ])
            : null,
        ]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-chart
   * ------------------------------------------------------------------ */
  const XChart = defineComponent({
    name: 'x-chart',
    props: { option: Object, height: { type: String, default: 'h300' }, loading: Boolean, emptySub: { type: String, default: '数据生成后此处将展示图表' } },
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
          ro = new ResizeObserver(() => { if (inst && !inst.isDisposed()) inst.resize(); });
          nextTick(() => el.value && ro.observe(el.value));
        }
      });
      /* 【优化重构】原来图表实例从不 dispose，反复进出页面会留下 canvas 与
       * ResizeObserver 引用。XChart 是全站图表入口，泄漏量随使用时长线性增长。 */
      onUnmounted(() => {
        if (ro) { ro.disconnect(); ro = null; }
        if (inst) { inst.dispose(); inst = null; }
      });
      watch(() => props.option, (v) => {
        nextTick(draw);
        /* option 被置空（数据清空）时清掉旧图，避免残留上一份数据的画面 */
        if (!v && inst && !inst.isDisposed()) inst.clear();
      }, { deep: true });

      /* 空数据占位（2026-10-29）：option 为 null 时不再渲染空的定高画布——
       * 此前空数据图表表现为灰色空心环 / 空轴，用户会以为图表坏了。
       * 直接引用 XEmpty 组件对象，不经过字符串名解析 */
      return () => (props.option == null
        ? h('div', { class: ['chart', props.height, 'chart-empty'] }, [
          h(XEmpty, { title: '暂无数据', sub: props.emptySub, icon: 'chart' }),
        ])
        : h('div', {
          ref: el,
          class: ['chart', props.height],
          style: props.loading ? 'opacity:.35;transition:opacity .2s' : 'transition:opacity .2s',
        }));
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
   * x-modal —— ESC 关闭 / 背景锁滚 / 焦点圈定（【新增增强】）
   * ------------------------------------------------------------------
   * 三个原本缺失的行为，都在"用户已经打开弹窗"之后才体现，因此容易被忽略：
   *   ① ESC 关不掉 —— 键盘用户唯一能用的关闭方式是 Tab 到 × 再回车；
   *   ② 背景还在滚 —— 滚轮滚动的是底下那张长表格，弹窗内容不动；
   *   ③ 焦点逃逸 —— Tab 会从弹窗一路跑到背景的侧边栏，屏幕阅读器读错上下文。
   * 嵌套弹窗（存证核验 → 详情）用栈管理：ESC 只关最上面那层，
   * 背景锁用计数，关掉上层不会把下层也解锁。
   * ------------------------------------------------------------------ */
  const modalStack = [];
  let modalUid = 0;

  const XModal = defineComponent({
    name: 'x-modal',
    props: {
      modelValue: Boolean, title: String, width: { type: String, default: '620px' },
      maskClosable: { type: Boolean, default: true },
      escClosable: { type: Boolean, default: true },
    },
    emits: ['update:modelValue'],
    setup(props, { slots, emit }) {
      const myId = ++modalUid;
      const box = ref(null);
      let prevFocus = null;
      let locked = false;
      let attached = false;

      function close() { emit('update:modelValue', false); }

      function onKey(e) {
        if (!attached) return;
        const isTop = modalStack[modalStack.length - 1] === myId;
        if (e.key === 'Escape') {
          if (!isTop || !props.escClosable) return;
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
        /* 焦点圈定：Tab 到底部后回到第一个可聚焦元素 */
        if (e.key === 'Tab' && isTop && box.value) {
          const f = box.value.querySelectorAll(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
          if (!f.length) return;
          const first = f[0];
          const last = f[f.length - 1];
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        }
      }

      function activate() {
        if (attached) return;
        attached = true;
        prevFocus = document.activeElement;
        modalStack.push(myId);
        if (App.ux && App.ux.lockScroll) { App.ux.lockScroll(); locked = true; }
        document.addEventListener('keydown', onKey, true);
        nextTick(() => { if (box.value) { box.value.setAttribute('tabindex', '-1'); box.value.focus(); } });
      }

      function deactivate() {
        if (!attached) return;
        attached = false;
        const i = modalStack.indexOf(myId);
        if (i > -1) modalStack.splice(i, 1);
        if (locked && App.ux && App.ux.unlockScroll) { App.ux.unlockScroll(); locked = false; }
        document.removeEventListener('keydown', onKey, true);
        /* 焦点归还：关闭后光标回到"打开它的那个按钮"，否则会掉到 body 上，
         * 键盘用户得从头 Tab 一遍才能回到原位置。 */
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* 元素可能已卸载 */ }
        prevFocus = null;
      }

      watch(() => props.modelValue, (v) => { if (v) activate(); else deactivate(); });

      onMounted(() => { if (props.modelValue) activate(); });
      onUnmounted(deactivate);

      return () => {
        if (!props.modelValue) return null;
        return h('div', {
          class: 'mask', onClick: props.maskClosable ? close : undefined,
        }, [
          h('div', {
            ref: box,
            class: 'modal', role: 'dialog', 'aria-modal': 'true',
            style: `max-width:${props.width}`, onClick: (e) => e.stopPropagation(),
          }, [
            h('div', { class: 'modal-head' }, [
              h('h3', {}, props.title),
              h('button', { class: 'x', 'aria-label': '关闭', onClick: close }, [h(XIcon, { name: 'close', size: 16 })]),
            ]),
            h('div', { class: 'modal-body' }, slots.default && slots.default()),
            slots.footer && h('div', { class: 'modal-foot' }, slots.footer()),
          ]),
        ]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-drawer —— 右侧抽屉（【新增增强】）
   * ------------------------------------------------------------------
   * 用于"看详情但不值得整页跳转"的场景（存证核验、批次明细）。
   * 交互与 x-modal 一致：ESC / 锁滚 / 焦点圈定 / 遮罩关闭。
   * ------------------------------------------------------------------ */
  const XDrawer = defineComponent({
    name: 'x-drawer',
    props: {
      modelValue: Boolean, title: String, sub: String,
      width: { type: String, default: '520px' },
      maskClosable: { type: Boolean, default: true },
    },
    emits: ['update:modelValue'],
    setup(props, { slots, emit }) {
      const myId = ++modalUid;
      const box = ref(null);
      let prevFocus = null;
      let locked = false;
      let attached = false;

      function close() { emit('update:modelValue', false); }

      function onKey(e) {
        if (!attached) return;
        if (modalStack[modalStack.length - 1] !== myId) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        if (e.key === 'Tab' && box.value) {
          const f = box.value.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
          if (!f.length) return;
          const first = f[0], last = f[f.length - 1];
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        }
      }

      function activate() {
        if (attached) return;
        attached = true;
        prevFocus = document.activeElement;
        modalStack.push(myId);
        if (App.ux && App.ux.lockScroll) { App.ux.lockScroll(); locked = true; }
        document.addEventListener('keydown', onKey, true);
        nextTick(() => { if (box.value) { box.value.setAttribute('tabindex', '-1'); box.value.focus(); } });
      }

      function deactivate() {
        if (!attached) return;
        attached = false;
        const i = modalStack.indexOf(myId);
        if (i > -1) modalStack.splice(i, 1);
        if (locked && App.ux && App.ux.unlockScroll) { App.ux.unlockScroll(); locked = false; }
        document.removeEventListener('keydown', onKey, true);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* 忽略 */ }
        prevFocus = null;
      }

      watch(() => props.modelValue, (v) => { if (v) activate(); else deactivate(); });
      onMounted(() => { if (props.modelValue) activate(); });
      onUnmounted(deactivate);

      return () => {
        if (!props.modelValue) return null;
        return h('div', {
          class: 'drawer-mask', onClick: props.maskClosable ? close : undefined,
        }, [
          h('aside', {
            ref: box, class: 'drawer', role: 'dialog', 'aria-modal': 'true',
            style: `width:${props.width}`, onClick: (e) => e.stopPropagation(),
          }, [
            h('div', { class: 'drawer-head' }, [
              h('div', {}, [
                h('h3', {}, props.title),
                props.sub && h('div', { class: 'sub' }, props.sub),
              ]),
              h('button', { class: 'x', 'aria-label': '关闭', onClick: close }, [h(XIcon, { name: 'close', size: 16 })]),
            ]),
            h('div', { class: 'drawer-body' }, slots.default && slots.default()),
            slots.footer && h('div', { class: 'drawer-foot' }, slots.footer()),
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
   * ------------------------------------------------------------------
   * 【新增增强】支持提示内操作按钮（如"重试"）。没有 action 时渲染不变。
   * ------------------------------------------------------------------ */
  const XToasts = defineComponent({
    name: 'x-toasts',
    setup() {
      return () => h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }, App.Store.toasts.map((t) => {
        function run() {
          App.closeToast(t.id);
          try { if (t.action && t.action.run) t.action.run(); } catch (e) { App.notify.err(e.message); }
        }
        return h('div', { class: ['toast', t.type] }, [
          h('span', { class: 'ico' }, [h(XIcon, { name: t.type === 'ok' ? 'check' : t.type === 'err' ? 'x' : t.type === 'warn' ? 'alert' : 'info', size: 17 })]),
          h('div', { class: 'flex-1' }, t.message),
          t.action ? h('button', { class: 'toast-act', onClick: run }, t.action.label || '处理') : null,
          h('button', { class: 'toast-x', 'aria-label': '关闭提示', onClick: () => App.closeToast(t.id) }, '×'),
        ]);
      }));
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

  /* ------------------------------------------------------------------
   * x-error —— 统一错误态（【新增增强】2026-10-25）
   * ------------------------------------------------------------------
   * 升级前各页的错误处理是 "catch(e){ App.notify.err(e.message) }"：
   *   · 报错只说"哪里坏了"，不说"现在能做什么"；
   *   · 提示 3 秒后自动消失，用户还没来得及看清就没了；
   *   · 想重试只能刷新整页，丢掉所有已填内容。
   * 这里把三件事一次给全：摘要 + 可执行建议 + 就地重试。
   * hint 优先用调用方传入的，否则交给 App.errHint 按 HTTP 状态分层。
   * ------------------------------------------------------------------ */
  const XErrorState = defineComponent({
    name: 'x-error',
    props: {
      error: [String, Object], hint: [String, Object],
      title: String, detail: String, compact: Boolean,
      retry: Function, retryText: { type: String, default: '重试' },
    },
    setup(props) {
      return () => {
        const raw = props.error;
        const msg = props.title
          || (typeof raw === 'string' ? raw : (raw && raw.message))
          || '操作没有完成';
        let hintText = props.hint || '';
        if (!hintText && App.errHint) {
          try { hintText = App.errHint(raw) || ''; } catch (e) { hintText = ''; }
        }
        return h('div', { class: ['err-state', props.compact && 'compact'], role: 'alert' }, [
          h('div', { class: 'err-ico' }, [h(XIcon, { name: 'alert', size: props.compact ? 18 : 26 })]),
          h('div', { class: 'err-body' }, [
            h('div', { class: 'err-title' }, msg),
            hintText ? h('div', { class: 'err-hint' }, hintText) : null,
            props.detail ? h('details', { class: 'err-detail' }, [
              h('summary', {}, '技术细节'),
              h('pre', {}, String(props.detail)),
            ]) : null,
          ]),
          props.retry ? h('button', { class: 'btn sm ghost err-retry', onClick: props.retry }, [
            h(XIcon, { name: 'refresh', size: 14 }), props.retryText,
          ]) : null,
        ]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * x-filter-bar —— 通用筛选条（【新增增强】2026-10-25）
   * ------------------------------------------------------------------
   * 状态完全由页面的 App.ux.useFilter(...) 托管，本组件只负责渲染。
   * 这样"筛选逻辑"与"筛选外观"解耦：页面不必为了统一外观而改数据结构。
   * ------------------------------------------------------------------ */
  const XFilterBar = defineComponent({
    name: 'x-filter-bar',
    props: {
      state: { type: Object, required: true },
      placeholder: { type: String, default: '搜索关键词…' },
      showDate: Boolean,
      unit: { type: String, default: '条' },
    },
    setup(props) {
      return () => {
        const s = props.state;
        if (!s) return null;
        const opts = s.statusOptions || [];
        return h('div', { class: 'filter-bar' }, [
          h('div', { class: 'fb-row' }, [
            h('label', { class: 'fb-search' }, [
              h(XIcon, { name: 'search', size: 15 }),
              h('input', {
                type: 'text', value: s.kw.value, placeholder: props.placeholder,
                'aria-label': props.placeholder,
                onInput: (e) => { s.kw.value = e.target.value; },
              }),
              s.kw.value ? h('button', {
                class: 'fb-x', type: 'button', 'aria-label': '清空关键词',
                onClick: () => { s.kw.value = ''; },
              }, [h(XIcon, { name: 'close', size: 13 })]) : null,
            ]),
            props.showDate && s.dateKey ? h('div', { class: 'fb-date' }, [
              h(XIcon, { name: 'clock', size: 14 }),
              h('input', {
                type: 'date', value: s.from.value, 'aria-label': '起始日期',
                onInput: (e) => { s.from.value = e.target.value; },
              }),
              h('span', { class: 'dim' }, '→'),
              h('input', {
                type: 'date', value: s.to.value, 'aria-label': '截止日期',
                onInput: (e) => { s.to.value = e.target.value; },
              }),
            ]) : null,
            opts.length ? h('div', { class: 'fb-chips' }, opts.map((o) => h('button', {
              type: 'button',
              class: ['fb-chip', s.picked.value.indexOf(String(o.value)) > -1 && 'on'],
              onClick: () => s.toggleStatus(o.value),
            }, o.label))) : null,
            h('span', { class: 'fb-count dim' }, `${s.shown.value} / ${s.total.value} ${props.unit}`),
            s.active.value ? h('button', { class: 'btn sm ghost', onClick: s.clearAll }, '清空筛选') : null,
          ]),
          s.tags.value.length ? h('div', { class: 'fb-tags' }, s.tags.value.map((t) => h('span', { class: 'fb-tag', key: t.key }, [
            t.label,
            h('button', { class: 'x', type: 'button', 'aria-label': '移除该条件', onClick: t.clear }, [h(XIcon, { name: 'close', size: 11 })]),
          ]))) : null,
        ]);
      };
    },
  });

  /* 注册 */
  const comps = {
    'x-icon': XIcon, 'x-empty': XEmpty, 'x-card': XCard, 'x-kpi': XKpi, 'x-tag': XTag,
    'x-hash': XHash, 'x-chainbadge': XChainBadge, 'x-table': XTable, 'x-pager': XPager,
    'x-chart': XChart, 'x-page': XPage, 'x-modal': XModal, 'x-bars': XBars,
    'x-toasts': XToasts, 'x-readout': XReadout,
    /* 【新增增强】2026-10-25 */
    'x-skeleton': XSkeleton, 'x-drawer': XDrawer,
    'x-error': XErrorState, 'x-filter-bar': XFilterBar,
  };
  App.components = comps;
})();
