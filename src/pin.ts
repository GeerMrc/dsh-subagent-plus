/**
 * Pure child-agent route-pinning logic for dsh-subagent-plus.
 *
 * Structural read-only views over the host's Agent/Session surfaces; no
 * runtime dependency on dsh packages so every rule here is unit-testable
 * without a live Host.
 */

/** Route a child agent is pinned to. Empty `reasoningEffort` keeps the model's own default. */
export interface PinRoute {
  /** Registered provider id, e.g. `sz`. */
  provider: string
  /** Provider-owned model id, e.g. `Qwen3.8-27B-FP8`. */
  model: string
  /** Optional effort id; when the route changes without one, the inherited effort is dropped. */
  reasoningEffort?: string
}

/** Structural view of the pin configuration fields used in route resolution. */
export interface PinConfigView {
  /** Whether child requests are pinned at all. */
  enabled: boolean
  /** Explicitly configured provider id; empty falls through to `autoRoute`. */
  provider: string
  /** Explicitly configured model id; empty falls through to `autoRoute`. */
  model: string
  /** Effort id pinned alongside the route; empty drops effort on route change. */
  reasoningEffort: string
  /** Whether an unset route may adopt the official subagent settings' first allowed model. */
  autoRoute: boolean
}

/** Structural face of the official `subagentModelSelection` settings service. */
export interface OfficialModelSelectionSettings {
  /** Read the live preference; throws when the enabled list is empty or unreadable. */
  current(): { enabled: boolean; allowedModels: readonly { provider: string; model: string }[] }
}

/**
 * Resolve the pin target for one delegation: an explicit `provider`/`model`
 * pair always wins; with both unset and `autoRoute` on, adopt the first route
 * of the official subagent model-selection settings when they are enabled.
 * `current()` failures propagate to the caller, which logs once and pins
 * nothing for that request.
 * @param config - structural pin configuration.
 * @param settings - official settings service face, when the Host provides one.
 * @returns the pin target, or undefined when this request keeps its resolved route.
 */
export function resolvePinRoute(
  config: PinConfigView,
  settings: OfficialModelSelectionSettings | undefined,
): PinRoute | undefined {
  if (!config.enabled) return undefined
  if (config.provider !== '' && config.model !== '') {
    return {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === '' ? {} : { reasoningEffort: config.reasoningEffort },
    }
  }
  if (!config.autoRoute || config.provider !== '' || config.model !== '') return undefined
  if (settings === undefined || typeof settings.current !== 'function') return undefined
  const current = settings.current()
  const first = current.enabled ? current.allowedModels[0] : undefined
  return first === undefined ? undefined : { provider: first.provider, model: first.model }
}

/** Subset of `LlmCallConfig` this plugin reads and overrides. */
export interface RouteFields {
  /** Resolved provider id of the request. */
  provider?: string
  /** Resolved model id of the request. */
  model?: string
  /** Resolved reasoning effort of the request. */
  reasoningEffort?: string
}

/** Read-only view over `Session` fields used for child classification and routing. */
export interface SessionLike {
  /** Durable session header fields; `parentSession` links a child to its delegating Session. */
  header?: { delegationDepth?: number; parentSession?: string }
  /** Length of the fork-inherited event prefix, when seeded. */
  inheritedEventCount?: number
  /**
   * Event read by sequence number. Declared as a method so the host's
   * branded-sequence signature stays structurally compatible.
   */
  eventAt?(seq: number): SessionEventLike | undefined | null
  /** Latest persisted request header, carrying the route the Session last ran. */
  requestHeader?(): { config?: RouteFields } | undefined
}

/** Structural view over one session event. */
export interface SessionEventLike {
  /** Event type tag. */
  type: string
  /** Event payload; `inherited` marks fork-inherited seed markers. */
  data?: unknown
}

/** Read-only view over the `Agent` fields used for child classification and routing. */
export interface AgentLike {
  /** Agent creation options: `subagentDepth` when delegated, plus the creation route. */
  options?: { subagentDepth?: number } & RouteFields
  /** The agent's owning Session. */
  session?: SessionLike
}

function readDepth(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Delegation depth of one agent, taken as the deeper of the runtime
 * `AgentOptions.subagentDepth` and the durable `Session` header depth. Both
 * spawn-provider children (the `subagent` tool) and Agent Teams teammates
 * carry a depth of at least 1; top-level agents read 0.
 * @param agent - agent to classify.
 * @returns the delegation depth, 0 for top-level agents.
 */
export function childDepthOf(agent: AgentLike): number {
  return Math.max(
    readDepth(agent.options?.subagentDepth),
    readDepth(agent.session?.header?.delegationDepth),
  )
}

/**
 * Whether the agent's session was built from a fork-inherited prefix: the
 * event at `inheritedEventCount` is the tagged `session/end-seed` marker.
 * Fork children reuse the parent conversation; pinning them elsewhere defeats
 * that reuse, so they are excluded unless explicitly enabled.
 * @param agent - agent to classify.
 * @returns true only when a fork-inherited seed marker is confirmed.
 */
export function isForkedChild(agent: AgentLike): boolean {
  const session = agent.session
  if (session === undefined || session.eventAt === undefined) return false
  const cut = session.inheritedEventCount
  if (typeof cut !== 'number' || !Number.isSafeInteger(cut) || cut < 0) return false
  const marker = session.eventAt(cut)
  if (marker?.type !== 'session/end-seed' || marker.data === undefined) return false
  const { data } = marker
  return typeof data === 'object' && data !== null && 'inherited' in data && data.inherited === true
}

/** One pin decision for a resolved route. */
export type PinOverride =
  | { kind: 'effort-only'; reasoningEffort: string }
  | { kind: 'route'; provider: string; model: string; reasoningEffort?: string }

/**
 * Apply the pin to one resolved route.
 * @param resolved - route the agent loop resolved (agent options plus any
 * deeper model-selection listener).
 * @param pin - configured pin route.
 * @returns the override to apply, or undefined when nothing changes.
 *  `route` without `reasoningEffort` drops the inherited effort so the
 *  selected model resolves its own default, mirroring delegation semantics;
 *  `effort-only` keeps the route and aligns the effort.
 */
export function pinnedRoute(resolved: RouteFields, pin: PinRoute): PinOverride | undefined {
  if (resolved.provider === pin.provider && resolved.model === pin.model) {
    if (pin.reasoningEffort === undefined || resolved.reasoningEffort === pin.reasoningEffort) {
      return undefined
    }
    return { kind: 'effort-only', reasoningEffort: pin.reasoningEffort }
  }
  return {
    kind: 'route',
    provider: pin.provider,
    model: pin.model,
    ...(pin.reasoningEffort === undefined ? {} : { reasoningEffort: pin.reasoningEffort }),
  }
}
