import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The client half runs inside the desktop's client-modules loader, whose
 *  frozen module table carries only client-platform packages. The host-side
 *  modules `config.js` (schemastery), `settings.js`, and `index.js` (dsh-llm
 *  values) must never reach the client bundle as runtime imports — type-only
 *  imports are erased at build time and stay safe. The 2026-11-11 desktop
 *  crash (schemastery missed the module table) instantiated this class; the
 *  scan covers every import form so a regression cannot slip through a
 *  default/namespace/side-effect/dynamic/re-export spelling. */
const HOST_ONLY_TARGETS = new Set(['../config.js', '../settings.js', '../index.js'])

/** Host-only packages that must never appear in the built client bundle. */
const FORBIDDEN_BUNDLE_MARKERS = [
  'schemastery',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-api-session-controller',
]

/** Any import/export form referencing one of the targets: named, default,
 *  namespace, side-effect, dynamic import, re-export; single or double
 *  quotes. The specifier clause (when present) decides type-only safety. */
const IMPORT_PATTERN = /(?:import|export)\s+([^;]*?from\s+)?['"](\.\.\/(?:config|settings|index)\.js)['"]|import\(\s*['"](\.\.\/(?:config|settings|index)\.js)['"]\s*\)/g

function isTypeOnlyClause(clause: string | undefined): boolean {
  if (clause === undefined) return false // side-effect / dynamic form: runtime by definition
  const specifiers = clause.replace(/from\s*$/, '').split(',')
  return specifiers.every(specifier => {
    const trimmed = specifier.trim()
    return trimmed === '' || trimmed.startsWith('type ') || trimmed.startsWith('type{')
  })
}

describe('client/host module boundary (crash 2026-11-11 guard, broadened R7)', () => {
  const clientDir = join(process.cwd(), 'src', 'client')
  const files = readdirSync(clientDir).filter(file => file.endsWith('.ts') || file.endsWith('.tsx'))

  it('client sources never runtime-import the host-only modules, in any import form', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(join(clientDir, file), 'utf8')
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const target = match[2] ?? match[3] ?? ''
        if (!HOST_ONLY_TARGETS.has(target)) continue
        if (!isTypeOnlyClause(match[1])) offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the built client bundle carries none of the host-only packages', () => {
    const bundle = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8')
    const present = FORBIDDEN_BUNDLE_MARKERS.filter(marker => bundle.includes(marker))
    expect(present).toEqual([])
  })
})
