---
doc-type: task
mutation: lifecycle
id: T-016
---
# T-016 咨询超时默认 10 分钟、输出上限跟随宿主模型配置、设置卡补两键

风险等级: standard
状态: completed
关联: R-02-001（C-015；东家 2026-09-30 会话直接指令）

## 背景与目标

生产实测（reasoningEffort=max 的 glm-5.3-flash 顾问）advisor timeout 频发：整次调用时限默认 180000ms 在深度思考模型 comprehensive 审阅下不够。东家指令（2026-09-30 会话，闸口已确认）：① 默认超时改 10 分钟；② web 设置界面提供覆盖项；③ maxTokens 与所选模型 provider 在 dsh 中的设置一致，并在设置界面提供覆盖项。决策依据与被否方案见 C-015。

## 差距评估

- 默认值：`lib/config.js` `DEFAULT_CALL_TIMEOUT_MS = 180_000`（对齐 pi），需改 600_000；`lib/client.js` 为构建产物，随 client bundle 重建同步。
- maxTokens 语义：现为固定默认 16384（`parsePositiveInt(DEFAULT_MAX_TOKENS)` 缺省填充）；目标为可选——缺省经 `llm.resolveModelInfo` 跟随宿主模型配置，显式配置覆盖。宿主 `llm.stream` 直调不经 prepareCall 默认填充链，省略参数≠跟随模型配置，须显式解析（C-015 被否方案①）。
- 设置卡：`callTimeoutMs`/`maxTokens` 在 settings.yaml 解析器与 describe Schema 已可配，但 web 设置卡无输入控件；数字控件清空不触发 onChange，无法回归缺省（循环门阈值「留空用默认 3」文案与行为同样不一致）。
- Map 演进：PRD R-02-001 需求陈述加「咨询超时与输出上限」并新增 AC-06/07/08；SOLUTION 产品契约/运行时语义/咨询服务/web 设置卡同提交同步；RATIONALE C-015 记账。闸口依据：东家 2026-09-30 会话对方案（含 maxTokens 缺省经 resolveModelInfo 语义与门内联等待共享上限）的明确确认。

## 收敛方案

- `lib/config.js`：`DEFAULT_CALL_TIMEOUT_MS = 600_000`；`maxTokens` 改可选解析（缺省 = undefined；出现时须为正整数，新 parser `parseOptionalPositiveInt`）；`DEFAULT_MAX_TOKENS` 常量随语义退役移除（含导出，测试同步）。
- `lib/consultation.js`：新增 `resolveDefaultMaxTokens(deadlineSignal)`——显式配置优先；未配置经 `llm.resolveModelInfo().defaultMaxTokens`（正整数才采用），解析失败或未声明则省略参数；独立缓存（键 = provider\0model，仅缓存确定性结果，失败不缓存，与 effortCache 同纪律）；llm.stream 请求按 `...(maxTokens === undefined ? {} : { maxTokens })` 携带。
- `lib/status.js`：快照原样携带 `maxTokens`（undefined = 跟随）；`/advisor status` 文本渲染未配置时显示「跟随模型配置」（文本渲染落点为 `lib/commands.js` advisorStatusText，status.js 仅快照透传）。
- `lib/index.js`（scout 二次调用，复审批次二补齐）：runScout 直传 `maxTokens: config.advisor.maxTokens` 在缺省语义下省略参数——恰为 C-015 被否方案①形态且属未声明的静默行为变化（复审 Spec 轴发现 1）。修复：引擎经 runScout 缝下发 `resolveMaxTokens` 解析缝，scout 与主咨询同语义（显式覆盖 > 模型声明值 > 省略），共享 (provider\0model) 缓存。
- `lib/client/render.js`：顾问区补 `advisor.callTimeoutMs`（占位「默认 600000（10 分钟）」）与 `advisor.maxTokens`（占位「跟随所选模型配置」）数字输入；`numberControl` 支持清空 → `onChange(null)`（回归缺省；循环门阈值一并兑现「留空用默认 3」）。
- `lib/client/card-state.js`：清空路径经 setField 存 null，解析器将 null 视为缺省（既有语义），无需新增校验分支。
- client bundle 重建（scripts/build-client.mjs；pre-push 30-client-bundle-fresh 门禁核对）。

## 测试计划

- `test/config.test.js`：默认 callTimeoutMs=600000；maxTokens 缺省 undefined；显式值保留；非法值（0/负数/非整数）拒绝。
- `test/consultation.test.js`：未配置 maxTokens → 请求携带模型声明值（stub resolveModelInfo 返回 defaultMaxTokens）；模型未声明 → 请求不含 maxTokens 键；显式配置 → 用显式值；resolveModelInfo 失败 → 省略且不缓存；effort 门控行为不回归。
- `test/commands.test.js`：`/advisor status` 文本呈现「输出上限: 跟随模型配置」（缺省）与「超时: 600000ms」（解析器默认填充）；快照形态不变（原样透传 maxTokens，无独立新断言）。
- `test/client/`：卡渲染两字段、清空 → null、保存合并语义。
- 锚定：R-02-001/AC-06、AC-07、AC-08 各落测试标题锚点（strict 模式）。
- `test/index.test.js`：scout.enabled 时二次调用与主咨询同语义跟随模型声明值（复审批次二补齐）。
- 全套件回归 + parity 差分（纯函数子集，不涉两键）+ anchor_coverage + expected-fail 账本核对。
- 联调核定项（记档随目标关闭）：设置卡清空产生的 null 经 gateway persist 落 settings.yaml 后，宿主 describe seam 对该键的校验行为宿主侧不可静态证明；运行时语义由 config.js 解析器单点承载（null → 缺省），风险限于 describe 呈现面。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：默认超时 600000；缺省 maxTokens 跟随模型声明值；显式值覆盖 | `test/config.test.js::R-02-001/AC-01 解析后的配置驱动后续咨询，重新应用即时生效`、`test/consultation.test.js::R-02-001/AC-07 maxTokens 缺省跟随宿主模型配置：声明值采用、未声明省略、显式覆盖、失败不缓存` |
| 异常 | 适用：resolveModelInfo 失败不缓存不阻断，参数省略；非法值拒绝 | `test/consultation.test.js::R-02-001/AC-07 maxTokens 缺省跟随宿主模型配置：声明值采用、未声明省略、显式覆盖、失败不缓存`、`test/config.test.js::R-02-001 非法值被拒绝；未知键不算拒绝；空配置取默认（守则三门布尔 + 循环门阈值 + 阻断模式；阈值下界另见 R-01-005/AC-08）` |
| 边界配置 | 适用：maxTokens 非法值拒绝；设置卡清空回归缺省且保存合并与 settings.yaml 同语义 | `test/config.test.js::R-02-001 非法值被拒绝；未知键不算拒绝；空配置取默认（守则三门布尔 + 循环门阈值 + 阻断模式；阈值下界另见 R-01-005/AC-08）`、`test/client/settings-card.test.js::R-02-001/AC-08 顾问超时与输出上限数字输入：填写覆盖、清空回归缺省、保存语义与 settings.yaml 一致` |
| 副作用 | 适用：缺省形态下请求省略 maxTokens（effort 门控语义不回归）；状态文本呈现跟随/默认语义 | `test/consultation.test.js::R-01-001/AC-01 咨询成功返回含 adviceId 的意见文本（无 severity），adviceId 为 UUID 形态且互不相同`、`test/commands.test.js::R-02-003/AC-02 /advisor status 展示启用态、路由、门状态、待处理、最近活动、用量摘要与降级项` |

## 终态与证据

- 实现: ① `lib/config.js` `DEFAULT_CALL_TIMEOUT_MS = 600_000`（10 分钟，偏离 pi 180s 记 C-015）；`DEFAULT_MAX_TOKENS` 常量退役，`advisor.maxTokens` 改可选解析（`parseOptionalPositiveInt`：缺省 = undefined；null 同义缺省；出现时须为正整数）。② `lib/consultation.js` 新增 `resolveDefaultMaxTokens`——显式配置优先；未配置经 `llm.resolveModelInfo().defaultMaxTokens` 跟随宿主模型配置（正整数才采用），解析失败或未声明省略参数；独立缓存（provider\0model 键，失败不缓存，effortCache 同纪律）；llm.stream 与 scout 缝（lib/index.js runScout 经 `resolveMaxTokens` 解析缝）同语义，signal 两形态归一（复审收口）。③ `lib/client/render.js` 顾问区补两键数字输入 + `numberControl` 清空 → `onChange(null)`；`lib/commands.js` 状态文本「输出上限: 跟随模型配置 / 超时: 600000ms」；`lib/settings.js` 注明可选键投影约定；client bundle 重建同步。
- 测试: 全套件 `npm test` 229 通过 / 0 失败（基线 227 + 新增：AC-06 标题锚、AC-07 四分支、AC-08 卡两键、scout 跟随语义）；`expected_fail_check` passed（executed=229 与账本一致）；`anchor_coverage` passed（68/68）；`agentmap_lint` passed；`parity_differential` 全等；bundle 重建无 diff。
- SOLUTION 对照: PRD R-02-001 需求陈述增「咨询超时与输出上限」+ AC-06/07/08（AC-04 限定枚举范围指向 AC-06/07）；SOLUTION 产品契约两键语义、运行时语义（600s）、咨询服务模块 bullet、web 设置卡 bullet、对齐基线两处声明账本新承载（T-011 终态后以 RATIONALE C-nnn 追加）；RATIONALE C-015 追加。闸口依据：东家 2026-09-30 会话对方案（含 maxTokens 缺省经 resolveModelInfo 语义、门内联等待共享上限）的明确确认（ask_user_question 选择记录）。
- commit: f7d10c7 —— 关联提交 6a832fa（实现）与 22aefe8（复审 findings 修复批次一）。
- 锚定理由: AC-06/07/08 为本变更新增承诺，测试标题直接锚定（config.test.js::AC-06、consultation.test.js::AC-07、settings-card.test.js::AC-08），机械门禁 `anchor_coverage` 68/68 与 `agentmap_lint --staged` 通过为权威依据。
- 联调核定项（随目标关闭记档）: 设置卡清空产生的 null 经 gateway persist 落 settings.yaml 后，宿主 describe seam 对该键的校验行为宿主侧不可静态证明；运行时语义由 config.js 解析器单点承载（null → 缺省），风险限于 describe 呈现面。
- review:
  - 审核方: code-review skill 双轴并行独立子代理（Standards 轴 agent 47bdace7-1a34-49a3-b748-43892082a56b、Spec 轴 agent edacb75c-3848-41c7-866c-3f0852e05d87）
  - 目的理解: 落地 C-015 三项东家裁决——callTimeoutMs 默认 600000、maxTokens 缺省经 resolveModelInfo 跟随宿主模型配置（未声明省略、显式覆盖、独立缓存）、web 设置卡补两键（清空=回归缺省）；关联约束为 PRD R-02-001/AC-06/07/08、C-015 决策与被否方案、SOLUTION 横切约束（分歧记账、非阻断不变量）；预期行为为三项交付 + map 原子级联 + strict 锚定；验证方式为 229 用例全套件 + anchor_coverage + expected_fail_check + parity + bundle 新鲜度门禁。
  - 执行方式: code-review skill 双轴并行独立子代理；首轮基线 20c08dc...6a832fa；复审基线 6a832fa...22aefe8（同一审核方双轴）；低级收口 f7d10c7。
  - 问题与修复: Standards 首轮 4 硬违规（分歧账本缺落点→SOLUTION 两处声明新承载；AC-04 矛盾→限定枚举；阈值清空无锚→补断言；AC-06 无标题锚→补标题测试）+ Spec 首轮 1 高（scout maxTokens 直传构成 C-015 被否形态的静默行为变化→引擎经 runScout 缝下发解析缝、同语义共享缓存 + 测试）与 1 中（describe Schema 投影漂移→头注显性化 + null 持久化记联调核定项）及低级项（负数用例、task 归因）→ 修复批次 22aefe8；复审新发现 signal 形态错位（scout 解析脱离 timeout 约束）→ 兼容归一 + 断言，锚定行重复删除 → f7d10c7。
  - 复审结论: 双轴逐条推翻原发现并确认处置合格；Standards 判断题「平行解析缝」以 C-015 最小改动取舍结案；Spec「无阻塞项，可关闭 T-016」（f7d10c7 后信号形态已修复并加断言钉住）。
- 残余风险: ① scout 主语义外的宿主 describe seam 对 null 的校验行为为联调核定项（见上）；② maxTokens 缺省跟随模型配置（131072）较旧固定 16384 显著放大单次咨询输出上限——成本与极长意见风险由 callTimeoutMs 600s 兜底，东家明示接受；③ 门内联同步等待与咨询超时共享 600s 上限，循环门命中最坏阻塞执行者 10 分钟（东家会话确认接受）。
