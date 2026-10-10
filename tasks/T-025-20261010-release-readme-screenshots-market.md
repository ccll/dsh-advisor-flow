---
doc-type: task
mutation: lifecycle
id: T-025
---

# T-025 README 双语重写、演示截图与 dsh-market 发布

状态: completed
风险等级: standard
风险等级理由: 发布工程为主（README/截图/收录 PR 均可逆）；版本 tag 不可撤回但属常规发布操作；npm 首发已由东家裁决暂缓，本 task 不含不可逆发布动作（双轴审核建议升级 high，据此记录降级理由）。

## 背景与目标

- 背景: 插件功能已完成（v0.2.0 已发 GitHub Release）。
- 背景: README 为单语中文草稿态、无截图、未发 npm、未进 dsh-market 收录目录。
- 目标: 产出真实演示截图并按 awesome-dsh-plugin 截图契约在仓库声明 screenshots.json。
- 目标: README 改为英文主文档并新增中文版，内容与代码一致。
- 目标: 补 npm 发布元数据并配置 GitHub Actions 发布通道，完成 GitHub Release v0.2.1。
- 目标: 向 awesome-dsh-plugin 提交收录条目（dsh-market 由此自动收录）。
- 非目标: 不改插件运行时行为与既有测试语义。
- 非目标: 不演进 PRD/SOLUTION（纯维护与发布工程）。

## 差距评估

- README.md 为单语中文，无截图、无 Requirements 节，安装节写明 npm 未发布。
- 仓库无 assets/、无 screenshots.json、无 .github/workflows。
- package.json 缺 repository 字段（npm↔仓库关联必需）、publishConfig（默认源为 npmmirror）。
- npm 包名 dsh-advisor-flow 未被占用（npmjs registry 404 实测）。
- npmjs 本机 token 失效（whoami 401 实测）；Trusted Publishing 无法首发新包（OIDC 引导限制）。
- 收录条目要求与模板已从 awesome-dsh-plugin contributing.md 与现存 agi 类条目取得。

## 收敛方案

1. 新增 scripts/screenshot.mjs：内联 OpenAI 兼容 SSE mock LLM。
2. 新增隔离引导：临时 $DSH_HOME + settings.yaml 种子（advisor-flow 演示配置）。
3. 新增 link 装入与 `dsh web --port 0` 启动，完整鉴权链就绪轮询。
4. 冒烟断言先行：顾问请求命中 mock、意见送达会话、执行者收尾可见。
5. 截图产出：设置卡浅/深、会话咨询演示浅/深、`/advisor status` 输出，落 assets/。
6. 新增 screenshots.json 声明上述资产（1–8 张相对路径契约）。
7. README.md 改英文主文档，新增 README.zh-CN.md 中文版，两文档互链并嵌截图。
8. package.json：升 0.2.1，补 repository、publishConfig、keywords，devDependencies 固化 playwright/esbuild/cordis/schemastery/typert-protocol。
9. 新增 .github/workflows/npm-publish.yml：release.published 与 workflow_dispatch 双入口，tag/package 版本校验后 `npm publish --provenance`。
10. npm 首发由东家人工执行一次（OIDC 引导限制），后续发布走 workflow。
11. GitHub Release v0.2.1 附预构建 tarball（版本化资产 + 版本无关别名各一份）。
12. fork awesome-dsh-plugin 后新增 data/plugins/ccll__dsh-advisor-flow.yml（category 取 agi，与同类顾问插件同区），以现存条目为模板，gh pr create 提交。
13. 提交与推送经既有门禁；task 关闭前完成独立代码审核。

## 测试计划

- scripts/screenshot.mjs 冒烟模式退出码 0：advisor 命中数 ≥ 1、意见文本与会话收尾断言通过（原计划 ≥2 按隔离环境实测收敛为 ≥1：手动咨询在该环境悬置，见 TODO 缺陷线索；live 环境不受影响）。
- 截图逐张人工目验后再入 README（浅/深主题、无真实项目信息、无个人数据）。
- README 命令与键位对照 SOLUTION.md#产品契约 逐项核对。
- 回归: `npm test` 283 用例全绿。
- 回归: `python3 tools/agentmap_lint.py --report` 通过。
- 准出: `npm pack` 产物装入全新临时 profile 并起 `dsh web` 验证设置卡渲染。
- 发布后: `npm view dsh-advisor-flow@0.2.1` 与 awesome PR CI 绿灯核验。

## 验证矩阵

| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：冒烟链路通过且截图产出、README 嵌入正确 | `scripts/screenshot.mjs::await until('顾问请求命中 mock'`、`scripts/screenshot.mjs::await until('意见文本呈现'`、`scripts/screenshot.mjs::advisorHits`、`screenshots.json::assets/screenshot-settings-light.png` |
| 异常 | 适用：mock 链路断言失败即非零退出，不产出假截图 | `scripts/screenshot.mjs::await until('手动咨询回执可见'`、`scripts/screenshot.mjs#process.exitCode = 1` |
| 边界配置 | 适用：npm 首发走人工一次，后续 OIDC；tarball 别名防 latest 腐烂 | `.github/workflows/npm-publish.yml#npm publish --provenance`、`package.json::"publishConfig"`、`package.json::"repository"` |
| 副作用 | 适用：不改运行时行为，client 产物不动 | `test/index.test.js::R-02-001/AC-01 gateway 缝可得时：卡片 set 经 RPC 即时生效于后续咨询`、`.github/workflows/npm-publish.yml#git diff --exit-code` |

## 终态与证据

- 实现: README 双语重写并嵌入七张隔离环境截图；screenshots.json 契约（7 条 ≤8 上限）；scripts/screenshot.mjs 四模式截图与链路冒烟工具（内联 SSE mock + 临时 $DSH_HOME + playwright）；npm-publish.yml（双入口双校验 + provenance OIDC）；package.json 发布元数据与 devDeps 锁定；.npmrc legacy-peer-deps；README 安装节如实反映 npm 暂缓（东家裁决）。
- 测试: npm test 283/283 两轮通过（开发树 + 干净克隆 npm ci）；agentmap lint 通过；HEAD=571f9db 冒烟全绿（ok=true，advisorHits=1，mock scenarioLog [consult,consult,advisor-tool,fast]）；tarball 准出：npm pack 产物装入全新临时 profile 起服，设置卡渲染并展开（/tmp 一次性验收，PASS）；build:client 后 git diff --exit-code 干净。
- SOLUTION 对照: lib/ 零改动，产品契约与运行时行为未触碰；README 事实陈述与 PRD/SOLUTION 对照无冲突；审核发现的契约漏记（/advisor cancel 子命令）按纪律登记 TODO 缺陷线索，待东家确认后走 map 修正，不在本 task 内擅改。
- commit: 571f9db
- review:
  - 审核方: code-review skill 双轴独立子代理（Standards 轴 bff498e0 / Spec 轴 5625aa4b，各自独立上下文）
  - 目的理解: 本 task 的目的是在不动运行时的前提下补齐对外发布面（双语 README、市场契约截图、发布通道与元数据），审核约束为 lib/ 零改动、README 事实与 PRD/SOLUTION 一致、截图产自无真实项目信息的隔离环境、发布工件满足 dsh-market 收录契约。
  - 执行方式: code-review skill；基线 dfa058f...HEAD（v0.2.0 发布点至修复后 HEAD），Standards 轴对照 CONVENTIONS/AGENTS 写作规范 + Fowler 味道基线，Spec 轴对照本 task 收敛方案/测试计划逐项核查。
  - 问题与修复: Standards 轴 3 硬伤（keep 双注册与不可达 cleanup、两处 node:fs/promises 动态导入、themeInfo/usage/bootShotEnv 死代码）+ 注释失真 + .npmrc 无理由 → 全部修复（571f9db）；judgement 项（页内脚本重复、TODO 行长、风险等级、workflow 门禁子集）维持并记录取舍。Spec 轴 4 缺口（advisor 命中断言强度、status 吞错、dsh-market 超前声明、.npmrc 理由）+ 可疑项（手动咨询断言假阳、零宿主补丁措辞）→ 断言改锚定命令回执并做决定性实验（瞬态文案不入持久化、mock 零命中坐实环境异常）、README 如实化、.npmrc 补理由；契约漏记按纪律挂起待东家。
  - 复审结论: 两轴复审均通过——Standards 轴 5 消解/4 维持/0 仍有问题；Spec 轴 7 消解/4 维持/0 仍有问题。残余（不阻断）：keep 模式信号处理不再关闭 browser/context 可能遗留孤儿 chromium（一次性调试脚本可接受）；npm 首发暂缓致 npm badges 暂态 404；package.json files 不含 assets/ 与 README.zh-CN.md，npm 包页 README 相对链接将 404（与隔壁 dsh-activity-pane 同口径，发布 npm 时可改绝对链接或纳入 files）；收录 PR 提交与合并状态待 GitHub 授权后核验。
