#!/usr/bin/env node
/**
 * Build the capability knowledge base (ADR 0016 d1) — a hand-run script.
 *
 * Sources (see NOTICES for licenses and attribution):
 *   - lmarena-ai/leaderboard-dataset via the HF datasets-server rows API
 *     (text/overall + text/coding, webdev, agent configs; CC-BY-4.0)
 *   - Aider-AI/aider polyglot leaderboard YAML (Apache-2.0)
 *   - Optional best-effort stages (τ-bench / Web-Bench / BigCodeBench) that
 *     no-op with a warning when the fetch or parse fails — the KB stays
 *     valid on the two core sources.
 *
 * Output: src/capability-kb.ts (GENERATED, deterministic — sorted keys and
 * fixed-point decimals so diffs stay reviewable). CI never runs this; the
 * generated file is committed.
 *
 * Dimension scores are rank fractions within each source population
 * (best = 1.0). Missing dimensions stay absent here; the consumer applies
 * the 0.5-median fill (ADR 0016 — missing evidence must not outrank proven
 * evidence). Entries missing the coding anchor carry `estimated: true`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DS = 'lmarena-ai/leaderboard-dataset'
const HF_ROWS = (config, split, offset, length) =>
  `https://datasets-server.huggingface.co/rows?dataset=${DS}&config=${config}&split=${split}&offset=${offset}&length=${length}`
const AIDER_URLS = [
  'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/leaderboards/polyglot.yml',
  'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml',
]

const sleep = ms => new Promise(r => setTimeout(r, ms))
// Inter-page throttle for the rows API (PH1): the limiter allows ~2 req/s
// sustained with a small burst (empirical: 0.35s spacing dies at page ~3,
// 1.4s spacing sustains); 1500ms keeps the ~113-page text crawl whole.
const PAGE_DELAY_MS = 1500

async function fetchWithRetry(url, tries = 5) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      if (attempt === tries) throw error
      // 429 = quota window: short linear backoff just burns the window —
      // wait it out properly (empirical: 30s of 3s-spaced retries still
      // 429; a single 20s hold clears it).
      const hold = String(error).includes('429') ? 20_000 : 3000 * attempt
      console.warn(`  retry ${attempt}/${tries - 1} after error: ${String(error)} (hold ${hold / 1000}s)`)
      await sleep(hold)
    }
  }
  throw new Error('unreachable')
}

async function fetchArena(config) {
  const rows = []
  let offset = 0
  let total = Number.POSITIVE_INFINITY
  while (offset < total) {
    // Datasets-server jobs flap under load ("temporary spike"); a config that
    // stays down is skipped by the caller so the snapshot builds partially.
    // Full pagination is request-heavy (text ≈ 112 pages of 100): throttle
    // between pages so the 429 limiter does not cut the config off (PH1 —
    // the recovered text source must land whole, not partially skipped).
    if (offset > 0) await sleep(PAGE_DELAY_MS)
    const text = await fetchWithRetry(HF_ROWS(config, 'latest', offset, 100), 5)
    const page = JSON.parse(text)
    total = page.num_rows_total ?? rows.length
    for (const { row } of page.rows ?? []) rows.push(row)
    offset += 100
    if (offset % 1000 === 0) console.log(`    …${config} ${offset}/${total}`)
  }
  return rows
}

/** Root-cause diagnosis for an empty text fetch (ADR 0016 3d, 2026-11-16):
 *  the rows API's "temporary spike" wording hid a persistent upstream failure
 *  for four days — the /parquet endpoint names the real state (the text
 *  config's config-parquet conversion FAILED upstream, no client-side path). */
async function diagnoseTextSource() {
  try {
    const text = await fetchWithRetry(`https://datasets-server.huggingface.co/parquet?dataset=${DS}`, 2)
    const page = JSON.parse(text)
    const failed = (page.failed ?? []).some(entry => entry.config === 'text')
    if (failed) {
      console.warn('  diagnosis: config-parquet conversion for "text" FAILED upstream — the rows-API spike wording is a symptom; recovery needs the upstream pipeline (no client-side path)')
    } else {
      console.warn('  diagnosis: parquet conversion for "text" looks healthy — the rows spike may be transient; retrying the build later may succeed')
    }
  } catch (error) {
    console.warn(`  diagnosis unavailable (${String(error)})`)
  }
}

async function fetchArenaOptional(config) {
  try {
    return await fetchArena(config)
  } catch (error) {
    console.warn(`  arena config "${config}" unavailable (${String(error)}) — building without it`)
    return []
  }
}

async function fetchAider() {
  for (const url of AIDER_URLS) {
    try {
      const text = await fetchWithRetry(url)
      const entries = []
      // Minimal parse of the flat leaderboard entries: `- model: X` blocks
      // with `pass_rate_2: N`.
      let current = null
      for (const line of text.split('\n')) {
        const model = /^-?\s*model:\s*(.+)$/.exec(line)
        if (model !== null) { if (current !== null) entries.push(current); current = { model: model[1].trim() } ; continue }
        const pass = /^\s*pass_rate_2:\s*([0-9.]+)\s*$/.exec(line)
        if (pass !== null && current !== null) current.pass = Number(pass[1])
      }
      if (current !== null) entries.push(current)
      const scored = entries.filter(entry => typeof entry.pass === 'number')
      if (scored.length >= 20) return scored
      console.warn(`  aider source thin (${scored.length} entries) at ${url}`)
    } catch (error) {
      console.warn(`  aider source unavailable at ${url}: ${String(error)}`)
    }
  }
  return []
}

const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models'

async function fetchOpenRouter() {
  try {
    const text = await fetchWithRetry(OR_MODELS_URL, 3)
    const page = JSON.parse(text)
    const rows = Array.isArray(page.data) ? page.data : []
    console.log(`  openrouter=${rows.length}`)
    return rows
  } catch (error) {
    console.warn(`  openrouter catalogue unavailable (${String(error)}) — building without alias cross-reference`)
    return []
  }
}

/** Build-time matcher normalization: strips EVERY separator, far more
 *  aggressive than the runtime canonicalizer (which stays conservative by
 *  design — `deepseek/deepseek-r1` is hyphenated officially while
 *  `qwen/qwen-2.5-x` is contracted, so no runtime rule can fold both). */
const squish = raw => String(raw).toLowerCase().replace(/[^a-z0-9]/g, '')

/** Cross-reference the OpenRouter catalogue against the KB entries (F4): an
 *  OR slug whose squished model part matches a KB entry's squished name gains
 *  that slug as an ALIAS — but only when the runtime canonicalizer cannot
 *  already fold it (no redundant bytes). Also collects curated-stem
 *  CANDIDATES (printed for human review, never auto-added): official bare ids
 *  named in `~`-router alias_targets or description backticks that no layer
 *  resolves — exactly how `deepseek-flash` was found. */
function crossReference(entries, orModels) {
  const bySquish = new Map()
  for (const [key, entry] of entries) {
    if (!bySquish.has(squish(key))) bySquish.set(squish(key), key)
    for (const alias of entry.aliases) {
      if (!bySquish.has(squish(alias))) bySquish.set(squish(alias), key)
    }
  }
  // Fail-loud collision check: two DISTINCT KB entries squishing identically
  // (glm-4.5 vs glm-45) would first-win silently — warn so a future snapshot
  // cannot misbridge (review F-round 🟡#5).
  const squishCounts = new Map()
  for (const [key, entry] of entries) {
    for (const name of [key, ...entry.aliases]) {
      const squished = squish(name)
      const prior = squishCounts.get(squished)
      if (prior !== undefined && prior !== key) console.warn(`  squish collision: "${prior}" ≡ "${key}" (${squished}) — first entry wins the bridge`)
      squishCounts.set(squished, key)
    }
  }
  const added = []
  const curated = new Set()
  const considerCurated = id => {
    const bare = String(id)
    if (bare === '' || !/^[a-z0-9][a-z0-9._-]*$/i.test(bare)) return
    if (bySquish.get(squish(bare)) === undefined) curated.add(bare)
  }
  for (const model of orModels) {
    const slug = String(model.id ?? '')
    if (slug === '') continue
    if (slug.startsWith('~')) {
      considerCurated(String(model.alias_target ?? '').split('/').pop())
      continue
    }
    const tail = slug.includes('/') ? slug.slice(slug.indexOf('/') + 1) : slug
    const key = bySquish.get(squish(tail)) ?? bySquish.get(squish(slug))
    if (key === undefined) continue
    if (canonicalize(slug) === key || canonicalize(tail) === key) continue // runtime folds it already
    const entry = entries.get(key)
    if (!entry.aliases.has(slug)) {
      entry.aliases.add(slug)
      added.push(`${slug} → ${key}`)
    }
    for (const backtick of String(model.description ?? '').match(/`[^`]+`/g) ?? []) {
      considerCurated(backtick.slice(1, -1))
    }
  }
  return { added, curated: [...curated].sort() }
}

/** Rank fraction within one population: best = 1.0, worst = 0.0 (ties share ranks). */
function rankFractions(items, valueOf) {
  const sorted = [...items].sort((a, b) => valueOf(b) - valueOf(a))
  const n = sorted.length
  return new Map(sorted.map((item, index) => [item, n <= 1 ? 1 : 1 - index / (n - 1)]))
}

const QUANT_SUFFIX = /[-_ ](fp8|fp8-?hf|fp4|nvfp4|int8|int4|awq|gptq(?:-int4)?|gguf|bnb-[48]bit)$/i
const FRESH_SUFFIX = /[-_ ](next|preview|latest|exp|canary)$/i
const DATE_SUFFIX = /[-_ ](\d{4}-\d{2}-\d{2}|\d{8}|0\d{2}|\d{4,6})$/
const CONTEXT_TAIL = /^\d+[km]$/i
// Hyphenated single-digit version pairs fold to the dotted spelling (3-5 ≡
// 3.5); the lookarounds keep size suffixes (4-32k, 2-72b) intact — kept in
// lockstep with canonicalizeModelId in src/capability-scoring.ts (parity
// pinned by tests/capability-scoring.spec.ts).
const VERSION_PAIR = /(?<!\d)(\d)-(\d)(?![\w.])/g

/** Canonical KB key (also the progressive-match normalization, ADR 0016 d1). */
export function canonicalize(raw) {
  let name = String(raw).toLowerCase().trim()
  name = name.replace(/^[a-z0-9_.-]+\//, '') // vendor namespace inside the model id
  name = name.replace(/:[a-z0-9-]+$/, '') // router variant suffixes
  name = name.replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim()
  // Strip date/snapshot suffixes BEFORE tokenising — split on '-' would shatter
  // '2025-02-15' into tokens the per-token patterns can no longer see.
  name = name.replace(/[\s-_]\d{4}-\d{2}-\d{2}$/, '').replace(/[\s-_]\d{8}$/, '').replace(/[\s-_]0\d{2}$/, '')
  let tokens = name.split(/[\s-_]+/).map(token => token.replace(/[^a-z0-9.]/g, '')).filter(Boolean)
    // Pure-digit snapshot tokens (20260910, 0902) strip wherever they sit —
    // version tokens (3.8, 4o, v4) carry dots/letters and never match.
    .filter(token => !/^\d{8}$|^0\d{2}$|^\d{4}$|^\d{5,6}$/.test(token))
  const strip = () => { tokens = tokens.slice(0, -1) }
  let changed = true
  while (changed && tokens.length > 1) {
    changed = false
    const tail = tokens[tokens.length - 1]
    if (QUANT_SUFFIX.test(`-${tail}`) || DATE_SUFFIX.test(`-${tail}`) || CONTEXT_TAIL.test(tail)) { strip(); changed = true }
  }
  return tokens.join('-').replace(VERSION_PAIR, '$1.$2')
}

function arenaPercentiles(rows, categories) {
  const picked = rows.filter(row => categories.includes(row.category))
  const fractions = rankFractions(picked, row => row.rating)
  return new Map([...fractions].map(([row, fraction]) => [row.model_name, fraction]))
}

const fixed = value => Math.round(value * 1000) / 1000

async function main() {
  console.log('fetching arena text/webdev/agent (latest)…')
  const [textRows, webdevRows, agentRows] = await Promise.all([fetchArenaOptional('text'), fetchArenaOptional('webdev'), fetchArenaOptional('agent')])
  console.log(`  text=${textRows.length} webdev=${webdevRows.length} agent=${agentRows.length}`)
  if (textRows.length === 0) await diagnoseTextSource()
  console.log('fetching aider polyglot…')
  const aider = await fetchAider()
  console.log(`  aider=${aider.length}`)

  const arenaOverall = arenaPercentiles(textRows, ['overall'])
  const arenaCoding = arenaPercentiles(textRows, ['coding'])
  const arenaWebdev = arenaPercentiles(webdevRows, ['overall'])
  const arenaAgent = arenaPercentiles(agentRows, ['overall'])
  const aiderFraction = rankFractions(aider, entry => entry.pass)

  const publishDates = new Set()
  for (const rows of [textRows, webdevRows, agentRows]) for (const row of rows) publishDates.add(row.leaderboard_publish_date)
  const asOf = [...publishDates].sort().pop() ?? 'unknown'

  const entries = new Map()
  const note = (displayName, dims) => {
    const key = canonicalize(displayName)
    if (key === '') return
    const existing = entries.get(key) ?? { aliases: new Set(), dims: {} }
    existing.aliases.add(displayName)
    for (const [dim, value] of Object.entries(dims)) {
      if (typeof value !== 'number') continue
      existing.dims[dim] = Math.min(existing.dims[dim] ?? 1, value) // keep the weakest observed signal
    }
    entries.set(key, existing)
  }
  for (const [name, fraction] of arenaOverall) note(name, { overall: fraction })
  for (const [name, fraction] of arenaCoding) note(name, { coding: fraction })
  for (const [name, fraction] of arenaWebdev) note(name, { webdev: fraction })
  for (const [name, fraction] of arenaAgent) note(name, { agentic: fraction })
  for (const [entry] of aiderFraction) {
    // Aider model strings carry config suffixes like "gpt-5 (high)"; the
    // canonicalize pass keeps the variant token, so record both spellings.
    note(entry.model, {})
  }

  // Blend coding: arena coding fraction is the primary anchor, aider the
  // secondary (0.6/0.4); a model present in only one source keeps that one.
  const aiderByKey = new Map([...aiderFraction].map(([entry, fraction]) => [canonicalize(entry.model), fraction]))
  for (const [key, entry] of entries) {
    const arena = entry.dims.coding
    const secondary = aiderByKey.get(key)
    if (arena !== undefined && secondary !== undefined) entry.dims.coding = fixed(0.6 * arena + 0.4 * secondary)
    else if (arena !== undefined) entry.dims.coding = fixed(arena)
    else if (secondary !== undefined) entry.dims.coding = fixed(secondary)
    // estimated = the coding anchor is absent (the runtime recomputes the flag
    // from dims.coding; the serialised flag is a build-time convenience).
    if (entry.dims.coding === undefined) entry.estimated = true
  }

  // OpenRouter cross-reference (F4): optional stage — a flapping catalogue
  // never fails the snapshot build.
  console.log('fetching openrouter catalogue…')
  const orModels = await fetchOpenRouter()
  const { added, curated } = crossReference(entries, orModels)
  reportAliasDiff(added, curated, entries)

  const lines = emitKb(entries, { asOf, sources: { text: textRows.length, webdev: webdevRows.length, agent: agentRows.length, aider: aider.length } })
  const outPath = kbOutPath()
  writeFileSync(outPath, `${lines.join('\n')}\n`)
  console.log(`wrote ${outPath} with ${entries.size} entries (as_of ${asOf})`)
}

/** Deterministic emitter shared by the full build and the aliases-only pass. */
function emitKb(entries, { asOf, sources }) {
  const lines = []
  lines.push('/**')
  lines.push(' * GENERATED by scripts/build-capability-kb.mjs — do not edit by hand.')
  lines.push(' * Capability knowledge base snapshot (ADR 0016 d1). Sources and licenses: NOTICES.')
  lines.push(' * Aliases cross-referenced with the OpenRouter catalogue (F4; see NOTICES).')
  lines.push(` * Snapshot as_of ${asOf}. Refresh by running the build script.`)
  lines.push(' */')
  lines.push('')
  lines.push("export interface KbDims { overall?: number; coding?: number; webdev?: number; agentic?: number }")
  lines.push('export interface KbEntry { aliases: string[]; dims: KbDims; estimated?: true }')
  lines.push(`export const KB_AS_OF = ${JSON.stringify(asOf)}`)
  lines.push(`export const KB_SOURCES = ${JSON.stringify(sources)}`)
  lines.push('export const KB: Record<string, KbEntry> = {')
  for (const key of [...entries.keys()].sort()) {
    const entry = entries.get(key)
    const dims = ['overall', 'coding', 'webdev', 'agentic']
      .filter(dim => entry.dims[dim] !== undefined)
      .map(dim => `${dim}: ${entry.dims[dim].toFixed(3)}`)
      .join(', ')
    const estimated = entry.estimated ? ', estimated: true' : ''
    // Alias slimming (PH1): aliases whose canonical form equals the key add
    // nothing to the runtime lookup index (kbLookup canonicalizes aliases) —
    // dropping them keeps the 497-entry snapshot inside the 40KB budget
    // (51550 → ~39.7KB) with zero behavior change.
    const liveAliases = [...entry.aliases].sort().filter(alias => canonicalize(alias) !== key)
    lines.push(`  ${JSON.stringify(key)}: { aliases: ${JSON.stringify(liveAliases)}, dims: { ${dims} }${estimated} },`)
  }
  lines.push('}')
  lines.push('')
  return lines
}

const kbOutPath = () => resolve(process.cwd(), 'src/capability-kb.ts')

/** `--aliases-only` (F4): merge OpenRouter cross-reference aliases into the
 *  COMMITTED snapshot without refetching the benchmark sources — dims, keys,
 *  KB_AS_OF, and KB_SOURCES are preserved byte-for-byte, so a mid-outage text
 *  source cannot degrade the committed coding anchors. Needs node with
 *  type-stripping (>= 23.6 unflagged, or >= 22.18 with
 *  --experimental-strip-types) to import the committed .ts. */
async function aliasesOnly() {
  const committed = await import('../src/capability-kb.ts')
  const entries = new Map(Object.entries(committed.KB).map(([key, entry]) => [key, { aliases: new Set(entry.aliases), dims: { ...entry.dims }, ...(entry.estimated === true ? { estimated: true } : {}) }]))
  console.log(`committed snapshot: ${entries.size} entries (as_of ${committed.KB_AS_OF})`)
  console.log('fetching openrouter catalogue…')
  const orModels = await fetchOpenRouter()
  const { added, curated } = crossReference(entries, orModels)
  reportAliasDiff(added, curated, entries)
  const lines = emitKb(entries, { asOf: committed.KB_AS_OF, sources: committed.KB_SOURCES })
  const outPath = kbOutPath()
  writeFileSync(outPath, `${lines.join('\n')}\n`)
  const bytes = Buffer.byteLength(JSON.stringify(Object.fromEntries([...entries].map(([key, entry]) => [key, { aliases: [...entry.aliases], dims: entry.dims }]))))
  console.log(`wrote ${outPath} (+${added.length} aliases, serialized KB ${bytes} bytes, budget 40000)`)
}

/** Human review surface for the cross-reference: the merged alias pairs and
 *  the curated-stem candidates (OFFICIAL_ID_STEMS is hand-maintained). */
function reportAliasDiff(added, curated, entries) {
  console.log(`\nalias diff (${added.length} merged):`)
  for (const line of added) console.log(`  ${line}`)
  console.log(`\ncurated-stem candidates (review by hand; ${curated.length}):`)
  for (const id of curated) console.log(`  ${id}`)
  const aliasedEntries = [...entries.values()].filter(entry => entry.aliases.size > 0).length
  console.log(`\nentries with aliases: ${aliasedEntries}/${entries.size}\n`)
}

// Import-safe: the canonicalize export is pinned by a parity spec, so main()
// only runs when executed as a script (node scripts/build-capability-kb.mjs
// [--aliases-only]).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--aliases-only')) await aliasesOnly()
  else await main()
}
