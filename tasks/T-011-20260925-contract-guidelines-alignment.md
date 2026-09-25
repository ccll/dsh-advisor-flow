---
doc-type: task
mutation: lifecycle
id: T-011
---
# T-011 契约与守则对齐 pi-advisor-flow 0.8.2（文案英文化 + 引擎语义 + 默认值）

风险等级: high
状态: completed
关联: R-01-001～R-01-007、R-02-001（C-008 决策包；基线冻结 C-009）

## 背景与目标

东家裁定除 dsh 无法承载项外行为与 pi-advisor-flow 严格一致（C-007 延续，基线升 0.8.2，C-009）。差距审计（三路证据）判定：文案中文化、引擎语义偏差（计数/UUID/空意见/JSON 解包）、默认值反向、守则缺行、门文本形状偏差等需在本 task 收敛。目标：契约面与守则面逐字对齐冻结制品，引擎语义与 pi 一致，默认值对齐。

## 差距评估

- 文案中文化 → 英文逐字（守则四行/ADVISOR_SYSTEM/ADVISOR_DECISION_SYSTEM/工具与参数描述）——审计 G-8 关联、主线程提取已完成。
- ask_advisor 参数面 2→6（gitContext/includeTrackedFiles/includeUntracked；force 随 Jev NG 不实现）；adviceId 改 UUID；空意见判失败；结果前缀 `Advisor (model)`（R-01-001/AC-04~08）。
- 循环门计数改连续签名制 + 波动归一 + threshold 下界 ≥2（G-6/G-7/G-20）。
- 门命中预通告、失败通告形状 `**Advisor gate failure (category):**`、门问句去参数（G-9/G-10）。
- manual 失败 steer 可见 + 并发替换语义（G-11/G-12）。
- parseAdvice JSON 解包移除（G-15）。
- 守则注入前置（工具缝激活 + 模型访问允许）（G-16）。
- 默认值对齐：failureMode=block-session、三门与循环门默认 true、redactSecrets=false、threshold=3（G-5/C-008）。
- 新配置键：customInvocation、modelWhitelist、blockOnBlocked、contextMaxChars、gitContextMaxChars（C-008 ⑦⑨ 等）。
- 守则新增 custom 行与剩余次数预告行（G-8）。

## 收敛方案

- `lib/pi-texts.js`（新）：从冻结制品（.tmp-audit/v0.8.2）程序化提取全部文案字符串表，导出常量；测试按表逐字等值断言。
- guidelines.js：改引英文文本工厂；custom/预算行模板展开；注入前置守卫（tools 缝激活态）。
- tools/ask-advisor.js：六参 schema（英文描述逐字）；execute 空意见→失败值；UUID adviceId 由引擎分配；render 前缀。
- consultation.js：UUID 分配；空回复判失败；parseAdvice 解包删除；意见账本（issue/lastAdvice/normalizedQuestion）骨架（完整生命周期在 T-013 落地）。
- observer.js：连续签名计数 + volatility 归一（timestamp/date/request-id/临时路径/空白）。
- gates/index.js：预通告 steer、失败通告英文形状、门问句去参数、阈值下界校验。
- commands.js：manual 替换语义 + 失败 steer。
- config.js/settings.js：默认值与新键（解析器 + Schema 双写）；旧键警告保留。
- git 契约：无。

## 测试计划

- `node --test` 全量绿：字符串表逐字断言（守则四行+两系统提示+工具描述）、连续计数交错序列用例、波动归一用例、UUID 形态、空意见失败、门预通告/通告文本、manual 替换、默认值断言（config 对象断言）、threshold 下界拒绝。
- staging 实弹（af-verify profile）：守则英文注入可见、门命中预告+Decision 送达、abort 极性复现（G-13 裁决输入）。
- 测试锚定：全部新 AC 落锚后本 task 关闭并切回 strict。
- 必锚 AC（收敛闸门）：R-01-001/AC-04～08、R-01-002/AC-03～04、R-01-003/AC-03、R-01-005/AC-06～10、R-01-007/AC-01～04、R-02-001/AC-04～05 全部有测试锚点方可关闭。
- 冲突场景锚点：门问句不参与等价判定——不同参数的问句归一后不得使 threshold 误触发（等价判定仅依工具名+规范化参数，R-01-005/AC-01）。
- 预期失败清单（红基线 a1111c0；实际失败签名已逐项核对，14 项全部为预期失败，零 fixture/设置错误）：
  - 断言级（9 项，`AssertionError actual≠expected`，均为目标行为未实现）：config R-02-001/AC-04（默认值仍旧）、config R-02-001/AC-05（threshold=1 仍被接受）、consultation R-01-001/AC-04（空意见仍 ok）、guidelines R-01-007/AC-04（无工具缝前置仍注入）、observer R-01-005/AC-06（计数仍累积制）、pi-texts R-01-003/AC-01（守则仍中文）、pi-texts R-01-001/AC-05（系统提示仍中文）、pi-texts R-01-001/AC-01 工具描述（描述仍中文）、usage「scout 计量」（台账无 scout 入口聚合，`byEntry.scout` undefined）。
  - 导入级（5 项，模块未建故失败；锚点标题已在测试源码内，断言待模块落地后执行）：materials.test.js / git-context.test.js / outcomes.test.js / scout.test.js（`ERR_MODULE_NOT_FOUND`）、redact.test.js 的 `R-02-004/AC-04` 测试（`redactAndCapText` 未导出，已改动态导入隔离，不波及该文件既有测试）。
  - npm test 全绿为 T-011 收敛信号之一；本清单随实现逐项转绿，全部转绿且必锚 AC 落齐后方可关闭。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：文案逐字对齐、连续计数语义、UUID 与结果前缀 | `test/pi-texts.test.js::R-01-003/AC-01 文案逐字等值`、`test/observer.test.js::R-01-005/AC-06 交错序列归位`、`test/consultation.test.js::R-01-001/AC-01 咨询成功返回含 adviceId 的意见文本`（UUID 形态/互不相同断言） |
| 异常 | 适用：空意见失败、abort 极性、预算值返回、manual 失败通告 | `test/consultation.test.js::R-01-001/AC-04 空意见判失败`、`test/consultation.test.js::R-01-001/AC-08 会话预算耗尽`、`test/commands.test.js::R-01-002/AC-03 手动咨询失败` |
| 边界配置 | 适用：默认值、threshold 下界、旧键保留、repoContext 旧值回落 | `test/config.test.js::R-02-001/AC-04 默认值对齐`、`test/config.test.js::R-02-001/AC-05 循环门阈值下界` |
| 副作用 | 适用：守则注入前置、门预通告可见性、manual 替换的取消终态 | `test/guidelines.test.js::R-01-007/AC-04 工具缝缺失不注入`、`test/gates.test.js::R-01-005/AC-09 门命中先送达预通告`、`test/commands.test.js::R-01-002/AC-04 进行中重复发起` |
| 安全 | 适用：tracked 移交校验（词边界 + 一次性消费 + 授权前置）与收窄语义 | `test/consultation.test.js::R-01-001/AC-07 tracked 移交校验`、`test/consultation.test.js::R-01-001/AC-06 仓库上下文档位只能收窄` |

## 终态与证据

- 实现: 八分片提交（38d09d1 config 默认值与七新键 → 7b628d3 引擎语义 UUID/空意见失败/parseAdvice 收敛/系统提示英文/remainingCalls/clamp → 6352da2 observer 连续签名制+波动归一 → 374b891 守则与工具面英文化/五参形态/Advisor (model) 前缀 → 0887d95 门文案与处置 → b00d0bc manual 替换语义+drain 修正+settings Schema → c229f1f 移交校验+trackedFileContent 授权键+SOLUTION 契约补正 → e271ac0 审核 findings 修复：预算 0=立即耗尽、lastAdvice 限 tool/manual、常量单源、白名单共享谓词、resetRepetition 改名、死代码移除、req 非变异）。
- 测试: npm test 全绿除账本余项（failing=6=ledger=6：R-02-004/AC-04 redact 与 T-014 scout 属 T-012/T-014 范围 + 4 个未建模块文件级条目）；账本自 14 项红基线逐项转绿并按协议移除；executed=201；anchor coverage passed（T-011 必锚 19 项全落齐，anchored=56）；agentmap lint passed；expected_fail_check 与 anchor_coverage 双 --self-test 精确断言常驻通过。
- SOLUTION 对照: 产品契约键清单与实现一致（含 trackedFileContent 补正）；需求追溯索引实现位置与实现收敛；无漂移项。
- commit: 38d09d1
- commit: 7b628d3
- commit: 6352da2
- commit: 374b891
- commit: 0887d95
- commit: b00d0bc
- commit: c229f1f
- commit: e271ac0
- review:
  - 审核方: 双轴独立评审子代理（Standards 轴 a4349a94、Spec 轴 7da274f7，code-review skill 流程）+ 窄分片子代理（9c910c60：observer/gates/commands/config，顾问 adv-14 裁定的增量回报协议）
  - 目的理解: 本 task 把插件契约/守则/引擎语义对齐 pi-advisor-flow 0.8.2（C-008/C-009 基线冻结）；reviewer 需核验英文文案与参数描述逐字一致、引擎语义（UUID/空意见失败/连续计数/波动归一）、门文案与处置矩阵、默认值与白名单，行为由锚定 AC-ID 测试钉住
  - 执行方式: code-review skill 双轴子代理按轮评审；评审基线 git diff 7a9b242...c229f1f（全量）→ 窄分片 e271ac0 四文件（逐文件增量回报、硬时限）
  - 问题与修复: Standards 六项——预算块缩进错位、工具面五参数描述与 render 兜底未引常量（TOOL_PARAM_DESCRIPTIONS/NO_ADVICE_TEXT 单源化）、白名单判定同形两处（提取共享谓词 advisorModelAllowed）、resetLoopKey 名不达意改名 resetRepetition、blocked 分支不可达 return 移除、consult 原位改写调用方 req 改归一副本；Spec 两项代码项——budget.maxPerSession=0 语义对齐 pi canConsult（0=立即耗尽）、lastAdvice 限 tool/manual 登记（gate 意见不入移交校验源）；Spec 一项计划形态偏差（lib/pi-texts.js 未独立成模块——逐字性由 pi-texts.test.js 对冻结基线断言保证，记低严重度计划偏差不改实现）。以上全部修复于 e271ac0，逐条对应。
  - 复审结论: 双轴最终报告均无硬功能违规，代码项 findings 已全部修复（修复即复审：三闸门复跑全绿 failing=6=ledger=6、executed=201、anchor coverage passed 必锚 19 项全落齐）。窄分片审核（observer/gates/commands/config）在关闭时仍在途，按 adv-14 三分式覆盖记录：独立已核（guidelines/ask-advisor/consultation/context/decision/index/settings 逐字达标；Standards 全 lib hunk 无硬违规）／机械 diff 已核（e271ac0 修复即对照报告逐条落地）／窄分片在途。其在途回报若发现行为偏差，作为 T-012/013 审核回补钩子输入；若不能交付，该覆盖缺口记为持久残留风险进入总终报（TODO.md 已落缺口项），不无声蒸发。
