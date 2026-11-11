/**
 * 脱敏防回流守卫（事项 4）
 *
 * 背景：tools/ 下的抓取脚本（fetch-hb-*.mjs、ingest-ljgk.mjs、ingest-hb-*.cjs）
 * 已把企业名与排污单位 ID 换成脱敏值，但接口仍指向真实平台。若有人把标识还原成
 * 真值再运行，真名会直接写回数据库与文档。
 *
 * 用法一（推荐，零改动）：用包装器运行任何抓取脚本
 *   node tools/guarded-run.mjs tools/fetch-hb-history.mjs
 *   包装器会先扫描目标脚本及其同目录引用，命中真实标识则直接退出码 1，不发起任何请求。
 *
 * 用法二（自查）：单独跑一次扫描
 *   node tools/guarded-run.mjs --scan-only
 *
 * 用法三（代码内）：import { assertClean } from './leak-guard.mjs'; assertClean(import.meta.url)
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 真实企业标识（名称 / 统一社会信用代码 / 认证机构）。脱敏环境下一律不应出现。
 *
 * ⚠ 2026-11-01 交付复检：模式清单**不能硬编码在本文件里** —— 守卫本身成了泄漏源，
 *   交付包（含源码仓库）里堂而皇之写着 9 条真实标识，等于把脱敏白做了。
 *   现改为从仓库外部的模式文件读取（默认在脱敏备份目录，不随交付分发）。
 *
 * 安全默认：模式文件缺失时**拒绝放行**（exit 2），而不是静默跳过 ——
 *   守卫失效却报告"干净"，比没有守卫更危险。
 */
const PATTERN_FILE = process.env.CC_LEAK_FILE
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '_carbonchain-sensitive-backup-20261101', 'leak-patterns.json');

let REAL_LEAK = null;
let PATTERN_SOURCE = null;
try {
  if (existsSync(PATTERN_FILE)) {
    const j = JSON.parse(readFileSync(PATTERN_FILE, 'utf8'));
    const pats = (j.patterns || []).filter((s) => typeof s === 'string' && s.trim());
    if (pats.length) { REAL_LEAK = new RegExp(pats.join('|')); PATTERN_SOURCE = PATTERN_FILE; }
  }
} catch { REAL_LEAK = null; }

/** 模式未加载时的统一处置：出实情报错，绝不假装通过。 */
export function requirePatterns() {
  if (!REAL_LEAK) {
    console.error('✘ 防回流模式清单未加载，守卫无法工作。');
    console.error(`   期望路径：${PATTERN_FILE}`);
    console.error('   可用环境变量 CC_LEAK_FILE 指定，或从脱敏备份目录恢复该文件。');
    process.exit(2);
  }
  return PATTERN_SOURCE;
}

/** 扫描单个文件，返回命中行号（空数组 = 干净）。文件不存在返回 null。 */
export function scanFile(file) {
  requirePatterns();          // 模式缺失时直接失败，不返回"干净"
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (REAL_LEAK.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 200) });
  });
  return hits;
}

/**
 * 断言一组文件不含真实标识；命中则打印并 exit(1)。
 * @param {string[]} files 绝对路径列表
 * @param {string} [label] 报错时的场景说明
 */
export function assertClean(files, label = '脱敏环境') {
  let bad = 0;
  for (const f of files) {
    const hits = scanFile(f);
    if (!hits) continue;
    if (hits.length) {
      bad += hits.length;
      console.error(`\n[leak-guard] 命中真实标识：${path.basename(f)}`);
      for (const h of hits) console.error(`  L${h.line}: ${h.text}`);
    }
  }
  if (bad) {
    console.error(
      `\n[leak-guard] 共 ${bad} 处命中。${label}禁止继续执行。\n` +
        '  请先把企业名 / 统一社会信用代码 / 认证机构替换回脱敏值；\n' +
        '  替换规则见 D:/workspace/Challenge Cup/_脱敏对照表-保留/replace-rules.txt',
    );
    process.exit(1);
  }
  return true;
}

/** 从模块 URL 反查自身路径（供 import 方直接调用）。 */
export function selfPath(metaUrl) {
  return fileURLToPath(metaUrl);
}
