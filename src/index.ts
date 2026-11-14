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
  assignedNotice,
  byNameFallbackNotice,
  byNameNotice,
  byNameSkippedNotice,
  byNameTakeoverNotice,
  candidateRoutes,
  classifyFailure,
  createSelectionState,
  deriveStarterRows,
  explicitRouteOf,
  fallbackNotice,
  fallbackRouteOf,
  isValidKeyword,
  matchByKeyword,
  pinnedNotice,
  pinFallbackNotice,
  pinSkippedNotice,
  reassignedNotice,
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
import { capabilityOf } from './capability-scoring.js'
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
  /** Middle-tier takeover route (G3): memoized while the row route cools, so
   *  step boundaries reuse one takeover instead of advancing the rotation
   *  cursor per step. Cleared when the memo itself goes unhealthy. */
  takeover?: PinRoute
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
    void rederive()
  })

  // ─── ADR 0014 d2: derived defaults ───
  // Per-route reasoning tiers resolved once and cached in this closure; the
  // cache empties on adapter updates so derivation self-heals when a model's
  // tier vocabulary changes.
  const tierCache = new Map<string, { efforts?: readonly { id: string }[]; description?: string }>()
  let derivedRows: readonly NameMapEntryView[] = []
  let deriveGeneration = 0
  let deriveInFlight: Promise<void> | undefined

  /** Catalogue extras for one route (ADR 0015): reasoning tiers plus the
   *  description tie-break hint, both from the official resolveModelInfo —
   *  the same source the client's modelCatalog view is built from. */
  const catalogueExtrasOf = async (route: PinRoute): Promise<{ efforts?: readonly { id: string }[]; description?: string }> => {
    const key = routeKey(route)
    const cached = tierCache.get(key)
    if (cached !== undefined) return cached
    let llm: unknown
    try {
      llm = ctx.get('llm')
    } catch {
      return {}
    }
    if (llm === undefined || typeof llm !== 'object') return {}
    const resolve = (llm as { resolveModelInfo?: unknown }).resolveModelInfo
    if (typeof resolve !== 'function') return {}
    try {
      const settled: unknown = await (resolve as (provider: string, model: string) => unknown)(route.provider, route.model)
      const info = settled as { reasoning?: { efforts?: readonly { id: string }[] }; description?: string } | undefined
      const efforts = info?.reasoning?.efforts === undefined ? undefined : info.reasoning.efforts.map(effort => ({ id: effort.id }))
      const extras = { efforts, description: info?.description }
      tierCache.set(key, extras)
      return extras
    } catch {
      // Failures stay uncached — the next derivation retries.
      return {}
    }
  }

  /** The effective mapping rows: derived under defaults-on (spread only, the
   *  R1 gate — derivation must never outrank a configured pin), stored rows
   *  otherwise. Derived rows only ever reference listed candidates, and
   *  decideByName's priority guard drops any stale row after a config change. */
  const effectiveNameMapOf = (config: PinConfig): readonly NameMapEntryView[] =>
    config.nameMapDefaults && resolveStrategyPlan(config).kind === 'spread'
      ? derivedRows
      : config.nameMap ?? []

  /** Re-derive the default rows from the live candidates (generation-guarded:
   *  in-flight requests dedupe, a request landing mid-flight re-runs once so
   *  the cache never settles on stale input). */
  let unknownExcludedSignature = ''
  const rederive = (): Promise<void> => {
    deriveGeneration += 1
    if (deriveInFlight !== undefined) return deriveInFlight
    deriveInFlight = (async () => {
      try {
        for (let settled = false; !settled;) {
          const startedAt = deriveGeneration
          const config = live.current()
          const withExtras = await Promise.all(candidatesOf(config).map(async route => ({
            provider: route.provider,
            model: route.model,
            ...await catalogueExtrasOf(route),
          })))
          const deriving = config.nameMapDefaults && resolveStrategyPlan(config).kind === 'spread'
          derivedRows = deriving
            ? deriveStarterRows(withExtras, { overrides: config.capabilityOverrides ?? [] })
            : []
          if (deriving) {
            // Silent-exclusion witness (ADR 0016 3a F2): in a mixed list the
            // unknown candidates hold zero rows (A-1) — say so once per
            // distinct unknown-set, so re-derives stay quiet and a rescue
            // override's silence is meaningful.
            const overrides = config.capabilityOverrides ?? []
            const unknownIds = withExtras
              .filter(route => capabilityOf(route.model, overrides, undefined, route.provider).unknown)
              .map(route => routeId(route))
            if (unknownIds.length > 0 && unknownIds.length < withExtras.length && unknownIds.join(',') !== unknownExcludedSignature) {
              unknownExcludedSignature = unknownIds.join(',')
              ctx.logger.warn(`dsh-subagent-plus: ${unknownIds.length} candidate(s) unknown to the capability KB hold no rows while a known candidate fills every slot (${unknownIds.join(' · ')}); import an evaluation override in the settings page to include them`)
            }
          }
          settled = deriveGeneration === startedAt
        }
      } finally {
        deriveInFlight = undefined
      }
    })()
    return deriveInFlight
  }

  // First derivation once the llm service exists (before that, derivation is
  // dormant — the same semantics as an empty stored map).
  ctx.inject(['llm'], () => { void rederive() })

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
  /** Middle tier for a Team row whose route is cooling or unregistered (G3,
   *  ADR 0016 3c): the next healthy CANDIDATE takes over before the fallback
   *  is ever consulted — bench candidates stop being idle. Memoized per
   *  decision for the cooldown episode (cursor stability). */
  const byNameTakeoverOf = async (config: PinConfig, decision: ByNameDecision): Promise<PinRoute | undefined> => {
    if (decision.takeover !== undefined) {
      if (healthyNow(config)(decision.takeover)
        && (!config.failOpen || await routeRegistered(ctx, decision.takeover.provider, decision.takeover.model))) {
        return decision.takeover
      }
      decision.takeover = undefined
    }
    const plan = resolveStrategyPlan(config)
    if (plan.kind !== 'spread') return undefined
    const next = selectChildRoute(plan.strategy, await usableCandidates(config), healthyNow(config), selection, Math.random, decision.route)
    if (next !== undefined) decision.takeover = next
    return next
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
    const rows = effectiveNameMapOf(config)
    if (rows.length === 0) return undefined
    const memo = byNameDecisions.get(agent)
    if (memo !== undefined) return memo
    const name = nameOf(agent)
    if (name === undefined || name === '') return undefined
    const row = matchByKeyword(name, rows)
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
      // Health/registration check at select-time (ADR 0010 step-boundary
      // semantics). Three-tier chain (G3): row route → next healthy candidate
      // → fallback; each branch keeps its pre-G3 terminal semantics.
      if (config.failOpen && !await routeRegistered(ctx, byName.route.provider, byName.route.model)) {
        const key = routeKey(byName.route)
        if (!unregisteredNameRoutes.has(key)) {
          unregisteredNameRoutes.add(key)
          ctx.logger.warn(`dsh-subagent-plus: mapped route "${routeId(byName.route)}" is not registered; falling back or keeping resolved route`)
        }
        return await byNameTakeoverOf(config, byName) ?? await usableFallbackOf(config) ?? undefined
      }
      if (!healthyNow(config)(byName.route)) {
        return await byNameTakeoverOf(config, byName) ?? await usableFallbackOf(config) ?? byName.route
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
    if (model === undefined) return
    let config = live.current()
    // Fork children are excluded unless pinForkChildren (same semantics as before).
    if (!config.pinForkChildren && isForkedChild(agent)) {
      // A mapped name on a fork teammate: warn once (same as before).
      if (!forkNameWarned && effectiveNameMapOf(config).length > 0) {
        const name = nameOf(agent)
        if (name !== undefined && matchByKeyword(name, effectiveNameMapOf(config)) !== undefined) {
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
      // ADR 0014 d2: await the in-flight derivation — a child arriving before
      // the first derivation still sees the derived rows; re-read the config
      // afterwards so a commit landing inside that window is not missed.
      await rederive()
      config = live.current()
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
    lastFailureCodes.set(agent, failure.code)
    const fallback = fallbackRouteOf(config)
    const failurePlan = resolveStrategyPlan(config)
    const failurePin = failurePlan.kind === 'pinned' ? resolvePin(config) : undefined
    if (!candidatesOf(config).some(route => route.provider === provider)
      && fallback?.provider !== provider && failurePin?.provider !== provider
      && !effectiveNameMapOf(config).some(row => row.provider === provider)) return
    const now = Date.now()
    const until = now + Math.max(failure.providerRetryAfterMs ?? 0, config.cooldownMs)
    if (failureClass === 'sticky-provider') {
      health.markProvider(provider, until, failure.code)
      ctx.logger.warn(`dsh-subagent-plus: provider "${provider}" failed (${failure.code}); every route of it cools down for ${until - now}ms`)
      return
    }
    const decision = decisions.get(agent)
    const byName = byNameDecisions.get(agent)
    const lastFailureCode = lastFailureCodes.get(agent)
    let model: string | undefined
    if (byName !== undefined && byName.route.provider === provider) {
      model = byName.route.model
    } else if (byName !== undefined && byName.takeover !== undefined && byName.takeover.provider === provider) {
      // G3: a failure on the takeover candidate cools that route too —
      // without this the middle tier would keep serving a failing route.
      model = byName.takeover.model
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
    // Synchronous listener: reads the derived-rows cache only — before the
    // first derivation completes, defaults mode is dormant (empty-map
    // semantics) and agent/created performs the awaited derivation.
    if (effectiveNameMapOf(config).length === 0) return
    if (!config.pinForkChildren && isForkedChild(agent)) return
    // ADR 0013 d4: an explicit delegator pick yields the same here as at
    // agent/created — the keyword map never overrides it.
    if (config.respectExplicit && resolveStrategyPlan(config).kind === 'spread'
      && explicitRouteOf(agent.options, parentRouteOf(ctx, agent)) !== undefined) return
    const byName = decideByName(config, agent)
    if (byName === undefined) return
    const model = agentModelOf(agent)
    if (model === undefined) return
    // S8 (audit Y-6): the synchronous hook must not select a cooling route —
    // skip and let the step boundary pick the next healthy candidate (the
    // agent/created path keeps owning the async registration check).
    if (!healthyNow(config)(byName.route)) return
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
      || effectiveNameMapOf(config).length > 0
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
    // Determine what notice to show based on the current route vs intent
    // (ADR 0010 M6 in full — R-1: the spread assignment and step-boundary
    // reassignment notices were lost in the migration, leaving e2e Flow A/B
    // standards and the locale promises unbacked).
    const byName = byNameDecisions.get(agent)
    const spread = decisions.get(agent)
    let text: string | undefined
    if (byName !== undefined && byName.route.provider === currentRoute.provider && byName.route.model === currentRoute.model) {
      text = byNameNotice(byName.name, routeId(currentRoute))
    } else if (byName !== undefined) {
      // Off its mapped route (G3): name the takeover candidate or the
      // fallback hand-off — the byName chain's own vocabulary, not the
      // generic fallback notice.
      if (byName.takeover !== undefined && byName.takeover.provider === currentRoute.provider && byName.takeover.model === currentRoute.model) {
        text = byNameTakeoverNotice(byName.name, routeId(byName.route), routeId(currentRoute))
      } else {
        const fallback = fallbackRouteOf(config)
        if (fallback !== undefined && fallback.provider === currentRoute.provider && fallback.model === currentRoute.model) {
          text = byNameFallbackNotice(routeId(byName.route), routeId(currentRoute))
        }
      }
    } else {
      const plan = resolveStrategyPlan(config)
      const pin = plan.kind === 'pinned' ? resolvePin(config) : undefined
      if (pin !== undefined && pin.provider === currentRoute.provider && pin.model === currentRoute.model) {
        text = pinnedNotice(routeId(currentRoute))
      } else if (spread !== undefined && spread.kind === 'assigned' && spread.via === 'strategy'
        && spread.route.provider === currentRoute.provider && spread.route.model === currentRoute.model) {
        // The strategy-assigned route is running as assigned — say so once.
        text = assignedNotice(routeId(currentRoute), spread.strategy)
      } else if (spread !== undefined && spread.kind === 'assigned' && spread.via === 'strategy'
        && (spread.route.provider !== currentRoute.provider || spread.route.model !== currentRoute.model)) {
        // Health failover moved the child off its assigned route — name the swap.
        text = reassignedNotice(routeId(spread.route), routeId(currentRoute), lastFailureCodes.get(agent) ?? 'unhealthy')
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

  // Adapter cache invalidation + derived-tier self-healing behind a short
  // merge window (adapter updates can burst).
  const forgetRegisteredRoutes = (): void => { registeredRoutes.clear() }
  let adaptersTimer: ReturnType<typeof setTimeout> | undefined
  ctx.on('llm/adapters-updated', () => {
    forgetRegisteredRoutes()
    tierCache.clear()
    if (adaptersTimer !== undefined) clearTimeout(adaptersTimer)
    adaptersTimer = setTimeout(() => {
      adaptersTimer = undefined
      void rederive()
    }, 200)
  })
  // Dispose hygiene: a scheduled debounce must not fire past fiber teardown.
  ctx.effect(() => () => { if (adaptersTimer !== undefined) clearTimeout(adaptersTimer) })
}

/** Last recorded failure code per agent (feeds the reassignment notice). */
const lastFailureCodes = new WeakMap<object, string>()

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
