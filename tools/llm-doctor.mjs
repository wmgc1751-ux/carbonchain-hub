#!/usr/bin/env node
/**
 * tools/llm-doctor.mjs —— 大模型接入诊断与联调
 * ==================================================================================
 * 【用法】
 *   npm run llm:doctor                 列出 10 家服务商的配置状态 + 探测已配置的家
 *   npm run llm:doctor -- --all        连未配置的家也探测（只测端点可达性）
 *   npm run llm:doctor -- --ask "问题" 用真实链路问一句，打印回答 + 时延 + 换家过程
 *   npm run llm:doctor -- --json       机器可读输出（供 CI / 报告引用）
 *
 * 【为什么"探测"是必须的】
 *   密钥写错、余额耗尽、模型名过期、网络被墙 —— 四种故障在业务代码里的表现
 *   完全一样：AI 不说话。没有探测就只能靠猜。本工具统一用 GET /models 判定，
 *   它是 OpenAI 兼容协议里唯一"只读、零成本、能暴露鉴权错误"的端点。
 *
 * @module tools/llm-doctor
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const LLM = require(path.join(ROOT, 'server/services/llmClient.js'));

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const JSON_OUT = has('--json');
const PROBE_ALL = has('--all');
const ASK = val('--ask');

const C = {
  dim: '\x1b[2m', reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
};

/* 中文占两列宽：padEnd 按字符数补齐会让表格错位，这里按显示宽度补 */
const dw = (s) => [...String(s).replace(/\x1b\[[0-9;]*m/g, '')]
  .reduce((a, ch) => a + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dw(s)));

async function main() {
  await LLM.refreshLocal('ollama');
  const s = LLM.snapshot();

  /* ---------- 一、总览 ---------- */
  const summary = {
    configured: s.configured,
    provider: s.provider,
    providerId: s.providerId,
    model: s.model,
    backend: s.backend,
    chain: s.chain.map((c) => c.id),
    fallbacks: s.fallbacks,
    reason: s.reason,
  };

  /* ---------- 二、逐家探测 ---------- */
  const targets = PROBE_ALL
    ? LLM.listProviders().map((p) => p.id)
    : LLM.listProviders().filter((p) => p.hasKey).map((p) => p.id);

  const probes = [];
  if (targets.length) {
    for (const id of targets) probes.push(await LLM.probe(id));
  }

  /* ---------- 三、真实提问（可选） ---------- */
  let ask = null;
  if (ASK) {
    const t0 = Date.now();
    try {
      const r = await LLM.chat(
        [{ role: 'user', content: ASK }],
        { system: '你是碳资产管理助手。用两句话回答，不要编造具体数字。', temperature: 0.3 },
      );
      ask = {
        ok: true, ms: Date.now() - t0, answer: r.text,
        provider: r.provider, model: r.model, attempts: r.attempts,
      };
    } catch (e) {
      ask = { ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 300), attempts: e.attempts || null };
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ summary, providers: LLM.listProviders(), probes, ask }, null, 2));
    return;
  }

  /* ---------- 四、人读输出 ---------- */
  console.log(`${C.bold}碳链通 · 大模型接入诊断${C.reset}  ${C.dim}${new Date().toLocaleString('zh-CN')}${C.reset}`);
  console.log('─'.repeat(78));

  if (s.configured) {
    console.log(`${C.green}● 已接入${C.reset}  ${C.bold}${s.provider}${C.reset} / ${s.model}`);
    console.log(`  backend : ${s.backend}`);
    console.log(`  备用链  : ${s.fallbacks.length ? s.fallbacks.join(' → ') : '无（单点，建议再加一家）'}`);
  } else {
    console.log(`${C.yellow}○ 未接入${C.reset}  ${s.reason}`);
    console.log(`  ${C.dim}平台内问题仍可回答（规则引擎 + 工具查库），只是没有平台外知识与自然语言润色。${C.reset}`);
  }

  console.log(`\n${C.bold}服务商清单${C.reset}`);
  console.log(`  ${pad('服务商', 24)}${pad('密钥', 12)}${pad('默认模型', 32)}探测`);
  for (const p of LLM.listProviders()) {
    const pr = probes.find((x) => x.providerId === p.id);
    let probeTxt = `${C.dim}—${C.reset}`;
    if (pr) {
      if (pr.ok) {
        probeTxt = `${C.green}可达 ${pr.ms}ms${C.reset}${pr.modelCount != null ? ` · ${pr.modelCount} 个模型` : ''}`
          + (pr.defaultModelPresent === false ? ` ${C.yellow}（默认模型不在清单内，需 LLM_MODEL 指定）${C.reset}` : '');
      } else {
        probeTxt = `${C.red}失败${C.reset} ${pr.error || pr.status || ''}`
          + (pr.hint ? ` ${C.yellow}${pr.hint}${C.reset}` : '');
      }
    }
    const keyTxt = p.hasKey ? `${C.green}已配置${C.reset}` : (p.keyOptional ? `${C.dim}免密钥${C.reset}` : `${C.dim}未配置${C.reset}`);
    const nameTxt = (p.active ? '▸ ' : '  ') + p.name;
    console.log('  ' + pad(nameTxt, 24) + pad(keyTxt, 12) + pad(p.model, 32) + probeTxt);
  }

  /* ---------- 五、结论与下一步 ---------- */
  console.log('─'.repeat(78));
  const okProbes = probes.filter((p) => p.ok);
  if (!s.configured) {
    console.log(`${C.bold}下一步（任选其一，30 秒生效）${C.reset}`);
    console.log('  ① 最省事 · 智谱 GLM-4-Flash（有免费额度）');
    console.log('     到 https://open.bigmodel.cn/ 注册取 key，写入 .env：');
    console.log(`     ${C.cyan}ZHIPU_API_KEY=你的key${C.reset}`);
    console.log('  ② 效果优先 · DeepSeek');
    console.log(`     ${C.cyan}DEEPSEEK_API_KEY=你的key${C.reset}`);
    console.log('  ③ 完全离线 · 本地 Ollama（需先安装并 ollama pull qwen2.5:7b）');
    console.log(`     ${C.cyan}LLM_PROVIDER=ollama${C.reset}`);
    console.log(`  ${C.dim}改完重启服务即可；也可登录管理员账号调用 POST /api/copilot/config 临时接入。${C.reset}`);
  } else if (probes.length === 0) {
    console.log(`${C.dim}未探测任何服务商（未加 --all，且已配置家的密钥未触发探测）。${C.reset}`);
  } else if (!okProbes.length) {
    console.log(`${C.red}配置了密钥但全部探测失败 —— 请先修通网络或密钥，再谈接入。${C.reset}`);
  } else {
    console.log(`${C.green}链路正常${C.reset}：${okProbes.map((p) => `${p.providerId}(${p.ms}ms)`).join('、')}`);
  }

  if (ask) {
    console.log(`\n${C.bold}真实提问${C.reset}  ${C.dim}${ASK}${C.reset}`);
    if (ask.ok) {
      console.log(`  ${C.green}✓ ${ask.provider} / ${ask.model} · ${ask.ms}ms${C.reset}`);
      console.log('  ' + ask.answer.replace(/\n/g, '\n  '));
      if (ask.attempts && ask.attempts.length > 1) {
        console.log(`  ${C.yellow}换家过程${C.reset}：` + ask.attempts
          .map((a) => `${a.provider}${a.ok ? '✓' : '✗' + (a.error || '')}`).join(' → '));
      }
    } else {
      console.log(`  ${C.red}✗ ${ask.error}${C.reset}`);
    }
  }
}

main().catch((e) => { console.error('诊断失败：', e); process.exit(1); });
