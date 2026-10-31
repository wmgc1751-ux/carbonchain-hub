-- =====================================================================================
-- 14_schema_disclosure.sql —— 公众公示专区与授权范围（P2）
-- =====================================================================================
-- 为什么需要这张表：
--   公示核查结论与履约情况是碳信息公开的要求，但企业授权书通常只写
--   "研究、开发、数据接入演示、碳排放核算与学术竞赛"，**未包含对外公示**。
--   未获授权就公示会超出授权范围——这比功能缺失更严重。
--
-- 因此设计为「企业逐项授权 + 未授权默认不公示」：
--   · disclosure_consent 记录企业对每个公示项的授权状态（默认 NONE）
--   · 公示接口只返回 consent_status='GRANTED' 的数据
--   · 撤销授权立即生效（不缓存）
-- =====================================================================================

CREATE TABLE IF NOT EXISTS disclosure_consent (
  id            BIGINT      NOT NULL AUTO_INCREMENT,
  ent_id        BIGINT      NOT NULL COMMENT '企业ID',
  item          VARCHAR(32) NOT NULL COMMENT '公示项：VERIFY_RESULT 核查结论 / COMPLIANCE 履约清缴 / EMISSION_RANK 排放排名',
  consent_status VARCHAR(16) NOT NULL DEFAULT 'NONE' COMMENT 'GRANTED 已授权 / NONE 未授权 / REVOKED 已撤回',
  mask_level    VARCHAR(16) NOT NULL DEFAULT 'SUMMARY' COMMENT '脱敏级别：SUMMARY 仅结论 / DETAIL 含数值',
  granted_by    BIGINT               DEFAULT NULL COMMENT '企业授权人',
  granted_at    DATETIME             DEFAULT NULL,
  revoked_at    DATETIME             DEFAULT NULL,
  note          VARCHAR(200)         DEFAULT NULL COMMENT '授权范围备注（如授权书条款号）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_consent (ent_id, item),
  KEY idx_consent_status (item, consent_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公示授权（未授权默认不公示）';

-- 公示项字典：让企业知道每一项具体公示什么，避免笼统授权
CREATE TABLE IF NOT EXISTS disclosure_item_dict (
  item        VARCHAR(32) NOT NULL,
  label       VARCHAR(60) NOT NULL,
  detail      VARCHAR(300) NOT NULL COMMENT '具体公示内容说明（企业据此判断是否授权）',
  PRIMARY KEY (item)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公示项说明字典';

INSERT INTO disclosure_item_dict (item, label, detail) VALUES
  ('VERIFY_RESULT', '核查结论公示', '公示：企业名称、报告期、核查结论（通过/不通过/有条件通过）、核查机构名称、核查日期。不公示：核查底稿、具体排放数值细节、企业内部工艺数据。'),
  ('COMPLIANCE',    '履约清缴公示', '公示：企业名称、年度、是否按期足额清缴、清缴比例。不公示：具体金额、交易价格、企业内部资金安排。'),
  ('EMISSION_RANK', '排放排名公示', '公示：企业在所属行业中的分档（A/B/C 三档）。不公示：精确排放量、排名位次。')
ON DUPLICATE KEY UPDATE label = VALUES(label), detail = VALUES(detail);
