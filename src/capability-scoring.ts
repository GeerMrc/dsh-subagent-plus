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
import { KB, KB_AS_OF, type KbDims, type KbEntry } from './capability-kb.js'

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
    if (QUANT_SUFFIX.test(`-${tail}`) || DATE_SUFFIX.test(`-${tail}`)) {
      tokens = tokens.slice(0, -1)
      changed = true
    }
  }
  return tokens.join('-')
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

/** Progressive match against the KB (ADR 0016 d1): exact → alias → strip one
 *  suffix at a time and retry — so `Qwen3.8-Flash-Next-NVFP4` finds
 *  `qwen3.8-flash-next` even when the KB also holds the older
 *  `qwen3.8-flash`. Family fallback stays a future build-script concern. */
/** Progressive match against a KB table (ADR 0016 d1): exact → alias → strip
 *  one suffix at a time and retry — so `Qwen3.8-Flash-Next-NVFP4` finds
 *  `qwen3.8-flash-next` even when the table also holds the older
 *  `qwen3.8-flash`. */
export function kbEntryFor(modelId: string, kb: KbTable = KB): { dims: Partial<Record<CapabilityDimension, number>>; estimated: boolean } | undefined {
  const direct = kb[canonicalizeModelId(modelId)]
  if (direct !== undefined) return { dims: direct.dims, estimated: direct.estimated === true }
  let stripped = String(modelId)
  for (let round = 0; round < 4; round += 1) {
    const next = stripOneSuffix(stripped)
    if (next === stripped) break
    stripped = next
    const hit = kb[canonicalizeModelId(stripped)]
    if (hit !== undefined) return { dims: hit.dims, estimated: hit.estimated === true }
  }
  // Variant fan-out fallback (ADR 0016 d1 family fallback, snapshot-scoped):
  // a bare family query (`deepseek-v4.1-flash`) matches its variant entries
  // (`…-flash-max`) by key prefix; prefer the entry with more dimensions, then
  // the higher mean — deterministic under snapshot refreshes.
  const stem = canonicalizeModelId(modelId)
  const fanouts = Object.keys(kb).filter(key => key.startsWith(`${stem}-`))
  if (fanouts.length > 0) {
    const mean = (entry: { dims: KbDims }): number => {
      const values = Object.values(entry.dims)
      return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
    }
    const best = fanouts
      .map(key => kb[key]!)
      .sort((left, right) => Object.keys(right.dims).length - Object.keys(left.dims).length || mean(right) - mean(left))[0]!
    return { dims: best.dims, estimated: best.estimated === true }
  }
  return undefined
}

function stripOneSuffix(raw: string): string {
  const key = canonicalizeModelId(raw)
  // Single-token tails only — a '-' inside the class would let the greedy
  // match cross dashes and strip several tokens at once.
  const tail = /[-_]([a-z0-9.]+)$/.exec(key)
  if (tail === null) return raw
  return key.slice(0, Math.max(0, key.length - tail[1].length - 1))
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
  // Two-pass resolution (ADR 0016 d3, Z10): layer priority is absolute over
  // array order — the qualified pass (exact provider + model pair) runs
  // first, the generic pass (provider-less + model) only on miss; within a
  // pass, last-wins (a hand-edited list resolves to its final word).
  const route = normalizeProvider(provider)
  const modelKey = canonicalizeModelId(modelId)
  const pickPass = (wanted: string): CapabilityOverride | undefined => {
    let found: CapabilityOverride | undefined
    for (const entry of overrides) {
      if (canonicalizeModelId(entry.model) !== modelKey) continue
      if (normalizeProvider(entry.provider) === wanted) found = entry
    }
    return found
  }
  // Qualified pass first (exact route), then the generic pass — layer priority
  // absolute over array order; last-wins inside each pass.
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

export { KB, KB_AS_OF }
