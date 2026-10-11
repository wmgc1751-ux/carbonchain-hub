/**
 * routes/telemetry.js —— 工业物联网 WebSocket 实时通道
 * ------------------------------------------------------------------
 * 双模架构的服务端侧：
 *   · 在线模式：浏览器连 /ws/telemetry，服务端推送归档序列帧
 *   · 真实部署：CEMS 网关通过 HJ 212 协议注入真实数据，本服务透传
 *
 * 事件类型（与前端 realDataEngine.js 对齐）：
 *   · cems:telemetry   CEMS 烟气实时流
 *   · energy:telemetry  车间物理电表实时流
 *   · chain:block       联盟链真实出块事件（从链上取最新区块）
 *   · status            连接状态
 *
 * 容错策略：ws 库未安装时跳过 WS 端点，前端连不上会自动降级归档模式。
 * 归档序列与前端 realDataEngine.js 同源（确定性生成，无随机分量）。
 */
'use strict';

let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; }
catch (e) {
  console.warn('[telemetry] ws 库未安装，WebSocket 端点跳过（前端将降级归档模式）。npm install ws 后可用。');
}

const M_CO2 = 44, V_M = 22.4;
function instantRate(flow, co2Pct) { return flow * (co2Pct / 100) * (M_CO2 / V_M) * 1e-3; }

/* 归档序列：60 组 300MW 级燃煤电厂排口典型工况（与前端 realDataEngine.js 同源）
   基于公开文献构造，非实测数据，仅供演示数据流形态与物理规律合规性。
   序列：升负荷(15) → 满负荷稳态(15) → 降负荷(15) → 低负荷稳态(15) */
const ARCHIVE_CEMS_60 = (() => {
  const arr = [];
  for (let i = 0; i < 60; i++) {
    let flow, co2, temp, pressure, o2;
    if (i < 15) {
      const r = i / 15;
      flow = 150000 + 30000 * r + 800 * Math.sin(r * 7);
      co2 = 11.8 + 0.6 * r + 0.05 * Math.sin(r * 9);
      temp = 124.0 + 3.5 * r + 0.2 * Math.sin(r * 11);
      pressure = -115 - 5 * r;
      o2 = 7.0 - 0.4 * r + 0.03 * Math.sin(r * 8);
    } else if (i < 30) {
      const r = (i - 15) / 15;
      flow = 180000 + 2500 * Math.sin(r * 8) + 800 * Math.sin(r * 13);
      co2 = 12.4 + 0.25 * Math.sin(r * 6) + 0.08 * Math.sin(r * 11);
      temp = 127.5 + 1.8 * Math.sin(r * 5) + 0.3 * Math.sin(r * 9);
      pressure = -120 - 6 * Math.sin(r * 7);
      o2 = 6.6 + 0.4 * Math.sin(r * 8) + 0.05 * Math.sin(r * 12);
    } else if (i < 45) {
      const r = (i - 30) / 15;
      flow = 180000 - 40000 * r + 700 * Math.sin(r * 6);
      co2 = 12.4 - 0.9 * r + 0.05 * Math.sin(r * 8);
      temp = 127.5 - 3.5 * r + 0.2 * Math.sin(r * 7);
      pressure = -120 + 8 * r;
      o2 = 6.6 + 0.5 * r + 0.04 * Math.sin(r * 9);
    } else {
      const r = (i - 45) / 15;
      flow = 140000 + 1800 * Math.sin(r * 7) + 600 * Math.sin(r * 12);
      co2 = 11.5 + 0.2 * Math.sin(r * 5) + 0.06 * Math.sin(r * 10);
      temp = 124.0 + 1.5 * Math.sin(r * 4) + 0.2 * Math.sin(r * 8);
      pressure = -112 + 4 * Math.sin(r * 6);
      o2 = 7.1 + 0.3 * Math.sin(r * 7) + 0.04 * Math.sin(r * 11);
    }
    arr.push({
      flow: Math.round(flow),
      co2Pct: +co2.toFixed(2),
      temp: +temp.toFixed(1),
      pressure: Math.round(pressure),
      o2Pct: +o2.toFixed(2),
    });
  }
  return arr;
})();

const ARCHIVE_ENERGY_60 = (() => {
  const arr = [];
  for (let i = 0; i < 60; i++) {
    const cems = ARCHIVE_CEMS_60[i];
    const loadRatio = cems.flow / 180000;
    const baseKw = 12000 * loadRatio;
    const r = i / 60;
    arr.push({
      voltageAB: +(6.0 + 0.05 * Math.sin(r * 9)).toFixed(2),
      voltageBC: +(6.0 + 0.04 * Math.sin(r * 9 + 2.1)).toFixed(2),
      voltageCA: +(6.0 + 0.05 * Math.sin(r * 9 + 4.2)).toFixed(2),
      currentA: Math.round(1150 * loadRatio + 15 * Math.sin(r * 11)),
      currentB: Math.round(1150 * loadRatio + 15 * Math.sin(r * 11 + 2.1)),
      currentC: Math.round(1150 * loadRatio + 15 * Math.sin(r * 11 + 4.2)),
      powerKw: +(baseKw + 80 * Math.sin(r * 7)).toFixed(1),
      energyKwh: +(baseKw * (i + 1) * 3 / 3600).toFixed(2),
    });
  }
  return arr;
})();

let handles = null;

function attach(server) {
  if (!WebSocketServer) return null;
  if (handles) return handles;  // 防止重复挂载

  const wss = new WebSocketServer({ server, path: '/ws/telemetry' });
  let idx = 0;
  let cumulative = 0;

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    wss.clients.forEach((c) => { if (c.readyState === 1) try { c.send(msg); } catch (e) {} });
  }

  /* 3 秒推一帧 CEMS + 能耗（归档序列） */
  const telemetryTimer = setInterval(() => {
    const cems = ARCHIVE_CEMS_60[idx];
    const energy = ARCHIVE_ENERGY_60[idx];
    const rate = instantRate(cems.flow, cems.co2Pct);
    cumulative += rate * (3 / 3600);
    broadcast('cems:telemetry', { ...cems, instantRate: rate, cumulative, frameIdx: idx, ts: Date.now() });
    broadcast('energy:telemetry', { ...energy, ts: Date.now() });
    idx = (idx + 1) % ARCHIVE_CEMS_60.length;
  }, 3000);

  /* 6 秒推一帧 chain:block（从真实链上取最新区块） */
  const chainTimer = setInterval(() => {
    (async () => {
      try {
        const anchorSvc = require('../services/anchor');
        const chain = await anchorSvc.getChain();
        const stats = await chain.stats();
        broadcast('chain:block', {
          blockHeight: stats.height,
          totalBlocks: stats.totalBlocks,
          confirmed: stats.confirmed,
          consensus: stats.consensusMode || 'POA',
          ts: Date.now(),
        });
      } catch (e) { /* 链未就绪时静默 */ }
    })();
  }, 6000);

  wss.on('connection', (ws) => {
    /* 连上立即推一帧 + 状态 */
    const cems = ARCHIVE_CEMS_60[idx];
    const energy = ARCHIVE_ENERGY_60[idx];
    const rate = instantRate(cems.flow, cems.co2Pct);
    try {
      ws.send(JSON.stringify({ type: 'cems:telemetry', payload: { ...cems, instantRate: rate, cumulative, frameIdx: idx, ts: Date.now() } }));
      ws.send(JSON.stringify({ type: 'energy:telemetry', payload: { ...energy, ts: Date.now() } }));
      ws.send(JSON.stringify({ type: 'status', payload: { status: 'online', archiveIndex: idx, total: ARCHIVE_CEMS_60.length } }));
    } catch (e) {}
    ws.on('message', (raw) => {
      /* 预留：真实部署时 CEMS 网关可注入 HJ 212 报文，服务端解析后广播 */
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'cems:inject') {
          /* 真实网关注入：透传给所有客户端 */
          broadcast('cems:telemetry', msg.payload);
        }
      } catch (e) {}
    });
  });

  console.log('[telemetry] WebSocket 端点已就绪：/ws/telemetry');
  handles = { wss, telemetryTimer, chainTimer };
  return handles;
}

function detach() {
  if (!handles) return;
  if (handles.telemetryTimer) clearInterval(handles.telemetryTimer);
  if (handles.chainTimer) clearInterval(handles.chainTimer);
  if (handles.wss) try { handles.wss.close(); } catch (e) {}
  handles = null;
}

module.exports = { attach, detach, ARCHIVE_CEMS_60, ARCHIVE_ENERGY_60, instantRate };
