/**
 * _probe-mrv-ui.mjs —— MRV 前端页面实测（起服务 → 逐页渲染检查 → 关服务）
 * ==================================================================================
 * 只用 HTTP 取页面 + 检查关键接口返回，不依赖浏览器。
 * 真正的 DOM 渲染由 server/scripts/cdp-check.js（check:ui）负责，
 * 本脚本解决的是「路由注册了没有、接口通不通、JS 有没有 404」这三个最快崩的问题。
 *
 * ⚠ 单进程：沙箱会回收后台进程，`node app.js &` 在下一个命令里就死了。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PROBE_PORT || 8398);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ['server/app.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), INSTANCE_LOCK: '0', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', CEMS_INTERVAL_MS: '86400000', HJ212_AUTOSTART: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const items = [];
const push = (n, ok, d) => { items.push({ n, ok, d }); console.log(`${ok ? '✔' : '✘'} ${n}${d ? ' — ' + d : ''}`); };

async function up(maxMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* wait */ }
    await sleep(400);
  }
  return false;
}
async function get(path, tok) {
  const r = await fetch(`${BASE}${path}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  const txt = await r.text();
  let body = null; try { body = JSON.parse(txt); } catch { body = { raw: txt.slice(0, 200) }; }
  return { status: r.status, body };
}

async function main() {
  if (!(await up())) { console.error('服务未就绪'); console.error(log.slice(-2000)); child.kill('SIGKILL'); process.exit(1); }
  console.log(`服务就绪 @ ${BASE}\n${'─'.repeat(70)}`);

  /* 1. index.html 引用了 mrv.js */
  const idx = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  push('index.html 引入 mrv.js', idx.includes('js/views/mrv.js'), 'script 标签存在');

  /* 2. mrv.js 可取到且语法可解析（浏览器侧会真解析，这里先查可达与大小） */
  const js = readFileSync(join(ROOT, 'public/js/views/mrv.js'), 'utf8');
  push('mrv.js 已落盘且非空', js.length > 8000, `${(js.length / 1024).toFixed(1)} KB`);

  /* 3. 五个视图已注册 */
  /* ⚠ 视图分散在 mrv.js 与 zk.js 两个文件里 —— 探针必须两个都读，
   *   只查 mrv.js 会误报「ZK 视图未注册」（实际是查错了文件）。 */
  const zkJsPath = join(ROOT, 'public/js/views/zk.js');
  const zkJs = existsSync(zkJsPath) ? readFileSync(zkJsPath, 'utf8') : '';
  push('zk.js 已落盘', zkJs.length > 5000, `${(zkJs.length / 1024).toFixed(1)} KB`);
  const allJs = js + zkJs;
  const expectViews = ['page-zk', 'page-ent-zk', 'page-reg-zk', 'page-mrv-activity', 'page-mrv-calc', 'page-mrv-factor', 'page-mrv-compliance', 'page-mrv-cbam'];
  const missing = expectViews.filter((v) => !allJs.includes(`'${v}'`));
  push('全部视图已注册（MRV + ZK）', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : `${expectViews.length} 个视图`);

  /* 4. 路由已定义（app.js 中含路径） */
  const appjs = readFileSync(join(ROOT, 'public/js/app.js'), 'utf8');
  const expectRoutes = ['/mrv/activity', '/mrv/calc', '/mrv/factor', '/mrv/compliance', '/ent/mrv/cbam', '/ent/zk'];
  const missR = expectRoutes.filter((p) => !appjs.includes(`'${p}'`));
  push('MRV 路由已定义', missR.length === 0, missR.length ? `缺 ${missR.join(',')}` : `${expectRoutes.length} 条`);

  /* 5. 登录并测各页所需接口 */
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ent001', password: '123456' }),
  });
  const lj = await r.json();
  const tok = lj.data.token;
  push('企业端登录', !!tok, 'ent001');

  const checks = [
    ['/api/mrv/activity?year=2026', '活动数据接口'],
    ['/api/mrv/factor', '因子台账接口（公开）'],
    ['/api/mrv/calc/batches?year=2026', '核算批次列表'],
    ['/api/mrv/quality?year=2026', '数据质量接口'],
    ['/api/settlement/account', '结算账户'],
    ['/api/settlement/surrender/status?year=2026', '履约状态'],
    ['/api/settlement/cbam/factor', 'CBAM 因子表'],
    ['/api/settlement/cbam/certificates?year=2026', 'CBAM 证书台账'],
    ['/api/zk/protocol', 'ZK 协议说明'],
    ['/api/zk/commitments?year=2026', 'ZK 承诺列表'],
    ['/api/zk/data-truth', 'ZK 数据真实性声明'],
  ];
  for (const [p, name] of checks) {
    const res = await get(p, p.includes('/factor') ? null : tok);
    push(name, res.status === 200, res.status === 200 ? 'HTTP 200' : `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`);
  }

  /* 6. 因子接口未登录也可读（公开性是设计目标） */
  const pub = await get('/api/mrv/factor');
  push('因子台账无需登录可读', pub.status === 200, `HTTP ${pub.status}`);

  /* 7. 方法学自检公开 */
  const st = await get('/api/mrv/factor/selftest');
  push('方法学自检公开可访问', st.status === 200 && st.body.data.passed === st.body.data.total,
    st.status === 200 ? `${st.body.data.passed}/${st.body.data.total}` : '');

  /* 8. 核算试算（页面的核心动作） */
  const pv = await fetch(`${BASE}/api/mrv/calc/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ year: 2026 }),
  });
  const pvj = await pv.json();
  push('核算试算接口', pv.status === 200 && pvj.data.total > 0,
    pv.status === 200 ? `${pvj.data.total} tCO₂e，分源 ${pvj.data.rows.length} 项` : JSON.stringify(pvj).slice(0, 150));

  /* 9. 页面上用到的字段都必须存在（前后端契约） */
  if (pv.status === 200) {
    const d = pvj.data;
    const need = ['total', 'scope1', 'scope2', 'complete', 'gapCount', 'rows', 'quality', 'usableForCompliance', 'uncertainty', 'inputDigest', 'resultDigest'];
    const missF = need.filter((k) => d[k] === undefined);
    push('试算返回字段与页面契约一致', missF.length === 0, missF.length ? `缺 ${missF.join(',')}` : `${need.length} 个字段齐备`);
    const u = d.uncertainty || {};
    push('不确定度字段齐备', u.u95Rel !== undefined && u.contributions && u.crossValidation && u.priorGate,
      `uc=${u.ucRel}, U95=${u.u95Rel}, 互证=${u.crossValidation && u.crossValidation.verdict}`);
  }

  const pass = items.filter((i) => i.ok).length;
  console.log(`${'─'.repeat(70)}\n结果：${pass}/${items.length}`);
  const bad = items.filter((i) => !i.ok);
  if (bad.length) { console.log('\n失败：'); bad.forEach((b) => console.log(`  ✘ ${b.n} — ${b.d}`)); }

  child.kill('SIGKILL');
  await sleep(200);
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); child.kill('SIGKILL'); process.exit(1); });
