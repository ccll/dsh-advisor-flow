---
doc-type: task
mutation: lifecycle
id: T-009
---
# staging 实弹验证与咨询链路残缝收敛

状态: active
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

（执行中）
