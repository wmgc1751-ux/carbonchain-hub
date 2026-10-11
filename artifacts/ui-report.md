# UI 巡检报告（无头 Edge + CDP 实测）

- 生成时间：2026/10/11 15:29:24
- 站点：http://127.0.0.1:8300　链高度：306　累计存证：1129
- 路由渲染：**34/34** 通过
- 关键交互：**5/5** 通过

## 一、路由渲染明细

| # | 角色 | 路由 | 页面 | 结果 | 文本量 | 表格 | 图表 | 控制台异常 |
|---|------|------|------|------|--------|------|------|------------|
| 1 | 公众 | `/login` | 统一登录 | ✅ | 956 | 0 | 0 | 0 |
| 2 | 公众 | `/screen` | 数据公示大屏 | ✅ | 1401 | 0 | 4 | 0 |
| 3 | 公众 | `/explorer` | 区块链浏览器 | ✅ | 3813 | 2 | 0 | 0 |
| 4 | 公众 | `/verify` | 科研验证中心 | ✅ | 991 | 1 | 0 | 0 |
| 5 | 公众 | `/cems` | CEMS 实测流监控 | ✅ | 1468 | 0 | 0 | 0 |
| 6 | 公众 | `/notice/55` | 公告详情 | ✅ | 275 | 0 | 0 | 0 |
| 7 | 公众 | `/explorer/block/1` | 区块详情 | ✅ | 1535 | 1 | 0 | 0 |
| 8 | 公众 | `/explorer/tx/008c1965452c9c4bc16be1c056ae8b06b2b58023947844ce99bc534d8223cfca` | 交易详情（含 Merkle 路径） | ✅ | 1340 | 0 | 0 | 0 |
| 9 | ENTERPRISE | `/ent/overview` | ENT-企业总览 | ✅ | 1033 | 1 | 2 | 0 |
| 10 | ENTERPRISE | `/ent/reports` | ENT-碳排放上报 | ✅ | 1302 | 1 | 0 | 0 |
| 11 | ENTERPRISE | `/ent/dynamic` | ENT-动态核算 | ✅ | 5190 | 4 | 0 | 0 |
| 12 | ENTERPRISE | `/ent/credit` | ENT-碳信用与抵销 | ✅ | 639 | 2 | 0 | 0 |
| 13 | ENTERPRISE | `/ent/quota` | ENT-碳配额账户 | ✅ | 794 | 2 | 0 | 0 |
| 14 | ENTERPRISE | `/ent/trade` | ENT-碳配额交易 | ✅ | 1171 | 2 | 1 | 0 |
| 15 | ENTERPRISE | `/ent/analytics` | ENT-数据分析 | ✅ | 399 | 0 | 4 | 0 |
| 16 | ENTERPRISE | `/ent/wallet` | ENT-链上身份 | ✅ | 1194 | 1 | 0 | 0 |
| 17 | ENTERPRISE | `/ent/notices` | ENT-通知公告 | ✅ | 830 | 1 | 0 | 0 |
| 18 | VERIFIER | `/ver/overview` | VER-核查总览 | ✅ | 887 | 2 | 2 | 0 |
| 19 | VERIFIER | `/ver/tasks` | VER-核查任务 | ✅ | 966 | 1 | 0 | 0 |
| 20 | VERIFIER | `/ver/reports` | VER-核查报告 | ✅ | 1049 | 1 | 0 | 0 |
| 21 | VERIFIER | `/ver/wallet` | VER-机构链上身份 | ✅ | 1031 | 1 | 0 | 0 |
| 22 | VERIFIER | `/ver/notices` | VER-通知公告 | ✅ | 719 | 1 | 0 | 0 |
| 23 | REGULATOR | `/reg/overview` | REG-监管总览 | ✅ | 1827 | 3 | 5 | 0 |
| 24 | REGULATOR | `/reg/enterprises` | REG-企业名录 | ✅ | 1459 | 1 | 0 | 0 |
| 25 | REGULATOR | `/reg/allocations` | REG-配额分配 | ✅ | 1527 | 1 | 0 | 0 |
| 26 | REGULATOR | `/reg/trades` | REG-交易监管 | ✅ | 1851 | 2 | 0 | 0 |
| 27 | REGULATOR | `/reg/dynamic` | REG-动态核算监管 | ✅ | 6796 | 4 | 0 | 0 |
| 28 | REGULATOR | `/reg/credit` | REG-碳资产总览 | ✅ | 3886 | 2 | 0 | 0 |
| 29 | REGULATOR | `/reg/alerts` | REG-预警处置 | ✅ | 1543 | 1 | 0 | 0 |
| 30 | REGULATOR | `/reg/stats` | REG-统计分析 | ✅ | 1462 | 1 | 4 | 0 |
| 31 | REGULATOR | `/reg/logs` | REG-操作日志 | ✅ | 1433 | 1 | 0 | 0 |
| 32 | REGULATOR | `/reg/consortium` | REG-联盟链治理 | ✅ | 2164 | 1 | 0 | 0 |
| 33 | REGULATOR | `/reg/system` | REG-系统设置 | ✅ | 918 | 1 | 0 | 0 |
| 34 | REGULATOR | `/reg/notices` | REG-通知公告 | ✅ | 1072 | 1 | 0 | 0 |

## 二、关键交互

| 交互 | 结果 | 细节 | 截图 |
|------|------|------|------|
| 登录页表单登录 → 跳转企业端 | ✅ | `{"hash":"#/ent/overview","hasToken":true}` | `artifacts\screens\90-登录后企业总览.png` |
| 排放上报 → 行点击打开详情弹窗 | ✅ | `{"click":{"ok":true,"cols":11},"panel":{"open":true,"title":"上报单 ER202610111220313236","textLen":318,"head":"上报单 ER202610111220313236 排放总量 25,448.80 tCO₂e 综合能耗 9,877.18 tce 报告期产值 1,130.41 万元 排放强度 22."}}` | `artifacts\screens\91-上报详情弹窗.png` |
| 区块链浏览器 → 区块详情（含 Merkle 根） | ✅ | `{"click":{"ok":true,"via":"row"},"after":{"hash":"#/explorer/block/307","textLen":832,"err":"","merkle":true,"hashes":16}}` | `artifacts\screens\92-区块详情.png` |
| 监管端预警 → 处置弹窗 | ✅ | `{"click":{"ok":true,"label":"处置"},"panel":{"open":true,"title":"预警处置","textLen":263,"hash":"#/reg/alerts"}}` | `artifacts\screens\93-预警处置弹窗.png` |
| 企业端存证按钮 → 链上核验弹窗（验签 + Merkle 路径） | ✅ | `{"click":{"ok":true,"label":"存证"},"panel":{"open":true,"textLen":991,"readouts":4,"merkle":true,"signed":true,"head":"链上存证核验 · 上报单链上存证核验 · ER202610111220313236 物理电表采集 边缘 TEE 签名 合约核算 机构背书上链 PASS ECDSA 数字签名验签 验签通过 PASS 存证数据摘要比对 一字未改 PASS 链下业务库与链上快照一致 完全一致 PASS"}}` | `artifacts\screens\94-链上存证核验.png` |
