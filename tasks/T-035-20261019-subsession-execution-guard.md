---
doc-type: task
id: T-035
created: 2026-10-19
mutation: lifecycle
---

# T-035 顾问子会话零工具契约执行面修复与会话 cwd 采集

风险等级: standard
状态: completed

## 背景与目标

- 东家裁定（会话内明示）：「宿主侧不修，其它的地方修」——宿主侧委派组合不尊重 `toolFilter` 的语义缺陷不修，插件侧修复其它缺陷。
- 缺陷一（NG-1/R-02-007/AC-05 违约）：宿主 dsh-tool-subagent 把 `subagent`/`list_subagent_models` 注册进被 spawn 子会话的 own 层（dsh-tools `view()` 对 own 层不做 admits 检查），插件的 `toolFilter:{allow:[]}`（lib/subsession.js:153）拦不住——真机实证（mailai-models 会话 e3846d0a，2026-10-19 11:49）：顾问子会话工具恰为委派对，顾问 step1 即委派子代理并真实执行 cargo test 等命令。顾问「不执行任何工具」（PRD NG-1）与「不得出现任何可执行工具」（R-02-007/AC-05）被击穿。
- 缺陷二：`repository_changes` 素材区恒为 `not-a-repository`（lib/git-context.js:43）——根因 lib/index.js:107 `getCwd = () => process.cwd()` 返回 dsh 服务进程 cwd（systemd WorkingDirectory=/home/cailei），非会话工作区；违反 R-02-006 仓库上下文契约。会话真实 cwd 在 `sessionQuery.observeSession(...).header.cwd`（宿主先例 dsh-session-reference/lib/index.js:523）。
- 目标：插件侧恢复上述两项既有承诺；执行面否决为主（能力面），协议提示补句为辅（指令面）；决策依据记 RATIONALE C-034。

## 差距评估

- 宿主语义：`restrict({allow:[]})` 只过滤继承面（global+祖先层），own 层注册（dsh-tool-subagent 的委派对）恒可见——插件侧无法让工具「不出现」，只能拦「执行」。AC-05 字面因此存在宿主侧残余缺口，本 task 以执行面否决实现承诺实质，字面缺口记 RATIONALE C-034。
- getCwd 两使用点（lib/consultation.js:511、:597）当前取宿主进程 cwd：/home/cailei 非 git 仓库 → 注记恒 not-a-repository（真机日志实证）。
- 协议提示本体受 C-009 冻结（pi-texts.test.js 逐字断言），禁委派指示须以附加常量承载并仅拼接子会话 persona。

## 收敛方案

- 新模块 lib/subsession-guard.js：`createSubsessionExecutionGuard({isAdvisorSubsession, logger})` → `{check(exec), denialStats()}`；`tools/pre-execute` carrier（`{name, arguments, agent, …}`，会话标识 `exec.agent.id`）命中登记表即返回 `{kind:'deny', reason: SUBSESSION_TOOL_DENIED_REASON}`（英文三点式：advisory-only 契约/勿重试/以素材作答）；deny-all 不限工具名（NG-1 全称；插件无 outputSchema，子会话作答走最终文本）；畸形 exec 与异常 fail-open 透传；scope 仅本插件登记的顾问子会话，外来审核类子会话不纳入（其合法用工具，classifier 不复用于执行面防误伤）。
- 接线 lib/index.js:548：处理器内先 `subsessionGuard.check(exec)`，命中即 deny（不再进门引擎），否则透传 `gateEngine.handlePreExecute(exec, next)`；否决计数经 `subsessionGuardStats` 入状态快照（沿 toolFaceStats 先例）。
- getCwd（lib/index.js:107）改 async 会话 cwd 解析：`observeSession(sessionId)?.header?.cwd`，缝缺失/空值/异常回退 `process.cwd()`；consultation.js callAdvisor（:597）await 解析一次，collectFileEntries（:511，调用点 :643）改经 options 传入。
- 子会话 persona 追加禁委派附加句（新导出常量 `ADVISOR_NO_DELEGATION_ADDENDUM`，consultation.js persona 装配行模板串拼接；直调 system 保持冻结原文）；决策协议 persona 同拼（gate/turn-review 子会话同受 NG-1 约束）。
- 文档：SOLUTION 咨询服务新小节「子会话执行面守卫」+ 运行时语义 bullet + 需求追溯索引 R-02-007 落点补文件；DOMAIN 登记术语「子会话执行面守卫」；RATIONALE C-034（东家裁定 + 被否方案）。

## 测试计划

- test/subsession-guard.test.js：登记命中拒绝任意工具名（subagent/list_subagent_models/bash）且 deny reason 三点式；未登记会话透传（next 可达）；畸形 exec 透传；isAdvisorSubsession 抛错 fail-open；统计累计与日志留痕。
- test/index.test.js 接线级：pre-execute 订阅处理器命中登记表即 deny、未登记进门引擎路径。
- test/consultation.test.js：getCwd 注入临时 git 仓 → repository_changes 恢复采集（不再 not-a-repository）；persona 断言更新为「冻结提示词 + 附加段」；既有 getCwd 直调路径语义保持。
- 回归：node --test 全量；pre-commit 门禁（doc lint、code lint、单测）。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
| --- | --- | --- |
| 成功 | 适用：登记表命中的顾问子会话工具调用被否决，非顾问会话不受影响 | `test/subsession-guard.test.js::R-02-007/AC-05 已登记顾问子会话内的工具调用被否决` 与 `test/subsession-guard.test.js::未登记会话与执行类子会话放行` |
| 异常 | 适用：守卫组件异常放行（fail-open），不误伤正常会话工具面 | `test/subsession-guard.test.js::isAdvisorSubsession 访问器抛错 fail-open 放行并留痕` |
| 边界配置 | 适用：缝缺失（sessionQuery 缺失）时 cwd 回落宿主 cwd（现状语义不回退） | `test/consultation.test.js::R-02-006 工作区 cwd 解析失败不阻断咨询：钩子抛错/缺失回落宿主进程 cwd（T-035 fail-open）` |
| 副作用 | 适用：门引擎计数不受影响（deny 短路不进 gate 计数）；status 快照新增字段向后兼容 | `test/index.test.js::T-035 deny 短路不进循环门计数：同签名被否决调用零咨询（审核缺口 G1 回归）`（零咨询）；`test/status.test.js::R-01-009/AC-10 状态快照呈现介入强度与收口评审计数（缺省 soft、显式 hard、计数缺省零）`（subsessionGuardStats 访问器缺失 undefined、注入后随快照呈现） |
| 安全 | 适用：NG-1 执行面恢复——委派对在顾问子会话内不可执行 | `test/subsession-guard.test.js::R-02-007/AC-05 deny-all 范围：委派对与非委派工具同否决（NG-1 全称）` 与 `test/index.test.js::T-035 接线级执行面守卫：已登记顾问子会话的工具调用在 pre-execute 被否决（NG-1 能力面）` |

## 自查清单

- 边界：exec 无 agent/无 name（根会话裸调用载体）→ sessionOf 兜底 'default' 不在登记表 → 透传；exec.name 非字符串透传；无会话标识透传（subsession-guard.test.js「畸形载体透传」）。
- 异常路径：isAdvisorSubsession 访问器抛错 fail-open 放行留痕；sessionQuery 缝缺失/observeSession 失败 → getWorkspaceCwd undefined → 回落宿主 cwd，咨询不阻断（consultation.test.js fail-open 用例断言 result.ok=true）；resolveWorkspaceCwd 非字符串返回同样回落。
- 回归影响：waterfall 第二级循环门行为不变（index.test.js 接线级：同 exec 两次不拦、阈值推进）；ADVISOR_SYSTEM_PROMPT 逐字冻结断言保持绿（pi-texts）；直调形态 system/persona 不附加附加段；status/commands 新字段在访问器缺失时不呈现（非零值虚构禁令同口径）；登记摘除后同 id 恢复门引擎路径（登记不泄漏）。

## 终态与证据

- 实现: 子会话执行面守卫 lib/subsession-guard.js（tools/pre-execute waterfall 第一级 deny-all，SUBSESSION_TOOL_DENIED 三点式 reason，fail-open 仅阳性否决）；接线 lib/index.js:240-247（守卫创建）/:373（status 合成）/:658-667（pre-execute 两级组合）；getCwd 修复 lib/index.js:107-130（getWorkspaceCwd 经 sessionQuery 读 header.cwd）与 lib/consultation.js（resolveWorkspaceCwd :592-604、callAdvisor :621 一次解析供 :632/:679 两点）；persona 附加段 lib/consultation.js:87（ADVISOR_NO_DELEGATION_ADDENDUM）与 :721（persona 模板串）；登记跳过留痕 lib/subsession.js:166-176（审核 F1）；status/commands 否决计数与渲染。
- 测试: `node --test` 341/341 全绿（新增 test/subsession-guard.test.js 7 用例；index.test.js 接线级 3 用例含 deny-不计数 G1 断言与会话工作区 cwd 接线回归；consultation.test.js persona 附加段断言 + 工作区 cwd 现场用例；status/commands 快照键与渲染断言；pi-texts 冻结断言保持绿）。独立轻量审核（subagent 34d95a11，独立上下文）实测 340/340 后补 G1 断言至 341。
- SOLUTION 对照: SOLUTION.md#咨询服务（persona 附加禁委派段 bullet）、#素材装配器（会话工作区 cwd bullet）、#门控服务（两级 waterfall + 守卫结构 bullet）、#配置与状态服务（快照键）、#运行时、并发与失败语义（子会话执行面守卫 bullet + 重入防护第三防线）、需求追溯索引 R-02-006/R-02-007 行；核对日期 2026-10-19 已核验；PRD 不动（NG-1/R-02-007 承诺既有）。
- commit: 48e769b
- review: 独立子代理 34d95a11-7973-4dee-be83-fca24dc1b914（独立上下文，先读 T-035/C-034 完成目的理解后对照代码核验六项重点），结论 blocking=0；non-blocking F1（登记静默跳过无留痕）/F2（注释常量名漂移）/F3（SOLUTION 重复行）均已修复，测试缺口 G1（deny 不进循环门计数）已补直接断言（同签名两次否决零咨询）；non-blocking 结论收口。
- 风险自评补充: 残余风险六项（登记竞态窄窗口/AC-05 字面可见性/header.cwd 联调项/插件重载失忆/降级档回落/deny-all 粒度立场）均为宿主侧或产品立场约束，已记录于 RATIONALE C-034 与审核报告，不构成回归；真机 repository_changes 披露证据待东家下次会话实测留痕。
