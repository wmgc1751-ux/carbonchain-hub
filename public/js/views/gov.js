/* =====================================================================
   gov.js —— 源端真实化与工程品质三块治理看板（WP1 / WP6）
   ---------------------------------------------------------------------
   ① /gov/iot          工业设备接入看板
        · TCP 接入服务运行态（连接/帧/CRC/拒绝/补传/离线补记）
        · 设备台账（MN / 排口 / 企业 / 协议 / 授权状态 / 最近上报）
        · 准入治理操作：审批·吊销 / 绑定归属主体
        · HJ 212 协议合规自检（六重锚定）+ 因子编码表 + 未实现子集如实声明
   ② /gov/quality      数据质量看板
        · 质量标记分布（NORMAL/MISSING/DRIFT/OFFLINE/CALIBRATION）
        · 数据获取率 PMA（含分母口径：max(应得, 实收)）
        · 接入量时序（总量 / 设备直报 / 有效）
        · 离线看门狗（OFFLINE 标记的唯一真实生产者）手动巡检
        · 质量门控对动态核算的实际影响（有效点 / 排除点）
   ③ /gov/audit-chain  审计日志哈希链校验
        · 链状态概览 / 全链复算 / 抽样复算 / 单条复核 / 封印
        · 与联盟链的分工对照（业务事实 vs 操作事实）

   三块看板共同回答一个问题：**"数据可信"这件事，平台自己是怎么证明的。**
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  const STYLE_ID = 'gov-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
.gov-mono{font-family:var(--mono);font-size:11.6px;line-height:1.75;word-break:break-all}
.gov-check{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--hair)}
.gov-check:last-child{border-bottom:none}
.gov-check .flag{flex:none;font-family:var(--mono);font-size:11px;font-weight:600;padding:2px 6px;border-radius:5px}
.gov-check .flag.ok{background:rgba(16,185,129,.16);color:#6ee7b7}
.gov-check .flag.no{background:rgba(244,63,94,.16);color:#fda4af}
.gov-check .tx{font-size:12.4px;color:var(--tx-1);line-height:1.65}
.gov-ev{max-height:280px;overflow-y:auto}
.gov-ev .it{display:flex;gap:9px;padding:6px 0;border-bottom:1px solid var(--hair);font-size:12.2px}
.gov-ev .it:last-child{border-bottom:none}
.gov-ev .at{flex:none;font-family:var(--mono);font-size:11px;color:var(--tx-3);width:64px}
.gov-qrow{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--hair)}
.gov-qrow:last-child{border-bottom:none}
.gov-dot{width:9px;height:9px;border-radius:50%;flex:none}
.gov-formula{background:var(--bg-0);border:1px solid var(--hair);border-radius:8px;padding:12px 14px;
  font-family:var(--mono);font-size:12px;line-height:1.9;color:var(--brand-l);word-break:break-all}
`;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* 质量标记语义与配色（与后端 hj212Server.quality() 的 semantics 保持一致） */
  const QUALITY_META = {
    NORMAL: { label: '有效数据', color: '#10b981', tone: 't-ok' },
    MISSING: { label: '缺数', color: '#f5a524', tone: 't-warn' },
    DRIFT: { label: '漂移存疑', color: '#f59e0b', tone: 't-warn' },
    OFFLINE: { label: '停机/断线', color: '#f43f5e', tone: 't-danger' },
    CALIBRATION: { label: '校准/维护', color: '#a78bfa', tone: 't-violet' },
    SUBSTITUTED: { label: '替代规则补齐', color: '#38bdf8', tone: 't-info' },
  };

  /* 通用：定时器集合，卸载时统一清理（避免切页后后台仍在轮询） */
  function usePollers() {
    const timers = [];
    onUnmounted(() => { timers.forEach((t) => clearInterval(t)); timers.length = 0; });
    return {
      every(fn, ms) { fn(); timers.push(setInterval(fn, ms)); },
    };
  }

  /* KPI 网格：列数按条目数取能整除的值，避免"末行只剩两张、右边空四格"。
   * 2026-10-29 巡检 P1-30：/gov/iot 8 张卡在 auto-fit 下排成 7+1，
   * 第二行右侧整片留空，看起来像漏渲染。 */
  function kpiGrid(items) {
    const n = items.length;
    const cols = n % 4 === 0 ? 4 : (n % 3 === 0 ? 3 : 4);
    return h('div', { class: 'kpi-grid', style: `--kpi-cols:${cols}` },
      items.map((k) => h('x-kpi', k)));
  }

  /* ==================================================================
   * ① 工业设备接入看板
   * ================================================================== */
  const PageIotDevices = defineComponent({
    name: 'page-iot-devices',
    setup() {
      injectStyle();
      const stats = ref({});
      const status = ref({});
      const devices = ref([]);
      /* 设备台账分页：一台一屏铺完 80 行会把页面拉到 5000px 高
       * （2026-10-29 巡检 P2-35）。一页 15 行，翻页成本低于无休止滚动。 */
      const devPage = ref(1);
      const DEV_PAGE_SIZE = 15;
      const devPageRows = computed(() => {
        const list = devices.value || [];
        const p = Math.min(Math.max(devPage.value, 1), Math.max(1, Math.ceil(list.length / DEV_PAGE_SIZE)));
        return list.slice((p - 1) * DEV_PAGE_SIZE, p * DEV_PAGE_SIZE);
      });
      const devPageCount = computed(() => Math.max(1, Math.ceil((devices.value || []).length / DEV_PAGE_SIZE)));
      const conformance = ref(null);
      const factors = ref(null);
      const filter = reactive({ protocol: '', authStatus: '', keyword: '' });
      const loading = ref(false);
      const bindOpen = ref(false);
      const bindTarget = ref(null);
      const ents = ref([]);
      const bindForm = reactive({ entId: '', monitorNo: '', replace: false, note: '' });
      const poll = usePollers();

      async function loadStats() {
        try { stats.value = await App.API.get('/iot/stats'); } catch (e) { /* 静态模式或未启动 */ }
      }
      async function loadStatus() {
        try { status.value = await App.API.get('/iot/status'); } catch (e) { /* ignore */ }
      }
      async function loadDevices() {
        loading.value = true;
        try {
          devices.value = await App.API.get('/iot/devices', {
            protocol: filter.protocol, authStatus: filter.authStatus,
            keyword: filter.keyword, limit: 300,
          });
          devPage.value = 1;
        } catch (e) { devices.value = []; } finally { loading.value = false; }
      }
      async function loadStatic() {
        try { conformance.value = await App.API.get('/iot/conformance'); } catch (e) { /* ignore */ }
        try { factors.value = await App.API.get('/iot/factors'); } catch (e) { /* ignore */ }
      }

      async function setAuth(dev, nextStatus) {
        const verb = nextStatus === 'ACTIVE' ? '审批通过' : (nextStatus === 'REVOKED' ? '吊销' : '置为待审批');
        if (!(await App.confirm(`确认将设备 ${dev.mn || dev.device_did} ${verb}？\n\n该动作会写入操作审计日志（哈希链留痕）。`))) return;
        try {
          const r = await App.API.post(`/iot/devices/${encodeURIComponent(dev.device_did)}/auth`,
            { status: nextStatus, note: '监管端看板操作' });
          App.notify.ok(r && r.mn ? `设备 ${r.mn} 已变更为 ${nextStatus}` : '授权状态已更新');
          await Promise.all([loadStats(), loadDevices()]);
        } catch (e) { App.notify.err(e.message); }
      }

      async function openBind(dev) {
        bindTarget.value = dev;
        bindForm.entId = ''; bindForm.monitorNo = ''; bindForm.replace = false; bindForm.note = '';
        bindOpen.value = true;
        if (!ents.value.length) {
          try {
            /* 公开名录接口：ADMIN 也会打开本页，而 /regulator/enterprises 仅 REGULATOR 可用 */
            const d = await App.API.get('/public/enterprises', { page: 1, size: 200 });
            ents.value = (d && (d.rows || d)) || [];
          } catch (e) { ents.value = []; }
        }
      }
      async function submitBind() {
        if (!bindForm.entId) return App.notify.warn('请选择归属企业');
        try {
          const r = await App.API.post(`/iot/devices/${encodeURIComponent(bindTarget.value.device_did)}/bind`, {
            entId: Number(bindForm.entId),
            monitorNo: bindForm.monitorNo || undefined,
            replace: !!bindForm.replace,
            note: bindForm.note || undefined,
          });
          App.notify.ok(r && r.entName
            ? `设备已绑定至 ${r.entName}${r.monitorNo ? ' · ' + r.monitorNo : ''}`
            : '设备已绑定归属主体');
          bindOpen.value = false;
          await Promise.all([loadStats(), loadDevices()]);
        } catch (e) { App.notify.err(e.message); }
      }

      onMounted(() => {
        loadStatic();
        poll.every(loadStats, 8000);
        poll.every(loadStatus, 5000);
        loadDevices();
      });

      const columns = [
        { key: 'mn', title: 'HJ 212 设备标识 MN', width: '210px' },
        { key: 'monitor_no', title: '排口', width: '120px' },
        { key: 'ent_name', title: '归属企业' },
        { key: 'protocol', title: '接入协议', width: '110px' },
        { key: 'auth_status', title: '授权状态', width: '105px' },
        { key: 'last_seen_at', title: '最近上报', width: '150px' },
        { key: '_ops', title: '治理操作', width: '210px' },
      ];

      return () => {
        const s = stats.value || {};
        const st = status.value || {};
        const sup = (status.value && status.value.implementedCn) || [];
        return h('x-page', {
          title: '工业设备接入看板',
          desc: 'HJ 212-2017 数采仪直连上报 · 设备台账与准入治理 · 未经审批的源端一律不落库',
        }, {
          default: () => [
            /* ── 运行态 KPI ── */
            kpiGrid([
              { label: '接入服务', value: st.listening ? '运行中' : '未监听', unit: '', tone: st.listening ? 'carbon' : 'rose', icon: 'factory', foot: st.listening ? `TCP 0.0.0.0:${st.port}` : '可用 HJ212_AUTOSTART=1 自动启动' },
              { label: '在册设备', value: App.fmt.num(s.total || 0), unit: '台', tone: 'sky', icon: 'dash', foot: `在用 ${s.active || 0} / 待审批 ${s.pending || 0} / 已吊销 ${s.revoked || 0}` },
              { label: 'HJ 212 链路', value: App.fmt.num(s.hj212 || 0), unit: '台', tone: 'violet', icon: 'chain', foot: `Modbus 规划中 ${(s.total || 0) - (s.hj212 || 0)} 台` },
              { label: '收帧 / 发帧', value: App.fmt.num(st.framesIn || 0), unit: '帧', tone: 'chain', icon: 'block', foot: `应答 ${App.fmt.num(st.framesOut || 0)} 帧 · 活动连接 ${st.liveConnections || 0}` },
              { label: 'CRC 校验失败', value: App.fmt.num(st.crcFail || 0), unit: '帧', tone: (st.crcFail || 0) ? 'rose' : 'carbon', icon: 'shield', foot: '坏帧一律不入库，只计数' },
              { label: '准入拒绝', value: App.fmt.num(st.rejected || 0), unit: '帧', tone: (st.rejected || 0) ? 'rose' : 'carbon', icon: 'alert', foot: `密码失败 ${st.authFail || 0} · 幂等去重 ${st.duplicates || 0}` },
              { label: '设备直报读数', value: App.fmt.num(s.directReports || 0), unit: '条', tone: 'carbon', icon: 'report', foot: `带 CRC 留痕 ${App.fmt.num(s.crcVerified || 0)} · SM3 ${App.fmt.num(s.sm3Verified || 0)}` },
              { label: '离线补记', value: App.fmt.num(st.offlineMarks || 0), unit: '条', tone: 'violet', icon: 'alert', foot: '设备静默由看门狗判定（非设备上报）' },
            ]),

            h('div', { class: 'grid mt-16', style: 'grid-template-columns:1.35fr .65fr' }, [
              /* ── 设备台账 ── */
              h('x-card', { title: '设备台账与准入治理', sub: '授权（能否上报）与归属（数据算谁的）是两步，缺一不可' }, {
                actions: () => [
                  h('input', {
                    class: 'input', style: 'width:180px;height:30px', placeholder: '搜索 MN / 企业',
                    value: filter.keyword,
                    onInput: (e) => { filter.keyword = e.target.value; },
                    onKeyup: (e) => { if (e.key === 'Enter') loadDevices(); },
                  }),
                  h('select', {
                    class: 'input', style: 'width:118px;height:30px', value: filter.authStatus,
                    onChange: (e) => { filter.authStatus = e.target.value; loadDevices(); },
                  }, [
                    h('option', { value: '' }, '全部状态'),
                    h('option', { value: 'ACTIVE' }, '在用'),
                    h('option', { value: 'PENDING' }, '待审批'),
                    h('option', { value: 'REVOKED' }, '已吊销'),
                  ]),
                  h('button', { class: 'btn sm ghost', onClick: loadDevices }, '刷新'),
                ],
                default: () => h('div', { class: 'card-body flush' }, [
                  h('x-table', { columns, rows: devPageRows.value, loading: loading.value, rowKey: 'device_did', empty: '暂无设备档案' }, {
                    'col-mn': ({ row }) => h('span', { class: 'mono', title: row.device_did }, row.mn || '—'),
                    'col-monitor_no': ({ row }) => row.monitor_no
                      ? h('span', { class: 'tag t-info plain' }, row.monitor_no)
                      : h('span', { class: 'tag t-mute' }, '未绑定'),
                    'col-ent_name': ({ row }) => row.ent_name || h('span', { class: 'dim' }, '—'),
                    'col-protocol': ({ row }) => h('x-tag', {
                      text: row.protocol, tone: row.protocol === 'HJ212' ? 't-ok' : 't-mute',
                    }),
                    'col-auth_status': ({ row }) => h('x-tag', {
                      text: { ACTIVE: '在用', PENDING: '待审批', REVOKED: '已吊销' }[row.auth_status] || row.auth_status,
                      tone: { ACTIVE: 't-ok', PENDING: 't-warn', REVOKED: 't-danger' }[row.auth_status] || 't-mute',
                    }),
                    'col-last_seen_at': ({ row }) => h('span', { class: 'tiny dim' }, App.fmt.dt(row.last_seen_at)),
                    'col-_ops': ({ row }) => h('div', { class: 'flex gap-6' }, [
                      row.auth_status !== 'ACTIVE'
                        ? h('button', { class: 'btn sm primary', onClick: () => setAuth(row, 'ACTIVE') }, '审批')
                        : h('button', { class: 'btn sm danger', onClick: () => setAuth(row, 'REVOKED') }, '吊销'),
                      h('button', { class: 'btn sm ghost', onClick: () => openBind(row) }, '绑定主体'),
                    ]),
                  }),
                  devPageCount.value > 1 ? h('x-pager', {
                    page: devPage.value, pages: devPageCount.value, total: devices.value.length,
                    size: DEV_PAGE_SIZE, onChange: (p) => { devPage.value = p; },
                  }) : null,
                ]),
              }),

              /* ── 协议合规自检 ── */
              h('div', { class: 'grid gap-16', style: 'grid-template-columns:1fr' }, [
                h('x-card', { title: 'HJ 212 协议合规自检', sub: conformance.value ? `${conformance.value.passed}/${conformance.value.total} 项锚定通过` : '六重锚定' }, {
                  default: () => h('div', { class: 'card-body' }, conformance.value ? [
                    conformance.value.details.map((d) => h('div', { class: 'gov-check' }, [
                      h('span', { class: ['flag', d.pass ? 'ok' : 'no'] }, d.pass ? 'PASS' : 'FAIL'),
                      h('div', { class: 'flex-1' }, [
                        h('div', { class: 'tx' }, d.anchor),
                        d.problems && d.problems.length
                          ? h('div', { class: 'tiny', style: 'color:#fda4af;margin-top:3px' }, d.problems.join('；'))
                          : null,
                      ]),
                    ])),
                    h('div', { class: 'tiny dim mt-12' }, '锚定用的是 CRC-16/MODBUS 名录校验值 0x4B37 —— 不是 CCITT（0x1021）。'),
                  ] : h('div', { class: 'empty' }, '加载中…')),
                }),

                h('x-card', { title: '协议能力对照（如实声明）', sub: '实现了什么 / 没实现什么，都写清楚' }, {
                  default: () => {
                    if (!factors.value) return h('div', { class: 'card-body dim' }, '加载中…');
                    const f = factors.value;
                    return h('div', { class: 'card-body' }, [
                      h('dl', { class: 'kv' }, [
                        h('dt', {}, '帧结构'), h('dd', { class: 'gov-mono' }, f.frame.structure),
                        h('dt', {}, '长度语义'), h('dd', { class: 'gov-mono' }, f.frame.lengthCovers),
                        h('dt', {}, 'CRC 参数集'), h('dd', { class: 'gov-mono' }, `poly=${f.crc.poly} init=${f.crc.init} check=${f.crc.checkValue}`),
                        h('dt', {}, '易错警示'), h('dd', { class: 'gov-mono', style: 'color:#fcd34d' }, f.crc.notThis),
                      ]),
                      h('div', { class: 'flex between mt-12' }, [
                        h('div', { class: 'tiny dim' }, `已实现命令：${Object.keys(f.implementedCn || {}).join(' / ')}`),
                      ]),
                      h('div', { class: 'mt-12' }, [
                        h('div', { class: 'tiny', style: 'color:var(--tx-2);margin-bottom:6px' }, '未实现（不夸大兼容性）'),
                        ...(f.notImplemented || []).map((x) => h('div', { class: 'tiny dim' }, '· ' + x)),
                      ]),
                    ]);
                  },
                }),

                h('x-card', { title: '最近帧与事件', sub: '源端可审计：每条报文与每次拒绝都留痕' }, {
                  default: () => h('div', { class: 'card-body' }, [
                    h('div', { class: 'gov-ev' }, (st.lastFrames || []).length
                      ? st.lastFrames.slice(0, 14).map((fr) => {
                        const ok = fr.result === 'OK' || fr.inserted;
                        return h('div', { class: 'it' }, [
                          h('span', { class: 'at' }, String(fr.at || '').slice(11, 19)),
                          h('div', { class: 'flex-1 gov-mono' },
                            `${fr.cn} ${fr.cnName || ''} · ${fr.mn} · CRC ${fr.crc || '—'} · ` +
                            (ok ? '入库' : '拒绝(' + (fr.result || '—') + ')')),
                        ]);
                      })
                      : [h('x-empty', { inline: true, title: '暂无帧记录 · 启动模拟器或让设备直报后出现' })]),
                    h('div', { class: 'tiny', style: 'color:var(--tx-2);margin:12px 0 6px' }, '服务端事件'),
                    h('div', { class: 'gov-ev' }, (st.events || []).length
                      ? st.events.map((ev) => h('div', { class: 'it' }, [
                        h('span', { class: 'at' }, String(ev.at || '').slice(11, 19)),
                        h('div', { class: 'flex-1' }, [h('x-tag', { text: ev.kind, tone: 't-mute' }), ' ' + ev.message]),
                      ]))
                      : [h('x-empty', { inline: true, title: '暂无事件' })]),
                  ]),
                }),
              ]),
            ]),

            /* ── 绑定主体弹窗 ── */
            h('x-modal', {
              modelValue: bindOpen.value, title: '绑定设备归属主体',
              'onUpdate:modelValue': (v) => { bindOpen.value = v; },
            }, {
              default: () => [
                h('div', { class: 'tiny dim mb-12' },
                  `设备 ${bindTarget.value ? (bindTarget.value.mn || bindTarget.value.device_did) : ''}：` +
                  '授权只回答"能不能上报"，绑定才决定"这条数据算谁的"。未绑定主体的设备上报会被直接拒收（应答码 7）。'),
                h('div', { class: 'field' }, [
                  h('label', {}, '归属企业'),
                  h('select', {
                    class: 'input', value: bindForm.entId,
                    onChange: (e) => { bindForm.entId = e.target.value; },
                  }, [h('option', { value: '' }, '请选择…')].concat(
                    ents.value.map((e2) => h('option', { value: String(e2.id) }, `${e2.ent_name}（${e2.industry || '—'}）`))
                  )),
                ]),
                h('div', { class: 'field' }, [
                  h('label', {}, '排口编号（留空按企业默认顺序分配）'),
                  h('input', {
                    class: 'input', placeholder: '如 M-0007-01', value: bindForm.monitorNo,
                    onInput: (e) => { bindForm.monitorNo = e.target.value; },
                  }),
                  h('div', { class: 'hint' }, '同一排口不允许两台设备重复绑定，防止重复计量。'),
                ]),
                h('div', { class: 'field' }, [
                  h('label', {}, '备注'),
                  h('input', {
                    class: 'input', placeholder: '如：设备更换 / 现场核验记录号', value: bindForm.note,
                    onInput: (e) => { bindForm.note = e.target.value; },
                  }),
                ]),
                h('label', { class: 'flex gap-8 tiny', style: 'color:var(--tx-2)' }, [
                  h('input', {
                    type: 'checkbox', checked: bindForm.replace,
                    onChange: (e) => { bindForm.replace = e.target.checked; },
                  }),
                  '目标排口已被其他设备占用时，按"设备更换"语义接管（原设备置为 REVOKED 并留痕）',
                ]),
              ],
              footer: () => [
                h('button', { class: 'btn ghost', onClick: () => { bindOpen.value = false; } }, '取消'),
                h('button', { class: 'btn primary', onClick: submitBind }, '确认绑定'),
              ],
            }),
          ],
        });
      };
    },
  });

  /* ==================================================================
   * ② 数据质量看板
   * ================================================================== */
  const PageDataQuality = defineComponent({
    name: 'page-data-quality',
    setup() {
      injectStyle();
      const quality = ref(null);
      const pma = ref(null);
      const trend = ref([]);
      const windowHours = ref(24);
      const intervalMin = ref(60);
      const sweep = reactive({ silentMinutes: 180, cooldownMinutes: 60, maxPerRun: 200, running: false, result: null });
      const dyn = ref(null);
      const poll = usePollers();

      async function loadQuality() {
        try { quality.value = await App.API.get('/iot/quality'); } catch (e) { /* ignore */ }
      }
      async function loadPma() {
        try { pma.value = await App.API.get('/iot/pma', { hours: windowHours.value, interval: intervalMin.value }); } catch (e) { /* ignore */ }
      }
      async function loadTrend() {
        try { trend.value = await App.API.get('/iot/trend', { hours: windowHours.value }); } catch (e) { trend.value = []; }
      }
      async function loadDyn() {
        try { dyn.value = await App.API.get('/dynamic/overview'); } catch (e) { /* ignore */ }
      }

      async function runSweep() {
        sweep.running = true;
        try {
          sweep.result = await App.API.post('/iot/offline-sweep', {
            silentMinutes: Number(sweep.silentMinutes),
            cooldownMinutes: Number(sweep.cooldownMinutes),
            maxPerRun: Number(sweep.maxPerRun),
          });
          App.notify.ok(sweep.result.marked
            ? `已补记 ${sweep.result.marked} 个离线排口`
            : '本次未发现新的离线排口（严格模式下"从未上报"不算离线）');
          await Promise.all([loadQuality(), loadPma(), loadTrend(), loadDyn()]);
        } catch (e) { App.notify.err(e.message); } finally { sweep.running = false; }
      }

      onMounted(() => {
        loadQuality(); loadPma(); loadTrend(); loadDyn();
        poll.every(loadQuality, 15000);
        poll.every(loadDyn, 20000);
      });

      /* 质量分布环形图 */
      const donutOption = computed(() => {
        const q = quality.value;
        if (!q) return null;
        const data = q.distribution.map((d) => ({
          name: (QUALITY_META[d.flag] || {}).label || d.flag,
          value: d.count,
          itemStyle: { color: (QUALITY_META[d.flag] || {}).color || '#8d9cb5' },
        }));
        return App.chartBase({
          tooltip: Object.assign({}, App.chartBase().tooltip, { trigger: 'item', formatter: '{b}<br/>{c} 条（{d}%）' }),
          legend: { bottom: 0, textStyle: { color: '#8d9cb5', fontSize: 11.5 }, icon: 'circle', itemWidth: 9, itemHeight: 9 },
          series: [{
            type: 'pie', radius: ['46%', '68%'], center: ['50%', '44%'], avoidLabelOverlap: true,
            itemStyle: { borderColor: 'rgba(0,0,0,.28)', borderWidth: 2 },
            label: { color: '#c3d0e4', fontSize: 11, formatter: '{b}\n{d}%' },
            labelLine: { lineStyle: { color: 'rgba(255,255,255,.2)' } },
            data,
          }],
        });
      });

      /* 接入量时序（有效 / 异常堆叠） */
      const trendOption = computed(() => {
        if (!trend.value.length) return null;
        const xs = trend.value.map((r) => r.hour);
        return App.chartBase({
          grid: { left: 10, right: 16, top: 40, bottom: 6, containLabel: true },
          legend: { data: ['有效数据', '非正常', '设备直报'], top: 2 },
          xAxis: App.catAxis(xs, { boundaryGap: false }),
          yAxis: App.valAxis(),
          series: [
            {
              name: '有效数据', type: 'line', smooth: true, showSymbol: false,
              areaStyle: { color: App.areaGrad('rgba(16,185,129,.35)', 'rgba(16,185,129,0)') },
              lineStyle: { width: 2, color: '#10b981' },
              data: trend.value.map((r) => r.normal),
            },
            {
              name: '非正常', type: 'bar', stack: 'q', barMaxWidth: 12,
              itemStyle: { color: 'rgba(244,63,94,.55)' },
              data: trend.value.map((r) => Math.max(0, r.count - r.normal)),
            },
            {
              name: '设备直报', type: 'bar', stack: 'q', barMaxWidth: 12,
              itemStyle: { color: 'rgba(56,189,248,.45)' },
              data: trend.value.map((r) => r.direct),
            },
          ],
        });
      });

      const pmaColumns = [
        { key: 'entName', title: '企业' },
        { key: 'monitorNo', title: '排口', width: '120px' },
        { key: 'normalCount', title: '有效', width: '74px', align: 'right' },
        { key: 'abnormalCount', title: '异常', width: '74px', align: 'right' },
        { key: 'actualCount', title: '实收', width: '74px', align: 'right' },
        { key: 'expectedCount', title: '分母', width: '74px', align: 'right' },
        { key: 'availabilityPct', title: '获取率', width: '96px', align: 'right' },
        { key: 'grade', title: '等级', width: '66px' },
      ];

      return () => {
        const q = quality.value;
        const p = pma.value;
        const normal = q ? ((q.distribution.find((d) => d.flag === 'NORMAL') || {}).count || 0) : 0;
        const total = q ? q.total : 0;
        const abnormal = Math.max(0, total - normal);
        const ds = dyn.value && dyn.value.summary ? dyn.value.summary : {};
        const accounts = (dyn.value && dyn.value.accounts) || [];
        const excludedTotal = accounts.reduce((s, a) => s + (a.excludedPoints || 0), 0);

        return h('x-page', {
          title: '数据质量看板',
          desc: '质量标记不是装饰 —— 它决定哪些数据能进核算，并用数据获取率如实暴露缺数',
        }, {
          default: () => [
            kpiGrid([
              { label: '读数总量', value: App.fmt.num(total), unit: '条', tone: 'sky', icon: 'db', foot: `窗口 ${windowHours.value} 小时内 ${p ? App.fmt.num(p.points) : 0} 个测点` },
              { label: '有效数据占比', value: total ? ((normal / total) * 100).toFixed(2) : '—', unit: '%', tone: 'carbon', icon: 'shield', foot: `${App.fmt.num(normal)} 条 NORMAL` },
              { label: '非正常数据', value: App.fmt.num(abnormal), unit: '条', tone: abnormal ? 'rose' : 'carbon', icon: 'alert', foot: '缺数 / 漂移 / 停机 / 校准' },
              { label: '全场数据获取率', value: p ? p.overallPct : '—', unit: '%', tone: 'violet', icon: 'chart', foot: p ? '分母 = max(应得, 实收)' : 'PMA 指标' },
              { label: '核算纳入有效点', value: App.fmt.num(accounts.reduce((s, a) => s + (a.validPoints || 0), 0)), unit: '点', tone: 'chain', icon: 'leaf', foot: `动态核算已按质量门控取数` },
              { label: '核算排除点数', value: App.fmt.num(excludedTotal), unit: '点', tone: excludedTotal ? 'rose' : 'carbon', icon: 'alert', foot: '被质量门控挡在核算之外' },
            ]),

            h('div', { class: 'grid mt-16', style: 'grid-template-columns:1fr 1.1fr' }, [
              h('x-card', { title: '质量标记分布', sub: q ? `共 ${App.fmt.num(q.total)} 条（全部历史）` : '—' }, {
                default: () => h('div', { class: 'card-body' }, [
                  q && donutOption.value
                    ? h('x-chart', { option: donutOption.value, height: 'h260' })
                    : h('div', { class: 'empty' }, '加载中…'),
                  h('div', { class: 'mt-12' }, q ? q.distribution.map((d) => {
                    const meta = QUALITY_META[d.flag] || { color: '#8d9cb5', label: d.flag };
                    return h('div', { class: 'gov-qrow' }, [
                      h('span', { class: 'gov-dot', style: `background:${meta.color};box-shadow:0 0 7px ${meta.color}` }),
                      h('div', { style: 'width:96px;font-size:12.4px' }, h('x-tag', { text: d.flag, tone: meta.tone })),
                      h('div', { class: 'flex-1 tiny dim' }, d.semantics),
                      h('div', { class: 'mono', style: 'width:70px;text-align:right' }, App.fmt.num(d.count)),
                      h('div', { class: 'mono dim', style: 'width:60px;text-align:right' }, d.sharePct + '%'),
                    ]);
                  }) : null),
                ]),
              }),

              h('x-card', { title: '接入量时序', sub: '有效 / 非正常 / 设备直报' }, {
                actions: () => [
                  h('select', {
                    class: 'input', style: 'width:96px;height:30px', value: String(windowHours.value),
                    'aria-label': '统计窗口',
                    onChange: (e) => { windowHours.value = Number(e.target.value); loadPma(); loadTrend(); },
                  }, [6, 24, 72, 168].map((x) => h('option', { value: String(x) }, `${x} 小时`))),
                  h('button', { class: 'btn sm ghost', onClick: () => { loadQuality(); loadPma(); loadTrend(); } }, '刷新'),
                ],
                default: () => h('div', { class: 'card-body' },
                  trendOption.value ? h('x-chart', { option: trendOption.value, height: 'h260' }) : h('x-empty', { title: '暂无时序数据', sub: '时序数据由采集任务写入，可在「系统与链自检」中触发一次采集', icon: 'chart', tone: 'data' })),
              }),
            ]),

            h('div', { class: 'grid mt-16', style: 'grid-template-columns:1fr 320px' }, [
              h('x-card', {
                title: '数据获取率 PMA', sub: '有效数据个数 / 应得数据个数 —— 按排口逐个考核',
              }, {
                actions: () => h('div', { class: 'flex gap-8' }, [
                  h('span', { class: 'tiny dim' }, '约定间隔'),
                  h('select', {
                    class: 'input', style: 'width:96px;height:30px', value: String(intervalMin.value),
                    onChange: (e) => { intervalMin.value = Number(e.target.value); loadPma(); },
                  }, [15, 30, 60, 240].map((x) => h('option', { value: String(x) }, `${x} 分钟`))),
                ]),
                default: () => h('div', { class: 'card-body flush' }, [
                  p && p.denominatorRule
                    ? h('div', { class: 'tiny dim', style: 'padding:10px 17px;border-bottom:1px solid var(--hair)' },
                      '分母口径：' + p.denominatorRule)
                    : null,
                  h('x-table', {
                    columns: pmaColumns, rows: (p && p.worst) || [], rowKey: 'monitorNo',
                    empty: '暂无数据获取率数据',
                  }, {
                    'col-monitorNo': ({ row }) => h('span', { class: 'tag t-info plain' }, row.monitorNo),
                    'col-normalCount': ({ row }) => h('span', { class: 'mono' }, App.fmt.num(row.normalCount)),
                    'col-abnormalCount': ({ row }) => h('span', { class: 'mono', style: row.abnormalCount ? 'color:#fda4af' : '' }, App.fmt.num(row.abnormalCount)),
                    'col-actualCount': ({ row }) => h('span', { class: 'mono dim' }, App.fmt.num(row.actualCount)),
                    'col-expectedCount': ({ row }) => h('span', { class: 'mono dim' }, App.fmt.num(row.expectedCount)),
                    'col-availabilityPct': ({ row }) => h('span', {
                      class: 'mono', style: row.availabilityPct >= 95 ? 'color:#6ee7b7' : (row.availabilityPct >= 80 ? 'color:#fcd34d' : 'color:#fda4af'),
                    }, row.availabilityPct + '%'),
                    'col-grade': ({ row }) => h('x-tag', {
                      text: row.grade,
                      tone: { A: 't-ok', B: 't-info', C: 't-warn', D: 't-danger' }[row.grade] || 't-mute',
                    }),
                  }),
                ]),
              }),

              /* 离线看门狗 */
              h('x-card', { title: '离线看门狗', sub: 'OFFLINE 标记的唯一真实生产者' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'tiny', style: 'color:var(--tx-2);line-height:1.8;margin-bottom:12px' }, App.fmt.md(
                    '缺数（MISSING）是设备报了但那个时段没有有效值；离线（OFFLINE）是设备**根本没出现**。'
                    + '后者只能由平台主动巡检发现 —— 存活证据只认设备直报，平台自举读数不作数。')),
                  h('div', { class: 'field' }, [
                    h('label', {}, '静默阈值（分钟）'),
                    h('input', {
                      class: 'input', type: 'number', value: sweep.silentMinutes,
                      onInput: (e) => { sweep.silentMinutes = e.target.value; },
                    }),
                    h('div', { class: 'hint' }, '最后一次设备直报距今超过该阈值 → 判定离线。从未上报的设备不判离线（那是"尚未投运"）。'),
                  ]),
                  h('div', { class: 'field' }, [
                    h('label', {}, '冷却期（分钟）'),
                    h('input', {
                      class: 'input', type: 'number', value: sweep.cooldownMinutes,
                      onInput: (e) => { sweep.cooldownMinutes = e.target.value; },
                    }),
                    h('div', { class: 'hint' }, '同一排口在冷却期内只补记一条，避免一次停机每轮巡检都写一条。'),
                  ]),
                  h('div', { class: 'field' }, [
                    h('label', {}, '单次最多补记（台）'),
                    h('input', {
                      class: 'input', type: 'number', value: sweep.maxPerRun,
                      onInput: (e) => { sweep.maxPerRun = e.target.value; },
                    }),
                  ]),
                  h('button', {
                    class: 'btn block primary', disabled: sweep.running, onClick: runSweep,
                  }, sweep.running ? '巡检中…' : '执行离线巡检'),
                  sweep.result ? h('div', { class: 'mt-12' }, [
                    h('x-readout', {
                      pass: true,
                      label: sweep.result.marked ? `补记 ${sweep.result.marked} 个离线排口` : '未发现新的离线排口',
                      detail: `候选 ${sweep.result.candidates} · 批次 ${sweep.result.batchNo}`,
                    }),
                    sweep.result.details && sweep.result.details.length
                      ? h('div', { class: 'gov-ev mt-8' }, sweep.result.details.slice(0, 12).map((d) => h('div', { class: 'it' }, [
                        h('span', { class: 'at' }, d.monitorNo),
                        h('div', { class: 'flex-1 tiny dim' }, `最后直报 ${App.fmt.dt(d.lastAt)}`),
                      ])))
                      : null,
                  ]) : null,
                ]),
              }),
            ]),
          ],
        });
      };
    },
  });

  /* ==================================================================
   * ③ 审计日志哈希链校验
   * ================================================================== */
  const PageAuditChain = defineComponent({
    name: 'page-audit-chain',
    setup() {
      injectStyle();
      const st = ref(null);
      const verifyResult = ref(null);
      const sample = ref(0);
      const verifying = ref(false);
      const sealing = ref(false);
      const entryId = ref('');
      const entryResult = ref(null);
      const entryErr = ref('');
      const isAdmin = computed(() => !!(App.Store.user && App.Store.user.role === 'ADMIN'));
      const poll = usePollers();

      async function loadStats() {
        try { st.value = await App.API.get('/ops/audit-chain'); } catch (e) { /* ignore */ }
      }
      async function runVerify() {
        verifying.value = true;
        try {
          verifyResult.value = await App.API.get('/ops/audit-chain/verify', { sample: Number(sample.value) || undefined });
          App.notify[verifyResult.value.valid ? 'ok' : 'err'](
            verifyResult.value.valid ? '审计链完整，未发现篡改' : `发现 ${verifyResult.value.errors.length} 处异常`
          );
        } catch (e) { App.notify.err(e.message); } finally { verifying.value = false; }
      }
      async function seal() {
        sealing.value = true;
        try {
          const r = await App.API.post('/ops/audit-chain/seal', {});
          App.notify.ok(r.sealed ? `已封印 ${r.sealed} 条` : '无待封印条目（幂等）');
          await loadStats();
        } catch (e) { App.notify.err(e.message); } finally { sealing.value = false; }
      }
      async function lookupEntry() {
        entryErr.value = ''; entryResult.value = null;
        const id = String(entryId.value || '').trim();
        if (!id) return;
        try { entryResult.value = await App.API.get('/ops/audit-chain/entry/' + encodeURIComponent(id)); }
        catch (e) { entryErr.value = e.message; }
      }

      onMounted(() => {
        poll.every(loadStats, 12000);
        runVerify();
      });

      const errColumns = [
        { key: 'id', title: '条目', width: '90px' },
        { key: 'type', title: '异常类型', width: '190px' },
        { key: 'message', title: '说明' },
      ];

      return () => {
        const s = st.value || {};
        const v = verifyResult.value;
        return h('x-page', {
          title: '审计日志哈希链校验',
          desc: '链上的业务事实再可信，操作它的人如果不留痕，"可信"也只是半截 —— 这里补上后半截',
        }, {
          actions: () => [
            isAdmin.value
              ? h('button', { class: 'btn sm primary', disabled: sealing.value, onClick: seal },
                sealing.value ? '封印中…' : '封印历史条目')
              : null,
          ],
          default: () => [
            kpiGrid([
              { label: '日志条目', value: App.fmt.num(s.total || 0), unit: '条', tone: 'sky', icon: 'db', foot: `链高 #${(s.tip && s.tip.id) || 0}` },
              { label: '已封印', value: App.fmt.num(s.sealed || 0), unit: '条', tone: 'carbon', icon: 'shield', foot: '每条都链接前一条的 entry_hash' },
              { label: '未封印', value: App.fmt.num(s.unsealed || 0), unit: '条', tone: (s.unsealed ? 'rose' : 'carbon'), icon: 'alert', foot: s.unsealed ? '存在断点，校验会报 UNSEALED' : '全部入链' },
              { label: '链首条目', value: s.head ? '#' + s.head.id : '—', unit: '', tone: 'violet', icon: 'block', foot: s.head ? App.fmt.dt(s.head.at) : '—' },
              { label: '链尾条目', value: s.tip ? '#' + s.tip.id : '—', unit: '', tone: 'chain', icon: 'chain', foot: s.tip ? App.fmt.dt(s.tip.at) : '—' },
              {
                label: '最近校验结论',
                value: v ? (v.valid ? '完整' : '异常') : '—',
                unit: '', tone: v && v.valid ? 'carbon' : 'rose', icon: 'verify',
                foot: v ? `${v.mode} · 复算 ${v.checked} 条` : '尚未校验',
              },
            ]),

            h('div', { class: 'grid mt-16', style: 'grid-template-columns:1fr 1fr' }, [
              h('x-card', {
                title: '全链复算校验',
                sub: '不读缓存、不看标记，逐条重算哈希并与记录比对',
              }, {
                actions: () => [
                  h('select', {
                    class: 'input', style: 'width:140px;height:30px', value: String(sample.value),
                    'aria-label': '校验范围',
                    onChange: (e) => { sample.value = Number(e.target.value); },
                  }, [
                    h('option', { value: '0' }, '全链复算'),
                    h('option', { value: '50' }, '抽样最后 50 条'),
                    h('option', { value: '200' }, '抽样最后 200 条'),
                    h('option', { value: '1000' }, '抽样最后 1000 条'),
                  ]),
                  h('button', { class: 'btn sm primary', disabled: verifying.value, onClick: runVerify },
                    verifying.value ? '复算中…' : '开始校验'),
                ],
                default: () => h('div', { class: 'card-body' }, [
                  v
                    ? h('x-readout', {
                      pass: v.valid,
                      label: v.valid ? '审计链完整，未发现篡改' : `发现 ${v.errors.length} 处异常`,
                      detail: `${v.mode} · 复算 ${v.checked} / 共 ${v.total} 条`,
                    })
                    : h('div', { class: 'empty' }, '尚未执行校验'),
                  v ? h('dl', { class: 'kv mt-12' }, [
                    h('dt', {}, '校验条目'), h('dd', { class: 'mono' }, `${v.checked} 条`),
                    h('dt', {}, '已封印 / 未封印'), h('dd', { class: 'mono' }, `${v.sealed} / ${v.unsealed}`),
                    h('dt', {}, '链尾高度'), h('dd', { class: 'mono' }, '#' + v.height),
                    h('dt', {}, '链尾哈希'), h('dd', {}, h('x-hash', { value: v.tipHash, len: 16 })),
                    h('dt', {}, '异常类型'), h('dd', { class: 'mono' }, (v.errorTypes || []).length ? v.errorTypes.join(' , ') : '无'),
                  ]) : null,
                  v && v.errors && v.errors.length
                    ? h('div', { class: 'mt-12' }, h('x-table', { columns: errColumns, rows: v.errors.slice(0, 20), rowKey: 'id' }, {
                      'col-id': ({ row }) => h('span', { class: 'mono' }, '#' + row.id),
                      'col-type': ({ row }) => h('span', { class: 'tag t-danger' }, row.type),
                    }))
                    : null,
                ]),
              }),

              h('x-card', { title: '哈希链构造', sub: '改动任意一条，其后全部失配' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'gov-formula' }, 'entry_hash = SHA256( prev_hash + "|" + stableStringify(条目) )'),
                  h('div', { class: 'tiny', style: 'color:var(--tx-2);line-height:1.85;margin-top:12px' },
                    '为什么链上是这样：把 audit_log 从"任何能连库的人都能静默 UPDATE 的普通表"，'
                    + '升级为与区块链同构的轻量哈希链。改动一条的明细，它的 entry_hash 立刻变化，'
                    + '后一条的 prev_hash 就对不上 —— 想掩盖就得重算整条链，而链顶哈希已经对外可见。'),
                  h('div', { class: 'mt-12' }, [
                    h('div', { class: 'tiny', style: 'color:var(--tx-2);margin-bottom:6px' }, '与联盟链的分工（不是重复造链）'),
                    h('div', { class: 'gov-check' }, [
                      h('span', { class: 'flag ok' }, '业务事实'),
                      h('div', { class: 'flex-1 tx' }, '联盟链承载排放、配额、交易：多方副本、PoA 共识、慢而重。'),
                    ]),
                    h('div', { class: 'gov-check' }, [
                      h('span', { class: 'flag ok' }, '操作事实'),
                      h('div', { class: 'flex-1 tx' }, '审计哈希链承载"谁在什么时候动了什么"：单链、无共识、快。'),
                    ]),
                  ]),
                  h('div', { class: 'mt-16' }, [
                    h('div', { class: 'tiny', style: 'color:var(--tx-2);margin-bottom:8px' }, '按模块分布'),
                    h('x-bars', {
                      items: (s.byModule || []).map((m) => ({ name: m.module, value: m.count })),
                      valueKey: 'value', labelKey: 'name',
                    }),
                  ]),
                ]),
              }),
            ]),

            h('x-card', {
              title: '单条条目复核',
              sub: '输入条目编号，查看它参与哈希的规范化字段与复算结果',
              class: 'mt-16',
            }, {
              actions: () => h('div', { class: 'flex gap-8' }, [
                h('input', {
                  class: 'input', style: 'width:150px;height:30px', placeholder: '条目编号，如 1',
                  value: entryId.value, onInput: (e) => { entryId.value = e.target.value; },
                  onKeyup: (e) => { if (e.key === 'Enter') lookupEntry(); },
                }),
                h('button', { class: 'btn sm primary', onClick: lookupEntry }, '复核'),
              ]),
              default: () => h('div', { class: 'card-body' }, [
                entryErr.value ? h('div', { class: 'tag t-danger' }, entryErr.value) : null,
                entryResult.value
                  ? h('div', {}, [
                    h('x-readout', {
                      pass: entryResult.value.consistent,
                      label: entryResult.value.consistent ? '该条目与链上记录一致' : '该条目已被改动（哈希失配）',
                      detail: `#${entryResult.value.id}`,
                    }),
                    h('dl', { class: 'kv mt-12' }, [
                      h('dt', {}, 'prev_hash'), h('dd', {}, h('x-hash', { value: entryResult.value.prevHash, len: 20 })),
                      h('dt', {}, 'entry_hash'), h('dd', {}, h('x-hash', { value: entryResult.value.entryHash, len: 20 })),
                      h('dt', {}, '复算结果'), h('dd', {}, h('x-hash', { value: entryResult.value.recomputed, len: 20 })),
                      h('dt', {}, '操作人'), h('dd', {}, `${entryResult.value.payload.username}（${entryResult.value.payload.role}）`),
                      h('dt', {}, '模块 / 动作'), h('dd', {}, `${entryResult.value.payload.module} · ${entryResult.value.payload.action}`),
                      h('dt', {}, '操作对象'), h('dd', {}, entryResult.value.payload.target || '—'),
                      h('dt', {}, '时间'), h('dd', { class: 'mono' }, entryResult.value.payload.createdAt),
                      h('dt', {}, '结果'), h('dd', {}, h('x-tag', {
                        text: entryResult.value.payload.result,
                        tone: entryResult.value.payload.result === 'SUCCESS' ? 't-ok' : 't-danger',
                      })),
                    ]),
                    h('div', { class: 'gov-formula mt-12' }, entryResult.value.formula),
                    h('div', { class: 'tiny', style: 'color:var(--tx-2);margin:12px 0 6px' }, '参与哈希的规范化条目'),
                    h('pre', { class: 'gov-mono', style: 'background:var(--bg-0);border:1px solid var(--hair);border-radius:8px;padding:12px;overflow:auto;max-height:260px' },
                      JSON.stringify(entryResult.value.payload, null, 2)),
                  ])
                  : h('div', { class: 'dim tiny' }, '输入条目编号后点击「复核」。时间字段一律取 DATETIME 字面量参与哈希 —— 用 Date 对象会随进程时区解释出不同毫秒数，哈希必失配。'),
              ]),
            }),
          ],
        });
      };
    },
  });

  /* 注册到全局视图表（app.js L409 按 App.views[Router.view] 解析路由） */
  App.views = App.views || {};
  App.views['page-iot-devices'] = PageIotDevices;
  App.views['page-data-quality'] = PageDataQuality;
  App.views['page-audit-chain'] = PageAuditChain;
})();
