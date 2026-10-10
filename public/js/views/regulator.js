/* =====================================================================
   监管端：驾驶舱 / 企业名录 / 配额分配 / 交易监管 / 预警处置 / 统计分析 / 审计
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted } = Vue;
  const h = App.h;
  const YEAR = new Date().getFullYear();

  /* ==================================================================
   * 一、监管驾驶舱
   * ================================================================== */
  const PageRegOverview = defineComponent({
    name: 'page-reg-overview',
    setup() {
      const d = ref(null);
      const err = ref('');
      async function load() { try { d.value = await App.API.get('/regulator/overview'); err.value = ''; } catch (e) { err.value = e.message; } }
      onMounted(load);

      const trendOption = computed(() => {
        if (!d.value) return null;
        const t = d.value.trend;
        return App.chartBase({
          legend: { data: ['排放总量', '排放强度'], top: 0, right: 6 },
          grid: { left: 10, right: 26, top: 34, bottom: 6, containLabel: true },
          xAxis: App.catAxis(t.map((x) => x.period), { boundaryGap: false }),
          yAxis: [App.valAxis({ name: 'tCO₂e' }), App.valAxis({ name: '强度', splitLine: { show: false } })],
          series: [
            { name: '排放总量', type: 'line', smooth: true, symbolSize: 6, data: t.map((x) => x.total), lineStyle: { width: 2.6, color: '#10b981' }, itemStyle: { color: '#34d399' }, areaStyle: { color: App.areaGrad('rgba(16,185,129,.4)', 'rgba(16,185,129,.01)') } },
            { name: '排放强度', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 5, data: t.map((x) => x.intensity), lineStyle: { color: '#38bdf8', width: 2, type: 'dashed' }, itemStyle: { color: '#38bdf8' } },
          ],
        });
      });

      const priceOption = computed(() => {
        if (!d.value) return null;
        const p = d.value.priceTrend || [];
        return App.chartBase({
          legend: { data: ['成交均价', '成交量'], top: 0, right: 6 },
          grid: { left: 10, right: 26, top: 34, bottom: 6, containLabel: true },
          xAxis: App.catAxis(p.map((x) => x.month)),
          yAxis: [App.valAxis({ name: '元/吨' }), App.valAxis({ name: '吨', splitLine: { show: false } })],
          series: [
            { name: '成交量', type: 'bar', yAxisIndex: 1, barWidth: '40%', data: p.map((x) => x.volume), itemStyle: { borderRadius: [4, 4, 0, 0], color: 'rgba(56,189,248,.35)' } },
            { name: '成交均价', type: 'line', smooth: true, data: p.map((x) => x.avgPrice), lineStyle: { color: '#f5a524', width: 2.4 }, itemStyle: { color: '#fbbf24' } },
          ],
        });
      });

      const industryOption = computed(() => {
        if (!d.value) return null;
        return App.chartBase({
          tooltip: Object.assign(App.chartBase().tooltip, { trigger: 'item', formatter: '{b}<br/>{c} tCO₂e（{d}%）' }),
          legend: { orient: 'vertical', right: 4, top: 'center' },
          series: [{
            type: 'pie', radius: ['46%', '72%'], center: ['36%', '52%'],
            itemStyle: { borderColor: 'rgba(6,10,18,.9)', borderWidth: 2, borderRadius: 4 },
            label: { show: false }, labelLine: { show: false },
            data: d.value.byIndustry.map((x) => ({ name: x.name, value: Math.round(x.value) })),
          }],
        });
      });

      const regionOption = computed(() => {
        if (!d.value) return null;
        const list = (d.value.byRegion || []).slice().reverse();
        return App.chartBase({
          grid: { left: 10, right: 46, top: 14, bottom: 6, containLabel: true },
          tooltip: Object.assign(App.chartBase().tooltip, { formatter: (ps) => `${ps[0].name}<br/><b>${App.fmt.num(ps[0].value)}</b> tCO₂e` }),
          xAxis: App.valAxis({ show: false }),
          yAxis: App.catAxis(list.map((x) => x.name), { axisLabel: { fontSize: 10.5 } }),
          series: [{
            type: 'bar', data: list.map((x) => x.value), barWidth: 10,
            itemStyle: { borderRadius: [0, 5, 5, 0], color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: 'rgba(167,139,250,.3)' }, { offset: 1, color: '#a78bfa' }]) },
            label: { show: true, position: 'right', color: '#8d9cb5', fontSize: 10.5, formatter: (p) => App.fmt.big(p.value) },
          }],
        });
      });

      const verifyOption = computed(() => {
        if (!d.value) return null;
        const vp = d.value.verifyProgress;
        const items = [
          { name: '已核查', value: vp.VERIFIED || 0, color: '#10b981' },
          { name: '核查中', value: vp.VERIFYING || 0, color: '#a78bfa' },
          { name: '已提交', value: vp.SUBMITTED || 0, color: '#38bdf8' },
          { name: '草稿', value: vp.DRAFT || 0, color: 'rgba(255,255,255,.22)' },
          { name: '已驳回', value: vp.REJECTED || 0, color: '#fb7185' },
        ].filter((x) => x.value > 0);
        return App.chartBase({
          tooltip: Object.assign(App.chartBase().tooltip, { trigger: 'item', formatter: '{b}：{c} 份（{d}%）' }),
          legend: { orient: 'vertical', right: 4, top: 'center' },
          series: [{
            type: 'pie', radius: ['52%', '78%'], center: ['36%', '52%'],
            itemStyle: { borderColor: 'rgba(6,10,18,.9)', borderWidth: 2, borderRadius: 4 },
            label: { show: false }, labelLine: { show: false },
            data: items.map((x) => ({ name: x.name, value: x.value, itemStyle: { color: x.color } })),
          }],
        });
      });

      return () => {
        if (err.value) return h('div', {}, [h('x-page', { title: '监管驾驶舱' }), h('div', { class: 'alertbar err' }, [h('x-icon', { name: 'alert', size: 15 }), err.value])]);
        if (!d.value) return h('div', { class: 'grid g4' }, Array.from({ length: 8 }).map(() => h('div', { class: 'skel', style: 'height:118px' })));
        const k = d.value.kpi;

        return h('div', {}, [
          h('x-page', {
            title: '监管驾驶舱',
            desc: `全国碳排放权交易市场运行总览 · 统计口径：${YEAR} 年度（含历史存续数据）· 数据每 60 秒自动刷新`,
          }, {
            actions: () => [
              h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
              h('button', { class: 'btn sm', onClick: () => App.go('/reg/stats') }, [h('x-icon', { name: 'chart', size: 14 }), '深度分析']),
              h('button', { class: 'btn sm primary', onClick: () => App.go('/reg/allocations') }, [h('x-icon', { name: 'coin', size: 14 }), '配额分配']),
            ],
            default: () => [
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: '纳入控排企业', value: App.fmt.num(k.entCount), unit: '家', icon: 'factory', tone: 'carbon', foot: `正常经营 ${k.activeEnt} 家` }),
                h('x-kpi', { label: `${YEAR} 年度排放总量`, value: App.fmt.big(k.emissionYtd), unit: 'tCO₂e', icon: 'fire', tone: 'sky', foot: `${App.fmt.num(k.reports)} 份上报单 · 平均强度 ${k.avgIntensity}` }),
                h('x-kpi', { label: '已核证配额总量', value: App.fmt.big(k.quotaAllocated), unit: 'tCO₂e', icon: 'coin', tone: 'violet', foot: `已用完 ${App.fmt.big(k.quotaUsed)} · 剩余 ${App.fmt.big(k.quotaAvailable)}` }),
                h('x-kpi', { label: '存在履约缺口企业', value: k.gapCount, unit: '家', icon: 'alert', tone: 'rose', foot: '可用配额为负，需通过市场购买' }),
                h('x-kpi', { label: '市场成交笔数', value: App.fmt.num(k.dealCount), unit: '笔', icon: 'trade', tone: 'chain', foot: `累计成交 ${App.fmt.big(k.tradeVolume)} 吨` }),
                h('x-kpi', { label: '成交金额', value: App.fmt.big(k.turnover), unit: '元', icon: 'bank', tone: 'carbon', foot: `区间 ${k.minPrice} ~ ${k.maxPrice} 元/吨` }),
                h('x-kpi', { label: '碳配额均价', value: k.avgPrice, unit: '元/吨', icon: 'chart', tone: 'sky', foot: '全市场加权平均' }),
                h('x-kpi', { label: '未关闭预警', value: k.alertOpen, unit: '条', icon: 'alert', tone: 'rose', foot: `其中高风险 ${k.alertHigh} 条 · 累计 ${k.alertTotal} 条` }),
              ]),

              h('div', { class: 'grid g-3-2 mb-16' }, [
                h('x-card', { title: '全市场排放趋势', sub: '按报告期汇总的排放总量与排放强度' }, { default: () => h('x-chart', { option: trendOption.value, height: 'h300' }) }),
                h('x-card', { title: '核查进度', sub: `${YEAR} 年度上报单状态分布` }, { default: () => h('x-chart', { option: verifyOption.value, height: 'h300' }) }),
              ]),

              h('div', { class: 'grid g-3-2 mb-16' }, [
                h('x-card', { title: '碳配额价格与成交量', sub: '月度加权均价与成交规模' }, { default: () => h('x-chart', { option: priceOption.value, height: 'h300' }) }),
                h('x-card', { title: '行业排放结构' }, { default: () => h('x-chart', { option: industryOption.value, height: 'h300' }) }),
              ]),

              h('div', { class: 'grid g2 mb-16' }, [
                h('x-card', { title: '区域排放分布', sub: '按省级行政区（单位 tCO₂e）' }, { default: () => h('x-chart', { option: regionOption.value, height: 'h340' }) }),
                h('x-card', { title: '履约风险企业 TOP10', sub: '可用配额最少的十家企业', flush: true }, {
                  actions: () => h('button', { class: 'btn sm ghost', onClick: () => App.go('/reg/alerts') }, '预警中心'),
                  default: () => h('x-table', {
                    columns: [
                      { key: 'name', title: '企业名称' },
                      { key: 'industry', title: '行业', width: '80px' },
                      { key: 'total_allocated', title: '分配配额', align: 'right' },
                      { key: 'used', title: '实际排放', align: 'right' },
                      { key: 'gap', title: '可用余额', align: 'right' },
                    ],
                    rows: d.value.gapEnt,
                    rowClick: (r) => App.go('/reg/enterprises?focus=' + r.id),
                  }, {
                    'col-name': ({ value }) => h('span', { class: 'ellipsis', style: 'max-width:180px;display:inline-block' }, value),
                    'col-industry': ({ value }) => h('span', { class: 'tag t-mute plain' }, value),
                    'col-total_allocated': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
                    'col-used': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
                    'col-gap': ({ value }) => h('b', { class: 'mono', style: `color:${Number(value) >= 0 ? 'var(--carbon-l)' : '#fda4af'}` }, App.fmt.num(value, 0)),
                  }),
                }),
              ]),

              h('div', { class: 'grid g2' }, [
                h('x-card', { title: '排放量 TOP10 企业', flush: true }, {
                  actions: () => h('button', { class: 'btn sm ghost', onClick: () => App.go('/reg/enterprises') }, '企业名录'),
                  default: () => h('x-table', {
                    columns: [
                      { key: 'name', title: '企业名称' },
                      { key: 'industry', title: '行业', width: '80px' },
                      { key: 'value', title: '排放量(tCO₂e)', align: 'right' },
                      { key: 'intensity', title: '强度', align: 'right', width: '100px' },
                    ],
                    rows: d.value.topEnt,
                  }, {
                    'col-name': ({ value }) => h('span', { class: 'ellipsis', style: 'max-width:200px;display:inline-block' }, value),
                    'col-industry': ({ value }) => h('span', { class: 'tag t-mute plain' }, value),
                    'col-value': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 0)),
                    'col-intensity': ({ value }) => h('span', { class: 'mono muted' }, Number(value).toFixed(4)),
                  }),
                }),
                h('x-card', { title: '最新预警事项', flush: true }, {
                  actions: () => h('button', { class: 'btn sm ghost', onClick: () => App.go('/reg/alerts') }, '全部'),
                  default: () => h('x-table', {
                    columns: [
                      { key: 'title', title: '预警事项' },
                      { key: 'ent_name', title: '企业', width: '150px' },
                      { key: 'level', title: '级别', width: '70px' },
                      { key: 'status', title: '状态', width: '90px' },
                      { key: 'created_at', title: '时间', width: '110px' },
                    ],
                    rows: d.value.recentAlerts,
                  }, {
                    'col-ent_name': ({ value }) => h('span', { class: 'tiny ellipsis', style: 'max-width:150px;display:inline-block' }, value || '-'),
                    'col-level': ({ row }) => h('x-tag', { dict: App.DICT.alertLevel, dictKey: row.level }),
                    'col-status': ({ row }) => h('x-tag', { dict: App.DICT.alertStatus, dictKey: row.status }),
                    'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.ago(value)),
                  }),
                }),
              ]),
            ],
          }),
        ]);
      };
    },
  });

  /* ==================================================================
   * 二、企业名录
   * ================================================================== */
  const PageRegEnterprises = defineComponent({
    name: 'page-reg-enterprises',
    setup() {
      const pager = App.usePager((p) => App.API.get('/regulator/enterprises', p), { page: 1, size: 12 });
      const filters = reactive({ keyword: '', industry: '', region: '', status: '', scale: '' });
      const opts = ref({ industries: [], regions: [] });
      const detail = ref(null);
      const showDetail = ref(false);

      function load() { pager.load({ ...filters, page: pager.state.page, size: pager.state.size }); }
      onMounted(async () => {
        try { opts.value = await App.API.get('/regulator/enterprises/filters'); } catch (e) { /* ignore */ }
        load();
      });

      async function open(row) {
        try { detail.value = await App.API.get('/regulator/enterprises/' + row.id); showDetail.value = true; }
        catch (e) { App.notify.err(e.message); }
      }

      const quotaBar = computed(() => {
        if (!detail.value || !detail.value.quotas || !detail.value.quotas.length) return null;
        const q = detail.value.quotas[0];
        const alloc = Number(q.total_allocated) || 1;
        return { pct: Math.min((Number(q.used) / alloc) * 100, 130), q };
      });

      return () => h('div', {}, [
        h('x-page', {
          title: '控排企业名录',
          desc: '覆盖全国 28 个省级行政区的重点排放单位。点击任意企业可查看其上报表、配额账户、成交记录、预警事项与链上存证明细。',
        }, {
          default: () => h('x-card', { flush: true }, {
            head: () => h('div', { class: 'flex gap-8 wrap', style: 'flex:1;align-items:center' }, [
              h('div', { class: 'input-group', style: 'width:260px' }, [
                h('input', { class: 'input', placeholder: '企业名称 / 信用代码', value: filters.keyword, onInput: (e) => { filters.keyword = e.target.value; }, onKeyup: (e) => { if (e.key === 'Enter') load(); } }),
                h('button', { class: 'btn', onClick: load }, [h('x-icon', { name: 'search', size: 14 })]),
              ]),
              h('select', { class: 'select', style: 'width:120px', value: filters.industry, onChange: (e) => { filters.industry = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部行业'), ...opts.value.industries.map((x) => h('option', { value: x }, x)),
              ]),
              h('select', { class: 'select', style: 'width:150px', value: filters.region, onChange: (e) => { filters.region = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部地区'), ...opts.value.regions.map((x) => h('option', { value: x }, x)),
              ]),
              h('select', { class: 'select', style: 'width:120px', value: filters.scale, onChange: (e) => { filters.scale = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部规模'), ['大型', '中型', '小型'].map((x) => h('option', { value: x }, x)),
              ]),
              h('select', { class: 'select', style: 'width:130px', value: filters.status, onChange: (e) => { filters.status = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部状态'), ...Object.keys(App.DICT.entStatus).map((k) => h('option', { value: k }, App.DICT.entStatus[k][0])),
              ]),
            ]),
            default: () => [
              h('x-table', {
                columns: [
                  { key: 'ent_name', title: '企业名称' },
                  { key: 'ent_code', title: '统一社会信用代码', width: '190px' },
                  { key: 'industry', title: '行业', width: '85px' },
                  { key: 'region', title: '地区', width: '110px' },
                  { key: 'scale', title: '规模', width: '70px' },
                  { key: 'emission_ytd', title: '本年度排放(tCO₂e)', align: 'right' },
                  { key: 'total_allocated', title: '分配配额', align: 'right' },
                  { key: 'available', title: '可用余额', align: 'right' },
                  { key: 'credit_score', title: '信用分', align: 'right', width: '80px' },
                  { key: 'verified_reports', title: '已核证', align: 'right', width: '80px' },
                  { key: 'chain_txs', title: '存证笔数', align: 'right', width: '90px' },
                  { key: 'status', title: '状态', width: '105px' },
                ],
                rows: pager.state.rows, loading: pager.state.loading, rowClick: open,
              }, {
                'col-ent_code': ({ value }) => h('span', { class: 'mono tiny' }, value),
                'col-industry': ({ value }) => h('span', { class: 'tag t-mute plain' }, value),
                'col-scale': ({ value }) => h('span', { class: 'tag plain ' + (App.DICT.scale[value] || 't-mute') }, value),
                'col-emission_ytd': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 0)),
                'col-total_allocated': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
                'col-available': ({ value }) => h('span', { class: 'mono', style: `color:${Number(value) >= 0 ? 'var(--carbon-l)' : '#fda4af'}` }, App.fmt.num(value, 0)),
                'col-verified_reports': ({ value }) => h('span', { class: 'mono muted' }, value),
                'col-chain_txs': ({ value }) => h('span', { class: 'tag t-chain plain' }, value),
                'col-status': ({ row }) => h('x-tag', { dict: App.DICT.entStatus, dictKey: row.status }),
              }),
              h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
            ],
          }),
        }),

        /* 企业详情 */
        h('x-modal', {
          modelValue: showDetail.value,
          title: detail.value ? `企业档案 · ${detail.value.ent_name}` : '企业档案',
          width: '1040px',
          'onUpdate:modelValue': (v) => { showDetail.value = v; },
        }, {
          default: () => {
            if (!detail.value) return null;
            const e = detail.value;
            return h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: '统一社会信用代码', value: e.ent_code, tone: 'sky', foot: `${e.industry} · ${e.scale}企业` }),
                h('x-kpi', { label: '年产值', value: App.fmt.big(e.annual_output), unit: '万元', tone: 'violet', foot: `员工 ${App.fmt.num(e.headcount)} 人` }),
                h('x-kpi', { label: '碳信用分', value: e.credit_score, unit: '分', tone: e.credit_score >= 85 ? 'carbon' : 'rose', foot: `状态 ${App.DICT.entStatus[e.status] ? App.DICT.entStatus[e.status][0] : e.status}` }),
                h('x-kpi', { label: '链上钱包', value: App.fmt.addr(e.wallet_address), tone: 'chain', foot: '点击下方可复制完整地址' }),
              ]),

              quotaBar.value && h('x-card', { title: '配额履约情况', class: 'mb-16' }, {
                default: () => h('div', {}, [
                  h('div', { class: 'bar-row' }, [
                    h('div', { class: 'nm' }, '配额使用率'),
                    h('div', { class: 'bar-track' }, [h('div', {
                      class: ['bar-fill', quotaBar.value.pct > 100 ? 'danger' : quotaBar.value.pct > 85 ? 'warn' : ''],
                      style: `width:${Math.min(quotaBar.value.pct, 100)}%`,
                    })]),
                    h('div', { class: 'vv' }, quotaBar.value.pct.toFixed(1) + '%'),
                  ]),
                  h('div', { class: 'grid g4 mt-12' }, [
                    h('div', { class: 'readout' }, [h('span', { class: 'k' }, '分配配额'), h('span', { class: 'mono', style: 'margin-left:auto' }, App.fmt.num(quotaBar.value.q.total_allocated, 0))]),
                    h('div', { class: 'readout' }, [h('span', { class: 'k' }, '实际排放'), h('span', { class: 'mono', style: 'margin-left:auto' }, App.fmt.num(quotaBar.value.q.used, 0))]),
                    h('div', { class: 'readout' }, [h('span', { class: 'k' }, '买入/卖出'), h('span', { class: 'mono', style: 'margin-left:auto' }, `${App.fmt.num(quotaBar.value.q.bought, 0)} / ${App.fmt.num(quotaBar.value.q.sold, 0)}`)]),
                    h('div', { class: 'readout' }, [h('span', { class: 'k' }, '可用余额'), h('span', { class: 'mono', style: `margin-left:auto;color:${Number(quotaBar.value.q.available) >= 0 ? 'var(--carbon-l)' : '#fda4af'}` }, App.fmt.num(quotaBar.value.q.available, 0))]),
                  ]),
                ]),
              }),

              h('div', { class: 'grid g2 mb-16' }, [
                h('x-card', { title: '近期上报单', flush: true }, {
                  default: () => h('x-table', {
                    columns: [
                      { key: 'report_no', title: '上报单号' }, { key: 'period', title: '报告期', width: '85px' },
                      { key: 'total_emission', title: '排放量', align: 'right' }, { key: 'status', title: '状态', width: '95px' },
                      { key: 'chain_block_index', title: '链上', width: '90px' },
                    ],
                    rows: e.reports,
                  }, {
                    'col-report_no': ({ value }) => h('span', { class: 'mono tiny' }, value),
                    'col-period': ({ value }) => h('span', { class: 'tag t-info plain mono' }, value),
                    'col-total_emission': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
                    'col-status': ({ row }) => h('x-tag', { dict: App.DICT.reportStatus, dictKey: row.status }),
                    'col-chain_block_index': ({ value }) => h('x-chainbadge', { block: value }),
                  }),
                }),
                h('x-card', { title: '近期成交', flush: true }, {
                  default: () => h('x-table', {
                    columns: [
                      { key: 'deal_no', title: '成交编号' }, { key: 'price', title: '价格', align: 'right', width: '85px' },
                      { key: 'amount', title: '数量(t)', align: 'right' }, { key: 'deal_time', title: '时间', width: '120px' },
                    ],
                    rows: e.deals,
                  }, {
                    'col-deal_no': ({ value }) => h('span', { class: 'mono tiny' }, value),
                    'col-price': ({ value }) => h('span', { class: 'mono', style: 'color:var(--chain-l)' }, Number(value).toFixed(2)),
                    'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
                    'col-deal_time': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                  }),
                }),
              ]),

              h('div', { class: 'grid g2' }, [
                h('x-card', { title: '预警记录', flush: true }, {
                  default: () => e.alerts.length ? h('x-table', {
                    columns: [{ key: 'title', title: '预警事项' }, { key: 'level', title: '级别', width: '70px' }, { key: 'status', title: '状态', width: '90px' }],
                    rows: e.alerts,
                  }, {
                    'col-level': ({ row }) => h('x-tag', { dict: App.DICT.alertLevel, dictKey: row.level }),
                    'col-status': ({ row }) => h('x-tag', { dict: App.DICT.alertStatus, dictKey: row.status }),
                  }) : h('div', { class: 'empty' }, '暂无预警'),
                }),
                h('x-card', { title: '链上存证记录', flush: true }, {
                  default: () => h('x-table', {
                    columns: [
                      { key: 'tx_type', title: '类型', width: '140px' }, { key: 'biz_no', title: '业务单号' },
                      { key: 'block_index', title: '区块', width: '90px' }, { key: 'created_at', title: '时间', width: '120px' },
                    ],
                    rows: e.chainTxs,
                    rowClick: (r) => { showDetail.value = false; App.go('/explorer/tx/' + r.tx_id); },
                  }, {
                    'col-tx_type': ({ row }) => h('x-tag', { dict: App.DICT.txType, dictKey: row.tx_type }),
                    'col-biz_no': ({ value }) => h('span', { class: 'mono tiny' }, value),
                    'col-block_index': ({ value }) => h('x-chainbadge', { block: value }),
                    'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                  }),
                }),
              ]),
            ]);
          },
          footer: () => [h('button', { class: 'btn', onClick: () => { showDetail.value = false; } }, '关闭')],
        }),
      ]);
    },
  });

  /* ==================================================================
   * 三、配额分配
   * ================================================================== */
  const PageRegAllocations = defineComponent({
    name: 'page-reg-allocations',
    setup() {
      const pager = App.usePager((p) => App.API.get('/regulator/allocations', p), { page: 1, size: 12 });
      const filters = reactive({ year: String(YEAR), type: '', keyword: '' });
      const summary = ref(null);
      const showForm = ref(false);
      const busy = ref(false);
      const ents = ref([]);
      const form = reactive({ entId: '', year: YEAR, amount: 10000, allocType: 'FREE', allocMethod: '行业基准线法', baseline: 1.2 });

      function load() {
        pager.load({ year: filters.year, type: filters.type, keyword: filters.keyword }, {});
        App.API.get('/regulator/allocations', { year: filters.year, page: 1, size: 1 })
          .then((d) => { summary.value = d.summary; }).catch(() => {});
      }
      onMounted(async () => {
        load();
        try { const d = await App.API.get('/regulator/enterprises', { page: 1, size: 200 }); ents.value = d.rows; } catch (e) { /* ignore */ }
      });

      async function submit() {
        busy.value = true;
        try {
          const r = await App.API.post('/regulator/allocations', {
            entId: Number(form.entId), year: Number(form.year), amount: Number(form.amount),
            allocType: form.allocType, allocMethod: form.allocMethod, baseline: form.baseline,
          });
          App.notify.ok(`配额分配成功并已上链存证（区块 #${r.chain.blockIndex}）`);
          showForm.value = false;
          load();
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      return () => h('div', {}, [
        h('x-page', {
          title: '碳配额分配管理',
          desc: '按「历史强度法 / 行业基准线法 / 历史总量法」核定企业年度免费配额，另可通过有偿竞价与政府回购进行市场调节。每次分配都会同步写入配额账户并生成链上存证。',
        }, {
          actions: () => h('button', { class: 'btn sm primary', onClick: () => { showForm.value = true; } }, [h('x-icon', { name: 'plus', size: 14 }), '下发配额']),
          default: () => [
            summary.value && h('div', { class: 'grid g3 mb-16' }, [
              h('x-kpi', { label: `${filters.year} 年度累计分配配额`, value: App.fmt.big(summary.value.total), unit: 'tCO₂e', icon: 'coin', tone: 'carbon' }),
              h('x-kpi', { label: '分配流水笔数', value: App.fmt.num(summary.value.count), unit: '笔', icon: 'report', tone: 'sky', foot: '每笔均生成链上存证' }),
              h('x-kpi', { label: '平均单笔分配量', value: App.fmt.big(summary.value.count ? summary.value.total / summary.value.count : 0), unit: 'tCO₂e', icon: 'chart', tone: 'violet' }),
            ]),

            h('x-card', { flush: true }, {
              head: () => h('div', { class: 'flex gap-8 wrap', style: 'flex:1;align-items:center' }, [
                h('select', { class: 'select', style: 'width:120px', value: filters.year, onChange: (e) => { filters.year = e.target.value; load(); } },
                  [YEAR, YEAR - 1, YEAR - 2].map((y) => h('option', { value: String(y) }, y + ' 年度'))),
                h('select', { class: 'select', style: 'width:150px', value: filters.type, onChange: (e) => { filters.type = e.target.value; load(); } }, [
                  h('option', { value: '' }, '全部类型'), ...Object.keys(App.DICT.allocType).map((k) => h('option', { value: k }, App.DICT.allocType[k][0])),
                ]),
                h('div', { class: 'input-group', style: 'width:250px' }, [
                  h('input', { class: 'input', placeholder: '分配单号 / 企业名', value: filters.keyword, onInput: (e) => { filters.keyword = e.target.value; }, onKeyup: (e) => { if (e.key === 'Enter') load(); } }),
                  h('button', { class: 'btn', onClick: load }, [h('x-icon', { name: 'search', size: 14 })]),
                ]),
              ]),
              default: () => [
                h('x-table', {
                  columns: [
                    { key: 'alloc_no', title: '分配单号', width: '170px' },
                    { key: 'ent_name', title: '企业名称' },
                    { key: 'industry', title: '行业', width: '80px' },
                    { key: 'region', title: '地区', width: '110px' },
                    { key: 'year', title: '年度', width: '75px' },
                    { key: 'quota_amount', title: '分配量(tCO₂e)', align: 'right' },
                    { key: 'alloc_type', title: '类型', width: '110px' },
                    { key: 'alloc_method', title: '核定方法', width: '130px' },
                    { key: 'operator', title: '操作人', width: '90px' },
                    { key: 'chain_block_index', title: '链上存证', width: '110px' },
                    { key: 'created_at', title: '分配时间', width: '150px' },
                  ],
                  rows: pager.state.rows, loading: pager.state.loading,
                }, {
                  'col-alloc_no': ({ value }) => h('span', { class: 'mono' }, value),
                  'col-ent_name': ({ value }) => h('span', { class: 'ellipsis', style: 'max-width:200px;display:inline-block' }, value),
                  'col-industry': ({ value }) => h('span', { class: 'tag t-mute plain' }, value),
                  'col-quota_amount': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 2)),
                  'col-alloc_type': ({ row }) => h('x-tag', { dict: App.DICT.allocType, dictKey: row.alloc_type }),
                  'col-chain_block_index': ({ row }) => h('x-chainbadge', { block: row.chain_block_index, hash: row.chain_tx_id }),
                  'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                }),
                h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
              ],
            }),
          ],
        }),

        h('x-modal', { modelValue: showForm.value, title: '下发年度碳配额', width: '620px', 'onUpdate:modelValue': (v) => { showForm.value = v; } }, {
          default: () => h('div', {}, [
            h('div', { class: 'field' }, [
              h('label', {}, '选择企业'),
              h('select', { class: 'select', value: form.entId, onChange: (e) => { form.entId = e.target.value; } }, [
                h('option', { value: '' }, '请选择企业…'),
                ...ents.value.map((x) => h('option', { value: x.id }, `${x.ent_name}（${x.industry} · ${x.region}）`)),
              ]),
            ]),
            h('div', { class: 'grid g2' }, [
              h('div', { class: 'field' }, [h('label', {}, '配额年度'), h('input', { class: 'input', type: 'number', value: form.year, onInput: (e) => { form.year = e.target.value; } })]),
              h('div', { class: 'field' }, [h('label', {}, '分配量（tCO₂e）'), h('input', { class: 'input', type: 'number', value: form.amount, onInput: (e) => { form.amount = e.target.value; } })]),
              h('div', { class: 'field' }, [
                h('label', {}, '分配类型'),
                h('select', { class: 'select', value: form.allocType, onChange: (e) => { form.allocType = e.target.value; } }, [
                  h('option', { value: 'FREE' }, '免费分配'),
                  h('option', { value: 'AUCTION' }, '有偿竞价'),
                  h('option', { value: 'BUYBACK' }, '政府回购'),
                ]),
              ]),
              h('div', { class: 'field' }, [
                h('label', {}, '核定方法'),
                h('select', { class: 'select', value: form.allocMethod, onChange: (e) => { form.allocMethod = e.target.value; } }, ['历史强度法', '行业基准线法', '历史总量法', '基准价竞拍'].map((x) => h('option', { value: x }, x))),
              ]),
            ]),
            form.allocMethod === '行业基准线法' && h('div', { class: 'field' }, [
              h('label', {}, '基准强度（tCO₂e/万元）'),
              h('input', { class: 'input', type: 'number', step: '0.01', value: form.baseline, onInput: (e) => { form.baseline = e.target.value; } }),
            ]),
            h('div', { class: 'alertbar info' }, [
              h('x-icon', { name: 'info', size: 15 }),
              '提交后系统将：① 更新企业配额账户余额；② 以监管节点私钥签名并上链存证，业务单号、分配量、核定方法与操作人一同写入区块，事后不可抵赖。',
            ]),
          ]),
          footer: () => [
            h('button', { class: 'btn', onClick: () => { showForm.value = false; } }, '取消'),
            h('button', { class: 'btn primary', disabled: busy.value || !form.entId, onClick: submit }, [h('x-icon', { name: 'chain', size: 15 }), busy.value ? '提交中…' : '确认分配并上链']),
          ],
        }),
      ]);
    },
  });

  /* ==================================================================
   * 四、交易监管
   * ================================================================== */
  const PageRegTrades = defineComponent({
    name: 'page-reg-trades',
    setup() {
      const pager = App.usePager((p) => App.API.get('/regulator/trades', p), { page: 1, size: 12 });
      const stat = ref(null);
      const anomalies = ref([]);
      const filter = reactive({ minPrice: '', maxPrice: '', keyword: '' });

      function load() { pager.load({ ...filter }); }
      onMounted(async () => {
        try {
          const first = await App.API.get('/regulator/trades', { page: 1, size: 12 });
          pager.state.rows = first.rows; pager.state.total = first.total;
          pager.state.pages = first.pages; pager.state.page = first.page; pager.state.size = first.size;
          stat.value = first.priceStat; anomalies.value = first.anomalies;
        } catch (e) { App.notify.err(e.message); }
      });

      async function reload() {
        try {
          const d = await App.API.get('/regulator/trades', { ...filter, page: pager.state.page, size: pager.state.size });
          pager.state.rows = d.rows; pager.state.total = d.total; pager.state.pages = d.pages;
          stat.value = d.priceStat; anomalies.value = d.anomalies;
        } catch (e) { App.notify.err(e.message); }
      }

      const priceOption = computed(() => {
        if (!stat.value) return null;
        // 用成交流水还原价格区间分布
        return null;
      });

      return () => h('div', {}, [
        h('x-page', {
          title: '碳市场交易监管',
          desc: '对全市场成交明细进行穿透式监管，自动检测偏离均值 2 倍标准差的异常报价，并支持按价格区间筛选核查。',
        }, {
          actions: () => h('button', { class: 'btn sm', onClick: reload }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          default: () => [
            stat.value && h('div', { class: 'grid g5 mb-16' }, [
              h('x-kpi', { label: '成交均价', value: stat.value.avgPrice, unit: '元/吨', icon: 'chart', tone: 'carbon' }),
              h('x-kpi', { label: '价格标准差', value: stat.value.stdPrice, unit: '元/吨', icon: 'target', tone: 'sky', foot: '超过 ±2σ 判定为异常' }),
              h('x-kpi', { label: '最高成交价', value: stat.value.maxPrice, unit: '元/吨', icon: 'arrowUp', tone: 'rose' }),
              h('x-kpi', { label: '最低成交价', value: stat.value.minPrice, unit: '元/吨', icon: 'arrowDown', tone: 'violet' }),
              h('x-kpi', { label: '累计成交笔数', value: App.fmt.num(stat.value.count), unit: '笔', icon: 'trade', tone: 'chain' }),
            ]),

            anomalies.value && anomalies.value.length > 0 && h('x-card', { title: '价格异动监测', sub: '成交价偏离全市场均值 2 倍标准差，建议核查是否存在异常交易', class: 'mb-16', flush: true }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'deal_no', title: '成交编号', width: '170px' },
                  { key: 'price', title: '成交价', align: 'right' },
                  { key: 'amount', title: '成交量(t)', align: 'right' },
                  { key: 'buyer_name', title: '买方' },
                  { key: 'seller_name', title: '卖方' },
                  { key: 'deal_time', title: '成交时间', width: '160px' },
                ],
                rows: anomalies.value,
              }, {
                'col-deal_no': ({ value }) => h('span', { class: 'mono' }, value),
                'col-price': ({ value, row }) => {
                  const dev = stat.value && stat.value.avgPrice ? ((Number(value) - stat.value.avgPrice) / stat.value.avgPrice * 100) : 0;
                  return h('b', { class: 'mono', style: `color:${Math.abs(dev) > 8 ? '#fda4af' : 'var(--chain-l)'}` }, Number(value).toFixed(2) + ` (${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%)`);
                },
                'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
                'col-buyer_name': ({ value }) => h('span', { class: 'tiny ellipsis', style: 'max-width:160px;display:inline-block' }, value),
                'col-seller_name': ({ value }) => h('span', { class: 'tiny ellipsis', style: 'max-width:160px;display:inline-block' }, value),
                'col-deal_time': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
              }),
            }),

            h('x-card', { flush: true }, {
              head: () => h('div', { class: 'flex gap-8 wrap', style: 'flex:1;align-items:center' }, [
                h('div', { class: 'input-group', style: 'width:250px' }, [
                  h('input', { class: 'input', placeholder: '成交编号 / 企业名', value: filter.keyword, onInput: (e) => { filter.keyword = e.target.value; }, onKeyup: (e) => { if (e.key === 'Enter') { pager.state.page = 1; reload(); } } }),
                  h('button', { class: 'btn', onClick: () => { pager.state.page = 1; reload(); } }, [h('x-icon', { name: 'search', size: 14 })]),
                ]),
                h('input', { class: 'input', style: 'width:150px', type: 'number', placeholder: '最低价', value: filter.minPrice, onInput: (e) => { filter.minPrice = e.target.value; } }),
                h('input', { class: 'input', style: 'width:150px', type: 'number', placeholder: '最高价', value: filter.maxPrice, onInput: (e) => { filter.maxPrice = e.target.value; } }),
                h('button', { class: 'btn', onClick: () => { pager.state.page = 1; reload(); } }, '筛选'),
              ]),
              default: () => [
                h('x-table', {
                  columns: [
                    { key: 'deal_no', title: '成交编号', width: '170px' },
                    { key: 'buyer_name', title: '买方' },
                    { key: 'seller_name', title: '卖方' },
                    { key: 'price', title: '成交价(元/吨)', align: 'right' },
                    { key: 'amount', title: '成交量(t)', align: 'right' },
                    { key: 'total_amount', title: '成交金额(元)', align: 'right' },
                    { key: 'fee', title: '手续费(元)', align: 'right' },
                    { key: 'chain_block_index', title: '链上存证', width: '110px' },
                    { key: 'deal_time', title: '成交时间', width: '160px' },
                  ],
                  rows: pager.state.rows, loading: pager.state.loading,
                }, {
                  'col-deal_no': ({ value }) => h('span', { class: 'mono' }, value),
                  'col-buyer_name': ({ value }) => h('span', { class: 'tiny ellipsis', style: 'max-width:170px;display:inline-block' }, value),
                  'col-seller_name': ({ value }) => h('span', { class: 'tiny ellipsis', style: 'max-width:170px;display:inline-block' }, value),
                  'col-price': ({ value }) => h('b', { class: 'mono', style: 'color:var(--chain-l)' }, Number(value).toFixed(2)),
                  'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
                  'col-total_amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
                  'col-fee': ({ value }) => h('span', { class: 'mono muted' }, App.fmt.num(value, 2)),
                  'col-chain_block_index': ({ row }) => h('x-chainbadge', { block: row.chain_block_index, hash: row.chain_tx_id }),
                  'col-deal_time': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                }),
                h('x-pager', {
                  page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size,
                  onChange: (p) => { pager.state.page = p; reload(); },
                }),
              ],
            }),
          ],
        }),
      ]);
    },
  });

  /* ==================================================================
   * 五、预警处置
   * ================================================================== */
  const PageRegAlerts = defineComponent({
    name: 'page-reg-alerts',
    setup() {
      const pager = App.usePager((p) => App.API.get('/regulator/alerts', p), { page: 1, size: 12 });
      const filters = reactive({ type: '', level: '', status: '', keyword: '' });
      const stat = ref([]);
      const cur = ref(null);
      const showHandle = ref(false);
      const note = ref('');
      const busy = ref(false);

      function load() {
        pager.load({ ...filters });
        App.API.get('/regulator/alerts', { page: 1, size: 1 }).then((d) => { stat.value = d.stat; }).catch(() => {});
      }
      onMounted(load);

      const byType = computed(() => {
        const m = {};
        stat.value.forEach((s) => {
          const k = s.type;
          if (!m[k]) m[k] = { name: (App.DICT.alertType[k] || [k])[0], open: 0, total: 0, high: 0 };
          m[k].total += Number(s.cnt);
          if (s.status === 'OPEN') m[k].open += Number(s.cnt);
          if (s.level === 'HIGH') m[k].high += Number(s.cnt);
        });
        return Object.values(m).sort((a, b) => b.total - a.total);
      });

      function openHandle(row) { cur.value = row; note.value = ''; showHandle.value = true; }

      async function doHandle(status) {
        busy.value = true;
        try {
          await App.API.post(`/regulator/alerts/${cur.value.id}/handle`, { status, note: note.value });
          App.notify.ok(status === 'CLOSED' ? '预警已关闭' : '预警已受理');
          showHandle.value = false;
          load();
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      return () => h('div', {}, [
        h('x-page', {
          title: '预警与风险处置',
          desc: '平台自动监测配额超限、数据异常、漏报、价格异动与链上风险五类情形并生成预警。处置过程全程留痕，可追溯至具体经办人与处置说明。',
        }, {
          default: () => [
            h('div', { class: 'grid g-2-1 mb-16' }, [
              h('x-card', { title: '预警类型分布', sub: '按类型统计的产生量与待处理量' }, {
                default: () => h('div', {}, byType.value.map((t) => h('div', { class: 'bar-row' }, [
                  h('div', { class: 'nm' }, t.name),
                  h('div', { class: 'bar-track' }, [h('div', {
                    class: ['bar-fill', t.open > 0 ? 'warn' : ''],
                    style: `width:${Math.max(3, (t.total / Math.max(...byType.value.map((x) => x.total), 1)) * 100)}%`,
                  })]),
                  h('div', { class: 'vv' }, `${t.total} 条 / 待处理 ${t.open}`),
                ]))),
              }),
              h('x-card', { title: '处置提示' }, {
                default: () => h('div', { class: 'col gap-12' }, [
                  h('div', { class: 'alertbar warn' }, [h('x-icon', { name: 'alert', size: 15 }), '高风险预警应在 3 个工作日内完成核查，并督促企业提交整改报告。']),
                  h('div', { class: 'alertbar info' }, [h('x-icon', { name: 'info', size: 15 }), '预警记录与操作日志可作为碳排放数据质量执法的证据链，链上存证部分可供司法核验。']),
                ]),
              }),
            ]),

            h('x-card', { flush: true }, {
              head: () => h('div', { class: 'flex gap-8 wrap', style: 'flex:1;align-items:center' }, [
                h('select', { class: 'select', style: 'width:150px', value: filters.type, onChange: (e) => { filters.type = e.target.value; load(); } }, [
                  h('option', { value: '' }, '全部类型'), ...Object.keys(App.DICT.alertType).map((k) => h('option', { value: k }, App.DICT.alertType[k][0])),
                ]),
                h('select', { class: 'select', style: 'width:110px', value: filters.level, onChange: (e) => { filters.level = e.target.value; load(); } }, [
                  h('option', { value: '' }, '全部级别'), ...Object.keys(App.DICT.alertLevel).map((k) => h('option', { value: k }, App.DICT.alertLevel[k][0])),
                ]),
                h('select', { class: 'select', style: 'width:120px', value: filters.status, onChange: (e) => { filters.status = e.target.value; load(); } }, [
                  h('option', { value: '' }, '全部状态'), ...Object.keys(App.DICT.alertStatus).map((k) => h('option', { value: k }, App.DICT.alertStatus[k][0])),
                ]),
                h('div', { class: 'input-group', style: 'width:240px' }, [
                  h('input', { class: 'input', placeholder: '标题 / 企业名', value: filters.keyword, onInput: (e) => { filters.keyword = e.target.value; }, onKeyup: (e) => { if (e.key === 'Enter') load(); } }),
                  h('button', { class: 'btn', onClick: load }, [h('x-icon', { name: 'search', size: 14 })]),
                ]),
              ]),
              default: () => [
                h('x-table', {
                  columns: [
                    { key: 'alert_no', title: '预警编号', width: '150px' },
                    { key: 'alert_type', title: '类型', width: '115px' },
                    { key: 'level', title: '级别', width: '75px' },
                    { key: 'title', title: '预警事项' },
                    { key: 'ent_name', title: '相关企业', width: '200px' },
                    { key: 'status', title: '状态', width: '95px' },
                    { key: 'handler', title: '处理人', width: '90px' },
                    { key: 'created_at', title: '产生时间', width: '125px' },
                    { key: '_act', title: '操作', width: '90px' },
                  ],
                  rows: pager.state.rows, loading: pager.state.loading,
                }, {
                  'col-alert_no': ({ value }) => h('span', { class: 'mono' }, value),
                  'col-alert_type': ({ row }) => h('x-tag', { dict: App.DICT.alertType, dictKey: row.alert_type }),
                  'col-level': ({ row }) => h('x-tag', { dict: App.DICT.alertLevel, dictKey: row.level }),
                  'col-ent_name': ({ value }) => h('span', { class: 'tiny ellipsis', style: 'max-width:200px;display:inline-block' }, value || '-'),
                  'col-status': ({ row }) => h('x-tag', { dict: App.DICT.alertStatus, dictKey: row.status }),
                  'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.ago(value)),
                  'col-_act': ({ row }) => ['OPEN', 'HANDLING'].includes(row.status)
                    ? h('button', { class: 'btn sm', onClick: () => openHandle(row) }, '处置')
                    : h('span', { class: 'dim tiny' }, '已闭环'),
                }),
                h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
              ],
            }),
          ],
        }),

        h('x-modal', { modelValue: showHandle.value, title: '预警处置', width: '640px', 'onUpdate:modelValue': (v) => { showHandle.value = v; } }, {
          default: () => cur.value && h('div', {}, [
            h('dl', { class: 'kv mb-16' }, [
              h('dt', {}, '预警编号'), h('dd', { class: 'mono' }, cur.value.alert_no),
              h('dt', {}, '类型 / 级别'), h('dd', {}, [h('x-tag', { dict: App.DICT.alertType, dictKey: cur.value.alert_type }), ' ', h('x-tag', { dict: App.DICT.alertLevel, dictKey: cur.value.level })]),
              h('dt', {}, '相关企业'), h('dd', {}, cur.value.ent_name || '-'),
              h('dt', {}, '触发指标'), h('dd', { class: 'mono' }, cur.value.metric || '-'),
              h('dt', {}, '预警详情'), h('dd', {}, cur.value.content),
              h('dt', {}, '产生时间'), h('dd', {}, App.fmt.dt(cur.value.created_at)),
            ]),
            h('div', { class: 'field' }, [
              h('label', {}, '处置说明'),
              h('textarea', { class: 'textarea', placeholder: '请填写核查情况、整改要求与处置结论…', value: note.value, onInput: (e) => { note.value = e.target.value; } }),
            ]),
          ]),
          footer: () => [
            h('button', { class: 'btn', onClick: () => { showHandle.value = false; } }, '取消'),
            h('button', { class: 'btn', disabled: busy.value, onClick: () => doHandle('HANDLING') }, '标记为处理中'),
            h('button', { class: 'btn primary', disabled: busy.value, onClick: () => doHandle('CLOSED') }, [h('x-icon', { name: 'check', size: 15 }), '完成闭环']),
          ],
        }),
      ]);
    },
  });

  /* ==================================================================
   * 六、统计分析
   * ================================================================== */
  const PageRegStats = defineComponent({
    name: 'page-reg-stats',
    setup() {
      const d = ref(null);
      const year = ref(YEAR);
      async function load() { try { d.value = await App.API.get('/regulator/statistics', { year: year.value }); } catch (e) { App.notify.err(e.message); } }
      onMounted(load);

      const industryOption = computed(() => {
        if (!d.value) return null;
        const list = d.value.industries;
        return App.chartBase({
          legend: { data: ['排放总量', '排放强度'], top: 0, right: 6 },
          grid: { left: 10, right: 26, top: 34, bottom: 6, containLabel: true },
          xAxis: App.catAxis(list.map((x) => x.name)),
          yAxis: [App.valAxis({ name: 'tCO₂e' }), App.valAxis({ name: '强度', splitLine: { show: false } })],
          series: [
            { name: '排放总量', type: 'bar', barWidth: '44%', data: list.map((x) => Math.round(x.emission)), itemStyle: { borderRadius: [5, 5, 0, 0], color: App.areaGrad('#10b981', 'rgba(16,185,129,.28)') } },
            { name: '排放强度', type: 'line', yAxisIndex: 1, smooth: true, data: list.map((x) => x.intensity), lineStyle: { color: '#f5a524', width: 2 }, itemStyle: { color: '#fbbf24' } },
          ],
        });
      });

      const energyOption = computed(() => {
        if (!d.value) return null;
        return App.chartBase({
          tooltip: Object.assign(App.chartBase().tooltip, { trigger: 'item', formatter: '{b}<br/>{c} tCO₂e（{d}%）' }),
          legend: { orient: 'vertical', right: 4, top: 'center' },
          series: [{
            type: 'pie', radius: ['44%', '72%'], center: ['34%', '52%'], roseType: 'radius',
            itemStyle: { borderColor: 'rgba(6,10,18,.9)', borderWidth: 2, borderRadius: 4 },
            label: { show: false }, labelLine: { show: false },
            data: d.value.energyMix.map((x) => ({ name: x.name, value: Math.round(x.value) })),
          }],
        });
      });

      const regionOption = computed(() => {
        if (!d.value) return null;
        const list = d.value.regions;
        return App.chartBase({
          grid: { left: 10, right: 16, top: 22, bottom: 6, containLabel: true },
          xAxis: App.catAxis(list.map((x) => x.name), { axisLabel: { rotate: 38, fontSize: 10 } }),
          yAxis: App.valAxis({ name: 'tCO₂e' }),
          series: [{
            type: 'bar', data: list.map((x) => Math.round(x.emission)), barWidth: '56%',
            itemStyle: { borderRadius: [4, 4, 0, 0], color: App.areaGrad('#a78bfa', 'rgba(167,139,250,.22)') },
          }],
        });
      });

      const reductionOption = computed(() => {
        if (!d.value) return null;
        const t = d.value.reduction;
        return App.chartBase({
          legend: { data: ['排放总量', '平均同比变化率'], top: 0, right: 6 },
          grid: { left: 10, right: 26, top: 34, bottom: 6, containLabel: true },
          xAxis: App.catAxis(t.map((x) => x.period), { boundaryGap: false }),
          yAxis: [App.valAxis({ name: 'tCO₂e' }), App.valAxis({ name: '%', splitLine: { show: false } })],
          series: [
            { name: '排放总量', type: 'line', smooth: true, data: t.map((x) => x.total), lineStyle: { width: 2.6, color: '#10b981' }, itemStyle: { color: '#34d399' }, areaStyle: { color: App.areaGrad('rgba(16,185,129,.38)', 'rgba(16,185,129,.01)') } },
            { name: '平均同比变化率', type: 'line', yAxisIndex: 1, smooth: true, data: t.map((x) => x.yoy), lineStyle: { color: '#fb7185', type: 'dashed', width: 2 }, itemStyle: { color: '#fb7185' } },
          ],
        });
      });

      return () => h('div', {}, [
        h('x-page', {
          title: '统计分析与决策支持',
          desc: '从行业、区域、企业规模、能源结构、减排成效与履约合规六个维度对碳市场运行状况进行量化分析。',
        }, {
          actions: () => [
            h('select', {
              class: 'select', style: 'width:120px', value: year.value,
              onChange: (e) => { year.value = e.target.value; load(); },
            }, [YEAR, YEAR - 1].map((y) => h('option', { value: y }, y + ' 年度'))),
            h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ],
          default: () => {
            if (!d.value) return h('div', { class: 'grid g2' }, Array.from({ length: 4 }).map(() => h('div', { class: 'skel', style: 'height:300px' })));
            const c = d.value.compliance;
            const total = (c.meet + c.gap) || 1;
            return [
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: '履约达标企业', value: c.meet, unit: '家', icon: 'check', tone: 'carbon', foot: `占已分配企业的 ${App.fmt.pct((c.meet / total) * 100, 1)}` }),
                h('x-kpi', { label: '存在履约缺口', value: c.gap, unit: '家', icon: 'alert', tone: 'rose', foot: `占比 ${App.fmt.pct((c.gap / total) * 100, 1)}` }),
                h('x-kpi', { label: '覆盖行业数', value: d.value.industries.length, unit: '个', icon: 'factory', tone: 'sky', foot: d.value.industries.map((x) => x.name).slice(0, 4).join(' / ') }),
                h('x-kpi', { label: '覆盖省级行政区', value: d.value.regions.length, unit: '个', icon: 'globe', tone: 'violet' }),
              ]),

              h('div', { class: 'grid g-3-2 mb-16' }, [
                h('x-card', { title: '行业排放总量与强度', sub: `${year.value} 年度` }, { default: () => h('x-chart', { option: industryOption.value, height: 'h320' }) }),
                h('x-card', { title: '能源品种排放结构', sub: '所有上报明细行的汇总' }, { default: () => h('x-chart', { option: energyOption.value, height: 'h320' }) }),
              ]),

              h('div', { class: 'grid g2 mb-16' }, [
                h('x-card', { title: '区域排放分布', sub: `${year.value} 年度 · 按省级行政区` }, { default: () => h('x-chart', { option: regionOption.value, height: 'h320' }) }),
                h('x-card', { title: '减排成效趋势', sub: '排放总量与平均同比变化率' }, { default: () => h('x-chart', { option: reductionOption.value, height: 'h320' }) }),
              ]),

              h('div', { class: 'grid g2' }, [
                h('x-card', { title: '企业排放排行榜 TOP20', flush: true }, {
                  default: () => h('x-table', {
                    columns: [
                      { key: 'name', title: '企业名称' },
                      { key: 'industry', title: '行业', width: '80px' },
                      { key: 'region', title: '地区', width: '110px' },
                      { key: 'emission', title: '排放量(tCO₂e)', align: 'right' },
                      { key: 'intensity', title: '强度', align: 'right', width: '95px' },
                      { key: 'quota_available', title: '配额余额', align: 'right' },
                    ],
                    rows: d.value.rank,
                  }, {
                    'col-name': ({ value }) => h('span', { class: 'ellipsis', style: 'max-width:210px;display:inline-block' }, value),
                    'col-industry': ({ value }) => h('span', { class: 'tag t-mute plain' }, value),
                    'col-emission': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 0)),
                    'col-intensity': ({ value }) => h('span', { class: 'mono muted' }, Number(value).toFixed(4)),
                    'col-quota_available': ({ value }) => h('span', { class: 'mono', style: `color:${Number(value) >= 0 ? 'var(--carbon-l)' : '#fda4af'}` }, App.fmt.num(value, 0)),
                  }),
                }),
                h('x-card', { title: '企业规模结构' }, {
                  default: () => h('div', {}, [
                    h('x-bars', {
                      items: d.value.scaleStat.map((x) => ({ name: x.name + '企业（' + x.ents + ' 家）', value: x.emission })),
                      format: (v) => App.fmt.big(v) + ' t',
                    }),
                    h('div', { class: 'alertbar info mt-16' }, [
                      h('x-icon', { name: 'info', size: 15 }),
                      '大型企业数量占比不高，但排放量占绝对主导 —— 这也是配额分配采用"行业基准线法"对大型高排放单位约束更强的政策依据。',
                    ]),
                  ]),
                }),
              ]),
            ];
          },
        }),
      ]);
    },
  });

  /* ==================================================================
   * 七、操作审计
   * ================================================================== */
  const PageRegLogs = defineComponent({
    name: 'page-reg-logs',
    setup() {
      const pager = App.usePager((p) => App.API.get('/regulator/logs', p), { page: 1, size: 15 });
      const filters = reactive({ module: '', role: '', keyword: '' });
      const MODULES = ['碳排上报', '核查作业', '配额管理', '交易撮合', '链上存证', '用户管理', '预警处置'];
      function load() { pager.load({ ...filters }); }
      onMounted(load);
      return () => h('div', {}, [
        h('x-page', { title: '操作审计日志', desc: '记录平台所有用户的关键操作行为，满足网络安全等级保护对"安全审计"的要求。' }, {
          default: () => h('x-card', { flush: true }, {
            head: () => h('div', { class: 'flex gap-8 wrap', style: 'flex:1;align-items:center' }, [
              h('select', { class: 'select', style: 'width:140px', value: filters.module, onChange: (e) => { filters.module = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部模块'), ...MODULES.map((m) => h('option', { value: m }, m)),
              ]),
              h('select', { class: 'select', style: 'width:150px', value: filters.role, onChange: (e) => { filters.role = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部角色'), ...Object.keys(App.DICT.role).map((r) => h('option', { value: r }, App.DICT.role[r])),
              ]),
              h('div', { class: 'input-group', style: 'width:250px' }, [
                h('input', { class: 'input', placeholder: '账号 / 动作 / 对象', value: filters.keyword, onInput: (e) => { filters.keyword = e.target.value; }, onKeyup: (e) => { if (e.key === 'Enter') load(); } }),
                h('button', { class: 'btn', onClick: load }, [h('x-icon', { name: 'search', size: 14 })]),
              ]),
            ]),
            default: () => [
              h('x-table', {
                columns: [
                  { key: 'created_at', title: '时间', width: '160px' },
                  { key: 'username', title: '账号', width: '110px' },
                  { key: 'role', title: '角色', width: '110px' },
                  { key: 'module', title: '模块', width: '110px' },
                  { key: 'action', title: '操作', width: '120px' },
                  { key: 'target', title: '操作对象' },
                  { key: 'detail', title: '详情' },
                  { key: 'ip', title: '来源IP', width: '130px' },
                  { key: 'result', title: '结果', width: '80px' },
                ],
                rows: pager.state.rows, loading: pager.state.loading,
              }, {
                'col-created_at': ({ value }) => h('span', { class: 'tiny mono' }, App.fmt.dt(value)),
                'col-username': ({ value }) => h('span', { class: 'mono' }, value),
                'col-role': ({ row }) => h('span', { class: 'tag t-mute plain' }, App.DICT.role[row.role] || row.role),
                'col-target': ({ value }) => h('span', { class: 'tiny ellipsis', style: 'max-width:190px;display:inline-block' }, value || '-'),
                'col-detail': ({ value }) => h('span', { class: 'tiny muted ellipsis', style: 'max-width:230px;display:inline-block' }, value || '-'),
                'col-ip': ({ value }) => h('span', { class: 'mono tiny' }, value),
                'col-result': ({ row }) => h('span', { class: ['tag', row.result === 'SUCCESS' ? 't-ok' : 't-danger'] }, row.result === 'SUCCESS' ? '成功' : '失败'),
              }),
              h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
            ],
          }),
        }),
      ]);
    },
  });

  /* ==================================================================
   * 八、系统概况
   * ================================================================== */
  const PageRegSystem = defineComponent({
    name: 'page-reg-system',
    setup() {
      const d = ref(null);
      const err = ref('');
      const tampering = ref(false);
      const tamper = reactive({ blockIndex: 30, field: 'merkle_root' });
      const panel = ref(null);

      async function load() { try { d.value = await App.API.get('/regulator/system'); err.value = ''; } catch (e) { err.value = e.message; } }
      onMounted(load);

      async function doTamper() {
        tampering.value = true;
        try {
          const r = await App.API.request('POST', '/chain/tamper', { blockIndex: Number(tamper.blockIndex), field: tamper.field }, { noAuth: true });
          panel.value = { kind: 'tamper', data: r };
          App.notify.warn(`区块 #${r.blockIndex} 已被改写，全链校验发现 ${r.validation.errors.length} 处异常`);
          load();
        } catch (e) { App.notify.err(e.message); } finally { tampering.value = false; }
      }
      async function doRepair() {
        tampering.value = true;
        try {
          const from = panel.value ? panel.value.data.blockIndex : 30;
          const r = await App.API.request('POST', '/chain/repair', { fromIndex: from }, { noAuth: true });
          panel.value = { kind: 'repair', data: r };
          App.notify.ok(`已重算 ${r.repaired.length} 个区块并重做 PoW；注意：所有后续区块哈希均已改变，其它节点可以立即发现`);
          load();
        } catch (e) { App.notify.err(e.message); } finally { tampering.value = false; }
      }

      return () => {
        if (err.value) return h('div', {}, [h('x-page', { title: '系统概况' }), h('div', { class: 'alertbar err' }, [h('x-icon', { name: 'alert', size: 15 }), err.value])]);
        if (!d.value) return h('div', { class: 'skel', style: 'height:300px' });
        const rt = d.value.runtime, ch = d.value.chain, v = d.value.validation;
        return h('div', {}, [
          h('x-page', { title: '系统运行状况与数据规模', desc: '平台数据规模、运行环境与区块链节点状态自检。' }, {
            actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '重新自检']),
            default: () => [
              h('div', { class: 'flex gap-12 mb-16 wrap' }, [
                h('x-readout', { pass: v.valid, label: '全链完整性校验', detail: `已校验 ${v.checked} 个区块` }),
                h('x-readout', { pass: true, label: '数据库连通性', detail: rt.db }),
                h('div', { class: 'readout pass' }, [h('span', { class: 'flag' }, 'NODE'), h('span', { class: 'k' }, rt.node + ' · ' + rt.platform)]),
              ]),

              h('div', { class: 'grid g6 mb-16' }, [
                h('x-kpi', { label: '数据表总数', value: d.value.tableCounts.length, unit: '张', icon: 'db', tone: 'carbon' }),
                h('x-kpi', { label: '数据总行数', value: App.fmt.num(d.value.totalRows), unit: '行', icon: 'layers', tone: 'sky' }),
                h('x-kpi', { label: '区块高度', value: App.fmt.num(ch.height), icon: 'block', tone: 'chain' }),
                h('x-kpi', { label: '链上交易', value: App.fmt.num(ch.confirmed), unit: '笔', icon: 'chain', tone: 'violet' }),
                h('x-kpi', { label: 'PoW 难度', value: ch.difficulty, unit: '前导零', icon: 'target', tone: 'carbon' }),
                h('x-kpi', { label: '服务内存占用', value: rt.memory, unit: 'MB', icon: 'chart', tone: 'sky', foot: `Node ${rt.node} · 运行 ${rt.uptime}s` }),
              ]),

              h('div', { class: 'grid g-2-1 mb-16' }, [
                h('x-card', { title: '各数据表行数', sub: '每张表的仿真数据规模（均 ≥ 50 行）', flush: true }, {
                  default: () => h('div', { class: 'card-body' }, h('div', { class: 'grid g2' }, d.value.tableCounts.map((t) => h('div', { class: 'bar-row' }, [
                    h('div', { class: 'nm mono' }, t.table),
                    h('div', { class: 'bar-track' }, [h('div', {
                      class: 'bar-fill', style: `width:${Math.max(2, (t.rows / Math.max(...d.value.tableCounts.map((x) => x.rows), 1)) * 100)}%`,
                    })]),
                    h('div', { class: 'vv' }, App.fmt.num(t.rows)),
                  ])))),
                }),
                h('x-card', { title: '账号角色分布', flush: true }, {
                  default: () => h('x-table', {
                    columns: [{ key: 'role', title: '角色' }, { key: 'cnt', title: '账号数', align: 'right' }],
                    rows: d.value.byRole,
                  }, {
                    'col-role': ({ row }) => h('span', {}, App.DICT.role[row.role] || row.role),
                    'col-cnt': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value)),
                  }),
                }),
              ]),

              h('x-card', { title: '链完整性自检与篡改实验', sub: '监管端也可直接对链上数据做一致性自检' }, {
                default: () => h('div', {}, [
                  h('div', { class: 'flex gap-12 wrap mb-16', style: 'align-items:flex-end' }, [
                    h('div', { class: 'field', style: 'margin:0;width:180px' }, [h('label', {}, '目标区块'), h('input', { class: 'input', type: 'number', value: tamper.blockIndex, onInput: (e) => { tamper.blockIndex = e.target.value; } })]),
                    h('div', { class: 'field', style: 'margin:0;width:220px' }, [h('label', {}, '篡改字段'), h('select', { class: 'select', value: tamper.field, onChange: (e) => { tamper.field = e.target.value; } }, [
                      h('option', { value: 'merkle_root' }, 'merkle_root'),
                      h('option', { value: 'prev_hash' }, 'prev_hash'),
                      h('option', { value: 'nonce' }, 'nonce'),
                      h('option', { value: 'block_time' }, 'block_time'),
                    ])]),
                    h('button', { class: 'btn danger', disabled: tampering.value, onClick: doTamper }, '模拟篡改并校验'),
                    panel.value && h('button', { class: 'btn chain', disabled: tampering.value, onClick: doRepair }, '修复链'),
                  ]),
                  panel.value && h('div', { class: ['alertbar', panel.value.data.validation.valid ? 'ok' : 'err', 'mb-12'] }, [
                    h('x-icon', { name: 'alert', size: 15 }),
                    panel.value.data.validation.valid
                      ? `校验通过，共校验 ${panel.value.data.validation.checkedBlocks} 个区块`
                      : `校验失败：${panel.value.data.validation.errors.length} 处异常 —— ${panel.value.data.validation.errors[0].message}`,
                  ]),
                  h('div', { class: 'mt-8' }, d.value.validation.errors.length
                    ? d.value.validation.errors.map((e) => h('div', { class: 'readout fail mb-8' }, [
                      h('span', { class: 'flag' }, e.type), h('span', {}, e.message),
                    ]))
                    : h('div', { class: 'alertbar ok' }, [h('x-icon', { name: 'check', size: 15 }), `全链 ${v.checked} 个区块校验一致：哈希链、PoW 难度与 Merkle 根全部匹配。`])),
                ]),
              }),
            ],
          }),
        ]);
      };
    },
  });

  /* ==================================================================
   * 九、公告管理
   * ================================================================== */
  const PageRegNotices = defineComponent({
    name: 'page-reg-notices',
    setup() {
      const pager = App.usePager((p) => App.API.get('/regulator/notices', p), { page: 1, size: 12 });
      const showForm = ref(false);
      const busy = ref(false);
      const form = reactive({ title: '', content: '', noticeType: 'POLICY', targetRole: 'ALL', isTop: false });
      onMounted(() => pager.load());

      async function publish() {
        busy.value = true;
        try {
          await App.API.post('/regulator/notices', { ...form, isTop: form.isTop ? 1 : 0 });
          App.notify.ok('公告已发布');
          showForm.value = false;
          form.title = ''; form.content = '';
          pager.reset();
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      return () => h('div', {}, [
        h('x-page', { title: '通知公告管理', desc: '发布政策法规、市场公告与系统通知，可按角色定向推送。' }, {
          actions: () => h('button', { class: 'btn sm primary', onClick: () => { showForm.value = true; } }, [h('x-icon', { name: 'plus', size: 14 }), '发布公告']),
          default: () => h('x-card', { flush: true }, {
            default: () => [
              h('x-table', {
                columns: [
                  { key: 'title', title: '标题' },
                  { key: 'notice_type', title: '类型', width: '110px' },
                  { key: 'target_role', title: '推送对象', width: '120px' },
                  { key: 'publisher', title: '发布人', width: '120px' },
                  { key: 'is_top', title: '置顶', width: '75px' },
                  { key: 'views', title: '浏览', align: 'right', width: '85px' },
                  { key: 'publish_time', title: '发布时间', width: '160px' },
                ],
                rows: pager.state.rows, loading: pager.state.loading,
                rowClick: (r) => App.go('/notice/' + r.id),
              }, {
                'col-notice_type': ({ row }) => h('x-tag', { dict: App.DICT.noticeType, dictKey: row.notice_type }),
                'col-target_role': ({ row }) => h('span', { class: 'tag t-mute plain' }, row.target_role === 'ALL' ? '全部角色' : (App.DICT.role[row.target_role] || row.target_role)),
                'col-is_top': ({ value }) => h('span', { class: ['tag', Number(value) ? 't-danger' : 't-mute'] }, Number(value) ? '置顶' : '普通'),
                'col-publish_time': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
              }),
              h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
            ],
          }),
        }),

        h('x-modal', { modelValue: showForm.value, title: '发布通知公告', width: '680px', 'onUpdate:modelValue': (v) => { showForm.value = v; } }, {
          default: () => h('div', {}, [
            h('div', { class: 'field' }, [h('label', {}, '标题'), h('input', { class: 'input', value: form.title, onInput: (e) => { form.title = e.target.value; }, placeholder: '请输入公告标题' })]),
            h('div', { class: 'grid g3' }, [
              h('div', { class: 'field' }, [h('label', {}, '公告类型'), h('select', { class: 'select', value: form.noticeType, onChange: (e) => { form.noticeType = e.target.value; } },
                Object.keys(App.DICT.noticeType).map((k) => h('option', { value: k }, App.DICT.noticeType[k][0])))]),
              h('div', { class: 'field' }, [h('label', {}, '推送对象'), h('select', { class: 'select', value: form.targetRole, onChange: (e) => { form.targetRole = e.target.value; } }, [
                h('option', { value: 'ALL' }, '全部角色'),
                ...Object.keys(App.DICT.role).map((r) => h('option', { value: r }, App.DICT.role[r])),
              ])]),
              h('div', { class: 'field' }, [h('label', {}, '是否置顶'), h('select', { class: 'select', value: String(form.isTop), onChange: (e) => { form.isTop = e.target.value === 'true'; } }, [h('option', { value: 'false' }, '不置顶'), h('option', { value: 'true' }, '置顶')])]),
            ]),
            h('div', { class: 'field' }, [h('label', {}, '正文'), h('textarea', { class: 'textarea', style: 'min-height:160px', value: form.content, onInput: (e) => { form.content = e.target.value; }, placeholder: '请输入公告正文…' })]),
          ]),
          footer: () => [
            h('button', { class: 'btn', onClick: () => { showForm.value = false; } }, '取消'),
            h('button', { class: 'btn primary', disabled: busy.value || !form.title, onClick: publish }, '确认发布'),
          ],
        }),
      ]);
    },
  });

  Object.assign(App.views, {
    'page-reg-overview': PageRegOverview,
    'page-reg-enterprises': PageRegEnterprises,
    'page-reg-allocations': PageRegAllocations,
    'page-reg-trades': PageRegTrades,
    'page-reg-alerts': PageRegAlerts,
    'page-reg-stats': PageRegStats,
    'page-reg-logs': PageRegLogs,
    'page-reg-system': PageRegSystem,
    'page-reg-notices': PageRegNotices,
  });
})();
