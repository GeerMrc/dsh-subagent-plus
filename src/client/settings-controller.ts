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
  return {
    schema: 1,
    exportedAt: today,
    dimensions: ['overall', 'coding', 'webdev', 'agentic'],
    candidates: candidates.map(entry => ({ provider: entry.provider, model: entry.model, match: entry.match })),
    prompt_zh: [
      '你是模型能力评估员。请对下列模型在四个维度上给出 0-100 的能力评分。',
      '评分表达该模型相对当前主流模型总体的位置：50≈主流中位、70≈前四分之一、90≈前 10%。',
      '维度：overall（综合）/ coding（编码）/ webdev（前端网页开发）/ agentic（自主任务·工具使用）。',
      '清单为当前环境的完整模型目录（并非都在使用）；请依据公开基准与社区实测知识评分，标注了"当前候选"的模型正在使用中。',
      '输出一个 JSON 数组，每项 {"model": "<原样模型 id>", "overall": n, "coding": n, "webdev": n, "agentic": n, "asOf": "调研执行日期(YYYY-MM-DD)", "note": "简短依据"}。',
      '只输出 JSON，不要解释。模型列表：',
      ...candidates.map(entry => `- ${entry.model}${entry.match === 'candidate' ? '（当前候选）' : entry.match === 'none' ? '（未知模型，请按同类定位估计）' : ''}`),
    ].join('\n'),
    prompt_en: [
      'You are a model-capability evaluator. Score the models below 0-100 on four dimensions.',
      'Scores express each model\'s position against the current mainstream population: 50≈median, 70≈top quartile, 90≈top decile.',
      'Dimensions: overall / coding / webdev (frontend web development) / agentic (autonomous tool use).',
      'The list is the FULL model catalogue of this environment (not all are in use); ground your scores in public benchmarks and community testing. Models marked "current candidate" are actively listed.',
      'Output a JSON array, one object per model: {"model": "<exact id>", "overall": n, "coding": n, "webdev": n, "agentic": n, "asOf": "YYYY-MM-DD research date", "note": "brief basis"}.',
      'JSON only, no prose. Models:',
      ...candidates.map(entry => `- ${entry.model}${entry.match === 'candidate' ? ' (current candidate)' : entry.match === 'none' ? ' (unknown model — estimate by comparable positioning)' : ''}`),
    ].join('\n'),
  }
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
  #overrideMatch(model: string): 'candidate' | 'kb' | 'none' {
    const key = canonicalizeModelId(model)
    if (this.#state.draft?.priority.some(entry => canonicalizeModelId(entry.model) === key) === true) return 'candidate'
    if (kbEntryFor(model) !== undefined) return 'kb'
    return 'none'
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
  importCapabilityOverrides = (rows: readonly CapabilityOverrideView[]): { kind: 'imported'; rows: { model: string; match: 'candidate' | 'kb' | 'none' }[] } | { kind: 'rejected'; reasons: string[] } => {
    const reasons: string[] = []
    const seen = new Set<string>()
    rows.forEach((row, index) => {
      if (row.model === '') reasons.push(`#${index + 1}: missing model id`)
      const key = canonicalizeModelId(row.model)
      if (seen.has(key)) reasons.push(`#${index + 1}: duplicate model "${row.model}"`)
      seen.add(key)
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
    this.#edit(draft => {
      // Import replaces the previous import wholesale (the research package is
      // one coherent evaluation); existing rows from an older import go.
      draft.capabilityOverrides = rows.map(row => ({ ...row }))
    })
    return { kind: 'imported', rows: rows.map(row => ({ model: row.model, match: this.#overrideMatch(row.model) })) }
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
