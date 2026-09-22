---
doc-type: task
mutation: lifecycle
id: T-001
---
# 咨询服务与配置核心

状态: completed
关联: R-01-001、R-01-002（工具与错误语义）、R-02-001（配置解析与硬门）、R-02-002（用量台账）、R-02-003（失败显性化）、R-02-004（裁剪与脱敏）、R-02-005（非阻断）；关联决策 C-002、C-003
风险等级: standard

## 背景与目标

按 SOLUTION 落地插件的宿主侧咨询核心：无 UI、无门控——先让"一次咨询"在 dsh 的接缝上正确工作。纯 ESM JavaScript（lib/ 即源码，无构建工具链），依赖注入式设计使核心不依赖 dsh 运行时即可单元测试。

## 差距评估

- 仓库除 map 文档与 handoff 外无代码。
- 咨询服务、配置解析、脱敏、用量台账、状态快照、咨询工具面均不存在。
- 源参照：`~/.npm-global/lib/node_modules/pi-advisor-flow`（功能语义）、`~/.dsh/profiles/web/node_modules/dsh-advisor/lib`（dsh 接缝模式：根作用域 LLM 解析、deadline race、失败分类）。

## 收敛方案

- `lib/config.js`：`advisor-flow` 命名空间解析——已知键白名单、未知键警告保留、缺 provider/model 时 `enabled` 解析为 disabled-with-reason；门配置结构完整解析（门本体 T-002 消费）。
- `lib/redact.js`：密钥形状值（sk-、Bearer、AKIA、password=、token= 等）占位替换；开关可关。
- `lib/context.js`：按隐私档位裁剪素材（history/repoContext/toolResults/fileContent 档位），产出顾问 user 消息。
- `lib/consultation.js`：`createConsultationEngine({ llm, config, logger })`——adviceId 分配、effort 能力门控（llm.resolveModelInfo 可选注入）、maxTokens/callTimeoutMs、deadline race、失败三分类（transient 重试 1 次 / quota pause / permanent halt）、意见自由文本 + 可选宽松 JSON、outcome 追加。
- `lib/usage.js`：逐次 + 会话累计台账，按入口类型分类，缺失项 `unavailable`。
- `lib/status.js`：状态快照（启用态、路由、pending、最近活动、用量摘要）。
- `lib/tools/ask-advisor.js`：工具面工厂，参数校验、错误转译（诊断码 NO_ADVISOR_MODEL / ADVISOR_ROUTE_MISSING / ADVISOR_TIMEOUT / ADVISOR_FAILED）。
- `lib/index.js`：dsh bundle 入口骨架——注册工具面、暴露服务接口；门控/观察/命令/卡片留待 T-002/T-003（本任务不实现，留显式 TODO 注释指向 task）。
- package.json：`type: module`、`main: lib/index.js`、dsh bundle 元数据（peerDependencies 对齐 dsh-advisor 0.4.1 的版本段）、测试用 node:test（无 vitest，零额外依赖）。

## 测试计划

- node:test 单元测试，注入假 llm（可编程 chunk/finish/error/usage）与假 clock。
- 覆盖并锚定：R-01-001/AC-01..03、R-02-001/AC-01..03、R-02-002/AC-01..03、R-02-003/AC-01、R-02-004/AC-03（脱敏）、R-02-005/AC-01（超时/失败不抛出、返回诊断）。
- 测试文件 `test/*.test.js`，测试名含 `<R-ID>/AC-nn` 锚点。
- `python3 tools/agentmap_lint.py --report` 全绿（test anchor 由测试名锚点满足）。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：咨询往返与用量记录 | `test/consultation.test.js::R-01-001/AC-01`、`test/usage.test.js::R-02-002/AC-01` |
| 异常 | 适用：失败分类、超时、禁用态诊断 | `test/consultation.test.js::R-01-001/AC-02`、`test/consultation.test.js::R-02-005/AC-01` |
| 边界配置 | 适用：未知键、缺模型、档位边界 | `test/config.test.js::R-02-001/AC-01`、`test/config.test.js::R-02-001/AC-02`、`test/config.test.js::R-02-001/AC-03`、`test/redact.test.js::R-02-004/AC-03` |
| 副作用 | 适用：台账落盘需可回放 | `test/usage.test.js::R-02-002/AC-02`、`test/usage.test.js::R-02-002/AC-03` |
| 跨实现 | 不适用：单一实现 | — |

## 终态与证据

- 实现: lib/config.js、lib/redact.js、lib/context.js、lib/consultation.js、lib/usage.js、lib/status.js、lib/util.js、lib/tools/ask-advisor.js、lib/index.js（bundle 入口骨架，含根作用域 LLM 解析）；package.json、cordis.patch.yml。门控/观察/命令/卡片按边界留待后续 task。
- 测试: `node --test` 50/50 全绿；test-anchored 16/30（migration T-002 承载其余 14 项，warnings 无 unknown anchor）；lint --self-test 与 --report 通过。
- SOLUTION 对照: 双轴复审逐项核对 SOLUTION 契约与实现一致（含 C-005 quota 语义对齐、retryAttempts/toolResultMaxBytes 两键契约回补）；无差异。
- commit: 1e8f7ac
- commit: fe04be0
- commit: 8393f5d
- commit: 63bfec6
- review:
  - 审核方: 双轴独立评审——Standards 轴代理 eb77d407-3912-4c16-86c8-da1c1997a42d、Spec 轴代理 8f19eb7a-2266-4fb4-9220-ef1f316e1ba8，均经 code-review skill 流程
  - 目的理解: 本 task 目标是在 dsh 接缝上正确实现"一次咨询"的核心语义（可注入、可测、非阻断），受 SOLUTION 咨询服务/配置与状态服务/咨询工具契约与 DOMAIN 非阻断不变量约束；两位 reviewer 开审前已据 map 建立该理解并记录
  - 执行方式: code-review skill 双轴并行子代理；Standards 基线 = AGENTS/CONVENTIONS/handoff 硬约束 + Fowler 坏味道清单；Spec 基线 = T-001 任务书 + SOLUTION/PRD/DOMAIN；范围 4b825dc..HEAD 代码与配置
  - 问题与修复: 首轮 Standards 2 硬违规 + 4 坏味道、Spec 2 中 + 4 低——全部经 8393f5d 修复并经同审核方逐项确认已解决；复审新增锚点语义漂移 3 处与默认值单源 1 处，经 63bfec6 修复；过程中 advisor 注入两度纠偏（PRD AC-03 语义漂移 c55d90e；migration 掩盖的锚点缺口 15→18 显形）
  - 复审结论: 双轴终确认均通过，无未决事项；残余风险一项——宽松 JSON balancedObjects 帧误识别边界待真实模型联调验证（已有空 note/非帧 JSON/markdown 围栏三类测试）
