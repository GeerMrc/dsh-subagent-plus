# 0010 — agent.model.select() 迁移（取代 agent/request 瀑布模型改写）

日期：2026-11-12 ｜ 状态：用户裁定（v0.0.4 未发布原地改写）｜ 取代：0006 d2 解析链的 agent/request 载体面、0009 全部

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
