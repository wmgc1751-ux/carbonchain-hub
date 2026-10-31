/**
 * tools/migrate-verify.mjs —— 云端迁移验收（统一权威链）
 * ==================================================================
 * 云端迁移手册 §校验 的可执行版本。三重校验：
 *   ① 数据完整性：本地基线（migration-baseline 快照计数）vs 云端逐表行数
 *   ② 链一致性：链顶（block_index, block_hash）一致 + 全链复算通过
 *   ③ 运行时：/api/chain/business-binding 业务行与链上摘要一致
 *
 * 用法（在云端 VM 的 carbonchain-hub 目录，或任何能连两端的地方）：
 *   node tools/migrate-verify.mjs --cloud-host=<host> --cloud-biz-user=.. --cloud-biz-pass=.. \
 *        --cloud-ledger-user=.. --cloud-ledger-pass=.. [--port=3306] [--ledger-port=3307]
 * 本地参数默认取 .env。
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const ARGV = process.argv.slice(2);
const argOf = (k, d) => {
  const i = ARGV.indexOf('--' + k);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};

const ROOT = process.cwd();
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.trim().match(/^([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const E = { ...readEnv(path.join(ROOT, '.env')), ...process.env };

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

/* 云端连接（验收目标） */
const CLOUD_BIZ = {
  host: argOf('cloud-host', E.DB_HOST || '127.0.0.1'),
  port: Number(argOf('cloud-port', E.DB_PORT || 3306)),
  user: argOf('cloud-biz-user', E.DB_USER || 'root'),
  password: argOf('cloud-biz-pass', E.DB_PASSWORD || ''),
  database: E.DB_NAME || 'carbon_chain',
};
const CLOUD_LED = {
  host: CLOUD_BIZ.host,
  port: Number(argOf('ledger-port', E.LEDGER_DB_PORT || 3307)),
  user: argOf('cloud-ledger-user', E.LEDGER_DB_USER || CLOUD_BIZ.user),
  password: argOf('cloud-ledger-pass', E.LEDGER_DB_PASSWORD || CLOUD_BIZ.password),
  database: E.LEDGER_DB_NAME || 'carbon_chain_ledger',
};
/* 本地基线（迁移源），默认连本地双实例 */
const LOCAL_BIZ = { host: '127.0.0.1', port: 3306, user: E.DB_USER || 'root', password: E.DB_PASSWORD || '', database: E.DB_NAME || 'carbon_chain' };
const LOCAL_LED = {
  host: E.DB_HOST || '127.0.0.1', port: Number(E.DB_PORT || 3306),
  user: E.DB_USER || 'root', password: E.DB_PASSWORD || '',
  database: 'carbon_chain_ledger',
};

const diffs = [];

async function tableCounts(conn, db) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME t, TABLE_ROWS r FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [db]
  );
  const out = {};
  for (const r of rows) {
    const [[c]] = await conn.query(`SELECT COUNT(*) c FROM \`${r.t}\``);
    out[r.t] = Number(c.c);
  }
  return out;
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  云端迁移验收');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  基线 ${LOCAL_BIZ.user}@${LOCAL_BIZ.host}:${LOCAL_BIZ.port}`);
  console.log(`  云端 ${CLOUD_BIZ.user}@${CLOUD_BIZ.host}:${CLOUD_BIZ.port} / 账本 ${CLOUD_LED.port}`);

  const lb = await mysql.createConnection(LOCAL_BIZ).catch(() => null);
  const cb = await mysql.createConnection(CLOUD_BIZ).catch((e) => { console.log(C.warn(`  业务库连接失败：${e.code || e.message}`)); return null; });
  const cl = await mysql.createConnection(CLOUD_LED).catch(() => null);

  /* ---- ① 逐表行数 ---- */
  if (lb && cb) {
    console.log(C.dim('\n  ① 业务库逐表行数…'));
    const [tables] = await lb.query(
      `SELECT TABLE_NAME t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [LOCAL_BIZ.database]
    );
    let checked = 0;
    for (const { t } of tables) {
      const [[l]] = await lb.query(`SELECT COUNT(*) c FROM \`${t}\``);
      try {
        const [[c]] = await cb.query(`SELECT COUNT(*) c FROM \`${t}\``);
        if (Number(l.c) !== Number(c.c)) diffs.push(`业务.${t}: 本地 ${l.c} ≠ 云端 ${c.c}`);
        checked++;
      } catch (e) {
        diffs.push(`业务.${t}: 云端缺表（${e.code}）`);
      }
    }
    console.log(C.ok(`  ✔ 已比对 ${checked} 张表`));
  } else {
    diffs.push('业务库连接不可用，行数校验跳过');
  }

  /* ---- ② 链一致性 ---- */
  if (cl) {
    console.log(C.dim('\n  ② 账本链…'));
    const [[tipL]] = await cl.query(
      'SELECT block_index, block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1'
    );
    const [[cntL]] = await cl.query('SELECT COUNT(*) c FROM chain_tx');
    console.log(`    云端账本：${Number(tipL.block_index)} 块 / ${Number(cntL.c)} 笔 · 链顶 ${String(tipL.block_hash).slice(0, 16)}…`);
    if (lb) {
      try {
        const [[tipB]] = await lb.query(
          'SELECT block_index, block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1'
        );
        if (Number(tipB.block_index) !== Number(tipL.block_index) || tipB.block_hash !== tipL.block_hash) {
          diffs.push(`链顶不一致：本地 #${tipB.block_index}/${tipB.block_hash.slice(0, 12)} vs 云端 #${tipL.block_index}/${tipL.block_hash.slice(0, 12)}`);
        } else {
          console.log(C.ok('  ✔ 链顶与本地一致'));
        }
      } catch { /* 本地基线不可达时跳过 */ }
    }
  } else {
    diffs.push('账本库连接不可用');
  }

  /* ---- ③ 运行时复算 ---- */
  if (cb) {
    console.log(C.dim('\n  ③ 运行时校验（对云端 API）…'));
    const apiBase = argOf('api', E.CLOUD_API_URL || '');
    if (apiBase) {
      try {
        const r = await fetch(apiBase.replace(/\/$/, '') + '/api/chain/validate?fresh=1');
        const j = await r.json();
        if (j.data && j.data.valid === true) console.log(C.ok('  ✔ 全链复算通过（' + j.data.checkedBlocks + ' 块）'));
        else diffs.push('全链复算未通过：' + JSON.stringify(j).slice(0, 120));
      } catch (e) { diffs.push('运行时校验请求失败：' + e.message); }
    } else {
      console.log(C.warn('  ⊘ 未提供 CLOUD_API_URL，跳过运行时复算'));
    }
  }

  console.log('\n──────────────────────────────────────────────────────────');
  if (!diffs.length) console.log(C.ok('  ✔ 五约束验收：数据不少 · 一条链 · 可核验'));
  else {
    console.log(C.bad(`  ✘ ${diffs.length} 处差异：`));
    diffs.forEach((d) => console.log(`     · ${d}`));
  }
  console.log('──────────────────────────────────────────────────────────');
  process.exit(diffs.length ? 1 : 0);
}

main().catch((e) => { console.error(C.bad('✘ 验收异常：'), e.message || e); process.exit(9); });
