-- ============================================================================
-- 15_schema_derivation.sql —— 派生业务数据血缘（仅 CEMS 输入场景）
--
-- 背景：企业侧只提供 CEMS 实测数据（cems_cn_hourly），其余业务数据由平台派生。
--       派生不等于编造：每一条派生记录必须能反向指认它用到的真实输入、
--       所用规则、以及规则本身的置信边界。没有血缘的派生数据一律不允许入库。
--
-- 三层口径（沿用 routes/real.js 已有的 REAL / DERIVED / MODELED 约定）：
--   REAL     —— 观测值本身，直接来自监测系统/官方统计，平台未做任何换算
--   DERIVED  —— 同一口径的换算（如 kg → t），可逆、无假设
--   MODELED  —— 引入了分配假设（如"按烟气量占比把年度值拆到季度"），
--               必须写明假设，且不能被当作实测值对外主张
--
-- 硬约束：本表存在的意义是让"派生"和"编造"在数据库层面可区分。
--         derivation_log 里 source_kind='NONE' 的记录不允许出现（见 CHECK）。
-- ============================================================================

CREATE TABLE IF NOT EXISTS derivation_log (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  /* 被派生的对象：目标表 + 目标主键 */
  target_table    VARCHAR(40)  NOT NULL,
  target_id       BIGINT       NOT NULL,
  /* 派生结果摘要，便于不 JOIN 也能看懂一行 */
  target_label    VARCHAR(200) DEFAULT NULL,

  /* ---- 输入侧 ---- */
  /* 真实输入的种类。NONE 被禁：不允许无输入的派生 */
  source_kind     VARCHAR(24)  NOT NULL COMMENT 'CEMS_HOURLY / OFFICIAL_ACTIVITY / OFFICIAL_STAT / CEMS_BATCH / DERIVATION',
  source_ref      VARCHAR(200) NOT NULL COMMENT '批次号 / 表.主键 / 官方文件名 —— 必须可定位到具体行',
  source_detail   JSON         DEFAULT NULL COMMENT '参与计算的原始数值快照，便于日后复算',

  /* ---- 规则侧 ---- */
  rule_code       VARCHAR(60)  NOT NULL COMMENT '规则标识，如 CEMS_Q_SHARE / OFFICIAL_MSW_X_FACTOR',
  rule_expr       VARCHAR(400) NOT NULL COMMENT '人可读的算式，如 "年度CO2 x 当季烟气量/全年烟气量"',
  layer           VARCHAR(12)  NOT NULL DEFAULT 'DERIVED' COMMENT 'REAL / DERIVED / MODELED',
  confidence      VARCHAR(12)  NOT NULL DEFAULT 'HIGH' COMMENT 'HIGH=可逆换算 / MEDIUM=含分配假设 / LOW=含外推',

  /* ---- 边界声明 ---- */
  /* 这条派生"不能证明什么"。院审批评过的正是把派生值当实测值主张。 */
  limitation      VARCHAR(400) DEFAULT NULL,
  /* 复核要求：核查机构应当验算什么 */
  review_hint     VARCHAR(300) DEFAULT NULL,

  chain_tx_id     VARCHAR(80)  DEFAULT NULL,
  created_by      VARCHAR(40)  DEFAULT 'platform-derivation',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uk_target (target_table, target_id, rule_code),
  KEY idx_source (source_kind, source_ref),
  KEY idx_layer (layer, confidence),
  CONSTRAINT chk_source_kind CHECK (source_kind <> 'NONE'),
  CONSTRAINT chk_layer CHECK (layer IN ('REAL','DERIVED','MODELED')),
  CONSTRAINT chk_conf CHECK (confidence IN ('HIGH','MEDIUM','LOW'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='派生业务数据血缘台账：每条派生记录必须能指认真实输入与所用规则';

-- ---------------------------------------------------------------------------
-- 企业 CEMS 口径登记：同一家企业可能存在多个排口，官方活动水平是全厂口径。
-- 若 CEMS 只覆盖部分排口，必须在 coverage_ratio 里如实写，不许把单排口数据
-- 当成全厂排放量。NULL 表示"覆盖比例未知"，而不是 100%。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cems_coverage (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  ent_id            BIGINT       NOT NULL,
  year              INT          NOT NULL,
  outlet_name       VARCHAR(120) NOT NULL,
  /* 实测有效小时数 / 应有时长 */
  valid_hours       INT          NOT NULL DEFAULT 0,
  expected_hours    INT          NOT NULL DEFAULT 0,
  /* 实测烟气量（万m³） */
  flue_gas_10k_m3   DECIMAL(18,2) DEFAULT NULL,
  /* 可比对的官方处理量（万吨），仅企业级口径可取到 */
  official_msw_10kt DECIMAL(14,4)  DEFAULT NULL,
  /* 每吨垃圾烟气量（m³/t），用于判断 CEMS 是否覆盖全厂 */
  gas_per_ton_m3    DECIMAL(12,2) DEFAULT NULL,
  /* 行业典型区间下限/上限（m³/t），用于给出覆盖判定 */
  typical_min       DECIMAL(12,2) DEFAULT NULL,
  typical_max       DECIMAL(12,2) DEFAULT NULL,
  /* CEMS 相对全厂的覆盖比例估计；NULL = 未知，不假设 */
  coverage_ratio    DECIMAL(8,4)  DEFAULT NULL,
  coverage_basis    VARCHAR(200)  DEFAULT NULL COMMENT '判定依据，如"gas_per_ton 仅为典型值 1/3，判为单排口"',
  note              VARCHAR(400)  DEFAULT NULL,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ent_year_outlet (ent_id, year, outlet_name),
  KEY idx_ent_year (ent_id, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='CEMS 数据覆盖口径登记：单排口 ≠ 全厂，覆盖比例未知时写 NULL';
