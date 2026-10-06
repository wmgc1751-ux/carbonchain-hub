/**
 * chain.js —— 轻量级联盟链内核
 * ------------------------------------------------------------------
 * 本文件实现了一条可直接运行、可被真实业务调用的区块链，包含：
 *
 *   · 哈希链结构      block.hash = SHA256(index|timestamp|merkleRoot|prevHash|difficulty|nonce)
 *   · 工作量证明 PoW  出块需找出满足 difficulty 个前导零的 nonce
 *   · Merkle 树       区块内所有交易摘要收敛为一个根
 *   · 交易池          业务动作先入池，打包后落块
 *   · ECDSA 存证签名  每笔交易由发起方私钥签名，节点可验签
 *   · 链完整性校验    逐块重算哈希 + 校验前向引用 + 校验 PoW + 校验 Merkle 根
 *   · 篡改演示        模拟恶意节点直改数据库，校验立刻报警；修复需重做整条后缀的 PoW
 *
 * 设计上刻意与业务库共库（同一 MySQL 实例、独立表），
 * 目的是让"链上数据"与"链下数据"形成可对照的对照关系：
 * 链下随意改、链上一改就崩，这正是区块链在碳数据场景的价值所在。
 *
 * @module blockchain/chain
 */
'use strict';

const cu = require('./crypto-utils');

/** 创世区块固定前向哈希 */
const GENESIS_PREV_HASH = cu.ZERO.repeat(64);

class Blockchain {
  /**
   * @param {object} db  MySQL 连接池
   * @param {object} opts { difficulty, autoMine, batchSize, nodeName }
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.difficulty = opts.difficulty || 4;
    this.autoMine = opts.autoMine !== false;
    this.batchSize = opts.batchSize || 1;
    this.nodeName = opts.nodeName || 'node-carbon-01';
    this.blocks = [];       // 内存链（已确认）
    this.pool = [];         // 交易池（待打包）
    this.mining = false;    // 出块锁，防止并发挖矿
    this.ready = false;
  }

  /* ================================================================
   * 初始化
   * ================================================================ */

  /** 从数据库装载链与交易池；链为空时创建创世块 */
  async init() {
    const [rows] = await this.db.query(
      'SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, tx_count, miner, size_bytes, mine_time, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block ORDER BY block_index ASC'
    );
    if (rows.length === 0) {
      await this.mineBlock({ miner: 'GENESIS', genesis: true });
    } else {
      this.blocks = rows.map((r) => this._rowToBlock(r));
    }

    const [pend] = await this.db.query(
      "SELECT * FROM chain_tx WHERE status = 'PENDING' ORDER BY id ASC"
    );
    this.pool = pend.map((r) => this._rowToTx(r));
    this.ready = true;
    return this;
  }

  _rowToBlock(r) {
    return {
      index: Number(r.block_index),
      hash: r.block_hash,
      prevHash: r.prev_hash,
      merkleRoot: r.merkle_root,
      nonce: Number(r.nonce),
      difficulty: Number(r.difficulty),
      txCount: Number(r.tx_count),
      miner: r.miner,
      sizeBytes: Number(r.size_bytes),
      mineTime: Number(r.mine_time),
      // 区块时间戳统一使用「秒」，与 MySQL DATETIME 精度对齐，
      // 否则毫秒部分在落库时被截断，重算哈希必然不一致。
      timestamp: Number(r.ts),
    };
  }

  _rowToTx(r) {
    return {
      txId: r.tx_id,
      txType: r.tx_type,
      bizNo: r.biz_no,
      blockIndex: r.block_index === null ? null : Number(r.block_index),
      fromAddress: r.from_address,
      toAddress: r.to_address,
      payloadHash: r.payload_hash,
      payload: r.payload_json ? safeParse(r.payload_json) : null,
      signature: r.signature,
      pubKey: r.pub_key,
      nonce: Number(r.nonce),
      fee: Number(r.gas_fee),
      status: r.status,
      createdAt: new Date(r.created_at).getTime(),
    };
  }

  /* ================================================================
   * 区块哈希与 PoW
   * ================================================================ */

  /** 计算区块头哈希 */
  static calcHash(b) {
    const raw = [
      b.index, b.timestamp, b.merkleRoot, b.prevHash, b.difficulty, b.nonce,
    ].join('|');
    return cu.sha256(raw);
  }

  /**
   * 工作量证明：暴力搜索 nonce，使区块哈希以 difficulty 个 0 开头
   * @returns {{nonce:number, hash:string, hashRate:number, elapsed:number}}
   */
  static proofOfWork(header) {
    const target = cu.ZERO.repeat(header.difficulty);
    const start = Date.now();
    let nonce = header.nonce || 0;
    let hash = '';
    for (;;) {
      hash = Blockchain.calcHash({ ...header, nonce });
      if (hash.startsWith(target)) break;
      nonce += 1;
    }
    const elapsed = Math.max(Date.now() - start, 1);
    return { nonce, hash, hashRate: Math.round(nonce / (elapsed / 1000)) || nonce, elapsed };
  }

  /** 校验区块自身（哈希、PoW、结构） */
  static isBlockValid(block) {
    const errors = [];
    const expect = Blockchain.calcHash(block);
    if (expect !== block.hash) errors.push(`区块#${block.index} 哈希不匹配（数据已被改动）`);
    const target = cu.ZERO.repeat(block.difficulty);
    if (!String(block.hash).startsWith(target)) errors.push(`区块#${block.index} 不满足 PoW 难度 ${block.difficulty}`);
    if (block.index > 0 && block.prevHash !== (block.prevHash || '')) {
      // 占位，链式校验在 validateChain 中做
    }
    return { ok: errors.length === 0, errors };
  }

  /* ================================================================
   * 交易：构造 → 签名 → 入池 → 打包
   * ================================================================ */

  /**
   * 构造并签名一笔存证交易
   * @param {object} p
   *   p.txType     业务类型
   *   p.bizNo      业务单号
   *   p.fromAddress 发起方地址
   *   p.toAddress  接收方地址（可选）
   *   p.payload    业务数据对象（会被哈希并快照存证）
   *   p.privateKey 发起方私钥 PEM（用于 ECDSA 签名）
   *   p.publicKey  发起方公钥 PEM
   *   p.fee        存证手续费
   * @returns {object} 交易对象
   */
  buildTx(p) {
    const payloadHash = cu.hashObject(p.payload || {});
    const nonce = Date.now() + Math.floor(Math.random() * 1000);
    const txId = cu.sha256(
      [p.fromAddress || 'SYSTEM', nonce, payloadHash, p.txType, p.bizNo || ''].join('|')
    ).slice(0, 64);

    // 签名内容：交易核心字段（不含签名字段自身），保证任何字段被改都会验签失败
    const signContent = cu.stableStringify({
      txId,
      txType: p.txType,
      bizNo: p.bizNo || null,
      fromAddress: p.fromAddress || 'SYSTEM',
      toAddress: p.toAddress || null,
      payloadHash,
      nonce,
    });
    const signature = p.privateKey ? cu.sign(p.privateKey, signContent) : null;

    return {
      txId,
      txType: p.txType,
      bizNo: p.bizNo || null,
      blockIndex: null,
      fromAddress: p.fromAddress || 'SYSTEM',
      toAddress: p.toAddress || null,
      payloadHash,
      payload: p.payload || {},
      signature,
      pubKey: p.publicKey || null,
      nonce,
      fee: p.fee || 0,
      status: 'PENDING',
      createdAt: Date.now(),
      signContent, // 仅内存中使用，供验签
    };
  }

  /** 内存中校验一笔交易的签名 */
  static isTxSignatureValid(tx) {
    if (!tx.signature || !tx.pubKey) return false;
    const content = cu.stableStringify({
      txId: tx.txId,
      txType: tx.txType,
      bizNo: tx.bizNo || null,
      fromAddress: tx.fromAddress,
      toAddress: tx.toAddress || null,
      payloadHash: tx.payloadHash,
      nonce: tx.nonce,
    });
    return cu.verify(tx.pubKey, content, tx.signature);
  }

  /** 交易落库为 PENDING */
  async persistTx(tx) {
    await this.db.query(
      `INSERT INTO chain_tx
        (tx_id, tx_type, biz_no, block_index, from_address, to_address, payload_hash,
         payload_json, signature, pub_key, nonce, gas_fee, status, created_at)
       VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,'PENDING',NOW())
       ON DUPLICATE KEY UPDATE tx_id = tx_id`,
      [
        tx.txId, tx.txType, tx.bizNo, tx.fromAddress, tx.toAddress, tx.payloadHash,
        JSON.stringify(tx.payload), tx.signature, tx.pubKey, tx.nonce, tx.fee,
      ]
    );
  }

  /**
   * 批量落库为 PENDING（性能优化）
   * ------------------------------------------------------------------
   * 与 persistTx 写入完全相同的行，但用单条 INSERT ... VALUES (...),(...) 提交。
   * 用途：初始化脚本一次要灌 900+ 笔存证，逐条 await 在跨地域（如本机 → 云端 MySQL）
   * 场景下光是网络往返就要数分钟；批量后往返次数从 N 降到 N/50。
   * 单进程高频提交时同样受益。业务语义与逐条写入完全一致。
   */
  async persistTxBatch(txs, chunk = 50) {
    if (!txs || !txs.length) return 0;
    const cols = ['tx_id', 'tx_type', 'biz_no', 'from_address', 'to_address', 'payload_hash',
      'payload_json', 'signature', 'pub_key', 'nonce', 'gas_fee'];
    let n = 0;
    for (let i = 0; i < txs.length; i += chunk) {
      const slice = txs.slice(i, i + chunk);
      const ph = slice.map(() => "(?,?,?,?,?,?,?,?,?,?,?,'PENDING',NOW())").join(',');
      const params = slice.flatMap((tx) => [
        tx.txId, tx.txType, tx.bizNo, tx.fromAddress, tx.toAddress, tx.payloadHash,
        JSON.stringify(tx.payload), tx.signature, tx.pubKey, tx.nonce, tx.fee,
      ]);
      await this.db.query(
        `INSERT INTO chain_tx (${cols.join(',')}, status, created_at)
         VALUES ${ph}
         ON DUPLICATE KEY UPDATE tx_id = tx_id`,
        params
      );
      n += slice.length;
    }
    return n;
  }

  /**
   * 提交交易：入池，并在满足批大小时自动出块
   * @returns {Promise<{tx:object, block:object|null}>}
   */
  async submitTx(tx) {
    await this.persistTx(tx);
    this.pool.push(tx);
    if (this.autoMine && this.pool.length >= this.batchSize) {
      const block = await this.mineBlock();
      return { tx, block };
    }
    return { tx, block: null };
  }

  /* ================================================================
   * 出块
   * ================================================================ */

  /**
   * 打包当前交易池并出块
   * @param {object} opts { miner, genesis, txs }
   * @returns {Promise<object>} 新区块
   */
  async mineBlock(opts = {}) {
    if (this.mining) throw new Error('出块进行中，请稍后');
    this.mining = true;
    try {
      const genesis = !!opts.genesis;
      const txs = opts.txs || (genesis ? [] : this.pool.splice(0, this.pool.length));
      const prev = this.blocks[this.blocks.length - 1];
      const index = prev ? prev.index + 1 : 0;
      // 时间戳取整到秒（与 DATETIME 存储精度一致，保证重新装载后哈希可复现）
      const rawMs = opts.timestamp
        ? new Date(opts.timestamp).getTime()
        : (genesis ? Date.now() - 1000 * 60 * 60 * 24 : Date.now());
      const timestamp = Math.floor(rawMs / 1000);
      const txHashes = txs.map((t) => t.txId);
      const root = cu.merkleRoot(txHashes);

      const header = {
        index,
        timestamp,
        merkleRoot: root,
        prevHash: prev ? prev.hash : GENESIS_PREV_HASH,
        difficulty: this.difficulty,
        nonce: 0,
      };
      const pow = Blockchain.proofOfWork(header);
      const block = {
        index,
        timestamp,
        merkleRoot: root,
        prevHash: header.prevHash,
        difficulty: this.difficulty,
        nonce: pow.nonce,
        hash: pow.hash,
        txCount: txs.length,
        miner: opts.miner || this.nodeName,
        mineTime: pow.elapsed,
        sizeBytes: Buffer.byteLength(JSON.stringify({ header, txs: txHashes })),
      };

      await this.db.query(
        `INSERT INTO chain_block
          (block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, tx_count,
           miner, size_bytes, mine_time, block_time, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
        [
          block.index, block.hash, block.prevHash, block.merkleRoot, block.nonce,
          block.difficulty, block.txCount, block.miner, block.sizeBytes, block.mineTime,
          new Date(block.timestamp * 1000),
        ]
      );

      if (txs.length) {
        const ids = txs.map((t) => t.txId);
        await this.db.query(
          `UPDATE chain_tx SET block_index = ?, status = 'CONFIRMED', confirmed_at = NOW()
           WHERE tx_id IN (?)`,
          [block.index, ids]
        );
        txs.forEach((t) => { t.blockIndex = block.index; t.status = 'CONFIRMED'; });
      }

      this.blocks.push(block);
      return block;
    } finally {
      this.mining = false;
    }
  }

  /* ================================================================
   * 链完整性校验
   * ================================================================ */

  /**
   * 全链校验：逐块重算哈希、校验前向引用、校验 PoW、比对 Merkle 根
   * @param {object} opts { fromIndex } 仅校验某高度之后
   * @returns {Promise<object>}
   */
  async validateChain(opts = {}) {
    const from = opts.fromIndex || 0;
    const [blocks] = await this.db.query(
      'SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index >= ? ORDER BY block_index ASC', [from]
    );
    const errors = [];
    let checked = 0;

    for (let i = 0; i < blocks.length; i++) {
      const raw = blocks[i];
      const b = {
        index: Number(raw.block_index),
        timestamp: Number(raw.ts),
        merkleRoot: raw.merkle_root,
        prevHash: raw.prev_hash,
        difficulty: Number(raw.difficulty),
        nonce: Number(raw.nonce),
        hash: raw.block_hash,
      };
      checked++;

      // (1) 重算哈希
      const expect = Blockchain.calcHash(b);
      if (expect !== b.hash) {
        errors.push({
          index: b.index, type: 'HASH_MISMATCH',
          message: `区块 #${b.index} 内容哈希与记录不符：期望 ${expect.slice(0, 16)}…，实际 ${b.hash.slice(0, 16)}…`,
        });
      }

      // (2) PoW 难度
      if (!String(b.hash).startsWith(cu.ZERO.repeat(b.difficulty))) {
        errors.push({
          index: b.index, type: 'POW_INVALID',
          message: `区块 #${b.index} 不满足难度 ${b.difficulty} 的工作量证明`,
        });
      }

      // (3) 前向引用
      if (i > 0) {
        const prevRaw = blocks[i - 1];
        if (b.prevHash !== prevRaw.block_hash) {
          errors.push({
            index: b.index, type: 'PREV_HASH_MISMATCH',
            message: `区块 #${b.index} 的 prevHash 未指向区块 #${b.index - 1}（链断裂）`,
          });
        }
      }

      // (4) Merkle 根与交易表比对
      const [txRows] = await this.db.query(
        'SELECT tx_id FROM chain_tx WHERE block_index = ? ORDER BY id ASC', [b.index]
      );
      const root = cu.merkleRoot(txRows.map((t) => t.tx_id));
      if (root !== b.merkleRoot) {
        errors.push({
          index: b.index, type: 'MERKLE_ROOT_MISMATCH',
          message: `区块 #${b.index} 的交易 Merkle 根与链上交易表不一致（交易被增删改）`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      checkedBlocks: checked,
      height: this.blocks.length ? this.blocks[this.blocks.length - 1].index : -1,
      errors,
      verifiedAt: new Date().toISOString(),
    };
  }

  /* ================================================================
   * 篡改演示 / 修复
   * ================================================================ */

  /**
   * 【演示】模拟一个恶意节点绕过应用层、直接修改数据库中的区块数据。
   * 修改后不重算哈希 —— 这正是攻击者最容易犯的错，也是区块链能抓到的点。
   * @param {number} blockIndex
   * @param {string} field 'merkle_root' | 'prev_hash' | 'nonce' | 'block_time'
   * @returns {Promise<object>} 篡改前后对比
   */
  async tamper(blockIndex, field = 'merkle_root') {
    const [rows] = await this.db.query(
      'SELECT * FROM chain_block WHERE block_index = ?', [blockIndex]
    );
    if (!rows.length) throw new Error(`区块 #${blockIndex} 不存在`);
    const before = rows[0];
    const col = field === 'prev_hash' ? 'prev_hash'
      : field === 'nonce' ? 'nonce'
        : field === 'block_time' ? 'block_time' : 'merkle_root';

    let newValue;
    if (col === 'nonce') {
      newValue = Number(before.nonce) + 1;
    } else if (col === 'block_time') {
      newValue = new Date(new Date(before.block_time).getTime() - 86400000);
    } else {
      // 翻转哈希的最后一个字符
      newValue = String(before[col]).slice(0, -1) + (String(before[col]).endsWith('a') ? 'b' : 'a');
    }

    await this.db.query(
      `UPDATE chain_block SET ${col} = ? WHERE block_index = ?`, [newValue, blockIndex]
    );

    const validation = await this.validateChain({ fromIndex: 0 });
    return {
      blockIndex,
      field: col,
      before: before[col],
      after: newValue,
      validation,
      tip: '链上数据一旦被改写，全链校验立刻失败 —— 这就是"不可篡改"的技术含义。',
    };
  }

  /**
   * 修复链：从指定高度起重算哈希并重做 PoW（模拟攻击者想"续上"链所需要付出的代价）。
   * 演示用：改一个块，后面所有块都得重挖，且其它节点只要比对过旧哈希就能发现。
   * @param {number} fromIndex
   * @returns {Promise<object>}
   */
  async repairChain(fromIndex) {
    const [rows] = await this.db.query(
      'SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index >= ? ORDER BY block_index ASC', [fromIndex]
    );
    const repaired = [];
    let prevHash = null;
    if (fromIndex > 0) {
      const [p] = await this.db.query(
        'SELECT block_hash FROM chain_block WHERE block_index = ?', [fromIndex - 1]
      );
      prevHash = p.length ? p[0].block_hash : GENESIS_PREV_HASH;
    }
    for (const raw of rows) {
      const [txRows] = await this.db.query(
        'SELECT tx_id FROM chain_tx WHERE block_index = ? ORDER BY id ASC', [raw.block_index]
      );
      const merkle = cu.merkleRoot(txRows.map((t) => t.tx_id));
      const header = {
        index: Number(raw.block_index),
        timestamp: Number(raw.ts),
        merkleRoot: merkle,
        prevHash: prevHash || raw.prev_hash,
        difficulty: Number(raw.difficulty),
        nonce: 0,
      };
      const pow = Blockchain.proofOfWork(header);
      await this.db.query(
        `UPDATE chain_block SET block_hash=?, prev_hash=?, merkle_root=?, nonce=?, mine_time=?
         WHERE block_index = ?`,
        [pow.hash, header.prevHash, merkle, pow.nonce, pow.elapsed, raw.block_index]
      );
      repaired.push({ index: header.index, newHash: pow.hash, cost: pow.elapsed });
      prevHash = pow.hash;
    }
    await this.init();
    const validation = await this.validateChain();
    return { fromIndex, repaired, validation };
  }

  /* ================================================================
   * 统计
   * ================================================================ */

  async stats() {
    const [[blk]] = await this.db.query(
      `SELECT COUNT(*) AS total_blocks, IFNULL(SUM(tx_count),0) AS total_txs,
              IFNULL(AVG(mine_time),0) AS avg_mine_time, IFNULL(MAX(difficulty),0) AS difficulty,
              IFNULL(SUM(size_bytes),0) AS total_size
       FROM chain_block`
    );
    const [[tx]] = await this.db.query(
      `SELECT COUNT(*) AS total, SUM(status='CONFIRMED') AS confirmed, SUM(status='PENDING') AS pending
       FROM chain_tx`
    );
    const [byType] = await this.db.query(
      'SELECT tx_type, COUNT(*) AS cnt FROM chain_tx GROUP BY tx_type ORDER BY cnt DESC'
    );
    const [recent] = await this.db.query(
      `SELECT DATE_FORMAT(block_time,'%Y-%m-%d %H:00') AS hour, COUNT(*) AS cnt
       FROM chain_block GROUP BY hour ORDER BY hour DESC LIMIT 24`
    );
    const tip = this.blocks[this.blocks.length - 1] || null;
    return {
      height: tip ? tip.index : -1,
      tipHash: tip ? tip.hash : null,
      totalBlocks: Number(blk.total_blocks),
      totalTxs: Number(blk.total_txs),
      avgMineTime: Math.round(Number(blk.avg_mine_time)),
      difficulty: Number(blk.difficulty),
      totalSize: Number(blk.total_size),
      confirmed: Number(tx.confirmed || 0),
      pending: Number(tx.pending || 0),
      txByType: byType,
      blockRate: recent.reverse(),
      node: this.nodeName,
      consensus: 'PoW（工作量证明）+ 最长链原则',
      crypto: 'SHA-256 / secp256k1-ECDSA / Merkle Tree',
    };
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = { Blockchain, GENESIS_PREV_HASH };
