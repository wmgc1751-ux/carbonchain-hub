const fs = require('fs');
const http = require('http');
const DIR = __dirname;

function req(method, p, tok, body) {
  return new Promise((resolve) => {
    const d = body ? JSON.stringify(body) : null;
    const h = {};
    if (d) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(d); }
    if (tok) h.Authorization = 'Bearer ' + tok;
    const r = http.request({ host: '127.0.0.1', port: 8300, path: p, method, headers: h }, (resp) => {
      let s = '';
      resp.on('data', (c) => (s += c));
      resp.on('end', () => { let b; try { b = JSON.parse(s); } catch { b = s; } resolve({ status: resp.statusCode, body: b }); });
    });
    r.on('error', (e) => resolve({ status: -1, body: e.message }));
    if (d) r.write(d);
    r.end();
  });
}

(async () => {
  const adm = fs.readFileSync(DIR + '/tok-admin.txt', 'utf8');
  const list = await req('GET', '/api/admin/verifier-registrations', adm);
  console.log('待审列表:', JSON.stringify(list.body.data));
  const t = (list.body.data || [])[0];
  if (!t) { console.log('无待审记录'); return; }

  const rv = await req('POST', '/api/admin/verifier-registrations/' + t.id + '/review', adm, { approve: true, reason: '端到端验证' });
  console.log('审核:', rv.status, rv.body.message);

  const lg = await req('POST', '/api/auth/login', null, { username: t.username, password: 'test123456' });
  console.log('审核后登录:', lg.status, lg.body.message);
  if (lg.body.code !== 0) return;

  const v = lg.body.data.token;
  for (const p of ['/api/verifier/overview', '/api/verifier/tasks', '/api/verifier/wallet', '/api/verifier/notices', '/api/chain/stats']) {
    const r = await req('GET', p, v);
    console.log(' ', (r.status === 200 && r.body.code === 0) ? '✔' : '✘', p, r.status);
  }

  // 新机构应有钱包身份
  const w = await req('GET', '/api/verifier/wallet', v);
  console.log('机构钱包:', w.body.data && w.body.data.address);
})();
