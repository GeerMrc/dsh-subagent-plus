import { describe, expect, it } from 'vitest'
import { TakeoverSwitchController, type PluginManagerFace } from '../../src/client/takeover-switch.js'

/** Scriptable face over the host's plugin-manager remote surface. */
class FakeFace implements PluginManagerFace {
  bundles: { name: string; enabled: boolean }[] = [{ name: 'dsh-subagent-plus', enabled: true }]
  nextResponse: { ok: boolean; value?: { application?: string } } = { ok: true, value: { application: 'applied' } }
  readonly setBundleCalls: { name: string; enabled: boolean }[] = []
  #failRead = false
  #throwWrite = false

  failReads(): void { this.#failRead = true }
  throwWrites(): void { this.#throwWrite = true }

  async listBundles(): Promise<{ name: string; enabled: boolean }[]> {
    if (this.#failRead) throw new Error('transport')
    return this.bundles
  }

  async setBundleEnabled(packageName: string, enabled: boolean): Promise<{ ok: boolean; value?: { application?: string } }> {
    this.setBundleCalls.push({ name: packageName, enabled })
    if (this.#throwWrite) throw new Error('transport')
    return this.nextResponse
  }
}

function controller(face?: FakeFace): TakeoverSwitchController {
  return new TakeoverSwitchController('dsh-subagent-plus', face)
}

describe('TakeoverSwitchController', () => {
  it('reports unavailable without a face', async () => {
    const switch_ = controller()
    expect(switch_.snapshot()).toMatchObject({ available: false, status: 'on' })
    await expect(switch_.refresh()).resolves.toBeUndefined()
    expect(switch_.snapshot().available).toBe(false)
  })

  it('reflects the bundle enabled state', async () => {
    const face = new FakeFace()
    const switch_ = controller(face)
    await switch_.refresh()
    expect(switch_.snapshot().status).toBe('on')
    face.bundles = [{ name: 'dsh-subagent-plus', enabled: false }]
    await switch_.refresh()
    expect(switch_.snapshot().status).toBe('off')
  })

  it('reads unknown when the bundle is missing or the read fails', async () => {
    const missing = new FakeFace()
    missing.bundles = []
    const switch_ = controller(missing)
    await switch_.refresh()
    expect(switch_.snapshot().status).toBe('unknown')

    const failing = new FakeFace()
    failing.failReads()
    const failingSwitch = controller(failing)
    await failingSwitch.refresh()
    expect(failingSwitch.snapshot().status).toBe('unknown')
  })

  it('click opens the confirm bar and cancel closes it', () => {
    const switch_ = controller(new FakeFace())
    switch_.requestDisable()
    expect(switch_.snapshot().confirming).toBe(true)
    switch_.cancel()
    expect(switch_.snapshot().confirming).toBe(false)
  })

  it('confirm disable turns the bundle off on applied', async () => {
    const face = new FakeFace()
    const switch_ = controller(face)
    switch_.requestDisable()
    await switch_.confirmDisable()
    expect(face.setBundleCalls).toEqual([{ name: 'dsh-subagent-plus', enabled: false }])
    expect(switch_.snapshot()).toMatchObject({ status: 'off', confirming: false, working: false, restartRequired: false })
  })

  it('restart-required keeps the page alive with a notice', async () => {
    const face = new FakeFace()
    face.nextResponse = { ok: true, value: { application: 'restart-required' } }
    const switch_ = controller(face)
    switch_.requestDisable()
    await switch_.confirmDisable()
    expect(switch_.snapshot()).toMatchObject({ status: 'off', restartRequired: true, disableFailed: false })
  })

  it('a refused envelope surfaces disableFailed', async () => {
    const face = new FakeFace()
    face.nextResponse = { ok: false }
    const switch_ = controller(face)
    switch_.requestDisable()
    await switch_.confirmDisable()
    expect(switch_.snapshot()).toMatchObject({ status: 'on', disableFailed: true, confirming: false })
  })

  it('a transport throw surfaces disableFailed without flipping the switch', async () => {
    const face = new FakeFace()
    face.throwWrites()
    const switch_ = controller(face)
    switch_.requestDisable()
    await switch_.confirmDisable()
    expect(switch_.snapshot()).toMatchObject({ status: 'on', disableFailed: true, working: false })
  })

  it('cancelled and overridden applications count as failures', async () => {
    for (const application of ['cancelled', 'overridden'] as const) {
      const face = new FakeFace()
      face.nextResponse = { ok: true, value: { application } }
      const switch_ = controller(face)
      switch_.requestDisable()
      await switch_.confirmDisable()
      expect(switch_.snapshot()).toMatchObject({ status: 'on', disableFailed: true })
    }
  })
})
