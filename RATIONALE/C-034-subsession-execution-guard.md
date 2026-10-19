---
doc-type: rationale
mutation: append-only
id: C-034
owner: agent
---

# C-034 零工具契约被宿主 own 层注入击穿，插件侧以执行面否决恢复 NG-1 实质

日期: 2026-10-19

#### 上下文
T-035 调查确认（真机实证 mailai-models 会话 2026-10-19 11:49）：宿主 spawn 任何子会话时把委派工具（`subagent`、`list_subagent_models`）注册进该子会话 own 工具层，而 dsh-tools 的 restriction 语义是「只过滤继承面（全局层与祖先层），own 层注册恒可见」——插件 NG-1 的零工具契约载体 `toolFilter={allow:[]}` 剥不掉这对工具。真机上顾问子会话据此把核验任务委派给持全量工具的子代理执行（depth2 会话真实跑了 cargo test），击穿 NG-1 与 R-02-007/AC-05。同日发现缺陷二：`getCwd=process.cwd()` 返回宿主服务进程 cwd（systemd WorkingDirectory），致 repository_changes 恒 `not-a-repository`。

#### 决策
东家裁定「宿主侧不修，其它的地方修」：宿主 dsh-tools/subagent 不改。插件侧双层防御——指令面：persona 附加独立常量禁委派段（冻结提示本体不动）；能力面：`tools/pre-execute` waterfall 第一级否决已登记顾问子会话内的一切工具调用（deny-all，`SUBSESSION_TOOL_DENIED`，计数入状态快照）；并修复 getCwd 为会话工作区 cwd（sessionQuery 读 header.cwd，失败回落宿主 cwd 留痕）。

#### 被否方案及原因
- 修宿主（让委派组合尊重 toolFilter，或改 restriction 覆盖 own 层）：东家裁定宿主侧不修——宿主语义有自己的豁免理由（保住委派运行时注册进子 own 层的结构化作答工具），不宜为单插件改动。
- 仅靠协议提示禁委派（指令面单独防御）：实证指令弱于能力——顾问正是读了「不可轻信草稿、须独立核验」的协议后才委派的，指令面单独无效。
- 否决面收窄到委派工具对（只拦 subagent/list_subagent_models）：NG-1 是全称承诺（不执行任何工具），deny-all 才与其对齐；且未来宿主若泄漏更多工具，deny-all 仍守住防线。
- 顾问子会话改默认直调（presentation=direct）绕开子会话形态：放弃子会话呈现的可观测性与隔离收益，属产品级回退，超出缺陷修复边界（呈现形态是 C-020 的既定选择）。

#### 影响面
R-02-007 · 咨询服务、门控服务（T-035）；DOMAIN 新术语「子会话执行面守卫」；AC-05 字面缺口（own 层工具「出现」不可剥）残余记于此，宿主侧语义变化（如 restriction 覆盖 own 层）时插件可回退守卫。
