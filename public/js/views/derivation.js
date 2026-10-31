/* 「仅 CEMS 输入的派生链」视图
 * 后端：/api/derive/summary | /enterprise/:id | /report/:id | /coverage | /trace
 *
 * 这个页面的唯一职责是让「哪些是实测、哪些是派生、派生的边界在哪」一眼可见。
 * 不用 x-card（部分视图解析失败），用原生 div.card。 */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, h } = Vue;

  App.views = App.views || {};

  const card = (title, sub, children, extra) => h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [
      h('div', {}, [
        h('h3', {}, title),
        sub && h('div', { class: 'sub' }, sub),
      ]),
      extra || null,
    ]),
    h('div', { class: 'card-body' }, children),
  ]);

  const LAYER_STYLE = {
    REAL: { bg: '#e8f5e9', fg: '#1b5e20', label: '实测' },
    DERIVED: { bg: '#e3f2fd', fg: '#0d47a1', label: '可逆换算' },
    MODELED: { bg: '#fff3e0', fg: '#e65100', label: '含假设' },
  };
  const CONFIDENCE_STYLE = {
    HIGH: { bg: '#e8f5e9', fg: '#1b5e20' },
    MEDIUM: { bg: '#fff8e1', fg: '#f57f17' },
    LOW: { bg: '#ffebee', fg: '#b71c1c' },
  };
  const badge = (map, key, text) => {
    const s = map[key] || { bg: '#eceff1', fg: '#37474f' };
    return h('span', {
      style: `display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;`
        + `background:${s.bg};color:${s.fg};margin-right:4px;white-space:nowrap`,
    }, text || key);
  };

  /* ==================================================================
   * 派生链总览（企业端 / 监管端共用）
   * ================================================================== */
  App.views['page-derivation'] = defineComponent({
    name: 'page-derivation',
    setup() {
      const sum = ref(null);
      const detail = ref(null);
      const coverage = ref([]);
      const loading = ref(true);
      const busy = ref(false);
      const selectedEnt = ref('');
      const ents = ref([]);

      const load = async () => {
        loading.value = true;
        try {
          const [s, c] = await Promise.all([
            App.API.get('/derive/summary'),
            App.API.get('/derive/coverage'),
          ]);
          sum.value = s;
          coverage.value = (c && c.rows) || [];
          /* 企业下拉：从覆盖记录里取去重企业 */
          const seen = new Map();
          for (const r of coverage.value) {
            if (!seen.has(r.entId)) seen.set(r.entId, r.entName);
          }
          ents.value = [...seen.entries()].map(([id, name]) => ({ id, name }));
        } catch (e) {
          toast(e.message || '加载失败', 'error');
        } finally {
          loading.value = false;
        }
      };

      const pick = async (entId) => {
        selectedEnt.value = String(entId);
        if (!entId) { detail.value = null; return; }
        busy.value = true;
        try { detail.value = await App.API.get(`/derive/enterprise/${entId}`); }
        catch (e) { toast(e.message || '加载失败', 'error'); }
        finally { busy.value = false; }
      };

      onMounted(load);

      const summaryCards = computed(() => {
        if (!sum.value) return [];
        const c = sum.value.cemsInput;
        const d = sum.value.derivedReports;
        return [
          { k: 'CEMS 有效小时', v: Number(c.validHours).toLocaleString(), s: `${c.enterprises} 家企业 · ${c.anchoredBatches} 批次已上链` },
          { k: '派生上报单', v: Number(d.count || 0), s: d.count ? `${d.years[0]}–${d.years[1]} · ${d.enterprises} 家` : '—' },
          { k: '派生 CO₂ 合计', v: d.count ? `${(d.totalTco2 / 1e4).toFixed(2)} 万t` : '—', s: '官方活动水平法核算值' },
          { k: '血缘记录', v: Number(sum.value.lineage.total), s: `${sum.value.lineage.byRule.length} 条规则` },
        ];
      });

      const renderSummary = () => {
        /* /api/derive/summary 是全量聚合（实测 ~2.4s），用骨架占位代替
         * 一句"加载中…"，避免首屏被判成空页（2026-10-31 巡检 P3）。 */
        if (!sum.value) return h('div', {}, [
          h('div', { class: 'grid g4 mb-16' }, Array.from({ length: 4 }).map(() => h('div', { class: 'skel', style: 'height:96px' }))),
          h('div', { class: 'skel', style: 'height:220px' }),
        ]);
        const c = sum.value.cemsInput;
        return h('div', {}, [
          h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px' },
            summaryCards.value.map((x) => h('div', {
              style: 'border:1px solid #e0e0e0;border-radius:8px;padding:12px;background:#fff',
            }, [
              h('div', { style: 'font-size:12px;color:#78909c' }, x.k),
              h('div', { style: 'font-size:22px;font-weight:600;margin:4px 0;color:#263238' }, x.v),
              h('div', { style: 'font-size:11px;color:#90a4ae' }, x.s),
            ]))
          ),
          /* 能力边界：这一块是页面的核心，必须显眼 */
          h('div', {
            style: 'border-left:4px solid #ff8f00;background:#fff8e1;padding:12px 14px;border-radius:4px;margin-bottom:14px',
          }, [
            h('div', { style: 'font-weight:600;color:#e65100;margin-bottom:6px' }, '能力边界（必须如实披露）'),
            h('div', { style: 'font-size:13px;line-height:1.8;color:#5d4037' }, [
              h('div', {}, [h('b', {}, '实测：'), sum.value.capabilityBoundary.measured]),
              h('div', {}, [h('b', {}, '派生：'), sum.value.capabilityBoundary.derived]),
              h('div', {}, [h('b', {}, '不主张：'), sum.value.capabilityBoundary.notClaimed]),
            ]),
          ]),
          h('div', { style: 'font-size:12px;color:#607d8b;line-height:1.7' }, [
            h('div', {}, `数据区间：${c.periodFrom} → ${c.periodTo}`),
            h('div', {}, `来源：${c.note}`),
            sum.value.trading.deals > 0
              ? h('div', {}, `交易：${sum.value.trading.deals} 笔成交，量 ${sum.value.trading.volume.toLocaleString()} t，`
                + `金额 ${(sum.value.trading.turnover / 1e4).toFixed(2)} 万元`)
              : null,
          ]),
        ]);
      };

      const renderCoverage = () => {
        if (!coverage.value.length) return h('div', { class: 'empty' }, '暂无覆盖记录');
        const rows = coverage.value.map((r) => h('tr', {}, [
          h('td', {}, r.entName),
          h('td', {}, r.year),
          h('td', {}, r.outlet),
          h('td', { style: 'text-align:right' }, `${r.validHours}/${r.expectedHours}`),
          h('td', { style: 'text-align:right' }, r.gasPerTonM3 === null ? '—' : r.gasPerTonM3.toFixed(0)),
          h('td', { style: 'text-align:right' }, r.coverageRatio === null ? '未知' : (r.coverageRatio * 100).toFixed(1) + '%'),
          h('td', {}, h('span', {
            style: `padding:1px 8px;border-radius:9px;font-size:11px;`
              + (r.coverageRatio === null ? 'background:#eceff1;color:#546e7a'
                : r.coverageRatio < 0.5 ? 'background:#ffebee;color:#b71c1c'
                  : 'background:#e8f5e9;color:#1b5e20'),
          }, r.verdict)),
        ]));
        return h('div', {}, [
          h('div', { style: 'font-size:12px;color:#607d8b;margin-bottom:8px;line-height:1.7' },
            '每吨生活垃圾烟气量行业典型区间 4000–6000 m³/t。低于该区间说明 CEMS 只覆盖单个排口，'
            + '而官方处理量是全厂口径 —— 两者不可直接相比，因此本平台只用 CEMS 做时间分布权重，'
            + '不用它做质量基数。'),
          h('div', { class: 'table-wrap' }, [h('table', { class: 'table' }, [
            h('thead', {}, [h('tr', {}, ['企业', '年度', '排口', '有效/应有时长', '每吨烟气(m³/t)',
              '覆盖比', '判定'].map((t) => h('th', {}, t)))]),
            h('tbody', {}, rows),
          ])]),
        ]);
      };

      const renderDetail = () => {
        if (!selectedEnt.value) {
          return h('div', { class: 'empty' }, '请选择企业查看从 CEMS 到配额、清缴的完整派生链');
        }
        if (busy.value) return h('div', { class: 'empty' }, '加载中…');
        if (!detail.value) return h('div', { class: 'empty' }, '无数据');
        const d = detail.value;
        return h('div', {}, [
          /* 链路示意 */
          h('div', {
            style: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px;'
              + 'background:#f5f7fa;border-radius:8px;margin-bottom:14px;font-size:12px',
          }, [
            h('span', { style: 'padding:4px 10px;background:#e8f5e9;color:#1b5e20;border-radius:12px' }, 'CEMS 实测'),
            h('span', { style: 'color:#90a4ae' }, '→'),
            h('span', { style: 'padding:4px 10px;background:#e3f2fd;color:#0d47a1;border-radius:12px' }, '污染物汇总'),
            h('span', { style: 'color:#90a4ae' }, '→'),
            h('span', { style: 'padding:4px 10px;background:#fff3e0;color:#e65100;border-radius:12px' }, '季度 CO₂ 分配'),
            h('span', { style: 'color:#90a4ae' }, '→'),
            h('span', { style: 'padding:4px 10px;background:#f3e5f5;color:#4a148c;border-radius:12px' }, '第三方核查'),
            h('span', { style: 'color:#90a4ae' }, '→'),
            h('span', { style: 'padding:4px 10px;background:#e0f2f1;color:#004d40;border-radius:12px' }, '配额分配'),
            h('span', { style: 'color:#90a4ae' }, '→'),
            h('span', { style: 'padding:4px 10px;background:#fce4ec;color:#880e4f;border-radius:12px' }, '交易/清缴'),
          ]),

          /* CEMS 原始量 */
          d.cemsRaw.length ? h('div', { style: 'margin-bottom:14px' }, [
            h('div', { style: 'font-weight:600;margin-bottom:6px;font-size:13px' }, 'CEMS 原始实测（未经换算）'),
            ...d.cemsRaw.map((r) => h('div', {
              style: 'font-size:12px;color:#455a64;padding:6px 10px;background:#fafafa;border-radius:4px;margin-bottom:4px',
            }, `${r.year} 年：有效 ${r.validHours} h，烟气量 ${(r.flueGasM3 / 1e8).toFixed(3)} 亿m³，`
              + `SO₂ ${(r.pollutants.so2Kg / 1000).toFixed(2)} t，NOx ${(r.pollutants.noxKg / 1000).toFixed(2)} t，`
              + `烟尘 ${(r.pollutants.pmKg / 1000).toFixed(2)} t`)),
          ]) : null,

          /* 上报单 */
          d.reports.length ? h('div', { style: 'margin-bottom:14px' }, [
            h('div', { style: 'font-weight:600;margin-bottom:6px;font-size:13px' }, `派生上报单（${d.reports.length} 张）`),
            h('div', { class: 'table-wrap' }, [h('table', { class: 'table' }, [
              h('thead', {}, [h('tr', {}, ['单号', '期间', 'CO₂ (t)', '状态', '血缘', '链上区块']
                .map((t) => h('th', {}, t)))]),
              h('tbody', {}, d.reports.map((r) => h('tr', {}, [
                h('td', {}, r.reportNo),
                h('td', {}, r.period),
                h('td', { style: 'text-align:right' }, Number(r.totalEmission).toLocaleString()),
                h('td', {}, r.status),
                h('td', { style: 'text-align:center' }, r.lineageCount > 0 ? `✔ ${r.lineageCount}` : '✘'),
                h('td', {}, r.chainBlockIndex ? '#' + r.chainBlockIndex : '—'),
              ]))),
            ])]),
          ]) : null,

          /* 配额 */
          d.allocations.length ? h('div', { style: 'margin-bottom:14px' }, [
            h('div', { style: 'font-weight:600;margin-bottom:6px;font-size:13px' }, '配额分配'),
            ...d.allocations.map((a) => h('div', {
              style: 'font-size:12px;color:#455a64;padding:6px 10px;background:#fafafa;border-radius:4px;margin-bottom:4px',
            }, `${a.year} 年：${Number(a.quota).toLocaleString()} t（${a.method}，`
              + `基准强度 ${a.baselineIntensity} tCO₂/万kWh），链上 #${a.chainBlockIndex}`)),
          ]) : null,

          /* 清缴 */
          d.surrenders.length ? h('div', {}, [
            h('div', { style: 'font-weight:600;margin-bottom:6px;font-size:13px' }, '履约清缴'),
            ...d.surrenders.map((s) => h('div', {
              style: 'font-size:12px;color:#455a64;padding:6px 10px;background:#fafafa;'
                + 'border-radius:4px;margin-bottom:4px',
            }, `${s.year} 年：应缴 ${Number(s.required).toLocaleString()} t，`
              + `已缴 ${Number(s.surrendered).toLocaleString()} t，`
              + (s.shortfall > 0 ? `缺口 ${Number(s.shortfall).toLocaleString()} t，罚款 ${Number(s.penalty).toLocaleString()} 元` : '无缺口')
              + ` · ${s.status}`)),
          ]) : null,
        ]);
      };

      return () => h('div', { class: 'page' }, [
        h('div', { class: 'page-head' }, [
          h('h2', {}, '派生核算链（仅 CEMS 输入）'),
          h('div', { class: 'sub' },
            '企业只提供 CEMS 实测数据，平台派生上报单、核查、配额与清缴。'
            + '每条派生记录都可反向指认它用到的真实输入与所用规则。'),
        ]),
        loading.value ? h('div', { class: 'empty' }, '加载中…') : h('div', {}, [
          card('总览', null, [renderSummary()]),
          card('CEMS 覆盖口径：单排口 ≠ 全厂', null, [renderCoverage()]),
          card('企业派生链', null, [
            h('div', { style: 'margin-bottom:12px' }, [
              h('select', {
                style: 'padding:6px 10px;border:1px solid #cfd8dc;border-radius:4px;min-width:260px',
                value: selectedEnt.value,
                onChange: (e) => pick(e.target.value),
              }, [
                h('option', { value: '' }, '— 选择企业 —'),
                ...ents.value.map((e) => h('option', { value: String(e.id) }, e.name)),
              ]),
            ]),
            renderDetail(),
          ]),
        ]),
      ]);
    },
  });
})();
