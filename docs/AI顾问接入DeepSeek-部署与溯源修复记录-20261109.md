# AI 顾问接入 DeepSeek · 部署与溯源修复记录（2026-11-09）

> 范围：本地开发环境 + 线上 `www.carbonchain.dpdns.org`（ECS 权威链 Node 服务）。
> 结论：线上已生效（`backend: deepseek:deepseek-flash`），4 类典型问题端到端溯源全通过，
> 对抗测试 9/9 符合预期。修复 4 处真实缺陷，其中 1 处为权限缺陷。
> 回滚备份：ECS `/opt/carbonchain-hub.bak-llm-20261109-210836`。

---

## 一、接入方式（零代码即可接入，但实际修了四处）

架构现状（v3，接入前已就位）：

```
用户提问 → 规则引擎识别意图 → 工具查库（数字唯一来源）
        → 有大模型？→ 工具结果注入 system → 大模型组织语言
        → grounding 数字溯源（逐个回查工具结果）
        → 无模型/全挂 → 规则引擎兜底（服务永不中断）
```

密钥配置两处：

| 位置 | 生效方式 |
| --- | --- |
| 本地 `CarbonChainHub/.env` | `DEEPSEEK_API_KEY=sk-…`；`llmProviders.js` 按文件 mtime 缓存，**改完不用重启** |
| ECS `/opt/carbonchain-hub/.env` | 追加同一段；`systemctl restart carbonchain` 生效 |

**不设 `LLM_PROVIDER`**：保留多服务商故障转移链；DeepSeek 主用，不可用时自动换智谱
`glm-4-flash`，最终兜底规则引擎（2026-11-09 深夜起为双链，见 §六）。

## 二、接入过程中发现并修复的 4 处缺陷

### ① 默认模型名不存在（llmProviders.js:61）

`deepseek-chat` 在当前账号的 `/models` 清单中不存在，实际可用：
`deepseek-flash`（V4.1-Flash，正文直出）与 `deepseek-v4-pro`（推理模型）。
`llm:doctor` 原本就探测并告警过「默认模型不在清单内」——不处理的表现是 AI 永远"不说话"。

修法：注册表默认改为 `deepseek-flash`。**刻意不用 `LLM_MODEL` 环境变量**——它是全局的，
将来接入第二家会把 DeepSeek 的模型名套到别家头上，破坏多服务商链。

### ② 推理模型返回空正文（llmClient.js 三处）

`deepseek-v4-pro` 把输出放 `reasoning_content`、`content` 为空，原代码只读 `content`，
直接报「返回空内容」。补了三处兜底：非流式、非 SSE 降级、SSE 流式。
流式处**先缓存思考流不发射**，正文首字到达即丢弃缓存——否则用户会先看到一段"内心独白"。

### ③ `/api/copilot/ask` 与 `/stream` 没有鉴权中间件（权限缺陷）

`server/routes/copilot.js` 只在 `/config`、`/probe` 上挂了 `authRequired`，`/ask`、`/stream` 裸奔。
后果链：`req.user` 恒为 `undefined` → `carbonCopilot.ask` 里
`if (user.role === 'ENTERPRISE') args.entId = Number(user.orgId)` 永远不走 →
`entId: null` → 工具返回「未指定企业」→ 模型围绕空数据作答。
表象是"AI 一本正经地说没收到平台数据"，看着像模型不行，实际是身份丢了。

修法：新增 `authOptional`（有有效 token 解析身份，无/无效按访客放行 `req.user=null`），
挂到 `/ask`、`/stream`。**刻意不用 `authRequired`**——公网站点 GUEST 角色也要能用 AI 按钮，
强制登录会砍掉访客体验。需要身份才能做的操作仍必须 `authRequired`。

### ④ 数字溯源误报/漏报（grounding.js，三处）

接入后跑 10 个典型问题，溯源告警率 63%，逐条归因后分三类：

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 模型照抄规则引擎原话的「抵销上限 5%」被判无出处 | `pctAllowed` 只收非整数比率，防"`44/12` 的 12 合法化编造 12%"时误伤真实百分比 | 新增 `percentLiteralsOf`：源头**字面带 `%`** 的整数放行，裸整数仍拦截 |
| 库里 `gap:-68873.143`（负数=富余），模型写"富余 68,873.14"被判编造 | 变体集合不含绝对值 | 负值的绝对值进同一变体集；**不做任意符号翻转**（否则"缺口 100 写成富余 100"抓不出） |
| 真实值 293,687.71 被模型写成 293,739.94（差 52 t）被判"四舍五入"放行 | 0.5% 相对容差（±1,468）宽到能藏住真偏差 | 收紧至 0.01%。实测合法舍入记法（整数/1位小数/千分位）仍全部放行 |

配套：提示词收紧（带平台数据时数字只能原样引用、禁止一切推算、
富余/缺口这类派生值必须引用平台结论数字而不是自己再算一遍），
并新增"测试隔离开关 `setIgnoreEnvFile`"——自测用 `delete process.env.X` 模拟无密钥，
挡不住 `readEnv` 回退读 `.env`，开发机一旦填了真 key 就有 6 个用例永远走不到分支。

## 三、验证结果

**离线自测**：`npm run verify:llm` 57/57 项断言（本地与 ECS 均跑过）。
含专项：编造 12%/3%/414.66/9999 全部抓出；源头 5% 放行；真舍入放行。

**线上端到端**（`https://www.carbonchain.dpdns.org/api/copilot/ask`，企业账号 ent_zjbd）：

| 问题 | 工具 | 溯源 | 告警 |
| --- | --- | --- | --- |
| 今年排放缺口多少吨 | enterprise_overview ✅ | 4/4 | 0 |
| 我的配额还够吗 | enterprise_overview ✅ | 4/4 | 0 |
| 原煤的排放因子是多少 | factor_lookup ✅ | 7/7 | 0 |
| EU 碳市场最新价格 | concept_faq ✅ | —（无平台数字） | 0 |

**对抗测试 9/9**：编造 12%/7%/68,900/293,700/9999 全抓出；
真值原样、语义正向（负 gap 写正富余）、源头 5%、千分位舍入全放行。
——确认溯源没有被"为清零告警"而放宽到失效。

## 四、变更清单（未提交，+135/−18 + 文档）

| 文件 | 内容 |
| --- | --- |
| `server/services/llmProviders.js` | 默认模型 `deepseek-flash`；注册表 DeepSeek 排首（主用）；`setIgnoreEnvFile` 隔离开关 |
| `worker/lib/llm.mjs` | 注册表同构同步：`deepseek-flash` + DeepSeek 排首（Worker 未部署，仅保持语义一致） |
| `server/services/llmClient.js` | `reasoning_content` 兜底 ×3；提示词收紧（禁止推算/派生值引用平台结论） |
| `server/services/grounding.js` | `percentLiteralsOf`；负值绝对值互通；容差 0.5%→0.01% |
| `server/middleware/auth.js` | 新增 `authOptional` |
| `server/routes/copilot.js` | `/ask`、`/stream` 挂 `authOptional` |
| `tools/llm-selftest.mjs` | 隔离开关接入；0.25% 近似改写用例预期反转（附事故注记）；新增真舍入用例 |

⚠ `server/routes/auth.js`、`worker/routes/auth.mjs` 的未提交改动**早于本次工作**，与本记录无关。

## 五、线上操作留痕

- ECS 直连：`ssh root@47.86.28.202`（**文档原记"SSH 密钥未解决"已过时**，本机 `id_ed25519` 可直登）
- 备份：`/opt/carbonchain-hub.bak-llm-20261109-210836`（4 个源文件 + 改前 `.env`）
- 上传 7 个文件（统一转 LF）；`.env` 追加密钥段；`systemctl restart carbonchain`
- 回滚：拷回备份目录文件 → 重启即可
- 一处遗留：验证期间的诊断命令在 ECS 留下一个未退出的 `node -e` 进程（DB 连接未关），
  已 kill 并复核 0 残留。**教训：对线上跑 node 脚本必须带 `timeout N` 或显式 `process.exit`。**

## 六、遗留事项

1. ~~**线上单点**~~（2026-11-09 深夜已解决）：接入智谱 `glm-4-flash` 作为第二跳。
   注册表优先级同步调整——**DeepSeek 主用、智谱兜底**（原顺序智谱在前，两家都配 key 后
   会变成免费模型主用、付费模型兜底，与"效果优先"相悖），worker 版注册表同步改齐，
   自测的 mock 指向与断言（链序/熔断对象/流式降级目标家）一并更新。
   线上实测：主用 DeepSeek，`fallbacks: ['智谱 GLM']`，两家 `/models` 探测均可达。
   注意：智谱 `/models` 清单（glm-4.5/4.6/5.3 系）不含 `glm-4-flash`，但该遗留别名
   chat 实测可用（免费额度挂在它上面），doctor 的"默认模型不在清单内"告警属此情形。
2. **密钥轮换**：DeepSeek key 经对话明文传递且已写入两处 `.env`，答辩后建议到
   DeepSeek 控制台轮换；智谱 key 同理。
3. 提示词的「不推算」约束是请求不是约束——真约束在 grounding，且 0.01% 容差下
   模型推算值（如 `362,613.08 − 293,739.94`）只要与平台结论不一致就会被告警标注，属预期行为。
