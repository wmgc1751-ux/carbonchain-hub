/**
 * config.js —— 全局配置
 * 全部支持环境变量覆盖，便于本地运行与云端部署共用一套代码。
 */
'use strict';

const path = require('path');

/**
 * 零依赖 .env 加载器（必须在读取任何 process.env 之前执行）。
 * 为什么不用 dotenv：少一个依赖面，且只需要「KEY=VALUE + 注释」这一小撮语法。
 * 规则：
 *   · 只在变量**尚未存在**时注入（真实环境变量 > .env 文件，云平台面板可覆盖）；
 *   · 行内 # 后视为注释、去首尾空白、去成对引号；
 *   · 文件不存在/不可读一律静默跳过（.env 是本地便利设施，不是必需品）。
 */
(function loadDotEnv() {
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8');
    for (const lineRaw of raw.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([\w.]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        v = v.slice(1, -1);
      }
      v = v.replace(/\s+#.*$/, '').trim();   // 行内注释
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch (e) { /* 无 .env 或不可读：按纯环境变量运行 */ }
})();

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

/* 托管云平台探测：Render / Heroku / Fly / Vercel / Railway / Cloud Run 等
 * 会自动注入下列环境变量之一。用它判定"运行在线上"，比依赖使用者记得设置
 * NODE_ENV=production 更可靠 —— 安全默认值（关闭演示账号接口、收紧跨域）
 * 据此生效，避免出现"忘了设环境变量 = 线上裸奔"。 */
const IS_CLOUD = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL
  || process.env.RENDER_SERVICE_ID || process.env.DYNO
  || process.env.FLY_APP_NAME || process.env.VERCEL
  || process.env.RAILWAY_ENVIRONMENT || process.env.K_SERVICE);

/** 生产语义：显式声明 production，或运行在托管云平台上 */
const IS_PROD = process.env.NODE_ENV === 'production' || IS_CLOUD;

module.exports = {
  /* ---- 运行环境 ---- */
  isCloud: IS_CLOUD,
  isProd: IS_PROD,
  /* 演示账号接口开关（安全默认：线上关闭）。
   * 显式 DEMO_ACCOUNTS=true / false 优先；未设置时，只有非生产环境开放。
   * 该接口会明文返回演示口令，因此绝不能在公网环境默认开放。 */
  demoAccounts: process.env.DEMO_ACCOUNTS === 'true'
    || (process.env.DEMO_ACCOUNTS === undefined && !IS_PROD),

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

  /* ---- 联盟链账本库（与业务库物理分离） ----
   * ------------------------------------------------------------------
   * 为什么单独一个库而不是同库不同表：
   *   同库时，一个拥有业务表写权限的账号，一条 UPDATE 就能同时改掉
   *   「链下明文」与「链上锚点」，五道校验没有一道会报警 —— 这正是
   *   评审指出的「信任模型硬伤」。独立成库后，业务账号对该库没有写权限，
   *   「一条 UPDATE 同改」在权限层即失败；即便 DBA 越权同改，仍要面对
   *   payload_hash → merkle_root → block_hash → 出块签名 的逐层失配。
   *
   * 三个字段都可单独覆盖，便于：
   *   · 本地 MySQL：同实例、两个 schema（默认）
   *   · 生产环境：账本库放到另一台实例/另一套账号（LEDGER_DB_HOST/USER）
   *   · 云托管单库（TiDB Serverless 只给一个库）：把 LEDGER_DB_NAME 设成
   *     与 DB_NAME 相同即自动退化为同库模式，代码无需改动。
   */
  ledgerDb: {
    host: process.env.LEDGER_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.LEDGER_DB_PORT || process.env.DB_PORT, 3306),
    user: process.env.LEDGER_DB_USER || process.env.DB_USER || 'root',
    password: process.env.LEDGER_DB_PASSWORD || process.env.DB_PASSWORD || '123456',
    database: process.env.LEDGER_DB_NAME || 'carbon_chain_ledger',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 7,
    timezone: 'Z',
    dateStrings: ['DATE', 'DATETIME'],
    ssl: dbSsl(),
  },

  /* ---- 认证 ---- */
  jwt: {
    secret: process.env.JWT_SECRET || 'carbonchain-hub-secret-2026-change-me',
    expiresIn: 8 * 3600, // 秒
  },

  /* ---- 区块链 ---- */
  chain: {
    consensusMode: String(process.env.CHAIN_CONSENSUS || 'POA').toUpperCase(), // POA 联盟链授权出块 / POW 历史兼容
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
    /* MRV 生产层结构（活动数据台账 / 核算批次 / 结算 / 清缴 / 注销 / CBAM 证书 / 绿证）
     * —— 只增不改 01_schema.sql，保证既有表结构与历史数据向后兼容。 */
    mrvSchema: path.resolve(__dirname, '..', 'db', '04_schema_mrv.sql'),
    /* 真实数据层（真实设施台账 / 年度真实排放 / 真实序列 / 实时归档 / 真实性声明）
     * —— 与业务表**物理分离**，避免真实源数据与合成业务数据互相污染。 */
    realSchema: path.resolve(__dirname, '..', 'db', '05_schema_real.sql'),
    /* 账本库（链上 5 表）单独一份 DDL；业务库 schema 只保留指向它的只读视图 */
    ledgerSchema: path.resolve(__dirname, '..', 'db', '00_schema_ledger.sql'),
    keystore: path.resolve(__dirname, 'keystore.json'),
  },

  /* ---- 业务参数 ---- */
  biz: {
    quotaPrice: 68.5,       // 碳配额基准价(元/吨)
    defaultQuotaYear: 2026,
  },
};
