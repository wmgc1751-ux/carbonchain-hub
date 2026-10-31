/**
 * firmware-interop-check.mjs —— 固件 ↔ 平台 **跨实现互操作**验证
 * ==================================================================
 * 为什么需要它（本项目最贵的一课）
 * ------------------------------------------------------------------
 * 此前验证固件用的是"把 C 算法用 JS 重写一遍，然后两边互相对"的办法，
 * 结果 7/7 全绿，但真编译一次就暴露出 5 个致命缺陷：
 *   ① mbedtls/mpi.h 这个头文件根本不存在（真名 bignum.h）→ 连编都编不过
 *   ② SM2_N 少填一组 0xFF → 取模用 n>>32 → 签名算得出但**永远验不过**
 *   ③ canon 的 a05001 用 ppm、CP 用 mg/m³ → 平台重建 canon 后必然不匹配
 *   ④ g_cfg.mn 从未赋值 → 报文 MN 为空 → 平台认不出设备
 *   ⑤ g_cfg.section_m2 从未赋值 → 截面积为 0 → 排放量恒为 0
 *   ②③④⑤ 全是"静默失败"：不崩溃、不报错、返回值正常，只是永远连不上平台。
 *   JS 镜像之所以查不到，是因为它用的是**正确**的常量与口径 —— 它验证的是"我理解的
 *   算法"，不是"我写下的代码"。
 *
 * 本脚本的做法：**让真编译器 + 真 mbedtls 跑真 C 代码产出真报文，再交给平台自己的
 * 模块（hj212.decode / deviceVerify.canonFromFrame / sm2DeviceBridge.verifyDevice）
 * 去验**。跨实现、跨语言、含负向对照。
 *
 * 用法：npm run verify:interop
 * 依赖：gcc（自动探测 WinGet 安装的 MinGW-w64）、mbedtls 源码（自动下载到 .cache/）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');                       // CarbonChainHub/
const FW = path.join(ROOT, 'hardware', 'firmware');
const CACHE = path.join(ROOT, '.cache');
const OUT_DIR = path.join(ROOT, 'tools', 'out');

const MBEDTLS_VERSION = 'mbedtls-3.6.2';
const MBEDTLS_LIBS = ['bignum', 'bignum_core', 'bignum_mod', 'bignum_mod_raw',
                      'constant_time', 'platform', 'platform_util'];

const log = (s) => console.log(s);
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const no = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

/* ---------------- 1. 找编译器 ----------------
 * ⚠ 必须区分三种情况（2026-10-24 修复，与 check-hw-syntax.mjs 同源问题）：
 *   ① 找到且可执行        → { gcc, blocked: null }
 *   ② 存在但无法执行      → { gcc: null, blocked: path }   环境策略/ACL，应判 SKIP
 *   ③ 根本不存在          → { gcc: null, blocked: null }   需要装工具链，应判 FAIL
 * 混为一谈会让人去"装 gcc"，而实际 gcc 早就装好了、只是被策略拦住。
 */
function findGcc() {
  const candidates = [];
  for (const c of [process.env.CC, process.env.GCC, 'gcc']) {
    if (c) candidates.push(c);
  }
  const base = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      if (!/WinLibs/i.test(d)) continue;
      const p = path.join(base, d, 'mingw64', 'bin', 'gcc.exe');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }

  let blockedPath = null;
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return { gcc: c, blocked: null };
    } catch (e) {
      const exists = (() => { try { return fs.existsSync(c); } catch { return false; } })();
      if (exists && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'UNKNOWN')) {
        blockedPath = c;
      }
    }
  }
  return { gcc: null, blocked: blockedPath };
}

/* ---------------- 2. 找 / 取 mbedtls 源码 ---------------- */
function findMbedtls() {
  const cands = [process.env.MBEDTLS_DIR, path.join(CACHE, MBEDTLS_VERSION)];
  for (const d of cands) {
    if (d && fs.existsSync(path.join(d, 'include', 'mbedtls', 'bignum.h'))) return d;
  }
  return null;
}

function fetchMbedtls() {
  fs.mkdirSync(CACHE, { recursive: true });
  const tar = path.join(CACHE, `${MBEDTLS_VERSION}.tar.gz`);
  const url = `https://codeload.github.com/Mbed-TLS/mbedtls/tar.gz/refs/tags/${MBEDTLS_VERSION}`;
  if (!fs.existsSync(tar)) {
    log(`  下载 mbedtls 源码（约 5 MB，仅首次）…`);
    const r = spawnSync('curl', ['-sSL', '--max-time', '600', '-o', tar, url], { stdio: 'inherit' });
    if (r.status !== 0 || !fs.existsSync(tar)) return null;
  }
  const dest = path.join(CACHE, MBEDTLS_VERSION);
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync('tar', ['xzf', tar, '-C', dest, '--strip-components=1'], { stdio: 'inherit' });
  if (r.status !== 0) return null;
  return fs.existsSync(path.join(dest, 'include', 'mbedtls', 'bignum.h')) ? dest : null;
}

/* ---------------- 3. 编 & 跑自检 ---------------- */
function buildAndRun(gcc, mb) {
  const exe = path.join(os.tmpdir(), 'cen100-selftest.exe');
  const objMain = path.join(os.tmpdir(), 'ccmain.o');
  const common = ['-std=c11', '-Wall', '-I', path.join(FW, 'src'), '-I', path.join(mb, 'include'),
                  '-I', path.join(mb, 'library')];

  // main.c 里有 main()；改名后与自检的 main 共存
  execFileSync(gcc, [...common, '-Dmain=cc_vendor_main_unused', '-c',
    path.join(FW, 'src', 'main.c'), '-o', objMain], { stdio: 'pipe' });

  const sources = ['cc_sm2.c', 'cc_hj212.c', 'cc_sensors.c', 'cc_store.c', 'cc_tamper.c']
    .map((f) => path.join(FW, 'src', f));
  sources.push(path.join(FW, 'test', 'host_stub.c'), path.join(FW, 'test', 'host_selftest.c'));
  sources.push(objMain);
  sources.push(...MBEDTLS_LIBS.map((n) => path.join(mb, 'library', `${n}.c`)));

  execFileSync(gcc, [...common, '-o', exe, ...sources, '-lm'], { stdio: 'pipe' });
  /* ⚠ 宿主机可能禁止运行临时目录下的可执行文件（Windows 应用控制 / 组策略 /
   *   杀软拦截）。必须把这种**环境限制**与「程序跑了但断言失败」区分开，
   *   否则会把环境问题误报成功能缺陷，让人去改本来没坏的代码。
   *
   *   为什么改用 spawnSync 而不是 execFileSync：
   *     execFileSync 在 checkExecSyncError 里会**重写** err.code
   *     （实测原始 'UNKNOWN' 被换成 'ETIMEDOUT' 之外的值），
   *     导致识别条件失效。spawnSync 返回原始结构：
   *       r.error.code === 'UNKNOWN'，r.status === null，r.stdout === undefined
   *     这是唯一可靠的判据。 */
  const r = spawnSync(exe, [], { encoding: 'utf8' });
  if (r.error) {
    const blocked = (r.error.code === 'UNKNOWN' || r.error.code === 'EPERM'
      || r.error.code === 'EACCES')
      && r.status === null && r.stdout == null && r.stderr == null;
    if (blocked) {
      const e = new Error(
        `HOST_EXEC_BLOCKED：宿主机拒绝执行临时文件 ${exe}`
        + `（应用控制策略/杀软拦截，错误码 ${r.error.code}）。`
        + '这是**运行环境限制**，不是固件互认逻辑缺陷。'
        + '请在允许执行临时 exe 的环境重跑，或设置 EXE_DIR 指向受信任目录。'
      );
      e.code = 'HOST_EXEC_BLOCKED';
      throw e;
    }
    /* 其他 spawn 级错误（如找不到文件）原样抛出，那是真问题 */
    throw r.error;
  }
  if (r.status !== 0) {
    /* 程序真的跑了但退出码非 0 —— 这是固件自检失败，属功能缺陷 */
    throw new Error(`固件主机自检以退出码 ${r.status} 结束：\n${r.stdout || ''}\n${r.stderr || ''}`);
  }
  return r.stdout || '';
}

/* ---------------- 4. 解析自检输出 ---------------- */
function parseOut(text) {
  const kv = {};
  const chks = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.split('\t');
    if (t[0] === 'CHK') chks.push({ pass: t[1] === 'PASS', name: t[2] });
    else if (t[0]) kv[t[0]] = t.slice(1).join('\t');
  }
  return { kv, chks };
}

/* ---------------- 5b. 独立复算 d·G + 曲线判定（BigInt，与 C 完全独立） ----------------
 * "公钥不在曲线上"是本项目最阴险的一类故障：签名算得出、报文发得出，
 * 但平台无法注册/验签。JS 侧用独立实现直接判曲线上 + 复算 d·G，可一眼定位。 */
const CP = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFFn;
const CA = 0xFFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFCn;
const CB = 0x28E9FA9E9D9F5E344D5A9E4BCF6509A7F39789F515AB8F92DDBCBD414D940E93n;
const CGX = 0x32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7n;
const CGY = 0xBC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0n;
const cmod = (x, m) => ((x % m) + m) % m;
function cinv(a, m) {
  let [r0, r1] = [cmod(a, m), m], [s0, s1] = [1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return cmod(s0, m);
}
function cadd(p1, p2) {
  if (p1 === null) return p2; if (p2 === null) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && cmod(y1 + y2, CP) === 0n) return null;
  const lam = (x1 === x2 && y1 === y2)
    ? cmod((3n * x1 * x1 + CA) * cinv(2n * y1, CP), CP)
    : cmod((y2 - y1) * cinv(x2 - x1, CP), CP);
  const x3 = cmod(lam * lam - x1 - x2, CP);
  return [x3, cmod(lam * (x1 - x3) - y1, CP)];
}
function cmul(k, pt) { let r = null, q = pt; while (k > 0n) { if (k & 1n) r = cadd(r, q); q = cadd(q, q); k >>= 1n; } return r; }
const B = (hex) => BigInt('0x' + hex);
const hx = (x) => x.toString(16).padStart(64, '0').toUpperCase();

/* ---------------- 6. 公钥 hex → SPKI PEM（与 cc_sm2_pubkey_pem 同格式） ---------------- */
const SPKI_PREFIX = '3059301306072a8648ce3d020106082a811ccf5501822d034200';
function pubHexToPem(hex) {
  const der = Buffer.from(SPKI_PREFIX + hex.toLowerCase(), 'hex');
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const evidence = { at: new Date().toISOString(), steps: [], checks: [], platform: {} };
  const push = (name, pass, note = '') => {
    evidence.checks.push({ name, pass: !!pass, note });
    (pass ? ok : no)(`${name}${note ? '  — ' + note : ''}`);
  };

  log('\n═══ CEN-100 固件 ↔ 平台 跨实现互操作验证 ═══\n');

  const found = findGcc();
  if (!found.gcc) {
    if (found.blocked) {
      no('编译器存在但无法执行：' + found.blocked);
      no('这是**运行环境限制**（ACL/应用控制策略），不是固件逻辑缺陷。');
      log('HOST_EXEC_BLOCKED');
      process.exit(3);
    }
    no('未找到 C 编译器（设 CC 环境变量或安装 MinGW-w64）');
    process.exit(2);
  }
  const gcc = found.gcc;
  log(`编译器：${gcc}`);

  let mb = findMbedtls();
  if (!mb) {
    log('未找到 mbedtls 源码，尝试获取…');
    mb = fetchMbedtls();
  }
  if (!mb) { no('mbedtls 源码不可用（可设 MBEDTLS_DIR 指向已解压的源码根）'); process.exit(2); }
  log(`mbedtls：${mb}\n`);
  evidence.steps.push({ gcc, mbedtls: mb });

  log('【1/3】真编译 + 跑固件主机自检');
  let text;
  try {
    text = buildAndRun(gcc, mb);
  } catch (err) {
    if (err && err.code === 'HOST_EXEC_BLOCKED') {
      /* 环境限制 → 退出码 3（由 verify-all 识别为 SKIP，而非 FAIL）。
       * 退出码约定：0 通过 / 1 功能失败 / 2 依赖缺失 / 3 环境限制（跳过） */
      log(`  ⊘ ${err.message}`);
      evidence.skipped = { reason: err.message, kind: 'HOST_EXEC_BLOCKED' };
      write(evidence);
      process.exit(3);
    }
    throw err;
  }
  const { kv, chks } = parseOut(text);
  for (const c of chks) push(`固件自检 · ${c.name}`, c.pass);
  if (kv.RESULT && kv.RESULT.split('\t')[0] !== 'PASS') {
    no('固件自检整体失败，后续平台侧验证跳过'); write(evidence); process.exit(1);
  }
  const frame = Buffer.from(kv.FRAME_B64 || '', 'base64').toString('utf8');
  log(`  报文：${frame.replace(/[\r\n]/g, '')}\n`);

  /* ★ 独立复算：设备公钥必须在 SM2 曲线上，且等于 priv·G */
  {
    const pub = (kv.PUB_HEX || '').toUpperCase();
    const priv = (kv.PRIV_HEX || '').toUpperCase();
    if (pub.length === 130) {
      const x = B(pub.slice(2, 66)), y = B(pub.slice(66, 130));
      push('设备公钥在 SM2 曲线上', cmod(y * y, CP) === cmod(x * x * x + CA * x + CB, CP));
    } else push('设备公钥在 SM2 曲线上', false, `len=${pub.length}`);

    for (const [tag, d] of [['d=1', 1n], ['d=2', 2n], ['d=3', 3n]]) {
      const got = (kv[`PUB_${tag.replace('d=', 'D')}`] || '').toUpperCase();
      if (!got) continue;
      const want = cmul(d, [CGX, CGY]);
      const okd = got === ('04' + hx(want[0]) + hx(want[1]));
      push(`k·G 已知答案对照 ${tag}`, okd, okd ? '' : `固件=${got.slice(0, 20)}… 期望=${('04' + hx(want[0])).slice(0, 20)}…`);
    }

    if (priv.length === 64 && pub.length === 130) {
      const w = cmul(B(priv), [CGX, CGY]);
      push('设备公钥 == priv·G（独立复算）', pub === ('04' + hx(w[0]) + hx(w[1])));
    }
  }

  log('【2/3】平台侧解码 + 重建 canon');
  /* 平台模块是 CommonJS，用 createRequire 加载（ESM 的 import 在 Windows 下
   * 不接受绝对路径，必须 file:// URL —— 这里直接绕开） */
  const require_ = createRequire(path.join(ROOT, 'tools', 'x.js'));
  const hj = require_(path.join(ROOT, 'server', 'protocol', 'hj212.js'));
  const dv = require_(path.join(ROOT, 'server', 'services', 'deviceVerify.js'));
  const bridge = require_(path.join(ROOT, 'server', 'services', 'sm2DeviceBridge.js'));

  const f = hj.decode(frame);
  push('平台能解出 HJ 212 帧', !!f && !!f.mn, `MN=${f && f.mn}`);
  push('CRC 校验通过', !!f && f.crcOk !== false, `crc=${f && (f.crc || '')}`);

  const sig = dv.extractSigFields(f.cpParsed);
  push('平台取到 SM2Sig（裸 r‖s，base64）', !!sig.sigRaw && Buffer.from(sig.sigRaw, 'base64').length === 64,
       `len=${sig.sigRaw ? Buffer.from(sig.sigRaw, 'base64').length : 0}`);
  push('平台取到 DevSeq', sig.seq != null, `seq=${sig.seq}`);
  push('平台取到 Gdev（端云互证用）', sig.gdev != null, `Gdev=${sig.gdev}`);

  const canon = dv.canonFromFrame(f, sig);
  log(`  平台重建 canon：${canon}`);
  evidence.platform = { frame: frame.replace(/[\r\n]/g, ''), canon, seq: sig.seq, gdev: sig.gdev, pubHex: kv.PUB_HEX };

  /* ★ 核心：设备**实际签名**的 canon vs 平台从报文重建的 canon，必须逐字符一致 */
  const devCanon = kv.FRAME_CANON || '';
  push('设备签名 canon == 平台重建 canon（逐字符）', devCanon === canon,
       devCanon === canon ? `len=${canon.length}` : `设备=${devCanon} / 平台=${canon}`);
  evidence.platform.devCanon = devCanon;

  log('\n【3/3】平台密码学验签（跨实现）');
  const pem = pubHexToPem(kv.PUB_HEX || '');
  evidence.platform.pubPem = pem;

  const r1 = bridge.verifyDevice(pem, canon, sig.sigRaw);
  push('平台验签设备签名（期望 STD）', r1.ok && r1.mode === 'STD', JSON.stringify(r1));
  evidence.platform.verify = r1;

  /* 负向对照：篡改 canon 一个字符，必须验不过 */
  const tampered = canon.replace(/a05001=[0-9.]+/, 'a05001=278915.796');
  const r2 = bridge.verifyDevice(pem, tampered, sig.sigRaw);
  push('阴性对照 · 篡改一字节须验签失败', !r2.ok, JSON.stringify(r2));

  /* 负向对照：篡改签名一个字节，必须验不过 */
  const badSig = Buffer.from(sig.sigRaw, 'base64');
  badSig[10] ^= 0x01;
  const r3 = bridge.verifyDevice(pem, canon, badSig.toString('base64'));
  push('阴性对照 · 篡改签名须验签失败', !r3.ok, JSON.stringify(r3));

  const passed = evidence.checks.filter((c) => c.pass).length;
  log(`\n═══ 结果：${passed}/${evidence.checks.length} 通过 ═══\n`);
  evidence.summary = { total: evidence.checks.length, passed };
  write(evidence);
  process.exit(passed === evidence.checks.length ? 0 : 1);
}

function write(evidence) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'firmware-interop-evidence.json'),
    JSON.stringify(evidence, null, 2), 'utf8');

  const L = [];
  L.push('# CEN-100 固件 ↔ 平台 跨实现互操作证据', '');
  L.push(`生成时间：${evidence.at}`, '');
  L.push(`- 编译器：\`${evidence.steps[0] ? evidence.steps[0].gcc : 'n/a'}\``);
  L.push(`- mbedtls：\`${evidence.steps[0] ? evidence.steps[0].mbedtls : 'n/a'}\``, '');
  L.push('## 逐项结果', '', '| 项 | 结果 | 备注 |', '| --- | :--: | --- |');
  for (const c of evidence.checks) L.push(`| ${c.name} | ${c.pass ? '✅' : '❌'} | ${(c.note || '').replace(/\|/g, '\\|')} |`);
  if (evidence.platform.frame) {
    L.push('', '## 报文与 canon', '', '```', evidence.platform.frame, '```', '');
    L.push('设备端签名 canon：', '', '```', evidence.platform.canon, '```', '');
    L.push(`平台验签结论：\`${JSON.stringify(evidence.platform.verify)}\``, '');
  }
  const s = evidence.summary || { total: 0, passed: 0 };
  L.push('', `**合计 ${s.passed}/${s.total} 通过**（${evidence.at}）`);
  fs.writeFileSync(path.join(OUT_DIR, 'firmware-interop-evidence.md'), L.join('\n'), 'utf8');
  log(`证据已写入 tools/out/firmware-interop-evidence.{md,json}`);
}

main().catch((e) => { no(String(e && e.stack || e)); process.exit(1); });
