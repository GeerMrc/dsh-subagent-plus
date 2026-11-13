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
import { MAX_NAME_MAP_ENTRIES, validateStrategyConfig, type Strategy } from '../strategy.js'
import type { PinConfig } from '../config.js'
import type { SaveOutcome } from './unified-save.js'

/** Template slot: S=first candidate (strong), B=middle, F=last (fast). */
export type Slot = 'S' | 'B' | 'F'

/** One starter-template definition (ADR 0013). */
interface RoleTemplate {
  id: string
  rows: ReadonlyArray<{ keyword: string; slot: Slot; effort: EffortIntent }>
}

/**
 * Result of a template application (ADR 0013 d3): counts ride 'applied' so
 * the UI reports "N rows added, M effort intents not materialisable" instead
 * of a silent degrade; 'confirm' carries the mode-aware numbers the inline
 * confirm renders (merge disabled with its reason); refusals ('rejected' =
 * gate/slots lost, 'insufficient-capacity' = capacity gone, 'unknown-template')
 * never touch the draft.
 */
export type ApplyTemplateResult =
  | { kind: 'applied'; added: number; unmaterialized: number }
  | { kind: 'confirm'; mergeFeasible: boolean; needed: number; free: number }
  | { kind: 'insufficient-capacity'; needed: number; free: number }
  | { kind: 'rejected' }
  | { kind: 'unknown-template' }

/**
 * The universal starter template (ADR 0013 d2): one cross-domain table serving
 * every session — dev sessions hit review/dev/test, game sessions
 * design/write, research sessions research/plan; unmatched names fall through
 * to the strategy chain. Row order is the equal-length cross-family
 * tie-break order (matchByKeyword resolves ties by first occurrence), so the
 * quality-gate family comes first: `test-planner` resolves to `plan` (S+top)
 * and `design-review-dev` to `review` (S+top).
 */
export const STARTER_TEMPLATE_ROWS: ReadonlyArray<{ keyword: string; slot: Slot; effort: EffortIntent }> = [
  { keyword: 'review', slot: 'S', effort: 'top' },
  { keyword: 'audit', slot: 'S', effort: 'top' },
  { keyword: 'verif', slot: 'S', effort: 'top' },
  { keyword: 'plan', slot: 'S', effort: 'top' },
  { keyword: 'research', slot: 'B', effort: 'default' },
  { keyword: 'dev', slot: 'B', effort: 'default' },
  { keyword: 'build', slot: 'B', effort: 'default' },
  { keyword: 'execute', slot: 'B', effort: 'default' },
  { keyword: 'write', slot: 'B', effort: 'default' },
  { keyword: 'design', slot: 'B', effort: 'default' },
  { keyword: 'test', slot: 'F', effort: 'lowest' },
  { keyword: 'qa', slot: 'F', effort: 'lowest' },
]


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
}

/** One model-catalogue group as it crosses the wire (session/modelCatalog). */
export interface CatalogGroup {
  /** Provider id. */
  id: string
  /** Provider display name. */
  name: string
  /** Models under the provider. */
  models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[]
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
}

function isPinConfig(value: unknown): value is PinConfig {
  return typeof value === 'object' && value !== null && typeof (value as PinConfig).strategy === 'string'
}

function copyConfig(value: PinConfig): PinConfig {
  return {
    ...value,
    priority: value.priority.map(entry => ({ ...entry })),
    nameMap: value.nameMap.map(entry => ({ ...entry })),
  }
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
function joinRoutes(draft: PinConfig | undefined, routes: readonly RouteOption[]): { provider: string; providerName: string; model: string; modelName: string; available: boolean; efforts?: readonly EffortOption[]; defaultEffort?: string }[] {
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

/** Semantic effort intent a template row expresses (ADR 0013): resolved against
 *  the route's actual tiers at apply time, never a literal provider id. */
export type EffortIntent = 'top' | 'default' | 'lowest'

/** Recognised effort strength ladder, weakest to strongest (ADR 0013). The host
 *  publishes efforts in adapter-preferred display order, which is not a
 *  strength order — the ladder ranks ids whose vocabulary is known. */
const EFFORT_LADDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/** Effort ids that mean "reasoning disabled" — excluded from automatic picks
 *  (a manual row may still choose them). 'off' has live instances
 *  (deepseek/qwen); 'none' is a preventive exclusion with none observed. */
const DISABLED_EFFORT_IDS = new Set(['off', 'none'])

/**
 * Resolve a semantic effort intent against a route's actual tiers (ADR 0013):
 * ladder-ranked ids win ('off'/'none' never picked automatically); ids off the
 * ladder fall back to adapter position (last = top, first = lowest) only when
 * no tier is on the ladder. `default` stays absent ('' — the host materialises
 * the model's own default); no non-disabled tiers materialise nothing.
 * @param route - the route the template row targets, when known.
 * @param intent - the row's semantic effort intent.
 * @returns the materialised effort id, or '' to follow the model default.
 */
export function resolveSemanticEffort(route: { efforts?: readonly { id: string; name?: string }[] } | undefined, intent: EffortIntent): string {
  if (intent === 'default') return ''
  const active = (route?.efforts ?? []).filter(effort => !DISABLED_EFFORT_IDS.has(effort.id.toLowerCase()))
  if (active.length === 0) return ''
  const ranked = active.map(effort => ({ id: effort.id, rank: EFFORT_LADDER.indexOf(effort.id.toLowerCase()) }))
  const onLadder = ranked.filter(effort => effort.rank >= 0)
  if (onLadder.length > 0) {
    const pick = intent === 'top'
      ? onLadder.reduce((best, entry) => (entry.rank > best.rank ? entry : best))
      : onLadder.reduce((best, entry) => (entry.rank < best.rank ? entry : best))
    return pick.id
  }
  return (intent === 'top' ? active[active.length - 1] : active[0]).id
}

/** Options for the add-select: catalogue routes not already listed. */
export function addableRoutesOf(draft: PinConfig | undefined, routes: readonly RouteOption[]): RouteOption[] {
  if (draft === undefined) return [...routes]
  return routes.filter(route => !draft.priority.some(entry => entry.provider === route.provider && entry.model === route.model))
}

/**
 * Draft-editing controller for the plugin's settings section.
 */
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
      value: undefined, valueInvalid: false, draft: undefined, structural: [], degraded: [], cooldownInvalid: false,
      routes: [], addableRoutes: [], atLimit: false, catalogFailed: false,
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
  addNameRow = (route: RouteOption): void => {
    this.#edit(draft => {
      if (draft.nameMap.length >= MAX_NAME_MAP_ENTRIES) return
      draft.nameMap.push({ name: '', provider: route.provider, model: route.model, reasoningEffort: '' })
    })
  }

  removeNameRow = (index: number): void => {
    this.#edit(draft => { draft.nameMap.splice(index, 1) })
  }

  setNameRowName = (index: number, name: string): void => {
    this.#edit(draft => {
      const row = draft.nameMap[index]
      if (row !== undefined) row.name = name.trim()
    })
  }

  setNameRowRoute = (index: number, route: RouteOption): void => {
    this.#edit(draft => {
      const row = draft.nameMap[index]
      if (row === undefined) return
      row.provider = route.provider
      row.model = route.model
      row.reasoningEffort = ''
    })
  }

  setNameRowEffort = (index: number, reasoningEffort: string): void => {
    this.#edit(draft => {
      const row = draft.nameMap[index]
      if (row !== undefined) row.reasoningEffort = reasoningEffort
    })
  }

  // ─── ADR 0013: universal starter template ───

  readonly #templates: readonly RoleTemplate[] = [
    { id: 'starter', rows: STARTER_TEMPLATE_ROWS },
  ]

  /** Map a slot to a route from the listed candidates (ADR 0011 H2: from listed, never hardcoded). */
  #slotRoute(listed: readonly { provider: string; model: string; efforts?: readonly { id: string }[] }[], slot: Slot): { provider: string; model: string; efforts?: readonly { id: string }[] } | undefined {
    if (listed.length === 0) return undefined
    if (slot === 'S') return listed[0]
    if (slot === 'F') return listed[listed.length - 1]
    // B: middle; for 2 items, pick the second (different from S)
    const mid = Math.floor((listed.length - 1) / 2)
    return listed[Math.max(1, mid)]
  }

  /**
   * The starter-template gate (ADR 0013 d2): 'locked' under the pinned
   * strategy (by-name rows stay read-only), 'no-routes' with no available
   * candidates, and 'no-efforts' when the sole available route has no
   * materialisable tier — every row would land on the model default and the
   * template's differentiation would silently collapse (the D2 lesson).
   */
  starterGate = (): { enabled: boolean; reason: 'locked' | 'no-routes' | 'no-efforts' | undefined } => {
    const state = this.snapshot()
    if (state.draft?.strategy === 'pinned') return { enabled: false, reason: 'locked' }
    const available = listedRoutesOf(state).filter(route => route.available)
    if (available.length === 0) return { enabled: false, reason: 'no-routes' }
    if (available.length === 1
      && resolveSemanticEffort(available[0], 'top') === ''
      && resolveSemanticEffort(available[0], 'lowest') === '') return { enabled: false, reason: 'no-efforts' }
    return { enabled: true, reason: undefined }
  }

  /** The starter template when its gate passes (for the quick-setup entry). */
  visibleTemplates = (): { id: string; rowCount: number }[] => {
    if (!this.starterGate().enabled) return []
    return this.#templates.map(t => ({ id: t.id, rowCount: t.rows.length }))
  }

  /**
   * Start applying a template (ADR 0013 d3). An empty table applies directly;
   * a non-empty one returns 'confirm' carrying mode-aware numbers — replace
   * needs the whole template to fit a cleared table, merge only the
   * not-yet-present keywords (a merge that cannot fit still offers replace).
   */
  applyTemplate = (templateId: string): ApplyTemplateResult => {
    const template = this.#templates.find(t => t.id === templateId)
    if (template === undefined) return { kind: 'unknown-template' }
    const state = this.snapshot()
    const draft = state.draft
    if (draft === undefined) return { kind: 'unknown-template' }
    if (!this.starterGate().enabled) return { kind: 'rejected' }
    const existing = new Set(draft.nameMap.map(row => row.name))
    const needed = template.rows.filter(row => !existing.has(row.keyword)).length
    const free = MAX_NAME_MAP_ENTRIES - draft.nameMap.length
    const replaceFeasible = template.rows.length <= MAX_NAME_MAP_ENTRIES
    const mergeFeasible = needed <= free
    if (!replaceFeasible && !mergeFeasible) return { kind: 'insufficient-capacity', needed, free }
    if (draft.nameMap.length > 0) return { kind: 'confirm', mergeFeasible, needed, free }
    // Empty table: replace and merge coincide — writing every row is the merge.
    if (!mergeFeasible) return { kind: 'insufficient-capacity', needed, free }
    return this.#applyRows(template, new Set())
  }

  /**
   * Confirm a template application after the user chose replace or merge
   * (ADR 0013 d3). Preconditions replay at confirm time — the draft may have
   * changed while the inline confirm was open — and any refusal (gate locked,
   * capacity gone) leaves the draft untouched: replace never clears a table
   * it then fails to repopulate.
   */
  applyTemplateConfirm = (templateId: string, mode: 'replace' | 'merge'): ApplyTemplateResult => {
    const template = this.#templates.find(t => t.id === templateId)
    if (template === undefined) return { kind: 'unknown-template' }
    const state = this.snapshot()
    const draft = state.draft
    if (draft === undefined) return { kind: 'unknown-template' }
    // Gate replay covers slot resolvability: with no available route no
    // template row resolves (S/B/F all need at least one).
    if (!this.starterGate().enabled) return { kind: 'rejected' }
    const existing = new Set(draft.nameMap.map(row => row.name))
    const needed = template.rows.filter(row => !existing.has(row.keyword)).length
    const free = MAX_NAME_MAP_ENTRIES - draft.nameMap.length
    if (mode === 'replace') {
      if (template.rows.length > MAX_NAME_MAP_ENTRIES) return { kind: 'insufficient-capacity', needed, free }
    } else if (needed > free) {
      return { kind: 'insufficient-capacity', needed, free }
    }
    const skip = mode === 'replace' ? new Set<string>() : existing
    if (mode === 'replace') this.#edit(d => { d.nameMap = [] })
    return this.#applyRows(template, skip)
  }

  /** Internal: append template rows to the draft, resolving slots to listed
   *  routes; counts rows whose effort intent could not materialise so the UI
   *  reports the degrade instead of hiding it. */
  #applyRows(template: RoleTemplate, skipKeywords: Set<string>): ApplyTemplateResult {
    const state = this.snapshot()
    if (state.draft === undefined) return { kind: 'unknown-template' }
    const listed = listedRoutesOf(state).filter(route => route.available)
    let added = 0
    let unmaterialized = 0
    this.#edit(d => {
      for (const row of template.rows) {
        if (skipKeywords.has(row.keyword)) continue
        if (d.nameMap.length >= MAX_NAME_MAP_ENTRIES) break
        const route = this.#slotRoute(listed, row.slot)
        if (route === undefined) continue
        const effort = resolveSemanticEffort(route, row.effort)
        if (row.effort !== 'default' && effort === '') unmaterialized += 1
        d.nameMap.push({
          name: row.keyword,
          provider: route.provider,
          model: route.model,
          reasoningEffort: effort,
        })
        added += 1
      }
    })
    return { kind: 'applied', added, unmaterialized }
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
  }

  #patch = (patch: Partial<SettingsUiState>): void => {
    this.#state = { ...this.#state, ...patch }
    const draft = this.#state.draft
    if (draft !== undefined) {
      this.#revalidate(draft)
      this.#state.addableRoutes = addableRoutesOf(draft, this.#state.routes)
      this.#state.atLimit = draft.priority.length >= MAX_ROUTES
    } else {
      this.#state.addableRoutes = [...this.#state.routes]
      this.#state.atLimit = false
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
