/**
 * One save button for every namespace this settings page edits (ADR 0002 D2):
 * the plugin's own form plus each absorbed official form commit in a fixed
 * order behind their own revision fences. Availability is per namespace — a
 * namespace the host does not serve is excluded from the run instead of
 * blocking the others, while a blocked (invalid input) namespace stops the
 * run exactly like the official single-form pages do. The first failure
 * (conflict, transport error, or blocked input) stops the run; namespaces
 * already committed stay committed and name themselves in the footer.
 *
 * @module dsh-subagent-plus/client/unified-save
 */

/** One namespace save attempt's outcome; the orchestrator's only vocabulary. */
export type SaveOutcome =
  /** Nothing dirty to write. */
  | 'clean'
  /** The revision fence accepted the ops. */
  | 'saved'
  /** The revision fence rejected the ops; the form reloaded a newer value. */
  | 'conflict'
  /** The transport rejected the write. */
  | 'failed'
  /** Invalid input blocks the write (official single-form semantics). */
  | 'blocked'
  /** The namespace is not served (or unreadable); excluded from the run. */
  | 'unavailable'

/** One namespace participating in the unified save, in dispatch order. */
export interface SaveParticipant {
  /** Footer-facing section key: 'limits' | 'self'. */
  key: string
  /** One save attempt; never throws (outcomes carry the failure modes). */
  save(): Promise<SaveOutcome>
}

/** Render state for the single footer. */
export interface UnifiedSaveState {
  saving: boolean
  /** Every dispatched participant saved (or had nothing to write). */
  saved: boolean
  /** The participant key whose transport failed; the run stopped there. */
  failedAt?: string
  /** The participant key whose revision fence rejected; the run stopped there. */
  conflictAt?: string
  /** The participant key with invalid input; nothing was written. */
  blockedAt?: string
}

/**
 * Orchestrates the fixed-order multi-namespace save behind one button.
 */
export class UnifiedSaveController {
  readonly #participants: readonly SaveParticipant[]
  readonly #listeners = new Set<() => void>()
  #state: UnifiedSaveState
  #disposed = false

  /**
   * @param participants - namespaces in commit order (official namespaces
   * first, the plugin's own form last).
   */
  constructor(participants: readonly SaveParticipant[]) {
    this.#participants = participants
    this.#state = { saving: false, saved: false }
  }

  /** Subscribe to snapshot replacements (useSyncExternalStore contract). */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** The current render-ready snapshot (stable reference until the next change). */
  snapshot = (): UnifiedSaveState => this.#state

  /** Drop listeners; the section effect's disposer calls this. */
  dispose = (): void => {
    this.#disposed = true
    this.#listeners.clear()
  }

  /** Commit every dirty namespace in order; the first failure stops the run. */
  save = async (): Promise<void> => {
    if (this.#state.saving) return
    this.#patch({ saving: true, saved: false, failedAt: undefined, conflictAt: undefined, blockedAt: undefined })
    for (const participant of this.#participants) {
      let outcome: SaveOutcome
      try {
        outcome = await participant.save()
      } catch {
        outcome = 'failed'
      }
      if (this.#disposed) return
      if (outcome === 'failed') {
        this.#patch({ saving: false, failedAt: participant.key })
        return
      }
      if (outcome === 'conflict') {
        this.#patch({ saving: false, conflictAt: participant.key })
        return
      }
      if (outcome === 'blocked') {
        this.#patch({ saving: false, blockedAt: participant.key })
        return
      }
    }
    this.#patch({ saving: false, saved: true })
  }

  #patch = (patch: Partial<UnifiedSaveState>): void => {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }
}
