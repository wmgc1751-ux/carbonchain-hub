/* =====================================================================
   区块链浏览器（公开访问）+ 防篡改演示
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, reactive } = Vue;
  const h = App.h;

  /* ==================================================================
   * 一、链总览
   * ================================================================== */
  const PageExplorer = defineComponent({
    name: 'page-explorer',
    setup() {
      const stats = ref(null);
      const blocks = reactive({ rows: [], total: 0, page: 1, size: 12, pages: 1, loading: true });
      const txs = reactive({ rows: [], total: 0, page: 1, size: 12, pages: 1, loading: true });
      const tab = ref('blocks');
      const kw = ref('');

      const validation = ref(null);
      const busy = ref(false);
      const tamper = reactive({ blockIndex: 20, field: 'merkle_root' });
      const panel = ref(null);   // 篡改/修复结果面板

      async function loadStats() {
        stats.value = await App.API.request('GET', '/chain/stats', null, { noAuth: true });
        blocksConsistent();
      }
      async function blocksConsistent() {
        try { validation.value = await App.API.request('GET', '/chain/validate', null, { noAuth: true }); } catch (e) { /* ignore */ }
      }
      async function loadBlocks() {
        blocks.loading = true;
        try {
          const d = await App.API.request('GET', `/chain/blocks?page=${blocks.page}&size=${blocks.size}`, null, { noAuth: true });
          blocks.rows = d.rows; blocks.total = d.total; blocks.pages = d.pages;
        } finally { blocks.loading = false; }
      }
      async function loadTxs() {
        txs.loading = true;
        try {
          const q = new URLSearchParams({ page: txs.page, size: txs.size });
          if (kw.value) q.append('keyword', kw.value);
          const d = await App.API.request('GET', '/chain/txs?' + q.toString(), null, { noAuth: true });
          txs.rows = d.rows; txs.total = d.total; txs.pages = d.pages;
        } finally { txs.loading = false; }
      }

      onMounted(() => { loadStats(); loadBlocks(); loadTxs(); });

      async function doTamper() {
        busy.value = true; panel.value = null;
        try {
          const r = await App.API.request('POST', '/chain/tamper', { blockIndex: Number(tamper.blockIndex), field: tamper.field }, { noAuth: true });
          panel.value = { kind: 'tamper', data: r };
          App.notify.warn(`区块 #${r.blockIndex} 已被改写，链校验发现 ${r.validation.errors.length} 处异常`);
          await blocksConsistent();
          await loadBlocks();
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      async function doRepair() {
        busy.value = true;
        try {
          const from = panel.value && panel.value.data ? panel.value.data.blockIndex : Number(tamper.blockIndex);
          const r = await App.API.request('POST', '/chain/repair', { fromIndex: from }, { noAuth: true });
          panel.value = { kind: 'repair', data: r };
          App.notify.ok(`已重算 ${r.repaired.length} 个区块的哈希并重做工作量证明（耗时 ${r.repaired.reduce((a, b) => a + b.cost, 0)}ms）`);
          await loadStats(); await loadBlocks();
        } catch (e) { App.notify.err(e.message); } finally { busy.value = false; }
      }

      /* 链式可视化：取最新 6 块，如果存在被篡改的块则标红 */
      const vizBlocks = computed(() => {
        if (!stats.value) return [];
        const list = (blocks.rows || []).slice(0, 6).reverse();
        const badSet = new Set((panel.value && panel.value.kind === 'tamper'
          ? panel.value.data.validation.errors.map((e) => e.index) : []));
        return list.map((b) => ({ ...b, bad: badSet.has(Number(b.block_index)) }));
      });

      const chainStatus = computed(() => {
        if (!validation.value) return { cls: 'info', text: '正在校验全链完整性…' };
        return validation.value.valid
          ? { cls: 'ok', text: `全链完整性校验通过 —— 已校验 ${validation.value.checkedBlocks} 个区块，哈希链、PoW 难度、Merkle 根全部一致` }
          : { cls: 'err', text: `全链校验失败 —— 发现 ${validation.value.errorCount} 处异常，链上数据已被篡改或有节点作恶` };
      });

      return () => h('div', {}, [
        h('x-page', {
          title: '区块链浏览器',
          desc: '平台所有关键业务动作（排放上报 / 核查结论 / 配额分配 / 成交清算）均以交易形式写入区块链。本页面对公众开放，任何人可独立核验链上数据。',
        }, {
          actions: () => [
            h('button', { class: 'btn sm', onClick: () => App.go('/screen') }, [h('x-icon', { name: 'globe', size: 14 }), '公示大屏']),
            h('button', { class: 'btn sm', onClick: () => { loadStats(); loadBlocks(); loadTxs(); } }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新数据']),
          ],
          default: () => [
            /* 校验状态条 */
            h('div', { class: ['alertbar', chainStatus.value.cls, 'mb-16'] }, [
              h('x-icon', { name: validation.value && validation.value.valid ? 'shield' : 'alert', size: 16 }),
              h('div', { class: 'flex-1' }, [
                chainStatus.value.text,
                validation.value && h('div', { class: 'tiny mt-8 mono', style: 'opacity:.75' },
                  `链尾哈希 ${validation.value.height >= 0 ? stats.value.tipHash : '-'} · 校验时间 ${App.fmt.dt(validation.value.verifiedAt)}`),
              ]),
            ]),

            /* KPI */
            stats.value && h('div', { class: 'grid g6 mb-16' }, [
              h('x-kpi', { label: '区块高度', value: App.fmt.num(stats.value.height), icon: 'block', tone: 'chain', foot: `共 ${stats.value.totalBlocks} 块` }),
              h('x-kpi', { label: '链上交易', value: App.fmt.num(stats.value.confirmed), icon: 'chain', tone: 'carbon', foot: `待打包 ${stats.value.pending}` }),
              h('x-kpi', { label: 'PoW 难度', value: stats.value.difficulty, unit: '个前导零', icon: 'target', tone: 'violet', foot: `平均出块 ${stats.value.avgMineTime}ms` }),
              h('x-kpi', { label: '链上数据量', value: App.fmt.bytes(stats.value.totalSize), icon: 'db', tone: 'sky', foot: `${stats.value.totalTxInBlocks} 笔交易` }),
              h('x-kpi', { label: '出块节点', value: stats.value.node, icon: 'factory', tone: 'carbon', foot: '联盟链单节点演示' }),
              h('x-kpi', { label: '共识机制', value: 'PoW', icon: 'shield', tone: 'chain', foot: '最长链原则' }),
            ]),

            /* 链式可视化 */
            h('x-card', { title: '区块链接示意', sub: '每个区块通过 prevHash 指向前一区块，任一区块被改动都会造成后续所有区块失联', class: 'mb-16' }, {
              default: () => h('div', { class: 'chainviz' }, [
                ...vizBlocks.value.flatMap((b, i) => {
                  const node = h('div', { class: ['cv-block', b.bad && 'bad', Number(b.block_index) === 0 && 'genesis'] }, [
                    h('div', { class: 'flex between' }, [
                      h('span', { class: 'idx' }, '#' + b.block_index),
                      h('span', { class: 'tiny dim' }, `${b.tx_count} 笔`),
                    ]),
                    h('div', { class: 'h' }, 'HASH ' + App.fmt.short(b.block_hash, 14)),
                    h('div', { class: 'h' }, 'PREV ' + App.fmt.short(b.prev_hash, 14)),
                    h('div', { class: 'h' }, 'MRKL ' + App.fmt.short(b.merkle_root, 14)),
                    h('div', { class: 'tiny', style: 'margin-top:6px;color:var(--tx-3)' },
                      `nonce ${b.nonce} · ${App.fmt.ago(b.block_time)}`),
                  ]);
                  if (i === 0) return [node];
                  return [h('div', { class: 'cv-link' }, [h('b', {}, '→')]), node];
                }),
                h('div', { class: 'cv-link', style: 'flex:0 0 60px' }, [h('b', {}, '…')]),
              ]),
            }),

            /* 防篡改演示 */
            h('x-card', {
              title: '防篡改实验台',
              sub: '直接改写数据库中的区块字段，观察全链校验如何立刻发现异常 —— 这就是"不可篡改"的技术含义',
              class: 'mb-16',
            }, {
              default: () => h('div', {}, [
                h('div', { class: 'flex gap-12 wrap', style: 'align-items:flex-end' }, [
                  h('div', { class: 'field', style: 'margin:0;width:190px' }, [
                    h('label', {}, '目标区块高度'),
                    h('input', {
                      class: 'input', type: 'number', value: tamper.blockIndex,
                      onInput: (e) => { tamper.blockIndex = e.target.value; },
                    }),
                  ]),
                  h('div', { class: 'field', style: 'margin:0;width:230px' }, [
                    h('label', {}, '被篡改字段'),
                    h('select', {
                      class: 'select', value: tamper.field,
                      onChange: (e) => { tamper.field = e.target.value; },
                    }, [
                      h('option', { value: 'merkle_root' }, 'merkle_root（交易 Merkle 根）'),
                      h('option', { value: 'prev_hash' }, 'prev_hash（前向哈希）'),
                      h('option', { value: 'nonce' }, 'nonce（工作量证明随机数）'),
                      h('option', { value: 'block_time' }, 'block_time（出块时间）'),
                    ]),
                  ]),
                  h('button', { class: 'btn danger', disabled: busy.value, onClick: doTamper }, [
                    h('x-icon', { name: 'alert', size: 15 }), busy.value ? '处理中…' : '模拟恶意篡改',
                  ]),
                  panel.value && h('button', { class: 'btn chain', disabled: busy.value, onClick: doRepair }, [
                    h('x-icon', { name: 'refresh', size: 15 }), '重做工作量证明并修复',
                  ]),
                ]),

                panel.value && h('div', { class: 'mt-16' }, [
                  h('div', { class: 'hashbox mb-12' }, [
                    h('b', {}, panel.value.kind === 'tamper' ? '篡改操作记录' : '修复操作记录'), h('br'),
                    panel.value.kind === 'tamper'
                      ? `区块 #${panel.value.data.blockIndex} · 字段 ${panel.value.data.field}\n原值：${String(panel.value.data.before).slice(0, 72)}\n新值：${String(panel.value.data.after).slice(0, 72)}`
                      : `从区块 #${panel.value.data.fromIndex} 起重算 ${panel.value.data.repaired.length} 个区块，累计重做 PoW 耗时 ${panel.value.data.repaired.reduce((a, b) => a + b.cost, 0)} ms`,
                  ]),
                  h('div', { class: ['alertbar', panel.value.data.validation.valid ? 'ok' : 'err', 'mb-12'] }, [
                    h('x-icon', { name: panel.value.data.validation.valid ? 'check' : 'alert', size: 15 }),
                    panel.value.data.validation.valid
                      ? `校验通过：共校验 ${panel.value.data.validation.checkedBlocks} 个区块，未发现异常`
                      : `校验失败：发现 ${panel.value.data.validation.errors.length} 处异常`,
                  ]),
                  panel.value.data.validation.errors.length > 0 && h('div', { class: 'col gap-8' },
                    panel.value.data.validation.errors.slice(0, 8).map((e) => h('div', { class: 'readout fail' }, [
                      h('span', { class: 'flag' }, e.type),
                      h('span', {}, e.message),
                    ]))),
                  h('div', { class: 'alertbar info mt-12' }, [
                    h('x-icon', { name: 'info', size: 15 }),
                    h('div', {}, panel.value.kind === 'tamper'
                      ? '攻击者可以改掉自己机器上的数据库，但改完之后：① 本区块哈希对不上；② 后一个区块的 prevHash 指不过来；③ Merkle 根与交易表不一致；④ PoW 难度不再满足。只要网络中有任何一个诚实的全节点，这次篡改就会被全网发现。'
                      : '要让篡改后的链"看起来正常"，攻击者必须从被改动的区块开始，把后面每一个区块的哈希重新算出来，并为每一个区块重新完成 PoW。区块越往后，重算成本越高 —— 这就是工作量证明的经济学威慑。'),
                  ]),
                ]),

                !panel.value && h('div', { class: 'alertbar info mt-16' }, [
                  h('x-icon', { name: 'info', size: 15 }),
                  '提示：实验完成后请点击"重做工作量证明并修复"，把链恢复到可信状态。',
                ]),
              ]),
            }),

            /* 区块 / 交易列表 */
            h('div', { class: 'card' }, [
              h('div', { class: 'card-head' }, [
                h('div', { class: 'seg' }, [
                  h('button', { class: tab.value === 'blocks' ? 'on' : '', onClick: () => { tab.value = 'blocks'; loadBlocks(); } }, '区块列表'),
                  h('button', { class: tab.value === 'txs' ? 'on' : '', onClick: () => { tab.value = 'txs'; loadTxs(); } }, '交易列表'),
                ]),
                h('div', { class: 'acts' }, [
                  tab.value === 'txs' && h('div', { class: 'input-group', style: 'width:280px' }, [
                    h('input', {
                      class: 'input', placeholder: '搜索交易号 / 业务单号 / 地址', value: kw.value,
                      onInput: (e) => { kw.value = e.target.value; },
                      onKeyup: (e) => { if (e.key === 'Enter') { txs.page = 1; loadTxs(); } },
                    }),
                    h('button', { class: 'btn', onClick: () => { txs.page = 1; loadTxs(); } }, [h('x-icon', { name: 'search', size: 14 })]),
                  ]),
                ]),
              ]),

              tab.value === 'blocks' ? [
                h('x-table', {
                  columns: [
                    { key: 'block_index', title: '高度', width: '90px' },
                    { key: 'block_hash', title: '区块哈希' },
                    { key: 'prev_hash', title: '父哈希' },
                    { key: 'tx_count', title: '交易数', width: '80px' },
                    { key: 'nonce', title: 'nonce', width: '110px' },
                    { key: 'difficulty', title: '难度', width: '70px' },
                    { key: 'mine_time', title: '出块耗时', width: '100px' },
                    { key: 'block_time', title: '出块时间', width: '160px' },
                  ],
                  rows: blocks.rows, loading: blocks.loading,
                  rowClick: (r) => App.go('/explorer/block/' + r.block_index),
                }, {
                  'col-block_index': ({ value }) => h('span', { class: 'mono', style: 'color:var(--chain-l);font-weight:700' }, '#' + value),
                  'col-block_hash': ({ value }) => h('x-hash', { value, len: 20 }),
                  'col-prev_hash': ({ value }) => h('x-hash', { value, len: 14 }),
                  'col-tx_count': ({ value }) => h('span', { class: 'tag t-chain plain' }, value + ' 笔'),
                  'col-nonce': ({ value }) => h('span', { class: 'mono dim' }, value),
                  'col-mine_time': ({ value }) => h('span', { class: 'mono' }, value + ' ms'),
                  'col-block_time': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                }),
                h('x-pager', { page: blocks.page, pages: blocks.pages, total: blocks.total, size: blocks.size, onChange: (p) => { blocks.page = p; loadBlocks(); } }),
              ] : [
                h('x-table', {
                  columns: [
                    { key: 'tx_id', title: '交易号' },
                    { key: 'txTypeCn', title: '类型', width: '140px' },
                    { key: 'biz_no', title: '业务单号', width: '170px' },
                    { key: 'block_index', title: '区块', width: '90px' },
                    { key: 'from_address', title: '发起地址' },
                    { key: 'gas_fee', title: '手续费', width: '90px', align: 'right' },
                    { key: 'created_at', title: '发起时间', width: '160px' },
                  ],
                  rows: txs.rows, loading: txs.loading,
                  rowClick: (r) => App.go('/explorer/tx/' + r.tx_id),
                }, {
                  'col-tx_id': ({ value }) => h('x-hash', { value, len: 18 }),
                  'col-txTypeCn': ({ row }) => h('x-tag', { dict: App.DICT.txType, dictKey: row.tx_type }),
                  'col-biz_no': ({ value }) => h('span', { class: 'mono' }, value || '-'),
                  'col-block_index': ({ value }) => h('x-chainbadge', { block: value }),
                  'col-from_address': ({ value }) => h('span', { class: 'mono tiny' }, App.fmt.addr(value)),
                  'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                }),
                h('x-pager', { page: txs.page, pages: txs.pages, total: txs.total, size: txs.size, onChange: (p) => { txs.page = p; loadTxs(); } }),
              ],
            ]),
          ],
        }),
      ]);
    },
  });

  /* ==================================================================
   * 二、区块详情
   * ================================================================== */
  const PageBlockDetail = defineComponent({
    name: 'page-block-detail',
    props: { index: String },
    setup(props) {
      const d = ref(null);
      const err = ref('');

      async function load() {
        try { d.value = await App.API.request('GET', '/chain/blocks/' + props.index, null, { noAuth: true }); err.value = ''; }
        catch (e) { err.value = e.message; }
      }
      onMounted(load);

      return () => h('div', {}, [
        h('x-page', { title: '区块详情 #' + props.index, desc: '区块头包含高度、时间戳、Merkle 根、前向哈希、难度与 nonce；区块体为若干笔链上交易。' }, {
          actions: () => [
            h('button', { class: 'btn sm', onClick: () => App.go('/explorer') }, '返回浏览器'),
            h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ],
          default: () => {
            if (err.value) return h('div', { class: 'alertbar err' }, [h('x-icon', { name: 'alert', size: 15 }), err.value]);
            if (!d.value) return h('div', { class: 'skel', style: 'height:280px' });
            const b = d.value.block, m = d.value.merkle;
            return [
              h('div', { class: 'flex gap-12 mb-16 wrap' }, [
                h('x-readout', { pass: d.value.hashMatch, label: '区块哈希现场重算比对', detail: d.value.hashMatch ? '记录值 = 重算值' : '记录值 ≠ 重算值' }),
                h('x-readout', { pass: m.rootMatches, label: 'Merkle 根与交易表比对', detail: m.rootMatches ? '一致' : '不一致' }),
                h('div', { class: 'readout pass' }, [
                  h('span', { class: 'flag' }, 'PoW'), h('span', { class: 'k' }, `难度 ${b.difficulty}`),
                  h('span', { class: 'mono', style: 'margin-left:auto;color:var(--tx-3)' }, '前导零 ' + '0'.repeat(b.difficulty)),
                ]),
              ]),

              h('div', { class: 'grid g-2-1 mb-16' }, [
                h('x-card', { title: '区块头' }, {
                  default: () => h('dl', { class: 'kv' }, [
                    h('dt', {}, '区块高度'), h('dd', { class: 'mono' }, String(b.index)),
                    h('dt', {}, '区块哈希'), h('dd', { class: 'hashbox' }, [h('b', {}, b.hash)]),
                    h('dt', {}, '前向哈希'), h('dd', { class: 'hashbox' }, App.fmt.short(b.prevHash, 30)),
                    h('dt', {}, 'Merkle 根'), h('dd', { class: 'hashbox' }, [h('b', {}, b.merkleRoot)]),
                    h('dt', {}, 'nonce'), h('dd', { class: 'mono' }, String(b.nonce)),
                    h('dt', {}, '难度'), h('dd', { class: 'mono' }, String(b.difficulty) + ' 个前导零'),
                    h('dt', {}, '出块耗时'), h('dd', { class: 'mono' }, b.mineTime + ' ms'),
                    h('dt', {}, '区块大小'), h('dd', { class: 'mono' }, App.fmt.bytes(b.sizeBytes)),
                    h('dt', {}, '交易数量'), h('dd', {}, b.txCount + ' 笔'),
                    h('dt', {}, '出块节点'), h('dd', { class: 'mono' }, b.miner),
                    h('dt', {}, '出块时间'), h('dd', {}, App.fmt.dt(b.blockTime)),
                  ]),
                }),
                h('x-card', { title: '完整性证明', sub: 'Merkle 树可从任一笔交易出发，用对数级的路径证明它确实属于本区块' }, {
                  default: () => h('div', {}, [
                    h('div', { class: 'tiny muted mb-8' }, '以区块内第 1 笔交易为例，其 Merkle 证明路径：'),
                    h('div', { class: 'col gap-6' }, m.samplePath.map((p, i) => h('div', { class: 'readout' }, [
                      h('span', { class: 'flag', style: 'background:rgba(245,165,36,.16);color:#fcd34d' }, 'L' + (i + 1)),
                      h('span', { class: 'k' }, p.position === 'left' ? '兄弟节点在左侧' : '兄弟节点在右侧'),
                      h('span', { class: 'mono tiny', style: 'margin-left:auto;color:var(--tx-3)' }, App.fmt.short(p.hash, 10)),
                    ]))),
                    h('div', { class: 'alertbar info mt-12' }, [
                      h('x-icon', { name: 'info', size: 15 }),
                      '验证一笔交易是否上链，不需要下载整条链，只需该交易的哈希 + 这条路径，逐层哈希上去能算出等于区块头中的 Merkle 根，即可证明"它确实在链上"。',
                    ]),
                  ]),
                }),
              ]),

              h('x-card', { title: `区块内交易（${d.value.transactions.length} 笔）`, flush: true }, {
                default: () => h('x-table', {
                  columns: [
                    { key: 'tx_id', title: '交易号' },
                    { key: 'txTypeCn', title: '类型', width: '140px' },
                    { key: 'biz_no', title: '业务单号', width: '170px' },
                    { key: 'from_address', title: '发起地址' },
                    { key: 'to_address', title: '接收地址' },
                    { key: 'gas_fee', title: '手续费', width: '90px', align: 'right' },
                    { key: 'created_at', title: '时间', width: '160px' },
                  ],
                  rows: d.value.transactions,
                  rowClick: (r) => App.go('/explorer/tx/' + r.tx_id),
                }, {
                  'col-tx_id': ({ value }) => h('x-hash', { value, len: 18 }),
                  'col-txTypeCn': ({ row }) => h('x-tag', { dict: App.DICT.txType, dictKey: row.tx_type }),
                  'col-biz_no': ({ value }) => h('span', { class: 'mono' }, value || '-'),
                  'col-from_address': ({ value }) => h('span', { class: 'mono tiny' }, App.fmt.addr(value)),
                  'col-to_address': ({ value }) => h('span', { class: 'mono tiny' }, App.fmt.addr(value)),
                  'col-created_at': ({ value }) => h('span', { class: 'tiny' }, App.fmt.dt(value)),
                }),
              }),
            ];
          },
        }),
      ]);
    },
  });

  /* ==================================================================
   * 三、交易详情
   * ================================================================== */
  const PageTxDetail = defineComponent({
    name: 'page-tx-detail',
    props: { txId: String },
    setup(props) {
      const d = ref(null);
      const err = ref('');
      async function load() {
        try { d.value = await App.API.request('GET', '/chain/tx/' + props.txId, null, { noAuth: true }); err.value = ''; }
        catch (e) { err.value = e.message; }
      }
      onMounted(load);

      return () => h('div', {}, [
        h('x-page', { title: '链上交易详情', desc: '每笔交易都携带发起方的 ECDSA 数字签名。验签通过说明：这笔存证确实由该主体的私钥签发，且内容一字未改。' }, {
          actions: () => [
            h('button', { class: 'btn sm', onClick: () => history.back() }, '返回'),
            h('button', { class: 'btn sm', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ],
          default: () => {
            if (err.value) return h('div', { class: 'alertbar err' }, [h('x-icon', { name: 'alert', size: 15 }), err.value]);
            if (!d.value) return h('div', { class: 'skel', style: 'height:300px' });
            const t = d.value.tx, v = d.value.verify, m = d.value.merkle;
            return [
              h('div', { class: 'flex gap-12 mb-16 wrap' }, [
                h('x-readout', { pass: v.signatureValid, label: 'ECDSA 数字签名验签', detail: v.signatureValid ? 'secp256k1 验签通过' : '验签失败' }),
                h('x-readout', { pass: v.payloadIntact, label: '业务数据摘要比对', detail: v.payloadIntact ? '快照哈希 = 声明哈希' : '数据已被篡改' }),
                m && h('x-readout', { pass: m.verified, label: 'Merkle 存在性证明', detail: m.verified ? '证明通过' : '证明失败' }),
              ]),

              h('div', { class: 'grid g-2-1 mb-16' }, [
                h('x-card', { title: '交易信息' }, {
                  default: () => h('dl', { class: 'kv' }, [
                    h('dt', {}, '交易号'), h('dd', { class: 'hashbox' }, [h('b', {}, t.txId)]),
                    h('dt', {}, '交易类型'), h('dd', {}, [h('x-tag', { dict: App.DICT.txType, dictKey: t.txType })]),
                    h('dt', {}, '业务单号'), h('dd', { class: 'mono' }, t.bizNo || '-'),
                    h('dt', {}, '所在区块'), h('dd', {}, [t.blockIndex !== null
                      ? h('x-chainbadge', { block: t.blockIndex, hash: d.value.block && d.value.block.hash, label: '点击复制区块哈希' })
                      : h('span', { class: 'tag t-warn' }, '待打包')]),
                    h('dt', {}, '发起地址'), h('dd', { class: 'mono' }, t.from),
                    h('dt', {}, '接收地址'), h('dd', { class: 'mono' }, t.to || '-'),
                    h('dt', {}, '业务数据摘要'), h('dd', { class: 'hashbox' }, t.payloadHash),
                    h('dt', {}, '交易序号 nonce'), h('dd', { class: 'mono' }, String(t.nonce)),
                    h('dt', {}, '存证手续费'), h('dd', { class: 'mono' }, t.fee + ' 碳积分'),
                    h('dt', {}, '发起时间'), h('dd', {}, App.fmt.dt(t.createdAt)),
                    h('dt', {}, '状态'), h('dd', {}, [h('x-tag', { text: t.status === 'CONFIRMED' ? '已确认' : '待打包', tone: t.status === 'CONFIRMED' ? 't-ok' : 't-warn' })]),
                  ]),
                }),
                h('x-card', { title: '数字签名' }, {
                  default: () => h('div', {}, [
                    h('div', { class: 'tiny muted mb-8' }, '签名算法：ECDSA over secp256k1，摘要算法 SHA-256'),
                    h('div', { class: 'hashbox mb-12' }, [h('b', {}, 'signature'), h('br'), t.signature || '（无签名）']),
                    h('div', { class: 'tiny muted mb-8' }, '发起方公钥（PEM，公钥可公开，私钥离线托管）'),
                    h('pre', { class: 'mono-pre', style: 'max-height:190px' }, t.pubKey || '-'),
                  ]),
                }),
              ]),

              h('div', { class: 'grid g2' }, [
                h('x-card', { title: '链上存证的业务数据快照', sub: '该快照参与 payloadHash 计算，只要业务数据被改动，摘要就对不上' }, {
                  default: () => h('pre', { class: 'mono-pre' }, JSON.stringify(d.value.payload, null, 2)),
                }),
                h('x-card', { title: '所在区块' }, {
                  default: () => d.value.block ? h('dl', { class: 'kv' }, [
                    h('dt', {}, '区块高度'), h('dd', {}, [h('x-chainbadge', { block: d.value.block.index })]),
                    h('dt', {}, '区块哈希'), h('dd', { class: 'hashbox' }, [h('b', {}, d.value.block.hash)]),
                    h('dt', {}, '前向哈希'), h('dd', { class: 'hashbox' }, App.fmt.short(d.value.block.prevHash, 30)),
                    h('dt', {}, 'Merkle 根'), h('dd', { class: 'hashbox' }, d.value.block.merkleRoot),
                    h('dt', {}, 'nonce / 难度'), h('dd', { class: 'mono' }, `${d.value.block.nonce} / ${d.value.block.difficulty}`),
                    h('dt', {}, '出块时间'), h('dd', {}, App.fmt.dt(d.value.block.blockTime)),
                    h('dt', {}, '出块节点'), h('dd', { class: 'mono' }, d.value.block.miner),
                  ]) : h('div', { class: 'empty' }, '该交易仍在交易池中，尚未被打包'),
                }),
              ]),
            ];
          },
        }),
      ]);
    },
  });

  /* ==================================================================
   * 四、公告详情（公众）
   * ================================================================== */
  const PageNotice = defineComponent({
    name: 'page-notice',
    props: { id: String },
    setup(props) {
      const n = ref(null);
      async function load() {
        try { n.value = await App.API.request('GET', '/public/notices/' + props.id, null, { noAuth: true }); }
        catch (e) { App.notify.err(e.message); }
      }
      onMounted(load);
      return () => h('div', { style: 'max-width:900px;margin:0 auto' }, [
        h('x-page', { title: '通知公告', desc: '平台政策法规、市场公告与系统通知的公开查阅入口' }, {
          actions: () => h('button', { class: 'btn sm', onClick: () => App.go('/screen') }, '返回大屏'),
          default: () => {
            if (!n.value) return h('div', { class: 'skel', style: 'height:240px' });
            return h('x-card', {}, {
              default: () => h('div', {}, [
                h('div', { class: 'flex gap-8 mb-12' }, [
                  h('x-tag', { dict: App.DICT.noticeType, dictKey: n.value.notice_type }),
                  n.value.is_top ? h('span', { class: 'tag t-danger' }, '置顶') : null,
                ]),
                h('h3', { style: 'font-size:19px;line-height:1.6' }, n.value.title),
                h('div', { class: 'tiny dim mt-8' }, `${n.value.publisher || '平台'} · ${App.fmt.dt(n.value.publish_time)} · 浏览 ${n.value.views}`),
                h('div', { class: 'alertbar info mt-16' }, [
                  h('x-icon', { name: 'info', size: 15 }),
                  '本公告由监管端发布，发布记录同步写入操作审计日志。',
                ]),
                h('pre', { class: 'mono-pre mt-16', style: 'max-height:none;font-family:var(--sans);font-size:13.4px;color:var(--tx-1)' }, n.value.content),
              ]),
            });
          },
        }),
      ]);
    },
  });

  Object.assign(App.views, {
    'page-explorer': PageExplorer,
    'page-block-detail': PageBlockDetail,
    'page-tx-detail': PageTxDetail,
    'page-notice': PageNotice,
  });
})();
