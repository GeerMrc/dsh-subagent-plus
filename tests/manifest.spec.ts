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

  it('keeps the version in lockstep with the CHANGELOG top entry', () => {
    const changelog = readFileSync('CHANGELOG.md', 'utf8')
    const topEntry = changelog.match(/^## v(\d+\.\d+\.\d+[^\s(]*)/m)
    expect(topEntry, 'CHANGELOG must open with a "## v<x.y.z>" entry').not.toBeNull()
    expect(pkg.version).toBe(topEntry?.[1])
  })

  it('stays on the 0.0.x release line above 0.0.2 (ADR 0004)', () => {
    // The npm 0.3.0 package is an orphaned accidental publish (2026-10-28),
    // not part of this product line; releases continue 0.0.2 -> 0.0.3 -> …
    // and every version that ships has passed the user's real-test gate.
    expect(pkg.version).toMatch(/^0\.0\.\d+$/)
    expect(Number(pkg.version.split('.')[2])).toBeGreaterThan(2)
  })
})

/** PH2 (P2 pattern): the plugins-page detail is a named locale file — a
 *  missing named file is a HARD error upstream (no README fallback), so the
 *  contract locks path validity, file existence, and tarball inclusion. */
describe('plugin-page detail contract (PH2, P2)', () => {
  const readMeta = async (lang: string): Promise<{ meta?: { title?: unknown; description?: unknown; detail?: unknown } }> =>
    JSON.parse(await import('node:fs').then(fs => fs.readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')))

  it('zh/en meta carry title/description and a legal detail path that exists', async () => {
    for (const lang of ['zh', 'en']) {
      const { meta } = await readMeta(lang)
      expect(meta, lang).toBeDefined()
      expect(typeof meta!.title, lang).toBe('string')
      expect(typeof meta!.description, lang).toBe('string')
      const detail = meta!.detail
      expect(typeof detail, lang).toBe('string')
      // P2 path rules: '/'-separated, .md suffix, no ./.. segments, no
      // backslash, no URL scheme.
      expect(detail, lang).toMatch(/^[^/].*\.md$/)
      expect(detail, lang).not.toMatch(/(^|\/)\.{1,2}(\/|$)/)
      expect(String(detail)).not.toMatch(/[\\]/)
      expect(String(detail)).not.toMatch(/^[a-z]+:\/\//i)
      const fs = await import('node:fs')
      expect(fs.existsSync(new URL(`../${detail}`, import.meta.url)), `${lang}: ${String(detail)}`).toBe(true)
    }
  })

  it('package.json ships the locale dir and exports it', async () => {
    const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')))
    expect(pkg.files).toContain('locale')
    expect(Object.keys(pkg.exports)).toContain('./locale/*.json')
  })
})

/** P7: the npm files whitelist must ship the meta.detail docs AND must not
 *  leak internal governance docs. The sibling's incident: "files": ["docs"]
 *  shipped every ADR/fault-report to the public registry while the contract
 *  test only checked source-repo existence. These assertions pin BOTH halves
 *  statically (npm files semantics: a directory entry includes recursively;
 *  an exact file entry includes exactly). */
describe('npm files whitelist vs governance docs (P7)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] }
  /** Docs that must reach the npm consumer (product manuals the README links). */
  const SHIPPED_DOCS = ['docs/plugin-page.zh.md', 'docs/plugin-page.en.md', 'docs/settings.md', 'docs/strategy.md', 'docs/upgrade.md']
  /** Internal governance/ops docs — never in the public package. */
  const INTERNAL_DOCS = ['docs/dont-do.md', 'docs/e2e-manual.md', 'docs/release-runbook.md', 'docs/upstream-feedback-llm-deepseek-id-split.md']
  const covers = (entry: string, path: string): boolean => path === entry || path.startsWith(`${entry}/`)

  it('ships every meta.detail target and product manual as an exact files entry', async () => {
    for (const doc of SHIPPED_DOCS) {
      expect(pkg.files, doc).toContain(doc)
      expect(readFileSync(doc, 'utf8').length, doc).toBeGreaterThan(0)
    }
  })

  it('never whitelists the bare docs/ directory — governance ships file-by-file only', () => {
    expect(pkg.files, 'a bare "docs" entry recursively ships every ADR and lesson doc to npm').not.toContain('docs')
    expect(pkg.files).not.toContain('docs/')
  })

  it('no whitelist entry reaches an internal governance doc', () => {
    const internal = [...INTERNAL_DOCS.map(doc => [doc] as const), ['docs/decisions/', 'docs/decisions/2026-10-29-takeover-surface.md'] as const]
    for (const [internalPath] of internal) {
      const leaking = pkg.files.filter(entry => covers(entry, internalPath))
      expect(leaking, `${internalPath} would ship via ${leaking.join(', ')}`).toEqual([])
    }
  })
})
