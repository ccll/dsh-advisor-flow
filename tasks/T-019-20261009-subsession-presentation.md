---
doc-type: task
mutation: lifecycle
id: T-019
---
# T-019 顾问咨询以 one-shot 子会话呈现（R-02-007）

风险等级: standard
状态: active
关联: R-02-007（C-020；东家 2026-10-09 会话裁决走全链，呈现范围三入口统一、形态 one-shot）

## 背景与目标

东家实测反馈：咨询经 `llm.stream` 进程内直调，dsh web GUI 会话树中无任何条目。
- 咨询发起、进行与完成对会话主不可见；对照宿主 subagent 机制（子会话条目出现于会话树）产生可见性落差。
- 评估确认原 map 无子会话承诺（NG-8 豁免 pi TUI 专属面），属新需求。
- 决策依据与被否方案见 C-020。

目标：
- 咨询（工具/手动/门三入口统一）经 `ctx.subagents.start` 以 one-shot 顾问子会话发起。
- 会话界面出现顾问子会话条目（R-02-007/AC-01）。
- 意见与送达通道、素材契约、隐私档位、非阻断语义全部保持不变。

边界：
- 不做 continuable 留存。
- Scout 不子会话化。
- 不新增送达通道。
- 不改变失败/预算/取消语义。
- 设置卡不新增 presentation 编辑面（settings.yaml 承载）。

## 差距评估

- 咨询服务：`lib/consultation.js` `callAdvisor` 以 `llm.stream` 直调为唯一路径。
  - 需在装配完成后插入呈现缝：`presentation=subagent` 时经 `subagents.start` one-shot 发起，结算取意见。
  - 降级路径保留直调。
- 宿主缝现状（spike 已核）：
  - `ctx.subagents.start(name, request)` 公开（dsh-subagent types index.d.ts:296）。
  - `SubagentStartRequest` 含 `label/prompt/parent/signal/agentOptions/toolFilter/persona`。
  - `SubagentResult.output/stopReason` 承载意见与成败。
  - 宿主自带 `dsh-subagent-spawn-in-process` provider（默认名 `spawn`，capabilities 全支持）。
  - `SubagentResult` 无 usage 字段——用量取数缝（run 结束事件或 sessionQuery 读子会话日志）实现首日验证；系统性不可得时台账按 unavailable（R-02-002 语义）。
- 配置面：`lib/config.js` 无 `presentation` 键——新增解析（`subagent|direct`，默认 `subagent`；非法值按库纪律 invalid-value-rejected 拒绝，与 failureMode 同型）。
- 接线层：`lib/index.js` 引擎装配处需把 `subagents` 服务（可选缝，条件子上下文原语）注入呈现缝。
- Map 演进（已随本 task 同提交落笔）：
  - PRD：R-02-007 新增 + NG-8 括注演进。
  - SOLUTION：系统上下文图/内部组件分解图/分层依赖图/运行时交互图、产品契约 presentation 键、咨询服务子系统职责、运行时语义子会话呈现条、追溯索引、接缝清单。
  - DOMAIN：子会话呈现术语与实体关系。
  - RATIONALE：C-020。
- 测试：呈现缝解析/降级/结算映射/空输出失败/句柄释放的新用例（锚定 R-02-007/AC-nn）；既有 consultation/gates/commands 套件回归。

## 收敛方案

- `lib/subsession.js`（新）：子会话呈现缝纯逻辑——`createSubsessionPresenter({ subagents, logger })` 返回 `present({ label, promptText, parent, signal, advisorRoute })`：
  - 提供方解析：`subagents.list()` 含宿主 spawn 后端名（`spawn`，容忍改名——名单非空且含可解析项；无可用提供方即发布前失败返回 `{ ok: false, reason }`）。
  - `start(provider, { label: 'Advisor review (entry)', prompt: [{type:'text',text:promptText}], parent, signal, agentOptions: 顾问路由, toolFilter: { allow: [] } })`。
  - 结算：`SubagentResult.output` 过滤取文本块拼接。
  - 空输出或 `stopReason: 'error'` 返回失败形态。
  - `finally` 无条件 `run.dispose()`。
  - persona：ADVISOR_SYSTEM/ADVISOR_DECISION 协议提示经 start 请求 `persona` 承载。
- `lib/consultation.js`：`callAdvisor` 装配完成后按 `config.presentation` 分流。
  - `subagent` 且呈现缝在场时经呈现缝，结算文本复用既有 answered/failed 收敛。
  - decision 解析、账本、用量提取路径不变；用量不可得记 unavailable。
  - 呈现缝缺失或发布前失败降级直调并记 info 日志（原因 + 会话 + 入口）。
  - 发布后 run 失败直接映射诊断码，不降级重发。
- `lib/config.js`：`presentation` 键解析，默认 `subagent`。
  - 非法值按库纪律拒绝；未知键纪律不变。
- `lib/index.js`：`whenServiceAvailable('subagents', ...)` 条件子上下文接呈现缝进引擎。
  - 缺缝 = 降级直调路径，degradations 显性化。
- `lib/settings.js`：Schema 同步 presentation 键（双清单纪律）。

## 测试计划

- `test/subsession.test.js`（新）：
  - 锚定 R-02-007/AC-01：label 与 start 请求形态（prompt 承载素材、parent、agentOptions 顾问路由、toolFilter 零工具）。
  - 锚定 R-02-007/AC-03：缝缺失/名单无提供方/发布前失败 → 降级直调且原因可查。
  - 锚定 R-02-007/AC-04：发布后 run 失败 → 诊断码收敛且不降级重发、finally dispose 无条件。
  - 锚定 R-02-007/AC-05：prompt 即装配素材原文，工具零暴露由 toolFilter 断言。
  - 锚定 R-02-007/AC-06：空输出/无非空文本 → 失败诊断码。
- `test/consultation.test.js`：presentation=subagent 命中呈现缝、direct 保持直调、结算意见与直调意见文本一致（AC-02）。
- `test/config.test.js`：presentation 解析（默认/显式/非法拒绝）。
- 全套件 `npm test` 回归。
- 门禁：`agentmap_lint`、`anchor_coverage`（R-02-007 六 AC 锚定核对）、`expected_fail_check`。
- staging 实弹（go/no-go 检查点）：
  - 真实会话发起咨询 → GUI 会话树出现顾问子会话条目（label 可辨识）。
  - 结算留存行为观测记录。
  - 门审与手动咨询两入口复验。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用: presentation=subagent 时三入口咨询经 one-shot 子会话发起，意见结算与送达不变 | `test/subsession.test.js::R-02-007/AC-01 子会话发起：label 标识顾问与入口，start 请求承载 prompt/parent/signal/agentOptions/toolFilter/persona`、`test/consultation.test.js::R-02-007/AC-02 presentation=subagent 时咨询经呈现缝发起：结算意见即咨询结果，直调不触发` |
| 异常 | 适用: 发布后 run 失败映射诊断码不重发；空输出失败；取消收敛；dispose 无条件 | `test/subsession.test.js::R-02-007/AC-04 发布后 run 失败映射 failure 终态；dispose 无条件执行（dispose 抛错也被包含）`、`test/consultation.test.js::R-02-007/AC-04 发布后 run 失败直接映射诊断码：不降级直调重发（无双倍成本）`、`test/subsession.test.js::R-02-007/AC-06 空输出或无非空文本按失败处置：EMPTY 诊断；用量在 dispose 前提取` |
| 边界配置 | 适用: presentation 缺省/显式/非法拒绝；subagents 缝缺失与发布前失败降级 | `test/config.test.js::R-02-001/AC-01 解析后的配置驱动后续咨询，重新应用即时生效`、`test/config.test.js::R-02-001 门配置解析为结构化对象（三布尔 + 循环门阈值 + failureMode 三值）`、`test/subsession.test.js::R-02-007/AC-03 降级链：缝缺失、无合规提供方、发布前失败均返回 fallback（不抛错）`、`test/consultation.test.js::R-02-007/AC-03 呈现缝缺席（presentSubsession 未注入）时降级直调：默认 presentation 兼容无缝宿主` |
| 副作用 | 适用: 素材契约不变（prompt 即装配产物）；顾问零工具；门处置语义不回归（既有门套件承载） | `test/subsession.test.js::R-02-007/AC-05 呈现提供方语义约束：零工具 allowlist 与素材透传经 start 请求断言；优先 spawn 后端`、`test/gates.test.js::R-01-005/AC-03 决策 blocked × block-session：会话封锁 + stopSession 调用 + 后续调用全 deny` |

## 终态与证据

（待实现完成后填写）
