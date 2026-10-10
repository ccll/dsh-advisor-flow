---
doc-type: task
mutation: lifecycle
id: T-023
---
# T-023 收口评审审核类子会话豁免（R-01-009、R-02-001）

风险等级: standard
状态: active
关联: R-01-009（评审对象语义细化）、R-02-001/AC-01（新配置键即时生效）、T-022（豁免机制先例）

## 背景与目标

2026-10-10 东家三轮讨论收敛（本会话实录）：hard 模式下，主会话经 skill（如 code-review）发起的审核类子会话，其回合收口也触发收口评审——形成「对审核进行审核」。

- 东家裁定一：全量豁免一切子会话过宽。
  - 搜索、计划、判断类子会话是工作单元，其收口评审保障应保留。
- 东家裁定二：审核类子会话收口不评审。
  - 审核者本身是质量闸门，元评审冗余且落在高频路径（AgentMap 流程每 task 关闭必走 code-review）。
  - 每个 review 子会话收口一次同步咨询，扇出放大拉长主会话关键路径。
- 东家裁定三（终态方案）：按 label 与首条提示词的关键词豁免。
  - 判定源在子会话自身日志，机制可达性先行实证（见下）。

实证证据（2026-10-10，`~/.dsh/sessions/--home-cailei-proj-mailai-models--` 真实日志取证）：

- 子会话日志头部 header 行携带 `"origin":"subagent"`、`parentSession`、`delegationDepth`。
  - fork 会话 header 无 `origin` 字段且 `delegationDepth:0`——`origin === 'subagent'` 严格判定可绕开 fork seed 回放边界。
- `subagent/descriptor` 事件位于子会话自身日志头部（seq 0 或 6），`data.label` 承载 durable 创建标签。
  - one-shot 样本：`{"mode":"one-shot","label":"审查规范与代码异味"}`。
  - continuable 样本：`{"mode":"continuable","label":"Standards review of T-032"}`。
- 首条提示词经 `agent/inbox/spliced`（seq 3，`target:'next-turn'`，`inserted[].content[].text`）承载。
  - 实测子会话日志无 `user/message` 事件——首条提示词判定不得走表面重建线。
- code-review skill 实际 label 实测命中：`Standards review of T-032`、`Spec review of T-033`、`Spec 轴审核 T-049`。
- 读取成本上界：本机最大日志（4.8 MB 明文、7070 行）zstd 解压 + 全量 JSON.parse 实测 0.146 秒。
- 语义边界：豁免审核类是向 DOMAIN.md:84「评审对象只能是执行者回合」收敛；「执行类子会话照常评审」相对 DOMAIN.md:11「执行者 = 主 agent」是存量越界，非本变更引入，随本 task 一并经东家确认落 map。

目标：审核类子会话的回合收口不再触发收口评审；判定失败 fail-open 照常评审；豁免模式清单可配置。

## 差距评估

- `lib/turn-review.js` `handleTurnStopping`：豁免仅覆盖本插件顾问子会话（T-022 登记表），skill 发起的审核类子会话照常被评审。
- `lib/config.js`：无豁免模式清单配置键。
- `lib/index.js`：处置器无子会话自证与关键词判定的注入缝；`getSessionEvents` 已存在可复用为读取源。
- `SOLUTION.md` 收口评审语义块：无子会话豁免语义（仅顾问子会话豁免条）。
- `PRD.md` R-01-009：无子会话豁免 AC。
- `DOMAIN.md`：缺「子会话自证」与「豁免模式清单」词条。
  - 评审对象的不变量行未覆盖子会话收口。

## 收敛方案

- `lib/config.js`：新增顶层配置键 `turnReviewExemptPatterns`。
  - 类型：非空字符串数组。
  - 空数组 = 不豁免。
  - 非法值按 invalid-value-rejected 拒绝（与 mode 同型）。
  - 默认值：`['review', '审核', '审查', '评审', '审计']`（双语预置，实证命中 code-review 实际 label）。
- `lib/turn-review.js`：新增前置豁免判定 `isExemptSubsession(sessionId)`，位于 T-022 顾问子会话豁免之后、预算核查之前。
  - 判定两条件同时满足才豁免：
    - 子会话自证：该会话日志 header `origin === 'subagent'`。
    - 关键词命中：descriptor `data.label` 或首条 `agent/inbox/spliced` 提示词文本命中豁免模式（大小写不敏感的子串匹配）。
  - fail-open：缝缺失、读取失败、解析失败一律不豁免（照常评审）。
  - per-session 判定缓存：一次判定后复用，避免 continuable 子会话逐回合重复读取；仅缓存成功读取的判定，失败不缓存、次轮收口重判（Spec 复审修复）。
  - 豁免命中即 skipped 留痕（计数 + 日志，与 T-022 同型）。
- `lib/index.js`：接线注入读取缝（复用 `getSessionEvents`）与配置读点（读时求值同型）。
- `lib/settings.js` / `lib/client/render.js`：Schema 补 `turnReviewExemptPatterns`（双清单纪律）与设置卡输入字段（逗号/换行分隔解析，空 = 豁免关闭）——兑现 R-02-001「web 设置卡可配置」承诺（Spec 复审补列）。
- `PRD.md`（东家确认闸口，拟议）：
  - R-01-009 陈述句补「审核类子会话收口不评审」。
  - 新增 AC-11：子会话自证且关键词命中时，收口不评审且留痕。
  - 新增 AC-12：判定失败时照常评审（fail-open）。
  - R-02-001 配置清单句补 `turnReviewExemptPatterns`。
- `DOMAIN.md`（东家确认闸口，拟议）：
  - 新增词条「子会话自证」与「豁免模式清单」。
  - 不变量行修订：评审对象 = 执行者回合与执行类子会话收口；顾问子会话与审核类子会话收口不评审。
- `SOLUTION.md`：收口评审语义块补「子会话审核豁免」语义条目（判定源、fail-open、缓存、配置键）。
- 测试：config 解析、豁免判定（命中/不命中/失败三分支）、缓存、接线级真实形状回归。

## 测试计划

- `test/config.test.js`（或既有 config 断言所在文件）：
  - 默认值双语预置断言。
  - 非法值拒绝与空数组放行。
- `test/turn-review.test.js`：
  - 子会话自证 + label 命中 → 豁免，skipped 留痕。
  - 子会话自证 + 首条提示词命中 → 豁免。
  - 双源不命中 → 照常评审。
  - 读取失败/缝缺失 → 照常评审（fail-open）。
  - 判定缓存：同会话第二次收口不再读取。
  - 主会话（origin 非 subagent）prompt 含关键词 → 照常评审（自证前置保护）。
  - 失败判定不缓存：首判读取失败（undefined 或抛错）照常评审，次轮成功读取后豁免。
  - 标签与提示词分离匹配：跨源拼接不构成命中。
- `test/client/settings-card.test.js`：豁免关键词输入默认回显、逗号分隔解析进 patch、空输入 = 豁免关闭、随总开关禁用。
- `test/index.test.js` 接线级回归：
  - 真实形状事件流夹具（header origin + descriptor + inbox splice）驱动豁免。
  - 执行者根会话收口照常评审（既有用例回归）。
- 全套件 `npm test` 回归全绿。
- 三道门禁：agentmap_lint、anchor_coverage、expected_fail_check。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：豁免判定是本 task 主体行为 | `test/turn-review.test.js::T-023 审核类子会话豁免`；`test/index.test.js::T-023 接线级豁免` |
| 异常 | 适用：读取失败与解析失败 fail-open | `test/turn-review.test.js::T-023 豁免判定 fail-open` |
| 边界配置 | 适用：空清单、主会话保护、缓存行为 | `test/config.test.js::R-02-001/AC-04 T-023 turnReviewExemptPatterns 解析`；`test/turn-review.test.js::T-023 主会话不豁免`；`test/turn-review.test.js::T-023 判定缓存` |
| 副作用 | 适用：判定缓存随会话清理，不泄漏 | `test/index.test.js::T-023 接线级豁免：审核子会话（真实形状日志）收口不评审；缓存复用与 disposed 复位`（disposed 后判定复位断言） |

## 残余风险

- 联调验证项 ①：observeSession 事件流是否含 header 行待实弹确认。
  - 不含时自证判定退回 descriptor own-suffix 推算（inheritedEventCount 之后）。
- 联调验证项 ②：豁免判定缓存须随会话清理。
  - 前提：宿主对子会话派发 `session/disposed`（同 T-022 联调项 ① 口径）。
  - 若宿主不派发该事件，缓存条目随会话累积泄漏。
- 关键词漏判残差存在。
  - 触发条件：审核子会话的 prompt 全程回避清单词形。
  - 后果：该子会话仍被评审（漏豁免方向，非误豁免）。
  - 启发式固有残差，东家经配置补词即修。
- 素材缺口（TODO.md:24 登记）不阻塞本 task。
  - 该缺口影响全部收口评审的有效性，另行裁决。
- 语义边界观察已登记 TODO：实质执行移入 continuable 子会话时 DOMAIN 词条须重审。
- 复审登记（2026-10-10 Standards 轴复审）：豁免判定夹具在两个测试文件各建一份，事件形状相同。
  - 位置：test/turn-review.test.js 的 subsessionLog 与 test/index.test.js 的 reviewSubsessionLog。
  - 处置：判断项不阻断收口，合并提取留待后续维护，不顺手重构。
- 复审登记（2026-10-10 Standards 轴复审）：C-023 上下文长句维持原文不改写。
  - 理由：风格检查显式豁免 RATIONALE 散文段（STYLE_PROSE_EXEMPT_FILES），拆句无 lint 收益，避免触碰 append-only 历史。
- 复审登记（2026-10-10 Spec 轴复审，独立 reviewer）：四项发现，同轮全部修复。
  - settings Schema 漏写 `turnReviewExemptPatterns`（双清单纪律违例 + R-02-001 web 设置卡承诺未兑现）→ lib/settings.js Schema 补键、lib/client/render.js 补设置卡字段、SOLUTION.md#配置与状态服务新键清单同步。
  - 失败判定被缓存（注释声明不缓存，实现无条件缓存 false；生产缝以 undefined 表达读取失败，失败走成功路径被缓存，暂态故障致同会话持续漏豁免）→ lib/turn-review.js 仅缓存成功读取（events 为数组）所得判定，失败一律不缓存、次轮收口重判；SOLUTION.md 缓存语义行同步。
  - R-02-001/AC-04 锚点缺（豁免清单缺省断言未并入 AC-04 默认值用例）→ test/config.test.js 默认值用例补断言，解析用例锚改 R-02-001/AC-04。
  - label 与 prompt 拼接 haystack 可跨界拼出清单词（误豁免方向）→ 分离匹配（等价 OR，不跨源拼接）。

## 终态与证据

（active 期间未填）
