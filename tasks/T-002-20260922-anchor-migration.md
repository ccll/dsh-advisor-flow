---
doc-type: task
mutation: lifecycle
id: T-002
---
# 测试锚定迁移：剩余 AC 锚点补齐

状态: active
关联: R-01-002、R-01-003、R-01-004、R-01-005、R-01-006、R-02-005（15 个未锚定 AC 的归属需求）
风险等级: standard

## 背景与目标

strict 测试锚定要求 PRD 全部 AC-ID 在测试中锚定；T-001（咨询核心）落地后尚有 18 个未锚定——其中 15 个属于门控服务、命令面与门 fail-open 的实现范围，另 3 个（R-01-001/AC-03、R-02-004/AC-01、R-02-004/AC-02）是 EARS 句式修正后才被 lint 计数的既有咨询语义（migration 模式曾掩盖其缺失）。本任务承载该迁移窗口：随后续实现任务补齐锚点，全部落地后切回 strict 并关闭本任务。

## 差距评估

- `agentmap_lint.py --report`：test-anchored=12/30。
- 未锚定清单：R-01-001/AC-03（咨询引擎重试预算可配）、R-02-004/AC-01..02（裁剪与排除语义，现有 context 测试需补斜杠锚点）；R-01-002/AC-01..02（命令面）；R-01-003..006 全部 AC（门控服务）；R-02-005/AC-02（门组件 fail-open）。
- 上述需求的实现尚未开始（T-003 门控与观察、T-004 命令与卡片待立项）；R-01-001/AC-03 与 R-02-004 两项随修复轮补齐。

## 收敛方案

- 后续实现任务（门控、命令、卡片）以测试先行落地，测试名携带对应 `<R-ID>/AC-nn` 锚点。
- 全部 27 个 AC 锚定后：CONVENTIONS 切回 strict，本任务转 completed（证据 = lint 计数）。
- 本任务只承载锚点迁移，不承载任何实现设计（设计归各实现任务）。

## 测试计划

- 不新增独立测试；锚点随 T-003/T-004 的测试文件落地。
- 每次提交后运行 `python3 tools/agentmap_lint.py --report` 观察 test-anchored 计数收敛。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：lint 报告 test-anchored 计数达到 27/27 | `tools/agentmap_lint.py::test-anchored`、`test/consultation.test.js::R-01-001/AC-01` |
| 异常 | 适用：未知锚点（测试名与 PRD 不符）会被 lint 拒绝 | `tools/agentmap_lint.py::unknown` |
| 边界配置 | 不适用：迁移任务无配置面 | — |
| 副作用 | 不适用：迁移任务无运行时行为 | — |
| 跨实现 | 不适用：单一实现 | — |

## 终态与证据
