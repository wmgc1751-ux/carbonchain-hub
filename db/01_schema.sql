-- =====================================================================
--  碳链通 CarbonChain Hub —— 面向工业场景的联盟链碳资产动态核算可信存证平台
--  数据库结构定义脚本 (MySQL 8.0)
--  文件: db/01_schema.sql
--  说明: 本文件为纯 DDL，不含数据。数据由 server/scripts/init-db.js 生成，
--        并可导出为 db/02_seed_data.sql，方便直接导入还原。
--
--  ⚠ 结构变更（链库物理分离）：
--    链上账本 5 张表（chain_block / chain_tx / chain_payload_backup /
--    chain_node / chain_node_replica）已迁至独立数据库 carbon_chain_ledger，
--    定义见 db/00_schema_ledger.sql。本库为此 5 张表建立【只读视图】，
--    使得：
--      · 原有全部查询代码零改动（含业务表与链表的 JOIN）；
--      · 业务库账号对账本库只有 SELECT 权限，无法写入/篡改；
--      · 链内核通过专用连接池（server/db.js#ledgerPool）直连账本库读写实体表。
--    ⇒ 「一条 UPDATE 同时改业务明文与链上锚点」在权限层不再成立。
-- =====================================================================

DROP DATABASE IF EXISTS carbon_chain;
-- 2026-10-31（CCD-005）：库默认排序规则统一为 utf8mb4_0900_ai_ci。
-- 原 general_ci 声明导致旧表与新表（MySQL8 默认 0900_ai_ci）混合，
-- ent_code 跨表比较直接抛 "Illegal mix of collations"（/api/real/* 500）。
-- 已对现库执行 CONVERT 统一；此处修正声明防止 initdb 重建后复发。
CREATE DATABASE carbon_chain DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE carbon_chain;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- 1. sys_user  统一用户账号表（五端共用一套账号体系，靠 role 区分身份）
-- ---------------------------------------------------------------------
CREATE TABLE sys_user (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  username      VARCHAR(50)  NOT NULL                COMMENT '登录账号',
  password      VARCHAR(200) NOT NULL                COMMENT '口令摘要 = scrypt$<hex128>（135字符；SHA256旧格式64字符）',
  salt          VARCHAR(32)  NOT NULL                COMMENT '口令盐值',
  real_name     VARCHAR(50)           DEFAULT NULL   COMMENT '姓名',
  role          VARCHAR(20)  NOT NULL                COMMENT '角色: ENTERPRISE 企业端 / VERIFIER 核查机构端 / REGULATOR 监管端 / TRADER 交易端（碳配额履约流转） / ADMIN 系统管理',
  org_id        BIGINT                DEFAULT NULL   COMMENT '所属组织ID(企业ID或核查机构ID)',
  org_name      VARCHAR(120)          DEFAULT NULL   COMMENT '所属组织名称快照',
  phone         VARCHAR(20)           DEFAULT NULL   COMMENT '手机号',
  email         VARCHAR(80)           DEFAULT NULL   COMMENT '邮箱',
  avatar        VARCHAR(255)          DEFAULT NULL   COMMENT '头像',
  status        TINYINT      NOT NULL DEFAULT 1      COMMENT '状态 1启用 0待审核(机构自主注册待管理员审核) 2停用',
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
  prev_hash  VARCHAR(80)           DEFAULT NULL   COMMENT '前一条日志的 entry_hash(NULL 表示链首)',
  entry_hash VARCHAR(80)           DEFAULT NULL   COMMENT '本条日志哈希 SHA256(prev_hash|规范序列化内容)',
  PRIMARY KEY (id),
  KEY idx_log_user (user_id),
  KEY idx_log_module (module),
  KEY idx_log_time (created_at),
  KEY idx_log_entry_hash (entry_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统操作日志表（entry_hash 构成哈希链，可验证未被篡改）';

-- ---------------------------------------------------------------------
-- 16. notice  平台通知公告
-- ---------------------------------------------------------------------
CREATE TABLE notice (
  id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  title        VARCHAR(150) NOT NULL                COMMENT '标题',
  content      TEXT                  DEFAULT NULL   COMMENT '正文',
  notice_type  VARCHAR(20)  NOT NULL DEFAULT 'POLICY' COMMENT '类型: POLICY 政策法规 / MARKET 市场公告 / SYSTEM 系统通知 / OFFICIAL 官方通知 / INTL 国际动态',
  target_role  VARCHAR(20)  NOT NULL DEFAULT 'ALL'  COMMENT '目标角色 ALL/ENTERPRISE/VERIFIER/REGULATOR',
  publisher    VARCHAR(50)           DEFAULT NULL   COMMENT '发布人',
  is_top       TINYINT      NOT NULL DEFAULT 0      COMMENT '是否置顶',
  views        INT          NOT NULL DEFAULT 0      COMMENT '浏览量',
  publish_time DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发布时间',
  source_name  VARCHAR(120)          DEFAULT NULL   COMMENT '真实消息源名称（如"生态环境部"；平台自建公告为 NULL）',
  source_url   VARCHAR(500)          DEFAULT NULL   COMMENT '原文链接（权威平台 URL）',
  fetched_at   DATETIME              DEFAULT NULL   COMMENT '抓取时间（区分"实时抓取"与"平台自建"）',
  PRIMARY KEY (id),
  KEY idx_notice_type (notice_type),
  KEY idx_notice_time (publish_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台通知公告表';

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
  source       VARCHAR(20)   NOT NULL DEFAULT 'CEMS' COMMENT '数据来源 CEMS 在线监测 / MANUAL 人工补录 / WATCHDOG 平台看门狗补记的离线占位记录(非设备上报)',
  status       VARCHAR(20)   NOT NULL DEFAULT 'NORMAL' COMMENT '数据状态 NORMAL 正常 / ABNORMAL 异常',
  quality_flag VARCHAR(20)   NOT NULL DEFAULT 'NORMAL' COMMENT '时序完整性标记 NORMAL 有效 / MISSING 缺数 / DRIFT 漂移 / OFFLINE 停机 / CALIBRATION 校准 / SUBSTITUTED 已按替代规则补齐',
  device_did   VARCHAR(80)            DEFAULT NULL   COMMENT '上报设备 DID(与 device_registry 关联，NULL 表示由平台自举生成)',
  crc16        VARCHAR(8)             DEFAULT NULL   COMMENT 'HJ 212 报文 CRC-16 校验值(附录A参数集，同 CRC-16/MODBUS；设备直报时有值)',
  sm3_digest   VARCHAR(80)            DEFAULT NULL   COMMENT '报文国密 SM3 指纹(设备直报时有值)',
  batch_no     VARCHAR(40)            DEFAULT NULL   COMMENT '采数批次号(同批次整体上链)',
  chain_tx_id  VARCHAR(80)            DEFAULT NULL   COMMENT '该批次上链存证交易号',
  dev_seq      BIGINT                 DEFAULT NULL   COMMENT 'CEN-100 设备单调序号(与报文 DevSeq 一致，用于防重放)',
  signature    VARCHAR(256)           DEFAULT NULL   COMMENT 'CEN-100 设备 SM2 签名的 SM3 指纹留痕(不存完整签名，避免表膨胀)',
  sig_mode     VARCHAR(16)            DEFAULT NULL   COMMENT '验签口径 STD 标准含ZA / NO_ZA 非标 / UNSIGNED 无签名',
  gdev_tph     DECIMAL(18,9)          DEFAULT NULL   COMMENT 'CEN-100 设备端独立折算的排放速率(t/h)，用于端云双算互证',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '落库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_cems_point (ent_id, monitor_no, reading_time),
  KEY idx_cems_ent_time (ent_id, reading_time),
  KEY idx_cems_time (reading_time),
  KEY idx_cems_batch (batch_no),
  KEY idx_cems_quality (quality_flag),
  KEY idx_reading_seq (device_did, dev_seq)
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
  excluded_points     INT           NOT NULL DEFAULT 0      COMMENT '被质量门控排除的实测点数(quality_flag<>NORMAL，不参与核算)',
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
  status       VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE' COMMENT '状态 ACTIVE 可用 / USED 已用尽 / RETIRED 已注销（永久退出流通，不可再声称） / EXPIRED 过期',
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

-- ---------------------------------------------------------------------
-- 23. emission_factor  排放因子库（对齐 GB/T 32150 等国家标准）
--     核算公式「活动数据 × 因子 × 氧化率」中的系数；按能源品种与行业维护。
-- ---------------------------------------------------------------------
CREATE TABLE emission_factor (
  id           BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  energy_type  VARCHAR(30)   NOT NULL                COMMENT '能源品种: COAL 原煤 / COKE 焦炭 / GAS 天然气 / DIESEL 柴油 / FUEL_OIL 燃料油 / POWER 电力 / HEAT 热力',
  factor       DECIMAL(14,6) NOT NULL                COMMENT '排放因子(tCO2e/单位)',
  unit         VARCHAR(30)   NOT NULL DEFAULT 'tCO2e/单位' COMMENT '计量单位',
  scope        TINYINT       NOT NULL DEFAULT 1      COMMENT '核算范围 1 直接 / 2 间接',
  source       VARCHAR(120)           DEFAULT NULL   COMMENT '因子出处(标准/指南)',
  industry     VARCHAR(30)            DEFAULT NULL   COMMENT '适用行业(空为通用)',
  version      VARCHAR(20)            DEFAULT NULL   COMMENT '当前生效版本号',
  effective_from DATETIME             DEFAULT NULL   COMMENT '生效时间',
  effective_to DATETIME               DEFAULT NULL   COMMENT '失效时间(旧版本封口)',
  status       VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE' COMMENT '状态 ACTIVE / ARCHIVED',
  remark       VARCHAR(200)           DEFAULT NULL   COMMENT '备注',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '落库时间',
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  KEY idx_factor_energy (energy_type),
  KEY idx_factor_industry (industry)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='排放因子库表';

-- ---------------------------------------------------------------------
-- 24. factor_version  因子版本（核算规则合约的链上固化）
--     每次发布把当前因子库快照固化为一个版本，旧版本只读，保证历史核算可复现。
-- ---------------------------------------------------------------------
CREATE TABLE factor_version (
  id           BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  version      VARCHAR(20)   NOT NULL                COMMENT '版本号(如 v2026.1)',
  effective_from DATETIME    NOT NULL                COMMENT '生效时间',
  effective_to DATETIME               DEFAULT NULL   COMMENT '失效时间',
  operator     VARCHAR(40)            DEFAULT NULL   COMMENT '发布人',
  snapshot     JSON                   DEFAULT NULL   COMMENT '因子库快照(JSON)',
  chain_block_index INT              DEFAULT NULL    COMMENT '存证区块高度',
  chain_tx_id  VARCHAR(80)            DEFAULT NULL   COMMENT '存证交易号',
  status       VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE' COMMENT '状态 ACTIVE / ARCHIVED',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '落库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_factor_version (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='排放因子版本表';

-- ---------------------------------------------------------------------
-- 25. prediction_record  多智能体预测结果存档
--     用量预测 / 超限预警 / 异常检测 / 减排建议 的结果留档，供趋势回溯与答辩演示。
-- ---------------------------------------------------------------------
CREATE TABLE prediction_record (
  id           BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id       BIGINT        NOT NULL                COMMENT '企业ID',
  year         INT           NOT NULL                COMMENT '预测年度',
  agent        VARCHAR(20)   NOT NULL                COMMENT '智能体: FORECAST 用量预测 / OVER_QUOTA 超限预警 / ANOMALY 异常检测 / ADVISOR 减排建议',
  predicted_eoy DECIMAL(16,3)         DEFAULT NULL   COMMENT '预测期末排放(tCO2e)',
  gap          DECIMAL(16,3)          DEFAULT NULL   COMMENT '预测缺口(tCO2e)',
  risk_level   VARCHAR(10)            DEFAULT NULL   COMMENT '风险等级 HIGH/MEDIUM/LOW',
  detail       JSON                   DEFAULT NULL   COMMENT '预测明细(JSON)',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
  PRIMARY KEY (id),
  KEY idx_pred_ent_year (ent_id, year),
  KEY idx_pred_agent (agent)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='多智能体预测结果表';

-- ---------------------------------------------------------------------
-- 26. reconciliation  链上链下对账记录
--     定时核对 MySQL 业务记录 ↔ 链上 txid 映射，记录不一致情况与修复轨迹。
-- ---------------------------------------------------------------------
CREATE TABLE reconciliation (
  id           BIGINT        NOT NULL AUTO_INCREMENT COMMENT '主键',
  recon_no     VARCHAR(40)   NOT NULL                COMMENT '对账单号',
  total_records INT          NOT NULL DEFAULT 0      COMMENT '核对记录总数',
  inconsistent INT           NOT NULL DEFAULT 0      COMMENT '不一致记录数',
  detail       JSON                   DEFAULT NULL   COMMENT '分表核对明细(JSON)',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '对账时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_recon_no (recon_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='链上链下对账记录表';

-- ---------------------------------------------------------------------
-- 27. anchor_batch  批量锚定批次（WP3 链内核规模化）
--     把时间窗内的 N 笔业务存证组织成一棵 Merkle 树，只把「根」作为
--     1 笔锚点交易上链。明细挂在本表 + batch_leaf，链上只留 1 个锚点。
--     ⚠ 中间态语义（必须显式声明，否则会成为新的歧义源）：
--       PENDING   —— 该笔存证已确认入链（block_index 非空），但尚未被批量锚定
--       ANCHORED  —— 该笔存证已被某个批次的 Merkle 根覆盖，可由证明路径独立验证
--       对外查询口径：两种状态的数据均为「已固化」；区别仅在于「锚定强度」。
-- ---------------------------------------------------------------------
CREATE TABLE anchor_batch (
  id                 BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  batch_no           VARCHAR(40)  NOT NULL                COMMENT '批次号',
  leaf_count         INT          NOT NULL DEFAULT 0      COMMENT '批次内叶节点(存证)数量',
  merkle_root        VARCHAR(80)  NOT NULL                COMMENT '批次 Merkle 根(SHA-256)',
  algo               VARCHAR(40)  NOT NULL DEFAULT 'SHA256-MERKLE-1' COMMENT '锚定算法标识',
  anchor_tx_id       VARCHAR(80)           DEFAULT NULL   COMMENT '锚点交易号(1 笔代表整批)',
  anchor_block_index BIGINT                DEFAULT NULL   COMMENT '锚点所在区块高度',
  window_from        DATETIME     NOT NULL                COMMENT '锚定时间窗起(取批次内最早存证时间)',
  window_to          DATETIME     NOT NULL                COMMENT '锚定时间窗止',
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ab_batch_no (batch_no),
  KEY idx_ab_anchor_tx (anchor_tx_id),
  KEY idx_ab_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='批量锚定批次表（N 笔存证 → 1 个锚点）';

-- ---------------------------------------------------------------------
-- 28. batch_leaf  批次叶节点（存证 → 批次的归属与叶序）
--     leaf_index 是 Merkle 证明路径的唯一依据，一经写入不可变更。
-- ---------------------------------------------------------------------
CREATE TABLE batch_leaf (
  id           BIGINT      NOT NULL AUTO_INCREMENT COMMENT '主键',
  batch_no     VARCHAR(40) NOT NULL                COMMENT '所属批次号',
  leaf_index   INT         NOT NULL                COMMENT '叶序(从 0 起，证明路径据此生成)',
  tx_id        VARCHAR(80) NOT NULL                COMMENT '存证交易号(作为 Merkle 叶)',
  payload_hash VARCHAR(80) NOT NULL                COMMENT '该存证的链上锚定摘要(便于独立复核)',
  block_index  BIGINT               DEFAULT NULL   COMMENT '该存证所在区块高度',
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_bl_batch_leaf (batch_no, leaf_index),
  UNIQUE KEY uk_bl_tx (tx_id),
  KEY idx_bl_batch (batch_no),
  KEY idx_bl_block (block_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='批量锚定叶节点表（一笔存证只归属一个批次）';

-- ---------------------------------------------------------------------
-- 29. device_registry  工业现场设备注册表（WP1 源端真实化）
--     设备以 DID 标识，承载「谁在测、用什么协议测、是否在授权期」三件事。
--     auth_status 与 chain_node.status 同构：被吊销的设备所报数据不得入链。
-- ---------------------------------------------------------------------
CREATE TABLE device_registry (
  id             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  device_did     VARCHAR(80)  NOT NULL                COMMENT '设备 DID，如 did:iot:cems:gw:01',
  ent_id         BIGINT                DEFAULT NULL   COMMENT '归属企业ID',
  monitor_no     VARCHAR(40)           DEFAULT NULL   COMMENT '对应排口编号',
  protocol       VARCHAR(20)  NOT NULL DEFAULT 'HJ212' COMMENT '接入协议 HJ212 / MODBUS_TCP / OPC_UA / SIMULATED',
  device_type    VARCHAR(40)           DEFAULT NULL   COMMENT '设备类型，如 烟气排放连续监测系统',
  manufacturer   VARCHAR(80)           DEFAULT NULL   COMMENT '厂商',
  mn             VARCHAR(40)           DEFAULT NULL   COMMENT 'HJ 212 设备唯一标识(MN)',
  cert_fingerprint VARCHAR(80)         DEFAULT NULL   COMMENT '设备证书指纹(用于校验上报方身份)',
  auth_status    VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT '授权状态 ACTIVE 在用 / PENDING 待审批 / REVOKED 已吊销',
  last_seen_at   DATETIME              DEFAULT NULL   COMMENT '最近一次上报时间',
  offline        TINYINT(1)   NOT NULL DEFAULT 0      COMMENT '是否配置为断网续传缓冲节点',
  remark         VARCHAR(200)          DEFAULT NULL   COMMENT '备注',
  dev_pubkey     TEXT                  DEFAULT NULL   COMMENT 'CEN-100 设备 SM2 公钥 PEM(SPKI)；有值则该设备数据帧进入验签通道',
  dev_key_fp     VARCHAR(64)           DEFAULT NULL   COMMENT 'CEN-100 公钥指纹 Hex(前 32 字符)，用于现场核对',
  dev_key_reg_at DATETIME              DEFAULT NULL   COMMENT 'CEN-100 公钥注册时间',
  dev_sm2_id     VARCHAR(64)  NOT NULL DEFAULT '1234567812345678' COMMENT 'CEN-100 SM2 用户标识，必须与设备端烧录值一致，否则 ZA 不同、验签必败',
  dev_last_seq   BIGINT       NOT NULL DEFAULT 0      COMMENT 'CEN-100 设备已确认的最大单调序号，用于防重放',
  dev_sig_mode   VARCHAR(16)           DEFAULT NULL   COMMENT 'CEN-100 最近一次验签口径 STD / NO_ZA / UNSIGNED',
  tamper_at      DATETIME              DEFAULT NULL   COMMENT 'CEN-100 最近一次防拆触发时间',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '登记时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_dr_did (device_did),
  UNIQUE KEY uk_dr_mn (mn),
  KEY idx_dr_ent (ent_id),
  KEY idx_dr_status (auth_status),
  KEY idx_dr_protocol (protocol),
  KEY idx_dev_keyfp (dev_key_fp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工业现场设备注册表（DID 标识 + 授权状态 + 接入协议 + CEN-100 验签台账）';

-- ---------------------------------------------------------------------
-- 29b. device_verify_log  CEN-100 设备签名验签事件台账
--      每次数据帧验签（通过/失败/重放/跳号/未签名）留痕，
--      既是阴性对照与攻击证据的来源，也是"源端可信"的可观测性基础。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_verify_log (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  mn            VARCHAR(32)  NOT NULL COMMENT '设备 MN',
  device_did    VARCHAR(128) DEFAULT NULL,
  seq           BIGINT       DEFAULT NULL COMMENT '设备序号',
  outcome       VARCHAR(24)  NOT NULL COMMENT 'PASS_STD / PASS_NO_ZA / SIG_FAIL / REPLAY / SEQ_GAP / UNSIGNED',
  mode          VARCHAR(16)  DEFAULT NULL,
  cn            VARCHAR(8)   DEFAULT NULL,
  ip            VARCHAR(64)  DEFAULT NULL,
  detail        VARCHAR(512) DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_log_mn (mn, created_at),
  KEY idx_log_outcome (outcome, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='设备签名验签事件台账（阴性对照与攻击证据留痕）';

-- ---------------------------------------------------------------------
-- 29c. source_crosscheck  同源双路交叉验证记录
--      同一路探头信号，现役 CEMS 数采仪值与 CEN-100 独立采样值比对；
--      相对偏差超阈值即告警 —— 这是"数采仪改数"从不可发现变为可发现的证据链。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_crosscheck (
  id             BIGINT        NOT NULL AUTO_INCREMENT,
  ent_id         BIGINT        NOT NULL,
  monitor_no     VARCHAR(32)   NOT NULL,
  reading_time   DATETIME      NOT NULL,
  value_cems     DECIMAL(18,6) DEFAULT NULL COMMENT '现役 CEMS 数采仪上报值',
  value_edge     DECIMAL(18,6) DEFAULT NULL COMMENT 'CEN-100 独立采样上报值',
  rel_diff       DECIMAL(10,6) DEFAULT NULL COMMENT '相对偏差 |A-B|/B',
  threshold_pct  DECIMAL(6,3)  NOT NULL DEFAULT 5.000 COMMENT '告警阈值(%)，工程经验值，需按实测标定',
  alarmed        TINYINT(1)    NOT NULL DEFAULT 0,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cc_ent (ent_id, monitor_no, reading_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='同源双路交叉验证记录（发现数采仪改数的证据链）';

-- ---------------------------------------------------------------------
-- 30. cbam_declaration  欧盟 CBAM 申报数据包（WP5 国际互认）
--     一张表 = 一次「某企业某申报期某 CN Code 货物」的隐含碳申报。
--     设计要点：
--       · 直接/间接排放分列 —— CBAM 对二者的处理不同（间接排放在过渡期需报、
--         正式期是否计入取决于实施条例），分开存才不会把法规差异吞掉。
--       · emission_route 记录用的是「实际值法」还是「欧盟缺省值法」，
--         并同时存 eu_default_intensity 以便**同口径对照出成本差**（本 WP 的核心举证）。
--       · methodology + regulation_basis 强制落库 —— 法规持续修订，
--         必须能回答"你这份数据是按哪一版做的"。
-- ---------------------------------------------------------------------
CREATE TABLE cbam_declaration (
  id                   BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  decl_no              VARCHAR(40)  NOT NULL                COMMENT '申报批次号，如 CBAM-2026-STEEL-0001',
  ent_id               BIGINT       NOT NULL                COMMENT '申报企业ID',
  period               VARCHAR(20)  NOT NULL                COMMENT '申报期，如 2026Q1 / 2026-03',
  cn_code              VARCHAR(12)  NOT NULL                COMMENT '欧盟综合税则号(CN Code)，如 7208',
  goods_name           VARCHAR(120) NOT NULL                COMMENT '货物名称',
  goods_quantity       DECIMAL(18,3) NOT NULL               COMMENT '货物数量',
  quantity_unit        VARCHAR(10)  NOT NULL DEFAULT 't'    COMMENT '计量单位',
  direct_emission      DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '直接排放(tCO2e)',
  indirect_emission    DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '间接排放(tCO2e)',
  embedded_intensity   DECIMAL(18,6) NOT NULL DEFAULT 0     COMMENT '单位产品隐含碳(tCO2e/t)',
  carbon_price_paid    DECIMAL(18,2) NOT NULL DEFAULT 0     COMMENT '在原产国已支付的碳成本(用于扣减)',
  carbon_price_currency VARCHAR(8)  NOT NULL DEFAULT 'CNY'  COMMENT '已付碳价币种',
  methodology          VARCHAR(60)  NOT NULL                COMMENT '核算方法学，如 ISO 14067:2018',
  emission_route       VARCHAR(20)  NOT NULL DEFAULT 'ACTUAL' COMMENT '取值路线 ACTUAL 实际值法 / DEFAULT 欧盟缺省值法',
  eu_default_intensity DECIMAL(18,6)         DEFAULT NULL   COMMENT '欧盟公布的缺省隐含碳强度(对照用)',
  evidence_digest      VARCHAR(80)  NOT NULL                COMMENT '溯源附件指纹(SM3)',
  evidence_refs        JSON                  DEFAULT NULL   COMMENT '关联存证引用列表(区块/交易/批次)',
  regulation_basis     VARCHAR(160) NOT NULL                COMMENT '所依据法规版本与生效日期(禁止模糊表述)',
  status               VARCHAR(20)  NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT 草稿 / GENERATED 已生成 / ARCHIVED 归档',
  chain_tx_id          VARCHAR(80)           DEFAULT NULL   COMMENT '上链存证交易号',
  block_index          BIGINT                DEFAULT NULL   COMMENT '所在区块高度',
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_cbam_no (decl_no),
  KEY idx_cbam_ent (ent_id, period),
  KEY idx_cbam_cn (cn_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='CBAM 产品隐含碳申报数据包（ISO 14067 口径）';

-- ---------------------------------------------------------------------
-- 31. green_power_match  小时级绿电溯源匹配（WP5）
--     把「绿电交易/绿证核销」与「用能时序」按**小时**对齐。
--     为什么必须小时级：出口企业只有证明"该小时用的确实是绿电"，
--     才能用实际值法而非欧盟缺省值法核算间接排放 —— 这是钱。
--     match_status 三态如实反映匹配质量，不允许把 UNMATCHED 当 MATCHED 报上去。
-- ---------------------------------------------------------------------
CREATE TABLE green_power_match (
  id               BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id           BIGINT       NOT NULL                COMMENT '企业ID',
  stat_hour        DATETIME     NOT NULL                COMMENT '统计小时(整点)',
  consumption_mwh  DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '该小时总用电量(MWh)',
  green_mwh        DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '该小时已匹配绿电电量(MWh)',
  match_status     VARCHAR(20)  NOT NULL DEFAULT 'UNMATCHED' COMMENT 'MATCHED 全额 / PARTIAL 部分 / UNMATCHED 未匹配',
  coverage_ratio   DECIMAL(8,6) NOT NULL DEFAULT 0      COMMENT '绿电覆盖率 = green/consumption',
  cert_no          VARCHAR(60)           DEFAULT NULL   COMMENT '绿证编号(GEC 等)',
  cert_type        VARCHAR(30)           DEFAULT NULL   COMMENT 'GEC 绿证 / PPA 直购 / 分布式自建 / 跨省绿电',
  source_name      VARCHAR(120)          DEFAULT NULL   COMMENT '绿电来源名称',
  grid_factor      DECIMAL(18,6) NOT NULL DEFAULT 0     COMMENT '该小时电网平均排放因子(tCO2/MWh)',
  residual_factor  DECIMAL(18,6) NOT NULL DEFAULT 0     COMMENT '扣绿后残余电网因子(tCO2/MWh)',
  provenance       JSON                  DEFAULT NULL   COMMENT '数据来源与推算方法声明(实测/推算分别标注，防止把推算值当实测值)',
  evidence_digest  VARCHAR(80)           DEFAULT NULL   COMMENT '匹配证据指纹(SM3)',
  chain_tx_id      VARCHAR(80)           DEFAULT NULL   COMMENT '上链存证交易号',
  block_index      BIGINT                DEFAULT NULL   COMMENT '所在区块高度',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_gpm_hour_cert (ent_id, stat_hour, cert_no),
  KEY idx_gpm_ent_hour (ent_id, stat_hour),
  KEY idx_gpm_status (match_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='小时级绿电溯源匹配（实际值法核算间接排放的依据）';

-- ---------------------------------------------------------------------
-- 32. report_export  双轨报告导出台账（WP5）
--     ISO 14064-1（组织碳）+ ISO 14067（产品碳）两轨，结果可互证。
--     content_digest 用 SM3：报告一变指纹就变，可证明"交付的就是这份"。
-- ---------------------------------------------------------------------
CREATE TABLE report_export (
  id                BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id            BIGINT       NOT NULL                COMMENT '企业ID',
  std               VARCHAR(20)  NOT NULL                COMMENT '标准 ISO14064-1 / ISO14067',
  report_scope      VARCHAR(20)  NOT NULL                COMMENT '组织 ORGANIZATION / 产品 PRODUCT',
  title             VARCHAR(160) NOT NULL                COMMENT '报告标题',
  period            VARCHAR(20)  NOT NULL                COMMENT '报告期',
  payload           JSON         NOT NULL                COMMENT '报告正文结构(供前端渲染与下载)',
  content_digest    VARCHAR(80)  NOT NULL                COMMENT '报告内容指纹(SM3)',
  file_fingerprint  VARCHAR(80)  NOT NULL                COMMENT '导出文件指纹(SHA-256)',
  total_emission    DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '报告总量(tCO2e)',
  cross_check       JSON                  DEFAULT NULL   COMMENT '与另一轨的互证结论',
  generated_by      VARCHAR(60)           DEFAULT NULL   COMMENT '生成人',
  chain_tx_id       VARCHAR(80)           DEFAULT NULL   COMMENT '上链存证交易号',
  block_index       BIGINT                DEFAULT NULL   COMMENT '所在区块高度',
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
  PRIMARY KEY (id),
  KEY idx_rpt_ent (ent_id, std, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='双轨报告导出台账（ISO 14064-1 / ISO 14067）';

-- ---------------------------------------------------------------------
-- 33. key_rotation_log  密钥轮换与双人复核日志（WP2 密码学生产化）
--     密钥轮换必须留痕，否则"轮换过"只是一句自述。
--     状态机：PENDING（已申请，待复核）→ APPROVED（生效）/ REJECTED。
--     ★ 同一条记录的 requested_by 与 approved_by **不得为同一人** —— 这是双人复核的
--       实质，服务层强制校验，不是靠流程约定。
-- ---------------------------------------------------------------------
CREATE TABLE key_rotation_log (
  id               BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  key_label        VARCHAR(80)  NOT NULL                COMMENT '密钥主体标签，如 ent:12 / gateway:M-0007-01',
  key_type         VARCHAR(20)  NOT NULL DEFAULT 'SM2'  COMMENT 'SM2 / ECDSA',
  action           VARCHAR(20)  NOT NULL                COMMENT 'GENERATE 生成 / ROTATE 轮换 / REVOKE 吊销',
  old_address      VARCHAR(80)           DEFAULT NULL   COMMENT '轮换前地址(SM2 曲线公钥派生)',
  new_address      VARCHAR(80)           DEFAULT NULL   COMMENT '轮换后地址',
  old_fingerprint  VARCHAR(80)           DEFAULT NULL   COMMENT '轮换前公钥指纹(SM3)',
  new_fingerprint  VARCHAR(80)           DEFAULT NULL   COMMENT '轮换后公钥指纹(SM3)',
  reason           VARCHAR(200)          DEFAULT NULL   COMMENT '轮换事由',
  requested_by     VARCHAR(60)  NOT NULL                COMMENT '申请人',
  approved_by      VARCHAR(60)           DEFAULT NULL   COMMENT '复核人(必须与申请人不一致)',
  approval_status  VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING 待复核 / APPROVED 已生效 / REJECTED 已驳回',
  approval_note    VARCHAR(200)          DEFAULT NULL   COMMENT '复核意见',
  approved_at      DATETIME              DEFAULT NULL   COMMENT '复核时间',
  chain_tx_id      VARCHAR(80)           DEFAULT NULL   COMMENT '轮换事件上链交易号',
  block_index      BIGINT                DEFAULT NULL   COMMENT '所在区块高度',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '申请时间',
  PRIMARY KEY (id),
  KEY idx_krl_label (key_label, created_at),
  KEY idx_krl_status (approval_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='密钥轮换与双人复核日志（PKCS#11 接口预留）';

-- ---------------------------------------------------------------------
-- 34. uncertainty_posterior  贝叶斯后验不确定度（WP4 核算升级）
--     由「蒙特卡洛单值」升级为「后验分布 + 95% 置信区间」。
--     采用 Normal-Inverse-Gamma 共轭先验 —— 有解析解，无需 MCMC，
--     且可用蒙特卡洛做**交叉验证**（两条独立路径结论必须一致）。
-- ---------------------------------------------------------------------
CREATE TABLE uncertainty_posterior (
  id               BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id           BIGINT       NOT NULL                COMMENT '企业ID',
  year             INT          NOT NULL                COMMENT '核算年度',
  target           VARCHAR(40)  NOT NULL DEFAULT 'ANNUAL_EMISSION' COMMENT 'ANNUAL_EMISSION 年度排放 / INTENSITY 排放强度',
  prior_type       VARCHAR(60)  NOT NULL                COMMENT '先验类型，如 Normal-Inverse-Gamma',
  prior_params     JSON                  DEFAULT NULL   COMMENT '先验超参数 mu0/kappa0/alpha0/beta0',
  posterior_params JSON         NOT NULL                COMMENT '后验超参数 mun/kappan/alphan/betan',
  n_obs            INT          NOT NULL DEFAULT 0      COMMENT '参与推断的观测点数',
  obs_summary      JSON                  DEFAULT NULL   COMMENT '观测数据摘要(均值/方差/极值)',
  mean             DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '后验均值',
  sd               DECIMAL(18,6) NOT NULL DEFAULT 0     COMMENT '后验标准差',
  ci_level         DECIMAL(6,4)  NOT NULL DEFAULT 0.95  COMMENT '置信水平',
  ci_low           DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '置信区间下界',
  ci_high          DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '置信区间上界',
  mc_cross_check   JSON                  DEFAULT NULL   COMMENT '蒙特卡洛交叉验证结果(与解析解对比)',
  method           VARCHAR(80)  NOT NULL                COMMENT '推断方法说明',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '计算时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_uq (ent_id, year, target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='贝叶斯后验不确定度（含 95% 置信区间与蒙特卡洛交叉验证）';

-- ---------------------------------------------------------------------
-- 35. model_eval  预测模型评估（WP4）
--     验收要求 MAPE ≤ 5%(L4) / ≤ 10%(L3)，并**必须给出消融实验**。
--     ablation 里逐项记录"去掉某组件后精度变化多少" —— 没有消融，
--     精度数字就只是运气，说不清是哪一部分在起作用。
-- ---------------------------------------------------------------------
CREATE TABLE model_eval (
  id             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id         BIGINT                DEFAULT NULL   COMMENT '企业ID(NULL 表示行业汇总评估)',
  model          VARCHAR(60)  NOT NULL                COMMENT '模型名，如 STL+ARIMA / Holt-Winters / Linear',
  horizon_days   INT          NOT NULL DEFAULT 30     COMMENT '预测步长(天)',
  n_train        INT          NOT NULL DEFAULT 0      COMMENT '训练集样本数',
  n_test         INT          NOT NULL DEFAULT 0      COMMENT '测试集样本数',
  split          VARCHAR(30)  NOT NULL                COMMENT '切分方式，如 HOLDOUT-30D / ROLLING-7',
  mape           DECIMAL(10,4) NOT NULL DEFAULT 0     COMMENT '平均绝对百分比误差(%)',
  rmse           DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '均方根误差',
  mae            DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '平均绝对误差',
  r2             DECIMAL(10,6) NOT NULL DEFAULT 0     COMMENT '决定系数 R²',
  params         JSON                  DEFAULT NULL   COMMENT '模型参数',
  ablation       JSON                  DEFAULT NULL   COMMENT '消融实验：逐项去掉组件后的精度变化',
  dataset_slice  VARCHAR(120)          DEFAULT NULL   COMMENT '数据集切片说明',
  verdict        VARCHAR(200)          DEFAULT NULL   COMMENT '结论(含"复杂模型未取胜"这类如实结论)',
  evaluated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '评估时间',
  PRIMARY KEY (id),
  KEY idx_me_model (model),
  KEY idx_me_ent (ent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='预测模型评估与消融实验（MAPE/R²/消融）';


-- =====================================================================
--  链上账本只读视图 —— 指向独立账本库 carbon_chain_ledger
--  ---------------------------------------------------------------------
--  目的：让业务侧查询代码（含与 business 表的 JOIN）保持不变，同时
--        保证业务库账号对账本【只有读权限、没有写权限】。
--  ⚠ 这些是视图不是表；对它们执行 UPDATE/INSERT/DELETE 会被 MySQL 拒绝
--    （业务账号无账本库写权限）。写入必须走 server/db.js#ledgerPool。
--  ⚠⚠ 必须显式 SQL SECURITY INVOKER（默认是 DEFINER）：
--    默认 DEFINER 时，视图以**创建者（root）**的权限执行，于是任何拿到
--    业务库 UPDATE 权限的账号，都能通过视图把改动写进账本库 —— 物理分离
--    在权限层被绕过。改为 INVOKER 后，操作视图需要调用者自己对底层表有
--    对应权限，业务账号只有 SELECT，写操作直接报 ER_TABLEACCESS_DENIED。
--    本机制已由 tools/attack-same-db.mjs 用例 5 实测验证。
--  ⚠ 若需改名（如云托管只给了一个库），改 init-db 的 LEDGER_DB 替换即可。
-- =====================================================================
CREATE OR REPLACE SQL SECURITY INVOKER VIEW chain_block           AS SELECT * FROM carbon_chain_ledger.chain_block;
CREATE OR REPLACE SQL SECURITY INVOKER VIEW chain_tx              AS SELECT * FROM carbon_chain_ledger.chain_tx;
CREATE OR REPLACE SQL SECURITY INVOKER VIEW chain_payload_backup  AS SELECT * FROM carbon_chain_ledger.chain_payload_backup;
CREATE OR REPLACE SQL SECURITY INVOKER VIEW chain_node            AS SELECT * FROM carbon_chain_ledger.chain_node;
CREATE OR REPLACE SQL SECURITY INVOKER VIEW chain_node_replica    AS SELECT * FROM carbon_chain_ledger.chain_node_replica;

SET FOREIGN_KEY_CHECKS = 1;
