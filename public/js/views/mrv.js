/* =====================================================================
   mrv.js —— MRV 生产作业流（监测 / 核算 / 核查）
   ---------------------------------------------------------------------
   这一组页面把平台从「看板」变成「能干活的工作台」：
     /mrv/activity   活动数据台账   企业按月填报 → 双人复核 → 缺口可见
     /mrv/calc       核算作业       一键核算 → 分源可核对 → 可复算校验
     /mrv/factor     因子台账       三要素复算明细（任何人不登录也能查）
     /mrv/compliance 履约与清缴     应缴/实缴/缺口/凭证/链上存证
     /mrv/cbam       CBAM 证书      8 步计算链 + 证书台账

   设计立场（与 uncertainty.js 一致）：
     · 缺口就画出来，不给"估算补充后算完整"；
     · 每个数字旁边给出它怎么来的（推导式 / 依据编号）；
     · 不能履约的理由必须写在页面上，而不是藏在日志里。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, reactive, onMounted, watch } = Vue;
  const h = App.h;

  const STYLE_ID = 'mrv-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
.mrv-steps{counter-reset:mrv}
.mrv-step{display:flex;gap:11px;padding:9px 0;border-bottom:1px solid var(--hair)}
.mrv-step:last-child{border-bottom:none}
.mrv-step .no{flex:none;width:20px;height:20px;border-radius:6px;background:rgba(16,185,129,.16);
  color:var(--ok-tx);font-family:var(--mono);font-size:11px;display:flex;align-items:center;justify-content:center;margin-top:1px}
.mrv-step .tt{font-size:12.6px;color:var(--tx-0);font-weight:500}
.mrv-step .fx{font-family:var(--mono);font-size:11.4px;color:var(--tx-3);margin-top:3px;word-break:break-all;line-height:1.65}
.mrv-step .vv{font-family:var(--mono);font-size:12px;color:var(--brand-l);margin-top:3px}
.mrv-warn{border-left:3px solid rgba(245,165,36,.55);padding:9px 12px;background:rgba(245,165,36,.06);
  border-radius:0 8px 8px 0;font-size:12.3px;line-height:1.75;color:var(--tx-1);margin-top:8px}
.mrv-bad{border-left:3px solid rgba(244,63,94,.55);padding:9px 12px;background:rgba(244,63,94,.06);
  border-radius:0 8px 8px 0;font-size:12.3px;line-height:1.75;color:var(--tx-1);margin-top:8px}
.mrv-ok{border-left:3px solid rgba(16,185,129,.5);padding:9px 12px;background:rgba(16,185,129,.05);
  border-radius:0 8px 8px 0;font-size:12.3px;line-height:1.75;color:var(--tx-1);margin-top:8px}
.mrv-mono{font-family:var(--mono);font-size:11.5px;color:var(--tx-2);word-break:break-all}
.mrv-tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.mrv-tab{padding:6px 13px;border-radius:8px;font-size:12.6px;cursor:pointer;color:var(--tx-2);
  background:var(--bg-1);border:1px solid var(--hair);transition:.15s}
.mrv-tab.on{background:rgba(16,185,129,.14);color:var(--ok-tx);border-color:rgba(16,185,129,.4)}
.mrv-tier{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:11px;
  padding:1.5px 7px;border-radius:5px}
.mrv-tier.L3{background:rgba(16,185,129,.16);color:var(--ok-tx)}
.mrv-tier.L2{background:rgba(6,182,212,.16);color:#67e8f9}
.mrv-tier.L1{background:rgba(245,165,36,.16);color:var(--warn-tx)}
.mrv-tier.L0{background:rgba(244,63,94,.16);color:var(--danger-tx)}
.mrv-miss{color:var(--danger-tx);font-family:var(--mono);font-size:11px}
.mrv-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.mrv-form label{display:block;font-size:11.6px;color:var(--tx-3);margin-bottom:4px}
.mrv-form input,.mrv-form select{width:100%;padding:6px 9px;border-radius:7px;font-size:12.4px;
  background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0)}
`;
    document.head.appendChild(el);
  }

  const num = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '—' : App.fmt.num(v, d);
  const pct = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '—' : (Number(v) * 100).toFixed(d) + '%';
  const tierTag = (t) => h('span', { class: 'mrv-tier ' + (t || 'L2') }, t || '—');

  /* 写操作的角色边界，必须与 server/routes/mrv.js 的 requireRole 一致。
   * 这三张 MRV 页面是跨角色共用的：企业端来干活，核查/监管端来复核。
   * 此前不区分角色，监管端打开 /reg/mrv/activity 会看到"填报/修正一条记录"
   * 表单，填完点保存必然收到 403 —— 界面允许的操作被服务端拒绝，
   * 比不显示按钮更糟。 */
  const role = () => (App.Store.user && App.Store.user.role) || '';
  /** 填报活动数据：仅企业（POST /mrv/activity 要求 ENTERPRISE） */
  const canEditActivity = () => role() === 'ENTERPRISE';
  /** 核算并落库：企业/管理/核查可写，监管端只读（POST /mrv/calc 的 requireRole） */
  const canWriteCalc = () => ['ENTERPRISE', 'ADMIN', 'VERIFIER'].includes(role());

  /** 企业选择器（非企业角色可见全部） */
  function useEntPicker() {
    const isEnt = role() === 'ENTERPRISE';
    const entId = ref(isEnt ? Number(App.Store.user.orgId) : null);
    const ents = ref([]);
    async function loadEnts() {
      if (isEnt) return;
      try {
        /* 企业名录走公开名录接口：/regulator/enterprises 只对 REGULATOR 开放，
           核查端/管理端打开同一页面会 403（实测 /ver/mrv/activity、/ver/mrv/calc）。 */
        const d = await App.API.get('/public/enterprises', { page: 1, size: 200 });
        ents.value = ((d && (d.rows || d)) || []).map((x) => ({ id: x.id, name: x.ent_name }));
        if (!entId.value && ents.value.length) entId.value = Number(ents.value[0].id);
      } catch (e) { ents.value = []; }
    }
    return { isEnt, entId, ents, loadEnts };
  }

  function entSelect(picker) {
    if (picker.isEnt) return null;
    return h('div', { style: 'min-width:220px' }, [
      h('label', { style: 'font-size:11.6px;color:var(--tx-3);display:block;margin-bottom:4px' }, '查看企业'),
      h('select', {
        value: picker.entId.value || '',
        onChange: (e) => { picker.entId.value = Number(e.target.value); },
        style: 'width:100%;padding:6px 9px;border-radius:7px;background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0);font-size:12.4px',
      }, picker.ents.value.map((x) => h('option', { value: x.id }, `${x.id} · ${x.name}`))),
    ]);
  }

  /* ==================================================================
   * 1. 活动数据台账
   * ================================================================== */
  const PageMrvActivity = defineComponent({
    name: 'page-mrv-activity',
    setup() {
      injectStyle();
      const picker = useEntPicker();
      const year = ref(new Date().getFullYear());
      const data = ref(null);
      const loading = ref(false);
      const err = ref('');
      const saving = ref(false);

      /* 录入表单 */
      const form = reactive({ month: new Date().getMonth() + 1, sourceCode: 'COAL', quantity: '', dataOrigin: 'L3', voucherNo: '', remark: '' });
      const editCode = ref('');

      async function load() {
        if (!picker.entId.value) return;
        loading.value = true; err.value = '';
        try {
          data.value = await App.API.get('/mrv/activity', { entId: picker.entId.value, year: year.value });
          /* 默认选中第一个有缺口的源，帮用户先补最要紧的那个 */
          const miss = data.value.missingMonths || {};
          const firstMiss = Object.keys(miss)[0];
          if (firstMiss) { form.sourceCode = firstMiss; form.month = miss[firstMiss][0]; }
        } catch (e) { err.value = e.message; data.value = null; }
        finally { loading.value = false; }
      }

      async function save() {
        if (!picker.entId.value) return;
        if (form.quantity === '' || !isFinite(Number(form.quantity))) { App.notify.err('请填写数量'); return; }
        saving.value = true;
        try {
          const r = await App.API.post('/mrv/activity', {
            entId: picker.entId.value, year: year.value, month: form.month,
            sourceCode: form.sourceCode, quantity: Number(form.quantity),
            dataOrigin: form.dataOrigin, voucherNo: form.voucherNo || undefined,
            remark: form.remark || undefined,
          });
          App.notify.ok(`已保存：${form.sourceCode} ${year.value}-${form.month} = ${form.quantity}`);
          if (r && r.hint) App.notify.warn(r.hint);
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { saving.value = false; }
      }

      onMounted(async () => { await picker.loadEnts(); await load(); });
      watch(() => picker.entId.value, load);

      const sum = computed(() => (data.value && data.value.summary) || {});

      return () => h('x-page', {
        title: '活动数据台账',
        desc: '核算的唯一输入：按月填报 → 双人复核 → 缺口可见。缺项不会被估算补齐，而是列为缺口。',
      }, {
        actions: () => [entSelect(picker), h('div', { style: 'min-width:110px' }, [
          h('label', { style: 'font-size:11.6px;color:var(--tx-3);display:block;margin-bottom:4px' }, '年度'),
          h('select', {
            value: year.value,
            onChange: (e) => { year.value = Number(e.target.value); },
            style: 'width:100%;padding:6px 9px;border-radius:7px;background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0);font-size:12.4px',
          }, [2025, 2026, 2027].map((y) => h('option', { value: y }, String(y)))),
        ]), h('button', { class: 'btn sm', onClick: load, disabled: loading.value }, '刷新')],
        default: () => {
          if (loading.value) return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, '加载中…')]);
          if (err.value) return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [h('div', { class: 'mrv-bad' }, err.value)])]);
          if (!data.value) return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, '请选择企业')]);

          const kpis = h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(168px,1fr));margin-bottom:14px' }, [
            h('x-kpi', { label: '记录数', value: String(data.value.count), sub: '条' }),
            h('x-kpi', { label: '覆盖月份', value: `${sum.value.coveredMonths || 0}/12`, sub: '满 12 月才构成完整年' }),
            h('x-kpi', { label: '待复核', value: String(sum.value.pendingReview || 0), sub: '条 SUBMITTED' }),
            h('x-kpi', { label: 'L0 缺省值', value: String(sum.value.l0Count || 0), sub: '占比 >1% 即不可履约' }),
          ]);

          /* 分源汇总表 */
          const srcRows = (data.value.bySource || []).map((s) => ({
            ...s,
            missing: (data.value.missingMonths || {})[s.sourceCode] || [],
          }));
          const srcTable = h('x-card', { title: '按排放源汇总' }, {
            default: () => h('x-table', {
              columns: [
                { key: 'sourceCode', title: '排放源', width: '140px' },
                { key: 'sourceType', title: '类型', width: '90px' },
                { key: 'total', title: '年度合计', align: 'right' },
                { key: 'unit', title: '单位', width: '70px' },
                { key: 'months', title: '已报月', align: 'right', width: '80px' },
                { key: 'missing', title: '缺报月份' },
              ],
              rows: srcRows,
              rowKey: 'sourceCode',
            }, {
              'col-sourceCode': ({ row }) => h('span', { class: 'mono' }, row.sourceCode),
              'col-sourceType': ({ row }) => h('span', { class: 'tag t-mute plain' }, row.sourceType),
              'col-total': ({ row }) => h('b', {}, num(row.total)),
              'col-months': ({ row }) => h('span', { class: row.months === 12 ? '' : 'mrv-miss' }, String(row.months)),
              'col-missing': ({ row }) => row.missing.length
                ? h('span', { class: 'mrv-miss' }, row.missing.join(','))
                : h('span', { class: 'dim' }, '无缺报'),
            }),
          });

          /* 录入表单 —— 仅企业端。监管/核查角色在这一页是"查数据、看缺口"，
           * 服务端 POST /mrv/activity 也只允许 ENTERPRISE，展示表单等于给出
           * 一个必然被 403 拒绝的入口。 */
          const formCard = canEditActivity() ? h('x-card', { title: '填报 / 修正一条记录' }, {
            default: () => h('div', { class: 'card-body' }, [
              h('div', { class: 'mrv-form' }, [
                h('div', {}, [h('label', {}, '排放源'), h('select', {
                  value: form.sourceCode,
                  onChange: (e) => { form.sourceCode = e.target.value; },
                }, ['COAL', 'COKE', 'GAS', 'DIESEL', 'FUEL_OIL', 'GASOLINE', 'LPG', 'COKE_OVEN_GAS', 'POWER', 'HEAT',
                  'CEMENT_CLINKER', 'ALU_ANODE', 'ALU_ANODE_EFFECT', 'AMMONIA_FEEDSTOCK', 'REFINERY_COKE_BURN']
                  .map((c) => h('option', { value: c }, c)))]),
                h('div', {}, [h('label', {}, '月份'), h('select', {
                  value: form.month,
                  onChange: (e) => { form.month = Number(e.target.value); },
                }, Array.from({ length: 12 }, (_, i) => h('option', { value: i + 1 }, `${i + 1} 月`)))]),
                h('div', {}, [h('label', {}, '数量'), h('input', {
                  type: 'number', step: '0.001', value: form.quantity,
                  onInput: (e) => { form.quantity = e.target.value; },
                })]),
                h('div', {}, [h('label', {}, '数据来源'), h('select', {
                  value: form.dataOrigin,
                  onChange: (e) => { form.dataOrigin = e.target.value; },
                }, [
                  h('option', { value: 'L3' }, 'L3 实测（计量+检定）'),
                  h('option', { value: 'L2' }, 'L2 台账（原始凭证）'),
                  h('option', { value: 'L1' }, 'L1 估算（需补录）'),
                  h('option', { value: 'L0' }, 'L0 缺省（不可履约）'),
                ])]),
                h('div', {}, [h('label', {}, '凭证号'), h('input', {
                  value: form.voucherNo, onInput: (e) => { form.voucherNo = e.target.value; },
                })]),
              ]),
              h('div', { style: 'display:flex;gap:8px;align-items:center' }, [
                h('button', { class: 'btn sm primary', onClick: save, disabled: saving.value },
                  saving.value ? '保存中…' : '保存并提交复核'),
                h('span', { class: 'tiny dim' }, '保存后状态为「已提交」，需核查端复核才计入核算'),
              ]),
              form.dataOrigin === 'L0'
                ? h('div', { class: 'mrv-warn' }, 'L0 = 活动数据缺失、按缺省值暂代。该记录会使整年不可用于履约（阈值 1%），请尽快补录原始凭证后改为 L2/L3。')
                : null,
            ]),
          }) : null;

          /* 明细表 */
          const detailTable = h('x-card', { title: `月度明细（${data.value.count} 条）` }, {
            default: () => h('x-table', {
              columns: [
                { key: 'month', title: '月', width: '56px', align: 'right' },
                { key: 'sourceCode', title: '排放源', width: '150px' },
                { key: 'quantity', title: '数量', align: 'right' },
                { key: 'unit', title: '单位', width: '70px' },
                { key: 'dataOrigin', title: '来源', width: '70px' },
                { key: 'voucherNo', title: '凭证号' },
                { key: 'status', title: '状态', width: '100px' },
              ],
              rows: data.value.records || [],
              rowKey: 'id',
            }, {
              'col-month': ({ row }) => h('span', { class: 'mono' }, String(row.month)),
              'col-sourceCode': ({ row }) => h('span', { class: 'mono' }, row.sourceCode),
              'col-quantity': ({ row }) => num(row.quantity, 3),
              'col-dataOrigin': ({ row }) => tierTag(row.dataOrigin),
              'col-voucherNo': ({ row }) => row.voucherNo ? h('span', { class: 'mono tiny' }, row.voucherNo) : h('span', { class: 'dim' }, '—'),
              'col-status': ({ row }) => h('span', {
                class: 'tag ' + (row.status === 'REVIEWED' ? 't-chain plain' : (row.status === 'REJECTED' ? 't-alert plain' : 't-warn plain')),
              }, row.status === 'REVIEWED' ? '已复核' : (row.status === 'REJECTED' ? '已驳回' : '待复核')),
            }),
          });

          return h('div', {}, [kpis, srcTable, formCard, detailTable]);
        },
      });
    },
  });

  /* ==================================================================
   * 2. 核算作业
   * ================================================================== */
  const PageMrvCalc = defineComponent({
    name: 'page-mrv-calc',
    setup() {
      injectStyle();
      const picker = useEntPicker();
      const year = ref(new Date().getFullYear());
      const preview = ref(null);
      const batch = ref(null);
      const verify = ref(null);
      const batches = ref([]);
      const busy = ref(false);
      const err = ref('');
      const tab = ref('overview');

      async function loadBatches() {
        if (!picker.entId.value) return;
        try {
          const d = await App.API.get('/mrv/calc/batches', { entId: picker.entId.value, year: year.value });
          batches.value = (d && d.items) || [];
        } catch (e) { batches.value = []; }
      }

      async function doPreview() {
        if (!picker.entId.value) return;
        busy.value = true; err.value = ''; batch.value = null; verify.value = null;
        try {
          preview.value = await App.API.post('/mrv/calc/preview', { entId: picker.entId.value, year: year.value });
          tab.value = 'overview';
        } catch (e) { err.value = e.message; preview.value = null; }
        finally { busy.value = false; }
      }

      async function doCalc() {
        if (!picker.entId.value) return;
        if (!(await App.confirm('将本次核算结果落库为一个核算批次？\n\n落库后该批次会计算输入/结果摘要，可用于事后复算校验。'))) return;
        busy.value = true;
        try {
          const r = await App.API.post('/mrv/calc', { entId: picker.entId.value, year: year.value });
          batch.value = r;
          App.notify.ok(`核算已落库：${r.batchNo}（${r.result.total} tCO₂e）`);
          await loadBatches();
          await doVerify(r.batchNo);
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      async function doVerify(batchNo) {
        const no = batchNo || (batch.value && batch.value.batchNo);
        if (!no) return;
        try { verify.value = await App.API.get(`/mrv/calc/batch/${no}/verify`); }
        catch (e) { verify.value = { ok: false, reason: e.message }; }
      }

      /* 2026-10-29（QA-P1-01）：核查端/监管端打开的是"复核核算批次"语境，
       * 此前挂载与企业切换时会自动跑一次正向 preview——对没有活动数据的企业
       * 必然收到 409 冲突，页面刚打开就弹红色报错。
       *
       * 2026-10-30 修正：完全关掉自动试算走过了头。监管/核查端进入本页后
       * "核算结果"标签页只剩一块红字「尚未试算」，必须先点一次按钮才有内容，
       * 而监管端连"重新试算"都不该点（那是企业侧的写操作入口）。实测
       * POST /mrv/calc/preview 对全部角色放开（纯试算、不落库、不改数据），
       * 因此复核语境也自动试算；失败（该企业本年度无活动数据）则静默切到
       * 批次列表——那里有已落库的历史批次可看，不需要弹红。 */
      const isVerifierReview = role() !== 'ENTERPRISE';
      async function previewOrFallback() {
        if (!picker.entId.value) return;
        await doPreview();
        if (!preview.value) { err.value = ''; tab.value = 'batch'; await loadBatches(); }
      }
      onMounted(async () => {
        await picker.loadEnts();
        if (!isVerifierReview) await loadBatches();
        await previewOrFallback();
      });
      watch(() => picker.entId.value, async () => {
        if (!isVerifierReview) await loadBatches();
        await previewOrFallback();
      });

      const p = computed(() => preview.value || {});

      function overviewTab() {
        if (!preview.value) {
          return h('div', { class: 'card' }, [
            h('div', { class: 'card-body' }, [
              h('div', { class: 'mrv-bad' }, err.value || '尚未试算'),
            ]),
          ]);
        }
        const u = p.value.uncertainty || {};
        const kpis = h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(172px,1fr));margin-bottom:14px' }, [
          h('x-kpi', { label: '排放总量', value: num(p.value.total, 1), sub: 'tCO₂e' }),
          h('x-kpi', { label: '范围一', value: num(p.value.scope1, 1), sub: 'tCO₂e · 直接' }),
          h('x-kpi', { label: '范围二', value: num(p.value.scope2, 1), sub: 'tCO₂e · 间接' }),
          h('x-kpi', { label: 'U95 相对', value: u.u95Rel ? pct(u.u95Rel, 2) : '—', sub: `k=${u.k || '—'}` }),
        ]);

        /* 完整性 / 可履约状态 —— 必须显眼 */
        const banner = p.value.complete
          ? h('div', { class: 'mrv-ok' }, `核算完整：${p.value.rows.length} 个排放源全部有数据，覆盖率 ${pct(p.value.coverageRatio, 0)}。`)
          : h('div', { class: 'mrv-bad' }, `核算不完整：缺 ${p.value.gapCount} 项。缺口如下：`
            + (p.value.gaps || []).map((g) => `${g.cn || g.code}（${g.msg}）`).join('；'));

        const usable = p.value.usableForCompliance
          ? h('div', { class: 'mrv-ok' }, `数据质量 ${p.value.quality.code}（${p.value.quality.reason}），可用于履约清缴。`)
          : h('div', { class: 'mrv-warn' }, `不可用于履约：${(p.value.notUsableReason || []).join('；')}`);

        /* 【2026-11-03】必须写清"这个数为什么与总览差几个量级"。
         * /ent/overview 的累计排放来自**上报单**（企业按季度申报的能源消耗），
         * 本页只算**活动数据台账**里已录入的明细。台账几乎空白时（实测易州恒新
         * 只有 1 条柴油 10t），本页 29.5 t 与总览 12.1 万 t 会并排出现，
         * 读者第一反应是"数据串了"。这里给出两处数字的来源与差额解释。 */
        const crossNote = h('div', {
          style: 'font-size:11.6px;color:var(--tx-3);line-height:1.7;padding:8px 12px;'
            + 'border-left:2px solid var(--hair);background:rgba(255,255,255,.02);border-radius:4px;margin-top:8px',
        }, [
          h('b', { style: 'color:var(--tx-2)' }, '与「企业总览」累计排放的口径差异：'),
          '总览的年度排放来自碳排放上报单（按季度申报的能源消耗），',
          '本页只汇总活动数据台账中已录入的月度明细。',
          '台账未录满时，本页数值会显著小于总览 —— 这是"未录入"，不是"未排放"。',
          '两处都只统计本企业；要补齐差额，请在「活动数据台账」按月录入。',
        ]);

        /* 分源明细 —— 一个总数变 N 条可核对推导 */
        const rowsCard = h('x-card', { title: '分源明细（逐项可核对）' }, {
          default: () => h('x-table', {
            columns: [
              { key: 'code', title: '排放源', width: '150px' },
              { key: 'scope', title: '范围', width: '60px', align: 'right' },
              { key: 'emission', title: '排放量', align: 'right' },
              { key: 'unit', title: '单位', width: '70px' },
              { key: 'ef', title: '因子', align: 'right', width: '100px' },
              { key: 'tier', title: '因子等级', width: '130px' },
              { key: 'dataOrigin', title: '数据', width: '70px' },
              { key: 'status', title: '状态', width: '100px' },
            ],
            rows: p.value.rows || [],
            rowKey: 'code',
          }, {
            'col-code': ({ row }) => h('span', { class: 'mono' }, row.code),
            'col-emission': ({ row }) => row.emission === null ? h('span', { class: 'mrv-miss' }, '未核算') : h('b', {}, num(row.emission, 3)),
            'col-unit': ({ row }) => h('span', { class: 'tiny dim' }, row.unit || ''),
            'col-ef': ({ row }) => row.ef === undefined ? h('span', { class: 'dim' }, '—') : num(row.ef, 6),
            'col-tier': ({ row }) => h('span', { class: 'tiny' }, row.tier || '—'),
            'col-dataOrigin': ({ row }) => tierTag(row.dataOrigin),
            'col-status': ({ row }) => h('span', { class: row.status === 'OK' ? 'tag t-chain plain' : 'tag t-alert plain' }, row.status),
          }),
        });

        /* 不确定度分解 */
        const uRow = (u.contributions || []).slice(0, 6);
        const uCard = uRow.length ? h('x-card', { title: '不确定度分量（贡献占比）' }, {
          default: () => h('div', { class: 'card-body' }, [
            h('div', { class: 'mrv-mono', style: 'margin-bottom:9px' }, u.formula || ''),
            ...uRow.map((c) => h('div', { style: 'display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--hair)' }, [
              h('span', { class: 'mono', style: 'width:150px;font-size:11.5px' }, c.key),
              h('div', { style: 'flex:1;height:6px;background:var(--bg-0);border-radius:3px;overflow:hidden' }, [
                h('div', { style: `height:100%;width:${Math.min(100, c.sharePct)}%;background:linear-gradient(90deg,#10b981,#06b6d4)` }),
              ]),
              h('span', { class: 'mono', style: 'width:60px;text-align:right;font-size:11.5px' }, c.sharePct + '%'),
              h('span', { class: 'tiny dim', style: 'width:120px;text-align:right' }, `u_rel ${(c.uRel * 100).toFixed(2)}%`),
            ])),
            u.dominant ? h('div', { class: 'tiny dim', style: 'margin-top:8px' },
              `主导分量：${u.dominant.key}（${u.dominant.sharePct}%）—— 降不确定度应优先从这里入手`) : null,
          ]),
        }) : null;

        /* 双路径互证 + 闸门 */
        const cv = u.crossValidation || {};
        const gate = u.priorGate || {};
        const checkCard = h('x-card', { title: '验证链（三路径 + 闸门）' }, {
          default: () => h('div', { class: 'card-body' }, [
            h('div', { class: 'mrv-step' }, [
              h('div', { class: 'no' }, '1'),
              h('div', {}, [
                h('div', { class: 'tt' }, `GUM 解析 vs 蒙特卡洛：${cv.verdict || '—'}`),
                h('div', { class: 'fx' }, cv.reason || ''),
                cv.checks ? h('div', { class: 'fx' }, cv.checks.map((c) => `${c.name} ${c.value}%（阈值 ${c.tol}%）${c.pass ? '✔' : '✘'}`).join('；')) : null,
              ]),
            ]),
            h('div', { class: 'mrv-step' }, [
              h('div', { class: 'no' }, '2'),
              h('div', {}, [
                h('div', { class: 'tt' }, `先验敏感性闸门：${gate.status || '—'}`),
                h('div', { class: 'fx' }, gate.reason || ''),
              ]),
            ]),
            h('div', { class: 'mrv-step' }, [
              h('div', { class: 'no' }, '3'),
              h('div', {}, [
                h('div', { class: 'tt' }, `区间是否可对外发布：${u.publishable ? '可发布' : '不可发布'}`),
                h('div', { class: 'fx' }, u.publishBlockReason || `95% 区间 [${num(u.interval && u.interval.low, 1)}, ${num(u.interval && u.interval.high, 1)}] tCO₂e`),
              ]),
            ]),
            h('div', { class: 'mrv-mono', style: 'margin-top:8px' },
              `输入摘要 ${String(p.value.inputDigest || '').slice(0, 32)}…　结果摘要 ${String(p.value.resultDigest || '').slice(0, 32)}…`),
          ]),
        });

        return h('div', {}, [kpis, h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [banner, usable, crossNote])]), rowsCard, uCard, checkCard]);
      }

      function verifyTab() {
        if (!verify.value) {
          return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, '尚未校验。先执行「核算并落库」，或从下方批次列表点「复算」。')]);
        }
        const v = verify.value;
        return h('div', {}, [
          h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [
            v.ok
              ? h('div', { class: 'mrv-ok' }, `可复现：${v.verdict}（${v.passed}/${v.total} 项通过）。同一输入重算得到逐位相同的摘要，这是"结果没被改过"的直接证据。`)
              : h('div', { class: 'mrv-bad' }, `不可复现：${v.verdict || v.reason}。可能原因：活动数据被改动、因子版本被替换、或核算引擎版本变了。`),
          ])]),
          h('x-card', { title: '逐项校验' }, {
            default: () => h('div', { class: 'card-body' }, (v.checks || []).map((c) => h('div', { class: 'mrv-step' }, [
              h('div', { class: 'no' }, c.pass ? '✓' : '✗'),
              h('div', {}, [h('div', { class: 'tt' }, c.name), h('div', { class: 'fx' }, c.detail || '')]),
            ]))),
          }),
        ]);
      }

      function batchTab() {
        return h('x-card', { title: '核算批次' }, {
          default: () => h('x-table', {
            columns: [
              { key: 'batchNo', title: '批次号' },
              { key: 'total', title: '排放量', align: 'right' },
              { key: 'complete', title: '完整', width: '70px' },
              { key: 'qualityTier', title: '质量', width: '64px' },
              { key: 'usableForCompliance', title: '可履约', width: '80px' },
              { key: 'u95Rel', title: 'U95', align: 'right', width: '80px' },
              { key: 'createdAt', title: '时间', width: '150px' },
              { key: 'act', title: '', width: '80px' },
            ],
            rows: batches.value,
            rowKey: 'batchNo',
            empty: '本年度尚无核算批次',
          }, {
            'col-batchNo': ({ row }) => h('span', { class: 'mono tiny' }, row.batchNo),
            'col-total': ({ row }) => num(row.total, 1),
            'col-complete': ({ row }) => h('span', { class: row.complete ? 'tag t-chain plain' : 'tag t-alert plain' }, row.complete ? '完整' : '有缺口'),
            'col-qualityTier': ({ row }) => h('span', { class: 'mono' }, row.qualityTier || '—'),
            'col-usableForCompliance': ({ row }) => row.usableForCompliance
              ? h('span', { class: 'tag t-chain plain' }, '可')
              : h('span', { class: 'tag t-mute plain' }, '否'),
            'col-u95Rel': ({ row }) => row.u95Rel ? pct(row.u95Rel, 2) : '—',
            'col-createdAt': ({ row }) => h('span', { class: 'tiny dim' }, String(row.createdAt || '').slice(0, 16)),
            'col-act': ({ row }) => h('button', {
              class: 'btn xs', onClick: () => doVerify(row.batchNo),
            }, '复算'),
          }),
        });
      }

      return () => h('x-page', {
        title: '核算作业',
        desc: '活动数据 → 正向核算（AD×EF）→ 分源明细 → 可复算摘要 → 双路径互证。配额不参与核算，只用于事后比对缺口。',
      }, {
        actions: () => [entSelect(picker),
          h('button', { class: 'btn sm', onClick: doPreview, disabled: busy.value }, busy.value ? '计算中…' : '重新试算'),
          /* 「核算并落库」是写操作，服务端只放行 ENTERPRISE/ADMIN/VERIFIER；
           * 监管端在这一页是复核语境（看历史批次、验摘要），不显示落库按钮。 */
          canWriteCalc()
            ? h('button', { class: 'btn sm primary', onClick: doCalc, disabled: busy.value || !preview.value }, '核算并落库')
            : null],
        default: () => {
          const tabs = h('div', { class: 'mrv-tabs' }, [
            ['overview', '核算结果'], ['verify', '可复算校验'], ['batch', '批次列表'],
          ].map(([k, label]) => h('div', {
            class: 'mrv-tab' + (tab.value === k ? ' on' : ''), onClick: () => { tab.value = k; if (k === 'batch') loadBatches(); },
          }, label)));

          let body;
          if (busy.value && !preview.value) body = h('div', { class: 'card' }, [h('div', { class: 'card-body' }, '核算中…')]);
          else if (tab.value === 'overview') body = overviewTab();
          else if (tab.value === 'verify') body = verifyTab();
          else body = batchTab();

          return h('div', {}, [tabs, body]);
        },
      });
    },
  });

  /* ==================================================================
   * 3. 因子台账（公开，无需登录）
   * ================================================================== */
  const PageMrvFactor = defineComponent({
    name: 'page-mrv-factor',
    setup() {
      injectStyle();
      const data = ref(null);
      const loading = ref(false);
      const err = ref('');
      const cat = ref('');

      async function load() {
        loading.value = true; err.value = '';
        try { data.value = await App.API.get('/mrv/factor', cat.value ? { category: cat.value } : {}); }
        catch (e) { err.value = e.message; }
        finally { loading.value = false; }
      }
      onMounted(load);

      return () => h('x-page', {
        title: '排放因子台账',
        desc: '每个因子都给出三要素（NCV/CC/OF）与文号出处，任何人不登录也能逐条复算。核算是科学，不是相信。',
      }, {
        actions: () => [
          h('select', {
            value: cat.value, onChange: (e) => { cat.value = e.target.value; load(); },
            style: 'padding:6px 9px;border-radius:7px;background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0);font-size:12.4px',
          }, [
            h('option', { value: '' }, '全部类别'),
            h('option', { value: 'FUEL' }, '燃料'),
            h('option', { value: 'POWER' }, '电力'),
            h('option', { value: 'HEAT' }, '热力'),
            h('option', { value: 'PROCESS' }, '工业过程'),
          ]),
          h('button', { class: 'btn sm', onClick: load }, '刷新'),
        ],
        default: () => {
          if (loading.value) return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, '加载中…')]);
          if (err.value) return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [h('div', { class: 'mrv-bad' }, err.value)])]);
          if (!data.value) return null;

          const rows = (data.value.items || []);
          const fuelRows = rows.filter((r) => r.derivation);
          const allOk = fuelRows.length > 0 && fuelRows.every((r) => r.derivation.ok);

          const banner = h('div', { class: allOk ? 'mrv-ok' : 'mrv-warn' },
            `共 ${rows.length} 条因子。其中 ${fuelRows.length} 条燃料因子带三要素，`
            + (allOk ? '全部通过独立复算（EF = NCV/1000 × CC × OF × 44/12），可被第三方逐条验证。'
              : '存在复算不通过的因子，请立即核查因子表 —— 这会直接导致所有核算结果错误。'));

          const table = h('x-card', { title: '因子清单' }, {
            default: () => h('x-table', {
              columns: [
                { key: 'code', title: '代码', width: '130px' },
                { key: 'nameCn', title: '名称', width: '150px' },
                { key: 'category', title: '类别', width: '80px' },
                { key: 'ef', title: '因子', align: 'right' },
                { key: 'efUnit', title: '单位', width: '70px' },
                { key: 'derivation', title: '三要素复算' },
                { key: 'region', title: '区域', width: '70px' },
              ],
              rows,
              rowKey: 'code',
              /* 【新增增强】因子台账的两个高频下游动作：
               *   ① 把某几条因子代码贴到核算表单里（原来只能一条条手抄）
               *   ② 导出当前清单做离线复核 / 归档
               * 未勾选时批量条不出现，表格外观与升级前一致。 */
              selectable: true,
              exportName: '排放因子台账',
            }, {
              /* 【新增增强】批量动作：复制已选因子的代码（逗号分隔，可直接粘贴） */
              bulk: ({ rows: picked }) => h('button', {
                class: 'btn sm',
                title: '复制已选因子的代码，可直接粘贴到核算表单',
                onClick: () => App.copyText(picked.map((r) => r.code).join(', ')),
              }, [h('x-icon', { name: 'copy', size: 14 }), '复制代码']),
              'col-code': ({ row }) => h('span', { class: 'mono tiny' }, row.code),
              'col-category': ({ row }) => h('span', { class: 'tag t-mute plain' }, row.category),
              'col-ef': ({ row }) => h('b', {}, num(row.ef, 6)),
              'col-derivation': ({ row }) => row.derivation
                ? h('div', {}, [
                  h('div', { class: 'mrv-mono' }, row.derivation.step),
                  h('div', { class: 'mrv-mono', style: 'color:' + (row.derivation.ok ? 'var(--ok-tx)' : 'var(--danger-tx)') },
                    `${row.derivation.ok ? '✔ 复算通过' : '✘ 复算不符'}（偏差 ${row.derivation.diff}）`),
                ])
                : h('span', { class: 'tiny dim' }, '间接/过程因子，无三要素'),
              'col-region': ({ row }) => row.region ? h('span', { class: 'tiny' }, row.region) : h('span', { class: 'dim' }, '全国'),
            }),
          });

          const stdCard = h('x-card', { title: '方法学依据' }, {
            default: () => h('div', { class: 'card-body' }, [
              h('div', { class: 'mrv-mono', style: 'margin-bottom:8px' }, '计算法：' + (data.value.methodology.formulas.calc || '')),
              h('div', { class: 'mrv-mono', style: 'margin-bottom:8px' }, '在线监测法：' + (data.value.methodology.formulas.cems || '')),
              h('div', { class: 'mrv-mono', style: 'margin-bottom:12px' }, '一致性判据：' + (data.value.methodology.formulas.consistency || '')),
              ...(data.value.methodology.standards || []).map((s) =>
                h('div', { style: 'font-size:12.2px;color:var(--tx-2);padding:3px 0' }, '· ' + s)),
            ]),
          });

          return h('div', {}, [h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [banner])]), table, stdCard]);
        },
      });
    },
  });

  /* ==================================================================
   * 4. 履约与清缴
   * ================================================================== */
  const PageMrvCompliance = defineComponent({
    name: 'page-mrv-compliance',
    setup() {
      injectStyle();
      const picker = useEntPicker();
      const year = ref(new Date().getFullYear());
      const st = ref(null);
      const list = ref([]);
      const busy = ref(false);
      const err = ref('');

      async function load() {
        if (!picker.entId.value) return;
        err.value = '';
        try {
          const [s, l] = await Promise.all([
            App.API.get('/settlement/surrender/status', { entId: picker.entId.value, year: year.value }),
            App.API.get('/settlement/surrender', { entId: picker.entId.value, year: year.value }).catch(() => ({ items: [] })),
          ]);
          st.value = s; list.value = (l && l.items) || [];
        } catch (e) { err.value = e.message; st.value = null; }
      }

      async function prepare() {
        busy.value = true;
        try {
          const r = await App.API.post('/settlement/surrender/prepare', { entId: picker.entId.value, year: year.value });
          App.notify.ok(r.alreadySurrendered
            ? `本年度已完成清缴（${r.certificateNo || '已出具凭证'}）`
            : `清缴单已生成：应缴 ${num(r.requiredQuota, 3)} t，可用 ${num(r.availableQuota, 3)} t`
              + (r.willShortfall > 0 ? `，缺口 ${num(r.willShortfall, 3)} t` : ''));
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      async function execute() {
        const pending = list.value.find((x) => x.status === 'PENDING');
        if (!pending) { App.notify.err('没有待执行的清缴单，请先「生成清缴单」'); return; }
        const shortfallWarn = pending.shortfall > 0 ? `\n\n⚠ 该单存在缺口，将按缺口清缴并计罚款。` : '';
        if (!(await App.confirm(`确认执行清缴 ${pending.surrenderNo}？\n\n将从可用配额中扣减 ${num(pending.requiredQuota, 3)} tCO₂e，并上链存证。${shortfallWarn}`))) return;
        busy.value = true;
        try {
          const r = await App.API.post('/settlement/surrender/execute', {
            surrenderNo: pending.surrenderNo, allowShortfall: true,
          });
          App.notify.ok(`清缴完成：${r.status}，实缴 ${num(r.surrendered, 3)} t，凭证 ${r.certificateNo || '—'}`);
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      onMounted(async () => { await picker.loadEnts(); await load(); });
      watch(() => picker.entId.value, load);

      return () => h('x-page', {
        title: '履约与清缴',
        desc: '碳市场闭环的最后一环：核定排放 → 扣抵销 → 应缴配额 → 实际清缴 → 出具凭证 → 上链存证。配额若不消耗，碳价就没有意义。',
      }, {
        actions: () => [entSelect(picker),
          h('button', { class: 'btn sm', onClick: prepare, disabled: busy.value }, '生成清缴单'),
          h('button', { class: 'btn sm primary', onClick: execute, disabled: busy.value }, '执行清缴')],
        default: () => {
          if (err.value) return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [h('div', { class: 'mrv-bad' }, err.value)])]);
          if (!st.value) return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, '加载中…')]);

          const a = st.value.assessment || {};
          const eb = st.value.emissionBasis || {};
          const q = st.value.quota || {};
          const off = st.value.offset || {};
          const s = st.value.surrender;

          const stateMap = {
            COMPLIANT: ['t-chain', '已足额清缴'],
            SHORTFALL: ['t-alert', '按缺口清缴'],
            PARTIAL: ['t-warn', '清缴不足'],
            NOT_SURRENDERED: ['t-warn', '尚未清缴'],
            NO_BASIS: ['t-mute', '无排放依据'],
          };
          const [cls, label] = stateMap[a.state] || ['t-mute', a.state || '—'];

          const kpis = h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(168px,1fr));margin-bottom:14px' }, [
            h('x-kpi', { label: '核定排放', value: num(eb.value, 1), sub: eb.source === 'VERIFY_REPORT' ? '核查报告认定值' : '平台核算值' }),
            h('x-kpi', { label: '已抵销', value: num(off.usedForYear, 1), sub: 'tCO₂e · 碳信用' }),
            h('x-kpi', { label: '可用配额', value: num(q.available, 1), sub: `已分配 ${num(q.allocated, 1)}` }),
            h('x-kpi', { label: '缺口', value: num(a.gap, 1), sub: a.riskLevel || '' }),
          ]);

          const stateCard = h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [
            h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' }, [
              h('span', { class: 'tag ' + cls + ' plain' }, label),
              h('span', { class: 'tiny dim' }, `${year.value} 年度 · ${eb.basisStrength || (eb.available === false ? '无依据' : '')}`),
            ]),
            eb.conflict ? h('div', { class: 'mrv-warn' }, eb.conflictDetail) : null,
            eb.available === false ? h('div', { class: 'mrv-bad' }, eb.reason || '无排放依据，无法清缴。') : null,
            a.note ? h('div', { class: 'mrv-ok' }, a.note) : null,
          ])]);

          const sCard = s ? h('x-card', { title: '清缴单' }, {
            default: () => h('div', { class: 'card-body' }, [
              h('div', { class: 'mrv-step' }, [h('div', { class: 'no' }, '1'), h('div', {}, [
                h('div', { class: 'tt' }, '应缴配额'), h('div', { class: 'fx' }, `核定排放 − 已抵销 = ${num(s.required, 3)} tCO₂e`),
              ])]),
              h('div', { class: 'mrv-step' }, [h('div', { class: 'no' }, '2'), h('div', {}, [
                h('div', { class: 'tt' }, '实际清缴'), h('div', { class: 'fx' }, `${num(s.surrendered, 3)} tCO₂e，状态 ${s.status}`),
              ])]),
              s.shortfall > 0 ? h('div', { class: 'mrv-step' }, [h('div', { class: 'no' }, '3'), h('div', {}, [
                h('div', { class: 'tt' }, '缺口与罚款'),
                h('div', { class: 'fx' }, `缺口 ${num(s.shortfall, 3)} tCO₂e，罚款 ${num(s.penalty, 2)} 元`),
              ])]) : null,
              s.certificateNo ? h('div', { class: 'mrv-step' }, [h('div', { class: 'no' }, '✓'), h('div', {}, [
                h('div', { class: 'tt' }, '清缴凭证'), h('div', { class: 'fx' }, s.certificateNo),
              ])]) : null,
              s.chain && s.chain.blockIndex ? h('div', { class: 'mrv-mono', style: 'margin-top:8px' },
                `链上存证：区块 #${s.chain.blockIndex}　tx ${String(s.chain.txId || '').slice(0, 24)}…`) : null,
            ]),
          }) : null;

          const listCard = list.value.length ? h('x-card', { title: '清缴记录' }, {
            default: () => h('x-table', {
              columns: [
                { key: 'surrenderNo', title: '清缴单号' },
                { key: 'requiredQuota', title: '应缴', align: 'right' },
                { key: 'surrenderedQuota', title: '实缴', align: 'right' },
                { key: 'shortfall', title: '缺口', align: 'right' },
                { key: 'status', title: '状态', width: '110px' },
                { key: 'certificateNo', title: '凭证', width: '150px' },
              ],
              rows: list.value,
              rowKey: 'surrenderNo',
            }, {
              'col-surrenderNo': ({ row }) => h('span', { class: 'mono tiny' }, row.surrenderNo),
              'col-requiredQuota': ({ row }) => num(row.requiredQuota, 2),
              'col-surrenderedQuota': ({ row }) => num(row.surrenderedQuota, 2),
              'col-shortfall': ({ row }) => Number(row.shortfall) > 0 ? h('span', { class: 'mrv-miss' }, num(row.shortfall, 2)) : '0',
              'col-status': ({ row }) => h('span', {
                class: 'tag ' + (row.status === 'SURRENDERED' || row.status === 'CERTIFIED' ? 't-chain plain' : 'tag t-warn plain'),
              }, row.status),
              'col-certificateNo': ({ row }) => row.certificateNo ? h('span', { class: 'mono tiny' }, row.certificateNo) : h('span', { class: 'dim' }, '—'),
            }),
          }) : null;

          return h('div', {}, [kpis, stateCard, sCard, listCard]);
        },
      });
    },
  });

  /* ==================================================================
   * 5. CBAM 证书
   * ================================================================== */
  const PageMrvCbam = defineComponent({
    name: 'page-mrv-cbam',
    setup() {
      injectStyle();
      const picker = useEntPicker();
      const year = ref(new Date().getFullYear());
      const cnCode = ref('76011000');
      const qty = ref('');
      const originPaid = ref('');
      const calc = ref(null);
      const certs = ref([]);
      const busy = ref(false);
      const factorTable = ref(null);

      const PRODUCTS = [
        ['72083900', '热轧板卷（钢铁）'], ['72149100', '型钢棒材（钢铁）'],
        ['76011000', '未锻轧铝'], ['76061200', '铝板带'],
        ['25231000', '水泥熟料'], ['25232900', '硅酸盐水泥'],
        ['31021000', '氮肥（尿素）'], ['27160000', '电力'],
      ];

      async function loadCerts() {
        if (!picker.entId.value) return;
        try {
          const d = await App.API.get('/settlement/cbam/certificates', { entId: picker.entId.value, year: year.value });
          certs.value = (d && d.items) || [];
        } catch (e) { certs.value = []; }
      }

      async function doCalc() {
        if (!qty.value || !isFinite(Number(qty.value))) { App.notify.err('请填写申报数量'); return; }
        busy.value = true;
        try {
          calc.value = await App.API.post('/settlement/cbam/calculate', {
            entId: picker.entId.value, year: year.value, cnCode: cnCode.value,
            quantity: Number(qty.value),
            originCarbonPriceCny: originPaid.value ? Number(originPaid.value) : undefined,
          });
        } catch (e) { App.notify.err(e.message); calc.value = null; }
        finally { busy.value = false; }
      }

      async function issue() {
        if (!calc.value) return;
        if (!(await App.confirm(`生成 CBAM 证书并上链？\n\n应缴排放 ${num(calc.value.payableEmission, 3)} tCO₂e\n净应付 ${num(calc.value.netPayableCny, 2)} 元`))) return;
        busy.value = true;
        try {
          const r = await App.API.post('/settlement/cbam/certificate', {
            entId: picker.entId.value, year: year.value, cnCode: cnCode.value,
            quantity: Number(qty.value), originCarbonPriceCny: originPaid.value ? Number(originPaid.value) : undefined,
          });
          App.notify.ok(`证书已生成：${r.certNo}`);
          await loadCerts();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      onMounted(async () => {
        await picker.loadEnts();
        factorTable.value = await App.API.get('/settlement/cbam/factor').catch(() => null);
        await loadCerts();
      });
      watch(() => picker.entId.value, loadCerts);

      return () => h('x-page', {
        title: 'CBAM 证书',
        desc: 'CBAM 的商业核心不是报表，而是证书：应缴排放 = 内含排放 − 免费配额×递减系数；金额 = 应缴 × EUA 价 × 汇率 − 原产国已付碳价。',
      }, {
        actions: () => entSelect(picker),
        default: () => {
          const formCard = h('x-card', { title: '证书测算' }, {
            default: () => h('div', { class: 'card-body' }, [
              h('div', { class: 'mrv-form' }, [
                h('div', {}, [h('label', {}, '商品（CN Code）'), h('select', {
                  value: cnCode.value, onChange: (e) => { cnCode.value = e.target.value; },
                }, PRODUCTS.map(([c, n]) => h('option', { value: c }, `${c} ${n}`)))]),
                h('div', {}, [h('label', {}, '申报数量'), h('input', {
                  type: 'number', step: '1', value: qty.value, placeholder: '如 50000',
                  onInput: (e) => { qty.value = e.target.value; },
                })]),
                h('div', {}, [h('label', {}, '原产国已付碳价（元）'), h('input', {
                  type: 'number', step: '1', value: originPaid.value, placeholder: '可空',
                  onInput: (e) => { originPaid.value = e.target.value; },
                })]),
                h('div', { style: 'display:flex;align-items:flex-end;gap:8px' }, [
                  h('button', { class: 'btn sm primary', onClick: doCalc, disabled: busy.value }, busy.value ? '计算中…' : '测算'),
                  calc.value ? h('button', { class: 'btn sm', onClick: issue }, '生成证书') : null,
                ]),
              ]),
              factorTable.value && factorTable.value.schedule
                ? h('div', { style: 'margin-top:10px' }, [
                  h('div', { class: 'tiny dim', style: 'margin-bottom:5px' }, 'CBAM 免费配额退坡系数（EU 2023/956 Art.10a 阶梯表，2034 年起归零）：'),
                  h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, factorTable.value.schedule.map((s) =>
                    h('span', {
                      class: 'mrv-tier', style: s.year === year.value ? 'background:rgba(16,185,129,.24);color:var(--ok-tx)' : 'background:var(--bg-0);color:var(--tx-3)',
                    }, `${s.year}: ${(s.factor * 100).toFixed(1)}%`))),
                ]) : null,
            ]),
          });

          let resultCard = null;
          if (calc.value) {
            const c = calc.value;
            resultCard = h('div', {}, [
              h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(168px,1fr));margin-bottom:14px' }, [
                h('x-kpi', { label: '内含排放', value: num(c.embeddedTotal, 1), sub: `强度 ${num(c.embeddedIntensity, 4)} ${c.embeddedIntensityUnit}` }),
                h('x-kpi', { label: '免费配额', value: num(c.freeAllocation, 1), sub: `系数 ${c.cbamFactor}` }),
                h('x-kpi', { label: '应缴排放', value: num(c.payableEmission, 1), sub: `${c.certificateCount} 张证书` }),
                h('x-kpi', { label: '净应付', value: num(c.netPayableCny, 0), sub: '元' }),
              ]),
              h('x-card', { title: '计算链（逐步可复核）' }, {
                default: () => h('div', { class: 'card-body' }, c.steps.map((s) => h('div', { class: 'mrv-step' }, [
                  h('div', { class: 'no' }, String(s.step)),
                  h('div', {}, [
                    h('div', { class: 'tt' }, `${s.name} = ${num(s.value, 3)} ${s.unit || ''}`),
                    h('div', { class: 'fx' }, s.formula || ''),
                    s.note ? h('div', { class: 'fx', style: 'color:var(--tx-3)' }, '注：' + s.note) : null,
                  ]),
                ]))),
              }),
              c.limitations && c.limitations.length
                ? h('div', { class: 'card' }, [h('div', { class: 'card-body' }, [
                  h('div', { class: 'tiny', style: 'color:var(--warn-tx);margin-bottom:6px' }, `⚠ 本测算的局限（${c.limitations.length} 条，必须一并阅读）`),
                  ...c.limitations.map((l) => h('div', { class: 'fx', style: 'color:var(--tx-2);line-height:1.7;padding:2px 0' }, '· ' + l)),
                ])]) : null,
            ]);
          }

          const certCard = certs.value.length ? h('x-card', { title: '证书台账' }, {
            default: () => h('x-table', {
              columns: [
                { key: 'certNo', title: '证书号' },
                { key: 'payableEmission', title: '应缴(t)', align: 'right' },
                { key: 'amountEur', title: '金额(EUR)', align: 'right' },
                { key: 'netPayableCny', title: '净应付(元)', align: 'right' },
                { key: 'status', title: '状态', width: '110px' },
                { key: 'createdAt', title: '时间', width: '150px' },
              ],
              rows: certs.value,
              rowKey: 'certNo',
            }, {
              'col-certNo': ({ row }) => h('span', { class: 'mono tiny' }, row.certNo),
              'col-payableEmission': ({ row }) => num(row.payableEmission, 2),
              'col-amountEur': ({ row }) => num(row.amountEur, 2),
              'col-netPayableCny': ({ row }) => num(row.netPayableCny, 2),
              'col-status': ({ row }) => h('span', { class: 'tag t-mute plain' }, row.status),
              'col-createdAt': ({ row }) => h('span', { class: 'tiny dim' }, String(row.createdAt || '').slice(0, 16)),
            }),
          }) : null;

          return h('div', {}, [formCard, resultCard, certCard]);
        },
      });
    },
  });

  App.views['page-mrv-activity'] = PageMrvActivity;
  App.views['page-mrv-calc'] = PageMrvCalc;
  App.views['page-mrv-factor'] = PageMrvFactor;
  App.views['page-mrv-compliance'] = PageMrvCompliance;
  App.views['page-mrv-cbam'] = PageMrvCbam;
})();
