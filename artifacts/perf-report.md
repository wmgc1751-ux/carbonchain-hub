# 接口性能采样

- 采样时间：2026/9/17 23:34:43
- 站点：http://127.0.0.1:8300　每接口 15 次（已预热 1 次）

| 接口 | 说明 | 平均 | 中位 | P95 | 最快 | 最慢 |
| --- | --- | --- | --- | --- | --- | --- |
| `/health` | 健康检查（含链高度查询） | 3.0 ms | 3 ms | 4 ms | 2 ms | 4 ms |
| `/public/dashboard` | 公示大屏聚合数据 | 11.1 ms | 11 ms | 15 ms | 8 ms | 15 ms |
| `/chain/blocks?page=1&size=10` | 区块列表 | 3.1 ms | 3 ms | 5 ms | 2 ms | 5 ms |
| `/chain/txs?page=1&size=10` | 交易列表 | 3.3 ms | 3 ms | 5 ms | 2 ms | 5 ms |
| `/chain/validate` | 全链完整性校验（155 区块 900+ 交易） | 31.4 ms | 31 ms | 37 ms | 25 ms | 37 ms |
| `/enterprise/overview` | 企业总览 | 4.6 ms | 5 ms | 6 ms | 3 ms | 6 ms |
| `/enterprise/reports?page=1&size=10` | 企业上报单分页 | 1.7 ms | 2 ms | 2 ms | 1 ms | 2 ms |
| `/enterprise/analytics` | 企业碳数据分析 | 2.9 ms | 3 ms | 3 ms | 2 ms | 3 ms |
| `/regulator/overview` | 监管总览 | 9.9 ms | 10 ms | 13 ms | 8 ms | 13 ms |
| `/regulator/statistics` | 监管统计分析 | 10.5 ms | 11 ms | 13 ms | 8 ms | 13 ms |
