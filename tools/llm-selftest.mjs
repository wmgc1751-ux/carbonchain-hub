#!/usr/bin/env node
/**
 * tools/llm-selftest.mjs —— 多模型网关离线自测（无需外网、无需真实密钥）
 * ==================================================================================
 * 【为什么必须在本地起假服务商】
 *
 * "接了某家大模型"这件事，最容易被自我欺骗地验证：
 * 用真 key 跑一次成功，就宣布"接入完成"——但没验证过失败路径。
 * 而线上真正会咬人的是失败路径：
 *   · 密钥过期（401）→ 用户看到的是"AI 不说话"，没有任何提示
 *   · 首家人挂了（5xx）→ 是重试？换家？还是挂住 30 秒？
 *   · 流式吐了半句断开 → 两段文字拼接，读者无法分辨哪句可信
 *
 * 因此本自测用一台本地 HTTP 服务扮演四类服务商（正常/500/401/中途断流），
 * 把上述路径逐条跑一遍。全部断言都不依赖外网。
 *
 * 【覆盖】
 *   ① 配置解析：无密钥 → 正确报"未配置"（而不是假装已接入）
 *   ② 正常对话：一次调用拿回正文，attempts 记录耗时
 *   ③ 故障转移：首选 500 → 自动换家，且结果里能看出换了谁
 *   ④ 熔断：连续失败 2 次后冷却，后续请求不再撞已挂端点
 *   ⑤ 鉴权失败：401 被识别为密钥问题（不是网络问题）
 *   ⑥ 流式：多片段拼接正确 / 首字前可换家 / 中途断流不换家
 *   ⑦ 数字溯源：命中、四舍五入命中、容差命中、单位换算命中、编造数字命中未命中
 *   ⑧ 探测：/models 可达性判定
 *
 * 用法：npm run verify:llm     （退出码 0 = 全通过）
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n【${t}】`); }

/* ==================================================================================
 * 一、假服务商
 * ================================================================================== */
const ANSWER = '该企业的配额缺口为 3208 吨，占配额约 12%，链高度 148。';
const ANSWER_STREAM_PIECES = ['该企业的配额', '缺口为 3208 吨，', '占配额约 12%。'];

const server = http.createServer((req, res) => {
  const url = req.url || '';

  /* 模型清单（探测用） */
  if (url.endsWith('/models')) {
    if (url.startsWith('/bad')) { res.writeHead(500); res.end('{"error":"boom"}'); return; }
    if (url.startsWith('/unauth')) { res.writeHead(401); res.end('{"error":"invalid api key"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-chat' }, { id: 'mock-chat-mini' }] }));
    return;
  }

  if (!url.endsWith('/chat/completions')) { res.writeHead(404); res.end('no route'); return; }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }

    /* 500：模拟服务商故障 */
    if (url.startsWith('/bad')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"internal server error"}}');
      return;
    }
    /* 401：模拟密钥过期 */
    if (url.startsWith('/unauth')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"invalid api key"}}');
      return;
    }

    /* 流式 */
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const pieces = url.startsWith('/midfail') ? ANSWER_STREAM_PIECES.slice(0, 1) : ANSWER_STREAM_PIECES;
      let i = 0;
      const tick = () => {
        if (i >= pieces.length) {
          if (url.startsWith('/midfail')) {
            /* 中途断流：已发一帧后直接摧毁连接，模拟网关掐断 */
            try { req.socket.destroy(); } catch { /* ignore */ }
            return;
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] })}\n\n`);
        i += 1;
        setTimeout(tick, 8);
      };
      tick();
      return;
    }

    /* 非流式 */
    if (url.startsWith('/midfail')) {
      /* 非流式的 midfail 直接 500，便于测"首字前换家"之外的场景 */
      res.writeHead(500); res.end('{"error":"down"}'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: payload.model || 'mock-chat',
      choices: [{ message: { role: 'assistant', content: ANSWER } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }));
  });
});

const PORT = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`假服务商已启动：${BASE}`);

/* ==================================================================================
 * 二、环境注入（必须在 require 业务模块之前）
 * ==================================================================================
 * 每家服务商单独指向本地不同路径：
 *   智谱 → /bad（500）       DeepSeek → /ok（正常）
 *   通义 → /unauth（401）    Kimi → /midfail（断流）
 */
process.env.ZHIPU_API_KEY = 'mock-key-zhipu';
process.env.DEEPSEEK_API_KEY = 'mock-key-deepseek';
process.env.DASHSCOPE_API_KEY = 'mock-key-dashscope';
process.env.MOONSHOT_API_KEY = 'mock-key-moonshot';
process.env.ZHIPU_BASE_URL = `${BASE}/bad`;
process.env.DEEPSEEK_BASE_URL = `${BASE}/ok`;
process.env.DASHSCOPE_BASE_URL = `${BASE}/unauth`;
process.env.MOONSHOT_BASE_URL = `${BASE}/midfail`;
process.env.LLM_TIMEOUT_MS = '4000';
delete process.env.LLM_PROVIDER;
delete process.env.LLM_API_KEY;
delete process.env.LLM_BASE_URL;
delete process.env.LLM_MODEL;

const P = require(path.join(ROOT, 'server/services/llmProviders.js'));
const LLM = require(path.join(ROOT, 'server/services/llmClient.js'));
const G = require(path.join(ROOT, 'server/services/grounding.js'));

/* ==================================================================================
 * 三、配置解析
 * ================================================================================== */
section('配置解析');

{
  const s = P.snapshot();
  ok('四家密钥全部被识别', s.providers.filter((p) => p.hasKey).length === 4,
    '实际 ' + s.providers.filter((p) => p.hasKey).length);
  ok('可用链按注册表优先级排序（智谱→DeepSeek→通义→Kimi）',
    s.chain.map((c) => c.id).join(',') === 'zhipu,deepseek,dashscope,moonshot',
    s.chain.map((c) => c.id).join(','));
  ok('主用为链首（智谱）', s.providerId === 'zhipu', s.providerId);
  ok('备用家数 = 3', s.fallbacks.length === 3, String(s.fallbacks.length));
  ok('密钥变量名如实回显（便于排查贴错位置）', s.keyVar === 'ZHIPU_API_KEY', s.keyVar);
  ok('快照不含密钥本体', !JSON.stringify(s).includes('mock-key-'), '快照出现明文密钥');
  ok('单家 baseUrl 覆盖生效', s.baseUrl === `${BASE}/bad`, s.baseUrl);
}

/* ==================================================================================
 * 四、故障转移
 * ================================================================================== */
section('故障转移（首选 500 → 自动换家）');
LLM.resetBreakers();

{
  const r = await LLM.chat([{ role: 'user', content: '缺口多少' }], { system: 'sys' });
  ok('回答拿到正文', typeof r.text === 'string' && r.text.includes('3208'), String(r.text).slice(0, 40));
  ok('实际由 DeepSeek 回答（首字前换家）', r.providerId === 'deepseek', r.providerId);
  ok('attempts 记录了两家', r.attempts.length === 2, String(r.attempts.length));
  ok('首家标记失败且带错误摘要',
    r.attempts[0].ok === false && /500/.test(r.attempts[0].error || ''),
    JSON.stringify(r.attempts[0]));
  ok('次家标记成功且有时延', r.attempts[1].ok === true && r.attempts[1].ms >= 0,
    JSON.stringify(r.attempts[1]));
  ok('backend 字符串可用于观测', r.backend.startsWith('deepseek:'), r.backend);
}

/* ==================================================================================
 * 五、熔断
 * ================================================================================== */
section('熔断（连续失败 2 次后冷却 60 秒）');

{
  /* 上一节已经失败 1 次；再打一次 → 达到阈值 */
  await LLM.chat([{ role: 'user', content: '再来一次' }]);
  const b = LLM.breakerSnapshot();
  ok('智谱熔断器已跳开', !!(b.zhipu && b.zhipu.open), JSON.stringify(b.zhipu));
  ok('冷却窗口 > 0 秒', b.zhipu.openForSec > 0, String(b.zhipu && b.zhipu.openForSec));
  ok('失败原因已留存', /500/.test(String(b.zhipu.lastError || '')), String(b.zhipu && b.zhipu.lastError));

  const r3 = await LLM.chat([{ role: 'user', content: '第三次' }]);
  ok('熔断期内跳过该家（不再撞已挂端点）',
    r3.attempts[0].skipped === 'circuit-open', JSON.stringify(r3.attempts[0]));
  ok('熔断期内仍能由备用家回答', r3.providerId === 'deepseek', r3.providerId);
}

/* ==================================================================================
 * 六、鉴权失败识别
 * ================================================================================== */
section('鉴权失败（401 应判为密钥问题，而非网络问题）');
LLM.resetBreakers();

{
  /* 只留通义一家，避免被前面的家救走 */
  const saved = { ...process.env };
  delete process.env.ZHIPU_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  try {
    let err = null;
    try { await LLM.chat([{ role: 'user', content: 'hi' }]); } catch (e) { err = e; }
    ok('全部不可用时抛错', !!err, '未抛错');
    ok('错误信息含 401', /401/.test(String(err && err.message)), String(err && err.message).slice(0, 80));
    ok('错误里列出尝试过的服务商', /通义/.test(String(err && err.message)), String(err && err.message).slice(0, 80));
  } finally {
    Object.assign(process.env, saved);
    LLM.resetBreakers();
  }
}

/* ==================================================================================
 * 七、流式
 * ================================================================================== */
section('流式输出');
LLM.resetBreakers();

{
  /* 让 DeepSeek 成为主用（智谱熔断失效 → 直接跳过；也可清 key 更干净） */
  const savedZhipu = process.env.ZHIPU_API_KEY;
  delete process.env.ZHIPU_API_KEY;
  try {
    const chunks = [];
    const r = await LLM.chatStream([{ role: 'user', content: '流式' }], (t) => chunks.push(t), {});
    ok('收到多个片段（真流式，不是整段）', chunks.length >= 3, String(chunks.length));
    ok('片段拼接与全文一致', r.fullText === chunks.join(''), '拼接不一致');
    ok('全文内容正确', r.fullText.includes('3208'), r.fullText.slice(0, 30));
    ok('未发生降级（首选即成功）', r.degraded === false, String(r.degraded));
    ok('流式也记录 backend', String(r.backend).startsWith('deepseek:'), r.backend);
  } finally {
    if (savedZhipu) process.env.ZHIPU_API_KEY = savedZhipu;
    LLM.resetBreakers();
  }
}

{
  /* 流式降级：首选 500 → 备用家接着流 */
  const chunks = [];
  const r = await LLM.chatStream([{ role: 'user', content: '流式降级' }], (t) => chunks.push(t), {});
  ok('流式可换家（degraded=true）', r.degraded === true, String(r.degraded));
  ok('换家后 providerId 为备用家', r.providerId === 'deepseek', r.providerId);
  ok('换家后仍输出完整正文', r.fullText.includes('占配额约 12%'), r.fullText);
}

section('流式中途断流（不得换家拼接）');
LLM.resetBreakers();

{
  const saved = { ...process.env };
  delete process.env.ZHIPU_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  process.env.MOONSHOT_BASE_URL = `${BASE}/midfail`;
  try {
    let err = null;
    let emitted = '';
    try {
      await LLM.chatStream([{ role: 'user', content: '断流' }], (t) => { emitted += t; }, {});
    } catch (e) { err = e; }
    ok('中途断流抛错（不静默当成功）', !!err, '未抛错');
    ok('错误标记 partial=true', !!(err && err.partial), JSON.stringify(err && Object.keys(err)));
    ok('已输出的片段保留（供前端提示中断位置）', emitted.length > 0, `已输出 ${emitted.length} 字`);
    ok('断流时 attempts 记录了部分输出字数',
      !!(err && err.attempts && err.attempts[0] && err.attempts[0].partialChars > 0),
      JSON.stringify(err && err.attempts && err.attempts[0]));
  } finally {
    process.env = { ...saved };
    LLM.resetBreakers();
  }
}

/* ==================================================================================
 * 八、探测
 * ================================================================================== */
section('连通性探测（/models）');

{
  const good = await LLM.probe('deepseek');
  ok('/ok 探测成功', good.ok === true, JSON.stringify(good).slice(0, 80));
  ok('返回可用模型清单', Array.isArray(good.models) && good.models.length === 2,
    JSON.stringify(good.models));
  ok('给出时延', typeof good.ms === 'number' && good.ms >= 0, String(good.ms));

  const bad = await LLM.probe('zhipu');
  ok('/bad 探测失败且带状态码', bad.ok === false && bad.status === 500, JSON.stringify(bad).slice(0, 80));

  const un = await LLM.probe('dashscope');
  ok('401 探测失败并提示密钥无效', un.ok === false && /密钥/.test(String(un.hint || '')),
    JSON.stringify(un).slice(0, 100));
}

/* ==================================================================================
 * 九、数字溯源
 * ================================================================================== */
section('数字溯源（防编造）');

{
  const facts = [{ gap: 3208.4, allocated: 25000, available: 21791.6, chainHeight: 148 }];

  const g1 = G.verify('缺口 3208 吨，配额 25000 吨。', facts, {});
  ok('精确数字命中', g1.verified === 2 && g1.unverified.length === 0,
    JSON.stringify(g1));

  const g2 = G.verify('缺口约 3208.4 吨。', facts, {});
  ok('带小数原样命中', g2.unverified.length === 0, JSON.stringify(g2.unverified));

  const g3 = G.verify('缺口约 3200 吨。', facts, {});
  ok('容差内（0.26%）判为命中', g3.unverified.length === 0, JSON.stringify(g3.unverified));

  const g4 = G.verify('缺口 3208 吨，约占配额 12%，预计超排 9999 吨。', facts, {});
  ok('编造数字被抓出（12%、9999）', g4.unverified.length === 2,
    JSON.stringify(g4.unverified.map((u) => u.raw)));
  ok('未命中清单含百分比标记', g4.unverified.some((u) => u.percent === true), JSON.stringify(g4.unverified));

  const g5 = G.verify('链高度 148，2026 年 3 月生效，共 3 个排口。', facts, {});
  ok('年份与三以内小整数不计入', g5.total === 1, `total=${g5.total}`);

  const g6 = G.verify('全国配额总量 222877 万吨？', [{ total: 2228770000 }], {});
  ok('单位换算（万）判为命中', g6.unverified.length === 0, JSON.stringify(g6.unverified));

  const g7 = G.verify('总量 222,877 吨。', [{ total: 222877 }], {});
  ok('千分位写法判为命中', g7.unverified.length === 0, JSON.stringify(g7.unverified));

  const g8 = G.verify('缺口 3208 吨', facts, { question: '我欠了 5000 吨吗' });
  ok('问题里出现过的数字不计入未命中',
    !g8.unverified.some((u) => u.raw === '5000'), JSON.stringify(g8.unverified));

  /* 回归：公式里的常数（44/12 的 12）不得合法化编造的百分比。
   * 这条来自端到端验收抓到的假阴性：12 出现在复算公式里，
   * 于是模型编的"下降 12%"被判为"有出处"。 */
  const g9 = G.verify('排放量比去年下降 12%。', [{ formula: 'NCV/1000 × CC × OF × 44/12' }], {});
  ok('公式常数不合法化编造百分比（44/12 的 12）',
    g9.unverified.some((u) => u.raw === '12%'), JSON.stringify(g9.unverified));

  const g10 = G.verify('合格率 96.76%。', [{ ratio: 0.9676 }], {});
  ok('真实比率与百分比口径互通（0.9676 → 96.76%）',
    g10.unverified.length === 0, JSON.stringify(g10.unverified));

  ok('全命中时给出正向结论',
    /均可在平台数据中找到出处/.test(G.footnote(g1)), G.footnote(g1).slice(0, 60));
  ok('有未命中时给出告警并列出数字',
    /未在平台数据中找到出处/.test(G.footnote(g4)) && /12%/.test(G.footnote(g4)),
    G.footnote(g4).slice(0, 80));
  ok('没有数字时不出溯源声明', G.footnote(G.verify('好的。', facts, {})) === '',
    G.footnote(G.verify('好的。', facts, {})));

  const empty = G.verify('缺口 3208 吨。', [], {});
  ok('空事实集下不误判为通过（total=1, verified=0）',
    empty.total === 1 && empty.verified === 0, JSON.stringify(empty));
}

/* ==================================================================================
 * 十、状态契约（前端读 llm.configured）
 * ================================================================================== */
section('状态契约');
{
  const s = LLM.snapshot();
  ok('snapshot 提供 configured/provider/model/backend 四件套',
    typeof s.configured === 'boolean' && !!s.provider && !!s.model && !!s.backend,
    JSON.stringify({ c: s.configured, p: s.provider, m: s.model, b: s.backend }));
  ok('providers 清单每项含 hasKey（前端据此显示"已配置/未配置"）',
    s.providers.every((p) => typeof p.hasKey === 'boolean'), '字段缺失');
  ok('active 标记唯一', s.providers.filter((p) => p.active).length === 1,
    String(s.providers.filter((p) => p.active).length));
}

/* ==================================================================================
 * 收尾
 * ================================================================================== */
server.close();

console.log('\n' + '─'.repeat(64));
if (fail === 0) {
  console.log(`✓ LLM 网关自测全部通过：${pass} 项断言`);
  process.exit(0);
} else {
  console.log(`✗ 失败 ${fail} 项 / 共 ${pass + fail} 项`);
  for (const f of failures) console.log('   · ' + f);
  process.exit(1);
}
