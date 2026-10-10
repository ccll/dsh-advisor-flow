---
doc-type: task
mutation: lifecycle
id: T-024
---
# 设置卡保存控件常驻与未保存显性化

状态: active
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

（active 期间留空）
