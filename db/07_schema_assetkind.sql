-- =====================================================================================
-- 07_schema_assetkind.sql —— 为 real_emission_year 增加 asset_kind 生成列
-- =====================================================================================
-- 【为什么需要它】
--
-- 全平台有 9 处查询要排除「聚合型资产」：
--
--   AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.process_json,'$.assetKind')),'FACILITY') <> 'AGGREGATE'
--
-- 这类条件**完全无法走索引** —— MySQL 必须对每一行解析一次 JSON 再判断。
-- 在 33.9 万行的 real_emission_year 上，单这一条就让 /facilities 慢了 2.4 秒、
-- /trend 慢了 4 秒（后者已通过物化表解决，但列表类查询没法物化）。
--
-- 【做法】
-- 加一个**持久化生成列** asset_kind，把 JSON 取值固化成普通列，并为它建索引。
-- 生成列由 MySQL 自动维护：写入/更新 process_json 时同步重算，不存在"忘记同步"的风险。
-- 这比在应用层多写一列更可靠 —— 应用层会漏，数据库不会。
--
-- 【口径完全不变】
--   COALESCE(..., 'FACILITY') 的默认值语义原样保留在生成列定义里，
--   因此 idx 查询与原来的表达式**逐行等价**。这一点由
--   `tools/agg-refresh.mjs --verify` 的分项比对持续守护。
-- =====================================================================================

SET NAMES utf8mb4;

-- 幂等：列已存在则跳过（MySQL 8 不支持 ADD COLUMN IF NOT EXISTS，用存储过程判断）
DROP PROCEDURE IF EXISTS _add_asset_kind;
DELIMITER $$
CREATE PROCEDURE _add_asset_kind()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'real_emission_year'
       AND COLUMN_NAME = 'asset_kind'
  ) THEN
    ALTER TABLE real_emission_year
      ADD COLUMN asset_kind VARCHAR(16)
        GENERATED ALWAYS AS (
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(process_json, '$.assetKind')), 'FACILITY')
        ) STORED
        COMMENT '资产类型生成列（FACILITY/AGGREGATE），由 process_json 自动派生';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'real_emission_year'
       AND INDEX_NAME = 'idx_rey_asset'
  ) THEN
    ALTER TABLE real_emission_year ADD INDEX idx_rey_asset (asset_kind, year);
  END IF;
END$$
DELIMITER ;

CALL _add_asset_kind();
DROP PROCEDURE IF EXISTS _add_asset_kind;
