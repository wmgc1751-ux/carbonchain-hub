/**
 * bench-consensus.mjs —— PoW 与 PoA 单块出块耗时对比（可复现基准）
 * ==================================================================
 * 为什么单独做这个基准
 *   论文第 6 章「共识与性能」对比表里曾写「同难度下 PoW 出块慢约 79 倍」，
 *   但正文与附录都没有给出这个倍数的测量方法、样本量与硬件环境 ——
 *   这是评审明确指出的「关键数字无出处」。本脚本把该倍数变成可复现结果：
 *   同一台机器、同一份 `Blockchain.calcHash`、同一难度，各测 N 次取中位数。
 *
 * 口径（重要，引用时必须带）
 *   · difficulty = 4（平台默认，等价于 16^4 ≈ 65,536 次哈希的期望工作量）
 *   · PoW：`Blockchain.proofOfWork(header)` —— 真实循环找前导零，含哈希计算；
 *   · PoA：`Blockchain.calcHash(header)` + `cu.sign()` —— 出块节点签名，
 *     不含 ECDSA 验签（验签属校验开销，全链校验时按块计，另见 §5.4）；
 *   · 计时用 hrtime.bigint，取 20 次（PoW）/ 2000 次（PoA）的中位数，
 *     避免 Date.now() 的 1 ms 粒度把 PoA 耗时量化为 0。
 *
 * 用法：node tools/bench-consensus.mjs [--rounds 20]
 * 产物：tools/out/bench-consensus.json
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const cu = require('../server/blockchain/crypto-utils');
const { Blockchain } = require('../server/blockchain/chain');
const keystore = require('../server/blockchain/keystore');
const config = require('../server/config');

const args = process.argv.slice(2);
const argvRound = args.indexOf('--rounds');
const POW_ROUNDS = argvRound >= 0 ? Number(args[argvRound + 1]) || 20 : 20;
const POA_ROUNDS = Math.max(POW_ROUNDS * 100, 2000);
const DIFFICULTY = 4;

const ms = (ns) => Number(ns) / 1e6;
const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const fmt = (v, d = 3) => Number(v.toFixed(d));

function makeHeader(index) {
  return {
    index,
    timestamp: 1760000000 + index,
    merkleRoot: cu.sha256(`bench-merkle-${index}`),
    prevHash: cu.sha256(`bench-prev-${index}`),
    difficulty: DIFFICULTY,
    nonce: 0,
    consensus: 'POW',
  };
}

function main() {
  const wallet = keystore.walletFor('regulator:system');

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  PoW ↔ PoA 单块出块耗时基准');
  console.log(`  难度 ${DIFFICULTY}　PoW 样本 ${POW_ROUNDS} 块　PoA 样本 ${POA_ROUNDS} 块`);
  console.log(`  环境 ${os.platform()} ${os.arch()} · ${os.cpus().length} vCPU · ${os.cpus()[0].model}`);
  console.log('══════════════════════════════════════════════════════════');

  /* 预热：把 JIT 与 ECDSA 曲线初始化开销排除在计时之外 */
  for (let i = 0; i < 200; i++) { Blockchain.calcHash(makeHeader(i)); cu.sign(wallet.privateKey, `warm-${i}`); }

  /* --- PoW：真实找 nonce --- */
  const powTimes = [];
  let powNonces = 0;
  for (let i = 0; i < POW_ROUNDS; i++) {
    const header = makeHeader(i);
    const t0 = process.hrtime.bigint();
    const r = Blockchain.proofOfWork(header);
    const t1 = process.hrtime.bigint();
    powTimes.push(ms(t1 - t0));
    powNonces += r.nonce;
    if (!r.hash.startsWith('0'.repeat(DIFFICULTY))) throw new Error('PoW 结果不满足难度，基准无效');
  }

  /* --- PoA：算哈希 + 出块签名 --- */
  const poaTimes = [];
  for (let i = 0; i < POA_ROUNDS; i++) {
    const header = { ...makeHeader(i), consensus: 'POA', proposer: 'node-regulator-01', difficulty: 0 };
    const t0 = process.hrtime.bigint();
    const h = Blockchain.calcHash(header);
    cu.sign(wallet.privateKey, Blockchain.signingPayload({ ...header, merkleRoot: header.merkleRoot }));
    const t1 = process.hrtime.bigint();
    if (!h) throw new Error('PoA 哈希计算失败');
    poaTimes.push(ms(t1 - t0));
  }

  const powMed = median(powTimes);
  const poaMed = median(poaTimes);
  const ratio = powMed / poaMed;
  const powAvgNonce = powNonces / POW_ROUNDS;
  const tps = 1000 / poaMed;

  console.log(`\n  PoW  单块中位耗时 ${fmt(powMed)} ms（平均尝试 nonce ${Math.round(powAvgNonce).toLocaleString('en-US')} 次）`);
  console.log(`  PoA  单块中位耗时 ${fmt(poaMed)} ms（哈希 + ECDSA 出块签名）`);
  console.log(`  ⇒ 同难度下 PoW 出块耗时约为 PoA 的 ${fmt(ratio, 1)} 倍`);
  console.log(`  ⇒ PoA 单节点名义出块速率 ${Math.round(tps).toLocaleString("en-US")} 块/秒（不含网络广播与落库）`);

  const out = {
    generatedAt: new Date().toISOString(),
    hardware: {
      platform: `${os.platform()} ${os.arch()}`,
      cpu: os.cpus()[0].model,
      cores: os.cpus().length,
      memGB: Math.round(os.totalmem() / 1024 ** 3),
      node: process.version,
    },
    difficulty: DIFFICULTY,
    pow: {
      rounds: POW_ROUNDS,
      medianMs: fmt(powMed),
      meanMs: fmt(powTimes.reduce((a, b) => a + b, 0) / powTimes.length),
      minMs: fmt(Math.min(...powTimes)),
      maxMs: fmt(Math.max(...powTimes)),
      avgNonce: Math.round(powAvgNonce),
      expectedNonce: 16 ** DIFFICULTY,
    },
    poa: {
      rounds: POA_ROUNDS,
      medianMs: fmt(poaMed, 4),
      meanMs: fmt(poaTimes.reduce((a, b) => a + b, 0) / poaTimes.length, 4),
      p99Ms: fmt([...poaTimes].sort((a, b) => a - b)[Math.floor(poaTimes.length * 0.99)], 4),
      tpsNominal: Math.round(tps),
    },
    ratio: fmt(ratio, 1),
    note: '同难度、同机器、同一份 calcHash 实现；PoA 侧含出块签名，不含验签。',
  };

  const dir = path.resolve(config.paths.root, 'tools', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bench-consensus.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n  证据已写出：${file}\n`);
}

main();
