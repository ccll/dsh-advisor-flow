---
id: T-032
doc-type: task
created: 2026-10-15
mutation: lifecycle
---

# T-032 默认介入强度回归 soft + maxTokens 占位显示实际值

风险等级: standard
状态: active

## 背景与目标

东家 2026-10-15 指令（生产验证后微调）：

1. 配置默认为 soft 模式——C-022 缺省 hard 裁定翻案（PRD 愿景段、R-01-009/AC-02 与 R-02-001/AC-04 均承诺缺省硬模式，需原子级联演进）。
2. 所有门禁选项默认打开——服务端 lib/config.js:396 门开关 `parseBool(true)` 本就默认全开（无需改服务端）；但设置卡门开关此前读未解析叠加值，raw 未写键时显示「关」而运行时实际「开」，显示与行为相反，须补齐显示面。
3. 设置卡 maxTokens 占位文案把所选模型声明的实际 maxTokens 数字追加到「跟随所选模型配置」后并用括号括起来（生产 gpu 声明 maxTokens: 131072，~/.dsh/profiles/web/cordis.patch.yml）。

需求变更路径（AC-02/AC-04 默认值承诺变更）：PRD → SOLUTION → RATIONALE（C-032，废弃 C-022 的缺省裁定部分）→ 代码 → 测试，同次变更内同步。

## 差距评估

- lib/config.js:47 `DEFAULT_INTERVENTION_MODE = 'hard'` → `'soft'`；guidelinesActive 谓词（mode !== hard）语义不变。
- PRD.md:128（R-01-009/AC-02「以 hard 生效」）、PRD.md:12、PRD.md:149（AC-04）、SOLUTION.md:371/377 缺省承诺与 C-022 引用需同步；lib/tool-guard.js:83 与 lib/status.js:63 注释缺省依据同改 C-032。
- lib/client/card-state.js 无模型声明 maxTokens 取值函数；lib/client/render.js:664 placeholder 为静态文案。
- 门开关显示面：render.js gates 块读未解析叠加值，缺省物化缺失（本任务引入 displayConfig 修复）。
- RATIONALE 追加 C-032。
- 测试：test/config.test.js:255 缺省断言；test/client/settings-card.test.js 占位断言 + mode 默认显示 + 门默认勾选。

## 收敛方案

- config.js 缺省改 soft，注释记录 C-032 翻案。
- card-state.js 增 `modelMaxTokens(modelId)`（目录模型声明 maxTokens，正整数才返回）与 `displayConfig()`（解析失败回退未解析叠加值）。
- render.js placeholder 动态拼接 `跟随所选模型配置（当前 N）`，无声明时回退原文。
- render.js gates 块改读 displayConfig。
- PRD/SOLUTION/RATIONALE 按上述落点同步。

## 测试计划

- 单元：缺省 mode==='soft'（config.test）。
- 单元：卡片 mode 控件默认显示 soft。
- 单元：placeholder 含「当前 131072」（fixture 模型声明）与无声明回退原文两形态。
- 单元：四门开关默认 aria-checked=true（卡片显示面）。
- 单元：tool-guard 无 mode 键走归一 soft 行为路径（审核类子会话 SESSION_EXEMPT 而非硬模式关闭）。
- E2E（af-home，mock 目录无 maxTokens）：四门开关默认 aria-checked=true + mode 显示 soft + maxTokens placeholder 回退原文 + pageerror=0。
- 全量套件回归 + bundle 双构建哈希一致 + agentmap lint。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
| --- | --- | --- |
| 成功 | 适用：缺省 soft 与占位数字为主路径 | `test/config.test.js::R-01-009/AC-02 mode 缺省 soft（开箱温和，pi 行为；C-032 废弃 C-022 缺省 hard）`；`test/client/settings-card.test.js::R-02-001/AC-04 默认面（T-032）：mode 缺省显示 soft、四门默认开启、maxTokens 占位显示模型声明值` |
| 异常 | 适用：目录不可用/模型无声明时占位须回退而非误显数字 | `test/client/settings-card.test.js::R-02-001/AC-04 默认面（T-032）：mode 缺省显示 soft、四门默认开启、maxTokens 占位显示模型声明值`（gpt-x 无声明回退原文断言） |
| 边界配置 | 适用：显式 mode: hard 仍生效、阈值下界不变 | `test/config.test.js::R-01-009/AC-01 mode 非法值拒绝且原因可查；合法值透传（C-021）`；`test/config.test.js::R-02-001/AC-05 循环门阈值下界：小于 2 的配置被拒绝` |
| 副作用 | 适用：hard 语义面（守则停用/收口评审/守卫拒绝）行为不变 | `test/guidelines.test.js::R-01-009/AC-13 硬模式守则停用：mode=hard 时守则族求值为空串，soft 照常（C-025）`；`test/tool-guard.test.js::R-01-001/AC-10 mode 未定义走归一 soft 行为路径：审核类子会话按 SESSION_EXEMPT 拒绝而非硬模式关闭（复审 N1，C-032）` |
| 兼容性 | 适用：已显式配置 mode 的存量配置与快照呈现不变 | `test/status.test.js::R-01-009/AC-10 状态快照呈现介入强度与收口评审计数（缺省 soft、显式 hard、计数缺省零）` |

## 自查清单

- 边界：目录声明 maxTokens 为 0/负数/非整数时 `modelMaxTokens` 返回 undefined 回退原文（`test/client/settings-card.test.js` fixture 只有正整数声明——以正整数守卫断言覆盖，见 modelMaxTokens 实现守卫）。
- 异常路径：解析失败（非法草稿）时 `displayConfig()` 回退未解析叠加值，门显示回退旧行为而非崩卡（card-state.js displayConfig 分支，单测覆盖 deriveEnabled 不抛错既有用例群）。
- 回归影响：hard 全语义面不变（显式 hard 仍拒绝配置非法值、收口评审、守则停用——test/guidelines、tool-guard、turn-review、status 既有断言全绿）；显式配置过 mode 的存量 profile 不受缺省变化影响。

## 终态与证据

（关闭时填写）
