-- =====================================================================================
-- 12_schema_integrity.sql —— 内控与合规（P1）
-- =====================================================================================
-- 解决四个问题：
--   ① 每机构单账号、无岗位、无复核（sys_user.post + 复核字段）
--   ② 核查与交易利益冲突无系统阻断（org_qualification + 互斥校验）
--   ③ 关键动作一人可定成败（核查结论/清缴/大额挂牌 双人复核）
--   ④ 审计日志可被 DBA 篡改（批次摘要上链）
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- ① 岗位分级：同一机构可建多个子账号，按岗位分权
-- ---------------------------------------------------------------------------
ALTER TABLE sys_user
  ADD COLUMN post VARCHAR(24) DEFAULT NULL COMMENT '岗位：ENT_CLERK 排放填报 / QUOTA_MANAGER 履约管理 / ENT_ADMIN 企业管理员；VER_CLERK 核查录入 / VER_REVIEWER 核查审核 / ORG_ADMIN 机构管理员；REG_CLERK 监管经办 / REG_REVIEWER 监管复核',
  ADD COLUMN parent_user_id BIGINT DEFAULT NULL COMMENT '子账号归属的主账号（机构管理员）',
  ADD COLUMN cert_no VARCHAR(64) DEFAULT NULL COMMENT '执业证书/资质编号（核查员等专业岗位必填）';

CREATE INDEX idx_user_org_post ON sys_user (org_id, post);

-- 岗位字典（便于前端下拉与后端校验共用一份定义）
CREATE TABLE IF NOT EXISTS user_post_dict (
  post        VARCHAR(24) NOT NULL COMMENT '岗位代码',
  role_scope  VARCHAR(24) NOT NULL COMMENT '所属角色（ENTERPRISE/VERIFIER/REGULATOR）',
  label       VARCHAR(40) NOT NULL COMMENT '中文名称',
  can_entry   TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可否录入',
  can_review  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可否审核/批准',
  can_admin   TINYINT(1) NOT NULL DEFAULT 0 COMMENT '可否管理子账号',
  PRIMARY KEY (post)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='岗位字典（职责分离定义）';

INSERT INTO user_post_dict (post, role_scope, label, can_entry, can_review, can_admin) VALUES
  ('ENT_CLERK',       'ENTERPRISE', '排放填报员',   1, 0, 0),
  ('QUOTA_MANAGER',   'ENTERPRISE', '履约管理员',   0, 1, 0),
  ('ENT_ADMIN',       'ENTERPRISE', '企业管理员',   0, 0, 1),
  ('VER_CLERK',       'VERIFIER',   '核查录入员',   1, 0, 0),
  ('VER_REVIEWER',    'VERIFIER',   '核查审核员',   0, 1, 0),
  ('ORG_ADMIN',       'VERIFIER',   '机构管理员',   0, 0, 1),
  ('REG_CLERK',       'REGULATOR',  '监管经办人',   1, 0, 0),
  ('REG_REVIEWER',    'REGULATOR',  '监管复核人',   0, 1, 0)
ON DUPLICATE KEY UPDATE label = VALUES(label);

-- ---------------------------------------------------------------------------
-- ② 资质互斥：核查机构不得同时做交易代理（利益冲突的硬阻断）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_qualification (
  id          BIGINT      NOT NULL AUTO_INCREMENT COMMENT '主键',
  org_key     VARCHAR(64) NOT NULL COMMENT '机构标识（统一社会信用代码或 org_name 规范化）',
  org_name    VARCHAR(120) NOT NULL COMMENT '机构名称',
  qual_type   VARCHAR(24) NOT NULL COMMENT 'VERIFIER 核查资质 / TRADER 交易代理 / SELF_TRADE 自营交易',
  status      VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / REVOKED',
  granted_by  BIGINT               DEFAULT NULL COMMENT '授予人 user_id',
  granted_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at  DATETIME             DEFAULT NULL,
  evidence    VARCHAR(300)         DEFAULT NULL COMMENT '资质证明（证书号/文件号）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_qual (org_key, qual_type),
  KEY idx_qual_type (qual_type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='机构资质（含互斥校验：核查与交易不得同体）';

-- 互斥规则表（规则可配置，避免硬编码在代码里）
CREATE TABLE IF NOT EXISTS qual_conflict_rule (
  id          BIGINT      NOT NULL AUTO_INCREMENT,
  qual_a      VARCHAR(24) NOT NULL COMMENT '资质A',
  qual_b      VARCHAR(24) NOT NULL COMMENT '资质B（与A互斥）',
  reason      VARCHAR(200) NOT NULL COMMENT '互斥理由（写进错误提示，让人知道为什么被拒）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_rule (qual_a, qual_b)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='资质互斥规则';

INSERT INTO qual_conflict_rule (qual_a, qual_b, reason) VALUES
  ('VERIFIER', 'TRADER',     '核查机构同时代理被核查企业的交易构成利益冲突（《碳排放权交易管理暂行条例》要求核查独立性）'),
  ('TRADER',   'VERIFIER',   '核查机构同时代理被核查企业的交易构成利益冲突（《碳排放权交易管理暂行条例》要求核查独立性）'),
  ('VERIFIER', 'SELF_TRADE', '核查机构自营碳资产交易将丧失独立性')
ON DUPLICATE KEY UPDATE reason = VALUES(reason);

-- ---------------------------------------------------------------------------
-- ③ 双人复核：关键动作留"经办 + 复核"两个签字位
-- ---------------------------------------------------------------------------
ALTER TABLE verify_report
  ADD COLUMN submitted_by BIGINT DEFAULT NULL COMMENT '结论提交人（经办）',
  ADD COLUMN approved_by  BIGINT DEFAULT NULL COMMENT '结论批准人（复核，不得与提交人相同）',
  ADD COLUMN approved_at  DATETIME DEFAULT NULL COMMENT '批准时间';

ALTER TABLE quota_surrender
  ADD COLUMN initiated_by BIGINT DEFAULT NULL COMMENT '清缴发起人',
  ADD COLUMN confirmed_by BIGINT DEFAULT NULL COMMENT '清缴确认人（不得与发起人相同）',
  ADD COLUMN confirmed_at DATETIME DEFAULT NULL COMMENT '确认时间';

ALTER TABLE quota_allocation
  ADD COLUMN proposed_by BIGINT DEFAULT NULL COMMENT '分配方案拟定人',
  ADD COLUMN approved_by BIGINT DEFAULT NULL COMMENT '分配方案批准人（不得与拟定人相同）';

-- ---------------------------------------------------------------------------
-- ④ 审计日志批次摘要上链（日志本身防篡改）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_anchor (
  id           BIGINT      NOT NULL AUTO_INCREMENT,
  from_id      BIGINT      NOT NULL COMMENT '起始 audit_log.id',
  to_id        BIGINT      NOT NULL COMMENT '结束 audit_log.id',
  row_count    INT         NOT NULL COMMENT '本批条数',
  merkle_root  VARCHAR(64) NOT NULL COMMENT '本批日志的 Merkle 根',
  chain_tx_id  VARCHAR(80)          DEFAULT NULL COMMENT '上链交易ID',
  block_index  BIGINT               DEFAULT NULL COMMENT '区块高度',
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_anchor_range (from_id, to_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计日志批次锚点（每 N 条算一次 Merkle 根并上链）';
