---
id: T-034
doc-type: task
created: 2026-10-15
mutation: lifecycle
---

# T-034 maxTokens 占位数值改走自有 modelInfo RPC（宿主目录不携带模型 limits）

风险等级: standard
状态: completed

## 背景与目标

东家报障（2026-10-15，T-032 验收项 ③）：生产详情页「输出上限（maxTokens）」占位仍无具体数值。根因（证据链齐全，宿主 checkout /home/cailei/.npm-global/lib/node_modules/@deepseek-ai/dsh/ 核实）：T-032 的取数路径「目录快照 model.maxTokens」在真实宿主上不存在——宿主模型目录条目只透出 `{id,name,description?,reasoning?}`（`@deepseek-ai/dsh-api-session-controller/lib/index.js:500-528` buildModelCatalog），`llm/listConfigurableProviders` 只透出 `{id,name,configured}`；而声明值真实存在于 llm 运行时（pi-ai 适配器 `modelInfo()` 对声明过 `maxTokens` 的模型返回 `defaultMaxTokens`，`@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1827`）。目标：占位数值改经插件自有 RPC `/api/advisor-flow/modelInfo` 从宿主运行时解析，未声明/通道失败回退原文。

## 差距评估

- `lib/gateway.js` 处理器映射无 `advisor-flow/modelInfo`；typert 贡献声明无该方法；`createConfigGateway` 无宿主 llm 解析注入口。
- `lib/typert-gateway.js` 网关类无 `modelInfo` 方法。
- `lib/index.js` 装配点未注入 `ctx.llm.resolveModelInfo` 适配器。
- `lib/client/card-state.js` `modelMaxTokens(modelId)` 只读目录快照（真实宿主恒 undefined）；无 modelInfo 拉取与缓存。
- `lib/client/render.js` 调用点与注释按「目录声明」表述。
- `test/client/settings-card.test.js` CATALOG 夹具含编造的 `maxTokens: 131072`（T-032 按假想宿主形态建模）；RPC 方法白名单断言需放行 modelInfo。
- `test/gateway.test.js` 缺 modelInfo 处理器用例。
- `SOLUTION.md` 配置与状态服务/web 设置卡模块的「自有 gateway RPC 只保留模型目录」表述需扩为目录 + modelInfo。
- PRD 无需改动：占位显值承诺已锚定 R-02-001/AC-07（「跟随宿主对所选模型的配置（经 llm.resolveModelInfo 取模型声明值）」；AC-04 为枚举承诺并明示 maxTokens 缺省另见 AC-07）。

## 收敛方案

- 服务端：`createConfigGateway` 新增可选注入口 `resolveModelLimits(provider, model)`；新处理器 `advisor-flow/modelInfo` 校验字符串入参→调注入解析→`{ ok: true, defaultMaxTokens }`（声明缺失则省键）/`{ ok: false, reason }`，任何异常降级不抛；`advisorFlowTypertContribution` 增第三条 invocation（provider+model 两参数，src-json codec，镜像 set 条目形态）。
- 装配：`lib/index.js` 在 `createConfigGateway({...})` 注入 `resolveModelLimits`——直接委派 `ctx.llm.resolveModelInfo` 不吞错（审核 N4 修订：llm 缝缺失或解析抛错交由 gateway 统一降级并记 warn，resolve-failed 在生产装配下可达）。
- 网关类：`typert-gateway.js` 增 `modelInfo(provider, model)` 委派处理器并 `toWireJson`（undefined 自动剥除）。
- 客户端：card-state 增 `state.modelLimits`（`provider\0model` → defaultMaxTokens|undefined 正负缓存）与一次性 `limitsDegraded`；`maybeLoadModelLimits()` 在 deriveFromForm/setField 尾部触发（ready + 路由齐备 + 未缓存 + 未在途才发）；`modelMaxTokens(provider, modelId)` 改读缓存（正整数守卫）。
- 渲染：render.js 调用点改传 `advisor.provider`；注释与文案机制说明同步（数值来自宿主运行时声明）。
- 夹具：CATALOG 去 `maxTokens`；`catalog.modelInfo` 注入桩；默认面用例改经 modelInfo 桩断言 `（当前 131072）`；新增 ok:false 回退、未声明回退、通道失败一次性降级三形态；RPC 白名单断言放行 `advisor-flow/modelInfo`（仍禁 get/set——卡值不走自有写读通道的契约不变）。
- E2E：af-home staging 真实环境（无 AF_FRESH，advisor-flow 路由保留 provider=deepseek-official/model=deepseek-flash），走真实 deepseek 适配器全链；探针断言占位匹配 `/当前 \d+/`，实测 256000（deepseek 适配器连接级缺省 `configured?.maxTokens ?? connection.maxTokens`——语义=宿主对所选模型实际生效的声明值，与 AC-07 一致）；另断言 mode 下拉缺省选中 soft（T-032 回归）与 pageerror=0。

## 测试计划

- 全量 `node --test "test/**/*.test.js"` 绿（gateway 新用例 + 卡片夹具重构/新用例）。
- bundle 确定性重建一致；agentmap lint 通过。
- af-home staging 浏览器 E2E：占位数值、回退形态、无 pageerror。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
| --- | --- | --- |
| 成功 | 适用：数值主路径——宿主声明 defaultMaxTokens 经自有 RPC 透传到占位 | `test/gateway.test.js::R-02-001/AC-07 modelInfo（T-034）：宿主声明 defaultMaxTokens 经自有 RPC 透传`（精确 deepEqual）；`test/client/settings-card.test.js::R-02-001/AC-04 默认面（T-032/T-034）：mode 缺省显示 soft、四门默认开启、maxTokens 占位显示宿主声明值`（占位含「当前 N」+恰好一次带精确参数的查询） |
| 异常 | 适用：通道失败/解析抛错/非法入参 → 降级不抛、占位回退、不崩卡 | `test/gateway.test.js::R-02-001/AC-07 modelInfo（T-034）：非法入参/注入缺失/解析抛错一律降级不抛`（invalid-args/model-info-unavailable/resolve-failed 精确形态）；`test/client/settings-card.test.js::T-034 modelInfo 通道降级：rpc 抛错一次性显性化，路由变化不再重试` |
| 边界配置 | 适用：未声明 defaultMaxTokens（键省略）与非法值（≤0）守卫；负缓存不重发 | `test/gateway.test.js::R-02-001/AC-07 modelInfo（T-034）：宿主声明 defaultMaxTokens 经自有 RPC 透传`（键省略裸形态 deepEqual）；`test/client/settings-card.test.js::R-02-001/AC-01 卡值全走宿主 configForms、自有 RPC 仅目录与模型声明值查询（平铺常开，C-030）`（未声明回退+白名单收窄） |
| 副作用 | 适用：RPC 白名单契约不破（卡值仍不走自有 get/set）；目录三级联动与死路回退不受影响 | `test/client/settings-card.test.js::R-02-001/AC-01 卡值全走宿主 configForms、自有 RPC 仅目录与模型声明值查询（平铺常开，C-030）`（负向断言禁 get/set）；`test/client/settings-card.test.js::R-02-001/AC-01 目录驱动三级联动：provider/model 下拉来自目录，effort 来自模型声明`（联动与死路回退回归） |

## 自查清单

- [x] 边界：modelInfo 对空串/非字符串 provider、model 返回 `invalid-args`（`test/gateway.test.js`）；defaultMaxTokens 非>0 整数时键省略，客户端正整数守卫双保险。
- [x] 异常路径：resolver 抛错→`resolve-failed`；注入缺失→`model-info-unavailable`；RPC 通道抛错→`limitsDegraded` 一次性降级（不再逐键重试，避免每次快照刷新都打失败请求）。
- [x] 回归影响：`advisor-flow/get|set` 契约与贡献声明不动（仅新增第三方法）；卡片值流（configForms 读、settings.mutate 写）不变；目录三级联动与死路回退不受影响（catalog 不再被假想 maxTokens 污染）。

## 终态与证据

- 实现: 自有只读 RPC `/api/advisor-flow/modelInfo`（provider+model → 宿主 llm 运行时声明的 defaultMaxTokens）：lib/gateway.js 处理器 + advisorFlowTypertContribution 第三条 invocation、lib/typert-gateway.js modelInfo 委派（toWireJson 剥除）、lib/index.js 直接委派 ctx.llm.resolveModelInfo 不吞错；客户端 lib/client/card-state.js 按 provider\0model 正负缓存 + 在途去重 + 通道失败一次性 limitsDegraded、render.js 占位「跟随所选模型配置（当前 N）」/未声明回退原文；构建产物 lib/client.js 已重建。
- 测试: `node --test "test/**/*.test.js"` 327/327 绿（exit 0，实现与审核修复后各复跑一次）；bundle 重建与产物一致性核验（reviewer 重建 diff 零差异）；af-home staging 浏览器 E2E 实证全链（tasks/evidence/T-034/：占位「跟随所选模型配置（当前 256000）」=真实 deepseek 适配器连接级缺省、mode soft 回归、pageerror=0、截图 detail-placeholder.png）。
- SOLUTION 对照: SOLUTION.md:505（配置与状态服务职责增 modelInfo 数据源）与 :537（web 设置卡关键内部结构：RPC 形态/正负缓存/一次性降级/回退语义）；核对日期 2026-10-15 已核验；PRD 不动（承诺锚 R-02-001/AC-07）成立。
- review: 独立子代理会话（独立上下文 reviewer，未与实现共用上下文），目的理解先行记录（含宿主 checkout 独立证实目录无 limits）；blocking 1（B1 证据文件明文 token，已脱敏——token 行改为「经 AF_TOKEN 环境变量注入，不落盘」）已修复；non-blocking 5 项：N1 白名单用例标题陈旧（已改为「仅目录与模型声明值查询」）、N2 typert-gateway.js:78/:107 get|set 文档漂移（已补 modelInfo）、N3 网关用例锚 AC-04 实质归属 AC-07（已改锚 AC-07）、N4 resolver 生产装配静默吞错致 resolve-failed 与 warn 生产死代码（已改为直接委派不吞错，gateway 统一降级并记 warn）+ 业务级 ok:false 客户端按「未声明」负缓存（表现一致，记录为残余语义）、N5 task 测试计划与实际执行漂移（终态前已对齐：真实 af-home 环境 + /当前 \d+/ 断言 + 256000 来源注明）。复审结论：B1 修复后无 blocking 残留，可收口。
- 风险自评: —（standard 档）
- commit: 8419c50（实现，含审核修复 B1 脱敏/N1 标题/N2 文档/N3 改锚/N4 不吞错与验证矩阵、终态文书）
