---
doc-type: conventions
mutation: living
owner: agent 主笔，项目属主审批
---

# CONVENTIONS — 本项目开发规范

## 高频规则

<!-- BEGIN AGENTMAP COMMIT CONVENTION -->
## Git 提交规范

- 标题使用 `emoji 中文类型(scope): 中文结果描述`。
- emoji/type 固定配对：⭐ 功能、✨ 改进、🐛 修复、📝 文档、🧪 测试、📌 计划、🧹 维护、⚙️ 配置、♻️ 重构、🚀 发布。
- `scope` 使用小写字母、数字和连字符，不使用 subscope。
- 普通提交正文必须包含 `## 原因`、`## 影响`、`## 取舍`；Merge、Revert、fixup 与 squash 使用 Git 生成标题。
- 实现、修正或关闭 task 的提交：正文须引用对应 `T-nnn`。
  - 目的：`git blame` → commit → task 可反查。
  - 不涉及 task 的提交：不要求引用。
  - 被引用的 task 必须真实存在，commit-msg 校验。
- `.githooks/commit-msg` 校验当前提交，`.githooks/pre-push` 重检 outgoing commits；项目附加规则放入 `.githooks/commit-msg.d/NN-name.sh`。
<!-- END AGENTMAP COMMIT CONVENTION -->

## AgentMap 本地参数

- 需求组按 `需求组 gg: 角色` 登记；确认角色后从 `01` 连续分配，登记项永久保留。
- 需求组 01: 执行 agent（Executor）
- 需求组 02: 会话主（配置与运维角色）
- 验证矩阵起始 task: T-001
- 代码审核起始 task: T-001
- 测试锚定模式: strict
- 代码锚点: 关闭

## 验证门禁

- `.d/` hook 统一使用 `NN-name.sh`，两位编号在同一目录内唯一；dispatcher 以 `LC_ALL=C` 按文件名顺序执行并在首个失败处停止。
- `.githooks/pre-push`：先对 outgoing commits 重放 `.githooks/commit-msg`，再执行 `pre-push.d/`。
- 权威验证入口: .githooks/pre-push
- CI 门禁: 不适用：新项目尚未声明共享集成分支，建立 CI 时改为适用并登记配置路径
- `.githooks/pre-commit.d/20-agentmap-lint.sh`：AgentMap 结构、追溯与派生报告。
- `.githooks/pre-push.d/20-agentmap-lint.sh`：校验待推送历史的 AgentMap 不可变契约。
- `.githooks/pre-push.d/30-client-bundle-fresh.sh`：client 产物新鲜度守卫（重建 lib/client.js 与源码比对，不同步拒绝推送；构建副作用还原）。
- `.githooks/pre-push.d/40-anchor-coverage.sh`：锚定覆盖闸门（未锚定 AC ⊆ task 必锚清单双向校验 + 僵尸预期规则；C-010）。
- `.githooks/pre-push.d/50-expected-fail.sh`：预期失败账本校验（运行套件与 `test/expected-fail.json` 集合相等比较——计划外失败或已转绿条目均拒绝；C-011）。
- 扫描来源：`.`
