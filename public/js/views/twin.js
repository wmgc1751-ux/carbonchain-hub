/* =====================================================================
   twin.js —— 企业端「3D 数字孪生」页（v3：卫星实测厂区模型）
   ---------------------------------------------------------------------
   版本沿革（答辩被追问数据来源时，按这段回答）：

     v1  7 个写死的示意方块 + 编造能耗数字 —— 已废弃
     v2  Climate TRACE 设施派生几何（行业工程量级示意）—— 境外数据源
         2026-10-30 随平台清退境外数据一并下线，页面转为空态
     v3  本版。几何逐栋量自四家保定焚烧企业的卫星影像
         （services/plantGeometry.js，每栋带量测 note），
         排放绑 cems_cn_hourly 逐小时实测报文。

   归属规则：本页只展示**当前登录企业自己**的厂区 —— 数据来自
   /api/plant3d/mine（authRequired，按 token 里的 orgId 解析）。
   企业账号各看各家；其他角色/未登录看到明确的说明，而不是报错空白。

   数据边界在页面上写死三条（不许合并成"全部真实"）：
     · 平面尺寸 = 卫星影像实测（可复核）
     · 建筑高度 = 工程常见值（正射影像读不出高度，不谎称实测）
     · 排放量   = CEMS 逐小时实测（分摊权重是建模假设）
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, onUnmounted, nextTick } = Vue;
  const h = App.h;

  const STYLE_ID = 'twin-page-style-v3';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
.tw3-wrap{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:12px;align-items:start}
@media(max-width:1180px){.tw3-wrap{grid-template-columns:1fr}}
.tw3-stage{position:relative;border:1px solid var(--hair);border-radius:12px;overflow:hidden;
  background:radial-gradient(ellipse at 50% 8%,rgba(16,185,129,.07),transparent 55%),var(--bg-0)}
.tw3-canvas{width:100%;height:clamp(430px,56vh,680px);position:relative}
.tw3-canvas canvas{display:block;width:100%;height:100%;touch-action:none}
.tw3-hud{position:absolute;left:12px;bottom:12px;z-index:3;display:flex;gap:10px;flex-wrap:wrap;
  font-family:var(--mono);font-size:11px;color:var(--tx-3)}
.tw3-hud span{background:rgba(10,16,26,.86);border:1px solid var(--hair);
  border-radius:7px;padding:4px 9px;backdrop-filter:blur(6px)}
.tw3-hud b{color:#6ee7b7;font-weight:500}
.tw3-legend{position:absolute;right:12px;top:12px;z-index:3;display:flex;flex-direction:column;gap:6px;
  background:rgba(10,16,26,.86);border:1px solid var(--hair);border-radius:9px;padding:9px 11px;
  font-size:11.3px;color:var(--tx-2);backdrop-filter:blur(8px)}
.tw3-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px}
.tw3-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  flex-direction:column;gap:10px;color:var(--tx-3);font-size:12.5px;z-index:5;
  background:rgba(8,14,24,.62)}
.tw3-spin{width:26px;height:26px;border:2px solid rgba(16,185,129,.25);border-top-color:#10b981;
  border-radius:50%;animation:tw3spin .8s linear infinite}
@keyframes tw3spin{to{transform:rotate(360deg)}}
.tw3-side{display:flex;flex-direction:column;gap:12px;min-width:0}
.tw3-card{border:1px solid var(--hair);border-radius:12px;background:var(--bg-1);overflow:hidden}
.tw3-card-h{padding:10px 12px;border-bottom:1px solid var(--hair);
  display:flex;align-items:center;justify-content:space-between;gap:8px}
.tw3-card-h .t{font-size:12.8px;color:var(--tx-0);font-weight:500}
.tw3-card-b{padding:12px}
.tw3-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;
  padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.055);font-size:12.2px}
.tw3-row:last-child{border-bottom:0}
.tw3-row .k{color:var(--tx-3);white-space:nowrap}
.tw3-row .v{font-family:var(--mono);color:var(--tx-0);text-align:right;word-break:break-all}
.tw3-src{font-size:11.2px;line-height:1.65;color:var(--tx-3);
  background:rgba(16,185,129,.055);border:1px solid rgba(16,185,129,.16);
  border-radius:8px;padding:9px 11px;margin-top:10px}
.tw3-src .a{color:#6ee7b7}
.tw3-src .w{color:#f5a524}
.tw3-list{max-height:250px;overflow:auto}
.tw3-li{display:flex;justify-content:space-between;gap:8px;padding:7px 4px;font-size:12px;
  border-bottom:1px dashed rgba(255,255,255,.05);cursor:pointer;border-radius:5px}
.tw3-li:hover{background:rgba(16,185,129,.09)}
.tw3-li.on{background:rgba(16,185,129,.15)}
.tw3-li .nm{color:var(--tx-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw3-li .sz{font-family:var(--mono);color:var(--tx-3);font-size:11px;white-space:nowrap}
.tw3-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.07);margin-top:4px;overflow:hidden}
.tw3-bar i{display:block;height:100%;background:linear-gradient(90deg,#10b981,#34d399)}
/* 非企业账号的说明态 */
.tw3-empty{border:1px solid var(--hair);border-radius:12px;background:var(--bg-1);
  padding:34px 28px;max-width:660px;margin:26px auto;text-align:center}
.tw3-empty h3{font-size:15.5px;color:var(--tx-0);margin:0 0 12px}
.tw3-empty p{font-size:12.4px;color:var(--tx-3);line-height:1.8;margin:0 0 8px}
.tw3-empty .tag{display:inline-block;font-family:var(--mono);font-size:11px;color:#6ee7b7;
  border:1px solid rgba(16,185,129,.35);border-radius:6px;padding:2px 9px;margin-bottom:14px}
`;
    document.head.appendChild(el);
  }

  const PageTwin = defineComponent({
    name: 'PageTwin',
    setup() {
      const detail = ref(null);
      const loading = ref(false);
      const err = ref('');
      const deny = ref('');            // 401/403/404 的说明文案
      const selected = ref('');
      const canvasRef = ref(null);
      let sceneHandle = null;

      const structures = computed(() => (detail.value && detail.value.plant.structures) || []);
      const maxEmit = computed(() => Math.max(...structures.value.map((s) => s.emission || 0), 1));

      async function load() {
        loading.value = true; err.value = ''; deny.value = '';
        try {
          detail.value = await App.API.get('/plant3d/mine');
          selected.value = '';
          await nextTick();
          await buildScene();
        } catch (e) {
          detail.value = null;
          const status = e && (e.status || e.code);
          const msg = (e && (e.message || (e.payload && e.payload.message))) || String(e);
          if (Number(status) === 401) deny.value = '未登录。厂区模型归属企业 —— 请用企业账号（ent_zjbd 等）登录后查看本企业厂区。';
          else deny.value = String(msg || '暂无厂区模型。');
        } finally {
          loading.value = false;
        }
      }

      async function buildScene() {
        if (sceneHandle && sceneHandle.dispose) { try { sceneHandle.dispose(); } catch (e) {} }
        sceneHandle = null;
        if (!canvasRef.value || !detail.value) return;
        canvasRef.value.innerHTML = '';   // 防旧画布残留（重载时实测叠出两块）
        try {
          sceneHandle = await App.Plant3D.createPlantScene(canvasRef.value, detail.value, {
            onSelect: (st) => { selected.value = st ? st.id : ''; },
          });
        } catch (e) {
          err.value = '3D 场景构建失败：' + (e.message || e);
        }
      }

      function pick(id) {
        selected.value = id;
        if (sceneHandle && sceneHandle.select) {
          try { sceneHandle.select(id); } catch (e) {}
        }
      }

      onMounted(() => { injectStyle(); load(); });
      onUnmounted(() => { if (sceneHandle && sceneHandle.dispose) { try { sceneHandle.dispose(); } catch (e) {} } });

      const fmt = (n, d = 0) => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: d });

      return { detail, loading, err, deny, selected, canvasRef, structures, maxEmit, pick, fmt };
    },
    render() {
      const d = this.detail;
      const f = d && d.facility;
      const p = d && d.plant;

      /* 非企业账号 / 未登录：说明态（沿用 /twin 下线时的诚实口径） */
      if (this.deny) {
        return h('div', {}, [
          h('div', { class: 'page-head' }, [
            h('div', {}, [
              h('h2', { style: 'font-size:19px;margin:18px 0 6px' }, '3D 数字孪生'),
            ]),
          ]),
          h('div', { class: 'tw3-empty' }, [
            h('span', { class: 'tag' }, '厂区模型归属企业账号'),
            h('h3', {}, '本页展示登录企业自己的卫星实测厂区'),
            h('p', {}, this.deny),
            h('p', {}, '几何逐栋量自卫星影像（高德 z18，北纬 38.8° 处 0.4655 m/px）；'
              + '建筑高度取工程常见值，不作实测声称；排放绑 CEMS 逐小时实测报文。'),
          ]),
        ]);
      }

      return h('div', {}, [
        h('div', { class: 'page-head mb-16' }, [
          h('div', {}, [
            h('h2', { style: 'font-size:19px;margin:0 0 6px' }, '3D 数字孪生'),
            h('p', { class: 'muted', style: 'font-size:12.6px;margin:0;line-height:1.7' },
              '本企业厂区按卫星影像实测尺寸建模：几何逐栋量测可复核；'
              + '建筑高度取工程常见值（不作实测声称）；排放绑 CEMS 逐小时实测报文。'),
          ]),
        ]),
        this.err ? h('div', { class: 'alert err mb-12' }, this.err) : null,

        h('div', { class: 'tw3-wrap' }, [
          h('div', { class: 'tw3-stage' }, [
            h('div', { class: 'tw3-canvas', ref: 'canvasRef' }),
            this.loading ? h('div', { class: 'tw3-loading' }, [
              h('div', { class: 'tw3-spin' }), h('div', {}, '正在按实测尺寸构建本厂模型…'),
            ]) : null,
            p ? h('div', { class: 'tw3-hud' }, [
              h('span', {}, ['场区 ', h('b', {}, p.sceneExtent.w + '×' + p.sceneExtent.d), ' m']),
              h('span', {}, ['构筑物 ', h('b', {}, String(this.structures.length)), ' 栋']),
              h('span', {}, ['拖动旋转 · 滚轮缩放 · 点击构件']),
            ]) : null,
            h('div', { class: 'tw3-legend' }, [
              h('div', {}, [h('i', { style: 'background:#3b82f6' }), '蓝顶厂房']),
              h('div', {}, [h('i', { style: 'background:#94a3b8' }), '灰色辅房']),
              h('div', {}, [h('i', { style: 'background:#e2e8f0' }), '烟囱 / 筒仓']),
            ]),
          ]),

          h('div', { class: 'tw3-side' }, [
            f ? h('div', { class: 'tw3-card' }, [
              h('div', { class: 'tw3-card-h' }, [h('div', { class: 't' }, f.name)]),
              h('div', { class: 'tw3-card-b' }, [
                h('div', { class: 'tw3-row' }, [h('div', { class: 'k' }, '厂址'), h('div', { class: 'v' }, f.address)]),
                h('div', { class: 'tw3-row' }, [h('div', { class: 'k' }, '坐标'), h('div', { class: 'v' }, f.lat.toFixed(5) + ', ' + f.lon.toFixed(5))]),
                h('div', { class: 'tw3-row' }, [h('div', { class: 'k' }, '布局'), h('div', { class: 'v', style: 'font-family:inherit' }, d.layout)]),
                h('div', { class: 'tw3-src' }, [
                  h('div', {}, [h('span', { class: 'a' }, '几何'), '：卫星影像逐栋量测（z18，0.4655 m/px）']),
                  h('div', {}, [h('span', { class: 'w' }, '高度'), '：取该类构筑物工程常见值，非实测']),
                  h('div', {}, [h('span', { class: 'a' }, '排放'), '：CEMS 逐小时实测，',
                    String(d.emission ? d.emission.hours.toLocaleString() : 0), ' 条有效小时']),
                ]),
              ]),
            ]) : null,

            p ? h('div', { class: 'tw3-card' }, [
              h('div', { class: 'tw3-card-h' }, [
                h('div', { class: 't' }, '构筑物清单'),
                h('div', { class: 'muted', style: 'font-size:11px' }, '点击定位'),
              ]),
              h('div', { class: 'tw3-card-b tw3-list' }, this.structures.map((s) =>
                h('div', {
                  class: ['tw3-li', this.selected === s.id ? 'on' : ''],
                  onClick: () => this.pick(s.id),
                }, [
                  h('div', { style: 'min-width:0;flex:1' }, [
                    h('div', { class: 'nm' }, s.name),
                    h('div', { class: 'tw3-bar' }, [
                      h('i', { style: 'width:' + ((s.emission || 0) / this.maxEmit * 100).toFixed(1) + '%' }),
                    ]),
                  ]),
                  h('div', { class: 'sz' }, s.scene.w + '×' + s.scene.d + 'm'),
                ]))),
            ]) : null,

            d && d.emission ? h('div', { class: 'tw3-card' }, [
              h('div', { class: 'tw3-card-h' }, [h('div', { class: 't' }, '实测排放（CEMS 累计）')]),
              h('div', { class: 'tw3-card-b' }, [
                h('div', { class: 'tw3-row' }, [h('div', { class: 'k' }, 'NOₓ'), h('div', { class: 'v' }, this.fmt(d.emission.noxKg / 1000, 1) + ' t')]),
                h('div', { class: 'tw3-row' }, [h('div', { class: 'k' }, 'SO₂'), h('div', { class: 'v' }, this.fmt(d.emission.so2Kg / 1000, 1) + ' t')]),
                h('div', { class: 'tw3-row' }, [h('div', { class: 'k' }, '烟粉尘'), h('div', { class: 'v' }, this.fmt(d.emission.pmKg / 1000, 1) + ' t')]),
                h('div', { class: 'tw3-row' }, [h('div', { class: 'k' }, '烟气量'), h('div', { class: 'v' }, this.fmt(d.emission.gasM3 / 10000, 0) + ' 万m³')]),
                h('div', { class: 'muted', style: 'font-size:11px;margin-top:8px;line-height:1.6' },
                  '统计区间 ' + String(d.emission.from || '').slice(0, 10) + ' → ' + String(d.emission.to || '').slice(0, 10)),
                h('div', { class: 'tw3-src' }, [
                  h('div', {}, '排放按构筑物功能权重分摊（主厂房+烟囱承担主体），'),
                  h('div', {}, '权重为', h('span', { class: 'w' }, '建模假设'), '，非实测。'),
                ]),
              ]),
            ]) : null,
          ]),
        ]),
      ]);
    },
  });

  App.views['page-twin'] = PageTwin;
})();
