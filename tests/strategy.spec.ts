import { describe, expect, it } from 'vitest'
import type { PinRoute } from '../src/pin.js'
import {
  assignedNotice,
  deriveStarterRows,
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
  resolveNameMapDefaults,
  resolveSemanticEffort,
  resolveStrategyPlan,
  STARTER_TEMPLATE_ROWS,
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
    expect(validateStrategyConfig(base)).toEqual({ structural: [], degraded: [], advisory: [] })
    expect(validateStrategyConfig({
      ...base,
      strategy: 'priority',
      priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }, { provider: 'hh', model: 'a', reasoningEffort: 'high' }],
    })).toEqual({ structural: [], degraded: [], advisory: [] })
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

  it('an empty keyword never matches (bestLength starts at 0)', () => {
    const map = [nm('', sz)]
    expect(matchByKeyword('researcher', map)).toBeUndefined()
    expect(matchByKeyword('', map)).toBeUndefined()
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

  it('refuses maps longer than 32 entries (ADR 0013 d5)', () => {
    const long = Array.from({ length: 33 }, (_, i) => nm(`dev-${i + 1}`, sz))
    const report = validateStrategyConfig({
      ...base,
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: long,
    })
    expect(report.structural.some(m => m.includes('at most 32'))).toBe(true)
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


describe('semantic effort intents (X2, ADR 0014 d1)', () => {
  it('top/mid/lowest on the qwen vocabulary: xhigh / medium / low', () => {
    const qwen = { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'xhigh', name: 'Xhigh' }] }
    expect(resolveSemanticEffort(qwen, 'top')).toBe('xhigh')
    expect(resolveSemanticEffort(qwen, 'mid')).toBe('medium')
    expect(resolveSemanticEffort(qwen, 'lowest')).toBe('low')
  })

  it('mid takes the upper median on even ACTIVE tier counts (review #5)', () => {
    // 4 active on-ladder tiers: low < medium < high < xhigh → 3rd (high).
    expect(resolveSemanticEffort({ efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] }, 'mid')).toBe('high')
    // 2 active on-ladder tiers: low < high → 2nd (high).
    expect(resolveSemanticEffort({ efforts: [{ id: 'low' }, { id: 'high' }] }, 'mid')).toBe('high')
    // Disabled tiers never count toward the median.
    expect(resolveSemanticEffort({ efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'xhigh' }] }, 'mid')).toBe('high')
    const oneActive = { efforts: [{ id: 'off' }, { id: 'low' }] }
    expect(resolveSemanticEffort(oneActive, 'mid')).toBe('low')
    expect(resolveSemanticEffort(oneActive, 'top')).toBe('low')
  })

  it('zai vocabulary: mid=high among low/high/max', () => {
    const zai = { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] }
    expect(resolveSemanticEffort(zai, 'mid')).toBe('high')
    expect(resolveSemanticEffort(zai, 'top')).toBe('max')
  })

  it('minimal ranks below low on the ladder', () => {
    const tiers = { efforts: [{ id: 'minimal' }, { id: 'low' }, { id: 'high' }] }
    expect(resolveSemanticEffort(tiers, 'lowest')).toBe('minimal')
    expect(resolveSemanticEffort(tiers, 'mid')).toBe('low')
  })

  it('ladder ranks win over non-monotonic display order; mixed sets rank on-ladder tiers only', () => {
    const shuffled = { efforts: [{ id: 'xhigh' }, { id: 'medium' }, { id: 'low' }] }
    expect(resolveSemanticEffort(shuffled, 'mid')).toBe('medium')
    const mixed = { efforts: [{ id: 'low' }, { id: 'turbo' }] }
    expect(resolveSemanticEffort(mixed, 'mid')).toBe('low')
  })

  it('off-ladder-only ids fall back to catalog order with the upper median', () => {
    const three = { efforts: [{ id: 'eco' }, { id: 'standard' }, { id: 'turbo' }] }
    expect(resolveSemanticEffort(three, 'mid')).toBe('standard')
    const two = { efforts: [{ id: 'eco' }, { id: 'turbo' }] }
    expect(resolveSemanticEffort(two, 'mid')).toBe('turbo')
  })

  it('matches ladder ids case-insensitively and returns the original id', () => {
    const route = { efforts: [{ id: 'Low' }, { id: 'XHigh' }] }
    expect(resolveSemanticEffort(route, 'top')).toBe('XHigh')
    expect(resolveSemanticEffort(route, 'lowest')).toBe('Low')
    expect(resolveSemanticEffort({ efforts: [{ id: 'OFF' }, { id: 'low' }] }, 'lowest')).toBe('low')
  })

  it('no non-disabled tiers (empty, undefined, all off/none) materialise nothing', () => {
    expect(resolveSemanticEffort({ efforts: [] }, 'mid')).toBe('')
    expect(resolveSemanticEffort(undefined, 'mid')).toBe('')
    expect(resolveSemanticEffort({ efforts: [{ id: 'off' }, { id: 'none' }] }, 'top')).toBe('')
  })
})

describe('KB family-scored derivation (Z3, ADR 0016 d2/d3)', () => {
  const kb = {
    'qwen3.8-27b': { aliases: ['Qwen3.8-27B'], dims: { overall: 0.20, coding: 0.20, webdev: 0.15, agentic: 0.25 } },
    'deepseek-v4.1-flash': { aliases: ['DeepSeek-V4.1-Flash'], dims: { overall: 0.90, coding: 0.95, webdev: 0.85, agentic: 0.92 } },
    'qwen3.8-flash': { aliases: ['Qwen3.8-Flash'], dims: { overall: 0.30, coding: 0.35, webdev: 0.40, agentic: 0.30 } },
    'qwen3.8-flash-next': { aliases: ['Qwen3.8-Flash-Next'], dims: { overall: 0.50, coding: 0.55, webdev: 0.60, agentic: 0.50 } },
    'coding-specialist': { aliases: [], dims: { overall: 0.60, coding: 0.90, webdev: 0.20, agentic: 0.40 } },
    'webdev-specialist': { aliases: [], dims: { overall: 0.60, coding: 0.30, webdev: 0.95, agentic: 0.40 } },
  }
  const at = (model: string, efforts: string[] = ['off', 'low', 'medium', 'xhigh']) =>
    ({ provider: 'p', model, efforts: efforts.map(id => ({ id })) })

  it("the user's counterexample: deepseek-v4.1-flash outranks Qwen3.8-27B for the S family", () => {
    const rows = deriveStarterRows([at('Qwen3.8-27B-FP8'), at('deepseek-v4.1-flash')], { kb })
    expect(rows.find(r => r.name === 'review')?.model).toBe('deepseek-v4.1-flash')
    expect(rows.find(r => r.name === 'review')?.reasoningEffort).toBe('xhigh') // top within ITS OWN ladder
  })

  it('progressive matching prefers the closer entry: Flash-Next-NVFP4 hits qwen3.8-flash-next, not the older flash', () => {
    const rows = deriveStarterRows([at('Qwen3.8-Flash-Next-NVFP4'), at('qwen3.8-flash')], { kb })
    expect(rows.find(r => r.name === 'review')?.model).toBe('Qwen3.8-Flash-Next-NVFP4')
  })

  it('missing evidence never outranks proven evidence (no renormalisation)', () => {
    // sparse: only overall 0.9; complete: coding 0.8 with every dimension present.
    const sparseKb = {
      sparse: { aliases: [], dims: { overall: 0.9 } },
      complete: { aliases: [], dims: { overall: 0.7, coding: 0.8, webdev: 0.7, agentic: 0.7 } },
    }
    const rows = deriveStarterRows([at('sparse'), at('complete')], { kb: sparseKb })
    // S weight: complete = .45*.8+.25*.7+.20*.7+.10*.7 = .765; sparse = .25*.9 + .75*.5 = .6
    expect(rows.find(r => r.name === 'review')?.model).toBe('complete')
  })

  it('unknown models are the last resort for every slot — including F (A-1)', () => {
    const rows = deriveStarterRows([at('qwen3.8-27b'), at('mystery-custom-deploy'), at('qwen3.8-flash')], { kb })
    expect(rows.find(r => r.name === 'review')?.model).toBe('qwen3.8-flash')
    expect(rows.find(r => r.name === 'test')?.model).toBe('qwen3.8-27b') // the weakest KNOWN model — never the unknown mystery
  })

  it('estimated models never win S — they only ride the B ranking (A-6)', () => {
    const estKb: import('../src/capability-scoring.js').KbTable = {
      'anchored-model': { aliases: [], dims: { overall: 0.4, coding: 0.4, webdev: 0.4, agentic: 0.4 } },
      'estimated-strong': { aliases: [], dims: { overall: 0.95, webdev: 0.95 }, estimated: true },
    }
    const rows = deriveStarterRows([at('estimated-strong'), at('anchored-model')], { kb: estKb })
    expect(rows.find(r => r.name === 'review')?.model).toBe('anchored-model')
  })

  it('families rank independently: S takes the coding specialist, B tilts toward webdev', () => {
    const rows = deriveStarterRows([at('coding-specialist'), at('webdev-specialist')], { kb })
    expect(rows.find(r => r.name === 'review')?.model).toBe('coding-specialist')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('webdev-specialist')
  })

  it('slot tie rules: S keeps the earlier candidate, F the later (list order)', () => {
    const tie = [at('qwen3.8-27b'), at('qwen3.8-27b-again', ['off', 'low', 'medium', 'xhigh'])]
    const rows = deriveStarterRows(tie, { kb }) // both resolve to the same KB entry — a full tie
    expect(rows.find(r => r.name === 'review')?.model).toBe('qwen3.8-27b')
    expect(rows.find(r => r.name === 'test')?.model).toBe('qwen3.8-27b-again')
  })

  it('overrides beat the KB on a linear /100 scale (mixed-scale snapshot, B-1)', () => {
    const rows = deriveStarterRows(
      [at('qwen3.8-27b'), at('deepseek-v4.1-flash')],
      { kb, overrides: [{ model: 'qwen3.8-27b', coding: 85, overall: 85, webdev: 85, agentic: 85, asOf: '2026-11-14' }] },
    )
    // override 0.85 across the board beats the flash entry's weighted ≈0.9x? No — 0.85 < 0.95-weighted S score.
    expect(rows.find(r => r.name === 'review')?.model).toBe('deepseek-v4.1-flash')
    const lifted = deriveStarterRows(
      [at('qwen3.8-27b'), at('deepseek-v4.1-flash')],
      { kb, overrides: [{ model: 'qwen3.8-27b', coding: 95, overall: 95, webdev: 95, agentic: 95, asOf: '2026-11-14' }] },
    )
    expect(lifted.find(r => r.name === 'review')?.model).toBe('qwen3.8-27b')
  })

  it('partial overrides cover only their dimensions; the KB fills the rest', () => {
    const rows = deriveStarterRows(
      [at('qwen3.8-27b'), at('qwen3.8-flash')],
      { kb, overrides: [{ model: 'qwen3.8-flash', coding: 90, asOf: '2026-11-14' }] },
    )
    expect(rows.find(r => r.name === 'review')?.model).toBe('qwen3.8-flash')
  })

  it('with no known candidate at all, slots fall back to list order (first / upper-median / last)', () => {
    const rows = deriveStarterRows([at('alpha'), at('beta'), at('gamma')])
    expect(rows.find(r => r.name === 'review')?.model).toBe('alpha')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('beta')
    expect(rows.find(r => r.name === 'test')?.model).toBe('gamma')
  })

  it('a sole candidate resolves every slot with materialised tiers', () => {
    const rows = deriveStarterRows([at('qwen3.8-27b')], { kb })
    expect(rows).toHaveLength(12)
    expect(rows.find(r => r.name === 'review')).toMatchObject({ model: 'qwen3.8-27b', reasoningEffort: 'xhigh' })
  })

  it('no candidates derive no rows (dormant)', () => {
    expect(deriveStarterRows([])).toEqual([])
  })
})

/** F3 (ADR 0016 3a): slot diversity — canonical-model dedup for F, outward
 *  walk for a colliding B median, each slot yielding only inside its own
 *  pool, the ≥3-distinct-models commitment gate, and the A-6 boundary.
 *  Fixture weights are exact: S = .45c+.25o+.20a+.10w, B = .40c+.30o+.20w+.10a. */
describe('slot diversity preference (F3)', () => {
  // S-scores: a .575 > b .565 > d .4775 > c .335 > e .2475.
  // B-scores: b .61 > a .56 > d .51 > c .35 > e .25.
  const kb: import('../src/capability-scoring.js').KbTable = {
    'model-a': { aliases: [], dims: { overall: 0.50, coding: 0.80, webdev: 0.30, agentic: 0.30 } },
    'model-b': { aliases: [], dims: { overall: 0.70, coding: 0.40, webdev: 0.90, agentic: 0.60 } },
    'model-c': { aliases: [], dims: { overall: 0.40, coding: 0.30, webdev: 0.40, agentic: 0.30 } },
    'model-d': { aliases: [], dims: { overall: 0.60, coding: 0.35, webdev: 0.70, agentic: 0.50 } },
    'model-e': { aliases: [], dims: { overall: 0.30, coding: 0.25, webdev: 0.20, agentic: 0.20 } },
  }
  const at = (model: string, provider = 'p'): Parameters<typeof deriveStarterRows>[0][number] =>
    ({ provider, model, efforts: ['off', 'low', 'medium', 'xhigh'].map(id => ({ id })) })
  const slotsOf = (candidates: Parameters<typeof deriveStarterRows>[0], table: import('../src/capability-scoring.js').KbTable = kb) =>
    deriveStarterRows(candidates, { kb: table })

  it('a colliding B median walks outward to the nearest different model', () => {
    // [a, b, c]: S=a; B ranks b .61 > a .56 > c .35 → median a collides with
    // S → walk to the stronger neighbour b.
    const rows = slotsOf([at('model-a'), at('model-b'), at('model-c')])
    expect(rows.find(r => r.name === 'review')?.model).toBe('model-a')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('model-b')
    expect(rows.find(r => r.name === 'test')?.model).toBe('model-c')
  })

  it('equal-distance neighbours resolve to the STRONGER side', () => {
    // Five models with d re-weighted (S .55, B .58): B ranks b .61 > d .58 >
    // a .56 > c .35 > e .25 → median a collides with S=a; d (idx1) and c
    // (idx3) sit equidistant — the stronger side wins.
    const walkKb: import('../src/capability-scoring.js').KbTable = {
      ...kb,
      'model-d': { aliases: [], dims: { overall: 0.65, coding: 0.45, webdev: 0.75, agentic: 0.55 } },
    }
    const rows = slotsOf([at('model-a'), at('model-b'), at('model-c'), at('model-d'), at('model-e')], walkKb)
    expect(rows.find(r => r.name === 'review')?.model).toBe('model-a')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('model-d')
  })

  it('two candidates: the colliding median walks (H1 coverage contract superseded the old ≥3 gate)', () => {
    // [a, b]: B ranks b > a, upper median a collides with S — with a second
    // distinct model listed, B walks to it: the user's zero-rows report
    // retired the "two candidates keep collisions" pin.
    const rows = slotsOf([at('model-a'), at('model-b')])
    expect(rows.find(r => r.name === 'review')?.model).toBe('model-a')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('model-b')
  })

  it('same model via two providers counts once for the gate — but the ≥2 gate still fires', () => {
    // [a@p1, a@p2, b]: duplicates collapse to one canonical for the distinct
    // count (2), which now meets the H1 gate — the colliding median walks to
    // b, so the second MODEL holds a family regardless of duplicate listings.
    const rows = slotsOf([at('model-a', 'p1'), at('model-a', 'p2'), at('model-b')])
    expect(rows.find(r => r.name === 'review')?.model).toBe('model-a')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('model-b')
  })

  it('F re-reduces over the canonically deduplicated pool — first listing represents a model', () => {
    // [a, c@p1, c@p2]: the two c routes are one model; F lands on the FIRST
    // listing (list order), not the duplicate that the later-tie rule picked.
    const rows = slotsOf([at('model-a'), at('model-c', 'p1'), at('model-c', 'p2')])
    const testRow = rows.find(r => r.name === 'test')!
    expect(testRow.model).toBe('model-c')
    expect(testRow.provider).toBe('p1')
  })

  it('estimated models ride B and (since H7) F coverage placement — S stays anchored-strict (A-6 governs victories)', () => {
    const estKb: import('../src/capability-scoring.js').KbTable = {
      'model-a': { aliases: [], dims: { overall: 0.50, coding: 0.80, webdev: 0.30, agentic: 0.30 } },
      'model-e1': { aliases: [], dims: { overall: 0.90, webdev: 0.95 }, estimated: true },
      'model-e2': { aliases: [], dims: { overall: 0.60, webdev: 0.50 }, estimated: true },
    }
    // B ranks e1 .71 > a .56 > e2 .53 → median a collides with S=a → walk to e1.
    const rows = deriveStarterRows([at('model-a'), at('model-e1'), at('model-e2')], { kb: estKb })
    expect(rows.find(r => r.name === 'review')?.model).toBe('model-a') // A-6: S never leaves the anchored model
    expect(rows.find(r => r.name === 'dev')?.model).toBe('model-e1')
    // H7 review ruling: the anchored-only pool cannot cover three models, so
    // F's occupancy yield crosses into the known set — the second estimated
    // model takes the weakest slot instead of stranding (this pin previously
    // asserted the collision; the reviewer's counterexample superseded it).
    expect(rows.find(r => r.name === 'test')?.model).toBe('model-e2')
  })

  it("the user's three-candidate scenario: every model holds a family (end-to-end, shipped KB)", () => {
    const rows = deriveStarterRows([
      { provider: 'strata', model: 'Qwen3.8-Flash-Next-NVFP4', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'xhigh' }] },
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] },
      { provider: 'deepseek-official', model: 'deepseek-flash', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'max' }] },
    ])
    // The audit's acceptance: the review family flips onto the official
    // deepseek route (curated stem, .5582 S-score tops the all-estimated pool)
    // and all three candidates hold at least one family.
    expect(rows.find(r => r.name === 'review')).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    const providers = new Set(rows.map(row => row.provider))
    expect(providers.size).toBe(3)
  })
})

describe('F-slot occupancy yield (G1, ADR 0016 3c)', () => {
  // p/q/r crafted so S-order is p .5525 > r .5465 > q .49 (argmin = q) while
  // B-order is r .588 > q .54 > p .525 (median = q, no B-walk) — today F takes
  // q again and r holds nothing; the fix yields F to the unoccupied r.
  const kb: import('../src/capability-scoring.js').KbTable = {
    'model-p': { aliases: [], dims: { overall: 0.35, coding: 0.90, webdev: 0.20, agentic: 0.20 } },
    'model-q': { aliases: [], dims: { overall: 0.75, coding: 0.25, webdev: 0.80, agentic: 0.55 } },
    'model-r': { aliases: [], dims: { overall: 0.65, coding: 0.42, webdev: 0.85, agentic: 0.55 } },
  }
  const at = (model: string, provider = 'p', efforts = ['off', 'low', 'medium', 'xhigh']): Parameters<typeof deriveStarterRows>[0][number] =>
    ({ provider, model, efforts: efforts.map(id => ({ id })) })

  it('F colliding with the B median yields to the unoccupied model', () => {
    const rows = deriveStarterRows([at('model-p', 'p1'), at('model-q', 'p2'), at('model-r', 'p3')], { kb })
    expect(rows.find(r => r.name === 'review')?.model).toBe('model-p')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('model-q')
    expect(rows.find(r => r.name === 'test')?.model).toBe('model-r') // was model-q — r held zero rows
  })

  it("the user's scenario B: v4-pro in, all three models hold a family (end-to-end, shipped KB)", () => {
    const rows = deriveStarterRows([
      { provider: 'strata', model: 'Qwen3.8-Flash-Next-NVFP4', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'xhigh' }] },
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'max' }] },
    ])
    // 2026-11-22 snapshot: v4-pro and 27b carry real coding anchors, fn stays
    // estimated — strict scores rule among the anchored pool (v4-pro .7363 >
    // 27b .7112 ≫ fn .4889; the noise band no longer binds this trio; fn
    // never wins S while an anchored candidate exists). Coverage: F = fn.
    expect(rows.find(r => r.name === 'review')?.model).toBe('deepseek-v4-pro')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('Qwen3.8-27B-FP8')
    expect(rows.find(r => r.name === 'test')?.model).toBe('Qwen3.8-Flash-Next-NVFP4')
    expect(new Set(rows.map(row => row.provider)).size).toBe(3)
  })

  it('Zb boundary at three canonicals: the demoted duplicate holds ZERO rows (occupancy beats the dividend)', () => {
    const zkb: import('../src/capability-scoring.js').KbTable = {
      'model-x': { aliases: [], dims: { overall: 0.50, coding: 0.80, webdev: 0.30, agentic: 0.30 } },
      'model-y': { aliases: [], dims: { overall: 0.60, coding: 0.40, webdev: 0.60, agentic: 0.40 } },
      'model-z': { aliases: [], dims: { overall: 0.40, coding: 0.30, webdev: 0.40, agentic: 0.30 } },
    }
    const overrides = [{ provider: 'backup', model: 'model-x', overall: 20, coding: 20, webdev: 20, agentic: 20, asOf: '2026-11-15' }]
    const rows = deriveStarterRows(
      [at('model-x', 'official'), at('model-x', 'backup'), at('model-y', 'sz'), at('model-z', 'hh')],
      { kb: zkb, overrides },
    )
    // S=official/x, B median=y; the demoted backup/x wins the strict argmin
    // but shares x's canonical with S → at ≥3 distinct canonicals F yields
    // to the unoccupied z — the Z10 dividend survives only at 2 canonicals.
    expect(rows.find(r => r.name === 'review')?.provider).toBe('official')
    expect(rows.find(r => r.name === 'dev')?.model).toBe('model-y')
    expect(rows.find(r => r.name === 'test')?.model).toBe('model-z')
    expect(rows.some(row => row.provider === 'backup')).toBe(false)
  })

  it('two candidates: F keeps the argmin (pigeonhole — S and B already cover both models)', () => {
    const rows = deriveStarterRows([at('model-p', 'p1'), at('model-q', 'p2')], { kb })
    expect(rows.find(r => r.name === 'review')?.model).toBe('model-p')
    expect(rows.find(r => r.name === 'test')?.model).toBe('model-q')
  })
})

describe('S-slot noise band, list order first (G2, ADR 0016 3c — user ruling)', () => {
  // Sub-band (non-zero) S-score differences are rank-fraction noise between
  // same-snapshot entries; the user's listing order decides. EXACT ties keep
  // the Z7 structural chain (a genuine tie is not noise).
  const kb = (a: number, b: number, c: number): import('../src/capability-scoring.js').KbTable => ({
    'model-low': { aliases: [], dims: { overall: a, coding: a, webdev: a, agentic: a } },
    'model-mid': { aliases: [], dims: { overall: b, coding: b, webdev: b, agentic: b } },
    'model-high': { aliases: [], dims: { overall: c, coding: c, webdev: c, agentic: c } },
  })
  const at = (model: string, provider = 'p'): Parameters<typeof deriveStarterRows>[0][number] =>
    ({ provider, model, efforts: ['off', 'low', 'medium', 'xhigh'].map(id => ({ id })) })

  it('a later-listed model beating the first by 0.006 does NOT steal S', () => {
    // .4905 vs .4965 — the user's scenario-B margin: noise, list order wins.
    const rows = deriveStarterRows([at('model-low', 'p1'), at('model-high', 'p2')], { kb: kb(0.4905, 0.5, 0.4965) })
    expect(rows.find(r => r.name === 'review')?.provider).toBe('p1')
  })

  it('outside the band strict scores decide regardless of order', () => {
    const rows = deriveStarterRows([at('model-low', 'p1'), at('model-high', 'p2')], { kb: kb(0.48, 0.5, 0.53) })
    expect(rows.find(r => r.name === 'review')?.provider).toBe('p2')
  })

  it('non-transitivity is real and documented: the winner is order-dependent inside a 2×band spread', () => {
    // .50 / .515 / .53 — pairwise gaps all sub-band except low↔high (.03).
    // Whichever model is listed FIRST accumulates as `best` and later
    // sub-band challengers never displace it; the strict winner (.53) only
    // wins when it leads the list. Recorded as intended semantics.
    const scores = { a: 0.50, b: 0.515, c: 0.53 }
    const firstKeeps = deriveStarterRows([at('model-mid', 'p1'), at('model-high', 'p2'), at('model-low', 'p3')], { kb: kb(scores.a, scores.b, scores.c) })
    expect(firstKeeps.find(r => r.name === 'review')?.provider).toBe('p1') // .515 listed first keeps S
    const leaderKeeps = deriveStarterRows([at('model-high', 'p1'), at('model-mid', 'p2'), at('model-low', 'p3')], { kb: kb(scores.a, scores.b, scores.c) })
    expect(leaderKeeps.find(r => r.name === 'review')?.provider).toBe('p1') // .53 listed first keeps S
  })

  it("the user's scenario B final state (2026-11-22): S=v4-pro (strict), B=27b, F=flash-next", () => {
    const rows = deriveStarterRows([
      { provider: 'strata', model: 'Qwen3.8-Flash-Next-NVFP4', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'xhigh' }] },
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'max' }] },
    ])
    expect(rows.find(r => r.name === 'review')).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
    expect(rows.find(r => r.name === 'dev')?.provider).toBe('sz')
    expect(rows.find(r => r.name === 'test')?.provider).toBe('strata')
    expect(new Set(rows.map(row => row.provider)).size).toBe(3)
  })
})

describe('sibling route splitting — same model, several providers (G4, ADR 0016 3c)', () => {
  const at = (provider: string, model: string, efforts: string[] = ['off', 'low', 'medium', 'xhigh']): Parameters<typeof deriveStarterRows>[0][number] =>
    ({ provider, model, efforts: efforts.map(id => ({ id })) })
  const providersOf = (rows: Parameters<typeof deriveStarterRows>[0], slotKeywords: string[], options?: Parameters<typeof deriveStarterRows>[1]): string[] =>
    slotKeywords.map(keyword => deriveStarterRows(rows, options).find(r => r.name === keyword)!.provider)

  it('one model through two providers alternates per row: 6+6 equal weight over 12 rows', () => {
    const rows = deriveStarterRows([at('sz', 'model-x1'), at('hh', 'model-x1')])
    expect(providersOf([at('sz', 'model-x1'), at('hh', 'model-x1')], ['review', 'audit', 'verif', 'plan'])).toEqual(['sz', 'hh', 'sz', 'hh'])
    expect(rows.filter(r => r.provider === 'sz')).toHaveLength(6)
    expect(rows.filter(r => r.provider === 'hh')).toHaveLength(6)
    // F's winner is the LATER listing (the all-unknown fallback keeps last) —
    // winner-leads rotation puts hh on the family's first row.
    expect(rows.find(r => r.name === 'test')?.provider).toBe('hh')
    expect(rows.find(r => r.name === 'qa')?.provider).toBe('sz')
  })

  it('each row materialises effort on ITS OWN route ladder', () => {
    const rows = deriveStarterRows([
      at('sz', 'model-x1', ['off', 'low', 'medium', 'xhigh']),
      at('hh', 'model-x1', ['low', 'high', 'max']),
    ])
    expect(rows.find(r => r.name === 'review')).toMatchObject({ provider: 'sz', reasoningEffort: 'xhigh' })
    expect(rows.find(r => r.name === 'audit')).toMatchObject({ provider: 'hh', reasoningEffort: 'max' }) // top of hh's ladder
  })

  it('three entrances rotate round-robin; the odd extra row goes to the slot winner', () => {
    const rows = deriveStarterRows([at('p1', 'model-x1'), at('p2', 'model-x1'), at('p3', 'model-x1')])
    // S winner is the first listing; the rotation then follows list order.
    expect(providersOf([at('p1', 'model-x1'), at('p2', 'model-x1'), at('p3', 'model-x1')], ['review', 'audit', 'verif', 'plan'])).toEqual(['p1', 'p2', 'p3', 'p1'])
    // B's winner is the median (p2) — winner leads, then list order.
    expect(rows.filter(r => r.name === 'research' || r.name === 'dev' || r.name === 'build' || r.name === 'execute' || r.name === 'write' || r.name === 'design').map(r => r.provider)).toEqual(['p2', 'p1', 'p3', 'p2', 'p1', 'p3'])
  })

  it("dual 27B entrances plus flash-next and v4-pro: the B family splits 3+3 (end-to-end, shipped KB)", () => {
    const rows = deriveStarterRows([
      { provider: 'strata', model: 'Qwen3.8-Flash-Next-NVFP4', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'xhigh' }] },
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'xhigh' }] },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', efforts: [{ id: 'off' }, { id: 'medium' }, { id: 'max' }] },
    ])
    expect(rows.find(r => r.name === 'review')?.provider).toBe('deepseek-official') // S: v4-pro strict (2026-11-22 anchors)
    expect(rows.find(r => r.name === 'test')?.provider).toBe('strata') // F: the weakest, flash-next
    const bProviders = rows.filter(r => ['research', 'dev', 'build', 'execute', 'write', 'design'].includes(r.name)).map(r => r.provider)
    // 2026-11-22 snapshot: the B winner is the sz entrance (winner leads the
    // rotation), alternating with hh: 3+3 equal weight.
    expect(bProviders).toEqual(['sz', 'hh', 'sz', 'hh', 'sz', 'hh'])
  })

  it('a provider-qualified override breaks interchangeability: deliberately differentiated routes never split (Z10)', () => {
    const zkb: import('../src/capability-scoring.js').KbTable = {
      'model-x': { aliases: [], dims: { overall: 0.50, coding: 0.80, webdev: 0.30, agentic: 0.30 } },
      'model-y': { aliases: [], dims: { overall: 0.60, coding: 0.40, webdev: 0.60, agentic: 0.40 } },
    }
    const overrides = [{ provider: 'backup', model: 'model-x', overall: 20, coding: 20, webdev: 20, agentic: 20, asOf: '2026-11-15' }]
    const rows = deriveStarterRows(
      [at('official', 'model-x'), at('backup', 'model-x'), at('sz', 'model-y')],
      { kb: zkb, overrides },
    )
    // S=official/x wins outright; the demoted backup is a DIFFERENT scoring
    // unit (not a sibling) — the S family stays on official alone.
    expect(providersOf([at('official', 'model-x'), at('backup', 'model-x'), at('sz', 'model-y')], ['review', 'audit', 'verif', 'plan'], { kb: zkb, overrides })).toEqual(['official', 'official', 'official', 'official'])
  })
})

describe('coverage contract at two candidates (H1, ADR 0016 3d — the user report)', () => {
  // 27b S .4800 / B .5272; flash-next S .4905 / B .5431; gap .0105 < band →
  // first-listed takes S in EITHER order; the coverage contract then forces
  // B off S's model so the second model never drops to zero rows.
  const mk = (provider: string, model: string, efforts: string[]): Parameters<typeof deriveStarterRows>[0][number] =>
    ({ provider, model, efforts: efforts.map(id => ({ id })) })
  const flash = (provider: string) => mk(provider, 'Qwen3.8-Flash-Next-NVFP4', ['off', 'medium', 'xhigh'])
  const q27 = (provider: string) => mk(provider, 'Qwen3.8-27B-FP8', ['off', 'low', 'high'])

  it('27B listed FIRST still leaves flash-next a family (the reported zero-rows regression)', () => {
    const rows = deriveStarterRows([q27('hh'), flash('strata')])
    expect(rows.find(r => r.name === 'review')?.provider).toBe('hh') // band: first-listed keeps S
    expect(rows.find(r => r.name === 'dev')?.provider).toBe('strata') // B walks off the collision
    expect(rows.find(r => r.name === 'test')?.provider).toBe('hh') // F: pigeonhole at 2 models
    expect(new Set(rows.map(r => r.provider))).toEqual(new Set(['hh', 'strata']))
  })

  it('flash-next listed first: strict scores put 27B on S either way (order-symmetric)', () => {
    const rows = deriveStarterRows([flash('strata'), q27('hh')])
    expect(rows.find(r => r.name === 'review')?.provider).toBe('hh')
    expect(rows.find(r => r.name === 'dev')?.provider).toBe('strata')
    expect(new Set(rows.map(r => r.provider))).toEqual(new Set(['hh', 'strata']))
  })

  it('the 27B + v4-pro pair: strict scores give S to v4-pro (.0251 gap > band)', () => {
    const rows = deriveStarterRows([q27('hh'), mk('deepseek-official', 'deepseek-v4-pro', ['off', 'medium', 'max'])])
    expect(rows.find(r => r.name === 'review')?.provider).toBe('deepseek-official')
    expect(rows.find(r => r.name === 'dev')?.provider).toBe('hh')
    expect(rows.find(r => r.name === 'test')?.provider).toBe('hh')
  })

  it('same model through two providers keeps splitting (not a coverage case)', () => {
    const rows = deriveStarterRows([q27('hh'), mk('sz', 'Qwen3.8-27B-FP8', ['off', 'medium', 'xhigh'])])
    expect(new Set(rows.map(r => r.provider))).toEqual(new Set(['hh', 'sz'])) // G4 sibling split, 6+6
  })
})

describe('coverage across the A-6 pool boundary (H7 review, ADR 0016 3d)', () => {
  const mk = (provider: string, model: string): Parameters<typeof deriveStarterRows>[0][number] =>
    ({ provider, model, efforts: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'xhigh' }] })

  it('one anchored + two estimated covers ALL THREE (the reviewer counterexample, every ordering)', () => {
    // 2026-11-22 snapshot: 27b/v4-pro gained anchors — the estimated pair is
    // now flash-next + deepseek-v4-flash-high. A-6 keeps S on the sole
    // anchored model; F's coverage yield crosses the anchored-only pool.
    for (const list of [
      [mk('p1', 'gpt-5 (high)'), mk('hh', 'Qwen3.8-Flash-Next-NVFP4'), mk('ds', 'deepseek-v4-flash-high')],
      [mk('hh', 'Qwen3.8-Flash-Next-NVFP4'), mk('p1', 'gpt-5 (high)'), mk('ds', 'deepseek-v4-flash-high')],
      [mk('ds', 'deepseek-v4-flash-high'), mk('hh', 'Qwen3.8-Flash-Next-NVFP4'), mk('p1', 'gpt-5 (high)')],
    ]) {
      const rows = deriveStarterRows(list)
      const holders = new Set(rows.map(row => `${row.provider}/${row.model}`))
      expect(holders.size, `${[...holders].join(',')}`).toBe(3)
      expect(rows.find(r => r.name === 'review')?.model).toBe('gpt-5 (high)') // A-6: S stays anchored-strict
    }
  })

  it('two anchored + one estimated: estimated never steals S; coverage hands it F', () => {
    // 2026-11-22 snapshot: gpt-5-medium (.7042) outranks gpt-5 (high)
    // (.6757) — S goes to the stronger anchored model regardless of listing.
    const rows = deriveStarterRows([mk('p1', 'gpt-5 (high)'), mk('p2', 'gpt-5-medium'), mk('hh', 'Qwen3.8-Flash-Next-NVFP4')])
    expect(rows.find(r => r.name === 'review')?.model).toBe('gpt-5-medium')
    const holders = new Set(rows.map(row => row.model))
    expect(holders.size).toBe(3)
  })
})

describe('resolveNameMapDefaults (X2, ADR 0014 d2 migration rule)', () => {
  it('absent field: empty stored map → defaults on; non-empty → custom', () => {
    expect(resolveNameMapDefaults(undefined, 0)).toBe(true)
    expect(resolveNameMapDefaults(undefined, 3)).toBe(false)
  })

  it('explicit values are preserved regardless of stored rows', () => {
    expect(resolveNameMapDefaults(true, 5)).toBe(true)
    expect(resolveNameMapDefaults(false, 0)).toBe(false)
  })
})

describe('nameMapDefaults validation (X3, ADR 0014 d2)', () => {
  it('advises (non-blocking) when defaults-on ignores stored rows (S7 reclassification)', () => {
    const report = validateStrategyConfig({
      ...base,
      strategy: 'round-robin',
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: [nm('dev', sz)],
      nameMapDefaults: true,
    } as Parameters<typeof validateStrategyConfig>[0])
    expect(report.advisory.some(m => m.includes('nameMapDefaults'))).toBe(true)
    expect(report.degraded).toEqual([]) // no longer blocks the page save
  })

  it('no warning for defaults-off with rows, or defaults-on with none', () => {
    const custom = validateStrategyConfig({
      ...base, strategy: 'round-robin',
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: [nm('dev', sz)], nameMapDefaults: false,
    } as Parameters<typeof validateStrategyConfig>[0])
    expect(custom.degraded.some(m => m.includes('nameMapDefaults'))).toBe(false)
    const fresh = validateStrategyConfig({ ...base, strategy: 'round-robin', nameMap: [], nameMapDefaults: true } as Parameters<typeof validateStrategyConfig>[0])
    expect(fresh.degraded.some(m => m.includes('nameMapDefaults'))).toBe(false)
  })
})

describe('slot tie chain fixes (Z7 review #1/#3)', () => {
  const kb = {
    'same-score-model': { aliases: [], dims: { overall: 0.5, coding: 0.5, webdev: 0.5, agentic: 0.5 } },
  }
  const twin = (model: string, efforts: string[]) => ({ provider: 'p', model, efforts: efforts.map(id => ({ id })) })

  it('S keeps the structurally STRONGER candidate when family scores tie (one KB entry, two ladders)', () => {
    // Both candidates resolve to the same KB entry → equal family scores; the
    // richer ladder must win S, regardless of list order.
    const richer = twin('same-score-model', ['off', 'low', 'medium', 'xhigh'])
    const leaner = twin('same-score-model', ['off', 'low'])
    expect(deriveStarterRows([leaner, richer], { kb }).find(r => r.name === 'review')?.reasoningEffort).toBe('xhigh')
    expect(deriveStarterRows([richer, leaner], { kb }).find(r => r.name === 'review')?.reasoningEffort).toBe('xhigh')
  })

  it('F keeps the structurally WEAKER candidate when family scores tie', () => {
    const richer = twin('same-score-model', ['off', 'low', 'medium', 'xhigh'])
    const leaner = twin('same-score-model', ['off', 'low'])
    expect(deriveStarterRows([richer, leaner], { kb }).find(r => r.name === 'test')?.reasoningEffort).toBe('low')
    expect(deriveStarterRows([leaner, richer], { kb }).find(r => r.name === 'test')?.reasoningEffort).toBe('low')
  })

  it('F yields to a fast-named candidate before the list-order tie rule', () => {
    const fast = { provider: 'p', model: 'same-score-model', efforts: [{ id: 'off' }, { id: 'low' }], description: 'Fast and cheap for routine tasks.' }
    const plain = { provider: 'p', model: 'same-score-model', efforts: [{ id: 'off' }, { id: 'low' }] }
    expect(deriveStarterRows([plain, fast], { kb }).find(r => r.name === 'test')?.provider).toBe('p')
    expect(deriveStarterRows([fast, plain], { kb }).find(r => r.name === 'test')?.provider).toBe('p')
  })
})

describe('override runtime tolerance (Z7 review #2)', () => {
  it('duplicate model rows resolve last-wins and the validator warns', async () => {
    const kb = { 'dup-model': { aliases: [], dims: { overall: 0.5, coding: 0.5, webdev: 0.5, agentic: 0.5 } } }
    const { validateStrategyConfig } = await import('../src/strategy.js')
    const report = validateStrategyConfig({
      provider: '', model: '', strategy: 'round-robin', priority: [], respectExplicit: false, cooldownMs: 0,
      fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
      nameMap: [], nameMapDefaults: true,
      capabilityOverrides: [
        { model: 'dup-model', coding: 50, asOf: '2026-11-13' },
        { model: 'dup-model', coding: 90, asOf: '2026-11-14' },
        { model: '', coding: 50, asOf: '2026-11-14' },
      ],
    })
    expect(report.degraded.some(message => message.includes('last row wins'))).toBe(true)
    expect(report.degraded.some(message => message.includes('without a model id'))).toBe(true)
    const { capabilityOf } = await import('../src/capability-scoring.js')
    const view = capabilityOf('dup-model', [
      { model: 'dup-model', overall: 20, coding: 20, webdev: 20, agentic: 20, asOf: '2026-11-13' },
      { model: 'dup-model', overall: 90, coding: 90, webdev: 90, agentic: 90, asOf: '2026-11-14' },
    ], kb)
    expect(view.dims.coding).toBe(0.9) // the LAST row's word
    expect(view.source).toBe('override')
  })
})

describe('provider-aware override resolution (Zb, ADR 0016 d3 Z10)', () => {
  const kb = { 'route-model': { aliases: [], dims: { overall: 0.5, coding: 0.5, webdev: 0.5, agentic: 0.5 } } }
  const at = (provider: string, model = 'route-model') =>
    ({ provider, model, efforts: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'xhigh' }] })

  it('a qualified row beats the generic row for its own route regardless of array order', async () => {
    const { capabilityOf } = await import('../src/capability-scoring.js')
    const generic = { model: 'route-model', overall: 80, coding: 80, webdev: 80, agentic: 80, asOf: '2026-11-14' }
    const qualified = { provider: 'backup', model: 'route-model', overall: 20, coding: 20, webdev: 20, agentic: 20, asOf: '2026-11-14' }
    // qualified FIRST — a single-pass last-wins loop would let the later generic row win.
    const view = capabilityOf('route-model', [qualified, generic], kb, 'backup')
    expect(view.dims.coding).toBe(0.2)
    expect(view.source).toBe('override')
  })

  it('a qualified row does not spill onto other providers of the same model (they fall back to generic)', async () => {
    const { capabilityOf } = await import('../src/capability-scoring.js')
    const generic = { model: 'route-model', overall: 80, coding: 80, webdev: 80, agentic: 80, asOf: '2026-11-14' }
    const qualified = { provider: 'backup', model: 'route-model', overall: 20, coding: 20, webdev: 20, agentic: 20, asOf: '2026-11-14' }
    const official = capabilityOf('route-model', [generic, qualified], kb, 'official')
    expect(official.dims.coding).toBe(0.8)
    const backup = capabilityOf('route-model', [generic, qualified], kb, 'backup')
    expect(backup.dims.coding).toBe(0.2)
  })

  it('a qualified row replaces the route wholesale: missing dimensions fill from the KB, not the generic row', async () => {
    const { capabilityOf } = await import('../src/capability-scoring.js')
    const generic = { model: 'route-model', overall: 90, coding: 90, webdev: 90, agentic: 90, asOf: '2026-11-14' }
    const qualified = { provider: 'backup', model: 'route-model', coding: 30, asOf: '2026-11-14' } // partial dims
    const view = capabilityOf('route-model', [generic, qualified], kb, 'backup')
    expect(view.dims.coding).toBe(0.3)
    expect(view.dims.overall).toBe(0.5) // KB median fill — NOT the generic row's 0.9
  })

  it('integration dividend: two routes of one model diverge in the derived table (one keeps S, the other drops)', async () => {
    const generic = { model: 'route-model', overall: 80, coding: 80, webdev: 80, agentic: 80, asOf: '2026-11-14' }
    const demoted = { provider: 'backup', model: 'route-model', overall: 20, coding: 20, webdev: 20, agentic: 20, asOf: '2026-11-14' }
    const rows = deriveStarterRows(
      [at('official'), at('backup'), at('other', 'other-model')],
      { kb, overrides: [generic, demoted] },
    )
    // The official route stays the S winner; the demoted backup route falls to F.
    expect(rows.find(r => r.name === 'review')?.provider).toBe('official')
    expect(rows.find(r => r.name === 'test')?.provider).toBe('backup')
  })

  it('whitespace and empty provider strings normalise to generic', async () => {
    const { capabilityOf } = await import('../src/capability-scoring.js')
    const row = { model: 'route-model', provider: '  ', coding: 70, asOf: '2026-11-14' }
    const view = capabilityOf('route-model', [row], kb, 'official')
    expect(view.dims.coding).toBe(0.7)
  })
})

describe('B-slot unknown last-resort (S3, audit Y-1)', () => {
  it('with one known and one unknown candidate, the B family stays on the KNOWN model', () => {
    const kb = { 'known-model': { aliases: [], dims: { overall: 0.6, coding: 0.6, webdev: 0.6, agentic: 0.6 } } }
    const known = { provider: 'p', model: 'known-model', efforts: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'xhigh' }] }
    const unknown = { provider: 'p', model: 'mystery-relay', efforts: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'xhigh' }] }
    for (const order of [[known, unknown], [unknown, known]]) {
      const rows = deriveStarterRows(order, { kb })
      expect(rows.find(r => r.name === 'review')?.model, 'S').toBe('known-model')
      expect(rows.find(r => r.name === 'dev')?.model, 'B').toBe('known-model') // NOT the unknown
      expect(rows.find(r => r.name === 'test')?.model, 'F').toBe('known-model') // weakest known
    }
  })
})
