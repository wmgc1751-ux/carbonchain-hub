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

// 跨域（便于前端独立部署 / 本地调试）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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
app.use('/api/public', require('./routes/public'));

app.get('/api/health', async (req, res) => {
  try {
    const chain = await getChain();
    const stats = await chain.stats();
    ok(res, {
      status: 'UP', time: new Date().toISOString(),
      chainHeight: stats.height, node: stats.node, difficulty: stats.difficulty,
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
async function bootstrap() {
  try {
    const chain = await getChain();
    const stats = await chain.stats();
    console.log('⛓  区块链节点已就绪：高度=%d 区块=%d 交易=%d 难度=%d',
      stats.height, stats.totalBlocks, stats.confirmed, stats.difficulty);
  } catch (e) {
    console.error('⚠ 区块链初始化失败（数据库未初始化？请先执行 npm run initdb）：', e.message);
  }

  app.listen(config.port, config.host, () => {
    console.log('─'.repeat(64));
    console.log('  碳链通 CarbonChain Hub 已启动');
    console.log(`  访问地址: http://localhost:${config.port}`);
    console.log(`  API 前缀: http://localhost:${config.port}/api`);
    console.log('─'.repeat(64));
  });
}

if (require.main === module) bootstrap();

module.exports = app;
