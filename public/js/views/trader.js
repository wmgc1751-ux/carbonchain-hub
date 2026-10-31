/* =====================================================================
   交易端 · 碳资产二级市场
   T1 市场行情 / T2 交易下单 / T3 我的账户 / T4 交易记录 / T5 抵销清缴
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, watch } = Vue;
  const h = App.h;

  /* =====================================================================
     代理企业（TRADER 专用）
     ---------------------------------------------------------------------
     交易端账号 trader01 的 org_id = 1，而 enterprise 表里 id=1 是
     「邢台纸业有限公司」—— 既不是交易中心本身，也不是"交易中心持有的配额"。
     若所有交易端页面都按 orgId 取数，就会出现：
       · "我的交易账户" 实际展示邢台纸业的配额与持仓；
       · "我的委托单" 实际是邢台纸业的委托；
       · 抵销清缴页取 /credit/status 时因缺 entId 直接 400（整页不可用）。
     正确语义：交易中心是**代理服务方**，必须显式选定"当前代理企业"再操作。
     选定结果持久化到 localStorage，四个交易端页面共用同一份选择。
     ===================================================================== */
  const PROXY_KEY = 'cch_proxy_ent';
  const Proxy = {
    entId: ref(null),
    ents: ref([]),
    ready: ref(false),
    loading: ref(false),
    /* 授权清单是否成功取到。false 时页面要明确说"拿不到授权清单"，
     * 而不是显示"暂无数据"——后者会被误读成"这家企业没有委托"。 */
    mandatesReady: ref(false),
    loadError: ref(''),
  };

  /** 是否交易端（企业端页面走自身 orgId，不需要选择器） */
  function isTrader() {
    const u = App.Store && App.Store.user;
    return !!u && u.role === 'TRADER';
  }

  /** 当前生效的企业 id：交易端取所选代理企业，企业端取自身 */
  function activeEntId() {
    if (!isTrader()) return null;
    return Proxy.entId.value || null;
  }

  /** 给 URL 补 entId（企业端不需要） */
  function withEnt(url) {
    const id = activeEntId();
    if (!id) return url;
    return url + (url.indexOf('?') > -1 ? '&' : '?') + 'entId=' + id;
  }

  /** 拉取代理企业候选 —— 只列「本机构已被授权」的企业。
   *
   * 【为什么不能用 /public/enterprises】
   * 交易端每一页的数据都按 entId 取，而后端 resolveActor() 会校验
   * trade_mandate：无授权的企业一律 403。原先下拉列的是全站 64 家公开名录，
   * 默认又挑「第一个有挂单的企业」，于是默认选中的通常是**没有授权**的那家
   * （实测 trader01 仅授权保定 4 家垃圾焚烧企业，默认却选中唐山热电），
   * 每页一打开就是 403，表格渲染成"暂无数据"——
   * 用户看到的"没数据"和真实的"没权限"是两回事，而界面从不区分。
   *
   * /mandate/granted-to-me 返回的正是「已授权且生效」的清单，用它既消除了
   * 默认选错，也让下拉里不再出现点进去必然失败的企业。 */
  async function loadProxyEnts() {
    if (Proxy.loading.value) return;
    Proxy.loading.value = true;
    try {
      const r = await App.API.request('GET', '/mandate/granted-to-me');
      const rows = (r && r.rows) || [];
      Proxy.ents.value = rows.map((x) => ({
        id: Number(x.ent_id),
        name: x.ent_name || ('企业 #' + x.ent_id),
        entCode: x.ent_code || '',
        scope: x.scope, scopeCn: x.scopeCn || x.scope,
        maxAmount: x.max_amount === null || x.max_amount === undefined ? null : Number(x.max_amount),
        validTo: x.valid_to,
        orderCount: 0,
      }));
      Proxy.mandatesReady.value = true;
    } catch (e) {
      /* 失败时清空候选，而不是退回公开名录 —— 名录里全是无法操作的企业，
       * 列出来只会让用户逐个点进去撞 403。 */
      Proxy.ents.value = [];
      Proxy.mandatesReady.value = false;
      Proxy.loadError.value = e.message || String(e);
      App.notify.err('代理授权清单加载失败：' + Proxy.loadError.value);
    } finally {
      Proxy.loading.value = false;
      Proxy.ready.value = true;
    }
    const saved = Number(localStorage.getItem(PROXY_KEY));
    const hit = Proxy.ents.value.find((x) => x.id === saved);
    /* 默认取授权清单第一家。清单按授权 id 倒序（最近签发的在前），
     * 且每家都已确认可操作，因此这里不再需要"挑有挂单的"那种启发式：
     * 那只会在无授权的名录上选出一个必然 403 的对象。 */
    const pick = hit || Proxy.ents.value[0] || null;
    Proxy.entId.value = pick ? pick.id : null;
  }

  /** 页面进入前确保已选定代理企业 */
  async function ensureProxy() {
    if (!isTrader()) return null;
    if (!Proxy.ready.value) await loadProxyEnts();
    /* 已就绪但当前选中的企业已不在名录中（被删除/停用），重新拉一次。
     * 否则会一直用着一个失效的 entId 去查委托，页面永远"暂无数据"，
     * 而接口返回的是 200 + 空数组 —— 看起来像没数据，实则是选错了对象。 */
    if (Proxy.entId.value && !Proxy.ents.value.some((x) => x.id === Proxy.entId.value)) {
      Proxy.ready.value = false;
      await loadProxyEnts();
    }
    return Proxy.entId.value;
  }

  function setProxyEnt(id) {
    Proxy.entId.value = Number(id) || null;
    try { localStorage.setItem(PROXY_KEY, String(Proxy.entId.value || '')); } catch (e) { /* 隐私模式忽略 */ }
  }

  function proxyEnt() {
    return Proxy.ents.value.find((x) => x.id === Proxy.entId.value) || null;
  }

  /** 代理企业选择条（交易端四个页面共用同一 vnode）
   *
   * 三种状态必须说出三种不同的话，不能都退化成"暂无数据"：
   *   ① 授权清单加载失败   → 明说失败原因并给重试
   *   ② 一条授权都没有     → 明说"尚未获得任何企业授权"，并指路到企业端签授权
   *   ③ 有授权             → 正常显示选择器 + 授权范围
   */
  function ProxyBar() {
    if (!isTrader()) return null;
    if (!Proxy.mandatesReady.value) {
      return h('div', { class: 'alertbar warn' }, [
        h('x-icon', { name: 'alert', size: 15 }),
        h('span', {}, Proxy.loadError.value
          ? `代理授权清单加载失败：${Proxy.loadError.value}`
          : '正在读取本机构的代理授权…'),
        h('button', { class: 'btn sm', onClick: () => { Proxy.ready.value = false; loadProxyEnts(); } }, '重试'),
      ]);
    }
    if (!Proxy.ents.value.length) {
      return h('div', { class: 'alertbar warn' }, [
        h('x-icon', { name: 'shield', size: 15 }),
        h('span', {}, '本机构尚未获得任何企业的代理交易授权。请由控排企业在「企业端 → 代理授权」中签发授权后再操作。'),
      ]);
    }
    const cur = proxyEnt();
    return h('div', { class: 'flex gap-8 wrap', style: 'margin-bottom:14px' }, [
      h('span', { class: 'tiny dim' }, '当前代理企业'),
      h('select', {
        class: 'select',
        style: 'width:300px',
        value: Proxy.entId.value || '',
        onChange: (e) => setProxyEnt(e.target.value),
      }, Proxy.ents.value.map((x) => h('option', { value: x.id }, x.name))),
      cur && h('x-tag', { text: cur.scopeCn || cur.scope, tone: 't-ok' }),
      cur && cur.maxAmount !== null && h('x-tag', {
        text: `单笔上限 ${App.fmt.num(cur.maxAmount, 0)} t`, tone: 't-mute',
      }),
      cur && cur.validTo && h('span', { class: 'tiny dim' }, `授权至 ${String(cur.validTo).slice(0, 10)}`),
      h('span', { class: 'tiny dim' }, `共 ${Proxy.ents.value.length} 家已授权 · 本页数据均属所选企业`),
    ]);
  }

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
        /* change 为 null 表示"前一交易日无成交，没有可比基准"。
         * 此时不能传 0，否则 KPI 显示「↑ 0.00%」，读者会以为价格持平。 */
        const hasChange = m && m.change !== null && m.change !== undefined;
        const up = hasChange ? m.change >= 0 : true;
        const b = book.value || { buys: [], sells: [] };
        return h('x-page', { title: '市场行情', desc: '碳配额二级市场 · 价格优先、时间优先连续竞价撮合 · 涨红跌绿' }, {
          actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          default: () => !m ? h('div', { class: 'skel', style: 'height:260px' }) : [
            h('div', { class: 'grid g4 mb-16' }, [
              h('x-kpi', {
                label: '最新成交价', value: App.fmt.usd(m.lastPrice, 2), unit: '元/吨', icon: 'coin',
                tone: hasChange ? (up ? 'rose' : 'carbon') : 'carbon',
                ...(hasChange
                  ? { delta: m.change, deltaTone: up ? 'bad' : 'good', foot: m.changeBasis }
                  : { foot: m.changeBasis || '前一交易日无成交' }),
              }),
              h('x-kpi', { label: '累计成交量', value: App.fmt.num(m.kpi.volume, 0), unit: 'tCO₂e', icon: 'trade', tone: 'sky', foot: `${m.kpi.deals} 笔成交` }),
              h('x-kpi', { label: '累计成交额', value: App.fmt.big(m.kpi.turnover), unit: '元', icon: 'bank', tone: 'violet' }),
              /* 原名「CCER 资产参考」+ 徽标「价格参照」，但 credit_asset 表
               * 没有价格字段，这里能给的只有"项数 / 平均体量"。
               * 名字必须与内容一致：这是规模口径，不是价格参照。 */
              h('x-kpi', {
                label: 'CCER 资产规模', value: m.ccer.assetCount, unit: '项', icon: 'leaf', tone: 'carbon',
                foot: `平均 ${App.fmt.num(m.ccer.avgAmount, 0)} tCO₂e/项 · 非价格口径`,
              }),
            ]),

            h('div', { class: 'grid g-2-1 mb-16' }, [
              h('x-card', { title: '碳价走势（日线）', sub: '近 90 个交易日' }, {
                default: () => h('x-chart', { option: klineOption.value, height: 'h340' }),
              }),
              h('x-card', { title: '买卖盘口', sub: '前 10 档（卖绿 / 买红）' }, {
                default: () => h('div', { class: 'col gap-4' }, [
                  h('div', { class: 'tiny dim mb-4' }, '卖盘'),
                  /* 无挂单时必须给一句明确的话。原来直接 map 空数组 →
                   * 整块空白，读者分不清"没有卖盘"和"页面没加载出来"
                   * （2026-10-29 巡检 P1-15）。 */
                  ...(b.sells.length ? b.sells.slice().reverse().map((s) => h('div', { class: 'bar-row' }, [
                    h('span', { class: 'nm', style: 'color:#34d399' }, App.fmt.num(s.price, 2)),
                    h('div', { class: 'bar-track' }, [h('div', { class: 'bar-fill', style: `width:${Math.min(100, s.amount / 120)}%;background:linear-gradient(90deg,#065f46,#34d399);box-shadow:0 0 12px -2px rgba(52,211,153,.7)` })]),
                    h('span', { class: 'vv' }, App.fmt.num(s.amount, 0)),
                  ])) : [h('div', { class: 'tiny dim', style: 'padding:10px 0' }, '暂无挂单（卖方未挂出配额）')]),
                  h('div', { class: 'divider' }),
                  h('div', { class: 'tiny dim mb-4' }, '买盘'),
                  ...(b.buys.length ? b.buys.map((x) => h('div', { class: 'bar-row' }, [
                    h('span', { class: 'nm', style: 'color:#fb7185' }, App.fmt.num(x.price, 2)),
                    h('div', { class: 'bar-track' }, [h('div', { class: 'bar-fill', style: `width:${Math.min(100, x.amount / 120)}%;background:linear-gradient(90deg,#9f1239,#fb7185);box-shadow:0 0 12px -2px rgba(251,113,133,.7)` })]),
                    h('span', { class: 'vv' }, App.fmt.num(x.amount, 0)),
                  ])) : [h('div', { class: 'tiny dim', style: 'padding:10px 0' }, '暂无挂单（买方未挂出需求）')]),
                ]),
              }),
            ]),
          ],
        });
      };
    },
  });

  /* ---------------- T2 配额挂牌 + 成交记录（合并页） ----------------
   *
   * 【为什么合并】原「挂牌与成交」页下半已有「我的委托单」，而独立页
   * 「成交记录」只是同一批 trade_deal 的另一种切法；「我的账户」里还有
   * 第三张"最近成交"表。同一份数据在三个入口重复出现，用户得记
   * "换个角度看成交要去哪个菜单"。合并为一个页面的两个标签：
   *   委托 / 成交 —— 动作与结果相邻，签完单立刻能看到是否成交。
   * 旧路由 /trade/deals 仍然可达（渲染同一个组件并默认打开成交标签），
   * 因此外部链接与巡检脚本不会断。
   */
  const PageTradeOrders = defineComponent({
    name: 'page-trade-orders',
    setup() {
      const orders = ref([]);
      const deals = ref([]);
      const market = ref(null);
      const busy = ref(false);
      /* 取数失败（403 未授权 / 网络）必须与"真的没有委托"区分开。
       * 原先两者都渲染成 x-table 的"暂无数据"，界面上完全一样，
       * 于是"没权限"被读成"没数据"。 */
      const loadErr = ref('');
      const dealsErr = ref('');
      const form = reactive({ side: 'BUY', price: '', amount: '' });
      /* 默认标签：/trade/deals 进来直接看成交，/trade/orders 看委托 */
      const tab = ref(App.Router && App.Router.path === '/trade/deals' ? 'deals' : 'orders');

      async function load() {
        loadErr.value = '';
        dealsErr.value = '';
        const [o, d] = await Promise.all([
          App.API.request('GET', withEnt('/trade/orders'), null, { fresh: true })
            .then((v) => ({ v })).catch((e) => ({ e })),
          App.API.request('GET', withEnt('/trade/deals'), null, { fresh: true })
            .then((v) => ({ v })).catch((e) => ({ e })),
        ]);
        if (o.e) { orders.value = []; loadErr.value = o.e.message || String(o.e); } else { orders.value = o.v || []; }
        if (d.e) { deals.value = []; dealsErr.value = d.e.message || String(d.e); } else { deals.value = d.v || []; }
        try {
          market.value = await App.API.request('GET', '/trade/market', null, { noAuth: true });
        } catch (e) { /* 行情失败不影响委托单展示 */ }
      }
      onMounted(async () => { await ensureProxy(); await load(); });
      watch(Proxy.entId, (v) => { if (v) load(); });

      function useLast() { if (market.value) form.price = String(market.value.lastPrice); }

      async function submit() {
        if (!(Number(form.price) > 0) || !(Number(form.amount) > 0)) { App.notify.warn('请填写有效的价格与数量'); return; }
        busy.value = true;
        try {
          const r = await App.API.request('POST', '/trade/orders', {
            side: form.side, price: Number(form.price), amount: Number(form.amount),
            entId: activeEntId() || undefined,
          });
          App.notify.ok(r.matchedCount > 0 ? `委托已提交，即时撮合成交 ${r.matchedCount} 笔` : '委托已挂出，等待成交');
          form.amount = '';
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      async function cancel(o) {
        try { await App.API.request('POST', withEnt(`/trade/orders/${o.id}/cancel`)); App.notify.ok('委托已撤销'); await load(); }
        catch (e) { App.notify.err(e.message); }
      }

      const tabBtn = (key, label, count) => h('button', {
        class: ['btn', tab.value === key ? 'primary' : 'ghost'],
        onClick: () => { tab.value = key; },
      }, [label, count !== undefined ? h('span', { class: 'tiny', style: 'margin-left:6px;opacity:.75' }, String(count)) : null]);

      return () => h('x-page', {
        title: '配额挂牌与成交',
        desc: '代理企业限价委托 · 成交后配额即时划转并上链存证（每笔成交一笔 TRADE_DEAL 存证）',
      }, {
        actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
        default: () => [
          ProxyBar(),
          h('div', { class: 'flex gap-8 mb-16' }, [
            tabBtn('orders', '我的委托单', orders.value.length),
            tabBtn('deals', '成交记录', deals.value.length),
          ]),
          tab.value === 'orders' ? h('div', { class: 'grid g-1-2 mb-16' }, [
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
                h('div', { class: 'tiny dim' }, '委托单价偏离最近成交价超过 30% 会被拒单，用于拦截输错量级的价格。'),
                h('button', { class: 'btn primary', disabled: busy.value, onClick: submit }, busy.value ? '提交中…' : '提交委托'),
              ]),
            }),
            h('x-card', { title: '我的委托单', flush: true }, {
              default: () => loadErr.value
                ? h('div', { style: 'padding:16px' }, [h('x-empty', {
                  title: '委托单加载失败', sub: loadErr.value, tone: 'danger', retry: true, onRetry: () => load(),
                })])
                : h('x-table', {
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
          ]) : h('x-card', {
            title: '成交记录', sub: '全程可溯 · 每笔成交均上链存证，可点链上凭证跳转区块链浏览器', flush: true,
          }, {
            default: () => dealsErr.value
              ? h('div', { style: 'padding:16px' }, [h('x-empty', {
                title: '成交记录加载失败', sub: dealsErr.value, tone: 'danger', retry: true, onRetry: () => load(),
              })])
              : h('x-table', {
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
        ],
      });
    },
  });

  /* ---------------- T3 我的账户 ---------------- */
  const PageTradeAccount = defineComponent({
    name: 'page-trade-account',
    setup() {
      const acc = ref(null);
      const loadErr = ref('');
      async function load() {
        loadErr.value = '';
        try { acc.value = await App.API.request('GET', withEnt('/trade/account'), null, { fresh: true }); }
        catch (e) { acc.value = null; loadErr.value = e.message || String(e); }
      }
      onMounted(async () => { await ensureProxy(); await load(); });
      watch(Proxy.entId, (v) => { if (v) load(); });
      return () => {
        const a = acc.value;
        const ent = proxyEnt();
        return h('x-page', { title: isTrader() ? '代理交易账户' : '我的交易账户', desc: '配额 / 碳信用持仓 · 冻结与可用 · 每笔划转含链上 txid' }, {
          actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          default: () => [ProxyBar(), loadErr.value
            ? h('x-empty', { title: '账户数据加载失败', sub: loadErr.value, tone: 'danger', retry: true, onRetry: () => load() })
            : !a ? h('div', { class: 'skel', style: 'height:220px' }) : [
            isTrader() && ent && h('div', { class: 'alertbar info' }, [
              h('x-icon', { name: 'info', size: 15 }),
              `以下为代理企业「${ent.name}」的配额与持仓，非交易中心自有账户。`,
            ]),
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
          ]],
        });
      };
    },
  });

  /* ---------------- 旧 T4 路由的兼容层 ----------------
   * /trade/deals 已并入「配额挂牌与成交」页的成交标签。这里保留路由，
   * 让书签、外部链接与 cdp-check 巡检脚本仍然可达，且直接落到成交标签。
   * 不重复实现一份表格 —— 两份实现必然漂移。 */
  const PageTradeDeals = defineComponent({
    name: 'page-trade-deals',
    setup() {
      return () => h(PageTradeOrders);
    },
  });

  /* ---------------- T5 抵销清缴 ---------------- */
  const PageTradeOffset = defineComponent({
    name: 'page-trade-offset',
    setup() {
      const assets = ref([]);
      const offsets = ref([]);
      const status = ref(null);
      const modal = ref(false);
      const form = reactive({ assetId: null, amount: '' });
      const pick = ref(null);
      const busy = ref(false);
      const loadErr = ref('');

      async function load() {
        loadErr.value = '';
        try {
          if (isTrader() && !activeEntId()) { assets.value = []; offsets.value = []; status.value = null; return; }
          const [a, s, o] = await Promise.all([
            App.API.request('GET', withEnt('/credit/assets')),
            App.API.request('GET', withEnt('/credit/status')),
            App.API.request('GET', withEnt('/credit/offsets?limit=50')),
          ]);
          assets.value = a || [];
          status.value = s || null;
          offsets.value = o || [];
        } catch (e) {
          assets.value = []; offsets.value = []; status.value = null;
          loadErr.value = e.message || String(e);
        }
      }
      onMounted(async () => { await ensureProxy(); await load(); });
      watch(Proxy.entId, (v) => { if (v) load(); });

      function open(a) {
        const allowed = status.value ? Math.min(a.remaining, status.value.offsetLimitRemaining) : a.remaining;
        pick.value = a;
        form.assetId = a.id;
        form.amount = String(Math.max(0, Math.floor(allowed)));
        modal.value = true;
      }
      async function submit() {
        const amt = Number(form.amount);
        if (!(amt > 0)) { App.notify.warn('请填写大于 0 的抵销量'); return; }
        if (status.value && amt > status.value.offsetLimitRemaining) {
          App.notify.warn(`超出剩余可抵销额度 ${status.value.offsetLimitRemaining} tCO₂e`); return;
        }
        if (pick.value && amt > pick.value.remaining) {
          App.notify.warn(`超出该资产可用量 ${pick.value.remaining} tCO₂e`); return;
        }
        busy.value = true;
        try {
          const r = await App.API.request('POST', '/trade/offset', {
            assetId: form.assetId, amount: amt,
            entId: activeEntId() || undefined,
          });
          App.notify.ok(`已抵销 ${r.amount} tCO₂e，缺口降至 ${r.quotaAfter} tCO₂e（已上链）`);
          modal.value = false;
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      return () => h('x-page', { title: isTrader() ? '代理抵销清缴' : '抵销清缴', desc: '选择 CCER 等碳信用抵销履约缺口 · 自动校验 5% 上限 · 注销记录上链存证' }, {
        actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
        default: () => [
          ProxyBar(),
          loadErr.value && h('x-empty', {
            title: '抵销数据加载失败', sub: loadErr.value, tone: 'danger', retry: true, onRetry: () => load(),
          }),
          isTrader() && !activeEntId() && !loadErr.value && h('x-empty', { title: '请先选择代理企业', sub: '交易中心需先指定代理企业，才能查看其抵销额度并代为发起抵销。', icon: 'users' }),
          status.value && h('div', { class: 'grid g5 mb-16' }, [
            h('x-kpi', { label: '本年度配额', value: App.fmt.num(status.value.quota, 0), unit: 'tCO₂e', icon: 'coin', tone: 'carbon' }),
            h('x-kpi', { label: '抵销上限（5%）', value: App.fmt.num(status.value.limit, 0), unit: 'tCO₂e', icon: 'target', tone: 'sky' }),
            h('x-kpi', { label: '已抵销', value: App.fmt.num(status.value.used, 0), unit: 'tCO₂e', icon: 'fire', tone: 'violet' }),
            h('x-kpi', { label: '剩余可抵销', value: App.fmt.num(status.value.offsetLimitRemaining, 0), unit: 'tCO₂e', icon: 'leaf', tone: 'carbon' }),
            h('x-kpi', {
              label: Number(status.value.gap) >= 0 ? '预计履约缺口' : '预计履约盈余',
              value: App.fmt.num(Math.abs(Number(status.value.gap) || 0), 0), unit: 'tCO₂e', icon: 'alert',
              tone: Number(status.value.gap) >= 0 ? 'rose' : 'carbon',
              foot: Number(status.value.gap) >= 0 ? '需清缴或抵销' : '无需抵销',
            }),
          ]),
          status.value && Number(status.value.gap) < 0 && h('div', { class: 'alertbar warn mb-16' }, [
            h('x-icon', { name: 'alert', size: 15 }),
            `该企业本年度预计盈余 ${App.fmt.num(Math.abs(Number(status.value.gap)), 0)} tCO₂e，不存在履约缺口。`
            + '此时发起抵销虽可记账，但不产生任何履约收益，且会消耗不可再生的碳信用额度。',
          ]),
          h('x-card', { title: proxyEnt() ? `可用碳信用资产 · ${proxyEnt().name}` : '可用碳信用资产', flush: true }, {
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
          h('x-card', { title: '抵销流水', sub: '最近 50 笔 · 每笔注销均上链存证', flush: true, style: 'margin-top:16px' }, {
            default: () => h('x-table', {
              columns: [
                { key: 'offsetNo', title: '抵销编号', width: '150px' },
                { key: 'year', title: '年度', width: '80px' },
                { key: 'entName', title: '企业' },
                { key: 'assetNo', title: '资产编号', width: '140px' },
                { key: 'amount', title: '抵销量', align: 'right' },
                { key: 'quotaBefore', title: '抵销前缺口', align: 'right' },
                { key: 'quotaAfter', title: '抵销后缺口', align: 'right' },
                { key: 'operator', title: '经办人', width: '100px' },
                { key: 'chainBlockIndex', title: '链上存证', width: '110px' },
              ],
              rows: offsets.value, empty: '暂无抵销记录',
            }, {
              'col-offsetNo': ({ value }) => h('span', { class: 'mono' }, value),
              'col-entName': ({ value }) => h('span', {}, value || '-'),
              'col-assetNo': ({ value }) => h('span', { class: 'mono tiny' }, value),
              'col-amount': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
              'col-quotaBefore': ({ value }) => h('span', { class: 'mono muted' }, App.fmt.num(value, 1)),
              'col-quotaAfter': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 1)),
              'col-chainBlockIndex': ({ row }) => h('x-chainbadge', { block: row.chainBlockIndex, hash: row.chainTxId }),
            }),
          }),
          modal.value && h('x-modal', { modelValue: modal.value, title: 'CCER 抵销清缴', 'onUpdate:modelValue': (v) => { modal.value = v; } }, {
            default: () => h('div', { class: 'col gap-12' }, [
              proxyEnt() && h('div', { class: 'alertbar warn' }, [h('x-icon', { name: 'alert', size: 15 }), `本次为代理抵销，计入「${proxyEnt().name}」履约账户，经办人记录为当前登录交易员。`]),
              h('div', {}, [h('b', {}, '资产：'), pick.value ? pick.value.assetTypeCn + ' · ' + pick.value.assetNo : '']),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '抵销量（tCO₂e）'),
                h('input', { class: 'input', type: 'number', value: form.amount, onInput: (e) => { form.amount = e.target.value; } }),
              ]),
              status.value && h('div', { class: 'alertbar info' }, [h('x-icon', { name: 'info', size: 15 }), `抵销不超过配额 5%（上限 ${status.value.limit} tCO₂e，已用 ${status.value.used} tCO₂e）`]),
            ]),
            footer: () => [
              h('button', { class: 'btn', onClick: () => { modal.value = false; } }, '取消'),
              h('button', { class: 'btn primary', disabled: busy.value, onClick: submit }, busy.value ? '提交中…' : '确认抵销并上链'),
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
