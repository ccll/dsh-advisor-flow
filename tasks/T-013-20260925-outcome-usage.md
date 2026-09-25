---
doc-type: task
mutation: lifecycle
id: T-013
---
# T-013 回写与用量状态面（record_advisor_outcome + 逐次明细 + 决策统计）

风险等级: standard
状态: completed
关联: R-01-008、R-02-002、R-02-003（C-008 ⑧）

## 背景与目标

审计 G-3/G-17：outcome 回写工具整体缺失（engine 存根无消费方）；逐次用量无查询面（PRD R-02-002 已承诺逐次）；状态缺门决策统计与干预计数。东家裁定 outcome 对齐实现（JSONL+HMAC，密钥插件生成，不与 pi 账本互读）。

## 差距评估

- record_advisor_outcome 工具面缺失；ADDITIONS/VALIDATIONS 枚举（followed|not-followed|unknown / passed|failed|not-run|unknown）；一次性 reserve/commit/release。
- 落盘：JSONL + HMAC 哈希 + 跨进程锁 + 1MB 轮转 + outcomeLogging 开关（默认 false）。
- usage.js records() 无消费方；status 缺逐次明细、剩余次数、决策统计（proceed/revise/blocked 计数）与干预计数。

## 收敛方案

- lib/outcomes.js（新）：appendOutcome（HMAC、锁、轮转）；密钥生成存插件数据目录。
- pi 0.8.2 落盘机制逐项（2026-09-25 主线程源码提取，实现直接采用）：盐=32 字节随机文件 `advisor-outcomes-salt`（agent 数据目录，0600/目录 0700，link() 原子发布 + EEXIST 重试 20 次）；锁=`advisor-outcomes.jsonl.lock` wx 独占创建，200 次 × 5ms 重试，30s 陈旧锁同文件核验后回收；摘要=HMAC-SHA256(盐).update(advice).digest('hex')**截断 16 hex**——注意本 task 的 test/outcomes.test.js 脚手架现断言 64 hex，实现时须改为 16 hex 与 pi 一致；记录形如 `{ adoption, adviceHash, timestamp, trigger, v: 1, validationStatus }`（意见原文不落盘）；日志=advisor-outcomes.jsonl，1MB 轮转；appendOutcome 为 best-effort 全局遥测。
- lib/tools/record-outcome.js（新）：工具面（英文描述逐字）。
- lib/consultation.js：意见账本完整化（issue 时登记 trigger/normalizedQuestion/draft 标记）。
- lib/status.js、lib/commands.js、lib/client/*：逐次明细、剩余次数、决策统计呈现；设置卡 outcomeLogging 开关。

## 测试计划

- 回写往返（reserve→commit 成功；重复回写拒绝；release 后可重试）；禁用态提示；HMAC 不落明文断言；轮转触发用例。
- status 逐次明细/剩余次数/决策统计断言。
- 必锚 AC（收敛闸门）：R-01-008/AC-01～06、R-02-002/AC-04～05、R-02-003/AC-03 全部有测试锚点方可关闭。
- 不变量执行映射：回写至多一次（范围=每个 adviceId 至多一条回写记录）→ reserve/commit 单向门 + R-01-008/AC-02 锚点；HMAC 语义（密钥独立生成、缺失或不可写 fail-closed、单行规范化 JSON、同置仅防篡改）→ R-01-008/AC-03、AC-06 锚点；预留崩溃窗口释放 → R-01-008/AC-05 锚点。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：回写往返与枚举校验 | `test/outcomes.test.js::R-01-008/AC-01 回写成功确认` |
| 异常 | 适用：未知/重复 adviceId 拒绝、禁用态 | `test/outcomes.test.js::R-01-008/AC-02` |
| 边界配置 | 适用：outcomeLogging 关闭、轮转边界 | `test/outcomes.test.js::R-01-008/AC-04` |
| 副作用 | 适用：不落明文（HMAC） | `test/outcomes.test.js::R-01-008/AC-03` |

## 终态与证据

- 实现: lib/outcomes.js（createOutcomeStore：HMAC-SHA256 截断 16 hex、盐临时文件 + link() 原子发布、wx 锁 200×5ms + 30s 陈旧回收、1MB 轮转、chmod 0o600）；lib/tools/record-outcome.js（advisor_record_outcome 工具：一次性回写/禁用提示/未知拒绝不抛出）；lib/consultation.js 增意见账本（reserve/commit/release + dispose 释放未决，AC-05）与 outcomeStore 选项（fail-closed）；lib/status.js 快照增 usageRecords/budgetRemaining/gateDecisions；lib/index.js status 复合引擎面；lib/usage.js ENTRY_TYPES 增 scout。
- 测试: npm test 216/216 全绿；account 锚点——test/outcomes.test.js（AC-01~04 + AC-05 dispose 释放 + AC-06 fail-closed）、test/status.test.js（R-02-002/AC-04 逐次明细、AC-05 预算剩余、R-02-003/AC-03 门决策统计）；HMAC 期望 64→16 hex 修正（pi outcomes.ts:125 spike 结论）。
- SOLUTION 对照: 产品契约与实现一致；需求追溯索引实现位置（lib/outcomes.js、lib/tools/record-outcome.js、lib/status.js、lib/usage.js、lib/consultation.js）与实现收敛。
- commit: 843a388
- commit: 1106cdb
- review:
  - 审核方: 窄分片独立审核子代理（acfa1bfb，outcomes+record-outcome 模块轮 + 复审批次复审）
  - 目的理解: 回写存储/工具/状态面按 R-01-008 与 R-02-002/003 契约对齐 pi 0.8.2；HMAC 语义、一次性回写、禁用 fail-closed、用量明细/剩余/门统计呈现
  - 执行方式: 逐模块静态逐字对照（pi outcomes.ts 全文）+ 复审（基线 1106cdb..23fae76）+ 测试实跑（本复审运行 npm test 全绿）
  - 问题与修复: 枚举越界静默归 unknown→显性拒绝（消解宿主 enum 条件性）；工具名 advisor_record_outcome→record_advisor_outcome（对齐 SOLUTION）；chmod 吞错→显性化；hmacKey 路径 mkdir；commit 失败释放预留（AC-05 延伸）；ADOPTIONS/VALIDATIONS 单源；R-02-002/AC-04~05、R-02-003/AC-03 的 status/gates/index 补全经复审逐条对 PRD 成立（无发现问题）
  - 复审结论: 复审达标（B10 群与 B2 条件性全部消解）；残余风险：outcome 台账持久化路径（memory-only 待 settings 承载，SOLUTION 已注）
