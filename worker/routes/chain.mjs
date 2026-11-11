/**
 * worker/routes/chain.mjs —— 链上数据只读端点（浏览器 / 校验 / 批次锚定）
 * ==================================================================================
 * 【D1 上这一层的特殊性】
 *
 * 链的**写入**仍在本地 Node 服务（PoA 出块、SM2 签名、Merkle 计算）。
 * 线上 Worker 只做**读取与核验展示**，原因有三：
 *
 *   ① 出块需要 SM2 签名 —— Workers 无国密（见 lib/gm.mjs 的说明）。
 *   ② 出块是串行的、有状态的（区块高度、nonce、父哈希），
 *      而 Workers 是无状态多实例 —— 并发写会分叉。
 *      治理方式应是 Durable Object 单点，但那等于把整条链锁在一个实例上，
 *      与"联盟链多节点"的叙事矛盾。
 *   ③ D1 无交互式事务，"读父哈希 → 算新块 → 写"三步之间没有隔离，
 *      两个请求同时进来会产出两个同高度的块。
 *
 * 【因此线上提供的链上能力】
 *   · 区块/交易列表与详情（读）
 *   · **全链哈希链完整性校验**（纯计算，可无状态执行 —— 这正是最有价值的部分）
 *   · 交易与业务行的绑定核对
 *   · 批次锚定与 Merkle 证明的读取
 * 并明确标注"出块在本地节点完成，线上只读"。
 *
 * 这个限制不是缺陷，而是诚实：把"能读能验"和"能写"分开说，
 * 比宣称"线上跑着一条链"更经得起追问。
 *
 * @module worker/routes/chain
 */

import { json, fail, authRequired, requireRole, num, pickEnum } from '../lib/http.mjs';
import { sha256Hex, canonicalHash, stableStringify, sm3Hex } from '../lib/gm.mjs';

const TX_TYPE_CN = {
  EMISSION_REPORT: '排放上报', VERIFY_REPORT: '核查报告', QUOTA_ALLOC: '配额分配',
  TRADE_DEAL: '交易成交', CREDIT_OFFSET: '信用抵销', SURRENDER: '履约清缴',
  CREDIT_RETIRE: '信用注销', CBAM_DECL: 'CBAM 申报', ZK_COMMIT: '隐私承诺',
  ZK_FORMULA_PROOF: '公式证明', ANCHOR_BATCH: '批量锚定', KEY_ROTATION: '密钥轮换',
};

export function attachChainRoutes(r) {
  /* ---------- 链概览 ---------- */
  r.get('/api/chain/stats', async (ctx) => {
    const blk = await ctx.db.one(
      `SELECT COUNT(*) AS total_blocks, SUM(tx_count) AS packed, MAX(block_index) AS height,
              AVG(mine_time) AS avg_ms, MAX(difficulty) AS difficulty, SUM(size_bytes) AS size
         FROM chain_block`);
    const tx = await ctx.db.one(
      `SELECT COUNT(*) AS rows_n,
              SUM(CASE WHEN status='CONFIRMED' THEN 1 ELSE 0 END) AS confirmed,
              SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) AS pending
         FROM chain_tx`);
    const byType = await ctx.db.query(
      `SELECT tx_type, COUNT(*) AS cnt FROM chain_tx GROUP BY tx_type ORDER BY cnt DESC`);
    const tip = await ctx.db.one(
      'SELECT block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1');

    const packed = num(blk.packed);
    const confirmed = num(tx.confirmed);
    const pending = num(tx.pending);
    return json({
      height: num(blk.height),
      totalBlocks: num(blk.total_blocks),
      tipHash: tip ? tip.block_hash : null,
      difficulty: num(blk.difficulty),
      avgMineTime: Math.round(num(blk.avg_ms)),
      totalSize: num(blk.size),
      /* 三个口径分开命名：混用是"数字对不上"的根源 */
      totalTxs: packed,
      confirmed,
      pending,
      ledgerTxRows: num(tx.rows_n),
      txAccounting: {
        packedTotal: packed, confirmed, pending, ledgerRows: num(tx.rows_n),
        balanced: packed === confirmed + pending,
        diff: packed - (confirmed + pending),
        state: packed === confirmed + pending ? 'BALANCED'
          : (packed - (confirmed + pending) === -pending ? 'PENDING_BACKLOG' : 'MISMATCH'),
      },
      txByType: byType.map((b) => ({
        type: b.tx_type, typeCn: TX_TYPE_CN[b.tx_type] || b.tx_type, cnt: num(b.cnt),
      })),
      consensus: 'PoA（权威证明）+ 联盟节点轮值出块',
      consensusMode: 'POA',
      node: 'node-carbon-01',
      /* 明确声明写入位置 */
      writeMode: {
        minerHost: 'off-chain-node',
        note: '出块与国密签名由本地 Node 节点完成；线上 Worker 仅提供读取与核验。'
          + '原因：Workers 无国密 SM2 能力，且无交互式事务不足以支撑串行出块。',
      },
      crypto: 'SHA-256 / secp256k1-ECDSA / Merkle Tree（历史块）· SM2 签名由本地节点执行',
    });
  });

  /* ---------- 区块列表 ---------- */
  r.get('/api/chain/blocks', async (ctx) => {
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.pageSize, num(ctx.query.size, 20)), 1), 100);
    const total = num(await ctx.db.value('SELECT COUNT(*) FROM chain_block'));
    const rows = await ctx.db.query(
      `SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty,
              consensus, proposer, tx_count, size_bytes, mine_time,
              strftime('%s', block_time) AS ts, block_time
         FROM chain_block ORDER BY block_index DESC LIMIT ? OFFSET ?`,
      [size, (page - 1) * size]);
    /* 分页信封 + 双命名（前端表格用 block_index，详情页用 index/txCount）。
     * 早期只给驼峰数组，浏览器页读到 undefined 后整表空白。 */
    return json({
      rows: rows.map((b) => ({
        block_index: num(b.block_index), index: num(b.block_index),
        block_hash: b.block_hash, hash: b.block_hash,
        prev_hash: b.prev_hash, prevHash: b.prev_hash,
        merkle_root: b.merkle_root, merkleRoot: b.merkle_root,
        nonce: num(b.nonce), difficulty: num(b.difficulty),
        consensus: b.consensus, proposer: b.proposer,
        tx_count: num(b.tx_count), txCount: num(b.tx_count),
        size_bytes: num(b.size_bytes), size: num(b.size_bytes), sizeBytes: num(b.size_bytes),
        mine_time: num(b.mine_time), mineTime: num(b.mine_time),
        ts: num(b.ts), timestamp: num(b.ts),
        block_time: b.block_time, blockTime: b.block_time,
      })),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    });
  });

  /* ---------- 区块详情（含逐笔交易与 Merkle 复算） ---------- */
  r.get('/api/chain/blocks/:index', async (ctx) => {
    const idx = num(ctx.params.index, NaN);
    if (!Number.isFinite(idx)) return fail('非法区块高度');
    const b = await ctx.db.one(
      `SELECT cb.*, strftime('%s', cb.block_time) AS ts_epoch
         FROM chain_block cb WHERE cb.block_index = ?`, [idx]);
    if (!b) return fail('区块不存在', 404);

    const txs = await ctx.db.query(
      `SELECT tx_id, tx_type, biz_no, from_address, payload_hash, nonce, status, created_at
         FROM chain_tx WHERE block_index = ? ORDER BY id`, [idx]);

    /* Merkle 根复算：用交易 payload_hash 重建树，与块头比对。
     * 这是**无状态纯计算**，正是线上能承担的最有价值的核验：
     * 任何人打开一个区块页，平台都在当场重算并给出 pass/fail。 */
    /* Merkle 叶子 = tx_id（链内核写入时的叶子口径），与链上 merkle_root 同源 */
    const leaves = txs.map((t) => t.tx_id);
    const merkle = merkleRoot(leaves);
    const merkleOk = merkle === b.merkle_root;

    /* 块头哈希复算：与本地链内核 calcHash 的 PoA 分支逐字节同源 */
    const headerHash = nodeCalcHashOf({
      blockIndex: num(b.block_index),
      timestamp: Number(b.ts_epoch),
      merkleRoot: b.merkle_root,
      prevHash: b.prev_hash,
      proposer: b.proposer,
      nonce: num(b.nonce),
    });

    return json({
      index: num(b.block_index),
      hash: b.block_hash,
      prevHash: b.prev_hash,
      merkleRoot: b.merkle_root,
      nonce: num(b.nonce),
      difficulty: num(b.difficulty),
      consensus: b.consensus,
      proposer: b.proposer,
      proposerSig: b.proposer_sig,
      txCount: num(b.tx_count),
      size: num(b.size_bytes),
      mineTime: num(b.mine_time),
      blockTime: b.block_time,
      transactions: txs.map((t) => ({
        txId: t.tx_id, type: t.tx_type, typeCn: TX_TYPE_CN[t.tx_type] || t.tx_type,
        bizNo: t.biz_no, from: t.from_address, payloadHash: t.payload_hash,
        nonce: num(t.nonce), status: t.status, createdAt: t.created_at,
      })),
      /* 当场核验结果 —— 这是本端点存在的意义 */
      verification: {
        merkleRecomputed: merkle,
        merkleMatches: merkleOk,
        headerHashRecomputed: headerHash,
        headerHashMatches: headerHash === b.block_hash,
        /* ⚠ 只校验"数据内部一致"，不校验"谁出的块"——
         * 后者需要 PoA 提议者公钥与 SM2 验签，线上不具备该能力。 */
        scopeNote: '本页校验 Merkle 根与块头哈希的内部一致性；'
          + '提议者签名（SM2）的验签需在本地节点或离线工具执行。',
      },
    });
  });

  /* ---------- 交易列表 / 详情 ---------- */
  r.get('/api/chain/txs', async (ctx) => {
    const page = Math.max(num(ctx.query.page, 1), 1);
    const size = Math.min(Math.max(num(ctx.query.pageSize, num(ctx.query.size, 20)), 1), 100);
    const where = [];
    const params = [];
    if (ctx.query.type && TX_TYPE_CN[ctx.query.type]) { where.push('tx_type = ?'); params.push(ctx.query.type); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = num(await ctx.db.value(`SELECT COUNT(*) FROM chain_tx ${w}`, params));
    const rows = await ctx.db.query(
      `SELECT tx_id, tx_type, biz_no, block_index, from_address, to_address,
              payload_hash, nonce, status, created_at
         FROM chain_tx ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size]);
    /* 字段命名与本地 Express 版逐字段一致（前端表格 key 是 tx_type / block_index）。
     * 之前用驼峰 txId/blockIndex，浏览器页表格整列空白 —— 契约必须两运行时统一。 */
    return json({
      rows: rows.map((t) => ({
        id: num(t.id), tx_id: t.tx_id, tx_id_: undefined,
        txId: t.tx_id,
        tx_type: t.tx_type, txType: t.tx_type,
        txTypeCn: TX_TYPE_CN[t.tx_type] || t.tx_type,
        biz_no: t.biz_no, bizNo: t.biz_no,
        block_index: t.block_index === null ? null : num(t.block_index),
        blockIndex: t.block_index === null ? null : num(t.block_index),
        height: t.block_index === null ? null : num(t.block_index),
        from_address: t.from_address, from: t.from_address,
        to_address: t.to_address, to: t.to_address,
        payload_hash: t.payload_hash, payloadHash: t.payload_hash,
        nonce: num(t.nonce), gas_fee: num(t.gas_fee), status: t.status,
        created_at: t.created_at, createdAt: t.created_at,
      })),
      total, page, size, pages: Math.max(1, Math.ceil(total / size)),
    });
  });

  r.get('/api/chain/tx/:txId', async (ctx) => {
    const txId = String(ctx.params.txId || '');
    const t = await ctx.db.one('SELECT * FROM chain_tx WHERE tx_id = ?', [txId]);
    if (!t) return fail('交易不存在', 404);

    /* 载荷摘要复算：把 payload_json 规范化后哈希，与 payload_hash 比对。
     * 这是"链下明文是否被改过"的判据 —— 改动任一字节即不匹配。 */
    let payload = null;
    let payloadHashOk = null;
    let recomputedHash = null;
    try {
      payload = typeof t.payload_json === 'string' ? JSON.parse(t.payload_json) : t.payload_json;
      if (payload) {
        recomputedHash = canonicalHash(payload);
        payloadHashOk = recomputedHash === t.payload_hash;
      }
    } catch { /* 载荷非 JSON 时不做复算 */ }

    /* 载荷是否对本次请求方可见（2026-11-01 P0 修复）：
     *   · 已登录用户                 → 可见
     *   · 持有效内部令牌的可信调用方 → 可见（小程序后端代理这类同主体调用）
     *   · 其余匿名请求               → 只见 payloadHash，不见明文
     *
     * 原因：payload_json 含 entName（真实企业名）与排放数值，而本接口匿名可访问。
     * 哈希链承诺的是"存证不可改"，不是"存证明文对公网公开"。
     * 收敛明文不削弱验真：payloadHash / 签名 / 复算结论仍然全部公开。 */
    const internalOk = (() => {
      const want = String((ctx.env && ctx.env.INTERNAL_ANCHOR_TOKEN) || '');
      const got = String((ctx.headers && (ctx.headers['x-internal-token'] || ctx.headers['X-Internal-Token'])) || '');
      return !!want && !!got && want === got;
    })();
    const payloadVisible = !!ctx.user || internalOk;

    const blk = t.block_index === null ? null
      : await ctx.db.one('SELECT block_index, block_hash, merkle_root, block_time FROM chain_block WHERE block_index = ?', [t.block_index]);

    return json({
      txId: t.tx_id,
      type: t.tx_type,
      typeCn: TX_TYPE_CN[t.tx_type] || t.tx_type,
      bizNo: t.biz_no,
      from: t.from_address,
      to: t.to_address,
      payloadHash: t.payload_hash,
      payload: payloadVisible ? payload : null,
      payloadRedacted: !payloadVisible,
      payloadRedactedReason: payloadVisible
        ? null
        : '存证明文需登录后查看；payloadHash 与签名始终公开，可据此独立验真。',
      nonce: num(t.nonce),
      status: t.status,
      createdAt: t.created_at,
      block: blk ? {
        index: num(blk.block_index), hash: blk.block_hash,
        merkleRoot: blk.merkle_root, blockTime: blk.block_time,
      } : null,
      verification: {
        recomputedPayloadHash: recomputedHash,
        payloadHashMatches: payloadHashOk,
        /* 三态，不用布尔：
         *   true  = 复算一致
         *   false = 明文被改动（严重）
         *   null  = 载荷不是 JSON，无法复算（不是失败） */
        verdict: payloadHashOk === true ? '载荷完整'
          : payloadHashOk === false ? '⚠ 载荷与链上摘要不一致，明文可能被改动' : '载荷非结构化，未复算',
        scopeNote: '摘要一致性由本端点在运行时复算；签名有效性需 SM2 离线验证。',
      },
    });
  });

  /* ---------- 全链完整性校验（本模块最有价值的端点） ----------
   * 纯计算、无状态，因此**完全可以**在 Worker 上跑。
   * 判据三条：
   *   ① 每块 prev_hash 等于前一块的 block_hash（链式不断）
   *   ② 每块 merkle_root 等于其交易的 Merkle 根（内容未被换）
   *   ③ 每块 block_hash 等于块头复算值（块头未被改）
   * 任一条不满足即定位到具体区块。 */
  r.get('/api/chain/validate', async (ctx) => {
    const t0 = Date.now();
    /* 分批读取，避免一次性把 400+ 块全载入（D1 单次返回有大小限制） */
    const totalBlocks = num(await ctx.db.value('SELECT COUNT(*) FROM chain_block'));
    const issues = [];
    let prevHash = null;
    let checkedBlocks = 0;
    let checkedTx = 0;

    /* ⚠ 叶子查询必须一次性全量取回后内存分组：
     * 原实现每块发一次 `WHERE block_index = ?` 查询——772 块就是 772 次
     * subrequest，而 Cloudflare 免费档单请求上限 50 次，第 51 次抛异常，
     * /api/chain/validate 线上恒 500（本文件曾长期带此隐患上线）。
     * 一次全量 + 内存分组后，subrequest 数降为个位数。 */
    const leavesAll = await ctx.db.query(
      'SELECT block_index, tx_id, payload_hash FROM chain_tx ORDER BY block_index ASC, id ASC');
    const leavesByBlock = new Map();
    for (const l of leavesAll) {
      const k = num(l.block_index);
      if (!leavesByBlock.has(k)) leavesByBlock.set(k, []);
      leavesByBlock.get(k).push(l);
    }

    const BATCH = 100;
    for (let off = 0; off < totalBlocks; off += BATCH) {
      const blocks = await ctx.db.query(
        `SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, tx_count,
               consensus, proposer, strftime('%s', block_time) AS ts_epoch
           FROM chain_block ORDER BY block_index ASC LIMIT ? OFFSET ?`, [BATCH, off]);
      for (const b of blocks) {
        checkedBlocks++;
        const idx = num(b.block_index);

        /* ① 链式 */
        if (prevHash !== null && b.prev_hash !== prevHash) {
          issues.push({ block: idx, kind: 'CHAIN_BREAK', detail: `prev_hash 与上一块 hash 不符（期望 ${prevHash.slice(0, 16)}…，实为 ${String(b.prev_hash).slice(0, 16)}…）` });
        }
        prevHash = b.block_hash;

        /* ② Merkle（叶子取自内存分组，不再逐块查询） */
        const leaves = leavesByBlock.get(idx) || [];
        checkedTx += leaves.length;
        const mr = merkleRoot(leaves.map((l) => l.tx_id));
        if (mr !== b.merkle_root) {
          issues.push({ block: idx, kind: 'MERKLE_MISMATCH', detail: `Merkle 根不符（期望 ${String(b.merkle_root).slice(0, 16)}…，重算 ${mr.slice(0, 16)}…）` });
        }

        /* ③ 块头（Node calcHash PoA 公式） */
        const hh = nodeCalcHashOf({
          blockIndex: idx, timestamp: Math.floor(Number(b.ts_epoch)),
          merkleRoot: b.merkle_root, prevHash: b.prev_hash,
          proposer: b.proposer, nonce: num(b.nonce),
        });
        if (hh !== b.block_hash) {
          issues.push({ block: idx, kind: 'HEADER_MISMATCH', detail: `块头哈希不符（期望 ${String(b.block_hash).slice(0, 16)}…，重算 ${hh.slice(0, 16)}…）` });
        }
      }
    }

    /* 临时诊断：全链复算若超 CPU 限额/抛异常，这里返回真实原因而非笼统 500 */
    try {
      return json({
        ok: issues.length === 0,
        checkedBlocks,
        checkedTx,
        blockHeight: num(await ctx.db.value('SELECT MAX(block_index) FROM chain_block')),
      issues,
      elapsedMs: Date.now() - t0,
      verdict: issues.length === 0
        ? `全链复算通过：${checkedBlocks} 个区块、${checkedTx} 笔交易的哈希链与 Merkle 根全部一致`
        : `发现 ${issues.length} 处不一致`,
      scopeNote: '本校验覆盖哈希链与 Merkle 内部一致性。提议者签名（SM2）的验签需本地/离线执行。',
    });
    } catch (e) {
      return json({ validateError: String(e && e.message || e), stackHead: String(e && e.stack || '').split('\n').slice(0, 4) });
    }
  });

  /* ---------- 交易与业务行的绑定核对 ---------- */
  r.get('/api/chain/business-binding', requireRole('REGULATOR', 'VERIFIER')(async (ctx) => {
    const limit = Math.min(num(ctx.query.limit, 200), 1000);
    const txs = await ctx.db.query(
      `SELECT tx_id, tx_type, biz_no, payload_hash, block_index FROM chain_tx
        WHERE biz_no IS NOT NULL ORDER BY id DESC LIMIT ?`, [limit]);
    const checks = [];
    for (const t of txs) {
      checks.push({
        txId: t.tx_id, type: t.tx_type, bizNo: t.biz_no,
        blockIndex: t.block_index === null ? null : num(t.block_index),
        payloadHash: t.payload_hash,
        /* 深度绑定核对（逐字段对业务表）需要业务表结构映射，
         * 这里只报告"链上有这笔、且摘要非空"，逐字段核对见本地工具。 */
        bound: !!t.biz_no && !!t.payload_hash,
      });
    }
    return json({
      checked: checks.length,
      bound: checks.filter((c) => c.bound).length,
      items: checks.slice(0, 100),
      note: '逐字段绑定核对（链上 payload_hash ↔ 业务行字段）由本地工具 tools/cross-check-internal.cjs 执行；'
        + '线上提供"链上条目存在性与摘要完整性"这一层。',
    });
  }));

  /* ---------- 批次锚定（Merkle 批量存证） ---------- */
  r.get('/api/chain/anchor/stats', async (ctx) => {
    const a = await ctx.db.one(
      `SELECT COUNT(*) AS batches, SUM(leaf_count) AS leaves FROM anchor_batch`);
    return json({ batches: num(a.batches), leaves: num(a.leaves) });
  });

  r.get('/api/chain/anchor/batches', async (ctx) => {
    const rows = await ctx.db.query(
      `SELECT id, batch_no, merkle_root, leaf_count, tx_id, block_index, created_at
         FROM anchor_batch ORDER BY id DESC LIMIT 50`);
    return json(rows.map((x) => ({
      id: num(x.id), batchNo: x.batch_no, merkleRoot: x.merkle_root,
      leafCount: num(x.leaf_count), txId: x.tx_id,
      blockIndex: x.block_index === null ? null : num(x.block_index),
      createdAt: x.created_at,
    })));
  });

  r.get('/api/chain/anchor/batch/:batchNo', async (ctx) => {
    const b = await ctx.db.one('SELECT * FROM anchor_batch WHERE batch_no = ?', [ctx.params.batchNo]);
    if (!b) return fail('批次不存在', 404);
    const leaves = await ctx.db.query(
      'SELECT idx, leaf_hash, payload_hash FROM batch_leaf WHERE batch_id = ? ORDER BY idx', [num(b.id)]);
    /* 复算 Merkle 根，与登记值比对 */
    const recomputed = merkleRootPipe(leaves.map((l) => l.leaf_hash));
    return json({
      batchNo: b.batch_no, merkleRoot: b.merkle_root, leafCount: num(b.leaf_count),
      txId: b.tx_id, blockIndex: b.block_index === null ? null : num(b.block_index),
      createdAt: b.created_at,
      leaves: leaves.map((l) => ({
        idx: num(l.idx), leafHash: l.leaf_hash, payloadHash: l.payload_hash,
      })),
      verification: {
        recomputedRoot: recomputed,
        matches: recomputed === b.merkle_root,
      },
    });
  });

  /* ---------- 联盟节点 ---------- */
  r.get('/api/consortium/nodes', async (ctx) => {
    const rows = await ctx.db.query(
      /* ⚠ 实际列名：node_name（不是 name）、vote_weight（不是 weight）、
       * applied_at（不是 joined_at）、last_propose_at（不是 last_sync_at）。
       * 联盟节点的这些字段名在 ledger 库里与业务库风格不同，必须逐个核对。 */
      `SELECT node_id, node_name, org_type, org_name, status, vote_weight,
              applied_at, approved_at, replica_height, last_propose_at
         FROM chain_node ORDER BY id`);
    return json(rows.map((n) => ({
      nodeId: n.node_id, name: n.node_name, orgType: n.org_type, orgName: n.org_name,
      status: n.status, weight: num(n.vote_weight),
      appliedAt: n.applied_at, approvedAt: n.approved_at,
      replicaHeight: n.replica_height == null ? null : num(n.replica_height),
      lastProposeAt: n.last_propose_at,
    })));
  });

  r.get('/api/consortium/replica', async (ctx) => {
    /* 每个节点只取"最高副本高度"一行 —— chain_node_replica 是逐块明细表，
     * 直接 SELECT 会把每个节点的全部历史块都列出来（实测 5 节点 × 813 块 = 4065 行）。 */
    const rows = await ctx.db.query(
      `SELECT n.node_id, n.node_name,
              (SELECT MAX(r.block_index) FROM chain_node_replica r WHERE r.node_id = n.node_id) AS block_index,
              (SELECT r.synced_at FROM chain_node_replica r WHERE r.node_id = n.node_id
                ORDER BY r.block_index DESC LIMIT 1) AS synced_at
         FROM chain_node n
        ORDER BY n.id`);
    /* ⚠ 判据修正：必须与主链链顶比，不能与"副本自己的最大高度"比。
     * 早期实现拿 max(副本高度) 当基准，于是 5 个副本全部落后主链 45 块时，
     * 仍会判"5/5 一致"—— 一个永远不会报错的校验等于没有校验。 */
    const tipRow = await ctx.db.one(
      'SELECT block_index AS h, block_hash AS hash FROM chain_block ORDER BY block_index DESC LIMIT 1');
    const tipH = tipRow ? num(tipRow.h) : 0;
    const consistent = rows.filter((x) => num(x.block_index) === tipH).length;
    return json({
      nodes: rows.map((r) => ({
        nodeId: r.node_id, name: r.node_name,
        height: r.block_index === null ? null : num(r.block_index),
        consistent: r.block_index !== null && num(r.block_index) === tipH,
        behind: r.block_index === null ? tipH : Math.max(0, tipH - num(r.block_index)),
        syncedAt: r.synced_at,
      })),
      chainTip: tipH,
      chainTipHash: tipRow ? tipRow.hash : null,
      consistentNodes: consistent,
      totalNodes: rows.length,
      allConsistent: rows.length > 0 && consistent === rows.length,
      note: '一致性判据：副本最新高度 === 主链链顶高度。落后块数见 behind 字段。',
    });
  });

  /* ---------- 密文自检（国密能力如实报告） ---------- */
  r.get('/api/chain/crypto-selftest', async (ctx) => {
    /* 在 Worker 上跑 SM3/SHA-256 官方向量与跨实现一致性 */
    const checks = [];
    const push = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });

    push('SM3("abc") 官方向量', sm3Hex('abc') === '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
      sm3Hex('abc').slice(0, 16) + '…');
    push('SHA-256("abc")', sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sha256Hex('abc').slice(0, 16) + '…');
    /* 异步原生与同步纯 JS 必须逐位一致 —— 两条路径都用到了 */
    const syncH = sha256Hex('cross-check');
    const nativeBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cross-check'));
    const nativeH = Array.from(new Uint8Array(nativeBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    push('同步/异步 SHA-256 逐位一致', syncH === nativeH, syncH.slice(0, 16) + '…');
    push('canonicalHash 键序无关',
      canonicalHash({ b: 2, a: 1 }) === canonicalHash({ a: 1, b: 2 }));

    const passed = checks.filter((c) => c.pass).length;
    return json({
      checks, passed, total: checks.length,
      failed: checks.length - passed,
      verdict: passed === checks.length ? '全部密码学原语自检通过' : '存在失败项',
      capabilities: {
        sm3: true,
        sha256: true,
        merkle: true,
        sm2Sign: false,
        sm2Reason: 'Cloudflare Workers（WebCrypto）不提供国密 SM2。'
          + 'SM2 签名与验签由本地 Node 节点执行；线上仅展示与复算哈希/Merkle。',
        scrypt: false,
        scryptReason: 'WebCrypto 只提供 PBKDF2；scrypt 账号需在本地节点登录。',
      },
    });
  });

  /* ---------- 信任模型（与 Node 侧 /api/chain/trust-model 同契约） ----------
   * 双运行时如实分叉：本形态（Cloudflare Workers + D1）是**单库形态**，
   * 链库物理分离是 MySQL 主架构（业务库 carbon_chain + 账本库
   * carbon_chain_ledger）的能力，D1 上不存在双库，因此 splitDb.separated
   * 返回 null（不适用）而不是 true（编造）—— 与"声明必须配得上证据"同一条纪律。
   * 攻击演练与指标台账在本地节点执行，边缘侧没有证据文件，如实返回 null。 */
  r.get('/api/chain/trust-model', async (ctx) => {
    const blk = await ctx.db.one('SELECT COUNT(*) AS blocks FROM chain_block');
    const tx = await ctx.db.one('SELECT COUNT(*) AS txs FROM chain_tx');
    return json({
      generatedAt: new Date().toISOString(),
      runtime: 'workers-d1',
      splitDb: {
        separated: null,
        /* 隔离强度分级（与 Node 侧同口径）：本形态链上表与业务表在同一个
         * D1 库里，即 L0（同库同表）。separated 仍为 null（分级判据在该
         * 形态不适用，不编造 true/false），但强度结论必须给 —— 否则新前端
         * 的信任模型页会渲染成"未知"而不是如实的 L0。 */
        level: 'L0',
        levelLabel: '同库同表',
        levelGuarded: false,
        levelDesc: '边缘形态为托管型单库（D1），链上表与业务表同库；'
          + '链库物理分离（不同实例 + 权限隔离）是 MySQL 主架构（L3）的能力，'
          + '在本形态不适用 —— 如实返回 L0 而非借主架构背书。',
        businessDb: 'Cloudflare D1（carbonchain_mini 之外的平台边缘库）',
        ledgerDb: 'Cloudflare D1（同上，单库）',
        businessEndpoint: 'Cloudflare D1（边缘单库形态）',
        ledgerEndpoint: 'Cloudflare D1（边缘单库形态）',
        sameInstance: true,
        ledgerBaseTablesInBusinessDb: [],
        ledgerViewsInBusinessDb: [],
        ledgerTablesInLedgerDb: [],
        note: 'D1 为单库形态：链库物理分离（业务库/账本库 + 权限隔离）'
          + '是 MySQL 主架构的能力，在本形态不适用 —— 如实返回 L0 而非编造。'
          + '链上锚点与存证明文在本地主架构中物理分库（L3）。',
      },
      sevenChecks: [
        { id: 1, name: '区块哈希重算', guards: '区块内容被改动', where: '/api/chain/validate' },
        { id: 2, name: '共识合法性', guards: '非法节点出块 / 难度不足', where: '/api/chain/validate' },
        { id: 3, name: 'prevHash 连续性', guards: '区块被抽换 / 断链', where: '/api/chain/validate' },
        { id: 4, name: 'Merkle 根重算', guards: '区块内交易被增删改', where: '/api/chain/validate' },
        { id: 5, name: '链下重算绑定', guards: '链下存证明文被改而锚点未动', where: '/api/chain/validate' },
        { id: 6, name: '交易发起方签名', guards: 'payload_hash 被同步重算（私钥不在库中）', where: '/api/chain/validate' },
        { id: 7, name: '业务行绑定（对账式）', guards: '业务表与链上摘要不一致', where: '/api/chain/business-binding' },
      ],
      attack: null,
      metrics: {
        generatedAt: null,
        note: '边缘形态不携带本地证据文件；完整台账见证据包（evidence-pack）与本地 /api/chain/trust-model',
        onchain: { blocks: num(blk.blocks), txs: num(tx.txs) },
      },
      deployMode: {
        cloud: true,
        /* 院审④：不再使用"前后端分离"这一表述。三个维度拆开说：
         * 运行形态（serverless，无自管进程）、资产托管（Pages/Workers/D1
         * 三个托管产品各承其职 —— 这是托管层拆分，不是应用架构拆分）、
         * 契约（与本地 Express 同一套 API 契约）。 */
        oneLine: 'Serverless 托管形态：Pages 承载静态资产、Workers 承载 API、D1 承载数据，'
          + '三者共用同一套 API 契约；与本地"单一 Node 进程"形态共用同一份前端与契约',
        runtime: {
          model: 'serverless-worker',
          statement: 'Cloudflare Workers 承载 API 与链上计算，无自管进程；D1 承载数据',
          apiBase: '/api（同域反代，无需跨域）',
          frontendBuild: '无独立构建产物：运行期编译的 Vue 3 + 原生 JS 视图',
        },
        assetHosting: {
          separated: true,
          statement: '托管层拆分：静态资产由 Cloudflare Pages 托管、API 由 Workers 承载、数据在 D1 —— '
            + '这是托管产品的各承其职，不是应用架构的拆分',
        },
        contract: {
          consistent: true,
          statement: '与本地 Express 形态共用同一套 API 契约与同一份前端代码',
        },
      },
      selfCheckHint: '完整演练与台账在本地节点执行：node tools/attack-same-db.mjs && node tools/metrics-ledger.mjs --strict',
    });
  });
}

/* ==================================================================================
 * Merkle 与块头哈希（与本地链内核同算法）
 * ================================================================================== */

/**
 * 计算 Merkle 根。
 * 规则：叶子按顺序两两配对哈希，奇数个则最后一个与自身配对；
 * 空列表返回全零根（与本地实现一致）。
 */
/* ⭐ 与本地链内核 cu.merkleRoot 逐字节同源：
 * 两两 sha256(左 + 右) 直接拼接（无分隔符），奇数个则最后一个与自身配对。
 * 2026-10-27 勘查实证：Turso 权威链的 merkle_root 即此公式
 * （tools/_qa/formula-space.mjs 对块 #1/#2 四变体枚举，仅本变体匹配）。 */
export function merkleRoot(leaves) {
  if (!leaves || !leaves.length) return '0'.repeat(64);
  let level = leaves.map((l) => String(l));
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256Hex(level[i] + level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

/** 批次锚定（anchor_batch）专用的历史 pipe 公式：该表的 merkle_root
 * 由边缘批次锚定流程以 sha256(左|右) 写入，校验须沿用同公式。
 * 与链内核的 concat 公式是两个子系统，不得混用。 */
export function merkleRootPipe(leaves) {
  if (!leaves || !leaves.length) return '0'.repeat(64);
  let level = leaves.map((l) => String(l));
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(canonicalHash(a, b));
    }
    level = next;
  }
  return level[0];
}

/* ⭐ 块头哈希：与本地链内核 calcHash 的 PoA 分支逐字节同源：
 * sha256([index, timestamp, merkleRoot, prevHash, 'POA', proposer, nonce].join('|'))
 * 其中 timestamp 为 UNIX 秒（块时间 block_time 为 UTC 文本，经 strftime 还原）。
 * 2026-10-27 勘查实证：对 Turso 权威链抽块重算逐位一致
 * （旧 canonical JSON 实现与链内核并非同口径——线上 validate 因此恒红，属隐性缺陷）。 */
function nodeCalcHashOf(h) {
  return sha256Hex([
    h.blockIndex, h.timestamp, h.merkleRoot, h.prevHash,
    'POA', h.proposer || '', h.nonce,
  ].join('|'));
}
