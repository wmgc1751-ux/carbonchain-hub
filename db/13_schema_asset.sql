-- =====================================================================================
-- 13_schema_asset.sql —— 交易品种与主体类型抽象（P2 可扩展性）
-- =====================================================================================
-- 为什么需要：
--   现有 trade.js 全程硬编码 carbon_quota（表名与 available/frozen/bought/sold 写死在 SQL 里）。
--   接入 CCER 自愿减排量、绿证时，要么复制一套交易逻辑，要么大改。
--
-- 本文件做三件不破坏现有功能的事：
--   ① 建统一资产账户表 asset_account（carbon_quota 作为 CEA 品种的兼容视图保留）
--   ② 给 trade_order / trade_deal 加资产维度（asset_kind / asset_ref / party_type）
--   ③ 建品种注册表 asset_kind_dict，新增品种只需插一行，不改交易代码
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- ① 品种字典：新增交易品种只需在此登记
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_kind_dict (
  kind          VARCHAR(24) NOT NULL COMMENT '品种代码：CEA 配额 / CCER 自愿减排量 / GEC 绿证 / FOREST 碳汇',
  label         VARCHAR(40) NOT NULL COMMENT '中文名称',
  unit          VARCHAR(16) NOT NULL DEFAULT 'tCO2e' COMMENT '计量单位',
  need_vintage  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否需要项目年份（CCER/GEC 需要）',
  need_project  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否需要项目编号',
  allow_offset  TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否可用于履约抵销',
  offset_ratio  DECIMAL(6,4) DEFAULT NULL COMMENT '抵销比例上限（如 CCER 为 0.05 即 5%）',
  seller_types  VARCHAR(120) NOT NULL DEFAULT 'EMITTER' COMMENT '允许的卖方主体类型（逗号分隔）',
  buyer_types   VARCHAR(120) NOT NULL DEFAULT 'EMITTER' COMMENT '允许的买方主体类型',
  active        TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='交易品种字典';

INSERT INTO asset_kind_dict (kind, label, unit, need_vintage, need_project, allow_offset, offset_ratio, seller_types, buyer_types) VALUES
  ('CEA',    '碳排放配额',       'tCO2e', 0, 0, 1, NULL,  'EMITTER',                    'EMITTER,TRADER'),
  ('CCER',   '国家核证自愿减排量', 'tCO2e', 1, 1, 1, 0.0500,'PROJECT_OWNER,EMITTER',      'EMITTER,INVESTOR,TRADER'),
  ('GEC',    '绿色电力证书',     'MWh',   1, 0, 0, NULL,  'PROJECT_OWNER,EMITTER',      'EMITTER,INVESTOR'),
  ('FOREST', '林业碳汇',         'tCO2e', 1, 1, 1, 0.0300,'PROJECT_OWNER',              'EMITTER,INVESTOR')
ON DUPLICATE KEY UPDATE label = VALUES(label), allow_offset = VALUES(allow_offset);

-- ---------------------------------------------------------------------------
-- ② 统一资产账户（多品种、多 vintage、多项目）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_account (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  ent_id      BIGINT       NOT NULL COMMENT '持有主体',
  asset_kind  VARCHAR(24)  NOT NULL DEFAULT 'CEA' COMMENT '品种',
  vintage     INT                   DEFAULT NULL COMMENT '项目年份（CCER/GEC）',
  project_id  VARCHAR(64)           DEFAULT NULL COMMENT '项目编号（CCER/碳汇）',
  available   DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT '可用',
  frozen      DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT '冻结（挂单中）',
  total_in    DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT '累计转入',
  total_out   DECIMAL(18,3) NOT NULL DEFAULT 0 COMMENT '累计转出',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_asset_acc (ent_id, asset_kind, vintage, project_id),
  KEY idx_asset_kind (asset_kind, vintage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='统一资产账户（配额/CCER/绿证/碳汇）';

-- ---------------------------------------------------------------------------
-- ③ 订单/成交的资产维度与主体类型
-- ---------------------------------------------------------------------------
ALTER TABLE trade_order
  ADD COLUMN asset_kind VARCHAR(24) NOT NULL DEFAULT 'CEA' COMMENT '交易品种',
  ADD COLUMN asset_ref  VARCHAR(64) DEFAULT NULL COMMENT '品种附加标识（vintage 或 projectId）',
  ADD COLUMN party_type VARCHAR(24) NOT NULL DEFAULT 'EMITTER' COMMENT '交易主体类型：EMITTER/PROJECT_OWNER/INVESTOR/TRADER';

ALTER TABLE trade_deal
  ADD COLUMN asset_kind VARCHAR(24) NOT NULL DEFAULT 'CEA' COMMENT '交易品种',
  ADD COLUMN asset_ref  VARCHAR(64) DEFAULT NULL COMMENT '品种附加标识';

-- ---------------------------------------------------------------------------
-- ④ 兼容视图：现有代码查 carbon_quota 时不改，但 CEA 品种统一走 asset_account 后可逐步迁移
--    这里先建"配额视图"映射到统一账户，便于两套并存期间对账。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_quota_from_asset AS
SELECT ent_id,
       YEAR(COALESCE(created_at, NOW())) AS year,
       asset_kind,
       SUM(available) AS available,
       SUM(frozen)    AS frozen,
       SUM(total_in)  AS total_in,
       SUM(total_out) AS total_out
  FROM asset_account
 WHERE asset_kind = 'CEA'
 GROUP BY ent_id, YEAR(COALESCE(created_at, NOW())), asset_kind;
