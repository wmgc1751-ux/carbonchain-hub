# UI 巡检报告（无头 Edge + CDP 实测）

- 生成时间：2026/10/11 13:27:45
- 站点：http://127.0.0.1:8300　链高度：303　累计存证：1126
- 路由渲染：**33/33** 通过
- 关键交互：**5/5** 通过

## 一、路由渲染明细

| # | 角色 | 路由 | 页面 | 结果 | 文本量 | 表格 | 图表 | 控制台异常 |
|---|------|------|------|------|--------|------|------|------------|
| 1 | 公众 | `/login` | 统一登录 | ✅ | 948 | 0 | 0 | 0 |
| 2 | 公众 | `/screen` | 数据公示大屏 | ✅ | 1387 | 0 | 4 | 0 |
| 3 | 公众 | `/explorer` | 区块链浏览器 | ✅ | 3801 | 2 | 0 | 0 |
| 4 | 公众 | `/verify` | 科研验证中心 | ✅ | 983 | 1 | 0 | 0 |
| 5 | 公众 | `/notice/55` | 公告详情 | ✅ | 267 | 0 | 0 | 0 |
| 6 | 公众 | `/explorer/block/1` | 区块详情 | ✅ | 1527 | 1 | 0 | 0 |
| 7 | 公众 | `/explorer/tx/69e3910081d979125535e59467e0bfce7a2ccfcff4da28e012fe786c3de81cd9` | 交易详情（含 Merkle 路径） | ✅ | 1430 | 0 | 0 | 0 |
| 8 | ENTERPRISE | `/ent/overview` | ENT-企业总览 | ✅ | 1023 | 1 | 2 | 0 |
| 9 | ENTERPRISE | `/ent/reports` | ENT-碳排放上报 | ✅ | 1292 | 1 | 0 | 0 |
| 10 | ENTERPRISE | `/ent/dynamic` | ENT-动态核算 | ✅ | 5180 | 4 | 0 | 0 |
| 11 | ENTERPRISE | `/ent/credit` | ENT-碳信用与抵销 | ✅ | 629 | 2 | 0 | 0 |
| 12 | ENTERPRISE | `/ent/quota` | ENT-碳配额账户 | ✅ | 784 | 2 | 0 | 0 |
| 13 | ENTERPRISE | `/ent/trade` | ENT-碳配额交易 | ✅ | 1161 | 2 | 1 | 0 |
| 14 | ENTERPRISE | `/ent/analytics` | ENT-数据分析 | ✅ | 389 | 0 | 4 | 0 |
| 15 | ENTERPRISE | `/ent/wallet` | ENT-链上身份 | ✅ | 1184 | 1 | 0 | 0 |
| 16 | ENTERPRISE | `/ent/notices` | ENT-通知公告 | ✅ | 820 | 1 | 0 | 0 |
| 17 | VERIFIER | `/ver/overview` | VER-核查总览 | ✅ | 887 | 2 | 2 | 0 |
| 18 | VERIFIER | `/ver/tasks` | VER-核查任务 | ✅ | 966 | 1 | 0 | 0 |
| 19 | VERIFIER | `/ver/reports` | VER-核查报告 | ✅ | 1049 | 1 | 0 | 0 |
| 20 | VERIFIER | `/ver/wallet` | VER-机构链上身份 | ✅ | 1031 | 1 | 0 | 0 |
| 21 | VERIFIER | `/ver/notices` | VER-通知公告 | ✅ | 719 | 1 | 0 | 0 |
| 22 | REGULATOR | `/reg/overview` | REG-监管总览 | ✅ | 1817 | 3 | 5 | 0 |
| 23 | REGULATOR | `/reg/enterprises` | REG-企业名录 | ✅ | 1449 | 1 | 0 | 0 |
| 24 | REGULATOR | `/reg/allocations` | REG-配额分配 | ✅ | 1517 | 1 | 0 | 0 |
| 25 | REGULATOR | `/reg/trades` | REG-交易监管 | ✅ | 1841 | 2 | 0 | 0 |
| 26 | REGULATOR | `/reg/dynamic` | REG-动态核算监管 | ✅ | 6786 | 4 | 0 | 0 |
| 27 | REGULATOR | `/reg/credit` | REG-碳资产总览 | ✅ | 3876 | 2 | 0 | 0 |
| 28 | REGULATOR | `/reg/alerts` | REG-预警处置 | ✅ | 1533 | 1 | 0 | 0 |
| 29 | REGULATOR | `/reg/stats` | REG-统计分析 | ✅ | 1452 | 1 | 4 | 0 |
| 30 | REGULATOR | `/reg/logs` | REG-操作日志 | ✅ | 1423 | 1 | 0 | 0 |
| 31 | REGULATOR | `/reg/consortium` | REG-联盟链治理 | ✅ | 2132 | 1 | 0 | 0 |
| 32 | REGULATOR | `/reg/system` | REG-系统设置 | ✅ | 908 | 1 | 0 | 0 |
| 33 | REGULATOR | `/reg/notices` | REG-通知公告 | ✅ | 1062 | 1 | 0 | 0 |

## 二、关键交互

| 交互 | 结果 | 细节 | 截图 |
|------|------|------|------|
| 登录页表单登录 → 跳转企业端 | ✅ | `{"hash":"#/ent/overview","hasToken":true}` | `artifacts\screens\90-登录后企业总览.png` |
| 排放上报 → 行点击打开详情弹窗 | ✅ | `{"click":{"ok":true,"cols":11},"panel":{"open":true,"title":"上报单 ER202610111220313236","textLen":318,"head":"上报单 ER202610111220313236 排放总量 25,448.80 tCO₂e 综合能耗 9,877.18 tce 报告期产值 1,130.41 万元 排放强度 22."}}` | `artifacts\screens\91-上报详情弹窗.png` |
| 区块链浏览器 → 区块详情（含 Merkle 根） | ✅ | `{"click":{"ok":true,"via":"row"},"after":{"hash":"#/explorer/block/304","textLen":827,"err":"","merkle":true,"hashes":16}}` | `artifacts\screens\92-区块详情.png` |
| 监管端预警 → 处置弹窗 | ✅ | `{"click":{"ok":true,"label":"处置"},"panel":{"open":true,"title":"预警处置","textLen":263,"hash":"#/reg/alerts"}}` | `artifacts\screens\93-预警处置弹窗.png` |
| 企业端存证按钮 → 链上核验弹窗（验签 + Merkle 路径） | ✅ | `{"click":{"ok":true,"label":"存证"},"panel":{"open":true,"textLen":991,"readouts":4,"merkle":true,"signed":true,"head":"链上存证核验 · 上报单链上存证核验 · ER202610111220313236 物理电表采集 边缘 TEE 签名 合约核算 机构背书上链 PASS ECDSA 数字签名验签 验签通过 PASS 存证数据摘要比对 一字未改 PASS 链下业务库与链上快照一致 完全一致 PASS"}}` | `artifacts\screens\94-链上存证核验.png` |
