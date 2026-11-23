import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { preflight } from '../scripts/release-preflight.mjs'

/** PH6: release.yml runs the pre-flight BEFORE creating the GitHub Release,
 *  so a tree that cannot publish fails early instead of at `npm publish`
 *  (after the release and its tag already exist). */
describe('release pre-flight (PH6)', () => {
  const pkg = { name: 'dsh-subagent-plus', version: '0.0.4' }

  it('passes a publishable tree: matching tag, not private, version unseen on npm', () => {
    expect(preflight(pkg, 'v0.0.4', ['0.0.1', '0.0.2', '0.0.3'])).toEqual([])
  })

  it('passes a prerelease tag that names the prerelease version', () => {
    expect(preflight({ ...pkg, version: '0.0.5-rc.1' }, 'v0.0.5-rc.1', [])).toEqual([])
  })

  it('refuses a tag that names another version than package.json', () => {
    expect(preflight(pkg, 'v0.0.5', [])).toEqual([
      'tag "v0.0.5" names 0.0.5 but package.json is 0.0.4',
    ])
  })

  it('refuses a non-release ref', () => {
    expect(preflight(pkg, 'main', [])).toEqual(['ref "main" is not a release tag (expected v<semver>)'])
    expect(preflight(pkg, '', [])).toEqual(['ref "" is not a release tag (expected v<semver>)'])
  })

  it('refuses a private tree — the release commit must remove "private"', () => {
    expect(preflight({ ...pkg, private: true }, 'v0.0.4', [])).toEqual([
      'package.json is private — remove "private" in the release commit (docs/release-runbook.md)',
    ])
  })

  it('refuses a version that is already on npm', () => {
    expect(preflight(pkg, 'v0.0.4', ['0.0.3', '0.0.4'])).toEqual([
      'version 0.0.4 is already published to npm',
    ])
  })

  it('fails closed when the registry could not be read', () => {
    expect(preflight(pkg, 'v0.0.4', undefined)).toEqual([
      'could not read https://registry.npmjs.com to check whether 0.0.4 is already published',
    ])
  })

  it('reports every problem at once', () => {
    // Tag/version mismatch, private, and the package's own version already on npm.
    const problems = preflight({ ...pkg, private: true }, 'v0.0.3', ['0.0.4'])
    expect(problems).toEqual([
      'tag "v0.0.3" names 0.0.3 but package.json is 0.0.4',
      'package.json is private — remove "private" in the release commit (docs/release-runbook.md)',
      'version 0.0.4 is already published to npm',
    ])
  })

  it('rejects THIS tree while it is private — the guard is wired to the real manifest', () => {
    const real = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string; private?: boolean }
    expect(preflight(real, `v${real.version}`, []).some(problem => problem.includes('is private'))).toBe(real.private === true)
  })
})
