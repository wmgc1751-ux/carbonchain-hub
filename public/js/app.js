/* =====================================================================
   应用外壳：路由表 / 侧边导航 / 顶栏 / 链上存证核验弹窗 / 404
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;
  const Router = App.Router;
  /* ==================================================================
   * 路由访问模型（单一来源）
   * ------------------------------------------------------------------
   * 这份常量同时被「公开布局判定」与「路由守卫」引用，新增开放页只改这一处。
   *
   * 历史缺陷（2026-10-11 修复）：守卫曾内联维护一份独立的 publicish 列表，
   * 且漏掉了 /matrix。结果 7 个演示账号在侧边栏点击「碳账本总览」时，
   * 布局按公开路由渲染（侧边栏消失），守卫却判定越权并踢回工作台 —— 两个
   * 列表不一致造成的死路。教训：权限白名单必须只有一个来源。
   * ================================================================== */

  /** 开放路由：不限定角色，任何身份（含未登录）均可访问。
   *  /mrv/factor 是**排放因子台账**，纯公开数据 —— 因子必须可被任何人（含
   *  第三方核查机构、进口商、监管方）复核，这是「核算可验证」的前提。
   *  要求登录才能查因子，等于要求"先相信再验证"。 */
  const OPEN_ROUTES = ['/login', '/screen', '/explorer', '/verify', '/cems', '/matrix', '/notice', '/', '/mrv/factor', '/zk',
    /* 真实数据层：公开数据集 + 实时运转状态，刻意不设登录门槛。
     * 这不是"偷懒少写鉴权"，而是一个设计选择：可核验性 ≠ 权限。 */
    '/real', '/twin'];
  /** 全屏独立页：不套应用外壳（无侧边栏），大盘 / 大屏类页面走公开布局渲染 */
  const STANDALONE_PREFIX = ['/login', '/screen', '/explorer', '/verify', '/cems', '/matrix', '/notice'];
  /** 额外角色授权：路径不落在角色前缀下、但确属该角色职能的路由。
   *  /ops 生产运维监控挂在监管端菜单的「系统治理」分组，而 REGULATOR 的
   *  前缀是 /reg，不加这条会被守卫误判为越权。
   *  /gov 是**监管与管理共用**的治理看板（源端接入 / 数据质量 / 审计链），
   *  两个角色的职能都需要，故一并授给两者 —— 避免复制两份页面。 */
  const EXTRA_ALLOW = {
    /* ⚠ /mrv/* 是**跨角色共用**的 MRV 作业流（同一套页面，不同角色看不同数据范围）。
     *   它不落在任何角色前缀下，若不加进 EXTRA_ALLOW，守卫会把企业端
     *   访问 /mrv/activity 直接重定向回 /ent/overview —— 表现为"点了菜单没反应"。
     *   实测发现：/mrv/activity 打开后 hash 变成 #/ent/overview，
     *   但页面能显示内容（因为 /ent/overview 也是有效页），所以肉眼很难发现。
     *   这类"静默重定向"必须靠 hash 判据才能查出。 */
    REGULATOR: ['/ops', '/gov', '/keys', '/mrv'],
    TRADER: ['/ent/credit'],
    ENTERPRISE: ['/mrv'],
    VERIFIER: ['/mrv'],
    /* ADMIN 原本就有 /reg/consortium 等授权，此处仅追加 /mrv —— 不能把原有项冲掉。
     * 早先编辑时误删了 ADMIN 原有清单，语法检查会通过（对象重复键后者覆盖前者），
     * 但运行时会丢掉 /reg/consortium 权限，导致管理端点联盟链治理被弹回。 */
    ADMIN: ['/ops', '/gov', '/keys', '/reg/consortium', '/reg/system',
      '/reg/uncertainty', '/reg/cbam', '/reg/greenpower', '/reg/dual-report',
      /* ⚠ /reg/integrity（内控治理）在 MENUS.ADMIN 里是一个可见菜单项，
       *   但此前未加入本清单 → 点击后 guard() 判定越权，静默弹回原页，
       *   表现为"菜单点了没反应"。2026-10-29 巡检（console-audit 101 页）
       *   报的唯一 fatal 就是它。菜单与守卫必须同源，此处补齐。 */
      '/reg/integrity',
      '/mrv'],
  };

  /** 路径是否命中前缀列表（支持 `/a` 与 `/a/xxx`；`/` 只做精确匹配，避免通配全站） */
  function matchPrefix(list, p) {
    return list.some((x) => (x === '/' ? p === '/' : (p === x || p.startsWith(x + '/'))));
  }

  /* ==================================================================
   * 路由表
   * ================================================================== */
  const ROUTES = [
    ['/', 'page-home'],
    ['/login', 'page-login'],
    ['/screen', 'page-screen'],
    ['/explorer', 'page-explorer'],
    ['/verify', 'page-verify'],
    ['/cems', 'page-cems'],
    ['/matrix', 'page-matrix'],
    /* 3D 数字孪生：碳账本的空间视图。公开可访问（与 /matrix 同级）——
     * 它展示的是厂区布局与链上存证，不含任何企业敏感数据。 */
    ['/twin', 'page-twin'],
    ['/ops', 'page-ops'],
    ['/gov/iot', 'page-iot-devices'],
    ['/gov/quality', 'page-data-quality'],
    ['/gov/audit-chain', 'page-audit-chain'],
    ['/explorer/block/:index', 'page-block-detail'],
    ['/explorer/tx/:txId', 'page-tx-detail'],
    ['/notice', 'page-notice-list'],
    ['/notice/:id', 'page-notice'],
    ['/ent/overview', 'page-ent-overview'],
    ['/ent/reports', 'page-ent-reports'],
    ['/ent/quota', 'page-ent-quota'],
    ['/ent/analytics', 'page-ent-analytics'],
    ['/ent/wallet', 'page-ent-wallet'],
    ['/ent/mandate', 'page-ent-mandate'],
    ['/ent/members', 'page-ent-members'],
    ['/ent/disclosure', 'page-ent-disclosure'],
    ['/ent/derivation', 'page-derivation'],
    ['/reg/derivation', 'page-derivation'],
    ['/disclosure', 'page-public-disclosure'],
    ['/reg/integrity', 'page-reg-integrity'],
    ['/reg/mandates', 'page-reg-mandates'],
    ['/ent/notices', 'page-ent-notices'],
    ['/ent/predict', 'page-ent-predict'],
    ['/ver/overview', 'page-ver-overview'],
    ['/ver/tasks', 'page-ver-tasks'],
    ['/ver/reports', 'page-ver-reports'],
    ['/ver/wallet', 'page-ver-wallet'],
    ['/ver/notices', 'page-ver-notices'],
    ['/reg/overview', 'page-reg-overview'],
    ['/reg/enterprises', 'page-reg-enterprises'],
    ['/reg/allocations', 'page-reg-allocations'],
    ['/reg/alerts', 'page-reg-alerts'],
    ['/reg/stats', 'page-reg-stats'],
    ['/reg/logs', 'page-reg-logs'],
    ['/reg/system', 'page-reg-system'],
    ['/reg/consortium', 'page-consortium'],
    ['/reg/dynamic', 'page-dynamic'],
    ['/reg/credit', 'page-credit'],
    ['/reg/trades', 'page-reg-trades'],
    ['/reg/notices', 'page-reg-notices'],
    ['/ent/dynamic', 'page-dynamic'],
    ['/ent/credit', 'page-credit'],
    ['/trade/market', 'page-trade-market'],
    ['/trade/orders', 'page-trade-orders'],
    ['/trade/account', 'page-trade-account'],
    ['/trade/deals', 'page-trade-deals'],
    ['/trade/offset', 'page-trade-offset'],
    ['/admin/overview', 'page-admin-overview'],
    ['/admin/factors', 'page-admin-factors'],
    ['/admin/users', 'page-admin-users'],
    ['/admin/reconcile', 'page-admin-reconcile'],
    /* 第 2 轮（WP4 核算升级 / WP2 密码学生产化 / WP5 国际互认） */
    ['/keys', 'page-keymgmt'],
    ['/ent/uncertainty', 'page-ent-uncertainty'],
    ['/reg/uncertainty', 'page-reg-uncertainty'],
    ['/ent/cbam', 'page-cbam'],
    ['/reg/cbam', 'page-cbam'],
    ['/ent/greenpower', 'page-greenpower'],
    ['/reg/greenpower', 'page-greenpower'],
    ['/ent/dual-report', 'page-dual-report'],
    ['/reg/dual-report', 'page-dual-report'],
    /* 第 3 轮（MRV 生产作业流，2026-10-24）
     * 这一组是「能干活」的页面，不是看板：
     *   activity   活动数据台账（核算的唯一输入）
     *   calc       核算作业（正向核算 + 可复算校验）
     *   factor     因子台账（公开，三要素可复算）
     *   compliance 履约清缴（碳市场闭环）
     *   cbam       CBAM 证书（出口合规的商业核心） */
    ['/mrv/activity', 'page-mrv-activity'],
    ['/mrv/calc', 'page-mrv-calc'],
    ['/mrv/factor', 'page-mrv-factor'],
    ['/mrv/compliance', 'page-mrv-compliance'],
    ['/ent/mrv/activity', 'page-mrv-activity'],
    ['/ent/mrv/calc', 'page-mrv-calc'],
    ['/ent/mrv/compliance', 'page-mrv-compliance'],
    ['/ent/mrv/cbam', 'page-mrv-cbam'],
    ['/ver/mrv/activity', 'page-mrv-activity'],
    ['/ver/mrv/calc', 'page-mrv-calc'],
    ['/reg/mrv/activity', 'page-mrv-activity'],
    ['/reg/mrv/calc', 'page-mrv-calc'],
    ['/reg/mrv/factor', 'page-mrv-factor'],
    ['/reg/mrv/compliance', 'page-mrv-compliance'],
    ['/admin/mrv/factor', 'page-mrv-factor'],
    /* 零知识碳核算（隐私保护型 MRV）—— 企业不交原始数据也能被监管验证 */
    ['/zk', 'page-zk'],
    ['/ent/zk', 'page-ent-zk'],
    ['/reg/zk', 'page-reg-zk'],
    ['/admin/zk', 'page-reg-zk'],
    /* 真实数据层 + 实时运转（2026-10-24 第 4 轮）
     * 这一组全部是**公开路由**：数据源本身是政府公开信息（生态环境部公开因子 /
     * 省级在线监测公开平台 / 交易所行情），锁在登录后会让第三方无法核验平台的
     * 真实性主张。需要鉴权的是企业填报的活动数据与核算结果，那些在 /mrv/* 下。
     *
     * ⚠ 2026-10-30 收敛：境外数据源（Climate TRACE / EPA GHGRP / 世界银行 / OWID）
     *     下线并清库，六条路由一度随之摘除。
     * ⚠ 2026-10-31 重建：五条路由以国内真实数据恢复注册 —— 设施=4 家保定焚烧企业，
     *     污染物=河北省公开系统小时实测（REAL），CO₂=活动水平法核算（DERIVED，可复算），
     *     宏观=区域电网因子（生态环境部发布）。全部端点自带口径与边界声明。
     *     详见 docs/国外数据下线报告-20261030.md 与 tools/fix-round2-20261031.cjs。 */
    ['/real', 'page-real-overview'],
    ['/real/facilities', 'page-real-facilities'],
    ['/real/facility/:id', 'page-real-facility'],
    ['/real/benchmarks', 'page-real-benchmarks'],
    ['/real/trend', 'page-real-trend'],
    ['/real/macro', 'page-real-macro'],
    ['/real/truth', 'page-real-truth'],
    ['/real/enterprise-cems', 'page-real-ent-cems'],
  ];
  ROUTES.forEach(([p, v]) => App.define(p, v));

  const ROLE_HOME = { ENTERPRISE: '/ent/overview', VERIFIER: '/ver/overview', REGULATOR: '/reg/overview', TRADER: '/trade/market', ADMIN: '/admin/overview' };
  const ROLE_PREFIX = { ENTERPRISE: '/ent', VERIFIER: '/ver', REGULATOR: '/reg', TRADER: '/trade', ADMIN: '/admin' };

  /** 该角色能否进入该路径 —— 守卫与巡检脚本共用的唯一判据（纯函数） */
  function canEnter(role, p) {
    if (matchPrefix(OPEN_ROUTES, p)) return true;
    const prefix = ROLE_PREFIX[role];
    if (prefix && (p === prefix || p.startsWith(prefix + '/'))) return true;
    return matchPrefix(EXTRA_ALLOW[role] || [], p);
  }

  /* ==================================================================
   * 菜单
   * ================================================================== */
  const MENUS = {
    ENTERPRISE: [
      /* 2026-10-30 IA 收敛（37→33 项）：
       * zk 双入口合并为 /ent/zk 一个（/zk 保留为页内"原理演示"按钮可达）；
       * 链上身份退出导航（企业总览首卡已有"链上身份详情"直达）；
       * 动态核算归位 MRV 组，与人工"核算作业"相邻，两条核算链路一眼可辨；
       * 碳账本总览（平台层视角）挪去信息服务组并改名"账本全景"。 */
      { group: '核算作业（MRV）', items: [
        { path: '/twin', icon: 'layers', label: '3D 数字孪生' },
        { path: '/mrv/activity', icon: 'report', label: '活动数据台账' },
        { path: '/mrv/calc', icon: 'target', label: '核算作业' },
        { path: '/ent/dynamic', icon: 'leaf', label: '动态核算（自动滚动）' },
        { path: '/mrv/compliance', icon: 'shield', label: '履约与清缴' },
        { path: '/cems', icon: 'factory', label: 'CEMS 实测监控' },
      ] },
      { group: '碳资产管理', items: [
        { path: '/ent/overview', icon: 'dash', label: '企业总览' },
        { path: '/ent/quota', icon: 'coin', label: '碳配额账户' },
        { path: '/ent/credit', icon: 'leaf', label: '碳信用与抵销' },
        { path: '/ent/predict', icon: 'alert', label: '预警中心' },
        { path: '/ent/analytics', icon: 'chart', label: '数据分析' },
        { path: '/ent/mandate', icon: 'shield', label: '代理授权' },
        { path: '/ent/members', icon: 'users', label: '机构账号' },
        { path: '/ent/disclosure', icon: 'globe', label: '公示授权' },
        { path: '/ent/derivation', icon: 'layers', label: '派生核算链' },
      ] },
      { group: '合规与出口', items: [
        { path: '/ent/zk', icon: 'lock', label: '零知识碳核算（隐私承诺）' },
        { path: '/ent/mrv/cbam', icon: 'globe', label: 'CBAM 证书' },
        { path: '/mrv/factor', icon: 'book', label: '排放因子台账' },
        { path: '/ent/uncertainty', icon: 'target', label: '核算不确定度' },
        { path: '/ent/greenpower', icon: 'leaf', label: '绿电溯源' },
        { path: '/ent/dual-report', icon: 'report', label: '双轨报告' },
        { path: '/ent/reports', icon: 'report', label: '碳排放上报' },
      ] },
      { group: '信息服务', items: [
        { path: '/matrix', icon: 'chart', label: '账本全景' },
        { path: '/ent/notices', icon: 'book', label: '通知公告' },
        { path: '/explorer', icon: 'block', label: '区块链浏览器' },
        { path: '/verify', icon: 'shield', label: '科研验证中心' },
        { path: '/screen', icon: 'globe', label: '公示大屏' },
      ] },
    ],
    VERIFIER: [
      { group: '核查作业', items: [
        { path: '/matrix', icon: 'chart', label: '账本全景' },
        { path: '/ver/overview', icon: 'dash', label: '机构总览' },
        { path: '/ver/tasks', icon: 'verify', label: '核查任务' },
        { path: '/ver/mrv/activity', icon: 'report', label: '审阅活动数据' },
        { path: '/ver/mrv/calc', icon: 'target', label: '复核核算批次' },
        { path: '/ver/reports', icon: 'report', label: '核查报告台账' },
        { path: '/mrv/factor', icon: 'book', label: '排放因子台账' },
        { path: '/zk', icon: 'lock', label: '零知识碳核算' },
      ] },
      { group: '信息服务', items: [
        { path: '/ver/wallet', icon: 'wallet', label: '机构链上身份' },
        { path: '/ver/notices', icon: 'book', label: '通知公告' },
        { path: '/explorer', icon: 'block', label: '区块链浏览器' },
        { path: '/verify', icon: 'shield', label: '科研验证中心' },
      ] },
    ],
    REGULATOR: [
      { group: '监管驾驶', items: [
        { path: '/matrix', icon: 'chart', label: '账本全景' },
        { path: '/reg/overview', icon: 'dash', label: '监管驾驶舱' },
        { path: '/reg/stats', icon: 'chart', label: '统计分析' },
      ] },
      /* 2026-10-29：原「业务监管」18 项平铺，认知负担大。按监管动线重排为
       * 主体与配额 → 数据与核算监管 → 合规与风控 三组（数量不变，只挪分组） */
      { group: '主体与配额', items: [
        { path: '/reg/enterprises', icon: 'factory', label: '控排企业名录' },
        { path: '/reg/allocations', icon: 'coin', label: '配额分配管理' },
        { path: '/reg/credit', icon: 'coin', label: '碳资产总览' },
        { path: '/reg/trades', icon: 'chart', label: '履约流转监管' },
        { path: '/reg/mandates', icon: 'shield', label: '代理授权台账' },
        { path: '/reg/integrity', icon: 'lock', label: '内控治理' },
      ] },
      { group: '数据与核算监管', items: [
        { path: '/reg/mrv/activity', icon: 'report', label: '活动数据监管' },
        { path: '/reg/mrv/calc', icon: 'target', label: '核算批次监管' },
        { path: '/reg/mrv/compliance', icon: 'shield', label: '履约清缴监管' },
        { path: '/reg/mrv/factor', icon: 'book', label: '因子版本监管' },
        { path: '/reg/dynamic', icon: 'leaf', label: '动态核算监管' },
        { path: '/cems', icon: 'factory', label: 'CEMS 实测监管' },
        { path: '/reg/zk', icon: 'lock', label: '零知识验证' },
        { path: '/gov/iot', icon: 'factory', label: '设备接入看板' },
        { path: '/gov/quality', icon: 'shield', label: '数据质量看板' },
        { path: '/reg/derivation', icon: 'layers', label: '派生核算链' },
      ] },
      { group: '合规与风控', items: [
        { path: '/reg/alerts', icon: 'alert', label: '预警与风险处置' },
        { path: '/reg/uncertainty', icon: 'target', label: '不确定度监管' },
        { path: '/reg/cbam', icon: 'globe', label: 'CBAM 申报监管' },
        { path: '/reg/greenpower', icon: 'leaf', label: '绿电溯源监管' },
        { path: '/reg/dual-report', icon: 'report', label: '双轨报告台账' },
      ] },
      { group: '系统治理', items: [
        { path: '/reg/consortium', icon: 'chain', label: '联盟链治理' },
        { path: '/keys', icon: 'key', label: '国密密钥治理' },
        { path: '/gov/audit-chain', icon: 'lock', label: '审计链校验' },
        { path: '/reg/notices', icon: 'book', label: '通知公告管理' },
        { path: '/reg/logs', icon: 'shield', label: '操作审计日志' },
        { path: '/reg/system', icon: 'db', label: '系统与链自检' },
        { path: '/ops', icon: 'chart', label: '生产运维监控' },
        { path: '/explorer', icon: 'block', label: '区块链浏览器' },
        { path: '/verify', icon: 'shield', label: '科研验证中心' },
      ] },
    ],
    TRADER: [
      { group: '配额履约流转', items: [
        { path: '/trade/market', icon: 'chart', label: '市场行情' },
        /* 「成交记录」已并入本页的标签（同一批 trade_deal 不该有两个入口）。
         * /trade/deals 路由保留可达，但侧栏不再占一格。 */
        { path: '/trade/orders', icon: 'coin', label: '挂牌与成交' },
      ] },
      { group: '我的资产', items: [
        { path: '/trade/account', icon: 'wallet', label: '我的账户' },
        { path: '/trade/offset', icon: 'leaf', label: '抵销清缴' },
      ] },
      { group: '信息服务', items: [
        { path: '/explorer', icon: 'block', label: '区块链浏览器' },
        { path: '/screen', icon: 'globe', label: '公示大屏' },
      ] },
    ],
    ADMIN: [
      { group: '平台治理', items: [
        { path: '/admin/overview', icon: 'dash', label: '管理总览' },
        { path: '/reg/consortium', icon: 'chain', label: '联盟链治理' },
        { path: '/keys', icon: 'key', label: '国密密钥治理' },
        { path: '/admin/users', icon: 'shield', label: '用户与权限' },
        { path: '/reg/integrity', icon: 'lock', label: '内控治理' },
      ] },
      { group: '标准与一致性', items: [
        { path: '/admin/factors', icon: 'coin', label: '因子库维护' },
        { path: '/admin/reconcile', icon: 'db', label: '对账中心' },
        { path: '/reg/uncertainty', icon: 'target', label: '不确定度汇总' },
        { path: '/reg/dual-report', icon: 'report', label: '双轨报告台账' },
        { path: '/reg/cbam', icon: 'globe', label: 'CBAM 申报台账' },
        { path: '/reg/greenpower', icon: 'leaf', label: '绿电溯源' },
      ] },
      { group: '运维监控', items: [
        { path: '/reg/system', icon: 'db', label: '系统与链自检' },
        { path: '/gov/iot', icon: 'factory', label: '设备接入看板' },
        { path: '/gov/quality', icon: 'shield', label: '数据质量看板' },
        { path: '/gov/audit-chain', icon: 'lock', label: '审计链校验' },
        { path: '/ops', icon: 'chart', label: '生产运维监控' },
        { path: '/explorer', icon: 'block', label: '区块链浏览器' },
      ] },
    ],
  };

  /* 真实数据层菜单 —— **所有角色共用同一份**。
   *
   * 【为什么不在每个角色里各写一遍】
   * 五个角色各写一份，就有五份会各自漂移的副本。历史上 /matrix 与 /ops
   * 正是因为"菜单一份、守卫另一份"不一致而变成死链。同一功能只允许一个来源。
   *
   * 【为什么它出现在所有角色菜单里，而且未登录也能进】
   * 这一层是**公开可核验数据**：生态环境部公开因子、省级在线监测公开平台报文、
   * 交易所成交行情 —— 全部是政府/交易所公开信息。
   * 监管方要拿它做基准、核查机构要拿它做对照、第三方要拿它做独立复核，
   * 企业自己也该能看见"我的实测数据处在什么水平"。
   * 把它藏在某个角色后面，等于让"可核验"变成"需授权"。 */
  const REAL_MENU_GROUP = {
    group: '真实数据（公开可核验）',
    /* 2026-10-30 大幅收敛：设施台账、行业基准、年度趋势、宏观序列四条已下线，
     * 因为它们的数据源全部来自境外（Climate TRACE / EPA GHGRP / 世行 / OWID）。
     * 剩下的三项都有国内公开来源支撑，可逐条复核。 */
    items: [
      { path: '/real', icon: 'db', label: '真实数据总览' },
      { path: '/real/enterprise-cems', icon: 'factory', label: '真实企业CEMS与核算' },
      { path: '/real/truth', icon: 'shield', label: '数据真实性契约' },
    ],
  };
  Object.keys(MENUS).forEach((role) => {
    /* 插在「信息服务」之前；没有该分组就追加到末尾。
     * 不插在首位：真实数据层是参照与核验，不是角色的主职工作。 */
    const idx = MENUS[role].findIndex((g) => g.group === '信息服务');
    if (idx >= 0) MENUS[role].splice(idx, 0, REAL_MENU_GROUP);
    else MENUS[role].push(REAL_MENU_GROUP);
  });
  /* 路由访问模型对外只读暴露 —— 供 server/scripts/cdp-check.js 用同一套判据穷举断言
     「侧边栏里的每一项、每个角色都进得去」。历史上 /matrix 与 /ops 都是因为
     菜单与守卫两份名单不一致而变成死链，这个断言就是为了让同类缺陷跑不掉。 */
  App.routeAccess = { OPEN_ROUTES, STANDALONE_PREFIX, EXTRA_ALLOW, ROLE_HOME, ROLE_PREFIX, MENUS, ROUTES, canEnter };

  const CRUMB = {
    '/ent/overview': ['企业端', '企业总览'], '/ent/reports': ['企业端', '碳排放上报'],
    '/ent/quota': ['企业端', '碳配额账户'],
    '/ent/analytics': ['企业端', '数据分析'], '/ent/wallet': ['企业端', '链上身份'],
    '/ent/mandate': ['企业端', '代理授权'],
    '/ent/members': ['企业端', '机构账号'],
    '/ent/disclosure': ['企业端', '公示授权'],
    '/ent/derivation': ['企业端', '派生核算链'],
    '/reg/derivation': ['监管端', '派生核算链'],
    '/disclosure': ['信息服务', '信息公示专区'],
    '/reg/integrity': ['监管端', '内控治理'],
    '/reg/mandates': ['监管端', '代理授权台账'],
    '/ent/dynamic': ['企业端', '动态核算'],
    '/ent/credit': ['企业端', '碳信用与抵销'],
    '/ent/predict': ['企业端', '预警中心'],
    '/ent/notices': ['企业端', '通知公告'],
    '/ver/overview': ['核查机构端', '机构总览'], '/ver/tasks': ['核查机构端', '核查任务'],
    '/ver/reports': ['核查机构端', '核查报告台账'], '/ver/wallet': ['核查机构端', '机构链上身份'],
    '/ver/notices': ['核查机构端', '通知公告'],
    '/reg/overview': ['监管端', '监管驾驶舱'], '/reg/enterprises': ['监管端', '控排企业名录'],
    '/reg/allocations': ['监管端', '配额分配管理'],
    '/reg/alerts': ['监管端', '预警与风险处置'], '/reg/stats': ['监管端', '统计分析'],
    '/reg/logs': ['监管端', '操作审计日志'], '/reg/system': ['监管端', '系统与链自检'],
    '/reg/trades': ['监管端', '履约流转监管'],
    '/ops': ['运维', '生产监控中心'],
    '/gov/iot': ['治理', '工业设备接入看板'],
    '/gov/quality': ['治理', '数据质量看板'],
    '/gov/audit-chain': ['治理', '审计日志哈希链校验'],
    '/matrix': ['账本全景', '工业碳资产动态核算可信存证平台'],
    '/twin': ['3D 数字孪生', '本企业厂区 · 卫星实测尺寸与 CEMS 实测联动'],
    '/reg/consortium': ['监管端', '联盟链治理'], '/reg/dynamic': ['监管端', '动态核算监管'],
    '/reg/credit': ['监管端', '碳资产总览'],
    '/reg/notices': ['监管端', '通知公告管理'],
    '/trade/market': ['交易端', '市场行情'], '/trade/orders': ['交易端', '挂牌与成交'],
    '/trade/account': ['交易端', '我的账户'], '/trade/deals': ['交易端', '成交记录'],
    '/trade/offset': ['交易端', '抵销清缴'],
    '/admin/overview': ['管理端', '管理总览'], '/admin/factors': ['管理端', '因子库维护'],
    '/admin/users': ['管理端', '用户与权限'], '/admin/reconcile': ['管理端', '对账中心'],
    '/keys': ['治理', '国密密钥治理'],
    /* 真实数据层（公开可核验） */
    '/real': ['真实数据', '真实数据总览'],
    '/real/facilities': ['真实数据', '真实设施台账'],
    '/real/facility/:id': ['真实数据', '设施详情'],
    '/real/benchmarks': ['真实数据', '行业真实基准'],
    '/real/trend': ['真实数据', '年度真实趋势'],
    '/real/macro': ['真实数据', '区域电网因子'],
    '/real/truth': ['真实数据', '数据真实性契约'],
    '/real/enterprise-cems': ['真实数据', '真实企业CEMS与核算'],
    '/ent/uncertainty': ['企业端', '核算不确定度报告'],
    '/reg/uncertainty': ['监管端', '不确定度监管'],
    '/ent/cbam': ['企业端', 'CBAM 碳关税申报'],
    '/reg/cbam': ['监管端', 'CBAM 申报监管'],
    '/ent/greenpower': ['企业端', '小时级绿电溯源'],
    '/reg/greenpower': ['监管端', '绿电溯源监管'],
    '/ent/dual-report': ['企业端', '双轨报告导出'],
    '/reg/dual-report': ['监管端', '双轨报告台账'],
    '/explorer': ['公开', '区块链浏览器'], '/screen': ['公开', '数据公示大屏'],
    '/verify': ['公开', '科研验证中心'],
    '/cems': ['公开', 'CEMS 实测流监控'],
    '/notice': ['公开', '通知公告'],
    '/login': ['公开', '登录'],
    /* MRV 作业流与零知识系列：这三个前缀此前没有中文名，
     * 表现为浏览器标题与面包屑直接裸露路由（"/ mrv/calc"）。
     * 2026-10-29 巡检：/zk、/mrv/activity、/mrv/calc、/mrv/factor、
     * /ent/mrv/cbam、/ent/zk 六个入口受影响，此处统一补齐。 */
    '/mrv/activity': ['MRV 作业', '活动数据台账'],
    '/mrv/calc': ['MRV 作业', '核算作业'],
    '/mrv/factor': ['MRV 作业', '排放因子台账'],
    '/mrv/compliance': ['MRV 作业', '履约与清缴'],
    '/ent/mrv/activity': ['企业端', '活动数据台账'],
    '/ent/mrv/calc': ['企业端', '核算作业'],
    '/ent/mrv/compliance': ['企业端', '履约与清缴'],
    '/ent/mrv/cbam': ['企业端', 'CBAM 证书'],
    '/ver/mrv/activity': ['核查机构端', '审阅活动数据'],
    '/ver/mrv/calc': ['核查机构端', '复核核算批次'],
    '/reg/mrv/activity': ['监管端', '活动数据监管'],
    '/reg/mrv/calc': ['监管端', '核算批次监管'],
    '/reg/mrv/factor': ['监管端', '因子版本监管'],
    '/reg/mrv/compliance': ['监管端', '履约清缴监管'],
    '/admin/mrv/factor': ['管理端', '因子库维护'],
    '/zk': ['公开', '零知识碳核算'],
    '/ent/zk': ['企业端', '隐私承诺（零知识）'],
    '/reg/zk': ['监管端', '零知识验证'],
    '/admin/zk': ['管理端', '零知识验证'],
  };
  /* 【新增增强】把面包屑表挂到 routeAccess 上：命令面板需要它把
   * "路径"翻译成"中文名"。原本它是 app.js 内部的私有常量，
   * 外部只能靠猜——这正是"同一个信息维护两份"的来源。 */
  App.routeAccess.CRUMB = CRUMB;

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

          /* 全流程可信流水线：物理采集 → 边缘签名 → 合约核算 → 机构背书上链 */
          const flow = [
            { k: '物理电表采集', ok: true },
            { k: '边缘 TEE 签名', ok: v.signatureValid !== false },
            { k: '合约核算', ok: v.dataIntact !== false && m.rootMatches !== false },
            { k: '机构背书上链', ok: v.sealMatches !== false && !!(b && b.index) },
          ];

          return h('div', {}, [
            h('div', { class: 'trust-flow mb-16' }, flow.flatMap((s, i) => {
              const node = h('div', { class: ['tf-step', s.ok ? 'ok' : 'bad'] }, [
                h('i', { class: 'tf-dot' }),
                h('span', { class: 'tf-txt' }, s.k),
              ]);
              return i < flow.length - 1 ? [node, h('i', { class: 'tf-line' })] : [node];
            })),
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
   * 主页（/）：品牌叙事主页 —— 内容由 views/brand-page.js 提供
   * （与 /login 共用同一份品牌组件，避免两份实现漂移）。
   * 已登录用户直接跳工作台；未登录访客浏览主页。
   * ================================================================== */
  const PageHome = defineComponent({
    name: 'page-home',
    setup() {
      onMounted(() => {
        if (App.Store.user && App.Store.token) {
          App.go(ROLE_HOME[App.Store.user.role] || '/screen');
        }
      });
      return () => h(App.BrandPage, {});
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
      const mobileNavOpen = ref(false);
      let chainTimer = null, clockTimer = null;

      /* 数据通道状态角标。
       *
       * ⚠ 这里原本显示「快照 · HH:MM」，含义是"你看到的是某个时刻冻结的数据"。
       * 快照回放能力已整体删除（staticApi.js 与 api-snapshot.json 均已移除），
       * 因此那种状态不再存在 —— 取而代之的是两个真实状态：
       *   · live    → 不显示角标（正常，无需打扰）
       *   · offline → 显示"离线"，提示后端不可达
       * 显示"离线"比显示"快照"更诚实：前者告诉用户"现在拿不到数据"，
       * 后者会让人以为"这是设计如此"。 */
      const snapInfo = computed(() => {
        const s = App.Store.snap;
        if (!s) return null;
        if (s.mode === 'offline') return { mode: 'offline', text: '离线', error: s.error };
        return null;
      });

      const isPublicRoute = computed(() => {
        if (!App.Store.user) return true;
        return matchPrefix(STANDALONE_PREFIX, Router.path);
      });

      /* 链是否真的连上：以「有没有可用链顶」为准，不看 Store.chain 是否为空对象。
       * height 为 -1 表示 stats() 既没有内存链顶、也没能从库里回查到链顶，
       * 此时链高度与出块均值都不可信，状态块不能显示绿灯。 */
      const chainLive = computed(() => {
        const c = App.Store.chain;
        return !!c && Number(c.height) >= 0;
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

      /* ==================================================================
       * 【新增增强】2026-10-25 外壳效率层
       * ================================================================== */

      /* ① 侧栏收起：监管端 25 项菜单固定占 240px，看数据大屏时全是浪费。
       *    状态存在 App.prefs（localStorage），刷新/换页都保持。 */
      const navCollapsed = computed(() => App.prefs.nav === 'collapsed');
      function toggleNavCollapse() {
        App.setPref('nav', navCollapsed.value ? 'expanded' : 'collapsed');
      }
      /* ≤760px 时侧栏本来就用抽屉，收起按钮由 CSS 隐藏（v2.css 的媒体查询） */

      /* ② 密度档：紧凑 / 标准 / 宽松，一键循环 */
      const densityLabel = computed(() => ({ compact: '紧凑', normal: '标准', loose: '宽松' }[App.prefs.density] || '标准'));
      function cycleDensity() {
        const order = ['compact', 'normal', 'loose'];
        const i = order.indexOf(App.prefs.density);
        App.setPref('density', order[(i + 1) % order.length]);
        App.notify.info('信息密度：' + densityLabel.value);
      }

      /* ③ 最近访问：命令面板据此把"刚才那页"排在最前。
       *    只在路由真正变化时记，避免同一页面反复重渲染写爆 localStorage。 */
      let lastRecent = '';
      Vue.watch([() => Router.path, title], ([p, t]) => {
        if (!p || p === lastRecent || p === '/login') return;
        lastRecent = p;
        App.recent.push(p, t || p);
      }, { immediate: true });

      /* 路由守卫：判据来自 canEnter（与 isPublicRoute 共用同一份白名单）。
       * 未登录态也要守卫：静态交付模式下后端不校验 token（快照无条件应答），
       * 若不在此拦截，未登录直访业务页会完整渲染敏感数据（Bug-1）。
       * 注意不能用 isPublicRoute —— 它在未登录时恒返回 true；须用 OPEN_ROUTES
       * （真正对匿名开放的公开路由）判断，其余一律回登录页。 */
      function guard() {
        if (!App.Store.user) {
          if (!matchPrefix(OPEN_ROUTES, Router.path)) App.go('/login');
          return;
        }
        const role = App.Store.user.role;
        if (canEnter(role, Router.path)) return;
        App.notify.warn('当前身份无权访问该模块，已返回你的工作台');
        App.go(ROLE_HOME[role] || '/screen');
      }
      Vue.watch(() => Router.path, guard);

      /* 页面标题随路由变化 —— 单页应用若不更新 document.title，
       * 浏览器标签页在 35 个路由之间始终显示同一个标题，
       * 既不利于用户在多标签场景下辨识，也让浏览器历史记录无法区分页面。
       * 公开页只写页面名；业务页写成「页面名 · 碳链通」。 */
      Vue.watch(title, (t) => {
        document.title = `${t} · 碳链通 CarbonChain Hub`;
      }, { immediate: true });

      async function refreshChain() {
        try {
          App.Store.chain = await App.API.request('GET', '/chain/stats', null, { noAuth: true });
        } catch (e) { /* ignore */ }
        /* 同步数据通道状态（给顶栏角标用）。
         * probe() 只报告"能不能连上后端"，不改变任何请求路径 ——
         * 与已删除的快照回放不同：它不会让请求改道去读旧数据。 */
        try {
          const DL = App.DataLayer || App.StaticApi;
          if (DL && DL.probe) {
            const st = await DL.probe();
            App.Store.snap = { mode: st.mode, error: st.lastError || null };
          }
        } catch (e) { /* 探测失败不影响主流程 */ }
      }

      /* 静默回刷当前身份（/auth/me）——
       * ① 本地 cch_user 可能是旧结构（早期登录时后端没回 post/postCn），
       *    只依赖登录返回值会让顶栏一直停在角色名，看不到岗位（缺陷 P1-24）；
       * ② 管理员改了某人的岗位或机构名后，无需强制重新登录即可生效。
       * 失败（离线 / 401）一律静默：401 由 API 层统一走登出流程，这里不重复处理。 */
      async function syncMe() {
        if (!App.Store.token) return;
        try {
          const me = await App.API.get('/auth/me');
          if (me && me.username) setSession(App.Store.token, Object.assign({}, App.Store.user, me));
        } catch (e) { /* 忽略 */ }
      }

      onMounted(() => {
        App.resolve();
        guard();
        refreshChain();
        syncMe();
        chainTimer = setInterval(refreshChain, 30000);
        /* 投屏模式状态还原（刷新页面不丢）+ 导航搜索快捷键 */
        try { presenting.value = localStorage.getItem('cc_present') === '1'; } catch (e) { presenting.value = false; }
        document.body.classList.toggle('present', presenting.value);
        window.addEventListener('keydown', onHotkey);
        const t = () => {
          const d = new Date();
          const p = (x) => String(x).padStart(2, '0');
          clock.value = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        };
        t(); clockTimer = setInterval(t, 1000);
      });
      onUnmounted(() => { clearInterval(chainTimer); clearInterval(clockTimer); window.removeEventListener('keydown', onHotkey); });

      function logout() {
        /* 先打标记再清 session：清 session 后仍在飞的请求会拿到 401，
         * 那个提示对"刚点了退出"的用户没有意义（缺陷 P1-23）。 */
        App.Store.loggedOutByUser = true;
        App.API.post('/auth/logout').catch(() => {});
        setSession('', null);
        App.notify.info('已退出登录');
        App.go('/screen');
      }

      /* ==================================================================
       * 导航：搜索 + 分组折叠（2026-10-23 美化批次 W8）
       * ------------------------------------------------------------------
       * 监管端有 25 项菜单、企业端 18 项，一屏放不下，演示时找一个入口要滚半天。
       * 两条改进：
       *   ① 顶部搜索框，输入即过滤，命中的分组自动强制展开并高亮条目；
       *      ⌘K / Ctrl+K 聚焦（只在工作台布局挂监听，公开页不劫持键盘）。
       *   ② 分组标题变成按钮，可折叠；折叠状态按「角色|组名」持久化，
       *      不污染其他角色的默认视图。
       * ================================================================== */
      const navQuery = ref('');
      /* 搜索框的示例词取当前角色菜单里的真实标签 —— 照着提示输入必能搜到。
       * 固定写「配额」只在企业/监管端成立，管理端会搜不到任何东西。 */
      const searchHint = computed(() => {
        const first = navGroups.value.length && navGroups.value[0].items.length
          ? navGroups.value[0].items[0].label : null;
        /* 原实现 slice(0, 4) 会把「管理总览」截成「管理总」、把
         * 「动态核算（自动滚动）」截成「动态核算」，示例词成了半截词。
         * 改为：够短就整词给出，过长才按 8 字截断并加省略号。 */
        if (!first) return '搜索功能';
        return `搜索功能，如「${first.length > 8 ? first.slice(0, 8) + '…' : first}」`;
      });
      const readClosed = () => {
        try { return JSON.parse(localStorage.getItem('cc_nav_closed') || '{}') || {}; } catch (e) { return {}; }
      };
      const closedGroups = reactive(readClosed());
      const saveClosed = () => {
        try { localStorage.setItem('cc_nav_closed', JSON.stringify(closedGroups)); } catch (e) { /* 隐私模式忽略 */ }
      };
      const navKey = (g) => (App.Store.user ? App.Store.user.role : 'ANON') + '|' + g;

      const navGroups = computed(() => {
        const q = navQuery.value.trim().toLowerCase();
        if (!q) return menus.value.map((g) => ({ group: g.group, items: g.items, hit: false }));
        return menus.value
          .map((g) => ({
            group: g.group, hit: true,
            items: g.items.filter((it) => String(it.label).toLowerCase().includes(q) || String(it.path).toLowerCase().includes(q)),
          }))
          .filter((g) => g.items.length > 0);
      });

      /* 投屏模式：答辩现场 1920×1080 一屏可读。只加一个 body 类，样式在 CSS 里 */
      const presenting = ref(false);
      function togglePresent() {
        presenting.value = !presenting.value;
        document.body.classList.toggle('present', presenting.value);
        try { localStorage.setItem('cc_present', presenting.value ? '1' : '0'); } catch (e) { /* ignore */ }
      }

      function onHotkey(e) {
        if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
          /* 【新增增强】⌘K 交给命令面板；把 shell.cmdk 关掉后，
           * 退回升级前行为（聚焦侧栏搜索框），开关两侧都可用。 */
          if (App.flag('shell.cmdk') && App.palette) return;
          const box = document.querySelector('.nav-search input');
          if (box) { e.preventDefault(); box.focus(); box.select(); }
          return;
        }
        /* 【新增增强】输入框之外按 `/` 直接唤起命令面板（GitHub / Linear 的习惯） */
        if (e.key === '/' && App.flag('shell.cmdk') && App.palette
          && !(App.ux && App.ux.isTyping(e.target))) {
          e.preventDefault();
          App.palette.openPalette();
        }
      }

      function renderNav(onPick) {
        const pick = (path) => { navQuery.value = ''; onPick(path); };
        return h('nav', { class: 'nav' }, [
          h('label', { class: 'nav-search' }, [
            h('x-icon', { name: 'search', size: 13 }),
            h('input', {
              /* 显式 class：app.css 末尾有一条"裸 input 兜底"规则
               * （input:not([class]) → 36px 高 + 边框 + 背景），目的是救那些
               * 完全没写 class 的业务表单输入框。但侧栏搜索框也是裸 input，
               * 于是被误伤成一个套在 32px 搜索框里的白边框 36px 小框。
               * 给它一个明确 class 即脱离该兜底规则的作用域。 */
              class: 'nav-q',
              /* placeholder 不能写死某一个例子：侧栏菜单按角色不同，
               * 管理端并没有"配额"相关页面，写死「配额」会让用户照着输入却得到
               * "没有匹配的功能"，看起来像搜索坏了。改为取当前角色的真实菜单标签。 */
              type: 'text', placeholder: searchHint.value, 'aria-label': '搜索功能',
              value: navQuery.value,
              onInput: (e) => { navQuery.value = e.target.value; },
            }),
            h('kbd', {}, '⌘K'),
          ]),
          ...navGroups.value.map((g) => {
            const key = navKey(g.group);
            const closed = !g.hit && !!closedGroups[key];
            return h('div', {}, [
              h('div', {
                class: ['nav-group', closed && 'closed', g.hit && 'searching'],
                role: g.hit ? null : 'button', tabindex: g.hit ? null : 0,
                title: g.hit ? '搜索结果已展开' : (closed ? '展开「' + g.group + '」' : '折叠「' + g.group + '」'),
                /* 搜索态下分组强制展开，此时点击不应改写折叠状态 ——
                 * 否则会留下一个"看不见的折叠"，清空搜索后突然少一组，很难自解释。 */
                onClick: g.hit ? undefined : () => { closedGroups[key] = !closedGroups[key]; saveClosed(); },
              }, [
                h('span', {}, g.group),
                h('i', { class: 'nav-sep' }),
                h('span', { class: 'num' }, String(g.items.length)),
                h('i', { class: 'caret' }),
              ]),
              ...(closed ? [] : g.items.map((it) => h('button', {
                class: ['nav-item', Router.path === it.path && 'active', g.hit && 'hit'],
                /* 【新增增强】收起态只剩图标，title 是可发现性的兜底 */
                title: it.label,
                onClick: () => pick(it.path),
              }, [
                h('x-icon', { name: it.icon, size: 16 }),
                h('span', { class: 'lbl' }, it.label),
              ]))),
            ]);
          }),
          !navGroups.value.length
            ? h('div', { class: 'tiny dim', style: 'padding:14px 8px;text-align:center' }, '没有匹配的功能')
            : null,
        ]);
      }

      /* ==================================================================
       * 公开顶栏（2026-10-30 精简）：不再放导航文字按钮，
       * 通知公告并入右侧铃铛（label 形态），公告列表经面板"查看全部通知"进入；
       * 公示大屏 / 区块链浏览器由主页卡片与命令面板直达，顶栏不再重复。
       * 账本全景 / 科研验证中心 / CEMS 监控属于登录后的工作台功能，
       * 对公众不展示（登录后在工作台侧栏内都有）。
       * ================================================================== */
      const showTop = ref(false);
      function onScrollTop() { showTop.value = (window.scrollY || document.documentElement.scrollTop) > 600; }
      onMounted(() => window.addEventListener('scroll', onScrollTop, { passive: true }));
      onUnmounted(() => window.removeEventListener('scroll', onScrollTop));

      /* 角色色彩身份（2026-10-29）：外壳根节点挂 role-XXX 类，
       * 配合 app.css 的 --role-accent 给四端各自的侧边栏选中态 / 顶栏头像上色 */
      return () => h('div', { class: 'app role-' + ((App.Store.user && App.Store.user.role) || 'GUEST') }, [
        /* 回到顶部（全局浮动） */
        h('button', {
          class: ['backtop', showTop.value && 'show'],
          title: '回到顶部',
          'aria-label': '回到顶部',
          onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
        }, '↑'),
        /* 公开布局 */
        isPublicRoute.value
          ? h('div', {}, [
            h('div', { class: 'topbar topbar-public', style: 'position:sticky' }, [
              /* 品牌区（Logo + 站名）可点：从任意公开页一键回主页 */
              h('div', { class: 'flex gap-10', style: 'cursor:pointer', title: '返回主页', onClick: () => App.go('/') }, [
                h('div', { class: 'brand-logo', style: 'width:44px;height:24px' }, [h('img', { src: './img/logo-mark.png', alt: '碳链通 CarbonChain Hub' })]),
                h('b', { style: 'color:var(--tx-0);font-size:14.5px' }, '碳链通'),
              ]),
              h('div', { class: 'topbar-right' }, [
                /* 通知公告与铃铛合体（2026-10-30）：带文字的铃铛即公告入口，
                 * 点开为通知中心下拉，面板底部可进 /notice 全部通知页 */
                h(App.NoticeBell, { label: '通知公告' }),
                App.Store.user
                  ? h('button', { class: 'btn sm', onClick: () => App.go(ROLE_HOME[App.Store.user.role]) }, [h('x-icon', { name: 'dash', size: 14 }), '进入工作台'])
                  : h('button', { class: 'btn sm primary', onClick: () => {
                    /* 登录弹窗：品牌页内直接弹出；其他页先跳品牌页（自动弹出） */
                    if (window.__cchOpenAuth) window.__cchOpenAuth('login');
                    else App.go('/login');
                  } }, [h('x-icon', { name: 'lock', size: 14 }), '登录平台']),
              ]),
            ]),
            h('div', { style: 'max-width:1680px;margin:0 auto;padding:20px 24px 48px' }, [h(view.value, viewProps())]),
          ])

          /* 工作台布局 */
          : h('div', { class: 'shell' }, [
            h('aside', { class: 'sidebar' }, [
              h('div', { class: 'brand' }, [
                h('div', { class: 'brand-logo' }, [h('img', { src: './img/logo-mark.png', alt: '碳链通 CarbonChain Hub' })]),
                h('div', { class: 'brand-txt' }, [h('strong', {}, '碳链通'), h('span', {}, 'CarbonChain Hub')]),
                /* 【新增增强】侧栏收起：状态在 App.prefs，全站持久化 */
                h('button', {
                  class: 'nav-collapse',
                  title: navCollapsed.value ? '展开侧边栏' : '收起侧边栏（腾出 176px 看数据）',
                  'aria-label': navCollapsed.value ? '展开侧边栏' : '收起侧边栏',
                  onClick: toggleNavCollapse,
                }, [h('x-icon', { name: navCollapsed.value ? 'chevronRight' : 'chevronLeft', size: 14 })]),
              ]),
              renderNav((path) => App.go(path)),
              h('div', { class: 'side-foot' }, [
                /* 状态必须由链高度驱动，不能"有对象就绿灯"。
                 * 原实现只要 App.Store.chain 存在就点亮绿点并写死「链节点运行中」，
                 * 于是链高度 -1（链不可达 / 内存链未回查成功）时，同屏出现
                 * 「运行中 / H=-1 / 出块均值 1 ms」三个互相矛盾的事实——
                 * 绿灯在这个场景下不是状态，只是装饰。 */
                chainLive.value ? h('div', { class: 'node-card' }, [
                  h('div', { class: 'flex gap-8', style: 'align-items:center' }, [
                    h('span', { class: 'dot' }),
                    h('span', { class: 'tiny', style: 'color:var(--tx-1)' }, '链节点运行中'),
                  ]),
                  h('div', { class: 'tiny dim mt-8 mono' }, `H=${App.Store.chain.height} · ${App.Store.chain.difficulty ? '难度 ' + App.Store.chain.difficulty : 'PoA 共识'}`),
                  h('div', { class: 'tiny dim mono' }, `出块均值 ${App.Store.chain.avgMineTime ? App.Store.chain.avgMineTime + ' ms' : '—'}`),
                  h('div', { class: 'tiny dim mono ellipsis', title: App.Store.chain.tipHash }, App.fmt.short(App.Store.chain.tipHash || '-', 8)),
                ]) : h('div', { class: 'node-card off' }, [
                  h('div', { class: 'flex gap-8', style: 'align-items:center' }, [
                    h('span', { class: 'dot' }),
                    h('span', { class: 'tiny', style: 'color:var(--tx-1)' }, '链节点未连接'),
                  ]),
                  h('div', { class: 'tiny dim mt-8 mono' }, 'H=- · PoA 共识'),
                  h('div', { class: 'tiny dim mono' }, '正在重试连接…'),
                ]),
              ]),
            ]),

            h('div', { class: 'main' }, [
              h('header', { class: 'topbar' }, [
                h('button', { class: 'nav-toggle', onClick: () => { mobileNavOpen.value = !mobileNavOpen.value; }, 'aria-label': '打开导航菜单' }, [
                  h('span', {}), h('span', {}), h('span', {}),
                ]),
                /* 【新增增强】面包屑上级可点：原来「监管端 / 配额分配管理」里的
                 * "监管端"只是装饰文字，想回工作台得去侧栏找。现在点它就回去。 */
                h('div', { class: 'crumb' }, [
                  h('button', {
                    class: ['crumb-up', crumb.value[0] ? '' : 'hide'],
                    title: '返回' + (crumb.value[0] || '首页'),
                    onClick: () => App.go(App.Store.user ? (ROLE_HOME[App.Store.user.role] || '/screen') : '/screen'),
                  }, crumb.value[0] + ' / '),
                  h('b', {}, crumb.value[1] || ''),
                ]),
                h('div', { class: 'topbar-right' }, [
                  /* 全局实时通知中心（工作台顶栏 —— 覆盖企业/核查/监管/交易/管理全部角色） */
                  h(App.NoticeBell),
                  h('span', { class: 'chip live' }, [h('x-icon', { name: 'chain', size: 14 }), `链高度 ${App.Store.chain.height || '-'}`, snapInfo.value ? h('span', { class: 'snap-badge', style: 'background:rgba(244,63,94,.18);color:#fda4af;border-color:rgba(244,63,94,.35)', title: (snapInfo.value.error || '后端不可达') + ' —— 数据无法加载，且不会回放旧快照' }, snapInfo.value.text) : null]),
                  h('span', { class: 'chip mono' }, clock.value),
                  h('div', { class: 'userbox' }, [
                    h('div', { class: 'avatar' }, (App.Store.user.realName || App.Store.user.username || '?').slice(0, 1)),
                    h('div', { class: 'col', style: 'line-height:1.25' }, [
                      h('span', { style: 'font-size:12.8px;color:var(--tx-0)' }, App.Store.user.realName || App.Store.user.username),
                      /* 第二行优先显示**岗位**（机构管理员 / 核查录入员 / 排放填报员…），
                       * 岗位缺失时退回角色名（企业端 / 核查机构端…）。
                       * 缺陷清单 P1-24：此前只显示角色名，导致同角色不同岗位的账号
                       * （机构管理员 vs 核查录入员）在界面上完全无法区分。 */
                      h('span', {
                        class: 'tiny dim',
                        title: [App.Store.user.postCn, App.DICT.role[App.Store.user.role], App.Store.user.orgName]
                          .filter(Boolean).join(' · '),
                      }, (App.Store.user.postCn || App.DICT.role[App.Store.user.role] || '')
                        + (App.Store.user.orgName ? ' · ' + App.Store.user.orgName.slice(0, 14) : '')),
                    ]),
                  ]),
                  /* 【新增增强】显示与偏好设置入口（密度 / 字号 / 对比度 / 动效 / 功能开关） */
                  App.SettingsPanel
                    ? h('button', {
                      class: 'btn sm ghost',
                      title: '显示与偏好设置',
                      'aria-label': '打开显示与偏好设置',
                      onClick: () => App.settings.openSettings(),
                    }, [h('x-icon', { name: 'gear', size: 15 })])
                    : null,
                  /* 【新增增强】信息密度：紧凑档一屏多 4–6 行表格 */
                  App.flag('ui.density')
                    ? h('button', {
                      class: 'btn sm ghost',
                      title: '信息密度（当前：' + densityLabel.value + '）· 点击切换',
                      'aria-label': '切换信息密度',
                      onClick: cycleDensity,
                    }, [h('x-icon', { name: 'sliders', size: 15 })])
                    : null,
                  /* 【新增增强】命令面板入口：不知道快捷键的人也该能找到它 */
                  App.flag('shell.cmdk') && App.palette
                    ? h('button', {
                      class: 'btn sm ghost cmdk-btn',
                      title: '全局搜索与快捷动作（Ctrl/⌘ + K）',
                      'aria-label': '打开命令面板',
                      onClick: () => App.palette.openPalette(),
                    }, [h('x-icon', { name: 'command', size: 15 })])
                    : null,
                  h('button', {
                    class: ['btn sm ghost present-btn', presenting.value && 'primary'],
                    /* aria-label 与 title 必须同时给：title 在键盘导航与读屏里不可靠，
                     * 顶栏其余按钮都带 aria-label，只这个缺失 —— 无障碍不一致。 */
                    'aria-label': presenting.value ? '退出投屏模式' : '进入投屏模式',
                    'aria-pressed': presenting.value ? 'true' : 'false',
                    title: presenting.value ? '退出投屏模式' : '投屏模式：放大字号与行高，适合答辩投影',
                    onClick: togglePresent,
                  }, [h('x-icon', { name: 'layers', size: 15 })]),
                  h('button', {
                    class: 'btn sm ghost', title: '退出登录', 'aria-label': '退出登录', onClick: logout,
                  }, [h('x-icon', { name: 'logout', size: 15 })]),
                ]),
              ]),
              /* 【新增增强】路由过渡：外层用路径作 key，切页时整体淡入 120ms。
               * 只改变透明度不改变布局，因此不会引起重排，也不影响首屏指标。 */
              h('main', { class: 'content' }, [
                h('div', { class: App.flag('shell.turb') ? 'view-fade' : null, key: Router.path },
                  [h(view.value, viewProps())]),
              ]),
            ]),
          ]),

        /* 移动端抽屉导航：仅 ≤760px 显示，复用与侧边栏同一份 menus 数据 */
        !isPublicRoute.value
          ? h('div', { class: ['mnav-mask', mobileNavOpen.value && 'open'], onClick: () => { mobileNavOpen.value = false; } }, [
            h('aside', { class: ['mnav', mobileNavOpen.value && 'open'], onClick: (e) => e.stopPropagation() }, [
              h('div', { class: 'brand' }, [
                h('div', { class: 'brand-logo' }, [h('img', { src: './img/logo-mark.png', alt: '碳链通 CarbonChain Hub' })]),
                h('div', { class: 'brand-txt' }, [h('strong', {}, '碳链通'), h('span', {}, 'CarbonChain Hub')]),
              ]),
              renderNav((path) => { App.go(path); mobileNavOpen.value = false; }),
              h('div', { class: 'side-foot' }, [
                h('button', { class: 'btn block danger', onClick: () => { mobileNavOpen.value = false; logout(); } }, [h('x-icon', { name: 'logout', size: 15 }), '退出登录']),
              ]),
            ]),
          ])
          : null,

        h(ChainProofModal),
        /* 【新增增强】全局命令面板（⌘K）—— 放在外壳最后一层，
         * 任何页面（含公开页）都能唤起，且不受路由切换影响。 */
        App.flag('shell.cmdk') && App.CmdPalette ? h(App.CmdPalette) : null,
        /* 【新增增强】快捷键说明浮层（`?` 唤起）—— 与命令面板同层，
         * 二者互斥打开（打开一个会关掉另一个），避免叠成两层遮罩。 */
        App.flag('shell.cmdk') && App.ShortcutHelp ? h(App.ShortcutHelp) : null,
        /* 【新增增强】显示与偏好设置抽屉 */
        App.SettingsPanel ? h(App.SettingsPanel) : null,
        h('x-toasts'),
        /* AI 碳资产顾问浮窗。
         *
         * ⚠ 为什么挂在外壳最后一层，而不是塞进某个页面里：
         * 它需要**跨页面持续存在** —— 用户在 /twin 里选中车间，切到 /mrv/calc
         * 继续问"这个批次的存证在哪"，浮窗与对话上下文都不应被重建。
         * 放在根节点下，路由切换只替换 view，浮窗不受影响。
         *
         * 它自己管显示/隐藏（默认收成一个圆钮），因此不遮挡现有页面内容。
         * 未登录时也显示 —— 顾问会明确说"需要登录才能查企业数据"，
         * 而不是整块消失让人以为功能不存在。 */
        App.Copilot ? h(App.Copilot) : null,
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
