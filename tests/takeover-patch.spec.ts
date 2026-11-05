import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** T1 takeover patch discipline (v0.3.0 plan). The bundle layer must disable
 *  exactly the official subagent settings-page row (`ui-settings-subagent`, a
 *  pure edit surface) and must never touch the rows whose absence breaks the
 *  shipped composition: the model-selection settings service (hard dependency
 *  of every web preset's `modelSelectionSettings: true`), the subagent
 *  runtime (spawn-time limits owner), and the delegation tool itself. A wrong
 *  id here bricks the subagent tool silently; a missing row here leaves the
 *  confusing dual settings surface the takeover exists to remove. */
describe('takeover patch (T1)', () => {
  const patch = readFileSync('cordis.patch.yml', 'utf8')

  it('disables the official subagent settings page row', () => {
    expect(patch).toMatch(/^- id: ui-settings-subagent\s*\n\s*disabled: true\s*$/m)
  })

  it.each([
    ['subagent-model-selection-settings', 'settings service every web preset hard-depends on'],
    ['subagent', 'subagent runtime owning spawn-time limits'],
    ['tool-subagent', 'the delegation tool itself'],
  ])('never disables the %s row (%s)', (id) => {
    expect(patch).not.toMatch(new RegExp(`^- id: ${id}\\s*$`, 'm'))
  })

  it('still inserts exactly the plugin row', () => {
    expect(patch).toContain('id: dsh-subagent-plus')
    expect(patch).toContain('name: dsh-subagent-plus')
  })
})
