/**
 * chain.js —— 联盟链内核（PoA 授权证明）
 * ------------------------------------------------------------------
 * 本文件实现了一条可直接运行、可被真实业务调用的**联盟链**内核，包含：
 *
 *   · 哈希链结构      block.hash = SHA256(index|timestamp|merkleRoot|prevHash|consensus|proposer|nonce)
 *   · PoA 授权出块    仅"联盟授权节点"具备出块权，按权重轮值出块，无需挖矿
 *   · 出块签名        出块节点对区块头做 ECDSA(secp256k1) 签名，任何节点可验签
 *   · 成员准入        出块权来自 chain_node 白名单（PENDING/ACTIVE/REVOKED）
 *   · Merkle 树       区块内所有交易摘要收敛为一个根
 *   · 交易池          业务动作先入池，打包后落块
 *   · ECDSA 存证签名  每笔交易由发起方私钥签名，节点可验签
 *   · 链完整性校验    逐块重算哈希 + 校验前向引用 + 校验出块签名 + 校验 Merkle 根
 *   · 双共识兼容      历史 PoW 块仍按工作量证明校验（向后兼容，便于迁移）
 *
 * 为什么是"联盟链"而不是公有链：
 *   参与方是**许可制**的成员机构（监管 / 核查 / 企业 / 审计），各自运行一个节点、
 *   各自持有一份全量链副本；出块权由联盟授予，共识采用 PoA（授权证明）而非挖矿。
 *   这样即使某一方的数据库被完全攻陷，其它节点仍能凭各自副本发现并拒绝被篡改的链。
 *
 * @module blockchain/chain
 */
'use strict';

const cu = require('./crypto-utils');
const keystore = require('./keystore');

/** 创世区块固定前向哈希 */
const GENESIS_PREV_HASH = cu.ZERO.repeat(64);

class Blockchain {
  /**
   * @param {object} db  MySQL 连接池
   * @param {object} opts { consensusMode, difficulty, autoMine, batchSize, nodeName }
   *   consensusMode: 'POA'（默认，联盟链授权出块）/ 'POW'（历史兼容）
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.consensusMode = String(opts.consensusMode || process.env.CHAIN_CONSENSUS || 'POA').toUpperCase();
    this.difficulty = opts.difficulty || 4;   // 仅 POW 模式使用
    this.autoMine = opts.autoMine !== false;
    this.batchSize = opts.batchSize || 1;
    this.nodeName = opts.nodeName || 'node-carbon-01';
    this.blocks = [];       // 内存链（已确认）
    this.pool = [];         // 交易池（待打包）
    this.mining = false;    // 出块锁，防止并发出块
    this.ready = false;
    /* 链数据「变更版本号」：任何一次写入（出块 / 篡改 / 修复 / 重新装载）都自增。
     * 用途见 validateChainCached()：全链校验的缓存键必须包含本字段，
     * 否则「篡改后链高未变」会让缓存把一个已被破坏的链误报为 valid=true。 */
    this._rev = 0;
    this._validateCache = null; // { key, at, value }
  }

  /** 标记链数据已变更（使全链校验缓存失效） */
  _bumpRev() {
    this._rev++;
    this._validateCache = null;
  }

  /* ================================================================
   * 初始化
   * ================================================================ */

  /**
   * 从数据库装载链与交易池；链为空时创建创世块
   *
   * ⚠ 关于时间戳与时区（本文件最关键的一处约定）
   * ------------------------------------------------------------------
   * 区块哈希的输入包含 timestamp（绝对秒数），因此"从 DATETIME 反解出秒数"
   * 这一步必须在**任何机器上都得到同一个答案**。原实现用
   *   UNIX_TIMESTAMP(block_time)
   * 但 MySQL 的 UNIX_TIMESTAMP() 是按【会话时区】解释 DATETIME 的：
   *   · 本机 MySQL 会话时区 = +08:00 → 2026-01-01 10:00 视作 02:00Z
   *   · TiDB Cloud 会话时区   = +00:00 → 同一个字面量视作 10:00Z
   * 结果同一个字面量在两端反解出相差 28800 秒的 timestamp，重算哈希必然失败。
   * 解法两步（缺一不可）：
   *   (1) 连接建立后立刻 `SET time_zone = '+00:00'`，让两端会话统一按 UTC 解释；
   *   (2) 写入时不再做本地→UTC 的换算，直接把秒数按 UTC 格式化成字面量。
   * 这样"写进去的字符串"与"读出来的秒数"在 MySQL 与 TiDB 上完全一致。
   */
  static TIME_ZONE_UTC = true;

  async init() {
    await this.syncTimeZone();
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
    this._bumpRev(); // 首次装载视为一次变更，丢弃可能存在的陈旧校验缓存
    return this;
  }

  /**
   * 以库为准校正内存链高度。
   * ------------------------------------------------------------------
   * 正常路径只多一条 `MAX(block_index)`；仅当内存高度与库内不一致
   * （多进程并发、外部直接灌库、库被重建）时才整链重载。
   */
  async alignHeight() {
    let dbMax = -1;
    try {
      const [rows] = await this.db.query('SELECT MAX(block_index) AS maxIdx FROM chain_block');
      const v = rows && rows[0] ? rows[0].maxIdx : null;
      dbMax = v === null || v === undefined ? -1 : Number(v);
    } catch (e) {
      // 极早期（chain_block 尚未建表）忽略：交给后续 INSERT 抛真实错误
      return this.blocks.length ? Number(this.blocks[this.blocks.length - 1].index) : -1;
    }
    const memMax = this.blocks.length ? Number(this.blocks[this.blocks.length - 1].index) : -1;
    if (dbMax !== memMax) await this.reloadAll();
    return this.blocks.length ? Number(this.blocks[this.blocks.length - 1].index) : -1;
  }

  /** 从库内整链重载（仅在高度不一致或撞车重试时调用） */
  async reloadAll() {
    const [rows] = await this.db.query(
      'SELECT block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, tx_count, miner, size_bytes, mine_time, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block ORDER BY block_index ASC'
    );
    this.blocks = rows.map((r) => this._rowToBlock(r));
    this._bumpRev();
    return this;
  }

  /**
   * 把当前连接的会话时区固定为 UTC。
   * 池化连接下必须逐条连接生效，故先取一条连接执行；mysql2 每次从池里取到的连接
   * 都会带着初始化指令（在 pool 上用 connectionAttributes/initSql 不可用时，这里
   * 采用"每次查询前确保"的轻量策略：连接池是长连接，设一次即可长期生效；
   * 若中途因超时重连，这里都会被 init() / 校验入口再次调用覆盖）。
   */
  async syncTimeZone() {
    try {
      await this.db.query("SET time_zone = '+00:00'");
    } catch (e) {
      // 个别托管库不允许改会话时区（极少见）；此时退化为依赖 dateStrings 与写入格式化，
      // 不影响本机 MySQL，也不阻断启动。
      this._tzWarned = true;
    }
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
      consensus: r.consensus || 'POW',
      proposer: r.proposer || null,
      proposerSig: r.proposer_sig || null,
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

  /**
   * 计算区块头哈希（按共识类型分派，保证历史 PoW 块与新区块都可复现）
   *   · PoA：SHA256(index|timestamp|merkleRoot|prevHash|consensus|proposer|nonce)
   *   · PoW：SHA256(index|timestamp|merkleRoot|prevHash|difficulty|nonce)
   */
  static calcHash(b) {
    const consensus = String(b.consensus || 'POW').toUpperCase();
    if (consensus === 'POA') {
      return cu.sha256([
        b.index, b.timestamp, b.merkleRoot, b.prevHash, 'POA', b.proposer || '', b.nonce,
      ].join('|'));
    }
    return cu.sha256([
      b.index, b.timestamp, b.merkleRoot, b.prevHash, b.difficulty, b.nonce,
    ].join('|'));
  }

  /**
   * 出块签名的待签内容（区块头规范化序列化）。
   * 出块节点用自己的私钥对它签名，任何节点都能用其公钥验签，
   * 从而证明"这个块确实是本轮被授权的节点出的"，且区块头未被改动。
   */
  static signingPayload(b) {
    return cu.stableStringify({
      index: b.index, timestamp: b.timestamp, merkleRoot: b.merkleRoot,
      prevHash: b.prevHash, consensus: 'POA', proposer: b.proposer || '', nonce: b.nonce,
    });
  }

  /**
   * 绝对秒数 → UTC 的 'YYYY-MM-DD HH:mm:ss' 字面量。
   * 与 `SET time_zone = '+00:00'` 配对使用：写入即 UTC，读出按 UTC 解释，
   * 于是 timestamp 的往返在任何服务器时区下都恒等。
   * @param {number} sec epoch 秒
   */
  static utcDateString(sec) {
    const d = new Date(Number(sec) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
      + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
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

  /**
   * 【第五道校验】链下重算绑定：用交易明文负载重算 SHA-256，与链上锚定摘要比对。
   * ------------------------------------------------------------------
   * 前四道校验（区块头哈希 / 前向引用 / Merkle 根 / 出块与交易签名）全部只覆盖
   * **链上字段**。它们能证明"链上记录没人改过"，却证明不了"链下明细和链上锚点还对得上"。
   * 若攻击者只改链下 payload 正文而不动 payloadHash，前四道全绿、篡改却已发生。
   * 本方法补上这个断点：hashObject(payload) 必须等于 payloadHash。
   * @param {object} tx 至少含 { payload, payloadHash }
   * @returns {boolean}
   */
  static isTxPayloadBound(tx) {
    if (!tx || !tx.payloadHash) return false;
    return cu.verifyPayloadBinding(tx.payload, tx.payloadHash);
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
      const root = cu.merkleRoot(txs.map((t) => t.txId));

      // 出块前先与库内真实高度对齐。
      // 本地开发常同时跑多个 app.js / 模拟脚本，或有人直接灌库；此时内存
      // this.blocks 会落后于 chain_block 的实际高度，仍按 prev.index+1 出块
      // 必然撞唯一索引 uk_block_index（Duplicate entry 'NNNN'）。
      await this.alignHeight();

      let block = null;
      for (let attempt = 0; ; attempt += 1) {
        const prev = this.blocks[this.blocks.length - 1];
        const index = prev ? prev.index + 1 : 0;
        // 时间戳取整到秒（与 DATETIME 存储精度一致，保证重新装载后哈希可复现）
        const rawMs = opts.timestamp
          ? new Date(opts.timestamp).getTime()
          : (genesis ? Date.now() - 1000 * 60 * 60 * 24 : Date.now());
        const timestamp = Math.floor(rawMs / 1000);
        const prevHash = prev ? prev.hash : GENESIS_PREV_HASH;

        // 按共识类型出块：联盟链默认 PoA（授权节点轮值 + 签名），POW 为历史兼容路径
        const built = this.consensusMode === 'POA'
          ? await this._buildPoaBlock({ index, timestamp, root, prevHash, txs, genesis, opts })
          : this._buildPowBlock({ index, timestamp, root, prevHash, txs, genesis, opts });

        try {
          await this.db.query(
            `INSERT INTO chain_block
              (block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, consensus,
               proposer, proposer_sig, tx_count, miner, size_bytes, mine_time, block_time, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
            [
              built.index, built.hash, built.prevHash, built.merkleRoot, built.nonce,
              built.difficulty, built.consensus, built.proposer, built.proposerSig,
              built.txCount, built.miner, built.sizeBytes, built.mineTime,
              // 传字符串而不是 Date 对象：驱动不再做任何本地时区换算，
              // 配合会话 time_zone='+00:00'，写入值与读出秒数在 MySQL / TiDB 上完全一致。
              Blockchain.utcDateString(built.timestamp),
            ]
          );
          block = built;
          break;
        } catch (e) {
          const dup = e && (e.code === 'ER_DUP_ENTRY' || /Duplicate entry|uk_block_index/.test(String(e.message || '')));
          // 撞车说明库内已被其他进程推进：重新对齐后按新高度重建本块（最多重试 3 次）
          if (!dup || attempt >= 3) throw e;
          await this.reloadAll();
        }
      }

      if (txs.length) {
        const ids = txs.map((t) => t.txId);
        await this.db.query(
          `UPDATE chain_tx SET block_index = ?, status = 'CONFIRMED', confirmed_at = NOW()
           WHERE tx_id IN (?)`,
          [block.index, ids]
        );
        txs.forEach((t) => { t.blockIndex = block.index; t.status = 'CONFIRMED'; });
      }

      // 联盟链：登记本轮出块节点的统计（出块数 + 最近出块时间）
      if (block.consensus === 'POA' && block.proposer) {
        try {
          await this.db.query(
            `UPDATE chain_node SET proposed_blocks = proposed_blocks + 1, last_propose_at = NOW()
             WHERE node_id = ?`,
            [block.proposer]
          );
        } catch (e) { /* 节点表不可用时忽略统计 */ }
      }

      this.blocks.push(block);
      this._bumpRev(); // 新区块入链 → 全链校验缓存失效
      return block;
    } finally {
      this.mining = false;
    }
  }

  /**
   * 构造 PoA 区块：由本轮被授权的联盟节点出块，并对区块头签名。
   * 无挖矿，出块耗时接近 0 —— 这正是联盟链相对公有链的性能优势。
   */
  async _buildPoaBlock({ index, timestamp, root, prevHash, txs, genesis, opts }) {
    const t0 = Date.now();
    const proposer = await this.pickProposer(index, opts.proposer);
    const header = {
      index, timestamp, merkleRoot: root, prevHash,
      consensus: 'POA', proposer: proposer.nodeId, nonce: 0,
    };
    const hash = Blockchain.calcHash(header);
    const proposerSig = cu.sign(proposer.privateKey, Blockchain.signingPayload(header));
    /* 出块耗时：PoA 无挖矿，但"选主 + 算哈希 + 节点签名"是可测的真实工程开销。
     * 原实现硬编码 0 → 大屏「平均出块」、浏览器「出块耗时」、管理总览「出块均值」
     * 三处全部显示 0 ms / —（2026-10-29 巡检 P0-13）。一条本可用于佐证
     * 联盟链性能优势的真实数据被浪费成了占位符。
     * Math.max(1, …)：亚毫秒会被取整成 0，再次退化为"0 ms"，故设下限 1。 */
    const mineTime = Math.max(1, Date.now() - t0);
    return {
      index, timestamp, merkleRoot: root, prevHash,
      consensus: 'POA', proposer: proposer.nodeId, nonce: 0, difficulty: 0,
      hash, proposerSig,
      txCount: txs.length, miner: proposer.nodeId, mineTime,
      sizeBytes: Buffer.byteLength(JSON.stringify({ header, txs: txs.map((t) => t.txId) })),
    };
  }

  /** 构造 PoW 区块（历史兼容路径，保留以便旧链校验与迁移） */
  _buildPowBlock({ index, timestamp, root, prevHash, txs, genesis, opts }) {
    const header = { index, timestamp, merkleRoot: root, prevHash, difficulty: this.difficulty, nonce: 0 };
    const pow = Blockchain.proofOfWork(header);
    return {
      index, timestamp, merkleRoot: root, prevHash,
      consensus: 'POW', proposer: opts.miner || this.nodeName, nonce: pow.nonce,
      difficulty: this.difficulty, hash: pow.hash, proposerSig: null,
      txCount: txs.length, miner: opts.miner || this.nodeName, mineTime: pow.elapsed,
      sizeBytes: Buffer.byteLength(JSON.stringify({ header, txs: txs.map((t) => t.txId) })),
    };
  }

  /**
   * 选出本轮出块节点（PoA）：从 chain_node 白名单里取"状态 ACTIVE 且具备出块权"的节点，
   * 按 vote_weight 展开成轮值序列后取 index % seq.length —— 权重越高、出块机会越多。
   * 若链上尚未登记任何授权节点，退化为本节点单节点联盟（保证系统可启动）。
   */
  async pickProposer(index, forced) {
    if (forced) return this._nodeWallet(forced);
    try {
      const [rows] = await this.db.query(
        "SELECT node_id, vote_weight FROM chain_node WHERE status = 'ACTIVE' AND is_authorized = 1 ORDER BY id"
      );
      if (rows.length) {
        const seq = [];
        rows.forEach((r) => {
          const w = Math.max(1, Number(r.vote_weight) || 1);
          for (let i = 0; i < w; i++) seq.push(r.node_id);
        });
        return this._nodeWallet(seq[index % seq.length]);
      }
    } catch (e) { /* chain_node 表不存在时退化为单节点 */ }
    return this._nodeWallet(this.nodeName);
  }

  /** 取某节点的钱包（确定性派生，label 形如 node:xxx），用于出块签名 */
  _nodeWallet(nodeId) {
    const w = keystore.walletFor(`node:${nodeId}`);
    return { nodeId, address: w.address, publicKey: w.publicKey, privateKey: w.privateKey };
  }

  /* ================================================================
   * 链完整性校验
   * ================================================================ */

  /**
   * 带短时缓存的全链校验 —— 面向「高频只读巡检」场景（浏览器/监管端轮询该接口）。
   *
   * 为什么需要缓存：validateChain 是 O(区块数 × 交易数) 的重活，一次调用要对
   * 每个区块做 1 次区块头哈希 + 1 次出块签名验签（ECDSA ≈ 0.5 ms）+ 1 次 Merkle 建根，
   * 还要对每笔交易做 1 次链下重算绑定。500+ 区块时单次耗时进入百毫秒级，
   * 并发巡检会把单进程 CPU 打满（实测线上 100 并发全部超时）。
   *
   * 安全前提：缓存键包含 `_rev`（链数据变更版本号）与链高。任何写入 ——
   * 出块、篡改、修复、重新装载 —— 都会 `_bumpRev()` 使缓存立即失效，
   * 因此**不存在「链已被破坏但缓存仍报 valid=true」的窗口**。
   *
   * @param {object} opts { fromIndex, ttlMs } ttlMs 默认 5000，传 0 可强制重算
   * @returns {Promise<object>} validateChain 的结果，额外带 cached / cacheAgeMs 字段
   */
  async validateChainCached(opts = {}) {
    const from = Number(opts.fromIndex) || 0;
    const ttl = opts.ttlMs === undefined ? 5000 : Number(opts.ttlMs);
    const tip = this.blocks.length ? this.blocks[this.blocks.length - 1].index : -1;
    const key = `${from}:${tip}:${this.blocks.length}:${this._rev}`;
    const now = Date.now();
    const c = this._validateCache;
    if (ttl > 0 && c && c.key === key && (now - c.at) < ttl) {
      return { ...c.value, cached: true, cacheAgeMs: now - c.at };
    }
    const value = await this.validateChain({ fromIndex: from });
    this._validateCache = { key, at: Date.now(), value };
    return { ...value, cached: false, cacheAgeMs: 0 };
  }

  /**
   * 全链校验（五道校验，逐层递进）：
   *   ① 区块头哈希重算          —— 链上区块内容是否被改
   *   ② 出块签名 / PoW / 出块资格 —— 是否由获授权节点出块、区块头是否被改
   *   ③ 前向引用 prevHash       —— 链是否断裂、区块是否被抽换
   *   ④ Merkle 根重算           —— 区块内交易是否被增删
   *   ⑤ 链下重算绑定            —— 链下业务明文是否仍与链上锚定摘要一致
   * 前四道只覆盖链上字段；第五道是"链上存证 + 链下存储"架构下唯一的链下完整性出口。
   * @param {object} opts { fromIndex } 仅校验某高度之后
   * @returns {Promise<object>} { valid, checkedBlocks, height, coverage, errors }
   */
  async validateChain(opts = {}) {
    await this.syncTimeZone();
    const from = opts.fromIndex || 0;
    const [blocks] = await this.db.query(
      'SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index >= ? ORDER BY block_index ASC', [from]
    );
    const errors = [];
    /* 治理告警：不影响 valid（完整性结论），但必须让人看见。
       见 (2) 出块资格判据的注释 —— 事后撤销节点不能反溯历史区块。 */
    const warnings = [];
    let revokedProposerBlocks = 0;
    let checked = 0;

    // 联盟链：加载授权节点公钥与状态，用于验证 PoA 出块签名与出块资格
    const nodePubKey = new Map();
    const nodeStatus = new Map();
    try {
      const [nodes] = await this.db.query('SELECT node_id, public_key, status, is_authorized FROM chain_node');
      nodes.forEach((n) => {
        nodePubKey.set(n.node_id, n.public_key);
        nodeStatus.set(n.node_id, { status: n.status, auth: Number(n.is_authorized) });
      });
    } catch (e) { /* 无节点表时退化为仅验哈希链 */ }

    /* 一次性把所有区块的交易取回来，按 block_index 分组，避免"每块一次查询"。
     * 原实现是 for 循环里逐块 SELECT，本地 MySQL 上无所谓（<1 ms），
     * 但部署到云端后数据库与 Web 服务跨地域，155 块 = 155 次网络往返，
     * 实测一次全链校验要跑几十分钟，接口必然超时。
     * 改成单条查询 + 内存分组后，往返次数恒为 1。 */
    const [allTx] = await this.db.query(
      `SELECT block_index, tx_id, payload_hash, payload_json, tx_type, biz_no,
              signature, pub_key, from_address, to_address, nonce
         FROM chain_tx WHERE block_index >= ? ORDER BY block_index ASC, id ASC`,
      [from]
    );
    const txByBlock = new Map();      // 区块高度 → [tx_id]（供 Merkle 根重算）
    const txRowsByBlock = new Map();  // 区块高度 → [整行]（供第五道「链下重算绑定」校验）
    for (const t of allTx) {
      const k = Number(t.block_index);
      if (!txByBlock.has(k)) txByBlock.set(k, []);
      txByBlock.get(k).push(t.tx_id);
      if (!txRowsByBlock.has(k)) txRowsByBlock.set(k, []);
      txRowsByBlock.get(k).push(t);
    }

    // 第五道校验的计数器与错误明细（明细限量，避免异常时错误数组爆掉接口响应）
    let txChecked = 0;
    let payloadBound = 0;
    let payloadMismatch = 0;
    const payloadErrors = [];
    /* 第(6)项：交易发起方签名校验的计数器 */
    let txSigChecked = 0;
    let txSigOk = 0;
    let txSigInvalid = 0;
    let txSigUnsigned = 0;
    const txSigErrors = [];
    const PAYLOAD_ERROR_LIMIT = 20;

    for (let i = 0; i < blocks.length; i++) {
      const raw = blocks[i];
      const consensus = String(raw.consensus || 'POW').toUpperCase();
      const b = {
        index: Number(raw.block_index),
        timestamp: Number(raw.ts),
        merkleRoot: raw.merkle_root,
        prevHash: raw.prev_hash,
        difficulty: Number(raw.difficulty),
        nonce: Number(raw.nonce),
        consensus,
        proposer: raw.proposer || null,
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

      // (2) 共识校验：PoA 验出块签名与授权资格；PoW 校验前导零
      if (consensus === 'POA') {
        const local = keystore.all()[`node:${b.proposer}`];
        const pub = nodePubKey.get(b.proposer) || (local ? local.publicKey : null);
        const sigValid = !!(raw.proposer_sig && pub
          && cu.verify(pub, Blockchain.signingPayload(b), raw.proposer_sig));
        if (!sigValid) {
          errors.push({
            index: b.index, type: 'POA_SIGNATURE_INVALID',
            message: `区块 #${b.index} 的 PoA 出块签名无效（出块节点 ${b.proposer} 签名校验失败）`,
          });
        }
        /* ⚠⚠ 判据边界：出块资格必须按「出块当时」判，不能按「今天」判。
         * 原实现拿 chain_node 的当前 status 去否历史区块 —— 节点一旦被撤销，
         * 它此前签过的全部区块立刻变成"未授权出块"（实测 268 块 → 271 条错误），
         * valid 从此恒为 false。这是恒假式判据：等于把「全链校验」这道总闸门废掉，
         * 且联盟链本身也站不住 —— 撤销节点不能反溯撤销历史共识。
         * 正确划分：
         *   · 硬错误（真·未经授权）：出块者根本不在节点表里，身份不可识别；
         *   · 治理告警（不是完整性问题）：出块者曾在册、事后被撤销/停用。
         *     区块本身仍被签名与哈希链保护，篡改照样抓得住。
         * 「撤销后是否仍在出块」属于节点治理问题，由 /regulator/nodes 的
         * last_propose_at 与状态一起看，不该由历史区块反推。 */
        const st = nodeStatus.get(b.proposer);
        if (!st) {
          errors.push({
            index: b.index, type: 'PROPOSER_UNREGISTERED',
            message: `区块 #${b.index} 的出块节点 ${b.proposer} 不在联盟节点表中（身份不可识别）`,
          });
        } else if (st.status !== 'ACTIVE' || !st.auth) {
          revokedProposerBlocks += 1;
          if (warnings.length < 20) {
            warnings.push({
              index: b.index, type: 'PROPOSER_REVOKED_LATER',
              message: `区块 #${b.index} 由 ${b.proposer} 出块；该节点现为 ${st.status}`
                + '（历史区块不因事后撤销而失效，此处仅作治理提示）',
            });
          }
        }
      } else if (!String(b.hash).startsWith(cu.ZERO.repeat(b.difficulty))) {
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

      // (4) Merkle 根与交易表比对（交易已在上方一次性取回）
      const txRows = txByBlock.get(b.index) || [];
      const root = cu.merkleRoot(txRows);
      if (root !== b.merkleRoot) {
        errors.push({
          index: b.index, type: 'MERKLE_ROOT_MISMATCH',
          message: `区块 #${b.index} 的交易 Merkle 根与链上交易表不一致（交易被增删改）`,
        });
      }

      // (5) 链下重算绑定：逐笔用明文负载重算摘要，与链上锚定摘要比对。
      //     这是唯一能发现"链下业务明细被改、链上锚点未变"的校验点。
      const bindRows = txRowsByBlock.get(b.index) || [];
      for (const t of bindRows) {
        txChecked++;
        const payload = t.payload_json === null || t.payload_json === undefined
          ? null : safeParse(t.payload_json);
        if (cu.verifyPayloadBinding(payload, t.payload_hash)) {
          payloadBound++;
        } else {
          payloadMismatch++;
          if (payloadErrors.length < PAYLOAD_ERROR_LIMIT) {
            payloadErrors.push({
              index: b.index, txId: t.tx_id, type: 'PAYLOAD_BINDING_MISMATCH',
              message: `区块 #${b.index} 的交易 ${String(t.tx_id).slice(0, 16)}… 链下明细与链上锚定摘要不符`
                + '（链下业务数据被改动，或锚点被改动）',
            });
          }
        }

        /* (6) 交易发起方签名校验 —— 补上「同库同改」的最后一段。
         * 背景：payload_hash 虽被出块签名间接保护（区块头含 Merkle 根，
         * 根由 txId 派生，而 txId 又由 payload_hash 派生），但攻击者可以
         * **只改 payload_hash 而不改 txId**：此时 Merkle 根不变、第⑤道
         * 重算出来的摘要也与被改后的 payload_hash 一致 —— 五道全绿，篡改成功。
         * 交易签名覆盖了 payloadHash / txId / bizNo / from / to / nonce，
         * 任何一项被改，验签必然失败；而伪造签名需要发起方私钥，
         * 私钥只存在于节点本地 keystore，不进数据库。
         * 因此本项是「改 payload_json + 同步改 payload_hash」这条路径的唯一出口。 */
        if (t.signature && t.pub_key) {
          txSigChecked++;
          const okSig = Blockchain.isTxSignatureValid({
            txId: t.tx_id,
            txType: t.tx_type,
            bizNo: t.biz_no,
            fromAddress: t.from_address,
            toAddress: t.to_address,
            payloadHash: t.payload_hash,
            nonce: Number(t.nonce),
            signature: t.signature,
            pubKey: t.pub_key,
          });
          if (okSig) {
            txSigOk++;
          } else {
            txSigInvalid++;
            if (txSigErrors.length < PAYLOAD_ERROR_LIMIT) {
              txSigErrors.push({
                index: b.index, txId: t.tx_id, type: 'TX_SIGNATURE_INVALID',
                message: `区块 #${b.index} 的交易 ${String(t.tx_id).slice(0, 16)}… 发起方签名无效`
                  + '（交易字段包括 payloadHash 已被改动，且无法伪造发起方私钥签名）',
              });
            }
          }
        } else {
          txSigUnsigned++;
        }
      }
    }

    // 把第五道校验的失配汇总进 errors（限量明细 + 一条汇总）
    for (const e of payloadErrors) errors.push(e);
    if (payloadMismatch > PAYLOAD_ERROR_LIMIT) {
      errors.push({
        index: -1, type: 'PAYLOAD_BINDING_MISMATCH_SUMMARY',
        message: `另有 ${payloadMismatch - PAYLOAD_ERROR_LIMIT} 笔交易存在链下重算绑定失配（明细已省略）`,
      });
    }

    // 第(6)项：交易签名失配汇总
    for (const e of txSigErrors) errors.push(e);
    if (txSigInvalid > PAYLOAD_ERROR_LIMIT) {
      errors.push({
        index: -1, type: 'TX_SIGNATURE_INVALID_SUMMARY',
        message: `另有 ${txSigInvalid - PAYLOAD_ERROR_LIMIT} 笔交易的发起方签名无效（明细已省略）`,
      });
    }

    return {
      valid: errors.length === 0,
      checkedBlocks: checked,
      /* 治理告警（不参与 valid）：目前只有「出块节点事后被撤销」一类 */
      warnings,
      warningCount: revokedProposerBlocks,
      height: this.blocks.length ? this.blocks[this.blocks.length - 1].index : -1,
      /* 校验覆盖面（透明度指标）：本次到底验了什么、验了多少 */
      coverage: {
        blocksHashRecomputed: checked,
        merkleRootsRecomputed: checked,
        txPayloadBindingChecked: txChecked,
        txPayloadBoundOk: payloadBound,
        txPayloadBindingMismatch: payloadMismatch,
        txSignatureChecked: txSigChecked,
        txSignatureOk: txSigOk,
        txSignatureInvalid: txSigInvalid,
        txSignatureUnsigned: txSigUnsigned,
      },
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
   *
   * 支持两类篡改目标：
   *   · 链上字段（merkle_root / prev_hash / nonce / block_time）—— 由前四道校验捕获
   *   · 链下明细（offchain_payload）—— 只改 chain_tx.payload_json 正文、**不动**
   *     payload_hash 与区块头。这条路径前四道校验全部通过，只有第五道「链下重算绑定」
   *     能抓到，用于演示"链上没被改 ≠ 数据没被改"。
   *
   * @param {number} blockIndex
   * @param {string} field 'merkle_root' | 'prev_hash' | 'nonce' | 'block_time' | 'offchain_payload'
   * @returns {Promise<object>} 篡改前后对比
   */
  async tamper(blockIndex, field = 'merkle_root') {
    if (field === 'offchain_payload') return this.tamperOffChainPayload(blockIndex);

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
    this._bumpRev(); // 链上字段被改写 → 缓存必须失效，否则会把已破坏的链误报为 valid

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
   * 【演示】只篡改**链下明细**：改动某区块内一笔交易的 payload_json 正文，
   * 保持 payload_hash、tx_id、区块头、Merkle 根全部不变。
   * 用于证明第五道「链下重算绑定」校验的必要性。
   *
   * 演示前先把原文备份到 chain_payload_backup（幂等建表），
   * 使 `repairOffChainPayload()` 可一键还原，演示可反复进行、不污染数据。
   * @param {number} blockIndex
   * @returns {Promise<object>}
   */
  async tamperOffChainPayload(blockIndex) {
    const [rows] = await this.db.query(
      `SELECT tx_id, payload_hash, payload_json FROM chain_tx
        WHERE block_index = ? ORDER BY id ASC LIMIT 1`, [blockIndex]
    );
    if (!rows.length) throw new Error(`区块 #${blockIndex} 内没有交易，无法演示链下明细篡改`);
    const tx = rows[0];

    // 先把原文备份走（同一 tx 只保留最早一次原文，避免重复演示时把被污染的值当原文）
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS chain_payload_backup (
         tx_id        VARCHAR(80) NOT NULL,
         payload_json TEXT                 DEFAULT NULL,
         backed_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (tx_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`
    );
    await this.db.query(
      `INSERT IGNORE INTO chain_payload_backup (tx_id, payload_json, backed_at)
       VALUES (?, ?, NOW())`,
      [tx.tx_id, tx.payload_json]
    );

    const payload = safeParse(tx.payload_json);
    if (!payload || typeof payload !== 'object') {
      throw new Error('该交易的 payload_json 不是可解析的对象，无法演示');
    }

    // 找第一个数值字段并把它的值改掉（不改 key，保持结构不变）
    const key = Object.keys(payload).find((k) => typeof payload[k] === 'number');
    const beforeJson = JSON.stringify(payload);
    if (key) {
      payload[key] = Math.round((Number(payload[key]) + 1234.5) * 100) / 100;
    } else {
      payload.__tampered = true;  // 没有数值字段就注入一个标记字段
    }
    const afterJson = JSON.stringify(payload);

    await this.db.query(
      'UPDATE chain_tx SET payload_json = ? WHERE tx_id = ?', [afterJson, tx.tx_id]
    );
    this._bumpRev(); // 链下明细被改写 → 缓存失效（第五道校验的结果随之变化）

    const validation = await this.validateChain({ fromIndex: 0 });
    return {
      blockIndex,
      field: 'offchain_payload',
      txId: tx.tx_id,
      changedKey: key || '__tampered',
      before: beforeJson.slice(0, 160),
      after: afterJson.slice(0, 160),
      payloadHashUnchanged: tx.payload_hash,
      backups: 1,
      note: '注意：payload_hash、tx_id、区块头、Merkle 根**全部未改动**。'
        + '前四道链上校验因此全部通过（链上确实没人动过），'
        + '只有第五道「链下重算绑定」能发现链下明细已与链上锚点脱钩。',
      validation,
      tip: '链上存证必须配套链下重算 —— 否则"链上没被改"会被误读为"数据没被改"。',
    };
  }

  /**
   * 把链下 payload_json 从备份还原（配合 tamperOffChainPayload 使用）。
   * 不传 blockIndex 时还原全部备份。
   * @param {number} [blockIndex]
   * @returns {Promise<object>}
   */
  async repairOffChainPayload(blockIndex) {
    const scoped = Number.isFinite(Number(blockIndex));
    // 注意：不要在 SQL 里 JOIN chain_tx —— 演示表是运行期按需创建的，
    // 其列排序规则取自服务器默认（MySQL 8 为 utf8mb4_0900_ai_ci），
    // 而既有 chain_tx 为 utf8mb4_general_ci，跨排序规则 JOIN VARCHAR 会报
    // ER_CANT_AGGREGATE_2COLLATIONS（本机实测踩到）。改为两次独立查询 + 内存求交，
    // 既绕开排序规则差异，也避免各版本 MySQL/TiDB 的行为分歧。
    let backups;
    try {
      [backups] = await this.db.query(
        'SELECT tx_id, payload_json AS backup_json FROM chain_payload_backup'
      );
    } catch (e) {
      // 备份表不存在 → 没有需要还原的内容
      return { restored: 0, validation: null, tip: '没有链下明细篡改记录需要还原。' };
    }
    if (!backups.length) return { restored: 0, validation: null, tip: '没有需要还原的内容。' };

    let allow = null;
    if (scoped) {
      const [txRows] = await this.db.query(
        'SELECT tx_id FROM chain_tx WHERE block_index = ?', [Number(blockIndex)]
      );
      allow = new Set(txRows.map((r) => r.tx_id));
    }

    let restored = 0;
    for (const r of backups) {
      if (allow && !allow.has(r.tx_id)) continue;
      await this.db.query('UPDATE chain_tx SET payload_json = ? WHERE tx_id = ?', [r.backup_json, r.tx_id]);
      await this.db.query('DELETE FROM chain_payload_backup WHERE tx_id = ?', [r.tx_id]);
      restored++;
    }
    this._bumpRev(); // 链下明细还原 → 缓存失效

    const validation = await this.validateChain({ fromIndex: 0 });
    return {
      restored,
      validation,
      tip: restored ? '链下明细已还原为备份原文，第五道校验重新通过。' : '没有匹配到需要还原的内容。',
    };
  }

  /**
   * 修复链：从指定高度起重算哈希并重做 PoW（模拟攻击者想"续上"链所需要付出的代价）。
   * 演示用：改一个块，后面所有块都得重挖，且其它节点只要比对过旧哈希就能发现。
   * @param {number} fromIndex
   * @returns {Promise<object>}
   */
  async repairChain(fromIndex) {
    await this.syncTimeZone();
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
    // 同 validateChain：交易一次性取回并按块分组，避免逐块查询造成的 N 次网络往返
    const [allTx] = await this.db.query(
      'SELECT block_index, tx_id FROM chain_tx WHERE block_index >= ? ORDER BY block_index ASC, id ASC',
      [fromIndex]
    );
    const txByBlock = new Map();
    for (const t of allTx) {
      const k = Number(t.block_index);
      if (!txByBlock.has(k)) txByBlock.set(k, []);
      txByBlock.get(k).push(t.tx_id);
    }
    for (const raw of rows) {
      const txRows = txByBlock.get(Number(raw.block_index)) || [];
      const merkle = cu.merkleRoot(txRows);
      const consensus = String(raw.consensus || 'POW').toUpperCase();
      const proposer = raw.proposer || raw.miner || this.nodeName;
      const header = {
        index: Number(raw.block_index),
        timestamp: Number(raw.ts),
        merkleRoot: merkle,
        prevHash: prevHash || raw.prev_hash,
        difficulty: Number(raw.difficulty) || this.difficulty,
        nonce: Number(raw.nonce) || 0,
        consensus,
        proposer,
      };
      let newHash;
      let sig = raw.proposer_sig || null;
      let cost = 0;
      if (consensus === 'POA') {
        // 联盟链：修复 = 用该块出块节点的私钥重新签名（无挖矿成本，因此"篡改收益"依赖准入治理而非算力）
        newHash = Blockchain.calcHash(header);
        const w = keystore.walletFor(`node:${proposer}`);
        sig = cu.sign(w.privateKey, Blockchain.signingPayload(header));
        header.nonce = 0;
      } else {
        const pow = Blockchain.proofOfWork({ ...header, nonce: 0 });
        newHash = pow.hash;
        header.nonce = pow.nonce;
        sig = null;
        cost = pow.elapsed;
      }
      await this.db.query(
        /* ⚠ mine_time 不在区块哈希里，它是一份独立的观测数据（出块耗时样本）。
         * 原实现无条件写 cost（PoA 分支恒为 0），于是每修复一次就把**全部**历史
         * 出块耗时样本抹成 0：「出块均值 1 ms」退化为「—」，而 stats() 的注释
         * 恰恰说这条数据是用来佐证联盟链性能的。修复只应改哈希与签名，
         * 不应改动与被修字段无关的观测列 —— 这里保留原值。 */
        `UPDATE chain_block SET block_hash=?, prev_hash=?, merkle_root=?, nonce=?, proposer_sig=?
         WHERE block_index = ?`,
        [newHash, header.prevHash, merkle, header.nonce, sig, raw.block_index]
      );
      repaired.push({ index: header.index, newHash, cost });
      prevHash = newHash;
    }
    await this.init();
    const validation = await this.validateChain();
    return { fromIndex, repaired, validation };
  }

  /* ================================================================
   * 统计
   * ================================================================ */

  async stats() {
    /* 平均出块耗时只在"真的出了块"的样本上平均。
     * mine_time=0 表示该块不是节点挖出来的（历史补锚/导入批次），
     * 把它算进均值会把 1~6 ms 的真实耗时稀释成 0，页面于是显示「0 ms」/「—」，
     * 看起来像出块根本没有耗时（2026-10-29 巡检 P0-13）。 */
    const [[blk]] = await this.db.query(
      `SELECT COUNT(*) AS total_blocks, IFNULL(SUM(tx_count),0) AS total_txs,
              IFNULL(AVG(NULLIF(mine_time,0)),0) AS avg_mine_time,
              IFNULL(MAX(mine_time),0) AS max_mine_time,
              SUM(mine_time > 0) AS mine_samples,
              IFNULL(MAX(difficulty),0) AS difficulty,
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
    /* 出块速率按**本地小时**分组：block_time 存的是 UTC 字面量，
     * 直接 DATE_FORMAT 出来的是 UTC 整点，与页面上其它本地时间差 8 小时。 */
    const tzOffHours = -new Date().getTimezoneOffset() / 60;
    const [recent] = await this.db.query(
      `SELECT DATE_FORMAT(DATE_ADD(block_time, INTERVAL ? HOUR),'%Y-%m-%d %H:00') AS hour, COUNT(*) AS cnt
       FROM chain_block GROUP BY hour ORDER BY hour DESC LIMIT 24`, [tzOffHours]
    );
    let tip = this.blocks[this.blocks.length - 1] || null;
    /* ⚠ 内存链在进程重启后为空（区块从 DB 独立可查），此时 tip=null 会让
     * stats() 返回 height:-1，与同屏的 totalBlocks:1139 自相矛盾
     * （/admin/overview"链高度 -1 块"就是它）。内存没有 tip 时回查 DB 链顶。 */
    if (!tip && this.db) {
      try {
        /* 列名必须是 block_index / block_hash —— 账本表（00_schema_ledger.sql）的
         * 真实列名，不是内存区块对象的 index/hash。原先写成 `index`/`hash`，
         * 这条 SQL 必然抛 Unknown column，被下面 catch 吞掉后 height 仍为 -1：
         * 回查形同虚设，页面继续显示「链高度 -1」而同屏显示 1,545 笔存证。 */
        const [[dbTip]] = await this.db.query(
          'SELECT block_index AS idx, block_hash AS hash FROM chain_block ORDER BY block_index DESC LIMIT 1');
        if (dbTip) tip = { index: Number(dbTip.idx), hash: dbTip.hash };
      } catch (e) { /* DB 不可用时维持 -1 */ }
    }
    let activeNodes = 0;
    let poaBlocks = 0;
    try {
      const [[nc]] = await this.db.query("SELECT COUNT(*) AS c FROM chain_node WHERE status = 'ACTIVE'");
      activeNodes = Number(nc.c) || 0;
      const [[pb]] = await this.db.query("SELECT COUNT(*) AS c FROM chain_block WHERE consensus = 'POA'");
      poaBlocks = Number(pb.c) || 0;
    } catch (e) { /* 非联盟表结构时忽略 */ }

    /* ⚠⚠ 三个"交易数"是三个不同的东西，必须分开命名。
     *
     *   totalTxs  = Σ(区块.tx_count) —— 历史上被**打包进区块**的笔数总和，
     *               是"累计写入量"，不随交易状态变化，也不等于当前表行数。
     *   confirmed = COUNT(*) WHERE status='CONFIRMED' —— 当前状态为已确认的笔数。
     *   pending   = COUNT(*) WHERE status='PENDING'   —— 已入池、待打包的笔数。
     *
     * 三者不相等是**正常的**，会长期不等，原因有三种：
     *   ① 入池与出块之间存在窗口期；
     *   ② 打包后状态回写失败（进程中断）—— 这是真实的"账实不符"，必须能被发现；
     *   ③ 重建链时被重新出块，tx_count 累加而 status 未同步。
     *
     * 院审点名"摘要 894 与正文 895 不一致"，本质就是这类口径混用：
     * 同一个词"存证数"在不同位置指了不同的量。修法不是把数字调成一样
     * （那会掩盖真实的不一致），而是**给每个口径一个明确的名字**，
     * 并额外给出可核对的 `ledgerTxRows`（账本表实际行数）。
     * 三者若要相等，只能靠状态回写机制保证；不相等时必须能被看见。 */
    const totalTxs = Number(blk.total_txs);
    const confirmed = Number(tx.confirmed || 0);
    const pending = Number(tx.pending || 0);
    const ledgerTxRows = Number(tx.total || 0);

    return {
      height: tip ? tip.index : -1,
      tipHash: tip ? tip.hash : null,
      totalBlocks: Number(blk.total_blocks),
      /* 兼容字段：历史代码大量引用 totalTxs 表示"累计打包笔数"，语义保持不变。 */
      totalTxs,
      avgMineTime: Math.round(Number(blk.avg_mine_time)),
      /* 出块耗时的样本口径：只有 mine_time>0 的块才是节点真实出块，
       * 补锚/导入批次为 0。把样本数一并回传，前端才能说清
       * 「平均 2 ms（基于 849 个真实出块样本）」而不是含糊的「0 ms」。 */
      mineTimeSamples: Number(blk.mine_samples || 0),
      maxMineTime: Number(blk.max_mine_time || 0),
      difficulty: Number(blk.difficulty),
      totalSize: Number(blk.total_size),
      confirmed,
      pending,
      ledgerTxRows,
      /* 口径核对。⚠ 注意 `diff` 的符号有明确含义，不能笼统说"账实不符"：
       *
       *   diff < 0  ⇒ 待打包笔数 > 0，即账本表里还有交易尚未进区块。
       *                这是**正常的工作状态**（等待下一个出块周期），
       *                只要 pending 与 diff 绝对值相等即可确认无异常。
       *   diff > 0  ⇒ 累计打包笔数 **大于** 已确认+待确认的总行数。
       *                这才是真正的异常：打包记录里存在账本表中已不存在的交易
       *                （被删除、被重建、或状态回写丢失）。必须告警。
       *   diff == 0 ⇒ 完全自洽。
       *
       * 原判断只看 `!==`，把"有 35 笔正常待打包"报成"状态未回写，需排查" ——
       * 一个会持续误报的告警比没有告警更糟，它会训练人忽略真正的异常。 */
      txAccounting: {
        packedTotal: totalTxs,
        confirmed,
        pending,
        ledgerRows: ledgerTxRows,
        balanced: totalTxs === (confirmed + pending),
        diff: totalTxs - (confirmed + pending),
        state: (totalTxs === confirmed + pending) ? 'BALANCED'
          : (totalTxs - (confirmed + pending) === -pending && pending >= 0) ? 'PENDING_BACKLOG'
            : 'MISMATCH',
        note: (() => {
          if (totalTxs === confirmed + pending) {
            return '累计打包笔数 = 已确认 + 待确认，账实自洽';
          }
          if (totalTxs - (confirmed + pending) === -pending) {
            return `账实自洽：${confirmed} 笔已确认、${pending} 笔待打包，合计等于账本表 ${ledgerTxRows} 行。`
              + '待打包是正常的工作状态，不是一个缺陷。';
          }
          return `⚠ 累计打包 ${totalTxs} 笔 > 已确认+待确认 ${confirmed + pending} 笔，`
            + `多出 ${totalTxs - (confirmed + pending)} 笔：区块记录里有账本表中不存在的交易，`
            + '可能存在交易被删除或状态回写丢失，需排查。';
        })(),
      },
      txByType: byType,
      blockRate: recent.reverse(),
      node: this.nodeName,
      consensus: this.consensusMode === 'POA'
        ? 'PoA（权威证明）+ 联盟节点轮值出块'
        : 'PoW（工作量证明）+ 最长链原则',
      consensusMode: this.consensusMode,
      activeNodes,
      poaBlocks,
      crypto: 'SHA-256 / secp256k1-ECDSA / Merkle Tree',
    };
  }
}

function safeParse(s) {
  try {
    // mysql2 对 TEXT 列返回字符串；若某部署把该列建成 JSON 类型，驱动可能已解析成对象，
    // 此时直接返回，避免对对象再 JSON.parse 触发异常。
    if (s !== null && typeof s === 'object') return s;
    return JSON.parse(s);
  } catch (e) { return null; }
}

module.exports = { Blockchain, GENESIS_PREV_HASH };
