---
doc-type: task
mutation: lifecycle
id: T-029
status: active
---

# T-029 手机端启动竞态：卡片注册与 fiber 激活解耦

风险等级: standard
状态: active

## 背景与目标

生产 3080 手机端（iOS/EdgiOS，经 TLS 代理）加载 web 界面报
「Failed to load plugins / web boot: 1 entry did not activate /
dsh-advisor-flow: failed」，且报错很快跳出，普通刷新无效。
桌面端同一构建恒正常。

根因（beacon 日志与 staging 实测闭环）：
- 插件管理页对 keyed 槽 `plugins.row.config` 的声明提交时刻，与本插件
  fiber 激活存在竞态；慢设备上声明晚于 boot 门审计。
- 经 `slots.inject('plugins.row.config', cb)` 注册：inject 等待声明会
  park 激活，fiber 在审计时仍非 ACTIVE → 被记 failed。
- 直接 `slots.register`：声明未提交时同步抛
  `slot "plugins.row.config" is not declared (a parent entry's children
  table must declare it)`，同样拖垮 fiber。

目标：卡片注册在任何声明时序下都不阻塞、不失败宿主启动；卡片可照常
渲染与保存。

## 差距评估

T-028 交付的注册路径（slots.inject 等声明）在桌面恒通过，在慢设备
时序下失败；属 T-028 收敛方案未覆盖的时序缝。缺陷修复，map 不变。

## 收敛方案

- 注册与激活解耦：apply 内直注一次。
- 声明未提交（错误文本含 `not declared`）时经 timer 短轮询重试，
  50 × 200ms 上限。
- 重试耗尽或其他注册错误仅降级告警，不上抛。
- client inject 增声明 `timer`（重试缝）。
- 诊断插桩移除，保留降级 warn。

## 测试计划

- 新增回归：槽未声明时 apply 不抛、安排 timer 重试、声明就绪后注册成功。
- 既有挂载测试改直注断言（registrations.length === 1）。
- 全量 node --test 绿；bundle 重建核对。
- staging 浏览器复验：boot 无门错误、行详情卡片渲染、展开出完整表单。
- 生产手机端由东家复测（预期不再出现 boot 失败页）。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：声明先行时直注即成功 | `test/client-bundle.test.js::R-02-001/AC-01 T-028 挂载：工厂执行后 apply 在 plugins.row.config keyed 槽注册行配置卡` |
| 异常 | 适用：声明未提交时重试而非失败 | `test/client-bundle.test.js::R-02-001/AC-01 槽未声明时注册重试且不阻塞激活（手机端竞态回归）` |
| 边界配置 | 适用：重试耗尽仅降级 | `lib/client/index.js::retryOrDegrade` |
| 副作用 | 适用：激活不再依赖声明时序，服务缺失仍降级 | `test/index.test.js::R-02-001/AC-01 entry 就绪时序无关：装载时 entry 为空、宿主后写入——读时求值使 engine/get 读到就绪值` |
| 兼容性 | 适用：timer 缝为宿主根服务，bundle 仍为经典脚本 | `test/client-bundle.test.js::client bundle 是经典脚本（closure-factory CJS），无裸 ESM` |

## 终态与证据

（待填）
