---
doc-type: receipt
task: T-038
日期: 2026-10-24
---

# T-038 Herdr 真实验收回执

## T-038 真实验收

证据锚点: T-038-真实验收

结论：PASS。独立临时 profile `dsh-tui-dual-advisor` 中，`/advisor-manual` 完成一次真实双顾问调用；随后把副顾问超时临时改为 1ms，验证一家超时不影响另一家。验收后副顾问超时恢复为 120000ms。现有 `dsh-tui` profile 未修改。

## 运行与环境

- 源码：分支 `feat/dual-advisor-consultation`，经 `dsh plugin --profile dsh-tui-dual-advisor add /root/codex-ops/headroom/.work/dsh-tui-dual-advisor/dsh-advisor-flow` 以 link 安装。
- Herdr：client/server `0.9.2-preview.2026-09-29-8e78f929d8f0`，验收 pane `wF:p23`，由本任务创建。
- 主会话：`cf00ec84-3e50-4a4c-b27b-e5cbd66158b0`。
- `/advisor status`：`Advisor: enabled`，主顾问 `deepseek/deepseek-flash`，副顾问 `minimax-cn/MiniMax-M3`，介入强度 `soft`。
- 证据导出：`.work/dsh-tui-dual-advisor/acceptance/` 下的 `manual-*.jsonl` 与 `timeout-main.jsonl` 由对应 `session.v4.jsonl.zstd` 直接解压，不重写内容。

## 双顾问成功批次

- 触发：`/advisor-manual 请分别用一句话评价当前双顾问实现`。
- 批次：`3b1fbf18-d993-4b0e-a5d7-1bd569226c74`。
- 主顾问子会话：`2ea58ea5-f26f-4be1-99be-3477f15193b9`；创建时间 1792822998075；标签 `Advisor review (manual) · deepseek/deepseek-flash`。
- 副顾问子会话：`f4488ddd-a762-4e70-bcdd-e64c512d0da6`；创建时间 1792822998075；标签 `Advisor review (manual) · minimax-cn/MiniMax-M3`。
- 两个子会话的父会话均为主会话；两者 seq 11 的完整外发文本 SHA-256 均为 `71b1b4020b40a527d899cf70fcd4255aa6fa843f8f9fc8f89cb19b407c51b41a`。
- 主顾问意见：`adviceId a9d6ce41-09e7-4f56-a6dd-68eab2fd7f61`，经 `plugin:advisor-flow` 独立送达。
- 副顾问意见：`adviceId d64731ec-3e48-45bd-b12a-8c9165fe0b59`，经 `plugin:advisor-flow` 独立送达。
- 两家回答文本不同，未做第三次模型汇总；主会话之后只评价两份既有意见。

### 分别用量与批次合计

| 口径 | input | output | total | cacheRead | cost |
| --- | ---: | ---: | ---: | ---: | --- |
| deepseek/deepseek-flash | 1671 | 273 | 3096 | 1152 | unavailable |
| minimax-cn/MiniMax-M3 | 2681 | 999 | 3841 | 161 | unavailable |
| 批次合计 | 4352 | 1272 | 6937 | 1313 | unavailable |

- `/advisor status` 批次读数：`calls=2`、`durationMs=28358`，其余 token 与上表一致。
- 成本由提供方未给出，按合同显示 `unavailable`，未记为零。

## 一家超时批次

- 临时配置：仅临时 profile 的 `secondaryAdvisor.callTimeoutMs` 从 120000 改为 1；主顾问保持 120000。
- 触发：`/advisor-manual 超时验收：主顾问回答一句话，副顾问应超时`。
- 批次：`5556caff-a8f1-404f-ad10-d3fc4884014d`。
- 主顾问子会话：`0f7bce81-fdf8-42b7-b980-d570191a7469`。
- 主顾问意见仍送达：`adviceId b2c2df70-cda2-403e-96ac-ffb2fb2ea7d1`。
- 副顾问失败独立送达：`Manual Advisor consultation failed: [minimax-cn/MiniMax-M3] advisor call timed out after 1ms`，来源 `plugin:advisor-flow`。
- 批次读数：`calls=1 inputTokens=4320 outputTokens=536 totalTokens=6008 cacheReadTokens=1152 durationMs=4986 cost=unavailable`；超时方未伪记成功用量。
- 累计状态同时保留两个批次，未覆盖成功批次。

## 原始证据位置

- 主会话：`/root/.dsh/sessions/--root-codex-ops-headroom--/cf00ec84-3e50-4a4c-b27b-e5cbd66158b0/session.v4.jsonl.zstd`。
- 成功主顾问：`/root/.dsh/sessions/--root-codex-ops-headroom--/2ea58ea5-f26f-4be1-99be-3477f15193b9/session.v4.jsonl.zstd`。
- 成功副顾问：`/root/.dsh/sessions/--root-codex-ops-headroom--/f4488ddd-a762-4e70-bcdd-e64c512d0da6/session.v4.jsonl.zstd`。
- 超时批次主顾问：`/root/.dsh/sessions/--root-codex-ops-headroom--/0f7bce81-fdf8-42b7-b980-d570191a7469/session.v4.jsonl.zstd`。
- 成功批次状态：`manual-main.jsonl` 的 `command/done`（批次 3b1fbf18）；超时批次状态：`timeout-main.jsonl` 的 `command/done`（批次 5556caff）及失败通告。

## 范围与未覆盖项

- 本回执只覆盖 Herdr + dsh-tui 的真实手动双顾问成功与一家超时路径。
- 设置卡浏览器验收使用另一回执；本文件不声称其已完成。
- 本回执不表示 PR 已合并或 npm 已发布；两者均未执行。
