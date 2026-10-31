-- =====================================================================================
-- 08_schema_cems_public.sql —— 真实企业 CEMS 公开日均浓度（污染物浓度层）
-- =====================================================================================
-- 为什么单独建表、不复用 cems_reading：
--   cems_reading.flow_value 的语义是「排放速率 t/h」，是浓度×流量的乘积结果，
--   用于排放量核算；而本表存的是**污染物浓度 mg/m³**，没有流量、算不出排放量。
--   两者混存会让所有依赖 flow_value 的统计与核算口径静默出错。
--
-- 数据来源：生态环境部「生活垃圾焚烧发电厂自动监测数据公开平台」(ljgk.envsc.cn)
--   企业环境监测平台导出的原始报文（ps_code / mp_code / monitor_time /
--   pollutant_code / strength / standard_value / status / data_status）。
--   每条记录保留原始报文 JSON 摘要，可逐条回溯。
--
-- 真实性等级：REAL_PUBLIC —— 真实企业、真实公开数据，但不是企业授权的一手台账，
--   也不含烟气流量，**不得用于排放量核算**，只用于达标判定与链上存证演示。
-- =====================================================================================

CREATE TABLE IF NOT EXISTS cems_public_reading (
  id             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_code       VARCHAR(32)  NOT NULL                COMMENT '企业统一社会信用代码（回联 enterprise.ent_code）',
  ent_name       VARCHAR(120) NOT NULL                COMMENT '企业名称（原始报文口径）',
  ps_code        VARCHAR(64)           DEFAULT NULL   COMMENT '污染源平台编码',
  mp_code        VARCHAR(64)  NOT NULL                COMMENT '监控点/排放口平台编码',
  outlet_name    VARCHAR(80)           DEFAULT NULL   COMMENT '排放口名称',
  reading_time   DATETIME     NOT NULL                COMMENT '监测时间（原始报文 monitor_time，均为 00:00:00 的日均值）',
  pollutant_code VARCHAR(16)  NOT NULL                COMMENT '污染物编码（001/002/003/004/008）',
  pollutant_name VARCHAR(40)  NOT NULL                COMMENT '污染物名称',
  concentration  DECIMAL(16,6) NOT NULL               COMMENT '浓度实测值（原始字段 strength）',
  unit           VARCHAR(16)  NOT NULL DEFAULT 'mg/m3' COMMENT '浓度单位',
  standard_value DECIMAL(16,6)         DEFAULT NULL   COMMENT '标准限值（原始报文 standard_value）',
  exceed         TINYINT(1)   NOT NULL DEFAULT 0      COMMENT '是否超限：concentration > standard_value',
  status         VARCHAR(16)  NOT NULL DEFAULT '0'    COMMENT '原始报文 status',
  data_status    VARCHAR(16)  NOT NULL DEFAULT '0'    COMMENT '原始报文 data_status',
  is_valid       TINYINT(1)   NOT NULL DEFAULT 1      COMMENT '是否有效：status=0 且 data_status=0 且 concentration>0',
  source         VARCHAR(24)  NOT NULL DEFAULT 'LJGK' COMMENT '来源渠道：LJGK（公开平台）/ ENTERPRISE（企业回流）/ MANUAL',
  provenance     VARCHAR(16)  NOT NULL DEFAULT 'REAL_PUBLIC' COMMENT '真实性等级',
  batch_no       VARCHAR(48)  NOT NULL                COMMENT '内容寻址批次号 CPS-<sha256前24位>',
  chain_tx_id    VARCHAR(80)           DEFAULT NULL   COMMENT '链上存证交易ID',
  raw_json       JSON                  DEFAULT NULL   COMMENT '原始报文单条 JSON（溯源凭证）',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_cpr (mp_code, reading_time, pollutant_code),
  KEY idx_cpr_ent (ent_code, reading_time),
  KEY idx_cpr_batch (batch_no),
  KEY idx_cpr_poll (pollutant_name, reading_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='真实企业CEMS公开日均浓度（无流量，不用于排放量核算）';

-- -------------------------------------------------------------------------------------
-- 企业年度活动水平（官方统计口径）——活动水平法核算的唯一输入
-- 来源：河北省发改委《垃圾发电厂2024年垃圾处理量及上网电量情况统计表》
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enterprise_activity (
  id             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_code       VARCHAR(32)  NOT NULL                COMMENT '企业统一社会信用代码',
  ent_name       VARCHAR(120) NOT NULL                COMMENT '企业/项目名称（统计表原口径）',
  year           INT          NOT NULL                COMMENT '统计年度',
  capacity_mw    DECIMAL(10,2)         DEFAULT NULL   COMMENT '装机容量 MW',
  msw_10kt       DECIMAL(14,4)         DEFAULT NULL   COMMENT '年垃圾处理量（万吨，入炉口径）',
  grid_kwh_10k   DECIMAL(16,4)         DEFAULT NULL   COMMENT '年上网电量（万kWh）',
  waste_kwh_10k  DECIMAL(16,4)         DEFAULT NULL   COMMENT '年垃圾发电上网电量（万kWh）',
  source         VARCHAR(200) NOT NULL                COMMENT '数据来源（发布机构+文件名称）',
  source_url     VARCHAR(300)          DEFAULT NULL   COMMENT '来源链接',
  provenance     VARCHAR(16)  NOT NULL DEFAULT 'REAL_OFFICIAL' COMMENT '真实性等级',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ea (ent_code, ent_name, year),
  KEY idx_ea_year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='企业年度活动水平（官方统计口径）';

-- -------------------------------------------------------------------------------------
-- 活动水平法核算结果（可复算）——E = MSW × 矿物碳因子 × 氧化率
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emission_calc (
  id             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_code       VARCHAR(32)  NOT NULL                COMMENT '企业统一社会信用代码',
  ent_name       VARCHAR(120) NOT NULL                COMMENT '企业名称',
  year           INT          NOT NULL                COMMENT '核算年度',
  method         VARCHAR(40)  NOT NULL DEFAULT 'ACTIVITY_MAIN' COMMENT '核算方法：ACTIVITY_MAIN（活动水平主线）/ CEMS_DIRECT（CEMS直接法，需流量）',
  msw_t          DECIMAL(18,2)         DEFAULT NULL   COMMENT '入炉垃圾量 t',
  factor_tco2_t  DECIMAL(12,6)         DEFAULT NULL   COMMENT '矿物碳排放因子 tCO2/t',
  oxidation      DECIMAL(6,4)          DEFAULT NULL   COMMENT '碳氧化率',
  total_tco2     DECIMAL(18,2)         DEFAULT NULL   COMMENT '矿物碳CO2排放量 tCO2',
  biogenic_tco2  DECIMAL(18,2)         DEFAULT NULL   COMMENT '生物碳CO2（信息项，不计入总量）',
  factor_ref     VARCHAR(200)          DEFAULT NULL   COMMENT '因子出处（标准号+附录）',
  evidence       VARCHAR(400)          DEFAULT NULL   COMMENT '可复算说明（公式与输入）',
  status         VARCHAR(20)  NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT/CALCULATED/ANCHORED',
  chain_tx_id    VARCHAR(80)           DEFAULT NULL   COMMENT '链上存证交易ID',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ec (ent_code, year, method)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='活动水平法排放核算结果（可复算、可上链）';
