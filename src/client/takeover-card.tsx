/**
 * The takeover card (v0.3.0 T5/T7): the banner naming what was taken over and
 * how to restore it, plus the two absorbed official sections — runtime limits
 * and the model-selection allowlist — each editing its official namespace
 * through the shared config form. The card renders while this plugin's own
 * settings namespace is served; an official namespace going away flips only
 * its own section to `unavailable`, never the card (T7).
 *
 * @module dsh-subagent-plus/client/takeover-card
 */
import { useSyncExternalStore, type CSSProperties } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { QuestionIcon } from './host-icons.tsx'
import { NS } from './locales.ts'
import type { RouteOption } from './settings-controller.ts'
import type {
  NamespaceFormState,
  OfficialAllowlistController,
  OfficialAllowlistValue,
  OfficialLimitsController,
  OfficialLimitsValue,
} from './official-surfaces.ts'
import { routeShort, Switch } from './settings-section.tsx'
import {
  cardHeadingStyle,
  cardHeaderRowStyle,
  cardStyle,
  hintStyle,
  inputStyle,
  invalidStyle,
  saveButtonStyle,
  statusTextStyle,
} from './settings-styles.ts'

/** Banner box: the takeover statement, distinct from plain hints. */
const bannerStyle: CSSProperties = {
  margin: 0,
  padding: '8px 12px',
  borderRadius: 8,
  border: '0.5px solid var(--dsw-alias-state-warn-primary)',
  background: 'var(--dsw-alias-bg-layer-2, transparent)',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-secondary)',
}

/** Sub-section divider inside the takeover card. */
const sectionDividerStyle: CSSProperties = {
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
  paddingTop: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

/** Hover ⓘ: the dsh-websearch pattern shared with the main section. */
function Info({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip label={text} side="bottom" delayMs={400} maxWidth={360} portal>
      <button type="button" aria-label={label} style={{ border: 'none', background: 'transparent', color: 'inherit', opacity: 0.6, cursor: 'help', padding: 0, display: 'inline-flex' }}>
        <QuestionIcon />
      </button>
    </Tooltip>
  )
}

/** One official namespace's header row: title + hover help. */
function SectionHeader({ title, help }: { title: string; help: string }) {
  return (
    <div style={cardHeaderRowStyle}>
      <h5 style={{ ...cardHeadingStyle, margin: 0, fontSize: 13 }}>{title}</h5>
      <Info label={help} text={help} />
    </div>
  )
}

/** One namespace's save row: disabled while clean/blocked/saving, one-shot feedback. */
function SectionFooter(props: {
  clean: boolean
  blocked: boolean
  saving: boolean
  saved: boolean
  saveFailed: boolean
  conflict: boolean
  saveLabel: string
  savingLabel: string
  savedLabel: string
  failedLabel: string
  conflictLabel: string
  onSave: () => void
}) {
  const disabled = props.clean || props.blocked || props.saving
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" style={saveButtonStyle(disabled)} disabled={disabled} onClick={() => { props.onSave() }}>
        {props.saving ? props.savingLabel : props.saveLabel}
      </button>
      {props.saved ? <span style={statusTextStyle('success')}>{props.savedLabel}</span> : null}
      {props.saveFailed ? <span style={statusTextStyle('error')}>{props.failedLabel}</span> : null}
      {props.conflict ? <span style={statusTextStyle('warn')}>{props.conflictLabel}</span> : null}
    </div>
  )
}

/** The status branches every official section shares (loading / unavailable / invalid). */
function NsStatusLine({ state, t }: { state: NamespaceFormState<unknown>; t: PropsLocale<typeof NS>['t'] }) {
  if (state.status === 'unavailable') return <p style={hintStyle}>{t('takeover.nsUnavailable')}</p>
  if (state.valueInvalid) return <p style={invalidStyle}>{t('takeover.valueInvalid')}</p>
  return null
}

/** The two official controllers the card edits, shared with the client entry's wiring. */
export interface TakeoverControllers {
  limits: OfficialLimitsController
  allowlist: OfficialAllowlistController
}

/** Presentation component; every action is a controller call, every string a locale key. */
export function TakeoverCard(props: PropsLocale<typeof NS> & TakeoverControllers & { routes: readonly RouteOption[] }) {
  const { t } = props
  const limits = useSyncExternalStore(props.limits.subscribe, props.limits.snapshot)
  const allowlist = useSyncExternalStore(props.allowlist.subscribe, props.allowlist.snapshot)
  return (
    <section style={cardStyle} aria-labelledby="dsmp-takeover">
      <div style={cardHeaderRowStyle}>
        <h4 id="dsmp-takeover" style={cardHeadingStyle}>{t('takeover.title')}</h4>
      </div>
      <p style={bannerStyle}>{t('takeover.banner')}</p>

      <div style={sectionDividerStyle}>
        <SectionHeader title={t('takeover.limitsTitle')} help={t('takeover.limitsHelp')} />
        <NsStatusLine state={limits} t={t} />
        {limits.status === 'ready' && !limits.valueInvalid && limits.draft !== undefined
          ? (
            <>
              <LimitsBody state={limits} controller={props.limits} t={t} />
              {limits.invalid ? <p style={invalidStyle}>{t('takeover.limitsInvalid')}</p> : null}
            </>
            )
          : null}
        {limits.status === 'ready' && !limits.valueInvalid && limits.draft !== undefined
          ? (
            <SectionFooter
              clean={limits.value !== undefined && JSON.stringify(limits.value) === JSON.stringify(limits.draft)}
              blocked={limits.invalid}
              saving={limits.saving}
              saved={limits.saved}
              saveFailed={limits.saveFailed}
              conflict={limits.conflict}
              saveLabel={t('action.save')} savingLabel={t('action.saving')} savedLabel={t('action.saved')} failedLabel={t('action.failed')} conflictLabel={t('action.conflict')}
              onSave={() => { void props.limits.save() }}
            />
            )
          : null}
      </div>

      <div style={sectionDividerStyle}>
        <SectionHeader title={t('takeover.allowlistTitle')} help={t('takeover.allowlistHelp')} />
        <NsStatusLine state={allowlist} t={t} />
        {allowlist.status === 'ready' && !allowlist.valueInvalid && allowlist.draft !== undefined
          ? <AllowlistBody state={allowlist} controller={props.allowlist} routes={props.routes} t={t} />
          : null}
        {allowlist.status === 'ready' && !allowlist.valueInvalid && allowlist.draft !== undefined
          ? (
            <SectionFooter
              clean={allowlist.value !== undefined && JSON.stringify(allowlist.value) === JSON.stringify(allowlist.draft)}
              blocked={false}
              saving={allowlist.saving}
              saved={allowlist.saved}
              saveFailed={allowlist.saveFailed}
              conflict={allowlist.conflict}
              saveLabel={t('action.save')} savingLabel={t('action.saving')} savedLabel={t('action.saved')} failedLabel={t('action.failed')} conflictLabel={t('action.conflict')}
              onSave={() => { void props.allowlist.save() }}
            />
            )
          : null}
      </div>
    </section>
  )
}

/** The runtime-limits rows: two parsed numeric inputs writing the official keys. */
function LimitsBody(props: {
  state: NamespaceFormState<OfficialLimitsValue>
  controller: Pick<OfficialLimitsController, 'setMaxDepth' | 'setMaxActiveSubagents'>
  t: PropsLocale<typeof NS>['t']
}) {
  const { draft } = props.state
  if (draft === undefined) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={cardHeadingStyle}>{props.t('takeover.maxDepth')}</span>
        <span style={{ flex: 1 }} />
        <input
          className={`dsmp-input${props.state.invalid ? ' dsmp-invalid' : ''}`}
          style={{ ...inputStyle, height: 32, width: 'auto', minWidth: 0 }}
          type="number" min={0} step={1} inputMode="numeric"
          value={String(draft.maxDepth)}
          aria-label={props.t('takeover.maxDepth')}
          onChange={event => { props.controller.setMaxDepth(event.target.value) }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={cardHeadingStyle}>{props.t('takeover.maxActive')}</span>
        <span style={{ flex: 1 }} />
        <input
          className={`dsmp-input${props.state.invalid ? ' dsmp-invalid' : ''}`}
          style={{ ...inputStyle, height: 32, width: 'auto', minWidth: 0 }}
          type="number" min={1} step={1} inputMode="numeric"
          value={String(draft.maxActiveSubagents)}
          aria-label={props.t('takeover.maxActive')}
          onChange={event => { props.controller.setMaxActiveSubagents(event.target.value) }}
        />
      </div>
    </div>
  )
}

/** The official allowlist: the enabled switch plus a route checklist. Stored
 *  routes that left the catalogue stay checked and tagged so a catalogue
 *  hiccup never silently deauthorizes a route. */
function AllowlistBody(props: {
  state: NamespaceFormState<OfficialAllowlistValue>
  controller: Pick<OfficialAllowlistController, 'setEnabled' | 'toggleRoute'>
  routes: readonly RouteOption[]
  t: PropsLocale<typeof NS>['t']
}) {
  const { draft } = props.state
  if (draft === undefined) return null
  const checked = (route: { provider: string; model: string }): boolean =>
    draft.allowedModels.some(entry => entry.provider === route.provider && entry.model === route.model)
  const storedMissing = draft.allowedModels.filter(entry =>
    !props.routes.some(route => route.provider === entry.provider && route.model === entry.model))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={cardHeadingStyle}>{props.t('takeover.allowlistEnabled')}</span>
        <Info label={props.t('takeover.allowlistEnabledHelp')} text={props.t('takeover.allowlistEnabledHelp')} />
        <span style={{ flex: 1 }} />
        <Switch
          checked={draft.enabled}
          onChange={props.controller.setEnabled}
          label={props.t('takeover.allowlistEnabled')}
          title={props.t('takeover.allowlistEnabledHelp')}
        />
      </div>
      {props.routes.map(route => (
        <label key={`${route.provider}\0${route.model}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={checked(route)}
            onChange={() => { props.controller.toggleRoute({ provider: route.provider, model: route.model }) }}
            aria-label={`${props.t('takeover.allowlistTitle')} ${route.provider}/${route.model}`}
          />
          <span>{routeShort(route)}</span>
        </label>
      ))}
      {storedMissing.map(entry => (
        <label key={`${entry.provider}\0${entry.model}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked
            onChange={() => { props.controller.toggleRoute(entry) }}
            aria-label={`${props.t('takeover.allowlistTitle')} ${entry.provider}/${entry.model}`}
          />
          <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
            {`${entry.provider}/${entry.model}${props.t('takeover.allowlistUnavailable')}`}
          </span>
        </label>
      ))}
      {draft.allowedModels.length === 0 ? <p style={hintStyle}>{props.t('takeover.allowlistEmpty')}</p> : null}
    </div>
  )
}
