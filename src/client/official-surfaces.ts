/**
 * The controller for the one official config namespace this plugin's settings
 * page absorbs while the takeover is active (v0.3.0 T2): the runtime limits
 * (`subagent`: maxDepth / maxActiveSubagents — still enforced by the official
 * subagent runtime, this page only owns the edit surface through the same
 * keys). The namespace is one revision-fenced draft editor over the host's
 * shared config form — same contract as the plugin's own form, so a value
 * written here is exactly what the official page would have written;
 * disabling this plugin restores the official page with the values intact.
 *
 * The official model-selection allowlist is neither edited nor read here
 * (ADR 0005): the candidate list is the plugin's complete and sole routing
 * source.
 *
 * The controller never disappears with the namespace (T7): a namespace the
 * host stops serving flips only its own section to `unavailable` while the
 * merged card keeps rendering, so an ns hiccup cannot flash the hidden
 * official page back into existence.
 *
 * @module dsh-subagent-plus/client/official-surfaces
 */
import type { SaveOutcome } from './unified-save.js'
import type { FieldSetOp, SettingsFormPort } from './settings-controller.js'

/** Official `subagent` namespace value as this page edits it. */
export interface OfficialLimitsValue {
  /** Maximum delegation depth; integer ≥ 0, official default 1. */
  maxDepth: number
  /** Maximum live parallel children; integer ≥ 1, official default 8. */
  maxActiveSubagents: number
}

/** Structural guard narrowing an untyped form snapshot onto the official shape. */
export function isLimitsValue(value: unknown): value is OfficialLimitsValue {
  return typeof value === 'object' && value !== null
    && typeof (value as OfficialLimitsValue).maxDepth === 'number'
    && typeof (value as OfficialLimitsValue).maxActiveSubagents === 'number'
}

/** Deep-copy the limits value (flat fields). */
function copyLimits(source: OfficialLimitsValue): OfficialLimitsValue {
  return { ...source }
}

/** Per-namespace render state: one status machine per official namespace.
 *  Save failure/conflict feedback is the unified footer's domain; this state
 *  keeps only the `saved` chip the section header renders. */
export interface NamespaceFormState<Value> {
  /** `unavailable` flips only this section (T7); the card keeps rendering. */
  status: 'loading' | 'ready' | 'unavailable'
  /** One-shot success feedback flag, cleared by the next action. */
  saved: boolean
  /** The committed value, when ready and recognizable. */
  value: Value | undefined
  /** Ready but unrecognizable (hand-edited patch) — editor hidden, line shown. */
  valueInvalid: boolean
  /** The local edit; diverges from `value` until save or reset. */
  draft: Value | undefined
  /** Section-input parse failure (mirrors the plugin form's cooldown flag):
   *  blocks saving and renders the section's invalid hint. */
  invalid: boolean
}

/** Structural options one namespace controller needs. */
interface NamespaceFormOptions<Value> {
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
  /** Re-entry guard for save(); the footer's `saving` is the unified
   *  controller's state, not this controller's. */
  #saving = false

  /**
   * @param form - the shared config form for the official namespace.
   * @param options - guard/copy/blocked for the value shape.
   */
  constructor(form: SettingsFormPort, options: NamespaceFormOptions<Value>) {
    this.#form = form
    this.#options = options
    this.#state = { status: 'loading', saved: false, value: undefined, valueInvalid: false, draft: undefined, invalid: false }
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

  /** Commit every changed field behind the revision fence; `blocked` and the
   *  section's invalid flag gate the write. The returned outcome drives the
   *  unified footer: unavailable/blocked namespaces never reach the wire. */
  save = async (): Promise<SaveOutcome> => {
    const { value, draft } = this.#state
    if (value === undefined || draft === undefined) return 'unavailable'
    if (this.#saving) return 'clean'
    if (this.#options.blocked(draft) || this.#state.invalid) return 'blocked'
    const ops = namespaceFieldOps(value, draft)
    if (ops.length === 0) return 'clean'
    this.#saving = true
    this.#patch({ saved: false })
    let accepted: boolean
    try {
      accepted = await this.#form.mutate(ops, this.#form.getSnapshot().revision)
    } catch {
      if (this.#disposed) return 'failed'
      this.#saving = false
      return 'failed'
    }
    this.#saving = false
    if (this.#disposed) return accepted ? 'saved' : 'conflict'
    this.#sync()
    if (accepted) this.#patch({ saved: true })
    return accepted ? 'saved' : 'conflict'
  }

  /** Apply one draft mutation; rebuilds the state object for useSyncExternalStore. */
  protected edit(mutate: (draft: Value) => void): void {
    const draft = this.#state.draft
    if (draft === undefined) return
    mutate(draft)
    this.#patch({ saved: false })
  }

  /** Publish the section's input-validity flag through the shared notify pipeline. */
  protected setInvalid(invalid: boolean): void {
    this.#patch({ invalid })
  }

  /** Clear per-field validity flags when a namespace reload hands back a clean
   *  committed value; the base resets the shared `invalid` flag alongside. */
  protected resetValidity(): void {}

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
      // The reloaded draft is the committed value, so no invalid input
      // survives the flap: input-validity flags from before it would keep
      // the section blocked (red inputs, save gated) with nothing to fix.
      patch.invalid = false
      this.resetValidity()
    } else {
      // Not served (or unrecognizable): no editable draft may survive, or a
      // flapping namespace would keep offering stale edits (T7).
      patch.draft = undefined
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

/**
 * Parse one official limit from input text: a plain non-negative decimal
 * integer within the schema's domain (`maxDepth` ≥ 0, `maxActiveSubagents`
 * ≥ 1, both capped at `Number.MAX_SAFE_INTEGER`).
 * @param text - the raw input text.
 * @param min - the inclusive lower bound of the official schema.
 * @returns the parsed integer, or undefined for out-of-domain text.
 */
export function parseLimitText(text: string, min: number): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  if (parsed < min || parsed > Number.MAX_SAFE_INTEGER) return undefined
  return parsed
}

/**
 * The official runtime limits as an editable section: two parsed numeric
 * inputs writing the official `subagent` namespace keys verbatim. An invalid
 * parse keeps the previous number in the draft and flags the section invalid
 * (blocking save) until a valid parse arrives.
 */
export class OfficialLimitsController extends NamespaceFormController<OfficialLimitsValue> {
  #depthInvalid = false
  #activeInvalid = false

  constructor(form: SettingsFormPort) {
    super(form, { guard: isLimitsValue, copy: copyLimits, blocked: () => false })
  }

  /** Parse and set `maxDepth` (≥ 0); an invalid parse only flags the section. */
  setMaxDepth = (text: string): void => {
    const parsed = parseLimitText(text, 0)
    this.#depthInvalid = parsed === undefined
    this.#publishValidity()
    if (parsed !== undefined) this.edit(draft => { draft.maxDepth = parsed })
  }

  /** Parse and set `maxActiveSubagents` (≥ 1); an invalid parse only flags the section. */
  setMaxActiveSubagents = (text: string): void => {
    const parsed = parseLimitText(text, 1)
    this.#activeInvalid = parsed === undefined
    this.#publishValidity()
    if (parsed !== undefined) this.edit(draft => { draft.maxActiveSubagents = parsed })
  }

  #publishValidity = (): void => {
    this.setInvalid(this.#depthInvalid || this.#activeInvalid)
  }

  protected override resetValidity(): void {
    this.#depthInvalid = false
    this.#activeInvalid = false
  }
}


