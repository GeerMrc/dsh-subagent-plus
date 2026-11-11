import { describe, expect, it } from 'vitest'
import { listRowStyle, nameMapRowStyle } from '../../src/client/settings-styles.js'

/** The mapping row carries five children (chip, name input, route select,
 *  effort select, remove) — a three-track grid sends the fourth and fifth to
 *  an implicit second row (the 2026-11-12 wrap bug). The dedicated style must
 *  declare exactly five tracks and keep the candidate-row geometry. */
describe('nameMapRowStyle (five-track single line, ADR 0007 decision 7)', () => {
  it('declares exactly five grid tracks', () => {
    const tracks = String(nameMapRowStyle.gridTemplateColumns).trim().split(/\s+/)
    expect(tracks).toHaveLength(5)
    expect(tracks[0]).toBe('auto')
    expect(tracks[1]).toBe('auto')
    expect(tracks[2]).toBe('minmax(0,1fr)')
    expect(tracks[3]).toBe('auto')
    expect(tracks[4]).toBe('auto')
  })

  it('keeps the candidate-row geometry (gap, padding, radius, display)', () => {
    expect(nameMapRowStyle.display).toBe(listRowStyle.display)
    expect(nameMapRowStyle.gap).toBe(listRowStyle.gap)
    expect(nameMapRowStyle.padding).toBe(listRowStyle.padding)
    expect(nameMapRowStyle.borderRadius).toBe(listRowStyle.borderRadius)
    expect(nameMapRowStyle.alignItems).toBe('center')
  })
})
