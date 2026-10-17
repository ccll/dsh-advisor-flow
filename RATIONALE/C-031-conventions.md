---
doc-type: rationale
mutation: append-only
id: C-031
owner: agent
---

# C-031 必锚幽灵引用以 CONVENTIONS 豁免行承载，不改终态任务

日期: 2026-10-14

#### 上下文
T-031 将配置卡改为平铺常开并从 PRD 删除 R-02-001/AC-11（折叠态徽标）后，已终态的 T-024 必锚清单区间 AC-09～12 含幽灵引用，pre-push 锚点覆盖检查硬失败，仓库不可推送。两条既定不变量在此组合成死锁：agentmap_lint 强制终态任务不可修改（唯一豁免是 commit 证据哈希修复）；anchor_coverage 无条件拒绝幽灵引用。

#### 决策
在 CONVENTIONS 本地参数新增 `必锚幽灵豁免` 行，anchor_coverage 读取该行并从幽灵错误集中减去；豁免逐 AC 显式登记、经东家确认，不按 task 状态放宽检查。

#### 被否方案及原因
- 修订终态任务内的引用：被 agentmap_lint「changed after reaching a terminal state」拦截，与其不可变契约正面冲突。
- 恢复 PRD 的 AC-11：折叠态随 T-031 平铺常开已不存在，恢复等于写入失效承诺。
- 幽灵引用按来源 task 状态降级为告警：终态/活跃的状态判定把校验语义复杂化，且活跃任务的幽灵同样可能源于历史区间，一刀切豁免削弱收敛闸门。

#### 影响面
R-02-001 / 配置与状态服务（T-024、T-031）
