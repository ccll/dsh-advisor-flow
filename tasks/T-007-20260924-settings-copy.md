---
doc-type: task
mutation: lifecycle
id: T-007
---
# 设置卡文案统一与可读性改进

状态: completed
关联: R-02-001（GUI 面）
风险等级: standard

## 背景与目标

东家目验反馈四点（R-02-001 GUI 面可用性细化，map 不变——设置卡能力已在 R-02-001 承诺，本轮只改呈现层）：

1. 字段标题大小写不统一（`Advisor provider` / `advisor reasoningEffort` / `History 档位`混排），且出现 `reasoningEffort` 这类 camelCase 连写词；
2. 各选项无说明介绍，不知如何取值；
3. 「隐私档位」组标题（legend）字号 12px 小于其下选项标题（13px），层级关系不可辨；
4. 「密钥脱敏」行与其下方 footer 分隔线零间距紧贴，视觉拥挤。

## 差距评估

- lib/client/render.js：字段 label/ariaLabel 为中英混排 + camelCase；`field()` 的 hint 能力仅 3 处使用；门策略/隐私档位下拉选项为裸枚举值；`.advisorflow_legend` 12px < `.advisorflow_toggleLabel` 13px；`.advisorflow_footer` 无上边距，与 form 末行贴线。
- 语义事实源（hint 文案须与实现一致）：lib/gates/index.js（review/ask/block/block-session 处置语义）、lib/context.js（history off/delta/window 与 repoContext none/summary/patch 截断语义）、lib/config.js（脱敏默认开、阈值默认 3）。

## 收敛方案

- render.js 文案统一为中文规范名：顾问提供方 / 顾问模型 / 推理档位 / 计划门·失败门·循环门·完成门 / 会话历史档位 / 仓库上下文档位（保留产品名 Advisor Flow）；下拉选项改为「中文（原值）」双写，保证与 settings.yaml 取值的映射可见。
- 每字段补一句 hint：主开关（关闭的影响面）、provider/model/effort 联动关系、四门触发时机、策略四值语义、阈值含义与留空默认、history/repoContext 各档位含义、脱敏行为。
- 样式：legend 12px→14px（高于选项标题 13px、低于卡片标题 15px）；footer 加 margin-top:12px 恢复分隔线上方留白。
- 逻辑层零改动；`npm run build:client` 重建产物随提交。

## 测试计划

- test/client/settings-card.test.js 文案查找器同步；新增断言钉住新 hint 与下拉选项双写文案。
- `node --test` 全量绿；playwright 静态挂载截图目验四点修正。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：新文案/说明渲染完整 | `test/client/settings-card.test.js::R-02-001/AC-01` |
| 异常 | 不适用：纯文案/样式层，无新失败路径 | — |
| 边界配置 | 适用：目录失败回退形态下文案同步 | `test/client/settings-card.test.js::目录拉取失败回退` |
| 副作用 | 适用：产物新鲜度——重建后 lib/client.js 与源码同步（pre-push 30 守卫复核），bundle 经典脚本契约由测试钉住 | `test/client-bundle.test.js::client bundle 是经典脚本（closure-factory CJS），无裸 ESM` |

## 终态与证据

- 实现: 设置卡纯呈现层四点改进——① 文案统一中文规范名（顾问提供方/顾问模型/推理档位/计划门·失败门·循环门·完成门/会话历史档位/仓库上下文档位；保留产品名 Advisor Flow），下拉选项改「中文（原值）」双写；② 每字段补说明 hint（主开关影响面、provider/model/effort 联动、四门触发时机、策略四值语义、阈值含义与留空默认、history/repoContext 档位含义、脱敏行为），语义逐条对照 gates/config/context 事实源；③ legend 12px→14px（组标题高于选项标题 13px、低于卡片标题 15px）；④ footer margin-top:12px 恢复分隔线上方留白。评审轮补 hintParagraph() 共用提取、恒真三元内联、POLICY_HINT_BASE 改名去异义近名。逻辑层零改动（双轴核验属实）。
- 测试: `npm test` 166/166 全绿（新增文案正/反断言：camelCase 反断言、循环门句式正反断言、策略/阈值/patch hint 抽样钉）；agentmap lint 通过；headless Chrome 挂载页展开/折叠两态真机目验四点通过（截图会话内核验，产物未入库）。
- SOLUTION 对照: web 设置卡模块职责与代码位置描述不变，无需演进；配置键与取值枚举零改动（双清单纪律未触发）；map-code 无漂移。
- commit: d966ce5
- commit: e657dad
- commit: 47a8f09
- review:
  - 审核方: 双轴独立评审——Standards 轴代理 03a505d9-dc29-4bbe-8590-5a9864b09252、Spec 轴代理 6985a788-0c9a-46ce-8104-67e2c605273e，code-review skill 流程
  - 目的理解: 本 task 目标是设置卡呈现层可读性改进（东家四点目验需求）——文案统一、说明补齐、组标题层级、分隔线留白；reviewer 需核验「逻辑层零改动」声明、hint 文案与实现语义一致性、产物同步
  - 执行方式: code-review skill 双轴并行子代理；评审基线 f55c9b2..d966ce5（首轮）→ d966ce5..e657dad（修复复审）→ d966ce5..47a8f09（终审）
  - 问题与修复: Spec 轴核心发现——循环门 hint 误用失败门「下一次调用」句式（实现：recordCall 计数含当前调用、达到阈值的那次调用本身受审、命中后重置）→ 修正句式并同步 threshold hint；block-session 说明把 best-effort 会话停止缝说成必然 → 改「尽力停止会话」；patch hint 补字节上限。Standards 轴基线三微项——hint 段落三处同形提取 hintParagraph()、GATE_HINTS 恒真三元内联、POLICY_HINT(S) 异义近名改名（POLICY_HINT_BASE）+ 单点常量内联 → e657dad；复审发现恒真三元内联未实际落地（提交正文已声明未落地）→ 47a8f09 补齐
  - 复审结论: Spec 轴一次复审通过（句式与 observer/loop/failure/gates-index/context 逐条核验一致，bundle 解码复核 + 重建零差异）；Standards 轴两轮复审通过（三微项闭环、无硬违规、无残留）；残余不阻塞项登记 TODO（hint 语义机械锚点、CSS 两点测试断言、真机目验证据入库载体）
