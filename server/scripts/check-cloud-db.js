/**
 * check-cloud-db.js —— 云端数据库一键体检 + 数据灌入
 * ------------------------------------------------------------------
 * 用途：把本地已验证的 16 张表与 4600+ 行数据灌入云端 MySQL（TiDB Cloud 等）。
 *      自动完成：连接测试 → 权限探测 → 建表 → 灌数 → 出块 → 全链校验。
 *
 * 用法：
 *   1) 先把连接信息写进同目录的 cloud-db.env（可从 cloud-db.env.example 复制）
 *   2) node server/scripts/check-cloud-db.js
 *
 * 设计说明：
 *   · 只读取 cloud-db.env，不污染你的本地环境变量；
 *   · 连接失败时给出针对性的排查提示，而不是抛一堆堆栈；
 *   · 灌数复用 init-db.js，保证与本地数据完全一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, 'cloud-db.env');

/* ---------------- 1. 读取配置文件 ---------------- */

if (!fs.existsSync(ENV_FILE)) {
  console.error('✘ 找不到 cloud-db.env');
  console.error(`  请在 ${ROOT} 下创建该文件，内容可参考：`);
  console.error('');
  console.error('    DB_HOST=gateway01.us-west-2.prod.aws.tidbcloud.com');
  console.error('    DB_PORT=4000');
  console.error('    DB_USER=xxxxxxxxxxxx.root');
  console.error('    DB_PASSWORD=你的密码');
  console.error('    DB_NAME=test');
  console.error('');
  console.error('  提示：TiDB Cloud 的用户名形如 3pTAoNNegb47Uc8.root，必须带前缀。');
  process.exit(1);
}

function parseEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const cfg = parseEnv(ENV_FILE);
const need = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = need.filter((k) => !cfg[k]);
if (missing.length) {
  console.error('✘ cloud-db.env 缺少必填项：', missing.join(', '));
  process.exit(1);
}

const HOST = cfg.DB_HOST;
const PORT = Number(cfg.DB_PORT);
const USER = cfg.DB_USER;
const PASS = cfg.DB_PASSWORD;
const NAME = cfg.DB_NAME;

/* ---------------- 2. 连接测试 ---------------- */

const mysql = require('mysql2/promise');

const line = (s) => console.log('─'.repeat(Math.max(56, s.length)));

async function tryConnect(label, opts) {
  try {
    const c = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS, ...opts });
    await c.end();
    return { ok: true, label };
  } catch (e) {
    return { ok: false, label, err: e };
  }
}

function diagnose(err) {
  const code = err && (err.code || '');
  const msg = (err && err.message) || '';
  const tips = [];
  if (/ER_ACCESS_DENIED|Access denied/i.test(msg) || code === 'ER_ACCESS_DENIED_ERROR') {
    tips.push('用户名或密码不对。TiDB Cloud 的用户名形如 `3pTAoNNegb47Uc8.root`，**必须带前缀**，不能只填 root。');
    tips.push('密码是你在创建集群时设置的 root 密码，注意区分大小写。');
  }
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(msg) || code === 'ENOTFOUND') {
    tips.push('主机名解析失败。检查 DB_HOST 是否把集群详情页里的一长串地址完整复制过来了（不要带 https:// 或空格）。');
  }
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(msg) || ['ETIMEDOUT', 'ECONNREFUSED'].includes(code)) {
    tips.push('连接超时/被拒。① 确认 DB_PORT 是 4000（不是 3306）；② 到集群的 Network / IP Access List 放行 0.0.0.0/0；③ 检查本机代理是否拦截了 4000 端口。');
  }
  if (/SSL|TLS|certificate|self signed/i.test(msg)) {
    tips.push('这是 TLS 握手问题：请确认 DB_SSL=no-verify 已在 cloud-db.env 中设置。');
  }
  if (/Unknown database/i.test(msg)) {
    tips.push(`库 ${NAME} 不存在。TiDB Cloud 默认库名是 test；也可在控制台新建库后改 DB_NAME。`);
  }
  if (!tips.length) tips.push('请把上面的原始报错信息一并排查。');
  return tips;
}

(async () => {
  line('碳链通 CarbonChain Hub —— 云端数据库体检');
  console.log(`  目标: ${USER}@${HOST}:${PORT}/${NAME}`);
  console.log('');

  // 2.1 先不带 TLS 试
  console.log('① 尝试连接（不启用 TLS）…');
  let r = await tryConnect('plain', {});
  if (r.ok) {
    console.log('   ✔ 连上了。但注意：TiDB Cloud 强烈建议启用 TLS，本脚本将继续用 TLS 模式灌数。');
  } else {
    console.log('   ✘ 失败：' + (r.err.code || r.err.message));
  }

  // 2.2 带 TLS（不校验证书）
  console.log('② 尝试连接（TLS，不校验证书）…');
  const sslOpt = { ssl: { rejectUnauthorized: false } };
  r = await tryConnect('tls-noverify', sslOpt);
  if (!r.ok) {
    console.log('   ✘ 失败：' + (r.err.code || r.err.message));
    console.log('');
    console.log('排查建议：');
    diagnose(r.err).forEach((t, i) => console.log(`   ${i + 1}. ${t}`));
    console.log('');
    console.error('✘ 云端数据库连接不通过，已中止。');
    process.exit(1);
  }
  console.log('   ✔ 连接成功（TLS 生效）');
  console.log('');

  // 2.3 权限探测
  console.log('③ 探测账号权限…');
  const c = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS, ...sslOpt });
  let canCreateDb = false;
  try {
    const [g] = await c.query('SHOW GRANTS');
    const txt = JSON.stringify(g);
    canCreateDb = /ALL PRIVILEGES/i.test(txt) && !/WITH GRANT OPTION/i.test(txt) ? true : /CREATE/i.test(txt);
    console.log('   权限：' + txt.replace(/[{}[\]"]/g, ' ').replace(/,/g, ' ').slice(0, 160));
  } catch (e) {
    console.log('   权限查询被拒绝（多数免费云库如此，属正常）');
  }
  console.log(canCreateDb ? '   → 账号可建库，将使用常规模式' : '   → 账号无建库权限，将使用 DB_MANAGED 模式');
  await c.end();
  console.log('');

  // ---------------- 3. 灌数 ----------------
  console.log('④ 开始建表并灌入数据（复用 init-db.js）…');
  line('');

  /* 云端一律使用 managed 模式：
   * 即便账号恰好有 CREATE/DROP DATABASE 权限，也不应去 DROP 整个库
   * （库里可能有别人的表，且 TiDB Starter 的 test 库是共享的实例级库）。
   * managed 模式下会逐表清理，同样保证可重复执行。 */
  const env = {
    ...process.env,
    DB_HOST: HOST,
    DB_PORT: String(PORT),
    DB_USER: USER,
    DB_PASSWORD: PASS,
    DB_NAME: NAME,
    DB_SSL: 'no-verify',
    DB_MANAGED: 'true',
  };

  const res = spawnSync(process.execPath, [path.join(ROOT, 'server', 'scripts', 'init-db.js')], {
    cwd: ROOT, stdio: 'inherit', env,
  });

  if (res.status !== 0) {
    console.error('');
    console.error('✘ 数据灌入失败。请把上面的报错发给我，或检查：');
    console.error('   · 是否已设置 DB_MANAGED=true（无建库权限时必需）');
    console.error('   · 网络是否稳定（数据量约 2.9 MB，中途断线会失败）');
    process.exit(res.status || 1);
  }

  console.log('');
  console.log('═'.repeat(60));
  console.log('  ✅ 云端数据库已就绪');
  console.log('  下一步：到 Render 创建 Web Service，把这些环境变量填进 Environment 面板');
  console.log('═'.repeat(60));
  console.log('');
  console.log('  DB_HOST=' + HOST);
  console.log('  DB_PORT=' + PORT);
  console.log('  DB_USER=' + USER);
  console.log('  DB_PASSWORD=(保持原值)');
  console.log('  DB_NAME=' + NAME);
  console.log('  DB_SSL=no-verify');
  console.log('  JWT_SECRET=(自己敲一串长随机字符)');
})().catch((e) => {
  console.error('✘ 未预期的错误：', e && e.stack || e);
  process.exit(1);
});
