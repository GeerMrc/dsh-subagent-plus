import { describe, expect, it } from 'vitest'
import { listRowStyle, nameMapRowStyle } from '../../src/client/settings-styles.js'

/** The mapping row carries four children (chip-with-remove, name input,
 *  route select, effort select) — the delete action moved onto the index chip
 *  hover (ADR 0015 d3, superseding 0007 d7's five tracks), so the trailing
 *  track disappears and the flexible route track widens. */
describe('nameMapRowStyle (four-track single line, ADR 0015 decision 3)', () => {
  it('declares exactly four grid tracks', () => {
    const tracks = String(nameMapRowStyle.gridTemplateColumns).trim().split(/\s+/)
    expect(tracks).toHaveLength(4)
    expect(tracks[0]).toBe('auto')
    expect(tracks[1]).toBe('auto')
    expect(tracks[2]).toBe('minmax(0,1fr)')
    expect(tracks[3]).toBe('auto')
  })

  it('keeps the candidate-row geometry (gap, padding, radius, display)', () => {
    expect(nameMapRowStyle.display).toBe(listRowStyle.display)
    expect(nameMapRowStyle.gap).toBe(listRowStyle.gap)
    expect(nameMapRowStyle.padding).toBe(listRowStyle.padding)
    expect(nameMapRowStyle.borderRadius).toBe(listRowStyle.borderRadius)
    expect(nameMapRowStyle.alignItems).toBe('center')
  })
})

describe('resetButtonStyle (plain button, no select affordance, Y-fix 2026-11-14)', () => {
  it('carries no dropdown caret background and keeps a pointer cursor', async () => {
    const { resetButtonStyle } = await import('../../src/client/settings-styles.js')
    expect(resetButtonStyle.backgroundImage).toBeUndefined()
    expect(String(resetButtonStyle.backgroundImage ?? '')).not.toContain('svg')
    expect(resetButtonStyle.cursor).toBe('pointer')
    expect(resetButtonStyle.borderStyle).not.toBe('none')
  })
})
