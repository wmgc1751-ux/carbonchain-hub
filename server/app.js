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
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

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

/* ---------------- 业务路由 ---------------- */
app.use('/api/auth', require('./routes/auth'));
app.use('/api/enterprise', require('./routes/enterprise'));
app.use('/api/verifier', require('./routes/verifier'));
app.use('/api/regulator', require('./routes/regulator'));
app.use('/api/chain', require('./routes/chain'));
app.use('/api/consortium', require('./routes/consortium'));
app.use('/api/dynamic', require('./routes/dynamic'));
app.use('/api/credit', require('./routes/credit'));
app.use('/api/public', require('./routes/public'));

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

/* ---------------- 静态资源 ---------------- */
app.use(express.static(config.paths.public, { extensions: ['html'] }));

// SPA 兜底
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(config.paths.public, 'index.html'));
});

/* ---------------- 统一异常处理 ---------------- */
app.use((req, res) => fail(res, '接口不存在', 404));
app.use((err, req, res, next) => {
  console.error('[ERROR]', req.method, req.originalUrl, err.message);
  if (res.headersSent) return next(err);
  fail(res, err.message || '服务器内部错误', err.status || 500);
});

/* ---------------- 启动 ---------------- */

/** 启动前安全自检：关键密钥若为内置默认值，生产环境直接拒绝启动 */
function assertSecureConfig() {
  const problems = [];
  if (!process.env.JWT_SECRET) problems.push('JWT_SECRET 未设置（正在使用内置默认密钥，令牌可被伪造）');
  if (config.isProd && !process.env.DB_PASSWORD) problems.push('DB_PASSWORD 未设置（数据库使用默认口令）');
  if (config.isProd && !process.env.KEYSTORE_SECRET) problems.push('KEYSTORE_SECRET 未设置（链上私钥库将明文落盘）');
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
    try {
      const dyn = require('./services/dynamic');
      const ov = await dyn.bootstrap();
      dyn.startScheduler();
      console.log('📈 动态核算引擎已启动：实测读数 %d 条，覆盖企业 %d 家，高/中风险 %d/%d',
        ov.readings.total, ov.summary.enterprises, ov.summary.highRisk, ov.summary.mediumRisk);
    } catch (e) {
      console.error('⚠ 动态核算初始化跳过：', e.message);
    }
  } catch (e) {
    console.error('⚠ 区块链初始化失败（数据库未初始化？请先执行 npm run initdb）：', e.message);
  }

  app.listen(config.port, config.host, () => {
    console.log('─'.repeat(64));
    console.log('  碳链通 CarbonChain Hub 已启动');
    console.log(`  访问地址: http://localhost:${config.port}`);
    console.log(`  API 前缀: http://localhost:${config.port}/api`);
    console.log(`  运行模式: ${config.isCloud ? '云平台' : (config.isProd ? '生产' : '开发')}` +
      ` · 演示账号接口${config.demoAccounts ? '开放' : '关闭'}` +
      ` · 跨域${CORS_ORIGINS.length ? `白名单(${CORS_ORIGINS.length})` : (config.isProd ? '仅同源' : '宽松')}`);
    console.log('─'.repeat(64));
  });
}

if (require.main === module) bootstrap();

module.exports = app;
