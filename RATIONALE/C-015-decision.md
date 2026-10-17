---
doc-type: rationale
mutation: append-only
id: C-015
owner: agent
---

# C-015 咨询超时默认 10 分钟、输出上限缺省跟随宿主模型配置（东家偏离裁决）

日期: 2026-09-30

#### 上下文
生产实测（reasoningEffort=max 的 glm-5.3-flash 顾问）advisor timeout 频发：单次咨询整体时限默认 180000ms（对齐 pi-advisor-flow 0.8.2）在深度思考型模型的 comprehensive 审阅下不够；且输出上限固定 16384，与所选模型在 dsh provider 配置中声明的 maxTokens（glm-5.3-flash = 131072）不一致。东家指令：默认超时改 10 分钟、设置界面提供覆盖项、maxTokens 与所选模型 provider 在 dsh 中的设置一致并可在设置界面覆盖。

#### 决策
① `advisor.callTimeoutMs` 默认 600000（10 分钟）——偏离 pi 0.8.2 的 180s，记入分歧账本（豁免，东家签字 = 本指令）；② `advisor.maxTokens` 改为可选——未配置时经 `llm.resolveModelInfo` 取所选模型在 provider 配置中声明的 maxTokens（info.defaultMaxTokens），模型未声明则省略请求参数交上游默认，显式配置覆盖；③ web 设置卡补两键数字输入，清空 = 回归缺省。callTimeoutMs 同时约束门内联同步等待上限，东家已知悉并接受共享上限（会话闸口确认，不增设第二配置键）。

#### 被否方案及原因
- 请求省略 maxTokens 由宿主默认填充：`llm.stream` 直调不经 prepareCall 解析链（dsh-llm `resolveCallWithInfo` 仅 prepareCall 路径生效），省略即上游 API 默认而非模型配置——与「跟随模型配置」语义不符。
- 维持固定默认 16384 与 180s：与东家指令直接冲突；180s 在 max effort 深审下实测不够。
- 显式复制模型信息数值另建解析路径：与推荐形态行为等价，复用既有 resolveModelInfo 缝（effort 门控同缝）为最小改动。

#### 影响面
R-02-001（AC-06/07/08）/ 配置与状态服务、咨询服务；web 设置卡（T-016）
