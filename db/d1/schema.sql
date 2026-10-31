-- =====================================================================================
-- 碳链通平台 · D1 (SQLite) Schema —— 由 tools/schema-from-mysql.mjs 从 MySQL 实际结构生成
-- =====================================================================================
-- ⚠ 本文件是**生成产物**，不要手改。重新生成：
--     node tools/schema-from-mysql.mjs
--
-- 【为什么以 MySQL 元数据为准，而不解析 DDL 文本】
-- 早期版本解析 db/*.sql 的 DDL。它漏了两张表共 12 个列 —— 因为这些列是
-- 迁移期用 ALTER TABLE 追加的，从未回写到 DDL 文件。
-- 偏差不会在生成时报错，只在 INSERT 时暴露为
--   table enterprise has no column named data_source_id
-- 而那时已经写坏了几批数据。
--
-- information_schema 是运行时真相，不可能漏列、不可能过时。
-- 因此两边结构必然一致 —— 结构正确性优先于注释美观。
--
-- 【精度声明】
-- DECIMAL(p,s) → REAL（IEEE754 双精度，15~17 位有效数字）。
-- 对 DECIMAL(18,3) 的典型值足够，但**不要用 SQL 累加后比较相等**：
-- 累加顺序不同会有末位差异。聚合请用预聚合表并统一 toFixed 还原。
--
-- 【类型映射】
-- 整数族 → INTEGER（SQLite 只有 64 位整数）
-- DECIMAL/FLOAT/DOUBLE → REAL
-- VARCHAR/CHAR/ENUM/SET/JSON → TEXT（ENUM 值域靠应用层校验）
-- BLOB 族 → BLOB
-- DATE/DATETIME/TIMESTAMP → TEXT（ISO8601，避免时区漂移）
-- =====================================================================================

PRAGMA foreign_keys = OFF;


-- =====================================================================
-- 账本库（carbon_chain_ledger，链上 5 表实体结构）
-- =====================================================================


-- chain_block [ledger] —— 联盟链区块表（16 列）
CREATE TABLE IF NOT EXISTS "chain_block" (
  "id" INTEGER PRIMARY KEY,
  "block_index" INTEGER NOT NULL,
  "block_hash" TEXT NOT NULL,
  "prev_hash" TEXT NOT NULL,
  "merkle_root" TEXT NOT NULL,
  "nonce" INTEGER DEFAULT 0 NOT NULL,
  "difficulty" INTEGER DEFAULT 0 NOT NULL,
  "consensus" TEXT NOT NULL,
  "proposer" TEXT,
  "proposer_sig" TEXT,
  "tx_count" INTEGER DEFAULT 0 NOT NULL,
  "miner" TEXT,
  "size_bytes" INTEGER DEFAULT 0 NOT NULL,
  "mine_time" INTEGER DEFAULT 0 NOT NULL,
  "block_time" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_block_hash" ON "chain_block" ("block_hash");
CREATE INDEX IF NOT EXISTS "idx_block_proposer" ON "chain_block" ("proposer");
CREATE INDEX IF NOT EXISTS "idx_block_time" ON "chain_block" ("block_time");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_block_index" ON "chain_block" ("block_index");

-- chain_node [ledger] —— 联盟链成员节点表（18 列）
CREATE TABLE IF NOT EXISTS "chain_node" (
  "id" INTEGER PRIMARY KEY,
  "node_id" TEXT NOT NULL,
  "node_name" TEXT NOT NULL,
  "org_type" TEXT NOT NULL,
  "org_name" TEXT,
  "wallet_address" TEXT,
  "public_key" TEXT,
  "status" TEXT NOT NULL,
  "is_authorized" INTEGER DEFAULT 0 NOT NULL,
  "vote_weight" INTEGER DEFAULT 1 NOT NULL,
  "last_propose_at" TEXT,
  "proposed_blocks" INTEGER DEFAULT 0 NOT NULL,
  "replica_height" INTEGER DEFAULT -1 NOT NULL,
  "replica_tip" TEXT,
  "applied_at" TEXT,
  "approved_at" TEXT,
  "remark" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_node_status" ON "chain_node" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_node_id" ON "chain_node" ("node_id");

-- chain_node_replica [ledger] —— 联盟节点链副本表（5 列）
CREATE TABLE IF NOT EXISTS "chain_node_replica" (
  "id" INTEGER PRIMARY KEY,
  "node_id" TEXT NOT NULL,
  "block_index" INTEGER NOT NULL,
  "block_hash" TEXT NOT NULL,
  "synced_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_replica_node" ON "chain_node_replica" ("node_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_replica_node_block" ON "chain_node_replica" ("node_id", "block_index");

-- chain_payload_backup [ledger] —— 链下明细篡改演示原文备份（3 列）
CREATE TABLE IF NOT EXISTS "chain_payload_backup" (
  "tx_id" TEXT NOT NULL,
  "payload_json" TEXT,
  "backed_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- chain_tx [ledger] —— 链上存证交易表（18 列）
CREATE TABLE IF NOT EXISTS "chain_tx" (
  "id" INTEGER PRIMARY KEY,
  "tx_id" TEXT NOT NULL,
  "tx_type" TEXT NOT NULL,
  "biz_no" TEXT,
  "block_index" INTEGER,
  "from_address" TEXT,
  "to_address" TEXT,
  "payload_hash" TEXT NOT NULL,
  "payload_json" TEXT,
  "signature" TEXT,
  "pub_key" TEXT,
  "nonce" INTEGER DEFAULT 0 NOT NULL,
  "gas_fee" REAL DEFAULT 0.0000 NOT NULL,
  "status" TEXT NOT NULL,
  "anchor_batch_no" TEXT,
  "anchor_status" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "confirmed_at" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_tx_anchor" ON "chain_tx" ("anchor_status", "block_index");
CREATE INDEX IF NOT EXISTS "idx_tx_batch" ON "chain_tx" ("anchor_batch_no");
CREATE INDEX IF NOT EXISTS "idx_tx_block" ON "chain_tx" ("block_index");
CREATE INDEX IF NOT EXISTS "idx_tx_status" ON "chain_tx" ("status");
CREATE INDEX IF NOT EXISTS "idx_tx_type" ON "chain_tx" ("tx_type");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_tx_id" ON "chain_tx" ("tx_id");

-- =====================================================================
-- 业务库（carbon_chain）
-- =====================================================================


-- activity_data —— 企业活动数据台账（核算链唯一输入）（24 列）
CREATE TABLE IF NOT EXISTS "activity_data" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "source_code" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "quantity" REAL DEFAULT 0.0000 NOT NULL,
  "unit" TEXT NOT NULL,
  "data_origin" TEXT NOT NULL,
  "meter_no" TEXT,
  "meter_calibrated_until" TEXT,
  "voucher_no" TEXT,
  "measured_ncv" REAL,
  "measured_cc" REAL,
  "measured_of" REAL,
  "lab_report_no" TEXT,
  "submitted_by" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TEXT,
  "status" TEXT NOT NULL,
  "reject_reason" TEXT,
  "remark" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_activity_origin" ON "activity_data" ("data_origin");
CREATE INDEX IF NOT EXISTS "idx_activity_status" ON "activity_data" ("status");
CREATE INDEX IF NOT EXISTS "idx_activity_ym" ON "activity_data" ("year", "month");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_activity" ON "activity_data" ("ent_id", "year", "month", "source_code");

-- alert_record —— 监管预警记录表（13 列）
CREATE TABLE IF NOT EXISTS "alert_record" (
  "id" INTEGER PRIMARY KEY,
  "alert_no" TEXT NOT NULL,
  "ent_id" INTEGER,
  "alert_type" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT,
  "metric" TEXT,
  "status" TEXT NOT NULL,
  "handler" TEXT,
  "handle_note" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "closed_at" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_alert_ent" ON "alert_record" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_alert_level" ON "alert_record" ("level");
CREATE INDEX IF NOT EXISTS "idx_alert_status" ON "alert_record" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_alert_no" ON "alert_record" ("alert_no");

-- anchor_batch —— 批量锚定批次表（N 笔存证 → 1 个锚点）（10 列）
CREATE TABLE IF NOT EXISTS "anchor_batch" (
  "id" INTEGER PRIMARY KEY,
  "batch_no" TEXT NOT NULL,
  "leaf_count" INTEGER DEFAULT 0 NOT NULL,
  "merkle_root" TEXT NOT NULL,
  "algo" TEXT NOT NULL,
  "anchor_tx_id" TEXT,
  "anchor_block_index" INTEGER,
  "window_from" TEXT NOT NULL,
  "window_to" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_ab_anchor_tx" ON "anchor_batch" ("anchor_tx_id");
CREATE INDEX IF NOT EXISTS "idx_ab_created" ON "anchor_batch" ("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_ab_batch_no" ON "anchor_batch" ("batch_no");

-- audit_log —— 系统操作日志表（entry_hash 构成哈希链，可验证未被篡改）（13 列）
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" INTEGER PRIMARY KEY,
  "user_id" INTEGER,
  "username" TEXT,
  "role" TEXT,
  "module" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target" TEXT,
  "detail" TEXT,
  "ip" TEXT,
  "result" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "prev_hash" TEXT,
  "entry_hash" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_log_entry_hash" ON "audit_log" ("entry_hash");
CREATE INDEX IF NOT EXISTS "idx_log_module" ON "audit_log" ("module");
CREATE INDEX IF NOT EXISTS "idx_log_time" ON "audit_log" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_log_user" ON "audit_log" ("user_id");

-- batch_leaf —— 批量锚定叶节点表（一笔存证只归属一个批次）（7 列）
CREATE TABLE IF NOT EXISTS "batch_leaf" (
  "id" INTEGER PRIMARY KEY,
  "batch_no" TEXT NOT NULL,
  "leaf_index" INTEGER NOT NULL,
  "tx_id" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "block_index" INTEGER,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_bl_batch" ON "batch_leaf" ("batch_no");
CREATE INDEX IF NOT EXISTS "idx_bl_block" ON "batch_leaf" ("block_index");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_bl_batch_leaf" ON "batch_leaf" ("batch_no", "leaf_index");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_bl_tx" ON "batch_leaf" ("tx_id");

-- calc_batch —— 核算批次（可复算、可回溯）（33 列）
CREATE TABLE IF NOT EXISTS "calc_batch" (
  "id" INTEGER PRIMARY KEY,
  "batch_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "period_from" TEXT NOT NULL,
  "period_to" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "factor_version" TEXT NOT NULL,
  "industry" TEXT NOT NULL,
  "region" TEXT,
  "scope1" REAL DEFAULT 0.000 NOT NULL,
  "scope2" REAL DEFAULT 0.000 NOT NULL,
  "total_emission" REAL DEFAULT 0.000 NOT NULL,
  "intensity" REAL,
  "output_value" REAL,
  "is_complete" INTEGER DEFAULT 0 NOT NULL,
  "coverage_ratio" REAL DEFAULT 0.0000 NOT NULL,
  "gap_count" INTEGER DEFAULT 0 NOT NULL,
  "gap_detail" TEXT,
  "quality_tier" TEXT,
  "usable_for_compliance" INTEGER DEFAULT 0 NOT NULL,
  "u_rel" REAL,
  "u95_rel" REAL,
  "u_low" REAL,
  "u_high" REAL,
  "input_digest" TEXT NOT NULL,
  "result_digest" TEXT NOT NULL,
  "engine_version" TEXT DEFAULT 1.0 NOT NULL,
  "status" TEXT NOT NULL,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "operator" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_cb_digest" ON "calc_batch" ("input_digest");
CREATE INDEX IF NOT EXISTS "idx_cb_ent_year" ON "calc_batch" ("ent_id", "year");
CREATE INDEX IF NOT EXISTS "idx_cb_status" ON "calc_batch" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_calc_batch" ON "calc_batch" ("batch_no");

-- calc_source_detail —— 核算分源明细（逐项可核对）（18 列）
CREATE TABLE IF NOT EXISTS "calc_source_detail" (
  "id" INTEGER PRIMARY KEY,
  "batch_id" INTEGER NOT NULL,
  "source_code" TEXT NOT NULL,
  "source_cn" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "scope" INTEGER NOT NULL,
  "activity" REAL,
  "activity_unit" TEXT,
  "months_count" INTEGER DEFAULT 0 NOT NULL,
  "ef_value" REAL,
  "ef_source" TEXT,
  "ef_tier" TEXT,
  "derivation" TEXT,
  "emission" REAL,
  "status" TEXT NOT NULL,
  "gap_reason" TEXT,
  "data_origin" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_csd_batch" ON "calc_source_detail" ("batch_id");
CREATE INDEX IF NOT EXISTS "idx_csd_source" ON "calc_source_detail" ("source_code");

-- carbon_dynamic_account —— 企业动态核算账户表（16 列）
CREATE TABLE IF NOT EXISTS "carbon_dynamic_account" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "period" TEXT NOT NULL,
  "cumulative_emission" REAL DEFAULT 0.000 NOT NULL,
  "quota_allocated" REAL DEFAULT 0.000 NOT NULL,
  "quota_available" REAL DEFAULT 0.000 NOT NULL,
  "gap" REAL DEFAULT 0.000 NOT NULL,
  "predicted_eoy" REAL DEFAULT 0.000 NOT NULL,
  "offset_applied" REAL DEFAULT 0.000 NOT NULL,
  "emission_rate" REAL DEFAULT 0.0000 NOT NULL,
  "risk_level" TEXT NOT NULL,
  "data_points" INTEGER DEFAULT 0 NOT NULL,
  "excluded_points" INTEGER DEFAULT 0 NOT NULL,
  "last_reading_at" TEXT,
  "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_dyn_risk" ON "carbon_dynamic_account" ("risk_level");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_dyn_ent_year" ON "carbon_dynamic_account" ("ent_id", "year");

-- carbon_quota —— 企业碳配额账户表（10 列）
CREATE TABLE IF NOT EXISTS "carbon_quota" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "total_allocated" REAL DEFAULT 0.00 NOT NULL,
  "available" REAL DEFAULT 0.00 NOT NULL,
  "frozen" REAL DEFAULT 0.00 NOT NULL,
  "used" REAL DEFAULT 0.00 NOT NULL,
  "bought" REAL DEFAULT 0.00 NOT NULL,
  "sold" REAL DEFAULT 0.00 NOT NULL,
  "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_quota_year" ON "carbon_quota" ("year");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_quota_ent_year" ON "carbon_quota" ("ent_id", "year");

-- cbam_certificate —— CBAM 证书台账（21 列）
CREATE TABLE IF NOT EXISTS "cbam_certificate" (
  "id" INTEGER PRIMARY KEY,
  "cert_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "declaration_id" INTEGER,
  "year" INTEGER NOT NULL,
  "embedded_emission" REAL DEFAULT 0.000 NOT NULL,
  "free_allocation" REAL DEFAULT 0.000 NOT NULL,
  "cbam_factor" REAL DEFAULT 1.0000 NOT NULL,
  "payable_emission" REAL DEFAULT 0.000 NOT NULL,
  "eua_price_eur" REAL DEFAULT 0.0000 NOT NULL,
  "eur_cny" REAL DEFAULT 0.0000 NOT NULL,
  "price_source" TEXT,
  "amount_eur" REAL DEFAULT 0.00 NOT NULL,
  "amount_cny" REAL DEFAULT 0.00 NOT NULL,
  "origin_carbon_price_paid" REAL DEFAULT 0.00 NOT NULL,
  "deduction_cny" REAL DEFAULT 0.00 NOT NULL,
  "net_payable_cny" REAL DEFAULT 0.00 NOT NULL,
  "status" TEXT NOT NULL,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_cbam_ent_year" ON "cbam_certificate" ("ent_id", "year");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_cbam_cert" ON "cbam_certificate" ("cert_no");

-- cbam_declaration —— CBAM 产品隐含碳申报数据包（ISO 14067 口径）（23 列）
CREATE TABLE IF NOT EXISTS "cbam_declaration" (
  "id" INTEGER PRIMARY KEY,
  "decl_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "period" TEXT NOT NULL,
  "cn_code" TEXT NOT NULL,
  "goods_name" TEXT NOT NULL,
  "goods_quantity" REAL NOT NULL,
  "quantity_unit" TEXT NOT NULL,
  "direct_emission" REAL DEFAULT 0.0000 NOT NULL,
  "indirect_emission" REAL DEFAULT 0.0000 NOT NULL,
  "embedded_intensity" REAL DEFAULT 0.000000 NOT NULL,
  "carbon_price_paid" REAL DEFAULT 0.00 NOT NULL,
  "carbon_price_currency" TEXT NOT NULL,
  "methodology" TEXT NOT NULL,
  "emission_route" TEXT NOT NULL,
  "eu_default_intensity" REAL,
  "evidence_digest" TEXT NOT NULL,
  "evidence_refs" TEXT,
  "regulation_basis" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "chain_tx_id" TEXT,
  "block_index" INTEGER,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_cbam_cn" ON "cbam_declaration" ("cn_code");
CREATE INDEX IF NOT EXISTS "idx_cbam_ent" ON "cbam_declaration" ("ent_id", "period");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_cbam_no" ON "cbam_declaration" ("decl_no");

-- cems_reading —— CEMS 在线监测读数表（同一排口同一时刻唯一，采数幂等）（22 列）
CREATE TABLE IF NOT EXISTS "cems_reading" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "monitor_no" TEXT NOT NULL,
  "energy_type" TEXT NOT NULL,
  "reading_time" TEXT NOT NULL,
  "flow_value" REAL DEFAULT 0.000 NOT NULL,
  "cum_value" REAL DEFAULT 0.000 NOT NULL,
  "o2_content" REAL,
  "temperature" REAL,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "quality_flag" TEXT NOT NULL,
  "device_did" TEXT,
  "crc16" TEXT,
  "sm3_digest" TEXT,
  "batch_no" TEXT,
  "chain_tx_id" TEXT,
  "dev_seq" INTEGER,
  "signature" TEXT,
  "sig_mode" TEXT,
  "gdev_tph" REAL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_cems_batch" ON "cems_reading" ("batch_no");
CREATE INDEX IF NOT EXISTS "idx_cems_ent_time" ON "cems_reading" ("ent_id", "reading_time");
CREATE INDEX IF NOT EXISTS "idx_cems_quality" ON "cems_reading" ("quality_flag");
CREATE INDEX IF NOT EXISTS "idx_cems_time" ON "cems_reading" ("reading_time");
CREATE INDEX IF NOT EXISTS "idx_reading_seq" ON "cems_reading" ("device_did", "dev_seq");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_cems_point" ON "cems_reading" ("ent_id", "monitor_no", "reading_time");

-- credit_asset —— 碳信用资产表（配额之外的碳资产类型）（14 列）
CREATE TABLE IF NOT EXISTS "credit_asset" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "asset_no" TEXT NOT NULL,
  "asset_type" TEXT NOT NULL,
  "project_name" TEXT,
  "amount" REAL DEFAULT 0.000 NOT NULL,
  "used_amount" REAL DEFAULT 0.000 NOT NULL,
  "issue_year" INTEGER,
  "valid_until" TEXT,
  "registry" TEXT,
  "status" TEXT NOT NULL,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_credit_ent" ON "credit_asset" ("ent_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_credit_asset_no" ON "credit_asset" ("asset_no");

-- credit_offset —— 碳信用抵销流水表（14 列）
CREATE TABLE IF NOT EXISTS "credit_offset" (
  "id" INTEGER PRIMARY KEY,
  "offset_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "asset_id" INTEGER NOT NULL,
  "amount" REAL NOT NULL,
  "ratio_limit" REAL DEFAULT 0.0500 NOT NULL,
  "quota_before" REAL DEFAULT 0.000 NOT NULL,
  "quota_after" REAL DEFAULT 0.000 NOT NULL,
  "operator" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_offset_ent" ON "credit_offset" ("ent_id", "year");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_offset_no" ON "credit_offset" ("offset_no");

-- credit_retirement —— 碳信用注销记录（14 列）
CREATE TABLE IF NOT EXISTS "credit_retirement" (
  "id" INTEGER PRIMARY KEY,
  "retire_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "asset_id" INTEGER NOT NULL,
  "amount" REAL NOT NULL,
  "purpose" TEXT NOT NULL,
  "beneficiary" TEXT,
  "asset_status_before" TEXT,
  "proof_hash" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "status" TEXT NOT NULL,
  "operator" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_retire_asset" ON "credit_retirement" ("asset_id");
CREATE INDEX IF NOT EXISTS "idx_retire_ent" ON "credit_retirement" ("ent_id", "purpose");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_retire_no" ON "credit_retirement" ("retire_no");

-- data_ingest_log —— 数据采集留痕（成功与失败均记录）（11 列）
CREATE TABLE IF NOT EXISTS "data_ingest_log" (
  "id" INTEGER PRIMARY KEY,
  "source_key" TEXT NOT NULL,
  "started_at" TEXT NOT NULL,
  "finished_at" TEXT,
  "duration_ms" INTEGER,
  "status" TEXT NOT NULL,
  "records" INTEGER,
  "from_cache" INTEGER DEFAULT 0 NOT NULL,
  "error" TEXT,
  "detail_json" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_dil_source" ON "data_ingest_log" ("source_key", "created_at");
CREATE INDEX IF NOT EXISTS "idx_dil_status" ON "data_ingest_log" ("status");

-- data_source —— 数据源登记表（含真实性等级）（16 列）
CREATE TABLE IF NOT EXISTS "data_source" (
  "id" INTEGER PRIMARY KEY,
  "source_key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "publisher" TEXT,
  "url" TEXT,
  "license" TEXT,
  "authenticity" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "refresh_ttl_ms" INTEGER DEFAULT 86400000 NOT NULL,
  "last_fetched_at" TEXT,
  "last_status" TEXT,
  "last_error" TEXT,
  "record_count" INTEGER,
  "note" TEXT,
  "enabled" INTEGER DEFAULT 1 NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_ds_scope" ON "data_source" ("scope", "authenticity");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_source_key" ON "data_source" ("source_key");

-- device_registry —— 工业现场设备注册表（DID 标识 + 授权状态 + 接入协议 + CEN-100 验签台账）（21 列）
CREATE TABLE IF NOT EXISTS "device_registry" (
  "id" INTEGER PRIMARY KEY,
  "device_did" TEXT NOT NULL,
  "ent_id" INTEGER,
  "monitor_no" TEXT,
  "protocol" TEXT NOT NULL,
  "device_type" TEXT,
  "manufacturer" TEXT,
  "mn" TEXT,
  "cert_fingerprint" TEXT,
  "auth_status" TEXT NOT NULL,
  "last_seen_at" TEXT,
  "offline" INTEGER DEFAULT 0 NOT NULL,
  "remark" TEXT,
  "dev_pubkey" TEXT,
  "dev_key_fp" TEXT,
  "dev_key_reg_at" TEXT,
  "dev_sm2_id" TEXT DEFAULT 1234567812345678 NOT NULL,
  "dev_last_seq" INTEGER DEFAULT 0 NOT NULL,
  "dev_sig_mode" TEXT,
  "tamper_at" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_dev_keyfp" ON "device_registry" ("dev_key_fp");
CREATE INDEX IF NOT EXISTS "idx_dr_ent" ON "device_registry" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_dr_protocol" ON "device_registry" ("protocol");
CREATE INDEX IF NOT EXISTS "idx_dr_status" ON "device_registry" ("auth_status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_dr_did" ON "device_registry" ("device_did");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_dr_mn" ON "device_registry" ("mn");

-- device_verify_log —— 设备签名验签事件台账（阴性对照与攻击证据留痕）（10 列）
CREATE TABLE IF NOT EXISTS "device_verify_log" (
  "id" INTEGER PRIMARY KEY,
  "mn" TEXT NOT NULL,
  "device_did" TEXT,
  "seq" INTEGER,
  "outcome" TEXT NOT NULL,
  "mode" TEXT,
  "cn" TEXT,
  "ip" TEXT,
  "detail" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_log_mn" ON "device_verify_log" ("mn", "created_at");
CREATE INDEX IF NOT EXISTS "idx_log_outcome" ON "device_verify_log" ("outcome", "created_at");

-- emission_factor —— 排放因子库表（14 列）
CREATE TABLE IF NOT EXISTS "emission_factor" (
  "id" INTEGER PRIMARY KEY,
  "energy_type" TEXT NOT NULL,
  "factor" REAL NOT NULL,
  "unit" TEXT NOT NULL,
  "scope" INTEGER DEFAULT 1 NOT NULL,
  "source" TEXT,
  "industry" TEXT,
  "version" TEXT,
  "effective_from" TEXT,
  "effective_to" TEXT,
  "status" TEXT NOT NULL,
  "remark" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_factor_energy" ON "emission_factor" ("energy_type");
CREATE INDEX IF NOT EXISTS "idx_factor_industry" ON "emission_factor" ("industry");

-- emission_item —— 碳排放上报明细行（11 列）
CREATE TABLE IF NOT EXISTS "emission_item" (
  "id" INTEGER PRIMARY KEY,
  "report_id" INTEGER NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "energy_type" TEXT NOT NULL,
  "scope" INTEGER DEFAULT 1 NOT NULL,
  "amount" REAL DEFAULT 0.000 NOT NULL,
  "unit" TEXT NOT NULL,
  "factor" REAL DEFAULT 0.000000 NOT NULL,
  "co2" REAL DEFAULT 0.000 NOT NULL,
  "calc_method" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_item_ent" ON "emission_item" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_item_report" ON "emission_item" ("report_id");
CREATE INDEX IF NOT EXISTS "idx_item_type" ON "emission_item" ("energy_type");

-- emission_report —— 企业碳排放数据上报单（29 列）
CREATE TABLE IF NOT EXISTS "emission_report" (
  "id" INTEGER PRIMARY KEY,
  "report_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "quarter" INTEGER NOT NULL,
  "period" TEXT NOT NULL,
  "scope1_emission" REAL DEFAULT 0.00 NOT NULL,
  "scope2_emission" REAL DEFAULT 0.00 NOT NULL,
  "total_emission" REAL DEFAULT 0.00 NOT NULL,
  "energy_consumption" REAL DEFAULT 0.00 NOT NULL,
  "output_value" REAL DEFAULT 0.00 NOT NULL,
  "intensity" REAL DEFAULT 0.0000 NOT NULL,
  "yoy_rate" REAL DEFAULT 0.00 NOT NULL,
  "data_source" TEXT,
  "status" TEXT NOT NULL,
  "verifier_id" INTEGER,
  "submit_time" TEXT,
  "verify_time" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "attachment" TEXT,
  "remark" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "data_source_id" INTEGER,
  "is_real" INTEGER DEFAULT 0 NOT NULL,
  "co2_only" REAL,
  "ch4_co2e" REAL,
  "n2o_co2e" REAL,
  "biogenic_co2" REAL
);
CREATE INDEX IF NOT EXISTS "idx_report_ent" ON "emission_report" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_report_period" ON "emission_report" ("period");
CREATE INDEX IF NOT EXISTS "idx_report_status" ON "emission_report" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_report_no" ON "emission_report" ("report_no");

-- enterprise —— 控排企业名录表（24 列）
CREATE TABLE IF NOT EXISTS "enterprise" (
  "id" INTEGER PRIMARY KEY,
  "ent_code" TEXT NOT NULL,
  "ent_name" TEXT NOT NULL,
  "short_name" TEXT,
  "industry" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "city" TEXT,
  "scale" TEXT,
  "legal_person" TEXT,
  "contact_phone" TEXT,
  "reg_capital" REAL DEFAULT 0.00,
  "annual_output" REAL DEFAULT 0.00,
  "headcount" INTEGER DEFAULT 0,
  "wallet_address" TEXT,
  "pub_key" TEXT,
  "credit_score" INTEGER DEFAULT 100 NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "data_source_id" INTEGER,
  "external_id" TEXT,
  "latitude" REAL,
  "longitude" REAL,
  "naics" TEXT,
  "is_real" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_ent_industry" ON "enterprise" ("industry");
CREATE INDEX IF NOT EXISTS "idx_ent_region" ON "enterprise" ("region");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_ent_code" ON "enterprise" ("ent_code");

-- factor_entry —— 结构化排放因子台账（三要素可复算）（23 列）
CREATE TABLE IF NOT EXISTS "factor_entry" (
  "id" INTEGER PRIMARY KEY,
  "code" TEXT NOT NULL,
  "name_cn" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "scope" INTEGER DEFAULT 1 NOT NULL,
  "ncv" REAL,
  "ncv_unit" TEXT,
  "cc" REAL,
  "of_rate" REAL,
  "ef_value" REAL NOT NULL,
  "ef_unit" TEXT NOT NULL,
  "source_doc" TEXT NOT NULL,
  "source_year" INTEGER,
  "industry" TEXT,
  "region" TEXT,
  "version" TEXT NOT NULL,
  "effective_from" TEXT NOT NULL,
  "effective_to" TEXT,
  "status" TEXT NOT NULL,
  "recompute_ok" INTEGER DEFAULT 0 NOT NULL,
  "recompute_diff" REAL,
  "remark" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_fe_category" ON "factor_entry" ("category");
CREATE INDEX IF NOT EXISTS "idx_fe_status" ON "factor_entry" ("status", "effective_from");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_factor_entry" ON "factor_entry" ("code", "version", "region");

-- factor_version —— 排放因子版本表（10 列）
CREATE TABLE IF NOT EXISTS "factor_version" (
  "id" INTEGER PRIMARY KEY,
  "version" TEXT NOT NULL,
  "effective_from" TEXT NOT NULL,
  "effective_to" TEXT,
  "operator" TEXT,
  "snapshot" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uk_factor_version" ON "factor_version" ("version");

-- green_cert —— 绿证绿电台账（防双重声明）（16 列）
CREATE TABLE IF NOT EXISTS "green_cert" (
  "id" INTEGER PRIMARY KEY,
  "cert_no" TEXT NOT NULL,
  "cert_type" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "energy_source" TEXT NOT NULL,
  "energy_mwh" REAL NOT NULL,
  "period_from" TEXT NOT NULL,
  "period_to" TEXT NOT NULL,
  "owner_ent_id" INTEGER,
  "claim_status" TEXT NOT NULL,
  "claimed_by_ent" INTEGER,
  "claimed_batch" INTEGER,
  "claimed_at" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_gc_owner" ON "green_cert" ("owner_ent_id");
CREATE INDEX IF NOT EXISTS "idx_gc_period" ON "green_cert" ("period_from", "period_to");
CREATE INDEX IF NOT EXISTS "idx_gc_status" ON "green_cert" ("claim_status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_green_cert" ON "green_cert" ("cert_no");

-- green_power_match —— 小时级绿电溯源匹配（实际值法核算间接排放的依据）（17 列）
CREATE TABLE IF NOT EXISTS "green_power_match" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "stat_hour" TEXT NOT NULL,
  "consumption_mwh" REAL DEFAULT 0.0000 NOT NULL,
  "green_mwh" REAL DEFAULT 0.0000 NOT NULL,
  "match_status" TEXT NOT NULL,
  "coverage_ratio" REAL DEFAULT 0.000000 NOT NULL,
  "cert_no" TEXT,
  "cert_type" TEXT,
  "source_name" TEXT,
  "grid_factor" REAL DEFAULT 0.000000 NOT NULL,
  "residual_factor" REAL DEFAULT 0.000000 NOT NULL,
  "provenance" TEXT,
  "evidence_digest" TEXT,
  "chain_tx_id" TEXT,
  "block_index" INTEGER,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_gpm_ent_hour" ON "green_power_match" ("ent_id", "stat_hour");
CREATE INDEX IF NOT EXISTS "idx_gpm_status" ON "green_power_match" ("match_status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_gpm_hour_cert" ON "green_power_match" ("ent_id", "stat_hour", "cert_no");

-- key_rotation_log —— 密钥轮换与双人复核日志（PKCS#11 接口预留）（17 列）
CREATE TABLE IF NOT EXISTS "key_rotation_log" (
  "id" INTEGER PRIMARY KEY,
  "key_label" TEXT NOT NULL,
  "key_type" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "old_address" TEXT,
  "new_address" TEXT,
  "old_fingerprint" TEXT,
  "new_fingerprint" TEXT,
  "reason" TEXT,
  "requested_by" TEXT NOT NULL,
  "approved_by" TEXT,
  "approval_status" TEXT NOT NULL,
  "approval_note" TEXT,
  "approved_at" TEXT,
  "chain_tx_id" TEXT,
  "block_index" INTEGER,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_krl_label" ON "key_rotation_log" ("key_label", "created_at");
CREATE INDEX IF NOT EXISTS "idx_krl_status" ON "key_rotation_log" ("approval_status");

-- live_rollup —— 实时指标分钟聚合归档（10 列）
CREATE TABLE IF NOT EXISTS "live_rollup" (
  "id" INTEGER PRIMARY KEY,
  "bucket" TEXT NOT NULL,
  "metric_key" TEXT NOT NULL,
  "metric_cn" TEXT,
  "value_avg" REAL,
  "value_min" REAL,
  "value_max" REAL,
  "samples" INTEGER DEFAULT 0 NOT NULL,
  "unit" TEXT,
  "provenance" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_lr_key" ON "live_rollup" ("metric_key", "bucket");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_lr" ON "live_rollup" ("bucket", "metric_key");

-- macro_indicator —— 宏观真实指标时间序列（世行/OWID）（10 列）
CREATE TABLE IF NOT EXISTS "macro_indicator" (
  "id" INTEGER PRIMARY KEY,
  "source_id" INTEGER NOT NULL,
  "country_iso" TEXT NOT NULL,
  "indicator" TEXT NOT NULL,
  "indicator_cn" TEXT,
  "year" INTEGER NOT NULL,
  "value" REAL,
  "unit" TEXT,
  "raw_json" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_macro_ind" ON "macro_indicator" ("indicator", "year");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_macro" ON "macro_indicator" ("source_id", "country_iso", "indicator", "year");

-- model_eval —— 预测模型评估与消融实验（MAPE/R²/消融）（16 列）
CREATE TABLE IF NOT EXISTS "model_eval" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER,
  "model" TEXT NOT NULL,
  "horizon_days" INTEGER DEFAULT 30 NOT NULL,
  "n_train" INTEGER DEFAULT 0 NOT NULL,
  "n_test" INTEGER DEFAULT 0 NOT NULL,
  "split" TEXT NOT NULL,
  "mape" REAL DEFAULT 0.0000 NOT NULL,
  "rmse" REAL DEFAULT 0.0000 NOT NULL,
  "mae" REAL DEFAULT 0.0000 NOT NULL,
  "r2" REAL DEFAULT 0.000000 NOT NULL,
  "params" TEXT,
  "ablation" TEXT,
  "dataset_slice" TEXT,
  "verdict" TEXT,
  "evaluated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_me_ent" ON "model_eval" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_me_model" ON "model_eval" ("model");

-- notice —— 平台通知公告表（9 列）
CREATE TABLE IF NOT EXISTS "notice" (
  "id" INTEGER PRIMARY KEY,
  "title" TEXT NOT NULL,
  "content" TEXT,
  "notice_type" TEXT NOT NULL,
  "target_role" TEXT NOT NULL,
  "publisher" TEXT,
  "is_top" INTEGER DEFAULT 0 NOT NULL,
  "views" INTEGER DEFAULT 0 NOT NULL,
  "publish_time" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "source_name" TEXT,
  "source_url" TEXT,
  "fetched_at" TEXT
);
CREATE INDEX IF NOT EXISTS "idx_notice_time" ON "notice" ("publish_time");
CREATE INDEX IF NOT EXISTS "idx_notice_type" ON "notice" ("notice_type");

-- prediction_record —— 多智能体预测结果表（9 列）
CREATE TABLE IF NOT EXISTS "prediction_record" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "agent" TEXT NOT NULL,
  "predicted_eoy" REAL,
  "gap" REAL,
  "risk_level" TEXT,
  "detail" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_pred_agent" ON "prediction_record" ("agent");
CREATE INDEX IF NOT EXISTS "idx_pred_ent_year" ON "prediction_record" ("ent_id", "year");

-- quota_allocation —— 碳配额分配流水表（12 列）
CREATE TABLE IF NOT EXISTS "quota_allocation" (
  "id" INTEGER PRIMARY KEY,
  "alloc_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "quota_amount" REAL DEFAULT 0.00 NOT NULL,
  "alloc_type" TEXT NOT NULL,
  "alloc_method" TEXT,
  "baseline_intensity" REAL,
  "operator" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_alloc_ent" ON "quota_allocation" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_alloc_year" ON "quota_allocation" ("year");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_alloc_no" ON "quota_allocation" ("alloc_no");

-- quota_surrender —— 配额履约清缴（21 列）
CREATE TABLE IF NOT EXISTS "quota_surrender" (
  "id" INTEGER PRIMARY KEY,
  "surrender_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "verified_emission" REAL DEFAULT 0.000 NOT NULL,
  "offset_used" REAL DEFAULT 0.000 NOT NULL,
  "required_quota" REAL DEFAULT 0.000 NOT NULL,
  "surrendered_quota" REAL DEFAULT 0.000 NOT NULL,
  "shortfall" REAL DEFAULT 0.000 NOT NULL,
  "penalty" REAL DEFAULT 0.00 NOT NULL,
  "penalty_rule" TEXT,
  "calc_batch_id" INTEGER,
  "verify_report_id" INTEGER,
  "emission_source" TEXT,
  "status" TEXT NOT NULL,
  "certificate_no" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "operator" TEXT,
  "deadline" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_sur_status" ON "quota_surrender" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_surrender_ent_year" ON "quota_surrender" ("ent_id", "year");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_surrender_no" ON "quota_surrender" ("surrender_no");

-- real_emission_year —— 真实设施年度排放（官方报告值）（14 列）
CREATE TABLE IF NOT EXISTS "real_emission_year" (
  "id" INTEGER PRIMARY KEY,
  "facility_id" INTEGER NOT NULL,
  "source_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "total_co2e" REAL,
  "co2" REAL,
  "ch4_co2e" REAL,
  "n2o_co2e" REAL,
  "biogenic_co2" REAL,
  "unit" TEXT NOT NULL,
  "process_json" TEXT,
  "source_url" TEXT,
  "authenticity" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_rey_total" ON "real_emission_year" ("total_co2e");
CREATE INDEX IF NOT EXISTS "idx_rey_year" ON "real_emission_year" ("year");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_rey" ON "real_emission_year" ("facility_id", "year");

-- real_facility —— 真实设施台账（官方公开数据，非合成）（19 列）
CREATE TABLE IF NOT EXISTS "real_facility" (
  "id" INTEGER PRIMARY KEY,
  "source_id" INTEGER NOT NULL,
  "country_iso" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "name_cn" TEXT,
  "industry" TEXT NOT NULL,
  "sector_raw" TEXT,
  "naics" TEXT,
  "admin1" TEXT,
  "admin2" TEXT,
  "city" TEXT,
  "postal" TEXT,
  "latitude" REAL,
  "longitude" REAL,
  "source_url" TEXT,
  "authenticity" TEXT NOT NULL,
  "first_seen_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_rf_auth" ON "real_facility" ("authenticity");
CREATE INDEX IF NOT EXISTS "idx_rf_country" ON "real_facility" ("country_iso", "industry");
CREATE INDEX IF NOT EXISTS "idx_rf_country_id" ON "real_facility" ("country_iso", "id");
CREATE INDEX IF NOT EXISTS "idx_rf_geo" ON "real_facility" ("admin1", "city");
CREATE INDEX IF NOT EXISTS "idx_rf_ind" ON "real_facility" ("industry");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_rf_ext" ON "real_facility" ("source_id", "external_id");

-- real_series —— 真实宏观/市场时间序列（统一长表）（12 列）
CREATE TABLE IF NOT EXISTS "real_series" (
  "id" INTEGER PRIMARY KEY,
  "source_id" INTEGER NOT NULL,
  "series_key" TEXT NOT NULL,
  "series_cn" TEXT,
  "scope" TEXT NOT NULL,
  "entity_ref" TEXT,
  "ts" TEXT NOT NULL,
  "value" REAL,
  "unit" TEXT,
  "authenticity" TEXT NOT NULL,
  "raw_json" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_rs_key_ts" ON "real_series" ("series_key", "ts");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_rs" ON "real_series" ("source_id", "series_key", "entity_ref", "ts");

-- reconciliation —— 链上链下对账记录表（6 列）
CREATE TABLE IF NOT EXISTS "reconciliation" (
  "id" INTEGER PRIMARY KEY,
  "recon_no" TEXT NOT NULL,
  "total_records" INTEGER DEFAULT 0 NOT NULL,
  "inconsistent" INTEGER DEFAULT 0 NOT NULL,
  "detail" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uk_recon_no" ON "reconciliation" ("recon_no");

-- report_export —— 双轨报告导出台账（ISO 14064-1 / ISO 14067）（15 列）
CREATE TABLE IF NOT EXISTS "report_export" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "std" TEXT NOT NULL,
  "report_scope" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "content_digest" TEXT NOT NULL,
  "file_fingerprint" TEXT NOT NULL,
  "total_emission" REAL DEFAULT 0.0000 NOT NULL,
  "cross_check" TEXT,
  "generated_by" TEXT,
  "chain_tx_id" TEXT,
  "block_index" INTEGER,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_rpt_ent" ON "report_export" ("ent_id", "std", "period");

-- settlement_account —— 资金结算账户（11 列）
CREATE TABLE IF NOT EXISTS "settlement_account" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "balance" REAL DEFAULT 0.00 NOT NULL,
  "frozen" REAL DEFAULT 0.00 NOT NULL,
  "total_in" REAL DEFAULT 0.00 NOT NULL,
  "total_out" REAL DEFAULT 0.00 NOT NULL,
  "credit_limit" REAL DEFAULT 0.00 NOT NULL,
  "status" TEXT NOT NULL,
  "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_settle_status" ON "settlement_account" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_settle_ent" ON "settlement_account" ("ent_id", "currency");

-- settlement_flow —— 资金流水（复式记账）（13 列）
CREATE TABLE IF NOT EXISTS "settlement_flow" (
  "id" INTEGER PRIMARY KEY,
  "flow_no" TEXT NOT NULL,
  "biz_type" TEXT NOT NULL,
  "biz_ref" TEXT,
  "ent_id" INTEGER NOT NULL,
  "direction" TEXT NOT NULL,
  "amount" REAL NOT NULL,
  "balance_after" REAL NOT NULL,
  "counterparty" INTEGER,
  "remark" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_flow_biz" ON "settlement_flow" ("biz_type", "biz_ref");
CREATE INDEX IF NOT EXISTS "idx_flow_ent" ON "settlement_flow" ("ent_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_flow_no" ON "settlement_flow" ("flow_no");

-- source_crosscheck —— 同源双路交叉验证记录（发现数采仪改数的证据链）（10 列）
CREATE TABLE IF NOT EXISTS "source_crosscheck" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "monitor_no" TEXT NOT NULL,
  "reading_time" TEXT NOT NULL,
  "value_cems" REAL,
  "value_edge" REAL,
  "rel_diff" REAL,
  "threshold_pct" REAL DEFAULT 5.000 NOT NULL,
  "alarmed" INTEGER DEFAULT 0 NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_cc_ent" ON "source_crosscheck" ("ent_id", "monitor_no", "reading_time");

-- sys_user —— 统一用户账号表（14 列）
CREATE TABLE IF NOT EXISTS "sys_user" (
  "id" INTEGER PRIMARY KEY,
  "username" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "salt" TEXT NOT NULL,
  "real_name" TEXT,
  "role" TEXT NOT NULL,
  "org_id" INTEGER,
  "org_name" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "avatar" TEXT,
  "status" INTEGER DEFAULT 1 NOT NULL,
  "last_login" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_user_org" ON "sys_user" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_user_role" ON "sys_user" ("role");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_user_username" ON "sys_user" ("username");

-- trade_deal —— 碳配额成交记录表（14 列）
CREATE TABLE IF NOT EXISTS "trade_deal" (
  "id" INTEGER PRIMARY KEY,
  "deal_no" TEXT NOT NULL,
  "buy_order_id" INTEGER,
  "sell_order_id" INTEGER,
  "buyer_ent_id" INTEGER NOT NULL,
  "seller_ent_id" INTEGER NOT NULL,
  "price" REAL DEFAULT 0.00 NOT NULL,
  "amount" REAL DEFAULT 0.00 NOT NULL,
  "total_amount" REAL DEFAULT 0.00 NOT NULL,
  "fee" REAL DEFAULT 0.00 NOT NULL,
  "deal_time" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "status" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_deal_buyer" ON "trade_deal" ("buyer_ent_id");
CREATE INDEX IF NOT EXISTS "idx_deal_seller" ON "trade_deal" ("seller_ent_id");
CREATE INDEX IF NOT EXISTS "idx_deal_time" ON "trade_deal" ("deal_time");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_deal_no" ON "trade_deal" ("deal_no");

-- trade_order —— 碳配额交易挂单表（10 列）
CREATE TABLE IF NOT EXISTS "trade_order" (
  "id" INTEGER PRIMARY KEY,
  "order_no" TEXT NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "side" TEXT NOT NULL,
  "price" REAL DEFAULT 0.00 NOT NULL,
  "amount" REAL DEFAULT 0.00 NOT NULL,
  "filled_amount" REAL DEFAULT 0.00 NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_order_ent" ON "trade_order" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_order_side" ON "trade_order" ("side");
CREATE INDEX IF NOT EXISTS "idx_order_status" ON "trade_order" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_order_no" ON "trade_order" ("order_no");

-- truth_declaration —— 数据真实性声明（运行时可核验）（11 列）
CREATE TABLE IF NOT EXISTS "truth_declaration" (
  "id" INTEGER PRIMARY KEY,
  "decl_key" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "layer" TEXT NOT NULL,
  "claim" TEXT NOT NULL,
  "basis" TEXT,
  "verify_sql" TEXT,
  "expected" INTEGER,
  "tolerance" TEXT NOT NULL,
  "note" TEXT,
  "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uk_td" ON "truth_declaration" ("decl_key");

-- uncertainty_posterior —— 贝叶斯后验不确定度（含 95% 置信区间与蒙特卡洛交叉验证）（17 列）
CREATE TABLE IF NOT EXISTS "uncertainty_posterior" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "target" TEXT NOT NULL,
  "prior_type" TEXT NOT NULL,
  "prior_params" TEXT,
  "posterior_params" TEXT NOT NULL,
  "n_obs" INTEGER DEFAULT 0 NOT NULL,
  "obs_summary" TEXT,
  "mean" REAL DEFAULT 0.0000 NOT NULL,
  "sd" REAL DEFAULT 0.000000 NOT NULL,
  "ci_level" REAL DEFAULT 0.9500 NOT NULL,
  "ci_low" REAL DEFAULT 0.0000 NOT NULL,
  "ci_high" REAL DEFAULT 0.0000 NOT NULL,
  "mc_cross_check" TEXT,
  "method" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uk_uq" ON "uncertainty_posterior" ("ent_id", "year", "target");

-- verification_finding —— 核查发现项（不符合项闭环）（16 列）
CREATE TABLE IF NOT EXISTS "verification_finding" (
  "id" INTEGER PRIMARY KEY,
  "task_id" INTEGER NOT NULL,
  "finding_no" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "evidence_ref" TEXT,
  "status" TEXT NOT NULL,
  "correction" TEXT,
  "rectify_deadline" TEXT,
  "rectified_at" TEXT,
  "verified_by" TEXT,
  "related_batch" INTEGER,
  "related_source" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_vf_status" ON "verification_finding" ("status", "severity");
CREATE INDEX IF NOT EXISTS "idx_vf_task" ON "verification_finding" ("task_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_finding_no" ON "verification_finding" ("finding_no");

-- verifier_org —— 第三方核查机构表（16 列）
CREATE TABLE IF NOT EXISTS "verifier_org" (
  "id" INTEGER PRIMARY KEY,
  "org_code" TEXT NOT NULL,
  "org_name" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "license_no" TEXT,
  "director" TEXT,
  "contact_phone" TEXT,
  "staff_count" INTEGER DEFAULT 0 NOT NULL,
  "level" TEXT NOT NULL,
  "done_tasks" INTEGER DEFAULT 0 NOT NULL,
  "pass_rate" REAL DEFAULT 0.00 NOT NULL,
  "rating" REAL DEFAULT 5.0 NOT NULL,
  "wallet_address" TEXT,
  "pub_key" TEXT,
  "status" TEXT NOT NULL,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_verifier_region" ON "verifier_org" ("region");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_verifier_code" ON "verifier_org" ("org_code");

-- verify_report —— 核查报告表（17 列）
CREATE TABLE IF NOT EXISTS "verify_report" (
  "id" INTEGER PRIMARY KEY,
  "report_no" TEXT NOT NULL,
  "task_id" INTEGER NOT NULL,
  "emission_report_id" INTEGER NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "verifier_id" INTEGER NOT NULL,
  "declared_value" REAL DEFAULT 0.00 NOT NULL,
  "verified_value" REAL DEFAULT 0.00 NOT NULL,
  "deviation_rate" REAL DEFAULT 0.00 NOT NULL,
  "conclusion" TEXT NOT NULL,
  "opinion" TEXT,
  "auditor" TEXT,
  "seal_hash" TEXT,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "issue_time" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_vreport_ent" ON "verify_report" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_vreport_verifier" ON "verify_report" ("verifier_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_vreport_no" ON "verify_report" ("report_no");

-- verify_task —— 第三方核查任务表（14 列）
CREATE TABLE IF NOT EXISTS "verify_task" (
  "id" INTEGER PRIMARY KEY,
  "task_no" TEXT NOT NULL,
  "report_id" INTEGER NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "verifier_id" INTEGER NOT NULL,
  "verifier_user" TEXT,
  "task_type" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "assign_time" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "deadline" TEXT,
  "finish_time" TEXT,
  "reject_reason" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_task_ent" ON "verify_task" ("ent_id");
CREATE INDEX IF NOT EXISTS "idx_task_status" ON "verify_task" ("status");
CREATE INDEX IF NOT EXISTS "idx_task_verifier" ON "verify_task" ("verifier_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_task_no" ON "verify_task" ("task_no");

-- zk_commitment —— 零知识承诺存证（不含任何原始数值）（17 列）
CREATE TABLE IF NOT EXISTS "zk_commitment" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "protocol" TEXT NOT NULL,
  "commit_value" TEXT NOT NULL,
  "proof_json" TEXT NOT NULL,
  "parts_json" TEXT,
  "digest" TEXT NOT NULL,
  "bits" INTEGER DEFAULT 64 NOT NULL,
  "scale_factor" INTEGER DEFAULT 1000 NOT NULL,
  "unit" TEXT NOT NULL,
  "prove_ms" INTEGER,
  "status" TEXT NOT NULL,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "created_by" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_zk_digest" ON "zk_commitment" ("digest");
CREATE INDEX IF NOT EXISTS "idx_zk_ent_year" ON "zk_commitment" ("ent_id", "year");
CREATE INDEX IF NOT EXISTS "idx_zk_status" ON "zk_commitment" ("status");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_zk_commit" ON "zk_commitment" ("ent_id", "year", "commit_value");

-- zk_disclosure_log —— 授权披露日志（披露行为可审计）（9 列）
CREATE TABLE IF NOT EXISTS "zk_disclosure_log" (
  "id" INTEGER PRIMARY KEY,
  "commitment_id" INTEGER NOT NULL,
  "ent_id" INTEGER NOT NULL,
  "scope" TEXT NOT NULL,
  "source_code" TEXT,
  "grantee" TEXT,
  "purpose" TEXT,
  "operator" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_zd_commit" ON "zk_disclosure_log" ("commitment_id");
CREATE INDEX IF NOT EXISTS "idx_zd_ent" ON "zk_disclosure_log" ("ent_id");

-- zk_formula_proof —— 公式正确性零知识证明（不含活动数据与排放量）（18 列）
CREATE TABLE IF NOT EXISTS "zk_formula_proof" (
  "id" INTEGER PRIMARY KEY,
  "ent_id" INTEGER NOT NULL,
  "year" INTEGER NOT NULL,
  "batch_no" TEXT NOT NULL,
  "factor_version" TEXT,
  "source_count" INTEGER DEFAULT 0 NOT NULL,
  "ef_scale" INTEGER DEFAULT 4 NOT NULL,
  "ad_scale" INTEGER DEFAULT 3 NOT NULL,
  "e_scale" INTEGER DEFAULT 7 NOT NULL,
  "e_commit" TEXT NOT NULL,
  "payload_json" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "proof_bytes" INTEGER,
  "status" TEXT NOT NULL,
  "chain_block_index" INTEGER,
  "chain_tx_id" TEXT,
  "created_by" TEXT,
  "created_at" TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_zkfp_batch" ON "zk_formula_proof" ("batch_no");
CREATE INDEX IF NOT EXISTS "idx_zkfp_ent_year" ON "zk_formula_proof" ("ent_id", "year");
CREATE UNIQUE INDEX IF NOT EXISTS "uk_zkfp_digest" ON "zk_formula_proof" ("digest");

-- =====================================================================
-- 预聚合表（D1 性能关键 —— MySQL 侧不需要，故不在此生成范围内）
-- =====================================================================
-- 实测：D1 上对 5 万行做 GROUP BY 会 rows_read=100,000，
-- 免费层每天 500 万行读取额度 ⇒ 只能跑 50 次。
-- 读预聚合表后同口径查询 rows_read=12。
-- 这不是"优化"，是"能不能用"的分界。
CREATE TABLE IF NOT EXISTS agg_facility_year (
  country_iso TEXT NOT NULL,
  year INTEGER NOT NULL,
  industry TEXT NOT NULL,
  region_code TEXT,
  facilities INTEGER NOT NULL DEFAULT 0,
  total_co2e REAL NOT NULL DEFAULT 0,
  device_rows INTEGER NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (country_iso, year, industry, region_code)
);
CREATE INDEX IF NOT EXISTS idx_afy_year ON agg_facility_year(year);

CREATE TABLE IF NOT EXISTS agg_facility_total (
  country_iso TEXT NOT NULL,
  year INTEGER NOT NULL,
  facilities INTEGER NOT NULL DEFAULT 0,
  emission_rows INTEGER NOT NULL DEFAULT 0,
  total_co2e REAL NOT NULL DEFAULT 0,
  aggregate_assets INTEGER NOT NULL DEFAULT 0,
  aggregate_tonnes REAL NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (country_iso, year)
);

CREATE TABLE IF NOT EXISTS agg_insight (
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, scope)
);

CREATE TABLE IF NOT EXISTS _migration_log (
  table_name TEXT PRIMARY KEY,
  rows_expected INTEGER,
  rows_written INTEGER,
  migrated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

PRAGMA foreign_keys = ON;
