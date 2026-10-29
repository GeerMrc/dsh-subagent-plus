import { describe, expect, it } from 'vitest'
import { UnifiedSaveController, type SaveOutcome, type SaveParticipant } from '../../src/client/unified-save.js'
import { OfficialLimitsController, type FieldSetOp, type NamespaceFormPort } from '../../src/client/official-surfaces.js'
import { SettingsSectionController, type CatalogPort, type SettingsFormPort } from '../../src/client/settings-controller.js'
import type { PinConfig } from '../../src/config.js'

/** In-memory form port mirroring the host's revision-fenced contract. */
class FakeForm implements SettingsFormPort {
  value: unknown
  status = 'ready'
  revision = 1
  readonly mutateCalls: { ops: FieldSetOp[]; expectedRevision?: number }[] = []
  #failNext = false
  #listeners = new Set<() => void>()

  constructor(value: unknown) {
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
    const record = this.value as Record<string, unknown> | undefined
    for (const op of ops) {
      if (op.op === 'set' && op.path.length === 1 && record !== undefined) {
        Object.assign(record, { [op.path[0] ?? '']: op.value })
      }
    }
    this.revision += 1
    for (const listener of this.#listeners) listener()
    return true
  }

  failNextMutate(): void { this.#failNext = true }

  setStatus(status: string): void {
    this.status = status
    for (const listener of this.#listeners) listener()
  }

  setValue(value: unknown): void {
    this.value = value
    for (const listener of this.#listeners) listener()
  }
}

/** A participant stub that records dispatch order and replays scripted outcomes. */
class StubParticipant implements SaveParticipant {
  readonly calls: number[] = []
  constructor(readonly key: string, private readonly outcomes: SaveOutcome[]) {}

  save(): Promise<SaveOutcome> {
    this.calls.push(this.calls.length)
    return Promise.resolve(this.outcomes[this.calls.length - 1] ?? 'saved')
  }
}

/** The empty catalogue port: the own-namespace editor never needs it here. */
const emptyCatalog: CatalogPort = { load: async () => ({ groups: [], failureCount: 0 }) }

/** A minimal valid own-namespace value for the plugin form. */
function pinConfig(overrides: Partial<PinConfig> = {}): PinConfig {
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
    cooldownMs: 120000,
    fallbackProvider: '',
    fallbackModel: '',
    fallbackReasoningEffort: '',
    ...overrides,
  }
}

/** Bound plugin controller over a fake form; mirrors the client entry wiring. */
function ownController(value: PinConfig): { controller: SettingsSectionController; form: FakeForm } {
  const form = new FakeForm(value)
  const controller = new SettingsSectionController(form, emptyCatalog)
  controller.init()
  return { controller, form }
}

describe('UnifiedSaveController', () => {
  it('saves all namespaces in order (limits before self)', async () => {
    const first = new StubParticipant('limits', ['saved'])
    const second = new StubParticipant('self', ['saved'])
    const order: string[] = []
    const record = (participant: StubParticipant): SaveParticipant => ({
      key: participant.key,
      save: async () => { order.push(participant.key); return participant.save() },
    })
    const controller = new UnifiedSaveController([record(first), record(second)])
    await controller.save()
    expect(order).toEqual(['limits', 'self'])
    expect(controller.snapshot()).toMatchObject({ saving: false, saved: true })
  })

  it('partial failure stops later namespaces', async () => {
    const failed = new StubParticipant('limits', ['failed'])
    const later = new StubParticipant('self', ['saved'])
    const controller = new UnifiedSaveController([failed, later])
    await controller.save()
    expect(later.calls).toHaveLength(0)
    expect(controller.snapshot()).toMatchObject({ saving: false, failedAt: 'limits' })
  })

  it('conflict stops later namespaces and marks conflictAt', async () => {
    const conflicted = new StubParticipant('limits', ['conflict'])
    const later = new StubParticipant('self', ['saved'])
    const controller = new UnifiedSaveController([conflicted, later])
    await controller.save()
    expect(later.calls).toHaveLength(0)
    expect(controller.snapshot()).toMatchObject({ saving: false, conflictAt: 'limits' })
  })

  it('a blocked participant stops later namespaces and names the section', async () => {
    const blocked = new StubParticipant('limits', ['blocked'])
    const later = new StubParticipant('self', ['saved'])
    const controller = new UnifiedSaveController([blocked, later])
    await controller.save()
    expect(later.calls).toHaveLength(0)
    expect(controller.snapshot()).toMatchObject({ saving: false, blockedAt: 'limits' })
  })

  it('unavailable and clean participants are skipped without stopping', async () => {
    const participants = [
      new StubParticipant('limits', ['unavailable']),
      new StubParticipant('allowlist', ['clean']),
      new StubParticipant('self', ['saved']),
    ]
    const controller = new UnifiedSaveController(participants)
    await controller.save()
    expect(controller.snapshot()).toMatchObject({ saving: false, saved: true, failedAt: undefined, conflictAt: undefined })
  })

  it('ignores a second save dispatch while one is in flight', async () => {
    let release: (() => void) | undefined
    const slow: SaveParticipant = {
      key: 'limits',
      save: () => new Promise<SaveOutcome>(resolve => { release = () => { resolve('saved') } }),
    }
    const later = new StubParticipant('self', ['saved'])
    const controller = new UnifiedSaveController([slow, later])
    const inFlight = controller.save()
    await controller.save()
    expect(later.calls).toHaveLength(0)
    release?.()
    await inFlight
    expect(later.calls).toHaveLength(1)
  })

  it('unavailable namespace is excluded but others save', async () => {
    const limitsForm = new FakeForm({ maxDepth: 1, maxActiveSubagents: 8 })
    limitsForm.setStatus('unavailable')
    const limits = new OfficialLimitsController(limitsForm)
    limits.init()
    const own = ownController(pinConfig({ cooldownMs: 60000 }))
    own.controller.setCooldownMs('90000')
    const controller = new UnifiedSaveController([
      { key: 'limits', save: limits.save },
      { key: 'self', save: own.controller.save },
    ])
    await controller.save()
    expect(limitsForm.mutateCalls).toHaveLength(0)
    expect(own.form.mutateCalls).toHaveLength(1)
    expect(own.form.value).toMatchObject({ cooldownMs: 90000 })
    expect(controller.snapshot()).toMatchObject({ saved: true })
  })

  it('conflict reloads only that namespace', async () => {
    const limitsForm = new FakeForm({ maxDepth: 1, maxActiveSubagents: 8 })
    const limits = new OfficialLimitsController(limitsForm)
    limits.init()
    limits.setMaxDepth('4')
    const own = ownController(pinConfig({ cooldownMs: 60000 }))
    own.controller.setCooldownMs('90000')
    const controller = new UnifiedSaveController([
      { key: 'limits', save: limits.save },
      { key: 'self', save: own.controller.save },
    ])
    limitsForm.failNextMutate()
    await controller.save()
    expect(limits.snapshot().conflict).toBe(true)
    // The fence reloaded the committed value into the draft (stale edit dropped).
    expect(limits.snapshot().draft).toEqual({ maxDepth: 1, maxActiveSubagents: 8 })
    // The own namespace was never attempted after the conflict.
    expect(own.form.mutateCalls).toHaveLength(0)
    expect(controller.snapshot()).toMatchObject({ conflictAt: 'limits' })
  })

  it('stale draft cleared on namespace flap', async () => {
    const limitsForm = new FakeForm({ maxDepth: 1, maxActiveSubagents: 8 })
    const limits = new OfficialLimitsController(limitsForm)
    limits.init()
    limits.setMaxDepth('5')
    expect(limits.snapshot().draft).toMatchObject({ maxDepth: 5 })
    limitsForm.setStatus('unavailable')
    expect(limits.snapshot().draft).toBeUndefined()
    limitsForm.setStatus('ready')
    expect(limits.snapshot().draft).toEqual({ maxDepth: 1, maxActiveSubagents: 8 })
    // A save after the flap carries no stale edit: nothing to write.
    limitsForm.mutateCalls.length = 0
    const outcome = await limits.save()
    expect(outcome).toBe('clean')
    expect(limitsForm.mutateCalls).toHaveLength(0)
  })
})
