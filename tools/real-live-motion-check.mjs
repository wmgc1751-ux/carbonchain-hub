/**
 * real-live-motion-check.mjs —— 「数字真的在动」的运动检测
 * ==================================================================================
 * 【为什么必须单独测这一件事】
 * 前面所有巡检都在验证"页面有没有渲染出内容"。但本项目对用户的核心承诺是
 * **"每分每秒自动实时更新"** —— 这是一个**时间维度**的断言，静态快照式检查
 * 无论做多少遍都证明不了它。
 *
 * 一个页面可以把 5,352 渲染得完美无缺，而那个"实时速率"其实冻在采集时刻。
 * 用文字长度、行数、图表数量都查不出来。唯一有效的判据是：
 *   **在同一个页面上相隔 N 秒取两次同一个数字，它必须不一样。**
 *
 * 同时要反过来查一件事：**不该动的不能动**。
 * 真实设施数（EPA 年度数据）如果几秒内变了，那说明有人给它加了抖动 ——
 * 那比"不动"更严重，因为那是在伪造实时性。
 *
 * 判据（四条，全部必须成立）
 *   ① 实时指标文本在 3 秒内发生变化
 *   ② 变化的幅度在合理范围（不是乱跳）
 *   ③ 静态指标（真实设施 5,352）在 3 秒内保持不变
 *   ④ 通道状态显示为已连接（不是"断开"）
 *
 * 用法
 *   node tools/real-live-motion-check.mjs --base http://127.0.0.1:8300
 *   node tools/real-live-motion-check.mjs --base http://127.0.0.1:8899   # 静态站
 */
'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ARGV = process.argv.slice(2);
const argOf = (n, d) => {
  /* 同时支持 --k v 与 --k=v 两种写法。
   * 【为什么必须支持 --k=v】Windows 的 Git Bash（MSYS）会把形如 /real/facilities
   * 的命令行参数当成 POSIX 绝对路径，自动改写成 D:/WorkBuddy/.../real/facilities。
   * 结果被测页面收到一个垃圾 hash，回落 404 再被守卫踢回登录页 ——
   * 看起来像应用缺陷，实际是测试脚本被 shell 改了参数。
   * 用 --k=v 形式（赋值不经过独立 argv 元素）可以完全避开这次改写。 */
  const eq = ARGV.find((a) => a.startsWith(n + '='));
  if (eq) return eq.slice(n.length + 1);
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d;
};
const BASE = argOf('--base', 'http://127.0.0.1:8300');
const PORT = Number(argOf('--cdp-port', '9366'));
const GAP_MS = Number(argOf('--gap', '3000'));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

/* 极简 CDP 客户端 */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws error'))); });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 20000);
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
    return r.result && r.result.value;
  }
}

let pass = 0, fail = 0;
const fails = [];
function ck(name, cond, note = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}${note ? ' — ' + note : ''}`); }
  else { fail++; fails.push(name + (note ? ' — ' + note : '')); console.log(`  ✘ ${name}${note ? ' — ' + note : ''}`); }
}

/* 取页面上指定 label 的 KPI 数值文本。
 * 用"标签文字 → 相邻数值"的方式定位，而不是按 DOM 结构猜位置：
 * 布局调整时前者不会失效。
 *
 * ⚠ 属性选择器不能写成 [style*="font-size:11.4px"]：
 *   Vue 把 style 对象序列化成 `font-size: 11.4px;`（冒号后有空格），
 *   写成无空格版本会一条都匹配不到 —— 而且不报错，只是"什么都找不到"。
 *   实测踩过：状态条显示已连接、tick 在涨，但 6 项指标全部 undefined，
 *   看起来像"页面没渲染"，实际是选择器写错了。 */
const SNAPSHOT_JS = `(function(){
  var out = {};
  var cards = document.querySelectorAll('.card');
  for (var i=0;i<cards.length;i++){
    var lbl = cards[i].querySelector('div[style*="11.4px"]');
    var val = cards[i].querySelector('.rl-liveval') || cards[i].querySelector('div[style*="21px"]');
    if (!lbl || !val) continue;
    var k = (lbl.innerText||'').trim();
    if (!k) continue;
    out[k] = (val.innerText||'').trim();
  }
  var bar = document.querySelector('.rl-live');
  return { metrics: out, bar: bar ? (bar.innerText||'').replace(/\\s+/g,' ').trim() : '',
           cardCount: cards.length };
})()`;

(async () => {
  const profile = path.join(process.cwd(), '_ui-check', '.edge-motion-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(EDGE, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
    '--hide-scrollbars', '--mute-audio', '--no-proxy-server', '--proxy-bypass-list=*',
    '--window-size=1680,1050', 'about:blank',
  ], { stdio: 'ignore' });
  child.unref();

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(300);
    try { target = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) {}
  }
  if (!target) throw new Error('连接不上 Edge 调试端口');

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log(`\n目标：${BASE}/#/real`);
  console.log(`间隔：${GAP_MS} ms\n`);

  await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#/real` });
  /* 等到实时指标出现（最多 20 秒） */
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const s = await cdp.evaluate(SNAPSHOT_JS);
      if (s && s.metrics && Object.keys(s.metrics).length >= 4) { ready = true; break; }
    } catch (e) {}
  }
  ck('页面实时指标区已渲染', ready);

  const a = await cdp.evaluate(SNAPSHOT_JS);
  console.log('  首帧：', JSON.stringify(a.metrics));
  console.log('  状态条：', a.bar);

  /* ① 通道状态：必须显示已连接 */
  ck('实时通道显示为已连接',
    /已连接/.test(a.bar || ''), a.bar || '(空)');

  await sleep(GAP_MS);
  const b = await cdp.evaluate(SNAPSHOT_JS);
  console.log('  二帧：', JSON.stringify(b.metrics));

  /* ② 实时指标必须变化 */
  const LIVE_LABELS = ['全平台瞬时排放速率', '今日累计排放'];
  let movedCount = 0;
  for (const k of LIVE_LABELS) {
    const v1 = a.metrics[k];
    const v2 = b.metrics[k];
    const moved = v1 !== undefined && v2 !== undefined && v1 !== v2;
    if (moved) movedCount++;
    ck(`「${k}」在 ${GAP_MS / 1000} 秒内发生变化`, moved, `${v1} → ${v2}`);
  }
  ck('至少一项实时指标在动', movedCount > 0, `${movedCount}/${LIVE_LABELS.length}`);

  /* ③ 变化幅度合理性：瞬时速率是 tCO2e/s，量级应在 0.05~5 之间；
   *    若出现 0 或 1000 这种数，说明公式或单位错了。 */
  const parseNum = (s) => {
    if (!s) return NaN;
    const m = String(s).replace(/[^0-9.\-]/g, '');
    return Number(m);
  };
  const r1 = parseNum(a.metrics['全平台瞬时排放速率']);
  const r2 = parseNum(b.metrics['全平台瞬时排放速率']);
  ck('瞬时速率量级合理（0.01~10 tCO₂e/s）',
    r1 > 0.01 && r1 < 10 && r2 > 0.01 && r2 < 10, `${r1} / ${r2}`);
  if (Number.isFinite(r1) && Number.isFinite(r2) && r1 > 0) {
    const rel = Math.abs(r2 - r1) / r1;
    /* 3 秒内负荷曲线变化应在 5% 以内；超过说明在乱跳（不是确定性曲线） */
    ck('变化幅度符合负荷曲线物理预期（<5%）', rel < 0.05,
      `相对变化 ${(rel * 100).toFixed(3)}%`);
  }

  /* ④ 静态指标不得抖动 */
  const staticLabel = '真实设施台账';
  const s1 = a.metrics[staticLabel];
  const s2 = b.metrics[staticLabel];
  ck(`静态指标「${staticLabel}」保持稳定（无伪造抖动）`,
    s1 !== undefined && s1 === s2, `${s1} → ${s2}`);

  /* ⑤ 长间隔再确认一次：15 秒后仍在动（排除"只动一次就停"） */
  console.log('\n  追加长间隔观察（15 秒）…');
  const t0 = (await cdp.evaluate(SNAPSHOT_JS)).metrics['今日累计排放'];
  await sleep(15000);
  const t1 = (await cdp.evaluate(SNAPSHOT_JS)).metrics['今日累计排放'];
  ck('长间隔 15 秒后今日累计仍在增长', t0 !== t1, `${t0} → ${t1}`);
  if (Number.isFinite(parseNum(t0)) && Number.isFinite(parseNum(t1))) {
    ck('今日累计单调不减（排放不可能倒流）', parseNum(t1) >= parseNum(t0),
      `${parseNum(t0)} → ${parseNum(t1)}`);
  }

  try { child.kill('SIGKILL'); } catch (e) {}
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }, 800);

  console.log('\n' + '═'.repeat(64));
  console.log(`  运动检测：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} 项`);
  if (fails.length) fails.forEach((f) => console.log('    · ' + f));
  console.log('═'.repeat(64));

  try {
    const outDir = path.join(process.cwd(), 'tools', 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const tag = /:8899/.test(BASE) ? 'static' : 'server';
    fs.writeFileSync(path.join(outDir, `real-motion-${tag}.json`), JSON.stringify({
      generatedAt: new Date().toISOString(), base: BASE, gapMs: GAP_MS,
      pass, fail, total: pass + fail, failedItems: fails,
      frameA: a.metrics, frameB: b.metrics, statusBar: a.bar,
    }, null, 2), 'utf8');
    console.log(`  已写出：tools/out/real-motion-${tag}.json`);
  } catch (e) { /* 落盘失败不影响结论 */ }

  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n✘ 运动检测异常：', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
