---
id: T-033
doc-type: task
created: 2026-10-15
mutation: lifecycle
---

# T-033 收口评审豁免关键词缺省清单增补「复审」

风险等级: standard
状态: active

## 背景与目标

东家指令（2026-10-15）：默认的豁免关键词中加一个「复审」。豁免清单缺省值由 `DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS` 单点承载（C-023 设立的机制，原预置 review/审核/审查/评审/审计）；本任务把「复审」并入缺省预置并同步活文档，使审核类子会话收口豁免覆盖「复审」命名的子会话。

## 差距评估

- `lib/config.js` 缺省数组无「复审」——唯一实现单点，客户端 bundle 内联同源常量，重建即同步。
- `SOLUTION.md` 产品契约枚举缺省清单——需同步。
- `PRD.md` AC-04 承诺为「默认双语预置」未枚举词表——扩充词表不违背承诺，无需改动。
- `test/config.test.js` 含缺省词成员断言；`test/client/settings-card.test.js` 回显缺省串断言——需同步。
- RATIONALE C-023 为历史记录（append-only）保留原文；本变更系东家直接指令、无候选方案权衡，不新增决策条目，变更轨迹由本任务承载。

## 收敛方案

- `lib/config.js` `DEFAULT_TURN_REVIEW_EXEMPT_PATTERNS` 增补 `'复审'`（置于「评审」后，语义相邻）。
- `SOLUTION.md` 子会话审核豁免条目缺省清单同步。
- `test/config.test.js` 缺省词成员断言补 `复审`；`test/client/settings-card.test.js` 缺省回显串同步。
- 重建 `lib/client.js`（bundle 内联该常量）。

## 测试计划

- 全量 `node --test "test/**/*.test.js"` 绿（config 缺省词成员、卡片回显串两处锚点更新）。
- `agentmap_lint` 通过。
- bundle 确定性重建一致。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
| --- | --- | --- |
| 成功 | 适用：缺省清单含「复审」 | `test/config.test.js::R-02-001/AC-04 T-023 turnReviewExemptPatterns 解析：默认双语预置（C-023）、显式覆盖、空数组关闭、非法拒绝`（成员断言） |
| 异常 | 适用：显式覆盖/空数组/非法输入路径不受词表扩充影响 | `test/config.test.js::R-02-001/AC-04 T-023 turnReviewExemptPatterns 解析：默认双语预置（C-023）、显式覆盖、空数组关闭、非法拒绝` |
| 边界配置 | 适用：显式清单完全覆盖缺省（空数组=关闭） | `test/config.test.js::R-02-001/AC-04 T-023 turnReviewExemptPatterns 解析：默认双语预置（C-023）、显式覆盖、空数组关闭、非法拒绝` |
| 副作用 | 适用：豁免判定/缓存/守卫共用清单的行为不变 | `test/turn-review.test.js::T-023 审核类子会话豁免`（DEFAULT 常量引用，随扩自动覆盖） |

## 自查清单

- 边界：显式配置 `turnReviewExemptPatterns` 的存量配置完全覆盖缺省（解析用例覆盖），缺省扩充不影响已配置者。
- 异常路径：空数组=豁免关闭与非法输入拒绝语义不变（既有断言全绿）。
- 回归影响：豁免判定、判定缓存签名（patternsKey 含清单内容）、工具面守卫共用同一清单——清单成员断言唯一锚点在 config 测试，卡片回显串为第二锚点。

## 终态与证据

- 实现: `lib/config.js:63` 缺省数组增补 `'复审'`（注释注明 T-033 东家指令）；`SOLUTION.md:583` 产品契约同步；bundle 重建随实现提交入库（sha1 31fa7b5f）；PRD AC-04 承诺（默认双语预置，未枚举词表）不违约未改；RATIONALE C-023 原文保留（append-only，不新增决策条目——直接指令无候选权衡）。
- 测试: `node --test "test/**/*.test.js"` 323/323 绿（exit=0）；锚点更新 `test/config.test.js:265`（成员断言含复审）与 `test/client/settings-card.test.js:834`（缺省回显硬编码串，双侧漂移即红）；`agentmap_lint` exit=0。
- SOLUTION 对照: 子会话审核豁免条目缺省清单已同步（T-033 增补标注）；机制语义（显式覆盖/空数组关闭/非法拒绝/缓存签名 patternsKey 含清单内容自动重判）不变，与实现一致。
- review: 审核方 = 独立子代理（独立上下文），结论 blocking=0 / non-blocking=2（N1 lint 文风告警属既存类不处置；N2 评审以只读比对代替重建复跑——实现方已实际重建并入库）。全仓词表硬编码排查无遗漏枚举点；两处测试锚点真实锚定核验通过；复审结论：通过。
- 风险自评: —（standard 档）
- commit: （提交后回填）
