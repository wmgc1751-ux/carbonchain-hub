#!/usr/bin/env node
/**
 * gen-build-info.mjs —— 部署时生成构建信息（CCD 检查修复轮：builtAt 静态戳问题）
 * ----------------------------------------------------------------------------------
 * 原问题：worker/index.mjs 里 builtAt 硬编码 '2026-10-24'，部署多少次都不变，
 * 运维无法从 /api/health 判断线上到底是哪个版本。
 *
 * 本脚本在每次部署前生成 worker/lib/buildInfo.generated.mjs（已 gitignore，
 * 仓库内保留一份默认占位以保证新 clone 可构建），内容取自 git 提交与当前时间。
 * package.json 的 deploy:pages / deploy 已前置调用本脚本。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'worker', 'lib', 'buildInfo.generated.mjs');

function git(args, fallback) {
  try { return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return fallback; }
}

const sha = git('rev-parse --short=9 HEAD', 'unknown');
const branch = git('rev-parse --abbrev-ref HEAD', 'unknown');
const builtAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const content = `/**
 * 构建信息 —— 由 tools/gen-build-info.mjs 在部署前自动生成（勿手工编辑）。
 * gitignore 之外的这份占位保证新 clone 可构建；真实值随每次部署刷新。
 */
export const BUILD_INFO = {
  version: '2.0.0-worker',
  builtAt: '${builtAt}',
  gitSha: '${sha}',
  gitBranch: '${branch}',
};
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, content, 'utf8');
console.log(`✔ build info generated: sha=${sha} branch=${branch} builtAt=${builtAt}`);
