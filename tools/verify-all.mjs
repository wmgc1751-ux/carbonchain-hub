#!/usr/bin/env node
/**
 * tools/verify-all.mjs —— 全量自检「不中断」汇总器
 * ==================================================================
 * 为什么需要它（P1 缺陷修复）
 * ------------------------------------------------------------------
 * 旧实现 `npm run verify:all` 用 shell 的 `&&` 串联 6 个套件：
 *
 *     node A && node B && node C && …
 *
 * 第 1 个套件失败即中止，**后续套件根本不执行**，而外部看到的只有
 * 一段中断的输出 —— 一个失败会静默掩盖其余全部套件的真实状态，
 * 使"全绿"结论不可信。本脚本替代该实现：
 *
 *   ① 串行执行全部套件，**任一失败都不中断其余套件**；
 *   ② 每个套件单独落盘原始输出，供逐字复核；
 *   ③ 汇总表明确列出 PASS / WARN / FAIL / BLOCKED / SKIP 五态，
 *      失败或跳过一律显式呈现，不允许静默消失；
 *   ④ 任一 FAIL 时进程退出码为 1，可直接用于 CI 判定。
 *
 * 与 verify-report.mjs 的分工
 * ------------------------------------------------------------------
 *   · verify-report.mjs —— 面向《步骤五·验证成果》的 7 套件证据表
 *     （口径已写入交付文档，保持稳定，不在本脚本中改动）。
 *   · verify-all.mjs   —— 面向「回归是否有红」的全量 14 套件守门器。
 *
 * 用法
 *   npm run verify:all
 *   node tools/verify-all.mjs --only sm2,interop      # 只跑指定套件
 *   node tools/verify-all.mjs --skip interop,firmware # 跳过耗时套件
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tools', 'out');
const LOG_DIR = path.join(OUT_DIR, 'verify-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const NODE = process.execPath;

/* ---------- 参数 ---------- */
const ARGV = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d;
};
const only = argOf('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const skip = argOf('--skip', '').split(',').map((s) => s.trim()).filter(Boolean);

/* ---------- 套件清单 ----------
 * needs    : 必须在此套件成功后才具备运行条件（前置失败 → BLOCKED，而非 FAIL）
 * needHttp : 需要本机 HTTP 服务在跑，未探测到 → SKIP 并给出启动提示
 * count    : 是否具备"通过/总数"计数口径（哑管道类为 false）
 */
const SUITES = [
  { id: 'protocol', name: 'HJ 212-2017 协议栈锚点', cmd: ['tools/protocol-check.cjs'], needHttp: false, timeout: 60_000, count: true },
  { id: 'chain-export', name: '联盟链数据导出（哑管道）', cmd: ['tools/export-chain.mjs'], needHttp: false, timeout: 120_000, count: false },
  { id: 'chain-verify', name: '联盟链离线零信任复核', cmd: ['tools/verify-offline.mjs', '--input', 'tools/out/chain-export.json'], needs: 'chain-export', timeout: 180_000, count: true },
  { id: 'chain-probe', name: '复核器阴性对照（篡改注入）', cmd: ['tools/selftest-verify.mjs'], needs: 'chain-export', timeout: 180_000, count: true },
  { id: 'chain-crosscheck', name: '内核自校验对撞', cmd: ['tools/cross-check-internal.cjs'], timeout: 180_000, count: true },
  /* ⚠ iot 套件同时需要两样东西：平台 API（8300）与 HJ 212 TCP 服务（9100）。
   * 早先没标 needHttp，服务没跑时它会以「fetch failed」判 FAIL ——
   * 这是把"环境未就绪"误报成"功能坏了"，会掩盖真实问题。
   * 标上 needHttp 后，服务未起时正确判 SKIP 并提示如何启动。 */
  { id: 'iot', name: '设备接入准入闭环', cmd: ['tools/iot-selftest.mjs'], needHttp: true, timeout: 300_000, count: true },
  { id: 'audit', name: '审计哈希链篡改检出', cmd: ['tools/audit-chain-selftest.mjs'], timeout: 240_000, count: true },
  { id: 'bridge', name: '链库分离与同库同改演练', cmd: ['tools/attack-same-db.mjs'], timeout: 300_000, count: false },
  { id: 'keymgmt', name: '密钥托管与轮换安全断言', cmd: ['tools/keymgmt-selftest.mjs'], timeout: 180_000, count: true },
  { id: 'uncertainty', name: '不确定度与模型评估', cmd: ['tools/uncertainty-selftest.mjs'], timeout: 240_000, count: true },

  /* ---- MRV 生产层与商业闭环（2026-10-24 新增）----
   * mrv 检验四件事是否真的成立：方法学内核 / 核算可复算 / 不确定度三路径 /
   * 结算·清缴·注销·CBAM 闭环。放在 uncertainty 之后，因为它复用那两套内核。 */
  { id: 'mrv', name: 'MRV 链路与商业闭环', cmd: ['tools/mrv-selftest.mjs'], timeout: 300_000, count: true },

  /* ---- 零知识碳核算（2026-10-24 新增）----
   * 检验隐私保护型 MRV：SM2 曲线群运算、Pedersen 承诺、范围证明、
   * 同态聚合、跨期一致性、授权披露可审计。
   * 放在 mrv 之后：ZK 的输入来自 MRV 的核算结果。 */
  { id: 'zk', name: '零知识碳核算协议', cmd: ['tools/zk-selftest.mjs'], timeout: 600_000, count: true },

  /* ---- AI 大模型网关（2026-10-25 新增）----
   * 检验"接入市面大模型"这件事在**失败路径**上是否成立：
   * 无密钥时如实报未配置、首选 5xx 自动换家、连续失败熔断、
   * 401 判为密钥问题、流式首字前可换家/中途断流不换家、
   * 以及模型编造的数字能否被溯源校验抓出。
   * 全程用本机假服务商，不依赖外网与真实密钥 —— 否则评审现场无法复现。 */
  { id: 'llm', name: '多模型网关与数字溯源', cmd: ['tools/llm-selftest.mjs'], timeout: 180_000, count: true },

  { id: 'api-iter2', name: '二轮 API 端到端', cmd: ['tools/api-iter2-check.mjs'], needHttp: true, timeout: 180_000, count: true },
  { id: 'sm2', name: '国密 SM2 端到端', cmd: ['tools/sm2-verify-e2e.mjs'], needHttp: true, timeout: 240_000, count: true },
  { id: 'firmware', name: '固件兼容自证', cmd: ['tools/firmware-compat-check.mjs'], timeout: 600_000, count: true },
  { id: 'interop', name: '端云固件互认', cmd: ['tools/firmware-interop-check.mjs'], timeout: 900_000, count: true, asset: 'hardware/firmware' },
  { id: 'hw', name: '硬件胶水层语法检查', cmd: ['tools/check-hw-syntax.mjs'], timeout: 180_000, count: true, asset: 'hardware/firmware' },

  /* ---- 参赛证据链三件套（2026-10-24 新增） ----
   * 这三项不测业务功能，测的是「对外主张能不能被验证」：
   *   ledger  —— 论文/答辩里的每个数字是否有可追溯出处
   *   prov    —— 数据来源等级是否被如实分级（缺证即空，不美化）
   *   pack    —— 证据包能否打包并自校验通过（含阴性对照能力）
   * ⚠ 顺序铁律：ledger 消费 realaudit/reallayer 产出的 real-data-audit.json /
   *   real-layer-check.json —— 必须排在数据层套件之后，否则 initdb 重置基准后
   *   首轮会读到上一轮的旧产物（取值 0 → --strict 误报"取错字段"）。
   *   2026-10-26 实测踩中：initdb 后 verify:all 台账 9 条非 OK，单独复跑全绿。 */
  { id: 'prov', name: '数据来源分级审计', cmd: ['tools/data-provenance.mjs'], timeout: 120_000, count: false },
  /* 核查机构归属一致性守门（2026-10-30 新增）：
   * 任务改派脚本历史上漏同步 verify_report，全库曾累计 219 条
   * 「报告挂在别家机构任务下」的记录 —— 页面不报错，只是结论错，
   * 且「累计完成」与「链上存证」两个数字永远对不齐。
   * 断言五条不变量：报告/上报单归属、签章可复算、
   * 「完成+驳回」= 存证份数、重复锚定。 */
  { id: 'ownership', name: '核查机构归属一致性', cmd: ['tools/ownership-coherence-check.mjs'], timeout: 120_000, count: false },
  /* 外部真实数据审计（2026-10-24 新增）：
   * 回答"平台里哪些数据是真的、来自哪些开放单位"。
   * 与 prov（内部分级）互补：prov 看内部标注，本套件看**外部可核查性**。 */
  { id: 'realaudit', name: '外部真实数据审计', cmd: ['tools/real-data-audit.mjs', '--strict'], timeout: 120_000, count: false },
  /* 真实数据层端到端（2026-10-24 新增）：
   * 自起子进程（8311 端口）跑完「起服务 → 87 项断言 → 关服务」，
   * 与主服务端口隔离，不会互相干扰。
   * 覆盖：真实设施台账（美国 EPA + 中国 Climate TRACE 双源）/ 年度记录 /
   *       行业基准分布自洽 / 年度趋势同比 / 真实性契约全部核验通过 /
   *       SSE 每秒来帧且 LIVE 指标在变而 STATIC 指标不抖 / 真实层公开可读。
   * 放在 realaudit 之后：realaudit 看"数据从哪来"，本套件看"数据到没到位"。 */
  { id: 'reallayer', name: '真实数据层与实时引擎', cmd: ['tools/real-layer-check.mjs'], timeout: 300_000, count: true },
  /* ⭐ 本轮新增：用**外部真实观测**检验核算实现（科学性从自证转为他证）。
   * 判据：恒等式 E=A×EF 精确自洽占比 > 95%、无量纲级错误、因子跳变率 < 10%、
   *       与官方电网因子的比值在物理相容区间。 */
  { id: 'crossvalidate', name: '真实数据交叉验证（核算实现）', cmd: ['tools/crossvalidate-check.mjs'], timeout: 420_000, count: true },
  /* ⭐ 本轮新增：零知识协议在**真实设施量级**上端到端可用，
   * 且三类阴性对照（谎报/篡改/挪用）必须全部被拦截。
   * 为什么必须单列：合成批次上的 35 项 ZK 自检证明不了协议能作用于
   * 32,850,000 MWh 与 0.806119 这样的真实量级 —— 那里才会暴露位宽与量纲问题。 */
  { id: 'zk-realdata', name: '零知识协议 · 真实设施数据', cmd: ['tools/zk-real-data-check.mjs', '--year', '2025'], timeout: 420_000, count: true },
  /* 台账必须在数据层套件（realaudit/reallayer/crossvalidate/zk-realdata）全部
   * 产出证据文件之后执行 —— 见上方"顺序铁律"注释。 */
  { id: 'ledger', name: '指标溯源台账', cmd: ['tools/metrics-ledger.mjs', '--strict'], timeout: 120_000, count: false },
  /* 口径一致性守门：台账回答"数字从哪来"，本套件回答"这个数全文是不是只有一个值"。
   * 院审意见②的两个子问题正对应这两件事，缺一不可。必须排在 ledger 之后
   * （它读台账产物做比对）。 */
  { id: 'consistency', name: '数字口径一致性', cmd: ['tools/metrics-consistency.mjs', '--strict'], timeout: 120_000, count: false },
  /* 演示可用性：每个演示角色是否都有"可操作路径"。
   * 这不是数据正确性检查，而是"能不能演示"的检查 ——
   * 核查机构分不到待办任务、企业没有钱包，数据都没错，但流程走不下去。
   * 放在回归里，是为了在每次改完数据后立刻发现演示路径断了。 */
  { id: 'demo', name: '演示账号可用性', cmd: ['tools/demo-readiness.mjs'], timeout: 60_000, count: false },
  { id: 'pack', name: '可自验证据包', cmd: ['tools/evidence-pack.mjs'], timeout: 180_000, count: false },
];

/* ---------- HTTP 探活 ---------- */
const HTTP_PORT = Number(process.env.PORT || 8300);
function httpUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/chain/stats', timeout: 2500 }, (r) => {
      r.resume();
      resolve(r.statusCode > 0);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* ---------- 计数解析（各套件汇总行格式不统一，逐一兼容） ---------- */
const ANSI = /\x1b\[[0-9;]*m/g;
function parseCounts(text) {
  const clean = text.replace(ANSI, '');
  const tail = clean.slice(-2000);
  const lines = tail.split('\n');
  const line = lines.filter((l) => l.includes('结果')).pop() || '';

  let m = /共\s*(\d+)\s*项/.exec(line);
  if (m) {
    const total = +m[1];
    const p = /(\d+)\s*通过/.exec(line) || /通过\s*(\d+)/.exec(line);
    return { pass: p ? +p[1] : total, total };
  }
  m = /(\d+)\s*\/\s*(\d+)/.exec(line);
  if (m) return { pass: +m[1], total: +m[2] };
  if (/全部复核项通过/.test(tail)) return { pass: null, total: null, note: '全项通过' };
  if (/链接构有效/.test(tail)) return { pass: null, total: null, note: '内核判定有效' };
  if (/通过桩头语法\/类型检查/.test(tail)) return { pass: null, total: null, note: '语法检查通过' };
  if (/已导出/.test(tail) && !/结果/.test(tail)) return { pass: null, total: null, note: '导出完成' };
  return null;
}

/* ---------- 执行 ---------- */
const t0 = Date.now();
const rows = [];
const state = new Map();   // id -> 'PASS' | 'WARN' | 'FAIL' | 'BLOCKED' | 'SKIP'

console.log('\n════════ 全量自检 · 不中断汇总 ════════');
console.log(`  套件 ${SUITES.length} 个 · node ${process.version} · HTTP 探测端口 ${HTTP_PORT}\n`);

const up = await httpUp(HTTP_PORT);
console.log(up
  ? `  ✔ 本机 HTTP 服务在 127.0.0.1:${HTTP_PORT} 可达\n`
  : `  ⚠ 本机 HTTP 服务在 127.0.0.1:${HTTP_PORT} 不可达 —— 依赖服务的套件将标为 SKIP\n`);

for (const s of SUITES) {
  if (only.length && !only.includes(s.id)) { state.set(s.id, 'SKIP'); continue; }
  if (skip.includes(s.id)) { state.set(s.id, 'SKIP'); continue; }

  /* 前置依赖未通过 → BLOCKED（不算失败，但必须显式呈现） */
  if (s.needs && state.get(s.needs) !== 'PASS') {
    rows.push({ ...s, status: 'BLOCKED', note: `前置 ${s.needs} 未通过`, ms: 0, pass: null, total: null });
    state.set(s.id, 'BLOCKED');
    console.log(`  ⊘ ${s.name.padEnd(22, '　')} BLOCKED（前置 ${s.needs} 未通过）`);
    continue;
  }
  /* 需要服务但服务不在 → SKIP 并给出可执行提示 */
  if (s.needHttp && !up) {
    rows.push({ ...s, status: 'SKIP', note: `HTTP ${HTTP_PORT} 不可达`, ms: 0, pass: null, total: null });
    state.set(s.id, 'SKIP');
    console.log(`  ⊘ ${s.name.padEnd(22, '　')} SKIP（先执行 node server/scripts/start-prod.js）`);
    continue;
  }
  /* 依赖本仓资产的套件，资产缺席 → SKIP（如实呈现，不判永久红灯）。
   * 2026-10-26：hardware/（CAD/固件桩）经用户确认从仓内移除后，
   * interop / hw 两套件每次回归必红 —— 与"常红断言"危害同理：
   * 团队会习惯性忽略这条红，真正的新问题就被淹没。
   * 资产在库时（clone 完整仓 / 恢复 hardware 目录）两套件自动恢复执行。 */
  if (s.asset && !fs.existsSync(path.join(ROOT, s.asset))) {
    rows.push({ ...s, status: 'SKIP', note: `资产缺失：${s.asset}（套件自动跳过）`, ms: 0, pass: null, total: null });
    state.set(s.id, 'SKIP');
    console.log(`  ⊘ ${s.name.padEnd(22, '　')} SKIP（${s.asset} 不在库中）`);
    continue;
  }

  /* ledger 自引用消解：ledger（指标溯源台账）消费 verify-all.json，而该文件在轮末才写 ——
   * 轮内执行时只能读到上一轮产物（若上一轮被 --only 覆盖过，还会读到残缺汇总）。
   * 处置：跑 ledger 前把**当轮已完成套件**的临时汇总落盘（provisional，不含尚未执行的
   * ledger/pack 自身）；ledger 读到的即当轮真值，轮末再以全量版覆盖本文件。 */
  if (s.id === 'ledger') {
    const pBy = (st) => rows.filter((r) => r.status === st);
    const pSumPass = rows.reduce((a, r) => a + (r.pass ?? 0), 0);
    const pSumTotal = rows.reduce((a, r) => a + (r.total ?? 0), 0);
    fs.writeFileSync(path.join(OUT_DIR, 'verify-all.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      provisional: true,
      note: 'ledger 执行前的当轮临时汇总（sumTotal 已含除 ledger/pack 外全部套件；轮末被全量版覆盖）',
      env: { measuredAt: new Date(t0).toISOString(), node: process.version, httpReachable: up },
      totals: { passed: pBy('PASS').length, warned: pBy('WARN').length, failed: pBy('FAIL').length, blocked: pBy('BLOCKED').length, skipped: pBy('SKIP').length, sumPass: pSumPass, sumTotal: pSumTotal, ms: Date.now() - t0 },
      rows: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, pass: r.pass, total: r.total, note: r.note, ms: r.ms, exit: r.exit ?? null })),
    }, null, 2), 'utf8');
  }

  const start = Date.now();
  const r = spawnSync(NODE, s.cmd, {
    cwd: ROOT, timeout: s.timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_PROXY: '*', HTTP_PROXY: '', HTTPS_PROXY: '' },
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const ms = Date.now() - start;
  fs.writeFileSync(path.join(LOG_DIR, `${s.id}.txt`), out, 'utf8');

  const code = r.status === null ? -1 : r.status;   // null = 超时被杀
  const c = s.count ? parseCounts(out) : null;
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';

  let status;
  if (timedOut) status = 'FAIL';
  /* ⭐ 退出码 3 = 环境限制（如宿主机禁止执行临时 exe）。
   * 这不是功能缺陷，必须判 SKIP —— 否则每次回归都有一条永久红灯，
   * 团队会逐渐习惯「反正总有一条红的」，真正的新问题就被淹没了
   * （这是"常红断言"最实际的危害：它训练人忽略警报）。 */
  else if (code === 3) status = 'SKIP';
  else if (code !== 0) status = 'FAIL';
  else if (c && c.pass !== null && c.pass !== c.total) status = 'WARN';
  else status = 'PASS';

  const cnt = c ? (c.pass !== null ? `${c.pass}/${c.total}` : c.note) : '—';
  const mark = { PASS: '✔', WARN: '⚠', FAIL: '✘', SKIP: '⊘' }[status];
  const skipNote = code === 3
    ? (out.split('\n').find((l) => l.includes('HOST_EXEC_BLOCKED') || l.includes('⊘')) || '环境限制（退出码 3）').trim()
    : (timedOut ? '超时被终止' : (c?.note ?? ''));
  rows.push({ ...s, status, note: skipNote, ms, pass: c?.pass ?? null, total: c?.total ?? null, exit: code });
  state.set(s.id, status);
  console.log(`  ${mark} ${s.name.padEnd(22, '　')} ${String(cnt).padEnd(14)} ${status.padEnd(8)} ${(ms / 1000).toFixed(1)}s`);
}

/* ---------- 汇总 ---------- */
const totalMs = Date.now() - t0;
const by = (st) => rows.filter((r) => r.status === st);
const failed = by('FAIL');
const warned = by('WARN');
const blocked = by('BLOCKED');
const skipped = by('SKIP');
const passed = by('PASS');
const sumPass = rows.reduce((a, r) => a + (r.pass ?? 0), 0);
const sumTotal = rows.reduce((a, r) => a + (r.total ?? 0), 0);

console.log('\n────────────────────────────────────────');
console.log(`  通过 ${passed.length} · 部分 ${warned.length} · 失败 ${failed.length} · 阻断 ${blocked.length} · 跳过 ${skipped.length}`);
console.log(`  断言合计 ${sumPass}/${sumTotal} · 总耗时 ${(totalMs / 1000).toFixed(1)}s`);
if (failed.length) console.log(`  失败套件：${failed.map((r) => `${r.id}(${r.note || 'exit ' + r.exit})`).join(', ')}`);
if (warned.length) console.log(`  部分通过：${warned.map((r) => `${r.id}(${r.pass}/${r.total})`).join(', ')}`);
if (blocked.length) console.log(`  被阻断　：${blocked.map((r) => r.id).join(', ')}`);
if (skipped.length) console.log(`  已跳过　：${skipped.map((r) => r.id).join(', ')}`);
console.log(`  原始输出：tools/out/verify-logs/`);
console.log('────────────────────────────────────────\n');

/* ---------- 落盘 ---------- */
const env = {
  measuredAt: new Date(t0).toISOString(),
  node: process.version, platform: `${os.type()} ${os.release()}`,
  cpuModel: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length,
  httpPort: HTTP_PORT, httpReachable: up,
};
const report = {
  generatedAt: env.measuredAt, env, totals: { passed: passed.length, warned: warned.length, failed: failed.length, blocked: blocked.length, skipped: skipped.length, sumPass, sumTotal, ms: totalMs },
  rows: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, pass: r.pass, total: r.total, note: r.note, ms: r.ms, exit: r.exit ?? null })),
};
fs.writeFileSync(path.join(OUT_DIR, 'verify-all.json'), JSON.stringify(report, null, 2), 'utf8');

const md = [];
md.push('# 全量自检汇总（自动生成，请勿手工编辑）');
md.push('');
md.push(`> 生成命令：\`npm run verify:all\`　生成时间：${env.measuredAt}`);
md.push('');
md.push('| # | 套件 | 结果 | 断言 | 耗时 | 备注 | 原始输出 |');
md.push('| --- | --- | --- | --- | --- | --- | --- |');
rows.forEach((r, i) => {
  const s = { PASS: '✔ 通过', WARN: '⚠ 部分通过', FAIL: '✘ 失败', BLOCKED: '⊘ 被阻断', SKIP: '⊘ 已跳过' }[r.status];
  const cnt = r.pass !== null ? `${r.pass}/${r.total}` : (r.note || '—');
  md.push(`| ${i + 1} | ${r.name} | ${s} | ${cnt} | ${(r.ms / 1000).toFixed(1)}s | ${r.note || ''} | \`tools/out/verify-logs/${r.id}.txt\` |`);
});
md.push('');
md.push(`**合计**：通过 ${passed.length} · 部分 ${warned.length} · 失败 ${failed.length} · 阻断 ${blocked.length} · 跳过 ${skipped.length} · 断言 ${sumPass}/${sumTotal}`);
fs.writeFileSync(path.join(OUT_DIR, 'verify-all.md'), md.join('\n'), 'utf8');
console.log('  已写出：tools/out/verify-all.md · tools/out/verify-all.json\n');

process.exit(failed.length === 0 ? 0 : 1);
