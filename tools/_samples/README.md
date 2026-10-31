# tools/_samples —— 接入通道的格式样例（不是真实数据）

这里的三个文件用于验证 `tools/real-cems-ingest.mjs` 的解析与校验逻辑，
**全部是手工构造的格式样例，不是任何真实企业的排放数据**。

| 文件 | 用途 |
| --- | --- |
| `cems-sample.csv` | CSV 模式的列名识别（表头带单位 `排放速率tCO2e/h`） |
| `packet.txt` | HJ 212-2017 报文解析（两个小时的 `01101-Avg` 数据段） |
| `bad.csv` | 反例：时间倒序。用于验证**整批拒绝**而非静默排序 |

复跑：

```bash
node tools/real-cems-ingest.mjs --file tools/_samples/cems-sample.csv --mode=csv --ent-code=TEST --dry-run
node tools/real-cems-ingest.mjs --file tools/_samples/packet.txt  --mode=hj212 --ent-code=TEST --dry-run
node tools/real-cems-ingest.mjs --file tools/_samples/bad.csv     --mode=csv  --ent-code=TEST --dry-run   # 预期失败
```

⚠ 不要把这些文件当作"平台已接入真实数据"的证据。真实接入需要企业提供报文并完成备案，
判定口径见 `tools/out/metrics-ledger.json` 与 `/api/real/truth` 的 `real_cems_batch_count` 声明。
