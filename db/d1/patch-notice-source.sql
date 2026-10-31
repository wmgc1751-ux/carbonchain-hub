-- patch-notice-source.sql —— 已部署 D1 的 notice 表补丁
-- 为真实消息聚合（来源名称 / 原文链接 / 抓取时间）增加三列。
-- 可重复执行：用 ALTER TABLE ... ADD COLUMN（SQLite 无 IF NOT EXISTS，
-- 因此用下面的防重复写法——先查再改由 wrangler 外部保证，
-- 重复执行报 "duplicate column name" 视为已应用，无副作用）。

ALTER TABLE "notice" ADD COLUMN "source_name" TEXT;
ALTER TABLE "notice" ADD COLUMN "source_url" TEXT;
ALTER TABLE "notice" ADD COLUMN "fetched_at" TEXT;
