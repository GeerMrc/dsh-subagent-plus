/**
 * Pure badge decision logic, kept free of React and host types so it is
 * unit-testable without a renderer.
 * @module dsh-subagent-plus/client/badge-logic
 */

import { capabilityOf, type CapabilityOverride } from '../capability-scoring.js'

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

/** One candidate route as the visibility aggregate reads it. */
export interface VisibilityRoute {
  /** Route qualifier — a qualified override scores only its own route. */
  provider: string
  /** Raw model id as listed in the candidate routes. */
  model: string
}

/** KB-visibility aggregate of a candidate list (ADR 0016 3a F2): which
 *  candidates no layer knows (they hold zero rows whenever a known candidate
 *  exists — A-1), and whether every candidate is known-but-estimated (the
 *  ranking-basis hint). Mutually exclusive by construction: a list with
 *  unknowns never claims estimatedAll, because the hint would then describe
 *  rows those unknowns never receive.
 *  @param routes - the candidate route list.
 *  @param overrides - user-imported evaluation rows (L2), rescue path included.
 *  @returns the unknown model ids in list order plus the estimatedAll flag. */
export function kbVisibilityOf(
  routes: readonly VisibilityRoute[],
  overrides: readonly CapabilityOverride[],
): { unknownModels: string[]; estimatedAll: boolean } {
  const unknownModels: string[] = []
  let anyAnchored = false
  for (const route of routes) {
    const view = capabilityOf(route.model, overrides, undefined, route.provider)
    if (view.unknown) unknownModels.push(route.model)
    else if (!view.estimated) anyAnchored = true
  }
  return { unknownModels, estimatedAll: unknownModels.length === 0 && routes.length > 0 && !anyAnchored }
}

/** One derived mapping row as the bench aggregate reads it. */
export interface BenchRow {
  /** Route qualifier of the row's route. */
  provider: string
  /** Model id of the row's route. */
  model: string
}

/** Candidates holding no template row (G3, ADR 0016 3c): the middle failover
 *  tier — idle until a row's model fails, then the first takeover before the
 *  fallback is consulted. Surfaced as the bench hint so an idle candidate
 *  never reads as a bug.
 *  @param routes - the candidate route list.
 *  @param rows - the effective (derived or stored) mapping rows.
 *  @returns `provider/model` labels of candidates no row references. */
export function benchRouteLabelsOf(
  routes: readonly VisibilityRoute[],
  rows: readonly BenchRow[],
): string[] {
  const holding = new Set(rows.map(row => `${row.provider}/${row.model}`))
  return routes
    .filter(route => !holding.has(`${route.provider}/${route.model}`))
    .map(route => `${route.provider}/${route.model}`)
}
