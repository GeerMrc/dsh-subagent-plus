/**
 * Pure badge decision logic, kept free of React and host types so it is
 * unit-testable without a renderer.
 * @module dsh-subagent-plus/client/badge-logic
 */

/** Structural view of the durable `modelSelection` projection. */
export interface ModelSelectionLike {
  /** Route of the most recent real request, folded from `request/header`. */
  lastUsed?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
  /** Selection staged for the next request, when one is pending. */
  next?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
}

/** The badge's readable route: provider/model plus the effort actually used. */
export interface BadgeRoute {
  /** Provider id. */
  provider: string
  /** Model id. */
  model: string
  /** The reasoning effort the request actually carried, when it carried one. */
  effort?: string
}

/**
 * Decide the badge label for one session.
 * @param subagent - the session snapshot's `subagent` marker; `null` on a
 *  top-level session, whose model stays under the official selector.
 * @param projection - the session's `modelSelection` projection, if delivered.
 * @returns the readable route for a delegated session — provider/model plus
 *  the non-empty reasoning effort the request carried — or undefined when
 *  the badge renders nothing.
 */
export function badgeRoute(
  subagent: object | null | undefined,
  projection: ModelSelectionLike | undefined,
): BadgeRoute | undefined {
  if (subagent === null || subagent === undefined) return undefined
  if (projection === undefined || projection === null) return undefined
  const route = projection.lastUsed ?? projection.next
  if (route === undefined || route === null) return undefined
  if (typeof route.provider !== 'string' || typeof route.model !== 'string') return undefined
  return {
    provider: route.provider,
    model: route.model,
    ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort !== ''
      ? { effort: route.reasoningEffort }
      : {}),
  }
}
