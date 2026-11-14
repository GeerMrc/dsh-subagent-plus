/**
 * Pure multi-route selection strategy for dsh-subagent-plus: strategy plan
 * resolution over the configuration, candidate selection (round-robin / random /
 * priority), failure classification, route health with cooldowns, and the
 * explicit-route test. Clock and randomness are injected so every rule is
 * unit-testable without a live Host.
 */
import { canonicalizeModelId, capabilityOf, familyScore, type CapabilityOverride, type KbTable } from './capability-scoring.js'
import { routeId, type PinRoute, type RouteFields } from './pin.js'

/** One user-imported capability evaluation row as the config schema materializes it (ADR 0016 d3). */
export interface CapabilityOverrideView {
  /** Route qualifier (Z10): non-empty = the row scores only that provider's
   *  route of the model; empty = generic (every route). */
  provider?: string
  /** Raw model identifier as researched — matched progressively at read time. */
  model: string
  /** Percentile-position scores 0-100 (50≈median, 70≈top quartile, 90≈top decile). */
  overall?: number
  coding?: number
  webdev?: number
  agentic?: number
  /** Research execution date (YYYY-MM-DD). */
  asOf: string
  /** Free-text provenance note — unverifiable, informational only. */
  note?: string
}

/** Upper bound on user-imported capability overrides (ADR 0016 d3, Z8:
 *  raised to fit a full model-catalogue research package, not just the
 *  candidate list). */
export const MAX_CAPABILITY_OVERRIDES = 256

/** Upper bound on `nameMap` rows. Originally 16 to align with the official
 * roster's `DEFAULT_MAX_MEMBERS`; that roster left the host in 0.2.2-rc.2, and
 * the starter template's 12 rows plus existing manual rows no longer fit — 32
 * since ADR 0013 d5. Lives here — not config.js — so the client half can
 * import it without dragging schemastery into the client bundle. */
export const MAX_NAME_MAP_ENTRIES = 32

/** Semantic effort intent a derived row expresses (ADR 0014 d1): resolved
 *  against the route's actual tiers at derive time, never a literal id. */
export type EffortIntent = 'top' | 'mid' | 'lowest'

/** Recognised effort strength ladder, weakest to strongest (ADR 0014 d1).
 *  `minimal` is a declarative seat for pi-ai-style pass-through vocabularies;
 *  the host publishes efforts in adapter-preferred display order, which is
 *  not a strength order — the ladder ranks ids whose vocabulary is known. */
const EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Effort ids that mean "reasoning disabled" — excluded from automatic picks
 *  (a manual row may still choose them). 'off' has live instances
 *  (deepseek/qwen); 'none' is a preventive exclusion with none observed. */
const DISABLED_EFFORT_IDS = new Set(['off', 'none'])

/**
 * Resolve a semantic effort intent against a route's actual tiers (ADR 0014):
 * ladder-ranked ids win ('off'/'none' never picked automatically); mid takes
 * the upper median of the ladder-ranked tiers (the B-slot precedent: two
 * tiers pick the second); ids off the ladder fall back to adapter position
 * with the same upper-median rule only when no tier is on the ladder; no
 * non-disabled tiers materialise nothing.
 * @param route - the route the row targets, when known.
 * @param intent - the row's semantic effort intent.
 * @returns the materialised effort id, or '' to follow the model default.
 */
export function resolveSemanticEffort(route: { efforts?: readonly { id: string }[] } | undefined, intent: EffortIntent): string {
  const active = (route?.efforts ?? []).filter(effort => !DISABLED_EFFORT_IDS.has(effort.id.toLowerCase()))
  if (active.length === 0) return ''
  const pick = (ordered: readonly { id: string }[]): string =>
    intent === 'top' ? ordered[ordered.length - 1]!.id
      : intent === 'lowest' ? ordered[0]!.id
        : ordered[Math.ceil((ordered.length - 1) / 2)]!.id
  const onLadder = active
    .map(effort => ({ id: effort.id, rank: EFFORT_LADDER.indexOf(effort.id.toLowerCase()) }))
    .filter(effort => effort.rank >= 0)
    .sort((left, right) => left.rank - right.rank)
  if (onLadder.length > 0) return pick(onLadder)
  return pick(active)
}

/** Template slot: S=first candidate (strong), B=middle, F=last (fast). */
export type Slot = 'S' | 'B' | 'F'

/**
 * The universal starter stems (ADR 0013 d2 / 0014): one cross-domain table
 * serving every session — dev sessions hit review/dev/test, game sessions
 * design/write, research sessions research/plan; unmatched names fall through
 * to the strategy chain. Row order is the equal-length cross-family
 * tie-break order (matchByKeyword resolves ties by first occurrence), so the
 * quality-gate family comes first: `test-planner` resolves to `plan` (S+top)
 * and `design-review-dev` to `review` (S+top). B rows take `mid` since ADR
 * 0014 (qwen: medium; the old `default` intent materialised low there and
 * collided with the F family).
 */
export const STARTER_TEMPLATE_ROWS: ReadonlyArray<{ keyword: string; slot: Slot; effort: EffortIntent }> = [
  { keyword: 'review', slot: 'S', effort: 'top' },
  { keyword: 'audit', slot: 'S', effort: 'top' },
  { keyword: 'verif', slot: 'S', effort: 'top' },
  { keyword: 'plan', slot: 'S', effort: 'top' },
  { keyword: 'research', slot: 'B', effort: 'mid' },
  { keyword: 'dev', slot: 'B', effort: 'mid' },
  { keyword: 'build', slot: 'B', effort: 'mid' },
  { keyword: 'execute', slot: 'B', effort: 'mid' },
  { keyword: 'write', slot: 'B', effort: 'mid' },
  { keyword: 'design', slot: 'B', effort: 'mid' },
  { keyword: 'test', slot: 'F', effort: 'lowest' },
  { keyword: 'qa', slot: 'F', effort: 'lowest' },
]

/** One candidate route with its reasoning tiers, the derive input (ADR 0014/0015). */
export interface StarterCandidate {
  /** Registered provider id. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** The model's reasoning tiers from the catalogue, when known. */
  efforts?: readonly { id: string }[]
  /** Catalogue description, when the wire/adapter carries one — a tie-break
   *  hint only, never a primary capability signal (ADR 0015 d1: descriptions
   *  are factually, not structurally, the same on both sides). */
  description?: string
}

/** Catalogue description hints (ADR 0015 d1): official vocabulary names
 *  stronger models ("higher cost", "Stronger…") and fast/cheap ones; missing
 *  or non-English descriptions score 0. */
const STRONG_HINT = /higher cost|stronger|premium|quality/i
const FAST_HINT = /fast|flash|lite|cheap/i

/** The rank of candidates with no active on-ladder tier (off-ladder
 *  vocabularies or models without reasoning): a fixed floor sorting after
 *  every on-ladder candidate (ADR 0015 R1). */
const OFF_LADDER_FLOOR = -1

/**
 * The 0015 structural tie chain — [topTierRank, activeTierCount, descHint] —
 * retained as the fallback when KB family scores tie (ADR 0016 d2: benchmark
 * truth first, host-structural signals only break its ties).
 */
function legacyTuple(candidate: StarterCandidate): [number, number, number] {
  const active = (candidate.efforts ?? []).filter(effort => !DISABLED_EFFORT_IDS.has(effort.id.toLowerCase()))
  let top = OFF_LADDER_FLOOR
  for (const effort of active) {
    const rank = EFFORT_LADDER.indexOf(effort.id.toLowerCase())
    if (rank > top) top = rank
  }
  const description = candidate.description ?? ''
  const descHint = (STRONG_HINT.test(description) ? 1 : 0) - (FAST_HINT.test(description) ? 1 : 0)
  return [top, active.length, descHint]
}

/** Options threading the L2 overrides and (for tests) a fixture KB through
 *  the slot assignment (ADR 0016 d2/d3). */
export interface SlotAssignmentOptions {
  /** User-imported capability evaluations — highest-priority score layer. */
  overrides?: readonly CapabilityOverride[]
  /** Fixture KB for tests; the shipped snapshot is the default. */
  kb?: KbTable
}

const fastHintOf = (candidate: StarterCandidate): number => (FAST_HINT.test(candidate.description ?? '') ? 1 : 0)

/** S-slot noise band (ADR 0016 3c, G2 — user ruling): a NON-ZERO S-score
 *  difference below this bound is rank-fraction noise between same-snapshot
 *  entries (an all-estimated pool shifts pairwise winners by .006 without any
 *  real capability signal), so the user's listing order decides S. Exact ties
 *  are genuine ties and keep the Z7 structural chain; the band deliberately
 *  does not extend to B/F (their collision logic consumes strict scores).
 *  Non-transitive by design inside a 2×band spread — the first-listed model
 *  accumulates and sub-band challengers never displace it. */
export const NOISE_BAND = 0.02

/**
 * Assign the S/B/F slots by KB family scores (ADR 0016 d2). Each family ranks
 * the candidates by its own dimension weights — three independent orderings,
 * no cross-family containment (the same model may serve several families).
 * Ties fall through the 0015 structural chain, then the stored order (S/B
 * take the earlier candidate, F the later). Unknown models are the LAST
 * resort for every slot — including F, whose argmin would otherwise promote
 * them (A-1); estimated models never win S/F while an anchored candidate
 * exists, they only ride the B ranking (A-6) — when EVERY candidate is
 * estimated the pool degrades to the known set so someone can win (the
 * snapshot's text-source outage exercises exactly this). With no known
 * candidate at all the slots fall back to list order (first / upper-median /
 * last).
 * @param candidates - the candidate routes in stored priority order.
 * @param options - overrides and fixture KB.
 * @returns the candidate per slot, empty when no candidates exist.
 */
export function assignSlotsByCapability(candidates: readonly StarterCandidate[], options: SlotAssignmentOptions = {}): { S?: StarterCandidate; B?: StarterCandidate; F?: StarterCandidate } {
  if (candidates.length === 0) return {}
  const overrides = options.overrides ?? []
  const views = candidates.map((candidate, index) => ({
    candidate,
    view: capabilityOf(candidate.model, overrides, options.kb, candidate.provider),
    index,
  }))
  const legacyDiff = (a: typeof views[number], b: typeof views[number]): number => {
    const left = legacyTuple(a.candidate)
    const right = legacyTuple(b.candidate)
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2]
  }
  const known = views.filter(entry => !entry.view.unknown)
  const anchored = known.filter(entry => !entry.view.estimated)
  const pool = anchored.length > 0 ? anchored : known
  // Canonical model identity for the diversity rules (F3): the same model
  // served by several providers is one model.
  const canonOf = (entry: typeof views[number]): string => canonicalizeModelId(entry.candidate.model)
  // Explicit reduce scans (not sort comparators): the per-slot tie rules stay
  // readable and deterministic — S keeps the earlier candidate on ties, F the
  // later one, and a fast-named model yields to F first.
  const sPick = pool.length > 0
    ? pool.reduce((best, entry) => {
        const diff = familyScore(entry.view, 'S') - familyScore(best.view, 'S')
        if (diff === 0) {
          // legacyDiff(entry, best) > 0 means entry outranks best on the 0015
          // structural chain — the STRONGER candidate keeps S on exact ties.
          if (legacyDiff(best, entry) > 0) return entry
          return best
        }
        // Noise band (G2): a sub-band nonzero difference is not evidence —
        // the earlier listing wins, skipping the structural chain.
        if (Math.abs(diff) < NOISE_BAND) return best
        return diff > 0 ? entry : best
      })
    : views[0]!
  const bCompare = (a: typeof views[number], b: typeof views[number]): number => {
    const left = a.view.unknown ? Number.NEGATIVE_INFINITY : familyScore(a.view, 'B')
    const right = b.view.unknown ? Number.NEGATIVE_INFINITY : familyScore(b.view, 'B')
    if (left !== right) return right - left
    // Two unknowns tie at list order (the ADR's no-known fallback); the
    // structural chain only breaks ties between scored candidates.
    if (a.view.unknown && b.view.unknown) return a.index - b.index
    const legacy = legacyDiff(a, b)
    if (legacy !== 0) return legacy
    return a.index - b.index
  }
  // A-1 holds for B too (S3, audit Y-1): unknown candidates are the last
  // resort for EVERY slot — with any known candidate present the median is
  // taken over the known pool, so one unknown never captures the six
  // builder rows.
  const bPool = known.length > 0 ? known : views
  const bRanked = [...bPool].sort(bCompare)
  const bIndex = Math.min(Math.max(1, Math.floor((bRanked.length - 1) / 2)), bRanked.length - 1)
  let bPick = bRanked[bIndex]!
  // Diversity preference (F3, gate ≥2 since H1): a median colliding with S's
  // model walks outward to the nearest different model — stronger side first
  // on equal distance. Scoped to B's own pool (estimated models included —
  // A-6 governs S/F only) and promised whenever that pool holds ≥2 distinct
  // models: with any second distinct model listed, B never stacks onto S
  // (the user's two-candidate zero-rows report retired the old ≥3 gate —
  // the most common configuration must sit INSIDE the promise).
  const sCanonical = canonOf(sPick)
  if (canonOf(bPick) === sCanonical && new Set(bRanked.map(canonOf)).size >= 2) {
    for (let distance = 1; bIndex - distance >= 0 || bIndex + distance < bRanked.length; distance += 1) {
      const stronger = bIndex - distance >= 0 ? bRanked[bIndex - distance] : undefined
      const weaker = bIndex + distance < bRanked.length ? bRanked[bIndex + distance] : undefined
      if (stronger !== undefined && canonOf(stronger) !== sCanonical) { bPick = stronger; break }
      if (weaker !== undefined && canonOf(weaker) !== sCanonical) { bPick = weaker; break }
    }
  }
  // F re-runs the full reduce over the canonically deduplicated pool (F3): a
  // model listed through several routes counts once, its first listing
  // representing it — duplicates no longer distort the later-tie rule. Only
  // INTERCHANGEABLE routes collapse (same canonical model, same S-score, same
  // fast hint): a provider-qualified override deliberately differentiates two
  // routes of one model (Z10) and both must stay in play.
  const dedupedPool: typeof views = []
  const seenModels = new Set<string>()
  for (const entry of pool) {
    const key = `${canonOf(entry)}\0${familyScore(entry.view, 'S')}\0${fastHintOf(entry.candidate)}`
    if (seenModels.has(key)) continue
    seenModels.add(key)
    dedupedPool.push(entry)
  }
  const fReduce = (entries: typeof views): typeof views[number] =>
    entries.reduce((worst, entry) => {
      const diff = familyScore(entry.view, 'S') - familyScore(worst.view, 'S')
      if (diff < 0) return entry
      if (diff > 0) return worst
      const entryFast = fastHintOf(entry.candidate)
      const worstFast = fastHintOf(worst.candidate)
      if (entryFast > worstFast) return entry
      if (entryFast < worstFast) return worst
      // legacyDiff(worst, entry) < 0 means entry is WEAKER on the structural
      // chain — it replaces worst; a strictly stronger entry keeps worst.
      if (legacyDiff(worst, entry) < 0) return entry
      if (legacyDiff(worst, entry) > 0) return worst
      return entry // F ties keep the LATER candidate (list order)
    })
  let fPick: typeof views[number]
  if (dedupedPool.length === 0) {
    fPick = views[views.length - 1]!
  } else {
    // Occupancy yield (G1, completing the F3 chain; gate ≥2 since H1): when
    // the strict argmin's model is already held by S or B and the
    // deduplicated pool offers ≥2 distinct models, F takes the weakest
    // S-score among the UNOCCUPIED entries — as weak as possible while
    // distinct; at exactly two distinct models the unoccupied set is empty
    // (pigeonhole) and the collision stands. A demoted Z10 duplicate holds
    // zero rows whenever a second distinct model exists (occupancy beats the
    // dividend at every cardinality).
    const strict = fReduce(dedupedPool)
    const occupied = new Set([sCanonical, canonOf(bPick)])
    if (occupied.has(canonOf(strict)) && new Set(dedupedPool.map(canonOf)).size >= 2) {
      const unoccupied = dedupedPool.filter(entry => !occupied.has(canonOf(entry)))
      fPick = unoccupied.length > 0 ? fReduce(unoccupied) : strict
    } else {
      fPick = strict
    }
  }
  return { S: sPick.candidate, B: bPick.candidate, F: fPick.candidate }
}

/**
 * Derive the default mapping rows from the candidate list (ADR 0014 d2 /
 * 0015 d1): stems × capability-assigned S/B/F slots × top/mid/lowest intents,
 * efforts materialised from each candidate's actual tiers. Rows only ever
 * reference listed candidates and legal stems, so the derived table bypasses
 * stored-config validation by construction; an empty candidate list derives
 * no rows (dormant).
 * @param candidates - the candidate routes in stored priority order, with
 *  catalogue tiers/description when available (missing tiers materialise '').
 * @returns the derived mapping rows.
 */
export function deriveStarterRows(candidates: readonly StarterCandidate[], options: SlotAssignmentOptions = {}): NameMapEntryView[] {
  if (candidates.length === 0) return []
  const slots = assignSlotsByCapability(candidates, options)
  // Sibling route splitting (G4, ADR 0016 3c): interchangeable routes of the
  // slot's model — same canonical + S-score + fast hint, the F3 dedup key —
  // are deployments of one model and alternate over the family's rows
  // (row-granularity equal-weight load spreading, LiteLLM's deployment
  // round-robin shape). The SLOT WINNER leads the rotation and takes the odd
  // extra row (Z7's structural chain outranks plain list order when it picks
  // a later listing — the winner earned the family); remaining siblings
  // follow in list order. A provider-qualified override breaks the key, so
  // deliberately differentiated routes (Z10) never split.
  const overrides = options.overrides ?? []
  const siblingKeyOf = (candidate: StarterCandidate): string => {
    const view = capabilityOf(candidate.model, overrides, options.kb, candidate.provider)
    return `${canonicalizeModelId(candidate.model)}\0${familyScore(view, 'S')}\0${fastHintOf(candidate)}`
  }
  const siblingsOf = (pick: StarterCandidate | undefined): StarterCandidate[] => {
    if (pick === undefined) return []
    const key = siblingKeyOf(pick)
    const siblings = candidates.filter(candidate => siblingKeyOf(candidate) === key)
    if (siblings.length <= 1) return [pick]
    return [pick, ...siblings.filter(candidate => candidate !== pick)]
  }
  const siblingsBySlot: Record<'S' | 'B' | 'F', StarterCandidate[]> = {
    S: siblingsOf(slots.S),
    B: siblingsOf(slots.B),
    F: siblingsOf(slots.F),
  }
  const familyCount: Partial<Record<'S' | 'B' | 'F', number>> = {}
  const rows: NameMapEntryView[] = []
  for (const row of STARTER_TEMPLATE_ROWS) {
    const siblings = siblingsBySlot[row.slot]
    if (siblings.length === 0) continue
    const index = familyCount[row.slot] ?? 0
    familyCount[row.slot] = index + 1
    const route = siblings[index % siblings.length]!
    rows.push({
      name: row.keyword,
      provider: route.provider,
      model: route.model,
      reasoningEffort: resolveSemanticEffort(route, row.effort),
    })
  }
  return rows
}

/**
 * The `nameMapDefaults` migration rule (ADR 0014 d2): an absent field means
 * defaults-on only for a fresh configuration — a hand-edited document with
 * stored rows lands on custom so derivation never silently replaces them.
 * @param field - the stored field value, undefined when the document predates it.
 * @param storedRowCount - the stored nameMap row count.
 * @returns the effective defaults-mode flag.
 */
export function resolveNameMapDefaults(field: boolean | undefined, storedRowCount: number): boolean {
  return field ?? storedRowCount === 0
}

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

/** One `nameMap` row as the configuration schema materializes it (ADR 0006). */
export interface NameMapEntryView {
  /** Role keyword matched by substring inclusion in the teammate name (lower-kebab, 2-64 chars, never `lead`, ADR 0008). */
  name: string
  /** Registered provider id. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Effort id for this route; empty keeps the model's own default. */
  reasoningEffort: string
}

/** Structural view of the configuration fields the strategy engine reads. */
export interface StrategyConfigView {
  /** Top-level provider id; only the `pinned` strategy reads it. */
  provider: string
  /** Top-level model id; only the `pinned` strategy reads it. */
  model: string
  /** Selection strategy. */
  strategy: Strategy
  /** Ordered candidate routes; empty leaves the strategy with no candidates. */
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
  /** By-name mapping rows (ADR 0006); `undefined` is a v0.0.3 configuration without the field. */
  nameMap?: readonly NameMapEntryView[]
  /** Defaults mode (ADR 0014 d2): derived rows replace the stored ones while true. */
  nameMapDefaults?: boolean
  /** User-imported capability evaluations (ADR 0016 d3); `undefined` is a pre-0016 configuration. */
  capabilityOverrides?: readonly CapabilityOverrideView[]
}

/** How one configuration routes children. */
export type StrategyPlan =
  | { kind: 'pinned' }
  | {
    kind: 'spread'
    strategy: SpreadStrategy
    /** True when top-level provider/model fields are set but ignored by this strategy. */
    ignoredRoute: boolean
  }

/**
 * Resolve the routing plan for a configuration. `pinned` keeps the single
 * explicit route; a spread strategy takes its candidates from `priority`
 * (the sole routing source — ADR 0005) and ignores the top-level
 * provider/model fields.
 * @param config - structural configuration view.
 * @returns the plan.
 */
export function resolveStrategyPlan(config: StrategyConfigView): StrategyPlan {
  if (config.strategy === 'pinned') return { kind: 'pinned' }
  return {
    kind: 'spread',
    strategy: config.strategy,
    ignoredRoute: config.provider !== '' || config.model !== '',
  }
}

/** What one validation pass found. Structural problems refuse to load; degraded ones downgrade with a warning. */
export interface ValidationReport {
  /** Refuse-to-load problems: an over-long `priority`, half-filled entries, repeated routes. */
  structural: string[]
  /** Cross-field combinations that load but behave as if unset: a half-filled or duplicate fallback. */
  degraded: string[]
  /** Informational notes that neither refuse load nor block saving (S7). */
  advisory: string[]
}

/**
 * Validate a configuration. Structural problems (more than 5 `priority`
 * routes, a priority entry missing its provider or model, a repeated route)
 * refuse to load. Cross-field combinations that a settings page could
 * persist degrade instead of throwing — throwing here would brick the plugin
 * on the next Host restart, so an empty `priority` list resolves to no
 * candidates (fallback route, then the resolved route — the legitimate
 * not-assigned state) and a half-filled or duplicate fallback stays unused.
 * Shared with the settings page, which blocks both classes before writing.
 * @param config - structural configuration view.
 * @returns the structural and degraded findings.
 */
export function validateStrategyConfig(config: StrategyConfigView): ValidationReport {
  const structural: string[] = []
  const degraded: string[] = []
  const advisory: string[] = []
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
      structural.push(`dsh-subagent-plus: priority repeats route "${routeId(entry)}"`)
    }
    seen.add(key)
  })
  const fallbackHalfFilled = (config.fallbackProvider === '') !== (config.fallbackModel === '')
  if (fallbackHalfFilled) {
    degraded.push('dsh-subagent-plus: fallback needs both provider and model; it stays unused')
  } else if (fallbackRouteOf(config) === undefined && config.fallbackProvider !== '' && config.fallbackModel !== '') {
    degraded.push(`dsh-subagent-plus: fallback repeats the listed route "${config.fallbackProvider}/${config.fallbackModel}"; it stays unused`)
  }
  const nameMap = config.nameMap ?? []
  // ADR 0016 d3 runtime tolerance: overrides are auxiliary scoring data, never
  // routing structure — a malformed or duplicated hand-edited row degrades
  // (dropped / last-wins) with a warning instead of refusing to load.
  const seenOverridePairs = new Set<string>()
  for (const entry of config.capabilityOverrides ?? []) {
    if (entry.model === '') {
      degraded.push('dsh-subagent-plus: capabilityOverrides row without a model id is ignored')
      continue
    }
    const pair = `${(entry.provider ?? '').trim()}\0${canonicalizeModelId(entry.model)}`
    if (seenOverridePairs.has(pair)) {
      degraded.push(`dsh-subagent-plus: capabilityOverrides repeats "${entry.model}"${(entry.provider ?? '').trim() !== '' ? ` (${(entry.provider ?? '').trim()})` : ''}; the last row wins`)
    }
    seenOverridePairs.add(pair)
  }
  // ADR 0014 d2: with defaults on, derivation wins and stored rows sit
  // ignored — a hand-edited document in that state deserves a warning, not a
  // silent disappearance.
  if (config.nameMapDefaults === true && nameMap.length > 0) {
    // Advisory (S7, audit Y-5): informational — the defaults override the
    // stored rows BY DESIGN; blocking the whole page's save over it (limits
    // namespace included) punished a legal hand-edited state.
    advisory.push('dsh-subagent-plus: nameMapDefaults is on; the stored nameMap rows are ignored while the derived defaults are in effect')
  }
  if (nameMap.length > MAX_NAME_MAP_ENTRIES) {
    structural.push(`dsh-subagent-plus: nameMap lists ${nameMap.length} entries; at most ${MAX_NAME_MAP_ENTRIES} are allowed`)
  }
  const names = new Set<string>()
  nameMap.forEach((entry, index) => {
    if (!isValidKeyword(entry.name)) {
      structural.push(entry.name.length > 64
        ? `dsh-subagent-plus: nameMap[${index}] name exceeds 64 characters`
        : `dsh-subagent-plus: nameMap[${index}] is not a legal role keyword ("${entry.name}")`)
      return
    }
    if (entry.provider === '' || entry.model === '') {
      structural.push(`dsh-subagent-plus: nameMap[${index}] needs both provider and model`)
      return
    }
    // ADR 0007: the candidate list is the sole source of mapped routes — a
    // row referencing a route it removed (or never listed) is meaningless and
    // refuses to load. Several rows may share one listed route.
    if (!seen.has(routeKey(entry))) {
      structural.push(`dsh-subagent-plus: nameMap[${index}] route "${routeId(entry)}" is not in the candidate list`)
      return
    }
    if (names.has(entry.name)) {
      structural.push(`dsh-subagent-plus: nameMap repeats teammate name "${entry.name}"`)
    }
    names.add(entry.name)
  })
  return { structural, degraded, advisory }
}

const KEYWORD_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Whether `keyword` is a legal role keyword (ADR 0008): official lower-kebab
 * substring, at least 2 characters (a single character would match almost
 * every teammate name), at most 64 characters, never the reserved `lead`.
 * @param keyword - candidate row keyword.
 * @returns whether the keyword is usable for substring matching.
 */
export function isValidKeyword(keyword: string): boolean {
  return keyword !== 'lead' && keyword.length >= 2 && keyword.length <= 64 && KEYWORD_PATTERN.test(keyword)
}

/**
 * Match a subagent's team name against the role-keyword mapping (ADR 0008):
 * every row whose keyword is a substring of the team name is a candidate, and
 * the longest keyword wins (the most specific role intent). Equal-length
 * keywords resolve by first occurrence in the map (deterministic). An exact
 * name match is the degenerate case where the keyword equals the full team
 * name — no other keyword can be longer, so it always wins.
 * @param teammateName - team name of the subagent being routed.
 * @param map - mapping rows in configuration order.
 * @returns the best-matching row, or undefined to fall through to the strategy chain.
 */
export function matchByKeyword(teammateName: string, map: readonly NameMapEntryView[]): NameMapEntryView | undefined {
  let best: NameMapEntryView | undefined
  let bestLength = 0
  for (const entry of map) {
    // bestLength starts at 0, so an empty keyword (mid-session hand-edit)
    // never wins — it would need length > 0 to beat the initial value.
    if (teammateName.includes(entry.name) && entry.name.length > bestLength) {
      best = entry
      bestLength = entry.name.length
    }
  }
  return best
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

/** The candidate routes of one configuration: the `priority` list in stored
 *  order — the sole routing source (ADR 0005); an empty list leaves every
 *  spread strategy with no candidates.
 * @param config - structural configuration view.
 * @returns the ordered candidates; empty when nothing is configured.
 */
export function candidateRoutes(config: StrategyConfigView): PinRoute[] {
  return config.priority.map(entry => ({
    provider: entry.provider,
    model: entry.model,
    ...entry.reasoningEffort === '' ? {} : { reasoningEffort: entry.reasoningEffort },
  }))
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
  return `[模型指派 model assigned: 本子智能体所有请求运行 ${label}（策略：${strategyZh(strategy)}｜strategy: ${strategy}）— dsh-subagent-plus]`
}

/** Bilingual notices: the transcript is the only default-on feedback channel,
 *  so zh and en ride the same bracketed line. */
function strategyZh(strategy: SpreadStrategy): string {
  return strategy === 'round-robin' ? '轮询' : strategy === 'random' ? '随机' : '优先级'
}

/**
 * Transcript notice naming the fallback route a child landed on after no
 * candidate route was usable.
 * @param label - `provider/model` of the fallback route.
 * @returns the bracketed one-line notice.
 */
export function fallbackNotice(label: string): string {
  return `[模型兜底 model fallback: 无可用候选路由，本子智能体运行 ${label}｜no usable candidate, runs ${label} — dsh-subagent-plus]`
}

/**
 * Transcript notice naming the pinned route a child is forced onto.
 * @param label - `provider/model` of the pinned route.
 * @returns the bracketed one-line notice.
 */
export function pinnedNotice(label: string): string {
  return `[模型钉定 model pinned: 本子智能体所有请求运行 ${label}｜every request runs ${label} — dsh-subagent-plus]`
}

/**
 * Transcript notice for an unusable pinned route (cooling, or unregistered
 * and skipped by failOpen) that handed the child over to the fallback.
 * @param pinLabel - `provider/model` of the unusable pinned route.
 * @param fallbackLabel - `provider/model` of the fallback now in use.
 * @returns the bracketed one-line notice.
 */
export function pinFallbackNotice(pinLabel: string, fallbackLabel: string): string {
  return `[模型钉定兜底 model pin fallback: 钉定路由 ${pinLabel} 当前不可用（冷却或未注册），本子智能体改用兜底 ${fallbackLabel}｜pinned route ${pinLabel} unavailable, runs fallback ${fallbackLabel} — dsh-subagent-plus]`
}

/**
 * Transcript notice for a pin that failOpen found unregistered with no usable
 * fallback: the child still runs the pinned route and fails loudly (the
 * all-dead semantics), so the notice names that instead of claiming the
 * resolved route is kept.
 * @param label - `provider/model` of the unregistered pinned route.
 * @returns the bracketed one-line notice.
 */
export function pinSkippedNotice(label: string): string {
  return `[模型钉定跳过 model pin skipped: 钉定路由 ${label} 未注册且无可用兜底，本子智能体仍将运行钉定路由（预期响亮失败）｜pinned route ${label} unregistered with no usable fallback; the child still runs the pinned route and fails loudly — dsh-subagent-plus]`
}

/**
 * Transcript notice recording a mid-child failover.
 * @param from - `provider/model` that entered cooldown.
 * @param to - `provider/model` the child continues with.
 * @param code - failure code that triggered the cooldown.
 * @returns the bracketed one-line notice.
 */
export function reassignedNotice(from: string, to: string, code: string): string {
  return `[模型切换 model reassigned: ${from} 冷却中（${code}），本子智能体继续使用 ${to}｜${from} cooling (${code}), continues ${to} — dsh-subagent-plus]`
}

/**
 * Transcript notice naming the mapped route a by-name child runs (ADR 0006).
 * @param name - teammate name that matched the row.
 * @param label - `provider/model` of the mapped route, with an optional
 * `·effort` suffix the caller composes.
 * @returns the bracketed one-line notice.
 */
export function byNameNotice(name: string, label: string): string {
  return `[按角色指派 model assigned by keyword: 匹配角色 "${name}" 的队友所有请求运行 ${label}｜every request of a teammate matching "${name}" runs ${label} — dsh-subagent-plus]`
}

/**
 * Transcript notice for an unusable mapped route (cooling, or unregistered
 * and skipped by failOpen) that handed the child over to the fallback.
 * @param mappedLabel - `provider/model` of the unusable mapped route.
 * @param fallbackLabel - `provider/model` of the fallback now in use.
 * @returns the bracketed one-line notice.
 */
export function byNameFallbackNotice(mappedLabel: string, fallbackLabel: string): string {
  return `[按角色兜底 model keyword fallback: 角色路由 ${mappedLabel} 当前不可用（冷却或未注册），本子智能体改用兜底 ${fallbackLabel}｜role route ${mappedLabel} unavailable, runs fallback ${fallbackLabel} — dsh-subagent-plus]`
}

/**
 * Transcript notice for a Team row running on a takeover CANDIDATE (G3, the
 * middle tier): the mapped route went cooling/unregistered and the next
 * healthy candidate from the list took over — the fallback was not needed.
 * @param name - teammate name that matched the row.
 * @param mappedLabel - `provider/model` of the unavailable mapped route.
 * @param takeoverLabel - `provider/model` of the candidate now in use.
 * @returns the bracketed one-line notice.
 */
export function byNameTakeoverNotice(name: string, mappedLabel: string, takeoverLabel: string): string {
  return `[按角色接管 model keyword takeover: 匹配角色 "${name}" 的路由 ${mappedLabel} 当前不可用，由候选 ${takeoverLabel} 接管（候选清单优先于兜底）｜role route ${mappedLabel} for "${name}" unavailable; candidate ${takeoverLabel} takes over (candidates outrank the fallback) — dsh-subagent-plus]`
}

/**
 * Transcript notice for a mapped route that failOpen found unregistered with
 * no usable fallback: the child still runs the mapped route and fails loudly
 * (mirrors the pin semantics), so the notice names that.
 * @param name - teammate name that matched the row.
 * @param label - `provider/model` of the unregistered mapped route.
 * @returns the bracketed one-line notice.
 */
export function byNameSkippedNotice(name: string, label: string): string {
  return `[按角色跳过 model keyword skipped: 匹配角色 "${name}" 的路由 ${label} 未注册且无可用兜底，本子智能体仍将运行该路由（预期响亮失败）｜role route ${label} for "${name}" unregistered with no usable fallback; the child still runs it and fails loudly — dsh-subagent-plus]`
}
