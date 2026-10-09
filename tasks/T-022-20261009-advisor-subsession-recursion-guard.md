---
doc-type: task
mutation: lifecycle
id: T-022
---
# T-022 收口评审顾问子会话递归守卫（R-01-009/AC-05、R-02-007）

风险等级: standard
状态: active
关联: R-01-009/AC-05、R-02-007/AC-01

## 背景与目标

2026-10-09 20:36 东家在 docsim 会话实测 `/advisor-manual`，顾问子会话链嵌套至深度 9（`delegationDepth: 9`，20:41 强行终止宿主时仍在生成）。会话日志取证结论：

- 每层嵌套都是收口评审（`entry: 'turn-review'`）经子会话呈现发起新顾问子会话。
  - 证据：第 2 层问句为 `Targeted focus: Advisor turn review…`。
  - 证据：其 `<conversation>` 引用上一层顾问意见全文。
- 顾问子会话内 `ask_advisor` 不可调用。
  - 证据：第 8 层 `request/header` 仅 `list_subagent_models` 与 `subagent` 两工具。
  - 证据：`toolFilter={allow:[]}` 生效。
  - 结论：递归驱动者是宿主侧 `agent/turn-stopping` 全局监听，不是模型工具调用。
- `lib/turn-review.js` 处置器对每个会话的收口发起评审。
  - 无顾问子会话豁免。
  - 无深度上限。
  - 每个新子会话的首次收口绕过同回合去重（新 session id、新 turn）。
  - 结果：评审—呈现—再收口的无界深度优先递归。
- 伴生漂移：`subsessionLabel` 仅映射 `tool|manual|gate` 三态。
  - `turn-review` 落默认值，显示为 `Advisor review (tool)`，掩盖真实入口。
  - `SOLUTION.md` 子会话呈现语义已承诺四态标签（实现漂移）。

目标：顾问子会话的回合收口不再触发收口评审（R-01-009/AC-05 评审对象是执行者回合）；标签如实标识 `turn-review` 入口。

## 差距评估

- `lib/turn-review.js` `handleTurnStopping`：无会话来源豁免——顾问子会话收口被评审，评审本身又生成子会话（递归根因）。
- `lib/subsession.js` `createSubsessionPresenter`：无呈现登记缝，处置器无法识别本插件发出的子会话。
- `lib/subsession.js` `subsessionLabel`：三态映射，`turn-review` 误标 `tool`（与 SOLUTION 子会话呈现语义承诺的四态不符）。
- `lib/index.js`：无豁免判定源注入；`session/disposed` 清理缺登记表项。

## 收敛方案

- `lib/subsession.js` `subsessionLabel` 增加 `turn-review` 态。
- `lib/subsession.js` `createSubsessionPresenter` 增加 `onPresented(subsessionId)` 登记缝。
  - 发布成功即调用（result 结算前）。
  - 调用异常被包含，不影响呈现。
  - 发布前失败不调用。
- `lib/turn-review.js` `createTurnReview` 增加 `isAdvisorSubsession(sessionId)` 前置豁免。
  - 命中即跳过评审并留痕（skipped 计数）。
  - 判定位于预算核查之前。
- `lib/index.js`：
  - 插件持 `advisorSubsessions` 登记表。
  - 呈现缝 `onPresented` 登记。
  - `session/disposed` 清理登记。
  - 处置器注入 `isAdvisorSubsession` 判定。
- `SOLUTION.md` 收口评审语义块补记顾问子会话豁免。
  - 现状对照同步，非语义变更。
  - 依据：R-01-009/AC-05 评审对象本为执行者回合。
- 测试：处置器豁免、呈现登记缝、标签四态、接线级递归守卫回归。
  - 接线级回归覆盖：收口 → 子会话 → 子会话收口不再评审。
  - 接线级回归覆盖：会话清理后判定源失效。

## 测试计划

- `test/turn-review.test.js`：
  - 豁免命中不发起 consult，skipped 留痕。
  - 未登记会话照常评审（既有用例承载）。
- `test/subsession.test.js`：
  - 发布成功调用 `onPresented(run.id)`。
  - 发布前失败与缝缺失不调用。
  - `onPresented` 抛错被包含。
  - `subsessionLabel('turn-review')` 四态断言。
- `test/index.test.js` 接线级回归：
  - 硬模式收口触发一次子会话评审。
  - 以子会话 id 派发收口不再发起咨询。
  - `session/disposed` 后登记失效。
- 全套件 `npm test` 回归全绿。
- 三道门禁：agentmap_lint、anchor_coverage、expected_fail_check。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：豁免与登记是本 task 主体行为 | `test/index.test.js::T-022 接线级递归守卫`；`test/turn-review.test.js::T-022 顾问子会话豁免` |
| 异常 | 适用：`onPresented` 抛错被包含、豁免留痕可查 | `test/subsession.test.js::T-022 登记缝`；`test/turn-review.test.js::T-022 顾问子会话豁免`（skipped 留痕断言） |
| 边界配置 | 适用：豁免仅命中登记会话，执行者回合评审不受影响 | `test/turn-review.test.js::T-022 顾问子会话豁免`（未登记会话照常评审）；全套件既有收口评审用例回归 |
| 副作用 | 适用：呈现登记表随会话清理，不泄漏 | `test/index.test.js::T-022 接线级递归守卫`（会话清理后登记失效断言） |

## 终态与证据

（待关闭时填写）
