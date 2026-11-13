/**
 * dsh-subagent-plus — route every delegated child agent by one configured
 * strategy: pin all children to a single LLM route (the default), or spread
 * children over several candidate routes (round-robin / random / priority)
 * with health-aware failover and an optional last-resort fallback route.
 *
 * Architecture (ADR 0010): routes are selected at agent creation time via
 * `agent.model.select()` — the official API for pre-step model choices on
 * 0.2.2+ hosts where the `agent/request` waterfall may no longer change
 * provider/model/effort. The plugin listens for `agent/created`, matches the
 * teammate's name against role-keyword rows, pre-validates the route, and
 * records the selection before the first step's preparation captures it.
 *
 * Health-aware failover operates at step boundaries: `agent/request-error`
 * records failures and calls `select()` to swap to the next healthy route
 * for the next step; `agent/pre-step` re-evaluates cooled routes the same
 * way. Mid-step route changes are impossible on 0.2.2+ hosts (retries keep
 * the captured selection — a host invariant, not a plugin limitation).
 *
 * Top-level agents are never touched; fork children are excluded by default
 * to preserve KV-cache route reuse. The `agent/request` listener remains as
 * a pass-through shell for waterfall-chain completeness.
 *
 * @module dsh-subagent-plus
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import {
  childDepthOf,
  isForkedChild,
  resolvePinRoute,
  routeId,
  type PinRoute,
  type RouteFields,
} from './pin.js'
import {
  byNameFallbackNotice,
  byNameNotice,
  byNameSkippedNotice,
  candidateRoutes,
  classifyFailure,
  createSelectionState,
  explicitRouteOf,
  fallbackNotice,
  fallbackRouteOf,
  isValidKeyword,
  matchByKeyword,
  pinnedNotice,
  pinFallbackNotice,
  pinSkippedNotice,
  resolveStrategyPlan,
  routeKey,
  RouteHealth,
  selectChildRoute,
  usableFallback,
  validateStrategyConfig,
  type NameMapEntryView,
  type SpreadStrategy,
} from './strategy.js'
import { materializeConfig, type PinConfig, type PinConfigRuntime } from './config.js'
export { Config } from './config.js'
export type { PinConfig } from './config.js'
import { attachSettingsSection, LivePinConfig } from './settings.js'

export type { PinConfigRuntime } from './config.js'

export const name = 'dsh-subagent-plus'

export const usage = [
  '按策略为所有子智能体（subagent 委派与 Agent Teams 队友）指派 LLM 路由：钉定单一路由，或在多条候选路由间轮询/随机/按优先级分配，支持健康降级与兜底路由。',
  'Route every delegated child agent (subagent delegations and Agent Teams teammates) by strategy: pin one LLM route, or spread children over candidate routes (round-robin / random / priority) with health-aware failover and an optional fallback route.',
].join('\n')

/** A spread strategy's per-child routing record (kept for health tracking). */
interface SpreadDecision {
  kind: 'assigned'
  strategy: SpreadStrategy
  via: 'strategy' | 'fallback'
  route: PinRoute
  noticed: Set<string>
}

type Decision = { kind: 'explicit'; route: PinRoute } | SpreadDecision

/** A by-name child's forced routing record. */
interface ByNameDecision {
  kind: 'by-name'
  name: string
  route: PinRoute
}

/** Structural view of the optional `agentTeams` service. */
interface AgentTeamsLike {
  tryMembership(agent: object): { name?: string } | undefined
}

/** Structural view of `agent.model` (ADR 0010): the official per-Agent model
 *  selection API on 0.2.2+ hosts. `select()` records a durable choice that
 *  step preparation reads before the first request. */
interface AgentModelLike {
  select(selection: { provider: string; model: string; reasoningEffort?: string }): void
  current(): { provider: string; model: string; reasoningEffort?: string } | undefined
}

function agentTeamsOf(ctx: Context): AgentTeamsLike | undefined {
  let service: unknown
  try {
    service = ctx.get('agentTeams')
  } catch {
    return undefined
  }
  if (service === undefined || typeof service !== 'object') return undefined
  return typeof (service as { tryMembership?: unknown }).tryMembership === 'function'
    ? service as AgentTeamsLike
    : undefined
}

/** Structural view of the `subagents` service (ADR 0012): 0.2.2+ hosts expose
 *  namesOf() as the official per-agent name lookup (replacing the removed
 *  roster/tryMembership architecture — "teammates are subagents"). */
interface SubagentsLike {
  namesOf(agent: object): { self?: string } | undefined
}

function subagentsOf(ctx: Context): SubagentsLike | undefined {
  let service: unknown
  try {
    service = ctx.get('subagents')
  } catch {
    return undefined
  }
  if (service === undefined || typeof service !== 'object') return undefined
  return typeof (service as { namesOf?: unknown }).namesOf === 'function'
    ? service as SubagentsLike
    : undefined
}

/** Read agent.model if present (0.2.2+ hosts; older hosts lack the property). */
function agentModelOf(agent: Agent): AgentModelLike | undefined {
  const model = (agent as { model?: unknown }).model
  if (model === undefined || typeof model !== 'object') return undefined
  return typeof (model as { select?: unknown }).select === 'function'
    ? model as AgentModelLike
    : undefined
}

export function apply(ctx: Context, entry: PinConfigRuntime): void {
  const boot = materializeConfig(entry)
  const bootReport = validateStrategyConfig(boot)
  if (bootReport.structural.length > 0) {
    throw new Error(bootReport.structural.join('; '))
  }
  const warnedDegraded = new Set<string>()
  const warnDegraded = (config: PinConfig): void => {
    for (const message of validateStrategyConfig(config).degraded) {
      if (warnedDegraded.has(message)) continue
      warnedDegraded.add(message)
      ctx.logger.warn(message)
    }
  }
  const warnedStructural = new Set<string>()
  const warnStructural = (config: PinConfig): void => {
    for (const message of validateStrategyConfig(config).structural) {
      if (warnedStructural.has(message)) continue
      warnedStructural.add(message)
      ctx.logger.warn(message)
    }
  }
  warnDegraded(boot)

  const live = new LivePinConfig(entry, error => {
    ctx.logger.warn(`dsh-subagent-plus: the committed configuration failed to materialize (${String(error)}); the last good configuration stays in effect`)
  })
  attachSettingsSection(ctx, entry, live, () => {
    live.refresh()
    warnStructural(live.current())
    warnDegraded(live.current())
  })

  const health = new RouteHealth()
  const selection = createSelectionState()
  const decisions = new WeakMap<object, Decision>()
  const byNameDecisions = new WeakMap<object, ByNameDecision>()
  let noCandidateWarned = false
  let unregisteredPinWarned = false
  let agentTeamsAbsentWarned = false
  let forkNameWarned = false
  const unregisteredNameRoutes = new Set<string>()

  const resolvePin = (config: PinConfig): PinRoute | undefined => resolvePinRoute(config)
  const candidatesOf = (config: PinConfig): PinRoute[] => candidateRoutes(config)
  const usableCandidates = async (config: PinConfig): Promise<PinRoute[]> => {
    const all = candidatesOf(config)
    if (!config.failOpen) return all
    const registered = await Promise.all(all.map(route => routeRegistered(ctx, route.provider, route.model)))
    return all.filter((_, index) => registered[index] === true)
  }
  const healthyNow = (config: PinConfig) => (route: PinRoute): boolean =>
    config.cooldownMs === 0 || health.isHealthy(route, Date.now())
  const usableFallbackOf = async (config: PinConfig): Promise<PinRoute | undefined> => {
    const fallback = usableFallback(fallbackRouteOf(config), healthyNow(config))
    if (fallback === undefined) return undefined
    if (config.failOpen && !await routeRegistered(ctx, fallback.provider, fallback.model)) return undefined
    return fallback
  }

  /**
   * Dual-source name resolution (ADR 0012): try the roster-based tryMembership
   * first (0.2.0 hosts); on hosts without it, fall back to the official
   * subagents.namesOf() API (0.2.2+). UNAUTHORIZED from namesOf during the
   * creation window (before resident registration) is swallowed — the
   * inbox/claimed hook retries later.
   */
  const nameOf = (agent: Agent): string | undefined => {
    const teams = agentTeamsOf(ctx)
    if (teams !== undefined) {
      return teams.tryMembership(agent)?.name
    }
    const subs = subagentsOf(ctx)
    if (subs === undefined) {
      if (!agentTeamsAbsentWarned) {
        agentTeamsAbsentWarned = true
        ctx.logger.warn('dsh-subagent-plus: neither agentTeams.tryMembership nor subagents.namesOf is available; by-name mapping stays dormant (children follow the strategy chain)')
      }
      return undefined
    }
    try {
      const names = subs.namesOf(agent)
      if (names === undefined) return undefined
      const name = names.self
      if (name === undefined || name === '' || name === 'lead') return undefined
      return name
    } catch {
      // UNAUTHORIZED during the creation window (agent/created time) — the
      // inbox/claimed hook will retry after resident registration.
      return undefined
    }
  }

  const rowRoute = (row: NameMapEntryView): PinRoute => ({
    provider: row.provider,
    model: row.model,
    ...(row.reasoningEffort === '' ? {} : { reasoningEffort: row.reasoningEffort }),
  })

  // ─── Decision logic (pure, reused by created + step-boundary select) ───

  const decideByName = (config: PinConfig, agent: Agent): ByNameDecision | undefined => {
    if (config.nameMap.length === 0) return undefined
    const memo = byNameDecisions.get(agent)
    if (memo !== undefined) return memo
    const name = nameOf(agent)
    if (name === undefined || name === '') return undefined
    const row = matchByKeyword(name, config.nameMap)
    if (row === undefined) return undefined
    if (!isValidKeyword(row.name) || row.provider === '' || row.model === ''
      || !config.priority.some(listed => listed.provider === row.provider && listed.model === row.model)) {
      return undefined
    }
    const decision: ByNameDecision = { kind: 'by-name', name, route: rowRoute(row) }
    byNameDecisions.set(agent, decision)
    return decision
  }

  const decideFor = async (config: PinConfig, agent: Agent): Promise<Decision | undefined> => {
    const plan = resolveStrategyPlan(config)
    if (plan.kind !== 'spread') return undefined
    const memo = decisions.get(agent)
    if (memo !== undefined) return memo
    const route = selectChildRoute(plan.strategy, await usableCandidates(config), healthyNow(config), selection, Math.random)
    if (route !== undefined) {
      const decision: SpreadDecision = { kind: 'assigned', strategy: plan.strategy, via: 'strategy', route, noticed: new Set() }
      decisions.set(agent, decision)
      return decision
    }
    const fallback = await usableFallbackOf(config)
    if (fallback !== undefined) {
      const decision: SpreadDecision = { kind: 'assigned', strategy: plan.strategy, via: 'fallback', route: fallback, noticed: new Set() }
      decisions.set(agent, decision)
      return decision
    }
    if (!noCandidateWarned) {
      noCandidateWarned = true
      ctx.logger.warn(`dsh-subagent-plus: strategy "${plan.strategy}" found no usable candidate or fallback route; child keeps its resolved route`)
    }
    return undefined
  }

  /** Resolve the intended route for one child (explicit > byName > pinned > spread). */
  const resolveIntendedRoute = async (config: PinConfig, agent: Agent): Promise<PinRoute | undefined> => {
    if (childDepthOf(agent) <= 0) return undefined
    if (!config.pinForkChildren && isForkedChild(agent)) return undefined
    // ADR 0013 d4 (respectExplicit revival): under a spread strategy, an
    // explicit delegator pick — a creation route differing from the parent's
    // current route — outranks both the keyword map and the strategy chain
    // (the community resolution order: explicit spawn > declared policy).
    // Pinned stays a forced assignment the switch never evades.
    if (config.respectExplicit && resolveStrategyPlan(config).kind === 'spread') {
      const explicit = explicitRouteOf(agent.options, parentRouteOf(ctx, agent))
      if (explicit !== undefined) {
        decisions.set(agent, { kind: 'explicit', route: explicit })
        return undefined
      }
    }
    const byName = decideByName(config, agent)
    if (byName !== undefined) {
      // Health/registration check at select-time (ADR 0010 step-boundary semantics)
      if (config.failOpen && !await routeRegistered(ctx, byName.route.provider, byName.route.model)) {
        const key = routeKey(byName.route)
        if (!unregisteredNameRoutes.has(key)) {
          unregisteredNameRoutes.add(key)
          ctx.logger.warn(`dsh-subagent-plus: mapped route "${routeId(byName.route)}" is not registered; falling back or keeping resolved route`)
        }
        return await usableFallbackOf(config) ?? undefined
      }
      if (!healthyNow(config)(byName.route)) {
        return await usableFallbackOf(config) ?? byName.route
      }
      return byName.route
    }
    const plan = resolveStrategyPlan(config)
    if (plan.kind === 'pinned') {
      const pin = resolvePin(config)
      if (pin === undefined) {
        const fallback = await usableFallbackOf(config)
        return fallback ?? undefined
      }
      if (config.failOpen && !await routeRegistered(ctx, pin.provider, pin.model)) {
        if (!unregisteredPinWarned) {
          unregisteredPinWarned = true
          ctx.logger.warn(`dsh-subagent-plus: pinned route "${routeId(pin)}" is not registered; child uses the fallback or keeps its resolved route`)
        }
        const fallback = await usableFallbackOf(config)
        return fallback ?? undefined
      }
      if (!healthyNow(config)(pin)) {
        const fallback = await usableFallbackOf(config)
        return fallback ?? pin
      }
      return pin
    }
    const decision = await decideFor(config, agent)
    if (decision === undefined || decision.kind === 'explicit') return undefined
    // ADR 0010 d3: a cooling route re-evaluates to the next healthy candidate
    // or the fallback for the next step boundary select.
    if (!healthyNow(config)(decision.route)) {
      const plan = resolveStrategyPlan(config)
      if (plan.kind === 'spread') {
        const next = selectChildRoute(plan.strategy, await usableCandidates(config), healthyNow(config), selection, Math.random, decision.route)
        if (next !== undefined) return next
      }
      return await usableFallbackOf(config) ?? decision.route
    }
    return decision.route
  }

  // ─── ADR 0010 M3: agent/created listener — select() before step prep ───

  ctx.on('agent/created', async (payload) => {
    const agent = payload.agent
    if (childDepthOf(agent) <= 0) return
    const model = agentModelOf(agent)
    if (model === undefined) return // Pre-0.2.2 host: no select() API; old agent/request fallback doesn't exist either (deprecated).
    const config = live.current()
    // Fork children are excluded unless pinForkChildren (same semantics as before).
    if (!config.pinForkChildren && isForkedChild(agent)) {
      // A mapped name on a fork teammate: warn once (same as before).
      if (!forkNameWarned && config.nameMap.length > 0) {
        const name = nameOf(agent)
        if (name !== undefined && matchByKeyword(name, config.nameMap) !== undefined) {
          forkNameWarned = true
          ctx.logger.warn(`dsh-subagent-plus: role keyword "${name}" matches a fork teammate; fork children keep their inherited route (enable pinForkChildren to route them)`)
        }
      }
      return
    }
    // Resolve the intended route (keyword > pinned > spread, with health/registration checks).
    // ADR 0010 d2: ANY throw here rolls back the entire agent creation —
    // every async operation must be caught and degraded.
    try {
      const route = await resolveIntendedRoute(config, agent)
      if (route === undefined) return
      const selection: { provider: string; model: string; reasoningEffort?: string } = {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      }
      model.select(selection)
      ctx.logger.info(`dsh-subagent-plus: selected route "${routeId(route)}" for child agent at creation (ADR 0010)`)
    } catch (error: unknown) {
      // ADR 0010 d2 hard requirement: degrade silently, never propagate.
      ctx.logger.warn(`dsh-subagent-plus: route selection at agent creation failed (${String(error)}); the child keeps its inherited route`)
    }
  })

  // ─── ADR 0010 M4: health failover at step boundaries ───

  const recordFailure = (config: PinConfig, agent: Agent, provider: string, failure: LlmFailure): void => {
    const failureClass = classifyFailure(failure.code, failure.status)
    if (failureClass === 'ignore') return
    const fallback = fallbackRouteOf(config)
    const failurePlan = resolveStrategyPlan(config)
    const failurePin = failurePlan.kind === 'pinned' ? resolvePin(config) : undefined
    if (!candidatesOf(config).some(route => route.provider === provider)
      && fallback?.provider !== provider && failurePin?.provider !== provider
      && !config.nameMap.some(row => row.provider === provider)) return
    const now = Date.now()
    const until = now + Math.max(failure.providerRetryAfterMs ?? 0, config.cooldownMs)
    if (failureClass === 'sticky-provider') {
      health.markProvider(provider, until, failure.code)
      ctx.logger.warn(`dsh-subagent-plus: provider "${provider}" failed (${failure.code}); every route of it cools down for ${until - now}ms`)
      return
    }
    const decision = decisions.get(agent)
    const byName = byNameDecisions.get(agent)
    let model: string | undefined
    if (byName !== undefined && byName.route.provider === provider) {
      model = byName.route.model
    } else if (decision !== undefined && decision.route.provider === provider) {
      model = decision.route.model
    } else {
      model = failurePin?.provider === provider
        ? failurePin.model
        : fallback?.provider === provider
          ? fallback.model
          : undefined
    }
    if (model === undefined) model = agent.session?.requestHeader?.()?.config?.model
    if (model === undefined) return
    health.markRoute({ provider, model }, until, failure.code)
    ctx.logger.warn(`dsh-subagent-plus: route "${routeId({ provider, model })}" failed (${failure.code}); cooling down for ${until - now}ms`)
  }

  /** Swap to the next healthy route for the NEXT step (ADR 0010 d3). */
  const selectNextHealthyRoute = async (config: PinConfig, agent: Agent): Promise<void> => {
    const model = agentModelOf(agent)
    if (model === undefined) return
    try {
      const route = await resolveIntendedRoute(config, agent)
      if (route === undefined) return
      const current = model.current()
      if (current !== undefined && current.provider === route.provider && current.model === route.model) return // already there
      model.select({ provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) })
      ctx.logger.info(`dsh-subagent-plus: step-boundary route swap to "${routeId(route)}" for the next step (ADR 0010 d3)`)
    } catch {
      // Degrade silently; the child keeps its current route for the next step.
    }
  }

  // ─── ADR 0012: inbox/claimed hook — deterministic by-name routing on 0.2.2+ hosts.
  // Fires synchronously during preStep's inbox.claim(), BEFORE model.current()
  // captures the selection (host agent.ts:293→294). At this point the subagents
  // service's resident table is populated and namesOf() works. The WeakMap
  // idempotence gate prevents re-selecting for already-decided agents.
  ctx.on('agent/inbox/claimed', (payload: { agent: Agent }) => {
    const agent = payload.agent
    if (childDepthOf(agent) <= 0) return
    if (byNameDecisions.has(agent)) return
    const config = live.current()
    if (config.nameMap.length === 0) return
    if (!config.pinForkChildren && isForkedChild(agent)) return
    // ADR 0013 d4: an explicit delegator pick yields the same here as at
    // agent/created — the keyword map never overrides it.
    if (config.respectExplicit && resolveStrategyPlan(config).kind === 'spread'
      && explicitRouteOf(agent.options, parentRouteOf(ctx, agent)) !== undefined) return
    const byName = decideByName(config, agent)
    if (byName === undefined) return
    const model = agentModelOf(agent)
    if (model === undefined) return
    try {
      const route = byName.route
      model.select({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      })
      ctx.logger.info(`dsh-subagent-plus: selected route "${routeId(route)}" for "${byName.name}" at inbox/claimed (ADR 0012)`)
    } catch {
      // Degrade silently; the agent keeps its inherited/strategy route.
    }
  })

  // Failure recording + step-boundary select (prepend: before llm-retry vetoes).
  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    const config = live.current()
    const routed = resolveStrategyPlan(config).kind === 'spread' || fallbackRouteOf(config) !== undefined
      || config.nameMap.length > 0
    if (routed && config.cooldownMs > 0) {
      recordFailure(config, payload.agent, payload.provider, payload.failure)
      // ADR 0010 d3: select the next healthy route for the next step.
      if (childDepthOf(payload.agent) > 0) {
        await selectNextHealthyRoute(config, payload.agent)
      }
    }
    return next()
  }, { prepend: true })

  // ─── ADR 0010 M6: pre-step notices (read modelSelection truth) ───

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    const config = live.current()
    if (!config.showNotice) return decision
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    if (decision.messages.length === 0 && (payload.step === 1 || payload.messages.length > 0)) {
      return decision
    }
    const agent = payload.agent
    if (childDepthOf(agent) <= 0) return decision
    if (!config.pinForkChildren && isForkedChild(agent)) return decision
    // ADR 0010 d6: read the step's actual modelSelection (truth), not a derived route.
    const modelSelection = (payload as { modelSelection?: { provider: string; model: string; reasoningEffort?: string } }).modelSelection
    if (modelSelection === undefined) return decision
    const currentRoute: PinRoute = {
      provider: modelSelection.provider,
      model: modelSelection.model,
      ...(modelSelection.reasoningEffort === undefined ? {} : { reasoningEffort: modelSelection.reasoningEffort }),
    }
    // Determine what notice to show based on the current route vs intent.
    const byName = byNameDecisions.get(agent)
    let text: string | undefined
    if (byName !== undefined && byName.route.provider === currentRoute.provider && byName.route.model === currentRoute.model) {
      text = byNameNotice(byName.name, routeId(currentRoute))
    } else {
      const plan = resolveStrategyPlan(config)
      const pin = plan.kind === 'pinned' ? resolvePin(config) : undefined
      if (pin !== undefined && pin.provider === currentRoute.provider && pin.model === currentRoute.model) {
        text = pinnedNotice(routeId(currentRoute))
      } else {
        const fallback = fallbackRouteOf(config)
        if (fallback !== undefined && fallback.provider === currentRoute.provider && fallback.model === currentRoute.model) {
          text = fallbackNotice(routeId(currentRoute))
        }
      }
    }
    if (text === undefined) return decision
    const targetLabel = routeId(currentRoute)
    if (noticedLabel.get(agent) === targetLabel) return decision
    noticedLabel.set(agent, targetLabel)
    const notice = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'model-selection', form: 'notice', summary: boundContextSummary(targetLabel) },
    })
    return { ...decision, messages: [...decision.messages, notice] }
  })

  // ─── ADR 0010 d8: agent/request empty shell (waterfall completeness) ───
  ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    return await next()
  })

  // Adapter cache invalidation.
  const forgetRegisteredRoutes = (): void => { registeredRoutes.clear() }
  ctx.on('llm/adapters-updated', forgetRegisteredRoutes)
}

/** One notice per agent per distinct route target. */
const noticedLabel = new WeakMap<object, string>()

/** Successful validations are memoized; failures retry on later requests. */
const registeredRoutes = new Set<string>()

async function routeRegistered(ctx: Context, provider: string, model: string): Promise<boolean> {
  if (registeredRoutes.has(routeKey({ provider, model }))) return true
  const llm = ctx.get('llm')
  if (llm === undefined) return true
  try {
    if (!llm.listProviders().some(candidate => candidate.id === provider)) return false
    const models = await llm.listModels(provider)
    if (!models.some(candidate => candidate.id === model)) return false
  } catch (error: unknown) {
    if (error instanceof TypeError) return false
    return true
  }
  registeredRoutes.add(routeKey({ provider, model }))
  return true
}

/** The delegating Session's current route (best-effort). */
function parentRouteOf(ctx: Context, agent: Agent): RouteFields | undefined {
  const parentId = agent.session?.header?.parentSession
  if (parentId === undefined) return undefined
  let sessions
  try {
    sessions = ctx.get('sessions')
  } catch {
    return undefined
  }
  if (sessions === undefined) return undefined
  try {
    return sessions.get(parentId)?.requestHeader()?.config
  } catch {
    return undefined
  }
}
