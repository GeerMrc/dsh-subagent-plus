# 0012 — 双源名字解析＋inbox/claimed 确定性挂钩

日期：2026-11-13 ｜ 状态：用户批准（v0.0.4 未发布原地补丁）｜ 关联：[0010](2026-11-agent-model-select-migration.md)

## 背景

0.2.2-rc.2 删除了 roster/tryMembership 架构（官方迁移："teammates are subagents"）。插件关键词匹配因 agentTeamsOf 结构守卫返回 undefined 而休眠。原方案 A（读子代 session 的 catalog 事件）被独立审核四重否决：① catalog 在父代 session 非子代；② 事件在 agent/created 之后才写入；③ eventAt API 已 @deprecated；④ 全量扫描性能浪费。

## 决策

### 1. 双源名字解析

`nameOf(agent)` 函数按优先级尝试两个名字源，结构守卫互斥：
- **源 1（0.2.0 宿主）**：`agentTeamsOf(ctx)?.tryMembership(agent)?.name`（保留，roster 架构）
- **源 2（0.2.2+ 宿主）**：`subagentsOf(ctx)?.namesOf(agent)` → `.self`；try/catch 吞 UNAUTHORIZED（创建窗口标志）；'lead' 返回 undefined；嵌套路径如 `dev-frontend/plan-reviewer` 天然兼容 matchByKeyword 子串匹配

### 2. agent/inbox/claimed 确定性挂钩

在 agent/created（策略链照常）之后、model.current() selection 捕获之前：
- inbox.claim 同步 emit（host inbox.ts:111）→ preStep 的 model.current() 捕获（agent.ts:293→294）
- 幂等门：byNameDecisions.has(agent) → 已决策则 return
- 同步 decideByName（namesOf + matchByKeyword，无 await）→ agentModelOf.select() → try/catch 降级
- select() 确定性作用于该子代的**第一个 LLM 请求**

### 3. agent/created 现有逻辑不动

策略链在 agent/created 已工作（SELECT 事件验证）。decideByName 在该点因 namesOf 抛 UNAUTHORIZED 被吞而返回 undefined——安全不干扰。

### 4. 方案 A 否决记录

读子代 catalog 事件：错误 session（父代）、错误时序（agent/created 后写入）、deprecated API（eventAt 禁止新用）、性能浪费（全量扫描）。
