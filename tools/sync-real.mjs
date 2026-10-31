#!/usr/bin/env node
/**
 * tools/sync-real.mjs —— 手动触发外部真实源同步
 * ==================================================================================
 * 平台在启动 20 秒后会自己按 TTL 同步（见 server/services/realSync.js）。
 * 这个脚本是给运维/演示用的手动入口：
 *
 *   node tools/sync-real.mjs                # 只同步已到期的源
 *   node tools/sync-real.mjs --force        # 忽略 TTL，全部重拉
 *   node tools/sync-real.mjs --only worldbank
 *   node tools/sync-real.mjs --status       # 只看新鲜度，不发请求
 *
 * 【为什么默认不 force】
 * 世行 / OWID 的排放数据是年度发布。强制刷新拉到的还是同一个文件，
 * 但会：① 白白消耗对方带宽（开放数据项目最怕这个）；② 把出口 IP 打进风控。
 * "刷新"按钮看起来无害，滥用它就是在消耗公共资源。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/* ESM 里加载 CJS 的正规做法：服务层是 module.exports，用 createRequire 直接拿，
 * 而不是 import() —— 后者返回 { default: ... }，每处调用都要拆一层，容易漏。 */
const R = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const ARGV = process.argv.slice(2);
const force = ARGV.includes('--force');
const statusOnly = ARGV.includes('--status');
const onlyArg = ARGV.indexOf('--only');
const only = onlyArg >= 0 && ARGV[onlyArg + 1]
  ? ARGV[onlyArg + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;

const fmtAge = (sec) => {
  if (sec === null || sec === undefined) return '从未同步';
  if (sec < 60) return `${Math.round(sec)} 秒前`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小时前`;
  return `${(sec / 86400).toFixed(1)} 天前`;
};

(async () => {
  const rs = require_(path.join(ROOT, 'server', 'services', 'realSync.js'));
  const IR = require_(path.join(ROOT, 'server', 'services', 'ingestReal.js'));

  /* 首次运行时 data_source 可能还没登记，先幂等登记 */
  await IR.registerSources().catch(() => {});

  const show = async () => {
    const list = await rs.freshness();
    console.log('\n数据源新鲜度');
    console.log('─'.repeat(96));
    console.log('  来源'.padEnd(22) + '真实性'.padEnd(10) + '记录数'.padStart(10)
      + '  最近同步'.padStart(14) + '  状态'.padStart(8) + '  下次检查');
    for (const s of list) {
      console.log('  ' + String(s.key).padEnd(20)
        + String(s.authenticity).padEnd(10)
        + String(s.recordCount === null ? '—' : s.recordCount).padStart(10)
        + fmtAge(s.ageSec).padStart(14)
        + String(s.lastStatus || '—').padStart(8)
        + '  ' + (s.dueForCheck ? '已到期' : '未到期'));
    }
    const due = list.filter((s) => s.dueForCheck);
    console.log('─'.repeat(96));
    console.log(`  共 ${list.length} 个源，${due.length} 个已到期`
      + (due.length ? `：${due.map((x) => x.key).join(', ')}` : ''));
    return list;
  };

  if (statusOnly) { await show(); process.exit(0); }

  console.log(`\n开始同步${force ? '（强制刷新，忽略 TTL）' : '（仅到期源）'}`
    + (only ? `，限定：${only.join(', ')}` : ''));
  const r = await rs.runOnce({ force, only });

  console.log(`\n本轮耗时 ${r.durationMs} ms，处理 ${r.total} 个源`);
  for (const x of r.results || []) {
    const mark = x.ok ? '✔' : (x.skipped ? '·' : '✘');
    let extra = '';
    if (x.ok && x.detail) {
      if (x.detail.worldbank) extra = ` 入库 ${x.detail.worldbank.rows} 行`;
      else if (x.detail.owid) extra = ` 入库 ${x.detail.owid.rows} 行`;
      else if (x.detail.emissionRows !== undefined) {
        extra = ` 设施 ${x.detail.facilities} 家 / 记录 ${x.detail.emissionRows} 条`;
      }
    }
    console.log(`  ${mark} ${x.key.padEnd(14)} ${x.ok ? 'OK' : (x.error || '失败')}${extra}`);
  }

  await show();

  /* 本次结果落盘，供证据包与台账引用 */
  try {
    const fs = await import('node:fs');
    const outDir = path.join(ROOT, 'tools', 'out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'real-sync.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      force, only, durationMs: r.durationMs, total: r.total,
      results: (r.results || []).map((x) => ({
        key: x.key, ok: x.ok, skipped: !!x.skipped, error: x.error || null,
      })),
    }, null, 2), 'utf8');
    console.log('\n  已写出：tools/out/real-sync.json');
  } catch (e) { console.log('  ⚠ 写 real-sync.json 失败：', e.message); }

  const failed = (r.results || []).filter((x) => !x.ok && !x.skipped);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('同步失败：', e && e.stack || e);
  process.exit(1);
});

/* ESM 里加载 CommonJS：用 createRequire 而不是 import()，
 * 因为 services 层是 CJS（module.exports），import() 拿到的是 { default: ... }，
 * 每次都要拆一层，容易漏。 */
function require_(p) {
  return R(p);
}
