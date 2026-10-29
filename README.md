# dsh-subagent-plus（子Agent增强）

> 语言权威声明：本文件为中文正本；[README.en.md](README.en.md) 是英文镜像，两者不一致时以中文为准。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供**子智能体模型路由策略引擎**的独立 cordis 插件：把所有委派产生的子 Agent 按可配置策略指派到 LLM 路由，并附只读模型徽章与设置页面。不修改任何产品代码，随上游升级免疫。

## 功能矩阵

| 能力 | 说明 |
|---|---|
| 钉定 | 所有子 Agent 固定一条路由（默认；修复官方"授权清单不传参即继承主模型"的缺口） |
| 轮询 | 每个子 Agent 按清单顺序轮流领路由（a→b→c→a…），领到后整个生命周期保持 |
| 随机 | 每个子 Agent 随机领一条并保持 |
| 优先级 | 默认第一条健康路由；故障冷却时按序降级，冷却期满自动恢复 |
| 兜底模型 | 候选清单全部不可用或为空时的最后路由（可关闭；清单空+兜底=单固定模型入口） |
| 推理强度 | 按所选模型自动加载其支持的思考档位（qwen 系 Off/Low/Medium/Xhigh、zai 系 Low/High/Max、无档位模型不显示） |
| 健康降级 | 瞬态失败（限流/5xx/超时/断网）随官方重试换到下一健康路由；凭据/配额类失败冷却整个 provider，只影响后续指派 |
| 只读徽章 | 子 Agent 窗口输入框右侧显示 `provider/model · 档位`（两段配色，悬停全文） |
| 子窗口识别 | 子 Agent 列表弹窗中当前所在行的标题呈琥珀色（叠加官方加粗标记） |
| 设置页 | 设置 → 子Agent增强：策略/清单（≤5）/兜底/高级全部图形化，保存即热生效（无需重启、不重置运行态） |
| 官方设置页接管 | 启用期间官方「子智能体」设置页隐藏；**运行限制**区在候选模型清单上方、**官方授权清单**区在策略编辑器之后，全页一个保存按钮按固定顺序提交官方+本插件三个命名空间（单一事实源）；页头开关=完全接管开关（关闭即禁用插件并恢复官方页，值保留） |
| 覆盖范围 | `subagent` 委派、Agent Teams 队友、恢复会话中的委派；顶层 Agent 与 fork 子代（默认）不受影响 |

## 从零安装（三步）

```sh
# 1) 构建 tarball
pnpm install && pnpm run pack:artifact   # 产出 dist-artifacts/dsh-subagent-plus-<ver>.tgz

# 2) 安装进 DSH profile（desktop 为桌面端保留 profile）
dsh plugin --profile desktop add /path/to/dsh-subagent-plus/dist-artifacts/dsh-subagent-plus-<ver>.tgz

# 3) 验证
dsh --profile desktop --dump-config | grep dsh-subagent-plus
```

重启桌面端 → 设置 → 子Agent增强：默认"钉定 + 自动采纳官方清单第一条"，开箱即用。

### 其他分发方式

- **npm**：`dsh plugin --profile desktop add dsh-subagent-plus@<ver>`（profile 内 pnpm 会拉取并解包）。
- **file: 依赖**：profile `package.json` 手动 `"dsh-subagent-plus": "file:…tgz"` + bundles 数组加同名条目（等价于 `dsh plugin add` 的两步），详见 [docs/upgrade.md](docs/upgrade.md)。
- **源码安装**：clone 后走"从零安装"三步。

## 配置速览

全部配置可在设置页完成；等价的 profile patch 层：

```yaml
- id: dsh-subagent-plus
  name: dsh-subagent-plus
  config:
    enabled: true            # 总开关；关闭即完整恢复官方行为
    strategy: round-robin    # pinned | round-robin | random | priority
    priority:                # 候选路由（≤5，顺序即优先级；空则用官方授权清单）
      - { provider: sz, model: Qwen3.8-27B-FP8, reasoningEffort: "" }
      - { provider: hh, model: Qwen3.8-27B-FP8, reasoningEffort: xhigh }
    fallbackProvider: ""     # 兜底路由（与 fallbackModel 成对；空=关）
    fallbackModel: ""
    respectExplicit: false   # true=尊重主 Agent 显式指派
    cooldownMs: 120000       # 故障冷却；0=关闭健康跟踪
    showNotice: true         # 子 Agent 转录内显示指派提示
```

完整语义见 [docs/strategy.md](docs/strategy.md) 与 [docs/settings.md](docs/settings.md)。

## 接管语义（v0.3.0 起；v0.3.1 打磨）

- **安装并启用即接管**：官方「子智能体」设置页（纯编辑面）被隐藏；其中的**运行限制**（最大递归深度 / 并行数量上限——仍由官方子智能体运行时在委派时强制执行，本插件不复制实现）与**官方授权清单**（"允许 Agent 为子智能体选择模型"——供主智能体逐次显式指派、钉定路由留空时自动采纳、候选清单为空时的回落池）由本插件设置页**同键读写**官方命名空间：写进去的就是官方命名空间的值。v0.3.1 起两区并入主页面——运行限制卡在候选模型清单**上方**（与官方页排版一致），授权清单区在策略编辑器之后；全页**一个保存按钮**按固定顺序（运行限制 → 授权清单 → 本插件配置）提交，任一命名空间失败会在页脚点名分区；某命名空间失活仅该区转不可用并被本次保存排除（接管期间不死锁）。
- **页头开关 = 完全接管开关（v0.3.1）**：关闭需经确认条（说明本页将卸载、重新启用走插件页）；确认后经插件管理器整体禁用本插件（bundle 级）——官方「子智能体」设置页回归、全部配置值保留。生产桌面/远程宿主 hmr 即时生效；启动型宿主显示"需重启生效"提示。开关状态与插件页主开关联动同态。组合未提供插件管理服务时降级为提示文案（引导去插件页操作），不再出现死设置页。
- **禁用 / 卸载即恢复**：插件页关闭（或卸载、或页头开关确认关闭）后官方页面回归（生产宿主 hmr 热生效；源码启动的宿主需重启），上述配置值原样保留。已存在的子 Agent 从**下一次请求**起回到官方解析；在飞请求不受影响。
- **透明与逃生门**：接管事实在插件页的 overrides 列表中可见；任何时候都可在用户层 patch 写 `{id: ui-settings-subagent, disabled: false}` 强制恢复官方页面。
- 本插件只隐藏编辑面，绝不触碰官方运行时行：`subagent` 运行时与 `subagent-model-selection-settings` 服务保持原样（后者被官方 preset 硬依赖，禁用会砍掉委派工具本身）。

## 开关与卸载（v0.3.1）

- **页头完全接管开关**（设置 → 子Agent增强 右上）：确认后 bundle 级禁用本插件并恢复官方页；本设置页随插件卸载。重新启用走插件页开关。
- **插件页开关**：设置 → 插件 → dsh-subagent-plus 主开关（与页头开关同一 bundle 态，双向联动）。
- **仅停用路由指派**（高级折叠首项，即原软开关 `enabled: false`）：钩子完全惰性，路由与官方逐字节一致；**页面接管保持**（官方页仍隐藏）——恢复页面请用完全接管开关、插件页开关或卸载。v0.0.2 存量 `enabled: false` 升级后语义不变。
- **卸载**：插件页移除——官方「子智能体」设置页与官方路由行为一并恢复。

## 升级与版本线（v0.3.1）

- npm 上存在 **0.3.0**（2026-10-28 在人工实测门存在之前被 tag 触发发布，`latest` 已拨回 0.0.2）；版本线自 **0.3.1** 起续接其上，`tests/manifest.spec.ts` 有版本下限守卫。从 0.0.2 升级：配置字段无增删，仅页头开关语义变化（原软开关移入高级），已保存值全部兼容。

## 已知行为与限制（摘要）

完整清单见 [docs/strategy.md](docs/strategy.md) 第五节：策略/清单变更只影响下一个决策点；粘性失败当前子 Agent 不救回（只影响后续指派）；健康表与轮询游标为进程内存态（重启清零、多窗口共享）；远程 web 会话保存仅当前会话生效；未组合 settings/remote 服务的精简客户端中客户端半边（含徽章）响亮失败。

**有意偏离官方语义（v0.3.0 起）**：子 Agent 被改路由时，继承自父 Agent 的 `maxTokens` 会被**丢弃**（官方逐次选择模型时保留它）——继承预算按父模型容量设定，跨模型携带会溢出新模型上限且官方 runtime 无 clamp；丢弃后由 runtime 按新模型物化默认输出上限。因此**父 Agent 显式配置的输出预算不会传播到被改路由的子 Agent**。

## 统一命名规范（自有独立插件）

- 裸名 `dsh-<product>` 作为包名（不用 `@deepseek-ai` scope——上游专用）；npm 裸名被政策拒绝时走 scope 分发 + 裸名 tarball 双名模式。
- 注册 id 族六面恒等裸包名：包名 = cordis patch 行 `id` = 行 `name` = client bundle banner id = 插件 `name` 导出 = settings/locale 命名空间；`tests/manifest.spec.ts` 机械钉住。
- `-plus` 等后缀是产品名，不是机制语义；CSS 前缀/`data-*` 等外观短名（本插件 `dsmp-`）与注册 id 分层，不随包名联动。
- 任何触及安装面的改动（含改名）必须 bump 版本：`file:`/tarball 循环开发同版本重装会被 pnpm 跳过。

## 开发

```sh
pnpm run typecheck   # 双 tsconfig
pnpm test            # 全量（宿主 + 客户端纯逻辑）
pnpm run pack:artifact
```

分支模型、版本策略与发版流程见 [AGENTS.md](AGENTS.md)；升级与发布链恢复见 [docs/upgrade.md](docs/upgrade.md)；负向教训清单见 [docs/dont-do.md](docs/dont-do.md)。

## License

[MIT](LICENSE)
