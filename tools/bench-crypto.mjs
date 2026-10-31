#!/usr/bin/env node
/**
 * tools/bench-crypto.mjs —— 密码学原语基准（国密 / 国际双套件）
 * ==================================================================
 * 承接仓库收敛时移除的 scripts/bench-crypto.js（原 npm run bench:crypto）。
 *
 * 测项（全部直接调用平台的真实密码学实现，不另起炉灶）：
 *   ① SM3 哈希吞吐 —— 1 KB 与 1 MB 消息
 *   ② SM2 签名 QPS
 *   ③ SM2 验签 QPS
 *   ④ SM3 Merkle 根构建耗时（1000 / 10000 叶）
 *   ⑤ SM3 标准测试向量一致性（附随出具，确保跑的不是"假基准"）
 *
 * 用例
 *   npm run bench:crypto:fast   # 快速档（约 1~2s）
 *   npm run bench:crypto        # 默认档
 *   npm run bench               # 全量档（约 2 倍样本）
 *
 * 产出：控制台表格 + tools/out/bench-crypto.json
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const gm = require(path.join(ROOT, 'server', 'blockchain', 'gm-crypto.js'));

const ARGV = process.argv.slice(2);
const FAST = ARGV.includes('--fast');
const ALL = ARGV.includes('--all');
const SCALE = FAST ? 0.2 : ALL ? 2 : 1;
const n = (base) => Math.max(5, Math.round(base * SCALE));

const now = () => Number(process.hrtime.bigint()) / 1e6;

/** 简单基准：返回单次耗时与吞吐 */
function bench(label, iterations, fn) {
  for (let i = 0; i < Math.min(20, iterations); i++) fn(i);   // 预热
  const t0 = now();
  for (let i = 0; i < iterations; i++) fn(i);
  const dt = now() - t0;
  return { label, iterations, totalMs: +dt.toFixed(2), perOpMs: +(dt / iterations).toFixed(4), opsPerSec: Math.round(iterations / (dt / 1000)) };
}

if (!gm.available) {
  console.error('✘ 当前 OpenSSL 不支持国密套件，基准无法执行。');
  console.error(`  openssl: ${process.versions.openssl}`);
  process.exit(1);
}

const results = [];

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  碳链通 · 密码学原语基准（gm-crypto.js 真实实现）');
console.log('════════════════════════════════════════════════════════════════');
console.log(`  档位      ${FAST ? '快速' : ALL ? '全量' : '默认'}（scale=${SCALE}）`);
console.log(`  OpenSSL   ${process.versions.openssl}`);
console.log(`  平台      ${os.type()} ${os.release()} · ${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length}`);
console.log('────────────────────────────────────────────────────────────────');

/* ---------- ① SM3 哈希吞吐 ---------- */
const buf1k = Buffer.alloc(1024, 0x61);
const buf1m = Buffer.alloc(1024 * 1024, 0x61);

const h1k = bench('SM3 · 1 KB', n(10_000), () => gm.sm3(buf1k));
const h1m = bench('SM3 · 1 MB', n(200), () => gm.sm3(buf1m));
results.push(h1k, h1m);
console.log(`  ① SM3 · 1 KB      ${String(h1k.opsPerSec).padStart(9)} ops/s   ${h1k.perOpMs} ms/op`);
console.log(`     SM3 · 1 MB      ${String(h1m.opsPerSec).padStart(9)} ops/s   ${h1m.perOpMs} ms/op   `
  + `等效吞吐 ${(1024 / (h1m.perOpMs / 1000) / 1024).toFixed(1)} MB/s`);

/* ---------- ②③ SM2 签名 / 验签 ---------- */
const wallet = gm.generateSm2Wallet();
const msg = 'carbonchain-hub/bench/payload|' + 'x'.repeat(256);
const sig = gm.sm2Sign(wallet.privateKey, msg);

const sign = bench('SM2 签名', n(1000), () => gm.sm2Sign(wallet.privateKey, msg));
const verify = bench('SM2 验签', n(1000), () => {
  const ok = gm.sm2Verify(wallet.publicKey, msg, sig);
  if (!ok) throw new Error('验签失败');
});
results.push(sign, verify);
console.log(`  ② SM2 签名        ${String(sign.opsPerSec).padStart(9)} ops/s   ${sign.perOpMs} ms/op`);
console.log(`  ③ SM2 验签        ${String(verify.opsPerSec).padStart(9)} ops/s   ${verify.perOpMs} ms/op`);

/* ---------- ④ SM3 Merkle 根 ---------- */
const leaves1k = Array.from({ length: 1000 }, (_, i) => gm.sm3('leaf:' + i));
const leaves10k = Array.from({ length: 10_000 }, (_, i) => gm.sm3('leaf:' + i));
const m1k = bench('Merkle 1000 叶', n(50), () => gm.merkleRootSm3(leaves1k));
const m10k = bench('Merkle 10000 叶', n(10), () => gm.merkleRootSm3(leaves10k));
results.push(m1k, m10k);
console.log(`  ④ Merkle 1000 叶  ${String(m1k.opsPerSec).padStart(9)} ops/s   ${m1k.perOpMs} ms/op`);
console.log(`     Merkle 10000 叶 ${String(m10k.opsPerSec).padStart(9)} ops/s   ${m10k.perOpMs} ms/op`);

/* ---------- ⑤ 标准向量自证 ---------- */
let conf = null;
try {
  conf = gm.conformance();
  const okCases = (conf.cases || []).filter((c) => String(c.expected).toLowerCase() === String(c.actual).toLowerCase());
  console.log(`  ⑤ SM3 标准向量  ${okCases.length}/${(conf.cases || []).length} 一致   `
    + `标准：${conf.source || 'GB/T 32905-2016 附录 A'}`);
} catch (e) {
  console.log(`  ⑤ SM3 标准向量  校验失败：${e.message}`);
}

console.log('────────────────────────────────────────────────────────────────');
console.log('  说明：本基准测的是平台**实际使用**的密码学实现（server/blockchain/gm-crypto.js），');
console.log('        非独立玩具实现；SM2 含密钥对生成开销之外的单次签名/验签耗时。');
console.log('════════════════════════════════════════════════════════════════\n');

/* ---------- 落盘 ---------- */
const OUT_DIR = path.join(ROOT, 'tools', 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  tier: FAST ? 'fast' : ALL ? 'all' : 'default',
  env: {
    node: process.version, openssl: process.versions.openssl,
    platform: `${os.type()} ${os.release()}`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length,
  },
  results,
  conformance: conf ? { standard: conf.standard, source: conf.source, standardVectorsOk: (conf.cases || []).filter((c) => String(c.expected).toLowerCase() === String(c.actual).toLowerCase()).length, standardVectorsTotal: (conf.cases || []).length } : null,
};
fs.writeFileSync(path.join(OUT_DIR, 'bench-crypto.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('  已写出：tools/out/bench-crypto.json\n');
