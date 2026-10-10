/* =====================================================================
   应用外壳：路由表 / 侧边导航 / 顶栏 / 链上存证核验弹窗 / 404
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;
  const Router = App.Router;
  const PUBLIC_PREFIX = ['/login', '/screen', '/explorer', '/notice'];

  /* ==================================================================
   * 路由表
   * ================================================================== */
  const ROUTES = [
    ['/', 'page-home'],
    ['/login', 'page-login'],
    ['/screen', 'page-screen'],
    ['/explorer', 'page-explorer'],
    ['/explorer/block/:index', 'page-block-detail'],
    ['/explorer/tx/:txId', 'page-tx-detail'],
    ['/notice/:id', 'page-notice'],
    ['/ent/overview', 'page-ent-overview'],
    ['/ent/reports', 'page-ent-reports'],
    ['/ent/quota', 'page-ent-quota'],
    ['/ent/trade', 'page-ent-trade'],
    ['/ent/analytics', 'page-ent-analytics'],
    ['/ent/wallet', 'page-ent-wallet'],
    ['/ent/notices', 'page-ent-notices'],
    ['/ver/overview', 'page-ver-overview'],
    ['/ver/tasks', 'page-ver-tasks'],
    ['/ver/reports', 'page-ver-reports'],
    ['/ver/wallet', 'page-ver-wallet'],
    ['/ver/notices', 'page-ver-notices'],
    ['/reg/overview', 'page-reg-overview'],
    ['/reg/enterprises', 'page-reg-enterprises'],
    ['/reg/allocations', 'page-reg-allocations'],
    ['/reg/trades', 'page-reg-trades'],
    ['/reg/alerts', 'page-reg-alerts'],
    ['/reg/stats', 'page-reg-stats'],
    ['/reg/logs', 'page-reg-logs'],
    ['/reg/system', 'page-reg-system'],
    ['/reg/consortium', 'page-consortium'],
    ['/reg/dynamic', 'page-dynamic'],
    ['/reg/credit', 'page-credit'],
    ['/reg/notices', 'page-reg-notices'],
    ['/ent/dynamic', 'page-dynamic'],
    ['/ent/credit', 'page-credit'],
  ];
  ROUTES.forEach(([p, v]) => App.define(p, v));

  const ROLE_HOME = { ENTERPRISE: '/ent/overview', VERIFIER: '/ver/overview', REGULATOR: '/reg/overview', ADMIN: '/reg/overview' };
  const ROLE_PREFIX = { ENTERPRISE: '/ent', VERIFIER: '/ver', REGULATOR: '/reg', ADMIN: '/reg' };

  /* ==================================================================
   * 菜单
   * ================================================================== */
  const MENUS = {
    ENTERPRISE: [
      { group: '我的碳账本', items: [
        { path: '/ent/overview', icon: 'dash', label: '企业总览' },
        { path: '/ent/reports', icon: 'report', label: '碳排放上报' },
        { path: '/ent/dynamic', icon: 'leaf', label: '动态核算' },
        { path: '/ent/quota', icon: 'coin', label: '碳配额账户' },
      ] },
      { group: '碳资产运营', items: [
        { path: '/ent/trade', icon: 'trade', label: '碳配额交易' },
        { path: '/ent/credit', icon: 'leaf', label: '碳信用与抵销' },
        { path: '/ent/analytics', icon: 'chart', label: '数据分析' },
        { path: '/ent/wallet', icon: 'wallet', label: '链上身份' },
      ] },
      { group: '信息服务', items: [
        { path: '/ent/notices', icon: 'book', label: '通知公告' },
        { path: '/explorer', icon: 'block', label: '区块链浏览器' },
        { path: '/screen', icon: 'globe', label: '公示大屏' },
      ] },
    ],
    VERIFIER: [
      { group: '核查作业', items: [
        { path: '/ver/overview', icon: 'dash', label: '机构总览' },
        { path: '/ver/tasks', icon: 'verify', label: '核查任务' },
        { path: '/ver/reports', icon: 'report', label: '核查报告台账' },
      ] },
      { group: '信息服务', items: [
        { path: '/ver/wallet', icon: 'wallet', label: '机构链上身份' },
        { path: '/ver/notices', icon: 'book', label: '通知公告' },
        { path: '/explorer', icon: 'block', label: '区块链浏览器' },
      ] },
    ],
    REGULATOR: [
      { group: '监管驾驶', items: [
        { path: '/reg/overview', icon: 'dash', label: '监管驾驶舱' },
        { path: '/reg/stats', icon: 'chart', label: '统计分析' },
      ] },
      { group: '业务监管', items: [
        { path: '/reg/enterprises', icon: 'factory', label: '控排企业名录' },
        { path: '/reg/allocations', icon: 'coin', label: '配额分配管理' },
        { path: '/reg/trades', icon: 'trade', label: '碳市场交易监管' },
        { path: '/reg/dynamic', icon: 'leaf', label: '动态核算监管' },
        { path: '/reg/credit', icon: 'coin', label: '碳资产总览' },
        { path: '/reg/alerts', icon: 'alert', label: '预警与风险处置' },
      ] },
      { group: '系统治理', items: [
        { path: '/reg/consortium', icon: 'chain', label: '联盟链治理' },
        { path: '/reg/notices', icon: 'book', label: '通知公告管理' },
        { path: '/reg/logs', icon: 'shield', label: '操作审计日志' },
        { path: '/reg/system', icon: 'db', label: '系统与链自检' },
        { path: '/explorer', icon: 'block', label: '区块链浏览器' },
      ] },
    ],
  };
  MENUS.ADMIN = MENUS.REGULATOR;

  const CRUMB = {
    '/ent/overview': ['企业端', '企业总览'], '/ent/reports': ['企业端', '碳排放上报'],
    '/ent/quota': ['企业端', '碳配额账户'], '/ent/trade': ['企业端', '碳配额交易'],
    '/ent/analytics': ['企业端', '数据分析'], '/ent/wallet': ['企业端', '链上身份'],
    '/ent/dynamic': ['企业端', '动态核算'],
    '/ent/credit': ['企业端', '碳信用与抵销'],
    '/ent/notices': ['企业端', '通知公告'],
    '/ver/overview': ['核查机构端', '机构总览'], '/ver/tasks': ['核查机构端', '核查任务'],
    '/ver/reports': ['核查机构端', '核查报告台账'], '/ver/wallet': ['核查机构端', '机构链上身份'],
    '/ver/notices': ['核查机构端', '通知公告'],
    '/reg/overview': ['监管端', '监管驾驶舱'], '/reg/enterprises': ['监管端', '控排企业名录'],
    '/reg/allocations': ['监管端', '配额分配管理'], '/reg/trades': ['监管端', '碳市场交易监管'],
    '/reg/alerts': ['监管端', '预警与风险处置'], '/reg/stats': ['监管端', '统计分析'],
    '/reg/logs': ['监管端', '操作审计日志'], '/reg/system': ['监管端', '系统与链自检'],
    '/reg/consortium': ['监管端', '联盟链治理'], '/reg/dynamic': ['监管端', '动态核算监管'],
    '/reg/credit': ['监管端', '碳资产总览'],
    '/reg/notices': ['监管端', '通知公告管理'],
    '/explorer': ['公开', '区块链浏览器'], '/screen': ['公开', '数据公示大屏'],
    '/login': ['公开', '登录'],
  };

  /* ==================================================================
   * 链上存证核验弹窗（全局复用）
   * ================================================================== */
  const chainProof = reactive({ show: false, loading: false, title: '', data: null, error: '' });
  App.chainProof = chainProof;
  App.showChainProof = async function (title, apiPath) {
    chainProof.show = true; chainProof.loading = true; chainProof.title = title; chainProof.data = null; chainProof.error = '';
    try {
      chainProof.data = await App.API.request('GET', apiPath, null, { noAuth: !App.Store.token });
    } catch (e) { chainProof.error = e.message; }
    finally { chainProof.loading = false; }
  };

  const ChainProofModal = defineComponent({
    name: 'chain-proof-modal',
    setup() {
      return () => h('x-modal', {
        modelValue: chainProof.show,
        title: '链上存证核验 · ' + chainProof.title,
        width: '860px',
        'onUpdate:modelValue': (v) => { chainProof.show = v; },
      }, {
        default: () => {
          if (chainProof.loading) return h('div', Array.from({ length: 5 }).map(() => h('div', { class: 'skel', style: 'height:40px;margin-bottom:10px' })));
          if (chainProof.error) return h('div', { class: 'alertbar err' }, [h('x-icon', { name: 'alert', size: 15 }), chainProof.error]);
          const d = chainProof.data;
          if (!d) return null;
          const v = d.verify || {}, m = d.merkle || {}, b = d.block || {}, t = d.tx || {};

          return h('div', {}, [
            h('div', { class: 'flex gap-12 wrap mb-16' }, [
              v.signatureValid !== undefined && h('x-readout', { pass: v.signatureValid, label: 'ECDSA 数字签名验签', detail: v.signatureValid ? '验签通过' : '验签失败' }),
              v.dataIntact !== undefined && h('x-readout', { pass: v.dataIntact, label: '存证数据摘要比对', detail: v.dataIntact ? '一字未改' : '数据已变动' }),
              v.dbMatchesSnapshot !== undefined && h('x-readout', { pass: v.dbMatchesSnapshot, label: '链下业务库与链上快照一致', detail: v.dbMatchesSnapshot ? '完全一致' : '存在差异' }),
              v.sealMatches !== undefined && h('x-readout', { pass: v.sealMatches, label: '核查报告电子签章复核', detail: v.sealMatches ? '签章有效' : '签章失效' }),
              m.rootMatches !== undefined && h('x-readout', { pass: m.rootMatches, label: 'Merkle 根与区块头一致', detail: m.rootMatches ? '一致' : '不一致' }),
            ]),

            h('div', { class: 'grid g2 mb-16' }, [
              h('x-card', { title: '存证交易' }, {
                default: () => h('dl', { class: 'kv', style: 'grid-template-columns:96px 1fr' }, [
                  h('dt', {}, '交易号'), h('dd', { class: 'hashbox' }, [h('b', {}, t.txId || '-')]),
                  h('dt', {}, '发起地址'), h('dd', { class: 'mono tiny' }, t.from || '-'),
                  h('dt', {}, '接收地址'), h('dd', { class: 'mono tiny' }, t.to || '-'),
                  h('dt', {}, '数据摘要'), h('dd', { class: 'hashbox' }, t.payloadHash || '-'),
                  h('dt', {}, '发起时间'), h('dd', {}, App.fmt.dt(t.createdAt)),
                ]),
              }),
              h('x-card', { title: '所在区块' }, {
                default: () => h('dl', { class: 'kv', style: 'grid-template-columns:96px 1fr' }, [
                  h('dt', {}, '区块高度'), h('dd', {}, [h('x-chainbadge', { block: b.index, hash: b.hash, label: '点击复制区块哈希' })]),
                  h('dt', {}, '区块哈希'), h('dd', { class: 'hashbox' }, [h('b', {}, b.hash || '-')]),
                  h('dt', {}, '前向哈希'), h('dd', { class: 'hashbox' }, App.fmt.short(b.prevHash, 30)),
                  h('dt', {}, 'Merkle 根'), h('dd', { class: 'hashbox' }, b.merkleRoot || '-'),
                  h('dt', {}, 'nonce / 难度'), h('dd', { class: 'mono' }, `${b.nonce} / ${b.difficulty}`),
                  h('dt', {}, '出块时间'), h('dd', {}, App.fmt.dt(b.blockTime)),
                  h('dt', {}, '出块节点'), h('dd', { class: 'mono' }, b.miner || '-'),
                ]),
              }),
            ]),

            h('x-card', { title: 'Merkle 存在性证明路径', sub: '从本笔交易的哈希出发，逐层与兄弟节点哈希合并，最终应得到区块头中的 Merkle 根' }, {
              default: () => h('div', { class: 'col gap-6' }, (m.path || []).length
                ? m.path.map((p, i) => h('div', { class: 'readout' }, [
                  h('span', { class: 'flag', style: 'background:rgba(245,165,36,.16);color:#fcd34d' }, 'L' + (i + 1)),
                  h('span', { class: 'k' }, p.position === 'left' ? '兄弟在左' : '兄弟在右'),
                  h('span', { class: 'mono tiny', style: 'margin-left:auto;color:var(--tx-3)' }, App.fmt.short(p.hash, 12)),
                ]))
                : h('div', { class: 'alertbar info' }, [
                  h('x-icon', { name: 'info', size: 15 }),
                  m.leafIndex === 0 && m.root === m.leafHash
                    ? '该交易所在区块仅此一笔交易，Merkle 根即本笔交易哈希（单叶场景，无需兄弟节点即可自证）。'
                    : '该交易所在区块的证明路径数据缺失，请检查链上数据结构。',
                ])),
            }),

            v.snapshot && h('x-card', { title: '链上存证的业务数据快照', class: 'mt-16' }, {
              default: () => h('pre', { class: 'mono-pre' }, JSON.stringify(v.snapshot, null, 2)),
            }),
          ]);
        },
        footer: () => [
          h('button', { class: 'btn', onClick: () => { chainProof.show = false; } }, '关闭'),
          chainProof.data && chainProof.data.tx && chainProof.data.tx.txId
            ? h('button', { class: 'btn chain', onClick: () => { chainProof.show = false; App.go('/explorer/tx/' + chainProof.data.tx.txId); } }, [h('x-icon', { name: 'block', size: 15 }), '在浏览器中打开'])
            : null,
        ],
      });
    },
  });

  /* ==================================================================
   * 首页跳转
   * ================================================================== */
  const PageHome = defineComponent({
    name: 'page-home',
    setup() {
      onMounted(() => { App.go(App.Store.user ? (ROLE_HOME[App.Store.user.role] || '/screen') : '/screen'); });
      return () => h('div', { class: 'boot' }, [h('div', { class: 'boot-chain' }, [h('span'), h('span'), h('span'), h('span')]), h('p', {}, '正在跳转…')]);
    },
  });

  /* ==================================================================
   * 404
   * ================================================================== */
  const Page404 = defineComponent({
    name: 'page-404',
    setup() {
      return () => h('div', { class: 'boot' }, [
        h('h1', { style: 'font-size:60px;font-family:var(--mono);color:var(--carbon-l)' }, '404'),
        h('p', { class: 'muted' }, '页面不存在或已被移动'),
        h('div', { class: 'flex gap-8 mt-16' }, [
          h('button', { class: 'btn', onClick: () => App.go('/screen') }, '返回公示大屏'),
          h('button', { class: 'btn primary', onClick: () => App.go(App.Store.user ? ROLE_HOME[App.Store.user.role] : '/login') }, '回到首页'),
        ]),
      ]);
    },
  });

  /* ==================================================================
   * 根组件
   * ================================================================== */
  const Root = defineComponent({
    name: 'app-root',
    setup() {
      const clock = ref('');
      let chainTimer = null, clockTimer = null;

      const isPublicRoute = computed(() => {
        if (!App.Store.user) return true;
        return PUBLIC_PREFIX.some((p) => Router.path === p || Router.path.startsWith(p + '/'));
      });

      const menus = computed(() => (App.Store.user ? (MENUS[App.Store.user.role] || []) : []));
      const crumb = computed(() => {
        if (Router.path.startsWith('/explorer/block')) return ['公开', '区块详情'];
        if (Router.path.startsWith('/explorer/tx')) return ['公开', '交易详情'];
        if (Router.path.startsWith('/notice/')) return ['公开', '公告详情'];
        return CRUMB[Router.path] || ['', Router.path];
      });
      const title = computed(() => (crumb.value[1] || '碳链通'));
      const view = computed(() => App.views[Router.view] || Page404);

      /** 把路由参数（:index / :txId / :id）作为 props 传给视图组件；
       *  key 用完整路径，保证从「区块 A」跳到「区块 B」时组件重新挂载并重新拉数。 */
      function viewProps() { return Object.assign({ key: Router.path }, Router.params); }

      /* 路由守卫 */
      function guard() {
        if (!App.Store.user) return;
        const prefix = ROLE_PREFIX[App.Store.user.role];
        const publicish = ['/login', '/screen', '/explorer', '/notice', '/'];
        if (publicish.some((p) => Router.path === p || Router.path.startsWith(p + '/'))) return;
        if (!Router.path.startsWith(prefix)) {
          App.notify.warn('当前身份无权访问该模块，已返回你的工作台');
          App.go(ROLE_HOME[App.Store.user.role] || '/screen');
        }
      }
      Vue.watch(() => Router.path, guard);

      async function refreshChain() {
        try { App.Store.chain = await App.API.request('GET', '/chain/stats', null, { noAuth: true }); } catch (e) { /* ignore */ }
      }

      onMounted(() => {
        App.resolve();
        guard();
        refreshChain();
        chainTimer = setInterval(refreshChain, 30000);
        const t = () => {
          const d = new Date();
          const p = (x) => String(x).padStart(2, '0');
          clock.value = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        };
        t(); clockTimer = setInterval(t, 1000);
      });
      onUnmounted(() => { clearInterval(chainTimer); clearInterval(clockTimer); });

      function logout() {
        App.API.post('/auth/logout').catch(() => {});
        setSession('', null);
        App.notify.info('已退出登录');
        App.go('/screen');
      }

      return () => h('div', {}, [
        /* 公开布局 */
        isPublicRoute.value
          ? h('div', {}, [
            h('div', { class: 'topbar', style: 'position:sticky' }, [
              h('div', { class: 'flex gap-10', style: 'cursor:pointer', onClick: () => App.go('/screen') }, [
                h('div', { class: 'brand-mark', style: 'width:30px;height:30px;flex:0 0 30px;border-radius:9px' }, [h('x-icon', { name: 'leaf', size: 17 })]),
                h('b', { style: 'color:var(--tx-0);font-size:14.5px' }, '碳链通'),
              ]),
              h('div', { class: 'flex gap-6', style: 'margin-left:18px' }, [
                h('button', { class: ['btn sm', Router.path === '/screen' && 'primary'], onClick: () => App.go('/screen') }, '公示大屏'),
                h('button', { class: ['btn sm', Router.path.startsWith('/explorer') && 'primary'], onClick: () => App.go('/explorer') }, '区块链浏览器'),
              ]),
              h('div', { class: 'topbar-right' }, [
                h('span', { class: 'chip live', title: '链尾哈希 ' + App.Store.chain.tipHash }, [
                  h('x-icon', { name: 'chain', size: 14 }),
                  `高度 ${App.Store.chain.height || '-'} · ${App.fmt.num(App.Store.chain.totalTxs || 0)} 笔存证`,
                ]),
                h('span', { class: 'chip mono' }, clock.value),
                App.Store.user
                  ? h('button', { class: 'btn sm', onClick: () => App.go(ROLE_HOME[App.Store.user.role]) }, [h('x-icon', { name: 'dash', size: 14 }), '进入工作台'])
                  : h('button', { class: 'btn sm primary', onClick: () => App.go('/login') }, [h('x-icon', { name: 'lock', size: 14 }), '登录平台']),
              ]),
            ]),
            h('div', { style: 'max-width:1680px;margin:0 auto;padding:20px 24px 48px' }, [h(view.value, viewProps())]),
          ])

          /* 工作台布局 */
          : h('div', { class: 'shell' }, [
            h('aside', { class: 'sidebar' }, [
              h('div', { class: 'brand' }, [
                h('div', { class: 'brand-mark' }, [h('x-icon', { name: 'leaf', size: 21 })]),
                h('div', { class: 'brand-txt' }, [h('strong', {}, '碳链通'), h('span', {}, 'CarbonChain Hub')]),
              ]),
              h('nav', { class: 'nav' }, menus.value.map((g) => h('div', {}, [
                h('div', { class: 'nav-group' }, g.group),
                ...g.items.map((it) => h('button', {
                  class: ['nav-item', Router.path === it.path && 'active'],
                  onClick: () => App.go(it.path),
                }, [h('x-icon', { name: it.icon, size: 16 }), h('span', {}, it.label)])),
              ]))),
              h('div', { class: 'side-foot' }, [
                h('div', { class: 'node-card' }, [
                  h('div', { class: 'flex gap-8', style: 'align-items:center' }, [
                    h('span', { class: 'dot' }),
                    h('span', { class: 'tiny', style: 'color:var(--tx-1)' }, '链节点运行中'),
                  ]),
                  h('div', { class: 'tiny dim mt-8 mono' }, `H=${App.Store.chain.height || '-'} · 难度 ${App.Store.chain.difficulty || '-'}`),
                  h('div', { class: 'tiny dim mono' }, `出块均值 ${App.Store.chain.avgMineTime || '-'} ms`),
                  h('div', { class: 'tiny dim mono ellipsis', title: App.Store.chain.tipHash }, App.fmt.short(App.Store.chain.tipHash || '-', 8)),
                ]),
              ]),
            ]),

            h('div', { class: 'main' }, [
              h('header', { class: 'topbar' }, [
                h('div', { class: 'crumb' }, [h('span', {}, crumb.value[0] + ' / '), h('b', {}, crumb.value[1] || '')]),
                h('div', { class: 'topbar-right' }, [
                  h('span', { class: 'chip live' }, [h('x-icon', { name: 'chain', size: 14 }), `链高度 ${App.Store.chain.height || '-'}`]),
                  h('span', { class: 'chip mono' }, clock.value),
                  h('div', { class: 'userbox' }, [
                    h('div', { class: 'avatar' }, (App.Store.user.realName || App.Store.user.username || '?').slice(0, 1)),
                    h('div', { class: 'col', style: 'line-height:1.25' }, [
                      h('span', { style: 'font-size:12.8px;color:var(--tx-0)' }, App.Store.user.realName || App.Store.user.username),
                      h('span', { class: 'tiny dim' }, (App.DICT.role[App.Store.user.role] || '') + (App.Store.user.orgName ? ' · ' + App.Store.user.orgName.slice(0, 14) : '')),
                    ]),
                  ]),
                  h('button', { class: 'btn sm ghost', title: '退出登录', onClick: logout }, [h('x-icon', { name: 'logout', size: 15 })]),
                ]),
              ]),
              h('main', { class: 'content' }, [h(view.value, viewProps())]),
            ]),
          ]),

        h(ChainProofModal),
        h('x-toasts'),
      ]);
    },
  });

  /* ==================================================================
   * 挂载
   * ================================================================== */
  App.views['page-home'] = PageHome;
  App.views['page-404'] = Page404;

  const app = Vue.createApp(Root);
  // 注册全局组件
  Object.keys(App.components || {}).forEach((k) => app.component(k, App.components[k]));
  // 注册视图组件（按需渲染，无需提前注册也可，因为用 :is 直接传组件对象）
  App.resolve();
  app.mount('#app');
  window.__app = app;
})();
