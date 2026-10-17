---
doc-type: rationale
mutation: append-only
id: C-029
owner: agent
---

# C-029 配置卡挂点改接宿主 configForms 管线（废弃 C-026 的 plugins.row.config 挂点）

日期: 2026-10-13

#### 上下文
T-028 选用行级槽 `plugins.row.config`（key=包名#行 id）承载配置卡。生产手机端实测暴露槽声明时序竞态：经 `slots.inject` 等待声明会 park 激活、直注在声明未提交时同步抛错，慢设备上启动门审计把 fiber 判为 failed，拖垮整页加载（T-029 解耦修复只是止血）。东家指令改按标准插件（dsh-context）形态实现配置页。

#### 决策
挂点改 bundle 级槽 `plugins.bundle.config`（key=包名）；值流整体改接宿主 `configForms` 管线——读经 ConfigFormController 快照订阅、写经保存时一次 `settings.mutate`；注册整体活在 `ctx.effect` + `whileServed` 门控内，apply 帧零槽触碰。

#### 被否方案及原因
- 保留 row.config + 注册重试轮询（T-029 修复）：竞态窗口仍在，且行级挂点与宿主官方形态漂移，配置项仍可能不显示。
- 弃自绘卡、只用宿主 autoGenerate 表单：丢失 sticky 保存、未保存徽标、迁移提示等既有验收点（R-02-001/AC-09..12）。
- 卡片读走 describe RPC 直连：绕开宿主镜像的 revision/冲突管理，重复造轮子。

#### 影响面
R-02-001 / web 设置卡（T-030）
