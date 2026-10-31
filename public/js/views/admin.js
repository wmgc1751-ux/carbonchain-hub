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
      const err = ref('');
      const factors = ref([]);
      const versions = ref([]);
      /* 管理总览走自己的 /admin/overview：只要 5 个 KPI + 因子表，
         不再借监管端 /regulator/system（那要数 55 张表，本机 3 s+）。 */
      async function load() {
        err.value = '';
        try {
          const d = await App.API.request('GET', '/admin/overview');
          sys.value = d;
          factors.value = d.factors || [];
          versions.value = d.versions || [];
        } catch (e) {
          /* 失败必须有可见的落点：只弹 toast 会让页面永远停在骨架屏上，
             用户看到的是"一直在加载"，而不是"加载失败"。 */
          err.value = (e && e.message) || '总览数据加载失败';
          App.notify.err(err.value);
        }
      }
      onMounted(load);
      /* 生效版本按 status 取，不取 versions[0]：listVersions 按 effective_from 倒序，
       * 而现存 17 个版本里有 16 个的 effective_from 是同一秒 2026-01-01 00:00，
       * 并列时首行并不保证是生效版（实测首行是 v2026.1，但它靠的是 id 排序的巧合）。 */
      const activeVersion = Vue.computed(() =>
        versions.value.find((v) => v.status === 'ACTIVE') || null);
      /* 「最近发布」指链上锚点最大的那个版本，而不是时间最大的——
       * 时间字段全部并列，靠时间排序会随机命中。 */
      const latestAnchor = Vue.computed(() => {
        let best = null;
        for (const v of versions.value) {
          if (!v.chainBlockIndex) continue;
          if (!best || v.chainBlockIndex > best.chainBlockIndex) best = v;
        }
        return best;
      });
      /* 总览只回答两个问题：链是否可信、因子标准是否就位。
       * 明细各有专页（/reg/system、/admin/factors），这里只留结论与出口：
       * 原来把「链完整性自检」明细、「当前生效因子」全表、「因子版本历史」
       * 全表都铺在总览上，三块内容与专页完全同源，既重复又互相矛盾
       * （16/17 个版本的因子数取不到值，却在总览上列了 16 行）。 */
      return () => {
        const s = sys.value;
        return h('x-page', { title: '平台管理总览', desc: '链与因子的两条主线一屏可读；明细见各自专页' }, {
          actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          default: () => (err.value
            ? h('x-empty', { title: '总览数据加载失败', sub: err.value, tone: 'danger', retry: true, onRetry: () => load() })
            /* 【缺陷 P1-27】原来这里只有一个 height:220px 的灰条 —— 而 /admin/overview
             * 要跑一遍全链校验，本机首屏约 5 秒。5 秒里屏幕上一块灰,用户不知道
             * 是在加载还是已经卡死。改为按真实版式铺骨架屏（KPI×4 + 结论行 + 摘要行），
             * 加载完成时版面不会跳动。 */
            : !s ? h('div', { class: 'col gap-16' }, [
              h('x-skeleton', { type: 'kpi', rows: 4 }),
              h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [h('x-skeleton', { type: 'table', rows: 3 })])]),
              h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [h('x-skeleton', { type: 'table', rows: 2 })])]),
            ]) : [
            h('div', { class: 'grid g4 mb-16' }, [
              /* chain/stats 的 height 在链端离线时为 -1，直接上屏会与"链上存证 1,545 笔 /
               * 全链校验 1547 块"同屏自相矛盾 —— 负值按未取到处理，显示 —。 */
              h('x-kpi', { label: '链高度', value: s.chain.height >= 0 ? App.fmt.num(s.chain.height, 0) : '—', unit: s.chain.height >= 0 ? '块' : '', icon: 'chain', tone: 'carbon' }),
              h('x-kpi', { label: '链上存证', value: App.fmt.num(s.chain.confirmed, 0), unit: '笔', icon: 'block', tone: 'sky' }),
              h('x-kpi', { label: '因子条目', value: factors.value.length, unit: '项', icon: 'coin', tone: 'violet' }),
              h('x-kpi', { label: '因子版本', value: versions.value.length, unit: '个', icon: 'layers', tone: 'carbon' }),
            ]),
            /* 结论行 + 出口。共识、出块耗时、数据库、运行时长属于自检明细，
             * 归 /reg/system；这里只留「能不能信」这一个判断，外加一键跳转。 */
            h('div', { class: 'card mb-16' }, [h('div', { class: 'card-body col gap-8' }, [
              h('x-readout', { pass: s.validation.valid, label: '全链完整性校验', detail: s.validation.valid ? `校验 ${s.validation.checked} 块全部一致` : `${s.validation.errorCount} 处异常` }),
              h('div', { class: 'flex gap-8 wrap', style: 'align-items:center' }, [
                h('button', { class: 'btn sm', onClick: () => App.go('/reg/system') }, [h('x-icon', { name: 'db', size: 14 }), '查看系统与链自检']),
                h('span', { class: 'tiny dim' }, `${s.chain.consensus || 'POA'} · 出块均值 ${s.chain.avgMineTime} ms · ${s.runtime.db}`),
              ]),
            ])]),
            /* 因子摘要：条目数已在 KPI 里，这里补「生效的是哪一版、最近一次发布锚在哪个块」，
             * 全表归 /admin/factors。生效版本取 ACTIVE 行，而不是数组第一行——
             * listVersions 按 effective_from 倒序，同秒并列时首行不一定是生效版。
             * ⚠ 手写 render 函数里 computed 必须写 .value：直接读拿到的是 ref 对象，
             * 它会永远是 truthy，取值全是 undefined（表现为版本号空白、"#undefined"）。 */
            h('div', { class: 'card' }, [h('div', { class: 'card-body col gap-8' }, [
              h('div', { class: 'flex gap-8 wrap', style: 'align-items:center' }, [
                h('span', { class: 'k' }, '当前生效因子版本'),
                h('span', { class: 'mono' }, activeVersion.value ? activeVersion.value.version : '—'),
                h('span', { class: 'tiny dim' }, `共 ${factors.value.length} 项 · 最近发布 ${latestAnchor.value ? '#' + latestAnchor.value.chainBlockIndex : '—'}`),
              ]),
              h('div', { class: 'flex gap-8 wrap', style: 'align-items:center' }, [
                h('button', { class: 'btn sm', onClick: () => App.go('/admin/factors') }, [h('x-icon', { name: 'coin', size: 14 }), '进入因子库维护']),
                h('span', { class: 'tiny dim' }, '平台因子库 4 位小数；与「排放因子台账」的国标缺省值（8 位精度）同源'),
              ]),
            ])]),
          ]),
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
                { key: 'unit', title: '因子单位' },
                { key: 'scope', title: '范围', width: '80px' },
                { key: 'source', title: '出处' },
                { key: 'industry', title: '行业', width: '100px' },
                { key: 'version', title: '版本', width: '90px' },
                { key: 'status', title: '状态', width: '100px' },
                { key: '_act', title: '操作', width: '80px' },
              ],
              rows: factors.value,
            }, {
              'col-factor': ({ value }) => h('span', { class: 'mono' }, isFinite(+value) ? String(+value) : '—'),
              /* 同上：只显示分母会被误读成质量单位，补全为 tCO₂e/分母。 */
              'col-unit': ({ value }) => h('span', { class: 'mono' }, value ? 'tCO₂e/' + value : '—'),
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
              h('button', { class: 'btn primary', disabled: busy.value, onClick: save }, '保存'),
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
              h('button', { class: 'btn primary', disabled: busy.value, onClick: publish }, '发布并上链'),
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
      const stat = ref(null);
      const pending = ref([]);
      const busyId = ref(0);
      const q = ref('');
      const roleFilter = ref('');
      /* 【缺陷 P2-35】账号台账 30+ 行一页铺完，页面 2000px+。加客户端分页。 */
      const USER_PAGE_SIZE = 15;
      const page = ref(1);
      const pageRows = Vue.computed(() =>
        users.value.slice((page.value - 1) * USER_PAGE_SIZE, page.value * USER_PAGE_SIZE));
      const pageCount = Vue.computed(() => Math.max(1, Math.ceil(users.value.length / USER_PAGE_SIZE)));
      /* 【缺陷 P1-25】原来这页读的是 /auth/demo-accounts —— 那是**登录页用**的
       * 演示账号清单，只读、只有白名单里的 19 个账号、连 status 都不返回，
       * 所以页面上既没有操作列，也没法停用/重置口令。
       * 改走管理端自己的账号台账 /admin/users（全量账号 + 状态 + 岗位 + 最后登录）。 */
      async function load() {
        try {
          const r = await App.API.get('/admin/users', {
            ...(q.value.trim() ? { q: q.value.trim() } : {}),
            ...(roleFilter.value ? { role: roleFilter.value } : {}),
          });
          users.value = r.rows || [];
          stat.value = r;
          page.value = 1;   // 换筛选回第一页，避免停在超出范围的空页
        } catch (e) { users.value = []; stat.value = null; }
        try { pending.value = await App.API.request('GET', '/admin/verifier-registrations'); }
        catch (e) { pending.value = []; }
      }
      onMounted(load);

      async function toggleStatus(row) {
        const toEnable = row.status !== 1;
        const msg = toEnable
          ? `启用账号「${row.username}」（${row.realName || row.roleCn}）？启用后可正常登录。`
          : `停用账号「${row.username}」（${row.realName || row.roleCn}）？停用后该账号立即无法登录，已签发的令牌也会被拒绝。`;
        if (!(await App.confirm({ message: msg, danger: !toEnable }))) return;
        busyId.value = row.id;
        try {
          const r = await App.API.request('PATCH', `/admin/users/${row.id}`, { status: toEnable ? 1 : 2 });
          App.notify.ok(typeof r === 'string' ? r : (toEnable ? '已启用' : '已停用'));
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busyId.value = 0; }
      }

      async function resetPwd(row) {
        const msg = `把「${row.username}」的口令重置为平台演示口令？原口令立即失效。`;
        if (!(await App.confirm({ message: msg }))) return;
        busyId.value = row.id;
        try {
          const r = await App.API.request('POST', `/admin/users/${row.id}/reset-password`);
          App.notify.ok(`已重置：${row.username} 的口令为 ${r && r.password ? r.password : '演示口令'}`);
        } catch (e) { App.notify.err(e.message); }
        finally { busyId.value = 0; }
      }

      async function review(row, approve) {
        const action = approve
          ? `通过核查机构「${row.orgName}」的注册申请？通过后该机构账号即可登录开展核查业务。`
          : `驳回核查机构「${row.orgName}」的注册申请？注册记录将被清理。`;
        /* 2026-10-29：window.confirm 会同步阻塞主线程且样式与平台割裂，
         * 换成 core.js 的 Promise 化确认弹窗（其余视图均已接入） */
        if (!(await App.confirm({ message: action, danger: !approve }))) return;
        busyId.value = row.id;
        try {
          await App.API.request('POST', `/admin/verifier-registrations/${row.id}/review`, { approve });
          App.notify.ok(approve ? `已通过：${row.orgName} 机构账号开通` : `已驳回：${row.orgName} 注册记录已清理`);
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busyId.value = 0; }
      }
      return () => h('x-page', { title: '用户与权限', desc: '五类角色账号体系 · 机构注册审核准入 · CA 证书签发与吊销 · 联盟成员准入' }, {
        default: () => [
          pending.value.length > 0 && h('x-card', { title: `待审核查机构注册（${pending.value.length}）`, flush: true }, {
            default: () => h('x-table', {
              columns: [
                { key: 'username', title: '申请账号' },
                { key: 'realName', title: '联系人' },
                { key: 'orgName', title: '机构名称' },
                { key: 'phone', title: '联系电话' },
                { key: 'createdAt', title: '申请时间', width: '160px' },
                { key: 'op', title: '操作', width: '170px' },
              ],
              rows: pending.value,
              empty: '暂无待审核的机构注册',
            }, {
              'col-username': ({ value }) => h('span', { class: 'mono' }, value),
              'col-createdAt': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
              'col-op': ({ row }) => h('div', { style: 'display:flex;gap:6px' }, [
                h('button', {
                  class: 'btn sm primary', disabled: busyId.value === row.id,
                  onClick: () => review(row, true),
                }, '通过'),
                h('button', {
                  class: 'btn sm', disabled: busyId.value === row.id,
                  onClick: () => review(row, false),
                }, '驳回'),
              ]),
            }),
          }),
          /* KPI 用真实统计：原来 5 张卡全写死「已启用」，
           * 既不对应任何数据，也掩盖了"有几个账号被停用"这件事（缺陷 P1-25）。 */
          h('div', { class: 'grid g5 mb-16' }, ['ENTERPRISE', 'VERIFIER', 'REGULATOR', 'TRADER', 'ADMIN'].map((r) => {
            const b = (stat.value && stat.value.byRole && stat.value.byRole[r]) || { total: 0, active: 0 };
            return h('x-kpi', {
              label: App.DICT.role[r] || r,
              value: `${b.active}`, unit: `/ ${b.total} 个`,
              icon: 'users', tone: b.total === b.active ? 'carbon' : 'sky',
              foot: b.total ? (b.total === b.active ? '全部启用' : `另有 ${b.total - b.active} 个非启用`) : '暂无账号',
            });
          })),
          h('x-card', {
            title: '账号台账',
            sub: stat.value ? `共 ${stat.value.total} 个 · 启用 ${stat.value.active} · 停用 ${stat.value.suspended}${stat.value.pendingReview ? ` · 待审核 ${stat.value.pendingReview}` : ''}` : null,
            flush: true,
          }, {
            actions: () => h('div', { style: 'display:flex;gap:8px;align-items:center' }, [
              h('input', {
                class: 'input', style: 'width:200px', placeholder: '搜账号 / 姓名 / 组织',
                value: q.value,
                onInput: (e) => { q.value = e.target.value; },
                onKeydown: (e) => { if (e.key === 'Enter') load(); },
              }),
              h('select', {
                class: 'select', style: 'width:130px', value: roleFilter.value,
                onChange: (e) => { roleFilter.value = e.target.value; load(); },
              }, [['', '全部角色']].concat(['ENTERPRISE', 'VERIFIER', 'REGULATOR', 'TRADER', 'ADMIN']
                .map((r) => [r, App.DICT.role[r] || r])).map(([v, label]) => h('option', { value: v, selected: v === roleFilter.value }, label))),
              h('button', { class: 'btn sm', onClick: load }, '查询'),
            ]),
            default: () => [h('x-table', {
              columns: [
                { key: 'username', title: '账号' },
                { key: 'realName', title: '姓名' },
                { key: 'postCn', title: '岗位', width: '130px' },
                { key: 'roleCn', title: '角色', width: '110px' },
                { key: 'orgName', title: '组织' },
                { key: 'status', title: '状态', width: '90px' },
                { key: 'lastLogin', title: '最后登录', width: '160px' },
                { key: 'op', title: '操作', width: '160px' },
              ],
              rows: pageRows.value, empty: '没有匹配的账号',
            }, {
              'col-username': ({ row, value }) => h('span', {}, [
                h('span', { class: 'mono' }, value),
                row.isSelf ? h('span', { class: 'tiny dim', style: 'margin-left:6px' }, '（当前登录）') : null,
              ]),
              'col-postCn': ({ value }) => h('span', { class: value ? '' : 'dim' }, value || '未设岗位'),
              'col-orgName': ({ value }) => h('span', { class: 'tiny' }, value || '—'),
              'col-status': ({ value }) => h('span', {
                class: 'tag',
                style: value === 1
                  ? 'background:rgba(0,192,127,.14);color:#6ee7b7;border-color:rgba(0,192,127,.35)'
                  : (value === 0
                    ? 'background:rgba(250,173,20,.14);color:#fcd34d;border-color:rgba(250,173,20,.35)'
                    : 'background:rgba(244,63,94,.14);color:#fda4af;border-color:rgba(244,63,94,.35)'),
              }, value === 1 ? '启用' : value === 0 ? '待审核' : '停用'),
              'col-lastLogin': ({ value }) => h('span', { class: 'tiny' }, value ? App.fmt.dt(value) : '从未登录'),
              'col-op': ({ row }) => h('div', { style: 'display:flex;gap:6px' }, [
                row.status === 0
                  ? h('span', { class: 'tiny dim' }, '待审核')
                  : h('button', {
                    class: row.status === 1 ? 'btn sm' : 'btn sm primary',
                    disabled: busyId.value === row.id || (row.isSelf && row.status === 1),
                    title: row.isSelf && row.status === 1 ? '不能停用当前登录账号' : '',
                    onClick: () => toggleStatus(row),
                  }, row.status === 1 ? '停用' : '启用'),
                h('button', {
                  class: 'btn sm ghost', disabled: busyId.value === row.id,
                  onClick: () => resetPwd(row),
                }, '重置口令'),
              ]),
            }),
            /* 分页：30+ 行一页铺完会把页面拉到 2000px+（缺陷 P2-35） */
            pageCount.value > 1 ? h('x-pager', {
              page: page.value, pages: pageCount.value, total: users.value.length,
              size: USER_PAGE_SIZE, onChange: (p) => { page.value = p; },
            }) : null,
          ],
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
        actions: () => h('button', { class: 'btn sm primary', disabled: busy.value, onClick: run }, [h('x-icon', { name: 'refresh', size: 14 }), busy.value ? '对账中…' : '执行对账']),
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
