import { describe, expect, it } from 'vitest'
import { deriveStarterRows } from '../src/strategy.js'
import { canonicalizeModelId, kbEntryFor } from '../src/capability-scoring.js'
import { KB } from '../src/capability-kb.js'

/** H2 (ADR 0016 3d): the coverage invariant over EVERY permutation — the
 *  suite that would have caught every user report across the F/G/H rounds
 *  (zero-rows by ordering, band flips, duplicate entrances, unknown mixes).
 *
 *  Invariant: the distinct canonical models holding rows number exactly
 *  min(3, D) where D is the distinct-canonical count of the candidate list —
 *  at D ≤ 3 that means EVERY distinct model holds ≥1 family (no ordering can
 *  strand a model); at D > 4 exactly three hold rows and the rest are bench.
 *  Outcomes are deterministic (same list → identical table). */

type Cand = Parameters<typeof deriveStarterRows>[0][number]

const mk = (provider: string, model: string): Cand => ({
  provider,
  model,
  efforts: [{ id: 'off' }, { id: 'low' }, { id: 'medium' }, { id: 'xhigh' }],
})

/** All k-length permutations of a pool, in deterministic order. */
function permutations<T>(pool: readonly T[], k: number): T[][] {
  if (k === 0) return [[]]
  const out: T[][] = []
  for (let i = 0; i < pool.length; i += 1) {
    const head = pool[i]!
    const rest = pool.filter((_, j) => j !== i)
    for (const tail of permutations(rest, k - 1)) out.push([head, ...tail])
  }
  return out
}

const canonicalHolders = (rows: ReturnType<typeof deriveStarterRows>): Set<string> =>
  new Set(rows.map(row => canonicalizeModelId(row.model)))

function checkInvariants(label: string, list: Cand[]): void {
  const rows = deriveStarterRows(list)
  expect(rows, `${label}: 12 template rows`).toHaveLength(12)
  const holders = canonicalHolders(rows)
  const distinctModels = new Set(list.map(candidate => canonicalizeModelId(candidate.model)))
  expect(holders.size, `${label}: holders = min(3, distinct)`).toBe(Math.min(3, distinctModels.size))
  // Deterministic: the same list derives an identical table twice.
  expect(deriveStarterRows(list), `${label}: deterministic`).toEqual(rows)
  // Every row must reference a listed candidate route.
  for (const row of rows) {
    expect(list.some(candidate => candidate.provider === row.provider && candidate.model === row.model), `${label}: row ${row.name} references the list`).toBe(true)
  }
}

describe('coverage matrix — every permutation, shipped KB (H2)', () => {
  const pool: Cand[] = [
    mk('strata', 'Qwen3.8-Flash-Next-NVFP4'),
    mk('sz', 'Qwen3.8-27B-FP8'),
    mk('deepseek-official', 'deepseek-v4-pro'),
    mk('deepseek-relay', 'deepseek-flash'),
    mk('zai', 'glm-5.3'),
  ]
  expect(new Set(pool.map(c => c.model)).size).toBe(5)

  for (const size of [2, 3, 4, 5]) {
    it(`every ${size}-candidate permutation covers min(3, distinct) models with zero stranding`, () => {
      const lists = permutations(pool, size)
      expect(lists.length).toBeGreaterThan(0)
      for (const list of lists) checkInvariants(`size${size} ${list.map(c => c.model).join(',')}`, list)
    })
  }
})

describe('coverage matrix — duplicate entrance in the list (H2, G4 interaction)', () => {
  // 4 distinct canonicals + a second entrance of one model.
  const pool: Cand[] = [
    mk('sz', 'Qwen3.8-27B-FP8'),
    mk('hh', 'Qwen3.8-27B-FP8'), // duplicate entrance of the first
    mk('strata', 'Qwen3.8-Flash-Next-NVFP4'),
    mk('deepseek-official', 'deepseek-v4-pro'),
    mk('zai', 'glm-5.3'),
  ]
  const distinct = new Set(pool.map(c => c.model)).size
  expect(distinct).toBe(4)

  for (const size of [2, 3, 4, 5]) {
    it(`every ${size}-candidate permutation covers min(3, distinct canonicals)`, () => {
      for (const list of permutations(pool, size)) {
        const rows = deriveStarterRows(list)
        expect(rows, `size${size}`).toHaveLength(12)
        const holderModels = new Set(rows.map(row => row.model))
        const distinctModels = new Set(list.map(candidate => candidate.model))
        expect(holderModels.size, `size${size} ${list.map(c => c.model).join(',')}`).toBe(Math.min(3, distinctModels.size))
      }
    })
  }
})

describe('coverage matrix — anchored + estimated mix (H7 review counterexample pool)', () => {
  const pool: Cand[] = [
    mk('p1', 'gpt-5 (high)'),            // anchored (coding 1.000)
    mk('hh', 'Qwen3.8-27B-FP8'),          // estimated
    mk('ds', 'deepseek-v4-pro'),          // estimated
    mk('p2', 'gpt-5-medium'),             // anchored (coding .985)
  ]

  for (const size of [2, 3, 4]) {
    it(`every ${size}-candidate permutation covers min(3, distinct) models across the A-6 boundary`, () => {
      for (const list of permutations(pool, size)) {
        checkInvariants(`mixed size${size} ${list.map(c => c.model).join(',')}`, list)
      }
    })
  }
})

describe('coverage matrix — all-unknown list, list-order fallback (H2)', () => {
  const pool: Cand[] = [
    mk('p1', 'model-u1'),
    mk('p2', 'model-u2'),
    mk('p3', 'model-u3'),
    mk('p4', 'model-u4'),
    mk('p5', 'model-u5'),
  ]

  for (const size of [2, 3, 4, 5]) {
    it(`every ${size}-candidate permutation covers min(3, n) models (list-order contract)`, () => {
      for (const list of permutations(pool, size)) {
        const rows = deriveStarterRows(list)
        expect(rows, `size${size}`).toHaveLength(12)
        expect(new Set(rows.map(row => row.model)).size, `size${size} ${list.map(c => c.model).join(',')}`).toBe(Math.min(3, size))
      }
    })
  }
})

describe('coverage matrix sanity — the shipped KB still anchors the pool (H2)', () => {
  it('every pooled model resolves against the shipped snapshot (loud precondition)', () => {
    for (const model of ['Qwen3.8-Flash-Next-NVFP4', 'Qwen3.8-27B-FP8', 'deepseek-v4-pro', 'deepseek-flash', 'glm-5.3']) {
      expect(kbEntryFor(model), model).toBeDefined()
    }
    expect(Object.keys(KB).length).toBeGreaterThan(50)
  })
})
