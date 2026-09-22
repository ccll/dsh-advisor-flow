---
doc-type: todo
mutation: inbox
owner: 双方
---

# TODO — 想法收集箱

## 条目

- [维护想法] card-state 测试同时直断自身输出，解除对 test/gateway 宿主实现桩的耦合（gateway 测试桩重构不应静默改变卡片测试的验证对象）

- [维护想法] dsh-tui 专属设置界面与 `/advisor` 命令面（NG-4 排除于首版，市场需求再现时升级）
- [缺陷线索] dsh 全局未注册 kimi-coding provider 路由，而 pi 侧 advisor 用 kimi-coding/k3-256k——移植版默认 advisor 路由待定（曾实测 NO_ADAPTER）
- [维护想法] 向 dsh-advisor（omdsh-dev）上游提 maxTokens/timeout 配置化 issue；本机 node_modules 补丁在插件更新时会被覆盖
- [需求候选] 意见采纳结果回写（record_advisor_outcome 对应物）与 outcome 统计（pi 侧默认关闭，移植版是否跟进待定）
- [安全想法] 顾问输出的隔离检疫（当前设计信任顾问文本原样送达；pi 亦无，roadmap 项）
