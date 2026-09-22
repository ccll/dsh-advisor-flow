---
doc-type: task
mutation: lifecycle
id: T-002
---
# 测试锚定迁移：剩余 AC 锚点补齐

状态: active
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
- 跨任务交接项（自 T-001 终态移交）：宽松 JSON balancedObjects 帧解析（lib/consultation.js）为自研解析器，接入真实模型输出时须验证帧误识别边界（已覆盖空 note/非帧 JSON/markdown 围栏三类单测）。
- 联调验证清单（自 T-003 双轴评审移交，接入真实 dsh 运行时后逐项实测并记录结论）：
  - `tools/result` 与 `session/event` 双缝是否重复投递同一工具结果；**两缝载荷是否共享可拼接的执行标识（execId/callId/seq）**——若实测无共享标识，评估在调用时生成 idempotency token 由双缝回传的可行性；当前实现为「有标识去重、无标识保守逐次计数」的临时偏置，实测后收敛。
  - 双缝去重的键宽语义实测：同工具两次不同执行不得被误并为一次（单测已钉该语义，实测验证真实载荷满足键假设）。
  - 观察器假设的事件形状实测：result 失败判定字段（error/ok/success）、压缩/重写事件名——错向会把失败记成功。
  - block-session 兑现路径（修复后已收敛）：保证路径仅 deny(reason)；会话停止经注入钩子——实测宿主是否存在 agent cancel 类缝、钩子命中后宿主是否真正停止执行（R-01-004/AC-03 兑现方式按实测结论最终确认）。
  - fail-open 放行形态统一（T-003 复审遗留轻微项）：handlePreExecute 顶层 catch 当前返回裸 allow（终止瀑布跳过后续监听者），应统一为委托式放行（next 存在时委托）——随 T-004 修复轮收敛，属纯代码级修复。
  - approver 宿主缝实际可用性（ctx.approval 或等价服务）：当前 ask 策略在无 approver 时 fail-open。
  - delivery source 负载形状（kind/plugin/form/summary）与宿主注入消息渲染的兼容性。
  - immuneTurns 冷却的 turn-end 事件源修复后，实测冷却窗口按 stepped turn 递减。

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
