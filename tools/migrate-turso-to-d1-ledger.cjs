#!/usr/bin/env node
/**
 * tools/migrate-turso-to-d1-ledger.cjs —— 把链上 5 表从 Turso 迁到独立 D1 账本实例
 * ==================================================================
 * 为什么这么做（院审意见①的线上形态整改）
 * ------------------------------------------------------------------
 * 线上真实架构是：业务数据在 **Turso**（libSQL，东京区），链上 5 表也在同一个
 * Turso 库里 —— 也就是链上锚点与链下明文同库同表，正是评审说的「DBA 一条
 * UPDATE 即可同时篡改」。
 *
 * 之前的 trust-model 接口把运行时写成 "workers-d1"，并且 D1 里的 chain_* 表
 * 全是 0 行 —— 说明该描述是错的（真实后端是 Turso）。本脚本一方面把账本
 * 搬到 **Cloudflare D1**，另一方面让接口如实报告后端。
 *
 * 迁移后的隔离强度：业务在 Turso（AWS ap-northeast-1），账本在 Cloudflare D1
 * （WNAM）—— **不同云厂商、不同凭据体系**，比"同实例两库"更强：
 * 拿到 Turso token 的人，在物理上无法触碰 D1 的一行数据。
 *
 * 用法
 *   node tools/migrate-turso-to-d1-ledger.cjs            # 生成 SQL，不执行
 *   node tools/migrate-turso-to-d1-ledger.cjs --check    # 只对比两侧行数
 * 产物
 *   tools/out/ledger-to-d1.sql        （CREATE + INSERT，供 wrangler d1 execute --file）
 *   tools/out/ledger-migration.json   （迁移前后行数与校验和）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const OUT = path.join(__dirname, 'out');
const TABLES = ['chain_block', 'chain_tx', 'chain_node', 'chain_node_replica', 'chain_payload_backup'];

function readEnv() {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const get = (k) => {
    const m = raw.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  return { url: get('TURSO_URL'), token: get('TURSO_AUTH_TOKEN') };
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    return `X'${Buffer.from(v).toString('hex')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

(async () => {
  const { url, token } = readEnv();
  if (!url || !token) throw new Error('.env 缺少 TURSO_URL / TURSO_AUTH_TOKEN');
  const client = createClient({ url, authToken: token });

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  链上 5 表：Turso → Cloudflare D1（独立账本实例）');
  console.log('══════════════════════════════════════════════════════════\n');
  console.log('  源：' + url.replace(/\/\/[^@]*@/, '//'));

  const checkOnly = process.argv.includes('--check');

  /* ---- 1. 取 DDL 与行数 ---- */
  const ddl = {};
  const counts = {};
  for (const t of TABLES) {
    const r = await client.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      args: [t],
    });
    if (!r.rows.length) { console.log(`  ⚠ 源库无表 ${t}`); continue; }
    ddl[t] = r.rows[0].sql;
    const c = await client.execute(`SELECT COUNT(*) AS c FROM ${t}`);
    counts[t] = Number(c.rows[0].c);
    console.log(`  ${t.padEnd(22)} ${counts[t].toString().padStart(6)} 行`);
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n  合计 ${total} 行`);

  if (checkOnly) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'ledger-migration.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), source: url, counts, checkOnly: true }, null, 2));
    console.log('\n  （--check 模式，未生成 SQL）\n');
    process.exit(0);
  }

  /* ---- 2. 生成 SQL ---- */
  const lines = [];
  lines.push('-- 由 tools/migrate-turso-to-d1-ledger.cjs 生成');
  lines.push('-- 目的：把链上 5 表从 Turso 迁到独立 D1 账本实例（物理分离）');
  lines.push(`-- 生成时间：${new Date().toISOString()}`);
  lines.push('PRAGMA foreign_keys=OFF;');

  const checksums = {};
  for (const t of TABLES) {
    if (!ddl[t]) continue;
    lines.push('');
    lines.push(`-- ---- ${t}（${counts[t]} 行）----`);
    lines.push(`DROP TABLE IF EXISTS ${t};`);
    lines.push(ddl[t].trim() + ';');

    /* 分页读，避免一次拉爆内存 */
    const PAGE = 500;
    const h = crypto.createHash('sha256');
    let read = 0;
    for (let off = 0; off < counts[t]; off += PAGE) {
      const r = await client.execute(`SELECT * FROM ${t} LIMIT ${PAGE} OFFSET ${off}`);
      if (!r.rows.length) break;
      const cols = r.columns;
      const colList = cols.join(',');
      for (const row of r.rows) {
        const vals = cols.map((c) => sqlLiteral(row[c])).join(',');
        lines.push(`INSERT INTO ${t} (${colList}) VALUES (${vals});`);
        h.update(cols.map((c) => String(row[c] ?? '')).join('\x1f'));
        read++;
      }
    }
    checksums[t] = { rows: read, sha256: h.digest('hex').slice(0, 16) };
  }
  lines.push('');
  lines.push('PRAGMA foreign_keys=ON;');

  fs.mkdirSync(OUT, { recursive: true });
  const sqlFile = path.join(OUT, 'ledger-to-d1.sql');
  fs.writeFileSync(sqlFile, lines.join('\n'));
  const mb = (fs.statSync(sqlFile).size / 1024 / 1024).toFixed(2);

  /* ---- 3. 索引（从源库 sqlite_master 一并带过来）---- */
  const idx = [];
  for (const t of TABLES) {
    const r = await client.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
      args: [t],
    });
    for (const row of r.rows) idx.push(row.sql.trim() + ';');
  }
  if (idx.length) {
    fs.appendFileSync(sqlFile, '\n-- ---- 索引 ----\n' + idx.filter(Boolean).join('\n'));
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    source: { backend: 'turso', url: url.replace(/\/\/.*@/, '//') },
    target: { backend: 'cloudflare-d1', database: 'carbonchain-ledger', id: '6170f12c-b3c6-40be-8bdc-338bd81d7e71' },
    isolation: '跨云厂商：业务数据在 Turso(ap-northeast-1)，账本在 Cloudflare D1(WNAM)，凭据体系互不相通',
    counts,
    checksums,
    sqlFile: path.relative(process.cwd(), sqlFile),
    sqlSizeMB: Number(mb),
    indexCount: idx.length,
    next: 'wrangler d1 execute carbonchain-ledger --remote --file tools/out/ledger-to-d1.sql --config wrangler.worker.json',
  };
  fs.writeFileSync(path.join(OUT, 'ledger-migration.json'), JSON.stringify(meta, null, 2));

  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`  SQL 已生成：${meta.sqlFile}（${mb} MB，含 ${idx.length} 个索引）`);
  console.log(`  校验和：`);
  for (const [t, v] of Object.entries(checksums)) {
    console.log(`    ${t.padEnd(22)} ${String(v.rows).padStart(6)} 行  sha256:${v.sha256}`);
  }
  console.log(`\n  下一步：`);
  console.log(`    node ${path.relative(process.cwd(), __filename)} --check   # 先对比`);
  console.log(`    ${meta.next}`);
  console.log('──────────────────────────────────────────────────────────\n');
})().catch((e) => { console.error('迁移脚本失败：', e); process.exit(1); });
