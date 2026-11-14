import { describe, expect, it } from 'vitest'
import { KB } from '../src/capability-kb.js'
import {
  canonicalizeModelId,
  kbEntryFor,
  kbStatusOf,
  OFFICIAL_ID_STEMS,
  type KbTable,
} from '../src/capability-scoring.js'

/** F1 (ADR 0016 3a): resolver hardening — curated official stems, version
 *  separator normalization, context-suffix stripping, and the conservative
 *  fan-out cascade with its single-token guard. Corpus drawn from the 269-id
 *  empirical audit; the shipped-KB tests carry loud preconditions so a
 *  snapshot refresh that drops an anchor fails loudly instead of silently. */
describe('canonicalizeModelId hardening (F1)', () => {
  it('strips context-size suffix tokens so kimi-k3-256k reaches its family', () => {
    expect(canonicalizeModelId('kimi-k3-256k')).toBe('kimi-k3')
    expect(canonicalizeModelId('Qwen3.8-Flash-128k')).toBe('qwen3.8-flash')
  })

  it('context tokens only strip as tails — a leading 32k survives (it is part of the name)', () => {
    expect(canonicalizeModelId('32k-variant')).toBe('32k-variant')
  })

  it('normalizes hyphenated version pairs to the dotted form (3-5 ≡ 3.5, 4-8 ≡ 4.8)', () => {
    expect(canonicalizeModelId('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(canonicalizeModelId('claude-3.5-sonnet')).toBe('claude-3.5-sonnet') // idempotent
  })

  it('version normalization never crosses into size suffixes or multi-digit tails (pin: the 4-32k / 2-72b hazard)', () => {
    expect(canonicalizeModelId('claude-opus-4-32k-thinking')).toBe('claude-opus-4-32k-thinking')
    expect(canonicalizeModelId('Qwen2-72B-Instruct')).toBe('qwen2-72b-instruct')
    expect(canonicalizeModelId('llama-3-8b')).toBe('llama-3-8b') // Llama 3 8B — NOT 3.8
    expect(canonicalizeModelId('llama-3-1-8b')).toBe('llama-3.1-8b') // Llama 3.1 — IS
  })

  it('still strips vendor namespaces and variant suffixes (unchanged baseline)', () => {
    expect(canonicalizeModelId('strata/Qwen3.8-Flash-Next-NVFP4')).toBe('qwen3.8-flash-next')
    expect(canonicalizeModelId('model-x:free')).toBe('model-x')
  })
})

describe('kbEntryFor curated official stems (F1, the audited user cases)', () => {
  it("the harness bare id deepseek-flash resolves to the V4.1-Flash family (the user's real candidate)", () => {
    const hit = kbEntryFor('deepseek-flash')
    expect(hit).toBeDefined()
    expect(hit?.dims).toEqual({ webdev: 0.806, agentic: 0.638 })
    expect(hit?.estimated).toBe(true)
  })

  it('the short family alias k3 resolves to the Kimi K3 family', () => {
    expect(kbEntryFor('k3')).toBeDefined()
    expect(kbEntryFor('k3-256k')?.dims).toEqual(kbEntryFor('k3')?.dims)
  })

  it('hyphenated official ids reach their dotted KB entries (claude-opus-4-8, claude-3.5-sonnet)', () => {
    expect(kbEntryFor('claude-opus-4-8')?.dims.webdev).toBe(KB['claude-opus-4.8']?.dims.webdev)
    expect(kbEntryFor('claude-3.5-sonnet')?.dims.coding).toBe(KB['claude-3-5-sonnet']?.dims.coding)
    expect(kbEntryFor('claude-haiku-4-5-20251001')).toBeDefined()
  })
})

describe('kbEntryFor conservative cascade and single-token guard (F1)', () => {
  const kb: KbTable = {
    'family-x-pro': { aliases: [], dims: { overall: 0.8, coding: 0.8, webdev: 0.8, agentic: 0.8 } },
    'family-x-lite': { aliases: [], dims: { overall: 0.3, coding: 0.3 } },
    'qwen2-72b-instruct': { aliases: [], dims: { coding: 0.4 } },
  }

  it('strip-exact rounds still win before any fan-out (progressive order pinned)', () => {
    const mixed: KbTable = {
      ...kb,
      'family-x': { aliases: [], dims: { coding: 0.1 } },
    }
    // family-x-turbo strips to the EXACT family-x entry, never the fan-out family.
    expect(kbEntryFor('family-x-turbo', mixed)?.dims).toEqual({ coding: 0.1 })
  })

  it('fan-out retries stripped stems longest-to-shortest after every strip-exact round misses', () => {
    // family-x-turbo-256k: strip 256k → family-x-turbo (miss) → strip turbo → family-x
    // (miss) → fan-out: family-x-turbo has no variants, family-x hits the family.
    const hit = kbEntryFor('family-x-turbo-256k', kb)
    expect(hit?.dims).toEqual({ overall: 0.8, coding: 0.8, webdev: 0.8, agentic: 0.8 })
  })

  it('a single-token stem NEVER fans out — a bare vendor stays unknown (the rejected-F1 hazard)', () => {
    expect(kbEntryFor('deepseek')).toBeUndefined()
    expect(kbEntryFor('familyx', kb)).toBeUndefined()
  })

  it('unmapped private ids stay unknown (no guessed mapping, ADR 0016 A-1)', () => {
    expect(kbEntryFor('my-ft-v2')).toBeUndefined()
    expect(kbEntryFor('kimi-for-coding')).toBeUndefined()
  })

  it('aliases whose canonical form diverges from their key resolve through the alias index', () => {
    const aliased: KbTable = {
      'qwen2.5-coder-32b-instruct': { aliases: ['qwen/qwen-2.5-coder-32b-instruct'], dims: { coding: 0.5 } },
    }
    // Inert until the KB build carries divergent aliases (F4): the namespace
    // strip alone leaves qwen-2.5-coder…, and the alias index closes the gap.
    expect(kbEntryFor('qwen/qwen-2.5-coder-32b-instruct', aliased)?.dims).toEqual({ coding: 0.5 })
  })

  it('KB entries colliding under the separator normalization merge on the weakest signal', () => {
    const colliding: KbTable = {
      'claude-3-5-sonnet': { aliases: [], dims: { coding: 0.485 } },
      'claude-3.5-sonnet': { aliases: [], dims: { coding: 0.9, overall: 0.9 } },
    }
    const hit = kbEntryFor('claude-3.5-sonnet', colliding)
    expect(hit?.dims).toEqual({ coding: 0.485, overall: 0.9 }) // min per dimension
  })
})

describe('curated stems table invariants (F1)', () => {
  it('every stem maps to a stem that resolves against the shipped KB', () => {
    for (const mapped of Object.values(OFFICIAL_ID_STEMS)) {
      expect(kbEntryFor(mapped), mapped).toBeDefined()
    }
  })

  it('no curated stem key exists as a shipped KB key — rebuilds must retire absorbed rows', () => {
    for (const key of Object.keys(OFFICIAL_ID_STEMS)) {
      expect(canonicalizeModelId(key) in KB, key).toBe(false)
    }
  })

  it('shipped KB keys stay unique under the hardened canonicalizer', () => {
    const keys = Object.keys(KB).map(canonicalizeModelId)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('kbStatusOf three-state visibility (F2)', () => {
  it('anchors: coding-backed entry / known: estimated entry / unknown: no layer', () => {
    expect(kbStatusOf('gpt-5 (high)')).toBe('anchored') // coding-backed in the shipped snapshot
    expect(kbStatusOf('deepseek-flash')).toBe('known') // resolves via curated stem, estimated
    expect(kbStatusOf('Qwen3.8-27B')).toBe('known') // snapshot-wide text-source outage: estimated
    expect(kbStatusOf('my-ft-v2')).toBe('unknown')
  })

  it('an override rescues an unknown id; a qualified override only rescues its own route', () => {
    const overrides = [
      { provider: 'official', model: 'my-ft-v2', coding: 80, asOf: '2026-11-14' },
      { provider: 'other', model: 'my-ft-v3', coding: 80, asOf: '2026-11-14' },
    ]
    expect(kbStatusOf('my-ft-v2', overrides, undefined, 'official')).toBe('anchored')
    expect(kbStatusOf('my-ft-v2', overrides, undefined, 'backup')).toBe('unknown')
    expect(kbStatusOf('my-ft-v3', overrides)).toBe('unknown') // generic read: qualified row never applies
  })
})

describe('build/runtime canonicalizer parity (F1)', () => {
  it('the build script and the resolver canonicalize identically across the hazard corpus', async () => {
    const { canonicalize } = await import('../scripts/build-capability-kb.mjs')
    const corpus = [
      'Qwen3.8-Flash-Next-NVFP4', 'kimi-k3-256k', 'claude-opus-4-8', 'claude-3.5-sonnet',
      'claude-opus-4-32k-thinking', 'Qwen2-72B-Instruct', 'llama-3-8b', 'llama-3-1-8b',
      'strata/Qwen3.8-Flash-Next-NVFP4', 'model-x:free', 'DeepSeek-V4.1-Flash-20260910 (Max)',
      'chatgpt-4o-latest (2025-02-15)', 'claude-3-7-sonnet-20250219 (32k thinking tokens)',
      'grok-4.20-beta-reasoning', 'qwen/qwen-2.5-coder-32b-instruct',
    ]
    for (const id of corpus) {
      expect(canonicalize(id), id).toBe(canonicalizeModelId(id))
    }
  })
})
