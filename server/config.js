/**
 * config.js —— 全局配置
 * 全部支持环境变量覆盖，便于本地运行与云端部署共用一套代码。
 */
'use strict';

const path = require('path');

/**
 * 是否启用 TLS 连接数据库。
 * DB_SSL=true            开启（校验证书，适用于正规云数据库）
 * DB_SSL=require|true    同上
 * DB_SSL=no-verify       开启但不校验证书（部分免费实例不提供 CA，TiDB Cloud Serverless 常见）
 * 未设置 / false         关闭（本地 MySQL 默认）
 */
function dbSsl() {
  const v = String(process.env.DB_SSL || '').toLowerCase();
  if (['no-verify', 'noverify', 'insecure'].includes(v)) return { rejectUnauthorized: false };
  if (['true', '1', 'yes', 'require', 'required'].includes(v)) return { rejectUnauthorized: true };
  return undefined;
}

/**
 * 解析数字型环境变量，带"空字符串/非法值"兜底。
 * 注意：Number('') === 0，直接写 Number(process.env.PORT || 8300) 在
 * 某些平台把变量注入为空串时会导致监听端口 0（随机端口），从而部署失败。
 */
function num(v, fallback) {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? fallback : n;
}

module.exports = {
  /* ---- HTTP 服务 ---- */
  port: num(process.env.PORT, 8300),
  /* 云平台（Render 等）要求监听 0.0.0.0 才能接收外部请求；本地也适用。 */
  host: process.env.HOST || '0.0.0.0',

  /* ---- MySQL ---- */
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456',
    database: process.env.DB_NAME || 'carbon_chain',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    /* 时区固定为 UTC（'Z'），不要用 'local'。
     * 原因：区块哈希的输入包含 timestamp（绝对秒数），任何一次
     * "DATETIME 字面量 ↔ 秒数" 的换算都必须在所有机器上得到同一个答案。
     *   · 驱动侧：timezone='Z' 让驱动不做本地时区换算；
     *   · 服务端侧：chain.js 在每次读写前 `SET time_zone = '+00:00'`，
     *     让 MySQL 与 TiDB 的 UNIX_TIMESTAMP() 都按 UTC 解释 DATETIME。
     * 两者配对后，「本机 MySQL(CST)」与「TiDB Cloud(UTC)」反解出的秒数完全一致，
     * 同一份数据在两端都能通过全链校验。缺任何一半都会导致整条链校验失败。 */
    timezone: 'Z',
    dateStrings: ['DATE', 'DATETIME'],
    /* 云端托管 MySQL（TiDB Cloud / PlanetScale / Aiven 等）强制要求 TLS 加密连接。
     * 本地 MySQL 默认关闭，因此这里用环境变量开关，保持一套代码两处通用。 */
    ssl: dbSsl(),
  },

  /* ---- 认证 ---- */
  jwt: {
    secret: process.env.JWT_SECRET || 'carbonchain-hub-secret-2026-change-me',
    expiresIn: 8 * 3600, // 秒
  },

  /* ---- 区块链 ---- */
  chain: {
    difficulty: Number(process.env.CHAIN_DIFFICULTY || 4),
    autoMine: process.env.CHAIN_AUTOMINE !== 'false',
    batchSize: Number(process.env.CHAIN_BATCH || 1),
    nodeName: process.env.CHAIN_NODE || 'node-carbon-01',
  },

  /* ---- 路径 ---- */
  paths: {
    root: path.resolve(__dirname, '..'),
    public: path.resolve(__dirname, '..', 'public'),
    schema: path.resolve(__dirname, '..', 'db', '01_schema.sql'),
    keystore: path.resolve(__dirname, 'keystore.json'),
  },

  /* ---- 业务参数 ---- */
  biz: {
    quotaPrice: 68.5,       // 碳配额基准价(元/吨)
    defaultQuotaYear: 2026,
  },
};
