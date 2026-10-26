import { describe, expect, it } from 'vitest'
import {
  childDepthOf,
  isForkedChild,
  pinnedRoute,
  resolvePinRoute,
  type AgentLike,
  type OfficialModelSelectionSettings,
  type PinConfigView,
  type SessionEventLike,
} from '../src/pin.js'

function agentWith(overrides: Partial<AgentLike>): AgentLike {
  return { options: {}, session: { header: {} }, ...overrides }
}

const base: PinConfigView = {
  enabled: true,
  provider: '',
  model: '',
  reasoningEffort: '',
  autoRoute: true,
}

function settingsWith(current: OfficialModelSelectionSettings['current']): OfficialModelSelectionSettings {
  return { current }
}

describe('childDepthOf', () => {
  it('reads 0 for a top-level agent without depth markers', () => {
    expect(childDepthOf(agentWith({}))).toBe(0)
    expect(childDepthOf({})).toBe(0)
  })

  it('prefers the deeper of runtime options and session header depths', () => {
    expect(childDepthOf(agentWith({ options: { subagentDepth: 1 } }))).toBe(1)
    expect(childDepthOf(agentWith({ session: { header: { delegationDepth: 2 } } }))).toBe(2)
    expect(childDepthOf(agentWith({
      options: { subagentDepth: 1 },
      session: { header: { delegationDepth: 3 } },
    }))).toBe(3)
  })

  it('ignores non-integer or negative depth values', () => {
    expect(childDepthOf(agentWith({ options: { subagentDepth: 1.5 } }))).toBe(0)
    expect(childDepthOf(agentWith({ session: { header: { delegationDepth: -1 } } }))).toBe(0)
  })
})

describe('isForkedChild', () => {
  const endSeed = (inherited: boolean): SessionEventLike =>
    ({ type: 'session/end-seed', data: { inherited } })

  it('detects the tagged end-seed at the inherited cut', () => {
    const agent = agentWith({
      session: {
        header: { delegationDepth: 1 },
        inheritedEventCount: 4,
        eventAt: (seq: number) => (seq === 4 ? endSeed(true) : undefined),
      },
    })
    expect(isForkedChild(agent)).toBe(true)
  })

  it('rejects an untagged end-seed marker', () => {
    const agent = agentWith({
      session: {
        inheritedEventCount: 3,
        eventAt: (seq: number) => (seq === 3 ? { type: 'session/end-seed', data: {} } : undefined),
      },
    })
    expect(isForkedChild(agent)).toBe(false)
  })

  it('returns false when the cut holds another event or is absent', () => {
    expect(isForkedChild(agentWith({
      session: { inheritedEventCount: 0, eventAt: () => ({ type: 'permission/preset', data: {} }) },
    }))).toBe(false)
    expect(isForkedChild(agentWith({
      session: { header: { delegationDepth: 1 }, inheritedEventCount: 2, eventAt: () => undefined },
    }))).toBe(false)
    expect(isForkedChild(agentWith({ session: { header: { delegationDepth: 1 } } }))).toBe(false)
  })
})

describe('resolvePinRoute', () => {
  const official = settingsWith(() => ({
    enabled: true,
    allowedModels: [{ provider: 'sz', model: 'first-model' }, { provider: 'sz', model: 'second-model' }],
  }))

  it('prefers the explicitly configured route', () => {
    expect(resolvePinRoute(
      { ...base, provider: 'hh', model: 'explicit', reasoningEffort: 'low' },
      official,
    )).toEqual({ provider: 'hh', model: 'explicit', reasoningEffort: 'low' })
  })

  it('adopts the first official allowed route when unset and autoRoute is on', () => {
    expect(resolvePinRoute(base, official)).toEqual({ provider: 'sz', model: 'first-model' })
  })

  it('does not auto-route without the settings service', () => {
    expect(resolvePinRoute(base, undefined)).toBeUndefined()
  })

  it('does not auto-route when the official preference is disabled or empty', () => {
    expect(resolvePinRoute(base, settingsWith(() => ({ enabled: false, allowedModels: [{ provider: 'sz', model: 'm' }] })))).toBeUndefined()
    expect(resolvePinRoute(base, settingsWith(() => ({ enabled: true, allowedModels: [] })))).toBeUndefined()
  })

  it('respects autoRoute=false and rejects half-set explicit routes', () => {
    expect(resolvePinRoute({ ...base, autoRoute: false }, official)).toBeUndefined()
    expect(resolvePinRoute({ ...base, provider: 'sz' }, official)).toBeUndefined()
    expect(resolvePinRoute({ ...base, model: 'm' }, official)).toBeUndefined()
  })

  it('never pins when disabled, and propagates settings failures', () => {
    expect(resolvePinRoute({ ...base, enabled: false, provider: 'sz', model: 'm' }, official)).toBeUndefined()
    expect(() => resolvePinRoute(base, settingsWith(() => { throw new Error('unreadable') }))).toThrow('unreadable')
  })
})

describe('pinnedRoute', () => {
  it('returns undefined when the route and effort already match', () => {
    expect(pinnedRoute(
      { provider: 'sz', model: 'm1', reasoningEffort: 'low' },
      { provider: 'sz', model: 'm1', reasoningEffort: 'low' },
    )).toBeUndefined()
    expect(pinnedRoute({ provider: 'sz', model: 'm1' }, { provider: 'sz', model: 'm1' })).toBeUndefined()
  })

  it('reports effort-only when the route matches but the effort differs', () => {
    expect(pinnedRoute(
      { provider: 'sz', model: 'm1', reasoningEffort: 'low' },
      { provider: 'sz', model: 'm1', reasoningEffort: 'high' },
    )).toEqual({ kind: 'effort-only', reasoningEffort: 'high' })
  })

  it('overrides an inherited route and names the pinned effort', () => {
    expect(pinnedRoute(
      { provider: 'strata', model: 'flash', reasoningEffort: 'medium' },
      { provider: 'sz', model: 'm1', reasoningEffort: 'low' },
    )).toEqual({ kind: 'route', provider: 'sz', model: 'm1', reasoningEffort: 'low' })
  })

  it('drops the inherited effort on a route change without a pinned effort', () => {
    expect(pinnedRoute(
      { provider: 'strata', model: 'flash', reasoningEffort: 'medium' },
      { provider: 'sz', model: 'm1' },
    )).toEqual({ kind: 'route', provider: 'sz', model: 'm1' })
  })
})
