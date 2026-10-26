import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import type { AgentLike } from '../src/pin.js'

/** Load-bearing smoke: the plugin entry must load into a real cordis context and
 * pin child-agent request routes through the `agent/request` waterfall while
 * leaving top-level agents untouched. */
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

/** Structural stand-in carrying exactly the depth fields the listener reads;
 * legal assertion because the real `Agent` is assignable to `AgentLike`. */
function fakeAgent(view: AgentLike): Agent {
  return view as Agent
}

async function loadedContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(plugin, {
    enabled: true,
    provider: 'sz',
    model: 'Qwen3.8-27B-FP8',
    reasoningEffort: '',
    pinForkChildren: false,
    failOpen: true,
    showNotice: true,
    autoRoute: false,
    strategy: 'pinned',
    priority: [],
    respectExplicit: false,
    cooldownMs: 120_000,
    fallbackProvider: '',
    fallbackModel: '',
    fallbackReasoningEffort: '',
  })
  return ctx
}

const childAgent = fakeAgent({
  options: { subagentDepth: 1 },
  session: { header: { delegationDepth: 1 }, inheritedEventCount: 0, eventAt: () => undefined },
})

const topAgent = fakeAgent({
  options: {},
  session: { header: {} },
})

// Branded effort literal, mirroring the justified narrowing in src/index.ts.
const seed: LlmCallConfig = {
  provider: 'strata',
  model: 'Qwen3.8-Flash-Next-NVFP4',
  reasoningEffort: 'medium' as ReasoningEffortId,
}

function dispatch(ctx: Context, agent: Agent): Promise<LlmCallConfig> {
  return ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ ...seed }))
}

function dispatchPreStep(ctx: Context, agent: Agent, step = 2): Promise<PreStepDecision> {
  return ctx.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
}

function noticeText(decision: PreStepDecision): string | undefined {
  const block = decision.kind === 'enter' ? decision.messages[0]?.content[0] : undefined
  return block !== undefined && block.type === 'text' ? block.text : undefined
}

describe('plugin load through cordis', () => {
  it('pins a child request and drops the inherited effort', async () => {
    const ctx = await loadedContext()
    await expect(dispatch(ctx, childAgent)).resolves.toEqual({
      provider: 'sz',
      model: 'Qwen3.8-27B-FP8',
    })
  })

  it('leaves top-level requests untouched', async () => {
    const ctx = await loadedContext()
    await expect(dispatch(ctx, topAgent)).resolves.toEqual(seed)
  })

  it('does not pin fork children by default', async () => {
    const ctx = await loadedContext()
    const forkAgent = fakeAgent({
      options: { subagentDepth: 1 },
      session: {
        header: { delegationDepth: 1 },
        inheritedEventCount: 4,
        eventAt: (seq: number) => seq === 4
          ? { type: 'session/end-seed', data: { inherited: true } }
          : undefined,
      },
    })
    await expect(dispatch(ctx, forkAgent)).resolves.toEqual(seed)
  })
})

describe('visible pinned-model notice', () => {  it('adds one transcript notice to a child agent, naming the pinned route', async () => {
    const ctx = await loadedContext()
    const decision = await dispatchPreStep(ctx, childAgent)
    expect(decision.kind).toBe('enter')
    expect(noticeText(decision)).toContain('sz/Qwen3.8-27B-FP8')
    expect(noticeText(decision)).toContain('dsh-subagent-plus')
    const again = await dispatchPreStep(ctx, childAgent, 3)
    expect(again.kind === 'enter' && again.messages.length).toBe(0)
  })

  it('adds no notice to top-level agents or fork children', async () => {
    const ctx = await loadedContext()
    const top = await dispatchPreStep(ctx, topAgent)
    expect(top.kind === 'enter' && top.messages.length).toBe(0)
    const forkAgent = fakeAgent({
      options: { subagentDepth: 1 },
      session: {
        header: { delegationDepth: 1 },
        inheritedEventCount: 4,
        eventAt: (seq: number) => seq === 4
          ? { type: 'session/end-seed', data: { inherited: true } }
          : undefined,
      },
    })
    const fork = await dispatchPreStep(ctx, forkAgent)
    expect(fork.kind === 'enter' && fork.messages.length).toBe(0)
  })
})

/** Structural stand-in for the official `subagentModelSelection` settings. */
const officialSettings = {
  enabled: true,
  allowedModels: [{ provider: 'sz', model: 'auto-picked' }],
  current(): { enabled: boolean; allowedModels: { provider: string; model: string }[] } {
    return { enabled: officialSettings.enabled, allowedModels: officialSettings.allowedModels }
  },
}

const autoRouteConfig: plugin.PinConfig = {
  enabled: true,
  provider: '',
  model: '',
  reasoningEffort: '',
  pinForkChildren: false,
  failOpen: true,
  showNotice: false,
  autoRoute: true,
  strategy: 'pinned',
  priority: [],
  respectExplicit: false,
  cooldownMs: 120_000,
  fallbackProvider: '',
  fallbackModel: '',
  fallbackReasoningEffort: '',
}

describe('autoRoute through a live context', () => {
  it('pins onto the first official allowed route when provider/model are unset', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagentModelSelection', officialSettings)
    await ctx.plugin(plugin, autoRouteConfig)
    await expect(dispatch(ctx, childAgent)).resolves.toEqual({ provider: 'sz', model: 'auto-picked' })
    await expect(dispatch(ctx, topAgent)).resolves.toEqual(seed)
  })

  it('pins nothing without the settings service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(plugin, autoRouteConfig)
    await expect(dispatch(ctx, childAgent)).resolves.toEqual(seed)
  })
})

/** Fresh official settings per test: the spread strategies read this list in stored order. */
function allowList(...routes: { provider: string; model: string }[]): typeof officialSettings {
  const settings = {
    enabled: true,
    allowedModels: routes,
    current(): { enabled: boolean; allowedModels: { provider: string; model: string }[] } {
      return { enabled: settings.enabled, allowedModels: settings.allowedModels }
    },
  }
  return settings
}

const sz = { provider: 'sz', model: 'Qwen3.8-27B-FP8' }
const hh = { provider: 'hh', model: 'Qwen3.8-27B-FP8' }

function spreadConfig(overrides: Partial<plugin.PinConfig>): plugin.PinConfig {
  return {
    enabled: true,
    provider: '',
    model: '',
    reasoningEffort: '',
    pinForkChildren: false,
    failOpen: true,
    showNotice: true,
    autoRoute: true,
    strategy: 'round-robin',
    priority: [],
    respectExplicit: false,
    cooldownMs: 120_000,
    fallbackProvider: '',
    fallbackModel: '',
    fallbackReasoningEffort: '',
    ...overrides,
  }
}

/** A distinct child agent object per call so per-agent memos never collide. */
function newChild(options: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Agent {
  return fakeAgent({
    options: { subagentDepth: 1, ...options },
    session: { header: { delegationDepth: 1, ...header }, inheritedEventCount: 0, eventAt: () => undefined },
  })
}

async function spreadContext(config: plugin.PinConfig, settings = allowList(sz, hh)): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('subagentModelSelection', settings)
  await ctx.plugin(plugin, config)
  return ctx
}

function dispatchFailure(ctx: Context, agent: Agent, provider: string, code: string, status?: number): Promise<unknown> {
  return ctx.waterfall('agent/request-error', {
    agent,
    turn: 1,
    step: 1,
    provider,
    failure: { message: `${code} injected`, code, ...status === undefined ? {} : { status } },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }, async () => undefined)
}

describe('spread strategies through a live context (S-06)', () => {
  it('round-robin hands successive children successive routes and keeps each child on its route', async () => {
    const ctx = await spreadContext(spreadConfig({}))
    const first = newChild()
    const second = newChild()
    const third = newChild()
    await expect(dispatch(ctx, first)).resolves.toEqual(sz)
    await expect(dispatch(ctx, second)).resolves.toEqual(hh)
    await expect(dispatch(ctx, third)).resolves.toEqual(sz)
    await expect(dispatch(ctx, first)).resolves.toEqual(sz)
    await expect(dispatch(ctx, second)).resolves.toEqual(hh)
    await expect(dispatch(ctx, topAgent)).resolves.toEqual(seed)
  })

  it('priority keeps every child on the first route while it is healthy', async () => {
    const ctx = await spreadContext(spreadConfig({
      strategy: 'priority',
      priority: [{ provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'high' }, { ...sz, reasoningEffort: '' }],
    }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual({ ...hh, reasoningEffort: 'high' })
    await expect(dispatch(ctx, newChild())).resolves.toEqual({ ...hh, reasoningEffort: 'high' })
  })

  it('passes requests through when the official list is disabled and no priority is configured', async () => {
    const settings = allowList(sz, hh)
    settings.enabled = false
    const ctx = await spreadContext(spreadConfig({}), settings)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })

  it('ignores the top-level provider/model fields under a spread strategy', async () => {
    const ctx = await spreadContext(spreadConfig({ provider: 'zai', model: 'glm-5.3' }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
  })
})

describe('health-aware failover (S-07)', () => {
  it('cools a transiently failing route, moves the child on its retried request, and steers new children away', async () => {
    const ctx = await spreadContext(spreadConfig({}))
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await expect(dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)).resolves.toBeUndefined()
    await expect(dispatch(ctx, child)).resolves.toEqual(hh)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
  })

  it('cools every route of a provider on a credential failure', async () => {
    const ctx = await spreadContext(spreadConfig({ strategy: 'priority', priority: [{ ...sz, reasoningEffort: '' }, { ...hh, reasoningEffort: '' }] }))
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'INVALID_CREDENTIAL', 401)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
  })

  it('leaves health untouched for request-shaped failures and keeps the child on its route', async () => {
    const ctx = await spreadContext(spreadConfig({ strategy: 'priority', priority: [{ ...sz, reasoningEffort: '' }, { ...hh, reasoningEffort: '' }] }))
    const child = newChild()
    await dispatch(ctx, child)
    await dispatchFailure(ctx, child, 'sz', 'CONTEXT_WINDOW_EXCEEDED')
    await dispatchFailure(ctx, child, 'sz', 'ABORTED')
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
  })

  it('keeps the child on its route when every candidate is cooling', async () => {
    const ctx = await spreadContext(spreadConfig({}))
    const onSz = newChild()
    const onHh = newChild()
    await expect(dispatch(ctx, onSz)).resolves.toEqual(sz)
    await expect(dispatch(ctx, onHh)).resolves.toEqual(hh)
    await dispatchFailure(ctx, onSz, 'sz', 'SERVER', 503)
    await dispatchFailure(ctx, onHh, 'hh', 'SERVER', 503)
    await expect(dispatch(ctx, onSz)).resolves.toEqual(sz)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })

  it('skips a failure whose model cannot be attributed to the child or its session header', async () => {
    const ctx = await spreadContext(spreadConfig({}))
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'hh', 'SERVER', 503)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
  })

  it('always delegates the request-error decision downstream', async () => {
    const ctx = await spreadContext(spreadConfig({}))
    const child = newChild()
    await dispatch(ctx, child)
    const action = await ctx.waterfall('agent/request-error', {
      agent: child,
      turn: 1,
      step: 1,
      provider: 'sz',
      failure: { message: 'rate limited', code: 'RATE_LIMIT', providerRetryAfterMs: 1_000 },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'retry' as const }))
    expect(action).toEqual({ kind: 'retry' })
  })

  it('does not track health when cooldownMs is 0', async () => {
    const ctx = await spreadContext(spreadConfig({ cooldownMs: 0 }))
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
  })
})

describe('spread notices (S-08)', () => {
  it('names the assigned route and strategy once, then the reassignment after a failover', async () => {
    const ctx = await spreadContext(spreadConfig({}))
    const child = newChild()
    await dispatch(ctx, child)
    const assigned = await dispatchPreStep(ctx, child)
    expect(noticeText(assigned)).toBe('[model assigned: every request from this child agent runs sz/Qwen3.8-27B-FP8 (strategy: round-robin, dsh-subagent-plus)]')
    const again = await dispatchPreStep(ctx, child, 3)
    expect(again.kind === 'enter' && again.messages.length).toBe(0)
    await dispatchFailure(ctx, child, 'sz', 'TIMEOUT')
    await expect(dispatch(ctx, child)).resolves.toEqual(hh)
    const reassigned = await dispatchPreStep(ctx, child, 4)
    expect(noticeText(reassigned)).toBe('[model reassigned: route sz/Qwen3.8-27B-FP8 is cooling down (TIMEOUT); this child agent continues with hh/Qwen3.8-27B-FP8 (dsh-subagent-plus)]')
    const settled = await dispatchPreStep(ctx, child, 5)
    expect(settled.kind === 'enter' && settled.messages.length).toBe(0)
  })

  it('decides the route at the first noticed step when no request ran yet', async () => {
    const ctx = await spreadContext(spreadConfig({}))
    const child = newChild()
    const decision = await dispatchPreStep(ctx, child)
    expect(noticeText(decision)).toContain('sz/Qwen3.8-27B-FP8')
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
  })
})

describe('respectExplicit (S-09)', () => {
  const parentRoute = { provider: 'zai', model: 'glm-5.3' }
  const sessions = {
    get(id: string): { requestHeader(): { config: { provider: string; model: string } } } | undefined {
      return id === 'parent-1' ? { requestHeader: () => ({ config: parentRoute }) } : undefined
    },
  }

  it('leaves a child whose creation route differs from its parent on that route', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagentModelSelection', allowList(sz, hh))
    ctx.provide('sessions', sessions)
    await ctx.plugin(plugin, spreadConfig({ respectExplicit: true }))
    const explicit = newChild({ ...hh }, { parentSession: 'parent-1' })
    const explicitSeed: LlmCallConfig = { provider: 'hh', model: 'Qwen3.8-27B-FP8' }
    const result = await ctx.waterfall('agent/request', { agent: explicit, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ ...explicitSeed }))
    expect(result).toEqual(explicitSeed)
    const notice = await dispatchPreStep(ctx, explicit)
    expect(notice.kind === 'enter' && notice.messages.length).toBe(0)
    const inherited = newChild({ ...parentRoute }, { parentSession: 'parent-1' })
    await expect(dispatch(ctx, inherited)).resolves.toEqual(sz)
  })

  it('treats a child as inherited when the session store is absent or the parent is unknown', async () => {
    const ctx = await spreadContext(spreadConfig({ respectExplicit: true }))
    await expect(dispatch(ctx, newChild({ ...hh }, { parentSession: 'parent-1' }))).resolves.toEqual(sz)
  })
})

describe('configuration gates (structural fail-loud, cross-field degrade)', () => {
  it('refuses a repeated priority route at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(plugin, spreadConfig({
      strategy: 'random',
      priority: [{ ...sz, reasoningEffort: '' }, { ...sz, reasoningEffort: 'high' }],
    }))).rejects.toThrow(/repeats route/)
  })

  it('refuses a priority list longer than 5 at the schema layer', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const six = Array.from({ length: 6 }, (_, index) => ({ provider: `p${index}`, model: 'm', reasoningEffort: '' }))
    await expect(ctx.plugin(plugin, spreadConfig({ strategy: 'round-robin', priority: six }))).rejects.toThrow()
  })

  it('loads a priority strategy with no routes and keeps children on their resolved route (degraded, restart-safe)', async () => {
    const ctx = await spreadContext(spreadConfig({ strategy: 'priority' }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })

  it('keeps degrading softly when disabled, even with structurally invalid routes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(plugin, spreadConfig({
      enabled: false,
      priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }, { provider: 'sz', model: 'a', reasoningEffort: '' }],
    }))).resolves.toBeDefined()
  })
})

describe('fallback route (adjudication after candidates)', () => {
  const zai = { provider: 'zai', model: 'glm-5.3' }

  it('answers for a pinned config with no pinned route (single-model entry)', async () => {
    const ctx = await spreadContext(spreadConfig({
      strategy: 'pinned', provider: '', model: '', autoRoute: false,
      fallbackProvider: 'hh', fallbackModel: 'Qwen3.8-27B-FP8',
    }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
    const notice = await dispatchPreStep(ctx, newChild())
    expect(noticeText(notice)).toBe('[model fallback: no usable candidate route; this child agent runs hh/Qwen3.8-27B-FP8 (dsh-subagent-plus)]')
  })

  it('answers for a spread strategy when every candidate is cooling', async () => {
    const ctx = await spreadContext(spreadConfig({ fallbackProvider: 'zai', fallbackModel: 'glm-5.3' }))
    const onSz = newChild()
    const onHh = newChild()
    await dispatch(ctx, onSz)
    await dispatch(ctx, onHh)
    await dispatchFailure(ctx, onSz, 'sz', 'SERVER', 503)
    await dispatchFailure(ctx, onHh, 'hh', 'SERVER', 503)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(zai)
    const notice = await dispatchPreStep(ctx, newChild())
    expect(noticeText(notice)).toContain('[model fallback:')
  })

  it('moves a cooling child onto the fallback only after every candidate is out', async () => {
    const ctx = await spreadContext(spreadConfig({ fallbackProvider: 'zai', fallbackModel: 'glm-5.3' }))
    const onSz = newChild()
    const onHh = newChild()
    await dispatch(ctx, onSz)
    await dispatch(ctx, onHh)
    await dispatchFailure(ctx, onSz, 'sz', 'RATE_LIMIT', 429)
    // A healthy candidate still wins over the fallback on the retry.
    await expect(dispatch(ctx, onSz)).resolves.toEqual(hh)
    await dispatchFailure(ctx, onHh, 'hh', 'SERVER', 503)
    await expect(dispatch(ctx, onSz)).resolves.toEqual(zai)
    const notice = await dispatchPreStep(ctx, onSz, 3)
    expect(noticeText(notice)).toContain('is cooling down')
    expect(noticeText(notice)).toContain('continues with zai/glm-5.3')
  })

  it('passes through when the fallback is cooling too', async () => {
    const ctx = await spreadContext(spreadConfig({ fallbackProvider: 'zai', fallbackModel: 'glm-5.3' }))
    const onSz = newChild()
    const onHh = newChild()
    await dispatch(ctx, onSz)
    await dispatch(ctx, onHh)
    await dispatchFailure(ctx, onSz, 'sz', 'SERVER', 503)
    await dispatchFailure(ctx, onHh, 'hh', 'SERVER', 503)
    const onFallback = newChild()
    await expect(dispatch(ctx, onFallback)).resolves.toEqual(zai)
    await dispatchFailure(ctx, onFallback, 'zai', 'SERVER', 503)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })

  it('ignores a half-filled fallback (degraded)', async () => {
    const ctx = await spreadContext(spreadConfig({ strategy: 'pinned', provider: '', model: '', autoRoute: false, fallbackProvider: 'hh' }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })

  it('ignores a fallback repeating a configured priority route (degraded)', async () => {
    const ctx = await spreadContext(spreadConfig({
      strategy: 'round-robin',
      priority: [{ ...sz, reasoningEffort: '' }],
      fallbackProvider: 'sz',
      fallbackModel: 'Qwen3.8-27B-FP8',
    }))
    const onSz = newChild()
    await expect(dispatch(ctx, onSz)).resolves.toEqual(sz)
    await dispatchFailure(ctx, onSz, 'sz', 'SERVER', 503)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })

  it('records fallback-provider failures for a pinned config and clears the fallback while cooling', async () => {
    const ctx = await spreadContext(spreadConfig({
      strategy: 'pinned', provider: '', model: '', autoRoute: false,
      fallbackProvider: 'sz', fallbackModel: 'Qwen3.8-27B-FP8',
    }))
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })
})

describe('soft switch softens invalid spread configuration (review P2-1)', () => {
  it('loads with enabled:false even when the priority strategy has no routes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(plugin, spreadConfig({ enabled: false, strategy: 'priority' }))).resolves.toBeDefined()
  })
})

describe('review P1-2/P1-3: inert disable and pinned attribution', () => {
  it('stays inert on request-error while disabled, so re-enabling starts from clean health', async () => {
    const entry = spreadConfig({ enabled: false, fallbackProvider: 'zai', fallbackModel: 'glm-5.3' })
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagentModelSelection', allowList(sz, hh))
    // A settings service puts the live config into read-time evaluation, and
    // apply() directly keeps the entry reference — together the unit-level
    // stand-in for a volatile settings commit.
    ctx.provide('settings', {})
    plugin.apply(ctx, entry)
    const child = newChild()
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    entry.enabled = true
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
  })

  it('attributes a pinned-route failure to the pinned model, not the same-provider fallback', async () => {
    const entry = spreadConfig({
      strategy: 'pinned', provider: 'sz', model: 'Qwen3.8-27B-FP8',
      fallbackProvider: 'sz', fallbackModel: 'other-model',
    })
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagentModelSelection', allowList(sz, hh))
    ctx.provide('settings', {})
    plugin.apply(ctx, entry)
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    // Hot config switch (volatile-commit simulation): the cooled pinned route is
    // skipped, the healthy hh candidate wins first, and after hh cools too the
    // same-provider fallback is still usable — the pinned failure was attributed
    // to Qwen3.8-27B-FP8, never to other-model.
    entry.strategy = 'round-robin'
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
    const onHh = newChild()
    await expect(dispatch(ctx, onHh)).resolves.toEqual(hh)
    await dispatchFailure(ctx, onHh, 'hh', 'SERVER', 503)
    await expect(dispatch(ctx, newChild())).resolves.toEqual({ provider: 'sz', model: 'other-model' })
  })
})

describe('registration cache invalidation (E1)', () => {
  it('survives an adapters-updated event and keeps routing children', async () => {
    const ctx = await spreadContext(spreadConfig({ strategy: 'pinned', provider: 'sz', model: 'Qwen3.8-27B-FP8' }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
    // The host broadcasts this whenever the adapter set changes; the plugin
    // forgets its memoized registrations and re-checks on the next request.
    ctx.emit('llm/adapters-updated')
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
  })
})
