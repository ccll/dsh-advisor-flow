---
doc-type: rationale
mutation: append-only
id: C-007
owner: agent
---

# C-007 全面放弃 dsh-advisor 谱系借鉴，门控与送达对齐 pi-advisor-flow 0.8.1

日期: 2026-09-24

#### 上下文
东家试用了宿主上的 dsh-advisor 0.4.1（omdsh-dev）后认定其实现不佳，明确指示全面放弃对该插件的任何借鉴，向移植源头 pi-advisor-flow 对齐。此前移植版混用了两套来源：pi 的自由文本意见 + 门控清单，与 dsh-advisor 的 severity 三级（nit/concern/blocker）、severity→inject/steer 分流、immuneTurns 冷却、`[advisor:{severity}]` 消息格式、咨询失败三分类（重试/暂停/停机）与门策略三值（review/ask/block）。staging 实弹验证期间 pi-advisor-flow 0.8.1 源码核对确认：其原生模型与本版实现存在结构性差异，混搭没有保留价值。

#### 决策
全面退役 dsh-advisor 谱系元素，行为模型对齐 pi-advisor-flow 0.8.1：意见无严重度分级（按需咨询协议为「完全无问题时首行 `Verdict: sound`」二值约定）；唯一硬门为循环门，顾问回复以 `Decision: proceed|revise|blocked` 首行裁定，处置按全局 `failureMode`（warn-and-continue / block-tool / block-session，含会话封锁）执行；咨询失败无重试，直接按阻断模式处置；plan/failure/completion 三门降为注入执行者系统提示的行为守则（`ctx.systemPrompt.section` 实时求值）；门结果一律 steer 送达（`**Decision: X**` + 全文），无冷却；人工审批通道删除。

#### 被否方案及原因
- 保留混搭（severity + 门策略 + pi 决策行并存）：两套处置模型语义重叠且互相冲突（severity 分级在 Decision 协议下无消费方），维护双模型只增复杂度。
- 仅换消息格式保留门策略：东家已对 dsh-advisor 的实现质量作出否定裁决，其「策略+严重度」组合正是被否定的核心，格式对齐而模型保留会延续同一缺陷。

#### 影响面
R-01-003 / R-01-004 / R-01-006 / 执行者守则；R-01-005 / 门控服务（T-010）
