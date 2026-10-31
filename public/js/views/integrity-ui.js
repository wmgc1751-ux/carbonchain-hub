/* 企业端「成员与岗位」页 + 监管端「内控治理」页（P2）
 * 后端：/api/integrity/posts | /members | PATCH /members/:id
 *       /qualifications | /conflicts | /audit-anchor | /audit-anchors
 * 注意：本文件用原生 div.card（不用 x-card）——x-card 在部分视图里解析失败，
 * 原生结构样式完全等价且更可靠。 */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, h } = Vue;

  App.views = App.views || {};

  const card = (title, sub, children) => h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [
      h('div', {}, [
        h('h3', {}, title),
        sub && h('div', { class: 'sub' }, sub),
      ]),
    ]),
    h('div', { class: 'card-body' }, children),
  ]);

  /* ==================================================================
   * 企业端：成员与岗位（子角色拆分）
   * ================================================================== */
  App.views['page-ent-members'] = defineComponent({
    name: 'page-ent-members',
    setup() {
      const d = ref(null);
      const posts = ref([]);
      const loading = ref(true);
      const err = ref('');
      const saving = ref(false);
      const form = reactive({ username: '', password: '', realName: '', post: 'ENT_CLERK', certNo: '' });

      async function load() {
        loading.value = true; err.value = '';
        try {
          const [a, b] = await Promise.all([
            App.API.get('/integrity/members'),
            App.API.get('/integrity/posts'),
          ]);
          d.value = a;
          posts.value = (b || []).filter((p) => p.role_scope === 'ENTERPRISE');
        } catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      async function create() {
        if (saving.value) return;
        saving.value = true;
        try {
          const r = await App.API.post('/integrity/members', {
            username: form.username, password: form.password,
            realName: form.realName, post: form.post, certNo: form.certNo,
          });
          App.notify.ok(r.message || '子账号已创建');
          form.username = ''; form.password = ''; form.realName = '';
          await load();
        } catch (e) { App.notify.err(e.message); } finally { saving.value = false; }
      }

      async function setPost(row, post) {
        try {
          await App.API.request('PATCH', '/integrity/members/' + row.id, { post });
          App.notify.ok('岗位已调整');
          await load();
        } catch (e) { App.notify.err(e.message); }
      }

      async function toggle(row) {
        try {
          await App.API.request('PATCH', '/integrity/members/' + row.id, { status: row.status === 1 ? 0 : 1 });
          await load();
        } catch (e) { App.notify.err(e.message); }
      }

      return () => {
        if (loading.value) return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '加载中…')]);
        const x = d.value || { rows: [], canAdmin: false };
        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head' }, [
            h('div', {}, [
              h('h2', {}, '机构账号（单账号制）'),
              h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:760px' },
                '一个机构只有一个账号：填报、复核、清缴、授权、账号管理等职能全部整合在同一账号内，'
                + '跨端（企业/核查/监管/交易）同规则。每次操作都带操作人落审计日志并上链存证——'
                + '追责单位是"账号+时间+动作"，不再依赖岗位分设。'),
            ]),
          ]),
          err.value && h('div', { class: 'alertbar err mb-12' }, err.value),

          x.canAdmin && card('机构账号（唯一）', '填报 / 复核 / 清缴 / 授权 / 账号管理 —— 职能已全部整合，不再分设子账号', [
            h('div', { style: 'font-size:11.6px;color:var(--tx-3)' },
              '如需更换经办人：直接修改本账号的姓名与密码即可；历史操作已上链留痕，不随人员变动丢失。'),
          ]),

          h('div', { class: 'mt-16' }, [
            card('本机构账号（' + (x.rows || []).length + '）', null, [
              h('table', { class: 'tbl' }, [
                h('thead', {}, [h('tr', {}, ['#', '账号', '姓名', '岗位', '录入', '审核', '管账号', '状态', '操作'].map((t) => h('th', {}, t)))]),
                h('tbody', {}, (x.rows || []).map((r) => h('tr', {}, [
                  h('td', { style: 'font-family:var(--mono)' }, String(r.id)),
                  h('td', {}, r.username),
                  h('td', {}, r.real_name || '—'),
                  h('td', {}, r.post_label || h('span', { style: 'color:#c98a00' }, '未设岗位')),
                  h('td', {}, r.can_entry ? '✔' : '—'),
                  h('td', {}, r.can_review ? '✔' : '—'),
                  h('td', {}, r.can_admin ? '✔' : '—'),
                  h('td', { style: 'color:' + (r.status === 1 ? '#2e9e6b' : '#c0392b') }, r.statusCn || r.status),
                  h('td', {}, x.canAdmin
                    ? (r.id === x.selfId
                      ? h('span', { class: 'tiny dim' }, '本人')
                      : h('button', { class: 'btn sm', onClick: () => toggle(r) },
                        r.status === 1 ? '停用' : '启用'))
                    : '—'),
                ]))),
              ]),
            ]),
          ]),
        ]);
      };
    },
  });

  /* ==================================================================
   * 监管端：内控治理（资质冲突 + 审计锚定）
   * ================================================================== */
  App.views['page-reg-integrity'] = defineComponent({
    name: 'page-reg-integrity',
    setup() {
      const conf = ref(null);
      const quals = ref([]);
      const anchors = ref([]);
      const loading = ref(true);
      const err = ref('');
      const busy = ref(false);

      async function load() {
        loading.value = true; err.value = '';
        try {
          const [c, q, a] = await Promise.all([
            App.API.get('/integrity/conflicts'),
            App.API.get('/integrity/qualifications'),
            App.API.get('/integrity/audit-anchors'),
          ]);
          conf.value = c; quals.value = q || []; anchors.value = a || [];
        } catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      async function anchorNow() {
        if (busy.value) return;
        busy.value = true;
        try {
          const r = await App.API.post('/integrity/audit-anchor', { batchSize: 500 });
          App.notify.ok(r.message || '已锚定');
          await load();
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      return () => {
        if (loading.value) return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '加载中…')]);
        const c = conf.value || { rows: [], conflictCount: 0 };
        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head' }, [
            h('div', {}, [
              h('h2', {}, '内控治理'),
              h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:760px' },
                '两件事：① 资质互斥巡检——同一机构不得同时持有核查与交易代理资质（利益冲突）；'
                + '② 审计日志锚定——定期把日志批次做 Merkle 根上链，使日志本身事后无法被悄悄篡改。'),
            ]),
          ]),
          err.value && h('div', { class: 'alertbar err mb-12' }, err.value),

          card('资质冲突巡检', '扫描全库资质组合，发现互斥即告警',
            c.conflictCount > 0
              ? [h('div', { class: 'alertbar err mb-12' }, `发现 ${c.conflictCount} 个冲突机构`),
                 h('table', { class: 'tbl' }, [
                   h('thead', {}, [h('tr', {}, ['机构', '资质A', '资质B', '理由', '处置'].map((t) => h('th', {}, t)))]),
                   h('tbody', {}, c.rows.map((r) => h('tr', {}, [
                     h('td', {}, r.orgName), h('td', {}, r.qualA), h('td', {}, r.qualB),
                     h('td', { style: 'font-size:11px' }, r.reason), h('td', { style: 'font-size:11px' }, r.action),
                   ]))),
                 ])]
              : [h('div', { class: 'alertbar ok' }, `✔ 未发现资质冲突（巡检时间 ${String(c.scannedAt).slice(0, 19)}）`)]),

          h('div', { class: 'mt-16' }, [
            card('资质台账（' + quals.value.length + '）', '机构持有的核查/交易资质', [
              quals.value.length
                ? h('table', { class: 'tbl' }, [
                  h('thead', {}, [h('tr', {}, ['机构', '资质', '状态', '授予时间', '证明'].map((t) => h('th', {}, t)))]),
                  h('tbody', {}, quals.value.map((q) => h('tr', {}, [
                    h('td', {}, q.org_name), h('td', {}, q.qualCn || q.qual_type),
                    h('td', {}, q.status), h('td', { style: 'font-size:11px' }, String(q.granted_at).slice(0, 10)),
                    h('td', { style: 'font-size:11px' }, q.evidence || '—'),
                  ]))),
                ])
                : h('div', { class: 'empty' }, '尚无资质记录'),
            ]),
          ]),

          h('div', { class: 'mt-16' }, [
            card('审计日志锚定', '每批次计算 Merkle 根并上链，证明日志未被篡改', [
              h('div', { class: 'flex gap-10 mb-12' }, [
                h('button', { class: 'btn primary', disabled: busy.value, onClick: anchorNow },
                  busy.value ? '锚定中…' : '立即锚定一批'),
                h('span', { style: 'font-size:11.6px;color:var(--tx-3);align-self:center' },
                  '建议由定时任务每日执行一次'),
              ]),
              anchors.value.length
                ? h('table', { class: 'tbl' }, [
                  h('thead', {}, [h('tr', {}, ['ID 区间', '条数', 'Merkle 根', '区块', '时间'].map((t) => h('th', {}, t)))]),
                  h('tbody', {}, anchors.value.slice(0, 20).map((a) => h('tr', {}, [
                    h('td', { style: 'font-family:var(--mono);font-size:11px' }, `${a.from_id} ~ ${a.to_id}`),
                    h('td', { style: 'font-family:var(--mono)' }, String(a.row_count)),
                    h('td', { style: 'font-family:var(--mono);font-size:10.4px' }, String(a.merkle_root).slice(0, 16) + '…'),
                    h('td', { style: 'font-family:var(--mono)' }, String(a.block_index || '—')),
                    h('td', { style: 'font-size:11px' }, String(a.created_at).slice(0, 19)),
                  ]))),
                ])
                : h('div', { class: 'empty' }, '尚未锚定任何批次'),
            ]),
          ]),
        ]);
      };
    },
  });
})();

/* ==================================================================
 * 公示授权（企业端）
 * ================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, onMounted, h } = Vue;
  App.views = App.views || {};

  App.views['page-ent-disclosure'] = defineComponent({
    name: 'page-ent-disclosure',
    setup() {
      const d = ref(null);
      const loading = ref(true);
      const err = ref('');
      const busy = ref({});

      async function load() {
        loading.value = true; err.value = '';
        try { d.value = await App.API.get('/disclosure/consent'); }
        catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      onMounted(load);

      async function act(item, action) {
        if (busy.value[item]) return;
        busy.value[item] = true;
        try {
          const r = await App.API.post('/disclosure/consent', { item, action });
          App.notify.ok(r.message);
          await load();
        } catch (e) { App.notify.err(e.message); } finally { busy.value[item] = false; }
      }

      return () => {
        if (loading.value) return h('div', { class: 'page' }, [h('div', { class: 'empty' }, '加载中…')]);
        if (err.value) return h('div', { class: 'page' }, [h('div', { class: 'alertbar err' }, err.value)]);
        const x = d.value || { items: [], hint: '' };
        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head' }, [
            h('div', {}, [
              h('h2', {}, '公示授权'),
              h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:780px' },
                '公众页面只展示企业明确授权的公示项，且全部脱敏。'
                + '未授权的项一律不公示——这是授权范围的边界，不是功能开关。'
                + '授权与撤回即时生效，并上链留痕。'),
            ]),
          ]),

          h('div', { class: 'alertbar info mb-12' }, x.hint || ''),

          ...(x.items || []).map((it) => h('div', { class: 'card mb-12' }, [
            h('div', { class: 'card-head' }, [
              h('div', { style: 'flex:1' }, [
                h('h3', {}, it.label),
                h('div', { class: 'sub' }, it.detail),
              ]),
              h('div', { style: 'align-self:center;margin-left:12px' }, [
                (() => {
                  const granted = it.status === 'GRANTED';
                  return h('span', {
                    style: 'font-size:12px;font-weight:600;color:' + (granted ? '#2e9e6b' : '#8a90a0'),
                  }, granted ? '✔ 已授权公示' : '未授权（不公示）');
                })(),
              ]),
            ]),
            h('div', { class: 'card-body', style: 'padding-top:0' }, [
              h('div', { class: 'flex gap-10' }, [
                it.status === 'GRANTED'
                  ? h('button', { class: 'btn danger sm', disabled: !!busy.value[it.item], onClick: () => act(it.item, 'REVOKE') },
                    busy.value[it.item] ? '处理中…' : '撤回授权（公众页立即移除）')
                  : h('button', { class: 'btn primary sm', disabled: !!busy.value[it.item], onClick: () => act(it.item, 'GRANT') },
                    busy.value[it.item] ? '处理中…' : '授权公示（脱敏）'),
                it.grantedAt && h('span', { style: 'font-size:11.4px;color:var(--tx-3);align-self:center' },
                  '授权时间 ' + String(it.grantedAt).slice(0, 19)),
              ]),
            ]),
          ])),

          h('div', { class: 'alertbar warn mt-16' }, [
            h('b', {}, '为什么默认不公示：'),
            '企业数据使用授权书通常约定"研究、开发、数据接入演示、碳排放核算与学术竞赛"，'
            + '未明确包含"对外公示"。因此公示必须逐项取得企业授权，避免超出授权范围——这比多一个功能更重要。',
          ]),
        ]);
      };
    },
  });

  /* ==================================================================
   * 公众端：公示专区（无需登录）
   * ================================================================== */
  App.views['page-public-disclosure'] = defineComponent({
    name: 'page-public-disclosure',
    setup() {
      const tab = ref('VERIFY_RESULT');
      const d = ref(null);
      const loading = ref(false);
      const err = ref('');
      const TABS = [
        ['VERIFY_RESULT', '核查结论公示'],
        ['COMPLIANCE', '履约清缴公示'],
        ['EMISSION_RANK', '排放分档公示'],
      ];

      async function load() {
        loading.value = true; err.value = '';
        try { d.value = await App.API.get('/disclosure/public/' + tab.value); }
        catch (e) { err.value = e.message || String(e); }
        loading.value = false;
      }
      function sw(k) { tab.value = k; load(); }
      onMounted(load);

      return () => {
        const x = d.value || { rows: [], count: 0, disclaimer: '' };
        return h('div', { class: 'page' }, [
          h('div', { class: 'page-head' }, [
            h('div', {}, [
              h('h2', {}, '信息公示专区'),
              h('div', { style: 'font-size:12.4px;color:var(--tx-3);line-height:1.7;max-width:780px' },
                '这里只展示企业已授权公示的内容，且全部经过脱敏处理。'
                + '每一项数据都可在区块链浏览器中按交易号核验真伪。'),
            ]),
          ]),

          h('div', { class: 'flex gap-8 wrap mb-12' },
            TABS.map(([k, label]) => h('button', {
              class: ['btn', tab.value === k && 'primary'],
              onClick: () => sw(k),
            }, label))),

          err.value && h('div', { class: 'alertbar err mb-12' }, err.value),

          loading.value
            ? h('div', { class: 'empty' }, '加载中…')
            : (x.count === 0
              ? h('div', { class: 'card' }, [
                h('div', { class: 'card-body' }, [
                  h('div', { class: 'alertbar info' }, [
                    h('div', {}, [
                      h('b', {}, '当前没有企业授权公示本项。'),
                      h('div', { style: 'margin-top:6px' }, x.note || ''),
                    ]),
                  ]),
                ]),
              ])
              : h('div', { class: 'card' }, [
                h('div', { class: 'card-body' }, [
                  h('table', { class: 'tbl' }, [
                    h('thead', {}, [h('tr', {},
                      (tab.value === 'VERIFY_RESULT' ? ['企业', '行业', '报告期', '核查结论', '核查机构', '核查日期', '链上']
                        : tab.value === 'COMPLIANCE' ? ['企业', '行业', '年度', '履约状态']
                          : ['企业', '行业', '分档']).map((t) => h('th', {}, t)))]),
                    h('tbody', {}, x.rows.map((r) => {
                      if (tab.value === 'VERIFY_RESULT') {
                        return h('tr', {}, [h('td', {}, r.enterprise), h('td', {}, r.industry),
                          h('td', {}, r.period || '—'), h('td', {}, r.conclusion),
                          h('td', {}, r.verifier || '—'), h('td', {}, r.issueDate || '—'),
                          h('td', { style: 'font-family:var(--mono);font-size:10.4px' }, r.chainTxId || '—')]);
                      }
                      if (tab.value === 'COMPLIANCE') {
                        return h('tr', {}, [h('td', {}, r.enterprise), h('td', {}, r.industry),
                          h('td', {}, String(r.year)), h('td', {}, r.compliant)]);
                      }
                      return h('tr', {}, [h('td', {}, r.enterprise), h('td', {}, r.industry), h('td', {}, r.band)]);
                    })),
                  ]),
                ]),
              ])),

          x.disclaimer && h('div', { class: 'alertbar info mt-12' }, x.disclaimer),
        ]);
      };
    },
  });
})();
