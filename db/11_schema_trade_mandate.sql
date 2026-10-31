-- =====================================================================================
-- 11_schema_trade_mandate.sql —— 代理交易授权（P0 越权漏洞修复）
-- =====================================================================================
-- 为什么必须有这张表：
--   改造前 trade.js 的 traderEntId() 直接采信客户端传入的 entId，任何 TRADER 账号
--   可代理**任意企业**挂牌/撤单/清缴，企业毫不知情。这是可被直接利用的越权漏洞。
--
-- 授权链路的三个约束（缺一不可）：
--   ① 谁授权：ent_id（企业）+ granted_by（企业侧授权人）
--   ② 授给谁：trader_user_id（交易端账号）
--   ③ 授什么：scope（能否清缴）+ max_amount（额度上限）+ valid_from/to（期限）
-- 授权与撤销动作本身上链（chain_tx_id），使"企业确实授权过"成为不可否认的事实。
-- =====================================================================================

CREATE TABLE IF NOT EXISTS trade_mandate (
  id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
  ent_id          BIGINT       NOT NULL                COMMENT '授权方企业ID',
  trader_user_id  BIGINT       NOT NULL                COMMENT '受托方（交易端账号ID）',
  scope           VARCHAR(20)  NOT NULL DEFAULT 'TRADE_ONLY' COMMENT 'TRADE_ONLY 仅交易 / TRADE_AND_OFFSET 含清缴',
  max_amount      DECIMAL(18,3)         DEFAULT NULL   COMMENT '单笔额度上限(t)，NULL=不限',
  valid_from      DATETIME     NOT NULL                COMMENT '生效时间',
  valid_to        DATETIME     NOT NULL                COMMENT '失效时间',
  status          VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / REVOKED / EXPIRED',
  granted_by      BIGINT       NOT NULL                COMMENT '企业侧授权人 user_id',
  revoked_by      BIGINT                DEFAULT NULL   COMMENT '撤销人 user_id',
  revoked_at      DATETIME              DEFAULT NULL   COMMENT '撤销时间',
  revoke_reason   VARCHAR(200)          DEFAULT NULL   COMMENT '撤销原因',
  chain_tx_id     VARCHAR(80)           DEFAULT NULL   COMMENT '授权动作的链上交易ID',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_mandate (ent_id, trader_user_id, scope),
  KEY idx_mandate_trader (trader_user_id, status),
  KEY idx_mandate_ent (ent_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='代理交易授权（企业→交易机构的委托凭证）';

-- 订单增加业务类型：代理（AGENCY）与自营（PROPRIETARY）分开统计与风控
ALTER TABLE trade_order
  ADD COLUMN biz_type VARCHAR(20) NOT NULL DEFAULT 'AGENCY' COMMENT 'AGENCY 代理 / PROPRIETARY 自营',
  ADD COLUMN mandate_id BIGINT DEFAULT NULL COMMENT '代理订单对应的授权ID（自营为 NULL）',
  ADD COLUMN reviewed_by BIGINT DEFAULT NULL COMMENT '复核人 user_id（大额挂牌需双人复核）',
  ADD COLUMN reviewed_at DATETIME DEFAULT NULL COMMENT '复核时间';

-- 成交也带业务类型，便于分账与监管统计
ALTER TABLE trade_deal
  ADD COLUMN biz_type VARCHAR(20) NOT NULL DEFAULT 'AGENCY' COMMENT 'AGENCY 代理 / PROPRIETARY 自营';
