#!/usr/bin/env node
/**
 * tools/llm-e2e.mjs —— 大模型接入端到端验收（真服务 + 假模型，不依赖外网密钥）
 * ==================================================================================
 * 【与 llm-selftest 的分工】
 *   llm-selftest：只测网关模块（函数级，54 项断言）。
 *   llm-e2e     ：起**真的 Express 服务**，打真的 HTTP 接口，走真的 MySQL 查数，
 *                 只把"外部大模型"换成本机假服务商。
 *
 * 这样验证的是完整链路：
 *   前端 → /api/copilot/stream → 规则引擎查库 → 网关 → （假）大模型
 *        → 数字溯源 → SSE 逐字回传
 *
 * 【三个场景，各起一个服务实例】
 *   A 正常接入     ：模型可用，回答正确 → 断言 provider/backend/溯源通过
 *   B 编造数字     ：假模型故意说错 → 断言溯源把它抓出来并写进回答末尾
 *   C 首选故障     ：智谱 500、DeepSeek 正常 → 断言端到端自动换家
 *   D 未配置       ：一个密钥都没有 → 断言平台内问题仍答得出来（不中断）
 *
 * 用法：node tools/llm-e2e.mjs      （退出码 0 = 全通过）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ==================================================================================
 * 一、假模型服务
 * ================================================================================== */
const ANSWER_FABRICATE = '根据平台数据：原煤因子 EF = 1.9003 tCO₂/t，比去年下降 12%，全国合计 9999 万吨。';
const ANSWER_CLEAN = '原煤的排放因子为 **1.9003** tCO₂/t，三要素复算过程见平台因子台账。';

const mock = http.createServer((req, res) => {
  const url = req.url || '';
  if (url.endsWith('/models')) {
    if (url.startsWith('/bad')) { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-chat' }] }));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (url.startsWith('/bad')) { res.writeHead(500); res.end('{"error":"down"}'); return; }
    const text = url.startsWith('/fabricate') ? ANSWER_FABRICATE : ANSWER_CLEAN;
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const pieces = text.match(/.{1,6}/gs) || [text];
      let i = 0;
      const tick = () => {
        if (i >= pieces.length) { res.write('data: [DONE]\n\n'); res.end(); return; }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] })}\n\n`);
        i += 1;
        setTimeout(tick, 5);
      };
      tick();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
  });
});
const MOCK_PORT = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
console.log(`假模型服务：${MOCK}\n`);

/* ==================================================================================
 * 二、服务实例管理
 * ================================================================================== */
async function waitReady(port, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/copilot/status`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function withServer(port, env, fn) {
  const child = spawn(NODE, ['server/app.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), INSTANCE_LOCK: '0', CEMS_INTERVAL_MS: '86400000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    const ready = await waitReady(port);
    if (!ready) {
      console.log(log.slice(-1200));
      throw new Error(`服务 ${port} 未就绪`);
    }
    return await fn();
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
  }
}

async function json(port, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40000),
  });
  return r.json();
}

/** 读 SSE，返回按事件类型分组的数组 */
async function sse(port, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  const events = [];
  for (const raw of text.split('\n\n')) {
    const ev = raw.match(/^event: (\w+)/m);
    const data = raw.match(/^data: ([\s\S]*)$/m);
    if (!ev || !data) continue;
    try { events.push({ ev: ev[1], data: JSON.parse(data[1]) }); } catch { /* skip */ }
  }
  return events;
}

const cleanEnv = {
  ZHIPU_API_KEY: '', DEEPSEEK_API_KEY: '', DASHSCOPE_API_KEY: '', MOONSHOT_API_KEY: '',
  SILICONFLOW_API_KEY: '', ARK_API_KEY: '', QIANFAN_API_KEY: '', HUNYUAN_API_KEY: '',
  OPENAI_API_KEY: '', LLM_API_KEY: '', LLM_BASE_URL: '', LLM_PROVIDER: '',
};

/* ==================================================================================
 * 三、场景 A：正常接入 + 溯源通过
 * ================================================================================== */
console.log('【A 正常接入（模型可用，回答未编数字）】');
await withServer(8391, {
  ...cleanEnv,
  ZHIPU_API_KEY: 'mock-zhipu', ZHIPU_BASE_URL: `${MOCK}/ok`,
}, async () => {
  const st = await json(8391, '/api/copilot/status');
  ok('状态显示已接入', st.data.llm && st.data.llm.configured === true, JSON.stringify(st.data.llm));
  ok('provider 为智谱 GLM', st.data.llm.provider === '智谱 GLM', st.data.llm.provider);
  ok('backend 可观测', String(st.data.llm.backend).startsWith('zhipu:'), st.data.llm.backend);
  ok('旧字段仍兼容（llmEnabled）', st.data.llmEnabled === true, String(st.data.llmEnabled));

  const a = await json(8391, '/api/copilot/ask', { question: '原煤的排放因子是多少' });
  ok('走的是"模型 + 工具"混合引擎',
    a.data.engine && a.data.engine.kind === 'llm+tools', JSON.stringify(a.data.engine));
  ok('回答里带模型名', /1\.9003/.test(a.data.answer), String(a.data.answer).slice(0, 60));
  ok('溯源已执行（非跳过）', a.data.grounding && a.data.grounding.skipped !== true,
    JSON.stringify(a.data.grounding));
  ok('未发现无出处数字', a.data.grounding.unverified.length === 0,
    JSON.stringify(a.data.grounding.unverified));
  ok('回答末尾附正向溯源声明', /均可在平台数据中找到出处/.test(a.data.answer),
    String(a.data.answer).slice(-80));
});

/* ==================================================================================
 * 四、场景 B：模型编造数字 → 必须被抓出
 * ================================================================================== */
console.log('\n【B 模型编造数字（12% / 9999 万吨）】');
await withServer(8392, {
  ...cleanEnv,
  ZHIPU_API_KEY: 'mock-zhipu', ZHIPU_BASE_URL: `${MOCK}/fabricate`,
}, async () => {
  const a = await json(8392, '/api/copilot/ask', { question: '原煤的排放因子是多少' });
  const g = a.data.grounding || {};
  ok('抓到编造的百分比', (g.unverified || []).some((u) => u.raw === '12%'),
    JSON.stringify(g.unverified));
  ok('抓到编造的绝对量', (g.unverified || []).some((u) => u.raw === '9999'),
    JSON.stringify(g.unverified));
  ok('真实数字未被误报', (g.unverified || []).every((u) => u.raw !== '1.9003'),
    JSON.stringify(g.unverified));
  ok('回答末尾给出告警而非沉默', /未在平台数据中找到出处/.test(a.data.answer),
    String(a.data.answer).slice(-120));
  ok('原始回答内容仍保留（不篡改模型输出）', /9999/.test(a.data.answer),
    String(a.data.answer).slice(0, 60));

  const ev = await sse(8392, '/api/copilot/stream', { question: '原煤的排放因子是多少' });
  const done = ev.find((x) => x.ev === 'done');
  ok('流式也带溯源结果', !!(done && done.data.grounding && done.data.grounding.total > 0),
    JSON.stringify(done && done.data.grounding));
  ok('流式 done 带 backend', !!(done && done.data.engine && done.data.engine.backend),
    JSON.stringify(done && done.data.engine));
});

/* ==================================================================================
 * 五、场景 C：首选服务商 500 → 端到端自动换家
 * ================================================================================== */
console.log('\n【C 首选 500，自动换到 DeepSeek】');
await withServer(8393, {
  ...cleanEnv,
  ZHIPU_API_KEY: 'mock-zhipu', ZHIPU_BASE_URL: `${MOCK}/bad`,
  DEEPSEEK_API_KEY: 'mock-ds', DEEPSEEK_BASE_URL: `${MOCK}/ok`,
}, async () => {
  const st = await json(8393, '/api/copilot/status');
  ok('主用仍是链首（智谱）', st.data.llm.providerId === 'zhipu', st.data.llm.providerId);
  ok('备用链含 DeepSeek', (st.data.llm.fallbacks || []).includes('DeepSeek'),
    JSON.stringify(st.data.llm.fallbacks));

  const a = await json(8393, '/api/copilot/ask', { question: '原煤的排放因子是多少' });
  ok('实际由 DeepSeek 作答', a.data.engine && a.data.engine.providerId === 'deepseek',
    JSON.stringify(a.data.engine && a.data.engine.providerId));
  ok('换家过程被记录', Array.isArray(a.data.engine.attempts) && a.data.engine.attempts.length === 2,
    JSON.stringify(a.data.engine.attempts));
  ok('换家后回答仍完整', /1\.9003/.test(a.data.answer), String(a.data.answer).slice(0, 50));

  const ev = await sse(8393, '/api/copilot/stream', { question: '原煤的排放因子是多少' });
  const fo = ev.find((x) => x.ev === 'status' && x.data.phase === 'failover');
  ok('流式换家会告知用户', !!fo, ev.filter((x) => x.ev === 'status').map((x) => x.data.phase).join(','));
});

/* ==================================================================================
 * 六、场景 D：未配置任何模型 → 平台内问题照常可答
 * ================================================================================== */
console.log('\n【D 未配置模型（兜底能力）】');
await withServer(8394, cleanEnv, async () => {
  const st = await json(8394, '/api/copilot/status');
  ok('如实报告未接入', st.data.llm.configured === false, JSON.stringify(st.data.llm));
  ok('给出可操作的失败原因', /未配置/.test(String(st.data.llm.reason)), st.data.llm.reason);

  const a = await json(8394, '/api/copilot/ask', { question: '原煤的排放因子是多少' });
  ok('平台内问题仍能回答', /1\.9003|原煤/.test(a.data.answer), String(a.data.answer).slice(0, 60));
  ok('引擎类型标注为规则引擎', /rule-based/.test(JSON.stringify(a.data.engine)),
    JSON.stringify(a.data.engine && a.data.engine.kind));
  ok('规则引擎回答无需溯源声明（数字本就来自库）',
    !/数字溯源/.test(a.data.answer), String(a.data.answer).slice(-60));

  const ev = await sse(8394, '/api/copilot/stream', { question: '链上现在多高' });
  const deltas = ev.filter((x) => x.ev === 'delta').map((x) => x.data.text).join('');
  ok('流式兜底也能出字', deltas.length > 10, `${deltas.length} 字`);
  ok('流式兜底有 done 事件', ev.some((x) => x.ev === 'done'), ev.map((x) => x.ev).join(','));
});

/* ==================================================================================
 * 七、收尾
 * ================================================================================== */
mock.close();
console.log('\n' + '─'.repeat(64));
if (fail === 0) {
  console.log(`✓ 端到端验收全部通过：${pass} 项断言`);
  process.exit(0);
} else {
  console.log(`✗ 失败 ${fail} 项 / 共 ${pass + fail} 项`);
  for (const f of failures) console.log('   · ' + f);
  if (fs.existsSync(path.join(ROOT, 'tools/out'))) { /* 保留日志位 */ }
  process.exit(1);
}
