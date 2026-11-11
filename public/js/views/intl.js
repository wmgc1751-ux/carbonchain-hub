/* =====================================================================
   intl.js —— WP5 国际互认与绿电溯源（三个页面）
   ---------------------------------------------------------------------
   ① /cbam          CBAM 碳关税申报数据包（ISO 14067 产品碳足迹口径）
        · 法规基准摆在最前面（依据哪一版法规、实施期、现行覆盖范围）
        · 试算面板：逐步代入过程 + EU 默认值对照 + 成本影响
        · 生成申报包并上链；申报包台账
        · 成本量化对照（与第三方核查服务报价的可核验对比）
   ② /greenpower    小时级绿电溯源
        · 绿电与用电的小时级匹配（不是年度总量相减）
        · 未匹配小时按区域电网基准线因子计排放，残余混合因子如实披露
   ③ /dual-report   双轨报告导出（ISO 14064-1 组织轨 / ISO 14067 产品轨）
        · 两轨同时计算才能互证：组织总量应 ≥ 已核算产品的隐含碳之和
        · 导出即上链，文件指纹用于证明"交付的就是这份"

   贯穿三个页面的立场：**出口合规最怕"算法说不清、数据来源说不清"。**
   因此每一处数值都带 provenance（实测 / 推导 / 引用），无法实测的如实标注"未纳入"。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted } = Vue;
  const h = App.h;

  const STYLE_ID = 'intl-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
.intl-step{display:flex;gap:11px;padding:9px 0;border-bottom:1px solid var(--hair)}
.intl-step:last-child{border-bottom:none}
.intl-step .no{flex:none;width:20px;height:20px;border-radius:6px;background:rgba(56,189,248,.14);
  color:#7dd3fc;font-family:var(--mono);font-size:11px;display:flex;align-items:center;justify-content:center;margin-top:1px}
.intl-step .tt{font-size:12.5px;color:var(--tx-0)}
.intl-step .fx{font-family:var(--mono);font-size:11.3px;color:var(--tx-3);margin-top:2px;word-break:break-all}
.intl-step .vv{font-family:var(--mono);font-size:11.8px;color:var(--brand-l);margin-top:3px;word-break:break-all}
.intl-formula{background:var(--bg-0);border:1px solid var(--hair);border-radius:8px;padding:11px 13px;
  font-family:var(--mono);font-size:11.8px;line-height:1.85;color:var(--brand-l);word-break:break-all}
.intl-quote{border-left:3px solid rgba(16,185,129,.5);padding:8px 12px;background:rgba(16,185,129,.05);
  border-radius:0 8px 8px 0;font-size:12.3px;line-height:1.75;color:var(--tx-1)}
.intl-warn{border-left:3px solid rgba(245,165,36,.5);padding:8px 12px;background:rgba(245,165,36,.05);
  border-radius:0 8px 8px 0;font-size:12.3px;line-height:1.75;color:var(--tx-1)}
.intl-kv{display:grid;grid-template-columns:150px 1fr;gap:8px 14px;font-size:12.6px}
.intl-kv dt{color:var(--tx-3);font-size:12px}
.intl-kv dd{font-family:var(--mono);color:var(--tx-0);margin:0;word-break:break-all}
`;
    document.head.appendChild(el);
  }

  const num = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '-' : App.fmt.num(v, d);
  const pct = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '-' : (v * 100).toFixed(d) + '%';

  function kpiGrid(items) {
    return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(178px,1fr))' },
      items.map((k) => h('x-kpi', k)));
  }

  /** 非企业角色：渲染企业选择器（企业角色由令牌自动带入，无需选择） */
  function entPicker(isEnt, entId, ents) {
    if (isEnt || !ents.value.length) return null;
    return h('select', {
      class: 'input', style: 'width:200px;height:30px', value: entId.value,
      'aria-label': '选择企业',
      onChange: (e) => { entId.value = Number(e.target.value); },
    }, ents.value.map((o) => h('option', { value: o.id }, o.entName)));
  }

  /** 通用：加载企业下拉列表，返回 { id, entName } 数组（非 ref） */
  async function useEnts(isEnt, entId) {
    if (isEnt) return [];
    try {
      const d = await App.API.get('/public/enterprises', { page: 1, size: 200 });
      const list = ((d && (d.rows || d)) || []).map((x) => ({ id: x.id, entName: x.ent_name }));
      if (!entId.value && list.length) entId.value = list[0].id;
      return list;
    } catch (e) { return []; }
  }

  function useRole() {
    const u = App.Store.user || {};
    return { isEnt: u.role === 'ENTERPRISE', canWrite: ['ENTERPRISE', 'ADMIN', 'REGULATOR'].includes(u.role), role: u.role };
  }

  /* 步骤渲染（试算过程的逐步代入） */
  function stepList(steps) {
    return h('div', { class: 'card-body' }, (steps || []).map((st, i) => h('div', { class: 'intl-step' }, [
      h('span', { class: 'no' }, String(i + 1)),
      h('div', { class: 'flex-1' }, [
        h('div', { class: 'tt' }, st.name + (st.kind ? '　' + h('span', { class: 'tag t-mute plain', style: 'font-size:11px' }, st.kind) : '')),
        h('div', { class: 'fx' }, st.formula || ''),
        h('div', { class: 'vv' }, `${num(st.value, 4)} ${st.unit || ''}${st.note ? '　· ' + st.note : ''}`),
      ]),
    ])));
  }

  /* ==================================================================
   * ① CBAM 碳关税申报
   * ================================================================== */
  const PageCbam = defineComponent({
    name: 'page-cbam',
    setup() {
      injectStyle();
      const { isEnt, canWrite } = useRole();
      const entId = ref(isEnt ? Number(App.Store.user.orgId) : null);
      const ents = ref([]);
      const catalog = ref(null);
      const decls = ref([]);
      const declTotal = ref(0);
      const cost = ref(null);
      const calc = ref(null);
      const genResult = ref(null);
      const busy = ref(false);
      const form = reactive({ period: '2026Q1', cnCode: '', quantity: '' });

      async function loadStatic() {
        catalog.value = await App.API.get('/cbam/catalog').catch(() => null);
        cost.value = await App.API.get('/cost/comparison', isEnt ? {} : { entId: entId.value }).catch(() => null);
        if (catalog.value && catalog.value.cnCodes && catalog.value.cnCodes.length && !form.cnCode) {
          form.cnCode = catalog.value.cnCodes[0].code;
        }
      }
      async function loadDecls() {
        try {
          const d = await App.API.get('/cbam/declarations', Object.assign({ page: 1, size: 20 }, isEnt ? {} : { entId: entId.value }));
          decls.value = (d && (d.rows || d)) || [];
          declTotal.value = (d && d.total) || decls.value.length;
        } catch (e) { decls.value = []; }
      }
      async function doCalc() {
        busy.value = true; genResult.value = null;
        try {
          calc.value = await App.API.post('/cbam/calc', {
            entId: entId.value, period: form.period, cnCode: form.cnCode,
            quantity: form.quantity === '' ? undefined : Number(form.quantity),
          });
          App.notify.ok('试算完成（未落库、未上链）');
        } catch (e) { App.notify.err(e.message); calc.value = null; }
        finally { busy.value = false; }
      }
      async function doGenerate() {
        if (!(await App.confirm('按当前参数生成 CBAM 申报包并写入联盟链存证？\n\n该动作会落库一条申报记录并上链（区块 +1）。'))) return;
        busy.value = true;
        try {
          genResult.value = await App.API.post('/cbam/generate', {
            entId: entId.value, period: form.period, cnCode: form.cnCode,
            quantity: form.quantity === '' ? undefined : Number(form.quantity),
          });
          App.notify.ok(`申报包 ${genResult.value.declNo} 已生成并上链`);
          await loadDecls();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      onMounted(async () => {
        ents.value = await useEnts(isEnt, entId);
        await loadStatic(); await loadDecls();
      });

      function openDeclaration(row) {
        App.showChainProof('CBAM 申报包 ' + row.decl_no, '/chain/tx/' + (row.chain_tx_id || ''));
      }

      return () => {
        const c = catalog.value || {};
        const reg = (c.regulation && c.regulation.cbam) || {};
        const bench = (calc.value && calc.value.benchmark) || {};
        const elec = (calc.value && calc.value.electricity) || {};
        const prov = (calc.value && calc.value.provenance) || {};
        const qp = (calc.value && calc.value.quantityProvenance) || {};

        return h('x-page', {
          title: 'CBAM 碳关税申报数据包',
          desc: '欧盟碳边境调节机制（CBAM）出口申报 · 按 ISO 14067 产品碳足迹口径核算隐含碳 · 每一个数值都带数据来源',
        }, {
          actions: () => [
            entPicker(isEnt, entId, ents),
            h('button', { class: 'btn sm ghost', onClick: () => { loadStatic(); loadDecls(); } }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ],
          default: () => [
            App.staticNote('当前为静态演示模式：法规基准、目录与台账为快照时点值；'
              + '「试算」命中快照时点的真实核算过程；「生成申报包」在静态模式下不落库。'),
            /* ── 法规基准（摆在最前面） ── */
            h('x-card', { title: '法规基准与适用范围', sub: '先固定依据哪一版法规，再谈数值 —— 否则算得再细也无法对外申报' }, {
              default: () => h('div', { class: 'card-body' }, [
                h('dl', { class: 'intl-kv' }, [
                  h('dt', {}, '法规名称'), h('dd', {}, reg.name || '—'),
                  h('dt', {}, '法规编号'), h('dd', {}, reg.regulation || '—'),
                  h('dt', {}, '实施条例'), h('dd', {}, reg.implementing || '—'),
                  h('dt', {}, '过渡期'), h('dd', {}, reg.transition || '—'),
                  h('dt', {}, '正式征收期'), h('dd', {}, reg.definitive || '—'),
                  h('dt', {}, '现行覆盖范围'), h('dd', {}, reg.scopeNow || '—'),
                  h('dt', {}, '后续拟扩展'), h('dd', {}, reg.scopeFuture || '—'),
                ]),
                reg.note ? h('div', { class: 'intl-quote mt-16' }, App.fmt.md(reg.note)) : null,
                h('div', { class: 'tiny dim mb-8 mt-16' }, '覆盖商品编码（CN Code）与 EU 默认隐含碳强度'),
                h('x-table', {
                  columns: [
                    { key: 'code', title: 'CN 编码', width: '110px' },
                    { key: 'sector', title: '行业', width: '110px' },
                    { key: 'goods', title: '商品' },
                    { key: 'unit', title: '计量单位', width: '92px' },
                    { key: 'euDefaultIntensity', title: 'EU 默认强度', align: 'right', width: '130px' },
                  ],
                  rows: c.cnCodes || [],
                  rowKey: 'code',
                  empty: '无目录数据',
                }, {
                  'col-code': ({ row }) => h('span', { class: 'mono' }, row.code),
                  'col-goods': ({ row }) => h('span', { style: 'font-size:12.5px' }, row.goods),
                  'col-euDefaultIntensity': ({ row }) => h('span', { class: 'mono' }, num(row.euDefaultIntensity, 4)),
                }),
              ]),
            }),

            /* ── 试算 ── */
            h('x-card', { title: '申报试算（不落库、不上链）', sub: '生成正式申报包之前可反复调整参数；试算与正式生成的算法完全一致', class: 'mt-16' }, {
              actions: () => [
                h('button', { class: 'btn sm', disabled: busy.value, onClick: doCalc }, [h('x-icon', { name: 'target', size: 14 }), '试算']),
                canWrite ? h('button', { class: 'btn sm primary', disabled: busy.value || !calc.value, onClick: doGenerate },
                  [h('x-icon', { name: 'chain', size: 14 }), '生成申报包并上链']) : null,
              ],
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'flex gap-10 wrap mb-16', style: 'align-items:flex-end' }, [
                  h('div', { style: 'width:140px' }, [
                    h('div', { class: 'tiny dim mb-6' }, '申报期'),
                    h('input', { class: 'input', style: 'height:31px', value: form.period, onInput: (e) => { form.period = e.target.value; } }),
                  ]),
                  h('div', { style: 'width:220px' }, [
                    h('div', { class: 'tiny dim mb-6' }, '商品编码'),
                    h('select', {
                      class: 'input', style: 'height:31px', value: form.cnCode,
                      onChange: (e) => { form.cnCode = e.target.value; },
                    }, (c.cnCodes || []).map((x) => h('option', { value: x.code }, `${x.code} · ${x.goods}`))),
                  ]),
                  h('div', { style: 'width:170px' }, [
                    h('div', { class: 'tiny dim mb-6' }, '出口产量（留空按估算）'),
                    h('input', { class: 'input', style: 'height:31px', type: 'number', value: form.quantity, onInput: (e) => { form.quantity = e.target.value; } }),
                  ]),
                ]),

                !calc.value
                  ? h('div', { class: 'alertbar info' }, [h('x-icon', { name: 'info', size: 15 }), '填写参数后点「试算」查看逐步代入过程与成本影响。'])
                  : [
                    kpiGrid([
                      { label: '隐含碳强度', value: num(calc.value.embeddedIntensity, 4), unit: `tCO₂e/${calc.value.unit || 't'}`, tone: 'carbon', icon: 'leaf', foot: `EU 默认 ${num(bench.euDefaultIntensity, 4)}` },
                      { label: '总排放', value: num(calc.value.totalEmission, 2), unit: 'tCO₂e', tone: 'sky', icon: 'fire', foot: `直接 ${num(calc.value.directEmission, 2)} + 间接 ${num(calc.value.indirectEmission, 2)}` },
                      { label: '出口产量', value: num(calc.value.quantity, 2), unit: calc.value.unit || '', tone: 'violet', icon: 'factory', foot: qp.kind ? (qp.label || qp.kind) : '' },
                      { label: '绿电匹配率', value: pct(elec.greenRatio), unit: '', tone: (elec.greenRatio || 0) > 0.5 ? 'carbon' : 'amber', icon: 'leaf', foot: `绿电 ${num(elec.greenMatchedMwh, 1)} / 用电 ${num(elec.mwh, 1)} MWh` },
                      { label: '相对 EU 默认值', value: bench.penaltyTco2 > 0 ? '+' + num(bench.penaltyTco2, 2) : num(bench.penaltyTco2, 2), unit: 'tCO₂e', tone: bench.penaltyTco2 > 0 ? 'rose' : 'carbon', icon: 'target', foot: bench.verdict || '' },
                      { label: '电网因子', value: num(elec.gridFactor, 4), unit: 'tCO₂e/MWh', tone: 'chain', icon: 'db', foot: elec.gridFactorSource || '' },
                    ]),

                    h('div', { class: 'grid mt-16', style: 'grid-template-columns:1fr 1fr' }, [
                      h('x-card', { title: '核算过程逐步代入' }, { default: () => stepList(calc.value.steps) }),
                      h('div', { class: 'col gap-16' }, [
                        h('x-card', { title: '与 EU 默认值的对照' }, {
                          default: () => h('div', { class: 'card-body' }, [
                            h('dl', { class: 'intl-kv' }, [
                              h('dt', {}, '本平台实测强度'), h('dd', {}, `${num(calc.value.embeddedIntensity, 4)} tCO₂e/${calc.value.unit}`),
                              h('dt', {}, 'EU 默认强度'), h('dd', {}, `${num(bench.euDefaultIntensity, 4)} tCO₂e/${calc.value.unit}`),
                              h('dt', {}, 'EU 默认对应总量'), h('dd', {}, `${num(bench.euDefaultTotal, 2)} tCO₂e`),
                              h('dt', {}, '差额（正=我更有优势）'), h('dd', {}, `${num(bench.penaltyTco2, 2)} tCO₂e`),
                            ]),
                            bench.note ? h('div', { class: 'intl-quote mt-16' }, App.fmt.md(bench.note)) : null,
                          ]),
                        }),
                        h('x-card', { title: '数据来源声明（provenance）', sub: '每一项数值都要能回答"这个数从哪来"' }, {
                          default: () => h('div', { class: 'card-body' }, [
                            h('div', { class: 'tiny dim mb-6' }, '实测来源'),
                            h('div', { class: 'col gap-5 mb-12' }, (prov.measured || []).map((x) => h('div', { class: 'intl-quote' }, '· ' + x))),
                            h('div', { class: 'tiny dim mb-6' }, '推导来源'),
                            h('div', { class: 'col gap-5 mb-12' }, (prov.derived || []).map((x) => h('div', { class: 'intl-formula' }, x))),
                            h('div', { class: 'tiny dim mb-6' }, '引用来源'),
                            h('div', { class: 'col gap-5' }, (prov.referenced || []).map((x) => h('div', { class: 'intl-formula' }, x))),
                            prov.disclaimer ? h('div', { class: 'intl-warn mt-16' }, App.fmt.md(prov.disclaimer)) : null,
                          ]),
                        }),
                      ]),
                    ]),

                    genResult.value ? h('x-card', { title: `申报包已生成：${genResult.value.declNo}`, class: 'mt-16' }, {
                      default: () => h('div', { class: 'card-body' }, [
                        h('div', { class: 'flex gap-16 wrap' }, [
                          h('x-readout', { pass: true, label: '已写入联盟链存证', detail: '区块 #' + ((genResult.value.chain && genResult.value.chain.blockIndex) || '—') }),
                          h('x-readout', { pass: true, label: `证据摘要（${genResult.value.digest.algorithm}）`, detail: String(genResult.value.digest.digest).slice(0, 24) + '…' }),
                          h('x-readout', { pass: true, label: '已支付碳成本（有偿竞价部分）', detail: App.fmt.num(genResult.value.carbonPricePaid, 0) + ' CNY' }),
                        ]),
                      ]),
                    }) : null,
                  ],
              ]),
            }),

            /* ── 申报包台账 ── */
            h('x-card', { title: 'CBAM 申报包台账', sub: `共 ${declTotal.value} 份 · 每份均带链上存证与证据摘要`, class: 'mt-16' }, {
              default: () => h('div', { class: 'card-body flush' }, [
                h('x-table', {
                  columns: [
                    { key: 'decl_no', title: '申报编号', width: '220px' },
                    { key: 'ent_name', title: '企业' },
                    { key: 'period', title: '申报期', width: '92px' },
                    { key: 'goods_name', title: '商品', width: '130px' },
                    { key: 'goods_quantity', title: '产量', align: 'right', width: '110px' },
                    { key: 'embedded_intensity', title: '隐含碳强度', align: 'right', width: '120px' },
                    { key: 'evidence_digest', title: '证据摘要', width: '130px' },
                    { key: 'block_index', title: '链上存证', width: '100px' },
                    { key: 'created_at', title: '生成时间', width: '146px' },
                  ],
                  rows: decls.value,
                  rowKey: 'id',
                  empty: '暂无申报包（可在上方试算后生成）',
                }, {
                  'col-decl_no': ({ row }) => h('span', { class: 'mono', style: 'font-size:11.6px' }, row.decl_no),
                  'col-goods_quantity': ({ row }) => `${num(row.goods_quantity, 2)} ${row.quantity_unit || ''}`,
                  'col-embedded_intensity': ({ row }) => h('span', { class: 'mono' }, num(row.embedded_intensity, 4)),
                  'col-evidence_digest': ({ row }) => h('x-hash', { value: row.evidence_digest, len: 10 }),
                  'col-block_index': ({ row }) => h('x-chainbadge', { block: row.block_index, hash: row.chain_tx_id, label: '点击核验存证' }),
                  'col-created_at': ({ row }) => h('span', { class: 'tiny dim' }, row.created_at),
                }),
              ]),
            }),

            /* ── 成本对照 ── */
            cost.value ? h('x-card', { title: '成本量化对照', sub: '给出可核验的计算过程，而不是一个结论性的"省了多少钱"', class: 'mt-16' }, {
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr' }, [
                  h('div', {}, [
                    h('dl', { class: 'intl-kv mb-16' }, [
                      h('dt', {}, 'EUA 碳价'), h('dd', {}, `${num(cost.value.prices.euaEur, 2)} EUR/t · 来源：${cost.value.prices.euaSource || '—'}`),
                      h('dt', {}, '汇率'), h('dd', {}, `${num(cost.value.prices.eurCny, 4)} CNY/EUR · 来源：${cost.value.prices.fxSource || '—'}`),
                    ]),
                    h('div', { class: 'tiny dim mb-8' }, '基准数据来源'),
                    h('div', { class: 'col gap-5' }, (cost.value.baselineSources || []).map((x) => h('div', { class: 'intl-formula' }, x))),
                  ]),
                  h('div', {}, (cost.value.items || []).map((it) => {
                    /* 成本项有两种结构：核查成本带 baseline/platform（第三方报价对照），
                       履约成本带 steps/carbonPrice/saving（规避溢价支出的逐步计算）。 */
                    if (it.baseline) {
                      return h('div', { class: 'card mb-12', style: 'padding:12px 14px' }, [
                        h('div', { class: 'flex between mb-8' }, [
                          h('b', { style: 'font-size:13px' }, it.item),
                          h('x-tag', { text: `节省 ${App.fmt.num(it.savingPerEnt, 0)} ${it.baseline.unit}`, tone: 't-ok' }),
                        ]),
                        h('div', { class: 'tiny dim mb-8', style: 'line-height:1.65' },
                          `第三方基准：${App.fmt.num(it.baseline.low, 0)} ~ ${App.fmt.num(it.baseline.high, 0)} ${it.baseline.unit}（${it.baseline.budget}）；本平台：${num(it.platform.laborWan, 2)} 万元/年`),
                        h('x-bars', {
                          items: [
                            { name: '第三方下限', value: it.baseline.low },
                            { name: '第三方上限', value: it.baseline.high },
                            { name: '本平台', value: (it.platform.laborWan || 0) * 10000 },
                          ],
                          format: (v) => App.fmt.big(v),
                        }),
                        it.caveat ? h('div', { class: 'intl-warn mt-12' }, App.fmt.md(it.caveat)) : null,
                      ]);
                    }
                    return h('div', { class: 'card mb-12', style: 'padding:12px 14px' }, [
                      h('div', { class: 'flex between mb-8' }, [
                        h('b', { style: 'font-size:13px' }, it.item),
                        it.saving != null ? h('x-tag', { text: `规避支出 ${App.fmt.big(it.saving)} 元`, tone: 't-ok' }) : null,
                      ]),
                      it.carbonPrice != null ? h('div', { class: 'tiny dim mb-8' },
                        `当期碳价 ${App.fmt.num(it.carbonPrice, 2)} 元/tCO₂e · ${it.carbonPriceSource || ''}`) : null,
                      h('div', { class: 'intl-formula mb-8' }, (it.steps || []).map((st) =>
                        `【${st.step}】${st.formula}：${st.calc}  ⇒  ${num(st.value, 2)} ${st.unit || ''}`).join('\n')),
                      it.caveat ? h('div', { class: 'intl-warn' }, App.fmt.md(it.caveat)) : null,
                    ]);
                  })),
                ]),
                h('div', { class: 'col gap-6 mt-16' }, (cost.value.principles || []).map((p) =>
                  h('div', { class: 'intl-quote' }, App.fmt.md(p)))),
              ]),
            }) : null,
          ],
        });
      };
    },
  });

  /* ==================================================================
   * ② 小时级绿电溯源
   * ================================================================== */
  const PageGreenPower = defineComponent({
    name: 'page-greenpower',
    setup() {
      injectStyle();
      const { isEnt, canWrite } = useRole();
      const entId = ref(isEnt ? Number(App.Store.user.orgId) : null);
      const ents = ref([]);
      const summary = ref(null);
      const matchResult = ref(null);
      const busy = ref(false);
      const form = reactive({ year: '', month: '', days: '' });

      async function load() {
        summary.value = await App.API.get('/greenpower/summary', isEnt ? {} : { entId: entId.value }).catch(() => null);
      }
      async function doMatch() {
        busy.value = true;
        try {
          const r = await App.API.post('/greenpower/match', {
            entId: entId.value,
            year: form.year === '' ? undefined : Number(form.year),
            month: form.month === '' ? undefined : Number(form.month),
            days: form.days === '' ? undefined : Number(form.days),
          });
          if (!r || !r.summary) {
            /* 该端点在本版本未实现（小时级匹配需读写时序库）。
             * ⚠ 原本文案写的是「静态演示模式下不执行」——但静态模式已删除，
             * 那句话会让人以为「换个模式就能用」。现在如实说：该能力未实现。 */
            matchResult.value = null;
            App.notify.warn('小时级绿电匹配需要读写时序数据库，当前版本尚未实现该能力。');
            return;
          }
          matchResult.value = r;
          App.notify.ok(`已完成 ${r.summary.hours} 小时的绿电匹配`);
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      onMounted(async () => { ents.value = await useEnts(isEnt, entId); await load(); });

      function dailyOption() {
        const d = ((summary.value && summary.value.daily) || []).slice().reverse();
        return App.chartBase({
          grid: { left: 8, right: 42, top: 32, bottom: 6, containLabel: true },
          xAxis: App.catAxis(d.map((x) => String(x.date).slice(5))),
          yAxis: [
            App.valAxis({ name: 'MWh', nameTextStyle: { color: '#8d9cb5', fontSize: 11 } }),
            App.valAxis({ name: '绿电占比%', position: 'right', splitLine: { show: false }, min: 0, max: 100, axisLabel: { color: '#f5a524', fontSize: 11 } }),
          ],
          series: [
            { name: '用电量', type: 'bar', stack: 'e', data: d.map((x) => x.consumptionMwh), itemStyle: { color: 'rgba(56,189,248,.55)' }, barMaxWidth: 26 },
            { name: '绿电', type: 'bar', stack: 'g', data: d.map((x) => x.greenMwh), itemStyle: { color: '#10b981' }, barMaxWidth: 26 },
            { name: '绿电占比', type: 'line', yAxisIndex: 1, smooth: true, symbolSize: 5, data: d.map((x) => (x.ratio * 100).toFixed(2)), lineStyle: { color: '#f5a524' }, itemStyle: { color: '#f5a524' } },
          ],
          legend: { textStyle: { color: '#8d9cb5', fontSize: 11.5 }, top: 2, icon: 'roundRect', itemWidth: 10, itemHeight: 10 },
        });
      }

      return () => {
        const s = summary.value || {};
        const m = matchResult.value || {};
        return h('x-page', {
          title: '小时级绿电溯源',
          desc: '绿电与用电按小时匹配（而非年度总量相减）· 未匹配小时按区域电网基准线因子计排放 · 残余混合因子如实披露',
        }, {
          actions: () => [
            entPicker(isEnt, entId, ents),
            canWrite ? h('button', { class: 'btn sm primary', disabled: busy.value, onClick: doMatch },
              [h('x-icon', { name: 'play', size: 14 }), busy.value ? '匹配中…' : '执行本期匹配']) : null,
            h('button', { class: 'btn sm ghost', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ],
          default: () => [
            App.staticNote('当前为静态演示模式：绿电匹配为快照时点结果；'
              + '「执行本期匹配」需读写时序数据库，静态模式下会如实提示而不伪造结果。'),
            kpiGrid([
              { label: '用电总量', value: num(s.consumptionMwh, 1), unit: 'MWh', tone: 'sky', icon: 'factory', foot: `覆盖 ${s.hours || 0} 小时 · ${s.enterprises || 0} 家企业` },
              { label: '绿电总量', value: num(s.greenMwh, 1), unit: 'MWh', tone: 'carbon', icon: 'leaf', foot: `凭证 ${(s.byCert || []).length} 张` },
              { label: '绿电覆盖率', value: pct(s.coverageRatio), unit: '', tone: (s.coverageRatio || 0) > 0.5 ? 'carbon' : 'amber', icon: 'target', foot: '小时级匹配口径，非年度总量口径' },
              { label: '完全匹配小时', value: App.fmt.num(s.hoursMatched || 0), unit: '小时', tone: 'violet', icon: 'check', foot: `部分匹配 ${s.hoursPartial || 0} · 未匹配 ${s.hoursUnmatched || 0}` },
              { label: '平均电网因子', value: num(s.avgGridFactor, 4), unit: 'tCO₂e/MWh', tone: 'chain', icon: 'db', foot: '区域电网基准线因子' },
              { label: '残余混合因子', value: num(s.avgResidualFactor, 4), unit: 'tCO₂e/MWh', tone: 'amber', icon: 'layers', foot: '扣除绿电后的实际用电排放强度' },
              { label: '减碳量', value: num(s.savedTco2, 2), unit: 'tCO₂e', tone: 'carbon', icon: 'leaf', foot: '绿电替代电网电力的减排量' },
            ]),

            h('div', { class: 'grid mt-16', style: 'grid-template-columns:1.25fr .75fr' }, [
              h('x-card', { title: '日度用电与绿电结构', sub: '绿电占比以折线叠加，可直观看出匹配是否稳定' }, {
                default: () => h('div', { class: 'card-body' }, [
                  (s.daily || []).length
                    ? h('x-chart', { option: dailyOption(), height: 'h260' })
                    : h('div', { class: 'alertbar info' }, [h('x-icon', { name: 'info', size: 15 }), '暂无匹配数据，点右上「执行本期匹配」生成。']),
                ]),
              }),
              h('x-card', { title: '绿电凭证清单', sub: '每张凭证对应的电量与匹配小时数' }, {
                default: () => h('div', { class: 'card-body flush' }, [
                  h('x-table', {
                    columns: [
                      { key: 'certNo', title: '凭证编号', width: '150px' },
                      { key: 'certType', title: '类型', width: '100px' },
                      { key: 'sourceName', title: '来源' },
                      { key: 'hours', title: '匹配小时', align: 'right', width: '92px' },
                      { key: 'greenMwh', title: '绿电(MWh)', align: 'right', width: '110px' },
                    ],
                    rows: s.byCert || [],
                    rowKey: 'certNo',
                    empty: '暂无凭证',
                  }, {
                    'col-certNo': ({ row }) => h('span', { class: 'mono', style: 'font-size:11.6px' }, row.certNo),
                    'col-certType': ({ row }) => h('span', { class: 'tag t-info plain' }, row.certType),
                    'col-greenMwh': ({ row }) => num(row.greenMwh, 1),
                  }),
                ]),
              }),
            ]),

            m.summary ? h('x-card', { title: '本次匹配结果', class: 'mt-16' }, {
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'flex gap-12 wrap' }, [
                  h('x-readout', { pass: (m.summary.coverageRatio || 0) > 0.3, label: '绿电覆盖率', detail: pct(m.summary.coverageRatio) }),
                  h('x-readout', { pass: true, label: '匹配小时数', detail: App.fmt.num(m.summary.hours) }),
                  h('x-readout', { pass: true, label: '减碳量', detail: num(m.summary.savedTco2, 2) + ' tCO₂e' }),
                ]),
                h('div', { class: 'intl-quote mt-16' },
                  '小时级匹配的意义：若用年度总量相减，一家企业白天外购电网电、夜里买绿电，也会被算成"100% 绿电"。'
                  + '只有逐小时匹配，才能保证"用电的那一刻确实用的是绿电"，这也是 CBAM 间接排放扣减被接受的必要条件。'),
              ]),
            }) : null,
          ],
        });
      };
    },
  });

  /* ==================================================================
   * ③ 双轨报告导出
   * ================================================================== */
  const PageDualReport = defineComponent({
    name: 'page-dual-report',
    setup() {
      injectStyle();
      const { isEnt, canWrite } = useRole();
      const entId = ref(isEnt ? Number(App.Store.user.orgId) : null);
      const ents = ref([]);
      const rows = ref([]);
      const last = ref(null);
      const busy = ref(false);
      const form = reactive({ period: '', cnCode: '' });
      const detail = ref(null);
      const detailOpen = ref(false);

      async function load() {
        try { rows.value = (await App.API.get('/report/list', isEnt ? {} : { entId: entId.value })) || []; }
        catch (e) { rows.value = []; }
      }
      async function doExport(std) {
        busy.value = true;
        try {
          const r = await App.API.post('/report/export', { entId: entId.value, std, period: form.period || undefined, cnCode: form.cnCode || undefined });
          if (!r || !r.payload) {
            /* 静态演示模式：导出需落库并上链，如实告知 */
            App.notify.warn('静态演示模式下不执行报告导出（需落库并上链）。请在本地 npm start 或在线模式下操作。');
            return;
          }
          last.value = r;
          App.notify.ok(`${r.std} 报告已生成并上链存证`);
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }
      async function openDetail(row) {
        try {
          detail.value = await App.API.get('/report/' + row.id);
          detailOpen.value = true;
        } catch (e) { App.notify.err(e.message); }
      }

      onMounted(async () => { ents.value = await useEnts(isEnt, entId); await load(); });

      return () => {
        const lp = (last.value && last.value.payload) || null;
        return h('x-page', {
          title: '双轨报告导出',
          desc: 'ISO 14064-1 组织轨 + ISO 14067 产品轨同时计算，两轨互证 · 导出即上链，文件指纹用于证明"交付的就是这份"',
        }, {
          actions: () => [
            entPicker(isEnt, entId, ents),
            h('input', { class: 'input', style: 'width:120px;height:30px', placeholder: '期间 2026Q1', value: form.period, onInput: (e) => { form.period = e.target.value; } }),
            h('button', { class: 'btn sm ghost', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ],
          default: () => [
            App.staticNote('当前为静态演示模式：报告台账为快照时点值；'
              + '「导出并上链」需落库并写链，静态模式下会如实提示而不伪造报告。'),
            h('x-card', { title: '两轨各自的边界与用途', sub: '同一份底层数据，两套报告口径 —— 这正是"双轨"要互证的地方' }, {
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'grid g2' }, [
                  h('div', { class: 'card', style: 'padding:14px 16px' }, [
                    h('div', { class: 'flex between mb-8' }, [
                      h('b', {}, 'ISO 14064-1 · 组织轨'),
                      canWrite ? h('button', { class: 'btn sm primary', disabled: busy.value, onClick: () => doExport('14064') }, '导出并上链') : null,
                    ]),
                    h('div', { class: 'tiny dim', style: 'line-height:1.7' }, App.fmt.md(
                      '面向组织层级的温室气体量化与报告：类别 1（直接排放）与类别 2（输入能源间接排放）本平台可实测；'
                      + '类别 3~6（运输、产品使用、其他间接）**如实标注未纳入**，而非填 0 冒充完整。')),
                  ]),
                  h('div', { class: 'card', style: 'padding:14px 16px' }, [
                    h('div', { class: 'flex between mb-8' }, [
                      h('b', {}, 'ISO 14067 · 产品轨'),
                      canWrite ? h('button', { class: 'btn sm primary', disabled: busy.value, onClick: () => doExport('14067') }, '导出并上链') : null,
                    ]),
                    h('div', { class: 'tiny dim', style: 'line-height:1.7' },
                      '面向产品碳足迹：以单位产品隐含碳强度为核心指标，是 CBAM 申报的直接依据。'
                      + '需要显式产量口径（实测 / 估算会分别标注来源），避免"用组织总量除以产量"这种粗糙做法。'),
                  ]),
                ]),
                h('div', { class: 'intl-quote mt-16' },
                  App.fmt.md('互证规则：**组织总量应 ≥ 已核算产品的隐含碳之和**。若产品隐含碳之和超过组织总量，说明边界或产量数据有误 —— 这是两轨同时计算的真正价值。')),
              ]),
            }),

            lp ? h('x-card', { title: `最近导出：${last.value.std}`, class: 'mt-16' }, {
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'flex gap-12 wrap mb-16' }, [
                  h('x-readout', { pass: true, label: '已上链存证', detail: '区块 #' + ((last.value.chain && last.value.chain.blockIndex) || '—') }),
                  h('x-readout', { pass: last.value.crossCheck.orgTotal >= last.value.crossCheck.productTotal, label: '两轨互证（组织 ≥ 产品）', detail: `组织 ${num(last.value.crossCheck.orgTotal, 2)} / 产品 ${num(last.value.crossCheck.productTotal, 2)} tCO₂e` }),
                  h('x-readout', { pass: true, label: '文件指纹', detail: String(last.value.fileFingerprint || '').slice(0, 20) + '…' }),
                ]),
                h('div', { class: 'tiny dim mb-6' }, '报告内容（可据此另存为交付文件）'),
                h('pre', { class: 'mono-pre', style: 'max-height:320px;overflow:auto;font-size:11.4px' }, JSON.stringify(lp, null, 2)),
                last.value.exportHint ? h('div', { class: 'intl-quote mt-12' }, last.value.exportHint) : null,
              ]),
            }) : null,

            h('x-card', { title: '导出报告台账', class: 'mt-16' }, {
              default: () => h('div', { class: 'card-body flush' }, [
                h('x-table', {
                  columns: [
                    { key: 'id', title: '#', width: '54px' },
                    { key: 'std', title: '标准', width: '116px' },
                    { key: 'ent_name', title: '企业' },
                    { key: 'report_scope', title: '范围', width: '96px' },
                    { key: 'period', title: '期间', width: '92px' },
                    { key: 'total_emission', title: '总量(tCO₂e)', align: 'right', width: '128px' },
                    { key: 'file_fingerprint', title: '文件指纹', width: '130px' },
                    { key: 'block_index', title: '链上存证', width: '100px' },
                    { key: 'created_at', title: '导出时间', width: '146px' },
                    { key: '_ops', title: '', width: '82px' },
                  ],
                  rows: rows.value,
                  rowKey: 'id',
                  empty: '暂无导出报告',
                }, {
                  'col-std': ({ row }) => h('span', { class: 'tag t-info plain' }, row.std),
                  'col-total_emission': ({ row }) => num(row.total_emission, 3),
                  'col-file_fingerprint': ({ row }) => h('x-hash', { value: row.file_fingerprint, len: 10 }),
                  'col-block_index': ({ row }) => h('x-chainbadge', { block: row.block_index, hash: row.chain_tx_id }),
                  'col-created_at': ({ row }) => h('span', { class: 'tiny dim' }, row.created_at),
                  'col-_ops': ({ row }) => h('button', { class: 'btn sm ghost', onClick: () => openDetail(row) }, '查看'),
                }),
              ]),
            }),

            /* 详情弹窗 */
            h('x-modal', {
              modelValue: detailOpen.value, title: detail.value ? (detail.value.title || detail.value.std) : '报告详情', width: '880px',
              'onUpdate:modelValue': (v) => { detailOpen.value = v; },
            }, {
              default: () => detail.value ? [
                h('div', { class: 'flex gap-12 wrap mb-16' }, [
                  h('x-readout', { pass: true, label: '内容摘要指纹', detail: String(detail.value.content_digest || '').slice(0, 20) + '…' }),
                  h('x-readout', { pass: true, label: '文件指纹', detail: String(detail.value.file_fingerprint || '').slice(0, 20) + '…' }),
                ]),
                h('pre', { class: 'mono-pre', style: 'max-height:420px;overflow:auto;font-size:11.3px' },
                  JSON.stringify(detail.value.payload || detail.value, null, 2)),
              ] : null,
              footer: () => h('button', { class: 'btn', onClick: () => { detailOpen.value = false; } }, '关闭'),
            }),
          ],
        });
      };
    },
  });

  App.views['page-cbam'] = PageCbam;
  App.views['page-greenpower'] = PageGreenPower;
  App.views['page-dual-report'] = PageDualReport;
})();
