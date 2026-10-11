# UI 巡检报告（无头 Edge + CDP 实测）

- 生成时间：2026/10/11 22:33:06
- 站点：http://127.0.0.1:8300　链高度：164　累计存证：955
- 路由渲染：**44/44** 通过
- 关键交互：**6/6** 通过

## 一、路由渲染明细

| # | 角色 | 路由 | 页面 | 结果 | 文本量 | 表格 | 图表 | 控制台异常 |
|---|------|------|------|------|--------|------|------|------------|
| 1 | 公众 | `/login` | 统一登录 | ✅ | 958 | 0 | 0 | 0 |
| 2 | 公众 | `/screen` | 数据公示大屏 | ✅ | 1372 | 0 | 4 | 0 |
| 3 | 公众 | `/explorer` | 区块链浏览器 | ✅ | 3806 | 2 | 0 | 0 |
| 4 | 公众 | `/verify` | 科研验证中心 | ✅ | 995 | 1 | 0 | 0 |
| 5 | 公众 | `/cems` | CEMS 实测流监控 | ✅ | 1472 | 0 | 0 | 0 |
| 6 | 公众 | `/matrix` | 碳矩阵工业大盘 | ✅ | 1283 | 1 | 1 | 0 |
| 7 | 公众 | `/notice/55` | 公告详情 | ✅ | 279 | 0 | 0 | 0 |
| 8 | 公众 | `/explorer/block/1` | 区块详情 | ✅ | 1541 | 1 | 0 | 0 |
| 9 | 公众 | `/explorer/tx/d382b2fd3323f7aac9dccba92c1bcedffb60bd25171ed14163f86e482b2712fe` | 交易详情（含 Merkle 路径） | ✅ | 1360 | 0 | 0 | 0 |
| 10 | ENTERPRISE | `/ent/overview` | ENT-企业总览 | ✅ | 1041 | 1 | 2 | 0 |
| 11 | ENTERPRISE | `/ent/reports` | ENT-碳排放上报 | ✅ | 1111 | 1 | 0 | 0 |
| 12 | ENTERPRISE | `/ent/dynamic` | ENT-动态核算 | ✅ | 12034 | 5 | 0 | 0 |
| 13 | ENTERPRISE | `/ent/credit` | ENT-碳信用与抵销 | ✅ | 647 | 2 | 0 | 0 |
| 14 | ENTERPRISE | `/ent/quota` | ENT-碳配额账户 | ✅ | 802 | 2 | 0 | 0 |
| 15 | ENTERPRISE | `/ent/trade` | ENT-碳配额交易 | ✅ | 1051 | 2 | 1 | 0 |
| 16 | ENTERPRISE | `/ent/analytics` | ENT-数据分析 | ✅ | 407 | 0 | 4 | 0 |
| 17 | ENTERPRISE | `/ent/wallet` | ENT-链上身份 | ✅ | 1054 | 1 | 0 | 0 |
| 18 | ENTERPRISE | `/ent/notices` | ENT-通知公告 | ✅ | 838 | 1 | 0 | 0 |
| 19 | VERIFIER | `/ver/overview` | VER-核查总览 | ✅ | 895 | 2 | 2 | 0 |
| 20 | VERIFIER | `/ver/tasks` | VER-核查任务 | ✅ | 974 | 1 | 0 | 0 |
| 21 | VERIFIER | `/ver/reports` | VER-核查报告 | ✅ | 1057 | 1 | 0 | 0 |
| 22 | VERIFIER | `/ver/wallet` | VER-机构链上身份 | ✅ | 1039 | 1 | 0 | 0 |
| 23 | VERIFIER | `/ver/notices` | VER-通知公告 | ✅ | 727 | 1 | 0 | 0 |
| 24 | REGULATOR | `/reg/overview` | REG-监管总览 | ✅ | 1834 | 3 | 5 | 0 |
| 25 | REGULATOR | `/reg/enterprises` | REG-企业名录 | ✅ | 1474 | 1 | 0 | 0 |
| 26 | REGULATOR | `/reg/allocations` | REG-配额分配 | ✅ | 1518 | 1 | 0 | 0 |
| 27 | REGULATOR | `/reg/trades` | REG-交易监管 | ✅ | 1866 | 2 | 0 | 0 |
| 28 | REGULATOR | `/reg/dynamic` | REG-动态核算监管 | ✅ | 11167 | 4 | 0 | 0 |
| 29 | REGULATOR | `/reg/credit` | REG-碳资产总览 | ✅ | 3901 | 2 | 0 | 0 |
| 30 | REGULATOR | `/reg/alerts` | REG-预警处置 | ✅ | 1547 | 1 | 0 | 0 |
| 31 | REGULATOR | `/reg/stats` | REG-统计分析 | ✅ | 1477 | 1 | 4 | 0 |
| 32 | REGULATOR | `/reg/logs` | REG-操作日志 | ✅ | 1560 | 1 | 0 | 0 |
| 33 | REGULATOR | `/reg/consortium` | REG-联盟链治理 | ✅ | 2178 | 1 | 0 | 0 |
| 34 | REGULATOR | `/reg/system` | REG-系统设置 | ✅ | 929 | 1 | 0 | 0 |
| 35 | REGULATOR | `/reg/notices` | REG-通知公告 | ✅ | 1087 | 1 | 0 | 0 |
| 36 | ADMIN | `/matrix` | 登录态-admin-碳矩阵工业大盘 | ✅ | 1284 | 1 | 1 | 0 |
| 37 | REGULATOR | `/matrix` | 登录态-reg001-碳矩阵工业大盘 | ✅ | 1284 | 1 | 1 | 0 |
| 38 | ENTERPRISE | `/matrix` | 登录态-ent001-碳矩阵工业大盘 | ✅ | 1284 | 1 | 1 | 0 |
| 39 | ENTERPRISE | `/matrix` | 登录态-ent002-碳矩阵工业大盘 | ✅ | 1284 | 1 | 1 | 0 |
| 40 | ENTERPRISE | `/matrix` | 登录态-ent003-碳矩阵工业大盘 | ✅ | 1284 | 1 | 1 | 0 |
| 41 | VERIFIER | `/matrix` | 登录态-ver001-碳矩阵工业大盘 | ✅ | 1284 | 1 | 1 | 0 |
| 42 | VERIFIER | `/matrix` | 登录态-ver002-碳矩阵工业大盘 | ✅ | 1284 | 1 | 1 | 0 |
| 43 | ADMIN | `/ops` | 登录态-admin-生产运维监控 | ✅ | 4987 | 0 | 1 | 0 |
| 44 | REGULATOR | `/ops` | 登录态-reg001-生产运维监控 | ✅ | 4951 | 0 | 1 | 0 |

## 二、关键交互与可进入性

| 交互 | 结果 | 细节 | 截图 |
|------|------|------|------|
| 菜单可达性穷举（各角色侧边栏每一项都须进得去） | ✅ | `{"roles":["ENTERPRISE","VERIFIER","REGULATOR","ADMIN"],"entries":56,"broken":[],"anonBroken":[],"totalRoutes":37}` | — |
| 登录页表单登录 → 跳转企业端 | ✅ | `{"hash":"#/ent/overview","hasToken":true}` | `artifacts\screens\90-登录后企业总览.png` |
| 排放上报 → 行点击打开详情弹窗 | ✅ | `{"click":{"ok":true,"cols":11},"panel":{"open":true,"title":"上报单 ER202610112231193941","textLen":316,"head":"上报单 ER202610112231193941 排放总量 26,073.86 tCO₂e 综合能耗 10,134.43 tce 报告期产值 3,617.32 万元 排放强度 7."}}` | `artifacts\screens\91-上报详情弹窗.png` |
| 区块链浏览器 → 区块详情（含 Merkle 根） | ✅ | `{"click":{"ok":true,"via":"row"},"after":{"hash":"#/explorer/block/165","textLen":836,"err":"","merkle":true,"hashes":16}}` | `artifacts\screens\92-区块详情.png` |
| 监管端预警 → 处置弹窗 | ✅ | `{"click":{"ok":true,"label":"处置"},"panel":{"open":true,"title":"预警处置","textLen":263,"hash":"#/reg/alerts"}}` | `artifacts\screens\93-预警处置弹窗.png` |
| 企业端存证按钮 → 链上核验弹窗（验签 + Merkle 路径） | ✅ | `{"click":{"ok":true,"label":"存证"},"panel":{"open":true,"textLen":993,"readouts":4,"merkle":true,"signed":true,"head":"链上存证核验 · 上报单链上存证核验 · ER202610112231193941 物理电表采集 边缘 TEE 签名 合约核算 机构背书上链 PASS ECDSA 数字签名验签 验签通过 PASS 存证数据摘要比对 一字未改 PASS 链下业务库与链上快照一致 完全一致 PASS"}}` | `artifacts\screens\94-链上存证核验.png` |
