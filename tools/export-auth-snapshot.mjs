/**
 * export-auth-snapshot.mjs —— 导出 sys_user 登录快照到 Cloudflare KV
 * ==================================================================================
 * 【解决什么问题】
 * D1 免费层每日 500 万行读取额度会被日常流量耗尽，耗尽后登录查询
 * `SELECT sys_user WHERE username=?` 直接 503 —— 而登录恰恰是最不能挂的功能。
 *
 * 用户表极小（约 120 行），把登录必需列整体存为一个 KV key：
 *   · KV 免费读额度独立于 D1（10 万读/天），一次登录 = 1 次 KV 读
 *   · 登录路径从此对 D1 配额免疫（KV 优先，D1 回退 + 自动回填）
 *
 * 【用法】
 *   node tools/export-auth-snapshot.mjs            # 本地 MySQL → 远端 KV
 *
 * 【何时需要重跑】
 * 本地端注册/改密后（云端注册与改密会自动更新快照，无需重跑）。
 * 快照带 exportedAt 时间戳；KV 缺失或过期且 D1 可用时，登录路径会
 * 自动回源 D1 并重写快照，因此本工具只是"主动刷新"的便捷入口。
 */
'use strict';

import mysql from 'mysql2/promise';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

(async () => {
  const cfg = require('../server/config').db;

  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user,
    password: cfg.password, database: cfg.database,
  });

  const [rows] = await conn.query(
    `SELECT id, username, password, salt, real_name, role, org_id, org_name, status
       FROM sys_user WHERE status = 1`);
  await conn.end();

  const snapshot = {
    exportedAt: new Date().toISOString(),
    count: rows.length,
    /* 登录必需列快照（i=id、st=status 供登录后构造 JWT 与停用判断）。
     * password/salt 本就是防爆破哈希（非明文），放进 KV 不降低安全性。 */
    users: rows.map((r) => ({
      i: Number(r.id),
      u: r.username,
      p: r.password,
      s: r.salt,
      n: r.real_name,
      r: r.role,
      o: r.org_id === null ? null : Number(r.org_id),
      g: r.org_name,
      st: Number(r.status),
    })),
  };

  const json = JSON.stringify(snapshot);
  console.log(`快照：${snapshot.count} 个账号，${(json.length / 1024).toFixed(1)} KB`);

  /* 写远端 KV（wrangler kv key put --remote） */
  const tmp = tmpdir() + '/auth-users-snapshot.json';
  writeFileSync(tmp, json);
  execFileSync('npx', ['wrangler', 'kv', 'key', 'put', 'auth:users', '--path', tmp,
    '--namespace-id', 'd4d054ab7dab4443a7026aa82a14c740', '--remote'],
    { stdio: 'inherit', shell: true });
  console.log('✔ 已写入 KV：auth:users');
})().catch((e) => { console.error('✘ 失败：', e.message); process.exit(1); });
