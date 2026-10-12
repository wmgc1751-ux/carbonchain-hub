/* =====================================================================
   企业端：碳排上报 / 链上存证 / 配额账户 / 碳交易 / 数据分析
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, watch } = Vue;
  const h = App.h;

  const ENERGY = [
    { name: '原煤', unit: 't', factor: 1.9003, scope: 1 },
    { name: '焦炭', unit: 't', factor: 2.8604, scope: 1 },
    { name: '天然气', unit: '万m³', factor: 21.622, scope: 1 },
    { name: '柴油', unit: 't', factor: 3.0959, scope: 1 },
    { name: '燃料油', unit: 't', factor: 3.1705, scope: 1 },
    { name: '电力', unit: 'MWh', factor: 0.5703, scope: 2 },
    { name: '热力', unit: 'GJ', factor: 0.11, scope: 2 },
  ];
  const YEAR = new Date().getFullYear();

  /* ==================================================================
   * 一、企业总览
   * ================================================================== */
  const PageEntOverview = defineComponent({
    name: 'page-ent-overview',
    setup() {
      const d = ref(null);
      const err = ref('');

      async function load() {
        try { d.value = await App.API.get('/enterprise/overview'); err.value = ''; }
        catch (e) { err.value = e.message; }
      }
      onMounted(load);

      const trendOption = computed(() => {
        if (!d.value) return null;
        const t = d.value.trend || [];
        return App.chartBase({
          legend: { data: ['范围一 直接排放', '范围二 间接排放', '排放强度'], top: 0, right: 6 },
          grid: { left: 10, right: 26, top: 34, bottom: 6, containLabel: true },
          xAxis: App.catAxis(t.map((x) => x.period), { boundaryGap: false }),
          yAxis: [App.valAxis({ name: 'tCO₂e', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 } }),
            App.valAxis({ name: '强度', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 }, splitLine: { show: false } })],
          series: [
            {
              name: '范围一 直接排放', type: 'bar', stack: 'e', data: t.map((x) => Number(x.s1)), barWidth: '46%',
              itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#10b981' }, { offset: 1, color: 'rgba(16,185,129,.35)' }]), borderRadius: [0, 0, 0, 0] },
            },
            {
              name: '范围二 间接排放', type: 'bar', stack: 'e', data: t.map((x) => Number(x.s2)),
              itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#38bdf8' }, { offset: 1, color: 'rgba(56,189,248,.35)' }]), borderRadius: [4, 4, 0, 0] },
            },
            {
              name: '排放强度', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 6,
              data: t.map((x) => Number(x.intensity)), lineStyle: { color: '#f5a524', width: 2 }, itemStyle: { color: '#fbbf24' },
            },
          ],
        });
      });

      const quotaOption = computed(() => {
        if (!d.value) return null;
        const q = d.value.currentQuota || {};
        const alloc = Number(q.total_allocated) || 0;
        const used = Number(q.used) || 0;
        return {
          series: [{
            type: 'pie', radius: ['62%', '84%'], center: ['50%', '52%'], startAngle: 90,
            avoidLabelOverlap: false, label: { show: false }, labelLine: { show: false },
            itemStyle: { borderColor: 'rgba(6,10,18,.9)', borderWidth: 3, borderRadius: 5 },
            data: [
              { name: '已使用', value: Math.max(used, 0), itemStyle: { color: '#10b981' } },
              { name: '剩余可用', value: Math.max(alloc - used, 0), itemStyle: { color: 'rgba(255,255,255,.12)' } },
            ],
          }],
        };
      });

      return () => {
        if (err.value) return h('div', {}, [h('x-page', { title: '企业总览' }), h('div', { class: 'alertbar err' }, [h('x-icon', { name: 'alert', size: 15 }), err.value])]);
        if (!d.value) return h('div', { class: 'grid g4' }, Array.from({ length: 4 }).map(() => h('div', { class: 'skel', style: 'height:118px' })));
        const e = d.value.enterprise, k = d.value.kpi, q = d.value.currentQuota;

        return h('div', {}, [
          h('x-page', {
            title: `${e.name}`,
            desc: `${e.industry} · ${e.region}${e.city} · ${e.scale}企业 · 统一社会信用代码 ${e.code} · 碳信用分 ${e.creditScore}`,
          }, {
            actions: () => [
              h('button', { class: 'btn sm', onClick: () => App.go('/ent/reports') }, [h('x-icon', { name: 'report', size: 14 }), '碳排上报']),
              h('button', { class: 'btn sm primary', onClick: () => App.go('/ent/dynamic') }, [h('x-icon', { name: 'leaf', size: 14 }), '动态核算']),
            ],
            default: () => [
              /* 链上身份 */
              h('div', { class: 'card mb-16' }, [
                h('div', { class: 'card-body', style: 'display:flex;align-items:center;gap:16px;flex-wrap:wrap' }, [
                  h('div', { class: 'brand-mark', style: 'background:linear-gradient(135deg,#f5a524,#b45309)' }, [h('x-icon', { name: 'wallet', size: 19 })]),
                  h('div', { class: 'flex-1', style: 'min-width:260px' }, [
                    h('div', { class: 'lbl tiny muted' }, '我的链上身份（secp256k1 钱包地址）'),
                    h('div', { class: 'mono', style: 'color:var(--chain-l);font-size:14px;margin-top:3px' }, e.wallet),
                    h('div', { class: 'tiny dim mt-8' }, '私钥由节点本地密钥库离线托管，业务库中仅保存公钥与地址，平台任何人员均无法冒用你的名义签发存证。'),
                  ]),
                  h('div', { class: 'flex gap-20' }, [
                    h('div', { class: 'center' }, [h('div', { style: 'font-size:20px;font-weight:700;color:var(--tx-0)' }, App.fmt.num(k.chainAnchors)), h('div', { class: 'tiny dim' }, '上链存证笔数')]),
                    h('div', { class: 'center' }, [h('div', { style: 'font-size:20px;font-weight:700;color:var(--tx-0)' }, e.status === 'ACTIVE' ? '正常' : '关注'), h('div', { class: 'tiny dim' }, '账户状态')]),
                  ]),
                  h('button', { class: 'btn sm', onClick: () => App.go('/ent/wallet') }, [h('x-icon', { name: 'key', size: 14 }), '链上身份详情']),
                ]),
              ]),

              /* KPI */
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: `${YEAR} 年度累计排放`, value: App.fmt.num(k.emissionYtd), unit: 'tCO₂e', icon: 'fire', tone: 'carbon', foot: `已核查 ${k.reportVerified} 份 / 待核查 ${k.reportPending} 份` }),
                h('x-kpi', { label: '免费分配配额', value: App.fmt.num(k.quotaAllocated), unit: 'tCO₂e', icon: 'coin', tone: 'sky', foot: `可用余额 ${App.fmt.num(q.available)}` }),
                h('x-kpi', { label: '履约缺口 / 盈余', value: App.fmt.num(k.quotaGap), unit: 'tCO₂e', icon: 'target', tone: Number(k.quotaGap) >= 0 ? 'carbon' : 'rose', foot: Number(k.quotaGap) >= 0 ? '动态核算配额盈余' : '动态核算存在缺口' }),
                h('x-kpi', { label: `行业排放排名`, value: `${k.industryRank} / ${k.industryTotal}`, icon: 'chart', tone: 'chain', foot: `按 ${e.industry} 行业 ${YEAR} 年累计排放` }),
              ]),

              /* 图表 */
              h('div', { class: 'grid g-2-1 mb-16' }, [
                h('x-card', { title: '碳排放趋势（范围一 / 范围二 / 排放强度）', sub: '范围一为企业直接排放，范围二为购入电力热力对应的间接排放' }, {
                  default: () => h('x-chart', { option: trendOption.value, height: 'h300' }),
                }),
                h('x-card', { title: '配额使用进度', sub: `${YEAR} 年度免费分配配额消耗情况` }, {
                  default: () => h('div', {}, [
                    h('x-chart', { option: quotaOption.value, height: 'h200' }),
                    h('div', { class: 'grid g2 mt-8' }, [
                      h('div', { class: 'center' }, [h('div', { class: 'tiny dim' }, '已使用'), h('div', { class: 'mono', style: 'color:var(--carbon-l);font-size:15px' }, App.fmt.num(q.used))]),
                      h('div', { class: 'center' }, [h('div', { class: 'tiny dim' }, '占比'), h('div', { class: 'mono', style: 'color:var(--tx-0);font-size:15px' }, App.fmt.pct(k.complianceRate, 1))]),
                    ]),
                  ]),
                }),
              ]),

              /* 预警与公告 */
              h('div', { class: 'grid g2' }, [
                h('x-card', { title: '监管预警', sub: '与本企业相关的预警事项', flush: true }, {
                  actions: () => h('button', { class: 'btn sm ghost', onClick: () => App.go('/ent/reports') }, '查看上报单'),
                  default: () => d.value.alerts.length
                    ? h('x-table', {
                      columns: [{ key: 'title', title: '预警事项' }, { key: 'level', title: '级别', width: '70px' }, { key: 'status', title: '状态', width: '90px' }, { key: 'created_at', title: '时间', width: '150px' }],
                      rows: d.value.alerts,
                    }, {
                      'col-level': ({ row }) => h('x-tag', { dict: App.DICT.alertLevel, dictKey: row.level }),
                      'col-status': ({ row }) => h('x-tag', { dict: App.DICT.alertStatus, dictKey: row.status }),
                      'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                    })
                    : h('div', { class: 'empty' }, '暂无预警事项'),
                }),
                h('x-card', { title: '通知公告', flush: true }, {
                  actions: () => h('button', { class: 'btn sm ghost', onClick: () => App.go('/ent/notices') }, '全部'),
                  default: () => h('div', { class: 'card-body col gap-12' }, d.value.notices.map((n) => h('div', {
                    class: 'flex gap-8', style: 'cursor:pointer;align-items:flex-start', onClick: () => App.go('/notice/' + n.id),
                  }, [
                    h('x-tag', { dict: App.DICT.noticeType, dictKey: n.notice_type }),
                    h('div', { class: 'flex-1' }, [
                      h('div', { style: 'font-size:13px;color:var(--tx-1)' }, n.title),
                      h('div', { class: 'tiny dim' }, App.fmt.d(n.publish_time)),
                    ]),
                  ]))),
                }),
              ]),
            ],
          }),
        ]);
      };
    },
  });

  /* ==================================================================
   * 二、碳排上报
   * ================================================================== */
  const PageEntReports = defineComponent({
    name: 'page-ent-reports',
    setup() {
      const pager = App.usePager((p) => App.API.get('/enterprise/reports', p), { page: 1, size: 10 });
      const filters = reactive({ status: '', period: '', keyword: '' });
      const showCreate = ref(false);
      const showDetail = ref(false);
      const detail = ref(null);
      const submitting = ref(false);

      const form = reactive({
        year: YEAR, quarter: 3, dataSource: '在线监测',
        items: [{ energyType: '原煤', amount: 12000 }, { energyType: '电力', amount: 3200 }],
      });

      const periods = computed(() => {
        const out = [];
        for (let y = YEAR; y >= YEAR - 2; y--) for (let q = 4; q >= 1; q--) out.push(`${y}Q${q}`);
        return out;
      });

      const calc = computed(() => {
        let s1 = 0, s2 = 0;
        const rows = form.items.map((it) => {
          const m = ENERGY.find((x) => x.name === it.energyType) || ENERGY[0];
          const amount = Number(it.amount) || 0;
          const co2 = amount * m.factor;
          if (m.scope === 1) s1 += co2; else s2 += co2;
          return { ...it, unit: m.unit, factor: m.factor, scope: m.scope, co2 };
        });
        return { rows, s1, s2, total: s1 + s2 };
      });

      function load() { pager.load({ status: filters.status, period: filters.period, keyword: filters.keyword }); }
      onMounted(load);

      function addRow() { form.items.push({ energyType: '电力', amount: 0 }); }
      function rmRow(i) { form.items.splice(i, 1); }

      async function submitReport(submit) {
        submitting.value = true;
        try {
          const r = await App.API.post('/enterprise/reports', {
            year: Number(form.year), quarter: Number(form.quarter),
            dataSource: form.dataSource, submit,
            items: form.items.filter((i) => Number(i.amount) > 0).map((i) => ({ energyType: i.energyType, amount: Number(i.amount) })),
          });
          App.notify.ok(submit ? `上报成功，数据已上链存证（区块 #${r.chain.blockIndex}）` : '草稿已保存');
          showCreate.value = false;
          load();
          if (submit) App.showChainProof('上报单链上存证核验 · ' + r.reportNo, `/enterprise/reports/${r.reportId}/chain`);
        } catch (e) { App.notify.err(e.message); } finally { submitting.value = false; }
      }

      async function openDetail(row) {
        try {
          detail.value = await App.API.get(`/enterprise/reports/${row.id}`);
          showDetail.value = true;
        } catch (e) { App.notify.err(e.message); }
      }

      async function submitDraft(row) {
        try {
          const r = await App.API.post(`/enterprise/reports/${row.id}/submit`);
          App.notify.ok(`提交成功，已上链存证（区块 #${r.chain.blockIndex}）`);
          load();
        } catch (e) { App.notify.err(e.message); }
      }

      return () => h('div', {}, [
        h('x-page', {
          title: '碳排放数据上报',
          desc: '按季度填报能源消耗，系统自动折算碳排放量（范围一直接排放 + 范围二间接排放）。提交后数据将被哈希并上链存证，随后自动派单至第三方核查机构。',
        }, {
          actions: () => h('button', { class: 'btn sm primary', onClick: () => { showCreate.value = true; } }, [h('x-icon', { name: 'plus', size: 14 }), '新建上报单']),
          default: () => h('x-card', { flush: true }, {
            head: () => h('div', { class: 'flex gap-8 wrap', style: 'align-items:center;flex:1' }, [
              h('select', { class: 'select', style: 'width:150px', value: filters.status, onChange: (e) => { filters.status = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部状态'),
                ...Object.keys(App.DICT.reportStatus).map((k) => h('option', { value: k }, App.DICT.reportStatus[k][0])),
              ]),
              h('select', { class: 'select', style: 'width:140px', value: filters.period, onChange: (e) => { filters.period = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部报告期'),
                ...periods.value.map((p) => h('option', { value: p }, p)),
              ]),
              h('div', { class: 'input-group', style: 'width:240px' }, [
                h('input', { class: 'input', placeholder: '搜索上报单号', value: filters.keyword, onInput: (e) => { filters.keyword = e.target.value; }, onKeyup: (e) => { if (e.key === 'Enter') load(); } }),
                h('button', { class: 'btn', onClick: load }, [h('x-icon', { name: 'search', size: 14 })]),
              ]),
            ]),
            default: () => [
              h('x-table', {
                columns: [
                  { key: 'report_no', title: '上报单号', width: '180px' },
                  { key: 'period', title: '报告期', width: '90px' },
                  { key: 'total_emission', title: '排放总量(tCO₂e)', align: 'right' },
                  { key: 'scope1_emission', title: '范围一', align: 'right' },
                  { key: 'scope2_emission', title: '范围二', align: 'right' },
                  { key: 'intensity', title: '强度(t/万元)', align: 'right' },
                  { key: 'yoy_rate', title: '同比', align: 'right', width: '90px' },
                  { key: 'status', title: '状态', width: '95px' },
                  { key: 'verifier_name', title: '核查机构' },
                  { key: 'chain_block_index', title: '链上存证', width: '110px' },
                  { key: '_act', title: '操作', width: '150px' },
                ],
                rows: pager.state.rows, loading: pager.state.loading, rowClick: openDetail,
              }, {
                'col-report_no': ({ value }) => h('span', { class: 'mono', style: 'color:var(--tx-0)' }, value),
                'col-period': ({ value }) => h('span', { class: 'tag t-info plain', style: 'font-family:var(--mono)' }, value),
                'col-total_emission': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 2)),
                'col-scope1_emission': ({ value }) => h('span', { class: 'mono muted' }, App.fmt.num(value, 2)),
                'col-scope2_emission': ({ value }) => h('span', { class: 'mono muted' }, App.fmt.num(value, 2)),
                'col-intensity': ({ value }) => h('span', { class: 'mono' }, value),
                'col-yoy_rate': ({ value }) => h('span', { class: ['delta', Number(value) >= 0 ? 'bad' : 'good'], style: 'font-size:12px' }, (Number(value) >= 0 ? '+' : '') + value + '%'),
                'col-status': ({ row }) => h('x-tag', { dict: App.DICT.reportStatus, dictKey: row.status }),
                'col-verifier_name': ({ value }) => h('span', { class: 'tiny' }, value || '待派单'),
                'col-chain_block_index': ({ row }) => h('x-chainbadge', {
                  block: row.chain_block_index,
                  hash: row.chain_tx_id,
                  label: '点击复制存证交易号',
                }),
                'col-_act': ({ row }) => h('div', { class: 'flex gap-6' }, [
                  h('button', {
                    class: 'btn sm ghost', onClick: (e) => {
                      e.stopPropagation();
                      if (row.chain_block_index) App.showChainProof('上报单链上存证核验 · ' + row.report_no, `/enterprise/reports/${row.id}/chain`);
                      else App.notify.warn('该上报单尚未上链存证');
                    },
                  }, [h('x-icon', { name: 'shield', size: 13 }), '存证']),
                  row.status === 'DRAFT' && h('button', {
                    class: 'btn sm', onClick: (e) => { e.stopPropagation(); submitDraft(row); },
                  }, '提交'),
                ]),
              }),
              h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
            ],
          }),
        }),

        /* 新建上报单 */
        h('x-modal', { modelValue: showCreate.value, title: '新建碳排放数据上报单', width: '880px', 'onUpdate:modelValue': (v) => { showCreate.value = v; } }, {
          default: () => h('div', {}, [
            h('div', { class: 'grid g4' }, [
              h('div', { class: 'field' }, [h('label', {}, '核算年度'), h('input', { class: 'input', type: 'number', value: form.year, onInput: (e) => { form.year = e.target.value; } })]),
              h('div', { class: 'field' }, [h('label', {}, '核算季度'), h('select', { class: 'select', value: form.quarter, onChange: (e) => { form.quarter = e.target.value; } }, [1, 2, 3, 4].map((q) => h('option', { value: q }, '第 ' + q + ' 季度')))]),
              h('div', { class: 'field' }, [h('label', {}, '数据来源'), h('select', { class: 'select', value: form.dataSource, onChange: (e) => { form.dataSource = e.target.value; } }, ['在线监测', '物料衡算', '排放因子法'].map((s) => h('option', { value: s }, s)))]),
              h('div', { class: 'field' }, [h('label', {}, '报告期'), h('input', { class: 'input', value: `${form.year}Q${form.quarter}`, disabled: true })]),
            ]),

            h('div', { class: 'flex between mb-8', style: 'align-items:center' }, [
              h('h4', {}, '能源消耗明细'),
              h('button', { class: 'btn sm', onClick: addRow }, [h('x-icon', { name: 'plus', size: 13 }), '添加一行']),
            ]),
            h('div', { class: 'tbl-wrap' }, [
              h('table', { class: 'tbl' }, [
                h('thead', {}, [h('tr', {}, [
                  h('th', { style: 'width:180px' }, '能源品种'), h('th', { style: 'width:150px' }, '消耗量'),
                  h('th', {}, '单位'), h('th', {}, '排放因子'), h('th', {}, '排放范围'), h('th', { class: 'num' }, '折算排放量(tCO₂e)'), h('th', { style: 'width:70px' }, ''),
                ])]),
                h('tbody', {}, calc.value.rows.map((r, i) => h('tr', {}, [
                  h('td', {}, [h('select', {
                    class: 'select', value: r.energyType,
                    onChange: (e) => { form.items[i].energyType = e.target.value; },
                  }, ENERGY.map((x) => h('option', { value: x.name }, x.name)))]),
                  h('td', {}, [h('input', {
                    class: 'input', type: 'number', value: form.items[i].amount,
                    onInput: (e) => { form.items[i].amount = e.target.value; },
                  })]),
                  h('td', {}, h('span', { class: 'muted' }, r.unit)),
                  h('td', {}, h('span', { class: 'mono muted' }, r.factor)),
                  h('td', {}, h('span', { class: ['tag', r.scope === 1 ? 't-ok' : 't-info'] }, r.scope === 1 ? '范围一 直接' : '范围二 间接')),
                  h('td', { class: 'num' }, [h('b', { class: 'mono' }, App.fmt.num(r.co2, 3))]),
                  h('td', {}, h('button', { class: 'btn sm danger ghost', onClick: () => rmRow(i) }, [h('x-icon', { name: 'close', size: 13 })])),
                ]))),
              ]),
            ]),

            h('div', { class: 'grid g3 mt-16' }, [
              h('div', { class: 'card kpi k-carbon' }, [h('div', { class: 'card-body' }, [
                h('div', { class: 'lbl' }, '范围一 直接排放'), h('div', { class: 'val' }, [App.fmt.num(calc.value.s1, 2), h('span', { class: 'unit' }, 'tCO₂e')]),
              ])]),
              h('div', { class: 'card kpi k-sky' }, [h('div', { class: 'card-body' }, [
                h('div', { class: 'lbl' }, '范围二 间接排放'), h('div', { class: 'val' }, [App.fmt.num(calc.value.s2, 2), h('span', { class: 'unit' }, 'tCO₂e')]),
              ])]),
              h('div', { class: 'card kpi k-chain' }, [h('div', { class: 'card-body' }, [
                h('div', { class: 'lbl' }, '排放总量'), h('div', { class: 'val' }, [App.fmt.num(calc.value.total, 2), h('span', { class: 'unit' }, 'tCO₂e')]),
              ])]),
            ]),

            h('div', { class: 'alertbar info mt-16' }, [
              h('x-icon', { name: 'info', size: 15 }),
              '提交后系统将计算业务数据 SHA-256 摘要，用你的企业私钥做 ECDSA 签名并打包上链；随后按规则随机指派一家第三方核查机构。同一企业同一季度不可重复上报。',
            ]),
          ]),
          footer: () => [
            h('button', { class: 'btn', onClick: () => { showCreate.value = false; } }, '取消'),
            h('button', { class: 'btn', disabled: submitting.value, onClick: () => submitReport(false) }, '保存草稿'),
            h('button', { class: 'btn primary', disabled: submitting.value, onClick: () => submitReport(true) }, [h('x-icon', { name: 'chain', size: 15 }), submitting.value ? '提交中…' : '提交并上链存证']),
          ],
        }),

        /* 上报单详情 */
        h('x-modal', { modelValue: showDetail.value, title: detail.value ? `上报单 ${detail.value.report_no}` : '上报单详情', width: '900px', 'onUpdate:modelValue': (v) => { showDetail.value = v; } }, {
          default: () => {
            if (!detail.value) return null;
            const r = detail.value;
            return h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: '排放总量', value: App.fmt.num(r.total_emission, 2), unit: 'tCO₂e', tone: 'carbon' }),
                h('x-kpi', { label: '综合能耗', value: App.fmt.num(r.energy_consumption, 2), unit: 'tce', tone: 'sky' }),
                h('x-kpi', { label: '报告期产值', value: App.fmt.num(r.output_value, 2), unit: '万元', tone: 'violet' }),
                h('x-kpi', { label: '排放强度', value: r.intensity, unit: 't/万元', tone: 'chain' }),
              ]),
              h('dl', { class: 'kv mb-16' }, [
                h('dt', {}, '报告期'), h('dd', {}, r.period),
                h('dt', {}, '数据来源'), h('dd', {}, r.data_source),
                h('dt', {}, '当前状态'), h('dd', {}, [h('x-tag', { dict: App.DICT.reportStatus, dictKey: r.status })]),
                h('dt', {}, '提交时间'), h('dd', {}, App.fmt.dt(r.submit_time)),
                h('dt', {}, '核查机构'), h('dd', {}, r.verifier_name || '待派单'),
                h('dt', {}, '核查完成'), h('dd', {}, App.fmt.dt(r.verify_time)),
                h('dt', {}, '链上存证'), h('dd', {}, [r.chain_block_index
                  ? h('x-chainbadge', { block: r.chain_block_index, hash: r.chain_tx_id })
                  : h('span', { class: 'tag t-mute' }, '未上链')]),
                r.remark && h('dt', {}, '核查意见'), r.remark && h('dd', {}, r.remark),
              ]),
              h('h4', { class: 'mb-8' }, '能源消耗明细'),
              h('div', { class: 'tbl-wrap mb-16' }, [
                h('table', { class: 'tbl' }, [
                  h('thead', {}, [h('tr', {}, ['能源品种', '消耗量', '单位', '排放因子', '范围', '折算排放量(tCO₂e)'].map((t, i) => h('th', { class: i === 5 ? 'num' : '' }, t)))]),
                  h('tbody', {}, (r.items || []).map((it) => h('tr', {}, [
                    h('td', {}, it.energy_type),
                    h('td', { class: 'num' }, App.fmt.num(it.amount, 3)),
                    h('td', { class: 'muted' }, it.unit),
                    h('td', { class: 'num' }, it.factor),
                    h('td', {}, [h('span', { class: ['tag', it.scope === 1 ? 't-ok' : 't-info'] }, it.scope === 1 ? '范围一' : '范围二')]),
                    h('td', { class: 'num' }, [h('b', { class: 'mono' }, App.fmt.num(it.co2, 3))]),
                  ]))),
                ]),
              ]),
              r.verifyReport && h('div', {}, [
                h('h4', { class: 'mb-8' }, '第三方核查结论'),
                h('dl', { class: 'kv' }, [
                  h('dt', {}, '核查报告号'), h('dd', { class: 'mono' }, r.verifyReport.report_no),
                  h('dt', {}, '申报值 / 认定值'), h('dd', { class: 'mono' }, `${App.fmt.num(r.verifyReport.declared_value, 2)} / ${App.fmt.num(r.verifyReport.verified_value, 2)} tCO₂e`),
                  h('dt', {}, '偏差率'), h('dd', { class: 'mono' }, r.verifyReport.deviation_rate + '%'),
                  h('dt', {}, '核查结论'), h('dd', {}, [h('x-tag', { dict: App.DICT.conclusion, dictKey: r.verifyReport.conclusion })]),
                  h('dt', {}, '主核查员'), h('dd', {}, r.verifyReport.auditor),
                  h('dt', {}, '电子签章'), h('dd', { class: 'hashbox' }, r.verifyReport.seal_hash),
                  h('dt', {}, '核查意见'), h('dd', {}, r.verifyReport.opinion),
                ]),
              ]),
            ]);
          },
          footer: () => [
            h('button', { class: 'btn', onClick: () => { showDetail.value = false; } }, '关闭'),
            detail.value && detail.value.chain_block_index
              ? h('button', { class: 'btn chain', onClick: () => App.showChainProof('上报单链上存证核验 · ' + detail.value.report_no, `/enterprise/reports/${detail.value.id}/chain`) }, [h('x-icon', { name: 'shield', size: 15 }), '核验链上存证'])
              : null,
          ],
        }),
      ]);
    },
  });

  /* ==================================================================
   * 三、配额账户
   * ================================================================== */
  const PageEntQuota = defineComponent({
    name: 'page-ent-quota',
    setup() {
      const d = ref(null);
      async function load() { try { d.value = await App.API.get('/enterprise/quota'); } catch (e) { App.notify.err(e.message); } }
      onMounted(load);

      return () => h('div', {}, [
        h('x-page', { title: '碳配额账户', desc: '配额由监管端按年度核定并下发，每一次分配都会生成一笔链上存证交易，可溯源到具体的分配方法与操作人。' }, {
          actions: () => h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          default: () => !d.value ? h('div', { class: 'skel', style: 'height:220px' }) : [
            h('div', { class: 'grid g4 mb-16' }, (d.value.list || []).slice(0, 4).map((q) => h('x-kpi', {
              label: `${q.year} 年度配额`,
              value: App.fmt.num(q.total_allocated),
              unit: 'tCO₂e',
              icon: 'coin',
              tone: Number(q.available) >= 0 ? 'carbon' : 'rose',
              foot: `可用 ${App.fmt.num(q.available)} · 已用 ${App.fmt.num(q.used)}`,
            }))),

            h('x-card', { title: '账户明细', flush: true, class: 'mb-16' }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'year', title: '年度', width: '90px' },
                  { key: 'total_allocated', title: '免费分配', align: 'right' },
                  { key: 'used', title: '已履约使用', align: 'right' },
                  { key: 'available', title: '当前可用', align: 'right' },
                  { key: '_gap', title: '履约状态', width: '120px' },
                ],
                rows: d.value.list,
              }, {
                'col-total_allocated': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
                'col-used': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
                'col-available': ({ value }) => h('b', { class: 'mono', style: `color:${Number(value) >= 0 ? 'var(--carbon-l)' : '#fda4af'}` }, App.fmt.num(value, 2)),
                'col-_gap': ({ row }) => Number(row.available) >= 0
                  ? h('span', { class: 'tag t-ok' }, '配额充足')
                  : h('span', { class: 'tag t-danger' }, '存在缺口'),
              }),
            }),

            h('x-card', { title: '配额分配流水（监管端下发记录）', flush: true }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'alloc_no', title: '分配单号', width: '170px' },
                  { key: 'year', title: '年度', width: '80px' },
                  { key: 'quota_amount', title: '分配量(tCO₂e)', align: 'right' },
                  { key: 'alloc_type', title: '分配类型', width: '120px' },
                  { key: 'alloc_method', title: '核定方法' },
                  { key: 'baseline_intensity', title: '基准强度', align: 'right', width: '110px' },
                  { key: 'operator', title: '操作人', width: '100px' },
                  { key: 'chain_block_index', title: '链上存证', width: '110px' },
                  { key: 'created_at', title: '分配时间', width: '160px' },
                ],
                rows: d.value.allocations,
              }, {
                'col-alloc_no': ({ value }) => h('span', { class: 'mono' }, value),
                'col-quota_amount': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 2)),
                'col-alloc_type': ({ row }) => h('x-tag', { dict: App.DICT.allocType, dictKey: row.alloc_type }),
                'col-baseline_intensity': ({ value }) => h('span', { class: 'mono muted' }, value || '-'),
                'col-chain_block_index': ({ row }) => h('x-chainbadge', { block: row.chain_block_index, hash: row.chain_tx_id }),
                'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
              }),
            }),
          ],
        }),
      ]);
    },
  });

  /* ==================================================================
   * 四、数据分析
   * ================================================================== */
  const PageEntAnalytics = defineComponent({
    name: 'page-ent-analytics',
    setup() {
      const d = ref(null);
      onMounted(async () => { try { d.value = await App.API.get('/enterprise/analytics'); } catch (e) { App.notify.err(e.message); } });

      const trendOption = computed(() => {
        if (!d.value) return null;
        const t = d.value.trend;
        return App.chartBase({
          grid: { left: 10, right: 24, top: 24, bottom: 6, containLabel: true },
          xAxis: App.catAxis(t.map((x) => x.period), { boundaryGap: false }),
          yAxis: App.valAxis({ name: 'tCO₂e', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 } }),
          series: [
            {
              name: '排放总量', type: 'line', smooth: true, symbolSize: 7, data: t.map((x) => Number(x.total)),
              lineStyle: { width: 2.8, color: '#10b981' }, itemStyle: { color: '#34d399' },
              areaStyle: { color: App.areaGrad('rgba(16,185,129,.42)', 'rgba(16,185,129,.01)') },
              markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(251,113,133,.7)', type: 'dashed' }, data: [{ type: 'average', name: '均值' }] },
            },
          ],
        });
      });

      const mixOption = computed(() => {
        if (!d.value) return null;
        return App.chartBase({
          tooltip: Object.assign(App.chartBase().tooltip, { trigger: 'item', formatter: '{b}<br/>{c} tCO₂e（{d}%）' }),
          legend: { orient: 'vertical', right: 6, top: 'center' },
          series: [{
            type: 'pie', radius: ['48%', '74%'], center: ['38%', '52%'],
            itemStyle: { borderColor: 'rgba(6,10,18,.9)', borderWidth: 2, borderRadius: 4 },
            label: { show: false }, labelLine: { show: false },
            data: d.value.mix.map((m) => ({ name: m.name, value: Number(m.value) })),
          }],
        });
      });

      const tradeOption = computed(() => {
        if (!d.value) return null;
        const m = d.value.monthly || [];
        const q = d.value.quota || {};
        const quotaTotal = Number(q.total_allocated) || 0;
        // 累计排放 vs 配额：缺口为正表示预计超排，需履约补足
        let acc = 0;
        const accData = m.map((x) => { acc += Number(x.amount); return Number(acc.toFixed(1)); });
        return App.chartBase({
          legend: { data: ['累计核算排放', '年度配额'], top: 0, right: 6 },
          grid: { left: 10, right: 26, top: 34, bottom: 6, containLabel: true },
          xAxis: App.catAxis(m.map((x) => x.month)),
          yAxis: App.valAxis({ name: 'tCO₂e' }),
          series: [
            { name: '累计核算排放', type: 'line', smooth: true, data: accData, lineStyle: { color: '#10b981', width: 2 }, itemStyle: { color: '#34d399' }, areaStyle: { color: App.areaGrad('rgba(16,185,129,.3)', 'rgba(16,185,129,.01)') } },
            { name: '年度配额', type: 'line', smooth: true, data: m.map(() => quotaTotal), lineStyle: { color: '#f5a524', width: 2, type: 'dashed' }, itemStyle: { color: '#fbbf24' } },
          ],
        });
      });

      const peerOption = computed(() => {
        if (!d.value) return null;
        const p = d.value.peers || [];
        return App.chartBase({
          grid: { left: 10, right: 50, top: 14, bottom: 6, containLabel: true },
          tooltip: Object.assign(App.chartBase().tooltip, { formatter: (ps) => `${ps[0].name}<br/>排放量 <b>${App.fmt.num(ps[0].value)}</b> tCO₂e` }),
          xAxis: App.valAxis({ show: false }),
          yAxis: App.catAxis(p.slice().reverse().map((x) => (x.name || '').slice(0, 14)), { axisLabel: { color: '#8d9cb5', fontSize: 10.5 } }),
          series: [{
            type: 'bar', barWidth: 12, data: p.slice().reverse().map((x) => x.value),
            itemStyle: {
              borderRadius: [0, 6, 6, 0],
              color: (par) => (p.slice().reverse()[par.dataIndex].name === d.value.myName
                ? '#f5a524' : new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: 'rgba(56,189,248,.3)' }, { offset: 1, color: '#38bdf8' }])),
            },
            label: { show: true, position: 'right', color: '#8d9cb5', fontSize: 10.5, formatter: (par) => App.fmt.big(par.value) },
          }],
        });
      });

      return () => h('div', {}, [
        h('x-page', { title: '碳排放数据分析', desc: '从时间趋势、能源结构、履约缺口与同行对标四个维度对本企业碳资产核算状况进行诊断。' }, {
          default: () => {
            if (!d.value) return h('div', { class: 'grid g2' }, Array.from({ length: 2 }).map(() => h('div', { class: 'skel', style: 'height:300px' })));
            const q = d.value.quota || {};
            return [
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: '免费分配配额', value: App.fmt.num(q.total_allocated), unit: 'tCO₂e', icon: 'coin', tone: 'sky' }),
                h('x-kpi', { label: '已履约使用', value: App.fmt.num(q.used), unit: 'tCO₂e', icon: 'fire', tone: 'carbon' }),
                h('x-kpi', { label: '已履约 / 待履约', value: `${App.fmt.num(q.used)} / ${App.fmt.num(Math.max(0, (q.total_allocated || 0) - (q.used || 0)))}`, unit: 'tCO₂e', icon: 'target', tone: 'violet' }),
                h('x-kpi', { label: '账户可用余额', value: App.fmt.num(q.available), unit: 'tCO₂e', icon: 'wallet', tone: Number(q.available) >= 0 ? 'carbon' : 'rose' }),
              ]),
              h('div', { class: 'grid g-2-1 mb-16' }, [
                h('x-card', { title: '排放总量趋势' }, { default: () => h('x-chart', { option: trendOption.value, height: 'h300' }) }),
                h('x-card', { title: '能源结构排放占比', sub: `${YEAR} 年度` }, { default: () => h('x-chart', { option: mixOption.value, height: 'h300' }) }),
              ]),
              h('div', { class: 'grid g2' }, [
                h('x-card', { title: '动态核算履约缺口', sub: '累计核算排放 vs 年度配额' }, { default: () => h('x-chart', { option: tradeOption.value, height: 'h300' }) }),
                h('x-card', { title: '同行业排放对标 TOP10', sub: '橙色为本企业' }, { default: () => h('x-chart', { option: peerOption.value, height: 'h300' }) }),
              ]),
            ];
          },
        }),
      ]);
    },
  });

  /* ==================================================================
   * 五、链上身份
   * ================================================================== */
  const PageEntWallet = defineComponent({
    name: 'page-ent-wallet',
    setup() {
      const d = ref(null);
      onMounted(async () => { try { d.value = await App.API.get('/enterprise/wallet'); } catch (e) { App.notify.err(e.message); } });
      return () => h('div', {}, [
        h('x-page', { title: '我的链上身份', desc: '平台为每个企业分配独立的 secp256k1 密钥对。私钥仅保存在节点本地密钥库，业务数据库中只有公钥与地址。' }, {
          default: () => !d.value ? h('div', { class: 'skel', style: 'height:260px' }) : h('div', { class: 'grid g-1-2' }, [
            h('x-card', { title: '钱包信息' }, {
              default: () => h('dl', { class: 'kv' }, [
                h('dt', {}, '钱包地址'), h('dd', { class: 'hashbox' }, [h('b', {}, d.value.address)]),
                h('dt', {}, '签名算法'), h('dd', { class: 'mono' }, d.value.algorithm),
                h('dt', {}, '私钥位置'), h('dd', {}, d.value.privateKeyLocation),
                h('dt', {}, '公钥'), h('dd', {}, h('pre', { class: 'mono-pre', style: 'max-height:150px' }, d.value.publicKey)),
              ]),
            }),
            h('x-card', { title: '由本钱包发起的存证交易', flush: true }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'tx_id', title: '交易号' },
                  { key: 'tx_type', title: '类型', width: '140px' },
                  { key: 'biz_no', title: '业务单号', width: '170px' },
                  { key: 'block_index', title: '区块', width: '90px' },
                  { key: 'created_at', title: '时间', width: '160px' },
                ],
                rows: d.value.recentTxs,
                rowClick: (r) => App.go('/explorer/tx/' + r.tx_id),
              }, {
                'col-tx_id': ({ value }) => h('x-hash', { value, len: 18 }),
                'col-tx_type': ({ row }) => h('x-tag', { dict: App.DICT.txType, dictKey: row.tx_type }),
                'col-biz_no': ({ value }) => h('span', { class: 'mono' }, value),
                'col-block_index': ({ value }) => h('x-chainbadge', { block: value }),
                'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
              }),
            }),
          ]),
        }),
      ]);
    },
  });

  /* ==================================================================
   * 六、预警中心（多智能体预测预警）
   * ================================================================== */
  const PageEntPredict = defineComponent({
    name: 'page-ent-predict',
    setup() {
      const report = ref(null);
      const twin = ref(null);
      const busy = ref(false);

      async function load() {
        try { report.value = await App.API.request('GET', '/intelligence/report'); }
        catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);

      // 预测曲线：实际累计 vs 预测外推 vs 配额线
      const predictOption = computed(() => {
        if (!report.value) return null;
        const f = report.value.forecast;
        const fc = f.forecast || [];
        return App.chartBase({
          legend: { data: ['预测累计排放', '年度配额'], top: 0, right: 6 },
          grid: { left: 10, right: 24, top: 34, bottom: 6, containLabel: true },
          xAxis: App.catAxis(fc.map((x) => x.date), { boundaryGap: false }),
          yAxis: App.valAxis({ name: 'tCO₂e', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 } }),
          series: [
            { name: '预测累计排放', type: 'line', smooth: true, symbolSize: 6, data: fc.map((x) => Number(x.cumulative)), lineStyle: { color: '#f43f5e', width: 2.4 }, itemStyle: { color: '#fb7185' }, areaStyle: { color: App.areaGrad('rgba(244,63,94,.3)', 'rgba(244,63,94,.01)') } },
            { name: '年度配额', type: 'line', smooth: true, data: fc.map(() => f.allocated), lineStyle: { color: '#10b981', width: 2, type: 'dashed' }, itemStyle: { color: '#34d399' } },
          ],
        });
      });

      async function runTwin() {
        busy.value = true;
        try {
          twin.value = await App.API.request('POST', '/intelligence/simulate', {
            scenarios: [
              { name: '减产 10%', key: 'output', deltaPct: -10 },
              { name: '节能改造提升能效 15%', key: 'efficiency', deltaPct: 15 },
              { name: '燃料替代降碳强度 10%', key: 'fuel', deltaPct: -10 },
            ],
          });
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      return () => {
        const r = report.value;
        return h('x-page', { title: '预警中心', desc: '多智能体预测预警：用量预测 / 超限预警 / 异常检测 / 减排建议 协同研判，提前干预履约风险' }, {
          actions: () => h('div', { class: 'flex gap-8' }, [
            h('button', { class: 'btn sm', onClick: runTwin, disabled: busy }, [h('x-icon', { name: 'target', size: 14 }), busy ? '推演中…' : '数字孪生推演']),
            h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ]),
          default: () => !r ? h('div', { class: 'skel', style: 'height:260px' }) : [
            h('div', { class: 'grid g4 mb-16' }, [
              h('x-kpi', { label: '预测期末排放', value: App.fmt.num(r.overQuota.predictedEoy, 0), unit: 'tCO₂e', icon: 'fire', tone: r.overQuota.gap > 0 ? 'rose' : 'carbon', foot: `滚动速率 ${r.forecast.stats.avgDaily} tCO₂e/天` }),
              h('x-kpi', { label: '预计缺口', value: App.fmt.num(r.overQuota.gap, 0), unit: 'tCO₂e', icon: 'target', tone: r.overQuota.gap > 0 ? 'rose' : 'carbon', foot: `占配额 ${r.overQuota.gapRatio}%` }),
              h('x-kpi', { label: '超限概率', value: r.overQuota.exceedProbability * 100 + '%', icon: 'alert', tone: r.overQuota.riskLevel === 'HIGH' ? 'rose' : (r.overQuota.riskLevel === 'MEDIUM' ? 'violet' : 'carbon') }),
              h('x-kpi', { label: '异常读数', value: r.anomaly.anomalyCount, unit: '处', icon: 'shield', tone: r.anomaly.anomalyCount > 3 ? 'rose' : 'carbon' }),
            ]),

            h('div', { class: 'grid g2 mb-16' }, [
              h('x-card', { title: '预测累计排放 vs 年度配额', sub: `${r.forecast.horizonDays} 天外推 · ${r.forecast.method}` }, {
                default: () => h('x-chart', { option: predictOption.value, height: 'h300' }),
              }),
              h('x-card', { title: '减排建议', sub: 'ADVISOR 智能体生成' }, {
                default: () => h('div', { class: 'col gap-10' }, r.advisor.suggestions.map((s) => h('div', { class: 'alertbar info', style: 'flex-direction:column;align-items:flex-start;gap:6px' }, [
                  h('div', { class: 'flex gap-8', style: 'align-items:center' }, [
                    h('x-tag', { text: { TRADE: '市场交易', OFFSET: 'CCER 抵销', PRODUCTION: '生产优化', DATA: '数据核查', OK: '状态良好' }[s.type] || s.type, tone: s.priority === 'HIGH' ? 't-danger' : (s.priority === 'MEDIUM' ? 't-warn' : 't-ok') }),
                    h('b', { style: 'font-size:14px' }, s.title),
                  ]),
                  h('span', { style: 'font-size:13px;line-height:1.6;color:var(--tx-2)' }, s.detail),
                ]))),
              }),
            ]),

            r.anomaly.anomalyCount > 0 && h('x-card', { title: '异常检测明细（3σ 判据）', flush: true }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'time', title: '时间', width: '170px' },
                  { key: 'flow', title: '读数(tCO₂e)', align: 'right' },
                  { key: 'zScore', title: 'Z 分数', align: 'right' },
                  { key: 'type', title: '类型', width: '100px' },
                  { key: 'severity', title: '严重度', width: '100px' },
                ],
                rows: r.anomaly.anomalies.slice().reverse(),
              }, {
                'col-flow': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 3)),
                'col-zScore': ({ value }) => h('span', { class: 'mono', style: `color:${Math.abs(value) > 3.5 ? '#fda4af' : '#fbbf24'}` }, value),
                'col-type': ({ value }) => h('span', {}, value === 'SPIKE' ? '突增' : '突降'),
                'col-severity': ({ value }) => h('x-tag', { text: value === 'HIGH' ? '高' : '中', tone: value === 'HIGH' ? 't-danger' : 't-warn' }),
              }),
            }),

            twin.value && h('x-card', { title: '数字孪生情景推演', sub: 'what-if 分析：调整生产/能效/燃料参数，对比预测期末配额结余' }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'name', title: '情景' },
                  { key: 'deltaPct', title: '调整幅度', align: 'right', width: '120px' },
                  { key: 'predictedEoy', title: '预测期末排放', align: 'right' },
                  { key: 'gap', title: '期末缺口', align: 'right' },
                  { key: 'quotaSurplus', title: '配额结余', width: '100px' },
                ],
                rows: twin.value.scenarios,
              }, {
                'col-deltaPct': ({ value }) => h('span', { class: 'mono' }, (value > 0 ? '+' : '') + value + '%'),
                'col-predictedEoy': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 0)),
                'col-gap': ({ value }) => h('span', { class: 'mono', style: `color:${Number(value) > 0 ? '#fda4af' : '#34d399'}` }, App.fmt.num(value, 0)),
                'col-quotaSurplus': ({ row }) => h('span', { class: row.quotaSurplus ? 'tag t-ok' : 'tag t-danger' }, row.quotaSurplus ? '有结余' : '有缺口'),
              }),
            }),
          ],
        });
      };
    },
  });

  /* ==================================================================
   * 七、通知公告
   * ================================================================== */
  const PageEntNotices = defineComponent({
    name: 'page-ent-notices',
    setup() {
      const pager = App.usePager((p) => App.API.get('/enterprise/notices', p), { page: 1, size: 10 });
      onMounted(() => pager.load());
      return () => h('div', {}, [
        h('x-page', { title: '通知公告' }, {
          default: () => h('x-card', { flush: true }, {
            default: () => [
              h('x-table', {
                columns: [
                  { key: 'notice_type', title: '类型', width: '110px' },
                  { key: 'title', title: '标题' },
                  { key: 'publisher', title: '发布人', width: '130px' },
                  { key: 'views', title: '浏览', align: 'right', width: '90px' },
                  { key: 'publish_time', title: '发布时间', width: '160px' },
                ],
                rows: pager.state.rows, loading: pager.state.loading,
                rowClick: (r) => App.go('/notice/' + r.id),
              }, {
                'col-notice_type': ({ row }) => h('x-tag', { dict: App.DICT.noticeType, dictKey: row.notice_type }),
                'col-title': ({ row }) => h('div', { class: 'flex gap-8' }, [
                  row.is_top ? h('span', { class: 'tag t-danger' }, '置顶') : null,
                  h('span', {}, row.title),
                ]),
                'col-publish_time': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
              }),
              h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
            ],
          }),
        }),
      ]);
    },
  });

  Object.assign(App.views, {
    'page-ent-overview': PageEntOverview,
    'page-ent-reports': PageEntReports,
    'page-ent-quota': PageEntQuota,
    'page-ent-analytics': PageEntAnalytics,
    'page-ent-wallet': PageEntWallet,
    'page-ent-predict': PageEntPredict,
    'page-ent-notices': PageEntNotices,
  });
})();
