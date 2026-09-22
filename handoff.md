# handoff — 将 pi-advisor-flow 移植为 dsh 插件

> 状态：待启动。本文档是唯一 active truth；后续 PRD/SOLUTION 获东家确认后，本文降级为历史证据。

## 目标

把 Pi 生态的 `pi-advisor-flow`（philipbrembeck/pi-advisor）移植为 DeepSeek Harness (DSH) 插件，
在 DSH 上复刻其「执行者/顾问」工作流：

- Executor（日常模型）通过 `ask_advisor` 工具按需咨询更强的 Advisor 模型；
- 配置化评审门：计划前、反复失败后、完成前、循环检测；
- Advisor 只给意见不接管（无工具、不执行命令）；
- 用量核算、隐私分级、失败隔离完整可用。

## 动机（2026-09-22 实测结论）

现装的 dsh-advisor 0.4.1（omdsh-dev，omp 评审器移植）在真实环境不可用，问题清单：

- `ADVISOR_MAX_TOKENS = 768` 硬编码（lib/advisor-runtime.js:110）：
  思考型评审模型（gpu/glm-5.3-flash，路由默认 effort=max）把预算吃光，回复为空，
  每条 delta 静默丢弃——日志仅 debug 级一行 `reply yielded no note`，用户零感知。
- `DEFAULT_CALL_TIMEOUT_MS = 60_000` 同样硬编码；把 maxTokens 放大到 131072 后改为撞 60s
  整调用超时（TIMEOUT → 重试 1 次 → 丢弃）。
- 无任何配置项暴露 maxTokens / call timeout；unknown config key 直接拒绝。
- 无门控、无循环检测、无用量核算、无密钥脱敏（转写内容原样发给评审模型）。
- 失败完全不可见：`/advisor status` 有活动痕迹，但会话里永远看不到输出，
  journal 也只有 drop 行，排障成本高。

对照：pi-advisor-flow 的按需触发天然避开「每轮必评审 × 思考型模型」的成本/超时矛盾，
且输出是自由文本 + adviceId，没有严格 JSON 帧解析这一脆弱环节。

## 源项目事实（移植源头）

- 本地参考副本：`/home/cailei/.npm-global/lib/node_modules/pi-advisor-flow`（v0.5.6，含 src/ 与 bench/）。
- 上游最新：npm `pi-advisor-flow@0.7.0`（2026-09-19 发布，共 35 版）；仓库
  `https://github.com/philipbrembeck/pi-advisor`。**移植应以 0.7.0 源码为准，本地 0.5.6 仅作离线参考。**
- 依赖底座：`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui`。
- 核心概念（README + docs/configuration.md）：
  - `ask_advisor({question?, draft?})` 零参/可选参工具；返回意见 + `adviceId`；
    `record_advisor_outcome` 可回写采纳结果。
  - 门控：plan gate、failure gate、completion gate、auto loop gate（`advisorLoopThreshold=3`），
    失败策略可 `block-tool` / `block-session`。
  - 上下文工程：会话历史分级、仓库 git 上下文分级（none/summary/capped patch）、
    tool result 截断（字节数/行数）、tracked/untracked 文件内容独立 opt-in、
    secret 形状值脱敏、outcome logging、Advisor Scout（实验性上下文预筛）。
  - 用量核算：per-call token/成本，归入宿主 `/cost`，outcome logging。
- 源码规模：61 个 TS 源文件（不含测试）；有独立 bench 套件与文档四件套
  （configuration / privacy / development / benchmark）。

## 目标平台事实（本次会话逐项验证过，移植时直接采用）

### 插件形态与安装

- dsh 插件 = bundle（ESM 包 + `cordis.patch.yml`）+ 可选 client 卡片；web profile 安装：
  `dsh plugin --profile web add <pkg>`，登记进 `~/.dsh/profiles/web/package.json` 的
  `dsh.profile.bundles` 数组；验证用 `dsh --profile web --dump-config` 看插件层。
- 纯 mount 即可：bundle insert + 自身 gateway 通道 + 命令注册，无需改 dsh 源码
  （dsh-advisor 0.4.1 即此形态，可作样例）。

### LLM 接缝（最容易踩坑处）

- 插件 ctx 可能位于隔离 scope，其局部 llm 服务**没有 provider adapter**；
  必须从应用根解析：`ctx.root?.get?.('llm') ?? ctx.llm`
  （dsh-advisor 因此修过 host 实测的 `NO_ADAPTER`，见其 lib/index.js:270 注释）。
- 调用形态：`llm.stream({provider, model, system, messages, maxTokens, reasoningEffort?})`；
  `purpose` 是闭合枚举（compaction/session-title），普通调用不设。
- 思考等级必须**能力门控**：先 `llm.resolveModelInfo(provider, model)`，仅当
  `reasoning.efforts` 含目标等级才发送，否则省略——否则 LlmRuntime 抛
  `UNSUPPORTED_REASONING_EFFORT` 直接杀死调用。
- 请求缺省 effort 时会物化 provider 路由的 defaultEffort：本机 gpu 路由（LiteLLM，
  `reasoning: max`）下 glm-5.3-flash 不显式传参就是 max 思考。
- deepseek thinkingFormat 的 off 语义：模型 reasoningEfforts 声明 `off: null` →
  thinkingLevelMap 中 off 键缺席 → pi-ai 视为「支持 off、发空」，请求侧发
  `thinking:{type:"disabled"}`；**但该参数经 LiteLLM 转发到后端是否生效未经验证**，
  移植版不要依赖它，应对思考型 advisor 模型留足 maxTokens 与超时（本会话实测：
  768 → 思考吃光空回复；131072 → 60s 超时；16384 + 180s 为当前折中）。

### 会话接缝

- 观察会话：`ctx.on('session/event', (session, event) => …, { global: true })`；
  scoped 监听收不到跨 scope 会话事件，**必须 `{ global: true }`**。
- 评审触发点：stepped `turn/end`，`reason.kind ∈ {completed, 'max-tokens', error}`。
- 注入通道：nit 用非唤醒 `agent.inject`；concern/blocker 用唤醒式 `agent.steer`；
  lifecycle 事件 `agent/created|disposed`、`session/disposed` 均需 `{ global: true }`。

### 设置与命令接缝

- 全局设置命名空间：`$DSH_HOME/settings.yaml` 顶层键；运行时经 settings bridge
  注册 section + `onChange` 即时生效（参考 dsh-advisor lib/settings.js 的
  installAdvisorSettings + onChange 重应用模式：signature 变更才重建运行时）。
- web 设置卡走插件自有 GatewayService RPC（如 `/api/advisor/get|set`），**不走**
  `settings.describe` 暴露通道；后者被 host 端 `WEB_SETTINGS_NAMESPACES`
  硬编码 allowlist 过滤（曾为旧插件 `consult-advisor` 打过补丁，见
  `~/ops/patches/dsh-host-apiproxy-consult-advisor-settings.patch`）。
- 会话命令（`/advisor`、`/advisor status` 等）经命令注册表挂载，可参考
  dsh-advisor lib/commands.js。

### 参考实现（本机可读）

- `~/.dsh/profiles/web/node_modules/dsh-advisor/lib/`：advisor-runtime（FIFO backlog、
  deadline race、失败分类 permanent/quota/transient、emission guard）、delivery
  （severity→inject/steer、immuneTurns）、settings bridge、web 卡片、TUI settings。
- 用户旧自制件（历史参考，已卸载）：`~/ops/dsh-consult-advisor`（Anthropic advisor
  tool 形态的 consult_advisor 工具）；备份 `~/ops/backups/dsh-consult-advisor-uninstall-20260818-110042`。
- pi 侧完整功能与文档：`pi-advisor-flow/README.md`、`docs/configuration.md`、
  `docs/privacy.md`、`docs/benchmark.md`（需另行拉取 GitHub 最新版）。

## 已知差距 / 待定设计决策（PRD 阶段逐项与东家确认）

- ~~Pi 的门控依赖「工具动作前拦截」；dsh 的 agent loop 是否暴露等价拦截缝待查证。~~
  **已查证（2026-09-22 spike）：可行。** `dsh-tools` 的 `prepareExecution` 在每次工具
  dispatch 前跑 `ctx.waterfall(carrier, "tools/pre-execute", exec, () => ({kind:"allow"}))`，
  监听方可返回 `allow` / `ask`（转入内置 approval）/ `deny + reason`（硬拦，工具以
  `Error: <reason>` 结果收场，不 dispatch）。第三方先例：`dsh-hooks-claude-code`
  注册同事件实现 PreToolUse 桥。工具生命周期事件
  `tools/pre-execute|execute|post-execute|result` 与 `session/event` 的 `tool/call`
  提供失败/循环观测面；loop driver 另有 `agent.steer/inject` 与 `cancel`。
  因此 pi 四门（plan/failure/completion/loop）全部可映射为真前置拦截：
  plan gate → 拦 exit_plan_mode 类工具；completion gate → 拦 concludesTurn 工具；
  loop/failure gate → 观测计数 + 下次调用前 deny/ask。
- `ask_advisor` 工具名与入参形态沿用 pi 还是沿用 Anthropic/Claude 的 `consult_advisor`。
- 用量核算接入 dsh 的哪个账面（无 /cost 时的替代）。
- 隐私分级默认值与设置面（web 卡片 + settings.yaml namespace）。
- TUI 侧是否首版就支持（dsh-advisor 同时支持 web/dsh-tui 双 profile）。
- Advisor 模型默认路由（东家当前 pi 配置为 kimi-coding/k3-256k，但 dsh 无该
  provider 路由——NO_ADAPTER 实证；候选：zai-coding-cn/glm-4.5-air 等）。

## 验证思路

- 单元：复刻 pi-advisor 的门控判定、循环检测、失败隔离的可测核心。
- 集成：dsh headless/web profile 冒烟——注册工具、门触发、advisor 调用、注入可见。
- 运行环境实测路径参考本会话：`journalctl --user -u dsh` 观察调用与丢弃日志。
