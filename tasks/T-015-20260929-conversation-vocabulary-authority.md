---
doc-type: task
mutation: lifecycle
id: T-015
---
# T-015 会话词汇识别权归位：宿主运行时词汇表取代手工白名单快照

风险等级: standard
状态: completed
关联: R-02-006（C-014；T-012 spike 边界契约的实现收口）

## 背景与目标

生产故障（2026-09-29 实证）：宿主按配置追加的 `subagent/model-selection-policy` 事件（settings `subagent-model-selection.enabled: true` 使每会话 seq 3 固定出现）被 `lib/conversation-source.js` 的手工 `KNOWN_NON_SURFACE` 白名单判为「未识别的必需事件」→ fail-closed 抛错 → 门审咨询失败 → `failureMode` 默认 `block-session`（settings 未配置，lib/config.js:38）→ 会话级全工具拒绝。实弹拒绝记录：mailai-models 会话 22 次（policy 事件）、ops 会话 28 次（`session/end-seed`，同根因第二词汇）；历史（09-25）另有 `request/header`（22）、`tool/call`（1）同型故障——同一缺陷类随宿主词汇增长反复发作。目标：识别权归位宿主运行时词汇表，词汇增长自动跟随；fail-closed 契约边界不变。

## 差距评估

- 识别权威错位：跳过集是 2026-09-25 staging 观测的手工快照（12 项），宿主已知词汇表 56 项，缺口约 39 项均可在门审触发时炸会话。
- 兜底缺口：快照缺本次实证的两类型，导入不可达的部署形态无防护。
- Map 一致性：PRD 不变；SOLUTION#素材装配器内部结构描述同提交同步（新增词汇识别 bullet 并补全 conversation-source 代码位置——该条目 T-012 落地时本就缺失）。闸口依据：东家 2026-09-29 会话内直接指令「修复根因」，修复方向（跳过集以宿主运行时词汇表为权威）已在当日查证报告中明示并获同意，SOLUTION 演进为该指令的组成落点；SOLUTION 演进记录于此作为闸口证据。

## 收敛方案

- `lib/conversation-source.js`：`KNOWN_NON_SURFACE` 改为运行时推导——权威 `KNOWN_SESSION_EVENT_TYPES`（宿主根包导出；宿主进程已加载同一模块，动态导入命中 ESM 缓存）减插件表面集，∪ 兜底集 `FLOOR_NON_SURFACE`（原快照 12 项 + 本次实证两类型）。动态导入 fire-and-forget，失败保留兜底集，插件引导不受影响。
- 部署链接：`node_modules/@deepseek-ai/dsh-session` → 宿主树同包符号链接（与既有 cosmokit/dsh-typert-protocol/schemastery 同惯例）；链接缺失时动态导入失败 → 兜底集生效（已含实弹全部已知炸点词汇）。
- fail-closed 边界保留：仅宿主词汇与兜底集都不认识且非 ignorable 的事件拒绝重建。
- 纯函数 `knownNonSurfaceFrom(hostKnownEventTypes)` 承载推导并容忍缺失导出，供单测。

## 测试计划

- 回归红→绿：`test/conversation-source.test.js` 新增 5 例——policy 事件跳过、end-seed 跳过、ignorable 未知跳过、双词汇皆未知仍 fail-closed、推导纯函数（含缺失导出回落兜底集）。
- 全套件回归：`npm test` 225 通过 / 0 失败（基线 220 + 新增 5）。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：宿主词汇事实事件跳过、脉络重建不受污染 | `test/conversation-source.test.js::T-015 回归：subagent/model-selection-policy 跳过而非拒绝重建`、`test/conversation-source.test.js::T-015 回归：session/end-seed 跳过而非拒绝重建` |
| 异常 | 适用：词汇推导容忍缺失/畸形导出并回落兜底集 | `test/conversation-source.test.js::T-015 词汇推导：宿主已知词汇 − 插件表面集 ∪ 兜底集（容忍缺失导出）` |
| 边界配置 | 适用：fail-closed 契约边界与 ignorable 契约不变 | `test/conversation-source.test.js::T-015 回归：两处词汇都不认识的非 ignorable 事件仍 fail-closed`、`test/conversation-source.test.js::T-015 回归：ignorable 未知事件仍跳过（宿主契约不变）` |
| 副作用 | 适用：跳过集推导为纯函数无出站行为变化；动态导入失败仅降级跳过集不中断模块装载 | `test/conversation-source.test.js::T-015 回归：subagent/model-selection-policy 跳过而非拒绝重建`、`test/conversation-source.test.js::T-015 词汇推导：宿主已知词汇 − 插件表面集 ∪ 兜底集（容忍缺失导出）` |

## 终态与证据

- 实现: `lib/conversation-source.js` 非表面跳过集改为运行时推导——纯函数 `knownNonSurfaceFrom`（宿主已知词汇 − 插件表面集 ∪ 兜底集 `FLOOR_NON_SURFACE`，容器守卫排除字符串畸形导出）；动态导入宿主根包词汇 fire-and-forget，失败回落兜底集并以 `console.warn` 留降级诊断（每进程至多一次）；fail-closed 仅对宿主词汇也不认识的非 ignorable 事件生效。
- 测试: 回归 5 例新增于 `test/conversation-source.test.js`（policy/end-seed 跳过、ignorable 跳过、双词汇皆未知仍 fail-closed、推导纯函数含缺失与字符串畸形回落断言）；全套件 `npm test` 225 通过 / 0 失败（基线 220 + 新增 5）；`expected_fail_check` passed（账本 baselineExecuted 同步 225）；`anchor_coverage` passed（65/65 锚定）；降级路径实弹验证（摘除链接 → console.warn + 兜底集放行两实证类型，链接已恢复）；真实会话日志事件流探针通过（fail-closed 对日志头记录 `type:"session"` 的拒绝为 fixture 噪声，宿主 observeSession 不下发该记录——由故障现场首炸类型为 seq 3 事件而非 seq 0 日志头反证）。
- SOLUTION 对照: PRD 无变化；SOLUTION#素材装配器新增「会话脉络词汇识别（T-015）」内部结构 bullet 与实现一致（宿主运行时词汇为权威、导入失败落兜底集、fail-closed 边界收窄至宿主未知类型），并补全该模块代码位置（T-012 落地时缺失）。闸口依据：东家 2026-09-29 会话内直接指令「修复根因」（见差距评估）。
- commit: f48409f —— 关联提交 360b45a（复审 findings 修复批次一）与 f14d1e8（复审非阻断观察收口 + expected-fail 基线）。
- 部署注记: `node_modules/@deepseek-ai/dsh-session` → 宿主树同包符号链接为运行时权威生效前提（手工步骤，与既有 peer 依赖 symlink 同惯例，仓库不可核验故记档于此）；链接缺失时降级为兜底集（含全部已知炸点词汇）并输出 console.warn。运行中的宿主进程持旧代码，本修复经宿主进程重启后生效。
- 锚定理由: 新增 5 例回归测试验证的是宿主契约实现边界（fail-closed/ignorable/词汇推导），R-02-006 五条 AC（六区结构/档位/预算/兜底/偏好）均无对应承诺，不属「直接验证需求的测试」，无需 AC 锚点；权威依据为 `anchor_coverage` 机械门禁通过（65/65），按 CONVENTIONS「文字规范与可执行检查冲突时以检查为准」。
- review:
  - 审核方: code-review skill 双轴并行独立子代理（Standards 轴 agent 68eceb1d-a507-453b-8f19-c4824a328167、Spec 轴 agent cf0de3c1-e101-4bca-bc98-e7083a2d5f36）
  - 目的理解: 修复目标是会话词汇识别权归位——宿主已知非表面事件（实证：subagent/model-selection-policy、session/end-seed）被手工白名单误判为未识别必需事件，fail-closed 抛错致门审失败、block-session 默认下会话级全拒绝；关联约束为 R-02-006 素材契约、T-012 spike 定稿的 fail-closed 边界（仅对「未识别」类型）与 C-014 决策；预期行为为宿主已知词汇自动跟随跳过、未知非 ignorable 仍拒绝重建、插件引导不受导入失败影响；验证方式为回归测试 + 全套件 + 真实会话事件实弹探针。
  - 执行方式: code-review skill；首轮基线 f6d6b51...f48409f（双轴并行独立子代理）；复审基线 f48409f..360b45a（同一审核方双轴）。
  - 问题与修复: 首轮 Standards 2 硬性（task「map 不变」表述与 SOLUTION 同步矛盾、闸口证据未记档——已更正并补记东家指令；测试锚定存疑——经机械门禁核实通过并补记理由）+ 3 判断性（推导入口分支冗余——收敛为单一可迭代入口；导入失败静默——补 console.warn 诊断；TODO 标签失配与繁体笔误——已改）／Spec 3 轻微（部署链接 git 不可核验——维持与既有 peer symlink 同惯例并双重记档；TODO 行范围说明——C-014 有意挂账；task 矛盾——同上更正）→ 修复批次 360b45a。复审双轴通过，遗留非阻断观察（字符串畸形导出与验证矩阵承诺的字面偏差、TODO 标签 [需求候选] 裁量）→ f14d1e8 按复审人预先指定 remedy 收口。
  - 复审结论: 双轴均通过（commit 360b45a）；非阻断观察已在 f14d1e8 处置（其一为复审人指定的单行 remedy，其二采纳 Spec 轴裁量建议），无遗留阻断项。
- 残余风险: ① block-session 处置对「兼容性故障」的放大效应为独立策略裁决项，已挂 TODO [需求候选] 待东家裁决；② 导入未决窗口期跳过集为兜底集（含全部已知炸点词汇，权威集随后生效）；③ fail-closed 测试的伪造类型若被宿主未来采纳同名词汇则该例语义失效（可接受脆性，复审已认可）。
