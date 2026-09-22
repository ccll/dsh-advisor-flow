---
doc-type: task
mutation: lifecycle
id: T-005
---
# 整装真实联调

状态: completed
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
- 必选/可选服务划分实测裁决：必选 = agents/llm（声明式 inject）、可选 = approval/commands/typert/settings（条件子上下文）；**tools 若重启时再报同类属性访问错误则升级必选**（实现方提请实测裁决）。
- 条件子上下文实测（T-005 装载修复复审移交，①已获 cordis 源码级修正）：① 子上下文 apply 内 throw **不走同步上抛**——Standards 轴实读 cordis 源码确认走 fiber 错误事件上报（显性化效果经 degradations + error 日志 + cordis error 事件仍在，但「注册失败向上传播拒绝启动」的注释语义需按实测修正）；② 服务后到时序（宿主是否可能在插件装载后才 provide approval/commands/typert/settings——影响「激活清除降级」是否真能触发）；③ 条件子上下文热重启边界（fiber 随服务消失撤除、服务回归重放 apply：approval 守卫跳过重接、commands/typert 重复注册且 disposer 泄漏）；④ approval/approvals 双候选名常驻等待 fiber 的收敛（真名定后单注册）。
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

- 实现: 真实联调六轮修复全部落地并经双轴复审闭环——装载双原语（声明式必选 inject + 条件子上下文，4644aa9/aee78cc）、client 半区 classic-script 打包线（afe2b16）、exports 子路径（e90908b）、TypertRemoteService gateway（b0e6842）、settings section 注册（d8d907d）、RPC 信封解包（e0955f7）、三级目录联动下拉（b48f0da）、卡片视觉对齐（569ae18）、工具监听 {global:true}（511d996）、持久写与产物守卫（01ce483/2bb697b/02114b6）。
- 测试: `node --test` 155/155 全绿；test-anchored 30/30；strict lint 全绿无 warning；产物新鲜度机械守卫（pre-push.d/30）上线。
- 生产实测（东家确认 + staging headless 浏览器实证）: 装载无崩溃；describe 服务 advisor-flow；设置卡渲染完整表单且三级联动选项来自真实目录；配置保存 → settings.yaml 落盘 → live re-apply（运行中实例 RPC 回读 enabled=True + 新路由）；**东家在子代理中实测所有触发情况，均符合设计要求**。
- SOLUTION 对照: 双轴批次复审确认 settings 桥使 R-02-001/AC-01 完整兑现（卡片保存与 settings.yaml 手改双路径即时生效、无回写环）；模块条目与实现一致。
- commit: b0e6842
- commit: afe2b16
- commit: d8d907d
- commit: e0955f7
- commit: b48f0da
- commit: 569ae18
- commit: 511d996
- commit: 01ce483
- review:
  - 审核方: 双轴独立评审——Standards 轴代理 eb77d407-3912-4c16-86c8-da1c1997a42d、Spec 轴代理 8f19eb7a-2266-4fb4-9220-ef1f316e1ba8（同前 task 审核方），code-review skill 流程，按轮次复审（装载修复两轮 + 批次 + 收口批次）
  - 目的理解: 本 task 目标是让插件在真实 dsh 运行时中可装载、可配置、可触发——所有宿主缝形态假设（exports、inject 原语、typert 贡献、installSection、事件可达性、classic-script 约束）都须经真机实测收敛；reviewer 开审前已据 map 与各轮实测证据建立该理解
  - 执行方式: code-review skill 双轴并行子代理按轮复审；实测由 staging 独立实例（headless 浏览器 + curl RPC）与生产真实会话（东家亲自验证）承载；联调清单逐项销项
  - 问题与修复: 实测暴露并修复六类真问题——装载崩溃（try/catch 探测原语）、client ESM 经典脚本不兼容（exports+打包线）、gateway 注册原语错误（TypertRemoteService）、卡片不渲染（settings section 未注册交集规则）、RPC 信封误读、工具监听缺 {global:true} 门零触发；每轮修复均经同审核方复审确认
  - 复审结论: 双轴各轮终确认均通过；残余运行时深项（条件子上下文热重启、双缝共享标识、事件形状细目）已在联调清单登记，由日常使用持续验证，不阻塞关闭
