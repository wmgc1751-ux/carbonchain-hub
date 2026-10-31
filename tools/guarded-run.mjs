/**
 * 抓取脚本包装器（事项 4）：跑之前先做脱敏防回流检查。
 *
 *   node tools/guarded-run.mjs tools/fetch-hb-history.mjs [原有参数...]
 *   node tools/guarded-run.mjs --scan-only        # 只扫描，不执行
 *
 * 检查范围：目标脚本本身 + 同目录下所有 fetch- 与 ingest- 开头的脚本（抓取链路常互相 import）。
 * 任一命中真实企业标识 → 退出码 1，且不会发起任何网络请求。
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertClean } from './leak-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

/** 待检文件：整个 tools 目录下的脚本（不含 node_modules），范围小、扫描快。 */
function collect() {
  const out = [];
  for (const name of readdirSync(HERE)) {
    if (!/\.(mjs|cjs|js)$/.test(name)) continue;
    if (name === 'guarded-run.mjs' || name === 'leak-guard.mjs') continue;
    out.push(path.join(HERE, name));
  }
  return out;
}

const files = collect();
const scanOnly = argv[0] === '--scan-only';

console.log(`[leak-guard] 扫描 ${files.length} 个脚本…`);
assertClean(files, '抓取脚本');
console.log('[leak-guard] 未发现真实标识，允许执行。');

if (scanOnly) process.exit(0);

const target = argv[0];
if (!target) {
  console.error('用法: node tools/guarded-run.mjs <脚本路径> [参数...]');
  process.exit(2);
}

const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
const hits = files.filter((f) => path.resolve(f) === path.resolve(abs));
if (!hits.length && !/\.(mjs|cjs|js)$/.test(abs)) {
  console.error(`[leak-guard] 目标不是可执行脚本: ${abs}`);
  process.exit(2);
}

// 把剩余参数透传给目标脚本
process.argv = [process.argv[0], abs, ...argv.slice(1)];
await import(pathToFileURL(abs).href);
