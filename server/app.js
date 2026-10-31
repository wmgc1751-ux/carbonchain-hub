/**
 * app.js —— 应用入口
 * 一个进程同时提供：REST API（/api/**） + 前端静态资源（/）
 */
'use strict';

const express = require('express');
const path = require('path');
const config = require('./config');
const { ok, fail } = require('./middleware/auth');
const { getChain } = require('./services/anchor');

const app = express();

/* ---------------- 进程级兜底 ----------------
 * Node 15+ 默认会把未处理的 Promise 拒绝升级为进程退出。
 * 演示现场（以及无人值守的长跑）绝不能让一个漏 catch 的异步分支把节点带走，
 * 因此这里统一记日志并让进程继续服务。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err && err.stack ? err.stack : err);
});

/* ---------------- 基础中间件 ---------------- */
/* 安全响应头（必须在最前面设置，才能覆盖包括错误响应在内的所有返回）
 *
 * 为什么这几条是硬性要求：
 *   · X-Content-Type-Options: nosniff —— 阻止浏览器把 JSON 猜成 HTML 执行。
 *     本平台有大量"用户可控文本"（企业名、公告正文），一旦被当成 HTML 解析，
 *     就构成存储型 XSS 的入口。
 *   · X-Frame-Options: DENY —— 禁止被第三方站点 iframe 嵌套，防点击劫持。
 *     "存证验真"页面尤其重要：攻击者可以套一个透明 iframe 诱导用户确认。
 *   · Referrer-Policy —— 钱包地址会出现在 URL 里，不能随 Referer 泄露给外站。
 *   · HSTS —— 仅在生产且确实走 HTTPS 时下发；本地 HTTP 下发会让浏览器
 *     记住"这个主机只能用 HTTPS"，把本地开发环境搞坏。
 *   · CSP —— 本平台前端是运行期编译的 Vue，用了内联事件属性与 style，
 *     因此不能上严格 CSP（会白屏）。这里只启用不会破坏现有页面的部分：
 *     object-src 'none' / frame-ancestors 'none' / base-uri 'self'。
 *     刻意不写 script-src，避免给出"看起来有 CSP 其实挡不住"的错觉。
 *   · 关闭 X-Powered-By —— 版本指纹是最省事的攻击入口。 */
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy',
    "object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  /* HSTS 只在生产 + 确实启用了 HTTPS 时下发 */
  if (config.isProd && process.env.HTTPS_ON === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  /* 敏感接口不缓存：余额、身份、存证明细经中间代理缓存会跨用户泄露 */
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, private');
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* ============ 轻量可观测性（RR-09，2026-10-31）==================
 * 请求计数 / 错误计数 / 延迟累计，/api/metrics 以 Prometheus 文本格式暴露。
 * 面向演示级监控：无外部 APM 依赖；告警阈值见 审计-20261031/告警阈值.md。
 * ================================================================ */
const METRICS = { startedAt: Date.now(), requests: 0, errors: 0, byRoute: new Map() };
app.use((req, res, next) => {
  if (req.path === '/api/metrics') return next();
  const t0 = Date.now();
  res.on('finish', () => {
    const route = (req.route && req.route.path) || req.baseUrl || req.path.split('?')[0];
    const ms = Date.now() - t0;
    METRICS.requests += 1;
    if (res.statusCode >= 500) METRICS.errors += 1;
    const key = req.method + ' ' + (req.baseUrl || '/api') + route;
    const cur = METRICS.byRoute.get(key) || { n: 0, err: 0, ms: 0 };
    cur.n += 1; cur.ms += ms;
    if (res.statusCode >= 500) cur.err += 1;
    METRICS.byRoute.set(key, cur);
  });
  next();
});
app.get('/api/metrics', (req, res) => {
  const up = ((Date.now() - METRICS.startedAt) / 1000).toFixed(0);
  const lines = [
    '# HELP cc_requests_total Total API requests.', '# TYPE cc_requests_total counter',
    `cc_requests_total ${METRICS.requests}`,
    '# HELP cc_errors_total Total 5xx responses.', '# TYPE cc_errors_total counter',
    `cc_errors_total ${METRICS.errors}`,
    '# HELP cc_uptime_seconds Process uptime.', '# TYPE cc_uptime_seconds gauge',
    `cc_uptime_seconds ${up}`,
    '# HELP cc_route_requests Requests per route.', '# TYPE cc_route_requests counter',
  ];
  for (const [k, v] of METRICS.byRoute) {
    const tag = k.replace(/"/g, '');
    lines.push(`cc_route_requests{route="${tag}"} ${v.n}`);
    lines.push(`cc_route_errors{route="${tag}"} ${v.err}`);
    lines.push(`cc_route_latency_sum{route="${tag}"} ${v.ms}`);
  }
  lines.push('# 告警阈值：5xx 率 >1% 持续 5min → P1；P95 >500ms 持续 10min → P2；DB 连接失败即时 → P0');
  res.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
});

/* 跨域策略（安全默认）
 *   · 配置了 CORS_ORIGINS      → 白名单模式，只放行名单内来源；
 *   · 未配置 且为本地/内网开发 → 回显请求来源，便于前后端分端联调；
 *   · 未配置 且处于生产/云平台 → 不下发任何跨域放行头。
 * 为什么生产环境要"什么都不发"：本平台前后端同端口部署，同源请求本来就不需要
 * 任何 CORS 响应头，功能不受影响；而一旦回显任意 Origin，配合
 * Access-Control-Allow-Credentials: true，等于允许任意第三方站点携带用户凭据
 * 读取接口数据 —— 这正是线上旧版本暴露的问题。 */
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  let allowOrigin = null;
  if (CORS_ORIGINS.length) {
    if (origin && CORS_ORIGINS.includes(origin)) allowOrigin = origin;
  } else if (!config.isProd) {
    allowOrigin = origin || '*';
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 访问日志
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${new Date().toLocaleTimeString('zh-CN')} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
    }
  });
  next();
});

/* ---------------- 生产加固中间件 ----------------
 * 结构化日志 + 监控指标 + 灰度路由 —— 三件套构成"生产加固"基础设施：
 *   · structured-log：JSON 日志 + 环形缓冲（/api/ops/logs 可查）
 *   · monitor：Prometheus 指标 + 阈值告警（/api/ops/metrics, /api/ops/alerts）
 *   · canary：灰度发布功能开关（?canary=1 或 X-Canary header）
 */
app.use(require('./middleware/structured-log').requestLogger);
app.use(require('./middleware/monitor').middleware);
app.use(require('./middleware/canary').middleware);

/* ---------------- 健康检查（必须在所有业务路由之前） ----------------
 * ⚠ 顺序陷阱（2026-10-24 修复）：
 *   international.js 是挂在 `/api` 根上的（它的端点是 /api/cbam/*、/api/report/* 等），
 *   而它内部第一行是 `router.use(authRequired)`。Express 的 app.use('/api', r)
 *   会让 r 的中间件对**所有** /api/* 请求先跑一遍，
 *   于是在它之后定义的 /api/health 也会被要求带令牌 → 返回 401。
 *   后果很严重：云平台的健康检查拿到 401 会判定实例不健康，
 *   部署显示成功但流量永远不切过来 —— 表现为「线上还是上一版代码」。
 *   修法：把 health 注册到所有 /api 级中间件之前。 */
app.get('/api/health', async (req, res) => {
  try {
    const chain = await getChain();
    const stats = await chain.stats();
    ok(res, {
      status: 'UP', time: new Date().toISOString(),
      chainHeight: stats.height, node: stats.node, difficulty: stats.difficulty,
      consensus: stats.consensusMode || config.chain.consensusMode,
      runMode: config.isCloud ? 'cloud' : (config.isProd ? 'production' : 'development'),
      demoAccounts: config.demoAccounts,
    });
  } catch (e) {
    fail(res, e.message, 500);
  }
});

/* ---------------- 业务路由 ---------------- */
app.use('/api/auth', require('./routes/auth'));
app.use('/api/enterprise', require('./routes/enterprise'));
app.use('/api/verifier', require('./routes/verifier'));
app.use('/api/regulator', require('./routes/regulator'));
app.use('/api/chain', require('./routes/chain'));
app.use('/api/consortium', require('./routes/consortium'));
app.use('/api/dynamic', require('./routes/dynamic'));
app.use('/api/credit', require('./routes/credit'));
app.use('/api/trade', require('./routes/trade'));
app.use('/api/mandate', require('./routes/mandate'));
app.use('/api/integrity', require('./routes/integrity'));
app.use('/api/disclosure', require('./routes/disclosure'));
app.use('/api/derive', require('./routes/derive'));
app.use('/api/intelligence', require('./routes/intelligence'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/public', require('./routes/public'));
/* 实时通知推送：SSE 订阅权威源站新消息（公开，面向所有访客与角色） */
app.use('/api/notify', require('./routes/notify'));
app.use('/api/ops', require('./routes/ops'));
app.use('/api/iot', require('./routes/iot'));
/* WP2 密码学生产化：国密 SM2 密钥治理（/api/keys/*） */
app.use('/api/keys', require('./routes/keymgmt'));
/* WP4 核算升级：不确定度/模型评估/口径方法学（/api/uncertainty/*） */
app.use('/api/uncertainty', require('./routes/uncertainty'));
/* MRV 生产作业流：活动数据台账 / 核算批次 / 因子台账 / 数据质量 */
app.use('/api/mrv', require('./routes/mrv'));
/* 商业闭环：资金结算账户 / 履约清缴 / 碳信用注销 / CBAM 证书 */
app.use('/api/settlement', require('./routes/settlement'));
/* 零知识碳核算：隐私承诺 / 范围证明 / 同态聚合 / 授权披露
 * —— 这是平台进入真实企业的关键：企业不交原始数据也能被监管验证 */
app.use('/api/zk', require('./routes/zk'));
/* 核算节点可信存证：为"活动数据登记/核算完成/核查通过"等关键节点
 * 自动生成带时间戳与 SHA-256 摘要的区块凭证，并提供**公开的离线复核**端点。
 * ⚠ /api/evidence/verify 刻意不挂 authRequired —— 存证的价值在于任何人可验证，
 *   若验证必须登录，它就退化成"请相信我们验证过"。 */
app.use('/api/evidence', require('./routes/evidence'));
/* AI 碳资产顾问：上下文感知 + 真实工具调用 + SSE 流式输出。
 * 不依赖外部 LLM —— 碳数据不能由语言模型编造（见 services/carbonCopilot.js 头部说明）。 */
app.use('/api/copilot', require('./routes/copilot'));
/* 真实厂区数字孪生：从 Climate TRACE / EPA 的真实设施数据派生 3D 厂区几何。
 * 公开可读 —— 源数据本身公开，锁在登录后会让「可核验」变成「请相信」。 */
app.use('/api/twin', require('./routes/twin'));
/* 四家保定焚烧厂区的 3D 测绘模型：几何逐栋量自卫星影像，排放绑 CEMS 实测。
 * 与 /api/twin 并存 —— 后者几何曾为派生示意已下线，本路由的数据来源
 * 与限制（高度取工程常见值）在返回体里分开标注，不合并成"全部真实"。 */
app.use('/api/plant3d', require('./routes/plant3d'));
/* 真实数据层 + 实时运转：EPA GHGRP 真实设施台账 / 行业基准 / 年度趋势 /
 * 宏观真实序列 / 真实性契约 / 秒级实时快照与 SSE 推送。
 * ⚠ 本层刻意不挂 authRequired：数据源本身是公开数据集（Public Domain / CC BY），
 *   锁在登录后会让第三方无法核验平台的真实性主张，"可核验"就成了"请相信"。 */
app.use('/api/real', require('./routes/real'));
/* WP5 国际互认：挂载在 /api 根上，端点为 /api/cbam/* /api/greenpower/* /api/report/* /api/cost/* */
app.use('/api', require('./routes/international'));

/* health 已在业务路由之前注册（见上方说明），此处不再重复 */

/* ---------------- 静态资源 ---------------- */
app.use(express.static(config.paths.public, { extensions: ['html'] }));

// SPA 兜底
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(config.paths.public, 'index.html'));
});

/* ---------------- 统一异常处理 ---------------- */
app.use((req, res) => fail(res, '接口不存在', 404));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  /* 请求体解析失败（express.json 抛出的 body-parser 错误）。
   * 原实现直接把 err.message 回显给客户端，会泄露底层解析器的内部信息
   * （例如 `Expected property name or '}' in JSON at position 1 (line 1 column 2)`），
   * 这类信息对攻击者探测技术栈有价值、对正常用户毫无意义。改为返回统一提示，
   * 仅在服务端日志中保留细节。 */
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return fail(res, '请求体格式不正确，应为合法的 JSON', 400);
  }
  if (err.type === 'entity.too.large') {
    return fail(res, '请求体过大（上限 2 MB）', 413);
  }

  const status = Number(err.status) || 500;
  if (status >= 500) {
    /* 未预期的系统异常：细节仅落服务端日志，对外统一泛化文案。
     * 历史缺陷：业务层 DB 错误被原样回显（如
     * "Incorrect integer value: 'abc' for column 'quarter' at row 1"），
     * 泄露库表结构。此处统一收敛；业务规则错误应带 4xx 的 err.status，
     * 走下面的分支保留可读提示。 */
    console.error('[ERROR]', req.method, req.originalUrl, err.message, err.stack);
    return fail(res, '服务器内部错误，请稍后重试', 500);
  }
  console.error('[BIZ]', req.method, req.originalUrl, status, err.message);
  fail(res, err.message || '请求处理失败', status);
});

/* ---------------- 启动 ---------------- */

/* 优雅停机用：当前 HTTP server 引用与重入保护（bootstrap 内赋值） */
let currentServer = null;
let shuttingDown = false;

/** 启动前安全自检：关键密钥若为内置默认值，生产环境直接拒绝启动 */
function assertSecureConfig() {
  const problems = [];
  if (!process.env.JWT_SECRET) problems.push('JWT_SECRET 未设置（正在使用内置默认密钥，令牌可被伪造）');
  if (config.isProd && !process.env.DB_PASSWORD) problems.push('DB_PASSWORD 未设置（数据库使用默认口令）');
  if (config.isProd && !process.env.KEYSTORE_SECRET) problems.push('KEYSTORE_SECRET 未设置（链上私钥库将明文落盘）');
  if (config.isProd && !process.env.HJ212_PW) problems.push('HJ212_PW 未设置（设备接入将使用默认口令 123456，CCD-004）');
  if (!problems.length) return;
  const msg = '⚠ 安全配置检查未通过：\n  - ' + problems.join('\n  - ');
  if (config.isProd) {
    console.error(msg + '\n生产环境禁止以不安全配置启动，进程已中止。');
    process.exit(1);
  }
  console.warn(msg + '\n（当前为非生产环境，仅告警；上线前请务必配置上述环境变量）');
}

async function bootstrap() {
  assertSecureConfig();

  /* ── 单实例互斥（2026-10-26 迭代）──────────────────────────────
     教训：机器上同时跑 3 个 app.js 时，各自内存链缓存按"内存最高块+1"出块，
     全部写同一个 MySQL ⇒ `Duplicate entry uk_block_index`，一切上链动作必败。
     现在启动即抢 MySQL 命名锁：抢不到 = 已有实例在跑，直接拒绝启动（exit 1），
     把"两个实例悄悄互相写坏数据"变成"第二个进程响亮地启动失败"。
     锁随连接存活：进程崩溃连接断开 ⇒ 锁自动释放，无手工清理负担。
     DB 暂不可用时不阻塞启动（云平台健康检查优先），只降级为告警。
     ⚠ 豁免通道：INSTANCE_LOCK=0 跳过本锁。仅供测试探针（tools/real-layer-check、
       llm-e2e、offline-pack 等自起 8311 等隔离端口的子实例）使用——
       它们关闭了全部定时写库调度（CEMS/HJ212），与主实例不构成写冲突。
       业务部署禁止设置该变量。 */
  if (['0', 'off', 'false'].includes(String(process.env.INSTANCE_LOCK || '').toLowerCase())) {
    console.warn('⚠ INSTANCE_LOCK=0：本实例为测试探针子实例，跳过单实例互斥（请勿在业务部署中使用）');
  } else try {
    const db = require('./db');
    const conn = await db.pool.getConnection();
    const [[lk]] = await conn.query('SELECT GET_LOCK(?, 0) AS got', ['carbon_chain_instance_lock']);
    if (Number(lk.got) !== 1) {
      conn.release();
      console.error('✘ 拒绝启动：检测到另一个 server/app.js 实例正在运行（持有实例锁）。'
        + '\n  多实例会各自持有内存链缓存并写同一个库，历史上造成过区块唯一索引撞车。'
        + '\n  如确需多实例，请先改为共享链状态/分库，而不是绕过本锁。');
      process.exit(1);
    }
    /* 心跳：连接空闲超 8 小时可能被 MySQL wait_timeout 掐断 ⇒ 锁失效。
       60s 一次 SELECT 1 既保活，也顺带探活数据库。 */
    const hb = setInterval(() => { conn.query('SELECT 1').catch(() => {}); }, 60_000);
    hb.unref();
    console.log('🔒 实例锁已取得（单实例模式）：carbon_chain_instance_lock');
  } catch (e) {
    console.warn('⚠ 实例锁不可用（数据库未就绪？），启动继续但失去多实例保护：', e.message);
  }

  /* ── 启动顺序很关键：先把 HTTP 端口监听起来 ──
     数据库 / 联盟链 / 动态核算的初始化全部放进 warmup()，在 listen 之后异步执行。
     原因：云平台（Render 等）的健康检查依赖端口尽早可用；若在这里同步 await 远程
     数据库（跨区连接可能耗时数分钟），新实例会被判定「启动过慢」，结果是部署虽然
     显示成功、流量却没有切到新实例 —— 表现为线上仍是上一版代码。 */
  const httpServer = app.listen(config.port, config.host, () => {
    console.log('─'.repeat(64));
    console.log('  碳链通 CarbonChain Hub 已启动');
    console.log(`  访问地址: http://localhost:${config.port}`);
    console.log(`  API 前缀: http://localhost:${config.port}/api`);
    console.log(`  运行模式: ${config.isCloud ? '云平台' : (config.isProd ? '生产' : '开发')}` +
      ` · 演示账号接口${config.demoAccounts ? '开放' : '关闭'}` +
      ` · 跨域${CORS_ORIGINS.length ? `白名单(${CORS_ORIGINS.length})` : (config.isProd ? '仅同源' : '宽松')}`);
    console.log('─'.repeat(64));
  });
  currentServer = httpServer;

  /* 挂载工业物联网 WebSocket 实时通道（容错：ws 库未装则跳过，前端降级归档模式）
     渠道：/ws/telemetry —— 推送 CEMS 烟气实时流 / 车间电表 / 联盟链出块事件 */
  try {
    const telemetry = require('./routes/telemetry');
    telemetry.attach(httpServer);
  } catch (e) { console.warn('⚠ WebSocket 通道挂载跳过：', e.message); }

  /* 后台预热：幂等、失败仅告警，绝不阻塞端口可用性 */
  warmup().catch((e) => {
    console.error('⚠ 后台初始化异常（服务继续运行）：', e && e.message ? e.message : e);
  });
}

/** 链 / 联盟链 / 动态核算的幂等预热 —— 在 HTTP 已监听之后异步执行 */
async function warmup() {
  try {
    const chain = await getChain();
    const stats = await chain.stats();
    console.log('⛓  区块链节点已就绪：高度=%d 区块=%d 交易=%d 共识=%s',
      stats.height, stats.totalBlocks, stats.confirmed, stats.consensusMode || 'POA');
    // 联盟链：幂等注册初始成员节点，并把各节点链副本同步到最新高度
    try {
      const cons = require('./services/consortium');
      await cons.ensureSeed();
      await cons.syncAll();
      const rs = await cons.replicaStatus();
      console.log('🔗 联盟链已就绪：授权节点 %d 个，副本一致节点 %d/%d',
        rs.nodes.filter((n) => n.status === 'ACTIVE').length, rs.consistentNodes, rs.totalNodes);
    } catch (e) {
      console.error('⚠ 联盟节点初始化跳过：', e.message);
    }
    // 动态核算：自举实测数据 + 启动准实时采数调度
    /* ⚠ 2026-10-29 真实数据模式：平台已接入 4 家国内控排企业的真实 CEMS 排放量数据
     *   （cems_cn_hourly，46 个月）。bootstrap() 会为库内企业**生成模拟读数**，
     *   startScheduler() 会周期性续写——若放任运行，模拟数据会被安到真实企业头上，
     *   正是评审点破的"自举模拟"。因此默认停用；要恢复合成演示环境，显式设
     *   SYNTH_DEMO=1（用于纯流程演示，且此时不得宣称真实企业数据）。 */
    if (process.env.SYNTH_DEMO === '1') {
      try {
        const dyn = require('./services/dynamic');
        const ov = await dyn.bootstrap();
        dyn.startScheduler();
        console.log('📈 动态核算引擎已启动（合成演示模式）：实测读数 %d 条，覆盖企业 %d 家，高/中风险 %d/%d',
          ov.readings.total, ov.summary.enterprises, ov.summary.highRisk, ov.summary.mediumRisk);
      } catch (e) {
        console.error('⚠ 动态核算初始化跳过：', e.message);
      }
    } else {
      console.log('🔒 真实数据模式：动态核算模拟自举与准实时采数已停用（真实企业数据在 cems_cn_hourly / cems_public_reading）');
    }

    /* 审计日志批次锚定（P2）：每日把新日志做 Merkle 根上链。
     * 为什么需要：audit_log 本身可被 DBA 直接 UPDATE，上链后才能证明日志未被事后篡改。
     * 失败只告警，不影响主服务。 */
    setInterval(async () => {
      try {
        const integrity = require('./services/integrity');
        const anchorSvc2 = require('./services/anchor');
        const cu2 = require('./blockchain/crypto-utils');
        const r = await integrity.anchorAuditBatch(anchorSvc2, cu2.merkleRoot, cu2.sha256, 500);
        if (r) console.log('🔐 审计日志已锚定：%d 条 → Merkle %s…（区块 #%d）', r.rowCount, r.merkleRoot.slice(0, 12), r.blockIndex);
      } catch (e) {
        console.warn('⚠ 审计日志锚定跳过：', e.message);
      }
    }, 24 * 3600 * 1000).unref();

    /* 秒级实时运转引擎：每秒推进内存指标（负荷曲线 + 累计量），
       按各自节奏轮询数据库（链 5s / 账户 10s / 结算 15s / 真实源 60s），
       通过 SSE(/api/real/stream) 与 WS(/ws/telemetry) 双通道推给前端。
       失败只告警：实时面板降级为静态快照，不影响核心业务。 */
    try {
      const rt = require('./services/realtime');
      const snap = await rt.start();
      await require('./routes/real').ensureDeclarations();
      console.log('⚡ 实时引擎已启动：%d 项指标 / %d ms tick / 国内 CEMS 读数 %d 条',
        snap.metrics.length, snap.tickMs,
        (snap.metrics.find((m) => m.key === 'real.cn_cems') || {}).value || 0);
    } catch (e) {
      console.error('⚠ 实时引擎启动跳过：', e.message);
    }

    /* 外部真实源周期同步：按各源登记的 TTL 判断是否该重新拉取。
       失败也写 data_ingest_log —— 否则"最近同步时间"会停在最后一次成功，
       看起来像"刚同步过、数据很新"，而实际可能已连续失败数天。 */
    try {
      const rs = require('./services/realSync');
      const st = rs.start();
      console.log('🔄 真实源同步器已启动：每 %d 分钟检查一次到期源', Math.round(st.checkMs / 60000));
    } catch (e) {
      console.error('⚠ 真实源同步器启动跳过：', e.message);
    }

    /* 重聚合页预热（2026-10-26 迭代）：/api/real/overview 冷聚合 33.9 万行要 6.8 s，
       首个访客必然撞上。启动 20 s 后（等 DB 与实时引擎就绪）后台自访一次，
       把聚合结果填进值缓存 —— 访客命中 5 ms。预热失败只告警，绝不影响服务。 */
    setTimeout(async () => {
      try {
        const t0 = Date.now();
        await new Promise((resolve, reject) => {
          require('http').get({ host: '127.0.0.1', port: config.port, path: '/api/real/overview' },
            (r) => { r.resume(); r.statusCode < 400 ? resolve() : reject(new Error('HTTP ' + r.statusCode)); })
            .on('error', reject);
        });
        console.log('🔥 /api/real/overview 预热完成（%d ms），首个访客直接命中缓存', Date.now() - t0);
      } catch (e) {
        console.warn('⚠ /api/real/overview 预热跳过：', e.message);
      }
    }, 20_000).unref();

    /* 源端真实化（WP1）：设备台账自举 + HJ 212 设备接入服务端。
       两者都幂等；TCP 端口被占用等异常只告警，不影响 HTTP 服务可用性。 */
    try {
      const registry = require('./services/deviceRegistry');
      const seeded = await registry.ensureSeeded();
      const regStats = await registry.stats();
      console.log('🏭 工业设备台账已就绪：设备 %d 台（在用 %d / 待审批 %d / 已吊销 %d），'
        + 'HJ 212 链路 %d 台%s',
      regStats.total, regStats.active, regStats.pending, regStats.revoked, regStats.hj212,
      seeded.created ? `（本次自举新增 ${seeded.created} 台）` : '');
    } catch (e) {
      console.error('⚠ 设备台账自举跳过：', e.message);
    }
    if (String(process.env.HJ212_AUTOSTART || '1') !== '0') {
      try {
        const hj = require('./services/hj212Server');
        const r = await hj.start();
        console.log('📡 HJ 212-2017 设备接入服务已监听 0.0.0.0:%d（协议子集见 /api/iot/factors）', r.port);
      } catch (e) {
        console.error('⚠ HJ 212 接入服务启动失败（HTTP 服务不受影响）：', e.message);
      }
    }

    /* WP6 审计日志哈希链：启动时幂等封印历史未封印条目。
       老库里的历史日志（entry_hash 为空）在此一次性链接成链；已封印则 sealed=0。 */
    try {
      const auditChain = require('./services/auditChain');
      const r = await auditChain.seal({ limit: 20000 });
      const s = await auditChain.stats();
      console.log('🧾 审计日志哈希链已就绪：共 %d 条（已封印 %d / 未封印 %d）%s',
        s.total, s.sealed, s.unsealed, r.sealed ? `（本次封印 ${r.sealed} 条）` : '');
    } catch (e) {
      console.error('⚠ 审计日志哈希链封印跳过（HTTP 服务不受影响）：', e.message);
    }

    /* 行数计数表一致性自愈（P2-8）：TRUNCATE 不触发 DELETE 触发器，
       若有人绕过常规路径清空 real_emission_year，row_counter 会漂移。
       每 6 小时对账一次：不一致即告警并用真实 COUNT(*) 修复
       （精确口径兜底，宁可慢一次对账也不让监管页显示漂移的数字）。 */
    setInterval(async () => {
      try {
        const db2 = require('./db');
        const [[rc]] = await db2.query(`SELECT row_count FROM row_counter WHERE table_name = 'real_emission_year'`);
        if (!rc) return;   // row_counter 未启用（旧库）→ 静默
        const [[ac]] = await db2.query('SELECT COUNT(*) AS n FROM real_emission_year');
        if (Number(rc.row_count) !== Number(ac.n)) {
          console.error('⚠ row_counter 与真实行数漂移：counter=%d actual=%d —— 已自动修复',
            Number(rc.row_count), Number(ac.n));
          await db2.query(`REPLACE INTO row_counter (table_name, row_count, updated_at)
            SELECT 'real_emission_year', COUNT(*), CURRENT_TIMESTAMP FROM real_emission_year`);
        }
      } catch (e) { /* 数据库不可用等：下个周期再对账 */ }
    }, 6 * 3600 * 1000).unref();

    /* 通知消息源定时刷新：从生态环境部 / 上海环交所 / ICAP 等权威源站
       实时抓取最新消息入库。启动 15 秒后首次执行（错开数据库初始化高峰），
       此后每 5 分钟一次（"实时碳消息"要求——4 个源站页面每 5 分钟各访问
       一次完全在友好限度内）；幂等入库（按标题去重），新消息经 noticeBus
       广播到 SSE 订阅者触发前端弹窗与铃铛闪烁。源站故障不影响服务。 */
    try {
      const feed = require('./services/noticeFeed');
      const FETCH_INTERVAL_MS = 5 * 60 * 1000;
      const runRefresh = async () => {
        try {
          const r = await feed.refresh();
          if (r.inserted) {
            console.log('📰 通知消息源刷新：新增 %d 条（已广播 SSE）', r.inserted);
          }
        } catch (e) {
          console.error('⚠ 通知消息源刷新失败（不影响服务）：', e.message);
        }
      };
      setTimeout(runRefresh, 15000);
      const noticeTimer = setInterval(runRefresh, FETCH_INTERVAL_MS);
      noticeTimer.unref?.();
      console.log('📰 通知消息源定时刷新已启用（每 5 分钟，新消息实时推送）');
    } catch (e) {
      console.error('⚠ 通知消息源刷新器初始化失败：', e.message);
    }
  } catch (e) {
    console.error('⚠ 区块链初始化失败（数据库未初始化？请先执行 npm run initdb）：', e.message);
  }

}

if (require.main === module) bootstrap();

/* ---------------- 优雅停机（P2-4）----------------
 * 此前没有 SIGTERM/SIGINT 处理：云平台重启/发布时进程被硬杀，
 * 在途请求被切断、连接池不回收。现在的顺序：
 *   停止接新连接 → 关 WS/定时器 → 给在途请求 5 s 排空 →
 *   强制断开残余长连接（SSE/WS 否则 close 永不回调）→ 关连接池 → 退出。
 * 20 s 强制兜底：任何一步卡死都不会让平台等超时后 SIGKILL。 */
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n↩ 收到 %s，开始优雅停机…', signal);
  const force = setTimeout(() => {
    console.error('✘ 20 s 内未完成排空，强制退出');
    process.exit(1);
  }, 20_000);
  if (force.unref) force.unref();
  try {
    try { require('./routes/telemetry').detach(); } catch (e) { /* 未挂载 */ }
    try { require('./services/hj212Server').stop?.(); } catch (e) { /* 未启动 */ }
    try { require('./services/realtime').stop?.(); } catch (e) { /* 未启动 */ }
    if (currentServer) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        currentServer.close(done);                                   // 停止接新连接，等在途请求
        setTimeout(() => {                                           // SSE/WS 长连接排空宽限
          try { if (currentServer.closeAllConnections) currentServer.closeAllConnections(); } catch (e) {}
          done();
        }, 5000).unref?.();
      });
    }
    try {
      const db = require('./db');
      await db.pool.end();
      await db.ledgerPool.end();
    } catch (e) { /* 池已关/未建 */ }
    clearTimeout(force);
    console.log('✔ 优雅停机完成');
    process.exit(0);
  } catch (e) {
    console.error('⚠ 停机流程异常：', e.message);
    process.exit(1);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
/* 供自定义启动器（server/scripts/start-prod.js）在完成数据库自检后调用 */
module.exports.bootstrap = bootstrap;
