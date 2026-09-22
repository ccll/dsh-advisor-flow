---
doc-type: task
mutation: lifecycle
id: T-002
---
# 测试锚定迁移：剩余 AC 锚点补齐

状态: completed
关联: R-01-002、R-01-003、R-01-004、R-01-005、R-01-006、R-02-005（14 个未锚定 AC 的归属需求）
风险等级: standard

## 背景与目标

strict 测试锚定要求 PRD 全部 AC-ID（30 个）在测试中锚定。T-001（咨询核心）与其修复轮落地后 test-anchored=16/30，剩余 14 个未锚定 AC 全部属于门控服务、命令面与门 fail-open 的实现范围。本任务承载该迁移窗口：随后续实现任务补齐锚点，全部落地后切回 strict 并关闭本任务。

## 差距评估

- `agentmap_lint.py --report`：test-anchored=16/30（演进：12/27 → EARS 修正后 12/30 → 修复轮 17/30 → 锚点真实性修正 16/30）。
- 未锚定清单：R-01-002/AC-01..02（命令面，AC-01 已由引擎语义部分锚定待命令面复核）；R-01-003..006 全部 AC（门控服务，12 项）；R-02-005/AC-02（门组件 fail-open）。
- 上述需求的实现尚未开始（T-003 门控与观察、T-004 命令与卡片待立项）。

## 收敛方案

- 后续实现任务（门控、命令、卡片）以测试先行落地，测试名携带对应 `<R-ID>/AC-nn` 锚点。
- 全部 30 个 AC 锚定后：CONVENTIONS 切回 strict，本任务转 completed（证据 = lint 计数）。
- 本任务只承载锚点迁移，不承载任何实现设计（设计归各实现任务）。
- 交接项去向：联调验证清单已整体移交 T-005（整装真实联调）任务书「联调验证清单」节——含 T-001 移交的 balancedObjects 帧解析项与 T-003 双轴评审移交的全部运行时实测项；随真实运行时实测逐项销项，本任务关闭不影响其存续。

## 测试计划

- 不新增独立测试；锚点随 T-003/T-004 的测试文件落地。
- 每次提交后运行 `python3 tools/agentmap_lint.py --report` 观察 test-anchored 计数收敛。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：lint 报告 test-anchored 计数达到 30/30 | `tools/agentmap_lint.py::test-anchored`、`test/consultation.test.js::R-01-001/AC-01` |
| 异常 | 适用：未知锚点（测试名与 PRD 不符）会被 lint 拒绝 | `tools/agentmap_lint.py::unknown` |
| 边界配置 | 不适用：迁移任务无配置面 | — |
| 副作用 | 不适用：迁移任务无运行时行为 | — |
| 跨实现 | 不适用：单一实现 | — |

## 终态与证据

- 实现: 无运行时代码——纯锚点迁移与映射窗口管理；CONVENTIONS 随本提交由 migration T-002 切回 strict。
- 测试: `agentmap_lint.py --report` test-anchored 30/30、warnings 清零（收口前独立复跑实证：npm test 122/122、lint exit 0）。
- SOLUTION 对照: 不适用（无方案变化；迁移过程中 EARS 句式修正使 AC 计数 27→30，属 PRD 措辞校准）。
- commit: c62fe17
- commit: 1ed08a2
- commit: b5d82eb
- commit: 3ee4383
- review:
  - 审核方: Standards 轴独立评审代理（eb77d407-3912-4c16-86c8-da1c1997a42d），同 T-001/T-003/T-004 审核方
  - 目的理解: 迁移窗口的成果是「锚点真实性」——锚点必须指向真实覆盖而非虚报，lint 机械计数可信；reviewer 各轮复审均以此为目的核验
  - 执行方式: 随 T-001/T-003/T-004 各实现轮的 Standards 轴复审逐轮核验（17→16 虚报锚点移除、空格锚点改正、新增测试锚点语义相符性），lint 机械校验为可执行证据
  - 问题与修复: 迁移窗口内发现并修正三类锚点失真（空格写法规避、引擎层虚报 AC 覆盖、migration 模式掩盖的真实缺口 15→18 显形）；全部经对应轮修复
  - 复审结论: Standards 轴各轮均确认锚点真实性纪律成立；30/30 达成后 strict 恢复，lint 全绿无 warning
