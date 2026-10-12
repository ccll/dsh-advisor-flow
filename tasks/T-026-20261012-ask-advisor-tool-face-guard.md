---
doc-type: task
mutation: lifecycle
id: T-026
---
# T-026 咨询工具面守卫（R-01-001、R-01-009）

风险等级: standard
状态: completed
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
- `lib/guidelines.js`：hard 模式守则族求值为空串（R-01-009/AC-13）。
  - 判定谓词 `guidelinesActive`（lib/config.js）单点承载，status/gates 呈现共用——mode 缺省随 DEFAULT_INTERVENTION_MODE 归一。
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

- 实现: ① `lib/tool-guard.js`（新）：execute 前守卫——hard 拒绝一切（`TOOL_FACE_CLOSED`）、soft 拒绝审核类子会话（共享分类器阳性）与已登记顾问子会话（呈现登记表，防线纵深）；fail-open 仅阳性拒绝；判定前先 `applyConfig()`（时序缝修正）；mode 未定义归一 DEFAULT_INTERVENTION_MODE；拒绝 reason 三点（属预期/勿重试/替代路径）；拒绝计数按 code。② `lib/reviewer-classifier.js`（新）：T-023 判定（`subsessionExemptFrom` + 缓存）逐行等价抽取为共享分类器。③ `lib/turn-review.js` 改注入共享分类器（getEvents 缝移交、forgetSession 委托）。④ `lib/guidelines.js` hard 停用，判定谓词 `guidelinesActive`（`lib/config.js` 新增）单点承载；`lib/commands.js` status 注记与 gates 回读收编同谓词；`lib/status.js` 快照 `toolFaceStats`。⑤ `lib/index.js` 接线：分类器 + 守卫注入工具与收口评审，`session/disposed` 摘缓存。⑥ 测试基建：`reviewerSubsessionEvents` 夹具收编 `test/helpers.js` 单点（turn-review 与 index 两测试文件既有同形夹具去重——T-023 复审确立的夹具单点纪律延续，超出测试计划文本的补充项）。⑦ map 同步：PRD R-01-001 增 AC-09/AC-10、R-01-009 增 AC-13；SOLUTION 契约（两拒绝码）/收口评审语义/工具面守卫语义块/三模块条目；DOMAIN「工具面守卫」词条 + 两条不变量（fail-open 与空清单放宽已补注）；RATIONALE C-025；TODO 第二递归向量缺陷线索关闭。
- 测试: 全套件 `npm test` 307/307 通过（基线 283→306 实现、306→307 复审锚点）。新增锚点：`test/tool-guard.test.js`（soft 拒绝/硬模式全拒/登记表防线纵深/fail-open/时序缝/未启用放行/mode 未定义归一/reason 三点/计数）与 `test/reviewer-classifier.test.js`（判定/缓存/失败重判/空清单/多会话隔离）；`test/ask-advisor.test.js` 守卫短路接线与拒绝码渲染；`test/guidelines.test.js` hard 停用与 mode 归一；`test/index.test.js` 接线级守卫回归（软模式审核子会话被拒且主会话照常、硬模式全拒零咨询）。`agentmap_lint` / `anchor_coverage`（prd-ac=93 全锚定）/ `expected_fail_check`（executed=307）三道门禁通过。
- SOLUTION 对照: R-01-001/AC-09（审核类与顾问子会话工具拒绝）与 AC-10（hard 全拒）由 lib/tool-guard.js 兑现；R-01-009/AC-13（hard 守则停用且状态呈现如实）由 guidelinesActive 谓词单点兑现——工厂与 status/gates 呈现共用判定；评审对象语义（顾问/审核类子会话不评审）与 DOMAIN 不变量一致。SOLUTION 与实现对照无差异。
- commit: 344feba —— 实现提交（map 演进 + 守卫 + 分类器 + 测试）；7765365 —— 双轴审核收口提交（共享谓词、reason 替代路径、文档损伤修复）；1a81aa5 —— 复审 polish 提交（mode 归一锚点用例、排版）。
- review:
  - 审核方: code-review skill 双轴并行子代理（Standards 轴、Spec 轴，各自独立会话）；复审由同一双方执行。
  - 目的理解: 收口评审豁免只覆盖 turn-stopping 缝，工具入口无判定——审核类子会话自咨询构成元评审（homelab 实测取证），硬模式主动咨询与收口评审结构性重叠成双重评审（C-021 仅去重同一收口事件）；修复须守住非阻断不变量（守卫失败放行、拒绝仅为当次失败值）与素材出境唯一通道（拒绝路径不发起咨询、无新数据流）。
  - 执行方式: code-review skill——两轴并行（ Standards：AGENTS.md 工程原则 + CONVENTIONS + SOLUTION 横切约束 + DOMAIN 不变量 + Fowler 基线；Spec：T-026 task + PRD AC + C-025 决策），基线 95dc666。
  - 问题与修复: Standards①commands.js 字面量 `'hard'` 违反 canonical term → guidelinesActive 谓词单点收编三处（7765365）；Standards②test 行损坏（执行方自查发现）→ 分行修复（7765365）；Spec①SESSION_EXEMPT reason 第三点为停止指令非替代路径 → 改为可执行替代路径并收紧断言（7765365）；Spec②「共用谓词」表述未字面落地 → guidelinesActive 落地消除三处副本与 undefined-mode 语义分叉（7765365）；Spec③turn-review.js JSDoc 重复块 → 删除（7765365）；复审 n2 mode 归一分支缺锚点 → 两侧各补用例（1a81aa5）。判断项裁量保留：Middle Man（forgetSession 单行委托——维持 dispose 接线缝）、Speculative Generality（guard 可选注入——钉住工具级单测契约）、n1 归一式双份不合并（守则生效与工具面关闭概念不同）——复审双方均认可。
  - 复审结论: 两轴复审通过——Standards 轴「四项闭环、保留处置同意、无阻断新发现」；Spec 轴「四项技术发现闭环、无阻塞可关闭」。唯一行为变化（mode 未定义归一 hard）方向与 R-01-009/AC-02 一致且记残余风险。

## 残余风险

- 豁免清单为空（`turnReviewExemptPatterns: []`）时工具面对审核类子会话的拒绝随之关闭——AC-09 在该合法配置下不成立。
  - DOMAIN 不变量已记「判定失败放行（fail-open）与豁免清单为空是仅有的两处放宽」。
  - 清空清单即显式关闭豁免判定面，属会话主裁量（与收口评审豁免同键同语义）。
- 守卫对 mode 未定义的配置按 DEFAULT_INTERVENTION_MODE（hard）归一。
  - 生产配置经解析器恒有 mode（config.js:310 缺省填充），该路径仅测试直接构造时可达。
  - 与守则停用谓词、状态呈现同一缺省语义；未定义 mode 不构成 fail-open 旁路。
