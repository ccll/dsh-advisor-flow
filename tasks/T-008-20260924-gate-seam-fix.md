---
doc-type: task
mutation: lifecycle
id: T-008
---
# 门控接缝对齐真实宿主载体——四门零触发修复

状态: completed
关联: R-01-003、R-01-004、R-01-005、R-01-006、R-01-001、R-02-005
风险等级: standard

## 背景与目标

东家报告：插件装载后多次 agent 会话零触发（2026-09-24 现场排查）。生产宿主实弹验证确认四门全部失效：

- 循环门探针（同会话 3 次完全等价 bash 调用）第 3 次调用 0.29s 直接返回，无咨询、无注入、无日志；
- 同期宿主自带 `repeat-tool-reminder` 插件对同一模式正常触发（`agent/inbox/spliced` 注入记录在案）——宿主事件面本身健康；
- 我（执行 agent）的工具清单无 `ask_advisor`；
- journal（dsh.service）自 Sep23 启动以来无任何 advisor-flow 日志。

根因：插件宿主半区的接缝契约与真实宿主（dsh 0.1.5-rc.1 / dsh-tools 0.1.5-rc.2，Sep11 装机后未变）不符，且门引擎对「malformed carrier」静默放行，全部失效无任何显性化痕迹。T-005 终态声称的「东家在子代理中实测所有触发情况」未在真实 pre-execute 载体上发生（测试桩的 exec 形状与宿主真实形状同构，掩盖了断缝）——本 task 同时修正该验证缺口。

改动源于 T-005 联调清单遗留项的实弹复核（TODO.md「联调深项持续观察」条目）。目标：四门在真实宿主上按 R-01-003～R-01-006 的 AC 语义触发，`ask_advisor` 真实可注册可调用。

## 差距评估

宿主接缝事实（均经源码实证，dsh 0.1.5-rc.1 / dsh-tools 0.1.5-rc.2，Sep11 装机后零改动）：

1. **pre-execute 载体字段**：宿主派发 `exec = { token, callId, rootCallId, name, arguments, agent?, parent?, signal, … }`（dsh-tools/lib/index.js:3037-3059）；插件门引擎读 `exec.tool`/`exec.args` 并以 `exec.tool` 非字符串为由静默放行（lib/gates/index.js:256-259）。四门从未参与判定。
2. **tools/result 缝形状**：宿主以 `(exec, result)` 两参投递（dsh-tools/lib/index.js:3290-3298），成败真值是 `result.isError`；插件按单对象事件读取 `event.tool`/`event.error/ok/success`——失败计数恒为成功、工具名落 `unknown`。且 session/event 的 `tool/result` 记录（`{type, seq, time, data:{message:…}}`）不携带工具名，不能作为失败计数来源。
3. **ask_advisor 工具契约**：宿主 `tools.register` 强制 `output { schema, render, presentationMeta? }`（dsh-tools/lib/index.js:2773-2776），缺失即 TypeError；插件工具体无 `output` → 每次装载注册必抛（被子上下文容纳为 fiber 错误，宿主半区存活、工具缺席）。
4. **完成门锚点**：宿主无名为 `concludesTurn` 的工具；「回合收口」由工具体结果标志 `result.concludesTurn`（仅执行后可知）与 `agent/turn-stopping` 串行事件（收口前等待、listener 以 `agent.steer` 反对即续跑）承载（dsh-tools/lib/index.js:3437-3443、dsh-agent-loop/lib/index.js:966-970）。完成门在 pre-execute 时点不可判定，须改锚 `agent/turn-stopping`。
5. **送达消息形状**：宿主 UserMessage 的 `content` 为 ContentBlock 数组且带 id（dsh-llm message 契约；宿主自带 repeat-tool-reminder 的注入消息为 `{role:'user', content:[{type:'text',text}], source, id}`）；插件送达构造 `content` 为纯字符串。
6. **immuneTurns 冷却事件源**：session 记录无 `turn/end` 类型（实测转写仅 step/start、step/end 等），`classifySessionEvent` 的 turn-end 分支永不命中；真实收口信号是 `agent/turn-stopping`（payload `{turn, signal, agent}`，agent 由 agentEvents 融入）。
7. **会话标识**：`session` 对象有 `.id` getter；`agent.id === sessionId`（dsh-agents typert lookup 以 SessionId 解析 agent）。

SOLUTION 的「会话观察」「门控服务」「咨询工具」「横切约束」对上述接缝的描述同步于本提交（map 不变的缺陷修复，内部结构描述同提交同步）。

## 收敛方案

- `lib/util.js`：`sessionOf` 增补 `record.agent?.id` 分支（exec 载体的会话标识）。
- `lib/gates/index.js`：载体字段改 `exec.name`/`exec.arguments`；会话经 `sessionOf`（agent 分支）；豁免判断改 `exec.name`；`GATE_ORDER` 收窄为 plan/loop/failure；新增 `handleTurnStopping(payload)`——完成门改锚 `agent/turn-stopping`：enabled 时同步咨询，review→送达+放行；block+blocker→`agent.steer(原因消息)`（收口被反对、续步）；ask→审批缝，拒绝即 steer；其余放行。失败路径 fail-open 放行收口。
- `lib/index.js`：`tools/result` 监听改两参 `(exec, result)`——`result.isError === true` 记失败、`exec.callId` 为去重标识、`exec.agent?.id` 为会话；session/event 监听收缩为 reset 类事件（会话压缩/重写）与 carrier 传递，不再做结果计数（权威成败缝唯一化）；新增 `agent/turn-stopping` `{global:true}` 监听：完成门判定与处置 + 送达冷却倒数。
- `lib/observer.js`：`onEvent` 移除 session/event 结果计数分支（该缝记录无工具名，不能归属失败计数；权威缝为 `tools/result` 两参形态），保留 reset 分支。
- `lib/tools/ask-advisor.js`：定义补 `output { schema, render }`（value 契约 `{ok, adviceId?, severity?, text?} | {ok:false, code, reason}`，render 出 text 块）；execute 返回值形态对齐，错误诊断以 value 携带、不抛错。
- `lib/delivery.js`：消息 `content` 改 ContentBlock 数组（`[{type:'text',text}]`）并生成消息 id。
- 测试：全部 exec/事件构造改真实宿主形状；新增回归——真实形状 exec 三次等价调用第 3 次命中循环门（R-01-005/AC-01）、失败 result 后同工具下次调用命中失败门（R-01-004/AC-01）、`exit_plan_mode` 命中计划门（R-01-003/AC-01）、turn-stopping 命中完成门（R-01-006/AC-01）、工具定义含 `output` 可过宿主注册校验（R-01-001/AC-01 面）、送达消息为块数组。
- SOLUTION 同步：门控服务/会话观察/咨询工具模块条目、横切约束载体契约、运行时交互图完成门时序、运行时并发与失败语义补 turn-stopping 语义。

## 测试计划

- `node --test` 全量绿（真实形状构造）；测试锚定 AC-ID 保持 strict。
- 真机实弹复验（需宿主重启载入新码，东家执行）：循环门 3×等价调用、失败门（一次失败后同工具重试）、计划门（exit_plan_mode）、完成门（回合收口）、`ask_advisor` 工具出现并可调用、`/advisor status` 全字段。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：真实形状载体的门命中与意见送达 | `test/gates.test.js::真实宿主形状回归`、`test/ask-advisor.test.js::R-01-001/AC-01` |
| 异常 | 适用：consult 不可用/送达失败 fail-open 不停摆 | `test/gates.test.js::R-02-005/AC-02 门组件抛错` |
| 边界配置 | 适用：门禁用/豁免工具/agentless 载体 | `test/gates.test.js::R-01-006 真实锚点钉住`、`test/index.test.js::R-01-003/AC-01 apply 接线` |
| 副作用 | 适用：送达消息契约（块数组）、计数键归属会话 | `test/delivery.test.js::R-01-003/AC-03 消息形态`、`test/observer.test.js::R-02-005 sessionOf 宽窄` |

## 终态与证据

- 实现: 门控接缝对齐真实宿主载体（dsh 0.1.5-rc.1 / dsh-tools 0.1.5-rc.2 实测裁决）——① pre-execute 载体契约改 `exec.name`/`exec.arguments`/`exec.agent.id`（含 plan.js judge 旧字段修复）；② 失败计数单一权威缝 `tools/result`（两参 `(exec, result)`、失败真值 `result.isError`、`exec.callId` 去重），session/event 收缩为 reset 缝（其存储记录无工具名，双缝去重议题裁决关闭）；③ `ask_advisor` 工具定义补宿主强制 `output {schema, render}`，value 契约 `{ok,adviceId,severity,text}|{ok:false,code,reason}`；④ 完成门改锚 `agent/turn-stopping` 回合收口串行派发（宿主无名为 concludesTurn 的工具），反对以 steer 数据表达，去重标记只在放行收口后落、反对不落（AC-02 不被同回合再收口绕过）、反对未发出按事实降级（block 路径自由收口 / ask 路径按已送达 fail-open 放行落标记）；⑤ 送达消息改 ContentBlock 数组 + id；⑥ 送达冷却只在自由收口倒数（送达/反对续步不倒数）；⑦ package.json 声明实测接缝清单；SOLUTION 同步入图与模块条目（横切约束合并单节、完成门收口时序图）。
- 测试: `npm test` 177/177 全绿（基线 166 净 +11：真实宿主形状回归组 + 完成门 turn-stopping 三 AC + 回合去重边界 + 反对降级两分支 + ask fail-open 三分支 + 冷却口径）；`python3 tools/agentmap_lint.py --report` 全绿（test-anchored 30/30）。
- SOLUTION 对照: 载体契约、完成门锚点、权威缝裁决、收口去重与降级语义已同步入 SOLUTION（横切约束/门控服务/会话观察/咨询工具/运行时语义/交互图）；PRD 零改动（R-01-003～R-01-006 承诺不变，机制锚点按宿主现实收敛）；map-code 无漂移。
- 残余与后续: 真机四门实弹复验待宿主重启载入新码后执行（生产宿主重启属东家操作；复验清单见测试计划）；`stopSession`（agents.cancel）真实签名与 `classifySessionEvent` turn-end 死分支清理归 T-002 联调清单；完成门启用时每回合收口一次咨询的成本由 budget.maxPerSession 与门开关调节。
- commit: 4364b6d
- commit: 46550a2
- commit: 3c9e38b
- commit: 4dc9ec8
- review:
  - 审核方: 双轴独立评审子代理（Standards 轴、Spec 轴，code-review skill 流程，同步委派各自成会话；基线评审一轮 + 修复复审三轮，末轮 Standards+Spec 合并终确认）
  - 目的理解: 本 task 目标是让四门与 ask_advisor 在真实宿主载体上按 R-01-001/003/004/005/006 与 R-02-005 的 AC 语义工作；reviewer 需核验载体契约改写与宿主源码事实一致、SOLUTION 同步无漂移、fail-open 非阻断不变量不被破坏、测试锚定真实形状
  - 执行方式: code-review skill 双轴并行子代理；评审基线 d88887c..4364b6d（首轮）→ 4364b6d..46550a2（二轮）→ 46550a2..3c9e38b（三轮）→ 3c9e38b..4dc9ec8（终确认）
  - 问题与修复: 首轮 Standards 三项硬/判断题（task 重复标题、observer 双叠 JSDoc 过期句、forgetSession 命名偏离动词族）与两项保留判断（处置阶梯不提取——两处置通道实质不同；五处缝面注释非复制）均经复审裁定；首轮 Spec 核心发现——完成门（会话，回合）去重使同回合 blocker 反对可被立即再收口绕过（AC-02 失效）→ 修复为放行落标记/反对不落标记；二轮发现冷却按派发次数倒数口径漂移 → 修复为仅自由收口倒数；二轮 Spec 完成门时序图只补一半 → 补 sequenceDiagram；三轮发现 steer 降级返回 'objected' 与「收口已发生」事实不符、ask fail-open 已送达却返回 undefined 误倒数、ask 拒绝且反对未发出支路与 fail-open 支路处置不一致 → 统一按已送达事实处置（markReviewed + 'delivered'）、反对未发出且无投递按自由收口（undefined）；测试 AC 锚点错位（ask fail-open 误锚 R-01-006/AC-02）→ 改 R-02-005/AC-02。施工期另有测试代理上报 plan.js judge 旧字段遗漏（计划门真实载体失明）→ 实现方修复后用例恢复。
  - 复审结论: 终确认轮双轴「复审通过，无残余发现」；残余风险两条已记录（ask fail-open 依赖 budget 兜底的拉锯成本、steer 瞬态抛错的冷却偏差窗口）+ 真机复验待宿主重启（非代码工作）
