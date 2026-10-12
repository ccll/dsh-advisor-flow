---
doc-type: task
mutation: lifecycle
id: T-026
---
# T-026 咨询工具面守卫（R-01-001、R-01-009）

风险等级: standard
状态: active
关联: R-01-001（工具面收窄）、R-01-009（介入强度语义延伸）、T-022/T-023（豁免机制先例与判定复用）、C-025

## 背景与目标

东家裁决（2026-10-12 会话）：两条收敛规则。

- 软模式：审核类子会话不得经 `ask_advisor` 工具自动咨询。
  - 即使调用发生，工具执行面也应当检测并拒绝。
- 硬模式：任何会话都不得主动调用 `ask_advisor`。
  - 即使调用发生也应当完全拒绝。
  - 动机：避免与收口评审叠加成多重评审。

动机证据（2026-10-12 homelab 会话日志取证）：

- code-review skill 发起的审核类子会话（`3afc1e4f`，`origin=subagent`）在 turn 1 step 7 自行调用 `ask_advisor`，呈现 `Advisor review (tool)` 顾问子会话（`66c58112`，depth 2）。
- 该子会话系统提示含完整三行「Advisor invocation settings」守则——守则经 `systemPrompt.section` 全局注入，对子会话同样生效。
- T-023 豁免只挂 `agent/turn-stopping` 收口缝（lib/turn-review.js:196），工具入口无豁免判定。
- 硬模式存在结构性重叠：收尾守则指示模型在宣告成功前调用工具。
  - 此时收口评审又在 turn-stopping 自动发起，同回合形成双重评审。
  - C-021 只去重同一收口事件的重复派发。
- TODO 缺陷线索（顾问子会话守则注入 + toolFilter 单点防线）同族，本次随守卫一并关闭。

目标：`ask_advisor` 执行面守卫——硬模式拒绝一切调用；软模式拒绝审核类子会话与已登记顾问子会话；判定复用共享分类器；硬模式停用守则注入且状态呈现不谎报。

## 差距评估

- `lib/tools/ask-advisor.js` `execute`：无任何调用方判定，一律进 `engine.consult`。
- `lib/turn-review.js`：豁免判定（`subsessionExemptFrom` + 按会话缓存）内嵌于处置器闭包，无法被工具面复用。
- `lib/guidelines.js` `guidelineTextFactory`：无 mode 判断——硬模式仍注入守则，指示模型调用必然被拒的工具。
- `lib/status.js` / `lib/commands.js`：快照与 `/advisor status` 无工具面拒绝计数，`/advisor gates` 回读在硬模式下不注明守则停用。
- `lib/index.js`：守卫与共享分类器无接线；时序缝——包装引擎在 `consult` 内才 `applyFromSource()`，守卫若先行判定会读到旧 mode。

## 收敛方案

- `lib/reviewer-classifier.js`（新）：从 turn-review.js 抽取 `subsessionExemptFrom` 纯函数与按会话缓存判定（清单空零读取、patternsKey 失配重判、失败不缓存 fail-open），暴露 `createReviewerClassifier({ getConfig, getEvents, logger })` → `{ isReviewerSubsession, forgetSession }`。纯抽取重构，豁免行为不变。
- `lib/tool-guard.js`（新）：`createToolFaceGuard({ getConfig, applyConfig, classifier, isAdvisorSubsession, logger })` → `async guard(sessionId)`。
  - 判定顺序：先 `applyConfig()`（时序缝修正）→ 未启用放行（沿用引擎路径）→ hard 拒绝一切（`TOOL_FACE_CLOSED`）→ soft 拒绝已登记顾问子会话与审核类子会话（`SESSION_EXEMPT`）。
  - 守卫抛错 fail-open 放行。
  - 拒绝 reason 明示属预期、勿重试、替代路径；拒绝计数（总数 + 按 code）。
- `lib/tools/ask-advisor.js`：`createAskAdvisorTool({ engine, guard })`。
  - `execute` 在参数校验后调用 `guard(sessionOf(exec))`，命中即返回 `{ ok:false, code, reason }`。
  - guard 未注入时行为不变（向后兼容既有单测）。
- `lib/turn-review.js`：改注入共享 `classifier`（替换内嵌豁免缓存）。
  - `getEvents` 缝移交分类器；`forgetSession` 委托分类器。
- `lib/guidelines.js`：`mode === 'hard'` 时守则族求值为空串（R-01-009/AC-13）。
- `lib/status.js`：快照新增 `toolFaceStats`（访问器不可得时 undefined，同 turnReviewStats 口径）。
- `lib/commands.js`：`/advisor status` 增工具面拒绝行；`/advisor gates` 回读在 hard 模式注明三类守则停用。
- `lib/index.js` 接线：创建共享分类器（getSessionEvents + config getter）。
  - 创建守卫（applyFromSource 原语 + 登记表 + 分类器）。
  - 守卫注入工具与收口评审；状态服务注入拒绝计数访问器。
  - `session/disposed` 摘除分类器缓存。

## 测试计划

- `test/reviewer-classifier.test.js`（新）：
  - 分类器判定：审核子会话命中（label/首条提示词）、主会话与 fork 不判、执行类子会话不命中。
  - 缓存：同会话零重读、patternsKey 失配重判、失败不缓存次轮重判、`forgetSession` 复位。
  - fail-open：undefined 缝 / 抛错 / 空流一律 false 且不缓存。
- `test/tool-guard.test.js`（新，锚定 R-01-001/AC-09、AC-10）：
  - soft 拒绝审核类子会话（分类器阳性）。
  - soft 拒绝登记表命中的顾问子会话。
  - soft 放行主会话与执行类子会话。
  - hard 拒绝一切会话（含主会话、含未分类会话）。
  - 未启用（enabled=false）放行；守卫抛错放行。
  - guard 未注入时工具行为不变。
  - 拒绝 reason 三点断言（expected / do not retry / 替代路径）；计数按 code 累计。
  - 时序缝：盘上 soft→hard 切换后首次调用按新 mode 拒绝（applyConfig 先于判定）。
  - `output.render` 对两拒绝码的呈现断言。
- `test/guidelines.test.js`：hard 模式守则求值空串；soft 模式守则照常（既有用例回归）。
- `test/turn-review.test.js`：夹具改注入共享分类器；豁免行为断言不变（log 文案随分类器统一调整）。
- `test/status.test.js` / `test/commands.test.js`：快照字段与渲染行断言（R-01-009/AC-13 状态口径）。
- `test/index.test.js`：接线级守卫回归——软模式审核子会话工具调用被拒、硬模式全拒、拒绝计数入快照。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：守卫判定是本 task 主体行为 | `test/tool-guard.test.js::软模式拒绝审核类子会话`；`test/tool-guard.test.js::硬模式拒绝一切会话`；`test/tool-guard.test.js::软模式放行主会话与执行类子会话`；`test/reviewer-classifier.test.js::纯判定` |
| 异常 | 适用：守卫抛错与判定失败 fail-open 放行 | `test/tool-guard.test.js::守卫组件失败 fail-open`；`test/turn-review.test.js::豁免判定 fail-open` |
| 边界配置 | 适用：未启用放行、空清单、mode 切换时序缝、guard 未注入向后兼容 | `test/tool-guard.test.js::未启用（enabled=false）放行`；`test/tool-guard.test.js::时序缝`；`test/guidelines.test.js::硬模式守则停用`；`test/reviewer-classifier.test.js::分类器清单为空` |
| 副作用 | 适用：拒绝计数入快照且随会话清理不泄漏缓存 | `test/status.test.js::toolFaceStats`；`test/reviewer-classifier.test.js::分类器多会话隔离与 forgetSession 复位`；`test/index.test.js::T-026 接线级守卫` |
| 安全 | 不适用：守卫不触及出境素材；拒绝路径不发起咨询，无新数据流 | |
| 性能 | 适用：判定缓存命中零重读（共享分类器同收口评审豁免） | `test/reviewer-classifier.test.js::分类器缓存` |
| 并发 | 适用：分类器缓存按会话键隔离，跨会话判定互不污染 | `test/reviewer-classifier.test.js::分类器多会话隔离与 forgetSession 复位` |
| 可观测性 | 适用：拒绝计数与 reason 留痕可查 | `test/commands.test.js::工具面拒绝计数`；`test/tool-guard.test.js::拒绝计数按 code 累计` |

## 终态与证据

（关闭时填写）
