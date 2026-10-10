/**
 * scripts/record-tour.js —— 自动录制「系统运行演示视频」
 *
 * 原理：用 Chrome DevTools Protocol 的 Page.startScreencast 抓取无头 Edge 的画面帧，
 *       再用脚本驱动浏览器走访核心业务路径（登录 → 企业端 → 链上核验 → 核查端 →
 *       监管端 → 公众大屏 → 区块链浏览器 → 防篡改实验），
 *       每帧带真实时间戳，最后交给 ffmpeg 按"变帧时长"合成 MP4。
 *
 * 页面里由脚本注入了一条字幕条与一个模拟光标，因此视频自带中文分镜说明。
 *
 * 依赖：ffmpeg（可选）。查找顺序：环境变量 FFMPEG_PATH → D:\_setup\tools\ffmpeg\ffmpeg.exe → PATH
 * 用法：node scripts/record-tour.js [--headed] [--no-encode]
 * 前置：node server/app.js 已启动
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.APP_BASE || 'http://127.0.0.1:8300';
const PORT = Number(process.env.CDP_PORT || 9335);
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'video');
const FRAMES = path.join(OUT, 'frames');
const HEADED = process.argv.includes('--headed');
const NO_ENCODE = process.argv.includes('--no-encode');
const ENCODE_ONLY = process.argv.includes('--encode-only');

/* Edge 调试用的一次性配置目录放系统临时目录，别写进 artifacts/（每个 40~50MB）。 */
const TMP_ROOT = path.join(os.tmpdir(), 'carbonchain-cdp');
let ACTIVE_PROFILE = null;
process.on('exit', () => {
  if (ACTIVE_PROFILE) { try { fs.rmSync(ACTIVE_PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

const W = 1600, H = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

async function api(pathname, method = 'GET', body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/api' + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (json.code !== 0) throw new Error(pathname + ' -> ' + json.message);
  return json.data;
}

/* ------------------------------------------------------------ CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.onEvent = null;
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method && this.onEvent) this.onEvent(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 40000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    return r.result ? r.result.value : undefined;
  }
}

/* -------------------------- 注入页面：字幕条 + 模拟光标（每次新文档都会重新注入） */
const OVERLAY = `
(function () {
  var cur = null, cap = null, capT = null, capS = null, dots = null;
  function ensure() {
    if (!document.body) return;
    if (!cap) {
      cap = document.createElement('div');
      cap.id = '__cap';
      cap.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483000;'
        + 'background:linear-gradient(180deg,rgba(4,10,20,0),rgba(4,10,20,.92) 42%);'
        + 'padding:44px 40px 26px;pointer-events:none;font-family:"Microsoft YaHei","PingFang SC",sans-serif;'
        + 'opacity:0;transition:opacity .35s ease';
      capT = document.createElement('div');
      capT.style.cssText = 'font-size:27px;font-weight:700;color:#eaf6f2;letter-spacing:.5px;'
        + 'text-shadow:0 2px 12px rgba(0,0,0,.8)';
      capS = document.createElement('div');
      capS.style.cssText = 'font-size:16.5px;color:#9fd8c8;margin-top:8px;letter-spacing:.3px;'
        + 'text-shadow:0 2px 10px rgba(0,0,0,.8)';
      cap.appendChild(capT); cap.appendChild(capS);
      document.body.appendChild(cap);
    }
    if (!cur) {
      cur = document.createElement('div');
      cur.id = '__cur';
      cur.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483001;width:22px;height:22px;'
        + 'pointer-events:none;transform:translate(420px,300px);transition:transform .45s cubic-bezier(.4,.1,.2,1);opacity:0';
      cur.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22">'
        + '<path d="M4 2 L4 20 L9.2 14.8 L12.6 22 L15.4 20.6 L12 13.6 L19 13.2 Z" '
        + 'fill="#ffffff" stroke="#0b3d3a" stroke-width="1.4"/></svg>';
      document.body.appendChild(cur);
    }
    if (!dots) {
      dots = document.createElement('div');
      dots.id = '__dots';
      dots.style.cssText = 'position:fixed;left:0;top:0;right:0;height:3px;z-index:2147483002;'
        + 'background:linear-gradient(90deg,#10b981,#38bdf8);transform-origin:0 50%;transform:scaleX(0);'
        + 'transition:transform .4s ease;pointer-events:none';
      document.body.appendChild(dots);
    }
  }
  window.__cap = function (title, sub) {
    ensure(); if (!cap) return false;
    capT.textContent = title || '';
    capS.textContent = sub || '';
    cap.style.opacity = '1';
    return true;
  };
  window.__capHide = function () { ensure(); if (cap) cap.style.opacity = '0'; };
  window.__cursor = function (x, y) {
    ensure(); if (!cur) return false;
    cur.style.opacity = '1';
    cur.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    return true;
  };
  window.__cursorHide = function () { ensure(); if (cur) cur.style.opacity = '0'; };
  window.__progress = function (p) { ensure(); if (dots) dots.style.transform = 'scaleX(' + p + ')'; };
  window.__centerOf = function (sel, text) {
    var list = Array.prototype.slice.call(document.querySelectorAll(sel));
    var el = null;
    if (text) { el = list.filter(function (n) { return (n.innerText || '').trim() === text; })[0]; }
    if (!el) el = list.filter(function (n) { return n.offsetParent !== null; })[0];
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName, label: (el.innerText || '').trim().slice(0, 20) };
  };
  /** 先把目标滚进视野中央，再返回它的视口坐标（否则长页面上的按钮点在视口外） */
  window.__scrollFind = function (sel, text) {
    var list = Array.prototype.slice.call(document.querySelectorAll(sel));
    var el = null;
    if (text) { el = list.filter(function (n) { return (n.innerText || '').trim() === text; })[0]; }
    if (!el) el = list.filter(function (n) { return n.offsetParent !== null; })[0];
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { el.scrollIntoView(); }
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (el.innerText || '').trim().slice(0, 24) };
  };
  window.__click = function (sel, text) {
    var list = Array.prototype.slice.call(document.querySelectorAll(sel));
    var el = text ? list.filter(function (n) { return (n.innerText || '').trim() === text; })[0] : null;
    if (!el) el = list.filter(function (n) { return n.offsetParent !== null; })[0];
    if (!el) return false;
    el.click();
    return true;
  };
})();
`;

/* ------------------------------------------------------------------ 走位脚本 */
/** 每一步：可选先切角色/路由，再报字幕，再等待（等待期间浏览器画面会被持续抓帧） */
const STEPS = [
  {
    cap: ['碳链通 CarbonChain Hub', '基于区块链的企业碳排放数据存证与碳配额交易平台 · 四端协同'],
    wait: 4200,
  },
  {
    route: '/login', role: null,
    cap: ['统一登录 · 一套账号体系区分四端身份', '登录页内置演示账号一键切换；这里用企业账号 ent001 真实走一遍登录'],
    wait: 3000,
    pre: async (ctx) => {
      const a = await ctx.pos('.login-card input');
      if (a) await ctx.move(a.x, a.y, 500);
      await cdp.evaluate(`(function () {
        var ins = document.querySelectorAll('.login-card input');
        var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        function type(el, v) {
          return new Promise(function (res) {
            var i = 0;
            var t = setInterval(function () {
              i++; set.call(el, v.slice(0, i));
              el.dispatchEvent(new Event('input', { bubbles: true }));
              if (i >= v.length) { clearInterval(t); res(true); }
            }, 85);
          });
        }
        return type(ins[0], 'ent001').then(function () { return type(ins[1], '123456'); });
      })()`);
      await sleep(500);
      await ctx.clickText('.login-card button', '登 录', 400);
    },
    waitAfter: 3200,
  },
  {
    role: 'ENTERPRISE', route: '/ent/overview',
    cap: ['企业端 · 碳账本总览', '年度累计排放 / 免费分配配额 / 履约缺口 / 本年度成交，右侧为企业链上钱包身份'],
    wait: 5200,
  },
  {
    route: '/ent/reports',
    cap: ['碳排放上报 · 提交即签名上链', '注意"存证"列：每张已提交的上报单都锚定了区块高度与链上交易号'],
    wait: 4600,
  },
  {
    cap: ['链上存证核验 · 一键验证四件事', 'ECDSA 验签 · 载荷哈希一致 · 链下链上一致 · Merkle 根一致'],
    wait: 2600,
    pre: async (ctx) => {
      await ctx.clickText('tbody button', '存证', 900);
    },
    post: async (ctx) => {
      const p = await ctx.pos('.mask .modal');
      if (p) await ctx.move(p.x, Math.min(p.y + 150, H - 200), 800);
    },
    waitAfter: 6400,
  },
  {
    route: '/ent/trade',
    cap: ['碳配额交易 · 价格优先、时间优先连续撮合', '支持部分成交与撤单，成交即上链存证，账实相符可审计'],
    wait: 4600,
  },
  {
    role: 'VERIFIER', route: '/ver/overview',
    cap: ['核查机构端 · 签发即定稿', '受理任务 → 核对数据 → 出具结论，报告签发后以机构私钥签名上链'],
    wait: 5000,
  },
  {
    route: '/ver/tasks',
    cap: ['核查任务队列 · 自动派单', '企业提交上报后按规则自动派单至第三方核查机构，形成核查任务'],
    wait: 4400,
  },
  {
    role: 'REGULATOR', route: '/reg/overview',
    cap: ['监管端 · 全局视图', '全市场排放总量、配额发放、成交金额、风险预警与链健康度'],
    wait: 5200,
  },
  {
    route: '/reg/alerts',
    cap: ['风险预警 · 五类情形自动监测', '配额超限 / 数据异常 / 漏报 / 价格异动 / 链上风险，处置全程留痕'],
    wait: 4600,
  },
  {
    role: null, route: '/screen',
    cap: ['公众端 · 数据公示大屏（免登录）', '碳市场不再是黑箱：任何人可查看市场运行数据与链上存证总量'],
    wait: 5400,
  },
  {
    route: '/explorer',
    cap: ['区块链浏览器 · 公开可核验', '区块列表、存证交易、交易池、地址视图与全链完整性校验'],
    wait: 4400,
  },
  {
    cap: ['防篡改实验 ①  先看正常状态', '进入浏览器时自动跑全链校验：全部区块通过，哈希链、PoW 难度、Merkle 根一致'],
    wait: 4200,
  },
  {
    cap: ['防篡改实验 ②  模拟恶意篡改', '直接改写数据库里的区块字段 —— 相当于有人端后干了一票'],
    wait: 2200,
    pre: async (ctx) => {
      await ctx.clickText('button', '模拟恶意篡改', 900);
    },
    waitAfter: 5200,
  },
  {
    cap: ['校验立即失败 · 区块哈希与记录不符', '改动一处，其后所有区块的哈希全部对不上 —— 篡改必然被察觉'],
    wait: 5200,
    pre: async (ctx) => {
      const p = await ctx.pos('.alertbar.err');
      if (p) await ctx.move(p.x, p.y, 900);
    },
    waitAfter: 1800,
  },
  {
    cap: ['防篡改实验 ③  尝试"修好"这条链', '重做 150 个区块的工作量证明需要十余秒 —— 难度越高，代价呈指数上升'],
    wait: 2200,
    pre: async (ctx) => {
      await ctx.clickText('button', '重做工作量证明并修复', 900);
    },
    waitAfter: 11000,
  },
  {
    cap: ['修复完成 · 全链恢复通过', '链下负责查、链上负责证 —— 这就是本项目把区块链用在该用的地方的方式'],
    wait: 2000,
    pre: async (ctx) => {
      const p = await ctx.pos('.alertbar.ok');
      if (p) await ctx.move(p.x, p.y, 900);
    },
    waitAfter: 5200,
  },
];

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.readdirSync(FRAMES).filter((f) => f.endsWith('.jpg')).forEach((f) => fs.unlinkSync(path.join(FRAMES, f)));

  const tokens = {}, users = {};
  const accounts = await api('/auth/demo-accounts');
  for (const a of accounts) {
    if (tokens[a.role]) continue;
    const d = await api('/auth/login', 'POST', { username: a.username, password: a.password });
    tokens[a.role] = d.token; users[a.role] = d.user;
  }
  const chain = await api('/chain/stats');
  console.log(`[i] 演示开始：链高度=${chain.height}　存证=${chain.totalTxs}`);

  /* 清理可能残留的旧浏览器实例 */
  try {
    const busy = await new Promise((resolve) => {
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = ''; ps.stdout.on('data', (d) => { out += d; }); ps.on('close', () => resolve(out.trim()));
    });
    for (const pid of busy.split(/\s+/).filter(Boolean)) { spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); await sleep(600); }
  } catch (e) { /* ignore */ }

  const profile = path.join(TMP_ROOT, 'rec-' + Date.now());
  ACTIVE_PROFILE = profile;
  const args = [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
    '--hide-scrollbars', '--mute-audio', '--no-proxy-server', '--proxy-bypass-list=*',
    `--window-size=${W},${H}`, '--force-device-scale-factor=1',
    '--disable-features=Translate,BackForwardCache', 'about:blank',
  ];
  if (HEADED) args.splice(0, 1);
  const child = spawn(EDGE, args, { stdio: 'ignore' });
  child.unref();

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(300);
    try { target = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page'); } catch (e) { /* 等端口 */ }
  }
  if (!target) throw new Error('无法连接 Edge 调试端口 ' + PORT);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('ws error'))); });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  /* 抓帧 */
  let frameSeq = 0;
  const frames = [];
  const t0 = Date.now();
  cdp.onEvent = (m) => {
    if (m.method === 'Page.screencastFrame') {
      const n = ++frameSeq;
      const f = path.join(FRAMES, 'f' + String(n).padStart(5, '0') + '.jpg');
      try { fs.writeFileSync(f, Buffer.from(m.params.data, 'base64')); } catch (e) { /* 忽略写失败 */ }
      frames.push({ file: path.basename(f), t: Date.now() - t0 });
      cdp.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
    }
  };
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  /* 巡场 */
  const ctx = {
    async pos(sel, text) {
      return cdp.evaluate(`window.__centerOf(${JSON.stringify(sel)}, ${JSON.stringify(text || '')})`);
    },
    /** 滚动到目标 → 移动光标 → 停一下 → 真实点击 */
    async clickText(sel, text, settle = 700) {
      const p = await cdp.evaluate(`window.__scrollFind(${JSON.stringify(sel)}, ${JSON.stringify(text || '')})`);
      if (!p) return null;
      await sleep(settle);
      const q = await cdp.evaluate(`window.__centerOf(${JSON.stringify(sel)}, ${JSON.stringify(text || '')})`) || p;
      await cdp.evaluate(`window.__cursor(${q.x}, ${q.y})`);
      await sleep(600);
      await cdp.evaluate(`(function () {
        var el = document.elementFromPoint(${q.x}, ${q.y});
        if (!el) return false;
        (el.closest('button,a') || el).click();
        return true;
      })()`);
      return q;
    },
    async move(x, y, ms = 450) {
      await cdp.evaluate(`window.__cursor(${x}, ${y})`);
      await sleep(ms);
    },
  };

  async function loadRoute(role, route) {
    if (role) {
      await cdp.evaluate(`(function(){
        localStorage.setItem('cch_token', ${JSON.stringify(tokens[role])});
        localStorage.setItem('cch_user', ${JSON.stringify(JSON.stringify(users[role]))});
        return true;
      })()`);
    }
    await cdp.send('Page.navigate', { url: `${BASE}/?_=${Date.now()}#${route}` });
    // 等首屏渲染完成
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const ready = await cdp.evaluate(`(function(){
          var a=document.getElementById('app');
          return a && !document.querySelector('.boot') && (a.innerText||'').length > 60;
        })()`);
        if (ready) break;
      } catch (e) { /* 导航中 */ }
    }
    await sleep(700);
  }

  // 首帧：确保 origin 可用
  await loadRoute(null, '/login');
  await cdp.evaluate(`window.__cursor(420, 300); window.__progress(0); true`).catch(() => {});

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    if (s.route || s.role) await loadRoute(s.role === undefined ? null : s.role, s.route || '/screen');
    await cdp.evaluate(`window.__progress(${((i + 1) / STEPS.length).toFixed(3)})`).catch(() => {});
    await cdp.evaluate(`window.__cap(${JSON.stringify(s.cap[0])}, ${JSON.stringify(s.cap[1])})`).catch(() => {});
    await cdp.evaluate(`window.__cursorHide && window.__cursorHide()`).catch(() => {});
    await sleep(s.wait || 3000);
    if (s.pre) { try { await s.pre(ctx); } catch (e) { /* 跳过 */ } }
    if (s.waitAfter) await sleep(s.waitAfter);
    console.log(`  ✔ 第 ${i + 1}/${STEPS.length} 幕：${s.cap[0]}　累计 ${frames.length} 帧`);
  }

  await cdp.evaluate(`window.__cap('演示结束 · 谢谢观看', '链下负责查 · 链上负责证')`).catch(() => {});
  await sleep(3200);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await sleep(400);
  try { ws.close(); } catch (e) { /* ignore */ }
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });

  /* 收干净浏览器进程与临时配置目录（每个约 40~50MB，不删就会一直堆着） */
  await sleep(900);
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    if (!fs.existsSync(profile)) break;
    await sleep(700);
  }
  if (ACTIVE_PROFILE === profile) ACTIVE_PROFILE = null;

  console.log(`\n[i] 共抓取 ${frames.length} 帧，总时长约 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

  /* 生成 concat 列表并编码 */
  await encodeVideo(frames.map((f) => ({ file: f.file, t: f.t })));
  process.exit(0);
}

/* ---------- 编码：帧序列 → MP4 ---------- */
async function encodeVideo(items) {
  if (!items.length) { console.error('✗ 没有可用帧'); return false; }

  /* concat 列表：每帧时长 = 到下一帧的真实间隔（长停留最长 6 秒）
     注意：ffmpeg 的 concat 解析器按「进程 CWD」解析相对路径，
     这里统一写绝对路径，否则会出现 "Impossible to open 'frames/xxx.jpg'"。 */
  const abs = (f) => path.resolve(FRAMES, f).replace(/\\/g, '/');
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const next = items[i + 1];
    let d = next ? (next.t - items[i].t) / 1000 : 2.0;
    d = Math.min(Math.max(d, 0.05), 6);
    lines.push(`file '${abs(items[i].file)}'`);
    lines.push('duration ' + d.toFixed(3));
  }
  lines.push(`file '${abs(items[items.length - 1].file)}'`);
  const listFile = path.join(OUT, 'frames.txt');
  fs.writeFileSync(listFile, lines.join('\n'), 'utf8');

  if (NO_ENCODE) { console.log('[i] 已跳过编码（--no-encode）'); return true; }

  /* 找 ffmpeg */
  const cands = [
    process.env.FFMPEG_PATH,
    'D:\\_setup\\tools\\ffmpeg\\ffmpeg.exe',
    'ffmpeg',
  ].filter(Boolean);
  let ff = null;
  for (const c of cands) {
    if (c === 'ffmpeg') { ff = c; break; }
    if (fs.existsSync(c)) { ff = c; break; }
  }
  const mp4 = path.join(OUT, '碳链通-系统运行演示.mp4');
  console.log('[i] 开始编码：' + ff);
  const enc = spawn(ff, [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vsync', 'vfr', '-vf', 'scale=1280:-2', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-crf', '24', '-preset', 'medium', '-movflags', '+faststart',
    mp4,
  ], { stdio: ['ignore', 'pipe', 'pipe'], cwd: OUT });
  let encErr = '';
  enc.stderr.on('data', (d) => { encErr += d.toString(); });
  const code = await new Promise((r) => enc.on('close', r));
  if (code === 0 && fs.existsSync(mp4)) {
    const mb = (fs.statSync(mp4).size / 1048576).toFixed(1);
    console.log(`\n✅ 视频已生成：${path.relative(ROOT, mp4)}（${mb} MB）`);
    return true;
  }
  console.error('\n✗ 编码失败，ffmpeg 末尾输出：\n' + encErr.split('\n').slice(-14).join('\n'));
  console.error('  帧文件已保留在 ' + FRAMES + '，可用 --encode-only 重试。');
  return false;
}

/* ---------- --encode-only：复用已抓取的帧，只重新编码 ---------- */
async function encodeOnly() {
  if (!fs.existsSync(FRAMES)) { console.error('✗ 找不到帧目录 ' + FRAMES); return false; }
  const files = fs.readdirSync(FRAMES).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  if (!files.length) { console.error('✗ 帧目录为空'); return false; }

  /* 优先从上次的 frames.txt 取回每帧真实时长，取不到则退回固定 100ms */
  const prev = path.join(OUT, 'frames.txt');
  const dur = new Map();
  if (fs.existsSync(prev)) {
    const ls = fs.readFileSync(prev, 'utf8').split('\n');
    for (let i = 0; i < ls.length; i++) {
      const m = /file '(.+?)'/.exec(ls[i]);
      const d = /^duration\s+([\d.]+)/.exec(ls[i + 1] || '');
      if (m && d) dur.set(path.basename(m[1]), Number(d[1]) * 1000);
    }
  }
  let t = 0;
  const items = files.map((f) => {
    const cur = { file: f, t };
    t += dur.has(f) ? dur.get(f) : 100;
    return cur;
  });
  console.log(`[i] 复用 ${items.length} 帧，重建 concat 列表…`);
  return encodeVideo(items);
}

if (ENCODE_ONLY) {
  encodeOnly().then((ok) => process.exit(ok ? 0 : 1));
} else {
  main().catch((e) => { console.error('录制失败：', e && e.stack || e); process.exit(1); });
}
