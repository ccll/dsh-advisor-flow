---
doc-type: rationale
mutation: append-only
id: C-005
owner: agent
---

# C-005 quota 暂停时等待方按丢弃策略收敛而非保留待处理

日期: 2026-09-22

#### 上下文
SOLUTION 初稿写"quota → 暂停并保留待处理"；实现发现保留等待方会悬挂工具调用，与 DOMAIN 非阻断不变量（R-02-005/AC-01）冲突。只有一个合理选项：fast-fail。

#### 决策
quota 暂停时新咨询与等待方一律立即返回 `ADVISOR_PAUSED`（丢弃策略收敛），恢复经显式 resume；SOLUTION 措辞已对齐。

#### 被否方案及原因
- 保留待处理直至配额恢复：等待方悬挂 = 变相 park 主循环，违反非阻断不变量。

#### 影响面
R-02-005 / 咨询服务
