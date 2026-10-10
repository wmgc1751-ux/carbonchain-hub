/**
 * export-sql.js —— 把当前数据库导出为可交付的 SQL 脚本
 *
 * 产出（与 db/ 目录中已有文件同名，直接覆盖）：
 *   db/02_seed_data.sql   仅数据（INSERT，含已生成的区块与存证交易）
 *   db/03_full_backup.sql 结构 + 数据（可直接整库导入还原）
 *
 * 说明：使用 mysqldump 的 --result-file 直接写文件，避免经由管道导致中文乱码。
 *
 * 用法：node server/scripts/export-sql.js
 * 可配置：环境变量 MYSQL_BIN 指定 MySQL 的 bin 目录（未加入 PATH 时需要）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../config');

const ROOT = path.join(__dirname, '..', '..');

/** 依次尝试：MYSQL_BIN 环境变量 → PATH → 常见安装位置 */
function findMysqldump() {
  const exe = process.platform === 'win32' ? 'mysqldump.exe' : 'mysqldump';
  const cands = [];
  if (process.env.MYSQL_BIN) cands.push(path.join(process.env.MYSQL_BIN, exe));
  cands.push(
    'D:\\MySQL\\mysql-8.0.29-winx64\\bin\\' + exe,
    'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\' + exe,
    'C:\\xampp\\mysql\\bin\\' + exe,
    exe, // 交给 PATH
  );
  for (const c of cands) {
    if (c === exe) return c;
    if (fs.existsSync(c)) return c;
  }
  return exe;
}

const db = config.db || {};
const host = db.host || '127.0.0.1';
const port = db.port || 3306;
const user = db.user || 'root';
const password = db.password || '';
const database = db.database || 'carbon_chain';

const dump = findMysqldump();
console.log(`[i] 使用 ${dump}`);
console.log(`[i] 连接 ${user}@${host}:${port} → ${database}`);

const common = [
  `-h${host}`, `-P${port}`, `-u${user}`, `-p${password}`,
  '--default-character-set=utf8mb4',
  '--single-transaction', '--skip-add-locks', '--set-gtid-purged=OFF', '--no-tablespaces',
];

const jobs = [
  {
    file: path.join(ROOT, 'db', '02_seed_data.sql'),
    args: [...common, '--no-create-info', '--skip-comments'],
    desc: '仅数据（INSERT）',
  },
  {
    file: path.join(ROOT, 'db', '03_full_backup.sql'),
    args: [...common, '--skip-comments'],
    desc: '结构 + 数据（完整备份）',
  },
];

let failed = 0;
for (const job of jobs) {
  const args = [...job.args, `--result-file=${job.file}`, database];
  const r = spawnSync(dump, args, { encoding: 'utf8' });
  const ok = r.status === 0 && fs.existsSync(job.file);
  if (ok) {
    const kb = (fs.statSync(job.file).size / 1024).toFixed(0);
    const inserts = (fs.readFileSync(job.file, 'utf8').match(/INSERT INTO/g) || []).length;
    console.log(`  ✔ ${path.relative(ROOT, job.file)}  ${job.desc}  ${kb} KB，${inserts} 组 INSERT`);
  } else {
    failed++;
    console.log(`  ✘ ${path.relative(ROOT, job.file)} 导出失败`);
    if (r.stderr) console.log('    ' + String(r.stderr).split('\n').slice(-4).join('\n    '));
  }
}

if (failed) {
  console.log('\n提示：若提示找不到 mysqldump，请设置环境变量 MYSQL_BIN 指向 MySQL 的 bin 目录，例如：');
  console.log('  set MYSQL_BIN=D:\\MySQL\\mysql-8.0.29-winx64\\bin');
  process.exit(1);
}
console.log('\n✅ 导出完成。');
