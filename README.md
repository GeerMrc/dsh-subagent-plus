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
| 兜底模型 | 候选清单全部不可用或为空、以及钉定路由故障时的最后路由（可关闭；清单空+兜底=单固定模型入口） |
| 推理强度 | 按所选模型自动加载其支持的思考档位（qwen 系 Off/Low/Medium/Xhigh、zai 系 Low/High/Max、无档位模型不显示） |
| 健康降级 | 瞬态失败（限流/5xx/超时/断网）随官方重试换到下一健康路由（记账先于官方重试器，第一次失败即入冷却）；凭据/配额类失败冷却整个 provider，只影响后续指派 |
| 只读徽章 | 子 Agent 窗口输入框右侧显示 `provider/model · 档位`（两段配色，悬停全文） |
| 子窗口识别 | 子 Agent 列表弹窗中当前所在行的标题呈琥珀色（叠加官方加粗标记） |
| 设置页 | 设置 → 子Agent增强：策略/清单（≤5）/兜底/高级全部图形化，保存即热生效（无需重启、不重置运行态） |
| 官方设置页接管 | **安装即 100% 接管（二态互斥，ADR 0005）**：官方「子智能体」设置页隐藏，**运行限制**并入候选模型清单**同一张卡**顶部（接管说明在运行限制 ⓘ 悬停中），全页一个保存按钮按固定顺序提交官方+本插件两个命名空间（单一事实源）；**候选模型清单是唯一路由来源**（官方授权清单零引用）；唯一关闭入口=「插件」页停用本插件（官方页带值回归） |
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

重启桌面端 → 设置 → 子Agent增强：安装即接管编辑面；未配置路由前不指派（子智能体继承主会话模型），请先在钉定路由或候选清单中选择模型，页面会明示当前未指派状态。

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
    strategy: round-robin    # pinned | round-robin | random | priority
    priority:                # 候选路由（≤5，顺序即优先级）——唯一路由来源；清单为空=不指派（继承主会话模型）
      - { provider: sz, model: Qwen3.8-27B-FP8, reasoningEffort: "" }
      - { provider: hh, model: Qwen3.8-27B-FP8, reasoningEffort: xhigh }
    fallbackProvider: ""     # 兜底路由（与 fallbackModel 成对；空=关）
    fallbackModel: ""
    respectExplicit: false   # true=尊重主 Agent 显式指派
    cooldownMs: 120000       # 故障冷却；0=关闭健康跟踪（UI 层上限 86400000）
    showNotice: true         # 子 Agent 转录内显示指派提示（中英双语单行）
```

完整语义见 [docs/strategy.md](docs/strategy.md) 与 [docs/settings.md](docs/settings.md)。

## 接管语义（v0.0.3 起，纯二进制，ADR 0005）

- **安装即接管，二态互斥**：官方「子智能体」设置页（纯编辑面）被隐藏；其中的**运行限制**（最大递归深度 / 并行数量上限——仍由官方子智能体运行时在委派时强制执行，本插件不复制实现）由本插件设置页**同键读写**官方 `subagent` 命名空间：写进去的就是官方命名空间的值。v0.0.3 起运行限制并入候选模型清单**同一张卡**的顶部子区（官方 SubagentCard 单卡惯例：卡内分区用留白不用边框；接管声明在运行限制 ⓘ 悬停中）。全页**一个保存按钮**按固定顺序（运行限制 → 本插件配置）提交，任一命名空间失败在页脚点名分区；某命名空间失活仅对应分区转不可用并被本次保存排除（接管期间不死锁）。
- **候选模型清单 = 唯一路由来源（ADR 0005）**：策略 + 逐模型推理强度 + 兜底 + 健康冷却完整覆盖并超出官方授权清单的能力；官方授权清单**不设编辑面、运行时零引用**（本插件不读它，它也不约束本插件的候选——候选只需在 LLM 目录注册）。未配置路由（钉定为空且清单为空且无兜底）= 不指派，子智能体继承主会话模型。
- **禁用 / 卸载即恢复（唯一关闭入口=「插件」页开关）**：插件页关闭（或卸载）后官方页面回归（生产宿主 hmr 热生效；源码启动的宿主需重启），上述配置值原样保留。已存在的子 Agent 从**下一次请求**起回到官方解析；在飞请求不受影响。设置页内不再有任何开关——关插件只去插件页。
- **透明与逃生门**：接管事实在插件页的 overrides 列表中可见；任何时候都可在用户层 patch 写 `{id: ui-settings-subagent, disabled: false}` 强制恢复官方页面。
- 本插件只隐藏编辑面，绝不触碰官方运行时行：`subagent` 运行时与 `subagent-model-selection-settings` 服务保持原样（后者被官方 preset 硬依赖，禁用会砍掉委派工具本身）。

## 开关与卸载（v0.0.3，ADR 0005）

- **插件页开关 = 唯一开关**：设置 → 插件 → dsh-subagent-plus 主开关。关闭即 bundle 级禁用本插件并恢复官方页（值保留）；重新启用同处。
- **卸载**：插件页移除——官方「子智能体」设置页与官方路由行为一并恢复。
- **设置页内无开关**：不设"仅停用路由指派"软开关、不设页头开关（v0.0.3 起，ADR 0005）。临时不想让插件管路由时，把策略/清单/兜底清空即为"不指派"状态（编辑面保持接管）。

## 升级与版本线（v0.0.3）

- 产品线固定 **0.0.x** 连续递增（0.0.2 → 0.0.3 → …，用户裁定，ADR 0004）；npm 上的 0.3.0 为 2026-10-28 误 tag 触发的孤儿包（tag 已删、`latest` 仍指 0.0.2），不属于本线。版本号只在用户批准发布时推进，日常完善走规范 commit。
- **从 0.0.2 升级的三条行为翻转（ADR 0005，均为用户裁定）**：① 存量 `enabled: false`（暂停态）升级后即翻转为 100% 接管（字段已删，残键被忽略）；② 钉定路由留空且依赖 autoRoute 采纳官方清单第一条的配置，升级后为不指派（继承主会话模型）；③ 轮询/随机空清单回落官方授权池的配置，升级后为无候选（走兜底或继承）。边角：存量 `enabled: false` 且结构非法的手改 yml 从惰性加载翻转为拒绝加载。已保存的合法值全部兼容，残键透传被忽略且永不写回。

## 已知行为与限制（摘要）

完整清单见 [docs/strategy.md](docs/strategy.md) 第五节：策略/清单变更只影响下一个决策点；粘性失败当前子 Agent 不救回（只影响后续指派）；健康表与轮询游标为进程内存态（重启清零、多窗口共享）；远程 web 会话（非本机访问）设置命名空间整区不可用（官方 memory 持久化语义），关闭本插件请到本机的「插件」页（ADR 0005 删除了页内开关后的已知代价）；未组合 settings/remote 服务的精简客户端中客户端半边（含徽章）响亮失败。

**有意偏离官方语义（v0.0.3 起）**：子 Agent 被改路由时，继承自父 Agent 的 `maxTokens` 会被**丢弃**（官方逐次选择模型时保留它）——继承预算按父模型容量设定，跨模型携带会溢出新模型上限且官方 runtime 无 clamp；丢弃后由 runtime 按新模型物化默认输出上限。因此**父 Agent 显式配置的输出预算不会传播到被改路由的子 Agent**。

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
