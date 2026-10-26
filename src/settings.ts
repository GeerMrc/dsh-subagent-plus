/**
 * Settings live-state for dsh-subagent-plus: the hot-readable plain
 * configuration behind every routing decision. The loader's cordis.yml config
 * is the initial state; when the host's settings service is present, every
 * committed settings change re-runs {@link materializeConfig} on read, so a
 * change reaches the next child request without restarting the plugin — and
 * without resetting the health table, the rotation cursor, or any child's
 * sticky decision.
 *
 * A materialization failure (a committed value the schema layer let through
 * but the structural check rejects) keeps the last good snapshot and reports
 * once per distinct failure — the deliberate divergence from the websearch
 * precedent, whose `current()` lets the error propagate.
 *
 * @module dsh-subagent-plus/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { materializeConfig, type PinConfig, type PinConfigRuntime } from './config.js'

/** The plugin's settings namespace (the profile entry id). */
export const SETTINGS_NAMESPACE = 'dsh-subagent-plus'

/** How a materialization failure is reported; implementations dedupe by message. */
export type InvalidConfigReporter = (error: unknown) => void

/**
 * One hot state holder over the runtime config. `current()` re-evaluates the
 * source on every read in volatile mode (the host hands each field as a live
 * handle), or returns the snapshot taken at the last source swap otherwise.
 */
export class LivePinConfig {
  #source: () => PinConfigRuntime
  #current: PinConfig
  #volatile = false
  readonly #onInvalid: InvalidConfigReporter | undefined
  readonly #reported = new Set<string>()

  /**
   * @param entry - the runtime config object the host handed the plugin.
   * @param onInvalid - reporter for materialization failures, deduplicated by
   * message; the last good snapshot stays authoritative when it fires.
   */
  constructor(entry: PinConfigRuntime, onInvalid?: InvalidConfigReporter) {
    this.#source = () => entry
    this.#current = materializeConfig(entry)
    this.#onInvalid = onInvalid
  }

  /** The currently authoritative plain configuration. */
  current(): PinConfig {
    if (this.#volatile) this.#recompute()
    return this.#current
  }

  /** Adopt read-time evaluation — the volatile-source hook. */
  setVolatileSource(source: () => PinConfigRuntime): void {
    this.#source = source
    this.#volatile = true
    this.#recompute()
  }

  /** Recompute from the current source — the committed-change hook. */
  refresh(): void {
    this.#recompute()
  }

  #recompute(): void {
    try {
      this.#current = materializeConfig(this.#source())
      this.#reported.clear()
    } catch (error) {
      const message = String(error)
      if (this.#reported.has(message)) return
      this.#reported.add(message)
      this.#onInvalid?.(error)
    }
  }
}

/**
 * Attach the plugin's settings section on hosts that run the settings
 * service: the live config adopts read-time evaluation, and a committed
 * change for this namespace triggers the commit hook (re-warning degraded
 * cross-field combinations). Without a settings service the call is a no-op —
 * the entry config stays authoritative and the plugin must not fail to load.
 * Disposal is bound to the calling fiber by the surrounding effect.
 * @param ctx - the plugin's context.
 * @param entry - the runtime config object the host handed the plugin.
 * @param live - the live state to drive.
 * @param onCommit - runs after a committed change for this namespace.
 */
export function attachSettingsSection(
  ctx: Context,
  entry: PinConfigRuntime,
  live: LivePinConfig,
  onCommit?: () => void,
): void {
  ctx.inject(['settings'], () => {
    live.setVolatileSource(() => entry)
    ctx.on('settings/document-updated', (ns: string) => {
      if (ns === SETTINGS_NAMESPACE) onCommit?.()
    })
  })
}
