/* =====================================================================
   管理端 · 平台治理与基础设施
   A1 管理总览 / A2 因子库维护 / A3 用户与权限 / A4 对账中心
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, onMounted } = Vue;
  const h = App.h;

  /* ---------------- A1 管理总览 ---------------- */
  const PageAdminOverview = defineComponent({
    name: 'page-admin-overview',
    setup() {
      const sys = ref(null);
      const factors = ref([]);
      const versions = ref([]);
      async function load() {
        try {
          sys.value = await App.API.request('GET', '/regulator/system');
          factors.value = await App.API.request('GET', '/admin/factors');
          versions.value = await App.API.request('GET', '/admin/factor-versions');
        } catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);
      return () => {
        const s = sys.value;
        return h('x-page', { title: '平台管理总览', desc: '联盟治理 · 因子标准 · 一致性保障 · 运维监控' }, {
          actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          default: () => !s ? h('div', { class: 'skel', style: 'height:220px' }) : [
            h('div', { class: 'grid g4 mb-16' }, [
              h('x-kpi', { label: '链高度', value: s.chain.height, unit: '块', icon: 'chain', tone: 'carbon' }),
              h('x-kpi', { label: '链上存证', value: App.fmt.num(s.chain.confirmed, 0), unit: '笔', icon: 'block', tone: 'sky' }),
              h('x-kpi', { label: '因子条目', value: factors.value.length, unit: '项', icon: 'coin', tone: 'violet' }),
              h('x-kpi', { label: '因子版本', value: versions.value.length, unit: '个', icon: 'layers', tone: 'carbon' }),
            ]),
            h('x-card', { title: '链完整性自检', sub: '哈希链 / PoA 出块签名 / Merkle 根' }, {
              default: () => h('div', { class: 'col gap-8' }, [
                h('x-readout', { pass: s.validation.valid, label: '全链校验', detail: s.validation.valid ? `校验 ${s.validation.checked} 块全部一致` : `${s.validation.errorCount} 处异常` }),
                h('div', { class: 'kv' }, [
                  h('span', { class: 'k' }, '共识'), h('span', {}, s.chain.consensus || 'POA'),
                  h('span', { class: 'k' }, '出块均值'), h('span', {}, s.chain.avgMineTime + ' ms'),
                  h('span', { class: 'k' }, '数据库'), h('span', {}, s.runtime.db),
                  h('span', { class: 'k' }, '运行时长'), h('span', {}, Math.round(s.runtime.uptime / 60) + ' 分钟'),
                ]),
              ]),
            }),
            h('div', { class: 'grid g2 mb-16' }, [
              h('x-card', { title: '当前生效因子', flush: true }, {
                default: () => h('x-table', {
                  columns: [
                    { key: 'energyCn', title: '能源品种' },
                    { key: 'factor', title: '排放因子', align: 'right' },
                    { key: 'unit', title: '单位' },
                    { key: 'scope', title: '范围', width: '80px' },
                    { key: 'version', title: '版本', width: '90px' },
                  ],
                  rows: factors.value.slice(0, 12),
                }, {
                  'col-factor': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 6)),
                  'col-scope': ({ value }) => h('span', {}, value === 1 ? '直接' : '间接'),
                }),
              }),
              h('x-card', { title: '因子版本历史', flush: true }, {
                default: () => h('x-table', {
                  columns: [
                    { key: 'version', title: '版本', width: '100px' },
                    { key: 'factorCount', title: '因子数', align: 'right' },
                    { key: 'effectiveFrom', title: '生效时间', width: '150px' },
                    { key: 'status', title: '状态', width: '100px' },
                    { key: 'chainTxId', title: '链上存证', width: '110px' },
                  ],
                  rows: versions.value, empty: '暂无版本',
                }, {
                  'col-effectiveFrom': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                  'col-status': ({ row }) => h('x-tag', { dict: App.DICT.factorStatus, dictKey: row.status }),
                  'col-chainTxId': ({ row }) => row.chainBlockIndex ? h('x-chainbadge', { block: row.chainBlockIndex, hash: row.chainTxId }) : h('span', { class: 'dim' }, '-'),
                }),
              }),
            ]),
          ],
        });
      };
    },
  });

  /* ---------------- A2 因子库维护 ---------------- */
  const PageAdminFactors = defineComponent({
    name: 'page-admin-factors',
    setup() {
      const factors = ref([]);
      const versions = ref([]);
      const modal = ref(false);
      const pubModal = ref(false);
      const busy = ref(false);
      const form = reactive({ id: null, energyType: 'COAL', factor: '', unit: 'tCO2e/单位', scope: 1, source: '', industry: '', remark: '' });
      const pubForm = reactive({ version: '', effectiveFrom: '' });

      const ENERGY = { COAL: '原煤', COKE: '焦炭', GAS: '天然气', DIESEL: '柴油', FUEL_OIL: '燃料油', POWER: '电力', HEAT: '热力' };

      async function load() {
        try {
          factors.value = await App.API.request('GET', '/admin/factors');
          versions.value = await App.API.request('GET', '/admin/factor-versions');
        } catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);

      function add() {
        Object.assign(form, { id: null, energyType: 'COAL', factor: '', unit: 'tCO2e/单位', scope: 1, source: '', industry: '', remark: '' });
        modal.value = true;
      }
      function edit(f) {
        Object.assign(form, { id: f.id, energyType: f.energyType, factor: String(f.factor), unit: f.unit, scope: f.scope, source: f.source || '', industry: f.industry || '', remark: f.remark || '' });
        modal.value = true;
      }
      async function save() {
        busy.value = true;
        try {
          await App.API.request('POST', '/admin/factors', { ...form, factor: Number(form.factor), scope: Number(form.scope) });
          App.notify.ok('因子已保存');
          modal.value = false;
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      function openPublish() {
        const now = new Date();
        pubForm.version = 'v' + now.getFullYear() + '.' + (versions.value.length + 1);
        pubForm.effectiveFrom = App.fmt.d(now);
        pubModal.value = true;
      }
      async function publish() {
        busy.value = true;
        try {
          const r = await App.API.request('POST', '/admin/factors/publish', pubForm);
          App.notify.ok(`因子版本 ${r.version} 已发布并上链存证`);
          pubModal.value = false;
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      return () => h('x-page', { title: '因子库维护', desc: '排放因子 CRUD · 版本发布（旧版本只读，保证历史核算可复现）· 生效区间设置 · 对齐 GB/T 32150' }, {
        actions: () => h('div', { class: 'flex gap-8' }, [
          h('button', { class: 'btn sm', onClick: add }, [h('x-icon', { name: 'plus', size: 14 }), '新增因子']),
          h('button', { class: 'btn sm chain', onClick: openPublish }, [h('x-icon', { name: 'chain', size: 14 }), '发布新版本']),
        ]),
        default: () => [
          h('x-card', { title: '排放因子库', flush: true }, {
            default: () => h('x-table', {
              columns: [
                { key: 'energyCn', title: '能源品种' },
                { key: 'factor', title: '排放因子', align: 'right' },
                { key: 'unit', title: '单位' },
                { key: 'scope', title: '范围', width: '80px' },
                { key: 'source', title: '出处' },
                { key: 'industry', title: '行业', width: '100px' },
                { key: 'version', title: '版本', width: '90px' },
                { key: 'status', title: '状态', width: '100px' },
                { key: '_act', title: '操作', width: '80px' },
              ],
              rows: factors.value,
            }, {
              'col-factor': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 6)),
              'col-scope': ({ value }) => h('span', {}, value === 1 ? '直接' : '间接'),
              'col-status': ({ row }) => h('x-tag', { dict: App.DICT.factorStatus, dictKey: row.status }),
              'col-_act': ({ row }) => h('button', { class: 'btn sm', onClick: () => edit(row) }, '编辑'),
            }),
          }),
          modal.value && h('x-modal', { modelValue: modal.value, title: form.id ? '编辑因子' : '新增因子', 'onUpdate:modelValue': (v) => { modal.value = v; } }, {
            default: () => h('div', { class: 'col gap-12' }, [
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '能源品种'),
                h('select', { class: 'input', value: form.energyType, onChange: (e) => { form.energyType = e.target.value; } },
                  Object.keys(ENERGY).map((k) => h('option', { value: k }, ENERGY[k]))),
              ]),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '排放因子（tCO₂e/单位）'),
                h('input', { class: 'input', type: 'number', step: '0.0001', value: form.factor, onInput: (e) => { form.factor = e.target.value; } }),
              ]),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '核算范围'),
                h('select', { class: 'input', value: String(form.scope), onChange: (e) => { form.scope = Number(e.target.value); } }, [
                  h('option', { value: '1' }, 'Scope1 直接排放'), h('option', { value: '2' }, 'Scope2 间接排放'),
                ]),
              ]),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '出处'),
                h('input', { class: 'input', value: form.source, onInput: (e) => { form.source = e.target.value; }, placeholder: '如 国家温室气体排放核算指南' }),
              ]),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '适用行业（空为通用）'),
                h('input', { class: 'input', value: form.industry, onInput: (e) => { form.industry = e.target.value; }, placeholder: '如 化工' }),
              ]),
            ]),
            footer: () => [
              h('button', { class: 'btn', onClick: () => { modal.value = false; } }, '取消'),
              h('button', { class: 'btn primary', disabled: busy, onClick: save }, '保存'),
            ],
          }),
          pubModal.value && h('x-modal', { modelValue: pubModal.value, title: '发布因子版本', 'onUpdate:modelValue': (v) => { pubModal.value = v; } }, {
            default: () => h('div', { class: 'col gap-12' }, [
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '版本号'),
                h('input', { class: 'input', value: pubForm.version, onInput: (e) => { pubForm.version = e.target.value; } }),
              ]),
              h('div', { class: 'col gap-6' }, [
                h('label', { class: 'tiny dim' }, '生效时间'),
                h('input', { class: 'input', type: 'date', value: pubForm.effectiveFrom, onInput: (e) => { pubForm.effectiveFrom = e.target.value; } }),
              ]),
              h('div', { class: 'alertbar info' }, [h('x-icon', { name: 'info', size: 15 }), '发布后旧版本自动归档为只读，新版本哈希上链固化，保证历史核算可复现。']),
            ]),
            footer: () => [
              h('button', { class: 'btn', onClick: () => { pubModal.value = false; } }, '取消'),
              h('button', { class: 'btn primary', disabled: busy, onClick: publish }, '发布并上链'),
            ],
          }),
        ],
      });
    },
  });

  /* ---------------- A3 用户与权限 ---------------- */
  const PageAdminUsers = defineComponent({
    name: 'page-admin-users',
    setup() {
      const users = ref([]);
      async function load() {
        try { users.value = await App.API.request('GET', '/auth/demo-accounts'); }
        catch (e) { users.value = []; }
      }
      onMounted(load);
      return () => h('x-page', { title: '用户与权限', desc: '五类角色账号体系 · CA 证书签发与吊销 · 联盟成员准入' }, {
        default: () => [
          h('div', { class: 'grid g5 mb-16' }, ['ENTERPRISE', 'VERIFIER', 'REGULATOR', 'TRADER', 'ADMIN'].map((r) => h('x-kpi', {
            label: App.DICT.role[r] || r, value: '已启用', icon: 'users', tone: 'carbon',
          }))),
          h('x-card', { title: '演示账号', flush: true }, {
            default: () => h('x-table', {
              columns: [
                { key: 'username', title: '账号' },
                { key: 'realName', title: '姓名' },
                { key: 'roleCn', title: '角色', width: '120px' },
                { key: 'orgName', title: '组织' },
              ],
              rows: users.value, empty: '演示账号接口当前环境已关闭',
            }, {
              'col-username': ({ value }) => h('span', { class: 'mono' }, value),
            }),
          }),
        ],
      });
    },
  });

  /* ---------------- A4 对账中心 ---------------- */
  const PageAdminReconcile = defineComponent({
    name: 'page-admin-reconcile',
    setup() {
      const result = ref(null);
      const history = ref([]);
      const busy = ref(false);
      async function loadHistory() { try { history.value = await App.API.request('GET', '/admin/reconciliations'); } catch (e) {} }
      onMounted(loadHistory);
      async function run() {
        busy.value = true;
        try {
          result.value = await App.API.request('POST', '/admin/reconcile');
          App.notify.ok(result.value.inconsistent === 0 ? '对账完成，链上链下全部一致' : `发现 ${result.value.inconsistent} 条不一致`);
          await loadHistory();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }
      return () => h('x-page', { title: '对账中心', desc: '链上 ↔ 链下一致性保障 · 核对业务记录与链上 txid 映射 · 不一致记录修复工作流' }, {
        actions: () => h('button', { class: 'btn sm primary', disabled: busy, onClick: run }, [h('x-icon', { name: 'refresh', size: 14 }), busy ? '对账中…' : '执行对账']),
        default: () => [
          result.value && h('div', { class: 'grid g3 mb-16' }, [
            h('x-kpi', { label: '核对记录', value: App.fmt.num(result.value.total, 0), unit: '条', icon: 'db', tone: 'sky' }),
            h('x-kpi', { label: '不一致', value: App.fmt.num(result.value.inconsistent, 0), unit: '条', icon: 'alert', tone: result.value.inconsistent > 0 ? 'rose' : 'carbon' }),
            h('x-kpi', { label: '结论', value: result.value.inconsistent === 0 ? '全部一致' : '需修复', icon: 'check', tone: result.value.inconsistent === 0 ? 'carbon' : 'rose' }),
          ]),
          result.value && h('x-card', { title: '分表核对明细', flush: true }, {
            default: () => h('x-table', {
              columns: [
                { key: 'table', title: '业务表' },
                { key: 'anchored', title: '已锚定', align: 'right' },
                { key: 'matched', title: '链上命中', align: 'right' },
                { key: 'missing', title: '缺失', align: 'right' },
                { key: 'consistent', title: '一致', width: '80px' },
              ],
              rows: result.value.tables,
            }, {
              'col-missing': ({ value }) => h('span', { style: `color:${value > 0 ? '#fda4af' : '#6ee7b7'}` }, value),
              'col-consistent': ({ value }) => h('span', { class: value ? 't-ok' : 't-danger' }, value ? '✓' : '✗'),
            }),
          }),
          h('x-card', { title: '对账历史', flush: true }, {
            default: () => h('x-table', {
              columns: [
                { key: 'reconNo', title: '对账单号', width: '170px' },
                { key: 'totalRecords', title: '记录数', align: 'right' },
                { key: 'inconsistent', title: '不一致', align: 'right' },
                { key: 'createdAt', title: '时间', width: '160px' },
              ],
              rows: history.value, empty: '暂无对账记录',
            }, {
              'col-reconNo': ({ value }) => h('span', { class: 'mono' }, value),
              'col-inconsistent': ({ value }) => h('span', { style: `color:${value > 0 ? '#fda4af' : '#6ee7b7'}` }, value),
              'col-createdAt': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
            }),
          }),
        ],
      });
    },
  });

  Object.assign(App.views, {
    'page-admin-overview': PageAdminOverview,
    'page-admin-factors': PageAdminFactors,
    'page-admin-users': PageAdminUsers,
    'page-admin-reconcile': PageAdminReconcile,
  });
})();
