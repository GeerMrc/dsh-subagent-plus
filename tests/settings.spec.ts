import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, materializeConfig } from '../src/config.js'
import { attachSettingsSection, LivePinConfig, SETTINGS_NAMESPACE } from '../src/settings.js'
import type { PinConfig, PinConfigRuntime } from '../src/config.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

/** A plain config snapshot with every field overridable; tests also derive handles from it. */
function plainConfig(overrides: Partial<PinConfig> = {}): PinConfig {
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
    ...overrides,
  }
}

/** Wrap every field in a live handle over one shared state object. */
function handleRuntime(state: PinConfig): PinConfigRuntime {
  const runtime = {} as PinConfigRuntime
  for (const key of Object.keys(state) as (keyof PinConfig)[]) {
    Object.assign(runtime, { [key]: { get: () => state[key] } })
  }
  return runtime
}

describe('LivePinConfig', () => {
  it('passes plain values through untouched', () => {
    const config = plainConfig({ strategy: 'round-robin' })
    const live = new LivePinConfig(config)
    expect(live.current()).toEqual(config)
  })

  it('re-reads handle fields on every current() call in volatile mode', () => {
    const state = plainConfig({ strategy: 'pinned' })
    const live = new LivePinConfig(handleRuntime(state))
    expect(live.current().strategy).toBe('pinned')
    state.strategy = 'round-robin'
    expect(live.current().strategy).toBe('pinned')
    live.setVolatileSource(() => handleRuntime(state))
    expect(live.current().strategy).toBe('round-robin')
    state.strategy = 'priority'
    expect(live.current().strategy).toBe('priority')
  })

  it('keeps the last good snapshot when the source starts throwing, reporting once per message', () => {
    const good = plainConfig({ provider: 'sz' })
    let broken = false
    const source = (): PinConfigRuntime => {
      if (broken) throw new Error('committed value failed the schema')
      return good
    }
    const onInvalid = vi.fn()
    const live = new LivePinConfig(good, onInvalid)
    live.setVolatileSource(source)
    expect(live.current().provider).toBe('sz')
    broken = true
    expect(live.current().provider).toBe('sz')
    expect(live.current().provider).toBe('sz')
    expect(onInvalid).toHaveBeenCalledTimes(1)
  })
})

describe('attachSettingsSection', () => {
  it('adopts read-time evaluation and fires the commit hook for this namespace only', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('settings', {})
    const state = plainConfig({ strategy: 'round-robin' })
    const runtime = handleRuntime(state)
    const live = new LivePinConfig(runtime)
    const onCommit = vi.fn()
    attachSettingsSection(ctx, runtime, live, onCommit)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(live.current().strategy).toBe('round-robin')
    state.strategy = 'random'
    expect(live.current().strategy).toBe('random')
    ctx.emit('settings/document-updated', SETTINGS_NAMESPACE as SettingsNamespace, 1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    ctx.emit('settings/document-updated', 'another-plugin' as SettingsNamespace, 2)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('LivePinConfig nameMap (by-name mapping, ADR 0006)', () => {
  it('re-reads nameMap rows through volatile handles on every current() call', () => {
    const state = plainConfig({ nameMap: [{ name: 'researcher', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }] })
    const live = new LivePinConfig(handleRuntime(state))
    live.setVolatileSource(() => handleRuntime(state))
    expect(live.current().nameMap).toHaveLength(1)
    state.nameMap.push({ name: 'coder', provider: 'zai', model: 'glm-5.3', reasoningEffort: 'xhigh' })
    expect(live.current().nameMap).toHaveLength(2)
    expect(live.current().nameMap[1]).toEqual({ name: 'coder', provider: 'zai', model: 'glm-5.3', reasoningEffort: 'xhigh' })
  })

  it('keeps the last good nameMap snapshot when the source starts throwing', () => {
    const state = plainConfig({ nameMap: [{ name: 'researcher', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }] })
    let broken = false
    const live = new LivePinConfig(handleRuntime(state), vi.fn())
    live.setVolatileSource(() => {
      if (broken) throw new Error('schema failure')
      return handleRuntime(state)
    })
    expect(live.current().nameMap).toHaveLength(1)
    broken = true
    expect(live.current().nameMap).toHaveLength(1)
    expect(live.current().nameMap[0]?.name).toBe('researcher')
  })
})

describe('Config schema nameMap (by-name mapping, ADR 0006)', () => {
  it('defaults nameMap to an empty list for legacy documents and caps it at 16 rows', () => {
    const parse = (doc: unknown): PinConfig => materializeConfig((Config as unknown as (d: unknown) => import('../src/config.js').PinConfigRuntime)(doc))
    expect(parse({ strategy: 'pinned' }).nameMap).toEqual([])
    const single = parse({ nameMap: [{ name: 'dev', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'xhigh' }] })
    expect(single.nameMap).toEqual([{ name: 'dev', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'xhigh' }])
    const row = { name: 'dev', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }
    const seventeen = Array.from({ length: 17 }, () => ({ ...row }))
    expect(() => parse({ nameMap: seventeen })).toThrow()
  })
})
