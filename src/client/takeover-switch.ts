/**
 * The header switch as the full takeover switch (v0.3.1 D1): turning it off
 * disables the whole bundle through the host's plugin manager, which removes
 * the bundle layer — the hidden official subagent settings page returns with
 * its values intact and this section unloads (production hosts reconcile
 * immediately; startup-profile hosts apply after a restart, surfaced as a
 * notice). The switch is a view over the bundle's enabled state, not the
 * plugin's soft routing flag: pausing route assignment alone stays an
 * advanced option inside the page, so a v0.0.2 `enabled: false` keeps its
 * exact meaning after the upgrade.
 *
 * The plugin-manager face is optional: compositions that do not ship it get a
 * degraded switch (a hint pointing at the Plugins page) instead of a dead
 * settings entry — the face is probed, never injected.
 *
 * @module dsh-subagent-plus/client/takeover-switch
 */

/** The host plugin-manager remote face this switch uses, narrowed to the two
 *  calls it makes; the envelope matches the Typert result wrapping. */
export interface PluginManagerFace {
  listBundles(): Promise<{ name: string; enabled: boolean }[]>
  setBundleEnabled(packageName: string, enabled: boolean): Promise<{ ok: boolean; value?: { application?: string } }>
}

/** Render state for the header switch. */
export interface TakeoverSwitchState {
  /** Whether the bundle-level face is reachable in this composition. */
  available: boolean
  /** The bundle's selected state; `unknown` until the first read resolves. */
  status: 'on' | 'off' | 'unknown'
  /** A disable request is in flight. */
  working: boolean
  /** The disable was accepted but the host applies it only after a restart. */
  restartRequired: boolean
  /** The disable request failed; the switch stays on. */
  disableFailed: boolean
  /** The confirm bar is open (the switch was clicked while on). */
  confirming: boolean
}

/**
 * Bundle-level takeover switch: reads `listBundles`, disables through
 * `setBundleEnabled`, and never flips optimistically — the state changes only
 * on the host's answer.
 */
export class TakeoverSwitchController {
  readonly #bundle: string
  readonly #face: PluginManagerFace | undefined
  readonly #listeners = new Set<() => void>()
  #state: TakeoverSwitchState
  #disposed = false
  /** Monotonic operation counter: only the newest started refresh or disable
   *  write may patch the state; a stale resolving response is dropped. */
  #generation = 0

  /**
   * @param bundle - this plugin's package name (the bundle row id).
   * @param face - the probed plugin-manager face; undefined in compositions without it.
   */
  constructor(bundle: string, face: PluginManagerFace | undefined) {
    this.#bundle = bundle
    this.#face = face
    this.#state = { available: face !== undefined, status: 'on', working: false, restartRequired: false, disableFailed: false, confirming: false }
  }

  /** Subscribe to snapshot replacements (useSyncExternalStore contract). */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** The current render-ready snapshot (stable reference until the next change). */
  snapshot = (): TakeoverSwitchState => this.#state

  /** Drop listeners; the section effect's disposer calls this. */
  dispose = (): void => {
    this.#disposed = true
    this.#listeners.clear()
  }

  /** Re-read the bundle's enabled state (boot, plugin-manager change, reconnect). */
  refresh = async (): Promise<void> => {
    if (this.#face === undefined || this.#disposed) return
    const generation = ++this.#generation
    let enabled: boolean | undefined
    try {
      const bundles = await this.#face.listBundles()
      enabled = bundles.find(bundle => bundle.name === this.#bundle)?.enabled
    } catch {
      enabled = undefined
    }
    if (this.#disposed || generation !== this.#generation) return
    // A manifest that shows the bundle enabled again superseded a queued
    // disable (the user re-enabled it), so the restart notice retires.
    const patch: Partial<TakeoverSwitchState> = { status: enabled === undefined ? 'unknown' : enabled ? 'on' : 'off' }
    if (enabled === true) patch.restartRequired = false
    this.#patch(patch)
  }

  /** Open the confirm bar (the switch was clicked while on). */
  requestDisable = (): void => {
    if (this.#state.status !== 'on' || this.#state.working) return
    this.#patch({ confirming: true, disableFailed: false })
  }

  /** Close the confirm bar without disabling. */
  cancel = (): void => {
    this.#patch({ confirming: false })
  }

  /** Confirm the bar: disable the bundle. On `applied` the section unloads
   *  right after; on `restart-required` it stays alive with a notice. */
  confirmDisable = async (): Promise<void> => {
    if (this.#face === undefined || this.#state.working || this.#state.status !== 'on') return
    ++this.#generation
    this.#patch({ working: true, disableFailed: false })
    let response: { ok: boolean; value?: { application?: string } }
    try {
      response = await this.#face.setBundleEnabled(this.#bundle, false)
    } catch {
      if (this.#disposed) return
      this.#patch({ working: false, confirming: false, disableFailed: true })
      return
    }
    if (this.#disposed) return
    const application = response.ok ? response.value?.application : undefined
    if (application === 'applied') {
      this.#patch({ working: false, confirming: false, status: 'off' })
      return
    }
    if (application === 'restart-required') {
      this.#patch({ working: false, confirming: false, status: 'off', restartRequired: true })
      return
    }
    // Refused, cancelled, overridden, or failed: nothing changed host-side.
    this.#patch({ working: false, confirming: false, disableFailed: true })
  }

  #patch = (patch: Partial<TakeoverSwitchState>): void => {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }
}

/**
 * Probe the optional plugin-manager face on a client remote service object.
 * The property is absent (or throws) in compositions that do not inject it —
 * both resolve to undefined, never to a broken settings entry.
 * @param remote - the client `ctx.remote` service object.
 * @returns the narrowed face, or undefined when the composition lacks it.
 */
export function probePluginManagerFace(remote: object): PluginManagerFace | undefined {
  let candidate: unknown
  try {
    candidate = (remote as { pluginManager?: unknown }).pluginManager
  } catch {
    return undefined
  }
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const face = candidate as Partial<PluginManagerFace>
  if (typeof face.listBundles !== 'function' || typeof face.setBundleEnabled !== 'function') return undefined
  return face as PluginManagerFace
}
