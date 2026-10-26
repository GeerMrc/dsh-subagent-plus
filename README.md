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

## 开关与卸载

- **插件页开关**：桌面端 设置 → 插件 → dsh-subagent-plus（写 `disabled: true` 并热重载）。
- **软关**：设置页总开关或 `enabled: false`（钩子完全惰性，路由与官方逐字节一致）。
- **卸载**：插件页移除，官方 subagent 自动按默认运行——本插件是叠加层，官方行为从未被改过。

## 已知限制（摘要）

完整清单见 [docs/strategy.md](docs/strategy.md) 第五节：策略/清单变更只影响下一个决策点；粘性失败当前子 Agent 不救回（只影响后续指派）；健康表与轮询游标为进程内存态（重启清零、多窗口共享）；远程 web 会话保存仅当前会话生效；未组合 settings/remote 服务的精简客户端中客户端半边（含徽章）响亮失败。

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
