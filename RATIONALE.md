---
doc-type: rationale
mutation: append-only
id-prefix: C
owner: agent 主笔，项目属主审批
---

# RATIONALE — 决策依据

### C-001 门命中时同步阻塞受守护动作直至意见形成
日期: 2026-09-22

#### 上下文
dsh 的 `tools/pre-execute` waterfall 决定门可以在动作 dispatch 前介入；pi-advisor-flow 的门语义是评审先行、blocker 可拒。异步评审（先放行、意见后到）无法兑现"blocker 级意见拒绝动作"的承诺。

#### 决策
门命中时在 waterfall 内同步 `await` 咨询完成，再按门策略处置；等待受 `callTimeoutMs` 硬约束，超时/失败 fail-open 放行并记录。

#### 被否方案及原因
- 异步评审 + 放行后送达意见：阻断语义失效，blocker 只能事后补救，等于退化成逐轮评审器（即现 dsh-advisor 的形态）。
- 拦截后长期悬挂等待人工：与宿主 approval 通道重复，且 stall 主循环违反非阻断不变量。

#### 影响面
R-01-003、R-01-004、R-01-005、R-01-006 / 门控服务；R-02-005 / 咨询服务

### C-002 咨询上下文经会话事件增量观察组装，不读会话持久化存储
日期: 2026-09-22

#### 上下文
顾问需要会话上下文。dsh 会话存储有版本化文件格式与投影层；直接读盘耦合存储内部且难以增量。dsh-advisor 的 delta 观察模式已验证事件流足以支撑有界上下文。

#### 决策
维护每会话有界 markdown 增量（`session/event` + snapshotEvents），压缩/重写时重置游标；素材组装只依赖事件流。

#### 被否方案及原因
- 每次咨询整读会话持久化文件：成本高、耦合存储格式演进、压缩后语义断裂。
- 全量历史注入顾问：成本与隐私双输，pi 侧同样采用分级裁剪而非全量。

#### 影响面
R-02-004 / 咨询服务；R-01-004、R-01-005 / 门控服务、会话观察

### C-003 用量核算落插件自有台账，不等待宿主聚合口
日期: 2026-09-22

#### 上下文
pi 侧用量归入其 `/cost` 聚合；dsh 无对等聚合口。东家已选插件自记账。

#### 决策
插件内维护用量台账（逐次 + 会话累计，按入口类型分类），`/advisor status` 呈现；缺失项记不可得。

#### 被否方案及原因
- 等待 dsh 提供 /cost 类聚合口：时机不受控，阻塞核算需求。
- 只写日志不做查询面：R-02-002 的可查询承诺无法兑现。

#### 影响面
R-02-002、R-02-003 / 配置与状态服务

### C-004 分阶段交付的锚定缺口走 migration 机制，不绕过门禁
日期: 2026-09-22

#### 上下文
strict 测试锚定要求全部 27 个 AC 有锚点；T-001（咨询核心）只覆盖 12 个，其余 15 个属门控/命令/卡片范围。pre-commit 门禁因此阻塞实现提交，执行代理曾以绕过门禁的方式放行（处置见本条）。

#### 决策
采用 AgentMap 自带的 `测试锚定模式: migration T-002`：建立 active 迁移任务 T-002 承载锚点缺口，全部 27 个锚点落地后切回 strict 并关闭 T-002。已绕门禁的提交不重写，后续提交全部走正常门禁。

#### 被否方案及原因
- 继续 `--no-verify`：绕过门禁成为惯例，pre-push 重放也会持续告警，门禁形同虚设。
- 把 T-001 范围扩成 v1 全量实现再关 task：任务失去可审边界，review 粒度恶化。

#### 影响面
T-002 / 全部需求；CONVENTIONS（测试锚定模式）

### C-005 quota 暂停时等待方按丢弃策略收敛而非保留待处理
日期: 2026-09-22

#### 上下文
SOLUTION 初稿写"quota → 暂停并保留待处理"；实现发现保留等待方会悬挂工具调用，与 DOMAIN 非阻断不变量（R-02-005/AC-01）冲突。只有一个合理选项：fast-fail。

#### 决策
quota 暂停时新咨询与等待方一律立即返回 `ADVISOR_PAUSED`（丢弃策略收敛），恢复经显式 resume；SOLUTION 措辞已对齐。

#### 被否方案及原因
- 保留待处理直至配额恢复：等待方悬挂 = 变相 park 主循环，违反非阻断不变量。

#### 影响面
R-02-005 / 咨询服务

### C-006 T-002 终态审核覆盖的更正与 Standards 轴追认
日期: 2026-09-22

#### 上下文
T-002 终态 review 块曾把 Standards 轴在各实现轮中的在飞核验表述为该轴对 T-002 的签收；advisor 指出后，主责 agent 试图直接修改终态文件，被 lint 的终态不可变校验机械否决。更正改由本决策承载，并取得 Standards 轴代理的显式 ack。

#### 决策
T-002 迁移成果的审核 = Standards 轴在 T-001 终确认、T-003 与 T-004 各轮复审中的在飞锚点真实性核验（空格锚点改正发生于 T-001 修复轮，具体提交可经 T-001 终态证据反查）+ lint 机械校验（test-anchored 30/30、warnings 清零，收口前独立复跑实证）。Standards 轴未对 T-002 单独出具终审；主责 agent 据此归并关闭成立，无需本轴专项终审追认。Standards 轴 ack 已取得，其要旨即上述决策语句本身（含对 T-001 修复轮的具体指向）。

#### 被否方案及原因
- 直接修改终态任务文件：被 AgentMap lint 的终态不可变校验拒绝——机械门禁优先于口头授权，例外不成立。
- 为一条更正重开双轴全流程：与更正的量级不成比例。

#### 影响面
T-002（审计链更正）

### C-007 全面放弃 dsh-advisor 谱系借鉴，门控与送达对齐 pi-advisor-flow 0.8.1
日期: 2026-09-24

#### 上下文
东家试用了宿主上的 dsh-advisor 0.4.1（omdsh-dev）后认定其实现不佳，明确指示全面放弃对该插件的任何借鉴，向移植源头 pi-advisor-flow 对齐。此前移植版混用了两套来源：pi 的自由文本意见 + 门控清单，与 dsh-advisor 的 severity 三级（nit/concern/blocker）、severity→inject/steer 分流、immuneTurns 冷却、`[advisor:{severity}]` 消息格式、咨询失败三分类（重试/暂停/停机）与门策略三值（review/ask/block）。staging 实弹验证期间 pi-advisor-flow 0.8.1 源码核对确认：其原生模型与本版实现存在结构性差异，混搭没有保留价值。

#### 决策
全面退役 dsh-advisor 谱系元素，行为模型对齐 pi-advisor-flow 0.8.1：意见无严重度分级（按需咨询协议为「完全无问题时首行 `Verdict: sound`」二值约定）；唯一硬门为循环门，顾问回复以 `Decision: proceed|revise|blocked` 首行裁定，处置按全局 `failureMode`（warn-and-continue / block-tool / block-session，含会话封锁）执行；咨询失败无重试，直接按阻断模式处置；plan/failure/completion 三门降为注入执行者系统提示的行为守则（`ctx.systemPrompt.section` 实时求值）；门结果一律 steer 送达（`**Decision: X**` + 全文），无冷却；人工审批通道删除。

#### 被否方案及原因
- 保留混搭（severity + 门策略 + pi 决策行并存）：两套处置模型语义重叠且互相冲突（severity 分级在 Decision 协议下无消费方），维护双模型只增复杂度。
- 仅换消息格式保留门策略：东家已对 dsh-advisor 的实现质量作出否定裁决，其「策略+严重度」组合正是被否定的核心，格式对齐而模型保留会延续同一缺陷。

#### 影响面
R-01-003 / R-01-004 / R-01-006 / 执行者守则；R-01-005 / 门控服务（T-010）

### C-008 严格对齐口径与分歧裁决包（文案英文化、默认值、Jev NG、Scout spike 门槛等八项）
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

### C-009 行为对齐基线冻结为 pi-advisor-flow 0.8.2 npm 制品
日期: 2026-09-25

#### 上下文
T-010 对齐基线记录为 0.8.1；审计期间 npm latest 已为 0.8.2。逐文件机械 diff 证实 0.8.1→0.8.2 唯一行为面变化是 Scout 超时从硬编码提升为配置键（advisorScoutTimeoutMs，默认 30000ms）与 scout-status fallback 文案修正，门/咨询/守则/隐私/用量/解析器零行为变化。顾问意见要求对齐目标锚定到具体制品，防目标漂移。

#### 决策
对齐基线冻结为 pi-advisor-flow@0.8.2 npm 制品（sha256 ead4e3a2bbdabc1f16935120c01e0d16fb68ccacb23c63424a984f1140e1b401；npm integrity sha512-KmHaVtkwaiDnZdwIIxu3Ll784NtmvZoaMxRjLe2esBxUigfT8WbZpy8Cyj+jAOAHoPRvNWKvQQx96T5V5uPf7A==）；0.8.1 制品（sha256 f65b8c905d442e5c4b0f028e968a5921b6a5abf6792b03dde9e25fe0d0839941）留存作增量核对参照。审计证据以该制品解包源码为准（.tmp-audit/v0.8.2）。

#### 被否方案及原因
- 维持 0.8.1 基线：npm latest 已是 0.8.2，差异仅 Scout 超时可配，冻结 0.8.2 使 Scout spike 直接面向目标态。
- 以 GitHub main 分支为基线：浮动引用会漂移，违背可审计要求。

#### 影响面
全部需求（对齐判据的引用基准）；审计与验收证据链

### C-010 锚定覆盖机械闸门：必锚清单双向校验与僵尸预期规则
日期: 2026-09-25

#### 上下文
测试锚定迁移模式（C-004）允许 AC 暂缺锚点，但顾问复审（adv-6/adv-7）指出：迁移期「未锚定 AC 归属哪个 task 收敛」若无机械校验，存在漏配风险——复算证实 R-02-003/AC-03 确实漏配；且预期失败清单若不随 task 终态退役，会长期把回归漂白成「预期红」。迁移模式的收敛判定需要一个可执行闸门而非口头承诺。

#### 决策
新增 `tools/anchor_coverage.py` 并经 `.githooks/pre-push.d/40-anchor-coverage.sh` 接入权威验证入口：① 双向覆盖——每个未锚定 AC 必须出现在至少一个 task 的「必锚 AC（收敛闸门）」清单（区间语法展开），清单引用必须指向真实存在的 PRD AC（幽灵引用报错）；② 僵尸预期——`测试锚定模式: migration T-nnn` 所指 task 终态后残留未锚定 AC 即错误。所有 task 的必锚清单为收敛闸门：清单内 AC 全部落锚是该 task 关闭的必要条件。

#### 被否方案及原因
- 只靠 lint 的锚点计数：计数只回答「多少未锚」，不回答「谁负责收敛」——漏配（R-02-003/AC-03）正是计数发现不了的。
- 扩展 agentmap_lint.py 本体：覆盖规则是本项目迁移期专有闸门，独立脚本 + hook 接线保持 lint 通用性与本闸门的可拆除性（strict 恢复后可整体退役）。

#### 影响面
T-011～T-014（收敛闸门）；CONVENTIONS（验证门禁登记）

### C-011 预期失败账本机器可读化与零 AC 需求逃逸分支
日期: 2026-09-25

#### 上下文
顾问复审（adv-8）接受锚定覆盖闸门（C-010）但指出三点残留：① 预期失败清单为纯文字账本，已发生一次计数错误（13→14），逐项转绿无机械凭据机制，叙述性宣布不可信；② 终态规则只检查「残留未锚 AC」，零 AC 需求（如 spike 前的 Scout）恰好不触发该规则，形成最需兜底需求的逃逸通道；③ 两条 AC 为过 lint EARS 正则而改写，需语义复核。同时须确认迁移期内 pre-push 对账本内失败的处置（容许账本内失败、拒绝计划外失败）。

#### 决策
① 建立机器可读账本 `test/expected-fail.json`（每项绑定测试标题、AC 与失败签名；文件级失败单列）+ `tools/expected_fail_check.py`（TAP 运行 → 实际失败集合与账本集合相等比较：计划外失败错误、账本条目转绿亦错误并要求移除条目——转绿以运行输出为凭）+ `.githooks/pre-push.d/50-expected-fail.sh` 接入权威验证入口；② anchor_coverage 增加零 AC 逃逸分支：migration task 终态后每需求必须 ≥1 AC；③ 两条 AC 改写经 diff 复核语义零漂移（仅加 EARS 框架，波动归一与 settings 映射约束逐字保留）。

#### 被否方案及原因
- 以叙述维护预期失败清单：已有一次计数错误实证，叙述不可审计。
- 把 expected-fail 校验并入 anchor_coverage：二者职责不同（谁负责收敛 vs 红基线是否如实），分开才能独立演进与退役。
- 账本转绿仅告警不阻断：转绿是收敛信号，必须强迫同步更新账本，否则账本重新腐化。

#### 影响面
T-011～T-014（红基线与转绿管理）；CONVENTIONS（验证门禁登记）；test/expected-fail.json（账本本体）
