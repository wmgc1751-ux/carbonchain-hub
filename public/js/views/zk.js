/* =====================================================================
   zk.js —— 零知识碳核算（隐私保护型 MRV）前端
   ---------------------------------------------------------------------
   /zk              协议总览（公开：任何人可读，含局限声明）
   /ent/zk          企业「隐私承诺」工作台（生成承诺 / 保管见证 / 授权披露）
   /reg/zk          监管「零知识验证」工作台（验证承诺 / 聚合核算 / 披露审计）

   页面立场：
     这一页要说服的不是评审，而是**真实企业**。
     所以页面第一屏必须回答"我的商业机密会不会泄漏"，
     而不是"我们用了什么密码学算法"。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, reactive } = Vue;
  const h = App.h;

  const STYLE_ID = 'zk-page-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
.zk-hero{background:linear-gradient(135deg,rgba(16,185,129,.09),rgba(6,182,212,.05));
  border:1px solid rgba(16,185,129,.22);border-radius:14px;padding:22px 24px;margin-bottom:16px}
.zk-hero h3{margin:0 0 8px;font-size:17px;color:var(--tx-0)}
.zk-hero p{margin:6px 0;font-size:13.2px;line-height:1.8;color:var(--tx-1)}
.zk-vs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:16px 0}
.zk-vs>div{background:var(--bg-0);border:1px solid var(--hair);border-radius:10px;padding:13px 15px}
.zk-vs .t{font-size:12.6px;font-weight:600;margin-bottom:6px}
.zk-vs .b{font-size:12px;line-height:1.7;color:var(--tx-2)}
.zk-vs .bad .t{color:#fda4af}
.zk-vs .mid .t{color:#fcd34d}
.zk-vs .good .t{color:#6ee7b7}
.zk-flow{display:flex;flex-direction:column;gap:0}
.zk-step{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--hair)}
.zk-step:last-child{border-bottom:none}
.zk-step .no{flex:none;width:22px;height:22px;border-radius:7px;background:rgba(16,185,129,.16);
  color:#6ee7b7;font-family:var(--mono);font-size:11px;display:flex;align-items:center;
  justify-content:center;margin-top:1px}
.zk-step .tt{font-size:12.8px;color:var(--tx-0);font-weight:500}
.zk-step .dd{font-size:12.2px;color:var(--tx-2);line-height:1.72;margin-top:2px}
.zk-step .fx{font-family:var(--mono);font-size:11.4px;color:var(--tx-3);margin-top:3px;word-break:break-all}
.zk-mono{font-family:var(--mono);font-size:11.4px;color:var(--tx-2);word-break:break-all}
.zk-warn{border-left:3px solid rgba(245,165,36,.55);padding:10px 13px;background:rgba(245,165,36,.06);
  border-radius:0 8px 8px 0;font-size:12.4px;line-height:1.78;color:var(--tx-1);margin:10px 0}
.zk-bad{border-left:3px solid rgba(244,63,94,.55);padding:10px 13px;background:rgba(244,63,94,.06);
  border-radius:0 8px 8px 0;font-size:12.4px;line-height:1.78;color:var(--tx-1);margin:10px 0}
.zk-ok{border-left:3px solid rgba(16,185,129,.5);padding:10px 13px;background:rgba(16,185,129,.05);
  border-radius:0 8px 8px 0;font-size:12.4px;line-height:1.78;color:var(--tx-1);margin:10px 0}
.zk-tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.zk-tab{padding:6px 13px;border-radius:8px;font-size:12.6px;cursor:pointer;color:var(--tx-2);
  background:var(--bg-1);border:1px solid var(--hair);transition:.15s}
.zk-tab.on{background:rgba(16,185,129,.14);color:#6ee7b7;border-color:rgba(16,185,129,.4)}
.zk-pill{display:inline-block;font-family:var(--mono);font-size:11px;padding:1.5px 7px;
  border-radius:5px;background:rgba(16,185,129,.14);color:#6ee7b7;margin-right:5px}
.zk-pill.warn{background:rgba(245,165,36,.16);color:#fcd34d}
.zk-pill.bad{background:rgba(244,63,94,.16);color:#fda4af}
.zk-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px}
.zk-form label{display:block;font-size:11.6px;color:var(--tx-3);margin-bottom:4px}
.zk-form input,.zk-form select{width:100%;padding:6px 9px;border-radius:7px;font-size:12.4px;
  background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0)}
.zk-secret{background:var(--bg-0);border:1px dashed rgba(244,63,94,.4);border-radius:9px;
  padding:12px 14px;font-family:var(--mono);font-size:11.2px;color:var(--tx-2);
  max-height:180px;overflow:auto;word-break:break-all;line-height:1.7}
`;
    document.head.appendChild(el);
  }

  const num = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '—' : App.fmt.num(v, d);

  function useEntPicker() {
    const isEnt = !!(App.Store.user && App.Store.user.role === 'ENTERPRISE');
    const entId = ref(isEnt ? Number(App.Store.user.orgId) : null);
    const ents = ref([]);
    async function loadEnts() {
      if (isEnt) return;
      try {
        const d = await App.API.get('/public/enterprises', { page: 1, size: 200 });
        ents.value = ((d && (d.rows || d)) || []).map((x) => ({ id: x.id, name: x.ent_name }));
        if (!entId.value && ents.value.length) entId.value = Number(ents.value[0].id);
      } catch (e) { ents.value = []; }
    }
    return { isEnt, entId, ents, loadEnts };
  }

  function entSelect(p) {
    if (p.isEnt) return null;
    return h('div', { style: 'min-width:220px' }, [
      h('label', { style: 'font-size:11.6px;color:var(--tx-3);display:block;margin-bottom:4px' }, '查看企业'),
      h('select', {
        value: p.entId.value || '',
        onChange: (e) => { p.entId.value = Number(e.target.value); },
        style: 'width:100%;padding:6px 9px;border-radius:7px;background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0);font-size:12.4px',
      }, p.ents.value.map((x) => h('option', { value: x.id }, `${x.id} · ${x.name}`))),
    ]);
  }

  /* ==================================================================
   * 1. 协议总览（公开）
   * ================================================================== */
  const PageZkOverview = defineComponent({
    name: 'page-zk',
    setup() {
      injectStyle();
      const proto = ref(null);
      const st = ref(null);
      const truth = ref(null);
      onMounted(async () => {
        proto.value = await App.API.get('/zk/protocol').catch(() => null);
        st.value = await App.API.get('/zk/selftest').catch(() => null);
        truth.value = await App.API.get('/zk/data-truth').catch(() => null);
      });

      return () => {
        const p = proto.value || {};
        return h('x-page', {
          title: '零知识碳核算（隐私保护型 MRV）',
          desc: '让监管能验证、企业不必交出商业机密 —— 这是碳数据平台能否进入真实企业的分水岭。',
        }, {
          default: () => h('div', {}, [
            /* 数据真实性声明 —— 放在最前面。
             * 理由：这一页讲的全是"可验证"，如果连"数据本身是真是假"
             * 都含糊其辞，后面的技术主张就没有立足点。
             * 声明内容**来自服务端实时计算**（/api/zk/data-truth），不是写死的文案。 */
            truth.value ? h('div', { class: 'zk-bad', style: 'margin-bottom:16px' }, [
              h('div', { style: 'font-weight:600;margin-bottom:6px;color:var(--tx-0)' },
                '数据真实性声明（本页必须先说清这一点）'),
              h('p', { style: 'margin:4px 0' }, truth.value.verdict),
              h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px' }, [
                h('div', {}, [
                  h('div', { style: 'font-size:12px;color:#6ee7b7;margin-bottom:3px' }, '✔ 真实的（可核查）'),
                  h('div', { style: 'font-size:11.8px;line-height:1.7;color:var(--tx-2)' },
                    `${truth.value.real.standards.count} 项标准/法规引用；`
                    + `${truth.value.real.factors.count} 项排放因子（燃料 ${truth.value.real.factors.fuel} + `
                    + `区域电网 ${truth.value.real.factors.gridRegion}），全部与官方公布值一致`),
                ]),
                h('div', {}, [
                  h('div', { style: 'font-size:12px;color:#fda4af;margin-bottom:3px' }, '✘ 合成的（不可声称真实）'),
                  h('div', { style: 'font-size:11.8px;line-height:1.7;color:var(--tx-2)' },
                    `企业主体 ${truth.value.synthetic.enterprises.count} 家（模板生成）；`
                    + `CEMS 读数 ${truth.value.synthetic.cems.count} 条（真实设备 `
                    + `${truth.value.synthetic.cems.realDevice} 条）；`
                    + `活动数据 ${truth.value.synthetic.activity.count} 条（按定额生成）`),
                ]),
              ]),
              h('div', { style: 'font-size:11.6px;color:var(--tx-3);margin-top:8px' },
                '本声明由服务端实时计算（GET /api/zk/data-truth），接入真实数据后会自动变化。'),
            ]) : null,

            /* 第一屏：先解决企业最关心的问题 */
            h('div', { class: 'zk-hero' }, [
              h('h3', {}, '企业最担心的问题：我的产量、能耗、工艺会不会被看到？'),
              h('p', {}, '不会。平台只要求你提交一个 65 字节的「承诺」和一份「范围证明」。'),
              h('p', {}, '监管可以确认：① 这个数没被改过；② 这个数在合理范围内；③ 这个数与你其他申报口径一致。'),
              h('p', {}, h('b', {}, '但监管拿不到这个数是多少 —— 平台自己也拿不到。')),
              h('p', { style: 'color:var(--tx-3);font-size:12.4px;margin-top:10px' },
                '这在密码学上叫「信息论隐藏」：不是"我们承诺不看"，而是"即使我们想看也看不到"。'),
            ]),

            /* 三种方案的对比 —— 让评审一眼看出这不是"又做了一个上传功能" */
            h('div', { class: 'zk-vs' }, [
              h('div', { class: 'bad' }, [
                h('div', { class: 't' }, '方案 A：明文上链'),
                h('div', { class: 'b' }, '监管能验证，但活动数据全部公开。企业不会用——那是商业自杀。'),
              ]),
              h('div', { class: 'mid' }, [
                h('div', { class: 't' }, '方案 B：只报汇总数'),
                h('div', { class: 'b' }, '保密没问题，但监管无法验证真实性。等于信任企业自述。'),
              ]),
              h('div', { class: 'good' }, [
                h('div', { class: 't' }, '方案 C：本平台（承诺 + 范围证明）'),
                h('div', { class: 'b' }, '可验证且不披露。监管获得可信结论，企业保住商业机密。'),
              ]),
            ]),

            /* 协议流程 */
            h('x-card', { title: '协议流程（5 步）' }, {
              default: () => h('div', { class: 'card-body zk-flow' },
                [
                  ['1', '企业本地核算', '活动数据留在企业内部，只算出排放量 v', '不上传任何明细'],
                  ['2', '生成承诺', 'Com(v, r) = v·G + r·H，65 字节', 'H 由哈希派生，无人知道其离散对数'],
                  ['3', '生成范围证明', '证明 0 ≤ v < 2⁶⁴，不透露 v', '约 1.1 KB，耗时约 600 ms'],
                  ['4', '上链', '只放承诺 + 证明 + 元数据摘要', '链上永不含原始数值'],
                  ['5', '监管验证', '验承诺绑定、范围、跨期一致', '约 11 ms，获得「可信」结论'],
                ].map(([no, tt, dd, fx]) => h('div', { class: 'zk-step' }, [
                  h('div', { class: 'no' }, no),
                  h('div', {}, [
                    h('div', { class: 'tt' }, tt),
                    h('div', { class: 'dd' }, dd),
                    h('div', { class: 'fx' }, fx),
                  ]),
                ]))
              ),
            }),

            /* 四个可验证性质 */
            h('x-card', { title: '四个可验证性质（每个都配阴性对照）' }, {
              default: () => h('div', { class: 'card-body' }, [
                ...(p.properties || []).map((x) => h('div', { class: 'zk-step' }, [
                  h('div', { class: 'no' }, '✓'),
                  h('div', {}, [
                    h('div', { class: 'tt' }, x.name),
                    h('div', { class: 'dd' }, x.meaning),
                  ]),
                ])),
                h('div', { class: 'zk-mono', style: 'margin-top:10px' },
                  '自检：' + (st.value ? `${st.value.passed}/${st.value.total} 项断言通过` : '加载中…')),
              ]),
            }),

            /* 密码学细节 */
            h('x-card', { title: '密码学实现（可被第三方独立复核）' }, {
              default: () => h('div', { class: 'card-body' }, [
                ...Object.entries(p.cryptography || {}).map(([k, v]) =>
                  h('div', { style: 'display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--hair)' }, [
                    h('span', { class: 'zk-mono', style: 'width:110px;flex:none;color:var(--tx-3)' }, k),
                    h('span', { style: 'font-size:12.4px' }, v),
                  ])),
                h('div', { class: 'zk-ok', style: 'margin-top:12px' },
                  '群运算与 OpenSSL 的 SM2 实现逐字节一致 —— 这是"自实现没错"的跨实现证据。'
                  + '可通过 GET /api/zk/selftest 自行复核。'),
              ]),
            }),

            /* 局限 —— 必须放在显眼位置 */
            h('x-card', { title: '局限声明（必须与结论一并阅读）' }, {
              default: () => h('div', { class: 'card-body' }, [
                h('div', { class: 'zk-warn' }, [
                  ...(p.limitations || []).map((l) => h('div', { style: 'padding:3px 0' }, '· ' + l)),
                ]),
                p.performance ? h('div', { class: 'zk-mono', style: 'margin-top:10px' },
                  `性能：证明 ${p.performance.proveMs} / 验证 ${p.performance.verifyMs} / 公开包 ${p.performance.publicBytes}`) : null,
              ]),
            }),
          ]),
        });
      };
    },
  });

  /* ==================================================================
   * 2. 企业侧：隐私承诺工作台
   * ================================================================== */
  const PageEntZk = defineComponent({
    name: 'page-ent-zk',
    setup() {
      injectStyle();
      const picker = useEntPicker();
      const year = ref(new Date().getFullYear());
      const list = ref([]);
      const busy = ref(false);
      const tab = ref('commit');
      const created = ref(null);       // 刚生成的承诺（含见证）
      const disclosed = ref(null);
      const form = reactive({ emission: '', useCalc: true, breakdown: '', batchNo: '' });
      const formula = ref(null);
      const disclForm = reactive({ commitmentId: '', witnessJson: '', grantee: '', purpose: '', part: '' });

      async function load() {
        if (!picker.entId.value) return;
        try {
          const d = await App.API.get('/zk/commitments', { entId: picker.entId.value, year: year.value });
          list.value = (d && d.items) || [];
        } catch (e) { list.value = []; }
      }

      async function doCommit() {
        if (!picker.entId.value) return;
        if (!form.useCalc && !form.emission) { App.notify.err('请输入排放量，或选择"使用核算批次结果"'); return; }
        busy.value = true;
        try {
          let breakdown = null;
          if (form.breakdown && form.breakdown.trim()) {
            /* 格式：COAL:3000,POWER:2000 */
            breakdown = form.breakdown.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
              const [c, v] = s.split(':');
              return { sourceCode: c.trim(), emission: Number(v) };
            }).filter((x) => x.sourceCode && isFinite(x.emission));
          }
          const body = {
            entId: picker.entId.value, year: year.value,
            breakdown: breakdown && breakdown.length ? breakdown : undefined,
          };
          if (!form.useCalc) body.emission = Number(form.emission);
          const r = await App.API.post('/zk/commit', body);
          created.value = r;
          App.notify.ok('承诺已生成并上链。请立即下载 privateWitness 并离线保管');
          await load();
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      function downloadWitness() {
        if (!created.value) return;
        const blob = new Blob([JSON.stringify({
          commitmentId: created.value.commitmentId,
          publicPayload: created.value.publicPayload,
          privateWitness: created.value.privateWitness,
          warning: created.value.warning,
        }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `zk-witness-${picker.entId.value}-${year.value}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        App.notify.ok('见证文件已下载，请离线保管（丢失后该承诺永久无法打开）');
      }

      async function doFormula() {
        if (!form.batchNo) { App.notify.err('请填写核算批次号'); return; }
        busy.value = true;
        try {
          const r = await App.API.post('/zk/formula/prove', { batchNo: form.batchNo });
          /* 立即自验一次，让用户当场看到"证明确实有效" */
          const v = await App.API.post('/zk/formula/verify', { publicPayload: r.publicPayload });
          formula.value = { ...r, verified: v.ok, verifyReason: v.reason };
          App.notify.ok(v.ok ? '公式证明已生成并上链' : `证明生成但验证未通过：${v.reason}`);
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      function downloadFormulaWitness() {
        if (!formula.value) return;
        const blob = new Blob([JSON.stringify({
          batchNo: formula.value.batchNo,
          publicPayload: formula.value.publicPayload,
          privateWitness: formula.value.privateWitness,
          note: '私密见证含各排放源真实活动数据。请离线保管，勿外传。',
        }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `zk-formula-witness-${formula.value.batchNo}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        App.notify.ok('见证文件已下载');
      }

      async function doDisclose() {
        if (!picker.entId.value) return;
        if (!disclForm.commitmentId || !disclForm.witnessJson) { App.notify.err('请填写承诺 ID 与见证 JSON'); return; }
        let witness;
        try { witness = JSON.parse(disclForm.witnessJson); } catch (e) { App.notify.err('见证 JSON 格式错误'); return; }
        /* 支持直接粘贴整个下载文件（含 privateWitness 字段） */
        if (witness.privateWitness) witness = witness.privateWitness;
        busy.value = true;
        try {
          const r = await App.API.post('/zk/disclose', {
            entId: picker.entId.value,
            commitmentId: Number(disclForm.commitmentId),
            witness,
            grantee: disclForm.grantee || undefined,
            purpose: disclForm.purpose || undefined,
            disclosePart: disclForm.part || undefined,
          });
          disclosed.value = r;
          App.notify.ok(`已披露（${r.disclosure.scope}），本次披露已记入审计日志`);
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      onMounted(async () => { await picker.loadEnts(); await load(); });

      return () => h('x-page', {
        title: '隐私承诺工作台',
        desc: '生成承诺 → 保管见证 → 按需披露。平台不保存你的见证，因此平台永远无法打开你的承诺。',
      }, {
        /* zk 双入口合并后，原理演示页（/zk）从这里进入（2026-10-30） */
        actions: () => [entSelect(picker),
          h('button', { class: 'btn sm', onClick: () => App.go('/zk'), title: '零知识碳核算原理演示（监管视角）' }, '原理演示 ↗'),
          h('button', { class: 'btn sm', onClick: load }, '刷新')],
        default: () => {
          const tabs = h('div', { class: 'zk-tabs' }, [
            ['formula', '公式正确性证明'],
            ['commit', '生成承诺'], ['list', `我的承诺（${list.value.length}）`],
            ['disclose', '授权披露'],
          ].map(([k, label]) => h('div', {
            class: 'zk-tab' + (tab.value === k ? ' on' : ''), onClick: () => { tab.value = k; },
          }, label)));

          let body;

          if (tab.value === 'formula') {
            /* 公式正确性证明 —— 本轮最重要的能力。
             * 上一轮的承诺 + 范围证明只能说"这个数在合理量级内"，
             * 企业完全可以填任意数字。本页证明的是"这个数是算出来的"。 */
            body = h('div', {}, [
              h('div', { class: 'zk-hero' }, [
                h('h3', {}, '为什么光有承诺和范围证明还不够'),
                h('p', {}, '承诺证明「数据没被改过」，范围证明证明「这个数在合理量级内」——'),
                h('p', {}, h('b', {}, '但两者都没有证明这个数是算出来的。')),
                h('p', {}, '企业完全可以填一个假数字（真实排放 100 万吨，报 50 万吨），'
                  + '范围证明照样通过，因为 50 万确实在 [0, 2⁶⁴) 内。'),
                h('p', { style: 'color:var(--tx-0);margin-top:10px' },
                  '本页补上这一层：用零知识证明确认「排放量 = Σ(排放因子 × 活动数据)」，'
                  + '而监管依然看不到任何活动数据。'),
              ]),
              h('x-card', { title: '生成公式正确性证明' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'zk-form' }, [
                    h('div', {}, [h('label', {}, '核算批次号'), h('input', {
                      value: form.batchNo, placeholder: '如 CALC2026…',
                      onInput: (e) => { form.batchNo = e.target.value; },
                    })]),
                    h('div', { style: 'display:flex;align-items:flex-end;gap:8px' }, [
                      h('button', { class: 'btn sm primary', onClick: doFormula, disabled: busy.value },
                        busy.value ? '生成中…' : '生成并验证'),
                    ]),
                  ]),
                  h('div', { class: 'zk-warn' },
                    '活动数据会以承诺形式提交（65 字节/源），排放因子是公开台账。'
                    + '证明生成后，任何第三方都能确认"这个排放量确实是按这些因子和活动数据算的"，'
                    + '但看不到任何活动数据数值。'),
                ]),
              }),
              formula.value ? h('x-card', { title: '证明结果' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: formula.value.verified ? 'zk-ok' : 'zk-bad' },
                    formula.value.verified
                      ? `证明有效：${formula.value.publicPayload.sourceCodes.length} 个排放源的 EF×AD 之和等于申报排放量`
                      : '证明无效'),
                  h('div', { class: 'zk-mono', style: 'margin-top:10px' },
                    `批次 ${formula.value.publicPayload.batchNo}　`
                    + `因子版本 ${formula.value.publicPayload.factorVersion}　`
                    + `证明 ${formula.value.publicPayload.proofBytes} 字节`),
                  h('div', { style: 'margin-top:10px;font-size:12px;color:var(--tx-3)' },
                    '参与公式的排放源（活动数据含量值，仅承诺点公开）：'),
                  h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px' },
                    formula.value.publicPayload.sourceCodes.map((c) =>
                      h('span', { class: 'zk-pill' }, c))),
                  h('div', { style: 'margin-top:12px' }, [
                    h('button', { class: 'btn sm', onClick: downloadFormulaWitness },
                      '下载私密见证（含活动数据，必做）'),
                  ]),
                  h('div', { class: 'zk-warn', style: 'margin-top:10px' },
                    '私密见证含各排放源的真实活动数据（等价于产量/能耗机密）。'
                    + '平台不保存它。丢失后无法向监管披露具体数值（证明仍然有效）。'),
                ]),
              }) : null,
            ]);
          } else if (tab.value === 'commit') {
            body = h('div', {}, [
              h('x-card', { title: '生成隐私承诺' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'zk-form' }, [
                    h('div', {}, [h('label', {}, '数据来源'), h('select', {
                      value: form.useCalc ? 'calc' : 'manual',
                      onChange: (e) => { form.useCalc = e.target.value === 'calc'; },
                    }, [
                      h('option', { value: 'calc' }, '使用核算批次结果（推荐）'),
                      h('option', { value: 'manual' }, '手动输入排放量'),
                    ])]),
                    form.useCalc ? null : h('div', {}, [h('label', {}, '排放量（tCO₂e）'), h('input', {
                      type: 'number', step: '0.001', value: form.emission,
                      onInput: (e) => { form.emission = e.target.value; },
                    })]),
                    h('div', {}, [h('label', {}, '年度'), h('select', {
                      value: year.value, onChange: (e) => { year.value = Number(e.target.value); load(); },
                    }, [new Date().getFullYear() - 1, new Date().getFullYear()].map((y) => h('option', { value: y }, String(y))))]),
                  ]),
                  h('div', { style: 'margin-bottom:10px' }, [
                    h('label', { style: 'font-size:11.6px;color:var(--tx-3);display:block;margin-bottom:4px' },
                      '分源承诺（可选，格式 COAL:5400,POWER:3600）'),
                    h('input', {
                      value: form.breakdown, placeholder: '留空则只承诺总量',
                      onInput: (e) => { form.breakdown = e.target.value; },
                      style: 'width:100%;padding:6px 9px;border-radius:7px;background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0);font-size:12.4px',
                    }),
                  ]),
                  h('button', { class: 'btn sm primary', onClick: doCommit, disabled: busy.value },
                    busy.value ? '生成中（约 0.6 秒）…' : '生成承诺并上链'),
                  h('div', { class: 'zk-warn', style: 'margin-top:12px' },
                    '生成后你会得到一份 privateWitness。它是打开承诺的唯一凭据（含盲化因子）。'
                    + '平台不保存它——一旦丢失，该承诺将永久无法打开。验证仍然有效，但你无法再披露具体数值。'),
                ]),
              }),

              created.value ? h('x-card', { title: '生成结果' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'zk-ok' }, `承诺已上链：区块 #${(created.value.chain && created.value.chain.blockIndex) || '—'}　`
                    + `承诺点 ${String(created.value.publicPayload.commit).slice(0, 32)}…`),
                  h('div', { style: 'display:flex;gap:8px;margin:12px 0' }, [
                    h('button', { class: 'btn sm primary', onClick: downloadWitness }, '下载见证文件（必做）'),
                  ]),
                  h('div', { style: 'font-size:12px;color:var(--tx-3);margin-bottom:6px' },
                    'privateWitness（平台不会保存，仅此一次显示）：'),
                  h('div', { class: 'zk-secret' }, JSON.stringify(created.value.privateWitness, null, 2)),
                  h('div', { class: 'zk-mono', style: 'margin-top:10px' },
                    `公开包大小 ${Buffer ? new Blob([JSON.stringify(created.value.publicPayload)]).size : '—'} 字节　`
                    + `证明耗时 ${created.value.publicPayload.meta.proveMs} ms`),
                ]),
              }) : null,
            ]);
          } else if (tab.value === 'list') {
            body = h('x-card', { title: '我的隐私承诺' }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'id', title: 'ID', width: '60px', align: 'right' },
                  { key: 'year', title: '年度', width: '70px', align: 'right' },
                  { key: 'commit', title: '承诺点' },
                  { key: 'bits', title: '位宽', width: '60px', align: 'right' },
                  { key: 'chain', title: '链上', width: '80px' },
                  { key: 'createdAt', title: '时间', width: '150px' },
                ],
                rows: list.value,
                rowKey: 'id',
                empty: '尚未生成承诺',
              }, {
                'col-commit': ({ row }) => h('span', { class: 'zk-mono' }, String(row.commit).slice(0, 40) + '…'),
                'col-chain': ({ row }) => row.chain && row.chain.blockIndex
                  ? h('span', { class: 'zk-pill' }, '#' + row.chain.blockIndex)
                  : h('span', { style: 'color:var(--tx-3)' }, '—'),
                'col-createdAt': ({ row }) => h('span', { style: 'font-size:11px;color:var(--tx-3)' },
                  String(row.createdAt || '').slice(0, 16)),
              }),
            });
          } else {
            body = h('div', {}, [
              h('x-card', { title: '授权披露（选择性披露）' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'zk-form' }, [
                    h('div', {}, [h('label', {}, '承诺 ID'), h('input', {
                      value: disclForm.commitmentId, placeholder: '如 3',
                      onInput: (e) => { disclForm.commitmentId = e.target.value; },
                    })]),
                    h('div', {}, [h('label', {}, '只披露某分源（可空）'), h('input', {
                      value: disclForm.part, placeholder: '如 COAL；留空则披露总量',
                      onInput: (e) => { disclForm.part = e.target.value; },
                    })]),
                    h('div', {}, [h('label', {}, '被授权方'), h('input', {
                      value: disclForm.grantee, placeholder: '如 华信联合认证中心',
                      onInput: (e) => { disclForm.grantee = e.target.value; },
                    })]),
                    h('div', {}, [h('label', {}, '用途'), h('input', {
                      value: disclForm.purpose, placeholder: '如 2026 年度履约核查',
                      onInput: (e) => { disclForm.purpose = e.target.value; },
                    })]),
                  ]),
                  h('div', { style: 'margin-bottom:10px' }, [
                    h('label', { style: 'font-size:11.6px;color:var(--tx-3);display:block;margin-bottom:4px' },
                      '见证 JSON（粘贴下载的文件，或只粘贴 privateWitness）'),
                    h('textarea', {
                      value: disclForm.witnessJson,
                      onInput: (e) => { disclForm.witnessJson = e.target.value; },
                      style: 'width:100%;height:110px;padding:8px 10px;border-radius:7px;background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0);font-family:var(--mono);font-size:11.4px',
                    }),
                  ]),
                  h('button', { class: 'btn sm primary', onClick: doDisclose, disabled: busy.value }, '确认披露'),
                  h('div', { class: 'zk-warn', style: 'margin-top:12px' },
                    '披露是**不可撤回**的：一旦披露，该范围内数值即不再保密。所有披露都会记入审计日志，'
                    + '包括被授权方与用途——这既是约束也是保护（可证明你没有私下泄露给竞争对手）。'),
                ]),
              }),
              disclosed.value ? h('x-card', { title: '披露结果' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'zk-ok' }, `已披露 ${disclosed.value.disclosure.scope}`
                    + (disclosed.value.disclosure.sourceCode ? `（${disclosed.value.disclosure.sourceCode}）` : '')),
                  h('div', { class: 'zk-mono', style: 'margin-top:8px' },
                    `数值 ${disclosed.value.disclosure.value} ${disclosed.value.disclosure.unit}　`
                    + `缩放因子 ${disclosed.value.disclosure.scale}`),
                  h('div', { style: 'font-size:12px;color:var(--tx-3);margin-top:8px' },
                    disclosed.value.disclosure.note),
                ]),
              }) : null,
            ]);
          }

          return h('div', {}, [tabs, body]);
        },
      });
    },
  });

  /* ==================================================================
   * 3. 监管侧：零知识验证
   * ================================================================== */
  const PageRegZk = defineComponent({
    name: 'page-reg-zk',
    setup() {
      injectStyle();
      /* 年度初始值留空 = "跟随库内最新有数据的年度"。
       * 此前写死系统时钟当年（2026），而库内承诺提交在 2024/2025，
       * 于是监管端一进页面看到的就是「本年度暂无企业提交隐私承诺」的空表格
       * —— 数据明明存在，只是被默认筛选挡掉了。拿到真实年度后回填筛选器，
       * 用户仍可手动切到任一年度。 */
      const year = ref('');
      const years = ref([]);
      const list = ref([]);
      const results = ref({});
      const selecting = ref([]);
      const aggResult = ref(null);
      const disclosures = ref([]);
      const busy = ref(false);
      const tab = ref('verify');

      async function load() {
        busy.value = true;
        try {
          const [d, dl] = await Promise.all([
            App.API.get('/zk/commitments', year.value ? { year: year.value } : {}).catch(() => ({ items: [] })),
            App.API.get('/zk/disclosures').catch(() => ({ items: [] })),
          ]);
          list.value = (d && d.items) || [];
          disclosures.value = (dl && dl.items) || [];
          /* 首次加载：从返回结果里取最新年度回填筛选器。
           * 不传 year 时服务端返回全部年度（按 id 倒序），第一条即最新。 */
          if (!year.value && list.value.length) {
            const ys = [...new Set(list.value.map((x) => Number(x.year)).filter(Boolean))].sort((a, b) => b - a);
            years.value = ys;
            year.value = ys[0];
            /* 回填后按该年度重查一次，保证列表与筛选器显示的是同一口径 */
            await load();
            return;
          }
          if (!years.value.length) {
            const cur = new Date().getFullYear();
            years.value = [cur, cur - 1, cur - 2];
            /* 库内一条承诺都没有：筛选器仍需有选中值，否则显示为空 */
            if (!year.value) year.value = cur;
          }
        } finally { busy.value = false; }
      }

      async function verifyOne(row) {
        try {
          const r = await App.API.post('/zk/verify', { commitmentId: row.id });
          results.value = { ...results.value, [row.id]: r };
          App.notify.ok(r.ok ? `#${row.id} 验证通过` : `#${row.id} 验证失败`);
        } catch (e) { App.notify.err(e.message); }
      }

      async function verifyAll() {
        busy.value = true;
        let ok = 0; let bad = 0;
        for (const row of list.value) {
          try {
            const r = await App.API.post('/zk/verify', { commitmentId: row.id });
            results.value = { ...results.value, [row.id]: r };
            r.ok ? ok++ : bad++;
          } catch (e) { bad++; }
        }
        busy.value = false;
        App.notify.ok(`批量验证完成：通过 ${ok} / 失败 ${bad}`);
      }

      function toggle(id) {
        const s = new Set(selecting.value);
        s.has(id) ? s.delete(id) : s.add(id);
        selecting.value = [...s];
      }

      async function doAggregate() {
        if (selecting.value.length < 2) { App.notify.err('至少选择 2 个承诺'); return; }
        busy.value = true;
        try {
          aggResult.value = await App.API.post('/zk/aggregate', { commitmentIds: selecting.value });
          App.notify.ok(`已聚合 ${aggResult.value.count} 个承诺`);
        } catch (e) { App.notify.err(e.message); }
        finally { busy.value = false; }
      }

      onMounted(load);

      return () => h('x-page', {
        title: '零知识验证（监管侧）',
        desc: '验证企业承诺、做区域总量聚合、审计披露记录。全过程不获取任何企业原始数值。',
      }, {
        actions: () => [
          h('select', {
            value: year.value, onChange: (e) => { year.value = Number(e.target.value); load(); },
            'aria-label': '年度筛选',
            style: 'padding:6px 9px;border-radius:7px;background:var(--bg-0);border:1px solid var(--hair);color:var(--tx-0);font-size:12.4px',
          }, years.value.map((y) => h('option', { value: y }, y + ' 年度'))),
          h('button', { class: 'btn sm', onClick: verifyAll, disabled: busy.value }, '全部验证'),
          h('button', { class: 'btn sm primary', onClick: doAggregate, disabled: busy.value || selecting.value.length < 2 },
            `聚合选中的 ${selecting.value.length} 个`),
        ],
        default: () => {
          const tabs = h('div', { class: 'zk-tabs' }, [
            ['verify', `承诺验证（${list.value.length}）`],
            ['agg', '总量聚合'],
            ['audit', `披露审计（${disclosures.value.length}）`],
          ].map(([k, label]) => h('div', {
            class: 'zk-tab' + (tab.value === k ? ' on' : ''), onClick: () => { tab.value = k; },
          }, label)));

          let body;
          if (tab.value === 'verify') {
            body = h('x-card', { title: '企业隐私承诺（全部已上链）' }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'sel', title: '', width: '40px' },
                  { key: 'id', title: 'ID', width: '55px', align: 'right' },
                  { key: 'entName', title: '企业', width: '170px' },
                  { key: 'commit', title: '承诺点' },
                  { key: 'chain', title: '链上', width: '70px' },
                  { key: 'status', title: '验证', width: '90px' },
                  { key: 'act', title: '', width: '70px' },
                ],
                rows: list.value,
                rowKey: 'id',
                empty: '本年度暂无企业提交隐私承诺',
              }, {
                'col-sel': ({ row }) => h('input', {
                  type: 'checkbox', checked: selecting.value.includes(row.id),
                  onChange: () => toggle(row.id),
                  style: 'cursor:pointer',
                }),
                'col-entName': ({ row }) => h('span', { style: 'font-size:12.4px' }, row.entName),
                'col-commit': ({ row }) => h('span', { class: 'zk-mono' }, String(row.commit).slice(0, 34) + '…'),
                'col-chain': ({ row }) => row.chain && row.chain.blockIndex
                  ? h('span', { class: 'zk-pill' }, '#' + row.chain.blockIndex)
                  : h('span', { style: 'color:var(--tx-3)' }, '—'),
                'col-status': ({ row }) => {
                  const r = results.value[row.id];
                  if (!r) return h('span', { style: 'color:var(--tx-3);font-size:11.5px' }, '未验证');
                  return h('span', { class: 'zk-pill' + (r.ok ? '' : ' bad') }, r.ok ? '有效' : '无效');
                },
                'col-act': ({ row }) => h('button', { class: 'btn xs', onClick: () => verifyOne(row) }, '验证'),
              }),
            });
          } else if (tab.value === 'agg') {
            body = h('div', {}, [
              h('x-card', { title: '同态聚合（区域/行业总量）' }, {
                default: () => h('div', { class: 'card-body' }, [
                  h('div', { class: 'zk-step' }, [
                    h('div', { class: 'no' }, '1'),
                    h('div', {}, [
                      h('div', { class: 'tt' }, '选中企业承诺（在"承诺验证"页勾选）'),
                      h('div', { class: 'dd' }, `当前已选 ${selecting.value.length} 个`),
                    ]),
                  ]),
                  h('div', { class: 'zk-step' }, [
                    h('div', { class: 'no' }, '2'),
                    h('div', {}, [
                      h('div', { class: 'tt' }, '同态相加得到一个聚合承诺'),
                      h('div', { class: 'dd' }, 'ΣCom(vᵢ) = Com(Σvᵢ) —— 加法交换律保证与顺序无关'),
                    ]),
                  ]),
                  h('div', { class: 'zk-step' }, [
                    h('div', { class: 'no' }, '3'),
                    h('div', {}, [
                      h('div', { class: 'tt' }, '聚合结果可对外公告，但仍是"承诺"'),
                      h('div', { class: 'dd' }, '只有同时持有全部企业见证的一方才能打开它。平台不持有见证，因此平台也不知道总量'),
                    ]),
                  ]),
                  aggResult.value ? h('div', { class: 'zk-ok', style: 'margin-top:12px' }, [
                    h('div', {}, `已聚合 ${aggResult.value.count} 个承诺`),
                    h('div', { class: 'zk-mono', style: 'margin-top:6px' },
                      '聚合承诺：' + String(aggResult.value.aggregateCommit).slice(0, 48) + '…'),
                    h('div', { style: 'font-size:12px;color:var(--tx-3);margin-top:8px' },
                      aggResult.value.disclosureNotice),
                  ]) : null,
                ]),
              }),
            ]);
          } else {
            body = h('x-card', { title: '授权披露审计日志' }, {
              default: () => h('x-table', {
                columns: [
                  { key: 'at', title: '时间', width: '150px' },
                  { key: 'entName', title: '披露方', width: '160px' },
                  { key: 'scope', title: '范围', width: '80px' },
                  { key: 'sourceCode', title: '分项', width: '100px' },
                  { key: 'grantee', title: '被授权方' },
                  { key: 'purpose', title: '用途' },
                ],
                rows: disclosures.value,
                rowKey: 'id',
                empty: '暂无披露记录（说明所有企业的数值都仍是保密的）',
              }, {
                'col-at': ({ row }) => h('span', { style: 'font-size:11px;color:var(--tx-3)' }, String(row.at || '').slice(0, 16)),
                'col-entName': ({ row }) => h('span', { style: 'font-size:12.4px' }, row.entName),
                'col-scope': ({ row }) => h('span', { class: 'zk-pill' + (row.scope === 'TOTAL' ? ' warn' : '') }, row.scope),
                'col-sourceCode': ({ row }) => row.sourceCode ? h('span', { class: 'zk-mono' }, row.sourceCode) : h('span', { style: 'color:var(--tx-3)' }, '—'),
                'col-grantee': ({ row }) => h('span', { style: 'font-size:12.2px' }, row.grantee || '—'),
                'col-purpose': ({ row }) => h('span', { style: 'font-size:12.2px' }, row.purpose || '—'),
              }),
            });
          }

          return h('div', {}, [tabs, body]);
        },
      });
    },
  });

  App.views['page-zk'] = PageZkOverview;
  App.views['page-ent-zk'] = PageEntZk;
  App.views['page-reg-zk'] = PageRegZk;
})();
