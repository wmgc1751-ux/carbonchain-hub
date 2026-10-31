/* =====================================================================
   input-fuzz.mjs —— 接口极端输入 / 注入 / 信息泄漏测试
   ---------------------------------------------------------------------
   要回答三个问题：
     ① 空值、超长、非法格式、负数、超大数、NaN —— 会不会打崩后端（5xx）？
     ② SQL / XSS / 路径穿越片段 —— 会不会被拼进查询、或原样回显到响应里？
     ③ 出错时返回的是什么 —— 中文可读提示，还是 MySQL 报错与堆栈？

   ⚠ 只发"应当被拒绝"的请求，不构造合法写操作，因此不会污染业务数据。
     少数只读查询用 GET，写接口一律给非法参数（期望 4xx）。

   用法：node tools/input-fuzz.mjs
   ===================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const BASE = argOf('base', 'http://127.0.0.1:8300');
const OUT = path.resolve(ROOT, argOf('out', '_ui-check/fuzz'));
const HOST = new URL(BASE).hostname;
const PORT = Number(new URL(BASE).port) || 8300;

function req(method, pathname, { body, token, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const t0 = Date.now();
    const r = http.request({
      host: HOST, port: PORT, path: pathname, method, timeout,
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
        resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', raw: d, json, ms: Date.now() - t0 });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, ct: '', raw: '', json: null, ms: Date.now() - t0, timeout: true }); });
    r.on('error', (e) => resolve({ status: 0, ct: '', raw: '', json: null, ms: Date.now() - t0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 攻击载荷 ---------- */
const LONG = 'A'.repeat(10000);
const LONG_CN = '碳'.repeat(3000);
const PAYLOADS = {
  sql: "1' OR '1'='1",
  sql2: "'; DROP TABLE enterprise; --",
  xss: '<script>alert(1)</script>',
  xss2: '"><img src=x onerror=alert(1)>',
  traversal: '../../../../etc/passwd',
  nul: 'a\u0000b',
  emoji: '🙂🔥💥',
  negNum: -999999,
  hugeNum: 1e18,
  nan: 'NaN',
  inf: 'Infinity',
  long: LONG,
  longCn: LONG_CN,
  empty: '',
  spaces: '   ',
};

/* 内部信息泄漏特征：命中即说明错误处理不当
 * ⚠ `ER_` 这条必须区分大小写、且后面只许大写/数字/下划线。
 *   原来写成 /ER_[A-Z_]{3,}/i，加了 `/i` 等于 [A-Z_] 也匹配小写字母 ⇒
 *   形如 "other_gas_emissions" 的普通业务字段名被当成 MySQL 错误码
 *   （实测 1 例假警报）。错误码本身永远是全大写，不需要 i。 */
const LEAK = [
  { id: 'stack', re: /\n\s+at\s+[\w$.<>]+\s*\(/ },
  { id: 'mysql', re: /\bER_[A-Z0-9_]{3,}\b/ },
  { id: 'mysql', re: /You have an error in your SQL syntax|mysql2\b|SequelizeError|sqlMessage/i },
  { id: 'sql-text', re: /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[\s\S]{0,80}\b(FROM|WHERE|SET)\b/ },
  { id: 'path', re: /[A-Z]:\\\\|node_modules|\.js:\d+:\d+/ },
  { id: 'echo-script', re: /<script>alert\(1\)<\/script>|<img src=x onerror=/ },
  { id: 'echo-sql', re: /1' OR '1'='1|DROP TABLE/i },
];

/* ---------- 用例表 ---------- */
/* 每条：name / 请求 / 期望（'reject' 表示应被 4xx 拒绝且不崩） */
const CASES = [
  /* --- 认证 --- */
  { g: '认证', name: '登录：空账号密码', m: 'POST', p: '/api/auth/login', b: { username: '', password: '' }, expect: 'reject' },
  { g: '认证', name: '登录：用户名 SQL 注入', m: 'POST', p: '/api/auth/login', b: { username: PAYLOADS.sql, password: PAYLOADS.sql }, expect: 'reject' },
  { g: '认证', name: '登录：超长用户名 10k', m: 'POST', p: '/api/auth/login', b: { username: PAYLOADS.long, password: 'x' }, expect: 'reject' },
  { g: '认证', name: '登录：缺字段', m: 'POST', p: '/api/auth/login', b: {}, expect: 'reject' },
  { g: '认证', name: '未带 token 访问受保护接口', m: 'GET', p: '/api/regulator/enterprises', expect: 'reject' },
  { g: '认证', name: '伪造 token', m: 'GET', p: '/api/regulator/enterprises', token: 'Bearer.fake.token', expect: 'reject' },

  /* --- 分页与数值边界 --- */
  { g: '分页', name: 'size 负数', m: 'GET', p: '/api/regulator/enterprises?page=1&size=-5', auth: 'REGULATOR', expect: 'any200' },
  { g: '分页', name: 'size 超大 1e9', m: 'GET', p: '/api/regulator/enterprises?page=1&size=1000000000', auth: 'REGULATOR', expect: 'any200',
    check: (r) => (!r.json || !r.json.data || Number(r.json.data.size) > 200 ? '每页条数未受上限约束（size 未被夹取）' : '') },
  { g: '分页', name: 'size=NaN', m: 'GET', p: '/api/regulator/enterprises?page=1&size=NaN', auth: 'REGULATOR', expect: 'any200' },
  { g: '分页', name: 'page=0', m: 'GET', p: '/api/regulator/enterprises?page=0&size=20', auth: 'REGULATOR', expect: 'any200' },
  /* 页码是"可夹取的参数"，不是"必须拒绝的参数"：非法页码被夹到第 1 页
     并正常返回，比抛 400 更符合分页惯例。判据改为"必须夹取且不得崩/不得注入"，
     此处原来写成 expect:'reject' 属于判据过严——同一组里 page=0/NaN 都按 any200 判。 */
  { g: '分页', name: 'page 超长串', m: 'GET', p: `/api/regulator/enterprises?page=${PAYLOADS.long}&size=20`, auth: 'REGULATOR', expect: 'any200',
    check: (r) => (!r.json || !r.json.data || Number(r.json.data.page) !== 1 ? '非法页码未被夹取为第 1 页' : '') },
  { g: '分页', name: 'page SQL 注入', m: 'GET', p: `/api/regulator/enterprises?page=${encodeURIComponent(PAYLOADS.sql)}&size=20`, auth: 'REGULATOR', expect: 'any200' },

  /* --- 路径参数 --- */
  { g: '路径参数', name: '区块高度=abc', m: 'GET', p: '/api/chain/block/abc', expect: 'reject' },
  { g: '路径参数', name: '区块高度=-1', m: 'GET', p: '/api/chain/block/-1', expect: 'reject' },
  { g: '路径参数', name: '区块高度=1e18', m: 'GET', p: '/api/chain/block/1000000000000000000', expect: 'reject' },
  { g: '路径参数', name: '区块高度=路径穿越', m: 'GET', p: '/api/chain/block/..%2f..%2f..%2fetc%2fpasswd', expect: 'reject' },
  { g: '路径参数', name: '地址参数 XSS 片段', m: 'GET', p: '/api/chain/address/%3Cscript%3Ealert(1)%3C%2Fscript%3E', expect: 'reject' },

  /* --- 查询关键词（拼接高危点）--- */
  { g: '关键词', name: '企业搜索 SQL 注入', m: 'GET', p: `/api/regulator/enterprises?keyword=${encodeURIComponent(PAYLOADS.sql)}`, auth: 'REGULATOR', expect: 'any200' },
  { g: '关键词', name: '企业搜索 DROP TABLE', m: 'GET', p: `/api/regulator/enterprises?keyword=${encodeURIComponent(PAYLOADS.sql2)}`, auth: 'REGULATOR', expect: 'any200' },
  { g: '关键词', name: '企业搜索 XSS', m: 'GET', p: `/api/regulator/enterprises?keyword=${encodeURIComponent(PAYLOADS.xss)}`, auth: 'REGULATOR', expect: 'any200' },
  { g: '关键词', name: '企业搜索 10k 字符', m: 'GET', p: `/api/regulator/enterprises?keyword=${PAYLOADS.long}`, auth: 'REGULATOR', expect: 'any200' },
  { g: '关键词', name: '企业搜索 emoji', m: 'GET', p: `/api/regulator/enterprises?keyword=${encodeURIComponent(PAYLOADS.emoji)}`, auth: 'REGULATOR', expect: 'any200' },

  /* --- 写接口：只喂非法参数，期望 4xx --- */
  { g: '写接口', name: '登录态下单：空 body', m: 'POST', p: '/api/trade/orders', b: {}, auth: 'TRADER', expect: 'reject' },
  { g: '写接口', name: '下单：数量为负', m: 'POST', p: '/api/trade/orders', b: { side: 'SELL', amount: -100, price: 50 }, auth: 'TRADER', expect: 'reject' },
  { g: '写接口', name: '下单：数量为 NaN', m: 'POST', p: '/api/trade/orders', b: { side: 'SELL', amount: 'NaN', price: 'NaN' }, auth: 'TRADER', expect: 'reject' },
  { g: '写接口', name: '下单：数量 1e18', m: 'POST', p: '/api/trade/orders', b: { side: 'SELL', amount: 1e18, price: 1e18 }, auth: 'TRADER', expect: 'reject' },
  { g: '写接口', name: '下单：side 非法枚举', m: 'POST', p: '/api/trade/orders', b: { side: 'DROP', amount: 1, price: 1 }, auth: 'TRADER', expect: 'reject' },
  { g: '写接口', name: '抵销：负数金额', m: 'POST', p: '/api/trade/offset', b: { amount: -1 }, auth: 'TRADER', expect: 'reject' },
  { g: '写接口', name: '抵销：10k 字符串金额', m: 'POST', p: '/api/trade/offset', b: { amount: PAYLOADS.long }, auth: 'TRADER', expect: 'reject' },
  { g: '写接口', name: '上报：空 body', m: 'POST', p: '/api/mrv/reports', b: {}, auth: 'ENTERPRISE', expect: 'reject' },
  { g: '写接口', name: '上报：items 非数组', m: 'POST', p: '/api/mrv/reports', b: { year: 2025, month: 1, items: 'not-an-array' }, auth: 'ENTERPRISE', expect: 'reject' },
  { g: '写接口', name: '上报：月份 13', m: 'POST', p: '/api/mrv/reports', b: { year: 2025, month: 13, items: [] }, auth: 'ENTERPRISE', expect: 'reject' },
  { g: '写接口', name: '上报：年份 1e18', m: 'POST', p: '/api/mrv/reports', b: { year: 1e18, month: 1, items: [] }, auth: 'ENTERPRISE', expect: 'reject' },

  /* --- 只读接口：极端参数不应 5xx --- */
  { g: '只读', name: 'CEMS 记录：size 超大', m: 'GET', p: '/api/cems/records?size=1000000', auth: 'REGULATOR', expect: 'any200' },
  { g: '只读', name: '真实设施：year=abc', m: 'GET', p: '/api/real/facilities?year=abc', auth: 'REGULATOR', expect: 'any200' },
  { g: '只读', name: '真实总览：country 非法', m: 'GET', p: '/api/real/overview?country=ZZZ', auth: 'REGULATOR', expect: 'reject' },
  { g: '只读', name: '真实趋势：country 注入', m: 'GET', p: `/api/real/trend?country=${encodeURIComponent(PAYLOADS.sql)}`, auth: 'REGULATOR', expect: 'any200' },
  { g: '只读', name: '数据真实性契约', m: 'GET', p: '/api/zk/data-truth', expect: 'any200' },
  { g: '只读', name: '不存在的路由', m: 'GET', p: '/api/definitely-not-here', expect: 'reject' },
];

async function main() {
  /* 先拿 5 个角色的 token */
  const TOK = {};
  for (const [role, u, p] of [['ENTERPRISE', 'ent001', '123456'], ['VERIFIER', 'ver001', '123456'],
    ['REGULATOR', 'reg001', '123456'], ['TRADER', 'trader01', '123456'], ['ADMIN', 'admin', 'admin123']]) {
    const r = await req('POST', '/api/auth/login', { body: { username: u, password: p } });
    TOK[role] = r.json && r.json.data && r.json.data.token;
  }

  const results = [];
  for (const c of CASES) {
    const token = c.token || (c.auth ? TOK[c.auth] : undefined);
    const r = await req(c.m, c.p, { body: c.b, token });
    const text = r.raw || '';
    /* 命中要留证据：只说"泄漏了 mysql"却不给位置，等于让下一个人重跑一遍。
       echo-* 只在响应是 text/html 时才算泄漏——JSON 里原样回显输入是
       正常的校验提示（"未知国家代码：xxx"），前端用文本节点渲染不会执行。 */
    const isHtml = /text\/html/i.test(r.ct || '');
    const hits = [];
    for (const x of LEAK) {
      x.re.lastIndex = 0;
      const m = x.re.exec(text);
      if (!m) continue;
      if (x.id.startsWith('echo-') && !isHtml) continue;
      hits.push({ id: x.id, hit: m[0].slice(0, 40), at: m.index, ctx: text.slice(Math.max(0, m.index - 50), m.index + 70).replace(/\s+/g, ' ') });
    }
    const leaks = hits.map((h) => h.id);

    /* 判定 */
    const problems = [];
    if (r.status === 0) problems.push(r.timeout ? '请求超时（>30s）' : `连接失败 ${r.error || ''}`);
    if (r.status >= 500) problems.push(`5xx（${r.status}）—— 服务端崩溃而不是拒绝`);
    if (leaks.length) problems.push('响应泄漏内部信息：' + leaks.join(','));
    if (c.expect === 'reject') {
      if (r.status >= 200 && r.status < 300) problems.push(`本应拒绝却返回 ${r.status}`);
      if (r.status >= 400 && r.status < 500) {
        const msg = r.json && (r.json.message || r.json.msg);
        if (!msg) problems.push('拒绝但没有可读 message');
        else if (!/[\u4e00-\u9fa5]/.test(msg)) problems.push(`错误提示无中文："${String(msg).slice(0, 50)}"`);
      }
    }
    if (r.status >= 200 && r.status < 300 && c.expect === 'any200' && leaks.length) {
      problems.push('正常响应里出现内部信息');
    }
    if (r.ms > 5000) problems.push(`响应过慢 ${r.ms} ms`);
    if (typeof c.check === 'function') {
      try { const msg = c.check(r); if (msg) problems.push(msg); } catch (e) { problems.push('自定义断言抛错：' + e.message); }
    }

    results.push({
      group: c.g, name: c.name, method: c.m, path: c.p.slice(0, 90),
      status: r.status, ms: r.ms, expect: c.expect,
      message: (r.json && (r.json.message || r.json.msg)) || '',
      ct: r.ct, bodyLen: text.length,
      leaks, leakHits: hits,
      problems,
    });
    const ok = problems.length === 0;
    console.log(`  ${ok ? '✔' : '✘'} [${c.g}] ${c.name.padEnd(24)} ${String(r.status).padEnd(4)} ${r.ms}ms${ok ? '' : '  ← ' + problems.join(' / ')}`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const bad = results.filter((x) => x.problems.length);
  const byGroup = {};
  for (const r of results) {
    byGroup[r.group] = byGroup[r.group] || { total: 0, bad: 0 };
    byGroup[r.group].total++;
    if (r.problems.length) byGroup[r.group].bad++;
  }
  const report = { generatedAt: new Date().toISOString(), base: BASE, total: results.length, bad: bad.length, byGroup, results };
  fs.writeFileSync(path.join(OUT, 'input-fuzz.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n合计 ${results.length} 例，其中 ${bad.length} 例有问题`);
  for (const [g, v] of Object.entries(byGroup)) console.log(`  ${g.padEnd(6)} ${v.total - v.bad}/${v.total}`);
  console.log(`报告：${path.join(OUT, 'input-fuzz.json')}`);
  process.exit(bad.length ? 1 : 0);
}

main();
