---
doc-type: task
id: T-038
created: 2026-10-24
mutation: lifecycle
---

# T-038 按需与手动双顾问并行咨询

风险等级: major
风险面: 契约、对外接口、并发与用量核算
状态: active
实证验收: 是
总时间预算: 120 分钟（含主会话组织、执行、返工、验收与保存；token 预算未知，缓存与上下文占用单列，不作估算）

## 背景与目标

- 东家批准 `/root/codex-ops/headroom/.scratch/dsh-tui-dual-advisor/spec.md`，授权改造插件并提交 PR；决策记 C-036。
- 新增可选 `secondaryAdvisor`，使 `ask_advisor` 与 `/advisor-manual` 一次并行咨询主、副顾问；旧 `advisor` 单顾问配置与返回行为保持兼容。
- 自动门与收口评审只走主顾问；不做第三次汇总、权重、自动选路，不改 DSH 主程序，不合并 PR、不发布 npm。

## 差距评估

- 当前配置、引擎、工具结果、手动送达与用量台账均假设单顾问；PRD NG-5 原排除全部多顾问，已由 C-036 按东家授权收窄。
- 基线 `npm ci --allow-remote=all && npm test`：346/346 通过。本机 npm `allow-remote=none`，仅命令级显式允许，不改全局 npm 配置。
- K2.8 Preview 已加入 Kimi Code subagent 可选池；Herdr client/server 可用，真实验收尚未开始。

## 收敛方案

- 配置：复用主顾问字段解析 `secondaryAdvisor`；缺省不启用双发，半配、非法值或与主顾问同路由拒绝；primary 派生启用规则不变。
- 引擎：批次只装配一次素材，两家并行接收完全相同的 outbound；各自 deadline、模型能力解析、子会话句柄、adviceId、history 与 usage；批次 UUID 关联结果。
- 结果：至少一家成功即保留全部独立结果；一家失败显式标记，两家均失败返回既有非阻断失败形态；成功意见不做自动汇总。
- 计数：一个批次消耗一个既有预算和队列槽；两家实际 token、耗时、成本分别记录并提供批次合计。
- 兼容：`gate` 与 `turn-review` 恒为主顾问单发；无 `secondaryAdvisor` 时工具 value 和渲染保持原契约。
- 界面：工具按模型分块渲染，手动按顾问分别 steer；设置卡增加副顾问路由与可选调用参数，重建 client bundle。
- 文档：同步 PRD、SOLUTION、DOMAIN、README 与迁移说明；真实验收回执冻结于 `receipts/T-038-dual-advisor-consultation.md`。

## 测试计划

- 先写失败测试，再实现：并行与相同 outbound、批次/意见 UUID、意见冲突不汇总、部分失败、双失败、旧配置、自动入口单发、预算计数。
- 工具 schema/render 与手动分别送达、取消双在飞；配置、设置持久化、状态、用量分项与批次合计；client 源码及 bundle 新鲜度。
- 全量 `npm test`、`npm run build:client`、`.githooks/pre-push`；独立 major 双轴代码审核并复审 blocking findings。
- Herdr 操作 dsh-tui 真实完成双顾问调用与一家超时，保存可核证据；外部服务或凭据受阻按合同停报，不伪造。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
| --- | --- | --- |
| 成功 | 适用：两家并行收到相同素材，独立批次与意见标识、分别展示 | `test/consultation.test.js::R-01-010/AC-02、AC-03 双顾问批次：素材只装配一次，两家并行收到字节级相同 outbound；批次 UUID 与独立意见 UUID 按主副顺序分列` |
| 异常 | 适用：一家失败/超时保留另一家，两家失败不阻断主循环 | `test/consultation.test.js::R-01-010/AC-04 一家超时另一家保留：超时方标记 ADVISOR_TIMEOUT，独立 deadline 各自结算`；`test/consultation.test.js::R-01-010/AC-04 两家均失败保持 {ok:false,code,reason} 非阻断：原因可诊断且主循环继续` |
| 边界配置 | 适用：旧配置兼容、半配/同路由拒绝、自动入口不双发 | `test/config.test.js::R-01-010/AC-07 secondaryAdvisor 半配、同路由、非法值与非对象形态拒绝且原因可诊断；合法配置字段齐备解析`；`test/gates.test.js::R-01-010/AC-06 配置副顾问时循环门仍只触发主顾问单发（引擎集成：一次评审仅一次主路由调用）` |
| 副作用 | 适用：预算只计一批次；手动取消两家；无第三次调用 | `test/consultation.test.js::R-01-010/AC-05 一个批次只消耗一个既有预算额度；批次在队列中只占一个槽位`；`test/commands.test.js::R-01-010/AC-08 手动双顾问取消：收束两家在飞调用、无用量副作用、状态收敛` |
| 安全 | 适用：两家 outbound 一致且不扩大隐私权限 | `test/consultation.test.js::R-01-010/AC-09 双顾问素材沿用既有隐私分级与脱敏管线，不扩大披露；相同字节外发` |
| 兼容性 | 适用：旧工具 value/render、旧用量 JSONL、旧设置迁移可读 | `test/ask-advisor.test.js::R-01-010/AC-01、AC-03 配置副顾问时工具 value 为 {ok:true,batchId,results}；未配置时旧 value 契约逐字不变`；`test/config.test.js::R-01-010/AC-01 未配置副顾问（含双空段）时旧单顾问配置、派生启用与返回行为不变` |
| 可观测性 | 适用：按顾问 token/耗时/成本及批次合计、失败标记 | `test/usage.test.js::R-01-010/AC-05 台账记录携带 batchId/model/durationMs；批次合计按 batchId 聚合，缺项 unavailable 而非零`；`test/commands.test.js::R-01-010/AC-05 status 呈现副顾问路由与批次合计用量（按顾问分列 + batchId 合计）` |
| 实证 | 适用：真实 dsh-tui 双答与一家超时不能由单元测试替代 | `receipts/T-038-dual-advisor-consultation.md::T-038-真实验收` |

## 自查清单

- 边界：无 secondary 完全走旧路径；secondary 半配/同路由显式拒绝；gate/turn-review 不双发；批次只耗一个额度。
- 异常路径：一家超时、失败或空回复不丢另一家；两家失败不抛异常；取消/销毁收束两个句柄且不降级重发。
- 回归影响：pi 冻结文案不变；素材只装配一次且不扩大披露；旧工具 value、旧配置与 JSONL 可读；client bundle 与源码同步。

## 终态与证据

- 实现: 可选 secondaryAdvisor；tool/manual 双发；批次并行/独立结果/分别用量/批次合计；legacy 与自动入口单发；设置卡与迁移文档同步；生产接线字符串失败通告修复。
- 测试: 基线 346/346；主会话复跑 378/378；client bundle 重建、git diff --check、AgentMap lint（仅存量警告）通过；Herdr 双答与一家超时 PASS（receipts/T-038-dual-advisor-consultation.md）。
- SOLUTION 对照: R-01-010 的产品契约、咨询服务、配置与状态服务、工具/命令/设置卡及运行时语义已对照实现；核对日期 2026-10-24。
- commit: 实现提交后登记；设置卡浏览器未验证（receipts/T-038-browser-settings.md），task 保持 active。
- review: Standards agent-2 PASS；Spec agent-3 PASS（blocking 修复后复审）。
- 审核方: 独立 K2.8 子代理 agent-2（Standards）与 agent-3（Spec），均非实现上下文。
- 目的理解: secondaryAdvisor 仅 tool/manual 双顾问并行，相同素材、独立展示/记账、部分可用；legacy 与 gate/turn-review 单发不变。
- 执行方式: code-review skill；基线 b1a71e1 至 working tree；两轴独立审核并对真实调用点核验。
- 问题与修复: 手动失败字符串被生产 delivery 回调静默丢弃；lib/index.js 增加字符串 steer 分支，test/index.test.js 增加三例生产 wiring 测试；task 实证引用按 lint 修正。
- 复审结论: 两轴 PASS；残余为设置卡浏览器未验证与 non-blocking 重复渲染/装配失败活动记录建议，不构成 blocking。
