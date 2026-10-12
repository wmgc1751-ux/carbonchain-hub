#!/usr/bin/env node
/**
 * tools/verify-report.mjs —— 验证证据「一键汇总器」
 * ==================================================================
 * 用途：把分散在 7 套自检脚本中的验证结论，一次性跑完并汇编成
 *       可复现的 Markdown + JSON 证据表，供《步骤五·验证成果》引用。
 *
 * 设计纪律（承接步骤四 C6「零虚标」）：
 *   ① 本脚本不生产结论，只**搬运**各自检脚本的原始输出；
 *   ② 数字一律由脚本实测解析得出，**禁止手填**；
 *   ③ 任一套件失败/超时，如实标 ERROR，不以 0 计，不中断其余套件；
 *   ④ 每套原始输出落盘到 tools/out/verify-logs/，供第三方逐字复核。
 *
 * 用法：npm run verify:report
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tools', 'out');
const LOG_DIR = path.join(OUT_DIR, 'verify-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

/** 套件清单：新增自检脚本时只需在此追加一项 */
const SUITES = [
  { id: 'protocol',     cmd: 'node tools/protocol-check.cjs',                                  name: 'HJ 212-2017 协议栈锚点',       zeroDep: true,  timeout: 60_000,  claim: '协议解析与 CRC/拆包双实现互证' },
  { id: 'chain-verify', cmd: 'node tools/verify-offline.mjs --input tools/out/chain-export.json', name: '联盟链离线零信任复核',     zeroDep: true,  timeout: 120_000, claim: '第三方脱离本平台独立重算全链', requireFile: 'tools/out/chain-export.json' },
  { id: 'chain-probe',  cmd: 'node tools/selftest-verify.mjs',                                  name: '复核器阴性对照（篡改注入）', zeroDep: true,  timeout: 120_000, claim: '复核器对逐类篡改的独立检出能力且无误报' },
  { id: 'iot',          cmd: 'node tools/iot-selftest.mjs',                                     name: '设备接入准入闭环',           zeroDep: false, timeout: 240_000, claim: '未登记/未授权/坏CRC/重放一律挡在账本外' },
  { id: 'audit',        cmd: 'node tools/audit-chain-selftest.mjs',                             name: '审计哈希链篡改检出',         zeroDep: false, timeout: 180_000, claim: '审计链五类篡改可检出、复原后可自愈' },
  { id: 'keymgmt',      cmd: 'node tools/keymgmt-selftest.mjs',                                 name: '密钥托管与轮换安全断言',     zeroDep: false, timeout: 120_000, claim: '私钥不落地、双人复核、轮换可追溯' },
  { id: 'uncertainty',  cmd: 'node tools/uncertainty-selftest.mjs',                             name: '不确定度与模型评估',         zeroDep: false, timeout: 180_000, claim: 'GUM/贝叶斯双口径交叉校验与先验稳健性' },
];

function run(cmd, timeoutMs) {
  const t0 = Date.now();
  try {
    const buf = execSync(cmd, {
      cwd: ROOT, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exit: 0, out: buf.toString('utf8'), ms: Date.now() - t0 };
  } catch (e) {
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.toString('utf8');
    return { exit: e.status ?? 1, out, ms: Date.now() - t0 };
  }
}

const ANSI = /\[[0-9;]*m/g;

/**
 * 从原始输出中解析「通过 / 总数」。
 *
 * 只在**尾部含「结果」的最后一行**上匹配，原因有三：
 *   ① 正文里常有「GUM 增加零贡献成分不改变结果 → 期望 0.05 / 实际 0.05」这类中间行，全文匹配会误取；
 *   ② 各套件的汇总行格式并不统一（audit 为「通过 12 / 失败 0 共 12 项」，
 *      keymgmt/uncertainty 为「29 通过 / 0 失败 / 共 29 项」，protocol/iot 为「6/6 个锚点通过」）；
 *   ③ 部分套件输出带 ANSI 颜色码，会插在数字与标签之间阻断匹配，必须先剥离。
 */
function parseCounts(text) {
  const tail = text.slice(-1500);
  const lines = tail.split('\n').map((l) => l.replace(ANSI, ''));
  const line = lines.filter((l) => l.includes('结果')).pop() || '';

  if (/共\s*(\d+)\s*项/.test(line)) {
    const total = +/共\s*(\d+)\s*项/.exec(line)[1];
    const pass = +(/(\d+)\s*通过/.exec(line)?.[1] ?? /通过\s*(\d+)/.exec(line)?.[1] ?? total);
    return { pass, total };
  }
  const slash = /(\d+)\s*\/\s*(\d+)/.exec(line);
  if (slash) return { pass: +slash[1], total: +slash[2] };
  if (/全部复核项通过/.test(tail.replace(ANSI, ''))) {
    return { pass: null, total: null, note: '全项通过（无计数口径）' };
  }
  return null;
}

const startedAt = new Date();
const rows = [];

console.log('\n════════ 验证证据一键汇总 · 开始 ════════\n');

for (const s of SUITES) {
  if (s.requireFile && !fs.existsSync(path.join(ROOT, s.requireFile))) {
    rows.push({ ...s, status: 'SKIP', pass: null, total: null, ms: 0, raw: '' });
    console.log(`  ⊘ ${s.name} —— 缺少 ${s.requireFile}，请先跑 npm run chain:export`);
    continue;
  }
  const r = run(s.cmd, s.timeout);
  fs.writeFileSync(path.join(LOG_DIR, `${s.id}.txt`), r.out, 'utf8');
  const c = parseCounts(r.out);
  const status = r.exit === 0 ? (c && c.pass !== null && c.pass !== c.total ? 'WARN' : 'PASS') : 'FAIL';
  rows.push({ ...s, status, pass: c?.pass ?? null, total: c?.total ?? null, note: c?.note ?? '', ms: r.ms, exit: r.exit });
  const stat = status === 'PASS' ? '✔' : status === 'WARN' ? '⚠' : '✘';
  const cnt = c ? (c.pass !== null ? `${c.pass}/${c.total}` : c.note) : '未解析到计数';
  console.log(`  ${stat} ${s.name.padEnd(20, '　')} ${String(cnt).padEnd(12)} ${(r.ms / 1000).toFixed(1)}s`);
}

const totalMs = Date.now() - startedAt.getTime();
const sumPass = rows.reduce((a, r) => a + (r.pass ?? 0), 0);
const sumTotal = rows.reduce((a, r) => a + (r.total ?? 0), 0);
const failed = rows.filter((r) => r.status === 'FAIL' || r.status === 'SKIP');

console.log(`\n────────────────────────────────────────`);
console.log(`  套件 ${rows.length} 个 · 断言合计 ${sumPass}/${sumTotal} · 耗时 ${(totalMs / 1000).toFixed(1)}s`);
console.log(`  异常套件：${failed.length === 0 ? '无' : failed.map((r) => r.id).join(', ')}`);
console.log(`  原始输出：tools/out/verify-logs/`);
console.log(`────────────────────────────────────────\n`);

/** 环境指纹：跨环境复现时的可比性依据 */
const env = {
  measuredAt: startedAt.toISOString(),
  node: process.version,
  v8: process.versions.v8,
  openssl: process.versions.openssl,
  platform: `${os.type()} ${os.release()}`,
  cpuModel: os.cpus()[0]?.model ?? 'unknown',
  cpuCount: os.cpus().length,
  totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
};

const md = [];
md.push('# 验证证据汇总（自动生成，请勿手工编辑）');
md.push('');
md.push(`> 生成命令：\`npm run verify:report\`　生成时间：${startedAt.toISOString()}`);
md.push('');
md.push('| # | 验证套件 | 举证目标 | 结果 | 断言 | 耗时 | 是否依赖数据库 | 原始输出 |');
md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
rows.forEach((r, i) => {
  const s = r.status === 'PASS' ? '✔ 通过' : r.status === 'WARN' ? '⚠ 部分' : r.status === 'SKIP' ? '⊘ 跳过' : '✘ 失败';
  const cnt = r.pass !== null ? `${r.pass}/${r.total}` : r.note || '—';
  md.push(`| ${i + 1} | ${r.name} | ${r.claim} | ${s} | ${cnt} | ${(r.ms / 1000).toFixed(1)}s | ${r.zeroDep ? '否' : '是'} | \`tools/out/verify-logs/${r.id}.txt\` |`);
});
md.push('');
md.push(`**合计**：${rows.length} 个套件 · ${sumPass}/${sumTotal} 项断言通过 · 总耗时 ${(totalMs / 1000).toFixed(1)}s`);
md.push('');
md.push('## 环境指纹');
md.push('');
md.push('```json');
md.push(JSON.stringify(env, null, 2));
md.push('```');

fs.writeFileSync(path.join(OUT_DIR, 'verify-report.md'), md.join('\n'), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'verify-report.json'), JSON.stringify({ generatedAt: startedAt.toISOString(), env, rows }, null, 2), 'utf8');
console.log(`  已写出：tools/out/verify-report.md · tools/out/verify-report.json\n`);

process.exit(failed.length === 0 ? 0 : 1);
