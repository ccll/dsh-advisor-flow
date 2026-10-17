---
doc-type: rationale
mutation: append-only
id: C-001
owner: agent
---

# C-001 门命中时同步阻塞受守护动作直至意见形成

日期: 2026-09-22

#### 上下文
dsh 的 `tools/pre-execute` waterfall 决定门可以在动作 dispatch 前介入；pi-advisor-flow 的门语义是评审先行、blocker 可拒。异步评审（先放行、意见后到）无法兑现"blocker 级意见拒绝动作"的承诺。

#### 决策
门命中时在 waterfall 内同步 `await` 咨询完成，再按门策略处置；等待受 `callTimeoutMs` 硬约束，超时/失败 fail-open 放行并记录。

#### 被否方案及原因
- 异步评审 + 放行后送达意见：阻断语义失效，blocker 只能事后补救，等于退化成逐轮评审器（即现 dsh-advisor 的形态）。
- 拦截后长期悬挂等待人工：与宿主 approval 通道重复，且 stall 主循环违反非阻断不变量。

#### 影响面
R-01-003、R-01-004、R-01-005、R-01-006 / 门控服务；R-02-005 / 咨询服务
