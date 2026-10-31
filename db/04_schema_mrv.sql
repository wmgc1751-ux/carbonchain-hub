-- =====================================================================================
-- 04_schema_mrv.sql —— MRV 生产层结构（国赛级整改，2026-10-24）
-- =====================================================================================
-- 【为什么单独一个文件】
-- 01_schema.sql 是「比赛期」的结构：企业名录 / 上报单 / 核查任务 / 配额 / 交易。
-- 它缺了三样东西，而这三样恰好是「实际应用」与「演示」的分水岭：
--   ① 活动数据台账 —— 没有它，排放量永远只能由配额反推（科学性不成立）
--   ② 结算层      —— 没有它，交易只是数字搬家，没有商业闭环
--   ③ 履约清缴/注销 —— 没有它，配额与碳信用永远不「消耗」，碳市场不成立
-- 本文件只增不改，不动 01_schema.sql 的任何既有表，保证向后兼容与可回滚。
--
-- 【设计原则】
--   · 所有「量」都带单位和来源，不允许裸数字；
--   · 所有「结论」都能追到「输入」（parent 字段）；
--   · 所有「状态流转」都用显式枚举，不用布尔值表达多态。
-- =====================================================================================

SET NAMES utf8mb4;
USE carbon_chain;

-- -------------------------------------------------------------------------------------
-- 34. factor_entry  结构化排放因子台账
--     与 emission_factor（扁平因子值）的区别：
--       emission_factor 存「已经是因子」的结果（tCO2/单位），用于快速查表；
--       factor_entry    存「因子的构成」（NCV/CC/OF 三要素 + 文号），用于第三方复算。
--     这是「可复算」这一主张的物质基础 —— 只给结果不给推导，别人无法验证。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS factor_entry (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  code          VARCHAR(40)  NOT NULL                COMMENT '因子代码 COAL/COKE/GAS/...或过程因子 CEMENT_CLINKER',
  name_cn       VARCHAR(60)  NOT NULL                COMMENT '中文名',
  category      VARCHAR(20)  NOT NULL                COMMENT '类别 FUEL 燃料 / POWER 电力 / HEAT 热力 / PROCESS 工业过程',
  scope         TINYINT      NOT NULL DEFAULT 1      COMMENT '核算范围 1直接 2间接',
  -- 三要素：燃料类必填，电力/热力/过程类可为空（它们不是 AD×EF 形式）
  ncv           DECIMAL(14,4)         DEFAULT NULL   COMMENT '低位发热量',
  ncv_unit      VARCHAR(20)           DEFAULT NULL   COMMENT '低位发热量单位 GJ/t、GJ/万m³',
  cc            DECIMAL(10,4)         DEFAULT NULL   COMMENT '单位热值含碳量 tC/TJ',
  of_rate       DECIMAL(8,4)          DEFAULT NULL   COMMENT '碳氧化率 0~1',
  ef_value      DECIMAL(16,8) NOT NULL               COMMENT '排放因子 tCO2/活动数据单位（燃料类须等于三要素复算值）',
  ef_unit       VARCHAR(30)  NOT NULL                COMMENT '活动数据单位 t、万m³、MWh、GJ',
  -- 出处：必须写到文号或指南名 + 表号
  source_doc    VARCHAR(200) NOT NULL                COMMENT '因子出处（标准号/指南名/表号）',
  source_year   INT                   DEFAULT NULL   COMMENT '因子发布年份',
  -- 适用性
  industry      VARCHAR(40)           DEFAULT NULL   COMMENT '适用行业，空为通用',
  region        VARCHAR(40)           DEFAULT NULL   COMMENT '适用区域（电网因子用），空为全国',
  -- 版本
  version       VARCHAR(20)  NOT NULL DEFAULT 'v2026.1' COMMENT '所属版本号',
  effective_from DATE        NOT NULL                COMMENT '生效日期',
  effective_to  DATE                  DEFAULT NULL   COMMENT '失效日期',
  status        VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE 生效 / ARCHIVED 归档 / DRAFT 草稿',
  -- 复算审计：每次发布前由自检写入，非空即表示已通过复算
  recompute_ok  TINYINT      NOT NULL DEFAULT 0      COMMENT '复算校验是否通过 1是 0否',
  recompute_diff DECIMAL(12,8)        DEFAULT NULL   COMMENT '复算值与登记值的绝对差',
  remark        VARCHAR(300)          DEFAULT NULL   COMMENT '备注（含口径差异说明）',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '落库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_factor_entry (code, version, region),
  KEY idx_fe_category (category),
  KEY idx_fe_status (status, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='结构化排放因子台账（三要素可复算）';

-- -------------------------------------------------------------------------------------
-- 35. activity_data  活动数据台账（按月，按排放源）
--     这是整条核算链的**唯一输入**。没有活动数据，一切排放量都是编的。
--     data_origin 四档：
--       L3 实测    —— 计量器具读数/化验报告（最高可信）
--       L2 台账    —— 企业原始台账（发票/磅单/电费单）
--       L1 估算    —— 工程估算（按产量反推）
--       L0 缺省    —— 缺失，按缺省值暂代（**必须标红，不可用于履约**）
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_data (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id        BIGINT       NOT NULL                COMMENT '企业ID',
  year          INT          NOT NULL                COMMENT '数据年度',
  month         TINYINT      NOT NULL                COMMENT '数据月份 1-12',
  -- 排放源：燃料类用 factor_entry.code，过程类用过程因子 code
  source_code   VARCHAR(40)  NOT NULL                COMMENT '排放源代码 COAL/CEMENT_CLINKER/...',
  source_type   VARCHAR(20)  NOT NULL DEFAULT 'FUEL' COMMENT 'FUEL 燃料燃烧 / PROCESS 工业过程 / INDIRECT 净购入电力热力',
  quantity      DECIMAL(18,4) NOT NULL DEFAULT 0     COMMENT '活动数据量',
  unit          VARCHAR(20)  NOT NULL                COMMENT '计量单位',
  -- 数据来源分级（与 data-provenance 工具同源，是「数据可信度」的基础）
  data_origin   VARCHAR(4)   NOT NULL DEFAULT 'L2'   COMMENT 'L3实测/L2台账/L1估算/L0缺省',
  -- 计量器具与凭证
  meter_no      VARCHAR(60)           DEFAULT NULL   COMMENT '计量器具编号（电表/皮带秤/流量计）',
  meter_calibrated_until DATE         DEFAULT NULL   COMMENT '计量器具检定有效期至',
  voucher_no    VARCHAR(60)           DEFAULT NULL   COMMENT '原始凭证号（发票/磅单/化验单）',
  -- 实测化验值（燃料类专用，Tier2 升级路径）
  measured_ncv  DECIMAL(14,4)         DEFAULT NULL   COMMENT '实测低位发热量',
  measured_cc   DECIMAL(10,4)         DEFAULT NULL   COMMENT '实测单位热值含碳量',
  measured_of   DECIMAL(8,4)          DEFAULT NULL   COMMENT '实测碳氧化率',
  lab_report_no VARCHAR(60)           DEFAULT NULL   COMMENT '化验报告编号',
  -- 审核轨迹
  submitted_by  VARCHAR(40)           DEFAULT NULL   COMMENT '填报人',
  reviewed_by   VARCHAR(40)           DEFAULT NULL   COMMENT '复核人（双人复核制）',
  reviewed_at   DATETIME              DEFAULT NULL   COMMENT '复核时间',
  status        VARCHAR(20)  NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT 草稿 / SUBMITTED 已提交 / REVIEWED 已复核 / REJECTED 已驳回',
  reject_reason VARCHAR(300)          DEFAULT NULL   COMMENT '驳回原因',
  remark        VARCHAR(300)          DEFAULT NULL   COMMENT '备注',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_activity (ent_id, year, month, source_code),
  KEY idx_activity_ym (year, month),
  KEY idx_activity_origin (data_origin),
  KEY idx_activity_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业活动数据台账（核算链唯一输入）';

-- -------------------------------------------------------------------------------------
-- 36. calc_batch  核算批次（一次完整核算作业）
--     把「用哪个版本因子、哪段时期数据、由谁发起」固化为一个可回溯的批次。
--     核算是可重复的：给定同一批次输入，必须得到同一结果（幂等 + 可复算）。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calc_batch (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  batch_no      VARCHAR(40)  NOT NULL                COMMENT '批次号',
  ent_id        BIGINT       NOT NULL                COMMENT '企业ID',
  year          INT          NOT NULL                COMMENT '核算年度',
  period_from   DATE         NOT NULL                COMMENT '核算起',
  period_to     DATE         NOT NULL                COMMENT '核算止',
  -- 方法学快照：核算时必须锁定方法学与因子版本，否则结果不可复现
  method        VARCHAR(20)  NOT NULL DEFAULT 'CALC' COMMENT 'CALC 计算法 / CEMS 在线监测法 / DUAL 双轨',
  factor_version VARCHAR(20) NOT NULL                COMMENT '锁定的因子版本号',
  industry      VARCHAR(40)  NOT NULL                COMMENT '行业（决定应核算的排放源清单）',
  region        VARCHAR(40)           DEFAULT NULL   COMMENT '区域（决定电网因子）',
  -- 结果
  scope1        DECIMAL(18,3) NOT NULL DEFAULT 0     COMMENT '范围一排放 tCO2e',
  scope2        DECIMAL(18,3) NOT NULL DEFAULT 0     COMMENT '范围二排放 tCO2e',
  total_emission DECIMAL(18,3) NOT NULL DEFAULT 0    COMMENT '排放总量 tCO2e',
  intensity     DECIMAL(14,6)         DEFAULT NULL   COMMENT '排放强度 tCO2e/万元（无产值时为 NULL 而非 0）',
  output_value  DECIMAL(18,2)         DEFAULT NULL   COMMENT '报告期产值（万元）',
  -- 完整性：这是最重要的一个字段
  is_complete   TINYINT      NOT NULL DEFAULT 0      COMMENT '核算是否完整 1完整 0有缺口',
  coverage_ratio DECIMAL(6,4) NOT NULL DEFAULT 0      COMMENT '应核算源的覆盖率 0~1',
  gap_count     INT          NOT NULL DEFAULT 0      COMMENT '缺口项数量',
  gap_detail    JSON                  DEFAULT NULL   COMMENT '缺口明细（漏了哪些源、为什么）',
  -- 质量档位
  quality_tier  VARCHAR(4)            DEFAULT NULL   COMMENT '数据质量档 Q1/Q2/Q3/Q4',
  usable_for_compliance TINYINT NOT NULL DEFAULT 0   COMMENT '是否可用于履约 1是 0否',
  -- 不确定度
  u_rel         DECIMAL(10,6)         DEFAULT NULL   COMMENT '相对合成标准不确定度（k=1）',
  u95_rel       DECIMAL(10,6)         DEFAULT NULL   COMMENT '相对扩展不确定度 U95（k=2）',
  u_low         DECIMAL(18,3)         DEFAULT NULL   COMMENT '95% 区间下界 tCO2e',
  u_high        DECIMAL(18,3)         DEFAULT NULL   COMMENT '95% 区间上界 tCO2e',
  -- 可复算性：输入摘要 + 输出摘要
  input_digest  VARCHAR(80)  NOT NULL                COMMENT '输入数据摘要（所有参与核算的行的规范化哈希）',
  result_digest VARCHAR(80)  NOT NULL                COMMENT '结果摘要（对结果规范化后的哈希）',
  engine_version VARCHAR(20) NOT NULL DEFAULT '1.0'  COMMENT '核算引擎版本',
  -- 状态与存证
  status        VARCHAR(20)  NOT NULL DEFAULT 'COMPUTED' COMMENT 'COMPUTED 已计算 / CONFIRMED 已确认 / LINKED 已上链 / VOID 作废',
  chain_block_index INT               DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id   VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  operator      VARCHAR(40)           DEFAULT NULL   COMMENT '发起人',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_calc_batch (batch_no),
  KEY idx_cb_ent_year (ent_id, year),
  KEY idx_cb_status (status),
  KEY idx_cb_digest (input_digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核算批次（可复算、可回溯）';

-- -------------------------------------------------------------------------------------
-- 37. calc_source_detail  核算批次的分源明细
--     每个排放源一行：活动数据 → 因子 → 排放量 → 推导式。
--     这张表让「一个总数」变成「N 条可逐项核对的推导」，是答辩时最有力的一页。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calc_source_detail (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  batch_id      BIGINT       NOT NULL                COMMENT '所属核算批次ID',
  source_code   VARCHAR(40)  NOT NULL                COMMENT '排放源代码',
  source_cn     VARCHAR(60)  NOT NULL                COMMENT '排放源中文名',
  source_type   VARCHAR(20)  NOT NULL                COMMENT 'FUEL/PROCESS/INDIRECT',
  scope         TINYINT      NOT NULL                COMMENT '核算范围',
  -- 输入
  activity      DECIMAL(18,4)         DEFAULT NULL   COMMENT '活动数据合计',
  activity_unit VARCHAR(20)           DEFAULT NULL   COMMENT '活动数据单位',
  months_count  INT          NOT NULL DEFAULT 0      COMMENT '有数据的月数（满 12 才算完整年）',
  -- 因子
  ef_value      DECIMAL(16,8)         DEFAULT NULL   COMMENT '采用的排放因子',
  ef_source     VARCHAR(200)          DEFAULT NULL   COMMENT '因子出处',
  ef_tier       VARCHAR(30)           DEFAULT NULL   COMMENT 'Tier1缺省/Tier2实测',
  -- 推导：把算式原样存下来，第三方可逐字复核
  derivation    VARCHAR(400)          DEFAULT NULL   COMMENT '推导式原文，如 "12000 t × 1.9003 = 22803.6"',
  -- 结果
  emission      DECIMAL(18,3)         DEFAULT NULL   COMMENT '该源排放量 tCO2e（无数据时为 NULL 而非 0）',
  status        VARCHAR(20)  NOT NULL DEFAULT 'OK'   COMMENT 'OK/NO_DATA/UNIT_MISMATCH/UNKNOWN_FACTOR',
  gap_reason    VARCHAR(300)          DEFAULT NULL   COMMENT '未核算原因',
  data_origin   VARCHAR(4)            DEFAULT NULL   COMMENT '该源最差来源等级（木桶原理取最差）',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  KEY idx_csd_batch (batch_id),
  KEY idx_csd_source (source_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核算分源明细（逐项可核对）';

-- -------------------------------------------------------------------------------------
-- 38. settlement_account  资金结算账户
--     交易必须有对手方与资金，否则「成交」只是改了配额数字。
--     单一账户制（不做多币种子账户），币种固定 CNY，预留 currency 字段以便扩展。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settlement_account (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id        BIGINT       NOT NULL                COMMENT '企业ID',
  currency      VARCHAR(8)   NOT NULL DEFAULT 'CNY'  COMMENT '币种',
  balance       DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '可用余额（元）',
  frozen        DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '冻结金额（挂单保证金，元）',
  total_in      DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '累计入金（元）',
  total_out     DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '累计出金（元）',
  credit_limit  DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '授信额度（元），0 表示无授信',
  status        VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE 正常 / FROZEN 冻结',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_settle_ent (ent_id, currency),
  KEY idx_settle_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='资金结算账户';

-- -------------------------------------------------------------------------------------
-- 39. settlement_flow  资金流水（复式记账）
--     每一笔资金变动都记两行：一借一贷，且必须成对出现。
--     为什么用复式：单式记账无法发现「钱从哪来、到哪去」的错误，
--     而碳交易的每一笔都有明确的对手方，天然适合复式。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settlement_flow (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  flow_no       VARCHAR(40)  NOT NULL                COMMENT '流水号',
  biz_type      VARCHAR(30)  NOT NULL                COMMENT '业务类型 DEPOSIT入金/WITHDRAW出金/TRADE_BUY买入/TRADE_SELL卖出/FEE手续费/SURRENDER清缴/REFUND退款',
  biz_ref       VARCHAR(60)           DEFAULT NULL   COMMENT '业务关联号（订单号/成交号/清缴单号）',
  ent_id        BIGINT       NOT NULL                COMMENT '账户所属企业',
  direction     VARCHAR(10)  NOT NULL                COMMENT 'DEBIT 借（减少）/ CREDIT 贷（增加）',
  amount        DECIMAL(20,2) NOT NULL               COMMENT '发生额（元，恒为正数）',
  balance_after DECIMAL(20,2) NOT NULL               COMMENT '变动后余额（元）',
  counterparty  BIGINT                DEFAULT NULL   COMMENT '对手方企业ID（内部转账时必填）',
  remark        VARCHAR(200)          DEFAULT NULL   COMMENT '备注',
  -- 资金流水上链：金额是最不能篡改的数据
  chain_block_index INT               DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id   VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发生时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_flow_no (flow_no),
  KEY idx_flow_ent (ent_id, created_at),
  KEY idx_flow_biz (biz_type, biz_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='资金流水（复式记账）';

-- -------------------------------------------------------------------------------------
-- 40. quota_surrender  配额履约清缴
--     清缴是碳市场闭环的最后一环：企业把配额交还给监管方，用于覆盖其核证排放量。
--     不清缴 ⇒ 配额永不消耗 ⇒ 稀缺性不存在 ⇒ 碳价无意义。
--     一张清缴单覆盖一个企业一个年度，状态流转：
--       PENDING 待核定 → SURRENDERED 已清缴 → CERTIFIED 已出具凭证
--                       → SHORTFALL 存在缺口（未足额清缴）
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quota_surrender (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  surrender_no  VARCHAR(40)  NOT NULL                COMMENT '清缴单号',
  ent_id        BIGINT       NOT NULL                COMMENT '企业ID',
  year          INT          NOT NULL                COMMENT '履约年度',
  -- 三个关键量：核定排放 / 应清缴配额 / 实清缴配额
  verified_emission DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT '经核查认定的排放量 tCO2e（来自 verify_report 或 calc_batch）',
  offset_used   DECIMAL(18,3) NOT NULL DEFAULT 0     COMMENT '已用碳信用抵销量 tCO2e',
  required_quota DECIMAL(18,3) NOT NULL DEFAULT 0    COMMENT '应清缴配额 = 核定排放 − 抵销量',
  surrendered_quota DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT '实清缴配额 tCO2e',
  -- 缺口与罚则
  shortfall     DECIMAL(18,3) NOT NULL DEFAULT 0     COMMENT '缺口 tCO2e（正=不足）',
  penalty       DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '罚款金额（元），按缺口 × 碳价 × 罚则倍数',
  penalty_rule  VARCHAR(200)          DEFAULT NULL   COMMENT '罚则依据',
  -- 溯源
  calc_batch_id BIGINT                DEFAULT NULL   COMMENT '依据的核算批次',
  verify_report_id BIGINT             DEFAULT NULL   COMMENT '依据的核查报告',
  emission_source VARCHAR(30)        DEFAULT NULL   COMMENT '排放量取值来源 CALC_BATCH/VERIFY_REPORT/MANUAL',
  status        VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/SURRENDERED/SHORTFALL/CERTIFIED',
  certificate_no VARCHAR(60)          DEFAULT NULL   COMMENT '清缴凭证号',
  chain_block_index INT               DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id   VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  operator      VARCHAR(40)           DEFAULT NULL   COMMENT '经办人',
  deadline      DATE                  DEFAULT NULL   COMMENT '法定清缴截止日',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_surrender_no (surrender_no),
  UNIQUE KEY uk_surrender_ent_year (ent_id, year),
  KEY idx_sur_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='配额履约清缴';

-- -------------------------------------------------------------------------------------
-- 41. credit_retirement  碳信用注销
--     注销 ≠ 抵销。抵销是「用掉」（还能被查询为已使用），注销是「永久销毁」
--     （对应减排量真实被消费，不可再流通）。
--     CCER 规则要求：抵销的减排量必须注销，且注销后不得再次进入市场。
--     没有注销 = 同一份减排量可以被无限次声称，这是碳市场最经典的漏洞。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_retirement (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  retire_no     VARCHAR(40)  NOT NULL                COMMENT '注销单号',
  ent_id        BIGINT       NOT NULL                COMMENT '申请注销的企业ID',
  asset_id      BIGINT       NOT NULL                COMMENT '被注销的碳信用资产ID',
  amount        DECIMAL(18,3) NOT NULL               COMMENT '注销数量 tCO2e',
  purpose       VARCHAR(30)  NOT NULL                COMMENT '注销用途 OFFSET履约抵销 / VOLUNTARY自愿碳中和 / CBAM出口抵扣',
  beneficiary   VARCHAR(120)          DEFAULT NULL   COMMENT '受益人/声明主体（自愿碳中和时的品牌方）',
  -- 双重声明防护：同一资产只能注销一次，注销后资产状态置 RETIRED
  asset_status_before VARCHAR(20)     DEFAULT NULL   COMMENT '注销前资产状态（审计用）',
  proof_hash    VARCHAR(80)           DEFAULT NULL   COMMENT '注销凭证摘要',
  chain_block_index INT               DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id   VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  status        VARCHAR(20)  NOT NULL DEFAULT 'CONFIRMED' COMMENT 'CONFIRMED 已注销 / REVOKED 已撤销（仅限错误注销）',
  operator      VARCHAR(40)           DEFAULT NULL   COMMENT '经办人',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '注销时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_retire_no (retire_no),
  KEY idx_retire_asset (asset_id),
  KEY idx_retire_ent (ent_id, purpose)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='碳信用注销记录';

-- -------------------------------------------------------------------------------------
-- 42. cbam_certificate  CBAM 证书台账
--     CBAM 的商业核心不是「算排放」，而是「买证书」。没有这张表，CBAM 只是报表工具。
--     证书数量公式（EU 2023/956 第 31 条 + 实施条例草案）：
--       certificates = max(0, embedded_emissions − free_allocation) × cbam_factor
--     其中 free_allocation 按 EU ETS 基准线法计算，cbam_factor 2026-2034 线性递减。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cbam_certificate (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  cert_no       VARCHAR(40)  NOT NULL                COMMENT '证书编号',
  ent_id        BIGINT       NOT NULL                COMMENT '企业ID',
  declaration_id BIGINT               DEFAULT NULL   COMMENT '关联的 CBAM 申报单',
  year          INT          NOT NULL                COMMENT '履约年度',
  -- 数量计算链（每一步都留痕，便于进口商复核）
  embedded_emission DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT '内含排放 tCO2e',
  free_allocation DECIMAL(18,3) NOT NULL DEFAULT 0   COMMENT '对应免费配额 tCO2e（按 EU ETS 基准线法）',
  cbam_factor   DECIMAL(8,4)  NOT NULL DEFAULT 1     COMMENT 'CBAM 免费配额递减因子 0~1',
  payable_emission DECIMAL(18,3) NOT NULL DEFAULT 0  COMMENT '应缴排放 = (内含排放 − 免费配额) × factor，下限 0',
  -- 价格与金额
  eua_price_eur DECIMAL(12,4) NOT NULL DEFAULT 0     COMMENT 'EUA 均价 EUR/t',
  eur_cny       DECIMAL(10,4) NOT NULL DEFAULT 0     COMMENT '欧元兑人民币汇率',
  price_source  VARCHAR(200)          DEFAULT NULL   COMMENT '价格来源（季度均价/周均价/来源机构）',
  amount_eur    DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '证书金额 EUR',
  amount_cny    DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '证书金额 CNY',
  -- 原产国碳价扣减（EU 2023/956 第 9 条）
  origin_carbon_price_paid DECIMAL(20,2) NOT NULL DEFAULT 0 COMMENT '原产国已支付碳价（可扣减，CNY）',
  deduction_cny DECIMAL(20,2) NOT NULL DEFAULT 0     COMMENT '实际扣减额（不超过证书金额）',
  net_payable_cny DECIMAL(20,2) NOT NULL DEFAULT 0   COMMENT '净应付（CNY）',
  -- 状态
  status        VARCHAR(20)  NOT NULL DEFAULT 'CALCULATED' COMMENT 'CALCULATED已计算/PURCHASED已购买/SURRENDERED已清缴/VOID作废',
  chain_block_index INT               DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id   VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_cbam_cert (cert_no),
  KEY idx_cbam_ent_year (ent_id, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='CBAM 证书台账';

-- -------------------------------------------------------------------------------------
-- 43. green_cert  绿证/绿电台账（防双重声明）
--     为什么自建台账：绿电抵扣是 CBAM 与国内核算都认的减项，也是最容易被重复声明的环节。
--     防重复的三道锁：
--       ① cert_no 全局唯一 —— 一张证只能存在一行
--       ② claim_status 显式流转 —— CLAIMED 后不可再次领取
--       ③ 领用记录与核算批次绑定 —— 同一批次不能重复领同一张证
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS green_cert (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  cert_no       VARCHAR(60)  NOT NULL                COMMENT '绿证编号（来自核发机构，全局唯一）',
  cert_type     VARCHAR(30)  NOT NULL                COMMENT '类型 GEC绿证 / PPA直购 / SELFGEN自发电 / CROSS_PROV跨省绿电',
  issuer        VARCHAR(120) NOT NULL                COMMENT '核发机构',
  energy_source VARCHAR(30)  NOT NULL                COMMENT '能源来源 风电/光伏/水电/生物质',
  -- 电量与时段
  energy_mwh    DECIMAL(18,4) NOT NULL               COMMENT '对应电量 MWh',
  period_from   DATE         NOT NULL                COMMENT '对应发电起始日',
  period_to     DATE         NOT NULL                COMMENT '对应发电终止日',
  -- 归属与声明
  owner_ent_id  BIGINT                DEFAULT NULL   COMMENT '当前持有人企业ID',
  claim_status  VARCHAR(20)  NOT NULL DEFAULT 'AVAILABLE' COMMENT 'AVAILABLE可领用/CLAIMED已领用/RETIRED已注销/EXPIRED已过期',
  claimed_by_ent BIGINT               DEFAULT NULL   COMMENT '领用企业ID',
  claimed_batch  BIGINT               DEFAULT NULL   COMMENT '领用时的核算批次ID',
  claimed_at    DATETIME              DEFAULT NULL   COMMENT '领用时间',
  -- 溯源
  chain_block_index INT               DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id   VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_green_cert (cert_no),
  KEY idx_gc_status (claim_status),
  KEY idx_gc_owner (owner_ent_id),
  KEY idx_gc_period (period_from, period_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='绿证绿电台账（防双重声明）';

-- -------------------------------------------------------------------------------------
-- 44. verification_finding  核查发现项（不符合项）
--     真实核查工作的产出不是「通过/不通过」，而是一份发现项清单。
--     这是核查机构收费的实际交付物，也是平台「成熟程度」的证据。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_finding (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  task_id       BIGINT       NOT NULL                COMMENT '关联核查任务ID',
  finding_no    VARCHAR(40)  NOT NULL                COMMENT '发现项编号',
  category      VARCHAR(30)  NOT NULL                COMMENT '类别 DATA数据 / METHOD方法 / SYSTEM系统 / BOUNDARY边界 / DOC文档',
  severity      VARCHAR(20)  NOT NULL DEFAULT 'MINOR' COMMENT '严重程度 MAJOR重大/MINOR一般/OBSERVATION观察项',
  title         VARCHAR(200) NOT NULL                COMMENT '发现项标题',
  description   TEXT                  DEFAULT NULL   COMMENT '详细描述',
  evidence_ref  VARCHAR(300)          DEFAULT NULL   COMMENT '证据引用（表名+记录ID/文件摘要）',
  -- 整改闭环
  status        VARCHAR(20)  NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN待整改/RECTIFIED已整改/ACCEPTED已接受/CLOSED已关闭',
  correction    TEXT                  DEFAULT NULL   COMMENT '整改措施',
  rectify_deadline DATE               DEFAULT NULL   COMMENT '整改期限',
  rectified_at  DATETIME              DEFAULT NULL   COMMENT '整改完成时间',
  verified_by   VARCHAR(40)           DEFAULT NULL   COMMENT '确认人',
  -- 与具体业务对象的关联
  related_batch BIGINT                DEFAULT NULL   COMMENT '关联核算批次',
  related_source VARCHAR(40)          DEFAULT NULL   COMMENT '关联排放源',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_finding_no (finding_no),
  KEY idx_vf_task (task_id),
  KEY idx_vf_status (status, severity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='核查发现项（不符合项闭环）';

-- -------------------------------------------------------------------------------------
-- 45. zk_commitment  零知识承诺存证
--     只存**公开部分**（承诺点 + 范围证明 + 摘要）。
--     ⚠ 绝不存原始排放量与盲化因子 —— 那是企业商业机密本身。
--     平台自身也无法从本表反推任何数值，这是设计目标而非疏漏。
--
--     为什么这张表是平台能否进入真实企业的关键：
--       企业不愿明文上链活动数据（产量/能耗/工艺是商业机密），
--       而监管必须能验证。承诺 + 范围证明让"可验证但不披露"成为可能。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zk_commitment (
  id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id          BIGINT       NOT NULL                COMMENT '企业ID',
  year            INT          NOT NULL                COMMENT '核算年度',
  protocol        VARCHAR(20)  NOT NULL DEFAULT 'zkc-v1' COMMENT '协议版本（升级后需按版本验证）',
  -- 承诺：65 字节未压缩椭圆曲线点（04||X||Y）
  commit_value    VARCHAR(140) NOT NULL                COMMENT 'Pedersen 承诺点（公开）',
  -- 证明：序列化后的范围证明
  proof_json      JSON         NOT NULL                COMMENT '范围证明（公开）',
  -- 分源承诺（可选）：只含来源代码与承诺点，不含数值
  parts_json      JSON                  DEFAULT NULL   COMMENT '分源承诺列表（仅承诺点）',
  -- 摘要：绑定协议版本 + 承诺 + 证明 + 企业 + 年度 + 缩放因子
  digest          VARCHAR(80)  NOT NULL                COMMENT '承诺包摘要',
  bits            INT          NOT NULL DEFAULT 64     COMMENT '范围证明位宽',
  scale_factor    INT          NOT NULL DEFAULT 1000   COMMENT '量纲缩放（承诺整数 = 吨 × scale）',
  unit            VARCHAR(20)  NOT NULL DEFAULT 'tCO2e' COMMENT '计量单位',
  prove_ms        INT                   DEFAULT NULL   COMMENT '证明生成耗时（性能证据）',
  status          VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE 生效 / SUPERSEDED 被新版替代 / REVOKED 撤销',
  chain_block_index INT                 DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id     VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  created_by      VARCHAR(40)           DEFAULT NULL   COMMENT '提交人',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_zk_commit (ent_id, year, commit_value),
  KEY idx_zk_ent_year (ent_id, year),
  KEY idx_zk_status (status),
  KEY idx_zk_digest (digest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='零知识承诺存证（不含任何原始数值）';

-- -------------------------------------------------------------------------------------
-- 46. zk_disclosure_log  授权披露日志
--     企业每次主动打开承诺（披露数值），都必须留痕。
--     为什么重要：隐私保护的价值在于"披露是可审计的"。
--     若披露不留痕，企业可以私下把数据给竞争对手，平台无法追责。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zk_disclosure_log (
  id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  commitment_id   BIGINT       NOT NULL                COMMENT '关联的承诺ID',
  ent_id          BIGINT       NOT NULL                COMMENT '披露方企业ID',
  scope           VARCHAR(10)  NOT NULL                COMMENT '披露范围 TOTAL 总量 / PART 单分项',
  source_code     VARCHAR(40)           DEFAULT NULL   COMMENT '当 scope=PART 时的分项代码',
  grantee         VARCHAR(120)          DEFAULT NULL   COMMENT '被授权方（核查机构/监管/进口商）',
  purpose         VARCHAR(200)          DEFAULT NULL   COMMENT '披露用途',
  operator        VARCHAR(40)           DEFAULT NULL   COMMENT '经办人',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '披露时间',
  PRIMARY KEY (id),
  KEY idx_zd_commit (commitment_id),
  KEY idx_zd_ent (ent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='授权披露日志（披露行为可审计）';

-- -------------------------------------------------------------------------------------
-- 47. zk_formula_proof  公式正确性零知识证明
--     证明「本批次的排放量确实等于 Σ(排放因子 × 活动数据)」，
--     且不披露任何活动数据或排放量数值。
--
--     为什么这是必要的（补上一轮的语义缺口）：
--       承诺 + 范围证明只能证明「这个数在 [0, 2^64) 内」——
--       企业完全可以填任意数字，范围证明对它零保障。
--       本表存的证明补上「这个数是算出来的」这一层。
--
--     只存公开部分：EF 整数（公开）、AD 承诺点、E 承诺点、证明体。
--     活动数据与盲化因子**绝不入库**。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zk_formula_proof (
  id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id          BIGINT       NOT NULL                COMMENT '企业ID',
  year            INT          NOT NULL                COMMENT '核算年度',
  batch_no        VARCHAR(40)  NOT NULL                COMMENT '核算批次号',
  factor_version  VARCHAR(20)           DEFAULT NULL   COMMENT '锁定的因子版本',
  source_count    INT          NOT NULL DEFAULT 0      COMMENT '参与公式的排放源数量',
  ef_scale        TINYINT      NOT NULL DEFAULT 4      COMMENT '因子缩放指数',
  ad_scale        TINYINT      NOT NULL DEFAULT 3      COMMENT '活动数据缩放指数',
  e_scale         TINYINT      NOT NULL DEFAULT 7      COMMENT '排放量缩放指数（须等于 ef+ad）',
  e_commit        VARCHAR(140) NOT NULL                COMMENT '排放量承诺点',
  payload_json    JSON         NOT NULL                COMMENT '公开证明包（承诺/因子/证明）',
  digest          VARCHAR(80)  NOT NULL                COMMENT '公开包摘要',
  proof_bytes     INT                   DEFAULT NULL   COMMENT '证明体字节数',
  status          VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / SUPERSEDED / REVOKED',
  chain_block_index INT                 DEFAULT NULL   COMMENT '存证区块高度',
  chain_tx_id     VARCHAR(80)           DEFAULT NULL   COMMENT '存证交易号',
  created_by      VARCHAR(40)           DEFAULT NULL   COMMENT '提交人',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_zkfp_digest (digest),
  KEY idx_zkfp_batch (batch_no),
  KEY idx_zkfp_ent_year (ent_id, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公式正确性零知识证明（不含活动数据与排放量）';

-- =====================================================================================
-- 真实数据溯源层（2026-10-24 新增）
-- =====================================================================================
-- 【为什么必须单独一层，而不是往原表里塞字段】
-- 平台此前所有数据都是合成数据，"数据来源"这一个概念根本不存在。
-- 现在要接入真实数据（EPA GHGRP / World Bank / OWID 等），
-- 核心要求是：**每一条数据都能回答"你从哪来"**。
--
-- 因此设计两张表：
--   data_source     数据源登记（谁提供的、什么许可、怎么取、多久更新）
--   data_ingest_log 每次采集的留痕（取了什么、多少条、成功还是失败）
--
-- 并在业务表上加 `data_source_id` / `is_estimate` 两个字段，
-- 使"真实 / 估算 / 合成"三者可以**在同一张表里共存但严格区分**。
-- =====================================================================================

-- 48. data_source  数据源登记表
CREATE TABLE IF NOT EXISTS data_source (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  source_key    VARCHAR(40)  NOT NULL                COMMENT '源标识 worldbank/owid/epa_ghgrp/mee_factor/cneeex',
  name          VARCHAR(200) NOT NULL                COMMENT '数据源全名',
  publisher     VARCHAR(200)          DEFAULT NULL   COMMENT '发布机构',
  url           VARCHAR(400)          DEFAULT NULL   COMMENT '取数地址或数据集页面',
  license       VARCHAR(100)          DEFAULT NULL   COMMENT '许可协议',
  -- 真实性等级：这是最关键的一个字段
  --   REAL       官方公开发布的真实数据（可溯源到原始文件）
  --   ESTIMATE   基于真实公开数据的推算（如 营收×行业强度）
  --   SYNTHETIC  算法生成的合成数据（仅用于功能演示）
  authenticity  VARCHAR(12)  NOT NULL DEFAULT 'REAL' COMMENT 'REAL/ESTIMATE/SYNTHETIC',
  scope         VARCHAR(20)  NOT NULL DEFAULT 'MACRO' COMMENT 'MACRO 宏观/ENTITY 企业/DEVICE 设备/FACTOR 因子/MARKET 市场',
  -- 更新策略
  refresh_ttl_ms BIGINT      NOT NULL DEFAULT 86400000 COMMENT '缓存有效期（毫秒）',
  last_fetched_at DATETIME            DEFAULT NULL   COMMENT '最近一次成功采集时间',
  last_status   VARCHAR(20)           DEFAULT NULL   COMMENT '最近一次采集结果 OK/FAIL',
  last_error    VARCHAR(400)          DEFAULT NULL   COMMENT '最近一次失败原因',
  record_count  INT                   DEFAULT NULL   COMMENT '最近一次采集到的记录数',
  note          VARCHAR(500)          DEFAULT NULL   COMMENT '说明（含口径与局限）',
  enabled       TINYINT      NOT NULL DEFAULT 1      COMMENT '是否启用',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '登记时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_source_key (source_key),
  KEY idx_ds_scope (scope, authenticity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据源登记表（含真实性等级）';

-- 49. data_ingest_log  数据采集留痕
--     每次从外部源拉取都写一条，无论成功失败。
--     为什么失败也要记：失败本身是重要事实 ——
--     它解释了「为什么界面上这个数字是 3 小时前的」。
CREATE TABLE IF NOT EXISTS data_ingest_log (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  source_key    VARCHAR(40)  NOT NULL                COMMENT '数据源标识',
  started_at    DATETIME     NOT NULL                COMMENT '开始时间',
  finished_at   DATETIME              DEFAULT NULL   COMMENT '结束时间',
  duration_ms   INT                   DEFAULT NULL   COMMENT '耗时（毫秒）',
  status        VARCHAR(20)  NOT NULL                COMMENT 'OK / FAIL / CACHED / STALE',
  records       INT                   DEFAULT NULL   COMMENT '入库/返回记录数',
  from_cache    TINYINT      NOT NULL DEFAULT 0      COMMENT '是否来自缓存',
  error         VARCHAR(500)          DEFAULT NULL   COMMENT '失败原因',
  detail_json   JSON                  DEFAULT NULL   COMMENT '明细（摘要统计）',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  KEY idx_dil_source (source_key, created_at),
  KEY idx_dil_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据采集留痕（成功与失败均记录）';

-- -------------------------------------------------------------------------------------
-- 业务表扩展：让真实数据与合成数据可以共存但严格区分
-- -------------------------------------------------------------------------------------
-- ⚠ 用 ALTER TABLE ... ADD COLUMN IF NOT EXISTS 不可靠（MySQL 8.0 不支持该语法），
--   改用存储过程做幂等加列。

DROP PROCEDURE IF EXISTS cc_add_col;
DELIMITER $$
CREATE PROCEDURE cc_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(400))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = tbl AND column_name = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', ddl);
    PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
  END IF;
END$$
DELIMITER ;

-- enterprise：真实企业标识
CALL cc_add_col('enterprise', 'data_source_id', 'BIGINT DEFAULT NULL COMMENT ''数据源ID（NULL=平台合成）''');
CALL cc_add_col('enterprise', 'external_id', 'VARCHAR(60) DEFAULT NULL COMMENT ''外部系统ID（如 EPA Facility Id）''');
CALL cc_add_col('enterprise', 'latitude', 'DECIMAL(10,6) DEFAULT NULL COMMENT ''真实纬度''');
CALL cc_add_col('enterprise', 'longitude', 'DECIMAL(10,6) DEFAULT NULL COMMENT ''真实经度''');
CALL cc_add_col('enterprise', 'naics', 'VARCHAR(10) DEFAULT NULL COMMENT ''NAICS 行业码（真实）''');
CALL cc_add_col('enterprise', 'is_real', 'TINYINT NOT NULL DEFAULT 0 COMMENT ''1=真实主体 0=合成''');

-- emission_report：真实排放量标识
CALL cc_add_col('emission_report', 'data_source_id', 'BIGINT DEFAULT NULL COMMENT ''数据源ID''');
CALL cc_add_col('emission_report', 'is_real', 'TINYINT NOT NULL DEFAULT 0 COMMENT ''1=官方报告值 0=合成''');
CALL cc_add_col('emission_report', 'co2_only', 'DECIMAL(16,3) DEFAULT NULL COMMENT ''纯CO2排放（非生物质）''');
CALL cc_add_col('emission_report', 'ch4_co2e', 'DECIMAL(16,3) DEFAULT NULL COMMENT ''CH4折算CO2e''');
CALL cc_add_col('emission_report', 'n2o_co2e', 'DECIMAL(16,3) DEFAULT NULL COMMENT ''N2O折算CO2e''');
CALL cc_add_col('emission_report', 'biogenic_co2', 'DECIMAL(16,3) DEFAULT NULL COMMENT ''生物质CO2（单列，不计入总量）''');

DROP PROCEDURE IF EXISTS cc_add_col;

-- 50. macro_indicator  宏观真实指标时间序列
--     国家级 CO2 排放、强度、分品种结构。
--     这是平台里最"硬"的真实数据：来自世界银行与 OWID，可逐条溯源。
CREATE TABLE IF NOT EXISTS macro_indicator (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  source_id     BIGINT       NOT NULL                COMMENT '数据源ID',
  country_iso   VARCHAR(3)   NOT NULL                COMMENT 'ISO3 国家代码',
  indicator     VARCHAR(60)  NOT NULL                COMMENT '指标代码 co2_total/coal_co2/oil_co2/...',
  indicator_cn  VARCHAR(80)           DEFAULT NULL   COMMENT '指标中文名',
  year          INT          NOT NULL                COMMENT '数据年度',
  value         DECIMAL(20,6)         DEFAULT NULL   COMMENT '数值（NULL 表示该年无数据，不填 0）',
  unit          VARCHAR(30)           DEFAULT NULL   COMMENT '单位',
  raw_json      JSON                  DEFAULT NULL   COMMENT '原始行（保留以便复核）',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_macro (source_id, country_iso, indicator, year),
  KEY idx_macro_ind (indicator, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='宏观真实指标时间序列（世行/OWID）';
