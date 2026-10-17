---
doc-type: rationale
mutation: append-only
id: C-020
owner: agent
---

# C-020 顾问咨询以 one-shot 子会话呈现：llm.stream 直调降级保留

日期: 2026-10-09

#### 上下文
东家实测反馈：咨询经 `llm.stream` 进程内直调，dsh web GUI 会话树中无任何条目，咨询发起、进行与完成对会话主不可见；对照宿主 subagent 机制（子会话条目出现于会话树）产生可见性落差。评估确认需求层原无子会话承诺（NG-8 将 pi TUI 专属交互面豁免），属新需求而非缺陷。宿主存在公开缝 `ctx.subagents.start(name, request)`（one-shot 委托：label、prompt、parent、signal、agentOptions 路由覆盖、toolFilter 工具约束），可承载无工具顾问子会话；东家裁决走全链新增 R-02-007，呈现范围三入口统一（工具/手动/门），形态 one-shot。

#### 决策
`presentation` 默认 `subagent`：咨询经 `subagents.start` 以 one-shot 顾问子会话发起——素材仍由插件装配（R-02-006 契约不变，prompt 载荷），顾问路由经 `agentOptions` 覆盖，`toolFilter={allow:[]}` 零工具维持 NG-1，协议提示经子会话 persona 承载；结算意见取自 `SubagentResult.output`，送达通道不变。呈现提供方经已注册名单解析，缝缺失或发布前失败降级 `direct`（llm.stream 直调）并显性化；发布后的 run 失败映射诊断码、不降级重发。

#### 被否方案及原因
- 维持纯直调：东家可见性诉求落空，评估后明示不满足，无保留理由。
- continuable 子会话留存：会话树条目随咨询次数无限累积，需另配清理策略，复杂度先于真实需求；意见经工具返回值与 steer 送达后已落入父会话日志，回看诉求的主体不依赖子会话留存。
- 仅 tool/manual 子会话化、门审保持直调：可见性语义分叉，门审恰是关键决策时刻，可见价值最高，分叉无收益。
- Scout 一并子会话化：Scout 是内部策展（默认关闭），非用户面，徒增会话树噪音。

#### 影响面
R-02-007 / 咨询服务（T-019）。NG-8 括注同步演进（可见性承载新增子会话呈现）。残余风险：one-shot 结算后子会话条目的宿主留存行为未实测，staging 实弹为 go/no-go 检查点，若东家需条目级回看再升级 continuable 或台账存 transcript；用量双轨（宿主 meter 与插件台账）取数缝存在性实现首日验证，系统性不可得时台账按 unavailable 呈现。
