import { describe, expect, it } from 'vitest'
import { badgeRoute } from '../../src/client/badge-logic.ts'

const address = { mode: 'continuable' }

describe('badgeRoute', () => {
  it('renders nothing on top-level sessions', () => {
    expect(badgeRoute(null, { lastUsed: { provider: 'sz', model: 'm' } })).toBeUndefined()
    expect(badgeRoute(undefined, { lastUsed: { provider: 'sz', model: 'm' } })).toBeUndefined()
  })

  it('prefers the last-used route of a delegated session', () => {
    expect(badgeRoute(address, {
      lastUsed: { provider: 'sz', model: 'Qwen3.8-27B-FP8' },
      next: { provider: 'hh', model: 'other' },
    })).toEqual({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  })

  it('falls back to the staged next selection', () => {
    expect(badgeRoute(address, { next: { provider: 'sz', model: 'm' } })).toEqual({ provider: 'sz', model: 'm' })
  })

  it('carries the reasoning effort the request actually used', () => {
    expect(badgeRoute(address, { lastUsed: { provider: 'sz', model: 'm', reasoningEffort: 'xhigh' } }))
      .toEqual({ provider: 'sz', model: 'm', effort: 'xhigh' })
    expect(badgeRoute(address, { next: { provider: 'sz', model: 'm', reasoningEffort: 'low' } }))
      .toEqual({ provider: 'sz', model: 'm', effort: 'low' })
  })

  it('omits the effort segment when absent, empty, or not a string', () => {
    expect(badgeRoute(address, { lastUsed: { provider: 'sz', model: 'm', reasoningEffort: undefined } }))
      .toEqual({ provider: 'sz', model: 'm' })
    expect(badgeRoute(address, { lastUsed: { provider: 'sz', model: 'm', reasoningEffort: '' } }))
      .toEqual({ provider: 'sz', model: 'm' })
    expect(badgeRoute(address, { lastUsed: { provider: 'sz', model: 'm', reasoningEffort: 3 } }))
      .toEqual({ provider: 'sz', model: 'm' })
  })

  it('renders nothing without a projection or a readable route', () => {
    expect(badgeRoute(address, undefined)).toBeUndefined()
    expect(badgeRoute(address, {})).toBeUndefined()
    expect(badgeRoute(address, { lastUsed: { provider: 'sz', model: 1 } })).toBeUndefined()
    expect(badgeRoute(address, { lastUsed: null })).toBeUndefined()
  })
})

describe('settings locale dictionaries (key parity)', () => {
  it('zh and en cover exactly the same keys', async () => {
    const { en, zh } = await import('../../src/client/locales.js')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

/** F2 (ADR 0016 3a): the KB-visibility aggregate behind the candidate badge,
 *  the summary line, and the estimatedAll mutual exclusion. */
describe('kbVisibilityOf (F2)', () => {
  const rows = [
    { provider: 'sz', model: 'Qwen3.8-27B-FP8' },
    { provider: 'hh', model: 'my-ft-v2' },
    { provider: 'zai', model: 'deepseek-flash' },
  ]

  it('a mixed list reports exactly its unknown candidates and never claims estimatedAll', async () => {
    const { kbVisibilityOf } = await import('../../src/client/badge-logic.ts')
    expect(kbVisibilityOf(rows, [])).toEqual({ unknownModels: ['my-ft-v2'], estimatedAll: false })
  })

  it('all-unknown lists report every candidate and suppress estimatedAll (mutual exclusion)', async () => {
    const { kbVisibilityOf } = await import('../../src/client/badge-logic.ts')
    const all = [
      { provider: 'sz', model: 'my-ft-v2' },
      { provider: 'hh', model: 'private-b' },
    ]
    expect(kbVisibilityOf(all, [])).toEqual({ unknownModels: ['my-ft-v2', 'private-b'], estimatedAll: false })
  })

  it('all-estimated known candidates with no unknown claim estimatedAll', async () => {
    const { kbVisibilityOf } = await import('../../src/client/badge-logic.ts')
    const estimated = [
      { provider: 'hh', model: 'deepseek-flash' },
      { provider: 'zai', model: 'glm-5' },
    ]
    expect(kbVisibilityOf(estimated, [])).toEqual({ unknownModels: [], estimatedAll: true })
  })

  it('an imported override rescues its candidate out of the unknown report', async () => {
    const { kbVisibilityOf } = await import('../../src/client/badge-logic.ts')
    const rescued = kbVisibilityOf(rows, [{ model: 'my-ft-v2', coding: 70, asOf: '2026-11-14' }])
    expect(rescued.unknownModels).toEqual([])
    expect(rescued.estimatedAll).toBe(false) // Qwen3.8-27B carries the coding anchor
  })

  it('a qualified override rescues only its own provider route', async () => {
    const { kbVisibilityOf } = await import('../../src/client/badge-logic.ts')
    const rescued = kbVisibilityOf(rows, [{ provider: 'hh', model: 'my-ft-v2', coding: 70, asOf: '2026-11-14' }])
    expect(rescued.unknownModels).toEqual([])
    const partial = kbVisibilityOf([
      { provider: 'sz', model: 'my-ft-v2' },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8' },
    ], [{ provider: 'hh', model: 'my-ft-v2', coding: 70, asOf: '2026-11-14' }])
    expect(partial.unknownModels).toEqual(['my-ft-v2'])
  })
})
