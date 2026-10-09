---
doc-type: task
mutation: lifecycle
id: T-021
---
# T-021 mode 缺省 hard 与设置卡控件位置（R-01-009/AC-02）

风险等级: standard
状态: completed
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

- 实现: ① `lib/config.js`：`DEFAULT_INTERVENTION_MODE='hard'`（C-022）+ `HARD_INTERVENTION_MODE` 档位语义常量（档位与缺省解耦）。② `lib/settings.js`：Schema `mode` default 改引 `DEFAULT_INTERVENTION_MODE`。③ `lib/client/render.js`：介入强度控件移至 enabled 提示行紧后（高于其余全部选项）、下拉回退引常量、注释 C-022；`lib/client.js` 经 build-client.mjs 重建（bundle 内仅剩枚举与选项文案，无缺省残留）。④ `lib/status.js`/`lib/commands.js`：展示层回退改引常量。⑤ `lib/turn-review.js`：收口评审触发判定改绑 `HARD_INTERVENTION_MODE`（非 hard 即不评审的 fail-safe 语义保持）。
- 测试: 全套件 `npm test` 266 通过 / 0 失败（`test/config.test.js` 缺省 hard 断言锚定 R-01-009/AC-02；`test/status.test.js` 快照用例随缺省演进——缺省 hard、显式 soft、计数缺省三态；`test/turn-review.test.js` 处置器兜底标题随语义收敛）；`agentmap_lint` passed；`anchor_coverage` passed（prd-ac=84 全锚定）；`expected_fail_check` passed（executed=266 与账本一致）。
- SOLUTION 对照: PRD 愿景行收敛（软模式显式选择表述；缺省 hard 记 C-022）、R-01-009/AC-02 与 R-02-001/AC-04 缺省承诺改 hard；SOLUTION 产品契约 mode 行（缺省 hard + 控件位置 + 拒绝语义三段拆分）与设置命名空间偏离项穷举补 mode/C-022；RATIONALE C-022 四段式追加。SOLUTION 与实现对照无差异。
- commit: f1c3685 —— 实现提交（正文引用 T-021）；0ad6d99 —— 双轴审核修复提交（缺省值单点化与 map 级联收敛）；fd8936d —— 复审残留收敛提交（档位与缺省解耦）。
- review:
  - 审核方: code-review skill 合并双轴独立子代理（Standards/Spec 两轴并行，审核方逐条亲验）+ 两轮同审核方复审
  - 目的理解: 在 T-020 已交付的软硬模式之上按东家设置卡实测裁定收敛两点——介入强度控件位置（总开关紧下、高于其余选项）与缺省档位（hard，开箱即获收口评审）；验证方式为 266 用例全套件 + 三道门禁 + bundle 新鲜度脚本。
  - 执行方式: code-review skill 双轴并行独立子代理，基线 9aa723a...f1c3685（实现提交）；复审轮接收首轮全部发现逐条裁决，基线扩展至 0ad6d99、fd8936d。
  - 问题与修复: 首轮 Standards 3 硬违规——PRD 愿景行残留「软模式（默认）」（原子级联违例）→ 修复（0ad6d99）；展示层缺省回退漏改三处（status.js/commands.js 两处）→ 修复并单点化根因（四处回退与判定改引常量，settings.js 第二轮补落）；RATIONALE C-022 超句限 → 拆分（两轮收敛）。判断性 4 项——缺省字面量散布（Duplicated Code）→ 单点化收敛、render.js 位置裁定误标 C-021 → 改 C-022、config.test 断言重复 → 合并、SOLUTION mode 行一项三规则 → 拆子列表。Spec 轴 4 项——展示层 soft 兜底残留（同 Standards-2 单点化修复）、turn-review.test 标题失实 → 改名（锚定不变）、SOLUTION 偏离项穷举漏 mode/C-022 → 补记、task 收敛方案漏列愿景行 → 随 PRD 演进补落。复审轮 3 项——settings.js 补落、C-022 再拆、档位与缺省解耦（新增 HARD_INTERVENTION_MODE）→ 全部修复（fd8936d）。
  - 复审结论: 第二轮复审通过——三项全部消解、依赖单向无环、schemastery peer 隔离未破坏、档位与缺省解耦达成、bundle 守卫与 266 测试实跑通过、无新发现；两轮审核发现全部闭环，可关闭 T-021。
- 残余风险: ① UI 实测（控件位置与缺省显示）待东家在宿主重启加载新 bundle 后目验（bundle 已重建同步，宿主重启由东家执行）；② 开箱行为变更：未显式配置 mode 的既有部署重启后即入硬模式，每回合收口发起顾问评审（成本面东家知情裁定，软模式保留为显式选择项）。
