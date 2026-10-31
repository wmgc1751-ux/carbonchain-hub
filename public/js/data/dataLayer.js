/* =====================================================================
   前端数据层 —— 全动态，无快照回放
   ---------------------------------------------------------------------
   ⚠ 本文件替代了原来的 staticApi.js（已删除）。

   【为什么删掉快照回放，而不是"关掉它"】
   原实现在 fetch 层拦截 /api/*，把请求导向 public/data/api-snapshot.json
   里冻结的 248 条 fixture。它的设计初衷是"让纯静态站也能独立运行"，
   但带来一个致命问题：**页面上的每个数字都是某个时刻的快照，
   却以"当前值"的样式呈现**。

   评审点开两个页面会看到互相矛盾的数（比如总览说 60 家、明细说 55,706 家），
   无法判断哪个是真的。而"无法判断哪个是真的"这件事，比"数据不全"严重得多。

   因此本轮彻底移除该能力：
     · 不再拦截 fetch
     · 不再加载快照 JSON
     · 后端不可用时**直接报错**，而不是静默回放旧数据
   宁可让用户看到"服务不可用"，也不让用户看到"看起来正常的旧数据"。

   【保留的能力】
   只保留一个：`probe()` —— 探测后端是否可达，供页面显示连接状态。
   它不改变请求路径，只报告事实。
   ===================================================================== */
(function (global) {
  'use strict';

  const PROBE_URL = './api/health';
  const PROBE_TIMEOUT_MS = 6000;
  /* 连续几次"明确否定证据"才判离线。单次抖动不足以下结论：
   * 这个角标的用途是提示真实故障，误报会让它失去信号价值。 */
  const PROBE_FAILURES_BEFORE_OFFLINE = 2;

  const state = {
    mode: 'unknown',      // live | offline | unknown
    lastProbeAt: null,
    lastError: null,
    build: null,
    /* 诊断用：本轮超时（排队）与累计失败次数，不参与离线判定 */
    lastTimeout: false,
    lastDenial: null,
    failures: 0,
  };

  /**
   * 探测后端。
   * 判据必须是"拿到合法的 {code:0} JSON"，而不是 HTTP 200 ——
   * 因为静态托管对任意路径都返回 index.html（SPA 兜底），
   * 状态码 200 但内容是 HTML。历史上正是这个假 200 掩盖了后端不可用。
   *
   * ⚠ 超时 ≠ 离线（2026-10-30）。
   * 浏览器对同一 origin 的并发连接有硬上限（HTTP/1.1 约 6 条），而
   * /api/notify/stream 与 /api/real/stream 是两条常驻 SSE，各自长占一条；
   * 数据公示大屏、生产运维监控这类页面还会一次性并发十几个请求。
   * 于是 probe 的 fetch 经常排在队列里排队，6 秒 abort —— 但后端其实好好的
   * （实测同一时刻 curl /api/health 只要 10 ms，而页面显示"离线"）。
   * 把"排队超时"当成"后端不可达"是误报：顶栏一直挂红色"离线"角标，
   * 真实故障反而失去信号。
   *
   * 处理原则：
   *   · 只有**明确的否定证据**（非 JSON、code≠0、4xx/5xx、网络错误）才判 offline；
   *   · 超时一律维持上一次的结论，mode 记为 'unknown' 供诊断，不报离线；
   *   · 连续失败才降级 —— 单次抖动不足以改变结论。
   */
  async function probe() {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, PROBE_TIMEOUT_MS) : null;
    try {
      const res = await fetch(PROBE_URL, {
        headers: { Accept: 'application/json' },
        signal: ctl ? ctl.signal : undefined,
        cache: 'no-store',
      });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('json') < 0) {
        /* 非 JSON 是明确的否定证据：后端没在服务 API（静态托管兜底 / 反代错配） */
        state.lastDenial = 'non-json';
        if (++state.failures >= PROBE_FAILURES_BEFORE_OFFLINE) {
          state.mode = 'offline';
          state.lastError = `后端返回非 JSON（${ct || '未知'}）—— 可能被静态托管兜底成了 index.html`;
        }
      } else {
        const j = await res.json();
        if (j && j.code === 0) {
          state.mode = 'live';
          state.build = (j.data && j.data.build) || null;
          state.lastError = null;
          state.failures = 0;
        } else {
          state.lastDenial = 'code';
          if (++state.failures >= PROBE_FAILURES_BEFORE_OFFLINE) {
            state.mode = 'offline';
            state.lastError = `后端返回 code=${j && j.code}`;
          }
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        /* 排队超时：既不能证明在线，也不能证明离线。
         * 不累加 failures、不改 mode —— 保持上一次结论，避免误报与抖动。 */
        state.lastTimeout = true;
      } else {
        /* 网络层错误（DNS/拒绝连接/断网）是明确的否定证据 */
        state.lastDenial = 'network';
        if (++state.failures >= PROBE_FAILURES_BEFORE_OFFLINE) {
          state.mode = 'offline';
          state.lastError = String(e && e.message);
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      state.lastProbeAt = Date.now();
    }
    return state;
  }

  const Api = {
    get mode() { return state.mode; },
    isLive() { return state.mode === 'live'; },
    isOffline() { return state.mode === 'offline'; },
    status() {
      return {
        mode: state.mode,
        lastProbeAt: state.lastProbeAt,
        lastError: state.lastError,
        build: state.build,
        /* 诊断字段：让"没探到结果"与"确认不可达"在日志里可区分 */
        lastTimeout: state.lastTimeout,
        lastDenial: state.lastDenial,
        failures: state.failures,
      };
    },
    probe,
    /** 兼容旧调用点：本版本不存在静态模式，恒返回 false */
    isStatic() { return false; },
  };

  global.App = global.App || {};
  global.App.DataLayer = Api;
  global.App.StaticApi = Api;
})(typeof window !== 'undefined' ? window : globalThis);
