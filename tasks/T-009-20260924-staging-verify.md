---
doc-type: task
mutation: lifecycle
id: T-009
---
# staging 实弹验证与咨询链路残缝收敛

状态: completed
关联: R-01-001、R-01-003、R-01-004、R-01-005、R-01-006、R-02-002、R-02-005（验证面）
风险等级: standard

## 背景与目标

T-008 关闭时显性记录「真机四门实弹复验待宿主重启」为后续项。东家指示先在 staging 验证（不动生产宿主）。本 task 承载 staging 验证轮：以一次性 `af-verify` profile（headless 模板 + 本插件软链）驱动真实 agent 会话，实弹触发四门与 `ask_advisor`，暴露并收敛残余断缝，最终以全链路绿色结论支持生产宿主重启。

## 差距评估

首轮 staging 实弹（af-verify profile，真实 headless 会话）实测结果：

- 插件装载成功：`ask_advisor` 出现在执行者工具清单（T-008 的 tools 注册修复生效）。
- **新缺陷**：门命中后的咨询调用全部失败——`content.some is not a function`。根因：`GenerateOptions.messages[].content` 是 ContentBlock 数组（dsh-llm 消息契约），插件传字符串，适配器内容遍历处抛 TypeError；重试 1 次后以 ADVISOR_FAILED 显性化（错误处理与非阻断不变量按设计工作）。门处置因咨询不可用而 fail-open 放行，与探针观察（循环门第 3 次调用无延迟、无意见注入）自洽。
- 用量台账字段错位：宿主 TokenUsage 为 `cacheReadTokens`/`cacheWriteTokens`（离散计数），插件读不存在的 `cacheTokens`——缓存用量盲。
- 宿主自带 repeat-tool-reminder 在同模式正常触发（对照健康）。

## 收敛方案

- lib/consultation.js：llm.stream 的 messages content 改块数组（`[{type:'text',text}]`）；recordUsage 映射宿主 TokenUsage 字段（cacheReadTokens/cacheWriteTokens/totalTokens）。
- lib/usage.js：TOKEN_FIELDS 对齐宿主五字段（inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/totalTokens），台账与 totals 按字段表生成。
- lib/commands.js：/advisor status 用量行字段同步。
- 测试：消息 content 断言改块数组；usage 字段断言对齐宿主契约。
- 复验：af-verify staging 重跑探针（ask_advisor → 循环门 3× 等价 → 失败门 → 完成门），以探针 agent 观察报告 + 会话转写注入记录 + 宿主日志三面佐证。

## 测试计划

- `node --test` 全量绿；agentmap lint 全绿。
- staging 实弹探针（af-verify profile，一次性会话）四门逐门观测，结论记录于终态。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：真实 LLM 流上咨询往返与意见送达 | `test/consultation.test.js::R-01-001/AC-01` |
| 异常 | 适用：咨询失败显性化与 fail-open（staging 实测 ADVISOR_FAILED 路径） | `test/consultation.test.js::R-02-005/AC-01 任何失败路径都不得向调用方抛出未处理异常` |
| 边界配置 | 适用：headless 组合（settings 桥在场、卡片/命令缝缺失降级） | `test/observer.test.js::R-02-005 sessionOf 宽窄两种形态` |
| 副作用 | 适用：用量字段按宿主 TokenUsage 离散承载 | `test/usage.test.js::R-02-002/AC-02` |

## 终态与证据

- 实现: staging 实弹验证轮（af-verify 一次性 profile，headless 组合 + 本插件软链）收敛三处断缝——① `llm.stream` 请求的 `messages[].content` 改 ContentBlock 数组（宿主 dsh-llm 消息契约；原字符串 content 在适配器内容遍历抛 `content.some is not a function`，即首轮探针 ADVISOR_FAILED 的根因）；② 用量台账字段对齐宿主 TokenUsage（`cacheReadTokens`/`cacheWriteTokens`/`totalTokens` 离散计数，原 `cacheTokens` 字段在宿主契约中不存在）；③ ask_advisor 渲染输出补 adviceId 行（首轮实测意见文本可回查性缺失）。
- 测试: `npm test` 177/177 全绿；`python3 tools/agentmap_lint.py --report` 全绿（test-anchored 30/30）；staging 实弹三轮探针（af-verify profile 真实会话）：
  - 第二轮（咨询形状修复后）：循环门实弹通过——3 次等价 bash 第 3 次执行前 17s 同步咨询、`[advisor:nit]`（adv-1）送达、动作放行；完成门实弹通过——回合收口触发咨询、`[advisor:concern]`（adv-2）经 steer 送达、宿主续步一轮后闭合（去重有界，恰好一次咨询）。
  - 第三轮：ask_advisor 返回含 `（adviceId: adv-1）` 行；失败门实弹通过——`read` 不存在路径首次 `isError:true` 计数后，同参二次调用执行前 13s 咨询、`[advisor:nit]` 送达后放行。
- SOLUTION 对照: 咨询消息契约与用量字段契约补入横切约束载体清单（T-008 轮已建立该节，本轮两处增补）；PRD 零改动；map-code 无漂移。
- 已知事实与边界（记录，非缺陷）: bash 工具的非零退出在宿主契约中 `isError:false`（退出码在内容里）——失败门对 shell 级失败不敏感，仅对真正 error 的工具结果计数（staging 实测：read isError 触发、exit 7 不触发）；plan 门真机流程（exit_plan_mode 经 plan mode）留待东家日常使用验证，判定逻辑已由单测与接线测试覆盖。
- 残余与后续: 咨询素材装配缺口——顾问收到的素材在默认隐私档位下仅含问题文本，无会话历史/工作摘要（收口评审时顾问报「无可评审素材」）；SOLUTION 会话观察模块声称维护转写增量但实现未投喂——是否立项补齐（涉及隐私档位与素材装配语义）待东家裁决，暂记 TODO。
- commit: 8d3410d
- commit: 72e513b
- commit 证据注记: 咨询契约修复最初以 ec70ff3 提交（正文引 T-008——立项时序失误），随后 T-009 task 书经 amend 并入该提交形成 8d3410d；按 Git 纪律不重写历史，以本条目映射 ec70ff3 → 8d3410d 供反查。
- review:
  - 审核方: 双轴独立评审子代理（Standards 轴、Spec 轴，code-review skill 流程；T-009 增量评审一轮，覆盖 8d3410d 咨询契约修复与 72e513b 渲染修复）
  - 目的理解: 本 task 目标是在 staging 真实 LLM 流上验证 T-008 修复并收敛残余断缝；reviewer 需核验咨询消息契约与宿主 GenerateOptions 一致、用量字段与 TokenUsage 一致、staging 实测发现均有回归钉或显性记录
  - 执行方式: code-review skill 双轴并行子代理；评审基线 2aecfc3..72e513b（含 ec70ff3 咨询形状修复、72e513b adviceId 渲染）
  - 问题与修复: 实现方自查修复——content 块数组（staging ADVISOR_FAILED 实证）、usage 五字段离散承载、adviceId 渲染回查行；测试断言同步改形（messages content 块数组、TokenUsage 五字段、render adviceId 行）
  - 复审结论: 复审通过，无残余发现——五项发现全部 confirmed 已解决（SOLUTION 两行契约对照 dsh-llm types.d.ts 事实准确、TOKEN_FIELDS 单点维护、hash 映射注记、TODO 登记、totalTokens/reasoningTokens 断言算术复核）；残余风险两条已显性记录（素材装配缺口待东家裁决、单测层无宿主适配器形状桩——请求向契约由 staging 实弹钉住）
