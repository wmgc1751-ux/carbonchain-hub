-- =====================================================================================
-- 06_schema_agg.sql —— 真实数据层的预聚合物化表
-- =====================================================================================
-- 【为什么需要它】
--
-- `/api/real/overview` 原来每次冷启动都要对 33.9 万行 real_emission_year 做全表聚合，
-- 实测 5.5 秒（2026-10-26 压测）。这不是"数据量大"的问题 —— 34 万行用对索引应当是毫秒级。
-- 真正的开销来自一遍遍重复的全表扫描：
--
--   · SUM(total_co2e) 覆盖全部 15 年 × 5.5 万家设施 —— 无索引可走，必然全扫；
--   · byIndustry / byState 各扫一遍 4.7 万行（某一年的）；
--   · 每次冷启动都重来，内存缓存（30s TTL）帮不上第一次。
--
-- 这些数字的性质是"**历史数据，年度更新**"：2024 年的排放合计今天算和明天算完全一样。
-- 对一个不变的事实反复做全表聚合，是纯粹的浪费。
--
-- 【做法】
-- 把聚合结果物化成表，运行时直接读。物化不是"抄一份假数据"——每条都带 refresh 时间与
-- 源行数，可与源表对照核验（`tools/agg-refresh.mjs --verify`）。
--
-- 【重要边界】
--   · 物化表**只存放源表能算出来的聚合值**，不引入任何新口径；
--   · 源表变更后必须重跑 refresh；`--verify` 会逐项重算并比对，不一致即失败；
--   · 当前年（2026）是"年初至今"，与完整年度不可比 —— 该判据仍在代码里，不因物化而消失。
-- =====================================================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------------------------------
-- 1. agg_emission_total  排放总量与年度覆盖（替代全表 SUM/COUNT）
--    一行 = 一个 (国家, 年度) 组合；country_iso 为空串表示"全部国家"
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agg_emission_total (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  country_iso   VARCHAR(3)   NOT NULL DEFAULT ''     COMMENT '国家（空串=全部）',
  year          INT          NOT NULL                COMMENT '年度',
  facility_rows INT          NOT NULL DEFAULT 0      COMMENT '该年设施-年度记录数',
  facilities    INT          NOT NULL DEFAULT 0      COMMENT '该年不同设施数',
  total_co2e    DECIMAL(28,4) NOT NULL DEFAULT 0     COMMENT '该年排放合计（tCO2e，含聚合型资产）',
  aggregate_rows INT         NOT NULL DEFAULT 0      COMMENT '其中聚合型资产（assetKind=AGGREGATE）行数',
  /* 气体分项与"排除聚合资产"口径 —— /trend 需要这两组数。
   * 之所以在这里一并物化：它们与总量出自同一次全表扫描，
   * 分开算就等于把 4 秒的扫描做三遍。 */
  co2_excl_agg   DECIMAL(28,4) NOT NULL DEFAULT 0    COMMENT 'CO2 合计（排除聚合型资产，t）',
  ch4_excl_agg   DECIMAL(28,4) NOT NULL DEFAULT 0    COMMENT 'CH4 折 CO2e 合计（排除聚合型资产）',
  n2o_excl_agg   DECIMAL(28,4) NOT NULL DEFAULT 0    COMMENT 'N2O 折 CO2e 合计（排除聚合型资产）',
  total_excl_agg DECIMAL(28,4) NOT NULL DEFAULT 0    COMMENT '排放合计（排除聚合型资产）',
  refreshed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '物化时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_aet (country_iso, year),
  KEY idx_aet_year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='排放总量按年物化（可核验）';

-- -------------------------------------------------------------------------------------
-- 2. agg_industry_year  行业 × 年度
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agg_industry_year (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  country_iso   VARCHAR(3)   NOT NULL DEFAULT '',
  year          INT          NOT NULL,
  industry      VARCHAR(40)  NOT NULL,
  facilities    INT          NOT NULL DEFAULT 0      COMMENT '该行业该年不同设施数',
  total_co2e    DECIMAL(28,4) NOT NULL DEFAULT 0,
  refreshed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_aiy (country_iso, year, industry),
  KEY idx_aiy_lookup (year, country_iso)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行业排放按年物化（可核验）';

-- -------------------------------------------------------------------------------------
-- 3. agg_region_year  区域 × 年度
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agg_region_year (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  country_iso   VARCHAR(3)   NOT NULL DEFAULT '',
  year          INT          NOT NULL,
  region_code   VARCHAR(20)           DEFAULT NULL   COMMENT 'admin1（区域电网 code / 州）',
  facilities    INT          NOT NULL DEFAULT 0,
  total_co2e    DECIMAL(28,4) NOT NULL DEFAULT 0,
  refreshed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ary (country_iso, year, region_code),
  KEY idx_ary_lookup (year, country_iso)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='区域排放按年物化（可核验）';

-- -------------------------------------------------------------------------------------
-- 4. agg_meta  物化元信息（用于"物化是否可信"的运行时判定）
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agg_meta (
  k             VARCHAR(60)  NOT NULL,
  v             VARCHAR(200) NOT NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='物化表元信息';

-- -------------------------------------------------------------------------------------
-- 5. agg_industry_stats  行业分布统计（含分位数）
--    /benchmarks 原来对每个行业各做 3 次 LIMIT/OFFSET 大表扫描（8 行业 × 3 = 24 次），
--    实测 3.2s。中位数/P90/Top10 集中度对同一份历史数据是常量，
--    没有任何理由每次请求重算一遍。物化后降到毫秒级。
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agg_industry_stats (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  country_iso   VARCHAR(3)   NOT NULL DEFAULT '',
  year          INT          NOT NULL,
  industry      VARCHAR(40)  NOT NULL,
  facilities    INT          NOT NULL DEFAULT 0,
  total_co2e    DECIMAL(28,4) NOT NULL DEFAULT 0,
  mean_co2e     DECIMAL(28,4) NOT NULL DEFAULT 0,
  min_co2e      DECIMAL(28,4) NOT NULL DEFAULT 0,
  max_co2e      DECIMAL(28,4) NOT NULL DEFAULT 0,
  p50_co2e      DECIMAL(28,4)         DEFAULT NULL,
  p90_co2e      DECIMAL(28,4)         DEFAULT NULL,
  top10_co2e    DECIMAL(28,4) NOT NULL DEFAULT 0    COMMENT '前 10% 设施合计',
  top10_count   INT          NOT NULL DEFAULT 0,
  refreshed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ais (country_iso, year, industry),
  KEY idx_ais_lookup (year, country_iso)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行业分布统计（含分位数，可核验）';
