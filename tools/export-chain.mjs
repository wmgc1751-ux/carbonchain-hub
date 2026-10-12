/**
 * export-chain.mjs —— 联盟链数据导出器（WP7 可核验性）
 * ==================================================================
 * 角色定位：**哑管道**（dumb pipe）。
 *   本脚本只做一件事：把链上相关表原样导出为 JSON，**不做任何计算、不做任何判定**。
 *   所有校验逻辑都在 verify-offline.mjs 中，由该脚本独立重实现，
 *   **不 require 项目的任何模块** —— 这是"第三方独立复核"成立的前提。
 *
 * 用法：
 *   node tools/export-chain.mjs                          # 导出到 tools/out/chain-export.json
 *   node tools/export-chain.mjs --out D:/tmp/chain.json
 *   node tools/export-chain.mjs --db-host 127.0.0.1 --db-user root --db-name carbon_chain
 *
 * 凭据来源优先级：命令行参数 > 环境变量 > 项目 .env
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

/* ---------- 参数与配置 ---------- */
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      a[key] = val;
    }
  }
  return a;
}

/** 极简 .env 解析（不引入 dotenv 依赖） */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(import.meta.dirname, '..');
const envFile = readEnvFile(path.join(root, '.env'));

const dbCfg = {
  host: args['db-host'] || process.env.DB_HOST || envFile.DB_HOST || '127.0.0.1',
  port: Number(args['db-port'] || process.env.DB_PORT || envFile.DB_PORT || 3306),
  user: args['db-user'] || process.env.DB_USER || envFile.DB_USER || 'root',
  password: args['db-password'] || process.env.DB_PASSWORD || envFile.DB_PASSWORD || '',
  database: args['db-name'] || process.env.DB_NAME || envFile.DB_NAME || 'carbon_chain',
};

const outPath = path.resolve(args.out || path.join(root, 'tools', 'out', 'chain-export.json'));

/* ---------- 导出 ---------- */
async function main() {
  console.log('▶ 联盟链数据导出（哑管道：仅搬运，不做任何校验）');
  console.log(`  数据源：${dbCfg.user}@${dbCfg.host}:${dbCfg.port}/${dbCfg.database}`);

  const conn = await mysql.createConnection({ ...dbCfg, timezone: 'Z', dateStrings: true });
  try {
    /* ⚠ 会话时区必须钉死为 UTC —— 这是本导出器唯一"非搬运"的动作，但必须做。
     *
     * 链内核把区块秒数按 UTC 格式化成 'YYYY-MM-DD HH:mm:ss' 字面量写库
     * （见 server/blockchain/chain.js#utcDateString 与 #syncTimeZone 的注释）。
     * 而 MySQL 的 UNIX_TIMESTAMP() 是按【会话时区】解释 DATETIME 的：
     *   · 会话时区 = +08:00 → '2026-10-11 11:50:52' 被读作 1791690652
     *   · 会话时区 = +00:00 → 同一字面量被读作 1791719452
     * 两者相差 28800 秒。区块哈希与出块签名都把 timestamp 作为输入，
     * 于是时区错一格，全链 150 个区块的哈希与签名会"看起来全部失配"，
     * 而链下绑定（不含 timestamp）却全部通过 —— 典型的假阳性。
     *
     * 因此这里与链内核保持同一约定：连接建立后立刻 SET time_zone='+00:00'。
     * 同时仍把原始 block_time 字面量一并导出，供复核方自行推导时间戳交叉验证。 */
    await conn.query("SET time_zone = '+00:00'");

    /* 区块时间用 UNIX_TIMESTAMP 取出「整数秒」。
     * 区块哈希的计算输入就是整数秒时间戳，若改用字符串时间再本地解析，
     * 会因时区/精度差异算出不同哈希 —— 这是复现失败最常见的原因。 */
    const [blocks] = await conn.query(
      `SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty,
              consensus, proposer, proposer_sig, tx_count, miner, size_bytes, mine_time,
              block_time, UNIX_TIMESTAMP(block_time) AS ts
         FROM chain_block ORDER BY block_index ASC`
    );

    const [txs] = await conn.query(
      `SELECT tx_id, tx_type, biz_no, block_index, from_address, to_address,
              payload_hash, payload_json, signature, pub_key, nonce, status,
              anchor_status, anchor_batch_no
         FROM chain_tx ORDER BY block_index ASC, id ASC`
    );

    let nodes = [];
    try {
      const [r] = await conn.query(
        'SELECT node_id, node_name, public_key, status, is_authorized, vote_weight FROM chain_node'
      );
      nodes = r;
    } catch (e) { /* 无节点表时忽略 */ }

    let batches = [];
    let leaves = [];
    try {
      const [r1] = await conn.query('SELECT * FROM anchor_batch ORDER BY id ASC');
      batches = r1;
      const [r2] = await conn.query('SELECT * FROM batch_leaf ORDER BY batch_no ASC, leaf_index ASC');
      leaves = r2;
    } catch (e) { /* 未迁移时忽略 */ }

    const payload = {
      meta: {
        exporter: 'tools/export-chain.mjs',
        exportedAt: new Date().toISOString(),
        source: `${dbCfg.user}@${dbCfg.host}:${dbCfg.port}/${dbCfg.database}`,
        note: '本文件由哑管道导出，未经任何计算或判定。校验请使用 tools/verify-offline.mjs。',
        timezone: "UTC (+00:00)",
        timezoneNote: '导出会话已 SET time_zone=\'+00:00\'，与链内核 utcDateString 约定一致；'
          + 'blocks[].ts 为该会话下 UNIX_TIMESTAMP(block_time) 的整数秒，'
          + 'blocks[].block_time 为原始 UTC 字面量，复核方可据此自行推导时间戳交叉验证。',
        counts: {
          blocks: blocks.length,
          txs: txs.length,
          nodes: nodes.length,
          batches: batches.length,
          leaves: leaves.length,
        },
      },
      blocks: blocks.map((b) => ({ ...b, ts: Number(b.ts) })),
      txs,
      nodes,
      anchorBatches: batches,
      batchLeaves: leaves,
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
    const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log(`  ✔ 区块 ${blocks.length} · 交易 ${txs.length} · 节点 ${nodes.length}`
      + ` · 批次 ${batches.length} · 叶 ${leaves.length}`);
    console.log(`  ✔ 已导出：${outPath}（${sizeKB} KB）`);
    console.log('  下一步：node tools/verify-offline.mjs --input ' + outPath);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('✘ 导出失败：', e.message);
  process.exit(1);
});
