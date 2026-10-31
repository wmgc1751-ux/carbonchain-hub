/* =====================================================================
   cmd-palette.js —— 全局命令面板（【新增增强】2026-10-25）
   ---------------------------------------------------------------------
   【为什么需要】
   监管端侧栏 25 项、企业端 18 项，且分 5 个分组。找一个入口要：
   回忆它在哪个分组 → 滚到那个分组 → 点开。熟练用户也至少 3 步。
   命令面板把这三步压成一步：⌘K → 敲两个字 → 回车。

   【与侧栏搜索的分工】
   侧栏搜索（原有）只在工作台布局、且只能筛当前角色的菜单；
   命令面板是**全局**的：公开页也能用、能跨角色按权限过滤、还能执行动作
   （切密度 / 投屏 / 复制地址）。两者并存，谁也没替代谁。

   【权限】
   列表直接复用 App.routeAccess.canEnter —— 与路由守卫同一判据。
   不会出现在面板里的页面，就是点进去也会被弹回来的页面。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, watch, nextTick } = Vue;
  /* ⚠ 必须用 App.h 而不是 Vue.h：
   * Vue.h('x-icon') 会把它当原生自定义元素渲染成空标签，
   * 因为字符串标签不会去查全局注册表。App.h 会把 x-* 换成组件对象。 */
  const h = App.h;

  /* ------------------------------------------------------------------
   * 状态（模块级单例：面板只有一个，跨页面常驻）
   * ------------------------------------------------------------------ */
  const open = ref(false);
  const q = ref('');
  const sel = ref(0);
  const inputEl = ref(null);
  const listEl = ref(null);

  function reset() { q.value = ''; sel.value = 0; }

  function openPalette() {
    if (open.value) return;
    reset();
    open.value = true;
    nextTick(() => { if (inputEl.value) inputEl.value.focus(); });
  }

  function closePalette() {
    open.value = false;
  }

  function togglePalette() {
    if (open.value) closePalette(); else openPalette();
  }

  /* ------------------------------------------------------------------
   * 数据源 1：可访问的页面
   * ------------------------------------------------------------------ */
  function buildRoutes() {
    const ra = App.routeAccess || {};
    const crumb = ra.CRUMB || {};
    const role = (App.Store.user && App.Store.user.role) || null;
    const can = ra.canEnter || (() => true);

    const seen = {};
    const out = [];

    function push(path, label, group) {
      if (!path || seen[path]) return;
      if (path.indexOf(':') > -1) return;      // 动态路由（区块/交易详情）不进面板
      if (!can(role, path)) return;            // 与路由守卫同一判据
      seen[path] = 1;
      out.push({ type: 'route', path, label: label || path, group: group || '' });
    }

    /* ① 当前角色菜单（顺序与侧栏一致，用户的心智模型就在这里） */
    const menus = ra.MENUS || {};
    (role ? (menus[role] || []) : []).forEach((g) => {
      (g.items || []).forEach((it) => push(it.path, it.label, g.group));
    });

    /* ② 公开页：未登录时菜单为空，但公示大屏/浏览器/验证中心本来就该能进 */
    (ra.OPEN_ROUTES || []).forEach((p) => {
      const c = crumb[p];
      push(p, (c && c[1]) || p, '公开页面');
    });

    /* ③ 兜底：路由表里还有、但没写进菜单的页（如 /gov/*） */
    (ra.ROUTES || []).forEach(([p]) => {
      const c = crumb[p];
      if (c) push(p, c[1], c[0]);
      else push(p, p, '其他页面');
    });

    return out;
  }

  /* ------------------------------------------------------------------
   * 数据源 2：动作
   * ------------------------------------------------------------------ */
  function buildActions() {
    const acts = [];
    const url = location.href;

    if (App.Store.user) {
      acts.push({
        type: 'action', label: '返回我的工作台', group: '动作', icon: 'dash',
        run: () => {
          const home = (App.routeAccess && App.routeAccess.ROLE_HOME) || {};
          const p = home[App.Store.user.role] || '/screen';
          App.go(p);
        },
      });
    }

    acts.push({
      type: 'action', label: '刷新当前页数据', group: '动作', icon: 'refresh',
      hint: '丢弃缓存，重新拉取',
      run: () => location.reload(),
    });

    acts.push({
      type: 'action',
      label: App.prefs.nav === 'collapsed' ? '展开侧边栏' : '收起侧边栏',
      group: '动作', icon: 'panelLeft',
      run: () => App.setPref('nav', App.prefs.nav === 'collapsed' ? 'expanded' : 'collapsed'),
    });

    acts.push({
      type: 'action', label: '切换信息密度（当前：' + densityLabel() + '）', group: '动作', icon: 'sliders',
      run: () => {
        const order = ['compact', 'normal', 'loose'];
        const i = order.indexOf(App.prefs.density);
        App.setPref('density', order[(i + 1) % order.length]);
        App.notify.info('信息密度：' + densityLabel());
      },
    });

    acts.push({
      type: 'action', label: '切换投屏模式（答辩投影）', group: '动作', icon: 'expand',
      run: () => {
        const btn = document.querySelector('.present-btn');
        if (btn) btn.click();
        else App.notify.warn('当前页面没有投屏模式');
      },
    });

    acts.push({
      type: 'action', label: '复制当前页面地址', group: '动作', icon: 'copy',
      run: () => App.copyText(url),
    });

    acts.push({
      type: 'action', label: '清空「最近访问」', group: '动作', icon: 'clock',
      run: () => { App.recent.clear(); App.notify.ok('已清空最近访问'); },
    });

    /* 【新增增强】把快捷键说明本身也做成一条可搜索的动作 ——
     * 否则用户得先知道有 `?` 才能看到快捷键，是个死循环。 */
    acts.push({
      type: 'action', label: '查看键盘快捷键', group: '动作', icon: 'command',
      run: () => { helpOpen.value = true; },
    });

    return acts;
  }

  function densityLabel() {
    const map = { compact: '紧凑', normal: '标准', loose: '宽松' };
    return map[App.prefs.density] || '标准';
  }

  /* ------------------------------------------------------------------
   * 检索：先算分再排序
   * ------------------------------------------------------------------
   * 为什么不用模糊子序列匹配：中文标签的子序列匹配会产生大量噪音
   * （「配额」两个字的子序列能命中半个菜单）。这里用三段式：
   *   前缀命中(0) < 包含命中(1) < 分组命中(2)
   * 同分按原始顺序（菜单顺序本身有信息量），稳定排序。
   * ------------------------------------------------------------------ */
  function score(item, query) {
    const s = query.toLowerCase();
    const label = String(item.label).toLowerCase();
    const path = String(item.path || '').toLowerCase();
    const group = String(item.group || '').toLowerCase();
    if (label.indexOf(s) === 0) return 0;
    if (label.indexOf(s) > 0) return 1;
    if (path.indexOf(s) > -1) return 2;
    if (group.indexOf(s) > -1) return 3;
    return -1;
  }

  const items = computed(() => {
    const query = q.value.trim();
    const routes = buildRoutes();
    const acts = buildActions();

    let recentItems = [];
    if (!query) {
      recentItems = App.recent.list()
        .filter((r) => r.path && r.path !== App.Router.path)
        .slice(0, 5)
        .map((r) => ({ type: 'route', path: r.path, label: r.label, group: '最近访问', icon: 'clock' }));
    }

    const all = recentItems.concat(routes, acts);
    if (!query) {
      /* 无查询：最近访问 → 动作 → 页面。前两组最多各 6 条，避免面板变成目录 */
      return all.slice(0, 40);
    }

    const scored = [];
    all.forEach((it) => {
      /* 同一个页面可能同时来自"菜单"和"最近访问"，按 path 去重，保留分高的 */
      const sc = score(it, query);
      if (sc > -1) scored.push({ it, sc, i: scored.length });
    });
    scored.sort((a, b) => (a.sc - b.sc) || (a.i - b.i));
    return scored.slice(0, 30).map((x) => x.it);
  });

  /* 空结果时给出的示例词：从当前角色真实可选的条目里挑 3 个标签片段。
   * 写死的示例词在别的角色下可能一条都搜不到，那比不给提示更糟。 */
  const suggest = computed(() => {
    const pool = buildRoutes().concat(buildActions());
    const out = [];
    const seen = new Set();
    for (const it of pool) {
      const lbl = String(it.label || '');
      if (lbl.length < 2) continue;
      const piece = lbl.slice(0, Math.min(4, lbl.length));
      if (seen.has(piece)) continue;
      seen.add(piece);
      out.push(piece);
      if (out.length >= 3) break;
    }
    return out;
  });

  /* 查询变化时把选中项拉回第一条 —— 否则会停在上一次的位置上，回车跳错页 */
  watch(q, () => { sel.value = 0; });
  watch(items, () => { if (sel.value >= items.value.length) sel.value = 0; });

  function move(delta) {
    const n = items.value.length;
    if (!n) return;
    sel.value = (sel.value + delta + n) % n;
    nextTick(() => {
      const box = listEl.value;
      if (!box) return;
      const el = box.querySelector('.cmdk-item.on');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function choose(idx) {
    const it = items.value[idx === undefined ? sel.value : idx];
    if (!it) return;
    closePalette();
    if (it.type === 'action') {
      try { it.run(); } catch (e) { App.notify.err(e.message); }
      return;
    }
    App.go(it.path);
  }

  /* ------------------------------------------------------------------
   * 高亮命中片段（保持大小写，只切分不替换）
   * ------------------------------------------------------------------ */
  function highlight(text, query) {
    const s = String(text || '');
    const qq = String(query || '').trim();
    if (!qq) return s;
    const i = s.toLowerCase().indexOf(qq.toLowerCase());
    if (i < 0) return s;
    return [s.slice(0, i), h('mark', {}, s.slice(i, i + qq.length)), s.slice(i + qq.length)];
  }

  /* ------------------------------------------------------------------
   * 组件
   * ------------------------------------------------------------------ */
  const CmdPalette = defineComponent({
    name: 'cmd-palette',
    setup() {
      return () => {
        if (!open.value) return null;
        const list = items.value;

        /* 分组标题只在"无查询"或跨组时插入，避免每行都带一个小标题 */
        let lastGroup = null;
        const rows = [];
        list.forEach((it, i) => {
          if (it.group && it.group !== lastGroup) {
            lastGroup = it.group;
            rows.push(h('div', { class: 'cmdk-group' }, it.group));
          }
          rows.push(h('div', {
            class: ['cmdk-item', i === sel.value && 'on'],
            onMouseenter: () => { sel.value = i; },
            onClick: () => choose(i),
          }, [
            h('span', { class: 'ic' }, [h('x-icon', { name: it.icon || (it.type === 'action' ? 'spark' : 'table'), size: 15 })]),
            h('span', { class: 'tx' }, highlight(it.label, q.value)),
            it.type === 'route'
              ? h('span', { class: 'pt mono' }, it.path)
              : h('kbd', { class: 'run' }, '执行'),
          ]));
        });

        return h('div', { class: 'cmdk-mask', onClick: closePalette }, [
          h('div', { class: 'cmdk', role: 'dialog', 'aria-label': '命令面板', onClick: (e) => e.stopPropagation() }, [
            h('div', { class: 'cmdk-input' }, [
              h('x-icon', { name: 'search', size: 16 }),
              h('input', {
                ref: inputEl,
                type: 'text',
                placeholder: '搜索页面、动作…（输入中文或路径均可）',
                value: q.value,
                'aria-label': '搜索页面或动作',
                onInput: (e) => { q.value = e.target.value; },
                onKeydown: (e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
                  else if (e.key === 'Enter') { e.preventDefault(); choose(); }
                  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
                },
              }),
              h('kbd', {}, 'ESC'),
            ]),
            h('div', { class: 'cmdk-list', ref: listEl },
              list.length ? rows : [
                h('div', { class: 'cmdk-empty' }, [
                  h('x-icon', { name: 'search', size: 22 }),
                  h('div', {}, '没有匹配的页面或动作'),
                  /* 示例词必须取自当前角色真实存在的条目：写死「配额」在管理端
                   * 一条都搜不到，用户会以为搜索坏了（实测即如此）。
                   * 这里从可选条目里取，保证"照着提示输入一定能搜到"。 */
                  h('div', { class: 'tiny dim' },
                    suggest.value.length
                      ? '试试 ' + suggest.value.map((x) => `「${x}」`).join('') + '，或直接输入路径（如 /mrv）'
                      : '当前角色暂无可搜索的条目'),
                ]),
              ]),
            h('div', { class: 'cmdk-foot' }, [
              h('span', {}, [h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' 选择']),
              h('span', {}, [h('kbd', {}, '↵'), ' 打开']),
              h('span', {}, [h('kbd', {}, 'ESC'), ' 关闭']),
              h('span', {
                class: 'help-link',
                role: 'button', tabIndex: 0,
                title: '查看全部键盘快捷键',
                onClick: (e) => { e.stopPropagation(); closePalette(); helpOpen.value = true; },
                onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); closePalette(); helpOpen.value = true; } },
              }, [h('kbd', {}, '?'), ' 快捷键']),
              h('span', { class: 'right dim' }, `${list.length} 项`),
            ]),
          ]),
        ]);
      };
    },
  });

  /* ==================================================================
   * 快捷键说明浮层（【新增增强】2026-10-25）
   * ------------------------------------------------------------------
   * 为什么值得做：快捷键是"只有知道的人才用得上"的能力。
   * 没有说明入口 = 等于没做。`?` 是这类帮助的通用约定（GitHub / Gmail 同款），
   * 且不需要用户先记住任何东西 —— 但前提是"有人告诉他可以按 ?"，
   * 所以命令面板底部常驻一个「? 快捷键」入口。
   * ================================================================== */
  const helpOpen = ref(false);

  const SHORTCUTS = [
    { k: ['⌘ / Ctrl', 'K'], t: '打开命令面板（搜索页面与动作）' },
    { k: ['/'], t: '聚焦当前页搜索框；本页没有搜索框时打开命令面板' },
    { k: ['?'], t: '显示 / 关闭这份快捷键说明' },
    { k: ['↑', '↓'], t: '在命令面板中上下选择' },
    { k: ['↵'], t: '打开选中项；表单内为提交' },
    { k: ['Esc'], t: '关闭命令面板、抽屉或弹窗' },
    { k: ['Tab'], t: '弹窗内循环焦点，不会跑到背景页面' },
  ];

  function toggleHelp() { helpOpen.value = !helpOpen.value; }

  const ShortcutHelp = defineComponent({
    name: 'shortcut-help',
    setup() {
      return () => {
        if (!helpOpen.value) return null;
        return h('div', { class: 'cmdk-mask', onClick: () => { helpOpen.value = false; } }, [
          h('div', {
            class: 'cmdk help-card', role: 'dialog', 'aria-label': '快捷键说明',
            onClick: (e) => e.stopPropagation(),
          }, [
            h('div', { class: 'cmdk-input' }, [
              h('x-icon', { name: 'command', size: 16 }),
              h('span', { class: 'help-title' }, '键盘快捷键'),
              h('kbd', { class: 'ml-auto' }, '?'),
            ]),
            h('div', { class: 'cmdk-list help-list' }, SHORTCUTS.map((s) => h('div', { class: 'help-row' }, [
              h('div', { class: 'help-keys' }, s.k.map((x) => h('kbd', {}, x))),
              h('div', { class: 'help-tx' }, s.t),
            ]))),
            h('div', { class: 'cmdk-foot' }, [
              h('span', { class: 'dim' }, '按 ? 或 Esc 关闭'),
            ]),
          ]),
        ]);
      };
    },
  });

  /* ------------------------------------------------------------------
   * 页面内搜索框定位
   * ----------------------------------------------------------------
   * 优先顺序讲究"用户意图"：先找语义明确的搜索框，再退化到通用文本框。
   * 直接抓第一个 input[type=text] 会把光标塞进"数量"字段，
   * 用户敲字直接变成改数据 —— 那是事故，不是快捷键。
   * ------------------------------------------------------------------ */
  const SEARCH_SELECTORS = [
    '[data-search]',
    'input[type="search"]',
    '.filter-bar input[type="text"]',
    '.fb-search input',
    '.tbl-tools input[type="text"]',
    '.search input',
    '.topbar input[type="text"]',
  ];

  function visible(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function focusPageSearch() {
    for (let i = 0; i < SEARCH_SELECTORS.length; i++) {
      const list = document.querySelectorAll(SEARCH_SELECTORS[i]);
      for (let j = 0; j < list.length; j++) {
        if (visible(list[j])) {
          list[j].focus();
          if (list[j].select) { try { list[j].select(); } catch (err) { /* 忽略 */ } }
          return true;
        }
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------
   * 全局快捷键
   * ------------------------------------------------------------------
   * 三条纪律（否则快捷键会变成"打字时乱跳页面"的元凶）：
   *   ① 带修饰键的组合优先处理，不参与后面的单键判定；
   *   ② 焦点在输入框 / 可编辑区时，**单键一律不劫持**；
   *   ③ 面板或帮助浮层打开时，单键交给浮层自己处理。
   * ------------------------------------------------------------------ */
  function onKeydown(e) {
    const cmdK = (e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k';
    if (cmdK) {
      e.preventDefault();
      if (helpOpen.value) helpOpen.value = false;
      togglePalette();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (open.value) return;   // 面板打开时按键归面板内部

    if (helpOpen.value) {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); helpOpen.value = false; }
      return;
    }

    if (App.ux && App.ux.isTyping && App.ux.isTyping()) return;

    if (e.key === '/') {
      e.preventDefault();
      if (!focusPageSearch()) openPalette();
      return;
    }
    if (e.key === '?') {
      e.preventDefault();
      helpOpen.value = true;
    }
  }

  document.addEventListener('keydown', onKeydown, true);

  App.CmdPalette = CmdPalette;
  App.ShortcutHelp = ShortcutHelp;
  App.palette = { open, openPalette, closePalette, togglePalette, helpOpen, toggleHelp };
})();
