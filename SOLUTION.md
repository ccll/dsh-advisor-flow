---
doc-type: solution
mutation: living
owner: agent 主笔，项目属主审批
---

# SOLUTION — 方案层

## 架构视图清单

| 视图 | 适用性/理由 | 图表位置 |
|---|---|---|
| 系统上下文 | 适用: 插件与宿主、执行者、顾问路由、会话主的边界决定全部接缝 | 系统上下文图 |
| 一级静态分解 | 适用: 插件由七个能力模块组成，模块归属需先定 | 一级静态分解图 |
| 内部组件分解 | 适用: 门控服务的判定管线是正确性与非阻断性的核心 | 内部组件分解图 |
| 运行时交互 | 适用: 咨询往返与门阻断是两个架构级时序 | 运行时交互图 |
| 数据与领域模型 | 适用: 咨询/意见/用量/门记录是跨模块数据契约 | 数据与领域模型图 |
| 状态与生命周期 | 适用: 咨询生命周期与顾问运行态是失败语义的载体 | 状态与生命周期图 |
| 数据流与信任边界 | 适用: 会话素材出境与顾问输出入境是隐私设计的主体 | 数据流与信任边界图 |
| 部署 | 适用: 纯 mount 插件在 web profile 的装载方式需要表达 | 部署图 |
| 分层与依赖 | 适用: 客户端卡片与宿主服务的单向依赖需固化 | 分层与依赖图 |
| 系统景观 | 不适用: 单宿主单插件，外部系统景观与系统上下文重合 | — |

## 方案细化清单

| 关注面 | 适用性/理由 | 方案落点 |
|---|---|---|
| 边界与对外契约 | 适用: 工具、命令、设置命名空间、注入消息格式是插件对外稳定面 | SOLUTION.md#产品契约 |
| 核心数据与不变量 | 适用: 咨询与用量记录的结构决定核算与诊断能力 | SOLUTION.md#数据视图 |
| 状态与生命周期 | 适用: 咨询终态一次性约束失败隔离设计 | SOLUTION.md#运行时、并发与失败语义 |
| 运行时、并发与失败语义 | 适用: 门内联等待与非阻断保证的相互作用是本方案最大风险点 | SOLUTION.md#运行时、并发与失败语义 |
| 外部集成 | 适用: LLM 路由、宿主工具层、会话存储三类集成缝 | SOLUTION.md#静态架构 |
| 配置与可变点 | 适用: 全部行为档位收敛到一个设置命名空间 | SOLUTION.md#产品契约 |
| 安全与信任边界 | 适用: 素材出境与意见入境双向信任问题 | SOLUTION.md#数据视图 |
| 部署、迁移与恢复 | 适用: web profile 装载与版本升级路径 | SOLUTION.md#部署视图 |
| 兼容性与版本演进 | 适用: 依赖 dsh 插件接缝的版本契约需声明 | SOLUTION.md#部署视图 |
| 可观测性与运维 | 适用: 状态查询与失败显性化是 R-02-003 的落点 | SOLUTION.md#运行时、并发与失败语义 |

## 实现就绪检查

| 条件 | 结论 | 证据或落点 |
|---|---|---|
| 边界与契约已明确 | 通过 | SOLUTION.md#产品契约 |
| 关键不变量已明确 | 通过 | DOMAIN.md#跨模块不变量 |
| 重大方案选择已收敛 | 通过 | RATIONALE.md（C-001～C-003） |
| 目标实现归属已明确 | 通过 | SOLUTION.md#子系统与模块 |
| 现状差距已有 task 承接 | 通过 | 全新实现，无现状差距；首个 task 于实现阶段建立 |
| 可派生验证 | 通过 | SOLUTION.md#运行时、并发与失败语义 |

## 静态架构

### 系统上下文图

```mermaid
flowchart LR
    owner[会话主] -->|web GUI / 设置卡| host[dsh web 宿主]
    agent[执行者 agent] -->|ask_advisor 工具调用| plugin[advisor-flow 插件]
    plugin -->|inject / steer 建议注入| agent
    plugin -->|tools/pre-execute 门判定| agent
    agent -->|工具调用 exec| tools[dsh 工具层]
    tools -->|pre-execute waterfall| plugin
    plugin -->|llm.stream 咨询请求| route[顾问模型路由]
    route -->|意见文本| plugin
    plugin <-->|advisor-flow 设置命名空间| settings[settings.yaml]
```

- 插件不修改 dsh 源码（纯 mount）；全部接缝为公开事件与服务。

### 一级静态分解图

```mermaid
flowchart TB
    subgraph bundle[advisor-flow 插件 bundle]
        tool[咨询工具 ask_advisor]
        commands[命令面]
        gates[门控服务]
        consult[咨询服务]
        observer[会话观察]
        delivery[意见送达]
        configsvc[配置与状态服务]
    end
    card[web 设置卡 client bundle]
    tool --> consult
    commands --> consult
    commands --> configsvc[配置与状态服务]
    gates --> consult
    gates --> observer
    observer --> gates
    consult --> config
    config[配置与状态服务] --> gates
    card -->|gateway RPC| config
    consult --> delivery[意见送达]
    delivery --> agent[执行者 agent]
```

### 内部组件分解图

```mermaid
flowchart TB
    subgraph gates[门控服务]
        watcher[调用与失败观察器] --> loopdet[循环等价判定]
        watcher[失败计数器] --> arbiter
        loopdet --> arbiter[门仲裁器]
        planner[计划门] --> arbiter
        completer[完成门] --> arbiter
        arbiter --> policy[门策略处置 review/ask/block]
    end
    arbiter -->|命中| consult[咨询服务]
    consult --> ctxasm[上下文装配器]
    ctxasm --> redact[脱敏器]
    redact --> llmcall[顾问模型调用器]
    llmcall[llmcall] -.-> llmcall2[usage 采集]
    llmcall --> parse[意见解析与 adviceId]
```

- 观察器只读：从 `session/event` 消费 `tool/call` 与结果事件，维护每会话失败计数与循环等价表。
- 仲裁器单一出口：`allow / ask / deny(reason)`，命中即同步触发咨询。
- 失败路径与成功路径同样经过仲裁器；门组件自身异常按放行处置并记录。

## 运行时视图

### 运行时交互图

```mermaid
sequenceDiagram
    participant E as 执行者
    participant G as 门控服务
    participant C as 咨询服务
    participant A as 顾问路由
    participant D as 意见送达
    E->>G: 工具调用（pre-execute waterfall）
    G->>G: 循环/失败/计划/完成判定
    alt 门未命中
        G-->>E: allow（放行执行）
    else 门命中且策略 review
        G->>C: 同步发起咨询
        C->>A: llm.stream（素材 + 脱敏）
        A-->>C: 意见
        C-->>G: 意见（adviceId）
        G->>D: 送达（nit→inject，concern/blocker→steer）
        G-->>E: allow（放行执行）
    else 门命中且策略 block 且存在 blocker
        G->>C: 同步发起咨询
        C-->>G: 意见
        G-->>E: deny（原因 = 意见摘要）
    else 门命中且策略 ask
        G->>D: 征询会话主（approval 通道）
        D-->>E: ask（人工决定后放行或拒绝）
    end
    E->>C: ask_advisor（按需咨询）
    C->>A: llm.stream
    A-->>C: 意见
    C-->>E: 意见文本 + adviceId
```

### 完成门收口时序（agent/turn-stopping）

```mermaid
sequenceDiagram
    participant E as 执行者
    participant H as 宿主回合边界
    participant G as 门控服务
    participant C as 咨询服务
    participant D as 意见送达
    E->>H: 回合收口（无未决工作）
    H->>G: agent/turn-stopping（串行等待）
    G->>G: 回合去重检查（同回合已放行→直接跳过）
    G->>C: 同步发起咨询（entry: gate）
    C-->>G: 意见（adviceId）
    alt review / block 非 blocker / ask 同意
        G->>D: 送达（nit→inject，concern/blocker→steer）
        G-->>H: 放行收口（落回合去重标记）
    else block + blocker / ask 拒绝
        G->>D: agent.steer（反对消息，inbox 续步）
        G-->>H: 收口被反对——宿主重读 inbox 续步（不落去重标记）
    else consult 不可用/超时
        G-->>H: fail-open 放行收口（error 留痕）
    end
```

- 门内联等待有硬上限（`callTimeoutMs`）；超时按非阻断放行并记录。
- 完成门不在工具调用时序内：它挂在 `agent/turn-stopping`（回合收口前的串行派发）上，反对以 steer 数据表达（收口被拒 → inbox 续步）。

## 数据视图

### 数据与领域模型图

```mermaid
classDiagram
    class Consultation {
        +adviceId
        +entry: tool|manual|gate
        +gateKind?
        +state
        +素材引用
    }
    class Advice {
        +adviceId
        +severity: blocker|concern|nit
        +text
        +outcome?
    }
    class UsageRecord {
        +adviceId
        +inputTokens?
        +outputTokens?
        +cacheTokens?
        +cost?
    }
    class GateState {
        +会话id
        +失败计数表
        +循环等价表
        +冷却标记
    }
    Consultation "1" --> "1" Advice : 产生
    Consultation "1" --> "0..1" UsageRecord : 归属
    GateState "1" --> "*" Consultation : 触发
```

- 用量缺失项显式记 `unavailable`，不得落零。
- 素材不出现在意见与用量记录中，只存脱敏摘要与长度计数。

### 状态与生命周期图

```mermaid
stateDiagram-v2
    [*] --> pending: 咨询发起
    pending --> answered: 顾问返回意见
    pending --> failed: 失败（重试耗尽/永久错误）
    pending --> aborted: 超时或取消
    answered --> [*]
    failed --> [*]
    aborted --> [*]
```

- 顾问运行态另有三态：`active / paused(quota) / halted(permanent)`；paused 可经 `/advisor on` 恢复，halted 需重建。
- 终态一次性；终态后只允许追加 outcome。

## 部署视图

### 部署图

```mermaid
flowchart LR
    subgraph user[用户机器]
        proc[dsh web 宿主进程]
        subgraph profile[web profile]
            nm[node_modules/dsh-advisor-flow]
        end
        proc --> nm
        browser[浏览器 web GUI] -->|gateway RPC| proc
    end
    nm -->|HTTPS| api[顾问模型路由端点]
    settings[~/.dsh/settings.yaml] --> proc
```

- 安装：`dsh plugin --profile web add dsh-advisor-flow`（npm 发布，含构建产物）。
- 升级：版本替换 + 设置键向前兼容；无宿主补丁、无 postinstall。

## 补充架构视图

### 内部组件分解图

见「静态架构 → 一级静态分解图」之上的内部组件分解图；门仲裁器为唯一判定出口，观察器为唯一事件入口，两者经每会话状态隔离。

### 数据流与信任边界图

```mermaid
flowchart LR
    subgraph trust[宿主信任域]
        transcript[会话转写/工具结果]
        args[工具调用参数]
        red[脱敏器]
    end
    transcript -->|隐私档位裁剪| red
    args -->|隐私档位裁剪| red
    red -->|不可信数据标注| route((顾问模型路由))
    route -->|意见文本| deliver[意见送达]
    deliver -->|advisory 前缀注入| session[会话流]
```

- 出境侧：素材按档位裁剪后才可出境；脱敏在裁剪后、发送前执行。
- 入境侧：顾问输出按不可信数据处理，仅以 advisory 前缀消息进入会话流，永不作为工具结果或系统指令。
- 密钥形状值在出境侧被占位替换；脱敏关闭时明确告知会话主风险（设置卡提示）。

### 分层与依赖图

```mermaid
flowchart TD
    card[web 设置卡 client bundle] -->|gateway RPC| cfg[配置与状态服务]
    cmd[命令面] --> cfg
    cmd --> consult[咨询服务]
    tool[咨询工具] --> consult
    gates[门控服务] --> consult
    gates --> obs[会话观察]
    obs --> transcript[会话存储投影]
    consult --> llm[dsh LLM 运行时]
    deliver[意见送达] --> agent[dsh agent 表面]
    consult --> deliver
```

- 依赖单向：客户端 → 宿主服务 → dsh 公开缝；禁止反向与环。

## 产品契约

- **咨询工具** `ask_advisor`：
  - 入参：`question?: string`、`draft?: string`；均可省略（一般性评审）。
  - 返回：意见文本 + `adviceId`；失败返回带诊断码的错误（`NO_ADVISOR_MODEL` / `ADVISOR_ROUTE_MISSING` / `ADVISOR_TIMEOUT` 等）。
- **命令**：
  - `/advisor-manual [focus]`：立即咨询；进行中可取消。
  - `/advisor status`：启用态、模型路由、各门状态、待处理数、最近活动、累计用量摘要。
  - `/advisor gates`：门配置与阈值只读回读。
  - `/advisor on|off|toggle`：会话级临时开关，不写持久配置；裸 `/advisor` 等价 toggle（UX 增项，契约在此补记）。
- **设置命名空间** `advisor-flow`（settings.yaml 顶层键）：
  - `enabled`（默认 false）、`advisor.provider`、`advisor.model`、`advisor.reasoningEffort?`、`advisor.maxTokens`、`advisor.callTimeoutMs`、`advisor.retryAttempts`（瞬态重试次数，默认 1）
  - `gates.plan|failure|loop|completion`：各含 `enabled`、`policy(review|ask|block)`、阈值（failure/loop 另有 `threshold`，failure 另有 `policy(block|block-session)`）
  - `privacy.history(off|delta|window)`、`privacy.repoContext(none|summary|patch)`、`privacy.toolResults(off|capped)`、`privacy.toolResultMaxBytes`（capped 档字节上限）、`privacy.fileContent(默认 false)`、`privacy.redactSecrets`
  - `budget.maxPerSession`（0 = 不限）
  - 未知键警告保留；缺 provider/model 时整体禁用且状态可查询。
- **注入消息格式**：`[advisor:{severity}] <摘要>`；意见正文附 adviceId 引用。

## 需求追溯索引

| 需求 | 主责子系统 | 方案落点 | 实现位置 |
|---|---|---|---|
| R-01-001 | 咨询服务 | SOLUTION.md#咨询服务 | lib/consultation.js；lib/tools/ask-advisor.js |
| R-01-002 | 咨询服务 | SOLUTION.md#命令面 | lib/commands.js |
| R-01-003 | 门控服务 | SOLUTION.md#门控服务 | lib/gates/plan.js |
| R-01-004 | 门控服务 | SOLUTION.md#门控服务 | lib/gates/failure.js |
| R-01-005 | 门控服务 | SOLUTION.md#门控服务 | lib/gates/loop.js |
| R-01-006 | 门控服务 | SOLUTION.md#门控服务 | lib/gates/index.js（handleTurnStopping） |
| R-02-001 | 配置与状态服务 | SOLUTION.md#配置与状态服务 | lib/config.js；lib/client/card-state.js；lib/client/render.js |
| R-02-002 | 配置与状态服务 | SOLUTION.md#配置与状态服务 | lib/usage.js |
| R-02-003 | 配置与状态服务 | SOLUTION.md#配置与状态服务 | lib/status.js |
| R-02-004 | 咨询服务 | SOLUTION.md#数据流与信任边界图 | lib/context.js；lib/redact.js |
| R-02-005 | 咨询服务 | SOLUTION.md#运行时、并发与失败语义 | lib/consultation.js；lib/gates/index.js |

## 子系统与模块

### 咨询服务
- 职责: 顾问模型调用的唯一入口——上下文组装（隐私裁剪、脱敏）、llm.stream 调用（根作用域 LLM 解析、reasoningEffort 能力门控）、意见解析（自由文本，宽松 JSON 兼容）、adviceId 分配、用量记录（承接 R-01-001、R-01-002、R-02-004、R-02-005）
- 关键内部结构:
  - LLM 服务从应用根解析（`ctx.root?.get('llm') ?? ctx.llm`），防隔离作用域 NO_ADAPTER。
  - `resolveModelInfo` 能力门控 effort：仅模型声明时发送，缺省不传（路由 defaultEffort 会物化，须显式传 off 等级）。
  - `maxTokens` 与 `callTimeoutMs` 可配置；deadline 融合 dispose 信号，race 每 chunk。
  - 失败三分类：transient（重试 1 次）/ quota（pause）/ permanent（halt）；对工具调用表现为带诊断码的当次错误。
  - 意见为自由文本，不做严格 JSON 帧约定；严重度由顾问显式声明，缺省 nit。
- 代码位置: lib/consultation.js；lib/context.js；lib/redact.js
- 实现: 单端（宿主）

### 门控服务
- 职责: 注册 `tools/pre-execute` waterfall 监听对计划/失败/循环三门做前置判定与处置；注册 `agent/turn-stopping` 串行监听承载完成门的回合收口评审（承接 R-01-003～R-01-006）
- 关键内部结构:
  - 判定数据来自会话观察器维护的每会话 `GateState`。
  - 计划门锚定 `exit_plan_mode` 工具名；失败/循环门锚定观察器计数；完成门锚定 `agent/turn-stopping`（宿主无名为 concludesTurn 的工具，回合收口是串行事件 + steer 反对语义，T-008 实测裁决）。
  - 载体契约（dsh-tools 0.1.5-rc.2 实测）：工具名 `exec.name`、参数 `exec.arguments`、会话 `exec.agent.id`；结果缝 `(exec, result)` 两参、失败真值 `result.isError`。
  - 命中即同步 `await` 咨询，处置按门策略：review 放行+送达；ask 转 approval 通道；block 且 blocker 即 deny(reason)。完成门的反对经 `agent.steer` 表达（serial 派发无返回值否决通道）。
  - 门组件异常 fail-open（放行 + 记录），咨询超时同此；收口路径任何异常 contained，不得打断宿主收口流程。
- 代码位置: lib/gates/
- 实现: 单端（宿主）

### 会话观察
- 职责: 全局订阅 `session/event` 与 `tools/result`，维护有界转写增量与工具调用/结果统计，供咨询上下文组装与门判定（承接 R-01-004、R-01-005 的观测面）
- 关键内部结构:
  - 监听必须 `{ global: true }`（跨 scope 会话事件）。
  - 成败计数的权威缝是 `tools/result` 生命周期事件（`(exec, result)` 两参：`exec.name`、`result.isError`、`exec.callId` 去重）；session/event 的 `tool/result` 存储记录不带工具名，只承载压缩/重写 reset 类事件（T-008 实测裁决，双缝去重议题关闭）。
  - 压缩/重写事件重置观察游标与计数。
- 代码位置: lib/observer.js
- 实现: 单端（宿主）

### 意见送达
- 职责: 意见到会话的路由——severity → `agent.inject`（nit，非唤醒）/ `agent.steer`（concern/blocker，唤醒）；维护会话级 agent 映射（承接 R-01-003~006 的意见送达）
- 关键内部结构:
  - `agent/created` 注册 + 注册表回退双通道。
  - immuneTurns 冷却防止意见风暴。
- 代码位置: lib/delivery.js
- 实现: 单端（宿主）

### 配置与状态服务
- 职责: `advisor-flow` 命名空间注册与 live re-apply（signature 变更才重建运行时）；settings section 注册（SettingsProvider.installSection——describe 服务本命名空间是设置卡渲染的前提）；web 设置卡 gateway RPC（get/set，持久写经 settings.update 由宿主承担）；用量台账；状态快照（承接 R-02-001、R-02-002、R-02-003）
- 关键内部结构:
  - settings section 注册：installSection(ns, Schema, entry) + source-thunk 指向 settings 文件段 + onChange → live re-apply；重复注册回退 entry-source（多 fiber）。
  - 设置解析器拒绝非法值但保留未知键并警告（非法用户层 disabled-with-reason 兜底且 raw 保留真实键）。
  - 持久写：合法保存即运行时生效 + 经 settings.update 写回（宿主桥单写者）；写缝缺失/写失败显性降级（degradations.persistence），卡片回执双形态（已持久化/仅运行时态）。
  - 状态快照含启用态、路由、门状态、pending、最近活动、用量摘要。
  - 失败显性化：丢弃/超时/配额一律 info 级日志带原因。
- 代码位置: lib/config.js、lib/settings.js、lib/gateway.js、lib/usage.js、lib/status.js
- 实现: 单端（宿主）+ client 卡片（lib/client/card-state.js 纯逻辑 + lib/client/render.js 零依赖 DOM + lib/client/index.js bundle 入口）

### 咨询工具
- 职责: 注册 `ask_advisor` 工具面，参数校验与错误转译（承接 R-01-001）
- 关键内部结构: 工具体仅转发咨询服务，不含判定逻辑；定义必须声明 `output { schema, render }`（宿主 tools.register 强制，缺失即注册失败），value 契约 `{ok:true,adviceId,severity,text} | {ok:false,code,reason}`，render 出 text 块。
- 代码位置: lib/tools/ask-advisor.js
- 实现: 单端（宿主）

### 命令面
- 职责: `/advisor-manual`、`/advisor status|gates|on|off|toggle` 命令挂载（承接 R-01-002、R-02-003）
- 代码位置: lib/commands.js
- 实现: 单端（宿主）

### web 设置卡
- 职责: 设置页 Advisor Flow 卡片（开关、模型、门矩阵、隐私档位），经自有 gateway RPC 读写（承接 R-02-001 的 GUI 面）
- 代码位置: lib/client/
- 实现: client bundle（web profile）

## 横切约束

- 非阻断性优先于功能完整：任何 advisor 路径不得 park 主循环（见 DOMAIN 不变量）。
- 门内联等待是唯一同步点，且受 `callTimeoutMs` 硬约束、超时 fail-open；完成门的内联等待挂在 `agent/turn-stopping` 串行派发上，收口等待同样受 `callTimeoutMs` 约束、超时放行收口。
- 观察与判定不读会话持久化文件，只依赖事件流与投影。
- 宿主载体契约（T-008 实测，dsh 0.1.5-rc.1 / dsh-tools 0.1.5-rc.2）：工具载体 `{name, arguments, agent, callId, token, signal}`；结果缝 `(exec, result)`、失败真值 `result.isError`；回合收口缝 `agent/turn-stopping`（payload `{turn, signal, agent}`，serial 派发、steer 数据反对）；送达消息 content 为 ContentBlock 数组且带 id；工具定义必须含 `output {schema, render}`。
- LLM 请求契约（T-009 staging 实测，dsh-llm GenerateOptions）：`messages[].content` 为 ContentBlock 数组（字符串 content 在适配器内容遍历抛 `content.some is not a function`）；`system` 为字符串（一次性调用方）；流 chunk 为 `text-delta`/`usage`/`finish`。
- 用量契约（T-009 staging 核对，dsh-llm TokenUsage）：`inputTokens`（未缓存输入）/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`totalTokens?`/`reasoningTokens?` 离散计数，无 `cacheTokens` 与 `cost` 字段；台账未收到的字段记 unavailable（R-02-002/AC-02）。
- 插件零宿主补丁、零 postinstall；对 dsh 插件接缝（pre-execute、tools/result、session/event、agent/turn-stopping、inject/steer、settings、gateway RPC、命令注册）的版本假设在 package.json 声明。
- 宿主服务访问双原语（装载期实测教训）：必选服务声明式 `inject = ['agents', 'llm']`（缺任一整插件不装载）；可选服务（approval/commands/typert/settings）一律条件 `ctx.inject` 子上下文——未激活即缝缺失路径，降级标注保留、激活时清除，绝不以 try/catch 探测 ctx 代理属性（cordis 下不可靠，曾致装载崩溃）。tools 特殊：条件子上下文 + 注册失败 fail loud（ask_advisor 是唯一用户面）。
- package.json 必须声明 `exports` 段含 `./client` 子路径（client 装载器按 `<包名>/client` 解析插件 client 半区；缺失则宿主半区正常装载而设置卡静默不出现）。
- 全部 dsh 接缝调用点：`ctx.root.get('llm')`、`llm.resolveModelInfo` 能力门控、`ctx.on('tools/pre-execute')`、`ctx.on('tools/result')`（两参成败缝）、`ctx.on('agent/turn-stopping')`、`ctx.on('session/event', …, {global:true})`、`agent.inject/steer`、settings bridge `onChange`、GatewayService RPC、命令注册表。
- 思考型顾问路由默认 effort 可能为 max：调用必须显式携带能力门控后的 effort；预算与超时可配置，不得硬编码。
- 日志统一 `ctx.logger('advisor-flow')`，失败原因 info 级可见。

## 运行时、并发与失败语义

- **门内联等待**：门命中时工具调用暂停等待咨询完成（同步 await），上限 `callTimeoutMs`（默认 180s，可配）；超时/失败按放行处置并记录（R-02-005 AC-02）。`ask` 策略走宿主 approval 通道，拒绝即 deny。完成门的内联等待在 `agent/turn-stopping` 串行派发内：收口被 block/blocker 意见反对时以 `agent.steer` 数据表达，宿主重读 inbox 续步；监听器全 contained，异常不打断收口。
- **失败分类**：transient → 重试 1 次（1s 退避）→ 丢弃并记录；quota → 暂停并保留待处理；permanent（NO_ADAPTER、模型不存在、凭证无效）→ halt 顾问（门按放行处置，工具调用返回诊断错误）。
- **丢弃可见性**：每次丢弃记录 info 级日志（原因 + 会话 + 入口类型），状态可查。
- **并发**：同会话咨询串行（FIFO，容量上限，满则丢新）；不同会话并行互不影响。
- **重入防护**：咨询工具自身被门拦截豁免（防止门触发咨询的工具调用自递归）；顾问调用不经过工具层。
- **完成门与收口去重**：`agent/turn-stopping` 对同一回合的每次收口尝试都会再派发，而完成门的任何输出就是一次续步（送达 inject 与反对 steer 都落 next-step inbox）。
  - 去重标记只在**放行收口**的处置后落（review / block 非 blocker / ask 同意）：同回合的后续收口尝试直接放行，送达后续步的循环有界。
  - **反对收口不落标记**：同回合的再收口会重新评审，blocker 反对不能被立即再收口绕过（R-01-006/AC-02）。
  - 反对未能发出（steer 缝缺失/抛错）按自由收口降级放行并留痕；ask 拒绝后反对未能发出时意见已在审批前送达，按 fail-open 放行落标记（循环有界）。
  - 拉锯期代价：每次收口尝试各耗一次咨询，由 budget.maxPerSession 与门开关兜底（T-008 实测发现）。
- **恢复**：paused 由 `/advisor on` 原地恢复；halted 由命令重建运行时；配置 signature 变更原子重建，在飞调用经 dispose 信号收束。
