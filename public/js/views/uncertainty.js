/* =====================================================================
   uncertainty.js —— WP4 核算升级：不确定度、口径方法学与模型评估
   ---------------------------------------------------------------------
   ① /ent/uncertainty   企业「排放核算不确定度报告」
        · 数据准入五级门控（剔除归因逐项披露，而非只给一个"有效点数"）
        · 时间覆盖度（分母是"各排口自身观测跨度之和"，不是"窗口×排口数"）
        · 日均排放序列（残缺日已按"覆盖不足中位日 50%"排除并说明）
        · 贝叶斯后验区间（NIG 共轭，均值与方差同时未知）+ 先验敏感性扫描
        · GUM 误差传播（合成式、贡献分解、逐步代入、降不确定度建议）
        · 预测模型评估与消融实验（含"复杂模型未取胜"的诚实结论）
        · 两口径交叉校验（抽样随机性 vs 合成误差，系统项占比）
   ② /reg/uncertainty   监管「不确定度监管」
        · 行业汇总（企业间相对不确定度分布）
        · 已落库后验区间清单 + 批量重算

   本页面的立场：**不确定度不是要藏起来的缺点，而是报告可信度的组成部分。**
   把剔除率、覆盖缺口、系统项占比全部摆在明面上，比给一个漂亮的点估计更可信。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, reactive, onMounted } = Vue;
  const h = App.h;

  const STYLE_ID = 'unc-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
.unc-formula{background:var(--bg-0);border:1px solid var(--hair);border-radius:8px;padding:11px 13px;
  font-family:var(--mono);font-size:11.8px;line-height:1.85;color:var(--brand-l);word-break:break-all}
.unc-steps{counter-reset:unc}
.unc-step{display:flex;gap:11px;padding:9px 0;border-bottom:1px solid var(--hair)}
.unc-step:last-child{border-bottom:none}
.unc-step .no{flex:none;width:20px;height:20px;border-radius:6px;background:rgba(56,189,248,.14);
  color:#7dd3fc;font-family:var(--mono);font-size:11px;display:flex;align-items:center;justify-content:center;margin-top:1px}
.unc-step .tt{font-size:12.6px;color:var(--tx-0)}
.unc-step .fx{font-family:var(--mono);font-size:11.4px;color:var(--tx-3);margin-top:2px;word-break:break-all}
.unc-step .vv{font-family:var(--mono);font-size:11.8px;color:var(--brand-l);margin-top:3px;word-break:break-all}
.unc-note{font-size:12.2px;line-height:1.7;color:var(--tx-2)}
.unc-gate{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--hair)}
.unc-gate:last-child{border-bottom:none}
.unc-gate .ord{flex:none;font-family:var(--mono);font-size:11px;padding:2px 6px;border-radius:5px;
  background:rgba(167,139,250,.16);color:#c4b5fd}
.unc-gate .n{flex:1;font-size:12.4px}
.unc-gate .v{font-family:var(--mono);font-size:12.6px;color:var(--tx-0)}
.unc-quote{border-left:3px solid rgba(16,185,129,.5);padding:8px 12px;background:rgba(16,185,129,.05);
  border-radius:0 8px 8px 0;font-size:12.4px;line-height:1.75;color:var(--tx-1)}
`;
    document.head.appendChild(el);
  }

  /** 相对量（0.0594 → "±5.94%"） */
  const rel = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '-' : '±' + (v * 100).toFixed(d) + '%';
  const pct = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '-' : (v * 100).toFixed(d) + '%';
  const num = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '-' : App.fmt.num(v, d);

  function kpiGrid(items) {
    return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(178px,1fr))' },
      items.map((k) => h('x-kpi', k)));
  }

  /* 门控归因的中文名与顺序（顺序即披露顺序，与后端 gate() 的判定顺序一致） */
  const GATE_REASON = [
    { key: 'watchdog', name: '看门狗占位记录', why: '平台补记的离线占位，不是设备上报，只能用于链路可用性统计' },
    { key: 'nonPositive', name: '零值 / 负值读数', why: '停机或校准态，是真实工况但不构成排放' },
    { key: 'qualityFlag', name: '质量标记不合格', why: 'MISSING / DRIFT / OFFLINE / CALIBRATION 态读数不具代表性' },
    { key: 'implausible', name: '超工程上限', why: '瞬时速率超物理可能上限，属仪表故障或量纲错误' },
    { key: 'outlier', name: '稳健离群', why: '对数空间 |z| 超阈值且超同排口稳健中位数若干倍' },
  ];

  /* ==================================================================
   * ① 企业端：不确定度报告
   * ================================================================== */
  const PageEntUncertainty = defineComponent({
    name: 'page-ent-uncertainty',
    setup() {
      injectStyle();
      const isEnt = !!(App.Store.user && App.Store.user.role === 'ENTERPRISE');
      const entId = ref(isEnt ? Number(App.Store.user.orgId) : null);
      const ents = ref([]);
      const loading = ref(false);
      const anchoring = ref(false);
      const err = ref('');
      const series = ref(null);
      const post = ref(null);
      const prop = ref(null);
      const model = ref(null);
      const catalog = ref(null);

      const entOptions = computed(() => (isEnt
        ? [{ id: entId.value, entName: App.Store.user.orgName || '本企业' }]
        : ents.value));

      async function loadEnts() {
        if (isEnt) return;
        try {
          /* 公开名录接口：核查端无 REGULATOR 权限，用 /regulator/enterprises 会 403 */
          const d = await App.API.get('/public/enterprises', { page: 1, size: 200 });
          ents.value = ((d && (d.rows || d)) || []).map((x) => ({ id: x.id, entName: x.ent_name }));
          if (!entId.value && ents.value.length) entId.value = ents.value[0].id;
        } catch (e) { ents.value = []; }
      }

      async function loadAll() {
        if (!entId.value) return;
        loading.value = true; err.value = '';
        const id = entId.value;
        try {
          const [s, p, g, m] = await Promise.all([
            App.API.get('/uncertainty/series/' + id),
            App.API.get('/uncertainty/posterior/' + id),
            App.API.get('/uncertainty/propagate/' + id),
            App.API.get('/uncertainty/model/' + id),
          ]);
          series.value = s; post.value = p; prop.value = g; model.value = m;
        } catch (e) { err.value = e.message; }
        finally { loading.value = false; }
      }

      async function anchor() {
        if (!entId.value) return;
        if (!(await App.confirm('将本企业的核算不确定度报告摘要写入联盟链存证？\n\n该动作会在链上留下不可篡改的记录（区块 +1），并写入操作审计日志。'))) return;
        anchoring.value = true;
        try {
          const r = await App.API.post('/uncertainty/report/' + entId.value + '/anchor', {});
          App.notify.ok(`报告已上链：区块 #${(r.chain && (r.chain.blockIndex || r.chain.block)) || '—'}`);
          await Promise.all([App.API.get('/uncertainty/list').catch(() => null)]);
        } catch (e) { App.notify.err(e.message); }
        finally { anchoring.value = false; }
      }

      onMounted(async () => { catalog.value = await App.API.get('/uncertainty/catalog').catch(() => null); await loadEnts(); await loadAll(); });

      /* 日均排放序列图 */
      function seriesOption() {
        const s = (series.value && series.value.series) || [];
        return App.chartBase({
          grid: { left: 8, right: 18, top: 26, bottom: 6, containLabel: true },
          legend: { show: false },
          tooltip: { trigger: 'axis', backgroundColor: 'rgba(10,16,32,.96)', borderColor: 'rgba(255,255,255,.16)',
            textStyle: { color: '#eef4ff', fontSize: 12 } },
          xAxis: App.catAxis(s.map((x) => String(x.day).slice(5))),
          yAxis: App.valAxis({ name: 'tCO2e/日', nameTextStyle: { color: '#8d9cb5', fontSize: 11 } }),
          series: [{
            type: 'line', name: '日均排放', smooth: true, symbol: 'circle', symbolSize: 5,
            data: s.map((x) => x.emission),
            lineStyle: { width: 2, color: '#10b981' },
            itemStyle: { color: '#10b981' },
            areaStyle: { color: App.areaGrad('rgba(16,185,129,.30)', 'rgba(16,185,129,.02)') },
          }],
        });
      }

      return () => {
        const s = series.value || {};
        const g = (s.gating) || {};
        const cov = (s.coverage) || {};
        const p = post.value || {};
        const an = p.annual || null;
        const pr = prop.value || {};
        const md = model.value || {};
        const br = g.byReason || {};

        const covTone = cov.ratio >= 0.95 ? 'carbon' : (cov.ratio >= 0.8 ? 'amber' : 'rose');
        const relHalf = an && an.relHalfWidth != null ? an.relHalfWidth : null;

        return h('x-page', {
          title: '排放核算不确定度报告',
          desc: '把"这个数字有多准"与"这个数字是多少"放在同一张报告上 · 门控剔除、采样覆盖、随机性与系统性误差全部可追溯',
        }, {
          actions: () => [
            !isEnt && entOptions.value.length
              ? h('select', {
                class: 'input', style: 'width:190px;height:30px', value: entId.value,
                onChange: (e) => { entId.value = Number(e.target.value); loadAll(); },
              }, entOptions.value.map((o) => h('option', { value: o.id }, o.entName)))
              : null,
            h('button', { class: 'btn sm ghost', onClick: loadAll }, [h('x-icon', { name: 'refresh', size: 14 }), '重新计算']),
            h('button', { class: 'btn sm primary', disabled: anchoring.value, onClick: anchor },
              [h('x-icon', { name: 'chain', size: 14 }), anchoring.value ? '上链中…' : '报告上链存证']),
          ],
          default: () => {
            if (err.value) return h('div', { class: 'alertbar err' }, [h('x-icon', { name: 'alert', size: 15 }), err.value]);
            if (!s.entId) return h('div', { class: 'card' }, [h('div', { class: 'card-body' }, '正在计算…')]);

            return [
              App.staticNote('当前为静态演示模式：不确定度报告为快照时点计算结果（非实时重算）；报告上链仅在本页会话内可见。'),
              /* ── 观测不足提示 ──
               * 后端在有效日均观测点 < 3 时返回 available:false + reason（区间估计至少要 3 个点）。
               * 此前前端从不渲染该状态：页面摆满裸 "-"、先验扫描显示"无扫描结果"，
               * 用户无从得知为什么统计栏全空。这里把后端原因如实前置披露。 */
              p.available === false && p.reason
                ? h('div', { class: 'alertbar warn mt-16' }, [
                  h('x-icon', { name: 'alert', size: 15 }),
                  h('span', {}, [
                    h('b', {}, '区间估计暂不可用：'),
                    p.reason,
                    ' 下方门控、覆盖度等数据准入事实仍如实展示；观测累积到 3 天以上后自动恢复完整区间估计。',
                  ]),
                ])
                : null,
              /* ── 概览 KPI ── */
              kpiGrid([
                { label: '年度排放（后验均值）', value: an ? App.fmt.num(an.mean, 0) : '-', unit: 'tCO2e', tone: 'carbon', icon: 'leaf', foot: an ? `95% 区间 ${App.fmt.num(an.low, 0)} ~ ${App.fmt.num(an.high, 0)}` : '' },
                { label: '年化相对半宽', value: relHalf != null ? (relHalf * 100).toFixed(2) : '-', unit: '%', tone: relHalf != null && relHalf < 0.05 ? 'carbon' : 'amber', icon: 'target', foot: '抽样随机性 · 观测增多可收窄' },
                { label: '合成相对不确定度', value: pr.relativeUncertainty != null ? (pr.relativeUncertainty * 100).toFixed(2) : '-', unit: '%', tone: 'sky', icon: 'layers', foot: 'GUM 口径 · 含不随观测变小的系统项' },
                { label: '有效观测天数', value: App.fmt.num(s.days || 0), unit: '天', tone: 'violet', icon: 'clock', foot: s.incompleteDays ? `排除残缺日 ${s.incompleteDays} 天` : '无残缺日' },
                { label: '时间覆盖度', value: cov.ratio != null ? (cov.ratio * 100).toFixed(2) : '-', unit: '%', tone: covTone, icon: 'shield', foot: `缺口 ${App.fmt.num(cov.gapMinutes || 0, 0)} 分钟 · 最大连续缺口 ${App.fmt.num(cov.maxGapMinutes || 0, 0)} 分钟` },
                { label: '数据剔除率', value: g.excludeRate != null ? (g.excludeRate * 100).toFixed(2) : '-', unit: '%', tone: (g.excludeRate || 0) > 0.15 ? 'rose' : 'carbon', icon: 'filter', foot: `原始 ${App.fmt.num(g.raw || 0)} 条 → 保留 ${App.fmt.num(g.kept || 0)} 条` },
                { label: '配额年化', value: p.quotaAnnual ? App.fmt.num(p.quotaAnnual, 0) : '-', unit: 'tCO2e', tone: 'chain', icon: 'coin', foot: p.quotaRatio ? `排放/配额 = ${(p.quotaRatio * 100).toFixed(1)}%` : '' },
                { label: '结论口径', value: p.available === false ? '数据不足' : (p.priorSafe ? '数据主导' : '先验敏感'), unit: '', tone: p.available === false ? 'amber' : (p.priorSafe ? 'carbon' : 'amber'), icon: 'check', foot: p.available === false ? '观测点不足，无法评估' : (p.priorSafe ? '弱先验自证通过' : '须复核先验取值') },
              ]),

              /* ── 门控 + 覆盖度 ── */
              h('div', { class: 'grid mt-16', style: 'grid-template-columns:1.05fr .95fr' }, [
                h('x-card', {
                  title: '数据准入五级门控（与平台实时核算完全同一套规则）',
                  sub: '归因顺序即披露顺序：先剔除来源不合法的，再剔除数值不可能与统计离群的',
                }, {
                  default: () => h('div', { class: 'card-body' }, [
                    ...GATE_REASON.map((r, i) => h('div', { class: 'unc-gate' }, [
                      h('span', { class: 'ord' }, String(i + 1)),
                      h('div', { class: 'n' }, [
                        h('div', {}, r.name),
                        h('div', { class: 'tiny dim', style: 'margin-top:2px' }, r.why),
                      ]),
                      h('span', { class: 'v' }, App.fmt.num(br[r.key] || 0) + ' 条'),
                    ])),
                    h('div', { class: 'flex between mt-16', style: 'padding-top:10px;border-top:1px solid var(--hair)' }, [
                      h('span', { class: 'unc-note' }, '合计剔除'),
                      h('b', { class: 'mono' }, `${App.fmt.num((g.raw || 0) - (g.kept || 0))} / ${App.fmt.num(g.raw || 0)} 条（${pct(g.excludeRate)}）`),
                    ]),
                    (g.notes || []).length
                      ? h('div', { class: 'col gap-6 mt-12' }, (g.notes || []).map((n) =>
                        h('div', { class: 'unc-note' }, App.fmt.md(n))))
                      : null,
                  ]),
                }),

                h('x-card', {
                  title: '时间覆盖度与采样密度',
                  sub: '分母是「各排口自身观测跨度之和」—— 用全局窗口×排口数会把偶尔冒一次数的测试设备算进来，低估覆盖度',
                }, {
                  default: () => h('div', { class: 'card-body' }, [
                    h('div', { class: 'grid g2' }, [
                      h('div', {}, [h('div', { class: 'tiny dim' }, '合法覆盖时长'), h('div', { class: 'mono', style: 'font-size:15px' }, App.fmt.num(cov.coveredMinutes || 0, 0) + ' 分钟')]),
                      h('div', {}, [h('div', { class: 'tiny dim' }, '各排口自身跨度之和'), h('div', { class: 'mono', style: 'font-size:15px' }, App.fmt.num(cov.ownSpanMinutes || 0, 0) + ' 分钟')]),
                      h('div', {}, [h('div', { class: 'tiny dim' }, '活跃排口 / 台账排口'), h('div', { class: 'mono', style: 'font-size:15px' }, `${cov.activeMonitors || 0} / ${cov.monitors || 0}`)]),
                      h('div', {}, [h('div', { class: 'tiny dim' }, '采样密度（条/小时）'), h('div', { class: 'mono', style: 'font-size:15px' }, num(cov.sampleDensityPerHour, 2))]),
                      h('div', {}, [h('div', { class: 'tiny dim' }, '名义周期'), h('div', { class: 'mono', style: 'font-size:15px' }, (cov.nominalIntervalMin || 0) + ' 分钟')]),
                      h('div', {}, [h('div', { class: 'tiny dim' }, '替代值占比'), h('div', { class: 'mono', style: 'font-size:15px' }, pct(s.substituteRatio))]),
                    ]),
                    cov.note ? h('div', { class: 'unc-quote mt-16' }, App.fmt.md(cov.note)) : null,
                    h('div', { class: 'unc-formula mt-16' },
                      '排放量 = Σ rateᵢ × min(Δtᵢ, 名义周期) ÷ 60   —— 步进积分，末点不外推'),
                    s.dayNote ? h('div', { class: 'unc-note mt-12' }, App.fmt.md(s.dayNote)) : null,
                    (cov.monitorDetail || []).length
                      ? h('div', { class: 'mt-16' }, [h('x-table', {
                        columns: [
                          { key: 'monitor', title: '排口', width: '110px' },
                          { key: 'readings', title: '读数条数', align: 'right', width: '90px' },
                          { key: 'ownSpanMin', title: '自身跨度(分)', align: 'right', width: '110px' },
                          { key: 'coveredMin', title: '覆盖(分)', align: 'right', width: '100px' },
                          { key: 'gapMin', title: '缺口(分)', align: 'right' },
                        ],
                        rows: cov.monitorDetail,
                        rowKey: 'monitor',
                        empty: '无活跃排口',
                      }, {
                        'col-monitor': ({ row }) => h('span', { class: 'tag t-info plain' }, row.monitor),
                        'col-readings': ({ row }) => App.fmt.num(row.readings),
                        'col-ownSpanMin': ({ row }) => App.fmt.num(row.ownSpanMin),
                        'col-coveredMin': ({ row }) => App.fmt.num(row.coveredMin),
                        'col-gapMin': ({ row }) => h('span', { class: row.gapMin > 0 ? '' : 'dim' }, App.fmt.num(row.gapMin)),
                      })])
                      : null,
                  ]),
                }),
              ]),

              /* ── 日均序列 ── */
              h('x-card', {
                title: '日均排放序列（已排除残缺日）',
                sub: '残缺日只反映窗口内那几小时，与整日不可比；混入会把样本方差抬高一个量级',
                class: 'mt-16',
              }, { default: () => h('div', { class: 'card-body' }, [h('x-chart', { option: seriesOption(), height: 'h260', loading: loading.value })]) }),

              /* ── 后验区间 + 先验敏感性 ── */
              h('div', { class: 'grid mt-16', style: 'grid-template-columns:1fr 1fr' }, [
                h('x-card', { title: '贝叶斯后验区间（Normal-Inverse-Gamma 共轭）', sub: '均值与方差同时未知；均值边缘后验为 t 分布' }, {
                  default: () => h('div', { class: 'card-body' }, [
                    h('div', { class: 'grid g2' }, [
                      h('div', {}, [h('div', { class: 'tiny dim' }, '日均排放均值'), h('div', { class: 'mono', style: 'font-size:15px' }, num(p.mean, 3) + ' tCO2e/日')]),
                      h('div', {}, [h('div', { class: 'tiny dim' }, '日均标准差'), h('div', { class: 'mono', style: 'font-size:15px' }, num(p.sd, 3))]),
                      h('div', {}, [h('div', { class: 'tiny dim' }, `${((p.level || 0.95) * 100).toFixed(0)}% 区间`), h('div', { class: 'mono', style: 'font-size:13.5px' }, `${num(p.ciLow, 2)} ~ ${num(p.ciHigh, 2)}`)]),
                      h('div', {}, [h('div', { class: 'tiny dim' }, '观测点数'), h('div', { class: 'mono', style: 'font-size:15px' }, App.fmt.num(p.nObs || 0))]),
                    ]),
                    an ? h('div', { class: 'unc-formula mt-16' },
                      `年度 = 日均均值 × 365 = ${num(p.mean, 3)} × 365 = ${App.fmt.num(an.mean, 1)} tCO2e\n`
                      + `区间 = [${App.fmt.num(an.low, 0)}, ${App.fmt.num(an.high, 0)}] tCO2e（半宽 ${rel(an.relHalfWidth)}）`) : null,
                    p.classical ? h('div', { class: 'mt-12' }, [
                      h('div', { class: 'tiny dim mb-8' }, '与经典 t 区间的对照（α₀ = 0.5 使自由度 ≈ n + 1，两者可比）'),
                      h('div', { class: 'flex gap-12' }, [
                        h('span', { class: 'unc-note' }, '经典 t 半宽 ' + num(p.classical.halfWidth, 3)),
                        h('span', { class: 'unc-note' }, `差异 ${pct(p.classicalDelta, 2)}`),
                      ]),
                    ]) : null,
                    p.disclaimer ? h('div', { class: 'unc-quote mt-16' }, App.fmt.md(p.disclaimer)) : null,
                  ]),
                }),

                h('x-card', { title: '先验敏感性扫描（弱先验自证）', sub: 'κ₀ 跨 4 个数量级，看结论是否被先验牵引' }, {
                  default: () => h('div', { class: 'card-body' }, [
                    h('x-table', {
                      columns: [
                        { key: 'kappa0', title: 'κ₀', align: 'right', width: '76px' },
                        { key: 'mean', title: '日均点估计', align: 'right' },
                        { key: 'meanShiftPct', title: '相对基准偏移', align: 'right' },
                        { key: 'halfWidthShiftPct', title: '区间半宽变化', align: 'right' },
                      ],
                      rows: p.priorSweep || [],
                      rowKey: 'kappa0',
                      empty: '无扫描结果',
                    }, {
                      'col-kappa0': ({ row }) => h('span', { class: row.kappa0 <= 1 ? 'tag t-ok plain' : 'tag t-warn plain' }, String(row.kappa0)),
                      'col-mean': ({ row }) => num(row.mean, 4),
                      'col-meanShiftPct': ({ row }) => h('span', { class: Math.abs(row.meanShiftPct || 0) >= 2 ? '' : 'dim' }, (row.meanShiftPct >= 0 ? '+' : '') + num(row.meanShiftPct, 2) + '%'),
                      'col-halfWidthShiftPct': ({ row }) => (row.halfWidthShiftPct >= 0 ? '+' : '') + num(row.halfWidthShiftPct, 2) + '%',
                    }),
                    h('div', { class: ['readout', p.priorSafe ? 'pass' : 'fail'], style: 'margin-top:14px' }, [
                      h('span', { class: 'flag' }, p.priorSafe ? 'PASS' : 'FAIL'),
                      /* 标签与结论必须同向：此前无论 PASS/FAIL 都写死"结论稳定"，
                       * 出现"FAIL · 结论稳定"的自相矛盾展示。 */
                      h('span', { class: 'k' }, p.priorSafe
                        ? '弱先验档（κ₀ ≤ 1）结论稳定'
                        : (p.maxShift == null ? '弱先验档（κ₀ ≤ 1）· 观测不足，暂无法自证' : '弱先验档（κ₀ ≤ 1）· 结论受先验牵引，须复核')),
                      h('span', { class: 'mono', style: 'margin-left:auto;color:var(--tx-3)' }, '最大偏移 ' + num(p.maxShift, 2) + '%'),
                    ]),
                    p.priorVerdict ? h('div', { class: 'unc-note mt-12' }, App.fmt.md(p.priorVerdict)) : null,
                  ]),
                }),
              ]),

              /* ── GUM 误差传播 ── */
              h('x-card', {
                title: 'GUM 误差传播（合成不确定度，与贝叶斯口径相互独立）',
                sub: pr.method,
                class: 'mt-16',
              }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'grid g2' }, [
                    h('div', {}, [
                      h('div', { class: 'unc-formula' }, pr.steps && pr.steps.length
                        ? pr.steps.map((st) => `【${st.title}】${st.formula}  ⇒  ${st.value}`).join('\n')
                        : '—'),
                      pr.guidance ? h('div', { class: 'unc-quote mt-16' }, App.fmt.md(pr.guidance)) : null,
                    ]),
                    h('div', {}, [
                      h('x-table', {
                        columns: [
                          { key: 'name', title: '不确定度来源' },
                          { key: 'relative', title: '分量值', align: 'right', width: '96px' },
                          { key: 'shareV', title: '贡献占比', align: 'right', width: '96px' },
                        ],
                        rows: (pr.components || []).map((c) => Object.assign({}, c, {
                          shareV: (pr.contributions || []).find((x) => x.key === c.key)
                            ? (pr.contributions.find((x) => x.key === c.key).share * 100) : null,
                        })),
                        rowKey: 'key',
                        empty: '无分量',
                      }, {
                        'col-name': ({ row }) => h('div', {}, [
                          h('div', { style: 'font-size:12.5px' }, row.name),
                          h('div', { class: 'tiny dim', style: 'margin-top:3px;line-height:1.6' }, row.basis),
                        ]),
                        'col-relative': ({ row }) => rel(row.relative),
                        'col-shareV': ({ row }) => h('span', { class: row.shareV >= 50 ? '' : 'dim' }, row.shareV != null ? row.shareV.toFixed(1) + '%' : '-'),
                      }),
                    ]),
                  ]),
                ]),
              }),

              /* ── 模型评估 + 消融 ── */
              h('div', { class: 'grid mt-16', style: 'grid-template-columns:1fr 1fr' }, [
                h('x-card', { title: '预测模型留出法评估', sub: `训练 ${md.nTrain || 0} 天 / 留出 ${md.nTest || 0} 天 · 以 MAPE 为主判据` }, {
                  default: () => h('div', { class: 'card-body' }, [
                    h('x-table', {
                      columns: [
                        { key: 'model', title: '模型', width: '132px' },
                        { key: 'mape', title: 'MAPE', align: 'right' },
                        { key: 'rmse', title: 'RMSE', align: 'right' },
                        { key: 'r2', title: 'R²', align: 'right' },
                      ],
                      rows: md.models || [],
                      rowKey: 'model',
                      empty: '无评估结果',
                    }, {
                      'col-model': ({ row }) => h('span', { class: row.model === 'TREND+SEASON' ? 'tag t-chain plain' : 'tag t-mute plain' }, row.model),
                      'col-mape': ({ row }) => row.mape != null ? row.mape.toFixed(2) + '%' : '-',
                      'col-rmse': ({ row }) => num(row.rmse, 3),
                      'col-r2': ({ row }) => (row.r2 == null || !isFinite(row.r2)) ? h('span', { class: 'dim' }, '—') : row.r2.toFixed(3),
                    }),
                    md.note ? h('div', { class: 'unc-note mt-12' }, App.fmt.md(md.note)) : null,
                  ]),
                }),

                h('x-card', { title: '消融实验：每个组件是否真的带来信息', sub: '从完整模型出发逐项剔除，看 MAPE 如何变化' }, {
                  default: () => h('div', { class: 'card-body' }, [
                    h('x-table', {
                      columns: [
                        { key: 'variant', title: '变体' },
                        { key: 'removed', title: '剔除项', width: '110px' },
                        { key: 'mape', title: 'MAPE', align: 'right', width: '82px' },
                        { key: 'deltaMape', title: 'ΔMAPE', align: 'right', width: '82px' },
                      ],
                      rows: md.ablation || [],
                      rowKey: 'variant',
                      empty: '无消融结果',
                    }, {
                      'col-variant': ({ row }) => h('div', {}, [
                        h('div', { style: 'font-size:12.5px' }, row.variant),
                        row.note ? h('div', { class: 'tiny dim', style: 'margin-top:2px' }, row.note) : null,
                      ]),
                      'col-removed': ({ row }) => row.removed ? h('span', { class: 'tag t-warn plain' }, row.removed) : h('span', { class: 'dim' }, '—'),
                      'col-mape': ({ row }) => row.mape != null ? row.mape.toFixed(2) + '%' : '-',
                      'col-deltaMape': ({ row }) => h('span', { class: row.deltaMape == null || row.deltaMape <= 0 ? 'dim' : '' },
                        row.deltaMape == null ? '-' : (row.deltaMape >= 0 ? '+' : '') + row.deltaMape.toFixed(2) + '%'),
                    }),
                    md.verdict ? h('div', { class: 'unc-quote mt-16' }, App.fmt.md(md.verdict)) : null,
                  ]),
                }),
              ]),

              /* ── 两口径交叉校验 ── */
              prop.value && prop.value.guidance !== undefined
                ? h('x-card', { title: '两口径交叉校验（这是本模块最该被追问的一处）', sub: '贝叶斯区间刻画「抽样随机性」，GUM 合成刻画「报告值误差」，两者量的不是同一件事', class: 'mt-16' }, {
                  default: () => {
                    const cc = crossCheckLocal();
                    if (!cc) return h('div', { class: 'card-body' }, [h('x-empty', { title: '暂无对照数据', sub: '完成一次全平台重算后即可生成对照', icon: 'target', tone: 'data' })]);
                    return h('div', { class: 'card-body' }, [
                      h('div', { class: 'grid g2' }, [
                        h('div', { class: 'card', style: 'padding:13px 15px' }, [
                          h('div', { class: 'tiny dim mb-8' }, '贝叶斯：抽样随机性'),
                          h('div', { class: 'mono', style: 'font-size:16px' }, rel(cc.bayesian.k1Relative)),
                          h('div', { class: 'tiny dim mt-8', style: 'line-height:1.65' }, cc.bayesian.meaning),
                          h('div', { class: 'tiny mono mt-8' }, '95% 区间半宽 ' + num(cc.bayesian.halfWidth, 3)),
                        ]),
                        h('div', { class: 'card', style: 'padding:13px 15px' }, [
                          h('div', { class: 'tiny dim mb-8' }, 'GUM：报告值合成误差'),
                          h('div', { class: 'mono', style: 'font-size:16px' }, rel(cc.gum.k1Relative)),
                          h('div', { class: 'tiny dim mt-8', style: 'line-height:1.65' }, cc.gum.meaning),
                          h('div', { class: 'tiny mono mt-8' }, `随机项 ${rel(cc.gum.randomPart)} · 系统项 ${rel(cc.gum.systematicPart)}`),
                        ]),
                      ]),
                      h('div', { class: ['readout', cc.consistent ? 'pass' : 'fail'], style: 'margin-top:14px' }, [
                        h('span', { class: 'flag' }, cc.consistent ? 'PASS' : 'FAIL'),
                        h('span', { class: 'k' }, '必要条件 u_GUM ≥ u_Bayes 成立（反过来说明分级缺省值被低估）'),
                        h('span', { class: 'mono', style: 'margin-left:auto;color:var(--tx-3)' }, '比值 ' + num(cc.ratio, 2)),
                      ]),
                      h('div', { class: 'unc-formula mt-16' }, '系统项占比 = ' + pct(cc.systematicShare, 1)
                        + '  ← 该项占绝对多数时，继续加密采样收益有限，降不确定度要从校准与凭证入手'),
                      cc.verdict ? h('div', { class: 'unc-note mt-12' }, App.fmt.md(cc.verdict)) : null,
                    ]);
                  },
                })
                : null,

              /* ── 方法学依据 ── */
              catalog.value ? h('x-card', { title: '方法学依据与常量', sub: '评审可以逐条核对：标准、门控规则、积分口径、分级缺省不确定度', class: 'mt-16' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' }, [
                    h('div', {}, [
                      h('div', { class: 'tiny dim mb-8' }, '依据标准'),
                      h('div', { class: 'col gap-5' }, (catalog.value.standard || []).map((x) =>
                        h('div', { class: 'unc-note' }, '· ' + x))),
                      h('div', { class: 'tiny dim mb-8 mt-16' }, '积分口径'),
                      h('div', { class: 'unc-formula' }, catalog.value.integration.rule + '\n\n' + catalog.value.integration.why),
                    ]),
                    h('div', {}, [
                      h('div', { class: 'tiny dim mb-8' }, '分级缺省不确定度（k = 1）'),
                      h('x-table', {
                        columns: [
                          { key: 'k', title: '档位' },
                          { key: 'v', title: '取值', align: 'right', width: '88px' },
                        ],
                        rows: [
                          { k: 'CEMS 有效覆盖 ≥ 95%', v: rel(catalog.value.tiers.cemsHigh) },
                          { k: 'CEMS 有效覆盖 80~95%', v: rel(catalog.value.tiers.cemsMid) },
                          { k: 'CEMS 有效覆盖 < 80%', v: rel(catalog.value.tiers.cemsLow) },
                          { k: '时间缺口替代值', v: rel(catalog.value.tiers.substitute) },
                          { k: '区域电网基准线因子', v: rel(catalog.value.tiers.gridFactor) },
                          { k: '电能计量', v: rel(catalog.value.tiers.metering) },
                          { k: '缺省排放因子', v: rel(catalog.value.tiers.defaultFactor) },
                        ],
                        rowKey: 'k',
                        empty: '—',
                      }, { 'col-v': ({ row }) => h('span', { class: 'mono' }, row.v) }),
                      h('div', { class: 'tiny dim mb-8 mt-16' }, '工程常量'),
                      h('div', { class: 'unc-formula' }, Object.keys(catalog.value.constants || {})
                        .map((k) => `${k} = ${catalog.value.constants[k]}`).join('\n')),
                    ]),
                  ]),
                ]),
              }) : null,
            ];
          },
        });
      };

      /** 两口径对照从 /propagate 与 /posterior 的既有结果本地合成（避免再打一次接口） */
      function crossCheckLocal() {
        const p = post.value || {};
        const pr = prop.value || {};
        const an = p.annual;
        if (!an || pr.relativeUncertainty == null) return null;
        const uBayes = an.relHalfWidth != null ? an.relHalfWidth / 1.96 : null;
        const uGum = pr.relativeUncertainty;
        const w1 = (pr.weights && pr.weights.scope1) || 0;
        const gapComp = (pr.components || []).find((c) => c.key === 'gap');
        const uRandom = Math.abs(w1 * (gapComp ? gapComp.relative : 0));
        const uSystematic = uGum > uRandom ? Math.sqrt(uGum * uGum - uRandom * uRandom) : 0;
        return {
          bayesian: { k1Relative: uBayes, halfWidth: an.halfWidth, meaning: '抽样随机性（可随观测点增多而收窄）' },
          gum: { k1Relative: uGum, randomPart: uRandom, systematicPart: uSystematic, meaning: '报告值的合成误差（含不随观测增多的系统性项）' },
          ratio: uBayes ? uGum / uBayes : null,
          consistent: uGum >= (uBayes || 0) - 1e-12,
          systematicShare: uGum > 0 ? (uSystematic / uGum) ** 2 : 0,
          verdict: null,
        };
      }
    },
  });

  /* ==================================================================
   * ② 监管端：不确定度监管
   * ================================================================== */
  const PageRegUncertainty = defineComponent({
    name: 'page-reg-uncertainty',
    setup() {
      injectStyle();
      const ind = ref(null);
      const rows = ref([]);
      const models = ref([]);
      const loading = ref(false);
      const busy = ref(false);
      const limit = ref(20);

      async function loadIndustry() {
        loading.value = true;
        try { ind.value = await App.API.get('/uncertainty/industry', { limit: limit.value }); }
        catch (e) { ind.value = null; }
        finally { loading.value = false; }
      }
      async function loadList() {
        try { rows.value = (await App.API.get('/uncertainty/list')) || []; } catch (e) { rows.value = []; }
        try { models.value = (await App.API.get('/uncertainty/models')) || []; } catch (e) { models.value = []; }
      }
      async function recompute() {
        if (!(await App.confirm('对全平台 60 家控排企业重算后验区间并落库？\n\n该操作会遍历各企业的实测读数序列，耗时较长，结果写入 uncertainty_posterior 表。'))) return;
        busy.value = true;
        try {
          const r = await App.API.post('/uncertainty/recompute', {});
          App.notify.ok(`重算完成：成功落库 ${r.saved} / 共 ${r.total} 家`);
          await Promise.all([loadIndustry(), loadList()]);
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      onMounted(() => { loadIndustry(); loadList(); });

      return () => {
        const d = ind.value || {};
        const items = (d.items || []).slice().sort((a, b) => (b.relHalfWidth || 0) - (a.relHalfWidth || 0));
        return h('x-page', {
          title: '不确定度监管',
          desc: '相对不确定度是报告质量的可比指标 · 相对半宽越大的企业，越应先从仪器校准与凭证完备性入手，而非继续加密采样',
        }, {
          actions: () => [
            h('select', {
              class: 'input', style: 'width:110px;height:30px', value: limit.value,
              'aria-label': '榜单企业数',
              onChange: (e) => { limit.value = Number(e.target.value); loadIndustry(); },
            }, [10, 20, 40, 60].map((n) => h('option', { value: n }, '前 ' + n + ' 家'))),
            h('button', { class: 'btn sm ghost', onClick: () => { loadIndustry(); loadList(); } }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
            h('button', { class: 'btn sm primary', disabled: busy.value, onClick: recompute },
              [h('x-icon', { name: 'play', size: 14 }), busy.value ? '重算中…' : '全平台重算']),
          ],
          default: () => [
            App.staticNote('当前为静态演示模式：行业汇总与落库台账为快照时点值；「全平台重算」在静态模式下不会真正重算。'),
            kpiGrid([
              { label: '扫描企业', value: App.fmt.num(d.scanned || 0), unit: '家', tone: 'sky', icon: 'factory', foot: `可评估 ${d.available || 0} 家（有效观测 ≥ 3 天）` },
              { label: '平均覆盖度', value: pct(d.avgCoverage, 2), unit: '', tone: 'carbon', icon: 'shield', foot: '各企业时间维度的有效采样占比' },
              { label: '平均相对半宽', value: pct(d.avgRelHalfWidth, 2), unit: '', tone: 'violet', icon: 'target', foot: '95% 区间半宽 / 日均值' },
              { label: '超工程上限读数', value: App.fmt.num(d.totalImplausibleRows || 0), unit: '条', tone: (d.totalImplausibleRows || 0) ? 'rose' : 'carbon', icon: 'alert', foot: '已被统一门控剔除，不进核算' },
              { label: '已落库后验记录', value: App.fmt.num(rows.value.length), unit: '条', tone: 'chain', icon: 'db', foot: 'uncertainty_posterior 台账' },
              { label: '已落库模型评估', value: App.fmt.num(models.value.length), unit: '条', tone: 'sky', icon: 'chart', foot: 'model_eval 台账（每企业每模型一行）' },
            ]),

            h('x-card', {
              title: '企业间相对不确定度分布（降序）',
              sub: '把不确定度当成可比指标公开，是"监管可问责"的前提 —— 只报点估计而不报不确定度的报告无法横向比较',
              class: 'mt-16',
            }, {
              default: () => h('div', { class: 'card-body flush' }, [
                h('x-table', {
                  columns: [
                    { key: 'entName', title: '企业' },
                    { key: 'industry', title: '行业', width: '100px' },
                    { key: 'region', title: '区域', width: '96px' },
                    { key: 'days', title: '有效天数', align: 'right', width: '92px' },
                    { key: 'coverage', title: '覆盖度', align: 'right', width: '92px' },
                    { key: 'dailyMean', title: '日均排放', align: 'right', width: '110px' },
                    { key: 'relHalfWidth', title: '相对半宽', align: 'right', width: '100px' },
                    { key: 'implausible', title: '超限读数', align: 'right', width: '92px' },
                  ],
                  rows: items,
                  loading: loading.value,
                  rowKey: 'entId',
                  empty: '暂无企业数据',
                }, {
                  'col-entName': ({ row }) => h('span', { style: 'font-size:12.6px' }, row.entName),
                  'col-industry': ({ row }) => row.industry ? h('span', { class: 'tag t-mute plain' }, row.industry) : h('span', { class: 'dim' }, '—'),
                  'col-region': ({ row }) => row.region || h('span', { class: 'dim' }, '—'),
                  'col-days': ({ row }) => App.fmt.num(row.days),
                  'col-coverage': ({ row }) => h('span', { class: row.coverage >= 0.9 ? '' : 'dim' }, pct(row.coverage, 1)),
                  'col-dailyMean': ({ row }) => num(row.dailyMean, 2) + ' t',
                  'col-relHalfWidth': ({ row }) => h('x-tag', {
                    text: pct(row.relHalfWidth, 2),
                    tone: (row.relHalfWidth || 0) < 0.03 ? 't-ok' : ((row.relHalfWidth || 0) < 0.08 ? 't-warn' : 't-danger'),
                  }),
                  'col-implausible': ({ row }) => h('span', { class: row.implausible ? '' : 'dim' }, App.fmt.num(row.implausible || 0)),
                }),
              ]),
            }),

            h('x-card', {
              title: '已落库的后验区间台账',
              sub: '结论一旦落库即固定口径，可作为后续核查与追溯的比对基准',
              class: 'mt-16',
            }, {
              default: () => h('div', { class: 'card-body flush' }, [
                h('x-table', {
                  columns: [
                    { key: 'ent_name', title: '企业' },
                    { key: 'year', title: '年度', width: '76px' },
                    { key: 'n_obs', title: '观测点', align: 'right', width: '84px' },
                    { key: 'mean', title: '日均均值', align: 'right', width: '110px' },
                    { key: 'ci_low', title: '区间下界', align: 'right', width: '104px' },
                    { key: 'ci_high', title: '区间上界', align: 'right', width: '104px' },
                    { key: 'ci_level', title: '置信水平', align: 'right', width: '92px' },
                    { key: 'method', title: '方法' },
                  ],
                  rows: rows.value,
                  rowKey: 'id',
                  empty: '暂无落库记录（可点右上「全平台重算」生成）',
                }, {
                  'col-mean': ({ row }) => num(row.mean, 4),
                  'col-ci_low': ({ row }) => num(row.ci_low, 3),
                  'col-ci_high': ({ row }) => num(row.ci_high, 3),
                  'col-ci_level': ({ row }) => pct(row.ci_level, 1),
                  'col-method': ({ row }) => h('span', { class: 'tiny dim' }, App.fmt.short(row.method, 26)),
                  'col-n_obs': ({ row }) => App.fmt.num(row.n_obs),
                }),
              ]),
            }),
            h('x-card', {
              title: '模型评估台账（每次批量重算时落库，与后验区间同批次产出）',
              sub: '按 MAPE 升序 · 同一企业内可横向比较哪个模型真正更适合该企业的排放曲线',
              class: 'mt-16',
            }, {
              default: () => h('div', { class: 'card-body flush' }, [
                h('x-table', {
                  columns: [
                    { key: 'ent_name', title: '企业', width: '190px' },
                    { key: 'industry', title: '行业', width: '92px' },
                    { key: 'model', title: '模型', width: '132px' },
                    { key: 'split', title: '切分', width: '104px' },
                    { key: 'n_train', title: '训练', align: 'right', width: '72px' },
                    { key: 'n_test', title: '留出', align: 'right', width: '72px' },
                    { key: 'mape', title: 'MAPE', align: 'right', width: '88px' },
                    { key: 'rmse', title: 'RMSE', align: 'right', width: '92px' },
                    { key: 'r2', title: 'R²', align: 'right', width: '88px' },
                    { key: 'evaluated_at', title: '评估时间', width: '146px' },
                  ],
                  rows: models.value,
                  rowKey: 'id',
                  empty: '暂无模型评估记录（可点右上「全平台重算」生成）',
                }, {
                  'col-ent_name': ({ row }) => h('span', { style: 'font-size:12.5px' }, row.ent_name),
                  'col-model': ({ row }) => h('span', { class: row.model === 'TREND+SEASON' ? 'tag t-chain plain' : 'tag t-mute plain' }, row.model),
                  'col-n_train': ({ row }) => App.fmt.num(row.n_train),
                  'col-n_test': ({ row }) => App.fmt.num(row.n_test),
                  'col-mape': ({ row }) => h('span', { class: 'mono' }, num(row.mape, 2) + '%'),
                  'col-rmse': ({ row }) => num(row.rmse, 3),
                  'col-r2': ({ row }) => (Number(row.r2) ? Number(row.r2).toFixed(3) : h('span', { class: 'dim' }, '—')),
                  'col-evaluated_at': ({ row }) => h('span', { class: 'tiny dim' }, row.evaluated_at),
                }),
              ]),
            }),
          ],
        });
      };
    },
  });

  App.views['page-ent-uncertainty'] = PageEntUncertainty;
  App.views['page-reg-uncertainty'] = PageRegUncertainty;
})();
