/**
 * db.js —— MySQL 连接池 + 便捷查询封装
 */
'use strict';

const mysql = require('mysql2/promise');
const config = require('./config');

/**
 * 建池工厂。除个别参数外一律沿用 config.db。
 * @param {number} connectionLimit 连接数上限
 */
function makePool(connectionLimit) {
  return mysql.createPool({
    ...config.db,
    connectionLimit,
    multipleStatements: false,
  });
}

/** 业务连接池（平台所有业务查询都走这里） */
const pool = makePool(config.db.connectionLimit || 10);

/**
 * ⭐ 链内核专用连接池 —— 为什么必须和业务池分开
 * ------------------------------------------------------------------
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
 */
const chainPool = makePool(Number(process.env.CHAIN_DB_POOL || 3));

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

module.exports = { pool, chainPool, query, one, value, tx, paginate };
