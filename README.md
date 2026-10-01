# dsh-advisor-flow

DeepSeek Harness（DSH）插件：把 [pi-advisor-flow](https://github.com/philipbrembeck/pi-advisor) 的执行者/顾问工作流移植到 DSH。日常任务由执行者用日常模型完成；关键决策、反复失败与收尾时刻由更强大的顾问模型提供第二意见。顾问只给意见、不接管工作（advisory only），会话主对成本、隐私与阻断行为拥有完全的配置与可见性。

可观察行为对齐 pi-advisor-flow 0.8.2（分歧行逐项记录于 `RATIONALE.md`）。

## 核心能力

- **按需咨询**：执行者经 `ask_advisor` 工具主动请求第二意见（可带问题、草稿、仓库上下文档位与文件移交清单）；意见带 `adviceId` 可回查。
- **手动咨询**：会话主随时用 `/advisor-manual [聚焦词]` 发起咨询，进行中可取消（`/advisor cancel`）。
- **循环硬门**：同一工具以等价签名连续重复达到阈值（默认 3）时，宿主在该次调用执行前拦截并发起顾问评审；顾问以三值决策裁定 `proceed | revise | blocked`，阻断模式可选 `warn-and-continue | block-tool | block-session`。
- **执行者守则**：计划前 / 失败后 / 完成前三类咨询守则以 systemPrompt 守则注入（软约束，默认开启，文本与 pi 0.8.2 英文原文逐字一致）。
- **意见采纳回写**：`advisor_record_outcome` 工具支持自愿回写采纳与验证结果（单行 JSON + HMAC 哈希，默认关闭）。
- **用量核算与状态**：每次与累计的输入/输出/缓存 token 与成本明细，按需/手动/门触发分类计数；`/advisor status` 展示模型路由、门控状态与门决策统计。
- **隐私分级**：仓库上下文 `关闭 | 摘要 | 完整` 三档、文件内容默认不外发（独立授权后按归属校验外发）、六类密钥形状脱敏且先脱敏后截断。
- **非阻断保障**：advisor 与门控的任何失败不停摆主 agent 循环。

## 安装

```
dsh plugin --profile web add dsh-advisor-flow
```

> npm 包暂未发布：当前请从本仓库获取源码，待 npm 发布后上述命令即可用。

零宿主补丁、零 postinstall；对 DSH 插件接缝的版本假设见 `package.json` 的 `dsh.compat`。

## 配置

配置位于 `settings.yaml` 的 `advisor-flow` 命名空间，也可在 web 设置卡编辑，变更即时生效、无需重启。要点：

- 启用前提：`advisor-flow.enabled: true` 且 `advisor.provider` / `advisor.model` 配齐；配置不齐时功能整体禁用且原因可查询（`/advisor status`）。
- `advisor.callTimeoutMs`：单次咨询整体超时，默认 600000ms（10 分钟）。
- `advisor.maxTokens`：单次咨询输出上限，缺省跟随宿主对所选模型的配置。
- 循环门阈值默认 3（下界 2）；三类守则与循环门默认开启；脱敏默认关闭（可在设置卡开启，建议开启后咨询素材中的密钥形状值以占位符外发）。
- 完整键位以 `lib/config.js`（命名空间契约的 SSOT）与 `SOLUTION.md#产品契约` 为准。

## 命令

- `/advisor-manual [聚焦词]` — 立即发起一次手动咨询；进行中可 `/advisor cancel`。
- `/advisor [on|off|toggle|status|gates|cancel]` — 会话级开关与状态查询。

## 开发

```bash
npm test                # 单元测试（node --test）
npm run build:client    # 重建 web 设置卡 client 产物
```

提交与验证门禁（AgentMap 活文档 + `.githooks/`）见 `CONVENTIONS.md`。

## 许可

[MIT](LICENSE)
