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
type Slot = 'S' | 'B' | 'F'

/** One role-template definition (ADR 0011). */
interface RoleTemplate {
  id: string
  minRoutes: number
  maxRoutes?: number
  rows: ReadonlyArray<{ keyword: string; slot: Slot; effort?: string }>
}


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

  // ─── ADR 0011: Role template quick-setup ───

  readonly #templates: readonly RoleTemplate[] = [
    {
      id: 'quality-first',
      minRoutes: 2,
      rows: [
        { keyword: 'reviewer', slot: 'S', effort: 'high' },
        { keyword: 'auditor', slot: 'S', effort: 'high' },
        { keyword: 'verifier', slot: 'S', effort: 'high' },
        { keyword: 'planner', slot: 'S', effort: 'high' },
        { keyword: 'builder', slot: 'B' },
        { keyword: 'dev', slot: 'B' },
        { keyword: 'executor', slot: 'B' },
        { keyword: 'research', slot: 'B' },
        { keyword: 'tester', slot: 'B' },
      ],
    },
    {
      id: 'three-tier',
      minRoutes: 3,
      rows: [
        { keyword: 'reviewer', slot: 'S', effort: 'high' },
        { keyword: 'auditor', slot: 'S', effort: 'high' },
        { keyword: 'verifier', slot: 'S', effort: 'high' },
        { keyword: 'planner', slot: 'S', effort: 'high' },
        { keyword: 'builder', slot: 'B' },
        { keyword: 'dev', slot: 'B' },
        { keyword: 'executor', slot: 'B' },
        { keyword: 'research', slot: 'B' },
        { keyword: 'tester', slot: 'F', effort: 'low' },
      ],
    },
    {
      id: 'same-route',
      minRoutes: 1,
      maxRoutes: 1,
      rows: [
        { keyword: 'reviewer', slot: 'S', effort: 'high' },
        { keyword: 'auditor', slot: 'S', effort: 'high' },
        { keyword: 'verifier', slot: 'S', effort: 'high' },
        { keyword: 'planner', slot: 'S', effort: 'high' },
        { keyword: 'builder', slot: 'S' },
        { keyword: 'dev', slot: 'S' },
        { keyword: 'executor', slot: 'S' },
        { keyword: 'research', slot: 'S' },
        { keyword: 'tester', slot: 'S', effort: 'low' },
      ],
    },
    {
      id: 'content-production',
      minRoutes: 2,
      rows: [
        { keyword: 'research', slot: 'S', effort: 'high' },
        { keyword: 'reviewer', slot: 'S', effort: 'high' },
        { keyword: 'dev', slot: 'B' },
        { keyword: 'builder', slot: 'B' },
        { keyword: 'executor', slot: 'B' },
        { keyword: 'render', slot: 'B' },
        { keyword: 'tester', slot: 'F' },
      ],
    },
  ]

  /** Map a slot to a route from the listed candidates (H2: from listed, never hardcoded). */
  #slotRoute(listed: readonly { provider: string; model: string; efforts?: readonly { id: string }[] }[], slot: Slot): { provider: string; model: string; efforts?: readonly { id: string }[] } | undefined {
    if (listed.length === 0) return undefined
    if (slot === 'S') return listed[0]
    if (slot === 'F') return listed[listed.length - 1]
    // B: middle; for 2 items, pick the second (different from S)
    const mid = Math.floor((listed.length - 1) / 2)
    return listed[Math.max(1, mid)]
  }

  /** Resolve effort for a route, degraded to '' when the route has no matching effort (H5). */
  #resolveEffort(route: { efforts?: readonly { id: string }[] } | undefined, effort: string | undefined): string {
    if (effort === undefined || effort === '') return ''
    if (route?.efforts === undefined || !route.efforts.some(e => e.id === effort)) return ''
    return effort
  }

  /** Templates visible under the current candidate-list size (for the UI dropdown). */
  visibleTemplates = (): { id: string; rowCount: number }[] => {
    const routeCount = this.snapshot().routes.filter(r => r.provider !== '').length
    // Use listed (joined with priority) count if available, else catalog count
    const draft = this.snapshot().draft
    const listedCount = draft?.priority.length ?? routeCount
    return this.#templates
      .filter(t => listedCount >= t.minRoutes && (t.maxRoutes === undefined || listedCount <= t.maxRoutes))
      .map(t => ({ id: t.id, rowCount: t.rows.length }))
  }

  /**
   * Apply a role template to the draft. Returns 'applied' when done,
   * 'confirm' when the nameMap is non-empty (UI must ask replace/merge/cancel),
   * or 'insufficient-capacity' when there aren't enough rows left (H4).
   */
  applyTemplate = (templateId: string): 'applied' | 'confirm' | 'insufficient-capacity' => {
    const template = this.#templates.find(t => t.id === templateId)
    if (template === undefined) return 'insufficient-capacity'
    const state = this.snapshot()
    const draft = state.draft
    if (draft === undefined) return 'insufficient-capacity'
    // H4: capacity check — the template needs this many NEW rows (merge) or this many total (replace).
    const existingKeywords = new Set(draft.nameMap.map(row => row.name))
    const newRowsNeeded = template.rows.filter(r => !existingKeywords.has(r.keyword)).length
    const capacityAvailable = 16 - draft.nameMap.length
    if (newRowsNeeded > capacityAvailable) return 'insufficient-capacity'
    // Non-empty table: ask the UI to confirm replace/merge.
    if (draft.nameMap.length > 0) return 'confirm'
    // Empty table: apply directly.
    this.#applyRows(template, new Set())
    return 'applied'
  }

  /** Confirm a template application after the user chose replace or merge. */
  applyTemplateConfirm = (templateId: string, mode: 'replace' | 'merge'): void => {
    const template = this.#templates.find(t => t.id === templateId)
    if (template === undefined) return
    if (mode === 'replace') {
      this.#edit(draft => { draft.nameMap = [] })
      this.#applyRows(template, new Set())
    } else {
      // Merge: skip existing keywords, append the rest.
      const state = this.snapshot()
      const existing = new Set((state.draft?.nameMap ?? []).map(row => row.name))
      this.#applyRows(template, existing)
    }
  }

  /** Internal: append template rows to the draft, resolving slots to listed routes. */
  #applyRows(template: RoleTemplate, skipKeywords: Set<string>): void {
    const state = this.snapshot()
    const draft = state.draft
    if (draft === undefined) return
    const listed = state.routes // catalog routes for slot resolution
    this.#edit(d => {
      for (const row of template.rows) {
        if (skipKeywords.has(row.keyword)) continue
        if (d.nameMap.length >= 16) break // H4: hard cap
        const route = this.#slotRoute(listed, row.slot)
        if (route === undefined) continue
        d.nameMap.push({
          name: row.keyword,
          provider: route.provider,
          model: route.model,
          reasoningEffort: this.#resolveEffort(route, row.effort),
        })
      }
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
