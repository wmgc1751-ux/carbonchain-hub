/**
 * consortium.js —— 联盟链成员治理与链副本同步
 * ------------------------------------------------------------------
 * 联盟链区别于公有链的两个本质特征，都由本模块落地：
 *
 *   1. 成员准入（许可制）：节点不是随便接入的，必须**申请 → 联盟审批 → 授予出块权**。
 *      未获授权的节点读链可以，但不能出块；被吊销的节点所出的块会被全链校验判为非法。
 *
 *   2. 多方各自持链：每个成员节点维护一份**全量链副本**（chain_node_replica），
 *      落后了可以自动同步追平；任一节点副本的链顶哈希与主链不一致，即可发现异常。
 *      —— 这正是"即使某一方数据库被攻陷，其它节点仍能拒绝被篡改的链"的技术基础。
 *
 * @module services/consortium
 */
'use strict';

const db = require('../db');
const cu = require('../blockchain/crypto-utils');
const keystore = require('../blockchain/keystore');

/** 联盟初始成员（许可制：出块权由联盟授予，权重决定轮值出块机会） */
const SEED_NODES = [
  { node_id: 'node-regulator-01', node_name: '国家碳市场主节点', org_type: 'REGULATOR', org_name: '全国碳排放权注册登记结算机构', vote_weight: 3 },
  { node_id: 'node-verifier-01', node_name: '中环联合核查节点', org_type: 'VERIFIER', org_name: '中环联合（北京）认证中心', vote_weight: 2 },
  { node_id: 'node-verifier-02', node_name: '赛宝认证核查节点', org_type: 'VERIFIER', org_name: '广州赛宝认证中心', vote_weight: 1 },
  { node_id: 'node-enterprise-01', node_name: '华能集团企业节点', org_type: 'ENTERPRISE', org_name: '中国华能集团', vote_weight: 1 },
  { node_id: 'node-auditor-01', node_name: '第三方碳审计节点', org_type: 'AUDITOR', org_name: '独立碳审计机构', vote_weight: 1 },
];

const ORG_TYPE_CN = {
  REGULATOR: '监管机构', VERIFIER: '核查机构', ENTERPRISE: '企业', AUDITOR: '审计机构',
};

/** 注册（或更新）一个联盟成员节点，并为其分配确定性的链上钱包身份 */
async function registerNode(n, extra = {}) {
  const w = keystore.walletFor(`node:${n.node_id}`);
  const status = extra.status || n.status || 'ACTIVE';
  const authorized = status === 'ACTIVE' ? 1 : 0;
  await db.query(
    `INSERT INTO chain_node
       (node_id, node_name, org_type, org_name, wallet_address, public_key, status, is_authorized,
        vote_weight, applied_at, approved_at)
     VALUES (?,?,?,?,?,?,?,?,?,NOW(), ?)
     ON DUPLICATE KEY UPDATE
       node_name = VALUES(node_name), org_type = VALUES(org_type), org_name = VALUES(org_name),
       wallet_address = VALUES(wallet_address), public_key = VALUES(public_key)`,
    [n.node_id, n.node_name, n.org_type, n.org_name || null, w.address, w.publicKey,
      status, authorized, n.vote_weight || 1, status === 'ACTIVE' ? new Date() : null]
  );
  return { node_id: n.node_id, address: w.address };
}

/** 幂等初始化联盟初始成员 */
async function ensureSeed() {
  for (const n of SEED_NODES) await registerNode(n);
  return listNodes();
}

/** 节点列表 */
async function listNodes() {
  const rows = await db.query(
    `SELECT n.*,
            (SELECT COUNT(*) FROM chain_node_replica r WHERE r.node_id = n.node_id) AS replica_blocks
     FROM chain_node n
     ORDER BY (n.status = 'ACTIVE') DESC, n.vote_weight DESC, n.id`
  );
  const main = await db.one('SELECT block_index, block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1');
  const mainH = main ? Number(main.block_index) : -1;
  return rows.map((r) => ({
    id: Number(r.id),
    nodeId: r.node_id,
    nodeName: r.node_name,
    orgType: r.org_type,
    orgTypeCn: ORG_TYPE_CN[r.org_type] || r.org_type,
    orgName: r.org_name,
    walletAddress: r.wallet_address,
    status: r.status,
    isAuthorized: !!Number(r.is_authorized),
    voteWeight: Number(r.vote_weight),
    proposedBlocks: Number(r.proposed_blocks),
    lastProposeAt: r.last_propose_at,
    replicaHeight: Number(r.replica_height),
    replicaBlocks: Number(r.replica_blocks),
    replicaTip: r.replica_tip,
    lag: mainH - Number(r.replica_height),
    consistent: Number(r.replica_height) === mainH && r.replica_tip === (main ? main.block_hash : null),
    appliedAt: r.applied_at,
    approvedAt: r.approved_at,
    remark: r.remark,
  }));
}

/** 申请加入（PENDING，无出块权，需联盟审批） */
async function applyNode({ nodeId, nodeName, orgType, orgName, remark }) {
  if (!nodeId || !nodeName) throw new Error('缺少节点标识或名称');
  const exist = await db.one('SELECT id FROM chain_node WHERE node_id = ?', [nodeId]);
  if (exist) throw new Error('该节点标识已存在');
  await registerNode({ node_id: nodeId, node_name: nodeName, org_type: orgType || 'ENTERPRISE', org_name: orgName, vote_weight: 1 },
    { status: 'PENDING' });
  await db.query("UPDATE chain_node SET remark = ? WHERE node_id = ?", [remark || '等待联盟审批', nodeId]);
  return db.one('SELECT * FROM chain_node WHERE node_id = ?', [nodeId]);
}

/** 审批通过：授予出块权（联盟许可制的核心动作） */
async function approveNode(nodeId, weight) {
  const n = await db.one('SELECT * FROM chain_node WHERE node_id = ?', [nodeId]);
  if (!n) throw new Error('节点不存在');
  await db.query(
    "UPDATE chain_node SET status='ACTIVE', is_authorized=1, vote_weight=?, approved_at=NOW(), remark=? WHERE node_id=?",
    [Math.max(1, Number(weight) || 1), '联盟审批通过，已授予出块权', nodeId]
  );
  return db.one('SELECT * FROM chain_node WHERE node_id = ?', [nodeId]);
}

/**
 * 吊销节点：撤销其出块权。
 * 治理效果：该节点此后无法合法出块；若它仍试图出块，全链校验会以
 * PROPOSER_UNAUTHORIZED 报警（见 chain.js#validateChain）。
 */
async function revokeNode(nodeId, reason) {
  const n = await db.one('SELECT * FROM chain_node WHERE node_id = ?', [nodeId]);
  if (!n) throw new Error('节点不存在');
  await db.query(
    "UPDATE chain_node SET status='REVOKED', is_authorized=0, remark=? WHERE node_id=?",
    [reason || '联盟决议吊销其出块资格', nodeId]
  );
  return db.one('SELECT * FROM chain_node WHERE node_id = ?', [nodeId]);
}

/**
 * 同步某节点的链副本到主链最新高度。
 * 从该节点当前副本高度之后逐块补拉 —— 这就是"节点间区块同步"的最小实现。
 */
async function syncNode(nodeId, opts = {}) {
  const node = await db.one('SELECT * FROM chain_node WHERE node_id = ?', [nodeId]);
  if (!node) throw new Error('节点不存在');
  const from = opts.from !== undefined ? Math.max(0, Number(opts.from)) : Math.max(0, Number(node.replica_height) + 1);
  const blocks = await db.query(
    'SELECT block_index, block_hash FROM chain_block WHERE block_index >= ? ORDER BY block_index ASC', [from]
  );
  if (!blocks.length) return { nodeId, synced: 0, height: Number(node.replica_height), tipHash: node.replica_tip };

  const vals = blocks.map((b) => [nodeId, Number(b.block_index), b.block_hash]);
  const ph = vals.map(() => '(?,?,?,NOW())').join(',');
  await db.query(
    `INSERT INTO chain_node_replica (node_id, block_index, block_hash, synced_at) VALUES ${ph}
     ON DUPLICATE KEY UPDATE block_hash = VALUES(block_hash), synced_at = NOW()`,
    vals.flat()
  );
  const tip = blocks[blocks.length - 1];
  await db.query('UPDATE chain_node SET replica_height = ?, replica_tip = ? WHERE node_id = ?',
    [Number(tip.block_index), tip.block_hash, nodeId]);
  return { nodeId, synced: blocks.length, height: Number(tip.block_index), tipHash: tip.block_hash };
}

/** 令某节点"落后"到指定高度（模拟节点宕机/离线后链副本陈旧） */
async function desyncNode(nodeId, keepHeight) {
  const h = Math.max(0, Number(keepHeight));
  await db.query('DELETE FROM chain_node_replica WHERE node_id = ? AND block_index > ?', [nodeId, h]);
  const tip = await db.one('SELECT block_hash FROM chain_block WHERE block_index = ?', [h]);
  await db.query('UPDATE chain_node SET replica_height = ?, replica_tip = ? WHERE node_id = ?',
    [h, tip ? tip.block_hash : null, nodeId]);
  return { nodeId, height: h };
}

/** 全部 ACTIVE 节点同步到最新 */
async function syncAll() {
  const nodes = await db.query("SELECT node_id FROM chain_node WHERE status = 'ACTIVE' ORDER BY id");
  const results = [];
  for (const n of nodes) results.push(await syncNode(n.node_id));
  return results;
}

/**
 * 副本一致性总览：主链高度 + 各节点副本高度/落后块数/链顶是否一致。
 * "某节点链顶哈希 ≠ 主链链顶哈希" 就是该节点被篡改或分叉的直接证据。
 */
async function replicaStatus() {
  const main = await db.one('SELECT block_index, block_hash FROM chain_block ORDER BY block_index DESC LIMIT 1');
  const mainH = main ? Number(main.block_index) : -1;
  const nodes = await db.query(
    'SELECT node_id, node_name, org_type, status, replica_height, replica_tip FROM chain_node ORDER BY id'
  );
  const items = nodes.map((n) => {
    const height = Number(n.replica_height);
    const consistent = height === mainH && n.replica_tip === (main ? main.block_hash : null);
    return {
      nodeId: n.node_id, nodeName: n.node_name, orgType: n.org_type, status: n.status,
      height, lag: mainH - height, tipHash: n.replica_tip, consistent,
    };
  });
  return {
    mainHeight: mainH,
    mainTip: main ? main.block_hash : null,
    totalNodes: items.length,
    consistentNodes: items.filter((i) => i.consistent).length,
    laggingNodes: items.filter((i) => i.lag > 0).length,
    nodes: items,
  };
}

module.exports = {
  SEED_NODES, ORG_TYPE_CN,
  registerNode, ensureSeed, listNodes, applyNode, approveNode, revokeNode,
  syncNode, desyncNode, syncAll, replicaStatus,
};
