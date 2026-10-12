/**
 * start-prod.js —— 云托管 / 生产环境的「幂等 + 容错」启动器
 * ------------------------------------------------------------------
 * 为什么需要它：
 *   Render / Railway 等免费 Web Service 闲置一段时间会休眠，收到请求后重新冷启动。
 *   如果简单地把启动命令写成 `npm run initdb && npm start`，那么
 *     ① 每次冷启动都会清库重建 + 重新灌数 + 重建整条链，冷启动耗时可达数分钟；
 *     ② 每次冷启动都会把演示数据重置回初始快照，线上数据无法累积。
 *
 * 这里的做法：
 *   1. 先探测数据库结构是否与当前代码期望一致（看关键表 / 关键列）；
 *   2. 不一致（首次部署、或从旧版升级遗留的旧表）→ 执行一次完整初始化；
 *   3. 一致 → 直接跳过，冷启动只需几秒；
 *   4. 初始化失败**仅告警、不阻塞** HTTP 服务启动 —— 宁可页面能开、接口报业务错，
 *      也不让整站 502（并会在日志里留下明确的排错线索）。
 *
 * 用法： npm start   （package.json 的 start 已指向本文件）
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const config = require('../config');

/* 新版结构标志：PoA 区块头签名字段 + 若干新版才有的业务表。
 * 任一项缺失即判定"结构不是最新版" → 需要初始化。
 * ⚠ 2026-10-12 修复：此前 REQUIRED_TABLES 只列了 6 张旧表，遗漏了本次重构
 *   新增的 emission_factor / factor_version / reconciliation / prediction_record /
 *   trade_order / trade_deal 等表，导致线上冷启动误判"已最新"而跳过建表，
 *   依赖新表的接口（因子库/对账中心）SQL 报错 → 500。现补全关键新表。 */
const REQUIRED_COLUMN = { table: 'chain_block', column: 'consensus' };
const REQUIRED_TABLES = [
  'chain_node',
  'chain_node_replica',
  'cems_reading',
  'carbon_dynamic_account',
  'credit_asset',
  'credit_offset',
  'emission_factor',
  'factor_version',
  'reconciliation',
  'prediction_record',
  'trade_order',
  'trade_deal',
];

/** 探测数据库结构是否为最新版（不抛异常，任何异常都视为"需要初始化"） */
async function schemaIsLatest() {
  let conn;
  try {
    conn = await mysql.createConnection({
      ...config.db,
      database: config.db.database,
      connectTimeout: 15000,
    });

    const [[col]] = await conn.query(
      'SELECT COUNT(*) AS c FROM information_schema.COLUMNS '
      + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [config.db.database, REQUIRED_COLUMN.table, REQUIRED_COLUMN.column]
    );
    if (!Number(col.c)) {
      console.log(`   · 未发现 ${REQUIRED_COLUMN.table}.${REQUIRED_COLUMN.column}（旧版结构）`);
      return false;
    }

    const placeholders = REQUIRED_TABLES.map(() => '?').join(',');
    const [[tbl]] = await conn.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES `
      + `WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
      [config.db.database, ...REQUIRED_TABLES]
    );
    if (Number(tbl.c) < REQUIRED_TABLES.length) {
      console.log(`   · 新版业务表缺失：已存在 ${tbl.c}/${REQUIRED_TABLES.length}`);
      return false;
    }
    return true;
  } catch (e) {
    console.log(`   · 结构探测未成功（${e.code || e.message}），将执行初始化`);
    return false;
  } finally {
    if (conn) { try { await conn.end(); } catch (_) { /* ignore */ } }
  }
}

/** 以子进程方式执行一次完整初始化（进程隔离，避免其内部 pool.end() 影响主进程） */
function runInitDb() {
  const script = path.join(__dirname, 'init-db.js');
  console.log('⏳ 正在初始化数据库（建表 → 灌仿真数据 → 构建 PoA 联盟链 → 动态核算自举）…');
  console.log('   该过程需连接远程数据库并出块，可能需要 1~5 分钟，请耐心等待。');
  const r = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: process.env,
    cwd: path.resolve(__dirname, '..', '..'),
  });
  if (r.error) {
    console.error('⚠ 初始化子进程启动失败：', r.error.message);
    return false;
  }
  return r.status === 0;
}

/**
 * 以子进程方式执行「增量迁移」（幂等建表 + 补空表种子，不清库、不覆盖存量数据）。
 * 用于：代码重构新增表后，线上库缺表但已有存量数据（如链上存证、业务记录）的场景。
 * 全量 initdb 会 DROP 重建所有表导致存量数据丢失，故此处改走增量迁移。
 */
function runMigrate() {
  const script = path.join(__dirname, 'migrate-db.js');
  console.log('⏳ 正在增量迁移数据库（幂等建表 + 补空表种子，不清库）…');
  const r = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: process.env,
    cwd: path.resolve(__dirname, '..', '..'),
  });
  if (r.error) {
    console.error('⚠ 增量迁移子进程启动失败：', r.error.message);
    return false;
  }
  return r.status === 0;
}

async function main() {
  console.log('─'.repeat(64));
  console.log('  碳链通 CarbonChain Hub —— 启动自检');
  console.log(`  运行模式：${config.isCloud ? '云平台' : (config.isProd ? '生产' : '开发')}`);

  /* ── 端口优先级最高 ──
     app.bootstrap() 内部会先 app.listen() 再后台预热；这里同样把数据库结构自检
     挪到 listen 之后异步执行。原因：云平台（Render 等）的健康检查依赖端口尽早
     可用，若在端口之前同步连远程库（跨区可能数分钟），新实例会被判定「启动过慢」，
     结果是部署显示成功、流量却不切换（线上仍是上一版代码）。 */
  console.log('▶ 正在启动 HTTP 服务…');
  const app = require('../app');
  app.bootstrap();

  setImmediate(async () => {
    try {
      const latest = await schemaIsLatest();
      if (latest) {
        console.log('✔ 数据库结构已是最新版，跳过初始化（端口已就绪，初始化不阻塞访问）');
        return;
      }
      console.log('▶ 检测到数据库结构落后，执行增量迁移（后台执行，不阻塞端口、不清库）…');
      const okMigrate = runMigrate();
      if (okMigrate) console.log('✔ 增量迁移完成（已补齐缺失表与种子）');
      else {
        console.error('⚠ 增量迁移未成功完成。服务仍将运行，但部分功能可能不可用；');
        console.error('   请检查上方日志中的具体报错（常见原因：数据库连接失败 / 建表权限不足）。');
      }
    } catch (e) {
      console.error('⚠ 数据库自检异常（不影响服务）：', e && e.message ? e.message : e);
    }
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error('✘ 启动器异常：', e && e.stack ? e.stack : e);
    // 兜底：即便启动器自身出错，也尽量把 HTTP 服务拉起来
    try { require('../app').bootstrap(); } catch (e2) {
      console.error('✘ HTTP 服务启动失败：', e2 && e2.stack ? e2.stack : e2);
      process.exit(1);
    }
  });
}

module.exports = { schemaIsLatest, runInitDb, runMigrate, main };
