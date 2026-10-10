---
doc-type: task
mutation: lifecycle
id: T-025
---

# T-025 README 双语重写、演示截图与 dsh-market 发布

状态: active
风险等级: standard

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

- scripts/screenshot.mjs 冒烟模式退出码 0：advisor 命中数 ≥ 2、意见文本与会话收尾断言通过。
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
| 异常 | 适用：mock 链路断言失败即非零退出，不产出假截图 | `scripts/screenshot.mjs::await until('手动咨询意见送达'`、`scripts/screenshot.mjs#process.exitCode = 1` |
| 边界配置 | 适用：npm 首发走人工一次，后续 OIDC；tarball 别名防 latest 腐烂 | `.github/workflows/npm-publish.yml#npm publish --provenance`、`package.json::"publishConfig"`、`package.json::"repository"` |
| 副作用 | 适用：不改运行时行为，client 产物不动 | `test/index.test.js::R-02-001/AC-01 gateway 缝可得时：卡片 set 经 RPC 即时生效于后续咨询`、`.github/workflows/npm-publish.yml#git diff --exit-code` |

## 终态与证据

（关闭时填写）
