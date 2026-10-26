# AGENTS.md — 开发治理约定

本文件约束 dsh-subagent-plus 的日常开发、分支、版本与发布流程。

## 分支模型

- `main` = **可安装发布态**：任何时刻 checkout main 都应能 `pnpm run pack:artifact` 产出可安装 tarball。
- 日常开发在 `feat/<批次或主题>` 分支推进；修 bug 用 `fix/<主题>`。
- **合并需独立审核**：feature 分支完成后由独立上下文（独立 Agent 或人工）审核通过才合入 main，用真合并（`--no-ff`）保留分支历史。
- 提交信息 `<type>(<scope>): <summary>`（feat/fix/docs/polish/refactor/test/chore）；一个任务一个提交（红→绿→commit）。

## 版本策略

- 独立 semver 线，不跟随 DSH 宿主版本。
- **patch**（0.0.x）：缺陷修复、UI 打磨、文档——常态迭代。
- **minor**（0.x.0）：新功能或行为面扩展；升 minor 须在 `docs/decisions/` 记录一条决策说明（轻量 ADR：背景/决策/影响）。
- **非功能性变更不 bump**：纯文档、注释、重构（测试全绿且行为不变）不动版本号。
- 同版本号重打包陷阱：`file:`/tarball 循环开发中同版本换包会被 pnpm 跳过——**内容变更必须先 bump 再 pack**；调试期确需同版本重装，删 `node_modules/<pkg>` 后 `pnpm install --force`（并 `pnpm store prune` 清缓存副本）。

## 发版流程

1. 发版门：`pnpm run typecheck` + `pnpm test` + `pnpm run build` + `pnpm run pack:artifact` 全绿（CI 同款）。
2. CHANGELOG 顶部加版本条目（日期标题、诚实标注含未达项）。
3. bump `package.json` version → 提交 → 打**附注 tag** `v<x.y.z>`（message 含定档说明：本轮内容与版本线理由）。
4. 推送 main → **单独推送 tag**（首批 workflow 落库与 tag 不同批，避免 GitHub 不触发）。
5. tag 推送 = 发布确认点：release workflow 自动 build → GitHub Release（附 tgz）→ npm publish。
6. 发布链失败恢复见 [docs/upgrade.md](docs/upgrade.md) §6。

## 本地开发纪律

- Node ≥22.19：agent shell 一律 nvm 绝对路径前缀（`~/.nvm/versions/node/v22.x/bin`）。
- 隔离 E2E：专用 profile + 专用端口 + 临时工作区，测后全清理（流程见 [docs/e2e-manual.md](docs/e2e-manual.md)）；生产 `~/.dsh/profiles/desktop` 改动必须先备份。
- 生产 profile 依赖指向本地 `dist-artifacts/`：仓库移动/清理/重 clone 后会断供——重跑 pack 并重装。
- npm 首发前 `npm view <name>` 实测裸名可用性；被拒时走双名模式（见 dont-do）。

## 收尾六件套（每个交付批次）

1. 交付物（代码+测试+文档）；2. CHANGELOG；3. 负向教训沉淀（docs/dont-do.md 准入：踩坑→RCA→系统性确认）；4. 版本/分支动作合规；5. 独立审核结论留痕；6. 接力说明（未完成项/技术债/下一步）。
