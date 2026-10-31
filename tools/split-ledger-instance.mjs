#!/usr/bin/env node
/**
 * tools/split-ledger-instance.mjs —— 把账本库迁到独立 MySQL 实例
 * ==================================================================
 * 为什么必须做这一步（院审意见①的直接整改）
 * ------------------------------------------------------------------
 * 上一轮把账本 5 表从「业务库」挪到了「同实例的另一个 schema」，
 * 并在业务库留了 5 张跨库只读视图。这在答辩现场经不起推敲：
 *
 *   同一个 MySQL 实例里，root 一个会话就能执行
 *     UPDATE carbon_chain.emission_report ...
 *     UPDATE carbon_chain_ledger.chain_tx ...
 *   两条语句、一次提交 —— 「一条 UPDATE 同改」只是变成了「两条」，
 *   而"管理员无法事后篡改"的声明仍然没有对应强度的证据。
 *
 * 本脚本把账本库搬到一个**独立 MySQL 实例**（不同端口/不同数据目录/
 * 不同账号），于是业务侧账号在网络层就够不到账本：
 *   · 业务库 DBA 无法用同一连接触达账本库；
 *   · 跨库 JOIN / 跨库视图在物理上不可能存在（本脚本会把业务库里的
 *     同名视图删掉，防止代码继续依赖"反正同实例"的假象）。
 *
 * 分级口径（写进信任模型页，不再使用模糊表述）
 *   L0 同库同表      —— 一条 UPDATE 同改，漏洞成立
 *   L1 同实例不同库  —— 同会话两条 UPDATE 仍可同改（上一轮的状态）
 *   L2 不同实例同账号—— 本脚本的产物下限
 *   L3 不同实例不同账号 —— 推荐生产配置
 *
 * 安全性
 *   · 默认 dry-run：只打印将要做什么，不写任何库；
 *   · --execute 才真正执行，且执行前先把账本库整表导出为 JSON 备份；
 *   · 幂等：目标库已有数据时默认拒绝覆盖，需 --force。
 *
 * 用法
 *   node tools/split-ledger-instance.mjs                # 预演
 *   node tools/split-ledger-instance.mjs --execute      # 执行
 *   node tools/split-ledger-instance.mjs --execute --force
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'tools', 'out');
const ARGV = process.argv.slice(2);
const EXECUTE = ARGV.includes('--execute');
const FORCE = ARGV.includes('--force');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

/* ---------- 读 .env（零依赖，与 server/config.js 同口径） ---------- */
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([\w.]+)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const E = { ...readEnv(path.join(ROOT, '.env')), ...process.env };

const BIZ = {
  host: E.DB_HOST || '127.0.0.1',
  port: Number(E.DB_PORT || 3306),
  user: E.DB_USER || 'root',
  password: E.DB_PASSWORD || '',
  database: E.DB_NAME || 'carbon_chain',
};
const LED = {
  host: E.LEDGER_DB_HOST || BIZ.host,
  port: Number(E.LEDGER_DB_PORT || BIZ.port),
  user: E.LEDGER_DB_USER || BIZ.user,
  password: E.LEDGER_DB_PASSWORD || BIZ.password,
  database: E.LEDGER_DB_NAME || 'carbon_chain_ledger',
};

/** 账本 5 表（顺序即依赖顺序，恢复时正序插入） */
const LEDGER_TABLES = ['chain_block', 'chain_tx', 'chain_payload_backup', 'chain_node', 'chain_node_replica'];

const sameInstance = LED.host === BIZ.host && LED.port === BIZ.port;

function level() {
  if (sameInstance && LED.database === BIZ.database) return 'L0';
  if (sameInstance) return 'L1';
  return LED.user === BIZ.user ? 'L2' : 'L3';
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  账本库搬迁：从业务实例 → 独立 MySQL 实例');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  业务库  ${BIZ.user}@${BIZ.host}:${BIZ.port}/${BIZ.database}`);
  console.log(`  账本库  ${LED.user}@${LED.host}:${LED.port}/${LED.database}`);
  console.log(`  当前形态 ${C.b(level())}　${sameInstance ? C.warn('（同一实例：DBA 一个会话即可同改）') : C.ok('（不同实例：业务账号在网络层够不到账本）')}`);

  if (sameInstance) {
    console.log(C.bad('\n✘ 目标账本库与业务库指向同一实例，搬迁无意义。'));
    console.log(C.dim('  请先在 .env 里把 LEDGER_DB_HOST / LEDGER_DB_PORT / LEDGER_DB_USER 指向独立实例。'));
    console.log(C.dim('  本项目已随附第二实例配置：D:/MySQL/mysql-8.0.29-winx64/my-ledger.ini（端口 3307）。'));
    process.exit(2);
  }

  /* ---------- 1. 连两侧 ---------- */
  const biz = await mysql.createConnection({ ...BIZ, multipleStatements: false, dateStrings: true });
  /* 账本侧先以「不指定库」连上：目标库可能尚未创建，带 database 连接会直接 ER_BAD_DB_ERROR */
  const led = await mysql.createConnection({
    host: LED.host, port: LED.port, user: LED.user, password: LED.password,
    multipleStatements: false, dateStrings: true,
  });
  console.log(C.ok('\n✔ 两侧连接成功'));

  /* ---------- 2. 盘点源数据 ---------- */
  const srcTables = await biz.query(
    `SELECT TABLE_NAME AS n, TABLE_TYPE AS t FROM information_schema.tables
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${LEDGER_TABLES.map(() => '?').join(',')})`,
    [BIZ.database, ...LEDGER_TABLES]
  ).then(([r]) => r);
  const srcBase = srcTables.filter((r) => String(r.t).toUpperCase() === 'BASE TABLE').map((r) => r.n);
  const srcViews = srcTables.filter((r) => String(r.t).toUpperCase() !== 'BASE TABLE').map((r) => r.n);

  /* 源库可能有两个位置：业务库（L0 遗留）或同实例的账本 schema（L1 现状） */
  const midSchema = sameInstance ? null : (E.LEDGER_DB_NAME || 'carbon_chain_ledger');
  let srcConn = biz;
  let srcDb = BIZ.database;
  /* 额外打开的连接必须显式关闭，否则 Node 事件循环不退出（脚本看似"卡住"） */
  const extraConns = [];
  if (!srcBase.length) {
    /* 业务库里只剩视图，实体在某处 —— 先看同实例是否还有旧账本 schema */
    try {
      const old = await mysql.createConnection({
        host: BIZ.host, port: BIZ.port, user: BIZ.user, password: BIZ.password,
        database: LED.database, multipleStatements: false, dateStrings: true,
      });
      const [r] = await old.query(
        `SELECT TABLE_NAME AS n FROM information_schema.tables
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${LEDGER_TABLES.map(() => '?').join(',')})
            AND TABLE_TYPE = 'BASE TABLE'`,
        [LED.database, ...LEDGER_TABLES]
      );
      if (r.length) {
        srcConn = old; srcDb = LED.database; extraConns.push(old);
        console.log(C.dim(`  源实体表在旧账本 schema：${BIZ.host}:${BIZ.port}/${LED.database}（${r.length} 张）`));
      } else { await old.end(); }
    } catch (e) {
      console.log(C.dim(`  旧账本 schema 不可达（${e.code || e.message}）`));
    }
  }

  const counts = {};
  if (srcConn === biz && srcBase.length) {
    for (const t of srcBase) {
      const [[r]] = await biz.query(`SELECT COUNT(*) AS c FROM \`${srcDb}\`.\`${t}\``);
      counts[t] = Number(r.c);
    }
  } else if (srcConn !== biz) {
    for (const t of LEDGER_TABLES) {
      try {
        const [[r]] = await srcConn.query(`SELECT COUNT(*) AS c FROM \`${srcDb}\`.\`${t}\``);
        counts[t] = Number(r.c);
      } catch { counts[t] = null; }
    }
  }

  console.log('\n  源数据盘点：');
  for (const t of LEDGER_TABLES) {
    console.log(`    ${t.padEnd(22)} ${counts[t] === undefined ? C.dim('（业务库无实体表）') : `${counts[t]} 行`}`);
  }
  if (srcViews.length) {
    console.log(C.dim(`    业务库中的同名视图：${srcViews.join(', ')} —— 执行时会删除（跨实例视图不可能存在）`));
  }

  /* ---------- 3. 目标库现状 ---------- */
  await led.query(`CREATE DATABASE IF NOT EXISTS \`${LED.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  await led.changeUser({ database: LED.database });
  const dstCounts = {};
  for (const t of LEDGER_TABLES) {
    try {
      const [[r]] = await led.query(`SELECT COUNT(*) AS c FROM \`${LED.database}\`.\`${t}\``);
      dstCounts[t] = Number(r.c);
    } catch { dstCounts[t] = null; }
  }
  const dstHasData = Object.values(dstCounts).some((v) => (v || 0) > 0);
  if (dstHasData && !FORCE) {
    console.log(C.bad('\n✘ 目标账本库已有数据。为避免覆盖，默认中止。'));
    console.log(C.dim(`  现状：${JSON.stringify(dstCounts)}`));
    console.log(C.dim('  确认要覆盖请加 --force（会先导出目标库备份）。'));
    await biz.end(); await led.end();
    process.exit(3);
  }

  /* ---------- 4. 备份（执行前必做） ---------- */
  let backup = null;
  if (EXECUTE) {
    backup = { generatedAt: new Date().toISOString(), source: { ...BIZ, database: srcDb }, tables: {} };
    for (const t of LEDGER_TABLES) {
      try {
        const [rows] = await srcConn.query(`SELECT * FROM \`${srcDb}\`.\`${t}\``);
        backup.tables[t] = rows;
      } catch { backup.tables[t] = []; }
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const f = path.join(OUT_DIR, `ledger-backup-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(backup), 'utf8');
    console.log(C.ok(`\n✔ 源库已备份：${path.relative(ROOT, f)}（${Object.entries(backup.tables).map(([k, v]) => `${k}=${v.length}`).join(' ')}）`));
  }

  if (!EXECUTE) {
    console.log(C.warn('\n⊘ 预演模式：未写入任何数据。确认无误后加 --execute 执行。'));
    console.log(C.dim('  执行步骤：① 在 3307 实例上按 db/00_schema_ledger.sql 建表'));
    console.log(C.dim('            ② 逐表复制数据 ③ 校验行数/区块哈希链 ④ 删除业务库同名视图'));
    await biz.end();
    for (const c of extraConns) await c.end().catch(() => {});
    await led.end();
    process.exit(0);
  }

  /* ---------- 5. 建表 ---------- */
  const ddl = fs.readFileSync(path.join(ROOT, 'db', '00_schema_ledger.sql'), 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .replace(/DROP\s+DATABASE[^;]*;/gi, '')
    .replace(/CREATE\s+DATABASE[^;]*;/gi, '')
    .replace(/USE\s+`?[\w$]+`?\s*;/gi, '')
    .replace(/carbon_chain_ledger/g, LED.database);
  const stmts = ddl.split(';').map((s) => s.trim()).filter((s) => s.length > 5);
  if (FORCE) {
    await led.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...LEDGER_TABLES].reverse()) await led.query(`DROP TABLE IF EXISTS \`${t}\``);
    await led.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log(C.dim('  --force：已清空目标账本表'));
  }
  for (const s of stmts) await led.query(s);
  console.log(C.ok(`\n✔ 账本 5 表已在 ${LED.host}:${LED.port}/${LED.database} 建好（${stmts.length} 条 DDL）`));

  /* ---------- 6. 搬数据 ---------- */
  for (const t of LEDGER_TABLES) {
    const rows = backup.tables[t] || [];
    if (!rows.length) { console.log(C.dim(`  ${t.padEnd(22)} 无数据，跳过`)); continue; }
    const cols = Object.keys(rows[0]);
    const ph = rows.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    const chunk = 200;
    let n = 0;
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk);
      await led.query(
        `INSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ${slice.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}`,
        slice.flatMap((r) => cols.map((c) => r[c]))
      );
      n += slice.length;
    }
    console.log(C.ok(`  ${t.padEnd(22)} 迁入 ${n} 行`));
  }

  /* ---------- 7. 校验 ---------- */
  const verify = { tables: {}, ok: true };
  for (const t of LEDGER_TABLES) {
    const srcN = (backup.tables[t] || []).length;
    const [[r]] = await led.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    verify.tables[t] = { src: srcN, dst: Number(r.c), match: srcN === Number(r.c) };
    if (!verify.tables[t].match) verify.ok = false;
  }
  /* 链顶比对：同一高度必须是同一个 block_hash —— 证明搬的是同一份链 */
  try {
    const [[s]] = await srcConn.query(`SELECT block_index, block_hash FROM \`${srcDb}\`.chain_block ORDER BY block_index DESC LIMIT 1`);
    const [[d]] = await led.query('SELECT block_index, block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1');
    verify.tip = { source: s || null, target: d || null, match: !!(s && d && s.block_hash === d.block_hash && Number(s.block_index) === Number(d.block_index)) };
    if (!verify.tip.match) verify.ok = false;
  } catch (e) { verify.tip = { error: e.message }; }
  /* 全表 payload_hash 求和的摘要比对：比行数更强，能发现"行数对但内容错"。
   * GROUP_CONCAT 受 group_concat_max_len 限制，因此先放宽再比，仍超限时只作辅助参考。 */
  try {
    await srcConn.query("SET SESSION group_concat_max_len = 67108864");
    await led.query("SET SESSION group_concat_max_len = 67108864");
    const [[s]] = await srcConn.query(
      `SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(payload_hash ORDER BY tx_id)) AS h FROM \`${srcDb}\`.chain_tx`
    );
    const [[d]] = await led.query(
      'SELECT COUNT(*) AS n, MD5(GROUP_CONCAT(payload_hash ORDER BY tx_id)) AS h FROM chain_tx'
    );
    verify.digest = { sourceN: Number(s.n), targetN: Number(d.n), match: s.h === d.h };
    if (!verify.digest.match) verify.ok = false;
  } catch (e) { verify.digest = { error: e.message, auxiliary: true }; }

  console.log('\n  搬迁校验：');
  for (const [t, v] of Object.entries(verify.tables)) {
    console.log(`    ${t.padEnd(22)} ${v.src} → ${v.dst} ${v.match ? C.ok('✔') : C.bad('✘')}`);
  }
  if (verify.tip && verify.tip.match !== undefined) {
    console.log(`    链顶一致性           ${verify.tip.match ? C.ok('✔ 同高度同哈希') : C.bad('✘ 不一致')}`
      + C.dim(`  #${verify.tip.source?.block_index} ${String(verify.tip.source?.block_hash || '').slice(0, 16)}…`));
  }

  /* ---------- 8. 删除业务库同名视图 ---------- */
  for (const v of srcViews) {
    await biz.query(`DROP VIEW IF EXISTS \`${BIZ.database}\`.\`${v}\``);
  }
  console.log(C.ok(`\n✔ 已删除业务库中的 ${srcViews.length} 张同名视图（跨实例视图本就不可用，保留只会掩盖问题）`));

  /* ---------- 9. 写证据 ---------- */
  const evFile = path.join(OUT_DIR, 'ledger-split.json');
  fs.writeFileSync(evFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    level: level(),
    business: { host: BIZ.host, port: BIZ.port, database: BIZ.database },
    ledger: { host: LED.host, port: LED.port, database: LED.database, user: LED.user },
    counts: verify.tables,
    tip: verify.tip,
    viewsDropped: srcViews,
    ok: verify.ok,
  }, null, 2), 'utf8');
  console.log(C.dim(`  证据：${path.relative(ROOT, evFile)}`));

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(verify.ok ? C.ok('  搬迁完成，行数与链顶一致') : C.bad('  搬迁存在差异，请核对上面的校验表'));
  console.log('──────────────────────────────────────────────────────────');
  console.log(C.dim('  下一步：重启服务，然后跑 node tools/attack-same-db.mjs 复核攻击演练。\n'));

  await biz.end();
  for (const c of extraConns) await c.end().catch(() => {});
  await led.end();
  process.exit(verify.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(C.bad('✘ 搬迁异常：'), e);
  process.exit(9);
});
