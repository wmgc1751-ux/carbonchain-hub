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
      const root = cu.merkleRoot(txs.map((t) => t.txId));
      const prevHash = prev ? prev.hash : GENESIS_PREV_HASH;

      // 按共识类型出块：联盟链默认 PoA（授权节点轮值 + 签名），POW 为历史兼容路径
      const block = this.consensusMode === 'POA'
        ? await this._buildPoaBlock({ index, timestamp, root, prevHash, txs, genesis, opts })
        : this._buildPowBlock({ index, timestamp, root, prevHash, txs, genesis, opts });

      await this.db.query(
        `INSERT INTO chain_block
          (block_index, block_hash, prev_hash, merkle_root, nonce, difficulty, consensus,
           proposer, proposer_sig, tx_count, miner, size_bytes, mine_time, block_time, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
        [
          block.index, block.hash, block.prevHash, block.merkleRoot, block.nonce,
          block.difficulty, block.consensus, block.proposer, block.proposerSig,
          block.txCount, block.miner, block.sizeBytes, block.mineTime,
          // 传字符串而不是 Date 对象：驱动不再做任何本地时区换算，
          // 配合会话 time_zone='+00:00'，写入值与读出秒数在 MySQL / TiDB 上完全一致。
          Blockchain.utcDateString(block.timestamp),
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
    const proposer = await this.pickProposer(index, opts.proposer);
    const header = {
      index, timestamp, merkleRoot: root, prevHash,
      consensus: 'POA', proposer: proposer.nodeId, nonce: 0,
    };
    const hash = Blockchain.calcHash(header);
    const proposerSig = cu.sign(proposer.privateKey, Blockchain.signingPayload(header));
    return {
      index, timestamp, merkleRoot: root, prevHash,
      consensus: 'POA', proposer: proposer.nodeId, nonce: 0, difficulty: 0,
      hash, proposerSig,
      txCount: txs.length, miner: proposer.nodeId, mineTime: 0,
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
   * 全链校验：逐块重算哈希、校验前向引用、校验 PoW、比对 Merkle 根
   * @param {object} opts { fromIndex } 仅校验某高度之后
   * @returns {Promise<object>}
   */
  async validateChain(opts = {}) {
    await this.syncTimeZone();
    const from = opts.fromIndex || 0;
    const [blocks] = await this.db.query(
      'SELECT *, UNIX_TIMESTAMP(block_time) AS ts FROM chain_block WHERE block_index >= ? ORDER BY block_index ASC', [from]
    );
    const errors = [];
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
      'SELECT block_index, tx_id FROM chain_tx WHERE block_index >= ? ORDER BY block_index ASC, id ASC',
      [from]
    );
    const txByBlock = new Map();
    for (const t of allTx) {
      const k = Number(t.block_index);
      if (!txByBlock.has(k)) txByBlock.set(k, []);
      txByBlock.get(k).push(t.tx_id);
    }

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
        const st = nodeStatus.get(b.proposer);
        if (st && (st.status !== 'ACTIVE' || !st.auth)) {
          errors.push({
            index: b.index, type: 'PROPOSER_UNAUTHORIZED',
            message: `区块 #${b.index} 由未获授权的节点 ${b.proposer} 出块（当前状态 ${st.status}）`,
          });
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
        `UPDATE chain_block SET block_hash=?, prev_hash=?, merkle_root=?, nonce=?, proposer_sig=?, mine_time=?
         WHERE block_index = ?`,
        [newHash, header.prevHash, merkle, header.nonce, sig, cost, raw.block_index]
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
    let activeNodes = 0;
    let poaBlocks = 0;
    try {
      const [[nc]] = await this.db.query("SELECT COUNT(*) AS c FROM chain_node WHERE status = 'ACTIVE'");
      activeNodes = Number(nc.c) || 0;
      const [[pb]] = await this.db.query("SELECT COUNT(*) AS c FROM chain_block WHERE consensus = 'POA'");
      poaBlocks = Number(pb.c) || 0;
    } catch (e) { /* 非联盟表结构时忽略 */ }
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
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = { Blockchain, GENESIS_PREV_HASH };
