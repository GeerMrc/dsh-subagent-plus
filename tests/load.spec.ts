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

async function loadedContext(overrides: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(plugin, {
    provider: 'sz',
    model: 'Qwen3.8-27B-FP8',
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
    ...overrides,
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

  it('drops the parent-sized maxTokens when the route changes (T6 known deviation)', async () => {
    const ctx = await loadedContext()
    const resolved = await ctx.waterfall(
      'agent/request',
      { agent: childAgent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ ...seed, maxTokens: 131072 }),
    )
    // The inherited budget is sized for the parent's model; dropping it lets
    // the runtime materialise the pinned model's own defaultMaxTokens.
    expect(resolved).toEqual({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  })

  it('keeps maxTokens on an effort-only override of the same route', async () => {
    const ctx = await loadedContext({ reasoningEffort: 'high' })
    const resolved = await ctx.waterfall(
      'agent/request',
      { agent: childAgent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'medium' as ReasoningEffortId, maxTokens: 9999 }),
    )
    expect(resolved).toEqual({ provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: 'high' as ReasoningEffortId, maxTokens: 9999 })
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

describe('legacy residue (R7 binary takeover)', () => {
  it('routes children even when a legacy enabled:false key persists in the config', async () => {
    const residue = { enabled: false }
    const ctx = await loadedContext(residue)
    await expect(dispatch(ctx, childAgent)).resolves.toEqual({ provider: 'sz', model: 'Qwen3.8-27B-FP8' })
  })
})

describe('visible pinned-model notice', () => {  it('adds one transcript notice to a child agent, naming the pinned route', async () => {
    const ctx = await loadedContext()
    const decision = await dispatchPreStep(ctx, childAgent)
    expect(decision.kind).toBe('enter')
    expect(noticeText(decision)).toBe('[模型钉定 model pinned: 本子智能体所有请求运行 sz/Qwen3.8-27B-FP8｜every request runs sz/Qwen3.8-27B-FP8 — dsh-subagent-plus]')
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

describe('pinned notice vs registration', () => {
  const unregisteredPinConfig: plugin.PinConfig = {
    provider: 'sz',
    model: 'Qwen3.8-27B-FP8',
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
  }

  it('names the skip when failOpen keeps the resolved route (no false pinned claim)', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    // Only hh is registered: the sz pin is the unregistered route.
    ctx.provide('llm', llmWith(() => [hh]))
    await ctx.plugin(plugin, unregisteredPinConfig)
    const decision = await dispatchPreStep(ctx, newChild())
    expect(decision.kind).toBe('enter')
    expect(noticeText(decision)).toBe('[模型钉定跳过 model pin skipped: 钉定路由 sz/Qwen3.8-27B-FP8 未注册，本子智能体保持原路由｜pinned route sz/Qwen3.8-27B-FP8 unregistered, this child keeps its resolved route — dsh-subagent-plus]')
  })

  it('still claims the pin when failOpen is off (the override applies and fails loudly)', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('llm', llmWith(() => [hh]))
    await ctx.plugin(plugin, { ...unregisteredPinConfig, failOpen: false })
    const decision = await dispatchPreStep(ctx, newChild())
    expect(noticeText(decision)).toBe('[模型钉定 model pinned: 本子智能体所有请求运行 sz/Qwen3.8-27B-FP8｜every request runs sz/Qwen3.8-27B-FP8 — dsh-subagent-plus]')
  })

  it('skipped notice dedupes per child like the pinned one', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('llm', llmWith(() => [hh]))
    await ctx.plugin(plugin, unregisteredPinConfig)
    const agent = newChild()
    await dispatchPreStep(ctx, agent)
    const again = await dispatchPreStep(ctx, agent, 3)
    expect(again.kind === 'enter' && again.messages.length).toBe(0)
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
  provider: '',
  model: '',
  reasoningEffort: '',
  pinForkChildren: false,
  failOpen: true,
  showNotice: false,
  strategy: 'pinned',
  priority: [],
  respectExplicit: false,
  cooldownMs: 120_000,
  fallbackProvider: '',
  fallbackModel: '',
  fallbackReasoningEffort: '',
}

describe('legacy residue: autoRoute (R7 binary takeover)', () => {
  it('ignores a legacy autoRoute:true key when the pinned route is empty', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagentModelSelection', officialSettings)
    const residue = { autoRoute: true }
    await ctx.plugin(plugin, { ...autoRouteConfig, ...residue })
    // No adoption of the official first entry: the child keeps its resolved route.
    await expect(dispatch(ctx, childAgent)).resolves.toEqual(seed)
  })
})

/** Fresh official settings per test. The plugin never reads this service (ADR 0005); these
 *  provides are a regression tripwire — if the official-list reader ever comes back, the
 *  empty-list and autoRoute-residue cases above flip red. */
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
    provider: '',
    model: '',
    reasoningEffort: '',
    pinForkChildren: false,
    failOpen: true,
    showNotice: true,
    strategy: 'round-robin',
    priority: [
      { provider: 'sz', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
      { provider: 'hh', model: 'Qwen3.8-27B-FP8', reasoningEffort: '' },
    ],
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

  it('keeps children on their resolved route when the candidate list is empty and no fallback is configured', async () => {
    const ctx = await spreadContext(spreadConfig({ priority: [] }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })

  it('ignores the top-level provider/model fields under a spread strategy', async () => {
    const ctx = await spreadContext(spreadConfig({ provider: 'zai', model: 'glm-5.3' }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
  })
})

describe('failure recording outranks an upstream retry decider (R9 P0)', () => {
  it('records a vetoed failure and steers the next child away — the plugin must see retries', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('settings', {})
    // llm-retry stand-in registered FIRST (production layer order), in normal
    // mode it never calls next() for retryable codes — it vetoes downstream
    // listeners until its retries are exhausted.
    ctx.on('agent/request-error', async (): Promise<{ kind: 'retry' }> => ({ kind: 'retry' }))
    // Priority strategy: every new child takes the head route while healthy —
    // no rotation to mask the assertion.
    await ctx.plugin(plugin, spreadConfig({ strategy: 'priority' }))
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    // The veto hid the failure from append-registered listeners; the plugin's
    // recorder must still have run (prepend) and the next child must avoid sz.
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
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
    expect(noticeText(assigned)).toBe('[模型指派 model assigned: 本子智能体所有请求运行 sz/Qwen3.8-27B-FP8（策略：轮询｜strategy: round-robin）— dsh-subagent-plus]')
    const again = await dispatchPreStep(ctx, child, 3)
    expect(again.kind === 'enter' && again.messages.length).toBe(0)
    await dispatchFailure(ctx, child, 'sz', 'TIMEOUT')
    await expect(dispatch(ctx, child)).resolves.toEqual(hh)
    const reassigned = await dispatchPreStep(ctx, child, 4)
    expect(noticeText(reassigned)).toBe('[模型切换 model reassigned: sz/Qwen3.8-27B-FP8 冷却中（TIMEOUT），本子智能体继续使用 hh/Qwen3.8-27B-FP8｜sz/Qwen3.8-27B-FP8 cooling (TIMEOUT), continues hh/Qwen3.8-27B-FP8 — dsh-subagent-plus]')
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

  it('loads a priority strategy with no routes and keeps children on their resolved route (not assigned)', async () => {
    const ctx = await spreadContext(spreadConfig({ strategy: 'priority', priority: [] }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })

  it('refuses structurally invalid routes even when a legacy enabled:false key persists', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const residue = { enabled: false }
    await expect(ctx.plugin(plugin, {
      ...spreadConfig({ priority: [{ provider: 'sz', model: 'a', reasoningEffort: '' }, { provider: 'sz', model: 'a', reasoningEffort: '' }] }),
      ...residue,
    })).rejects.toThrow()
  })
})

describe('pinned route failure hands over to the fallback (R9)', () => {
  const pinnedWithFallback = (overrides: Partial<plugin.PinConfig> = {}): plugin.PinConfig => ({
    ...spreadConfig({
      strategy: 'pinned',
      provider: 'sz',
      model: 'Qwen3.8-27B-FP8',
      priority: [],
      fallbackProvider: 'hh',
      fallbackModel: 'Qwen3.8-27B-FP8',
    }),
    ...overrides,
  })

  it('routes children to the fallback while the pinned route is cooling', async () => {
    const ctx = await spreadContext(pinnedWithFallback())
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
    // The same child's next request also lands on the fallback.
    await expect(dispatch(ctx, child)).resolves.toEqual(hh)
  })

  it('falls back when the pinned route is unregistered and failOpen skips it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('llm', llmWith(() => [hh]))
    await ctx.plugin(plugin, pinnedWithFallback())
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
  })

  it('keeps the cooling pinned route when the fallback is unusable too', async () => {
    const ctx = await spreadContext(pinnedWithFallback())
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    await dispatchFailure(ctx, newChild(), 'hh', 'SERVER', 503)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
  })

  it('never hands over on health when cooldownMs is 0', async () => {
    const ctx = await spreadContext(pinnedWithFallback({ cooldownMs: 0 }))
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
  })

  it('notifies truthfully when the fallback takes over a cooling pin', async () => {
    const ctx = await spreadContext(pinnedWithFallback({ showNotice: true }))
    const child = newChild()
    await dispatch(ctx, child)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    const notice = await dispatchPreStep(ctx, newChild())
    expect(noticeText(notice)).toBe('[模型钉定兜底 model pin fallback: 钉定路由 sz/Qwen3.8-27B-FP8 当前不可用（冷却或未注册），本子智能体改用兜底 hh/Qwen3.8-27B-FP8｜pinned route sz/Qwen3.8-27B-FP8 unavailable, runs fallback hh/Qwen3.8-27B-FP8 — dsh-subagent-plus]')
  })
})

describe('fallback route (adjudication after candidates)', () => {
  const zai = { provider: 'zai', model: 'glm-5.3' }

  it('answers for a pinned config with no pinned route (single-model entry)', async () => {
    const ctx = await spreadContext(spreadConfig({
      strategy: 'pinned', provider: '', model: '', priority: [],
      fallbackProvider: 'hh', fallbackModel: 'Qwen3.8-27B-FP8',
    }))
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
    const notice = await dispatchPreStep(ctx, newChild())
    expect(noticeText(notice)).toBe('[模型兜底 model fallback: 无可用候选路由，本子智能体运行 hh/Qwen3.8-27B-FP8｜no usable candidate, runs hh/Qwen3.8-27B-FP8 — dsh-subagent-plus]')
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
    expect(noticeText(notice)).toContain('model fallback')
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
    expect(noticeText(notice)).toContain('cooling (')
    expect(noticeText(notice)).toContain('continues zai/glm-5.3')
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
    const ctx = await spreadContext(spreadConfig({ strategy: 'pinned', provider: '', model: '', fallbackProvider: 'hh' }))
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
      strategy: 'pinned', provider: '', model: '', priority: [],
      fallbackProvider: 'sz', fallbackModel: 'Qwen3.8-27B-FP8',
    }))
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(seed)
  })
})

describe('review P1-2/P1-3: inert disable and pinned attribution', () => {
  it('records request-error health regardless of a legacy enabled residue', async () => {
    const entry: { [key: string]: unknown } = { ...spreadConfig({ fallbackProvider: 'zai', fallbackModel: 'glm-5.3' }), enabled: false }
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagentModelSelection', allowList(sz, hh))
    // A settings service puts the live config into read-time evaluation, and
    // apply() directly keeps the entry reference — together the unit-level
    // stand-in for a volatile settings commit.
    ctx.provide('settings', {})
    plugin.apply(ctx, entry)
    const child = newChild()
    await expect(dispatch(ctx, child)).resolves.toEqual(sz)
    await dispatchFailure(ctx, child, 'sz', 'RATE_LIMIT', 429)
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
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

/** Minimal llm face over a mutable route set: routeRegistered consults
 *  listProviders/listModels, and adapters-updated shrinks the set. */
function llmWith(getRoutes: () => { provider: string; model: string }[]): object {
  return {
    listProviders: () => getRoutes().map(route => ({ id: route.provider })),
    listModels: async (provider: string) => getRoutes().filter(route => route.provider === provider).map(route => ({ id: route.model })),
  }
}

describe('registration cache invalidation (E1, discriminating)', () => {
  it('re-checks a memoized route after adapters change and skips a gone route', async () => {
    let routes = [{ provider: 'sz', model: 'Qwen3.8-27B-FP8' }, { provider: 'hh', model: 'Qwen3.8-27B-FP8' }]
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('subagentModelSelection', allowList(sz, hh))
    ctx.provide('llm', llmWith(() => routes))
    await ctx.plugin(plugin, spreadConfig({ strategy: 'priority', priority: [{ ...sz, reasoningEffort: '' }, { ...hh, reasoningEffort: '' }] }))
    // First child pins onto sz (priority head) — and memoizes its registration.
    await expect(dispatch(ctx, newChild())).resolves.toEqual(sz)
    // The adapter set loses sz; without invalidation the memo would keep
    // "sz registered" and the next child would pin onto the gone route.
    routes = routes.filter(route => route.provider !== 'sz')
    ctx.emit('llm/adapters-updated')
    await expect(dispatch(ctx, newChild())).resolves.toEqual(hh)
  })
})
