/**
 * routes/notify.js —— 实时通知推送（SSE）
 * ==================================================================================
 * 【端点】
 *   GET /api/notify/stream   订阅实时通知流（公开——通知面向所有访客）
 *
 * 【事件流】
 *   event: hello    连接确认（携带服务器时间，供前端校准）
 *   event: notice   新通知到达（noticeFeed.noticeBus 'new' 事件转发）
 *   event: ping     心跳（20 秒，防止代理空闲断链）
 *
 * 【为什么用 SSE 而不是 WebSocket】
 * 通知是纯服务端 → 客户端的单向流；SSE 原生支持、自动重连、无需额外依赖。
 *
 * 【数据流全景】
 *   权威源站 ──5min 定时抓取──▶ noticeFeed.persist() ──noticeBus.emit('new')
 *     ──▶ 本路由 SSE ──▶ 浏览器 NoticeCenter：铃铛闪烁 + 弹窗 + 未读徽标
 *
 * @module routes/notify
 */
'use strict';

const express = require('express');
const router = express.Router();
const feed = require('../services/noticeFeed');
const { ok } = require('../middleware/auth');

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { /* 客户端已断开 */ }
  };

  /* 连接确认：前端收到 hello 才认为通道就绪（也用作"连上了"的日志点） */
  send('hello', { serverTime: new Date().toISOString() });

  /* 心跳：短于常见代理 30~60 秒空闲超时 */
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 20000);

  /* 新通知广播 → 转发给这个浏览器 */
  const onNew = (rows) => send('notice', { rows, at: new Date().toISOString() });
  feed.noticeBus.on('new', onNew);

  /* ⚠ 监听 res 的 close（不是 req 的）——req 'close' 在请求体读完时就触发。
   * 断开时必须移除 noticeBus 监听器，否则每个断开的连接都会泄漏一个监听器，
   * 长期运行后 refresh 一次会向 N 个死连接写入。 */
  res.on('close', () => {
    clearInterval(hb);
    feed.noticeBus.off('new', onNew);
    try { res.end(); } catch { /* ignore */ }
  });
});

/* 通道自检：向所有 SSE 订阅者广播一条演示通知（不落库）。
 * 用于验证"源站新消息 → SSE → 铃铛闪烁 + 弹窗"全链路，
 * 答辩演示也用它展示实时性。标题带时间戳——便于连续触发多次演示，
 * 且与前端按标题去重的增量检测不冲突。
 * ⚠ 2026-10-31 审计（A4/P3-02）：此端点会向**所有**已连接浏览器注入弹窗内容，
 * 匿名可调用即是内容注入面 —— 收紧为 ADMIN。/stream 本身保持公开：
 * 通知为公开发布内容（与 /notice 公开页同源），不构成泄露。 */
const { authRequired, requireRole } = require('../middleware/auth');
router.get('/test', authRequired, requireRole('ADMIN'), (req, res) => {
  const ts = new Date().toISOString().slice(11, 19);
  feed.noticeBus.emit('new', [{
    id: null,
    title: `【通道自检 ${ts}】实时通知链路正常 —— 这是一条演示推送，未写入数据库`,
    category: 'PLATFORM',
    categoryLabel: '平台公告',
    sourceName: '碳链通通知中心',
    sourceUrl: null,
    publishedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }]);
  ok(res, { pushed: true, at: ts });
});

module.exports = router;
