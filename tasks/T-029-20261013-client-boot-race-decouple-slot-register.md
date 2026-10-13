---
doc-type: task
mutation: lifecycle
id: T-029
status: completed
---

# T-029 手机端启动竞态：卡片注册与 fiber 激活解耦

风险等级: standard
状态: completed

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
| 边界配置 | 适用：重试耗尽仅降级 | `test/client-bundle.test.js::R-02-001/AC-01 非时序注册错误降级告警且不重试不阻塞激活` |
| 副作用 | 适用：激活不再依赖声明时序，服务缺失仍降级 | `test/index.test.js::R-02-001/AC-01 entry 就绪时序无关：装载时 entry 为空、宿主后写入——读时求值使 engine/get 读到就绪值` |
| 兼容性 | 适用：timer 缝为宿主根服务，bundle 仍为经典脚本 | `test/client-bundle.test.js::client bundle 是经典脚本（closure-factory CJS），无裸 ESM` |

## 终态与证据

- 实现: 注册与激活解耦落地（lib/client/index.js：apply 内直注 `plugins.row.config` keyed 槽；错误文本含 `not declared` 时经 timer 短轮询重试，50 × 200ms 上限；重试耗尽或非时序错误仅降级告警不上抛；client inject 增声明 `timer`；诊断插桩移除；apply/applyInner 空包装合并）。lib/client.js 同步重建（30-client-bundle-fresh 核对）。
- 测试: 全量 node --test 319 过 0 失败（门禁 executed=318=账本 baselineExecuted）；新增回归「R-02-001/AC-01 槽未声明时注册重试且不阻塞激活（手机端竞态回归）」与「R-02-001/AC-01 非时序注册错误降级告警且不重试不阻塞激活」；staging（t028-home，0.2.0-rc.2）复验 boot 无门错误、行详情卡片完整渲染（截图 .staging/t028-*.png，probe 脚本已清理）。生产手机端由东家复测，预期 boot 失败页不再出现。
- SOLUTION 对照: 客户端模块（web 设置卡）职责补注册时序纪律——直注优先、声明竞态短轮询重试、降级不阻塞 boot；缺陷修复，PRD/SOLUTION 目标态不变（map 不变）。
- review:
    - 审核方: 双轴独立子代理（code-review skill；Spec 轴 3e00c73b、Standards 轴 1513e12c）
    - 目的理解: 消除手机端槽声明竞态对 fiber 激活的阻塞；预期行为=任何声明时序下激活完成、卡片可渲染或可降级、宿主 boot 不受累；约束=短路缺陷修复（map 不变）、零宿主补丁、经典脚本契约
    - 执行方式: code-review skill 双轴并行（Spec=方案兑现，Standards=规范与账本）；R1 主范围 538d3c0（基线 f05e24a）、R2 delta 538d3c0..433020d
    - 问题与修复: R1 Standards 硬违规 1 条（降级分支无测试、矩阵证据为代码指针）+ Spec 轻微项 3 条（重试 49 次口径、apply/applyInner 空包装、thenable 兜底归属存疑）→ 433020d 修复（包装合并、降级回归例、矩阵证据改测试名、取舍入提交正文）；R2 双轴 delta 复审通过
    - 复审结论: 双轴 delta 复审通过，无阻塞发现；残余风险记账如下
- commit: 538d3c0
- commit: 433020d
- 残余风险与已知缺口:
    - 重试耗尽支路（50 次上限）无直接断言；现有降级例覆盖同 warn 分支的非时序析取，矩阵边界行措辞已改为「同一降级支路」表述。
    - register thenable 兜底分支的现场归因不确定：10:32 beacon 诊断串（row.config register resolved）未进入本仓库任何提交（git log -S 为空），诊断构建不可考据；保留依据是宿主版本漂移防御，两条路径均有测试。
    - 宿主 `not declared` 文案甄别无版本锚；宿主改写文案即退化为仅降级告警（卡片缺位，不阻塞 boot）。
    - 热重载交错的 keyed 重复占位错（`already has an entry`）不重试，卡片缺位至整页刷新。

## staging 与生产验证

- staging（t028-home，dsh 0.2.0-rc.2）：boot 无门错误、行详情卡片完整渲染（修复后复验截图见 .staging/t028-*.png，probe 脚本已清理）。
- 生产手机端：修复经 link 安装直供生产 3080（生产 profile 未写入配置值，值迁移由东家手填）；东家手机复测确认后本 task 闭环。
