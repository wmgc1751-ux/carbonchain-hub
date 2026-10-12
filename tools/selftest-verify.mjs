/**
 * selftest-verify.mjs —— 复核工具的「阴性对照」自测台（WP7 可核验性）
 * ==================================================================
 * 为什么需要它
 * ------------------------------------------------------------------
 * 一个永远输出"通过"的校验器等于没有校验器。
 * 本脚本对同一份导出文件**故意注入可预期的篡改**，然后断言
 * verify-offline.mjs 必须报出**对应类型**的异常，且未注入时零异常。
 *
 * 七组对照：
 *   T0 未篡改            → 期望 0 异常（基线）
 *   T1 改链下业务明文    → 期望 PAYLOAD_BINDING_MISMATCH
 *   T2 改区块时间戳      → 期望 HASH_MISMATCH + POA_SIGNATURE_INVALID
 *   T3 删一笔链上交易    → 期望 MERKLE_ROOT_MISMATCH
 *   T4 改 prevHash       → 期望 PREV_HASH_MISMATCH
 *   T5 抽换批次叶        → 期望 BATCH_ROOT_MISMATCH
 *   T6 假链顶锚定值      → 期望 TIP_MISMATCH
 *
 * 全部通过则说明：工具对每类篡改都有独立检出能力，且不是"逢事皆报"。
 *
 * 用法：node tools/selftest-verify.mjs [--input tools/out/chain-export.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const k = process.argv[i].slice(2);
    args[k] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
  }
}
const root = path.resolve(import.meta.dirname, '..');
const input = path.resolve(args.input || path.join(root, 'tools', 'out', 'chain-export.json'));
const verifyScript = path.join(import.meta.dirname, 'verify-offline.mjs');
const nodeBin = process.execPath;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-selftest-'));

const base = JSON.parse(fs.readFileSync(input, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));

/** 跑一次复核，返回 { exitCode, report }（报告由 --json 落盘读取，避免解析 stdout） */
function runVerify(payload, extraArgs = []) {
  const p = path.join(tmpDir, `case-${Math.random().toString(36).slice(2)}.json`);
  const rp = p.replace(/\.json$/, '.report.json');
  fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
  let code = 0;
  try {
    execFileSync(nodeBin, [verifyScript, '--input', p, '--json', rp, ...extraArgs], {
      stdio: 'pipe', env: { ...process.env, NO_PROXY: '*', HTTP_PROXY: '', HTTPS_PROXY: '' },
    });
  } catch (e) {
    code = e.status === undefined ? -1 : e.status;
  }
  const report = JSON.parse(fs.readFileSync(rp, 'utf8'));
  return { exitCode: code, report, file: p };
}

const cases = [];
function expectOk(name, mutate, expectTypes, extraArgs = []) {
  const payload = clone();
  const detail = mutate(payload);
  const { exitCode, report } = runVerify(payload, extraArgs);
  const got = report.errors.map((e) => e.type);
  const uniqueGot = [...new Set(got)];
  const allPresent = expectTypes.every((t) => uniqueGot.includes(t));
  const noExtra = expectTypes.length === 0
    ? report.errors.length === 0
    : uniqueGot.every((t) => expectTypes.includes(t)); // 不出现意料之外的类型
  cases.push({
    name,
    detail,
    expectTypes,
    gotTypes: uniqueGot,
    errorCount: report.errors.length,
    exitCode,
    pass: allPresent && noExtra && (expectTypes.length === 0 ? exitCode === 0 : exitCode === 1),
  });
}

/* ---------- T0 基线：不得有任何异常 ---------- */
expectOk('T0 未篡改基线', () => '原样导出', []);

/* ---------- T1 链下业务明文被改（链上锚点未动） ---------- */
expectOk('T1 篡改链下业务明文', (p) => {
  // 找一笔带 payload_json 的交易，改一个业务字段
  const t = p.txs.find((x) => x.payload_json && x.payload_json.startsWith('{'));
  const obj = JSON.parse(t.payload_json);
  obj.__tampered = 'attacker';
  t.payload_json = JSON.stringify(obj);
  return `交易 ${t.tx_id.slice(0, 12)}… 的 payload_json 被改写`;
}, ['PAYLOAD_BINDING_MISMATCH']);

/* ---------- T2 区块头被改（时间戳） ---------- */
expectOk('T2 篡改区块时间戳', (p) => {
  const b = p.blocks[Math.min(5, p.blocks.length - 1)];
  b.block_time = '2000-01-01 00:00:00';
  b.ts = Math.floor(Date.UTC(2000, 0, 1) / 1000);
  return `区块 #${b.block_index} 的 block_time/ts 被改`;
}, ['HASH_MISMATCH', 'POA_SIGNATURE_INVALID']);

/* ---------- T3 删一笔链上交易（Merkle 根失配） ---------- */
expectOk('T3 抽走一笔链上交易', (p) => {
  // 必须挑一笔**未被批量锚定**的交易，否则会连带触发 BATCH_ROOT_MISMATCH，
  // 干扰"只应报 Merkle 失配"的对照结论。
  const anchored = new Set((p.batchLeaves || []).map((l) => l.tx_id));
  const byBlock = new Map();
  p.txs.forEach((t, i) => {
    if (anchored.has(t.tx_id)) return;
    if (!byBlock.has(t.block_index)) byBlock.set(t.block_index, []);
    byBlock.get(t.block_index).push(i);
  });
  let victim = null;
  for (const [, idxs] of byBlock) if (idxs.length >= 2) { victim = idxs[idxs.length - 1]; break; }
  if (victim === null) {
    for (const [, idxs] of byBlock) { victim = idxs[0]; break; }
  }
  if (victim === null) throw new Error('未找到未被锚定的可删交易');
  const t = p.txs[victim];
  p.txs.splice(victim, 1);
  return `从区块 #${t.block_index} 抽走未锚定交易 ${t.tx_id.slice(0, 12)}…`;
}, ['MERKLE_ROOT_MISMATCH']);

/* ---------- T4 链断裂（改 prevHash） ---------- */
expectOk('T4 篡改 prevHash 制造断链', (p) => {
  const b = p.blocks[Math.min(7, p.blocks.length - 1)];
  b.prev_hash = 'f'.repeat(64);
  return `区块 #${b.block_index} 的 prev_hash 被改成 'f'*64`;
}, ['HASH_MISMATCH', 'PREV_HASH_MISMATCH', 'POA_SIGNATURE_INVALID'], []);

/* ---------- T5 抽换批次叶（批量锚定被破坏） ---------- */
expectOk('T5 抽换批量锚定的叶', (p) => {
  if (!p.batchLeaves || !p.batchLeaves.length) throw new Error('无 batchLeaves');
  const leaf = p.batchLeaves[Math.min(3, p.batchLeaves.length - 1)];
  leaf.tx_id = 'd'.repeat(64);
  return `批次 ${leaf.batch_no} 的第 ${leaf.leaf_index} 叶 tx_id 被换`;
  // 三者都是应有的独立检出：叶集合重算根失配、叶序承诺失配、
  // 以及该叶对「原登记根」的存在性证明必然失败（派生后果，属正确告警）。
}, ['BATCH_ROOT_MISMATCH', 'BATCH_LEAF_DIGEST_MISMATCH', 'BATCH_PROOF_INVALID']);

/* ---------- T6 假链顶外部锚定 ---------- */
expectOk('T6 伪造链顶外部锚定值', () => '传入不存在的 --tip', ['TIP_MISMATCH'], ['--tip', 'a'.repeat(64)]);

/* ---------- T7 会话时区未钉 UTC 的假阳性抑制 ---------- */
expectOk('T7 导出 ts 整体偏移 +8h（应被吸收）', (p) => {
  p.blocks.forEach((b) => { b.ts = Number(b.ts) + 28800; });
  return '所有 block_time 保留原值，仅把导出 ts 抬高 28800 秒';
}, []);

/* ---------- 输出 ---------- */
console.log('');
console.log('════════════════════════════════════════════════════════════════');
console.log('  碳链通 · 复核工具阴性对照自测（tamper-detection harness）');
console.log('════════════════════════════════════════════════════════════════');
console.log(`  输入文件  ${input}`);
console.log(`  样本规模  区块 ${base.blocks.length} · 交易 ${base.txs.length}`
  + ` · 批次 ${(base.anchorBatches || []).length} · 叶 ${(base.batchLeaves || []).length}`);
console.log('────────────────────────────────────────────────────────────────');
for (const c of cases) {
  const mark = c.pass ? '✔' : '✘';
  console.log(`  ${mark} ${c.name}`);
  console.log(`      注入：${c.detail}`);
  console.log(`      期望检出：${c.expectTypes.length ? c.expectTypes.join(' + ') : '（无异常）'}`
    + `   实测：${c.errorCount} 处 ${c.gotTypes.length ? '[' + c.gotTypes.join(', ') + ']' : ''}`
    + `   退出码 ${c.exitCode}`);
}
console.log('────────────────────────────────────────────────────────────────');
const pass = cases.filter((c) => c.pass).length;
console.log(`  结果：${pass}/${cases.length} 组对照通过`);
console.log(pass === cases.length
  ? '  ✔ 校验器具备逐类篡改的独立检出能力，且无误报（基线零异常、时区假阳性已抑制）。'
  : '  ✘ 存在未通过项，校验器检出能力不完整。');
console.log('════════════════════════════════════════════════════════════════');
console.log('');

fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(pass === cases.length ? 0 : 1);
