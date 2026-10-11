/* =====================================================================
   科研验证中心 —— 可复现、可证伪、可复核
   ---------------------------------------------------------------------
   本页把平台的全部算法主张摊开成"可被质证"的证据面板，六个页签：
     ① 验证总览    六项验证的通过矩阵 + 断言口径
     ② 双轨对账    组织碳 ⊇ 产品碳 的包含性硬约束 + 存证覆盖率归因
     ③ 不确定度    IPCC 误差传播律解析解 vs 蒙特卡洛（可改迭代次数与种子）
     ④ 性能基准    密码学与联盟链内核的真实实测（双密码套件 / PoA vs PoW）
     ⑤ 判据证伪    故意破坏数据链路，验证判据会报警（判据非空）
     ⑥ 合规映射    标准 / 政策 / 国际规则的逐条平台落地映射
   ---------------------------------------------------------------------
   全部数字由浏览器端**现场重算**（复用 App.Nucleus 同一份内核），
   与 `node scripts/uncertainty.js` 的离线复算结果逐位一致（固定种子）。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted } = Vue;
  const h = App.h;

  const TABS = [
    ['overview', '验证总览', 'shield'],
    ['reconcile', '双轨对账', 'chain'],
    ['uncertainty', '不确定度传播', 'chart'],
    ['bench', '性能基准', 'db'],
    ['falsify', '判据可证伪性', 'alert'],
    ['compliance', '标准合规映射', 'book'],
  ];

  /** 断言条：PASS / FAIL */
  const readout = (pass, label, detail) =>
    h('x-readout', { pass: !!pass, label, detail: detail || '' });

  /* x-kpi 的配色由 CSS 变量 --tone 驱动，只认 carbon / chain / sky / violet / rose
     五档。这里做一个语义 → 配色的映射，避免写出没有样式定义的 k-ok / k-err 空类。 */
  const KPI_TONE = { ok: 'carbon', pass: 'carbon', info: 'sky', chain: 'chain', violet: 'violet', warn: 'rose', err: 'rose', danger: 'rose', carbon: 'carbon' };
  const kpi = (props) => h('x-kpi', Object.assign({}, props, { tone: KPI_TONE[props.tone] || props.tone || 'carbon' }));

  /** 键值对（沿用全局 .kv 样式：dl + dt/dd） */
  const kv = (pairs, cols) => h('dl', { class: 'kv', style: `grid-template-columns:${cols || '112px'} 1fr` },
    pairs.map((p) => [h('dt', {}, p[0]), h('dd', { class: p[2] || 'mono' }, p[1])]).flat());

  /** 小节标题 */
  const sub = (text, note) => h('div', { class: 'mb-16' }, [
    h('div', { style: 'font-weight:600;color:var(--tx-0);font-size:13.5px' }, text),
    note && h('div', { class: 'tiny dim mt-8', style: 'line-height:1.7' }, note),
  ]);

  /* CBAM mechanics 字段的中文标签 */
  const MECH_CN = {
    certificatePrice: '证书计价', formula: '成本公式', certificateCount: '证书数量',
    threshold: '豁免阈值', authorization: '申报资格', defaultFactorRule: '缺省值规则',
  };

  const PageVerify = defineComponent({
    name: 'page-verify',
    setup() {
      const tab = ref('overview');
      const iterations = ref(20000);
      const seed = ref(20261011);
      const busy = ref(false);
      const mc = ref(null);

      const S = App.Sources;
      const Ind = App.Industry;
      const N = App.Nucleus;
      const Bench = App.Bench || null;
      const BATCH_TOL = 0.5;

      /* ── ① 台账自洽性：13 项燃料 Tier1 vs Tier2 ── */
      const ledger = computed(() => {
        const rows = S.fuelFactors.filter((f) => f.traceLevel !== 'C').map((f) => {
          const d = N.dualPathFuel(f.code, 1, S);
          return {
            code: f.code, cn: f.cn, traceLevel: f.traceLevel,
            tier1: d.tier1.value, tier2: d.tier2.value,
            diffPct: d.differencePct, pass: d.consistent,
            cite: (f.cites && f.cites[0]) || null,
          };
        });
        const maxDev = rows.reduce((m, r) => Math.max(m, Math.abs(r.diffPct)), 0);
        return { rows, maxDev, allPass: rows.every((r) => r.pass) };
      });

      /* ── ② 产品碳内部闭合：三分量（批次总量 / 范围一+二 / Σ工序） ── */
      const pcf = computed(() => N.pcfInternalClosure(Ind.batches, BATCH_TOL));

      /* ── ③ 声明核算期与运行日历（在线率由设备工况折算） ── */
      const calendar = computed(() => N.productionCalendar({
        periodCn: '2026Q3', days: 92, hoursPerDay: 24, devices: Ind.devices,
      }));

      /* ── ④ 组织碳：逐企业按声明日历积分 ── */
      const AUX_SHARE = 0.055;
      const LOSS_SHARE = 0.08;

      const org = computed(() => {
        const cal = calendar.value;
        const ents = Object.keys(Ind.ENTERPRISES).map(Number).map((id) => {
          const ent = Ind.ENTERPRISES[id];
          const devs = Ind.devicesOf(id);
          const usable = devs.filter((d) => d.live && (d.live.powerKwh || d.live.gasNm3 || d.live.steamT));
          const per = N.meteredPeriodEmission(usable, cal, S);
          return {
            entId: id, entName: ent.name, entShort: ent.short, industry: ent.industry,
            devicesTotal: devs.length, devicesUsed: per.count,
            metered: per.count > 0,
            reason: per.count > 0 ? null : '该企业在本期尚未接入计量设备，无法做组织碳核算',
            periodTotal: per.periodTotal, scope1: per.scope1, scope2: per.scope2,
            items: per.items,
          };
        });
        const metered = ents.filter((e) => e.metered);
        return {
          calendar: cal, perEnterprise: ents,
          periodTotal: metered.reduce((s, e) => s + e.periodTotal, 0),
          scope1: metered.reduce((s, e) => s + e.scope1, 0),
          scope2: metered.reduce((s, e) => s + e.scope2, 0),
          meteredCount: metered.length,
          unmeteredCount: ents.length - metered.length,
        };
      });

      /* ── ⑤ 双轨对账：包含性硬约束 + 覆盖率归因 ── */
      const recon = computed(() => {
        const byEnt = {};
        org.value.perEnterprise.forEach((e) => { byEnt[e.entId] = e; });
        const rows = Object.keys(Ind.ENTERPRISES).map(Number).map((id) => {
          const o = byEnt[id];
          const all = Ind.batchesOf(id);
          const stored = all.filter((b) => b.status !== 'BLOCKED');
          const base = N.enterpriseReconcile({
            entId: id, entName: o.entName, industry: o.industry,
            periodCn: calendar.value.periodCn,
            orgTotal: o.periodTotal, batches: stored,
            auxShare: AUX_SHARE, lossShare: LOSS_SHARE,
          });
          return Object.assign(base, {
            metered: o.metered, reason: o.reason,
            blocked: all.filter((b) => b.status === 'BLOCKED').map((b) => b.batchNo),
          });
        });
        const league = N.leagueReconcile(rows);
        return { rows, league, auxShare: AUX_SHARE, lossShare: LOSS_SHARE };
      });

      /* ── ⑥ 判据可证伪性：四类负向注入 ── */
      const falsify = computed(() => {
        const cases = [];
        const pick = Ind.batches.find((b) => b.totalTco2e > 1000);

        const A = N.pcfInternalClosure([Object.assign({}, pick, { totalTco2e: pick.totalTco2e * 1.1 })], BATCH_TOL);
        cases.push({
          id: 'A', name: '篡改批次总碳足迹 +10%',
          inject: `${pick.batchNo}：totalTco2e × 1.10`,
          expect: '工序偏差 / 范围偏差同时超限',
          detected: !A.allPass,
          observed: `工序偏差 ${A.maxStageDevPct.toFixed(3)}% · 范围偏差 ${A.maxScopeDevPct.toFixed(3)}%`,
        });

        const B = N.pcfInternalClosure([Object.assign({}, pick, { scope2: pick.scope2 * 0.6 })], BATCH_TOL);
        cases.push({
          id: 'B', name: '只改范围二占比（−40%）',
          inject: `${pick.batchNo}：scope2 × 0.60`,
          expect: '范围一+二 ≠ 批次总量',
          detected: !B.allPass,
          observed: `范围偏差 ${B.maxScopeDevPct.toFixed(3)}%`,
        });

        const C = N.pcfInternalClosure([Object.assign({}, pick, {
          bom: Object.assign({}, pick.bom, { stages: pick.bom.stages.slice(0, 3) }),
        })], BATCH_TOL);
        cases.push({
          id: 'C', name: '删除一个工序分摊段',
          inject: `${pick.batchNo}：BOM 4 段 → 3 段`,
          expect: 'Σ工序 ≠ 批次总量',
          detected: !C.allPass,
          observed: `工序偏差 ${C.maxStageDevPct.toFixed(3)}%`,
        });

        const target = recon.value.rows.find((r) => r.metered);
        const inflate = target.batches.map((b) => Object.assign({}, b, { totalTco2e: b.totalTco2e * 10 }));
        const bad = N.enterpriseReconcile({
          entId: target.entId, orgTotal: target.orgTotal, batches: inflate,
          auxShare: AUX_SHARE, lossShare: LOSS_SHARE,
        });
        cases.push({
          id: 'D', name: '产品碳放大 10× 使其超过组织碳',
          inject: `${target.entShort}：Σ产品碳 ${target.pcfSum.toFixed(0)} → ${bad.pcfSum.toFixed(0)} tCO₂e`,
          expect: '包含性硬约束被击破',
          detected: target.pass && !bad.pass,
          observed: `基线 pass=${target.pass}，注入后 pass=${bad.pass}，不可解释量 ${bad.unexplained.toFixed(1)} tCO₂e`,
        });

        return {
          cases, total: cases.length,
          detectedCount: cases.filter((c) => c.detected).length,
          allDetected: cases.every((c) => c.detected),
        };
      });

      /* ── ⑦ 不确定度：解析 vs 蒙特卡洛（浏览器现场抽样） ── */
      function runMC() {
        busy.value = true;
        const p = S.uncertainty.parameters;
        const sg = (id, fb) => { const r = p.find((x) => x.id === id); return r ? r.sigmaRel : fb; };
        const chainInputs = [
          { id: 'AD', cn: '活动数据（计量）', value: 1, sigmaRel: sg('AD', 0.03) },
          { id: 'NCV', cn: '平均低位发热量', value: 1, sigmaRel: sg('NCV', 0.05) },
          { id: 'CC', cn: '单位热值含碳量', value: 1, sigmaRel: sg('CC', 0.05) },
          { id: 'OF', cn: '碳氧化率', value: 1, sigmaRel: sg('OF', 0.02) },
        ];
        const chain = N.monteCarlo(chainInputs, {
          model: 'product', iterations: Math.max(1000, Number(iterations.value) || 20000), seed: Number(seed.value) || 20261011,
        });
        const batch = Ind.batches.find((b) => b.totalTco2e > 0);
        const bt = N.mcForBatch(batch.totalTco2e, {
          iterations: Math.max(1000, Number(iterations.value) || 20000), seed: Number(seed.value) || 20261011, Sources: S,
        });

        const oracle = Ind.oracle;
        const readings = oracle.series.map((pt, i) => ({
          kwh: 12000 + Math.sin(i / 3.1) * 2600 + i * 40, factor: pt.factor,
        }));
        const grid = N.compareGridMethods(readings, oracle.baseline);

        mc.value = { chain, batch: bt, batchNo: batch.batchNo, batchProduct: batch.product, grid, chainInputs };
        busy.value = false;
      }
      onMounted(() => { if (!mc.value) runMC(); });

      /* ── ⑧ 总览矩阵 ── */
      const matrix = computed(() => {
        const m = mc.value;
        return [
          { id: '①', name: '台账自洽性（Tier 1 缺省法 vs Tier 2 参数展开法）', pass: ledger.value.allPass, detail: `${ledger.value.rows.length} 项燃料 · 最大偏差 ${ledger.value.maxDev.toFixed(4)}%` },
          { id: '②', name: '产品碳内部闭合（批次总量 = 范围一+二 = Σ工序分摊）', pass: pcf.value.allPass, detail: `${pcf.value.ok}/${pcf.value.total} 批次 · 最大偏差 ${Math.max(pcf.value.maxStageDevPct, pcf.value.maxScopeDevPct).toFixed(4)}%` },
          { id: '③', name: '组织碳可核算（逐企业 · 声明运行日历积分）', pass: org.value.meteredCount > 0, detail: `${org.value.meteredCount} 家接入计量 · ${org.value.calendar.hours.toFixed(1)} h 运行小时` },
          { id: '④', name: '双轨包含性（组织碳 ⊇ Σ产品碳 硬约束）', pass: recon.value.league.allPass, detail: `联盟覆盖率 ${recon.value.league.coveragePct.toFixed(2)}%` },
          { id: '⑤', name: '判据可证伪（负向注入必须被检出）', pass: falsify.value.allDetected, detail: `${falsify.value.detectedCount}/${falsify.value.total} 类注入被检出` },
          { id: '⑥', name: '不确定度互证（解析解 ↔ 蒙特卡洛）', pass: !!m && m.chain.crossCheck.absDiffPct < 5 && m.batch.crossCheck.absDiffPct < 5, detail: m ? `乘性链偏差 ${m.chain.crossCheck.absDiffPct.toFixed(2)}% · 加性偏差 ${m.batch.crossCheck.absDiffPct.toFixed(2)}%` : '待抽样' },
        ];
      });
      const allPass = computed(() => matrix.value.every((x) => x.pass));

      /* ================================================================
       * 图表
       * ================================================================ */
      const histOption = computed(() => {
        const m = mc.value;
        if (!m) return null;
        const hh = m.chain.histogram;
        return App.chartBase({
          grid: { left: 8, right: 18, top: 40, bottom: 30, containLabel: true },
          legend: { show: false },
          title: {
            text: '排放因子链蒙特卡洛抽样分布（相对点估计）',
            left: 'center', top: 2,
            textStyle: { color: '#8d9cb5', fontSize: 11.5, fontWeight: 400 },
          },
          xAxis: App.valAxis({ name: '相对值', nameTextStyle: { color: '#8d9cb5', fontSize: 10.5 }, min: hh.lo, max: hh.hi }),
          yAxis: App.valAxis({ name: '频数', nameTextStyle: { color: '#8d9cb5', fontSize: 10.5 } }),
          series: [{
            type: 'bar', barWidth: '88%',
            data: hh.centers.map((c, i) => [c, hh.counts[i]]),
            itemStyle: {
              borderRadius: [2, 2, 0, 0],
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(16,185,129,.92)' },
                { offset: 1, color: 'rgba(16,185,129,.18)' },
              ]),
            },
            markLine: {
              silent: true, symbol: 'none',
              lineStyle: { type: 'dashed', width: 1 },
              label: { color: '#c3d0e4', fontSize: 10.5, formatter: (p) => p.name },
              data: [
                { xAxis: 1, name: '点估计', lineStyle: { color: '#38bdf8' } },
                { xAxis: m.chain.quantiles.p5, name: 'P5', lineStyle: { color: 'rgba(245,165,36,.8)' } },
                { xAxis: m.chain.quantiles.p95, name: 'P95', lineStyle: { color: 'rgba(245,165,36,.8)' } },
              ],
            },
          }],
        });
      });

      const benchDigestOption = computed(() => {
        if (!Bench) return null;
        const rows = Bench.digest.rows;
        return App.chartBase({
          grid: { left: 8, right: 20, top: 30, bottom: 8, containLabel: true },
          legend: { show: false },
          xAxis: App.catAxis(rows.map((r) => r.label)),
          yAxis: App.valAxis({
            axisLabel: { color: '#8d9cb5', fontSize: 11, formatter: (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'k') },
          }),
          series: [{
            type: 'bar', barWidth: '42%',
            data: rows.map((r, i) => ({ value: r.opsPerSec, itemStyle: { color: i === 0 ? '#38bdf8' : '#10b981', borderRadius: [4, 4, 0, 0] } })),
            label: { show: true, position: 'top', color: '#c3d0e4', fontSize: 11, formatter: (p) => p.value.toLocaleString() + ' 次/秒' },
          }],
        });
      });

      const benchMerkleOption = computed(() => {
        if (!Bench) return null;
        const roots = Bench.merkle.roots;
        return App.chartBase({
          grid: { left: 8, right: 20, top: 34, bottom: 8, containLabel: true },
          xAxis: App.catAxis(roots.map((r) => r.size.toLocaleString() + ' 叶')),
          yAxis: App.valAxis({
            type: 'log', name: '建根耗时 (ms)', nameTextStyle: { color: '#8d9cb5', fontSize: 10.5 },
            axisLabel: { color: '#8d9cb5', fontSize: 11, formatter: (v) => (v >= 1 ? v : v.toFixed(2)) },
          }),
          series: [
            {
              name: 'SHA-256', type: 'line', smooth: true,
              data: roots.map((r) => Math.max(0.001, r.sha256.rootMs)),
              lineStyle: { width: 2.4, color: '#38bdf8' }, itemStyle: { color: '#38bdf8' },
              symbolSize: 7,
            },
            {
              name: 'SM3（国密）', type: 'line', smooth: true,
              data: roots.map((r) => Math.max(0.001, r.sm3.rootMs)),
              lineStyle: { width: 2.4, color: '#10b981' }, itemStyle: { color: '#10b981' },
              symbolSize: 7,
            },
          ],
        });
      });

      const benchBlockOption = computed(() => {
        if (!Bench) return null;
        const poa = Bench.blockProduction.poa;
        const pow = Bench.blockProduction.powComparison;
        const cats = ['PoA 联盟共识（本平台）'].concat(pow.map((p) => `PoW 难度 ${p.difficulty}`));
        const vals = [poa.msPerBlock].concat(pow.map((p) => p.avgMineMs));
        return App.chartBase({
          grid: { left: 8, right: 20, top: 30, bottom: 8, containLabel: true },
          legend: { show: false },
          xAxis: App.catAxis(cats, { axisLabel: { color: '#8d9cb5', fontSize: 10.5, interval: 0, rotate: 16 } }),
          yAxis: App.valAxis({
            type: 'log', name: '单块耗时 (ms)', nameTextStyle: { color: '#8d9cb5', fontSize: 10.5 },
            axisLabel: { color: '#8d9cb5', fontSize: 11, formatter: (v) => (v >= 1 ? v : v.toFixed(2)) },
          }),
          series: [{
            type: 'bar', barWidth: '46%',
            data: vals.map((v, i) => ({ value: Math.max(0.001, v), itemStyle: { color: i === 0 ? '#10b981' : 'rgba(251,113,133,.75)', borderRadius: [4, 4, 0, 0] } })),
            label: { show: true, position: 'top', color: '#c3d0e4', fontSize: 11, formatter: (p) => p.value + ' ms' },
          }],
        });
      });

      /* ================================================================
       * 渲染
       * ================================================================ */
      const tabsBar = () => h('div', { class: 'flex gap-6 wrap mb-16', style: 'position:sticky;top:56px;z-index:5;padding:8px 0;backdrop-filter:blur(8px)' },
        TABS.map(([k, label, icon]) => h('button', {
          class: ['btn sm', tab.value === k && 'primary'],
          onClick: () => { tab.value = k; },
        }, [h('x-icon', { name: icon, size: 14 }), label])));

      /* ---- 总览 ---- */
      function renderOverview() {
        const c = calendar.value;
        return h('div', { class: 'col gap-16' }, [
          h('x-card', { title: '验证结论矩阵', sub: '六项主张逐条给出可复核的判据与实测值' }, {
            default: () => h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                kpi({
                  label: '通过项', value: matrix.value.filter((x) => x.pass).length + ' / ' + matrix.value.length,
                  unit: '项', tone: allPass.value ? 'ok' : 'warn', icon: 'shield',
                  foot: allPass.value ? '全部判据通过' : '存在未通过项',
                }),
                kpi({ label: '台账可追溯率', value: S.stats().traceabilityPct, unit: '%', tone: 'chain', icon: 'book', foot: `${S.stats().citations} 条官方出处 · A 级 ${S.stats().byLevel.A} 项` }),
                kpi({ label: '声明运行小时', value: c.hours.toFixed(1), unit: 'h', tone: 'info', icon: 'clock', foot: `${c.days}d × ${c.hoursPerDay}h × 在线率 ${(c.availability * 100).toFixed(1)}%` }),
                kpi({ label: '蒙特卡洛抽样', value: mc.value ? mc.value.chain.iterations.toLocaleString() : '—', unit: '次', tone: 'violet', icon: 'chart', foot: `随机种子 ${mc.value ? mc.value.chain.seed : '—'}` }),
              ]),
              h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
                h('thead', {}, [h('tr', {}, [h('th', { style: 'width:44px' }, '#'), h('th', {}, '验证主张'), h('th', { style: 'width:96px' }, '判定'), h('th', { style: 'width:44%' }, '实测口径')])]),
                h('tbody', {}, matrix.value.map((x) => h('tr', {}, [
                  h('td', { class: 'mono' }, x.id),
                  h('td', {}, x.name),
                  h('td', {}, h('span', { class: ['tag', x.pass ? 'ok' : 'err'] }, x.pass ? 'PASS' : 'FAIL')),
                  h('td', { class: 'tiny dim mono' }, x.detail),
                ]))),
              ])]),
            ]),
          }),
          h('x-card', { title: '复现方式', sub: '任何评审可在本机独立重跑，结果必须逐位一致' }, {
            default: () => h('div', {}, [
              h('div', { class: 'mono-pre', style: 'white-space:pre-wrap;line-height:1.85' },
                '$ node scripts/uncertainty.js 20000\n'
                + '$ node scripts/bench-crypto.js            # 密码学与链性能真实基准\n'
                + '$ node scripts/browser-check.js           # 全站路由与交互回归\n'
                + '$ node scripts/smoke-test.js              # 接口冒烟'),
              h('div', { class: 'alertbar info mt-16' }, [
                h('x-icon', { name: 'info', size: 15 }),
                h('span', {}, '全部随机数来自 mulberry32 固定种子，跨机器结果完全一致；'
                  + '基准数字与硬件相关，应比较**同一环境下的相对差异**而非绝对值。'),
              ]),
              h('div', { class: 'tiny dim mt-8', style: 'line-height:1.8' }, App.fmt.md(
                '**口径诚实声明**：组织碳取自"已接入计量的设备子集"，是组织碳的**下界**；'
                + '产品碳只覆盖**已上链存证的部分批次**。因此本页的双轨对账判据是**包含性**'
                + '（组织碳 ⊇ Σ产品碳）而非数值相等 —— 强行凑闭合才是不可信的做法。')),
            ]),
          }),
        ]);
      }

      /* ---- 双轨对账 ---- */
      function renderReconcile() {
        const c = calendar.value;
        const r = recon.value;
        return h('div', { class: 'col gap-16' }, [
          h('x-card', { title: '声明核算期与运行日历', sub: '双轨对账的第一道口径校正：把「瞬时率」统一到「期间累计量」' }, {
            default: () => h('div', {}, [
              kv([
                ['核算期', c.periodCn],
                ['日历', `${c.days} 日 × ${c.hoursPerDay} h`],
                ['在线率', `${(c.availability * 100).toFixed(2)}%（${c.availabilityFrom}）`],
                ['有效运行小时', c.hours.toFixed(1) + ' h'],
                ['辅助用能率', (r.auxShare * 100).toFixed(1) + '%'],
                ['输配损耗率', (r.lossShare * 100).toFixed(1) + '%'],
              ], '104px'),
              h('div', { class: 'tiny dim mt-8', style: 'line-height:1.8' }, c.note
                + ' 在线率由在网设备的工况状态折算（处于降解态的设备不计入有效运行小时），不是拍出来的常数。'),
            ]),
          }),

          h('x-card', { title: '判据说明', sub: '为什么判据是「包含性」而不是「数值相等」' }, {
            default: () => h('div', { class: 'col gap-8' }, [
              h('div', { class: 'tiny', style: 'line-height:1.9' }, App.fmt.md(
                '组织碳刻画一家企业的**全部**排放；产品碳只覆盖**已上链存证的部分批次**。'
                + '两者在口径上本就不对等，因此正确判据是：')),
              h('ol', { style: 'margin:0;padding-left:22px;font-size:12.6px;line-height:2;color:var(--tx-1)' }, [
                h('li', {}, App.fmt.md('**包含性（硬约束）**：组织碳 ⊇ Σ产品碳。违反 = 数据打架，必须回溯原始凭证。')),
                h('li', {}, App.fmt.md('**可分摊空间** E_alloc = 组织碳 × (1 − 辅助率 − 损耗率)。')),
                h('li', {}, App.fmt.md('**存证覆盖率** ρ = Σ产品碳 / E_alloc。试点期 ρ 偏小是正常的，如实报告而非调参凑闭合。')),
              ]),
            ]),
          }),

          h('x-card', { title: '企业级双轨对账', sub: '组织碳（自上而下）↔ 产品碳（自下而上）' }, {
            flush: true,
            default: () => h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
              h('thead', {}, [h('tr', {}, [
                h('th', {}, '企业'), h('th', {}, '行业'), h('th', { class: 'num' }, '组织碳 tCO₂e'),
                h('th', { class: 'num' }, 'Σ产品碳 tCO₂e'), h('th', { class: 'num' }, '可分摊空间'),
                h('th', { class: 'num' }, '未存证产出'), h('th', { class: 'num' }, '覆盖率 ρ'),
                h('th', { style: 'width:96px' }, '包含性'),
              ])]),
              h('tbody', {}, r.rows.map((x) => h('tr', {}, [
                h('td', {}, x.entName),
                h('td', { class: 'tiny dim' }, x.industry),
                h('td', { class: 'num mono' }, x.metered ? App.fmt.num(x.orgTotal, 1) : '—'),
                h('td', { class: 'num mono' }, App.fmt.num(x.pcfSum, 1)),
                h('td', { class: 'num mono' }, x.metered ? App.fmt.num(x.allocatable, 1) : '—'),
                h('td', { class: 'num mono' }, x.metered ? App.fmt.num(x.residual, 1) : '—'),
                h('td', { class: 'num mono' }, x.metered ? x.coveragePct.toFixed(2) + '%' : '—'),
                h('td', {}, x.metered
                  ? h('span', { class: ['tag', x.pass ? 'ok' : 'err'] }, x.pass ? '成立' : '被击破')
                  : h('span', { class: 'tag t-mute' }, '未接入计量')),
              ]))),
            ])]),
          }),

          h('x-card', { title: '逐企业判定与归因', sub: '差额必须被拆解并归因，不能只给一个"已闭合"的结论' }, {
            default: () => h('div', { class: 'col gap-8' }, r.rows.map((x) => h('div', {
              class: ['readout', x.metered ? (x.pass ? 'pass' : 'fail') : 'fail'],
              style: x.metered ? '' : 'opacity:.72',
            }, [
              h('span', { class: 'flag' }, x.metered ? (x.pass ? 'PASS' : 'FAIL') : 'SKIP'),
              h('span', { class: 'k' }, x.entName),
              h('span', { class: 'mono', style: 'margin-left:auto;color:var(--tx-3);max-width:62%;text-align:right;white-space:normal;line-height:1.6;font-size:11.4px' },
                x.metered ? x.verdict : x.reason),
            ]))),
          }),

          h('x-card', { title: '联盟级汇总', sub: '只对已接入计量的企业做包含性校验，未接入企业单列不填补' }, {
            default: () => h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                kpi({ label: 'Σ 组织碳', value: App.fmt.big(r.league.orgTotal), unit: 'tCO₂e', tone: 'carbon', icon: 'factory', foot: `${r.league.meteredCount} 家已接入计量` }),
                kpi({ label: 'Σ 产品碳', value: App.fmt.big(r.league.pcfSum), unit: 'tCO₂e', tone: 'chain', icon: 'block', foot: '已上链存证批次合计' }),
                kpi({ label: '可分摊空间', value: App.fmt.big(r.league.allocatable), unit: 'tCO₂e', tone: 'info', icon: 'target', foot: '组织碳扣除辅助与损耗' }),
                kpi({ label: '存证覆盖率 ρ', value: r.league.coveragePct.toFixed(2), unit: '%', tone: 'violet', icon: 'chart', foot: '试点期只存证部分批次' }),
              ]),
              readout(r.league.allPass, '联盟级包含性校验', r.league.allPass
                ? `全部 ${r.league.meteredCount} 家已接入企业通过：组织碳 ⊇ Σ产品碳`
                : `存在被击破企业：${r.league.failed.join(', ')}`),
              r.league.unmeteredCount
                ? h('div', { class: 'alertbar info mt-12' }, [
                  h('x-icon', { name: 'info', size: 15 }),
                  h('span', {}, `另有 ${r.league.unmeteredCount} 家企业（${r.league.unmetered.map((u) => u.entName).join('、')}）`
                    + '本期尚未接入计量设备，**显式排除在双轨对账之外** —— 用估算值填补会让对账失去意义。'),
                ])
                : null,
            ]),
          }),

          h('x-card', { title: '产品碳三分量闭合明细', sub: '批次总量 = 范围一+范围二 = Σ工序 BOM 分摊（PCF 边界仅含范围一+二）' }, {
            flush: true,
            default: () => h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
              h('thead', {}, [h('tr', {}, [
                h('th', {}, '批次'), h('th', {}, '产品'), h('th', {}, '状态'),
                h('th', { class: 'num' }, '批次总量'), h('th', { class: 'num' }, 'Σ工序分摊'),
                h('th', { class: 'num' }, '范围一+二'), h('th', { class: 'num' }, '工序偏差'),
                h('th', { class: 'num' }, '范围偏差'), h('th', { style: 'width:72px' }, '判定'),
              ])]),
              h('tbody', {}, pcf.value.rows.map((x) => h('tr', {}, [
                h('td', { class: 'mono tiny' }, x.batchNo),
                h('td', {}, x.product),
                h('td', {}, h('span', { class: ['tag', x.status === 'CERTIFIED' ? 'ok' : x.status === 'BLOCKED' ? 'err' : 'warn'] }, x.status)),
                h('td', { class: 'num mono' }, App.fmt.num(x.totalTco2e, 2)),
                h('td', { class: 'num mono' }, App.fmt.num(x.stageSum, 2)),
                h('td', { class: 'num mono' }, App.fmt.num(x.scopeSum, 2)),
                h('td', { class: 'num mono' }, x.stageDevPct.toFixed(4) + '%'),
                h('td', { class: 'num mono' }, x.scopeDevPct.toFixed(4) + '%'),
                h('td', {}, h('span', { class: ['tag', x.pass ? 'ok' : 'err'] }, x.pass ? 'PASS' : 'FAIL')),
              ]))),
            ])]),
          }),

          h('x-card', { title: '排放因子台账（Tier 1 ↔ Tier 2 交叉校验）', sub: '同一组原始参数从 IPCC 算式重算一遍，验证台账不是"编"的' }, {
            flush: true,
            default: () => h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
              h('thead', {}, [h('tr', {}, [
                h('th', {}, '燃料 / 能源品种'), h('th', {}, '出处等级'),
                h('th', { class: 'num' }, 'Tier 1 缺省因子'), h('th', { class: 'num' }, 'Tier 2 NCV×CC×OF×44/12'),
                h('th', { class: 'num' }, '偏差'), h('th', {}, '官方出处'), h('th', { style: 'width:64px' }, '自洽'),
              ])]),
              h('tbody', {}, ledger.value.rows.map((x) => h('tr', {}, [
                h('td', {}, x.cn),
                h('td', {}, h('span', { class: ['tag', x.traceLevel === 'A' ? 'ok' : 'warn'] }, x.traceLevel + ' 级')),
                h('td', { class: 'num mono' }, x.tier1.toFixed(4)),
                h('td', { class: 'num mono' }, x.tier2.toFixed(4)),
                h('td', { class: 'num mono' }, App.fmt.num(x.diffPct, 4) + '%'),
                h('td', { class: 'tiny dim' }, x.cite ? (S.citeMap && S.citeMap[x.cite] ? S.citeMap[x.cite].short : x.cite) : '—'),
                h('td', {}, h('span', { class: ['tag', x.pass ? 'ok' : 'err'] }, x.pass ? '✓' : '✗')),
              ]))),
            ])]),
          }),
        ]);
      }

      /* ---- 不确定度 ---- */
      function renderUncertainty() {
        const m = mc.value;
        if (!m) return h('div', { class: 'empty' }, '正在抽样…');
        const c = m.chain; const b = m.batch; const g = m.grid;
        const diffOk = (x) => x < 5;
        return h('div', { class: 'col gap-16' }, [
          h('x-card', { title: '抽样参数', sub: '迭代次数与随机种子均可修改；固定种子 = 结果可被任何人复现' }, {
            actions: () => h('button', { class: 'btn sm primary', disabled: busy.value, onClick: runMC },
              [h('x-icon', { name: 'refresh', size: 14 }), busy.value ? '抽样中…' : '重新抽样']),
            default: () => h('div', { class: 'flex gap-10 wrap' }, [
              h('div', { class: 'field' }, [
                h('label', {}, '迭代次数'), 
                h('input', {
                  class: 'input', type: 'number', min: '1000', step: '1000', value: iterations.value,
                  onInput: (e) => { iterations.value = e.target.value; },
                }),
              ]),
              h('div', { class: 'field' }, [
                h('label', {}, '随机种子'),
                h('input', {
                  class: 'input', type: 'number', value: seed.value,
                  onInput: (e) => { seed.value = e.target.value; },
                }),
              ]),
              h('div', { class: 'field flex-1' }, [
                h('label', {}, '模型'),
                h('div', { class: 'tiny dim', style: 'line-height:1.8;padding-top:6px' },
                  '乘性链 y = Π xᵢ(1+σᵢzᵢ)　·　加性汇总 y = Σ xᵢ(1+σᵢzᵢ)　·　输入相互独立（相关性未建模，见局限）'),
              ]),
            ]),
          }),

          h('div', { class: 'grid g2' }, [
            h('x-card', { title: '乘性模型 · 排放因子链（AD × NCV × CC × OF）', sub: '解析解与蒙特卡洛互为独立验证' }, {
              default: () => h('div', {}, [
                h('div', { class: 'grid g4 mb-16' }, [
                  kpi({ label: '解析解 √(Σσᵢ²)', value: (c.analytic.sigmaRel * 100).toFixed(3), unit: '%', tone: 'info', icon: 'target', foot: 'IPCC 2006 Vol.1 Ch.3 Eq.3.1' }),
                  kpi({ label: '蒙特卡洛', value: (c.sigmaRel * 100).toFixed(3), unit: '%', tone: 'chain', icon: 'chart', foot: `${c.iterations.toLocaleString()} 次抽样` }),
                  kpi({ label: '互证偏差', value: c.crossCheck.absDiffPct.toFixed(3), unit: '%', tone: diffOk(c.crossCheck.absDiffPct) ? 'ok' : 'warn', icon: 'verify', foot: diffOk(c.crossCheck.absDiffPct) ? '自检闸门通过（< 5%）' : '偏差偏大，疑抽样不足' }),
                  kpi({ label: '分布类型', value: '对数正态', unit: '', tone: 'violet', icon: 'layers', foot: `P5 ${c.quantiles.p5.toFixed(4)} · P95 ${c.quantiles.p95.toFixed(4)}` }),
                ]),
                readout(diffOk(c.crossCheck.absDiffPct), '解析解 ↔ 蒙特卡洛 互证',
                  `解析 ${(c.analytic.sigmaRel * 100).toFixed(3)}% vs 抽样 ${(c.sigmaRel * 100).toFixed(3)}%（相对偏差 ${c.crossCheck.absDiffPct.toFixed(3)}%）`),
                h('div', { class: 'tiny dim mt-8', style: 'line-height:1.8' }, App.fmt.md(c.crossCheck.note)),
              ]),
            }),
            h('x-card', { title: '抽样分布直方图', sub: `分箱 ${c.histogram.bins} · ${c.histogram.note}` }, {
              default: () => h('x-chart', { option: histOption.value, height: 'h300' }),
            }),
          ]),

          h('div', { class: 'grid g2' }, [
            h('x-card', { title: '一阶敏感性（方差贡献占比）', sub: '给出"该先测准哪一项"的可执行优先级' }, {
              default: () => h('div', {}, [
                h('x-bars', {
                  items: c.sensitivity.map((s) => ({ name: s.cn, value: s.sharePct })),
                  valueKey: 'value', labelKey: 'name',
                  format: (v) => v.toFixed(1) + '%',
                }),
                h('div', { class: 'alertbar info mt-16' }, [
                  h('x-icon', { name: 'info', size: 15 }),
                  h('span', {}, App.fmt.md(c.recommendation)),
                ]),
              ]),
            }),
            h('x-card', { title: `加性模型 · 真实批次「${m.batchNo}」`, sub: '多排放源相加的合成不确定度' }, {
              default: () => h('div', {}, [
                h('div', { class: 'grid g2 mb-16' }, [
                  kpi({ label: '点估计', value: App.fmt.big(b.central), unit: 'tCO₂e', tone: 'carbon', icon: 'factory', foot: m.batchProduct }),
                  kpi({ label: '相对不确定度（解析）', value: (b.analytic.sigmaRel * 100).toFixed(3), unit: '%', tone: 'info', icon: 'target' }),
                  kpi({ label: '相对不确定度（MC）', value: (b.sigmaRel * 100).toFixed(3), unit: '%', tone: 'chain', icon: 'chart', foot: `${b.iterations.toLocaleString()} 次抽样` }),
                  kpi({ label: '95% 置信区间', value: App.fmt.num(b.mean - 1.96 * b.sd, 1) + ' ~ ' + App.fmt.num(b.mean + 1.96 * b.sd, 1), unit: 'tCO₂e', tone: 'violet', icon: 'layers', foot: `σ = ${App.fmt.num(b.sd, 2)} tCO₂e` }),
                ]),
                readout(diffOk(b.crossCheck.absDiffPct), '解析解 ↔ 蒙特卡洛 互证',
                  `解析 ${(b.analytic.sigmaRel * 100).toFixed(3)}% vs 抽样 ${(b.sigmaRel * 100).toFixed(3)}%（相对偏差 ${b.crossCheck.absDiffPct.toFixed(3)}%）`),
                h('div', { class: 'tbl-wrap mt-16' }, [h('table', { class: 'tbl' }, [
                  h('thead', {}, [h('tr', {}, [h('th', {}, '输入项'), h('th', { class: 'num' }, '方差贡献占比')])]),
                  h('tbody', {}, b.sensitivity.map((s) => h('tr', {}, [
                    h('td', {}, s.cn), h('td', { class: 'num mono' }, s.sharePct.toFixed(1) + '%'),
                  ]))),
                ])]),
              ]),
            }),
          ]),

          h('x-card', { title: '口径差异：动态电网因子里程积分法 vs 年均因子法', sub: '不是"谁算错了"，而是口径不同 —— 本平台把口径做成可声明、可审计的选择' }, {
            default: () => h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                kpi({ label: '电量合计', value: App.fmt.big(g.kwhTotal), unit: 'kWh', tone: 'info', icon: 'db' }),
                kpi({ label: '动态法 Σ(电量×EF_h)', value: App.fmt.big(g.dynamic), unit: 'tCO₂', tone: 'chain', icon: 'chart', foot: `等效因子 ${g.effectiveFactor} tCO₂/MWh` }),
                kpi({ label: '年均法 电量×年均EF', value: App.fmt.big(g.flat), unit: 'tCO₂', tone: 'carbon', icon: 'target', foot: `年均因子 ${g.annualFactor} tCO₂/MWh` }),
                kpi({ label: '相对差异', value: g.differencePct.toFixed(3), unit: '%', tone: 'warn', icon: 'alert', foot: `绝对差 ${App.fmt.num(g.difference, 2)} tCO₂` }),
              ]),
              h('div', { class: 'tiny dim', style: 'line-height:1.85' }, App.fmt.md(g.interpretation)),
            ]),
          }),
        ]);
      }

      /* ---- 性能基准 ---- */
      function renderBench() {
        if (!Bench) return h('x-card', { title: '性能基准数据缺失' }, {
          default: () => h('div', { class: 'tiny dim' }, '请先运行 `node scripts/bench-crypto.js` 生成 public/js/data/bench.js。'),
        });
        const e = Bench.environment; const gm = Bench.gm; const sg = Bench.signature;
        const bp = Bench.blockProduction; const ch = Bench.chain; const pw = Bench.password;
        const td = ch.tamperDetection;
        return h('div', { class: 'col gap-16' }, [
          h('x-card', { title: '测量环境指纹', sub: '基准数字与硬件/运行时强相关，必须连同环境一起披露' }, {
            default: () => h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                kpi({ label: 'Node 运行时', value: e.node, unit: '', tone: 'info', icon: 'db', foot: `V8 ${e.v8}` }),
                kpi({ label: 'OpenSSL', value: e.openssl, unit: '', tone: 'chain', icon: 'lock', foot: gm.available ? '原生支持 SM2 + SM3' : '不支持国密' }),
                kpi({ label: 'CPU', value: String(e.cpuCount) + ' 核', unit: '', tone: 'violet', icon: 'layers', foot: e.cpuModel }),
                kpi({ label: '测量耗时', value: Bench.meta.elapsedSec, unit: 's', tone: 'carbon', icon: 'clock', foot: App.fmt.dt(e.measuredAt) }),
              ]),
              h('div', { class: 'tiny dim', style: 'line-height:1.85;margin-bottom:14px' }, App.fmt.md(e.note)),
              sub('国密算法合规性现场复核（GB/T 32905-2016 附录 A 标准测试向量）'),
              h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
                h('thead', {}, [h('tr', {}, [h('th', {}, '明文'), h('th', {}, '标准期望摘要'), h('th', {}, '本机实测摘要'), h('th', { style: 'width:72px' }, '一致')])]),
                h('tbody', {}, gm.cases.map((c) => h('tr', {}, [
                  h('td', { class: 'mono' }, c.msg + `（${c.msgBytes} B）`),
                  h('td', { class: 'mono tiny' }, c.expected),
                  h('td', { class: 'mono tiny' }, c.actual),
                  h('td', {}, h('span', { class: ['tag', c.pass ? 'ok' : 'err'] }, c.pass ? '逐位一致' : '不一致')),
                ]))),
              ])]),
              h('div', { class: 'tiny dim mt-8', style: 'line-height:1.8' }, App.fmt.md(gm.conclusion)),
            ]),
          }),

          h('div', { class: 'grid g2' }, [
            h('x-card', { title: '摘要算法吞吐（60 B 载荷）', sub: 'SHA-256（套件 A）vs SM3（套件 B · 国密）' }, {
              default: () => h('div', {}, [
                h('x-chart', { option: benchDigestOption.value, height: 'h240' }),
                h('div', { class: 'tbl-wrap mt-16' }, [h('table', { class: 'tbl' }, [
                  h('thead', {}, [h('tr', {}, [h('th', {}, '算法'), h('th', { class: 'num' }, '次/秒'), h('th', { class: 'num' }, 'ns/次'), h('th', { class: 'num' }, 'MB/s')])]),
                  h('tbody', {}, Bench.digest.rows.map((r) => h('tr', {}, [
                    h('td', {}, r.label), h('td', { class: 'num mono' }, App.fmt.num(r.opsPerSec)),
                    h('td', { class: 'num mono' }, r.nsPerOp), h('td', { class: 'num mono' }, r.mbPerSec),
                  ])).concat(Bench.digest.largeRows.map((r) => h('tr', {}, [
                    h('td', {}, r.label + '（1 MiB）'), h('td', { class: 'num mono' }, App.fmt.num(r.opsPerSec)),
                    h('td', { class: 'num mono' }, App.fmt.num(r.nsPerOp, 0)), h('td', { class: 'num mono' }, r.mbPerSec),
                  ])))),
                ])]),
              ]),
            }),
            h('x-card', { title: 'Merkle 建根耗时随叶数增长', sub: `1000 叶树的证明路径 = ${Bench.merkle.proofPathNodes} 个节点（⌈log₂1000⌉）` }, {
              default: () => h('div', {}, [
                h('x-chart', { option: benchMerkleOption.value, height: 'h240' }),
                h('div', { class: 'tiny dim mt-16', style: 'line-height:1.85' }, App.fmt.md(Bench.merkle.theory)),
              ]),
            }),
          ]),

          h('div', { class: 'grid g2' }, [
            h('x-card', { title: '数字签名：双密码套件对照', sub: 'secp256k1 + ECDSA（国际）vs SM2（国密），304 B 载荷' }, {
              default: () => h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
                h('thead', {}, [h('tr', {}, [h('th', {}, '指标'), h('th', { class: 'num' }, '套件 A · secp256k1/ECDSA'), h('th', { class: 'num' }, '套件 B · SM2（国密）')])]),
                h('tbody', {}, [
                  h('tr', {}, [h('td', {}, '密钥生成'), h('td', { class: 'num mono' }, App.fmt.num(sg.suiteA.keygenPerSec) + ' /s'), h('td', { class: 'num mono' }, App.fmt.num(sg.suiteB.keygenPerSec) + ' /s')]),
                  h('tr', {}, [h('td', {}, '签名'), h('td', { class: 'num mono' }, App.fmt.num(sg.suiteA.signPerSec) + ' /s'), h('td', { class: 'num mono' }, App.fmt.num(sg.suiteB.signPerSec) + ' /s')]),
                  h('tr', {}, [h('td', {}, '验签'), h('td', { class: 'num mono' }, App.fmt.num(sg.suiteA.verifyPerSec) + ' /s'), h('td', { class: 'num mono' }, App.fmt.num(sg.suiteB.verifyPerSec) + ' /s')]),
                  h('tr', {}, [h('td', {}, '签名长度'), h('td', { class: 'num mono' }, sg.suiteA.signatureBytes + ' B'), h('td', { class: 'num mono' }, sg.suiteB.signatureBytes + ' B')]),
                  h('tr', {}, [h('td', {}, '自检 / 篡改拒绝'), h('td', {}, h('span', { class: ['tag', sg.suiteA.selfCheck && sg.suiteA.tamperRejected ? 'ok' : 'err'] }, sg.suiteA.selfCheck && sg.suiteA.tamperRejected ? '通过' : '失败')), h('td', {}, h('span', { class: ['tag', sg.suiteB.selfCheck && sg.suiteB.tamperRejected ? 'ok' : 'err'] }, sg.suiteB.selfCheck && sg.suiteB.tamperRejected ? '通过' : '失败'))]),
                ]),
              ])]),
            }),
            h('x-card', { title: '共识机制：PoA（本平台）vs PoW（公有链）', sub: '联盟链用实名可追责换取工业场景所需的吞吐与确定性时延' }, {
              default: () => h('div', {}, [
                h('x-chart', { option: benchBlockOption.value, height: 'h240' }),
                h('div', { class: 'grid g2 mt-16' }, [
                  kpi({ label: 'PoA 出块', value: bp.poa.msPerBlock, unit: 'ms/块', tone: 'ok', icon: 'chain', foot: `${App.fmt.num(bp.poa.tps)} TPS（${bp.txPerBlock} 交易/块）` }),
                  kpi({ label: 'PoW 难度 4 出块', value: bp.powComparison[3].avgMineMs, unit: 'ms/块', tone: 'warn', icon: 'alert', foot: `期望尝试 ${App.fmt.num(bp.powComparison[3].avgAttempts)} 次` }),
                ]),
                h('div', { class: 'tiny dim mt-16', style: 'line-height:1.85' }, App.fmt.md(bp.powNote)),
              ]),
            }),
          ]),

          h('x-card', { title: '全链构建与校验（1000 块 × 10 交易 = 10,000 笔存证）', sub: '构建 = 逐笔签名 + Merkle 建根 + 出块签名；校验 = 全量重算' }, {
            default: () => h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                kpi({ label: '数据规模', value: App.fmt.num(ch.txTotal) + ' 笔', unit: '', tone: 'info', icon: 'db', foot: App.fmt.bytes(ch.totalSizeBytes) }),
                kpi({ label: '构建吞吐', value: App.fmt.num(ch.build.tps), unit: 'TPS', tone: 'chain', icon: 'trade', foot: `${ch.build.msPerBlock} ms/块` }),
                kpi({ label: '全链校验吞吐', value: App.fmt.num(ch.verify.blocksPerSec), unit: '块/秒', tone: 'violet', icon: 'verify', foot: `${App.fmt.num(ch.verify.txSigVerified)} 笔验签 + ${App.fmt.num(ch.verify.txPayloadBindingChecked)} 笔链下重算绑定` }),
                kpi({ label: '检出错误', value: ch.verify.errorsFound, unit: '个', tone: ch.verify.pass ? 'ok' : 'err', icon: 'shield', foot: ch.verify.pass ? '校验通过（零错误）' : '存在异常' }),
              ]),
              h('div', { class: 'tiny dim mb-16', style: 'line-height:1.85' }, App.fmt.md(
                '值得注意的是：这个量级下**全链校验比构建还快**（2.93 s vs 5.96 s/块均摊），'
                + '原因是构建需要逐笔私钥签名（非对称运算），而校验只做哈希与验签。'
                + '这决定了联盟链的**监管可读性**：任意监管节点都能低成本地全量复核整条链。')),
              sub('五类篡改的检出对照（每类暴露在不同的密码学锚点上）'),
              h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
                h('thead', {}, [h('tr', {}, [h('th', {}, '攻击场景'), h('th', { style: 'width:42%' }, '被哪些锚点检出'), h('th', { style: 'width:64px' }, '检出')])]),
                h('tbody', {}, [
                  h('tr', {}, [h('td', {}, td.offChainDataTampered.scenario), h('td', { class: 'tiny' }, td.offChainDataTampered.withBindingCheck.join('；') || '—'), h('td', {}, h('span', { class: ['tag', td.offChainDataTampered.withBindingCaught ? 'ok' : 'err'] }, td.offChainDataTampered.withBindingCaught ? '已检出' : '漏检'))]),
                  h('tr', {}, [h('td', {}, td.blockHeaderTampered.scenario), h('td', { class: 'tiny' }, td.blockHeaderTampered.detected.join('；')), h('td', {}, h('span', { class: ['tag', td.blockHeaderTampered.pass ? 'ok' : 'err'] }, td.blockHeaderTampered.pass ? '已检出' : '漏检'))]),
                  h('tr', {}, [h('td', {}, td.txSetTampered.scenario), h('td', { class: 'tiny' }, td.txSetTampered.detected.join('；')), h('td', {}, h('span', { class: ['tag', td.txSetTampered.pass ? 'ok' : 'err'] }, td.txSetTampered.pass ? '已检出' : '漏检'))]),
                  h('tr', {}, [h('td', {}, td.onChainAnchorTampered.scenario), h('td', { class: 'tiny' }, td.onChainAnchorTampered.detected.join('；')), h('td', {}, h('span', { class: ['tag', td.onChainAnchorTampered.pass ? 'ok' : 'err'] }, td.onChainAnchorTampered.pass ? '已检出' : '漏检'))]),
                ]),
              ])]),
              h('div', { class: 'alertbar info mt-16' }, [
                h('x-icon', { name: 'alert', size: 15 }),
                h('span', {}, App.fmt.md(td.offChainDataTampered.verdict)),
              ]),
              h('div', { class: 'tiny dim mt-16', style: 'line-height:1.85' }, App.fmt.md(td.conclusion)),
            ]),
          }),

          h('x-card', { title: '口令安全（scrypt 内存硬）', sub: '离线爆破的代价由算法参数决定，而不是由攻击者算力决定' }, {
            default: () => h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                kpi({ label: 'scrypt 单次', value: pw.scrypt.msPerHash, unit: 'ms', tone: 'chain', icon: 'lock', foot: `${pw.scrypt.hashesPerSec} 次/秒` }),
                kpi({ label: '参数', value: 'N=16384', unit: '', tone: 'info', icon: 'key', foot: 'r=8, p=1 · 约 16 MiB/次' }),
                kpi({ label: '旧 SHA256 对照', value: App.fmt.big(pw.legacySha256.hashesPerSec), unit: '次/秒', tone: 'warn', icon: 'alert', foot: '比 scrypt 快约 5 万倍（故不可用于口令）' }),
                kpi({ label: '随机盐', value: pw.randomSalt.bytes, unit: 'B', tone: 'violet', icon: 'shield', foot: `${App.fmt.big(pw.randomSalt.perSec)} 次/秒` }),
              ]),
              h('div', { class: 'tiny dim', style: 'line-height:1.85' }, App.fmt.md(pw.scrypt.offLineCostNote)),
              h('div', { class: 'tiny dim mt-8', style: 'line-height:1.85' }, App.fmt.md(pw.upgradePolicy)),
            ]),
          }),
        ]);
      }

      /* ---- 判据证伪 ---- */
      function renderFalsify() {
        const f = falsify.value;
        return h('div', { class: 'col gap-16' }, [
          h('x-card', { title: '为什么必须做负向注入', sub: '如果一条判据在任何输入下都通过，它就不是判据' }, {
            default: () => h('div', { class: 'col gap-8' }, [
              h('div', { class: 'tiny', style: 'line-height:1.9' }, App.fmt.md(
                '本项目在开发过程中真实踩到过这个坑：**链上四道校验对"只改链下 payload 正文"完全无感** —— '
                + '因为交易签名签的是 payloadHash、Merkle 叶由 payloadHash 派生后作为独立字段存储，'
                + '所以改链下明文不会惊动任何链上锚点。补上第五道「链下重算绑定」校验后才检出。')),
              h('div', { class: 'tiny dim', style: 'line-height:1.9' }, App.fmt.md(
                '因此本节**故意破坏数据链路**，要求校验逻辑必须报警。报警 = 判据非空。')),
            ]),
          }),
          h('x-card', { title: '四类负向注入实测', sub: '每一类注入都对应一种真实攻击或数据错误' }, {
            flush: true,
            default: () => h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
              h('thead', {}, [h('tr', {}, [h('th', { style: 'width:40px' }, '#'), h('th', {}, '注入内容'), h('th', { style: 'width:22%' }, '注入方式'), h('th', { style: 'width:20%' }, '期望判据'), h('th', { style: 'width:28%' }, '实测观测'), h('th', { style: 'width:88px' }, '检出')])]),
              h('tbody', {}, f.cases.map((c) => h('tr', {}, [
                h('td', { class: 'mono' }, c.id),
                h('td', {}, c.name),
                h('td', { class: 'mono tiny' }, c.inject),
                h('td', { class: 'tiny dim' }, c.expect),
                h('td', { class: 'mono tiny' }, c.observed),
                h('td', {}, h('span', { class: ['tag', c.detected ? 'ok' : 'err'] }, c.detected ? '已检出' : '漏检')),
              ]))),
            ])]),
          }),
          h('x-card', { title: '判据有效性结论', sub: '实测可复核' }, {
            default: () => h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                kpi({ label: '注入用例', value: f.total, unit: '类', tone: 'info', icon: 'alert' }),
                kpi({ label: '成功检出', value: f.detectedCount, unit: '类', tone: 'ok', icon: 'verify' }),
                kpi({ label: '漏检', value: f.total - f.detectedCount, unit: '类', tone: f.total - f.detectedCount === 0 ? 'ok' : 'err', icon: 'shield' }),
                kpi({ label: '批次闭合容差', value: BATCH_TOL, unit: '%', tone: 'violet', icon: 'target', foot: '判据阈值（可调，越小越严）' }),
              ]),
              readout(f.allDetected, '判据非空性验证', f.allDetected
                ? `${f.total} 类故意破坏全部被检出 —— 判据不是"永远通过"的摆设`
                : `存在 ${f.total - f.detectedCount} 类漏检，判据需加强`),
              h('div', { class: 'tiny dim mt-8', style: 'line-height:1.85' }, App.fmt.md(
                '**可复现**：本页的注入用例在浏览器现场执行；同一逻辑也已固化进 '
                + '`scripts/uncertainty.js` 的 `checkFalsification()`，'
                + '评审可 `node scripts/uncertainty.js` 独立重跑并比对。')),
            ]),
          }),
        ]);
      }

      /* ---- 合规映射 ---- */
      function renderCompliance() {
        const std = S.standards || [];
        const pol = S.policies || [];
        const intl = S.internationalRules || [];
        const st = S.stats();
        return h('div', { class: 'col gap-16' }, [
          h('x-card', { title: '合规映射总览', sub: '平台每一项核算主张，都能指到一条标准/政策/规则的哪一款' }, {
            default: () => h('div', {}, [
              h('div', { class: 'grid g4 mb-16' }, [
                kpi({ label: '可追溯率', value: st.traceabilityPct, unit: '%', tone: 'ok', icon: 'verify', foot: `${st.total} 项因子/参数` }),
                kpi({ label: '官方出处', value: st.citations, unit: '条', tone: 'chain', icon: 'book', foot: `A 级 ${st.byLevel.A} · B 级 ${st.byLevel.B} · C 级 ${st.byLevel.C}` }),
                kpi({ label: '标准', value: st.standards, unit: '部', tone: 'info', icon: 'report', foot: '国标 / 团标 / 国际标准' }),
                kpi({ label: '政策与规则', value: st.policies + st.internationalRules, unit: '部', tone: 'violet', icon: 'shield', foot: `国内 ${st.policies} · 国际 ${st.internationalRules}` }),
              ]),
              h('div', { class: 'tiny dim', style: 'line-height:1.85' }, App.fmt.md(
                '**追溯等级定义**：A = 一手官方发布（附文号/公告号），可直接引用；'
                + 'B = 权威汇编（国标 / 团标 / 交易所披露文件附录）；'
                + 'C = 示例值，仅用于演示，正式申报须替换为官方当期值。')),
            ]),
          }),
          h('x-card', { title: '标准合规映射矩阵', sub: '每一条标准 → 本平台的落地位置' }, {
            flush: true,
            default: () => h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
              h('thead', {}, [h('tr', {}, [h('th', { style: 'width:150px' }, '标准编号'), h('th', {}, '名称'), h('th', { style: 'width:96px' }, '层级'), h('th', { style: 'width:64px' }, '等级'), h('th', { style: 'width:38%' }, '平台落地')])]),
              h('tbody', {}, std.map((x) => h('tr', {}, [
                h('td', { class: 'mono tiny' }, x.code),
                h('td', {}, [h('div', {}, x.cn), h('div', { class: 'tiny dim' }, `${x.issuer || ''} ${x.issuedAt || ''}`)]),
                h('td', {}, h('span', { class: 'tag t-info' }, x.level || x.kind)),
                h('td', {}, h('span', { class: ['tag', x.traceLevel === 'A' ? 'ok' : x.traceLevel === 'C' ? 'warn' : 't-info'] }, x.traceLevel + ' 级')),
                h('td', { class: 'tiny', style: 'line-height:1.75' }, App.fmt.md((x.maps ? '对标 ' + x.maps + '；' : '') + (x.note || x.purpose || ''))),
              ]))),
            ])]),
          }),
          h('x-card', { title: '国内政策依据', sub: '制度框架层面的合法性来源' }, {
            flush: true,
            default: () => h('div', { class: 'tbl-wrap' }, [h('table', { class: 'tbl' }, [
              h('thead', {}, [h('tr', {}, [h('th', { style: 'width:26%' }, '政策'), h('th', { style: 'width:16%' }, '发布机关'), h('th', { style: 'width:20%' }, '发布 / 施行'), h('th', { style: 'width:64px' }, '等级'), h('th', {}, '作用')])]),
              h('tbody', {}, pol.map((x) => h('tr', {}, [
                h('td', {}, [h('div', {}, x.cn), x.ref && h('div', { class: 'tiny dim mono' }, x.ref)]),
                h('td', { class: 'tiny' }, x.issuer),
                h('td', { class: 'tiny dim' }, x.issuedAt),
                h('td', {}, h('span', { class: ['tag', x.traceLevel === 'A' ? 'ok' : 't-info'] }, (x.traceLevel || 'B') + ' 级')),
                h('td', { class: 'tiny', style: 'line-height:1.75' }, App.fmt.md(x.purpose || '')),
              ]))),
            ])]),
          }),
          h('x-card', { title: '国际规则与平台映射', sub: '最要紧的一条：欧盟明确排除绿证抵扣电力间接排放' }, {
            default: () => h('div', { class: 'col gap-16' }, intl.map((x) => h('div', {}, [
              h('div', { class: 'flex between mb-16' }, [
                h('div', {}, [
                  h('div', { style: 'font-weight:600;color:var(--tx-0)' }, x.cn),
                  h('div', { class: 'tiny dim mono mt-8' }, x.code + ' · ' + x.ref),
                ]),
                h('span', { class: ['tag', x.traceLevel === 'A' ? 'ok' : 't-info'] }, (x.traceLevel || 'B') + ' 级'),
              ]),
              x.status ? h('div', { class: 'alertbar info mb-16' }, [h('x-icon', { name: 'alert', size: 15 }), h('span', {}, App.fmt.md(x.status))]) : null,
              x.coverage ? h('div', { class: 'flex gap-6 wrap mb-16' }, x.coverage.map((c) => h('span', { class: 'tag t-mute plain' }, c))) : null,
              x.expansion ? h('div', { class: 'tiny dim mb-16', style: 'line-height:1.8' }, App.fmt.md('**扩围**：' + x.expansion)) : null,
              x.mechanics ? h('div', { class: 'tbl-wrap mb-16' }, [h('table', { class: 'tbl' }, [
                h('tbody', {}, Object.keys(x.mechanics).map((k) => h('tr', {}, [
                  h('td', { style: 'width:30%', class: 'tiny dim' }, MECH_CN[k] || k),
                  h('td', { class: 'tiny', style: 'line-height:1.75' }, App.fmt.md(x.mechanics[k])),
                ]))),
              ])]) : null,
              x.impactCN ? h('div', { class: 'mb-16' }, [
                h('div', { class: 'tiny dim mb-16', style: 'line-height:1.8' }, App.fmt.md(
                  '**对中国出口的影响**：按缺省值法核算，每吨 CBAM 钢铁产品可能额外支付 '
                  + x.impactCN.costPerTonSteel.min + ' ~ ' + x.impactCN.costPerTonSteel.max
                  + ' ' + x.impactCN.costPerTonSteel.unit + '。' + x.impactCN.verification)),
                h('div', { class: 'tiny dim', style: 'line-height:1.8' }, App.fmt.md(x.impactCN.defaultPenalty)),
              ]) : null,
              x.platformMapping ? h('div', {}, [
                sub('本平台对应能力'),
                h('div', { class: 'col gap-8' }, x.platformMapping.map((p) => h('div', {
                  class: 'readout pass', style: 'font-size:12.4px',
                }, [h('span', { class: 'flag' }, 'MAP'), h('span', {}, App.fmt.md(p))]))),
              ]) : null,
              x.criticalFact ? h('div', { class: 'alertbar err mt-16' }, [h('x-icon', { name: 'alert', size: 15 }), h('span', {}, App.fmt.md(x.criticalFact))]) : null,
            ]))),
          }),
        ]);
      }

      return () => h('x-page', {
        title: '科研验证中心',
        desc: '全部算法主张摊开成可被质证的证据面板：可复现（固定种子）、可证伪（负向注入）、可复核（现场重算）',
      }, {
        actions: () => [
          h('span', { class: ['tag', allPass.value ? 'ok' : 'err'] }, allPass.value ? '六项验证全部通过' : '存在未通过项'),
          h('button', { class: 'btn sm', onClick: () => { runMC(); }, disabled: busy.value },
            [h('x-icon', { name: 'refresh', size: 14 }), '重跑抽样']),
        ],
        default: () => h('div', {}, [
          tabsBar(),
          tab.value === 'overview' ? renderOverview() : null,
          tab.value === 'reconcile' ? renderReconcile() : null,
          tab.value === 'uncertainty' ? renderUncertainty() : null,
          tab.value === 'bench' ? renderBench() : null,
          tab.value === 'falsify' ? renderFalsify() : null,
          tab.value === 'compliance' ? renderCompliance() : null,
        ]),
      });
    },
  });

  App.views['page-verify'] = PageVerify;
})();
