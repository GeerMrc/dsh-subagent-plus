# 0010 — agent.model.select() 迁移（取代 agent/request 瀑布模型改写）

日期：2026-11-12 ｜ 状态：用户裁定（v0.0.4 未发布原地改写）

## 取代/存活清单

**取代**：
- 0006 d2 的 agent/request 载体面（解析链不变，载体从瀑布改写迁至 select()）
- 0006 d4 的请求期暂避面（冷却即期 evade-to-fallback / spread 步中 failoverIfCooling → 步边界换路）
- 0006 d9 RISK-H1 追踪条款（本 ADR 即为该条款指向的"届时新 ADR"）
- 0009 d1-d3（defaultModelFallback / pre-step 冲突告警 / prepend 顺序保险——0.2.2 中不再需要且会撞不变量）
- 0009 d4 撤销（notice kind 暂缓项 moot——新机制下通知报真选择）

**存活（载体迁移）**：
- 0006 d1 存活三面（跨 Team 匹配、死名休眠、未知名不告警）、d3（无开关/空表休眠）、d5（agentTeams 守卫）、d6（粘住/fork 排除＋**fork 命中一次性 warn 随载体迁至 agent/created**）、d7（校验）、d8（通知——改读真值）
- 0007 d1（候选清单唯一来源）、d2（悬空防御——寄生在 decideByName 内、载体迁移至 agent/created）、d3（钉定只读）、d4（记账防御保留——载体从 agent/request 迁至 agent/created 预检）、d7（五轨行）
- 0008 全部（关键词匹配、isValidKeyword、运行时防御——载体迁移）
- 0009 d5-d6（parentRouteOf catch / routeRegistered 保守化——代码存活，src/index.ts 注释引用需改写）

## 背景

DSH 0.2.2-rc.2 禁止 agent/request 瀑布改写 provider/model/effort（不变量 agent.ts:635-637），报错 `proposed X after step preparation fixed Y; use agent.model.select() before step preparation`。独立审核（agent_e12a3ad1，六维对照）确认 agent/created + select() 为最佳路径：替代方案全部排除（包装服务违纪律／注入 setup 公开不可行／官方白名单语义不符／保留 agent/request 结构不可能）。

## 决策

### 1. 核心机制迁移

删除 agent/request 瀑布中的全部模型改写逻辑。新增 `agent/created` 事件监听器：守卫消费 agentTeams 获取队友名 → matchByKeyword → `llm.resolveCallConfig()` 预检 → `agent.model.select({provider, model, reasoningEffort?})` 落账。effort 缺省保持 absent（不物化 adapter 默认，headless 先例）。

### 2. 异常封堵（硬性要求）

agent/created 监听器内任何抛错/拒绝回滚整个子代理创建（interception.spec.ts:618-625）。预检 LlmError 必须 try/catch 降级（跳过指派＋一次性 warn），绝不冒泡。预检结果缓存（registeredRoutes 模式）避免串行阻塞。

### 3. 健康降级步间化（宿主强制语义降档）

重试期间路由固定（agent.ts:421-623 捕获复用，"retained across retries"）。等价能力退化为"步边界换路"：request-error 记账后 select() 换路 ＋ pre-step 步边界重评 select()，均下一 step 生效。select() 幂等控制事件量；冷却恢复 select 回原路由。

### 4. ADR 0009 全套删除

0.2.2-rc.2 的 agent-default-model 已是纯设置服务，瀑布中不存在默认模型注入。defaultModelFallback、pre-step 冲突告警、prepend 顺序保险全部过时——保留反而撞不变量。

### 5. maxTokens：接受继承预算跟随新路由（用户裁定）

select() 只换 provider/model/effort；maxTokens 持续生效。旧 applyOverride 换路由时丢弃继承 maxTokens 的行为不再保留——与官方委托语义一致。README 已知行为改写。

### 6. 通知改造

pre-step 通知改读 `payload.modelSelection` 真值（不再内部推导）。对比 modelSelection 与意图/上次报告目标，不同则发通知。去重沿用 noticedLabel WeakMap。

### 7. 冷恢复幂等

agent/created 以 source:'resume' 重触发。select() 自带幂等；WeakMap 以 Agent 对象为键，新 incarnation 天然满足。

### 8. agent/request 空壳保留

模型改写逻辑全部移除后，保留 `await next()` 直通空壳（瀑布链完整性；未来可恢复 controls 调整）。

## 功能影响

| 功能 | 影响 |
|---|---|
| 角色关键词匹配 | ✅ 完整保留 |
| 策略（钉定/轮询/随机/优先级） | ✅ 完整保留 |
| 兜底模型 | ✅ 完整保留 |
| 健康降级/冷却 | ⚠️ 步边界换路（宿主强制） |
| fork 子代 | ✅ 保留排除 |
| 转录通知 | ✅ 保留（读 modelSelection 真值） |
| maxTokens | ✅ 继承预算跟随（行为变化已裁定） |
| 步中换路由 | ❌ 0.2.2-rc.2 全面禁止 |

## 任务清单（M1-M12）

| ID | 任务 | 验收标准 | 不动面 |
|---|---|---|---|
| M1 | ADR 0010 落盘 | 八决策＋取代/存活清单＋功能影响 | — |
| M2 | 独立审核 R10-R1 | 六修正对照＋取代面＋覆盖度；修复后复核放行 | — |
| M3 | agent/created 监听器 | 守卫 agentTeams＋matchByKeyword＋resolveCallConfig 预检 try/catch＋select()；load.spec 先红 | matchByKeyword/validateStrategyConfig 纯函数保留 |
| M4 | 健康降级步间化 | request-error 记账后 select()＋pre-step 重评 select()；冷却恢复 select 回 | RouteHealth 纯函数保留 |
| M5 | 删除旧架构 | agent/request 模型改写链全部删（空壳保留）；ADR 0009 代码段删；src/index.ts:777/804 悬空引用改写 | — |
| M6 | 通知改造 | pre-step 读 payload.modelSelection；去重＋showNotice 不变 | settings-controller 不动 |
| M7 | locales | byname.help / advanced.cooldownMsHelp 更新（步边界降级语义） | UI 构件不动 |
| M8 | 文档 | README 双语＋settings/strategy/CHANGELOG 第五次原地改＋ADR 存活面修订引用 | — |
| M9 | 测试全改写 | load.spec 大改（模拟 agent.model.select＋agent/created） | strategy/controller/manifest/takeover/boundary 守卫不动 |
| M10 | 独立复查 R10-R2 | 判别性≥5＋旧代码残留清扫＋回归零破坏 | — |
| M11 | 四门＋装机 | 全绿＋pack＋桌面＋特征验证 | — |
| M12 | 用户终审＋发布 | "子代理不指定模型"不再报错→同意→OIDC→发布 | — |
