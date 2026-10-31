-- =====================================================================================
-- 09_schema_cems_emission.sql —— 真实 CEMS 排放量数据（EPA CAMD Part 75 小时级）
-- =====================================================================================
-- 为什么这张表能补上此前的缺口：
--   08 号表的 cems_public_reading 只有「污染物浓度 mg/m³」，没有流量、没有 CO₂，
--   因此算不出排放量。本表存的是**由 CEMS 分析仪直测得到的 CO₂ 质量排放（吨/小时）**，
--   并同时带齐足以交叉核验的伴生量测：热输入、负荷、SO₂、NOx、排放口栈号。
--
-- 数据来源：US EPA Clean Air Markets Program Data (CAMPD / EASEY API)
--   依据 40 CFR Part 75 的连续排放监测（CEMS）强制上报数据。
--   co2MassMeasureFlg = 'Measured' 表示该小时 CO₂ 质量由 CEMS 直接测得；
--   'Calculated' / 'Substitute' 等为替代值，本表用 is_measured 明确区分，不混算。
--
-- 【口径必须写清，否则会被当成中国控排企业数据】
--   本表是**国际参照集**，不是中国控排企业台账。
--   页面与接口必须同时显示 jurisdiction = 'US-EPA-CAMD'。
--
-- 单位换算（EPA 原始 → 本表）：
--   co2_mass        EPA 为 short ton(短吨) → 本表 metric_ton = × 0.90718474
--   so2_mass/nox_mass  EPA 为 lb(磅)      → 本表 kg = × 0.45359237
--   heat_input      MMBtu（不变）
--   gross_load      MW（不变）
--   op_time         小时（不变）
-- =====================================================================================

CREATE TABLE IF NOT EXISTS cems_emission_hourly (
  id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  jurisdiction    VARCHAR(24)  NOT NULL DEFAULT 'US-EPA-CAMD' COMMENT '辖区/数据体系',
  facility_id     INT          NOT NULL                COMMENT 'EPA 设施编号',
  facility_name   VARCHAR(120) NOT NULL                COMMENT '设施名称',
  state_code      VARCHAR(8)           DEFAULT NULL    COMMENT '州代码',
  unit_id         VARCHAR(24)  NOT NULL                COMMENT '机组编号',
  stack_id        VARCHAR(60)           DEFAULT NULL   COMMENT '排放口/烟囱编号（CEMS 溯源关键字段）',
  emission_date   DATE         NOT NULL                COMMENT '运行日期',
  emission_hour   TINYINT      NOT NULL                COMMENT '小时 0-23',
  op_time         DECIMAL(6,3)         DEFAULT NULL    COMMENT '该小时运行时长（小时）',
  gross_load_mw   DECIMAL(12,3)        DEFAULT NULL   COMMENT '毛负荷 MW',
  heat_input_mmbtu DECIMAL(16,3)       DEFAULT NULL   COMMENT '热输入 MMBtu',
  co2_mass_t      DECIMAL(16,4)        DEFAULT NULL   COMMENT 'CO₂ 质量排放（公吨，已由短吨换算）',
  co2_mass_raw_st DECIMAL(16,4)        DEFAULT NULL   COMMENT 'CO₂ 原始值（短吨，保留以便复核换算）',
  co2_rate_st_per_mmbtu DECIMAL(12,6)   DEFAULT NULL   COMMENT 'CO₂ 排放率（短吨/MMBtu，EPA原始口径）',
  so2_mass_kg     DECIMAL(16,4)        DEFAULT NULL   COMMENT 'SO₂ 质量（kg，已由磅换算）',
  nox_mass_kg     DECIMAL(16,4)        DEFAULT NULL   COMMENT 'NOx 质量（kg，已由磅换算）',
  co2_measure_flag VARCHAR(20)         DEFAULT NULL   COMMENT 'Measured/Calculated/Substitute 等（EPA 原文）',
  is_measured     TINYINT(1)  NOT NULL DEFAULT 0      COMMENT 'CO₂ 是否由 CEMS 直接测得',
  primary_fuel    VARCHAR(80)          DEFAULT NULL   COMMENT '主要燃料',
  unit_type       VARCHAR(80)          DEFAULT NULL   COMMENT '机组型式',
  program_code    VARCHAR(80)          DEFAULT NULL   COMMENT '适用排放交易项目代码',
  source          VARCHAR(40)  NOT NULL DEFAULT 'EPA-CAMD-EASEY' COMMENT '取数渠道',
  provenance      VARCHAR(24)  NOT NULL DEFAULT 'REAL_CEMS_MEASURED' COMMENT '真实性等级',
  batch_no        VARCHAR(48)  NOT NULL                COMMENT '内容寻址批次号 CEMS-<sha256前24位>',
  chain_tx_id     VARCHAR(80)           DEFAULT NULL   COMMENT '链上存证交易ID',
  raw_json        JSON                  DEFAULT NULL   COMMENT 'EPA 原始记录（溯源凭证）',
  fetched_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '取数时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ceh (facility_id, unit_id, emission_date, emission_hour),
  KEY idx_ceh_fac (facility_id, emission_date),
  KEY idx_ceh_batch (batch_no),
  KEY idx_ceh_measured (is_measured, emission_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='真实CEMS小时级排放量（EPA CAMD Part 75，国际参照集）';
