---
doc-type: task
mutation: lifecycle
id: T-019
---
# T-019 dsh 0.2.0-rc.2 兼容性修复（第一阶段：投递源形态与 peer 口径）

风险等级: standard
状态: completed
关联: R-01-006（投递链）；东家 2026-10-09 会话直接指令（对 dsh-simplify 与本插件做 0.2.0 兼容实测并适配）

## 背景与目标

生产 dsh 0.1.5-rc.1 与 npm latest 0.2.0-rc.2 之间的升级评估（~/ops/HANDOFF-dsh-0.2.0-upgrade.md）需要本插件在 0.2.0 上的实测证据。隔离审计环境（dsh 0.2.0-rc.2 + 五插件共存 + allow-version 豁免）实测发现：装载层零报错，但意见投递链被 0.2.0 的会话格式 v4 拒绝——`/advisor-manual` 咨询发起成功、顾问意见生成后，steer 投递的消息使回合以 `format v4 message requires a producer-owned source kind` 失败，且毒化同会话后续回合。本 task 修复投递源形态并对齐 peer 版本口径，使核心链路（命令→引擎→llm.stream→steer 送达）在 0.2.0 上端到端可用。

边界：设置卡（settings card）适配不在本 task 范围——0.2.0 settings 服务移除 `installSection`、改为「插件模块导出 schemastery `Config` schema + profile entry config」模型，需要新建 Config 导出，登记 TODO 由后继 task 承载；本 task 内该缝保持既有显性化降级（`settingsSection=install-section-missing`），配置经 profile entry config（cordis.patch.yml 的 advisor-flow 行）照常生效（实测已验证）。

## 差距评估

- 投递源形态：`lib/delivery.js` steerAdvice 构造的消息 source 为 `{ kind: 'plugin', plugin: 'advisor-flow', form, summary }`（0.1.5 v3 时代的插件包装形态）。0.2.0 v4 准入拒绝 `kind === 'plugin'`（dsh-session-format-v3-to-v4 lib/index.js source() 校验），要求生产者直接来源；v3→v4 转换规则明示 `plugin:acme` 形态（插件名保留在 kind 前缀）。全仓仅此一处生产 `kind: 'plugin'`（grep 实证）。
- peer 版本口径：`package.json` peerDependencies 全部 `^0.1.5-rc.2`，被 0.2.0 版本门控拦截（实测 `dsh plugin add` 失败，需 `allow-version --accept-risk` 豁免）。豁免是接受风险不是修复；适配分支应对齐 `^0.2.0-rc.2`。
- settings 桥：`lib/settings.js` 依赖的 `settings.installSection` 在 0.2.0 不存在（settings 服务重构为 SettingsForms：describe 从 entry config 的插件 `Config` schema 生成表单；`update(ns, patch)` 写缝仍在，index.js 的 `settingsSeam?.update ?? settingsSeam?.write` 取缝逻辑与 0.2.0 兼容）。降级路径实测已显性化且不崩装载；卡片适配延后（见边界）。
- 其余消费面实测在 0.2.0 未变：`llm.stream`（text-delta/usage 事件）、`agents.get/cancel`、`sessionQuery.observeSession`、`commands.register`、`ctx.on` 事件名（tools/pre-execute、tools/result、session/event、agent/created/disposed、session/disposed）——审计环境 e2e:job 真实工具回合与 /advisor status 均通过。
- 构建产物：`lib/client.js` 为 `scripts/build-client.mjs` 产物；本 task 不改 client 源（投递修复在宿主侧 delivery.js），无需重建；如最终改动触及 client 源则按 30-client-bundle-fresh 门禁重建。

## 收敛方案

- `lib/delivery.js`：steer 消息 source 改为直接来源 `{ kind: 'plugin:advisor-flow', form: 'notice', summary }`——kind 非空且非退役 `plugin` 包装，满足 v4 准入；额外自有字段（form/summary）按 v4 规则随直接来源保留。0.1.5 兼容性不在本分支目标内（分支即为 0.2.0 适配分支，main 保持 0.1.5 兼容）。
- `package.json`：peerDependencies 全部 `^0.1.5-rc.2` → `^0.2.0-rc.2`（适配分支口径；版本门控据此放行，无需 allow-version）。两处伴随改动（0.2.0 0.2.0 审计环境实测所需，随 peer 口径一并落位）：
  - `dsh.compat.dsh` 信息字段 `0.1.5-rc.1` → `0.2.0-rc.2`（声明适配目标线，与分支意图一致）；
  - `@deepseek-ai/cordis` peer `^4.0.2` → `^4.0.4`（0.2.0-rc.2 依赖树实测 cordis 为 4.0.4，原范围不覆盖——语义化兼容升级，非 API 形态变化）。
- `lib/settings.js`：installSection 缺失分支的 warn 文案补 0.2.0 语境（settings 服务重构 + Config schema 后继项），降级语义不变。

## 测试计划

- 单元：现有套件 `node --test "test/**/*.test.js"` 全绿（delivery 相关用例核对 source 断言是否需同步）。
- 集成（审计环境实测判据）：dsh 0.2.0-rc.2 隔离实例 + 本 worktree link 安装（无 allow-version）→ ① `/advisor status` 正常；② `/advisor-manual <focus>` 发起后，顾问意见以 steer 送达会话且回合正常完成（会话文本出现 Decision/advice 内容，无 `This turn failed`）；③ 同会话后续回合不再被毒化；④ e2e:job 真实工具回合门观察正常。
- 回归：0.1.5 主线不在本分支验证范围（分支目标即 0.2.0）；main 的 0.1.5 行为由 main 既有测试保障。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 核心投递链在 0.2.0 端到端可用 | 审计环境浏览器实测：/advisor-manual 后意见送达、回合 completed |
| 异常 | steer 目标会话无 agent 时保持既有容错 | delivery.js 既有 guard（isRecord/steer 函数检查）不变；单测覆盖 |
| 边界配置 | enabled:false 与配置非法形态的既有降级不变 | 既有单测（config.test.js）通过 |
| 副作用 | 消息 source 形态变更对会话持久化的影响 | v4 准入通过（回合不再失败）即证明；持久化由宿主承载 |
| 兼容性 | 版本门控放行 | `dsh plugin add` 无需 allow-version 成功 |

## 终态与证据

- 实现: `lib/delivery.js` steer 消息 source 改直接来源（`ADVICE_SOURCE_KIND = 'plugin:advisor-flow'` 导出常量，实现与测试单一事实源）；`package.json` 14 个 dsh peer → `^0.2.0-rc.2`、cordis `^4.0.4`、`compat.dsh` 信息字段 → `0.2.0-rc.2`；`lib/settings.js` installSection 缺失分支文案对齐 0.2.0 语境（降级语义不变）。模块头注与测试头注同步新契约。
- 测试: 单元 `node --test "test/**/*.test.js"` 230/230 通过（含 2 例 R-01-005/AC-02 source 断言随迁移更新：`test/delivery.test.js:38`、`test/index.test.js:319`）。审计环境集成实测（dsh 0.2.0-rc.2 隔离实例 + 本 worktree link，无 allow-version）：① `/advisor status` 正常；② `/advisor-manual` 咨询发起成功，会话持久化日志出现 2059 条 `source.kind = 'plugin:advisor-flow'` 的 user 消息（含 manual 意见 adviceId e1bb43f3），v4 拒绝错误消失；③ 修复前毒化会话不再出现于新会话；④ e2e:job 真实工具回合 tools/pre-execute、tools/result 缝触发正常。`dsh plugin add` 无需 allow-version 直接成功（门控放行实测）。
- SOLUTION 对照: R-01-005 送达契约语义不变（一律 steer、user 角色、稳定 id、折叠摘要）；仅消息 source 形态随宿主 v4 迁移从插件包装改为直接来源——SOLUTION「意见送达」章节的产品契约（无 severity 分流、无冷却）未变，形态差异属宿主会话格式演进的外部约束，记 RATIONALE 待办（后继 task 一并处理设置卡时同步 SOLUTION）。
- commit: b292632
- review:
  - 审核方: code-review skill 双轴独立子代理（Standards 轴 + Spec 轴，并行隔离上下文）
  - 目的理解: 修复 0.2.0 v4 对 steer 消息 source 的拒绝使投递链端到端可用；约束 = R-01-005 送达契约不变、settings 降级语义不变、AC-02 锚定、分支 0.2.0-only 口径；预期行为 = 意见送达且回合完成、门控放行无需豁免
  - 执行方式: code-review skill（Standards 轴：CONVENTIONS + 全局工程原则 + Fowler 基线；Spec 轴以本 task 为 spec 逐条对照 diff）；评审基线 HEAD=6ff0454 未提交 diff 5 文件
  - 问题与修复: Spec 轴——①集成/兼容性证据未落 task（本终态补齐）；②compat.dsh 与 cordis 两处伴随改动超出收敛方案口径（已在收敛方案补记理由）；③test 头注释编辑残留重复行（已删）；④lib/delivery.js 模块头仍写旧口径 source.plugin（已同步直接来源表述）。Standards 轴——同两处注释缺陷（已修）；`plugin:advisor-flow` 字面量三处（已导出 ADVICE_SOURCE_KIND 单一事实源，测试与实现共用）；settings.js 注释与 warn 事实重复（warn 缩短为事实+落点，理由留注释一处）；cordis 补记（同②）
  - 复审结论: 两轴全部发现处置完毕，无阻断缺陷；单元 230/230 + 审计环境集成实测通过，复审通过
- 残余风险: 设置卡缺失（T-019 边界显式延后，降级显性化）；审计环境发现 loop gate 在非反应执行者 + 空预算下可干预循环（1029 次），非本 task 范围亦非 0.2.0 特有，登记 TODO 由后继承载
