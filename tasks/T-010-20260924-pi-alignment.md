---
doc-type: task
mutation: lifecycle
id: T-010
---
# 门控与送达模型对齐 pi-advisor-flow 0.8.1

状态: completed
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
| 成功 | 适用：循环门 Decision 三值处置与守则注入 | `test/gates.test.js::R-01-005/AC-01 真实宿主形状回归：同参三次等价调用，第 3 次执行前拦截并触发咨询`、`test/ask-advisor.test.js::R-01-001/AC-01` |
| 异常 | 适用：决策行失败类别与阻断模式处置 | `test/gates.test.js::R-02-005/AC-02 门组件抛错：按放行处置该次工具调用并记录错误，不悬挂` |
| 边界配置 | 适用：旧配置键保留、守则全关、预算耗尽 | `test/config.test.js::R-02-001/AC-02 未知键收集为警告并保留透传（含旧键 policy 与 retryAttempts），不阻断其他配置生效` |
| 副作用 | 适用：会话封锁状态与送达文本契约 | `test/delivery.test.js::R-01-005/AC-03 送达通道抛错被包含：steerAdvice 不外抛、返回 false` |

## 终态与证据

- 实现: 门控与送达模型对齐 pi-advisor-flow 0.8.1（C-007）——① Decision 行对抗性解析器（lib/decision.js，重复/矛盾/围栏逃逸 fail-closed，移植 pi gate-protocol 逐行等价）；② 循环门单门重写（命中同步咨询 → proceed steer 送达+重置计数+放行 / revise steer+deny 全文 / blocked×failureMode 三分支，block-session 会话封锁 + agents.cancel 尽力停止 + 后续调用全拦截）；③ 双协议咨询（Verdict 按需 / Decision 循环门；去 severity/重试/pause/halt）；④ 送达一律 steerAdvice（无 severity 分流无冷却）；⑤ 执行者守则经 systemPrompt.section 实时求值注入；⑥ 预算执行（budget.maxPerSession，gate 入口超限带 budget-exhausted 类别）；⑦ 配置面 g gates 三布尔 + loop.threshold + failureMode（旧键警告保留）；⑧ 设置卡门矩阵重做。
- 测试: `npm test` 178/178 全绿（新建 decision 7 用例、guidelines 8 用例，gates/consultation/index/delivery/config 全面重写为 pi 模型）；`python3 tools/agentmap_lint.py --report` 全绿（test-anchored 29/29、strict 模式恢复）；staging 实弹三轮（af-verify profile）：Decision: revise 实弹命中（25s 咨询 + 门结果 steer 送达 + 拦截 + 意见全文作拒绝理由）、失败通告可见送达（missing-decision → warn-and-continue 通知后放行）、ask_advisor 意见文本 + adviceId 回查行、守则 section 注入。
- SOLUTION 对照: 门控服务（仅循环门）/执行者守则（新模块）/意见送达（一律 steer）/咨询服务（双协议 + 无重试）/产品契约（failureMode + Decision 消息格式）——与实现逐模块对照一致；PRD/DOMAIN 已随 C-007 演进；map-code 无漂移。
- 已知边界: bash 非零退出在宿主契约 isError:false（失败门语义已随守则化退役，仅循环门硬拦）；决策协议服从性非 100%（staging 实测一次 missing-decision → 对抗解析归类 + 阻断模式兜底放行，符合设计）；设置卡浏览器实测未做（DOM 桩 24 用例 + 产物新鲜度守卫覆盖，留生产日常验证）。
- commit: 4364b6d
- commit: 46550a2
- commit: 3c9e38b
- commit: 4dc9ec8
- commit: cfa0278
- commit: bae1f51
- commit: f063caf
- commit: acbaa03
- commit: 7f5ea89
- commit: e664aae
- commit: 29d3ea3
- review:
  - 审核方: 双轴独立评审子代理（Standards 轴、Spec 轴，code-review skill 流程；T-010 全量评审一轮 + 双轴修复复审一轮 + 终确认二轮）
  - 目的理解: 本 task 目标是按 C-007 全面退役 dsh-advisor 谱系并把门控/送达/解析对齐 pi-advisor-flow 0.8.1 原生模型；reviewer 需核验 pi 协议逐行等价（Decision 解析对抗性、failureMode 处置矩阵、守则文案）、SOLUTION 同步无漂移、staging 实测发现均有回归钉或显性记录
  - 执行方式: code-review skill 双轴子代理按轮评审；评审基线 716bcd8..e664aae（首轮全量）→ e664aae..0375c43（修复回归锚定轮）→ f51087f..29d3ea3（终审三轮）
  - 问题与修复: 首轮双轴命中高危二——压缩/重写路径调用已删除的 delivery.reset（TypeError）与引擎禁用态缺前置守卫（block-session 可误封会话）；中危四项——blocked×warn-and-continue 计数口径与 pi/取舍声明矛盾、队列满冒充 budget-exhausted 且 budget.maxPerSession 无执行点（AC-04 落空）、SOLUTION callTimeoutMs 表述失真、诊断码/头注漂移；全部修复（enabled 前置守卫、blocked 不重置计数、预算执行落地 ADVISOR_BUDGET_EXHAUSTED + budget-exhausted 类别、失败通告 steer 可见、SOLUTION/注释口径收敛、类别清单与阈值常量单点化）；施工与修复期的测试/卡片重做由测试子代理承载（173/173），实现方修复后 178/178。
  - 复审结论: 三轮评审递进收敛（终审二轮「复审通过，无残余发现」）。
- commit: cfa0278
- commit: bae1f51
- commit: e664aae
- commit: 7f5ea89
- commit: 0375c43
- commit: 29d3ea3