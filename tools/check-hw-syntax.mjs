/**
 * check-hw-syntax.mjs —— ESP-IDF 移植层（cc_hw_esp32.c）的 PC 侧语法/类型检查
 * ==================================================================
 * 本机没有 xtensa 工具链，`idf.py build` 真编译无法在 PC 上做。
 * 本脚本用 MinGW-w64 gcc 对 cc_hw_esp32.c 做 `-fsyntax-only` 检查，
 * 头文件来自 `tools/esp-stub/` —— 按 **ESP-IDF v5.x 真实 API 签名**伪造的最小头集。
 *
 * 能查到的：拼写错误、函数签名不匹配、类型错误、未使用变量等编译期问题。
 * 查不到的：运行时行为、桩头与真 IDF 的签名漂移。
 * ⚠ 结论口径（如实声明）：桩头检查通过 ≠ 真机编译通过；板卡到货后仍须
 *   `idf.py build` 才算"真编译"。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'hardware', 'firmware', 'src');
const TARGET = path.join(SRC, 'cc_hw_esp32.c');

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const no = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

/**
 * 找可用编译器。
 *
 * ⚠ 返回值分三种情况，调用方必须区分（2026-10-24 修复）：
 *   { gcc: 'path' }            —— 找到且能执行
 *   { gcc: null, blocked: p }  —— 文件存在但**无法执行**（环境策略/ACL）
 *   { gcc: null, blocked: null}—— 根本不存在
 *
 * 为什么必须区分：此前把两种情况都当"未找到"并以 exit 2 退出，
 * 虽然后来 verify-all 把 exit 2 当 FAIL，但环境策略拦截与"没装编译器"
 * 是两件完全不同的事 —— 前者应在别的机器上重跑，后者需要装工具链。
 * 混在一起会让人去检查"要不要装 gcc"，而实际 gcc 已经装好了。
 */
function findGcc() {
  const candidates = [];
  for (const c of [process.env.CC, process.env.GCC, 'gcc']) {
    if (c) candidates.push(c);
  }
  /* WinGet 目录里的 mingw64 gcc */
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
      /* EACCES / EPERM / UNKNOWN 且文件存在 ⇒ 被策略拦，记下来 */
      const exists = (() => { try { return fs.existsSync(c); } catch { return false; } })();
      if (exists && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'UNKNOWN')) {
        blockedPath = c;
      }
    }
  }
  return { gcc: null, blocked: blockedPath };
}

function main() {
  console.log('\n═══ cc_hw_esp32.c 桩头语法检查（ESP-IDF v5.x API 签名） ═══\n');
  const found = findGcc();
  if (!found.gcc) {
    if (found.blocked) {
      /* 环境限制 → 退出码 3（verify-all 判 SKIP，不判 FAIL） */
      no(`编译器存在但无法执行：${found.blocked}`);
      no('这是**运行环境限制**（ACL/应用控制策略），不是语法缺陷。');
      no('请在允许执行该二进制的环境重跑，或设置 CC 指向可用编译器。');
      console.log('HOST_EXEC_BLOCKED');
      process.exit(3);
    }
    no('未找到 C 编译器');
    process.exit(2);
  }
  const gcc = found.gcc;
  console.log(`编译器：${gcc}`);

  const args = ['-fsyntax-only', '-std=gnu11', '-Wall', '-Wextra', '-Werror',
    '-DESP_PLATFORM=1',
    '-I', path.join(ROOT, 'tools', 'esp-stub'),
    '-I', SRC, TARGET];
  try {
    execFileSync(gcc, args, { stdio: 'pipe' });
  } catch (e) {
    /* 同样要区分"编译器跑不起来"与"代码有语法错" */
    const blocked = e && e.status === null && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'UNKNOWN');
    if (blocked) {
      no('编译器在执行阶段被拦截（环境限制，非语法缺陷）');
      console.log('HOST_EXEC_BLOCKED');
      process.exit(3);
    }
    no('语法/类型检查失败：');
    console.log(String(e.stderr || e.message));
    process.exit(1);
  }
  ok('cc_hw_esp32.c 通过桩头语法/类型检查（-Wall -Wextra -Werror）');
  console.log('\n（这只说明"能编过签名"，真机验证仍以 idf.py build 为准。）\n');
}

main();
