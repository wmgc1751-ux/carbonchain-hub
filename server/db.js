/**
 * db.js —— MySQL 连接池 + 便捷查询封装
 */
'use strict';

const mysql = require('mysql2/promise');
const config = require('./config');

/**
 * 建池工厂。
 * @param {object} cfg 连接配置（config.db 或 config.ledgerDb）
 * @param {number} connectionLimit 连接数上限
 */
function makePool(cfg, connectionLimit) {
  return mysql.createPool({
    ...cfg,
    connectionLimit,
    multipleStatements: false,
  });
}

/** 业务连接池（平台所有业务查询都走这里） */
const pool = makePool(config.db, config.db.connectionLimit || 10);

/**
 * ⭐ 联盟链账本连接池 —— 与业务池分属【不同数据库】
 * ------------------------------------------------------------------
 * （一）为什么要分池（历史原因，仍然成立）
 * `blockchain/chain.js` 为了让 DATETIME 字面量与 `UNIX_TIMESTAMP()` 的口径
 * 在任何服务器时区下（本机 MySQL 的 +08:00、TiDB Cloud 的 +00:00）都恒等，
 * 会在连接上执行 `SET time_zone = '+00:00'`。这个做法本身是对的。
 *
 * 但 `SET` 是**会话级**状态，而连接用完后会带着这个状态回到池子里复用。
 * 于是只要链内核与业务共用同一个池，就会发生一件非常隐蔽的事故：
 *   · 链内核把某些连接改成 UTC；
 *   · 业务代码随后从池里抽到这些连接，`NOW()` 按 UTC 返回；
 *   · 而业务写入的 `reading_time` / `created_at` 是**本地墙上时间**字面量；
 *   · 两者相差 8 小时 —— 所有基于 `NOW()` 的窗口比较（数据获取率 PMA、
 *     离线看门狗判定、接入量趋势聚合）会静默地判错，且**不报任何错误**。
 * 这个 bug 实际发生过：离线看门狗对"4 小时前最后一次上报"的设备判定为"不静默"，
 * 因为 `NOW()` 是 13:57 而 reading_time 是 17:56，前者比后者还早。
 *
 * 结论（工程纪律）：**会修改会话状态的模块，必须独占自己的连接。**
 *
 * （二）为什么还要分库（本轮整改，针对评审「信任模型硬伤」）
 * 分池只解决了会话状态污染，**没有**解决信任问题：库还是同一个，DBA 一条
 * `UPDATE` 即可同时改掉业务明文与链上锚点，五道校验全部通过。
 * 因此把账本 5 表迁到独立数据库 `carbon_chain_ledger`（见 db/00_schema_ledger.sql），
 * 业务库只保留它们的**只读视图**。于是：
 *   · 业务账号对账本库没有 INSERT/UPDATE/DELETE 权限 → 「一条 UPDATE 同改」失败；
 *   · 链内核用本池直连账本库读写实体表 → 功能不受影响；
 *   · 业务侧 SELECT 与 JOIN 走视图 → 查询代码零改动。
 */
const ledgerPool = makePool(config.ledgerDb, config.ledgerDb.connectionLimit || 7);

/**
 * 账本池的每一条连接都必须处于 UTC 会话时区。
 * ------------------------------------------------------------------
 * chain_block.block_time 是「按 UTC 格式化的字面量」，读回来要用
 * UNIX_TIMESTAMP() 反解成 epoch 才能重算区块哈希。而 UNIX_TIMESTAMP()
 * 的解释依赖会话时区 —— 原来链内核只在启动时对**某一条**池连接执行
 * `SET time_zone='+00:00'`，并发升高后新开的连接仍是 SYSTEM(+08)，
 * 同一张表就会算出相差 28800 秒的 epoch：区块列表比 CEMS 慢 8 小时，
 * 更糟的是「现场重算哈希」会与记录值不符，把好块报成坏块。
 * 会话级状态必须对每条连接生效，因此挂到连接的创建事件上。
 * （业务池**不**加：业务写入的是本地墙上时间字面量，改成 UTC 反而错位 ——
 *   见本文件开头「会修改会话状态的模块，必须独占自己的连接」。）
 */
ledgerPool.on('connection', (conn) => {
  /* mysql2 的回调风格连接：队列顺序执行，SET 会先于调用方的第一条 SQL。
   * 个别托管库禁止改会话时区，失败时静默降级（不影响读写，仅时区口径退化）。 */
  conn.query("SET time_zone = '+00:00'", () => {});
});

/** 兼容别名：链内核与 anchor 服务历史代码里用的是 `db.chainPool` */
const chainPool = ledgerPool;

/** 普通查询 */
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** 取单行 */
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** 取单值 */
async function value(sql, params = []) {
  const row = await one(sql, params);
  if (!row) return null;
  return Object.values(row)[0];
}

/** 事务执行 */
async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 账本库普通查询（读链表实体表，或在需要写链表时使用） */
async function ledgerQuery(sql, params = []) {
  const [rows] = await ledgerPool.query(sql, params);
  return rows;
}

/** 账本库事务执行（写链表必须走这里，不能走业务池） */
async function ledgerTx(fn) {
  const conn = await ledgerPool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 账本库取单行 */
async function ledgerOne(sql, params = []) {
  const rows = await ledgerQuery(sql, params);
  return rows.length ? rows[0] : null;
}

/** 账本库取单值 */
async function ledgerValue(sql, params = []) {
  const row = await ledgerOne(sql, params);
  if (!row) return null;
  return Object.values(row)[0];
}

/**
 * 账本库分页查询（与 paginate 同语义，但走账本池）
 * @param {string} baseSql 不含 LIMIT 的 SQL（含 WHERE/ORDER BY）
 * @param {Array} params
 * @param {{page:number,size:number}} page
 */
async function ledgerPaginate(baseSql, params, page = {}) {
  const p = Math.max(Number(page.page) || 1, 1);
  const s = Math.min(Math.max(Number(page.size) || 10, 1), 200);
  const rows = await ledgerQuery(`${baseSql} LIMIT ${s} OFFSET ${(p - 1) * s}`, params);
  const countSql = `SELECT COUNT(*) AS total FROM (${baseSql}) _t`;
  const total = Number(await ledgerValue(countSql, params)) || 0;
  return { rows, total, page: p, size: s, pages: Math.ceil(total / s) || 1 };
}

/**
 * 账本实例与业务实例是否真的不是同一台 —— 用于对外声明「物理分离」时
 * 不做超出证据的表述（同实例分库 ≠ 物理分离，DBA 在同一会话内即可同改）。
 * @returns {{sameInstance:boolean, sameHost:boolean, sameUser:boolean, level:string}}
 */
function separationFacts() {
  const a = config.db;
  const b = config.ledgerDb;
  const sameHost = String(a.host) === String(b.host) && Number(a.port) === Number(b.port);
  const sameUser = String(a.user) === String(b.user);
  return {
    sameInstance: sameHost,
    sameHost,
    sameUser,
    /* L0 同库 / L1 同实例不同库 / L2 不同实例同主机账号 / L3 不同实例不同账号 */
    level: sameHost ? (a.database === b.database ? 'L0' : 'L1')
      : (sameUser ? 'L2' : 'L3'),
  };
}

/**
 * 分页查询辅助：自动拼 LIMIT，并返回总数
 * @param {string} baseSql 不含 LIMIT 的 SQL（含 WHERE/ORDER BY）
 * @param {Array} params
 * @param {{page:number,size:number}} page
 */
async function paginate(baseSql, params, page = {}) {
  const p = Math.max(Number(page.page) || 1, 1);
  const s = Math.min(Math.max(Number(page.size) || 10, 1), 200);
  const rows = await query(`${baseSql} LIMIT ${s} OFFSET ${(p - 1) * s}`, params);
  const countSql = `SELECT COUNT(*) AS total FROM (${baseSql}) _t`;
  const total = Number(await value(countSql, params)) || 0;
  return { rows, total, page: p, size: s, pages: Math.ceil(total / s) || 1 };
}

module.exports = {
  pool, chainPool, ledgerPool,
  query, one, value, tx, paginate,
  ledgerQuery, ledgerTx, ledgerOne, ledgerValue, ledgerPaginate,
  separationFacts,
};
