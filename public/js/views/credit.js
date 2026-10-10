/* =====================================================================
   碳资产 · 碳信用与抵销
   企业端：我的碳信用资产 / 抵销履约缺口 / 抵销记录
   监管端：全市场碳信用资产总览 / 类型分布 / 抵销流水
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted } = Vue;
  const h = App.h;

  const PageCredit = defineComponent({
    name: 'page-credit',
    setup() {
      const summary = ref(null);
      const assets = ref([]);
      const offsets = ref([]);
      const status = ref(null);
      const busy = ref(false);
      const isEnt = computed(() => App.Store.user && App.Store.user.role === 'ENTERPRISE');

      const modal = ref(false);
      const form = ref({ assetId: null, amount: '' });
      const pick = ref(null);

      async function load() {
        try {
          summary.value = await App.API.request('GET', '/credit/summary');
          assets.value = await App.API.request('GET', '/credit/assets');
          offsets.value = await App.API.request('GET', '/credit/offsets', null);
          if (isEnt.value) status.value = await App.API.request('GET', '/credit/status');
        } catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);

      function openOffset(a) {
        const avail = a.remaining;
        const allowed = status.value ? Math.min(avail, status.value.offsetLimitRemaining) : avail;
        pick.value = a;
        form.value = { assetId: a.id, amount: String(Math.max(0, Math.floor(allowed))) };
        modal.value = true;
      }

      async function submitOffset() {
        busy.value = true;
        try {
          const r = await App.API.request('POST', '/credit/offset', {
            assetId: form.value.assetId, amount: Number(form.value.amount),
          });
          App.notify.ok(`已抵销 ${r.amount} tCO₂e，预计缺口降至 ${r.quotaAfter} tCO₂e（已上链）`);
          modal.value = false;
          await load();
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      const statusTag = (s) => (s === 'ACTIVE' ? 'ok' : s === 'USED' ? 'warn' : 'err');
      const statusCn = (s) => ({ ACTIVE: '可用', USED: '已用尽', EXPIRED: '已过期' }[s] || s);

      const assetTable = () => h('div', { class: 'table-wrap' }, [
        h('table', { class: 'table' }, [
          h('thead', {}, h('tr', {}, [
            ...(isEnt.value ? [] : ['持有企业']),
            '资产编号', '类型', '减排项目', '持有量', '已抵销', '可用', '签发年度', '有效期', '状态',
            ...(isEnt.value ? ['操作'] : []),
          ].map((t) => h('th', {}, t)))),
          h('tbody', {}, (assets.value || []).map((a) => h('tr', {}, [
            ...(isEnt.value ? [] : [h('td', {}, a.entName || ('企业#' + a.entId))]),
            h('td', { class: 'mono', style: 'font-size:12px' }, a.assetNo),
            h('td', {}, h('span', { class: 'tag chain' }, a.assetTypeCn)),
            h('td', {}, a.projectName || '-'),
            h('td', { class: 'mono' }, App.fmt.num(Math.round(a.amount))),
            h('td', { class: 'mono' }, App.fmt.num(Math.round(a.usedAmount))),
            h('td', { class: 'mono' }, App.fmt.num(Math.round(a.remaining))),
            h('td', { class: 'mono' }, String(a.issueYear || '-')),
            h('td', { class: 'tiny dim' }, a.validUntil ? App.fmt.dt(a.validUntil).slice(0, 10) : '-'),
            h('td', {}, h('span', { class: ['tag', statusTag(a.status)] }, statusCn(a.status))),
            ...(isEnt.value ? [h('td', {}, a.status === 'ACTIVE' && a.remaining > 0
              ? h('button', { class: 'btn xs chain', disabled: busy.value, onClick: () => openOffset(a) }, '抵销')
              : h('span', { class: 'tiny dim' }, '—'))] : []),
          ]))),
        ]),
      ]);

      const offsetTable = () => h('div', { class: 'table-wrap' }, [
        h('table', { class: 'table' }, [
          h('thead', {}, h('tr', {}, [
            ...(isEnt.value ? [] : ['企业']),
            '抵销单号', '年度', '碳信用资产', '抵销量(tCO₂e)', '抵销前缺口', '抵销后缺口', '经办人', '存证', '时间',
          ].map((t) => h('th', {}, t)))),
          h('tbody', {}, (offsets.value || []).map((o) => h('tr', {}, [
            ...(isEnt.value ? [] : [h('td', {}, o.entName)]),
            h('td', { class: 'mono', style: 'font-size:12px' }, o.offsetNo),
            h('td', { class: 'mono' }, String(o.year)),
            h('td', {}, [h('div', {}, o.assetTypeCn), h('div', { class: 'tiny dim mono' }, o.assetNo)]),
            h('td', { class: 'mono' }, App.fmt.num(Math.round(o.amount))),
            h('td', { class: 'mono' }, App.fmt.num(Math.round(o.quotaBefore))),
            h('td', { class: 'mono' }, App.fmt.num(Math.round(o.quotaAfter))),
            h('td', {}, o.operator || '-'),
            h('td', {}, o.chainTxId ? h('span', { class: 'tag ok' }, '已上链') : h('span', { class: 'tiny dim' }, '-')),
            h('td', { class: 'tiny dim' }, o.createdAt ? App.fmt.dt(o.createdAt) : '-'),
          ]))),
        ]),
      ]);

      return () => {
        const s = summary.value || { byType: [] };
        const st = status.value || {};
        const kpis = isEnt.value
          ? [
            h('x-kpi', { label: '可用碳信用', value: App.fmt.num(Math.round(st.availableCredit || 0)), unit: 'tCO₂e', icon: 'leaf', tone: 'chain', foot: 'CCER / 碳汇 / 绿证' }),
            h('x-kpi', { label: '年度配额', value: App.fmt.num(Math.round(st.quota || 0)), unit: 'tCO₂e', icon: 'target', tone: 'sky', foot: '碳配额资产' }),
            h('x-kpi', { label: '抵销额度上限', value: App.fmt.num(Math.round(st.limit || 0)), unit: 'tCO₂e', icon: 'shield', tone: 'violet', foot: '配额 × 5%' }),
            h('x-kpi', { label: '剩余可抵销', value: App.fmt.num(Math.round(st.offsetLimitRemaining || 0)), unit: 'tCO₂e', icon: 'chart', tone: 'carbon', foot: `已抵销 ${App.fmt.num(Math.round(st.used || 0))}` }),
            h('x-kpi', { label: '当前预计缺口', value: App.fmt.num(Math.round(st.gap || 0)), unit: 'tCO₂e', icon: 'alert', tone: (st.gap > 0 ? 'rose' : 'chain'), foot: '动态核算净缺口' }),
          ]
          : [
            h('x-kpi', { label: '碳信用资产总量', value: App.fmt.num(Math.round(s.totalAmount || 0)), unit: 'tCO₂e', icon: 'leaf', tone: 'chain', foot: `持有企业 ${s.holders || 0} 家` }),
            h('x-kpi', { label: '已抵销', value: App.fmt.num(Math.round(s.usedAmount || 0)), unit: 'tCO₂e', icon: 'target', tone: 'carbon', foot: `抵销笔数 ${s.offsetCount || 0}` }),
            h('x-kpi', { label: '可用余额', value: App.fmt.num(Math.round(s.availableAmount || 0)), unit: 'tCO₂e', icon: 'db', tone: 'sky', foot: '尚未使用' }),
            h('x-kpi', { label: '资产笔数', value: App.fmt.num(s.assetCount || 0), unit: '笔', icon: 'sheet', tone: 'violet', foot: '配额之外的第二类碳资产' }),
          ];

        return h('x-page', {
          title: isEnt.value ? '碳信用与抵销' : '碳资产总览（碳信用）',
          desc: '本平台的"碳资产"包含两类：① 碳配额（年度分配，可市场交易）；② 碳信用（国家核证自愿减排量 CCER / 林业碳汇 / 绿证）。企业可用碳信用抵销履约缺口，抵销比例不得超过配额的 5%，抵销流水上链存证。',
        }, {
          actions: () => [h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新'])],
          default: () => [
            h('div', { class: isEnt.value ? 'grid g5 mb-16' : 'grid g4 mb-16' }, kpis),

            !isEnt.value
              ? h('x-card', { title: '碳资产类型分布', sub: '按碳信用类型统计持有量与已抵销量', class: 'mb-16' }, {
                default: () => h('div', { class: 'col gap-10' }, (s.byType || []).length
                  ? (s.byType || []).map((t) => h('div', { class: 'flex between', style: 'align-items:center' }, [
                    h('span', {}, [h('span', { class: 'tag chain' }, t.typeCn), `　${t.count} 笔`]),
                    h('span', { class: 'mono' }, `持有 ${App.fmt.num(Math.round(t.amount))} · 已抵销 ${App.fmt.num(Math.round(t.used))} tCO₂e`),
                  ]))
                  : h('div', { class: 'tiny dim' }, '暂无数据')),
              })
              : null,

            isEnt.value && st.gap > 0
              ? h('div', { class: ['alertbar', 'warn', 'mb-16'] }, [
                h('x-icon', { name: 'alert', size: 16 }),
                `按当前滚动核算，你企业本年度预计履约缺口约 ${App.fmt.num(Math.round(st.gap))} tCO₂e。可使用碳信用抵销（上限 ${App.fmt.num(Math.round(st.limit))} tCO₂e），或通过碳配额市场购碳履约。`,
              ])
              : null,

            h('x-card', { title: isEnt.value ? '我的碳信用资产' : '全市场碳信用资产', sub: isEnt.value ? '点击"抵销"用碳信用履约' : '按持有企业展示', class: 'mb-16' }, { default: assetTable }),

            h('x-card', { title: isEnt.value ? '我的抵销记录' : '碳信用抵销流水', sub: '每笔抵销均已上链存证' }, { default: offsetTable }),

            h('x-modal', {
              modelValue: modal.value, title: '发起碳信用抵销', width: '480px',
              'onUpdate:modelValue': (v) => { modal.value = v; },
            }, {
              default: () => [
                h('div', { class: 'col gap-10' }, [
                  h('div', { class: 'field', style: 'margin:0' }, [h('label', {}, '碳信用资产'), h('input', { class: 'input', value: pick.value ? `${pick.value.assetTypeCn} ${pick.value.assetNo}（可用 ${App.fmt.num(Math.round(pick.value.remaining))}）` : '', disabled: true })]),
                  h('div', { class: 'field', style: 'margin:0' }, [h('label', {}, '抵销量 (tCO₂e)'), h('input', { class: 'input', type: 'number', value: form.value.amount, onInput: (e) => { form.value.amount = e.target.value; } })]),
                  h('div', { class: 'tiny dim' }, `本次最多可抵销 ${status.value ? App.fmt.num(Math.round(Math.min(pick.value ? pick.value.remaining : 0, status.value.offsetLimitRemaining))) : '-'} tCO₂e（受配额 5% 上限与资产余额双重约束）。`),
                ]),
              ],
              footer: () => [
                h('button', { class: 'btn', onClick: () => { modal.value = false; } }, '取消'),
                h('button', { class: 'btn chain', disabled: busy.value || !(Number(form.value.amount) > 0), onClick: submitOffset }, '确认抵销并上链'),
              ],
            }),
          ],
        });
      };
    },
  });

  App.views['page-credit'] = PageCredit;
})();
