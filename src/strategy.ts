/**
 * Pure multi-route selection strategy for dsh-subagent-plus: strategy plan
 * resolution over the configuration, candidate selection (round-robin / random /
 * priority), failure classification, route health with cooldowns, and the
 * explicit-route test. Clock and randomness are injected so every rule is
 * unit-testable without a live Host.
 */
import type { OfficialModelSelectionSettings, PinRoute, RouteFields } from './pin.js'

/** Closed set of selection strategies; `pinned` is the v0.1.x single-route behaviour. */
export const STRATEGIES = ['pinned', 'round-robin', 'random', 'priority'] as const

/** One of {@link STRATEGIES}. */
export type Strategy = typeof STRATEGIES[number]

/** A strategy that distributes children over several candidate routes. */
export type SpreadStrategy = Exclude<Strategy, 'pinned'>

/** One ordered `priority` entry as the configuration schema materializes it. */
export interface PriorityEntryView {
  /** Registered provider id. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Effort id for this route; empty keeps the model's own default. */
  reasoningEffort: string
}

/** Structural view of the configuration fields the strategy engine reads. */
export interface StrategyConfigView {
  /** Whether child routing is active at all. */
  enabled: boolean
  /** Top-level provider id; only the `pinned` strategy reads it. */
  provider: string
  /** Top-level model id; only the `pinned` strategy reads it. */
  model: string
  /** Selection strategy. */
  strategy: Strategy
  /** Ordered candidate routes; empty falls back to the official allowed-model list. */
  priority: readonly PriorityEntryView[]
  /** Whether a route the delegating model chose explicitly is left untouched. */
  respectExplicit: boolean
  /** Cooldown applied to a failed route; 0 disables health tracking. */
  cooldownMs: number
  /** Fallback provider id; empty disables the fallback. */
  fallbackProvider: string
  /** Fallback model id; empty disables the fallback. */
  fallbackModel: string
  /** Effort id for the fallback route; empty keeps the model's own default. */
  fallbackReasoningEffort: string
}

/** How one configuration routes children. */
export type StrategyPlan =
  | { kind: 'off' }
  | { kind: 'pinned' }
  | {
    kind: 'spread'
    strategy: SpreadStrategy
    /** Where candidate routes come from. */
    source: 'priority' | 'official'
    /** True when top-level provider/model fields are set but ignored by this strategy. */
    ignoredRoute: boolean
  }

/**
 * Resolve the routing plan for a configuration. `pinned` keeps the complete
 * v0.1.x resolution (explicit route, then `autoRoute`); a spread strategy
 * takes its candidates from `priority` when set, else from the official
 * allowed-model list, and ignores the top-level provider/model fields.
 * @param config - structural configuration view.
 * @returns the plan; `off` when the plugin is disabled.
 */
export function resolveStrategyPlan(config: StrategyConfigView): StrategyPlan {
  if (!config.enabled) return { kind: 'off' }
  if (config.strategy === 'pinned') return { kind: 'pinned' }
  return {
    kind: 'spread',
    strategy: config.strategy,
    source: config.priority.length > 0 ? 'priority' : 'official',
    ignoredRoute: config.provider !== '' || config.model !== '',
  }
}

/** What one validation pass found. Structural problems refuse to load; degraded ones downgrade with a warning. */
export interface ValidationReport {
  /** Refuse-to-load problems: an over-long `priority`, half-filled entries, repeated routes. */
  structural: string[]
  /** Cross-field combinations that load but behave as if unset: an empty `priority` list under the `priority` strategy, a half-filled or duplicate fallback. */
  degraded: string[]
}

/**
 * Validate a configuration. Structural problems (more than 5 `priority`
 * routes, a priority entry missing its provider or model, a repeated route)
 * refuse to load. Cross-field combinations that a settings page could
 * persist degrade instead of throwing — throwing here would brick the plugin
 * on the next Host restart, so an empty `priority` list under the `priority`
 * strategy resolves to no candidates (fallback route, then the resolved
 * route) and a half-filled or duplicate fallback stays unused. Shared with
 * the settings page, which blocks both classes before writing.
 * @param config - structural configuration view.
 * @returns the structural and degraded findings.
 */
export function validateStrategyConfig(config: StrategyConfigView): ValidationReport {
  const structural: string[] = []
  const degraded: string[] = []
  if (config.priority.length > 5) {
    structural.push(`dsh-subagent-plus: priority lists ${config.priority.length} routes; at most 5 are allowed`)
  }
  const seen = new Set<string>()
  config.priority.forEach((entry, index) => {
    if (entry.provider === '' || entry.model === '') {
      structural.push(`dsh-subagent-plus: priority[${index}] needs both provider and model`)
      return
    }
    const key = routeKey(entry)
    if (seen.has(key)) {
      structural.push(`dsh-subagent-plus: priority repeats route "${entry.provider}/${entry.model}"`)
    }
    seen.add(key)
  })
  if (config.strategy === 'priority' && config.priority.length === 0) {
    degraded.push('dsh-subagent-plus: strategy "priority" lists no candidate routes; children use the fallback route when configured, otherwise keep their resolved route')
  }
  const fallbackHalfFilled = (config.fallbackProvider === '') !== (config.fallbackModel === '')
  if (fallbackHalfFilled) {
    degraded.push('dsh-subagent-plus: fallback needs both provider and model; it stays unused')
  } else if (fallbackRouteOf(config) === undefined && config.fallbackProvider !== '' && config.fallbackModel !== '') {
    degraded.push(`dsh-subagent-plus: fallback repeats the listed route "${config.fallbackProvider}/${config.fallbackModel}"; it stays unused`)
  }
  return { structural, degraded }
}

/**
 * The configured fallback route, when one is usable by configuration alone:
 * both fields must be set (a half-filled fallback counts as unset) and the
 * route must not repeat a `priority` entry — a fallback shares a failure
 * domain with a listed route only by accident, never by configuration.
 * Health and registration are the caller's checks.
 * @param config - structural configuration view.
 * @returns the fallback route, or undefined when none is configured.
 */
export function fallbackRouteOf(config: StrategyConfigView): PinRoute | undefined {
  if (config.fallbackProvider === '' || config.fallbackModel === '') return undefined
  const route: PinRoute = {
    provider: config.fallbackProvider,
    model: config.fallbackModel,
    ...config.fallbackReasoningEffort === '' ? {} : { reasoningEffort: config.fallbackReasoningEffort },
  }
  return config.priority.some(entry => entry.provider === route.provider && entry.model === route.model)
    ? undefined
    : route
}

/**
 * The fallback route narrowed by health, for the adjudication step after the
 * strategy candidates ran out.
 * @param fallback - configured fallback route, when any.
 * @param healthy - route health predicate.
 * @returns the usable fallback, or undefined.
 */
export function usableFallback(fallback: PinRoute | undefined, healthy: (route: PinRoute) => boolean): PinRoute | undefined {
  return fallback !== undefined && healthy(fallback) ? fallback : undefined
}

/**
 * Identity of one route; display names never take part.
 * @param route - provider/model pair.
 * @returns the `provider\0model` key.
 */
export function routeKey(route: { provider: string; model: string }): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Candidate routes for a spread plan, in priority order.
 * @param plan - a spread plan.
 * @param config - structural configuration view (for `priority`).
 * @param settings - official settings face, when the Host provides one;
 * `current()` failures propagate.
 * @returns the ordered candidates; empty when nothing is configured or the
 * official list is disabled or absent.
 */
export function candidateRoutes(
  plan: Extract<StrategyPlan, { kind: 'spread' }>,
  config: StrategyConfigView,
  settings: OfficialModelSelectionSettings | undefined,
): PinRoute[] {
  if (plan.source === 'priority') {
    return config.priority.map(entry => ({
      provider: entry.provider,
      model: entry.model,
      ...entry.reasoningEffort === '' ? {} : { reasoningEffort: entry.reasoningEffort },
    }))
  }
  // The `priority` strategy never falls back to the official list: its stored
  // order is undocumented ordering, so an empty list is the degraded
  // "no candidates" state rather than a silent source switch.
  if (plan.strategy === 'priority') return []
  if (settings === undefined || typeof settings.current !== 'function') return []
  const current = settings.current()
  if (!current.enabled) return []
  return current.allowedModels.map(route => ({ provider: route.provider, model: route.model }))
}

/** Mutable cursor and deck state shared by every selection under one plugin instance. */
export interface SelectionState {
  /** Next round-robin position over the full candidate list. */
  cursor: number
  /** Remaining keys of the current random draw cycle. */
  deck: string[]
  /** Candidate keys the deck was shuffled from; a different multiset reshuffles. */
  deckSource: string[]
}

/**
 * Fresh selection state.
 * @returns a state with an empty deck and the cursor at 0.
 */
export function createSelectionState(): SelectionState {
  return { cursor: 0, deck: [], deckSource: [] }
}

/**
 * Pick the route for one child under a spread strategy, skipping routes that
 * are unhealthy or excluded. Round-robin walks the full candidate order with a
 * shared cursor; random draws without replacement from a shuffled deck that is
 * reshuffled when the candidate multiset changes or the cycle is exhausted;
 * priority takes the first usable route.
 * @param strategy - spread strategy.
 * @param candidates - ordered candidate routes.
 * @param healthy - route health predicate.
 * @param state - shared selection state, mutated by round-robin and random.
 * @param rng - uniform source in [0, 1).
 * @param exclude - a route to skip, used when failing over away from it.
 * @returns the selected route, or undefined when no candidate is usable.
 */
export function selectChildRoute(
  strategy: SpreadStrategy,
  candidates: readonly PinRoute[],
  healthy: (route: PinRoute) => boolean,
  state: SelectionState,
  rng: () => number,
  exclude?: PinRoute,
): PinRoute | undefined {
  const usable = (route: PinRoute): boolean =>
    healthy(route) && !(exclude !== undefined && routeKey(route) === routeKey(exclude))
  if (!candidates.some(usable)) return undefined
  switch (strategy) {
    case 'priority':
      return candidates.find(usable)
    case 'round-robin': {
      const count = candidates.length
      for (let step = 0; step < count; step += 1) {
        const index = (state.cursor + step) % count
        const route = candidates[index]
        if (route !== undefined && usable(route)) {
          state.cursor = (index + 1) % count
          return route
        }
      }
      return undefined
    }
    case 'random': {
      const keys = candidates.map(routeKey)
      if (!sameMultiset(state.deckSource, keys)) {
        state.deckSource = [...keys]
        state.deck = []
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (state.deck.length === 0) state.deck = shuffle(keys, rng)
        const position = state.deck.findIndex(key => {
          const route = candidates[keys.indexOf(key)]
          return route !== undefined && usable(route)
        })
        if (position >= 0) {
          const [key] = state.deck.splice(position, 1)
          return candidates[keys.indexOf(key ?? '')]
        }
        state.deck = []
      }
      return undefined
    }
  }
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((key, index) => key === sortedRight[index])
}

function shuffle(keys: readonly string[], rng: () => number): string[] {
  const deck = [...keys]
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1))
    const held = deck[index]
    deck[index] = deck[swap] ?? ''
    deck[swap] = held ?? ''
  }
  return deck
}

/**
 * What a request failure says about its route. `transient` cools the exact
 * route; `sticky-provider` cools every route of the provider (credential and
 * quota failures); `sticky-route` cools the exact route for failures that only
 * another route can avoid; `ignore` leaves health untouched.
 */
export type FailureClass = 'transient' | 'sticky-provider' | 'sticky-route' | 'ignore'

const TRANSIENT_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])
const STICKY_PROVIDER_CODES = new Set(['AUTH', 'INVALID_CREDENTIAL', 'QUOTA', 'ACCOUNT_QUOTA'])
const STICKY_ROUTE_CODES = new Set(['NO_ADAPTER', 'UNSUPPORTED_REASONING_EFFORT'])

/**
 * Classify one `LlmFailure` by its Harness code, falling back to the HTTP
 * status for unknown codes (429 and 5xx count as transient). Request-shaped
 * failures (context window, image offload, local abort) never mark a route.
 * @param code - the failure's machine-routing code (an open string).
 * @param status - HTTP status when the provider returned one.
 * @returns the failure class.
 */
export function classifyFailure(code: string, status?: number): FailureClass {
  if (TRANSIENT_CODES.has(code)) return 'transient'
  if (STICKY_PROVIDER_CODES.has(code)) return 'sticky-provider'
  if (STICKY_ROUTE_CODES.has(code)) return 'sticky-route'
  if (code === 'UNKNOWN' && status !== undefined && (status === 429 || status >= 500)) return 'transient'
  return 'ignore'
}

interface Cooldown {
  until: number
  code: string
}

/**
 * Process-wide route health: cooldowns keyed by exact route and by provider.
 * Marking never shortens an existing cooldown. Time is passed in by callers.
 */
export class RouteHealth {
  readonly #routes = new Map<string, Cooldown>()
  readonly #providers = new Map<string, Cooldown>()

  /**
   * Cool one exact route.
   * @param route - provider/model pair.
   * @param until - epoch milliseconds the cooldown ends.
   * @param code - failure code recorded for notices.
   */
  markRoute(route: { provider: string; model: string }, until: number, code: string): void {
    extend(this.#routes, routeKey(route), until, code)
  }

  /**
   * Cool every route of one provider.
   * @param provider - provider id.
   * @param until - epoch milliseconds the cooldown ends.
   * @param code - failure code recorded for notices.
   */
  markProvider(provider: string, until: number, code: string): void {
    extend(this.#providers, provider, until, code)
  }

  /**
   * Whether a route is outside every cooldown that covers it.
   * @param route - provider/model pair.
   * @param now - current epoch milliseconds.
   * @returns true when neither the route nor its provider is cooling down.
   */
  isHealthy(route: { provider: string; model: string }, now: number): boolean {
    return this.cooldown(route, now) === undefined
  }

  /**
   * The active cooldown covering a route, preferring the one ending later.
   * @param route - provider/model pair.
   * @param now - current epoch milliseconds.
   * @returns the cooldown, or undefined when the route is healthy.
   */
  cooldown(route: { provider: string; model: string }, now: number): Cooldown | undefined {
    const byRoute = active(this.#routes.get(routeKey(route)), now)
    const byProvider = active(this.#providers.get(route.provider), now)
    if (byRoute === undefined) return byProvider
    if (byProvider === undefined) return byRoute
    return byProvider.until > byRoute.until ? byProvider : byRoute
  }
}

function extend(table: Map<string, Cooldown>, key: string, until: number, code: string): void {
  const existing = table.get(key)
  if (existing !== undefined && existing.until >= until) return
  table.set(key, { until, code })
}

function active(entry: Cooldown | undefined, now: number): Cooldown | undefined {
  return entry !== undefined && entry.until > now ? entry : undefined
}

/**
 * The route a delegating model chose explicitly for a child, if it did: a child
 * whose creation route differs from its parent's current route was given that
 * route on purpose (per-call selection or a configured default). An unknown
 * parent route counts as inheritance so the strategy still applies.
 * @param child - the child's creation route.
 * @param parent - the parent's current request route, when readable.
 * @returns the explicit route, or undefined when the child merely inherited.
 */
export function explicitRouteOf(child: RouteFields, parent: RouteFields | undefined): PinRoute | undefined {
  if (child.provider === undefined || child.model === undefined) return undefined
  if (parent === undefined || parent.provider === undefined || parent.model === undefined) return undefined
  if (child.provider === parent.provider && child.model === parent.model) return undefined
  return {
    provider: child.provider,
    model: child.model,
    ...child.reasoningEffort === undefined ? {} : { reasoningEffort: child.reasoningEffort },
  }
}

/**
 * Transcript notice naming the route a spread strategy assigned to a child.
 * @param label - `provider/model` of the assigned route.
 * @param strategy - the strategy that chose it.
 * @returns the bracketed one-line notice.
 */
export function assignedNotice(label: string, strategy: SpreadStrategy): string {
  return `[model assigned: every request from this child agent runs ${label} (strategy: ${strategy}, dsh-subagent-plus)]`
}

/**
 * Transcript notice naming the fallback route a child landed on after no
 * candidate route was usable.
 * @param label - `provider/model` of the fallback route.
 * @returns the bracketed one-line notice.
 */
export function fallbackNotice(label: string): string {
  return `[model fallback: no usable candidate route; this child agent runs ${label} (dsh-subagent-plus)]`
}

/**
 * Transcript notice recording a mid-child failover.
 * @param from - `provider/model` that entered cooldown.
 * @param to - `provider/model` the child continues with.
 * @param code - failure code that triggered the cooldown.
 * @returns the bracketed one-line notice.
 */
export function reassignedNotice(from: string, to: string, code: string): string {
  return `[model reassigned: route ${from} is cooling down (${code}); this child agent continues with ${to} (dsh-subagent-plus)]`
}
