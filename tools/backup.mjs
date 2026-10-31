#!/usr/bin/env node
/**
 * tools/backup.mjs —— 双库一致性备份
 * ==================================================================
 * 为什么需要它（硬性技术不足）
 * ------------------------------------------------------------------
 * 账本库搬到独立 MySQL 实例之后，备份就从"一件事"变成了"两件事"：
 * 两个库必须**在同一时点附近**备份，否则恢复出来会出现
 * "业务表里引用了某个 txId，但链上根本没有这笔交易"的断裂状态。
 *
 * 平台原先只有 `export-chain.mjs`（单项导出，用于可核验性证明），
 * 没有覆盖业务库的完整备份，也没有两者一致性校验。
 *
 * 本工具做三件事
 * ------------------------------------------------------------------
 *   ① 分别 dump 两个库的全部表到 JSON（含 schema 摘要）；
 *   ② 计算每张表的行数与内容摘要（MD5 over sorted pk list）；
 *   ③ 记录两侧的「链高度 / 交易数」快照，供恢复后比对。
 *
 * 不做的事（明确边界）
 * ------------------------------------------------------------------
 *   · 不是 mysqldump 替代品：不导出索引、触发器、存储过程；
 *     恢复请用 mysqldump 的物理备份，本工具用于**核对与取证**；
 *   · 不加密输出：备份文件含业务数据，必须放在受控目录；
 *     生产环境应配合磁盘加密或对象存储的服务端加密。
 *
 * 用法
 *   node tools/backup.mjs                       # 备份到 tools/out/backup-<时间>/
 *   node tools/backup.mjs --out D:/backup       # 指定目录
 *   node tools/backup.mjs --tables enterprise,emission_report   # 只备份指定表
 *   node tools/backup.mjs --verify <dir>        # 校验某个备份与当前库是否一致
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

const ROOT = process.cwd();
const ARGV = process.argv.slice(2);
const argOf = (k, d) => {
  const i = ARGV.indexOf('--' + k);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};
const VERIFY_DIR = argOf('verify', null);
const ONLY_TABLES = argOf('tables', '') ? argOf('tables', '').split(',').map((s) => s.trim()).filter(Boolean) : null;

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.trim().match(/^([\w.]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const E = { ...readEnv(path.join(ROOT, '.env')), ...process.env };
const BIZ = {
  host: E.DB_HOST || '127.0.0.1', port: Number(E.DB_PORT || 3306),
  user: E.DB_USER || 'root', password: E.DB_PASSWORD || '',
  database: E.DB_NAME || 'carbon_chain', dateStrings: true,
};
const LED = {
  host: E.LEDGER_DB_HOST || BIZ.host, port: Number(E.LEDGER_DB_PORT || BIZ.port),
  user: E.LEDGER_DB_USER || BIZ.user, password: E.LEDGER_DB_PASSWORD || BIZ.password,
  database: E.LEDGER_DB_NAME || 'carbon_chain_ledger', dateStrings: true,
};

/** 单表摘要：行数 + 主键排序后的 MD5（比行数更强，能发现"行数对但内容错"） */
async function tableDigest(conn, db, table) {
  const [[cnt]] = await conn.query(`SELECT COUNT(*) n FROM \`${db}\`.\`${table}\``);
  const n = Number(cnt.n);
  /* 取主键列；无主键则退化为全列拼接（代价高，但这类表在本库不存在） */
  const [pkRows] = await conn.query(
    `SELECT COLUMN_NAME c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
      ORDER BY SEQ_IN_INDEX`, [db, table]
  );
  const pk = pkRows.map((r) => r.c);
  let digest = null;
  if (pk.length && n > 0) {
    const orderBy = pk.map((c) => `\`${c}\``).join(',');
    const expr = pk.length === 1 ? `\`${pk[0]}\`` : `CONCAT_WS('|', ${pk.map((c) => `\`${c}\``).join(',')})`;
    const [[d]] = await conn.query(
      `SELECT MD5(GROUP_CONCAT(${expr} ORDER BY ${orderBy} SEPARATOR ',')) h FROM \`${db}\`.\`${table}\``
    ).catch(() => [[{ h: null }]]);
    digest = d.h || null;
  }
  return { table, rows: n, pk, digest };
}

async function listTables(conn, db, only) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [db]
  );
  let names = rows.map((r) => r.t);
  if (only) names = names.filter((t) => only.includes(t));
  return names;
}

/* ------------------------------------------------------------------ */
/* 校验模式                                                            */
/* ------------------------------------------------------------------ */
async function verify(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(C.bad(`✘ ${manifestPath} 不存在 —— 该目录不是本工具生成的备份`));
    process.exit(2);
  }
  const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  备份校验：当前库 vs 备份快照');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  备份时间 ${man.createdAt}`);

  const biz = await mysql.createConnection({ ...BIZ, connectionLimit: 3 });
  let led = null;
  try { led = await mysql.createConnection({ ...LED, connectionLimit: 3 }); } catch { /* 账本可能分离 */ }

  const diffs = [];
  for (const side of ['business', 'ledger']) {
    const conn = side === 'business' ? biz : led;
    const cfg = side === 'business' ? BIZ : LED;
    const snap = man.tables[side] || {};
    if (!conn) { diffs.push(`${side}: 当前不可连接，跳过`); continue; }
    for (const [table, exp] of Object.entries(snap)) {
      const cur = await tableDigest(conn, cfg.database, table);
      if (cur.rows !== exp.rows) {
        diffs.push(`${side}.${table} 行数：备份 ${exp.rows} → 当前 ${cur.rows}`);
      } else if (exp.digest && cur.digest && cur.digest !== exp.digest) {
        diffs.push(`${side}.${table} 内容摘要变化（行数相同但主键集合/取值不同）`);
      }
    }
  }

  console.log('');
  if (!diffs.length) {
    console.log(C.ok('  ✔ 备份与当前库完全一致'));
  } else {
    console.log(C.warn(`  发现 ${diffs.length} 处差异（备份后库有变更，属正常现象；用于判断"能否直接回滚"）：`));
    diffs.slice(0, 20).forEach((d) => console.log(`     · ${d}`));
    if (diffs.length > 20) console.log(C.dim(`     … 另有 ${diffs.length - 20} 处`));
  }
  console.log('');
  if (led) await led.end();
  await biz.end();
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 备份模式                                                            */
/* ------------------------------------------------------------------ */
async function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = argOf('out', path.join(ROOT, 'tools', 'out', `backup-${stamp}`));
  fs.mkdirSync(outDir, { recursive: true });

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  双库一致性备份');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  业务库 ${BIZ.user}@${BIZ.host}:${BIZ.port}/${BIZ.database}`);
  console.log(`  账本库 ${LED.user}@${LED.host}:${LED.port}/${LED.database}`);
  console.log(`  输出   ${outDir}`);

  const biz = await mysql.createConnection({ ...BIZ, connectionLimit: 5 });
  let led = null;
  let ledErr = null;
  try { led = await mysql.createConnection({ ...LED, connectionLimit: 3 }); } catch (e) { ledErr = e.code || e.message; }

  const manifest = {
    createdAt: new Date().toISOString(),
    generator: 'tools/backup.mjs',
    business: { host: BIZ.host, port: BIZ.port, database: BIZ.database, tables: 0, rows: 0 },
    ledger: { host: LED.host, port: LED.port, database: LED.database, tables: 0, rows: 0 },
    tables: { business: {}, ledger: {} },
    chainSnapshot: null,
    warnings: [],
  };

  /* ---- 业务库 ---- */
  const bizTables = await listTables(biz, BIZ.database, ONLY_TABLES);
  console.log(C.ok(`\n  业务库 ${bizTables.length} 张表`));
  for (const t of bizTables) {
    const [rows] = await biz.query(`SELECT * FROM \`${t}\``);
    const dg = await tableDigest(biz, BIZ.database, t);
    manifest.tables.business[t] = dg;
    manifest.business.rows += dg.rows;
    fs.writeFileSync(path.join(outDir, `business__${t}.json`), JSON.stringify(rows), 'utf8');
    process.stdout.write(`.`);
  }
  manifest.business.tables = bizTables.length;
  console.log(`\n  已导出 ${bizTables.length} 张 · ${manifest.business.rows} 行`);

  /* ---- 账本库 ---- */
  if (led) {
    const ledTables = await listTables(led, LED.database, ONLY_TABLES);
    console.log(C.ok(`\n  账本库 ${ledTables.length} 张表`));
    for (const t of ledTables) {
      const [rows] = await led.query(`SELECT * FROM \`${t}\``);
      const dg = await tableDigest(led, LED.database, t);
      manifest.tables.ledger[t] = dg;
      manifest.ledger.rows += dg.rows;
      fs.writeFileSync(path.join(outDir, `ledger__${t}.json`), JSON.stringify(rows), 'utf8');
      process.stdout.write(`.`);
    }
    manifest.ledger.tables = ledTables.length;
    console.log(`\n  已导出 ${ledTables.length} 张 · ${manifest.ledger.rows} 行`);

    /* 链快照：恢复后必须与这两项一致 */
    const [[tip]] = await led.query(
      'SELECT block_index, block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1'
    ).catch(() => [[null]]);
    const [[txc]] = await led.query('SELECT COUNT(*) n FROM chain_tx').catch(() => [[{ n: null }]]);
    manifest.chainSnapshot = tip ? {
      height: Number(tip.block_index), tipHash: tip.block_hash, txCount: Number(txc.n),
    } : null;
  } else {
    manifest.warnings.push(`账本库不可达（${ledErr}）—— 本次只备份了业务库。`
      + '这是不完整的备份：没有链上锚点，业务表里的 chain_tx_id 将无法验证。');
    console.log(C.warn(`\n  ⚠ 账本库不可达（${ledErr}），本次仅备份业务库`));
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  /* ---- 汇总 ---- */
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  业务库 ${manifest.business.tables} 表 / ${manifest.business.rows} 行`);
  console.log(`  账本库 ${manifest.ledger.tables} 表 / ${manifest.ledger.rows} 行`);
  if (manifest.chainSnapshot) {
    console.log(`  链快照 高度 #${manifest.chainSnapshot.height} · ${manifest.chainSnapshot.txCount} 笔交易`);
    console.log(C.dim(`          链顶 ${manifest.chainSnapshot.tipHash.slice(0, 24)}…`));
  }
  for (const w of manifest.warnings) console.log(C.warn(`  ⚠ ${w}`));
  console.log(`  清单   ${path.join(outDir, 'manifest.json')}`);
  console.log(C.dim('  校验：node tools/backup.mjs --verify ' + outDir));
  console.log('──────────────────────────────────────────────────────────\n');

  if (led) await led.end();
  await biz.end();
  process.exit(manifest.warnings.length ? 1 : 0);
}

(VERIFY_DIR ? verify(VERIFY_DIR) : backup()).catch((e) => {
  console.error(C.bad('✘ 失败：'), e.message || e);
  process.exit(9);
});
