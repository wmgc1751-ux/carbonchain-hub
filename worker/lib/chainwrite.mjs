/**
 * worker/lib/chainwrite.mjs —— 边缘端统一链写入（appendBlock）
 * ==================================================================================
 * 让 www（Pages Functions / Worker）也能作为联盟节点向**同一条权威链**
 * （Turso 上的 chain_block / chain_tx）追加区块。此前只有小程序 Worker 具备
 * 写链能力，www 侧的业务动作（企业上报 / 核查出证 / 配额下发 / 交易成交 /
 * 清缴执行）无法上链 —— 评审演示的核心闭环断在最后一公里。
 *
 * 哈希口径与小程序、本地 Node 内核**逐字节一致**（同一公式三处实现已在
 * verify:all 与小程序自测中交叉验证）：
 *   · payload_hash = sha256(stableStringify(payload))          —— 键序规范化
 *   · tx_id        = sha256(stableStringify({bizNo,from,payloadHash,ts}))
 *   · merkle_root  = 逐层两两 sha256(左+右)，奇数补尾，空 → 64 个 0
 *   · block_hash   = sha256(index|timestamp|merkleRoot|prevHash|POA|proposer|nonce)
 *
 * 并发防线：chain_block.block_index 已建唯一索引（ux_chain_block_index）。
 * 读 tip 与落库之间若被并发写方抢先占高，batch 会撞唯一约束 —— 此处重读
 * tip 整体重算重试（与小程序 appendBlock 同一策略），绝不复用旧高度哈希。
 *
 * 签名说明（如实）：边缘写入不带 secp256k1 签名（signature/pub_key 为 NULL），
 * 私钥托管在本地 keystore 不上云。payload_hash + 块哈希链保证内容不可篡改；
 * 发起方签名的强验证由平台本地验证环境承担。此边界与小程序端一致并已在
 * 信任模型页如实声明。
 * @module worker/lib/chainwrite
 */

import { sha256Hex } from './gm.mjs';

/** 联盟节点轮值表（与小程序端、本地内核一致） */
export const PROPOSERS = ['NODE-BJ-01', 'NODE-SH-02', 'NODE-GZ-03', 'NODE-SZ-04', 'NODE-WH-05'];

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function nowStr(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function merkleRoot(hashes) {
  if (!hashes || hashes.length === 0) return '0'.repeat(64);
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256Hex(level[i] + level[i + 1]));
    level = next;
  }
  return level[0];
}

const blockHash = (b) => sha256Hex([
  Math.trunc(Number(b.index)),
  Math.trunc(Number(b.timestamp)),
  b.merkleRoot,
  b.prevHash,
  'POA',
  b.proposer,
  Math.trunc(Number(b.nonce)),
].join('|'));

/**
 * 出块：把一批业务存证写入权威链（chain_block / chain_tx）。
 * @param {object} db  makeDb 产出的数据访问面（query/one/value/run/batch）
 * @param {Array<{type:string,bizNo:string,from:string,to?:string,payload:object}>} txs
 * @returns {Promise<{height:number,hash:string,merkleRoot:string,txIds:string[]}>}
 */
export async function appendBlock(db, txs) {
  const prev = await db.one(
    'SELECT block_index AS height, block_hash AS hash FROM chain_block ORDER BY block_index DESC LIMIT 1',
  );
  let height = prev ? Number(prev.height) + 1 : 0;
  let prevHash = prev ? prev.hash : '0'.repeat(64);

  const ts = Math.floor(Date.now() / 1000);
  const label = nowStr();
  let proposer = PROPOSERS[height % PROPOSERS.length];
  const nonce = Math.floor(Math.random() * 900000) + 100000;

  const rows = [];
  const txIds = [];
  for (const t of txs) {
    const payloadHash = sha256Hex(stableStringify(t.payload ?? {}));
    const txId = sha256Hex(stableStringify({
      bizNo: t.bizNo ?? null, from: t.from ?? null, payloadHash, ts,
    }));
    txIds.push(txId);
    rows.push({
      txId, type: t.type, bizNo: t.bizNo ?? null,
      payload: JSON.stringify(t.payload ?? {}), payloadHash,
      label, from: t.from ?? null, to: t.to ?? null,
    });
  }
  const root = await merkleRoot(txIds);
  let hash = blockHash({ index: height, timestamp: ts, merkleRoot: root, prevHash, proposer, nonce });
  const sizeBytes = rows.reduce((s, r) => s + r.payload.length, 0) + 220;

  let attempt = 0;
  for (;;) {
    try {
      await db.tx([
        { sql: `INSERT INTO chain_block (block_index, block_hash, prev_hash, merkle_root, tx_count, block_time, nonce, proposer, consensus, difficulty, size_bytes)
                VALUES (?,?,?,?,?,?,?,?,'POA',0,?)`,
          params: [height, hash, prevHash, root, rows.length, label, nonce, proposer, sizeBytes] },
        ...rows.map((r) => ({
          sql: `INSERT INTO chain_tx (tx_id, block_index, tx_type, biz_no, payload_json, payload_hash, created_at, from_address, to_address, status, anchor_status)
                VALUES (?,?,?,?,?,?,?,?,?,'CONFIRMED','PENDING')`,
          params: [r.txId, height, r.type, r.bizNo, r.payload, r.payloadHash, r.label, r.from, r.to],
        })),
      ]);
      break;
    } catch (e) {
      const msg = String(e && e.message || e);
      const isConflict = /UNIQUE|constraint/i.test(msg) && /chain_block|block_index/i.test(msg);
      if (!isConflict || ++attempt > 3) throw e;
      const fresh = await db.one(
        'SELECT block_index AS height, block_hash AS hash FROM chain_block ORDER BY block_index DESC LIMIT 1',
      );
      height = Number(fresh.height) + 1;
      prevHash = fresh.hash;
      proposer = PROPOSERS[height % PROPOSERS.length];
      hash = blockHash({ index: height, timestamp: ts, merkleRoot: root, prevHash, proposer, nonce });
    }
  }

  /* 新块已落库 → 读缓存全部作废，保证"写后读"立即看到新高度 */
  purgeReadCaches();

  /* 联盟节点副本同步：主链新增区块后，各成员节点的链副本必须跟上。
   * 早期没有任何自动同步机制，每出一块副本就落后一格 —— 累积到 45 块时，
   * 论文里"副本一致 5/5"的结论就不成立了。这里在出块后顺带补齐，
   * 单次写入成本可忽略（一次 INSERT...SELECT，与块内交易数无关）。 */
  try {
    await db.run(
      `INSERT INTO chain_node_replica (node_id, block_index, block_hash, synced_at)
       SELECT n.node_id, ?, ?, CURRENT_TIMESTAMP FROM chain_node n
        WHERE n.is_authorized = 1 OR n.status = 'ACTIVE'`,
      [height, hash]);
    await db.run(
      'UPDATE chain_node SET replica_height = ?, replica_tip = ? WHERE is_authorized = 1 OR status = ?',
      [height, hash, 'ACTIVE']);
  } catch { /* 副本同步失败不影响主链写入；/consortium/replica 会如实报告落后 */ }

  return { height, hash, merkleRoot: root, txIds, ts: label };
}

/**
 * 便捷锚点：单笔存证即出一个块（与本地 anchorSvc.anchor 语义对齐）。
 * @returns {Promise<{txId:string, blockIndex:number, blockHash:string, payloadHash:string}>}
 */
export async function anchor(db, p) {
  const r = await appendBlock(db, [{
    type: p.txType, bizNo: p.bizNo || null, from: p.fromAddress || 'did:cc:regulator:system',
    to: p.toAddress || null, payload: p.payload || {},
  }]);
  return {
    txId: r.txIds[0], blockIndex: r.height, blockHash: r.hash,
    payloadHash: sha256Hex(stableStringify(p.payload || {})), blockTime: r.ts,
  };
}

/** 业务单号：与本地 crypto-utils.bizNo 同格式（前缀+时间戳+随机 3 位） */
export function bizNo(prefix) {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
    + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  return `${prefix}${stamp}${Math.floor(Math.random() * 9000) + 1000}`;
}

/**
 * 出块后清空读缓存。
 * ------------------------------------------------------------------
 * index.mjs 的进程内缓存与边缘缓存都以 URL 为键、按路径给 TTL
 * （/api/chain/stats 是 60s）。写入新块后若不清，紧接着的"写后读"
 * 会拿到旧高度 —— 用户看到"提交成功 #779"，而链概况仍显示 #776，
 * 看起来像链没更新。写是低频操作，整表清空成本可忽略。
 *
 * 这里通过一个全局钩子注册（Worker 与 Pages Functions 同进程），
 * 避免 chainwrite 反向依赖 index.mjs 造成循环引用。
 */
let _purgeHook = null;
export function registerCachePurge(fn) { _purgeHook = typeof fn === 'function' ? fn : null; }
function purgeReadCaches() {
  try { if (_purgeHook) _purgeHook(); } catch { /* 清缓存失败不影响写入 */ }
}
