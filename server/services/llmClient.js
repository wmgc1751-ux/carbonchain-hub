/**
 * llmClient.js —— 多服务商 LLM 网关（OpenAI 兼容协议 + 故障转移 + 熔断）
 * ==================================================================================
 * 【定位】
 *
 * 本模块只做一件事：把「一组对话消息」变成「一段文字」。
 * 它**不负责取数** —— 平台数据一律由 carbonCopilot 的工具查库得到，
 * 再作为上下文注入（见 routes/copilot.js）。这个分工是刻意的：
 * 语言模型永远不碰数据库，因此它永远没有机会"编造一个排放量"。
 *
 * 【与上一版的差别（三处修正）】
 *
 *   ① 多服务商：由 llmProviders.resolveChain() 产出可用链，按优先级尝试；
 *      第一家 5xx / 超时 / 鉴权失败 → 自动让下一家接，回答里如实标注换了家。
 *   ② 熔断：某家连续失败 2 次，冷却 60 秒内不再尝试 —— 避免每次提问都先
 *      撞一次已经挂掉的端点，把 3 秒的回答拖成 20 秒。
 *   ③ 流式故障转移：只在**尚未吐出任何字符**时换家。已经吐了半句再换家，
 *      用户会看到两段拼接的、彼此矛盾的文字 —— 那比直接失败更糟。
 *
 * 【支持的协议差异】
 *   绝大多数服务商与 OpenAI 一致；已适配两处真实差异：
 *   · 部分端点不支持 `stream:true`（返回 JSON 而非 SSE）→ 自动退化为整段返回；
 *   · 部分端点要求 `max_tokens` 有下限、或忽略该字段 → 不在客户端强校验。
 *
 * @module services/llmClient
 */
'use strict';

const P = require('./llmProviders');

/* ==================================================================================
 * 一、熔断器
 * ==================================================================================
 * 状态放进程内存：这是"这一台机器此刻的可用性"，不是持久事实。
 * 重启后重新探测是对的 —— 网络环境会变（代理开关、VPN、欠费充值）。
 */
const breaker = new Map();   // providerId -> { fails, openUntil, lastError }
const COOLDOWN_MS = 60_000;
const FAIL_THRESHOLD = 2;

function breakerOf(id) {
  if (!breaker.has(id)) breaker.set(id, { fails: 0, openUntil: 0, lastError: null });
  return breaker.get(id);
}

function markFail(id, err) {
  const b = breakerOf(id);
  b.fails += 1;
  b.lastError = String(err && err.message || err).slice(0, 200);
  if (b.fails >= FAIL_THRESHOLD) b.openUntil = Date.now() + COOLDOWN_MS;
}

function markOk(id) {
  const b = breakerOf(id);
  b.fails = 0;
  b.openUntil = 0;
  b.lastError = null;
}

function isOpen(id) {
  const b = breakerOf(id);
  return b.openUntil > Date.now();
}

/** 熔断器快照（doctor / status 用） */
function breakerSnapshot() {
  const out = {};
  for (const [k, v] of breaker.entries()) {
    out[k] = {
      fails: v.fails,
      open: v.openUntil > Date.now(),
      openForSec: v.openUntil > Date.now() ? Math.ceil((v.openUntil - Date.now()) / 1000) : 0,
      lastError: v.lastError,
    };
  }
  return out;
}

/** 清空熔断状态（自测用；也用于"用户刚充了钱/换了网络，立刻重试"的场景） */
function resetBreakers() {
  breaker.clear();
}

/* ==================================================================================
 * 二、配置（向后兼容旧接口）
 * ================================================================================== */

/** @deprecated 保留旧签名；新代码用 P.snapshot() */
function getConfig() {
  const s = P.snapshot();
  return {
    apiKey: s.configured ? '__configured__' : null,
    baseUrl: s.baseUrl || '',
    model: s.model || '',
    timeoutMs: Number(P.readEnv('LLM_TIMEOUT_MS')) || 30000,
    maxTokens: Number(P.readEnv('LLM_MAX_TOKENS')) || 2048,
    provider: s.provider,
    providerId: s.providerId,
  };
}

function isConfigured() {
  return P.snapshot().configured;
}

/* ==================================================================================
 * 三、非流式对话（带故障转移）
 * ================================================================================== */

/**
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} [opts] { system, temperature, maxTokens, timeoutMs, prefer }
 * @returns {Promise<{text:string, model:string, provider:string, providerId:string,
 *                    backend:string, attempts:Array}>}
 */
async function chat(messages, opts = {}) {
  const { chain, reason } = P.resolveChain();
  if (!chain.length) throw new Error(reason || 'LLM 未配置');

  const attempts = [];
  const ordered = opts.prefer
    ? [...chain].sort((a, b) => (a.id === opts.prefer ? -1 : b.id === opts.prefer ? 1 : 0))
    : chain;

  for (const c of ordered) {
    if (isOpen(c.id) && ordered.length > 1) {
      attempts.push({ providerId: c.id, provider: c.name, skipped: 'circuit-open' });
      continue;
    }
    const t0 = Date.now();
    try {
      const body = {
        model: c.model,
        messages: opts.system ? [{ role: 'system', content: opts.system }, ...messages] : messages,
        temperature: opts.temperature ?? 0.5,
        max_tokens: opts.maxTokens || c.maxTokens,
        stream: false,
      };
      const text = await once(c, body, opts.timeoutMs || c.timeoutMs);
      if (!text || !text.trim()) throw new Error('返回空内容');
      markOk(c.id);
      attempts.push({ providerId: c.id, provider: c.name, model: c.model, ok: true, ms: Date.now() - t0 });
      return {
        text: text.trim(),
        model: c.model,
        provider: c.name,
        providerId: c.id,
        backend: `${c.id}:${c.model}`,
        attempts,
      };
    } catch (e) {
      markFail(c.id, e);
      attempts.push({
        providerId: c.id, provider: c.name, model: c.model, ok: false,
        ms: Date.now() - t0, error: String(e.message || e).slice(0, 160),
      });
    }
  }

  const err = new Error('全部模型均不可用：'
    + attempts.map((a) => `${a.provider}${a.skipped ? '(熔断)' : '→' + (a.error || '')}`).join('; '));
  err.attempts = attempts;
  throw err;
}

async function once(c, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
    }
    const j = await res.json();
    /* 推理类模型（如 DeepSeek V4-Pro）把思考过程放在 reasoning_content、
     * 正文仍可能为空（尤其是 max_tokens 被思考吃光时）。仅当正文为空才回退，
     * 避免把思考过程混进正常回答。 */
    const m = j.choices?.[0]?.message;
    return m?.content || m?.reasoning_content || j.choices?.[0]?.text || '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`超时 ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ==================================================================================
 * 四、流式对话（SSE，带「首字前」故障转移）
 * ================================================================================== */

/**
 * @param {Array} messages
 * @param {function} onChunk (text) => void
 * @param {object} [opts]
 * @returns {Promise<{fullText, model, provider, providerId, backend, attempts, degraded}>}
 */
async function chatStream(messages, onChunk, opts = {}) {
  const { chain, reason } = P.resolveChain();
  if (!chain.length) throw new Error(reason || 'LLM 未配置');

  const attempts = [];

  for (let i = 0; i < chain.length; i += 1) {
    const c = chain[i];
    if (isOpen(c.id) && chain.length > 1) {
      attempts.push({ providerId: c.id, provider: c.name, skipped: 'circuit-open' });
      continue;
    }
    const t0 = Date.now();
    let emitted = 0;
    try {
      const out = await streamOnce(c, messages, opts, (piece) => {
        emitted += piece.length;
        if (onChunk) onChunk(piece);
      });
      markOk(c.id);
      attempts.push({ providerId: c.id, provider: c.name, model: c.model, ok: true, ms: Date.now() - t0 });
      return {
        fullText: out, model: c.model, provider: c.name, providerId: c.id,
        backend: `${c.id}:${c.model}`, attempts, degraded: i > 0,
      };
    } catch (e) {
      markFail(c.id, e);
      attempts.push({
        providerId: c.id, provider: c.name, model: c.model, ok: false,
        ms: Date.now() - t0, error: String(e.message || e).slice(0, 160),
        partialChars: emitted,
      });
      /* 已经吐字 → 不换家（否则两段文字会拼接，读者无法分辨哪句可信） */
      if (emitted > 0) {
        const err = new Error(`${c.name} 在输出过程中中断（已输出 ${emitted} 字）：${e.message}`);
        err.attempts = attempts;
        err.partial = true;
        throw err;
      }
    }
  }

  const err = new Error('全部模型均不可用：'
    + attempts.map((a) => `${a.provider}${a.skipped ? '(熔断)' : '→' + (a.error || '')}`).join('; '));
  err.attempts = attempts;
  throw err;
}

async function streamOnce(c, messages, opts, onChunk) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts.timeoutMs || c.timeoutMs) * 2);
  try {
    const body = {
      model: c.model,
      messages: opts.system ? [{ role: 'system', content: opts.system }, ...messages] : messages,
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.maxTokens || c.maxTokens,
      stream: true,
    };
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
    }

    const ctype = res.headers.get('content-type') || '';
    /* 端点不支持流式 → 直接是一整包 JSON。某些兼容实现会忽略 stream 字段，
     * 此时若按 SSE 解析会得到空字符串，看起来像"模型没回答"。 */
    if (!ctype.includes('event-stream') || !res.body) {
      const j = await res.json();
      const m = j.choices?.[0]?.message;
      const text = m?.content || m?.reasoning_content || j.choices?.[0]?.text || '';
      if (text) onChunk(text);
      return text;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let full = '';
    let buf = '';
    /* 推理模型的思考流先于正文到达：先缓存不发出，等正文首字到达即丢弃缓存，
     * 只有整段都没有正文时才回退输出思考内容（否则用户会先看到一段"内心独白"）。 */
    let reasoning = '';
    let sawContent = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { buf = ''; break; }
        try {
          const j = JSON.parse(payload);
          const d = j.choices?.[0]?.delta || {};
          if (d.content) {
            sawContent = true;
            reasoning = '';
            full += d.content;
            onChunk(d.content);
          } else if (d.reasoning_content) {
            reasoning += d.reasoning_content;
          }
        } catch { /* 心跳行 / 半包，跳过 */ }
      }
    }
    if (!sawContent && reasoning) { full = reasoning; onChunk(reasoning); }
    return full;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`流式超时 ${(opts.timeoutMs || c.timeoutMs) * 2}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ==================================================================================
 * 五、连通性探测（doctor / admin 接口用）
 * ==================================================================================
 * 探测的是 `GET {baseUrl}/models`，不是自己编一个请求。
 * 理由：/models 是 OpenAI 兼容协议里唯一"只读、零成本、能暴露鉴权错误"的端点。
 * 它同时给出这家**实际可用模型清单**，避免我们写死的默认模型名过期。
 */
async function probe(providerId, timeoutMs = 8000) {
  const p = P.findProvider(providerId);
  if (!p) return { ok: false, error: `未知服务商 ${providerId}` };

  const chain = P.resolveChain().chain.filter((c) => c.id === providerId);
  const c = chain[0] || (() => {
    /* 未配密钥也允许探测端点可达性（只测网络与端点，不测鉴权） */
    return { id: p.id, name: p.name, baseUrl: p.baseUrl.replace(/\/+$/, ''), model: p.model, apiKey: null };
  })();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${c.baseUrl}/models`, {
      headers: c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
      signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { providerId, ok: false, ms, status: res.status, error: t.slice(0, 160),
        hint: res.status === 401 ? '密钥无效或已过期' : res.status === 404 ? '端点不提供 /models（协议兼容但非标准）' : null };
    }
    const j = await res.json().catch(() => ({}));
    const models = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    return { providerId, ok: true, ms, models: models.slice(0, 50), modelCount: models.length,
      defaultModelPresent: models.length ? models.includes(c.model) : null };
  } catch (e) {
    return { providerId, ok: false, ms: Date.now() - t0,
      error: e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ==================================================================================
 * 六、系统提示词
 * ==================================================================================
 * 三条硬约束写在提示词里，且每条都对应后端的一道检查（不是只靠"请勿编造"）：
 *   · 只能引用【平台数据】里的数字  → grounding.verify() 事后核对
 *   · 平台外知识要标明来源性质      → 提示词要求"据公开资料"
 *   · 不确定就说不确定             → 展示层保留原话
 */
function buildSystemPrompt(platformContext) {
  const s = P.snapshot();
  const lines = [
    '你是「碳链通 CarbonChainHub」平台的 AI 碳资产顾问。',
    '',
    '## 回答边界',
    '1. **若用户消息附带【平台实时数据】：正文里出现的每一个数字，都必须是其中原样存在的**。',
    '   禁止一切自行推算 —— 不求和、不求差、不乘除、不算占比、不算增长率、不做年化折算、',
    '   不做单位换算后改写。例如数据里有「配额 8293.24」和「CCER 抵销上限 5%」，',
    '   **不要**自行给出「即 414.66 tCO₂e」；需要推算值时，只写公式并说明"具体数值请看平台计算页"。',
    '   **尤其注意「富余/缺口」这类派生值**：数据块里通常已直接给出结论（如"预计富余 68,925.37"），',
    '   请原样引用这个数，**不要**用「配额 − 期末预测」自己再算一遍 —— 你的算法与平台口径',
    '   （含抵销、扣减项）不同，算出的数会与原值差几百吨，看起来像编造。',
    '2. 同样在附带平台数据时：**公开资料里的具体数字也不要写**（如"60~100 欧元""2023 年 10 月"），',
    '   改为定性表述（"区间震荡""近年发布"）。理由：回答中一旦混入平台外数字，',
    '   数字溯源校验会把它们判为无出处，读者无法分辨哪个数可信。',
    '3. 平台数据能回答的，用平台数据作答，并在每个结论后紧邻标注（来源：平台实时数据）；',
    '   不要在整段末尾统一标一次。',
    '4. **未附带平台数据时**（纯政策/概念/方法学问答）：可以引用你的知识，',
    '   数字照常给，但必须注明"据公开资料"；不要假装这些数据来自本平台。',
    '5. 不确定就明说"我不确定"，不编造数字、不编造政策文号与生效日期。',
    '6. 本平台数据为**演示数据**时（上下文会说明），不要说成"你企业的真实排放"。',
    '',
    '## 表达要求',
    '· 中文，简洁，300 字内；关键数字用 **加粗**；分点优于长段。',
    '· 不要输出"作为 AI 模型"这类自我指涉的套话。',
  ];

  if (platformContext) {
    if (platformContext.user) {
      lines.push('', `当前用户：${platformContext.user.name || platformContext.user.username || '未登录'}`
        + `（角色 ${platformContext.user.role || '未知'}）`);
    }
    if (platformContext.workshop) {
      lines.push(`选中车间：${platformContext.workshop.name}（排放 ${platformContext.workshop.emission} tCO₂e）`);
    }
    if (platformContext.enterprise) {
      lines.push(`企业：${platformContext.enterprise.name}，配额 ${platformContext.enterprise.allocated} tCO₂e，`
        + `缺口 ${platformContext.enterprise.gap} tCO₂e`);
    }
    if (platformContext.chain) {
      lines.push(`链高度：${platformContext.chain.height}，已确认存证：${platformContext.chain.confirmed} 笔`);
    }
  }

  if (s.configured) lines.push('', `当前底层模型：${s.provider} / ${s.model}`);
  return lines.join('\n');
}

/* ==================================================================================
 * 七、导出
 * ================================================================================== */
module.exports = {
  /* 兼容旧接口 */
  getConfig, isConfigured, chat, chatStream, buildSystemPrompt,
  /* 新增能力 */
  snapshot: P.snapshot,
  resolveChain: P.resolveChain,
  listProviders: () => P.snapshot().providers,
  applyRuntime: P.applyRuntime,
  probe,
  breakerSnapshot,
  resetBreakers,
  /* 本地端点（Ollama）可达性探测：状态接口在取快照前先刷新一次 */
  refreshLocal: P.refreshLocal,
};
