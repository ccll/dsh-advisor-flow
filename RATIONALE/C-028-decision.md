---
doc-type: rationale
mutation: append-only
id: C-028
owner: agent
---

# C-028 证据指针修复的机械形状边界与旧哈希映射

日期: 2026-10-13

#### 上下文
出站链归一化（C-027）后，T-028 终态文本的 review 区间、commit 子 bullet 与 staging 记录仍引用旧哈希（重写前链）。以七行哈希替换续修并推送，被历史完整性检查拒：`is_commit_evidence_repair` 机械限定 `- commit: <hash>` 单行形状，prose 哈希不在可修复形状内；revert 续修提交亦被拒（revert 本身再次触碰终态文件）。本条为「commit hash 不写入」规则的唯一例外：哈希即本条主题。

#### 决策
prose 旧哈希按原样保留（框架容许悬空）；旧→新映射记于本条，终态证据反查经本条换算后可达。映射：d59b878→14ebfcd、a937171→f157052、9c90d63→45b8839、378da24→4327002、17056e5→3b823af、4d7d25c→b469964、2e0f670→437547d。

#### 被否方案及原因
- 续修 prose 哈希：终态后修改超出机械修复形状，push 永拒。
- revert 续修提交：revert 的 task diff 再次触碰终态文件，同被拒。
- 在 C-027 内补记映射：RATIONALE 条目区只追加，既有条目不可改。

#### 影响面
T-028（证据链反查）；tools（lint 历史检查语义）。
