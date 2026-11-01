/**
 * worker/lib/db.mjs —— D1 数据访问层
 * ==================================================================================
 * 【为什么需要这一层，而不是直接写 DB.prepare().all()】
 *
 * 现有 400+ 处查询是按 **mysql2 的 API** 写的：
 *     const [rows] = await pool.query(sql, params)   →  rows
 *     await db.one(sql, params)                      →  单行
 *     await db.value(sql, params)                    →  单值
 *     await db.tx(async (conn) => { ... })           →  事务
 *
 * 平台同时存在 MySQL（本地开发/证据包）与 D1（线上）两个运行时。
 * 如果为 D1 重写一遍业务代码，两份实现必然漂移 —— 而且漂移不报错，
 * 只会在某天线上某个页面突然少一个字段。
 *
 * 因此策略是：**保留 mysql2 风格的调用签名**，在 D1 上实现同名函数。
 * 业务代码（services/*、routes/*）在两边用同一份，只换底层 db 实现。
 *
 * 【D1 与 MySQL 的三处语义差异，必须在这一层吸收】
 *
 *   ① 占位符：mysql2 用 `?`，D1 用 `?1 ?2 ...` 或位置数组。
 *      D1 的 `bind(...args)` 接受位置参数，因此 `?` 可以直接映射 —— 但
 *      **`??`（标识符转义）不支持**，遇到就抛错，不静默。
 *
 *   ② 返回值：mysql2 返回 `[rows, fields]`，D1 返回 `{results, success, meta}`。
 *      这里统一成 `rows`，让 `const [rows] = ...` 的解构照旧可用。
 *
 *   ③ 事务：mysql2 用连接对象上的 beginTransaction/commit/rollback；
 *      D1 用 `batch()`（一次提交多条）与 `withSession()`（顺序一致性读）。
 *      D1 **没有**交互式事务，不能 `BEGIN...COMMIT` 跨多次 await。
 *      这是硬限制：凡是"读-判断-写"的原子逻辑，必须改写成单条 SQL
 *      或用 `batch()` 一次提交，否则并发下会出现竞态。
 *      本层提供 `tx()` 接口，但其语义是**批量原子提交**，不是交互式事务 ——
 *      这个差异必须在调用点显式处理，不能假装一样。
 *
 * 【为什么把 rows_read 记账带回来】
 * D1 免费层每天 500 万行读取额度。一次全表 GROUP BY 就能吃掉 10 万行。
 * 本层每次查询后把 `meta.rows_read` 累计到请求上下文，由 /api/ops/d1-usage
 * 暴露出去 —— 让"额度还剩多少"变成可观测指标，而不是等超额才发现。
 *
 * @module worker/lib/db
 */

/* ==================================================================================
 * 一、SQL 方言适配
 * ================================================================================== */

/** 已知需要改写的函数/语法：MySQL → SQLite */
const SQL_REWRITES = [
  /* JSON 函数：D1 有 JSON1 扩展，函数名改为小写 json_* */
  [/\bJSON_EXTRACT\s*\(/gi, 'json_extract('],
  [/\bJSON_UNQUOTE\s*\(/gi, 'json_extract('],   // SQLite 的 json_extract 直接返回去引号的值
  [/\bJSON_LENGTH\s*\(/gi, 'json_array_length('],
  [/\bJSON_OBJECT\s*\(/gi, 'json_object('],
  [/\bJSON_ARRAY\s*\(/gi, 'json_array('],
  [/\bJSON_CONTAINS\s*\(/gi, 'json_contains('],

  /* 空值函数 */
  [/\bIFNULL\s*\(/gi, 'IFNULL('],               // SQLite 同样支持 IFNULL
  [/\bNOW\s*\(\s*\)/gi, "CURRENT_TIMESTAMP"],
  [/\bCURDATE\s*\(\s*\)/gi, "date('now')"],
  [/\bUNIX_TIMESTAMP\s*\(\s*\)/gi, "strftime('%s','now')"],

  /* 日期格式化：MySQL DATE_FORMAT(d,'%Y-%m-%d %H:00')
   * SQLite 等价写法是 strftime('%Y-%m-%d %H:00', d)
   * 这是**参数顺序相反**的改写，不能用简单正则完成，见 rewriteDateFormat()。 */

  /* 排序函数 FIELD(x,'a','b') → CASE WHEN x='a' THEN 0 ... */
  /* 同样需要结构化改写，见 rewriteField()。 */

  /* 类型转换 */
  [/\bCAST\s*\(([^)]+)\s+AS\s+(SIGNED|UNSIGNED)\s*\)/gi, 'CAST($1 AS INTEGER)'],
  [/\bCAST\s*\(([^)]+)\s+AS\s+CHAR\s*\)/gi, 'CAST($1 AS TEXT)'],
];

/** DATE_FORMAT(d, 'fmt') → strftime('fmt', d) */
function rewriteDateFormat(sql) {
  const re = /DATE_FORMAT\s*\(\s*([^,()]+(?:\([^()]*\))?[^,()]*)\s*,\s*'([^']+)'\s*\)/gi;
  return sql.replace(re, (_, expr, fmt) => `strftime('${fmt}', ${expr.trim()})`);
}

/** FIELD(col, 'a','b',...) → CASE col WHEN 'a' THEN 0 WHEN 'b' THEN 1 ... ELSE 999 END */
function rewriteField(sql) {
  const re = /FIELD\s*\(\s*([^,()]+(?:\([^()]*\))?)\s*,([^)]+)\)/gi;
  return sql.replace(re, (_, col, rest) => {
    const vals = rest.split(',').map((v) => v.trim()).filter(Boolean);
    const whens = vals.map((v, i) => `WHEN ${v} THEN ${i}`).join(' ');
    return `CASE ${col.trim()} ${whens} ELSE ${vals.length} END`;
  });
}

/** GROUP_CONCAT(x SEPARATOR ',') → group_concat(x, ',') */
function rewriteGroupConcat(sql) {
  return sql.replace(/GROUP_CONCAT\s*\(([^)]+?)\s+SEPARATOR\s+'([^']*)'\s*\)/gi,
    (_, expr, sep) => `group_concat(${expr.trim()}, '${sep}')`);
}

/**
 * 把 MySQL SQL 转成可在 D1 执行的 SQL。
 * 只做**语法层**改写，不改语义；遇到无法安全改写的情况直接抛错，
 * 绝不静默放过（静默 = 线上少数据却没人知道）。
 */
export function toSqliteSql(sql) {
  let s = String(sql);

  /* `??` 是 mysql2 的标识符占位符，D1 不支持 —— 必须显式拒绝 */
  if (s.includes('??')) {
    throw new Error('[D1] 不支持 `??` 标识符占位符：' + s.slice(0, 120));
  }

  s = rewriteDateFormat(s);
  s = rewriteField(s);
  s = rewriteGroupConcat(s);
  for (const [re, rep] of SQL_REWRITES) s = s.replace(re, rep);

  /* MySQL 允许 `LIMIT ?` / `LIMIT offset, count`；SQLite 只支持 `LIMIT n OFFSET m`。
   * `LIMIT ?, ?` 这种两参形式改写为 `LIMIT ? OFFSET ?`。 */
  s = s.replace(/LIMIT\s+\?\s*,\s*\?/gi, 'LIMIT ? OFFSET ?');

  return s;
}

/* ==================================================================================
 * 二、后端选择（D1 / Turso）
 * ================================================================================== */

import { createClient } from '@libsql/client/web';

/**
 * 按环境变量选择数据库后端（懒创建，缓存到 env 上跨请求复用）。
 *   env.TURSO_URL + env.TURSO_AUTH_TOKEN → Turso（libSQL HTTP 客户端）
 *   否则                                  → D1（wrangler 绑定）
 * createClient 是同步工厂（HTTP 请求本身异步），isolate 存活期内复用
 * 同一 client 可复用其内部连接池。
 */
/* ==================================================================================
 * 二·五、账本库路由（院审意见①的线上形态整改）
 * ==================================================================================
 * 线上原架构：业务数据与链上 5 表同在一个 Turso 库 —— 拿到该库凭据的人，
 * 一条 UPDATE 就能同时改掉链下明文与链上锚点，这正是评审说的「信任模型硬伤」。
 *
 * 整改后：链上 5 表迁到 **独立的 Cloudflare D1 实例**（另一个云厂商、另一套
 * 凭据体系）。业务侧凭据在物理上触达不到账本，跨库 UPDATE 不可能成立。
 *
 * 为什么用 SQL 文本判定而不是给每个调用点加参数：
 *   全仓有 105 处引用 chain_* 表，分散在 8 个文件。逐个改调用点既容易漏，
 *   也会让业务代码感知存储拓扑。在唯一的数据访问层做一次判定，
 *   业务代码零改动，拓扑变化只影响这一个文件。
 *
 * 判定精度：`\bchain_(block|tx|node|node_replica|payload_backup)\b`
 *   —— `chain_tx_id` 这类**列名**不会被误判（`_` 是词字符，`\b` 不成立）。
 */
const LEDGER_TABLE_RE = /\bchain_(block|tx|node|node_replica|payload_backup)\b/i;

/** 该 SQL 是否只操作账本表 */
export function isLedgerSql(sql) {
  return LEDGER_TABLE_RE.test(String(sql || ''));
}

export function selectBackend(env) {
  if (env.TURSO_URL && env.TURSO_AUTH_TOKEN) {
    if (!env.__tursoClient) {
      env.__tursoClient = createClient({
        url: env.TURSO_URL,
        authToken: env.TURSO_AUTH_TOKEN,
      });
    }
    return env.__tursoClient;
  }
  return env.DB;
}

/* ==================================================================================
 * 三、查询执行
 * ================================================================================== */

/**
 * 识别并翻译 D1 的"额度耗尽"错误。
 *
 * 【为什么必须单独识别 —— 这是实际发生了的事，不是预防性设计】
 * D1 超额时返回：
 *   "Your account has exceeded D1's free tier daily row read limit.
 *    Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. [code: 7500]"
 *
 * 若被全局处理器吞成"服务器内部错误，请稍后重试"，会有两个后果：
 *   ① 运维以为是代码 bug，去查日志改代码 —— 而代码完全没问题；
 *   ② 用户只看到"稍后重试"，但真实恢复时间是**次日 UTC 零点**，
 *      "稍后"可能是十几小时。
 *
 * 因此翻译成 503 + 明确提示 + 恢复时刻。
 */
export class D1QuotaError extends Error {
  constructor(message, original) {
    super(message);
    this.name = 'D1QuotaError';
    this.status = 503;
    this.original = original;
    const now = new Date();
    /* 额度在 UTC 零点重置 */
    this.resetsAt = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  }
}

export function isQuotaError(e) {
  const msg = String((e && e.message) || e || '');
  return /exceeded D1's free tier/i.test(msg)
    || /daily row read limit/i.test(msg)
    || /daily row write limit/i.test(msg)
    || /\b7500\b/.test(msg);
}

export function toQuotaIfNeeded(e) {
  if (e instanceof D1QuotaError) return e;
  if (isQuotaError(e)) {
    return new D1QuotaError(
      'D1 每日读写额度已耗尽（免费层：读取 500 万行/天、写入 10 万行/天）。'
      + '这不是代码故障，额度在 UTC 零点重置。',
      e);
  }
  return e;
}

/**
 * 请求级的用量记账（rows_read / queries）。
 * 每次请求新建一个，挂在 ctx 上，由 /api/ops/d1-usage 读出。
 */
export function createUsageMeter() {
  return { queries: 0, rowsRead: 0, rowsWritten: 0, startedAt: Date.now() };
}

/**
 * 选择**账本**后端。
 *   LEDGER_BACKEND=d1 且绑定了 env.LEDGER_DB → 用独立 D1 账本实例（推荐）
 *   否则                                → 返回 null，账本与业务同后端（旧行为）
 *
 * 为什么用开关而不是直接硬切：
 *   D1 免费层每 UTC 日 500 万行读取，账本切换后链查询的读量会落到 D1 上。
 *   额度打光时 D1 直接返回 7500 错误 —— 线上会 503。因此切换必须是
 *   **可回退的一步操作**，而不是改代码重发布。
 */
export function selectLedgerBackend(env) {
  if (String(env.LEDGER_BACKEND || '').toLowerCase() !== 'd1') return null;
  return env.LEDGER_DB || null;
}

/**
 * 建一个 db 句柄。签名与 server/db.js 保持一致：
 *   query / one / value / tx
 *
 * 【双后端】按传入对象的**能力**自动检测（鸭子类型，不认类型名）：
 *   · D1     —— 有 .prepare()（wrangler d1 绑定 env.DB）
 *   · libSQL —— 有 .execute()（Turso，createClient({url, authToken})）
 * 两者的 SQL 方言同为 SQLite，上层的 toSqliteSql 改写对两者通用；
 * 只是执行 API 与返回结构不同，在此分支吸收。
 *
 * 【账本分离】第三参 ledgerBackend 非空时，命中 chain_* 表的语句改走它。
 *
 * @param {D1Database|LibSQLClient} backend  env.DB 或 Turso client
 * @param {object} [meter]  用量记账对象
 * @param {D1Database} [ledgerBackend]  独立账本实例（env.LEDGER_DB）
 */
export function makeDb(backend, meter, ledgerBackend) {
  if (!backend) throw new Error('[db] 后端未绑定 —— 检查 wrangler.json（D1）或 TURSO_URL（Turso）');

  const isTurso = typeof backend.prepare !== 'function' && typeof backend.execute === 'function';

  const track = (meta) => {
    if (!meter || !meta) return;
    meter.queries += 1;
    meter.rowsRead += Number(meta.rows_read || 0);
    meter.rowsWritten += Number(meta.rows_written || 0);
  };

  /* ---------- 执行器工厂：同一个 be 上产出 query/run ---------- */
  function execFor(be) {
    const turso = typeof be.prepare !== 'function' && typeof be.execute === 'function';

    async function d1QueryOn(sql, params) {
      const stmt = be.prepare(toSqliteSql(sql));
      const bound = params && params.length ? stmt.bind(...normalizeParams(params)) : stmt;
      const res = await bound.all();
      track(res.meta);
      return res.results || [];
    }
    async function d1RunOn(sql, params) {
      const stmt = be.prepare(toSqliteSql(sql));
      const bound = params && params.length ? stmt.bind(...normalizeParams(params)) : stmt;
      const res = await bound.run();
      track(res.meta);
      return { changes: Number(res.meta && res.meta.changes || 0), lastRowId: res.meta && res.meta.last_row_id };
    }

    /* libSQL（Turso）后端
     * execute({sql, args}) 返回 { columns, rows, rowsAffected, lastInsertRowid }：
     * rows 是**按列序的数组**，需要与 columns zip 成对象 —— 这层 zip 后
     * 上层业务代码拿到的结构与 D1 完全一致。
     * libSQL 原生支持交互式事务（BEGIN/COMMIT），比 D1 的 batch 语义更强，
     * 但为保持两端行为一致，tx() 仍实现为批量原子提交。 */
    async function libsqlOn(sql, params, mode) {
      const res = await be.execute({ sql: toSqliteSql(sql), args: normalizeParams(params) });
      meter && (meter.queries += 1);
      if (mode === 'write') {
        const changes = Number(res.rowsAffected || 0);
        meter && (meter.rowsWritten += changes);
        const lastId = res.lastInsertRowid != null ? Number(res.lastInsertRowid) : undefined;
        return { changes, lastRowId: lastId };
      }
      meter && (meter.rowsRead += res.rows ? res.rows.length : 0);
      const cols = res.columns || [];
      return (res.rows || []).map((row) => {
        const obj = {};
        for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
        return obj;
      });
    }

    return {
      backend: be,
      isTurso: turso,
      query: turso ? (sql, p) => libsqlOn(sql, p, 'all') : d1QueryOn,
      run: turso ? (sql, p) => libsqlOn(sql, p, 'write') : d1RunOn,
    };
  }

  /* 主执行器 + 账本执行器（未配置时二者相同） */
  const main = execFor(backend);
  const ledger = ledgerBackend ? execFor(ledgerBackend) : null;

  /** 按 SQL 文本选执行器 */
  function pick(sql) {
    return ledger && isLedgerSql(sql) ? ledger : main;
  }

  /** 顶层 query/run：逐条语句判定路由 */
  const query = (sql, params) => pick(sql).query(sql, params);
  const run = (sql, params) => pick(sql).run(sql, params);

  async function one(sql, params = []) {
    const rows = await query(sql, params);
    return rows.length ? rows[0] : null;
  }

  async function value(sql, params = []) {
    const row = await one(sql, params);
    if (!row) return null;
    const vals = Object.values(row);
    return vals.length ? vals[0] : null;
  }

  /**
   * 批量原子提交。
   * D1：batch() 一次提交；Turso：client.batch(stmts, 'write') 同样原子。
   * ⚠ 语义仍是"批量原子提交"而非交互式事务（见上版注释）。
   */
  async function tx(ops) {
    if (!Array.isArray(ops) || !ops.length) return [];
    /* 账本路由：事务必须整体落在同一个实例上。
     * 跨库没有原子性 —— 混合提交会一半成功一半失败，且失败后无法回滚，
     * 因此这里显式拒绝，不静默降级成"两次独立提交"。 */
    const ledgerOps = ops.filter((o) => isLedgerSql(o.sql)).length;
    if (ledger && ledgerOps > 0 && ledgerOps < ops.length) {
      throw new Error('[db] 事务内混用账本表与业务表：账本在独立实例上，无跨库事务。请拆成两次调用。');
    }
    const target = (ledger && ledgerOps === ops.length) ? ledger : main;
    const be = target.backend;
    if (target.isTurso) {
      const stmts = ops.map((o) => ({
        sql: toSqliteSql(o.sql),
        args: normalizeParams(o.params || []),
      }));
      const results = await be.batch(stmts, 'write');
      meter && (meter.queries += 1);
      let written = 0;
      for (const r of results) written += Number(r && r.rowsAffected || 0);
      meter && (meter.rowsWritten += written);
      return results;
    }
    const stmts = ops.map((o) => {
      const s = toSqliteSql(o.sql);
      const p = o.params || [];
      return p.length ? be.prepare(s).bind(...normalizeParams(p)) : be.prepare(s);
    });
    const results = await be.batch(stmts);
    results.forEach((r) => track(r && r.meta));
    return results;
  }

  return {
    query, one, value, run, tx,
    raw: backend,
    backend: isTurso ? 'turso' : 'd1',
    /* 账本分离状态：供 /api/chain/trust-model 如实报告，不靠文案 */
    ledgerRaw: ledger ? ledger.backend : null,
    ledgerBackend: ledger ? (ledger.isTurso ? 'turso' : 'd1') : null,
    ledgerSplit: !!ledger,
  };
}

/**
 * D1 的 bind 只接受 string / number / null / ArrayBuffer。
 * undefined 与 boolean 会直接抛错（不是静默转换），因此在此显式归一化。
 * ⚠ 这是 D1 与 mysql2 的第三处差异：mysql2 会把 undefined 当 NULL，
 * 而 D1 报 `TypeError: Invalid prop`。
 */
function normalizeParams(params) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
    if (v !== null && typeof v === 'object' && !(v instanceof ArrayBuffer)) {
      /* 对象/数组按 JSON 存 —— 与 MySQL 的 JSON 列写入行为对齐 */
      return JSON.stringify(v);
    }
    return v;
  });
}

/* ==================================================================================
 * 三、分页辅助（与原 db.paginate 同签名）
 * ================================================================================== */

export function makePaginate(db) {
  return async function paginate(baseSql, params = [], page = 1, size = 20) {
    const p = Math.max(1, Number(page) || 1);
    const n = Math.min(Math.max(1, Number(size) || 20), 200);
    const offset = (p - 1) * n;

    /* 总数：把原查询包成子查询计数。D1 对 COUNT 的 rows_read 仍按扫描行数计，
     * 因此大表上的 COUNT 要注意额度；预聚合表就是为了避免走到这里。 */
    const countSql = `SELECT COUNT(*) AS c FROM (${baseSql}) AS _cnt`;
    const total = Number(await db.value(countSql, params) || 0);

    const rows = await db.query(`${baseSql} LIMIT ? OFFSET ?`, [...params, n, offset]);
    return {
      items: rows,
      total,
      page: p,
      size: n,
      pages: Math.max(1, Math.ceil(total / n)),
    };
  };
}
