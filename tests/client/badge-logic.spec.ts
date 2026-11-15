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

describe('settings locale dictionaries (key parity + language guard)', () => {
  it('zh and en cover exactly the same keys', async () => {
    const { en, zh } = await import('../../src/client/locales.js')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  /** L1: a bare-key regex edit once wrote en values into the zh dictionary —
   *  key parity cannot see language displacement. Whole-dict guard: every zh
   *  value carries Han characters (allowlist: the bilingual JSON example);
   *  no en value does. */
  it('zh values carry Han, en values carry none (language-displacement guard)', async () => {
    const { en, zh } = await import('../../src/client/locales.js')
    const han = /[\u4e00-\u9fff]/
    // 'Team' is a bilingual-identical Latin product label (N1); the
    // placeholder is the bilingual JSON example.
    const allowNoHan = new Set(['byname.research.placeholder', 'byname.title'])
    for (const [key, value] of Object.entries(zh)) {
      if (allowNoHan.has(key)) continue
      expect(han.test(value), `zh[${key}] = ${String(value).slice(0, 40)}`).toBe(true)
    }
    for (const [key, value] of Object.entries(en)) {
      expect(han.test(value), `en[${key}] = ${String(value).slice(0, 40)}`).toBe(false)
    }
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

/** G3: the bench hint aggregate — candidates holding no template row are the
 *  middle failover tier and must be visible as such. */
describe('benchRouteLabelsOf (G3)', () => {
  it('lists exactly the candidates no derived row references', async () => {
    const { benchRouteLabelsOf } = await import('../../src/client/badge-logic.ts')
    const routes = [
      { provider: 'sz', model: 'model-a' },
      { provider: 'hh', model: 'model-b' },
      { provider: 'zai', model: 'model-c' },
    ]
    const rows = [
      { provider: 'sz', model: 'model-a' },
      { provider: 'hh', model: 'model-b' },
    ]
    expect(benchRouteLabelsOf(routes, rows)).toEqual(['zai/model-c'])
  })

  it('an empty bench reports nothing (hint stays hidden)', async () => {
    const { benchRouteLabelsOf } = await import('../../src/client/badge-logic.ts')
    const routes = [{ provider: 'sz', model: 'model-a' }]
    expect(benchRouteLabelsOf(routes, [{ provider: 'sz', model: 'model-a' }])).toEqual([])
  })
})

/** H4: the noise-band gap the settings hint surfaces. */
describe('sBandGapOf (H4)', () => {
  it('reports the top-two S gap when it falls inside the band (the user scenario-B shape)', async () => {
    const { sBandGapOf } = await import('../../src/client/badge-logic.ts')
    const routes = [
      { provider: 'hh', model: 'Qwen3.8-27B-FP8' },      // S .4800
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, // S .4965 — gap .0165
    ]
    const gap = sBandGapOf(routes, [])
    expect(gap).not.toBeUndefined()
    expect(gap!).toBeGreaterThan(0.01)
    expect(gap!).toBeLessThan(0.02)
  })

  it('stays silent outside the band, for single-known lists, and for unknowns', async () => {
    const { sBandGapOf } = await import('../../src/client/badge-logic.ts')
    // v4.1-flash (.5582) vs 27b (.48): gap .078 — outside.
    expect(sBandGapOf([{ provider: 'a', model: 'deepseek-flash' }, { provider: 'b', model: 'Qwen3.8-27B-FP8' }], [])).toBeUndefined()
    expect(sBandGapOf([{ provider: 'a', model: 'Qwen3.8-27B-FP8' }], [])).toBeUndefined()
    expect(sBandGapOf([{ provider: 'a', model: 'my-ft-v2' }, { provider: 'b', model: 'private-b' }], [])).toBeUndefined()
  })
})

/** O4: the shared-date dedup behind the 评分来源 panel. */
describe('sharedAsOfOf (O4)', () => {
  it('all-equal rows surface the one date; mixed and empty stay undefined', async () => {
    const { sharedAsOfOf } = await import('../../src/client/badge-logic.ts')
    const rows = [
      { model: 'a', asOf: '2026-11-15' },
      { model: 'b', asOf: '2026-11-15' },
    ]
    expect(sharedAsOfOf(rows)).toBe('2026-11-15')
    expect(sharedAsOfOf([...rows, { model: 'c', asOf: '2026-11-16' }])).toBeUndefined()
    expect(sharedAsOfOf([])).toBeUndefined()
  })
})
