---
id: T-031
doc-type: task
created: 2026-10-14
mutation: lifecycle
---
# T-031 配置卡平铺常开 + 删除用户级启用开关（启用状态改配置派生）

风险等级: standard
状态: completed

## 背景与目标

- 东家指令（m00362，生产实测后）：0.2.0 插件详情页为每插件独享配置面——折叠交互已无用（0.1.x 多卡共享设置页的遗产，实测引发「详情页无配置项」误读），直接平铺；插件详情页自带插件级启停开关（`remote.pluginManager.setBundleEnabled` RPC，实测确认），卡内 `enabled` 全局开关冗余。东家确认方向（m00376「同意」）。
- 决策依据：C-030。需求侧变化：R-02-001 AC-03 改写（禁用条件改派生）、AC-11 删除（折叠不存在）、AC-13 新增（派生启用承诺）。
- 会话级静音既有承载：`/advisor off`（sessionOverride，R-02-001 命令面），不随本变更消失。

## 差距评估

- 卡片交互：`lib/client/render.js` header 为可折叠 button（chevron/aria-expanded/onClick + `controller.setExpanded`），body 依赖 `open` 判定渲染；`lib/client/card-state.js:77` 持久化 `expanded` 态（T-006 遗产）。
- 启用开关：render.js 主开关 toggleRow（`setField('enabled', …)`）+ `disabled = config.enabled !== true` 全局灰化传播（门块/隐私块 `advisorflow_disabledGroup`）。
- 校验/拦截：card-state.validate 与 gateway `advisor-flow/set` 各有一份 enabled-without-model 保存拦截（`advisorModelMissingMessage`）——派生后该状态不可达。
- 服务端：`lib/config.js` 解析 `raw.enabled`（默认 false）+ disabled-with-reason 门；`lib/settings.js:47` schema 声明 `enabled` 为可编辑键。
- 命令面：`lib/commands.js:342` 未启用文案引用 `settings.yaml 的 advisor-flow.enabled`——派生后措辞失效。

## 收敛方案

- 卡片平铺：header 改静态 div（标题/描述/未保存徽标，不可点），删除 chevron、`open` 判定与 `setExpanded`；error 态重试不再强制展开（表单常开）；`.advisorflow_cardOpen`/chevron CSS 与 `chevronIcon` 删除。
- 删除主开关：render.js 去「启用 Advisor Flow」toggleRow 与其 hint；`disabled`（主开关灰化传播）整体删除——控件恒可编辑，未配置态由整卡置顶提示横幅表达（唯一表面，审核 finding 1 收敛）：`advisor.provider`/`advisor.model` 任一缺失（按 effectiveConfig 含暂存补丁计算）时呈现「advisor 未启用：缺少顾问提供方或模型——在下方补齐后保存即可启用」横幅（`.advisorflow_banner` 样式），补齐（含暂存）即时消失；循环门阈值随门开关灰化的局部联动保留。
- 派生启用（lib/config.js）：删除 `raw.enabled` 解析与默认；解析完成后 `config.enabled = Boolean(advisor.provider && advisor.model)`，缺失时 `config.reason = 'missing-advisor-model'`；`KNOWN` 键清单保留 `enabled`（遗留值不告警透传），但显式出现 `enabled: false/true` 时追加弃用警告（告警不阻断，AC-02 语义）。
- 保存拦截退役：card-state.validate 与 gateway `advisor-flow/set` 的 enabled-without-model 块删除；`advisorModelMissingMessage` 随之删除（无消费方）；模块头注释同步。
- schema：`lib/settings.js` 删除 `enabled: z.any().volatile()` 声明键（describe/update 不再投影该键；遗留文档值经 cordis resolver schema 外 merge 保留，无数据丢失）。
- 命令面文案：commands.js:342 未启用回退文案改为不引用 enabled 键（reason 恒存在时走 reason 分支）。
- 运行时判定点不动：`config.enabled === true` 消费方（lib/index.js 守则注入、lib/turn-review.js、lib/consultation.js 会话 override 回退）语义在派生值下不变。
- PRD/SOLUTION 演进随本提交落盘（AC-03 改写、AC-11 删除、AC-13 新增；SOLUTION 契约行与 web 设置卡模块重写，C-030 链接）。

## 测试计划

- test/config.test.js：enabled 解析用例改派生断言（provider/model 齐备→enabled true；缺任一→false + reason；遗留 enabled:false 告警弃用且不影响派生）；advisorModelMissingMessage 删除。
- test/gateway.test.js：set 拦截用例删除（派生后不可达）；含 enabled 键的 patch 保存应成功且忽略该键。
- test/client/settings-card.test.js：去折叠断言（header 静态、无 aria-expanded、表单常开）；去主开关断言；新增未配置横幅断言（含暂存补丁联动）；去 expanded 持久化用例；validate 去 enabled 块。
- test/settings.test.js：schema 键清单去 enabled。
- test/commands.test.js：未启用文案断言更新。
- 回归：全套件 + `node --test`；staging（af-home 3087）浏览器实测——详情页打开即见全部字段（无需点击）、未配置横幅、编辑保存链、sticky footer、只读降级。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
| --- | --- | --- |
| 成功 | 适用：平铺卡片渲染与保存链为本变更主承诺 | `test/client/settings-card.test.js::R-02-001/AC-13 路由齐备即派生启用：无横幅、无开关、配置可查询（T-031/C-030）`；`test/client/settings-card.test.js::R-02-001/AC-01 卡值全走宿主 configForms、自有 RPC 仅目录查询（平铺常开，C-030）`；`tasks/evidence/T-031/e2e-output.txt#④ footer position=sticky` |
| 异常 | 适用：未配置/非法值/保存拒绝路径随派生改造 | `test/config.test.js::R-02-001/AC-03 顾问路由不完整时派生禁用且带原因，引擎返回 NO_ADVISOR_MODEL；遗留 enabled 键告警忽略（T-031/C-030）`；`test/client/settings-card.test.js::R-02-001/AC-03 路由不完整派生禁用：横幅提示可见，编辑/保存不再被拦截（T-031/C-030）` |
| 边界配置 | 适用：遗留 enabled 键、只读表单、目录降级均受本次改动影响 | `test/settings.test.js::R-02-001/AC-02 Config schema：enabled 已退役为未知键（T-031/C-030 派生启用）`；`test/config.test.js::R-02-001/AC-03 顾问路由不完整时派生禁用且带原因，引擎返回 NO_ADVISOR_MODEL；遗留 enabled 键告警忽略（T-031/C-030）` |
| 副作用 | 适用：运行时 enabled 消费方语义不变须证明 | `test/index.test.js::T-014 Scout 接线计量：scout.enabled 时二次调用 usage 以 scout 口径入台账`（index 全绿）；npm test 319/319（命令行） |
| 兼容性 | 适用：遗留文档含 enabled 值的保留路径被本变更触及（schema 剥除） | `test/config.test.js::R-02-001/AC-03 顾问路由不完整时派生禁用且带原因，引擎返回 NO_ADVISOR_MODEL；遗留 enabled 键告警忽略（T-031/C-030）`；`test/index.test.js#写缝投影（T-028）` |

## 自查清单

- 边界：遗留文档含 `enabled` 键——解析告警弃用并忽略（enabled 派生不受其影响）；schema 未声明该键 → settings.update 投影剥除新写值，文档层遗留值无损（merge 保留）。测试：config 遗留键用例 + index 写缝投影断言（`enabled` not in raw）。
- 异常路径：未配置路由时卡片可编辑可保存（横幅提示，不拦截）；非法值仍由 validate/gateway 各自拒绝（与派生无关）；目录挂起/失败回退手动输入；error 态重试自愈。测试：settings-card 派生禁用/AC-13/目录回退/unavailable 套件。
- 回归影响：运行时 `config.enabled === true` 消费方（index 守则注入、turn-review、consultation 会话 override 回退）在派生值下语义不变——齐备即 true。
  - 旧路径 `enabled:false` 用户升级后从禁用变启用——属 C-030 意图内行为变化，非回归。
  - 折叠交互删除仅影响卡片自身（无外部消费方）。
  - 全套件 319/319 绿 + staging E2E 实测（tasks/evidence/T-031/）。

## 终态与证据

- 实现: 平铺常开 + 删主开关 + 服务端派生启用 + 保存拦截退役 + 遗留键弃用告警（lib/config.js、lib/gateway.js、lib/settings.js、lib/commands.js、lib/client/{card-state,render}.js、构建产物 lib/client.js）；渲染层单一横幅表面 + provider/model 下拉死路回退自由文本（目录外 provider 或该 provider 无模型声明时，东家生产报障回归）。
- 测试: `node --test "test/**/*.test.js"` 320/320 绿（exit=0，2026-10-15）；构建产物复建 cmp 确定性一致；af-home staging 浏览器 E2E 复跑全绿（fieldset=6、provider/model 下拉、保存回执、reload 回显、横幅消失、footer sticky、pageerror=0、console=0）。
- SOLUTION 对照: PRD AC-03 改写（横幅可见、编辑保存不拦截）/AC-11 删除/AC-13 递补（齐备即启用）；SOLUTION.md:538 单一横幅表面 + 死路回退措辞、web 设置卡模块同步；C-030 四段式。
- review: 独立子代理 bfbe4104（独立上下文），结论 blocking=0 / non-blocking=5；finding 1（双提示并存+文档漂移）已收敛为单一横幅并同步 SOLUTION/任务书措辞；finding 2（config/gateway 测试夹具残留退役键）已清理（遗留键专测 :80 保留）；finding 3（gateway 弃用告警误套「未知键」前缀）已改按告警内容分流；finding 4（commands.js 兜底分支不可达，防御性死代码）记录保留；finding 5（evidence PNG/探针入库）供东家定夺。残余风险已记录：宿主 merge 语义不可本仓实测、gateway 收含 enabled patch 无直接用例、暂存联动横幅用例已补。
- 风险自评: —（standard 档）
- commit: 7f72120（实现）；本关闭提交为独立提交
