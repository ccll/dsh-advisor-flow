---
doc-type: task
mutation: lifecycle
id: T-018
---
# T-018 failureMode 默认值 block-session 改为 block-tool

风险等级: standard
状态: active
关联: R-02-001（C-017；东家 2026-10-01 会话直接指令翻案 C-008 ②）

## 背景与目标

C-008 ②（严格对齐 pi 0.8.2）将 failureMode 默认定为 block-session。其后的生产证据表明该默认把门审基础设施故障放大为会话级不可恢复拒绝：① 同协议 40 次复现实测约 12.5% 顾问回复不合规（中文漂移或空正文），对抗性 Decision 解析器 fail-closed 判为咨询失败；② 2026-09-30 深夜真实会话因门审咨询失败触发会话封锁，一切工具调用（含只读）被永久拒绝、无解除手段，整会话报废。东家拍板翻案：默认值改为 block-tool——咨询失败与 blocked 裁决都只拒绝当前一次工具调用；三个枚举值（warn-and-continue | block-tool | block-session）与处置语义不变，仅默认值变更。决策依据与被否方案见 C-017（废弃 C-008 ② 中该项默认值裁定，其余维持）。边界：不做失败重试、不做失败/blocked 分档处置、不加 unblock 命令、不改门引擎处置逻辑、不改 pi 文案冻结表。

## 差距评估

- 运行时默认：`lib/config.js` `DEFAULT_FAILURE_MODE = 'block-session'`（注释引 C-008 ②）——常量、`resolveAdvisorFlowConfig` 初始值与 `parseEnum` 回退共用该常量，单点改。
- 设置面 Schema：`lib/settings.js` failureMode `.default('block-session')` → block-tool（与 config.js 双清单纪律同步）。
- 设置卡展示：`lib/client/render.js` 阻断模式下拉未配置回退为字面量 `'warn-and-continue'`——回退分支 = 默认值的卡片侧绑定点（gateway `advisor-flow/get` 返回 RAW namespace，未配置时 `config.failureMode` 为 undefined，已核实 card-state 加载路径无客户端默认填充），展示默认与运行时默认不一致会误导会话主；改为绑定 `DEFAULT_FAILURE_MODE` 权威常量，此后默认值再翻转卡片自动跟随。
- 构建产物：`lib/client.js` 为 `scripts/build-client.mjs` 产物（closure-factory CJS，内联 config.js 常量与 render.js）→ 改完源码重建。
- Map 演进：PRD R-02-001/AC-04 默认值承诺改写（偏离项格式沿 AC-06/07 引 C-015 先例，出处保持 C-008）；SOLUTION 5 处默认值描述（方案细化清单、产品契约命名空间头注与 failureMode 键、配置与状态服务模块、T-011 历史交付行括注）；RATIONALE C-017 追加；TODO 原 failureMode 处置条目改写为剩余的失败/blocked 分流待议项。
- 测试：`test/config.test.js` R-02-001/AC-04 默认断言与标题、默认值注释；`test/status.test.js` 默认快照断言；设置卡「未配置 raw → 下拉选中默认档」无断言（补）。显式传 `'block-session'` 的场景测试（gates/index/gateway/status 显式配置）与门处置引擎测试不动。

## 收敛方案

- `lib/config.js`：`DEFAULT_FAILURE_MODE = 'block-tool'`；注释改为 C-017 依据（偏离 pi、废弃 C-008 ② 该项）。
- `lib/settings.js`：Schema default 同步 `'block-tool'`。
- `lib/client/render.js`：新增 `import { DEFAULT_FAILURE_MODE } from '../config.js'`（card-state 已有同源 import 先例，bundle 内联）；下拉 value 回退 `?? DEFAULT_FAILURE_MODE`。
- `scripts/build-client.mjs` 重建 `lib/client.js`（pre-push 30-client-bundle-fresh 门禁口径）。
- PRD/SOLUTION/RATIONALE/TODO 如差距评估所列同提交演进。

## 测试计划

- `test/config.test.js`：R-02-001/AC-04 标题锚默认断言 block-tool；三值逐一可解析、非法值拒绝等既有用例不回归。
- `test/status.test.js`：默认快照 failureMode=block-tool。
- `test/client/settings-card.test.js`：新增未配置 raw（无 failureMode 键）渲染 → 阻断模式下拉选中 = block-tool。
- 全套件 `npm test` 回归；`agentmap_lint --staged`；`anchor_coverage`（R-02-001/AC-04 锚点仍由 config.test.js 标题承载）；`expected_fail_check`；client bundle 重建后与源码同步。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用: 未显式配置时 failureMode=block-tool；显式配置三值不受影响 | `test/config.test.js::R-02-001/AC-04 默认值：failureMode=block-tool（偏离 pi 0.8.2 记 C-017）、三门与循环门默认开启、脱敏默认关闭、repoContext 摘要档、阈值 3`、`test/config.test.js::R-02-001 门配置解析为结构化对象（三布尔 + 循环门阈值 + failureMode 三值）` |
| 异常 | 适用: 非法 failureMode 值拒绝行为不变 | `test/config.test.js::R-02-001 非法值被拒绝；未知键不算拒绝；空配置取默认（守则三门布尔 + 循环门阈值 + 阻断模式；阈值下界另见 R-01-005/AC-08）` |
| 边界配置 | 适用: 未配置 raw 的设置卡回退选中默认档位；空配置解析 | `test/client/settings-card.test.js::R-02-001/AC-04 未配置 raw 的阻断模式下拉选中默认档位（C-017: block-tool）` |
| 副作用 | 适用: 门处置引擎与封锁语义不回归（显式 block-session 场景原样通过）；状态快照默认展示跟随 | `test/gates.test.js::R-01-005/AC-03 决策 blocked × block-session：会话封锁 + stopSession 调用 + 后续调用全 deny`、`test/status.test.js::R-02-003 禁用态与缺失路由在状态中可查询（disabled-with-reason）；阻断模式可查询` |

## 终态与证据

（关闭时填写）
