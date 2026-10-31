const http = require('http');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function req(method, p, tok) {
  return new Promise((resolve) => {
    const h = tok ? { Authorization: 'Bearer ' + tok } : {};
    const r = http.request({ host: '127.0.0.1', port: 8300, path: p, method, headers: h }, (resp) => {
      let s = '';
      const t0 = Date.now();
      resp.on('data', (c) => (s += c));
      resp.on('end', () => {
        let b = null; try { b = JSON.parse(s); } catch { /* 非 JSON */ }
        resolve({ status: resp.statusCode, code: b && b.code, msg: b && b.message, ms: Date.now() - t0 });
      });
    });
    r.setTimeout(30000, () => { r.destroy(); resolve({ status: -2, msg: 'TIMEOUT' }); });
    r.on('error', (e) => resolve({ status: -1, msg: e.message }));
    r.end();
  });
}

/* 每个角色必须能打通的核心接口（按业务流程排列） */
const SUITES = {
  admin: ['/api/admin/overview', '/api/admin/factors', '/api/admin/factor-versions',
    '/api/chain/stats', '/api/chain/validate', '/api/chain/trust-model',
    '/api/consortium/nodes', '/api/ops/health', '/api/real/truth'],
  reg001: ['/api/regulator/overview', '/api/regulator/enterprises', '/api/regulator/alerts',
    '/api/regulator/allocations', '/api/regulator/logs', '/api/regulator/system',
    '/api/chain/stats', '/api/chain/business-binding', '/api/settlement/account/overview'],
  ent001: ['/api/enterprise/overview', '/api/enterprise/reports', '/api/enterprise/quota',
    '/api/enterprise/wallet', '/api/enterprise/notices', '/api/enterprise/analytics',
    '/api/chain/stats', '/api/dynamic/me'],
  ver001: ['/api/verifier/overview', '/api/verifier/tasks', '/api/verifier/reports',
    '/api/verifier/wallet', '/api/verifier/notices', '/api/chain/stats'],
  trader01: ['/api/trade/market', '/api/trade/orderbook', '/api/trade/orders',
    '/api/trade/deals', '/api/trade/account', '/api/credit/assets', '/api/chain/stats'],
};

(async () => {
  let bad = 0, total = 0;
  for (const [user, paths] of Object.entries(SUITES)) {
    const tf = path.join(DIR, `tok-${user}.txt`);
    const tok = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8') : null;
    console.log(`\n===== ${user} =====`);
    for (const p of paths) {
      total++;
      const r = await req('GET', p, tok);
      const ok = r.status === 200 && r.code === 0;
      if (!ok) bad++;
      console.log(`${ok ? '  ' : 'XX'} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)}ms ${p}${r.msg ? ' | ' + String(r.msg).slice(0, 50) : ''}`);
    }
  }
  console.log(`\n>>> 共 ${total} 项，失败 ${bad} 项`);
  process.exit(bad ? 1 : 0);
})();
