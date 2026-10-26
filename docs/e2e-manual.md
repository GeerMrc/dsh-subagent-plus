# 隔离回归测试手册 / Isolated regression manual

在独立测试 profile（端口 8917）与专用临时工作区中端到端验证插件双半边，生产 profile 零接触。每次 DSH 上游升级后（配合 README 的"升级检测三步流程"）或插件改动后执行。

## 1. 前置

- 已 `pnpm run pack:artifact` 产出 `dist-artifacts/dsh-subagent-plus-<ver>.tgz`
- 凭据复用：`~/.dsh/.credentials.yaml`（home 级，含 `SZ_API_KEY` / `ZAI_CODING_CN_API_KEY` 等 ref），测试 profile 的 `apiKeyEnv` 直接按名引用，无需复制 key

## 2. 建测试 profile（三文件）

`~/.dsh/profiles/pin-test/package.json`：

```json
{
  "name": "dsh-profile-pin-test",
  "private": true,
  "dependencies": {
    "dsh-subagent-plus": "file:<插件目录>/dist-artifacts/dsh-subagent-plus-<ver>.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-subagent-plus"]
    }
  }
}
```

`pnpm-workspace.yaml`：`packages: ['.']` + `nodeLinker: hoisted` + `autoInstallPeers: false`。

`cordis.patch.yml` 关键条目（完整模板见 git 历史或按此裁剪）：
`llm-pi-ai`（providers：钉定目标 `sz/Qwen3.8-27B-FP8` + 主窗口用**不同** provider 如 `zai-coding-cn/glm-5.3`，差异可判别）；`agent-default-model` = 主窗口模型；`subagent-model-selection-settings` enabled + [sz 路由]（autoRoute 数据源）；`tool-subagent`（spawn/continuable，**不配 agentOptions**——验证 autoRoute 替代手工耦合）；`dsh-subagent-plus`（autoRoute 轮：provider/model 空串）；`webserver`：`host: 127.0.0.1` + `port: 8917`（host 为必填项，易漏）。

建临时工作区（含 a.md/b.md 两个小文件）后 `pnpm install`。

## 3. 启动与执行

```sh
cd <DSH 仓库>
pnpm dsh --profile pin-test --patch apps/web/tests/pin-browse-picker.overlay.yml --no-open
# 输出 http://127.0.0.1:8917/?token=…
```

浏览器打开 token URL → 关闭"预览版说明" → "选择工作区" → 添加工作区（编辑路径直接输入临时工作区绝对路径）→ 发任务：

> 请用 subagent 工具并行派出 2 个子智能体：第一个总结 a.md 的要点，第二个总结 b.md 的要点。收齐两个结果后用一句话汇总。不要自己读文件，必须通过子智能体完成。

**注意**：sidebar 会显示共享 workspace.json 里生产工作区的会话列表——只读无害，但**必须切到专用工作区再发任务**。

## 4. 验证点

| # | 验证 | 方法 |
|---|---|---|
| ① | 子会话 `request/header` = 钉定路由（非主窗口模型） | 解压 `~/.dsh/sessions/<临时工作区slug>/<子id>/session.v4.jsonl.zstd`（zstd -dc + jq） |
| ② | 每个子会话恰 1 条 `[model pinned: …]` 消息 | 同上 grep `model pinned` |
| ③ | 主会话路由 = agent-default-model，不受影响 | 同上查主 session 目录 |
| ④ | 子窗口徽章显示 `sz/Qwen3.8-27B-FP8`（两处：输入框右侧 + 会话头部） | DOM 快照搜 `子智能体当前模型` / 截图留档 |
| ⑤ | 主窗口无徽章、模型选择器正常 | 快照 |
| ⑥ | 显式配置轮：插件 provider/model 显式填 sz 后重启重跑 ①-④（autoRoute 语义的对照组） | 改 patch 后重启 |

负路径（可选）：allowedModels 指向未注册路由 → failOpen warn + 子请求放行原路由（`routeRegistered` 负分支目前仅靠此手工验证；建议后续补 fake `llm` 单测，见审核 NOTE）。

## 5. 清理（测完即清）

1. `lsof -ti tcp:8917 | xargs kill`
2. `rm -rf ~/.dsh/profiles/pin-test`
3. `rm -rf ~/.dsh/sessions/<临时工作区slug>`（slug = 工作区路径的 `--` 转义格式）
4. `rm -rf <临时工作区目录>`
5. `~/.dsh/storages/workspace.json`：删 `tables.workspaces.<测试uuid>` 键 **并** 从 `global.workspaceIds` 同步移除（先备份）
6. 关闭浏览器测试标签；`~/.dsh/logs`、`cache` 增量按时间戳可辨，可留

## 6. 共享面说明

跨 profile 共享且被本测试触碰的只有：`sessions/`（按工作区 slug 隔离，专用工作区即天然隔离）、`storages/workspace.json`（第 5.5 步清理）、`logs/`、`cache/`。生产 `profiles/desktop` 目录与依赖零接触。

## 7. v0.1.6 设置页纯 UI 闭环（三 Flow）

前置：profile 的 `cordis.patch.yml` **不放** `dsh-subagent-plus` 配置条目（安装即默认接管，全部配置走设置页）。

| Flow | UI 操作 | 通过标准（会话日志取证） |
|---|---|---|
| A 轮询 | 设置 → 子Agent增强 → 策略=轮询 → 保存 → 新会话派 2 子 Agent | 两子会话 `request/header` 分别 = 清单第 1/第 2 条；各 1 条 `[model assigned: … (strategy: round-robin)]`；主会话不受影响 |
| B 兜底降级 | 设置页 → 策略=优先级 → 清单添加两条指向 `http://127.0.0.1:9/v1` 的 provider → 兜底=某真实路由 → 保存 → 派 1 子 Agent（主 Agent 可能自动重试委派） | 死路由子会话 `end:error`（冷却记账）；最终子会话落兜底路由 + `[model fallback: …]` + completed |
| C 禁用回官方 | 设置页 → 总开关关 → 保存 → 新会话派 1 子 Agent | 子会话 `request/header` = 主窗口模型（继承）、无任何插件 notice |

清理同第 5 节（workspace.json 按 `tables.workspaces.<uuid>.path` 字段定位删除并同步 `global.workspaceIds`）。


## 8. 版本回退/降级安装注意

从更高版本（如 0.2.5）降到低版本（如 v0.0.1）时，pnpm 视为版本回退——删 `node_modules/dsh-subagent-plus` 后 `pnpm install --force`（必要时先 `pnpm store prune`），并用 grep 安装产物内容确认版本（不要只看 MD5 对比本地 lib）。
