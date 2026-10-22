---
doc-type: task
id: T-036
created: 2026-10-22
mutation: lifecycle
---

# T-036 审核类子会话豁免事件形状根因修复（T-094 案例）

风险等级: major
风险面: 对外接口（分类器缝与纯函数签名变更——插件内单消费点，无对外契约）
状态: active

## 背景与目标

- 东家报告（2026-10-21）：T-094 轻量独立代码评审（评审类子会话）调用 ask_advisor 未被豁免——豁免自 T-026 落库以来结构性从未生效；全库 3442 份会话日志零条真实 SESSION_EXEMPT 拒绝，部署后 ≥13 例评审类子会话咨询全部放行。
- 根因：事件形状偏斜，双上下文复核一致。
  - lib/reviewer-classifier.js:35 自证源 `events.find(type === 'session')` 假设持久化文件形状——首行 header 事件在流内。
- 生产 sessionQuery 租约（dsh-session-query live()）形状为 `{source, header, get events(){...}}`：header 是租约独立属性，事件流为裸 log 切片，不含自证事件。
- 后果：自证前置恒不成立 → 豁免恒 false 且零日志（结构性恒死）；判定 false 落缓存，会话内不可自愈。
- 测试全绿根因：test/helpers.js:204-219 夹具把 header 塞进 events（seq0）且 descriptor seq6——宿主 seq===index 校验下不可能的布局；实验假阳性同理（/tmp/t094.jsonl 全行含自证首行）。
- 约束：宿主事件流不得回填合成 `type:'session'` 事件——lib/conversation-source.js:117 reconstructSurface fail-closed 对未知类型抛错，且自证事件会泄进顾问提示词。
- 目标：分类器改吃租约真实形状，恢复 R-01-009/AC-11 豁免承诺；激活期金丝雀防同类回归。

## 差距评估

- 修复前差距 1：自证源错挂文件形状——生产租约下豁免恒 false，承诺 R-01-009/AC-11 完全未兑现（零日志静默）。
- 修复前差距：夹具布局在宿主不可能（header 塞进 events seq0 且 descriptor seq6），测试全绿是形状假阳性。
- 修复后：纯函数与缝统一租约形状 `{events, header}`；真实 T-094 日志回归锚 + 激活期金丝雀显性化同类回归。
- 残余差距：无（R-01-009/AC-11 豁免承诺在生产形状下恢复）。

## 收敛方案

- lib/reviewer-classifier.js：`subsessionExemptFrom(lease, patterns)` 改收租约形状 `{events, header}`，自证读 `header?.origin === 'subagent'`（fork 会话 origin 缺失→不豁免，语义不变）；`createReviewerClassifier` 缝更名 `getLease`，header 缺失视为异常租约形态 info 留痕且不缓存（fail-open）。
- lib/index.js：getSessionEvents 拆为 `observeSessionLease`（返回 `{events, header}`，header 于 dispose 前取）+ `getSessionEvents` 薄包装（脉络与用量两消费点语义不变）；激活期金丝雀：合成租约样本判 false 即 `degradations.reviewerClassifier` 显性化 + warn（激活窗口诊断可见）。
- 夹具 test/helpers.js::reviewerSubsessionLease 改租约形状——header 不在 events、descriptor seq0；四个测试文件同步；旧文件形状夹具保留并转役「结构性死路防回归」专用锚。
- 回归锚：test/fixtures/reviewer-subsession-t094.json 截取 T-094 真实日志前 7 条事件；布局三要素：
  - header 独立于事件流（origin: subagent）；
  - descriptor 占 seq 0；
  - 首条 agent/inbox/spliced 在后。
  - 标识脱敏：会话 UUID、项目路径与真实提示词占位化，结构形状逐键不变（两轴审核⑥收口）。

## 测试计划

- test/reviewer-classifier.test.js：纯函数改收租约对象；真实 T-094 夹具判 true；数组形状（含自证首行）不再成立→结构性死路用例防回归。
- test/tool-guard.test.js、test/turn-review.test.js、test/index.test.js：缝桩与夹具同步租约形状；豁免/缓存/fail-open 语义保持。
- 回归：node --test 全量；pre-push 门禁。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
| --- | --- | --- |
| 成功 | 适用：评审类子会话（租约形状）豁免恢复——T-094 形状日志判 true，收口与工具面双路径生效 | `test/reviewer-classifier.test.js::T-036 回归锚：真实 T-094 生产租约形状判 true——豁免生效`；`test/index.test.js::T-023 接线级豁免：审核子会话（真实形状日志）收口不评审；缓存复用与 disposed 复位` |
| 异常 | 适用：缝缺失/租约畸形（header 缺失、events 非数组）fail-open 不缓存次轮重判，行为不变 | `test/reviewer-classifier.test.js::T-036 回归根因形态：事件流原样但 header 缺失 → false + info + 不缓存` |
| 边界配置 | 适用：主会话/fork（origin 缺失）不豁免；清单空关闭语义不变；旧数组形状不再是判定输入 | `test/reviewer-classifier.test.js::R-01-009/AC-11 纯判定：主会话与 fork（无 origin 字段）不判为子会话`；`test/reviewer-classifier.test.js::T-036 结构性死路防回归：旧文件形状（header 自证事件在流内）不再是判定输入` |
| 副作用 | 适用：引擎脉络与用量取数仍收纯事件数组；顾问提示词不混入自证事件 | `test/consultation.test.js::R-02-002 咨询完成时用量进入台账；缺失项 unavailable（引擎集成）`；`test/consultation.test.js::R-02-004 咨询素材经隐私裁剪与脱敏后发送（引擎集成，R-02-006 统一素材契约）` |
| 安全 | 适用：豁免阳性面不扩大——仅自证 + 命中放行，fail-open 方向不变 | `test/tool-guard.test.js::R-01-001/AC-09 软模式放行主会话与执行类子会话（判定面收敛，不外溢）` |

## 自查清单

- 边界：主会话与 fork（header 无 origin）不豁免——自证前置在 descriptor/prompt 匹配之前短路；空清单零日志读取直接关闭（既有语义用例钉住，复审绿）。
- 异常路径：缝缺失（observeSessionLease 返回 undefined）、畸形租约（header 缺失 / events 非数组）、读取抛错三态均 fail-open false 且不落缓存、次轮重判（含 info 留痕断言）。
- 回归影响：getSessionEvents 薄包装下脉络区与用量取数两消费点仍收纯事件数组（consultation/用量套件绿）；顾问提示词不含自证事件（conversation-source fail-closed 语义保持）；tool-guard / turn-review 既有豁免与缓存语义用例全绿。

## 终态与证据

- （关闭时填写）
