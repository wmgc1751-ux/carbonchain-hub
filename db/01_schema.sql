-- =====================================================================
--  碳链通 CarbonChain Hub —— 企业碳足迹存证与碳配额交易平台
--  数据库结构定义脚本 (MySQL 8.0)
--  文件: db/01_schema.sql
--  说明: 本文件为纯 DDL，不含数据。数据由 server/scripts/init-db.js 生成，
--        并可导出为 db/02_seed_data.sql，方便直接导入还原。
-- =====================================================================

DROP DATABASE IF EXISTS carbon_chain;
CREATE DATABASE carbon_chain DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE carbon_chain;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- 1. sys_user  统一用户账号表（四端共用一套账号体系，靠 role 区分身份）
-- ---------------------------------------------------------------------
CREATE TABLE sys_user (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  username      VARCHAR(50)  NOT NULL                COMMENT '登录账号',
  password      VARCHAR(128) NOT NULL                COMMENT '口令摘要 = SHA256(salt + 明文)',
  salt          VARCHAR(32)  NOT NULL                COMMENT '口令盐值',
  real_name     VARCHAR(50)           DEFAULT NULL   COMMENT '姓名',
  role          VARCHAR(20)  NOT NULL                COMMENT '角色: ENTERPRISE 企业端 / VERIFIER 核查机构端 / REGULATOR 监管端 / ADMIN 系统管理',
  org_id        BIGINT                DEFAULT NULL   COMMENT '所属组织ID(企业ID或核查机构ID)',
  org_name      VARCHAR(120)          DEFAULT NULL   COMMENT '所属组织名称快照',
  phone         VARCHAR(20)           DEFAULT NULL   COMMENT '手机号',
  email         VARCHAR(80)           DEFAULT NULL   COMMENT '邮箱',
  avatar        VARCHAR(255)          DEFAULT NULL   COMMENT '头像',
  status        TINYINT      NOT NULL DEFAULT 1      COMMENT '状态 1启用 0停用',
  last_login    DATETIME              DEFAULT NULL   COMMENT '最近登录时间',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_username (username),
  KEY idx_user_role (role),
  KEY idx_user_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='统一用户账号表';

-- ---------------------------------------------------------------------
-- 2. enterprise  控排企业名录
-- ---------------------------------------------------------------------
CREATE TABLE enterprise (
  id             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_code       VARCHAR(32)  NOT NULL                COMMENT '统一社会信用代码',
  ent_name       VARCHAR(120) NOT NULL                COMMENT '企业名称',
  short_name     VARCHAR(60)           DEFAULT NULL   COMMENT '企业简称',
  industry       VARCHAR(40)  NOT NULL                COMMENT '所属行业: 电力/钢铁/建材/化工/有色金属/造纸/石化',
  region         VARCHAR(40)  NOT NULL                COMMENT '所在省级行政区',
  city           VARCHAR(40)           DEFAULT NULL   COMMENT '所在城市',
  scale          VARCHAR(20)           DEFAULT NULL   COMMENT '规模: 大型/中型/小型',
  legal_person   VARCHAR(50)           DEFAULT NULL   COMMENT '法定代表人',
  contact_phone  VARCHAR(20)           DEFAULT NULL   COMMENT '联系电话',
  reg_capital    DECIMAL(18,2)         DEFAULT 0      COMMENT '注册资本(万元)',
  annual_output  DECIMAL(18,2)         DEFAULT 0      COMMENT '年产值(万元)',
  headcount      INT                   DEFAULT 0      COMMENT '员工人数',
  wallet_address VARCHAR(80)           DEFAULT NULL   COMMENT '链上钱包地址(secp256k1公钥压缩后派生)',
  pub_key        TEXT                  DEFAULT NULL   COMMENT '钱包公钥 PEM',
  credit_score   INT          NOT NULL DEFAULT 100    COMMENT '碳信用分(0-100)',
  status         VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT '状态: ACTIVE 正常 / WATCH 关注 / SUSPENDED 暂停交易',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '纳入控排时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ent_code (ent_code),
  KEY idx_ent_industry (industry),
  KEY idx_ent_region (region)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='控排企业名录表';

-- ---------------------------------------------------------------------
-- 3. verifier_org  第三方核查机构
-- ---------------------------------------------------------------------
CREATE TABLE verifier_org (
  id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  org_code     VARCHAR(32)  NOT NULL                COMMENT '机构备案编号',
  org_name     VARCHAR(120) NOT NULL                COMMENT '机构名称',
  region       VARCHAR(40)  NOT NULL                COMMENT '所在省份',
  license_no   VARCHAR(60)           DEFAULT NULL   COMMENT '资质证书编号',
  director     VARCHAR(50)           DEFAULT NULL   COMMENT '负责人',
  contact_phone VARCHAR(20)          DEFAULT NULL   COMMENT '联系电话',
  staff_count  INT          NOT NULL DEFAULT 0      COMMENT '专职核查员数量',
  level        VARCHAR(20)  NOT NULL DEFAULT 'B'    COMMENT '资质等级: A / B / C',
  done_tasks   INT          NOT NULL DEFAULT 0      COMMENT '累计完成核查任务数',
  pass_rate    DECIMAL(5,2) NOT NULL DEFAULT 0      COMMENT '报告一次性通过率(%)',
  rating       DECIMAL(3,1) NOT NULL DEFAULT 5.0    COMMENT '综合评级(0-5)',
  wallet_address VARCHAR(80)         DEFAULT NULL   COMMENT '链上钱包地址',
  pub_key      TEXT                  DEFAULT NULL   COMMENT '机构签名公钥 PEM（用于核验其出具的核查报告存证）',
  status       VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT '状态',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '备案时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_verifier_code (org_code),
  KEY idx_verifier_region (region)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='第三方核查机构表';

-- ---------------------------------------------------------------------
-- 4. emission_report  企业碳排放数据上报单（Scope1 直接排放 + Scope2 间接排放）
-- ---------------------------------------------------------------------
CREATE TABLE emission_report (
  id               BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  report_no        VARCHAR(40)  NOT NULL                COMMENT '上报单号',
  ent_id           BIGINT       NOT NULL                COMMENT '企业ID',
  year             INT          NOT NULL                COMMENT '核算年度',
  quarter          INT          NOT NULL                COMMENT '核算季度 1-4',
  period           VARCHAR(10)  NOT NULL                COMMENT '报告期 形如 2025Q3',
  scope1_emission  DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '范围一排放量(tCO2e)',
  scope2_emission  DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '范围二排放量(tCO2e)',
  total_emission   DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '排放总量(tCO2e)',
  energy_consumption DECIMAL(14,2) NOT NULL DEFAULT 0   COMMENT '综合能耗(吨标准煤)',
  output_value     DECIMAL(16,2) NOT NULL DEFAULT 0     COMMENT '报告期产值(万元)',
  intensity        DECIMAL(12,4) NOT NULL DEFAULT 0     COMMENT '排放强度(tCO2e/万元)',
  yoy_rate         DECIMAL(8,2)  NOT NULL DEFAULT 0     COMMENT '同比变化率(%)',
  data_source      VARCHAR(40)           DEFAULT NULL   COMMENT '数据来源: 在线监测/物料衡算/排放因子',
  status           VARCHAR(20)  NOT NULL DEFAULT 'DRAFT' COMMENT '状态: DRAFT 草稿 / SUBMITTED 已提交待核查 / VERIFYING 核查中 / VERIFIED 已核查 / REJECTED 已驳回',
  verifier_id      BIGINT                DEFAULT NULL   COMMENT '承接受托的核查机构ID',
  submit_time      DATETIME              DEFAULT NULL   COMMENT '提交时间',
  verify_time      DATETIME              DEFAULT NULL   COMMENT '核查完成时间',
  chain_block_index INT                 DEFAULT NULL   COMMENT '存证所在区块高度',
  chain_tx_id      VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  attachment       VARCHAR(255)          DEFAULT NULL   COMMENT '佐证材料',
  remark           VARCHAR(500)          DEFAULT NULL   COMMENT '备注',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_report_no (report_no),
  KEY idx_report_ent (ent_id),
  KEY idx_report_status (status),
  KEY idx_report_period (period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业碳排放数据上报单';

-- ---------------------------------------------------------------------
-- 5. emission_item  上报单的能源消耗明细行
-- ---------------------------------------------------------------------
CREATE TABLE emission_item (
  id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  report_id    BIGINT       NOT NULL                COMMENT '所属上报单ID',
  ent_id       BIGINT       NOT NULL                COMMENT '企业ID(冗余,便于统计)',
  energy_type  VARCHAR(30)  NOT NULL                COMMENT '能源品种: 原煤/焦炭/天然气/柴油/燃料油/电力/热力',
  scope        TINYINT      NOT NULL DEFAULT 1      COMMENT '排放范围 1直接 2间接',
  amount       DECIMAL(16,3) NOT NULL DEFAULT 0     COMMENT '消耗量',
  unit         VARCHAR(10)  NOT NULL DEFAULT 't'    COMMENT '计量单位',
  factor       DECIMAL(14,6) NOT NULL DEFAULT 0     COMMENT '排放因子',
  co2          DECIMAL(14,3) NOT NULL DEFAULT 0     COMMENT '折算排放量(tCO2e)',
  calc_method  VARCHAR(30)           DEFAULT NULL   COMMENT '计算方法',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  KEY idx_item_report (report_id),
  KEY idx_item_ent (ent_id),
  KEY idx_item_type (energy_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='碳排放上报明细行';

-- ---------------------------------------------------------------------
-- 6. verify_task  核查任务（企业与核查机构的委托关系）
-- ---------------------------------------------------------------------
CREATE TABLE verify_task (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  task_no       VARCHAR(40)  NOT NULL                COMMENT '任务编号',
  report_id     BIGINT       NOT NULL                COMMENT '关联上报单ID',
  ent_id        BIGINT       NOT NULL                COMMENT '申请企业ID',
  verifier_id   BIGINT       NOT NULL                COMMENT '承接核查机构ID',
  verifier_user VARCHAR(50)           DEFAULT NULL   COMMENT '主责核查员账号',
  task_type     VARCHAR(20)  NOT NULL DEFAULT 'ROUTINE' COMMENT '任务类型: ROUTINE 常规核查 / RECHECK 复查 / RANDOM 抽查',
  priority      VARCHAR(10)  NOT NULL DEFAULT 'NORMAL'  COMMENT '优先级 HIGH/NORMAL/LOW',
  status        VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT '状态: PENDING 待接单 / PROCESSING 核查中 / DONE 已完成 / REJECTED 已驳回',
  assign_time   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '派单时间',
  deadline      DATETIME              DEFAULT NULL   COMMENT '要求完成时间',
  finish_time   DATETIME              DEFAULT NULL   COMMENT '实际完成时间',
  reject_reason VARCHAR(500)          DEFAULT NULL   COMMENT '驳回原因',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_task_no (task_no),
  KEY idx_task_verifier (verifier_id),
  KEY idx_task_status (status),
  KEY idx_task_ent (ent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='第三方核查任务表';

-- ---------------------------------------------------------------------
-- 7. verify_report  核查报告（核查结论上链存证）
-- ---------------------------------------------------------------------
CREATE TABLE verify_report (
  id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  report_no       VARCHAR(40)  NOT NULL                COMMENT '核查报告编号',
  task_id         BIGINT       NOT NULL                COMMENT '关联核查任务ID',
  emission_report_id BIGINT    NOT NULL                COMMENT '关联上报单ID',
  ent_id          BIGINT       NOT NULL                COMMENT '被核查企业ID',
  verifier_id     BIGINT       NOT NULL                COMMENT '出具机构ID',
  declared_value  DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '企业申报值(tCO2e)',
  verified_value  DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '核查认定值(tCO2e)',
  deviation_rate  DECIMAL(8,2) NOT NULL DEFAULT 0      COMMENT '偏差率(%)',
  conclusion      VARCHAR(20)  NOT NULL DEFAULT 'PASS' COMMENT '结论: PASS 通过 / FAIL 不通过 / CONDITIONAL 有条件通过',
  opinion         VARCHAR(500)          DEFAULT NULL   COMMENT '核查意见',
  auditor         VARCHAR(50)           DEFAULT NULL   COMMENT '主核查员',
  seal_hash       VARCHAR(80)           DEFAULT NULL   COMMENT '报告电子签章摘要',
  chain_block_index INT                 DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id     VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  issue_time      DATETIME              DEFAULT NULL   COMMENT '签发时间',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_vreport_no (report_no),
  KEY idx_vreport_ent (ent_id),
  KEY idx_vreport_verifier (verifier_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核查报告表';

-- ---------------------------------------------------------------------
-- 8. carbon_quota  企业碳配额账户（按年度一户一行）
-- ---------------------------------------------------------------------
CREATE TABLE carbon_quota (
  id             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id         BIGINT       NOT NULL                COMMENT '企业ID',
  year           INT          NOT NULL                COMMENT '配额年度',
  total_allocated DECIMAL(14,2) NOT NULL DEFAULT 0    COMMENT '累计免费分配配额(tCO2e)',
  available      DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '当前可用余额(tCO2e)',
  frozen         DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '挂单冻结量(tCO2e)',
  used           DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '已用于履约的配额(tCO2e)',
  bought         DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '累计买入(tCO2e)',
  sold           DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '累计卖出(tCO2e)',
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_quota_ent_year (ent_id, year),
  KEY idx_quota_year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业碳配额账户表';

-- ---------------------------------------------------------------------
-- 9. quota_allocation  配额分配流水（监管端下发，逐笔上链）
-- ---------------------------------------------------------------------
CREATE TABLE quota_allocation (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  alloc_no      VARCHAR(40)  NOT NULL                COMMENT '分配单号',
  ent_id        BIGINT       NOT NULL                COMMENT '企业ID',
  year          INT          NOT NULL                COMMENT '年度',
  quota_amount  DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '分配量(tCO2e)',
  alloc_type    VARCHAR(20)  NOT NULL DEFAULT 'FREE' COMMENT '类型: FREE 免费分配 / AUCTION 有偿竞价 / BUYBACK 政府回购',
  alloc_method  VARCHAR(30)           DEFAULT NULL   COMMENT '核定方法: 历史强度法 / 行业基准线法 / 历史总量法',
  baseline_intensity DECIMAL(12,4)     DEFAULT NULL   COMMENT '基准强度(tCO2e/万元)',
  operator      VARCHAR(50)           DEFAULT NULL   COMMENT '操作人',
  chain_block_index INT              DEFAULT NULL   COMMENT '上链区块高度',
  chain_tx_id   VARCHAR(80)           DEFAULT NULL   COMMENT '上链交易号',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '分配时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_alloc_no (alloc_no),
  KEY idx_alloc_ent (ent_id),
  KEY idx_alloc_year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='碳配额分配流水表';

-- ---------------------------------------------------------------------
-- 10. trade_order  碳配额交易挂单
-- ---------------------------------------------------------------------
CREATE TABLE trade_order (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  order_no      VARCHAR(40)  NOT NULL                COMMENT '委托单号',
  ent_id        BIGINT       NOT NULL                COMMENT '挂单企业ID',
  side          VARCHAR(10)  NOT NULL                COMMENT '方向: BUY 买入 / SELL 卖出',
  price         DECIMAL(10,2) NOT NULL DEFAULT 0     COMMENT '委托单价(元/吨)',
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '委托数量(tCO2e)',
  filled_amount DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '已成交数量(tCO2e)',
  status        VARCHAR(20)  NOT NULL DEFAULT 'OPEN' COMMENT '状态: OPEN 挂单中 / PARTIAL 部分成交 / FILLED 已成交 / CANCELLED 已撤单',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '挂单时间',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_order_ent (ent_id),
  KEY idx_order_status (status),
  KEY idx_order_side (side)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='碳配额交易挂单表';

-- ---------------------------------------------------------------------
-- 11. trade_deal  成交记录
-- ---------------------------------------------------------------------
CREATE TABLE trade_deal (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  deal_no       VARCHAR(40)  NOT NULL                COMMENT '成交编号',
  buy_order_id  BIGINT                DEFAULT NULL   COMMENT '买方委托单ID',
  sell_order_id BIGINT                DEFAULT NULL   COMMENT '卖方委托单ID',
  buyer_ent_id  BIGINT       NOT NULL                COMMENT '买方企业ID',
  seller_ent_id BIGINT       NOT NULL                COMMENT '卖方企业ID',
  price         DECIMAL(10,2) NOT NULL DEFAULT 0     COMMENT '成交单价(元/吨)',
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0     COMMENT '成交数量(tCO2e)',
  total_amount  DECIMAL(16,2) NOT NULL DEFAULT 0     COMMENT '成交金额(元)',
  fee           DECIMAL(12,2) NOT NULL DEFAULT 0     COMMENT '交易手续费(元)',
  deal_time     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '成交时间',
  chain_block_index INT              DEFAULT NULL   COMMENT '上链区块高度',
  chain_tx_id   VARCHAR(80)           DEFAULT NULL   COMMENT '上链交易号',
  status        VARCHAR(20)  NOT NULL DEFAULT 'SETTLED' COMMENT '状态: SETTLED 已清算 / REVOKED 已撤销',
  PRIMARY KEY (id),
  UNIQUE KEY uk_deal_no (deal_no),
  KEY idx_deal_buyer (buyer_ent_id),
  KEY idx_deal_seller (seller_ent_id),
  KEY idx_deal_time (deal_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='碳配额成交记录表';

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
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发起时间',
  confirmed_at  DATETIME              DEFAULT NULL   COMMENT '确认时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_tx_id (tx_id),
  KEY idx_tx_block (block_index),
  KEY idx_tx_type (tx_type),
  KEY idx_tx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='链上存证交易表';

-- ---------------------------------------------------------------------
-- 14. alert_record  监管预警记录
-- ---------------------------------------------------------------------
CREATE TABLE alert_record (
  id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  alert_no    VARCHAR(40)  NOT NULL                COMMENT '预警编号',
  ent_id      BIGINT                DEFAULT NULL   COMMENT '关联企业ID',
  alert_type  VARCHAR(30)  NOT NULL                COMMENT '类型: OVER_QUOTA 超配额 / DATA_ABNORMAL 数据异常 / MISSING_REPORT 漏报 / PRICE_ANOMALY 价格异动 / CHAIN_RISK 链上风险',
  level       VARCHAR(10)  NOT NULL DEFAULT 'MEDIUM' COMMENT '级别: LOW / MEDIUM / HIGH',
  title       VARCHAR(120) NOT NULL                COMMENT '预警标题',
  content     VARCHAR(500)          DEFAULT NULL   COMMENT '预警详情',
  metric      VARCHAR(60)           DEFAULT NULL   COMMENT '触发指标',
  status      VARCHAR(20)  NOT NULL DEFAULT 'OPEN' COMMENT '状态: OPEN 待处理 / HANDLING 处理中 / CLOSED 已关闭',
  handler     VARCHAR(50)           DEFAULT NULL   COMMENT '处理人',
  handle_note VARCHAR(500)          DEFAULT NULL   COMMENT '处理说明',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '产生时间',
  closed_at   DATETIME              DEFAULT NULL   COMMENT '关闭时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_alert_no (alert_no),
  KEY idx_alert_ent (ent_id),
  KEY idx_alert_status (status),
  KEY idx_alert_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='监管预警记录表';

-- ---------------------------------------------------------------------
-- 15. audit_log  操作日志（等保与审计留痕）
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  user_id    BIGINT                DEFAULT NULL   COMMENT '操作人ID',
  username   VARCHAR(50)           DEFAULT NULL   COMMENT '操作人账号',
  role       VARCHAR(20)           DEFAULT NULL   COMMENT '操作人角色',
  module     VARCHAR(40)  NOT NULL                COMMENT '功能模块',
  action     VARCHAR(60)  NOT NULL                COMMENT '操作动作',
  target     VARCHAR(120)          DEFAULT NULL   COMMENT '操作对象',
  detail     VARCHAR(500)          DEFAULT NULL   COMMENT '操作详情',
  ip         VARCHAR(60)           DEFAULT NULL   COMMENT '来源IP',
  result     VARCHAR(10)  NOT NULL DEFAULT 'SUCCESS' COMMENT '结果 SUCCESS/FAIL',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
  PRIMARY KEY (id),
  KEY idx_log_user (user_id),
  KEY idx_log_module (module),
  KEY idx_log_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统操作日志表';

-- ---------------------------------------------------------------------
-- 16. notice  平台通知公告
-- ---------------------------------------------------------------------
CREATE TABLE notice (
  id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  title        VARCHAR(150) NOT NULL                COMMENT '标题',
  content      TEXT                  DEFAULT NULL   COMMENT '正文',
  notice_type  VARCHAR(20)  NOT NULL DEFAULT 'POLICY' COMMENT '类型: POLICY 政策法规 / MARKET 市场公告 / SYSTEM 系统通知',
  target_role  VARCHAR(20)  NOT NULL DEFAULT 'ALL'  COMMENT '目标角色 ALL/ENTERPRISE/VERIFIER/REGULATOR',
  publisher    VARCHAR(50)           DEFAULT NULL   COMMENT '发布人',
  is_top       TINYINT      NOT NULL DEFAULT 0      COMMENT '是否置顶',
  views        INT          NOT NULL DEFAULT 0      COMMENT '浏览量',
  publish_time DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发布时间',
  PRIMARY KEY (id),
  KEY idx_notice_type (notice_type),
  KEY idx_notice_time (publish_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台通知公告表';

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

-- ---------------------------------------------------------------------
-- 19. cems_reading  在线监测(CEMS)实测读数
--     工业场景的"动态核算"来源：排口在线监测设备按小时推送烟气流量与
--     折算排放速率，替代人工季度填报，使核算从"周期性离线"变为"准实时滚动"。
-- ---------------------------------------------------------------------
CREATE TABLE cems_reading (
  id           BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id       BIGINT        NOT NULL                COMMENT '企业ID',
  monitor_no   VARCHAR(40)   NOT NULL                COMMENT '监测点(排口)编号',
  energy_type  VARCHAR(30)   NOT NULL                COMMENT '能源品种/排放源',
  reading_time DATETIME      NOT NULL                COMMENT '采样时间',
  flow_value   DECIMAL(16,3) NOT NULL DEFAULT 0      COMMENT '瞬时排放速率(tCO2e/h)',
  cum_value    DECIMAL(18,3) NOT NULL DEFAULT 0      COMMENT '当期累计排放(tCO2e)',
  o2_content   DECIMAL(6,2)           DEFAULT NULL   COMMENT '烟气含氧量(%)',
  temperature  DECIMAL(6,2)           DEFAULT NULL   COMMENT '烟气温度(℃)',
  source       VARCHAR(20)   NOT NULL DEFAULT 'CEMS' COMMENT '数据来源 CEMS 在线监测 / MANUAL 人工补录',
  status       VARCHAR(20)   NOT NULL DEFAULT 'NORMAL' COMMENT '数据状态 NORMAL 正常 / ABNORMAL 异常',
  batch_no     VARCHAR(40)            DEFAULT NULL   COMMENT '采数批次号(同批次整体上链)',
  chain_tx_id  VARCHAR(80)            DEFAULT NULL   COMMENT '该批次上链存证交易号',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '落库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_cems_point (ent_id, monitor_no, reading_time),
  KEY idx_cems_ent_time (ent_id, reading_time),
  KEY idx_cems_time (reading_time),
  KEY idx_cems_batch (batch_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='CEMS 在线监测读数表（同一排口同一时刻唯一，采数幂等）';

-- ---------------------------------------------------------------------
-- 20. carbon_dynamic_account  企业动态核算账户（滚动核算结果）
--     由 CEMS 实测读数滚动计算：周期累计排放、期末预测、配额缺口、履约风险。
-- ---------------------------------------------------------------------
CREATE TABLE carbon_dynamic_account (
  id                  BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id              BIGINT        NOT NULL                COMMENT '企业ID',
  year                INT           NOT NULL                COMMENT '核算年度',
  period              VARCHAR(10)   NOT NULL                COMMENT '当前核算周期 如 2026Q4',
  cumulative_emission DECIMAL(18,3) NOT NULL DEFAULT 0      COMMENT '本年度累计实测排放(tCO2e)',
  quota_allocated     DECIMAL(16,3) NOT NULL DEFAULT 0      COMMENT '本年度已分配配额(tCO2e)',
  quota_available     DECIMAL(16,3) NOT NULL DEFAULT 0      COMMENT '当前可用配额余额(tCO2e)',
  gap                 DECIMAL(18,3) NOT NULL DEFAULT 0      COMMENT '预计期末配额缺口(预测期末排放-已分配配额，正=预计超排，负=预计盈余)',
  predicted_eoy       DECIMAL(18,3) NOT NULL DEFAULT 0      COMMENT '按当前滚动排放速率预测的期末排放(tCO2e,抵销前)',
  offset_applied      DECIMAL(18,3) NOT NULL DEFAULT 0      COMMENT '已用碳信用抵销量(tCO2e)',
  emission_rate       DECIMAL(16,4) NOT NULL DEFAULT 0      COMMENT '滚动日均排放速率(tCO2e/天)',
  risk_level          VARCHAR(10)   NOT NULL DEFAULT 'LOW'  COMMENT '履约风险 LOW 低 / MEDIUM 中 / HIGH 高',
  data_points         INT           NOT NULL DEFAULT 0      COMMENT '参与核算的实测点数',
  last_reading_at     DATETIME               DEFAULT NULL   COMMENT '最近一次实测数据时间',
  updated_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '核算更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_dyn_ent_year (ent_id, year),
  KEY idx_dyn_risk (risk_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业动态核算账户表';

-- ---------------------------------------------------------------------
-- 21. credit_asset  碳信用资产（国家核证自愿减排量 CCER 等）
--     除"碳配额"外的第二类碳资产：企业持有的自愿减排量，可用于抵销履约缺口。
-- ---------------------------------------------------------------------
CREATE TABLE credit_asset (
  id           BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id       BIGINT        NOT NULL                COMMENT '持有企业ID',
  asset_no     VARCHAR(40)   NOT NULL                COMMENT '资产编号',
  asset_type   VARCHAR(30)   NOT NULL                COMMENT '资产类型 CCER 国家核证自愿减排量 / 林业碳汇 / 绿证',
  project_name VARCHAR(120)           DEFAULT NULL   COMMENT '减排项目名称',
  amount       DECIMAL(16,3) NOT NULL DEFAULT 0      COMMENT '持有量(tCO2e)',
  used_amount  DECIMAL(16,3) NOT NULL DEFAULT 0      COMMENT '已抵销使用量(tCO2e)',
  issue_year   INT                    DEFAULT NULL   COMMENT '签发年度',
  valid_until  DATE                   DEFAULT NULL   COMMENT '有效期截止',
  registry     VARCHAR(120)           DEFAULT NULL   COMMENT '登记机构',
  status       VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE' COMMENT '状态 ACTIVE 可用 / USED 已用尽 / EXPIRED 过期',
  chain_block_index INT              DEFAULT NULL    COMMENT '签发存证区块高度',
  chain_tx_id  VARCHAR(80)            DEFAULT NULL   COMMENT '签发存证交易号',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '落库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_credit_asset_no (asset_no),
  KEY idx_credit_ent (ent_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='碳信用资产表（配额之外的碳资产类型）';

-- ---------------------------------------------------------------------
-- 22. credit_offset  碳信用抵销使用流水
--     企业用碳信用抵销本年度配额缺口（受抵销比例上限约束），抵销即上链存证。
-- ---------------------------------------------------------------------
CREATE TABLE credit_offset (
  id           BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  offset_no    VARCHAR(40)   NOT NULL                COMMENT '抵销单号',
  ent_id       BIGINT        NOT NULL                COMMENT '企业ID',
  year         INT           NOT NULL                COMMENT '抵销年度',
  asset_id     BIGINT        NOT NULL                COMMENT '使用的碳信用资产ID',
  amount       DECIMAL(16,3) NOT NULL                COMMENT '本次抵销量(tCO2e)',
  ratio_limit  DECIMAL(8,4)  NOT NULL DEFAULT 0.05   COMMENT '抵销比例上限(占配额)',
  quota_before DECIMAL(18,3) NOT NULL DEFAULT 0      COMMENT '抵销前预计缺口(tCO2e)',
  quota_after  DECIMAL(18,3) NOT NULL DEFAULT 0      COMMENT '抵销后预计缺口(tCO2e)',
  operator     VARCHAR(40)            DEFAULT NULL   COMMENT '经办人',
  chain_block_index INT              DEFAULT NULL    COMMENT '存证区块高度',
  chain_tx_id  VARCHAR(80)            DEFAULT NULL   COMMENT '存证交易号',
  status       VARCHAR(20)   NOT NULL DEFAULT 'CONFIRMED' COMMENT '状态',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '落库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_offset_no (offset_no),
  KEY idx_offset_ent (ent_id, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='碳信用抵销流水表';

SET FOREIGN_KEY_CHECKS = 1;
