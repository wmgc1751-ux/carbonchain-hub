/**
 * migrate-iter1.js —— 第 1 轮升级（WP1/WP3/WP6）数据库迁移
 * ------------------------------------------------------------------
 * 为什么需要它：`npm run initdb` 会**重建**整个库（DROP + CREATE），
 * 适用于全新环境；但已在运行的环境不能重建，必须**原地增量升级**。
 * 本脚本对既有库做幂等迁移：重复执行 N 次结果与执行 1 次完全一致。
 *
 * 迁移内容
 *   一、新增三张表（DDL 直接从 db/01_schema.sql 抽取，保持单一事实来源）
 *       · anchor_batch     批量锚定批次          （WP3）
 *       · batch_leaf       批量锚定叶节点        （WP3）
 *       · device_registry  工业现场设备注册      （WP1）
 *   二、既有表增列
 *       · chain_tx       + anchor_batch_no / anchor_status   （WP3）
 *       · cems_reading   + quality_flag / device_did / crc16 / sm3_digest （WP1）
 *       · audit_log      + prev_hash / entry_hash            （WP6）
 *       · carbon_dynamic_account + excluded_points           （WP1 质量门控）
 *   三、既有表补索引（仅功能需要的）
 *
 * 设计原则
 *   1. **不 DROP 任何表、不修改任何既有列的数据**（只增不删）。
 *   2. DDL 从 01_schema.sql 抽取而非硬编码 —— 避免schema 与本脚本漂移。
 *   3. 每一步都有存续性检查，可安全重复执行。
 *
 * 用法：node server/scripts/migrate-iter1.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

/** 本批次新增的表（顺序即依赖顺序） */
const NEW_TABLES = ['anchor_batch', 'batch_leaf', 'device_registry'];

/** 既有表需要补的列：{ table, column, ddl } */
const NEW_COLUMNS = [
  ['chain_tx', 'anchor_batch_no',
    "ALTER TABLE chain_tx ADD COLUMN anchor_batch_no VARCHAR(40) DEFAULT NULL COMMENT '所属批量锚定批次号(NULL 表示尚未被批量锚定)'"],
  ['chain_tx', 'anchor_status',
    "ALTER TABLE chain_tx ADD COLUMN anchor_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT '锚定状态: PENDING 待锚定 / BATCHED 已入批 / ANCHORED 已锚定 / SELF 自身即锚点'"],
  ['cems_reading', 'quality_flag',
    "ALTER TABLE cems_reading ADD COLUMN quality_flag VARCHAR(20) NOT NULL DEFAULT 'NORMAL' COMMENT '时序完整性标记 NORMAL/MISSING/DRIFT/OFFLINE/CALIBRATION/SUBSTITUTED'"],
  ['cems_reading', 'device_did',
    "ALTER TABLE cems_reading ADD COLUMN device_did VARCHAR(80) DEFAULT NULL COMMENT '上报设备 DID'"],
  ['cems_reading', 'crc16',
    "ALTER TABLE cems_reading ADD COLUMN crc16 VARCHAR(8) DEFAULT NULL COMMENT 'HJ 212 报文 CRC-16 校验值(附录A，同 CRC-16/MODBUS)'"],
  ['cems_reading', 'sm3_digest',
    "ALTER TABLE cems_reading ADD COLUMN sm3_digest VARCHAR(80) DEFAULT NULL COMMENT '报文国密 SM3 指纹'"],
  ['audit_log', 'prev_hash',
    "ALTER TABLE audit_log ADD COLUMN prev_hash VARCHAR(80) DEFAULT NULL COMMENT '前一条日志的 entry_hash(NULL 表示链首)'"],
  ['audit_log', 'entry_hash',
    "ALTER TABLE audit_log ADD COLUMN entry_hash VARCHAR(80) DEFAULT NULL COMMENT '本条日志哈希 SHA256(prev_hash|规范序列化内容)'"],
  ['carbon_dynamic_account', 'excluded_points',
    "ALTER TABLE carbon_dynamic_account ADD COLUMN excluded_points INT NOT NULL DEFAULT 0 COMMENT '被质量门控排除的实测点数(quality_flag<>NORMAL，不参与核算)'"],
];

/** 既有表需要补的索引：[表, 索引名, 列定义, 类型?] 类型省略即普通索引，'UNIQUE' 为唯一索引 */
const NEW_INDEXES = [
  ['chain_tx', 'idx_tx_anchor', '(anchor_status, block_index)'],
  ['chain_tx', 'idx_tx_batch', '(anchor_batch_no)'],
  ['cems_reading', 'idx_cems_quality', '(quality_flag)'],
  ['audit_log', 'idx_log_entry_hash', '(entry_hash)'],
  // MN 是 HJ 212 设备唯一标识，必须唯一（NULL 不参与唯一约束，故非 HJ212 设备不受影响）
  ['device_registry', 'uk_dr_mn', '(mn)', 'UNIQUE'],
];

/* ------------------------------------------------------------------ */

async function tableExists(conn, name) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [config.db.database, name]
  );
  return Number(r[0].n) > 0;
}

async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [config.db.database, table, column]
  );
  return Number(r[0].n) > 0;
}

async function indexExists(conn, table, index) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [config.db.database, table, index]
  );
  return Number(r[0].n) > 0;
}

/** 从 01_schema.sql 中抽取指定表的 CREATE TABLE 语句（保持 schema 单一事实来源） */
function extractCreateStatements(sqlFile, tables) {
  const sql = fs.readFileSync(sqlFile, 'utf8').replace(/^\s*--.*$/gm, '');
  const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 2);
  const picked = [];
  for (const name of tables) {
    const re = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${name}\`?\\s*\\(`, 'i');
    const found = stmts.find((s) => re.test(s));
    if (!found) throw new Error(`01_schema.sql 中未找到表 ${name} 的定义`);
    // 统一注入 IF NOT EXISTS，使重复执行安全
    picked.push(found.replace(/^CREATE\s+TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS '));
  }
  return picked;
}

async function main() {
  console.log('▶ 碳链通 CarbonChain Hub —— 第 1 轮升级数据库迁移（增量 · 幂等）');
  console.log('─'.repeat(68));

  const conn = await mysql.createConnection(config.db);
  let changed = 0;

  try {
    /* 一、新增表 */
    console.log('\n[一] 新增表');
    const ddlFile = path.resolve(config.paths.root, 'db', '01_schema.sql');
    const stmts = extractCreateStatements(ddlFile, NEW_TABLES);
    for (let i = 0; i < NEW_TABLES.length; i++) {
      const name = NEW_TABLES[i];
      const existed = await tableExists(conn, name);
      await conn.query(stmts[i]);
      console.log(`  ${existed ? '·' : '+'} ${name.padEnd(22)} ${existed ? '已存在（跳过创建）' : '已创建'}`);
      if (!existed) changed++;
    }

    /* 二、既有表增列 */
    console.log('\n[二] 既有表增列');
    for (const [table, column, ddl] of NEW_COLUMNS) {
      if (!(await tableExists(conn, table))) {
        console.log(`  ! ${table}.${column}  目标表不存在，跳过（请先执行 npm run initdb）`);
        continue;
      }
      const existed = await columnExists(conn, table, column);
      if (existed) {
        console.log(`  · ${(table + '.' + column).padEnd(30)} 已存在（跳过）`);
      } else {
        await conn.query(ddl);
        console.log(`  + ${(table + '.' + column).padEnd(30)} 已添加`);
        changed++;
      }
    }

    /* 三、补索引 */
    console.log('\n[三] 补索引');
    for (const [table, index, cols, kind] of NEW_INDEXES) {
      if (!(await tableExists(conn, table))) continue;
      const existed = await indexExists(conn, table, index);
      if (existed) {
        console.log(`  · ${(table + '.' + index).padEnd(34)} 已存在（跳过）`);
      } else {
        const uniq = kind === 'UNIQUE' ? 'UNIQUE ' : '';
        await conn.query(`ALTER TABLE ${table} ADD ${uniq}INDEX ${index} ${cols}`);
        console.log(`  + ${(table + '.' + index).padEnd(34)} 已添加${uniq ? '（唯一）' : ''}`);
        changed++;
      }
    }

    /* 四、数据回填（仅填充 NULL，不覆盖既有值） */
    console.log('\n[四] 数据回填');
    if (await columnExists(conn, 'chain_tx', 'anchor_status')) {
      // 锚点交易自身不可被再次批量锚定，标记为 SELF
      const [r1] = await conn.query(
        "UPDATE chain_tx SET anchor_status = 'SELF' WHERE tx_type = 'ANCHOR_BATCH' AND anchor_status <> 'SELF'"
      );
      // 其余已确认交易一律为 PENDING（待锚定）
      const [r2] = await conn.query(
        "UPDATE chain_tx SET anchor_status = 'PENDING' WHERE anchor_status IS NULL"
      );
      console.log(`  · chain_tx 锚点交易标 SELF：${r1.affectedRows} 行；回填 PENDING：${r2.affectedRows} 行`);
    }
    if (await columnExists(conn, 'audit_log', 'entry_hash')) {
      const [r3] = await conn.query('SELECT COUNT(*) AS n FROM audit_log WHERE entry_hash IS NULL');
      console.log(`  · audit_log 待封印条目：${Number(r3[0].n)} 行（服务启动时自动封印，也可 POST /api/ops/audit-chain/seal）`);
    }
    if (await columnExists(conn, 'cems_reading', 'quality_flag')) {
      const [r4] = await conn.query(
        "UPDATE cems_reading SET quality_flag = 'NORMAL' WHERE quality_flag IS NULL OR quality_flag = ''"
      );
      console.log(`  · cems_reading 回填 quality_flag=NORMAL：${r4.affectedRows} 行`);
    }

    /* 校验 */
    console.log('\n[校验] 结构落位确认');
    for (const t of NEW_TABLES) {
      const ok = await tableExists(conn, t);
      console.log(`  ${ok ? '✔' : '✘'} 表 ${t}`);
    }
    for (const [table, column] of NEW_COLUMNS) {
      const ok = await columnExists(conn, table, column);
      console.log(`  ${ok ? '✔' : '✘'} 列 ${table}.${column}`);
    }
  } finally {
    await conn.end();
  }

  console.log('\n' + '─'.repeat(68));
  console.log(`✔ 迁移完成：本次实际变更 ${changed} 项（重复执行将显示 0 项）`);
  console.log('  下一步：node server/scripts/migrate-iter1.js 可安全重复执行');
}

main().catch((e) => {
  console.error('\n✘ 迁移失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
