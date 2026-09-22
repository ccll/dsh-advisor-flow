---
doc-type: task
mutation: lifecycle
id: T-004
---
# 命令面、web 设置卡与 bundle 装配

状态: completed
关联: R-01-002（手动咨询命令）、R-02-001/AC-01..02（GUI 设置面与即时生效）、R-02-003/AC-02（/advisor status 查询面）；同时收敛 T-002 清单中的 fail-open 统一项与 JSDoc 修正
风险等级: standard

## 背景与目标

完成插件对外可用的最后两块：宿主命令面与 web 设置卡，并把 T-003 复审遗留的两处纯代码级小修（fail-open 委托式放行统一、handlePreExecute JSDoc 失实）随本轮收敛。本任务完成后插件具备完整功能形态，集成与真实联调归下一任务。

## 差距评估

- lib/commands.js 不存在：/advisor-manual、/advisor status、/advisor gates、/advisor on|off 未挂载。
- lib/client/ 设置卡不存在；web 设置卡需走插件自有 GatewayService RPC（SOLUTION 产品契约：不走 settings.describe 暴露通道）。
- 遗留小修（T-002 清单登记）：fail-open 放行统一为委托式（next 存在时委托）；handlePreExecute JSDoc "Never throws" 与 rethrow 现状不符。
- 参考实现：dsh-advisor lib/commands.js（命令注册形态）、lib/client/（设置卡 + GatewayService RPC 模式）。

## 收敛方案

- `lib/commands.js`：命令注册（经命令注册表缝，可注入）——`/advisor-manual [focus]`（同步发起咨询、可取消、无用量副作用、素材含聚焦词）；`/advisor status`（启用态/路由/门状态/待处理/最近活动/用量摘要/degradations）；`/advisor gates`（只读回读）；`/advisor on|off`（会话级临时开关，不写持久配置）。
- `lib/client/`：web 设置卡 bundle——Advisor Flow 卡片（enabled、advisor 路由、四门矩阵 enabled/policy/threshold、隐私档位、脱敏开关、degradations 展示），经自有 gateway RPC（advisor-flow/get|set）读写；缺失字段禁用保存（enabled 且缺 provider/model 阻断，对齐 PRD R-02-001/AC-03 的 web 侧体验）。
- lib/index.js：gateway RPC 注册（advisor-flow/get|set）+ 命令挂载接线。
- fail-open 统一（T-002 登记项）：handlePreExecute 顶层 catch 委托式放行 + JSDoc 修正。
- gateway 通道声明于 package.json/cordis.patch.yml 所需的 bundle 元数据（对照 dsh-advisor 的 client 注入段）。

## 测试计划

- 命令面：注入桩命令注册表，锚定 R-01-002/AC-01..02（手动咨询素材含聚焦词、进行中可取消无副作用）与 R-02-003/AC-02（status 字段齐全）；gates/on|off 会话级临时开关语义。
- 设置卡：client 侧组件测试（读写 RPC、必填校验阻断保存）——R-02-001 的 GUI 面验收点。
- gateway RPC 处理器单测（get/set 往返、非法值拒绝）。
- 锚点补齐后 test-anchored = 30/30；lint warnings 应清零（未知锚点不得出现）。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：命令往返、卡片读写、status 呈现 | `test/commands.test.js::R-01-002/AC-01`、`test/client/settings-card.test.js::R-02-001/AC-01` |
| 异常 | 适用：RPC 非法值、必填缺失、命令错误路径 | `test/commands.test.js::R-02-001/AC-03`、`test/client/settings-card.test.js::R-02-001/AC-03` |
| 边界配置 | 适用：会话级覆盖与持久配置分离、on/off 边界 | `test/commands.test.js::R-01-002/AC-02` |
| 副作用 | 适用：on/off 不写持久配置、取消无用量副作用 | `test/commands.test.js::R-02-003/AC-02` |
| 跨实现 | 不适用：单一实现 | — |

## 终态与证据

- 实现: lib/commands.js（/advisor-manual|status|gates|on|off|toggle|cancel，会话级临时覆盖与持久配置严格分离）、lib/gateway.js（advisor-flow/get|set 自有 RPC，RAW 形态阻断校验）、lib/client/{card-state,render,index}.js（零依赖设置卡：纯逻辑控制器 + 注入式 DOM 渲染 + EPHEMERAL_SAVE_NOTICE 运行时态提示）、lib/index.js 条件注册与双真相同步、lib/consultation.js 会话级覆盖门控；两处 T-003 复审遗留小修（fail-open 委托式统一、JSDoc）随本轮收敛；收尾轮补 sessionOfEvent 窄版解析（消除执行 id 孤桶致失败门失明）与 sessionOf 字符串直传分支。
- 测试: `node --test` 122/122 全绿；test-anchored 30/30；lint warnings 清零。
- SOLUTION 对照: 双轴复审逐项核对一致（含 toggle 契约补记、.jsx→lib/client 实际布局修正）；无差异。
- commit: c42f154
- commit: bb124ef
- commit: d36bbb9
- review:
  - 审核方: 双轴独立评审——Standards 轴代理 eb77d407-3912-4c16-86c8-da1c1997a42d、Spec 轴代理 8f19eb7a-2266-4fb4-9220-ef1f316e1ba8（同前 task 审核方），code-review skill 流程
  - 目的理解: 命令面与设置卡是插件的对外操作与配置表面，须在「会话级临时性」与「持久配置」之间保持严格隔离，且 UX 面缺失不得阻断核心咨询与门控（显性降级双轨纪律）；reviewer 开审前已据 map 与任务书建立该理解
  - 执行方式: code-review skill 双轴并行子代理；Standards 基线 = AGENTS/CONVENTIONS/handoff + Fowler 清单 + T-004 设计要求；Spec 基线 = 任务书 + SOLUTION 契约 + PRD/DOMAIN；范围 2f31926..d36bbb9
  - 问题与修复: 首轮 Standards 4 坏味道 + 2 微项、Spec 2 中（session/disposed 清理缺失且注释失实、卡片保存不落盘未显性化）+ 2 低——经 bb124ef 修复（含顺带修复 util.sessionOf 载体 id 盲区这一使清理接线失效的根因）；复审新增 sessionOf 解析形状 3 项（孤桶风险、字符串直传、回执提示），经 d36bbb9 修复；两轴终确认均通过
  - 复审结论: 双轴终确认均通过，无未决事项；formatGateEntry 单源经调用点结构复核（1 定义 + 2 调用点）；顺带改动 EPHEMERAL_SAVE_NOTICE 经 Spec 轴终确认显式核验（渲染可见/新旧回执失效/返回值携带 notice/双侧测试断言）方随本 task 关闭；持久写与运行时实测归 T-005
