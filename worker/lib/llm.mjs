/**
 * worker/lib/llm.mjs —— Cloudflare 运行时 LLM 网关（多服务商 + 故障转移）
 * ==================================================================================
 * 与 server/services/llmClient.js 保持**同一套语义**，差异只有两处运行时事实：
 *
 *   ① 密钥来自 Worker/Pages 的环境变量（env.XXX），不能读 .env 文件；
 *   ② 多一个零密钥后端 —— Cloudflare Workers AI 绑定（env.AI），
 *      与 Pages 项目同账号自带，免费层 10k neurons/天。这让**线上演示**
 *      不依赖任何外部密钥也能有真模型可用。
 *
 * 服务商清单与本地运行时一致（智谱 / DeepSeek / 通义 / Kimi / 硅基流动 /
 * 火山方舟 / 千帆 / 混元 / OpenAI / 自定义端点），全部走 OpenAI 兼容协议。
 *
 * 故障转移规则（与本地一致）：
 *   · 非流式：任一家失败 → 下一家；
 *   · 流式：**仅在尚未吐出任何字符时**换家；已吐字再换会产生拼接文本。
 *
 * @module worker/lib/llm
 */

/* ==================================================================================
 * 一、服务商注册表
 * ================================================================================== */
export const PROVIDERS = [
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keys: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'] },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keys: ['DEEPSEEK_API_KEY'] },
  { id: 'dashscope', name: '阿里云百炼·通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'] },
  { id: 'moonshot', name: 'Moonshot · Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', keys: ['SILICONFLOW_API_KEY'] },
  { id: 'ark', name: '火山方舟 · 豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1-5-lite-32k-250115', keys: ['ARK_API_KEY', 'VOLC_API_KEY'] },
  { id: 'qianfan', name: '百度千帆 · 文心', baseUrl: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.0-8k', keys: ['QIANFAN_API_KEY', 'BAIDU_API_KEY'] },
  { id: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-lite', keys: ['HUNYUAN_API_KEY'] },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keys: ['OPENAI_API_KEY'] },
];

function readEnv(env, name) {
  const v = env && env[name];
  return v ? String(v).trim() : null;
}

/** 后端标识：cfai 的 id 已含模型名，不再重复拼接 */
function backendName(c) {
  return c.kind === 'cfai' ? c.id : `${c.id}:${c.model}`;
}

function modelOf(env, p) {
  return readEnv(env, 'LLM_MODEL') || p.model;
}

function baseUrlOf(env, p) {
  if (p.id === 'custom') return readEnv(env, 'LLM_BASE_URL') || '';
  return readEnv(env, `${p.id.toUpperCase()}_BASE_URL`) || p.baseUrl;
}

function keyOf(env, p) {
  for (const k of p.keys) {
    const v = readEnv(env, k);
    if (v && !/^your|^<|^change|placeholder/i.test(v)) return { hasKey: true, keyVar: k, key: v };
  }
  return { hasKey: false, keyVar: null, key: null };
}

/* ==================================================================================
 * 二、解析可用链
 * ================================================================================== */
export function resolveChain(env) {
  const chain = [];
  const seen = new Set();

  const push = (p, override = {}) => {
    if (!p || seen.has(p.id)) return;
    const k = keyOf(env, p);
    const baseUrl = baseUrlOf(env, p);
    if (!k.hasKey || !baseUrl) return;
    seen.add(p.id);
    chain.push({
      id: p.id, name: p.name, kind: 'openai',
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model: modelOf(env, p), apiKey: k.key, keyVar: k.keyVar,
      maxTokens: Number(readEnv(env, 'LLM_MAX_TOKENS')) || 2048,
      timeoutMs: Number(readEnv(env, 'LLM_TIMEOUT_MS')) || 30000,
      ...override,
    });
  };

  const forced = readEnv(env, 'LLM_PROVIDER');
  if (forced && forced !== 'cfai') {
    const p = PROVIDERS.find((x) => x.id === forced);
    if (p) { push(p); return { chain, reason: chain.length ? null : `已指定 ${p.name}，但未找到密钥` }; }
    if (forced === 'custom') {
      push({ id: 'custom', name: '自定义端点', baseUrl: '', model: '', keys: ['LLM_API_KEY'] });
      return { chain, reason: chain.length ? null : '已指定 custom，但缺少 LLM_API_KEY / LLM_BASE_URL' };
    }
    return { chain: [], reason: `LLM_PROVIDER=${forced} 不是已知服务商` };
  }

  /* 自定义端点（私有化 / 自建网关） */
  if (readEnv(env, 'LLM_API_KEY') && readEnv(env, 'LLM_BASE_URL')) {
    push({ id: 'custom', name: '自定义端点', baseUrl: '', model: '', keys: ['LLM_API_KEY'] });
  }

  /* 各家专有变量 */
  for (const p of PROVIDERS) push(p);

  /* Workers AI 绑定（零密钥）—— 放在最后：付费模型质量优于免费小模型
   *
   * ⚠⚠ 这里踩过一个真实故障：原默认模型是 `@cf/qwen/qwen1.5-14b-chat-awq`，
   *   它已被 Cloudflare 下线。绑定存在、代码没报错、`isConfigured()` 仍为 true，
   *   但每次调用都失败，且失败被 catch 静默吞掉 —— 线上表现是"状态显示已接入
   *   大模型，回答却全是规则引擎"，查了很久才发现是模型名过期。
   *
   *   两条修正：
   *   ① 默认模型改为在架模型，并准备一条**模型级备选链**（同一绑定内换模型，
   *      不是换服务商）—— 下线一个模型不该让整个 AI 能力消失；
   *   ② 失败不再静默：错误写进响应的 engine.llmError 与 attempts。
   *   可用模型清单：npx wrangler ai models */
  /* 顺序不是"谁最强谁在前"，而是"谁在当前账号上真的能跑"。
   * 实测（2026-10-25 · Workers Free 计划）：
   *   glm-5.3-flash / deepseek-v4.1-flash → 5035 该模型不在免费计划内（22–225ms 快速失败）
   *   qwen3.8-27b                          → 17.5s 后返回空内容（更糟：慢且无用）
   *   llama-3.3-70b-instruct-fp8-fast       → 7.8s 正常作答，中文可用
   * 因此免费计划下把可跑的通路放前面，付费模型留作末位（升级后自然会被用到，
   * 或直接 LLM_CF_MODEL 指定）。删掉 qwen3.8 是因为它每次要白等 17 秒。 */
  const CF_MODELS_DEFAULT = [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-3.1-8b-instruct-fp8',
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
    '@cf/zai-org/glm-5.3-flash',
  ];
  const hasAI = !!(env && env.AI && typeof env.AI.run === 'function');
  const cfModelOverride = readEnv(env, 'LLM_CF_MODEL');
  const cfModels = hasAI ? (cfModelOverride ? [cfModelOverride] : CF_MODELS_DEFAULT) : [];

  for (const m of cfModels) {
    const id = `cfai:${m}`;
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push({
      id, name: `Cloudflare Workers AI（${m.split('/').pop()}）`, kind: 'cfai',
      model: m,
      maxTokens: Number(readEnv(env, 'LLM_MAX_TOKENS')) || 2048, apiKey: null,
    });
  }

  return {
    chain,
    reason: chain.length ? null
      : '未配置大模型（可设置 DEEPSEEK_API_KEY / ZHIPU_API_KEY 等环境变量，'
        + '或为 Pages 项目绑定 Workers AI：Settings → Functions → AI bindings）',
  };
}

/* ==================================================================================
 * 三、兼容旧接口
 * ================================================================================== */
export function getConfig(env) {
  const { chain } = resolveChain(env);
  const c = chain[0];
  return {
    apiKey: c && c.apiKey ? '__configured__' : null,
    baseUrl: c ? c.baseUrl : '',
    model: c ? c.model : '',
    maxTokens: Number(readEnv(env, 'LLM_MAX_TOKENS')) || 2048,
    cfModel: readEnv(env, 'LLM_CF_MODEL') || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  };
}

export function isConfigured(env) {
  return resolveChain(env).chain.length > 0;
}

export function backendOf(env) {
  const c = resolveChain(env).chain[0];
  return c ? backendName(c) : null;
}

/** 状态快照（供 /api/copilot/status；不含密钥本体） */
export function snapshot(env) {
  const { chain, reason } = resolveChain(env);
  const active = chain[0] || null;
  return {
    configured: !!active,
    provider: active ? active.name : null,
    providerId: active ? active.id : null,
    model: active ? active.model : null,
    backend: active ? backendName(active) : null,
    chain: chain.map((c) => ({ id: c.id, name: c.name, model: c.model })),
    fallbacks: chain.slice(1).map((c) => c.name),
    reason,
    providers: [
      ...PROVIDERS.map((p) => {
        const k = keyOf(env, p);
        return {
          id: p.id, name: p.name, model: modelOf(env, p),
          hasKey: !!k.hasKey, keyVar: k.keyVar,
          active: !!active && active.id === p.id,
        };
      }),
      {
        id: 'cfai', name: 'Cloudflare Workers AI（零密钥）',
        model: readEnv(env, 'LLM_CF_MODEL') || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        hasKey: !!(env && env.AI && typeof env.AI.run === 'function'),
        keyVar: 'AI（binding）',
        active: !!active && String(active.id).startsWith('cfai'),
      },
    ],
  };
}

/* ==================================================================================
 * 四、系统提示词（与本地版同口径）
 * ================================================================================== */
export function buildSystemPrompt(env) {
  const s = snapshot(env);
  return [
    '你是「碳链通 CarbonChainHub」平台的 AI 碳资产顾问。',
    '## 回答边界',
    '1. 用户消息中可能附带【平台实时数据】。凡引用数字，必须与其中完全一致，',
    '   不得四舍五入改写，不得自行推算出新数字。',
    '2. 平台数据能回答的，优先用平台数据，并在结论后标注（来源：平台实时数据）。',
    '3. 平台外的（政策法规、CBAM、CCER 方法学、国际碳市场）用你的知识回答，',
    '   注明"据公开资料"，不要假装来自本平台。',
    '4. 不确定就明说"我不确定"，不编造数字、文号与日期。',
    '5. 中文，简洁，300 字内，关键数字用 **加粗**。',
    s.configured ? `当前底层模型：${s.provider} / ${s.model}` : '',
  ].filter(Boolean).join('\n');
}

/* ==================================================================================
 * 五、对话（带故障转移）
 * ================================================================================== */
function toPrompt(messages) {
  return messages.map((m) => `${m.role === 'assistant' ? '助手' : m.role === 'system' ? '系统' : '用户'}: ${m.content}`).join('\n') + '\n助手:';
}

export async function chat(env, { messages, temperature = 0.4 } = {}) {
  const { chain, reason } = resolveChain(env);
  if (!chain.length) throw new Error(reason || '无可用 LLM 后端');

  const attempts = [];
  for (const c of chain) {
    const t0 = Date.now();
    try {
      const text = await chatOnce(env, c, messages, temperature);
      if (!text || !text.trim()) throw new Error('返回空内容');
      attempts.push({ providerId: c.id, provider: c.name, model: c.model, ok: true, ms: Date.now() - t0 });
      return { text: text.trim(), model: c.model, provider: c.name, providerId: c.id, backend: backendName(c), attempts };
    } catch (e) {
      attempts.push({ providerId: c.id, provider: c.name, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 160) });
    }
  }
  const err = new Error('全部模型均不可用：' + attempts.map((a) => `${a.provider}→${a.error}`).join('; '));
  err.attempts = attempts;
  throw err;
}

async function chatOnce(env, c, messages, temperature) {
  if (c.kind === 'cfai') {
    const out = await env.AI.run(c.model, { messages, max_tokens: c.maxTokens });
    return (out && (out.response || out.result)) ? String(out.response || out.result) : '';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({ model: c.model, messages, temperature, max_tokens: c.maxTokens }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
    }
    const data = await res.json();
    const ch = data.choices && data.choices[0];
    return ch ? (ch.message ? ch.message.content : ch.text) : '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`超时 ${c.timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ==================================================================================
 * 六、流式（首字前可换家）
 * ================================================================================== */
export async function* chatStream(env, { messages, temperature = 0.4 } = {}) {
  const { chain, reason } = resolveChain(env);
  if (!chain.length) throw new Error(reason || '无可用 LLM 后端');

  const attempts = [];
  for (const c of chain) {
    let emitted = 0;
    const t0 = Date.now();
    try {
      for await (const piece of streamOnce(env, c, messages, temperature)) {
        emitted += piece.length;
        yield piece;
      }
      attempts.push({ providerId: c.id, provider: c.name, ok: true, ms: Date.now() - t0 });
      return;
    } catch (e) {
      attempts.push({ providerId: c.id, provider: c.name, ok: false, ms: Date.now() - t0,
        error: String(e.message || e).slice(0, 160), partialChars: emitted });
      /* 已吐字 → 不换家（拼接文本读者无法分辨真伪） */
      if (emitted > 0) {
        const err = new Error(`${c.name} 输出中断（已输出 ${emitted} 字）：${e.message}`);
        err.partial = true;
        err.attempts = attempts;
        throw err;
      }
    }
  }
  const err = new Error('全部模型均不可用：' + attempts.map((a) => `${a.provider}→${a.error}`).join('; '));
  err.attempts = attempts;
  throw err;
}

async function* streamOnce(env, c, messages, temperature) {
  if (c.kind === 'cfai') {
    const stream = await env.AI.run(c.model, { messages, max_tokens: c.maxTokens, stream: true });
    /* ⚠⚠ Workers AI 的 stream:true 返回的是 **ReadableStream 本身**，
     *   不是 HTTP Response（没有 .body）。旧代码判 `stream.body.getReader`，
     *   于是永远走进"不支持流式"分支，再取 stream.response（同样是 undefined）
     *   → 拿到空串 → 整个回答变成规则引擎兜底。
     *   两种形态都要认：ReadableStream（AI 绑定）与 Response.body（REST 代理）。 */
    const readerSrc = stream && typeof stream.getReader === 'function' ? stream
      : (stream && stream.body && typeof stream.body.getReader === 'function' ? stream.body : null);
    if (!readerSrc) {
      const text = stream && (stream.response || stream.result) ? String(stream.response || stream.result) : '';
      /* ⚠ 必须抛错而不是静默 return。
       *   静默返回的后果：生成器正常结束、一个字都没产出，调用方看到的是
       *   "usedLLM=false" 但没有任何错误 —— 线上表现就是"状态说已接入模型，
       *   回答却是规则引擎，且 llmError 为 null"，无从排查。 */
      if (!text.trim()) throw new Error('Workers AI 未返回可用内容');
      yield text;
      return;
    }
    const reader = readerSrc.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
        if (payload === '[DONE]') return;
        try {
          const j = JSON.parse(payload);
          if (j.response) yield j.response;
        } catch { /* 半包跳过 */ }
      }
    }
    return;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs * 2);
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
      body: JSON.stringify({ model: c.model, messages, temperature, max_tokens: c.maxTokens, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
    }

    /* 端点忽略 stream 字段 → 返回整包 JSON：按 SSE 解析会得到空串，
     * 表现成"模型没回答"。这里显式识别并退化为整段产出。 */
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('event-stream') || !res.body) {
      const j = await res.json();
      const ch = j.choices && j.choices[0];
      const text = ch ? (ch.message ? ch.message.content : ch.text) : '';
      if (text) yield text;
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
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
        if (payload === '[DONE]') return;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (delta && delta.content) yield delta.content;
        } catch { /* 心跳/半包 */ }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`流式超时 ${c.timeoutMs * 2}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
