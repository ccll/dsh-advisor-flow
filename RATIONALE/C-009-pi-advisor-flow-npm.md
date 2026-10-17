---
doc-type: rationale
mutation: append-only
id: C-009
owner: agent
---

# C-009 行为对齐基线冻结为 pi-advisor-flow 0.8.2 npm 制品

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
