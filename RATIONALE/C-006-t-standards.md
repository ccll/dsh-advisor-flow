---
doc-type: rationale
mutation: append-only
id: C-006
owner: agent
---

# C-006 T-002 终态审核覆盖的更正与 Standards 轴追认

日期: 2026-09-22

#### 上下文
T-002 终态 review 块曾把 Standards 轴在各实现轮中的在飞核验表述为该轴对 T-002 的签收；advisor 指出后，主责 agent 试图直接修改终态文件，被 lint 的终态不可变校验机械否决。更正改由本决策承载，并取得 Standards 轴代理的显式 ack。

#### 决策
T-002 迁移成果的审核 = Standards 轴在 T-001 终确认、T-003 与 T-004 各轮复审中的在飞锚点真实性核验（空格锚点改正发生于 T-001 修复轮，具体提交可经 T-001 终态证据反查）+ lint 机械校验（test-anchored 30/30、warnings 清零，收口前独立复跑实证）。Standards 轴未对 T-002 单独出具终审；主责 agent 据此归并关闭成立，无需本轴专项终审追认。Standards 轴 ack 已取得，其要旨即上述决策语句本身（含对 T-001 修复轮的具体指向）。

#### 被否方案及原因
- 直接修改终态任务文件：被 AgentMap lint 的终态不可变校验拒绝——机械门禁优先于口头授权，例外不成立。
- 为一条更正重开双轴全流程：与更正的量级不成比例。

#### 影响面
T-002（审计链更正）
