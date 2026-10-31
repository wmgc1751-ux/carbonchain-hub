-- =====================================================================================
-- 10_schema_cems_cn_hourly.sql —— 中国控排企业真实 CEMS 小时级数据（河北省公开系统）
-- =====================================================================================
-- 数据来源：河北省污染源自动监控信息公开系统（https://111.62.218.180:9920）
--   接口：POST /online_statistics/v5/dataQuery/list（X-ACCESS: ANONYMOUS）
--   这是河北省生态环境厅官方公开发布的小时级自动监测数据。
--
-- 与 08 号表（ljgk 日均浓度）的区别：
--   ljgk   = 日均值、只有 5 项浓度、无流量 → 不能算排放量
--   本表   = 小时级、含烟气量(m³)与每项污染物的排放量(kg) → **可直接做排放核算**
--
-- 与 09 号表（EPA CAMD）的区别：
--   EPA    = 美国 Part 75 体系、CO₂ 直测（国际参照集）
--   本表   = 中国河北省体系、CO₂ 不监测（GB 18485 只有 5 项污染物），
--            但 SO₂/NOx/颗粒物/CO/HCl 的排放量(kg) 是浓度×烟气量的真实产物
--
-- 内部自洽：排放量(kg) ≈ 实测浓度(mg/m³) × 烟气量(m³) × 1e-6
--   2335 条可验样本吻合率 92.5%；不符者多源于源头平台对 cou 只保留 1-2 位
--   有效数字（0.0010/0.0050 这类截断），以及传感器漂移时段的负流量。
--   两者均如实保留并标记，不做"修正"。
-- =====================================================================================

CREATE TABLE IF NOT EXISTS cems_cn_hourly (
  id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_name        VARCHAR(120) NOT NULL                COMMENT '企业名称',
  outlet_name     VARCHAR(80)  NOT NULL                COMMENT '排放口名称',
  monitored_at    DATETIME     NOT NULL                COMMENT '监控时间（小时）',
  op_status       VARCHAR(40)           DEFAULT NULL   COMMENT '生产设施工况（正常生产/停运等）',
  flue_gas_m3     DECIMAL(18,4)         DEFAULT NULL   COMMENT '烟气量（m³/h，a00000-cou）',
  furnace_temp_c  DECIMAL(12,3)         DEFAULT NULL   COMMENT '炉膛平均温度 ℃（a01901）',
  o2_pct          DECIMAL(10,3)         DEFAULT NULL   COMMENT '氧含量 %（a19001）',
  flow_velocity   DECIMAL(12,4)         DEFAULT NULL   COMMENT '烟气流速 m/s',
  gas_temp_c      DECIMAL(12,3)         DEFAULT NULL   COMMENT '烟气温度 ℃',
  gas_humidity    DECIMAL(12,3)         DEFAULT NULL   COMMENT '烟气湿度 %',
  gas_pressure    DECIMAL(12,4)         DEFAULT NULL   COMMENT '烟气压力 kPa',
  pm_measured     DECIMAL(16,6)         DEFAULT NULL   COMMENT '烟尘实测浓度 mg/m³（a34013-avg）',
  pm_corrected    DECIMAL(16,6)         DEFAULT NULL   COMMENT '烟尘折算浓度 mg/m³',
  pm_emission_kg  DECIMAL(16,6)         DEFAULT NULL   COMMENT '烟尘排放量 kg（平台口径）',
  so2_measured    DECIMAL(16,6)         DEFAULT NULL   COMMENT 'SO₂ 实测浓度',
  so2_corrected   DECIMAL(16,6)         DEFAULT NULL   COMMENT 'SO₂ 折算浓度',
  so2_emission_kg DECIMAL(16,6)         DEFAULT NULL   COMMENT 'SO₂ 排放量 kg',
  nox_measured    DECIMAL(16,6)         DEFAULT NULL   COMMENT 'NOx 实测浓度',
  nox_corrected   DECIMAL(16,6)         DEFAULT NULL   COMMENT 'NOx 折算浓度',
  nox_emission_kg DECIMAL(16,6)         DEFAULT NULL   COMMENT 'NOx 排放量 kg',
  co_measured     DECIMAL(16,6)         DEFAULT NULL   COMMENT 'CO 实测浓度',
  co_emission_kg  DECIMAL(16,6)         DEFAULT NULL   COMMENT 'CO 排放量 kg',
  hcl_measured    DECIMAL(16,6)         DEFAULT NULL   COMMENT 'HCl 实测浓度',
  hcl_emission_kg DECIMAL(16,6)         DEFAULT NULL   COMMENT 'HCl 排放量 kg',
  is_valid        TINYINT(1)   NOT NULL DEFAULT 1      COMMENT '有效：烟气量>0 且各排放量非负',
  invalid_reason  VARCHAR(80)           DEFAULT NULL   COMMENT '无效原因（负流量=传感器漂移等）',
  provenance      VARCHAR(24)  NOT NULL DEFAULT 'REAL_CEMS_CN' COMMENT '真实性等级',
  source          VARCHAR(60)  NOT NULL DEFAULT '河北省污染源自动监控信息公开系统' COMMENT '来源',
  batch_no        VARCHAR(48)  NOT NULL                COMMENT '内容寻址批次号 CN-<sha256前24位>',
  chain_tx_id     VARCHAR(80)           DEFAULT NULL   COMMENT '链上存证交易ID',
  fetched_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '取数时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_cch (outlet_name, monitored_at),
  KEY idx_cch_ent (ent_name, monitored_at),
  KEY idx_cch_batch (batch_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='中国控排企业CEMS小时级实测（含烟气量与排放量kg）';
