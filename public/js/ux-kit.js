/* =====================================================================
   ux-kit.js —— 升级层组合式工具（【新增增强】2026-10-25）
   ---------------------------------------------------------------------
   这里只放"多个页面都要用、但放哪一页都不合适"的通用能力：
     useSelection   批量选择（跨页保持）
     useRetry       请求重试状态机（loading / error / hint）
     useDensity     密度档
     toCSV/downloadCSV  结构化导出
     lockScroll     弹窗滚动锁（带计数，支持嵌套弹窗）
     isCmd / isTyping  快捷键判据

   设计约束：
   · 全部是纯函数 / 组合式函数，**无人调用即零副作用**；
   · 不依赖任何具体页面，只依赖 App.* ；
   · 不在这里做 DOM 结构，只做状态与工具，样式交给 v2.css。
   ===================================================================== */
(function (global) {
  'use strict';
  const { ref, reactive, computed } = Vue;

  /* ==================================================================
   * 一、批量选择
   * ------------------------------------------------------------------
   * 为什么存 key 而不是存行对象：
   * 分页/筛选后行对象会被整体替换，存对象引用会导致"翻页回来选中丢失，
   * 或者选中的是旧对象、导出的是过期数据"。存主键则跨页稳定。
   * ================================================================== */
  function useSelection(getRows, rowKey = 'id') {
    const keys = ref([]);

    const keyOf = (row) => (row === null || row === undefined ? '' : String(row[rowKey]));

    const count = computed(() => keys.value.length);

    function has(row) { return keys.value.indexOf(keyOf(row)) > -1; }

    function toggle(row) {
      const k = keyOf(row);
      if (!k) return;
      const i = keys.value.indexOf(k);
      if (i > -1) keys.value = keys.value.filter((x) => x !== k);
      else keys.value = keys.value.concat([k]);
    }

    /** 本页全选 / 全不选（不触碰其他页已选项） */
    function toggleAll(on) {
      const all = (getRows() || []).map(keyOf).filter(Boolean);
      if (on) {
        const set = {};
        keys.value.concat(all).forEach((k) => { set[k] = 1; });
        keys.value = Object.keys(set);
      } else {
        const drop = {};
        all.forEach((k) => { drop[k] = 1; });
        keys.value = keys.value.filter((k) => !drop[k]);
      }
    }

    function clear() { keys.value = []; }

    /** 只返回"当前可见行"里被选中的，用于本页操作 */
    function pickRows(rows) {
      return (rows || []).filter(has);
    }

    const allSelected = computed(() => {
      const all = (getRows() || []).map(keyOf).filter(Boolean);
      return all.length > 0 && all.every((k) => keys.value.indexOf(k) > -1);
    });

    const someSelected = computed(() => {
      const all = (getRows() || []).map(keyOf).filter(Boolean);
      const n = all.filter((k) => keys.value.indexOf(k) > -1).length;
      return n > 0 && n < all.length;
    });

    return { keys, count, has, toggle, toggleAll, clear, pickRows, allSelected, someSelected, keyOf };
  }

  /* ==================================================================
   * 二、CSV 导出
   * ------------------------------------------------------------------
   * 三个必须做对的细节（否则用户打开是乱码或错列）：
   *   ① BOM：不加 \ufeff，Excel 会用本地编码（GBK）读，中文全变乱码；
   *   ② 转义：字段里出现逗号/引号/换行时必须加双引号，内部引号翻倍；
   *   ③ 列定义：优先用 c.export(row) 生成，其次 row[c.key] ——
   *      展示值可能是 vnode（插槽渲染），不能直接 String()。
   * ================================================================== */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'string' ? v : String(v);
    /* 防 CSV 注入：以 = + - @ 开头的值会被 Excel 当公式执行 */
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(columns, rows) {
    const cols = (columns || []).filter((c) => c && c.export !== false && (c.key || c.export));
    const head = cols.map((c) => csvCell(c.csvTitle || c.title || c.key)).join(',');
    const body = (rows || []).map((row) => cols.map((c) => {
      const v = typeof c.export === 'function' ? c.export(row) : row[c.key];
      return csvCell(v);
    }).join(','));
    return '\ufeff' + [head].concat(body).join('\r\n');
  }

  function downloadCSV(filename, columns, rows) {
    const text = toCSV(columns, rows);
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    /* 文件名带时间戳：连续导出两次不会互相覆盖，也不会有 "(1)" 后缀 */
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    a.download = `${(filename || 'export').replace(/[\\/:*?"<>|]/g, '_')}_${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    /* 延迟回收：Safari 在 click 同步阶段回收会导致下载取消 */
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return text;
  }

  /* ==================================================================
   * 三、请求重试状态机
   * ================================================================== */
  function useRetry(fn) {
    const loading = ref(false);
    const error = ref('');
    const hint = ref(null);

    async function run() {
      loading.value = true;
      error.value = '';
      hint.value = null;
      try {
        return await fn.apply(null, arguments);
      } catch (e) {
        error.value = (e && e.message) || '未知错误';
        hint.value = (App.errHint ? App.errHint(e) : null);
        return undefined;
      } finally {
        loading.value = false;
      }
    }

    return { run, retry: run, loading, error, hint };
  }

  /* ==================================================================
   * 四、密度档（紧凑 / 标准 / 宽松）
   * ================================================================== */
  const DENSITY_ORDER = ['compact', 'normal', 'loose'];
  const DENSITY_LABEL = { compact: '紧凑', normal: '标准', loose: '宽松' };

  function useDensity() {
    const density = computed(() => (App.prefs ? App.prefs.density : 'normal'));
    function setDensity(v) {
      if (DENSITY_ORDER.indexOf(v) < 0) v = 'normal';
      App.setPref('density', v);
    }
    function cycleDensity() {
      const i = DENSITY_ORDER.indexOf(density.value);
      setDensity(DENSITY_ORDER[(i + 1) % DENSITY_ORDER.length]);
    }
    return { density, setDensity, cycleDensity, label: () => DENSITY_LABEL[density.value] };
  }

  /* ==================================================================
   * 五、滚动锁（支持嵌套：两个弹窗叠开时，关掉上面那个不该解锁背景）
   * ================================================================== */
  let lockCount = 0;
  let savedOverflow = '';

  function lockScroll() {
    lockCount += 1;
    if (lockCount === 1) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
  }

  function unlockScroll() {
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) {
      document.body.style.overflow = savedOverflow || '';
    }
  }

  /* ==================================================================
   * 六、快捷键判据
   * ================================================================== */
  /** ⌘ / Ctrl 组合键 */
  function isCmd(e) { return !!(e.metaKey || e.ctrlKey); }

  /** 当前焦点是否在输入类元素里（此时不应劫持普通字母键） */
  function isTyping(el) {
    const t = el || document.activeElement;
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }

  /* ==================================================================
   * 七、任务状态机（【新增增强】2026-10-25）
   * ------------------------------------------------------------------
   * 要解决的问题：全站"加载中…"只有一句话，用户分不清
   *   是"正在请求"、"请求回来了正在算"、还是"根本没发出去在排队"。
   * 三种情况的正确应对完全不同（等 / 再等 / 别等了去查原因）。
   *
   * 状态流转：
   *   idle → loading ──1.2s 未回──▶ working ──▶ ok / fail
   *   idle → queued（排队等待上游资源，如链上出块、批处理窗口）
   *
   * ⚠ 1.2 s 升级为"处理中"的依据：低于 1 s 的等待用户感知为"瞬时"，
   *   换了措辞反而闪一下；超过 1 s 用户开始怀疑卡死，此时换措辞有效。
   * ================================================================== */
  const TASK_STATE = {
    idle: { label: '', tone: 'mute' },
    loading: { label: '加载中', tone: 'run' },
    working: { label: '处理中', tone: 'run' },
    queued: { label: '排队中', tone: 'wait' },
    ok: { label: '已完成', tone: 'good' },
    fail: { label: '失败', tone: 'bad' },
  };

  function useTask(fn, opts) {
    const o = opts || {};
    const slowMs = o.slowMs === undefined ? 1200 : o.slowMs;
    const state = ref('idle');
    const error = ref('');
    const hint = ref('');
    const elapsed = ref(0);
    let startedAt = 0;
    let timer = null;

    const busy = () => state.value === 'loading' || state.value === 'working' || state.value === 'queued';

    async function run() {
      /* 防重入：按钮连点是最常见的重复请求来源，这里挡一次比在 74 个页面上加 disabled 更可靠 */
      if (busy()) return undefined;
      state.value = 'loading';
      error.value = ''; hint.value = '';
      elapsed.value = 0; startedAt = Date.now();
      timer = setInterval(() => { elapsed.value = Date.now() - startedAt; }, 200);
      const slow = setTimeout(() => { if (state.value === 'loading') state.value = 'working'; }, slowMs);
      try {
        const out = await fn.apply(null, arguments);
        state.value = 'ok';
        return out;
      } catch (e) {
        state.value = 'fail';
        error.value = (e && e.message) || '未知错误';
        hint.value = (App.errHint ? App.errHint(e) : null);
        return undefined;
      } finally {
        clearTimeout(slow);
        clearInterval(timer);
        timer = null;
        if (startedAt) elapsed.value = Date.now() - startedAt;
      }
    }

    function reset() { state.value = 'idle'; error.value = ''; hint.value = ''; elapsed.value = 0; }

    const info = computed(() => TASK_STATE[state.value] || TASK_STATE.idle);
    const label = computed(() => info.value.label);
    const tone = computed(() => info.value.tone);
    const running = computed(busy);

    return { state, label, tone, running, error, hint, elapsed, run, retry: run, reset, setQueued: () => { state.value = 'queued'; } };
  }

  /* ==================================================================
   * 八、表单校验（失焦即验 + 提交禁用）（【新增增强】2026-10-25）
   * ------------------------------------------------------------------
   * 规则写法（沿用 core.js 已有的 validate 语义，不新造判定函数）：
   *   useForm(model, {
   *     amount: [[App.validators.positive, '数量必须大于 0']],
   *     code:   [[App.validators.required, '编号必填'], [App.validators.code, '编号格式不对']],
   *   })
   * 关键设计：错误**只在字段失焦后**才显示 ——
   *   一边输入一边报红是最劝退的交互，用户第一个字符还没打完就被判错。
   * ================================================================== */
  function useForm(model, rules) {
    const errors = reactive({});
    const touched = reactive({});
    const R = rules || {};

    function check(k) {
      const list = R[k] || [];
      const msg = App.validate
        ? App.validate(list.map((it) => [model[k], it[0], it[1]]))
        : '';
      errors[k] = msg;
      return !msg;
    }

    function checkAll() {
      let ok = true;
      Object.keys(R).forEach((k) => { if (!check(k)) ok = false; });
      return ok;
    }

    /** 失焦：标记已触碰并校验 */
    function blur(k) { touched[k] = true; check(k); }

    /** 就地展示用：没被碰过的字段不返回错误，避免"一进页面满屏红" */
    function err(k) { return touched[k] ? (errors[k] || '') : ''; }

    function touchAll() { Object.keys(R).forEach((k) => { touched[k] = true; check(k); }); }

    function reset() {
      Object.keys(errors).forEach((k) => { delete errors[k]; });
      Object.keys(touched).forEach((k) => { delete touched[k]; });
    }

    /* 提交按钮禁用态：全量静默校验（不写 touched） */
    const valid = computed(() => {
      const keys = Object.keys(R);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const list = R[k] || [];
        const msg = App.validate ? App.validate(list.map((it) => [model[k], it[0], it[1]])) : '';
        if (msg) return false;
      }
      return true;
    });

    /** 直接绑到 input 上：v-on:blur 与 class 都能一次给全（模板用 spread 或 h() 直接展开） */
    function bind(k) {
      return {
        value: model[k],
        onInput: (e) => { model[k] = e.target.value; if (touched[k]) check(k); },
        onBlur: () => blur(k),
        class: err(k) ? 'is-err' : '',
      };
    }

    return { errors, touched, check, checkAll, blur, err, touchAll, reset, valid, bind };
  }

  /* ==================================================================
   * 九、筛选器（关键词 + 时间 + 状态 + 可移除标签）
   * ------------------------------------------------------------------
   * 只做"前端过滤 + 状态托管"，不碰请求 ——
   * 服务端筛选各页参数名不同，硬统一会把接口改坏。
   * ================================================================== */
  function useFilter(getRows, opts) {
    const o = opts || {};
    const kw = ref('');
    const from = ref('');
    const to = ref('');
    const picked = ref([]);          // 状态多选
    const fields = o.fields || [];   // 关键词参与匹配的字段
    const dateKey = o.dateKey || '';
    const statusKey = o.statusKey || '';
    const statusOptions = o.statusOptions || [];

    const norm = (v) => (v === null || v === undefined ? '' : String(v)).toLowerCase();

    const filtered = computed(() => {
      let out = (getRows() || []).slice();
      const q = kw.value.trim().toLowerCase();
      if (q) {
        out = out.filter((r) => {
          if (!fields.length) return norm(r).indexOf(q) > -1;
          return fields.some((f) => norm(r[f]).indexOf(q) > -1);
        });
      }
      if (dateKey && (from.value || to.value)) {
        out = out.filter((r) => {
          const d = String(r[dateKey] || '').slice(0, 10);
          if (!d) return false;
          if (from.value && d < from.value) return false;
          if (to.value && d > to.value) return false;
          return true;
        });
      }
      if (statusKey && picked.value.length) {
        out = out.filter((r) => picked.value.indexOf(String(r[statusKey])) > -1);
      }
      return out;
    });

    /** 已生效条件 → 可移除标签。清空按钮不需要单独记状态，标签自己就是状态。 */
    const tags = computed(() => {
      const t = [];
      if (kw.value.trim()) t.push({ key: 'kw', label: '关键词：' + kw.value.trim(), clear: () => { kw.value = ''; } });
      if (from.value) t.push({ key: 'from', label: '起始：' + from.value, clear: () => { from.value = ''; } });
      if (to.value) t.push({ key: 'to', label: '截止：' + to.value, clear: () => { to.value = ''; } });
      picked.value.forEach((v) => {
        const opt = statusOptions.filter((x) => String(x.value) === String(v))[0];
        t.push({ key: 'st-' + v, label: (opt && opt.label) || v, clear: () => { picked.value = picked.value.filter((x) => x !== v); } });
      });
      return t;
    });

    function toggleStatus(v) {
      const s = String(v);
      picked.value = picked.value.indexOf(s) > -1
        ? picked.value.filter((x) => x !== s)
        : picked.value.concat([s]);
    }

    function clearAll() {
      kw.value = ''; from.value = ''; to.value = ''; picked.value = [];
    }

    const active = computed(() => tags.value.length > 0);
    const total = computed(() => (getRows() || []).length);
    const shown = computed(() => filtered.value.length);

    return { kw, from, to, picked, fields, dateKey, statusKey, statusOptions, filtered, tags, toggleStatus, clearAll, active, total, shown };
  }

  /* ==================================================================
     【新增】无障碍补全与自愈（2026-10-26）
     ------------------------------------------------------------------
     问题来源：全站表单普遍写成
       h('div', { class: 'field' }, [ h('label', {}, '核算季度'), h('select', ...) ])
     label 与控件是"看得见、读不到"的关系（没有 for/id，也不是包裹关系），
     屏幕阅读器只会念"组合框"；筛选条上的 select 更是完全没有名字。
     图标按钮同理：视觉上认识，读屏里是一片空白。

     处理（只补语义，不动任何视觉）：
       1) .field 内 label 紧跟控件 ⇒ 自动配 id/for
       2) 无名字的 select ⇒ 由首选项"全部行业"推导 aria-label="行业筛选"
       3) 图标按钮 ⇒ 有 title/data-label 就转成 aria-label
       4) 补不上的不静默也不刷控制台，记进 App.a11y.pending 供审计取
     用 MutationObserver 去抖执行，视图切换后自动重跑（自愈）。
  ================================================================== */
  let __a11ySeq = 0;
  const A11Y_PENDING = [];

  function a11yHasName(el) {
    if (!el) return true;
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
    if (el.getAttribute('title')) return true;
    if (el.id && document.querySelector('label[for="' + el.id + '"]')) return true;
    if (el.closest && el.closest('label')) return true;
    const tag = (el.tagName || '').toLowerCase();
    if ((tag === 'input' || tag === 'textarea') && el.getAttribute('placeholder')) return true;
    return false;
  }

  /* textContent 经常带着布局换行（图标与文字分处两块），直接写进 aria-label
     会得到 "全 选本页"、"轮换主 体" 这种怪名字。CJK 之间的空白一律去掉，
     其余空白折叠成一个空格。 */
  function a11yClean(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/([\u3000-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u9fff\uff00-\uffef])/g, '$1')
      .replace(/[：:]\s*$/, '')
      .trim();
  }

  function a11yFieldLabels(root) {
    let n = 0;
    const ctlSel = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea';
    const directSel = ctlSel.split(',').map((s) => ':scope > ' + s.trim()).join(', ');
    /* 写法一：.field 结构（label 与控件是兄弟） */
    const boxes = root.querySelectorAll('.field, .form-row, .form-item');
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const lab = box.querySelector(':scope > label');
      const ctl = box.querySelector(directSel);
      if (!lab || !ctl || a11yHasName(ctl)) continue;
      if (!ctl.id) ctl.id = 'fld-' + (++__a11ySeq);
      lab.setAttribute('for', ctl.id);
      n += 1;
    }
    /* 写法二：紧凑行内表单 —— <div><div class="tiny dim">轮换主体</div><select/></div>
       标题是 div 而不是 label，读屏读不到。这里把"紧邻的前一个短文本兄弟"
       当作字段名（有长度上限且内部没有表单控件，避免误取整段说明）。
       ⚠ 提示文字常带补充说明，直接整段当名字会念出"建议用演示主体"这种冗余：
         "主体标签（建议用演示主体）" → 主体标签
         "主体标签 keyLabel"          → 主体标签
         "轮换原因 / 备注"            → 轮换原因 */
    root.querySelectorAll(ctlSel).forEach((ctl) => {
      if (a11yHasName(ctl)) return;
      const prev = ctl.previousElementSibling;
      if (!prev || !/^(LABEL|DIV|SPAN|P|B|I|STRONG)$/.test(prev.tagName)) return;
      if (prev.querySelector('input, select, textarea, button')) return;
      const raw = a11yClean(prev.textContent);
      if (!raw) return;
      let t = raw.split(/[（(：:/|、，,]/)[0].trim();
      const firstTok = t.split(' ')[0];
      if (/^[\u4e00-\u9fa5]{2,}$/.test(firstTok)) t = firstTok;
      if (!t || t.length > 24) return;
      ctl.setAttribute('aria-label', t);
      n += 1;
    });
    return n;
  }

  /* 只对"全部/请选择/不限/所有"开头的首选项推导名字，
     否则会把"第 1 季度"这种真实取值当成标签，反而更误导。 */
  function a11ySelectName(sel) {
    const first = sel.options && sel.options[0] ? String(sel.options[0].text || '').trim() : '';
    if (!/^(全部|请选择|不限|所有|选择)/.test(first)) return '';
    const t = first.replace(/^(全部|请选择|不限|所有|选择)/, '').replace(/[…⋯\.．:：\s]+$/, '').trim();
    if (!t) return '';
    return /筛选$/.test(t) ? t : t + '筛选';
  }

  function a11yControls(root) {
    let n = 0;
    root.querySelectorAll('select').forEach((s) => {
      if (a11yHasName(s)) return;
      const nm = a11ySelectName(s);
      if (nm) { s.setAttribute('aria-label', nm); n += 1; return; }
      A11Y_PENDING.push({ kind: 'select', cls: String(s.className || '') });
    });
    root.querySelectorAll('button, a[href], [role="button"]').forEach((b) => {
      if ((b.innerText || '').trim() || a11yHasName(b)) return;
      const lb = b.getAttribute('data-label');
      if (lb) { b.setAttribute('aria-label', lb); n += 1; return; }
      const t = b.querySelector('svg > title');
      if (t && t.textContent.trim()) { b.setAttribute('aria-label', t.textContent.trim()); n += 1; return; }
      /* .input-group 里唯一的图标按钮＝搜索触发键。全站固定写法：
           h('div',{class:'input-group'},[ h('input',…), h('button',{class:'btn'},[x-icon search]) ])
         组里有文本框、按钮无文字 ⇒ 它的作用就是"按当前关键词检索"，不是猜测。 */
      const grp = b.closest ? b.closest('.input-group') : null;
      if (grp && grp.querySelector('input')) { b.setAttribute('aria-label', '搜索'); n += 1; return; }
      A11Y_PENDING.push({ kind: 'icon-button', cls: String(b.className || ''), html: String(b.outerHTML || '').slice(0, 90) });
    });
    root.querySelectorAll('img:not([alt])').forEach((im) => { im.setAttribute('alt', ''); n += 1; });
    return n;
  }

  function a11ySweep(rootEl) {
    const root = rootEl || document.querySelector('.content') || document.body;
    if (!root) return 0;
    A11Y_PENDING.length = 0;
    return a11yFieldLabels(root) + a11yControls(root);
  }

  function a11yInstall(rootEl) {
    /* 观察 body 而不是 #app：弹窗/抽屉常被 teleport 到 body 之外，
       只看 #app 会把"弹窗里的表单没有 label 关联"整片漏掉（/keys 就是这样漏的）。 */
    const target = rootEl || document.body;
    const run = () => { try { a11ySweep(target); } catch (e) { /* 自愈失败绝不能拖垮业务 */ } };
    let timer = 0;
    run();
    let mo = null;
    try {
      mo = new MutationObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(run, 160); });
      mo.observe(target, { childList: true, subtree: true });
    } catch (e) { /* 老浏览器忽略 */ }
    return { run, pending: A11Y_PENDING, stop: () => { if (mo) mo.disconnect(); } };
  }

  App.a11y = { sweep: a11ySweep, install: a11yInstall, pending: A11Y_PENDING };

  /* 自举：ux-kit 先于 app.js 加载，等 #app 出现再装 */
  (function bootA11y() {
    let tries = 0;
    const tick = () => {
      if (document.getElementById('app')) { a11yInstall(); return; }
      if (++tries > 120) return;
      setTimeout(tick, 250);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick);
    else tick();
  })();

  App.ux = {
    useSelection, toCSV, downloadCSV,
    useRetry, useDensity,
    lockScroll, unlockScroll,
    isCmd, isTyping,
    DENSITY_ORDER, DENSITY_LABEL,
    /* 【新增增强】2026-10-25 */
    TASK_STATE, useTask, useForm, useFilter,
  };
})(window);
