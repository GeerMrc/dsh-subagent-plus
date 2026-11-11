/**
 * Name suggestions for the by-name mapping input (ADR 0007 decision 5).
 * Live team rosters live in the shared session store's `agentTeam`
 * projections — present only when the host runs the Team bundle — so the
 * aggregation is fully structural and degrades to an empty list on any
 * absent or foreign shape. Free-text stays possible: suggestions aid, never
 * constrain (a team is usually configured before it spawns).
 * @module dsh-subagent-plus/client/name-suggestions
 */

/** Structural view of one session's `agentTeam` projection value. */
interface AgentTeamProjectionLike {
  members?: readonly { name?: string; role?: string }[]
}

/** Structural view of the sessions store snapshot this plugin may read. */
interface SessionsSnapshotLike {
  projectionsBySession?: Record<string, { values?: { agentTeam?: AgentTeamProjectionLike } } | undefined>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Aggregate teammate names across every session's `agentTeam` projection,
 * dropping the `lead` pseudo-row; deduped and sorted.
 * @param snapshot - the sessions store snapshot (already unwrapped), any shape.
 * @returns teammate names worth suggesting, possibly empty.
 */
export function teamNamesFromSessions(snapshot: unknown): string[] {
  if (!isRecord(snapshot)) return []
  const projections = (snapshot as SessionsSnapshotLike).projectionsBySession
  if (!isRecord(projections)) return []
  const names = new Set<string>()
  for (const entry of Object.values(projections)) {
    const members = isRecord(entry)
      ? (entry as { values?: unknown }).values
      : undefined
    const team = isRecord(members) ? (members as { agentTeam?: unknown }).agentTeam : undefined
    if (!isRecord(team)) continue
    // A foreign `members` value must degrade to no suggestions, never throw
    // during a render — Array.isArray is the only shape this loop trusts.
    const roster = (team as AgentTeamProjectionLike).members
    if (!Array.isArray(roster)) continue
    for (const member of roster) {
      if (!isRecord(member)) continue
      const { name, role } = member as { name?: unknown; role?: unknown }
      if (typeof name !== 'string' || name === '' || role === 'lead') continue
      names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * Union live roster names with the names already configured in the table.
 * @param teamNames - live roster names (possibly empty).
 * @param usedNames - configured names; empty strings are ignored.
 * @returns the datalist suggestion list, deduped and sorted.
 */
export function nameSuggestions(teamNames: readonly string[], usedNames: readonly string[]): string[] {
  const names = new Set<string>()
  for (const name of teamNames) if (name !== '') names.add(name)
  for (const name of usedNames) if (name !== '') names.add(name)
  return [...names].sort()
}
