import { describe, expect, it, vi } from 'vitest'
import type { RouteOption } from '../../src/client/settings-controller.js'
import {
  addableRoutesOf,
  fieldOps,
  MAX_ROUTES,
  SettingsSectionController,
  type CatalogPort,
  type FieldSetOp,
  type SettingsFormPort,
} from '../../src/client/settings-controller.js'
import type { PinConfig } from '../../src/config.js'
import { MAX_NAME_MAP_ENTRIES } from '../../src/strategy.js'

/** In-memory form port recording every mutate with its revision fence. */
class FakeForm implements SettingsFormPort {
  value: PinConfig | undefined
  status = 'ready'
  revision = 1
  readonly mutateCalls: { ops: FieldSetOp[]; expectedRevision?: number }[] = []
  #failNext = false
  #listeners = new Set<() => void>()

  constructor(value: PinConfig) {
    this.value = value
  }

  getSnapshot(): { status: string; value?: unknown; revision?: number } {
    return { status: this.status, value: this.value, revision: this.revision }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  async mutate(ops: readonly FieldSetOp[], expectedRevision?: number): Promise<boolean> {
    this.mutateCalls.push({ ops: [...ops], expectedRevision })
    if (this.#failNext) {
      this.#failNext = false
      return false
    }
    for (const op of ops) {
      if (op.op === 'set' && op.path.length === 1 && this.value !== undefined) {
        Object.assign(this.value, { [op.path[0] ?? '']: op.value })
      }
    }
    this.revision += 1
    this.#emit()
    return true
  }

  failNextMutate(): void { this.#failNext = true }

  /** Flip the served status and notify, as the host form does. */
  setStatus(status: string): void {
    this.status = status
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

const catalog: CatalogPort = {
  load: async () => ({
    groups: [
      { id: 'sz', name: 'Qwen-SZ', models: [{ id: 'Qwen3.8-27B-FP8', name: 'Qwen3.8-27B-FP8' }] },
      { id: 'hh', name: 'Qwen-HH', models: [{ id: 'Qwen3.8-27B-FP8', name: 'Qwen3.8-27B-FP8' }] },
      { id: 'zai', name: '智谱', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
    ],
    failureCount: 0,
  }),
}

function baseConfig(): PinConfig {
  return {
    provider: '',
    model: '',
    reasoningEffort: '',
    pinForkChildren: false,
    failOpen: true,
    showNotice: true,
    strategy: 'pinned',
    priority: [],
    respectExplicit: false,
    cooldownMs: 120_000,
    fallbackProvider: '',
    fallbackModel: '',
    fallbackReasoningEffort: '',
    nameMap: [],
    nameMapDefaults: false,
    capabilityOverrides: [],
  }
}

const szRoute = { provider: 'sz', model: 'Qwen3.8-27B-FP8', providerName: 'Qwen-SZ', modelName: 'Qwen3.8-27B-FP8' }
const hhRoute = { provider: 'hh', model: 'Qwen3.8-27B-FP8', providerName: 'Qwen-HH', modelName: 'Qwen3.8-27B-FP8' }
const zaiRoute = { provider: 'zai', model: 'glm-5.3', providerName: '智谱', modelName: 'GLM-5.3' }

async function harness(value = baseConfig()): Promise<{ controller: SettingsSectionController; form: FakeForm }> {
  const form = new FakeForm(value)
  const controller = new SettingsSectionController(form, catalog)
  controller.init()
  await vi.waitFor(() => { if (controller.snapshot().routes.length === 0) throw new Error('catalog not loaded') })
  return { controller, form }
}

describe('fieldOps', () => {
  it('emits one set op per changed top-level field and skips equal values', () => {
    const committed = baseConfig()
    const draft = { ...baseConfig(), strategy: 'round-robin' as const, cooldownMs: 5_000 }
    const ops = fieldOps(committed, draft)
    expect(ops).toEqual([
      { op: 'set', path: ['strategy'], value: 'round-robin' },
      { op: 'set', path: ['cooldownMs'], value: 5_000 },
    ])
  })
})

describe('addableRoutesOf', () => {
  it('excludes routes already listed', () => {
    const draft = { ...baseConfig(), priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }] }
    expect(addableRoutesOf(draft, [szRoute, hhRoute])).toEqual([hhRoute])
  })
})

describe('SettingsSectionController', () => {
  it('mirrors the committed value into the draft on sync', async () => {
    const { controller } = await harness()
    const state = controller.snapshot()
    expect(state.status).toBe('ready')
    expect(state.draft).toEqual(state.value)
    expect(state.routes.map(route => route.provider)).toEqual(['sz', 'hh', 'zai'])
  })

  it('adds, reorders, and removes list routes with the 5-route bound', async () => {
    const { controller } = await harness()
    controller.setStrategy('round-robin')
    controller.addRoute(szRoute)
    controller.addRoute(hhRoute)
    expect(controller.snapshot().draft?.priority.map(entry => entry.provider)).toEqual(['sz', 'hh'])
    controller.moveRoute(1, -1)
    expect(controller.snapshot().draft?.priority.map(entry => entry.provider)).toEqual(['hh', 'sz'])
    controller.moveRoute(0, -1)
    expect(controller.snapshot().draft?.priority.map(entry => entry.provider)).toEqual(['hh', 'sz'])
    controller.removeRoute(0)
    expect(controller.snapshot().draft?.priority.map(entry => entry.provider)).toEqual(['sz'])
    for (let index = 0; index < MAX_ROUTES; index += 1) controller.addRoute(index === 4 ? hhRoute : szRoute)
    expect(controller.snapshot().draft?.priority.length).toBeLessThanOrEqual(MAX_ROUTES)
  })

  it('saves an empty candidate list (not assigned) but blocks on degraded findings (P0 gate)', async () => {
    const { controller, form } = await harness()
    controller.setStrategy('priority')
    // An empty list is the legitimate not-assigned state — saving goes through.
    await expect(controller.save()).resolves.toBe('saved')
    // A fallback repeating a listed route stays unused: degraded blocks the save.
    controller.setStrategy('random')
    controller.addRoute(szRoute)
    controller.setFallbackRoute(szRoute)
    expect(controller.snapshot().degraded.length).toBeGreaterThan(0)
    await controller.save()
    expect(form.mutateCalls).toHaveLength(1)
  })

  it('saves changed fields atomically behind the revision fence and reloads the committed value', async () => {
    const { controller, form } = await harness()
    controller.setStrategy('round-robin')
    controller.addRoute(szRoute)
    controller.setFallbackRoute(hhRoute)
    await expect(controller.save()).resolves.toBe('saved')
    expect(form.mutateCalls).toHaveLength(1)
    expect(form.mutateCalls[0]?.expectedRevision).toBe(1)
    const paths = form.mutateCalls[0]?.ops.map(op => op.path.join('.')).sort()
    expect(paths).toEqual(['fallbackModel', 'fallbackProvider', 'priority', 'strategy'])
    expect(controller.snapshot().value?.strategy).toBe('round-robin')
    expect(controller.snapshot().draft).toEqual(controller.snapshot().value)
  })

  it('marks a conflict and reloads when the revision fence rejects the write', async () => {
    const { controller, form } = await harness()
    controller.setStrategy('random')
    form.failNextMutate()
    await expect(controller.save()).resolves.toBe('conflict')
    // The next save carries the reloaded revision.
    controller.setStrategy('priority')
    const before = form.revision
    await expect(controller.save()).resolves.toBe('saved')
    expect(form.mutateCalls.at(-1)?.expectedRevision).toBe(before)
  })

  it('rejects a cooldown above the 24h cap and accepts the boundary', async () => {
    const { controller } = await harness()
    controller.setCooldownMs('86400001')
    expect(controller.snapshot().cooldownInvalid).toBe(true)
    expect(controller.snapshot().draft?.cooldownMs).toBe(baseConfig().cooldownMs)
    controller.setCooldownMs('86400000')
    expect(controller.snapshot().cooldownInvalid).toBe(false)
    expect(controller.snapshot().draft?.cooldownMs).toBe(86_400_000)
  })

  it('flags an invalid cooldown text and blocks the save', async () => {
    const { controller, form } = await harness()
    controller.setCooldownMs('abc')
    expect(controller.snapshot().cooldownInvalid).toBe(true)
    await controller.save()
    expect(form.mutateCalls).toEqual([])
    controller.setCooldownMs('300000')
    expect(controller.snapshot().cooldownInvalid).toBe(false)
    expect(controller.snapshot().draft?.cooldownMs).toBe(300_000)
  })

  it('clears a stale cooldownInvalid flag when a flapped namespace returns with a clean value', async () => {
    const { controller, form } = await harness()
    controller.setCooldownMs('abc')
    expect(controller.snapshot().cooldownInvalid).toBe(true)
    form.setStatus('unavailable')
    form.setStatus('ready')
    // The reloaded draft is the committed value; the stale parse flag must
    // not keep blocking saves after recovery.
    expect(controller.snapshot().cooldownInvalid).toBe(false)
    controller.setShowNotice(false)
    await controller.save()
    expect(form.mutateCalls).toEqual([{ ops: [{ op: 'set', path: ['showNotice'], value: false }], expectedRevision: 1 }])
  })

  it('recognizes a committed snapshot from hosts that never carried the legacy enabled key', async () => {
    const form = new FakeForm(baseConfig())
    const controller = new SettingsSectionController(form, catalog)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().status !== 'ready') throw new Error('not ready') })
    expect(controller.snapshot().valueInvalid).toBe(false)
    expect(controller.snapshot().draft?.strategy).toBe('pinned')
    controller.dispose()
  })

  it('never writes back residue keys the schema no longer knows', async () => {
    const residue = { legacyPause: false }
    const { controller, form } = await harness({ ...baseConfig(), ...residue })
    controller.setCooldownMs('90000')
    await expect(controller.save()).resolves.toBe('saved')
    expect(form.mutateCalls[0]?.ops).toEqual([{ op: 'set', path: ['cooldownMs'], value: 90_000 }])
  })

  it('shows unavailable when the host does not serve the namespace', async () => {
    const form = new FakeForm(baseConfig())
    form.status = 'unavailable'
    form.value = undefined
    const controller = new SettingsSectionController(form, catalog)
    controller.init()
    expect(controller.snapshot().status).toBe('unavailable')
    expect(controller.snapshot().draft).toBeUndefined()
    controller.dispose()
  })
})

describe('save transport failures (review P1-1)', () => {
  it('reports failed when mutate rejects and saves once the transport recovers', async () => {
    const { controller, form } = await harness()
    controller.setStrategy('random')
    const original = form.mutate.bind(form)
    form.mutate = async () => { throw new Error('transport down') }
    await expect(controller.save()).resolves.toBe('failed')
    form.mutate = original
    await expect(controller.save()).resolves.toBe('saved')
  })
})

describe('effort dropdown data (E-04)', () => {
  const qwenRoute = {
    provider: 'sz', model: 'Qwen3.8-27B-FP8', providerName: 'Qwen-SZ', modelName: 'Qwen3.8-27B-FP8',
    efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'xhigh', name: 'Xhigh' }],
    defaultEffort: 'low',
  }
  const plainRoute: RouteOption = { provider: 'cm', model: 'kimi-for-coding', providerName: 'cm', modelName: 'Kimi' }

  it('effortOptions lists efforts by name and flags a stale stored id', async () => {
    const { effortOptions } = await import('../../src/client/settings-controller.js')
    expect(effortOptions(qwenRoute, '')).toEqual({
      options: [
        { value: 'off', label: 'Off' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'xhigh', label: 'Xhigh' },
      ],
      stale: false,
    })
    const stale = effortOptions(qwenRoute, 'ultra')
    expect(stale.stale).toBe(true)
    expect(stale.options[0]).toEqual({ value: 'ultra', label: 'ultra' })
    expect(effortOptions(plainRoute, '')).toEqual({ options: [], stale: false })
    expect(effortOptions(undefined, 'low').stale).toBe(false)
  })

  it('effortDefaultLabel names the configured default when present', async () => {
    const { effortDefaultLabel } = await import('../../src/client/settings-controller.js')
    expect(effortDefaultLabel(qwenRoute, '默认（{name}）', '跟随默认')).toBe('默认（Low）')
    expect(effortDefaultLabel(plainRoute, '默认（{name}）', '跟随默认')).toBe('跟随默认')
    expect(effortDefaultLabel(undefined, '默认（{name}）', '跟随默认')).toBe('跟随默认')
  })

  it('carries catalogue efforts into routes and rows', async () => {
    const form = new FakeForm(baseConfig())
    const catalogWithEfforts: CatalogPort = {
      load: async () => ({
        groups: [
          { id: 'sz', name: 'Qwen-SZ', models: [{ id: 'Qwen3.8-27B-FP8', name: 'Qwen3.8-27B-FP8', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }], defaultEffort: 'low' } }] },
          { id: 'cm', name: 'cm', models: [{ id: 'kimi-for-coding', name: 'Kimi' }] },
        ],
        failureCount: 0,
      }),
    }
    const controller = new SettingsSectionController(form, catalogWithEfforts)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().routes.length !== 2) throw new Error('catalog') })
    expect(controller.snapshot().routes[0]?.efforts?.map(e => e.id)).toEqual(['off', 'low'])
    expect(controller.snapshot().routes[0]?.defaultEffort).toBe('low')
    expect(controller.snapshot().routes[1]?.efforts).toBeUndefined()
    controller.setStrategy('round-robin')
    controller.addRoute(controller.snapshot().routes[0] ?? plainRoute)
    controller.setRouteEffort(0, 'off')
    expect(controller.snapshot().draft?.priority[0]?.reasoningEffort).toBe('off')
    controller.dispose()
  })

  it('keeps a stored effort when switching to a model that still supports it, clears otherwise', async () => {
    const form = new FakeForm(baseConfig())
    const catalogWithEfforts: CatalogPort = {
      load: async () => ({
        groups: [
          { id: 'sz', name: 'Qwen-SZ', models: [{ id: 'Qwen3.8-27B-FP8', name: 'Qwen3.8-27B-FP8', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'xhigh', name: 'Xhigh' }], defaultEffort: 'low' } }] },
          { id: 'zai', name: '智谱', models: [{ id: 'glm-5.3', name: 'GLM-5.3', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'low' } }] },
          { id: 'cm', name: 'cm', models: [{ id: 'kimi-for-coding', name: 'Kimi' }] },
        ],
        failureCount: 0,
      }),
    }
    const controller = new SettingsSectionController(form, catalogWithEfforts)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().routes.length !== 3) throw new Error('catalog') })
    controller.setStrategy('pinned')
    controller.setPinnedEffort('low')
    const byProvider = (provider: string): RouteOption | null => controller.snapshot().routes.find(route => route.provider === provider) ?? null
    controller.setPinnedRoute(byProvider('sz'))   // qwen efforts include low → keep
    expect(controller.snapshot().draft?.reasoningEffort).toBe('low')
    controller.setPinnedRoute(byProvider('zai'))  // zai efforts also include low → keep
    expect(controller.snapshot().draft?.reasoningEffort).toBe('low')
    controller.setPinnedRoute(byProvider('cm'))   // no reasoning levels → clear
    expect(controller.snapshot().draft?.reasoningEffort).toBe('')
    controller.setPinnedRoute(null)               // clearing the route clears the effort
    expect(controller.snapshot().draft?.reasoningEffort).toBe('')
    controller.dispose()
  })

  it('preserves a stale stored effort id verbatim (runtime validation owns rejecting it)', async () => {
    const { controller } = await harness({ ...baseConfig(), strategy: 'round-robin' as never, priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'weird' }] })
    expect(controller.snapshot().draft?.priority[0]?.reasoningEffort).toBe('weird')
    // The plain catalog carries no efforts, so the stored id stays untouched
    // and effortOptions reports nothing to render against (no silent rewrite).
    const { effortOptions } = await import('../../src/client/settings-controller.js')
    const route = controller.snapshot().routes.find(r => r.provider === 'sz')
    expect(effortOptions(route, 'weird')).toEqual({ options: [], stale: false })
    expect(controller.snapshot().draft?.priority[0]?.reasoningEffort).toBe('weird')
  })
})


/** Catalog with two effort-bearing routes: sz (qwen Off/Low/Medium/Xhigh), zai (Low/High/Max), plus a tierless cm. */
const effortsCatalog: CatalogPort = {
  load: async () => ({
    groups: [
      { id: 'sz', name: 'Qwen-SZ', models: [{ id: 'cand-a', name: 'A', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'xhigh', name: 'Xhigh' }], defaultEffort: 'low' } }] },
      { id: 'zai', name: '智谱', models: [{ id: 'cand-b', name: 'B', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'low' } }] },
      { id: 'cm', name: 'cm', models: [{ id: 'kimi', name: 'Kimi' }] },
    ],
    failureCount: 0,
  }),
}



describe('valueInvalid (E4)', () => {
  it('flags a ready form whose value is not a recognizable config', async () => {
    const form = new FakeForm(baseConfig())
    form.status = 'ready'
    form.value = { nonsense: true } as never
    const controller = new SettingsSectionController(form, catalog)
    controller.init()
    expect(controller.snapshot().valueInvalid).toBe(true)
    expect(controller.snapshot().draft).toBeUndefined()
    controller.dispose()
  })

  it('stays false for a well-formed ready value', async () => {
    const { controller } = await harness()
    expect(controller.snapshot().valueInvalid).toBe(false)
  })
})

describe('nameMap draft actions (by-name mapping, ADR 0006)', () => {
  it('adds, renames, reroutes, and removes rows; fieldOps carries the whole nameMap as one op', async () => {
    const { controller, form } = await harness()
    // ADR 0007: mapped routes must be listed candidates first.
    controller.addRoute(szRoute)
    controller.addRoute(hhRoute)
    controller.addNameRow(szRoute)
    controller.setNameRowName(0, 'researcher')
    controller.addNameRow(hhRoute)
    controller.setNameRowName(1, 'coder')
    expect(controller.snapshot().draft?.nameMap).toEqual([
      { name: 'researcher', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      { name: 'coder', provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
    ])
    controller.addRoute(zaiRoute)
    controller.setNameRowRoute(1, zaiRoute)
    expect(controller.snapshot().draft?.nameMap[1]).toEqual({ name: 'coder', provider: 'zai', model: 'glm-5.3', reasoningEffort: '' })
    await expect(controller.save()).resolves.toBe('saved')
    const ops = form.mutateCalls[0]?.ops ?? []
    // Under ADR 0007 the first save carries both the freshly listed candidate
    // routes and the mapping table; nameMap still travels as one whole-field op.
    expect(ops.map(op => op.path[0]).sort()).toEqual(['nameMap', 'priority'])
    const nameMapOp = ops.find(op => op.path[0] === 'nameMap')
    controller.removeNameRow(0)
    await expect(controller.save()).resolves.toBe('saved')
    expect(form.mutateCalls.at(-1)?.ops[0]?.value).toEqual([{ name: 'coder', provider: 'zai', model: 'glm-5.3', reasoningEffort: '' }])
  })

  it('blocks the save while a row is unnamed, duplicated, or an illegal name', async () => {
    const { controller, form } = await harness()
    controller.addRoute(szRoute)
    controller.addRoute(hhRoute)
    controller.addNameRow(szRoute)
    await expect(controller.save()).resolves.toBe('blocked')
    expect(controller.snapshot().structural.length).toBeGreaterThan(0)
    expect(form.mutateCalls).toHaveLength(0)
    controller.setNameRowName(0, 'researcher')
    controller.addNameRow(hhRoute)
    controller.setNameRowName(1, 'researcher')
    await expect(controller.save()).resolves.toBe('blocked')
    expect(form.mutateCalls).toHaveLength(0)
    controller.setNameRowName(1, 'lead')
    await expect(controller.save()).resolves.toBe('blocked')
    expect(form.mutateCalls).toHaveLength(0)
    controller.removeNameRow(1)
    await expect(controller.save()).resolves.toBe('saved')
    expect(form.mutateCalls).toHaveLength(1)
  })

  it('caps the mapping at 32 rows (ADR 0013 d5)', async () => {
    const { controller } = await harness()
    controller.addRoute(szRoute)
    for (let index = 0; index < 40; index += 1) controller.addNameRow(szRoute)
    expect(controller.snapshot().draft?.nameMap.length).toBe(MAX_NAME_MAP_ENTRIES)
  })
})

describe('nameMap dangling flow (ADR 0007, R7-R2 🟡-3)', () => {
  it('blocks the save after the mapped candidate row is removed', async () => {
    const { controller, form } = await harness()
    controller.addRoute(szRoute)
    controller.addNameRow(szRoute)
    controller.setNameRowName(0, 'researcher')
    await expect(controller.save()).resolves.toBe('saved')
    controller.removeRoute(0)
    expect(controller.snapshot().structural.some(m => m.includes('not in the candidate list'))).toBe(true)
    await expect(controller.save()).resolves.toBe('blocked')
    expect(form.mutateCalls).toHaveLength(1)
  })
})


describe('effective name map & copy-on-write (X5, ADR 0014 d2)', () => {
  function defaultsConfig(): PinConfig {
    return {
      ...baseConfig(),
      strategy: 'round-robin' as never,
      priority: [
        { provider: 'sz', model: 'cand-a', reasoningEffort: '' },
        { provider: 'zai', model: 'cand-b', reasoningEffort: '' },
      ],
      nameMap: [],
      nameMapDefaults: true,
    }
  }

  async function x5Harness(value = defaultsConfig()) {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm(value)
    const controller = new SettingsSectionController(form, effortsCatalog)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().routes.length !== 3) throw new Error('catalog') })
    return controller
  }

  it('defaults mode exposes derived rows without touching the draft', async () => {
    const controller = await x5Harness()
    const state = controller.snapshot()
    expect(state.effectiveNameMap).toHaveLength(12)
    expect(state.draft?.nameMap).toEqual([])
    expect(state.draft?.nameMapDefaults).toBe(true)
    // Both candidates unknown to the KB: list-order fallback — S=first,
    // B=F=second; efforts materialise on each one's own ladder.
    const byName = (name: string) => state.effectiveNameMap.find(row => row.name === name)
    expect(byName('review')).toMatchObject({ provider: 'sz', model: 'cand-a', reasoningEffort: 'xhigh' })
    expect(byName('dev')).toMatchObject({ provider: 'zai', model: 'cand-b', reasoningEffort: 'high' })
    expect(byName('test')).toMatchObject({ provider: 'zai', model: 'cand-b', reasoningEffort: 'low' })
    controller.dispose()
  })

  it('editing a derived row materialises the table and flips to custom', async () => {
    const controller = await x5Harness()
    controller.setNameRowName(0, 'proofreader')
    const state = controller.snapshot()
    expect(state.draft?.nameMapDefaults).toBe(false)
    expect(state.draft?.nameMap).toHaveLength(12)
    expect(state.draft?.nameMap[0]).toMatchObject({ name: 'proofreader', provider: 'sz', model: 'cand-a', reasoningEffort: 'xhigh' })
    // Effective map now mirrors the stored (custom) rows.
    expect(state.effectiveNameMap.every(row => state.draft?.nameMap.some(stored => stored.name === row.name))).toBe(true)
    controller.dispose()
  })

  it('addNameRow under defaults materialises then appends', async () => {
    const controller = await x5Harness()
    const routes = controller.snapshot().routes
    controller.addNameRow(routes.find(route => route.provider === 'cm') ?? routes[0]!)
    const state = controller.snapshot()
    expect(state.draft?.nameMapDefaults).toBe(false)
    expect(state.draft?.nameMap).toHaveLength(13)
    controller.dispose()
  })

  it('removing a derived row materialises the table too (review #1)', async () => {
    const controller = await x5Harness()
    controller.removeNameRow(3)
    const state = controller.snapshot()
    expect(state.draft?.nameMapDefaults).toBe(false)
    expect(state.draft?.nameMap).toHaveLength(11)
    expect(state.effectiveNameMap).toHaveLength(11)
    controller.dispose()
  })

  it('unavailable candidates still derive — priority verbatim, R2 parity (Y3)', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm({ ...baseConfig(), strategy: 'round-robin' as never, priority: [
      { provider: 'sz', model: 'cand-a', reasoningEffort: '' },
      { provider: 'ghost', model: 'vanished', reasoningEffort: '' },
    ], nameMap: [], nameMapDefaults: true })
    const controller = new SettingsSectionController(form, effortsCatalog)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().routes.length !== 3) throw new Error('catalog') })
    const rows = controller.snapshot().effectiveNameMap
    expect(rows).toHaveLength(12)
    // The catalog-missing candidate floors below the on-ladder one: S=sz, B/F=ghost.
    expect(rows.find(row => row.name === 'review')?.provider).toBe('sz')
    expect(rows.find(row => row.name === 'dev')?.provider).toBe('ghost')
    expect(rows.find(row => row.name === 'test')?.provider).toBe('ghost')
    controller.dispose()
  })

  it('resetNameMapDefaults clears rows and re-enables derivation', async () => {
    const controller = await x5Harness()
    controller.setNameRowName(0, 'proofreader')
    controller.resetNameMapDefaults()
    const state = controller.snapshot()
    expect(state.draft?.nameMapDefaults).toBe(true)
    expect(state.draft?.nameMap).toEqual([])
    expect(state.effectiveNameMap).toHaveLength(12)
    controller.dispose()
  })

  it('pinned keeps the effective map at the stored rows (R1 mirror)', async () => {
    const controller = await x5Harness({ ...defaultsConfig(), strategy: 'pinned' as never, nameMap: [{ name: 'reviewer', provider: 'sz', model: 'cand-a', reasoningEffort: '' }] })
    const state = controller.snapshot()
    expect(state.effectiveNameMap).toEqual([{ name: 'reviewer', provider: 'sz', model: 'cand-a', reasoningEffort: '' }])
    controller.dispose()
  })

  it('a committed document missing nameMapDefaults opens clean and derived (Y4, R3)', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const legacy = defaultsConfig()
    // A pre-0014 hand-edited document carries no nameMapDefaults key.
    delete (legacy as Partial<PinConfig>).nameMapDefaults
    const form = new FakeForm(legacy)
    const controller = new SettingsSectionController(form, effortsCatalog)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().routes.length !== 3) throw new Error('catalog') })
    const state = controller.snapshot()
    // Both sides normalize: derived rows visible, migration default applied,
    // and no phantom dirty (fieldOps sees no difference).
    expect(state.draft?.nameMapDefaults).toBe(true)
    expect(state.effectiveNameMap).toHaveLength(12)
    expect(fieldOps(state.value!, state.draft!)).toEqual([])
    controller.dispose()
  })

  it('defaults-on with stored rows surfaces the ADVISORY note and does NOT block saving (S7)', async () => {
    const controller = await x5Harness({ ...defaultsConfig(), nameMap: [{ name: 'reviewer', provider: 'sz', model: 'cand-a', reasoningEffort: '' }] })
    expect(controller.snapshot().advisory.some(message => message.includes('nameMapDefaults'))).toBe(true)
    expect(controller.snapshot().degraded).toEqual([])
    await expect(controller.save()).resolves.not.toBe('blocked')
    controller.dispose()
  })
})

describe('capability override import (Z4, ADR 0016 d3)', () => {
  const today = '2026-11-14'

  it('merges duplicate model rows last-wins (Zd revision) and still rejects all-dimension-empty rows', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm(baseConfig())
    const controller = new SettingsSectionController(form, emptyCatalogPort)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().status !== 'ready') throw new Error('form') })
    const duplicated = controller.importCapabilityOverrides([
      { model: 'alpha', coding: 80, asOf: today },
      { model: 'alpha', coding: 90, asOf: today },
    ])
    // Real-world evaluators re-emit listed models — duplicates merge with
    // last-wins and surface in mergedDuplicates instead of bouncing the batch.
    expect(duplicated.kind).toBe('imported')
    if (duplicated.kind === 'imported') expect(duplicated.mergedDuplicates).toHaveLength(1)
    expect(controller.snapshot().draft?.capabilityOverrides.map(row => row.coding)).toEqual([90])
    const empty = controller.importCapabilityOverrides([{ model: 'beta', asOf: today }])
    expect(empty.kind).toBe('rejected')
    controller.dispose()
  })

  it('imports rows with per-row match feedback against the live catalogue', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm({ ...baseConfig(), strategy: 'round-robin' as never, priority: [
      { provider: 'sz', model: 'cand-a', reasoningEffort: '' },
      { provider: 'zai', model: 'cand-b', reasoningEffort: '' },
    ] })
    const controller = new SettingsSectionController(form, effortsCatalog)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().routes.length !== 3) throw new Error('catalog') })
    const result = controller.importCapabilityOverrides([
      { model: 'cand-a', coding: 90, webdev: 70, asOf: today },
      { model: 'Qwen3.8-27B-FP8', coding: 20, asOf: today },   // KB-known, not a current candidate
      { model: 'mystery-deploy', overall: 60, asOf: today },   // known nowhere — stored anyway
    ])
    expect(result.kind).toBe('imported')
    if (result.kind === 'imported') {
      expect(result.rows[0]?.match).toBe('candidate')
      expect(result.rows[1]?.match).toBe('kb')
      expect(result.rows[2]?.match).toBe('none')
    }
    expect(controller.snapshot().draft?.capabilityOverrides).toHaveLength(3)
    controller.dispose()
  })

  it('overrides lift a candidate over the KB-known one in the derived view', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm({ ...baseConfig(), strategy: 'round-robin' as never, priority: [
      { provider: 'sz', model: 'cand-a', reasoningEffort: '' },
      { provider: 'zai', model: 'cand-b', reasoningEffort: '' },
    ], nameMap: [], nameMapDefaults: true })
    const controller = new SettingsSectionController(form, effortsCatalog)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().routes.length !== 3) throw new Error('catalog') })
    const before = controller.snapshot().effectiveNameMap.find(row => row.name === 'review')?.model
    expect(before).toBe('cand-a') // list-order fallback with both unknown
    controller.importCapabilityOverrides([{ model: 'cand-b', overall: 90, coding: 90, webdev: 90, agentic: 90, asOf: today }])
    const after = controller.snapshot().effectiveNameMap.find(row => row.name === 'review')?.model
    expect(after).toBe('cand-b') // 0.9 across the board beats the 0.5-median fill
    controller.dispose()
  })
})

/** An empty catalogue port for form-only tests. */
const emptyCatalogPort: CatalogPort = { load: async () => ({ groups: [], failureCount: 0 }) }

describe('research package scope (Z8/Z10 — full catalogue, model-level scoring unit)', () => {
  // deepseek-flash resolves to the KB since F1's curated stem — its match is
  // 'kb' now, matching what a real export computes for the official route.
  const fullCatalogue = [
    { provider: 'deepseek-official', model: 'deepseek-flash', match: 'kb' as const },
    { provider: 'deepseek-account', model: 'deepseek-flash', match: 'kb' as const },
    { provider: 'sz', model: 'Qwen3.8-27B-FP8', match: 'none' as const },
    { provider: 'hh', model: 'Qwen3.8-27B-FP8', match: 'candidate' as const },
    { provider: 'private', model: 'my-private-model', match: 'none' as const },
  ]

  it('keeps EVERY catalogue route in candidates (no collapsing) while the prompt scores one row per model', async () => {
    const { buildResearchPackage } = await import('../../src/client/settings-controller.js')
    const pkg = buildResearchPackage(fullCatalogue, '2026-11-14') as { schema: number; candidates: unknown[]; prompt: string }
    expect(pkg.schema).toBe(2)
    expect(pkg.candidates).toHaveLength(5) // both providers of deepseek-flash, both routes of the 27B, and the private row stay visible
    // Prompt lists each distinct model exactly once.
    expect(pkg.prompt.match(/- deepseek-flash/g)).toHaveLength(1)
    expect(pkg.prompt.match(/- Qwen3.8-27B-FP8/g)).toHaveLength(1)
  })

  it('prompt carries the hardened output contract with live counts and route annotations', async () => {
    const { buildResearchPackage } = await import('../../src/client/settings-controller.js')
    const pkg = buildResearchPackage(fullCatalogue, '2026-11-14') as { prompt: string }
    expect(pkg.prompt).toContain('EXACTLY 3 objects') // deepseek-flash + Qwen3.8-27B-FP8 + the private model
    expect(pkg.prompt).toContain('deepseek-flash (via deepseek-official / deepseek-account)') // KB-known since F1 — no unknown caveat
    expect(pkg.prompt).toContain('my-private-model (unknown model — estimate by comparable positioning)')
    expect(pkg.prompt).toContain('Qwen3.8-27B-FP8 (via sz / hh; current candidate)')
    expect(pkg.prompt).toContain('same as above')
    expect(pkg.prompt).toContain('同上')
    expect(pkg.prompt).toContain('[reference:N]')
    expect(pkg.prompt).toContain('exactly this many items')
    expect(pkg.prompt).toContain('at most 120 characters')
    // R: deterministic WRAPPING — bare JSON renders as plain text in DSH (no
    // copy button); the fence makes every reply a copyable code card. Verified
    // against three real sessions: fenced → card, bare → plain text.
    expect(pkg.prompt).toContain('Wrap the entire JSON array in a single fenced code block tagged json')
    expect(pkg.prompt).toContain('nothing outside the fence')
    // R2: process discipline — capability-conditional search duty, two-source
    // cross-validation with a visible single-source mark, per-model order.
    expect(pkg.prompt).toContain('you have web/search tools, you MUST search each model')
    expect(pkg.prompt).toContain('two independent credible sources') // R2 original; R3 refined to per-MODEL wording below
    expect(pkg.prompt).toContain('(1src)') // R2's (single-source) mark superseded by the R3 per-note tag
    // R3: visible cross-validation — per-MODEL two-source basis and a MANDATORY
    // trailing tag on every note ((2src)/(1src)); success leaves a trace too.
    expect(pkg.prompt).toContain('at least two independent credible sources for EACH MODEL')
    expect(pkg.prompt).toContain('End every note with a source tag: (2src)')
    expect(pkg.prompt).toContain('every note ends with a (2src) or (1src) tag')
    expect(pkg.prompt).toContain('evidence, resolve conflicts, score, write the note')
  })

  it('single English prompt — no bilingual variants ship in the package', async () => {
    const { buildResearchPackage } = await import('../../src/client/settings-controller.js')
    const pkg = buildResearchPackage([{ provider: 'p', model: 'm', match: 'kb' }], '2026-11-14') as Record<string, unknown>
    expect(pkg.prompt).toBeTruthy()
    expect(pkg.prompt_zh).toBeUndefined()
    expect(pkg.prompt_en).toBeUndefined()
  })
})


describe('override removal persists (Za — review P-1: copyConfig aliasing bug)', () => {
  it('removing a row on a freshly loaded config produces a save op (the committed value must not mutate)', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm({ ...baseConfig(), capabilityOverrides: [
      { model: 'cand-a', coding: 80, asOf: '2026-11-14' },
      { model: 'cand-b', coding: 60, asOf: '2026-11-14' },
    ] })
    const controller = new SettingsSectionController(form, emptyCatalogPort)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().status !== 'ready') throw new Error('form') })
    controller.removeCapabilityOverride(0)
    const state = controller.snapshot()
    // draft lost the row…
    expect(state.draft?.capabilityOverrides).toHaveLength(1)
    expect(state.draft?.capabilityOverrides[0]?.model).toBe('cand-b')
    // …the COMMITTED value kept both (no aliasing mutation)…
    expect(state.value?.capabilityOverrides).toHaveLength(2)
    // …so fieldOps emits a set op and the removal actually persists on save.
    const { fieldOps } = await import('../../src/client/settings-controller.js')
    expect(fieldOps(state.value!, state.draft!)).toHaveLength(1)
    controller.dispose()
  })
})

describe('override import tolerance (Zd — real-world evaluator output)', () => {
  // Verbatim shape of the user's actual DeepSeek research paste: duplicate
  // model rows (evaluator ignored the one-row contract), 同上 notes,
  // [reference:N] markers — none of it may block the import.
  const realWorldPaste = [
    { model: 'deepseek-flash', overall: 68, coding: 70, webdev: 65, agentic: 72, asOf: '2026-11-14', note: '轻量版；同上' },
    { model: 'deepseek-v4-pro', overall: 78, coding: 76, webdev: 82, agentic: 85, asOf: '2026-11-14', note: '旗舰 [reference:2]' },
    { model: 'deepseek-flash', overall: 68, coding: 70, webdev: 65, agentic: 72, asOf: '2026-11-14', note: '同上' },
    { model: 'Qwen3.8-27B-FP8', overall: 73, coding: 78, webdev: 86, agentic: 74, asOf: '2026-11-14', note: '开源编码强' },
    { model: 'Qwen3.8-27B-FP8', overall: 75, coding: 79, webdev: 86, agentic: 74, asOf: '2026-11-14', note: '当前候选；同尺寸最强 [reference:11]' },
  ]

  it('merges duplicate rows last-wins instead of rejecting the batch, and reports the merges', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm(baseConfig())
    const controller = new SettingsSectionController(form, emptyCatalogPort)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().status !== 'ready') throw new Error('form') })
    const result = controller.importCapabilityOverrides(realWorldPaste as never)
    expect(result.kind).toBe('imported')
    if (result.kind === 'imported') {
      expect(result.mergedDuplicates).toEqual([
        expect.objectContaining({ model: 'deepseek-flash' }),
        expect.objectContaining({ model: 'Qwen3.8-27B-FP8' }),
      ])
    }
    // Last row wins per model.
    const rows = controller.snapshot().draft?.capabilityOverrides ?? []
    expect(rows).toHaveLength(3)
    expect(rows.find(row => row.model === 'Qwen3.8-27B-FP8')?.coding).toBe(79)
    controller.dispose()
  })

  it('generic and qualified rows for the same model coexist; same-pair duplicates also merge', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm(baseConfig())
    const controller = new SettingsSectionController(form, emptyCatalogPort)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().status !== 'ready') throw new Error('form') })
    const result = controller.importCapabilityOverrides([
      { model: 'deepseek-flash', coding: 70, asOf: '2026-11-14' },
      { provider: 'deepseek-account', model: 'deepseek-flash', coding: 40, asOf: '2026-11-14' },
      { provider: ' deepseek-account ', model: 'deepseek-flash', coding: 50, asOf: '2026-11-14' }, // trims to the same pair → merge
    ] as never)
    expect(result.kind).toBe('imported')
    const rows = controller.snapshot().draft?.capabilityOverrides ?? []
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.provider === '')?.coding).toBe(70)
    expect(rows.find(row => row.provider === 'deepseek-account')?.coding).toBe(50)
    controller.dispose()
  })

  it('a new qualified row landing on an existing pair replaces it (draft-aware last-wins, no repeats state)', async () => {
    const { SettingsSectionController, validateReport } = await import('../../src/client/settings-controller.js') as never as { SettingsSectionController: typeof import('../../src/client/settings-controller.js').SettingsSectionController, validateReport: never }
    const { SettingsSectionController: SC } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm(baseConfig())
    const controller = new SC(form, emptyCatalogPort)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().status !== 'ready') throw new Error('form') })
    controller.importCapabilityOverrides([
      { provider: 'backup', model: 'm1', coding: 40, asOf: '2026-11-13' },
    ] as never)
    const result = controller.importCapabilityOverrides([
      { provider: 'backup', model: 'm1', coding: 65, asOf: '2026-11-14' },
    ] as never)
    if (result.kind !== 'imported') throw new Error('expected import')
    expect(result.mergedDuplicates).toHaveLength(1)
    const rows = controller.snapshot().draft?.capabilityOverrides ?? []
    expect(rows.filter(row => row.model === 'm1')).toHaveLength(1)
    expect(rows.find(row => row.model === 'm1')?.coding).toBe(65)
    controller.dispose()
  })

  it('re-import replaces generic rows but PRESERVES existing qualified rows', async () => {
    const { SettingsSectionController } = await import('../../src/client/settings-controller.js')
    const form = new FakeForm(baseConfig())
    const controller = new SettingsSectionController(form, emptyCatalogPort)
    controller.init()
    await vi.waitFor(() => { if (controller.snapshot().status !== 'ready') throw new Error('form') })
    controller.importCapabilityOverrides([
      { model: 'deepseek-flash', coding: 70, asOf: '2026-11-13' },
      { provider: 'deepseek-account', model: 'deepseek-flash', coding: 40, asOf: '2026-11-13' },
    ] as never)
    controller.importCapabilityOverrides([{ model: 'deepseek-flash', coding: 90, asOf: '2026-11-14' }] as never)
    const rows = controller.snapshot().draft?.capabilityOverrides ?? []
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.provider === '')?.coding).toBe(90) // replaced
    expect(rows.find(row => row.provider === 'deepseek-account')?.coding).toBe(40) // preserved
    controller.dispose()
  })
})

describe('matchOverrideRoute branches (Zg review #4)', () => {
  it('covers candidate / kb / none / route-miss', async () => {
    const { matchOverrideRoute } = await import('../../src/client/settings-controller.js')
    // my-private-model: unknown to every layer — deepseek-flash stopped working
    // as the unknown fixture once F1's curated stem resolved it.
    const catalogue = [
      { provider: 'official', model: 'my-private-model' },
      { provider: 'backup', model: 'my-private-model' },
    ]
    const candidates = [{ provider: 'official', model: 'my-private-model' }]
    expect(matchOverrideRoute({ model: 'my-private-model' }, catalogue, candidates)).toBe('candidate') // generic hits any provider's candidate
    expect(matchOverrideRoute({ provider: 'official', model: 'my-private-model' }, catalogue, candidates)).toBe('candidate') // exact route
    expect(matchOverrideRoute({ provider: 'backup', model: 'my-private-model' }, catalogue, candidates)).toBe('none') // route exists in catalogue but not a candidate and not in KB
    expect(matchOverrideRoute({ provider: 'typo', model: 'my-private-model' }, catalogue, candidates)).toBe('route-miss') // route resolves nowhere
    expect(matchOverrideRoute({ model: 'Qwen3.8-27B' }, [], [])).toBe('kb') // KB-known, nowhere listed
  })
})

/** J1: one-click paste tolerance — real evaluator output arrives fenced
 *  (```json … ``` plus blank lines, verified from a live DSH session); a bare
 *  JSON.parse bounces it with a misleading "not an array" error. */
describe('parseResearchPaste (J1 — fence-tolerant one-paste import)', () => {
  const rows = [{ model: 'glm-5.3', overall: 84, coding: 86, webdev: 72, agentic: 85, asOf: '2026-11-15', note: 'bench' }]

  it('strips a ```json fence and blank lines around the array', async () => {
    const { parseResearchPaste } = await import('../../src/client/settings-controller.js')
    const fenced = '```json\n\n' + JSON.stringify(rows, null, 2) + '\n\n```'
    const result = parseResearchPaste(fenced)
    expect(result.kind).toBe('rows')
    if (result.kind === 'rows') expect(result.rows).toEqual(rows)
  })

  it('bare arrays still parse (no regression)', async () => {
    const { parseResearchPaste } = await import('../../src/client/settings-controller.js')
    expect(parseResearchPaste(JSON.stringify(rows)).kind).toBe('rows')
  })

  it('a pasted export PACKAGE is detected, not parsed as rows', async () => {
    const { parseResearchPaste } = await import('../../src/client/settings-controller.js')
    const pkg = JSON.stringify({ schema: 2, prompt: '…', candidates: [] })
    const result = parseResearchPaste(pkg)
    expect(result.kind).toBe('package')
  })

  it('prose garbage stays invalid', async () => {
    const { parseResearchPaste } = await import('../../src/client/settings-controller.js')
    expect(parseResearchPaste('评估结果很好，谢谢').kind).toBe('invalid')
    expect(parseResearchPaste('[{"model":"x"}').kind).toBe('truncated') // unclosed array — J2 refined from invalid
  })
})

/** J2: web-chat evaluator tolerance — prose-wrapped replies, trailing
 *  commas, string numbers, wrapper objects, truncated pastes. Every class
 *  observed or high-probability when the prompt runs in DeepSeek's web UI
 *  instead of DSH (which produced clean fenced output). */
describe('parseResearchPaste web-chat tolerance (J2)', () => {
  const rows = [{ model: 'glm-5.3', overall: 84, coding: 86, webdev: 72, agentic: 85, asOf: '2026-11-15', note: 'bench' }]
  const json = JSON.stringify(rows, null, 2)
  const load = async () => (await import('../../src/client/settings-controller.js')).parseResearchPaste

  it('prose before/after a fenced block still imports', async () => {
    const parse = await load()
    const chatty = '好的，以下是评估结果：\n```json\n' + json + '\n```\n希望对你有帮助！'
    expect(parse(chatty).kind).toBe('rows')
  })

  it('prose around a BARE array (no fence) still imports', async () => {
    const parse = await load()
    expect(parse('以下是结果：\n' + json + '\n以上。').kind).toBe('rows')
  })

  it('trailing commas are tolerated', async () => {
    const parse = await load()
    const sloppy = '[{"model": "glm-5.3", "overall": 84, "coding": 86, "webdev": 72, "agentic": 85, "asOf": "2026-11-15", "note": "x",},]'
    const result = parse(sloppy)
    expect(result.kind).toBe('rows')
    if (result.kind === 'rows') expect(result.rows[0]).toMatchObject({ model: 'glm-5.3', overall: 84 })
  })

  it('numeric strings coerce to numbers ("84" → 84)', async () => {
    const parse = await load()
    const quoted = '[{"model": "glm-5.3", "overall": "84", "coding": "86", "webdev": "72", "agentic": "85", "asOf": "2026-11-15", "note": "x"}]'
    const result = parse(quoted)
    expect(result.kind).toBe('rows')
    if (result.kind === 'rows') expect(result.rows[0]).toMatchObject({ overall: 84, coding: 86 })
  })

  it('a wrapper object with one whitelisted array key unwraps ({"results": [...]})', async () => {
    const parse = await load()
    const wrapped = JSON.stringify({ results: rows })
    expect(parse(wrapped).kind).toBe('rows')
  })

  it('multiple fenced blocks: the LAST parseable array wins (final answer after thinking)', async () => {
    const parse = await load()
    const two = '```json\n[{"model": "draft"}]\n```\n修正后：\n```json\n' + json + '\n```'
    const result = parse(two)
    expect(result.kind).toBe('rows')
    if (result.kind === 'rows') expect(result.rows[0]).toMatchObject({ model: 'glm-5.3' })
  })

  it('truncated JSON reports the TRUNCATED kind (not generic invalid)', async () => {
    const parse = await load()
    const cut = json.slice(0, 40)
    expect(parse(cut).kind).toBe('truncated')
  })

  it('unrelated prose with no array stays invalid; export package still detected last', async () => {
    const parse = await load()
    expect(parse('这个模型很强，推荐使用。').kind).toBe('invalid')
    expect(parse(JSON.stringify({ schema: 2, prompt: 'x', candidates: [] })).kind).toBe('package')
  })
})
