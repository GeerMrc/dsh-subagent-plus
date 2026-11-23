#!/usr/bin/env node
/**
 * Release pre-flight (PH6) — release.yml runs this BEFORE the workflow
 * creates any side effect. The release chain packs, creates the GitHub
 * Release, and only then publishes; a tree that cannot publish must fail
 * here, not at `npm publish` with the release and its tag already in place.
 *
 * Checked:
 *   - the pushed tag names the version package.json carries
 *   - the package is not private (the release commit removes "private")
 *   - that version is not already on npm
 *
 * Every problem is reported, then the process exits 1. The registry check
 * fails closed: an unreachable registry stops the run. That happens before
 * any side effect, so a re-run is safe.
 *
 * @module release-preflight
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REGISTRY = 'https://registry.npmjs.com'

/**
 * Decide whether the tree a tag points at can publish.
 * @param pkg - the package manifest the tag points at.
 * @param refName - the pushed ref, e.g. `v0.0.4`.
 * @param publishedVersions - versions found on npm, or undefined when the
 *  registry could not be read.
 * @returns the problems found; empty when the tree can publish.
 */
export function preflight(pkg, refName, publishedVersions) {
  const problems = []
  const tag = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(refName)
  if (tag === null) problems.push(`ref "${refName}" is not a release tag (expected v<semver>)`)
  else if (tag[1] !== pkg.version) problems.push(`tag "${refName}" names ${tag[1]} but package.json is ${pkg.version}`)
  if (pkg.private === true) problems.push('package.json is private — remove "private" in the release commit (docs/release-runbook.md)')
  if (publishedVersions === undefined) problems.push(`could not read ${REGISTRY} to check whether ${pkg.version} is already published`)
  else if (publishedVersions.includes(pkg.version)) problems.push(`version ${pkg.version} is already published to npm`)
  return problems
}

/** Versions listed on the npm registry for one package: [] when the package
 *  was never published, undefined when the registry could not be read. */
async function publishedVersions(name) {
  try {
    const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) })
    if (response.status === 404) return []
    if (!response.ok) return undefined
    return Object.keys((await response.json()).versions ?? {})
  } catch {
    return undefined
  }
}

// Import-safe: the preflight export is pinned by tests/release-preflight.spec.ts,
// so the CLI only runs when executed as a script.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const refName = process.argv[2] ?? ''
  const problems = preflight(pkg, refName, await publishedVersions(pkg.name))
  if (problems.length > 0) {
    for (const problem of problems) console.error(`release pre-flight: ${problem}`)
    process.exit(1)
  }
  console.log(`release pre-flight: ok — ${pkg.name}@${pkg.version} (${refName})`)
}
