-- =====================================================================================
-- 05_schema_real.sql —— 真实数据层（Real Data Layer）
-- =====================================================================================
-- 【为什么单独建层，而不是塞进 enterprise 表】
--
-- 三条理由，任意一条都足够：
--   1. 语义正确性。EPA GHGRP 是美国设施数据。把一座德州燃煤电厂写进
--      `enterprise` 表并挂上"浙江省/化工"，那是 fabrication，不是 real data。
--      真实数据的第一要求是：它被当成本来的东西呈现。
--   2. 工程安全性。`enterprise` 表被 26 个服务/路由、4000+ 处 SQL 引用。
--      从 60 行变 4143 行会静默改变配额分配分母、履约率分母、行业均值、
--      风险评分基线——且不会报错，只会让所有数字悄悄变形。
--      这类"不报错的错"是最难发现的。
--   3. 生命周期独立。真实源数据按年度更新（EPA 一年一版），合成业务数据按
--      仿真节奏更新。把两者绑在一张表里，任何一方的重建都会波及另一方。
--
-- 【三层真实性契约】
--   REAL      官方公开数据，可逐条回溯到原始文件 + 校验和
--   DERIVED   以 REAL 为输入、经公开公式推导得出（推导链可复算）
--   MODELED   公开信息 + 建模假设构造的主体/时序，明确标注、不冒充实测
-- 任何一行数据都必须能回答"你属于哪一层、依据是什么"。
-- =====================================================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------------------------------
-- 1. real_facility  真实设施台账
--    一行 = 一个真实存在的排放设施（来自官方公开数据集）
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS real_facility (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  source_id     BIGINT       NOT NULL                COMMENT '数据源ID → data_source.id',
  country_iso   VARCHAR(3)   NOT NULL DEFAULT 'USA'  COMMENT 'ISO3 国家代码',
  external_id   VARCHAR(60)  NOT NULL                COMMENT '源系统唯一ID（EPA Facility Id）',
  name          VARCHAR(240) NOT NULL                COMMENT '设施名称（原文）',
  name_cn       VARCHAR(240)          DEFAULT NULL   COMMENT '中文名（如有）',
  -- 行业：同时保留平台分类与原始分类，避免"归类即失真"
  industry      VARCHAR(40)  NOT NULL                COMMENT '平台行业分类',
  sector_raw    VARCHAR(240)          DEFAULT NULL   COMMENT '源数据原始部门字符串（可能多值）',
  naics         VARCHAR(10)           DEFAULT NULL   COMMENT 'NAICS 行业码（真实）',
  -- 地理位置：真实经纬度，可直接上图
  admin1        VARCHAR(20)           DEFAULT NULL   COMMENT '一级行政区（州/省代码）',
  admin2        VARCHAR(80)           DEFAULT NULL   COMMENT '二级行政区（县）',
  city          VARCHAR(120)          DEFAULT NULL   COMMENT '城市',
  postal        VARCHAR(20)           DEFAULT NULL   COMMENT '邮编',
  latitude      DECIMAL(10,6)         DEFAULT NULL   COMMENT '纬度',
  longitude     DECIMAL(10,6)         DEFAULT NULL   COMMENT '经度',
  -- 溯源
  source_url    VARCHAR(400)          DEFAULT NULL   COMMENT '该设施的官方记录页',
  authenticity  VARCHAR(12)  NOT NULL DEFAULT 'REAL' COMMENT 'REAL/DERIVED/MODELED',
  first_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次入库时间',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近更新',
  PRIMARY KEY (id),
  UNIQUE KEY uk_rf_ext (source_id, external_id),
  KEY idx_rf_ind (industry),
  KEY idx_rf_geo (admin1, city),
  KEY idx_rf_auth (authenticity),
  -- 国家维度索引：真实设施现已来自两国（USA 5,352 / CHN 50,354）。
  -- 没有它，每次按国家筛选或计数都要全表扫 5.5 万行（实测 2.1 s）；
  -- 有覆盖索引后同查询降到毫秒级。这是"能用"与"好用"的分界。
  KEY idx_rf_country (country_iso, industry),
  KEY idx_rf_country_id (country_iso, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='真实设施台账（官方公开数据，非合成）';

-- -------------------------------------------------------------------------------------
-- 2. real_emission_year  真实设施年度排放
--    一行 = 一个设施某一年度的官方报告排放量
--    多年度并列即可得到真实同比，不需要任何拟合
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS real_emission_year (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  facility_id   BIGINT       NOT NULL                COMMENT '设施ID → real_facility.id',
  source_id     BIGINT       NOT NULL                COMMENT '数据源ID',
  year          INT          NOT NULL                COMMENT '数据年度',
  total_co2e    DECIMAL(20,3)         DEFAULT NULL   COMMENT '排放总量（CO2e，吨）',
  co2           DECIMAL(20,3)         DEFAULT NULL   COMMENT 'CO2（非生物质，吨）',
  ch4_co2e      DECIMAL(20,3)         DEFAULT NULL   COMMENT 'CH4 折算 CO2e（吨）',
  n2o_co2e      DECIMAL(20,3)         DEFAULT NULL   COMMENT 'N2O 折算 CO2e（吨）',
  biogenic_co2  DECIMAL(20,3)         DEFAULT NULL   COMMENT '生物质 CO2（单列，不计入总量）',
  unit          VARCHAR(16)  NOT NULL DEFAULT 'tCO2e' COMMENT '计量单位',
  -- 过程分解：EPA 按工艺段上报，这是"排放从哪来"的真实答案
  process_json  JSON                  DEFAULT NULL   COMMENT '工艺段分解 [{name,nameCn,emission}]',
  -- ⚡ 性能生成列（STORED）：/truth 的 cn_owner_coverage 曾对 30 万行逐行
  -- JSON_EXTRACT 实测 3.0 s（并发无效，单查询 CPU 密集）。写入时算一次，
  -- 查询侧改为 owners_len > 0，同语义（NULL/缺 owners → NULL → 不命中）。
  -- ⚠ 这是 MySQL 侧优化：migrate-to-d1 / schema-from-mysql 会跳过 GENERATED 列，
  --   D1/Worker 侧继续用 json_extract，不迁移此列。
  owners_len    INT GENERATED ALWAYS AS (JSON_LENGTH(JSON_EXTRACT(process_json, '$.owners'))) STORED
                         COMMENT '所有者数组长度（生成列，免逐行 JSON 解析）',
  source_url    VARCHAR(400)          DEFAULT NULL   COMMENT '原始数据文件或记录页',
  authenticity  VARCHAR(12)  NOT NULL DEFAULT 'REAL' COMMENT 'REAL/DERIVED/MODELED',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_rey (facility_id, year),
  KEY idx_rey_year (year),
  KEY idx_rey_total (total_co2e)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='真实设施年度排放（官方报告值）';

-- -------------------------------------------------------------------------------------
-- 3. real_series  真实宏观/市场时间序列（统一长表）
--    macro_indicator 已存在，但那条线是"国家级年度"，粒度不够。
--    这里放的是平台运行中产生的、带实时性要求的序列（如碳价、成交量）。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS real_series (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  source_id     BIGINT       NOT NULL                COMMENT '数据源ID',
  series_key    VARCHAR(60)  NOT NULL                COMMENT '序列标识 cneeex_price/cneeex_volume/...',
  series_cn     VARCHAR(80)           DEFAULT NULL   COMMENT '序列中文名',
  scope         VARCHAR(20)  NOT NULL DEFAULT 'MARKET' COMMENT 'MACRO/MARKET/ENTITY',
  entity_ref    VARCHAR(60)           DEFAULT NULL   COMMENT '主体引用（企业编码/设施ID）',
  ts            DATETIME     NOT NULL                COMMENT '数据时点（不是入库时点）',
  value         DECIMAL(24,6)         DEFAULT NULL   COMMENT '数值（NULL 表示该时点无数据，不填 0）',
  unit          VARCHAR(24)           DEFAULT NULL   COMMENT '单位',
  authenticity  VARCHAR(12)  NOT NULL DEFAULT 'REAL' COMMENT 'REAL/DERIVED/MODELED',
  raw_json      JSON                  DEFAULT NULL   COMMENT '原始行（保留以便复核）',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '入库时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_rs (source_id, series_key, entity_ref, ts),
  KEY idx_rs_key_ts (series_key, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='真实宏观/市场时间序列（统一长表）';

-- -------------------------------------------------------------------------------------
-- 4. live_rollup  实时指标归档
--    实时引擎每秒在内存里算，但每秒落库会把库撑爆。
--    所以：内存环形缓冲供前端读，落库按分钟聚合（只保留可复算的摘要）。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_rollup (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  bucket        DATETIME     NOT NULL                COMMENT '聚合桶（分钟对齐）',
  metric_key    VARCHAR(60)  NOT NULL                COMMENT '指标标识',
  metric_cn     VARCHAR(80)           DEFAULT NULL   COMMENT '指标中文名',
  value_avg     DECIMAL(24,6)         DEFAULT NULL   COMMENT '桶内均值',
  value_min     DECIMAL(24,6)         DEFAULT NULL   COMMENT '桶内最小值',
  value_max     DECIMAL(24,6)         DEFAULT NULL   COMMENT '桶内最大值',
  samples       INT          NOT NULL DEFAULT 0      COMMENT '桶内样本数（用于核验聚合完整性）',
  unit          VARCHAR(24)           DEFAULT NULL   COMMENT '单位',
  provenance    VARCHAR(12)  NOT NULL DEFAULT 'REAL' COMMENT 'REAL/DERIVED/MODELED',
  PRIMARY KEY (id),
  UNIQUE KEY uk_lr (bucket, metric_key),
  KEY idx_lr_key (metric_key, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='实时指标分钟聚合归档';

-- -------------------------------------------------------------------------------------
-- 5. truth_declaration  数据真实性声明（可自动核验，不是手写文案）
--    每条声明 = 「某个数字属于哪一层 + 依据 + 可复算方式」
--    /api/real/truth 会在运行时重新计算实际条数，与声明对照；
--    对不上就报 MISMATCH —— 声明不能比事实更乐观。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS truth_declaration (
  id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  decl_key      VARCHAR(60)  NOT NULL                COMMENT '声明标识',
  subject       VARCHAR(120) NOT NULL                COMMENT '被声明的对象（人类可读）',
  layer         VARCHAR(12)  NOT NULL                COMMENT 'REAL/DERIVED/MODELED',
  claim         VARCHAR(400) NOT NULL                COMMENT '声明内容',
  basis         VARCHAR(400)          DEFAULT NULL   COMMENT '依据（标准号/数据源/公式）',
  verify_sql    VARCHAR(600)          DEFAULT NULL   COMMENT '核验SQL（返回单个计数，须与 expected 相符）',
  expected      BIGINT                DEFAULT NULL   COMMENT '期望计数（NULL=不核验计数，仅文字声明）',
  tolerance     VARCHAR(20)  NOT NULL DEFAULT 'EXACT' COMMENT 'EXACT / AT_LEAST / AT_MOST',
  note          VARCHAR(500)          DEFAULT NULL   COMMENT '局限与不可主张之处',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_td (decl_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='数据真实性声明（运行时可核验）';
