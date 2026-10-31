-- =====================================================================
--  碳链通 CarbonChain Hub —— 联盟链账本库（独立物理库）
--  文件: db/00_schema_ledger.sql
--  说明: 本文件为纯 DDL，只包含【链上账本】5 张表：
--          chain_block            区块
--          chain_tx               链上交易（业务动作的可信存证）
--          chain_payload_backup   链下明细篡改演示的原文备份
--          chain_node             联盟节点与出块权
--          chain_node_replica     多方持链副本
--        与业务库 carbon_chain 分开建库、分开授权，是「链库与业务库物理分离」
--        整改的落地文件（见论文 §3.2.6 与 §5.2）。
--
--        ⚠ 为什么要独立成库（而非同库不同表）：
--          同库时，一个拥有业务表写权限的账号，一条 UPDATE 就能同时改掉
--          「链下明文」与「链上锚点」，五道校验里没有任何一道会报警；
--          独立成库后，业务侧账号对该库无写权限，"一条 UPDATE 同改"在
--          权限层即被拒绝；即使 DBA 越权同改，也必须面对密码学校验
--          （payload_hash → merkle_root → block_hash → 出块签名逐层失配）。
-- =====================================================================

DROP DATABASE IF EXISTS carbon_chain_ledger;
CREATE DATABASE carbon_chain_ledger DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE carbon_chain_ledger;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- 12. chain_block  区块链区块表（联盟链：哈希链 + Merkle 根 + PoA 授权出块）
-- ---------------------------------------------------------------------
CREATE TABLE chain_block (
  id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  block_index BIGINT       NOT NULL                COMMENT '区块高度',
  block_hash  VARCHAR(80)  NOT NULL                COMMENT '区块哈希(SHA-256)',
  prev_hash   VARCHAR(80)  NOT NULL                COMMENT '前一区块哈希',
  merkle_root VARCHAR(80)  NOT NULL                COMMENT '交易 Merkle 根',
  nonce       BIGINT       NOT NULL DEFAULT 0      COMMENT '随机数(历史 PoW 块为该块工作量证明的 nonce)',
  difficulty  INT          NOT NULL DEFAULT 0      COMMENT '难度(历史 PoW 块为前导零个数；PoA 块为 0)',
  consensus   VARCHAR(10)  NOT NULL DEFAULT 'POA'  COMMENT '共识类型: POA 授权证明 / POW 工作量证明(历史块)',
  proposer    VARCHAR(80)           DEFAULT NULL   COMMENT '本轮出块的联盟授权节点标识',
  proposer_sig VARCHAR(255)         DEFAULT NULL   COMMENT '出块节点对区块头的 ECDSA 签名',
  tx_count    INT          NOT NULL DEFAULT 0      COMMENT '打包交易数',
  miner       VARCHAR(80)           DEFAULT NULL   COMMENT '出块节点标识',
  size_bytes  INT          NOT NULL DEFAULT 0      COMMENT '区块大小(字节)',
  mine_time   BIGINT       NOT NULL DEFAULT 0      COMMENT '出块耗时(毫秒)',
  block_time  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '出块时间',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '落库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_block_index (block_index),
  KEY idx_block_hash (block_hash),
  KEY idx_block_time (block_time),
  KEY idx_block_proposer (proposer)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='联盟链区块表';


-- ---------------------------------------------------------------------
-- 13. chain_tx  链上交易（业务动作的可信存证）
-- ---------------------------------------------------------------------
CREATE TABLE chain_tx (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  tx_id         VARCHAR(80)  NOT NULL                COMMENT '交易号(SHA-256 摘要)',
  tx_type       VARCHAR(30)  NOT NULL                COMMENT '类型: EMISSION_REPORT 排放上报 / VERIFY_REPORT 核查报告 / QUOTA_ALLOC 配额分配 / TRADE_DEAL 交易成交 / ENTERPRISE_REG 企业备案',
  biz_no        VARCHAR(40)           DEFAULT NULL   COMMENT '关联业务单号',
  block_index   BIGINT                DEFAULT NULL   COMMENT '所属区块高度(NULL 表示在内存池中)',
  from_address  VARCHAR(80)           DEFAULT NULL   COMMENT '发起方钱包地址',
  to_address    VARCHAR(80)           DEFAULT NULL   COMMENT '接收方钱包地址',
  payload_hash  VARCHAR(80)  NOT NULL                COMMENT '业务数据 SHA-256 摘要',
  payload_json  TEXT                  DEFAULT NULL   COMMENT '业务数据快照',
  signature     VARCHAR(255)          DEFAULT NULL   COMMENT '发起方 ECDSA 数字签名(secp256k1)',
  pub_key       TEXT                  DEFAULT NULL   COMMENT '发起方公钥 PEM',
  nonce         BIGINT       NOT NULL DEFAULT 0      COMMENT '交易序号(防重放)',
  gas_fee       DECIMAL(12,4) NOT NULL DEFAULT 0      COMMENT '存证手续费(碳积分)',
  status        VARCHAR(20)  NOT NULL DEFAULT 'CONFIRMED' COMMENT '状态: PENDING 待打包 / CONFIRMED 已确认 / FAILED 失败',
  anchor_batch_no VARCHAR(40)         DEFAULT NULL   COMMENT '所属批量锚定批次号(NULL 表示尚未被批量锚定)',
  anchor_status VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT '锚定状态: PENDING 待锚定 / BATCHED 已入批 / ANCHORED 已锚定 / SELF 自身即锚点',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发起时间',
  confirmed_at  DATETIME              DEFAULT NULL   COMMENT '确认时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_tx_id (tx_id),
  KEY idx_tx_block (block_index),
  KEY idx_tx_type (tx_type),
  KEY idx_tx_status (status),
  KEY idx_tx_anchor (anchor_status, block_index),
  KEY idx_tx_batch (anchor_batch_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='链上存证交易表';


-- ---------------------------------------------------------------------
-- 13b. chain_payload_backup  链下明细篡改演示的原文备份
--      仅用于「篡改链下明细 → 第五道校验告警 → 一键还原」的演示闭环，
--      保证演示可反复进行、不污染链下业务数据。正式业务流程不写入本表。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chain_payload_backup (
  tx_id        VARCHAR(80) NOT NULL           COMMENT '被篡改的交易号',
  payload_json TEXT                 DEFAULT NULL COMMENT '篡改前的链下明文负载（原文备份）',
  backed_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '备份时间',
  PRIMARY KEY (tx_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='链下明细篡改演示原文备份';


-- ---------------------------------------------------------------------
-- 17. chain_node  联盟链成员节点（准入白名单 + 出块权 + 副本状态）
--     联盟链的本质：参与方是"许可制"的成员，各成员节点共同出块并各自持链。
-- ---------------------------------------------------------------------
CREATE TABLE chain_node (
  id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  node_id         VARCHAR(40)  NOT NULL                COMMENT '节点标识 如 node-regulator-01',
  node_name       VARCHAR(80)  NOT NULL                COMMENT '节点名称',
  org_type        VARCHAR(20)  NOT NULL                COMMENT '机构类型: REGULATOR 监管 / VERIFIER 核查 / ENTERPRISE 企业 / AUDITOR 审计',
  org_name        VARCHAR(120)          DEFAULT NULL   COMMENT '所属机构名称',
  wallet_address  VARCHAR(80)           DEFAULT NULL   COMMENT '节点钱包地址(链上身份)',
  public_key      TEXT                  DEFAULT NULL   COMMENT '节点公钥 PEM(用于验证该节点的出块签名)',
  status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT '状态: PENDING 待审批 / ACTIVE 已授权 / REVOKED 已吊销',
  is_authorized   TINYINT      NOT NULL DEFAULT 0      COMMENT '是否具备出块权(联盟授权)',
  vote_weight     INT          NOT NULL DEFAULT 1      COMMENT '轮值权重(权重越高被选中出块的概率越大)',
  last_propose_at DATETIME              DEFAULT NULL   COMMENT '最近一次出块时间',
  proposed_blocks INT          NOT NULL DEFAULT 0      COMMENT '累计出块数',
  replica_height  BIGINT       NOT NULL DEFAULT -1     COMMENT '本地链副本已同步高度(-1 表示尚未同步)',
  replica_tip     VARCHAR(80)           DEFAULT NULL   COMMENT '本地副本链顶哈希',
  applied_at      DATETIME              DEFAULT NULL   COMMENT '申请加入时间',
  approved_at     DATETIME              DEFAULT NULL   COMMENT '审批通过时间',
  remark          VARCHAR(255)          DEFAULT NULL   COMMENT '备注/审批意见',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_node_id (node_id),
  KEY idx_node_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='联盟链成员节点表';


-- ---------------------------------------------------------------------
-- 18. chain_node_replica  各成员节点的本地链副本
--     每同步一个区块插一行，用于证明"每个节点各自持有全量链副本"，
--     并可对比各节点链顶哈希是否与主链一致（可发现被篡改的节点）。
-- ---------------------------------------------------------------------
CREATE TABLE chain_node_replica (
  id          BIGINT      NOT NULL AUTO_INCREMENT COMMENT '主键',
  node_id     VARCHAR(40) NOT NULL                COMMENT '节点标识',
  block_index BIGINT      NOT NULL                COMMENT '已同步到的区块高度',
  block_hash  VARCHAR(80) NOT NULL                COMMENT '该高度区块哈希(副本中保存的值)',
  synced_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '同步时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_replica_node_block (node_id, block_index),
  KEY idx_replica_node (node_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='联盟节点链副本表';

SET FOREIGN_KEY_CHECKS = 1;
