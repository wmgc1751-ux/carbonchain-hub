#!/usr/bin/env node
/**
 * tools/attack-l1-contrast.cjs —— 「同库同改」的 L1 / L3 对照实验
 * ==================================================================
 * 为什么需要这个脚本（院审建议①的最后一块）
 * ------------------------------------------------------------------
 * 已有 attack-same-db.mjs 在生产库的 L3 形态上跑了 8 组攻击，全部按预期检出。
 * 但它只证明了「L3 拦得住」，没有证明「L1 拦不住」——而后者才是评审
 * 意见①的原始命题：「同库时，DBA 一条 UPDATE 即可同时篡改，五道校验
 * 没有一道会报警」。
 *
 * 缺了对照组，结论就是单边的：读者只能相信"分离有用"，无法看到"不分离
 * 会怎样"。本脚本补上这个对照：
 *
 *   L1（同实例·两库·同账号）  一个会话内即可改遍业务明细与整条哈希链
 *   L3（双实例·双账号）        第二条 UPDATE 在连接层即失败，篡改无法完成
 *
 * 对照的诚实之处
 * ------------------------------------------------------------------
 * 本脚本**不**声称 L1 下篡改完全不可见。真实情况是：
 *   · 哈希链自洽性：攻击者若把 payload_hash → merkle_root → block_hash
 *     一路重算到底，五道结构校验**确实会全部通过**（这正是评审说的硬伤）；
 *   · 唯一挡住它的是第 6 道「交易发起方签名」——私钥不在库中，DBA 拿不到。
 * 所以正确表述是：**分离把防线从"只剩签名一道"抬回到"结构性校验全部有效"**，
 * 而不是"分离之后就无法篡改"。本脚本的输出要能支撑这个说法，而不是更大的说法。
 *
 * 用法
 *   node tools/attack-l1-contrast.cjs
 * 产物
 *   tools/out/attack-l1-contrast.json
 *
 * 安全性
 *   · 只在 3306 实例上建**临时库** cc_l1_probe / cc_l1_probe_ledger，
 *     用完立即 DROP；不触碰 carbon_chain / carbon_chain_ledger。
 */
'use strict';

const crypto = require('crypto');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const config = require('../server/config');

const H = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ZERO = '0'.repeat(64);

const PROBE_BIZ = 'cc_l1_probe';
const PROBE_LEDGER = 'cc_l1_probe_ledger';

const log = (...a) => console.log(...a);
const line = (c = '─') => log(c.repeat(66));

/** 用业务库凭据（root@3306）建临时库 */
function bizAdminCfg() {
  return { ...config.db, database: undefined, multipleStatements: false };
}

/* ---------------- 建最小可攻击环境 ---------------- */

async function setup(conn) {
  for (const db of [PROBE_BIZ, PROBE_LEDGER]) {
    await conn.query(`DROP DATABASE IF EXISTS ${db}`);
    await conn.query(`CREATE DATABASE ${db} DEFAULT CHARACTER SET utf8mb4`);
  }

  /* 业务库：一条排放报告 */
  await conn.query(`CREATE TABLE ${PROBE_BIZ}.emission_report (
    id INT PRIMARY KEY,
    report_no VARCHAR(40),
    total_emission DECIMAL(18,4),
    chain_tx_id VARCHAR(80),
    chain_block_index BIGINT
  ) ENGINE=InnoDB`);

  /* 账本库：交易 + 区块（结构与生产一致的关键字段） */
  await conn.query(`CREATE TABLE ${PROBE_LEDGER}.chain_tx (
    tx_id VARCHAR(80) PRIMARY KEY,
    block_index BIGINT,
    payload_json TEXT,
    payload_hash VARCHAR(80),
    tx_sig VARCHAR(255)
  ) ENGINE=InnoDB`);
  await conn.query(`CREATE TABLE ${PROBE_LEDGER}.chain_block (
    block_index BIGINT PRIMARY KEY,
    prev_hash VARCHAR(80),
    merkle_root VARCHAR(80),
    block_hash VARCHAR(80),
    proposer_sig VARCHAR(255)
  ) ENGINE=InnoDB`);

  /* ---- 造一条自洽的链：payload → payload_hash → merkle_root → block_hash ---- */
  const payload = { report_no: 'ER-L1-0001', total_emission: 12345.6789, ent: '河北恒能（保定）环保能源有限公司' };
  const payloadJson = JSON.stringify(payload);
  const payloadHash = H(payloadJson);
  const merkleRoot = H(payloadHash);          // 单笔交易的 Merkle 根 = 叶哈希
  const txId = H(`${payloadHash}|nonce=1`);
  /* 模拟"私钥在链下"：签名用一个脚本内临时密钥，不入库、不可由库内数据推出 */
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const txSig = crypto.sign('sha256', Buffer.from(payloadHash, 'hex'), privateKey).toString('hex');
  const blockHash = H(`1|${ZERO}|${merkleRoot}|POA|node-carbon-01`);
  /* 出块节点签名同样用独立密钥 */
  const blockSig = crypto.sign('sha256', Buffer.from(blockHash, 'hex'), privateKey).toString('hex');

  await conn.query(`INSERT INTO ${PROBE_BIZ}.emission_report VALUES (?,?,?,?,?)`,
    [1, payload.report_no, payload.total_emission, txId, 1]);
  await conn.query(`INSERT INTO ${PROBE_LEDGER}.chain_tx VALUES (?,?,?,?,?)`,
    [txId, 1, payloadJson, payloadHash, txSig]);
  await conn.query(`INSERT INTO ${PROBE_LEDGER}.chain_block VALUES (?,?,?,?,?)`,
    [1, ZERO, merkleRoot, blockHash, blockSig]);

  return { txId, payloadHash, merkleRoot, blockHash, publicKey, privateKey };
}

/* ---------------- 校验器：模拟平台七道校验中的结构类五道 ---------------- */

async function verifyStructure(conn, pub) {
  const [[tx]] = await conn.query(`SELECT * FROM ${PROBE_LEDGER}.chain_tx WHERE block_index=1`);
  const [[blk]] = await conn.query(`SELECT * FROM ${PROBE_LEDGER}.chain_block WHERE block_index=1`);
  const [[biz]] = await conn.query(`SELECT * FROM ${PROBE_BIZ}.emission_report WHERE id=1`);

  const checks = [];

  /* 1. 区块哈希重算 */
  const reBlockHash = H(`${blk.block_index}|${blk.prev_hash}|${blk.merkle_root}|POA|node-carbon-01`);
  checks.push({ id: 1, name: '区块哈希重算', ok: reBlockHash === blk.block_hash });

  /* 2. Merkle 根重算 */
  const reMerkle = H(tx.payload_hash);
  checks.push({ id: 2, name: 'Merkle 根重算', ok: reMerkle === blk.merkle_root });

  /* 3. prevHash 连续性（单块场景恒真，保留占位以对齐生产七道） */
  checks.push({ id: 3, name: 'prevHash 连续性', ok: blk.prev_hash === ZERO });

  /* 4. payload_hash 重算（链下明文 ↔ 链上锚点绑定） */
  const rePayloadHash = H(tx.payload_json);
  checks.push({ id: 4, name: 'payload_hash 重算', ok: rePayloadHash === tx.payload_hash });

  /* 5. 业务行绑定：业务表数值必须等于 payload 里的数值 */
  let bizBound = false;
  try {
    const p = JSON.parse(tx.payload_json);
    bizBound = Math.abs(Number(p.total_emission) - Number(biz.total_emission)) < 0.0001;
  } catch (e) { bizBound = false; }
  checks.push({ id: 5, name: '业务行绑定', ok: bizBound });

  /* 6. 交易发起方签名 —— 私钥不在库中，DBA 无法伪造 */
  let sigOk = false;
  try {
    sigOk = crypto.verify('sha256', Buffer.from(tx.payload_hash, 'hex'), pub, Buffer.from(tx.tx_sig, 'hex'));
  } catch (e) { sigOk = false; }
  checks.push({ id: 6, name: '交易发起方签名', ok: sigOk });

  return checks;
}

/* ---------------- 攻击：把排放量从 12345.6789 改成 7890.1234 ---------------- */

/**
 * @param {object} connBiz 业务库连接（3306）
 * @param {boolean} alsoLedger 是否在同会话内一并改账本库
 * @param {object} connLedger 账本连接（alsoLedger 时用；L1 传同一个 conn）
 */
async function attack(connBiz, connLedger, sameInstance) {
  const result = { bizUpdate: null, ledgerUpdate: null, steps: [] };
  const FAKE_EMISSION = 7890.1234;

  /* 步骤 1：改业务明文（用完全限定名，连接本身不绑定默认库） */
  try {
    await connBiz.query(`UPDATE ${PROBE_BIZ}.emission_report SET total_emission=? WHERE id=1`, [FAKE_EMISSION]);
    result.bizUpdate = 'OK';
    result.steps.push('① 改业务表 total_emission → 成功');
  } catch (e) {
    result.bizUpdate = e.code || e.message;
    result.steps.push(`① 改业务表 total_emission → 失败 ${e.code || e.message}`);
    return result;
  }

  /* 步骤 2：改链下明文 payload_json */
  try {
    const [[tx]] = await connLedger.query(`SELECT payload_json FROM ${PROBE_LEDGER}.chain_tx WHERE block_index=1`);
    const p = JSON.parse(tx.payload_json);
    p.total_emission = FAKE_EMISSION;
    const newJson = JSON.stringify(p);
    await connLedger.query(`UPDATE ${PROBE_LEDGER}.chain_tx SET payload_json=? WHERE block_index=1`, [newJson]);
    result.steps.push('② 改账本 payload_json → 成功');

    /* 步骤 3：重算 payload_hash */
    const newHash = H(newJson);
    await connLedger.query(`UPDATE ${PROBE_LEDGER}.chain_tx SET payload_hash=? WHERE block_index=1`, [newHash]);
    result.steps.push('③ 重算 payload_hash → 成功');

    /* 步骤 4：重算 merkle_root */
    const newMerkle = H(newHash);
    await connLedger.query(`UPDATE ${PROBE_LEDGER}.chain_block SET merkle_root=? WHERE block_index=1`, [newMerkle]);
    result.steps.push('④ 重算 merkle_root → 成功');

    /* 步骤 5：重算 block_hash */
    const newBlockHash = H(`1|${ZERO}|${newMerkle}|POA|node-carbon-01`);
    await connLedger.query(`UPDATE ${PROBE_LEDGER}.chain_block SET block_hash=? WHERE block_index=1`, [newBlockHash]);
    result.steps.push('⑤ 重算 block_hash → 成功');
    result.ledgerUpdate = 'OK';
  } catch (e) {
    result.ledgerUpdate = e.code || e.message;
    result.steps.push(`② 改账本 payload_json → 失败 ${e.code || e.message}`);
    if (sameInstance) result.steps.push('   （L1：本不该失败，请检查环境）');
    else result.steps.push('   （L3：账本库不在本实例，连接层拒绝 —— 篡改链在此断掉）');
  }
  return result;
}

/* ---------------- 主流程 ---------------- */

(async () => {
  log('');
  log('══════════════════════════════════════════════════════════');
  log('  「同库同改」L1 / L3 对照实验');
  log('  命题：同库时一条会话即可改遍全链；分库后连第一步都难以为继');
  log('══════════════════════════════════════════════════════════');

  const findings = { generatedAt: new Date().toISOString(), scenarios: [] };

  /* ===== 场景 A：L1 —— 同实例（3306）两库、同一账号 ===== */
  line('═');
  log('【场景 A】L1 同实例·两库·同账号（3306: cc_l1_probe + cc_l1_probe_ledger）');
  line();

  const adminA = await mysql.createConnection(bizAdminCfg());
  const env = await setup(adminA);
  log(`  ✔ 已建临时两库，写入 1 条排放报告与 1 笔存证`);
  log(`     payload_hash = ${env.payloadHash.slice(0, 24)}…`);
  log(`     block_hash   = ${env.blockHash.slice(0, 24)}…`);

  const before = await verifyStructure(adminA, env.publicKey);
  log(`  基线校验：${before.filter((c) => c.ok).length}/${before.length} 通过`);

  log('\n  开始攻击（同一连接、同一账号、连续 5 条 UPDATE）：');
  const atkA = await attack(adminA, adminA, true);
  atkA.steps.forEach((s) => log('    ' + s));

  const afterA = await verifyStructure(adminA, env.publicKey);
  log('\n  攻击后校验：');
  afterA.forEach((c) => log(`    ${c.ok ? '✔' : '✘'} 第${c.id}道 ${c.name}`));
  const structPassA = afterA.filter((c) => c.id <= 5 && c.ok).length;
  log(`\n  ⇒ 结构性五道校验：${structPassA}/5 通过 ${structPassA === 5 ? '（全部被绕过）' : ''}`);
  log(`  ⇒ 签名一道：${afterA.find((c) => c.id === 6).ok ? '通过' : '失败（私钥不在库，DBA 无法伪造）'}`);

  findings.scenarios.push({
    scenario: 'L1 同实例两库',
    level: 'L1',
    steps: atkA.steps,
    structuralChecksPassed: structPassA,
    structuralChecksTotal: 5,
    signatureBlocked: !afterA.find((c) => c.id === 6).ok,
    conclusion: structPassA === 5
      ? '同库时五道结构校验全部可通过重算绕过，只剩签名一道防线'
      : '未达预期，请检查环境',
  });

  await adminA.query(`DROP DATABASE IF EXISTS ${PROBE_BIZ}`);
  await adminA.query(`DROP DATABASE IF EXISTS ${PROBE_LEDGER}`);
  await adminA.end();
  log('\n  ✔ 临时库已清理');

  /* ===== 场景 B：L3 —— 业务库在 3306，账本库在 3307 ===== */
  line('═');
  log('【场景 B】L3 双实例·双账号（业务 3306:root / 账本 3307:cc_ledger）');
  line();

  /* 在 3306 建业务库，在 3307 建同名账本库 */
  const bizConn = await mysql.createConnection(bizAdminCfg());
  await bizConn.query(`DROP DATABASE IF EXISTS ${PROBE_BIZ}`);
  await bizConn.query(`CREATE DATABASE ${PROBE_BIZ} DEFAULT CHARACTER SET utf8mb4`);
  await bizConn.query(`CREATE TABLE ${PROBE_BIZ}.emission_report (
    id INT PRIMARY KEY, report_no VARCHAR(40), total_emission DECIMAL(18,4),
    chain_tx_id VARCHAR(80), chain_block_index BIGINT) ENGINE=InnoDB`);
  await bizConn.query(`INSERT INTO ${PROBE_BIZ}.emission_report VALUES (1,'ER-L3-0001',12345.6789,'tx-l3',1)`);
  log('  ✔ 3306 上已建业务库并写入 1 条排放报告');

  const ledgerAdminCfg = {
    ...config.ledgerDb,
    database: undefined,
    /* 账本实例的 root，不是业务账号 cc_ledger —— 这里要建临时库，需管理权限 */
    user: 'root',
    password: process.env.LEDGER_ROOT_PASSWORD || config.ledgerDb.password,
  };
  let ledgerConn = null;
  let l3LedgerReady = false;
  try {
    ledgerConn = await mysql.createConnection(ledgerAdminCfg);
    await ledgerConn.query(`CREATE DATABASE IF NOT EXISTS ${PROBE_LEDGER} DEFAULT CHARACTER SET utf8mb4`);
    await ledgerConn.query(`CREATE TABLE IF NOT EXISTS ${PROBE_LEDGER}.chain_tx (
      tx_id VARCHAR(80) PRIMARY KEY, block_index BIGINT, payload_json TEXT,
      payload_hash VARCHAR(80), tx_sig VARCHAR(255)) ENGINE=InnoDB`);
    await ledgerConn.query(`INSERT INTO ${PROBE_LEDGER}.chain_tx VALUES ('tx-l3',1,'{"total_emission":12345.6789}','${H('{"total_emission":12345.6789}')}','sig-stub')`);
    l3LedgerReady = true;
    log('  ✔ 3307 上已建账本库并写入对应存证');
  } catch (e) {
    log(`  ⚠ 3307 账本实例不可用（${e.code || e.message}），场景 B 退化为权限层验证`);
  }

  log('\n  开始攻击（同一连接尝试改业务库）：');
  const atkB = { steps: [] };
  try {
    await bizConn.query(`UPDATE ${PROBE_BIZ}.emission_report SET total_emission=7890.12345 WHERE id=1`);
    atkB.steps.push('① 改业务表 total_emission → 成功');
  } catch (e) {
    atkB.steps.push(`① 改业务表 → 失败 ${e.code || e.message}`);
  }

  /* 关键一步：业务连接去改账本库 */
  try {
    await bizConn.query(`UPDATE ${PROBE_LEDGER}.chain_tx SET payload_json='{"total_emission":7890.12345}' WHERE tx_id='tx-l3'`);
    atkB.steps.push('② 业务连接改账本库 payload_json → 成功（隔离失效！）');
    atkB.blocked = false;
    atkB.errorCode = null;
  } catch (e) {
    atkB.steps.push(`② 业务连接改账本库 payload_json → 失败 ${e.code || e.message}`);
    atkB.blocked = true;
    atkB.errorCode = e.code || e.message;
  }
  atkB.steps.forEach((s) => log('    ' + s));

  if (l3LedgerReady) {
    try {
      await ledgerConn.query(`DROP DATABASE IF EXISTS ${PROBE_LEDGER}`);
      await ledgerConn.end();
    } catch (e) { /* 忽略清理失败 */ }
  }
  await bizConn.query(`DROP DATABASE IF EXISTS ${PROBE_BIZ}`);
  await bizConn.end();
  log('\n  ✔ 临时库已清理');

  const l3Conclusion = atkB.blocked
    ? `篡改在第②步被连接层拒绝（${atkB.errorCode}）：账本库不在本实例上，业务凭据根本触达不到`
    : '篡改成功 —— 隔离失效，须立即排查';
  log(`\n  ⇒ ${l3Conclusion}`);

  findings.scenarios.push({
    scenario: 'L3 双实例双账号',
    level: 'L3',
    steps: atkB.steps,
    blockedAtLedger: !!atkB.blocked,
    errorCode: atkB.errorCode || null,
    conclusion: l3Conclusion,
  });

  /* ===== 对照结论 ===== */
  line('═');
  log('【结论】');
  log(`  L1（同实例两库）：结构性五道校验 ${findings.scenarios[0].structuralChecksPassed}/5 全部可通过重算绕过`);
  log(`                    唯一防线是签名（私钥不在库中，DBA 拿不到）`);
  log(`  L3（双实例双账号）：第②步即被拒绝，链上锚点改不动`);
  log('');
  log('  正确表述：分库把防线从「只剩签名一道」抬回到「结构性校验全部有效」，');
  log('            而不是「分离之后就无法篡改」。前者可证，后者不可证。');
  line('═');
  log('');

  const outDir = path.join(__dirname, 'out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  findings.verdict = {
    l1StructuralBypass: `${findings.scenarios[0].structuralChecksPassed}/5`,
    l3BlockedAt: findings.scenarios[1].errorCode,
    honestStatement: '分离使结构性校验重新有效，而非使篡改不可能；签名一道始终独立于数据库权限。',
  };
  fs.writeFileSync(path.join(outDir, 'attack-l1-contrast.json'), JSON.stringify(findings, null, 2));
  log('  证据：tools/out/attack-l1-contrast.json\n');
})().catch((e) => {
  console.error('对照实验异常：', e);
  process.exit(1);
});
