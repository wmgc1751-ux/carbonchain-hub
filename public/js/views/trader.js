/* =====================================================================
   交易端 · 碳资产二级市场
   T1 市场行情 / T2 交易下单 / T3 我的账户 / T4 交易记录 / T5 抵销清缴
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted } = Vue;
  const h = App.h;

  /* ---------------- T1 市场行情 ---------------- */
  const PageTradeMarket = defineComponent({
    name: 'page-trade-market',
    setup() {
      const market = ref(null);
      const book = ref(null);

      async function load() {
        try {
          market.value = await App.API.request('GET', '/trade/market', null, { noAuth: true });
          book.value = await App.API.request('GET', '/trade/orderbook', null, { noAuth: true });
        } catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);

      const klineOption = computed(() => {
        if (!market.value) return null;
        const k = market.value.kline || [];
        return App.chartBase({
          grid: { left: 10, right: 50, top: 24, bottom: 6, containLabel: true },
          legend: { data: ['碳价', '成交量'], top: 0, right: 6 },
          xAxis: App.catAxis(k.map((x) => x.date), { boundaryGap: true }),
          yAxis: [
            App.valAxis({ name: '元/吨', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 }, scale: true }),
            App.valAxis({ splitLine: { show: false }, name: '量', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 } }),
          ],
          series: [
            {
              name: '碳价', type: 'line', smooth: true, symbolSize: 5, data: k.map((x) => Number(x.high)),
              lineStyle: { width: 2.4, color: '#f43f5e' }, itemStyle: { color: '#fb7185' },
              areaStyle: { color: App.areaGrad('rgba(244,63,94,.28)', 'rgba(244,63,94,.01)') },
            },
            { name: '成交量', type: 'bar', yAxisIndex: 1, data: k.map((x) => Number(x.volume)), itemStyle: { color: 'rgba(56,189,248,.5)' }, barWidth: '50%' },
          ],
        });
      });

      return () => {
        const m = market.value;
        const up = m ? m.change >= 0 : true;
        const b = book.value || { buys: [], sells: [] };
        return h('x-page', { title: '市场行情', desc: '碳配额二级市场 · 价格优先、时间优先连续竞价撮合 · 涨红跌绿' }, {
          actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          default: () => !m ? h('div', { class: 'skel', style: 'height:260px' }) : [
            h('div', { class: 'grid g4 mb-16' }, [
              h('x-kpi', {
                label: '最新成交价', value: App.fmt.usd(m.lastPrice, 2), unit: '元/吨', icon: 'coin',
                tone: up ? 'rose' : 'carbon',
                delta: m.change, deltaTone: up ? 'bad' : 'good',
              }),
              h('x-kpi', { label: '累计成交量', value: App.fmt.num(m.kpi.volume, 0), unit: 'tCO₂e', icon: 'trade', tone: 'sky', foot: `${m.kpi.deals} 笔成交` }),
              h('x-kpi', { label: '累计成交额', value: App.fmt.big(m.kpi.turnover), unit: '元', icon: 'bank', tone: 'violet' }),
              h('x-kpi', { label: 'CCER 资产参考', value: m.ccer.assetCount, unit: '项', icon: 'leaf', tone: 'carbon', foot: `平均 ${App.fmt.num(m.ccer.avgAmount, 0)} tCO₂e/项` }),
            ]),

            h('div', { class: 'grid g-2-1 mb-16' }, [
              h('x-card', { title: '碳价走势（日线）', sub: '近 90 个交易日' }, {
                default: () => h('x-chart', { option: klineOption.value, height: 'h340' }),
              }),
              h('x-card', { title: '买卖盘口', sub: '前 10 档（卖绿 / 买红）' }, {
                default: () => h('div', { class: 'col gap-4' }, [
                  h('div', { class: 'tiny dim mb-4' }, '卖盘'),
                  ...b.sells.slice().reverse().map((s) => h('div', { class: 'bar-row' }, [
                    h('span', { class: 'nm', style: 'color:#34d399' }, App.fmt.num(s.price, 2)),
                    h('div', { class: 'bar-track' }, [h('div', { class: 'bar-fill', style: `width:${Math.min(100, s.amount / 120)}%;background:linear-gradient(90deg,#065f46,#34d399);box-shadow:0 0 12px -2px rgba(52,211,153,.7)` })]),
                    h('span', { class: 'vv' }, App.fmt.num(s.amount, 0)),
                  ])),
                  h('div', { class: 'divider' }),
                  h('div', { class: 'tiny dim mb-4' }, '买盘'),
                  ...b.buys.map((x) => h('div', { class: 'bar-row' }, [
                    h('span', { class: 'nm', style: 'color:#fb7185' }, App.fmt.num(x.price, 2)),
                    h('div', { class: 'bar-track' }, [h('div', { class: 'bar-fill', style: `width:${Math.min(100, x.amount / 120)}%;background:linear-gradient(90deg,#9f1239,#fb7185);box-shadow:0 0 12px -2px rgba(251,113,133,.7)` })]),
                    h('span', { class: 'vv' }, App.fmt.num(x.amount, 0)),
                  ])),
                ]),
              }),
            ]),
          ],
        });
      };
    },
  });

  /* ---------------- T2 交易下单 ---------------- */
  const PageTradeOrders = defineComponent({
    name: 'page-trade-orders',
    setup() {
      const orders = ref([]);
      const market = ref(null);
      const busy = ref(false);
      const form = reactive({ side: 'BUY', price: '', amount: '' });

      async function load() {
        try {
          orders.value = await App.API.request('GET', '/trade/orders');
          market.value = await App.API.request('GET', '/trade/market', null, { noAuth: true });
        } catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);

      function useLast() { if (market.value) form.price = String(market.value.lastPrice); }

      async function submit() {
        if (!(Number(form.price) > 0) || !(Number(form.amount) > 0)) { App.notify.warn('请填写有效的价格与数量'); return; }
        busy.value = true;
        try {
          const r = await App.API.request('POST', '/trade/orders', { side: form.side, price: Number(form.price), amount: Number(form.amount) });
          App.notify.ok(r.matchedCount > 0 ? `委托已提交，即时撮合成交 ${r.matchedCount} 笔` : '委托已挂出，等待成交');
          form.amount = '';
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      async function cancel(o) {
        try { await App.API.request('POST', `/trade/orders/${o.id}/cancel`); App.notify.ok('委托已撤销'); await load(); }
        catch (e) { App.notify.err(e.message); }
      }

      return () => h('x-page', { title: '交易下单', desc: '限价委托 · 成交后配额即时划转并上链存证（每笔成交一笔 TRADE_DEAL 存证）' }, {
        default: () => h('div', { class: 'grid g-1-2 mb-16' }, [
          h('x-card', { title: '提交委托' }, {
            default: () => h('div', { class: 'col gap-12' }, [
              h('div', { class: 'flex gap-8' }, [
                h('button', { class: ['btn', form.side === 'BUY' ? 'danger' : 'ghost'], onClick: () => { form.side = 'BUY'; } }, '买入'),
                h('button', { class: ['btn', form.side === 'SELL' ? 'primary' : 'ghost'], onClick: () => { form.side = 'SELL'; } }, '卖出'),
              ]),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '委托单价（元/吨）'),
                h('div', { class: 'flex gap-8' }, [
                  h('input', { class: 'input', type: 'number', value: form.price, onInput: (e) => { form.price = e.target.value; }, placeholder: '如 65.00' }),
                  h('button', { class: 'btn sm', onClick: useLast }, '取最新价'),
                ]),
              ]),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '委托数量（tCO₂e）'),
                h('input', { class: 'input', type: 'number', value: form.amount, onInput: (e) => { form.amount = e.target.value; }, placeholder: '如 1000' }),
              ]),
              h('div', { class: 'alertbar info' }, [
                h('x-icon', { name: 'info', size: 15 }),
                form.side === 'SELL' ? '卖出将冻结相应可用配额，成交后自动划转给买方。' : '买入成交后配额划入账户，请在履约期前完成清缴。',
              ]),
              h('button', { class: 'btn primary', disabled: busy, onClick: submit }, busy ? '提交中…' : '提交委托'),
            ]),
          }),
          h('x-card', { title: '我的委托单', flush: true }, {
            default: () => h('x-table', {
              columns: [
                { key: 'orderNo', title: '委托单号', width: '150px' },
                { key: 'side', title: '方向', width: '80px' },
                { key: 'price', title: '价格', align: 'right' },
                { key: 'amount', title: '数量', align: 'right' },
                { key: 'filledAmount', title: '已成交', align: 'right' },
                { key: 'status', title: '状态', width: '110px' },
                { key: 'createdAt', title: '挂单时间', width: '150px' },
                { key: '_act', title: '操作', width: '80px' },
              ],
              rows: orders.value,
            }, {
              'col-orderNo': ({ value }) => h('span', { class: 'mono' }, value),
              'col-side': ({ row }) => h('x-tag', { dict: App.DICT.orderSide, dictKey: row.side }),
              'col-price': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
              'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
              'col-filledAmount': ({ value }) => h('span', { class: 'mono muted' }, App.fmt.num(value, 0)),
              'col-status': ({ row }) => h('x-tag', { dict: App.DICT.orderStatus, dictKey: row.status }),
              'col-createdAt': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
              'col-_act': ({ row }) => ['OPEN', 'PARTIAL'].includes(row.status)
                ? h('button', { class: 'btn sm', onClick: () => cancel(row) }, '撤单') : h('span', { class: 'dim' }, '-'),
            }),
          }),
        ]),
      });
    },
  });

  /* ---------------- T3 我的账户 ---------------- */
  const PageTradeAccount = defineComponent({
    name: 'page-trade-account',
    setup() {
      const acc = ref(null);
      async function load() { try { acc.value = await App.API.request('GET', '/trade/account'); } catch (e) { App.notify.err(e.message); } }
      onMounted(load);
      return () => {
        const a = acc.value;
        return h('x-page', { title: '我的交易账户', desc: '配额 / 碳信用持仓 · 冻结与可用 · 每笔划转含链上 txid' }, {
          actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          default: () => !a ? h('div', { class: 'skel', style: 'height:220px' }) : [
            h('div', { class: 'grid g4 mb-16' }, [
              h('x-kpi', { label: `${a.year} 年度配额可用`, value: App.fmt.num(a.quota.available, 0), unit: 'tCO₂e', icon: 'wallet', tone: 'carbon' }),
              h('x-kpi', { label: '挂单冻结', value: App.fmt.num(a.quota.frozen, 0), unit: 'tCO₂e', icon: 'lock', tone: 'violet' }),
              h('x-kpi', { label: '累计买入', value: App.fmt.num(a.quota.bought, 0), unit: 'tCO₂e', icon: 'arrowDown', tone: 'rose' }),
              h('x-kpi', { label: '累计卖出', value: App.fmt.num(a.quota.sold, 0), unit: 'tCO₂e', icon: 'arrowUp', tone: 'sky' }),
            ]),
            h('div', { class: 'grid g2 mb-16' }, [
              h('x-card', { title: '碳信用持仓', flush: true }, {
                default: () => h('x-table', {
                  columns: [
                    { key: 'assetNo', title: '资产编号', width: '140px' },
                    { key: 'assetType', title: '类型', width: '110px' },
                    { key: 'amount', title: '持有量', align: 'right' },
                    { key: 'usedAmount', title: '已用', align: 'right' },
                    { key: 'remaining', title: '可用', align: 'right' },
                  ],
                  rows: a.credits, empty: '暂无碳信用资产',
                }, {
                  'col-assetNo': ({ value }) => h('span', { class: 'mono' }, value),
                  'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
                  'col-usedAmount': ({ value }) => h('span', { class: 'mono muted' }, App.fmt.num(value, 2)),
                  'col-remaining': ({ value }) => h('b', { class: 'mono', style: 'color:var(--carbon-l)' }, App.fmt.num(value, 2)),
                }),
              }),
              h('x-card', { title: '最近成交', flush: true }, {
                default: () => h('x-table', {
                  columns: [
                    { key: 'dealNo', title: '成交号', width: '150px' },
                    { key: 'price', title: '价格', align: 'right' },
                    { key: 'amount', title: '数量', align: 'right' },
                    { key: 'dealTime', title: '时间', width: '150px' },
                  ],
                  rows: a.deals, empty: '暂无成交',
                }, {
                  'col-dealNo': ({ value }) => h('span', { class: 'mono' }, value),
                  'col-price': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
                  'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
                  'col-dealTime': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                }),
              }),
            ]),
          ],
        });
      };
    },
  });

  /* ---------------- T4 交易记录 ---------------- */
  const PageTradeDeals = defineComponent({
    name: 'page-trade-deals',
    setup() {
      const deals = ref([]);
      async function load() { try { deals.value = await App.API.request('GET', '/trade/deals'); } catch (e) { App.notify.err(e.message); } }
      onMounted(load);
      return () => h('x-page', { title: '交易记录', desc: '全程可溯 · 每笔成交均上链存证，可点链上凭证跳转区块链浏览器' }, {
        actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
        default: () => h('x-card', { flush: true }, {
          default: () => h('x-table', {
            columns: [
              { key: 'dealNo', title: '成交编号', width: '150px' },
              { key: 'price', title: '成交价', align: 'right' },
              { key: 'amount', title: '数量', align: 'right' },
              { key: 'totalAmount', title: '金额', align: 'right' },
              { key: 'buyerName', title: '买方' },
              { key: 'sellerName', title: '卖方' },
              { key: 'chain_block_index', title: '链上存证', width: '110px' },
              { key: 'dealTime', title: '成交时间', width: '150px' },
            ],
            rows: deals.value,
          }, {
            'col-dealNo': ({ value }) => h('span', { class: 'mono' }, value),
            'col-price': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
            'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
            'col-totalAmount': ({ value }) => h('span', { class: 'mono' }, App.fmt.usd(value, 2)),
            'col-chain_block_index': ({ row }) => h('x-chainbadge', { block: row.chainBlockIndex, hash: row.chainTxId }),
            'col-dealTime': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
          }),
        }),
      });
    },
  });

  /* ---------------- T5 抵销清缴 ---------------- */
  const PageTradeOffset = defineComponent({
    name: 'page-trade-offset',
    setup() {
      const assets = ref([]);
      const status = ref(null);
      const modal = ref(false);
      const form = reactive({ assetId: null, amount: '' });
      const pick = ref(null);
      const busy = ref(false);

      async function load() {
        try {
          assets.value = await App.API.request('GET', '/credit/assets');
          status.value = await App.API.request('GET', '/credit/status');
        } catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);

      function open(a) {
        const allowed = status.value ? Math.min(a.remaining, status.value.offsetLimitRemaining) : a.remaining;
        pick.value = a;
        form.assetId = a.id;
        form.amount = String(Math.max(0, Math.floor(allowed)));
        modal.value = true;
      }
      async function submit() {
        busy.value = true;
        try {
          const r = await App.API.request('POST', '/trade/offset', { assetId: form.assetId, amount: Number(form.amount) });
          App.notify.ok(`已抵销 ${r.amount} tCO₂e，缺口降至 ${r.quotaAfter} tCO₂e（已上链）`);
          modal.value = false;
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      return () => h('x-page', { title: '抵销清缴', desc: '选择 CCER 等碳信用抵销履约缺口 · 自动校验 5% 上限 · 注销记录上链存证' }, {
        default: () => [
          status.value && h('div', { class: 'grid g4 mb-16' }, [
            h('x-kpi', { label: '本年度配额', value: App.fmt.num(status.value.quota, 0), unit: 'tCO₂e', icon: 'coin', tone: 'carbon' }),
            h('x-kpi', { label: '抵销上限（5%）', value: App.fmt.num(status.value.limit, 0), unit: 'tCO₂e', icon: 'target', tone: 'sky' }),
            h('x-kpi', { label: '已抵销', value: App.fmt.num(status.value.used, 0), unit: 'tCO₂e', icon: 'fire', tone: 'violet' }),
            h('x-kpi', { label: '剩余可抵销', value: App.fmt.num(status.value.offsetLimitRemaining, 0), unit: 'tCO₂e', icon: 'leaf', tone: 'carbon' }),
          ]),
          h('x-card', { title: '可用碳信用资产', flush: true }, {
            default: () => h('x-table', {
              columns: [
                { key: 'assetNo', title: '资产编号', width: '140px' },
                { key: 'assetTypeCn', title: '类型', width: '160px' },
                { key: 'amount', title: '持有量', align: 'right' },
                { key: 'usedAmount', title: '已用', align: 'right' },
                { key: 'remaining', title: '可用', align: 'right' },
                { key: 'validUntil', title: '有效期', width: '120px' },
                { key: '_act', title: '操作', width: '80px' },
              ],
              rows: assets.value, empty: '暂无碳信用资产',
            }, {
              'col-assetNo': ({ value }) => h('span', { class: 'mono' }, value),
              'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
              'col-usedAmount': ({ value }) => h('span', { class: 'mono muted' }, App.fmt.num(value, 2)),
              'col-remaining': ({ value }) => h('b', { class: 'mono', style: 'color:var(--carbon-l)' }, App.fmt.num(value, 2)),
              'col-validUntil': ({ value }) => h('span', { class: 'tiny' }, App.fmt.d(value)),
              'col-_act': ({ row }) => row.remaining > 0
                ? h('button', { class: 'btn sm', onClick: () => open(row) }, '抵销') : h('span', { class: 'dim' }, '-'),
            }),
          }),
          modal.value && h('x-modal', { modelValue: modal.value, title: 'CCER 抵销清缴', 'onUpdate:modelValue': (v) => { modal.value = v; } }, {
            default: () => h('div', { class: 'col gap-12' }, [
              h('div', {}, [h('b', {}, '资产：'), pick.value ? pick.value.assetTypeCn + ' · ' + pick.value.assetNo : '']),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '抵销量（tCO₂e）'),
                h('input', { class: 'input', type: 'number', value: form.amount, onInput: (e) => { form.amount = e.target.value; } }),
              ]),
              status.value && h('div', { class: 'alertbar info' }, [h('x-icon', { name: 'info', size: 15 }), `抵销不超过配额 5%（上限 ${status.value.limit} tCO₂e，已用 ${status.value.used} tCO₂e）`]),
            ]),
            footer: () => [
              h('button', { class: 'btn', onClick: () => { modal.value = false; } }, '取消'),
              h('button', { class: 'btn primary', disabled: busy, onClick: submit }, busy ? '提交中…' : '确认抵销并上链'),
            ],
          }),
        ],
      });
    },
  });

  Object.assign(App.views, {
    'page-trade-market': PageTradeMarket,
    'page-trade-orders': PageTradeOrders,
    'page-trade-account': PageTradeAccount,
    'page-trade-deals': PageTradeDeals,
    'page-trade-offset': PageTradeOffset,
  });
})();
