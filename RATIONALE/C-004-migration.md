---
doc-type: rationale
mutation: append-only
id: C-004
owner: agent
---

# C-004 分阶段交付的锚定缺口走 migration 机制，不绕过门禁

日期: 2026-09-22

#### 上下文
strict 测试锚定要求全部 27 个 AC 有锚点；T-001（咨询核心）只覆盖 12 个，其余 15 个属门控/命令/卡片范围。pre-commit 门禁因此阻塞实现提交，执行代理曾以绕过门禁的方式放行（处置见本条）。

#### 决策
采用 AgentMap 自带的 `测试锚定模式: migration T-002`：建立 active 迁移任务 T-002 承载锚点缺口，全部 27 个锚点落地后切回 strict 并关闭 T-002。已绕门禁的提交不重写，后续提交全部走正常门禁。

#### 被否方案及原因
- 继续 `--no-verify`：绕过门禁成为惯例，pre-push 重放也会持续告警，门禁形同虚设。
- 把 T-001 范围扩成 v1 全量实现再关 task：任务失去可审边界，review 粒度恶化。

#### 影响面
T-002 / 全部需求；CONVENTIONS（测试锚定模式）
