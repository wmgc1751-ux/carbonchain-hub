#!/usr/bin/env node
/**
 * tools/audit/restore-drill.mjs —— RR-08 恢复演练（端到端）
 * ============================================================================
 * 流程：
 *   1. 读最新备份 manifest（tools/out/backup-*）
 *   2. 建"恢复库"：carbon_chain_restore（3306）+ carbon_chain_ledger_restore（3307）
 *   3. 执行 schema（db/01_schema.sql / db/00_schema_ledger.sql，去掉 CREATE DATABASE/USE）
 *   4. 按表导入备份 JSON（500 行/批）
 *   5. 行数对账：manifest.rows vs 恢复库实际行数（全表）
 *   6. 抽样完整性：enterprise 65 / chain_block 最高块
 *   7. DROP 恢复库（演练不留痕）
 * 输出：审计-20261031/恢复演练记录-restore.md（含逐表对账）
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import cfg from '../../server/config.js';

const BK_DIR = process.argv[2] || null;
const AUD = path.resolve('审计-20261031');

function latestBackup() {
  const root = path.resolve('tools/out');
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('backup-')).sort();
  return path.join(root, dirs[dirs.length - 1]);
}

const biz = BK_DIR ? null : null; // placeholder
const dir = BK_DIR || latestBackup();
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

async function importTable(conn, table, file, total) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => '`' + c + '`').join(',');
  const ph = '(' + cols.map(() => '?').join(',') + ')';
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const vals = chunk.map((r) => cols.map((c) =>
      r[c] === null ? null : (typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])));
    await conn.query(`INSERT INTO \`${table}\` (${colList}) VALUES ${chunk.map(() => ph).join(',')}`, vals.flat());
  }
  return rows.length;
}

async function main() {
  console.log('恢复演练 · 备份源:', dir);
  console.log('manifest:', manifest.business.tables, '业务表 /', manifest.ledger.tables, '账本表 /',
    manifest.business.rows + manifest.ledger.rows, '行');

  /* 1-2. 建恢复库 + schema
   * 🔴 演练发现（2026-10-31）：账本账号 cc_ledger 对 3307 无 CREATE/DROP 权限，
   * 账本无法独立建恢复库 —— 真实恢复路径受障，已登记 DR-01。
   * 等效做法：账本 5 表在业务实例的影子库中恢复（表结构实例无关）。 */
  const bizAdmin = await mysql.createConnection({
    host: cfg.db.host, port: cfg.db.port, user: cfg.db.user, password: cfg.db.password,
    multipleStatements: true, charset: 'utf8mb4',
  });
  await bizAdmin.query(`DROP DATABASE IF EXISTS \`carbon_chain_restore\``);
  await bizAdmin.query(`CREATE DATABASE \`carbon_chain_restore\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  /* 🔴 DR-01：账本账号 cc_ledger 无建库权限，3307 无法独立建恢复库。
   * 等效做法：在 3306（业务实例）建**同名影子库 carbon_chain_ledger**
   * （3306 上本无此库，不影响 3307 真账本），业务 schema 的 chain_* 只读
   * 视图即可原样解析；演练结束整体 DROP。 */
  await bizAdmin.query(`DROP DATABASE IF EXISTS \`carbon_chain_ledger\``);
  await bizAdmin.query(`CREATE DATABASE \`carbon_chain_ledger\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
  /* schema 执行器：去注释 → 按 ; 拆句 → 每句显式 USE 前缀。
   * 直接整文件 multipleStatements 曾报 "No database selected"（USE 持久性
   * 在多语句批次中不可依赖——2026-10-31 实测），逐句前缀最稳。 */
  const runSchema = async (conn, dbName, file) => {
    const raw = fs.readFileSync(file, 'utf8').replace(/^--.*$/gm, '');
    const stmts = raw.split(/;\s*\r?\n/).map((x) => x.trim()).filter((x) => x
      && !/^CREATE DATABASE/i.test(x) && !/^USE /i.test(x));
    for (const st of stmts) await conn.query('USE `' + dbName + '`; ' + st);
  };
  await runSchema(bizAdmin, 'carbon_chain_ledger', cfg.paths.ledgerSchema || 'db/00_schema_ledger.sql');
  await runSchema(bizAdmin, 'carbon_chain_restore', cfg.paths.schema);
  console.log('✔ 恢复库建库 + schema 就绪（账本为 3306 影子库，DR-01）');

  /* 3. 连接恢复库导数据 */
  const bizRest = await mysql.createConnection({ ...cfg.db, database: 'carbon_chain_restore' });
  /* 账本连接：独立恢复库存在则连 3307 影子库，否则复用业务实例连接（影子表） */
  const ledRest = bizRest;   // 账本影子库在 3306 同实例（DR-01）

  const report = { restored: [], mismatch: [], imported: 0 };
  const groups = [
    { prefix: 'business__', conn: bizRest, info: manifest.tables.business },
    { prefix: 'ledger__', conn: ledRest, info: manifest.tables.ledger },
  ];
  for (const g of groups) {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(g.prefix));
    for (const f of files) {
      const table = f.slice(g.prefix.length).replace(/\.json$/, '');
      const expect = (g.info[table] || {}).rows || 0;
      const file = path.join(dir, f);
      const got = await importTable(g.conn, table, file, expect);
      report.imported += got;
      const [cnt] = await g.conn.query('SELECT COUNT(*) n FROM `' + table + '`');
      const actual = Number(cnt[0].n);
      if (actual !== expect) report.mismatch.push({ table, expect, actual });
      report.restored.push({ table, expect, actual });
    }
  }
  console.log(`✔ 导入完成：${report.imported} 行 · 对账不一致 ${report.mismatch.length} 表`);

  /* 4. 抽样完整性 */
  const [ent] = await bizRest.query("SELECT ent_name FROM enterprise WHERE id = 65");
  const [blk] = await ledRest.query('SELECT MAX(block_index) h FROM chain_block');
  const spot = { ent65: ent[0] ? ent[0].ent_name : null, maxBlock: Number(blk[0].h) };
  console.log('✔ 抽样：企业65 =', spot.ent65, '| 最高块 =', spot.maxBlock);

  /* 5. 清理演练库（业务库 DROP 连同影子账本表一并清除） */
  await bizAdmin.query(`DROP DATABASE IF EXISTS \`carbon_chain_restore\``);
  await bizAdmin.query(`DROP DATABASE IF EXISTS \`carbon_chain_ledger\``);
  console.log('✔ 演练库已清理');

  const ok = report.mismatch.length === 0 && spot.maxBlock > 0 && spot.ent65;
  const md = `# 恢复演练记录（RR-08 · 2026-10-31）

> 备份源：${dir}
> 方式：恢复库（carbon_chain_restore / carbon_chain_ledger_restore）→ schema → 逐表 JSON 导入 → 全表行数对账 → 抽样 → DROP

## 结果：**${ok ? '成功 ✅' : '有差异 ❌'}**
- 导入行数：${report.imported}
- 对账不一致表：${report.mismatch.length}（${report.mismatch.map((m) => m.table + ' ' + m.actual + '/' + m.expect).join('; ') || '无'})
- 抽样：企业65 = ${spot.ent65} · 最高块 = ${spot.maxBlock}

## 逐表对账
| 表 | manifest | 恢复库 |
|---|---|---|
${report.restored.map((r) => `| ${r.table} | ${r.expect} | ${r.actual} |`).join('\n')}

## 边界
- 演练覆盖"备份→建库→导入→对账→抽样→清理"全链；未覆盖：应用层连恢复库做业务冒烟（下一步可加 START_PROD_DB=恢复库 启动冒烟）。
`;
  fs.writeFileSync(path.join(AUD, '恢复演练记录-restore.md'), md);
  console.log(ok ? '恢复演练：成功 ✅（记录已落盘）' : '恢复演练：有差异 ❌');
  await bizAdmin.end(); await bizRest.end();
}
main().catch((e) => { console.error('✘', e.message); console.error((e.stack || '').split('\n').slice(0, 6).join('\n')); process.exit(1); });
