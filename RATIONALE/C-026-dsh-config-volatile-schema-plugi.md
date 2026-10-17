---
doc-type: rationale
mutation: append-only
id: C-026
owner: agent
---

# C-026 dsh 0.2.0 设置卡适配：Config 导出 + 宽松 volatile schema + plugins.row.config 挂点

日期: 2026-10-12

#### 上下文
dsh 0.2.0 将 settings 服务重构为 SettingsForms：`installSection` 移除（旧挂点 `settings.plugin.item` 全宿主 client 零引用——0.1.5 卡片消失根因），配置面改为「插件模块导出 schemastery `Config` schema + profile entry config」的 describe/update 模型。0.2.0 迁移把 `~/.dsh/settings.yaml` 改名 `settings.yaml.imported`：advisor-flow 节因当时无 Config 导出承接而导入失败，用户配置只剩于改名文件。声明 Config 后，cordis 以 `Config['~standard'].validate` 装载 entry config——schema 同时成为装载契约（T-028 一手实证）。

#### 决策
插件模块导出 `Config`，成员一律 `z.any().volatile()`（宽松形态：volatile 承担编辑面判定，零校验零默认填充）；校验单点仍在运行时解析器。entry config 读取统一经 volatile cell 解包（`.get()`）；挂点用插件管理页 keyed 槽 `plugins.row.config`（key `<包名>#<行 id>`）；持久写缝走 `settings.update` 且补丁按 schema 顶层声明键投影；live re-apply 桥接宿主 `loader/volatile-update` 事件，读时求值仅在 source 原文变化时应用。

#### 被否方案及原因
- Config 承载严格类型与默认值：schema 变成 entry config 装载校验器，坏值炸整行装载，越过解析器的 disabled-with-reason 容忍语义（T-005 回归）；默认填充会形成第二默认值真相源，双清单漂移。
- 弃自有卡片、改用宿主 describe 投影渲染：卡片被宿主 schema 表单接管，sticky 保存/未保存徽标/迁移与风险提示等既定 UX（C-024）全部丢失。
- 为 installSection 留兼容垫：0.2.0 服务已无该方法，垫只能指向死缝。
- 写缝直发完整 raw：宿主 validatePaths 拒绝 schema 外顶层键，未知键必须留在文档层（strip+mergeLayers 的 junk 保留语义），直发即保存失败。
- 读时求值无条件重应用：gateway.set 的运行时写入领先宿主 reconcile，无条件重应用会在窗口内回退卡片刚保存的配置——以 source 原文变化为应用条件。

#### 影响面
R-02-001（配置与状态服务、web 设置卡）（T-028）。
