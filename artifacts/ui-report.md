# UI 巡检报告（无头 Edge + CDP 实测）

- 生成时间：2026/9/17 23:35:53
- 站点：http://127.0.0.1:8300　链高度：161　累计存证：918
- 路由渲染：**27/27** 通过
- 关键交互：**5/5** 通过

## 一、路由渲染明细

| # | 角色 | 路由 | 页面 | 结果 | 文本量 | 表格 | 图表 | 控制台异常 |
|---|------|------|------|------|--------|------|------|------------|
| 1 | 公众 | `/login` | 统一登录 | ✅ | 733 | 0 | 0 | 0 |
| 2 | 公众 | `/screen` | 数据公示大屏 | ✅ | 1300 | 0 | 4 | 0 |
| 3 | 公众 | `/explorer` | 区块链浏览器 | ✅ | 2381 | 1 | 0 | 0 |
| 4 | 公众 | `/notice/40` | 公告详情 | ✅ | 260 | 0 | 0 | 0 |
| 5 | 公众 | `/explorer/block/1` | 区块详情 | ✅ | 1377 | 1 | 0 | 0 |
| 6 | 公众 | `/explorer/tx/9673959bda4a09f1ec2af02971b19d61fed70c38b17f2b2642857ce40cf91b28` | 交易详情（含 Merkle 路径） | ✅ | 1341 | 0 | 0 | 0 |
| 7 | ENTERPRISE | `/ent/overview` | ENT-企业总览 | ✅ | 986 | 1 | 2 | 0 |
| 8 | ENTERPRISE | `/ent/reports` | ENT-碳排放上报 | ✅ | 1271 | 1 | 0 | 0 |
| 9 | ENTERPRISE | `/ent/quota` | ENT-碳配额账户 | ✅ | 765 | 2 | 0 | 0 |
| 10 | ENTERPRISE | `/ent/trade` | ENT-碳配额交易 | ✅ | 1207 | 2 | 1 | 0 |
| 11 | ENTERPRISE | `/ent/analytics` | ENT-数据分析 | ✅ | 368 | 0 | 4 | 0 |
| 12 | ENTERPRISE | `/ent/wallet` | ENT-链上身份 | ✅ | 1167 | 1 | 0 | 0 |
| 13 | ENTERPRISE | `/ent/notices` | ENT-通知公告 | ✅ | 783 | 1 | 0 | 0 |
| 14 | VERIFIER | `/ver/overview` | VER-核查总览 | ✅ | 877 | 2 | 2 | 0 |
| 15 | VERIFIER | `/ver/tasks` | VER-核查任务 | ✅ | 961 | 1 | 0 | 0 |
| 16 | VERIFIER | `/ver/reports` | VER-核查报告 | ✅ | 1044 | 1 | 0 | 0 |
| 17 | VERIFIER | `/ver/wallet` | VER-机构链上身份 | ✅ | 1026 | 1 | 0 | 0 |
| 18 | VERIFIER | `/ver/notices` | VER-通知公告 | ✅ | 696 | 1 | 0 | 0 |
| 19 | REGULATOR | `/reg/overview` | REG-监管总览 | ✅ | 1681 | 3 | 5 | 0 |
| 20 | REGULATOR | `/reg/enterprises` | REG-企业名录 | ✅ | 1424 | 1 | 0 | 0 |
| 21 | REGULATOR | `/reg/allocations` | REG-配额分配 | ✅ | 1501 | 1 | 0 | 0 |
| 22 | REGULATOR | `/reg/trades` | REG-交易监管 | ✅ | 1812 | 2 | 0 | 0 |
| 23 | REGULATOR | `/reg/alerts` | REG-预警处置 | ✅ | 1287 | 1 | 0 | 0 |
| 24 | REGULATOR | `/reg/stats` | REG-统计分析 | ✅ | 1424 | 1 | 4 | 0 |
| 25 | REGULATOR | `/reg/logs` | REG-操作日志 | ✅ | 1508 | 1 | 0 | 0 |
| 26 | REGULATOR | `/reg/system` | REG-系统设置 | ✅ | 875 | 1 | 0 | 0 |
| 27 | REGULATOR | `/reg/notices` | REG-通知公告 | ✅ | 1032 | 1 | 0 | 0 |

## 二、关键交互

| 交互 | 结果 | 细节 | 截图 |
|------|------|------|------|
| 登录页表单登录 → 跳转企业端 | ✅ | `{"hash":"#/ent/overview","hasToken":true}` | `artifacts\screens\90-登录后企业总览.png` |
| 排放上报 → 行点击打开详情弹窗 | ✅ | `{"click":{"ok":true,"cols":11},"panel":{"open":true,"title":"上报单 ER202609172334297256","textLen":310,"head":"上报单 ER202609172334297256 排放总量 25,604.45tCO₂e 综合能耗 9,941.24tce 报告期产值 904.33万元 排放强度 28.3132t"}}` | `artifacts\screens\91-上报详情弹窗.png` |
| 区块链浏览器 → 区块详情（含 Merkle 根） | ✅ | `{"click":{"ok":true,"via":"row"},"after":{"hash":"#/explorer/block/161","textLen":767,"err":"","merkle":true,"hashes":16}}` | `artifacts\screens\92-区块详情.png` |
| 监管端预警 → 处置弹窗 | ✅ | `{"click":{"ok":true,"label":"处置"},"panel":{"open":true,"title":"预警处置","textLen":162,"hash":"#/reg/alerts"}}` | `artifacts\screens\93-预警处置弹窗.png` |
| 企业端存证按钮 → 链上核验弹窗（验签 + Merkle 路径） | ✅ | `{"click":{"ok":true,"label":"存证"},"panel":{"open":true,"textLen":967,"readouts":4,"merkle":true,"signed":true,"head":"链上存证核验 · 上报单链上存证核验 · ER202609172334297256 PASS ECDSA 数字签名验签 验签通过 PASS 存证数据摘要比对 一字未改 PASS 链下业务库与链上快照一致 完全一致 PASS Merkle 根与区块头一致 一致 存证交易 交易号 2"}}` | `artifacts\screens\94-链上存证核验.png` |
