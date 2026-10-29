# 0001 — 官方子智能体设置页接管语义（v0.3.0）

日期：2026-10-29 ｜ 状态：已实施（feat/takeover-surface）

> 部分已被后续决策取代：决策 2 的授权清单同键编辑面由 [0003](2026-10-29-candidate-list-replaces-allowlist.md) 改为「候选清单 = 完整替代」（官方 allowlist 无编辑面，仅 host 半边只读桥接）；决策 5 的 0.0.2 → 0.3.0 跳号由 [0004](2026-10-29-product-line-is-0.0.x.md) 改判（0.3.0 为误发孤儿包，产品线固定 0.0.x）。接管机制本体（决策 1/3/4）继续有效。

## 背景

安装本插件（接管子智能体模型路由）后，官方「子智能体」设置页（`ui-settings-subagent`：运行限制 + 模型选择双卡）仍完整可见可用，旧勾选保留——用户无法从界面上分辨"谁在生效"。同时官方页的两项配置在接管下仍有真实作用：运行限制（`subagent` 命名空间）由官方运行时在委派时强制执行；模型选择授权清单（`subagent-model-selection-settings`）是本插件 autoRoute 与 official 回落池的数据源。需要一个明确的接管语义。

## 决策

1. **接管机制 = bundle patch disable `ui-settings-subagent` 行**（插件启用期间官方编辑面隐藏；`selectBundle(false)` 整层移除 → 禁用/卸载即完整恢复，hmr 热生效）。**弃用 plugins.item 同 id 低 priority 遮蔽方案**：插件页清单层（deepseek-harness `ui-plugin-manager/src/client/config-ledger.ts:61`）用原始 `slots.entries` 构建条目而非遮蔽胜者视图，同 id 双注册会产生重复卡 + React key 冲突（独立计划审核 P0 证据）。
2. **编辑面吸收，不复制运行时**：运行限制/授权清单由本插件设置页的「官方子智能体设置（已接管）」卡经 `configForms` **同键读写**官方命名空间（官方明文支持跨属主编辑，`ui-settings/src/client/config-form.ts:304-316` whileServed 文档）；强制执行仍属官方 `SubagentRuntime` 与官方 preset 链。**绝不禁用** `subagent-model-selection-settings` 服务行（standard/ptc/cordis preset `modelSelectionSettings: true` 硬依赖）与 `subagent` 运行时行（`tests/takeover-patch.spec.ts` 机械钉住）。
3. **ns 可用性三分支（T7）**：任一官方命名空间失活只把对应 section 转 unavailable，接管卡不随之消失——与官方卡 `whileServed`（SOME 语义）刻意不同，防 ns 抖动闪回官方页。失活时**清除 stale draft**（状态机不诚实的草案残留是 T7 测试抓出的缺陷，已修）。
4. **maxTokens 有意偏离官方语义**：`applyOverride` 路由变更分支丢弃继承的 `maxTokens`（官方逐次选模型时保留）；理由＝继承预算按父模型容量设定、跨模型携带会溢出新模型上限且官方 runtime 无 clamp（仅 `undefined` 时物化 `defaultMaxTokens`）。README「已知行为」与 `tests/load.spec.ts` T6 用例钉住；按新模型上限 clamp 记为技术债候选。
5. **版本 0.0.2 → 0.3.0 跳号**：`tests/manifest.spec.ts` 守卫挡 `/^0\.1\./`（file: 同版本重装陷阱），且 0.1.0–0.2.5 为 npm 首发前内部开发线（已在归档分支留档，CHANGELOG v0.0.1 注明）——0.3.0 同时越过守卫与归档区间。

## 影响

- 用户视角：装即接管（官方页隐藏、本插件页成为唯一子智能体设置入口）、关即恢复（值不丢、下一请求回官方解析）；逃生门＝用户层 patch `{id: ui-settings-subagent, disabled: false}`；接管事实在插件页 overrides 列表可见。
- 软关（`enabled: false`）语义不变（仅停路由指派），不恢复官方页——README/设置手册已显式区分。
- 后续 by-name 策略（v0.4.0 计划）在本接管面之上叠加，互不耦合。
