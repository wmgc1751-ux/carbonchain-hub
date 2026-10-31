/**
 * attack-same-db.mjs —— 「同库同改」篡改演练（针对评审意见①的整改验收）
 * ==================================================================
 * 要验证的命题
 *   整改前：链上锚点与链下明文同库，DBA 一条 UPDATE 即可同时改掉两边，
 *           五道校验全部放行 —— 所谓"管理员无法事后篡改"不成立。
 *   整改后：账本 5 表迁入**独立 MySQL 实例**（不是同实例的另一个 schema），
 *           业务侧凭据在连接层就够不到账本；且每一类改动都有对应的一层收口。
 *
 * 与上一版的差别（本轮升级）
 * ------------------------------------------------------------------
 *   ① 先量化「隔离强度」L0~L3，并把它写进证据文件 —— 演练结论只在
 *      它实际所处的强度下成立，不能拿 L1 的结果去背书 L3 的声明；
 *   ② 新增「DBA 越权同改」用例：用业务侧的**最高权限账号**尝试同时改
 *      业务明文与账本锚点，记录失败发生在哪一层（连接层 / 权限层 /
 *      密码学层）—— 这正是评审说的"一条 UPDATE"那条路径；
 *   ③ 账本不可达时不再伪装成功，而是如实标 SKIP 并写明原因。
 *
 * 用法
 *   node tools/attack-same-db.mjs
 *   node tools/attack-same-db.mjs --level-probe   # 只报告隔离强度
 * 产物
 *   tools/out/attack-same-db.json（证据留档，论文 §5.2 引用）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const config = require('../server/config');
const db = require('../server/db');
const cu = require('../server/blockchain/crypto-utils');
const anchorSvc = require('../server/services/anchor');
const bizBinding = require('../server/services/bizBinding');

const OUT_DIR = path.resolve(config.paths.root, 'tools', 'out');
const results = [];
const ARGV = process.argv.slice(2);
const LEVEL_ONLY = ARGV.includes('--level-probe');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

const LEVELS = {
  L0: { label: '同库同表', guarded: false },
  L1: { label: '同实例不同库', guarded: false },
  L2: { label: '不同实例同账号', guarded: true },
  L3: { label: '不同实例不同账号', guarded: true },
};

function rec(name, expect, actual, detail) {
  const hit = actual.verdict === expect;
  results.push({ case: name, expect, ...actual, detail, hit });
  const tag = hit ? C.ok('命中预期') : C.bad('与预期不符');
  console.log(`  ${hit ? '✔' : '✘'} ${C.b(name.padEnd(36))} ${tag}`);
  console.log(`     ${C.dim('预期')} ${expect}`);
  console.log(`     ${C.dim('实际')} ${actual.verdict}${actual.codes && actual.codes.length ? '  [' + actual.codes.join(', ') + ']' : ''}`);
  if (detail) console.log(`     ${C.dim('说明')} ${detail}`);
}

function skip(name, expect, reason) {
  results.push({ case: name, expect, verdict: 'SKIPPED', reason, hit: null });
  console.log(`  ${C.dim('⊘')} ${C.b(name.padEnd(36))} ${C.dim('SKIP')} —— ${reason}`);
}

/** 跑一次全链校验（不走缓存），返回判定与错误码集合 */
async function runChainCheck() {
  const chain = await anchorSvc.getChain();
  const r = await chain.validateChain({ fromIndex: 0 });
  return {
    verdict: r.valid ? 'CHAIN_VALID' : 'CHAIN_INVALID',
    codes: [...new Set(r.errors.map((e) => e.type))],
    errors: r.errors.slice(0, 5),
    coverage: r.coverage,
    valid: r.valid,
  };
}

async function runBindingCheck() {
  const r = await bizBinding.verifyBusinessBinding();
  return {
    verdict: r.mismatch ? 'BIZ_BINDING_MISMATCH' : 'BIZ_BINDING_OK',
    codes: r.mismatch ? ['BIZ_BINDING_MISMATCH'] : [],
    mismatch: r.mismatch,
    sample: r.mismatches.slice(0, 3),
    checked: r.checked,
  };
}

/** 组合判定：先看链，再看业务绑定 */
async function runAll() {
  const chain = await runChainCheck();
  const bind = await runBindingCheck();
  return {
    verdict: chain.valid && bind.mismatch === 0 ? 'ALL_CLEAN' : 'DETECTED',
    codes: [...chain.codes, ...bind.codes],
    chain,
    binding: bind,
  };
}

async function main() {
  const sep = db.separationFacts();
  const lv = LEVELS[sep.level] || LEVELS.L0;

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  「同库同改」篡改演练 —— 隔离强度 + 攻击路径逐层收口');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  业务库 ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`  账本库 ${config.ledgerDb.user}@${config.ledgerDb.host}:${config.ledgerDb.port}/${config.ledgerDb.database}`);
  console.log(`  隔离强度 ${C.b(sep.level)}（${lv.label}）${lv.guarded ? C.ok(' —— 业务侧凭据到不了账本') : C.warn(' —— 业务侧凭据可达账本')}`);

  if (LEVEL_ONLY) {
    console.log(JSON.stringify({ level: sep.level, label: lv.label, guarded: lv.guarded, sameInstance: sep.sameInstance, sameUser: sep.sameUser }, null, 2));
    await db.ledgerPool.end().catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(0);
  }

  /* ---------- 0. 基线 ---------- */
  console.log('\n【0】基线：未篡改时应全绿');
  const base = await runAll();
  rec('基线（未篡改）', 'ALL_CLEAN', base,
    `区块 ${base.chain.coverage.blocksHashRecomputed} 个 / 存证 ${base.chain.coverage.txPayloadBindingChecked} 笔 / 业务行 ${base.binding.checked} 笔`);

  /* 选一个同时具备业务行与链上存证的样本（排放上报单） */
  const sample = await db.one(
    `SELECT r.id, r.report_no, r.total_emission, r.chain_tx_id, r.chain_block_index
       FROM emission_report r WHERE r.chain_tx_id IS NOT NULL ORDER BY r.id LIMIT 1`
  );
  if (!sample) throw new Error('找不到可用于演练的排放上报单样本');
  const tx0 = await db.ledgerOne(
    'SELECT tx_id, payload_hash, payload_json, block_index FROM chain_tx WHERE tx_id = ?',
    [sample.chain_tx_id]
  );
  if (!tx0) throw new Error(`账本库中查不到样本存证 ${sample.chain_tx_id} —— 请先确认账本库已迁移并可用`);
  console.log(C.dim(`\n  样本：${sample.report_no}（业务表 id=${sample.id}，链上 ${tx0.tx_id.slice(0, 16)}…，区块 #${tx0.block_index}）`));

  /* 还原基准必须取自**链上存证**，不能取自业务表当前值。
   * 早期实现用 sample.total_emission（业务表读出的值）当还原目标 ——
   * 一旦上次演练异常中断留下被篡改的脏值，本次就把脏值当成"正确值"，
   * restore() 原地踏步，基线永远报 BIZ_BINDING_MISMATCH，且越跑越脏。
   * 链是事实源：payload.claimtotalEmission 才是该单应有的值。 */
  const truthFromChain = (() => {
    try {
      const p = JSON.parse(tx0.payload_json);
      const v = Number(p.totalEmission);
      return Number.isFinite(v) ? v : Number(sample.total_emission);
    } catch { return Number(sample.total_emission); }
  })();
  if (Number(sample.total_emission) !== truthFromChain) {
    console.log(C.warn(`  ⚠ 业务表当前值 ${sample.total_emission} 与链上存证 ${truthFromChain} 不一致，`
      + '将按链上存证还原（多为上次演练异常中断所致）'));
  }

  const restore = async () => {
    await db.query('UPDATE emission_report SET total_emission = ? WHERE id = ?', [truthFromChain, sample.id]);
    await db.ledgerQuery('UPDATE chain_tx SET payload_json = ?, payload_hash = ? WHERE tx_id = ?',
      [tx0.payload_json, tx0.payload_hash, tx0.tx_id]);
  };

  try {
    /* ---------- 1. 只改业务库明文（评审所说"一条 UPDATE"） ---------- */
    console.log('\n【1】攻击一：只改业务库明文 —— 不动任何链上字段');
    const fake = Number(sample.total_emission) - 10000;
    await db.query('UPDATE emission_report SET total_emission = ? WHERE id = ?', [fake, sample.id]);
    const a1 = await runAll();
    rec('只改业务库 total_emission', 'DETECTED', a1,
      '链上五道全绿（链确实没被动过），但第六道「业务行绑定」把它抓了出来 —— '
      + '这正是整改前完全无感的那条路径');
    if (a1.chain.valid) console.log(C.dim('     ▸ 第①~⑤道结果：CHAIN_VALID（证明单纯加链上校验抓不到业务表改动）'));
    await restore();

    /* ---------- 2. 只改账本 payload_json ---------- */
    console.log('\n【2】攻击二：只改账本库的存证明文（payload_json），锚点不动');
    const p2 = JSON.parse(tx0.payload_json);
    const key2 = Object.keys(p2).find((k) => typeof p2[k] === 'number') || 'totalEmission';
    p2[key2] = Number(p2[key2]) - 10000;
    await db.ledgerQuery('UPDATE chain_tx SET payload_json = ? WHERE tx_id = ?', [JSON.stringify(p2), tx0.tx_id]);
    const a2 = await runAll();
    rec('只改 payload_json', 'DETECTED', a2, `被改字段 ${key2}；第⑤道「链下重算绑定」检出`);
    await restore();

    /* ---------- 3. 同库同改：业务表 + 存证明文 ---------- */
    console.log('\n【3】攻击三：同库同改（业务表 + 账本 payload_json 一起改）');
    await db.query('UPDATE emission_report SET total_emission = ? WHERE id = ?', [fake, sample.id]);
    await db.ledgerQuery('UPDATE chain_tx SET payload_json = ? WHERE tx_id = ?', [JSON.stringify(p2), tx0.tx_id]);
    const a3 = await runAll();
    rec('业务表 + payload_json 同改', 'DETECTED', a3,
      '两处同时改，第⑥道与第⑤道同时报警 —— 改两处并不会互相掩护');
    await restore();

    /* ---------- 4. 同改 + 同步更新 payload_hash ---------- */
    console.log('\n【4】攻击四：同改 + 同步重算 payload_hash（试图骗过第⑤道）');
    const newHash = cu.hashObject(p2);
    await db.query('UPDATE emission_report SET total_emission = ? WHERE id = ?', [fake, sample.id]);
    await db.ledgerQuery('UPDATE chain_tx SET payload_json = ?, payload_hash = ? WHERE tx_id = ?',
      [JSON.stringify(p2), newHash, tx0.tx_id]);
    const a4 = await runAll();
    rec('同改 + 改 payload_hash', 'DETECTED', a4,
      '第⑤道被绕过（摘要自洽），但 payload_hash 是被发起方私钥签名的字段，'
      + '第(6)项交易签名校验随之失败 —— 私钥在节点本地 keystore，库里没有');
    if (a4.chain.codes.includes('TX_SIGNATURE_INVALID')) {
      console.log(C.dim('     ▸ TX_SIGNATURE_INVALID 命中：篡改者无法在不持有私钥的情况下重签交易'));
    }
    await restore();

    /* ---------- 5. DBA 越权同改（评审"一条 UPDATE"最接近的复现） ----------
     * 与攻击三的区别：这里用的不是「业务代码的建连方式」，而是**业务侧最高权限账号**
     * 的原始连接，模拟一个拿到业务库 DBA 凭据的人，试图用一条连接同时改两边。
     * 判定要点不是"是否报错"，而是**在哪一层被拦住**：
     *   · L0/L1：同实例 → 连接层就能触达，只能靠密码学层兜底（第⑤⑥道）
     *   · L2/L3：不同实例 → 那条连接根本不可能指向账本库（连接层即失败） */
    console.log('\n【5】攻击五：业务侧 DBA 凭据越权同改（一条连接改两边）');
    let dbaCase;
    try {
      const rootConn = await mysql.createConnection({
        host: config.db.host, port: config.db.port,
        user: config.db.user, password: config.db.password,
        database: config.db.database,        /* 必须选库：下面的对照组用的是不带库名的表名 */
        multipleStatements: false,
      });
      const attempts = [];

      /* (a) 同一连接里用限定名直写账本库 —— 跨实例时必然失败 */
      try {
        await rootConn.query(
          `UPDATE \`${config.ledgerDb.database}\`.chain_tx SET payload_json = payload_json WHERE tx_id = ?`,
          [tx0.tx_id]
        );
        attempts.push({ label: '同一连接限定名直写账本库', result: 'ALLOWED', layer: null });
      } catch (e) {
        /* 跨实例时 MySQL 会报"未知数据库"；同实例但无权限时报权限错 —— 两者都是连接/权限层的拦截 */
        attempts.push({
          label: '同一连接限定名直写账本库',
          result: 'DENIED',
          layer: e.code === 'ER_DBACCESS_DENIED_ERROR' || e.code === 'ER_TABLEACCESS_DENIED_ERROR'
            ? '权限层' : '连接层（库不在该实例上）',
          code: e.code,
          message: String(e.sqlMessage || e.message).slice(0, 120),
        });
      }

      /* (b) 业务明文仍然可以改 —— 这一步必须成功，否则说明业务账号本身有问题，
       *     演练结论就不成立（不能靠"业务库也改不动"来冒充安全） */
      try {
        await rootConn.query('UPDATE emission_report SET total_emission = ? WHERE id = ?', [fake, sample.id]);
        attempts.push({ label: '业务库明文（对照组）', result: 'ALLOWED', layer: null, note: '预期成功：这是业务账号的正当权限' });
      } catch (e) {
        attempts.push({ label: '业务库明文（对照组）', result: 'DENIED', code: e.code, message: String(e.sqlMessage || e.message).slice(0, 120) });
      }
      await rootConn.end();

      const ledgerBlocked = attempts[0].result === 'DENIED';
      const bizWritable = attempts[1].result === 'ALLOWED';
      dbaCase = {
        verdict: ledgerBlocked ? (bizWritable ? 'SPLIT_AT_CONNECTION' : 'BIZ_ALSO_BLOCKED') : 'SAME_SESSION_WRITE',
        codes: attempts.filter((x) => x.code).map((x) => x.code),
        level: sep.level,
        attempts,
      };
      rec('DBA 凭据越权同改', 'SPLIT_AT_CONNECTION', dbaCase,
        ledgerBlocked
          ? `改业务明文成功、改账本被拒（${attempts[0].layer}，${attempts[0].code}）—— `
            + `"一条连接同改两边"在 ${sep.level} 强度下不成立`
          : '⚠ 同一连接改动了账本 —— 当前隔离强度不足以在连接层拦截，只能依赖第⑤⑥道密码学校验');
    } catch (e) {
      skip('DBA 凭据越权同改', 'SPLIT_AT_CONNECTION', `无法建立业务侧 DBA 连接：${e.code || e.message}`);
    }
    await restore();

    /* ---------- 6. 越权写入账本库（业务应用账号） ---------- */
    console.log('\n【6】攻击六：业务应用账号直接写账本库（权限隔离验证）');
    let permCase;
    try {
      const probeUser = `cc_app_probe_${Date.now().toString().slice(-6)}`;
      const probePwd = 'Probe#2026';
      /* 在业务实例上建一个「只有业务权限」的账号。
       * 跨实例时这个账号在账本实例上根本不存在 —— 这正是 L3 的强度来源。 */
      const rootConn = await mysql.createConnection({ ...config.db, multipleStatements: false });
      await rootConn.query(`CREATE USER IF NOT EXISTS '${probeUser}'@'%' IDENTIFIED BY '${probePwd}'`);
      await rootConn.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${config.db.database}\`.* TO '${probeUser}'@'%'`);
      let grantedLedgerSelect = false;
      try {
        await rootConn.query(`GRANT SELECT ON \`${config.ledgerDb.database}\`.* TO '${probeUser}'@'%'`);
        grantedLedgerSelect = true;
      } catch { /* 跨实例时业务实例上不存在该库，授权语句本身就会失败 —— 这正是预期 */ }
      await rootConn.query('FLUSH PRIVILEGES');

      const appConn = await mysql.createConnection({
        host: config.db.host, port: config.db.port,
        user: probeUser, password: probePwd,
        database: config.db.database, multipleStatements: false,
      });
      const attempts = [];
      for (const [label, sql] of [
        ['用限定名直写账本库', `UPDATE \`${config.ledgerDb.database}\`.chain_tx SET payload_json = payload_json WHERE tx_id = ?`],
        ['连到账本实例再写', null],   // 需要另开连接，下面单独测
      ]) {
        if (!sql) continue;
        try {
          await appConn.query(sql, [tx0.tx_id]);
          attempts.push({ label, result: 'ALLOWED', code: null, layer: null });
        } catch (e) {
          attempts.push({
            label, result: 'DENIED', code: e.code, layer: '连接层/权限层',
            message: String(e.sqlMessage || e.message).slice(0, 120),
          });
        }
      }
      /* 直接尝试用业务账号连账本实例 —— L3 下该账号在账本实例上不存在 */
      try {
        const direct = await mysql.createConnection({
          host: config.ledgerDb.host, port: config.ledgerDb.port,
          user: probeUser, password: probePwd,
          multipleStatements: false,
        });
        await direct.query(
          `UPDATE \`${config.ledgerDb.database}\`.chain_tx SET payload_json = payload_json WHERE tx_id = ?`, [tx0.tx_id]
        );
        attempts.push({ label: '用业务账号连账本实例后写', result: 'ALLOWED', code: null, layer: null });
        await direct.end();
      } catch (e) {
        attempts.push({
          label: '用业务账号连账本实例后写', result: 'DENIED',
          code: e.code, layer: '认证层（账号在账本实例上不存在/无权限）',
          message: String(e.sqlMessage || e.message).slice(0, 120),
        });
      }
      await appConn.end();
      try { await rootConn.query(`DROP USER IF EXISTS '${probeUser}'@'%'`); } catch { /* ignore */ }
      await rootConn.end();

      const allDenied = attempts.every((x) => x.result === 'DENIED');
      permCase = {
        verdict: allDenied ? 'PERMISSION_DENIED' : 'WRITE_ALLOWED',
        codes: attempts.filter((x) => x.result === 'DENIED').map((x) => x.code),
        attempts,
        grantedLedgerSelect,
        detail: attempts.map((x) => `${x.label}=${x.result}${x.code ? '(' + x.code + ')' : ''}`).join('；'),
      };
      rec('业务账号越权写账本库', 'PERMISSION_DENIED', permCase, permCase.detail);
    } catch (e) {
      skip('业务账号越权写账本库', 'PERMISSION_DENIED', e.message);
    }

    /* ---------- 7. 复查：恢复后必须回到全绿 ---------- */
    console.log('\n【7】收尾：恢复现场后复核');
    await restore();
    const fin = await runAll();
    rec('恢复后复核', 'ALL_CLEAN', fin, '所有用例均已还原，可重复执行');
  } finally {
    await restore().catch(() => {});
  }

  /* ---------- 汇总 ---------- */
  const hitN = results.filter((r) => r.hit === true).length;
  const skipN = results.filter((r) => r.hit === null).length;
  const missN = results.filter((r) => r.hit === false).length;
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  隔离强度 ${C.b(sep.level)}（${lv.label}）`);
  console.log(`  用例 ${results.length} 组：命中 ${hitN} / 不符 ${missN} / 跳过 ${skipN}`);
  console.log(`  结论：${missN === 0 ? C.ok('每条攻击路径都被某一层校验收口') : C.bad('存在未被收口的路径，需修正')}`);
  console.log('──────────────────────────────────────────────────────────\n');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'attack-same-db.json');
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    level: sep.level,
    levelLabel: lv.label,
    levelGuarded: lv.guarded,
    business: { host: config.db.host, port: config.db.port, database: config.db.database },
    ledger: { host: config.ledgerDb.host, port: config.ledgerDb.port, database: config.ledgerDb.database },
    businessDb: config.db.database,
    ledgerDb: config.ledgerDb.database,
    splitDb: !sep.sameInstance || config.ledgerDb.database !== config.db.database,
    sample: { reportNo: sample.report_no, txId: tx0.tx_id, blockIndex: Number(tx0.block_index) },
    summary: { total: results.length, hit: hitN, mismatch: missN, skipped: skipN },
    cases: results,
  }, null, 2), 'utf8');
  console.log(C.dim(`  证据已写出：${outFile}`));

  await db.ledgerPool.end().catch(() => {});
  await db.pool.end().catch(() => {});
  process.exit(missN === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(C.bad('✘ 演练异常终止：'), e);
  try { await db.ledgerPool.end(); } catch (_) { /* ignore */ }
  try { await db.pool.end(); } catch (_) { /* ignore */ }
  process.exit(2);
});
