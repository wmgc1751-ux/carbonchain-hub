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
    chain: { height: 0, totalBlocks: 0, totalTxs: 0, difficulty: 0, tipHash: '' },
    loading: false,
  });

  function setSession(token, user) {
    Store.token = token || '';
    Store.user = user || null;
    if (token) {
      localStorage.setItem('cch_token', token);
      localStorage.setItem('cch_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('cch_token');
      localStorage.removeItem('cch_user');
    }
  }

  /* ==================================================================
   * 二、API 客户端
   * ================================================================== */
  const API = {
    base: './api',

    async request(method, path, body, opts = {}) {
      const url = API.base + path;
      const headers = { 'Content-Type': 'application/json' };
      if (Store.token && !opts.noAuth) headers.Authorization = 'Bearer ' + Store.token;
      let res;
      try {
        res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        throw new Error('无法连接服务端，请确认后端已启动');
      }
      let json = null;
      try { json = await res.json(); } catch (e) { /* 非 JSON 响应 */ }

      if (res.status === 401 && !opts.noRedirect) {
        setSession('', null);
        location.hash = '#/login';
        throw new Error(json && json.message ? json.message : '登录已失效，请重新登录');
      }
      if (!json || json.code !== 0) {
        throw new Error((json && json.message) || `请求失败 (HTTP ${res.status})`);
      }
      return json.data;
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
    post(path, body) { return API.request('POST', path, body || {}); },
  };

  /* ==================================================================
   * 三、消息提示
   * ================================================================== */
  let toastSeq = 0;
  function toast(message, type = 'info', duration = 3200) {
    const id = ++toastSeq;
    Store.toasts.push({ id, message, type });
    setTimeout(() => {
      const i = Store.toasts.findIndex((t) => t.id === id);
      if (i > -1) Store.toasts.splice(i, 1);
    }, duration);
  }
  const notify = {
    ok: (m) => toast(m, 'ok'),
    err: (m) => toast(m, 'err', 4600),
    info: (m) => toast(m, 'info'),
    warn: (m) => toast(m, 'warn'),
  };

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

  window.addEventListener('hashchange', () => { resolve(); window.scrollTo({ top: 0 }); });

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
    orderSide: { BUY: ['买入', 't-danger'], SELL: ['卖出', 't-ok'] },
    orderStatus: {
      OPEN: ['挂单中', 't-info'], PARTIAL: ['部分成交', 't-violet'], FILLED: ['已成交', 't-ok'], CANCELLED: ['已撤单', 't-mute'],
    },
    conclusion: { PASS: ['通过', 't-ok'], CONDITIONAL: ['有条件通过', 't-warn'], FAIL: ['不通过', 't-danger'] },
    allocType: { FREE: ['免费分配', 't-ok'], AUCTION: ['有偿竞价', 't-info'], BUYBACK: ['政府回购', 't-violet'] },
    alertType: {
      OVER_QUOTA: ['配额超限', 't-danger'], DATA_ABNORMAL: ['数据异常', 't-warn'], MISSING_REPORT: ['漏报', 't-violet'],
      PRICE_ANOMALY: ['价格异动', 't-info'], CHAIN_RISK: ['链上风险', 't-chain'],
    },
    alertLevel: { HIGH: ['高', 't-danger'], MEDIUM: ['中', 't-warn'], LOW: ['低', 't-mute'] },
    alertStatus: { OPEN: ['待处理', 't-danger'], HANDLING: ['处理中', 't-warn'], CLOSED: ['已关闭', 't-ok'] },
    entStatus: { ACTIVE: ['正常', 't-ok'], WATCH: ['重点关注', 't-warn'], SUSPENDED: ['暂停交易', 't-danger'] },
    txType: {
      EMISSION_REPORT: ['排放上报存证', 't-ok'], VERIFY_REPORT: ['核查报告存证', 't-info'],
      QUOTA_ALLOC: ['配额分配存证', 't-violet'], TRADE_DEAL: ['交易成交存证', 't-chain'],
      ENTERPRISE_REG: ['企业备案存证', 't-mute'],
    },
    role: { ENTERPRISE: '企业端', VERIFIER: '核查机构端', REGULATOR: '监管端', ADMIN: '系统管理' },
    noticeType: { POLICY: ['政策法规', 't-info'], MARKET: ['市场公告', 't-chain'], SYSTEM: ['系统通知', 't-mute'] },
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
  const PALETTE = ['#10b981', '#38bdf8', '#f5a524', '#a78bfa', '#fb7185', '#2dd4bf', '#fbbf24', '#60a5fa', '#f472b6', '#4ade80'];

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
  /** 数值轴 */
  function valAxis(extra = {}) {
    return Object.assign({ type: 'value' }, AXIS, extra);
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

    onMounted(() => {
      nextTick(render);
      ro = new ResizeObserver(() => inst && inst.resize());
      if (el.value) ro.observe(el.value);
      window.addEventListener('resize', () => inst && inst.resize());
    });
    onUnmounted(() => { if (ro && el.value) ro.unobserve(el.value); if (inst) { inst.dispose(); inst = null; } });

    if (deps.length) watch(deps, () => nextTick(render), { deep: true });

    return { el, render, getInstance: () => inst };
  }

  /* ==================================================================
   * 九、其它工具
   * ================================================================== */
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
    });
    async function load(extra) {
      state.loading = true; state.error = '';
      try {
        const d = await loader(Object.assign({ page: state.page, size: state.size }, extra || {}));
        state.rows = d.rows || d || [];
        state.total = d.total !== undefined ? d.total : state.rows.length;
        state.pages = d.pages || Math.max(1, Math.ceil(state.total / state.size));
      } catch (e) {
        state.error = e.message;
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
    clear(prefix) {
      if (!prefix) return cache.map.clear();
      [...cache.map.keys()].forEach((k) => { if (k.startsWith(prefix)) cache.map.delete(k); });
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
    fmt, DICT, dict, notify, toast, copyText, debounce, usePager, cache,
    chartBase, catAxis, valAxis, areaGrad, useChart, PALETTE,
    vue: { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick },
  };
  global.setSession = setSession;
})(window);
