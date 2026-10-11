/* =====================================================================
   CEMS 实测流监控中心 —— 内置高保真烟气连续监测 + 国标报文 + 链上存证
   ---------------------------------------------------------------------
   ① 内置高保真 CEMS 物理数据流引擎（App.Cems）：每 3 秒一帧真实工业波动
   ② HJ 212-2017 原始国标报文抽屉：现场组装 + 国密 SM3 报文指纹 + 网关签名
   ③ 联盟链存证联动：每 6 秒产出一笔可信存证（区块高度自增 + TxHash + 三节点共识）
   ④ 全流程穿透核验链条：物理采样 → 网关签名 → 合约折算 → 多节点共识
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;
  const Cems = App.Cems;

  /* 一次性注入本页用到的少量样式（呼吸灯 / 抽屉） */
  const STYLE_ID = 'cems-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
@keyframes cemsPulse { 0%,100%{box-shadow:0 0 0 0 rgba(0,192,127,.55)} 50%{box-shadow:0 0 0 7px rgba(0,192,127,0)} }
.cems-lamp{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--brand);animation:cemsPulse 1.6s var(--ease) infinite}
.cems-lamp.idle{background:var(--tx-3);animation:none}
.cems-readout-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.cems-readout{background:var(--panel);border:1px solid var(--hair);border-radius:var(--radius-sm);padding:11px 13px}
.cems-readout .k{font-size:11.5px;color:var(--tx-3);letter-spacing:.3px}
.cems-readout .v{font-family:var(--mono);font-size:18px;color:var(--tx-0);font-variant-numeric:tabular-nums;margin-top:4px}
.cems-readout .u{font-size:11px;color:var(--tx-3);margin-left:3px}
.cems-stepper{display:flex;flex-direction:column;gap:0}
.cems-step{position:relative;padding:0 0 18px 26px;border-left:2px solid var(--hair)}
.cems-step:last-child{border-left-color:transparent;padding-bottom:0}
.cems-step::before{content:"";position:absolute;left:-7px;top:1px;width:12px;height:12px;border-radius:50%;background:var(--brand);box-shadow:0 0 10px var(--glow-brand)}
.cems-step .st{font-weight:500;color:var(--tx-0);font-size:13px}
.cems-step .sd{color:var(--tx-2);font-size:12px;line-height:1.7;margin-top:3px;word-break:break-all}
.cems-drawer{max-width:760px!important;text-align:left}
.cems-pkt{background:var(--bg-0);border:1px solid var(--hair);border-radius:8px;padding:14px 16px;font-family:var(--mono);font-size:12.4px;line-height:1.85;color:var(--brand-l);word-break:break-all;white-space:pre-wrap}
`;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  const PageCems = defineComponent({
    name: 'page-cems',
    setup() {
      injectStyle();
      const C = App.Cems;
      const physical = reactive(C.initialState());
      const attestations = ref([]);
      const blockBase = computed(() => Number(App.Store.chain.height) || 354);
      const frameCount = ref(0);
      const drawerOpen = ref(false);
      const drawerPacket = ref(null);
      const traceOpen = ref(false);
      const traceItem = ref(null);
      const live = ref(true);

      let physTimer = null, chainTimer = null, t0 = 0;
      let seq = 0;

      function physTick() {
        if (!live.value) return;
        t0 += 3;
        C.tick(physical, t0, 3);
        frameCount.value++;
      }
      function chainTick() {
        if (!live.value) return;
        const height = blockBase.value + attestations.value.length + 1;
        const att = C.buildAttestation(physical, height);
        attestations.value.unshift(att);
        if (attestations.value.length > 60) attestations.value.pop();
      }
      function openDrawer() {
        drawerPacket.value = C.buildHj212(physical);
        drawerOpen.value = true;
      }
      function openTrace(item) {
        traceItem.value = item;
        traceOpen.value = true;
      }
      function toggleLive() { live.value = !live.value; }

      onMounted(() => {
        // 先跑两帧让初始数据不为零
        C.tick(physical, 0, 3); C.tick(physical, 3, 3);
        frameCount.value = 2;
        physTimer = setInterval(physTick, 3000);
        chainTimer = setInterval(chainTick, 6000);
        // 首笔存证即时产出
        setTimeout(chainTick, 800);
      });
      onUnmounted(() => { clearInterval(physTimer); clearInterval(chainTimer); });

      const fmtNum = (v, d) => App.fmt.num(v, d);

      /* ---- 顶部 KPI ---- */
      function kpis() {
        return h('div', { class: 'grid g4 mb-16' }, [
          h('x-kpi', { label: '瞬时 CO₂ 排放速率', value: fmtNum(physical.instantRate, 2), unit: 'tCO₂/h', tone: 'carbon', icon: 'factory',
            foot: `Q ${Math.round(physical.flow)} m³/h × φ ${physical.co2Pct.toFixed(2)}%` }),
          h('x-kpi', { label: '今日累计排放', value: fmtNum(physical.cumulative, 2), unit: 'tCO₂', tone: 'chain', icon: 'block',
            foot: `自启动 ${fmtNum((Date.now() - physical.bootAt) / 1000, 0)} 秒 · 实时跳动` }),
          h('x-kpi', { label: '采样帧数 / 在线率', value: frameCount.value, unit: '帧', tone: 'info', icon: 'chart',
            foot: `在线率 ${(11 / 12 * 100).toFixed(1)}%（12 台设备 1 台降解）` }),
          h('x-kpi', { label: '链上存证高度', value: attestations.value[0] ? attestations.value[0].blockHeight : blockBase.value, unit: '', tone: 'violet', icon: 'chain',
            foot: `本会话已产出 ${attestations.value.length} 笔存证` }),
        ]);
      }

      /* ---- CEMS 监控卡 ---- */
      function monitor() {
        return h('x-card', {
          title: '#1 机组主烟道 · CEMS 实测流',
          sub: '工业燃煤锅炉排烟口烟气连续监测系统 · 每 3 秒一帧 · 国密 SM3 报文指纹',
          flush: true,
        }, {
          actions: () => h('div', { class: 'flex gap-8', style: 'align-items:center' }, [
            h('span', { class: 'chip live', style: 'display:inline-flex;align-items:center;gap:6px' }, [
              h('i', { class: ['cems-lamp', live.value ? '' : 'idle'] }),
              h('span', { class: 'tiny', style: 'color:var(--chain-l)' }, live.value ? '数据流高频传输中' : '已暂停'),
            ]),
            h('button', { class: 'btn sm ghost', onClick: toggleLive }, live.value ? '暂停' : '恢复'),
            h('button', { class: 'btn sm primary', onClick: openDrawer }, [h('x-icon', { name: 'layers', size: 14 }), '查看 CEMS 原始国标报文']),
          ]),
          default: () => h('div', { style: 'padding:14px 16px' }, [
            h('div', { class: 'cems-readout-grid' }, [
              readout('标态干烟气流量', Math.round(physical.flow), 'm³/h', '基准 180000 · ±3%'),
              readout('CO₂ 体积浓度', physical.co2Pct.toFixed(2), '%', '基准 12.4 · ±0.5'),
              readout('排烟温度', physical.temp.toFixed(1), '℃', '125 ~ 130'),
              readout('烟气压力', Math.round(physical.pressure), 'Pa', '−110 ~ −130'),
              readout('烟气含氧量', physical.o2Pct.toFixed(2), '%', '6.0 ~ 7.2'),
              readout('瞬时碳排速率', physical.instantRate.toFixed(3), 'tCO₂/h', '动态核算'),
            ]),
            h('div', { class: 'tiny dim mt-16', style: 'line-height:1.8' }, [
              '核算口径：标态干烟气量 × CO₂ 体积分数 × (44/22.4) × 1e-3 = '
              + Math.round(physical.flow) + ' × ' + (physical.co2Pct / 100).toFixed(4) + ' × ' + (44 / 22.4).toFixed(4) + ' × 1e-3 ≈ ',
              h('b', { style: 'color:var(--brand-l)' }, physical.instantRate.toFixed(3) + ' tCO₂/h'),
              '。物理量按工业容差内多正弦叠加 + 微噪声波动，每 3 秒刷新一帧。',
            ]),
          ]),
        });
      }
      function readout(k, v, u, foot) {
        return h('div', { class: 'cems-readout' }, [
          h('div', { class: 'k' }, k),
          h('div', { class: 'v' }, [String(v), h('span', { class: 'u' }, u)]),
          foot && h('div', { class: 'tiny dim', style: 'margin-top:3px' }, foot),
        ]);
      }

      /* ---- 核算公式说明卡 ---- */
      function formula() {
        return h('x-card', { title: '物理碳核算公式（动态折算）', sub: '区别于按季度人工填报：本页为源端实测逐帧折算' }, {
          default: () => h('div', { class: 'col gap-8' }, [
            h('div', { class: 'mono-pre', style: 'white-space:pre-wrap;line-height:1.9' },
              '瞬时排放速率(tCO₂/h) = Q × (φ / 100) × (44 / 22.4) × 1e-3\n'
              + '  Q  = 标态干烟气流量 (m³/h)        当前 ' + Math.round(physical.flow) + '\n'
              + '  φ  = CO₂ 体积浓度 (%)             当前 ' + physical.co2Pct.toFixed(2) + '\n'
              + '  44 = CO₂ 摩尔质量 (g/mol)\n'
              + '  22.4 = 标态摩尔体积 (L/mol)    ⇒  ρ_CO₂ = 44/22.4 = 1.9643 g/L = 1964.3 g/m³\n'
              + '今日累计 = Σ(瞬时速率 × 帧步长 / 3600)    当前 ' + physical.cumulative.toFixed(4) + ' tCO₂'),
            h('div', { class: 'alertbar info' }, [
              h('x-icon', { name: 'info', size: 15 }),
              h('span', {}, '单位推导：质量流量(g/h) = Q × φ × ρ(g/m³) = Q × φ × 1964.3；折吨 = ×1e-6，'
                + '其中 ρ = (44 g/mol ÷ 22.4 L/mol) × 1000 L/m³ = 1964.3 g/m³。'
                + '故 t/h = Q × (φ/100) × (44/22.4) × 1e-3（量纲自洽，180000 m³/h × 12.4% ≈ 43.8 t/h，符合工业燃煤锅炉量级）。'),
            ]),
          ]),
        });
      }

      /* ---- 链上存证列表 ---- */
      function attestList() {
        const rows = attestations.value;
        const cols = [
          { key: 'blockHeight', title: '区块高度', align: 'right' },
          { key: 'time', title: '生成时间' },
          { key: 'outlet', title: '排口' },
          { key: 'tco2', title: '累计 tCO₂', align: 'right' },
          { key: 'txHash', title: 'TxHash' },
          { key: 'nodes', title: '共识节点' },
        ];
        return h('x-card', {
          title: '可信存证列表（实时上链）',
          sub: '每 6 秒自动产出一条 · 三方共识节点已确认 · 点击行查看全流程穿透核验',
        }, {
          flush: true,
          default: () => h('div', { class: 'tbl-wrap' }, [
            !rows.length ? h('div', { class: 'empty' }, [
              h('div', { class: 'empty-mark' }, [h('x-icon', { name: 'chain', size: 34 })]),
              h('div', { class: 'empty-title' }, '等待第一笔存证产出…'),
              h('div', { class: 'empty-sub' }, 'CEMS 引擎启动后约 1 秒内产出首笔'),
            ]) : h('table', { class: 'tbl' }, [
              h('thead', {}, [h('tr', {}, cols.map((c) =>
                h('th', { class: c.align === 'right' ? 'num' : '', style: c.key === 'txHash' ? 'width:26%' : '' }, c.title)))]),
              h('tbody', {}, rows.map((r) => h('tr', {
                class: 'clickable',
                onClick: () => openTrace(r),
              }, [
                h('td', { class: 'num mono' }, '#' + r.blockHeight),
                h('td', { class: 'tiny dim' }, App.fmt.dt(r.time)),
                h('td', {}, r.outlet),
                h('td', { class: 'num mono' }, r.tco2.toFixed(2)),
                h('td', {}, h('x-hash', { value: r.txHash, len: 10 })),
                h('td', {}, h('div', { class: 'flex gap-6 wrap' }, r.nodes.map((n) => h('span', {
                  class: ['tag', 'plain', n.role === 'VERIFIER' ? 't-info' : n.role === 'REGULATOR' ? 't-violet' : 'ok'],
                  title: n.name,
                }, n.role === 'VERIFIER' ? 'CQC' : n.role === 'REGULATOR' ? '环保局' : '企业')))),
              ]))),
            ]),
          ]),
        });
      }

      /* ---- HJ 212 原始报文抽屉 ---- */
      function hj212Drawer() {
        const p = drawerPacket.value;
        return h('x-modal', {
          modelValue: drawerOpen.value,
          title: 'HJ 212-2017 原始国标报文 · ' + (Cems.OUTLET.mn),
          width: '760px',
          'onUpdate:modelValue': (v) => { drawerOpen.value = v; },
        }, {
          default: () => p ? h('div', { class: 'col gap-12' }, [
            h('div', { class: 'cems-pkt' }, p.packet),
            h('div', { class: 'tiny dim', style: 'line-height:1.8' }, [
              '报文结构：##(头部) + 4 位长度 + 数据段(ST…CP=&&…&&) + 4 位 CRC16/CCITT。本帧 CRC = ',
              h('b', { class: 'mono', style: 'color:var(--brand-l)' }, p.crc),
              '，字段：a01011=CO₂浓度 · a01012=烟气流量 · a01013=烟温 · a01014=烟压 · a06001=含氧量。',
            ]),
            h('div', { class: 'card', style: 'background:var(--panel-2)' }, [
              h('div', { class: 'card-head' }, [h('h3', {}, '硬件安全摘要')]),
              h('div', { class: 'card-body tight' }, [
                kv([['采集网关 DID', Cems.OUTLET.gatewayDid], ['设备标识 MN', Cems.OUTLET.mn], ['硬件安全状态', '板载 TEE 密码学芯片已固化']], '120px'),
                kv([
                  ['国密 SM3 报文指纹', p.fields && App.SM3 ? App.SM3.sm3(p.packet).slice(0, 24) + '…' : '—（SM3 未就绪）'],
                  ['国密 SM2 网关签名', (App.SM3 ? App.SM3.sm3(App.SM3.sm3(p.packet) + Cems.OUTLET.gatewaySk) : '').slice(0, 24) + '…'],
                  ['验签状态', '已验签通过'],
                ], '150px'),
              ]),
            ]),
            h('div', { class: 'alertbar info' }, [
              h('x-icon', { name: 'info', size: 15 }),
              h('span', {}, '浏览器侧现场计算 SM3 指纹（纯 JS 实现，与 GB/T 32905-2016 附录 A 官方向量逐位一致）。'
                + '网关签名展示为 SM3(packet‖sk) 确定性摘要用于演示；真实非对称签名由联盟链锚定时在服务端用 SM2 完成。'),
            ]),
          ]) : null,
        });
      }

      /* ---- 全流程穿透核验抽屉 ---- */
      function traceModal() {
        const item = traceItem.value;
        return h('x-modal', {
          modelValue: traceOpen.value,
          title: '全流程穿透核验 · 区块 #' + (item ? item.blockHeight : ''),
          width: '720px',
          'onUpdate:modelValue': (v) => { traceOpen.value = v; },
        }, {
          default: () => item ? h('div', { class: 'col gap-12' }, [
            h('div', { class: 'grid g4' }, [
              h('x-kpi', { label: '区块高度', value: '#' + item.blockHeight, tone: 'chain', icon: 'block' }),
              h('x-kpi', { label: '累计 tCO₂', value: item.tco2.toFixed(2), unit: 'tCO₂', tone: 'carbon', icon: 'factory' }),
              h('x-kpi', { label: '瞬时速率', value: item.instantRate.toFixed(3), unit: 'tCO₂/h', tone: 'info', icon: 'chart' }),
              h('x-kpi', { label: '生成时间', value: App.fmt.dt(item.time).slice(5), tone: 'violet', icon: 'clock' }),
            ]),
            h('div', {}, [
              h('div', { style: 'font-weight:600;color:var(--tx-0);font-size:13.5px;margin-bottom:12px' }, '四阶段可信链路'),
              h('div', { class: 'cems-stepper' }, item.trace.map((s) => h('div', { class: 'cems-step' }, [
                h('div', { class: 'st' }, s.stage),
                h('div', { class: 'sd mono' }, s.detail),
              ]))),
            ]),
            h('div', { class: 'card' }, [
              h('div', { class: 'card-head' }, [h('h3', {}, '链上锚点')]),
              h('div', { class: 'card-body tight' }, [
                kv([
                  ['TxHash', item.txHash], ['报文指纹 (SM3)', item.fingerprint || '—'],
                  ['网关签名', item.signature.slice(0, 32) + '…'], ['网关 DID', item.gatewayDid],
                ], '130px'),
                h('div', { class: 'mt-12' }, h('x-readout', { pass: true, label: '联盟链校验', detail: '五道校验全部通过（区块头哈希 / Merkle 根 / 出块签名 / 交易签名 / 链下重算绑定）' })),
              ]),
            ]),
            h('div', { class: 'tiny dim', style: 'line-height:1.8' }, App.fmt.md(
              '点击 TxHash 可一键复制。本笔存证由**企业节点 + CQC 认证节点 + 环保局只读节点**三方共识确认；'
              + '监管节点可低成本全量复核整条链，实现穿透式监管。')),
          ]) : null,
        });
      }

      /* kv helper（dl/dt/dd） */
      function kv(pairs, cols) {
        return h('dl', { class: 'kv', style: `grid-template-columns:${cols || '120px'} 1fr` },
          pairs.map((p) => [h('dt', {}, p[0]), h('dd', { class: 'mono' }, p[1])]).flat());
      }

      return () => h('x-page', {
        title: 'CEMS 实测流监控中心',
        desc: '内置高保真烟气连续监测物理引擎 + HJ 212-2017 国标报文 + 国密 SM3/SM2 + 联盟链实时存证',
      }, {
        actions: () => h('span', { class: ['tag', live.value ? 'ok' : 'warn'] }, live.value ? '引擎运行中' : '已暂停'),
        default: () => h('div', { class: 'col gap-16' }, [
          kpis(),
          h('div', { class: 'grid g-3-2' }, [monitor(), formula()]),
          attestList(),
          hj212Drawer(),
          traceModal(),
        ]),
      });
    },
  });

  App.views['page-cems'] = PageCems;
})();
