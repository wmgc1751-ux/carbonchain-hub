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

      /* ── 碳资产存证：批次级存证记录 / 产品数字护照 DPP / 穿透式验真 ── */
      const allBatches = App.Industry.batches;
      const dppRef = ref(null);     // 当前打开 DPP 的批次
      const proofRef = ref(null);   // 当前打开穿透式验真的批次
      const kwBatch = ref('');
      const batchStatusCn = { CERTIFIED: '已第三方核证', PENDING: '待核查机构核证', BLOCKED: '物料平衡异常·已阻断' };
      const batchStatusCls = { CERTIFIED: 'ok', PENDING: 'warn', BLOCKED: 'err' };
      const filteredBatches = computed(() => {
        const k = (kwBatch.value || '').trim().toLowerCase();
        if (!k) return allBatches;
        return allBatches.filter((b) =>
          (b.batchNo + b.product + b.entName + b.deviceDid + b.txHash + b.verifierName).toLowerCase().indexOf(k) >= 0);
      });
      const batchStat = computed(() => ({
        total: allBatches.length,
        tco2e: allBatches.reduce((s, b) => s + b.totalTco2e, 0),
        certified: allBatches.filter((b) => b.status === 'CERTIFIED').length,
      }));
      const dppQR = computed(() => (dppRef.value ? App.Industry.qrMatrix(dppRef.value.dppNo + '|' + dppRef.value.txHash, 29) : null));
      const pipeline = computed(() => (proofRef.value ? App.Industry.tracePipeline(proofRef.value) : null));
      function openDpp(b) { dppRef.value = b; }
      function openProof(b) { proofRef.value = b; }

      /** 前端生成防伪二维码点阵（SVG，无外部依赖） */
      function qrSvg(matrix, size) {
        if (!matrix) return null;
        const n = matrix.length;
        const cells = [];
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          if (matrix[y][x]) cells.push(h('rect', { key: y + '-' + x, x, y, width: 1, height: 1 }));
        }
        return h('svg', {
          class: 'qr', viewBox: '0 0 ' + n + ' ' + n, width: size || 138, height: size || 138,
          fill: '#0b1018', shapeRendering: 'crispEdges',
        }, [h('rect', { x: 0, y: 0, width: n, height: n, fill: '#ffffff' })].concat(cells));
      }

      /* ------------------------------------------------------------------
       * 产品数字护照（DPP）—— 面向欧盟新电池法案 / CBAM 的交付物
       * ------------------------------------------------------------------ */
      function renderDpp() {
        const b = dppRef.value;
        if (!b) return null;
        const dev = b.device || {};
        return h('x-modal', {
          modelValue: true, title: '产品数字护照（Digital Product Passport）', width: '900px',
          'onUpdate:modelValue': (v) => { if (!v) dppRef.value = null; },
        }, {
          default: () => h('div', { class: 'dpp' }, [
            /* 护照头 */
            h('div', { class: 'dpp-head' }, [
              h('div', {}, [
                h('div', { class: 'tiny dim' }, '数字护照编号 / DPP ID'),
                h('div', { class: 'mono', style: 'font-size:15px;color:var(--chain-l)' }, b.dppNo),
                h('div', { class: 'tiny dim mt-8' }, '申报口径：欧盟新电池法案 (EU) 2023/1542 · CBAM (EU) 2023/956 · ISO 14067'),
                h('div', { class: 'tiny dim' }, '签发主体：' + b.entName + '（链上钱包已实名映射）'),
              ]),
              h('div', { class: 'dpp-qr' }, [
                qrSvg(dppQR.value, 132),
                h('div', { class: 'tiny dim', style: 'text-align:center;margin-top:6px' }, '扫码验真 · 链上核验入口'),
              ]),
            ]),

            h('div', { class: 'alertbar ok mb-16' }, [
              h('x-icon', { name: 'check', size: 15 }),
              '本护照数据由边缘设备国密签名后上链，第三方核查机构节点（' + b.verifierName + '）已使用其私钥签名背书，任何人可凭该机构公钥独立验证。',
            ]),

            /* 产品与批次信息 */
            h('div', { class: 'grid g2 mb-16' }, [
              h('x-card', { title: '产品与批次', tight: true }, {
                default: () => h('dl', { class: 'kv', style: 'grid-template-columns:104px 1fr' }, [
                  h('dt', {}, '批次编号'), h('dd', { class: 'mono' }, b.batchNo),
                  h('dt', {}, '产品名称'), h('dd', {}, b.product),
                  h('dt', {}, '规格型号'), h('dd', {}, b.spec),
                  h('dt', {}, '生产产线'), h('dd', {}, b.line),
                  h('dt', {}, '批次产量'), h('dd', { class: 'mono' }, App.fmt.num(b.qty, 2) + ' ' + b.unit),
                  h('dt', {}, '生产企业'), h('dd', {}, b.entName + '（' + b.industry + ' · ' + b.region + '）'),
                ]),
              }),
              h('x-card', { title: '碳足迹核算结果', tight: true }, {
                default: () => h('div', {}, [
                  h('div', { class: 'res-big' }, [
                    h('span', { class: 'mono' }, App.fmt.num(b.totalTco2e, 2)),
                    h('span', { class: 'unit' }, 'tCO₂e'),
                  ]),
                  h('div', { class: 'tiny dim mb-12' }, '批次碳足迹总量（ISO 14067 产品碳足迹口径）'),
                  h('dl', { class: 'kv', style: 'grid-template-columns:110px 1fr' }, [
                    h('dt', {}, '单位产品强度'), h('dd', { class: 'mono' }, b.intensity.toFixed(4) + ' tCO₂e/' + b.unit),
                    h('dt', {}, '范围一 直接排放'), h('dd', { class: 'mono' }, App.fmt.num(b.scope1, 2) + ' tCO₂e'),
                    h('dt', {}, '范围二 间接排放'), h('dd', { class: 'mono' }, App.fmt.num(b.scope2, 2) + ' tCO₂e'),
                    h('dt', {}, '电网因子'), h('dd', { class: 'mono' }, App.Industry.oracle.baseline.toFixed(4) + ' kgCO₂/kWh'),
                  ]),
                ]),
              }),
            ]),

            /* BOM 碳排放构成 */
            h('x-card', { title: 'BOM 碳排放构成（工序级分摊）', sub: '用于 CBAM 申报的嵌入式排放明细', class: 'mb-16', tight: true }, {
              default: () => h('div', {}, [
                h('x-bars', {
                  items: App.Industry.bomBars(b), valueKey: 'value', labelKey: 'name',
                  format: (v, it) => App.fmt.num(v, 2) + ' t  (' + (it.share * 100).toFixed(1) + '%)',
                }),
                h('div', { class: 'bom-table mt-12' }, b.bom.stages.map((st) => h('div', { class: 'bom-line' }, [
                  h('span', { class: 'bl-name' }, st.name),
                  h('span', { class: 'bl-share mono' }, (st.share * 100).toFixed(1) + '%'),
                  h('span', { class: 'bl-val mono' }, App.fmt.num(st.tco2e, 2) + ' tCO₂e'),
                ]))),
              ]),
            }),

            /* 签名与存证 */
            h('div', { class: 'grid g2' }, [
              h('x-card', { title: '第三方核查节点公钥签名', tight: true }, {
                default: () => h('dl', { class: 'kv', style: 'grid-template-columns:110px 1fr' }, [
                  h('dt', {}, '核查机构'), h('dd', {}, b.verifierName),
                  h('dt', {}, '节点标识'), h('dd', { class: 'mono' }, b.verifierNode),
                  h('dt', {}, '资质编号'), h('dd', { class: 'mono' }, b.verifierCert),
                  h('dt', {}, '公钥指纹'), h('dd', { class: 'mono', style: 'font-size:11.6px' }, b.verifierPub),
                  h('dt', {}, '签名算法'), h('dd', { class: 'mono' }, 'ECDSA / secp256k1 + SHA-256'),
                  h('dt', {}, '签名值'), h('dd', { class: 'hashbox' }, b.signature),
                ]),
              }),
              h('x-card', { title: '链上存证锚点', tight: true }, {
                default: () => h('dl', { class: 'kv', style: 'grid-template-columns:110px 1fr' }, [
                  h('dt', {}, '交易哈希'), h('dd', { class: 'hashbox' }, [h('b', {}, b.txHash)]),
                  h('dt', {}, '区块高度'), h('dd', { class: 'mono' }, '#' + b.blockHeight),
                  h('dt', {}, '区块哈希'), h('dd', { class: 'hashbox' }, b.blockHash),
                  h('dt', {}, '业务数据摘要'), h('dd', { class: 'hashbox' }, b.payloadHash),
                  h('dt', {}, '共识节点'), h('dd', { class: 'mono', style: 'font-size:11.6px' }, b.consensusNodes.join(' · ')),
                  h('dt', {}, '共识时间戳'), h('dd', { class: 'mono' }, App.fmt.dt(b.consensusAt)),
                  h('dt', {}, '边缘设备 DID'), h('dd', { class: 'mono', style: 'font-size:11.6px' }, b.deviceDid + (dev.chip ? '（' + dev.chip + ' · ' + dev.alg + '）' : '')),
                ]),
              }),
            ]),
          ]),
          footer: () => [
            h('button', { class: 'btn', onClick: () => { dppRef.value = null; } }, '关闭'),
            h('button', { class: 'btn', onClick: () => App.notify.info('数字护照为链上数据的可核验呈现，导出功能对接 CBAM 申报模板（演示环境不落盘）。') }, [h('x-icon', { name: 'download', size: 15 }), '导出申报包']),
            h('button', { class: 'btn chain', onClick: () => { dppRef.value = null; proofRef.value = b; } }, [h('x-icon', { name: 'search', size: 15 }), '穿透式验真']),
          ],
        });
      }

      /* ------------------------------------------------------------------
       * 穿透式公钥验真 —— 源端到链上四段流水线
       * ------------------------------------------------------------------ */
      function renderProof() {
        const b = proofRef.value;
        if (!b) return null;
        const steps = pipeline.value || [];
        const blocked = b.status === 'BLOCKED';
        return h('x-modal', {
          modelValue: true, title: '穿透式公钥验真 · ' + b.batchNo, width: '960px',
          'onUpdate:modelValue': (v) => { if (!v) proofRef.value = null; },
        }, {
          default: () => h('div', {}, [
            h('x-readout', {
              pass: !blocked,
              label: blocked
                ? '验真未通过 —— 物料平衡异常，该批次已被边缘侧阻断上链'
                : '第三方认证机构公钥匹配通过，数据自物理源端至链上全程防篡改',
              detail: blocked ? '等待人工核查能源计量台账后重放' : '公钥指纹 ' + b.verifierPub.slice(0, 18) + '…',
            }),

            h('div', { class: 'trace-flow mt-16' }, steps.flatMap((st, i) => {
              const card = h('div', { class: ['trace-step', st.ok ? 'ok' : 'bad'] }, [
                h('div', { class: 'ts-head' }, [
                  h('span', { class: 'ts-stage' }, st.stage),
                  h('span', { class: 'ts-ico' }, [h('x-icon', { name: st.icon, size: 14 })]),
                  h('span', { class: 'ts-key' }, st.key),
                ]),
                h('div', { class: 'ts-title' }, st.title),
                h('div', { class: 'ts-sub tiny dim' }, st.sub),
                h('dl', { class: 'kv ts-kv' }, st.detail.flatMap((dd) => [
                  h('dt', {}, dd.k),
                  h('dd', { class: 'mono' }, dd.v),
                ])),
                h('div', { class: 'ts-frame' }, [
                  h('div', { class: 'tiny dim' }, '原始数据 / 中间产物'),
                  h('pre', { class: 'mono-pre' }, st.frame),
                ]),
                h('div', { class: 'ts-seal' }, [
                  h('i', { class: ['ind-lamp', st.ok ? 'NORMAL' : 'ANOMALY'], style: 'width:7px;height:7px' }),
                  h('span', { class: 'tiny' }, st.ok ? '校验通过' : '校验失败'),
                ]),
              ]);
              return i < steps.length - 1 ? [card, h('i', { class: 'ts-arrow' }, '→')] : [card];
            })),

            h('div', { class: 'alertbar ok mt-16' }, [
              h('x-icon', { name: 'shield', size: 16 }),
              h('div', {}, [
                h('b', {}, '第三方认证机构公钥匹配通过，数据自物理源端至链上全程防篡改。'),
                h('div', { class: 'tiny mt-8' }, '验证路径：用 ' + b.verifierName + ' 的公开公钥（指纹 ' + b.verifierPub.slice(0, 24) + '…）解开链上签名 → 得到合约核算结果摘要 → 与链上 payloadHash 比对一致 → 该摘要又由设备 TEE 内的国密私钥签名，而设备私钥不可导出。因此任何环节（报文、核算、存证）被改动，验真都会失败。'),
              ]),
            ]),

            h('div', { class: 'flex gap-8 mt-16 wrap' }, [
              h('button', { class: 'btn sm', onClick: () => App.copyText(b.txHash) }, [h('x-icon', { name: 'copy', size: 14 }), '复制 TxHash']),
              h('button', { class: 'btn sm', onClick: () => App.copyText(b.verifierPub) }, [h('x-icon', { name: 'key', size: 14 }), '复制核查机构公钥']),
              h('button', { class: 'btn sm chain', onClick: () => { proofRef.value = null; App.go('/explorer/tx/' + b.txHash); } }, [h('x-icon', { name: 'block', size: 14 }), '在浏览器中查看该交易']),
            ]),
          ]),
          footer: () => [
            h('button', { class: 'btn', onClick: () => { proofRef.value = null; } }, '关闭'),
            h('button', { class: 'btn chain', onClick: () => { proofRef.value = null; dppRef.value = b; } }, [h('x-icon', { name: 'report', size: 15 }), '查看数字护照']),
          ],
        });
      }

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
          App.notify.ok(`已重算 ${r.repaired.length} 个区块的哈希并按共识重新出块（耗时 ${r.repaired.reduce((a, b) => a + b.cost, 0)}ms）`);
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
          ? { cls: 'ok', text: `全链完整性校验通过 —— 已校验 ${validation.value.checkedBlocks} 个区块，哈希链、PoA 出块签名、Merkle 根全部一致` }
          : { cls: 'err', text: `全链校验失败 —— 发现 ${validation.value.errorCount} 处异常，链上数据已被篡改或存在未授权节点出块` };
      });

      return () => h('div', {}, [
        h('x-page', {
          title: '区块链浏览器',
          desc: '平台所有关键业务动作（排放上报 / 核查结论 / 配额分配 / 碳信用签发）均以存证交易写入区块链。本页面对公众开放，任何人可独立核验链上数据。',
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
              h('x-kpi', { label: '共识机制', value: stats.value.consensusMode || 'PoA', icon: 'shield', tone: 'violet', foot: '联盟授权节点轮值出块' }),
              h('x-kpi', { label: '链上数据量', value: App.fmt.bytes(stats.value.totalSize), icon: 'db', tone: 'sky', foot: `${stats.value.totalTxInBlocks} 笔交易` }),
              h('x-kpi', { label: '联盟节点', value: stats.value.activeNodes != null ? stats.value.activeNodes : '-', unit: '个', icon: 'factory', tone: 'carbon', foot: '已获出块授权' }),
              h('x-kpi', { label: 'PoA 区块', value: App.fmt.num(stats.value.poaBlocks != null ? stats.value.poaBlocks : stats.value.totalBlocks), icon: 'chain', tone: 'chain', foot: '无挖矿·即出即确认' }),
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
                      h('option', { value: 'nonce' }, 'nonce（出块序号 / 随机数）'),
                      h('option', { value: 'block_time' }, 'block_time（出块时间）'),
                    ]),
                  ]),
                  h('button', { class: 'btn danger', disabled: busy.value, onClick: doTamper }, [
                    h('x-icon', { name: 'alert', size: 15 }), busy.value ? '处理中…' : '模拟恶意篡改',
                  ]),
                  panel.value && h('button', { class: 'btn chain', disabled: busy.value, onClick: doRepair }, [
                    h('x-icon', { name: 'refresh', size: 15 }), '按共识重新出块并修复',
                  ]),
                ]),

                panel.value && h('div', { class: 'mt-16' }, [
                  h('div', { class: 'hashbox mb-12' }, [
                    h('b', {}, panel.value.kind === 'tamper' ? '篡改操作记录' : '修复操作记录'), h('br'),
                    panel.value.kind === 'tamper'
                      ? `区块 #${panel.value.data.blockIndex} · 字段 ${panel.value.data.field}\n原值：${String(panel.value.data.before).slice(0, 72)}\n新值：${String(panel.value.data.after).slice(0, 72)}`
                      : `从区块 #${panel.value.data.fromIndex} 起重算 ${panel.value.data.repaired.length} 个区块哈希并重新完成 PoA 出块签名`,
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
                      ? '攻击者可以改掉自己机器上的数据库，但改完之后：① 本区块哈希对不上；② 后一个区块的 prevHash 指不过来；③ Merkle 根与交易表不一致；④ 出块节点的 PoA 签名验不过。只要联盟中有一个诚实的成员节点持有一份未被篡改的副本，这次篡改就会被全网发现。'
                      : '要让篡改后的链"看起来正常"，攻击者必须从被改动的区块开始重算后面每一个区块的哈希，并重新伪造每个区块出块节点（联盟授权成员）的私钥签名 —— 而出块私钥分散在各成员机构手中，单一攻击者无法伪造。这就是"许可制 + 多副本"的治理威慑。'),
                  ]),
                ]),

                !panel.value && h('div', { class: 'alertbar info mt-16' }, [
                  h('x-icon', { name: 'info', size: 15 }),
                  '提示：实验完成后请点击"按共识重新出块并修复"，把链恢复到可信状态。',
                ]),
              ]),
            }),

            /* ==================================================================
               碳资产存证记录（批次级）· 产品数字护照 DPP · 穿透式验真
               ================================================================== */
            h('div', { class: 'sect-head' }, [
              h('span', { class: 'no' }, '03'),
              h('div', {}, [
                h('h3', {}, '碳资产存证记录与产品数字护照（DPP）'),
                h('p', {}, '每一批产品从「物理计量 → 边缘国密签名 → 合约动态核算 → 多节点共识」全链条留痕。此处的存证记录同时是生成欧盟新电池法案 / CBAM 碳关税申报所需产品数字护照的数据底座。'),
              ]),
            ]),

            h('x-card', {
              title: '存证记录（批次级）',
              sub: `共 ${batchStat.value.total} 个批次 · 累计核算碳足迹 ${App.fmt.num(Math.round(batchStat.value.tco2e))} tCO₂e · 已第三方核证 ${batchStat.value.certified} 个`,
              class: 'mb-16',
            }, {
              actions: () => h('div', { class: 'input-group', style: 'width:300px' }, [
                h('input', {
                  class: 'input', placeholder: '搜索批次 / 产品 / 企业 / DID / TxHash', value: kwBatch.value,
                  onInput: (e) => { kwBatch.value = e.target.value; },
                }),
                h('button', { class: 'btn', onClick: () => { kwBatch.value = ''; } }, [h('x-icon', { name: 'close', size: 14 })]),
              ]),
              default: () => h('div', { class: 'tbl-wrap', style: 'max-height:520px;overflow:auto' }, [
                h('table', { class: 'tbl' }, [
                  h('thead', {}, h('tr', {}, ['批次编号', '产品 / 企业', '核算碳足迹总量', '边缘设备 DID', '交易哈希 TxHash', '区块高度', '共识时间戳', '交付操作'].map((t) => h('th', {}, t)))),
                  h('tbody', {}, filteredBatches.value.map((b) => h('tr', {}, [
                    h('td', {}, [
                      h('div', { class: 'mono nowrap', style: 'font-size:12px;color:var(--chain-l);cursor:copy', title: '点击复制批次编号', onClick: () => App.copyText(b.batchNo) }, b.batchNo),
                      h('div', { class: 'tiny dim nowrap' }, b.dppNo),
                    ]),
                    h('td', {}, [
                      h('div', { class: 'nowrap', style: 'font-size:12.6px;color:var(--tx-0)' }, b.product),
                      h('div', { class: 'tiny dim nowrap' }, b.entShort + ' · ' + b.industry),
                      h('div', { class: 'mt-4' }, h('span', { class: ['tag', batchStatusCls[b.status]] }, batchStatusCn[b.status])),
                    ]),
                    h('td', { class: 'nowrap' }, [
                      h('div', { class: 'mono', style: 'color:var(--tx-0)' }, App.fmt.num(b.totalTco2e, 2) + ' tCO₂e'),
                      h('div', { class: 'tiny dim mono' }, b.intensity.toFixed(4) + ' tCO₂e/' + b.unit),
                    ]),
                    h('td', {}, [
                      h('div', { class: 'did mono', title: '点击复制 DID', onClick: () => App.copyText(b.deviceDid) }, b.deviceDid),
                      h('div', { class: 'tiny dim nowrap' }, (b.device ? b.device.chipCn + ' · ' + b.device.alg : '边缘签名已固化')),
                    ]),
                    h('td', {}, [
                      h('x-hash', { value: b.txHash, len: 16 }),
                      h('div', { class: 'tiny dim mono nowrap' }, 'payload ' + App.fmt.short(b.payloadHash, 6)),
                    ]),
                    h('td', {}, h('x-chainbadge', { block: b.blockHeight, hash: b.blockHash, label: '点击复制区块哈希' })),
                    h('td', { class: 'tiny mono nowrap' }, App.fmt.dt(b.consensusAt)),
                    h('td', {}, [
                      h('button', { class: 'btn xs chain', onClick: () => openDpp(b) }, [h('x-icon', { name: 'report', size: 12 }), '数字护照']),
                      h('button', { class: 'btn xs', style: 'margin-top:5px', onClick: () => openProof(b) }, [h('x-icon', { name: 'search', size: 12 }), '穿透式验真']),
                    ]),
                  ]))),
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
                  class: 'tbl-blocks',
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
                  class: 'tbl-txs',
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
        renderDpp(),
        renderProof(),
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
                  h('span', { class: 'flag' }, b.consensus || 'PoA'), h('span', { class: 'k' }, `出块节点 ${b.proposer || b.miner || '-'}`),
                  h('span', { class: 'mono', style: 'margin-left:auto;color:var(--tx-3)' }, d.value.proposerSigValid === false ? '出块签名验签失败' : 'PoA 出块签名有效'),
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
                    h('dt', {}, '共识 / 出块节点'), h('dd', { class: 'mono' }, (b.consensus || 'PoA') + ' / ' + (b.proposer || b.miner || '-')),
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
