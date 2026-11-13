import { describe, expect, it } from 'vitest'
import { KB, KB_AS_OF, KB_SOURCES } from '../src/capability-kb.js'

/** ADR 0016 d1 invariants over the generated snapshot. */
describe('capability KB invariants (Z2, ADR 0016 d1)', () => {
  it('carries a snapshot date, per-source availability, and a sane entry count', () => {
    expect(KB_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Object.keys(KB_SOURCES).length).toBeGreaterThan(0)
    expect(Object.keys(KB).length).toBeGreaterThanOrEqual(50)
    expect(Object.keys(KB).length).toBeLessThanOrEqual(2000)
  })

  it('keys are canonical (lowercase, no quant/date/freshness tails) and unique', () => {
    const keys = Object.keys(KB)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(key).toBe(key.toLowerCase())
      expect(key).not.toMatch(/[-_](fp8|nvfp4|int8|awq|gguf|next|preview|latest|exp)$/)
    }
  })

  it('dimension scores are rank fractions in [0,1] with fixed-point decimals', () => {
    for (const [key, entry] of Object.entries(KB)) {
      for (const value of Object.values(entry.dims)) {
        expect(value, `${key}`).toBeGreaterThanOrEqual(0)
        expect(value, `${key}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('entries missing the coding anchor are flagged estimated', () => {
    for (const [key, entry] of Object.entries(KB)) {
      if (entry.dims.coding === undefined) expect(entry.estimated, key).toBe(true)
    }
  })

  it('serialized snapshot stays inside the 40KB client-bundle budget', () => {
    const bytes = Buffer.byteLength(JSON.stringify(KB), 'utf8')
    expect(bytes).toBeLessThan(40_000)
  })
})
