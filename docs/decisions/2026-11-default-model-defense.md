# 0009 — 宿主默认模型冲突防御＋兼容性加固

日期：2026-11-12 ｜ 状态：用户裁定（实测报错后指令加固），随 v0.0.4 发布 ｜ 关联：[0008](2026-11-byname-keyword-matching.md)

## 背景

用户桌面（rc.3+）实测报错 `agent/request proposed "strata/..." after step preparation fixed "sz/..."`。根因：rc.3+ 宿主将 `installModelSelection` 扩展到子代理（rc.2 明确排除子代理——`hasApiSessionSubagentOwner` 守卫），子代理未指定模型时默认模型机制填入 strata，与 descriptor 继承的 sz 冲突，触发新不变量检查。**插件不在 causation chain 上，但可以通过防御性改写消除分歧。**

## 决策

### 1. C. pre-step 冲突预警（纯诊断，不改行为）

在 `agent/pre-step` 头部检测：孩子深度>0 且首请求（`requestHeader() === undefined`）且 `ctx.get('agentDefaultModel')?.currentSelection()` 的 provider/model ≠ `agent.options` 的继承路由。检测到即 `ctx.logger.warn`（一次性 latch）＋ notice 追加冲突声明。守卫消费 `agentDefaultModel` 服务（同 agentTeams 模式），不可用时静默跳过。

### 2. A'. 请求期兜底：早退分支的默认模型回退

在 `agent/request` 的两个早退分支（fork 豁免、无可用路由）中：检测 `resolved` 的 provider/model 恰等于 `agentDefaultModel.currentSelection()`（即宿主默认注入是分歧来源）→ 改写 `resolved` 为 `agent.options` 路由（继承值），消除分歧；记一次性诊断日志。正常命中分支（byName/pinned/spread）已有覆盖，不改。顶层不改（options ≠ resolved 是宿主合法常态——用户换模型）。

### 3. B. prepend 注册（顺序保险）

`ctx.on('agent/request', ...)` 加 `{ prepend: true }`。对当前 bug 无直接效果（installModelSelection 是 per-agent 注册、永远晚于启动期监听器），但防御未来宿主把默认注入改为启动期根级监听器时覆盖插件的 pin。廉价保险，零风险。

### 4. notice source.kind 去冒名

现有 notice 的 `source.kind: 'model-selection'` 与宿主官方换模型通知同 kind，rc.3+ 的 model-selection-projection 可能误归因。改为 `'dsh-subagent-plus'`（与命名空间一致的自有 kind）。

### 5. parentRouteOf 防御性 catch

`sessions.get(id)?.requestHeader()?.config` 路径 rc.3+ 改名则静默返回 undefined。加 try/catch ＋ 一次性 warn。

### 6. routeRegistered 保守化

catch-all 返回 false 导致所有路由判为未注册（插件行为退化为 fallback/保持原路由）。改为：仅当 API 方法确认不存在（TypeError）时返回 false，其他异常返回 true（保守——宁可多检一次不静默禁用）。

## 不推荐的方案

- **对顶层 agent 做 options↔resolved 一致性改写**：宿主合法常态（用户换模型后 persisted header ≠ 创建 options）
- **放弃 `await next()` 语义直接 veto**：cordis waterfall 不调 next 即否决整条链，会拦掉宿主合法深层监听器
- **在 pre-step 尝试"纠正"路由**：时序上路由尚不存在，无纠正对象

## 验证盲区（如实声明）

rc.3+ 不变量的确切位置与校验时机（瀑布整体返回后 vs 瀑布内逐级）在本地 rc.2 检出中不可见。A' 方案假设校验在整体返回后（插件最终输出已是配置路由，理论上不触发）；若校验在瀑布内部逐级执行，则需进一步测试确认。上线前应在 rc.3+ 桌面用"子代理不指定模型＋默认模型≠父路由"场景做 E2E。
