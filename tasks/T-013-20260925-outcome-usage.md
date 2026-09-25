---
doc-type: task
mutation: lifecycle
id: T-013
---
# T-013 回写与用量状态面（record_advisor_outcome + 逐次明细 + 决策统计）

风险等级: standard
状态: active
关联: R-01-008、R-02-002、R-02-003（C-008 ⑧）

## 背景与目标

审计 G-3/G-17：outcome 回写工具整体缺失（engine 存根无消费方）；逐次用量无查询面（PRD R-02-002 已承诺逐次）；状态缺门决策统计与干预计数。东家裁定 outcome 对齐实现（JSONL+HMAC，密钥插件生成，不与 pi 账本互读）。

## 差距评估

- record_advisor_outcome 工具面缺失；ADDITIONS/VALIDATIONS 枚举（followed|not-followed|unknown / passed|failed|not-run|unknown）；一次性 reserve/commit/release。
- 落盘：JSONL + HMAC 哈希 + 跨进程锁 + 1MB 轮转 + outcomeLogging 开关（默认 false）。
- usage.js records() 无消费方；status 缺逐次明细、剩余次数、决策统计（proceed/revise/blocked 计数）与干预计数。

## 收敛方案

- lib/outcomes.js（新）：appendOutcome（HMAC、锁、轮转）；密钥生成存插件数据目录。
- lib/tools/record-outcome.js（新）：工具面（英文描述逐字）。
- lib/consultation.js：意见账本完整化（issue 时登记 trigger/normalizedQuestion/draft 标记）。
- lib/status.js、lib/commands.js、lib/client/*：逐次明细、剩余次数、决策统计呈现；设置卡 outcomeLogging 开关。

## 测试计划

- 回写往返（reserve→commit 成功；重复回写拒绝；release 后可重试）；禁用态提示；HMAC 不落明文断言；轮转触发用例。
- status 逐次明细/剩余次数/决策统计断言。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：回写往返与枚举校验 | `test/outcomes.test.js::R-01-008/AC-01 回写成功确认` |
| 异常 | 适用：未知/重复 adviceId 拒绝、禁用态 | `test/outcomes.test.js::R-01-008/AC-02` |
| 边界配置 | 适用：outcomeLogging 关闭、轮转边界 | `test/outcomes.test.js::R-01-008/AC-04` |
| 副作用 | 适用：不落明文（HMAC） | `test/outcomes.test.js::R-01-008/AC-03` |

## 终态与证据

（待实现）
