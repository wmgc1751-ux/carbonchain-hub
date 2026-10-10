# 接口性能采样

- 采样时间：2026/10/10 22:47:45
- 站点：http://127.0.0.1:8300　每接口 20 次（已预热 1 次）

| 接口 | 说明 | 平均 | 中位 | P95 | 最快 | 最慢 |
| --- | --- | --- | --- | --- | --- | --- |
| `/health` | 健康检查（含链高度查询） | 3.7 ms | 3 ms | 16 ms | 2 ms | 16 ms |
| `/public/dashboard` | 公示大屏聚合数据 | 9.0 ms | 9 ms | 12 ms | 7 ms | 12 ms |
| `/chain/blocks?page=1&size=10` | 区块列表 | 2.5 ms | 2 ms | 6 ms | 2 ms | 6 ms |
| `/chain/txs?page=1&size=10` | 交易列表 | 2.4 ms | 2 ms | 3 ms | 2 ms | 3 ms |
| `/chain/validate` | 全链完整性校验（含 PoA 签名逐块验签） | 54.4 ms | 53 ms | 79 ms | 49 ms | 79 ms |
| `/enterprise/overview` | 企业总览 | 4.5 ms | 4 ms | 6 ms | 3 ms | 6 ms |
| `/enterprise/reports?page=1&size=10` | 企业上报单分页 | 1.6 ms | 2 ms | 3 ms | 1 ms | 3 ms |
| `/enterprise/analytics` | 企业碳数据分析 | 3.2 ms | 3 ms | 7 ms | 2 ms | 7 ms |
| `/regulator/overview` | 监管总览 | 9.7 ms | 9 ms | 18 ms | 8 ms | 18 ms |
| `/regulator/statistics` | 监管统计分析 | 12.6 ms | 12 ms | 19 ms | 9 ms | 19 ms |
