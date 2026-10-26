/**
 * dsh-subagent-plus client half entry: registers the locale dictionaries,
 * the read-only pinned-model badge on two session-scope list seats, and the
 * plugin's settings section. The bundle body is wrapped by the tsdown banner
 * into the `window.__ModuleLoader__.load({ id, factory })` contract.
 *
 * `inject` names the client services this entry binds: `slots` + `locale`
 * seat the badge and the section, `remote`/`remote.session` carry the model
 * catalogue, and `configForms` (provided by the settings shell) carries the
 * revision-fenced reads and writes of this plugin's namespace. A composition
 * without them cannot start this entry and the web boot fails loud — the
 * client half therefore requires a web-app-class composition.
 *
 * @module dsh-subagent-plus/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: carries the `ctx.slots` and `ctx.locale` service faces.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `settings.section` seat contract and the `ctx.configForms` face.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the `ctx.remote` / `ctx.remote.session` faces (model catalogue).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PinConfig } from '../config.js'
import type { CatalogGroup } from './settings-controller.js'
import { PinBadge } from './badge.tsx'
import { en, NS, zh } from './locales.ts'
import { SettingsSectionController, type CatalogPort, type SettingsFormPort } from './settings-controller.ts'
import { bindSettingsSection } from './settings-section.tsx'
import { PAGE_STYLE_CSS } from './settings-styles.ts'

/** Client services this bundle binds. */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

/** Structural view of the `remote.session.modelCatalog` result; the group
 *  shape is the shared {@link CatalogGroup} so the wire type lives once. */
interface ModelCatalogResult {
  ok: boolean
  value?: {
    groups: CatalogGroup[]
    failures?: unknown[]
  }
}

/** Narrow the shared config form to the controller's port shape (one boundary cast onto the host's op type). */
function asFormPort(form: { getSnapshot(): { status: string; value?: unknown; revision?: number }; subscribe(listener: () => void): () => void; mutate(ops: readonly never[], expectedRevision?: number): Promise<boolean> }): SettingsFormPort {
  return {
    getSnapshot: () => form.getSnapshot(),
    subscribe: listener => form.subscribe(listener),
    mutate: (ops, expectedRevision) => form.mutate(ops as never, expectedRevision),
  }
}

export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  // Page-lifetime styles (the conversation-view lineage hover tint). Light
  // DOM only: slots render without shadow roots, so a head <style> reaches
  // the documented [data-slot] anchor seam.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dsmpPage = ''
    style.textContent = PAGE_STYLE_CSS
    document.head.append(style)
    return () => { style.remove() }
  })

  // Read-only badge beside the official model selector (the closest
  // zero-conflict neighbour of `conversation.input.model`, a single cell this
  // plugin deliberately does not shadow). The header-utilities seat is
  // deliberately left empty: the composer-side badge is the single in-window
  // readout and one-shot read-only children fall back to the transcript
  // notice (user review, 0.2.5).
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: NS,
    order: 10,
    locale: NS,
  }, PinBadge))

  // Settings section: the shared config form owns reads and revision-fenced
  // writes; the catalogue port adapts `remote.session.modelCatalog`.
  const form = asFormPort(ctx.configForms.get<PinConfig>(NS))
  const catalog: CatalogPort = {
    load: async () => {
      // Narrow the untyped RPC result to the shared wire view once, here at
      // the only call site.
      const result = await ctx.remote.session.modelCatalog() as ModelCatalogResult
      if (!result.ok || result.value === undefined) throw new Error('model catalogue unavailable')
      return { groups: result.value.groups, failureCount: result.value.failures?.length ?? 0 }
    },
  }
  const controller = new SettingsSectionController(form, catalog)
  ctx.effect(() => () => { controller.dispose() }, 'dsh-subagent-plus: settings form subscription')
  // The catalogue is not part of the settings document: adapters come and go,
  // and a commit elsewhere can change which routes exist.
  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { void controller.refreshCatalog() }), 'dsh-subagent-plus: adapter invalidations')
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { void controller.refreshCatalog() }), 'dsh-subagent-plus: settings invalidations')
  ctx.effect(() => ctx.on('connection/reset', () => { void controller.refreshCatalog() }), 'dsh-subagent-plus: connection generation')
  // The section stays mounted only while the host serves this namespace.
  ctx.effect(() => ctx.configForms.whileServed([NS], () => {
    controller.init()
    return ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: NS,
      order: 17,
      label: () => t('nav'),
      locale: NS,
    }, bindSettingsSection(controller)))
  }), 'dsh-subagent-plus: settings section')
}
