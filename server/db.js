/**
 * db.js —— MySQL 连接池 + 便捷查询封装
 */
'use strict';

const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  ...config.db,
  multipleStatements: false,
});

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

module.exports = { pool, query, one, value, tx, paginate };
