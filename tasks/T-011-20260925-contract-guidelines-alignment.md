---
doc-type: task
mutation: lifecycle
id: T-011
---
# T-011 契约与守则对齐 pi-advisor-flow 0.8.2（文案英文化 + 引擎语义 + 默认值）

风险等级: high
状态: active
关联: R-01-001～R-01-007、R-02-001（C-008 决策包；基线冻结 C-009）

## 背景与目标

东家裁定除 dsh 无法承载项外行为与 pi-advisor-flow 严格一致（C-007 延续，基线升 0.8.2，C-009）。差距审计（三路证据）判定：文案中文化、引擎语义偏差（计数/UUID/空意见/JSON 解包）、默认值反向、守则缺行、门文本形状偏差等需在本 task 收敛。目标：契约面与守则面逐字对齐冻结制品，引擎语义与 pi 一致，默认值对齐。

## 差距评估

- 文案中文化 → 英文逐字（守则四行/ADVISOR_SYSTEM/ADVISOR_DECISION_SYSTEM/工具与参数描述）——审计 G-8 关联、主线程提取已完成。
- ask_advisor 参数面 2→6（gitContext/includeTrackedFiles/includeUntracked；force 随 Jev NG 不实现）；adviceId 改 UUID；空意见判失败；结果前缀 `Advisor (model)`（R-01-001/AC-04~08）。
- 循环门计数改连续签名制 + 波动归一 + threshold 下界 ≥2（G-6/G-7/G-20）。
- 门命中预通告、失败通告形状 `**Advisor gate failure (category):**`、门问句去参数（G-9/G-10）。
- manual 失败 steer 可见 + 并发替换语义（G-11/G-12）。
- parseAdvice JSON 解包移除（G-15）。
- 守则注入前置（工具缝激活 + 模型访问允许）（G-16）。
- 默认值对齐：failureMode=block-session、三门与循环门默认 true、redactSecrets=false、threshold=3（G-5/C-008）。
- 新配置键：customInvocation、modelWhitelist、blockOnBlocked、contextMaxChars、gitContextMaxChars（C-008 ⑦⑨ 等）。
- 守则新增 custom 行与剩余次数预告行（G-8）。

## 收敛方案

- `lib/pi-texts.js`（新）：从冻结制品（.tmp-audit/v0.8.2）程序化提取全部文案字符串表，导出常量；测试按表逐字等值断言。
- guidelines.js：改引英文文本工厂；custom/预算行模板展开；注入前置守卫（tools 缝激活态）。
- tools/ask-advisor.js：六参 schema（英文描述逐字）；execute 空意见→失败值；UUID adviceId 由引擎分配；render 前缀。
- consultation.js：UUID 分配；空回复判失败；parseAdvice 解包删除；意见账本（issue/lastAdvice/normalizedQuestion）骨架（完整生命周期在 T-013 落地）。
- observer.js：连续签名计数 + volatility 归一（timestamp/date/request-id/临时路径/空白）。
- gates/index.js：预通告 steer、失败通告英文形状、门问句去参数、阈值下界校验。
- commands.js：manual 替换语义 + 失败 steer。
- config.js/settings.js：默认值与新键（解析器 + Schema 双写）；旧键警告保留。
- git 契约：无。

## 测试计划

- `node --test` 全量绿：字符串表逐字断言（守则四行+两系统提示+工具描述）、连续计数交错序列用例、波动归一用例、UUID 形态、空意见失败、门预通告/通告文本、manual 替换、默认值断言（config 对象断言）、threshold 下界拒绝。
- staging 实弹（af-verify profile）：守则英文注入可见、门命中预告+Decision 送达、abort 极性复现（G-13 裁决输入）。
- 测试锚定：全部新 AC 落锚后本 task 关闭并切回 strict。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：文案逐字对齐、连续计数语义、UUID 与结果前缀 | `test/pi-texts.test.js::R-01-003/AC-01 文案逐字等值`、`test/observer.test.js::R-01-005/AC-06 交错序列归位` |
| 异常 | 适用：空意见失败、abort 极性、预算值返回 | `test/consultation.test.js::R-01-001/AC-04 空意见判失败` |
| 边界配置 | 适用：默认值、threshold 下界、旧键保留 | `test/config.test.js::R-02-001/AC-04 默认值对齐` |
| 副作用 | 适用：守则注入前置、门预通告可见性 | `test/guidelines.test.js::R-01-007/AC-04 工具缝缺失不注入` |

## 终态与证据

（待实现）
