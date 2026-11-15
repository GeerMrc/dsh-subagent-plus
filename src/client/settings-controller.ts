/**
 * Pure settings-section logic for dsh-subagent-plus: a draft-editing
 * controller over the host's shared config form (revision-fenced writes) plus
 * the model catalogue. Shared validation (structural AND cross-field) gates
 * every save before it reaches the wire, so the page can never persist a
 * combination that would brick the plugin on the next Host restart. No React,
 * no remote calls beyond the injected ports — the section component renders
 * the published snapshot.
 *
 * Every action is an arrow class property so sections can pass them directly
 * as event handlers without losing `this`.
 *
 * @module dsh-subagent-plus/client/settings-controller
 */
import { canonicalizeModelId, kbEntryFor } from '../capability-scoring.js'
import {
  deriveStarterRows,
  MAX_CAPABILITY_OVERRIDES,
  MAX_NAME_MAP_ENTRIES,
  resolveNameMapDefaults,
  validateStrategyConfig,
  type CapabilityOverrideView,
  type NameMapEntryView,
  type Strategy,
} from '../strategy.js'
import type { PinConfig } from '../config.js'
import type { SaveOutcome } from './unified-save.js'

/** Maximum candidate routes; mirrors the schema bound. */
export const MAX_ROUTES = 5

/** Cooldown upper bound: 24h — beyond it a route is effectively frozen forever. */
const MAX_COOLDOWN_MS = 86_400_000

/** One reasoning effort a model supports, from the catalogue. */
export interface EffortOption {
  /** Effort id (= the wire vocabulary: off/low/…/xhigh/max). */
  id: string
  /** Display name (title-cased). */
  name: string
}

/** One selectable route: catalogue identity, display names, and reasoning efforts. */
export interface RouteOption {
  /** Provider id. */
  provider: string
  /** Model id. */
  model: string
  /** Provider display name from the catalogue. */
  providerName: string
  /** Model display name from the catalogue. */
  modelName: string
  /** Efforts the model supports; absent = the model has no reasoning levels. */
  efforts?: readonly EffortOption[]
  /** The model's configured default effort id, when any. */
  defaultEffort?: string
  /** Catalogue description (ADR 0015): a capability tie-break hint. */
  description?: string
}

/** One model-catalogue group as it crosses the wire (session/modelCatalog). */
export interface CatalogGroup {
  /** Provider id. */
  id: string
  /** Provider display name. */
  name: string
  /** Models under the provider. */
  models: { id: string; name: string; description?: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[]
}

/** The catalogue face the controller reads; injected from `remote.session.modelCatalog`. */
export interface CatalogPort {
  /** Load the route catalogue; an error yields no routes without failing the page. */
  load(): Promise<{ groups: CatalogGroup[]; failureCount: number }>
}

/** One queued field write, mirroring the host's settings path-op shape. */
export interface FieldSetOp {
  op: 'set'
  path: string[]
  value: unknown
}

/** The shared config-form face this controller edits. */
export interface SettingsFormPort {
  /** The form's sync snapshot: `ready` carries the committed value and revision. */
  getSnapshot(): { status: string; value?: unknown; revision?: number }
  /** Observe snapshot replacements. */
  subscribe(listener: () => void): () => void
  /** Queue one atomic namespace mutation behind the revision fence. */
  mutate(ops: readonly FieldSetOp[], expectedRevision?: number): Promise<boolean>
}

/** Render-ready state for the section component. Save outcome feedback
 *  (saved/failed/conflict) is the unified footer's domain; this controller
 *  only reports it through the save() return value. */
export interface SettingsUiState {
  /** `unavailable` hides the editor (the host does not serve the namespace). */
  status: 'loading' | 'ready' | 'unavailable'
  /** The committed value, when ready. */
  value: PinConfig | undefined
  /** The form is ready but its value is not a recognizable plugin config
   *  (a hand-edited patch entry with missing fields) — the editor stays
   *  hidden and an explanatory line renders instead of a permanent "…". */
  valueInvalid: boolean
  /** The local edit; diverges from `value` until save or reset. */
  draft: PinConfig | undefined
  /** Structural problems — refuse to save. */
  structural: string[]
  /** Cross-field combinations the host would degrade — the page blocks them too. */
  degraded: string[]
  /** Informational validation notes — displayed, never blocking (S7). */
  advisory: string[]
  /** The parsed cooldown is not a valid non-negative integer. */
  cooldownInvalid: boolean
  /** Catalogue routes in catalogue order. */
  routes: RouteOption[]
  /** Catalogue routes not already listed (add-select options). */
  addableRoutes: RouteOption[]
  /** Whether the candidate list hit the 5-route bound. */
  atLimit: boolean
  /** Whether the model catalogue failed to load (routes stay empty). */
  catalogFailed: boolean
  /** The mapping rows routing actually reads (ADR 0014 d2): derived rows under
   *  defaults-on (spread only — the R1 mirror), stored rows otherwise. A
   *  computed view — never part of the draft, so it cannot dirty the page. */
  effectiveNameMap: NameMapEntryView[]
}

function isPinConfig(value: unknown): value is PinConfig {
  return typeof value === 'object' && value !== null && typeof (value as PinConfig).strategy === 'string'
}

function copyConfig(value: PinConfig): PinConfig {
  return {
    ...value,
    priority: value.priority.map(entry => ({ ...entry })),
    nameMap: value.nameMap.map(entry => ({ ...entry })),
    // Row-level deep copy (Za, review P-1): the shallow spread left the draft
    // sharing the committed overrides array, so removeCapabilityOverride's
    // splice mutated the committed value too — fieldOps then saw no difference
    // and the removal never persisted.
    capabilityOverrides: value.capabilityOverrides.map(entry => ({ ...entry })),
  }
}

/** Whether any of `fields` differs between the committed value and the draft
 *  (S5: the shared per-section dirty predicate — the same JSON comparison
 *  fieldOps uses, so a badge never disagrees with the save op stream).
 *  Pure function over the two snapshots; `undefined` drafts are never dirty. */
export function anyFieldDirty(value: PinConfig | undefined, draft: PinConfig | undefined, fields: readonly (keyof PinConfig)[]): boolean {
  if (value === undefined || draft === undefined) return false
  return fields.some(field => JSON.stringify(value[field]) !== JSON.stringify(draft[field]))
}

/**
 * Field ops carrying every top-level difference between the committed value
 * and the draft — one atomic mutate on save.
 * @param committed - the form's committed value.
 * @param draft - the local edit.
 * @returns one `set` op per changed field.
 */
export function fieldOps(committed: PinConfig, draft: PinConfig): FieldSetOp[] {
  const ops: FieldSetOp[] = []
  for (const key of Object.keys(draft) as (keyof PinConfig)[]) {
    if (JSON.stringify(committed[key]) === JSON.stringify(draft[key])) continue
    ops.push({ op: 'set', path: [key], value: draft[key] })
  }
  return ops
}

/** Join the draft's routes with the catalogue for display; missing routes stay visible as unavailable. */
function joinRoutes(draft: PinConfig | undefined, routes: readonly RouteOption[]): { provider: string; providerName: string; model: string; modelName: string; available: boolean; efforts?: readonly EffortOption[]; defaultEffort?: string; description?: string }[] {
  if (draft === undefined) return []
  return draft.priority.map(entry => {
    const hit = routes.find(route => route.provider === entry.provider && route.model === entry.model)
    return {
      provider: entry.provider,
      providerName: hit?.providerName ?? entry.provider,
      model: entry.model,
      modelName: hit?.modelName ?? entry.model,
      available: hit !== undefined,
      // Unavailable rows keep no effort data; their stored effort value stays
      // in the draft untouched and saves back verbatim.
      efforts: hit?.efforts,
      defaultEffort: hit?.defaultEffort,
      description: hit?.description,
    }
  })
}

/**
 * Options for one model's effort select: the always-present default row
 * (empty value = omit the key, the host materialises the model default),
 * then the model's efforts by name. A stored id outside the current set
 * stays visible as a stale option so a loaded value is never silently
 * dropped (the runtime validation owns rejecting it).
 * @param route - the selected route, when known.
 * @param value - the currently stored effort id ('' = default).
 * @returns ordered options plus whether the stored value is stale.
 */
export function effortOptions(route: Pick<RouteOption, 'efforts' | 'defaultEffort'> | undefined, value: string): { options: { value: string; label: string }[]; stale: boolean } {
  const efforts = route?.efforts
  if (efforts === undefined || efforts.length === 0) return { options: [], stale: false }
  const nameOf = (id: string): string => efforts.find(effort => effort.id === id)?.name ?? id
  const options: { value: string; label: string }[] = []
  const stale = value !== '' && !efforts.some(effort => effort.id === value)
  if (stale) options.push({ value, label: value })
  for (const effort of efforts) options.push({ value: effort.id, label: effort.name })
  return { options, stale }
}

/** The default row's label: names the model's configured default when it has one. */
export function effortDefaultLabel(route: Pick<RouteOption, 'efforts' | 'defaultEffort'> | undefined, withName: string, withoutName: string): string {
  if (route?.defaultEffort === undefined) return withoutName
  const name = route.efforts?.find(effort => effort.id === route.defaultEffort)?.name ?? route.defaultEffort
  return withName.replace('{name}', name)
}

/** Options for the add-select: catalogue routes not already listed. */
export function addableRoutesOf(draft: PinConfig | undefined, routes: readonly RouteOption[]): RouteOption[] {
  if (draft === undefined) return [...routes]
  return routes.filter(route => !draft.priority.some(entry => entry.provider === route.provider && entry.model === route.model))
}

/** Where an override row's route resolves right now (Z10/P-3: ONE shared
 *  predicate and ONE precedence for the import feedback, the list badge, and
 *  the export annotation — candidate > kb > none; a qualified row matches a
 *  candidate only on the exact provider route, and a route that resolves
 *  nowhere in the catalogue reports 'route-miss' so a mistyped provider is
 *  visible instead of a silent dead row). */
export type OverrideMatch = 'candidate' | 'kb' | 'none' | 'route-miss'

export function matchOverrideRoute(
  row: { provider?: string; model: string },
  catalogue: readonly { provider: string; model: string }[],
  candidates: readonly { provider: string; model: string }[],
): OverrideMatch {
  const key = canonicalizeModelId(row.model)
  const route = (row.provider ?? '').trim()
  if (route !== '') {
    const exactCandidate = candidates.some(entry => entry.provider === route && canonicalizeModelId(entry.model) === key)
    if (exactCandidate) return 'candidate'
    const exactRoute = catalogue.some(entry => entry.provider === route && canonicalizeModelId(entry.model) === key)
    if (!exactRoute) return 'route-miss'
  } else if (candidates.some(entry => canonicalizeModelId(entry.model) === key)) {
    return 'candidate'
  }
  if (kbEntryFor(row.model) !== undefined) return 'kb'
  return 'none'
}

/** One research-package candidate entry. */
export interface ResearchCandidate {
  provider: string
  model: string
  /** Where the model currently resolves (candidate / kb / none). */
  match: 'candidate' | 'kb' | 'none'
}

/**
 * Build the exportable research package (ADR 0016 d3): the current candidates
 * with their match status plus the bilingual research prompt. The consumer
 * feeds the prompt to any capable model and imports the JSON it produces.
 * @param candidates - effective candidate list with match status.
 * @returns the JSON-serialisable package.
 */
export function buildResearchPackage(candidates: readonly ResearchCandidate[], today: string): Record<string, unknown> {
  // Export fidelity (Z10): the candidates array lists EVERY catalogue entry —
  // the same model through several providers stays visible (the user's
  // multi-route reality). The PROMPT list still scores one row per distinct
  // model (capability is model-intrinsic), annotated with its access routes so
  // nothing is hidden from the evaluator.
  const models = new Map<string, { model: string; providers: string[]; candidate: boolean; unknown: boolean }>()
  for (const entry of candidates) {
    const key = canonicalizeModelId(entry.model)
    const record = models.get(key) ?? { model: entry.model, providers: [], candidate: false, unknown: entry.match === 'none' }
    if (!record.providers.includes(entry.provider)) record.providers.push(entry.provider)
    if (entry.match === 'candidate') record.candidate = true
    if (entry.match === 'kb') record.unknown = false
    models.set(key, record)
  }
  const unique = [...models.values()]
  const line = (record: { model: string; providers: string[]; candidate: boolean; unknown: boolean }): string => {
    const notes: string[] = []
    if (record.providers.length > 1) notes.push(`via ${record.providers.join(' / ')}`)
    if (record.candidate) notes.push('current candidate')
    else if (record.unknown) notes.push('unknown model — estimate by comparable positioning')
    return `- ${record.model}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`
  }
  // Hardened output contract (Z11): exact-count, order correspondence,
  // self-contained rows, note hygiene, and a self-check — each clause grounded
  // in the prompt-engineering evidence collected in the ADR (count constraints
  // are the most fragile class, so the importer merges duplicates as the
  // program-side backstop).
  const prompt = [
    'You are a model-capability evaluator. Score the models below 0-100 on four dimensions.',
    'Scores express each model\'s position against the current mainstream population: 50≈median, 70≈top quartile, 90≈top decile.',
    'Dimensions: overall / coding / webdev (frontend web development) / agentic (autonomous tool use).',
    'The list is the distinct model inventory of this environment (the full catalogue may serve one model through several providers — score the MODEL once regardless of access routes); ground your scores in public benchmarks and community testing. Models marked "current candidate" are actively listed.',
    'Before scoring each model, recall its most recent public benchmark results; when sources conflict, prefer the more recent reproducible source and note the conflict in the note field.',
    'Avoid compressing scores into the 55-75 band; use the full 0-100 range the anchors describe.',
    // R2 process discipline (2026-11-17): three evidence-based clauses — the
    // session logs showed search-vs-reason drifting per run (scores swung
    // 74-75 vs 62-64 on the same model), single-sourcing went unmarked, and
    // each session followed its own order. Capability-conditional so
    // tool-less evaluators stay compliant.
    'If you have web/search tools, you MUST search each model for its recent public benchmarks and community tests BEFORE scoring it; if you have no search capability, score from your own knowledge and mark every note with (no-search).',
    // R3: per-MODEL basis (per-score double-sourcing was silently economized —
    // session fb461bc8 showed one mark across eight notes) and a MANDATORY
    // trailing tag so compliance is visible in BOTH outcomes.
    'Gather at least two independent credible sources for EACH MODEL (official benchmark pages, leaderboards, reproducible community evaluations); End every note with a source tag: (2src) when two or more independent sources support its scores, (1src) when only one source was found.',
    'Work through the models in the listed order — evidence, resolve conflicts, score, write the note — and output only after all are done.',
    `Output a JSON array with EXACTLY ${unique.length} objects — one per listed model, in the listed order. Each object: {"model": "<exact id>", "overall": n, "coding": n, "webdev": n, "agentic": n, "asOf": "${today}", "note": "..."}.`,
    'Every object must be self-contained and independently understandable: write each field in full. Never write "same as above", "同上", "ditto", or refer to other items.',
    'Each note is plain text, at most 120 characters, stating the concrete basis (benchmark names and scores when available). Do not emit citation markers such as [reference:N] or [1] in any field.',
    'Before finishing, verify the array has exactly this many items, each model appears exactly once, and every note ends with a (2src) or (1src) tag; fix whatever fails.',
    'JSON only, no prose. Wrap the entire JSON array in a single fenced code block tagged json (starting ```json and ending ```) with nothing outside the fence — this makes the reply render as a copyable code card. Models:',
    ...unique.map(line),
  ].join('\n')
  return {
    schema: 2,
    exportedAt: today,
    dimensions: ['overall', 'coding', 'webdev', 'agentic'],
    // Full catalogue, entry per provider route — this documents the
    // environment; the prompt above is the scoring unit.
    candidates: candidates.map(entry => ({ provider: entry.provider, model: entry.model, match: entry.match })),
    prompt,
  }
}

/**
 * Draft-editing controller for the plugin's settings section.
 */
/**
 * Parse a pasted research payload (J1 fence tolerance; J2 web-chat tolerance):
 * real replies arrive in more shapes than DSH's clean fenced block — prose
 * around the JSON, trailing commas, numeric strings, wrapper objects, a
 * draft block followed by the corrected final answer, or token-limit
 * truncation. Candidate strings are tried in order (whole text → fenced
 * blocks last-first, a corrected final answer follows a draft → the first
 * `[`…last `]` span for prose-wrapped arrays); each candidate gets trailing
 * commas stripped before parsing, parsed wrapper objects unwrap ONE
 * whitelisted array key (results/models/rows/data/evaluations — bounded,
 * never fuzzy), and numeric-string scores coerce to numbers. The export
 * PACKAGE itself reports its own kind for the friendly pointer; an
 * unclosed array reports TRUNCATED so the user re-copies instead of
 * guessing at a generic failure.
 * @param text - the raw clipboard paste.
 * @returns the parsed rows, the package marker, the truncation marker, or invalid.
 */
const WRAPPER_KEYS = ['results', 'models', 'rows', 'data', 'evaluations'] as const

const coerceNumericStrings = (row: unknown): unknown => {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const key of ['overall', 'coding', 'webdev', 'agentic'] as const) {
    const value = out[key]
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) out[key] = Number(value.trim())
  }
  return out
}

export function parseResearchPaste(text: string): { kind: 'rows'; rows: unknown[] } | { kind: 'package' } | { kind: 'truncated' } | { kind: 'invalid' } {
  const trimmed = text.trim()
  const candidates: string[] = [trimmed]
  const blocks = [...trimmed.matchAll(/```[^\n]*\n([\s\S]*?)\n?```/g)].map(match => match[1]!.trim())
  for (let index = blocks.length - 1; index >= 0; index -= 1) candidates.push(blocks[index]!)
  const firstBracket = trimmed.indexOf('[')
  const lastBracket = trimmed.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) candidates.push(trimmed.slice(firstBracket, lastBracket + 1))
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'))
    } catch {
      continue
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      if ('prompt' in record) return { kind: 'package' }
      const wrapper = WRAPPER_KEYS.find(key => Array.isArray(record[key]))
      if (wrapper === undefined) continue
      parsed = record[wrapper]
    }
    if (Array.isArray(parsed)) return { kind: 'rows', rows: parsed.map(coerceNumericStrings) }
  }
  // An unclosed array reads as truncation (re-copy advice), not garbage.
  if (firstBracket !== -1 && lastBracket <= firstBracket) return { kind: 'truncated' }
  return { kind: 'invalid' }
}

export class SettingsSectionController {
  readonly #form: SettingsFormPort
  readonly #catalog: CatalogPort
  readonly #listeners = new Set<() => void>()
  #state: SettingsUiState
  #unsubscribe: (() => void) | undefined
  #disposed = false

  /**
   * @param form - the shared config form for this plugin's namespace.
   * @param catalog - the model-catalogue port.
   */
  constructor(form: SettingsFormPort, catalog: CatalogPort) {
    this.#form = form
    this.#catalog = catalog
    this.#state = {
      status: 'loading',
      value: undefined, valueInvalid: false, draft: undefined, structural: [], degraded: [], advisory: [], cooldownInvalid: false,
      routes: [], addableRoutes: [], atLimit: false, catalogFailed: false, effectiveNameMap: [],
    }
  }

  /** Subscribe to snapshot replacements (useSyncExternalStore contract). */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** The current render-ready snapshot (stable reference until the next change). */
  snapshot = (): SettingsUiState => this.#state

  /** Bind to the form and load the catalogue; idempotent across whileServed re-registrations. */
  init = (): void => {
    if (this.#unsubscribe !== undefined) return
    this.#unsubscribe = this.#form.subscribe(() => { this.#sync() })
    this.#sync()
    void this.refreshCatalog()
  }

  /** Drop the form subscription; the section effect's disposer calls this. */
  dispose = (): void => {
    this.#disposed = true
    this.#unsubscribe?.()
    this.#listeners.clear()
  }

  /** Reload the model catalogue (adapter or settings invalidation); one in-flight load per generation. */
  refreshCatalog = async (): Promise<void> => {
    if (this.#catalogInFlight) return
    this.#catalogInFlight = true
    try {
      const catalog = await this.#catalog.load()
      if (this.#disposed) return
      this.#patch({ routes: catalog.groups.flatMap(group => group.models.map(model => ({
        provider: group.id, model: model.id, providerName: group.name, modelName: model.name,
        efforts: model.reasoning?.efforts,
        defaultEffort: model.reasoning?.defaultEffort,
        description: model.description,
      }))), catalogFailed: false })
    } catch {
      if (this.#disposed) return
      this.#patch({ routes: [], catalogFailed: true })
    } finally {
      this.#catalogInFlight = false
    }
  }

  #catalogInFlight = false
  /** Re-entry guard for save(); the footer's `saving` is the unified
   *  controller's state, not this controller's. */
  #saving = false

  /** Commit every changed field behind the revision fence; the shared validation gates the write.
   *  The returned outcome drives the unified footer (see unified-save.ts). */
  save = async (): Promise<SaveOutcome> => {
    const { value, draft } = this.#state
    if (value === undefined || draft === undefined) return 'unavailable'
    if (this.#saving) return 'clean'
    if (this.#state.structural.length > 0 || this.#state.degraded.length > 0 || this.#state.cooldownInvalid) return 'blocked'
    const ops = fieldOps(value, draft)
    if (ops.length === 0) return 'clean'
    this.#saving = true
    let accepted: boolean
    try {
      // The form's contract: transport failures reject — a rejected save must
      // report 'failed', never strand the in-flight guard.
      accepted = await this.#form.mutate(ops, this.#form.getSnapshot().revision)
    } catch {
      if (this.#disposed) return 'failed'
      this.#saving = false
      return 'failed'
    }
    this.#saving = false
    if (this.#disposed) return accepted ? 'saved' : 'conflict'
    this.#sync()
    return accepted ? 'saved' : 'conflict'
  }

  setStrategy = (strategy: Strategy): void => { this.#edit(draft => { draft.strategy = strategy }) }
  setPinnedRoute = (route: RouteOption | null): void => {
    this.#edit(draft => {
      draft.provider = route?.provider ?? ''
      draft.model = route?.model ?? ''
      // Clearing the route clears the effort; switching keeps the stored id
      // only when the new model still supports it.
      if (route === null) draft.reasoningEffort = ''
      else if (draft.reasoningEffort !== '' && !(route.efforts?.some(effort => effort.id === draft.reasoningEffort) ?? false)) draft.reasoningEffort = ''
    })
  }
  setPinnedEffort = (reasoningEffort: string): void => { this.#edit(draft => { draft.reasoningEffort = reasoningEffort }) }
  addRoute = (route: RouteOption): void => {
    this.#edit(draft => {
      if (draft.priority.length >= MAX_ROUTES) return
      if (draft.priority.some(entry => entry.provider === route.provider && entry.model === route.model)) return
      draft.priority.push({ provider: route.provider, model: route.model, reasoningEffort: '' })
    })
  }
  removeRoute = (index: number): void => { this.#edit(draft => { draft.priority.splice(index, 1) }) }
  /** Set one candidate row's reasoning effort ('' = follow the model default). */
  setRouteEffort = (index: number, reasoningEffort: string): void => {
    this.#edit(draft => {
      const entry = draft.priority[index]
      if (entry !== undefined) entry.reasoningEffort = reasoningEffort
    })
  }
  /** Copy-on-write (ADR 0014 d2): the first edit under defaults-on materialises
   *  the derived table into the draft and flips to custom; later edits then
   *  target ordinary stored rows. Read-only under pinned (the UI locks it). */
  #materializeDefaultsInto = (draft: PinConfig): void => {
    if (!draft.nameMapDefaults) return
    if (draft.strategy === 'pinned') return
    // ADR 0015 R2: the derive input is the stored priority verbatim — the
    // client must not unilaterally drop candidates the runtime still sees.
    const candidates = listedRoutesOf(this.#state)
      .map(route => ({ provider: route.provider, model: route.model, efforts: route.efforts, description: route.description }))
    const overrides = draft.capabilityOverrides ?? []
    draft.nameMap = deriveStarterRows(candidates, { overrides }).map(row => ({ ...row }))
    draft.nameMapDefaults = false
  }

  /** Import-time feedback for one override row: where the model resolves. */
  #overrideMatch(model: string, provider?: string): 'candidate' | 'kb' | 'none' {
    const match = matchOverrideRoute(
      { provider, model },
      this.#state.routes,
      this.#state.draft?.priority ?? [],
    )
    return match === 'route-miss' ? 'none' : match
  }

  /**
   * Import user-researched capability evaluations (ADR 0016 d3). Semantic
   * validation happens HERE (the schema bounds shape): duplicate models and
   * all-dimension-empty rows reject with per-row reasons; accepted rows land
   * in the draft and ride the unified save. Each accepted row reports where
   * its model currently resolves so the UI can surface stale entries.
   * @param rows - evaluated rows as the research package produced them.
   * @returns 'imported' with per-row feedback, or 'rejected' with reasons.
   */
  importCapabilityOverrides = (rows: readonly CapabilityOverrideView[]): { kind: 'imported'; rows: { model: string; match: 'candidate' | 'kb' | 'none' }[]; mergedDuplicates: { model: string; provider: string }[] } | { kind: 'rejected'; reasons: string[] } => {
    const reasons: string[] = []
    rows.forEach((row, index) => {
      if (row.model === '') reasons.push(`#${index + 1}: missing model id`)
      if (row.overall === undefined && row.coding === undefined && row.webdev === undefined && row.agentic === undefined) {
        reasons.push(`#${index + 1}: "${row.model}" carries no dimension score`)
      }
      for (const [dimension, score] of Object.entries({ overall: row.overall, coding: row.coding, webdev: row.webdev, agentic: row.agentic })) {
        if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 100)) {
          reasons.push(`#${index + 1}: "${row.model}" ${dimension}=${String(score)} outside 0-100`)
        }
      }
    })
    if (rows.length > MAX_CAPABILITY_OVERRIDES) reasons.push(`at most ${MAX_CAPABILITY_OVERRIDES} rows are allowed`)
    if (reasons.length > 0) return { kind: 'rejected', reasons }
    // Evaluator duplicates MERGE last-wins (Zd, revising the B-3 reject ruling
    // with real-world evidence: research models re-emit listed models despite
    // the one-row contract — a duplicate is not grounds to bounce the batch).
    // The pair key is (normalised provider, canonicalised model) so generic
    // and route-qualified rows of one model coexist.
    const merged = new Map<string, CapabilityOverrideView>()
    const mergedDuplicates: { model: string; provider: string }[] = []
    const existingQualified = new Map<string, CapabilityOverrideView>()
    for (const row of this.#state.draft?.capabilityOverrides ?? []) {
      if ((row.provider ?? '').trim() !== '') existingQualified.set(`${(row.provider ?? '').trim()}\0${canonicalizeModelId(row.model)}`, row)
    }
    for (const row of rows) {
      const provider = (row.provider ?? '').trim()
      const key = `${provider}\0${canonicalizeModelId(row.model)}`
      if (merged.has(key) || (provider !== '' && existingQualified.has(key))) mergedDuplicates.push({ model: row.model, provider })
      merged.set(key, { ...row, provider })
    }
    const uniqueRows = [...merged.values()]
    this.#edit(draft => {
      // Re-import replaces the GENERIC rows (the research package is one
      // coherent evaluation) but PRESERVES qualified rows — route-specific
      // scores are hand-maintained knowledge the model-level package never
      // carries. A NEW qualified row landing on an existing pair replaces it
      // (draft-aware last-wins) so the pair never duplicates into a
      // save-blocking "repeats" state.
      const qualified = (draft.capabilityOverrides ?? []).filter(row => {
        const route = (row.provider ?? '').trim()
        if (route === '') return false
        return !merged.has(`${route}\0${canonicalizeModelId(row.model)}`)
      })
      draft.capabilityOverrides = [...qualified, ...uniqueRows]
    })
    return { kind: 'imported', rows: uniqueRows.map(row => ({ model: row.model, match: this.#overrideMatch(row.model, row.provider) })), mergedDuplicates }
  }

  /** Remove one override row from the draft (unified save persists). */
  removeCapabilityOverride = (index: number): void => {
    this.#edit(draft => { (draft.capabilityOverrides ?? []).splice(index, 1) })
  }

  /** Drop every override — scoring falls back to the bundled KB snapshot. */
  clearCapabilityOverrides = (): void => {
    this.#edit(draft => { draft.capabilityOverrides = [] })
  }

  /** Re-enable derivation: clears the stored rows and returns to defaults mode. */
  resetNameMapDefaults = (): void => {
    this.#edit(draft => {
      draft.nameMap = []
      draft.nameMapDefaults = true
    })
  }

  addNameRow = (route: RouteOption): void => {
    this.#edit(draft => {
      this.#materializeDefaultsInto(draft)
      if (draft.nameMap.length >= MAX_NAME_MAP_ENTRIES) return
      draft.nameMap.push({ name: '', provider: route.provider, model: route.model, reasoningEffort: '' })
    })
  }

  removeNameRow = (index: number): void => {
    this.#edit(draft => {
      this.#materializeDefaultsInto(draft)
      draft.nameMap.splice(index, 1)
    })
  }

  setNameRowName = (index: number, name: string): void => {
    this.#edit(draft => {
      this.#materializeDefaultsInto(draft)
      const row = draft.nameMap[index]
      if (row !== undefined) row.name = name.trim()
    })
  }

  setNameRowRoute = (index: number, route: RouteOption): void => {
    this.#edit(draft => {
      this.#materializeDefaultsInto(draft)
      const row = draft.nameMap[index]
      if (row === undefined) return
      row.provider = route.provider
      row.model = route.model
      row.reasoningEffort = ''
    })
  }

  setNameRowEffort = (index: number, reasoningEffort: string): void => {
    this.#edit(draft => {
      this.#materializeDefaultsInto(draft)
      const row = draft.nameMap[index]
      if (row !== undefined) row.reasoningEffort = reasoningEffort
    })
  }

  moveRoute = (index: number, delta: -1 | 1): void => {
    this.#edit(draft => {
      const target = index + delta
      if (target < 0 || target >= draft.priority.length) return
      const [entry] = draft.priority.splice(index, 1)
      if (entry !== undefined) draft.priority.splice(target, 0, entry)
    })
  }
  setFallbackRoute = (route: RouteOption | null): void => {
    this.#edit(draft => {
      draft.fallbackProvider = route?.provider ?? ''
      draft.fallbackModel = route?.model ?? ''
      if (route === null) draft.fallbackReasoningEffort = ''
      else if (draft.fallbackReasoningEffort !== '' && !(route.efforts?.some(effort => effort.id === draft.fallbackReasoningEffort) ?? false)) draft.fallbackReasoningEffort = ''
    })
  }
  setFallbackEffort = (reasoningEffort: string): void => { this.#edit(draft => { draft.fallbackReasoningEffort = reasoningEffort }) }
  setRespectExplicit = (value: boolean): void => { this.#edit(draft => { draft.respectExplicit = value }) }
  setShowNotice = (value: boolean): void => { this.#edit(draft => { draft.showNotice = value }) }
  setPinForkChildren = (value: boolean): void => { this.#edit(draft => { draft.pinForkChildren = value }) }
  setFailOpen = (value: boolean): void => { this.#edit(draft => { draft.failOpen = value }) }
  /** Parse and store the cooldown; an invalid parse sets `cooldownInvalid` and keeps the old number. */
  setCooldownMs = (text: string): void => {
    const trimmed = text.trim()
    if (!/^\d+$/.test(trimmed)) {
      this.#patch({ cooldownInvalid: true })
      return
    }
    const parsed = Number(trimmed)
    if (parsed > MAX_COOLDOWN_MS) {
      this.#patch({ cooldownInvalid: true })
      return
    }
    this.#patch({ cooldownInvalid: false })
    this.#edit(draft => { draft.cooldownMs = parsed })
  }

  #edit = (edit: (draft: PinConfig) => void): void => {
    const draft = this.#state.draft
    if (draft === undefined) return
    edit(draft)
    // Rebuild the state object: useSyncExternalStore skips notifications when
    // the snapshot identity is unchanged, so in-place mutation hides edits.
    this.#patch({})
  }

  #sync = (): void => {
    const snapshot = this.#form.getSnapshot()
    const value = snapshot.status === 'ready' && isPinConfig(snapshot.value) ? copyConfig(snapshot.value) : undefined
    const patch: Partial<SettingsUiState> = {
      status: snapshot.status === 'ready' ? 'ready' : snapshot.status === 'loading' ? 'loading' : 'unavailable',
      value,
      valueInvalid: snapshot.status === 'ready' && value === undefined,
    }
    if (value !== undefined) {
      // ADR 0015 R3: normalize the migration default on BOTH sides at this one
      // boundary — a pre-0014 document (field absent) opens clean and derived,
      // never phantom-dirty.
      value.nameMapDefaults = resolveNameMapDefaults(value.nameMapDefaults as boolean | undefined, value.nameMap?.length ?? 0)
      patch.draft = copyConfig(value)
      // The reloaded draft is the committed value, so the cooldown parse
      // flag from before a namespace flap must not keep the save blocked.
      patch.cooldownInvalid = false
    }
    this.#patch(patch)
  }

  #revalidate = (draft: PinConfig): void => {
    const report = validateStrategyConfig(draft)
    this.#state.structural = report.structural
    this.#state.degraded = report.degraded
    this.#state.advisory = report.advisory
  }

  #patch = (patch: Partial<SettingsUiState>): void => {
    this.#state = { ...this.#state, ...patch }
    const draft = this.#state.draft
    if (draft !== undefined) {
      this.#revalidate(draft)
      this.#state.addableRoutes = addableRoutesOf(draft, this.#state.routes)
      this.#state.atLimit = draft.priority.length >= MAX_ROUTES
      // The effective mapping view: derived under defaults-on + spread (the
      // R1 mirror of the runtime gate), stored rows otherwise.
      this.#state.effectiveNameMap = draft.nameMapDefaults && draft.strategy !== 'pinned'
        ? deriveStarterRows(listedRoutesOf(this.#state)
          .map(route => ({ provider: route.provider, model: route.model, efforts: route.efforts, description: route.description })), { overrides: draft.capabilityOverrides ?? [] })
        : draft.nameMap.map(row => ({ ...row }))
    } else {
      this.#state.addableRoutes = [...this.#state.routes]
      this.#state.atLimit = false
      this.#state.effectiveNameMap = []
    }
    this.#notify()
  }

  #notify = (): void => {
    for (const listener of this.#listeners) listener()
  }
}

/** Join helper re-export for the section component. */
export function listedRoutesOf(state: SettingsUiState): ReturnType<typeof joinRoutes> {
  return joinRoutes(state.draft, state.routes)
}
