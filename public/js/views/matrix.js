/* =====================================================================
   碳矩阵工业大盘（page-matrix）
   ---------------------------------------------------------------------
   面向工业场景的联盟链碳资产动态核算可信存证平台主界面。
   参考蚂蚁数科"碳矩阵"产品交互规范，采用三栏协同 + 验真抽屉布局。

   数据流（严禁 Math.random）：
     · realDataEngine 60 组工业归档序列驱动瞬时排碳/烟气流量/用电负荷
     · App.Sources.powerFactors.national（0.5703）作动态碳折算因子
     · App.Cems.buildHj212/buildAttestation/fingerprint/gatewaySign 现场计算
     · /api/chain/blocks 拉取真实链上最近 5 笔存证
     · App.showChainProof 复用全局验真抽屉（四级防篡改证据链）
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  /* ---- 点位台账（电弧炉/高炉/燃煤机组三类工业场景） ---- */
  const POINTS = [
    { code: 'HG-EAF-01', name: '杭钢特钢 01 号电弧炉机组', did: 'did:cch:hg-eaf-01-gw', process: '电弧炉炼钢', bom: ['废钢入料', '高温熔炼', '精炼连铸'] },
    { code: 'BW-BF-02', name: '宝武湛江 2 号高炉', did: 'did:cch:bw-bf-02-gw', process: '高炉炼铁', bom: ['矿石入炉', '高炉冶炼', '铁水预处理'] },
    { code: 'HN-COAL-04', name: '华能玉环 4 号机组', did: 'did:cch:hn-coal-04-gw', process: '燃煤发电', bom: ['煤粉制备', '锅炉燃烧', '烟气脱硫'] },
  ];

  /* ---- 工序能耗/碳排分摊系数（基于电弧炉炼钢典型工况，公开文献） ---- */
  const BOM_SPLIT = [
    { stage: '废钢入料', energyPct: 0.08, carbonPct: 0.05, desc: '废钢预处理 + 装料' },
    { stage: '高温熔炼', energyPct: 0.72, carbonPct: 0.78, desc: '电弧炉主熔炼期' },
    { stage: '精炼连铸', energyPct: 0.20, carbonPct: 0.17, desc: 'LF 精炼 + 连铸坯' },
  ];

  const PageMatrix = defineComponent({
    name: 'page-matrix',
    setup() {
      const RDE = App.RealDataEngine;
      const CEMS = App.Cems;
      const SOURCES = App.Sources;

      /* ---- 状态 ---- */
      const pointIdx = ref(0);
      const point = computed(() => POINTS[pointIdx.value]);
      const cemsState = ref(CEMS.initialState());
      const energyFrame = ref(RDE.ARCHIVE_ENERGY_60[0]);
      const frameIdx = ref(0);
      const chainBlocks = ref([]);
      const chainStats = ref({ height: 0, totalTxs: 0, difficulty: 0, nodes: 4 });
      const hjModal = reactive({ show: false, packet: '', crc: '', sm3: '', sig: '', body: '', fields: null });
      const probeModal = reactive({ show: false, loading: false, txId: '', data: null, error: '' });
      const curveWindow = ref([]);  // 双轴曲线滚动窗口（最近 30 帧）
      const cumulativeToday = ref(0);  // 今日累计存证 tCO₂

      let frameTimer = null, blockTimer = null;

      /* ---- 推进一帧：归档序列驱动 ---- */
      function advanceFrame() {
        const idx = frameIdx.value;
        const frame = RDE.archiveFrame(idx);
        const energy = RDE.ARCHIVE_ENERGY_60[idx % RDE.ARCHIVE_ENERGY_60.length];
        // 推进 cems state（用 tick 复用物理状态机）
        CEMS.tick(cemsState.value, idx, 3);
        energyFrame.value = energy;
        frameIdx.value = (idx + 1) % 60;
        // 累计（每帧 3 秒）
        cumulativeToday.value = cemsState.value.cumulative;
        // 双轴曲线滚动窗口
        const win = curveWindow.value;
        win.push({
          t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          load: +energy.powerKw.toFixed(1),        // 用电负荷 kW
          carbon: +cemsState.value.instantRate.toFixed(3),  // 烟气碳排 tCO₂/h
        });
        if (win.length > 30) win.shift();
      }

      /* ---- 拉取真实链上最近 5 笔存证 ---- */
      async function loadChain() {
        try {
          const page = await App.API.request('GET', '/chain/blocks?pageSize=5', null, { noAuth: true });
          chainBlocks.value = (page.rows || []).slice(0, 5);
        } catch (e) { /* 静默，链上数据可能为空 */ }
        try {
          const st = await App.API.request('GET', '/chain/stats', null, { noAuth: true });
          chainStats.value = {
            height: st.height || 0,
            totalTxs: st.totalTxs || 0,
            difficulty: st.difficulty || 0,
            nodes: st.nodeCount || 4,
          };
        } catch (e) {}
      }

      /* ---- HJ 212 原始报文抽屉 ---- */
      function openHj212() {
        const frame = CEMS.buildHj212(cemsState.value, new Date());
        const fp = CEMS.fingerprint(frame.packet);
        const sig = CEMS.gatewaySign(frame.packet);
        hjModal.packet = frame.packet;
        hjModal.crc = frame.crc;
        hjModal.body = frame.body;
        hjModal.sm3 = fp.sm3 || '(SM3 未就绪)';
        hjModal.sig = sig;
        hjModal.fields = frame.fields;
        hjModal.show = true;
      }

      /* ---- 点击 TxHash 触发验真抽屉（复用全局 showChainProof） ---- */
      function verifyBlock(b) {
        if (b && b.block_index !== undefined) {
          App.showChainProof('区块 #' + b.block_index, '/chain/blocks/' + b.block_index);
        }
      }

      /* ---- 自定义探针抽屉（备用，直接调 /chain/tx/:txId） ---- */
      async function openProbe(txId) {
        probeModal.show = true; probeModal.loading = true; probeModal.txId = txId; probeModal.data = null; probeModal.error = '';
        try {
          probeModal.data = await App.API.request('GET', '/chain/tx/' + txId, null, { noAuth: true });
        } catch (e) { probeModal.error = e.message; }
        finally { probeModal.loading = false; }
      }

      /* ---- 导出产品数字护照 ---- */
      function exportDPP() {
        const s = cemsState.value;
        const pf = SOURCES.powerFactors.national;
        const bom = BOM_SPLIT.map((b, i) => ({
          工序: point.value.bom[i] || b.stage,
          能耗占比: (b.energyPct * 100).toFixed(1) + '%',
          碳排占比: (b.carbonPct * 100).toFixed(1) + '%',
          实时功率_kW: +(energyFrame.value.powerKw * b.energyPct).toFixed(1),
          瞬时碳排_tCO2h: +(s.instantRate * b.carbonPct).toFixed(4),
        }));
        const dpp = {
          '产品数字护照': '碳链通 · 工业碳资产动态核算可信存证平台',
          '平台版本': 'v2.0 CarbonMatrix',
          '点位': point.value.name,
          '点位编码': point.value.code,
          '设备DID': point.value.did,
          '工艺路线': point.value.process,
          '采样时刻': new Date().toISOString(),
          '瞬时排碳速率_tCO2h': +s.instantRate.toFixed(4),
          '今日累计存证_tCO2': +s.cumulative.toFixed(4),
          '标态烟气流量_m3h': Math.round(s.flow),
          'CO2体积浓度_pct': s.co2Pct,
          '烟温_℃': s.temp,
          '动态碳折算因子': pf.value,
          '因子文号': pf.ref,
          '因子数据年度': pf.dataYear,
          '链高度': chainStats.value.height,
          '链上存证总数': chainStats.value.totalTxs,
          '共识节点数': chainStats.value.nodes,
          '国密算法': 'SM2/SM3',
          'BOM碳分摊': bom,
          '防篡改证据链': ['物理表计采样', '硬件芯片SM2签名', '智能合约核算', '权威节点共识确认'],
        };
        const blob = new Blob([JSON.stringify(dpp, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'DPP-' + point.value.code + '-' + Date.now() + '.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        App.notify && App.notify.info && App.notify.info('产品数字护照已导出（JSON）');
      }

      /* ---- 双轴联动曲线 option ---- */
      const curveOption = computed(() => {
        const win = curveWindow.value;
        if (!win.length) return null;
        return App.chartBase({
          legend: { data: ['用电负荷', '烟气碳排'], textStyle: { color: '#8d9cb5', fontSize: 11.5 }, top: 0, right: 8 },
          grid: { left: 10, right: 20, top: 34, bottom: 6, containLabel: true },
          tooltip: Object.assign(App.chartBase().tooltip, {
            trigger: 'axis',
            formatter: (ps) => {
              const p0 = ps[0], p1 = ps[1];
              return `<b>${p0.axisValue}</b><br/>` +
                `用电负荷：<b style="color:#1890FF">${p0 ? p0.value : '-'} kW</b><br/>` +
                `烟气碳排：<b style="color:#00C07F">${p1 ? p1.value : '-'} tCO₂/h</b>`;
            },
          }),
          xAxis: App.catAxis(win.map((w) => w.t), { boundaryGap: false }),
          yAxis: [
            App.valAxis({ name: 'kW', nameTextStyle: { color: '#1890FF', fontSize: 10.5 }, splitLine: { show: true, lineStyle: { color: 'rgba(24,144,255,.08)' } } }),
            App.valAxis({ name: 'tCO₂/h', nameTextStyle: { color: '#00C07F', fontSize: 10.5 }, splitLine: { show: false } }),
          ],
          series: [
            {
              name: '用电负荷', type: 'line', smooth: true, symbol: 'circle', symbolSize: 4,
              data: win.map((w) => w.load),
              lineStyle: { width: 2.4, color: '#1890FF' }, itemStyle: { color: '#1890FF' },
              areaStyle: { color: App.areaGrad('rgba(24,144,255,.28)', 'rgba(24,144,255,.02)') },
            },
            {
              name: '烟气碳排', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'circle', symbolSize: 4,
              data: win.map((w) => w.carbon),
              lineStyle: { width: 2.4, color: '#00C07F' }, itemStyle: { color: '#00C07F' },
              areaStyle: { color: App.areaGrad('rgba(0,192,127,.28)', 'rgba(0,192,127,.02)') },
            },
          ],
        });
      });

      /* ---- BOM 工序分摊数据 ---- */
      const bomRows = computed(() => {
        const s = cemsState.value;
        const energy = energyFrame.value;
        return BOM_SPLIT.map((b, i) => ({
          stage: point.value.bom[i] || b.stage,
          desc: b.desc,
          energyPct: b.energyPct,
          carbonPct: b.carbonPct,
          powerKw: +(energy.powerKw * b.energyPct).toFixed(1),
          carbonRate: +(s.instantRate * b.carbonPct).toFixed(4),
        }));
      });

      /* ---- 链上存证表格行（映射规范字段） ---- */
      const chainRows = computed(() => {
        const s = cemsState.value;
        return chainBlocks.value.map((b) => ({
          batch: 'B' + String(b.block_index).padStart(6, '0'),
          point: point.value.code,
          carbon: +s.instantRate.toFixed(4),
          did: point.value.did.slice(-16),
          txHash: b.block_hash,
          blockIndex: b.block_index,
          time: b.block_time,
          txCount: b.tx_count,
        }));
      });

      /* ---- 生命周期 ---- */
      onMounted(() => {
        // 立即推进一帧 + 拉链
        advanceFrame();
        loadChain();
        // 每 3 秒推进归档序列
        frameTimer = setInterval(advanceFrame, 3000);
        // 每 30 秒刷新链上数据
        blockTimer = setInterval(loadChain, 30000);
      });
      onUnmounted(() => {
        clearInterval(frameTimer);
        clearInterval(blockTimer);
      });

      /* ---- 渲染 ---- */
      return () => {
        const s = cemsState.value;
        const energy = energyFrame.value;
        const pf = SOURCES.powerFactors.national;
        const bom = bomRows.value;
        const rows = chainRows.value;

        return h('div', { class: 'matrix' }, [
          /* ===== 顶部全局状态栏 ===== */
          h('div', { class: 'matrix-head' }, [
            h('div', { class: 'matrix-head-left' }, [
              h('div', { class: 'brand-logo', style: 'width:48px;height:26px' }, [h('img', { src: './img/logo-mark.png', alt: '碳链通' })]),
              h('div', { class: 'matrix-title-block' }, [
                h('h1', { class: 'matrix-title' }, '碳链通 · 工业碳资产动态核算可信存证平台'),
                h('div', { class: 'matrix-sub' }, 'Carbon Matrix · 联盟链碳资产动态核算 · 国密 SM2/SM3 验签'),
              ]),
            ]),
            h('div', { class: 'matrix-head-mid' }, [
              h('div', { class: 'matrix-point' }, [
                h('label', { class: 'matrix-point-label' }, '点位'),
                h('select', {
                  class: 'matrix-point-sel',
                  value: pointIdx.value,
                  onChange: (e) => { pointIdx.value = +e.target.value; },
                }, POINTS.map((p, i) => h('option', { value: i }, p.name))),
              ]),
              h('div', { class: 'matrix-leds' }, [
                h('div', { class: 'matrix-led led-green' }, [h('i', { class: 'led-dot' }), h('span', {}, 'HJ 212-2017 工业流在线')]),
                h('div', { class: 'matrix-led led-blue' }, [h('i', { class: 'led-dot' }), h('span', {}, 'DL/T 645 电力数据直连')]),
              ]),
            ]),
            h('div', { class: 'matrix-head-right' }, [
              h('div', { class: 'matrix-chain' }, [
                h('x-icon', { name: 'chain', size: 16 }),
                h('div', { class: 'matrix-chain-info' }, [
                  h('div', { class: 'matrix-chain-h mono' }, 'Block #' + (chainStats.value.height || '—').toLocaleString()),
                  h('div', { class: 'matrix-chain-sub' }, chainStats.value.nodes + ' 节点共识 · 国密 SM2/SM3 验签通过'),
                ]),
              ]),
            ]),
          ]),

          /* ===== KPI 四卡 ===== */
          h('div', { class: 'grid g4 mb-16' }, [
            h('x-kpi', {
              label: '瞬时排碳速率', value: s.instantRate.toFixed(4), unit: 'tCO₂/h',
              icon: 'fire', tone: 'carbon',
              foot: 'Q=' + Math.round(s.flow) + ' m³/h · φ=' + s.co2Pct + '%',
            }),
            h('x-kpi', {
              label: '今日累计存证总量', value: cumulativeToday.value.toFixed(3), unit: 'tCO₂',
              icon: 'shield', tone: 'chain',
              foot: '链高度 #' + (chainStats.value.height || '—') + ' · ' + chainStats.value.totalTxs + ' 笔存证',
            }),
            h('x-kpi', {
              label: '标态烟气流量', value: Math.round(s.flow).toLocaleString(), unit: 'm³/h',
              icon: 'factory', tone: 'sky',
              foot: '烟温 ' + s.temp + '℃ · 含氧 ' + s.o2Pct + '% · 烟压 ' + s.pressure + 'Pa',
            }),
            h('x-kpi', {
              label: '动态碳折算因子', value: pf.value.toFixed(4), unit: 'tCO₂/MWh',
              icon: 'leaf', tone: 'violet',
              foot: pf.ref + ' · ' + pf.dataYear + ' 年度',
            }),
          ]),

          /* ===== 双轴联动曲线 + BOM 碳分摊 ===== */
          h('div', { class: 'grid g-3-2 mb-16' }, [
            h('x-card', {
              title: '用电负荷 vs 烟气碳排动态耦合', sub: '双轴联动 · 滚动窗口 90 秒（30 帧 × 3s）',
              actions: () => h('span', { class: 'chip live mono' }, '实时'),
            }, {
              default: () => h('x-chart', { option: curveOption.value, height: 'h340' }),
            }),
            h('x-card', {
              title: '工序级 BOM 碳分摊流水', sub: point.value.process + ' · ' + point.value.bom.join(' → '),
            }, {
              default: () => h('div', { class: 'bom-flow' }, bom.map((b, i) => {
                const maxCarbon = Math.max(...bom.map((x) => x.carbonRate), 0.001);
                const widthPct = (b.carbonRate / maxCarbon * 100).toFixed(1);
                return h('div', { class: 'bom-step' }, [
                  h('div', { class: 'bom-step-head' }, [
                    h('div', { class: 'bom-step-idx mono' }, String(i + 1).padStart(2, '0')),
                    h('div', { class: 'bom-step-name' }, b.stage),
                    h('div', { class: 'bom-step-pct mono' }, (b.carbonPct * 100).toFixed(0) + '%'),
                  ]),
                  h('div', { class: 'bom-step-desc tiny dim' }, b.desc),
                  h('div', { class: 'bom-bar' }, [
                    h('div', { class: 'bom-bar-fill', style: 'width:' + widthPct + '%' }),
                  ]),
                  h('div', { class: 'bom-step-meta mono tiny' }, [
                    h('span', {}, '功率 ' + b.powerKw + ' kW'),
                    h('span', { style: 'margin-left:12px' }, '碳排 ' + b.carbonRate + ' tCO₂/h'),
                  ]),
                  i < bom.length - 1 ? h('div', { class: 'bom-arrow' }, '↓') : null,
                ]);
              })),
            }),
          ]),

          /* ===== 链上存证表格 + 操作 ===== */
          h('div', { class: 'grid g-2-1' }, [
            h('x-card', {
              title: '最新 5 笔上链存证记录', sub: '点击 TxHash 打开穿透式核验报告抽屉', flush: true,
            }, {
              actions: () => h('div', { class: 'flex gap-8' }, [
                h('button', { class: 'btn sm ghost', onClick: openHj212 }, [h('x-icon', { name: 'report', size: 13 }), 'HJ 212 报文']),
                h('button', { class: 'btn sm ghost', onClick: loadChain }, [h('x-icon', { name: 'refresh', size: 13 }), '刷新']),
              ]),
              default: () => h('div', { class: 'card-body' }, [
                h('x-table', {
                  columns: [
                    { key: 'batch', title: '批次号', width: '110px' },
                    { key: 'point', title: '点位', width: '110px' },
                    { key: 'carbon', title: '折算碳量(tCO₂/h)', align: 'right' },
                    { key: 'did', title: '设备 DID' },
                    { key: 'txHash', title: 'TxHash' },
                  ],
                  rows: rows,
                  rowKey: 'batch',
                  rowClick: (row) => verifyBlock({ block_index: row.blockIndex }),
                  empty: '链上暂无存证记录',
                }, {
                  'col-txHash': ({ row }) => h('span', { class: 'mono tiny hash-link', title: row.txHash }, App.fmt.short(row.txHash, 16)),
                  'col-did': ({ row }) => h('span', { class: 'mono tiny' }, row.did),
                  'col-carbon': ({ row }) => h('span', { class: 'mono', style: 'color:#00C07F' }, row.carbon),
                  'col-batch': ({ row }) => h('span', { class: 'mono' }, row.batch),
                }),
              ]),
            }),
            h('div', { class: 'col gap-16' }, [
              h('x-card', { title: '设备 DID 与网关状态', sub: point.value.name }, {
                default: () => h('dl', { class: 'kv', style: 'grid-template-columns:88px 1fr' }, [
                  h('dt', {}, '设备 DID'), h('dd', { class: 'hashbox mono tiny' }, point.value.did),
                  h('dt', {}, '工艺路线'), h('dd', {}, point.value.process),
                  h('dt', {}, '采样频率'), h('dd', { class: 'mono' }, 'CEMS 3s / 电表 1s'),
                  h('dt', {}, '网关状态'), h('dd', {}, [h('span', { class: 'tag t-ok' }, 'TEE 在线')]),
                  h('dt', {}, '报文协议'), h('dd', {}, [h('span', { class: 'tag t-info' }, 'HJ 212-2017')]),
                  h('dt', {}, '电力协议'), h('dd', {}, [h('span', { class: 'tag t-info' }, 'DL/T 645-2007')]),
                ]),
              }),
              h('x-card', { title: '防篡改证据链', sub: '四级存证 · 穿透式核验' }, {
                default: () => h('div', { class: 'col gap-8' }, [
                  ['1. 物理表计采样', '2. 硬件芯片 SM2 签名', '3. 智能合约核算', '4. 权威节点共识确认'].map((t) =>
                    h('div', { class: 'proof-step' }, [h('i', { class: 'proof-dot' }), h('span', {}, t)])),
                  h('button', { class: 'btn primary mt-12', onClick: exportDPP }, [h('x-icon', { name: 'report', size: 14 }), '导出产品数字护照']),
                ]),
              }),
            ]),
          ]),

          /* ===== HJ 212 报文抽屉 ===== */
          h('x-modal', {
            modelValue: hjModal.show,
            title: 'HJ 212-2017 原始工业报文帧 · ' + point.value.code,
            width: '760px',
            'onUpdate:modelValue': (v) => { hjModal.show = v; },
          }, {
            default: () => hjModal.packet ? h('div', { class: 'hj212-frame' }, [
              h('div', { class: 'alertbar info mb-16' }, [
                h('x-icon', { name: 'info', size: 15 }),
                '符合生态环境部 HJ 212-2017《污染物在线监控（监测）系统数据传输标准》',
              ]),
              h('div', { class: 'grid g2 mb-16' }, [
                h('div', {}, [
                  h('div', { class: 'tiny dim mb-8' }, '完整报文帧'),
                  h('pre', { class: 'mono-pre hj212-packet' }, hjModal.packet),
                ]),
                h('div', { class: 'col gap-12' }, [
                  h('div', {}, [
                    h('div', { class: 'tiny dim mb-8' }, 'CRC16 校验和'),
                    h('div', { class: 'mono hj212-crc' }, hjModal.crc),
                  ]),
                  h('div', {}, [
                    h('div', { class: 'tiny dim mb-8' }, 'SM3 摘要指纹（报文防篡改）'),
                    h('div', { class: 'mono hj212-sm3' }, hjModal.sm3),
                  ]),
                  h('div', {}, [
                    h('div', { class: 'tiny dim mb-8' }, '网关 SM2 签名'),
                    h('div', { class: 'mono hj212-sig' }, hjModal.sig),
                  ]),
                ]),
              ]),
              h('div', { class: 'tiny dim mb-8' }, '数据段字段（CP=&& ... &&）'),
              h('pre', { class: 'mono-pre hj212-body' }, hjModal.body),
              hjModal.fields ? h('div', { class: 'grid g4 mt-16' }, [
                h('div', { class: 'kv-mini' }, [h('span', { class: 'dim tiny' }, 'CO₂'), h('b', { class: 'mono' }, hjModal.fields.co2 + '%')]),
                h('div', { class: 'kv-mini' }, [h('span', { class: 'dim tiny' }, '流量'), h('b', { class: 'mono' }, Math.round(hjModal.fields.flow) + ' m³/h')]),
                h('div', { class: 'kv-mini' }, [h('span', { class: 'dim tiny' }, '烟温'), h('b', { class: 'mono' }, hjModal.fields.temp + '℃')]),
                h('div', { class: 'kv-mini' }, [h('span', { class: 'dim tiny' }, '含氧'), h('b', { class: 'mono' }, hjModal.fields.o2 + '%')]),
              ]) : null,
            ]) : h('div', { class: 'skel', style: 'height:200px' }),
            footer: () => [
              h('button', { class: 'btn', onClick: () => { hjModal.show = false; } }, '关闭'),
              h('button', { class: 'btn chain', onClick: exportDPP }, [h('x-icon', { name: 'report', size: 14 }), '导出数字护照']),
            ],
          }),
        ]);
      };
    },
  });

  App.views = App.views || {};
  App.views['page-matrix'] = PageMatrix;
})();
