/**
 * tools/privacy-audit.mjs —— 敏感数据脱敏与响应泄漏审计
 *
 * 补 console-audit / platform-audit / input-fuzz 都没覆盖的一类问题：
 *   **接口正常返回的数据里，有没有不该出现的字段。**
 *
 * 检查项（递归遍历响应 JSON 的每一个键值）：
 *   1. 敏感字段名：password / pwd / salt / secret / private_key / mnemonic / id_card …
 *   2. 未脱敏手机号（11 位，非 138****1234 形态）
 *   3. 未脱敏身份证号（18 位）
 *   4. JWT 形态字符串出现在非 token 字段
 *   5. 堆栈 / SQL 报错 / 文件路径 / 内部表名（mysql2、ER_ 等）
 *   6. 私钥十六进制（64 字节连续 hex 且字段名含 key/priv）
 *
 * 用法：
 *   node tools/privacy-audit.mjs                 # 五角色主接口
 *   node tools/privacy-audit.mjs --verbose       # 打印每个可疑值
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i > -1 ? process.argv[i + 1] : 'http://127.0.0.1:8300';
})();
const VERBOSE = process.argv.includes('--verbose');
const OUT = path.resolve('_ui-check/privacy');
const HOST = new URL(BASE).hostname;
const PORT = Number(new URL(BASE).port) || 8300;

const ACCOUNTS = [
  ['ENTERPRISE', 'ent001', '123456'],
  ['VERIFIER', 'ver001', '123456'],
  ['REGULATOR', 'reg001', '123456'],
  ['TRADER', 'trader01', '123456'],
  ['ADMIN', 'admin', 'admin123'],
];

/* 每个角色要拉的主接口（都是"列表/详情"这类会带出实体的接口）。
 * ⚠ 路径必须与 server/routes/*.js 的实际挂载一致：写错会返回 404，
 *   而 404 在"扫描泄漏"的语境里看起来像"没问题"——这正是最危险的盲区。
 *   下面 404 一律记为问题（见下方探针失效判定），不许静默通过。 */
const ENDPOINTS = {
  ENTERPRISE: ['/api/enterprise/overview', '/api/enterprise/reports?size=20', '/api/enterprise/quota',
    '/api/enterprise/wallet', '/api/credit/status', '/api/mrv/activity?size=20', '/api/chain/blocks?size=10'],
  VERIFIER: ['/api/verifier/tasks?size=20', '/api/verifier/reports?size=20', '/api/public/enterprises?size=20',
    '/api/mrv/quality'],
  REGULATOR: ['/api/regulator/enterprises?size=20', '/api/regulator/system', '/api/regulator/alerts?size=20',
    '/api/regulator/allocations?size=20', '/api/public/enterprises?size=20', '/api/zk/data-truth',
    '/api/real/truth', '/api/consortium/nodes'],
  TRADER: ['/api/trade/market?size=20', '/api/trade/orders?size=20', '/api/trade/account'],
  ADMIN: ['/api/admin/overview', '/api/admin/factors?size=30', '/api/admin/reconciliations?size=20',
    '/api/consortium/nodes'],
};

/* 键名黑名单：出现即说明后端把内部字段直接透出 */
const BAD_KEY = /^(password|passwd|pwd|pass_hash|password_hash|salt|secret|jwt_secret|private_?key|priv_?key|mnemonic|keystore|id_card|idcard|bank_?card|card_no|session_id)$/i;

/* 值特征。
 * ⚠ 三条规则都吃过"太宽松"的教训，实测误报来源写在这里，避免下次又改回去：
 *   · sql 的 /ER_[A-Z_]/ 会命中 PROPOS**ER_**REVOKED_LATER、OV**ER_**QUOTA
 *     ⇒ 必须带 \b（真实的 MySQL 错误码 ER_DUP_ENTRY 前面是引号或行首，仍有边界）
 *   · idcard 不加锚点会命中 18 位的告警编号 AL202610241114071518
 *     ⇒ 只认"整个值就是 18 位"的形态
 *   · phone 同理，只认"整个值就是 11 位手机号"
 */
const RULES = [
  { id: 'phone', name: '未脱敏手机号', re: /^1[3-9]\d{9}$/ },
  { id: 'idcard', name: '未脱敏身份证号', re: /^\d{17}[\dXx]$/ },
  { id: 'jwt', name: 'JWT 形态字符串', re: /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}$/ },
  { id: 'stack', name: '堆栈/路径泄漏', re: /(?:node_modules|[A-Za-z]:\\\\?[\w\u4e00-\u9fa5 ]+\\)|\.js:\d+:\d+| at \w+ \(/ },
  { id: 'sql', name: 'SQL 报错泄漏', re: /\bER_[A-Z][A-Z_]{2,}|You have an error in your SQL syntax|\bmysql2\b|SequelizeError/ },
  { id: 'privhex', name: '疑似私钥十六进制', re: /^(?=.*[0-9a-fA-F])[0-9a-fA-F]{64,128}$/ },
];

function req(method, pathname, { body, token } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: HOST, port: PORT, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, raw: d, json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, raw: '', json: null, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

/** 递归遍历，把命中的键值记下来（带 JSON 路径，方便直接改代码） */
function walk(node, jsonPath, hits, ctx) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.slice(0, 40).forEach((v, i) => walk(v, `${jsonPath}[${i}]`, hits, ctx));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = jsonPath ? `${jsonPath}.${k}` : k;
      if (BAD_KEY.test(k) && v !== null && v !== '' && v !== 0) {
        hits.push({ id: 'bad-key', name: `敏感字段被透出：${k}`, at: p, sample: String(v).slice(0, 20) });
      }
      walk(v, p, hits, ctx);
    }
    return;
  }
  if (typeof node === 'string' && node.length >= 6) {
    for (const r of RULES) {
      if (r.id === 'privhex' && !/key|priv|secret|seed/i.test(jsonPath)) continue;
      /* 登录接口返回的 token 本来就是 JWT，不是泄漏；泄漏指它出现在日志/列表等非授权字段里 */
      if (r.id === 'jwt' && /(^|\.)token$/.test(jsonPath)) continue;
      if (r.re.test(node)) {
        hits.push({ id: r.id, name: r.name, at: jsonPath, sample: node.slice(0, 40) });
        break;    /* 同一个值只记一类问题，避免一条数据刷出五条命中 */
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const results = [];
  let totalHits = 0;

  for (const [role, user, pass] of ACCOUNTS) {
    const login = await req('POST', '/api/auth/login', { body: { username: user, password: pass } });
    const token = login.json?.data?.token;
    if (!token) {
      results.push({ role, path: '/api/auth/login', status: login.status, hits: [{ id: 'login', name: '登录失败，无法继续该角色', at: '', sample: '' }] });
      totalHits++;
      continue;
    }
    /* 登录响应本身也要查：最容易顺手把 password_hash 一起返回 */
    const lh = [];
    walk(login.json, '', lh, role);

    console.log(`\n════ ${role} ════`);
    if (lh.length) {
      console.log(`  ✘ 登录响应命中 ${lh.length} 条`);
      totalHits += lh.length;
    }

    for (const ep of ENDPOINTS[role] || []) {
      const r = await req('GET', ep, { token });
      const hits = [];
      if (r.json) walk(r.json, '', hits, role);
      /* 探针失效保护：404/0 说明路径写错或路由没挂，此时"零命中"毫无意义 */
      if (r.status === 404) hits.push({ id: 'probe-404', name: '探针路径不存在（本接口未被覆盖）', at: '(router)', sample: ep });
      if (r.status === 0) hits.push({ id: 'probe-down', name: '请求失败（未覆盖）', at: '(network)', sample: r.error || '' });
      /* 原始文本兜底：非 JSON 响应也可能带堆栈 */
      for (const rule of RULES) {
        if (['phone', 'idcard', 'jwt', 'privhex'].includes(rule.id)) continue;
        if (!r.json && rule.re.test(r.raw)) hits.push({ id: rule.id, name: rule.name, at: '(原文)', sample: r.raw.slice(0, 60) });
      }
      totalHits += hits.length;
      results.push({ role, path: ep, status: r.status, bytes: r.raw.length, hits });
      const ok = hits.length === 0;
      console.log(`  ${ok ? '✔' : '✘'} ${ep.padEnd(42)} ${r.status}  ${r.raw.length} B${ok ? '' : `  ← ${hits.length} 条`}`);
      if (VERBOSE) hits.slice(0, 6).forEach((h) => console.log(`      · ${h.name}  @${h.at}  ${h.sample}`));
      await sleep(60);
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  const byId = {};
  const badPages = results.filter((r) => r.hits.length);
  for (const r of results) for (const h of r.hits) byId[h.id] = (byId[h.id] || 0) + 1;
  const report = { generatedAt: new Date().toISOString(), base: BASE, totalHits, byId, badPages: badPages.length, results };
  fs.writeFileSync(path.join(OUT, 'privacy-audit.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n════════ 汇总 ════════`);
  console.log(`  接口 ${results.length} 个｜有命中的 ${badPages.length} 个｜命中合计 ${totalHits} 条`);
  if (totalHits) for (const [k, v] of Object.entries(byId)) console.log(`    ${k}: ${v}`);
  else console.log('  未发现敏感字段透出、未脱敏身份信息或内部信息泄漏');
  console.log(`\n报告：${path.join(OUT, 'privacy-audit.json')}`);

  if (totalHits) process.exitCode = 1;
}

main().catch((e) => { console.error('审计异常：' + e.message); process.exit(1); });
