/* =====================================================================
   核查机构端：任务受理 / 数据核查 / 出具报告并上链
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted } = Vue;
  const h = App.h;

  /* ==================================================================
   * 一、机构总览
   * ================================================================== */
  const PageVerOverview = defineComponent({
    name: 'page-ver-overview',
    setup() {
      const d = ref(null);
      async function load() { try { d.value = await App.API.get('/verifier/overview'); } catch (e) { App.notify.err(e.message); } }
      onMounted(load);

      const workloadOption = computed(() => {
        if (!d.value) return null;
        const m = d.value.monthly || [];
        return App.chartBase({
          grid: { left: 10, right: 16, top: 22, bottom: 6, containLabel: true },
          xAxis: App.catAxis(m.map((x) => x.month)),
          yAxis: App.valAxis({ name: '件' }),
          series: [{
            type: 'bar', data: m.map((x) => Number(x.cnt)), barWidth: '44%',
            itemStyle: { borderRadius: [5, 5, 0, 0], color: App.areaGrad('#38bdf8', 'rgba(56,189,248,.28)') },
          }],
        });
      });

      const concOption = computed(() => {
        if (!d.value) return null;
        return App.chartBase({
          tooltip: Object.assign(App.chartBase().tooltip, { trigger: 'item', formatter: '{b}<br/>{c} 份（{d}%）' }),
          legend: { orient: 'vertical', right: 4, top: 'center', formatter: (n) => ({ PASS: '通过', CONDITIONAL: '有条件通过', FAIL: '不通过' })[n] || n },
          series: [{
            type: 'pie', radius: ['50%', '76%'], center: ['38%', '52%'],
            itemStyle: { borderColor: 'rgba(6,10,18,.9)', borderWidth: 2, borderRadius: 4 },
            label: { show: false }, labelLine: { show: false },
            data: d.value.conclusion.map((c) => ({ name: c.name, value: c.value })),
          }],
        });
      });

      return () => {
        if (!d.value) return h('div', { class: 'grid g4' }, Array.from({ length: 4 }).map(() => h('div', { class: 'skel', style: 'height:118px' })));
        const o = d.value.org, k = d.value.kpi;
        return h('div', {}, [
          h('x-page', {
            title: o.name,
            desc: `备案编号 ${o.code} · ${o.region} · 资质等级 ${o.level} 级 · 专职核查员 ${o.staff} 人 · 综合评级 ${o.rating} 分`,
          }, {
            actions: () => [
              h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
              h('button', { class: 'btn sm primary', onClick: () => App.go('/ver/tasks') }, [h('x-icon', { name: 'verify', size: 14 }), '前往核查作业']),
            ],
            default: () => [
              h('div', { class: 'grid g5 mb-16' }, [
                h('x-kpi', { label: '待受理任务', value: k.pending, unit: '件', icon: 'clock', tone: 'chain', foot: '请及时受理，避免超期' }),
                h('x-kpi', { label: '核查中', value: k.processing, unit: '件', icon: 'verify', tone: 'sky', foot: '已受理待出具结论' }),
                h('x-kpi', { label: '累计完成', value: k.done, unit: '件', icon: 'shield', tone: 'carbon', foot: `驳回 ${k.rejected} 件` }),
                h('x-kpi', { label: '平均偏差率', value: k.avgDeviation, unit: '%', icon: 'target', tone: 'violet', foot: '申报值与认定值之差的绝对值均值' }),
                h('x-kpi', { label: '链上存证', value: App.fmt.num(k.chainCount), unit: '笔', icon: 'chain', tone: 'chain', foot: '由本机构钱包签发的报告存证' }),
              ]),

              h('div', { class: 'grid g-3-2 mb-16' }, [
                h('x-card', { title: '待办任务', sub: '按优先级排序，点击进入核查作业', flush: true }, {
                  actions: () => h('button', { class: 'btn sm ghost', onClick: () => App.go('/ver/tasks') }, '全部任务'),
                  default: () => d.value.todoTasks.length ? h('x-table', {
                    columns: [
                      { key: 'task_no', title: '任务编号', width: '170px' },
                      { key: 'ent_name', title: '被核查企业' },
                      { key: 'period', title: '报告期', width: '90px' },
                      { key: 'total_emission', title: '申报排放(tCO₂e)', align: 'right' },
                      { key: 'priority', title: '优先级', width: '80px' },
                      { key: 'status', title: '状态', width: '95px' },
                    ],
                    rows: d.value.todoTasks,
                    rowClick: () => App.go('/ver/tasks'),
                  }, {
                    'col-task_no': ({ value }) => h('span', { class: 'mono' }, value),
                    'col-period': ({ value }) => h('span', { class: 'tag t-info plain mono' }, value),
                    'col-total_emission': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 2)),
                    'col-priority': ({ row }) => h('x-tag', { dict: App.DICT.priority, dictKey: row.priority }),
                    'col-status': ({ row }) => h('x-tag', { dict: App.DICT.taskStatus, dictKey: row.status }),
                  }) : h('div', { class: 'empty' }, '暂无待办任务'),
                }),
                h('x-card', { title: '核查结论分布' }, { default: () => h('x-chart', { option: concOption.value, height: 'h300' }) }),
              ]),

              h('div', { class: 'grid g2' }, [
                h('x-card', { title: '近 12 个月核查工作量' }, { default: () => h('x-chart', { option: workloadOption.value, height: 'h260' }) }),
                h('x-card', { title: '最近出具的核查报告', flush: true }, {
                  default: () => h('x-table', {
                    columns: [
                      { key: 'report_no', title: '报告号' },
                      { key: 'verified_value', title: '认定排放(tCO₂e)', align: 'right' },
                      { key: 'deviation_rate', title: '偏差率', align: 'right', width: '90px' },
                      { key: 'issue_time', title: '签发时间', width: '150px' },
                    ],
                    rows: d.value.deviation,
                  }, {
                    'col-report_no': ({ value }) => h('span', { class: 'mono' }, value),
                    'col-verified_value': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 2)),
                    'col-deviation_rate': ({ value }) => h('span', { class: ['delta', Math.abs(Number(value)) > 3 ? 'bad' : 'good'], style: 'font-size:12px' }, (Number(value) >= 0 ? '+' : '') + value + '%'),
                    'col-issue_time': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                  }),
                }),
              ]),
            ],
          }),
        ]);
      };
    },
  });

  /* ==================================================================
   * 二、核查任务
   * ================================================================== */
  const PageVerTasks = defineComponent({
    name: 'page-ver-tasks',
    setup() {
      const pager = App.usePager((p) => App.API.get('/verifier/tasks', p), { page: 1, size: 10 });
      const filters = reactive({ status: '', priority: '', keyword: '' });
      const showWork = ref(false);
      const task = ref(null);
      const busy = ref(false);
      const form = reactive({ conclusion: 'PASS', verifiedValue: 0, opinion: '' });

      function load() { pager.load({ status: filters.status, priority: filters.priority, keyword: filters.keyword }); }
      onMounted(load);

      async function open(row) {
        try {
          task.value = await App.API.get('/verifier/tasks/' + row.id);
          form.conclusion = 'PASS';
          form.verifiedValue = Number(task.value.total_emission);
          form.opinion = '经核对能源采购台账、生产报表与在线监测数据，排放量核算边界清晰，数据来源可追溯，核查结果予以认可。';
          showWork.value = true;
        } catch (e) { App.notify.err(e.message); }
      }

      async function accept() {
        busy.value = true;
        try {
          await App.API.post(`/verifier/tasks/${task.value.id}/accept`);
          App.notify.ok('任务已受理');
          task.value.status = 'PROCESSING';
          task.value.report_status = 'VERIFYING';
          load();
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      async function issue() {
        busy.value = true;
        try {
          const r = await App.API.post(`/verifier/tasks/${task.value.id}/verify`, {
            conclusion: form.conclusion,
            verifiedValue: Number(form.verifiedValue),
            opinion: form.opinion,
          });
          App.notify.ok(`核查报告 ${r.verifyReportNo} 已出具并上链存证（区块 #${r.chain.blockIndex}）`);
          showWork.value = false;
          load();
          App.showChainProof('核查报告链上存证核验 · ' + r.verifyReportNo, `/verifier/reports/${r.verifyReportId}/chain`);
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      const deviation = computed(() => {
        if (!task.value) return 0;
        const d0 = Number(task.value.total_emission);
        return d0 > 0 ? (((Number(form.verifiedValue) - d0) / d0) * 100) : 0;
      });

      const historyOption = computed(() => {
        if (!task.value) return null;
        const t = task.value.history || [];
        return App.chartBase({
          grid: { left: 10, right: 16, top: 22, bottom: 6, containLabel: true },
          xAxis: App.catAxis(t.map((x) => x.period)),
          yAxis: App.valAxis({ name: 'tCO₂e' }),
          series: [{
            type: 'bar', data: t.map((x) => Number(x.total_emission)), barWidth: '46%',
            itemStyle: {
              borderRadius: [5, 5, 0, 0],
              color: (p) => (t[p.dataIndex].period === task.value.period
                ? '#f5a524'
                : new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(56,189,248,.85)' }, { offset: 1, color: 'rgba(56,189,248,.22)' }])),
            },
          }],
        });
      });

      return () => h('div', {}, [
        h('x-page', {
          title: '第三方核查作业',
          desc: '核查机构受监管端指派，对企业申报的碳排放数据进行独立核证。结论一经出具即生成 ECDSA 签名的链上存证，报告内容事后不可修改。',
        }, {
          default: () => h('x-card', { flush: true }, {
            head: () => h('div', { class: 'flex gap-8 wrap', style: 'flex:1;align-items:center' }, [
              h('select', { class: 'select', style: 'width:150px', value: filters.status, onChange: (e) => { filters.status = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部状态'),
                ...Object.keys(App.DICT.taskStatus).map((k) => h('option', { value: k }, App.DICT.taskStatus[k][0])),
              ]),
              h('select', { class: 'select', style: 'width:130px', value: filters.priority, onChange: (e) => { filters.priority = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部优先级'),
                ...Object.keys(App.DICT.priority).map((k) => h('option', { value: k }, App.DICT.priority[k][0])),
              ]),
              h('div', { class: 'input-group', style: 'width:280px' }, [
                h('input', { class: 'input', placeholder: '搜索任务号 / 企业名 / 上报单号', value: filters.keyword, onInput: (e) => { filters.keyword = e.target.value; }, onKeyup: (e) => { if (e.key === 'Enter') load(); } }),
                h('button', { class: 'btn', onClick: load }, [h('x-icon', { name: 'search', size: 14 })]),
              ]),
            ]),
            default: () => [
              h('x-table', {
                columns: [
                  { key: 'task_no', title: '任务编号', width: '170px' },
                  { key: 'ent_name', title: '被核查企业' },
                  { key: 'industry', title: '行业', width: '95px' },
                  { key: 'period', title: '报告期', width: '90px' },
                  { key: 'total_emission', title: '申报排放(tCO₂e)', align: 'right' },
                  { key: 'task_type', title: '任务类型', width: '110px' },
                  { key: 'priority', title: '优先级', width: '80px' },
                  { key: 'status', title: '状态', width: '95px' },
                  { key: 'deadline', title: '要求完成', width: '120px' },
                  { key: '_act', title: '操作', width: '110px' },
                ],
                rows: pager.state.rows, loading: pager.state.loading, rowClick: open,
              }, {
                'col-task_no': ({ value }) => h('span', { class: 'mono' }, value),
                'col-industry': ({ value }) => h('span', { class: 'tag t-mute plain' }, value),
                'col-period': ({ value }) => h('span', { class: 'tag t-info plain mono' }, value),
                'col-total_emission': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 2)),
                'col-task_type': ({ row }) => h('x-tag', { dict: App.DICT.taskType, dictKey: row.task_type }),
                'col-priority': ({ row }) => h('x-tag', { dict: App.DICT.priority, dictKey: row.priority }),
                'col-status': ({ row }) => h('x-tag', { dict: App.DICT.taskStatus, dictKey: row.status }),
                'col-deadline': ({ value }) => h('span', { class: 'tiny' }, App.fmt.d(value)),
                'col-_act': ({ row }) => h('button', {
                  class: 'btn sm', onClick: (e) => { e.stopPropagation(); open(row); },
                }, row.status === 'PENDING' ? '受理' : (row.status === 'PROCESSING' ? '出具结论' : '查看')),
              }),
              h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
            ],
          }),
        }),

        /* 核查作业台 */
        h('x-modal', {
          modelValue: showWork.value,
          title: task.value ? `核查作业台 · ${task.value.ent_name} · ${task.value.period}` : '核查作业台',
          width: '1000px',
          'onUpdate:modelValue': (v) => { showWork.value = v; },
        }, {
          default: () => {
            if (!task.value) return null;
            const t = task.value;
            return h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: '企业申报排放', value: App.fmt.num(t.total_emission, 2), unit: 'tCO₂e', tone: 'carbon', foot: `范围一 ${App.fmt.num(t.scope1_emission)} / 范围二 ${App.fmt.num(t.scope2_emission)}` }),
                h('x-kpi', { label: '综合能耗', value: App.fmt.num(t.energy_consumption, 2), unit: 'tce', tone: 'sky', foot: `数据来源 ${t.data_source}` }),
                h('x-kpi', { label: '报告期产值', value: App.fmt.num(t.output_value, 2), unit: '万元', tone: 'violet', foot: `排放强度 ${t.intensity} t/万元` }),
                h('x-kpi', { label: '同期行业均值', value: App.fmt.num(t.peerAvg ? t.peerAvg.avg_emission : 0, 2), unit: 'tCO₂e', tone: 'chain', foot: `同行业 ${t.peerAvg ? t.peerAvg.cnt : 0} 家企业同报告期` }),
              ]),

              h('div', { class: 'grid g-2-1 mb-16' }, [
                h('x-card', { title: '企业历史排放序列', sub: '橙色为本次核查的报告期' }, {
                  default: () => h('x-chart', { option: historyOption.value, height: 'h200' }),
                }),
                h('x-card', { title: '企业档案' }, {
                  default: () => h('dl', { class: 'kv', style: 'grid-template-columns:100px 1fr' }, [
                    h('dt', {}, '企业名称'), h('dd', {}, t.ent_name),
                    h('dt', {}, '信用代码'), h('dd', { class: 'mono tiny' }, t.ent_code),
                    h('dt', {}, '所属行业'), h('dd', {}, t.industry + ' · ' + t.scale + '企业'),
                    h('dt', {}, '所在地区'), h('dd', {}, t.region + t.city),
                    h('dt', {}, '碳信用分'), h('dd', {}, String(t.credit_score)),
                    h('dt', {}, '企业钱包'), h('dd', { class: 'mono tiny' }, App.fmt.addr(t.wallet_address)),
                  ]),
                }),
              ]),

              h('h4', { class: 'mb-8' }, '申报能源消耗明细'),
              h('div', { class: 'tbl-wrap mb-16' }, [
                h('table', { class: 'tbl' }, [
                  h('thead', {}, [h('tr', {}, ['能源品种', '消耗量', '单位', '排放因子', '范围', '折算排放量(tCO₂e)'].map((x, i) => h('th', { class: i === 5 ? 'num' : '' }, x)))]),
                  h('tbody', {}, (t.items || []).map((it) => h('tr', {}, [
                    h('td', {}, it.energy_type), h('td', { class: 'num' }, App.fmt.num(it.amount, 3)),
                    h('td', { class: 'muted' }, it.unit), h('td', { class: 'num' }, it.factor),
                    h('td', {}, [h('span', { class: ['tag', it.scope === 1 ? 't-ok' : 't-info'] }, it.scope === 1 ? '范围一' : '范围二')]),
                    h('td', { class: 'num' }, [h('b', { class: 'mono' }, App.fmt.num(it.co2, 3))]),
                  ]))),
                ]),
              ]),

              (t.status === 'PENDING') && h('div', { class: 'alertbar warn mb-16' }, [
                h('x-icon', { name: 'alert', size: 15 }),
                '该任务尚未受理。受理后企业端上报单状态将变更为「核查中」。',
              ]),

              (t.status === 'PROCESSING' || t.status === 'PENDING') && h('x-card', { title: '核查结论录入' }, {
                default: () => h('div', {}, [
                  h('div', { class: 'grid g3' }, [
                    h('div', { class: 'field' }, [
                      h('label', {}, '核查结论'),
                      h('select', { class: 'select', value: form.conclusion, onChange: (e) => { form.conclusion = e.target.value; } }, [
                        h('option', { value: 'PASS' }, '通过 —— 数据真实可信'),
                        h('option', { value: 'CONDITIONAL' }, '有条件通过 —— 需补充材料'),
                        h('option', { value: 'FAIL' }, '不通过 —— 数据不予采信'),
                      ]),
                    ]),
                    h('div', { class: 'field' }, [
                      h('label', {}, '核查认定值（tCO₂e）'),
                      h('input', { class: 'input', type: 'number', value: form.verifiedValue, onInput: (e) => { form.verifiedValue = e.target.value; } }),
                    ]),
                    h('div', { class: 'field' }, [
                      h('label', {}, '与申报值偏差'),
                      h('div', { class: 'readout', style: 'height:36px' }, [
                        h('span', { class: 'flag', style: `background:${Math.abs(deviation.value) > 3 ? 'rgba(244,63,94,.18)' : 'rgba(16,185,129,.18)'};color:${Math.abs(deviation.value) > 3 ? '#fda4af' : '#6ee7b7'}` }, Math.abs(deviation.value) > 3 ? '超阈值' : '正常'),
                        h('span', { class: 'mono', style: 'margin-left:auto' }, (deviation.value >= 0 ? '+' : '') + deviation.value.toFixed(2) + '%'),
                      ]),
                      h('div', { class: 'hint' }, '偏差超过 ±3% 将自动判定为「有条件通过」'),
                    ]),
                  ]),
                  h('div', { class: 'field' }, [
                    h('label', {}, '核查意见'),
                    h('textarea', { class: 'textarea', value: form.opinion, onInput: (e) => { form.opinion = e.target.value; } }),
                  ]),
                  h('div', { class: 'alertbar info' }, [
                    h('x-icon', { name: 'info', size: 15 }),
                    '出具结论后，系统将计算报告电子签章摘要，用本机构私钥做 ECDSA 签名并打包上链。报告一经上链，任何字段的修改都会导致存证校验失败。',
                  ]),
                ]),
              }),

              t.verifyReport && h('x-card', { title: '已出具的核查结论', class: 'mt-16' }, {
                default: () => h('dl', { class: 'kv' }, [
                  h('dt', {}, '核查报告号'), h('dd', { class: 'mono' }, t.verifyReport.report_no),
                  h('dt', {}, '申报 / 认定值'), h('dd', { class: 'mono' }, `${App.fmt.num(t.verifyReport.declared_value, 2)} / ${App.fmt.num(t.verifyReport.verified_value, 2)}`),
                  h('dt', {}, '偏差率'), h('dd', { class: 'mono' }, t.verifyReport.deviation_rate + '%'),
                  h('dt', {}, '结论'), h('dd', {}, [h('x-tag', { dict: App.DICT.conclusion, dictKey: t.verifyReport.conclusion })]),
                  h('dt', {}, '电子签章'), h('dd', { class: 'hashbox' }, t.verifyReport.seal_hash),
                  h('dt', {}, '链上存证'), h('dd', {}, [h('x-chainbadge', { block: t.verifyReport.chain_block_index, hash: t.verifyReport.chain_tx_id })]),
                ]),
              }),
            ]);
          },
          footer: () => {
            const t = task.value;
            if (!t) return null;
            const btns = [h('button', { class: 'btn', onClick: () => { showWork.value = false; } }, '关闭')];
            if (t.status === 'PENDING') btns.push(h('button', { class: 'btn primary', disabled: busy.value, onClick: accept }, [h('x-icon', { name: 'check', size: 15 }), '受理任务']));
            if (t.status === 'PENDING' || t.status === 'PROCESSING') {
              btns.push(h('button', { class: 'btn chain', disabled: busy.value, onClick: issue }, [h('x-icon', { name: 'chain', size: 15 }), busy.value ? '出具中…' : '出具报告并上链']));
            }
            if (t.verifyReport) {
              btns.push(h('button', {
                class: 'btn', onClick: () => App.showChainProof('核查报告链上存证核验 · ' + t.verifyReport.report_no, `/verifier/reports/${t.verifyReport.id}/chain`),
              }, [h('x-icon', { name: 'shield', size: 15 }), '核验存证']));
            }
            return btns;
          },
        }),
      ]);
    },
  });

  /* ==================================================================
   * 三、已出具报告
   * ================================================================== */
  const PageVerReports = defineComponent({
    name: 'page-ver-reports',
    setup() {
      const pager = App.usePager((p) => App.API.get('/verifier/reports', p), { page: 1, size: 10 });
      const filters = reactive({ conclusion: '', keyword: '' });
      function load() { pager.load({ conclusion: filters.conclusion, keyword: filters.keyword }); }
      onMounted(load);

      return () => h('div', {}, [
        h('x-page', { title: '核查报告台账', desc: '本机构历次出具的核查报告。每份报告均有唯一的电子签章摘要与链上存证交易号，可供监管与公众独立核验。' }, {
          default: () => h('x-card', { flush: true }, {
            head: () => h('div', { class: 'flex gap-8 wrap', style: 'flex:1;align-items:center' }, [
              h('select', { class: 'select', style: 'width:160px', value: filters.conclusion, onChange: (e) => { filters.conclusion = e.target.value; load(); } }, [
                h('option', { value: '' }, '全部结论'),
                ...Object.keys(App.DICT.conclusion).map((k) => h('option', { value: k }, App.DICT.conclusion[k][0])),
              ]),
              h('div', { class: 'input-group', style: 'width:260px' }, [
                h('input', { class: 'input', placeholder: '搜索报告号 / 企业名', value: filters.keyword, onInput: (e) => { filters.keyword = e.target.value; }, onKeyup: (e) => { if (e.key === 'Enter') load(); } }),
                h('button', { class: 'btn', onClick: load }, [h('x-icon', { name: 'search', size: 14 })]),
              ]),
            ]),
            default: () => [
              h('x-table', {
                columns: [
                  { key: 'report_no', title: '核查报告号', width: '180px' },
                  { key: 'ent_name', title: '被核查企业' },
                  { key: 'period', title: '报告期', width: '90px' },
                  { key: 'declared_value', title: '申报值(tCO₂e)', align: 'right' },
                  { key: 'verified_value', title: '认定值(tCO₂e)', align: 'right' },
                  { key: 'deviation_rate', title: '偏差率', align: 'right', width: '95px' },
                  { key: 'conclusion', title: '结论', width: '115px' },
                  { key: 'auditor', title: '主核查员', width: '100px' },
                  { key: 'chain_block_index', title: '链上存证', width: '110px' },
                  { key: 'issue_time', title: '签发时间', width: '150px' },
                  { key: '_act', title: '操作', width: '90px' },
                ],
                rows: pager.state.rows, loading: pager.state.loading,
              }, {
                'col-report_no': ({ value }) => h('span', { class: 'mono' }, value),
                'col-period': ({ value }) => h('span', { class: 'tag t-info plain mono' }, value),
                'col-declared_value': ({ value }) => h('span', { class: 'mono muted' }, App.fmt.num(value, 2)),
                'col-verified_value': ({ value }) => h('b', { class: 'mono' }, App.fmt.num(value, 2)),
                'col-deviation_rate': ({ value }) => h('span', { class: ['delta', Math.abs(Number(value)) > 3 ? 'bad' : 'good'], style: 'font-size:12px' }, (Number(value) >= 0 ? '+' : '') + value + '%'),
                'col-conclusion': ({ row }) => h('x-tag', { dict: App.DICT.conclusion, dictKey: row.conclusion }),
                'col-chain_block_index': ({ row }) => h('x-chainbadge', { block: row.chain_block_index, hash: row.chain_tx_id }),
                'col-issue_time': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                'col-_act': ({ row }) => h('button', {
                  class: 'btn sm ghost', onClick: () => App.showChainProof('核查报告链上存证核验 · ' + row.report_no, `/verifier/reports/${row.id}/chain`),
                }, [h('x-icon', { name: 'shield', size: 13 }), '核验']),
              }),
              h('x-pager', { page: pager.state.page, pages: pager.state.pages, total: pager.state.total, size: pager.state.size, onChange: pager.goto }),
            ],
          }),
        }),
      ]);
    },
  });

  /* ==================================================================
   * 四、机构链上身份
   * ================================================================== */
  const PageVerWallet = defineComponent({
    name: 'page-ver-wallet',
    setup() {
      const d = ref(null);
      onMounted(async () => { try { d.value = await App.API.get('/verifier/wallet'); } catch (e) { App.notify.err(e.message); } });
      return () => h('div', {}, [
        h('x-page', { title: '机构链上身份', desc: '核查机构以自己的私钥对每一份核查报告签名，实现"报告出自谁手"的不可抵赖性。' }, {
          default: () => !d.value ? h('div', { class: 'skel', style: 'height:240px' }) : h('div', { class: 'grid g-1-2' }, [
            h('x-card', { title: '机构钱包' }, {
              default: () => h('dl', { class: 'kv' }, [
                h('dt', {}, '机构名称'), h('dd', {}, d.value.org_name),
                h('dt', {}, '钱包地址'), h('dd', { class: 'hashbox' }, [h('b', {}, d.value.address)]),
                h('dt', {}, '签名算法'), h('dd', { class: 'mono' }, d.value.algorithm),
                h('dt', {}, '公钥'), h('dd', {}, h('pre', { class: 'mono-pre', style: 'max-height:150px' }, d.value.public_key || d.value.publicKey || '-')),
              ]),
            }),
            h('x-card', { title: '本机构签发的存证交易', flush: true }, {
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
   * 五、通知公告
   * ================================================================== */
  const PageVerNotices = defineComponent({
    name: 'page-ver-notices',
    setup() {
      const pager = App.usePager((p) => App.API.get('/verifier/notices', p), { page: 1, size: 10 });
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
                  { key: 'publish_time', title: '发布时间', width: '160px' },
                ],
                rows: pager.state.rows, loading: pager.state.loading,
                rowClick: (r) => App.go('/notice/' + r.id),
              }, {
                'col-notice_type': ({ row }) => h('x-tag', { dict: App.DICT.noticeType, dictKey: row.notice_type }),
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
    'page-ver-overview': PageVerOverview,
    'page-ver-tasks': PageVerTasks,
    'page-ver-reports': PageVerReports,
    'page-ver-wallet': PageVerWallet,
    'page-ver-notices': PageVerNotices,
  });
})();
