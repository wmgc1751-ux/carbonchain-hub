/* =====================================================================
   联盟链治理：节点网络共识拓扑 / 成员节点 / 准入白名单 / 副本同步与一致性
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  const PageConsortium = defineComponent({
    name: 'page-consortium',
    setup() {
      const nodes = ref([]);
      const replica = ref(null);
      const busy = ref(false);
      const form = ref({ nodeId: '', nodeName: '', orgType: 'ENTERPRISE', orgName: '' });
      const ORG_TYPES = [
        ['REGULATOR', '监管机构'], ['VERIFIER', '核查机构'], ['ENTERPRISE', '企业'], ['AUDITOR', '审计机构'],
      ];

      /* 实时脉动：节点呼吸灯与链路延迟 */
      const tick = ref(0);
      let timer = null;
      onMounted(() => { timer = setInterval(() => { tick.value++; }, 2200); });
      onUnmounted(() => { clearInterval(timer); });

      async function load() {
        try {
          nodes.value = await App.API.request('GET', '/consortium/nodes', null, { noAuth: true });
          replica.value = await App.API.request('GET', '/consortium/replica', null, { noAuth: true });
        } catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);

      async function run(fn, okMsg) {
        busy.value = true;
        try { const r = await fn(); App.notify.ok(typeof okMsg === 'function' ? okMsg(r) : okMsg); await load(); }
        catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }
      const syncAll = () => run(() => App.API.request('POST', '/consortium/sync', {}), (rs) => `已完成 ${rs.length} 个节点的副本同步`);
      const syncOne = (id) => run(() => App.API.request('POST', `/consortium/nodes/${id}/sync`, {}), (r) => (r.synced > 0 ? `节点 ${id} 已补拉 ${r.synced} 个区块` : `节点 ${id} 副本已是最新`));
      const desync = (id) => run(() => App.API.request('POST', `/consortium/nodes/${id}/desync`, { keepHeight: Math.max(0, (replica.value ? replica.value.mainHeight : 0) - 6) }), `已模拟 ${id} 链副本落后 6 个区块`);
      const approve = (id) => run(() => App.API.request('POST', `/consortium/nodes/${id}/approve`, { weight: 1 }), `已授予 ${id} 出块权`);
      const revoke = (id) => run(() => App.API.request('POST', `/consortium/nodes/${id}/revoke`, { reason: '监管决议吊销' }), `已吊销 ${id} 出块权`);
      const apply = () => run(() => App.API.request('POST', '/consortium/nodes/apply', form.value), '加入申请已提交，等待联盟审批')
        .then(() => { form.value = { nodeId: '', nodeName: '', orgType: 'ENTERPRISE', orgName: '' }; });

      const statusTag = (s) => (s === 'ACTIVE' ? 'ok' : s === 'PENDING' ? 'warn' : 'err');
      const statusCn = (s) => ({ ACTIVE: '已授权', PENDING: '待审批', REVOKED: '已吊销' }[s] || s);

      /* ── 四类参与方的物理节点网络拓扑 ── */
      const topo = App.Industry.topology;
      const ROLES = App.Industry.NODE_ROLES;
      const ROLE_ORDER = ['ENTERPRISE', 'VERIFIER', 'REGULATOR', 'BANK'];
      const groups = computed(() => ROLE_ORDER.map((role) => ({
        role, meta: ROLES[role],
        nodes: topo.filter((n) => n.role === role),
      })));
      const topoStats = computed(() => ({
        total: topo.length,
        active: topo.filter((n) => n.status === 'ACTIVE').length,
        consistent: topo.filter((n) => n.consistent).length,
        avgLatency: Math.round(topo.reduce((s, n) => s + n.latencyMs, 0) / topo.length),
      }));
      /** 延迟（叠加脉动） */
      const latOf = (n) => Math.max(1, Math.round(n.latencyMs + Math.sin((tick.value + n.id.length) * 0.8) * 4));

      return () => {
        const rep = replica.value || { nodes: [], mainHeight: -1, consistentNodes: 0, totalNodes: 0 };
        const activeCount = (nodes.value || []).filter((n) => n.status === 'ACTIVE').length;
        const ts = topoStats.value;

        return h('x-page', {
          title: '联盟链治理',
          desc: '联盟链由许可制成员节点共同维护：节点须经联盟审批获得出块权，共识采用 PoA（权威证明），各成员各自持有一份全量链副本。参与方覆盖「排碳企业自建节点 → 第三方核查机构节点 → 生态环境主管部门节点 → 绿色金融银行节点」四类主体，形成从生产、核查、监管到绿色金融的完整多方互信闭环。',
        }, {
          actions: () => [
            h('button', { class: 'btn sm', disabled: busy.value, onClick: syncAll }, [h('x-icon', { name: 'refresh', size: 14 }), '同步全部节点副本']),
            h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'dash', size: 14 }), '刷新']),
          ],
          default: () => [
            h('div', { class: 'grid g4 mb-16' }, [
              h('x-kpi', { label: '共识机制', value: 'PoA', icon: 'shield', tone: 'violet', foot: '授权证明·无挖矿·即出即确认' }),
              h('x-kpi', { label: '联盟节点总数', value: ts.total, unit: '个', icon: 'layers', tone: 'carbon', foot: `四类参与方 · 已授权 ${ts.active} 个` }),
              h('x-kpi', { label: '副本一致节点', value: `${rep.consistentNodes}/${rep.totalNodes}`, icon: 'chain', tone: 'chain', foot: rep.laggingNodes ? `落后 ${rep.laggingNodes} 个` : '全部追平主链' }),
              h('x-kpi', { label: '主链高度', value: App.fmt.num(rep.mainHeight), icon: 'block', tone: 'sky', foot: App.fmt.short(rep.mainTip || '-', 10) }),
            ]),

            /* ==================================================================
               节点网络共识拓扑
               ================================================================== */
            h('x-card', {
              title: '联盟链节点网络共识拓扑',
              sub: '四类参与方各自持有全量链副本：任意一方单独篡改本地数据库，其余副本都能立即发现',
              class: 'mb-16',
            }, {
              actions: () => h('div', { class: 'flex gap-8' }, [
                h('span', { class: 'tag t-mute' }, `平均链路延迟 ${ts.avgLatency} ms`),
                h('span', { class: 'tag chain' }, `拓扑示意 · ${ts.active}/${ts.total} 节点已授权`),
              ]),
              default: () => h('div', {}, [
                /* 共识核心 */
                h('div', { class: 'consensus-core mb-16' }, [
                  h('div', { class: 'cc-left' }, [
                    h('i', { class: 'ind-lamp NORMAL', style: 'width:10px;height:10px' }),
                    h('div', {}, [
                      h('div', { style: 'font-size:13.4px;color:var(--tx-0);font-weight:600' }, 'PoA 共识核心 · 主链'),
                      h('div', { class: 'tiny dim' }, '轮值出块 · 出块权与权重由联盟按机构类型授予'),
                    ]),
                  ]),
                  h('div', { class: 'cc-mid mono' }, 'H = ' + App.fmt.num(rep.mainHeight) + (rep.mainTip ? '  ·  ' + App.fmt.short(rep.mainTip, 10) : '')),
                  h('div', { class: 'cc-right' }, [
                    h('div', { class: 'tiny dim' }, '容器视图'),
                    h('div', { class: 'tiny mono', style: 'color:var(--tx-1)' },
                      `{ 企业 ${topo.filter((n) => n.role === 'ENTERPRISE').length} · 核查 ${topo.filter((n) => n.role === 'VERIFIER').length} · 监管 ${topo.filter((n) => n.role === 'REGULATOR').length} · 金融 ${topo.filter((n) => n.role === 'BANK').length} }`),
                  ]),
                ]),

                /* 四类参与方 */
                h('div', { class: 'topo-grid' }, groups.value.map((g) => h('div', { class: ['topo-col', g.meta.cls] }, [
                  h('div', { class: 'topo-head' }, [
                    h('div', { class: 'flex gap-8', style: 'align-items:center' }, [
                      h('span', { class: 'topo-ico' }, [h('x-icon', { name: g.meta.icon, size: 15 })]),
                      h('b', { style: 'font-size:13px;color:var(--tx-0)' }, g.meta.cn),
                    ]),
                    h('span', { class: 'tag t-mute' }, g.nodes.length + ' 节点'),
                  ]),
                  h('div', { class: 'tiny dim mb-8', style: 'min-height:30px' }, g.meta.desc),
                  h('div', { class: 'col gap-8' }, g.nodes.map((n) => h('div', { class: ['node-chip', n.status !== 'ACTIVE' ? 'off' : ''] }, [
                    h('div', { class: 'flex between', style: 'align-items:center' }, [
                      h('div', { class: 'flex gap-6', style: 'align-items:center;min-width:0' }, [
                        h('i', { class: ['ind-lamp', n.consistent ? 'NORMAL' : 'WATCH'], style: 'width:7px;height:7px' }),
                        h('span', { class: 'nc-name', title: n.name }, n.name),
                      ]),
                      n.status === 'ACTIVE'
                        ? h('span', { class: 'tag ok', style: 'flex:0 0 auto' }, '已授权')
                        : h('span', { class: 'tag warn', style: 'flex:0 0 auto' }, '待审批'),
                    ]),
                    h('div', { class: 'nc-meta mono' }, [
                      'H=' + n.height,
                      n.lag > 0 ? ' (落后' + n.lag + ')' : '',
                      ' · 权重 ' + n.weight,
                      ' · 出块 ' + n.proposed,
                      ' · ' + latOf(n) + 'ms',
                    ]),
                    h('div', { class: 'nc-id mono', title: '点击复制节点标识', onClick: () => App.copyText(n.id) }, n.id),
                  ]))),
                ]))),

                h('div', { class: 'alertbar info mt-16' }, [
                  h('x-icon', { name: 'info', size: 15 }),
                  '许可制的意义：节点不是任何人想接就能接。新节点须提交申请、经联盟（监管节点）审批授予出块权后才可参与共识；被吊销出块权的节点仍可保留只读副本，但无法再影响链的走向。',
                ]),
              ]),
            }),

            h('div', { class: ['alertbar', rep.consistentNodes === rep.totalNodes ? 'ok' : 'warn', 'mb-16'] }, [
              h('x-icon', { name: rep.consistentNodes === rep.totalNodes ? 'check' : 'alert', size: 16 }),
              rep.consistentNodes === rep.totalNodes
                ? `全部 ${rep.totalNodes} 个成员节点的链副本与主链完全一致（链顶哈希相同）—— 任意单一节点数据库被篡改，其它节点都能凭各自副本立即发现。`
                : `有 ${rep.laggingNodes} 个节点副本落后于主链，请执行同步；落后的副本不代表链被篡改，但同步前无法参与一致性比对。`,
            ]),

            h('x-card', { title: '联盟成员节点（链上实时状态）', sub: '出块权由联盟授予（许可制），权重决定轮值出块的相对频次', class: 'mb-16' }, {
              default: () => h('div', { class: 'tbl-wrap' }, [
                h('table', { class: 'tbl' }, [
                  h('thead', {}, h('tr', {}, ['节点标识', '机构类型', '所属机构', '状态', '出块权', '权重', '已出块', '副本高度', '链顶一致', '操作'].map((t) => h('th', {}, t)))),
                  h('tbody', {}, (nodes.value || []).map((n) => h('tr', {}, [
                    h('td', {}, [h('div', { class: 'mono', style: 'font-size:12px' }, n.nodeId), h('div', { class: 'tiny dim' }, App.fmt.short(n.walletAddress || '-', 12))]),
                    h('td', {}, n.orgTypeCn),
                    h('td', {}, n.orgName || '-'),
                    h('td', {}, h('span', { class: ['tag', statusTag(n.status)] }, statusCn(n.status))),
                    h('td', {}, n.isAuthorized ? h('span', { class: 'tag ok' }, '有') : h('span', { class: 'tag err' }, '无')),
                    h('td', { class: 'mono' }, String(n.voteWeight)),
                    h('td', { class: 'mono' }, String(n.proposedBlocks)),
                    h('td', { class: 'mono' }, '#' + n.replicaHeight + (n.lag > 0 ? ` (落后${n.lag})` : '')),
                    h('td', {}, n.consistent ? h('span', { class: 'tag ok' }, '一致') : h('span', { class: 'tag warn' }, n.lag > 0 ? '待同步' : '不一致')),
                    h('td', {}, [
                      h('button', { class: 'btn xs', disabled: busy.value, onClick: () => desync(n.nodeId) }, '模拟落后'),
                      ' ',
                      h('button', { class: 'btn xs chain', disabled: busy.value, onClick: () => syncOne(n.nodeId) }, '同步'),
                      ' ',
                      n.status !== 'ACTIVE'
                        ? h('button', { class: 'btn xs primary', disabled: busy.value, onClick: () => approve(n.nodeId) }, '授予出块权')
                        : h('button', { class: 'btn xs danger', disabled: busy.value, onClick: () => revoke(n.nodeId) }, '吊销'),
                    ]),
                  ]))),
                ]),
              ]),
            }),

            h('x-card', { title: '申请加入联盟', sub: '许可制：新节点须提出申请，经联盟（监管节点）审批授予出块权后才能参与共识' }, {
              default: () => h('div', { class: 'flex gap-12 wrap', style: 'align-items:flex-end' }, [
                h('div', { class: 'field', style: 'margin:0;width:190px' }, [h('label', {}, '节点标识'), h('input', { class: 'input', value: form.value.nodeId, placeholder: '如 node-xxx-01', onInput: (e) => { form.value.nodeId = e.target.value; } })]),
                h('div', { class: 'field', style: 'margin:0;width:190px' }, [h('label', {}, '节点名称'), h('input', { class: 'input', value: form.value.nodeName, placeholder: '如 XX 集团节点', onInput: (e) => { form.value.nodeName = e.target.value; } })]),
                h('div', { class: 'field', style: 'margin:0;width:150px' }, [h('label', {}, '机构类型'), h('select', { class: 'select', value: form.value.orgType, onChange: (e) => { form.value.orgType = e.target.value; } }, ORG_TYPES.map(([v, t]) => h('option', { value: v }, t)))]),
                h('div', { class: 'field', style: 'margin:0;width:210px' }, [h('label', {}, '所属机构'), h('input', { class: 'input', value: form.value.orgName, placeholder: '机构全称', onInput: (e) => { form.value.orgName = e.target.value; } })]),
                h('button', { class: 'btn chain', disabled: busy.value || !form.value.nodeId || !form.value.nodeName, onClick: apply }, [h('x-icon', { name: 'plus', size: 15 }), '提交加入申请']),
              ]),
            }),
          ],
        });
      };
    },
  });

  App.views['page-consortium'] = PageConsortium;
})();
