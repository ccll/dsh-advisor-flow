---
doc-type: task
mutation: lifecycle
id: T-015
---
# T-015 会话词汇识别权归位：宿主运行时词汇表取代手工白名单快照

风险等级: standard
状态: active
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

（active 期间留空；关闭时填写）
