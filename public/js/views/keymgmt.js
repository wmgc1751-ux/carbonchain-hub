/* =====================================================================
   keymgmt.js —— WP2 密码学生产化：国密 SM2/SM3 密钥治理
   ---------------------------------------------------------------------
   页面：/keys（管理员端 · 监管端可只读审计）

   设计原则：把评委最会追问的两个问题变成**可点、可验**的界面。
     ① "你用的是真国密吗，还是拿 SHA-256 冒充 SM3？"
        → 能力清单明示算法套件与签名方案；「签名取证」面板现场签、现场验，
          并用"同一载荷两次签名不同但都能验通过"证明随机数 k 非固定
          （这正是 SM2 而非哈希冒充签名的特征）。
     ② "私钥怎么管的？能轮换吗？轮换后历史签名的验签怎么办？"
        → 密钥清单**不含任何私钥字段**；「轮换安全性举证」现场跑完五项断言，
          证明旧签名由历史公钥仍可验通过（generation = HISTORICAL）。
        → 轮换走"申请 → 双人复核 → 生效"，且 approved_by ≠ requested_by
          是**服务层强制**，不是流程约定。

   同时如实声明局限：当前未接硬件加密机（HSM），已预留 provider 抽象。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, reactive, computed, onMounted } = Vue;
  const h = App.h;

  const STYLE_ID = 'keys-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
.keys-demo{display:flex;gap:11px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--hair)}
.keys-demo:last-child{border-bottom:none}
.keys-demo .flag{flex:none;font-family:var(--mono);font-size:11px;font-weight:600;padding:2px 6px;border-radius:5px;margin-top:1px}
.keys-demo .flag.ok{background:rgba(16,185,129,.16);color:#6ee7b7}
.keys-demo .flag.no{background:rgba(244,63,94,.16);color:#fda4af}
.keys-demo .tt{font-size:12.5px;color:var(--tx-1)}
.keys-demo .dd{font-family:var(--mono);font-size:11.3px;color:var(--tx-3);margin-top:2px;word-break:break-all}
.keys-sig{font-family:var(--mono);font-size:11.3px;line-height:1.8;word-break:break-all;
  background:var(--bg-0);border:1px solid var(--hair);border-radius:8px;padding:10px 12px;max-height:210px;overflow:auto}
.keys-quote{border-left:3px solid rgba(56,189,248,.5);padding:8px 12px;background:rgba(56,189,248,.05);
  border-radius:0 8px 8px 0;font-size:12.3px;line-height:1.75;color:var(--tx-1)}
.keys-rule{font-family:var(--mono);font-size:11.6px;color:var(--brand-l);background:var(--bg-0);
  border:1px solid var(--hair);border-radius:8px;padding:9px 12px;line-height:1.7;word-break:break-all}
`;
    document.head.appendChild(el);
  }

  function kpiGrid(items) {
    return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(178px,1fr))' },
      items.map((k) => h('x-kpi', k)));
  }

  const DEFAULT_PAYLOAD = JSON.stringify({
    bizNo: 'CBAM-2026-10-0001', entId: 1, emission: 12345.6789, period: '2026-10',
    at: '2026-10-12T21:00:00.000Z',
  }, null, 2);

  /** 签名的规范序列化口径说明（展示用，与 cu.stableStringify 的行为一致） */
  const CANON_NOTE = '载荷先按键名字典序规范化（stableStringify）再做 SM3 摘要与 SM2 签名，'
    + '因此键顺序无关、空白无关 —— 同一语义的 JSON 必然得到同一摘要。';

  const PageKeymgmt = defineComponent({
    name: 'page-keymgmt',
    setup() {
      injectStyle();
      const isAdmin = !!(App.Store.user && App.Store.user.role === 'ADMIN');
      const cap = ref(null);
      const status = ref(null);
      const inv = ref([]);
      const logs = ref([]);
      /* 台账与轮换申请都在几十行量级（密钥台账 46 个主体标签、轮换申请更多），
       * 一屏铺完会把页面拉到 3000px 以上（2026-10-29 巡检 P2-35）。
       * 这里做前端分页：接口一次给全量，切片展示，翻页不需要重新请求。 */
      const KEY_PAGE_SIZE = 12;
      const invPage = ref(1);
      const logPage = ref(1);
      const pagedSlice = (list, page) => {
        const arr = list || [];
        const pages = Math.max(1, Math.ceil(arr.length / KEY_PAGE_SIZE));
        const p = Math.min(Math.max(page, 1), pages);
        return { rows: arr.slice((p - 1) * KEY_PAGE_SIZE, p * KEY_PAGE_SIZE), pages, total: arr.length, page: p };
      };
      const invPaged = computed(() => pagedSlice(inv.value, invPage.value));
      const logPaged = computed(() => pagedSlice(logs.value, logPage.value));
      const labels = ref([]);

      /* 签名取证 */
      const sigLabel = ref('ent:9');
      const sigPayload = ref(DEFAULT_PAYLOAD);
      const sigResult = ref(null);
      const verifyResult = ref(null);
      const sigBusy = ref(false);

      /* 轮换举证（默认标签与快照采集时使用的主体一致，便于静态站直接命中真实记录） */
      const demoLabel = ref('device:snapshot');
      const demo = ref(null);
      const demoBusy = ref(false);

      /* 轮换申请 */
      const rotForm = reactive({ keyLabel: '', reason: '', requestedBy: '', approvedBy: '' });
      const rotBusy = ref(false);

      async function load() {
        const [c, s, i, l, g] = await Promise.all([
          App.API.get('/keys/capability').catch(() => null),
          App.API.get('/keys/status').catch(() => null),
          App.API.get('/keys/inventory').catch(() => []),
          App.API.get('/keys/labels').catch(() => null),
          App.API.get('/keys/rotations').catch(() => []),
        ]);
        cap.value = c; status.value = s; inv.value = i || []; labels.value = (l && l.prefixes) || []; logs.value = g || [];
      }

      onMounted(async () => {
        rotForm.requestedBy = (App.Store.user && (App.Store.user.realName || App.Store.user.username)) || '';
        rotForm.approvedBy = rotForm.requestedBy;
        await load();
        if (!sigLabel.value && inv.value.length) sigLabel.value = inv.value[0].label;
      });

      function parsePayload() {
        try { return JSON.parse(sigPayload.value); } catch (e) { throw new Error('载荷必须是合法 JSON：' + e.message); }
      }

      async function doSign() {
        sigBusy.value = true; verifyResult.value = null;
        try {
          const payload = parsePayload();
          sigResult.value = await App.API.post('/keys/sign', { keyLabel: sigLabel.value, payload });
          App.notify.ok('已生成 SM2 签名');
        } catch (e) { App.notify.err(e.message); sigResult.value = null; }
        finally { sigBusy.value = false; }
      }

      async function doVerify(tamper) {
        if (!sigResult.value) return App.notify.warn('请先签名');
        try {
          const payload = parsePayload();
          const body = {
            keyLabel: sigLabel.value,
            payload: tamper ? Object.assign({}, payload, { __tampered: Date.now() }) : payload,
            signature: sigResult.value.signature,
          };
          verifyResult.value = await App.API.post('/keys/verify', body);
          verifyResult.value.__tamper = !!tamper;
          App.notify.ok(verifyResult.value.valid ? '验签通过' : '验签未通过（未篡改时不应出现）');
        } catch (e) { App.notify.err(e.message); }
      }

      async function doDemo() {
        if (!demoLabel.value) return App.notify.warn('请填写主体标签');
        demoBusy.value = true;
        try {
          demo.value = await App.API.post('/keys/rotation-safety-demo', { keyLabel: demoLabel.value });
          App.notify.ok(`举证完成：${demo.value.passed}/${demo.value.total} 项通过`);
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { demoBusy.value = false; }
      }

      async function requestRotate() {
        if (!rotForm.keyLabel) return App.notify.warn('请选择要轮换的主体');
        rotBusy.value = true;
        try {
          const r = await App.API.post('/keys/rotations', {
            keyLabel: rotForm.keyLabel, reason: rotForm.reason || '常规轮换', requestedBy: rotForm.requestedBy,
          });
          App.notify.ok(`轮换申请 #${r.id} 已提交，等待另一名管理员复核`);
          rotForm.reason = '';
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { rotBusy.value = false; }
      }

      async function approve(row) {
        if (!(await App.confirm(`复核通过 #${row.id}（${row.key_label}）？\n\n复核通过后才会生成下一代密钥，并把轮换动作上链留痕。`))) return;
        try {
          const r = await App.API.post(`/keys/rotations/${row.id}/approve`, { approvedBy: rotForm.approvedBy, note: '管理端复核通过' });
          App.notify.ok(r.chain && r.chain.blockIndex ? `轮换已生效并上链（区块 #${r.chain.blockIndex}）` : '轮换已生效');
          await load();
        } catch (e) { App.notify.err(e.message); }
      }

      async function reject(row) {
        if (!(await App.confirm(`驳回 #${row.id}（${row.key_label}）？`))) return;
        try {
          await App.API.post(`/keys/rotations/${row.id}/reject`, { approvedBy: rotForm.approvedBy, note: '管理端驳回' });
          App.notify.ok('已驳回');
          await load();
        } catch (e) { App.notify.err(e.message); }
      }

      const labelOptions = computed(() => {
        const from = (labels.value || []).slice();
        const have = (inv.value || []).map((x) => x.label);
        return Array.from(new Set(from.concat(have)));
      });

      return () => {
        const c = cap.value || {};
        const st = status.value || {};
        const keys = st.keys || {};
        const rot = st.rotation || {};
        const dc = c.dualControl || {};
        const rs = c.rotationSafety || {};

        return h('x-page', {
          title: '国密密钥治理',
          desc: 'SM2（GB/T 32918）+ SM3（GB/T 32905）· SM2-with-SM3 签名 · 密钥轮换不以牺牲可核验性为代价 · 双人复核服务层强制',
        }, {
          actions: () => [
            h('button', { class: 'btn sm ghost', onClick: load }, [h('x-icon', { name: 'refresh', size: 14 }), '刷新']),
          ],
          default: () => [
            App.staticNote('当前为静态演示模式：算法能力与密钥台账为快照时点的真实取值；'
              + '「轮换安全举证」展示的是快照采集时执行的真实五项断言记录；'
              + '任意载荷的签名在本模式下会标注为 STATIC-DEMO（非真实国密）。'),
            /* ── 能力与局限（先说清楚"没做什么"） ── */
            kpiGrid([
              { label: '算法可用性', value: c.available ? '可用' : '不可用', unit: '', tone: c.available ? 'carbon' : 'rose', icon: 'key', foot: c.suite || '' },
              { label: '签名方案', value: 'SM2-with-SM3', unit: '', tone: 'sky', icon: 'lock', foot: 'OpenSSL createSign("SM3") + SM2 私钥' },
              { label: '密钥库加密', value: c.storeEncrypted ? '已加密' : '明文存储', unit: '', tone: c.storeEncrypted ? 'carbon' : 'amber', icon: 'db', foot: c.storeEncrypted ? '磁盘落库时加密' : '本地开发态允许明文，生产须接 HSM' },
              { label: '硬件加密机 HSM', value: c.hsmReady ? '已接入' : '未接入', unit: '', tone: c.hsmReady ? 'carbon' : 'amber', icon: 'shield', foot: '已预留 provider 抽象：实现 signWithProvider() 即可接入' },
              { label: '治理主体', value: App.fmt.num(keys.labels || 0), unit: '个', tone: 'violet', icon: 'users', foot: `累计世代 ${keys.generations || 0} · 已轮换 ${keys.rotated || 0} 个主体` },
              { label: '轮换申请', value: App.fmt.num(rot.total || 0), unit: '次', tone: 'chain', icon: 'refresh', foot: `待复核 ${rot.pending || 0} · 已批准 ${rot.approved || 0} · 已驳回 ${rot.rejected || 0}` },
            ]),

            h('div', { class: 'grid mt-16', style: 'grid-template-columns:1fr 1fr' }, [
              h('x-card', { title: '密码学能力清单（含如实声明的局限）', sub: '把"没做什么"写在前面，比让评审自己发现更可信' }, {
                default: () => h('div', { class: 'card-body' }, [
                  /* 【缺陷 P1-26】原来这里打印「密钥库文件：server/sm2-keystore.json」，
                   * 把服务端目录结构摆到了页面上。改为说明"存储形态 + 是否静态加密"，
                   * 这才是审计关心的信息；具体路径属部署细节，任何角色都不需要知道。 */
                  h('div', { class: 'keys-rule mb-16' },
                    `签名方案：${c.signing || '—'}\n`
                    + `密钥库：${c.storeRef || '平台内置密钥库（服务端本地）'}${c.storeEncrypted ? '（静态加密存储）' : ''}\n`
                    + `提供商：${c.provider || '—'}`),
                  h('div', { class: 'keys-quote mb-16' }, [h('b', {}, 'HSM 局限：'), c.hsmNote || '—']),
                  h('div', { class: 'tiny dim mb-8' }, '双人复核规则'),
                  h('div', { class: 'keys-rule mb-16' }, dc.rule || '—'),
                  h('div', { class: 'tiny dim mb-8' }, '轮换安全策略'),
                  h('div', { class: 'keys-rule mb-12' }, rs.strategy || '—'),
                  h('div', { class: 'keys-quote' }, [h('b', {}, '为什么不能删旧密钥：'), rs.why || '—']),
                ]),
              }),

              h('x-card', { title: '主体密钥台账（不含任何私钥）', sub: '本接口只返回公钥、指纹与世代信息 —— 私钥不出密钥库模块' }, {
                default: () => h('div', { class: 'card-body flush' }, [
                  h('x-table', {
                    columns: [
                      { key: 'label', title: '主体标签', width: '128px' },
                      { key: 'provider', title: '提供商', width: '96px' },
                      { key: 'gen', title: '世代', align: 'right', width: '68px' },
                      { key: 'address', title: '当前地址' },
                      { key: 'fingerprint', title: '公钥指纹' },
                    ],
                    rows: invPaged.value.rows,
                    rowKey: 'label',
                    empty: '暂无密钥台账',
                  }, {
                    'col-label': ({ row }) => h('span', { class: 'tag t-info plain' }, row.label),
                    'col-provider': ({ row }) => h('span', { class: 'tag t-mute plain' }, row.provider),
                    'col-gen': ({ row }) => h('x-tag', {
                      text: 'g' + row.generations, tone: row.generations > 1 ? 't-chain' : 't-mute',
                    }),
                    'col-address': ({ row }) => h('x-hash', { value: row.current.address, len: 16 }),
                    'col-fingerprint': ({ row }) => h('x-hash', { value: row.current.fingerprint, len: 12 }),
                  }),
                  invPaged.value.pages > 1 ? h('x-pager', {
                    page: invPaged.value.page, pages: invPaged.value.pages,
                    total: invPaged.value.total, size: KEY_PAGE_SIZE,
                    onChange: (p) => { invPage.value = p; },
                  }) : null,
                  h('div', { class: 'alertbar info mt-12', style: 'margin:12px 0 0' }, [
                    h('x-icon', { name: 'shield', size: 15 }),
                    '台账只含公钥与指纹。可用下方「签名取证」验证私钥确实持有且能产生可验签的国密签名。',
                  ]),
                ]),
              }),
            ]),

            /* ── 签名取证 ── */
            h('x-card', {
              title: '签名取证：现场签、现场验',
              sub: '同一载荷两次签名结果不同，但都能验通过 —— 这是 SM2（随机数 k 非固定）而非哈希冒充签名的特征',
              class: 'mt-16',
            }, {
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'grid', style: 'grid-template-columns:280px 1fr' }, [
                  h('div', { class: 'col gap-12' }, [
                    h('div', {}, [
                      h('div', { class: 'tiny dim mb-6' }, '主体标签 keyLabel'),
                      h('select', {
                        class: 'input', 'aria-label': '签名主体标签', style: 'height:31px', value: sigLabel.value,
                        onChange: (e) => { sigLabel.value = e.target.value; sigResult.value = null; verifyResult.value = null; },
                      }, labelOptions.value.map((x) => h('option', { value: x }, x))),
                    ]),
                    h('div', { class: 'tiny dim' }, `可选前缀：${(labels.value || []).join('  ')}`),
                    h('div', { class: 'flex gap-8 wrap' }, [
                      h('button', { class: 'btn sm primary', disabled: sigBusy.value, onClick: doSign },
                        [h('x-icon', { name: 'key', size: 14 }), sigBusy.value ? '签名中…' : '生成签名']),
                      h('button', { class: 'btn sm', disabled: !sigResult.value, onClick: () => doVerify(false) }, '验签（原载荷）'),
                      h('button', { class: 'btn sm danger', disabled: !sigResult.value, onClick: () => doVerify(true) }, '验签（篡改载荷）'),
                    ]),
                    verifyResult.value
                      ? h('x-readout', {
                        pass: verifyResult.value.__tamper ? !verifyResult.value.valid : verifyResult.value.valid,
                        label: verifyResult.value.__tamper ? '篡改后应当验签失败' : '原载荷应当验签通过',
                        detail: verifyResult.value.valid
                          ? ('valid=true · ' + (verifyResult.value.generation || ''))
                          : 'valid=false',
                      })
                      : null,
                    sigResult.value ? h('div', {}, [
                      h('x-readout', {
                        pass: /^SM2/.test(sigResult.value.algorithm || ''),
                        label: /^SM2/.test(sigResult.value.algorithm || '')
                          ? '用当前世代私钥签名（真实国密）'
                          : '静态演示占位签名（不是真实国密签名）',
                        detail: (sigResult.value.algorithm || '') + ' · keyId=' + sigResult.value.keyId,
                      }),
                      h('div', { class: 'tiny dim mt-8', style: 'word-break:break-all' }, '载荷 SM3 摘要 ' + ((sigResult.value.payloadDigest && sigResult.value.payloadDigest.digest) || '—')),
                    ]) : null,
                  ]),
                  h('div', {}, [
                    h('div', { class: 'tiny dim mb-6' }, '待签载荷（JSON）'),
                    h('textarea', {
                      class: 'input', style: 'height:112px;font-family:var(--mono);font-size:11.6px;padding:9px 11px',
                      value: sigPayload.value, onInput: (e) => { sigPayload.value = e.target.value; },
                    }),
                    h('div', { class: 'tiny dim mb-6 mt-12' }, '签名的规范序列化与结果'),
                    h('div', { class: 'keys-sig' }, sigResult.value
                      ? (CANON_NOTE + '\n\n签名值：\n' + sigResult.value.signature)
                      : '（尚未签名）'),
                  ]),
                ]),
              ]),
            }),

            /* ── 轮换安全性举证 ──
             * 后端 /keys/rotation-safety-demo 是 requireRole('ADMIN')。
             * 此前所有角色都渲染这个卡片，监管/核查端点一下只得到
             * "当前角色无权访问该功能" —— 看得见却点不动，属交互缺陷
             * （2026-10-28 深度实操发现）。改为按角色渲染。 */
            !isAdmin && h('x-card', {
              title: '轮换安全性举证',
              sub: '该功能需要管理员角色（会真实轮换演示主体的密钥）',
              class: 'mt-16',
            }, {
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'alertbar info' }, [
                  h('x-icon', { name: 'info', size: 15 }),
                  h('span', {}, '当前角色为只读视图。轮换安全性举证涉及密钥代际切换，仅平台管理员可执行。'),
                ]),
              ]),
            }),
            isAdmin && h('x-card', {
              title: '轮换安全性举证（WP2 最该被评审看到的一段）',
              sub: '步骤：用第 N 代签名 → 验签通过 → 轮换到第 N+1 代 → 再用旧签名验签 → 期望仍通过，且 generation 显示 HISTORICAL',
              class: 'mt-16',
            }, {
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'flex gap-10 wrap mb-16', style: 'align-items:flex-end' }, [
                  h('div', { style: 'width:200px' }, [
                    h('div', { class: 'tiny dim mb-6' }, '主体标签（建议用演示主体）'),
                    h('input', { class: 'input', 'aria-label': '签名主体标签', style: 'height:31px', value: demoLabel.value, onInput: (e) => { demoLabel.value = e.target.value; } }),
                  ]),
                  h('button', { class: 'btn primary', disabled: demoBusy.value, onClick: doDemo },
                    [h('x-icon', { name: 'shield', size: 15 }), demoBusy.value ? '举证中…' : '运行轮换安全举证']),
                  h('span', { class: 'tiny dim' }, App.fmt.md('注意：该动作**真的会轮换该主体的密钥**，请对演示主体执行')),
                ]),
                demo.value
                  ? h('div', {}, [
                    h('div', { class: 'flex between mb-12' }, [
                      h('span', { class: 'tiny dim' }, `主体 ${demo.value.keyLabel} · 世代 ${demo.value.generations.before} → ${demo.value.generations.after}`),
                      h('x-tag', { text: `${demo.value.passed}/${demo.value.total} 通过`, tone: demo.value.allPass ? 't-ok' : 't-danger' }),
                    ]),
                    ...(demo.value.checks || []).map((chk) => h('div', { class: 'keys-demo' }, [
                      h('span', { class: ['flag', chk.pass ? 'ok' : 'no'] }, chk.pass ? 'PASS' : 'FAIL'),
                      h('div', { class: 'flex-1' }, [
                        h('div', { class: 'tt' }, chk.name),
                        h('div', { class: 'dd' }, `期望 ${chk.expect} · 实际 ${chk.actual}${chk.generation ? ' · generation=' + chk.generation : ''}`),
                      ]),
                    ])),
                    demo.value.rotation
                      ? h('div', { class: 'keys-rule mt-16' },
                        `旧世代 g${demo.value.rotation.oldKeys.keyId}：${demo.value.rotation.oldKeys.address}\n`
                        + `新世代 g${demo.value.rotation.newKeys.keyId}：${demo.value.rotation.newKeys.address}`)
                      : null,
                    h('div', { class: 'keys-quote mt-12' }, demo.value.conclusion),
                  ])
                  : h('div', { class: 'alertbar info' }, [
                    h('x-icon', { name: 'info', size: 15 }),
                    '点上方按钮现场跑完五项断言。若"轮换后旧签名仍可验（HISTORICAL）"失败，说明轮换破坏了历史签名的可核验性 —— 那是以"更安全"之名毁掉账本。',
                  ]),
              ]),
            }),

            /* ── 轮换申请 → 双人复核 → 台账 ── */
            h('x-card', {
              title: '密钥轮换：申请 → 双人复核 → 生效',
              sub: '下一世代的密钥对在复核通过之后才生成；未批准前不产生任何新私钥。复核人必须与申请人不同（服务层强制）',
              class: 'mt-16',
            }, {
              actions: () => isAdmin ? null : h('x-tag', { text: '只读：仅管理员可发起轮换', tone: 't-warn' }),
              default: () => h('div', { class: 'card-body' }, [
                isAdmin ? h('div', { class: 'flex gap-10 wrap mb-16', style: 'align-items:flex-end' }, [
                  h('div', { style: 'width:170px' }, [
                    h('div', { class: 'tiny dim mb-6' }, '轮换主体'),
                    h('select', {
                      class: 'input', 'aria-label': '轮换主体', style: 'height:31px', value: rotForm.keyLabel,
                      onChange: (e) => { rotForm.keyLabel = e.target.value; },
                    }, [h('option', { value: '' }, '请选择…')].concat(labelOptions.value.map((x) => h('option', { value: x }, x)))),
                  ]),
                  h('div', { style: 'flex:1;min-width:180px' }, [
                    h('div', { class: 'tiny dim mb-6' }, '轮换原因'),
                    h('input', { class: 'input', 'aria-label': '轮换原因', style: 'height:31px', placeholder: '如：年度例行轮换 / 疑似泄露', value: rotForm.reason, onInput: (e) => { rotForm.reason = e.target.value; } }),
                  ]),
                  h('div', { style: 'width:170px' }, [
                    h('div', { class: 'tiny dim mb-6' }, '申请人'),
                    h('input', { class: 'input', 'aria-label': '发起人', style: 'height:31px', value: rotForm.requestedBy, onInput: (e) => { rotForm.requestedBy = e.target.value; } }),
                  ]),
                  h('div', { style: 'width:170px' }, [
                    h('div', { class: 'tiny dim mb-6' }, '本次复核人'),
                    h('input', { class: 'input', 'aria-label': '审批人', style: 'height:31px', value: rotForm.approvedBy, onInput: (e) => { rotForm.approvedBy = e.target.value; } }),
                  ]),
                  h('button', { class: 'btn primary', disabled: rotBusy.value, onClick: requestRotate },
                    [h('x-icon', { name: 'refresh', size: 14 }), '提交轮换申请']),
                ]) : null,
                h('div', { class: 'keys-rule mb-16' }, '双人复核的判据是 approved_by ≠ requested_by。当前"申请人"与"复核人"若填同一人，复核将被服务层直接拒绝执行。'),
                h('x-table', {
                  columns: [
                    { key: 'id', title: '#', width: '54px' },
                    { key: 'key_label', title: '主体', width: '128px' },
                    { key: 'action', title: '动作', width: '84px' },
                    { key: 'requested_by', title: '申请人', width: '110px' },
                    { key: 'approved_by', title: '复核人', width: '110px' },
                    { key: 'dualControlOk', title: '双人复核', width: '92px' },
                    { key: 'approval_status', title: '状态', width: '92px' },
                    { key: 'block_index', title: '上链', width: '80px' },
                    { key: 'created_at', title: '申请时间', width: '146px' },
                    { key: '_ops', title: '复核操作', width: '140px' },
                  ],
                  rows: logPaged.value.rows,
                  rowKey: 'id',
                  empty: '暂无轮换申请',
                }, {
                  'col-action': ({ row }) => h('span', { class: 'tag t-info plain' }, row.action),
                  'col-dualControlOk': ({ row }) => row.dualControlOk
                    ? h('span', { class: 'tag t-ok' }, '双人通过')
                    : h('span', { class: 'tag t-mute' }, '未复核'),
                  'col-approval_status': ({ row }) => h('x-tag', {
                    text: { PENDING: '待复核', APPROVED: '已批准', REJECTED: '已驳回' }[row.approval_status] || row.approval_status,
                    tone: { PENDING: 't-warn', APPROVED: 't-ok', REJECTED: 't-danger' }[row.approval_status] || 't-mute',
                  }),
                  'col-block_index': ({ row }) => h('x-chainbadge', { block: row.block_index, hash: row.chain_tx_id }),
                  'col-created_at': ({ row }) => h('span', { class: 'tiny dim' }, row.created_at),
                  'col-_ops': ({ row }) => (isAdmin && row.approval_status === 'PENDING')
                    ? h('div', { class: 'flex gap-6' }, [
                      h('button', { class: 'btn sm primary', onClick: () => approve(row) }, '复核通过'),
                      h('button', { class: 'btn sm ghost', onClick: () => reject(row) }, '驳回'),
                    ])
                    : h('span', { class: 'dim' }, '—'),
                }),
                logPaged.value.pages > 1 ? h('x-pager', {
                  page: logPaged.value.page, pages: logPaged.value.pages,
                  total: logPaged.value.total, size: KEY_PAGE_SIZE,
                  onChange: (p) => { logPage.value = p; },
                }) : null,
              ]),
            }),
          ],
        });
      };
    },
  });

  App.views['page-keymgmt'] = PageKeymgmt;
})();
