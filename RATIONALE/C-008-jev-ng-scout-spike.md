---
doc-type: rationale
mutation: append-only
id: C-008
owner: agent
---

# C-008 严格对齐口径与分歧裁决包（文案英文化、默认值、Jev NG、Scout spike 门槛等八项）

日期: 2026-09-25

#### 上下文
行为差距审计（主线程 + 双子代理三路证据，pi 0.8.2 基线）产出 20+ 项真实差距。东家裁定「除 dsh 无法承载的功能外，行为与 pi 原版插件严格一致」，并就八个分歧点逐项裁决：守则与全部模型面文案语言、默认值方向（failureMode / 三门开关 / redactSecrets 与 pi 相反）、Jev（依赖 TypeSafe/OpenRouter 外部付费服务）、Scout（实验性上下文策展）、预算拦截时点（宿主无 tool_call 预订缝）、per-tool 披露策略、模型白名单、outcome 回写落盘。顾问评审（adv-4）要求：L/M 差距主线程复核后才进 task 分解；「严格一致」须以分歧账本（gap → 对齐/适配/豁免 + 东家签字）为可审计载体；文案对齐用程序化字符串表等值断言。

#### 决策
① 全部模型面文案（守则四行、ADVISOR_SYSTEM、ADVISOR_DECISION_SYSTEM、ask_advisor 与 outcome 工具描述与参数描述）恢复 pi 0.8.2 英文原文，逐字一致，不留中文；② 默认值对齐 pi：failureMode=block-session、三门守则与循环门默认开启、redactSecrets=false（开箱不脱敏，设置卡显著提示风险）、repoContext=summary、threshold=3；③ Jev 筛查/轮询门与依附的 force 参数记 NG 不移植；④ Scout 以 spike 先行纳入（会话枚举走 dsh-session-query、二次 LLM 复用 llm.stream 缝；执行者模型解析缝待核，不可承载须回报东家再定）；⑤ 预算耗尽维持工具体内值返回、记适配账本；⑥ per-tool 披露策略（advisorToolPolicies full|summary|exclude）纳入对齐；⑦ 模型白名单补配置键并在门/手动等入口检查；⑧ outcome 回写对齐实现（JSONL+HMAC，密钥由插件生成，不追求与 pi 账本互读）；⑨ 偏好区（user_preferences）以 settings 命名空间映射承载。simple mode 与 herdr/TUI 面维持豁免（NG-7/NG-8）。

#### 被否方案及原因
- 保留中文文案仅语义对齐：东家明示「所有文案恢复英文并保持一致，不留中文」——文字本身即行为面，语义转写不满足严格一致口径。
- 默认值保留 port 更安全方向（redactSecrets=true、failureMode=warn-and-continue）：与严格一致裁定冲突；安全回退以设置卡风险提示与迁移说明补偿，不作为默认偏离的理由。
- Scout/Jev 一并 NG：东家对 Scout 明确「纳入对齐」，与 Jev 处置不同；两者依赖面不同（Scout 用宿主自有能力，Jev 依赖外部付费服务），不捆绑裁决。

#### 影响面
R-01-001～R-01-008、R-02-001～R-02-006（全文）；NG-6～NG-8；咨询服务、门控服务、执行者守则、会话观察、配置与状态服务
