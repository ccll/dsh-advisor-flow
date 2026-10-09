---
doc-type: task
mutation: lifecycle
id: T-019
---
# T-019 顾问咨询以 one-shot 子会话呈现（R-02-007）

风险等级: standard
状态: completed
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

- 实现: ① `lib/subsession.js`（新增）子会话呈现缝纯逻辑——呈现提供方解析（getProvider 优先 `spawn`，否则扫描名单取语义合规者：`inheritsParentContext===false && agentOptions && toolFilter`）、`subagents.start` one-shot 委托（label=`Advisor review (entry)`、prompt=装配产物、agentOptions=顾问路由、`toolFilter:{allow:[]}` 零工具、persona=协议提示）、`SubagentResult.output` 文本块提取（非文本块过滤）、空输出 EMPTY 失败、`stopReason: 'aborted'` 中止终态、error/max-tokens/refusal 映射 SUBSESSION 失败、`finally` 无条件 dispose（dispose 抛错被包含）、发布前失败与内部异常一律 fallback（本缝绝不抛错）。② `lib/consultation.js`：`callAdvisor` 装配后按 `config.presentation` 分流——非 direct 且呈现缝在场时经 `presentSubsession`（deadline 融合信号、能力门控 effort 与 maxTokens 经 agentOptions 下传、EMPTY 记账与直调同语义、aborted 经 timedOut() 区分超时/取消、fallback 降级直调并 info 留痕）；`consult` 请求新增 `parent` 透传。③ `lib/config.js`：`PRESENTATION_MODES`/`DEFAULT_PRESENTATION='subagent'`（C-020）常量 + 标量键表 + KNOWN 清单（非法值按库纪律拒绝）。④ `lib/settings.js`：Schema `presentation` 键（双清单纪律）。⑤ `lib/index.js`：`subagents` 条件子上下文接呈现缝（`degradations.subsessionPresentation` 显性化）、`presentSubsession` 读时求值闭包、`extractUsage` 用量取数缝（子会话 `assistant/message` 事件 usage，dispose 前提取；不可得记 unavailable）。⑥ 三入口 parent 透传：`lib/tools/ask-advisor.js`（exec.agent）、`lib/gates/index.js`（exec.agent）、`lib/commands.js`（invocation.agent 经 startManual）。⑦ `lib/client.js` 经 `scripts/build-client.mjs` 重建（内联 config.js 新常量，与源码同步）。
- 测试: 全套件 `npm test` 246 通过 / 0 失败（基线 230 + 新增 16：`test/subsession.test.js` 9 用例锚定 AC-01/03/04/05/06（含发布后 rejection 两用例）、`test/consultation.test.js` 6 用例锚定 AC-02/03/04、`test/config.test.js` presentation 默认/两值/非法拒绝断言）；`anchor_coverage` passed（prd-ac=74 anchored=74 unanchored=0，R-02-007 六 AC 全锚定）；`expected_fail_check` passed（executed=246 与账本基线一致，`test/expected-fail.json` 230→244→246）；`agentmap_lint` passed（15 需求 / 74 AC 全锚定；本 task 新增内容零警告）。staging 实弹（af-verify 真实会话，go/no-go 通过）：tool 入口探针——子会话 `c102689c…` 创建，会话头 `origin:subagent / parentSession:<主会话> / delegationDepth:1`，主会话 `subagent/catalog` 登记 `label: Advisor review (tool)`，子会话 system = 部署 persona + ADVISOR_SYSTEM_PROMPT 完整在场、无工具清单段、全事件流零 tool 事件（NG-1 实证），user 消息 = 六区装配产物（素材契约不变），意见 `Verdict:` 协议结算经工具返回值送达主会话（`Advisor (gpu/glm-5.3-flash)` 渲染行），usage 经子会话 `assistant/message` 事件提取（inputTokens/outputTokens/totalTokens 实得）；gate 入口探针——循环门命中后子会话 `e21e08da…` 创建，catalog `label: Advisor review (gate)`，`Decision: proceed` 结算、门结果送达执行者；结算后两子会话 session 落盘留存（go/no-go 留存项通过，无消失问题）。
- SOLUTION 对照: PRD R-02-007 六 AC 新增、NG-8 括注演进（可见性承载新增子会话呈现）；SOLUTION 系统上下文图/内部组件分解图/分层依赖图/运行时交互图、产品契约 `presentation` 键、咨询服务子系统职责、运行时语义「子会话呈现语义」条（含呈现提供方「可用」判定标准）、需求追溯索引 R-02-007 行、接缝清单 `ctx.subagents` 同步；DOMAIN「子会话呈现（Subagent Presentation）」术语与实体关系登记；RATIONALE C-020 追加（四段式）。修复提交 c7f1795 补写呈现提供方「可用」判定标准（spec 轴首轮发现③收敛）。SOLUTION 与实现对照无差异。
- commit: 4ef493d —— 实现提交（正文引用 T-019）；c7f1795 —— 审核修复提交（发布后 rejection 分类 + rejection 两用例 + SOLUTION 判定标准补写）。
- 锚定理由: R-02-007 六 AC 由 test/subsession.test.js 与 test/consultation.test.js 测试标题直接锚定，机械门禁 `anchor_coverage` 74/74 与 `agentmap_lint` 通过为权威依据。
- review:
  - 审核方: code-review skill 双轴并行独立子代理（Standards 轴 1e4c1d2e、Spec 轴 751ac2bd）+ 同审核方复审轮
  - 目的理解: 在不动素材装配（R-02-006 六区契约）、送达通道、隐私档位、失败/预算/取消语义的前提下，为咨询（tool/manual/gate 三入口统一）新增 one-shot 子会话呈现缝——会话界面出现顾问子会话条目（R-02-007/AC-01），意见结算与送达不变；验证方式为 244→246 用例全套件 + agentmap_lint/anchor_coverage/expected_fail_check/bundle 同步四道门禁 + af-verify staging 实弹 go/no-go。
  - 执行方式: code-review skill 双轴并行独立子代理，基线 6ff0454...4ef493d（实现提交）；复审轮接收首轮全部发现与处置逐条裁决，基线扩展至 c7f1795。
  - 问题与修复: 双轴一致命中 1 项高危——`run.result` rejection 穿过内层 finally 落入外层兜底 catch 被折叠为 fallback，经 consultation 分支降级直调重发同一请求，违背 AC-04「不得降级直调重发」与 C-020 → 修复（c7f1795）：run 在手后的异常内层分类（signal.aborted → aborted 终态；否则 failure/SUBSESSION 诊断），fallback 仅保留发布前，补 rejection 两用例锚定 AC-04；处置保留 3 项——实现提交正文重复「## 影响」段（commit-msg 门禁仅校验 task 引用，未推送历史不改写，沿 T-018 先例，后续提交正文改用规范三段式——复审确认 c7f1795 正文同形态，沿例不改写）、subsession/subagent 词根差异（DOMAIN 中文规范名「子会话呈现」统一承载，宿主服务名 subagents 属宿主词汇）、测试假件与 outcome 映射的结构性重复（两处假件服务不同抽象层：引擎分流 vs 缝本体，强行共享反致耦合）；处置收敛 1 项——呈现提供方语义合规判定属实现自行加严 → SOLUTION 运行时语义补写「可用」判定标准（不继承父上下文 + agentOptions + toolFilter 能力，判定先于 start），scope creep 消除；label 非法入口回退——不可达防御分支（consult() 已规范 entry），不改。
  - 复审结论: 双轴复审全部通过——两轴对 4 条发现逐条裁决「接受修复/接受处置」，无新发现（Standards 轴仅提示后续提交正文规范三段式，已列入处置理由）；全部问题已修复或处置完毕，可关闭 T-019。
- 残余风险: ① one-shot 结算后子会话条目在宿主 GUI 的长期留存行为以落盘与 catalog 实证为据，宿主版本升级后的呈现行为变化由宿主侧承载（插件无承诺面）；② `extractUsage` 依赖 sessionQuery 对子会话 id 的可读性，部署形态变化时台账按 unavailable 呈现（R-02-002/AC-02 语义兼容，无零值虚构）；③ 生产 web 宿主重启前仍运行旧 bundle——子会话条目出现以宿主重启加载新代码为前提（宿主重启由东家执行）；④ 实现/修复提交正文的重复「## 影响」段为已落历史瑕疵，反查链不受影响，后续提交正文以规范三段式为准。
