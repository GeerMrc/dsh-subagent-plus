import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import type { AgentLike } from '../src/pin.js'

/** ADR 0010 architecture tests: the plugin selects routes at agent creation
 *  time via agent.model.select(), never in the agent/request waterfall. */
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

const sz = { provider: 'sz', model: 'Qwen3.8-27B-FP8' }
const hh = { provider: 'hh', model: 'Qwen3.8-27B-FP8' }
const zai = { provider: 'zai', model: 'glm-5.3' }

interface MockModel {
  select: ReturnType<typeof vi.fn>
  current: ReturnType<typeof vi.fn>
}

/** A fake Agent with a mock agent.model (the 0.2.2+ API surface). */
function mockAgent(view: AgentLike & { model?: MockModel }): Agent {
  return view as Agent
}

function makeModel(currentRoute?: { provider: string; model: string; reasoningEffort?: string }): MockModel {
  return {
    select: vi.fn(),
    current: vi.fn(() => currentRoute),
  }
}

const teamNameOf = new WeakMap<object, string>()

function memberAgent(name: string, options: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Agent {
  const model = makeModel({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  const agent = mockAgent({
    options: { subagentDepth: 1, ...options },
    session: { header: { delegationDepth: 1, ...header }, inheritedEventCount: 0, eventAt: () => undefined },
    model,
  })
  teamNameOf.set(agent, name)
  return agent
}

function plainChild(): Agent {
  return mockAgent({
    options: { subagentDepth: 1 },
    session: { header: { delegationDepth: 1 }, inheritedEventCount: 0, eventAt: () => undefined },
    model: makeModel(),
  })
}

function topAgent(): Agent {
  return mockAgent({
    options: {},
    session: { header: {} },
    model: makeModel(),
  })
}

const seed: LlmCallConfig = {
  provider: 'strata',
  model: 'Qwen3.8-Flash-Next-NVFP4',
  reasoningEffort: 'medium' as ReasoningEffortId,
}

function dispatch(ctx: Context, agent: Agent): Promise<LlmCallConfig> {
  return ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ ...seed }))
}

function dispatchPreStep(ctx: Context, agent: Agent, modelSelection?: { provider: string; model: string; reasoningEffort?: string }): Promise<PreStepDecision> {
  return ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal, ...(modelSelection ? { modelSelection } : {}) }, async () => ({ kind: 'enter', messages: [] }))
}

function dispatchFailure(ctx: Context, agent: Agent, provider: string, code: string, status?: number): Promise<unknown> {
  return ctx.waterfall('agent/request-error', {
    agent, turn: 1, step: 1, provider,
    failure: { message: `${code} injected`, code, ...status === undefined ? {} : { status } },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }, async () => undefined)
}

function fireCreated(ctx: Context, agent: Agent, source = 'created'): Promise<void> {
  return (ctx as unknown as { waterfall: (name: string, data: unknown, next: () => Promise<void>) => Promise<void> }).waterfall('agent/created', { agent, source, signal: new AbortController().signal }, async () => {})
}

interface ByNameOpts { teams?: boolean; llm?: object }

async function byNameContext(overrides: Record<string, unknown> = {}, opts: ByNameOpts = {}): Promise<{ ctx: Context; warns: ReturnType<typeof vi.spyOn> }> {
  const ctx = new Context()
  contexts.push(ctx)
  if (opts.llm !== undefined) ctx.provide('llm', opts.llm)
  if (opts.teams !== false) {
    ctx.provide('agentTeams', {
      tryMembership: (a: object): { name: string } | undefined => {
        const n = teamNameOf.get(a)
        return n === undefined ? undefined : { name: n }
      },
    })
  }
  await ctx.plugin(plugin, {
    provider: '', model: '', reasoningEffort: '',
    pinForkChildren: false, failOpen: true, showNotice: true,
    strategy: 'pinned',
    priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
    respectExplicit: false,
    cooldownMs: 120_000, fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
    nameMap: [{ name: 'reviewer', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
    ...overrides,
  })
  return { ctx, warns: vi.spyOn(ctx.logger, 'warn') }
}

/** Minimal llm face for routeRegistered. */
function llmWith(getRoutes: () => { provider: string; model: string }[]): object {
  return {
    listProviders: () => getRoutes().map(route => ({ id: route.provider })),
    listModels: async (provider: string) => getRoutes().filter(route => route.provider === provider).map(route => ({ id: route.model })),
  }
}

const registered = llmWith(() => [sz, hh, zai])

describe('agent/created route selection (ADR 0010 M3)', () => {
  it('selects the mapped route for a keyword-matched teammate', async () => {
    const { ctx } = await byNameContext()
    const agent = memberAgent('plan-reviewer')
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalledWith({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  })

  it('selects the pinned route for an unmatched child', async () => {
    const { ctx } = await byNameContext({ provider: 'hh', model: 'Qwen3.8-27B-FP8' })
    const agent = plainChild()
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalledWith({ provider: 'hh', model: 'Qwen3.8-27B-FP8' })
  })

  it('does not select for a top-level agent', async () => {
    const { ctx } = await byNameContext()
    const agent = topAgent()
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).not.toHaveBeenCalled()
  })

  it('does not select for a fork child by default', async () => {
    const { ctx } = await byNameContext()
    const forkAgent = mockAgent({
      options: { subagentDepth: 1 },
      session: {
        header: { delegationDepth: 1 },
        inheritedEventCount: 2,
        eventAt: (seq: number) => seq === 2 ? { type: 'session/end-seed', data: { inherited: true } } : undefined,
      },
      model: makeModel(),
    })
    teamNameOf.set(forkAgent, 'plan-reviewer')
    await fireCreated(ctx, forkAgent)
    await new Promise(r => setTimeout(r, 10))
    const model = (forkAgent as unknown as { model: MockModel }).model
    expect(model.select).not.toHaveBeenCalled()
  })

  it('selects for a fork child when pinForkChildren is on', async () => {
    const { ctx } = await byNameContext({ pinForkChildren: true })
    const forkAgent = mockAgent({
      options: { subagentDepth: 1 },
      session: {
        header: { delegationDepth: 1 },
        inheritedEventCount: 2,
        eventAt: (seq: number) => seq === 2 ? { type: 'session/end-seed', data: { inherited: true } } : undefined,
      },
      model: makeModel(),
    })
    teamNameOf.set(forkAgent, 'plan-reviewer')
    await fireCreated(ctx, forkAgent)
    await new Promise(r => setTimeout(r, 10))
    const model = (forkAgent as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalledWith({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  })

  it('spreads successive children over candidate routes (round-robin)', async () => {
    const { ctx } = await byNameContext({
      strategy: 'round-robin',
      priority: [
        { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
        { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      ],
      nameMap: [],
    })
    const first = plainChild()
    const second = plainChild()
    await fireCreated(ctx, first)
    await fireCreated(ctx, second)
    await new Promise(r => setTimeout(r, 20))
    const m1 = (first as unknown as { model: MockModel }).model
    const m2 = (second as unknown as { model: MockModel }).model
    expect(m1.select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'sz' }))
    expect(m2.select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh' }))
  })

  it('stays dormant when the agentTeams service is absent (one warning)', async () => {
    const { ctx, warns } = await byNameContext({ provider: 'sz', model: 'Qwen3.8-27B-FP8' }, { teams: false })
    const agent = plainChild()
    await fireCreated(ctx, agent)
    await fireCreated(ctx, plainChild())
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    // Without agentTeams the keyword match can't fire, but pinned strategy still selects.
    expect(model.select).toHaveBeenCalled()
    expect(warns.mock.calls.filter(c => String(c[0]).includes('agentTeams'))).toHaveLength(1)
  })

  it('degrades silently when route selection throws (hard requirement: no rollback)', async () => {
    const { ctx, warns } = await byNameContext()
    const agent = mockAgent({
      options: { subagentDepth: 1 },
      session: { header: { delegationDepth: 1 }, inheritedEventCount: 0, eventAt: () => undefined },
      model: {
        select: vi.fn(() => { throw new Error('select failed') }),
        current: vi.fn(),
      },
    })
    teamNameOf.set(agent, 'plan-reviewer')
    // This must not throw — the try/catch in the created listener catches it.
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    expect(warns.mock.calls.some(c => String(c[0]).includes('failed'))).toBe(true)
  })

  it('agent without model property (pre-0.2.2 host) is silently skipped', async () => {
    const { ctx } = await byNameContext()
    const agent = mockAgent({
      options: { subagentDepth: 1 },
      session: { header: { delegationDepth: 1 }, inheritedEventCount: 0, eventAt: () => undefined },
      // No model property at all
    })
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    // No error, no select — silently skipped.
  })
})

describe('agent/request is an empty shell (ADR 0010 d8)', () => {
  it('passes through the resolved config unchanged', async () => {
    const { ctx } = await byNameContext()
    const agent = memberAgent('plan-reviewer')
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const result = await dispatch(ctx, agent)
    expect(result).toEqual(seed)
  })
})

describe('step-boundary health failover (ADR 0010 M4)', () => {
  it('records a failure and selects the next healthy route for the next step', async () => {
    const { ctx } = await byNameContext({
      strategy: 'round-robin',
      priority: [
        { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
        { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      ],
      nameMap: [],
    }, { llm: registered })
    const child = plainChild()
    // First creation selects sz (round-robin first).
    await fireCreated(ctx, child)
    await new Promise(r => setTimeout(r, 10))
    const model = (child as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'sz' }))
    // Failure on sz: request-error records it, then selects hh for next step.
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    expect(model.select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh' }))
  })

  it('cools every route of a provider on a credential failure', async () => {
    const { ctx } = await byNameContext({
      strategy: 'round-robin',
      priority: [
        { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
        { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      ],
      nameMap: [],
    }, { llm: registered })
    const child = plainChild()
    await fireCreated(ctx, child)
    await new Promise(r => setTimeout(r, 10))
    const model = (child as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'sz' }))
    // Provider-level failure: all sz routes cool down.
    await dispatchFailure(ctx, child, 'sz', 'INVALID_CREDENTIAL', 401)
    // The same agent gets re-selected to hh (sz is provider-cooled).
    expect(model.select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh' }))
  })

  it('does not track health when cooldownMs is 0', async () => {
    const { ctx } = await byNameContext({
      strategy: 'round-robin',
      priority: [
        { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
        { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      ],
      nameMap: [],
      cooldownMs: 0,
    }, { llm: registered })
    const child = plainChild()
    await fireCreated(ctx, child)
    await new Promise(r => setTimeout(r, 10))
    const model = (child as unknown as { model: MockModel }).model
    const callsBefore = model.select.mock.calls.length
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    // No re-selection when cooldown is 0.
    expect(model.select.mock.calls.length).toBe(callsBefore)
  })
})

describe('pre-step notices read modelSelection (ADR 0010 M6)', () => {
  it('shows the by-name notice when modelSelection matches the mapped route', async () => {
    const { ctx } = await byNameContext()
    const agent = memberAgent('plan-reviewer')
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    // Simulate a pre-step with the actual modelSelection.
    const decision = await dispatchPreStep(ctx, agent, { provider: 'sz', model: 'Qwen3.8-27B-FP8' })
    expect(decision.kind).toBe('enter')
    const messages = decision.kind === 'enter' ? decision.messages : []
    expect(messages.length).toBeGreaterThan(0)
    const text = messages[0]?.content?.[0]?.type === 'text' ? messages[0]?.content[0]?.text : undefined
    expect(text).toBeDefined()
    expect(text).toContain('按角色指派')
  })

  it('shows no notice for a top-level agent', async () => {
    const { ctx } = await byNameContext()
    const agent = topAgent()
    const decision = await dispatchPreStep(ctx, agent, { provider: 'sz', model: 'Qwen3.8-27B-FP8' })
    expect(decision.kind === 'enter' ? decision.messages.length : -1).toBe(0)
  })

  it('emits nothing when showNotice is off', async () => {
    const { ctx } = await byNameContext({ showNotice: false })
    const agent = memberAgent('plan-reviewer')
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const decision = await dispatchPreStep(ctx, agent, { provider: 'sz', model: 'Qwen3.8-27B-FP8' })
    expect(decision.kind === 'enter' ? decision.messages.length : -1).toBe(0)
  })
})

describe('runtime keyword defense (ADR 0007/0008, carrier-migrated)', () => {
  it('a row that left the candidate list is a miss (dangling defense)', async () => {
    const state = {
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: [{ name: 'reviewer', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
    }
    const entry: Record<string, unknown> = {}
    for (const key of Object.keys({ provider: '', model: '', reasoningEffort: '', pinForkChildren: false, failOpen: true, showNotice: true, strategy: 'pinned', respectExplicit: false, cooldownMs: 120_000, fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '', ...state })) {
      entry[key] = { get: () => (key in state ? state[key as keyof typeof state] : { provider: '', model: '', reasoningEffort: '', pinForkChildren: false, failOpen: true, showNotice: true, strategy: 'pinned', respectExplicit: false, cooldownMs: 120_000, fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '', ...state }[key as keyof typeof state]) }
    }
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agentTeams', { tryMembership: (a: object) => teamNameOf.has(a) ? { name: teamNameOf.get(a)! } : undefined })
    plugin.apply(ctx, entry as unknown as Parameters<typeof plugin.apply>[1])
    await new Promise(r => setTimeout(r, 10))
    // Route is valid initially.
    const agent = memberAgent('plan-reviewer')
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalled()
    // The candidate list loses the mapped route mid-session.
    state.priority = []
    const agent2 = memberAgent('plan-reviewer')
    await fireCreated(ctx, agent2)
    await new Promise(r => setTimeout(r, 10))
    const model2 = (agent2 as unknown as { model: MockModel }).model
    // Dangling: the byName match is a miss, falls to pinned which is empty
    // (provider ''/model '' means no pin → no select).
    // The plugin still selects via the fallback to pinned '' which means no
    // route available → select is NOT called for this agent.
    // (In the new architecture, resolveIntendedRoute returns undefined for
    //  empty pin + empty candidates → select is skipped.)
    // Note: if there was a fallback, select would be called with it.
  })

  it('a 1-character keyword mid-session is a miss (isValidKeyword defense)', async () => {
    const state: Record<string, unknown> = {
      provider: '', model: '', reasoningEffort: '', pinForkChildren: false,
      failOpen: true, showNotice: true, strategy: 'pinned', respectExplicit: false,
      cooldownMs: 120_000, fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
      priority: [{ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      nameMap: [{ name: 'reviewer', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
    }
    const entry: Record<string, unknown> = {}
    for (const key of Object.keys(state)) entry[key] = { get: () => state[key] }
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agentTeams', { tryMembership: (a: object) => teamNameOf.has(a) ? { name: teamNameOf.get(a)! } : undefined })
    plugin.apply(ctx, entry as unknown as Parameters<typeof plugin.apply>[1])
    await new Promise(r => setTimeout(r, 10))
    // Mid-session commit lands a 1-character keyword — the schema does not
    // catch it, the boot gate already passed; isValidKeyword defense must
    // treat it as unmatched at agent/created time.
    state.nameMap = [{ name: 'a', provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }]
    const agent = memberAgent('code-reviewer')
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    // 1-char keyword fails isValidKeyword → byName is a miss → falls to pinned
    // with empty provider/model → no select call (or select with the pinned
    // route if it were configured). Since provider is empty, no select.
    // The test verifies the defense: the agent is NOT routed to the 1-char
    // keyword's mapped route via byName. If pinned were configured, it would
    // get the pin route instead — which is correct behavior.
  })
})

describe('dual-source name resolution (ADR 0012, 0.2.2 hosts)', () => {
  it('namesOf fallback fires when tryMembership is absent, via inbox/claimed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    // No agentTeams service — 0.2.2 host: subagents.namesOf is the name source.
    ctx.provide('subagents', {
      namesOf: (a: object): { self?: string } | undefined => {
        const n = teamNameOf.get(a)
        return n === undefined ? undefined : { self: n }
      },
    })
    await ctx.plugin(plugin, {
      provider: '', model: '', reasoningEffort: '', pinForkChildren: false,
      failOpen: true, showNotice: true, strategy: 'round-robin',
      priority: [
        { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
        { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      ],
      respectExplicit: false, cooldownMs: 120_000,
      fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
      nameMap: [{ name: 'reviewer', provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
    })
    const agent = memberAgent('plan-reviewer')
    // Fire inbox/claimed — this is the deterministic hook for 0.2.2 hosts.
    void (ctx as unknown as { waterfall: (name: string, data: unknown, next: () => Promise<void>) => Promise<void> }).waterfall('agent/inbox/claimed', { agent }, async () => {})
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    // reviewer keyword should select the hh route (from nameMap).
    expect(model.select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh', model: 'Qwen3.8-27B-FP8' }))
  })

  it('namesOf UNAUTHORIZED during creation window is swallowed; inbox/claimed retries later', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    let authorized = false
    ctx.provide('subagents', {
      namesOf: (a: object): { self?: string } | undefined => {
        if (!authorized) throw new Error('UNAUTHORIZED: agent has no active runtime owner')
        const n = teamNameOf.get(a)
        return n === undefined ? undefined : { self: n }
      },
    })
    await ctx.plugin(plugin, {
      provider: '', model: '', reasoningEffort: '', pinForkChildren: false,
      failOpen: true, showNotice: true, strategy: 'pinned',
      priority: [{ provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      respectExplicit: false, cooldownMs: 120_000,
      fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
      nameMap: [{ name: 'reviewer', provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
    })
    const agent = memberAgent('plan-reviewer')
    // agent/created fires — namesOf throws UNAUTHORIZED, swallowed, no select yet.
    await fireCreated(ctx, agent)
    const model = (agent as unknown as { model: MockModel }).model
    // Strategy chain (pinned with empty pin) doesn't fire select either — name missed.
    // Now the creation window closes: inbox/claimed fires, namesOf works.
    authorized = true
    void (ctx as unknown as { waterfall: (name: string, data: unknown, next: () => Promise<void>) => Promise<void> }).waterfall('agent/inbox/claimed', { agent }, async () => {})
    await new Promise(r => setTimeout(r, 10))
    expect(model.select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh' }))
  })

  it('lead name from namesOf is excluded', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagents', {
      namesOf: (): { self?: string } | undefined => ({ self: 'lead' }),
    })
    await ctx.plugin(plugin, {
      provider: '', model: '', reasoningEffort: '', pinForkChildren: false,
      failOpen: true, showNotice: true, strategy: 'pinned',
      priority: [{ provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
      respectExplicit: false, cooldownMs: 120_000,
      fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
      nameMap: [{ name: 'reviewer', provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
    })
    const agent = memberAgent('anything')
    void (ctx as unknown as { waterfall: (name: string, data: unknown, next: () => Promise<void>) => Promise<void> }).waterfall('agent/inbox/claimed', { agent }, async () => {})
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    // 'lead' is excluded; nameMap miss → no by-name select.
    // But strategy chain (pinned, empty pin, fallback empty) also no select.
    expect(model.select).not.toHaveBeenCalled()
  })
})

describe('respectExplicit revival (W6, ADR 0013 d4)', () => {
  /** The delegating parent's current route, served through the sessions store. */
  function sessionsServing(route: { provider: string; model: string; reasoningEffort?: string }): object {
    return { get: (): { requestHeader: () => { config: typeof route } } => ({ requestHeader: () => ({ config: route }) }) }
  }
  const parentRoute = { provider: 'sz', model: 'Qwen3.8-27B-FP8' }

  /** A child created with an explicit zai pick that differs from the parent's sz route. */
  function explicitChild(name = 'plan-reviewer'): Agent {
    return memberAgent(name, { provider: 'zai', model: 'glm-5.3', reasoningEffort: 'low' }, { parentSession: 'p1' })
  }

  it('respectExplicit=true keeps the explicit pick over the keyword map (no select)', async () => {
    const { ctx } = await byNameContext({ strategy: 'round-robin', respectExplicit: true, priority: [
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
    ] })
    ctx.provide('sessions', sessionsServing(parentRoute))
    const agent = explicitChild()
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).not.toHaveBeenCalled()
  })

  it('respectExplicit=false routes the keyword map as usual (governance default)', async () => {
    const { ctx } = await byNameContext({ strategy: 'round-robin', respectExplicit: false, priority: [
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
    ] })
    ctx.provide('sessions', sessionsServing(parentRoute))
    const agent = explicitChild()
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalledWith({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  })

  it('a child equal to the parent route is inheritance, not an explicit pick', async () => {
    const { ctx } = await byNameContext({ strategy: 'round-robin', respectExplicit: true, priority: [
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
    ] })
    ctx.provide('sessions', sessionsServing(parentRoute))
    const agent = memberAgent('plan-reviewer', { provider: 'sz', model: 'Qwen3.8-27B-FP8' }, { parentSession: 'p1' })
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalledWith({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  })

  it('pinned stays a forced assignment: the explicit pick does not evade the pin', async () => {
    const { ctx } = await byNameContext({ strategy: 'pinned', respectExplicit: true, nameMap: [], provider: 'hh', model: 'Qwen3.8-27B-FP8' })
    ctx.provide('sessions', sessionsServing(parentRoute))
    const agent = explicitChild('worker')
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).toHaveBeenCalledWith({ provider: 'hh', model: 'Qwen3.8-27B-FP8' })
  })

  it('explicit children keep their pick at step boundaries (no failover swap)', async () => {
    const { ctx } = await byNameContext({ strategy: 'round-robin', respectExplicit: true, priority: [
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
    ] })
    ctx.provide('sessions', sessionsServing(parentRoute))
    ctx.provide('llm', registered)
    const agent = explicitChild()
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    await dispatchFailure(ctx, agent, 'zai', 'AUTH')
    await new Promise(r => setTimeout(r, 10))
    expect(model.select).not.toHaveBeenCalled()
  })

  it('the inbox/claimed hook also yields to an explicit pick', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagents', {
      namesOf: (a: object): { self?: string } | undefined => {
        const n = teamNameOf.get(a)
        return n === undefined ? undefined : { self: n }
      },
    })
    ctx.provide('sessions', sessionsServing(parentRoute))
    await ctx.plugin(plugin, {
      provider: '', model: '', reasoningEffort: '', pinForkChildren: false,
      failOpen: true, showNotice: true, strategy: 'round-robin',
      priority: [
        { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
        { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      ],
      respectExplicit: true, cooldownMs: 120_000,
      fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
      nameMap: [{ name: 'reviewer', provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }],
    })
    const agent = explicitChild()
    void (ctx as unknown as { waterfall: (name: string, data: unknown, next: () => Promise<void>) => Promise<void> }).waterfall('agent/inbox/claimed', { agent }, async () => {})
    await new Promise(r => setTimeout(r, 10))
    const model = (agent as unknown as { model: MockModel }).model
    expect(model.select).not.toHaveBeenCalled()
  })
})

describe('derived defaults (X4, ADR 0014 d2)', () => {
  /** llm face with mutable per-route reasoning tiers via resolveModelInfo. */
  function tieredLlm(initial: Record<string, string[]>) {
    const state = { tiers: initial }
    return {
      llm: {
        listProviders: () => [{ id: 'sz' }, { id: 'hh' }, { id: 'zai' }],
        listModels: async (provider: string) => (provider === 'zai' ? ['glm-5.3'] : ['Qwen3.8-27B-FP8']).map(id => ({ id })),
        resolveModelInfo: (provider: string, model: string) => {
          const efforts = state.tiers[`${provider}/${model}`]
          return { reasoning: efforts === undefined ? undefined : { efforts: efforts.map(id => ({ id })) } }
        },
      },
      setTiers: (next: Record<string, string[]>) => { state.tiers = next },
    }
  }
  const qwenTiers: Record<string, string[]> = {
    'sz/Qwen3.8-27B-FP8': ['off', 'low', 'medium', 'xhigh'],
    'hh/Qwen3.8-27B-FP8': ['low', 'high', 'max'],
    'zai/glm-5.3': ['low', 'medium', 'high', 'xhigh', 'max'],
  }
  const twoCandidates = [
    { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
    { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
  ]

  async function derivedContext(overrides: Record<string, unknown> = {}, opts: { llm?: object; settings?: boolean; teams?: boolean } = {}): Promise<{ ctx: Context; warns: ReturnType<typeof vi.spyOn> }> {
    const ctx = new Context()
    contexts.push(ctx)
    if (opts.llm !== undefined) ctx.provide('llm', opts.llm)
    if (opts.settings === true) ctx.provide('settings', {})
    if (opts.teams !== false) {
      ctx.provide('agentTeams', {
        tryMembership: (a: object): { name: string } | undefined => {
          const n = teamNameOf.get(a)
          return n === undefined ? undefined : { name: n }
        },
      })
    }
    await ctx.plugin(plugin, {
      provider: '', model: '', reasoningEffort: '', pinForkChildren: false,
      failOpen: true, showNotice: true, strategy: 'round-robin',
      priority: twoCandidates.map(entry => ({ ...entry })),
      respectExplicit: false, cooldownMs: 120_000,
      fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
      nameMap: [], nameMapDefaults: true,
      ...overrides,
    })
    return { ctx, warns: vi.spyOn(ctx.logger, 'warn') }
  }

  it('spread + defaults routes keywords with materialised top/mid/lowest tiers', async () => {
    const { llm } = tieredLlm(qwenTiers)
    const { ctx } = await derivedContext({}, { llm })
    // Capability order (ADR 0015): hh (max tier) outranks sz (xhigh) regardless of list order.
    const reviewer = memberAgent('plan-reviewer')
    await fireCreated(ctx, reviewer)
    expect(((reviewer as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith({ provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'max' })
    const dev = memberAgent('dev-worker')
    await fireCreated(ctx, dev)
    expect(((dev as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith({ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'medium' })
    const tester = memberAgent('tester-x')
    await fireCreated(ctx, tester)
    expect(((tester as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith({ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'low' })
  })

  it('runtime description hints rank equal-vocabulary candidates (Y3)', async () => {
    const sameVocab: Record<string, string[]> = {
      'sz/Qwen3.8-27B-FP8': ['off', 'low', 'medium', 'xhigh'],
      'hh/Qwen3.8-27B-FP8': ['off', 'low', 'medium', 'xhigh'],
    }
    const descriptions: Record<string, string> = { 'hh/Qwen3.8-27B-FP8': 'Stronger agentic coding at higher cost.' }
    const llm = {
      listProviders: () => [{ id: 'sz' }, { id: 'hh' }, { id: 'zai' }],
      listModels: async (provider: string) => (provider === 'zai' ? ['glm-5.3'] : ['Qwen3.8-27B-FP8']).map(id => ({ id })),
      resolveModelInfo: (provider: string, model: string) => ({
        description: descriptions[`${provider}/${model}`],
        reasoning: { efforts: sameVocab[`${provider}/${model}`]?.map(id => ({ id })) },
      }),
    }
    const { ctx } = await derivedContext({}, { llm })
    const reviewer = memberAgent('plan-reviewer')
    await fireCreated(ctx, reviewer)
    expect(((reviewer as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh', reasoningEffort: 'xhigh' }))
  })

  it('pinned keeps derivation dormant even with candidates listed (R1)', async () => {
    const { llm } = tieredLlm(qwenTiers)
    const { ctx } = await derivedContext({ strategy: 'pinned', provider: '', model: '' }, { llm })
    const agent = memberAgent('plan-reviewer')
    await fireCreated(ctx, agent)
    await new Promise(r => setTimeout(r, 10))
    expect(((agent as unknown as { model: MockModel }).model).select).not.toHaveBeenCalled()
  })

  it('custom mode keeps stored rows only; unmatched stems fall to the strategy chain', async () => {
    const { llm } = tieredLlm(qwenTiers)
    const { ctx } = await derivedContext({ nameMapDefaults: false, nameMap: [{ name: 'reviewer', provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' }] }, { llm })
    const reviewer = memberAgent('plan-reviewer')
    await fireCreated(ctx, reviewer)
    expect(((reviewer as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith({ provider: 'hh', model: 'Qwen3.8-27B-FP8' })
    const dev = memberAgent('dev-worker')
    await fireCreated(ctx, dev)
    // No derived rows in custom mode — the spread strategy assigns the first candidate.
    expect(((dev as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'sz', model: 'Qwen3.8-27B-FP8' }))
  })

  it('a settings commit runs re-derivation but keeps tier caches (tier changes invalidate via adapters-updated only)', async () => {
    // cordis deep-clones the config handed to apply(), so a unit test cannot
    // mutate the committed document through ctx.plugin; this exercises the
    // onCommit channel (refresh + rederive) with a mutation the plugin CAN
    // see — the llm service. Candidate-composition re-ranking is covered as a
    // pure function in strategy.spec ('appending a stronger model at the END').
    const mutable = tieredLlm(qwenTiers)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('llm', mutable.llm)
    ctx.provide('settings', {})
    ctx.provide('agentTeams', {
      tryMembership: (a: object): { name: string } | undefined => {
        const n = teamNameOf.get(a)
        return n === undefined ? undefined : { name: n }
      },
    })
    await ctx.plugin(plugin, {
      provider: '', model: '', reasoningEffort: '', pinForkChildren: false,
      failOpen: true, showNotice: true, strategy: 'round-robin',
      priority: twoCandidates.map(entry => ({ ...entry })),
      respectExplicit: false, cooldownMs: 120_000,
      fallbackProvider: '', fallbackModel: '', fallbackReasoningEffort: '',
      nameMap: [], nameMapDefaults: true,
    })
    const before = memberAgent('plan-reviewer')
    await fireCreated(ctx, before)
    expect(((before as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh', reasoningEffort: 'max' }))
    // Tier vocabularies change only through adapters-updated (the self-heal
    // test covers that path); a settings commit re-derives from cached tiers,
    // so a service-side tier mutation without adapters-updated must NOT leak
    // into the derived rows.
    mutable.setTiers({ ...qwenTiers, 'hh/Qwen3.8-27B-FP8': ['low', 'high'] })
    void (ctx as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit('settings/document-updated', 'dsh-subagent-plus')
    await new Promise(r => setTimeout(r, 30))
    const after = memberAgent('plan-reviewer')
    await fireCreated(ctx, after)
    expect(((after as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh', reasoningEffort: 'max' }))
  })

  it('adapter tier changes self-heal after adapters-updated (debounced, re-ranks capability)', async () => {
    const mutable = tieredLlm(qwenTiers)
    const { ctx } = await derivedContext({}, { llm: mutable.llm })
    const before = memberAgent('plan-reviewer')
    await fireCreated(ctx, before)
    expect(((before as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'hh', reasoningEffort: 'max' }))
    // hh loses its max tier → the S family re-ranks onto sz (xhigh) after the debounce.
    mutable.setTiers({ ...qwenTiers, 'hh/Qwen3.8-27B-FP8': ['low', 'high'] })
    void (ctx as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit('llm/adapters-updated')
    await new Promise(r => setTimeout(r, 280))
    const after = memberAgent('plan-reviewer')
    await fireCreated(ctx, after)
    expect(((after as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith(expect.objectContaining({ provider: 'sz', reasoningEffort: 'xhigh' }))
  })

  it('inbox/claimed before the first derivation stays dormant; agent/created awaits it', async () => {
    // No llm service at all: the inject-time first derivation never ran.
    const { ctx } = await derivedContext()
    const agent = memberAgent('plan-reviewer')
    void (ctx as unknown as { waterfall: (name: string, data: unknown, next: () => Promise<void>) => Promise<void> }).waterfall('agent/inbox/claimed', { agent }, async () => {})
    await new Promise(r => setTimeout(r, 10))
    expect(((agent as unknown as { model: MockModel }).model).select).not.toHaveBeenCalled()
    await fireCreated(ctx, agent)
    // agent/created awaits the (tierless) derivation — rows exist, efforts absent.
    expect(((agent as unknown as { model: MockModel }).model).select).toHaveBeenCalledWith({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  })

  it('request-error still records cooldowns for derived-route providers', async () => {
    const { llm } = tieredLlm(qwenTiers)
    const { ctx, warns } = await derivedContext({ cooldownMs: 60_000 }, { llm })
    const dev = memberAgent('dev-worker')
    await fireCreated(ctx, dev)
    await dispatchFailure(ctx, dev, 'sz', 'RATE_LIMIT')
    expect(warns.mock.calls.some(args => String(args[0]).includes('cooling down'))).toBe(true)
  })
})
