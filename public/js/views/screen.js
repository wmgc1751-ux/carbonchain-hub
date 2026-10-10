/* =====================================================================
   公众数据公示大屏（免登录）
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  const PageScreen = defineComponent({
    name: 'page-screen',
    setup() {
      const d = ref(null);
      const err = ref('');
      const cd = ref(30);
      let timer = null, tick = null;

      async function load() {
        try { d.value = await App.API.request('GET', '/public/dashboard', null, { noAuth: true }); err.value = ''; }
        catch (e) { err.value = e.message; }
      }

      onMounted(() => {
        load();
        timer = setInterval(load, 30000);
        tick = setInterval(() => { cd.value = cd.value <= 1 ? 30 : cd.value - 1; }, 1000);
      });
      onUnmounted(() => { clearInterval(timer); clearInterval(tick); });

      /* ---------------- 图表配置 ---------------- */
      const trendOption = computed(() => {
        if (!d.value) return null;
        const t = d.value.trend;
        return App.chartBase({
          legend: { data: ['排放总量', '排放强度'], textStyle: { color: '#8d9cb5', fontSize: 11.5 }, top: 0, right: 8 },
          grid: { left: 10, right: 30, top: 34, bottom: 6, containLabel: true },
          tooltip: Object.assign(App.chartBase().tooltip, {
            formatter: (ps) => {
              const p = ps[0];
              return `<b>${p.axisValue}</b><br/>排放总量：<b style="color:#34d399">${App.fmt.num(t[p.dataIndex].total)}</b> tCO₂e<br/>排放强度：<b style="color:#38bdf8">${t[p.dataIndex].intensity}</b> t/万元`;
            },
          }),
          xAxis: App.catAxis(t.map((x) => x.period), { boundaryGap: false }),
          yAxis: [
            App.valAxis({ name: 'tCO₂e', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 } }),
            App.valAxis({ name: '强度', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 }, splitLine: { show: false } }),
          ],
          series: [
            {
              name: '排放总量', type: 'line', smooth: true, symbol: 'circle', symbolSize: 6,
              data: t.map((x) => x.total), lineStyle: { width: 2.6, color: '#10b981' },
              itemStyle: { color: '#10b981' },
              areaStyle: { color: App.areaGrad('rgba(16,185,129,.42)', 'rgba(16,185,129,.02)') },
            },
            {
              name: '排放强度', type: 'line', yAxisIndex: 1, smooth: true, symbol: 'circle', symbolSize: 5,
              data: t.map((x) => x.intensity), lineStyle: { width: 2, color: '#38bdf8', type: 'dashed' },
              itemStyle: { color: '#38bdf8' },
            },
          ],
        });
      });

      const industryOption = computed(() => {
        if (!d.value) return null;
        const list = d.value.byIndustry || [];
        return App.chartBase({
          tooltip: Object.assign(App.chartBase().tooltip, { trigger: 'item', formatter: '{b}<br/>{c} tCO₂e（{d}%）' }),
          legend: { orient: 'vertical', right: 4, top: 'center', textStyle: { color: '#8d9cb5', fontSize: 11.5 } },
          series: [{
            type: 'pie', radius: ['46%', '72%'], center: ['36%', '52%'], avoidLabelOverlap: true,
            itemStyle: { borderColor: 'rgba(6,10,18,.9)', borderWidth: 2, borderRadius: 4 },
            label: { show: false }, labelLine: { show: false },
            data: list.map((x) => ({ name: x.name, value: Math.round(x.value) })),
          }],
        });
      });

      const regionOption = computed(() => {
        if (!d.value) return null;
        const list = (d.value.byRegion || []).slice(0, 10).reverse();
        return App.chartBase({
          grid: { left: 10, right: 40, top: 14, bottom: 6, containLabel: true },
          tooltip: Object.assign(App.chartBase().tooltip, { formatter: (ps) => `${ps[0].name}<br/>排放量 <b>${App.fmt.num(ps[0].value)}</b> tCO₂e` }),
          xAxis: App.valAxis({ show: false }),
          yAxis: App.catAxis(list.map((x) => x.name), { axisLabel: { color: '#8d9cb5', fontSize: 11 } }),
          series: [{
            type: 'bar', data: list.map((x) => x.value), barWidth: 11,
            itemStyle: {
              borderRadius: [0, 6, 6, 0],
              color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                { offset: 0, color: 'rgba(16,185,129,.35)' }, { offset: 1, color: '#34d399' },
              ]),
            },
            label: { show: true, position: 'right', color: '#8d9cb5', fontSize: 10.5, formatter: (p) => App.fmt.big(p.value) },
          }],
        });
      });

      const priceOption = computed(() => {
        if (!d.value) return null;
        const t = d.value.priceTrend || [];
        return App.chartBase({
          grid: { left: 10, right: 16, top: 22, bottom: 6, containLabel: true },
          tooltip: Object.assign(App.chartBase().tooltip, {
            formatter: (ps) => `${ps[0].axisValue}<br/>均价 <b style="color:#fbbf24">${ps[0].value}</b> 元/吨<br/>成交 ${App.fmt.num(t[ps[0].dataIndex].volume)} 吨`,
          }),
          xAxis: App.catAxis(t.map((x) => x.month), { boundaryGap: false }),
          yAxis: App.valAxis({ scale: true, name: '元/吨', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 } }),
          series: [{
            type: 'line', smooth: true, data: t.map((x) => x.price), symbol: 'circle', symbolSize: 6,
            lineStyle: { width: 2.6, color: '#f5a524' }, itemStyle: { color: '#fbbf24' },
            areaStyle: { color: App.areaGrad('rgba(245,165,36,.4)', 'rgba(245,165,36,.02)') },
          }],
        });
      });

      /* ---------------- 渲染 ---------------- */
      return () => {
        if (err.value) {
          return h('div', { class: 'screen' }, [
            h('div', { class: 'alertbar err' }, [h('x-icon', { name: 'alert', size: 16 }),
              h('div', {}, ['数据加载失败：' + err.value, h('div', { class: 'tiny mt-8' }, '请确认后端服务已启动（npm start）且数据库已初始化（npm run initdb）。')])]),
            h('div', { class: 'mt-16 flex gap-8' }, [
              h('button', { class: 'btn', onClick: load }, [h('x-icon', { name: 'refresh', size: 15 }), '重新加载']),
              h('button', { class: 'btn primary', onClick: () => App.go('/login') }, '前往登录'),
            ]),
          ]);
        }
        if (!d.value) return h('div', { class: 'screen' }, [h('div', { class: 'skel', style: 'height:520px' })]);

        const k = d.value.kpi, c = d.value.chain;

        return h('div', { class: 'screen' }, [
          /* 头部 */
          h('div', { class: 'screen-head' }, [
            h('div', { class: 'brand-logo', style: 'width:56px;height:29px' }, [h('img', { src: './img/logo-mark.png', alt: '碳链通 CarbonChain Hub' })]),
            h('div', {}, [
              h('h1', {}, '碳链通 · 全国碳排放数据公示大屏'),
              h('div', { class: 'sub' }, '数据来源：企业自主申报 + 第三方核查机构核证 + 区块链存证 · 面向社会公众开放查询'),
            ]),
            h('div', { class: 'flex gap-8', style: 'margin-left:auto' }, [
              h('span', { class: 'chip live' }, [h('x-icon', { name: 'chain', size: 14 }), `链高度 ${c.height}`]),
              h('span', { class: 'chip' }, [h('x-icon', { name: 'clock', size: 14 }), `刷新倒计时 ${cd.value}s`]),
              h('button', { class: 'btn sm', onClick: () => App.go('/explorer') }, [h('x-icon', { name: 'block', size: 14 }), '浏览器']),
              h('button', { class: 'btn sm primary', onClick: () => App.go('/login') }, [h('x-icon', { name: 'lock', size: 14 }), '登录']),
            ]),
          ]),

          /* 行情条 */
          h('div', { class: 'ticker mb-16' }, [
            h('div', { class: 'tick' }, ['碳配额最新价 ', h('b', {}, k.lastPrice ? k.lastPrice.toFixed(2) : '-'), h('span', { class: 'tiny dim' }, '元/吨')]),
            h('div', { class: 'tick' }, ['加权均价 ', h('b', {}, k.avgPrice ? k.avgPrice.toFixed(2) : '-')]),
            h('div', { class: 'tick' }, ['累计成交 ', h('b', {}, App.fmt.big(k.tradeVolume)), h('span', { class: 'tiny dim' }, '吨')]),
            h('div', { class: 'tick' }, ['成交金额 ', h('b', {}, App.fmt.big(k.turnover)), h('span', { class: 'tiny dim' }, '元')]),
            h('div', { class: 'tick' }, ['控排企业 ', h('b', {}, k.entCount), h('span', { class: 'tiny dim' }, '家')]),
            h('div', { class: 'tick' }, ['覆盖省份 ', h('b', {}, k.regionCount)]),
            h('div', { class: 'tick', style: 'margin-left:auto' }, ['链上存证 ', h('b', {}, App.fmt.num(c.totalTxs)), h('span', { class: 'tiny dim' }, '笔 · ' + (c.difficulty ? 'PoW 难度 ' + c.difficulty : 'PoA 共识'))]),
          ]),

          /* KPI */
          h('div', { class: 'grid g4 mb-16' }, [
            h('x-kpi', { label: '本年度排放总量', value: App.fmt.num(k.emissionYtd), unit: 'tCO₂e', icon: 'fire', tone: 'carbon', foot: `已纳入 ${k.reportCount} 份上报单` }),
            h('x-kpi', { label: '核查通过率', value: k.verifiedRate, unit: '%', icon: 'shield', tone: 'sky', foot: '第三方机构核证结论' }),
            h('x-kpi', { label: '区块高度', value: App.fmt.num(c.height), icon: 'block', tone: 'chain', foot: `${c.totalBlocks} 个区块 · 平均出块 ${c.avgMineTime ? c.avgMineTime + 'ms' : '—'}` }),
            h('x-kpi', { label: '累计交易额', value: App.fmt.big(k.turnover), unit: '元', icon: 'trade', tone: 'violet', foot: `${App.fmt.num(k.dealCount)} 笔成交` }),
          ]),

          /* 主图区 */
          h('div', { class: 'grid g-3-2 mb-16' }, [
            h('x-card', { title: '碳排放总量与强度趋势', sub: '按报告期汇总 · 单位 tCO₂e 与 tCO₂e/万元' }, {
              default: () => h('x-chart', { option: trendOption.value, height: 'h300' }),
            }),
            h('x-card', { title: '行业排放结构', sub: '按国民经济行业分类' }, {
              default: () => h('x-chart', { option: industryOption.value, height: 'h300' }),
            }),
          ]),

          h('div', { class: 'grid g-1-2 mb-16' }, [
            h('x-card', { title: '区域排放 TOP10', sub: '按省级行政区' }, {
              default: () => h('x-chart', { option: regionOption.value, height: 'h340' }),
            }),
            h('x-card', { title: '碳配额成交价格走势', sub: '月度加权均价' }, {
              default: () => h('x-chart', { option: priceOption.value, height: 'h340' }),
            }),
          ]),

          /* 链上实时 */
          h('div', { class: 'grid g-2-1' }, [
            h('x-card', { title: '最新区块', sub: '实时出块记录 · 点击查看区块详情', flush: true }, {
              actions: () => h('button', { class: 'btn sm ghost', onClick: load }, [h('x-icon', { name: 'refresh', size: 13 }), '刷新']),
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'blockfeed' }, d.value.latestBlocks.map((b) => h('div', {
                  class: 'bf-item', style: 'cursor:pointer',
                  onClick: () => App.go('/explorer/block/' + b.block_index),
                }, [
                  h('div', { class: 'bf-idx' }, '#' + b.block_index),
                  h('div', { class: 'bf-main' }, [
                    h('div', { class: 'bf-hash' }, [h('x-hash', { value: b.block_hash, len: 18 })]),
                    h('div', { class: 'tiny dim mt-8' }, `父哈希 ${App.fmt.short(b.prev_hash, 10)}`),
                  ]),
                  h('div', { class: 'col right gap-4', style: 'align-items:flex-end' }, [
                    h('span', { class: 'tag t-chain', style: 'font-size:11.4px' }, `${b.tx_count} 笔`),
                    h('span', { class: 'tiny dim' }, App.fmt.ago(b.block_time)),
                  ]),
                ]))),
              ]),
            }),
            h('div', { class: 'col gap-16' }, [
              h('x-card', { title: '链上存证构成' }, {
                default: () => h('div', {}, [
                  h('x-bars', {
                    items: c.byBizType.map((x) => ({
                      name: ({ EMISSION_REPORT: '排放上报', VERIFY_REPORT: '核查报告', QUOTA_ALLOC: '配额分配', TRADE_DEAL: '交易成交', ENTERPRISE_REG: '企业备案' })[x.tx_type] || x.tx_type,
                      value: x.cnt,
                    })),
                    format: (v) => App.fmt.num(v) + ' 笔',
                  }),
                  h('div', { class: 'flex gap-12 wrap mt-16' }, [
                    h('span', { class: 'tag t-ok' }, 'SHA-256'),
                    h('span', { class: 'tag t-info' }, 'secp256k1 ECDSA'),
                    h('span', { class: 'tag t-chain' }, 'Merkle Tree'),
                    h('span', { class: 'tag t-violet' }, 'PoW 难度 ' + c.difficulty),
                  ]),
                ]),
              }),
              h('x-card', { title: '政策与市场公告' }, {
                default: () => h('div', { class: 'col gap-12' }, d.value.notices.map((n) => h('div', {
                  class: 'flex gap-8', style: 'cursor:pointer;align-items:flex-start',
                  onClick: () => App.go('/notice/' + n.id),
                }, [
                  h('x-tag', { dict: App.DICT.noticeType, dictKey: n.notice_type }),
                  h('div', { class: 'flex-1' }, [
                    h('div', { style: 'font-size:12.8px;color:var(--tx-1)' }, n.title),
                    h('div', { class: 'tiny dim' }, `${n.publisher} · ${App.fmt.d(n.publish_time)}`),
                  ]),
                ]))),
              }),
            ]),
          ]),
        ]);
      };
    },
  });

  App.views = App.views || {};
  App.views['page-screen'] = PageScreen;
})();
