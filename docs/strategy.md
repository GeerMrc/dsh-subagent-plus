# 子 Agent 多模型路由策略 / Child-agent multi-route strategy（v0.0.4）

本文件是 `strategy` 配置的完整语义说明（ADR 0005 后候选唯一来源为 `priority` 列表）。

## 〇、解析链（v0.0.4，ADR 0006＋0007＋0008＋0010＋0014）：角色关键词命中（默认派生或自定义行）＞ 策略（钉定或 spread）＞ 兜底

路由经 `agent.model.select()` 在子智能体创建时选定（0.2.2+ 正规通道）；健康降级在步边界生效（request-error 记账后 select 下一健康路由）。

单链写死、无多层覆盖。`nameMap`（ADR 0006＋0007）：命中即强制指派（不读 respectExplicit、
无视成员手动选择），**路由目标只能取自候选清单**（悬空/半填＝structural 拒载＋运行时按未命中
防御，落策略链）；冷却/未注册时按三层链接管——同模型健康入口 → 其余健康候选 → 兜底（接管路由 memoize 且自身失败计入冷却；恢复即回映射路由）；
provider 级粘性失败连带冷却同 provider 全部映射行；命中 fork 队友默认放过（一次性 warn＋
pinForkChildren 出路）。空表＝休眠（ADR 0014→0016：默认映射开启时空表被派生行取代——三维度基准评分（内置 KB＋导入覆盖）；候选清单为空＝派生休眠；`nameMapDefaults=true` 且存储行非空＝派生胜出＋degraded 警告；钉定下派生休眠；未收录模型＝三槽最后备选）。

## 一、行为决策矩阵（ADR 0005：`priority` 列表是唯一候选来源，官方授权清单零引用；按名命中先于本表全部行）

| 插件配置 | 子 Agent 实际行为 |
|---|---|
| 无配置（钉定空 + 清单空 + 无兜底） | 不指派，继承主会话模型（官方默认解析，页面明示） |
| `provider`+`model` 显式（`strategy: pinned` 默认） | 全部钉定该路由；路由故障（冷却）或未注册被失败开放跳过时**由兜底接手**（兜底不可用：冷却场景保持钉定；未注册跳过场景保持官方解析路由）；留空则不指派（继承主会话模型） |
| `strategy: round-robin` | 每委派一个子 Agent 按清单顺序领一条（进程级游标），领到即**终身粘住**；下一个子 Agent 领下一条 |
| `strategy: random` | 每个子 Agent 从不放回牌组随机领一条并粘住；清单变化自动重洗 |
| `strategy: priority` | 默认全跑第一条健康路由；某路由故障进入冷却 → 后续子 Agent 自动降级到下一条；冷却期满自动恢复 |
| 轮询/随机/优先级 + `respectExplicit: true` | 主 Agent 委派时显式指派的路由被尊重；策略只分配"没指派"的子 Agent（钉定策略不吃此开关——它是强制指派） |
| spread 策略且清单运行中改为空 | 不分配，透传继承（一次 warn） |
| `subagent_fork` 子 Agent | 不受影响（`pinForkChildren` 默认 false；官方 KV cache 约束） |

候选来源：`priority` 列表是唯一来源（ADR 0005；存储顺序即设置页清单显示顺序——添加追加到末尾，上移/下移直接改写存储顺序）。清单为空 = 无候选（走兜底，否则不指派、继承主会话模型）——四种策略统一。

## 二、故障降级

| 失败码（`LlmFailure.code`） | 分类 | 冷却范围 | 当前子 Agent | 后续子 Agent |
|---|---|---|---|---|
| RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE | 瞬态 | 该路由 | 第一次失败即入冷却，并为**下一步** `select()` 健康路由（步边界生效）；同一步内的官方重试沿用本步已捕获的路由（§五.2） | 避开冷却中的路由 |
| AUTH / INVALID_CREDENTIAL / QUOTA / ACCOUNT_QUOTA | 粘性（provider 级） | 该 provider 全部路由 | 步内按官方重试策略（粘性码通常不重试，按官方行为失败结束——方案 A）；若仍有下一步，边界处换到其他 provider 的健康路由 | 避开该 provider |
| NO_ADAPTER / UNSUPPORTED_REASONING_EFFORT | 粘性（路由级） | 该路由 | 按官方行为失败结束（注意：NO_ADAPTER 多数在流构造期同步抛出、不经失败事件，见 §五.5；运行期到达失败事件的照常记账） | 避开该路由 |
| CONTEXT_WINDOW_EXCEEDED / IMAGE_OFFLOAD_REQUIRED / ABORTED / 其它未知码 | 忽略 | — | 不变 | 不变 |
| UNKNOWN 且 HTTP 429 / 5xx | 瞬态 | 该路由 | 同瞬态 | 同瞬态 |

冷却时长 = `max(providerRetryAfterMs, cooldownMs)`，重复失败只延长不缩短。`cooldownMs: 0` 完全关闭健康跟踪。插件在 `agent/request-error` 上**只记账、永远 `next()` 委派**，以 `prepend` 注册——重试与否完全由官方决定，但**每次失败（含将被重试的失败）都先入账**并为下一步 `select()` 健康路由。换路在**下一步边界**生效：步内重试沿用本步进入提示组装时捕获的路由（`select()` 只影响后续步骤——宿主不变量，见 §五.2）。

## 三、配置示例

双选 sz + hh、每个子 Agent 轮流使用（用户场景）：

```yaml
- id: dsh-subagent-plus
  name: dsh-subagent-plus
  config:
    strategy: round-robin     # 候选 = priority 列表（存储顺序）
    cooldownMs: 120000
    showNotice: true
```

优先级 + 故障降级（显式顺序）：

```yaml
    strategy: priority
    priority:
      - { provider: sz, model: Qwen3.8-27B-FP8 }
      - { provider: hh, model: Qwen3.8-27B-FP8, reasoningEffort: high }
    cooldownMs: 300000
```

尊重主 Agent 的显式指派、只给"没指派"的子 Agent 分配：

```yaml
    strategy: round-robin
    respectExplicit: true
```

## 四、可观测性

- 子窗口琥珀色徽章显示该子 Agent **实际**路由（读 `request/header`），分配与 failover 自动跟随，无需客户端改动。
- 转录提示（**中英双语单行**，以折叠的上下文注入行呈现）：策略指派 `[模型指派 model assigned: …（策略：轮询｜strategy: round-robin）— dsh-subagent-plus]`；钉定 `[模型钉定 model pinned: …]`；角色映射 `[按角色指派 model assigned by keyword: …]`；无可用候选 `[模型兜底 model fallback: …]`。路由失效后：策略链 `[模型切换 model reassigned: sz/… 冷却中（RATE_LIMIT），本子智能体继续使用 hh/…｜…]`；钉定 `[模型钉定兜底 …]`；角色映射 `[按角色接管 …]`（候选接管）或 `[按角色兜底 …]`。路由未注册且无接管、无兜底时 `[模型钉定跳过 …]`／`[按角色跳过 …]`（仍运行该路由，预期响亮失败）。同一子 Agent 对同一路由只提示一次，换到别的路由再提示。
- Host 日志（`dsh-subagent-plus: …` 前缀）：`selected route "hh/…" for child agent at creation (ADR 0010)`、`selected route "…" for "<角色名>" at inbox/claimed (ADR 0012)`、`route "sz/…" failed (RATE_LIMIT); cooling down for 120000ms`、`provider "sz" failed (INVALID_CREDENTIAL); every route of it cools down for …ms`、`step-boundary route swap to "hh/…" for the next step (ADR 0010 d3)`。
- 转录 notice 的两个边角：同一步内连续多次重试触发多次 failover（A→B→C）时，转录只报告最后一跳（中间跳见 Host 日志）；子 Agent 最后一步之后才发生的 failover 不会落转录 notice（Host 日志仍在）。

## 五、已知限制

1. 主 Agent 显式指派默认被策略覆盖（`respectExplicit: true` 可改）。开启尊重后，显式指派**恰好等于**父会话当前路由时识别不出（判别靠"子创建路由 ≠ 父当前路由"）；父会话未加载或无 `sessions` 服务（headless）时一律按继承处理。
2. 粘性失败（凭据/配额）当前子 Agent 通常无法救回，只影响后续指派（方案 A）。每次失败（含将被重试的失败）都先入账；换路在**下一步边界**生效——步内重试沿用本步进入提示组装时捕获的路由（宿主不变量：`agent.model.select()` 只影响后续步骤，插件不在步中改写请求）。若 provider 的 `retryPolicy` 不重试（不可重试码或额度耗尽），当前子 Agent 按官方行为失败结束，后续指派避开。
3. 健康表与轮询游标是进程内存态：Host 重启 / 插件重载清零；多窗口共享同一 Host 进程，顺序与健康态跨窗口共享。
4. 插件热重载后既有子 Agent 的粘住记忆丢失，其下一请求重新决策可能换路由（前缀重算一次、徽章跳变）。
5. 流构造期的同步失败不经 `agent/request-error`，健康表学不到；未注册路由由 `failOpen` 预检跳过。
6. `retryPolicy.mode: 'always'` 的 provider 上若路由持续失败（如硬宕机持续返回 5xx），步内重试会一直沿用已捕获的故障路由——插件无法在步中换路，该步不结束，换路就到不了下一步边界。对此类 provider 请使用有界重试策略。
7. 子 Agent 中途 failover 需对已积累前缀重新 prefill；若首请求即失败则零代价。
8. `respectExplicit=true` 时官方授权清单仍管辖**父模型的显式指派**（会话组合时的快照，官方 spawn 前校验）——被拒的委派不产生子 Agent；插件候选不受官方清单约束（ADR 0005 零引用），只需在 LLM 目录注册。
9. 失败事件只带 provider 不带 model：模型取该子 Agent 的记忆路由（映射行、接管路由或策略指派路由，provider 一致时；钉定子代无记忆，取钉定路由或兜底路由的 model）或其会话最新 `request/header`；两者都取不到则不记账。
