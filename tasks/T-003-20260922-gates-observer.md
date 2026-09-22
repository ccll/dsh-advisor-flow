---
doc-type: task
mutation: lifecycle
id: T-003
---
# 门控服务与会话观察

状态: active
关联: R-01-003、R-01-004、R-01-005、R-01-006（四门）、R-02-005/AC-02（门 fail-open）；关联决策 C-001、C-002
风险等级: high

## 背景与目标

按 SOLUTION 落地移植的核心价值：工具动作前置门。注册 `tools/pre-execute` waterfall 监听，实现计划/失败/循环/完成四门的判定与处置（review/ask/block 策略），配套会话观察器与意见送达。本任务仍为宿主侧可注入单元（不接真实 dsh 运行时），dsh 事件到门状态的接线按 SOLUTION 契约实现、以注入桩测试。

## 差距评估

- lib/ 无 gates/、observer、delivery 模块；lib/index.js 有显式 TODO 指向本任务。
- dsh 接缝事实（handoff 已验证）：`ctx.on("tools/pre-execute", async (exec, next) => …)` 可返回 `allow/ask/deny(reason)`；工具生命周期事件 `tools/pre-execute|execute|post-execute|result` 与 `session/event`（必须 `{global:true}`）提供观测面；`agent.inject`（非唤醒）/`agent.steer`（唤醒）为意见通道。参考实现：`~/.dsh/profiles/web/node_modules/dsh-hooks-claude-code/lib/index.js:248`（PreToolUse 桥）与 dsh-advisor lib/delivery.js（immuneTurns 模式）。

## 收敛方案

- `lib/observer.js`：`createSessionObserver({ global: true } 语义的事件订阅接口)`——消费工具调用/结果事件，维护每会话 GateState（失败计数表：工具名→连续失败数；循环等价表：工具名+规范化参数 hash→计数与首见序；压缩/重写事件重置）。规范化参数：键排序 + JSON 序列化 + 长字符串截断。
- `lib/gates/index.js`：`createGateEngine({ consult, policyLookup, logger, clock, timers })`——pre-execute 处理器：命中判定（按门序 plan→loop→failure→completion）→ 命中即同步 await 咨询（entry:'gate'）→ 按策略处置：review 放行+意见经送达；ask 委托注入的 approver；block 且 severity=blocker → deny(reason=意见摘要)；无 blocker → 放行+送达。咨询异常/超时 fail-open（放行+logger.error 留痕）。 deny 时循环/失败计数重置，避免同参数永久卡死。
- `lib/gates/plan.js|loop.js|failure.js|completion.js`：各门独立判定函数（纯函数，输入 GateState+exec，输出 hit/miss）；计划门锚定 `exit_plan_mode` 名单（可配），完成门锚定 `concludesTurn` 工具名单（可配）。
- `lib/delivery.js`：意见送达——severity→channel（nit→inject 非唤醒；concern/blocker→steer 唤醒）；immuneTurns 冷却（送达后 N 个 stepped turn 内不再送同级）；agent 映射注入。
- `lib/index.js`：把门引擎/观察器/送达接入 bundle 入口（替换 T-001 的 TODO），仍保持可注入与 fail-loud 注册。
- 咨询工具豁免：`ask_advisor` 自身调用不触发门（防自递归）。
- 配置消费：gates.*（enabled/policy/threshold）从 config.js 既有解析取用；applyConfig 时门状态按 SOLUTION signature 规则重建。

## 测试计划

- 注入假 exec 流与假咨询引擎，覆盖并锚定：R-01-003/AC-01..03、R-01-004/AC-01..03、R-01-005/AC-01..03、R-01-006/AC-01..03、R-02-005/AC-02（门 fail-open）。
- 重点场景：命中→blocker→deny 且原因回注；review 放行且意见送达；ask 策略人工拒绝→deny；咨询超时→放行+留痕；门组件抛错→放行+留痕；循环 deny 后计数重置；压缩重写重置状态；`ask_advisor` 豁免。
- 锚点斜杠形式；lint warnings 不得出现 unknown anchor；目标 test-anchored ≥ 28/30（仅 R-01-002/AC-01..02 命令面留 T-004）。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：四门命中→评审→按策略处置 | `test/gates.test.js::R-01-003/AC-01`、`test/gates.test.js::R-01-005/AC-01` |
| 异常 | 适用：咨询失败 fail-open、门组件异常放行 | `test/gates.test.js::R-02-005/AC-02` |
| 边界配置 | 适用：门禁用/策略档位/阈值边界/豁免 | `test/gates.test.js::R-01-006/AC-03`、`test/gates.test.js::R-01-005/AC-03` |
| 副作用 | 适用：deny/送达对会话流的注入与冷却 | `test/delivery.test.js::R-01-003/AC-03` |
| 跨实现 | 不适用：单一实现 | — |

## 终态与证据
