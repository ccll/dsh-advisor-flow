---
doc-type: task
mutation: lifecycle
id: T-012
---
# T-012 咨询素材出境链（六区装配 + git 上下文 + 附件授权 + 脱敏对齐）

风险等级: high
状态: completed
关联: R-02-004、R-02-006（C-002 补全；C-008 ⑥⑨）

## 背景与目标

审计 G-1（最高优先级）：移植版三咨询入口零素材出境，C-002 声明的可观察行为不成立，设置卡档位宣传失真（G-2）。本 task 建立素材出境单一通道：会话脉络、git 上下文、偏好映射、草稿、附件，六区共享预算，先脱敏后截断，per-tool 披露策略。

## 差距评估

- C-1/G-1：素材链整体缺失（装配器无数据源、观察器无脉络缓冲、无 git 收集）。
- C-2：git 上下文构建器缺失（name-status/shortstat/patch、转义、5s/16MB 子进程预算、空树 fallback）。
- C-3：档位枚举 off|summary|full 与共享预算（git=min(gitMax,⌊ctxMax/2⌋)）缺失。
- C-4：attachments 机制缺失（归属校验、拒 symlink/越界/NUL、单文件 8KB、总 24KB、tracked 移交验证）。
- C-5/C-6：脱敏缺 PEM/URL 凭据/ASIA/aws_* 四类；顺序应先脱敏后截断。
- C-7：per-tool 披露策略缺失（东家裁定纳入）。
- C-8：会话脉络预算口径（contextMaxChars 共享、保新尾+omission 标记、compaction 行、行/字节双上限）缺失。
- G-2：设置卡 hint 文案随实现收敛修正。

## 收敛方案

- **spike 先行**：会话脉络来源双轨裁决——主轨 dsh-session-query（装配时查询会话条目，含 extractSessionEventText 形态核验）；备轨 observer 事件增量缓冲。spike 结论落 RATIONALE（如需新 C 条目）后再写装配单测。
- 有序面重建算法（spike 预研定稿，2026-09-25）：过滤 SurfaceEventType 消息产出事件（三类 message 面；system 面的 replace 节点按压缩摘要承载）→ 按 seq 升序应用 surfaceOp（append 追加；`{op:'replace',startSeq,endSeq}` 以替换节点覆盖被替换区间——compaction 压缩语义）→ 得到有序消息节点流 → 按 pi 会话渲染口径（user/assistant/tool-result 逐条 + per-tool 披露策略 + 行/字节双上限）产出会话脉络文本；工具名经 tool/call 事件按 callId 配对（append 追加；`{op:'replace',startSeq,endSeq}` 以 sourceEventSeqs 引用的源事件重建被替换区间——compaction 压缩语义）→ 得到有序消息节点流（类型/turn/step/data）→ 按 pi 会话渲染口径（user/assistant/tool-result 逐条 + per-tool 披露策略 + 行/字节双上限）产出会话脉络文本；工具名经 tool/call 事件按 callId 配对。边界：`ignorable` 事件跳过；未识别非 ignorable 类型 fail-closed 拒绝重建（宿主契约）。
- lib/materials.js（新）：六区装配、advisorMessageText 逐字布局（XML 标签+不可信注记+转义+空兜底）、预算切分、per-call clamp。
- lib/git-context.js（新）：collectGitContext 语义移植（node child_process 执行 git，5s/16MB 预算、五态注记、redact 先于 cap）。
- lib/attachments.js（新）：tracked/untracked 读取器（git ls-files 归属校验、安全拒绝、预算、redactAndCapText）。
- lib/redact.js：补 PEM（含未闭合兜底）/URL 凭据/ASIA/aws_* 四类；标记改 `[REDACTED SECRET]`；口径对齐（Bearer 下限、赋值含引号值、整段替换策略核对 pi）。
- consultation.js/gates/index.js/commands.js：三入口接入装配器；门咨询全量素材。
- observer.js：工具结果内容环形缓存（行/字节双上限、toolPolicies 过滤）。
- 待核项：pi 宿主 tool-result 上限常量数值（grep 冻结制品 dist 内联值）。

## 测试计划

- 预算切分边界用例（零变更、超大草稿、附件溢出）；六区布局快照对照 pi advisorMessageText；脱敏六模式 + 跨截断边界负向断言；staging dump 出站请求对照 pi 契约（回归钉）。
- 测试锚定 R-02-004/AC-03~06、R-02-006/AC-01~05。
- spike 判据与时间盒（会话脉络来源，≤1 个工作日）：通过=dsh-session-query 可按会话枚举条目且能取得文本与工具名元数据（manifest 分组所需粒度）；失败=任一能力缺失或形态不符 → 记 RATIONALE 改用事件增量轨并回报东家确认取舍，不静默换轨。
- spike 预研结论（2026-09-25 主线程只读核查，判据①已满足）：宿主 `dsh-session-query` 以 cordis 模块增强暴露 `ctx.sessionQuery` 服务（SessionQueryEngine），`observeSession(sessionId)` 返回 `SessionObservation`——含完整不可变 `events: SessionEvent[]`（判别联合：seq/time/data/ignorable）与 `header`/`cursor`/`projections`；`SurfaceEventType = system/message | user/message | assistant/message | tool/result` 携带 `surfaceOp`（append 与 compaction 的 replace 区间）与 `sourceEventSeqs`——按序应用 surfaceOp 即得与 pi 分组所需等价的有序消息面，`tool/result` 事件可区分工具身份。判据②执行者模型解析见 T-014。剩余工作：staging 实证 observeSession 在插件 scope 的可达性（ctx 直属 or root.get）与 tool/result data 的工具名字段形态。
- spike 数据形态补全（2026-09-25 第二轮只读核查，判据①证据链闭合）：`tool/result` data = `{ turn, step, message: ToolResultMessage, error?: {name, code}, meta? }`（工具身份与内容块经 ToolResultMessage 承载，error 仅 isError 时存在）；`assistant/message` data = `{ turn, step, message: AssistantMessage, stream: AssistantStreamRecord[], usage?, interrupted? }`；`user/message` data = UserMessage；`system/message` 为模型可见系统面节点。分组所需全部元数据（类型判别、turn/step 序、成败、内容）在事件流内齐备，manifest 分组可行。
- spike 工具身份补充（2026-09-25 第三轮核查）：`ToolResultMessage.source = { kind: 'tool', callId }`、`ToolResultBlock = { toolCallId, content, isError? }`——消息体不携带工具名；工具名经 `tool/call` 事件（`{ callId, name, arguments }`）按 callId 配对取得。per-tool 披露策略与 pi 的按工具名渲染均以该配对实现。服务接入形态：`SessionQueryEngine.static inject = ['sessions']`，插件侧按既有条件 inject 子上下文模式接入 `sessionQuery`。
- 必锚 AC（收敛闸门）：R-02-006/AC-01～05、R-02-004/AC-03～06 全部有测试锚点方可关闭。
- 不变量执行映射：出境单一通道 → 素材装配器为唯一出境口，以 import 边界检查固化（gates/commands/tools 不得直接 import llm 或旁路拼装消息）+ R-02-006/AC-01 锚点；先脱敏后截断 → `test/redact.test.js::R-02-004/AC-04 先脱敏后截断`。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：六区装配、共享预算切分与不可信注记 | `test/materials.test.js::R-02-006/AC-01 六区结构与注记` |
| 异常 | 适用：git 失败/非仓库态注记、附件归属校验拒绝 | `test/git-context.test.js::R-02-006/AC-02 五态注记` |
| 边界配置 | 适用：零预算、关闭档、clamp 收窄与附件溢出切分 | `test/context.test.js::R-02-006/AC-03 预算切分`、`test/materials.test.js::R-02-006/AC-04 空素材兜底` |
| 副作用 | 适用：出站请求负向断言（无密钥形状残留） | `test/redact.test.js::R-02-004/AC-04 先脱敏后截断` |

## 终态与证据

- 实现: 素材出境链四模块 + 引擎装配——lib/materials.js（六区布局逐字 + advisorGitContextBudget）、lib/git-context.js（五态采集/注记/clamp）、lib/redact.js 增 capRepositoryContext 与 redactAndCapText（AC-04）、lib/tool-result-cap.js（capToolResult 头尾双限 + capUtf8Bytes）、lib/conversation-source.js（surface 重建 + 渲染 + 省略标记）、lib/consultation.js 六区管线集成（getSessionEvents/getCwd 缝、collectFileEntries 归属校验、偏好区、终检 redactText）、lib/context.js 退役。
- 测试: npm test 216/216 全绿；staging 实弹（af-verify profile）：探针 v10 全绿（顾问从会话脉络确认 bash 命令与输出、仓库注记到达、UUID 回查行）；三断缝（引擎接线缺失/工具面 exec 会话身份/ToolResultBlock 内层正文）经探针 v6-v9 逐层定位收敛（4dc6684）；anchor coverage passed（anchored=65/65 全 PRD AC 锚定）；expected-fail 全绿（账本清零、baselineExecuted=216）；account 锚点——materials/git-context/conversation-source/context/redact 五测试文件直锚 R-02-006/AC-01~05、R-02-004/AC-01/03~06。
- SOLUTION 对照: 产品契约键清单与实现一致（含 userPreferences 键补正同提交）；需求追溯索引实现位置（lib/materials.js、lib/git-context.js、lib/redact.js、lib/conversation-source.js、lib/tool-result-cap.js、lib/consultation.js）与实现收敛；无漂移项。
- commit: d1bff98
- commit: c4c2709
- commit: 4ecd756
- commit: 1106cdb
- review:
  - 审核方: 窄分片独立审核子代理（acfa1bfb：五模块逐轮增量回报 + 最终汇总，rubric 三级裁决 A/B/C；顾问 ask_advisor adv-17 复核其四条修正全部采纳）
  - 目的理解: 素材出境链/回写/Scout 对齐 pi 0.8.2（C-008/C-009 基线冻结）；核验六区布局/五态采集/HMAC/策略渲染逐字、PRD R-02-006/R-01-008/R-02-004 各 AC 行为由锚定测试钉住
  - 执行方式: 五轮逐模块静态逐字对照（pi 参照 + PRD AC + SOLUTION + 宿主类型契约），只报告不修复；基线冻结 1106cdb 并声明漂移
  - 问题与修复: A 级 4 项（gitContext 默认档→批次一；附件四道防线→批次一；toolResultMaxLines→批次二；textFrom 递归→staging 实弹发现并修）；B 级 10 项（B1/B3/B4/B6/B7/B10 修复；B2 显性拒绝消解条件性；B5/B8/B9 记档取舍保留）；C 级 4 项全修（SOLUTION#Scout 策展 章节新增、DOMAIN 词汇登记、lib/attachments.js 引用修正、fail-closed 兑现）；复审清单遗留①字节口径→f27eb5a 附件链与偏好区全字节口径 + ls-files 双向归一 + submodule 160000 排除
  - 复审结论: （acfa1bfb 复审在途——回报后填写最终结论；复审遗留项：tool-result-cap 默认行数 200 待联调核定已记档）
