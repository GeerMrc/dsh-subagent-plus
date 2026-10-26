/**
 * dsh-subagent-plus — route every delegated child agent by one configured
 * strategy: pin all children to a single LLM route (the default), or spread
 * children over several candidate routes (round-robin / random / priority)
 * with health-aware failover and an optional last-resort fallback route.
 *
 * Covers both delegation paths the shipped composition leaves unpinnable in
 * 0.2.0-rc.2: `subagent` tool children in Sessions that never sampled the
 * model-selection policy (resumed or pre-setting Sessions), and Agent Teams
 * teammates spawned via `spawn_teammate`, which carries no model parameter at
 * all. Top-level agents keep the Session's own model selection untouched;
 * fork children are excluded by default to preserve their KV-cache route
 * reuse.
 *
 * Routes apply on the `agent/request` waterfall after deeper listeners, so an
 * explicit per-call selection made by the delegating model is also
 * overridden unless `respectExplicit` is on — this plugin is a deliberate
 * assignment, not an allowlist. A spread strategy decides once per child on
 * its first request and keeps that route for the child's lifetime; only a
 * route entering cooldown moves the child to the next healthy candidate, and
 * the configured fallback route answers when no candidate is usable.
 *
 * Failures are observed on `agent/request-error` and always delegated, so the
 * official retry plugin keeps every retry decision; the retry's re-dispatched
 * `agent/request` is where a cooled route is swapped.
 *
 * Every settings-page-editable field is volatile: configuration is read
 * through a {@link LivePinConfig} on each decision, so a committed settings
 * change reaches the next child request without restarting the plugin (and
 * without resetting health, rotation, or sticky decisions).
 *
 * @module dsh-subagent-plus
 */
import type { Context } from '@deepseek-ai/cordis'
// Ambient event declarations for `agent/request`, `agent/request-error`, and `agent/pre-step`.
import type {} from '@deepseek-ai/dsh-agent'
// Ambient service typing for `ctx.llm` plus the call-config types.
import type {} from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
// Ambient `AgentOptions.subagentDepth` augmentation owned by the subagent runtime.
import type {} from '@deepseek-ai/dsh-subagent'
// Ambient `ctx.subagentModelSelection` service augmentation (optional at runtime).
import type {} from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import {
  childDepthOf,
  isForkedChild,
  pinnedRoute,
  resolvePinRoute,
  type OfficialModelSelectionSettings,
  type PinOverride,
  type PinRoute,
  type RouteFields,
} from './pin.js'
import {
  assignedNotice,
  candidateRoutes,
  classifyFailure,
  createSelectionState,
  explicitRouteOf,
  fallbackNotice,
  fallbackRouteOf,
  reassignedNotice,
  resolveStrategyPlan,
  RouteHealth,
  selectChildRoute,
  usableFallback,
  validateStrategyConfig,
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

/**
 * A spread strategy's per-child routing record. `via` distinguishes a
 * strategy assignment from a fallback landing so the transcript notice names
 * what actually happened.
 */
interface SpreadDecision {
  kind: 'assigned'
  strategy: SpreadStrategy
  /** Whether the route came from the strategy or from the fallback. */
  via: 'strategy' | 'fallback'
  /** Route every request of this child runs; replaced only by failover. */
  route: PinRoute
  /** Notice texts already appended to this child's transcript. */
  noticed: Set<string>
  /** Failover awaiting its transcript notice. */
  pendingFailover?: { from: PinRoute; to: PinRoute; code: string }
}

type Decision = { kind: 'explicit'; route: PinRoute } | SpreadDecision

export function apply(ctx: Context, entry: PinConfigRuntime): void {
  // Structural problems refuse to load (softened when disabled: the hooks
  // stay inert, so the plugin loads anyway); cross-field combinations that a
  // settings page could persist degrade with a warning instead of throwing —
  // throwing on load would brick the plugin on the next Host restart.
  const boot = materializeConfig(entry)
  const bootReport = validateStrategyConfig(boot)
  if (boot.enabled && bootReport.structural.length > 0) {
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
  warnDegraded(boot)

  // Read-time configuration: every decision below re-materializes, so a
  // committed settings change reaches the next child request without a
  // plugin reload (health, rotation, and sticky decisions survive edits).
  const live = new LivePinConfig(entry, error => {
    ctx.logger.warn(`dsh-subagent-plus: the committed configuration failed to materialize (${String(error)}); the last good configuration stays in effect`)
  })
  attachSettingsSection(ctx, entry, live, () => {
    live.refresh()
    warnDegraded(live.current())
  })

  const health = new RouteHealth()
  const selection = createSelectionState()
  const decisions = new WeakMap<object, Decision>()
  let noCandidateWarned = false
  let unregisteredPinWarned = false

  // Read per use: the official preference is volatile and may change while
  // the Host runs, and the read costs two getters next to a full LLM request.
  const readSettings = (): OfficialModelSelectionSettings | undefined => {
    try {
      // Structural read of the optional host service; the official face is
      // not a compile-time peer of this plugin.
      return ctx.get('subagentModelSelection') as OfficialModelSelectionSettings | undefined
    } catch {
      return undefined
    }
  }
  const resolvePin = (config: PinConfig): PinRoute | undefined => {
    try {
      return resolvePinRoute(config, readSettings())
    } catch {
      logSettingsFailureOnce(ctx)
      return undefined
    }
  }
  const candidatesOf = (config: PinConfig): PinRoute[] => {
    const plan = resolveStrategyPlan(config)
    if (plan.kind !== 'spread') return []
    try {
      return candidateRoutes(plan, config, readSettings())
    } catch {
      logSettingsFailureOnce(ctx)
      return []
    }
  }
  const usableCandidates = async (config: PinConfig): Promise<PinRoute[]> => {
    const all = candidatesOf(config)
    if (!config.failOpen) return all
    const registered = await Promise.all(all.map(route => routeRegistered(ctx, route.provider, route.model)))
    return all.filter((_, index) => registered[index] === true)
  }
  const healthyNow = (config: PinConfig) => (route: PinRoute): boolean =>
    config.cooldownMs === 0 || health.isHealthy(route, Date.now())
  /** The fallback narrowed by health, and by registration under `failOpen`. */
  const usableFallbackOf = async (config: PinConfig): Promise<PinRoute | undefined> => {
    const fallback = usableFallback(fallbackRouteOf(config), healthyNow(config))
    if (fallback === undefined) return undefined
    if (config.failOpen && !await routeRegistered(ctx, fallback.provider, fallback.model)) return undefined
    return fallback
  }

  /** Decide a spread child's route once; later calls return the memoized decision. */
  const decideFor = async (config: PinConfig, agent: Agent): Promise<Decision | undefined> => {
    const plan = resolveStrategyPlan(config)
    if (plan.kind !== 'spread') return undefined
    const memo = decisions.get(agent)
    if (memo !== undefined) return memo
    if (config.respectExplicit) {
      const explicit = explicitRouteOf(agent.options, parentRouteOf(ctx, agent))
      if (explicit !== undefined) {
        const decision: Decision = { kind: 'explicit', route: explicit }
        decisions.set(agent, decision)
        return decision
      }
    }
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
      ctx.logger.warn(`dsh-subagent-plus: strategy "${plan.strategy}" found no usable candidate or fallback route; child requests keep their resolved route`)
    }
    return undefined
  }

  /** Move a child off a cooling route when another healthy candidate or the fallback exists. */
  const failoverIfCooling = async (config: PinConfig, decision: SpreadDecision): Promise<void> => {
    const plan = resolveStrategyPlan(config)
    if (plan.kind !== 'spread' || config.cooldownMs === 0) return
    const cooling = health.cooldown(decision.route, Date.now())
    if (cooling === undefined) return
    const next = selectChildRoute(plan.strategy, await usableCandidates(config), healthyNow(config), selection, Math.random, decision.route)
      ?? await usableFallbackOf(config)
    if (next === undefined || routeKeyEquals(next, decision.route)) return
    decision.pendingFailover = { from: decision.route, to: next, code: cooling.code }
    ctx.logger.warn(
      `dsh-subagent-plus: route "${label(decision.route)}" is cooling down (${cooling.code}); `
      + `child agent continues with "${label(next)}"`,
    )
    decision.route = next
  }

  const recordFailure = (config: PinConfig, agent: Agent, provider: string, failure: LlmFailure): void => {
    const failureClass = classifyFailure(failure.code, failure.status)
    if (failureClass === 'ignore') return
    const fallback = fallbackRouteOf(config)
    if (!candidatesOf(config).some(route => route.provider === provider) && fallback?.provider !== provider) return
    const now = Date.now()
    const until = now + Math.max(failure.providerRetryAfterMs ?? 0, config.cooldownMs)
    if (failureClass === 'sticky-provider') {
      health.markProvider(provider, until, failure.code)
      ctx.logger.warn(`dsh-subagent-plus: provider "${provider}" failed (${failure.code}); every route of it cools down for ${until - now}ms`)
      return
    }
    const decision = decisions.get(agent)
    let model: string | undefined
    if (decision !== undefined && decision.route.provider === provider) {
      model = decision.route.model
    } else {
      const plan = resolveStrategyPlan(config)
      const pin = plan.kind === 'pinned' ? resolvePin(config) : undefined
      // A pinned child has no decision entry: attribute to the pinned route
      // first, so a same-provider fallback is never cooled for the pin's
      // failure; the fallback model applies only when the pin is unresolved.
      model = pin?.provider === provider
        ? pin.model
        : fallback?.provider === provider
          ? fallback.model
          : undefined
    }
    if (model === undefined) model = agent.session?.requestHeader?.()?.config?.model
    if (model === undefined) {
      ctx.logger.debug(`dsh-subagent-plus: provider "${provider}" failed (${failure.code}) on an unknown model; health unchanged`)
      return
    }
    health.markRoute({ provider, model }, until, failure.code)
    ctx.logger.warn(`dsh-subagent-plus: route "${provider}/${model}" failed (${failure.code}); cooling down for ${until - now}ms`)
  }

  // Adapter sets change at runtime: a memoized-registered route may have been
  // removed. Forget the successes so the next request re-checks the catalogue
  // (failOpen then skips the gone route instead of pinning children onto it).
  const forgetRegisteredRoutes = (): void => { registeredRoutes.clear() }
  ctx.on('llm/adapters-updated', forgetRegisteredRoutes)

  ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const agent = payload.agent
    if (childDepthOf(agent) <= 0) return resolved
    const config = live.current()
    if (!config.pinForkChildren && isForkedChild(agent)) return resolved
    const plan = resolveStrategyPlan(config)
    if (plan.kind === 'off') return resolved
    if (plan.kind === 'pinned') {
      const pin = resolvePin(config)
      if (pin !== undefined) {
        const override = pinnedRoute(resolved, pin)
        if (override !== undefined) {
          if (config.failOpen && !await routeRegistered(ctx, pin.provider, pin.model)) {
            // One line per lifetime: an unregistered pin fails every request,
            // and the registration cache below memoizes only successes, so
            // without this latch every child request re-queries the catalogue
            // and re-logs the same warning.
            if (!unregisteredPinWarned) {
              unregisteredPinWarned = true
              ctx.logger.warn(
                `dsh-subagent-plus: pinned route "${pin.provider}/${pin.model}" is not registered; `
                + `child requests keep their resolved route`,
              )
            }
            return resolved
          }
          logRouteOnce(ctx, agent, resolved, override, 'pinned')
          return applyOverride(resolved, override)
        }
        return resolved
      }
      // No pinned route: the fallback is the single-model entry point.
      const fallback = await usableFallbackOf(config)
      if (fallback === undefined) return resolved
      const override = pinnedRoute(resolved, fallback)
      if (override === undefined) return resolved
      logRouteOnce(ctx, agent, resolved, override, 'fallback-routed')
      return applyOverride(resolved, override)
    }
    const decision = await decideFor(config, agent)
    if (decision === undefined || decision.kind === 'explicit') return resolved
    await failoverIfCooling(config, decision)
    const override = pinnedRoute(resolved, decision.route)
    if (override === undefined) return resolved
    logRouteOnce(ctx, agent, resolved, override, decision.via === 'fallback' ? 'fallback-routed' : `assigned (${decision.strategy})`)
    return applyOverride(resolved, override)
  })

  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    const config = live.current()
    // Fully inert while disabled: official-routing traffic must not pollute
    // the health table the next enablement would consult.
    if (!config.enabled) return next()
    const routed = resolveStrategyPlan(config).kind === 'spread' || fallbackRouteOf(config) !== undefined
    if (routed && config.cooldownMs > 0) recordFailure(config, payload.agent, payload.provider, payload.failure)
    return next()
  })

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    const config = live.current()
    if (!config.enabled || !config.showNotice) return decision
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    // The loop skips an empty first step and an emptied offered continuation.
    if (decision.messages.length === 0 && (payload.step === 1 || payload.messages.length > 0)) {
      return decision
    }
    const agent = payload.agent
    if (childDepthOf(agent) <= 0) return decision
    if (!config.pinForkChildren && isForkedChild(agent)) return decision
    const plan = resolveStrategyPlan(config)
    if (plan.kind !== 'spread') {
      const pin = plan.kind === 'off' ? undefined : resolvePin(config)
      let text: string | undefined
      let target: PinRoute | undefined
      if (pin !== undefined) {
        target = pin
        text = `[model pinned: every request from this child agent runs ${label(pin)} (dsh-subagent-plus)]`
      } else {
        const fallback = fallbackRouteOf(config)
        if (fallback !== undefined && healthyNow(config)(fallback)
          && (!config.failOpen || await routeRegistered(ctx, fallback.provider, fallback.model))) {
          target = fallback
          text = fallbackNotice(label(fallback))
        }
      }
      if (target === undefined || text === undefined) return decision
      const targetLabel = label(target)
      if (noticedLabel.get(agent) === targetLabel) return decision
      noticedLabel.set(agent, targetLabel)
      const notice = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'model-selection', form: 'notice', summary: boundContextSummary(targetLabel) },
      })
      return { ...decision, messages: [...decision.messages, notice] }
    }
    const routing = await decideFor(config, agent)
    if (routing === undefined || routing.kind === 'explicit') return decision
    let text: string
    if (routing.pendingFailover !== undefined) {
      const { from, to, code } = routing.pendingFailover
      routing.pendingFailover = undefined
      text = reassignedNotice(label(from), label(to), code)
      // The reassignment names the new route; its plain assignment notice is redundant.
      routing.noticed.add(assignmentText(routing, routing.route))
    } else {
      text = assignmentText(routing, routing.route)
    }
    if (routing.noticed.has(text)) return decision
    routing.noticed.add(text)
    const notice = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'model-selection', form: 'notice', summary: boundContextSummary(label(routing.route)) },
    })
    return { ...decision, messages: [...decision.messages, notice] }
  })
}

/** The transcript line naming how one decision's current route was assigned. */
function assignmentText(decision: SpreadDecision, route: PinRoute): string {
  return decision.via === 'fallback'
    ? fallbackNotice(label(route))
    : assignedNotice(label(route), decision.strategy)
}

function routeKeyEquals(left: PinRoute, right: PinRoute): boolean {
  return left.provider === right.provider && left.model === right.model
}

function label(route: { provider: string; model: string }): string {
  return `${route.provider}/${route.model}`
}

function applyOverride(resolved: LlmCallConfig, override: PinOverride): LlmCallConfig {
  if (override.kind === 'effort-only') {
    // Config string narrowed to the branded effort id; an unsupported value
    // fails loudly when the provider resolves the effort for this request.
    return { ...resolved, reasoningEffort: override.reasoningEffort as ReasoningEffortId }
  }
  if (override.reasoningEffort === undefined) {
    const { reasoningEffort: _dropped, ...rest } = resolved
    return { ...rest, provider: override.provider, model: override.model }
  }
  return {
    ...resolved,
    provider: override.provider,
    model: override.model,
    reasoningEffort: override.reasoningEffort as ReasoningEffortId,
  }
}

/**
 * The delegating Session's current route, read through the Host's session
 * store. Undefined when the child has no parent link, the store is absent
 * (headless compositions), or the parent is not loaded.
 */
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
  return sessions.get(parentId)?.requestHeader()?.config
}

/** One notice per agent per distinct pin target (pinned strategy and fallback). */
const noticedLabel = new WeakMap<object, string>()

/** One debug line for the lifetime of the process when the official settings read fails. */
let settingsFailureLogged = false

function logSettingsFailureOnce(ctx: Context): void {
  if (settingsFailureLogged) return
  settingsFailureLogged = true
  ctx.logger.debug('dsh-subagent-plus: reading the subagent model-selection settings failed; this request keeps its resolved route')
}

/** Successful validations are memoized; failures retry on later requests. */
const registeredRoutes = new Set<string>()

async function routeRegistered(ctx: Context, provider: string, model: string): Promise<boolean> {
  if (registeredRoutes.has(`${provider}\0${model}`)) return true
  const llm = ctx.get('llm')
  if (llm === undefined) return true
  try {
    if (!llm.listProviders().some(candidate => candidate.id === provider)) return false
    const models = await llm.listModels(provider)
    if (!models.some(candidate => candidate.id === model)) return false
  } catch {
    return false
  }
  registeredRoutes.add(`${provider}\0${model}`)
  return true
}

/** Log at most one line per agent per distinct route target. */
const lastRouteLabel = new WeakMap<object, string>()

function logRouteOnce(
  ctx: Context,
  agent: object,
  resolved: LlmCallConfig,
  override: PinOverride,
  verb: string,
): void {
  const target = override.kind === 'route'
    ? label(override)
    : `effort ${override.reasoningEffort}`
  if (lastRouteLabel.get(agent) === target) return
  lastRouteLabel.set(agent, target)
  const from = resolved.provider === undefined || resolved.model === undefined
    ? 'unset'
    : `${resolved.provider}/${resolved.model}`
  ctx.logger.info(`dsh-subagent-plus: ${verb} child agent onto ${target} (was ${from})`)
}
