---
doc-type: task
mutation: lifecycle
id: T-024
---
# 设置卡保存控件常驻与未保存显性化

状态: completed
关联: R-02-001（AC-09～12）；C-024
风险等级: standard

## 背景与目标

东家反馈：web 设置卡展开后表单约 11 个控件，保存按钮固定在表单末尾；滚动编辑后按钮离开视口，用户易误以为修改已生效而直接关闭页面。经候选裁决（C-024），不改「暂存 patch + 显式保存」模型，改用 sticky 常驻 footer + 头部「未保存」徽标解决可见性。

## 差距评估

- `lib/client/render.js`：`.advisorflow_footer` 为普通流式块，位于 `.advisorflow_body` 末尾；长表单滚动时保存/放弃修改按钮随内容滚出视口。
- 无未保存状态显性化：`state.patch` 非空时头部无任何标识；卡片可折叠，折叠后暂存修改完全不可见。
- `lib/client/card-state.js`：controller 未暴露 dirty 语义，render 无法判定「存在暂存修改」。

## 收敛方案

- `lib/client/card-state.js`：`getState()` 增加 `dirty`（status=ready 且 patch 非空；与保存按钮可按下的暂存语义同源，不引入深比较）。
- `lib/client/render.js`：
  - `.advisorflow_footer` 改 `position:sticky; bottom:0`。
  - footer 补卡片同色背景（`--dsw-alias-bg-layer-2`）遮蔽滚过内容。
  - 表单未超高时 sticky 不改变布局，维持原位。
  - header 内追加「未保存」徽标（span 纯标识不可点——header 本身是 button，内嵌按钮非法）。
  - 保存动作由常驻 footer 承担。
  - `dirty` 时渲染徽标；折叠/展开均显示。
  - 保存成功或放弃修改后，徽标随 patch 清空消失。
- 逻辑层（catalog 联动、校验、三形态回执、持久写）零改动。

## 测试计划

- 新增锚定用例（`test/client/settings-card.test.js`）：sticky footer 结构与样式声明（AC-09）。
- 锚定用例：徽标编辑出现与折叠保留（AC-10/AC-11）；放弃与保存成功后消失（AC-12）。
- `node --test` 全量绿；agentmap lint 全绿。
- 真实验收：staging 起宿主 + 浏览器/headless 实测滚动可见性、未超高布局不变与徽标形态，截图东家目验；无法实测时显性说明。
- 必锚 AC（收敛闸门）：R-02-001/AC-09～12 全部有测试锚点方可关闭。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：sticky 滚动可见（AC-09）；徽标随编辑出现、随保存/放弃消失 | `test/client/settings-card.test.js::R-02-001/AC-10`；`test/client/settings-card.test.js::R-02-001/AC-12` |
| 异常 | 适用：校验失败时保存被拒，徽标与错误并存不误导 | `test/client/settings-card.test.js::R-02-001/AC-03`（既有回归） |
| 边界配置 | 适用：折叠态徽标保留由单测判定；sticky 生效性与未超高布局由浏览器实测裁决（单测正则断言结构上不可见） | `test/client/settings-card.test.js::R-02-001/AC-11`；`tasks/evidence/T-024/verify-output.txt::表单中部滚动后保存按钮仍在视口内` |
| 副作用 | 不适用：纯呈现层，无状态写入语义变化 | — |
| 兼容性 | 适用：client bundle 产物新鲜度 | `test/client-bundle.test.js::classic`；`.githooks/pre-push.d/30-client-bundle-fresh.sh::git diff --exit-code -- lib/client.js` |

## 终态与证据

- 实现: ① `lib/client/card-state.js` `getState()` 增加 `dirty`（ready 且 patch 非空，与保存按钮暂存语义同源，不做深比较）。② `lib/client/render.js` footer sticky 常驻（`position:sticky; bottom:0`、同色背景 `--dsw-alias-bg-layer-2` 遮蔽滚过内容、负 margin 撑满卡宽、未超高时维持原位）；header 内追加「未保存」徽标（span 纯标识不可点，保存动作由 sticky footer 承担）；模块注释 AC 引用逐条同步 AC-09～12。③ client bundle 重建同步（pre-push 30 新鲜度门禁通过）。④ 东家裁决按写作风格将原 AC-10 拆为 AC-10/11/12，PRD/SOLUTION/RATIONALE（C-024）原子级联。
- 测试: 全套件 `npm test` 283 通过 / 0 失败（基线 280 + 新增 AC-09/AC-10+AC-11/AC-12 三用例）；`expected_fail_check` passed（executed=283 与账本一致）；`anchor_coverage` passed（90/90）；`agentmap lint` passed。浏览器实测 13/13（staging 一次性 profile `af-sticky` + playwright-core 无头 chromium：滚动中部 footer 钉住 rect 恒定 y=790.5、未超高 y=1540 自然原位、徽标全生命周期、保存回执可见），脚本/输出/截图固化 `tasks/evidence/T-024/`（staging 实例已销毁，脚本内一次性 token 已失效）。
- SOLUTION 对照: R-02-001 需求陈述不变、新增 AC-09～12（东家 ask_user_question 闸口确认拆分）；SOLUTION「web 设置卡」关键内部结构子列表逐条锚定 AC-09/10/11/12；RATIONALE C-024 承载保存模型裁决与被否方案；需求追溯索引行不变（R-02-001 主责配置与状态服务）。
- commit: 9b1170c
- review:
  - 审核方: 双轴独立评审——Standards 轴代理 a2a01ad8-bccc-4dab-a903-2e903164d24d、Spec 轴代理 017956a9-8db2-49f4-8f6e-621ae0ef9d00（code-review skill 流程）
  - 目的理解: 本 task 目标是以 sticky 常驻 footer + 未保存徽标解决设置卡长表单下保存按钮不可见导致的「误以为已生效」问题（C-024 裁决，不改暂存+显式保存模型）；关联约束为 PRD R-02-001（拆分后 AC-09～12）、SOLUTION web 设置卡模块、C-024 决策与被否方案、逻辑层零改动边界；预期行为为滚动任意位置保存/放弃控件可见、dirty 徽标全生命周期正确；验证方式为 283 用例全套件 + anchor_coverage + expected_fail_check + agentmap lint + staging 浏览器实测。
  - 执行方式: code-review skill 双轴并行评审（Standards 轴：AGENTS.md/CONVENTIONS.md/DOMAIN.md + Fowler smell 基线；Spec 轴：task 收敛方案 + PRD AC 原文对照），评审基线为 `git diff HEAD`（实现提交前工作区，16 文件）；复审两轮均由原审核方执行。
  - 问题与修复: 8 项发现全部修复或经原审核方确认处置成立，无未决问题。明细：
    - Standards：PRD 新增 AC 违反写作风格（单句超 40 字、一条多断言、非 EARS 追加句）→ 东家裁决拆分为 AC-09～12 单条件单动作，测试锚定与必锚清单同步。
    - Standards：SOLUTION 模块条目插入四字段规范外自定小节 → 并入「关键内部结构」子列表。
    - 双轴：settings-card.test.js 同一 background 断言逐字重复 → 删除重复行。
    - 双轴：死 helper `badgeNodes` 零调用（Speculative Generality）→ 删除，保留测试内局部闭包。
    - Spec：浏览器实测证据缺失、矩阵「浏览器实测记录于本 task 终态」为悬空引用 → 证据固化 `tasks/evidence/T-024/`（脚本/逐项输出/5 截图），矩阵改为锚定输出文件。
    - Spec：源码注释 AC 引用漂移（折叠保留仍引 AC-10）→ render.js 头部与徽标注释逐条改 AC-09～12，card-state.js dirty 注释改 AC-10～12 口径，bundle 重建同步。
    - Spec：AC-09 测试标题过度声称行为 → 收敛为断言能力口径。
    - 验证矩阵「边界配置」行证据归属错置（未超高布局记在单测名下）→ 改为 AC-11 单测锚定 + 浏览器实测输出文件锚定。
  - 复审结论: 两轴均通过（Standards 轴第 2 轮复审：6 项处置全部落实或理由成立、lint 90/90 全锚定；Spec 轴最终确认：实测证据可核查、sticky 残余风险正式裁决关闭、bundle 幂等重建一致），同意关闭。残余风险：AC-09 单测仅样式结构断言（行为由实测承担，已记验证矩阵）；`expandCard` 命名欠准确（HEAD 既有 helper，26 处调用点改名超范围，调用点注释补救）；`.staging/rc2` 旧目录为既往遗留（非本 task 范围，待东家处置）。
