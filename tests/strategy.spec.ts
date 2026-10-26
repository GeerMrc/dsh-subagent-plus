import { describe, expect, it } from 'vitest'
import type { PinRoute } from '../src/pin.js'
import {
  assignedNotice,
  candidateRoutes,
  classifyFailure,
  createSelectionState,
  explicitRouteOf,
  fallbackNotice,
  fallbackRouteOf,
  reassignedNotice,
  resolveStrategyPlan,
  RouteHealth,
  routeKey,
  selectChildRoute,
  usableFallback,
  validateStrategyConfig,
  type StrategyConfigView,
} from '../src/strategy.js'

const base: StrategyConfigView = {
  enabled: true,
  provider: '',
  model: '',
  strategy: 'pinned',
  priority: [],
  respectExplicit: false,
  cooldownMs: 120_000,
  fallbackProvider: '',
  fallbackModel: '',
  fallbackReasoningEffort: '',
}

const sz: PinRoute = { provider: 'sz', model: 'Qwen3.8-27B-FP8' }
const hh: PinRoute = { provider: 'hh', model: 'Qwen3.8-27B-FP8' }
const zai: PinRoute = { provider: 'zai', model: 'glm-5.3' }
const always = (): boolean => true
const sequence = (...values: number[]): (() => number) => {
  let index = 0
  return () => values[index++ % values.length] ?? 0
}

describe('resolveStrategyPlan (S-01)', () => {
  it('is off when disabled regardless of strategy', () => {
    expect(resolveStrategyPlan({ ...base, enabled: false, strategy: 'round-robin' })).toEqual({ kind: 'off' })
  })

  it('keeps the legacy pinned plan by default, with or without an explicit route', () => {
    expect(resolveStrategyPlan(base)).toEqual({ kind: 'pinned' })
    expect(resolveStrategyPlan({ ...base, provider: 'sz', model: 'm' })).toEqual({ kind: 'pinned' })
  })

  it('spreads from the official list when priority is empty, and flags ignored top-level fields', () => {
    expect(resolveStrategyPlan({ ...base, strategy: 'round-robin' })).toEqual({
      kind: 'spread', strategy: 'round-robin', source: 'official', ignoredRoute: false,
    })
    expect(resolveStrategyPlan({ ...base, strategy: 'random', provider: 'sz' })).toEqual({
      kind: 'spread', strategy: 'random', source: 'official', ignoredRoute: true,
    })
  })

  it('spreads from priority when configured', () => {
    const priority = [{ provider: 'sz', model: 'a', reasoningEffort: '' }]
    expect(resolveStrategyPlan({ ...base, strategy: 'priority', priority })).toEqual({
      kind: 'spread', strategy: 'priority', source: 'priority', ignoredRoute: false,
    })
  })
})

describe('validateStrategyConfig (structural vs degraded, anti-brick)', () => {
  it('accepts the defaults and a well-formed priority list', () => {
    expect(validateStrategyConfig(base)).toEqual({ structural: [], degraded: [] })
    expect(validateStrategyConfig({
      ...base,
      strategy: 'priority',
      priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }, { provider: 'hh', model: 'a', reasoningEffort: 'high' }],
    })).toEqual({ structural: [], degraded: [] })
  })

  it('reports an over-long priority list as structural (at most 5)', () => {
    const report = validateStrategyConfig({
      ...base,
      priority: Array.from({ length: 6 }, (_, index) => ({ provider: `p${index}`, model: 'a', reasoningEffort: '' })),
    })
    expect(report.structural[0]).toMatch(/at most 5/)
    expect(report.degraded).toEqual([])
  })

  it('reports half-filled priority entries and repeated routes as structural', () => {
    expect(validateStrategyConfig({
      ...base, priority: [{ provider: 'sz', model: '', reasoningEffort: '' }],
    }).structural[0]).toMatch(/priority\[0\] needs both provider and model/)
    expect(validateStrategyConfig({
      ...base,
      priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }, { provider: 'sz', model: 'a', reasoningEffort: 'low' }],
    }).structural[0]).toMatch(/repeats route "sz\/a"/)
  })

  it('degrades a priority strategy with no routes instead of throwing (restart-safe)', () => {
    const report = validateStrategyConfig({ ...base, strategy: 'priority' })
    expect(report.structural).toEqual([])
    expect(report.degraded[0]).toMatch(/strategy "priority" lists no candidate routes/)
  })

  it('degrades a half-filled fallback', () => {
    expect(validateStrategyConfig({ ...base, fallbackProvider: 'hh' }).degraded[0]).toMatch(/fallback needs both provider and model/)
    expect(validateStrategyConfig({ ...base, fallbackModel: 'x' }).degraded[0]).toMatch(/fallback needs both provider and model/)
  })

  it('degrades a fallback repeating a listed route', () => {
    const report = validateStrategyConfig({
      ...base,
      priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }],
      fallbackProvider: 'sz',
      fallbackModel: 'a',
    })
    expect(report.degraded[0]).toMatch(/repeats the listed route "sz\/a"/)
  })
})

describe('fallbackRouteOf / usableFallback (fallback adjudication)', () => {
  it('is unset when either field is empty or both are', () => {
    expect(fallbackRouteOf(base)).toBeUndefined()
    expect(fallbackRouteOf({ ...base, fallbackProvider: 'hh' })).toBeUndefined()
    expect(fallbackRouteOf({ ...base, fallbackModel: 'x' })).toBeUndefined()
  })

  it('is the configured route, keeping a set effort and dropping an empty one', () => {
    expect(fallbackRouteOf({ ...base, fallbackProvider: 'hh', fallbackModel: 'x' })).toEqual({ provider: 'hh', model: 'x' })
    expect(fallbackRouteOf({ ...base, fallbackProvider: 'hh', fallbackModel: 'x', fallbackReasoningEffort: 'high' }))
      .toEqual({ provider: 'hh', model: 'x', reasoningEffort: 'high' })
  })

  it('is unset when it repeats a listed priority route', () => {
    expect(fallbackRouteOf({
      ...base,
      priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }],
      fallbackProvider: 'sz',
      fallbackModel: 'a',
    })).toBeUndefined()
  })

  it('usableFallback narrows by health only', () => {
    expect(usableFallback(sz, () => true)).toEqual(sz)
    expect(usableFallback(sz, () => false)).toBeUndefined()
    expect(usableFallback(undefined, () => true)).toBeUndefined()
  })

  it('names the fallback in its notice', () => {
    expect(fallbackNotice('hh/x'))
      .toBe('[model fallback: no usable candidate route; this child agent runs hh/x (dsh-subagent-plus)]')
  })
})

describe('candidateRoutes (S-01)', () => {
  const spread = { kind: 'spread', strategy: 'round-robin', source: 'official', ignoredRoute: false } as const

  it('maps priority entries and drops empty effort', () => {
    const config = {
      ...base,
      strategy: 'round-robin' as const,
      priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }, { provider: 'hh', model: 'b', reasoningEffort: 'high' }],
    }
    expect(candidateRoutes({ ...spread, source: 'priority' }, config, undefined)).toEqual([
      { provider: 'sz', model: 'a' },
      { provider: 'hh', model: 'b', reasoningEffort: 'high' },
    ])
  })

  it('reads the official allowed list in stored order, empty when disabled or absent', () => {
    const settings = { current: () => ({ enabled: true, allowedModels: [sz, hh] }) }
    expect(candidateRoutes(spread, base, settings)).toEqual([sz, hh])
    expect(candidateRoutes(spread, base, { current: () => ({ enabled: false, allowedModels: [sz] }) })).toEqual([])
    expect(candidateRoutes(spread, base, undefined)).toEqual([])
  })

  it('propagates a throwing current()', () => {
    const settings = { current: (): never => { throw new Error('empty list') } }
    expect(() => candidateRoutes(spread, base, settings)).toThrow('empty list')
  })

  it('resolves no candidates for the priority strategy with an empty list, even with an official list present (degraded)', () => {
    const settings = { current: () => ({ enabled: true, allowedModels: [sz, hh] }) }
    const plan = { kind: 'spread', strategy: 'priority', source: 'official', ignoredRoute: false } as const
    expect(candidateRoutes(plan, { ...base, strategy: 'priority' }, settings)).toEqual([])
  })
})

describe('selectChildRoute (S-02)', () => {
  it('returns undefined when no candidate is usable', () => {
    const state = createSelectionState()
    expect(selectChildRoute('priority', [], always, state, sequence(0))).toBeUndefined()
    expect(selectChildRoute('round-robin', [sz, hh], () => false, state, sequence(0))).toBeUndefined()
    expect(selectChildRoute('random', [sz], always, state, sequence(0), sz)).toBeUndefined()
  })

  it('priority takes the first healthy route and skips the excluded one', () => {
    const state = createSelectionState()
    expect(selectChildRoute('priority', [sz, hh, zai], always, state, sequence(0))).toEqual(sz)
    expect(selectChildRoute('priority', [sz, hh, zai], route => route !== sz, state, sequence(0))).toEqual(hh)
    expect(selectChildRoute('priority', [sz, hh, zai], always, state, sequence(0), sz)).toEqual(hh)
  })

  it('round-robin rotates over the full order with a shared cursor and skips unhealthy routes', () => {
    const state = createSelectionState()
    const pick = (healthy: (route: PinRoute) => boolean = always): PinRoute | undefined =>
      selectChildRoute('round-robin', [sz, hh, zai], healthy, state, sequence(0))
    expect(pick()).toEqual(sz)
    expect(pick()).toEqual(hh)
    expect(pick()).toEqual(zai)
    expect(pick()).toEqual(sz)
    expect(pick(route => route !== hh)).toEqual(zai)
    expect(state.cursor).toBe(0)
  })

  it('round-robin tolerates a shorter candidate list by taking the cursor modulo its length', () => {
    const state = createSelectionState()
    state.cursor = 5
    expect(selectChildRoute('round-robin', [sz, hh], always, state, sequence(0))).toEqual(hh)
    expect(state.cursor).toBe(0)
  })

  it('random draws every candidate once per cycle, then reshuffles', () => {
    const state = createSelectionState()
    // rng 0 keeps the Fisher-Yates swaps at index 0: deck becomes reversed-then-rotated deterministically.
    const rng = sequence(0)
    const drawn = [1, 2, 3].map(() => selectChildRoute('random', [sz, hh, zai], always, state, rng))
    expect(drawn.map(route => route && routeKey(route)).sort()).toEqual([sz, hh, zai].map(routeKey).sort())
    expect(state.deck).toEqual([])
    const fourth = selectChildRoute('random', [sz, hh, zai], always, state, rng)
    expect([sz, hh, zai]).toContainEqual(fourth)
    expect(state.deck).toHaveLength(2)
  })

  it('random reshuffles when the candidate multiset changes', () => {
    const state = createSelectionState()
    const rng = sequence(0)
    selectChildRoute('random', [sz, hh], always, state, rng)
    expect(state.deck).toHaveLength(1)
    const next = selectChildRoute('random', [sz, hh, zai], always, state, rng)
    expect([sz, hh, zai]).toContainEqual(next)
    expect(state.deckSource).toEqual([sz, hh, zai].map(routeKey))
    expect(state.deck).toHaveLength(2)
  })

  it('random still finds a usable route already drawn this cycle by reshuffling once', () => {
    const state = createSelectionState()
    const rng = sequence(0)
    const first = selectChildRoute('random', [sz, hh], always, state, rng)
    const other = first === sz ? hh : sz
    // Only the already-drawn route is healthy now: the deck holds `other`, so a reshuffle is needed.
    const again = selectChildRoute('random', [sz, hh], route => route === first, state, rng)
    expect(again).toEqual(first)
    expect(other).not.toEqual(again)
  })
})

describe('classifyFailure (S-03)', () => {
  it.each([
    ['RATE_LIMIT', undefined, 'transient'],
    ['SERVER', undefined, 'transient'],
    ['TIMEOUT', undefined, 'transient'],
    ['TRANSPORT', undefined, 'transient'],
    ['EMPTY_RESPONSE', undefined, 'transient'],
    ['AUTH', undefined, 'sticky-provider'],
    ['INVALID_CREDENTIAL', 401, 'sticky-provider'],
    ['QUOTA', undefined, 'sticky-provider'],
    ['ACCOUNT_QUOTA', undefined, 'sticky-provider'],
    ['NO_ADAPTER', undefined, 'sticky-route'],
    ['UNSUPPORTED_REASONING_EFFORT', undefined, 'sticky-route'],
    ['CONTEXT_WINDOW_EXCEEDED', undefined, 'ignore'],
    ['IMAGE_OFFLOAD_REQUIRED', undefined, 'ignore'],
    ['ABORTED', undefined, 'ignore'],
    ['UNKNOWN', undefined, 'ignore'],
    ['UNKNOWN', 400, 'ignore'],
    ['UNKNOWN', 429, 'transient'],
    ['UNKNOWN', 503, 'transient'],
    ['SOME_FUTURE_CODE', 500, 'ignore'],
  ] as const)('%s (status %s) → %s', (code, status, expected) => {
    expect(classifyFailure(code, status)).toBe(expected)
  })
})

describe('RouteHealth (S-05)', () => {
  it('is healthy until marked, and only while the cooldown is active', () => {
    const health = new RouteHealth()
    expect(health.isHealthy(sz, 1_000)).toBe(true)
    health.markRoute(sz, 5_000, 'RATE_LIMIT')
    expect(health.isHealthy(sz, 4_999)).toBe(false)
    expect(health.cooldown(sz, 4_999)).toEqual({ until: 5_000, code: 'RATE_LIMIT' })
    expect(health.isHealthy(sz, 5_000)).toBe(true)
    expect(health.isHealthy(hh, 4_999)).toBe(true)
  })

  it('never shortens an existing cooldown', () => {
    const health = new RouteHealth()
    health.markRoute(sz, 9_000, 'SERVER')
    health.markRoute(sz, 6_000, 'TIMEOUT')
    expect(health.cooldown(sz, 0)).toEqual({ until: 9_000, code: 'SERVER' })
    health.markRoute(sz, 12_000, 'TIMEOUT')
    expect(health.cooldown(sz, 0)).toEqual({ until: 12_000, code: 'TIMEOUT' })
  })

  it('provider cooldowns cover every route of that provider and win when they end later', () => {
    const health = new RouteHealth()
    health.markProvider('sz', 8_000, 'AUTH')
    expect(health.isHealthy(sz, 7_999)).toBe(false)
    expect(health.isHealthy({ provider: 'sz', model: 'other' }, 7_999)).toBe(false)
    expect(health.isHealthy(hh, 7_999)).toBe(true)
    health.markRoute(sz, 6_000, 'TIMEOUT')
    expect(health.cooldown(sz, 0)).toEqual({ until: 8_000, code: 'AUTH' })
    health.markRoute(sz, 10_000, 'TIMEOUT')
    expect(health.cooldown(sz, 0)).toEqual({ until: 10_000, code: 'TIMEOUT' })
  })
})

describe('explicitRouteOf (S-04)', () => {
  it('treats a child route equal to the parent route as inherited', () => {
    expect(explicitRouteOf({ provider: 'zai', model: 'glm-5.3' }, zai)).toBeUndefined()
  })

  it('treats an unknown parent route as inherited', () => {
    expect(explicitRouteOf({ provider: 'hh', model: 'x' }, undefined)).toBeUndefined()
    expect(explicitRouteOf({ provider: 'hh', model: 'x' }, { provider: 'zai' })).toBeUndefined()
    expect(explicitRouteOf({ provider: 'hh' }, zai)).toBeUndefined()
  })

  it('returns a differing child route as explicit, keeping its effort', () => {
    expect(explicitRouteOf({ provider: 'hh', model: 'x', reasoningEffort: 'high' }, zai))
      .toEqual({ provider: 'hh', model: 'x', reasoningEffort: 'high' })
    expect(explicitRouteOf({ provider: 'hh', model: 'x' }, zai)).toEqual({ provider: 'hh', model: 'x' })
  })
})

describe('notice text (S-08 helpers)', () => {
  it('names route and strategy', () => {
    expect(assignedNotice('sz/Qwen3.8-27B-FP8', 'round-robin'))
      .toBe('[model assigned: every request from this child agent runs sz/Qwen3.8-27B-FP8 (strategy: round-robin, dsh-subagent-plus)]')
  })

  it('names the cooled route, the code, and the replacement', () => {
    expect(reassignedNotice('sz/a', 'hh/a', 'RATE_LIMIT'))
      .toBe('[model reassigned: route sz/a is cooling down (RATE_LIMIT); this child agent continues with hh/a (dsh-subagent-plus)]')
  })
})
