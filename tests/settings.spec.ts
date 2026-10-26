import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { attachSettingsSection, LivePinConfig, SETTINGS_NAMESPACE } from '../src/settings.js'
import type { PinConfig, PinConfigRuntime } from '../src/config.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

/** A plain config snapshot with every field overridable; tests also derive handles from it. */
function plainConfig(overrides: Partial<PinConfig> = {}): PinConfig {
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
    const state = plainConfig({ enabled: false })
    const runtime = handleRuntime(state)
    const live = new LivePinConfig(runtime)
    const onCommit = vi.fn()
    attachSettingsSection(ctx, runtime, live, onCommit)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(live.current().enabled).toBe(false)
    state.enabled = true
    expect(live.current().enabled).toBe(true)
    ctx.emit('settings/document-updated', SETTINGS_NAMESPACE as SettingsNamespace, 1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    ctx.emit('settings/document-updated', 'another-plugin' as SettingsNamespace, 2)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})
