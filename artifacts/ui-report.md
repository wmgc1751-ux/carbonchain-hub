# UI 巡检报告（无头 Edge + CDP 实测）

- 生成时间：2026/10/11 02:53:11
- 站点：http://127.0.0.1:8300　链高度：250　累计存证：1041
- 路由渲染：**32/32** 通过
- 关键交互：**5/5** 通过

## 一、路由渲染明细

| # | 角色 | 路由 | 页面 | 结果 | 文本量 | 表格 | 图表 | 控制台异常 |
|---|------|------|------|------|--------|------|------|------------|
| 1 | 公众 | `/login` | 统一登录 | ✅ | 941 | 0 | 0 | 0 |
| 2 | 公众 | `/screen` | 数据公示大屏 | ✅ | 1379 | 0 | 4 | 0 |
| 3 | 公众 | `/explorer` | 区块链浏览器 | ✅ | 2298 | 1 | 0 | 0 |
| 4 | 公众 | `/notice/55` | 公告详情 | ✅ | 260 | 0 | 0 | 0 |
| 5 | 公众 | `/explorer/block/1` | 区块详情 | ✅ | 1522 | 1 | 0 | 0 |
| 6 | 公众 | `/explorer/tx/add15fac95dd5ebc1069036530a43f599e6327a87580c060a7fea0cf593ec8e4` | 交易详情（含 Merkle 路径） | ✅ | 1060 | 0 | 0 | 0 |
| 7 | ENTERPRISE | `/ent/overview` | ENT-企业总览 | ✅ | 1016 | 1 | 2 | 0 |
| 8 | ENTERPRISE | `/ent/reports` | ENT-碳排放上报 | ✅ | 990 | 1 | 0 | 0 |
| 9 | ENTERPRISE | `/ent/dynamic` | ENT-动态核算 | ✅ | 727 | 1 | 0 | 0 |
| 10 | ENTERPRISE | `/ent/credit` | ENT-碳信用与抵销 | ✅ | 622 | 2 | 0 | 0 |
| 11 | ENTERPRISE | `/ent/quota` | ENT-碳配额账户 | ✅ | 777 | 2 | 0 | 0 |
| 12 | ENTERPRISE | `/ent/trade` | ENT-碳配额交易 | ✅ | 962 | 2 | 1 | 0 |
| 13 | ENTERPRISE | `/ent/analytics` | ENT-数据分析 | ✅ | 382 | 0 | 4 | 0 |
| 14 | ENTERPRISE | `/ent/wallet` | ENT-链上身份 | ✅ | 955 | 1 | 0 | 0 |
| 15 | ENTERPRISE | `/ent/notices` | ENT-通知公告 | ✅ | 813 | 1 | 0 | 0 |
| 16 | VERIFIER | `/ver/overview` | VER-核查总览 | ✅ | 880 | 2 | 2 | 0 |
| 17 | VERIFIER | `/ver/tasks` | VER-核查任务 | ✅ | 959 | 1 | 0 | 0 |
| 18 | VERIFIER | `/ver/reports` | VER-核查报告 | ✅ | 1042 | 1 | 0 | 0 |
| 19 | VERIFIER | `/ver/wallet` | VER-机构链上身份 | ✅ | 1024 | 1 | 0 | 0 |
| 20 | VERIFIER | `/ver/notices` | VER-通知公告 | ✅ | 712 | 1 | 0 | 0 |
| 21 | REGULATOR | `/reg/overview` | REG-监管总览 | ✅ | 1802 | 3 | 5 | 0 |
| 22 | REGULATOR | `/reg/enterprises` | REG-企业名录 | ✅ | 1442 | 1 | 0 | 0 |
| 23 | REGULATOR | `/reg/allocations` | REG-配额分配 | ✅ | 1476 | 1 | 0 | 0 |
| 24 | REGULATOR | `/reg/trades` | REG-交易监管 | ✅ | 1834 | 2 | 0 | 0 |
| 25 | REGULATOR | `/reg/dynamic` | REG-动态核算监管 | ✅ | 760 | 1 | 0 | 0 |
| 26 | REGULATOR | `/reg/credit` | REG-碳资产总览 | ✅ | 3869 | 2 | 0 | 0 |
| 27 | REGULATOR | `/reg/alerts` | REG-预警处置 | ✅ | 1515 | 1 | 0 | 0 |
| 28 | REGULATOR | `/reg/stats` | REG-统计分析 | ✅ | 1445 | 1 | 4 | 0 |
| 29 | REGULATOR | `/reg/logs` | REG-操作日志 | ✅ | 1420 | 1 | 0 | 0 |
| 30 | REGULATOR | `/reg/consortium` | REG-联盟链治理 | ✅ | 1056 | 1 | 0 | 0 |
| 31 | REGULATOR | `/reg/system` | REG-系统设置 | ✅ | 903 | 1 | 0 | 0 |
| 32 | REGULATOR | `/reg/notices` | REG-通知公告 | ✅ | 1055 | 1 | 0 | 0 |

## 二、关键交互

| 交互 | 结果 | 细节 | 截图 |
|------|------|------|------|
| 登录页表单登录 → 跳转企业端 | ✅ | `{"hash":"#/ent/overview","hasToken":true}` | `artifacts\screens\90-登录后企业总览.png` |
| 排放上报 → 行点击打开详情弹窗 | ✅ | `{"click":{"ok":true,"cols":11},"panel":{"open":true,"title":"上报单 ER2026020001","textLen":375,"head":"上报单 ER2026020001 排放总量 3,870.83 tCO₂e 综合能耗 1,688.25 tce 报告期产值 3,682.43 万元 排放强度 1.0512 t/万元 "}}` | `artifacts\screens\91-上报详情弹窗.png` |
| 区块链浏览器 → 区块详情（含 Merkle 根） | ✅ | `{"click":{"ok":true,"via":"row"},"after":{"hash":"#/explorer/block/251","textLen":817,"err":"","merkle":true,"hashes":16}}` | `artifacts\screens\92-区块详情.png` |
| 监管端预警 → 处置弹窗 | ✅ | `{"click":{"ok":true,"label":"处置"},"panel":{"open":true,"title":"预警处置","textLen":263,"hash":"#/reg/alerts"}}` | `artifacts\screens\93-预警处置弹窗.png` |
| 企业端存证按钮 → 链上核验弹窗（验签 + Merkle 路径） | ✅ | `{"click":{"ok":true,"label":"存证"},"panel":{"open":true,"textLen":1028,"readouts":7,"merkle":true,"signed":true,"head":"链上存证核验 · 上报单链上存证核验 · ER2026020001 物理电表采集 边缘 TEE 签名 合约核算 机构背书上链 PASS ECDSA 数字签名验签 验签通过 PASS 存证数据摘要比对 一字未改 PASS 链下业务库与链上快照一致 完全一致 PASS Merkle "}}` | `artifacts\screens\94-链上存证核验.png` |
