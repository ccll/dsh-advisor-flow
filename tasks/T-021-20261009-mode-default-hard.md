---
doc-type: task
mutation: lifecycle
id: T-021
---
# T-021 mode 缺省 hard 与设置卡控件位置（R-01-009/AC-02）

风险等级: standard
状态: active
关联: R-01-009/AC-02、R-02-001/AC-04（C-022；东家 2026-10-09 设置卡实测裁定）

## 背景与目标

T-020 交付后东家在 web 设置卡实测介入强度配置，裁定两点：

- 介入强度是 advisor 行为的总纲档位，控件位置应紧随总开关（enabled）之后、高于其余全部选项。
- 缺省值应为 hard（开箱即获每回合收口评审），不再以「与 pi 开箱行为一致」为缺省导向。

决策记 C-022，废弃 C-021 的「缺省 soft」裁定；C-021 其余裁定维持。

## 差距评估

- `lib/config.js` `DEFAULT_INTERVENTION_MODE='soft'` 与裁定不符。
- `lib/settings.js` Schema `default('soft')` 与裁定不符（双写义务第二处）。
- `lib/client/render.js` 介入强度控件位于阻断模式之后，与「总开关紧下」不符。
- `PRD.md` R-01-009/AC-02 与 R-02-001/AC-04 承诺缺省 soft，随裁定演进。
- `SOLUTION.md` 产品契约 mode 行承诺缺省 soft，随裁定演进。
- `test/config.test.js` 缺省断言 soft，随实现改 hard。

## 收敛方案

- `lib/config.js`：`DEFAULT_INTERVENTION_MODE = 'hard'`（注释引 C-022）。
- `lib/settings.js`：Schema `mode` 缺省 `hard`。
- `lib/client/render.js`：mode 控件块移至 enabled 提示行紧后；下拉缺省回退 `hard`。
- map 演进：PRD 两 AC、SOLUTION 产品契约行、RATIONALE C-022。
- 测试：缺省断言改 hard（锚定 R-01-009/AC-02 不变）。
- `lib/client.js` 经 build-client.mjs 重建同步。

## 测试计划

- `test/config.test.js` 缺省 hard 断言；既有 mode 非法值拒绝与合法值透传回归。
- 全套件 `npm test` 回归全绿。
- UI 实测（东家执行）：宿主重启加载新 bundle 后，设置卡中介入强度控件位于总开关紧下、高于其余选项，下拉缺省显示硬模式。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：缺省 hard 与控件位置是本 task 主体行为 | `test/config.test.js::R-01-009/AC-02 mode 缺省 hard（开箱即获收口评审，C-022；废弃 C-021 缺省 soft）` |
| 异常 | 适用：非法值拒绝路径不随缺省变更受影响 | `test/config.test.js::R-01-009/AC-01 mode 非法值拒绝且原因可查；合法值透传（C-021）` |
| 边界配置 | 适用：settings.js Schema 与 config.js 解析器双写一致性 | `test/config.test.js::R-02-001/AC-04 默认值：failureMode=block-tool（偏离 pi 0.8.2 记 C-017）、三门与循环门默认开启、脱敏默认关闭、repoContext 摘要档、阈值 3` |
| 副作用 | 不适用：本变更不触碰咨询管线、台账与观察器；既有套件回归承载 | 全套件 `npm test` 回归全绿 |
| 兼容 | 适用：缺省值变更改变开箱行为（偏离 pi，C-022 记账） | `test/config.test.js::R-01-009/AC-02 mode 缺省 hard（开箱即获收口评审，C-022；废弃 C-021 缺省 soft）` |

## 终态与证据

- 实现: （进行中）
- 测试: （进行中）
- SOLUTION 对照: （进行中）
- commit: （关闭时填写）
- review: （关闭前由独立审核方执行 code-review 并记录）
