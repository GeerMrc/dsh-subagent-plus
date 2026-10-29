import { describe, expect, it } from 'vitest'
import {
  isLimitsValue,
  NamespaceFormController,
  OfficialAllowlistStatus,
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
  it('recognizes the limits shape', () => {
    expect(isLimitsValue({ maxDepth: 1, maxActiveSubagents: 8 })).toBe(true)
    expect(isLimitsValue({ maxDepth: 1 })).toBe(false)
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

  it('blocks a diverged draft from saving while another field parses invalid', async () => {
    // Discriminates the state.invalid gate: without it this save would emit
    // the maxDepth op — the invalid flag is the only thing holding it back.
    const { controller, form } = limitsHarness({ maxDepth: 1, maxActiveSubagents: 8 })
    controller.setMaxDepth('3')
    controller.setMaxActiveSubagents('abc')
    expect(controller.snapshot().invalid).toBe(true)
    expect(controller.snapshot().draft).toEqual({ maxDepth: 3, maxActiveSubagents: 8 })
    await controller.save()
    expect(form.mutateCalls).toEqual([])
  })

  it('clears a stale parse flag when a flapped namespace returns with a clean value', async () => {
    const { controller, form } = limitsHarness({ maxDepth: 1, maxActiveSubagents: 8 })
    controller.setMaxActiveSubagents('abc')
    expect(controller.snapshot().invalid).toBe(true)
    form.setStatus('unavailable')
    form.setStatus('ready')
    // The reloaded draft is the committed value; the stale per-field flag
    // must not keep the section blocked after recovery.
    expect(controller.snapshot().invalid).toBe(false)
    controller.setMaxDepth('4')
    await controller.save()
    expect(form.mutateCalls).toEqual([{ ops: [{ op: 'set', path: ['maxDepth'], value: 4 }], expectedRevision: 1 }])
  })
})

describe('T7 per-namespace availability (independent sections)', () => {
  function takeoverHarness(): { limits: OfficialLimitsController; limitsForm: FakeNsForm; probe: ProbeController; probeForm: FakeNsForm } {
    const limitsForm = new FakeNsForm({ maxDepth: 1, maxActiveSubagents: 8 })
    const probeForm = new FakeNsForm({ enabled: true, count: 2 })
    const limits = new OfficialLimitsController(limitsForm)
    const probe = new ProbeController(probeForm, {
      guard: (candidate): candidate is ProbeValue => typeof (candidate as ProbeValue).enabled === 'boolean',
      copy: source => ({ ...source }),
      blocked: () => false,
    })
    limits.init()
    probe.init()
    return { limits, limitsForm, probe, probeForm }
  }

  it('one namespace going unavailable flips only its own section; the other keeps editing and saving', async () => {
    const { limits, limitsForm, probe, probeForm } = takeoverHarness()
    limitsForm.setStatus('unavailable')
    expect(limits.snapshot().status).toBe('unavailable')
    expect(probe.snapshot().status).toBe('ready')
    // The served section still edits and lands its write in its namespace.
    probe.setCount(7)
    await probe.save()
    expect((probeForm.value as ProbeValue).count).toBe(7)
    // The unserved section's save is inert.
    limits.setMaxDepth('4')
    limitsForm.setValue({ maxDepth: 1, maxActiveSubagents: 8 })
    expect(limits.snapshot().status).toBe('unavailable')
  })

  it('both namespaces unavailable leaves both sections unavailable (the card keeps rendering)', () => {
    const { limits, limitsForm, probe, probeForm } = takeoverHarness()
    limitsForm.setStatus('unavailable')
    probeForm.setStatus('unavailable')
    expect(limits.snapshot().status).toBe('unavailable')
    expect(probe.snapshot().status).toBe('unavailable')
    expect(limits.snapshot().draft).toBeUndefined()
    expect(probe.snapshot().draft).toBeUndefined()
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

describe('OfficialAllowlistStatus (read-only view of the hidden official list)', () => {
  function statusHarness(value: unknown): { status: OfficialAllowlistStatus; form: FakeNsForm } {
    const form = new FakeNsForm(value)
    const status = new OfficialAllowlistStatus(form)
    status.init()
    return { status, form }
  }

  it('mirrors the committed list read-only: count and first entry, no draft surface', () => {
    const { status } = statusHarness({ enabled: true, allowedModels: [
      { provider: 'sz', model: 'Qwen3.8-27B-FP8' },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8' },
    ] })
    const view = status.snapshot()
    expect(view.status).toBe('ready')
    expect(view.count).toBe(2)
    expect(view.first).toEqual({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
    expect('draft' in view).toBe(false)
    expect(typeof (status as { save?: unknown }).save).toBe('undefined')
  })

  it('reports an empty list as count 0', () => {
    const { status } = statusHarness({ enabled: false, allowedModels: [] })
    expect(status.snapshot()).toMatchObject({ status: 'ready', count: 0, first: undefined })
  })

  it('exposes the committed enabled flag alongside a non-empty disabled list', () => {
    // Both bridges skip a disabled list: the line must not claim auto-adoption
    // just because stored entries exist.
    const { status } = statusHarness({ enabled: false, allowedModels: [
      { provider: 'sz', model: 'Qwen3.8-27B-FP8' },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8' },
    ] })
    expect(status.snapshot()).toMatchObject({ status: 'ready', enabled: false, count: 2, first: { provider: 'sz', model: 'Qwen3.8-27B-FP8' } })
  })

  it('follows a live enabled flip', () => {
    const { status, form } = statusHarness({ enabled: true, allowedModels: [{ provider: 'sz', model: 'm' }] })
    expect(status.snapshot().enabled).toBe(true)
    form.setValue({ enabled: false, allowedModels: [{ provider: 'sz', model: 'm' }] })
    expect(status.snapshot().enabled).toBe(false)
  })

  it('follows live updates and flips to unavailable with the namespace', () => {
    const { status, form } = statusHarness({ enabled: true, allowedModels: [{ provider: 'sz', model: 'm' }] })
    form.setValue({ enabled: true, allowedModels: [] })
    expect(status.snapshot().count).toBe(0)
    form.setStatus('unavailable')
    expect(status.snapshot().status).toBe('unavailable')
    form.setStatus('ready')
    expect(status.snapshot().count).toBe(0)
  })

  it('marks an unrecognizable shape valueInvalid and exposes nothing', () => {
    const { status } = statusHarness({ something: 'else' })
    expect(status.snapshot()).toMatchObject({ status: 'ready', count: 0, valueInvalid: true })
  })
})
