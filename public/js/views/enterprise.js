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
  /* 业务年度由后端返回（reportYear = 该企业最新有核查数据的年度）。
   * 不能在前端用 new Date().getFullYear() 硬编码 —— 碳数据滞后，
   * 当年必然无数据，页面会显示"2026 年度 0"，
   * 而实际该企业有 2025 年的 8 张已核查上报单。 */
  const YEAR = Vue.ref(new Date().getFullYear());
  const setYear = (y) => { if (y) YEAR.value = Number(y); };

  /* ==================================================================
   * 一、企业总览
   * ================================================================== */
  const PageEntOverview = defineComponent({
    name: 'page-ent-overview',
    setup() {
      const d = ref(null);
      const err = ref('');
      const alertDetail = ref(null);   // 预警详情弹窗（行点击查看正文）

      async function load() {
        try {
          d.value = await App.API.get('/enterprise/overview');
          setYear(d.value && d.value.reportYear);
          err.value = '';
        }
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
            /* 右轴必须带单位：强度 = 排放 ÷ 上网电量，与配额基准线同口径（tCO₂/万kWh）。
             * 此前只写"强度"，12.37 这个数无从解读（2026-10-31 巡检 P3）。 */
            App.valAxis({ name: 'tCO₂e/万kWh', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 }, splitLine: { show: false } })],
          series: [
            {
              /* 范围一为 0 的报告期：零值柱带 borderRadius 会渲染出数像素绿色残影，
               * 看起来像有微量直接排放 —— 置为透明（2026-10-31 巡检 P3）。 */
              name: '范围一 直接排放', type: 'bar', stack: 'e', barWidth: '46%',
              data: t.map((x) => (Number(x.s1) > 0 ? Number(x.s1) : { value: 0, itemStyle: { color: 'rgba(0,0,0,0)' } })),
              itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#10b981' }, { offset: 1, color: 'rgba(16,185,129,.35)' }]), borderRadius: [0, 0, 0, 0] },
            },
            {
              name: '范围二 间接排放', type: 'bar', stack: 'e',
              data: t.map((x) => (Number(x.s2) > 0 ? Number(x.s2) : { value: 0, itemStyle: { color: 'rgba(0,0,0,0)' } })),
              itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#38bdf8' }, { offset: 1, color: 'rgba(56,189,248,.35)' }]), borderRadius: [4, 4, 0, 0] },
            },
            {
              name: '排放强度', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 6,
              /* 强度 = 排放 ÷ 产出。产出缺失（output=0）的报告期强度在数学上无定义，
               * 库里却存着 0.0000 —— 照画会把 2025 年整段线"垂直下落"到 0 轴，
               * 看起来像强度骤降（P2-38 同类问题的企业端残留）。按缺失断线处理。 */
              data: t.map((x) => (Number(x.output) > 0 ? Number(x.intensity) : null)),
              lineStyle: { color: '#f5a524', width: 2 }, itemStyle: { color: '#fbbf24' },
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
            /* 字段级兜底：city 等资料缺失时此前会把字面量 "null" 渲染给用户（2026-10-29） */
            desc: [
              e.industry || '—',
              [e.region, e.city].filter(Boolean).join('') || '—',
              e.scale ? `${e.scale}企业` : '—',
              `主体编号 ${e.code || '—'}（演示）`,
              `碳信用分 ${e.creditScore ?? '—'}`,
            ].join(' · '),
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
                    h('div', { class: 'lbl tiny muted' }, '我的链上身份（链上钱包地址）'),
                    h('div', { class: 'mono', style: 'color:var(--chain-l);font-size:14px;margin-top:3px' }, e.wallet),
                    h('div', { class: 'tiny dim mt-8' }, '私钥由节点本地密钥库代持，业务库中仅保存公钥与地址 —— 仅凭数据库无法伪造你的签名（密钥不在任何业务库里）。'
                      + '已知边界：钱包由「标签 → 摘要」确定性派生、算法随源码公开，掌握节点密钥库或源码的主体仍可代签；'
                      + '生产环境应将私钥托管迁移至 HSM/KMS，并为派生过程掺入部署级密钥。'
                      + '平台内置双密码套件可按链级策略切换：套件 A = secp256k1/SHA-256（当前），套件 B = 国密 SM2/SM3。'),
                  ]),
                  h('div', { class: 'flex gap-20' }, [
                    h('div', { class: 'center' }, [h('div', { style: 'font-size:20px;font-weight:700;color:var(--tx-0)' }, App.fmt.num(k.chainAnchors)), h('div', { class: 'tiny dim' }, '上链存证笔数')]),
                    h('div', { class: 'center' }, [h('div', { style: 'font-size:20px;font-weight:700;color:var(--tx-0)' }, e.status === 'ACTIVE' ? '正常' : '关注'), h('div', { class: 'tiny dim' }, '账户状态')]),
                  ]),
                  h('button', { class: 'btn sm', onClick: () => App.go('/ent/wallet') }, [h('x-icon', { name: 'key', size: 14 }), '链上身份详情']),
                ]),
              ]),

              /* 【2026-11-03】必须显式说明"这个年度是本企业的业务年度，不是系统当年"。
               * 实测河北恒能（易州恒新）只有 2025/2024 上报单，接口 reportYear=2025，
               * 页面 KPI 全部按 2025 出数；若读者以为是"2026 年至今"，会得出
               * "今年排放 10.4 万吨"的完全错误结论。 */
              ...(YEAR.value !== new Date().getFullYear() ? [h('div', {
                class: 'alertbar info mb-16', style: 'margin-bottom:16px',
              }, [
                h('x-icon', { name: 'alert', size: 15 }),
                `本页按 ${YEAR.value} 年度口径展示（该年度为本企业最近一个已核查年度）。`
                + `${new Date().getFullYear()} 年度尚无已核查上报单，提交并完成核查后自动切换。`,
              ])] : []),
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', {
                  label: `${YEAR.value} 年度累计排放`,
                  value: App.fmt.num(k.emissionYtd),
                  unit: 'tCO₂e', icon: 'fire', tone: 'carbon',
                  /* 只有草稿时明确说出来，否则"0 tCO₂e"会被读成没有数据 */
                  foot: k.draftCount > 0
                    ? `另有 ${k.draftCount} 张草稿 ${App.fmt.num(k.draftEmission)} t 未提交`
                    : `已核查 ${k.reportVerified} 份 / 待核查 ${k.reportPending} 份`,
                }),
                h('x-kpi', { label: '免费分配配额', value: App.fmt.num(k.quotaAllocated), unit: 'tCO₂e', icon: 'coin', tone: 'sky', foot: `可用余额 ${App.fmt.num(q.available)} tCO₂e` }),
                /* 配额未分配时不能给"0 tCO₂e 盈余"这种假结论：此时缺口不可计算。
                 * （2026-10-29 巡检 P0-1：302,858 t 排放 + 0 配额，卡片却写"盈余 0"） */
                h('x-kpi', {
                  label: '履约缺口 / 盈余',
                  value: k.quotaAssigned ? App.fmt.num(k.quotaGap) : '—',
                  unit: k.quotaAssigned ? 'tCO₂e' : '',
                  icon: 'target',
                  tone: k.quotaAssigned ? (Number(k.quotaGap) >= 0 ? 'carbon' : 'rose') : 'sky',
                  foot: k.quotaAssigned
                    ? (Number(k.quotaGap) >= 0 ? '配额 − 已上报排放，结余为正' : '配额 − 已上报排放，缺口为负')
                    : `${YEAR.value} 年度尚未分配配额，缺口无法计算`,
                }),
                h('x-kpi', { label: `行业排放排名`, value: `${k.industryRank} / ${k.industryTotal}`, icon: 'chart', tone: 'chain', foot: `按 ${e.industry} 行业 ${YEAR.value} 年累计排放升序，排放最少为第 1` }),
              ]),

              /* 图表 */
              h('div', { class: 'grid g-2-1 mb-16' }, [
                h('x-card', { title: '碳排放趋势（范围一 / 范围二 / 排放强度）', sub: '范围一为企业直接排放，范围二为购入电力热力对应的间接排放' }, {
                  default: () => h('x-chart', { option: trendOption.value, height: 'h300' }),
                }),
                h('x-card', { title: '配额使用进度', sub: `${YEAR.value} 年度免费分配配额消耗情况` }, {
                  default: () => h('div', {}, [
                    h('x-chart', { option: quotaOption.value, height: 'h200' }),
                    h('div', { class: 'grid g2 mt-8' }, [
                      h('div', { class: 'center' }, [h('div', { class: 'tiny dim' }, '已清缴'), h('div', { class: 'mono', style: 'color:var(--carbon-l);font-size:15px' }, `${App.fmt.num(q.used)} tCO₂e`)]),
                      h('div', { class: 'center' }, [h('div', { class: 'tiny dim' }, '占比'), h('div', { class: 'mono', style: 'color:var(--tx-0);font-size:15px' }, App.fmt.pct(k.complianceRate, 1))]),
                    ]),
                    /* 口径披露：used 是清缴记账数（compliance.surrender 时入账），
                     * 与"累计排放"（申报口径）不同源 —— 不说明时两个数字偶尔
                     * 相等（如本企业 2025 全额清缴）会让用户误读为同一指标。 */
                    h('div', { class: 'tiny dim', style: 'margin-top:8px;text-align:center' },
                      `口径：已清缴 = 清缴时点入账的配额抵扣量（环图同步）· 占比 = 已清缴 ÷ 已分配`),
                  ]),
                }),
              ]),

              /* 预警与公告 */
              h('div', { class: 'grid g2' }, [
                h('x-card', { title: '监管预警', sub: '与本企业相关的预警事项', flush: true }, {
                  actions: () => h('button', { class: 'btn sm ghost', onClick: () => App.go('/ent/reports') }, '查看上报单'),
                  default: () => d.value.alerts.length
                    ? h('x-table', {
                      /* tbl-fixed：固定布局。卡宽 ~540px 放不下"300px 标题 +
                       * 三列固定宽"，auto 布局会把"时间"列推出首屏（P4）；
                       * fixed 下标题列收缩省略，四列任何宽度都完整可见。
                       * selectable:false 显式关批量列 —— 预警列表不需要勾选，
                       * 自动模式（行数≥3 启用）还会多吃 40px 且把根节点换成 .tbl-box。 */
                      class: 'tbl-fixed',
                      selectable: false,
                      columns: [{ key: 'title', title: '预警事项' }, { key: 'level', title: '级别', width: '56px' }, { key: 'status', title: '状态', width: '84px' }, { key: 'created_at', title: '时间', width: '104px' }],
                      rows: d.value.alerts,
                    }, {
                      /* 标题列：企业自己的总览页去掉企业名前缀（冗余），块级省略
                       * 吃满剩余列宽；悬停有 title 提示，点击查看完整正文。 */
                      'col-title': ({ row }) => h('span', {
                        style: 'cursor:pointer;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                        title: row.title,
                        onClick: () => { alertDetail.value = row; },
                      }, String(row.title || '').replace(`${e.name} `, '')),
                      'col-level': ({ row }) => h('x-tag', { dict: App.DICT.alertLevel, dictKey: row.level }),
                      'col-status': ({ row }) => h('x-tag', { dict: App.DICT.alertStatus, dictKey: row.status }),
                      /* 时间列紧凑格式：当年显示"MM-DD HH:mm"，往年显示"YYYY-MM-DD"
                       * （年度是分辨 2025/2026 口径的关键信息，不能丢）；
                       * 完整时间悬停 title 提示。 */
                      'col-created_at': ({ value }) => {
                        const s = String(value || '');
                        const cur = String(new Date().getFullYear());
                        const short = s.slice(0, 4) === cur ? s.slice(5, 16) : s.slice(0, 10);
                        return h('span', { class: 'tiny', title: s }, short);
                      },
                    })
                    : h('x-empty', { title: '当前无预警事项', sub: '排放与配额均在安全区间，风险模型持续监测中', icon: 'shield', tone: 'safe' }),
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
          /* 预警详情：正文（content）里写明了触发年度与成因 —— 没有这个入口，
           * "2025 盈余 59,755" 与 "2026 配额未分配预警" 同屏就是一桩无解矛盾。 */
          alertDetail.value && h('x-modal', {
            modelValue: true, title: '预警详情', width: '560px',
            'onUpdate:modelValue': (v) => { if (!v) alertDetail.value = null; },
          }, {
            default: () => {
              const a = alertDetail.value;
              return h('div', { class: 'col gap-12' }, [
                h('div', { style: 'font-size:14px;font-weight:600;color:var(--tx-0)' }, a.title),
                h('div', { class: 'flex gap-8' }, [
                  h('x-tag', { dict: App.DICT.alertLevel, dictKey: a.level }),
                  h('x-tag', { dict: App.DICT.alertStatus, dictKey: a.status }),
                  h('span', { class: 'tiny dim' }, `编号 ${a.alert_no}`),
                ]),
                h('div', { style: 'font-size:13px;line-height:1.8;color:var(--tx-1);white-space:pre-wrap' }, a.content || '（无正文）'),
                a.handle_note
                  ? h('div', { class: 'tiny dim', style: 'border-top:1px solid var(--ln);padding-top:8px' }, `处理记录：${a.handle_note}（${a.closed_at ? App.fmt.dt(a.closed_at) : ''}）`)
                  : null,
              ]);
            },
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
        year: YEAR.value, quarter: 3, dataSource: '在线监测',
        items: [{ energyType: '原煤', amount: 12000 }, { energyType: '电力', amount: 3200 }],
      });

      const periods = computed(() => {
        const out = [];
        for (let y = YEAR.value; y >= YEAR.value - 2; y--) for (let q = 4; q >= 1; q--) out.push(`${y}Q${q}`);
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
                h('button', { class: 'btn', 'aria-label': '搜索', onClick: load }, [h('x-icon', { name: 'search', size: 14 })]),
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
                  { key: 'intensity', title: '强度(tCO₂e/万kWh)', align: 'right' },
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
                'col-yoy_rate': ({ value }) => {
                  /* 同比≈0 不标红：+0.00% 是"无变化"，此前套用 bad 红色
                   * 会把 8 行全涂红，读成"同比全面恶化"（2026-10-31 巡检 P2-6）。
                   * 排放语义：同比升=bad、降=good、≈0 中性。 */
                  const v = Number(value);
                  const cls = Math.abs(v) < 0.005 ? ['delta', 'muted']
                    : (v > 0 ? ['delta', 'bad'] : ['delta', 'good']);
                  return h('span', { class: cls, style: 'font-size:12px' }, (v > 0 ? '+' : '') + v.toFixed(2) + '%');
                },
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
                /* output_value 是上网电量（万kWh）—— 配额基准线就是按
                 * tCO₂e/万kWh 上网电量核定的（基准线 14.5341 tCO₂/万kWh），
                 * 此前标成"报告期产值/万元"导致强度单位错到离谱
                 * （55,317 t ÷ 4,613 万kWh = 11.99，若按万元读成产值则荒谬） */
                h('x-kpi', { label: '上网电量', value: App.fmt.num(r.output_value, 2), unit: '万kWh', tone: 'violet' }),
                h('x-kpi', { label: '排放强度', value: r.intensity, unit: 'tCO₂e/万kWh', tone: 'chain' }),
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
            /* 两个年度各一张卡：g4 会空出半排，改 g2 满排（2026-10-31 巡检 P4） */
            h('div', { class: 'grid g2 mb-16' }, (d.value.list || []).slice(0, 4).map((q) => h('x-kpi', {
              label: `${q.year} 年度配额`,
              value: App.fmt.num(q.total_allocated),
              unit: 'tCO₂e',
              icon: 'coin',
              tone: Number(q.available) >= 0 ? 'carbon' : 'rose',
              foot: `可用 ${App.fmt.num(q.available)} · 已用 ${App.fmt.num(q.used)}`
                + (Number(q.sold) > 0 ? ` · 已售 ${App.fmt.num(q.sold)}` : ''),
            }))),

            /* 账户明细必须"能加减"。
             *
             * 2026-10-29 巡检 P0-9：初版只有「免费分配 / 已履约使用 / 当前可用」三列，
             * 读者按 362,613.08 − 308,724.00 一算得 53,889.08，与「当前可用 2,806.91」
             * 差 51,082 —— 那 51,082 是累计卖出量，库里 sold 字段明明有值，
             * 只是页面上没有列出来。少一列，整张表就从"账本"退化成"三个互不相干的数字"。
             * 现补齐 +买入 / −已卖出 / −冻结，并加一列闭合校验：
             *   可用 = 免费分配 + 累计买入 − 已履约 − 累计卖出 − 冻结
             * 校验不过就红标差额，宁可显眼地报错，也不要静静地不平。 */
            h('x-card', {
              title: '账户明细',
              sub: '可用 = 免费分配 + 累计买入 − 已履约 − 累计卖出 − 冻结',
              flush: true,
              class: 'mb-16',
            }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'year', title: '年度', width: '76px' },
                  { key: 'total_allocated', title: '免费分配', align: 'right' },
                  { key: 'bought', title: '+ 累计买入', align: 'right' },
                  { key: 'used', title: '− 已履约', align: 'right' },
                  { key: 'sold', title: '− 累计卖出', align: 'right' },
                  { key: 'frozen', title: '− 冻结', align: 'right' },
                  { key: 'available', title: '= 当前可用', align: 'right' },
                  { key: '_chk', title: '闭合校验', width: '110px' },
                  { key: '_gap', title: '履约状态', width: '104px' },
                ],
                rows: d.value.list,
              }, {
                'col-total_allocated': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
                'col-bought': ({ value }) => h('span', { class: 'mono muted' }, Number(value) > 0 ? App.fmt.num(value, 2) : '—'),
                'col-used': ({ value }) => h('span', { class: 'mono' }, App.fmt.num(value, 2)),
                'col-sold': ({ value }) => h('span', { class: 'mono muted' }, Number(value) > 0 ? App.fmt.num(value, 2) : '—'),
                'col-frozen': ({ value }) => h('span', { class: 'mono muted' }, Number(value) > 0 ? App.fmt.num(value, 2) : '—'),
                'col-available': ({ value }) => h('b', { class: 'mono', style: `color:${Number(value) >= 0 ? 'var(--carbon-l)' : 'var(--danger-tx)'}` }, App.fmt.num(value, 2)),
                'col-_chk': ({ row }) => {
                  const expect = Number(row.total_allocated || 0) + Number(row.bought || 0)
                    - Number(row.used || 0) - Number(row.sold || 0) - Number(row.frozen || 0);
                  const diff = Number(row.available || 0) - expect;
                  return Math.abs(diff) < 0.01
                    ? h('span', { class: 'tag t-ok' }, '明细平衡')
                    : h('span', { class: 'tag t-danger', title: `按公式应为 ${App.fmt.num(expect, 2)}，账面为 ${App.fmt.num(row.available, 2)}` }, `差 ${App.fmt.num(diff, 2)}`);
                },
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
      onMounted(async () => {
        try {
          d.value = await App.API.get('/enterprise/analytics');
          setYear(d.value && d.value.reportYear);
        } catch (e) { App.notify.err(e.message); }
      });

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
              /* 【缺陷 P2-36】markLine 的 label 默认 position:'end' —— 文字落在绘图区
               * 右缘之外，正好与 x 轴末类目「2025Q4」/右轴刻度叠成"乱码"。
               * 改放线段起点上方（图内），不与任何边缘元素争位。 */
              markLine: {
                silent: true, symbol: 'none',
                lineStyle: { color: 'rgba(251,113,133,.7)', type: 'dashed' },
                label: { position: 'insideStartTop', formatter: '均值 {c}', color: '#fb7185', fontSize: 10.5 },
                data: [{ type: 'average', name: '均值' }],
              },
            },
          ],
        });
      });

      const mixOption = computed(() => {
        if (!d.value) return null;
        return App.chartBase({
          tooltip: Object.assign(App.chartBase().tooltip, { trigger: 'item', formatter: '{b}<br/>{c} tCO₂e（{d}%）' }),
          /* 【缺陷 P2-37】图例原来贴 right:6，长类目名（如「包装物焚烧（化石源）」）
           * 直接顶出卡片边缘被裁；只有一个分类时还会和圆环叠在一起。
           * 改为图例横排置底 + 圆环上移居中：无论几个分类都不争位。 */
          legend: {
            bottom: 2, left: 'center', type: 'scroll',
            itemWidth: 12, itemHeight: 8, itemGap: 14,
            textStyle: { fontSize: 10.5, color: '#8d9cb5' },
            pageIconSize: 9,
          },
          series: [{
            type: 'pie', radius: ['40%', '62%'], center: ['50%', '44%'],
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
            const lq = d.value.lastQuota || null;
            /* 本年度未分配配额时，四张卡显示 0 但必须说清"为什么是 0"，
             * 否则会被读成"系统没取到数"（2026-10-29 巡检 P0-4）。 */
            const quotaFoot = q.assigned
              ? ''
              : (lq ? `本年度未分配配额 · 最近一次为 ${lq.year} 年度 ${App.fmt.num(lq.total_allocated)} t` : '本年度未分配配额');
            /* 【2026-11-03】2026 年度已分配但尚未清缴时，「已履约使用 0」与
             * 「碳配额账户」页（2025 年度已用 302,858）并读会被当成矛盾。
             * 把"本年度的 0"和最近一次清缴年度写进卡脚，说清口径差异。 */
            const usedFoot = q.assigned
              ? (Number(q.used) > 0 ? ''
                : (lq ? `本年度尚未清缴 · 最近一次为 ${lq.year} 年度` : '本年度尚未清缴'))
              : quotaFoot;
            return [
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: '免费分配配额', value: App.fmt.num(q.total_allocated), unit: 'tCO₂e', icon: 'coin', tone: 'sky', foot: quotaFoot }),
                h('x-kpi', { label: '已履约使用', value: App.fmt.num(q.used), unit: 'tCO₂e', icon: 'fire', tone: 'carbon', foot: usedFoot }),
                h('x-kpi', { label: '已清缴 / 配额结余', value: `${App.fmt.num(q.used)} / ${App.fmt.num(Math.max(0, (q.total_allocated || 0) - (q.used || 0)))}`, unit: 'tCO₂e', icon: 'target', tone: 'violet', foot: usedFoot }),
                h('x-kpi', { label: '账户可用余额', value: App.fmt.num(q.available), unit: 'tCO₂e', icon: 'wallet', tone: q.assigned ? (Number(q.available) >= 0 ? 'carbon' : 'rose') : 'sky', foot: q.assigned ? '' : quotaFoot }),
              ]),
              h('div', { class: 'grid g-2-1 mb-16' }, [
                h('x-card', { title: '排放总量趋势' }, { default: () => h('x-chart', { option: trendOption.value, height: 'h300' }) }),
                h('x-card', { title: '能源结构排放占比', sub: `${YEAR.value} 年度` }, { default: () => h('x-chart', { option: mixOption.value, height: 'h300' }) }),
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
                /* 【缺陷 P2-40b】公钥原来只有一个 max-height:150px 的 pre，
                 * 评审"只看到 BEGIN 与半截 base64"就以为内容被裁掉 —— 其实是容器内滚动。
                 * ① 加「复制公钥」按钮：一键拿全文，不必进 pre 里拖选；
                 * ② foot 说明可滚动，消除"被裁切"的误会。 */
                h('dt', {}, '公钥'), h('dd', {}, [
                  h('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:6px' }, [
                    h('button', {
                      class: 'btn sm ghost', title: '复制完整公钥（PEM）',
                      onClick: async (e) => {
                        await App.copyText(d.value.publicKey);
                        e.target.textContent = '✓ 已复制';
                        setTimeout(() => { e.target.textContent = '复制公钥'; }, 1600);
                      },
                    }, '复制公钥'),
                  ]),
                  h('pre', { class: 'mono-pre', style: 'max-height:150px', title: 'PEM 公钥（容器内可滚动，复制按钮可取全文）' }, d.value.publicKey),
                ]),
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
        const oq = report.value.overQuota || {};
        const fc = f.forecast || [];
        return App.chartBase({
          legend: { data: ['预测累计排放', '年度配额'], top: 0, right: 6 },
          grid: { left: 10, right: 24, top: 34, bottom: 6, containLabel: true },
          xAxis: App.catAxis(fc.map((x) => x.date), { boundaryGap: false }),
          yAxis: App.valAxis({ name: 'tCO₂e', nameTextStyle: { color: '#5f6d85', fontSize: 10.5 } }),
          series: [
            {
              name: '预测累计排放', type: 'line', smooth: true, symbolSize: 6,
              data: fc.map((x) => Number(x.cumulative)),
              lineStyle: { color: '#f43f5e', width: 2.4 }, itemStyle: { color: '#fb7185' },
              areaStyle: { color: App.areaGrad('rgba(244,63,94,.3)', 'rgba(244,63,94,.01)') },
              /* 曲线只覆盖 horizonDays 天外推，而 KPI 写的是"预测期末（12-31）"。
               * 两者同屏却对不上，读者会以为卡片数字算错了（2026-10-29 巡检 P0-6）。
               * 这里把期末预测值画成参考线，让图与 KPI 同一口径。 */
              markLine: oq.predictedEoy
                ? {
                  silent: true, symbol: 'none',
                  lineStyle: { color: 'rgba(251,113,133,.55)', type: 'dotted', width: 1 },
                  label: {
                    formatter: `期末预测 ${App.fmt.big(oq.predictedEoy)}`,
                    color: '#fb7185', fontSize: 10.5, position: 'insideEndTop',
                  },
                  data: [{ yAxis: Number(oq.predictedEoy) }],
                }
                : undefined,
            },
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
            h('button', { class: 'btn sm', onClick: runTwin, disabled: busy.value }, [h('x-icon', { name: 'target', size: 14 }), busy.value ? '推演中…' : '数字孪生推演']),
            h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ]),
          default: () => !r ? h('div', { class: 'skel', style: 'height:260px' }) : (() => {
            /* 三处此前会把"算不出来"伪装成确定的 0：
             *  · 超限概率：后端样本不足时返回 null，`null * 100 + '%'` 得到 "0%"，
             *    等于告诉用户"绝不会超限"；
             *  · 占配额：配额为 0 时 gap/allocated 无意义，却输出 0%；
             *  · 预计缺口 227,723 t 与"超限概率 0%"同屏，结论互相打脸。
             * （2026-10-29 巡检 P0-6） */
            const oq = r.overQuota;
            const ep = oq.exceedProbability;
            const hasEp = ep !== null && ep !== undefined;
            return [
              h('div', { class: 'grid g4 mb-16' }, [
                h('x-kpi', { label: '预测期末排放', value: App.fmt.num(oq.predictedEoy, 0), unit: 'tCO₂e', icon: 'fire', tone: oq.gap > 0 ? 'rose' : 'carbon',
                  /* 速率与标题同源：取动态核算账口径（overQuota.rate），
                   * 不再用本页 30 天窗口自算的 avgDaily —— 两者差 3 倍会自相矛盾 */
                  foot: `滚动速率 ${oq.rate != null ? App.fmt.num(oq.rate, 1) : App.fmt.num(r.forecast.stats.avgDaily, 1)} tCO₂e/天（动态核算口径）` }),
                h('x-kpi', {
                  label: '预计缺口',
                  value: App.fmt.num(oq.gap, 0),
                  unit: 'tCO₂e',
                  icon: 'target',
                  tone: oq.gap > 0 ? 'rose' : 'carbon',
                  foot: oq.allocated > 0 ? `占配额 ${oq.gapRatio}%` : '本年度配额为 0，无法计算占配额比例',
                }),
                h('x-kpi', {
                  label: '超限概率',
                  value: hasEp ? `${(ep * 100).toFixed(1)}%` : '—',
                  icon: 'alert',
                  tone: hasEp ? (oq.riskLevel === 'HIGH' ? 'rose' : (oq.riskLevel === 'MEDIUM' ? 'violet' : 'carbon')) : 'sky',
                  foot: hasEp ? `风险等级 ${oq.riskLevel}（${oq.confidence} 置信）` : '近 30 天有效读数不足 7 天，未给出概率',
                }),
                h('x-kpi', { label: '异常读数', value: r.anomaly.anomalyCount, unit: '处', icon: 'shield', tone: r.anomaly.anomalyCount > 3 ? 'rose' : 'carbon' }),
              ]),

            h('div', { class: 'grid g2 mb-16' }, [
              h('x-card', { title: '预测累计排放 vs 年度配额', sub: `${r.forecast.horizonDays} 天外推 · ${r.forecast.method}` }, {
                default: () => h('x-chart', { option: predictOption.value, height: 'h300' }),
              }),
              h('x-card', { title: '减排建议', sub: 'ADVISOR 智能体生成' }, {
                default: () => h('div', { class: 'col gap-10' }, r.advisor.suggestions.map((s) => h('div', { class: 'alertbar info', style: 'flex-direction:column;align-items:flex-start;gap:6px' }, [
                  h('div', { class: 'flex gap-8', style: 'align-items:center' }, [
                    h('x-tag', { text: { TRADE: '配额履约', OFFSET: 'CCER 抵销', PRODUCTION: '生产优化', DATA: '数据核查', OK: '状态良好' }[s.type] || s.type, tone: s.priority === 'HIGH' ? 't-danger' : (s.priority === 'MEDIUM' ? 't-warn' : 't-ok') }),
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
                'col-zScore': ({ value }) => h('span', { class: 'mono', style: `color:${Math.abs(value) > 3.5 ? 'var(--danger-tx)' : '#fbbf24'}` }, value),
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
                'col-gap': ({ value }) => h('span', { class: 'mono', style: `color:${Number(value) > 0 ? 'var(--danger-tx)' : '#34d399'}` }, App.fmt.num(value, 0)),
                'col-quotaSurplus': ({ row }) => h('span', { class: row.quotaSurplus ? 'tag t-ok' : 'tag t-danger' }, row.quotaSurplus ? '有结余' : '有缺口'),
              }),
            }),
            ];
          })(),
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
