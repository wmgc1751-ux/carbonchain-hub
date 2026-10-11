# 碳链通 CarbonChain Hub —— 界面功能与接口测试 / Bug 报告

| 项目 | 内容 |
| --- | --- |
| 被测系统 | 碳链通 CarbonChain Hub（联盟链碳资产动态核算可信存证平台） |
| 版本 / 提交 | `2307cac`（2026-10-11 `fix(router): 收敛路由权限为单一来源，修复 /matrix 与 /ops 死链`） |
| 测试环境 | 本地开发态，`http://127.0.0.1:8300`，Node v22.22.2，MySQL 8（`127.0.0.1:3306`），`NODE_ENV=development` |
| 链状态 | 高度 377 · 共识 POA · 联盟授权节点 5 · 演示账号接口开放 |
| 测试账号 | ent001/ent002/ent003（企业）· ver001/ver002（核查）· reg001/admin（监管）· 口令 `123456`（admin 为 `admin123`） |
| 测试方式 | ① 真实 UI 交互（无头 Edge + CDP 驱动）；② 接口层功能/边界/越权探测；③ 复用项目既有 `smoke-test.js`/`browser-check.js` 基线 |
| 测试时间 | 2026-10-11 21:30–21:45 |
| 结论 | **基线全绿，但深度功能/越权测试发现 8 类缺陷（4 个高危、4 个中危）**，集中在**后端接口的参数校验与鉴权**；前端 UI 交互层 7/7 正常。**→ 8 类缺陷已于当日晚间全部修复并回归通过（见第七节）**。 |

> 复现脚本：`_probe_bug.js`（接口层，31 项，自带测试数据自清理）、`_probe_ui.js`（UI 交互层，7 项）。两者可直接 `node` 运行回归。

---

## 一、测试执行概览

| 测试层 | 用例数 | 通过 | 失败 | 说明 |
| --- | --- | --- | --- | --- |
| 接口冒烟（既有 `smoke-test.js`） | 50 | 50 | 0 | 全接口连通性正常 |
| UI 渲染巡检（既有 `browser-check.js`） | 44 路由 + 6 交互 | 44 + 6 | 0 | 页面渲染、菜单可达性正常 |
| **接口功能/边界/越权探测**（本次新增） | 31 | 15 | **16** | 见下方缺陷清单 |
| **UI 真实交互回归**（本次新增） | 7 | 7 | 0 | 登录提示、超额下单、预警闭环、防篡改、筛选、分页均正常 |

---

## 二、缺陷清单

### 🔴 BUG-01【高危 · 阻断上线】联盟链副本同步/脱链写接口未鉴权，匿名可篡改联盟链治理状态

- **模块**：联盟链治理（`server/routes/consortium.js`）
- **前半条件**：无需登录；服务已启动
- **复现步骤**：
  1. 不携带任何 token，`POST /api/consortium/nodes/node-verifier-01/desync`（body `{}`）→ 匿名让节点副本"落后"；
  2. 匿名 `POST /api/consortium/sync` → 触发全部节点副本同步；
  3. 匿名 `POST /api/consortium/nodes/1/sync`。
- **实际结果**：三步均返回 `HTTP 200 / code 0`，功能真实生效（返回"已完成 5 个节点的副本同步"）。
- **期望结果**：均返回 `401`（未登录）。
- **根因**：`consortium.js` 仅在 `approve`/`revoke` 上挂了 `authRequired + requireRole('REGULATOR')`，而 `sync`、`nodes/:nodeId/sync`、`nodes/:nodeId/desync` 三个**写接口**完全未挂鉴权中间件——这与该文件头部注释"写接口需监管角色"自相矛盾。
- **影响范围**：任何能访问服务端口的匿名方，均可随意让联盟节点副本脱链/追平，破坏"多方各持链副本、一致性可核验"这一核心可信叙事；答辩/公网演示场景下后果尤为严重。
- **建议修复**：为上述三个路由统一挂载 `authRequired, requireRole('REGULATOR')`；`POST /nodes/apply` 若需保留公开申请能力（注释称"无需审批即可提交"），至少补充限流与审计。

### 🔴 BUG-02【高危 · 阻断上线】运维监控读接口未鉴权，匿名可读取内部结构化日志

- **模块**：生产运维监控（`server/routes/ops.js`）
- **复现步骤**：匿名 `GET /api/ops/logs`、`GET /api/ops/metrics`、`GET /api/ops/stats`、`GET /api/ops/alerts`、`GET /api/ops/canary`。
- **实际结果**：全部 `HTTP 200`。其中 `/api/ops/logs` 匿名返回约 100 条内部日志（含请求方法、路径、状态码、耗时等）；`/metrics` 返回 Prometheus 指标全量。
- **期望结果**：应 `401`（或仅对 REGULATOR/ADMIN 开放）。
- **根因**：`ops.js` 中只有 `POST /canary` 挂了 `authRequired`，五个 GET 读接口均无鉴权。前端 `/ops` 页面虽已限制角色，但接口层未设防——"前端藏起来"不等于"访问不了"。
- **影响范围**：内部运行信息、接口拓扑、流量特征外泄，为攻击者提供侦察素材（信息泄露类，等保测评项）。
- **建议修复**：运维读接口统一鉴权重灾区（REGULATOR/ADMIN）；若确需给 Prometheus 抓取，改用独立内网端口 + 抓取令牌。

### 🔴 BUG-03【高危 · 阻断上线】企业碳排放上报缺关键参数校验，可写入"负排放"并上链

- **模块**：企业端上报（`server/routes/enterprise.js` → `POST /api/enterprise/reports`）
- **前置条件**：以 ent001 登录取得 token
- **复现步骤**（可任选）：
  1. `items:[{energyType:'原煤', amount:-1000}]` → 负消耗量；
  2. `items:[{energyType:'电力', amount:0}]` → 零值；
  3. `items:[{energyType:'电力', amount:'abc'}]` → 非数字；
  4. `quarter:99` → 季度越界；
  5. `year:1800` → 年度不合理。
- **实际结果**：全部 `HTTP 200 code 0 草稿已保存`；负数量直接算出 **-1900.3 tCO₂e 的"负排放"**；非数字被静默当作 0；季度 99、年度 1800 均成功入库。
- **期望结果**：服务端应校验 `amount` 为有限正数、`quarter ∈ {1,2,3,4}`、`year` 在合理区间，非法值返回 `400` 并给出字段级提示。
- **根因**：`enterprise.js` 仅校验 `year/quarter` 非空与 `items` 非空，循环中 `const amount = Number(it.amount) || 0`——`Number('-1000')` 直接进入计算，非数字则被 `|| 0` 兜成 0，全程无正数/范围校验。
- **影响范围**：平台核心承诺是"碳排放数据可信不可篡改"，却允许把**负排放**写入业务库并（在 `submit:true` 时）签名上链，直接颠覆数据可信性叙事。**注**：前端上报表单在提交前用 `filter(Number(amount)>0)` 静默丢弃了非正数行，故该缺陷**仅接口层可达**；但接口是信任边界，仍须服务端封堵。
- **建议修复**：服务端补齐字段校验（金额>0 且 `Number.isFinite`、季度枚举、年度区间），并将前端"静默丢弃"改为明确报错提示。

### 🔴 BUG-04【高危 · 阻断上线】数据库内部错误信息泄露给客户端

- **模块**：企业端上报（`server/routes/enterprise.js`）+ 全局错误处理（`server/app.js`）
- **复现步骤**：`POST /api/enterprise/reports`，`quarter:"abc"`。
- **实际结果**：`HTTP 500`，`message` 为 `Incorrect integer value: 'abc' for column 'quarter' at row 1`——**泄露了表列名 `quarter` 与字段类型**。
- **期望结果**：返回统一的可读提示（如"季度参数不合法"），不暴露数据库结构。
- **根因**：入参未做类型前置校验，`quarter` 原样进入 SQL 由 MySQL 强转报错；`app.js` 的全局错误处理虽已对 body-parser 解析错误做了收敛，但业务层 `err.message` 仍被原样回显。
- **影响范围**：为攻击者推断库表结构提供便利；同时属语义错误的 500（见 BUG-05）。
- **建议修复**：与 BUG-03 一并做入参前置校验；全局错误处理对"非预期异常"统一返回泛化文案，细节仅落服务端日志。

### 🟠 BUG-05【中危】业务规则校验类错误统一返回 HTTP 500（语义错误、污染监控）

- **模块**：交易撮合（`server/services/trade.js`）、联盟链治理（`consortium.js`）
- **复现步骤**：触发以下任一业务拒绝——委托价格≤0、委托数量≤0、卖出超可用配额、撤销他人委托单、对不存在节点 sync。
- **实际结果**：一律 `HTTP 500 / code 500`（消息本身正确，如"可用配额不足…"）。
- **期望结果**：业务规则校验失败应返回 `400`（资源不存在类应 `404`）。
- **对照**：碳信用抵销接口（`routes/credit.js`）在同样场景下**正确返回 400**——说明这是实现不一致，而非有意设计。
- **根因**：`trade.js`/`consortium.js` 用 `throw new Error(...)` 表达业务校验失败，经 `wrap` 落到全局错误处理 `fail(res, err.message, err.status || 500)`，未区分业务异常与系统异常。
- **影响范围**：① 前端虽能展示正确提示，但 HTTP 语义错误；② 运维监控把这类"正常业务拒绝"计入 `errorCount/errorRate`，会误触 `/api/ops/alerts` 的错误率告警，干扰真实故障识别。
- **建议修复**：约定业务异常类型（如 `BizError{status}`），`wrap`/错误处理按 status 返回 4xx；或各 service 抛带 `status` 的错误。

### 🟠 BUG-06【中危】对"不存在的节点"执行 desync 返回成功（静默空操作）

- **模块**：联盟链治理（`services/consortium.js#desyncNode`）
- **复现步骤**：`POST /api/consortium/nodes/999999/desync`。
- **实际结果**：`HTTP 200`，提示"已模拟节点 999999 的链副本落后到高度 #3"，**实际未做任何操作**（节点不存在）。
- **期望结果**：应 `404 节点不存在`。
- **根因**：`desyncNode` 未做节点存在性校验，直接对不存在的 `node_id` 执行 DELETE/UPDATE（受影响行数为 0）后即返回"成功"。
- **影响范围**：误导性成功反馈，掩盖误用与故障；演示时若输入错误节点号，会给出"已完成"的假象。
- **建议修复**：进入前先 `SELECT` 校验节点存在，不存在则抛 404。

### 🟠 BUG-07【中危】`sync` 对不存在节点返回 500；且 `sync`/`desync` 节点标识契约不一致

- **模块**：联盟链治理（`services/consortium.js`、`routes/consortium.js`）
- **复现步骤**：`POST /api/consortium/nodes/999999/sync`。
- **实际结果**：`HTTP 500 节点不存在`。
- **期望结果**：应 `404`。
- **契约不一致**：`sync`/`desync` 的 `:nodeId` 期望的是**字符串标识**（如 `node-verifier-01`）；但 `desync` 传数字 id（如 `2`）也不报错（见 BUG-06），而 `sync` 传数字 id 则直接 500。两个对称接口的标识语义与错误处理不一致，极易误用。
- **建议修复**：统一 `:nodeId` 语义（建议统一为字符串标识），并对不存在节点统一返回 404。

### 🟠 BUG-08【中危 · 已按产品口径处置】核查机构可读取任意企业 CEMS 数据；任意登录用户可写入 CEMS/触发重算

- **模块**：动态核算（`server/routes/dynamic.js`）
- **复现步骤 A**：以 ver001 登录，`GET /api/dynamic/readings?entId=1`。
  - **实际**：`HTTP 200`，返回"邢台纸业有限公司"48 条 CEMS 实时读数。
- **复现步骤 B**：以 ver001 登录，`POST /api/dynamic/ingest`（写入 CEMS 实测读数）、`POST /api/dynamic/recompute`。
  - **实际**：均 `HTTP 200`——**核查机构 token 可向系统写入 660 条 CEMS 读数**；匿名访问为 401。
- **处置结论（产品口径）**：
  - **读（`readings`）**：核查机构需跨企业核验，**与监管端同级、全量可见**（企业端仍锁定本企业）。→ 按此实现，非缺陷。
  - **写（`ingest`/`recompute`）**：采数为全局操作、重算为核算动作，**收敛为监管/管理角色**（企业仅可重算本企业）。
- **根因**：写接口原仅 `authRequired`，未做角色控制。
- **影响范围**：实测数据写入接口此前对任意登录角色开放。

---

## 三、观察项（非缺陷，供确认）

| 编号 | 级别 | 内容 | 说明 |
| --- | --- | --- | --- |
| OBS-01 | 低 | `authRequired` 支持从 URL query（`?token=`）取令牌 | `middleware/auth.js`。令牌可能随 URL 进入访问日志/Referer，建议仅接受 `Authorization` 头。 |
| OBS-02 | 低 | 开发态 `JWT_SECRET` 使用内置默认值（仅告警不阻断） | 启动日志已明示；生产/云平台由 `assertSecureConfig()` 拒绝启动，设计合理，上线前配置即可。 |
| OBS-03 | 低 | 前端表单对非法数值"静默丢弃"而非提示 | 上报表单 `filter(Number(amount)>0)` 会把用户输入的非正数行悄悄剔除；若用户只填一行非法值，仅得到"请至少填写一项能源消耗数据"的模糊提示。建议改为显式字段报错。 |
| OBS-04 | — | 公告标题/正文的 SQL/XSS 特征输入被安全入库 | 接口层参数化查询与前端（无 `v-html`，Vue 默认转义）均未复现注入，**非缺陷**，已验证。 |

---

## 四、回归测试清单（修复后须复测）

1. **鉴权回归（BUG-01/02）**：匿名逐一对 `POST /api/consortium/{sync,nodes/:id/sync,nodes/:id/desync}`、`GET /api/ops/{logs,metrics,stats,alerts,canary}` 断言返回 `401`；以 REGULATOR 登录断言 `200`。
2. **上报校验回归（BUG-03/04）**：对 `amount` 取 `-1/0/'abc'/1e309`、`quarter` 取 `0/5/99/'abc'`、`year` 取 `1800/99999`，断言均 `400` 且提示不含库表字段名。
3. **状态码语义回归（BUG-05）**：交易 `价格≤0/数量≤0/超额卖出/撤他人单`、`sync 不存在节点`，断言返回 `4xx` 而非 `500`。
4. **联盟链治理回归（BUG-06/07）**：对不存在节点 `sync`/`desync`，断言 `404`；对存在节点（字符串标识）断言 `200`。
5. **动态核算权限回归（BUG-08）**：以 ver001 访问非在办企业 `readings`、调用 `ingest/recompute`，按确认后的预期断言 403/200。
6. **既有基线回归**：重跑 `node scripts/smoke-test.js`（50 例）与 `node scripts/browser-check.js`（44 路由 + 6 交互），确保无新增回归。

---

## 五、附录：测试用例与执行结果

### A. 接口功能/边界/越权（`_probe_bug.js`）

| # | 用例 | 结果 | 备注 |
| --- | --- | --- | --- |
| 1 | 上报消耗量 = -1000 | ❌ | 生成 -1900.3 tCO₂e 负排放 → BUG-03 |
| 2 | 上报消耗量 = 0 | ❌ | 成功入库 → BUG-03 |
| 3 | 上报能源类型非法 | ✅ | 正确 400 |
| 4 | 上报季度 = 99 | ❌ | 成功入库 → BUG-03 |
| 5 | 上报季度 = "abc" | ❌ | 500 且泄露列名 → BUG-04 |
| 6 | 上报年度 = 1800 | ❌ | 成功入库 → BUG-03 |
| 7 | 上报消耗量 = "abc" | ❌ | 静默变 0 → BUG-03 |
| 8 | 企业 token 访问监管接口 | ✅ | 403 |
| 9 | 核查 token 读企业1 CEMS | ❌ | 越权读取 → BUG-08 |
| 10 | 匿名读 /api/ops/logs | ❌ | 泄露日志 → BUG-02 |
| 11 | 匿名触发联盟链全量同步 | ❌ | 未鉴权写 → BUG-01 |
| 12 | 对不存在节点 desync | ❌ | 假成功 → BUG-06 |
| 13 | 对不存在节点 sync | ❌ | 500 应 404 → BUG-07 |
| 14–17 | 交易：超额卖出 / 价≤0 / 量≤0 / 撤他人单 | ⚠️ | 均 500，消息正确 → BUG-05 |
| 18 | 下发配额 = -5000 | ✅ | 400 |
| 19 | 下发配额至 2099 年度 | ✅ | 记录用 |
| 20–24 | 分页参数 `0/-3/100000/abc/999999` | ✅ | `db.paginate` 健壮，无 5xx |
| 25 | 公告含 SQL/XSS 特征 | ✅ | 安全入库，无注入 |
| 26–30 | 委托价≤0 / 量≤0 / 超额 / 撤他人 / sync 不存在节点 | ❌ | 均 500 → BUG-05 |
| 31 | 上报季度 = "abc"（状态码语义） | ❌ | 500 且泄露 DB 信息 → BUG-04+G6 |

### B. UI 真实交互（`_probe_ui.js`）

| # | 场景 | 结果 | 观察 |
| --- | --- | --- | --- |
| U1 | 登录页错误口令 | ✅ | 停留登录页并显示行内提示"账号或密码错误" |
| U2 | 交易卖出数量远超可用配额 | ✅ | 弹出"可用配额不足…"，页面不崩溃 |
| U3 | 监管预警 → 完成闭环 | ✅ | 弹窗打开 → 提交 → "预警已关闭" → 弹窗关闭 |
| U4 | 防篡改实验台：篡改 → 修复 | ✅ | 篡改后校验失败并出现修复按钮；修复后"全链完整性校验通过" |
| U5 | 企业名录按"纸业"筛选 | ✅ | 12 行 → 3 行，均为含"纸业"企业 |
| U6 | 企业名录筛选不存在关键字 | ✅ | 0 行并展示空态 |
| U7 | 企业名录翻页 | ✅ | 首行随页码变化 |

---

## 六、总体评价与建议

- **前端 UI 交互层质量良好**：登录反馈、表单校验提示、弹窗交互、防篡改可视化、筛选与分页均符合预期，未发现界面级缺陷。
- **风险集中于后端"信任边界"**：本次全部高危缺陷都源于**接口层鉴权缺失与入参校验缺失**——即"前端做了防护、后端没有兜底"。对于以"可信"为核心卖点的区块链平台，这类问题优先级最高。
- **建议修复顺序**：BUG-01、BUG-02（未鉴权写/读，安全）→ BUG-03、BUG-04（数据可信 + 信息泄露）→ BUG-05、BUG-06、BUG-07（健壮性与可维护性）→ BUG-08（需产品确认）。
- **流程建议**：将上述 6 条回归清单固化为 `scripts/` 下的用例；并在 CI 中接入 `smoke-test.js` 与 `browser-check.js`，把"接口越权用例"纳入提测门槛。

---

## 七、修复与回归验证（2026-10-11 21:55 更新）

> 状态：**8 类缺陷已全部处置并验证通过**。其中 BUG-08 的读可见范围按产品口径确认为**核查/监管全量可见**（企业锁定本企业），写操作收敛为监管（企业可重算自身）。共改动 7 个后端文件 + 2 个前端文件。

| 缺陷 | 状态 | 修复要点 | 改动文件 |
| --- | --- | --- | --- |
| BUG-01 联盟链写接口未鉴权 | ✅ 已修复 | `sync`/`nodes/:id/sync`/`nodes/:id/desync` 统一挂 `authRequired, requireRole('REGULATOR')`；同步更新文件头注释 | `server/routes/consortium.js` |
| BUG-02 运维读接口未鉴权 | ✅ 已修复 | 整个 `/api/ops` 路由级挂 `authRequired, requireRole('REGULATOR')`；前端 `/ops` 取数补 `Authorization` 头 | `server/routes/ops.js`、`public/js/views/ops.js` |
| BUG-03 上报缺参数校验 | ✅ 已修复 | 服务端校验 `amount>0 且有限`、`quarter∈{1,2,3,4}`、`year∈[2000,2100]`，非法值返 400 | `server/routes/enterprise.js` |
| BUG-04 库结构信息泄露 | ✅ 已修复 | 前置入参校验杜绝类型错；全局错误处理对 5xx 统一泛化文案，细节仅落日志 | `server/app.js`、`server/routes/enterprise.js` |
| BUG-05 业务错误返 500 | ✅ 已修复 | 服务层引入 `bizError(msg,status)`，业务拒绝带 4xx 状态码 | `server/services/trade.js`、`server/services/consortium.js` |
| BUG-06 desync 假成功 | ✅ 已修复 | `desyncNode` 增加节点存在性校验（404）与 `keepHeight` 数字校验 | `server/services/consortium.js` |
| BUG-07 sync 返 500 / 标识不一致 | ✅ 已修复 | `syncNode` 不存在节点返 404；sync/desync 统一以字符串 `node_id` 为契约 | `server/services/consortium.js` |
| BUG-08 动态核算越权 | ✅ 已处置 | 读：核查/监管**全量可见**（企业锁定本企业）；写：`ingest` 限监管、`recompute` 限企业(自身)/监管；企业端隐藏"采集"按钮 | `server/routes/dynamic.js`、`public/js/views/dynamic.js` |
| OBS-01 令牌可经 URL 传递 | ⏸ 保留 | 属兼容特性，未纳入本次修复范围 | — |

### 回归验证结果（修复后）

| 测试 | 修复前 | 修复后 | 结论 |
| --- | --- | --- | --- |
| 接口探针 `_probe_bug.js` | 16 项异常 | **0 项**（32/32 通过） | ✅ 全部消除 |
| UI 交互 `_probe_ui.js` | 7/7 | **7/7** | ✅ 无回归 |
| 接口冒烟 `scripts/smoke-test.js` | 50/50 | **50/50** | ✅ 无回归 |
| 全站巡检 `scripts/browser-check.js` | 44 路由 + 6 交互 | **44/44 + 6/6** | ✅ 无回归（`/ops` 带令牌取数正常） |

**定向确认**（修复后实测）：

```
HTTP 401  匿名 GET  /api/ops/logs            HTTP 200  监管 GET  /api/ops/logs
HTTP 401  匿名 POST /api/consortium/sync     HTTP 200  监管 POST /api/consortium/sync
HTTP 404  监管 desync 一个不存在的节点
HTTP 403  核查 POST /api/dynamic/ingest      HTTP 200  监管 POST /api/dynamic/ingest
HTTP 200  企业 POST /api/dynamic/recompute（仅本企业）
```

