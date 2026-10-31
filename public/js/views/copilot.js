/* =====================================================================
   copilot.js —— 原生级 AI 碳资产顾问浮窗
   ---------------------------------------------------------------------
   设计要点：

   ① **全局沉浸式但可收起**。默认收成一个圆形按钮（不遮挡内容）；
      展开后是侧边面板。收起状态不影响任何现有页面布局。

   ② **流式打字机**。用 SSE 接收后端逐字输出，前端按 delta 追加。
      不是"等 3 秒后整段出现" —— 那看不出是在思考还是在卡住。

   ③ **上下文感知**。读取当前路由与用户在 3D 场景中选中的车间，
   把它们作为 context 一并发给后端。用户在 3D 页点中"炼铁高炉"再问
   "这个车间排放多少"，AI 知道"这个"指谁。

   ④ **空间指令**。识别"带我去看/定位到 XX"这类指令，
   发出 `cch:twin-focus` 事件让 3D 场景飞过去。
   这是"AI 能操控空间"的最小可信实现 —— 不假装能理解任意自然语言，
   但把能做的做扎实。

   ⑤ **不阻塞主线程**。所有请求异步；浮窗本身不参与主渲染树的重排。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, nextTick, onMounted, onUnmounted, watch } = Vue;
  const h = App.h;

  const STYLE_ID = 'copilot-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
.cp-fab{position:fixed;right:22px;bottom:22px;z-index:9000;width:52px;height:52px;border-radius:50%;
  border:1px solid rgba(16,185,129,.45);background:linear-gradient(135deg,#065f46,#0f766e);
  color:#e7fff9;cursor:pointer;display:flex;align-items:center;justify-content:center;
  box-shadow:0 8px 26px rgba(0,0,0,.42),0 0 0 0 rgba(16,185,129,.5);transition:.2s}
.cp-fab:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(0,0,0,.5)}
.cp-fab:active{transform:translateY(0)}
.cp-fab.hidden{display:none}

.cp-panel{position:fixed;right:22px;bottom:22px;z-index:9001;width:min(400px,calc(100vw - 32px));
  height:min(600px,calc(100vh - 44px));display:flex;flex-direction:column;
  border:1px solid rgba(16,185,129,.28);border-radius:14px;overflow:hidden;
  background:linear-gradient(180deg,rgba(9,16,28,.97),rgba(8,14,24,.99));
  box-shadow:0 22px 60px rgba(0,0,0,.6);backdrop-filter:blur(14px);
  animation:cpIn .18s ease-out}
@keyframes cpIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}

.cp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:11px 13px;border-bottom:1px solid rgba(255,255,255,.08);flex:none}
.cp-title{display:flex;align-items:center;gap:8px;font-size:13.2px;color:var(--tx-0)}
.cp-engine{font-size:11px;font-family:var(--mono);padding:1px 7px;border-radius:999px;
  border:1px solid rgba(255,255,255,.14);color:var(--tx-3);background:rgba(255,255,255,.04);
  font-weight:400;letter-spacing:.02em;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-engine.on{border-color:rgba(16,185,129,.5);color:#6ee7b7;background:rgba(16,185,129,.12)}
.cp-dot{width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 0 rgba(16,185,129,.6);
  animation:cpPulse 2.2s infinite}
@keyframes cpPulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}70%{box-shadow:0 0 0 7px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}
.cp-x{border:0;background:none;color:var(--tx-3);cursor:pointer;font-size:16px;line-height:1;padding:4px 6px}
.cp-x:hover{color:var(--tx-0)}

.cp-body{flex:1;overflow-y:auto;padding:12px 13px;display:flex;flex-direction:column;gap:10px}
.cp-msg{font-size:12.6px;line-height:1.78;border-radius:10px;padding:9px 11px;max-width:92%;
  word-break:break-word}
.cp-msg.me{align-self:flex-end;background:rgba(16,185,129,.16);color:#d6fff4;
  border:1px solid rgba(16,185,129,.28)}
.cp-msg.ai{align-self:flex-start;background:rgba(255,255,255,.045);color:var(--tx-1);
  border:1px solid rgba(255,255,255,.07)}
.cp-msg.sys{align-self:center;background:none;color:var(--tx-3);font-size:11.4px;padding:2px}
.cp-msg.err{align-self:flex-start;background:rgba(244,63,94,.1);color:#fda4af;
  border:1px solid rgba(244,63,94,.25)}
.cp-msg code{font-family:var(--mono);font-size:11.5px;background:rgba(0,0,0,.3);padding:1px 4px;
  border-radius:4px;color:#a7f3d0}
.cp-msg strong{color:#6ee7b7;font-weight:600}
.cp-msg em{color:var(--tx-3);font-style:normal;font-size:11.5px}

.cp-cursor{display:inline-block;width:2px;height:13px;background:#10b981;
  vertical-align:-2px;margin-left:2px;animation:cpBlink .9s steps(1) infinite}
@keyframes cpBlink{50%{opacity:0}}

.cp-quick{display:flex;flex-wrap:wrap;gap:6px;padding:0 13px 10px;flex:none}
.cp-quick button{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);
  color:var(--tx-2);font-size:11.4px;padding:4px 9px;border-radius:999px;cursor:pointer;
  transition:.14s;white-space:nowrap}
.cp-quick button:hover{border-color:rgba(16,185,129,.45);color:#6ee7b7;background:rgba(16,185,129,.1)}

.cp-foot{flex:none;border-top:1px solid rgba(255,255,255,.08);padding:9px 11px;
  display:flex;gap:8px;align-items:flex-end}
.cp-input{flex:1;resize:none;border:1px solid rgba(255,255,255,.1);border-radius:9px;
  background:rgba(0,0,0,.28);color:var(--tx-0);font-size:12.6px;line-height:1.55;
  padding:7px 9px;max-height:88px;font-family:inherit;outline:none}
.cp-input:focus{border-color:rgba(16,185,129,.5)}
.cp-send{border:1px solid rgba(16,185,129,.45);background:rgba(16,185,129,.16);color:#6ee7b7;
  border-radius:9px;padding:7px 13px;font-size:12.2px;cursor:pointer;white-space:nowrap;flex:none}
.cp-send:hover:not(:disabled){background:rgba(16,185,129,.26)}
.cp-send:disabled{opacity:.4;cursor:not-allowed}

.cp-ctx{font-size:11px;color:var(--tx-3);padding:5px 13px 0;flex:none;
  display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.cp-ctx .chipx{font-family:var(--mono);background:rgba(6,182,212,.14);color:#67e8f9;
  border:1px solid rgba(6,182,212,.24);border-radius:5px;padding:1px 6px}

@media(max-width:520px){
  .cp-panel{right:8px;left:8px;bottom:8px;width:auto;height:min(70vh,560px)}
  .cp-fab{right:14px;bottom:14px}
}
`;
    document.head.appendChild(el);
  }

  /* ------------------------------------------------------------------
   * 极简 Markdown 渲染（只支持本顾问会用到的语法）
   * ------------------------------------------------------------------
   * 为什么不用第三方 md 库：顾问输出由我们自己控制，只需要
   * **粗体 / 斜体说明 / 行内代码 / 换行** 四种。引一个 30KB 的解析器
   * 为了四个语法不划算，而且第三方库通常允许 HTML 注入。
   *
   * 安全：先把 < > & 转义，再替换 ** / ` / _，因此不可能注入标签。
   */
  function renderMd(text) {
    const esc = String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return esc
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  /* ------------------------------------------------------------------
   * 空间指令识别
   * ------------------------------------------------------------------
   * 只识别**明确的**定位意图，不做模糊猜测。
   * 猜错的代价比不做更大：用户说"高炉怎么样"，我们不该擅自飞过去。
   */
  const FOCUS_PATTERNS = [
    { re: /(?:带我去|定位到|飞到|看看|切换到)\s*([^\s，。？?]+)/, kind: 'focus' },
  ];
  const WORKSHOP_ALIAS = {
    '烧结': 'WS-01', '烧结车间': 'WS-01',
    '炼铁': 'WS-02', '高炉': 'WS-02', '炼铁高炉': 'WS-02',
    '炼钢': 'WS-03', '转炉': 'WS-03', '转炉炼钢': 'WS-03',
    '轧钢': 'WS-04', '轧钢车间': 'WS-04',
    '电厂': 'WS-05', '自备电厂': 'WS-05', '发电': 'WS-05',
    '石灰': 'WS-06', '石灰窑': 'WS-06',
    '堆场': 'WS-07', '原料': 'WS-07', '原料堆场': 'WS-07',
  };

  function detectSpatialCommand(q) {
    for (const p of FOCUS_PATTERNS) {
      const m = String(q).match(p.re);
      if (!m) continue;
      const word = m[1];
      /* 精确别名匹配，或包含关系 */
      for (const [alias, id] of Object.entries(WORKSHOP_ALIAS)) {
        if (word.includes(alias) || alias.includes(word)) {
          return { kind: 'focus', workshopId: id, alias };
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------
   * 主组件
   * ------------------------------------------------------------------ */
  const CopilotPanel = defineComponent({
    name: 'copilot-panel',
    setup() {
      injectStyle();

      const open = ref(false);
      const input = ref('');
      /* LLM 连接状态：面板打开时从 /copilot/status 拉取。
       * llm=true 表示后端已接入真实大模型（可回答平台外内容）；
       * false 则为纯规则引擎（只答平台内数据），欢迎语随之切换。 */
      const llm = ref(null);            // null=未知, {configured, model, provider}
      const messages = ref([
        {
          role: 'ai',
          text: '我是碳链通的**数据助手**。我可以回答平台里真实存在的问题：\n'
            + '配额与缺口、核算批次、排放因子（含复算公式）、行业对标、链上存证状态。\n\n'
            + '_我不编造数字 —— 每个答案都来自数据库，并标注来源。_',
          done: true,
        },
      ]);
      const busy = ref(false);
      const bodyEl = ref(null);
      const inputEl = ref(null);
      const listening = ref(null);       // 当前 SSE 的清理句柄

      async function loadStatus() {
        try {
          const s = await App.API.request('GET', '/copilot/status', null, { noAuth: true });
          llm.value = s.llm || { configured: false };
          if (llm.value.configured) {
            /* 已接入真实大模型：欢迎语声明外部内容能力 */
            messages.value[0].text = '我是碳链通的 **AI 碳资产顾问**，已接入大模型（'
              + ((llm.value.provider || '') + ' ' + (llm.value.model || '')).trim() + '）。\n\n'
            + '**平台内**：配额与缺口、核算批次、排放因子、行业对标、链上存证 —— 直接查库作答，不编造数字。\n'
            + '**平台外**：碳市场政策、CBAM、CCER 方法论等行业知识 —— 由大模型结合行业语料回答。\n'
            + '**数字溯源**：回答里的每个数字都会回查数据库，查不到出处的会标黄提示。';
            extendQuickAsks();
          }
        } catch { /* 状态不可得时按未知展示，不阻塞面板 */ }
      }

      /* 上下文：从当前路由与 3D 选中态推导 */
      const ctxLabel = computed(() => {
        const parts = [];
        const p = App.Router.path;
        if (p === '/twin') parts.push({ k: '页面', v: '3D 数字孪生' });
        const sel = App.Store.copilotContext && App.Store.copilotContext.workshop;
        if (sel) parts.push({ k: '选中车间', v: sel.name });
        const bn = App.Store.copilotContext && App.Store.copilotContext.batchNo;
        if (bn) parts.push({ k: '选中批次', v: bn });
        return parts;
      });

      const quickAsks = ref([
        '我的配额还够吗？',
        '原煤的排放因子是多少？',
        '链上现在多高？账实一致吗？',
        '最近的核算批次',
        '钢铁行业的中位数排放',
      ]);

      /* LLM 就绪后补充平台外问题示例（展示外部知识能力） */
      function extendQuickAsks() {
        if (quickAsks.value.length > 5) return;
        quickAsks.value.push(
          '什么是欧盟 CBAM？对我企业有什么影响？',
          '全国碳市场扩围到哪些行业了？',
        );
      }

      function scrollBottom() {
        nextTick(() => {
          if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
        });
      }

      /** 构造 context（3D 选中车间 / 选中批次） */
      function buildContext() {
        const c = App.Store.copilotContext || {};
        const out = {};
        if (c.workshop) out.selectedWorkshop = c.workshop.name;
        if (c.workshop && c.workshop.id) out.selectedWorkshopId = c.workshop.id;
        if (c.batchNo) out.selectedBatchNo = c.batchNo;
        out.view = App.Router.path;
        return out;
      }

      /**
       * 发送问题。
       *
       * 用 fetch + ReadableStream 手工解析 SSE，而不用 EventSource ——
       * EventSource 只支持 GET，而我们需要 POST 带 body 与 Authorization 头。
       */
      async function send(text) {
        const q = String(text || input.value || '').trim();
        if (!q || busy.value) return;
        input.value = '';
        messages.value.push({ role: 'me', text: q, done: true });
        scrollBottom();

        /* 空间指令：先执行，再让 AI 解释 —— 这样"带我去看炼铁高炉"
         * 会真的飞过去，而不是只回一句"好的" */
        const spatial = detectSpatialCommand(q);
        if (spatial) {
          const ws = App.Twin3D && App.Twin3D.DEFAULT_LAYOUT.find((x) => x.id === spatial.workshopId);
          if (ws) {
            window.dispatchEvent(new CustomEvent('cch:twin-focus', { detail: { workshopId: ws.id } }));
            messages.value.push({ role: 'sys', text: `已定位到「${ws.name}」`, done: true });
            scrollBottom();
            /* 纯导航指令不必再调 AI */
            if (!/多少|怎样|如何|排放|能耗|为什么/.test(q)) return;
          }
        }

        busy.value = true;
        const aiMsg = { role: 'ai', text: '', done: false, tools: [] };
        messages.value.push(aiMsg);
        scrollBottom();

        const token = App.Store.token;
        try {
          const res = await fetch(App.API.base + '/copilot/stream', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: 'Bearer ' + token } : {}),
            },
            body: JSON.stringify({ question: q, context: buildContext() }),
          });

          if (!res.ok || !res.body) {
            throw new Error(`服务返回 ${res.status}`);
          }

          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';

          /* 逐块读取并解析 SSE。
           * 分隔符是空行（\n\n）；一个事件可能被拆在多个 TCP 块里，
           * 因此必须用缓冲区累积而不是假设"每次 read 恰好是一个事件"。 */
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });

            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const evM = raw.match(/^event: (\w+)/m);
              const dataM = raw.match(/^data: ([\s\S]*)$/m);
              if (!evM || !dataM) continue;
              const ev = evM[1];
              let payload = null;
              try { payload = JSON.parse(dataM[1]); } catch { continue; }

              if (ev === 'status') {
                if (payload.phase === 'plan' && payload.intents && payload.intents.length) {
                  aiMsg.tools = payload.intents;
                }
              } else if (ev === 'delta') {
                aiMsg.text += payload.text || '';
                scrollBottom();
              } else if (ev === 'done') {
                aiMsg.done = true;
                aiMsg.tools = (payload.tools || []).map((t) => (t && t.tool) || t).filter(Boolean);
                aiMsg.grounding = payload.grounding || null;
                aiMsg.backend = (payload.engine && payload.engine.backend) || payload.backend || null;
              } else if (ev === 'error') {
                aiMsg.role = 'err';
                aiMsg.text = '顾问服务出错：' + (payload.message || '未知错误');
                aiMsg.done = true;
              }
            }
          }
          aiMsg.done = true;
        } catch (e) {
          aiMsg.role = 'err';
          aiMsg.text = '无法连接顾问服务：' + (e.message || e)
            + '\n\n_请确认后端已启动，或稍后重试。_';
          aiMsg.done = true;
        } finally {
          busy.value = false;
          scrollBottom();
        }
      }

      function onKeydown(e) {
        /* Enter 发送，Shift+Enter 换行 —— 输入长问题时需要换行 */
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }

      function toggle() {
        open.value = !open.value;
        if (open.value) {
          if (!llm.value) loadStatus();
          scrollBottom();
          nextTick(() => { if (inputEl.value) inputEl.value.focus(); });
        }
      }

      /* 供外部（如页面按钮）打开顾问并预填问题 */
      function openWith(q) {
        open.value = true;
        nextTick(() => { if (q) send(q); });
      }
      onMounted(() => {
        window.__cchCopilotOpen = openWith;
      });
      onUnmounted(() => {
        if (window.__cchCopilotOpen === openWith) delete window.__cchCopilotOpen;
      });

      return () => {
        const fab = h('button', {
          class: ['cp-fab', open.value ? 'hidden' : ''],
          title: 'AI 碳资产顾问（Ctrl+K）',
          onClick: toggle,
        }, [
          h('x-icon', { name: 'spark', size: 22 }),
        ]);

        if (!open.value) return fab;

        return h('div', { class: 'cp-panel' }, [
          h('div', { class: 'cp-head' }, [
            h('div', { class: 'cp-title' }, [
              h('span', { class: 'cp-dot' }),
              'AI 碳资产顾问',
              /* 引擎徽标：大模型已接入时亮绿色（可答平台外内容），
               * 否则灰色"规则引擎"。状态未知时不渲染，避免闪烁。 */
              llm.value
                ? h('span', {
                  class: 'cp-engine' + (llm.value.configured ? ' on' : ''),
                  /* 徽标展示"哪家大模型在答"，悬停给出备用链与失败原因 ——
                   * 这是可观测性的一部分：用户有权知道回答来自哪一家，
                   * 也才有能力判断"数字不对是不是模型换了"。 */
                  title: llm.value.configured
                    ? `当前模型：${llm.value.provider || ''} ${llm.value.model || ''}`
                      + (llm.value.fallbacks && llm.value.fallbacks.length
                        ? `；备用：${llm.value.fallbacks.join(' / ')}` : '；无备用模型')
                      + '。平台数据由规则引擎查库，模型只负责组织语言。'
                    : (llm.value.reason || '未配置大模型密钥，当前为内置规则引擎（仅平台内数据）'),
                }, llm.value.configured
                  ? (llm.value.provider ? `${llm.value.provider}` : (llm.value.model || 'LLM'))
                  : '规则引擎')
                : null,
            ]),
            h('button', { class: 'cp-x', title: '收起', onClick: toggle }, '✕'),
          ]),

          ctxLabel.value.length
            ? h('div', { class: 'cp-ctx' }, [
              h('span', {}, '上下文：'),
              ctxLabel.value.map((c) => h('span', { class: 'chipx' }, `${c.k}=${c.v}`)),
            ])
            : null,

          h('div', { class: 'cp-body', ref: bodyEl },
            messages.value.map((m) => h('div', {
              class: ['cp-msg', m.role === 'me' ? 'me' : (m.role === 'err' ? 'err' : (m.role === 'sys' ? 'sys' : 'ai'))],
            }, [
              m.role === 'me' || m.role === 'sys'
                ? h('span', {}, m.text)
                : h('span', { innerHTML: renderMd(m.text) + (m.done ? '' : '<span class="cp-cursor"></span>') }),
              (m.role === 'ai' && m.tools && m.tools.length && m.done)
                ? h('div', { style: 'margin-top:6px;font-size:11px;color:var(--tx-3);font-family:var(--mono)' },
                  '工具：' + m.tools.join(' · '))
                : null,
              /* 数字溯源徽标：把"这句话里的数字有没有出处"变成可见信号。
               * 全通过 → 绿色 + 通过数；有未命中 → 橙色 + 具体数字。
               * 这比在回答末尾加一行灰字更有用 —— 灰字会被跳过。 */
              (m.role === 'ai' && m.done && m.grounding && !m.grounding.skipped)
                ? h('div', {
                  title: m.grounding.unverified && m.grounding.unverified.length
                    ? '未在平台数据中找到出处：' + m.grounding.unverified.map((u) => u.raw).join('、')
                    : '正文数字均可在平台数据中找到出处',
                  style: 'margin-top:5px;font-size:11px;font-family:var(--mono);display:inline-block;'
                    + 'padding:1px 7px;border-radius:999px;border:1px solid '
                    + (m.grounding.unverified && m.grounding.unverified.length
                      ? 'rgba(245,165,36,.45);color:#f5a524;background:rgba(245,165,36,.1)'
                      : 'rgba(16,185,129,.4);color:#6ee7b7;background:rgba(16,185,129,.1)'),
                }, m.grounding.unverified && m.grounding.unverified.length
                  ? `⚠ 数字溯源 ${m.grounding.verified}/${m.grounding.total}（${m.grounding.unverified.length} 个无出处）`
                  : `✓ 数字溯源 ${m.grounding.verified}/${m.grounding.total} 通过`)
                : null,
            ]))),

          h('div', { class: 'cp-quick' },
            quickAsks.value.map((q) => h('button', {
              onClick: () => send(q),
              disabled: busy.value,
            }, q))),

          h('div', { class: 'cp-foot' }, [
            h('textarea', {
              class: 'cp-input',
              ref: inputEl,
              rows: 1,
              placeholder: busy.value ? '正在回答…' : '问点什么（Enter 发送，Shift+Enter 换行）',
              value: input.value,
              onInput: (e) => { input.value = e.target.value; },
              onKeydown,
              disabled: busy.value,
            }),
            h('button', {
              class: 'cp-send',
              onClick: () => send(),
              disabled: busy.value || !input.value.trim(),
            }, busy.value ? '…' : '发送'),
          ]),
        ]);
      };
    },
  });

  /* 全局快捷键 Ctrl+K / Cmd+K */
  function bindHotkey() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (window.__cchCopilotOpen) window.__cchCopilotOpen();
      }
    });
  }
  bindHotkey();

  App.Copilot = CopilotPanel;
})();
