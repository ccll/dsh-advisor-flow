---
doc-type: task
mutation: lifecycle
id: T-017
---
# T-017 终态任务证据可达性修复豁免（lint 契约修订）

风险等级: high
状态: active
关联: C-016（东家 2026-10-01 会话闸口确认，否决全量重写历史）

## 背景与目标

公开发布推送 GitHub 时，pre-push 历史不可变门禁拦截全量 outgoing 历史（本仓库 main 此前从未推送过任何远端，155 个提交全部受检）：8eac96c（2026-09-24）在 T-010 终态后把终态证据中两处 `- commit: 29d3ea3` 替换为可达的 `0a9bacf`（29d3ea3 被 amend 改写销毁）。不修复则违反「终态证据必须指向可达提交」，修复则违反「终态任务不可变」——两规则在 amend 场景下不可能同时满足。目标：按东家裁定（2026-10-01 闸口）修订 lint 契约，为「证据可达性修复」这一窄形态提供合法通道，解除发布阻塞并使未来同类修复合法可判。

## 差距评估

- 契约矛盾：`tools/agentmap_lint.py` 既有 requirement「completed task commit evidence must resolve to a reachable commit」与「terminal task is immutable / changed after reaching a terminal state」在引用提交被 amend 销毁后互斥，任何一处都无法独立收敛。
- 违规面核验：全量 155 个 outgoing 提交逐一模拟 `check_history_transition`，确认历史中仅 8eac96c 一处违规，无其他终态后修改。
- 约束：AGENTS.md 被 `CANONICAL_FILES_SHA256` 钉定不可直接改文案；豁免只能落在 lint 实现并以 RATIONALE C-016 为契约载体；`tools/agentmap_lint.py` 自身不在哈希钉表内，可修改。

## 收敛方案

- `tools/agentmap_lint.py` 新增 `is_commit_evidence_repair(root, old_text, new_text)`：终态任务编辑仅当（① 终态不变；② 差异仅限 `- commit:` 证据行；③ 哈希一一对应替换且有效变更非空；④ 被移除哈希均不可达、新增哈希均可达——以 `resolves_to_reachable_commit`（rev-parse + HEAD 祖先判定）为准）时返回 true。
- `check_history_transition`（pre-push 历史轴）：「changed after reaching a terminal state」判定前先过豁免；删除/改态/重排路径不受豁免影响（状态变化与重命名判定先于豁免短路）。
- 现场检查（pre-commit 轴）同口径：`terminal task is immutable` 判定前先过同一豁免函数。
- RATIONALE 追加 C-016 记账（append-only）；AGENTS.md 系统文本不动（CANONICAL_FILES_SHA256 钉定），bootstrap 升级覆盖 `tools/agentmap_lint.py` 时须回移植本豁免（残余风险记入终态）。

## 测试计划

- 新增 `self_test_terminal_evidence_repair()` 并挂入 `self_test()`：
  - 正例（现场轴）：终态任务证据替换悬空哈希为可达哈希 → `lint` 无 `terminal task is immutable`；
  - 正例（历史轴）：`check_outgoing_history` 与 `check_history_transition` 对修复提交均不放行错误；
  - 负例：可达→可达哈希替换仍拒绝（现场轴与历史轴各一）；非证据行编辑仍拒绝（现场轴与历史轴各一）。
- 全量回归：`python3 tools/agentmap_lint.py --self-test`、`--report`（现场）、`--pre-push`（全量 outgoing 干跑，验证 8eac96c 放行且无新增违规）。
- 端到端：修复提交后重新 `git push github main`，四道 pre-push 门禁全绿。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：悬空→可达的纯证据行替换在现场轴与历史轴均放行 | `tools/agentmap_lint.py::self_test_terminal_evidence_repair` |
| 异常 | 适用：可达→可达替换、非证据行篡改在两轴仍拒绝 | `tools/agentmap_lint.py::self_test_terminal_evidence_repair` |
| 边界配置 | 适用：证据行数量不一致不豁免；哈希多重集不变的纯重排/纯格式化不豁免；非 `- commit:` 行差异不豁免；abandoned/superseded 终态同语义适用 | `tools/agentmap_lint.py::is_commit_evidence_repair` |
| 副作用 | 适用：既有终态不可变主路径、重排例外、直接终态创建判定不回归 | `tools/agentmap_lint.py::self_test` |

## 终态与证据
