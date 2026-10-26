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
    enabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
    pinForkChildren: false,
    failOpen: true,
    showNotice: true,
    autoRoute: true,
    strategy: 'pinned',
    priority: [],
    respectExplicit: false,
    cooldownMs: 120_000,
    fallbackProvider: '',
    fallbackModel: '',
    fallbackReasoningEffort: '',
  }
}

const szRoute = { provider: 'sz', model: 'Qwen3.8-27B-FP8', providerName: 'Qwen-SZ', modelName: 'Qwen3.8-27B-FP8' }
const hhRoute = { provider: 'hh', model: 'Qwen3.8-27B-FP8', providerName: 'Qwen-HH', modelName: 'Qwen3.8-27B-FP8' }

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

  it('blocks the save when the shared validation reports structural or degraded findings (P0 gate)', async () => {
    const { controller, form } = await harness()
    controller.setStrategy('priority')
    expect(controller.snapshot().degraded.length).toBeGreaterThan(0)
    await controller.save()
    expect(form.mutateCalls).toEqual([])
    controller.setStrategy('random')
    controller.setFallbackRoute(szRoute)
    controller.addRoute(szRoute)
    expect(controller.snapshot().degraded.length).toBeGreaterThan(0)
    await controller.save()
    expect(form.mutateCalls).toEqual([])
  })

  it('saves changed fields atomically behind the revision fence and reloads the committed value', async () => {
    const { controller, form } = await harness()
    controller.setStrategy('round-robin')
    controller.addRoute(szRoute)
    controller.setFallbackRoute(hhRoute)
    await controller.save()
    expect(form.mutateCalls).toHaveLength(1)
    expect(form.mutateCalls[0]?.expectedRevision).toBe(1)
    const paths = form.mutateCalls[0]?.ops.map(op => op.path.join('.')).sort()
    expect(paths).toEqual(['fallbackModel', 'fallbackProvider', 'priority', 'strategy'])
    expect(controller.snapshot().value?.strategy).toBe('round-robin')
    expect(controller.snapshot().draft).toEqual(controller.snapshot().value)
    expect(controller.snapshot().saved).toBe(true)
  })

  it('marks a conflict and reloads when the revision fence rejects the write', async () => {
    const { controller, form } = await harness()
    controller.setStrategy('random')
    form.failNextMutate()
    await controller.save()
    expect(controller.snapshot().conflict).toBe(true)
    expect(controller.snapshot().saved).toBe(false)
    // The next save carries the reloaded revision.
    controller.setStrategy('priority')
    controller.snapshot() // no-op read
    await controller.save()
    const last = form.mutateCalls.at(-1)
    expect(last?.expectedRevision).toBe(form.revision)
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
  it('releases the saving state and surfaces saveFailed when mutate rejects', async () => {
    const { controller, form } = await harness()
    controller.setStrategy('random')
    const original = form.mutate.bind(form)
    form.mutate = async () => { throw new Error('transport down') }
    await controller.save()
    expect(controller.snapshot().saving).toBe(false)
    expect(controller.snapshot().saveFailed).toBe(true)
    form.mutate = original
    await controller.save()
    expect(controller.snapshot().saved).toBe(true)
    // Editing retires the one-shot feedback.
    controller.setStrategy('priority')
    expect(controller.snapshot().saved).toBe(false)
    expect(controller.snapshot().saveFailed).toBe(false)
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
