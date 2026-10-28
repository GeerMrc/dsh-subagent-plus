import { describe, expect, it } from 'vitest'
import {
  isAllowlistValue,
  isLimitsValue,
  NamespaceFormController,
  OfficialAllowlistController,
  OfficialLimitsController,
  parseLimitText,
  type FieldSetOp,
  type NamespaceFormPort,
} from '../../src/client/official-surfaces.js'

/** Generic in-memory form port mirroring the host's revision-fenced contract. */
class FakeNsForm implements NamespaceFormPort {
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

  /** Flip the served status and notify, as the host form does. */
  setStatus(status: string): void {
    this.status = status
    this.#notify()
  }

  /** Replace the committed value and notify, as a foreign write does. */
  setValue(value: unknown): void {
    this.value = value
    this.#notify()
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
}

/** A concrete controller over a tiny value shape for the generic contract tests. */
interface ProbeValue { enabled: boolean; count: number }
class ProbeController extends NamespaceFormController<ProbeValue> {
  setCount = (count: number): void => { this.edit(draft => { draft.count = count }) }
}

function probeController(value: ProbeValue): { controller: ProbeController; form: FakeNsForm } {
  const form = new FakeNsForm(value)
  const controller = new ProbeController(form, {
    guard: (candidate): candidate is ProbeValue =>
      typeof candidate === 'object' && candidate !== null && typeof (candidate as ProbeValue).enabled === 'boolean',
    copy: source => ({ ...source }),
    blocked: () => false,
  })
  controller.init()
  return { controller, form }
}

describe('NamespaceFormController (generic takeover contract)', () => {
  it('mirrors the committed value into the draft when ready', () => {
    const { controller } = probeController({ enabled: true, count: 2 })
    const state = controller.snapshot()
    expect(state.status).toBe('ready')
    expect(state.value).toEqual({ enabled: true, count: 2 })
    expect(state.draft).toEqual({ enabled: true, count: 2 })
  })

  it('marks unavailable when the host does not serve the namespace', () => {
    const form = new FakeNsForm({ enabled: true, count: 2 })
    form.status = 'unavailable'
    const controller = new ProbeController(form, {
      guard: (candidate): candidate is ProbeValue => typeof (candidate as ProbeValue).enabled === 'boolean',
      copy: source => ({ ...source }), blocked: () => false,
    })
    controller.init()
    expect(controller.snapshot().status).toBe('unavailable')
  })

  it('flags valueInvalid when a ready snapshot is not a recognizable value', () => {
    const form = new FakeNsForm({ something: 'else' })
    const controller = new ProbeController(form, {
      guard: (candidate): candidate is ProbeValue => typeof (candidate as ProbeValue).enabled === 'boolean',
      copy: source => ({ ...source }), blocked: () => false,
    })
    controller.init()
    expect(controller.snapshot().valueInvalid).toBe(true)
  })

  it('saves only changed fields atomically behind the revision fence and lands them in the official namespace', async () => {
    const { controller, form } = probeController({ enabled: true, count: 2 })
    controller.setCount(5)
    await controller.save()
    expect(form.mutateCalls).toEqual([{ ops: [{ op: 'set', path: ['count'], value: 5 }], expectedRevision: 1 }])
    expect((form.value as ProbeValue).count).toBe(5)
    expect(controller.snapshot().saved).toBe(true)
  })

  it('blocks saving while the draft is invalid and surfaces the revision-fence conflict', async () => {
    const form = new FakeNsForm({ enabled: true, count: 2 })
    let invalid = false
    const controller = new ProbeController(form, {
      guard: (candidate): candidate is ProbeValue => typeof (candidate as ProbeValue).enabled === 'boolean',
      copy: source => ({ ...source }),
      blocked: () => invalid,
    })
    controller.init()
    controller.setCount(0)
    invalid = true
    await controller.save()
    expect(form.mutateCalls).toEqual([])
    invalid = false
    form.failNextMutate()
    await controller.save()
    expect(controller.snapshot().conflict).toBe(true)
  })
})

describe('official value guards', () => {
  it('recognizes limits and allowlist shapes', () => {
    expect(isLimitsValue({ maxDepth: 1, maxActiveSubagents: 8 })).toBe(true)
    expect(isLimitsValue({ maxDepth: 1 })).toBe(false)
    expect(isAllowlistValue({ enabled: true, allowedModels: [{ provider: 'sz', model: 'm' }] })).toBe(true)
    expect(isAllowlistValue({ enabled: true })).toBe(false)
  })
})

describe('parseLimitText', () => {
  it('accepts in-domain integers and rejects everything else', () => {
    expect(parseLimitText(' 3 ', 0)).toBe(3)
    expect(parseLimitText('1', 1)).toBe(1)
    expect(parseLimitText('0', 0)).toBe(0)
    expect(parseLimitText('0', 1)).toBeUndefined()
    expect(parseLimitText('-1', 0)).toBeUndefined()
    expect(parseLimitText('abc', 0)).toBeUndefined()
    expect(parseLimitText('1.5', 0)).toBeUndefined()
    expect(parseLimitText('9007199254740992', 0)).toBeUndefined()
  })
})

describe('OfficialLimitsController (T2 same-key writes into the official namespace)', () => {
  function limitsHarness(initial: { maxDepth: number; maxActiveSubagents: number }): { controller: OfficialLimitsController; form: FakeNsForm } {
    const form = new FakeNsForm({ ...initial })
    const controller = new OfficialLimitsController(form)
    controller.init()
    return { controller, form }
  }

  it('writes only the changed official keys on save', async () => {
    const { controller, form } = limitsHarness({ maxDepth: 1, maxActiveSubagents: 8 })
    controller.setMaxDepth('3')
    await controller.save()
    expect(form.mutateCalls).toEqual([{ ops: [{ op: 'set', path: ['maxDepth'], value: 3 }], expectedRevision: 1 }])
    expect(controller.snapshot().saved).toBe(true)
  })

  it('flags an invalid parse, keeps the previous number, and blocks the save', async () => {
    const { controller, form } = limitsHarness({ maxDepth: 1, maxActiveSubagents: 8 })
    controller.setMaxActiveSubagents('0')
    expect(controller.snapshot().invalid).toBe(true)
    expect(controller.snapshot().draft).toEqual({ maxDepth: 1, maxActiveSubagents: 8 })
    await controller.save()
    expect(form.mutateCalls).toEqual([])
    // A valid parse clears the flag and the save goes through.
    controller.setMaxActiveSubagents('2')
    expect(controller.snapshot().invalid).toBe(false)
    await controller.save()
    expect(form.mutateCalls).toEqual([{ ops: [{ op: 'set', path: ['maxActiveSubagents'], value: 2 }], expectedRevision: 1 }])
    expect((form.value as { maxActiveSubagents: number }).maxActiveSubagents).toBe(2)
  })

  it('surfaces the revision-fence conflict from the official form', async () => {
    const { controller, form } = limitsHarness({ maxDepth: 1, maxActiveSubagents: 8 })
    controller.setMaxDepth('2')
    form.failNextMutate()
    await controller.save()
    expect(controller.snapshot().conflict).toBe(true)
    expect(controller.snapshot().saved).toBe(false)
  })
})

describe('OfficialAllowlistController (T3 same-key writes, stored routes preserved)', () => {
  function allowlistHarness(initial: { enabled: boolean; allowedModels: { provider: string; model: string }[] }): { controller: OfficialAllowlistController; form: FakeNsForm } {
    const form = new FakeNsForm({ enabled: initial.enabled, allowedModels: initial.allowedModels.map(route => ({ ...route })) })
    const controller = new OfficialAllowlistController(form)
    controller.init()
    return { controller, form }
  }

  it('toggles route membership and the enabled flag, writing whole-key ops', async () => {
    const { controller, form } = allowlistHarness({ enabled: true, allowedModels: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8' }] })
    controller.toggleRoute({ provider: 'hh', model: 'Qwen3.8-27B-FP8' })
    await controller.save()
    expect(form.mutateCalls).toEqual([{
      ops: [{ op: 'set', path: ['allowedModels'], value: [
        { provider: 'sz', model: 'Qwen3.8-27B-FP8' },
        { provider: 'hh', model: 'Qwen3.8-27B-FP8' },
      ] }],
      expectedRevision: 1,
    }])
    controller.toggleRoute({ provider: 'hh', model: 'Qwen3.8-27B-FP8' })
    controller.setEnabled(false)
    await controller.save()
    expect((form.value as { enabled: boolean }).enabled).toBe(false)
    expect((form.value as { allowedModels: unknown[] }).allowedModels).toEqual([{ provider: 'sz', model: 'Qwen3.8-27B-FP8' }])
  })

  it('never duplicates a route and preserves stored routes the catalogue lost', async () => {
    const { controller, form } = allowlistHarness({ enabled: true, allowedModels: [{ provider: 'gone', model: 'old-model' }] })
    controller.toggleRoute({ provider: 'gone', model: 'old-model' })
    expect(controller.snapshot().draft?.allowedModels).toEqual([])
    controller.toggleRoute({ provider: 'gone', model: 'old-model' })
    // Back to exactly one entry — the toggle contract cannot manufacture duplicates.
    expect(controller.snapshot().draft?.allowedModels).toEqual([{ provider: 'gone', model: 'old-model' }])
    // Net-zero edits are not a diff: the draft equals the committed value, so
    // save is a no-op and the stored (catalogue-lost) route survives verbatim.
    await controller.save()
    expect(form.mutateCalls).toEqual([])
    expect((form.value as { allowedModels: unknown[] }).allowedModels).toEqual([{ provider: 'gone', model: 'old-model' }])
  })
})

describe('T7 per-namespace availability (independent sections)', () => {
  function takeoverHarness(): { limits: OfficialLimitsController; limitsForm: FakeNsForm; allowlist: OfficialAllowlistController; allowlistForm: FakeNsForm } {
    const limitsForm = new FakeNsForm({ maxDepth: 1, maxActiveSubagents: 8 })
    const allowlistForm = new FakeNsForm({ enabled: true, allowedModels: [] })
    const limits = new OfficialLimitsController(limitsForm)
    const allowlist = new OfficialAllowlistController(allowlistForm)
    limits.init()
    allowlist.init()
    return { limits, limitsForm, allowlist, allowlistForm }
  }

  it('one namespace going unavailable flips only its own section; the other keeps editing and saving', async () => {
    const { limits, limitsForm, allowlist, allowlistForm } = takeoverHarness()
    limitsForm.setStatus('unavailable')
    expect(limits.snapshot().status).toBe('unavailable')
    expect(allowlist.snapshot().status).toBe('ready')
    // The served section still edits and lands its write in the official ns.
    allowlist.setEnabled(false)
    await allowlist.save()
    expect((allowlistForm.value as { enabled: boolean }).enabled).toBe(false)
    // The unserved section's save is inert.
    limits.setMaxDepth('4')
    limitsForm.setValue({ maxDepth: 1, maxActiveSubagents: 8 })
    expect(limits.snapshot().status).toBe('unavailable')
  })

  it('both namespaces unavailable leaves both sections unavailable (the card keeps rendering)', () => {
    const { limits, limitsForm, allowlist, allowlistForm } = takeoverHarness()
    limitsForm.setStatus('unavailable')
    allowlistForm.setStatus('unavailable')
    expect(limits.snapshot().status).toBe('unavailable')
    expect(allowlist.snapshot().status).toBe('unavailable')
    expect(limits.snapshot().draft).toBeUndefined()
    expect(allowlist.snapshot().draft).toBeUndefined()
  })

  it('a namespace returning to service reloads the committed value as the fresh draft', () => {
    const { limits, limitsForm } = takeoverHarness()
    limitsForm.setStatus('unavailable')
    expect(limits.snapshot().status).toBe('unavailable')
    limitsForm.setValue({ maxDepth: 3, maxActiveSubagents: 2 })
    limitsForm.setStatus('ready')
    const state = limits.snapshot()
    expect(state.status).toBe('ready')
    expect(state.value).toEqual({ maxDepth: 3, maxActiveSubagents: 2 })
    expect(state.draft).toEqual({ maxDepth: 3, maxActiveSubagents: 2 })
  })
})
