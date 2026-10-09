---
doc-type: task
mutation: lifecycle
id: T-022
---
# T-022 收口评审顾问子会话递归守卫（R-01-009/AC-05、R-02-007）

风险等级: standard
状态: completed
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

## 残余风险

- 豁免缝 `isAdvisorSubsession` 为可选参（缺省不豁免）。
  - 缺省行为与修复前一致（fail-open 语义面）。
  - 接线注入由接线级回归测试钉住。
  - 已知取舍（东家裁定）：必选化会迫使全部测试夹具携带桩。
- 联调验证项 ①：登记清理依赖宿主对顾问子会话派发 `session/disposed`。
  - 若宿主只释放 run 句柄而不派发该事件，登记条目泄漏。
  - 泄漏后果：同 id 复用的执行者会被误豁免；会话 id 为 UUID，实际复用概率趋零。
- 联调验证项 ②：豁免判定的承重假设是「run.id 与收口载体 agent.id 同一」。
  - 实证旁证：2026-10-09 docsim 事故链中 `subagent/catalog.childId` 与子会话 session 头 id 一致。
  - 证据：f32ee7e9 的 catalog 记 childId f4d80df4，该子会话 session 头同 id。
  - 待真实宿主联调复核（同 T-002 体例）。
- 两项验证均依赖真实宿主行为，单测无法覆盖。
  - 宿主重启加载新构建后由东家实测收口。

## 终态与证据

- 实现: ① `lib/subsession.js`：`subsessionLabel` 补 `turn-review` 态（入口枚举经 `util.CONSULTATION_ENTRIES` 单点）；`createSubsessionPresenter` 新增 `onPresented(subsessionId)` 登记缝——发布成功且 run.id 为字符串时调用（先于 result 结算），失败 info 级留痕，发布前失败不调用。② `lib/turn-review.js`：`createTurnReview` 新增 `isAdvisorSubsession(sessionId)` 前置豁免——判定位于预算核查、会话停用与同回合去重之前，命中即 skipped 留痕放行。③ `lib/index.js`：`advisorSubsessions` 登记表；呈现缝 `onPresented` 登记；`session/disposed` 摘除；处置器注入判定。④ `lib/util.js`：`CONSULTATION_ENTRIES` 入口四态单点（consultation 入口归一共用；usage 台账枚举含 scout 属计量口径差异，保持独立并注明）。⑤ `SOLUTION.md`：收口评审语义条目补「评审对象是执行者回合」与豁免交叉引用；新增「顾问子会话豁免」语义块；门控服务职责同步。⑥ `DOMAIN.md`：「呈现登记表」词条、实体关系行、两条跨模块不变量。
- 测试: 全套件 `npm test` 269 通过 / 0 失败。新增锚点：`test/turn-review.test.js::T-022 顾问子会话豁免`（豁免命中不评审且留痕；未登记会话照常评审）；`test/subsession.test.js::T-022 登记缝`（发布成功调用、发布前失败与缝缺失不调用、抛错被包含；标签四态断言）；`test/index.test.js::T-022 接线级递归守卫`（执行者收口恰发布一个零工具 turn-review 标签子会话 → 子会话收口零咨询 → `session/disposed` 后登记失效恢复评审）。`expected-fail` 基线 266→269；`agentmap_lint` / `anchor_coverage`（prd-ac=84 全锚定）/ `expected_fail_check` 三道门禁通过。
- SOLUTION 对照: R-01-009/AC-05 评审对象收敛为执行者回合——豁免使实现回归该语义（顾问子会话不是执行者）；R-02-007/AC-01 标签如实标识入口（turn-review 态）；子会话零工具（`toolFilter={allow:[]}`）与素材契约不变。SOLUTION 与实现对照无差异。
- commit: b7ace27 —— 实现提交（正文引用 T-022）；b3eba4e —— 双轴复审收敛提交（DOMAIN 登记、注释精度、CONSULTATION_ENTRIES 单点化、夹具收编）；4c4462d —— DOMAIN 拆行排版提交；912b8b4 —— 复审收尾提交（注释锚修正、残余风险落盘、fakeRun 参数收敛）。
- review:
  - 审核方: code-review skill 双轴独立子代理（Standards/Spec 并行，审核方逐条亲验）+ 两轮同审核方复审
  - 目的理解: 收口评审经子会话呈现自我再入造成无界深度优先递归（2026-10-09 docsim 实测 delegationDepth 9，宿主被强行终止）；修复 = 呈现登记缝 + 处置器豁免 + 标签四态，豁免属缺陷修复而非语义变更（PRD.md R-01-009/AC-05 评审对象本为执行者回合）；验证方式 = 269 用例全套件 + 三道门禁 + 接线级递归守卫回归。
  - 执行方式: code-review skill 双轴并行独立子代理，基线 0b197f8...b7ace27；复审轮基线扩展至 b3eba4e、4c4462d；复核轮限 912b8b4。
  - 问题与修复: 首轮 Standards 2 硬违规——DOMAIN 缺「呈现登记表」词条与跨模块不变量 → 补记（b3eba4e、4c4462d）；登记缝注释「发布成功即登记」强于代码且守卫降级日志 debug 不可观测 → 条件如实表述 + 日志升 info（b3eba4e）。判断项 3 项收敛——入口四态白名单双点重复 → `CONSULTATION_ENTRIES` 单点化；递归叙事约 7 处重复 → 代码处缩短为 SOLUTION 指针；测试夹具同形两份 → 收编 `test/helpers.js`。判断项 2 项按 task 明文取舍保留——豁免缝可选形态（接线测试钉住，风险记残余风险）；`onPresented` try/catch 包容（测试锚定）。Spec 轴——SOLUTION 收口评审语义条目未提豁免（落点偏差）→ 补交叉引用；两条联调验证项建议 → 记入残余风险。复审轮 Standards 2 须修复项（残余风险落盘滞后于 b3eba4e 提交说明；注释锚「跨模块约束」断链）+ 1 可选项（fakeRun 投机 id 参数）→ 全部修复（912b8b4）；Spec 复审指出同一锚断链与关闭前提三项 → 全部满足。
  - 复审结论: 第二轮双轴复审通过——Standards 复核结论「可关闭」，Spec 复审关闭前提（注释锚、残余风险落盘、独立关闭提交）全部满足；两轮发现全部闭环，残余风险已记录（两项联调验证项待真实宿主复核）。
