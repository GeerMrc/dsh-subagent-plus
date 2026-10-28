/**
 * Pure controllers for the two official subagent config namespaces this
 * plugin's settings page absorbs while the takeover is active (v0.3.0 T2/T3):
 * the runtime limits (`subagent`: maxDepth / maxActiveSubagents — still
 * enforced by the official subagent runtime, this page only owns the edit
 * surface through the same keys) and the model-selection allowlist
 * (`subagent-model-selection-settings`: enabled / allowedModels). Each
 * namespace is one revision-fenced draft editor over the host's shared config
 * form — same contract as the plugin's own form, so a value written here is
 * exactly what the official page would have written; disabling this plugin
 * restores the official page with the values intact.
 *
 * The controllers never disappear with a namespace (T7): a namespace the host
 * stops serving flips its own section to `unavailable` while the takeover card
 * itself keeps rendering, so an ns hiccup cannot flash the hidden official
 * page back into existence.
 *
 * @module dsh-subagent-plus/client/official-surfaces
 */
import type { FieldSetOp, SettingsFormPort } from './settings-controller.js'

export type { FieldSetOp, SettingsFormPort as NamespaceFormPort }

/** Official `subagent` namespace value as this page edits it. */
export interface OfficialLimitsValue {
  /** Maximum delegation depth; integer ≥ 0, official default 1. */
  maxDepth: number
  /** Maximum live parallel children; integer ≥ 1, official default 8. */
  maxActiveSubagents: number
}

/** One allowed child route of the official model-selection allowlist. */
export interface AllowedModelRouteView {
  /** Provider id. */
  provider: string
  /** Model id. */
  model: string
}

/** Official `subagent-model-selection-settings` namespace value as this page edits it. */
export interface OfficialAllowlistValue {
  /** Whether newly composed top-level sessions receive model selection. */
  enabled: boolean
  /** Exact child LLM routes offered to the delegating model. */
  allowedModels: AllowedModelRouteView[]
}

/** Structural guards narrowing an untyped form snapshot onto the official shapes. */
export function isLimitsValue(value: unknown): value is OfficialLimitsValue {
  return typeof value === 'object' && value !== null
    && typeof (value as OfficialLimitsValue).maxDepth === 'number'
    && typeof (value as OfficialLimitsValue).maxActiveSubagents === 'number'
}

/** See {@link isLimitsValue}. */
export function isAllowlistValue(value: unknown): value is OfficialAllowlistValue {
  return typeof value === 'object' && value !== null
    && typeof (value as OfficialAllowlistValue).enabled === 'boolean'
    && Array.isArray((value as OfficialAllowlistValue).allowedModels)
}

/** Deep-copy the limits value (flat fields). */
export function copyLimits(source: OfficialLimitsValue): OfficialLimitsValue {
  return { ...source }
}

/** Deep-copy the allowlist value (the route array is rebuilt entry by entry). */
export function copyAllowlist(source: OfficialAllowlistValue): OfficialAllowlistValue {
  return { enabled: source.enabled, allowedModels: source.allowedModels.map(route => ({ ...route })) }
}

/** Per-namespace render state: one status machine per official namespace. */
export interface NamespaceFormState<Value> {
  /** `unavailable` flips only this section (T7); the card keeps rendering. */
  status: 'loading' | 'ready' | 'unavailable'
  /** The last save hit the revision fence; the form reloaded the newer value. */
  conflict: boolean
  saving: boolean
  /** One-shot success feedback flag, cleared by the next action. */
  saved: boolean
  /** One-shot failure feedback flag, cleared by the next action. */
  saveFailed: boolean
  /** The committed value, when ready and recognizable. */
  value: Value | undefined
  /** Ready but unrecognizable (hand-edited patch) — editor hidden, line shown. */
  valueInvalid: boolean
  /** The local edit; diverges from `value` until save or reset. */
  draft: Value | undefined
}

/** Structural options one namespace controller needs. */
export interface NamespaceFormOptions<Value> {
  /** Narrow an untyped snapshot onto the namespace value shape. */
  guard(value: unknown): value is Value
  /** Deep-copy a committed value into an independent draft. */
  copy(value: Value): Value
  /** Whether the current draft may not be saved (parse/validation failure). */
  blocked(draft: Value): boolean
}

/**
 * One official namespace as a draft editor over the shared config form —
 * the plugin-form contract (revision-fenced atomic field writes) applied to a
 * namespace another plugin owns, which the settings shell explicitly supports.
 */
export class NamespaceFormController<Value extends object> {
  readonly #form: SettingsFormPort
  readonly #options: NamespaceFormOptions<Value>
  readonly #listeners = new Set<() => void>()
  #state: NamespaceFormState<Value>
  #unsubscribe: (() => void) | undefined
  #disposed = false

  /**
   * @param form - the shared config form for the official namespace.
   * @param options - guard/copy/blocked for the value shape.
   */
  constructor(form: SettingsFormPort, options: NamespaceFormOptions<Value>) {
    this.#form = form
    this.#options = options
    this.#state = { status: 'loading', conflict: false, saving: false, saved: false, saveFailed: false, value: undefined, valueInvalid: false, draft: undefined }
  }

  /** Subscribe to snapshot replacements (useSyncExternalStore contract). */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** The current render-ready snapshot (stable reference until the next change). */
  snapshot = (): NamespaceFormState<Value> => this.#state

  /** Bind to the form; idempotent across whileServed re-registrations. */
  init = (): void => {
    if (this.#unsubscribe !== undefined) return
    this.#unsubscribe = this.#form.subscribe(() => { this.#sync() })
    this.#sync()
  }

  /** Drop the form subscription; the section effect's disposer calls this. */
  dispose = (): void => {
    this.#disposed = true
    this.#unsubscribe?.()
    this.#listeners.clear()
  }

  /** Discard the draft and mirror the committed value again. */
  reset = (): void => {
    this.#patch({ draft: this.#state.value === undefined ? undefined : this.#options.copy(this.#state.value) })
  }

  /** Commit every changed field behind the revision fence; `blocked` gates the write. */
  save = async (): Promise<void> => {
    const { value, draft } = this.#state
    if (value === undefined || draft === undefined || this.#state.saving) return
    if (this.#options.blocked(draft)) return
    const ops = namespaceFieldOps(value, draft)
    if (ops.length === 0) return
    this.#patch({ saving: true, saved: false, saveFailed: false, conflict: false })
    let accepted: boolean
    try {
      accepted = await this.#form.mutate(ops, this.#form.getSnapshot().revision)
    } catch {
      if (this.#disposed) return
      this.#patch({ saving: false, saveFailed: true })
      return
    }
    if (this.#disposed) return
    this.#sync()
    this.#patch(accepted ? { saving: false, saved: true } : { saving: false, conflict: true })
  }

  /** Apply one draft mutation; rebuilds the state object for useSyncExternalStore. */
  protected edit(mutate: (draft: Value) => void): void {
    const draft = this.#state.draft
    if (draft === undefined) return
    mutate(draft)
    this.#patch({ saved: false, saveFailed: false })
  }

  #sync = (): void => {
    const snapshot = this.#form.getSnapshot()
    const value = snapshot.status === 'ready' && this.#options.guard(snapshot.value) ? this.#options.copy(snapshot.value) : undefined
    const patch: Partial<NamespaceFormState<Value>> = {
      status: snapshot.status === 'ready' ? 'ready' : snapshot.status === 'loading' ? 'loading' : 'unavailable',
      value,
      valueInvalid: snapshot.status === 'ready' && value === undefined,
    }
    if (value !== undefined) {
      patch.draft = this.#options.copy(value)
      patch.conflict = false
    }
    this.#patch(patch)
  }

  #patch = (patch: Partial<NamespaceFormState<Value>>): void => {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }
}

/** Field ops carrying every top-level difference between two namespace values. */
function namespaceFieldOps<Value extends object>(committed: Value, draft: Value): { op: 'set'; path: string[]; value: unknown }[] {
  const ops: { op: 'set'; path: string[]; value: unknown }[] = []
  for (const key of Object.keys(draft) as (keyof Value & string)[]) {
    if (JSON.stringify(committed[key]) === JSON.stringify(draft[key])) continue
    ops.push({ op: 'set', path: [key], value: draft[key] })
  }
  return ops
}
