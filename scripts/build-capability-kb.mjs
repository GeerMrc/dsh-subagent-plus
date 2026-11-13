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

const DS = 'lmarena-ai/leaderboard-dataset'
const HF_ROWS = (config, split, offset, length) =>
  `https://datasets-server.huggingface.co/rows?dataset=${DS}&config=${config}&split=${split}&offset=${offset}&length=${length}`
const AIDER_URLS = [
  'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/leaderboards/polyglot.yml',
  'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml',
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchWithRetry(url, tries = 5) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      if (attempt === tries) throw error
      console.warn(`  retry ${attempt}/${tries - 1} after error: ${String(error)}`)
      await sleep(3000 * attempt)
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
    const text = await fetchWithRetry(HF_ROWS(config, 'latest', offset, 100), 3)
    const page = JSON.parse(text)
    total = page.num_rows_total ?? rows.length
    for (const { row } of page.rows ?? []) rows.push(row)
    offset += 100
  }
  return rows
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

/** Rank fraction within one population: best = 1.0, worst = 0.0 (ties share ranks). */
function rankFractions(items, valueOf) {
  const sorted = [...items].sort((a, b) => valueOf(b) - valueOf(a))
  const n = sorted.length
  return new Map(sorted.map((item, index) => [item, n <= 1 ? 1 : 1 - index / (n - 1)]))
}

const QUANT_SUFFIX = /[-_ ](fp8|fp8-?hf|fp4|nvfp4|int8|int4|awq|gptq(?:-int4)?|gguf|bnb-[48]bit)$/i
const FRESH_SUFFIX = /[-_ ](next|preview|latest|exp|canary)$/i
const DATE_SUFFIX = /[-_ ](\d{4}-\d{2}-\d{2}|\d{8}|0\d{2}|\d{4,6})$/

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
    if (QUANT_SUFFIX.test(`-${tail}`) || DATE_SUFFIX.test(`-${tail}`)) { strip(); changed = true }
  }
  return tokens.join('-')
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
    if (entry.dims.coding === undefined) entry.estimated = true
    else if (secondary !== undefined && arena === undefined) {
      // coding anchored only by the secondary source — treat as estimated.
      entry.estimated = true
    }
  }

  const lines = []
  lines.push('/**')
  lines.push(' * GENERATED by scripts/build-capability-kb.mjs — do not edit by hand.')
  lines.push(' * Capability knowledge base snapshot (ADR 0016 d1). Sources and licenses: NOTICES.')
  lines.push(` * Snapshot as_of ${asOf}. Refresh by running the build script.`)
  lines.push(' */')
  lines.push('')
  lines.push("export interface KbDims { overall?: number; coding?: number; webdev?: number; agentic?: number }")
  lines.push('export interface KbEntry { aliases: string[]; dims: KbDims; estimated?: true }')
  lines.push(`export const KB_AS_OF = ${JSON.stringify(asOf)}`)
  lines.push(`export const KB_SOURCES = ${JSON.stringify({ text: textRows.length, webdev: webdevRows.length, agent: agentRows.length, aider: aider.length })}`)
  lines.push('export const KB: Record<string, KbEntry> = {')
  for (const key of [...entries.keys()].sort()) {
    const entry = entries.get(key)
    const dims = ['overall', 'coding', 'webdev', 'agentic']
      .filter(dim => entry.dims[dim] !== undefined)
      .map(dim => `${dim}: ${entry.dims[dim].toFixed(3)}`)
      .join(', ')
    const estimated = entry.estimated ? ', estimated: true' : ''
    lines.push(`  ${JSON.stringify(key)}: { aliases: ${JSON.stringify([...entry.aliases].sort())}, dims: { ${dims} }${estimated} },`)
  }
  lines.push('}')
  lines.push('')
  const outPath = resolve(process.cwd(), 'src/capability-kb.ts')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${lines.join('\n')}\n`)
  console.log(`wrote ${outPath} with ${entries.size} entries (as_of ${asOf})`)
}

await main()
