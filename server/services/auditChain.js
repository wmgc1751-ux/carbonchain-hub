/**
 * server/services/auditChain.js —— 审计日志哈希链（WP6 工程品质 · 可防篡改）
 * ==================================================================
 * 解决什么问题
 * ------------------------------------------------------------------
 * 系统操作日志原本只是一张普通表：谁能连上数据库，谁就能
 * `UPDATE audit_log SET detail='...' WHERE id=?` 把"谁在什么时候改了配额"
 * 抹掉，而且**事后完全看不出来**。对碳数据平台来说这是硬伤 ——
 * 链上数据再怎么可信，操作链上数据的人如果不留痕，"可信"就是半截的。
 *
 * 本模块把审计日志改造成**哈希链**（与区块链同构的轻量版）：
 *     entry_hash = SHA256(prev_hash + '|' + 规范化序列化(本条内容))
 * 于是改动任意一条，其 entry_hash 变化 → 后一条的 prev_hash 对不上 →
 * 其后所有条目全部失配。想掩盖就得重算整条链，而链顶哈希已对外可见。
 *
 * 与联盟链的分工（说清楚，避免"重复造链"的质疑）
 * ------------------------------------------------------------------
 *   · 联盟链    承载**业务事实**（排放、配额、交易），多方副本、PoA 共识、慢；
 *   · 审计哈希链 承载**操作事实**（谁动了什么），单链、无共识、快。
 * 两者不是重复：联盟链记录"发生了什么业务"，审计链记录"是谁做的、有没有被改口"。
 *
 * ⚠ 时间字段口径（又是时区）
 * ------------------------------------------------------------------
 * 与区块哈希同理：`created_at` 若用 mysql2 的 Date 对象参与哈希，
 * 会随进程时区解释出不同毫秒数，哈希必失配。故本模块一律用
 * `DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s')` 取**字面量**参与哈希，
 * 写入与复算都用同一个字面量，任何时区下恒等。
 *
 * ⚠ 并发
 * ------------------------------------------------------------------
 * 两条日志同时写入会读到同一个链顶，导致分叉。故 append 走
 * ① 进程内串行化（promise 链）② 事务内 `FOR UPDATE` 锁链顶
 * 双保险。本平台是单进程部署，①即已足够；②用于防御未来多进程/多实例。
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');

/** 参与哈希的字段（顺序无关，stableStringify 会排序） */
const HASH_FIELDS = ['id', 'userId', 'username', 'role', 'module', 'action', 'target', 'detail', 'ip', 'result', 'createdAt'];

/** 规范化的取列（created_at 取字面量而非 Date 对象） */
const SELECT_COLS = `id, user_id, username, role, module, action, target, detail, ip, result,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at_s, prev_hash, entry_hash`;

/** 行 → 参与哈希的规范化对象 */
function rowToPayload(r) {
  return {
    id: Number(r.id),
    userId: r.user_id == null ? null : Number(r.user_id),
    username: r.username == null ? null : String(r.username),
    role: r.role == null ? null : String(r.role),
    module: String(r.module),
    action: String(r.action),
    target: r.target == null ? null : String(r.target),
    detail: r.detail == null ? null : String(r.detail),
    ip: r.ip == null ? null : String(r.ip),
    result: String(r.result),
    createdAt: String(r.created_at_s),
  };
}

/**
 * 计算条目哈希。
 * @param {string|null} prevHash
 * @param {object} payload
 * @returns {string} 64 位十六进制小写
 */
function entryHash(prevHash, payload) {
  return cu.sha256(`${prevHash === null || prevHash === undefined ? '' : prevHash}|${cu.stableStringify(payload)}`);
}

/* ---------------- 进程内串行化 ---------------- */
let tail = Promise.resolve();
function serialize(fn) {
  const run = tail.then(fn, fn);
  // 无论成功失败都让链条继续
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 追加一条审计日志并即时入链。
 * 与 `writeLog` 的差别：本函数**返回哈希信息**，且保证写入即封印。
 * @param {object} o { userId, username, role, module, action, target, detail, ip, result }
 * @returns {Promise<object>} { id, prevHash, entryHash }
 */
function append(o = {}) {
  return serialize(async () => db.tx(async (conn) => {
    // 锁住链顶，防止并发分叉
    const [tips] = await conn.query(
      'SELECT entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1 FOR UPDATE'
    );
    const prevHash = tips.length ? tips[0].entry_hash : null;

    const [ins] = await conn.query(
      `INSERT INTO audit_log (user_id, username, role, module, action, target, detail, ip, result, prev_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        o.userId || null, o.username || 'anonymous', o.role || '-',
        o.module || '未知模块', o.action || '未知动作',
        o.target || null, o.detail || null, (o.ip || '').toString().slice(0, 60),
        o.result || 'SUCCESS', prevHash,
      ]
    );
    const id = Number(ins.insertId);

    const [rows] = await conn.query(
      `SELECT ${SELECT_COLS} FROM audit_log WHERE id = ?`, [id]
    );
    const payload = rowToPayload(rows[0]);
    const h = entryHash(prevHash, payload);
    await conn.query('UPDATE audit_log SET entry_hash = ? WHERE id = ?', [h, id]);
    return { id, prevHash, entryHash: h, payload };
  }));
}

/**
 * 批量封印历史未封印条目（entry_hash IS NULL），按 id 升序逐条链接。
 * 幂等：已全部封印时返回 sealed=0。
 * @param {object} o { limit=2000 }
 * @returns {Promise<object>} { sealed, remaining, tipHash }
 */
function seal(o = {}) {
  const limit = Math.min(Math.max(Number(o.limit) || 2000, 1), 20000);
  return serialize(async () => db.tx(async (conn) => {
    const [tips] = await conn.query(
      'SELECT id, entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1 FOR UPDATE'
    );
    let prevHash = tips.length ? tips[0].entry_hash : null;
    const tipId = tips.length ? Number(tips[0].id) : 0;

    const [pending] = await conn.query(
      `SELECT ${SELECT_COLS} FROM audit_log
        WHERE entry_hash IS NULL AND id > ? ORDER BY id ASC LIMIT ?`,
      [tipId, limit]
    );

    let sealed = 0;
    for (const r of pending) {
      const payload = rowToPayload(r);
      const h = entryHash(prevHash, payload);
      await conn.query('UPDATE audit_log SET prev_hash = ?, entry_hash = ? WHERE id = ?', [prevHash, h, r.id]);
      prevHash = h;
      sealed++;
    }

    const [[cnt]] = await conn.query('SELECT COUNT(*) AS n FROM audit_log WHERE entry_hash IS NULL');
    return { sealed, remaining: Number(cnt.n), tipHash: prevHash };
  }));
}

/**
 * 全链复算校验。
 * @param {object} o { sample 仅校验最后 N 条（0/省略=全量） }
 * @returns {Promise<object>}
 */
async function verify(o = {}) {
  const sample = Number(o.sample) || 0;
  let rows;
  if (sample > 0) {
    // 取最后 N 条；仍需拿到其前一条的 entry_hash 作为起点
    // ⚠ db.query 直接返回 rows（不是 [rows, fields]，那是原生 conn.query），切勿再解构一层
    const tailRows = await db.query(
      `SELECT ${SELECT_COLS} FROM audit_log ORDER BY id DESC LIMIT ?`, [sample]
    );
    rows = tailRows.reverse();
  } else {
    rows = await db.query(`SELECT ${SELECT_COLS} FROM audit_log ORDER BY id ASC`);
  }

  const errors = [];
  let checked = 0;
  let unsealed = 0;
  let prevHash = null;
  let firstId = null;

  // 抽样模式下，起点哈希取"前一条"的记录值（无法复算，但可作锚）
  if (sample > 0 && rows.length) {
    const pre = await db.query(
      'SELECT entry_hash FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT 1', [rows[0].id]
    );
    prevHash = pre.length ? pre[0].entry_hash : null;
  }

  for (const r of rows) {
    if (firstId === null) firstId = Number(r.id);
    checked++;
    if (!r.entry_hash) {
      unsealed++;
      errors.push({ id: Number(r.id), type: 'UNSEALED', message: `条目 #${r.id} 尚未封印（entry_hash 为空）` });
      prevHash = null;   // 未封印处即为断点，其后重新起链
      continue;
    }
    const payload = rowToPayload(r);
    const expect = entryHash(prevHash, payload);
    if (expect !== r.entry_hash) {
      errors.push({
        id: Number(r.id), type: 'ENTRY_HASH_MISMATCH',
        message: `条目 #${r.id} 内容哈希与记录不符：期望 ${expect.slice(0, 16)}…，实际 ${String(r.entry_hash).slice(0, 16)}…`,
      });
    }
    if (prevHash !== null && r.prev_hash !== prevHash) {
      errors.push({
        id: Number(r.id), type: 'PREV_HASH_MISMATCH',
        message: `条目 #${r.id} 的 prev_hash 未指向前一条（链断裂）`,
      });
    }
    if (prevHash === null && r.prev_hash !== null && rows.length && Number(r.id) === firstId && sample === 0) {
      errors.push({
        id: Number(r.id), type: 'CHAIN_HEAD_BROKEN',
        message: `链首条目 #${r.id} 的 prev_hash 应为 NULL，实际 ${String(r.prev_hash).slice(0, 16)}…`,
      });
    }
    prevHash = r.entry_hash;
  }

  const lastRow = await db.query(
    `SELECT ${SELECT_COLS} FROM audit_log ORDER BY id DESC LIMIT 1`
  );
  const cnt = await db.one(
    `SELECT COUNT(*) AS total, SUM(entry_hash IS NULL) AS unsealed,
            SUM(entry_hash IS NOT NULL) AS sealed FROM audit_log`
  );

  return {
    valid: errors.length === 0,
    mode: sample > 0 ? `抽样最后 ${sample} 条` : '全链复算',
    checked,
    total: Number(cnt.total), sealed: Number(cnt.sealed), unsealed: Number(cnt.unsealed),
    height: lastRow.length ? Number(lastRow[0].id) : 0,
    tipHash: lastRow.length ? lastRow[0].entry_hash : null,
    headId: firstId,
    errors,
    errorTypes: [...new Set(errors.map((e) => e.type))],
  };
}

/** 链状态概览 */
async function stats() {
  const cnt = await db.one(
    `SELECT COUNT(*) AS total,
            SUM(entry_hash IS NOT NULL) AS sealed,
            SUM(entry_hash IS NULL)     AS unsealed
       FROM audit_log`
  );
  const tip = await db.query(
    `SELECT id, entry_hash, DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS at
       FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1`
  );
  const head = await db.query(
    `SELECT id, entry_hash, DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS at
       FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id ASC LIMIT 1`
  );
  const byModule = await db.query(
    `SELECT module, COUNT(*) AS cnt FROM audit_log GROUP BY module ORDER BY cnt DESC LIMIT 12`
  );
  const n = (v) => Number(v || 0);
  return {
    total: n(cnt.total), sealed: n(cnt.sealed), unsealed: n(cnt.unsealed),
    algorithm: 'SHA-256 哈希链：entry_hash = SHA256(prev_hash | 规范序列化(条目))',
    head: head.length ? { id: Number(head[0].id), hash: head[0].entry_hash, at: head[0].at } : null,
    tip: tip.length ? { id: Number(tip[0].id), hash: tip[0].entry_hash, at: tip[0].at } : null,
    byModule: byModule.map((r) => ({ module: r.module, count: Number(r.cnt) })),
  };
}

/**
 * 单条条目的可核验明细（含前后链接），供人工抽查。
 * @param {number} id
 */
async function entry(id) {
  const r = await db.one(`SELECT ${SELECT_COLS} FROM audit_log WHERE id = ?`, [Number(id)]);
  if (!r) return null;
  const payload = rowToPayload(r);
  const expect = entryHash(r.prev_hash, payload);
  return {
    id: Number(r.id),
    payload,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
    recomputed: expect,
    consistent: expect === r.entry_hash,
    formula: `SHA256('${r.prev_hash || ''}' + '|' + stableStringify(payload))`,
  };
}

module.exports = {
  HASH_FIELDS, entryHash, rowToPayload,
  append, seal, verify, stats, entry,
};
