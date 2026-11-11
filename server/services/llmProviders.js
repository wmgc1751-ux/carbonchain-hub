/**
 * llmProviders.js —— 市面大模型服务商注册表与密钥发现
 * ==================================================================================
 * 【为什么需要这一层】
 *
 * 上一版 llmClient.js 只认「一个 baseUrl + 一个 key」，服务商靠 baseUrl 子串
 * 猜名字。这带来三个实际问题：
 *   ① 换一家模型要改三行配置，且改错不报错（只会静默降级成规则引擎）；
 *   ② 没有任何「这家到底通不通」的判据 —— 密钥写错与没写密钥，表现完全一样；
 *   ③ 一家挂了整站 AI 就哑了，没有备选。
 *
 * 本模块把「服务商」变成数据：每家一段声明（接入点、默认模型、密钥变量名、
 * 协议差异），运行时自动发现哪几家配了密钥，按优先级组成可用链。
 *
 * 【密钥发现顺序】
 *   ① 显式 LLM_PROVIDER（指定必须用哪家，找不到密钥即报错，不静默换）
 *   ② LLM_API_KEY + LLM_BASE_URL（自建/私有化端点，最高兼容性）
 *   ③ 各家专有变量（DEEPSEEK_API_KEY / ZHIPU_API_KEY / DASHSCOPE_API_KEY …）
 *   ④ 本地 Ollama（无需密钥，127.0.0.1 探测到即用）
 *
 * 【为什么密钥只从环境读，不从库里读】
 *   库里的密钥会被导出、备份、被 SQL 注入读到；环境变量的生命周期与进程一致，
 *   且在 Cloudflare / 容器平台上就是官方推荐的注入方式。运行期设置密钥由
 *   routes/copilot.js 的 admin 接口写入进程内存（进程退出即失效），
 *   这样「演示时临时贴一个 key」不会留下持久化的明文凭据。
 *
 * @module services/llmProviders
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ==================================================================================
 * 一、服务商清单
 * ==================================================================================
 * 全部走 OpenAI chat/completions 兼容协议 —— 一套代码适配所有家。
 * 字段说明：
 *   id        稳定标识（对外 API 用，不随品牌改名而变）
 *   name      展示名
 *   baseUrl   接入点（**不含** /chat/completions）
 *   model     默认模型（可被 LLM_MODEL 覆盖）
 *   keys      该家的环境变量名候选（按顺序探测）
 *   docs      官方文档（doctor 输出里给人看）
 *   note      选型提示（免费额度、中文能力等实测观感）
 */
const PROVIDERS = [
  /* 优先级即数组顺序。DeepSeek 排首（效果优先：中文推理与碳政策问答质量更高、
   * 单价极低），智谱 glm-4-flash 免费额度排第二作兜底——两家都配 key 时，
   * 主用 DeepSeek，故障自动换到智谱，而不是反过来。 */
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    keys: ['DEEPSEEK_API_KEY'],
    docs: 'https://platform.deepseek.com/',
    note: '中文推理与结构化输出稳定，价格低；碳政策类问题表现好',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keys: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'],
    docs: 'https://open.bigmodel.cn/',
    note: 'glm-4-flash 有免费额度，中文常识与政策解读可用，适合演示起步',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼·通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'ALIYUN_API_KEY'],
    docs: 'https://help.aliyun.com/zh/model-studio/',
    note: '兼容模式端点；qwen-plus 上下文长，适合长文档问答',
  },
  {
    id: 'moonshot',
    name: 'Moonshot · Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    docs: 'https://platform.moonshot.cn/',
    note: '长文本能力强，适合政策全文比对',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keys: ['SILICONFLOW_API_KEY'],
    docs: 'https://siliconflow.cn/',
    note: '聚合多家开源模型，单 key 可切模型；部分小模型免费',
  },
  {
    id: 'ark',
    name: '火山方舟 · 豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1-5-lite-32k-250115',
    keys: ['ARK_API_KEY', 'VOLC_API_KEY'],
    docs: 'https://www.volcengine.com/product/ark',
    note: '模型名需填控制台创建的推理接入点 ID 或模型 ID',
  },
  {
    id: 'qianfan',
    name: '百度千帆 · 文心',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'ernie-4.0-8k',
    keys: ['QIANFAN_API_KEY', 'BAIDU_API_KEY'],
    docs: 'https://cloud.baidu.com/product/wenxinworkshop',
    note: 'v2 兼容端点；注意个别模型不支持 stream，已做降级处理',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-lite',
    keys: ['HUNYUAN_API_KEY', 'TENCENT_HUNYUAN_API_KEY'],
    docs: 'https://cloud.tencent.com/product/hunyuan',
    note: 'hunyuan-lite 免费；长文生成一般，短问答够用',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keys: ['OPENAI_API_KEY'],
    docs: 'https://platform.openai.com/',
    note: '国内网络通常不可直连；无代理时表现为超时，doctor 会标注',
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    keys: ['OLLAMA_API_KEY'],
    docs: 'https://ollama.com/',
    note: '完全离线；密钥可留空（本地端点不校验）',
    keyOptional: true,
  },
];

/* ==================================================================================
 * 二、环境读取（process.env 优先，其次 .env 文件）
 * ==================================================================================
 * ⚠ 旧的 readEnv 每次调用都读一遍磁盘文件：一次 /stream 请求会读十几次。
 *   本地无感，但弱机器上叠加在 SSE 首帧延迟上。此处解析一次并缓存，
 *   只有文件 mtime 变化才重读。
 */
const ENV_PATH = path.join(__dirname, '..', '..', '.env');
let envCache = { mtime: 0, map: {} };

function loadEnvFile() {
  try {
    const st = fs.statSync(ENV_PATH);
    if (st.mtimeMs === envCache.mtime) return envCache.map;
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const map = {};
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      /* 跳过注释与空行；允许 `# KEY=val` 形式注释掉某项 */
      if (!s || s.startsWith('#')) continue;
      const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      map[m[1]] = v;
    }
    envCache = { mtime: st.mtimeMs, map };
    return map;
  } catch {
    return envCache.map;
  }
}

/* 测试隔离开关：置真后 readEnv 只看 process.env，不回退 .env 文件。
 * 自测需要模拟"没有任何密钥"，而 delete process.env.X 挡不住文件回退 ——
 * 只要开发机上 .env 填了真 key，"全部不可用"这类用例就永远走不到分支。 */
let ignoreEnvFile = false;
function setIgnoreEnvFile(v) { ignoreEnvFile = !!v; }

/** 读取一个环境变量（进程环境优先，其次 .env 文件） */
function readEnv(name) {
  if (typeof process !== 'undefined' && process.env && process.env[name]) {
    return String(process.env[name]).trim();
  }
  if (ignoreEnvFile) return null;
  const v = loadEnvFile()[name];
  return v ? String(v).trim() : null;
}

/* 运行期覆盖（admin 接口写入；不落盘、进程退出即失效） */
const runtime = {
  provider: null,   // 强制指定服务商 id
  apiKey: null,
  baseUrl: null,
  model: null,
  savedAt: null,
};

/**
 * 运行期设置密钥/模型（演示时临时接入，无需改文件、无需重启）。
 * @param {object} p { provider, apiKey, baseUrl, model }
 */
function applyRuntime(p = {}) {
  if (p.provider !== undefined) runtime.provider = p.provider || null;
  if (p.apiKey !== undefined) runtime.apiKey = p.apiKey || null;
  if (p.baseUrl !== undefined) runtime.baseUrl = p.baseUrl || null;
  if (p.model !== undefined) runtime.model = p.model || null;
  runtime.savedAt = new Date().toISOString();
  return describeRuntime();
}

function describeRuntime() {
  return {
    provider: runtime.provider,
    /* 绝不回显密钥本体，只回显长度与后四位 —— 够确认「贴对了」，不够被复用 */
    keyMasked: runtime.apiKey
      ? `****${String(runtime.apiKey).slice(-4)} (len ${String(runtime.apiKey).length})`
      : null,
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    savedAt: runtime.savedAt,
  };
}

/* ==================================================================================
 * 二之二、本地端点探测（Ollama）
 * ==================================================================================
 * ⚠ 这里踩过一个语义坑：Ollama 不需要密钥，如果按"无密钥也可用"直接放进链，
 *   `snapshot().configured` 会恒为 true —— 明明机器上没装 Ollama，界面也显示
 *   「已接入大模型」。这正是本项目一直在纠的错误：**把"没有"说成"有"**。
 *
 * 正确做法：本地端点必须**实测可达**才算配置。探测结果缓存 60 秒，
 * 由 /status 与被显式指定时触发，避免每次提问都多一次 500ms 连接尝试。
 */
const LOCAL_TTL_MS = 60_000;
const localState = new Map();   // id -> { ok, at, models }

async function refreshLocal(id = 'ollama', timeoutMs = 700) {
  const p = findProvider(id);
  if (!p || !p.keyOptional) return false;

  /* 显式给了地址或密钥 → 视为用户明确要求使用，不必等探测 */
  const explicit = readEnv('LLM_PROVIDER') === id
    || readEnv(`${id.toUpperCase()}_BASE_URL`)
    || readEnv(`${id.toUpperCase()}_API_KEY`);
  if (explicit) {
    localState.set(id, { ok: true, at: Date.now(), models: [], explicit: true });
    return true;
  }

  const prev = localState.get(id);
  if (prev && Date.now() - prev.at < LOCAL_TTL_MS) return prev.ok;

  const baseUrl = (readEnv(`${id.toUpperCase()}_BASE_URL`) || p.baseUrl).replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: ctrl.signal });
    const ok = res.ok;
    let models = [];
    if (ok) {
      const j = await res.json().catch(() => ({}));
      models = (j.data || []).map((m) => m.id).filter(Boolean);
    }
    localState.set(id, { ok, at: Date.now(), models });
    return ok;
  } catch {
    localState.set(id, { ok: false, at: Date.now(), models: [] });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function localOk(id) {
  const s = localState.get(id);
  return !!(s && s.ok);
}

/* ==================================================================================
 * 三、解析：把环境变量变成「可用服务商链」
 * ================================================================================== */

function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** 某家是否已配置密钥；返回 {hasKey, keyVar, key} */
function keyOf(p) {
  /* 运行期覆盖优先（只作用于被指定的那一家） */
  if (runtime.apiKey && (!runtime.provider || runtime.provider === p.id)) {
    return { hasKey: true, keyVar: 'runtime', key: runtime.apiKey };
  }
  for (const k of p.keys) {
    const v = readEnv(k);
    if (v && !/^your|^<|^change|placeholder/i.test(v)) {
      return { hasKey: true, keyVar: k, key: v };
    }
  }
  return { hasKey: false, keyVar: null, key: null };
}

function baseUrlOf(p) {
  if (runtime.baseUrl && (!runtime.provider || runtime.provider === p.id)) return runtime.baseUrl;
  if (p.id === 'custom') return readEnv('LLM_BASE_URL') || '';
  /* 单家覆盖：用于走代理 / 私有化部署 / 自建网关（也可用于离线自测）。
   * 例：DEEPSEEK_BASE_URL=http://127.0.0.1:11434/v1 */
  const perProvider = readEnv(`${String(p.id).toUpperCase()}_BASE_URL`);
  if (perProvider) return perProvider;
  return readEnv('LLM_BASE_URL_OVERRIDE') || p.baseUrl;
}

function modelOf(p) {
  if (runtime.model && (!runtime.provider || runtime.provider === p.id)) return runtime.model;
  return readEnv('LLM_MODEL') || p.model;
}

/**
 * 解析出本次请求实际可用的服务商链（按优先级）。
 *
 * @returns {{chain: Array<object>, reason: string}} reason 说明为何为空
 */
function resolveChain() {
  const chain = [];
  const seen = new Set();

  const push = (p, extra = {}) => {
    if (!p || seen.has(p.id)) return;
    const k = keyOf(p);
    const baseUrl = baseUrlOf(p);
    if (!baseUrl) return;
    /* 需密钥的服务商：必须有密钥；免密钥的本地端点：必须实测可达
     * （或用户在环境里显式指定了它 —— 那是明确意图，不必等探测） */
    const localExplicit = p.keyOptional && (
      readEnv('LLM_PROVIDER') === p.id || !!readEnv(`${String(p.id).toUpperCase()}_BASE_URL`));
    if (!k.hasKey && !(p.keyOptional && (localOk(p.id) || localExplicit))) return;
    seen.add(p.id);
    chain.push({
      id: p.id, name: p.name, baseUrl: baseUrl.replace(/\/+$/, ''),
      model: modelOf(p), apiKey: k.key, keyVar: k.keyVar,
      timeoutMs: Number(readEnv('LLM_TIMEOUT_MS')) || 30000,
      maxTokens: Number(readEnv('LLM_MAX_TOKENS')) || 2048,
      ...extra,
    });
  };

  /* ① 显式指定：只这一家，不静默换家 —— 静默换家会让"我明明配了 A"
   *    变成"实际在用 B"，而日志里看不出来。 */
  const forced = runtime.provider || readEnv('LLM_PROVIDER');
  if (forced) {
    const p = findProvider(forced) || (forced === 'custom' ? {
      id: 'custom', name: '自定义端点', baseUrl: baseUrlOf({ id: 'custom' }),
      model: modelOf({ id: 'custom' }), keys: ['LLM_API_KEY'], keyOptional: true,
    } : null);
    if (!p) return { chain: [], reason: `LLM_PROVIDER=${forced} 不是已知服务商` };
    push(p);
    if (!chain.length) {
      return { chain: [], reason: `已指定 ${p.name}，但未找到密钥（应设置 ${p.keys.join(' 或 ')}）` };
    }
    return { chain, reason: null };
  }

  /* ② 自定义端点（LLM_API_KEY + LLM_BASE_URL），兼容任何私有化部署 */
  if (readEnv('LLM_API_KEY') && readEnv('LLM_BASE_URL')) {
    push({
      id: 'custom', name: '自定义端点', baseUrl: baseUrlOf({ id: 'custom' }),
      model: modelOf({ id: 'custom' }), keys: ['LLM_API_KEY'],
    });
  }

  /* ③ 各家专有变量 */
  for (const p of PROVIDERS) push(p);

  return {
    chain,
    reason: chain.length ? null
      : '未配置任何大模型密钥（可在 .env 设置 DEEPSEEK_API_KEY / ZHIPU_API_KEY 等，见 .env.example）',
  };
}

/** 对外状态快照 —— 不含密钥本体 */
function snapshot() {
  const { chain, reason } = resolveChain();
  const active = chain[0] || null;
  return {
    configured: !!active,
    provider: active ? active.name : null,
    providerId: active ? active.id : null,
    model: active ? active.model : null,
    baseUrl: active ? active.baseUrl : null,
    backend: active ? `${active.id}:${active.model}` : null,
    keyVar: active ? active.keyVar : null,
    chain: chain.map((c) => ({ id: c.id, name: c.name, model: c.model })),
    fallbacks: chain.slice(1).map((c) => c.name),
    reason,
    runtime: describeRuntime(),
    providers: PROVIDERS.map((p) => {
      const k = keyOf(p);
      return {
        id: p.id, name: p.name, model: modelOf(p), baseUrl: p.baseUrl,
        /* ⚠ 必须显式转 boolean：`k.hasKey || (p.keyOptional && …)` 在 keyOptional
         * 为 undefined 时结果是 undefined，前端 `typeof === 'boolean'` 判断直接失败。 */
        hasKey: !!(k.hasKey || (p.keyOptional && localOk(p.id))), keyVar: k.keyVar, docs: p.docs, note: p.note,
        keyOptional: !!p.keyOptional,
        active: !!active && active.id === p.id,
      };
    }),
  };
}

module.exports = {
  PROVIDERS, readEnv, findProvider, resolveChain, snapshot,
  applyRuntime, describeRuntime, refreshLocal, localState,
  setIgnoreEnvFile,
};
