---
id: T-030
doc-type: task
created: 2026-10-13
mutation: lifecycle
---
# T-030 web 卡改接宿主 configForms 管线（dsh-context 同构）

风险等级: standard
状态: active

## 背景与目标

- 东家指令（m03293）：advisor-flow 插件页选中后无配置项、且插件曾导致 dsh 页面无法加载；要求先修加载失败，再参照 dsh-context 等插件实现配置页，staging 桌面+移动双端浏览器验证后汇报。
- 前序事实（T-028/T-029）：设置卡曾挂 `plugins.row.config` 行级槽；手机端暴露槽声明竞态——`plugins.row.config` 声明由插件管理页 bundle 提交，晚于 boot 门审计时 apply 帧内注册（同步抛或 inject 等待 park 激活）导致 fiber 被判 failed、整页「1 entry did not activate」。
- 参考（dsh-context 0.69.1 客户端反编译解读）：卡片值流走宿主 `configForms` 服务——`configForms.get(ns)` 返回 ConfigFormController（describe 镜像驱动、revision 栅栏），读经快照订阅、写经 `controller.mutate/set`（宿主 `settings.mutate` 通道）；挂点 keyed 槽 `plugins.bundle.config`（key=包名），注册门控 `whileServed([ns], register)`。

## 差距评估

- 挂点差距：现实现挂 `plugins.row.config`（行详情页），dsh-context 范式挂 `plugins.bundle.config`（bundle 详情页）；且 `plugins.row.config` 声明时序不可控（T-029）。
- 值流差距：卡片读写走自有 gateway RPC（`advisor-flow/get|set`），不经宿主 describe 镜像——revision 栅栏、恢复、writable 判定自建；宿主正规客户端管线（configForms + settings.mutate）才是 0.2.0 官方形态。
- 页面加载失败差距：T-029 的注册解耦已消除槽竞态对 boot 的影响；生产手机端最终失败另涉宿主 combo rev 冻结+immutable 缓存（宿主侧事项，非本插件可修）。

## 收敛方案

- 挂点换轨：`plugins.row.config` 退役，挂 `plugins.bundle.config`（key=`dsh-advisor-flow`，dsh-context 同构）。
- 注册时序纪律保持：apply 同步帧零 slots 触碰；注册整体活在 `ctx.effect(() => configForms.whileServed([ns], () => ctx.slots.inject(...)))` 内。
- 值流改接（dsh-context 同构）：读经 `configForms.get('advisor-flow')` 控制器快照订阅；写经保存时一次 `form.mutate(全量脏字段 set ops)`；自有 gateway RPC 只保留模型目录两查询。
- 卡片 UX（sticky 保存、未保存徽标、门矩阵表单）保持不变；PRD 不动。
- gateway RPC `/api/advisor-flow/get|set` 保留（API 面/测试锚），web 卡不再消费 get/set。
- 服务端不动（lib/index.js、lib/settings.js、lib/config.js 的解析与 live re-apply 不变）；config.js 仅 SAVE_NOTICE_PERSISTED 文案去 settings.yaml 旧措辞。

## 测试计划

- 挂载回归（test/client-bundle.test.js）：经典脚本装载；configForms 管线 + whileServed 门控注册 `plugins.bundle.config`；configForms 缝缺失降级；whileServed 未服务不挂卡、恢复服务后注册。
- 卡片套件改接（test/client/settings-card.test.js）：控制器数据源换 configForms 快照桩（subscribe/ensure/derive），保存断言改为 `form.mutate(ops)`；保留 sticky 徽标、委托保存、键盘激活、换树、目录降级、错误恢复等全部 UX 回归。
- staging 实测（af-home 单插件 3087 + 五插件审计环境 3084）：boot 门零错误；bundle 详情页卡片渲染与展开；值流 E2E（编辑→保存→settings/mutate→profile patch 落盘）；iPhone 触屏仿真 boot 绿。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：卡片挂载/渲染/读写全链 | `test/client-bundle.test.js::R-02-001/AC-01 T-030 挂载：configForms 管线 + whileServed 门控注册 bundle 配置卡（dsh-context 同构）`、`test/client/settings-card.test.js::R-02-001/AC-01 卡片编辑经 mutate 保存成功：ops 提交、值同步、表单回显新值` |
| 异常 | 适用：宿主快照不可用/目录不可用降级 | `test/client/settings-card.test.js::R-02-003/AC-02 宿主快照不可用 → 错误显性化；恢复 ready 后 live 恢复（describe 镜像契约）` |
| 边界配置 | 适用：槽声明竞态回归与目录降级 | `test/client-bundle.test.js::R-02-001/AC-01 whileServed 未服务不挂卡、恢复服务后注册（宿主官方门控回归）` |
| 副作用 | 适用：保存一次批量提交且落盘回执显性化 | `test/client/settings-card.test.js::R-02-001/AC-01 保存成功回执：宿主持久化形态（mutate 通道单一回执）` |
| 兼容性 | 适用：bundle 以经典脚本装载、boot 门零失败（桌面+移动仿真 staging 实测，见终态记录） | `test/client-bundle.test.js::client bundle 是经典脚本（closure-factory CJS），无裸 ESM` |

## 终态与证据

（待填）
