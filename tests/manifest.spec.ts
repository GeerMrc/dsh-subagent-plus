import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** The plugin identity family must stay identical across every surface the
 *  dsh client loader and profile stack match on (the dsh-browser-plus
 *  manifest discipline): the bare package name, the cordis patch row's
 *  id/name, the client bundle's ModuleLoader id, and the plugin's own name
 *  export. A rename that misses any of these leaves a silently dead client
 *  half or an orphaned patch row. */
describe('plugin identity manifest (R-02)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string; files: string[]; dsh: { bundle: { patch: string } } }

  it('uses the bare product name as the package name', () => {
    expect(pkg.name).toBe('dsh-subagent-plus')
  })

  it('declares the patch in files and as a string bundle patch', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')
  })

  it('carries the identity through the cordis patch row and the cordis plugin name export', async () => {
    const patch = readFileSync('cordis.patch.yml', 'utf8')
    expect(patch).toContain('id: dsh-subagent-plus')
    expect(patch).toContain('name: dsh-subagent-plus')
    const host = await import('../src/index.js')
    expect(host.name).toBe('dsh-subagent-plus')
  })

  it('stamps the client bundle banner with the package name', () => {
    const build = readFileSync('tsdown.client.config.ts', 'utf8')
    expect(build).toContain("JSON.stringify('dsh-subagent-plus')")
  })

  it('bumped past the 0.1.x install surface (file: reinstalls skip same versions)', () => {
    expect(pkg.version).not.toMatch(/^0\.1\./)
  })
})
