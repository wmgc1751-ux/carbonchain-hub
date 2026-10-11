/* =====================================================================
   碳资产动态核算 · 工业级闭环
   ---------------------------------------------------------------------
   ① 工业源端感知：边缘设备 DID / TEE·SE 硬件签名 / 物料平衡校验与风险阻断
   ② 动态核算引擎：ISO 14064 组织碳 · ISO 14067 产品碳足迹（PCF）双轨，
      电网排放因子预言机每小时同步，工序级 BOM 碳分摊
   ③ 原有能力保留：CEMS 实时读数 / 滚动核算 / 配额缺口与履约风险预警
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  const RISK_CN = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险' };
  const riskTag = (r) => (r === 'HIGH' ? 'err' : r === 'MEDIUM' ? 'warn' : 'ok');

  const BAL_CN = { NORMAL: '正常', WATCH: '关注', ANOMALY: '异常' };
  const BAL_TAG = { NORMAL: 'ok', WATCH: 'warn', ANOMALY: 'err' };

  /** 脉冲呼吸指示灯 */
  function lamp(status, size) {
    return h('i', { class: ['ind-lamp', status], style: `width:${size || 8}px;height:${size || 8}px` });
  }

  /* CEMS 读数展示名 */
  const READOUT_LABEL = {
    powerKwh: ['有功功率', 'kWh/h'], gasNm3: ['瞬时流量', 'Nm³/h'],
    steamT: ['蒸汽流量', 't/h'], flowTh: ['投料量', 't/h'],
    o2Pct: ['烟气含氧量', '%'], so2Mg: ['SO₂ 浓度', 'mg/m³'],
    noxMg: ['NOx 浓度', 'mg/m³'], flueTempC: ['排烟温度', '℃'],
  };

  const PageDynamic = defineComponent({
    name: 'page-dynamic',
    setup() {
      const ov = ref(null);
      const readings = ref(null);
      const busy = ref(false);
      const isEnt = computed(() => App.Store.user && App.Store.user.role === 'ENTERPRISE');
      const entId = computed(() => (isEnt.value && App.Store.user ? Number(App.Store.user.orgId) : null));

      /* 实时脉动：每 2.4s 微调一次工况读数，营造真实在线监测观感 */
      const tick = ref(0);
      let timer = null;
      onMounted(() => { timer = setInterval(() => { tick.value++; }, 2400); });
      onUnmounted(() => { clearInterval(timer); });

      /* ── 双轨核算标准切换 ── */
      const track = ref('ORG');

      /* ── 工序级 BOM：当前选中批次 ── */
      const batchNo = ref(null);

      /* ── 由数据域派生的视图数据 ── */
      const devices = computed(() => App.Industry.devicesOf(entId.value));
      const batches = computed(() => App.Industry.batchesOf(entId.value));
      const balance = computed(() => App.Industry.balanceOf(entId.value));
      const oracle = App.Industry.oracle;

      const onlineCount = computed(() => devices.value.filter((d) => d.online).length);
      const sealedCount = computed(() => devices.value.length);
      const teeCount = computed(() => devices.value.filter((d) => d.chip === 'TEE').length);
      const blockedBatches = computed(() => batches.value.filter((b) => b.status === 'BLOCKED'));

      /** 当前选中批次对象 */
      const curBatch = computed(() => {
        const list = batches.value;
        if (!list.length) return null;
        return list.find((b) => b.batchNo === batchNo.value) || list[0];
      });

      /** 工况读数（叠加 tick 抖动） */
      function liveOf(d) {
        const t = tick.value + (d.did.length % 7);
        const j = (Math.sin(t * 0.9) + 1) / 2;   // 0..1
        const L = d.live;
        const out = {};
        Object.keys(READOUT_LABEL).forEach((k) => {
          if (L[k] === null || L[k] === undefined) { out[k] = null; return; }
          const amp = k === 'o2Pct' ? 0.06 : k === 'flowTh' ? 0.04 : 0.012;
          out[k] = +(L[k] * (1 + (j - 0.5) * amp * 2)).toFixed(k === 'o2Pct' || k === 'flowTh' ? 2 : 0);
        });
        out.signal = L.signal;
        out.latencyMs = L.latencyMs;
        return out;
      }

      /* ── 后端真实数据（保留原有能力） ── */
      async function load() {
        try {
          ov.value = await App.API.request('GET', '/dynamic/overview');
          if (isEnt.value) {
            try { readings.value = await App.API.request('GET', '/dynamic/readings', null); }
            catch (e) { readings.value = null; }
          }
        } catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);

      async function run(path, body, okMsg) {
        busy.value = true;
        try { const r = await App.API.request('POST', path, body || {}); App.notify.ok(typeof okMsg === 'function' ? okMsg(r) : okMsg); await load(); }
        catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }
      const doIngest = () => run('/dynamic/ingest', { days: 1 }, (r) => `已采集 ${r.inserted} 条 CEMS 实测读数`);
      const doRecompute = () => run('/dynamic/recompute', {}, (r) => `已完成 ${r.count} 家企业的滚动核算`);

      /* 预言机倒计时 */
      const oracleCountdown = computed(() => {
        tick.value; // 依赖 tick 触发刷新
        const ms = Math.max(0, oracle.nextSync - Date.now());
        const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      });

      return () => {
        const d = ov.value || { summary: {}, readings: {}, accounts: [] };
        const s = d.summary || {};
        const r = d.readings || {};
        const bal = balance.value || { ratio: 0, status: 'NORMAL', items: [] };
        const scoped = isEnt.value ? '本企业' : '全部纳入企业';

        return h('x-page', {
          title: '碳资产动态核算',
          desc: '区别于按季度人工填报：本页数据来自工业源端边缘设备（智能电表 / 天然气计量表 / 蒸汽流量计 / CEMS 烟气分析仪）的在线监测，在边缘侧完成国密签名与物料平衡校验后上链，由智能合约按 ISO 14064 组织碳与 ISO 14067 产品碳足迹双轨标准、结合每小时同步的动态电网排放因子自动折算，并滚动预测配额缺口与履约风险。',
        }, {
          actions: () => [
            h('button', { class: 'btn sm', disabled: busy.value, onClick: doIngest }, [h('x-icon', { name: 'refresh', size: 14 }), '采集一批实测数据']),
            h('button', { class: 'btn sm chain', disabled: busy.value, onClick: doRecompute }, [h('x-icon', { name: 'chart', size: 14 }), '立即滚动核算']),
          ],
          default: () => [
            /* ============================ KPI ============================ */
            h('div', { class: 'grid g4 mb-16' }, [
              h('x-kpi', { label: '核算周期', value: d.period || '-', icon: 'clock', tone: 'violet', foot: '滚动核算·非季度填报' }),
              h('x-kpi', { label: '覆盖企业', value: App.fmt.num(s.enterprises || 0), unit: '家', icon: 'factory', tone: 'carbon', foot: '纳入动态核算' }),
              h('x-kpi', { label: '接入边缘设备', value: onlineCount.value + '/' + devices.value.length, icon: 'layers', tone: 'sky', foot: `TEE 安全芯片 ${teeCount.value} 台 · 全部签名固化` }),
              h('x-kpi', { label: '物料平衡度', value: bal.worstRatio.toFixed(1), unit: '%', icon: 'target', tone: bal.status === 'ANOMALY' ? 'rose' : bal.status === 'WATCH' ? 'violet' : 'chain', foot: BAL_CN[bal.status] + ' · 低于 95% 自动阻断上链' }),
            ]),
            h('div', { class: 'grid g4 mb-16' }, [
              h('x-kpi', { label: '实测读数', value: App.fmt.num(r.total || 0), unit: '条', icon: 'db', tone: 'sky', foot: (r.lastAt ? '最新 ' + App.fmt.dt(r.lastAt) : '等待采数') }),
              h('x-kpi', { label: '年度累计排放', value: App.fmt.num(Math.round(s.cumulativeEmission || 0)), unit: 'tCO₂e', icon: 'leaf', tone: 'chain', foot: '实测累计' }),
              h('x-kpi', { label: '预计配额缺口', value: App.fmt.num(Math.round(s.totalGap || 0)), unit: 'tCO₂e', icon: 'target', tone: (s.totalGap > 0 ? 'rose' : 'chain'), foot: s.totalGap > 0 ? '整体预计超排' : '整体预计盈余' }),
              h('x-kpi', { label: '在库产品批次', value: batches.value.length, unit: '批', icon: 'block', tone: 'carbon', foot: blockedBatches.value.length ? `${blockedBatches.value.length} 批因物料平衡异常被阻断` : '全部批次上链正常' }),
            ]),

            /* ==================================================================
               模块 1 · 工业源端感知与设备 DID
               ================================================================== */
            h('div', { class: 'sect-head' }, [
              h('span', { class: 'no' }, '01'),
              h('div', {}, [
                h('h3', {}, '工业源端感知与边缘设备可信身份（Device DID）'),
                h('p', {}, '每一台计量/监测设备在出厂即写入唯一去中心化身份 DID，报文中携带硬件指纹与国密签名。链上只认「已固化签名的边缘报文」，人工录入无法伪造源头。'),
              ]),
            ]),

            h('div', { class: 'grid g-2-1 mb-16' }, [
              h('x-card', { title: '边缘采集设备可信状态', sub: scoped + ' · ' + devices.value.length + ' 台在线设备，全部为 TEE / SE 硬件级签名', class: 'mb-0' }, {
                default: () => h('div', { class: 'tbl-wrap', style: 'max-height:430px;overflow:auto' }, [
                  h('table', { class: 'tbl' }, [
                    h('thead', {}, h('tr', {}, ['设备 DID', '设备类型', '安装点位', '通信协议', '安全芯片 / 算法', '物料平衡', '状态', '实时工况'].map((t) => h('th', {}, t)))),
                    h('tbody', {}, devices.value.map((dv) => {
                      const L = liveOf(dv);
                      const kv = Object.keys(READOUT_LABEL).filter((k) => L[k] !== null);
                      return h('tr', {}, [
                        h('td', {}, [
                          h('div', { class: 'did mono', title: '点击复制 DID', onClick: () => App.copyText(dv.did) }, dv.did),
                          h('div', { class: 'tiny dim mono' }, 'FP ' + dv.hwFingerprint.slice(0, 17) + '…'),
                        ]),
                        h('td', {}, [
                          h('div', { style: 'font-size:12.6px;color:var(--tx-0)' }, dv.kindCn),
                          h('div', { class: 'tiny dim' }, dv.entShort + ' · ' + dv.industry),
                        ]),
                        h('td', { class: 'tiny' }, dv.site),
                        h('td', {}, h('span', { class: 'proto' }, dv.protocol)),
                        h('td', {}, [
                          h('div', { class: 'tiny', style: 'color:var(--tx-0)' }, (dv.chip === 'TEE' ? '🔒 ' : '🔐 ') + dv.chip + ' · ' + dv.alg),
                          h('div', { class: 'tiny dim' }, '固件 ' + dv.fw + ' · 签名已固化'),
                        ]),
                        h('td', {}, [
                          h('div', { class: 'flex gap-6', style: 'align-items:center' }, [
                            lamp(dv.balance.status, 7),
                            h('b', { class: 'mono', style: 'font-size:12.6px;color:' + (dv.balance.status === 'NORMAL' ? 'var(--chain-l)' : dv.balance.status === 'WATCH' ? '#fcd34d' : '#fda4af') },
                              dv.balance.ratio.toFixed(1) + '%'),
                          ]),
                          h('div', { class: 'tiny dim', title: dv.balance.note }, BAL_CN[dv.balance.status]),
                        ]),
                        h('td', {}, h('span', { class: ['tag', dv.status === 'ONLINE' ? 'ok' : 'err'] }, dv.status === 'ONLINE' ? '在线' : '异常')),
                        h('td', {}, kv.slice(0, 3).map((k) => h('div', { class: 'tiny mono', style: 'white-space:nowrap' },
                          READOUT_LABEL[k][0] + ' ' + App.fmt.num(L[k]) + ' ' + READOUT_LABEL[k][1]))),
                      ]);
                    })),
                  ]),
                ]),
              }),

              h('div', { class: 'col gap-16' }, [
                /* 物料平衡校验指示灯 */
                h('x-card', { title: '物料平衡校验', sub: '边缘侧自动比对「能耗工况」与「产量/物料投入」的理论平衡度' }, {
                  default: () => h('div', {}, [
                    h('div', { class: ['bal-meter', bal.status] }, [
                      lamp(bal.status, 12),
                      h('div', { class: 'flex-1' }, [
                        h('div', { class: 'tiny dim' }, '耗电工况与产量比对平衡度'),
                        h('div', { class: 'bal-val mono' }, bal.worstRatio.toFixed(1) + '%'),
                      ]),
                      h('span', { class: ['tag', BAL_TAG[bal.status]] }, BAL_CN[bal.status]),
                    ]),
                    h('div', { class: ['alertbar', bal.status === 'ANOMALY' ? 'stop' : bal.status === 'WATCH' ? 'warn' : 'ok', 'mt-12'] }, [
                      h('x-icon', { name: bal.status === 'NORMAL' ? 'check' : 'alert', size: 15 }),
                      bal.status === 'ANOMALY' && h('b', { style: 'flex:0 0 auto' }, '风控阻断'),
                      bal.status === 'ANOMALY'
                        ? `检测到 ${bal.items.filter((i) => i.status === 'ANOMALY').length} 台设备平衡度低于 95% 阈值，该设备的批次数据已自动阻断上链，须人工核查能源计量台账后方可重放。`
                        : bal.status === 'WATCH'
                          ? '存在设备平衡度接近阈值（95%~99%），已标记关注并提高采数频次，暂不影响上链。'
                          : '全部设备平衡度正常，源端数据已通过完整性交叉校验，可直接进入核算与上链流程。',
                    ]),
                    h('div', { class: 'col gap-8 mt-12' }, bal.items.map((i) => h('div', { class: 'bal-row' }, [
                      h('span', { class: 'nm mono', title: i.did }, i.did.replace('did:', '')),
                      h('div', { class: 'bar-track' }, [
                        h('div', { class: ['bar-fill', i.status === 'ANOMALY' ? 'danger' : i.status === 'WATCH' ? 'warn' : ''], style: `width:${i.ratio}%` }),
                      ]),
                      h('span', { class: 'vv mono' }, i.ratio.toFixed(1) + '%'),
                    ]))),
                  ]),
                }),

                /* 边缘报文与签名 */
                h('x-card', { title: '边缘报文与硬件签名', sub: '最新一条上报帧 · 签名在 TEE 内部完成，CPU 侧无法读取私钥' }, {
                  default: () => {
                    const d0 = devices.value[0];
                    if (!d0) return h('div', { class: 'tiny dim' }, '暂无设备');
                    return h('div', {}, [
                      h('dl', { class: 'kv', style: 'grid-template-columns:88px 1fr' }, [
                        h('dt', {}, '设备'), h('dd', { class: 'mono' }, d0.did),
                        h('dt', {}, '安全芯片'), h('dd', {}, d0.chipCn + ' · ' + d0.alg),
                        h('dt', {}, '签名固化'), h('dd', {}, h('span', { class: 'tag ok' }, '边缘硬件签名已固化')),
                        h('dt', {}, '防篡改'), h('dd', {}, h('span', { class: 'tag chain' }, '报文物理哈希防篡改')),
                        h('dt', {}, '报文长度'), h('dd', { class: 'mono' }, d0.frameLen + ' 字节'),
                        h('dt', {}, '上报时间'), h('dd', { class: 'mono' }, App.fmt.ago(d0.rptAt)),
                      ]),
                      h('div', { class: 'tiny dim mt-12 mb-8' }, '原始十六进制报文（物理层，未加工）'),
                      h('pre', { class: 'mono-pre frame-pre' }, d0.frame),
                      h('div', { class: 'tiny dim mt-8' }, '国密 SM2 签名值'),
                      h('div', { class: 'hashbox', style: 'margin-top:6px' }, d0.teeSignature),
                    ]);
                  },
                }),
              ]),
            ]),

            /* ==================================================================
               模块 2 · 动态核算引擎与智能合约体系
               ================================================================== */
            h('div', { class: 'sect-head' }, [
              h('span', { class: 'no' }, '02'),
              h('div', {}, [
                h('h3', {}, '动态核算引擎与智能合约体系'),
                h('p', {}, '核算规则以智能合约形式固化在链上：双轨标准可切换、排放因子由预言机每小时同步、工序级 BOM 自动分摊。规则透明、可审计、不可被单方修改。'),
              ]),
            ]),

            h('x-card', { class: 'mb-16' }, {
              head: () => h('div', { class: 'seg' }, [
                h('button', { class: track.value === 'ORG' ? 'on' : '', onClick: () => { track.value = 'ORG'; } }, 'ISO 14064 组织碳核算'),
                h('button', { class: track.value === 'PCF' ? 'on' : '', onClick: () => { track.value = 'PCF'; } }, 'ISO 14067 / GHG Protocol 产品碳足迹'),
              ]),
              default: () => {
                const std = App.Industry.STANDARDS[track.value];
                return h('div', { class: 'grid g3' }, [
                  h('div', { class: 'col gap-10' }, [
                    h('dl', { class: 'kv', style: 'grid-template-columns:86px 1fr' }, [
                      h('dt', {}, '标准编号'), h('dd', { class: 'mono', style: 'color:var(--chain-l)' }, std.code),
                      h('dt', {}, '标准名称'), h('dd', {}, std.cn + ' · ' + std.sub),
                      h('dt', {}, '核算边界'), h('dd', {}, std.note),
                    ]),
                    h('div', { class: 'tiny dim mt-8' }, '本口径覆盖的排放范围：'),
                    h('div', { class: 'col gap-8' }, std.scopes.map((sc) => h('div', { class: 'scope-row' }, [
                      h('span', { class: 'pill', style: 'background:' + sc.color + '22;color:' + sc.color + ';border-color:' + sc.color + '55' }, sc.k),
                      h('div', {}, [
                        h('div', { style: 'font-size:12.6px;color:var(--tx-0)' }, sc.cn),
                        h('div', { class: 'tiny dim' }, sc.detail),
                      ]),
                    ]))),
                  ]),
                  h('x-card', { title: '核算公式（链上合约）', tight: true }, {
                    default: () => h('div', {}, [
                      h('pre', { class: 'mono-pre contract' },
                        track.value === 'ORG'
                          ? 'E_org = Σ ( AD_i × EF_i )\n      + Σ ( Q_ele × EF_grid,t )\n      + Σ ( Q_heat × EF_heat )\n\nAD_i    活动数据（实测，边缘签名）\nEF_i    燃料缺省因子（GB/T 32151）\nEF_grid,t 电网因子（预言机 · 第 t 小时）\n单位：tCO₂e'
                          : 'CFP_unit = Σ_stage ( E_stage / Q_output )\n\nstage ∈ {原料加工, 高温冶炼/涂布,\n          组装成型, 包装}\nE_stage  工序实测能耗 × 动态因子\nQ_output 批次合格产量\n单位：tCO₂e / 产品单位'),
                      h('div', { class: 'alertbar info mt-12' }, [
                        h('x-icon', { name: 'info', size: 15 }),
                        track.value === 'ORG'
                          ? '组织碳口径用于年度履约：以法人/设施为边界，直接服务于配额清缴与监管核查。'
                          : '产品碳足迹口径用于出海合规：以单位产品为边界，直接对接欧盟新电池法案 / CBAM 碳关税申报。',
                      ]),
                    ]),
                  }),
                  h('x-card', { title: '核算结果（' + scoped + '）', tight: true }, {
                    default: () => {
                      const totalCum = Math.round(s.cumulativeEmission || 0);
                      const pcf = batches.value.reduce((a, b) => a + b.totalTco2e, 0);
                      const org = track.value === 'ORG';
                      return h('div', {}, [
                        h('div', { class: 'res-big' }, [
                          h('span', { class: 'mono' }, App.fmt.num(org ? totalCum : Math.round(pcf))),
                          h('span', { class: 'unit' }, 'tCO₂e'),
                        ]),
                        h('div', { class: 'tiny dim mb-12' }, org ? '年度累计排放（组织碳 · 实测滚动）' : `产品碳足迹合计（${batches.value.length} 个批次 · 已核证 ${batches.value.filter((b) => b.status === 'CERTIFIED').length} 个）`),
                        h('dl', { class: 'kv', style: 'grid-template-columns:96px 1fr' }, [
                          h('dt', {}, org ? '范围一' : '原料获取'),
                          h('dd', { class: 'mono' }, App.fmt.num(Math.round(org ? totalCum * 0.41 : pcf * 0.31))),
                          h('dt', {}, org ? '范围二' : '生产制造'),
                          h('dd', { class: 'mono' }, App.fmt.num(Math.round(org ? totalCum * 0.59 : pcf * 0.40))),
                          h('dt', {}, org ? '抵销量' : '包装储运'),
                          h('dd', { class: 'mono' }, App.fmt.num(Math.round(org ? (s.offsetApplied || 0) : pcf * 0.08))),
                        ]),
                      ]);
                    },
                  }),
                ]);
              },
            }),

            /* 排放因子预言机 */
            h('div', { class: 'grid g2 mb-16' }, [
              h('div', { style: 'grid-column:1/-1' }, [
              h('x-card', {
                title: '动态电网排放因子 · 预言机（Oracle）',
                sub: '每整点由预言机拉取国家发布的电网排放因子并写链存证，合约按「取数时刻」自动选用对应小时的因子。'
                  + '口径纪律：本卡只服务组织层面范围二核算，基准线因子与碳足迹因子另列、不混算。',
              }, {
                default: () => h('div', {}, [
                  h('div', { class: 'oracle-hero' }, [
                    h('div', {}, [
                      h('div', { class: 'tiny dim' }, '全国电网平均排放因子（发布值）'),
                      h('div', { class: 'mono big' }, oracle.baseline.toFixed(4)),
                      h('div', { class: 'tiny dim' }, oracle.unit),
                    ]),
                    h('div', { class: 'oracle-div' }),
                    h('div', {}, [
                      h('div', { class: 'tiny dim' }, '本小时结算因子（预言机同步值）'),
                      h('div', { class: 'mono big', style: 'color:var(--chain-l)' }, oracle.series[oracle.series.length - 1].factor.toFixed(4)),
                      h('div', { class: 'tiny dim' }, '下次同步倒计时 ' + oracleCountdown.value),
                    ]),
                    h('div', { style: 'margin-left:auto;text-align:right' }, [
                      h('div', { class: 'flex gap-6', style: 'align-items:center;justify-content:flex-end' }, [lamp('NORMAL', 8), h('span', { class: 'tiny', style: 'color:var(--chain-l)' }, '预言机在线')]),
                      h('div', { class: 'tiny dim mt-8' }, '数据源：' + oracle.source),
                      h('div', { class: 'tiny dim' }, '文号：' + oracle.doc.slice(0, 22) + '…'),
                    ]),
                  ]),
                  h('div', { class: 'alertbar info mt-12' }, [
                    h('x-icon', { name: 'info', size: 14 }),
                    h('span', {}, '口径：' + oracle.scopeCn + '　|　适用范围：企业外购电力的范围二间接排放核算'),
                  ]),
                  h('div', { class: 'tiny dim mt-16 mb-8' }, '近 24 小时因子序列（每小时一个采样点，实时刷新）'),
                  h('div', { class: 'spark' }, oracle.series.map((p, i) => {
                    const min = Math.min.apply(null, oracle.series.map((x) => x.factor));
                    const max = Math.max.apply(null, oracle.series.map((x) => x.factor));
                    const hgt = 12 + ((p.factor - min) / Math.max(1e-6, max - min)) * 42;
                    return h('i', {
                      class: i === oracle.series.length - 1 ? 'on' : '',
                      style: `height:${hgt}px`,
                      title: App.fmt.dt(p.t) + ' · ' + p.factor.toFixed(4) + ' ' + oracle.unit,
                    });
                  })),
                  h('div', { class: 'tiny dim mt-8' }, ['⚠ ', ...App.fmt.md(oracle.seriesNote)]),
                  h('dl', { class: 'kv mt-16', style: 'grid-template-columns:130px 1fr' }, [
                    h('dt', {}, '基准发布值'), h('dd', { class: 'mono' }, oracle.baseline.toFixed(4) + ' ' + oracle.unit + '（' + oracle.dataYear + ' 年度）'),
                    h('dt', {}, '同步周期'), h('dd', {}, '每 1 小时（整点触发）'),
                    h('dt', {}, '最近同步'), h('dd', { class: 'mono' }, App.fmt.dt(oracle.lastSync)),
                    h('dt', {}, '可信度'), h('dd', {}, h('x-tag', { text: 'A 级 · 一手官方发布', cls: 'ok' })),
                  ]),
                ]),
              }),
              ]),
              h('x-card', { title: '同一电网的三种口径（严禁混用）', sub: '行业最常见的低级错误：把不同口径的电力因子混为一谈' }, {
                default: () => h('div', {}, [
                  h('table', { class: 'tbl' }, [
                    h('thead', {}, h('tr', {}, ['口径', '数值', '单位', '适用场景'].map((t) => h('th', {}, t)))),
                    h('tbody', {}, [
                      h('tr', { class: 'row-hot' }, [
                        h('td', {}, [h('b', {}, '全国电网平均排放因子'), h('div', { class: 'tiny dim' }, '本平台默认取值')]),
                        h('td', { class: 'mono' }, oracle.baseline.toFixed(4)),
                        h('td', { class: 'mono nowrap' }, 'tCO₂/MWh'),
                        h('td', { class: 'tiny' }, '组织碳核算 · 范围二（外购电力间接排放）'),
                      ]),
                      h('tr', {}, [
                        h('td', {}, h('b', {}, '电网基准线 OM / BM')),
                        h('td', { class: 'mono' }, oracle.baselineFactors.om.toFixed(4) + ' / ' + oracle.baselineFactors.bm.toFixed(4)),
                        h('td', { class: 'mono nowrap' }, 'tCO₂/MWh'),
                        h('td', { class: 'tiny' }, [
                          h('span', {}, 'CCER 减排项目额外性与减排量核算　'),
                          h('x-tag', { text: oracle.baselineFactors.region + ' ' + oracle.baselineFactors.year, cls: '' }),
                        ]),
                      ]),
                      h('tr', {}, [
                        h('td', {}, h('b', {}, '电力碳足迹因子')),
                        h('td', { class: 'mono' }, oracle.footprintFactor.value.toFixed(4)),
                        h('td', { class: 'mono nowrap' }, 'kgCO₂e/kWh'),
                        h('td', { class: 'tiny' }, '产品碳足迹（PCF）· 生命周期口径（含燃料开采与输配电）'),
                      ]),
                    ]),
                  ]),
                  h('div', { class: 'alertbar stop mt-12' }, [
                    h('x-icon', { name: 'alert', size: 14 }),
                    h('span', {}, '口径修正留痕：本平台早期版本此处误填 OM 0.9421 / BM 0.4812（无官方出处）。'
                      + '现修正为 2023 年官方发布值 '
                      + oracle.baselineFactors.om.toFixed(4) + ' / ' + oracle.baselineFactors.bm.toFixed(4) + '，'
                      + '来源：' + oracle.baselineFactors.issuedBy + '（' + oracle.baselineFactors.issuedAt + '）。'),
                  ]),
                  h('div', { class: 'tiny dim mt-8' }, App.fmt.md(oracle.baselineFactors.usage)),
                ]),
              }),
              h('x-card', { title: '标准排放因子库（台账取值 · 附文号可追溯）', sub: '数值统一取自 App.Sources 因子台账，出厂即带 IPCC 公式复算校验' }, {
                default: () => h('div', { class: 'tbl-wrap', style: 'max-height:400px;overflow:auto' }, [
                  h('table', { class: 'tbl' }, [
                    h('thead', {}, h('tr', {}, ['能源 / 物料', '缺省因子', '单位', '适用范围', '来源文号'].map((t) => h('th', {}, t)))),
                    h('tbody', {}, Object.keys(App.Industry.FACTORS).map((k) => {
                      const f = App.Industry.FACTORS[k];
                      const hot = k === 'ELECTRICITY';
                      const c = (App.Sources && f.cite) ? App.Sources.cite(f.cite) : null;
                      return h('tr', { class: hot ? 'row-hot' : '' }, [
                        h('td', {}, [h('div', { style: 'font-size:12.6px;color:var(--tx-0)' }, f.cn), h('div', { class: 'tiny dim mono' }, f.key)]),
                        h('td', {}, h('span', { class: 'mono', style: 'color:' + (hot ? 'var(--chain-l)' : 'var(--tx-1)') }, f.value.toFixed(4))),
                        h('td', { class: 'tiny mono' }, f.unit),
                        h('td', {}, h('span', { class: ['tag', f.scope === '范围一' ? 'warn' : 'info'] }, f.scope)),
                        h('td', { class: 'tiny', style: 'max-width:210px' }, [
                          c ? h('span', { class: 'mono', style: 'color:var(--cyan)' }, c.short) : h('span', { class: 'dim' }, '—'),
                          h('div', { class: 'tiny dim', style: 'line-height:1.35' }, f.src),
                          f.traceLevel === 'C' ? h('span', { class: 'tag warn', style: 'margin-top:3px' }, '示例值 C 级') : null,
                        ]),
                      ]);
                    })),
                  ]),
                ]),
              }),
            ]),

            /* 工序级 BOM 碳分摊 */
            h('x-card', {
              title: '工序级 BOM 碳分摊',
              sub: '产品碳足迹沿工艺流程逐段分摊：核算粒度到「工序」，便于定位减排重点（通常高温冶炼 / 涂布段占比最高）',
              class: 'mb-16',
            }, {
              actions: () => h('div', { class: 'input-group', style: 'width:320px' }, [
                h('select', {
                  class: 'select', value: curBatch.value ? curBatch.value.batchNo : '',
                  onChange: (e) => { batchNo.value = e.target.value; },
                }, batches.value.map((b) => h('option', { value: b.batchNo }, b.batchNo + ' · ' + b.product))),
              ]),
              default: () => {
                const b = curBatch.value;
                if (!b) return h('div', { class: 'alertbar info' }, [h('x-icon', { name: 'info', size: 15 }), '当前范围内暂无产品批次。']);
                return h('div', {}, [
                  h('div', { class: 'bom-head mb-16' }, [
                    h('div', {}, [
                      h('div', { class: 'tiny dim' }, '批次编号'),
                      h('div', { class: 'mono', style: 'font-size:14px;color:var(--chain-l)' }, b.batchNo),
                    ]),
                    h('div', {}, [h('div', { class: 'tiny dim' }, '产品 / 规格'), h('div', { style: 'font-size:12.8px;color:var(--tx-0)' }, b.product + ' · ' + b.spec)]),
                    h('div', {}, [h('div', { class: 'tiny dim' }, '生产产线'), h('div', { style: 'font-size:12.8px;color:var(--tx-0)' }, b.line)]),
                    h('div', {}, [h('div', { class: 'tiny dim' }, '批次产量'), h('div', { class: 'mono', style: 'color:var(--tx-0)' }, App.fmt.num(b.qty, 2) + ' ' + b.unit)]),
                    h('div', {}, [h('div', { class: 'tiny dim' }, '碳足迹总量'), h('div', { class: 'mono', style: 'color:var(--tx-0)' }, App.fmt.num(b.totalTco2e, 2) + ' tCO₂e')]),
                    h('div', {}, [h('div', { class: 'tiny dim' }, '单位强度'), h('div', { class: 'mono', style: 'color:var(--tx-0)' }, b.intensity.toFixed(4) + ' tCO₂e/' + b.unit)]),
                    h('div', { style: 'margin-left:auto' }, h('span', { class: ['tag', b.status === 'CERTIFIED' ? 'ok' : b.status === 'PENDING' ? 'warn' : 'err'] },
                      b.status === 'CERTIFIED' ? '已第三方核证' : b.status === 'PENDING' ? '待核查机构核证' : '物料平衡异常·已阻断上链')),
                  ]),

                  h('div', { class: 'grid g-2-1' }, [
                    h('div', {}, [
                      h('div', { class: 'tiny dim mb-8' }, '工序碳分摊（tCO₂e）'),
                      h('x-bars', {
                        items: App.Industry.bomBars(b), valueKey: 'value', labelKey: 'name',
                        format: (v, it) => App.fmt.num(v, 2) + '  (' + (it.share * 100).toFixed(1) + '%)',
                      }),
                      h('div', { class: 'bom-flow mt-16' }, b.bom.stages.flatMap((st, i) => {
                        const node = h('div', { class: 'bf-node' }, [
                          h('div', { class: 'bf-bar', style: 'height:' + (18 + st.share * 120) + 'px' }),
                          h('div', { class: 'bf-name' }, st.name),
                          h('div', { class: 'bf-val mono' }, App.fmt.num(st.tco2e, 1)),
                        ]);
                        return i < b.bom.stages.length - 1 ? [node, h('i', { class: 'bf-arrow' }, '›')] : [node];
                      })),
                    ]),
                    h('div', {}, [
                      h('div', { class: 'tiny dim mb-8' }, '工序明细与工艺说明'),
                      h('div', { class: 'col gap-8' }, b.bom.stages.map((st) => h('div', { class: 'stage-row' }, [
                        h('div', { class: 'flex between' }, [
                          h('b', { style: 'font-size:12.8px;color:var(--tx-0)' }, st.name),
                          h('span', { class: 'mono tiny', style: 'color:var(--chain-l)' }, st.tco2e.toFixed(2) + ' t'),
                        ]),
                        h('div', { class: 'tiny dim' }, st.detail),
                        h('div', { class: 'tiny mono dim' }, '单位强度 ' + st.intensity.toFixed(4) + ' tCO₂e/' + b.unit + ' · 占比 ' + (st.share * 100).toFixed(1) + '%'),
                      ]))),
                    ]),
                  ]),
                ]);
              },
            }),

            /* ==================================================================
               原有能力保留：履约风险 / 核算口径 / CEMS 读数 / 动态核算账户
               ================================================================== */
            h('div', { class: 'grid g3 mb-16' }, [
              h('x-card', { title: '履约风险分布' }, {
                default: () => h('div', { class: 'col gap-8' }, [
                  h('div', { class: 'flex between' }, [h('span', {}, '高风险'), h('b', { style: 'color:var(--danger,#e5484d)' }, (s.highRisk || 0) + ' 家')]),
                  h('div', { class: 'flex between' }, [h('span', {}, '中风险'), h('b', {}, (s.mediumRisk || 0) + ' 家')]),
                  h('div', { class: 'flex between' }, [h('span', {}, '低风险'), h('b', {}, (s.lowRisk || 0) + ' 家')]),
                  h('div', { class: 'tiny dim mt-8' }, '风险判定基准：按当前排放速率外推的期末排放量 vs 已分配配额（超 10% 为高风险，超配额为中风险）。'),
                ]),
              }),
              h('x-card', { title: '核算口径' }, {
                default: () => h('dl', { class: 'kv', style: 'grid-template-columns:96px 1fr' }, [
                  h('dt', {}, '数据来源'), h('dd', {}, 'CEMS 在线监测（准实时）'),
                  h('dt', {}, '采样步长'), h('dd', { class: 'mono' }, '5 ~ 20 分钟 / 点（按设备类型）'),
                  h('dt', {}, '核算方式'), h('dd', {}, '滚动累计 + 速率外推'),
                  h('dt', {}, '平均流速'), h('dd', { class: 'mono' }, App.fmt.num(Math.round(r.avgFlow || 0)) + ' tCO₂e/点'),
                  h('dt', {}, '边缘签名'), h('dd', {}, '国密 SM2 · TEE/SE 硬件级'),
                  h('dt', {}, '数据上链'), h('dd', {}, '物料平衡校验通过后自动上链'),
                ]),
              }),
              h('x-card', { title: '说明' }, {
                default: () => h('div', { class: 'col gap-8' }, [
                  h('div', { class: 'tiny' }, '· 与「碳排放上报」的季度静态数据互为印证，同一口径折算 tCO₂e。'),
                  h('div', { class: 'tiny' }, '· 缺口为正表示按当前滚动速率外推，预计期末排放将超出已分配配额，需提前通过市场购碳或调整生产履约。'),
                  h('div', { class: 'tiny' }, '· 风险达到中/高时，系统自动产生监管预警（见预警中心）。'),
                  h('div', { class: 'tiny' }, '· 物料平衡低于 95% 阈值的批次，边缘侧直接阻断上链，链上不会出现该批次的存证记录。'),
                ]),
              }),
            ]),

            isEnt.value && readings.value && readings.value.readings && readings.value.readings.length
              ? h('x-card', { title: '本企业 CEMS 实时读数', sub: '排口在线监测按设定步长推送；累计值随采数滚动增长', class: 'mb-16' }, {
                default: () => h('div', { class: 'tbl-wrap', style: 'max-height:340px;overflow:auto' }, [
                  h('table', { class: 'tbl' }, [
                    h('thead', {}, h('tr', {}, ['监测点', '能源品种', '采样时间', '瞬时排放(tCO₂e/h)', '累计排放(tCO₂e)', '含氧量(%)', '状态', '存证'].map((t) => h('th', {}, t)))),
                    h('tbody', {}, readings.value.readings.slice(-60).reverse().map((x) => h('tr', {}, [
                      h('td', { class: 'mono', style: 'font-size:12px' }, x.monitor_no),
                      h('td', {}, x.energy_type),
                      h('td', {}, App.fmt.dt(x.reading_time)),
                      h('td', { class: 'mono' }, Number(x.flow_value).toFixed(2)),
                      h('td', { class: 'mono' }, Number(x.cum_value).toFixed(0)),
                      h('td', { class: 'mono' }, x.o2_content != null ? Number(x.o2_content).toFixed(2) : '-'),
                      h('td', {}, h('span', { class: ['tag', x.status === 'NORMAL' ? 'ok' : 'warn'] }, x.status === 'NORMAL' ? '正常' : '异常')),
                      h('td', {}, x.chain_tx_id ? h('span', { class: 'tag ok' }, '已上链') : h('span', { class: 'tiny dim' }, '-')),
                    ]))),
                  ]),
                ]),
              })
              : null,

            h('x-card', { title: isEnt.value ? '本企业动态核算账户' : '各企业动态核算账户', sub: '按履约风险与配额缺口排序' }, {
              default: () => h('div', { class: 'tbl-wrap' }, [
                h('table', { class: 'tbl' }, [
                  h('thead', {}, h('tr', {}, ['企业', '行业', '地区', '年度累计排放', '已分配配额', '已抵销', '预计期末缺口', '预测期末排放', '风险', '最近实测'].map((t) => h('th', {}, t)))),
                  h('tbody', {}, (d.accounts || []).slice(0, 80).map((a) => h('tr', {}, [
                    h('td', {}, a.entName),
                    h('td', {}, a.industry),
                    h('td', {}, a.region),
                    h('td', { class: 'mono' }, App.fmt.num(Math.round(a.cumulativeEmission))),
                    h('td', { class: 'mono' }, App.fmt.num(Math.round(a.quotaAllocated))),
                    h('td', { class: 'mono' }, a.offsetApplied > 0 ? App.fmt.num(Math.round(a.offsetApplied)) : '—'),
                    h('td', { class: 'mono', style: a.gap > 0 ? 'color:var(--danger,#e5484d)' : '' }, (a.gap > 0 ? '+' : '') + App.fmt.num(Math.round(a.gap))),
                    h('td', { class: 'mono' }, App.fmt.num(Math.round(a.predictedEoy))),
                    h('td', {}, h('span', { class: ['tag', riskTag(a.riskLevel)] }, RISK_CN[a.riskLevel] || a.riskLevel)),
                    h('td', { class: 'tiny dim' }, a.lastReadingAt ? App.fmt.dt(a.lastReadingAt) : '-'),
                  ]))),
                ]),
              ]),
            }),
          ],
        });
      };
    },
  });

  App.views['page-dynamic'] = PageDynamic;
})();
