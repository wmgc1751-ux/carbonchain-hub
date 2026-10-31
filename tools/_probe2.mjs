#!/usr/bin/env node
/**
 * tools/_probe2.mjs —— 通用只读探针
 * 用法：node tools/_probe2.mjs <role> <path> [jqLikeKey]
 *   role: admin | reg | ver | ent | tr | none
 *   path: 以 / 开头的接口路径（不含 /api 前缀）
 * 打印 JSON（超长自动截断到 2000 字符，可用 KEY 只看某一字段）。
 */
const BASE = 'http://127.0.0.1:8300';
const ACC = {
  admin: ['admin', 'admin123'], reg: ['reg001', '123456'], ver: ['ver001', '123456'],
  ent: ['ent_zjbd', '123456'], tr: ['trader01', '123456'],
};
const api = async (p, opt = {}) => {
  const r = await fetch(BASE + '/api' + p, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { code: r.status, raw: t.slice(0, 200) }; }
};
const [role, p, key] = process.argv.slice(2);
(async () => {
  let tk = null;
  if (role !== 'none') {
    const [u, pw] = ACC[role] || [];
    const r = await api('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }) });
    tk = r?.data?.token;
    if (!tk) { console.log('LOGIN FAIL', JSON.stringify(r).slice(0, 200)); process.exit(1); }
  }
  const r = await api(p, { headers: tk ? { authorization: `Bearer ${tk}` } : {} });
  let d = r.data !== undefined ? r.data : r;
  if (key) d = key.split('.').reduce((o, k) => (o == null ? o : o[k]), d);
  if (d === undefined) {
    const src = r.data !== undefined ? r.data : r;
    console.log('KEY NOT FOUND. top-level keys = ' + JSON.stringify(Object.keys(src || {})));
    const s0 = JSON.stringify(src, null, 1);
    console.log(s0.length > 4000 ? s0.slice(0, 4000) + `\n... (${s0.length} chars)` : s0);
    return;
  }
  const s = JSON.stringify(d, null, 1);
  console.log(s.length > 4000 ? s.slice(0, 4000) + `\n... (${s.length} chars)` : s);
})();
