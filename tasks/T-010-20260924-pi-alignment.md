---
doc-type: task
mutation: lifecycle
id: T-010
---
# 门控与送达模型对齐 pi-advisor-flow 0.8.1

状态: active
关联: R-01-003、R-01-004、R-01-005、R-01-006、R-01-001、R-02-001、R-02-005（C-007 决策包）
风险等级: high

## 背景与目标

东家裁定全面放弃 dsh-advisor 谱系借鉴，向移植源头 pi-advisor-flow（0.8.1，2026-09-24 npm latest）对齐（C-007）。map 已演进（PRD/DOMAIN/SOLUTION/RATIONALE 同步完成，本提交落地）。目标：severity 三级、inject/steer severity 分流、immuneTurns、[advisor:{severity}] 格式、门策略 review/ask/block、approval 人工审批缝、咨询失败三分类（重试/暂停/停机）全部退役；唯一硬门为循环门（Decision: proceed|revise|blocked 三值决策 + failureMode 统一处置 + 会话封锁），plan/failure/completion 三门降为 systemPrompt 守则。

## 差距评估

- lib/gates/：plan.js/failure.js/judges.js 承载已退役的三门判定——删除；loop 判定并入门控服务重写。
- lib/consultation.js：severity 解析（parseAdvice 的 severity 声明行）、retryAttempts 重试、quota/pause/halt 运行态——全部退役；新增 Decision 行对抗性解析（重复/矛盾/围栏逃逸，移植 pi gate-protocol）与 ADVISOR_DECISION_SYSTEM 门协议提示词；ask_advisor 系统提示补 Verdict: sound 协议（pi ADVISOR_SYSTEM 对齐）。
- lib/delivery.js：severity→inject/steer 分流与 immuneTurns——退役；改为门结果一律 steer（**Decision: X** + 全文）。
- lib/index.js：approval/approvals 审批缝、agent/turn-stopping 监听——删除；新增 systemPrompt 条件子上下文（守则 section）。
- lib/config.js：gates.plan|failure|completion 改布尔、gates.loop 只留 enabled/threshold、新增 failureMode、删除 retryAttempts 与各门 policy（旧键经未知键警告保留）。
- lib/guidelines.js 新建：三类守则文本（pi advisorInvocationGuidelines 对齐）+ systemPrompt.section 注册。
- lib/status.js、lib/commands.js：门状态展示改守则开关 + 循环门配置 + 阻断模式。
- lib/client/*：设置卡门矩阵 UI 重做（三布尔 + 循环门阈值 + failureMode 下拉）。
- 旧 stopSession 缝升级为会话封锁语义（block-session 下 agents.cancel + 后续调用全拦截）。

## 收敛方案

- 咨询服务双协议：`consult()`（ask_advisor，Verdict 协议系统提示）与 `consultGate()`（循环门，Decision 协议系统提示）；决策解析器独立模块（`parseDecision`：首非空行 Decision 匹配、重复/矛盾判失败、围栏内决策行不采信、未闭合围栏 fail-closed）。
- 门控服务：handlePreExecute 保留载体守卫与循环计数；命中即同步 consultGate，处置矩阵 proceed/revise/blocked×failureMode；咨询失败类别（provider-error/empty-response/missing-decision/malformed-decision/duplicate-decision/contradictory-decision/budget-exhausted）按阻断模式处置。
- 会话封锁：每会话封锁标记 + agents.cancel 尽力停止；封锁态下 pre-execute 一律 deny(封锁原因)。
- 执行者守则：systemPrompt.section 文本函数按活配置生成（全关返回空串）；守则文案与 pi advisorInvocationGuidelines 逐条对齐。
- 送达：门结果一律 agent.steer；文本 = `**Decision: X**\n\n{markdown}`（adviceForGateText 语义）。
- 未知旧配置键警告保留透传；failureMode 默认 warn-and-continue。

## 测试计划

- `node --test` 全量绿（守则 section 求值、Decision 解析对抗用例、处置矩阵×failureMode、会话封锁、无 severity 断言）；测试锚定迁移模式生效（CONVENTIONS migration T-010），实现收敛后切回 strict 再关闭本 task。
- staging 实弹复验（af-verify profile）：循环门 Decision 三值处置 + 守则注入可见 + ask_advisor 往返。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：循环门 Decision 三值处置与守则注入 | `test/gates.test.js::真实宿主形状回归`、`test/ask-advisor.test.js::R-01-001/AC-01` |
| 异常 | 适用：决策行失败类别与阻断模式处置 | `test/gates.test.js::R-02-005/AC-02 门组件抛错` |
| 边界配置 | 适用：旧配置键保留、守则全关、预算耗尽 | `test/config.test.js::R-02-001/AC-02` |
| 副作用 | 适用：会话封锁状态与送达文本契约 | `test/delivery.test.js::R-01-003/AC-03 消息形态` |

## 终态与证据

（执行中）
