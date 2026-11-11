import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The client half runs inside the desktop's client-modules loader, whose
 *  module table carries only client-platform packages. `src/config.js` imports
 *  `@deepseek-ai/schemastery` (a build-time host external), so a VALUE import
 *  of config.js from client code drags that require into the client bundle and
 *  bricks web boot (2026-11-11 desktop crash, v0.0.4 test tarball). Type-only
 *  imports are erased at build time and stay safe. */
describe('client/host module boundary (crash 2026-11-11 guard)', () => {
  const clientDir = join(process.cwd(), 'src', 'client')
  const files = readdirSync(clientDir).filter(file => file.endsWith('.ts') || file.endsWith('.tsx'))

  it('client sources never value-import host-only modules (config.js carries schemastery)', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(join(clientDir, file), 'utf8')
      for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(\.\.\/config\.js)'/g)) {
        const isTypeOnly = match[1] === 'type '
        const clause = match[2]
        const everySpecifierIsType = clause.split(',').every(specifier =>
          specifier.trim() === '' || specifier.trim().startsWith('type '))
        if (!isTypeOnly && !everySpecifierIsType) offenders.push(`${file}: ${match[0]}`)
      }
      for (const match of source.matchAll(/from\s+'(@deepseek-ai\/schemastery)'/g)) {
        offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the built client bundle carries no schemastery require', () => {
    const bundle = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8')
    expect(bundle.includes('schemastery')).toBe(false)
  })
})
