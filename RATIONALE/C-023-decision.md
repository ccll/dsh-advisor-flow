---
doc-type: rationale
mutation: append-only
id: C-023
owner: agent
---

# C-023 收口评审按关键词豁免审核类子会话

日期: 2026-10-10

#### 上下文
hard 模式下，主会话经 skill（如 code-review）发起的审核类子会话，其回合收口也触发收口评审，形成「对审核进行审核」——元评审冗余，且落在高频路径（AgentMap 流程每 task 关闭必走 code-review，每子会话收口一次同步咨询，扇出放大拉长主会话关键路径）。东家三轮讨论收敛：全量豁免一切子会话过宽（执行类子会话保障丢失）；把关点全部后移主会话收口则把交付物把关全压回 code-review skill。机制先行实证（真实会话日志取证）：子会话自身日志 header 携带 `origin:"subagent"`；`subagent/descriptor` 事件承载 durable 创建标签；首条提示词经 `agent/inbox/spliced` 承载（实测子会话日志无 `user/message` 事件）；fork 会话 header 无 `origin` 字段，`origin === 'subagent'` 严格判定可绕开 seed 回放边界；code-review 实际 label（`Standards review of T-032` 等）命中双语关键词。

#### 决策
收口评审对「子会话自证（日志 header `origin === 'subagent'`）且 label 或首条提示词命中豁免模式清单」的收口跳过评审。豁免清单为新配置键 `turnReviewExemptPatterns`（非空字符串数组，默认双语预置 review/审核/审查/评审/审计，空数组即关闭豁免），判定失败 fail-open 照常评审，判定结果按会话缓存。

#### 被否方案及原因
- 全量豁免一切子会话：搜索、计划、判断类子会话是工作单元，收口评审保障一并丢失，东家裁定过宽。
- 收口点后移（仅依赖主会话收口把关子会话结论）：子会话过程级把关在素材补齐后本可得，弃用理由须落在需求归属与成本——素材补齐后该方案论证自动失效；且错误结论先污染主会话上下文再被拦，修正成本更高。
- parent 链接探针判定子会话身份：子会话自身 header 已实证携带 `origin`，探针不必要。
- 硬编码关键词（不落配置）：skill 文案一变即漂移，配置面承载使东家可控可修（与 mode、failureMode 同型先例）。

#### 影响面
R-01-009（评审对象语义细化与新 AC）、R-02-001（配置键清单）；门控服务（收口评审处置）、配置与状态服务（T-023）。
