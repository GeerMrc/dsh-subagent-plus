# 隔离回归测试手册 / Isolated regression manual

在独立测试 profile（端口 8917）与专用临时工作区中端到端验证插件双半边，生产 profile 零接触。每次 DSH 上游升级后（配合 docs/upgrade.md §3 的升级检测三步流程）或插件改动后执行。

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
`llm-pi-ai`（providers：钉定目标 `sz/Qwen3.8-27B-FP8` + 主窗口用**不同** provider 如 `zai-coding-cn/glm-5.3`，差异可判别）；`agent-default-model` = 主窗口模型；`tool-subagent`（spawn/continuable，**不配 agentOptions**——验证插件指派替代手工耦合）；`dsh-subagent-plus`（钉定轮：provider/model 显式 sz）；`webserver`：`host: 127.0.0.1` + `port: 8917`（host 为必填项，易漏）。注：ADR 0005 后官方授权清单零引用，profile 不再需要 `subagent-model-selection-settings` 数据源行（宿主组合若仍要求该行存在，按原方式保留即可，插件不读它）。

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
| ② | 每个子会话恰 1 条双语言钉定提示 `[模型钉定 model pinned: …]` 消息 | 同上 grep `model pinned`（双语文案子串） |
| ③ | 主会话路由 = agent-default-model，不受影响 | 同上查主 session 目录 |
| ④ | 子窗口徽章显示 `sz/Qwen3.8-27B-FP8`（仅输入框右侧一处；会话头部座位 0.2.5 起已删，一次性只读子窗口无徽章、以转录 notice 为准） | DOM 快照搜 `子智能体当前模型` / 截图留档 |
| ⑤ | 主窗口无徽章、模型选择器正常 | 快照 |
| ⑥ | 空配置轮：插件 provider/model/清单全部留空后重启派 1 子 Agent（「不指派、继承主会话模型」对照组） | 改 patch 后重启 |

负路径（冒烟）：钉定路由（或候选）指向未注册路由 → failOpen warn + 子请求保持原路由。`routeRegistered` 负分支已有 fake `llm` 单测覆盖（`tests/load.spec.ts` 的 pinned notice vs registration 组），手工仅作冒烟。

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
| A 轮询 | 设置 → 子Agent增强 → 策略=轮询 → 保存 → 新会话派 2 子 Agent | 两子会话 `request/header` 分别 = 清单第 1/第 2 条；各 1 条双语文案 `[模型指派 model assigned: …（策略：轮询｜strategy: round-robin）— dsh-subagent-plus]`；主会话不受影响 |
| B 兜底降级 | 前置：把死路由 provider 先写进 profile patch 的 `llm` providers（目录刷新后才出现在设置页添加下拉）→ 设置页 → 策略=优先级 → 清单添加两条指向 `http://127.0.0.1:9/v1` 的 provider → 兜底=某真实路由 → 保存 → 派 1 子 Agent（主 Agent 可能自动重试委派） | 死路由子会话 `end:error`（冷却记账）；最终子会话落兜底路由 + `[模型兜底 model fallback: …]`（双语文案）+ completed |
| C 空配置不指派 | 设置页 → 钉定路由清空 + 清单清空 + 兜底关闭 → 保存 → 新会话派 1 子 Agent（ADR 0005：页内无开关，空配置=不指派） | 子会话 `request/header` = 主窗口模型（继承）、无任何插件 notice；官方页保持隐藏（编辑面接管不变） |

清理同第 5 节（workspace.json 按 `tables.workspaces.<uuid>.path` 字段定位删除并同步 `global.workspaceIds`）。


## 8. 0.0.x 接管面（takeover）Flow E

前置同第 2 节（profile 的 `cordis.patch.yml` **不放** `dsh-subagent-plus` 配置条目，也不放 `subagent` 覆盖——安装即默认接管，运行限制全部走设置页写入）。

### 8.1 浏览器 UI 全流程（用户实测门）

| # | 操作 | 通过标准 |
|---|---|---|
| E1 | 打开 `插件` 页 | 「已安装插件」出现 dsh-subagent-plus 且开关为开；「内置插件配置」**没有**「子智能体」卡（仅剩 Agent 循环/终端等） |
| E2 | 设置 → 子 Agent 增强 | **页头无开关**（ADR 0005：唯一关闭入口=插件页）；**无独立横幅、无独立运行限制卡**——运行限制是候选模型清单**同一张卡**的顶部子区（深度/并行两个数字输入；接管声明在其 ⓘ 悬停中）；**没有**「官方授权清单」区、没有官方清单状态行；高级折叠首项是 respectExplicit（pinned 下置灰）；行标题与 ⓘ 图标同组不换行；cooldown 输入 88px 居中、上限 86400000（超限阻塞保存）；底部只有**一个**保存按钮 |
| E3 | 运行限制改为 深度=3 / 并行=2 → 保存 | 保存按钮变已保存；`~/.dsh/profiles/pin-test/cordis.patch.yml` 出现 `subagent` 行 `maxDepth: 3`、`maxActiveSubagents: 2`（用户层覆写，官方命名空间同键落盘） |
| E4 | `插件` 页把 dsh-subagent-plus 开关关闭（**唯一关闭入口**，ADR 0005） | 本设置分区消失（hmr 即时；源码宿主需重启）；官方「子智能体」页回归 |
| E5 | 重启宿主（源码宿主必须）→ `插件` 页 | 「内置插件配置」**回归**「子智能体」卡，最大递归深度=3 带「已覆盖」徽章、并行=2（值保留）；无 dsh-subagent-plus 分区 |
| E6 | `插件` 页把 dsh-subagent-plus 开关打开 | 插件页/设置页回到 E1-E2 状态（官方页再次隐藏） |

断言纪律（dont-do 沉淀）：源码启动的宿主对 bundle 开关**不热重组**，E4/E5 必须按「重启后回归」设计；官方条目文案是单数 "Subagent"；web-app 专属行（ui-settings-subagent / subagent-model-selection-settings）在 headless 组合需 `--patch` overlay 补插。

### 8.2 无浏览器降级流程（组合层断言，v0.0.3 开发期已执行留证）

浏览器不可用时的等价组合层验证（证据存 `dist-artifacts/` 下的 e2e 目录）：

1. 按 §2 建隔离 profile → 启动 → `curl -c cookies -L "?token=…"` 取回 `index.html`
2. **E1'**：模块表 `href="plugins/??…"` 中含 `dsh-subagent-plus/client.js` 且**不含** `@deepseek-ai/dsh-client-ui-settings-subagent/client.js`（官方页隐藏）
3. **E3'**：停宿主 → 从 profile `package.json` 的 `dsh.profile.bundles` 移除 `dsh-subagent-plus`（即 `setBundleEnabled(false)` 的落盘动作）→ 重启 → 再取页面：模块表反转（含 ui-settings-subagent、不含 dsh-subagent-plus）
4. UI 写入路径（E2/E3 的保存行为）由单测覆盖（`tests/client/unified-save.spec.ts` 真控制器集成用例），不在本降级流程内重复

### 8.3 已知边界（本轮显式声明）

- 行级禁用 `dsh-subagent-plus` entry（插件详情页行开关）不移除 bundle 层：官方页保持隐藏而插件停用——逃生门为用户层 patch 追加 `- id: ui-settings-subagent / disabled: false` 或重开 bundle。
- 宿主致命恢复（sanitizeProfile）会重置 bundles 列表：插件随之停用、官方页回归，需在插件页重开。


## 9. 版本回退/降级安装注意

从更高版本（如 0.2.5）降到低版本（如 v0.0.1）时，pnpm 视为版本回退——删 `node_modules/dsh-subagent-plus` 后 `pnpm install --force`（必要时先 `pnpm store prune`），并用 grep 安装产物内容确认版本（不要只看 MD5 对比本地 lib）。
