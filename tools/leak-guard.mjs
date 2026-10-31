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

/** 真实企业标识（名称 / 统一社会信用代码 / 认证机构）。脱敏环境下一律不应出现。 */
export const REAL_LEAK = new RegExp(
  [
    '河北恒能（保定）',
    '河北恒能（涞水）',
    '中节能\\(保定\\)',
    '中节能\\(涞水\\)',
    '保定瑞丰环保',
    '保定易州恒新',
    '91130605MA0H2K7L3R',
    '91130607MA0N8T5Q2W',
    '华信联合',
  ].join('|'),
);

/** 扫描单个文件，返回命中行号（空数组 = 干净）。文件不存在返回 null。 */
export function scanFile(file) {
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
        '  替换规则见 D:/workspace/_carbonchain-sensitive-backup-20261101/replace-rules.txt',
    );
    process.exit(1);
  }
  return true;
}

/** 从模块 URL 反查自身路径（供 import 方直接调用）。 */
export function selfPath(metaUrl) {
  return fileURLToPath(metaUrl);
}
