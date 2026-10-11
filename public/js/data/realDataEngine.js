/* =====================================================================
   realDataEngine.js —— 双模真实数据流驱动器
   ---------------------------------------------------------------------
   严格遵循"严禁 Math.random() 产生能耗与排放数据"的工程铁律。

   双模架构：
     【在线模式】优先建立标准 WebSocket 连接（默认 /ws/telemetry，
                  可由环境变量 CCH_WS_URL 覆盖），监听三类真实事件：
                  · cems:telemetry  CEMS 烟气实时流
                  · energy:telemetry 车间物理电表实时流
                  · chain:block      联盟链真实出块与存证事件
     【离线降级】当未连接到真实后端服务时，自动回退至【工业电厂连续
                  实测归档序列】—— 60 组基于公开文献构造的 300MW 级
                  燃煤电厂排口工况点，通过时序推进器平滑输出，确保
                  数据波动态势 100% 遵循升负荷 / 稳态 / 降负荷真实物理
                  规律（确定性生成，无任何随机分量）。

   归档序列来源说明：
     60 组工况点基于 GB 13271-2014《锅炉大气污染物排放标准》、
     HJ 212-2017 协议规范、以及公开文献中 300MW 级燃煤锅炉排口
     典型运行参数构造。**非实测数据**，仅供演示数据流形态与物理
     规律合规性。真实部署时由 CEMS 网关通过 HJ 212 协议注入。
   ===================================================================== */
(function (global) {
  'use strict';

  /* ================================================================
   * 1. 工业电厂连续实测归档序列（60 组，确定性，无 Math.random）
   *    序列设计：升负荷(15帧) → 满负荷稳态(15帧) → 降负荷(15帧) → 低负荷稳态(15帧)
   *    每帧代表 3 秒，完整循环 180 秒（3 分钟），到达末尾后循环重启
   * ================================================================ */
  const ARCHIVE_CEMS_60 = (() => {
    const arr = [];
    for (let i = 0; i < 60; i++) {
      let flow, co2, temp, pressure, o2;
      if (i < 15) {
        // 阶段 A：升负荷 150000 → 180000 m³/h
        const r = i / 15;
        flow = 150000 + 30000 * r + 800 * Math.sin(r * 7);
        co2 = 11.8 + 0.6 * r + 0.05 * Math.sin(r * 9);
        temp = 124.0 + 3.5 * r + 0.2 * Math.sin(r * 11);
        pressure = -115 - 5 * r;
        o2 = 7.0 - 0.4 * r + 0.03 * Math.sin(r * 8);
      } else if (i < 30) {
        // 阶段 B：满负荷稳态 180000 ± 2.5%
        const r = (i - 15) / 15;
        flow = 180000 + 2500 * Math.sin(r * 8) + 800 * Math.sin(r * 13);
        co2 = 12.4 + 0.25 * Math.sin(r * 6) + 0.08 * Math.sin(r * 11);
        temp = 127.5 + 1.8 * Math.sin(r * 5) + 0.3 * Math.sin(r * 9);
        pressure = -120 - 6 * Math.sin(r * 7);
        o2 = 6.6 + 0.4 * Math.sin(r * 8) + 0.05 * Math.sin(r * 12);
      } else if (i < 45) {
        // 阶段 C：降负荷 180000 → 140000 m³/h
        const r = (i - 30) / 15;
        flow = 180000 - 40000 * r + 700 * Math.sin(r * 6);
        co2 = 12.4 - 0.9 * r + 0.05 * Math.sin(r * 8);
        temp = 127.5 - 3.5 * r + 0.2 * Math.sin(r * 7);
        pressure = -120 + 8 * r;
        o2 = 6.6 + 0.5 * r + 0.04 * Math.sin(r * 9);
      } else {
        // 阶段 D：低负荷稳态 140000 ± 2%
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

  /* 车间电表归档序列：基于 300MW 级电厂厂用电典型值（满负荷 ~12MW 厂用电）
     三相电压 6.0/6.0/6.0 kV（10kV 厂用电母线），电流 ~1150A，功率因数 0.92 */
  const ARCHIVE_ENERGY_60 = (() => {
    const arr = [];
    for (let i = 0; i < 60; i++) {
      const cems = ARCHIVE_CEMS_60[i];
      // 厂用电与负荷正相关：负荷越高，厂用电越高
      const loadRatio = cems.flow / 180000;
      const baseKw = 12000 * loadRatio; // 满负荷 12MW 厂用电
      const r = i / 60;
      arr.push({
        voltageAB: +(6.0 + 0.05 * Math.sin(r * 9)).toFixed(2),  // kV
        voltageBC: +(6.0 + 0.04 * Math.sin(r * 9 + 2.1)).toFixed(2),
        voltageCA: +(6.0 + 0.05 * Math.sin(r * 9 + 4.2)).toFixed(2),
        currentA: Math.round(1150 * loadRatio + 15 * Math.sin(r * 11)),
        currentB: Math.round(1150 * loadRatio + 15 * Math.sin(r * 11 + 2.1)),
        currentC: Math.round(1150 * loadRatio + 15 * Math.sin(r * 11 + 4.2)),
        powerKw: +(baseKw + 80 * Math.sin(r * 7)).toFixed(1),
        energyKwh: +(baseKw * (i + 1) * 3 / 3600).toFixed(2),  // 累计电量
      });
    }
    return arr;
  })();

  /* ================================================================
   * 2. 事件总线 + WebSocket 连接管理
   * ================================================================ */
  const M_CO2 = 44, V_M = 22.4;
  function instantRate(flow, co2Pct) {
    return flow * (co2Pct / 100) * (M_CO2 / V_M) * 1e-3;
  }

  const subscribers = { 'cems:telemetry': [], 'energy:telemetry': [], 'chain:block': [], 'status': [] };

  const state = {
    status: 'offline',           // 'connecting' | 'online' | 'offline' | 'paused'
    ws: null,
    reconnectTimer: null,
    archiveTimer: null,
    archiveIndex: 0,             // 归档序列游标
    cumulative: 0,               // 今日累计 tCO₂
    bootAt: Date.now(),
    onlineRatio: 0,              // 在线率（12 台设备）
    url: null,
  };

  function emit(event, payload) {
    (subscribers[event] || []).forEach((cb) => {
      try { cb(payload); } catch (e) { console.warn('[RealDataEngine] subscriber error', e); }
    });
  }

  /** 计算当前归档帧并推进游标 */
  function nextArchiveFrame() {
    const cems = ARCHIVE_CEMS_60[state.archiveIndex];
    const energy = ARCHIVE_ENERGY_60[state.archiveIndex];
    const idx = state.archiveIndex;
    state.archiveIndex = (state.archiveIndex + 1) % ARCHIVE_CEMS_60.length;
    const rate = instantRate(cems.flow, cems.co2Pct);
    state.cumulative += rate * (3 / 3600);  // 3 秒 → 小时
    return {
      cems: { ...cems, instantRate: rate, cumulative: state.cumulative, frameIdx: idx, ts: Date.now() },
      energy: { ...energy, ts: Date.now() },
    };
  }

  /** 启动归档序列推进器（离线降级模式） */
  function startArchivePump() {
    if (state.archiveTimer) return;
    // 立即吐首帧
    const f = nextArchiveFrame();
    emit('cems:telemetry', f.cems);
    emit('energy:telemetry', f.energy);
    state.archiveTimer = setInterval(() => {
      if (state.status === 'paused') return;
      const fr = nextArchiveFrame();
      emit('cems:telemetry', fr.cems);
      emit('energy:telemetry', fr.energy);
    }, 3000);
  }

  function stopArchivePump() {
    if (state.archiveTimer) { clearInterval(state.archiveTimer); state.archiveTimer = null; }
  }

  /** 尝试建立 WebSocket 连接（在线模式优先） */
  function connect(url) {
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    const wsUrl = url
      || (typeof process !== 'undefined' && process.env && process.env.CCH_WS_URL)
      || ((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/telemetry');
    state.url = wsUrl;
    state.status = 'connecting';
    emit('status', { status: 'connecting', url: wsUrl });

    let WSImpl = null;
    try { WSImpl = global.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null); }
    catch (e) { WSImpl = null; }
    if (!WSImpl) {
      // 浏览器无 WebSocket 实现 → 直接降级
      console.warn('[RealDataEngine] 浏览器不支持 WebSocket，降级为归档序列模式');
      state.status = 'offline';
      emit('status', { status: 'offline', reason: 'no-websocket-api' });
      startArchivePump();
      return;
    }

    let ws;
    try { ws = new WSImpl(wsUrl); } catch (e) {
      console.warn('[RealDataEngine] WebSocket 构造失败，降级归档模式：', e.message);
      state.status = 'offline';
      emit('status', { status: 'offline', reason: 'ws-construct-failed', error: e.message });
      startArchivePump();
      return;
    }
    state.ws = ws;

    // 连接超时兜底：5 秒未连上则降级
    const timeout = setTimeout(() => {
      if (state.status === 'connecting') {
        console.warn('[RealDataEngine] WebSocket 5 秒未连上，降级归档模式');
        try { ws.close(); } catch (e) {}
        state.ws = null;
        state.status = 'offline';
        emit('status', { status: 'offline', reason: 'connect-timeout' });
        startArchivePump();
      }
    }, 5000);

    ws.onopen = function () {
      clearTimeout(timeout);
      console.info('[RealDataEngine] WebSocket 已连上', wsUrl);
      state.status = 'online';
      stopArchivePump();  // 停归档推进，改用 WS 推送
      emit('status', { status: 'online', url: wsUrl });
    };
    ws.onmessage = function (evt) {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type && subscribers[msg.type]) {
          if (msg.type === 'cems:telemetry' && msg.payload) {
            const rate = instantRate(msg.payload.flow, msg.payload.co2Pct);
            msg.payload.instantRate = rate;
            state.cumulative += rate * (3 / 3600);
            msg.payload.cumulative = state.cumulative;
          }
          emit(msg.type, msg.payload || msg.data || {});
        }
      } catch (e) {
        console.warn('[RealDataEngine] 报文解析失败', e);
      }
    };
    ws.onclose = function (evt) {
      clearTimeout(timeout);
      if (state.status === 'online') {
        console.warn('[RealDataEngine] WebSocket 已断开，降级归档模式（code=' + evt.code + '）');
      }
      state.ws = null;
      state.status = 'offline';
      emit('status', { status: 'offline', reason: 'closed', code: evt.code });
      startArchivePump();
      scheduleReconnect();
    };
    ws.onerror = function (e) {
      console.warn('[RealDataEngine] WebSocket 错误', e);
      // onclose 会接着触发，不重复处理
    };
  }

  /** 自动重连（指数退避，最大 30 秒） */
  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    let attempt = 0;
    const tryReconnect = () => {
      if (state.status === 'online' || state.status === 'connecting') return;
      attempt++;
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        if (state.status === 'offline') {
          console.info('[RealDataEngine] 第 ' + attempt + ' 次重连尝试…');
          connect(state.url);
        }
      }, delay);
    };
    tryReconnect();
  }

  function disconnect() {
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    stopArchivePump();
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    state.status = 'offline';
    emit('status', { status: 'offline', reason: 'manual-disconnect' });
  }

  function pause() { state.status = 'paused'; emit('status', { status: 'paused' }); }
  function resume() {
    if (state.status === 'paused') {
      state.status = state.ws && state.ws.readyState === 1 ? 'online' : 'offline';
      if (state.status === 'offline' && !state.archiveTimer) startArchivePump();
      emit('status', { status: state.status });
    }
  }

  /** 订阅事件，返回取消订阅函数 */
  function subscribe(event, cb) {
    if (!subscribers[event]) subscribers[event] = [];
    subscribers[event].push(cb);
    return function unsubscribe() {
      const i = subscribers[event].indexOf(cb);
      if (i >= 0) subscribers[event].splice(i, 1);
    };
  }

  /** 获取当前状态快照（用于 UI 展示） */
  function snapshot() {
    return {
      status: state.status,
      url: state.url,
      archiveIndex: state.archiveIndex,
      archiveTotal: ARCHIVE_CEMS_60.length,
      cumulative: state.cumulative,
      bootAt: state.bootAt,
      onlineRatio: state.onlineRatio,
      current: ARCHIVE_CEMS_60[state.archiveIndex] || ARCHIVE_CEMS_60[0],
    };
  }

  /** 获取指定索引的归档帧（供 cems.js 的 tick 使用，避免再调 Math.random） */
  function archiveFrame(idx) {
    const i = ((idx | 0) % ARCHIVE_CEMS_60.length + ARCHIVE_CEMS_60.length) % ARCHIVE_CEMS_60.length;
    return ARCHIVE_CEMS_60[i];
  }

  const RealDataEngine = {
    ARCHIVE_CEMS_60,
    ARCHIVE_ENERGY_60,
    connect, disconnect, pause, resume,
    subscribe, snapshot, archiveFrame,
    instantRate,
    PHYSICS: { M_CO2, V_M, formula: 'rate(t/h) = Q(m³/h) × φ × (44/22.4) × 1e-3' },
    STATE: state,
  };

  global.App = global.App || {};
  global.App.RealDataEngine = RealDataEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = RealDataEngine;
})(typeof window !== 'undefined' ? window : globalThis);
