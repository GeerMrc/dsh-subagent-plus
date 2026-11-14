/**
 * Capability scoring over the benchmark KB (ADR 0016 d2/d3) — pure,
 * dependency-free so the client half imports it without dragging host
 * packages into the bundle (the MAX_NAME_MAP_ENTRIES precedent).
 *
 * Layering: L2 user overrides (config.capabilityOverrides, 0-100 linear /100)
 * beat L0 KB rank fractions dimension-by-dimension; dimensions absent from
 * both fill at the 0.5 median (missing evidence must not outrank proven
 * evidence — ADR 0016 d1); a model absent from both is UNKNOWN and is the
 * last resort for every slot (never promoted by argmin — A-1).
 */
import { KB, KB_AS_OF, type KbEntry } from './capability-kb.js'

/** The KB face the resolver reads — injectable so tests pin behaviour against
 *  fixture tables instead of the live snapshot. */
export type KbTable = Record<string, KbEntry>

/** The four capability dimensions the KB and overrides carry. */
export type CapabilityDimension = 'overall' | 'coding' | 'webdev' | 'agentic'

/** One user-imported evaluation row (config.capabilityOverrides entry). */
export interface CapabilityOverride {
  /** Route qualifier (Z10): when set, the row scores only the candidate with
   *  this provider id — the escape hatch for same-model-different-provider
   *  serving (relays, quantisation, quota). Empty/whitespace/absent = generic
   *  (the row applies to every route of the model). */
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

/** Slot families of the starter template with their dimension weights
 *  (ADR 0016 d2 — opinionated defaults: direction community-evidenced,
 *  numbers are design constants; F carries no weights). */
export const FAMILY_WEIGHTS = {
  /** 质量把关：review/audit/verif/plan — coding-first. */
  S: { coding: 0.45, overall: 0.25, agentic: 0.20, webdev: 0.10 },
  /** 执行构建：research/dev/build/execute/write/design — coding+overall with a webdev tilt. */
  B: { coding: 0.40, overall: 0.30, webdev: 0.20, agentic: 0.10 },
} as const

const QUANT_SUFFIX = /[-_](fp8|fp8-?hf|fp4|nvfp4|int8|int4|awq|gptq(?:-int4)?|gguf|bnb-[48]bit)$/i
const DATE_SUFFIX = /[-_](\d{4}-\d{2}-\d{2}|\d{8}|0\d{2}|\d{4,6})$/
/** Context-size variant tails (k3-256k, claude-…-32k): the underlying model is
 *  the same, so the tail strips exactly like a quantisation marker. Parameter
 *  sizes (llama-3-8b, qwen2-72b) are deliberately NOT stripped — they are part
 *  of the official id. */
const CONTEXT_TAIL = /^\d+[km]$/i
/** Hyphenated single-digit version pairs fold to the dotted spelling
 *  (3-5 ≡ 3.5, 4-8 ≡ 4.8) — Anthropic ships both forms across its ids while
 *  the KB mixes them. The lookarounds keep size suffixes intact: `4-32k` and
 *  `2-72b` keep their hyphen because the right digit continues into a word. */
const VERSION_PAIR = /(?<!\d)(\d)-(\d)(?![\w.])/g

/** Canonical KB key for a raw model identifier (ADR 0016 d1). Provider
 *  deployment names never take part — only the model id string does. */
export function canonicalizeModelId(raw: string): string {
  let name = raw.toLowerCase().trim()
  name = name.replace(/^[a-z0-9_.-]+\//, '') // vendor namespace inside the model id
  name = name.replace(/:[a-z0-9-]+$/, '') // router variant suffixes
  name = name.replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim()
  // Strip date/snapshot suffixes BEFORE tokenising — split on '-' would shatter
  // '2025-02-15' into tokens the per-token patterns can no longer see.
  name = name.replace(/[\s-_]\d{4}-\d{2}-\d{2}$/, '').replace(/[\s-_]\d{8}$/, '').replace(/[\s-_]0\d{2}$/, '')
  let tokens = name.split(/[\s-_]+/).map(token => token.replace(/[^a-z0-9.]/g, '')).filter(Boolean)
    // Pure-digit snapshot tokens (20260910, 0902, 0117) strip wherever they sit —
    // version tokens (3.8, 4o, v4) carry dots/letters and never match.
    .filter(token => !/^\d{8}$|^0\d{2}$|^\d{4}$|^\d{5,6}$/.test(token))
  let changed = true
  while (changed && tokens.length > 1) {
    changed = false
    const tail = tokens[tokens.length - 1] ?? ''
    if (QUANT_SUFFIX.test(`-${tail}`) || DATE_SUFFIX.test(`-${tail}`) || CONTEXT_TAIL.test(tail)) {
      tokens = tokens.slice(0, -1)
      changed = true
    }
  }
  return tokens.join('-').replace(VERSION_PAIR, '$1.$2')
}

/** Curated official-id stems (ADR 0016 3a F1): the only reliable bridge for
 *  official catalogue ids that carry no generation infix — the harness stores
 *  `deepseek-flash` while every KB key of the family carries `v4.1`-style
 *  infixes, and Moonshot's short alias `k3` fronts `kimi-k3`. Keyed by the
 *  canonical query, valued by the canonical family stem (resolved through the
 *  normal cascade, usually via variant fan-out). Vendor-repeat folding is
 *  deliberately NOT here: `deepseek/deepseek-r1` is hyphenated officially
 *  while `qwen/qwen-2.5-x` is contracted — the same input shape with opposite
 *  correct outputs, unresolvable at runtime without a per-vendor table (that
 *  table IS this table; the enumerable OpenRouter forms land as KB aliases at
 *  build time instead). Maintained alongside each KB snapshot: a rebuild that
 *  absorbs a row must delete it (guarded by a spec invariant). */
export const OFFICIAL_ID_STEMS: Readonly<Record<string, string>> = {
  'deepseek-flash': 'deepseek-v4.1-flash',
  k3: 'kimi-k3',
}

/** The resolved capability view of one model id. */
export interface CapabilityView {
  /** Dimension scores in [0,1]; absent dimensions are missing (callers apply the 0.5 fill). */
  dims: Partial<Record<CapabilityDimension, number>>
  /** The primary anchor (coding) is missing in every layer. */
  estimated: boolean
  /** No layer knows this model at all. */
  unknown: boolean
  /** Which layer supplied the score — surfaced in the UI. */
  source: 'override' | 'kb' | 'none'
}

/** One resolved KB row as the resolver returns it. */
export interface KbHit {
  dims: Partial<Record<CapabilityDimension, number>>
  estimated: boolean
}

const toHit = (entry: KbEntry): KbHit => ({ dims: entry.dims, estimated: entry.estimated === true })

/** Normalized lookup index of one KB table: canonical(key) → merged entry,
 *  plus canonical(alias) → entry for aliases whose canonical form diverges
 *  from every key (the OpenRouter cross-references, F4). Both sides run
 *  through the same canonicalizer, so the shipped file needs no migration —
 *  keys regenerate normalized at the next snapshot rebuild. WeakMap-cached:
 *  the shipped KB and test fixtures are stable objects — a table mutated
 *  after a lookup stays stale by design, so tests rebuild fixture objects
 *  (spread copies), never mutate a previously looked-up one. */
interface KbLookup {
  /** Canonical key/alias → merged entry (alias rows bridge EXACT lookups). */
  readonly index: Map<string, KbEntry>
  /** Canonical forms of the table's OWN keys — fan-out candidates only.
   *  An alias row whose canonical form extends a stem (qwen-2.5-…) must not
   *  let a different subfamily (qwen/qwen-2.5-72b) fan out onto it. */
  readonly primaries: ReadonlySet<string>
}

const lookupCache = new WeakMap<KbTable, KbLookup>()

function kbLookup(kb: KbTable): KbLookup {
  const cached = lookupCache.get(kb)
  if (cached !== undefined) return cached
  const index = new Map<string, KbEntry>()
  const add = (canonical: string, entry: KbEntry): void => {
    const existing = index.get(canonical)
    if (existing === undefined) {
      index.set(canonical, entry)
      return
    }
    if (existing === entry) return
    // Collision under the hardened canonicalizer (e.g. a snapshot carrying
    // both `claude-3-5-sonnet` and `claude-3.5-sonnet`): keep the weakest
    // observed signal per dimension, mirroring the build script's merge.
    const merged: KbEntry = { aliases: [...existing.aliases, ...entry.aliases], dims: {} }
    for (const dimension of ['overall', 'coding', 'webdev', 'agentic'] as const) {
      const left = existing.dims[dimension]
      const right = entry.dims[dimension]
      if (left !== undefined && right !== undefined) merged.dims[dimension] = Math.min(left, right)
      else if (left !== undefined || right !== undefined) merged.dims[dimension] = (left ?? right) as number
    }
    if (existing.estimated === true || entry.estimated === true) merged.estimated = true
    index.set(canonical, merged)
  }
  const primaries = new Set<string>()
  for (const [key, entry] of Object.entries(kb)) {
    const canonical = canonicalizeModelId(key)
    primaries.add(canonical)
    add(canonical, entry)
  }
  for (const entry of Object.values(kb)) {
    for (const alias of entry.aliases) add(canonicalizeModelId(alias), entry)
  }
  const lookup: KbLookup = { index, primaries }
  lookupCache.set(kb, lookup)
  return lookup
}

/** Variant fan-out from one stem: match PRIMARY keys with the `stem-` prefix
 *  and keep the entry with more dimensions, then the higher mean —
 *  deterministic under snapshot refreshes. Alias-derived index rows never fan
 *  out (review 🟡#1: qwen/qwen-2.5-72b must not absorb the coder-32B alias).
 *  Callers guard single-token stems (never fan out). */
function fanoutBest(stem: string, lookup: KbLookup): KbHit | undefined {
  const fanouts = [...lookup.primaries].filter(key => key.startsWith(`${stem}-`))
  if (fanouts.length === 0) return undefined
  const mean = (entry: KbEntry): number => {
    const values = Object.values(entry.dims)
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
  }
  const best = fanouts
    .map(key => lookup.index.get(key)!)
    .sort((left, right) => Object.keys(right.dims).length - Object.keys(left.dims).length || mean(right) - mean(left))[0]!
  return toHit(best)
}

/** Progressive match against a KB table (ADR 0016 d1 + 3a F1), strictly in
 *  order: curated official stem → exact key/alias → strip one token at a time
 *  (up to four) re-checking exactly → variant fan-out over the surviving
 *  stems longest-first. Single-token stems never fan out — a bare vendor id
 *  bridges nothing (the hazard the first F1 draft shipped). */
export function kbEntryFor(modelId: string, kb: KbTable = KB): KbHit | undefined {
  const lookup = kbLookup(kb)
  const stem = canonicalizeModelId(modelId)
  const curated = OFFICIAL_ID_STEMS[stem]
  if (curated !== undefined) {
    const hit = lookup.index.get(curated)
    if (hit !== undefined) return toHit(hit)
    if (curated.includes('-')) {
      const fan = fanoutBest(curated, lookup)
      if (fan !== undefined) return fan
    }
  }
  const direct = lookup.index.get(stem)
  if (direct !== undefined) return toHit(direct)
  // Strip-exact rounds: collect every intermediate stem, longest first.
  const stems = [stem]
  let current = stem
  for (let round = 0; round < 4; round += 1) {
    const tail = /-([a-z0-9.]+)$/.exec(current)
    if (tail === null) break
    current = current.slice(0, current.length - tail[1].length - 1)
    stems.push(current)
    const hit = lookup.index.get(current)
    if (hit !== undefined) return toHit(hit)
  }
  // Fan-out retry, longest stem first — after every strip-exact round missed.
  for (const candidate of stems) {
    if (!candidate.includes('-')) continue // single-token guard
    const hit = fanoutBest(candidate, lookup)
    if (hit !== undefined) return hit
  }
  return undefined
}

const asOverrideDims = (entry: CapabilityOverride): Partial<Record<CapabilityDimension, number>> => ({
  ...(entry.overall === undefined ? {} : { overall: entry.overall / 100 }),
  ...(entry.coding === undefined ? {} : { coding: entry.coding / 100 }),
  ...(entry.webdev === undefined ? {} : { webdev: entry.webdev / 100 }),
  ...(entry.agentic === undefined ? {} : { agentic: entry.agentic / 100 }),
})

/** Resolve one model id through the L2 > L0 > missing chain (ADR 0016 d3).
 *  Dimension-level precedence: an override dimension wins; dimensions the
 *  override omits fall back to the KB; what neither has stays missing. */
/** Normalised route qualifier: whitespace trims to '' (= generic). */
const normalizeProvider = (provider: string | undefined): string => (provider ?? '').trim()

export function capabilityOf(modelId: string, overrides: readonly CapabilityOverride[] = [], kb: KbTable = KB, provider?: string): CapabilityView {
  const route = normalizeProvider(provider)
  const modelKey = canonicalizeModelId(modelId)
  // Two-pass resolution (ADR 0016 d3, Z10): layer priority is absolute over
  // array order — the qualified pass (exact provider + model pair) runs
  // first, the generic pass only on miss; last-wins inside each pass.
  const pickPass = (wanted: string): CapabilityOverride | undefined => {
    let found: CapabilityOverride | undefined
    for (const entry of overrides) {
      if (canonicalizeModelId(entry.model) !== modelKey) continue
      if (normalizeProvider(entry.provider) === wanted) found = entry
    }
    return found
  }
  const override = route !== ''
    ? pickPass(route) ?? pickPass('')
    : pickPass('')
  const kbHit = kbEntryFor(modelId, kb)
  if (override === undefined && kbHit === undefined) {
    return { dims: {}, estimated: true, unknown: true, source: 'none' }
  }
  const dims: Partial<Record<CapabilityDimension, number>> = { ...(kbHit?.dims ?? {}) }
  if (override !== undefined) {
    // A winning override replaces the route wholesale (Z10): its missing
    // dimensions keep the KB fill — a generic row never contributes to a
    // route a qualified row won.
    const overrideDims = asOverrideDims(override)
    for (const dimension of ['overall', 'coding', 'webdev', 'agentic'] as CapabilityDimension[]) {
      const value = overrideDims[dimension]
      if (value !== undefined) dims[dimension] = value
    }
  }
  const estimated = dims.coding === undefined
  return { dims, estimated, unknown: false, source: override !== undefined ? 'override' : 'kb' }
}

/** Family-weighted score with the 0.5 median fill for missing dimensions. */
export function familyScore(view: CapabilityView, family: keyof typeof FAMILY_WEIGHTS): number {
  if (view.unknown) return Number.NaN
  let score = 0
  for (const [dimension, weight] of Object.entries(FAMILY_WEIGHTS[family]) as [CapabilityDimension, number][]) {
    score += weight * (view.dims[dimension] ?? 0.5)
  }
  return score
}

/** The three-state KB visibility of one model id (ADR 0016 3a F2): the single
 *  predicate the client badge, the summary line, and the runtime warn all
 *  read, so an override rescue is visible everywhere at once.
 *  - `anchored`: some layer knows the model AND carries the coding anchor.
 *  - `known`: some layer knows the model, coding anchor missing (estimated).
 *  - `unknown`: no layer knows it — last resort for every slot (A-1). */
export type KbStatus = 'anchored' | 'known' | 'unknown'

/** @param modelId - raw model identifier as listed in the candidate routes.
 *  @param overrides - user-imported evaluation rows (L2), rescue path included.
 *  @param kb - KB table override for tests.
 *  @param provider - route qualifier; a qualified override scores only its route.
 *  @returns the three-state visibility of the model. */
export function kbStatusOf(modelId: string, overrides: readonly CapabilityOverride[] = [], kb: KbTable = KB, provider?: string): KbStatus {
  const view = capabilityOf(modelId, overrides, kb, provider)
  if (view.unknown) return 'unknown'
  return view.estimated ? 'known' : 'anchored'
}

export { KB, KB_AS_OF }
