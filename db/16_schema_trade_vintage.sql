-- 16: trade_order.vintage_year —— 成交年度遵循委托 vintage（2026-10-30）
--
-- 缺陷：委托单不保存配额 vintage，成交时 executeDeal 用
--   「买卖双方配额账户交集，偏好当前年」重算交割年度。2026 年挂单买/卖
-- 2025 年配额时，双方都有 2026 账户 → 交割落在 2026，卖方在 2025 冻结的
-- 配额无法解冻交割（「卖方配额冻结不足」），撮合整批饿死。
-- 修复：下单时把 placeOrder 解析出的年度落库到 vintage_year；
--   交割年度优先取委托 vintage，双方均无标记时回退旧交集逻辑。
ALTER TABLE trade_order
  ADD COLUMN vintage_year INT NULL COMMENT '配额 vintage（履约年度），成交交割以此为准' AFTER mandate_id;
