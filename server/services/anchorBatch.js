/**
 * anchorBatch.js —— 批量锚定服务（WP3 链内核规模化）
 * ==================================================================
 * 解决什么问题
 * ------------------------------------------------------------------
 * 逐笔上链在"每 60 秒一批 CEMS 采数 × 数千家企业"的工业场景下会线性膨胀：
 *   1 笔存证 = 1 笔交易 = 1 个区块 → 链高度与链上索引表同速增长。
 * 批量锚定把**时间窗内的 N 笔业务存证组织成一棵 Merkle 树**，只把「根」
 * 作为 1 笔锚点交易上链。于是：
 *   链上锚点数量 : 业务存证数量 = 1 : N
 * 而**单笔存证的可验证性不下降** —— 任何一笔都能用 O(log N) 的 Merkle
 * 证明路径独立证明"它确实属于这个锚点"，无需信任服务端重新枚举全表。
 *
 * 与「链下重算绑定」的关系（两道机制互补，不可互相替代）
 * ------------------------------------------------------------------
 *   ⑤ 链下重算绑定  ——证明"这笔存证的链下明文与链上锚定摘要一致"（防内容替换）
 *   批量锚定        ——证明"这笔存证确实被某次上链的根覆盖"（防事后补录）
 * 少了批量锚定，链上只有边界但无法低成本枚举归属；少了第五道校验，
 * 统一个根也可能覆盖一份已被篡改的明文。二者共同构成存证可信的完整闭环。
 *
 * ⚠ 中间态语义（必须显式声明，否则会成为新的歧义源）
 * ------------------------------------------------------------------
 *   PENDING  该笔存证已确认入链（block_index 非空），但尚未被批量锚定。
 *            → 已固化，锚定强度 = 「区块级」
 *   BATCHED  已被选入某批次，批次正在构建中（事务内的瞬时态）。
 *   ANCHORED 已被某个批次的 Merkle 根覆盖。→ 已固化，锚定强度 = 「批次级」
 *   SELF     该笔交易自身就是锚点交易，不参与被锚定。
 * 对外查询口径：以上状态的数据**均为已固化**，区别只在锚定强度；
 * 界面与文档必须同时标注该语义，禁止把 PENDING 描述为"未上链"。
 *
 * @module services/anchorBatch
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const anchorSvc = require('./anchor');

/** 锚定算法标识（写入批次记录，便于未来算法升级时区分历史批次） */
const ANCHOR_ALGO = 'SHA256-MERKLE-1';

/** 单批次默认叶上限（避免单次事务过大） */
const DEFAULT_LIMIT = 500;

/* ==================================================================
 * 一、批次构建
 * ================================================================== */

/**
 * 把当前待锚定的存证聚合为一个批次，并只上链 1 笔锚点交易。
 *
 * 并发安全：先用事务把候选存证原子地置为 BATCHED（阻止并发批次重复选取），
 * 再在事务外构建 Merkle 树并上链；上链失败则回滚状态为 PENDING。
 *
 * @param {object} opts { limit?:number, actor?:string }
 * @returns {Promise<object>} 批次摘要；无可锚定存证时 { created:false, reason }
 */
async function createBatch(opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_LIMIT, 1), 2000);
  const actor = opts.actor || 'regulator:system';

  /* --- ① 事务内：锁定并占位候选存证 --- */
  /* ⚠ 走账本事务：chain_tx 在独立账本库里，业务池只有只读视图。
   * 视图上 FOR UPDATE 会被 MySQL 拒绝，必须用实体表加锁。 */
  const picked = await db.ledgerTx(async (conn) => {
    const [rows] = await conn.query(
      `SELECT tx_id, payload_hash, block_index, created_at
         FROM chain_tx
        WHERE anchor_status = 'PENDING'
          AND block_index IS NOT NULL
          AND tx_type <> 'ANCHOR_BATCH'
        ORDER BY block_index ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE`
    );
    if (!rows.length) return null;
    const ids = rows.map((r) => r.tx_id);
    await conn.query(
      `UPDATE chain_tx SET anchor_status = 'BATCHED' WHERE tx_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    return rows;
  });

  if (!picked) {
    return {
      created: false,
      reason: 'NO_PENDING_TX',
      hint: '当前没有待锚定的存证。若刚初始化数据库，请先执行 npm run initdb。',
    };
  }

  const leafTxIds = picked.map((r) => r.tx_id);
  const merkleRoot = cu.merkleRoot(leafTxIds);
  const windowFrom = new Date(picked[0].created_at);
  const windowTo = new Date(picked[picked.length - 1].created_at);
  const batchNo = cu.bizNo('AB');

  try {
    /* --- ② 写入批次记录 --- */
    await db.query(
      `INSERT INTO anchor_batch
         (batch_no, leaf_count, merkle_root, algo, window_from, window_to)
       VALUES (?,?,?,?,?,?)`,
      [batchNo, leafTxIds.length, merkleRoot, ANCHOR_ALGO, windowFrom, windowTo]
    );

    /* --- ③ 写入叶节点（批量插入） --- */
    const cols = 'batch_no, leaf_index, tx_id, payload_hash, block_index';
    const CHUNK = 250;
    for (let i = 0; i < picked.length; i += CHUNK) {
      const slice = picked.slice(i, i + CHUNK);
      const ph = slice.map(() => '(?,?,?,?,?)').join(',');
      const params = slice.flatMap((r, j) => [
        batchNo, i + j, r.tx_id, r.payload_hash, r.block_index,
      ]);
      await db.query(`INSERT INTO batch_leaf (${cols}) VALUES ${ph}`, params);
    }

    /* --- ④ 只上链 1 笔锚点交易 ---
     * 锚点交易的 payload 就是批次的「公共承诺」：批次号 + 叶数 + 根 + 时间窗 + 算法。
     * 它自身也受第五道「链下重算绑定」保护 —— 若有人改根，锚点交易立即失配。 */
    const anchored = await anchorSvc.anchor({
      txType: 'ANCHOR_BATCH',
      bizNo: batchNo,
      fromLabel: actor,
      payload: {
        batchNo,
        leafCount: leafTxIds.length,
        merkleRoot,
        algo: ANCHOR_ALGO,
        windowFrom: windowFrom.toISOString(),
        windowTo: windowTo.toISOString(),
        leafDigest: cu.sha256(leafTxIds.join('|')), // 叶序承诺：叶序本身也被锚定
      },
    });

    /* --- ⑤ 回写批次与存证状态 --- */
    await db.query(
      'UPDATE anchor_batch SET anchor_tx_id = ?, anchor_block_index = ? WHERE batch_no = ?',
      [anchored.txId, anchored.blockIndex, batchNo]
    );
    for (let i = 0; i < leafTxIds.length; i += CHUNK) {
      const slice = leafTxIds.slice(i, i + CHUNK);
      await db.ledgerQuery(
        `UPDATE chain_tx SET anchor_status = 'ANCHORED', anchor_batch_no = ?
          WHERE tx_id IN (${slice.map(() => '?').join(',')})`,
        [batchNo, ...slice]
      );
    }
    /* 锚点交易自身不参与被锚定，标为 SELF，避免被后续批次重复收编 */
    await db.ledgerQuery(
      "UPDATE chain_tx SET anchor_status = 'SELF', anchor_batch_no = ? WHERE tx_id = ?",
      [batchNo, anchored.txId]
    );

    return {
      created: true,
      batchNo,
      leafCount: leafTxIds.length,
      merkleRoot,
      algo: ANCHOR_ALGO,
      windowFrom,
      windowTo,
      anchorTxId: anchored.txId,
      anchorBlockIndex: anchored.blockIndex,
      anchorBlockHash: anchored.blockHash,
      /** 关键指标：本批 N 笔存证只消耗 1 个链上锚点 */
      chainAnchorCost: 1,
      compressionRatio: `${leafTxIds.length}:1`,
    };
  } catch (e) {
    /* 上链或写库失败 → 把占位状态回滚为 PENDING，保证存证不被"卡死" */
    try {
      await db.ledgerQuery(
        `UPDATE chain_tx SET anchor_status = 'PENDING'
          WHERE anchor_status = 'BATCHED' AND tx_id IN (${leafTxIds.map(() => '?').join(',')})`,
        leafTxIds
      );
      await db.query('DELETE FROM batch_leaf WHERE batch_no = ?', [batchNo]);
      await db.query('DELETE FROM anchor_batch WHERE batch_no = ?', [batchNo]);
    } catch (e2) {
      console.error('[anchorBatch] 回滚失败：', e2.message);
    }
    throw e;
  }
}

/* ==================================================================
 * 二、查询与证明
 * ================================================================== */

function mapBatch(r) {
  return {
    id: Number(r.id),
    batchNo: r.batch_no,
    leafCount: Number(r.leaf_count),
    merkleRoot: r.merkle_root,
    algo: r.algo,
    anchorTxId: r.anchor_tx_id,
    anchorBlockIndex: r.anchor_block_index == null ? null : Number(r.anchor_block_index),
    windowFrom: r.window_from,
    windowTo: r.window_to,
    createdAt: r.created_at,
  };
}

/** 批次列表（倒序） */
async function listBatches(page = {}) {
  const p = await db.paginate(
    `SELECT b.*, (SELECT COUNT(*) FROM batch_leaf l WHERE l.batch_no = b.batch_no) AS leaf_actual
       FROM anchor_batch b
      ORDER BY b.id DESC`,
    [],
    page
  );
  return { ...p, rows: p.rows.map((r) => ({ ...mapBatch(r), leafActual: Number(r.leaf_actual) })) };
}

/** 单批次详情（含全部叶） */
async function getBatch(batchNo) {
  const row = await db.one('SELECT * FROM anchor_batch WHERE batch_no = ?', [batchNo]);
  if (!row) return null;
  const leaves = await db.query(
    'SELECT leaf_index, tx_id, payload_hash, block_index FROM batch_leaf WHERE batch_no = ? ORDER BY leaf_index ASC',
    [batchNo]
  );
  return {
    ...mapBatch(row),
    leaves: leaves.map((l) => ({
      leafIndex: Number(l.leaf_index),
      txId: l.tx_id,
      payloadHash: l.payload_hash,
      blockIndex: l.block_index == null ? null : Number(l.block_index),
    })),
  };
}

/**
 * 生成某笔存证的 Merkle 存在性证明路径。
 * 第三方只需 (txId, leafIndex, path, merkleRoot) 四样东西，
 * 即可用 O(log N) 次哈希独立验证该存证确实属于该批次 —— 无需信任服务端。
 */
async function getProof(batchNo, txId) {
  const row = await db.one(
    'SELECT leaf_index FROM batch_leaf WHERE batch_no = ? AND tx_id = ?', [batchNo, txId]
  );
  if (!row) return { found: false, reason: 'TX_NOT_IN_BATCH' };
  const leaves = await db.query(
    'SELECT tx_id FROM batch_leaf WHERE batch_no = ? ORDER BY leaf_index ASC', [batchNo]
  );
  const hashes = leaves.map((l) => l.tx_id);
  const index = Number(row.leaf_index);
  const { root, path } = cu.merkleProof(hashes, index);
  const stored = await db.one('SELECT merkle_root FROM anchor_batch WHERE batch_no = ?', [batchNo]);
  return {
    found: true,
    batchNo,
    txId,
    leafIndex: index,
    leafCount: hashes.length,
    merkleRoot: root,
    merkleRootStored: stored ? stored.merkle_root : null,
    /** 自证：即时重算的根必须等于批次登记的根 */
    rootConsistent: !stored || stored.merkle_root === root,
    path,
    verifyHint: '把 leafHash=txId 与 path 依次哈希，结果必须等于 merkleRoot',
  };
}

/** 锚定统计（供运维与验收使用） */
async function stats() {
  /* 链表在账本库（可能是独立实例），必须走 ledgerQuery —— 走业务池会 ER_NO_SUCH_TABLE */
  const rows = await db.ledgerQuery(
    'SELECT anchor_status, COUNT(*) AS n FROM chain_tx GROUP BY anchor_status'
  );
  const dist = {};
  rows.forEach((r) => { dist[r.anchor_status] = Number(r.n); });
  const b = await db.one(
    'SELECT COUNT(*) AS batches, COALESCE(SUM(leaf_count),0) AS leaves, COALESCE(AVG(leaf_count),0) AS avgLeaves FROM anchor_batch'
  );
  const pending = dist.PENDING || 0;
  const anchored = dist.ANCHORED || 0;
  const selfTx = dist.SELF || 0;
  const total = pending + anchored + selfTx + (dist.BATCHED || 0);
  return {
    tx: { total, pending, anchored, self: selfTx, batched: dist.BATCHED || 0 },
    batch: {
      count: Number(b.batches),
      leavesTotal: Number(b.leaves),
      avgLeafCount: +Number(b.avgLeaves).toFixed(2),
    },
    /** 锚定压缩比 = 被锚定的存证数 / 消耗的锚点交易数 */
    compressionRatio: selfTx > 0 ? +((anchored + selfTx) / selfTx).toFixed(2) : null,
    anchorAlgo: ANCHOR_ALGO,
    semantics: {
      PENDING: '已确认入链，尚未被批量锚定（锚定强度：区块级）',
      BATCHED: '已选入批次，构建中（瞬时态）',
      ANCHORED: '已被批次 Merkle 根覆盖（锚定强度：批次级）',
      SELF: '该交易自身即锚点交易',
    },
  };
}

module.exports = {
  ANCHOR_ALGO,
  createBatch,
  listBatches,
  getBatch,
  getProof,
  stats,
};
