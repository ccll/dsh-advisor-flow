# dsh-advisor-flow

[![npm version](https://img.shields.io/npm/v/dsh-advisor-flow)](https://www.npmjs.com/package/dsh-advisor-flow)
[![npm downloads](https://img.shields.io/npm/dm/dsh-advisor-flow)](https://www.npmjs.com/package/dsh-advisor-flow)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

DeepSeek Harness（DSH）插件：把 [pi-advisor-flow](https://github.com/philipbrembeck/pi-advisor) 的执行者/顾问工作流移植到 DSH。日常任务由执行者用日常模型完成；关键决策、反复失败与收尾时刻由更强大的顾问模型提供第二意见。顾问只给意见、不接管工作（无工具、不改文件），会话主对成本、隐私与阻断行为拥有完全的配置与可见性。

可观察行为对齐 pi-advisor-flow 0.8.2（分歧行逐项记录于 `RATIONALE.md`）。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshot-consultation-dark.png">
    <img src="assets/screenshot-consultation-light.png" width="1000" alt="隔离演示环境中的 DSH 会话：执行者调用 ask_advisor 为重试策略草稿请求第二意见，顾问咨询以带标签的子会话条目呈现，意见带 adviceId 回执给执行者">
  </picture>
</p>
<p align="center"><sub>同一干净隔离环境：<a href="assets/screenshot-settings-light.png">web 设置卡</a>（另有<a href="assets/screenshot-settings-dark.png">深色版</a>，以及<a href="assets/screenshot-settings-privacy-light.png">守则门与隐私档位</a>的<a href="assets/screenshot-settings-privacy-dark.png">深色版</a>）与 <a href="assets/screenshot-status-light.png">/advisor status</a> 读数——逐次用量、门决策统计与剩余预算。</sub></p>

## 工作方式

- **按需咨询**：执行者随时可调用 `ask_advisor` 工具请求第二意见——不带参数即为一般性评审，也可带问题、草稿、仓库上下文档位（只能收窄会话主允许的档位）与点名的文件清单。每条意见带 `adviceId` 可回查。
- **手动咨询**：会话主随时用 `/advisor-manual [聚焦词]` 发起咨询，进行中可用 `/advisor cancel` 取消。
- **循环硬门**：同一工具以等价签名连续重复达到阈值（默认 3）时，宿主在该次调用执行前拦截并发起顾问评审；顾问以三值决策裁定 `proceed | revise | blocked`，`blocked` 按配置的阻断模式处置（`warn-and-continue | block-tool | block-session`）。
- **执行者守则**：计划前 / 失败后 / 完成前三类咨询守则以 systemPrompt 注入（软约束，默认开启，文本与 pi 0.8.2 英文原文逐字一致）。
- **收口评审（默认模式）**：默认硬介入模式下，执行者每个回合收口前都经顾问评审；`revise` 或 `blocked` 裁决会把意见全文送达执行者继续工作。软模式下插件行为与 pi-advisor-flow 一致：仅守则建议。
- **意见采纳回写**：`record_advisor_outcome` 工具支持自愿回写意见的采纳与验证结果（一次性 JSONL 记录，意见原文以 HMAC 哈希落盘；默认关闭）。
- **用量核算与状态**：逐次与累计的输入/输出/缓存 token 与成本明细，按触发来源分类（按需 / 手动 / 门）；`/advisor status` 展示模型路由、门控状态与门决策统计。
- **隐私分级**：仓库上下文 `off | summary | full` 三档；文件内容未经独立授权不外发（外发经归属校验）；密钥形状值发送前替换为占位符——脱敏先于截断执行。
- **非阻断保障**：advisor 与门控的任何失败都不停摆主 agent 循环。

## 安装

```sh
dsh plugin --profile web add dsh-advisor-flow
```

npm 包为预构建产物，无需本地构建。安装后若设置卡未出现，重启一次 `dsh web` 即可。本插件已收录于 [dsh-market](https://github.com/dsh-market/dsh-market#readme)（`dsh plugin --profile web add dshmarket`），可在市场内一键安装与更新。

npm 发布进行中——落地前可直接从本仓库安装：

```sh
dsh plugin --profile web add github:ccll/dsh-advisor-flow
```

零宿主补丁、零 postinstall 脚本；对 DSH 插件接缝的版本假设见 `package.json` 的 `dsh.compat`。

## 环境要求

- DSH web，针对 `@deepseek-ai/dsh@0.1.5-rc.1` 测试（见 `package.json` 的 `dsh.compat`）。
- 一个经 DSH 自身模型路由可达的顾问模型——任选 DSH 中已配置的 provider/model；插件复用宿主 LLM 服务，不直连任何提供方。

## 配置

配置位于 `settings.yaml` 的 `advisor-flow` 命名空间，也可在 web 设置卡编辑。变更即时生效、无需重启。要点：

- 启用前提：`advisor-flow.enabled: true` 且 `advisor.provider` / `advisor.model` 配齐；配置不齐时功能整体禁用，原因可经 `/advisor status` 查询。
- `mode` —— 介入强度：`hard`（默认；每次回合收口前强制发起收口评审）或 `soft`（仅守则建议，pi 行为）。
- `advisor.callTimeoutMs`：单次咨询整体超时，默认 600000ms（10 分钟）。
- `advisor.maxTokens`：单次咨询输出上限，缺省跟随宿主对所选模型的配置。
- 循环门阈值默认 3（下界 2）；三类守则与循环门默认开启；脱敏默认关闭（建议在设置卡开启，开启后密钥形状值以占位符外发）。
- `privacy.repoContext`（`off | summary | full`，默认 `summary`）、`privacy.fileContent` / `privacy.untrackedContent` / `privacy.trackedFileContent`（默认 `false`）、经 `toolPolicies` 配置 per-tool 披露策略。
- 完整键位以 `lib/config.js`（命名空间契约的 SSOT）为准，`SOLUTION.md#产品契约` 逐键记载默认值。

```yaml
advisor-flow:
  enabled: true
  advisor:
    provider: deepseek-official
    model: deepseek-reasoner
  mode: hard
  gates:
    plan: { enabled: true }
    failure: { enabled: true }
    loop: { enabled: true, threshold: 3 }
    completion: { enabled: true }
  failureMode: block-tool
  privacy:
    repoContext: summary
    redactSecrets: true
```

## 命令

- `/advisor-manual [聚焦词]` — 立即发起一次手动咨询；进行中可 `/advisor cancel`。
- `/advisor [on|off|toggle|status|gates|cancel]` — 会话级开关与状态查询；裸 `/advisor` 等价 toggle。

## 开发

```sh
npm test                # 单元测试（node --test）
npm run build:client    # 重建 web 设置卡 client 产物
node scripts/screenshot.mjs shots   # 在隔离演示环境中重新生成 README 截图
```

提交与验证门禁（AgentMap 活文档 + `.githooks/`）见 `CONVENTIONS.md`。

## 致谢与声明

- 本项目把 MIT 许可的 [`pi-advisor-flow`](https://github.com/philipbrembeck/pi-advisor)（0.8.2）的执行者/顾问工作流移植到 DeepSeek Harness；守则与协议文本在宿主允许处逐字保留。感谢原作者的设计。
- 顾问评审是模型输出而非事实判定：把它当作第二意见，而不是验证 oracle。
- 本项目 99.99% 的代码与文档由 AI 编写并评审，bug 与文档/代码漂移大概率存在。遇到问题请提 issue。

## 许可

[MIT](LICENSE)
