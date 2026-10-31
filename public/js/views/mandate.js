/* 企业端「代理授权」页 + 监管端「授权台账」页
 * 依赖：/api/mandate/mine | POST /api/mandate | POST /api/mandate/:id/revoke
 *       /api/mandate/candidates | /api/mandate/ledger */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, h } = Vue;

  /* views 注册表由各页面文件各自确保存在（app.js 的脚本在本文件之后加载，
   * 此处若不初始化，App.views 为 undefined，直接赋值会静默失败导致页面空白）。 */
  App.views = App.views || {};

  const SCOPE_CN = { TRADE_ONLY: '仅交易', TRADE_AND_OFFSET: '交易+清缴' };

  /* ==================================================================
   * 企业端：代理授权
   * ================================================================== */
  App.views['page-ent-mandate'] = defineComponent({
    name: 'page-ent-mandate',
    setup() {
      const rows = ref([]);
      const cands = ref([]);
      const loading = ref(true);
      const err = ref('');
      const saving = ref(false);
      const form = reactive({ traderUserId: '', scope: 'TRADE_ONLY', maxAmount: '', validTo: '' });

      async function load() {
        loading.value = true; err.value = '';
        try {
          const [a, b] = await Promise.all([
            App.API.get('/mandate/mine'),
            App.API.get('/mandate/candidates'),
          ]);
          rows.value = a.rows || [];
          cands.value = b || [];
          if (cands.value.length && !form.traderUserId) form.traderUserId = cands.value[0].id;
        } catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      async function submit() {
        if (saving.value) return;
        if (!form.traderUserId) return App.notify.warn('请选择受托交易机构');
        if (!form.validTo) return App.notify.warn('请填写授权到期时间');
        saving.value = true;
        try {
          const r = await App.API.post('/mandate', {
            traderUserId: Number(form.traderUserId),
            scope: form.scope,
            maxAmount: form.maxAmount === '' ? null : Number(form.maxAmount),
            validTo: form.validTo.length === 10 ? form.validTo + 'T23:59:59' : form.validTo,
          });
          App.notify.ok(r.message || '授权已生效');
          form.maxAmount = ''; form.validTo = '';
          await load();
        } catch (e) { App.notify.err(e.message); } finally { saving.value = false; }
      }

      async function revoke(row) {
        const reason = prompt(`确认撤销对「${row.trader_org_name || row.trader_username}」的授权？\n可填写撤销原因（留空则记为"企业主动撤销"）：`);
        if (reason === null) return;
        try {
          await App.API.post(`/mandate/${row.id}/revoke`, { reason });
          App.notify.ok('授权已撤销');
          await load();
        } catch (e) { App.notify.err(e.message); }
      }

      const stat = computed(() => {
        const a = rows.value;
        return {
          active: a.filter((x) => x.effectiveStatus === 'ACTIVE').length,
          revoked: a.filter((x) => x.status === 'REVOKED').length,
          expired: a.filter((x) => x.effectiveStatus === 'EXPIRED').length,
        };
      });

      return () => {
        if (loading.value) return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '加载中…')]);
        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head' }, [
            h('div', {}, [
              h('h2', {}, '代理授权'),
              h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:760px' },
                '交易机构只有获得本企业签发的有效授权，才能代理本企业挂牌、撤单与清缴。'
                + '未授权的机构即使拿到交易端账号也无法操作——这是防止"越权代挂、擅自清缴"的核心机制。'
                + '授权与撤销动作均上链存证，不可否认。'),
            ]),
          ]),

          err.value && h('div', { class: 'alertbar err mb-12' }, err.value),

          /* 授权表单 */
          h('div', { class: 'card' }, [
            h('div', { class: 'card-head' }, [
              h('div', {}, [
                h('h3', {}, '签发新授权'),
                h('div', { class: 'sub' }, '授权范围与额度决定了交易机构能做什么'),
              ]),
            ]),
            h('div', { class: 'card-body' }, [
              h('div', { class: 'flex gap-12 wrap', style: 'align-items:flex-end' }, [
                h('div', { class: 'field', style: 'margin:0;width:240px' }, [
                  h('label', {}, '受托交易机构'),
                  h('select', {
                    class: 'select', value: form.traderUserId,
                    onChange: (e) => { form.traderUserId = e.target.value; },
                  }, cands.value.map((c) => {
                    /* 演示库存在多个同名交易机构（id 3/54/57）—— 下拉里三行
                     * 一模一样无法选（2026-10-31 巡检 P2-8）。重名时带机构号区分。 */
                    const dup = cands.value.filter((x) => x.name === c.name).length > 1;
                    return h('option', { value: c.id }, dup ? `${c.name}（机构 #${c.id}）` : c.name);
                  })),
                ]),
                h('div', { class: 'field', style: 'margin:0;width:170px' }, [
                  h('label', {}, '授权范围'),
                  h('select', {
                    class: 'select', value: form.scope,
                    onChange: (e) => { form.scope = e.target.value; },
                  }, [
                    h('option', { value: 'TRADE_ONLY' }, '仅交易（挂牌/撤单）'),
                    h('option', { value: 'TRADE_AND_OFFSET' }, '交易 + 清缴'),
                  ]),
                ]),
                h('div', { class: 'field', style: 'margin:0;width:150px' }, [
                  h('label', {}, '单笔额度上限 (t)'),
                  h('input', {
                    class: 'input', type: 'number', placeholder: '留空=不限',
                    value: form.maxAmount, onInput: (e) => { form.maxAmount = e.target.value; },
                  }),
                ]),
                h('div', { class: 'field', style: 'margin:0;width:170px' }, [
                  h('label', {}, '授权到期'),
                  h('input', {
                    class: 'input', type: 'date', value: form.validTo,
                    onInput: (e) => { form.validTo = e.target.value; },
                  }),
                ]),
                h('button', { class: 'btn primary', disabled: saving.value, onClick: submit },
                  saving.value ? '签发中…' : '签发授权'),
              ]),
              h('div', { style: 'font-size:11.6px;color:var(--tx-3);margin-top:10px' },
                '· 「仅交易」不允许清缴——清缴会真实减少配额，风险更高，需单独授权。'
                + ' · 额度上限按单笔校验，超出即拒绝。 · 授权最长 3 年。'),
            ]),
          ]),

          /* 授权列表 */
          h('div', { class: 'card mt-16' }, [
            h('div', { class: 'card-head' }, [
              h('div', {}, [
                h('h3', {}, `我的授权（有效 ${stat.value.active} / 已撤销 ${stat.value.revoked} / 已过期 ${stat.value.expired}）`),
              ]),
            ]),
            h('div', { class: 'card-body' }, [
              rows.value.length
              ? h('table', { class: 'tbl' }, [
                h('thead', {}, [h('tr', {}, ['#', '受托机构', '范围', '单笔上限', '有效期', '状态', '链上', '操作'].map((t) => h('th', {}, t)))]),
                h('tbody', {}, rows.value.map((r) => h('tr', {}, [
                  h('td', { style: 'font-family:var(--mono)' }, String(r.id)),
                  h('td', {}, r.trader_org_name || r.trader_username || ('#' + r.trader_user_id)),
                  h('td', {}, r.scopeCn || r.scope),
                  h('td', { style: 'font-family:var(--mono)' }, r.max_amount === null ? '不限' : String(r.max_amount)),
                  h('td', { style: 'font-size:11px' },
                    String(r.valid_from).slice(0, 10) + ' ~ ' + String(r.valid_to).slice(0, 10)),
                  h('td', {}, (() => {
                    const s = r.effectiveStatus;
                    const tone = s === 'ACTIVE' ? '#2e9e6b' : s === 'EXPIRED' ? '#c98a00' : '#c0392b';
                    const cn = s === 'ACTIVE' ? '有效' : s === 'EXPIRED' ? '已过期' : '已撤销';
                    return h('span', { style: 'color:' + tone + ';font-weight:600' }, cn);
                  })()),
                  h('td', { style: 'font-family:var(--mono);font-size:10.4px' },
                    r.chain_tx_id ? String(r.chain_tx_id).slice(0, 12) + '…' : '—'),
                  h('td', {}, r.effectiveStatus === 'ACTIVE'
                    ? h('button', { class: 'btn danger sm', onClick: () => revoke(r) }, '撤销')
                    : h('span', { class: 'tiny dim' }, '—')),
                ]))),
              ])
              : h('div', { class: 'empty' }, '尚未签发任何授权。交易机构在获得授权前无法代理本企业任何操作。'),
            ]),
          ]),
        ]);
      };
    },
  });

  /* ==================================================================
   * 监管端：授权台账
   * ================================================================== */
  App.views['page-reg-mandates'] = defineComponent({
    name: 'page-reg-mandates',
    setup() {
      const d = ref(null);
      const loading = ref(true);
      const err = ref('');
      const filter = reactive({ status: '' });

      async function load() {
        loading.value = true; err.value = '';
        try {
          const q = filter.status ? ('?status=' + filter.status) : '';
          d.value = await App.API.get('/mandate/ledger' + q);
        } catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      const statusCn = (r) => {
        const s = r.effectiveStatus || r.status;
        return s === 'ACTIVE' ? '有效' : s === 'EXPIRED' ? '已过期' : s === 'REVOKED' ? '已撤销' : s;
      };

      return () => {
        if (loading.value) return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '加载中…')]);
        if (err.value) return h('div', { class: 'page' }, [h('div', { class: 'alertbar err' }, err.value)]);
        const x = d.value || { rows: [], summary: {} };
        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head' }, [
            h('div', {}, [
              h('h2', {}, '代理授权台账'),
              h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:760px' },
                '监管视角的代理授权全景：谁授权给谁、范围与额度、期限是否有效、是否已撤销。'
                + '任何一笔代理交易都必须有对应的有效授权，否则系统在接口层直接拒绝。'),
            ]),
          ]),

          h('div', { class: 'flex gap-10 wrap mb-12' }, [
            ...[['', '全部'], ['ACTIVE', '有效'], ['REVOKED', '已撤销']].map(([v, t]) =>
              h('button', {
                class: ['btn', filter.status === v && 'primary'],
                onClick: () => { filter.status = v; load(); },
              }, t)),
          ]),

          h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px' }, [
            [['授权总数', x.summary.total], ['有效', x.summary.active], ['已过期', x.summary.expired], ['已撤销', x.summary.revoked]]
              .map(([label, val]) => h('div', { class: 'card' }, [
                h('div', { class: 'card-body', style: 'padding:12px 13px' }, [
                  h('div', { style: 'font-size:11.4px;color:var(--tx-3)' }, label),
                  h('div', { style: 'font-family:var(--mono);font-size:21px;margin-top:4px' }, String(val == null ? 0 : val)),
                ]),
              ])),
          ]),

          h('table', { class: 'tbl' }, [
            h('thead', {}, [h('tr', {}, ['#', '授权企业', '受托机构', '范围', '单笔上限', '有效期', '状态', '授权人', '链上'].map((t) => h('th', {}, t)))]),
            h('tbody', {}, (x.rows || []).map((r) => h('tr', {}, [
              h('td', { style: 'font-family:var(--mono)' }, String(r.id)),
              h('td', {}, r.ent_name || ('企业#' + r.ent_id)),
              h('td', {}, r.trader_org_name || r.trader_username || ('#' + r.trader_user_id)),
              h('td', {}, r.scopeCn || r.scope),
              h('td', { style: 'font-family:var(--mono)' }, r.max_amount === null ? '不限' : String(r.max_amount)),
              h('td', { style: 'font-size:11px' },
                String(r.valid_from).slice(0, 10) + ' ~ ' + String(r.valid_to).slice(0, 10)),
              h('td', {}, statusCn(r)),
              h('td', { style: 'font-size:11px' }, r.granted_by_name || ('#' + r.granted_by)),
              h('td', { style: 'font-family:var(--mono);font-size:10.4px' },
                r.chain_tx_id ? String(r.chain_tx_id).slice(0, 12) + '…' : '—'),
            ]))),
          ]),
          (x.rows || []).length === 0 && h('div', { class: 'empty' }, '暂无授权记录'),
        ]);
      };
    },
  });
})();
