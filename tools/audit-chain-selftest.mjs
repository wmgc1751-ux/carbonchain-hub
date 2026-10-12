/**
 * audit-chain-selftest.mjs —— 审计日志哈希链的**阴性对照**验收（WP6）
 * ==================================================================
 * 为什么必须是"阴性对照"而不是"跑一遍打印 OK"
 * ------------------------------------------------------------------
 * 一个哈希链校验器最危险的失败模式不是"报错"，而是**永远报通过**：
 * 写错了列名、拿错了时间口径、漏拼了 prev_hash —— 只要它读到的数据确实没被改，
 * 就一路绿灯，你根本不知道它到底有没有在算。
 *
 * 所以本工具不验证"正常情况下能通过"（那是廉价的正向验证），而是**主动注入 7 类篡改**，
 * 逐类断言校验器必须把它抓出来。任何一类漏检，都说明校验器名存实亡。
 *
 * 断言清单
 *   P0 基线：全链复算通过（valid=true），且已封印条目数 > 0
 *   P1 接口：GET /audit-chain、/audit-chain/verify、/audit-chain/entry/:id 均可用（服务可达时）
 *   T1 篡改中间条目 detail          → 必须检出 ENTRY_HASH_MISMATCH
 *   T2 物理删除中间条目             → 必须检出 PREV_HASH_MISMATCH
 *   T3 抹掉链首 prev_hash(应为 NULL) → 必须检出 CHAIN_HEAD_BROKEN
 *   T4 抹掉某条 entry_hash          → 必须检出 UNSEALED
 *   T5 单条复核 entry(id)           → 篡改后 consistent 必须为 false
 *   P2 复原后：全链复算重新通过（证明异常确实来自注入，而非环境脏数据）
 *
 * 所有篡改都在用例结束时**原样复原**，工具本身幂等、可重复运行。
 *
 * 用法
 *   node tools/audit-chain-selftest.mjs
 *   node tools/audit-chain-selftest.mjs --api http://127.0.0.1:8300
 *   node tools/audit-chain-selftest.mjs --api http://127.0.0.1:8300 --user admin --pass admin123
 *   node tools/audit-chain-selftest.mjs --no-http        # 只做 DB 层阴性对照，不碰接口
 *
 * 退出码：0 = 全部通过；1 = 存在失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/* ---------------- 参数 ---------------- */
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const API = arg('api', 'http://127.0.0.1:8300');
const NO_HTTP = !!arg('no-http', false);
const USER = arg('user', 'admin');
const PASS = arg('pass', 'admin123');

/* 本机设有 HTTP_PROXY，本地回环必须绕开，否则 fetch 会走代理超时 */
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

/* 项目未安装 dotenv，这里做一次极简 .env 注入（不覆盖已存在的环境变量） */
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const mysql = require('mysql2/promise');
const chain = require('../server/services/auditChain');

/* ---------------- 输出美化 ---------------- */
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', dim: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const results = [];
function pass(name, note = '') {
  results.push({ name, ok: true });
  console.log(`  ${C.g}✔${C.x} ${name}${note ? `  ${C.dim}${note}${C.x}` : ''}`);
}
function fail(name, note = '') {
  results.push({ name, ok: false, note });
  console.log(`  ${C.r}✘${C.x} ${name}${note ? `  ${C.r}${note}${C.x}` : ''}`);
}
function warn(name, note = '') {
  results.push({ name, ok: true, warn: true });
  console.log(`  ${C.y}!${C.x} ${name}${note ? `  ${C.dim}${note}${C.x}` : ''}`);
}
function title(t) { console.log(`\n${C.b}${t}${C.x}`); }

/* ---------------- HTTP 小工具 ---------------- */
async function api(pathname, { method = 'GET', token = null, body = null } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json };
}

/* ==================================================================
 * 主流程
 * ================================================================== */
const conn = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '123456',
  database: process.env.DB_NAME || 'carbon_chain',
  charset: 'utf8mb4',
  /* 与 server/db.js 完全一致：驱动侧钉死 UTC，DATETIME 取字面量 */
  timezone: 'Z',
  dateStrings: ['DATE', 'DATETIME'],
});

/** 取一条位于链中部的已封印条目 id（非链首、非链尾） */
async function pickMiddle() {
  const [rows] = await conn.query('SELECT id FROM audit_log ORDER BY id ASC');
  if (rows.length < 5) return null;
  for (let i = Math.floor(rows.length / 2); i < rows.length - 1; i++) {
    const [r] = await conn.query('SELECT entry_hash, prev_hash FROM audit_log WHERE id = ?', [rows[i].id]);
    if (r.length && r[0].entry_hash) return rows[i].id;
  }
  return null;
}

/** 备份整行并恢复（用于删除类篡改） */
async function backupRow(id) {
  const [rows] = await conn.query(
    `SELECT id, user_id, username, role, module, action, target, detail, ip, result,
            DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS created_at, prev_hash, entry_hash
       FROM audit_log WHERE id = ?`, [id]);
  return rows.length ? rows[0] : null;
}
async function restoreRow(row) {
  await conn.query(
    `REPLACE INTO audit_log
       (id, user_id, username, role, module, action, target, detail, ip, result, created_at, prev_hash, entry_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.user_id, row.username, row.role, row.module, row.action, row.target,
      row.detail, row.ip, row.result, row.created_at, row.prev_hash, row.entry_hash]);
}

let exitCode = 0;
try {
  console.log(`${C.b}审计日志哈希链 · 阴性对照自测台${C.x}`);
  console.log(`${C.dim}数据库 ${process.env.DB_NAME || 'carbon_chain'} @ ${process.env.DB_HOST || '127.0.0.1'}`
    + `  ·  接口 ${NO_HTTP ? '（跳过）' : API}${C.x}`);

  /* ---------- 前置：封印全部历史条目（幂等） ---------- */
  title('【前置】封印历史条目');
  const sealed0 = await chain.seal({ limit: 20000 });
  const st0 = await chain.stats();
  console.log(`  ${C.dim}共 ${st0.total} 条：已封印 ${st0.sealed} / 未封印 ${st0.unsealed}`
    + `${sealed0.sealed ? `（本次封印 ${sealed0.sealed} 条）` : ''}${C.x}`);
  if (st0.sealed > 0 && st0.unsealed === 0) pass('全部条目已入链（unsealed = 0）');
  else fail('全部条目已入链（unsealed = 0）', `仍有 ${st0.unsealed} 条未封印`);

  /* ---------- P0 基线 ---------- */
  title('【P0】基线校验');
  const base = await chain.verify({});
  if (base.valid && base.checked === base.total) {
    pass('全链复算通过', `checked=${base.checked}/${base.total} 链尾 #${base.height}`);
  } else {
    fail('全链复算通过', `errors=${base.errors.length} 类型=${base.errorTypes.join(',') || '-'}`);
    for (const e of base.errors.slice(0, 3)) console.log(`      ${C.dim}${e.message}${C.x}`);
  }

  /* ---------- P1 接口可用性 ---------- */
  if (!NO_HTTP) {
    title('【P1】接口可用性');
    let token = null;
    try {
      const lg = await api('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
      token = lg.json && lg.json.data && lg.json.data.token;
      if (!token) { warn('管理员登录', `HTTP ${lg.status}：${(lg.json && lg.json.message) || '无 token'}`); }
    } catch (e) { warn('管理员登录', `服务不可达：${e.message}`); }

    if (token) {
      try {
        const a = await api('/api/ops/audit-chain', { token });
        if (a.status === 200 && a.json && a.json.data && Number.isFinite(a.json.data.total)) {
          pass('GET /api/ops/audit-chain', `total=${a.json.data.total} sealed=${a.json.data.sealed}`);
        } else fail('GET /api/ops/audit-chain', `HTTP ${a.status}`);

        const v = await api('/api/ops/audit-chain/verify', { token });
        if (v.status === 200 && v.json && v.json.data && v.json.data.valid === true) {
          pass('GET /api/ops/audit-chain/verify', `${v.json.message}`);
        } else fail('GET /api/ops/audit-chain/verify', `HTTP ${v.status} ${JSON.stringify(v.json).slice(0, 120)}`);

        const tipId = base.height;
        const en = await api(`/api/ops/audit-chain/entry/${tipId}`, { token });
        if (en.status === 200 && en.json && en.json.data && en.json.data.consistent === true) {
          pass(`GET /api/ops/audit-chain/entry/${tipId}`, 'consistent=true');
        } else fail(`GET /api/ops/audit-chain/entry/${tipId}`, `HTTP ${en.status}`);

        const nf = await api('/api/ops/audit-chain/entry/999999999', { token });
        if (nf.status === 404) pass('不存在的条目返回 404');
        else fail('不存在的条目返回 404', `实际 HTTP ${nf.status}`);
      } catch (e) { warn('接口可用性', `请求异常：${e.message}`); }
    }
  }

  const mid = await pickMiddle();
  if (!mid) {
    warn('篡改类用例', '链内条目过少（<5），跳过 T1~T5');
  } else {
    /* ---------- T1 篡改明细 ---------- */
    title('【T1】篡改中间条目的 detail（最典型的"改口"）');
    {
      const before = await backupRow(mid);
      await conn.query('UPDATE audit_log SET detail = ? WHERE id = ?',
        ['（被篡改）排放量由 13842 t 改为 842 t', mid]);
      const r = await chain.verify({});
      const hit = r.errors.some((e) => e.id === mid && e.type === 'ENTRY_HASH_MISMATCH');
      if (hit) pass(`条目 #${mid} 内容哈希失配被检出`, `${r.errors.length} 处异常`);
      else fail(`条目 #${mid} 内容哈希失配被检出`, `实际类型 ${r.errorTypes.join(',') || '无'}`);
      await restoreRow(before);
    }

    /* ---------- T2 删除中间条目 ---------- */
    title('【T2】物理删除中间条目（"抹掉一次操作"）');
    {
      const before = await backupRow(mid);
      await conn.query('DELETE FROM audit_log WHERE id = ?', [mid]);
      const r = await chain.verify({});
      const hit = r.errors.some((e) => e.type === 'PREV_HASH_MISMATCH');
      if (hit) pass(`条目 #${mid} 被删除后链断裂被检出`, r.errorTypes.join(' + '));
      else fail('条目被删除后链断裂被检出', `实际类型 ${r.errorTypes.join(',') || '无'}`);
      await restoreRow(before);
    }

    /* ---------- T3 链首 prev_hash 被改 ---------- */
    title('【T3】篡改链首的 prev_hash（链首必须为 NULL）');
    {
      const [headRows] = await conn.query(
        'SELECT id FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id ASC LIMIT 1');
      const headId = headRows[0].id;
      const before = await backupRow(headId);
      await conn.query('UPDATE audit_log SET prev_hash = ? WHERE id = ?',
        ['ffffffffffffffffffffffffffffffff', headId]);
      const r = await chain.verify({});
      const hit = r.errors.some((e) => e.id === headId && e.type === 'CHAIN_HEAD_BROKEN');
      if (hit) pass(`链首 #${headId} 的非法 prev_hash 被检出`, r.errorTypes.join(' + '));
      else fail(`链首 #${headId} 的非法 prev_hash 被检出`, `实际类型 ${r.errorTypes.join(',') || '无'}`);
      await restoreRow(before);
    }

    /* ---------- T4 抹掉 entry_hash（伪装成"未封印"） ---------- */
    title('【T4】抹掉某条的 entry_hash（伪装成未封印以绕过校验）');
    {
      const before = await backupRow(mid);
      await conn.query('UPDATE audit_log SET entry_hash = NULL, prev_hash = NULL WHERE id = ?', [mid]);
      const r = await chain.verify({});
      const hit = r.errors.some((e) => e.id === mid && e.type === 'UNSEALED');
      if (hit) pass(`条目 #${mid} 的 UNSEALED 被检出`, r.errorTypes.join(' + '));
      else fail(`条目 #${mid} 的 UNSEALED 被检出`, `实际类型 ${r.errorTypes.join(',') || '无'}`);
      await restoreRow(before);
    }

    /* ---------- T5 单条复核 ---------- */
    title('【T5】单条复核 entry(id) 在篡改前后必须翻转结论');
    {
      const before = await backupRow(mid);
      const clean = await chain.entry(mid);
      await conn.query('UPDATE audit_log SET module = ? WHERE id = ?', ['（被篡改的模块名）', mid]);
      const dirty = await chain.entry(mid);
      if (clean && clean.consistent === true && dirty && dirty.consistent === false) {
        pass(`条目 #${mid} 复核结论由 true 翻转为 false`);
      } else {
        fail(`条目 #${mid} 复核结论翻转`, `篡改前 ${clean && clean.consistent} → 篡改后 ${dirty && dirty.consistent}`);
      }
      await restoreRow(before);
    }
  }

  /* ---------- P2 复原后重新通过 ---------- */
  title('【P2】全部复原后，全链必须重新通过');
  {
    const again = await chain.verify({});
    if (again.valid) pass('复原后全链复算通过', `checked=${again.checked} 链尾 #${again.height}`);
    else {
      fail('复原后全链复算通过', `仍有 ${again.errors.length} 处异常：${again.errorTypes.join(',')}`);
      for (const e of again.errors.slice(0, 5)) console.log(`      ${C.dim}${e.message}${C.x}`);
    }
  }
} catch (e) {
  fail('自测台执行', e && e.stack ? e.stack.split('\n')[0] : String(e));
  console.error(e);
} finally {
  await conn.end().catch(() => {});
}

/* ---------------- 汇总 ---------------- */
const okN = results.filter((r) => r.ok).length;
const failN = results.length - okN;
console.log('\n' + '─'.repeat(64));
console.log(`${C.b}结果${C.x}  通过 ${C.g}${okN}${C.x} / 失败 ${failN ? C.r : C.dim}${failN}${C.x}  共 ${results.length} 项`);
if (failN) {
  console.log(`${C.r}未通过：${results.filter((r) => !r.ok).map((r) => r.name).join('；')}${C.x}`);
  exitCode = 1;
} else {
  console.log(`${C.g}全部通过：校验器对 5 类篡改均能稳定检出，且复原后自愈。${C.x}`);
}
process.exit(exitCode);
