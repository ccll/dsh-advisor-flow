---
doc-type: task
mutation: lifecycle
id: T-005
---
# 整装真实联调

状态: active
关联: R-01-001、R-01-003、R-01-004、R-01-005、R-01-006、R-02-001、R-02-003、R-02-004（联调清单覆盖的需求面）
风险等级: high

## 背景与目标

单元与接线桩测试已全绿（117 项，锚点 30/30），但事件形状、缝契约、持久写均未经真实 dsh 运行时验证。本任务把插件装入 web profile 接真实模型与会话，完成 T-002 移交的联调验证清单逐项实测销项，并补齐持久写路径。东家指示「最后再测」即指本阶段。

## 差距评估

- 插件未安装进任何真实 profile；全部接缝结论来自 handoff 实测（他人插件）与桩假设。
- T-002 移交的联调验证清单（8 项）未实测。
- 设置卡保存只落运行时态：settings.yaml 无写入路径（R-02-001/AC-01 持久写缺失，UI 亦无「重启即失」提示）。

## 收敛方案

- 持久写实现：经 dsh settings bridge 实现 `advisor-flow` 命名空间写回 settings.yaml（复用宿主 settings.mutate 类缝；缝形态对照 dsh-advisor lib/settings.js 的写入模式）；卡片保存回执注明持久化结果。
- 安装：`dsh plugin --profile web add`（本地路径或打包），确认 bundle 装载、client 卡片渲染、命令注册。
- 冒烟路径：真实会话发起咨询（ask_advisor 真实模型往返）→ `/advisor status` 全字段 → 手动咨询/取消 → 四门逐门触发实测（构造循环调用、连续失败、exit_plan_mode、concludesTurn）→ on|off|toggle 会话覆盖 → 卡片保存→即时生效→持久化检查。
- 联调验证清单逐项实测（自 T-002 移交，见下），每项记录结论并回写任务书；结论影响实现时走对应修复（短路或新 task）。
- 宽松 JSON balancedObjects 帧解析（lib/consultation.js，自 T-001 交接）：真实模型输出下验证帧误识别边界（已覆盖空 note/非帧 JSON/markdown 围栏三类单测）。
- 事件形状与缝契约按实测修正后，相关单测同步校准。

## 联调验证清单（自 T-002 移交，逐项销项）

- 双缝投递：`tools/result` 与 `session/event` 是否重复投递同一工具结果；两缝载荷是否共享可拼接执行标识（无则评估 idempotency token 方案）；双缝成败判定一致性（不一致则合并策略改「任一缝报失败即失败」）；resultIdentity 'id' 字段是否跨缝不同值。
- 观察器事件形状：result 失败判定字段（error/ok/success）、压缩/重写事件名实测。
- 会话标识形状实测：session/disposed 是否以纯字符串 id 直传、result 事件是否携带会话语义的 id 字段——sessionOf 的字符串分支与窄版解析按实测结论最终确认（当前已加宽键防护与钉住测试）。
- effort 下拉选项集收敛：当前硬编码 low/high/max/off——按 resolveModelInfo 实测的真实档位列表收敛选项集，或在 SOLUTION 契约把档位枚举定为封闭集（引擎能力门控已兜住列表外误值，仅 GUI 选择面受限）。
- block-session：宿主是否存在 agent cancel 类缝、钩子命中后是否真正停止执行。
- approver：宿主 approval 缝实际可用性与形状——**部分已实测（2026-09-22 journal）**：服务名为 `approval`（dsh-user-approval 的 ApprovalService 存在于宿主）；但经 ctx 代理直访未声明 inject 会抛 `cannot get property without inject` 且 try/catch 探测不可靠（曾致插件树装载崩溃）——已改条件 `ctx.inject(['approval'], …)` 子上下文方案，激活后 approver 缝可用性与 request 形状仍需下次重启确认。
- delivery source 负载形状与注入消息渲染兼容性。
- immuneTurns 冷却：turn-end 事件源实测下按 stepped turn 递减。
- fail-open 委托式放行：waterfall 多监听者场景下后续监听者是否如期执行。
- client 挂载缝（ctx.settingsPlugins 形态）与「RPC 可用但卡片未渲染」的不可观测窗口评估。

## 测试计划

- 真实环境冒烟按上述路径执行，结论记录于本任务书终态（每项：实测结论/影响/处置）。
- 修正实现时补对应单元测试并保持锚点；`python3 tools/agentmap_lint.py --report` 保持绿色（strict 已恢复则全绿无 warning）。
- 现场验证命令：`dsh --profile web --dump-config`、`journalctl --user -u dsh` 观察插件日志、会话内 `/advisor status`。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：真实咨询往返与四门触发处置 | `lib/consultation.js::createConsultationEngine`、`lib/gates/index.js::handlePreExecute` |
| 异常 | 适用：真实路由错误/超时下的 fail-open 与诊断 | `lib/consultation.js::classifyFailure`、`lib/gates/index.js::handlePreExecute` |
| 边界配置 | 适用：真实 settings.yaml 写回与即时生效 | `lib/gateway.js::createConfigGateway`、`lib/config.js::resolveAdvisorFlowConfig` |
| 副作用 | 适用：注入消息进真实会话流、冷却窗口行为 | `lib/delivery.js::deliver`、会话现场记录 |
| 跨实现 | 不适用：单一实现 | — |

## 终态与证据
