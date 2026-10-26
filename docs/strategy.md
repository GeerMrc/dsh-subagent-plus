# 子 Agent 多模型路由策略 / Child-agent multi-route strategy（v0.1.5）

本文件是 `strategy` 配置的完整语义说明。不写 `strategy` 字段时插件行为与 v0.1.4 逐字节一致。

## 一、行为决策矩阵

| 官方"允许 Agent 为子智能体选择模型"清单 | 插件配置 | 子 Agent 实际行为 |
|---|---|---|
| 关闭 / 未勾选 | 无配置 | 继承主窗口模型（官方默认） |
| 关闭 / 未勾选 | `provider`+`model` 显式 | 全部钉定该路由 |
| 勾 1 条 | 默认（`autoRoute: true`） | 全部钉定该条 |
| 勾 N 条 | `strategy: pinned`（默认） | 全部钉定显式路由，否则清单第一条 |
| 勾 N 条 | `strategy: round-robin` | 每委派一个子 Agent 按清单顺序领一条（进程级游标），领到即**终身粘住**；下一个子 Agent 领下一条 |
| 勾 N 条 | `strategy: random` | 每个子 Agent 从不放回牌组随机领一条并粘住；清单变化自动重洗 |
| 勾 N 条 | `strategy: priority` + `priority: [...]` | 默认全跑第一条健康路由；某路由故障进入冷却 → 后续子 Agent 自动降级到下一条；冷却期满自动恢复 |
| 勾 N 条 | 任意策略 + `respectExplicit: true` | 主 Agent 委派时显式指派的路由被尊重；策略只分配"没指派"的子 Agent |
| 勾 N 条 → 运行中改为空 | spread 策略且无 `priority` | 不分配，透传继承（一次 warn） |
| 任意 | `subagent_fork` 子 Agent | 不受影响（`pinForkChildren` 默认 false；官方 KV cache 约束） |

候选来源：`priority` 非空时用它（顺序即优先级）；否则读官方清单（**存储顺序** = 历史已存顺序 + 新勾选按点击顺序追加；与设置页显示顺序无关）。

## 二、故障降级

| 失败码（`LlmFailure.code`） | 分类 | 冷却范围 | 当前子 Agent | 后续子 Agent |
|---|---|---|---|---|
| RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE | 瞬态 | 该路由 | 官方重试机制发起重试时，插件把重试直接落到下一健康路由（`request/header` 记 `change`） | 避开冷却中的路由 |
| AUTH / INVALID_CREDENTIAL / QUOTA / ACCOUNT_QUOTA | 粘性（provider 级） | 该 provider 全部路由 | 按官方行为失败结束（方案 A） | 避开该 provider |
| NO_ADAPTER / UNSUPPORTED_REASONING_EFFORT | 粘性（路由级） | 该路由 | 按官方行为失败结束 | 避开该路由 |
| CONTEXT_WINDOW_EXCEEDED / IMAGE_OFFLOAD_REQUIRED / ABORTED / 其它未知码 | 忽略 | — | 不变 | 不变 |
| UNKNOWN 且 HTTP 429 / 5xx | 瞬态 | 该路由 | 同瞬态 | 同瞬态 |

冷却时长 = `max(providerRetryAfterMs, cooldownMs)`，重复失败只延长不缩短。`cooldownMs: 0` 完全关闭健康跟踪。插件在 `agent/request-error` 上**只记账、永远 `next()` 委派**——重试与否完全由官方 `dsh-llm-retry` 决定。

## 三、配置示例

双选 sz + hh、每个子 Agent 轮流使用（用户场景）：

```yaml
- id: dsh-subagent-plus
  name: dsh-subagent-plus
  config:
    enabled: true
    strategy: round-robin     # 候选 = 官方清单（存储顺序）
    cooldownMs: 120000
    showNotice: true
```

优先级 + 故障降级（显式顺序，不依赖官方清单的存储顺序）：

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
- 转录提示：`[model assigned: every request from this child agent runs sz/… (strategy: round-robin, dsh-subagent-plus)]`；failover 后追加 `[model reassigned: route sz/… is cooling down (RATE_LIMIT); this child agent continues with hh/… (dsh-subagent-plus)]`。每子 Agent 每条文案只出现一次。
- Host 日志：`assigned (round-robin) child agent onto hh/… (was zai/…)`、`route "sz/…" failed (RATE_LIMIT); cooling down for 120000ms`、`route "sz/…" is cooling down (…); child agent continues with "hh/…"`。
- 转录 notice 的两个边角：同一步内连续多次重试触发多次 failover（A→B→C）时，转录只报告最后一跳（中间跳见 Host 日志）；子 Agent 最后一步之后才发生的 failover 不会落转录 notice（Host 日志仍在）。

## 五、已知限制

1. 主 Agent 显式指派默认被策略覆盖（`respectExplicit: true` 可改）。开启尊重后，显式指派**恰好等于**父会话当前路由时识别不出（判别靠"子创建路由 ≠ 父当前路由"）；父会话未加载或无 `sessions` 服务（headless）时一律按继承处理。
2. 粘性失败（凭据/配额）当前子 Agent 无法救回，只影响后续指派（方案 A）；官方 `dsh-llm-retry` 不在场或 provider 无 `retryPolicy` 时，瞬态失败同样只影响后续指派。
3. 健康表与轮询游标是进程内存态：Host 重启 / 插件重载清零；多窗口共享同一 Host 进程，顺序与健康态跨窗口共享。
4. 插件热重载后既有子 Agent 的粘住记忆丢失，其下一请求重新决策可能换路由（前缀重算一次、徽章跳变）。
5. 流构造期的同步失败不经 `agent/request-error`，健康表学不到；未注册路由由 `failOpen` 预检跳过。
6. `retryPolicy.mode: 'always'` 的 provider 会持续重试，重试的 `agent/request` 仍会被换到健康路由，无饿死。
7. 子 Agent 中途 failover 需对已积累前缀重新 prefill；若首请求即失败则零代价。
8. 官方 per-call 校验用会话组合时的清单快照，插件候选读 live 设置——运行中改清单可能分叉；授权仍以官方为准。
9. 失败事件只带 provider 不带 model：模型取该子 Agent 的记忆路由（provider 一致时）或其会话最新 `request/header`；两者都取不到则不记账（debug 日志）。
