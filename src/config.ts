/**
 * Configuration schema and runtime unwrapping for dsh-subagent-plus.
 *
 * Every settings-page-editable field is `.volatile()`: on hosts with the
 * settings service (0.2.0-rc.x) that registers the namespace as a live
 * settings form whose committed changes apply without restarting the plugin,
 * and `apply` receives each field as a `Volatile` handle; on hosts without
 * volatile support the marker is inert metadata and values arrive plain. Both
 * shapes normalize through {@link materializeConfig}, so this module is also
 * the client half's type source (no host-side imports).
 *
 * @module dsh-subagent-plus/config
 */
import z from '@deepseek-ai/schemastery'
import type { CapabilityOverrideView, NameMapEntryView, PriorityEntryView, Strategy } from './strategy.js'
import { MAX_CAPABILITY_OVERRIDES, MAX_NAME_MAP_ENTRIES, resolveNameMapDefaults, STRATEGIES } from './strategy.js'

/** Plugin configuration; plain values only — runtime handles unwrap through {@link materializeConfig}. */
export interface PinConfig {
  /** Provider id of the pinned route (`pinned` strategy); empty assigns nothing. */
  provider: string
  /** Model id of the pinned route (`pinned` strategy); empty assigns nothing. */
  model: string
  /** Effort id pinned alongside the route; empty drops effort on route change. */
  reasoningEffort: string
  /** Whether `subagent_fork` children are routed too; off preserves fork route reuse. */
  pinForkChildren: boolean
  /** On an unregistered candidate route: skip it, or fail loudly when it is used. */
  failOpen: boolean
  /** Whether each child's transcript gains a visible one-line route notice. */
  showNotice: boolean
  /** Selection strategy; `pinned` keeps the v0.1.x single-route behaviour. */
  strategy: Strategy
  /** Ordered candidate routes for spread strategies (at most 5) — the sole routing source; an empty list assigns nothing. */
  priority: PriorityEntryView[]
  /** Whether a route the delegating model chose explicitly is left untouched by a spread strategy. */
  respectExplicit: boolean
  /** Cooldown applied to a failed candidate route; 0 disables health tracking. */
  cooldownMs: number
  /** Fallback provider id, used when no candidate route is usable; empty disables the fallback. */
  fallbackProvider: string
  /** Fallback model id, used when no candidate route is usable; empty disables the fallback. */
  fallbackModel: string
  /** Effort id for the fallback route; empty keeps the model's own default. */
  fallbackReasoningEffort: string
  /** Role-keyword mapping rows (ADR 0008): substring match against teammate names → forced route; empty list leaves routing to the strategy chain. */
  nameMap: NameMapEntryView[]
  /** Defaults mode (ADR 0014 d2): the effective mapping derives from the candidate list; false keeps the stored rows. */
  nameMapDefaults: boolean
  /** User-imported capability evaluations (ADR 0016 d3, L2): raw model ids
   *  matched progressively at read time; percentile-position scores 0-100. */
  capabilityOverrides: CapabilityOverrideView[]
}

/** Upper bound on `priority` entries; enforced by the schema and the settings page. */
const MAX_PRIORITY_ROUTES = 5

/**
 * A volatile handle as the host hands it to `apply` (upstream `Volatile<T>`):
 * reading through `get()` evaluates the field against the live configuration.
 * Structural — no compile-time cordis-version tie.
 */
export interface VolatileHandle<T> {
  get(): T
}

/** The configuration shape `apply` receives at runtime: plain values or volatile handles, per field. */
export type PinConfigRuntime = { [K in keyof PinConfig]?: PinConfig[K] | VolatileHandle<PinConfig[K]> }

/**
 * Unwrap a runtime config into the plain {@link PinConfig} shape: handle
 * fields read through `get()` (live snapshot at call time), plain fields pass
 * through. Shallow by construction — volatile marks sit exactly on the
 * top-level fields.
 * @param runtime - the config object the host handed the plugin.
 * @returns the plain snapshot for one decision pass.
 */
export function materializeConfig(runtime: PinConfigRuntime): PinConfig {
  const out = {} as PinConfig
  for (const key of Object.keys(runtime) as (keyof PinConfig)[]) {
    const value: unknown = runtime[key]
    const unwrapped = value !== null && typeof value === 'object' && typeof (value as VolatileHandle<unknown>).get === 'function'
      ? (value as VolatileHandle<unknown>).get()
      : value
    // Computed keys cannot target a typed union field directly; assign into
    // the (already-cast) config object instead.
    Object.assign(out, { [key]: unwrapped })
  }
  // ADR 0014 d2 migration default: the schema deliberately carries no
  // `.default()` (a static default would absorb "absent" at parse time), so
  // an absent field lands here as undefined and resolves by stored rows —
  // fresh configurations get defaults-on, hand-edited ones stay custom.
  out.nameMapDefaults = resolveNameMapDefaults(out.nameMapDefaults as boolean | undefined, out.nameMap?.length ?? 0)
  return out
}

/**
 * Validation schema for the plugin's config section. Every editable field is
 * `.volatile()` so the host settings service can read and write it; the
 * `priority` length bound is schema-level so an over-long list cannot even be
 * persisted. Annotated as plain `z` (like the websearch precedent) so
 * declaration emit stays portable.
 */
export const Config: z = z.object({
  provider: z.string().default('').volatile(),
  model: z.string().default('').volatile(),
  reasoningEffort: z.string().default('').volatile(),
  pinForkChildren: z.boolean().default(false).volatile(),
  failOpen: z.boolean().default(true).volatile(),
  showNotice: z.boolean().default(true).volatile(),
  strategy: z.union([...STRATEGIES]).default('pinned').volatile(),
  priority: z.array(z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default(''),
  })).default([]).max(MAX_PRIORITY_ROUTES).volatile(),
  respectExplicit: z.boolean().default(false).volatile(),
  cooldownMs: z.number().step(1).min(0).default(120_000).volatile(),
  fallbackProvider: z.string().default('').volatile(),
  fallbackModel: z.string().default('').volatile(),
  fallbackReasoningEffort: z.string().default('').volatile(),
  nameMap: z.array(z.object({
    name: z.string().default(''),
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningEffort: z.string().default(''),
  })).default([]).max(MAX_NAME_MAP_ENTRIES).volatile(),
  // Deliberately no `.default()`: absent must survive parsing so
  // materializeConfig can apply the stored-rows migration rule (ADR 0014 d2).
  nameMapDefaults: z.boolean().volatile(),
  capabilityOverrides: z.array(z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    overall: z.union([z.number().min(0).max(100), z.const(undefined)]),
    coding: z.union([z.number().min(0).max(100), z.const(undefined)]),
    webdev: z.union([z.number().min(0).max(100), z.const(undefined)]),
    agentic: z.union([z.number().min(0).max(100), z.const(undefined)]),
    asOf: z.string().default(''),
    note: z.string().default(''),
  })).default([]).max(MAX_CAPABILITY_OVERRIDES).volatile(),
})
