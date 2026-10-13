---
doc-type: todo
mutation: inbox
owner: 双方
---

# TODO — 想法收集箱

## 条目

- [缺陷线索] 隔离演示环境中 /advisor-manual 悬置：startManual 后 60s 无顾问 LLM 请求、子会话未发布（工具咨询同环境正常；parent=invocation?.agent 与工具路径的 agent 形态差异是头号嫌疑；宿主 advisor 日志零痕迹，2026-10-10 截图环境实测；live 环境日常使用正常，是否环境特异待甄别）
- [缺陷线索] SOLUTION.md#产品契约 命令面漏记 `/advisor cancel` 子命令（实现 lib/commands.js:55 存在、README 已列、契约只记 on|off|toggle|status|gates——T-025 双轴审核发现，属契约漏记需东家确认后补记）

- [维护想法] 联调深项持续观察（T-005 清单遗留）：条件子上下文热重启边界、双缝执行标识共享性、setSource/onChange 宿主时序、tools 升级必选裁决——日常使用异常时按 T-005 清单排查

- [维护想法] render.js 新旧 CSS 类名并存（advisorflow_* 新体系 + advisor-flow-gate/notice 旧语义钩子）——旧类无消费方后清理
- [维护想法] card-state unwrap 对 ok:true 但 value 非 record/array 判失败属过严校验——未来契约扩展（返回数组/标量的端点）时放宽

- [维护想法] 设置卡 hint 文案与实现语义无机械锚点（T-007 评审靠人工对照 gates/context 发现循环门句式错误）——文案漂移时静默风险，可做文案↔实现锚点测试
- [维护想法] 设置卡 CSS 两点无测试断言且真机目验证据无仓库内载体（T-007 评审残余：legend 14px 层级、footer margin-top 12px）

- [维护想法] card-state 测试同时直断自身输出，解除对 test/gateway 宿主实现桩的耦合（gateway 测试桩重构不应静默改变卡片测试的验证对象）

- [维护想法] dsh-tui 专属设置界面与 `/advisor` 命令面（NG-4 排除于首版，市场需求再现时升级）
- [缺陷线索] dsh 全局未注册 kimi-coding provider 路由，而 pi 侧 advisor 用 kimi-coding/k3-256k——移植版默认 advisor 路由待定（曾实测 NO_ADAPTER）
- [缺陷线索] 咨询素材装配缺口：默认隐私档位下顾问仅收到问题文本，无会话历史/工作摘要（staging 第三轮实测：收口评审时顾问报「无可评审素材」）；SOLUTION 会话观察模块声称维护转写增量但实现未投喂——是否立项补齐（涉及隐私档位与素材装配语义）待裁决（T-009 终态登记）
- [维护想法] 向 dsh-advisor（omdsh-dev）上游提 maxTokens/timeout 配置化 issue；本机 node_modules 补丁在插件更新时会被覆盖
- [需求候选] 意见采纳结果回写（record_advisor_outcome 对应物）与 outcome 统计（pi 侧默认关闭，移植版是否跟进待定）
- [安全想法] 顾问输出的隔离检疫（当前设计信任顾问文本原样送达；pi 亦无，roadmap 项）
- [维护想法] T-011 独立审核覆盖缺口回补钩子：窄分片审核（observer/gates/commands/config 四文件）在 task 关闭时仍在途——若其回报行为偏差，作为 T-012/013 审核输入处置；若不能交付，按 adv-14 记为持久残留风险进入总终报（T-011 终态 review 证据「复审结论」栏已明示三分式覆盖）
- [维护想法] getCwd 会话工作区缝（东家裁决记档，2026-09-25）：当前为宿主进程 cwd，多会话多仓库场景的会话级工作区解析待联调核定（T-012 终态残余风险；宿主侧会话→workdir 缝形态待实证）
- [维护想法] tool-result-cap 默认行数 200（东家裁决记档）：pi 宿主常量 PI_DEFAULT_MAX_LINES 不可从制品提取，待联调对照核定（字节 8192 已与 config 对齐）
- [维护想法] 与 pi 0.8.2 的同输入差分对照未做（宿主形态不同，等价性由逐字移植 + 锚定 AC 承载）；可用 staging 差分探针补强
- [需求候选] 失败/blocked 分流处置：「门审基础设施故障」（解析失败/超时/预算耗尽）与「advisor 实质拦截」（blocked 裁决）目前共用同一 failureMode 档位——是否分流出不同处置（如故障降级、裁决升级）待裁决（默认值已定 block-tool 并记 C-017，本条为剩余的语义分档待议项）
- [维护想法] 清理 map 存量风格 warning（68 条，agentmap lint 全量扫描常驻打印；涉及 PRD/SOLUTION/DOMAIN/TODO，逐条拆分列表或改写收敛；2026-10-08 bootstrap 升级后登记）
- [维护想法] skill 单元测试未在 Python 3.7.9 兼容下限实跑（本机仅 3.12；agentmap hook 工具声称 3.7.9+ 标准库兼容，静态核查无 3.8+ 语法，动态验证缺口待补；2026-10-08 bootstrap 升级时登记）
- [维护想法] 证据指针修复的语义后继校验增强：替换后的提交正文应引用对应 task 的 T-ID（git cat-file 可机械判定，成本低）——收窄「悬空哈希可被替换为任意可达提交」的反查链降级面（C-019 复审建议登记）
- [维护想法] 语义边界观察：收口评审豁免判定（T-023/C-023）的承重假设是「实质执行由主会话承担」——未来若实质执行移入 continuable 子会话（父会话只剩编排），DOMAIN 执行者定义与评审对象不变量须重审
- [缺陷线索] loop gate 干预循环：非反应执行者（重复同一工具调用且不响应建议）+ 空预算时，门「检测→咨询→steer→放行重计数」可无限循环（0.2.0 审计环境实测 1029 次干预/单会话；0.1.5 逻辑相同、从未共测）——候选处置：每会话干预数上限/冷却/预算默认值；生产建议先配 budget 非空（T-027 残余风险登记）
- [缺陷线索] 门咨询 caller 中止极性偏离对齐基线：pi 为拦截当次调用，port 按 failureMode 处置（warn-and-continue 下放行）——是否对齐待东家裁决
- [缺陷线索] 设置卡「会话历史档位」下拉写 privacy.history，但服务端键表（lib/config.js PRIVACY_FIELDS）无此键：按未知键告警透传、运行时无任何消费方（grep 佐证）——控件承诺了不存在的效果（选 off 并不改变咨询行为；T-031 E2E 顺带发现，pi 侧旧键，SOLUTION 记为旧键迁移但卡片仍以活控件呈现）——候选处置：卡片改迁移提示或按 pi 语义在素材装配补齐消费方
