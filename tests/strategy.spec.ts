import { describe, expect, it } from 'vitest'
import type { PinRoute } from '../src/pin.js'
import {
  assignedNotice,
  candidateRoutes,
  classifyFailure,
  createSelectionState,
  explicitRouteOf,
  fallbackNotice,
  byNameFallbackNotice,
  byNameNotice,
  byNameSkippedNotice,
  fallbackRouteOf,
  isValidKeyword,
  matchByKeyword,
  type NameMapEntryView,
  pinnedNotice,
  pinFallbackNotice,
  pinSkippedNotice,
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
  it('keeps the legacy pinned plan by default, with or without an explicit route', () => {
    expect(resolveStrategyPlan(base)).toEqual({ kind: 'pinned' })
    expect(resolveStrategyPlan({ ...base, provider: 'sz', model: 'm' })).toEqual({ kind: 'pinned' })
  })

  it('spreads regardless of the priority list, and flags ignored top-level fields', () => {
    expect(resolveStrategyPlan({ ...base, strategy: 'round-robin' })).toEqual({
      kind: 'spread', strategy: 'round-robin', ignoredRoute: false,
    })
    expect(resolveStrategyPlan({ ...base, strategy: 'random', provider: 'sz' })).toEqual({
      kind: 'spread', strategy: 'random', ignoredRoute: true,
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
      .toBe('[模型兜底 model fallback: 无可用候选路由，本子智能体运行 hh/x｜no usable candidate, runs hh/x — dsh-subagent-plus]')
  })
})

describe('validateStrategyConfig: empty list is a legitimate not-assigned state (R7)', () => {
  it('reports no degraded finding for an empty list under any strategy', () => {
    for (const strategy of ['pinned', 'round-robin', 'random', 'priority'] as const) {
      expect(validateStrategyConfig({ ...base, strategy }).degraded).toEqual([])
    }
  })
})

describe('candidateRoutes (S-01)', () => {
    it('maps priority entries and drops empty effort', () => {
    const config = {
      ...base,
      strategy: 'round-robin' as const,
      priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }, { provider: 'hh', model: 'b', reasoningEffort: 'high' }],
    }
    expect(candidateRoutes(config)).toEqual([
      { provider: 'sz', model: 'a' },
      { provider: 'hh', model: 'b', reasoningEffort: 'high' },
    ])
  })

  it('resolves no candidates for an empty list under every spread strategy', () => {
    for (const strategy of ['round-robin', 'random', 'priority'] as const) {
      expect(candidateRoutes({ ...base, strategy })).toEqual([])
    }
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
      .toBe('[模型指派 model assigned: 本子智能体所有请求运行 sz/Qwen3.8-27B-FP8（策略：轮询｜strategy: round-robin）— dsh-subagent-plus]')
  })

  it('names the cooled route, the code, and the replacement', () => {
    expect(reassignedNotice('sz/a', 'hh/a', 'RATE_LIMIT'))
      .toBe('[模型切换 model reassigned: sz/a 冷却中（RATE_LIMIT），本子智能体继续使用 hh/a｜sz/a cooling (RATE_LIMIT), continues hh/a — dsh-subagent-plus]')
  })

  it('names the pinned route', () => {
    expect(pinnedNotice('sz/Qwen3.8-27B-FP8'))
      .toBe('[模型钉定 model pinned: 本子智能体所有请求运行 sz/Qwen3.8-27B-FP8｜every request runs sz/Qwen3.8-27B-FP8 — dsh-subagent-plus]')
  })

  it('names the unusable pin and the fallback that took over', () => {
    expect(pinFallbackNotice('sz/a', 'hh/b'))
      .toBe('[模型钉定兜底 model pin fallback: 钉定路由 sz/a 当前不可用（冷却或未注册），本子智能体改用兜底 hh/b｜pinned route sz/a unavailable, runs fallback hh/b — dsh-subagent-plus]')
  })

  it('names the unregistered pin with no fallback: the child still runs it and fails loudly', () => {
    expect(pinSkippedNotice('sz/a'))
      .toBe('[模型钉定跳过 model pin skipped: 钉定路由 sz/a 未注册且无可用兜底，本子智能体仍将运行钉定路由（预期响亮失败）｜pinned route sz/a unregistered with no usable fallback; the child still runs the pinned route and fails loudly — dsh-subagent-plus]')
  })
})

const nm = (name: string, route: PinRoute, reasoningEffort = ''): NameMapEntryView =>
  ({ name, provider: route.provider, model: route.model, reasoningEffort })

describe('role-keyword matching (S-09, ADR 0008)', () => {
  it('accepts valid keywords and rejects everything else', () => {
    for (const keyword of ['ab', 'dev', 'researcher', 'plan-reviewer', 'a'.repeat(64)]) {
      expect(isValidKeyword(keyword)).toBe(true)
    }
    for (const keyword of ['', 'a', 'lead', 'Lead', 'dev_2', '-dev', 'dev-', 'dev--2', 'dev 2', 'a'.repeat(65)]) {
      expect(isValidKeyword(keyword)).toBe(false)
    }
  })

  it('matches by substring, not exact equality', () => {
    const map = [nm('researcher', sz), nm('coder', zai)]
    expect(matchByKeyword('researcher', map)).toEqual(map[0])
    expect(matchByKeyword('researcher-writer', map)).toEqual(map[0])
    expect(matchByKeyword('lead-researcher-helper', map)).toEqual(map[0])
    expect(matchByKeyword('coder', map)).toEqual(map[1])
    expect(matchByKeyword('peer-coder-v2', map)).toEqual(map[1])
    expect(matchByKeyword('reviewer', map)).toBeUndefined()
    expect(matchByKeyword('researcher', [])).toBeUndefined()
  })

  it('does not match when the keyword is longer than the teammate name', () => {
    const map = [nm('reviewer-v2', sz)]
    // keyword 'reviewer-v2' (10 chars) > teammate name 'reviewer' (8 chars) -> no match
    expect(matchByKeyword('reviewer', map)).toBeUndefined()
    // exact length match works
    expect(matchByKeyword('reviewer-v2', map)).toEqual(map[0])
    // teammate name longer than keyword containing it -> matches (substring)
    expect(matchByKeyword('reviewer-v2-extra', map)).toEqual(map[0])
  })

  it('longest keyword wins among multiple matches', () => {
    const map = [nm('dev', sz), nm('reviewer', zai)]
    // dev-reviewer matches both, but reviewer (8 chars) > dev (3 chars)
    expect(matchByKeyword('dev-reviewer', map)).toEqual(map[1])
    expect(matchByKeyword('dev-core', map)).toEqual(map[0])
  })

  it('equal-length keywords: first occurrence wins (deterministic)', () => {
    const map = [nm('dev', sz), nm('fix', zai)]
    // dev-fix matches both at 3 chars; first in the map wins
    expect(matchByKeyword('dev-fix', map)).toEqual(map[0])
  })

  it('nested keywords: the full name as keyword beats its substrings', () => {
    const map = [nm('plan', sz), nm('plan-reviewer', zai)]
    // plan-reviewer (14 chars) > plan (4 chars)
    expect(matchByKeyword('plan-reviewer', map)).toEqual(map[1])
    expect(matchByKeyword('plan-only', map)).toEqual(map[0])
  })

  it('exact name as keyword is a special case of keyword matching', () => {
    const map = [nm('researcher', sz)]
    expect(matchByKeyword('researcher', map)).toEqual(map[0])
    expect(matchByKeyword('researcher-writer', map)).toEqual(map[0])
  })

  it('accepts a valid map whose routes all come from the candidate list', () => {
    const report = validateStrategyConfig({
      ...base, nameMap: [nm('researcher', sz), nm('coder', zai)],
      priority: [
        { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
        { provider: 'zai', model: 'glm-5.3', reasoningEffort: '' },
      ],
    })
    expect(report.structural).toEqual([])
    expect(report.degraded).toEqual([])
  })

  it('keeps accepting configurations without a nameMap (v0.0.3 parity)', () => {
    expect(validateStrategyConfig(base).structural).toEqual([])
  })

  it('refuses a mapped route that is not in the candidate list (ADR 0007 dangling)', () => {
    const report = validateStrategyConfig({
      ...base,
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: [nm('researcher', zai)],
    })
    expect(report.structural).toHaveLength(1)
    expect(report.structural[0]).toContain('nameMap[0]')
    expect(report.structural[0]).toContain('zai/glm-5.3')
  })

  it('refuses any mapped row while the candidate list is empty', () => {
    const report = validateStrategyConfig({ ...base, priority: [], nameMap: [nm('researcher', sz)] })
    expect(report.structural.some(m => m.includes('nameMap[0]') && m.includes('candidate list'))).toBe(true)
  })

  it('a half-filled row reports its own defect, not the dangling one', () => {
    const report = validateStrategyConfig({
      ...base,
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: [{ name: 'researcher', provider: 'hh', model: '', reasoningEffort: '' }],
    })
    expect(report.structural).toHaveLength(1)
    expect(report.structural[0]).toContain('needs both provider and model')
  })

  it('refuses duplicate keywords, half-filled routes, and illegal keywords', () => {
    const listed = { ...base, priority: [
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      { provider: 'zai', model: 'glm-5.3', reasoningEffort: '' },
    ] }
    const dup = validateStrategyConfig({ ...listed, nameMap: [nm('dev', sz), nm('dev', zai)] })
    expect(dup.structural).toHaveLength(1)
    expect(dup.structural[0]).toContain('"dev"')

    const half = validateStrategyConfig({
      ...listed, nameMap: [{ name: 'dev', provider: 'sz', model: '', reasoningEffort: '' }],
    })
    expect(half.structural[0]).toContain('nameMap[0]')

    for (const bad of ['lead', 'Dev', 'a', 'a'.repeat(65), 'dev 2']) {
      const report = validateStrategyConfig({ ...listed, nameMap: [nm(bad, sz)] })
      expect(report.structural).toHaveLength(1)
      expect(report.structural[0]).toContain(bad === 'a'.repeat(65) ? '64' : `"${bad}"`)
    }
  })

  it('accepts several rows sharing one listed route (duplicates by keyword only)', () => {
    const report = validateStrategyConfig({
      ...base,
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: [nm('researcher', sz), nm('coder', sz)],
    })
    expect(report.structural).toEqual([])
  })

  it('accepts a keyword that is a substring of another keyword (longest wins resolves)', () => {
    const report = validateStrategyConfig({
      ...base,
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: [nm('dev', sz), nm('dev-core', sz)],
    })
    expect(report.structural).toEqual([])
  })

  it('refuses maps longer than 16 entries', () => {
    const long = Array.from({ length: 17 }, (_, i) => nm(`dev-${i + 1}`, sz))
    const report = validateStrategyConfig({
      ...base,
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: long,
    })
    expect(report.structural.some(m => m.includes('at most 16'))).toBe(true)
  })
})

describe('by-name notice text (S-09 helpers)', () => {
  it('names the teammate and route, bilingual on one line', () => {
    expect(byNameNotice('researcher', 'sz/Qwen3.8-27B-FP8')).toBe(
      '[按角色指派 model assigned by keyword: 匹配角色 "researcher" 的队友所有请求运行 sz/Qwen3.8-27B-FP8｜every request of a teammate matching "researcher" runs sz/Qwen3.8-27B-FP8 — dsh-subagent-plus]',
    )
  })

  it('names the fallback handover of an unusable mapped route', () => {
    expect(byNameFallbackNotice('sz/Qwen3.8-27B-FP8', 'zai/glm-5.3')).toBe(
      '[按角色兜底 model keyword fallback: 角色路由 sz/Qwen3.8-27B-FP8 当前不可用（冷却或未注册），本子智能体改用兜底 zai/glm-5.3｜role route sz/Qwen3.8-27B-FP8 unavailable, runs fallback zai/glm-5.3 — dsh-subagent-plus]',
    )
  })

  it('names the unregistered mapped route with no fallback: the child still runs it and fails loudly', () => {
    expect(byNameSkippedNotice('researcher', 'sz/Qwen3.8-27B-FP8')).toBe(
      '[按角色跳过 model keyword skipped: 匹配角色 "researcher" 的路由 sz/Qwen3.8-27B-FP8 未注册且无可用兜底，本子智能体仍将运行该路由（预期响亮失败）｜role route sz/Qwen3.8-27B-FP8 for "researcher" unregistered with no usable fallback; the child still runs it and fails loudly — dsh-subagent-plus]',
    )
  })
})
