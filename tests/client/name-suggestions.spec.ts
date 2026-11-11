import { describe, expect, it } from 'vitest'
import { nameSuggestions, teamNamesFromSessions } from '../../src/client/name-suggestions.js'

/** The name input's datalist suggestions: live team rosters (shared session
 *  projections, present only when the host runs the Team bundle) union the
 *  names already configured — free-text stays possible for pre-configuring a
 *  team that has not spawned yet (ADR 0007 decision 5). */
describe('teamNamesFromSessions', () => {
  it('aggregates member names across sessions, dropping the lead pseudo-row', () => {
    const snapshot = {
      projectionsBySession: {
        s1: { values: { agentTeam: { members: [
          { name: 'lead', role: 'lead' },
          { name: 'researcher', role: 'teammate' },
          { name: 'coder', role: 'teammate' },
        ] } } },
        s2: { values: { agentTeam: { members: [{ name: 'reviewer', role: 'teammate' }] } } },
        s3: { values: {} },
      },
    }
    expect(teamNamesFromSessions(snapshot)).toEqual(['coder', 'researcher', 'reviewer'])
  })

  it('returns an empty list for absent, empty, or foreign-shaped snapshots', () => {
    expect(teamNamesFromSessions(undefined)).toEqual([])
    expect(teamNamesFromSessions({})).toEqual([])
    expect(teamNamesFromSessions({ projectionsBySession: undefined })).toEqual([])
    expect(teamNamesFromSessions({ projectionsBySession: { s1: undefined } })).toEqual([])
    expect(teamNamesFromSessions({ projectionsBySession: { s1: { values: { agentTeam: undefined } } } })).toEqual([])
    expect(teamNamesFromSessions('not-a-snapshot')).toEqual([])
    // Hostile `members` values degrade, never throw (R7-R2 🟡-1).
    expect(teamNamesFromSessions({ projectionsBySession: { s1: { values: { agentTeam: { members: 42 } } } } })).toEqual([])
    expect(teamNamesFromSessions({ projectionsBySession: { s1: { values: { agentTeam: { members: { bad: true } } } } } })).toEqual([])
    expect(teamNamesFromSessions({ projectionsBySession: { s1: { values: { agentTeam: { members: 'lead' } } } } })).toEqual([])
  })
})

describe('nameSuggestions', () => {
  it('unions roster names with already-configured names, deduped and sorted', () => {
    expect(nameSuggestions(['researcher'], ['coder', 'researcher', ''])).toEqual(['coder', 'researcher'])
    expect(nameSuggestions([], ['coder'])).toEqual(['coder'])
  })
})
