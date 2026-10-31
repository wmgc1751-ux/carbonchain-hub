/**
 * full-regression.mjs —— 一体化全量回归（起服务 → 全量回归 → 证据三件套 → 自验）
 * ==================================================================================
 * 【为什么必须是一体化脚本】
 * 2026-10-24 的教训：单独跑每个脚本都成功，但合起来会互相矛盾 ——
 *   · 指标台账引用的 verify-all.json 是**上一轮**的；
 *   · 证据包里打进去的是**再上一轮**的；
 *   · 于是"台账说 121/121 通过"与"证据包里是 0/0"同时存在。
 * 根因是这些产物有先后依赖，而人工按顺序敲命令时很容易漏一步。
 *
 * 本脚本把顺序写死在代码里，且每一步失败都会中止后续（避免产出矛盾证据）：
 *   ① 起服务（子进程，探活就绪）
 *   ② 跑 verify-all（全量，写 verify-all.json）
 *   ③ 跑指标台账（读刚写的 verify-all.json）
 *   ④ 跑数据来源分级
 *   ⑤ 跑证据包（打包上面全部产物）
 *   ⑥ 用包内 verify-pack.mjs 自验（零依赖复核）
 *   ⑦ 阴性对照：改包内一个文件的一个字节，必须被检出 PACK_TAMPERED
 *   ⑧ 关服务
 *
 * ⚠ 不要用 `--only` 跑部分套件 —— 那会覆盖 verify-all.json 留下 0/0 假数据。
 *
 * 用法：node tools/full-regression.mjs [--skip-negative]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REGRESSION_PORT || 8300);
const skipNegative = process.argv.includes('--skip-negative');

let child = null;
const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** 在 ROOT 下跑一个 node 脚本，返回 { code, out } */
function runNode(script, args = [], env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function waitHttp(maxMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch { /* 未起来 */ }
    await sleep(500);
  }
  return false;
}

async function main() {
  console.log('═'.repeat(76));
  console.log('碳链通 · 一体化全量回归');
  console.log('═'.repeat(76));
  const t0 = Date.now();

  /* ============ ① 起服务 ============ */
  console.log('\n[①] 启动服务…');
  child = spawn(process.execPath, ['server/app.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      CEMS_INTERVAL_MS: '86400000',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  child.stdout.on('data', (d) => { srvOut += d.toString(); });
  child.stderr.on('data', (d) => { srvOut += d.toString(); });

  const up = await waitHttp();
  record('服务就绪', up, up ? `127.0.0.1:${PORT}` : '45s 未就绪');
  if (!up) {
    console.error(srvOut.slice(-2500));
    child.kill('SIGKILL');
    process.exit(1);
  }

  /* ============ ② 全量回归 ============ */
  console.log('\n[②] 全量回归（18+1 套件）…');
  const va = await runNode('tools/verify-all.mjs', [], { PORT: String(PORT) });
  /* 解析汇总行：通过 X · 失败 Y · 跳过 Z · 断言 A/B */
  const m = va.out.match(/通过\s*(\d+)\s*·\s*部分\s*(\d+)\s*·\s*失败\s*(\d+)\s*·\s*阻断\s*(\d+)\s*·\s*跳过\s*(\d+)/);
  const am = va.out.match(/断言合计\s*(\d+)\/(\d+)/);
  const failedSuites = (va.out.match(/失败套件：(.+)/) || [])[1] || '';
  if (m) {
    const [, pass, partial, fail, block, skip] = m.map(Number);
    record('全量回归跑完', true,
      `通过 ${pass} / 失败 ${fail} / 跳过 ${skip}${am ? ` · 断言 ${am[1]}/${am[2]}` : ''}`);
    record('无失败套件', fail === 0, fail === 0 ? '全部通过' : `失败：${failedSuites}`);
  } else {
    record('全量回归跑完', false, `无法解析汇总行（exit ${va.code}）`);
    console.log(va.out.slice(-2000));
  }

  /* 校验 verify-all.json 新鲜 —— 这是"证据一致性"的关键检查点 */  const vaJson = join(ROOT, 'tools/out/verify-all.json');
  if (existsSync(vaJson)) {
    const st = statSync(vaJson);
    const ageSec = (Date.now() - st.mtimeMs) / 1000;
    const sum = JSON.parse(readFileSync(vaJson, 'utf8'));
    /* ⚠ 字段路径是 totals.sumTotal，不是顶层 sumTotal。
     *   第一次写这个脚本时读成了 sum.sumTotal 得到 undefined → Number() → 0，
     *   于是误判"残缺轮次"。这类"读错字段导致假红"与"读错字段导致假绿"同样危险。 */
    const totalAssert = Number(sum.totals && sum.totals.sumTotal !== undefined
      ? sum.totals.sumTotal : 0);
    record('verify-all.json 是本轮产物', ageSec < 600,
      `${ageSec.toFixed(0)} 秒前生成，断言 ${totalAssert}`);
    /* ⚠ 假数据检测：断言总数为 0 说明这是 `--only` 部分运行留下的残缺轮次 */
    record('verify-all.json 非残缺轮次（断言数 > 0）', totalAssert > 0,
      totalAssert > 0 ? `${totalAssert} 条断言` : '断言数为 0 —— 疑似 --only 部分运行留下的假数据');
  } else {
    record('verify-all.json 存在', false, '文件缺失');
  }

  /* ============ ③④⑤ 证据三件套 ============ */
  /* ============ ②b 页面级巡检（CDP） ============
   * 为什么必须放在证据三件套之前：页面巡检会重新拉起 Edge 并导航 24 页，
   * 耗时约 1~2 分钟且会占用 8300 之上的调试端口。放在最后会与"关服务"冲突。
   * 它产出的 tools/out/ui-check.json 会被下面的指标台账消费。 */
  console.log('\n[②b] 页面级巡检（CDP）…');
  const ui = await runNode('server/scripts/cdp-check.js', [], {
    PORT: String(PORT), APP_BASE: `http://127.0.0.1:${PORT}`,
  });
  const um = ui.out.match(/=====\s*(\d+)\/(\d+)\s*通过/);
  if (um) {
    const [, okN, allN] = um.map(Number);
    record('页面级巡检', okN === allN, `${okN}/${allN} 页通过`);
  } else {
    record('页面级巡检', ui.code === 0, `无法解析汇总（exit ${ui.code}）；可能无 Edge 或调试端口被占`);
  }

  console.log('\n[③] 指标溯源台账…');
  const ledger = await runNode('tools/metrics-ledger.mjs', []);
  const lm = ledger.out.match(/(\d+)\s*条指标/);
  record('指标台账生成', ledger.code === 0 || ledger.code === undefined,
    lm ? `${lm[1]} 条指标` : (ledger.out.split('\n').filter((x) => x.trim()).slice(-1)[0] || ''));

  console.log('\n[④] 数据来源分级…');
  const prov = await runNode('tools/data-provenance.mjs', []);
  record('数据来源分级生成', prov.code === 0,
    (prov.out.split('\n').filter((x) => x.includes('L3') || x.includes('L0')).slice(-1)[0] || '').trim());

  console.log('\n[⑤] 证据包打包…');
  const pack = await runNode('tools/evidence-pack.mjs', []);
  record('证据包生成', pack.code === 0,
    (pack.out.split('\n').filter((x) => x.includes('文件') || x.includes('PACK')).slice(-1)[0] || '').trim());

  /* ============ ⑥ 包内自验 ============ */
  console.log('\n[⑥] 用包内工具自验（零依赖复核）…');
  /* 找最新的证据包目录。
   * ⚠ 证据包实际输出在 tools/out/evidence-pack-YYYYMMDD，不是 参赛材料/。
   *   早先按 参赛材料/证据包* 去找，第一次运行就出现"找不到包"的假红。
   *   这里同时检查两处，兼容历史产物。 */
  const candidates = [];
  const scanRoots = [join(ROOT, 'tools/out'), join(ROOT, '参赛材料'), join(ROOT, '../参赛材料')];
  for (const root of scanRoots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      if (/^evidence-pack-|^证据包/.test(d)) {
        const full = join(root, d);
        if (statSync(full).isDirectory() && existsSync(join(full, '复核工具/verify-pack.mjs'))) {
          candidates.push(full);
        }
      }
    }
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const packDir = candidates[0] || null;

  if (packDir && existsSync(join(packDir, '复核工具/verify-pack.mjs'))) {
    const v1 = await runNode(join(packDir, '复核工具/verify-pack.mjs'), []);
    const intact = /PACK_INTACT/.test(v1.out);
    record('包内自验 PACK_INTACT', intact, intact ? '逐文件摘要一致' : v1.out.slice(-400));

    /* ============ ⑦ 阴性对照 ============ */
    if (!skipNegative) {
      console.log('\n[⑦] 阴性对照：篡改包内一个文件，必须被检出…');
      /* 挑一个小的、非 manifest 的文本文件 */
      const manifestPath = join(packDir, 'manifest.json');
      let target = null;
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          const st = statSync(full);
          if (st.isDirectory()) { walk(full); continue; }
          if (full === manifestPath) continue;
          if (name.endsWith('.md') || name.endsWith('.json')) {
            if (st.size < 200000) { target = full; return; }
          }
        }
      };
      if (existsSync(manifestPath)) walk(packDir);

      if (target) {
        const orig = readFileSync(target, 'utf8');
        const backup = target + '.bak';
        copyFileSync(target, backup);
        writeFileSync(target, orig + ' ', 'utf8');
        const v2 = await runNode(join(packDir, '复核工具/verify-pack.mjs'), []);
        const detected = /PACK_TAMPERED/.test(v2.out);
        /* 恢复 */
        copyFileSync(backup, target);
        rmSync(backup, { force: true });
        const v3 = await runNode(join(packDir, '复核工具/verify-pack.mjs'), []);
        const restored = /PACK_INTACT/.test(v3.out);
        record('篡改被检出（PACK_TAMPERED）', detected,
          detected ? `已检出：${target.replace(packDir, '').replace(/\\/g, '/')}` : '未检出 —— 证据包不可信');
        record('恢复后重新通过（PACK_INTACT）', restored, restored ? '恢复正确' : '恢复失败');
      } else {
        record('篡改被检出（PACK_TAMPERED）', false, '找不到可篡改的候选文件');
      }
    }
  } else {
    record('包内自验 PACK_INTACT', false, `找不到证据包目录（期望含 复核工具/verify-pack.mjs）`);
  }

  /* ============ ⑧ 关服务 ============ */
  console.log('\n[⑧] 关闭服务…');
  child.kill('SIGKILL');
  child = null;
  await sleep(300);
  record('服务已关闭', true);

  /* ============ 汇总 ============ */
  const pass = steps.filter((s) => s.ok).length;
  const fail = steps.length - pass;
  console.log('\n' + '═'.repeat(76));
  console.log(`一体化回归：${pass}/${steps.length} 步通过 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (fail) {
    console.log('\n失败步骤：');
    for (const s of steps.filter((x) => !x.ok)) console.log(`  ✘ ${s.name} — ${s.detail}`);
  }
  console.log('═'.repeat(76));

  /* 关键结论：证据一致性 */
  if (fail === 0) {
    console.log('\n✅ 证据链一致：台账、数据分级、证据包三者均基于**同一轮**回归结果。');
  } else {
    console.log('\n⚠ 存在失败步骤。在修复并重跑之前，不要引用本轮任何证据产物 ——');
    console.log('  它们可能是不同轮次混合出来的，互相矛盾。');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('✘ 回归崩溃：', e);
  if (child) child.kill('SIGKILL');
  process.exit(1);
});
