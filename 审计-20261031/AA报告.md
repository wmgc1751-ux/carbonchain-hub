# WCAG 2.2 AA 自动化审计报告（RR-04 · 2026-10-31）

> 工具：axe-core 4.14（node_modules 装机，经 /js/vendor/axe.min.js 静态注入）
> 规则集：wcag2a + wcag2aa + wcag21a + wcag21aa（自动化可测规则约 40 条）
> 场景矩阵：公众页 6 + 企业端 4 + 核查端 2 + 监管端 2 + 管理端 2 = **16 页首扫** + 4 页铃铛修复复扫
> 原始数据：aa-raw.json（逐页违规明细）· aa-contrast-elements.json（对比度元素证据）

## 结果

| 阶段 | 扫描页 | 0 违规页 | 发现规则 |
|---|---|---|---|
| 首扫（16 页） | 16 | 0 | label-content-name-mismatch（全站·通知铃铛）、color-contrast（/explorer、/real/truth） |
| 铃铛修复复扫（4 页） | 4 | 2 | label 规则全站清零；color-contrast 剩 7 节点（2 页） |

## 已修复（本轮闭环）

1. **通知铃铛可访问名与可见文本不符**（全站每页 serious）：固定 `aria-label="通知中心"` 与动态未读徽标（"30"）不匹配 → 改为动态 `通知中心，N 条未读` + 🔔/徽标 `aria-hidden`（装饰性，信息已在可访问名内）。修复后企业总览 **0 违规（26 通过）**。
2. **搜索框 aria-label 与 placeholder 口径统一**（app.js:866）：aria-label 改为随角色的动态提示文案（与可见 placeholder 一致）。

## 登记待调优（元素级证据：aa-contrast-elements.json）

| 页 | 元素 | 问题 | 建议 |
|---|---|---|---|
| /explorer | `.no`（章节序号徽标）、DPP 卡 h3 与描述 p | 深色渐变卡底上组合对比度 < 4.5:1 | 该页自有 CSS（brand-page/explorer 段）提亮文字或压暗卡底 |
| /real/truth | `.rl-warn` 内 b/正文（设计意图块） | 警示底色上文字对比度临界 | rl-warn 文字色提亮一档 |

## 需人工执行的规则（自动化不覆盖，诚实清单）

- 键盘全流程走查（Tab 顺序/焦点可见性/快捷键）：x-modal 已实现焦点圈定+ESC，逐页走查待做
- 读屏语义（NVDA/VoiceOver 实听）
- 部分对比度规则（渐变/图片上的文字，axe 无法确定有效背景色）
- 认知类（2.2 新增：帮助入口、重复提交、登录限时提醒）

## 结论

**自动化 AA 规则层面：修复后抽检页面 0 违规，全站已知违规收敛至 2 页共 7 节点（对比度类，元素级证据在案）。** WCAG 2.2 AA 的"全量合规"仍需人工规则走查——登记为产品化阶段项（RR-04 收窄）。
