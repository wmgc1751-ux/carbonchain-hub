/**
 * routes/copilot.js —— AI 碳资产顾问 API（v3：多模型网关 + 规则引擎取数 + 数字溯源）
 * ==================================================================================
 * 端点：
 *   GET  /api/copilot/status          引擎状态（公开）：当前后端、可用服务商、熔断状态
 *   GET  /api/copilot/providers       支持的服务商清单与接入方式（公开）
 *   GET  /api/copilot/capabilities    能力清单 + 示例问题（公开）
 *   POST /api/copilot/ask             提问（JSON）
 *   POST /api/copilot/stream          流式回答（SSE）
 *   POST /api/copilot/config          运行期接入/切换模型（管理员）
 *   POST /api/copilot/probe           探测各服务商连通性（管理员）
 *
 * 【v3 架构：取数与说话分离】
 *
 *   用户提问
 *     ↓
 *   ① 规则引擎识别意图 → 调工具查库（carbonCopilot）—— **数字只从这里来**
 *     ↓
 *   ② 有可用大模型？
 *     ├─ 有 → 工具结果作为【平台实时数据】注入 → 大模型组织语言
 *     │        ↓
 *     │   ③ 数字溯源校验（grounding）：正文每个数字回查工具结果
 *     │        ├─ 全命中 → 末附「数字溯源通过」
 *     │        └─ 有未命中 → 末附明确告警，指出哪几个数查不到出处
 *     └─ 无 → 规则引擎模板回答（平台内问题照常可答，服务永不中断）
 *
 * 【为什么"无模型"也要能答】
 *   评审现场可能没有外网、密钥可能过期。规则引擎是**兜底而非降级**：
 *   它对平台内问题（配额/缺口/批次/因子/链状态）给出的是数据库原文，
 *   比任何模型复述都更可信。大模型带来的增量是"平台外知识 + 更自然的表达"。
 *
 * @module routes/copilot
 */
'use strict';

const express = require('express');
const { authRequired, authOptional, requireRole, ok, fail, wrap } = require('../middleware/auth');
const CP = require('../services/carbonCopilot');
const LLM = require('../services/llmClient');
const G = require('../services/grounding');

const router = express.Router();

/* ---------------------------------------------------------------------------------
 * 状态（公开）
 * ---------------------------------------------------------------------------------
 * ⚠ 字段契约：前端读 `llm.configured / llm.model`（public/js/views/copilot.js）。
 *   v2 曾经只返回扁平的 llmEnabled/llmModel，前端读 s.llm 恒为 undefined，
 *   于是"已接入大模型"时徽标仍显示「规则引擎」—— 配了 key 也看不出来。
 *   现在同时给出嵌套 llm 与扁平旧字段，两代前端都能正确显示。
 */
router.get('/status', async (req, res) => {
  /* 先刷新本地端点可达性（结果缓存 60 秒），再取快照 ——
   * 否则机器上没跑 Ollama 也会被报成「已接入大模型」。 */
  try { await LLM.refreshLocal('ollama'); } catch { /* 探测失败按未配置处理 */ }
  const s = LLM.snapshot();
  ok(res, {
    /* —— 新契约 —— */
    llm: {
      configured: s.configured,
      provider: s.provider,
      providerId: s.providerId,
      model: s.model,
      backend: s.backend,
      fallbacks: s.fallbacks,
      reason: s.reason,
    },
    providers: LLM.listProviders().map((p) => ({
      id: p.id, name: p.name, model: p.model, hasKey: p.hasKey,
      active: p.active, docs: p.docs, note: p.note, keyOptional: p.keyOptional,
    })),
    ruleEngine: true,
    grounding: {
      enabled: true,
      policy: '正文数字逐个回查工具查询结果；无平台数据参与的回答不启用（避免误报）',
    },
    breaker: LLM.breakerSnapshot(),

    /* —— 旧契约（v2 前端 / 第三方脚本仍在用）—— */
    llmEnabled: s.configured,
    llmModel: s.configured ? s.model : null,
    llmProvider: s.configured ? s.provider : null,
    fallback: s.configured
      ? '大模型均不可用时自动降级到规则引擎（数据仍来自平台真实数据库）'
      : (s.reason || '未配置大模型，当前为规则引擎'),
    externalKnowledge: s.configured
      ? '可回答平台外的碳中和、政策、技术问题'
      : '仅限平台内数据（未配置大模型密钥）',
  });
});

/* ---------------------------------------------------------------------------------
 * 服务商清单（公开 —— 让人知道"这套系统能接哪几家"，且不泄漏任何密钥）
 * --------------------------------------------------------------------------------- */
router.get('/providers', (req, res) => {
  const s = LLM.snapshot();
  ok(res, {
    protocol: 'OpenAI chat/completions 兼容',
    activeId: s.providerId,
    chain: s.chain.map((c) => c.id),
    items: LLM.listProviders().map((p) => ({
      id: p.id, name: p.name, defaultModel: p.model, docs: p.docs,
      configured: p.hasKey, active: p.active, note: p.note,
    })),
    configKeys: [
      'LLM_PROVIDER  指定服务商（可选，缺省自动探测）',
      'DEEPSEEK_API_KEY / ZHIPU_API_KEY / DASHSCOPE_API_KEY / MOONSHOT_API_KEY …',
      'LLM_API_KEY + LLM_BASE_URL  自定义/私有化端点',
      'LLM_MODEL     覆盖默认模型名',
    ],
  });
});

/* ---------------------------------------------------------------------------------
 * 能力清单（公开）
 * --------------------------------------------------------------------------------- */
router.get('/capabilities', (req, res) => {
  ok(res, CP.capabilities());
});

/* ---------------------------------------------------------------------------------
 * 内部：把模型回答接上溯源声明
 * --------------------------------------------------------------------------------- */
function withGrounding(text, ruleResult, question) {
  const facts = (ruleResult.tools || [])
    .filter((t) => t.ok && t.data)
    .map((t) => t.data);

  /* 没有平台数据参与（如纯概念/政策问答）→ 不做数字溯源。
   * 拿空事实集去比，会把「GB/T 32150」「2026 年」全部判成无出处 ——
   * 那是把"无法比较"误报成"比较失败"。 */
  if (!facts.length) {
    return { text, grounding: { skipped: true, reason: '本次回答未引用平台数据，数字溯源不适用' } };
  }

  const g = G.verify(text, [ruleResult.answer, ...facts], { question });
  return { text: text + G.footnote(g), grounding: g };
}

/** 对外精简 tools（去掉原始 data，降低响应体积） */
function slimTools(tools) {
  return (tools || []).map((t) => ({
    tool: t.tool, args: t.args, ok: t.ok, source: t.source,
  }));
}

/* ---------------------------------------------------------------------------------
 * 提问（JSON）
 * --------------------------------------------------------------------------------- */
router.post('/ask', authOptional, wrap(async (req, res) => {
  const b = req.body || {};
  const question = String(b.question || '').slice(0, 500);
  try {
    /* ① 取数（永远先查库，数字唯一来源） */
    const ruleResult = await CP.ask({
      question, user: req.user, context: b.context || {},
    });

    /* ② 说话（有模型才走） */
    const snap = LLM.snapshot();
    if (snap.configured) {
      try {
        const context = b.context || {};
        const dataBlock = (ruleResult.tools || []).some((t) => t.ok)
          ? '\n\n【平台实时数据（唯一可信数字来源）】\n' + ruleResult.answer
          : '';

        const r = await LLM.chat(
          [{ role: 'user', content: question }],
          {
            system: LLM.buildSystemPrompt({ user: req.user, workshop: context.workshop || null }) + dataBlock,
            temperature: 0.5,
          },
        );

        if (r.text) {
          const { text, grounding } = withGrounding(r.text, ruleResult, question);
          return ok(res, {
            answer: text,
            intents: ruleResult.intents || [],
            tools: slimTools(ruleResult.tools),
            grounding,
            engine: {
              kind: 'llm+tools',
              provider: r.provider,
              providerId: r.providerId,
              model: r.model,
              backend: r.backend,
              attempts: r.attempts,
              dataFrom: (ruleResult.tools || []).filter((t) => t.ok).map((t) => t.tool),
            },
            generatedAt: new Date().toISOString(),
          });
        }
      } catch (llmErr) {
        /* ③ 模型全挂 → 规则引擎结果照常返回，且如实标注失败原因 */
        ruleResult.engine = {
          ...(ruleResult.engine || {}),
          kind: 'rule-based (llm-failed)',
          llmError: String(llmErr.message).slice(0, 200),
          attempts: llmErr.attempts || null,
          fallback: '大模型调用失败，已降级到规则引擎（数字仍来自数据库）',
        };
      }
    }

    ruleResult.tools = slimTools(ruleResult.tools);
    ok(res, ruleResult);
  } catch (e) {
    fail(res, '顾问服务异常：' + e.message, 500);
  }
}));

/* ---------------------------------------------------------------------------------
 * 流式回答（SSE）
 * ---------------------------------------------------------------------------------
 * ⚠ 这里**不使用 wrap()**。原因：
 *   wrap() 的实现是 `fn(...).catch(next)`，它期望 fn 返回一个 Promise 并让
 *   Express 在 Promise 结束后继续走中间件链。而 SSE 是长连接 —— 我们在函数内部
 *   手动 `res.writeHead` 并保持连接，函数"返回"时响应还没结束。
 *   实测后果：包在 wrap 里时只发出第一帧（status: intent）就被中断。
 *
 * 事件序列：
 *   event: status   逐步状态（取数 / 选择模型 / 换家重试）
 *   event: delta    正文增量（逐字）
 *   event: done     结束（含 tools / grounding / backend）
 *   event: error    出错
 */
router.post('/stream', authOptional, async (req, res) => {
  const b = req.body || {};

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* 客户端已断开 */ }
  };

  /* 心跳：防止中间层（代理/网关）因空闲超时断开。20 秒一次 —— 短于多数
   * 默认的 30~60 秒空闲超时。 */
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* 已断开 */ }
  }, 20000);

  let closed = false;

  /* ⚠⚠ 必须监听 **res** 的 close，不是 req 的 close。
   * Node 的 `req.on('close')` 在**请求体被读完**时就触发（即 handler 刚开始执行
   * 的时刻），用它判"客户端是否断开"会导致第一帧之后 closed=true，流只剩一帧。
   * 正确判据是 `res.on('close')` —— 响应流真正关闭时才触发。 */
  res.on('close', () => { closed = true; clearInterval(hb); });

  /* 规则引擎回答的"打字机"输出：模型不可用时用它兜底 */
  const typeOut = async (text) => {
    const CHUNK = 3;
    for (let i = 0; i < text.length; i += CHUNK) {
      if (closed) return;
      send('delta', { text: text.slice(i, i + CHUNK), index: i });
      await new Promise((r) => setTimeout(r, 12));
    }
  };

  try {
    send('status', { phase: 'intent', message: '正在理解问题…' });

    const intents = CP.detectIntent(b.question || '');
    if (intents.length) {
      send('status', {
        phase: 'plan',
        message: `将查询：${intents.map((i) => i.tool).join('、')}`,
        intents: intents.map((i) => i.tool),
      });
    }

    /* ① 取数 */
    const r = await CP.ask({
      question: b.question,
      user: req.user,
      context: b.context || {},
    });
    if (closed) return;

    const snap = LLM.snapshot();

    /* ② 说话 */
    if (snap.configured) {
      send('status', {
        phase: 'llm',
        message: `正在调用 ${snap.provider}（${snap.model}）生成回答…`,
        provider: snap.providerId, model: snap.model,
        fallbacks: snap.fallbacks,
      });

      try {
        const dataBlock = (r.tools || []).some((t) => t.ok)
          ? '\n\n【平台实时数据（唯一可信数字来源）】\n' + r.answer
          : '';

        const out = await LLM.chatStream(
          [{ role: 'user', content: String(b.question || '') }],
          (chunk) => { if (!closed) send('delta', { text: chunk }); },
          {
            system: LLM.buildSystemPrompt({
              user: req.user,
              workshop: (b.context || {}).workshop || null,
            }) + dataBlock,
            temperature: 0.5,
          },
        );

        if (closed) return;

        /* ③ 溯源（换家时如实告知：用户有权知道回答来自哪一家） */
        const { text, grounding } = withGrounding(out.fullText, r, b.question);
        if (out.degraded) {
          send('status', {
            phase: 'failover',
            message: `首选模型不可用，已切换到 ${out.provider}`,
            attempts: out.attempts,
          });
        }
        const extra = grounding.skipped ? '' : G.footnote(grounding);
        if (extra) send('delta', { text: extra });

        send('done', {
          engine: {
            kind: 'llm+tools', provider: out.provider, providerId: out.providerId,
            model: out.model, backend: out.backend, attempts: out.attempts,
            degraded: out.degraded,
          },
          intents: r.intents,
          tools: slimTools(r.tools),
          grounding,
          fullLength: String(text).length,
        });
      } catch (llmErr) {
        /* 模型全挂 → 规则引擎流式输出。注意：若模型已吐了半句再中断，
         * 这里再接规则引擎全文会造成"两段回答"，因此先告知中断位置。 */
        const partial = llmErr.partial
          ? `\n\n_（模型在输出过程中中断，以下为平台规则引擎给出的确定性回答）_\n\n`
          : '';
        send('status', {
          phase: 'fallback',
          message: llmErr.partial
            ? '模型输出中断，切换到规则引擎'
            : '大模型不可用，切换到规则引擎',
          attempts: llmErr.attempts || null,
        });

        if (partial) send('delta', { text: partial });
        await typeOut(String(r.answer || ''));

        send('done', {
          intents: r.intents,
          tools: slimTools(r.tools),
          boundary: !!r.boundary,
          engine: {
            kind: 'rule-based (llm-failed)',
            llmError: String(llmErr.message).slice(0, 200),
            attempts: llmErr.attempts || null,
          },
        });
      }
    } else {
      /* 无模型 → 规则引擎（平台内问题的主路径，不是降级） */
      send('status', {
        phase: 'answer',
        message: snap.reason || '未配置大模型，使用规则引擎作答',
      });
      await typeOut(String(r.answer || ''));
      send('done', {
        intents: r.intents,
        tools: slimTools(r.tools),
        boundary: !!r.boundary,
        engine: r.engine,
        llm: { configured: false, reason: snap.reason },
      });
    }
  } catch (e) {
    send('error', { message: String(e.message || e) });
  } finally {
    clearInterval(hb);
    try { res.end(); } catch { /* ignore */ }
  }
});

/* ---------------------------------------------------------------------------------
 * 运行期接入 / 切换模型（管理员）
 * ---------------------------------------------------------------------------------
 * 用途：评审现场或部署环境不方便改文件时，直接在页面/命令行贴一个 key 即可接入。
 * 密钥只存进程内存：不落盘、不进库、重启即失效 —— 避免"临时演示"变成
 * "明文凭据长期留在服务器上"。
 */
router.post('/config', authRequired, requireRole('ADMIN'), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.provider !== undefined && b.provider !== null) {
    const okIds = LLM.listProviders().map((p) => p.id);
    if (b.provider && !okIds.includes(b.provider)) {
      return fail(res, `未知服务商 ${b.provider}；可选：${okIds.join(', ')}`, 400);
    }
  }
  LLM.applyRuntime({
    provider: b.provider,
    apiKey: b.apiKey,
    baseUrl: b.baseUrl,
    model: b.model,
  });
  const s = LLM.snapshot();
  ok(res, {
    applied: true,
    llm: { configured: s.configured, provider: s.provider, model: s.model, backend: s.backend },
    note: '密钥仅存于本进程内存，重启后失效；长期接入请写入 .env（见 .env.example）',
  });
}));

/* ---------------------------------------------------------------------------------
 * 连通性探测（管理员）
 * --------------------------------------------------------------------------------- */
router.post('/probe', authRequired, requireRole('ADMIN'), wrap(async (req, res) => {
  const b = req.body || {};
  const targets = b.provider
    ? [b.provider]
    : LLM.listProviders().filter((p) => p.hasKey).map((p) => p.id);

  if (!targets.length) {
    return ok(res, {
      probed: [],
      hint: '没有任何服务商配置了密钥。可用 POST /api/copilot/config 临时接入，'
        + '或在 .env 写入 DEEPSEEK_API_KEY / ZHIPU_API_KEY 等。',
    });
  }

  const results = [];
  for (const id of targets) {
    /* 串行探测：并行会同时打满本机 DNS/连接池，弱网下反而更容易误判超时 */
    results.push(await LLM.probe(id));
  }
  ok(res, { probed: results });
}));

module.exports = router;
