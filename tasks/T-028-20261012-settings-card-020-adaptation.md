---
doc-type: task
mutation: lifecycle
id: T-028
---
# T-028 dsh 0.2.0 设置卡适配（Config 导出 + plugins.row.config 挂点）

风险等级: standard
状态: active
关联: R-02-001（配置与状态服务）、T-027（边界后继）、TODO.md 0.2.0 设置卡适配条目；东家 2026-10-12 会话直接指令（查证 dsh 0.2.0 新插件配置机制并适配 advisor-flow；m00002）

## 背景与目标

生产 dsh 升级 0.2.0-rc.2 后设置卡消失。两处根因（宿主源码实证）：

1. **client 挂点退役**：卡片注册进 slot `settings.plugin.item`（`lib/client/index.js:61-66`），该槽在 0.2.0 全宿主 client 包零引用；0.2.0 插件设置唯一 GUI 面为插件管理页（plugin manager），bundle 行配置槽为 keyed slot `plugins.row.config`（key = `<包名>#<patch 行 id>`，dsh-cordis-client-runner/lib/client.js 契约目录）。
2. **settings 服务模型重构**：0.2.0 SettingsForms 移除 `installSection`；describe/update 由「插件模块导出 schemastery `Config` schema + entry config volatile cell」驱动（`dsh-settings/lib/index.js:538` schema 读 `entry.fiber.runtime.Config`）。无 Config 导出 → describe 不服务本 ns、update 抛 `No configurable plugin entry`——0.2.0 迁移把 `~/.dsh/settings.yaml` rename 为 `.imported` 后逐节 `update()` 导入，advisor-flow 节因此导入失败，现仅存于 `settings.yaml.imported`。

目标：恢复设置卡（插件管理页 advisor-flow 行 → 配置卡），恢复卡片经 settings.update 的持久写缝，live re-apply 适配 volatile cell 读取。

东家决策（2026-10-12 会话）：按方案执行；生产 profile 迁移不授权——旧值迁移由东家经新设置卡手填，本 task 不写 `~/.dsh/profiles/web/`。

## 差距评估

- **Config 导出缺失**：`lib/index.js` 无 `Config` 导出。cordis Loader 取 `plugin.Config` 记入 `runtime.Config`（cordis/lib/index.js:1631-1633），`~standard.validate` = `Schema.resolve` → entry config resolve 成 volatile cell + default 填充（实测演练验证：未知键透传、volatile 成员 cell 化、default 填充）。default export 形态下 Config 须同时挂在 default 对象（unwrapExports default 优先）。
- **schema 未标 volatile**：`AdvisorFlowConfigSchema` 顶层键均未 `.volatile()`——volatileForm 无字段 → describe 不服务、write 抛 `has no volatile fields`。方案：每个顶层键 `.volatile()`（与全部已发布参照插件一致的 per-field 约定；root-volatile 形态不需要）。
- **挂点**：`plugins.item` 明示 OCCUPIED by official settings pages，且文档指明 bundle 配置归 `plugins.bundle.config` / `plugins.row.config`——本插件配置属 patch 行（advisor-flow 行），取 `plugins.row.config`，key `dsh-advisor-flow#advisor-flow`；ownerProps `PluginConfigViewProps {view:'summary'|'page', form?}`。
- **cell 解包**：apply 收到的 entryConfig 现含 cell（cosmokit createVolatile：frozen `{get,[write]}`，非透传 proxy）——读值必须 `.get()`；识别符号 `Symbol.for("cosmokit.volatile.write")`（cosmokit/lib/index.js:83，全局注册表无需 import）。
- **live re-apply 事件**：0.1.5 onChange 由 installSection 承载；0.2.0 宿主 `_commitVolatile` 在 ref 热更新后对本 fiber emit `loader/volatile-update`——插件侧监听该事件触发 applyFromSource。
- **写缝校验**：`settings.update(ns, patch)` → write 内 validatePaths 拒绝补丁中任何 schema 外叶子（`Config field "x.y" is not volatile`，含未知嵌套键）；但 `projectForm` 先投影已知键、`mergeLayers` 保留未提交键——写缝侧须先按 schema 投影过滤未知键，junk 键留文档不进补丁（T-005 junk 保留语义不破坏）。
- **client bundle**：`lib/client.js` 为构建产物，改 client 源后按 30-client-bundle-fresh 门禁重建。

## 收敛方案

1. `lib/settings.js`：schema 每顶层键 `.volatile()`；`installAdvisorFlowSettings` 重写——去 `ctx.inject(['settings'])` 与 installSection 分支（0.2.0 死代码），保留 source/onChange 返回面，挂 `ctx.on('loader/volatile-update')` 触发 notify；source 每调用经新原语 `unwrapVolatileConfig` 解包 cell；新增 `projectSchemaKeys(schema, value)`（按 schema 投影：object 节点只保留声明键、其余节点整值透传——镜像宿主 projectForm）。
2. `lib/index.js`：静态 import settings.js（schemastery 有 devDep，单测环境可解析）。
   - 模块导出 `Config = AdvisorFlowConfigSchema` 并挂进 default export。
   - `rawConfig` 初始化与 applyFromSource 的 source 读取统一经 unwrapVolatileConfig。
   - settings 桥拆分：桥安装（事件监听+source）脱离 settings 条件子上下文直接执行。
   - `whenServiceAvailable('settings')` 只接写缝（update(ns, projectSchemaKeys(...))）。
   - `degradations.settingsSection` 语义重定：正常态不再出现（describe 由宿主自证）。
   - 标注保留但仅承载「桥装配意外失败」防御标注（reason 为 bridge-install-failed）。
   - 依据：装配在 apply 主路径同步执行，抛错向上传播会炸行装载；吞掉并标注更符合既有降级面纪律。
   - 此为实施期决策，与方案初稿「移除」有偏差。
3. `lib/client/index.js`：挂点改 `plugins.row.config`（key `dsh-advisor-flow#advisor-flow`，plain 回调形态）；AdvisorFlowCard 接 ownerProps，`view:'summary'` 渲染一行摘要、`view:'page'` 渲染全卡（既有 renderSettingsCard 路径不变）。
4. `package.json`：`dsh.compat.seams` 更新（settings.installSection → settings.update volatile 写缝 + plugins.row.config 槽 + loader/volatile-update）。
5. 单测：新增 unwrap/project 原语用例 + Config 导出断言；既有套件全绿。
6. staging 实测（dsh-activity-pane/.staging，0.2.0-rc.2，端口 3086）：link 安装本分支 → 浏览器实测设置卡出现、读写、持久化落 profile patch、live re-apply。

## 测试计划

- 单元：`node --test "test/**/*.test.js"` 全绿。
- 单元：新增用例锚定本 task——cell 解包、schema 投影、Config 导出存在性。
- 集成（staging 实测判据，浏览器实测逐项记录）：
  - 插件管理页 dsh-advisor-flow 行出现 Configure 控件。
  - 配置卡打开、get 返回 entry 真实值。
  - 修改保存 → `~/.dsh/profiles/web/cordis.patch.yml` 出现对应值。
  - 保存后运行时 live 生效（/advisor status 反映）。
  - 会话正常回合无回归。
- 回归：settings.yaml.imported 的 advisor-flow 旧值不自动迁移（东家手填）；gateway/typert 面行为不变（卡片传输通道不换）。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
| --- | --- | --- |
| 成功 | 适用：适配目标即卡片挂载、读写与持久写缝可用 | `test/client-bundle.test.js::R-02-001/AC-01 T-028 挂载：工厂执行后 apply 在 plugins.row.config keyed 槽注册行配置卡`、`test/index.test.js::R-02-001/AC-01 持久写缝可得时：保存经 settings.update 写回 advisor-flow 命名空间` |
| 异常 | 适用：settings 服务缺失与写失败降级路径须保持 | `test/index.test.js::R-02-001/AC-01 settings 服务缺失时桥仍装配：source 即 entry，写缝降级标注（0.2.0 无需注册动作，T-028）`、`test/index.test.js::R-02-001/AC-01 持久写缝缺失：degradations.persistence 标注且不虚报日志（服务缺失≠确认失败）` |
| 边界配置 | 适用：未知键/空对象 entry config 不炸装载是 resolveConfig 硬契约 | `test/settings.test.js::R-02-001/AC-02 Config schema resolve（0.2.0 装载契约）：零校验零填充、未知键透传、声明键整值 cell 化`、`test/settings.test.js::R-02-001/AC-01 unwrapVolatileConfig：cell 递归解包、顶层 undefined 丢弃、非 record 原样返回` |
| 副作用 | 适用：junk 键保留语义与 gateway 面不变须证明 | `test/index.test.js::R-02-001/AC-01 持久写缝可得时：保存经 settings.update 写回 advisor-flow 命名空间`（含写缝投影与 junk 顶层键留文档断言）、`test/index.test.js::R-02-001/AC-03 启动配置被拒时 raw 保留真实键：卡片可读回并修复，保存不丢键` |
| 兼容性 | 适用：0.2.0-rc.2 挂点/写缝契约为本 task 主体 | `tasks/T-028-20261012-settings-card-020-adaptation.md#差距评估`、`test/settings.test.js::R-02-001/AC-02 Config schema resolve（0.2.0 装载契约）：零校验零填充、未知键透传、声明键整值 cell 化` |

## 终态与证据

（待填）
