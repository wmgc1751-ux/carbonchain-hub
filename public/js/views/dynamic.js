/* =====================================================================
   碳资产动态核算：CEMS 实时读数 · 滚动核算 · 配额缺口与履约风险预警
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted } = Vue;
  const h = App.h;

  const RISK_CN = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险' };
  const riskTag = (r) => (r === 'HIGH' ? 'err' : r === 'MEDIUM' ? 'warn' : 'ok');

  const PageDynamic = defineComponent({
    name: 'page-dynamic',
    setup() {
      const ov = ref(null);
      const readings = ref(null);
      const busy = ref(false);
      const isEnt = computed(() => App.Store.user && App.Store.user.role === 'ENTERPRISE');

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

      return () => {
        const d = ov.value || { summary: {}, readings: {}, accounts: [] };
        const s = d.summary || {};
        const r = d.readings || {};
        const total = (s.highRisk || 0) + (s.mediumRisk || 0) + (s.lowRisk || 0);
        return h('x-page', {
          title: '碳资产动态核算',
          desc: '区别于按季度人工填报：本页数据来自工业排口 CEMS 在线监测的准实时读数，按企业配额规模滚动核算累计排放、预测期末排放与配额缺口，并据此动态给出履约风险预警。',
        }, {
          actions: () => [
            h('button', { class: 'btn sm', disabled: busy.value, onClick: doIngest }, [h('x-icon', { name: 'refresh', size: 14 }), '采集一批实测数据']),
            h('button', { class: 'btn sm chain', disabled: busy.value, onClick: doRecompute }, [h('x-icon', { name: 'chart', size: 14 }), '立即滚动核算']),
          ],
          default: () => [
            h('div', { class: 'grid g5 mb-16' }, [
              h('x-kpi', { label: '核算周期', value: d.period || '-', icon: 'clock', tone: 'violet', foot: '滚动核算·非季度填报' }),
              h('x-kpi', { label: '覆盖企业', value: App.fmt.num(s.enterprises || 0), unit: '家', icon: 'factory', tone: 'carbon', foot: '纳入动态核算' }),
              h('x-kpi', { label: '实测读数', value: App.fmt.num(r.total || 0), unit: '条', icon: 'db', tone: 'sky', foot: (r.lastAt ? '最新 ' + App.fmt.dt(r.lastAt) : '-') }),
              h('x-kpi', { label: '年度累计排放', value: App.fmt.num(Math.round(s.cumulativeEmission || 0)), unit: 'tCO₂e', icon: 'leaf', tone: 'chain', foot: '实测累计' }),
              h('x-kpi', { label: '预计配额缺口', value: App.fmt.num(Math.round(s.totalGap || 0)), unit: 'tCO₂e', icon: 'target', tone: (s.totalGap > 0 ? 'rose' : 'chain'), foot: s.totalGap > 0 ? '整体预计超排' : '整体预计盈余' }),
            ]),

            h('div', { class: 'grid g3 mb-16' }, [
              h('x-card', { title: '履约风险分布' }, {
                default: () => h('div', { class: 'col gap-8' }, [
                  h('div', { class: 'flex between' }, [h('span', {}, '高风险'), h('b', { style: 'color:var(--danger,#e5484d)' }, (s.highRisk || 0) + ' 家')]),
                  h('div', { class: 'flex between' }, [h('span', {}, '中风险'), h('b', {}, (s.mediumRisk || 0) + ' 家')]),
                  h('div', { class: 'flex between' }, [h('span', {}, '低风险'), h('b', {}, (s.lowRisk || 0) + ' 家')]),
                  h('div', { class: 'tiny dim mt-8' }, `风险判定基准：按当前排放速率外推的期末排放量 vs 已分配配额（超 10% 为高风险，超配额为中风险）。`),
                ]),
              }),
              h('x-card', { title: '核算口径' }, {
                default: () => h('dl', { class: 'kv', style: 'grid-template-columns:96px 1fr' }, [
                  h('dt', {}, '数据来源'), h('dd', {}, 'CEMS 在线监测（准实时）'),
                  h('dt', {}, '采样步长'), h('dd', { class: 'mono' }, '4 小时 / 点'),
                  h('dt', {}, '核算方式'), h('dd', {}, '滚动累计 + 速率外推'),
                  h('dt', {}, '平均流速'), h('dd', { class: 'mono' }, App.fmt.num(Math.round(r.avgFlow || 0)) + ' tCO₂e/点'),
                ]),
              }),
              h('x-card', { title: '说明' }, {
                default: () => h('div', { class: 'col gap-8' }, [
                  h('div', { class: 'tiny' }, '· 与「碳排放上报」的季度静态数据互为印证，同一口径折算 tCO₂e。'),
                  h('div', { class: 'tiny' }, '· 缺口为正表示按当前滚动速率外推，预计期末排放将超出已分配配额，需提前通过市场购碳或调整生产履约。'),
                  h('div', { class: 'tiny' }, '· 风险达到中/高时，系统自动产生监管预警（见预警中心）。'),
                ]),
              }),
            ]),

            isEnt.value && readings.value && readings.value.readings && readings.value.readings.length
              ? h('x-card', { title: '本企业 CEMS 实时读数', sub: '排口在线监测按 4 小时步长推送；累计值随采数滚动增长', class: 'mb-16' }, {
                default: () => h('div', { class: 'table-wrap', style: 'max-height:340px;overflow:auto' }, [
                  h('table', { class: 'table' }, [
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
              default: () => h('div', { class: 'table-wrap' }, [
                h('table', { class: 'table' }, [
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
