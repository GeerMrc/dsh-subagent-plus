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
