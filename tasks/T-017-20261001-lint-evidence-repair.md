---
doc-type: task
mutation: lifecycle
id: T-017
---
# T-017 终态任务证据可达性修复豁免（lint 契约修订）

风险等级: high
状态: completed
关联: C-016（东家 2026-10-01 会话闸口确认，否决全量重写历史）

## 背景与目标

公开发布推送 GitHub 时，pre-push 历史不可变门禁拦截全量 outgoing 历史（本仓库 main 此前从未推送过任何远端，155 个提交全部受检）：8eac96c（2026-09-24）在 T-010 终态后把终态证据中两处 `- commit: 29d3ea3` 替换为可达的 `0a9bacf`（29d3ea3 被 amend 改写销毁）。不修复则违反「终态证据必须指向可达提交」，修复则违反「终态任务不可变」——两规则在 amend 场景下不可能同时满足。目标：按东家裁定（2026-10-01 闸口）修订 lint 契约，为「证据可达性修复」这一窄形态提供合法通道，解除发布阻塞并使未来同类修复合法可判。

## 差距评估

- 契约矛盾：`tools/agentmap_lint.py` 既有 requirement「completed task commit evidence must resolve to a reachable commit」与「terminal task is immutable / changed after reaching a terminal state」在引用提交被 amend 销毁后互斥，任何一处都无法独立收敛。
- 违规面核验：全量 155 个 outgoing 提交逐一模拟 `check_history_transition`，确认历史中仅 8eac96c 一处违规，无其他终态后修改。
- 约束：AGENTS.md 被 `CANONICAL_FILES_SHA256` 钉定不可直接改文案；豁免只能落在 lint 实现并以 RATIONALE C-016 为契约载体；`tools/agentmap_lint.py` 自身不在哈希钉表内，可修改。

## 收敛方案

- `tools/agentmap_lint.py` 新增 `is_commit_evidence_repair(root, old_text, new_text)`：终态任务编辑仅当（① 终态不变；② 逐行位置对齐——仅双方同为 `- commit:` 证据形状的行可不同，证据行不得跨行位移；③ 哈希一一对应替换且有效变更非空；④ 被移除哈希均不可达、新增哈希均可达——以 `resolves_to_reachable_commit`（rev-parse + HEAD 祖先判定）为准）时返回 true。
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
| 边界配置 | 适用：证据行位移/跨行重排（含重排+换哈希）与行数不一致不豁免；哈希不变的纯格式化不豁免；非 `- commit:` 行差异不豁免；豁免按行形状判定、不解析小节语义，正文同形行（如本 task 背景段内引用）同在覆盖面；abandoned/superseded 终态同语义适用 | `tools/agentmap_lint.py::self_test_terminal_evidence_repair` |
| 副作用 | 适用：既有终态不可变主路径、重排例外、直接终态创建判定不回归 | `tools/agentmap_lint.py::self_test` |

## 终态与证据

- 实现: `tools/agentmap_lint.py` 新增 `is_commit_evidence_repair`——单正则（named group hash）逐行位置对齐 + 逐位置 old→new 配对：终态不变、行数相等、仅双方同为 `- commit:` 证据形状的行可不同（证据行不得跨行位移）、old==new 纯格式化拒绝、被移除哈希均不可达且新增哈希均可达（`resolves_to_reachable_commit` rev-parse + HEAD 祖先判定）；接入两处（`check_history_transition` 历史轴、现场 immutable 检查），状态/删除/重排/直接终态判定先于豁免短路；常量归位头部常量区；docstring 声明 line-local/section-blind 覆盖面；`self_test_terminal_evidence_repair` 挂入 `self_test()`（正例两轴 + 负例四类 + 形状断言：部分替换放行、证据行位移拒绝、2×同哈希重复放行）。RATIONALE 追加 C-016 并补影响面格式豁免备注（append-only 前缀保持）。
- 测试: `python3 tools/agentmap_lint.py --self-test` 通过（新函数挂载实跑，复审建议断言随 09ee7ea 入库）；`--report` 与 `--staged` 全绿；`--pre-push` 全量 outgoing 干跑（155 提交，8eac96c 豁免放行且无新增违规）；四道 pre-push 门禁单测干跑全绿（bundle-fresh exit 0、anchor-coverage 68/68、expected-fail failing=0 ledger=0 executed=229、agentmap lint passed）；`npm test` 229 通过 / 0 失败；发布 push 实门禁运行见 T-017 关闭提交后的推送记录。
- SOLUTION 对照: map 不变——本 task 为校验器过程基建契约修订（短路形态），PRD/SOLUTION/DOMAIN 零改动；契约变更由 RATIONALE C-016 承载（东家 2026-10-01 会话闸口确认，被否方案：全量重写历史、绕过门禁、放行悬空哈希、单点 grandfather）。
- commit: 2b7c5fe —— 关联 699c1ac（Spec 复审修复：自测挂载、负例方向、逐行位置对齐）、914b5ad（Standards 复审收口：影响面格式说明、单正则位置配对、自测 helper、覆盖面声明）、09ee7ea（Spec 建议采纳：2×同哈希重复替换断言）。
- review:
  - 审核方: 双轴独立评审子代理（Standards 轴、Spec 轴，code-review skill 流程；一轮双轴评审 + 修复后各轴同审核方复审循环两轮）
  - 目的理解: 修订校验器终态不可变契约，为「终态任务 commit 证据悬空指针修复」提供窄豁免以解除公开发布阻塞；关联约束——C-016 契约、终态不可变与纯编号迁移例外、终态证据可达性校验（rev-parse + HEAD 祖先）；预期行为——仅同位置证据行、悬空→可达、终态不变的编辑在 pre-commit 与 pre-push 两轴放行，其余终态后编辑（改态/删除/重排/位移/纯格式化/可达→可达）一律拒绝
  - 执行方式: code-review skill 双轴并行子代理评审（基线 5bbf070...HEAD 全量 diff）；findings 修复后由同一审核方复审（Spec：699c1ac 三项已修复、914b5ad 增量批准；Standards：914b5ad 四项已修复并独立实跑 --self-test）
  - 问题与修复: Spec①自测未挂入 self_test()（挂载并实跑验证）；Spec②历史轴可达→可达负例 replace 目标写反致空提交（方向修正）；Spec③证据行跨位置位移+换哈希可绕过、\s* 吞换行（逐行位置对齐 + 单行 fullmatch 形状）；Standards①C-016 影响面偏离条目格式（尾部追加显式豁免说明）；Standards②LINE_RE/HASH_RE 双正则同形（单正则 named group + 位置配对，常量归位）；Standards③自测 commit+rev-parse 六处重复（局部 commit() helper）；Standards④行形状覆盖面未声明（docstring + 验证矩阵同步）；Spec 建议 2×同哈希重复替换直接断言（09ee7ea 采纳）
  - 复审结论: 两轴通过（Spec：批准、无 spec 回归；Standards：四项已修复、无新发现）；残余风险——豁免按行形状判定不解析小节语义（正文同形行在覆盖面内，已在 docstring 与验证矩阵声明）；框架升级覆盖校验器时须回移植豁免（C-016 记账）
- 锚定理由: 本 task 无 PRD AC 锚点（校验器过程基建，无 R-ID 关联）；anchor_coverage 以「未锚定 AC ⊆ task 必锚清单」判定，零 AC 即零必锚项，实跑 passed（68/68，unanchored=0）为权威依据。
